import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { normalizeConfig, writeStarterConfig } from "./config.js";
import { TaskStore } from "./store.js";
import { loadTurnSchema } from "./protocol.js";
import { Orchestrator } from "./orchestrator.js";
import { createRuntime, DEFAULT_SCHEMA_PATH } from "./runtime.js";
import { DashboardServer } from "./server.js";

export async function runCli(argv, io = console) {
  const args = [...argv];
  const command = args.shift() ?? "help";

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      io.log(usage());
      return 0;
    case "init":
      return initCommand(args, io);
    case "doctor":
      return doctorCommand(args, io);
    case "capabilities":
      return capabilitiesCommand(args, io);
    case "task":
      return taskCommand(args, io);
    case "workflow":
      return workflowCommand(args, io);
    case "message":
      return messageCommand(args, io);
    case "run":
      return runTaskCommand(args, io);
    case "serve":
      return serveCommand(args, io);
    case "demo":
      return demoCommand(io);
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
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
    rejectExtraArgs(args);
    const tasks = await runtime.store.listTasks();
    if (tasks.length === 0) {
      io.log("No tasks.");
      return 0;
    }
    for (const task of tasks) {
      io.log(`${task.id}\t${task.status}\t${task.updatedAt}\t${oneLine(task.objective, 72)}`);
    }
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

  throw new Error("task requires one of: create, list, show");
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

async function workflowCommand(args, io) {
  const subcommand = args.shift();
  const configPath = takeOption(args, "--config") ?? "agent-office.json";
  const runtime = await createRuntime(configPath);

  if (subcommand === "create") {
    const objective = takeOption(args, "--objective");
    const file = takeOption(args, "--file");
    if (!objective) throw new Error("workflow create requires --objective");
    if (!file) throw new Error("workflow create requires --file");
    rejectExtraArgs(args);
    const definition = JSON.parse(await readFile(path.resolve(file), "utf8"));
    const task = await runtime.workflowOrchestrator.createWorkflow(objective, definition);
    io.log(task.id);
    return 0;
  }

  if (subcommand === "approve") {
    const taskId = args.shift();
    const nodeId = args.shift();
    if (!taskId || !nodeId) throw new Error("workflow approve requires a task id and node id");
    rejectExtraArgs(args);
    await runtime.store.approveWorkflowNode(taskId, nodeId);
    io.log(`Approved ${taskId}/${nodeId}`);
    return 0;
  }

  if (subcommand === "retry") {
    const taskId = args.shift();
    const nodeId = args.shift();
    if (!taskId || !nodeId) throw new Error("workflow retry requires a task id and node id");
    rejectExtraArgs(args);
    await runtime.store.retryWorkflowNode(taskId, nodeId);
    io.log(`Retry ready: ${taskId}/${nodeId}`);
    return 0;
  }

  throw new Error("workflow requires one of: create, approve, retry");
}

async function runTaskCommand(args, io) {
  const taskId = args.shift();
  if (!taskId) throw new Error("run requires a task id");
  const configPath = takeOption(args, "--config") ?? "agent-office.json";
  const roundsValue = takeOption(args, "--rounds");
  rejectExtraArgs(args);
  const maxRounds = roundsValue === undefined ? undefined : parsePositiveInteger(roundsValue, "--rounds");
  const runtime = await createRuntime(configPath);

  const task = await runtime.orchestrator.runTask(taskId, {
    maxRounds,
    onEvent: (event) => printRunEvent(event, io)
  });
  io.log(`Task ${task.id}: ${task.status}`);
  return task.status === "failed" ? 1 : 0;
}

async function serveCommand(args, io) {
  const configPath = takeOption(args, "--config") ?? "agent-office.json";
  const host = takeOption(args, "--host") ?? "127.0.0.1";
  const port = parsePort(takeOption(args, "--port") ?? "4177");
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
  } else if (event.type === "turn.completed") {
    io.log(`✓ ${event.agentId}: ${oneLine(event.response.summary, 100)} [${event.response.status}]`);
  } else if (event.type === "turn.failed") {
    io.error(`✗ ${event.agentId}: ${event.error}`);
  } else if (event.type === "workflow.node_started") {
    io.log(`→ node ${event.nodeId}: ${event.workspace}`);
  } else if (event.type === "workflow.node_succeeded") {
    io.log(`✓ node ${event.nodeId}: succeeded`);
  } else if (event.type === "workflow.node_blocked") {
    io.log(`! node ${event.nodeId}: blocked`);
  } else if (event.type === "workflow.node_failed") {
    io.error(`✗ node ${event.nodeId}: ${event.error}`);
  }
}

function formatTask(task) {
  if (task.mode === "workflow") return formatWorkflowTask(task);
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
  lines.push("Conversation:");
  for (const message of task.messages) {
    lines.push(`  [${message.sequence}] ${message.from} -> ${message.to}: ${oneLine(message.body, 120)}`);
  }
  return lines.join("\n");
}

function formatWorkflowTask(task) {
  const lines = [
    `${task.id} — ${task.status}`,
    `Objective: ${task.objective}`,
    `Workflow: ${task.workflow.runtime}, concurrency=${task.workflow.maxConcurrency}`,
    "Nodes:"
  ];
  for (const nodeId of task.workflow.order) {
    const node = task.workflow.nodes[nodeId];
    lines.push(
      `  ${node.id}: ${node.status}, type=${node.type}`
      + `${node.owner ? `, owner=${node.owner}` : ""}`
      + `${node.attempts ? `, attempts=${node.attempts}/${node.maxAttempts}` : ""}`
      + `${node.result?.summary ? ` — ${oneLine(node.result.summary, 90)}` : ""}`
      + `${node.error ? ` — ${oneLine(node.error, 90)}` : ""}`
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
  agent-office doctor [--config path]
  agent-office capabilities [--refresh] [--objective "..."] [--json] [--config path]
  agent-office task create --objective "..." [--config path]
  agent-office task list [--config path]
  agent-office task show <task-id> [--json] [--config path]
  agent-office workflow create --objective "..." --file workflow.json [--config path]
  agent-office workflow approve <task-id> <node-id> [--config path]
  agent-office workflow retry <task-id> <node-id> [--config path]
  agent-office message send <task-id> --body "..." [--to agent|team] [--config path]
  agent-office run <task-id> [--rounds N] [--config path]
  agent-office serve [--host 127.0.0.1] [--port 4177] [--config path]
  agent-office demo

The default configuration connects Codex and Claude Code to one shared workspace.
Run "agent-office demo" for an offline, zero-cost collaboration trace.`;
}
