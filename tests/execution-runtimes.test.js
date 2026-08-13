import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { normalizeConfig } from "../src/config.js";
import { HerdrExecutionRuntime, ProcessExecutionRuntime } from "../src/execution-runtimes.js";
import { TaskStore } from "../src/store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_HERDR = path.join(ROOT, "tests", "fixtures", "fake-herdr.js");

test("targets a dedicated Herdr session and gives long node ids collision-safe bindings", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-herdr-runtime-"));
  const stateDir = `${workspace}-state`;
  context.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });
  const wrapper = path.join(workspace, "fake-herdr");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexport FAKE_HERDR_START_TRANSIENT=1\nexport FAKE_HERDR_PROMPT_TRANSIENT=1\nexec "${process.execPath}" "${FAKE_HERDR}" "$@"\n`
  );
  await chmod(wrapper, 0o755);
  const config = normalizeConfig({
    version: 1,
    workspace,
    stateDir,
    execution: {
      runtime: "herdr",
      herdrCommand: wrapper,
      herdrSession: "ao-contract-test",
      herdrServerMode: "external",
      herdrPathPrefixes: ["/Applications/AgentTools"]
    },
    agents: [{
      id: "codex",
      adapter: "codex",
      herdrKind: "codex",
      herdrArgs: ["--sandbox", "read-only"],
      role: "Work."
    }]
  }, workspace);
  const store = new TaskStore(config.stateDir);
  const runtime = new HerdrExecutionRuntime({ config, store });
  const task = { id: "task-20260813-abcdef12" };
  const resultDirectory = path.join(stateDir, "turn-drop");
  const first = await runtime.ensureAgent({
    task,
    node: { id: `long-${"a".repeat(50)}-one`, type: "agent", owner: "codex" },
    workspace,
    resultDirectory,
    existingBinding: null
  });
  const second = await runtime.ensureAgent({
    task,
    node: { id: `long-${"a".repeat(50)}-two`, type: "agent", owner: "codex" },
    workspace,
    resultDirectory,
    existingBinding: null
  });

  assert.notEqual(first.agentName, second.agentName);
  assert.ok(first.agentName.length <= 32);
  assert.ok(second.agentName.length <= 32);
  assert.equal(first.kind, "codex");
  assert.match(first.terminalId, /^term-/);
  assert.match(first.agentSession.value, /^session-/);
  const fakeState = JSON.parse(await readFile(path.join(workspace, ".fake-herdr.json"), "utf8"));
  assert.ok(fakeState.calls.length > 0);
  assert.ok(fakeState.calls.every((call) => call.session === "ao-contract-test"));
  assert.deepEqual(config.execution.herdrPathPrefixes, ["/Applications/AgentTools"]);
  const start = fakeState.calls.find((call) => call.args[0] === "agent" && call.args[1] === "start");
  assert.deepEqual(
    start.args.slice(-5),
    ["--", "--sandbox", "read-only", "--add-dir", resultDirectory]
  );
  assert.equal(
    fakeState.calls.filter((call) => call.args[0] === "agent" && call.args[1] === "start").length,
    3,
    "the first shell race should be retried once for each independent binding"
  );

  const handle = await runtime.dispatch({
    binding: first,
    prompt: "Complete this turn.",
    timeoutMs: 10_000,
    attemptToken: "attempt"
  });
  await runtime.wait(handle);
  const promptedState = JSON.parse(await readFile(path.join(workspace, ".fake-herdr.json"), "utf8"));
  const promptCalls = promptedState.calls.filter((call) => (
    call.args[0] === "agent" && call.args[1] === "prompt"
  ));
  assert.equal(promptCalls.length, 2, "a transient missing target should retry the prompt exactly once");
  const promptCall = promptCalls.at(-1);
  assert.ok(promptCall.args.includes("idle"));
  assert.ok(promptCall.args.includes("done"));
  assert.ok(!promptCall.args.includes("blocked"), "permission prompts must not settle a workflow attempt");
});

test("command workflow runtime exposes only allowlisted environment variables", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-env-runtime-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new TaskStore(path.join(workspace, "state"));
  await store.init();
  const config = { workspace };
  const runtime = new ProcessExecutionRuntime({ config, store, adapters: new Map() });
  const previousSecret = process.env.AO_UNDECLARED_SECRET;
  const previousAllowed = process.env.AO_ALLOWED_VALUE;
  process.env.AO_UNDECLARED_SECRET = "must-not-leak";
  process.env.AO_ALLOWED_VALUE = "allowed-value";
  context.after(() => {
    if (previousSecret === undefined) delete process.env.AO_UNDECLARED_SECRET;
    else process.env.AO_UNDECLARED_SECRET = previousSecret;
    if (previousAllowed === undefined) delete process.env.AO_ALLOWED_VALUE;
    else process.env.AO_ALLOWED_VALUE = previousAllowed;
  });
  const node = {
    id: "env",
    type: "command",
    command: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({allowed:process.env.AO_ALLOWED_VALUE,secret:process.env.AO_UNDECLARED_SECRET??null}))"],
    envKeys: ["AO_ALLOWED_VALUE"]
  };
  const handle = await runtime.dispatch({
    node,
    attemptToken: "attempt",
    workspace,
    timeoutMs: 10_000
  });
  const result = await runtime.wait(handle);
  assert.match(result.response.summary, /allowed-value/);
  assert.doesNotMatch(result.response.summary, /must-not-leak/);
  assert.match(result.response.summary, /"secret":null/);
});
