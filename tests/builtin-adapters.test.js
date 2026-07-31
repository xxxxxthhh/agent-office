import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { normalizeConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { loadTurnSchema } from "../src/protocol.js";
import { TaskStore } from "../src/store.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(PACKAGE_ROOT, "schemas", "turn.schema.json");
const FAKE_CODEX_PATH = path.join(PACKAGE_ROOT, "tests", "fixtures", "fake-codex.js");
const FAKE_CLAUDE_PATH = path.join(PACKAGE_ROOT, "tests", "fixtures", "fake-claude.js");

test("Codex and Claude adapters exchange a structured peer handoff", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-builtins-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir: ".state",
    collaboration: { maxRounds: 2, transcriptMessages: 20, turnTimeoutMs: 5000 },
    agents: [
      {
        id: "codex",
        adapter: "codex",
        role: "Produce a structured handoff.",
        command: process.execPath,
        commandArgs: [FAKE_CODEX_PATH],
        sandbox: "workspace-write"
      },
      {
        id: "claude",
        adapter: "claude",
        role: "Verify the handoff.",
        command: process.execPath,
        commandArgs: [FAKE_CLAUDE_PATH],
        permissionMode: "acceptEdits"
      }
    ]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const orchestrator = new Orchestrator({ config, store, schema, schemaPath: SCHEMA_PATH });
  const task = await orchestrator.createTask("Exercise both built-in adapters.");

  const completed = await orchestrator.runTask(task.id);

  assert.equal(completed.status, "completed");
  assert.equal(completed.participants.codex.turns, 1);
  assert.equal(completed.participants.claude.turns, 1);
  assert.match(completed.participants.claude.lastSummary, /verified the Codex handoff/);
  assert.ok(completed.turns[0].tracePath.endsWith(".codex.json"));
  assert.ok(completed.turns[1].tracePath.endsWith(".claude.json"));
});
