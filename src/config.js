import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { ConfigError } from "./errors.js";
import { assertNonEmptyString, exists, resolveFrom } from "./utils.js";

export const DEFAULT_CONFIG_NAME = "agent-office.json";

function defaultRealpathSync(target) {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

// Workflows refuse to run while control state sits where an executing agent
// could rewrite it, so a generated config keeps state outside the workspace
// entirely. The digest keeps two projects with the same directory name apart.
export function starterStateDir(workspace, { realpathSync = defaultRealpathSync } = {}) {
  // Hash the canonical path so the same repository reached through a symlink
  // does not get a second, unrelated state directory.
  const canonical = realpathSync(path.resolve(workspace));
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  const leaf = path.join("agent-office", `${path.basename(canonical) || "workspace"}-${digest}`);
  const home = path.join(os.homedir(), ".local", "state");
  const configured = process.env.XDG_STATE_HOME ? path.resolve(process.env.XDG_STATE_HOME) : null;
  // An XDG_STATE_HOME pointing inside the workspace would generate exactly the
  // configuration workflows reject, so it is not honoured for this.
  if (configured && !isInside(canonical, configured)) return path.join(configured, leaf);
  if (!isInside(canonical, home)) return path.join(home, leaf);
  throw new ConfigError(
    `Cannot place control state outside ${canonical}: both the home state directory and `
    + "XDG_STATE_HOME resolve inside it. Set stateDir to an absolute path outside the workspace."
  );
}

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export const STARTER_AGENTS = {
  codex: {
    id: "codex",
    adapter: "codex",
    role: "Primary implementer. Make small, verified changes and report concrete evidence.",
    sandbox: "workspace-write",
    ephemeral: true,
    herdrArgs: [
      "--sandbox", "workspace-write",
      "--ask-for-approval", "never"
    ]
  },
  claude: {
    id: "claude",
    adapter: "claude",
    role: "Peer reviewer and collaborator. Inspect current work, fix valid issues, and communicate actionable findings.",
    permissionMode: "acceptEdits",
    noSessionPersistence: true,
    herdrArgs: ["--permission-mode", "acceptEdits"]
  }
};

export async function loadConfig(configPath = DEFAULT_CONFIG_NAME) {
  const absolutePath = path.resolve(configPath);
  let raw;
  try {
    raw = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ConfigError(`Configuration not found: ${absolutePath}. Run "agent-office init" first.`);
    }
    throw new ConfigError(`Cannot read configuration ${absolutePath}: ${error.message}`);
  }

  return normalizeConfig(raw, path.dirname(absolutePath), absolutePath);
}

export function normalizeConfig(raw, baseDir, configPath = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("Configuration must be a JSON object");
  }
  if (raw.version !== 1) {
    throw new ConfigError(`Unsupported configuration version: ${raw.version}`);
  }
  if (!Array.isArray(raw.agents) || raw.agents.length < 1) {
    throw new ConfigError("Configuration must define at least one agent");
  }

  const workspace = resolveFrom(baseDir, raw.workspace ?? ".");
  const stateDir = resolveFrom(workspace, raw.stateDir ?? ".agent-office");
  const seenIds = new Set();
  const agents = raw.agents.map((agent, index) => {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      throw new ConfigError(`agents[${index}] must be an object`);
    }
    const id = assertNonEmptyString(agent.id, `agents[${index}].id`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
      throw new ConfigError(`Agent id "${id}" contains unsupported characters`);
    }
    if (seenIds.has(id)) {
      throw new ConfigError(`Duplicate agent id: ${id}`);
    }
    seenIds.add(id);
    if (agent.commandArgs !== undefined) {
      validateStringArray(agent.commandArgs, `agents[${index}].commandArgs`);
    }
    if (agent.args !== undefined) {
      validateStringArray(agent.args, `agents[${index}].args`);
    }
    if (agent.herdrArgs !== undefined) {
      validateStringArray(agent.herdrArgs, `agents[${index}].herdrArgs`);
    }
    if (agent.tools !== undefined) {
      validateTools(agent.tools, `agents[${index}].tools`);
    }
    if (agent.models !== undefined) {
      validateModels(agent.models, `agents[${index}].models`);
    }
    if (agent.model !== undefined) {
      assertNonEmptyString(agent.model, `agents[${index}].model`);
    }

    return {
      ...agent,
      id,
      adapter: assertNonEmptyString(agent.adapter, `agents[${index}].adapter`),
      role: typeof agent.role === "string" && agent.role.trim()
        ? agent.role.trim()
        : "Collaborate on the task and hand off useful evidence to teammates."
    };
  });

  const collaboration = {
    maxRounds: positiveInteger(raw.collaboration?.maxRounds, 4, "collaboration.maxRounds"),
    transcriptMessages: positiveInteger(
      raw.collaboration?.transcriptMessages,
      40,
      "collaboration.transcriptMessages"
    ),
    turnTimeoutMs: positiveInteger(
      raw.collaboration?.turnTimeoutMs,
      600_000,
      "collaboration.turnTimeoutMs"
    ),
    // The transcript grows every round, so a message-count limit alone cannot
    // bound the prompt. This caps the assembled transcript in characters.
    promptBudgetChars: positiveInteger(
      raw.collaboration?.promptBudgetChars,
      120_000,
      "collaboration.promptBudgetChars"
    )
  };
  const routing = {
    enabled: raw.routing?.enabled !== false,
    maxAgents: positiveInteger(
      raw.routing?.maxAgents,
      Math.min(2, agents.length),
      "routing.maxAgents"
    ),
    probeTimeoutMs: positiveInteger(
      raw.routing?.probeTimeoutMs,
      10_000,
      "routing.probeTimeoutMs"
    ),
    cacheTtlMs: positiveInteger(
      raw.routing?.cacheTtlMs,
      300_000,
      "routing.cacheTtlMs"
    )
  };

  const retention = {
    // Neither the event log nor the raw run outputs are bounded by anything else,
    // so a long-lived install would grow without limit.
    maxEventFileBytes: positiveInteger(
      raw.retention?.maxEventFileBytes,
      5 * 1024 * 1024,
      "retention.maxEventFileBytes"
    ),
    maxRunFiles: positiveInteger(
      raw.retention?.maxRunFiles,
      500,
      "retention.maxRunFiles"
    )
  };
  const execution = {
    runtime: raw.execution?.runtime ?? "process",
    maxConcurrency: positiveInteger(
      raw.execution?.maxConcurrency,
      4,
      "execution.maxConcurrency"
    ),
    leaseTimeoutMs: integerAtLeast(
      raw.execution?.leaseTimeoutMs,
      60_000,
      "execution.leaseTimeoutMs",
      3_000
    ),
    snapshotMaxFiles: positiveInteger(
      raw.execution?.snapshotMaxFiles,
      50_000,
      "execution.snapshotMaxFiles"
    ),
    herdrCommand: raw.execution?.herdrCommand ?? "herdr",
    herdrSession: raw.execution?.herdrSession ?? "agent-office",
    herdrServerMode: raw.execution?.herdrServerMode ?? "external",
    herdrPathPrefixes: raw.execution?.herdrPathPrefixes ?? []
  };
  if (!["process", "herdr"].includes(execution.runtime)) {
    throw new ConfigError("execution.runtime must be process or herdr");
  }
  assertNonEmptyString(execution.herdrCommand, "execution.herdrCommand");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(execution.herdrSession)) {
    throw new ConfigError("execution.herdrSession contains unsupported characters");
  }
  if (!["external", "managed"].includes(execution.herdrServerMode)) {
    throw new ConfigError("execution.herdrServerMode must be external or managed");
  }
  validateStringArray(execution.herdrPathPrefixes, "execution.herdrPathPrefixes");
  if (execution.herdrPathPrefixes.some((entry) => !path.isAbsolute(entry))) {
    throw new ConfigError("execution.herdrPathPrefixes entries must be absolute directories");
  }
  execution.herdrPathPrefixes = [...new Set(execution.herdrPathPrefixes)];

  return {
    ...raw,
    version: 1,
    configPath,
    baseDir,
    workspace,
    stateDir,
    agents,
    collaboration,
    routing,
    retention,
    execution
  };
}

export async function writeStarterConfig(targetDirectory, { agents } = {}) {
  const directory = path.resolve(targetDirectory);
  const targetPath = path.join(directory, DEFAULT_CONFIG_NAME);
  if (await exists(targetPath)) {
    throw new ConfigError(`Refusing to overwrite existing configuration: ${targetPath}`);
  }
  const selected = (agents ?? Object.keys(STARTER_AGENTS)).filter((id) => STARTER_AGENTS[id]);
  if (!selected.length) {
    throw new ConfigError(`No known agent for: ${(agents ?? []).join(", ") || "(none)"}`);
  }

  const starter = {
    version: 1,
    workspace: ".",
    stateDir: starterStateDir(directory),
    collaboration: {
      maxRounds: 4,
      transcriptMessages: 40,
      turnTimeoutMs: 600000,
      promptBudgetChars: 120000
    },
    routing: {
      enabled: true,
      maxAgents: 2,
      probeTimeoutMs: 10000,
      cacheTtlMs: 300000
    },
    retention: {
      maxEventFileBytes: 5242880,
      maxRunFiles: 500
    },
    execution: {
      runtime: "process",
      maxConcurrency: 4,
      leaseTimeoutMs: 60000,
      snapshotMaxFiles: 50000,
      herdrCommand: "herdr",
      herdrSession: "agent-office",
      herdrServerMode: "external",
      herdrPathPrefixes: []
    },
    agents: selected.map((id) => STARTER_AGENTS[id])
  };

  await writeFile(targetPath, `${JSON.stringify(starter, null, 2)}\n`, { flag: "wx" });
  return targetPath;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${name} must be a positive integer`);
  }
  return value;
}

function integerAtLeast(value, fallback, name, minimum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum) {
    throw new ConfigError(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

function validateStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${name} must be an array of strings`);
  }
}

function validateTools(value, name) {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${name} must be an array`);
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry === "string") {
      assertNonEmptyString(entry, `${name}[${index}]`);
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConfigError(`${name}[${index}] must be a string or object`);
    }
    assertNonEmptyString(entry.id, `${name}[${index}].id`);
  }
}

function validateModels(value, name) {
  if (!Array.isArray(value) || value.length < 1) {
    throw new ConfigError(`${name} must contain at least one model`);
  }
  const seen = new Set();
  for (const [index, model] of value.entries()) {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw new ConfigError(`${name}[${index}] must be an object`);
    }
    const id = assertNonEmptyString(model.id, `${name}[${index}].id`);
    if (seen.has(id)) throw new ConfigError(`Duplicate model id in ${name}: ${id}`);
    seen.add(id);
    if (model.capabilities !== undefined) {
      if (!model.capabilities || typeof model.capabilities !== "object" || Array.isArray(model.capabilities)) {
        throw new ConfigError(`${name}[${index}].capabilities must be an object`);
      }
      for (const [capability, score] of Object.entries(model.capabilities)) {
        if (!Number.isInteger(score) || score < 1 || score > 5) {
          throw new ConfigError(
            `${name}[${index}].capabilities.${capability} must be an integer from 1 to 5`
          );
        }
      }
    }
  }
}
