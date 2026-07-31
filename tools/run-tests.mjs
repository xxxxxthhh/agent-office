#!/usr/bin/env node
// Supervises `node --test` from OUTSIDE the runner. The per-file watchdog in
// tests/_hang-watchdog.mjs runs inside each test-file worker, so it cannot see
// the hang shape actually observed in review: workers done, only the parent
// runner process idling forever. This wrapper owns the whole process tree and
// enforces a wall-clock deadline on it: on expiry it prints the surviving
// processes, kills the tree, and exits 124 — a diagnosed failure instead of an
// indefinite wait.
import { spawn, execFile } from "node:child_process";

const DEADLINE_MS = Number(process.env.AGENT_OFFICE_TEST_DEADLINE_MS) || 240_000;
const args = ["--test", ...process.argv.slice(2)];

// When the supervisor is itself started from inside a node:test worker (the
// supervisor's own tests do this), the inherited NODE_TEST_CONTEXT would make
// the spawned `node --test` believe it is a test CHILD and exit immediately
// instead of acting as a runner. Always start it as a fresh runner.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env,
  // Group leader, so the deadline can kill stuck grandchildren too.
  detached: process.platform !== "win32"
});

const killTree = (signal) => {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
    return;
  }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
};

const deadline = setTimeout(() => {
  console.error(`\n[test-supervisor] node --test exceeded the ${DEADLINE_MS} ms deadline; surviving processes:`);
  execFile("ps", ["ax", "-o", "pid=,ppid=,etime=,command="], (error, stdout) => {
    if (!error) {
      // Walk the descendants of the runner so the culprit is named.
      const rows = stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        return match && { pid: Number(match[1]), ppid: Number(match[2]), etime: match[3], command: match[4] };
      }).filter(Boolean);
      const tree = new Set([child.pid]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const row of rows) {
          if (tree.has(row.ppid) && !tree.has(row.pid)) { tree.add(row.pid); grew = true; }
        }
      }
      for (const row of rows) {
        if (tree.has(row.pid)) console.error(`[test-supervisor]   pid=${row.pid} etime=${row.etime} ${row.command.slice(0, 160)}`);
      }
    }
    killTree("SIGKILL");
    process.exit(124);
  });
  // ps itself failing must not leave the hang in place.
  setTimeout(() => { killTree("SIGKILL"); process.exit(124); }, 5000).unref();
}, DEADLINE_MS);
deadline.unref();

// The deadline must be able to fire even while we only wait on the child, and
// the child handle itself keeps the loop alive, so unref'd is correct here.
child.on("close", (code, signal) => {
  clearTimeout(deadline);
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", (error) => {
  console.error(`[test-supervisor] failed to start node --test: ${error.message}`);
  process.exit(1);
});
