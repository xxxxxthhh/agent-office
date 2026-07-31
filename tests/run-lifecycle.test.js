import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { normalizeConfig } from "../src/config.js";
import { RunLeaseError } from "../src/errors.js";
import { Orchestrator } from "../src/orchestrator.js";
import { loadTurnSchema } from "../src/protocol.js";
import { DEFAULT_SCHEMA_PATH } from "../src/runtime.js";
import { TaskStore } from "../src/store.js";

async function scaffold(context, runTurn, storeOptions = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-run-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    collaboration: { maxRounds: 3, transcriptMessages: 10, turnTimeoutMs: 5000 },
    agents: [{ id: "worker", adapter: "mock", role: "Implement the change." }]
  }, workspace);
  const store = new TaskStore(config.stateDir, storeOptions);
  const schema = await loadTurnSchema(DEFAULT_SCHEMA_PATH);
  const orchestrator = new Orchestrator({
    config,
    store,
    schema,
    schemaPath: DEFAULT_SCHEMA_PATH,
    adapterOverrides: {
      worker: { describe: () => ({ kind: "test", command: null, safety: "test" }), runTurn }
    }
  });
  return { config, store, orchestrator };
}

const doneTurn = async () => ({
  response: {
    summary: "Finished the change.",
    status: "done",
    messages: [],
    artifacts: [],
    needsUser: false
  },
  tracePath: null
});

test("refuses a second concurrent run of the same task", async (context) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, orchestrator } = await scaffold(context, async () => {
    await gate;
    return doneTurn();
  });
  const task = await orchestrator.createTask("Implement a change.");

  const first = orchestrator.runTask(task.id);
  await waitFor(async () => (await store.readLease(task.id))?.alive);

  await assert.rejects(
    () => orchestrator.runTask(task.id),
    (error) => {
      assert.ok(error instanceof RunLeaseError);
      assert.equal(error.holder.pid, process.pid);
      assert.match(error.message, /already being run/);
      return true;
    }
  );

  release();
  await first;
});

test("releases the run lease when the run finishes", async (context) => {
  const { store, orchestrator } = await scaffold(context, doneTurn);
  const task = await orchestrator.createTask("Implement a change.");

  await orchestrator.runTask(task.id);

  assert.equal(await store.readLease(task.id), null);
});

test("releases the run lease when a turn throws", async (context) => {
  const { store, orchestrator } = await scaffold(context, async () => {
    throw new Error("adapter exploded");
  });
  const task = await orchestrator.createTask("Implement a change.");

  const settled = await orchestrator.runTask(task.id);

  assert.equal(settled.status, "failed");
  assert.equal(await store.readLease(task.id), null);
});

test("treats a lease from a dead process as reclaimable", async (context) => {
  const { store, orchestrator } = await scaffold(context, doneTurn);
  const task = await orchestrator.createTask("Implement a change.");
  // A pid that cannot exist stands in for a crashed run.
  await store.init();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    path.join(store.leasesDir, `${task.id}.json`),
    JSON.stringify({
      taskId: task.id,
      runId: "abandoned",
      pid: 2147483646,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    })
  );

  assert.equal((await store.readLease(task.id)).alive, false);
  const completed = await orchestrator.runTask(task.id);
  assert.equal(completed.status, "completed");
});

test("a corrupt lease file is reclaimed instead of surfacing a raw EEXIST", async (context) => {
  const { store, orchestrator } = await scaffold(context, doneTurn);
  const task = await orchestrator.createTask("Implement a change.");
  await store.init();
  const { writeFile } = await import("node:fs/promises");
  // A torn or truncated lease has no live holder and must not block the run.
  await writeFile(path.join(store.leasesDir, `${task.id}.json`), '{"taskId":"tas');

  assert.equal(await store.readLease(task.id), null);
  const completed = await orchestrator.runTask(task.id);
  assert.equal(completed.status, "completed");
});

test("heartbeat rewrites never expose a partially written lease", async (context) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, orchestrator } = await scaffold(
    context,
    async () => { await gate; return doneTurn(); },
    // Heartbeat aggressively so many rewrites race the reads below.
    { leaseHeartbeatMs: 1 }
  );
  const task = await orchestrator.createTask("Implement a change.");
  const run = orchestrator.runTask(task.id);
  await waitFor(async () => (await store.readLease(task.id))?.alive);

  for (let attempt = 0; attempt < 300; attempt += 1) {
    const lease = await store.readLease(task.id);
    assert.notEqual(lease, null, "a concurrent read never sees a torn lease");
    assert.equal(lease.taskId, task.id);
  }

  release();
  await run;
});

test("cancelling a run leaves the task resumable rather than failed", async (context) => {
  const controller = new AbortController();
  let started = 0;
  const { store, orchestrator } = await scaffold(context, async ({ signal }) => {
    started += 1;
    await new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => {
        const error = new Error("Run cancelled: mock");
        error.details = { cancelled: true };
        reject(error);
      }, { once: true });
    });
    return doneTurn();
  });
  const task = await orchestrator.createTask("Implement a change.");

  const run = orchestrator.runTask(task.id, { signal: controller.signal });
  await waitFor(() => started > 0);
  controller.abort();
  const cancelled = await run;

  assert.equal(started, 1);
  assert.equal(cancelled.status, "ready", "a cancelled run stays runnable");
  // The agent was interrupted, not at fault, so it must not be marked failed.
  assert.notEqual(cancelled.participants.worker.status, "failed");
  assert.equal(cancelled.turns.length, 0);
  assert.equal(await store.readLease(task.id), null);
});

test("records a cancellation event distinct from a pause", async (context) => {
  const controller = new AbortController();
  const { store, orchestrator } = await scaffold(context, async ({ signal }) => {
    await new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => {
        const error = new Error("Run cancelled: mock");
        error.details = { cancelled: true };
        reject(error);
      }, { once: true });
    });
    return doneTurn();
  });
  const task = await orchestrator.createTask("Implement a change.");

  const run = orchestrator.runTask(task.id, { signal: controller.signal });
  await waitFor(async () => (await store.readLease(task.id))?.alive);
  controller.abort();
  await run;

  const events = await store.readEvents(50);
  assert.ok(events.some((event) => event.type === "run.cancelled"));
});

test("a run cancelled before its first turn does not consume a round", async (context) => {
  const controller = new AbortController();
  controller.abort();
  const { orchestrator } = await scaffold(context, async () => {
    throw new Error("must not run");
  });
  const task = await orchestrator.createTask("Implement a change.");

  const cancelled = await orchestrator.runTask(task.id, { signal: controller.signal });

  assert.equal(cancelled.status, "ready");
  assert.equal(cancelled.roundsCompleted, 0);
});

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
