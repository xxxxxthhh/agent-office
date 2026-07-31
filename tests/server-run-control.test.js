import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { normalizeConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { loadTurnSchema } from "../src/protocol.js";
import { DEFAULT_SCHEMA_PATH } from "../src/runtime.js";
import { DashboardServer } from "../src/server.js";
import { TaskStore } from "../src/store.js";

async function createServer(context, runTurn) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-run-control-"));
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir: ".state",
    collaboration: { maxRounds: 2, transcriptMessages: 20, turnTimeoutMs: 5000 },
    agents: [{ id: "worker", adapter: "mock", role: "Complete the task." }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
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
  const server = new DashboardServer({ config, store, orchestrator, host: "127.0.0.1", port: 0 });
  await server.start();
  context.after(async () => {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  });
  return { server, store, orchestrator };
}

const post = (url, body) => fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body ?? {})
});

const blockingTurn = async ({ signal }) => {
  await new Promise((resolve, reject) => {
    signal?.addEventListener("abort", () => {
      const error = new Error("Run cancelled: mock");
      error.details = { cancelled: true };
      reject(error);
    }, { once: true });
  });
  throw new Error("unreachable");
};

test("cancels a running task through the HTTP API", async (context) => {
  const { server, store } = await createServer(context, blockingTurn);
  const task = await (await post(`${server.url}/api/tasks`, {
    objective: "Implement a change."
  })).json();

  const started = await post(`${server.url}/api/tasks/${task.id}/run`, {});
  assert.equal(started.status, 202);
  await waitFor(async () => (await store.readLease(task.id))?.alive);

  const cancelled = await post(`${server.url}/api/tasks/${task.id}/cancel`, {});
  assert.equal(cancelled.status, 202);
  assert.equal((await cancelled.json()).status, "cancelling");

  // The lease is released after the status flips, so it is the later signal.
  await waitFor(async () => (await store.readLease(task.id)) === null);
  const settled = await store.loadTask(task.id);
  assert.equal(settled.status, "ready", "a cancelled run stays resumable");
});

test("rejects cancelling a task that is not running", async (context) => {
  const { server } = await createServer(context, blockingTurn);
  const task = await (await post(`${server.url}/api/tasks`, {
    objective: "Implement a change."
  })).json();

  const response = await post(`${server.url}/api/tasks/${task.id}/cancel`, {});
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /not running/);
});

test("reports an active run and refuses to start it twice", async (context) => {
  const { server, store } = await createServer(context, blockingTurn);
  const task = await (await post(`${server.url}/api/tasks`, {
    objective: "Implement a change."
  })).json();

  await post(`${server.url}/api/tasks/${task.id}/run`, {});
  await waitFor(async () => (await store.readLease(task.id))?.alive);

  const health = await (await fetch(`${server.url}/api/health`)).json();
  assert.ok(health.activeRuns[task.id], "an active run is visible in health");
  assert.equal(health.activeRuns[task.id].pid, process.pid);
  assert.equal(health.activeRuns[task.id].cancellable, true);
  assert.deepEqual(health.staleRunTaskIds, [], "a live run is not reported as stale");

  const second = await post(`${server.url}/api/tasks/${task.id}/run`, {});
  assert.equal(second.status, 409);

  await post(`${server.url}/api/tasks/${task.id}/cancel`, {});
});

test("reports a task abandoned in running as a stale run", async (context) => {
  const { server, store } = await createServer(context, blockingTurn);
  const task = await (await post(`${server.url}/api/tasks`, {
    objective: "Implement a change."
  })).json();
  // Simulate a run whose process died mid-turn: status stayed `running`, and the
  // lease points at a pid that no longer exists.
  await store.updateTask(task.id, "run.started", (current) => {
    current.status = "running";
  });
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

  const health = await (await fetch(`${server.url}/api/health`)).json();
  assert.deepEqual(health.staleRunTaskIds, [task.id]);
  assert.equal(health.activeRuns[task.id], undefined);

  // A stale run must be restartable rather than permanently stuck.
  const restarted = await post(`${server.url}/api/tasks/${task.id}/run`, {});
  assert.equal(restarted.status, 202);
  await waitFor(async () => (await store.readLease(task.id))?.alive);
  await post(`${server.url}/api/tasks/${task.id}/cancel`, {});
});

test("shuts down promptly while the dashboard holds an SSE stream open", async (context) => {
  const { server } = await createServer(context, blockingTurn);
  // The dashboard always keeps /api/stream open. An open response blocks
  // server.close() indefinitely unless shutdown terminates it, so this guards
  // the Ctrl+C path against a regression in that handling.
  const stream = await new Promise((resolve, reject) => {
    const request = httpRequest(`${server.url}/api/stream`, (response) => {
      response.resume();
      resolve(response);
    });
    request.on("error", reject);
    request.end();
  });
  context.after(() => stream.destroy());

  const startedAt = Date.now();
  await server.close();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 2000, `close() took ${elapsed}ms with an open SSE stream`);
});

async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
