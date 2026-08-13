import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { normalizeConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { Orchestrator } from "../src/orchestrator.js";
import { WorkflowOrchestrator } from "../src/workflow-orchestrator.js";
import { runProcess } from "../src/adapters/process.js";
import { loadTurnSchema } from "../src/protocol.js";
import { TaskStore } from "../src/store.js";

const SCHEMA_PATH = path.resolve("schemas/turn.schema.json");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_HERDR = path.join(ROOT, "tests", "fixtures", "fake-herdr.js");

test("runs the ready set in parallel and holds a join until every dependency succeeds", async (context) => {
  const fixture = await createFixture(context);
  let active = 0;
  let maxActive = 0;
  let bothStarted;
  const bothStartedPromise = new Promise((resolve) => { bothStarted = resolve; });
  const events = [];
  const fakeRuntime = {
    ensureAgent: async () => null,
    dispatch: async (entry) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`start:${entry.node.id}`);
      if (active === 2) bothStarted();
      return entry;
    },
    wait: async (handle) => {
      if (handle.node.id !== "join") await bothStartedPromise;
      await new Promise((resolve) => setTimeout(resolve, handle.node.id === "join" ? 5 : 10));
      active -= 1;
      events.push(`end:${handle.node.id}`);
      return {
        response: {
          summary: `${handle.node.id} done`,
          status: "done",
          messages: [],
          artifacts: [],
          needsUser: false
        },
        tracePath: null
      };
    },
    release: async () => {}
  };
  const orchestrator = fixture.orchestrator({ process: fakeRuntime });
  const task = await orchestrator.createWorkflow("Fan out, then join.", {
    version: 1,
    maxConcurrency: 2,
    nodes: [
      { id: "left", owner: "alpha", prompt: "Left analysis." },
      { id: "right", owner: "beta", prompt: "Right analysis." },
      { id: "join", owner: "alpha", dependsOn: ["left", "right"], prompt: "Join." }
    ]
  });

  const completed = await orchestrator.runWorkflow(task.id);

  assert.equal(completed.status, "completed");
  assert.equal(maxActive, 2);
  assert.ok(events.indexOf("start:join") > events.indexOf("end:left"));
  assert.ok(events.indexOf("start:join") > events.indexOf("end:right"));
  assert.deepEqual(completed.workflow.order.map((id) => completed.workflow.nodes[id].status), [
    "succeeded", "succeeded", "succeeded"
  ]);
});

test("stops at an approval gate and resumes only after explicit approval", async (context) => {
  const fixture = await createFixture(context);
  const runtime = doneRuntime();
  const orchestrator = fixture.orchestrator({ process: runtime });
  const task = await orchestrator.createWorkflow("Require a human gate.", {
    version: 1,
    nodes: [
      { id: "prepare", owner: "alpha" },
      { id: "gate", type: "approval", dependsOn: ["prepare"], prompt: "Approve release." },
      { id: "finish", owner: "beta", dependsOn: ["gate"] }
    ]
  });

  const paused = await orchestrator.runWorkflow(task.id);
  assert.equal(paused.status, "awaiting_input");
  assert.equal(paused.workflow.nodes.gate.status, "awaiting_approval");
  assert.equal(paused.workflow.nodes.finish.status, "pending");

  await fixture.store.approveWorkflowNode(task.id, "gate");
  const completed = await orchestrator.runWorkflow(task.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.workflow.nodes.finish.status, "succeeded");
});

test("rejects stale turn submissions and the legacy orchestrator cannot silently run v2", async (context) => {
  const fixture = await createFixture(context);
  const orchestrator = fixture.orchestrator({ process: doneRuntime() });
  const task = await orchestrator.createWorkflow("Protect attempts.", {
    version: 1,
    nodes: [{ id: "one", owner: "alpha" }]
  });
  await fixture.store.updateTask(task.id, "test.claim", (current) => {
    current.workflow.nodes.one.status = "working";
    current.workflow.nodes.one.attemptToken = "current";
  });
  await assert.rejects(
    () => fixture.store.submitWorkflowTurn(task.id, "one", "stale", {
      summary: "stale",
      status: "done",
      messages: [],
      artifacts: [],
      needsUser: false
    }),
    ConfigError
  );
  const legacy = new Orchestrator({
    config: fixture.config,
    store: fixture.store,
    schema: await loadTurnSchema(SCHEMA_PATH),
    schemaPath: SCHEMA_PATH
  });
  await assert.rejects(
    () => legacy.runTask(task.id),
    /Workflow task requires a WorkflowOrchestrator runtime/
  );
});

test("fences a second scheduler while the first workflow lease is alive", async (context) => {
  const fixture = await createFixture(context);
  let releaseFirst;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const hold = new Promise((resolve) => { releaseFirst = resolve; });
  const runtime = {
    ensureAgent: async () => null,
    dispatch: async (entry) => {
      started();
      return entry;
    },
    wait: async (handle) => {
      await hold;
      return {
        response: {
          summary: `${handle.node.id} done`,
          status: "done",
          messages: [],
          artifacts: [],
          needsUser: false
        },
        tracePath: null
      };
    },
    release: async () => {}
  };
  const first = fixture.orchestrator({ process: runtime });
  const second = fixture.orchestrator({ process: runtime });
  const task = await first.createWorkflow("Only one scheduler may own a workflow.", {
    version: 1,
    nodes: [{ id: "one", owner: "alpha" }]
  });
  const running = first.runWorkflow(task.id);
  await startedPromise;

  await assert.rejects(() => second.runWorkflow(task.id), /already running under lease/);
  releaseFirst();
  const completed = await running;
  assert.equal(completed.status, "completed");
  assert.equal(completed.workflow.nodes.one.attempts, 1);
});

test("retries a blocked node after a user answer and exposes only addressed messages", async (context) => {
  const fixture = await createFixture(context);
  const prompts = [];
  let turn = 0;
  const runtime = {
    ensureAgent: async () => null,
    dispatch: async (entry) => {
      prompts.push(entry.prompt);
      return entry;
    },
    wait: async () => {
      turn += 1;
      return {
        response: turn === 1
          ? {
              summary: "Need the format.",
              status: "blocked",
              messages: [{ to: "user", body: "Which format?" }],
              artifacts: [],
              needsUser: true
            }
          : {
              summary: "Used JSON and finished.",
              status: "done",
              messages: [],
              artifacts: [],
              needsUser: false
            },
        tracePath: null
      };
    },
    release: async () => {}
  };
  const orchestrator = fixture.orchestrator({ process: runtime });
  const task = await orchestrator.createWorkflow("Resume after a decision.", {
    version: 1,
    nodes: [{ id: "one", owner: "alpha" }]
  });
  const paused = await orchestrator.runWorkflow(task.id);
  assert.equal(paused.status, "awaiting_input");
  assert.equal(paused.workflow.nodes.one.attempts, 1);
  await fixture.store.addMessage(task.id, { from: "user", to: "alpha", body: "Use JSON." });
  await fixture.store.addMessage(task.id, { from: "user", to: "beta", body: "beta-private" });
  await fixture.store.retryWorkflowNode(task.id, "one");
  const reopened = await fixture.store.loadTask(task.id);
  assert.equal(reopened.workflow.nodes.one.attempts, 0);
  const completed = await orchestrator.runWorkflow(task.id);

  assert.equal(completed.status, "completed");
  assert.equal(completed.workflow.nodes.one.attempts, 1);
  assert.match(prompts[1], /Use JSON\./);
  assert.doesNotMatch(prompts[1], /beta-private/);
});

test("retry reopens skipped descendants after a transient upstream failure", async (context) => {
  const fixture = await createFixture(context);
  let firstAttempt = true;
  const runtime = {
    ensureAgent: async () => null,
    dispatch: async (entry) => entry,
    wait: async (handle) => {
      if (handle.node.id === "first" && firstAttempt) {
        firstAttempt = false;
        throw new Error("transient failure");
      }
      return {
        response: {
          summary: `${handle.node.id} done`,
          status: "done",
          messages: [],
          artifacts: [],
          needsUser: false
        },
        tracePath: null
      };
    },
    release: async () => {}
  };
  const orchestrator = fixture.orchestrator({ process: runtime });
  const task = await orchestrator.createWorkflow("Recover the dependency chain.", {
    version: 1,
    nodes: [
      { id: "first", owner: "alpha", maxAttempts: 1 },
      { id: "second", owner: "beta", dependsOn: ["first"] }
    ]
  });
  const failed = await orchestrator.runWorkflow(task.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.workflow.nodes.first.attempts, 1);
  assert.equal(failed.workflow.nodes.second.status, "skipped");

  await fixture.store.retryWorkflowNode(task.id, "first");
  const reopened = await fixture.store.loadTask(task.id);
  assert.equal(reopened.workflow.nodes.first.attempts, 1);
  assert.equal(reopened.workflow.nodes.second.status, "pending");
  const completed = await orchestrator.runWorkflow(task.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.workflow.nodes.first.attempts, 2);
  assert.equal(completed.workflow.nodes.second.status, "succeeded");
});

test("manual retry grants one exhausted attempt without extending automatic working retries", async (context) => {
  const fixture = await createFixture(context);
  let dispatches = 0;
  const runtime = {
    ensureAgent: async () => null,
    dispatch: async (entry) => {
      dispatches += 1;
      return entry;
    },
    wait: async () => ({
      response: {
        summary: "More work remains.",
        status: "working",
        messages: [],
        artifacts: [],
        needsUser: false
      },
      tracePath: null
    }),
    release: async () => {}
  };
  const orchestrator = fixture.orchestrator({ process: runtime });
  const task = await orchestrator.createWorkflow("Bound automatic retries.", {
    version: 1,
    nodes: [{ id: "one", owner: "alpha", maxAttempts: 2 }]
  });

  const exhausted = await orchestrator.runWorkflow(task.id);
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.workflow.nodes.one.attempts, 2);
  assert.equal(dispatches, 2);

  await fixture.store.retryWorkflowNode(task.id, "one");
  const retried = await orchestrator.runWorkflow(task.id);
  assert.equal(retried.status, "failed");
  assert.equal(retried.workflow.nodes.one.attempts, 3);
  assert.equal(retried.workflow.nodes.one.maxAttempts, 2);
  assert.equal(dispatches, 3);
});

test("reopens a succeeded writer for review-driven rework and reruns its descendants", async (context) => {
  const fixture = await createFixture(context);
  const prompts = [];
  const runs = new Map();
  const runtime = {
    ensureAgent: async () => null,
    dispatch: async (entry) => {
      prompts.push({ nodeId: entry.node.id, prompt: entry.prompt });
      return entry;
    },
    wait: async (handle) => {
      const count = (runs.get(handle.node.id) ?? 0) + 1;
      runs.set(handle.node.id, count);
      if (handle.node.id === "review" && count === 1) {
        return {
          response: {
            summary: "The edge case is not handled.",
            status: "blocked",
            messages: [{ to: "alpha", body: "Fix the empty-input edge case before release." }],
            artifacts: [],
            needsUser: true
          },
          tracePath: null
        };
      }
      return {
        response: {
          summary: `${handle.node.id} pass ${count} done`,
          status: "done",
          messages: [],
          artifacts: [],
          needsUser: false
        },
        tracePath: null
      };
    },
    release: async () => {}
  };
  const workspaceManager = {
    resolve: async () => fixture.config.workspace,
    snapshot: async () => ({}),
    validateChanges: () => [],
    validateArtifacts: async () => [],
    prepareIntegration: async () => ({ sourceHead: "prepared-head", changedFiles: [] }),
    publishIntegration: async (intent) => ({
      branch: "main",
      head: intent.sourceHead,
      changedFiles: intent.changedFiles
    })
  };
  const orchestrator = fixture.orchestrator({ process: runtime, workspaceManager });
  const task = await orchestrator.createWorkflow("Build, review, and repair.", {
    version: 1,
    nodes: [
      {
        id: "build",
        owner: "alpha",
        access: "write",
        workspace: "worktree",
        writeScopes: ["src/**"],
        maxAttempts: 1
      },
      { id: "review", owner: "beta", dependsOn: ["build"], workspaceFrom: "build" },
      { id: "gate", type: "approval", dependsOn: ["review"] },
      { id: "publish", type: "integration", source: "build", dependsOn: ["build", "gate"] }
    ]
  });

  const paused = await orchestrator.runWorkflow(task.id);
  assert.equal(paused.status, "awaiting_input");
  assert.equal(paused.workflow.nodes.build.status, "succeeded");
  assert.equal(paused.workflow.nodes.build.attempts, 1);
  assert.equal(paused.workflow.nodes.review.status, "blocked");

  await fixture.store.retryWorkflowNode(task.id, "build");
  const reopened = await fixture.store.loadTask(task.id);
  assert.equal(reopened.workflow.nodes.build.status, "ready");
  assert.equal(reopened.workflow.nodes.build.attempts, 1);
  assert.equal(reopened.workflow.nodes.review.status, "pending");
  assert.equal(reopened.workflow.nodes.review.attempts, 0);
  assert.equal(reopened.workflow.nodes.gate.status, "pending");
  assert.equal(reopened.workflow.nodes.publish.status, "pending");

  const awaitingGate = await orchestrator.runWorkflow(task.id);
  assert.equal(awaitingGate.status, "awaiting_input");
  assert.equal(awaitingGate.workflow.nodes.build.attempts, 2);
  assert.equal(awaitingGate.workflow.nodes.build.maxAttempts, 1);
  assert.equal(awaitingGate.workflow.nodes.review.attempts, 1);
  assert.equal(awaitingGate.workflow.nodes.gate.status, "awaiting_approval");
  const secondBuildPrompt = prompts.filter((entry) => entry.nodeId === "build")[1].prompt;
  assert.match(secondBuildPrompt, /Fix the empty-input edge case before release\./);

  await fixture.store.approveWorkflowNode(task.id, "gate");
  const completed = await orchestrator.runWorkflow(task.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.workflow.nodes.publish.status, "succeeded");
});

test("refuses retry control while a live lease or descendant attempt is active", async (context) => {
  const fixture = await createFixture(context);
  const orchestrator = fixture.orchestrator({ process: doneRuntime() });
  const task = await orchestrator.createWorkflow("Fence manual control mutations.", {
    version: 1,
    nodes: [
      { id: "first", owner: "alpha", maxAttempts: 2 },
      { id: "second", owner: "beta", dependsOn: ["first"] }
    ]
  });
  await fixture.store.updateTask(task.id, "test.active", (current) => {
    current.workflow.nodes.first.status = "succeeded";
    current.workflow.nodes.first.attempts = 1;
    current.workflow.nodes.second.status = "working";
    current.workflow.nodes.second.attempts = 1;
    current.workflow.nodes.second.attemptToken = "in-flight-token";
    current.workflow.lease = {
      id: "live-lease",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      pid: process.pid
    };
  });

  await assert.rejects(
    () => fixture.store.retryWorkflowNode(task.id, "first"),
    /while workflow nodes are active/
  );
  const preserved = await fixture.store.loadTask(task.id);
  assert.equal(preserved.workflow.nodes.second.status, "working");
  assert.equal(preserved.workflow.nodes.second.attemptToken, "in-flight-token");
  assert.equal(preserved.workflow.lease.id, "live-lease");
});

test("completes a workflow through the Herdr CLI contract and token-bound result drop", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-herdr-workflow-"));
  const workspace = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(workspace);
  await runProcess({ command: "git", args: ["init"], cwd: workspace });
  await runProcess({ command: "git", args: ["config", "user.email", "test@example.com"], cwd: workspace });
  await runProcess({ command: "git", args: ["config", "user.name", "Test"], cwd: workspace });
  await writeFile(path.join(workspace, "README.md"), "fixture\n");
  await runProcess({ command: "git", args: ["add", "."], cwd: workspace });
  await runProcess({ command: "git", args: ["commit", "-m", "initial"], cwd: workspace });
  const wrapper = path.join(root, "fake-herdr");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexport FAKE_HERDR_STATE="${path.join(stateDir, "fake-herdr.json")}"\nexec "${process.execPath}" "${FAKE_HERDR}" "$@"\n`
  );
  await chmod(wrapper, 0o755);
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir,
    execution: {
      runtime: "herdr",
      herdrCommand: wrapper,
      herdrSession: "ao-e2e-test",
      herdrServerMode: "external"
    },
    agents: [{ id: "alpha", adapter: "codex", herdrKind: "codex", role: "Inspect." }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const orchestrator = new WorkflowOrchestrator({ config, store, schema, schemaPath: SCHEMA_PATH });
  const task = await orchestrator.createWorkflow("Inspect without editing.", {
    version: 1,
    runtime: "herdr",
    nodes: [{ id: "inspect", owner: "alpha", access: "read_only" }]
  });

  const completed = await orchestrator.runWorkflow(task.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.workflow.nodes.inspect.status, "succeeded");
  assert.match(completed.workflow.nodes.inspect.result.summary, /Fake Herdr agent completed/);
  assert.equal(completed.workflow.nodes.inspect.binding.kind, "codex");
  assert.equal(await readFile(path.join(workspace, "README.md"), "utf8"), "fixture\n");
  const fakeState = JSON.parse(await readFile(path.join(stateDir, "fake-herdr.json"), "utf8"));
  const promptCall = fakeState.calls.find((call) => (
    call.args[0] === "agent" && call.args[1] === "prompt"
  ));
  assert.match(promptCall.args[3], /other node's result-drop path as private control data/);
});

async function createFixture(context) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-workflow-"));
  context.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(`${workspace}-state`, { recursive: true, force: true });
  });
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir: `${workspace}-state`,
    execution: { runtime: "process", maxConcurrency: 4 },
    agents: [
      { id: "alpha", adapter: "mock", role: "Alpha." },
      { id: "beta", adapter: "mock", role: "Beta." }
    ]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  await store.init();
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const workspaceManager = {
    resolve: async () => workspace,
    snapshot: async () => ({}),
    validateChanges: () => [],
    validateArtifacts: async () => []
  };
  return {
    config,
    store,
    orchestrator: (runtimeOverrides = {}) => new WorkflowOrchestrator({
      config,
      store,
      schema,
      schemaPath: SCHEMA_PATH,
      runtimeOverrides: { workspaceManager, ...runtimeOverrides }
    })
  };
}

function doneRuntime() {
  return {
    ensureAgent: async () => null,
    dispatch: async (entry) => entry,
    wait: async (handle) => ({
      response: {
        summary: `${handle.node.id} done`,
        status: "done",
        messages: [],
        artifacts: [],
        needsUser: false
      },
      tracePath: null
    }),
    release: async () => {}
  };
}

test("publishes the sole writing worktree through an approved ff-only integration", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-integration-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-state`, { recursive: true, force: true });
  });
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { runProcess } = await import("../src/adapters/process.js");
  await runProcess({ command: "git", args: ["init"], cwd: root });
  await runProcess({ command: "git", args: ["config", "user.email", "test@example.com"], cwd: root });
  await runProcess({ command: "git", args: ["config", "user.name", "Test"], cwd: root });
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "seed.js"), "export const seed = true;\n");
  await runProcess({ command: "git", args: ["add", "."], cwd: root });
  await runProcess({ command: "git", args: ["commit", "-m", "initial"], cwd: root });
  const config = normalizeConfig({
    version: 1,
    workspace: root,
    stateDir: `${root}-state`,
    agents: [{ id: "alpha", adapter: "mock", role: "Build." }]
  }, root);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const writingRuntime = {
    ensureAgent: async () => null,
    dispatch: async (entry) => entry,
    wait: async (handle) => {
      await writeFile(path.join(handle.workspace, "src", "answer.js"), "export const answer = 42;\n");
      return {
        response: {
          summary: "Built answer.",
          status: "done",
          messages: [],
          artifacts: ["src/answer.js"],
          needsUser: false
        },
        tracePath: null
      };
    },
    release: async () => {}
  };
  const orchestrator = new WorkflowOrchestrator({
    config,
    store,
    schema,
    schemaPath: SCHEMA_PATH,
    runtimeOverrides: { process: writingRuntime }
  });
  const task = await orchestrator.createWorkflow("Publish an isolated result.", {
    version: 1,
    nodes: [
      {
        id: "build",
        owner: "alpha",
        maxAttempts: 2,
        access: "write",
        workspace: "worktree",
        writeScopes: ["src/**"]
      },
      { id: "gate", type: "approval", dependsOn: ["build"], prompt: "Approve." },
      { id: "publish", type: "integration", source: "build", dependsOn: ["build", "gate"] }
    ]
  });
  const paused = await orchestrator.runWorkflow(task.id);
  assert.equal(paused.status, "awaiting_input");
  await store.approveWorkflowNode(task.id, "gate");
  const completed = await orchestrator.runWorkflow(task.id);

  assert.equal(completed.status, "completed");
  assert.equal(await readFile(path.join(root, "src", "answer.js"), "utf8"), "export const answer = 42;\n");
  assert.match(completed.workflow.nodes.publish.result.summary, /ff-only integration/);
  await assert.rejects(
    () => store.retryWorkflowNode(task.id, "build"),
    /cannot be reopened after integration/
  );
  await assert.rejects(
    () => store.retryWorkflowNode(task.id, "gate"),
    /cannot be retried or reopened/
  );
  await assert.rejects(
    () => store.retryWorkflowNode(task.id, "publish"),
    /only after a failed publication attempt/
  );
});

test("taints a writer worktree when failed read-only QA mutates it and never publishes the mutation", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-readonly-taint-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-state`, { recursive: true, force: true });
  });
  await runProcess({ command: "git", args: ["init"], cwd: root });
  await runProcess({ command: "git", args: ["config", "user.email", "test@example.com"], cwd: root });
  await runProcess({ command: "git", args: ["config", "user.name", "Test"], cwd: root });
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "seed.js"), "export const seed = true;\n");
  await runProcess({ command: "git", args: ["add", "."], cwd: root });
  await runProcess({ command: "git", args: ["commit", "-m", "initial"], cwd: root });
  const config = normalizeConfig({
    version: 1,
    workspace: root,
    stateDir: `${root}-state`,
    agents: [{ id: "alpha", adapter: "mock", role: "Build." }]
  }, root);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  let qaAttempt = 0;
  const runtime = {
    ensureAgent: async () => null,
    dispatch: async (entry) => entry,
    wait: async (handle) => {
      if (handle.node.id === "build") {
        await writeFile(path.join(handle.workspace, "src", "legit.js"), "export const legit = true;\n");
      } else if (handle.node.id === "qa") {
        qaAttempt += 1;
        if (qaAttempt === 1) {
          await writeFile(path.join(handle.workspace, "src", "qa-marker.js"), "unauthorized\n");
          throw new Error("QA crashed after writing");
        }
      }
      return {
        response: {
          summary: `${handle.node.id} done`,
          status: "done",
          messages: [],
          artifacts: [],
          needsUser: false
        },
        tracePath: null
      };
    },
    release: async () => {}
  };
  const orchestrator = new WorkflowOrchestrator({
    config,
    store,
    schema,
    schemaPath: SCHEMA_PATH,
    runtimeOverrides: { process: runtime }
  });
  const task = await orchestrator.createWorkflow("Reject unauthorized QA writes.", {
    version: 1,
    nodes: [
      {
        id: "build",
        owner: "alpha",
        access: "write",
        workspace: "worktree",
        writeScopes: ["src/**"]
      },
      {
        id: "qa",
        type: "command",
        command: "unused",
        dependsOn: ["build"],
        workspaceFrom: "build",
        maxAttempts: 2
      },
      { id: "gate", type: "approval", dependsOn: ["qa"], prompt: "Approve." },
      { id: "publish", type: "integration", source: "build", dependsOn: ["build", "gate"] }
    ]
  });

  const failedQa = await orchestrator.runWorkflow(task.id);
  assert.equal(failedQa.status, "failed");
  assert.match(failedQa.workflow.nodes.qa.error, /workspace boundary violation/);
  assert.equal(failedQa.workflow.workspaceTaints.build.nodeId, "qa");

  await store.retryWorkflowNode(task.id, "qa");
  const awaitingGate = await orchestrator.runWorkflow(task.id);
  assert.equal(awaitingGate.status, "awaiting_input");
  await store.approveWorkflowNode(task.id, "gate");
  const rejectedPublication = await orchestrator.runWorkflow(task.id);
  assert.equal(rejectedPublication.status, "failed");
  assert.match(rejectedPublication.workflow.nodes.publish.error, /tainted by unauthorized workspace changes/);
  await assert.rejects(() => readFile(path.join(root, "src", "legit.js")), /ENOENT/);
  await assert.rejects(() => readFile(path.join(root, "src", "qa-marker.js")), /ENOENT/);
});

test("quarantines a writer worktree when a failed executor cannot be proven stopped", async (context) => {
  const fixture = await createFixture(context);
  const runtime = {
    ensureAgent: async () => null,
    dispatch: async (entry) => entry,
    wait: async (handle) => {
      if (handle.node.id === "review") {
        throw new Error("remote prompt timed out");
      }
      return {
        response: {
          summary: `${handle.node.id} done`,
          status: "done",
          messages: [],
          artifacts: [],
          needsUser: false
        },
        tracePath: null
      };
    },
    interrupt: async () => ({ interrupted: true, settled: false }),
    release: async () => {}
  };
  const orchestrator = fixture.orchestrator({ process: runtime });
  const task = await orchestrator.createWorkflow("Quarantine ambiguous late writes.", {
    version: 1,
    nodes: [
      {
        id: "build",
        owner: "alpha",
        access: "write",
        workspace: "worktree",
        writeScopes: ["src/**"]
      },
      {
        id: "review",
        owner: "beta",
        access: "read_only",
        workspaceFrom: "build",
        dependsOn: ["build"]
      },
      { id: "gate", type: "approval", dependsOn: ["review"], prompt: "Approve." },
      { id: "publish", type: "integration", source: "build", dependsOn: ["build", "gate"] }
    ]
  });

  const failed = await orchestrator.runWorkflow(task.id);

  assert.equal(failed.status, "failed");
  assert.equal(failed.workflow.nodes.review.workspaceViolation.sourceId, "build");
  assert.match(
    failed.workflow.nodes.review.workspaceViolation.reason,
    /could not be proven stopped/
  );
  assert.equal(failed.workflow.workspaceTaints.build.nodeId, "review");
});

test("retries a prepared integration after divergence without duplicating its commit", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-publication-retry-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-state`, { recursive: true, force: true });
  });
  await runProcess({ command: "git", args: ["init"], cwd: root });
  await runProcess({ command: "git", args: ["config", "user.email", "test@example.com"], cwd: root });
  await runProcess({ command: "git", args: ["config", "user.name", "Test"], cwd: root });
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "seed.js"), "export const seed = true;\n");
  await runProcess({ command: "git", args: ["add", "."], cwd: root });
  await runProcess({ command: "git", args: ["commit", "-m", "initial"], cwd: root });
  const baseHead = (await runProcess({ command: "git", args: ["rev-parse", "HEAD"], cwd: root })).stdout.trim();
  const config = normalizeConfig({
    version: 1,
    workspace: root,
    stateDir: `${root}-state`,
    agents: [{ id: "alpha", adapter: "mock", role: "Build." }]
  }, root);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const runtime = {
    ensureAgent: async () => null,
    dispatch: async (entry) => entry,
    wait: async (handle) => {
      await writeFile(path.join(handle.workspace, "src", "answer.js"), "export const answer = 42;\n");
      return {
        response: { summary: "built", status: "done", messages: [], artifacts: [], needsUser: false },
        tracePath: null
      };
    },
    release: async () => {}
  };
  const orchestrator = new WorkflowOrchestrator({
    config,
    store,
    schema,
    schemaPath: SCHEMA_PATH,
    runtimeOverrides: { process: runtime }
  });
  const task = await orchestrator.createWorkflow("Retry publication safely.", {
    version: 1,
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
  const paused = await orchestrator.runWorkflow(task.id);
  assert.equal(paused.status, "awaiting_input");
  await writeFile(path.join(root, "main-only.txt"), "diverged\n");
  await runProcess({ command: "git", args: ["add", "."], cwd: root });
  await runProcess({ command: "git", args: ["commit", "-m", "diverge"], cwd: root });
  await store.approveWorkflowNode(task.id, "gate");
  const diverged = await orchestrator.runWorkflow(task.id);
  assert.equal(diverged.status, "failed");
  assert.equal(diverged.workflow.nodes.publish.attempts, 1);
  assert.ok(diverged.workflow.nodes.publish.publicationIntent?.sourceHead);
  const preparedHead = diverged.workflow.nodes.publish.publicationIntent.sourceHead;

  await runProcess({ command: "git", args: ["reset", "--hard", baseHead], cwd: root });
  await store.retryWorkflowNode(task.id, "publish");
  const reopened = await store.loadTask(task.id);
  assert.equal(reopened.workflow.nodes.publish.attempts, 1);
  const completed = await orchestrator.runWorkflow(task.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.workflow.nodes.publish.attempts, 2);
  assert.equal(completed.workflow.nodes.publish.publication.head, preparedHead);
  assert.equal(await readFile(path.join(root, "src", "answer.js"), "utf8"), "export const answer = 42;\n");
  assert.equal(
    (await runProcess({ command: "git", args: ["rev-list", "--count", `${baseHead}..HEAD`], cwd: root })).stdout.trim(),
    "1"
  );
});

test("publishes deletions without treating deleted paths as artifacts", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-delete-publication-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-state`, { recursive: true, force: true });
  });
  await runProcess({ command: "git", args: ["init"], cwd: root });
  await runProcess({ command: "git", args: ["config", "user.email", "test@example.com"], cwd: root });
  await runProcess({ command: "git", args: ["config", "user.name", "Test"], cwd: root });
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "obsolete.js"), "obsolete\n");
  await runProcess({ command: "git", args: ["add", "."], cwd: root });
  await runProcess({ command: "git", args: ["commit", "-m", "initial"], cwd: root });
  const config = normalizeConfig({
    version: 1,
    workspace: root,
    stateDir: `${root}-state`,
    agents: [{ id: "alpha", adapter: "mock", role: "Delete." }]
  }, root);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const runtime = {
    ensureAgent: async () => null,
    dispatch: async (entry) => entry,
    wait: async (handle) => {
      await rm(path.join(handle.workspace, "src", "obsolete.js"));
      return {
        response: { summary: "removed", status: "done", messages: [], artifacts: [], needsUser: false },
        tracePath: null
      };
    },
    release: async () => {}
  };
  const orchestrator = new WorkflowOrchestrator({
    config,
    store,
    schema,
    schemaPath: SCHEMA_PATH,
    runtimeOverrides: { process: runtime }
  });
  const task = await orchestrator.createWorkflow("Remove obsolete code.", {
    version: 1,
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
  await orchestrator.runWorkflow(task.id);
  await store.approveWorkflowNode(task.id, "gate");
  const completed = await orchestrator.runWorkflow(task.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.workflow.nodes.publish.publication.changedFiles, ["src/obsolete.js"]);
  await assert.rejects(() => readFile(path.join(root, "src", "obsolete.js")), /ENOENT/);
});

test("refuses workflow state stored inside an executor workspace", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-state-boundary-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir: ".agent-office",
    agents: [{ id: "alpha", adapter: "mock", role: "Work." }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const orchestrator = new WorkflowOrchestrator({ config, store, schema, schemaPath: SCHEMA_PATH });
  await assert.rejects(
    () => orchestrator.createWorkflow("Protect the control plane.", {
      version: 1,
      nodes: [{ id: "one", owner: "alpha" }]
    }),
    /control state must live outside/
  );
});

test("rejects a workspace-child stateDir named ..state", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-dotdot-state-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir: path.join(workspace, "..state"),
    agents: [{ id: "alpha", adapter: "mock", role: "Work." }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const orchestrator = new WorkflowOrchestrator({ config, store, schema, schemaPath: SCHEMA_PATH });
  await assert.rejects(
    () => orchestrator.createWorkflow("Dot-dot prefix is still inside the workspace.", {
      version: 1,
      nodes: [{ id: "one", owner: "alpha" }]
    }),
    /control state must live outside/
  );
});

test("cancellation interrupts a hanging Herdr wait instead of waiting for timeout", async (context) => {
  const fixture = await createFixture(context);
  let interruptCalls = 0;
  let waitStarted;
  const waitStartedPromise = new Promise((resolve) => { waitStarted = resolve; });
  const herdr = {
    ensureAgent: async () => ({ agentName: "ao-test", kind: "codex", workspace: fixture.config.workspace }),
    dispatch: async (entry) => entry,
    wait: async (handle) => {
      waitStarted();
      await new Promise((_, reject) => {
        const fail = () => reject(Object.assign(new Error("cancelled"), { details: { cancelled: true } }));
        if (handle.signal?.aborted) return fail();
        handle.signal?.addEventListener("abort", fail, { once: true });
      });
    },
    interrupt: async () => {
      interruptCalls += 1;
      return { interrupted: true, settled: true };
    },
    release: async () => {}
  };
  const orchestrator = fixture.orchestrator({ herdr });
  const task = await orchestrator.createWorkflow("Cancel a Herdr agent.", {
    version: 1,
    runtime: "herdr",
    nodes: [{ id: "inspect", owner: "alpha" }]
  });
  const controller = new AbortController();
  const running = orchestrator.runWorkflow(task.id, { signal: controller.signal });
  await waitStartedPromise;
  controller.abort();
  const finished = await running;
  assert.equal(finished.status, "ready");
  assert.equal(interruptCalls, 1);
});

test("parallel cancellation waits for every node to stop before returning", async (context) => {
  const fixture = await createFixture(context);
  const interrupts = [];
  let releases = 0;
  let startedCount = 0;
  let bothStarted;
  const bothStartedPromise = new Promise((resolve) => { bothStarted = resolve; });
  const runtime = {
    ensureAgent: async () => null,
    dispatch: async (entry) => entry,
    wait: async (handle) => {
      startedCount += 1;
      if (startedCount === 2) bothStarted();
      await new Promise((_, reject) => {
        const fail = () => reject(Object.assign(new Error("cancelled"), { details: { cancelled: true } }));
        if (handle.signal?.aborted) return fail();
        handle.signal?.addEventListener("abort", fail, { once: true });
      });
    },
    interrupt: async (handle) => {
      interrupts.push(handle.node.id);
      return { interrupted: true, settled: true };
    },
    release: async () => {
      releases += 1;
    }
  };
  const orchestrator = fixture.orchestrator({ process: runtime });
  const task = await orchestrator.createWorkflow("Cancel both ready nodes.", {
    version: 1,
    maxConcurrency: 2,
    nodes: [
      { id: "left", owner: "alpha" },
      { id: "right", owner: "beta" }
    ]
  });
  const controller = new AbortController();
  const running = orchestrator.runWorkflow(task.id, { signal: controller.signal });
  await bothStartedPromise;
  controller.abort();
  const finished = await running;
  assert.equal(finished.status, "ready");
  assert.equal(releases, 2);
  assert.deepEqual(interrupts.sort(), ["left", "right"]);
});

test("rejects a stateDir symlink that resolves inside the executor workspace", async (context) => {
  const { symlink } = await import("node:fs/promises");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-state-symlink-"));
  const hidden = path.join(workspace, ".hidden-state");
  const alias = `${workspace}-outside-alias`;
  context.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(alias, { recursive: true, force: true });
  });
  await mkdir(hidden, { recursive: true });
  await symlink(hidden, alias);
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir: alias,
    agents: [{ id: "alpha", adapter: "mock", role: "Work." }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const orchestrator = new WorkflowOrchestrator({ config, store, schema, schemaPath: SCHEMA_PATH });
  await assert.rejects(
    () => orchestrator.createWorkflow("Do not follow a symlink into the workspace.", {
      version: 1,
      nodes: [{ id: "one", owner: "alpha" }]
    }),
    /control state must live outside/
  );
});
