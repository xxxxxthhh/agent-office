import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { AdapterError, ConfigError } from "./errors.js";
import { runProcess } from "./adapters/process.js";
import { normalizeTurnEnvelope } from "./protocol.js";
import { sleep, truncate } from "./utils.js";

export class ProcessExecutionRuntime {
  constructor({ config, store, adapters }) {
    this.config = config;
    this.store = store;
    this.adapters = adapters;
    this.jobs = new Map();
  }

  async ensureAgent() {
    return null;
  }

  async dispatch(context) {
    const { node, attemptToken } = context;
    const promise = node.type === "command"
      ? this.#runCommand(context)
      : this.#runAgent(context);
    const job = { state: "working", promise, failure: null };
    this.jobs.set(attemptToken, job);
    promise.then(
      () => this.#setJobState(attemptToken, "settled"),
      (error) => {
        // Kept for interrupt(): the only case this runtime cannot prove a stop
        // is a tree that outlived SIGKILL, and the error is where it says so.
        job.failure = error;
        this.#setJobState(attemptToken, "failed");
      }
    );
    return { id: attemptToken, kind: "process" };
  }

  async wait(handle) {
    const job = this.jobs.get(handle.id);
    if (!job) throw new ConfigError(`Unknown process runtime handle: ${handle.id}`);
    return job.promise;
  }

  async inspect(handle) {
    return { state: this.jobs.get(handle.id)?.state ?? "unknown" };
  }

  async interrupt(handle) {
    // Normally this runtime settles only once the whole process tree is gone,
    // so a rejection already proves the stop. The exception is a tree that
    // ignored SIGKILL: runProcess reports that as treeUnresponsive rather than
    // hanging forever, and claiming it stopped would release the workspace to
    // a process still able to write in it.
    const unresponsive = this.jobs.get(handle?.id)?.failure?.details?.treeUnresponsive === true;
    return {
      interrupted: false,
      settled: !unresponsive,
      reason: unresponsive
        ? "the process tree was still alive after SIGKILL"
        : "process runtime waits for process-tree termination before rejecting"
    };
  }

  async release(handle) {
    this.jobs.delete(handle.id);
  }

  async #runAgent({ node, prompt, workspace, timeoutMs, assignment, signal }) {
    const adapter = this.adapters.get(node.owner);
    if (!adapter) throw new ConfigError(`No adapter configured for workflow owner "${node.owner}"`);
    return adapter.runTurn({
      prompt,
      workspace,
      timeoutMs,
      model: assignment?.model,
      effort: assignment?.effort,
      signal
    });
  }

  async #runCommand({ node, workspace, timeoutMs, signal }) {
    const result = await runProcess({
      command: node.command,
      args: node.args,
      cwd: workspace,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ...Object.fromEntries(node.envKeys.map((key) => [key, process.env[key] ?? ""]))
      },
      inheritEnv: false,
      timeoutMs,
      signal
    });
    const tracePath = this.store.createRunPath(node.id, "command.json");
    await writeFile(tracePath, `${JSON.stringify({
      command: node.command,
      args: node.args,
      cwd: workspace,
      stdout: result.stdout,
      stderr: result.stderr
    }, null, 2)}\n`, "utf8");
    const output = result.stdout.trim() || result.stderr.trim();
    return {
      response: normalizeTurnEnvelope({
        summary: output ? `Command passed: ${truncate(output, 1200)}` : "Command passed with no output.",
        status: "done",
        messages: [],
        artifacts: [],
        needsUser: false
      }),
      tracePath,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  #setJobState(id, state) {
    const job = this.jobs.get(id);
    if (job) job.state = state;
  }
}

export class HerdrExecutionRuntime {
  constructor({ config, store }) {
    this.config = config;
    this.store = store;
    this.serverReady = false;
    this.serverPromise = null;
    this.reservedPanes = new Set();
  }

  async ensureAgent({ task, node, workspace, resultDirectory, existingBinding }) {
    if (node.type !== "agent") return null;
    await this.ensureServer();
    const agentName = makeAgentName(task.id, node.id);
    const agents = await this.#agents();
    const configured = this.config.agents.find((entry) => entry.id === node.owner);
    const kind = configured?.herdrKind ?? configured?.adapter;
    if (existingBinding?.agentName) {
      const found = agents.find((agent) => agent.name === existingBinding.agentName);
      if (found) {
        const binding = await this.#awaitStableAgent(
          existingBinding.agentName,
          existingBinding,
          kind,
          workspace
        );
        this.reservedPanes.add(binding.paneId);
        return binding;
      }
    }
    const recovered = agents.find((agent) => agent.name === agentName);
    if (recovered) {
      const binding = await this.#awaitStableAgent(agentName, null, kind, workspace);
      this.reservedPanes.add(binding.paneId);
      return binding;
    }

    const panesPayload = await this.#call(["pane", "list"]);
    const reusablePane = panesPayload.result?.panes?.find((pane) => (
      samePath(pane.foreground_cwd ?? pane.cwd, workspace)
      && [undefined, null, "unknown"].includes(pane.agent_status)
      && !this.reservedPanes.has(pane.pane_id)
    ));
    let workspaceId = reusablePane?.workspace_id ?? null;
    let paneId = reusablePane?.pane_id ?? null;
    if (!paneId) {
      const created = await this.#call([
        "workspace", "create",
        "--cwd", workspace,
        "--label", `AO ${task.id.slice(-8)} ${node.id}`,
        "--no-focus"
      ]);
      workspaceId = created.result?.workspace?.workspace_id;
      paneId = created.result?.root_pane?.pane_id;
    }
    if (!workspaceId || !paneId) {
      throw new AdapterError("Herdr workspace.create did not return workspace_id and pane_id", {
        workspaceId,
        paneId
      });
    }
    this.reservedPanes.add(paneId);

    const supported = new Set(["claude", "codex", "gemini", "cursor", "copilot", "opencode", "hermes"]);
    if (!supported.has(kind)) {
      throw new ConfigError(`Agent "${node.owner}" needs a supported herdrKind for the Herdr runtime`);
    }
    const startupTimeoutMs = Math.min(configured?.startupTimeoutMs ?? 120_000, 300_000);
    const agentArgs = [
      ...(configured?.herdrArgs ?? []),
      ...turnDropAccessArgs(kind, resultDirectory)
    ];
    const startArgs = [
      "agent", "start", agentName,
      "--kind", kind,
      "--pane", String(paneId),
      "--timeout", String(startupTimeoutMs),
      ...(agentArgs.length ? ["--", ...agentArgs] : [])
    ];
    try {
      let started;
      const shellDeadline = Date.now() + 10_000;
      while (true) {
        try {
          started = await this.#call(startArgs, startupTimeoutMs + 5_000);
          break;
        } catch (error) {
          if (!error.message.includes("is not an available shell") || Date.now() >= shellDeadline) {
            throw error;
          }
          await sleep(200);
        }
      }
      validateAndBind(started.result?.agent, null, kind, workspace);
      return await this.#awaitStableAgent(agentName, null, kind, workspace);
    } catch (error) {
      this.reservedPanes.delete(paneId);
      throw error;
    }
  }

  async dispatch({ binding, prompt, timeoutMs, attemptToken, signal = null }) {
    if (!binding?.agentName) throw new ConfigError("Herdr dispatch requires an agent binding");
    const current = await this.inspect(binding);
    if (current.binding) Object.assign(binding, current.binding);
    if (current.state === "working") {
      throw new AdapterError(`Herdr agent ${binding.agentName} is already working; refusing ambiguous prompt`);
    }
    const promptArgs = [
      "agent", "prompt", binding.agentName, prompt,
      "--wait",
      "--until", "idle",
      "--until", "done",
      "--timeout", String(timeoutMs)
    ];
    const settledPromise = this.#promptWithMissingTargetRecovery(
      binding,
      promptArgs,
      timeoutMs + 5_000,
      signal
    );
    return {
      id: attemptToken,
      kind: "herdr",
      agentName: binding.agentName,
      binding,
      timeoutMs,
      signal,
      settledPromise
    };
  }

  async wait(handle) {
    const settled = await handle.settledPromise;
    const inspected = await this.inspect(handle);
    if (inspected.binding) Object.assign(handle.binding, inspected.binding);
    return {
      response: null,
      tracePath: null,
      herdr: settled,
      state: inspected.state,
      binding: inspected.binding ?? handle.binding
    };
  }

  async inspect(handleOrBinding) {
    const expected = handleOrBinding.binding ?? handleOrBinding;
    const name = expected.agentName;
    if (!name) return { state: "unknown" };
    await this.ensureServer();
    const payload = await this.#call(["agent", "get", name]);
    const agent = payload.result?.agent ?? null;
    const binding = validateAndBind(agent, expected, expected.kind, expected.workspace);
    return { state: agentState(agent), agent, binding, response: payload };
  }

  async interrupt(handle) {
    let inspected = await this.inspect(handle).catch(() => ({ state: "unknown" }));
    if (inspected.state !== "working") {
      return { interrupted: false, settled: inspected.state !== "unknown", state: inspected.state };
    }
    await this.#call(["agent", "send-keys", handle.agentName, "ctrl+c"]).catch(() => {});
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await sleep(200);
      inspected = await this.inspect(handle).catch(() => ({ state: "unknown" }));
      if (inspected.state !== "working" && inspected.state !== "unknown") {
        return { interrupted: true, settled: true, state: inspected.state };
      }
    }
    return { interrupted: true, settled: false, state: inspected.state };
  }

  async release() {
    return { released: false, reason: "persistent Herdr agents are retained" };
  }

  async createWorktree({ cwd, path, branch, base, label }) {
    await this.ensureServer();
    return this.#call([
      "worktree", "create",
      "--cwd", cwd,
      "--path", path,
      "--branch", branch,
      "--base", base,
      "--label", label,
      "--no-focus"
    ], 120_000);
  }

  async #agents() {
    const payload = await this.#call(["agent", "list"]);
    return payload.result?.agents ?? [];
  }

  async #promptWithMissingTargetRecovery(binding, promptArgs, timeoutMs, signal = null) {
    try {
      return await this.#call(promptArgs, timeoutMs, signal);
    } catch (error) {
      if (!isMissingAgentTarget(error)) throw error;
      const refreshed = await this.#awaitStableAgent(
        binding.agentName,
        binding,
        binding.kind,
        binding.workspace
      );
      Object.assign(binding, refreshed);
      return this.#call(promptArgs, timeoutMs, signal);
    }
  }

  async #awaitStableAgent(name, existing, kind, workspace) {
    const deadline = Date.now() + 15_000;
    let lastBinding = null;
    while (Date.now() < deadline) {
      const payload = await this.#call(["agent", "get", name]).catch(() => null);
      const agent = payload?.result?.agent;
      if (agent) {
        const binding = validateAndBind(agent, existing, kind, workspace);
        if (agent.interactive_ready === true) {
          const stableIdentity = existing?.agentSession
            ? binding.agentSession
              && lastBinding?.agentSession
              && JSON.stringify(lastBinding.agentSession) === JSON.stringify(binding.agentSession)
            : lastBinding !== null;
          if (stableIdentity) {
            return binding;
          }
          lastBinding = binding;
        }
      }
      await sleep(200);
    }
    throw new AdapterError(`Herdr agent ${name} did not expose a stable interactive session`);
  }

  async ensureServer() {
    if (this.serverReady) return;
    if (this.serverPromise) return this.serverPromise;
    this.serverPromise = this.#ensureServerInner();
    try {
      await this.serverPromise;
      this.serverReady = true;
    } finally {
      this.serverPromise = null;
    }
  }

  async #ensureServerInner() {
    const status = await this.#serverStatus();
    if (serverUsable(status)) return;
    if (this.config.execution.herdrServerMode === "external") {
      throw new AdapterError(
        `Herdr session "${this.config.execution.herdrSession}" is not running; start it with: `
        + `${this.config.execution.herdrCommand} --session ${this.config.execution.herdrSession} server`
      );
    }
    await mkdir(this.store.stateDir, { recursive: true });
    const logPath = path.join(this.store.stateDir, "herdr-server.log");
    const log = await open(logPath, "a");
    let child;
    try {
      child = spawn(
        this.config.execution.herdrCommand,
        ["--session", this.config.execution.herdrSession, "server"],
        {
          cwd: this.config.workspace,
          detached: true,
          shell: false,
          env: herdrServerEnvironment(this.config.execution.herdrPathPrefixes),
          stdio: ["ignore", log.fd, log.fd]
        }
      );
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      await log.close();
    }
    await writeFile(path.join(this.store.stateDir, "herdr-server-owner.json"), `${JSON.stringify({
      pid: child.pid,
      session: this.config.execution.herdrSession,
      command: this.config.execution.herdrCommand,
      pathPrefixes: this.config.execution.herdrPathPrefixes,
      startedAt: new Date().toISOString()
    }, null, 2)}\n`, "utf8");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const current = await this.#serverStatus();
      if (serverUsable(current)) return;
    }
    throw new AdapterError(`Managed Herdr server did not become ready; inspect ${logPath}`);
  }

  async #serverStatus() {
    try {
      const result = await runProcess({
        command: this.config.execution.herdrCommand,
        args: ["--session", this.config.execution.herdrSession, "status", "server", "--json"],
        cwd: this.config.workspace,
        timeoutMs: 10_000
      });
      return parseJson(result.stdout);
    } catch (error) {
      return parseJson(error.details?.stdout) ?? parseJson(error.details?.stderr);
    }
  }

  async #call(args, timeoutMs = 30_000, signal = null) {
    let result;
    try {
      result = await runProcess({
        command: this.config.execution.herdrCommand,
        args: ["--session", this.config.execution.herdrSession, ...args],
        cwd: this.config.workspace,
        timeoutMs,
        signal
      });
    } catch (error) {
      const payload = parseJson(error.details?.stdout) ?? parseJson(error.details?.stderr);
      const message = payload?.error?.message;
      throw new AdapterError(
        message ? `Herdr ${args.slice(0, 2).join(" ")} failed: ${message}` : error.message,
        { ...error.details, herdr: payload }
      );
    }
    const payload = parseJson(result.stdout);
    if (!payload) {
      throw new AdapterError(`Herdr returned invalid JSON for ${args.slice(0, 2).join(" ")}`, {
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
    if (payload.error) {
      throw new AdapterError(`Herdr ${args.slice(0, 2).join(" ")} failed: ${payload.error.message}`, {
        herdr: payload
      });
    }
    return payload;
  }
}

function makeAgentName(taskId, nodeId) {
  const normalized = nodeId.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "-");
  const digest = createHash("sha256").update(`${taskId}\0${nodeId}`).digest("hex").slice(0, 6);
  const prefix = `ao-${taskId.slice(-6)}-`;
  const room = 32 - prefix.length - digest.length - 1;
  return `${prefix}${normalized.slice(0, room)}-${digest}`;
}

function parseJson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value.trim());
  } catch {
    return null;
  }
}

function isMissingAgentTarget(error) {
  const code = error?.details?.herdr?.error?.code;
  return code === "agent_not_found"
    || /agent target .+ not found$/i.test(error?.message ?? "");
}

function agentState(agent) {
  return agent?.agent_status ?? "unknown";
}

function validateAndBind(agent, existing, expectedKind, workspace) {
  if (!agent || agent.agent !== expectedKind || !samePath(agent.foreground_cwd ?? agent.cwd, workspace)) {
    throw new AdapterError("Herdr agent binding does not match the expected kind and workspace", {
      expectedKind,
      workspace,
      agent
    });
  }
  if (existing) {
    if (existing.workspaceId && existing.workspaceId !== agent.workspace_id) {
      throw new AdapterError("Herdr agent workspace binding changed unexpectedly");
    }
    if (existing.paneId && existing.paneId !== agent.pane_id) {
      throw new AdapterError("Herdr agent pane binding changed unexpectedly");
    }
    if (existing.agentSession) {
      if (!agent.agent_session) {
        throw new AdapterError("Herdr agent session identity is missing from a resumed binding");
      }
      if (JSON.stringify(existing.agentSession) !== JSON.stringify(agent.agent_session)) {
        throw new AdapterError("Herdr agent session identity changed unexpectedly");
      }
    }
  }
  return {
    agentName: agent.name,
    workspaceId: agent.workspace_id,
    paneId: agent.pane_id,
    terminalId: agent.terminal_id,
    agentSession: agent.agent_session ?? null,
    kind: agent.agent,
    workspace,
    state: agentState(agent)
  };
}

function turnDropAccessArgs(kind, resultDirectory) {
  if (!resultDirectory) return [];
  if (["claude", "codex"].includes(kind)) return ["--add-dir", resultDirectory];
  throw new ConfigError(
    `Herdr workflow kind "${kind}" does not have a configured secure result-drop directory argument`
  );
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function serverUsable(status) {
  return status?.running === true
    && status.compatible === true
    && Number.isInteger(status.protocol)
    && status.protocol > 0;
}

function herdrServerEnvironment(pathPrefixes = []) {
  if (!pathPrefixes.length) return process.env;
  return {
    ...process.env,
    PATH: [...pathPrefixes, process.env.PATH].filter(Boolean).join(path.delimiter)
  };
}
