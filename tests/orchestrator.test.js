import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { normalizeConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { Orchestrator } from "../src/orchestrator.js";
import { loadTurnSchema } from "../src/protocol.js";
import { TaskStore } from "../src/store.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(PACKAGE_ROOT, "schemas", "turn.schema.json");

test("reactivates a completed colleague when direct review feedback arrives", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-orchestrator-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir: ".state",
    collaboration: { maxRounds: 3, transcriptMessages: 20, turnTimeoutMs: 5000 },
    agents: [
      {
        id: "builder",
        adapter: "mock",
        role: "Implement and revise.",
        replies: [
          {
            summary: "Initial implementation is ready.",
            status: "done",
            messages: [{ to: "reviewer", body: "Please review it." }],
            artifacts: ["src/change.js"],
            needsUser: false
          },
          {
            summary: "Review issue fixed and tested.",
            status: "done",
            messages: [],
            artifacts: ["tests/change.test.js"],
            needsUser: false
          }
        ]
      },
      {
        id: "reviewer",
        adapter: "mock",
        role: "Find correctness gaps.",
        replies: [
          {
            summary: "One edge case needs a fix.",
            status: "done",
            messages: [{ to: "builder", body: "Cover empty input." }],
            artifacts: [],
            needsUser: false
          }
        ]
      }
    ]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const orchestrator = new Orchestrator({ config, store, schema, schemaPath: SCHEMA_PATH });
  const task = await orchestrator.createTask("Ship a boundary-safe change.");

  const completed = await orchestrator.runTask(task.id);

  assert.equal(completed.status, "completed");
  assert.equal(completed.roundsCompleted, 2);
  assert.equal(completed.participants.builder.turns, 2);
  assert.equal(completed.participants.reviewer.turns, 1);
  assert.match(completed.messages.at(-1).body, /fixed and tested/i);
});

test("pauses for user input when an agent explicitly requests it", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-user-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    agents: [
      {
        id: "planner",
        adapter: "mock",
        role: "Clarify unsafe choices.",
        replies: [{
          summary: "The destructive target is ambiguous.",
          status: "blocked",
          messages: [{ to: "user", body: "Which exact directory may be replaced?" }],
          artifacts: [],
          needsUser: true
        }]
      }
    ]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const orchestrator = new Orchestrator({ config, store, schema, schemaPath: SCHEMA_PATH });
  const task = await orchestrator.createTask("Replace an unspecified directory.");

  const paused = await orchestrator.runTask(task.id);
  assert.equal(paused.status, "awaiting_input");

  await store.addMessage(task.id, { from: "user", to: "planner", body: "Use ./sandbox only." });
  const resumed = await store.loadTask(task.id);
  assert.equal(resumed.status, "ready");
  assert.equal(resumed.participants.planner.status, "working");
});

test("refuses to run a persisted task under a different team roster", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-roster-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const initialConfig = normalizeConfig({
    version: 1,
    workspace,
    agents: [{ id: "original", adapter: "mock", role: "Own the task." }]
  }, workspace);
  const store = new TaskStore(initialConfig.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const original = new Orchestrator({
    config: initialConfig,
    store,
    schema,
    schemaPath: SCHEMA_PATH
  });
  const task = await original.createTask("Keep task ownership stable.");
  const changedConfig = normalizeConfig({
    version: 1,
    workspace,
    agents: [{ id: "replacement", adapter: "mock", role: "Different owner." }]
  }, workspace);
  const changed = new Orchestrator({
    config: changedConfig,
    store,
    schema,
    schemaPath: SCHEMA_PATH
  });

  await assert.rejects(() => changed.runTask(task.id), ConfigError);
});

test("rechecks runtime capabilities before running a persisted task", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-run-preflight-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    agents: [{ id: "worker", adapter: "mock", role: "Complete the task." }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const original = new Orchestrator({
    config,
    store,
    schema,
    schemaPath: SCHEMA_PATH
  });
  const task = await original.createTask("Verify independent run initialization.");

  const resumedConfig = normalizeConfig({
    version: 1,
    workspace,
    agents: [{ id: "worker", adapter: "mock", role: "Complete the task." }]
  }, workspace);
  let discoveryCalls = 0;
  let commandSeenByAdapter = null;
  const resumed = new Orchestrator({
    config: resumedConfig,
    store,
    schema,
    schemaPath: SCHEMA_PATH,
    capabilityRegistry: {
      discover: async () => {
        discoveryCalls += 1;
        resumedConfig.agents[0].command = "/newer/runtime/worker";
        return {};
      }
    },
    adapterOverrides: {
      worker: {
        describe: () => ({ kind: "capture", command: null, safety: "test" }),
        runTurn: async () => {
          commandSeenByAdapter = resumedConfig.agents[0].command;
          return {
            response: {
              summary: "Runtime preflight completed.",
              status: "done",
              messages: [],
              artifacts: [],
              needsUser: false
            },
            tracePath: null
          };
        }
      }
    }
  });

  const completed = await resumed.runTask(task.id);

  assert.equal(discoveryCalls, 1);
  assert.equal(commandSeenByAdapter, "/newer/runtime/worker");
  assert.equal(completed.status, "completed");
});

test("does not expose a user's direct message to another agent", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-private-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    agents: [
      { id: "alpha", adapter: "mock", role: "Receive a direct note." },
      { id: "beta", adapter: "mock", role: "Must not receive alpha's direct note." }
    ]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const captured = {};
  const adapterOverrides = Object.fromEntries(config.agents.map((agent) => [
    agent.id,
    {
      describe: () => ({ kind: "capture", command: null, safety: "test" }),
      runTurn: async ({ prompt }) => {
        captured[agent.id] = prompt;
        return {
          response: {
            summary: `${agent.id} finished.`,
            status: "done",
            messages: [],
            artifacts: [],
            needsUser: false
          },
          tracePath: null,
          stderr: ""
        };
      }
    }
  ]));
  const orchestrator = new Orchestrator({
    config,
    store,
    schema,
    schemaPath: SCHEMA_PATH,
    adapterOverrides
  });
  const task = await orchestrator.createTask("Respect direct-message visibility.");
  await store.addMessage(task.id, {
    from: "user",
    to: "alpha",
    body: "alpha-only-context"
  });

  await orchestrator.runTask(task.id);

  assert.match(captured.alpha, /alpha-only-context/);
  assert.doesNotMatch(captured.beta, /alpha-only-context/);
});

test("a user follow-up can reactivate a completed teammate and task", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-follow-up-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    agents: [{
      id: "worker",
      adapter: "mock",
      role: "Complete work and handle follow-ups.",
      replies: [
        {
          summary: "Initial work completed.",
          status: "done",
          messages: [],
          artifacts: [],
          needsUser: false
        },
        {
          summary: "Follow-up completed.",
          status: "done",
          messages: [],
          artifacts: [],
          needsUser: false
        }
      ]
    }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const orchestrator = new Orchestrator({ config, store, schema, schemaPath: SCHEMA_PATH });
  const task = await orchestrator.createTask("Complete an initial task.");
  const completed = await orchestrator.runTask(task.id);
  assert.equal(completed.status, "completed");

  await store.addMessage(task.id, {
    from: "user",
    to: "worker",
    body: "Please add the follow-up."
  });
  const reactivated = await store.loadTask(task.id);
  assert.equal(reactivated.status, "ready");
  assert.equal(reactivated.participants.worker.status, "working");

  const followedUp = await orchestrator.runTask(task.id);
  assert.equal(followedUp.status, "completed");
  assert.equal(followedUp.participants.worker.turns, 2);
});
