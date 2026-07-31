import "./_hang-watchdog.mjs";
// Regression tests for provider discovery parsers.
//
// Provenance: `tests/fixtures/cli/claude-help.txt` is verbatim output from
// `claude --help` (Claude Code 2.1.220). `claude-mcp-list.txt` reproduces the
// exact line shape of `claude mcp list` with the server names replaced by
// neutral ones, so a real configuration is never committed.
//
// These fixtures exist because the previous hand-written single-line help string
// hid two parser bugs: the real help wraps option descriptions across indented
// lines, and real MCP names contain spaces and punctuation.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CapabilityRegistry, routeTask } from "../src/capabilities.js";
import { normalizeConfig } from "../src/config.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cli");

const readFixture = (name) => readFile(path.join(FIXTURES, name), "utf8");

// Subcommand probes are gated on the CLI declaring the subcommand, so a fake
// help text has to carry a Commands section like the real one does.
const MINIMAL_HELP = [
  "Usage: claude [options] [command] [prompt]",
  "",
  "Commands:",
  "  mcp                                   Configure and manage MCP servers",
  "  plugin|plugins                        Manage Claude Code plugins",
  ""
].join("\n");

async function discoverClaude({ help = MINIMAL_HELP, mcp, plugins = "[]", agent = {} } = {}) {
  const config = normalizeConfig({
    version: 1,
    workspace: process.cwd(),
    agents: [{ id: "claude", adapter: "claude", role: "Review.", ...agent }]
  }, process.cwd());
  const registry = new CapabilityRegistry({
    config,
    probe: async ({ args }) => {
      const joined = args.join(" ");
      if (joined === "--version") return { stdout: "2.1.220 (Claude Code)\n", stderr: "" };
      if (joined === "--help") return { stdout: help, stderr: "" };
      if (joined === "mcp list") return { stdout: mcp, stderr: "" };
      if (joined === "plugin list --json") return { stdout: plugins, stderr: "" };
      throw new Error(`Unexpected probe: ${joined}`);
    }
  });
  const inventory = await registry.discover({ refresh: true });
  return { config, inventory, agent: inventory.agents[0] };
}

test("reads model aliases out of the wrapped real --help output", async () => {
  const help = await readFixture("claude-help.txt");
  const { agent } = await discoverClaude({ help, mcp: "" });
  const byId = new Map(agent.models.map((model) => [model.id, model]));

  // The real help wraps these onto continuation lines below `--model`.
  for (const id of ["fable", "opus", "sonnet"]) {
    assert.ok(byId.has(id), `expected alias ${id}`);
    assert.equal(byId.get(id).availability, "advertised");
    assert.equal(byId.get(id).routable, true);
  }
  assert.ok(byId.has("claude-fable-5"), "expected the full model name");
  assert.equal(byId.get("claude-fable-5").availability, "advertised");
});

test("keeps aliases this CLI build does not advertise visible but unroutable", async () => {
  const help = await readFixture("claude-help.txt");
  const { agent } = await discoverClaude({ help, mcp: "" });
  const haiku = agent.models.find((model) => model.id === "haiku");

  // The installed help text never names `haiku`, so routing must not pick it.
  assert.ok(haiku, "known aliases stay visible in the inventory");
  assert.equal(haiku.availability, "unverified");
  assert.equal(haiku.routable, false);
});

test("falls back to the provider default when nothing is confirmed routable", async () => {
  const { agent } = await discoverClaude({ help: "no options here", mcp: "" });
  const routable = agent.models.filter((model) => model.routable !== false);

  assert.equal(routable.length, 1);
  assert.equal(routable[0].source, "provider-default");
});

test("an explicitly configured model overrides an unverified discovery result", async () => {
  const help = await readFixture("claude-help.txt");
  const { agent } = await discoverClaude({ help, mcp: "", agent: { model: "haiku" } });
  const haiku = agent.models.find((model) => model.id === "haiku");

  assert.equal(haiku.availability, "configured");
  assert.equal(haiku.routable, true);
});

test("parses MCP servers whose names contain spaces and punctuation", async () => {
  const mcp = await readFixture("claude-mcp-list.txt");
  const { agent } = await discoverClaude({ mcp });
  const servers = agent.tools.filter((item) => item.kind === "mcp");
  const byLabel = new Map(servers.map((item) => [item.label, item]));

  assert.equal(servers.length, 5, "every configured server is detected");
  assert.ok(byLabel.has("claude.ai S&P Example"), "names may contain spaces and &");
  assert.equal(byLabel.get("figma").available, true);
  assert.equal(byLabel.get("figma").id, "mcp.figma");
});

test("treats an unauthenticated or failed MCP server as unavailable", async () => {
  const mcp = await readFixture("claude-mcp-list.txt");
  const { agent } = await discoverClaude({ mcp });
  const byLabel = new Map(agent.tools.map((item) => [item.label, item]));

  assert.equal(byLabel.get("claude.ai S&P Example").available, false);
  assert.equal(byLabel.get("broken-server").available, false);
  assert.equal(byLabel.get("local-tools").available, true);
});

test("skips the health-check preamble instead of reading it as a server", async () => {
  const mcp = await readFixture("claude-mcp-list.txt");
  const { agent } = await discoverClaude({ mcp });

  assert.equal(
    agent.tools.some((item) => /Checking MCP/i.test(item.label)),
    false
  );
});

test("only probes subcommands the installed CLI advertises", async () => {
  const help = await readFixture("claude-help.txt");
  const probed = [];
  const config = normalizeConfig({
    version: 1,
    workspace: process.cwd(),
    agents: [{ id: "claude", adapter: "claude", role: "Review." }]
  }, process.cwd());
  const registry = new CapabilityRegistry({
    config,
    probe: async ({ args }) => {
      probed.push(args.join(" "));
      if (args.join(" ") === "--version") return { stdout: "2.1.220 (Claude Code)\n", stderr: "" };
      if (args.join(" ") === "--help") return { stdout: help, stderr: "" };
      if (args.join(" ") === "mcp list") return { stdout: "", stderr: "" };
      if (args.join(" ") === "plugin list --json") return { stdout: "[]", stderr: "" };
      throw new Error(`Unexpected probe: ${args.join(" ")}`);
    }
  });

  await registry.discover({ refresh: true });

  // An unrecognised subcommand is read as a prompt by the CLI and would bill a
  // model call, so every probe must be one the help output declares.
  assert.deepEqual(probed, ["--version", "--help", "mcp list", "plugin list --json"]);
});

test("issues no subcommand probes when the help text cannot be read", async () => {
  const probed = [];
  const config = normalizeConfig({
    version: 1,
    workspace: process.cwd(),
    agents: [{ id: "claude", adapter: "claude", role: "Review." }]
  }, process.cwd());
  const registry = new CapabilityRegistry({
    config,
    probe: async ({ args }) => {
      probed.push(args.join(" "));
      if (args.join(" ") === "--version") return { stdout: "2.1.220 (Claude Code)\n", stderr: "" };
      throw new Error("help unavailable");
    }
  });

  const inventory = await registry.discover({ refresh: true });

  assert.deepEqual(probed, ["--version", "--help"]);
  assert.ok(inventory.agents[0].warnings.some((warning) => /Skipped Claude subcommand/.test(warning)));
});

test("routes a review task to a confirmed alias rather than an unverified one", async () => {
  const help = await readFixture("claude-help.txt");
  const { config, inventory } = await discoverClaude({ help, mcp: "" });
  const plan = routeTask("审查这次改动的安全风险", inventory, config);
  const chosen = plan.assignments[0];
  const model = inventory.agents[0].models.find((item) => item.id === chosen.model);

  assert.notEqual(chosen.model, "haiku");
  assert.equal(model.routable, true);
});
