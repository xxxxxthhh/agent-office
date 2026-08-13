import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { ConfigError, RunCancelledError } from "./errors.js";
import { createAdapters } from "./adapters/index.js";
import { normalizeWorkflowDefinition } from "./workflow-definition.js";
import { WorkspaceManager } from "./workspaces.js";
import { HerdrExecutionRuntime, ProcessExecutionRuntime } from "./execution-runtimes.js";
import { isRelativeOutside, nowIso, sleep, truncate } from "./utils.js";

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed"]);
const ACTIVE_NODE_STATUSES = new Set(["dispatched", "working"]);

export class WorkflowOrchestrator {
  constructor({ config, store, schema, schemaPath, adapterOverrides = {}, runtimeOverrides = {} }) {
    this.config = config;
    this.store = store;
    this.schema = schema;
    this.schemaPath = schemaPath;
    this.adapters = createAdapters(
      config,
      { config, store, schema, schemaPath },
      adapterOverrides
    );
    this.processRuntime = runtimeOverrides.process ?? new ProcessExecutionRuntime({
      config,
      store,
      adapters: this.adapters
    });
    this.herdrRuntime = runtimeOverrides.herdr ?? new HerdrExecutionRuntime({ config, store });
    this.workspaceManager = runtimeOverrides.workspaceManager ?? new WorkspaceManager({
      config,
      createHerdrWorktree: (options) => this.herdrRuntime.createWorktree(options)
    });
  }

  async createWorkflow(objective, rawDefinition) {
    await assertControlStateOutsideWorkspace(this.config);
    const definition = normalizeWorkflowDefinition(rawDefinition, this.config);
    const owners = new Set(definition.nodes.filter((node) => node.owner).map((node) => node.owner));
    const agents = this.config.agents.filter((agent) => owners.has(agent.id));
    if (!agents.length) {
      throw new ConfigError("Workflow must contain at least one agent node");
    }
    return this.store.createWorkflow(objective, agents, definition);
  }

  async runWorkflow(taskId, options = {}) {
    const onEvent = options.onEvent ?? (() => {});
    const signal = options.signal ?? null;
    await assertControlStateOutsideWorkspace(this.config);
    let task = await this.store.loadTask(taskId);
    this.#assertWorkflow(task);
    this.#assertRoster(task);
    if (TERMINAL_TASK_STATUSES.has(task.status)) return task;
    throwIfAborted(signal);

    const leaseId = randomUUID();
    await this.#acquireLease(taskId, leaseId);
    const stopHeartbeat = this.#startLeaseHeartbeat(taskId, leaseId);
    try {
      return await this.#runWorkflowWithLease(taskId, leaseId, onEvent, signal);
    } catch (error) {
      if (!isCancellation(error, signal)) throw error;
      await this.#markCancelled(taskId, leaseId);
      task = await this.store.loadTask(taskId);
      onEvent({ type: "run.finished", taskId, status: task.status, cancelled: true });
      return task;
    } finally {
      stopHeartbeat();
      await this.#releaseLease(taskId, leaseId);
    }
  }

  async #runWorkflowWithLease(taskId, leaseId, onEvent, signal = null) {
    let task;

    throwIfAborted(signal);
    await this.#reconcile(taskId, leaseId, onEvent);
    await this.store.updateTask(taskId, "workflow.run_started", (current) => {
      this.#assertLease(current, leaseId);
      if (!TERMINAL_TASK_STATUSES.has(current.status)) current.status = "running";
    }, {});
    onEvent({ type: "workflow.run_started", taskId });

    while (true) {
      throwIfAborted(signal);
      const claimed = await this.#claimReadyNodes(taskId, leaseId);
      for (const node of claimed) {
        onEvent({ type: "workflow.node_dispatched", taskId, nodeId: node.id, attempt: node.attempts });
      }
      if (claimed.length) {
        await this.#runClaimedNodes(claimed, taskId, leaseId, onEvent, signal);
        continue;
      }

      task = await this.#settle(taskId, leaseId);
      if (task.status !== "running") {
        onEvent({ type: "workflow.run_finished", taskId, status: task.status });
        return task;
      }

      const active = Object.values(task.workflow.nodes).filter((node) => ACTIVE_NODE_STATUSES.has(node.status));
      if (!active.length) {
        task = await this.store.updateTask(taskId, "workflow.stalled", (current) => {
          this.#assertLease(current, leaseId);
          current.status = "failed";
          current.failureReason = "Workflow has no runnable or active nodes";
          current.workflow.lease = null;
        });
        onEvent({ type: "workflow.run_finished", taskId, status: task.status });
        return task;
      }

      // Another scheduler owns active nodes. Persisted Herdr bindings make the next run recoverable.
      task = await this.store.updateTask(taskId, "workflow.run_detached", (current) => {
        this.#assertLease(current, leaseId);
        current.status = "ready";
        current.workflow.lease = null;
      }, { activeNodes: active.map((node) => node.id) });
      onEvent({ type: "workflow.run_finished", taskId, status: task.status });
      return task;
    }
  }

  async #claimReadyNodes(taskId, leaseId) {
    return this.store.updateTask(taskId, "workflow.ready_set_claimed", (task) => {
      this.#assertLease(task, leaseId);
      const nodes = task.workflow.nodes;
      for (const nodeId of task.workflow.order) {
        const node = nodes[nodeId];
        if (node.status !== "pending") continue;
        const dependencies = node.dependsOn.map((id) => nodes[id]);
        if (dependencies.some((dependency) => ["failed", "skipped"].includes(dependency.status))) {
          node.status = "skipped";
          node.error = "A dependency did not succeed";
          node.completedAt = nowIso();
        } else if (dependencies.every((dependency) => dependency.status === "succeeded")) {
          node.status = "ready";
        }
      }

      for (const nodeId of task.workflow.order) {
        const node = nodes[nodeId];
        if (node.type === "approval" && node.status === "ready") {
          node.status = "awaiting_approval";
        }
      }

      const activeCount = Object.values(nodes).filter((node) => ACTIVE_NODE_STATUSES.has(node.status)).length;
      const capacity = Math.max(task.workflow.maxConcurrency - activeCount, 0);
      const claimed = task.workflow.order
        .map((id) => nodes[id])
        .filter((node) => node.status === "ready" && node.type !== "approval")
        .slice(0, capacity);
      for (const node of claimed) {
        node.status = "dispatched";
        node.attempts += 1;
        node.attemptToken = randomUUID();
        node.result = null;
        node.error = null;
        node.startedAt = nowIso();
      }
      refreshParticipants(task);
      return claimed.map((node) => structuredClone(node));
    }, {});
  }

  async #runClaimedNodes(claimed, taskId, leaseId, onEvent, signal) {
    const results = await Promise.allSettled(
      claimed.map((node) => this.#executeNode(taskId, node.id, leaseId, onEvent, signal))
    );
    const rejected = results.filter((result) => result.status === "rejected");
    const cancellation = rejected.find((result) => isCancellation(result.reason, signal));
    if (cancellation) throw cancellation.reason;
    if (rejected[0]) throw rejected[0].reason;
  }

  async #executeNode(taskId, nodeId, leaseId, onEvent, signal = null) {
    let handle = null;
    let runtime = null;
    let attemptToken = null;
    let node = null;
    let workspace = null;
    let baseline = null;
    try {
      let task = await this.store.loadTask(taskId);
      node = task.workflow.nodes[nodeId];
      attemptToken = node.attemptToken;
      workspace = await this.workspaceManager.resolve(task, node);
      baseline = await this.workspaceManager.snapshot(workspace);
      const resultPath = node.type === "agent" && task.workflow.runtime === "herdr"
        ? await createTurnDrop(task.id, node.id, node.attemptToken)
        : null;
      runtime = node.type === "agent" && task.workflow.runtime === "herdr"
        ? this.herdrRuntime
        : this.processRuntime;
      const binding = await runtime.ensureAgent({
        task,
        node,
        workspace,
        resultDirectory: resultPath ? path.dirname(resultPath) : null,
        existingBinding: node.binding
      });

      await this.store.updateTask(taskId, "workflow.node_started", (current) => {
        this.#assertLease(current, leaseId);
        const currentNode = current.workflow.nodes[nodeId];
        this.#assertAttempt(currentNode, node.attemptToken);
        currentNode.status = "working";
        currentNode.workspacePath = workspace;
        currentNode.baselineChanges = baseline;
        if (currentNode.access === "write" && !currentNode.integrationBaseline) {
          currentNode.integrationBaseline = baseline;
        }
        currentNode.binding = binding;
        currentNode.resultPath = resultPath;
        refreshParticipants(current);
      }, { nodeId, attempt: node.attempts, workspace, binding });
      task = await this.store.loadTask(taskId);
      node = task.workflow.nodes[nodeId];
      const prompt = this.#buildPrompt(task, node, workspace, resultPath);
      onEvent({ type: "workflow.node_started", taskId, nodeId, workspace });
      throwIfAborted(signal);

      let execution;
      if (node.type === "integration") {
        const intent = node.publicationIntent
          ?? await this.workspaceManager.prepareIntegration(task, node);
        if (!node.publicationIntent) {
          await this.store.updateTask(taskId, "workflow.integration_prepared", (current) => {
            this.#assertLease(current, leaseId);
            const currentNode = current.workflow.nodes[nodeId];
            this.#assertAttempt(currentNode, node.attemptToken);
            currentNode.publicationIntent = intent;
          }, { nodeId, sourceHead: intent.sourceHead, changedFiles: intent.changedFiles });
        }
        const publication = await this.workspaceManager.publishIntegration(intent);
        execution = {
          response: {
            summary: `Published ${publication.branch} to ${publication.head} with ff-only integration.`,
            status: "done",
            messages: [],
            artifacts: [],
            needsUser: false
          },
          tracePath: null,
          publication
        };
      } else {
        handle = await runtime.dispatch({
          task,
          node,
          binding,
          prompt,
          workspace,
          timeoutMs: this.#timeoutFor(node),
          attemptToken: node.attemptToken,
          assignment: task.participants[node.owner]?.assignment ?? null,
          signal
        });
        execution = await runtime.wait(handle);
        if (execution.binding) {
          await this.store.updateTask(taskId, "workflow.binding_refreshed", (current) => {
            this.#assertLease(current, leaseId);
            const currentNode = current.workflow.nodes[nodeId];
            this.#assertAttempt(currentNode, node.attemptToken);
            currentNode.binding = execution.binding;
          }, { nodeId, binding: execution.binding });
        }
      }
      if (node.type === "integration") {
        await this.store.submitWorkflowTurn(taskId, nodeId, node.attemptToken, execution.response);
      } else if (resultPath) {
        const submitted = await readTurnDrop(resultPath, node.attemptToken);
        await this.store.submitWorkflowTurn(taskId, nodeId, node.attemptToken, submitted);
        execution.response = submitted;
        const tracePath = this.store.createRunPath(node.id, "herdr.json");
        await writeFile(tracePath, `${JSON.stringify({
          binding,
          result: submitted,
          herdr: execution.herdr ?? null
        }, null, 2)}\n`, "utf8");
        execution.tracePath = tracePath;
      } else {
        await this.store.submitWorkflowTurn(taskId, nodeId, node.attemptToken, execution.response);
      }

      task = await this.store.loadTask(taskId);
      node = task.workflow.nodes[nodeId];
      const artifactWorkspace = node.type === "integration" ? this.config.workspace : workspace;
      await this.workspaceManager.validateArtifacts(artifactWorkspace, node.result?.artifacts ?? []);
      const after = await this.workspaceManager.snapshot(workspace);
      const changedFiles = node.type === "integration"
        ? execution.publication.changedFiles
        : this.workspaceManager.validateChanges(node, baseline, after);
      const completed = await this.#completeNode(
        taskId,
        nodeId,
        node.attemptToken,
        execution,
        changedFiles,
        leaseId,
        after
      );
      onEvent({
        type: completed.status === "succeeded" ? "workflow.node_succeeded" : "workflow.node_blocked",
        taskId,
        nodeId,
        status: completed.status,
        changedFiles
      });
    } catch (error) {
      const canInterrupt = runtime && handle && typeof runtime.interrupt === "function";
      if (isCancellation(error, signal)) {
        if (canInterrupt) await runtime.interrupt(handle).catch(() => {});
        await this.#reopenCancelledNode(taskId, nodeId, attemptToken, leaseId);
        throw error;
      }
      const containment = canInterrupt
        ? await runtime.interrupt(handle).catch(() => ({ settled: false }))
        : { settled: true };
      const failure = await this.#inspectFailedWorkspace(
        taskId,
        node,
        attemptToken,
        workspace,
        baseline,
        error,
        leaseId,
        containment.settled === false
      );
      await this.#failNode(taskId, nodeId, attemptToken, failure.error, leaseId, failure.violation);
      onEvent({ type: "workflow.node_failed", taskId, nodeId, error: failure.error.message });
    } finally {
      if (runtime && handle) await runtime.release(handle).catch(() => {});
    }
  }

  async #inspectFailedWorkspace(
    taskId,
    node,
    attemptToken,
    workspace,
    baseline,
    error,
    leaseId,
    executionMayStillMutate = false
  ) {
    if (!node || !workspace || !baseline || node.type === "integration") {
      return { error, violation: null };
    }
    let after = null;
    let boundaryError = null;
    try {
      after = await this.workspaceManager.snapshot(workspace);
      this.workspaceManager.validateChanges(node, baseline, after);
    } catch (candidate) {
      boundaryError = candidate;
    }
    if (!boundaryError && !executionMayStillMutate) return { error, violation: null };
    const changedFiles = after ? changedSnapshotPaths(baseline, after) : [];
    const sourceId = node.access === "write" ? node.id : node.workspaceFrom;
    const violation = {
      nodeId: node.id,
      sourceId: sourceId ?? null,
      attemptToken,
      workspace,
      changedFiles,
      detectedAt: nowIso(),
      reason: boundaryError?.message ?? "Execution could not be proven stopped after failure"
    };
    return {
      error: new ConfigError(
        `${error.message}; workspace boundary violation: ${violation.reason}`
      ),
      violation
    };
  }

  async #completeNode(
    taskId,
    nodeId,
    attemptToken,
    execution,
    changedFiles,
    leaseId = null,
    completedSnapshot = null
  ) {
    return this.store.updateTask(taskId, "workflow.node_completed", (task) => {
      if (leaseId) this.#assertLease(task, leaseId);
      const node = task.workflow.nodes[nodeId];
      this.#assertAttempt(node, attemptToken);
      const response = node.result;
      if (!response) throw new ConfigError(`Workflow node "${nodeId}" has no submitted result`);
      const at = nowIso();
      node.changedFiles = changedFiles;
      node.tracePath = execution.tracePath ?? null;
      node.completedAt = at;
      if (response.needsUser || response.status === "blocked") {
        node.status = "blocked";
      } else if (response.status === "done") {
        node.status = "succeeded";
      } else if (node.attempts < node.maxAttempts) {
        node.status = "ready";
      } else {
        node.status = "failed";
        node.error = "Node returned status=working without another allowed attempt";
      }
      if (node.status === "succeeded" && node.access === "write" && completedSnapshot) {
        node.verifiedSnapshot = completedSnapshot;
      }
      if (node.type === "integration" && execution.publication) {
        node.publication = execution.publication;
      }
      if (execution.binding) node.binding = execution.binding;
      recordWorkflowTurn(task, node, response, execution.tracePath, at);
      refreshParticipants(task);
      return structuredClone(node);
    }, { nodeId, status: execution.response?.status ?? null, changedFiles });
  }

  async #failNode(taskId, nodeId, attemptToken, error, leaseId = null, violation = null) {
    return this.store.updateTask(taskId, "workflow.node_failed", (task) => {
      if (leaseId) this.#assertLease(task, leaseId);
      const node = task.workflow?.nodes?.[nodeId];
      if (!node || !ACTIVE_NODE_STATUSES.has(node.status)) return;
      if (attemptToken && node.attemptToken !== attemptToken) return;
      node.status = "failed";
      node.error = error.message;
      node.completedAt = nowIso();
      if (violation) {
        node.workspaceViolation = violation;
        if (violation.sourceId) {
          task.workflow.workspaceTaints ??= {};
          task.workflow.workspaceTaints[violation.sourceId] = violation;
        }
      }
      refreshParticipants(task);
    }, { nodeId, error: error.message, violation });
  }

  async #settle(taskId, leaseId) {
    return this.store.updateTask(taskId, "workflow.settled", (task) => {
      this.#assertLease(task, leaseId);
      const nodes = Object.values(task.workflow.nodes);
      const active = nodes.some((node) => ACTIVE_NODE_STATUSES.has(node.status));
      const ready = nodes.some((node) => node.status === "ready");
      if (nodes.every((node) => node.status === "succeeded")) {
        task.status = "completed";
      } else if (!active && !ready && nodes.some((node) => ["blocked", "awaiting_approval"].includes(node.status))) {
        task.status = "awaiting_input";
      } else if (!active && !ready && nodes.some((node) => ["failed", "skipped"].includes(node.status))) {
        task.status = "failed";
      } else {
        task.status = "running";
      }
      if (task.status !== "running") task.workflow.lease = null;
      refreshParticipants(task);
      return task;
    }, {});
  }

  async #reconcile(taskId, leaseId, onEvent) {
    const task = await this.store.loadTask(taskId);
    for (const node of Object.values(task.workflow.nodes)) {
      if (!ACTIVE_NODE_STATUSES.has(node.status)) continue;
      if (node.type === "integration" && node.publicationIntent) {
        try {
          const publication = await this.workspaceManager.publishIntegration(node.publicationIntent);
          const response = node.result ?? {
            summary: `Published ${publication.branch} to ${publication.head} with ff-only integration.`,
            status: "done",
            messages: [],
            artifacts: [],
            needsUser: false
          };
          if (!node.result) {
            await this.store.submitWorkflowTurn(taskId, node.id, node.attemptToken, response);
          }
          await this.#completeNode(
            taskId,
            node.id,
            node.attemptToken,
            { response, publication, tracePath: null },
            publication.changedFiles,
            leaseId
          );
          onEvent({
            type: "workflow.node_reconciled",
            taskId,
            nodeId: node.id,
            state: "published"
          });
        } catch (error) {
          await this.#failNode(taskId, node.id, node.attemptToken, error, leaseId);
          onEvent({ type: "workflow.node_failed", taskId, nodeId: node.id, error: error.message });
        }
        continue;
      }
      if (node.result) {
        const after = await this.workspaceManager.snapshot(node.workspacePath);
        const changed = this.workspaceManager.validateChanges(node, node.baselineChanges ?? {}, after);
        await this.#completeNode(
          taskId,
          node.id,
          node.attemptToken,
          { response: node.result },
          changed,
          leaseId,
          after
        );
        continue;
      }
      if (task.workflow.runtime === "herdr" && node.binding?.agentName) {
        const inspected = await this.herdrRuntime.inspect(node.binding).catch(() => ({ state: "unknown" }));
        if (inspected.binding) {
          await this.store.updateTask(taskId, "workflow.binding_refreshed", (current) => {
            this.#assertLease(current, leaseId);
            current.workflow.nodes[node.id].binding = inspected.binding;
          }, { nodeId: node.id });
        }
        if (inspected.state === "working") {
          onEvent({ type: "workflow.node_reconciled", taskId, nodeId: node.id, state: "working" });
          continue;
        }
        if (node.resultPath) {
          const submitted = await readTurnDrop(node.resultPath, node.attemptToken, 250).catch(() => null);
          if (submitted) {
            await this.store.submitWorkflowTurn(taskId, node.id, node.attemptToken, submitted);
            const after = await this.workspaceManager.snapshot(node.workspacePath);
            const changed = this.workspaceManager.validateChanges(node, node.baselineChanges ?? {}, after);
            await this.#completeNode(
              taskId,
              node.id,
              node.attemptToken,
              { response: submitted },
              changed,
              leaseId,
              after
            );
            continue;
          }
        }
      }
      await this.store.updateTask(taskId, "workflow.node_recovered", (current) => {
        this.#assertLease(current, leaseId);
        const currentNode = current.workflow.nodes[node.id];
        currentNode.status = currentNode.attempts < currentNode.maxAttempts ? "ready" : "failed";
        currentNode.error = currentNode.status === "failed"
          ? "Interrupted attempt could not be recovered"
          : null;
        refreshParticipants(current);
      }, { nodeId: node.id });
    }
  }

  #buildPrompt(task, node, workspace, resultPath) {
    const dependencies = node.dependsOn.map((id) => task.workflow.nodes[id]);
    const dependencySummary = dependencies.length
      ? dependencies.map((dependency) => (
          `- ${dependency.id}: ${dependency.result?.summary ?? dependency.status}`
        )).join("\n")
      : "(none)";
    const agent = this.config.agents.find((entry) => entry.id === node.owner);
    const visibleMessages = task.messages
      .filter((message) => (
        message.to === "team"
        || message.to === node.owner
        || message.from === node.owner
      ))
      .slice(-this.config.collaboration.transcriptMessages);
    const transcript = visibleMessages.length
      ? visibleMessages.map((message) => (
          `[${message.sequence}] ${message.from} -> ${message.to}: ${truncate(message.body, 2000)}`
        )).join("\n")
      : "(none)";
    const resultInstructions = resultPath
      ? [
          "Completion contract:",
          `- Before ending this turn, write exactly one JSON object to: ${resultPath}`,
          `- It must include attemptToken exactly as: ${node.attemptToken}`,
          "- It must also include: summary, status, messages, artifacts, needsUser.",
          "- status must be done only when this node is fully complete; use blocked + needsUser only for a real decision blocker.",
          "- Do not merely print the JSON in chat; the file is the authoritative handoff."
        ].join("\n")
      : "Return exactly one Turn Protocol JSON object: summary, status, messages, artifacts, needsUser.";
    return [
      `You are workflow agent "${node.owner}" executing node "${node.id}" in Agent Office.`,
      "",
      "Overall objective:",
      task.objective,
      "",
      "This node:",
      node.prompt || node.role || agent?.role || "Complete the assigned node.",
      "",
      `Workspace: ${workspace}`,
      `Access: ${node.access}`,
      node.access === "write" ? `Allowed write scopes: ${node.writeScopes.join(", ")}` : "Do not modify any project file.",
      "",
      "Completed dependencies:",
      dependencySummary,
      "",
      "Relevant shared messages:",
      transcript,
      "",
      "Rules:",
      "- Inspect current files and dependency artifacts; do not assume their content.",
      "- Stay within this node and preserve unrelated work.",
      "- Run proportional verification before declaring done.",
      "- Put durable project outputs in the workspace and list them in artifacts.",
      "- Treat every other node's result-drop path as private control data; never read or modify it.",
      "- Do not commit, switch branches, edit Git configuration, or modify .git; publication belongs to the integration node.",
      "",
      resultInstructions
    ].join("\n");
  }

  #timeoutFor(node) {
    const agent = node.owner && this.config.agents.find((entry) => entry.id === node.owner);
    return agent?.timeoutMs ?? this.config.collaboration.turnTimeoutMs;
  }

  #assertWorkflow(task) {
    if (task.mode !== "workflow" || !task.workflow?.nodes) {
      throw new ConfigError(`Task ${task.id} is not a workflow task`);
    }
  }

  #assertRoster(task) {
    const configured = new Map(this.config.agents.map((agent) => [agent.id, agent]));
    for (const snapshot of task.roster ?? []) {
      const current = configured.get(snapshot.id);
      if (!current || current.adapter !== snapshot.adapter) {
        throw new ConfigError(
          `Workflow roster changed for "${snapshot.id}"; create a new workflow instead of resuming it`
        );
      }
    }
  }

  #assertAttempt(node, attemptToken) {
    if (!node || node.attemptToken !== attemptToken) {
      throw new ConfigError(`Workflow node attempt changed while it was executing`);
    }
  }

  async #acquireLease(taskId, leaseId) {
    const timeoutMs = this.config.execution.leaseTimeoutMs;
    await this.store.updateTask(taskId, "workflow.lease_acquired", (task) => {
      const lease = task.workflow.lease;
      const age = lease ? Date.now() - Date.parse(lease.heartbeatAt) : Infinity;
      if (lease && Number.isFinite(age) && age <= timeoutMs) {
        throw new ConfigError(`Workflow ${taskId} is already running under lease ${lease.id}`);
      }
      const at = nowIso();
      task.workflow.lease = { id: leaseId, acquiredAt: at, heartbeatAt: at, pid: process.pid };
    }, { leaseId });
  }

  #startLeaseHeartbeat(taskId, leaseId) {
    const intervalMs = Math.max(1_000, Math.floor(this.config.execution.leaseTimeoutMs / 3));
    let updating = false;
    const timer = setInterval(async () => {
      if (updating) return;
      updating = true;
      try {
        await this.store.updateTask(taskId, "workflow.lease_heartbeat", (task) => {
          this.#assertLease(task, leaseId);
          task.workflow.lease.heartbeatAt = nowIso();
        }, { leaseId });
      } catch {
        // The next fenced workflow mutation will surface a lost lease.
      } finally {
        updating = false;
      }
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async #reopenCancelledNode(taskId, nodeId, attemptToken, leaseId) {
    await this.store.updateTask(taskId, "workflow.node_cancelled", (task) => {
      if (leaseId) this.#assertLease(task, leaseId);
      const node = task.workflow?.nodes?.[nodeId];
      if (!node || !ACTIVE_NODE_STATUSES.has(node.status)) return;
      if (attemptToken && node.attemptToken !== attemptToken) return;
      node.status = "ready";
      if (node.attempts > 0) node.attempts -= 1;
      node.attemptToken = null;
      node.error = null;
      node.completedAt = null;
      refreshParticipants(task);
    }, { nodeId }).catch(() => {});
  }

  async #markCancelled(taskId, leaseId) {
    await this.store.updateTask(taskId, "run.cancelled", (task) => {
      if (leaseId && task.workflow.lease && task.workflow.lease.id !== leaseId) return;
      for (const node of Object.values(task.workflow.nodes ?? {})) {
        if (!ACTIVE_NODE_STATUSES.has(node.status)) continue;
        node.status = "ready";
        if (node.attempts > 0) node.attempts -= 1;
        node.attemptToken = null;
        node.error = null;
        node.completedAt = null;
      }
      if (task.status === "running") task.status = "ready";
      task.workflow.lease = null;
      refreshParticipants(task);
    }, { reason: "cancelled" }).catch(() => {});
  }

  async #releaseLease(taskId, leaseId) {
    await this.store.updateTask(taskId, "workflow.lease_released", (task) => {
      if (task.workflow.lease?.id === leaseId) task.workflow.lease = null;
    }, { leaseId }).catch(() => {});
  }

  #assertLease(task, leaseId) {
    if (task.workflow.lease?.id !== leaseId) {
      throw new ConfigError(`Workflow lease lost for ${task.id}`);
    }
  }
}

async function resolveCanonicalPath(target) {
  const absolute = path.resolve(target);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let current = absolute;
  const missing = [];
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    try {
      return path.join(await realpath(parent), ...missing.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export async function assertControlStateOutsideWorkspace(config) {
  const workspace = await resolveCanonicalPath(config.workspace);
  const stateDir = await resolveCanonicalPath(config.stateDir);
  const relative = path.relative(workspace, stateDir);
  if (!isRelativeOutside(relative)) {
    throw new ConfigError(
      "Workflow control state must live outside the executor workspace; set stateDir to an external absolute path"
    );
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new RunCancelledError("Workflow run cancelled");
  error.details = { cancelled: true };
  throw error;
}

function isCancellation(error, signal) {
  return Boolean(signal?.aborted)
    || error?.details?.cancelled === true
    || error?.name === "AbortError"
    || error instanceof RunCancelledError;
}

function changedSnapshotPaths(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((filePath) => before[filePath] !== after[filePath])
    .sort();
}

async function createTurnDrop(taskId, nodeId, attemptToken) {
  const directory = path.join(os.tmpdir(), "agent-office-turns", taskId, nodeId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${attemptToken}.json`);
  await writeFile(target, "", { flag: "wx", mode: 0o600 });
  return target;
}

async function readTurnDrop(target, expectedToken, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const raw = JSON.parse(await readFile(target, "utf8"));
      if (raw.attemptToken !== expectedToken) {
        throw new ConfigError("Turn drop has a stale or invalid attemptToken");
      }
      return raw;
    } catch (error) {
      lastError = error;
      await sleep(50);
    }
  }
  throw new ConfigError(`Agent did not produce a valid Turn Protocol file: ${truncate(lastError?.message ?? "missing", 300)}`);
}

function recordWorkflowTurn(task, node, response, tracePath, at) {
  task.turns.push({
    id: randomUUID(),
    nodeId: node.id,
    agentId: node.owner,
    at,
    summary: response.summary,
    status: response.status,
    artifacts: response.artifacts,
    tracePath: tracePath ?? null
  });
  pushMessage(task, node.owner ?? "system", "team", response.summary, at);
  const validTargets = new Set(["team", "user", ...Object.keys(task.participants)]);
  for (const message of response.messages) {
    if (validTargets.has(message.to)) pushMessage(task, node.owner ?? "system", message.to, message.body, at);
  }
}

function pushMessage(task, from, to, body, at) {
  task.messages.push({
    id: randomUUID(),
    sequence: task.nextSequence++,
    from,
    to,
    body,
    createdAt: at
  });
}

function refreshParticipants(task) {
  for (const [agentId, participant] of Object.entries(task.participants)) {
    const nodes = Object.values(task.workflow.nodes).filter((node) => node.owner === agentId);
    participant.turns = task.turns.filter((turn) => turn.agentId === agentId).length;
    const latest = task.turns.filter((turn) => turn.agentId === agentId).at(-1);
    participant.lastTurnAt = latest?.at ?? participant.lastTurnAt;
    participant.lastSummary = latest?.summary ?? participant.lastSummary;
    participant.artifacts = [...new Set(nodes.flatMap((node) => node.result?.artifacts ?? []))];
    if (nodes.some((node) => ACTIVE_NODE_STATUSES.has(node.status))) participant.status = "working";
    else if (nodes.some((node) => node.status === "blocked")) participant.status = "blocked";
    else if (nodes.some((node) => node.status === "failed")) participant.status = "failed";
    else if (nodes.length && nodes.every((node) => ["succeeded", "skipped"].includes(node.status))) participant.status = "done";
    else participant.status = "idle";
  }
}
