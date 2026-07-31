"use strict";

// Loaded into the test runner and every Node descendant through NODE_OPTIONS.
// It records both the current process and every child launched through Node's
// public child_process API. The supervisor can therefore still identify a
// detached process after its launcher exits and the OS reparents it.
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const ledgerPath = process.env.AGENT_OFFICE_TEST_PID_LEDGER;
const runToken = process.env.AGENT_OFFICE_TEST_RUN_TOKEN;

function record(event, pid, ppid, command) {
  if (!ledgerPath || !runToken || !Number.isInteger(pid) || pid <= 0) return;
  try {
    fs.appendFileSync(ledgerPath, `${JSON.stringify({
      token: runToken,
      event,
      pid,
      ppid,
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
  record("start", child.pid, process.pid, command);
  child.once("exit", () => record("stop", child.pid, process.pid, command));
  return child;
}

record("start", process.pid, process.ppid, `${process.execPath} ${process.argv.slice(1).join(" ")}`);
process.once("exit", () => {
  record("stop", process.pid, process.ppid, `${process.execPath} ${process.argv.slice(1).join(" ")}`);
});

for (const name of ["spawn", "exec", "execFile", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = function guardedChildProcessCall(...args) {
    return trackChild(original.apply(this, args), describeCall(name, args));
  };
}

// Keep `import { spawn } from "node:child_process"` aligned with the patched
// CommonJS exports before application modules are evaluated.
syncBuiltinESMExports();
