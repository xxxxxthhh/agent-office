import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { runProcess } from "../src/adapters/process.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(PACKAGE_ROOT, "bin", "agent-office.js");

test("offline demo completes a review-feedback loop", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "demo"],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });

  assert.match(result.stdout, /round 2: builder/);
  assert.match(result.stdout, /— completed/);
  assert.match(result.stdout, /reviewer -> builder: Handle empty input/);
});

test("init, create, list, and show form a usable CLI workflow", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-cli-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const configPath = path.join(workspace, "agent-office.json");

  const initialized = await runProcess({
    // Pinned rather than detected: which agent CLIs exist is a property of the
    // machine, and the rest of this test is about the task commands.
    command: process.execPath,
    args: [CLI_PATH, "init", workspace, "--agents", "codex,claude"],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });
  assert.match(initialized.stdout, /Created .*agent-office\.json/);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config.agents.map((agent) => agent.id), ["codex", "claude"]);

  const created = await runProcess({
    command: process.execPath,
    args: [
      CLI_PATH,
      "task",
      "create",
      "--config",
      configPath,
      "--objective",
      "Exercise the complete task CLI."
    ],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });
  const taskId = created.stdout.trim();
  assert.match(taskId, /^task-\d{8}-[a-f0-9]{8}$/);

  const listed = await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "task", "list", "--config", configPath],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });
  assert.match(listed.stdout, new RegExp(`${taskId}\\s+ready`));

  const shown = await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "task", "show", taskId, "--config", configPath],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });
  assert.match(shown.stdout, /Objective: Exercise the complete task CLI\./);
  assert.match(shown.stdout, /codex: idle/);
  assert.match(shown.stdout, /claude: idle/);
});

test("capabilities reports a task-specific routing plan as JSON", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-cli-capabilities-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const configPath = path.join(workspace, "agent-office.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    workspace,
    routing: { maxAgents: 1 },
    agents: [{
      id: "offline",
      adapter: "mock",
      role: "Handle repeatable transformations.",
      models: [{
        id: "fast",
        capabilities: {
          coding: 3,
          review: 3,
          reasoning: 2,
          research: 2,
          writing: 4,
          vision: 2,
          speed: 5,
          costEfficiency: 5
        }
      }]
    }]
  }));

  const result = await runProcess({
    command: process.execPath,
    args: [
      CLI_PATH,
      "capabilities",
      "--config",
      configPath,
      "--objective",
      "批量提取并格式化记录",
      "--json"
    ],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.inventory.totals.availableAgents, 1);
  assert.equal(payload.plan.assignments[0].agentId, "offline");
  assert.equal(payload.plan.assignments[0].model, "fast");
});

test("creates, runs, approves, and shows a v2 workflow through the CLI", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-cli-workflow-"));
  const stateDir = `${workspace}-state`;
  context.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });
  const configPath = path.join(workspace, "agent-office.json");
  const workflowPath = path.join(workspace, "workflow.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    workspace,
    stateDir,
    agents: [{
      id: "planner",
      adapter: "mock",
      role: "Prepare the plan.",
      replies: [{
        summary: "Plan is ready.",
        status: "done",
        messages: [],
        artifacts: [],
        needsUser: false
      }]
    }]
  }));
  await writeFile(workflowPath, JSON.stringify({
    version: 1,
    nodes: [
      { id: "plan", owner: "planner" },
      { id: "gate", type: "approval", dependsOn: ["plan"], prompt: "Approve the plan." }
    ]
  }));
  await runProcess({ command: "git", args: ["init"], cwd: workspace });
  await runProcess({ command: "git", args: ["config", "user.email", "test@example.com"], cwd: workspace });
  await runProcess({ command: "git", args: ["config", "user.name", "Test"], cwd: workspace });
  await runProcess({ command: "git", args: ["add", "."], cwd: workspace });
  await runProcess({ command: "git", args: ["commit", "-m", "fixture"], cwd: workspace });
  const created = await runProcess({
    command: process.execPath,
    args: [
      CLI_PATH, "workflow", "create",
      "--config", configPath,
      "--objective", "Exercise the v2 workflow CLI.",
      "--file", workflowPath
    ],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });
  const taskId = created.stdout.trim();
  const firstRun = await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "run", taskId, "--config", configPath],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });
  assert.match(firstRun.stdout, /node plan: succeeded/);
  assert.match(firstRun.stdout, /awaiting_input/);
  await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "workflow", "approve", taskId, "gate", "--config", configPath],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });
  const finalRun = await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "run", taskId, "--config", configPath],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });
  assert.match(finalRun.stdout, /completed/);
  const shown = await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "task", "show", taskId, "--json", "--config", configPath],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });
  const task = JSON.parse(shown.stdout);
  assert.equal(task.mode, "workflow");
  assert.equal(task.workflow.nodes.gate.status, "succeeded");
});

test("the generated configuration can create a workflow without being edited", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-first-run-"));
  const stateHome = await mkdtemp(path.join(os.tmpdir(), "agent-office-state-home-"));
  context.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  });

  const initialized = await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "init", workspace, "--agents", "codex,claude"],
    cwd: PACKAGE_ROOT,
    env: { ...process.env, XDG_STATE_HOME: stateHome },
    timeoutMs: 30_000
  });
  assert.match(initialized.stdout, /Agents: codex, claude/);

  const created = await runProcess({
    command: process.execPath,
    args: [
      CLI_PATH, "workflow", "create",
      "--config", path.join(workspace, "agent-office.json"),
      "--objective", "Exercise the shipped process-runtime workflow.",
      "--file", path.join(PACKAGE_ROOT, "examples", "workflow.process-review.json")
    ],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });

  // The generated state directory used to sit inside the workspace, which every
  // workflow command rejects: the headline v2 feature was unreachable until the
  // user hand-edited the file init had just written.
  assert.match(created.stdout.trim(), /^task-\d{8}-[a-f0-9]{8}$/);
  const config = JSON.parse(await readFile(path.join(workspace, "agent-office.json"), "utf8"));
  assert.ok(path.isAbsolute(config.stateDir), config.stateDir);
  assert.ok(config.stateDir.startsWith(stateHome), config.stateDir);
});

test("the CLI reports its version", async () => {
  const manifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  const printed = await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "--version"],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });
  assert.equal(printed.stdout.trim(), manifest.version);
});

test("the packaged demo dashboard config ships and loads", async () => {
  const { loadConfig } = await import("../src/config.js");
  // `demo --dashboard` resolves this path inside the installed package, which is
  // the only copy a globally installed CLI can reach.
  const configPath = path.join(PACKAGE_ROOT, "examples", "team.dashboard-demo.json");
  const config = await loadConfig(configPath);
  assert.ok(config.agents.length >= 1);
  assert.ok(config.agents.every((agent) => agent.adapter === "mock"), "the demo must not call a real provider");
});

test("workflow create resolves packaged examples by name", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-example-"));
  const stateDir = `${workspace}-state`;
  context.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });
  const configPath = path.join(workspace, "agent-office.json");
  const reply = { summary: "ok", status: "done", messages: [], artifacts: [], needsUser: false };
  await writeFile(configPath, JSON.stringify({
    version: 1,
    workspace,
    stateDir,
    agents: [
      { id: "codex", adapter: "mock", role: "Implement.", replies: [reply] },
      { id: "claude", adapter: "mock", role: "Review.", replies: [reply] }
    ]
  }));

  // An installed CLI has the examples in its package directory; --file resolves
  // against the caller's cwd, where they do not exist.
  const created = await runProcess({
    command: process.execPath,
    args: [
      CLI_PATH, "workflow", "create",
      "--config", configPath,
      "--objective", "Use the packaged example by name.",
      "--example", "process-review"
    ],
    cwd: workspace,
    timeoutMs: 30_000
  });
  assert.match(created.stdout.trim(), /^task-\d{8}-[a-f0-9]{8}$/);

  await assert.rejects(
    () => runProcess({
      command: process.execPath,
      args: [
        CLI_PATH, "workflow", "create",
        "--config", configPath,
        "--objective", "Unknown example.",
        "--example", "no-such-example"
      ],
      cwd: workspace,
      timeoutMs: 30_000
    }),
    (error) => {
      assert.match(error.details.stderr, /Unknown workflow example: no-such-example/);
      assert.match(error.details.stderr, /process-review/);
      return true;
    }
  );
});

test("init rejects agent ids it would otherwise drop", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-agents-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  // Silently dropping "typo" wrote a config that did not match what the command
  // echoed back; a duplicate id only failed later, inside doctor.
  await assert.rejects(
    () => runProcess({
      command: process.execPath,
      args: [CLI_PATH, "init", workspace, "--agents", "codex,typo"],
      cwd: PACKAGE_ROOT,
      timeoutMs: 30_000
    }),
    (error) => {
      assert.match(error.details.stderr, /Unknown agent\(s\) for --agents: typo/);
      return true;
    }
  );
  const deduped = await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "init", workspace, "--agents", "codex,codex"],
    cwd: PACKAGE_ROOT,
    timeoutMs: 30_000
  });
  assert.match(deduped.stdout, /Agents: codex$/m);
});

test("--owner reassigns a two-agent example onto a single configured agent", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-owner-"));
  const stateDir = `${workspace}-state`;
  context.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });
  const configPath = path.join(workspace, "agent-office.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    workspace,
    stateDir,
    // What init writes on a machine that has one of the two provider CLIs.
    agents: [{
      id: "codex",
      adapter: "mock",
      role: "Implement.",
      replies: [{ summary: "ok", status: "done", messages: [], artifacts: [], needsUser: false }]
    }]
  }));
  const create = (extra) => runProcess({
    command: process.execPath,
    args: [
      CLI_PATH, "workflow", "create",
      "--config", configPath,
      "--objective", "Run the shipped example with one agent.",
      "--example", "process-review",
      ...extra
    ],
    cwd: workspace,
    timeoutMs: 30_000
  });

  await assert.rejects(() => create([]), (error) => {
    assert.match(error.details.stderr, /references unknown agent "claude"/);
    assert.match(error.details.stderr, /Configured agents: codex/);
    assert.match(error.details.stderr, /--owner/);
    return true;
  });

  const created = await create(["--owner", "codex"]);
  assert.match(created.stdout.trim(), /^task-\d{8}-[a-f0-9]{8}$/);
});

test("workflow create refuses an ambiguous definition source", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-ambiguous-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const configPath = path.join(workspace, "agent-office.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    workspace,
    stateDir: `${workspace}-state`,
    agents: [{ id: "codex", adapter: "mock", role: "Implement." }]
  }));

  // Taking --example and ignoring --file would silently run something other
  // than the file the caller named.
  await assert.rejects(
    () => runProcess({
      command: process.execPath,
      args: [
        CLI_PATH, "workflow", "create",
        "--config", configPath,
        "--objective", "Ambiguous.",
        "--file", path.join(workspace, "missing.json"),
        "--example", "process-review"
      ],
      cwd: workspace,
      timeoutMs: 30_000
    }),
    (error) => {
      assert.match(error.details.stderr, /takes --file or --example, not both/);
      return true;
    }
  );
});

test("generated state never lands inside the workspace, whatever XDG_STATE_HOME says", async (context) => {
  const { starterStateDir } = await import("../src/config.js");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-xdg-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const previous = process.env.XDG_STATE_HOME;
  context.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });

  // The workspace itself, a directory inside it, and a symlink that resolves
  // into it all describe the same unusable placement.
  const link = path.join(await mkdtemp(path.join(os.tmpdir(), "agent-office-link-")), "state");
  await symlink(workspace, link);
  // "..state" is a child of the workspace whose name merely starts like a
  // traversal segment.
  for (const candidate of [workspace, path.join(workspace, ".state"), path.join(workspace, "..state"), link]) {
    process.env.XDG_STATE_HOME = candidate;
    const stateDir = starterStateDir(workspace);
    const relative = path.relative(workspace, stateDir);
    // Checked the way the code has to check it: a path merely beginning with
    // ".." can still be a child, which is the bug this case exists for.
    const outside = relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative);
    assert.ok(outside, `state landed inside the workspace for XDG_STATE_HOME=${candidate}: ${stateDir}`);
  }
});
