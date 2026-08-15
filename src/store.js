import os from "node:os";
import path from "node:path";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile
} from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ConfigError, LockTimeoutError, RunLeaseError, TaskNotFoundError } from "./errors.js";
import { normalizeTurnEnvelope } from "./protocol.js";
import { assertNonEmptyString, nowIso, sleep } from "./utils.js";

// Lives at the workspace root so every config pointing at this workspace sees
// the same lock, whatever stateDir each of them uses.
export const WORKSPACE_LOCK_NAME = ".agent-office.lock";
export const WORKSPACE_FENCE_NAME = ".agent-office.fence";

export function isWorkspaceLockName(name) {
  return name === WORKSPACE_LOCK_NAME || name.startsWith(`${WORKSPACE_LOCK_NAME}.`)
    || name === WORKSPACE_FENCE_NAME || name.startsWith(`${WORKSPACE_FENCE_NAME}.`);
}

export class TaskStore {
  constructor(stateDir, options = {}) {
    this.stateDir = path.resolve(stateDir);
    this.tasksDir = path.join(this.stateDir, "tasks");
    this.runsDir = path.join(this.stateDir, "runs");
    this.leasesDir = path.join(this.stateDir, "leases");
    this.baselinesDir = path.join(this.stateDir, "baselines");
    this.containmentsDir = path.join(this.stateDir, "containments");
    this.eventsPath = path.join(this.stateDir, "events.jsonl");
    this.lockPath = path.join(this.stateDir, ".write-lock");
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    this.leaseHeartbeatMs = options.leaseHeartbeatMs ?? 5_000;
    this.staleLeaseMs = options.staleLeaseMs ?? 30_000;
    this.containmentRetryMs = options.containmentRetryMs ?? 1000;
    this.hostname = options.hostname ?? os.hostname();
    this.maxEventFileBytes = options.maxEventFileBytes ?? 5 * 1024 * 1024;
    this.maxRunFiles = options.maxRunFiles ?? 500;
    // Task snapshots are only re-parsed when their file actually changed, so a
    // dashboard polling health every few seconds does not re-read every task.
    this.taskCache = new Map();
    // Workspace locks this process currently holds, keyed by canonical
    // workspace. A fence that cannot be written is escalated onto the lock that
    // is still ours, so containment never depends on a single writable path.
    this.workspaceLocks = new Map();
  }

  async init() {
    await mkdir(this.tasksDir, { recursive: true });
    await mkdir(this.runsDir, { recursive: true });
    await mkdir(this.leasesDir, { recursive: true });
    await mkdir(this.baselinesDir, { recursive: true });
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
  // Two locks are taken together: a task lease in this store's leasesDir, and a
  // workspace lock at a fixed name INSIDE the workspace itself. The task lease
  // alone would still let two *different* tasks sharing a workspace run at the
  // same time; and a workspace lock kept in the stateDir would only be visible
  // to configs sharing that stateDir — two configs with different stateDirs
  // pointing at one workspace would each "acquire" their own copy. The
  // workspace root is the one location every such config can see, and realpath
  // collapses symlink aliases of it.
  async acquireRunLease(taskId, runId, { workspace, onLost } = {}) {
    validateTaskId(taskId);
    const startedAt = nowIso();
    const makeLease = (kind, canonicalWorkspace) => ({
      taskId,
      runId,
      kind,
      workspace: canonicalWorkspace,
      pid: process.pid,
      host: this.hostname,
      startedAt,
      heartbeatAt: startedAt
    });

    const canonicalWorkspace = workspace
      ? await realpath(workspace).catch(() => path.resolve(workspace))
      : null;
    if (canonicalWorkspace) {
      // Any of the three markers closes the workspace, and the one that is set
      // names the file the operator has to delete — including the digest-named
      // state record, which nobody could guess otherwise.
      const containment = await this.readWorkspaceContainment(canonicalWorkspace);
      if (containment) {
        throw new RunLeaseError(
          `Workspace ${canonicalWorkspace} is fenced after an unproven stop`
          + (containment.taskId ? ` of ${containment.taskId}` : "")
          + (containment.nodeId ? `/${containment.nodeId}` : "")
          + `. Confirm the agent is stopped, then delete ${containment.path}.`,
          containment
        );
      }
    }

    const taskLease = await this.#withLock(async () => {
      const existing = await this.#assessLease(this.#leasePath(taskId));
      if (existing?.alive) {
        throw new RunLeaseError(
          `Task ${taskId} is already being run by pid ${existing.pid} on ${existing.host} `
          + `(started ${existing.startedAt}). Stop that run before starting another.`,
          existing
        );
      }
      // Unconditional: a lease file that failed to parse also has no live
      // holder, and leaving it would make the exclusive create below fail with
      // a raw EEXIST instead of the RunLeaseError above.
      await rm(this.#leasePath(taskId), { force: true });
      const lease = makeLease("task", canonicalWorkspace);
      await writeFile(this.#leasePath(taskId), JSON.stringify(lease), { flag: "wx" });
      return lease;
    });

    let workspaceLock = null;
    if (canonicalWorkspace) {
      try {
        workspaceLock = await this.#acquireWorkspaceLock(canonicalWorkspace, makeLease);
      } catch (error) {
        // Never hold the task lease when the workspace could not be locked.
        await rm(this.#leasePath(taskId), { force: true });
        throw error;
      }
      // Re-checked with the lock in hand: the marker may have been written
      // between the check above and this acquisition, by a run that fenced the
      // workspace and then released the very lock just taken.
      const fenced = await this.readWorkspaceContainment(canonicalWorkspace);
      if (fenced) {
        // Both cleanups are best-effort: what the caller must see is the
        // containment, not whichever filesystem error tripped a cleanup. A
        // lock left behind here holds no containment and goes stale normally.
        const current = await this.#assessLease(workspaceLock.path);
        if (!current || current.runId === runId) {
          await rm(workspaceLock.path, { force: true }).catch(() => {});
        }
        await rm(this.#leasePath(taskId), { force: true }).catch(() => {});
        throw new RunLeaseError(
          `Workspace ${canonicalWorkspace} was fenced after an unproven stop while this run was `
          + `acquiring it. Confirm the agent is stopped, then delete ${fenced.path}.`,
          fenced
        );
      }
      // Every write to the lock file goes through one chain, so a containment
      // conversion can never interleave with a heartbeat refresh.
      let workspaceWrites = Promise.resolve();
      workspaceLock.serialize = (write) => {
        workspaceWrites = workspaceWrites.then(write, write);
        return workspaceWrites;
      };
      this.workspaceLocks.set(canonicalWorkspace, workspaceLock);
    }

    // Rewriting blindly would let a holder whose lock was superseded stomp the
    // new owner's file. The refresh therefore verifies ownership — and when it
    // finds a foreign lock, that is the moment this run has LOST the workspace:
    // going quiet is not enough, because the process itself would keep writing.
    // The onLost callback lets the orchestrator fence the run (abort it).
    let released = false;
    let lost = false;
    const markLost = (holder) => {
      if (lost || released) return;
      lost = true;
      clearInterval(timer);
      try { onLost?.(holder ?? null); } catch { /* fencing is best-effort */ }
    };
    const refresh = async (filePath, lease) => {
      if (released || lost) return;
      const current = await this.#assessLease(filePath);
      if (released || lost) return;
      // Our own writes are atomic (temp+rename) and takeover replaces in
      // place, so while we legitimately hold the lock this file always exists
      // and parses. Foreign content OR absence both mean the lock is no longer
      // ours — the documented recovery path ("delete the lock file and the run
      // stops itself") depends on absence fencing rather than re-creating.
      if (!current || current.runId !== lease.runId) return markLost(current);
      await atomicWrite(filePath, { ...lease, heartbeatAt: nowIso() });
    };
    // Deliberately ref'd: a held lease IS an active run, and the fence depends
    // on the next tick firing even when nothing else keeps the loop alive. All
    // exit paths clear it (release() runs in the orchestrator's finally,
    // markLost clears it on loss), so it cannot outlive the run.
    const timer = setInterval(() => {
      refresh(this.#leasePath(taskId), taskLease).catch(() => {});
      // A contained lock is a permanent marker, not a lease: keeping it fresh
      // would only give a heartbeat the chance to race the marker it carries.
      if (workspaceLock && !workspaceLock.contained) {
        workspaceLock.serialize(() => refresh(workspaceLock.path, workspaceLock.lease)).catch(() => {});
      }
    }, this.leaseHeartbeatMs);

    return {
      ...taskLease,
      release: async () => {
        released = true;
        clearInterval(timer);
        const currentTask = await this.#assessLease(this.#leasePath(taskId));
        if (!currentTask || currentTask.runId === runId) {
          await rm(this.#leasePath(taskId), { force: true });
        }
        if (workspaceLock) {
          if (this.workspaceLocks.get(canonicalWorkspace) === workspaceLock) {
            this.workspaceLocks.delete(canonicalWorkspace);
          }
          // A lock that carries (or is still trying to carry) containment IS
          // the fence for a run that could not prove its agent stopped;
          // releasing it would reopen the workspace to a second writer. Only
          // the operator may clear it.
          if (workspaceLock.contained || workspaceLock.containing) return;
          const currentWorkspace = await this.#assessLease(workspaceLock.path);
          // Never delete a lock that a later run already took over. A delete
          // that fails leaves a lock nobody holds, which the next run takes
          // over — releasing must not turn into the run's outcome.
          if (!currentWorkspace || currentWorkspace.runId === runId) {
            await rm(workspaceLock.path, { force: true }).catch(() => {});
          }
        }
      }
    };
  }

  // The stateDir #withLock cannot serialize configs with different stateDirs,
  // so the workspace lock relies on filesystem atomicity alone. Two operations
  // are atomic and are the only ones used to change ownership:
  //   - O_EXCL create, for the uncontended path;
  //   - mkdir of a takeover mutex, to serialize stale-lock takeover. Takeover
  //     previously did assess -> rm -> create, and two processes that both saw
  //     the stale lock could interleave so that the second rm deleted the
  //     winner's *fresh* lock — double acquisition. Inside the mutex the stale
  //     file is replaced via temp+rename, so the path never has a free window,
  //     and a read-back verifies ownership before the mutex is released.
  async #acquireWorkspaceLock(canonicalWorkspace, makeLease) {
    const lockPath = path.join(canonicalWorkspace, WORKSPACE_LOCK_NAME);
    const mutexPath = `${lockPath}.takeover`;
    const deadline = Date.now() + this.lockTimeoutMs;

    // A containment lock outlives its holder: it is what remains when a run
    // could not persist a fence file, so a dead PID and a cold heartbeat are
    // exactly the state it is meant to survive. Checked once here, before the
    // loop, because the stale-lock takeover below would otherwise replace it.
    const contained = await this.#readContainedLock(lockPath);
    if (contained) {
      throw new RunLeaseError(
        `Workspace ${canonicalWorkspace} is fenced after an unproven stop`
        + (contained.taskId ? ` of ${contained.taskId}` : "")
        + `. Confirm the agent is stopped, then delete ${lockPath}.`,
        contained
      );
    }

    while (Date.now() < deadline) {
      const lease = makeLease("workspace", canonicalWorkspace);
      try {
        await writeFile(lockPath, JSON.stringify(lease), { flag: "wx" });
        return { path: lockPath, lease };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }

      const existing = await this.#assessLease(lockPath);
      if (existing?.alive) {
        throw new RunLeaseError(
          `Workspace ${canonicalWorkspace} is already in use by task ${existing.taskId} `
          + `(pid ${existing.pid} on ${existing.host}, started ${existing.startedAt}). `
          + `Agents run one at a time per workspace; stop that run first, or delete ${lockPath} `
          + "once you have confirmed it is gone.",
          existing
        );
      }
      if (existing === null) {
        // The lock disappeared between the failed create and the assessment;
        // race for the exclusive create again.
        continue;
      }

      // Stale lock: take the takeover mutex. mkdir is atomic, so exactly one
      // contender enters; the rest wait and re-assess (they will usually find
      // the winner's fresh lock and throw above on the next iteration).
      try {
        await mkdir(mutexPath);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        // A mutex older than the stale threshold belongs to a takeover that
        // died mid-flight; clear it and retry. (rmdir of a fresh mutex by a
        // slow observer is theoretically possible but requires a crashed
        // takeover plus a microsecond interleave; the read-back below still
        // resolves any resulting race to a single owner.)
        const mutexInfo = await stat(mutexPath).catch(() => null);
        if (mutexInfo && Date.now() - mutexInfo.mtimeMs > this.staleLeaseMs) {
          await rmdir(mutexPath).catch(() => {});
        }
        await sleep(25);
        continue;
      }

      try {
        // Re-assess inside the mutex: the lock may have been taken over while
        // this contender was waiting to enter.
        const current = await this.#assessLease(lockPath);
        if (current?.alive) {
          throw new RunLeaseError(
            `Workspace ${canonicalWorkspace} is already in use by task ${current.taskId} `
            + `(pid ${current.pid} on ${current.host}, started ${current.startedAt}). `
            + `Agents run one at a time per workspace; stop that run first, or delete ${lockPath} `
            + "once you have confirmed it is gone.",
            current
          );
        }
        // Replace the stale file in place — never rm + create, which would
        // open a window where the path is free for a concurrent O_EXCL create.
        await atomicWrite(lockPath, lease);
        // Read-back: if any racer replaced after us, concede to them.
        await sleep(30);
        const verified = await this.#assessLease(lockPath);
        if (verified?.runId !== lease.runId) {
          throw new RunLeaseError(
            `Workspace ${canonicalWorkspace} was claimed by a concurrent run while `
            + "taking over a stale lock; not proceeding.",
            verified ?? undefined
          );
        }
        return { path: lockPath, lease };
      } finally {
        await rmdir(mutexPath).catch(() => {});
      }
    }
    throw new RunLeaseError(
      `Could not acquire the workspace lock at ${lockPath} within ${this.lockTimeoutMs} ms.`
    );
  }

  // Containment is what keeps a workspace closed once the run lease is
  // released, so this call may not come back until a marker is proven on disk.
  // Three locations are tried, each read back: the fence file and the workspace
  // lock are visible to every config pointing at this workspace; the state
  // record only to configs sharing this stateDir, but by the time an unproven
  // stop gets here the failed node has just been written there, so it is the
  // location most likely to still be writable. When none of them takes, the
  // call keeps retrying instead of returning — the lease is still held and its
  // heartbeat still runs, and a live holder is itself containment.
  async pinWorkspaceFence(workspace, record = {}, options = {}) {
    const canonicalWorkspace = await realpath(workspace).catch(() => path.resolve(workspace));
    const fence = {
      kind: "containment",
      workspace: canonicalWorkspace,
      taskId: record.taskId ?? null,
      nodeId: record.nodeId ?? null,
      reason: record.reason ?? "Execution could not be proven stopped",
      host: this.hostname,
      createdAt: nowIso()
    };
    let attempts = 1;
    let persisted = await this.#persistContainment(canonicalWorkspace, fence);
    // The state record is diagnostics, never an answer: a config with another
    // stateDir cannot see it, and the workspace is exactly what has to be
    // closed to every config. Only a marker inside the workspace ends the wait;
    // until one takes, the held lock — refreshed all the while — is what keeps
    // the workspace closed.
    while (persisted?.source !== "fence" && persisted?.source !== "lock") {
      try {
        // Reported before the first wait: a run that stops returning with
        // nothing on screen is indistinguishable from a deadlock. Never
        // awaited — an observer that hangs would suspend containment itself —
        // but an async one's rejection is swallowed here, because an unhandled
        // rejection would take the process down and with it the lease that is
        // holding the workspace.
        const notified = options.onBlocked?.({
          workspace: canonicalWorkspace,
          attempts,
          recorded: persisted?.source ?? null,
          fence
        });
        if (typeof notified?.then === "function") notified.then(undefined, () => {});
      } catch { /* an observer cannot veto containment */ }
      await sleep(this.containmentRetryMs);
      attempts += 1;
      persisted = await this.#persistContainment(canonicalWorkspace, fence);
    }
    // A fence file fences everyone by itself, so a lock that never became a
    // marker goes back to being an ordinary lock — keeping it would strand the
    // workspace behind a lock that names no containment once the operator
    // clears the fence.
    const held = this.workspaceLocks.get(canonicalWorkspace);
    if (persisted.source === "fence" && held && held.contained !== true) held.containing = false;
    return { ...fence, source: persisted.source, path: persisted.path };
  }

  async #persistContainment(canonicalWorkspace, fence) {
    const fencePath = path.join(canonicalWorkspace, WORKSPACE_FENCE_NAME);
    try {
      await atomicWrite(fencePath, fence);
      // Read the raw file, not readWorkspaceFence(): that reader reports an
      // unreadable marker AS a fence, which would turn a failed write into a
      // false confirmation.
      const written = JSON.parse(await readFile(fencePath, "utf8"));
      if (written.kind === "containment" && written.createdAt === fence.createdAt) {
        return { source: "fence", path: fencePath };
      }
    } catch { /* fall through to the next location */ }
    const lockPath = await this.#containWorkspaceLock(canonicalWorkspace, fence);
    if (lockPath) return { source: "lock", path: lockPath };
    const statePath = await this.#recordStateContainment(canonicalWorkspace, fence);
    if (statePath) return { source: "state", path: statePath };
    return null;
  }

  // Outside the workspace, so it survives a workspace that has become
  // unwritable — at the price of only being visible to configs sharing this
  // stateDir. Last of the three for that reason.
  async #recordStateContainment(canonicalWorkspace, fence) {
    const statePath = this.#stateContainmentPath(canonicalWorkspace);
    try {
      await mkdir(this.containmentsDir, { recursive: true });
      await atomicWrite(statePath, fence);
      const written = JSON.parse(await readFile(statePath, "utf8"));
      if (written.kind !== "containment" || written.createdAt !== fence.createdAt) return null;
      return statePath;
    } catch {
      return null;
    }
  }

  // Converts the workspace lock this process holds into a permanent fence. The
  // lock file is the one path already proven writable by this run, and unlike
  // the process itself it survives exit — #acquireWorkspaceLock refuses a
  // contained lock however stale it looks.
  async #containWorkspaceLock(canonicalWorkspace, fence) {
    const held = this.workspaceLocks.get(canonicalWorkspace);
    if (!held) return null;
    // Flagged before the rewrite: whether or not the marker lands, this lock
    // may never be released — while it is unmarked the run is still holding
    // and refreshing it, and that live lease is the only thing fencing configs
    // that cannot see this stateDir.
    held.containing = true;
    // Mutating the lease object the heartbeat captured is what keeps the marker
    // alive: refresh() rewrites `{...lease, heartbeatAt}` and would otherwise
    // erase it on the next tick. It also means a later heartbeat can still land
    // a marker this call reported as unwritten — containment may end up
    // stronger than reported, never weaker.
    Object.assign(held.lease, { contained: true, containment: fence });
    const convert = async () => {
      try {
        await atomicWrite(held.path, held.lease);
        // Containment counts only once it is on disk: an in-memory flag dies
        // with this process, and what it leaves behind is an ordinary lock the
        // next run would take over as soon as the heartbeat goes cold.
        const written = JSON.parse(await readFile(held.path, "utf8"));
        if (written.contained !== true || written.runId !== held.lease.runId) return null;
        // Only now is the marker permanent on its own, and only now may the
        // heartbeat stop: until this point the lock had to keep looking fresh,
        // because a cold lock is a lock another config takes over.
        held.contained = true;
        return held.path;
      } catch {
        return null;
      }
    };
    // Queued behind any heartbeat write already in flight: a refresh that
    // serialized the lease before this conversion could otherwise land its
    // rename afterwards and drop the marker the read-back just confirmed.
    return held.serialize ? held.serialize(convert) : convert();
  }

  async readWorkspaceFence(workspace) {
    const canonicalWorkspace = await realpath(workspace).catch(() => path.resolve(workspace));
    const fencePath = path.join(canonicalWorkspace, WORKSPACE_FENCE_NAME);
    let raw;
    try {
      raw = await readFile(fencePath, "utf8");
    } catch (error) {
      // Only "there is no marker" may open the workspace. Every other error
      // means a marker may exist and cannot be read, and an unreadable fence
      // has to count as a set one.
      if (error.code === "ENOENT") return null;
      if (error.code === "ENOTDIR") {
        // No fence can live under a workspace that is not a directory, and
        // calling that containment would send the operator to delete a path
        // that cannot exist.
        const info = await stat(canonicalWorkspace).catch(() => null);
        if (!info?.isDirectory()) {
          throw new ConfigError(`Workspace ${canonicalWorkspace} is not a directory`);
        }
      }
      return this.#unreadableFence(canonicalWorkspace, `${fencePath} could not be read (${error.code})`);
    }
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      return this.#unreadableFence(canonicalWorkspace, `${fencePath} is not a readable containment marker`);
    }
    // Parsing is not validation: `null`, `false` and `0` all parse and all read
    // as "no fence" at the call site. A marker that exists but does not
    // describe containment is still a marker.
    if (!record || typeof record !== "object" || record.kind !== "containment") {
      return this.#unreadableFence(canonicalWorkspace, `${fencePath} is not a containment record`);
    }
    return record;
  }

  // A contained workspace is a persistent safety state a human has to clear,
  // not a run in progress. listLeases() deliberately hides workspace locks, so
  // the three markers need a surface of their own.
  async readWorkspaceContainment(workspace) {
    const canonicalWorkspace = await realpath(workspace).catch(() => path.resolve(workspace));
    const fence = await this.readWorkspaceFence(canonicalWorkspace);
    if (fence) {
      return this.#containmentView("fence", path.join(canonicalWorkspace, WORKSPACE_FENCE_NAME), canonicalWorkspace, fence);
    }
    const lockPath = path.join(canonicalWorkspace, WORKSPACE_LOCK_NAME);
    const lock = await this.#readContainedLock(lockPath);
    if (lock) {
      return this.#containmentView("lock", lockPath, canonicalWorkspace, {
        taskId: lock.taskId,
        ...(lock.containment && typeof lock.containment === "object" ? lock.containment : {})
      });
    }
    const state = await this.#readStateContainment(canonicalWorkspace);
    if (state) {
      return this.#containmentView("state", this.#stateContainmentPath(canonicalWorkspace), canonicalWorkspace, state);
    }
    return null;
  }

  // The marker is data on disk, written by whatever last held the path, so the
  // recovery instructions built from it come from the canonical values here —
  // never from fields the record itself carries. A marker that could name its
  // own `path` could send an operator to delete an unrelated file.
  #containmentView(source, markerPath, canonicalWorkspace, record) {
    return {
      source,
      path: markerPath,
      kind: "containment",
      workspace: canonicalWorkspace,
      taskId: asText(record?.taskId),
      nodeId: asText(record?.nodeId),
      reason: asText(record?.reason) ?? "Execution could not be proven stopped",
      unreadable: record?.unreadable === true
    };
  }

  #stateContainmentPath(canonicalWorkspace) {
    const digest = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 16);
    return path.join(this.containmentsDir, `${digest}.json`);
  }

  async #readStateContainment(canonicalWorkspace) {
    const statePath = this.#stateContainmentPath(canonicalWorkspace);
    let raw;
    try {
      raw = await readFile(statePath, "utf8");
    } catch (error) {
      // ENOENT is "no record"; so is ENOTDIR, which says the containments path
      // is not a directory and therefore never held one. That is proof of
      // absence, unlike a record file that exists and cannot be read — fencing
      // on it would close every workspace this config can reach.
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      return this.#unreadableFence(canonicalWorkspace, `${statePath} could not be read (${error.code})`);
    }
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      return this.#unreadableFence(canonicalWorkspace, `${statePath} is not a readable containment marker`);
    }
    if (!record || typeof record !== "object" || record.kind !== "containment") {
      return this.#unreadableFence(canonicalWorkspace, `${statePath} is not a containment record`);
    }
    // The file name is a digest, so a record for a different workspace here
    // would be a collision, not containment of this one.
    if (record.workspace !== canonicalWorkspace) return null;
    return record;
  }

  #unreadableFence(canonicalWorkspace, reason) {
    return {
      kind: "containment",
      workspace: canonicalWorkspace,
      taskId: null,
      nodeId: null,
      unreadable: true,
      reason
    };
  }

  async #readContainedLock(lockPath) {
    try {
      const lease = JSON.parse(await readFile(lockPath, "utf8"));
      return lease?.contained === true ? lease : null;
    } catch {
      // Absent or unparseable: the acquisition loop already refuses to take
      // over a lock it cannot read.
      return null;
    }
  }

  async readWorkspaceLease(workspace) {
    const canonicalWorkspace = await realpath(workspace).catch(() => path.resolve(workspace));
    return this.#assessLease(path.join(canonicalWorkspace, WORKSPACE_LOCK_NAME));
  }

  async readLease(taskId) {
    validateTaskId(taskId);
    return this.#assessLease(this.#leasePath(taskId));
  }

  async listLeases() {
    await this.init();
    const names = await readdir(this.leasesDir).catch(() => []);
    const leases = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const lease = await this.#assessLease(path.join(this.leasesDir, name));
      // Workspace leases mirror a task lease; surfacing both would double-count.
      if (lease && lease.kind !== "workspace") leases.push(lease);
    }
    return leases;
  }

  async #assessLease(filePath) {
    let lease;
    try {
      lease = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      return null;
    }
    const age = Date.now() - new Date(lease.heartbeatAt).getTime();
    const fresh = Number.isFinite(age) && age < this.staleLeaseMs;
    const sameHost = lease.host === this.hostname;
    // Same host: the PID can be probed directly, and a live PID is a live
    // holder even if its heartbeat paused (a SIGSTOPped process resumes and
    // keeps writing; taking its lock over would create two writers). Only a
    // gone PID is reclaimable. Other hosts cannot be probed, so heartbeat
    // freshness is the only available signal there.
    const alive = sameHost ? isProcessAlive(lease.pid) : fresh;
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
    let removed = 0;
    // Baseline blobs accumulate like raw run output does; same cap, same policy.
    for (const dir of [this.runsDir, this.baselinesDir]) {
      const names = await readdir(dir).catch(() => []);
      if (names.length <= this.maxRunFiles) continue;
      const entries = [];
      for (const name of names) {
        const filePath = path.join(dir, name);
        const info = await stat(filePath).catch(() => null);
        if (info?.isFile()) entries.push({ filePath, mtimeMs: info.mtimeMs });
      }
      entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
      const excess = entries.slice(0, Math.max(0, entries.length - this.maxRunFiles));
      for (const entry of excess) await rm(entry.filePath, { force: true });
      removed += excess.length;
    }
    return removed;
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
      const lease = await this.#assessLease(this.#leasePath(taskId));
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

async function atomicWrite(target, lease) {
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(lease), "utf8");
    await rename(temporary, target);
  } catch (error) {
    // A swap that could not complete must not leave its scratch file behind in
    // the workspace.
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function asText(value) {
  return typeof value === "string" ? value : null;
}

function safeParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    // A torn final line from a crashed append must not break the whole read.
    return null;
  }
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
