import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { ConfigError } from "./errors.js";
import { assertNonEmptyString, exists, resolveFrom } from "./utils.js";

export const DEFAULT_CONFIG_NAME = "agent-office.json";

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

  return {
    ...raw,
    version: 1,
    configPath,
    baseDir,
    workspace,
    stateDir,
    agents,
    collaboration,
    routing
  };
}

export async function writeStarterConfig(targetDirectory) {
  const directory = path.resolve(targetDirectory);
  const targetPath = path.join(directory, DEFAULT_CONFIG_NAME);
  if (await exists(targetPath)) {
    throw new ConfigError(`Refusing to overwrite existing configuration: ${targetPath}`);
  }

  const starter = {
    version: 1,
    workspace: ".",
    stateDir: ".agent-office",
    collaboration: {
      maxRounds: 4,
      transcriptMessages: 40,
      turnTimeoutMs: 600000
    },
    routing: {
      enabled: true,
      maxAgents: 2,
      probeTimeoutMs: 10000,
      cacheTtlMs: 300000
    },
    agents: [
      {
        id: "codex",
        adapter: "codex",
        role: "Primary implementer. Make small, verified changes and report concrete evidence.",
        sandbox: "workspace-write",
        ephemeral: true
      },
      {
        id: "claude",
        adapter: "claude",
        role: "Peer reviewer and collaborator. Inspect current work, fix valid issues, and communicate actionable findings.",
        permissionMode: "acceptEdits",
        noSessionPersistence: true
      }
    ]
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
