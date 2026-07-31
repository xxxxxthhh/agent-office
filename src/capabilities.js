import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { runProcess } from "./adapters/process.js";

const CAPABILITY_KEYS = [
  "coding",
  "review",
  "reasoning",
  "research",
  "writing",
  "vision",
  "speed",
  "costEfficiency"
];

// Claude Code has no cost-free command that enumerates the models an account may
// call, so the rolling aliases are kept here as a static table. An entry only
// becomes routable when the installed CLI's own help text still advertises it;
// everything else stays visible but unrouted, so a stale entry can never send a
// turn to a model the CLI would reject.
const CLAUDE_ALIASES = [
  { id: "fable", label: "Fable", family: "fable" },
  { id: "opus", label: "Opus", family: "opus" },
  { id: "sonnet", label: "Sonnet", family: "sonnet" },
  { id: "haiku", label: "Haiku", family: "haiku" }
];

const BASE_TOOLS = {
  codex: [
    tool("workspace.read", "Workspace read", "builtin"),
    tool("workspace.write", "Workspace write", "builtin"),
    tool("shell", "Shell commands", "builtin"),
    tool("web.search", "Web search", "builtin"),
    tool("image.input", "Image input", "builtin")
  ],
  claude: [
    tool("workspace.read", "Read / Glob / Grep", "builtin"),
    tool("workspace.write", "Edit / Write", "builtin"),
    tool("shell", "Bash", "builtin"),
    tool("web.search", "WebSearch / WebFetch", "builtin"),
    tool("image.input", "Image input", "builtin"),
    tool("agent.subagents", "Configured agents", "builtin")
  ],
  command: [
    tool("workspace.read", "Workspace access", "configured"),
    tool("shell", "Configured command", "configured")
  ],
  mock: [
    tool("simulation", "Offline simulation", "builtin")
  ]
};

export class CapabilityRegistry {
  constructor({
    config,
    probe = runProcess,
    homeDir = os.homedir(),
    clock = () => Date.now()
  }) {
    this.config = config;
    this.probe = probe;
    this.homeDir = homeDir;
    this.clock = clock;
    this.cached = null;
    this.cachedAt = 0;
  }

  async discover({ refresh = false } = {}) {
    const ttl = this.config.routing.cacheTtlMs;
    if (!refresh && this.cached && this.clock() - this.cachedAt < ttl) {
      return this.cached;
    }

    const agents = await Promise.all(
      this.config.agents.map((agent) => this.#discoverAgent(agent))
    );
    const inventory = {
      version: 1,
      detectedAt: new Date(this.clock()).toISOString(),
      agents,
      totals: {
        agents: agents.length,
        availableAgents: agents.filter((agent) => agent.available).length,
        models: agents.reduce((sum, agent) => sum + agent.models.length, 0),
        routableModels: agents.reduce(
          (sum, agent) => sum + agent.models.filter((model) => model.routable !== false).length,
          0
        ),
        tools: agents.reduce((sum, agent) => sum + agent.tools.length, 0),
        availableTools: agents.reduce(
          (sum, agent) => sum + agent.tools.filter((item) => item.available).length,
          0
        )
      }
    };
    this.cached = inventory;
    this.cachedAt = this.clock();
    return inventory;
  }

  async plan(objective, options = {}) {
    return routeTask(objective, await this.discover(options), this.config);
  }

  async #discoverAgent(agent) {
    const base = {
      id: agent.id,
      adapter: agent.adapter,
      role: agent.role,
      command: agent.command ?? defaultCommand(agent.adapter),
      available: true,
      version: agent.adapter === "mock" ? "offline" : "not probed",
      models: [],
      tools: mergeTools(BASE_TOOLS[agent.adapter] ?? [], configuredTools(agent)),
      warnings: []
    };

    if (!["codex", "claude"].includes(agent.adapter)) {
      base.models = configuredModels(agent, [
        modelFrom({
          id: agent.model ?? agent.adapter,
          label: agent.model ?? `${agent.adapter} default`,
          description: "Configured adapter model.",
          source: agent.model ? "configured" : "adapter-default",
          availability: agent.model ? "configured" : "assumed"
        }, agent.adapter)
      ]);
      return base;
    }

    try {
      const version = await this.#run(agent, ["--version"]);
      base.version = firstLine(version.stdout || version.stderr) || "unknown";
    } catch (error) {
      base.available = false;
      base.version = "unavailable";
      base.warnings.push(safeError(error));
    }

    if (agent.adapter === "codex") {
      const discovery = await this.#discoverCodex(agent, base.available);
      base.models = configuredModels(agent, discovery.models);
      base.tools = mergeTools(base.tools, discovery.tools);
      base.warnings.push(...discovery.warnings);
    } else {
      const discovery = await this.#discoverClaude(agent, base.available);
      base.models = configuredModels(agent, discovery.models);
      base.tools = mergeTools(base.tools, discovery.tools);
      base.warnings.push(...discovery.warnings);
    }

    // Discovery can surface models that are known but unconfirmed for this CLI
    // build. If none of them is safe to route to, fall back to letting the
    // provider pick, rather than routing a turn to an unverified alias.
    if (!base.models.some((model) => model.routable !== false)) {
      base.models.push(modelFrom({
        id: agent.model ?? "default",
        label: agent.model ?? "Provider default",
        description: "The provider will choose its current default model.",
        source: agent.model ? "configured" : "provider-default",
        availability: agent.model ? "configured" : "assumed"
      }, agent.adapter));
    }
    return base;
  }

  async #discoverCodex(agent, available) {
    const models = [];
    const tools = [];
    const warnings = [];
    const cachePath = path.join(
      process.env.CODEX_HOME || path.join(this.homeDir, ".codex"),
      "models_cache.json"
    );

    try {
      const payload = JSON.parse(await readFile(cachePath, "utf8"));
      models.push(...normalizeCodexCatalog(payload, "local-catalog"));
    } catch (error) {
      if (error.code !== "ENOENT") warnings.push(`Codex model cache: ${safeError(error)}`);
    }

    if (!models.length && available) {
      try {
        const result = await this.#run(agent, ["debug", "models", "--bundled"]);
        models.push(...normalizeCodexCatalog(JSON.parse(result.stdout), "bundled-catalog"));
      } catch (error) {
        warnings.push(`Codex model catalog: ${safeError(error)}`);
      }
    }

    if (available) {
      try {
        const result = await this.#run(agent, ["mcp", "list", "--json"]);
        const servers = JSON.parse(result.stdout);
        if (Array.isArray(servers)) {
          for (const server of servers) {
            tools.push(tool(
              `mcp.${slug(server.name)}`,
              server.name,
              "mcp",
              server.enabled !== false,
              server.disabled_reason ?? undefined
            ));
          }
        }
      } catch (error) {
        warnings.push(`Codex MCP: ${safeError(error)}`);
      }
    }
    return { models, tools, warnings };
  }

  async #discoverClaude(agent, available) {
    const models = [];
    const tools = [];
    const warnings = [];

    if (available) {
      // The Claude Code CLI treats an unrecognised subcommand as a prompt, which
      // would turn a capability probe into a billed model call. Every subcommand
      // is therefore checked against the CLI's own command list first, and
      // nothing is probed at all when the help text cannot be read.
      let commands = new Set();
      try {
        const help = await this.#run(agent, ["--help"]);
        models.push(...parseClaudeModels(help.stdout));
        commands = parseClaudeCommands(help.stdout);
      } catch (error) {
        warnings.push(`Claude model aliases: ${safeError(error)}`);
        warnings.push("Skipped Claude subcommand probes because --help could not be read.");
      }

      if (commands.has("mcp")) {
        try {
          const mcp = await this.#run(agent, ["mcp", "list"]);
          tools.push(...parseClaudeMcp(mcp.stdout));
        } catch (error) {
          warnings.push(`Claude MCP: ${safeError(error)}`);
        }
      } else if (commands.size) {
        warnings.push("This Claude Code build does not advertise an `mcp` command.");
      }

      if (commands.has("plugin")) {
        try {
          const plugins = await this.#run(agent, ["plugin", "list", "--json"]);
          const payload = JSON.parse(plugins.stdout);
          if (Array.isArray(payload)) {
            for (const plugin of payload) {
              const name = plugin.id ?? plugin.name ?? String(plugin);
              tools.push(tool(`plugin.${slug(name)}`, name, "plugin", plugin.enabled !== false));
            }
          }
        } catch (error) {
          warnings.push(`Claude plugins: ${safeError(error)}`);
        }
      } else if (commands.size) {
        warnings.push("This Claude Code build does not advertise a `plugin` command.");
      }
    }

    const environment = { ...process.env, ...agent.env };
    for (const name of ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"]) {
      if (!environment[name]) continue;
      models.push(modelFrom({
        id: environment[name],
        label: environment[name],
        description: `Selected through ${name}.`,
        source: "environment",
        availability: "configured"
      }, "claude"));
    }
    return { models, tools, warnings };
  }

  #run(agent, args) {
    return this.probe({
      command: agent.command ?? defaultCommand(agent.adapter),
      args: [...(agent.commandArgs ?? []), ...args],
      cwd: this.config.workspace,
      timeoutMs: this.config.routing.probeTimeoutMs,
      env: agent.env
    });
  }
}

export function inventoryFromConfig(config) {
  const agents = config.agents.map((agent) => ({
    id: agent.id,
    adapter: agent.adapter,
    role: agent.role,
    command: agent.command ?? defaultCommand(agent.adapter),
    available: true,
    version: "not probed",
    models: configuredModels(agent, [modelFrom({
      id: agent.model ?? "default",
      label: agent.model ?? "Provider default",
      description: "Static configuration fallback.",
      source: agent.model ? "configured" : "provider-default",
      availability: agent.model ? "configured" : "assumed"
    }, agent.adapter)]),
    tools: mergeTools(BASE_TOOLS[agent.adapter] ?? [], configuredTools(agent)),
    warnings: ["Runtime discovery was not attached; routing used configuration only."]
  }));
  return {
    version: 1,
    detectedAt: new Date().toISOString(),
    agents,
    totals: {
      agents: agents.length,
      availableAgents: agents.length,
      models: agents.reduce((sum, agent) => sum + agent.models.length, 0),
      routableModels: agents.reduce(
        (sum, agent) => sum + agent.models.filter((model) => model.routable !== false).length,
        0
      ),
      tools: agents.reduce((sum, agent) => sum + agent.tools.length, 0),
      availableTools: agents.reduce(
        (sum, agent) => sum + agent.tools.filter((item) => item.available).length,
        0
      )
    }
  };
}

export function routeTask(objective, inventory, config) {
  const profile = classifyTask(objective);
  const configured = new Map(config.agents.map((agent) => [agent.id, agent]));
  let candidates = inventory.agents.filter((agent) => agent.available);
  const warnings = [];
  if (!candidates.length) {
    candidates = inventory.agents;
    warnings.push("No provider CLI was confirmed available; using configured agents as a fallback.");
  }

  const bestByAgent = candidates.map((agent) => {
    const discoveredModels = agent.models.length ? agent.models : [modelFrom({
      id: configured.get(agent.id)?.model ?? "default",
      label: "Provider default",
      source: "provider-default",
      availability: "assumed"
    }, agent.adapter)];
    const routableModels = discoveredModels.filter((model) => model.routable !== false);
    const models = routableModels.length ? routableModels : discoveredModels;
    const best = models
      .map((model, modelOrder) => ({
        ...scoreCandidate(profile, agent, model),
        modelOrder
      }))
      .sort((left, right) => right.score - left.score || left.modelOrder - right.modelOrder)[0];
    return {
      ...best,
      configOrder: config.agents.findIndex((configuredAgent) => configuredAgent.id === agent.id)
    };
  });

  const limit = Math.min(config.routing.maxAgents, bestByAgent.length);
  const assignments = bestByAgent
    .sort((left, right) => right.score - left.score || left.configOrder - right.configOrder)
    .slice(0, limit)
    .map((candidate) => ({
      ...candidate,
      effort: chooseEffort(profile, candidate.modelDetails)
    }))
    .sort((left, right) => (
      assignmentPhase(left, profile) - assignmentPhase(right, profile)
      || left.configOrder - right.configOrder
    ))
    .map(({ modelDetails, role, configOrder, modelOrder, ...assignment }, index) => ({
      ...assignment,
      order: index + 1
    }));

  return {
    version: 1,
    strategy: config.routing.enabled ? "capability-aware" : "configured-order",
    generatedAt: new Date().toISOString(),
    profile,
    assignments: config.routing.enabled
      ? assignments
      : config.agents.map((agent, index) => ({
          agentId: agent.id,
          adapter: agent.adapter,
          model: agent.model ?? null,
          modelLabel: agent.model ?? "Provider default",
          effort: agent.effort ?? null,
          score: null,
          order: index + 1,
          reasons: ["Routing is disabled; using configured order."],
          missingTools: []
        })),
    warnings
  };
}

export function classifyTask(objective) {
  const text = String(objective).toLowerCase();
  const weights = {
    coding: 2,
    review: 1,
    reasoning: 3,
    research: 1,
    writing: 2,
    vision: 0,
    speed: 2,
    costEfficiency: 2
  };
  const kinds = new Set(["general"]);
  const requiredTools = new Set(["workspace.read"]);

  if (matches(text, [
    "implement", "build", "fix", "refactor", "test", "debug", "code",
    "实现", "开发", "构建", "修复", "重构", "测试", "调试", "代码"
  ])) {
    kinds.add("implementation");
    weights.coding = 5;
    weights.reasoning = Math.max(weights.reasoning, 4);
    requiredTools.add("workspace.write");
    requiredTools.add("shell");
  }
  if (matches(text, [
    "review", "audit", "inspect", "security", "verify", "risk",
    "审查", "评审", "审核", "安全", "验证", "风险", "检查"
  ])) {
    kinds.add("review");
    weights.review = 5;
    weights.reasoning = Math.max(weights.reasoning, 4);
    requiredTools.add("shell");
  }
  if (matches(text, [
    "research", "latest", "current", "compare", "investigate", "source",
    "调研", "研究", "最新", "当前", "比较", "搜索", "资料", "来源"
  ])) {
    kinds.add("research");
    weights.research = 5;
    weights.reasoning = Math.max(weights.reasoning, 4);
    requiredTools.add("web.search");
  }
  if (matches(text, [
    "document", "report", "translate", "summary", "proposal", "write",
    "文档", "报告", "翻译", "总结", "方案", "写作"
  ])) {
    kinds.add("writing");
    weights.writing = 5;
  }
  if (matches(text, [
    "image", "screenshot", "visual", "diagram", "ui", "design",
    "图片", "截图", "视觉", "图表", "界面", "设计"
  ])) {
    kinds.add("vision");
    weights.vision = 5;
    requiredTools.add("image.input");
  }
  if (matches(text, [
    "architecture", "migration", "distributed", "ambiguous", "complex", "deep",
    "架构", "迁移", "分布式", "模糊", "复杂", "深入", "彻底"
  ])) {
    kinds.add("complex");
    weights.reasoning = 5;
    weights.speed = 1;
    weights.costEfficiency = 1;
  }
  if (matches(text, [
    "extract", "classify", "format", "batch", "simple", "quick",
    "提取", "分类", "格式化", "批量", "简单", "快速"
  ])) {
    kinds.add("repeatable");
    weights.speed = 5;
    weights.costEfficiency = 5;
    weights.reasoning = Math.min(weights.reasoning, 2);
  }

  return {
    kinds: [...kinds].filter((kind) => kind !== "general" || kinds.size === 1),
    weights,
    requiredTools: [...requiredTools],
    complexity: weights.reasoning >= 5 ? "high" : weights.reasoning >= 4 ? "medium" : "low"
  };
}

function scoreCandidate(profile, agent, model) {
  let weighted = 0;
  let totalWeight = 0;
  for (const key of CAPABILITY_KEYS) {
    const weight = profile.weights[key] ?? 0;
    weighted += weight * (model.capabilities[key] ?? 3);
    totalWeight += weight;
  }
  let score = totalWeight ? (weighted / totalWeight) * 20 : 60;
  const toolIds = new Set(agent.tools.filter((item) => item.available).map((item) => item.id));
  const missingTools = profile.requiredTools.filter((required) => !toolIds.has(required));
  score -= missingTools.length * 12;

  const role = agent.role.toLowerCase();
  const affinity = roleAffinity(role, profile.kinds);
  score += affinity;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const strengths = topStrengths(model.capabilities, profile.weights);
  const reasons = [
    `${model.label} fits ${strengths.join(", ") || "general work"}.`,
    affinity > 0
      ? `${agent.id}'s configured role matches this task.`
      : `${agent.id} provides the required collaboration adapter.`
  ];
  if (missingTools.length) reasons.push(`Missing detected tools: ${missingTools.join(", ")}.`);

  return {
    agentId: agent.id,
    adapter: agent.adapter,
    role: agent.role,
    model: model.id === "default" ? null : model.id,
    modelLabel: model.label,
    modelDetails: model,
    score,
    reasons,
    missingTools
  };
}

function roleAffinity(role, kinds) {
  let score = 0;
  if (kinds.includes("implementation") && matches(role, ["implement", "build", "primary", "实现", "开发"])) {
    score += 8;
  }
  if (kinds.includes("review") && matches(role, ["review", "inspect", "verify", "审查", "评审"])) {
    score += 8;
  }
  if (kinds.includes("research") && matches(role, ["research", "investigate", "调研", "研究"])) {
    score += 8;
  }
  if (kinds.includes("writing") && matches(role, ["write", "document", "report", "文档", "报告"])) {
    score += 6;
  }
  return score;
}

function assignmentPhase(assignment, profile) {
  const role = assignment.role.toLowerCase();
  if (profile.kinds.includes("implementation") && /implement|primary|build|实现|开发/.test(role)) return 0;
  if (profile.kinds.includes("review") && /review|verify|inspect|审查|评审/.test(role)) return 2;
  return 1;
}

function chooseEffort(profile, model) {
  const desired = profile.complexity === "high"
    ? "high"
    : profile.complexity === "medium"
      ? "medium"
      : "low";
  const supported = model.reasoningEfforts ?? [];
  if (!supported.length) return desired;
  if (supported.includes(desired)) return desired;
  return model.defaultReasoningEffort ?? supported[0] ?? null;
}

function configuredModels(agent, discovered) {
  const merged = new Map();
  for (const model of discovered) merged.set(model.id, model);
  if (agent.model) {
    const existing = merged.get(agent.model);
    merged.set(agent.model, modelFrom({
      ...(existing ?? {}),
      id: agent.model,
      label: existing?.label ?? agent.model,
      description: existing?.description ?? "Explicitly configured model.",
      source: "configured",
      availability: "configured",
      // An explicit choice overrides an unverified discovery result.
      routable: true,
      defaultReasoningEffort: agent.effort ?? existing?.defaultReasoningEffort
    }, agent.adapter));
  }
  for (const definition of agent.models ?? []) {
    const existing = merged.get(definition.id);
    merged.set(definition.id, modelFrom({
      ...(existing ?? {}),
      ...definition,
      source: "configured",
      availability: "configured",
      routable: definition.routable !== false,
      capabilities: {
        ...(existing?.capabilities ?? {}),
        ...(definition.capabilities ?? {})
      }
    }, agent.adapter));
  }
  return [...merged.values()];
}

function normalizeCodexCatalog(payload, source) {
  if (!Array.isArray(payload?.models)) return [];
  return payload.models
    .filter((model) => model?.slug && model.visibility !== "hidden")
    .map((model) => modelFrom({
      id: model.slug,
      label: model.display_name ?? model.slug,
      description: model.description ?? "",
      source,
      availability: "catalog",
      modalities: model.input_modalities ?? [],
      reasoningEfforts: (
        model.supported_reasoning_levels
        ?? model.supported_reasoning_efforts
        ?? []
      ).map((item) => typeof item === "string" ? item : item.effort).filter(Boolean),
      defaultReasoningEffort: model.default_reasoning_level,
      routable: !model.slug.includes("auto-review")
    }, "codex"));
}

function parseClaudeModels(help) {
  const advertised = scrapeClaudeModelNames(help);
  const models = [];

  for (const alias of CLAUDE_ALIASES) {
    const confirmed = advertised.has(alias.id);
    models.push(modelFrom({
      id: alias.id,
      label: alias.label,
      description: confirmed
        ? "Rolling model alias advertised by the installed Claude Code CLI."
        : "Known rolling alias that this CLI build does not advertise; "
          + "configure it explicitly to route to it.",
      source: confirmed ? "cli-help" : "known-alias",
      availability: confirmed ? "advertised" : "unverified",
      modalities: ["text", "image"],
      reasoningEfforts: CLAUDE_EFFORTS,
      routable: confirmed
    }, "claude"));
  }

  for (const id of advertised) {
    if (models.some((model) => model.id === id)) continue;
    models.push(modelFrom({
      id,
      label: id,
      description: "Model name advertised by the installed Claude Code CLI.",
      source: "cli-help",
      availability: "advertised",
      modalities: ["text", "image"],
      reasoningEfforts: CLAUDE_EFFORTS
    }, "claude"));
  }
  return models;
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// `claude --help` wraps option descriptions across several indented lines, so the
// aliases live below the `--model` line rather than on it. Read the whole option
// block instead of a single line.
function scrapeClaudeModelNames(help) {
  const names = new Set();
  // Scoped to the `--model` block on purpose: a `claude-*` string elsewhere in
  // the help (another option's example, a package name) is not a model we may
  // pass to --model.
  const block = extractOptionBlock(help, "--model");
  for (const match of block.matchAll(/'([a-z][a-z0-9_.-]*)'/g)) {
    names.add(match[1]);
  }
  for (const match of block.matchAll(/\bclaude-[a-z]+(?:-[a-z0-9.]+)+\b/g)) {
    names.add(match[0].replace(/[).,]+$/, ""));
  }
  return names;
}

// Reads the `Commands:` section so a probe is only ever issued for a subcommand
// this CLI build actually declares.
function parseClaudeCommands(help) {
  const commands = new Set();
  const lines = help.split("\n");
  const start = lines.findIndex((line) => /^Commands:\s*$/.test(line));
  if (start === -1) return commands;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    const match = line.match(/^ {2}(\S+)/);
    if (!match) continue;
    for (const name of match[1].split("|")) commands.add(name);
  }
  return commands;
}

function extractOptionBlock(help, option) {
  const lines = help.split("\n");
  const startIndex = lines.findIndex((line) => (
    new RegExp(`^\\s*(?:-[A-Za-z], )?${option}(?:[ ,=]|$)`).test(line)
  ));
  if (startIndex === -1) return "";
  const indent = lines[startIndex].search(/\S/);
  const block = [lines[startIndex]];
  for (const line of lines.slice(startIndex + 1)) {
    if (!line.trim()) break;
    // A new option starts at the same indent as the one being read.
    if (line.search(/\S/) <= indent) break;
    block.push(line);
  }
  return block.join("\n");
}

// Real output is `<name>: <target> - <status>`, where the name may contain spaces
// and punctuation ("claude.ai S&P Global") and the target is usually a URL.
function parseClaudeMcp(output) {
  if (/No MCP servers configured/i.test(output)) return [];
  const tools = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line || /^Checking MCP server health/i.test(line)) continue;
    const match = line.match(/^(.+?):\s+(.*)\s+-\s+(.+)$/)
      ?? line.match(/^(.+?):\s+(.+)$/);
    if (!match) continue;
    const name = match[1].trim();
    const status = (match[3] ?? "").trim();
    const detail = [match[2]?.trim(), status].filter(Boolean).join(" - ");
    tools.push(tool(
      `mcp.${slug(name)}`,
      name,
      "mcp",
      !MCP_UNAVAILABLE.test(status),
      detail
    ));
  }
  return tools;
}

const MCP_UNAVAILABLE = /failed|disconnected|disabled|needs? authentication|not connected|unauthori[sz]ed|error|✗|✘/i;

function modelFrom(raw, adapter) {
  const capabilities = inferModelCapabilities(adapter, raw);
  return {
    id: raw.id,
    label: raw.label ?? raw.id,
    description: raw.description ?? "",
    source: raw.source ?? "unknown",
    availability: raw.availability ?? "unknown",
    modalities: raw.modalities ?? [],
    reasoningEfforts: raw.reasoningEfforts ?? [],
    defaultReasoningEffort: raw.defaultReasoningEffort ?? null,
    routable: raw.routable !== false,
    capabilities: {
      ...capabilities,
      ...(raw.capabilities ?? {})
    }
  };
}

function inferModelCapabilities(adapter, model) {
  const text = `${model.id} ${model.label ?? ""} ${model.description ?? ""}`.toLowerCase();
  let profile = {
    coding: 4,
    review: 4,
    reasoning: 4,
    research: 4,
    writing: 4,
    vision: (model.modalities ?? []).includes("image") ? 5 : 2,
    speed: 3,
    costEfficiency: 3
  };

  if (adapter === "codex") {
    if (matches(text, ["sol", "frontier", "most capable", "complex"])) {
      profile = { ...profile, coding: 5, review: 5, reasoning: 5, research: 5, writing: 5, speed: 2, costEfficiency: 2 };
    }
    if (matches(text, ["terra", "balanced", "everyday"])) {
      profile = { ...profile, coding: 4, review: 4, reasoning: 4, research: 4, writing: 4, speed: 4, costEfficiency: 4 };
    }
    if (matches(text, ["luna", "mini", "spark", "fast", "affordable", "small"])) {
      profile = { ...profile, coding: 4, review: 3, reasoning: 3, research: 3, writing: 4, speed: 5, costEfficiency: 5 };
    }
    if (text.includes("auto-review")) {
      profile = { ...profile, coding: 2, review: 5, reasoning: 4, research: 2, writing: 3, speed: 4, costEfficiency: 4 };
    }
  }

  if (adapter === "claude") {
    if (text.includes("fable")) {
      profile = { ...profile, coding: 5, review: 5, reasoning: 5, research: 5, writing: 5, vision: 5, speed: 3, costEfficiency: 2 };
    } else if (text.includes("opus")) {
      profile = { ...profile, coding: 5, review: 5, reasoning: 5, research: 5, writing: 5, vision: 5, speed: 2, costEfficiency: 1 };
    } else if (text.includes("sonnet")) {
      profile = { ...profile, coding: 5, review: 4, reasoning: 4, research: 4, writing: 4, vision: 5, speed: 4, costEfficiency: 3 };
    } else if (text.includes("haiku")) {
      profile = { ...profile, coding: 3, review: 3, reasoning: 3, research: 3, writing: 3, vision: 4, speed: 5, costEfficiency: 5 };
    }
  }
  return profile;
}

function topStrengths(capabilities, weights) {
  return Object.entries(capabilities)
    .filter(([key]) => (weights[key] ?? 0) > 0)
    .sort((left, right) => (
      (right[1] * (weights[right[0]] ?? 0)) - (left[1] * (weights[left[0]] ?? 0))
    ))
    .slice(0, 3)
    .map(([key]) => key);
}

function configuredTools(agent) {
  return (agent.tools ?? []).map((entry) => (
    typeof entry === "string"
      ? tool(entry, entry, "configured")
      : tool(entry.id, entry.label ?? entry.id, entry.kind ?? "configured", entry.available !== false)
  ));
}

function mergeTools(...groups) {
  const merged = new Map();
  for (const item of groups.flat()) merged.set(item.id, { ...merged.get(item.id), ...item });
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function tool(id, label, kind, available = true, detail = undefined) {
  return { id, label, kind, available, ...(detail ? { detail } : {}) };
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unnamed";
}

function defaultCommand(adapter) {
  return { codex: "codex", claude: "claude" }[adapter] ?? null;
}

function firstLine(value) {
  return String(value).trim().split("\n")[0];
}

function safeError(error) {
  return String(error?.message ?? error).replaceAll(/\s+/g, " ").slice(0, 240);
}

function matches(text, values) {
  return values.some((value) => text.includes(value));
}
