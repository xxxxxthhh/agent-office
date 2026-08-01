import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { runCli } from "../src/cli.js";
import { writeStarterConfig } from "../src/config.js";

async function createWorkspace(context) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-office-start-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

function createIo() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    log: (message) => logs.push(String(message)),
    error: (message) => errors.push(String(message))
  };
}

const noSystemProxy = async () => ({ applied: {} });

test("start cancellation leaves an uninitialized project untouched", async (context) => {
  const workspace = await createWorkspace(context);
  const io = createIo();
  let doctorCalled = false;
  let serveCalled = false;

  const code = await runCli(["start"], io, {
    cwd: workspace,
    inheritSystemProxy: noSystemProxy,
    confirmInitialization: async () => false,
    doctor: async () => { doctorCalled = true; return 0; },
    serve: async () => { serveCalled = true; return 0; }
  });

  assert.equal(code, 0);
  await assert.rejects(access(path.join(workspace, "agent-office.json")));
  assert.equal(doctorCalled, false);
  assert.equal(serveCalled, false);
});

test("start initializes after confirmation, checks the environment, and serves", async (context) => {
  const workspace = await createWorkspace(context);
  const io = createIo();
  const calls = [];

  const code = await runCli(["start"], io, {
    cwd: workspace,
    inheritSystemProxy: noSystemProxy,
    confirmInitialization: async () => true,
    doctor: async (configPath) => {
      await access(configPath);
      calls.push(["doctor", configPath]);
      return 0;
    },
    serve: async (configPath, settings) => {
      await access(configPath);
      calls.push(["serve", configPath, settings]);
      return 0;
    }
  });

  const configPath = path.join(workspace, "agent-office.json");
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    ["doctor", configPath],
    ["serve", configPath, { open: true }]
  ]);
  assert.ok(io.logs.some((line) => line.includes("Created") && line.includes(configPath)));
});

test("start reuses an existing configuration without asking to initialize", async (context) => {
  const workspace = await createWorkspace(context);
  const configPath = await writeStarterConfig(workspace);
  const io = createIo();
  const calls = [];

  const code = await runCli(["start"], io, {
    cwd: workspace,
    inheritSystemProxy: async () => {
      calls.push(["network"]);
      return { applied: { HTTPS_PROXY: "http://127.0.0.1:7897" } };
    },
    confirmInitialization: async () => {
      throw new Error("existing configurations must not prompt");
    },
    doctor: async (value) => { calls.push(["doctor", value]); return 0; },
    serve: async (value, settings) => { calls.push(["serve", value, settings]); return 0; }
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    ["network"],
    ["doctor", configPath],
    ["serve", configPath, { open: true }]
  ]);
  assert.ok(io.logs.some((line) => line.includes("macOS system proxy") && line.includes("7897")));
});

test("start refuses to serve when doctor reports an unavailable agent", async (context) => {
  const workspace = await createWorkspace(context);
  const configPath = await writeStarterConfig(workspace);
  const io = createIo();
  let serveCalled = false;

  const code = await runCli(["start"], io, {
    cwd: workspace,
    inheritSystemProxy: noSystemProxy,
    doctor: async (value) => {
      assert.equal(value, configPath);
      return 1;
    },
    serve: async () => { serveCalled = true; return 0; }
  });

  assert.equal(code, 1);
  assert.equal(serveCalled, false);
  assert.ok(io.errors.some((line) => line.includes("Environment check failed")));
});
