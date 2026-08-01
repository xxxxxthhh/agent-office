import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { normalizeConfig, writeStarterConfig } from "./config.js";
import { RunLeaseError } from "./errors.js";
import { totalUsage } from "./usage.js";
import { TaskStore } from "./store.js";
import { loadTurnSchema } from "./protocol.js";
import { Orchestrator } from "./orchestrator.js";
import { createRuntime, DEFAULT_SCHEMA_PATH } from "./runtime.js";
import { DashboardServer } from "./server.js";
import { exists } from "./utils.js";
import { inheritMacSystemProxy } from "./system-proxy.js";

export async function runCli(argv, io = console, options = {}) {
  const args = [...argv];
  const command = args.shift() ?? "help";

  if (["start", "run", "serve"].includes(command)) {
    await prepareNetworkEnvironment(io, options);
  }

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      io.log(usage());
      return 0;
    case "init":
      return initCommand(args, io);
    case "start":
      return startCommand(args, io, options);
    case "doctor":
      return doctorCommand(args, io);
    case "capabilities":
      return capabilitiesCommand(args, io);
    case "task":
      return taskCommand(args, io);
    case "message":
      return messageCommand(args, io);
    case "run":
      return runTaskCommand(args, io);
    case "serve":
      return serveCommand(args, io, options);
    case "demo":
      return demoCommand(io);
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

async function prepareNetworkEnvironment(io, options) {
  const inheritSystemProxy = options.inheritSystemProxy ?? inheritMacSystemProxy;
  const { applied } = await inheritSystemProxy();
  const proxy = applied.HTTPS_PROXY ?? applied.HTTP_PROXY;
  if (proxy) {
    io.log(`Using the macOS system proxy for agent processes: ${proxy}`);
  }
}

async function startCommand(args, io, options) {
  rejectExtraArgs(args);
  const workspace = path.resolve(options.cwd ?? process.cwd());
  const configPath = path.join(workspace, "agent-office.json");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new Error(`Agent Office requires Node.js 20 or newer; found ${process.version}`);
  }

  if (!(await exists(configPath))) {
    io.log(`No agent-office.json found in ${workspace}.`);
    const confirm = options.confirmInitialization ?? confirmInitialization;
    if (!(await confirm(workspace))) {
      io.log("Initialization cancelled; no files were changed.");
      return 0;
    }
    const createdPath = await writeStarterConfig(workspace);
    io.log(`Created ${createdPath}`);
  }

  io.log("Checking the configured agents…");
  const doctor = options.doctor
    ?? ((value) => doctorCommand(["--config", value], io));
  if (await doctor(configPath) !== 0) {
    io.error("Environment check failed; the dashboard was not started.");
    return 1;
  }

  io.log("Starting Agent Office and opening the dashboard…");
  const serve = options.serve
    ?? ((value, settings) => serveCommand(
      ["--config", value, ...(settings.open ? ["--open"] : [])],
      io,
      options
    ));
  return serve(configPath, { open: true });
}

async function confirmInitialization(workspace) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Configuration not found in ${workspace}. Run "agent-office init" first, `
      + "or run \"agent-office start\" in an interactive terminal."
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      "Initialize this project with the default Codex + Claude configuration? [y/N] "
    );
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function initCommand(args, io) {
  const targetDirectory = path.resolve(args[0] ?? ".");
  await mkdir(targetDirectory, { recursive: true });
  const targetPath = await writeStarterConfig(targetDirectory);
  io.log(`Created ${targetPath}`);
  io.log("Next: agent-office doctor");
  return 0;
}

async function doctorCommand(args, io) {
  const configPath = takeOption(args, "--config") ?? "agent-office.json";
  rejectExtraArgs(args);
  const runtime = await createRuntime(configPath, { initializeState: false });
  const definitions = new Map(
    runtime.orchestrator.describeAgents().map((agent) => [agent.id, agent])
  );
  const inventory = await runtime.capabilityRegistry.discover({ refresh: true });
  const rows = inventory.agents.map((agent) => ({
    ...definitions.get(agent.id),
    ...agent
  }));

  io.log(`Workspace: ${runtime.config.workspace}`);
  io.log(`State: ${runtime.config.stateDir}`);
  for (const row of rows) {
    io.log(
      `${row.available ? "✓" : "✗"} ${row.id} (${row.kind})`
      + `${row.version ? ` — ${row.version}` : ""}`
      + ` — ${row.safety}`
    );
    io.log(
      `  Models (${row.models.length}): ${row.models.map((model) => model.label).join(", ") || "none"}`
    );
    io.log(
      `  Tools (${row.tools.filter((tool) => tool.available).length}): `
      + `${row.tools.filter((tool) => tool.available).map((tool) => tool.label).join(", ") || "none"}`
    );
    for (const warning of row.warnings) io.log(`  ! ${warning}`);
  }
  return rows.every((row) => row.available) ? 0 : 1;
}

async function capabilitiesCommand(args, io) {
  const configPath = takeOption(args, "--config") ?? "agent-office.json";
  const objective = takeOption(args, "--objective");
  const asJson = takeFlag(args, "--json");
  const refresh = takeFlag(args, "--refresh");
  rejectExtraArgs(args);
  const runtime = await createRuntime(configPath, { initializeState: false });
  const inventory = await runtime.capabilityRegistry.discover({ refresh });
  const plan = objective
    ? await runtime.orchestrator.planTask(objective)
    : null;

  if (asJson) {
    io.log(JSON.stringify({ inventory, plan }, null, 2));
    return 0;
  }

  io.log(`Detected: ${inventory.detectedAt}`);
  for (const agent of inventory.agents) {
    io.log(`${agent.available ? "✓" : "✗"} ${agent.id} — ${agent.version}`);
    for (const model of agent.models) {
      const strengths = Object.entries(model.capabilities)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([name]) => name)
        .join(", ");
      io.log(`  model ${model.id} [${model.availability}] — ${strengths}`);
    }
    for (const item of agent.tools) {
      io.log(`  ${item.available ? "tool" : "tool-disabled"} ${item.id} [${item.kind}]`);
    }
  }
  if (plan) {
    io.log(`Task profile: ${plan.profile.kinds.join(", ")} (${plan.profile.complexity})`);
    for (const assignment of plan.assignments) {
      io.log(
        `  ${assignment.order}. ${assignment.agentId} → `
        + `${assignment.modelLabel} / ${assignment.effort} [score=${assignment.score}]`
      );
    }
  }
  return 0;
}

async function taskCommand(args, io) {
  const subcommand = args.shift();
  const configPath = takeOption(args, "--config") ?? "agent-office.json";
  const runtime = await createRuntime(configPath);

  if (subcommand === "create") {
    const objective = takeOption(args, "--objective");
    if (!objective) throw new Error("task create requires --objective");
    rejectExtraArgs(args);
    const task = await runtime.orchestrator.createTask(objective);
    io.log(task.id);
    return 0;
  }

  if (subcommand === "list") {
    const includeArchived = takeFlag(args, "--all");
    rejectExtraArgs(args);
    const tasks = await runtime.store.listTasks({ includeArchived });
    if (tasks.length === 0) {
      io.log(includeArchived ? "No tasks." : "No tasks. (Archived tasks are hidden; use --all.)");
      return 0;
    }
    for (const task of tasks) {
      io.log(
        `${task.id}\t${task.status}${task.archived ? " (archived)" : ""}`
        + `\t${task.updatedAt}\t${oneLine(task.objective, 72)}`
      );
    }
    return 0;
  }

  if (subcommand === "archive" || subcommand === "unarchive") {
    const taskId = args.shift();
    if (!taskId) throw new Error(`task ${subcommand} requires a task id`);
    rejectExtraArgs(args);
    await runtime.store.setArchived(taskId, subcommand === "archive");
    io.log(`${taskId} ${subcommand === "archive" ? "archived" : "unarchived"}`);
    return 0;
  }

  if (subcommand === "delete") {
    const taskId = args.shift();
    if (!taskId) throw new Error("task delete requires a task id");
    const confirmed = takeFlag(args, "--yes");
    rejectExtraArgs(args);
    // Deleting a snapshot is irreversible, so it never happens implicitly.
    if (!confirmed) {
      throw new Error(
        `Refusing to delete ${taskId} without --yes. `
        + "The task snapshot is removed permanently; consider \"task archive\" instead."
      );
    }
    const task = await runtime.store.loadTask(taskId);
    await runtime.store.deleteTask(taskId);
    io.log(`Deleted ${taskId} (${task.turns.length} turn(s), ${task.messages.length} message(s))`);
    return 0;
  }

  if (subcommand === "show") {
    const taskId = args.shift();
    if (!taskId) throw new Error("task show requires a task id");
    const asJson = takeFlag(args, "--json");
    rejectExtraArgs(args);
    const task = await runtime.store.loadTask(taskId);
    io.log(asJson ? JSON.stringify(task, null, 2) : formatTask(task));
    return 0;
  }

  throw new Error("task requires one of: create, list, show, archive, unarchive, delete");
}

async function messageCommand(args, io) {
  const subcommand = args.shift();
  if (subcommand !== "send") throw new Error("message requires: send");
  const taskId = args.shift();
  if (!taskId) throw new Error("message send requires a task id");
  const configPath = takeOption(args, "--config") ?? "agent-office.json";
  const to = takeOption(args, "--to") ?? "team";
  const body = takeOption(args, "--body");
  if (!body) throw new Error("message send requires --body");
  rejectExtraArgs(args);

  const runtime = await createRuntime(configPath);
  const task = await runtime.store.loadTask(taskId);
  const validTargets = new Set(["team", ...Object.keys(task.participants)]);
  if (!validTargets.has(to)) {
    throw new Error(`Unknown recipient "${to}". Expected one of: ${[...validTargets].join(", ")}`);
  }
  const message = await runtime.store.addMessage(taskId, { from: "user", to, body });
  io.log(`Sent message ${message.sequence} to ${to}`);
  return 0;
}

async function runTaskCommand(args, io) {
  const taskId = args.shift();
  if (!taskId) throw new Error("run requires a task id");
  const configPath = takeOption(args, "--config") ?? "agent-office.json";
  const roundsValue = takeOption(args, "--rounds");
  rejectExtraArgs(args);
  const maxRounds = roundsValue === undefined ? undefined : parsePositiveInteger(roundsValue, "--rounds");
  const runtime = await createRuntime(configPath);

  // Ctrl+C stops the current turn and releases the run lease, so the task stays
  // resumable instead of being stranded in `running`.
  const controller = new AbortController();
  let interrupted = false;
  const onInterrupt = () => {
    if (interrupted) return;
    interrupted = true;
    io.error("Cancelling the current turn… press Ctrl+C again to force quit.");
    controller.abort();
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  let task;
  try {
    task = await runtime.orchestrator.runTask(taskId, {
      maxRounds,
      signal: controller.signal,
      onEvent: (event) => printRunEvent(event, io)
    });
  } catch (error) {
    if (error instanceof RunLeaseError) {
      io.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
  io.log(`Task ${task.id}: ${task.status}${interrupted ? " (cancelled)" : ""}`);
  if (interrupted) return 130;
  return task.status === "failed" ? 1 : 0;
}

async function serveCommand(args, io, options = {}) {
  const configPath = takeOption(args, "--config") ?? "agent-office.json";
  const host = takeOption(args, "--host") ?? "127.0.0.1";
  const port = parsePort(takeOption(args, "--port") ?? "4177");
  const shouldOpen = takeFlag(args, "--open");
  rejectExtraArgs(args);
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("The dashboard only binds to a loopback host: 127.0.0.1, localhost, or ::1");
  }

  const runtime = await createRuntime(configPath);
  const dashboard = new DashboardServer({ ...runtime, host, port });
  const url = await dashboard.start();
  io.log(`Agent Office dashboard: ${url}`);
  io.log(`Workspace: ${runtime.config.workspace}`);
  io.log("Press Ctrl+C to stop.");
  if (shouldOpen) {
    try {
      await (options.openUrl ?? openDashboard)(url);
    } catch (error) {
      io.error(`Could not open the browser automatically: ${error.message}`);
      io.error(`Open this address manually: ${url}`);
    }
  }

  await new Promise((resolve) => {
    const shutdown = async () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      await dashboard.close();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  return 0;
}

async function openDashboard(url) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function demoCommand(io) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-demo-"));
  const config = normalizeConfig(
    {
      version: 1,
      workspace,
      stateDir: ".agent-office",
      collaboration: { maxRounds: 3, transcriptMessages: 20, turnTimeoutMs: 10_000 },
      agents: [
        {
          id: "builder",
          adapter: "mock",
          role: "Draft the implementation and address review feedback.",
          replies: [
            {
              summary: "Drafted the implementation and handed it to the reviewer.",
              status: "done",
              messages: [{ to: "reviewer", body: "Please inspect the draft and send concrete findings." }],
              artifacts: ["src/draft.js"],
              needsUser: false
            },
            {
              summary: "Applied the review feedback and verified the corrected behavior.",
              status: "done",
              messages: [],
              artifacts: ["src/draft.js", "tests/draft.test.js"],
              needsUser: false
            }
          ]
        },
        {
          id: "reviewer",
          adapter: "mock",
          role: "Review the implementation and return actionable feedback.",
          replies: [
            {
              summary: "Found one boundary case and sent a focused fix request.",
              status: "done",
              messages: [{ to: "builder", body: "Handle empty input and add a regression test." }],
              artifacts: [],
              needsUser: false
            },
            {
              summary: "Rechecked the revision; the boundary case is now covered.",
              status: "done",
              messages: [],
              artifacts: [],
              needsUser: false
            }
          ]
        }
      ]
    },
    workspace
  );
  const store = new TaskStore(config.stateDir);
  await store.init();
  const schema = await loadTurnSchema(DEFAULT_SCHEMA_PATH);
  const orchestrator = new Orchestrator({
    config,
    store,
    schema,
    schemaPath: DEFAULT_SCHEMA_PATH
  });
  const task = await orchestrator.createTask("Build and review a small boundary-safe utility.");
  io.log(`Demo workspace: ${workspace}`);
  const completed = await orchestrator.runTask(task.id, {
    onEvent: (event) => printRunEvent(event, io)
  });
  io.log(formatTask(completed));
  return completed.status === "completed" ? 0 : 1;
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (index === args.length - 1) throw new Error(`${name} requires a value`);
  const [value] = args.splice(index + 1, 1);
  args.splice(index, 1);
  return value;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function rejectExtraArgs(args) {
  if (args.length) throw new Error(`Unexpected argument(s): ${args.join(" ")}`);
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  return port;
}

function printRunEvent(event, io) {
  if (event.type === "turn.started") {
    io.log(`→ round ${event.round}: ${event.agentId}`);
  } else if (event.type === "turn.progress") {
    // Only the coarse, bounded kinds: a turn emits far too many thinking and
    // message deltas to print, and `output` is one line per stdout line.
    if (event.kind === "tool" || event.kind === "notice") {
      io.log(`  · ${oneLine(event.detail, 96)}`);
    }
  } else if (event.type === "turn.completed") {
    io.log(`✓ ${event.agentId}: ${oneLine(event.response.summary, 100)} [${event.response.status}]`);
  } else if (event.type === "turn.failed") {
    io.error(`✗ ${event.agentId}: ${event.error}`);
    // Without this the real cause is only in events.jsonl, which means digging
    // through JSON to find out why a turn failed.
    for (const line of failureHints(event)) io.error(`    ${line}`);
  } else if (event.type === "turn.cancelled") {
    io.error(`■ ${event.agentId}: turn cancelled`);
  }
}

function failureHints(event) {
  const hints = [];
  if (event.timedOut) hints.push("The turn exceeded its timeout (collaboration.turnTimeoutMs).");
  const stderr = String(event.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of stderr.slice(0, 5)) hints.push(line);
  if (stderr.length > 5) hints.push(`… ${stderr.length - 5} more stderr line(s)`);
  return hints;
}

function formatTask(task) {
  const lines = [
    `${task.id} — ${task.status}`,
    `Objective: ${task.objective}`,
    `Rounds: ${task.roundsCompleted}`,
    `Routing: ${task.routing?.strategy ?? "legacy configured roster"}`,
    "Participants:"
  ];
  for (const [agentId, participant] of Object.entries(task.participants)) {
    lines.push(
      `  ${agentId}: ${participant.status}, turns=${participant.turns}`
      + `${participant.assignment?.modelLabel ? `, model=${participant.assignment.modelLabel}` : ""}`
      + `${participant.assignment?.effort ? `, effort=${participant.assignment.effort}` : ""}`
      + `${participant.lastSummary ? ` — ${oneLine(participant.lastSummary, 90)}` : ""}`
    );
  }
  const usage = totalUsage(task.turns);
  if (usage.turnsWithUsage) {
    lines.push(
      `Usage: ${usage.inputTokens} in / ${usage.outputTokens} out tokens`
      + (usage.costUsd === null
        ? " (no provider reported a cost)"
        : ` · $${usage.costUsd.toFixed(4)}${usage.costIsPartial ? " (partial — some turns report no cost)" : ""}`)
    );
  }
  lines.push("Conversation:");
  for (const message of task.messages) {
    lines.push(`  [${message.sequence}] ${message.from} -> ${message.to}: ${oneLine(message.body, 120)}`);
  }
  return lines.join("\n");
}

function oneLine(value, maxLength) {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function usage() {
  return `Agent Office — local-first multi-agent orchestration

Usage:
  agent-office init [directory]
  agent-office start
  agent-office doctor [--config path]
  agent-office capabilities [--refresh] [--objective "..."] [--json] [--config path]
  agent-office task create --objective "..." [--config path]
  agent-office task list [--all] [--config path]
  agent-office task show <task-id> [--json] [--config path]
  agent-office task archive <task-id> [--config path]
  agent-office task unarchive <task-id> [--config path]
  agent-office task delete <task-id> --yes [--config path]
  agent-office message send <task-id> --body "..." [--to agent|team] [--config path]
  agent-office run <task-id> [--rounds N] [--config path]
  agent-office serve [--host 127.0.0.1] [--port 4177] [--open] [--config path]
  agent-office demo

The default configuration connects Codex and Claude Code to one shared workspace.
Run "agent-office demo" for an offline, zero-cost collaboration trace.`;
}
