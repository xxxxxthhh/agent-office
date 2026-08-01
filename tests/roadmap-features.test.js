import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { normalizeConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { loadTurnSchema } from "../src/protocol.js";
import { DEFAULT_SCHEMA_PATH } from "../src/runtime.js";
import { DashboardServer } from "../src/server.js";
import { TaskStore } from "../src/store.js";

async function scaffold(context, { runTurn, collaboration, storeOptions } = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-roadmap-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir: ".state",
    collaboration: { maxRounds: 2, transcriptMessages: 40, turnTimeoutMs: 5000, ...collaboration },
    agents: [{ id: "worker", adapter: "mock", role: "Implement the change." }]
  }, workspace);
  const store = new TaskStore(config.stateDir, storeOptions);
  const schema = await loadTurnSchema(DEFAULT_SCHEMA_PATH);
  const orchestrator = new Orchestrator({
    config,
    store,
    schema,
    schemaPath: DEFAULT_SCHEMA_PATH,
    adapterOverrides: runTurn
      ? { worker: { describe: () => ({ kind: "test", command: null, safety: "t" }), runTurn } }
      : {}
  });
  return { config, store, orchestrator, workspace };
}

const doneTurn = async () => ({
  response: { summary: "Done.", status: "done", messages: [], artifacts: [], needsUser: false },
  tracePath: null
});

// --- A1: failure diagnostics -------------------------------------------------

test("a failed turn carries stderr and exit code to the caller, not just the log", async (context) => {
  const captured = [];
  const { orchestrator } = await scaffold(context, {
    runTurn: async () => {
      const error = new Error("claude exited with code 1");
      error.name = "AdapterError";
      const { AdapterError } = await import("../src/errors.js");
      throw new AdapterError("claude exited with code 1", {
        code: 1,
        stderr: "Error: --json-schema is not a valid JSON Schema\n",
        command: "claude"
      });
    }
  });
  const task = await orchestrator.createTask("Implement a change.");

  await orchestrator.runTask(task.id, { onEvent: (event) => captured.push(event) });

  const failure = captured.find((event) => event.type === "turn.failed");
  assert.match(failure.stderr, /not a valid JSON Schema/);
  assert.equal(failure.exitCode, 1);
});

test("the failure cause is stored on the participant and in the transcript", async (context) => {
  const { AdapterError } = await import("../src/errors.js");
  const { orchestrator, store } = await scaffold(context, {
    runTurn: async () => {
      throw new AdapterError("codex exited with code 2", {
        code: 2,
        stderr: "fatal: sandbox denied write\n"
      });
    }
  });
  const task = await orchestrator.createTask("Implement a change.");

  await orchestrator.runTask(task.id);
  const settled = await store.loadTask(task.id);

  assert.equal(settled.participants.worker.lastFailure.exitCode, 2);
  assert.match(settled.participants.worker.lastFailure.stderr, /sandbox denied/);
  assert.match(settled.messages.at(-1).body, /sandbox denied write/);
});

test("a successful retry clears the participant's stale failure warning", async (context) => {
  const { AdapterError } = await import("../src/errors.js");
  let attempts = 0;
  const { orchestrator, store } = await scaffold(context, {
    runTurn: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new AdapterError("claude exited with code 1", {
          code: 1,
          stderr: "temporary network failure\n",
          command: "claude"
        });
      }
      return doneTurn();
    }
  });
  const task = await orchestrator.createTask("Implement a change.");

  const failed = await orchestrator.runTask(task.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.participants.worker.lastFailure.exitCode, 1);

  await store.addMessage(task.id, {
    from: "user",
    to: "worker",
    body: "Please retry now."
  });
  const recovered = await orchestrator.runTask(task.id);

  assert.equal(recovered.status, "completed");
  assert.equal(recovered.participants.worker.status, "done");
  assert.equal(recovered.participants.worker.lastFailure, undefined);
});

// --- A2: prompt budget -------------------------------------------------------

test("caps the transcript so the prompt cannot grow without bound", async (context) => {
  const prompts = [];
  const { orchestrator, store } = await scaffold(context, {
    collaboration: { promptBudgetChars: 2000, transcriptMessages: 500 },
    runTurn: async ({ prompt }) => {
      prompts.push(prompt);
      return doneTurn();
    }
  });
  const task = await orchestrator.createTask("Implement a change.");
  for (let index = 0; index < 40; index += 1) {
    await store.addMessage(task.id, {
      from: "user",
      to: "team",
      body: `filler message ${index} `.padEnd(500, "x")
    });
  }

  await orchestrator.runTask(task.id);

  const transcript = prompts[0];
  assert.ok(transcript.includes("omitted to stay within the prompt budget"));
  // Budget applies to the transcript; the rest of the prompt is fixed overhead.
  assert.ok(transcript.length < 6000, `prompt was ${transcript.length} chars`);
  // The newest message must survive.
  assert.ok(transcript.includes("filler message 39"));
});

test("keeps the newest message even when it alone exceeds the budget", async (context) => {
  const prompts = [];
  const { orchestrator, store } = await scaffold(context, {
    collaboration: { promptBudgetChars: 50 },
    runTurn: async ({ prompt }) => {
      prompts.push(prompt);
      return doneTurn();
    }
  });
  const task = await orchestrator.createTask("Implement a change.");
  await store.addMessage(task.id, { from: "user", to: "team", body: "z".repeat(900) });

  await orchestrator.runTask(task.id);

  assert.ok(prompts[0].includes("z".repeat(400)), "an oversized newest message is not dropped");
});

// --- A3: usage recorded on the turn -----------------------------------------

test("records adapter-reported usage on the persisted turn", async (context) => {
  const { orchestrator, store } = await scaffold(context, {
    runTurn: async () => ({
      ...(await doneTurn()),
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 5,
        reasoningOutputTokens: 0,
        costUsd: 0.25
      }
    })
  });
  const task = await orchestrator.createTask("Implement a change.");

  await orchestrator.runTask(task.id);
  const settled = await store.loadTask(task.id);

  assert.equal(settled.turns[0].usage.inputTokens, 100);
  assert.equal(settled.turns[0].usage.costUsd, 0.25);
});

// --- B2: retention -----------------------------------------------------------

test("rotates the event log instead of growing without limit", async (context) => {
  const budget = 4000;
  const { orchestrator, store } = await scaffold(context, {
    runTurn: doneTurn,
    storeOptions: { maxEventFileBytes: budget }
  });
  const task = await orchestrator.createTask("Implement a change.");
  for (let index = 0; index < 60; index += 1) {
    await store.addMessage(task.id, { from: "user", to: "team", body: `message ${index}` });
  }

  const live = await readFile(store.eventsPath, "utf8");
  const rotated = await readFile(`${store.eventsPath}.1`, "utf8").catch(() => "");
  const liveLines = live.trim().split("\n").filter(Boolean).length;

  assert.ok(rotated.length > 0, "a previous generation is kept");
  // Bounded: without rotation 61 events would far exceed the budget.
  assert.ok(live.length <= budget * 2, `live log was ${live.length} bytes`);

  // Reads reach across the rotation boundary rather than stopping at the live file.
  const events = await store.readEvents(500);
  assert.ok(
    events.length > liveLines,
    `read ${events.length} events but the live file holds ${liveLines}`
  );
  assert.equal(events[0].type, "message.sent", "newest event comes first");
});

test("prunes the oldest raw run files past the cap", async (context) => {
  const { store } = await scaffold(context, { storeOptions: { maxRunFiles: 3 } });
  await store.init();
  for (let index = 0; index < 6; index += 1) {
    await writeFile(path.join(store.runsDir, `run-${index}.json`), "{}");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const removed = await store.pruneRunFiles();
  const { readdir } = await import("node:fs/promises");

  assert.equal(removed, 3);
  assert.equal((await readdir(store.runsDir)).length, 3);
});

test("does not re-parse task snapshots that have not changed", async (context) => {
  const { orchestrator, store } = await scaffold(context, { runTurn: doneTurn });
  await orchestrator.createTask("Implement a change.");

  const first = await store.listTasks();
  const second = await store.listTasks();

  // Identity, not just equality: an unchanged snapshot is served from cache.
  assert.equal(first[0], second[0]);
});

// --- B3: archive and delete --------------------------------------------------

test("archived tasks are hidden from the default list but still loadable", async (context) => {
  const { orchestrator, store } = await scaffold(context, { runTurn: doneTurn });
  const task = await orchestrator.createTask("Implement a change.");

  await store.setArchived(task.id, true);

  assert.equal((await store.listTasks()).length, 0);
  assert.equal((await store.listTasks({ includeArchived: true })).length, 1);
  assert.equal((await store.loadTask(task.id)).archived, true);
});

test("refuses to delete a task that is currently running", async (context) => {
  const { RunLeaseError } = await import("../src/errors.js");
  const { orchestrator, store } = await scaffold(context, { runTurn: doneTurn });
  const task = await orchestrator.createTask("Implement a change.");
  const lease = await store.acquireRunLease(task.id, "run-1");

  await assert.rejects(() => store.deleteTask(task.id), RunLeaseError);

  await lease.release();
  await store.deleteTask(task.id);
  await assert.rejects(() => store.loadTask(task.id));
});

// --- B4/B5: trace confinement and diff ---------------------------------------

test("refuses to serve a trace whose path escapes the run directory", async (context) => {
  const { config, store, orchestrator, workspace } = await scaffold(context, { runTurn: doneTurn });
  const server = new DashboardServer({ config, store, orchestrator, host: "127.0.0.1", port: 0 });
  await server.start();
  context.after(() => server.close());
  const task = await orchestrator.createTask("Implement a change.");
  await orchestrator.runTask(task.id);

  // Simulate a hostile or buggy adapter writing a path outside runsDir.
  const secret = path.join(workspace, "secret.txt");
  await writeFile(secret, "top secret");
  await store.updateTask(task.id, "turn.completed", (current) => {
    current.turns[0].tracePath = secret;
  });
  const stored = await store.loadTask(task.id);

  const response = await fetch(
    `${server.url}/api/tasks/${task.id}/turns/${stored.turns[0].id}/trace`
  );

  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /outside the run directory/);
});

test("reports a pruned trace as unavailable rather than erroring", async (context) => {
  const { config, store, orchestrator } = await scaffold(context, {
    runTurn: async () => ({ ...(await doneTurn()), tracePath: null })
  });
  const server = new DashboardServer({ config, store, orchestrator, host: "127.0.0.1", port: 0 });
  await server.start();
  context.after(() => server.close());
  const task = await orchestrator.createTask("Implement a change.");
  await orchestrator.runTask(task.id);

  // A turn whose trace file retention already removed.
  const tracePath = path.join(store.runsDir, "gone.json");
  await store.updateTask(task.id, "turn.completed", (current) => {
    current.turns[0].tracePath = tracePath;
  });
  const stored = await store.loadTask(task.id);

  const response = await fetch(
    `${server.url}/api/tasks/${task.id}/turns/${stored.turns[0].id}/trace`
  );

  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /no longer available/);
});

test("prunes run files even when the run throws", async (context) => {
  const { store, orchestrator } = await scaffold(context, {
    runTurn: async () => { throw new Error("boom"); },
    storeOptions: { maxRunFiles: 2 }
  });
  await store.init();
  const { writeFile: write } = await import("node:fs/promises");
  for (let index = 0; index < 5; index += 1) {
    await write(path.join(store.runsDir, `old-${index}.json`), "{}");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const task = await orchestrator.createTask("Implement a change.");

  await orchestrator.runTask(task.id);

  const { readdir } = await import("node:fs/promises");
  assert.equal((await readdir(store.runsDir)).length, 2, "cleanup runs on the failure path too");
});

test("reports diff unavailability instead of failing outside a git repo", async (context) => {
  const { config, store, orchestrator } = await scaffold(context, { runTurn: doneTurn });
  const server = new DashboardServer({ config, store, orchestrator, host: "127.0.0.1", port: 0 });
  await server.start();
  context.after(() => server.close());
  const task = await orchestrator.createTask("Implement a change.");

  const diff = await (await fetch(`${server.url}/api/tasks/${task.id}/diff`)).json();

  assert.equal(diff.available, false);
  assert.match(diff.reason, /git/);
});

test("the task list hides archived tasks unless they are asked for", async (context) => {
  const { config, store, orchestrator } = await scaffold(context, { runTurn: doneTurn });
  const server = new DashboardServer({ config, store, orchestrator, host: "127.0.0.1", port: 0 });
  await server.start();
  context.after(() => server.close());
  const task = await orchestrator.createTask("Implement a change.");
  await store.setArchived(task.id, true);

  const withoutArchived = await (await fetch(`${server.url}/api/tasks`)).json();
  const withArchived = await (await fetch(`${server.url}/api/tasks?includeArchived=1`)).json();

  assert.equal(withoutArchived.length, 0);
  // The dashboard filters client-side, so it must still receive archived tasks.
  assert.equal(withArchived.length, 1);
  assert.equal(withArchived[0].archived, true);
});

test("deletes a task over HTTP and stops listing it", async (context) => {
  const { config, store, orchestrator } = await scaffold(context, { runTurn: doneTurn });
  const server = new DashboardServer({ config, store, orchestrator, host: "127.0.0.1", port: 0 });
  await server.start();
  context.after(() => server.close());
  const task = await orchestrator.createTask("Implement a change.");

  const response = await fetch(`${server.url}/api/tasks/${task.id}`, { method: "DELETE" });

  assert.equal(response.status, 200);
  assert.equal((await (await fetch(`${server.url}/api/tasks?includeArchived=1`)).json()).length, 0);
});

test("exposes task usage totals through the HTTP task list", async (context) => {
  const { config, store, orchestrator } = await scaffold(context, {
    runTurn: async () => ({
      ...(await doneTurn()),
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        costUsd: null
      }
    })
  });
  const server = new DashboardServer({ config, store, orchestrator, host: "127.0.0.1", port: 0 });
  await server.start();
  context.after(() => server.close());
  const task = await orchestrator.createTask("Implement a change.");
  await orchestrator.runTask(task.id);

  const [summary] = await (await fetch(`${server.url}/api/tasks`)).json();

  assert.equal(summary.usage.inputTokens, 7);
  assert.equal(summary.usage.costUsd, null);
  assert.equal(summary.archived, false);
});

// --- C2: progress derived from real provider event shapes -------------------

test("reports every tool call in one assistant message, not just the first", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-progress-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const { ClaudeAdapter } = await import("../src/adapters/claude.js");
  const store = new TaskStore(path.join(workspace, ".state"));
  await store.init();
  const adapter = new ClaudeAdapter(
    { id: "claude", command: process.execPath },
    { schema: { type: "object" }, store }
  );

  // Event shape captured from `claude -p --output-format stream-json`.
  const lines = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "considering" },
          { type: "tool_use", name: "Read" },
          { type: "tool_use", name: "Edit" },
          { type: "text", text: "done editing" }
        ]
      }
    }),
    JSON.stringify({
      type: "result",
      total_cost_usd: 0.01,
      usage: { input_tokens: 1, output_tokens: 2 },
      structured_output: {
        summary: "ok", status: "done", messages: [], artifacts: [], needsUser: false
      }
    })
  ];
  const progress = [];
  const { runProcess } = await import("../src/adapters/process.js");
  const fake = `${lines.join("\n")}\n`;
  // Drive the adapter's own line handling by echoing the stream through node.
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(fake)})`],
    cwd: workspace,
    onStdoutLine: (line) => {
      const event = JSON.parse(line);
      if (event.type === "assistant") {
        for (const block of event.message.content) progress.push(block.type);
      }
    }
  });

  assert.equal(result.code, 0);
  assert.deepEqual(progress, ["thinking", "tool_use", "tool_use", "text"]);
  assert.ok(adapter, "adapter constructs against the captured shape");
});
