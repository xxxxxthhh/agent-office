import "./_hang-watchdog.mjs";
// Regressions for the five issues found reviewing commit ac9f052.
// Each test reproduces the reported defect, so a revert of the fix fails here.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { runProcess } from "../src/adapters/process.js";
import { exists, sleep } from "../src/utils.js";
import { normalizeConfig } from "../src/config.js";
import { AdapterError, ConfigError, RunLeaseError } from "../src/errors.js";
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
  const ready = path.join(workspace, "stubborn.ready");
  // Ignores SIGTERM, so settling early would mean reporting "stopped" while the
  // process is still alive and still able to write.
  await writeFile(agent, `
    process.on("SIGTERM", () => {});
    require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready");
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `);

  const controller = new AbortController();
  const running = runProcess({
    command: process.execPath,
    args: [agent],
    cwd: workspace,
    signal: controller.signal,
    timeoutMs: 15_000
  });
  for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(ready), true, "stubborn child never installed its SIGTERM handler");
  const startedAt = Date.now();
  controller.abort();
  await assert.rejects(running, (error) => {
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

// --- Round 2: escalated findings against the first round of fixes -----------

test("a SIGTERM-ignoring grandchild is dead by the time cancellation settles", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-grandchild-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const pidFile = path.join(workspace, "grandchild.pid");
  const agent = path.join(workspace, "agent.cjs");
  // The parent obeys SIGTERM and closes immediately; the grandchild ignores it.
  // Settling on the parent's `close` alone would release the lease while the
  // grandchild is alive and still writing.
  await writeFile(agent, `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", \`
      process.on("SIGTERM", () => {});
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    \`], { stdio: "ignore" });
    grandchild.unref();
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `);

  const controller = new AbortController();
  const running = runProcess({
    command: process.execPath,
    args: [agent],
    cwd: workspace,
    signal: controller.signal,
    timeoutMs: 15_000
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await exists(pidFile)) break;
    await sleep(10);
  }
  if (!await exists(pidFile)) throw new Error("grandchild did not write a pid file before cancellation");
  controller.abort();
  await assert.rejects(() => running);

  // The moment of settling is the moment a lease would be released.
  const grandchildPid = Number(await readFile(pidFile, "utf8"));
  assert.throws(
    () => process.kill(grandchildPid, 0),
    "the grandchild was still alive when the cancellation settled"
  );
});

test("a baseline persistence failure still releases both leases", async (context) => {
  const { config, store, orchestrator } = await workspaceScaffold(context, async () => ({
    response: { summary: "d", status: "done", messages: [], artifacts: [], needsUser: false },
    tracePath: null
  }));
  const task = await orchestrator.createTask("baseline failure");
  const original = store.updateTask.bind(store);
  store.updateTask = async (id, type, ...rest) => {
    if (type === "workspace.baseline") throw new Error("injected baseline write failure");
    return original(id, type, ...rest);
  };

  await assert.rejects(() => orchestrator.runTask(task.id), /injected baseline write failure/);

  assert.equal(await store.readLease(task.id), null, "task lease leaked");
  assert.equal(await store.readWorkspaceLease(config.workspace), null, "workspace lease leaked");
});

test("two configs with different stateDirs cannot share a workspace concurrently", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-xdir-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const schema = await loadTurnSchema(DEFAULT_SCHEMA_PATH);
  const make = (stateDir, slow) => {
    const config = normalizeConfig({
      version: 1,
      workspace,
      stateDir,
      collaboration: { maxRounds: 1, transcriptMessages: 10, turnTimeoutMs: 10_000 },
      agents: [{ id: "w", adapter: "mock", role: "x" }]
    }, workspace);
    const store = new TaskStore(config.stateDir);
    const orchestrator = new Orchestrator({
      config, store, schema, schemaPath: DEFAULT_SCHEMA_PATH,
      adapterOverrides: { w: { describe: () => ({ kind: "t", command: null, safety: "t" }),
        runTurn: async () => {
          if (slow) await new Promise((resolve) => setTimeout(resolve, 400));
          return {
            response: { summary: "d", status: "done", messages: [], artifacts: [], needsUser: false },
            tracePath: null
          };
        } } }
    });
    return { config, store, orchestrator };
  };
  // Two legitimate configs, same workspace, DIFFERENT state directories: a lock
  // kept inside either stateDir is invisible to the other.
  const a = make(".stateA", true);
  const b = make(".stateB", false);
  const taskA = await a.orchestrator.createTask("A");
  const taskB = await b.orchestrator.createTask("B");

  const runA = a.orchestrator.runTask(taskA.id);
  await new Promise((resolve) => setTimeout(resolve, 120));

  await assert.rejects(
    () => b.orchestrator.runTask(taskB.id),
    (error) => {
      assert.ok(error instanceof RunLeaseError);
      assert.match(error.message, /Workspace .* already in use/);
      return true;
    }
  );
  await runA;

  // And a symlink alias of the workspace is the same workspace.
  const { symlink } = await import("node:fs/promises");
  const alias = path.join(os.tmpdir(), `agent-office-alias-${Date.now()}`);
  await symlink(workspace, alias);
  context.after(() => rm(alias, { force: true }));
  const c = make(".stateC", true);
  const viaAlias = normalizeConfig({
    version: 1,
    workspace: alias,
    stateDir: ".stateD",
    collaboration: { maxRounds: 1, transcriptMessages: 10, turnTimeoutMs: 10_000 },
    agents: [{ id: "w", adapter: "mock", role: "x" }]
  }, alias);
  const storeD = new TaskStore(viaAlias.stateDir);
  const orchD = new Orchestrator({
    config: viaAlias, store: storeD, schema, schemaPath: DEFAULT_SCHEMA_PATH,
    adapterOverrides: { w: { describe: () => ({ kind: "t", command: null, safety: "t" }),
      runTurn: async () => ({ response: { summary: "d", status: "done", messages: [], artifacts: [], needsUser: false }, tracePath: null }) } }
  });
  const taskC = await c.orchestrator.createTask("C");
  const taskD = await orchD.createTask("D");
  const runC = c.orchestrator.runTask(taskC.id);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await assert.rejects(() => orchD.runTask(taskD.id), RunLeaseError);
  await runC;
});

test("the task patch excludes pre-task dirt and includes untracked task files", async (context) => {
  const { workspace } = await gitWorkspace(context);
  const git = (args) => runProcess({ command: "git", args, cwd: workspace, timeoutMs: 10_000 });
  await writeFile(path.join(workspace, "pre.txt"), "committed base\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "add pre"]);
  // Unstaged pre-task user edit the task never touches.
  await writeFile(path.join(workspace, "pre.txt"), "user dirt\n");
  const baseline = await captureBaseline(workspace);
  await writeFile(path.join(workspace, "tracked.txt"), "task edit\n");
  await writeFile(path.join(workspace, "new.txt"), "untracked task file\n");

  const diff = await diffSince(workspace, baseline);

  assert.deepEqual(diff.changedDuringTask, ["new.txt", "tracked.txt"]);
  assert.deepEqual(diff.preexisting, ["pre.txt"]);
  assert.equal(diff.patch.includes("pre.txt"), false, "pre-task dirt leaked into the task patch");
  assert.equal(diff.stat.includes("pre.txt"), false, "pre-task dirt leaked into the task stat");
  assert.ok(diff.patch.includes("untracked task file"), "untracked task file missing from patch");
});

test("a task that commits its work still reports a consistent list and patch", async (context) => {
  const { workspace } = await gitWorkspace(context);
  const git = (args) => runProcess({ command: "git", args, cwd: workspace, timeoutMs: 10_000 });
  const baseline = await captureBaseline(workspace);
  await writeFile(path.join(workspace, "tracked.txt"), "task edit, then committed\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "task commit"]);

  const diff = await diffSince(workspace, baseline);

  // The tree is clean, but the task DID change this file.
  assert.deepEqual(diff.changedDuringTask, ["tracked.txt"]);
  assert.ok(diff.patch.includes("task edit, then committed"));
});

test("the workspace lock file never appears in a task diff", async (context) => {
  const { workspace } = await gitWorkspace(context);
  const baseline = await captureBaseline(workspace);
  const { WORKSPACE_LOCK_NAME } = await import("../src/store.js");
  await writeFile(path.join(workspace, WORKSPACE_LOCK_NAME), "{}");
  await writeFile(path.join(workspace, "real-change.txt"), "task work\n");

  const diff = await diffSince(workspace, baseline);

  assert.deepEqual(diff.changedDuringTask, ["real-change.txt"]);
  assert.equal(diff.patch.includes(WORKSPACE_LOCK_NAME), false);
});

// --- Round 3: escalated findings against the second round --------------------

test("concurrent stale-lock takeover yields exactly one owner (TOCTOU)", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-toctou-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { WORKSPACE_LOCK_NAME } = await import("../src/store.js");
  const lockPath = path.join(workspace, WORKSPACE_LOCK_NAME);
  const CONTENDERS = 6;
  const stores = [];
  for (let index = 0; index < CONTENDERS; index += 1) {
    const store = new TaskStore(path.join(workspace, `.state${index}`));
    await store.init();
    stores.push(store);
  }
  const staleLock = () => JSON.stringify({
    taskId: "task-20260101-deadbeef", runId: "crashed", kind: "workspace",
    workspace, pid: 2147483646, host: os.hostname(),
    startedAt: "2020-01-01T00:00:00.000Z", heartbeatAt: "2020-01-01T00:00:00.000Z"
  });

  // The old takeover (assess -> rm -> create) double-acquired within a handful
  // of attempts: the second rm deleted the winner's fresh lock.
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    await rm(lockPath, { force: true }).catch(() => {});
    await writeFile(lockPath, staleLock());
    const results = await Promise.allSettled(stores.map((store, index) => (
      store.acquireRunLease(`task-20260101-0000000${index}`, `run-${attempt}-${index}`, { workspace })
    )));
    const winners = results.filter((result) => result.status === "fulfilled");
    assert.equal(
      winners.length,
      1,
      `attempt ${attempt}: ${winners.length} contenders acquired the same workspace`
    );
    for (const winner of winners) await winner.value.release();
  }
});

test("a task edit to a pre-dirty file does not leak pre-task content into the patch", async (context) => {
  const { workspace } = await gitWorkspace(context);
  const blobDir = path.join(workspace, ".state", "baselines");
  // Pre-task user edit on a tracked file...
  await writeFile(path.join(workspace, "tracked.txt"), "baseline\nuser-before-task\n");
  const baseline = await captureBaseline(workspace, {
    stateDir: path.join(workspace, ".state"),
    blobDir
  });
  // ...then the task edits the SAME file.
  await writeFile(path.join(workspace, "tracked.txt"), "baseline\nuser-before-task\ntask-change\n");

  const diff = await diffSince(workspace, baseline, {
    stateDir: path.join(workspace, ".state"),
    blobDir
  });

  assert.deepEqual(diff.changedDuringTask, ["tracked.txt"]);
  assert.ok(diff.patch.includes("+task-change"), "the task's own edit is in the patch");
  assert.equal(
    diff.patch.includes("+user-before-task"),
    false,
    "the user's pre-task edit leaked into the task patch"
  );
});

test("an uncommitted rename is reported with both real paths", async (context) => {
  const { workspace, git } = await gitWorkspace(context);
  await writeFile(path.join(workspace, "before-name.txt"), "content\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "add before-name"]);
  const baseline = await captureBaseline(workspace);
  await git(["mv", "before-name.txt", "after-name.txt"]);

  const diff = await diffSince(workspace, baseline);

  // The -z porcelain rename record carries the origin as a second NUL field;
  // parsing it as a standalone record produced the mangled "ore-name.txt".
  assert.deepEqual(diff.changedDuringTask, ["after-name.txt", "before-name.txt"]);
  assert.ok(
    diff.patch.includes("before-name.txt"),
    "the old path's disappearance is missing from the patch"
  );
});

// --- Round 4: single-writer fencing and diff completeness --------------------

test("a live same-host holder with a paused heartbeat is not taken over", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-sigstop-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { WORKSPACE_LOCK_NAME } = await import("../src/store.js");
  // A holder whose heartbeat went silent long ago but whose PID (ours) is very
  // much alive — the shape of a SIGSTOPped process. Taking this lock over would
  // create two writers the moment the process resumes.
  await writeFile(path.join(workspace, WORKSPACE_LOCK_NAME), JSON.stringify({
    taskId: "task-20260101-00000001", runId: "paused-holder", kind: "workspace",
    workspace, pid: process.pid, host: os.hostname(),
    startedAt: "2020-01-01T00:00:00.000Z", heartbeatAt: "2020-01-01T00:00:00.000Z"
  }));
  const store = new TaskStore(path.join(workspace, ".state"), { staleLeaseMs: 50 });
  await store.init();

  await assert.rejects(
    () => store.acquireRunLease("task-20260101-00000002", "run-b", { workspace }),
    (error) => {
      assert.ok(error instanceof RunLeaseError);
      assert.equal(error.holder.runId, "paused-holder");
      return true;
    }
  );
});

test("a run whose workspace lock is stolen fences itself off", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-fence-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { WORKSPACE_LOCK_NAME } = await import("../src/store.js");
  const config = normalizeConfig({
    version: 1, workspace, stateDir: ".state",
    collaboration: { maxRounds: 1, transcriptMessages: 10, turnTimeoutMs: 30_000 },
    agents: [{ id: "w", adapter: "mock", role: "x" }]
  }, workspace);
  const store = new TaskStore(config.stateDir, { leaseHeartbeatMs: 40 });
  const schema = await loadTurnSchema(DEFAULT_SCHEMA_PATH);
  let sawAbort = false;
  const orchestrator = new Orchestrator({
    config, store, schema, schemaPath: DEFAULT_SCHEMA_PATH,
    adapterOverrides: { w: { describe: () => ({ kind: "t", command: null, safety: "t" }),
      runTurn: async ({ signal }) => new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          const error = new Error("Run cancelled: fenced");
          error.details = { cancelled: true };
          reject(error);
        }, { once: true });
      }) } }
  });
  const task = await orchestrator.createTask("fence test");
  const events = [];
  const run = orchestrator.runTask(task.id, { onEvent: (event) => events.push(event.type) });
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Any takeover path ends with a foreign lock at this path; the holder must
  // notice and stop writing rather than continue as a second writer.
  await writeFile(path.join(workspace, WORKSPACE_LOCK_NAME), JSON.stringify({
    taskId: "task-20260101-feedf00d", runId: "intruder", kind: "workspace",
    workspace, pid: process.pid, host: os.hostname(),
    startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString()
  }));
  const settled = await run;

  assert.equal(sawAbort, true, "the in-flight turn was not aborted on lease loss");
  assert.ok(events.includes("run.lost"), "no run.lost event was emitted");
  assert.equal(settled.status, "ready", "a fenced run stays resumable");
});

test("a file deleted before the task and restored by it has a real patch", async (context) => {
  const { workspace } = await gitWorkspace(context);
  const options = { stateDir: path.join(workspace, ".state"), blobDir: path.join(workspace, ".state", "baselines") };
  await rm(path.join(workspace, "tracked.txt"));
  const baseline = await captureBaseline(workspace, options);
  await writeFile(path.join(workspace, "tracked.txt"), "baseline\n");

  const diff = await diffSince(workspace, baseline, options);

  assert.deepEqual(diff.changedDuringTask, ["tracked.txt"]);
  assert.ok(diff.patch.includes("+baseline"), "the restore is invisible in the patch");
  assert.match(diff.stat, /restored during the task/);
});

test("a pre-task untracked file deleted by the task shows its content in the patch", async (context) => {
  const { workspace } = await gitWorkspace(context);
  const options = { stateDir: path.join(workspace, ".state"), blobDir: path.join(workspace, ".state", "baselines") };
  await writeFile(path.join(workspace, "pre-untracked.txt"), "user file content\n");
  const baseline = await captureBaseline(workspace, options);
  await rm(path.join(workspace, "pre-untracked.txt"));

  const diff = await diffSince(workspace, baseline, options);

  assert.deepEqual(diff.changedDuringTask, ["pre-untracked.txt"]);
  assert.ok(
    diff.patch.includes("-user file content"),
    "the deletion produced an empty patch while the list names the file"
  );
});

test("a committed rename keeps the old path in the list and patch", async (context) => {
  const { workspace, git } = await gitWorkspace(context);
  await writeFile(path.join(workspace, "before-name.txt"), "content\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "add before-name"]);
  const baseline = await captureBaseline(workspace);
  await git(["mv", "before-name.txt", "after-name.txt"]);
  await git(["commit", "-qm", "rename"]);

  const diff = await diffSince(workspace, baseline);

  // Rename detection collapses --name-only output to the destination alone.
  assert.deepEqual(diff.changedDuringTask, ["after-name.txt", "before-name.txt"]);
  assert.ok(diff.patch.includes("before-name.txt"), "the old path vanished from the patch");
});

// --- Round 6: a fence that fails to persist must not fail open ---------------

test("a contained workspace lock is not taken over once its holder is gone", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-contained-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { WORKSPACE_LOCK_NAME } = await import("../src/store.js");
  const { spawnSync } = await import("node:child_process");
  // A PID that has certainly exited, and a heartbeat from 2020: containment has
  // to hold precisely in the state where a stale lock would be taken over.
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  await writeFile(path.join(workspace, WORKSPACE_LOCK_NAME), JSON.stringify({
    taskId: "task-20260101-00000001", runId: "unproven-stop", kind: "workspace",
    workspace, pid: deadPid, host: os.hostname(),
    startedAt: "2020-01-01T00:00:00.000Z", heartbeatAt: "2020-01-01T00:00:00.000Z",
    contained: true
  }));
  const store = new TaskStore(path.join(workspace, ".state"), { staleLeaseMs: 50, lockTimeoutMs: 300 });
  await store.init();

  await assert.rejects(
    () => store.acquireRunLease("task-20260101-00000002", "run-b", { workspace }),
    /fenced after an unproven stop/
  );
  // The takeover path replaces the stale file in place; it must not have
  // overwritten the marker on its way to that rejection.
  const after = JSON.parse(await readFile(path.join(workspace, WORKSPACE_LOCK_NAME), "utf8"));
  assert.equal(after.contained, true);
  assert.equal(after.runId, "unproven-stop");
});

test("a fence that cannot be written keeps the workspace lock instead of releasing it", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-fence-write-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { WORKSPACE_FENCE_NAME, WORKSPACE_LOCK_NAME } = await import("../src/store.js");
  const { mkdir } = await import("node:fs/promises");
  const store = new TaskStore(path.join(workspace, ".state"));
  await store.init();
  const lease = await store.acquireRunLease("task-20260101-00000001", "unproven-stop", { workspace });
  // Something occupies the fence path by the time the run has to fence itself,
  // so the atomic rename fails.
  await mkdir(path.join(workspace, WORKSPACE_FENCE_NAME));

  const pinned = await store.pinWorkspaceFence(workspace, {
    taskId: "task-20260101-00000001",
    nodeId: "build"
  });
  assert.equal(pinned.source, "lock");
  await lease.release();

  assert.ok(
    existsSync(path.join(workspace, WORKSPACE_LOCK_NAME)),
    "the release freed the workspace although the fence never persisted"
  );
  // Clear what made the write fail: the converted lock alone has to keep the
  // workspace closed.
  await rm(path.join(workspace, WORKSPACE_FENCE_NAME), { recursive: true, force: true });
  await assert.rejects(
    () => store.acquireRunLease("task-20260101-00000002", "run-b", { workspace }),
    /fenced after an unproven stop/
  );
});

// --- Round 7: containment must be provable, not merely attempted ------------

test("a marker only this stateDir can see never ends the containment wait", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-contain-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const { WORKSPACE_FENCE_NAME, WORKSPACE_LOCK_NAME } = await import("../src/store.js");
  const { mkdir, readdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const store = new TaskStore(path.join(root, "state"), { containmentRetryMs: 25 });
  await store.init();
  const lease = await store.acquireRunLease("task-20260101-00000001", "unproven-stop", { workspace });
  // Neither marker inside the workspace can be written: both paths are
  // occupied by directories, so the atomic rename has nowhere to land. Only
  // the state record, which lives outside the workspace, can still be written.
  await mkdir(path.join(workspace, WORKSPACE_FENCE_NAME));
  await rm(path.join(workspace, WORKSPACE_LOCK_NAME));
  await mkdir(path.join(workspace, WORKSPACE_LOCK_NAME));
  const blocked = [];

  const pinning = store.pinWorkspaceFence(workspace, {
    taskId: "task-20260101-00000001",
    nodeId: "build"
  }, { onBlocked: (state) => blocked.push(state) });
  const pending = Symbol("pending");
  const raced = await Promise.race([
    pinning,
    new Promise((resolve) => setTimeout(() => resolve(pending), 150))
  ]);

  // The record IS written — it is how this config recovers — but a config with
  // another stateDir cannot see it, so it cannot end a wait whose whole purpose
  // is closing the workspace to everyone.
  assert.equal(raced, pending, "a state-local record was accepted as containment");
  assert.equal(blocked[0]?.recorded, "state", "the state record was never written");
  assert.equal((await readdir(store.containmentsDir)).length, 1);
  const rival = new TaskStore(path.join(root, "rival-state"));
  await rival.init();
  await assert.rejects(
    () => rival.acquireRunLease("task-20260101-00000002", "run-b", { workspace }),
    RunLeaseError,
    "a config with its own stateDir entered the workspace"
  );

  // Once the workspace itself takes a marker, the wait is over.
  await rm(path.join(workspace, WORKSPACE_FENCE_NAME), { recursive: true, force: true });
  const pinned = await pinning;
  assert.equal(pinned.source, "fence");
  await lease.release();
});

test("a throwing observer cannot end the containment wait", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-contain-observer-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const { WORKSPACE_FENCE_NAME } = await import("../src/store.js");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const store = new TaskStore(path.join(root, "state"), { containmentRetryMs: 25 });
  await store.init();
  await mkdir(path.join(workspace, WORKSPACE_FENCE_NAME));
  let calls = 0;

  // Both shapes an observer can fail in: a synchronous throw, and a rejected
  // promise from an async listener — the second would otherwise surface as an
  // unhandled rejection and take the process (and its lease) down.
  const observers = [
    () => { throw new Error("observer exploded"); },
    async () => { throw new Error("observer rejected"); },
    // A listener that never settles must not suspend containment either.
    () => new Promise(() => {})
  ];
  const pinning = store.pinWorkspaceFence(workspace, { nodeId: "build" }, {
    onBlocked: () => {
      calls += 1;
      return observers[calls % observers.length]();
    }
  });
  const pending = Symbol("pending");
  const raced = await Promise.race([
    pinning,
    new Promise((resolve) => setTimeout(() => resolve(pending), 150))
  ]);

  // Notification is the one part of this loop that may fail; letting it out
  // would end the run with nothing containing the workspace.
  assert.equal(raced, pending, "an observer exception ended the containment wait");
  assert.ok(calls >= 2, `the retry stopped after a throwing notification (${calls} calls)`);

  await rm(path.join(workspace, WORKSPACE_FENCE_NAME), { recursive: true, force: true });
  const pinned = await pinning;
  assert.equal(pinned.source, "fence");
});

test("a stop that cannot be contained anywhere never returns as contained", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-contain-none-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const { WORKSPACE_FENCE_NAME } = await import("../src/store.js");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const store = new TaskStore(path.join(root, "state"), { containmentRetryMs: 25 });
  await store.init();
  await mkdir(path.join(workspace, WORKSPACE_FENCE_NAME));
  // No lock is held, and the containments directory cannot be created because
  // a file already sits on its path: every location refuses the marker.
  await writeFile(store.containmentsDir, "not a directory\n");
  const blocked = [];

  const pinning = store.pinWorkspaceFence(workspace, { nodeId: "build" }, {
    onBlocked: (state) => blocked.push(state.attempts)
  });
  const pending = Symbol("pending");
  const raced = await Promise.race([
    pinning,
    new Promise((resolve) => setTimeout(() => resolve(pending), 150))
  ]);

  // Returning here would end the run and let the lock go stale while the agent
  // is still unproven; waiting keeps this process — a live holder — as the
  // containment until a marker takes.
  assert.equal(raced, pending, "an uncontained stop returned to its caller");
  assert.ok(blocked.length >= 1, "the wait was never reported to the operator");
  assert.equal(blocked[0], 1, "the first report came after a retry, not before the wait");
  // A containments path that is not a directory holds no record for anyone:
  // reading that as containment would fence every workspace this config sees.
  const open = path.join(root, "unrelated");
  await mkdir(open);
  const unrelated = await store.acquireRunLease("task-20260101-00000007", "run-g", { workspace: open });
  await unrelated.release();

  await rm(path.join(workspace, WORKSPACE_FENCE_NAME), { recursive: true, force: true });
  const pinned = await pinning;
  assert.equal(pinned.source, "fence");
});

test("a failed fence write leaves no scratch file in the workspace", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-fence-tmp-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { WORKSPACE_FENCE_NAME } = await import("../src/store.js");
  const { mkdir, readdir } = await import("node:fs/promises");
  const store = new TaskStore(path.join(workspace, ".state"));
  await store.init();
  // The held lock takes the marker the blocked fence path could not, so the
  // call returns and the only trace of the failed write is what it left behind.
  const lease = await store.acquireRunLease("task-20260101-00000001", "unproven-stop", { workspace });
  await mkdir(path.join(workspace, WORKSPACE_FENCE_NAME));

  const pinned = await store.pinWorkspaceFence(workspace, { nodeId: "build" });
  await lease.release();

  assert.equal(pinned.source, "lock");
  const leftovers = (await readdir(workspace)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "the interrupted atomic write left its temp file behind");
});

// --- Round 10: findings from the Codex review of the containment fix --------

test("a fence written while a run is acquiring the workspace still refuses it", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-fence-race-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { WORKSPACE_FENCE_NAME, WORKSPACE_LOCK_NAME } = await import("../src/store.js");
  const store = new TaskStore(path.join(workspace, ".state"));
  await store.init();
  await store.pinWorkspaceFence(workspace, { taskId: "task-20260101-00000001", nodeId: "build" });
  // Stands in for the window between the two: the fencing run writes its
  // marker and releases its lock while this acquisition is already past the
  // containment check and on its way to creating a lock of its own.
  const real = store.readWorkspaceContainment.bind(store);
  let checks = 0;
  store.readWorkspaceContainment = async (target) => (checks++ === 0 ? null : real(target));

  await assert.rejects(
    () => store.acquireRunLease("task-20260101-00000002", "run-b", { workspace }),
    /fenced after an unproven stop while this run was acquiring it/
  );

  assert.equal(checks, 2, "the lock was taken without a second containment check");
  assert.equal(
    existsSync(path.join(workspace, WORKSPACE_LOCK_NAME)),
    false,
    "the refused run left its workspace lock behind"
  );
  assert.equal(await store.readLease("task-20260101-00000002"), null);
  assert.ok(existsSync(path.join(workspace, WORKSPACE_FENCE_NAME)));
});

test("a lock that never became a marker is released once the fence persists", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-contain-clear-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { WORKSPACE_FENCE_NAME, WORKSPACE_LOCK_NAME } = await import("../src/store.js");
  const { realpath } = await import("node:fs/promises");
  const store = new TaskStore(path.join(workspace, ".state"));
  await store.init();
  const lease = await store.acquireRunLease("task-20260101-00000001", "unproven-stop", { workspace });
  // Stands in for a lock conversion that failed on an earlier attempt: the
  // lock is flagged unreleasable while nothing else contains the workspace.
  store.workspaceLocks.get(await realpath(workspace)).containing = true;

  const pinned = await store.pinWorkspaceFence(workspace, { nodeId: "build" });
  await lease.release();

  assert.equal(pinned.source, "fence");
  // The fence fences everyone. Keeping the lock too would leave a workspace
  // that stays closed after the operator deletes the fence, blocked by a lock
  // whose live PID makes it look held forever and which names no containment.
  assert.equal(
    existsSync(path.join(workspace, WORKSPACE_LOCK_NAME)),
    false,
    "an unmarked lock outlived the run that no longer needs it"
  );
  await rm(path.join(workspace, WORKSPACE_FENCE_NAME));
  const next = await store.acquireRunLease("task-20260101-00000002", "run-b", { workspace });
  await next.release();
});

test("a serial run whose process tree survives SIGKILL fences the workspace", async (context) => {
  const { config, store, orchestrator } = await workspaceScaffold(context, async () => {
    throw new AdapterError("Turn timed out after 10000 ms", { treeUnresponsive: true });
  });
  const task = await orchestrator.createTask("a turn whose tree cannot be killed");

  const finished = await orchestrator.runTask(task.id, {
    // No observer call between the unproven stop and the fencing may skip it.
    onEvent: (event) => {
      if (event.type === "turn.failed" || event.type === "round.completed") {
        throw new Error("observer exploded");
      }
    }
  });

  // Nothing proved that tree stopped, so the workspace has to close before the
  // run releases its lease — the serial path used to record the failure and
  // hand the workspace to the next run.
  assert.equal(finished.status, "failed");
  assert.match(finished.failureReason, /containment was recorded at/);
  assert.equal((await store.readWorkspaceFence(config.workspace)).kind, "containment");
  const next = await orchestrator.createTask("must not enter the fenced workspace");
  await assert.rejects(() => orchestrator.runTask(next.id), /fenced after an unproven stop/);
});

test("a marker that parses but describes nothing still fences the workspace", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-fence-falsey-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { WORKSPACE_FENCE_NAME } = await import("../src/store.js");
  const store = new TaskStore(path.join(workspace, ".state"));
  await store.init();

  // `null` parses, and every falsey value reads as "no fence" at the call site.
  for (const content of ["null", "false", "0", "[]", "{\"kind\":\"note\"}"]) {
    await writeFile(path.join(workspace, WORKSPACE_FENCE_NAME), content);
    const fence = await store.readWorkspaceFence(workspace);
    assert.equal(fence?.kind, "containment", `${content} was read as an open workspace`);
    assert.equal(fence.unreadable, true);
    await assert.rejects(
      () => store.acquireRunLease("task-20260101-00000004", "run-d", { workspace }),
      /fenced after an unproven stop/
    );
  }
});

test("a marker cannot name its own recovery path", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-fence-spoof-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { WORKSPACE_FENCE_NAME } = await import("../src/store.js");
  const store = new TaskStore(path.join(workspace, ".state"));
  await store.init();
  // Marker content is data, not instructions: it must not be able to point the
  // operator at a file that has nothing to do with the containment.
  await writeFile(path.join(workspace, WORKSPACE_FENCE_NAME), JSON.stringify({
    kind: "containment",
    workspace: "/tmp/not-this-workspace",
    source: "spoofed",
    path: "/tmp/not-the-marker",
    taskId: 42,
    reason: { toString: "not a string" }
  }));

  const containment = await store.readWorkspaceContainment(workspace);

  assert.equal(containment.source, "fence");
  assert.ok(containment.path.endsWith(WORKSPACE_FENCE_NAME), containment.path);
  assert.equal(containment.taskId, null);
  assert.equal(containment.reason, "Execution could not be proven stopped");
  await assert.rejects(
    () => store.acquireRunLease("task-20260101-00000006", "run-f", { workspace }),
    (error) => {
      assert.ok(!error.message.includes("/tmp/not-the-marker"), error.message);
      return true;
    }
  );
});

test("a workspace that is not a directory is a config error, not containment", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-not-a-dir-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace.txt");
  await writeFile(workspace, "this is a file, not a workspace\n");
  const store = new TaskStore(path.join(root, ".state"));
  await store.init();

  await assert.rejects(
    () => store.acquireRunLease("task-20260101-00000005", "run-e", { workspace }),
    (error) => {
      assert.ok(error instanceof ConfigError, `expected a config error, got ${error.name}`);
      assert.match(error.message, /is not a directory/);
      return true;
    }
  );
});

test("an unreadable fence marker counts as a fence, not as an open workspace", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-fence-torn-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { WORKSPACE_FENCE_NAME } = await import("../src/store.js");
  const store = new TaskStore(path.join(workspace, ".state"));
  await store.init();
  await writeFile(path.join(workspace, WORKSPACE_FENCE_NAME), "{ \"kind\": \"contain");

  const fence = await store.readWorkspaceFence(workspace);
  assert.equal(fence.kind, "containment");
  assert.equal(fence.unreadable, true);
  await assert.rejects(
    () => store.acquireRunLease("task-20260101-00000003", "run-c", { workspace }),
    /fenced after an unproven stop/
  );
});

test("heartbeat temp files of the workspace lock never enter the diff", async (context) => {
  const { workspace } = await gitWorkspace(context);
  const { WORKSPACE_LOCK_NAME } = await import("../src/store.js");
  const baseline = await captureBaseline(workspace);
  // The exact shape atomicWrite produces mid-heartbeat.
  await writeFile(path.join(workspace, `${WORKSPACE_LOCK_NAME}.61829.fced80d6.tmp`), "{}");

  const diff = await diffSince(workspace, baseline);

  assert.deepEqual(diff.changedDuringTask, []);
  assert.deepEqual(diff.status, []);
});

// --- Round 5: fence robustness, lock semantics, diff completeness ------------

test("a throwing run.lost observer cannot disable the fence", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-observer-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { WORKSPACE_LOCK_NAME } = await import("../src/store.js");
  const config = normalizeConfig({
    version: 1, workspace, stateDir: ".state",
    collaboration: { maxRounds: 1, transcriptMessages: 10, turnTimeoutMs: 30_000 },
    agents: [{ id: "w", adapter: "mock", role: "x" }]
  }, workspace);
  const store = new TaskStore(config.stateDir, { leaseHeartbeatMs: 40 });
  const schema = await loadTurnSchema(DEFAULT_SCHEMA_PATH);
  let sawAbort = false;
  const orchestrator = new Orchestrator({
    config, store, schema, schemaPath: DEFAULT_SCHEMA_PATH,
    adapterOverrides: { w: { describe: () => ({ kind: "t", command: null, safety: "t" }),
      runTurn: async ({ signal }) => new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          const error = new Error("Run cancelled: fenced");
          error.details = { cancelled: true };
          reject(error);
        }, { once: true });
      }) } }
  });
  const task = await orchestrator.createTask("observer boom");
  // The observer throwing used to run BEFORE controller.abort(), leaving a
  // heartbeat-less, lock-less run writing forever.
  const run = orchestrator.runTask(task.id, {
    onEvent: (event) => { if (event.type === "run.lost") throw new Error("observer boom"); }
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await writeFile(path.join(workspace, WORKSPACE_LOCK_NAME), JSON.stringify({
    taskId: "task-20260101-feedf00d", runId: "intruder", kind: "workspace",
    workspace, pid: process.pid, host: os.hostname(),
    startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString()
  }));

  const settled = await run;

  assert.equal(sawAbort, true, "the fence did not fire past the throwing observer");
  assert.equal(settled.status, "ready");
});

test("deleting the workspace lock fences the running owner", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-manual-rm-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { WORKSPACE_LOCK_NAME } = await import("../src/store.js");
  const config = normalizeConfig({
    version: 1, workspace, stateDir: ".state",
    collaboration: { maxRounds: 1, transcriptMessages: 10, turnTimeoutMs: 30_000 },
    agents: [{ id: "w", adapter: "mock", role: "x" }]
  }, workspace);
  const store = new TaskStore(config.stateDir, { leaseHeartbeatMs: 40 });
  const schema = await loadTurnSchema(DEFAULT_SCHEMA_PATH);
  let sawAbort = false;
  const orchestrator = new Orchestrator({
    config, store, schema, schemaPath: DEFAULT_SCHEMA_PATH,
    adapterOverrides: { w: { describe: () => ({ kind: "t", command: null, safety: "t" }),
      runTurn: async ({ signal }) => new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          const error = new Error("Run cancelled: fenced");
          error.details = { cancelled: true };
          reject(error);
        }, { once: true });
      }) } }
  });
  const task = await orchestrator.createTask("manual unlock");
  const run = orchestrator.runTask(task.id);
  await new Promise((resolve) => setTimeout(resolve, 150));

  // The manual recovery path the manual documents: remove the lock file and
  // the owner stops itself. It used to silently recreate the lock instead.
  await rm(path.join(workspace, WORKSPACE_LOCK_NAME));
  const settled = await run;

  assert.equal(sawAbort, true, "the owner kept running after its lock was removed");
  assert.equal(settled.status, "ready");
  const { existsSync: exists } = await import("node:fs");
  assert.equal(
    exists(path.join(workspace, WORKSPACE_LOCK_NAME)),
    false,
    "the deleted lock was recreated by the heartbeat"
  );
});

test("refused acquisitions do not leak listeners on the caller's signal", async (context) => {
  const { getEventListeners } = await import("node:events");
  const { config, store, orchestrator, workspace } = await workspaceScaffold(context, async () => ({
    response: { summary: "d", status: "done", messages: [], artifacts: [], needsUser: false },
    tracePath: null
  }));
  const holderTask = await orchestrator.createTask("holder");
  const holderLease = await store.acquireRunLease(holderTask.id, "run-holder", {
    workspace: config.workspace
  });
  context.after(() => holderLease.release());
  const loser = await orchestrator.createTask("loser");
  const controller = new AbortController();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await assert.rejects(() => orchestrator.runTask(loser.id, { signal: controller.signal }));
  }

  assert.equal(
    getEventListeners(controller.signal, "abort").length,
    0,
    "each refused run left an abort listener behind"
  );
});

test("files in new nested directories are listed and patched individually", async (context) => {
  const { workspace } = await gitWorkspace(context);
  const options = { stateDir: path.join(workspace, ".state"), blobDir: path.join(workspace, ".state", "baselines") };
  const { mkdir } = await import("node:fs/promises");
  // A pre-task untracked file inside a directory must survive as preexisting.
  await mkdir(path.join(workspace, "pre-dir"), { recursive: true });
  await writeFile(path.join(workspace, "pre-dir", "old.txt"), "pre-task file\n");
  const baseline = await captureBaseline(workspace, options);
  await mkdir(path.join(workspace, "nested", "deep"), { recursive: true });
  await writeFile(path.join(workspace, "nested", "deep", "new.txt"), "nested content\n");

  const diff = await diffSince(workspace, baseline, options);

  // Default git status collapses these to "nested/", which produced a listing
  // with no patch at all.
  assert.deepEqual(diff.changedDuringTask, ["nested/deep/new.txt"]);
  assert.deepEqual(diff.preexisting, ["pre-dir/old.txt"]);
  assert.ok(diff.patch.includes("nested content"), "the nested file's content is missing from the patch");
});
