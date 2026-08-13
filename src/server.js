import { createServer } from "node:http";
import { readFile, watch } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigError, TaskNotFoundError } from "./errors.js";
import { PACKAGE_ROOT } from "./runtime.js";

const DASHBOARD_ROOT = path.join(PACKAGE_ROOT, "dashboard");
const MAX_BODY_BYTES = 64 * 1024;
const STATIC_FILES = new Map([
  ["/", { path: path.join(DASHBOARD_ROOT, "index.html"), type: "text/html; charset=utf-8" }],
  ["/app.js", { path: path.join(DASHBOARD_ROOT, "app.js"), type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { path: path.join(DASHBOARD_ROOT, "styles.css"), type: "text/css; charset=utf-8" }],
  ["/favicon.svg", { path: path.join(DASHBOARD_ROOT, "favicon.svg"), type: "image/svg+xml" }]
]);

export class DashboardServer {
  constructor({ config, store, orchestrator, host = "127.0.0.1", port = 4177 }) {
    this.config = config;
    this.store = store;
    this.orchestrator = orchestrator;
    this.host = host;
    this.port = port;
    this.startedAt = Date.now();
    this.runningTasks = new Map();
    this.clients = new Set();
    this.watchers = [];
    this.refreshTimer = null;
    this.server = createServer((request, response) => {
      this.#handleRequest(request, response).catch((error) => this.#handleError(error, response));
    });
  }

  async start() {
    await this.store.init();
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : this.port;
    this.#watchState();
    return this.url;
  }

  get url() {
    return `http://${formatHost(this.host)}:${this.port}`;
  }

  async close() {
    clearTimeout(this.refreshTimer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const client of this.clients) client.end();
    this.clients.clear();
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async #handleRequest(request, response) {
    const url = new URL(request.url, this.url);
    this.#setSecurityHeaders(response);
    this.#assertLoopbackHost(request);

    if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
      return this.#serveStatic(STATIC_FILES.get(url.pathname), response);
    }
    if (request.method === "GET" && url.pathname === "/api/stream") {
      return this.#serveEvents(request, response);
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      return this.#json(response, 200, await this.#health());
    }
    if (request.method === "GET" && url.pathname === "/api/capabilities") {
      return this.#json(response, 200, await this.orchestrator.discoverCapabilities());
    }
    if (request.method === "GET" && url.pathname === "/api/tasks") {
      const tasks = await this.store.listTasks();
      return this.#json(response, 200, tasks.map(taskSummary));
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      const limit = url.searchParams.get("limit") ?? 100;
      return this.#json(response, 200, await this.store.readEvents(limit));
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/(task-\d{8}-[a-f0-9]{8})$/);
    if (request.method === "GET" && taskMatch) {
      return this.#json(response, 200, await this.store.loadTask(taskMatch[1]));
    }

    if (request.method === "POST") {
      this.#assertSameOrigin(request);
      if (url.pathname === "/api/capabilities/refresh") {
        const inventory = await this.orchestrator.discoverCapabilities({ refresh: true });
        this.#broadcast("state", { reason: "capabilities.refreshed" });
        return this.#json(response, 200, inventory);
      }
      if (url.pathname === "/api/tasks") {
        const body = await readJsonBody(request);
        const task = await this.orchestrator.createTask(requireString(body.objective, "objective"));
        this.#broadcast("state", { reason: "task.created", taskId: task.id });
        return this.#json(response, 201, task);
      }

      const messageMatch = url.pathname.match(
        /^\/api\/tasks\/(task-\d{8}-[a-f0-9]{8})\/messages$/
      );
      if (messageMatch) {
        const body = await readJsonBody(request);
        const task = await this.store.loadTask(messageMatch[1]);
        const validTargets = new Set(["team", ...Object.keys(task.participants)]);
        if (!validTargets.has(body.to ?? "team")) {
          return this.#json(response, 400, { error: "Unknown message recipient" });
        }
        const message = await this.store.addMessage(messageMatch[1], {
          from: "user",
          to: body.to ?? "team",
          body: requireString(body.body, "body")
        });
        this.#broadcast("state", { reason: "message.sent", taskId: messageMatch[1] });
        return this.#json(response, 201, message);
      }

      const runMatch = url.pathname.match(
        /^\/api\/tasks\/(task-\d{8}-[a-f0-9]{8})\/run$/
      );
      if (runMatch) {
        const body = await readJsonBody(request);
        const taskId = runMatch[1];
        if (this.runningTasks.has(taskId)) {
          return this.#json(response, 409, { error: "Task is already running" });
        }
        const maxRounds = body.maxRounds === undefined
          ? undefined
          : parsePositiveInteger(body.maxRounds, "maxRounds");
        await this.store.loadTask(taskId);
        if (!this.#runInBackground(taskId, maxRounds)) {
          return this.#json(response, 409, { error: "Task is already running" });
        }
        return this.#json(response, 202, { taskId, status: "starting" });
      }

      const nodeActionMatch = url.pathname.match(
        /^\/api\/tasks\/(task-\d{8}-[a-f0-9]{8})\/nodes\/([A-Za-z0-9][A-Za-z0-9_-]*)\/(approve|retry)$/
      );
      if (nodeActionMatch) {
        await readJsonBody(request);
        const [, taskId, nodeId, action] = nodeActionMatch;
        const node = action === "approve"
          ? await this.store.approveWorkflowNode(taskId, nodeId)
          : await this.store.retryWorkflowNode(taskId, nodeId);
        this.#broadcast("state", { reason: `workflow.node_${action}`, taskId, nodeId });
        return this.#json(response, 200, node);
      }
    }

    this.#json(response, 404, { error: "Not found" });
  }

  async #health() {
    const tasks = await this.store.listTasks();
    const agents = this.orchestrator.describeAgents();
    const capabilities = await this.orchestrator.discoverCapabilities();
    const statusCounts = countBy(tasks, (task) => task.status);
    const agentStates = tasks.flatMap((task) => Object.values(task.participants));
    return {
      status: "ok",
      serverTime: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      workspace: this.config.workspace,
      stateDir: this.config.stateDir,
      agents,
      capabilities: {
        detectedAt: capabilities.detectedAt,
        ...capabilities.totals
      },
      runningTaskIds: [...this.runningTasks.keys()],
      metrics: {
        totalTasks: tasks.length,
        activeTasks: tasks.filter((task) => ["ready", "running"].includes(task.status)).length,
        attentionTasks: tasks.filter((task) => ["awaiting_input", "failed"].includes(task.status)).length,
        runningAgents: agentStates.filter((state) => state.status === "working").length,
        totalTurns: tasks.reduce((sum, task) => sum + task.turns.length, 0),
        statusCounts
      }
    };
  }

  #runInBackground(taskId, maxRounds) {
    if (this.runningTasks.has(taskId)) return false;
    const runId = randomUUID();
    const promise = this.orchestrator.runTask(taskId, {
      maxRounds,
      onEvent: (event) => this.#broadcast("orchestrator", { runId, ...event })
    });
    this.runningTasks.set(taskId, { runId, promise, startedAt: new Date().toISOString() });
    this.#broadcast("state", { reason: "run.started", taskId, runId });
    promise
      .then((task) => {
        this.#broadcast("state", { reason: "run.finished", taskId, runId, status: task.status });
      })
      .catch((error) => {
        this.#broadcast("state", { reason: "run.failed", taskId, runId, error: error.message });
      })
      .finally(() => {
        this.runningTasks.delete(taskId);
        this.#broadcast("state", { reason: "run.settled", taskId, runId });
      });
    return true;
  }

  #serveEvents(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    this.clients.add(response);
    request.on("close", () => {
      clearInterval(heartbeat);
      this.clients.delete(response);
    });
  }

  #watchState() {
    for (const target of [this.store.tasksDir, this.store.eventsPath]) {
      try {
        const watcher = watch(target, () => {
          clearTimeout(this.refreshTimer);
          this.refreshTimer = setTimeout(() => {
            this.#broadcast("state", { reason: "filesystem.changed" });
          }, 80);
        });
        watcher.on("error", () => {});
        this.watchers.push(watcher);
      } catch {
        // The events file may not exist until the first task is created.
      }
    }
  }

  #broadcast(eventName, payload) {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify({
      ...payload,
      at: new Date().toISOString()
    })}\n\n`;
    for (const client of this.clients) client.write(frame);
  }

  #serveStatic(file, response) {
    readFile(file.path, (error, contents) => {
      if (error) return this.#handleError(error, response);
      response.writeHead(200, {
        "Content-Type": file.type,
        "Cache-Control": "no-store"
      });
      response.end(contents);
    });
  }

  #assertSameOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return;
    const expected = `http://${request.headers.host}`;
    if (origin !== expected) {
      const error = new Error("Cross-origin write request rejected");
      error.statusCode = 403;
      throw error;
    }
  }

  #assertLoopbackHost(request) {
    const hostHeader = request.headers.host;
    if (!hostHeader) {
      const error = new Error("Missing Host header");
      error.statusCode = 400;
      throw error;
    }
    let hostname;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      const error = new Error("Invalid Host header");
      error.statusCode = 400;
      throw error;
    }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
      const error = new Error("Non-loopback Host header rejected");
      error.statusCode = 403;
      throw error;
    }
  }

  #setSecurityHeaders(response) {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; "
      + "style-src 'self'; script-src 'self'; frame-ancestors 'none'; "
      + "base-uri 'none'; form-action 'self'"
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  }

  #json(response, statusCode, payload) {
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(JSON.stringify(payload));
  }

  #handleError(error, response) {
    if (response.headersSent) {
      response.end();
      return;
    }
    const statusCode = error.statusCode
      ?? (error instanceof TaskNotFoundError
        ? 404
        : error instanceof SyntaxError
          ? 400
          : error instanceof ConfigError
            ? 409
            : 500);
    this.#json(response, statusCode, {
      error: statusCode === 500 ? "Internal server error" : error.message
    });
  }
}

function taskSummary(task) {
  return {
    id: task.id,
    objective: task.objective,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    roundsCompleted: task.roundsCompleted,
    messageCount: task.messages.length,
    turnCount: task.turns.length,
    participants: task.participants,
    routing: task.routing,
    mode: task.mode ?? "rounds",
    workflow: task.workflow ? {
      runtime: task.workflow.runtime,
      maxConcurrency: task.workflow.maxConcurrency,
      order: task.workflow.order,
      nodes: Object.fromEntries(task.workflow.order.map((nodeId) => {
        const node = task.workflow.nodes[nodeId];
        return [nodeId, {
          id: node.id,
          type: node.type,
          owner: node.owner,
          status: node.status,
          dependsOn: node.dependsOn
        }];
      }))
    } : null
  };
}

function countBy(values, selector) {
  const counts = {};
  for (const value of values) {
    const key = selector(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    const error = new Error(`${name} must be an integer from 1 to 100`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

async function readJsonBody(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    const error = new Error("Expected application/json request body");
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text || "{}");
}

function formatHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    const error = new Error(`${name} must be a non-empty string`);
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}
