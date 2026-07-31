import path from "node:path";
import { appendFile, mkdir, readFile, readdir, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { LockTimeoutError, TaskNotFoundError } from "./errors.js";
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
    while (true) {
      try {
        await mkdir(this.lockPath);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const lockStat = await stat(this.lockPath).catch(() => null);
        if (lockStat && Date.now() - lockStat.mtimeMs > this.staleLockMs) {
          await rmdir(this.lockPath).catch(() => {});
          continue;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new LockTimeoutError(`Timed out waiting for state lock: ${this.lockPath}`);
        }
        await sleep(25);
      }
    }

    try {
      return await operation();
    } finally {
      await rmdir(this.lockPath).catch(() => {});
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
