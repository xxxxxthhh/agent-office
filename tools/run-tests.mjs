#!/usr/bin/env node
// Supervises `node --test` from OUTSIDE the runner. The per-file watchdog in
// tests/_hang-watchdog.mjs runs inside each test-file worker, so it cannot see
// a parent runner that idles after its workers finish. This wrapper owns the
// complete runner process tree, forwards terminal signals, and enforces a
// wall-clock deadline.
import { spawn, execFile } from "node:child_process";

const DEADLINE_MS = Number(process.env.AGENT_OFFICE_TEST_DEADLINE_MS) || 240_000;
const GRACE_MS = 500;
const args = ["--test", ...process.argv.slice(2)];

// A supervisor started by its own node:test meta-tests must create a fresh test
// runner, not inherit the marker that identifies a node:test child process.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env,
  detached: process.platform !== "win32"
});

let shuttingDown = false;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const execFileResult = (command, commandArgs, options = {}) => new Promise((resolve, reject) => {
  execFile(command, commandArgs, options, (error, stdout = "", stderr = "") => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
});

async function readOwnedProcesses() {
  if (!child.pid || process.platform === "win32") return [];
  try {
    const { stdout } = await execFileResult(
      "ps",
      ["ax", "-o", "pid=,ppid=,etime=,command="],
      { timeout: 2000 }
    );
    const rows = stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      return match && {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        etime: match[3],
        command: match[4],
        depth: 0
      };
    }).filter(Boolean);
    const owned = new Map([[child.pid, {
      pid: child.pid,
      ppid: process.pid,
      etime: "?",
      command: "node --test",
      depth: 0
    }]]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        const parent = owned.get(row.ppid);
        if (parent && !owned.has(row.pid)) {
          owned.set(row.pid, { ...row, depth: parent.depth + 1 });
          grew = true;
        }
      }
    }
    return [...owned.values()].sort((left, right) => right.depth - left.depth);
  } catch {
    return [{ pid: child.pid, ppid: process.pid, etime: "?", command: "node --test", depth: 0 }];
  }
}

function signalPid(pid, signal) {
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

async function signalOwnedTree(processes, signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await execFileResult(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      { timeout: 5000 }
    ).catch(() => {});
    return;
  }

  // Individually signal every captured descendant so children that created
  // their own process groups are covered. The group signal catches ordinary
  // descendants and any child created between the snapshot and this loop.
  for (const entry of processes) signalPid(entry.pid, signal);
  try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
}

async function stopRunner({ signal, exitCode, diagnose }) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(deadline);

  let processes = await readOwnedProcesses();
  if (diagnose) {
    console.error(`\n[test-supervisor] node --test exceeded the ${DEADLINE_MS} ms deadline; surviving processes:`);
    for (const entry of processes.slice().reverse()) {
      console.error(
        `[test-supervisor]   pid=${entry.pid} etime=${entry.etime} ${entry.command.slice(0, 160)}`
      );
    }
  }

  await signalOwnedTree(processes, signal);
  if (signal !== "SIGKILL") {
    await sleep(GRACE_MS);
    // Re-scan before escalation while also retaining processes that may have
    // been reparented after their original parent exited.
    const refreshed = await readOwnedProcesses();
    const byPid = new Map([...processes, ...refreshed].map((entry) => [entry.pid, entry]));
    processes = [...byPid.values()].sort((left, right) => right.depth - left.depth);
    await signalOwnedTree(processes, "SIGKILL");
  }
  await sleep(50);
  process.exit(exitCode);
}

const deadline = setTimeout(() => {
  stopRunner({ signal: "SIGKILL", exitCode: 124, diagnose: true }).catch((error) => {
    console.error(`[test-supervisor] failed to stop timed-out tests: ${error.message}`);
    process.exit(124);
  });
}, DEADLINE_MS);
deadline.unref();

process.once("SIGINT", () => {
  stopRunner({ signal: "SIGINT", exitCode: 130, diagnose: false }).catch(() => process.exit(130));
});
process.once("SIGTERM", () => {
  stopRunner({ signal: "SIGTERM", exitCode: 143, diagnose: false }).catch(() => process.exit(143));
});

child.on("close", (code, signal) => {
  if (shuttingDown) return;
  clearTimeout(deadline);
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", (error) => {
  clearTimeout(deadline);
  console.error(`[test-supervisor] failed to start node --test: ${error.message}`);
  process.exit(1);
});
