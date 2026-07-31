import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { normalizeConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { loadTurnSchema } from "../src/protocol.js";
import { DEFAULT_SCHEMA_PATH } from "../src/runtime.js";
import { DashboardServer } from "../src/server.js";
import { TaskStore } from "../src/store.js";

async function createTestServer(context, options = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-server-"));
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir: ".state",
    collaboration: { maxRounds: 2, transcriptMessages: 20, turnTimeoutMs: 5000 },
    routing: options.routing,
    agents: options.agents ?? [{
      id: "worker",
      adapter: "mock",
      role: "Complete the dashboard integration task.",
      replies: [{
        summary: "The monitored task completed successfully.",
        status: "done",
        messages: [],
        artifacts: ["dashboard/index.html"],
        needsUser: false
      }]
    }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(DEFAULT_SCHEMA_PATH);
  const orchestrator = new Orchestrator({
    config,
    store,
    schema,
    schemaPath: DEFAULT_SCHEMA_PATH
  });
  const server = new DashboardServer({
    config,
    store,
    orchestrator,
    host: "127.0.0.1",
    port: 0
  });
  await server.start();
  context.after(async () => {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  });
  return { server, config, store };
}

test("serves the dashboard and a bounded operational health snapshot", async (context) => {
  const { server, config } = await createTestServer(context);

  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await page.text(), /Agent Office · Local Control Plane/);

  const healthResponse = await fetch(`${server.url}/api/health`);
  const health = await healthResponse.json();
  assert.equal(health.status, "ok");
  assert.equal(health.workspace, config.workspace);
  assert.equal(health.metrics.totalTasks, 0);
  assert.deepEqual(health.runningTaskIds, []);
  assert.equal(health.agents[0].id, "worker");
  assert.equal(health.capabilities.availableAgents, 1);

  const capabilities = await (await fetch(`${server.url}/api/capabilities`)).json();
  assert.equal(capabilities.agents[0].id, "worker");
  assert.ok(capabilities.agents[0].models.length > 0);
});

test("creates, monitors, runs, and resumes a task through the HTTP API", async (context) => {
  const { server } = await createTestServer(context);
  const createdResponse = await jsonRequest(`${server.url}/api/tasks`, {
    objective: "Exercise the local monitoring API."
  });
  assert.equal(createdResponse.status, 201);
  const task = await createdResponse.json();
  assert.equal(task.routing.strategy, "capability-aware");
  assert.equal(task.routing.assignments[0].agentId, "worker");

  const listed = await (await fetch(`${server.url}/api/tasks`)).json();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, task.id);
  assert.equal(listed[0].status, "ready");

  const runResponse = await jsonRequest(`${server.url}/api/tasks/${task.id}/run`, {
    maxRounds: 1
  });
  assert.equal(runResponse.status, 202);

  const completed = await waitFor(async () => {
    const value = await (await fetch(`${server.url}/api/tasks/${task.id}`)).json();
    return value.status === "completed" ? value : null;
  });
  assert.equal(completed.participants.worker.status, "done");
  assert.match(completed.participants.worker.lastSummary, /completed successfully/);

  const messageResponse = await jsonRequest(`${server.url}/api/tasks/${task.id}/messages`, {
    to: "worker",
    body: "Please handle one follow-up."
  });
  assert.equal(messageResponse.status, 201);
  const reactivated = await (await fetch(`${server.url}/api/tasks/${task.id}`)).json();
  assert.equal(reactivated.status, "ready");
  assert.equal(reactivated.participants.worker.status, "working");

  const events = await (await fetch(`${server.url}/api/events?limit=3`)).json();
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "message.sent");
});

test("streams state notifications over SSE", async (context) => {
  const { server } = await createTestServer(context);
  const controller = new AbortController();
  const response = await fetch(`${server.url}/api/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  const firstChunk = await reader.read();
  const text = new TextDecoder().decode(firstChunk.value);
  assert.match(text, /event: ready/);
  controller.abort();
});

test("rejects cross-origin writes and malformed payloads", async (context) => {
  const { server } = await createTestServer(context);
  const crossOrigin = await fetch(`${server.url}/api/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://untrusted.example"
    },
    body: JSON.stringify({ objective: "This must not be created." })
  });
  assert.equal(crossOrigin.status, 403);

  const invalid = await jsonRequest(`${server.url}/api/tasks`, { objective: " " });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /non-empty string/);

  const unsupported = await fetch(`${server.url}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "no"
  });
  assert.equal(unsupported.status, 415);

  const rebound = await rawRequest(`${server.url}/api/health`, {
    Host: "untrusted.example"
  });
  assert.equal(rebound.statusCode, 403);
  assert.match(JSON.parse(rebound.body).error, /Non-loopback Host/);
});

test("refreshes capability discovery through a same-origin write", async (context) => {
  const { server } = await createTestServer(context);
  const response = await jsonRequest(`${server.url}/api/capabilities/refresh`, {});
  assert.equal(response.status, 200);
  const inventory = await response.json();
  assert.equal(inventory.totals.availableAgents, 1);
  assert.equal(inventory.agents[0].adapter, "mock");
});

test("rejects messages to configured agents that were not assigned to the task", async (context) => {
  const { server } = await createTestServer(context, {
    routing: { maxAgents: 1 },
    agents: [
      { id: "selected", adapter: "mock", role: "Primary implementer." },
      { id: "standby", adapter: "mock", role: "Standby specialist." }
    ]
  });
  const created = await jsonRequest(`${server.url}/api/tasks`, {
    objective: "Implement a focused change."
  });
  const task = await created.json();
  assert.deepEqual(Object.keys(task.participants), ["selected"]);

  const response = await jsonRequest(`${server.url}/api/tasks/${task.id}/messages`, {
    to: "standby",
    body: "This agent was not assigned."
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Unknown message recipient/);
});

function jsonRequest(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
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

function rawRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ statusCode: response.statusCode, body }));
    });
    request.on("error", reject);
    request.end();
  });
}
