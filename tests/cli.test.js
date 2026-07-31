import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { runProcess } from "../src/adapters/process.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(PACKAGE_ROOT, "bin", "agent-office.js");

test("offline demo completes a review-feedback loop", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "demo"],
    cwd: PACKAGE_ROOT,
    timeoutMs: 10_000
  });

  assert.match(result.stdout, /round 2: builder/);
  assert.match(result.stdout, /— completed/);
  assert.match(result.stdout, /reviewer -> builder: Handle empty input/);
});

test("init, create, list, and show form a usable CLI workflow", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-cli-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const configPath = path.join(workspace, "agent-office.json");

  const initialized = await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "init", workspace],
    cwd: PACKAGE_ROOT,
    timeoutMs: 10_000
  });
  assert.match(initialized.stdout, /Created .*agent-office\.json/);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config.agents.map((agent) => agent.id), ["codex", "claude"]);

  const created = await runProcess({
    command: process.execPath,
    args: [
      CLI_PATH,
      "task",
      "create",
      "--config",
      configPath,
      "--objective",
      "Exercise the complete task CLI."
    ],
    cwd: PACKAGE_ROOT,
    timeoutMs: 10_000
  });
  const taskId = created.stdout.trim();
  assert.match(taskId, /^task-\d{8}-[a-f0-9]{8}$/);

  const listed = await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "task", "list", "--config", configPath],
    cwd: PACKAGE_ROOT,
    timeoutMs: 10_000
  });
  assert.match(listed.stdout, new RegExp(`${taskId}\\s+ready`));

  const shown = await runProcess({
    command: process.execPath,
    args: [CLI_PATH, "task", "show", taskId, "--config", configPath],
    cwd: PACKAGE_ROOT,
    timeoutMs: 10_000
  });
  assert.match(shown.stdout, /Objective: Exercise the complete task CLI\./);
  assert.match(shown.stdout, /codex: idle/);
  assert.match(shown.stdout, /claude: idle/);
});

test("capabilities reports a task-specific routing plan as JSON", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-cli-capabilities-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const configPath = path.join(workspace, "agent-office.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    workspace,
    routing: { maxAgents: 1 },
    agents: [{
      id: "offline",
      adapter: "mock",
      role: "Handle repeatable transformations.",
      models: [{
        id: "fast",
        capabilities: {
          coding: 3,
          review: 3,
          reasoning: 2,
          research: 2,
          writing: 4,
          vision: 2,
          speed: 5,
          costEfficiency: 5
        }
      }]
    }]
  }));

  const result = await runProcess({
    command: process.execPath,
    args: [
      CLI_PATH,
      "capabilities",
      "--config",
      configPath,
      "--objective",
      "批量提取并格式化记录",
      "--json"
    ],
    cwd: PACKAGE_ROOT,
    timeoutMs: 10_000
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.inventory.totals.availableAgents, 1);
  assert.equal(payload.plan.assignments[0].agentId, "offline");
  assert.equal(payload.plan.assignments[0].model, "fast");
});
