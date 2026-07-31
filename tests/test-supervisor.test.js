import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPERVISOR = path.resolve(
  REPO_ROOT,
  "tools",
  "run-tests.mjs"
);
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

const runCommand = (command, args, options = {}) => new Promise((resolve) => {
  execFile(command, args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options
  }, (error, stdout, stderr) => {
    resolve({
      code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      signal: error?.signal ?? null,
      stdout,
      stderr
    });
  });
});

const runSupervisor = (args, env) => runCommand(
  process.execPath,
  [SUPERVISOR, ...args],
  {
    env: { ...process.env, ...env },
    timeout: 30_000
  }
);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitForJson(filePath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      await sleep(20);
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function stopOwnedProcess(pid) {
  if (!isAlive(pid)) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

// The per-file watchdog runs inside test workers; the hang observed in review
// was the PARENT runner idling after workers went quiet. Only an external
// supervisor of the whole `node --test` tree can convert that into a failure.
test("the supervisor kills a hung test run at the deadline and exits 124", async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-office-supervisor-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const hanging = path.join(scratch, "forever.test.mjs");
  await writeFile(hanging, `
    import test from "node:test";
    test("hangs forever", () => new Promise(() => { setInterval(() => {}, 1000); }));
  `);

  const result = await runSupervisor(
    ["--test-timeout=600000", hanging],
    { AGENT_OFFICE_TEST_DEADLINE_MS: "3000" }
  );

  assert.equal(result.code, 124, "a hang must become a distinct, nonzero exit");
  assert.match(result.stderr, /exceeded the 3000 ms deadline/);
  assert.match(result.stderr, /surviving processes/);
});

for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`${signal} on the supervisor also terminates its runner and worker`, async (context) => {
    if (process.platform === "win32") return;
    const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-office-supervisor-signal-"));
    context.after(() => rm(scratch, { recursive: true, force: true }));
    const marker = path.join(scratch, "pids.json");
    const hanging = path.join(scratch, "signal.test.mjs");
    await writeFile(hanging, `
      import test from "node:test";
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
        workerPid: process.pid,
        runnerPid: process.ppid
      }));
      test("hangs forever", () => new Promise(() => { setInterval(() => {}, 1000); }));
    `);

    const supervisor = spawn(process.execPath, [SUPERVISOR, hanging], {
      env: { ...process.env, AGENT_OFFICE_TEST_DEADLINE_MS: "60000" },
      stdio: "ignore"
    });
    const ids = await waitForJson(marker);
    context.after(() => {
      stopOwnedProcess(ids.workerPid);
      stopOwnedProcess(ids.runnerPid);
      stopOwnedProcess(supervisor.pid);
    });
    const exited = new Promise((resolve) => {
      supervisor.once("close", (code, childSignal) => resolve({ code, signal: childSignal }));
    });

    supervisor.kill(signal);
    const result = await Promise.race([
      exited,
      sleep(3000).then(() => ({ timedOut: true }))
    ]);

    assert.deepEqual(result, { code: exitCode, signal: null });
    assert.equal(isAlive(ids.runnerPid), false, "the runner survived its supervisor");
    assert.equal(isAlive(ids.workerPid), false, "the test worker survived its supervisor");
  });
}

test("the deadline kills descendants that create their own process group", async (context) => {
  if (process.platform === "win32") return;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-office-supervisor-detached-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, "detached.json");
  const hanging = path.join(scratch, "detached.test.mjs");
  await writeFile(hanging, `
    import test from "node:test";
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const detached = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore"
    });
    detached.unref();
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ detachedPid: detached.pid }));
    test("hangs forever", () => new Promise(() => { setInterval(() => {}, 1000); }));
  `);
  const markerPromise = waitForJson(marker);
  const resultPromise = runSupervisor(
    ["--test-timeout=600000", hanging],
    { AGENT_OFFICE_TEST_DEADLINE_MS: "2000" }
  );
  const ids = await markerPromise;
  context.after(() => stopOwnedProcess(ids.detachedPid));

  const result = await resultPromise;

  assert.equal(result.code, 124);
  assert.equal(isAlive(ids.detachedPid), false, "a detached test descendant survived the deadline");
});

test("the deadline does not depend on ps to kill a detached descendant", async (context) => {
  if (process.platform === "win32") return;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-office-supervisor-no-ps-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, "detached.json");
  const hanging = path.join(scratch, "detached.test.mjs");
  await writeFile(hanging, `
    import test from "node:test";
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const detached = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore"
    });
    detached.unref();
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ detachedPid: detached.pid }));
    test("hangs forever", () => new Promise(() => { setInterval(() => {}, 1000); }));
  `);
  const markerPromise = waitForJson(marker);
  const resultPromise = runSupervisor(
    ["--test-timeout=600000", hanging],
    { AGENT_OFFICE_TEST_DEADLINE_MS: "2000", PATH: scratch }
  );
  const ids = await markerPromise;
  context.after(() => stopOwnedProcess(ids.detachedPid));

  const result = await resultPromise;

  assert.equal(result.code, 124);
  assert.equal(isAlive(ids.detachedPid), false, "cleanup silently degraded when ps was unavailable");
});

test("the deadline kills a detached descendant after its launcher exits", async (context) => {
  if (process.platform === "win32") return;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-office-supervisor-reparented-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, "reparented.json");
  const launcher = path.join(scratch, "launcher.mjs");
  const hanging = path.join(scratch, "reparented.test.mjs");
  await writeFile(launcher, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const detached = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore"
    });
    detached.unref();
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
      launcherPid: process.pid,
      detachedPid: detached.pid
    }));
  `);
  await writeFile(hanging, `
    import test from "node:test";
    import { spawn } from "node:child_process";
    const launcher = spawn(process.execPath, [${JSON.stringify(launcher)}], {
      detached: true,
      stdio: "ignore"
    });
    launcher.unref();
    test("hangs forever", () => new Promise(() => { setInterval(() => {}, 1000); }));
  `);
  const markerPromise = waitForJson(marker);
  const resultPromise = runSupervisor(
    ["--test-timeout=600000", hanging],
    { AGENT_OFFICE_TEST_DEADLINE_MS: "2500" }
  );
  const ids = await markerPromise;
  context.after(() => {
    stopOwnedProcess(ids.launcherPid);
    stopOwnedProcess(ids.detachedPid);
  });
  for (let attempt = 0; attempt < 100 && isAlive(ids.launcherPid); attempt += 1) await sleep(10);
  assert.equal(isAlive(ids.launcherPid), false, "the launcher must exit before the deadline probe");

  const result = await resultPromise;

  assert.equal(result.code, 124);
  assert.equal(isAlive(ids.detachedPid), false, "a reparented detached descendant escaped cleanup");
});

test("a successful test run still cleans up an unrefed detached child", async (context) => {
  if (process.platform === "win32") return;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-office-supervisor-success-detached-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, "detached.json");
  const passing = path.join(scratch, "detached-success.test.mjs");
  await writeFile(passing, `
    import test from "node:test";
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const detached = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore"
    });
    detached.unref();
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ detachedPid: detached.pid }));
    test("passes", () => assert.equal(1, 1));
  `);
  const markerPromise = waitForJson(marker);
  const resultPromise = runSupervisor([passing], {});
  const ids = await markerPromise;
  context.after(() => stopOwnedProcess(ids.detachedPid));

  const result = await resultPromise;

  assert.equal(result.code, 0);
  assert.equal(isAlive(ids.detachedPid), false, "a green test run leaked a detached child");
});

test("a Worker exit cannot erase its detached host process from the ledger", async (context) => {
  if (process.platform === "win32") return;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-office-supervisor-worker-pid-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, "detached.json");
  const detachedProgram = path.join(scratch, "detached-worker.mjs");
  const hanging = path.join(scratch, "worker-pid.test.mjs");
  await writeFile(detachedProgram, `
    import { writeFileSync } from "node:fs";
    import { Worker } from "node:worker_threads";
    const worker = new Worker("void 0", { eval: true });
    worker.once("exit", () => {
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ detachedPid: process.pid }));
      setInterval(() => {}, 1000);
    });
  `);
  await writeFile(hanging, `
    import test from "node:test";
    import { spawn } from "node:child_process";
    const detached = spawn(process.execPath, [${JSON.stringify(detachedProgram)}], {
      detached: true,
      stdio: "ignore"
    });
    detached.unref();
    test("hangs forever", () => new Promise(() => { setInterval(() => {}, 1000); }));
  `);
  const markerPromise = waitForJson(marker);
  const resultPromise = runSupervisor(
    ["--test-timeout=600000", hanging],
    { AGENT_OFFICE_TEST_DEADLINE_MS: "2500" }
  );
  const ids = await markerPromise;
  context.after(() => stopOwnedProcess(ids.detachedPid));

  const result = await resultPromise;

  assert.equal(result.code, 124);
  assert.equal(isAlive(ids.detachedPid), false, "a Worker stop event hid its live host process");
});

test("a repeated SIGINT cannot bypass asynchronous cleanup", async (context) => {
  if (process.platform === "win32") return;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-office-supervisor-repeat-signal-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, "pids.json");
  const hanging = path.join(scratch, "signal.test.mjs");
  await writeFile(hanging, `
    import test from "node:test";
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
      workerPid: process.pid,
      runnerPid: process.ppid
    }));
    test("hangs forever", () => new Promise(() => { setInterval(() => {}, 1000); }));
  `);

  const supervisor = spawn(process.execPath, [SUPERVISOR, hanging], {
    env: {
      ...process.env,
      AGENT_OFFICE_TEST_DEADLINE_MS: "60000"
    },
    stdio: "ignore"
  });
  const ids = await waitForJson(marker);
  context.after(() => {
    stopOwnedProcess(ids.workerPid);
    stopOwnedProcess(ids.runnerPid);
    stopOwnedProcess(supervisor.pid);
  });
  const exited = new Promise((resolve) => {
    supervisor.once("close", (code, signal) => resolve({ code, signal }));
  });

  supervisor.kill("SIGINT");
  await sleep(50);
  supervisor.kill("SIGINT");
  const result = await Promise.race([
    exited,
    sleep(3000).then(() => ({ timedOut: true }))
  ]);

  assert.deepEqual(result, { code: 130, signal: null });
  assert.equal(isAlive(ids.runnerPid), false, "the runner survived repeated SIGINT");
  assert.equal(isAlive(ids.workerPid), false, "the worker survived repeated SIGINT");
});

test("the supervisor passes a successful run through unchanged", async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-office-supervisor-ok-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const passing = path.join(scratch, "fine.test.mjs");
  await writeFile(passing, `
    import test from "node:test";
    import assert from "node:assert/strict";
    test("passes", () => assert.equal(1, 1));
  `);

  const result = await runSupervisor([passing], {});

  assert.equal(result.code, 0);
});

test("the supervisor propagates a failing run's exit code", async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-office-supervisor-fail-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const failing = path.join(scratch, "fails.test.mjs");
  await writeFile(failing, `
    import test from "node:test";
    import assert from "node:assert/strict";
    test("fails", () => assert.equal(1, 2));
  `);

  const result = await runSupervisor([failing], {});

  assert.equal(result.code, 1, "test failures must stay visible through the supervisor");
});

test("the process ledger preserves promisified execFile semantics", async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-office-supervisor-promisify-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const passing = path.join(scratch, "promisify.test.mjs");
  await writeFile(passing, `
    import test from "node:test";
    import assert from "node:assert/strict";
    import { execFile } from "node:child_process";
    import { promisify } from "node:util";
    test("keeps the native result object", async () => {
      const pending = promisify(execFile)(process.execPath, ["-e", "process.stdout.write('ok')"]);
      assert.ok(pending.child?.pid > 0);
      const result = await pending;
      assert.equal(result.stdout, "ok");
      assert.equal(result.stderr, "");
    });
  `);

  const result = await runSupervisor([passing], {});

  assert.equal(result.code, 0, result.stdout + result.stderr);
});

test("the process ledger tracks a detached promisified execFile child", async (context) => {
  if (process.platform === "win32") return;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-office-supervisor-promisify-detached-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, "detached.json");
  const hanging = path.join(scratch, "promisify-detached.test.mjs");
  const python = [
    "import json, os, time",
    "os.setsid()",
    `open(${JSON.stringify(marker)}, "w").write(json.dumps({"detachedPid": os.getpid()}))`,
    "time.sleep(60)"
  ].join("; ");
  await writeFile(hanging, `
    import test from "node:test";
    import { execFile } from "node:child_process";
    import { promisify } from "node:util";
    test("hangs in a detached execFile", async () => {
      await promisify(execFile)("/usr/bin/python3", ["-c", ${JSON.stringify(python)}]);
    });
  `);
  const markerPromise = waitForJson(marker);
  const resultPromise = runSupervisor(
    ["--test-timeout=600000", hanging],
    { AGENT_OFFICE_TEST_DEADLINE_MS: "2500" }
  );
  const ids = await markerPromise;
  context.after(() => stopOwnedProcess(ids.detachedPid));

  const result = await resultPromise;

  assert.equal(result.code, 124);
  assert.equal(isAlive(ids.detachedPid), false, "promisify.custom bypassed child registration");
});

test("a timed-out command helper never reports success", async () => {
  const result = await runCommand(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)"],
    { timeout: 50 }
  );

  assert.notEqual(result.code, 0);
});

test("the published package runs at least one real test", { timeout: 60_000 }, async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-office-package-test-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const cache = path.join(scratch, "npm-cache");
  const installRoot = path.join(scratch, "install");
  await mkdir(installRoot, { recursive: true });
  await writeFile(path.join(installRoot, "package.json"), JSON.stringify({ private: true }));

  const packed = await runCommand(
    NPM,
    ["pack", "--json", "--pack-destination", scratch, "--cache", cache],
    { cwd: REPO_ROOT }
  );
  assert.equal(packed.code, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  const installed = await runCommand(
    NPM,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(scratch, filename)],
    { cwd: installRoot, env: { ...process.env, npm_config_cache: cache } }
  );
  assert.equal(installed.code, 0, installed.stderr);

  const packageTest = await runCommand(
    NPM,
    ["test", "--", "--test-name-pattern=reads tokens from a real Codex"],
    {
      cwd: path.join(installRoot, "node_modules", "agent-office"),
      env: { ...process.env, AGENT_OFFICE_TEST_DEADLINE_MS: "60000" }
    }
  );
  assert.equal(packageTest.code, 0, packageTest.stderr);
  const passCount = Number(packageTest.stdout.match(/(?:#|ℹ)\s*pass\s+(\d+)/)?.[1] ?? 0);
  assert.ok(
    passCount > 0,
    `published npm test passed ${passCount} real tests:\n${packageTest.stdout}`
  );
});
