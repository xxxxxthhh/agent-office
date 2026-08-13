import { randomUUID } from "node:crypto";
import { AdapterError, ConfigError } from "./errors.js";
import { createAdapters } from "./adapters/index.js";
import { inventoryFromConfig, routeTask } from "./capabilities.js";
import { nowIso, truncate } from "./utils.js";

export class Orchestrator {
  constructor({
    config,
    store,
    schema,
    schemaPath,
    capabilityRegistry = null,
    adapterOverrides = {}
  }) {
    this.config = config;
    this.store = store;
    this.schema = schema;
    this.schemaPath = schemaPath;
    this.capabilityRegistry = capabilityRegistry;
    this.adapters = createAdapters(
      config,
      { config, store, schema, schemaPath },
      adapterOverrides
    );
  }

  async createTask(objective) {
    const inventory = this.capabilityRegistry
      ? await this.capabilityRegistry.discover()
      : inventoryFromConfig(this.config);
    const routing = routeTask(objective, inventory, this.config);
    const agentsById = new Map(this.config.agents.map((agent) => [agent.id, agent]));
    const assignedAgents = routing.assignments
      .map((assignment) => agentsById.get(assignment.agentId))
      .filter(Boolean);
    if (!assignedAgents.length) {
      throw new ConfigError("Capability routing did not select any configured agent");
    }
    return this.store.createTask(objective, assignedAgents, { routing });
  }

  async runTask(taskId, options = {}) {
    const maxRounds = options.maxRounds ?? this.config.collaboration.maxRounds;
    const onEvent = options.onEvent ?? (() => {});
    let task = await this.store.loadTask(taskId);
    if (task.mode === "workflow") {
      if (!this.workflowOrchestrator) {
        throw new ConfigError("Workflow task requires a WorkflowOrchestrator runtime");
      }
      return this.workflowOrchestrator.runWorkflow(taskId, options);
    }
    this.#assertTaskRoster(task);
    if (["completed", "awaiting_input", "failed"].includes(task.status)) return task;
    if (this.capabilityRegistry) {
      await this.capabilityRegistry.discover();
    }

    await this.store.updateTask(taskId, "run.started", (current) => {
      current.status = "running";
    }, { maxRounds });
    onEvent({ type: "run.started", taskId, maxRounds });

    for (let round = 1; round <= maxRounds; round += 1) {
      let attemptedTurn = false;
      onEvent({ type: "round.started", taskId, round });

      for (const agent of this.#taskAgents(task)) {
        task = await this.store.loadTask(taskId);
        if (task.status !== "running") break;
        const participant = task.participants[agent.id];
        if (!participant || participant.status === "done" || participant.status === "failed") {
          continue;
        }

        attemptedTurn = true;
        const prompt = this.#buildPrompt(task, agent);
        const adapter = this.adapters.get(agent.id);
        const assignment = this.#assignment(task, agent.id);
        onEvent({
          type: "turn.started",
          taskId,
          round,
          agentId: agent.id,
          model: assignment?.model ?? agent.model ?? null,
          effort: assignment?.effort ?? agent.effort ?? null
        });

        let result;
        try {
          result = await adapter.runTurn({
            prompt,
            workspace: this.config.workspace,
            timeoutMs: agent.timeoutMs ?? this.config.collaboration.turnTimeoutMs,
            model: assignment?.model ?? agent.model,
            effort: assignment?.effort ?? agent.effort
          });
        } catch (error) {
          await this.#recordFailure(taskId, agent.id, error);
          onEvent({
            type: "turn.failed",
            taskId,
            round,
            agentId: agent.id,
            error: error.message
          });
          continue;
        }

        await this.#recordTurn(taskId, agent.id, result, assignment);
        onEvent({
          type: "turn.completed",
          taskId,
          round,
          agentId: agent.id,
          model: assignment?.model ?? agent.model ?? null,
          response: result.response,
          tracePath: result.tracePath
        });

        task = await this.#settleTask(taskId);
        if (task.status !== "running") break;
      }

      await this.store.updateTask(taskId, "round.completed", (current) => {
        current.roundsCompleted += 1;
      }, { round });
      task = await this.#settleTask(taskId);
      onEvent({ type: "round.completed", taskId, round, status: task.status });

      if (task.status !== "running") break;
      if (!attemptedTurn) {
        await this.store.updateTask(taskId, "run.stalled", (current) => {
          current.status = "awaiting_input";
        });
        break;
      }
    }

    task = await this.store.loadTask(taskId);
    if (task.status === "running") {
      await this.store.updateTask(taskId, "run.paused", (current) => {
        current.status = "ready";
      }, { reason: "round_limit" });
    }
    task = await this.store.loadTask(taskId);
    onEvent({ type: "run.finished", taskId, status: task.status });
    return task;
  }

  setWorkflowOrchestrator(workflowOrchestrator) {
    this.workflowOrchestrator = workflowOrchestrator;
  }

  describeAgents() {
    return this.config.agents.map((agent) => ({
      id: agent.id,
      adapter: agent.adapter,
      role: agent.role,
      ...this.adapters.get(agent.id).describe()
    }));
  }

  async discoverCapabilities(options = {}) {
    return this.capabilityRegistry
      ? this.capabilityRegistry.discover(options)
      : inventoryFromConfig(this.config);
  }

  async planTask(objective, options = {}) {
    const inventory = await this.discoverCapabilities(options);
    return routeTask(objective, inventory, this.config);
  }

  #buildPrompt(task, agent) {
    const visibleMessages = task.messages
      .filter((message) => (
        message.to === "team"
        || message.to === agent.id
        || message.from === agent.id
      ))
      .slice(-this.config.collaboration.transcriptMessages);
    const roster = this.#taskAgents(task).map((member) => {
      const state = task.participants[member.id];
      const assignment = this.#assignment(task, member.id);
      const model = assignment?.modelLabel ?? assignment?.model ?? member.model ?? "provider default";
      return `- ${member.id}: ${member.role} [status=${state?.status ?? "unknown"}, model=${model}]`;
    }).join("\n");
    const transcript = visibleMessages.length
      ? visibleMessages.map((message) => (
          `[${message.sequence}] ${message.from} -> ${message.to}: ${truncate(message.body, 3000)}`
        )).join("\n\n")
      : "(no messages yet)";

    return [
      `You are "${agent.id}", a colleague in Agent Office.`,
      "",
      "Shared task objective:",
      task.objective,
      "",
      `Shared workspace: ${this.config.workspace}`,
      "",
      "Team:",
      roster,
      "",
      "Your role:",
      agent.role,
      "",
      "Capability-aware assignment:",
      this.#assignmentSummary(task, agent.id),
      "",
      "Recent shared conversation:",
      transcript,
      "",
      "Collaboration rules:",
      "- Work directly in the shared workspace when action is appropriate.",
      "- Inspect current files and colleague artifacts before assuming their state.",
      "- Keep changes within your role and preserve unrelated work.",
      "- Send a direct message to a colleague when they must act on a handoff or review finding.",
      "- Set needsUser=true only when the team cannot safely progress without user input.",
      "- Use status=done only when your role has no remaining work or handoff.",
      "- Return only one JSON object matching the supplied turn schema.",
      "",
      "Required JSON fields: summary, status, messages[{to,body}], artifacts[], needsUser."
    ].join("\n");
  }

  async #recordTurn(taskId, agentId, result, assignment) {
    const response = result.response;

    await this.store.updateTask(taskId, "turn.completed", (task) => {
      const at = nowIso();
      const validTargets = new Set(["team", "user", ...Object.keys(task.participants)]);
      const outgoing = response.messages.filter((message) => validTargets.has(message.to));
      const participant = task.participants[agentId];
      participant.status = response.status;
      participant.turns += 1;
      participant.lastTurnAt = at;
      participant.lastSummary = response.summary;
      participant.artifacts = [...new Set([...participant.artifacts, ...response.artifacts])];

      task.turns.push({
        id: randomUUID(),
        agentId,
        at,
        summary: response.summary,
        status: response.status,
        model: assignment?.model ?? null,
        effort: assignment?.effort ?? null,
        artifacts: response.artifacts,
        tracePath: result.tracePath
      });
      pushMessage(task, {
        from: agentId,
        to: "team",
        body: response.summary,
        at
      });

      for (const message of outgoing) {
        pushMessage(task, {
          from: agentId,
          to: message.to,
          body: message.body,
          at
        });
        if (task.participants[message.to]?.status === "done") {
          task.participants[message.to].status = "working";
        }
      }
      if (response.needsUser || outgoing.some((message) => message.to === "user")) {
        task.status = "awaiting_input";
      }
    }, {
      agentId,
      model: assignment?.model ?? null,
      effort: assignment?.effort ?? null,
      status: response.status,
      tracePath: result.tracePath
    });
  }

  async #recordFailure(taskId, agentId, error) {
    const details = error instanceof AdapterError ? error.details : {};
    await this.store.updateTask(taskId, "turn.failed", (task) => {
      const participant = task.participants[agentId];
      participant.status = "failed";
      participant.lastTurnAt = nowIso();
      participant.lastSummary = error.message;
      pushMessage(task, {
        from: "system",
        to: "team",
        body: `${agentId} failed to complete its turn: ${error.message}`,
        at: nowIso()
      });
    }, {
      agentId,
      error: error.message,
      stderr: details.stderr
    });
  }

  async #settleTask(taskId) {
    const current = await this.store.loadTask(taskId);
    const nextStatus = settledStatus(current);
    if (!nextStatus || nextStatus === current.status) return current;
    return this.store.updateTask(taskId, "task.status_changed", (task) => {
      const lockedStatus = settledStatus(task);
      if (lockedStatus) task.status = lockedStatus;
    }, {
      from: current.status,
      to: nextStatus
    });
  }

  #assertTaskRoster(task) {
    const configured = this.config.agents.map((agent) => agent.id).sort();
    const persisted = Object.keys(task.participants).sort();
    const expected = task.roster?.map((agent) => agent.id).sort() ?? configured;
    const rosterChanged = (
      expected.length !== persisted.length
      || expected.some((agentId, index) => agentId !== persisted[index])
    );
    const missingConfigured = persisted.some((agentId) => !configured.includes(agentId));
    const adapterChanged = (task.roster ?? []).some((snapshot) => {
      const current = this.config.agents.find((agent) => agent.id === snapshot.id);
      return !current || current.adapter !== snapshot.adapter;
    });
    if (rosterChanged || missingConfigured || adapterChanged) {
      throw new ConfigError(
        `Task ${task.id} was created for [${persisted.join(", ")}], `
        + `but the current configuration defines [${configured.join(", ")}]. `
        + "Restore the original roster or create a new task."
      );
    }
  }

  #taskAgents(task) {
    const configured = new Map(this.config.agents.map((agent) => [agent.id, agent]));
    const order = task.routing?.assignments?.map((assignment) => assignment.agentId)
      ?? Object.keys(task.participants);
    return order.map((agentId) => configured.get(agentId)).filter(Boolean);
  }

  #assignment(task, agentId) {
    return task.routing?.assignments?.find((assignment) => assignment.agentId === agentId)
      ?? task.participants[agentId]?.assignment
      ?? null;
  }

  #assignmentSummary(task, agentId) {
    const assignment = this.#assignment(task, agentId);
    if (!assignment) return "No dynamic assignment; use the configured provider default.";
    return [
      `- Model: ${assignment.modelLabel ?? assignment.model ?? "provider default"}`,
      `- Reasoning effort: ${assignment.effort ?? "provider default"}`,
      `- Match score: ${assignment.score ?? "not scored"}`,
      `- Task profile: ${task.routing?.profile?.kinds?.join(", ") ?? "general"}`,
      `- Routing reasons: ${(assignment.reasons ?? []).join(" ")}`
    ].join("\n");
  }
}

function pushMessage(task, { from, to, body, at }) {
  task.messages.push({
    id: randomUUID(),
    sequence: task.nextSequence++,
    from,
    to,
    body,
    createdAt: at
  });
}

function settledStatus(task) {
  if (task.status === "awaiting_input") return task.status;
  const states = Object.values(task.participants).map((participant) => participant.status);
  if (states.every((status) => status === "done")) return "completed";
  if (states.every((status) => status === "blocked" || status === "failed" || status === "done")) {
    return states.includes("blocked") ? "awaiting_input" : "failed";
  }
  return null;
}
