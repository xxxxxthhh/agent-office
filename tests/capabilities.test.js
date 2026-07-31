import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  CapabilityRegistry,
  classifyTask,
  inventoryFromConfig,
  routeTask
} from "../src/capabilities.js";
import { normalizeConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { loadTurnSchema } from "../src/protocol.js";
import { DEFAULT_SCHEMA_PATH } from "../src/runtime.js";
import { TaskStore } from "../src/store.js";

test("discovers provider model catalogs, MCP servers, and plugins without model calls", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-capabilities-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    agents: [
      { id: "codex", adapter: "codex", role: "Implement." },
      { id: "claude", adapter: "claude", role: "Review." }
    ]
  }, workspace);
  const calls = [];
  const registry = new CapabilityRegistry({
    config,
    homeDir: workspace,
    probe: async ({ command, args }) => {
      calls.push({ command, args });
      const joined = args.join(" ");
      if (args.includes("--version")) {
        return { stdout: command === "codex" ? "codex-cli 1.2.3\n" : "2.3.4 (Claude Code)\n", stderr: "" };
      }
      if (joined === "debug models --bundled") {
        return {
          stdout: JSON.stringify({
            models: [{
              slug: "gpt-test-sol",
              display_name: "GPT Test Sol",
              description: "Frontier model for complex work.",
              input_modalities: ["text", "image"],
              default_reasoning_level: "medium",
              supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }]
            }]
          }),
          stderr: ""
        };
      }
      if (command === "codex" && joined === "mcp list --json") {
        return { stdout: JSON.stringify([{ name: "github", enabled: true }]), stderr: "" };
      }
      if (command === "claude" && joined === "--help") {
        return {
          stdout: [
            "  --fallback-model <model>  Enable automatic fallback to specified model(s)",
            "  --model <model>           Model for the current session. Provide",
            "                            an alias for the latest model (e.g.",
            "                            'fable', 'opus', or 'sonnet') or a",
            "                            model's full name (e.g.",
            "                            'claude-fable-5')."
          ].join("\n"),
          stderr: ""
        };
      }
      if (command === "claude" && joined === "mcp list") {
        return { stdout: "figma: https://mcp.figma.com - Connected\n", stderr: "" };
      }
      if (command === "claude" && joined === "plugin list --json") {
        return { stdout: JSON.stringify([{ id: "security", enabled: true }]), stderr: "" };
      }
      throw new Error(`Unexpected probe: ${command} ${joined}`);
    }
  });

  const inventory = await registry.discover({ refresh: true });

  assert.equal(inventory.totals.availableAgents, 2);
  assert.equal(inventory.agents[0].models[0].id, "gpt-test-sol");
  assert.ok(inventory.agents[0].tools.some((item) => item.id === "mcp.github"));
  assert.ok(inventory.agents[1].models.some((model) => model.id === "sonnet"));
  assert.ok(inventory.agents[1].models.some((model) => model.id === "opus"));
  assert.ok(inventory.agents[1].models.some((model) => model.id === "fable"));
  assert.ok(inventory.agents[1].models.some((model) => model.id === "claude-fable-5"));
  assert.ok(inventory.agents[1].tools.some((item) => item.id === "mcp.figma"));
  assert.ok(inventory.agents[1].tools.some((item) => item.id === "plugin.security"));
  assert.equal(calls.some((call) => call.args.includes("-p")), false);
});

test("selects a newer native Claude CLI and discovers its Fable model", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-claude-command-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const localCommand = path.join(workspace, ".local", "bin", "claude");
  await mkdir(path.dirname(localCommand), { recursive: true });
  await writeFile(localCommand, "#!/bin/sh\n");
  await chmod(localCommand, 0o755);
  const config = normalizeConfig({
    version: 1,
    workspace,
    agents: [{ id: "claude", adapter: "claude", role: "Review." }]
  }, workspace);
  const calls = [];
  const registry = new CapabilityRegistry({
    config,
    homeDir: workspace,
    probe: async ({ command, args }) => {
      calls.push({ command, args });
      const joined = args.join(" ");
      if (joined === "--version") {
        return {
          stdout: command === localCommand
            ? "2.1.220 (Claude Code)\n"
            : "2.1.139 (Claude Code)\n",
          stderr: ""
        };
      }
      if (command !== localCommand) {
        throw new Error(`Expected the newer Claude command, received ${command}`);
      }
      if (joined === "--help") {
        return {
          stdout: [
            "  --model <model>  Provide an alias (e.g. 'fable', 'opus', or 'sonnet')",
            "                   or a model's full name (e.g. 'claude-fable-5').",
            "  -n, --name <name> Session name"
          ].join("\n"),
          stderr: ""
        };
      }
      if (joined === "mcp list") {
        return { stdout: "No MCP servers configured\n", stderr: "" };
      }
      if (joined === "plugin list --json") {
        return { stdout: "[]", stderr: "" };
      }
      throw new Error(`Unexpected probe: ${command} ${joined}`);
    }
  });

  const inventory = await registry.discover({ refresh: true });
  const claude = inventory.agents[0];

  assert.equal(claude.command, localCommand);
  assert.equal(claude.version, "2.1.220 (Claude Code)");
  assert.ok(claude.models.some((model) => model.id === "fable"));
  assert.ok(claude.models.some((model) => model.id === "claude-fable-5"));
  assert.equal(claude.models.find((model) => model.id === "fable").capabilities.reasoning, 5);
  assert.match(claude.warnings[0], /selected newer/);
  assert.ok(calls.some((call) => call.command === "claude" && call.args[0] === "--version"));
});

test("routes complex and repeatable tasks to different model strengths", () => {
  const config = normalizeConfig({
    version: 1,
    workspace: ".",
    routing: { maxAgents: 2 },
    agents: [
      {
        id: "codex",
        adapter: "codex",
        role: "Primary implementer.",
        models: [
          {
            id: "sol",
            label: "Sol",
            capabilities: profile({ reasoning: 5, coding: 5, review: 5, speed: 2, costEfficiency: 2 })
          },
          {
            id: "luna",
            label: "Luna",
            capabilities: profile({ reasoning: 3, coding: 4, review: 3, speed: 5, costEfficiency: 5 })
          }
        ]
      },
      {
        id: "claude",
        adapter: "claude",
        role: "Peer reviewer.",
        models: [
          {
            id: "opus",
            label: "Opus",
            capabilities: profile({ reasoning: 5, coding: 5, review: 5, speed: 2, costEfficiency: 1 })
          },
          {
            id: "sonnet",
            label: "Sonnet",
            capabilities: profile({ reasoning: 4, coding: 5, review: 4, speed: 4, costEfficiency: 3 })
          }
        ]
      }
    ]
  }, process.cwd());
  const inventory = inventoryFromConfig(config);

  const complex = routeTask("实现复杂架构迁移，并进行严格审查和验证", inventory, config);
  assert.deepEqual(complex.profile.kinds, ["implementation", "review", "complex"]);
  assert.equal(complex.assignments[0].agentId, "codex");
  assert.equal(complex.assignments[0].model, "sol");
  assert.equal(complex.assignments[1].agentId, "claude");
  assert.equal(complex.assignments[1].model, "opus");
  assert.equal(complex.assignments[0].effort, "high");

  const repeatable = routeTask("批量提取并格式化简单记录", inventory, config);
  assert.equal(repeatable.profile.complexity, "low");
  assert.equal(repeatable.assignments.find((item) => item.agentId === "codex").model, "luna");
  assert.equal(repeatable.assignments.find((item) => item.agentId === "claude").model, "sonnet");
});

test("persists the routing snapshot and passes its model and effort to the adapter", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-routing-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    routing: { maxAgents: 1 },
    agents: [{
      id: "worker",
      adapter: "mock",
      role: "Process well-defined tasks.",
      models: [
        {
          id: "deep",
          capabilities: profile({ reasoning: 5, speed: 2, costEfficiency: 2 })
        },
        {
          id: "fast",
          capabilities: profile({ reasoning: 2, speed: 5, costEfficiency: 5 })
        }
      ]
    }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(DEFAULT_SCHEMA_PATH);
  const captured = {};
  const orchestrator = new Orchestrator({
    config,
    store,
    schema,
    schemaPath: DEFAULT_SCHEMA_PATH,
    adapterOverrides: {
      worker: {
        describe: () => ({ kind: "capture", command: null, safety: "test" }),
        runTurn: async ({ model, effort, prompt }) => {
          captured.model = model;
          captured.effort = effort;
          captured.prompt = prompt;
          return {
            response: {
              summary: "Batch completed.",
              status: "done",
              messages: [],
              artifacts: [],
              needsUser: false
            },
            tracePath: null
          };
        }
      }
    }
  });

  const task = await orchestrator.createTask("批量格式化简单记录");
  assert.equal(task.routing.strategy, "capability-aware");
  assert.equal(task.routing.assignments[0].model, "fast");
  assert.equal(task.participants.worker.assignment.model, "fast");

  const completed = await orchestrator.runTask(task.id);
  assert.equal(completed.status, "completed");
  assert.equal(captured.model, "fast");
  assert.equal(captured.effort, "low");
  assert.match(captured.prompt, /Capability-aware assignment/);
  assert.equal(completed.turns[0].model, "fast");
});

test("classifies research and visual requirements as tool requirements", () => {
  const task = classifyTask("调研最新 UI 截图并写一份报告");
  assert.ok(task.kinds.includes("research"));
  assert.ok(task.kinds.includes("vision"));
  assert.ok(task.kinds.includes("writing"));
  assert.ok(task.requiredTools.includes("web.search"));
  assert.ok(task.requiredTools.includes("image.input"));
});

test("drops handoffs to configured agents that were not assigned to the task", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-routing-targets-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    routing: { maxAgents: 1 },
    agents: [
      { id: "selected", adapter: "mock", role: "Primary implementer." },
      { id: "standby", adapter: "mock", role: "Standby specialist." }
    ]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(DEFAULT_SCHEMA_PATH);
  const orchestrator = new Orchestrator({
    config,
    store,
    schema,
    schemaPath: DEFAULT_SCHEMA_PATH,
    adapterOverrides: {
      selected: {
        describe: () => ({ kind: "capture", command: null, safety: "test" }),
        runTurn: async () => ({
          response: {
            summary: "Selected worker completed.",
            status: "done",
            messages: [{ to: "standby", body: "This target is outside the task roster." }],
            artifacts: [],
            needsUser: false
          },
          tracePath: null
        })
      },
      standby: {
        describe: () => ({ kind: "capture", command: null, safety: "test" }),
        runTurn: async () => {
          throw new Error("Standby must not run");
        }
      }
    }
  });

  const task = await orchestrator.createTask("Implement a focused change.");
  const completed = await orchestrator.runTask(task.id);
  assert.deepEqual(Object.keys(completed.participants), ["selected"]);
  assert.equal(completed.messages.some((message) => message.to === "standby"), false);
});

function profile(overrides = {}) {
  return {
    coding: 3,
    review: 3,
    reasoning: 3,
    research: 3,
    writing: 3,
    vision: 3,
    speed: 3,
    costEfficiency: 3,
    ...overrides
  };
}
