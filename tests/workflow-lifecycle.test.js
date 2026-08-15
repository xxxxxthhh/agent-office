import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { normalizeConfig } from "../src/config.js";
import { RunLeaseError } from "../src/errors.js";
import { Orchestrator } from "../src/orchestrator.js";
import { loadTurnSchema } from "../src/protocol.js";
import { TaskStore, WORKSPACE_FENCE_NAME, WORKSPACE_LOCK_NAME } from "../src/store.js";
import { WorkflowOrchestrator } from "../src/workflow-orchestrator.js";

const SCHEMA_PATH = path.resolve("schemas/turn.schema.json");

async function createLifecycle(context, runtimeOverrides = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-lifecycle-"));
  const stateDir = `${workspace}-state`;
  context.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir,
    agents: [{ id: "alpha", adapter: "mock", role: "Alpha." }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  await store.init();
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const workflowOrchestrator = new WorkflowOrchestrator({
    config,
    store,
    schema,
    schemaPath: SCHEMA_PATH,
    runtimeOverrides: {
      workspaceManager: {
        resolve: async () => workspace,
        snapshot: async () => ({}),
        validateChanges: () => [],
        validateArtifacts: async () => []
      },
      ...runtimeOverrides
    }
  });
  const orchestrator = new Orchestrator({ config, store, schema, schemaPath: SCHEMA_PATH });
  orchestrator.setWorkflowOrchestrator(workflowOrchestrator);
  return { config, store, orchestrator, workflowOrchestrator };
}

function slowCommandWorkflow() {
  return {
    version: 1,
    nodes: [
      { id: "prepare", owner: "alpha" },
      {
        id: "hold",
        type: "command",
        dependsOn: ["prepare"],
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 8000)"]
      }
    ]
  };
}

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition was not met within ${timeoutMs} ms`);
}

test("a serial workspace lock blocks a workflow run on the same workspace", async (context) => {
  const { config, store, orchestrator, workflowOrchestrator } = await createLifecycle(context);
  const serial = await store.createTask("Hold the workspace.", [
    { id: "alpha", adapter: "mock", role: "Alpha." }
  ]);
  const workflow = await workflowOrchestrator.createWorkflow("Must wait for the serial run.", {
    version: 1,
    nodes: [{ id: "one", owner: "alpha" }]
  });
  const lease = await store.acquireRunLease(serial.id, "serial-holder", {
    workspace: config.workspace
  });
  try {
    await assert.rejects(() => orchestrator.runTask(workflow.id), RunLeaseError);
    assert.equal(await store.readLease(workflow.id), null);
  } finally {
    await lease.release();
  }
});

test("AbortSignal cancels an in-flight workflow and releases the disk lease", async (context) => {
  const { store, orchestrator, workflowOrchestrator } = await createLifecycle(context);
  const task = await workflowOrchestrator.createWorkflow("Hold then cancel.", slowCommandWorkflow());
  const controller = new AbortController();
  const started = waitFor(async () => {
    const current = await store.loadTask(task.id);
    return current.workflow.nodes.hold.status === "working" ? current : null;
  });
  const running = orchestrator.runTask(task.id, { signal: controller.signal });
  await started;
  assert.ok((await store.readLease(task.id))?.alive);
  controller.abort();
  const finished = await running;
  assert.equal(finished.status, "ready");
  assert.equal(await store.readLease(task.id), null);
  assert.ok(["ready", "pending"].includes(finished.workflow.nodes.hold.status));
});

test("refuses to delete a workflow that holds a live disk lease", async (context) => {
  const { store, orchestrator, workflowOrchestrator } = await createLifecycle(context);
  const task = await workflowOrchestrator.createWorkflow("Do not delete while running.", slowCommandWorkflow());
  const controller = new AbortController();
  const running = orchestrator.runTask(task.id, { signal: controller.signal });
  await waitFor(async () => (await store.readLease(task.id))?.alive);
  await assert.rejects(() => store.deleteTask(task.id), /cannot be deleted/);
  controller.abort();
  await running;
  const deleted = await store.deleteTask(task.id);
  assert.equal(deleted.deleted, true);
});

test("an unproven Herdr stop releases the run lease but keeps a workspace fence", async (context) => {
  let waitStarted;
  const waitStartedPromise = new Promise((resolve) => { waitStarted = resolve; });
  const { config, store, orchestrator, workflowOrchestrator } = await createLifecycle(context, {
    herdr: {
      ensureAgent: async () => ({ agentName: "ao-test", kind: "codex" }),
      dispatch: async (entry) => entry,
      wait: async (handle) => {
        waitStarted();
        await new Promise((_, reject) => {
          const fail = () => reject(Object.assign(new Error("cancelled"), { details: { cancelled: true } }));
          if (handle.signal?.aborted) return fail();
          handle.signal?.addEventListener("abort", fail, { once: true });
        });
      },
      interrupt: async () => ({ interrupted: true, settled: false }),
      release: async () => {}
    }
  });
  const task = await workflowOrchestrator.createWorkflow("Fence after unproven stop.", {
    version: 1,
    runtime: "herdr",
    nodes: [
      {
        id: "build",
        owner: "alpha",
        access: "write",
        workspace: "worktree",
        writeScopes: ["src/**"]
      },
      { id: "gate", type: "approval", dependsOn: ["build"], prompt: "Approve." },
      { id: "publish", type: "integration", source: "build", dependsOn: ["build", "gate"] }
    ]
  });
  const controller = new AbortController();
  const running = orchestrator.runTask(task.id, { signal: controller.signal });
  await waitStartedPromise;
  await waitFor(async () => (await store.readLease(task.id))?.alive);
  controller.abort();
  const finished = await running;
  assert.equal(finished.status, "failed");
  assert.equal(await store.readLease(task.id), null);
  assert.equal((await store.readWorkspaceFence(config.workspace)).kind, "containment");

  const other = await store.createTask("Must not share the fenced workspace.", [
    { id: "alpha", adapter: "mock", role: "Alpha." }
  ]);
  await assert.rejects(
    () => orchestrator.runTask(other.id),
    RunLeaseError
  );
});

test("an unproven stop whose fence cannot be written keeps the workspace lock", async (context) => {
  let waitStarted;
  const waitStartedPromise = new Promise((resolve) => { waitStarted = resolve; });
  let workspaceRoot;
  const { config, store, orchestrator, workflowOrchestrator } = await createLifecycle(context, {
    herdr: {
      ensureAgent: async () => ({ agentName: "ao-test", kind: "codex" }),
      dispatch: async (entry) => entry,
      wait: async (handle) => {
        // Occupied only once the run holds the workspace: the fence marker
        // cannot be written when the unproven stop tries to pin it, which is
        // the moment the workspace lock has to become the fence instead.
        await mkdir(path.join(workspaceRoot, WORKSPACE_FENCE_NAME));
        waitStarted();
        await new Promise((_, reject) => {
          const fail = () => reject(Object.assign(new Error("cancelled"), { details: { cancelled: true } }));
          if (handle.signal?.aborted) return fail();
          handle.signal?.addEventListener("abort", fail, { once: true });
        });
      },
      interrupt: async () => ({ interrupted: true, settled: false }),
      release: async () => {}
    }
  });
  workspaceRoot = config.workspace;
  const task = await workflowOrchestrator.createWorkflow("Fence without a writable marker.", {
    version: 1,
    runtime: "herdr",
    nodes: [
      {
        id: "build",
        owner: "alpha",
        access: "write",
        workspace: "worktree",
        writeScopes: ["src/**"]
      },
      { id: "gate", type: "approval", dependsOn: ["build"], prompt: "Approve." },
      { id: "publish", type: "integration", source: "build", dependsOn: ["build", "gate"] }
    ]
  });
  const controller = new AbortController();
  const running = orchestrator.runTask(task.id, { signal: controller.signal });
  await waitStartedPromise;
  await waitFor(async () => (await store.readLease(task.id))?.alive);
  controller.abort();
  const finished = await running;

  assert.equal(finished.status, "failed");
  assert.match(finished.failureReason, /containment marker/);
  const lock = JSON.parse(await readFile(path.join(config.workspace, WORKSPACE_LOCK_NAME), "utf8"));
  assert.equal(lock.contained, true, "the run released the workspace although its fence never persisted");

  // Clearing what blocked the marker must not reopen the workspace: only the
  // operator deleting the lock does that.
  await rm(path.join(config.workspace, WORKSPACE_FENCE_NAME), { recursive: true, force: true });
  const other = await store.createTask("Must not enter the contained workspace.", [
    { id: "alpha", adapter: "mock", role: "Alpha." }
  ]);
  await assert.rejects(
    () => orchestrator.runTask(other.id),
    (error) => {
      assert.ok(error instanceof RunLeaseError);
      // The operator has to be told which file to delete, and here that is the
      // lock rather than the fence that never got written.
      assert.match(error.message, /Confirm the agent is stopped, then delete /);
      assert.ok(error.message.endsWith(`${WORKSPACE_LOCK_NAME}.`), error.message);
      return true;
    }
  );
});
