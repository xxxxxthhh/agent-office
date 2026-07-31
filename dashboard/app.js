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
  eventSource: null
};

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
elements.messageForm.addEventListener("submit", sendMessage);
elements.newTaskForm.addEventListener("submit", createTask);
elements.capabilityRefresh.addEventListener("click", refreshCapabilities);
document.addEventListener("keydown", handleKeyboard);

connectStream();
refreshAll();
setInterval(() => {
  renderUptime();
  refreshAll();
}, 30_000);

async function refreshAll(showFeedback = false) {
  try {
    const [health, capabilities, tasks, events] = await Promise.all([
      api("/api/health"),
      api("/api/capabilities"),
      api("/api/tasks"),
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
    if (payload.type === "turn.completed") {
      toast(`${payload.agentId} 完成本轮 · ${payload.response.status}`);
    } else if (payload.type === "turn.failed") {
      toast(`${payload.agentId} 运行失败`, "danger");
    }
    scheduleRefresh();
  });
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
}

function renderTaskList() {
  const filtered = state.tasks.filter((task) => {
    const matchesQuery = !state.query
      || task.objective.toLowerCase().includes(state.query)
      || task.id.toLowerCase().includes(state.query);
    const matchesFilter = state.filter === "all"
      || (state.filter === "active" && ["ready", "running"].includes(task.status))
      || (state.filter === "attention" && ["awaiting_input", "failed"].includes(task.status))
      || (state.filter === "completed" && task.status === "completed");
    return matchesQuery && matchesFilter;
  });
  elements.taskCount.textContent = state.tasks.length;
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
    const button = create("button", {
      className: `task-item${task.id === state.selectedTaskId ? " is-selected" : ""}`,
      attrs: { type: "button", "data-task-id": task.id }
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
  const isRunning = state.health?.runningTaskIds.includes(task.id) || task.status === "running";
  elements.runTaskButton.disabled = isRunning || task.status !== "ready";
  elements.runTaskButton.textContent = isRunning
    ? "正在协作…"
    : task.status === "completed"
      ? "任务已完成"
      : task.status === "awaiting_input"
        ? "等待输入"
        : task.status === "failed"
          ? "发送消息后重试"
        : "启动协作";

  renderAgents(task);
  renderRouting(task);
  renderConversation(task);
  renderRecipientOptions(task);
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
  elements.messageCount.textContent = `${task.messages.length} 条消息`;
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
    item.append(avatar, content);
    elements.conversation.append(item);
  }
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
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    elements.taskSearch.focus();
  } else if (!isTyping && event.key.toLowerCase() === "n") {
    event.preventDefault();
    openNewTaskDialog();
  } else if (!isTyping && event.key.toLowerCase() === "r") {
    event.preventDefault();
    refreshAll(true);
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json();
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
