"use strict";

// Loaded into the test runner and every Node descendant through NODE_OPTIONS.
// It records both the current process and every child launched through Node's
// public child_process API. The supervisor can therefore still identify a
// detached process after its launcher exits and the OS reparents it.
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { syncBuiltinESMExports } = require("node:module");
const { isMainThread } = require("node:worker_threads");

const ledgerPath = process.env.AGENT_OFFICE_TEST_PID_LEDGER;
const runToken = process.env.AGENT_OFFICE_TEST_RUN_TOKEN;
const selfInstanceId = randomUUID();

function record(event, pid, ppid, command, instanceId) {
  if (!ledgerPath || !runToken || !Number.isInteger(pid) || pid <= 0) return;
  try {
    fs.appendFileSync(ledgerPath, `${JSON.stringify({
      token: runToken,
      event,
      pid,
      ppid,
      instanceId,
      command: String(command || "").slice(0, 160)
    })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // The supervisor retains the runner process-group fallback if the ledger
    // itself becomes unavailable. Instrumentation must not break test code.
  }
}

function describeCall(name, args) {
  if (name === "fork") return `${process.execPath} ${String(args[0] || "")}`;
  return String(args[0] || name);
}

function trackChild(child, command) {
  if (!child || !Number.isInteger(child.pid)) return child;
  const instanceId = `spawn:${selfInstanceId}:${randomUUID()}`;
  record("start", child.pid, process.pid, command, instanceId);
  child.once("exit", () => record("stop", child.pid, process.pid, command, instanceId));
  return child;
}

// NODE_OPTIONS preloads this module inside Worker threads too. Workers share
// their host process PID, so only the main thread may describe process lifetime.
// Workers still patch child_process below so children they launch are tracked.
if (isMainThread) {
  const command = `${process.execPath} ${process.argv.slice(1).join(" ")}`;
  record("start", process.pid, process.ppid, command, selfInstanceId);
  process.once("exit", () => record(
    "stop",
    process.pid,
    process.ppid,
    command,
    selfInstanceId
  ));
}

for (const name of ["spawn", "exec", "execFile", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = new Proxy(original, {
    apply(target, thisArgument, args) {
      return trackChild(
        Reflect.apply(target, thisArgument, args),
        describeCall(name, args)
      );
    }
  });
}

// Keep `import { spawn } from "node:child_process"` aligned with the proxies
// before application modules are evaluated. Proxy property access preserves
// native metadata, including util.promisify.custom on exec/execFile.
syncBuiltinESMExports();
