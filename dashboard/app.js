const state = {
  health: null,
  capabilities: null,
  tasks: [],
  task: null,
  events: [],
  selectedTaskId: localStorage.getItem("agent-office:selected-task"),
  filter: "all",
  query: "",
  refreshTimer: null,
  eventSource: null,
  // Live turn activity, rebuilt from the orchestrator event stream.
  activity: null,
  theme: localStorage.getItem("agent-office:theme") ?? "auto"
};

const MAX_ACTIVITY_LINES = 60;

const elements = {
  connectionPill: document.querySelector("#connection-pill"),
  connectionLabel: document.querySelector("#connection-label"),
  metricTotal: document.querySelector("#metric-total"),
  metricTotalNote: document.querySelector("#metric-total-note"),
  metricActive: document.querySelector("#metric-active"),
  metricAttention: document.querySelector("#metric-attention"),
  metricTurns: document.querySelector("#metric-turns"),
  metricRunningNote: document.querySelector("#metric-running-note"),
  taskCount: document.querySelector("#task-count"),
  taskList: document.querySelector("#task-list"),
  taskSearch: document.querySelector("#task-search"),
  taskFilters: document.querySelector("#task-filters"),
  emptyState: document.querySelector("#empty-state"),
  taskContent: document.querySelector("#task-content"),
  taskStatus: document.querySelector("#task-status"),
  taskId: document.querySelector("#task-id"),
  taskUpdated: document.querySelector("#task-updated"),
  taskObjective: document.querySelector("#task-objective"),
  roundCount: document.querySelector("#round-count"),
  runTaskButton: document.querySelector("#run-task-button"),
  cancelTaskButton: document.querySelector("#cancel-task-button"),
  runHint: document.querySelector("#run-hint"),
  artifactCount: document.querySelector("#artifact-count"),
  artifactList: document.querySelector("#artifact-list"),
  diffButton: document.querySelector("#diff-button"),
  archiveButton: document.querySelector("#archive-button"),
  deleteButton: document.querySelector("#delete-button"),
  metricUsage: document.querySelector("#metric-usage"),
  metricUsageNote: document.querySelector("#metric-usage-note"),
  activityPanel: document.querySelector("#activity-panel"),
  activityAgent: document.querySelector("#activity-agent"),
  activityElapsed: document.querySelector("#activity-elapsed"),
  activityRound: document.querySelector("#activity-round"),
  activityFeed: document.querySelector("#activity-feed"),
  detailDialog: document.querySelector("#detail-dialog"),
  detailTitle: document.querySelector("#detail-title"),
  detailEyebrow: document.querySelector("#detail-eyebrow"),
  detailNote: document.querySelector("#detail-note"),
  detailBody: document.querySelector("#detail-body"),
  detailClose: document.querySelector("#detail-close"),
  themeToggle: document.querySelector("#theme-toggle"),
  themeToggleLabel: document.querySelector("#theme-toggle-label"),
  teamSummary: document.querySelector("#team-summary"),
  agentGrid: document.querySelector("#agent-grid"),
  routingSummary: document.querySelector("#routing-summary"),
  routingPlan: document.querySelector("#routing-plan"),
  messageCount: document.querySelector("#message-count"),
  conversation: document.querySelector("#conversation"),
  messageForm: document.querySelector("#message-form"),
  messageRecipient: document.querySelector("#message-recipient"),
  messageBody: document.querySelector("#message-body"),
  runtimeUptime: document.querySelector("#runtime-uptime"),
  runtimeAgents: document.querySelector("#runtime-agents"),
  runtimeRunning: document.querySelector("#runtime-running"),
  runtimeWorkspace: document.querySelector("#runtime-workspace"),
  runtimeState: document.querySelector("#runtime-state"),
  capabilitySummary: document.querySelector("#capability-summary"),
  capabilityList: document.querySelector("#capability-list"),
  capabilityRefresh: document.querySelector("#capability-refresh"),
  eventCount: document.querySelector("#event-count"),
  eventList: document.querySelector("#event-list"),
  newTaskDialog: document.querySelector("#new-task-dialog"),
  newTaskForm: document.querySelector("#new-task-form"),
  newTaskObjective: document.querySelector("#new-task-objective"),
  createTaskButton: document.querySelector("#create-task-button"),
  toastRegion: document.querySelector("#toast-region")
};

document.querySelector("#refresh-button").addEventListener("click", () => refreshAll(true));
document.querySelector("#new-task-button").addEventListener("click", openNewTaskDialog);
document.querySelector("#empty-new-task").addEventListener("click", openNewTaskDialog);
elements.taskSearch.addEventListener("input", (event) => {
  state.query = event.target.value.trim().toLowerCase();
  renderTaskList();
});
elements.taskFilters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  for (const item of elements.taskFilters.querySelectorAll("[data-filter]")) {
    item.classList.toggle("is-active", item === button);
  }
  renderTaskList();
});
elements.runTaskButton.addEventListener("click", runSelectedTask);
elements.cancelTaskButton.addEventListener("click", cancelSelectedTask);
elements.messageForm.addEventListener("submit", sendMessage);
elements.newTaskForm.addEventListener("submit", createTask);
elements.capabilityRefresh.addEventListener("click", refreshCapabilities);
elements.diffButton.addEventListener("click", showWorkspaceDiff);
elements.archiveButton.addEventListener("click", toggleArchive);
elements.deleteButton.addEventListener("click", deleteSelectedTask);
elements.detailClose.addEventListener("click", () => elements.detailDialog.close());
elements.themeToggle.addEventListener("click", cycleTheme);
document.addEventListener("keydown", handleKeyboard);

applyTheme();
connectStream();
refreshAll();
setInterval(() => {
  renderUptime();
  refreshAll();
}, 30_000);
// A turn can run for minutes, so the elapsed clock ticks independently of the
// much slower state refresh.
setInterval(renderActivity, 1000);

async function refreshAll(showFeedback = false) {
  try {
    const [health, capabilities, tasks, events] = await Promise.all([
      api("/api/health"),
      api("/api/capabilities"),
      api("/api/tasks?includeArchived=1"),
      api("/api/events?limit=80")
    ]);
    state.health = health;
    state.capabilities = capabilities;
    state.tasks = tasks;
    state.events = events;
    if (!state.selectedTaskId || !tasks.some((task) => task.id === state.selectedTaskId)) {
      state.selectedTaskId = tasks[0]?.id ?? null;
    }
    if (state.selectedTaskId) {
      state.task = await api(`/api/tasks/${state.selectedTaskId}`);
      localStorage.setItem("agent-office:selected-task", state.selectedTaskId);
    } else {
      state.task = null;
      localStorage.removeItem("agent-office:selected-task");
    }
    setConnection("connected", "实时连接");
    render();
    if (showFeedback) toast("状态已刷新");
  } catch (error) {
    setConnection("offline", "连接中断");
    if (showFeedback) toast(error.message, "danger");
  }
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => refreshAll(), 90);
}

function connectStream() {
  state.eventSource?.close();
  const source = new EventSource("/api/stream");
  state.eventSource = source;
  source.onopen = () => setConnection("connected", "实时连接");
  source.onerror = () => setConnection("offline", "正在重连");
  source.addEventListener("state", scheduleRefresh);
  source.addEventListener("orchestrator", (event) => {
    const payload = JSON.parse(event.data);
    trackActivity(payload);
    if (payload.type === "turn.completed") {
      toast(`${payload.agentId} 完成本轮 · ${payload.response.status}`);
    } else if (payload.type === "turn.failed") {
      toast(`${payload.agentId} 运行失败`, "danger");
    } else if (payload.type === "turn.cancelled") {
      toast(`${payload.agentId} 的回合已停止`, "attention");
    }
    // turn.progress arrives continuously during a turn; refreshing task state on
    // each one would hammer the API for no benefit.
    if (payload.type !== "turn.progress") scheduleRefresh();
  });
}

// Turns produce no output until they finish, so without this the UI would show
// nothing for minutes. Progress events give a live view of what the agent is
// doing right now; none of it is persisted.
function trackActivity(payload) {
  if (payload.type === "turn.started") {
    state.activity = {
      taskId: payload.taskId,
      agentId: payload.agentId,
      round: payload.round,
      startedAt: Date.now(),
      lines: []
    };
    renderActivity();
    return;
  }
  if (payload.type === "turn.progress" && state.activity?.taskId === payload.taskId) {
    state.activity.lines.push({ kind: payload.kind, detail: payload.detail, at: Date.now() });
    if (state.activity.lines.length > MAX_ACTIVITY_LINES) state.activity.lines.shift();
    renderActivity();
    return;
  }
  if (["turn.completed", "turn.failed", "turn.cancelled", "run.finished"].includes(payload.type)) {
    state.activity = null;
    renderActivity();
  }
}

function renderActivity() {
  const activity = state.activity;
  const visible = Boolean(activity) && activity.taskId === state.task?.id;
  elements.activityPanel.classList.toggle("is-hidden", !visible);
  if (!visible) return;

  elements.activityAgent.textContent = activity.agentId;
  elements.activityElapsed.textContent = formatDuration(
    Math.max(0, Math.floor((Date.now() - activity.startedAt) / 1000))
  );
  elements.activityRound.textContent = `第 ${activity.round} 轮`;

  const atBottom = elements.activityFeed.scrollHeight - elements.activityFeed.scrollTop
    - elements.activityFeed.clientHeight < 40;
  elements.activityFeed.replaceChildren();
  if (!activity.lines.length) {
    elements.activityFeed.append(create("p", {
      className: "activity-empty",
      text: "已启动，等待代理的第一条输出…"
    }));
  }
  for (const line of activity.lines) {
    const item = create("div", { className: "activity-line", attrs: { "data-kind": line.kind } });
    item.append(
      create("span", { className: "activity-kind", text: activityKindLabel(line.kind) }),
      create("span", { className: "activity-detail", text: line.detail || "…" })
    );
    elements.activityFeed.append(item);
  }
  if (atBottom) elements.activityFeed.scrollTop = elements.activityFeed.scrollHeight;
}

function activityKindLabel(kind) {
  return {
    thinking: "思考",
    tool: "工具",
    message: "输出",
    notice: "提示",
    output: "stdout",
    result: "完成"
  }[kind] ?? kind;
}

function render() {
  renderMetrics();
  renderTaskList();
  renderTask();
  renderRuntime();
  renderCapabilities();
  renderEvents();
}

function renderMetrics() {
  const metrics = state.health?.metrics;
  if (!metrics) return;
  elements.metricTotal.textContent = metrics.totalTasks;
  elements.metricTotalNote.textContent = `${metrics.statusCounts.completed ?? 0} 个已完成`;
  elements.metricActive.textContent = metrics.activeTasks;
  elements.metricAttention.textContent = metrics.attentionTasks;
  elements.metricTurns.textContent = metrics.totalTurns;
  elements.metricRunningNote.textContent = metrics.runningAgents
    ? `${metrics.runningAgents} 位代理处于工作状态`
    : "当前无运行代理";
  renderUsageMetric(metrics.usage);
}

function renderUsageMetric(usage) {
  if (!usage?.turnsWithUsage) {
    elements.metricUsage.textContent = "—";
    elements.metricUsageNote.textContent = "尚无用量数据";
    return;
  }
  elements.metricUsage.textContent = formatTokens(usage.inputTokens + usage.outputTokens);
  elements.metricUsageNote.textContent = usageCostNote(usage);
}

// Codex reports tokens but never a dollar amount, so a total is labelled partial
// rather than presented as the full spend.
function usageCostNote(usage) {
  if (usage.costUsd === null) return "tokens · 该提供方不报告费用";
  const cost = `$${usage.costUsd.toFixed(4)}`;
  return usage.costIsPartial ? `${cost}（部分回合不报告费用）` : cost;
}

function formatTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function renderTaskList() {
  const filtered = state.tasks.filter((task) => {
    const matchesQuery = !state.query
      || task.objective.toLowerCase().includes(state.query)
      || task.id.toLowerCase().includes(state.query);
    // Archived tasks stay out of every other view so the queue reflects live work.
    if (task.archived && state.filter !== "archived") return false;
    const matchesFilter = state.filter === "all"
      || (state.filter === "active" && ["ready", "running"].includes(task.status))
      || (state.filter === "attention" && ["awaiting_input", "failed"].includes(task.status))
      || (state.filter === "completed" && task.status === "completed")
      || (state.filter === "archived" && task.archived);
    return matchesQuery && matchesFilter;
  });
  elements.taskCount.textContent = state.tasks.length;
  // Rebuilding the list destroys the focused row, which would drop keyboard
  // navigation back to the body on every arrow press.
  const focusedTaskId = elements.taskList.contains(document.activeElement)
    ? document.activeElement.dataset.taskId
    : null;
  elements.taskList.replaceChildren();
  if (!filtered.length) {
    elements.taskList.append(
      create("p", { className: "task-list-empty", text: state.tasks.length
        ? "当前筛选没有匹配任务"
        : "还没有任务" })
    );
    return;
  }

  for (const task of filtered) {
    const isSelected = task.id === state.selectedTaskId;
    const button = create("button", {
      className: `task-item${isSelected ? " is-selected" : ""}`,
      attrs: {
        type: "button",
        "data-task-id": task.id,
        role: "option",
        "aria-selected": String(isSelected),
        // Roving tabindex: only the selected row is in the tab order, and the
        // arrow keys move between rows.
        tabindex: isSelected ? "0" : "-1"
      }
    });
    const top = create("div", { className: "task-item-top" });
    top.append(
      statusChip(task.status),
      create("span", { className: "task-item-id", text: shortTaskId(task.id) })
    );
    const footer = create("div", { className: "task-item-footer" });
    footer.append(
      create("span", { text: `${task.turnCount} 回合` }),
      create("span", { text: relativeTime(task.updatedAt) })
    );
    button.append(
      top,
      create("p", { className: "task-item-objective", text: task.objective }),
      footer
    );
    button.addEventListener("click", () => selectTask(task.id));
    elements.taskList.append(button);
  }

  if (focusedTaskId) {
    const restored = elements.taskList.querySelector(`[data-task-id="${focusedTaskId}"]`);
    restored?.focus();
  }
}

function renderTask() {
  const task = state.task;
  elements.emptyState.classList.toggle("is-hidden", Boolean(task));
  elements.taskContent.classList.toggle("is-hidden", !task);
  if (!task) return;

  setStatusChip(elements.taskStatus, task.status);
  elements.taskId.textContent = task.id;
  elements.taskUpdated.textContent = `更新于 ${relativeTime(task.updatedAt)}`;
  elements.taskObjective.textContent = task.objective;
  renderRunControls(task);
  renderAgents(task);
  renderRouting(task);
  renderArtifacts(task);
  renderConversation(task);
  renderRecipientOptions(task);
  renderActivity();
  elements.archiveButton.textContent = task.archived ? "取消归档" : "归档";
}

function renderRunControls(task) {
  const activeRun = state.health?.activeRuns?.[task.id] ?? null;
  // A task left in `running` with no live run is the residue of a crashed or
  // killed process, and must stay resumable rather than locked forever.
  const isStale = state.health?.staleRunTaskIds?.includes(task.id) ?? false;
  const canRun = !activeRun && (task.status === "ready" || isStale);

  elements.runTaskButton.disabled = !canRun;
  elements.runTaskButton.textContent = activeRun
    ? "正在协作…"
    : isStale
      ? "恢复运行"
      : task.status === "completed"
        ? "任务已完成"
        : task.status === "awaiting_input"
          ? "等待输入"
          : task.status === "failed"
            ? "发送消息后重试"
            : "启动协作";

  elements.cancelTaskButton.classList.toggle("is-hidden", !activeRun);
  elements.cancelTaskButton.disabled = !activeRun?.cancellable;
  elements.cancelTaskButton.title = activeRun && !activeRun.cancellable
    ? `这次运行由 ${activeRun.host} 上的进程 ${activeRun.pid} 启动，请在启动它的终端里停止。`
    : "停止当前回合并保留任务进度";

  const hint = activeRun
    ? `运行中 · 进程 ${activeRun.pid}@${activeRun.host} · 开始于 ${relativeTime(activeRun.startedAt)}`
    : isStale
      ? "上一次运行没有正常结束（进程已退出）。任务进度已保留，可以直接恢复运行。"
      : "";
  elements.runHint.textContent = hint;
  elements.runHint.classList.toggle("is-hidden", !hint);
  elements.runHint.dataset.tone = isStale && !activeRun ? "attention" : "neutral";
}

function renderArtifacts(task) {
  const artifacts = collectArtifacts(task);
  elements.artifactCount.textContent = artifacts.length
    ? `${artifacts.length} 个文件`
    : "尚无产物";
  elements.artifactList.replaceChildren();
  if (!artifacts.length) {
    elements.artifactList.append(create("p", {
      className: "task-list-empty compact-empty",
      text: "代理报告的工作区文件会出现在这里。"
    }));
    return;
  }
  for (const artifact of artifacts) {
    const item = create("article", { className: "artifact-item" });
    const meta = create("div", { className: "artifact-meta" });
    meta.append(
      create("span", { text: artifact.agents.join(" · ") }),
      create("span", { text: artifact.at ? relativeTime(artifact.at) : "—" })
    );
    item.append(
      create("code", { className: "artifact-path", text: artifact.path, attrs: { title: artifact.path } }),
      meta
    );
    elements.artifactList.append(item);
  }
}

// Turns carry both the reporting agent and a timestamp; participant lists are
// folded in so artifacts recorded before a turn was stored are not lost.
function collectArtifacts(task) {
  const byPath = new Map();
  const touch = (rawPath, agentId, at) => {
    const path = String(rawPath);
    const entry = byPath.get(path) ?? { path, agents: new Set(), at: null };
    entry.agents.add(agentId);
    if (at && (!entry.at || at > entry.at)) entry.at = at;
    byPath.set(path, entry);
  };
  for (const turn of task.turns ?? []) {
    for (const artifact of turn.artifacts ?? []) touch(artifact, turn.agentId, turn.at);
  }
  for (const [agentId, participant] of Object.entries(task.participants)) {
    for (const artifact of participant.artifacts ?? []) touch(artifact, agentId, null);
  }
  return [...byPath.values()]
    .map((entry) => ({ ...entry, agents: [...entry.agents] }))
    .sort((left, right) => (right.at ?? "").localeCompare(left.at ?? "")
      || left.path.localeCompare(right.path));
}

function renderAgents(task) {
  const entries = Object.entries(task.participants);
  const doneCount = entries.filter(([, participant]) => participant.status === "done").length;
  elements.teamSummary.textContent = `${doneCount}/${entries.length} 已完成当前职责`;
  elements.agentGrid.replaceChildren();
  const definitions = new Map((state.health?.agents ?? []).map((agent) => [agent.id, agent]));

  for (const [agentId, participant] of entries) {
    const definition = definitions.get(agentId);
    const assignment = participant.assignment
      ?? task.routing?.assignments?.find((item) => item.agentId === agentId);
    const card = create("article", { className: "agent-card" });
    const header = create("div", { className: "agent-card-header" });
    const nameWrap = create("div", { className: "agent-name-wrap" });
    nameWrap.append(
      create("span", { className: "agent-avatar", text: initials(agentId) }),
      create("span", { className: "agent-name", text: agentId })
    );
    header.append(nameWrap, statusChip(participant.status));
    const footer = create("div", { className: "agent-footer" });
    footer.append(
      create("span", { text: `${participant.turns} 回合` }),
      create("span", { text: participant.lastTurnAt ? relativeTime(participant.lastTurnAt) : "尚未启动" })
    );
    card.append(header);
    if (assignment) {
      const modelLine = create("div", { className: "agent-model-line" });
      modelLine.append(
        create("span", {
          className: "model-badge",
          text: assignment.modelLabel ?? assignment.model ?? "默认模型"
        }),
        create("span", {
          className: "effort-badge",
          text: assignment.effort ?? "default"
        }),
        create("span", {
          className: "score-badge",
          text: assignment.score === null || assignment.score === undefined
            ? "配置"
            : `${assignment.score} 分`
        })
      );
      card.append(modelLine);
    }
    if (participant.lastFailure) {
      const failure = create("div", { className: "agent-failure" });
      failure.append(create("strong", { text: failureHeadline(participant.lastFailure) }));
      const cause = firstLine(participant.lastFailure.stderr);
      if (cause) failure.append(create("code", { text: cause }));
      card.append(failure);
    }
    card.append(
      create("p", { className: "agent-role", text: definition?.role ?? "协作代理" }),
      assignment?.reasons?.length
        ? create("p", { className: "routing-reason", text: assignment.reasons.join(" ") })
        : create("span", { className: "is-hidden" }),
      create("p", {
        className: "agent-summary",
        text: participant.lastSummary ?? "等待第一次输出…"
      }),
      footer
    );
    elements.agentGrid.append(card);
  }
}

function renderRouting(task) {
  const routing = task.routing;
  elements.routingPlan.replaceChildren();
  if (!routing?.assignments?.length) {
    elements.routingSummary.textContent = "旧任务 · 固定配置";
    elements.routingPlan.append(create("p", {
      className: "task-list-empty compact-empty",
      text: "这个任务创建于能力路由启用之前。"
    }));
    return;
  }

  elements.routingSummary.textContent = `${routing.profile.kinds.join(" · ")} · ${routing.profile.complexity}`;
  for (const assignment of routing.assignments) {
    const item = create("article", { className: "route-item" });
    const order = create("span", { className: "route-order", text: assignment.order });
    const body = create("div", { className: "route-body" });
    const title = create("div", { className: "route-title" });
    title.append(
      create("strong", { text: assignment.agentId }),
      create("span", { text: assignment.modelLabel ?? assignment.model ?? "Provider default" })
    );
    body.append(
      title,
      create("p", {
        text: `${assignment.effort ?? "default"} 推理 · `
          + `${assignment.score ?? "配置"} 匹配分 · `
          + `${assignment.missingTools?.length ? `缺少 ${assignment.missingTools.join(", ")}` : "工具满足"}`
      })
    );
    item.append(order, body);
    elements.routingPlan.append(item);
  }
}

function renderConversation(task) {
  const usage = task.usage ?? sumTurnUsage(task.turns);
  elements.messageCount.textContent = usage.turnsWithUsage
    ? `${task.messages.length} 条消息 · ${formatTokens(usage.inputTokens + usage.outputTokens)} tokens · ${usageCostNote(usage)}`
    : `${task.messages.length} 条消息`;
  elements.conversation.replaceChildren();
  const visibleMessages = task.messages.slice(-80);
  for (const message of visibleMessages) {
    const item = create("article", {
      className: "message",
      attrs: { "data-from": message.from }
    });
    const avatar = create("span", {
      className: "message-avatar",
      text: message.from === "user" ? "YOU" : initials(message.from)
    });
    const content = create("div");
    const header = create("div", { className: "message-header" });
    header.append(
      create("strong", { text: message.from }),
      create("span", { text: `→ ${message.to}` }),
      create("span", { text: relativeTime(message.createdAt) })
    );
    content.append(
      header,
      create("p", { className: "message-body", text: message.body })
    );
    // The turn that produced this summary carries the raw provider output.
    const turn = task.turns.find(
      (candidate) => candidate.agentId === message.from && candidate.summary === message.body
    );
    if (turn?.tracePath) {
      const trace = create("button", {
        className: "link-button",
        text: "查看原始输出",
        attrs: { type: "button" }
      });
      trace.addEventListener("click", () => showTrace(task.id, turn));
      content.append(trace);
    }
    item.append(avatar, content);
    elements.conversation.append(item);
  }
  elements.conversation.scrollTop = elements.conversation.scrollHeight;
}

function sumTurnUsage(turns) {
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    costIsPartial: false,
    turnsWithUsage: 0
  };
  let sawCost = false;
  for (const turn of turns ?? []) {
    if (!turn.usage) continue;
    total.turnsWithUsage += 1;
    total.inputTokens += turn.usage.inputTokens ?? 0;
    total.outputTokens += turn.usage.outputTokens ?? 0;
    if (typeof turn.usage.costUsd === "number") {
      sawCost = true;
      total.costUsd = (total.costUsd ?? 0) + turn.usage.costUsd;
    } else {
      total.costIsPartial = true;
    }
  }
  if (!sawCost) {
    total.costUsd = null;
    total.costIsPartial = false;
  }
  return total;
}

function renderRecipientOptions(task) {
  const previous = elements.messageRecipient.value;
  elements.messageRecipient.replaceChildren(
    create("option", { text: "全体团队", attrs: { value: "team" } })
  );
  for (const agentId of Object.keys(task.participants)) {
    elements.messageRecipient.append(
      create("option", { text: agentId, attrs: { value: agentId } })
    );
  }
  if ([...elements.messageRecipient.options].some((option) => option.value === previous)) {
    elements.messageRecipient.value = previous;
  }
}

function renderRuntime() {
  const health = state.health;
  if (!health) return;
  renderUptime();
  elements.runtimeAgents.textContent = health.agents.length;
  elements.runtimeRunning.textContent = health.runningTaskIds.length || "0";
  elements.runtimeWorkspace.textContent = health.workspace;
  elements.runtimeWorkspace.title = health.workspace;
  elements.runtimeState.textContent = health.stateDir;
  elements.runtimeState.title = health.stateDir;
}

function renderCapabilities() {
  const inventory = state.capabilities;
  elements.capabilityList.replaceChildren();
  if (!inventory) {
    elements.capabilitySummary.textContent = "等待探测…";
    return;
  }
  elements.capabilitySummary.textContent = [
    `${inventory.totals.availableAgents}/${inventory.totals.agents} 个可用代理`,
    `${inventory.totals.routableModels}/${inventory.totals.models} 个可路由模型`,
    `${inventory.totals.availableTools}/${inventory.totals.tools} 项可用工具`
  ].join(" · ");

  for (const agent of inventory.agents) {
    const item = create("article", { className: "capability-agent" });
    const header = create("div", { className: "capability-agent-header" });
    header.append(
      create("strong", { text: agent.id }),
      create("span", {
        className: `availability${agent.available ? " is-available" : ""}`,
        text: agent.available ? "可用" : "不可用"
      })
    );
    const models = create("div", { className: "capability-tags" });
    for (const model of agent.models.slice(0, 8)) {
      models.append(create("span", {
        className: "capability-tag model-tag",
        text: model.label,
        attrs: {
          title: `${model.description} · ${model.availability} · `
            + `${model.routable === false ? "仅展示" : "可路由"}`
        }
      }));
    }
    const tools = create("div", { className: "capability-tags" });
    for (const itemTool of agent.tools.filter((entry) => entry.available).slice(0, 10)) {
      tools.append(create("span", {
        className: "capability-tag",
        text: itemTool.label,
        attrs: { title: `${itemTool.kind}: ${itemTool.id}` }
      }));
    }
    item.append(
      header,
      create("p", { className: "capability-version", text: agent.version }),
      models,
      tools
    );
    elements.capabilityList.append(item);
  }
}

async function refreshCapabilities() {
  elements.capabilityRefresh.disabled = true;
  try {
    state.capabilities = await api("/api/capabilities/refresh", {
      method: "POST",
      body: {}
    });
    renderCapabilities();
    toast("模型与工具已重新探测");
  } catch (error) {
    toast(error.message, "danger");
  } finally {
    elements.capabilityRefresh.disabled = false;
  }
}

function renderUptime() {
  if (!state.health) return;
  const elapsed = state.health.uptimeSeconds + Math.floor(
    (Date.now() - new Date(state.health.serverTime).getTime()) / 1000
  );
  elements.runtimeUptime.textContent = formatDuration(Math.max(0, elapsed));
}

function renderEvents() {
  elements.eventCount.textContent = state.events.length;
  elements.eventList.replaceChildren();
  if (!state.events.length) {
    elements.eventList.append(create("p", {
      className: "task-list-empty",
      text: "创建任务后会出现事件"
    }));
    return;
  }
  for (const event of state.events) {
    const item = create("article", {
      className: "event-item",
      attrs: { "data-tone": eventTone(event.type) }
    });
    const meta = create("div", { className: "event-meta" });
    meta.append(
      create("span", { text: shortTaskId(event.taskId) }),
      create("span", { text: relativeTime(event.at) })
    );
    item.append(
      create("p", { className: "event-type", text: event.type }),
      meta
    );
    elements.eventList.append(item);
  }
}

async function selectTask(taskId) {
  state.selectedTaskId = taskId;
  localStorage.setItem("agent-office:selected-task", taskId);
  try {
    state.task = await api(`/api/tasks/${taskId}`);
    renderTaskList();
    renderTask();
  } catch (error) {
    toast(error.message, "danger");
  }
}

async function runSelectedTask() {
  if (!state.task) return;
  elements.runTaskButton.disabled = true;
  elements.runTaskButton.textContent = "正在启动…";
  try {
    await api(`/api/tasks/${state.task.id}/run`, {
      method: "POST",
      body: {
        maxRounds: Number(elements.roundCount.value)
      }
    });
    toast("协作已启动");
    scheduleRefresh();
  } catch (error) {
    toast(error.message, "danger");
    renderTask();
  }
}

async function cancelSelectedTask() {
  if (!state.task) return;
  elements.cancelTaskButton.disabled = true;
  try {
    await api(`/api/tasks/${state.task.id}/cancel`, { method: "POST", body: {} });
    toast("正在停止当前回合…");
    scheduleRefresh();
  } catch (error) {
    toast(error.message, "danger");
    renderTask();
  }
}

async function showTrace(taskId, turn) {
  try {
    const trace = await api(`/api/tasks/${taskId}/turns/${turn.id}/trace`);
    openDetail({
      eyebrow: "RAW PROVIDER OUTPUT",
      title: `${trace.agentId} 的原始输出`,
      note: `${formatBytes(trace.bytes)}${trace.truncated ? " · 已截断显示" : ""} · ${turn.tracePath}`,
      body: trace.contents
    });
  } catch (error) {
    toast(error.message, "danger");
  }
}

async function showWorkspaceDiff() {
  if (!state.task) return;
  elements.diffButton.disabled = true;
  try {
    const diff = await api(`/api/tasks/${state.task.id}/diff`);
    if (!diff.available) {
      openDetail({
        eyebrow: "WORKSPACE DIFF",
        title: "无法生成工作区改动",
        note: diff.reason,
        body: "Agent Office 不要求工作区是 git 仓库；改动视图只在它是 git 仓库时可用。"
      });
      return;
    }
    const scoped = diff.scope === "task";
    const body = [
      scoped
        ? `本任务期间变化的文件（${diff.changedDuringTask.length}）：\n`
          + (diff.changedDuringTask.join("\n") || "(无)")
        : "该任务尚未运行过，没有基线，以下为整个工作区的当前改动。",
      "",
      // Named explicitly so pre-task edits are never read as the task's work.
      scoped && diff.preexisting.length
        ? `任务开始前就已修改、至今未被改动（${diff.preexisting.length}）：\n${diff.preexisting.join("\n")}`
        : "",
      "",
      diff.stat || "(没有相对基线的改动)",
      "",
      diff.patch || "(没有可显示的补丁)"
    ].filter((part) => part !== "").join("\n");
    openDetail({
      eyebrow: "WORKSPACE DIFF",
      title: scoped ? "本任务的工作区改动" : "工作区当前改动（全局）",
      note: scoped
        ? `基线 ${String(diff.baseline?.head ?? "无提交").slice(0, 12)} · `
          + `记录于 ${relativeTime(diff.baseline?.capturedAt)}`
          + `${diff.truncated ? " · 补丁已截断" : ""}`
        : `相对 HEAD${diff.truncated ? " · 补丁已截断" : ""}`,
      body
    });
  } catch (error) {
    toast(error.message, "danger");
  } finally {
    elements.diffButton.disabled = false;
  }
}

async function toggleArchive() {
  if (!state.task) return;
  const archived = !state.task.archived;
  elements.archiveButton.disabled = true;
  try {
    await api(`/api/tasks/${state.task.id}/archive`, { method: "POST", body: { archived } });
    toast(archived ? "任务已归档" : "任务已取消归档");
    await refreshAll();
  } catch (error) {
    toast(error.message, "danger");
  } finally {
    elements.archiveButton.disabled = false;
  }
}

async function deleteSelectedTask() {
  const task = state.task;
  if (!task) return;
  // Deleting a snapshot is irreversible, so it always requires confirmation.
  const confirmed = window.confirm(
    `永久删除 ${task.id}？\n\n`
    + `目标：${task.objective.slice(0, 120)}\n`
    + `包含 ${task.turns.length} 个回合、${task.messages.length} 条消息。\n\n`
    + "此操作不可撤销。如果只是想让它从列表里消失，请改用“归档”。"
  );
  if (!confirmed) return;
  elements.deleteButton.disabled = true;
  try {
    await api(`/api/tasks/${task.id}`, { method: "DELETE" });
    state.selectedTaskId = null;
    state.task = null;
    toast("任务已删除");
    await refreshAll();
  } catch (error) {
    toast(error.message, "danger");
  } finally {
    elements.deleteButton.disabled = false;
  }
}

function openDetail({ eyebrow, title, note, body }) {
  elements.detailEyebrow.textContent = eyebrow;
  elements.detailTitle.textContent = title;
  elements.detailNote.textContent = note ?? "";
  elements.detailBody.textContent = body ?? "";
  elements.detailDialog.showModal();
  elements.detailBody.focus();
}

function cycleTheme() {
  state.theme = { auto: "dark", dark: "light", light: "auto" }[state.theme] ?? "auto";
  localStorage.setItem("agent-office:theme", state.theme);
  applyTheme();
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  elements.themeToggleLabel.textContent = { auto: "跟随系统", dark: "深色", light: "浅色" }[state.theme];
  elements.themeToggle.setAttribute("aria-label", `主题：${elements.themeToggleLabel.textContent}，点击切换`);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function firstLine(value) {
  return String(value ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function failureHeadline(failure) {
  if (failure.timedOut) return "回合超时";
  if (failure.exitCode !== undefined && failure.exitCode !== null) {
    return `失败 · 退出码 ${failure.exitCode}`;
  }
  return "失败";
}

async function sendMessage(event) {
  event.preventDefault();
  if (!state.task) return;
  const body = elements.messageBody.value.trim();
  if (!body) return;
  const submit = elements.messageForm.querySelector("button[type='submit']");
  submit.disabled = true;
  try {
    await api(`/api/tasks/${state.task.id}/messages`, {
      method: "POST",
      body: {
        to: elements.messageRecipient.value,
        body
      }
    });
    elements.messageBody.value = "";
    toast("消息已发送");
    await refreshAll();
  } catch (error) {
    toast(error.message, "danger");
  } finally {
    submit.disabled = false;
  }
}

function openNewTaskDialog() {
  elements.newTaskForm.reset();
  elements.newTaskDialog.showModal();
  setTimeout(() => elements.newTaskObjective.focus(), 0);
}

async function createTask(event) {
  event.preventDefault();
  const submitter = event.submitter;
  if (submitter?.value === "cancel") {
    elements.newTaskDialog.close();
    return;
  }
  const objective = elements.newTaskObjective.value.trim();
  if (!objective) return;
  elements.createTaskButton.disabled = true;
  try {
    const task = await api("/api/tasks", {
      method: "POST",
      body: { objective }
    });
    state.selectedTaskId = task.id;
    elements.newTaskDialog.close();
    const assignment = task.routing?.assignments
      ?.map((item) => `${item.agentId}→${item.modelLabel ?? item.model ?? "默认模型"}`)
      .join("，");
    toast(assignment ? `已按能力分配：${assignment}` : "任务已创建");
    await refreshAll();
  } catch (error) {
    toast(error.message, "danger");
  } finally {
    elements.createTaskButton.disabled = false;
  }
}

function handleKeyboard(event) {
  const isTyping = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  const inTaskList = elements.taskList.contains(document.activeElement);

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    focusTaskList();
    return;
  }
  if (inTaskList && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    moveTaskSelection(event.key);
    return;
  }
  if (isTyping) return;
  if (event.key.toLowerCase() === "n") {
    event.preventDefault();
    openNewTaskDialog();
  } else if (event.key.toLowerCase() === "r") {
    event.preventDefault();
    refreshAll(true);
  } else if (event.key === "/") {
    event.preventDefault();
    elements.taskSearch.focus();
  }
}

function focusTaskList() {
  const selected = elements.taskList.querySelector(".task-item.is-selected")
    ?? elements.taskList.querySelector(".task-item");
  if (selected) selected.focus();
  else elements.taskSearch.focus();
}

function moveTaskSelection(key) {
  const items = [...elements.taskList.querySelectorAll(".task-item")];
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  const next = {
    ArrowDown: Math.min(items.length - 1, current + 1),
    ArrowUp: Math.max(0, current - 1),
    Home: 0,
    End: items.length - 1
  }[key];
  const target = items[next] ?? items[0];
  target.focus();
  selectTask(target.dataset.taskId);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

function create(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  return node;
}

function statusChip(status) {
  const chip = create("span", { className: "status-chip" });
  setStatusChip(chip, status);
  return chip;
}

function setStatusChip(chip, status) {
  chip.dataset.status = status;
  chip.textContent = statusLabel(status);
}

function statusLabel(status) {
  return {
    ready: "待启动",
    running: "运行中",
    completed: "已完成",
    awaiting_input: "等待输入",
    failed: "失败",
    idle: "空闲",
    working: "工作中",
    blocked: "受阻",
    done: "完成"
  }[status] ?? status;
}

function eventTone(type) {
  if (type.includes("failed")) return "danger";
  if (type.includes("completed") || type.includes("created")) return "success";
  if (type.includes("stalled") || type.includes("paused")) return "attention";
  return "neutral";
}

function initials(value) {
  return value.split(/[-_\s]+/).map((part) => part[0]).join("").slice(0, 3).toUpperCase();
}

function shortTaskId(taskId) {
  return taskId ? taskId.replace(/^task-\d{8}-/, "#") : "—";
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function setConnection(status, label) {
  elements.connectionPill.dataset.state = status;
  elements.connectionLabel.textContent = label;
}

function toast(message, tone = "neutral") {
  const item = create("div", {
    className: "toast",
    text: message,
    attrs: { "data-tone": tone }
  });
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), 3600);
}
