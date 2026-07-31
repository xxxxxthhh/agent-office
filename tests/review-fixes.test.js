// Regressions for the five issues found reviewing commit ac9f052.
// Each test reproduces the reported defect, so a revert of the fix fails here.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { runProcess } from "../src/adapters/process.js";
import { normalizeConfig } from "../src/config.js";
import { RunLeaseError } from "../src/errors.js";
import { Orchestrator } from "../src/orchestrator.js";
import { loadTurnSchema } from "../src/protocol.js";
import { DEFAULT_SCHEMA_PATH } from "../src/runtime.js";
import { TaskStore } from "../src/store.js";
import { captureBaseline, diffSince } from "../src/workspace.js";

// --- P1-1: cancellation must kill the whole process tree --------------------

test("cancelling kills descendants, not just the direct child", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-tree-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const marker = path.join(workspace, "descendant-wrote.txt");
  const agent = path.join(workspace, "agent.cjs");
  // The direct child spawns a grandchild that writes after a delay, exactly as
  // a real agent CLI shells out to tools.
  await writeFile(agent, `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", 'setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), 600)'], { stdio: "ignore" });
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 120);
  await assert.rejects(() => runProcess({
    command: process.execPath,
    args: [agent],
    cwd: workspace,
    signal: controller.signal,
    timeoutMs: 15_000
  }));

  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(
    existsSync(marker),
    false,
    "a descendant kept writing to the workspace after the run was cancelled"
  );
});

test("cancellation settles only after the tree has exited", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-tree-wait-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const agent = path.join(workspace, "stubborn.cjs");
  // Ignores SIGTERM, so settling early would mean reporting "stopped" while the
  // process is still alive and still able to write.
  await writeFile(agent, `
    process.on("SIGTERM", () => {});
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `);

  const controller = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(() => runProcess({
    command: process.execPath,
    args: [agent],
    cwd: workspace,
    signal: controller.signal,
    timeoutMs: 15_000
  }), (error) => {
    assert.equal(error.details.cancelled, true);
    return true;
  });

  // Must have waited for the SIGKILL escalation rather than returning at once.
  assert.ok(Date.now() - startedAt >= 400, "returned before the process could die");
});

// --- P1-2: one workspace runs one agent at a time ---------------------------

async function workspaceScaffold(context, runTurn) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-serial-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir: ".state",
    collaboration: { maxRounds: 1, transcriptMessages: 10, turnTimeoutMs: 10_000 },
    agents: [{ id: "w", adapter: "mock", role: "Implement." }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(DEFAULT_SCHEMA_PATH);
  const orchestrator = new Orchestrator({
    config,
    store,
    schema,
    schemaPath: DEFAULT_SCHEMA_PATH,
    adapterOverrides: {
      w: { describe: () => ({ kind: "t", command: null, safety: "t" }), runTurn }
    }
  });
  return { config, store, orchestrator, workspace };
}

test("two different tasks cannot run in the same workspace at once", async (context) => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const { store, orchestrator } = await workspaceScaffold(context, async () => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 300));
    inFlight -= 1;
    return {
      response: { summary: "done", status: "done", messages: [], artifacts: [], needsUser: false },
      tracePath: null
    };
  });
  const first = await orchestrator.createTask("task A sharing a workspace");
  const second = await orchestrator.createTask("task B sharing a workspace");

  const running = orchestrator.runTask(first.id);
  await new Promise((resolve) => setTimeout(resolve, 120));

  await assert.rejects(
    () => orchestrator.runTask(second.id),
    (error) => {
      assert.ok(error instanceof RunLeaseError);
      assert.match(error.message, /workspace/i);
      assert.equal(error.holder.taskId, first.id);
      return true;
    }
  );

  await running;
  assert.equal(maxConcurrent, 1, "turns from two tasks overlapped in one workspace");
  // Both the task and workspace leases are released together.
  assert.equal(await store.readLease(first.id), null);
  assert.equal(await store.readWorkspaceLease(process.cwd()), null);
});

test("the workspace frees up once the holding run finishes", async (context) => {
  const { orchestrator, config, store } = await workspaceScaffold(context, async () => ({
    response: { summary: "done", status: "done", messages: [], artifacts: [], needsUser: false },
    tracePath: null
  }));
  const first = await orchestrator.createTask("first task");
  const second = await orchestrator.createTask("second task");

  await orchestrator.runTask(first.id);
  assert.equal(await store.readWorkspaceLease(config.workspace), null);

  const settled = await orchestrator.runTask(second.id);
  assert.equal(settled.status, "completed", "the workspace was still blocked after the first run");
});

// --- P2-5: the diff is scoped to the task -----------------------------------

async function gitWorkspace(context) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-diff-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const git = (args) => runProcess({ command: "git", args, cwd: workspace, timeoutMs: 10_000 });
  await git(["init", "-q"]);
  await git(["config", "user.email", "t@example.com"]);
  await git(["config", "user.name", "test"]);
  await writeFile(path.join(workspace, "tracked.txt"), "baseline\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "init"]);
  return { workspace, git };
}

test("changes made before the task are not attributed to it", async (context) => {
  const { workspace } = await gitWorkspace(context);
  // A user edit that predates the task.
  await writeFile(path.join(workspace, "tracked.txt"), "edited by the user\n");

  const baseline = await captureBaseline(workspace);
  // Now the "task" changes a different file.
  await writeFile(path.join(workspace, "by-task.txt"), "written by the agent\n");

  const diff = await diffSince(workspace, baseline);

  assert.equal(diff.available, true);
  assert.equal(diff.scope, "task");
  assert.deepEqual(diff.changedDuringTask, ["by-task.txt"]);
  assert.deepEqual(diff.preexisting, ["tracked.txt"]);
});

test("a file dirty before the task counts once the task edits it again", async (context) => {
  const { workspace } = await gitWorkspace(context);
  await writeFile(path.join(workspace, "tracked.txt"), "user edit\n");
  const baseline = await captureBaseline(workspace);
  await writeFile(path.join(workspace, "tracked.txt"), "user edit, then agent edit\n");

  const diff = await diffSince(workspace, baseline);

  assert.deepEqual(diff.changedDuringTask, ["tracked.txt"]);
  assert.deepEqual(diff.preexisting, []);
});

test("marks the view as global when the task has no baseline", async (context) => {
  const { workspace } = await gitWorkspace(context);
  await writeFile(path.join(workspace, "tracked.txt"), "changed\n");

  const diff = await diffSince(workspace, null);

  assert.equal(diff.available, true);
  assert.equal(diff.scope, "workspace", "an unscoped diff must not claim to be task-scoped");
});

test("a run records a workspace baseline for later diffing", async (context) => {
  const { workspace } = await gitWorkspace(context);
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir: ".state",
    collaboration: { maxRounds: 1, transcriptMessages: 10, turnTimeoutMs: 5000 },
    agents: [{ id: "w", adapter: "mock", role: "Implement." }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(DEFAULT_SCHEMA_PATH);
  const orchestrator = new Orchestrator({ config, store, schema, schemaPath: DEFAULT_SCHEMA_PATH });
  const task = await orchestrator.createTask("Implement a change.");

  await orchestrator.runTask(task.id);
  const settled = await store.loadTask(task.id);

  assert.ok(settled.workspaceBaseline, "no baseline recorded");
  assert.match(settled.workspaceBaseline.head, /^[0-9a-f]{40}$/);
});

// --- P2-4: the Codex trace keeps the event stream ---------------------------

test("the Codex trace points at the event stream, not just the final message", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-codex-trace-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { CodexAdapter } = await import("../src/adapters/codex.js");
  const store = new TaskStore(path.join(workspace, ".state"));
  await store.init();

  // Stands in for `codex exec --json`: JSONL on stdout, final message to the
  // path given by --output-last-message.
  const fake = path.join(workspace, "fake-codex.cjs");
  await writeFile(fake, `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    const out = args[args.indexOf("--output-last-message") + 1];
    fs.writeFileSync(out, JSON.stringify({ summary: "did it", status: "done", messages: [], artifacts: [], needsUser: false }));
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls -la" } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } }) + "\\n");
  `);
  const adapter = new CodexAdapter(
    { id: "codex", command: process.execPath, commandArgs: [fake] },
    { schemaPath: DEFAULT_SCHEMA_PATH, store }
  );

  const result = await adapter.runTurn({ prompt: "go", workspace, timeoutMs: 15_000 });
  const trace = await readFile(result.tracePath, "utf8");

  assert.equal(result.response.summary, "did it");
  // The tool call is only in the event stream; a final-message trace loses it.
  assert.match(trace, /command_execution/);
  assert.match(trace, /ls -la/);
  assert.equal(result.usage.inputTokens, 5);
});
