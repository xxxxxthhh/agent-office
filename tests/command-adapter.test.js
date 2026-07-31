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
const FIXTURE_PATH = path.join(PACKAGE_ROOT, "tests", "fixtures", "protocol-agent.js");

test("runs a generic command adapter through stdin without shell interpolation", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-command-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir: ".state",
    agents: [{
      id: "custom",
      adapter: "command",
      role: "Confirm the prompt contract.",
      command: process.execPath,
      args: [FIXTURE_PATH]
    }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const schema = await loadTurnSchema(SCHEMA_PATH);
  const orchestrator = new Orchestrator({ config, store, schema, schemaPath: SCHEMA_PATH });
  const task = await orchestrator.createTask("Exercise the generic adapter.");

  const completed = await orchestrator.runTask(task.id);

  assert.equal(completed.status, "completed");
  assert.equal(
    completed.participants.custom.lastSummary,
    "Received the complete collaboration prompt."
  );
  assert.match(completed.turns[0].tracePath, /custom.*command\.txt$/);
});
