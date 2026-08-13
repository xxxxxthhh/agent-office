import { ConfigError } from "./errors.js";
import { assertNonEmptyString } from "./utils.js";

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NODE_TYPES = new Set(["agent", "command", "approval", "integration"]);
const ACCESS_MODES = new Set(["read_only", "write"]);

export function normalizeWorkflowDefinition(raw, config) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("Workflow definition must be a JSON object");
  }
  if (raw.version !== 1) {
    throw new ConfigError(`Unsupported workflow version: ${raw.version}`);
  }
  if (!Array.isArray(raw.nodes) || raw.nodes.length < 1) {
    throw new ConfigError("Workflow must define at least one node");
  }

  const configuredAgents = new Set(config.agents.map((agent) => agent.id));
  const seen = new Set();
  const nodes = raw.nodes.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConfigError(`nodes[${index}] must be an object`);
    }
    const id = assertNonEmptyString(entry.id, `nodes[${index}].id`);
    if (!NODE_ID.test(id) || id.length > 64) {
      throw new ConfigError(`Node id "${id}" must use supported characters and be at most 64 characters`);
    }
    if (seen.has(id)) throw new ConfigError(`Duplicate workflow node id: ${id}`);
    seen.add(id);

    const type = entry.type ?? "agent";
    if (!NODE_TYPES.has(type)) throw new ConfigError(`Unsupported node type for "${id}": ${type}`);
    const dependsOn = entry.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((value) => typeof value !== "string")) {
      throw new ConfigError(`nodes.${id}.dependsOn must be an array of node ids`);
    }
    const access = entry.access ?? (type === "agent" ? "read_only" : "read_only");
    if (!ACCESS_MODES.has(access)) {
      throw new ConfigError(`nodes.${id}.access must be read_only or write`);
    }

    if (type === "agent") {
      const owner = assertNonEmptyString(entry.owner, `nodes.${id}.owner`);
      if (!configuredAgents.has(owner)) {
        throw new ConfigError(`Node "${id}" references unknown agent "${owner}"`);
      }
    }
    if (type === "command") {
      assertNonEmptyString(entry.command, `nodes.${id}.command`);
      if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string"))) {
        throw new ConfigError(`nodes.${id}.args must be an array of strings`);
      }
    }
    if (type === "integration") {
      assertNonEmptyString(entry.source, `nodes.${id}.source`);
    }

    const writeScopes = entry.writeScopes ?? [];
    if (!Array.isArray(writeScopes) || writeScopes.some((value) => typeof value !== "string" || !value.trim())) {
      throw new ConfigError(`nodes.${id}.writeScopes must be an array of non-empty paths or globs`);
    }
    if (access === "write" && type === "agent" && writeScopes.length < 1) {
      throw new ConfigError(`Writing node "${id}" must declare writeScopes`);
    }
    if (access === "write" && entry.workspace !== "worktree") {
      throw new ConfigError(`Writing node "${id}" must use workspace="worktree"`);
    }
    if (entry.workspaceFrom !== undefined) {
      assertNonEmptyString(entry.workspaceFrom, `nodes.${id}.workspaceFrom`);
      if (entry.workspace !== undefined) {
        throw new ConfigError(`Node "${id}" cannot set both workspace and workspaceFrom`);
      }
    }

    return {
      id,
      type,
      owner: type === "agent" ? entry.owner : null,
      role: typeof entry.role === "string" ? entry.role.trim() : "",
      prompt: typeof entry.prompt === "string" ? entry.prompt.trim() : "",
      command: type === "command" ? entry.command : null,
      args: type === "command" ? [...(entry.args ?? [])] : [],
      envKeys: normalizeEnvironmentKeys(entry.env, `nodes.${id}.env`),
      dependsOn: [...new Set(dependsOn)],
      access,
      workspace: entry.workspace ?? "shared",
      workspaceFrom: entry.workspaceFrom ?? null,
      writeScopes: writeScopes.map((value) => value.trim()),
      maxAttempts: positiveInteger(
        entry.maxAttempts,
        type === "agent" ? 2 : 1,
        `nodes.${id}.maxAttempts`
      ),
      approval: type === "approval"
        ? (entry.prompt?.trim() || `Approve workflow node ${id}`)
        : null,
      source: type === "integration" ? entry.source : null
    };
  });

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!seen.has(dependency)) throw new ConfigError(`Node "${node.id}" depends on unknown node "${dependency}"`);
      if (dependency === node.id) throw new ConfigError(`Node "${node.id}" cannot depend on itself`);
    }
    if (node.workspaceFrom && !seen.has(node.workspaceFrom)) {
      throw new ConfigError(`Node "${node.id}" references unknown workspaceFrom node "${node.workspaceFrom}"`);
    }
    if (node.workspaceFrom && !node.dependsOn.includes(node.workspaceFrom)) {
      throw new ConfigError(`Node "${node.id}" must depend on its workspaceFrom node "${node.workspaceFrom}"`);
    }
    if (node.workspaceFrom) {
      const source = nodes.find((candidate) => candidate.id === node.workspaceFrom);
      if (node.access !== "read_only" || source.access !== "write" || source.workspace !== "worktree") {
        throw new ConfigError(
          `Node "${node.id}" may inherit only a writing worktree as a read-only consumer`
        );
      }
    }
  }
  assertAcyclic(nodes);
  assertIntegrationPolicy(nodes);

  const runtime = raw.runtime ?? config.execution.runtime;
  if (!["process", "herdr"].includes(runtime)) {
    throw new ConfigError("workflow.runtime must be process or herdr");
  }

  return {
    version: 1,
    runtime,
    leaseTimeoutMs: config.execution.leaseTimeoutMs,
    maxConcurrency: positiveInteger(
      raw.maxConcurrency,
      config.execution.maxConcurrency,
      "workflow.maxConcurrency"
    ),
    nodes
  };
}

function assertIntegrationPolicy(nodes) {
  const integrations = nodes.filter((node) => node.type === "integration");
  if (integrations.length > 1) {
    throw new ConfigError("A workflow may define only one integration node");
  }
  const writers = nodes.filter((node) => node.access === "write");
  if (writers.length && !integrations.length) {
    throw new ConfigError("A workflow with writing nodes requires one integration node");
  }
  if (!integrations.length) return;
  if (writers.length !== 1) {
    throw new ConfigError("Version 1 workflows support exactly one writing node and one integrator");
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const integration = integrations[0];
  const source = byId.get(integration.source);
  if (!source || source.access !== "write" || source.workspace !== "worktree") {
    throw new ConfigError(`Integration node "${integration.id}" source must be a worktree writing node`);
  }
  if (!integration.dependsOn.includes(source.id)) {
    throw new ConfigError(`Integration node "${integration.id}" must depend directly on source "${source.id}"`);
  }
  const approvalAfterSource = nodes.some((candidate) => (
    candidate.type === "approval"
    && hasAncestor(integration, candidate.id, byId)
    && hasAncestor(candidate, source.id, byId)
  ));
  if (!approvalAfterSource) {
    throw new ConfigError(
      `Integration node "${integration.id}" requires an approval after source "${source.id}"`
    );
  }
}

function hasAncestor(node, targetId, byId, seen = new Set()) {
  for (const dependencyId of node.dependsOn) {
    if (seen.has(dependencyId)) continue;
    seen.add(dependencyId);
    const dependency = byId.get(dependencyId);
    if (dependencyId === targetId || hasAncestor(dependency, targetId, byId, seen)) return true;
  }
  return false;
}

function assertAcyclic(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new ConfigError(`Workflow contains a dependency cycle at "${id}"`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

function normalizeEnvironmentKeys(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((key) => (
    typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
  ))) {
    throw new ConfigError(`${name} must be an array of environment variable names`);
  }
  return [...new Set(value)];
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new ConfigError(`${name} must be a positive integer`);
  return value;
}
