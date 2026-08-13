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
import { TaskStore } from "../src/store.js";
import { WorkflowOrchestrator } from "../src/workflow-orchestrator.js";

const SCHEMA_PATH = path.resolve("schemas/turn.schema.json");

async function createLifecycle(context) {
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
      }
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
