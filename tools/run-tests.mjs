#!/usr/bin/env node
// Supervises `node --test` from OUTSIDE the runner. A per-run PID ledger is
// injected through NODE_OPTIONS, so cleanup does not depend on `ps` or on a
// descendant retaining its original parent/process group.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEADLINE_MS = Number(process.env.AGENT_OFFICE_TEST_DEADLINE_MS) || 240_000;
const GRACE_MS = 500;
const EXIT_DELAY_MS = 50;
const HARD_STOP_MS = 5000;
const args = ["--test", ...process.argv.slice(2)];
const runToken = randomUUID();
const ledgerPath = path.join(
  os.tmpdir(),
  `agent-office-test-processes-${process.pid}-${runToken}.jsonl`
);
const guardPath = fileURLToPath(new URL("./_process-ledger.cjs", import.meta.url));

writeFileSync(ledgerPath, "", { encoding: "utf8", mode: 0o600, flag: "wx" });

// A supervisor started by its own node:test meta-tests must create a fresh test
// runner, not inherit the marker that identifies a node:test child process.
const env = {
  ...process.env,
  AGENT_OFFICE_TEST_PID_LEDGER: ledgerPath,
  AGENT_OFFICE_TEST_RUN_TOKEN: runToken
};
delete env.NODE_TEST_CONTEXT;
if (!String(env.NODE_OPTIONS || "").includes(guardPath)) {
  const requireGuard = `--require=${JSON.stringify(guardPath)}`;
  env.NODE_OPTIONS = [env.NODE_OPTIONS, requireGuard].filter(Boolean).join(" ");
}

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env,
  detached: process.platform !== "win32"
});

let shuttingDown = false;
let requestedExitCode = 1;
let finishTimer;
let hardStopTimer;

function appendRunnerToLedger() {
  if (!Number.isInteger(child.pid)) return;
  try {
    writeFileSync(ledgerPath, `${JSON.stringify({
      token: runToken,
      event: "start",
      pid: child.pid,
      ppid: process.pid,
      command: "node --test"
    })}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
  } catch {
    // The process-group fallback below still owns the ordinary tree.
  }
}
appendRunnerToLedger();

function readOwnedProcesses() {
  const active = new Map();
  try {
    for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.token !== runToken || !Number.isInteger(entry.pid) || entry.pid <= 0) continue;
      if (entry.event === "stop") active.delete(entry.pid);
      else if (entry.event === "start") active.set(entry.pid, entry);
    }
  } catch {
    // Seeded below with the runner so a damaged ledger cannot disable the
    // process-group fallback.
  }
  if (Number.isInteger(child.pid) && child.pid > 0 && !active.has(child.pid)) {
    active.set(child.pid, { pid: child.pid, ppid: process.pid, command: "node --test" });
  }
  // Later starts are normally deeper descendants; signal them first.
  return [...active.values()].reverse();
}

function signalPid(pid, signal) {
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

function signalOwnedProcesses(signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 4000 }, () => {});
    return;
  }

  for (const entry of readOwnedProcesses()) signalPid(entry.pid, signal);
  try { process.kill(-child.pid, signal); } catch { /* process group already gone */ }
}

function cleanupLedger() {
  try { rmSync(ledgerPath, { force: true }); } catch { /* best-effort temp cleanup */ }
}

function finish(exitCode) {
  if (finishTimer) return;
  finishTimer = setTimeout(() => {
    clearTimeout(hardStopTimer);
    cleanupLedger();
    process.exit(exitCode);
  }, EXIT_DELAY_MS);
}

function armHardStop(exitCode) {
  clearTimeout(hardStopTimer);
  hardStopTimer = setTimeout(() => {
    signalOwnedProcesses("SIGKILL");
    cleanupLedger();
    process.exit(exitCode);
  }, HARD_STOP_MS);
}

function beginShutdown(signal, exitCode, diagnose) {
  if (shuttingDown) {
    // Keep the handler installed: a second Ctrl-C escalates cleanup instead of
    // restoring the default action and killing only this supervisor.
    signalOwnedProcesses("SIGKILL");
    finish(requestedExitCode);
    return;
  }
  shuttingDown = true;
  requestedExitCode = exitCode;
  clearTimeout(deadline);
  armHardStop(exitCode);

  const processes = readOwnedProcesses();
  if (diagnose) {
    console.error(`\n[test-supervisor] node --test exceeded the ${DEADLINE_MS} ms deadline; surviving processes:`);
    for (const entry of processes.slice().reverse()) {
      console.error(
        `[test-supervisor]   pid=${entry.pid} ppid=${entry.ppid ?? "?"} ${String(entry.command || "").slice(0, 160)}`
      );
    }
  }

  signalOwnedProcesses(signal);
  if (signal === "SIGKILL") {
    finish(exitCode);
    return;
  }
  setTimeout(() => {
    signalOwnedProcesses("SIGKILL");
    finish(exitCode);
  }, GRACE_MS);
}

const deadline = setTimeout(() => beginShutdown("SIGKILL", 124, true), DEADLINE_MS);
deadline.unref();

process.on("SIGINT", () => beginShutdown("SIGINT", 130, false));
process.on("SIGTERM", () => beginShutdown("SIGTERM", 143, false));

child.on("close", (code, signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(deadline);
  // A successful runner can still leave an unref'd detached process behind.
  signalOwnedProcesses("SIGKILL");
  finish(code ?? (signal ? 1 : 0));
});
child.on("error", (error) => {
  clearTimeout(deadline);
  console.error(`[test-supervisor] failed to start node --test: ${error.message}`);
  signalOwnedProcesses("SIGKILL");
  finish(1);
});
