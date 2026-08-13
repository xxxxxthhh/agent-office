import path from "node:path";
import { appendFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { LockTimeoutError, TaskNotFoundError } from "./errors.js";
import { ConfigError } from "./errors.js";
import { normalizeTurnEnvelope } from "./protocol.js";
import { assertNonEmptyString, nowIso, sleep } from "./utils.js";

export class TaskStore {
  constructor(stateDir, options = {}) {
    this.stateDir = path.resolve(stateDir);
    this.tasksDir = path.join(this.stateDir, "tasks");
    this.runsDir = path.join(this.stateDir, "runs");
    this.eventsPath = path.join(this.stateDir, "events.jsonl");
    this.lockPath = path.join(this.stateDir, ".write-lock");
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
  }

  async init() {
    await mkdir(this.tasksDir, { recursive: true });
    await mkdir(this.runsDir, { recursive: true });
  }

  async createTask(objective, agents, metadata = {}) {
    const cleanObjective = assertNonEmptyString(objective, "objective");
    if (!Array.isArray(agents) || agents.length < 1) {
      throw new TypeError("agents must contain at least one agent");
    }

    return this.#withLock(async () => {
      const createdAt = nowIso();
      const id = createTaskId();
      const task = {
        version: 1,
        id,
        objective: cleanObjective,
        status: "ready",
        createdAt,
        updatedAt: createdAt,
        roundsCompleted: 0,
        nextSequence: 2,
        roster: agents.map((agent) => ({
          id: agent.id,
          adapter: agent.adapter,
          role: agent.role
        })),
        routing: metadata.routing ?? null,
        participants: Object.fromEntries(
          agents.map((agent) => [
            agent.id,
            {
              status: "idle",
              turns: 0,
              lastTurnAt: null,
              lastSummary: null,
              artifacts: [],
              assignment: metadata.routing?.assignments.find(
                (assignment) => assignment.agentId === agent.id
              ) ?? null
            }
          ])
        ),
        messages: [
          {
            id: randomUUID(),
            sequence: 1,
            from: "user",
            to: "team",
            body: cleanObjective,
            createdAt
          }
        ],
        turns: []
      };

      await this.#writeTask(task);
      await this.#appendEventUnlocked(id, "task.created", {
        objective: cleanObjective,
        agents: agents.map((agent) => agent.id),
        routing: metadata.routing
          ? {
              strategy: metadata.routing.strategy,
              profile: metadata.routing.profile,
              assignments: metadata.routing.assignments.map((assignment) => ({
                agentId: assignment.agentId,
                model: assignment.model,
                effort: assignment.effort,
                score: assignment.score
              }))
            }
          : null
      });
      return task;
    });
  }

  async createWorkflow(objective, agents, definition) {
    const cleanObjective = assertNonEmptyString(objective, "objective");
    if (!Array.isArray(agents) || agents.length < 1) {
      throw new TypeError("agents must contain at least one agent");
    }

    return this.#withLock(async () => {
      const createdAt = nowIso();
      const id = createTaskId();
      const participants = Object.fromEntries(agents.map((agent) => [
        agent.id,
        {
          status: "idle",
          turns: 0,
          lastTurnAt: null,
          lastSummary: null,
          artifacts: [],
          assignment: null
        }
      ]));
      const nodes = Object.fromEntries(definition.nodes.map((node) => [
        node.id,
        {
          ...node,
          status: "pending",
          attempts: 0,
          attemptToken: null,
          workspacePath: null,
          baselineChanges: {},
          integrationBaseline: null,
          verifiedSnapshot: null,
          binding: null,
          result: null,
          publicationIntent: null,
          publication: null,
          workspaceViolation: null,
          error: null,
          startedAt: null,
          completedAt: null,
          approvedAt: null
        }
      ]));
      const task = {
        version: 2,
        mode: "workflow",
        id,
        objective: cleanObjective,
        status: "ready",
        createdAt,
        updatedAt: createdAt,
        roundsCompleted: 0,
        nextSequence: 2,
        roster: agents.map((agent) => ({ id: agent.id, adapter: agent.adapter, role: agent.role })),
        routing: null,
        participants,
        messages: [{
          id: randomUUID(),
          sequence: 1,
          from: "user",
          to: "team",
          body: cleanObjective,
          createdAt
        }],
        turns: [],
        workflow: {
          version: definition.version,
          runtime: definition.runtime,
          maxConcurrency: definition.maxConcurrency,
          leaseTimeoutMs: definition.leaseTimeoutMs,
          workspaceTaints: {},
          order: definition.nodes.map((node) => node.id),
          nodes
        }
      };
      await this.#writeTask(task);
      await this.#appendEventUnlocked(id, "workflow.created", {
        objective: cleanObjective,
        runtime: definition.runtime,
        nodes: definition.nodes.map((node) => node.id)
      });
      return task;
    });
  }

  async submitWorkflowTurn(taskId, nodeId, attemptToken, response) {
    const normalized = normalizeTurnEnvelope(response);
    return this.updateTask(taskId, "workflow.turn_submitted", (task) => {
      const node = task.workflow?.nodes?.[nodeId];
      if (!node) throw new ConfigError(`Unknown workflow node: ${nodeId}`);
      if (node.status !== "working") {
        throw new ConfigError(`Workflow node "${nodeId}" is not accepting a turn submission`);
      }
      if (!attemptToken || node.attemptToken !== attemptToken) {
        throw new ConfigError(`Stale or invalid attempt token for workflow node "${nodeId}"`);
      }
      if (node.result) throw new ConfigError(`Workflow node "${nodeId}" already has a submitted result`);
      node.result = normalized;
      node.resultSubmittedAt = nowIso();
      return normalized;
    }, { nodeId, status: normalized.status });
  }

  async approveWorkflowNode(taskId, nodeId) {
    return this.updateTask(taskId, "workflow.node_approved", (task) => {
      assertWorkflowControlIdle(task, "approve a node");
      const node = task.workflow?.nodes?.[nodeId];
      if (!node || node.type !== "approval") {
        throw new ConfigError(`Unknown approval node: ${nodeId}`);
      }
      if (node.status !== "awaiting_approval") {
        throw new ConfigError(`Approval node "${nodeId}" is not awaiting approval`);
      }
      const at = nowIso();
      node.status = "succeeded";
      node.approvedAt = at;
      node.completedAt = at;
      task.status = "ready";
      return node;
    }, { nodeId });
  }

  async retryWorkflowNode(taskId, nodeId) {
    return this.updateTask(taskId, "workflow.node_retried", (task) => {
      assertWorkflowControlIdle(task, "retry or reopen a node");
      const node = task.workflow?.nodes?.[nodeId];
      if (!node) throw new ConfigError(`Unknown workflow node: ${nodeId}`);
      if (!["blocked", "failed", "succeeded"].includes(node.status)) {
        throw new ConfigError(`Workflow node "${nodeId}" is not blocked, failed, or eligible for rework`);
      }
      if (node.type === "approval") {
        throw new ConfigError(`Workflow node "${nodeId}" cannot be retried or reopened`);
      }
      if (node.type === "integration" && node.status !== "failed") {
        throw new ConfigError(`Integration node "${nodeId}" can be retried only after a failed publication attempt`);
      }
      const descendants = workflowDescendants(task.workflow.nodes, nodeId);
      const published = [...descendants].some((descendantId) => {
        const descendant = task.workflow.nodes[descendantId];
        return descendant.type === "integration" && descendant.status === "succeeded";
      });
      if (published) {
        throw new ConfigError(`Workflow node "${nodeId}" cannot be reopened after integration`);
      }
      const rework = node.status === "succeeded";
      node.status = "ready";
      if (node.result?.status === "blocked" && node.attempts > 0) {
        node.attempts -= 1;
      }
      node.error = null;
      node.result = null;
      node.attemptToken = null;
      node.resultSubmittedAt = null;
      node.completedAt = null;
      node.changedFiles = [];
      node.tracePath = null;
      for (const descendantId of descendants) {
        const descendant = task.workflow.nodes[descendantId];
        if (!rework && descendant.status !== "skipped") continue;
        descendant.status = "pending";
        if (rework) descendant.attempts = 0;
        descendant.attemptToken = null;
        descendant.error = null;
        descendant.result = null;
        descendant.resultSubmittedAt = null;
        descendant.startedAt = null;
        descendant.completedAt = null;
        descendant.approvedAt = null;
        descendant.changedFiles = [];
        descendant.tracePath = null;
        descendant.resultPath = null;
      }
      task.status = "ready";
      return node;
    }, { nodeId, resetsDescendants: true });
  }

  async loadTask(taskId) {
    validateTaskId(taskId);
    try {
      return JSON.parse(await readFile(this.#taskPath(taskId), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new TaskNotFoundError(`Task not found: ${taskId}`);
      }
      throw error;
    }
  }

  async listTasks() {
    await this.init();
    const entries = (await readdir(this.tasksDir))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
    const tasks = [];
    for (const entry of entries) {
      tasks.push(JSON.parse(await readFile(path.join(this.tasksDir, entry), "utf8")));
    }
    return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readEvents(limit = 100) {
    const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    let contents;
    try {
      contents = await readFile(this.eventsPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return contents
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-boundedLimit)
      .map((line) => JSON.parse(line))
      .reverse();
  }

  async updateTask(taskId, eventType, mutator, eventData = {}) {
    validateTaskId(taskId);
    return this.#withLock(async () => {
      const task = await this.loadTask(taskId);
      const result = await mutator(task);
      task.updatedAt = nowIso();
      await this.#writeTask(task);
      await this.#appendEventUnlocked(taskId, eventType, eventData);
      return result ?? task;
    });
  }

  async addMessage(taskId, { from, to, body }) {
    const cleanFrom = assertNonEmptyString(from, "from");
    const cleanTo = assertNonEmptyString(to, "to");
    const cleanBody = assertNonEmptyString(body, "body");
    return this.updateTask(
      taskId,
      "message.sent",
      (task) => {
        const message = {
          id: randomUUID(),
          sequence: task.nextSequence++,
          from: cleanFrom,
          to: cleanTo,
          body: cleanBody,
          createdAt: nowIso()
        };
        task.messages.push(message);
        if (cleanFrom === "user") {
          const recipients = cleanTo === "team"
            ? Object.values(task.participants)
            : [task.participants[cleanTo]].filter(Boolean);
          let reactivated = false;
          for (const participant of recipients) {
            if (["blocked", "done", "failed"].includes(participant.status)) {
              participant.status = "working";
              reactivated = true;
            }
          }
          if (task.status === "awaiting_input" || reactivated) {
            task.status = "ready";
          }
        }
        return message;
      },
      { from: cleanFrom, to: cleanTo }
    );
  }

  createRunPath(agentId, extension = "json") {
    const safeAgentId = agentId.replaceAll(/[^A-Za-z0-9_-]/g, "_");
    return path.join(this.runsDir, `${Date.now()}-${safeAgentId}-${randomBytes(3).toString("hex")}.${extension}`);
  }

  async #writeTask(task) {
    const target = this.#taskPath(task.id);
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  async #appendEventUnlocked(taskId, type, data) {
    const event = {
      id: randomUUID(),
      taskId,
      type,
      at: nowIso(),
      data
    };
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  #taskPath(taskId) {
    return path.join(this.tasksDir, `${taskId}.json`);
  }

  async #withLock(operation) {
    await this.init();
    const startedAt = Date.now();
    const ownerToken = randomUUID();
    const ownerPath = path.join(this.lockPath, "owner");
    while (true) {
      try {
        await mkdir(this.lockPath);
        await writeFile(ownerPath, `${ownerToken}\n`, { flag: "wx" });
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const lockStat = await stat(this.lockPath).catch(() => null);
        if (lockStat && Date.now() - lockStat.mtimeMs > this.staleLockMs) {
          const abandoned = `${this.lockPath}.abandoned-${ownerToken}`;
          try {
            await rename(this.lockPath, abandoned);
            await rm(abandoned, { recursive: true, force: true });
            continue;
          } catch (renameError) {
            if (renameError.code !== "ENOENT") await sleep(10);
          }
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new LockTimeoutError(`Timed out waiting for state lock: ${this.lockPath}`);
        }
        await sleep(25);
      }
    }

    const heartbeatMs = Math.max(2, Math.min(1_000, Math.floor(this.staleLockMs / 3)));
    const heartbeat = setInterval(() => {
      const now = new Date();
      utimes(this.lockPath, now, now).catch(() => {});
    }, heartbeatMs);
    heartbeat.unref();
    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      const owner = await readFile(ownerPath, "utf8").catch(() => null);
      if (owner?.trim() === ownerToken) {
        await rm(ownerPath, { force: true }).catch(() => {});
        await rmdir(this.lockPath).catch(() => {});
      }
    }
  }
}

function createTaskId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `task-${date}-${randomBytes(4).toString("hex")}`;
}

function validateTaskId(taskId) {
  if (!/^task-\d{8}-[a-f0-9]{8}$/.test(taskId)) {
    throw new TaskNotFoundError(`Invalid task id: ${taskId}`);
  }
}

function workflowDescendants(nodes, rootId) {
  const descendants = new Set();
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift();
    for (const node of Object.values(nodes)) {
      if (!node.dependsOn?.includes(current) || descendants.has(node.id)) continue;
      descendants.add(node.id);
      queue.push(node.id);
    }
  }
  return descendants;
}

function assertWorkflowControlIdle(task, action) {
  if (!task.workflow?.nodes) throw new ConfigError(`Task ${task.id} is not a workflow task`);
  const active = Object.values(task.workflow.nodes)
    .filter((node) => ["dispatched", "working"].includes(node.status))
    .map((node) => node.id);
  if (active.length) {
    throw new ConfigError(`Cannot ${action} while workflow nodes are active: ${active.join(", ")}`);
  }
  const lease = task.workflow.lease;
  if (!lease) return;
  const timeoutMs = task.workflow.leaseTimeoutMs ?? 60_000;
  const age = Date.now() - Date.parse(lease.heartbeatAt);
  if (!Number.isFinite(age) || age <= timeoutMs) {
    throw new ConfigError(`Cannot ${action} while workflow lease ${lease.id} is active`);
  }
}
