import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const session = sessionIndex >= 0 ? args[sessionIndex + 1] : null;
if (sessionIndex >= 0) args.splice(sessionIndex, 2);
const statePath = process.env.FAKE_HERDR_STATE ?? path.join(process.cwd(), ".fake-herdr.json");
const state = readState();
state.calls.push({ session, args });

if (args[0] === "status" && args[1] === "server") {
  output({
    status: "running",
    running: true,
    compatible: true,
    protocol: 19,
    version: "0.8.0",
    session
  });
} else if (args[0] === "agent" && args[1] === "list") {
  envelope("agent_list", { agents: state.agents });
} else if (args[0] === "pane" && args[1] === "list") {
  envelope("pane_list", { panes: state.panes });
} else if (args[0] === "workspace" && args[1] === "create") {
  const workspaceId = `w${state.nextWorkspace++}`;
  const paneId = `${workspaceId}:p1`;
  const cwd = option("--cwd");
  const pane = paneInfo(workspaceId, paneId, cwd);
  state.panes.push(pane);
  save();
  envelope("workspace_created", {
    workspace: { workspace_id: workspaceId, label: option("--label"), pane_count: 1 },
    tab: { tab_id: `${workspaceId}:t1`, workspace_id: workspaceId },
    root_pane: pane
  });
} else if (args[0] === "agent" && args[1] === "start") {
  if (process.env.FAKE_HERDR_START_TRANSIENT === "1" && !state.shellRetryDone) {
    state.shellRetryDone = true;
    save();
    process.stderr.write(`${JSON.stringify({
      id: "fake",
      error: { code: "pane_not_shell", message: `agent target pane ${option("--pane")} is not an available shell` }
    })}\n`);
    process.exit(1);
  }
  const name = args[2];
  const kind = option("--kind");
  const paneId = option("--pane");
  const pane = state.panes.find((entry) => entry.pane_id === paneId);
  const agent = agentInfo(name, kind, pane);
  state.agents.push(agent);
  pane.agent_status = "idle";
  save();
  envelope("agent_started", { argv: [kind], agent });
} else if (args[0] === "agent" && args[1] === "get") {
  const agent = state.agents.find((entry) => entry.name === args[2]);
  if (!agent) fail("agent_not_found", `missing ${args[2]}`);
  envelope("agent_info", { agent });
} else if (args[0] === "agent" && args[1] === "prompt") {
  const agent = state.agents.find((entry) => entry.name === args[2]);
  if (!agent) fail("agent_not_found", `missing ${args[2]}`);
  if (process.env.FAKE_HERDR_PROMPT_TRANSIENT === "1" && !state.promptRetryDone) {
    state.promptRetryDone = true;
    save();
    fail("agent_not_found", `agent target ${args[2]} not found`);
  }
  const prompt = args[3] ?? "";
  const resultPath = prompt.match(/write exactly one JSON object to: (.+)/)?.[1]?.trim();
  const attemptToken = prompt.match(/attemptToken exactly as: ([^\s]+)/)?.[1];
  if (resultPath && attemptToken) {
    fs.writeFileSync(resultPath, `${JSON.stringify({
      attemptToken,
      summary: "Fake Herdr agent completed the assigned node.",
      status: "done",
      messages: [],
      artifacts: [],
      needsUser: false
    })}\n`);
  }
  agent.agent_status = "done";
  save();
  envelope("agent_prompted", { agent });
} else if (args[0] === "agent" && args[1] === "send-keys") {
  envelope("agent_info", { agent: state.agents.find((entry) => entry.name === args[2]) });
} else if (args[0] === "worktree" && args[1] === "create") {
  const workspaceId = `w${state.nextWorkspace++}`;
  const paneId = `${workspaceId}:p1`;
  const cwd = option("--path");
  const pane = paneInfo(workspaceId, paneId, cwd);
  state.panes.push(pane);
  save();
  envelope("worktree_created", {
    workspace: { workspace_id: workspaceId, worktree: { checkout_path: cwd } },
    root_pane: pane,
    worktree: { path: cwd, branch: option("--branch"), open_workspace_id: workspaceId }
  });
} else {
  fail("unsupported", args.join(" "));
}

function paneInfo(workspaceId, paneId, cwd) {
  return {
    pane_id: paneId,
    terminal_id: `term-${paneId}`,
    workspace_id: workspaceId,
    tab_id: `${workspaceId}:t1`,
    cwd,
    foreground_cwd: cwd,
    agent_status: "unknown"
  };
}

function agentInfo(name, kind, pane) {
  return {
    name,
    agent: kind,
    agent_status: "idle",
    interactive_ready: true,
    cwd: pane.cwd,
    foreground_cwd: pane.cwd,
    pane_id: pane.pane_id,
    workspace_id: pane.workspace_id,
    tab_id: pane.tab_id,
    terminal_id: pane.terminal_id,
    agent_session: { source: `herdr:${kind}`, agent: kind, kind: "id", value: `session-${name}` }
  };
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { nextWorkspace: 1, agents: [], panes: [], calls: [] };
  }
}

function save() {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function envelope(type, result) {
  save();
  output({ id: `cli:${args[0]}:${args[1]}`, result: { type, ...result } });
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code, message) {
  save();
  process.stderr.write(`${JSON.stringify({ id: "fake", error: { code, message } })}\n`);
  process.exit(1);
}
