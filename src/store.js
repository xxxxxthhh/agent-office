import os from "node:os";
import path from "node:path";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile
} from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { LockTimeoutError, RunLeaseError, TaskNotFoundError } from "./errors.js";
import { assertNonEmptyString, nowIso, sleep } from "./utils.js";

export class TaskStore {
  constructor(stateDir, options = {}) {
    this.stateDir = path.resolve(stateDir);
    this.tasksDir = path.join(this.stateDir, "tasks");
    this.runsDir = path.join(this.stateDir, "runs");
    this.leasesDir = path.join(this.stateDir, "leases");
    this.eventsPath = path.join(this.stateDir, "events.jsonl");
    this.lockPath = path.join(this.stateDir, ".write-lock");
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    this.leaseHeartbeatMs = options.leaseHeartbeatMs ?? 5_000;
    this.staleLeaseMs = options.staleLeaseMs ?? 30_000;
    this.hostname = options.hostname ?? os.hostname();
    this.maxEventFileBytes = options.maxEventFileBytes ?? 5 * 1024 * 1024;
    this.maxRunFiles = options.maxRunFiles ?? 500;
    // Task snapshots are only re-parsed when their file actually changed, so a
    // dashboard polling health every few seconds does not re-read every task.
    this.taskCache = new Map();
  }

  async init() {
    await mkdir(this.tasksDir, { recursive: true });
    await mkdir(this.runsDir, { recursive: true });
    await mkdir(this.leasesDir, { recursive: true });
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

  async listTasks({ includeArchived = false } = {}) {
    await this.init();
    const entries = (await readdir(this.tasksDir))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
    const seen = new Set();
    const tasks = [];
    for (const entry of entries) {
      const filePath = path.join(this.tasksDir, entry);
      seen.add(filePath);
      const task = await this.#readTaskCached(filePath);
      if (!task) continue;
      if (!includeArchived && task.archived) continue;
      tasks.push(task);
    }
    for (const cached of this.taskCache.keys()) {
      if (!seen.has(cached)) this.taskCache.delete(cached);
    }
    return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async #readTaskCached(filePath) {
    const info = await stat(filePath).catch(() => null);
    if (!info) return null;
    const cached = this.taskCache.get(filePath);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.task;
    }
    let task;
    try {
      task = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      // A snapshot being replaced can be read mid-rename; the next poll retries.
      return cached?.task ?? null;
    }
    this.taskCache.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, task });
    return task;
  }

  async readEvents(limit = 100) {
    const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const lines = await this.#readEventLines(this.eventsPath);
    // Reach into the rotated generation only when the live file is too short.
    if (lines.length < boundedLimit) {
      const previous = await this.#readEventLines(`${this.eventsPath}.1`);
      lines.unshift(...previous.slice(-(boundedLimit - lines.length)));
    }
    return lines
      .slice(-boundedLimit)
      .map((line) => safeParseJson(line))
      .filter(Boolean)
      .reverse();
  }

  async #readEventLines(filePath) {
    try {
      return (await readFile(filePath, "utf8")).trim().split("\n").filter(Boolean);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
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

  // A run lease makes "this task is being executed right now" a fact on disk
  // rather than in one process's memory, so a second `agent-office run` fails
  // fast instead of interleaving turns, and a crashed run is recognisable.
  // Two leases are taken together: one for the task, and one for the workspace.
  // The task lease alone would still let two *different* tasks sharing a
  // workspace run at the same time and overwrite each other's files, which the
  // serial-execution guarantee forbids.
  async acquireRunLease(taskId, runId, { workspace } = {}) {
    validateTaskId(taskId);
    const names = [taskId];
    if (workspace) names.push(workspaceLeaseName(workspace));

    return this.#withLock(async () => {
      for (const name of names) {
        const existing = await this.#readLeaseUnlocked(name);
        if (!existing?.alive) continue;
        throw new RunLeaseError(
          existing.kind === "workspace" && existing.taskId !== taskId
            ? `Workspace ${existing.workspace} is already in use by task ${existing.taskId} `
              + `(pid ${existing.pid} on ${existing.host}, started ${existing.startedAt}). `
              + "Agents run one at a time per workspace; stop that run first."
            : `Task ${taskId} is already being run by pid ${existing.pid} on ${existing.host} `
              + `(started ${existing.startedAt}). Stop that run before starting another.`,
          existing
        );
      }

      const startedAt = nowIso();
      const written = [];
      try {
        for (const name of names) {
          // Unconditional: a lease file that failed to parse also has no live
          // holder, and leaving it would make the exclusive create below fail
          // with a raw EEXIST instead of the RunLeaseError above.
          await rm(this.#leasePath(name), { force: true });
          const lease = {
            taskId,
            runId,
            kind: name === taskId ? "task" : "workspace",
            workspace: workspace ? path.resolve(workspace) : null,
            pid: process.pid,
            host: this.hostname,
            startedAt,
            heartbeatAt: startedAt
          };
          await writeFile(this.#leasePath(name), JSON.stringify(lease), { flag: "wx" });
          written.push({ name, lease });
        }
      } catch (error) {
        // Never leave a half-acquired pair behind.
        for (const { name } of written) await rm(this.#leasePath(name), { force: true });
        throw error;
      }

      const timer = setInterval(() => {
        for (const { name, lease } of written) {
          this.#writeLeaseAtomic(name, { ...lease, heartbeatAt: nowIso() }).catch(() => {});
        }
      }, this.leaseHeartbeatMs);
      timer.unref();

      return {
        ...written[0].lease,
        release: async () => {
          clearInterval(timer);
          for (const { name } of written) {
            const current = await this.#readLeaseUnlocked(name);
            // Never delete a lease that a later run already took over.
            if (!current || current.runId === runId) {
              await rm(this.#leasePath(name), { force: true });
            }
          }
        }
      };
    });
  }

  async readWorkspaceLease(workspace) {
    return this.#readLeaseUnlocked(workspaceLeaseName(workspace));
  }

  async readLease(taskId) {
    validateTaskId(taskId);
    return this.#readLeaseUnlocked(taskId);
  }

  async listLeases() {
    await this.init();
    const names = await readdir(this.leasesDir).catch(() => []);
    const leases = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const lease = await this.#readLeaseUnlocked(name.slice(0, -".json".length));
      // Workspace leases mirror a task lease; surfacing both would double-count.
      if (lease && lease.kind !== "workspace") leases.push(lease);
    }
    return leases;
  }

  async #readLeaseUnlocked(name) {
    let lease;
    try {
      lease = JSON.parse(await readFile(this.#leasePath(name), "utf8"));
    } catch {
      return null;
    }
    const age = Date.now() - new Date(lease.heartbeatAt).getTime();
    const fresh = Number.isFinite(age) && age < this.staleLeaseMs;
    // A same-host lease can be checked directly; a lease from another host can
    // only be judged by how recently it was renewed.
    const sameHost = lease.host === this.hostname;
    const alive = sameHost ? fresh && isProcessAlive(lease.pid) : fresh;
    return { ...lease, alive, stale: !alive };
  }

  // The heartbeat rewrites the lease every few seconds while other processes
  // read it, so it uses the same temp-file-and-rename swap as task snapshots. A
  // plain write would let a reader observe a truncated file.
  async #writeLeaseAtomic(name, lease) {
    const target = this.#leasePath(name);
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(lease), "utf8");
    await rename(temporary, target);
  }

  #leasePath(name) {
    return path.join(this.leasesDir, `${name}.json`);
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
    await this.#rotateEventsUnlocked();
  }

  // Keeps one previous generation, so the audit trail survives a rotation but
  // total event-log size stays bounded by roughly 2x the limit.
  async #rotateEventsUnlocked() {
    const info = await stat(this.eventsPath).catch(() => null);
    if (!info || info.size <= this.maxEventFileBytes) return;
    await rename(this.eventsPath, `${this.eventsPath}.1`).catch(() => {});
  }

  // Raw provider output is the largest thing written per turn and nothing else
  // removes it. Oldest files go first once the cap is exceeded.
  async pruneRunFiles() {
    await this.init();
    const names = await readdir(this.runsDir).catch(() => []);
    if (names.length <= this.maxRunFiles) return 0;
    const entries = [];
    for (const name of names) {
      const filePath = path.join(this.runsDir, name);
      const info = await stat(filePath).catch(() => null);
      if (info?.isFile()) entries.push({ filePath, mtimeMs: info.mtimeMs });
    }
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
    const excess = entries.slice(0, Math.max(0, entries.length - this.maxRunFiles));
    for (const entry of excess) await rm(entry.filePath, { force: true });
    return excess.length;
  }

  async setArchived(taskId, archived) {
    return this.updateTask(
      taskId,
      archived ? "task.archived" : "task.unarchived",
      (task) => {
        task.archived = archived === true;
        return task;
      },
      { archived: archived === true }
    );
  }

  async deleteTask(taskId) {
    validateTaskId(taskId);
    return this.#withLock(async () => {
      const lease = await this.#readLeaseUnlocked(taskId);
      if (lease?.alive) {
        throw new RunLeaseError(
          `Task ${taskId} is running on pid ${lease.pid} (${lease.host}) and cannot be deleted. `
          + "Stop the run first.",
          lease
        );
      }
      const target = this.#taskPath(taskId);
      const info = await stat(target).catch(() => null);
      if (!info) throw new TaskNotFoundError(`Task not found: ${taskId}`);
      await rm(target, { force: true });
      await rm(this.#leasePath(taskId), { force: true });
      this.taskCache.delete(target);
      // The event log is append-only, so the deletion itself is recorded there.
      await this.#appendEventUnlocked(taskId, "task.deleted", {});
      return { id: taskId, deleted: true };
    });
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

function safeParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    // A torn final line from a crashed append must not break the whole read.
    return null;
  }
}

// A stable, filesystem-safe name for the workspace lease. Keyed by the resolved
// path so two configs pointing at the same directory collide as intended.
function workspaceLeaseName(workspace) {
  const resolved = path.resolve(workspace);
  return `workspace-${createHash("sha1").update(resolved).digest("hex").slice(0, 16)}`;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error.code === "EPERM";
  }
}

function validateTaskId(taskId) {
  if (!/^task-\d{8}-[a-f0-9]{8}$/.test(taskId)) {
    throw new TaskNotFoundError(`Invalid task id: ${taskId}`);
  }
}
