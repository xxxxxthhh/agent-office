import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

const SUPERVISOR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "tools",
  "run-tests.mjs"
);

const runSupervisor = (args, env) => new Promise((resolve) => {
  execFile(process.execPath, [SUPERVISOR, ...args], {
    env: { ...process.env, ...env },
    timeout: 30_000
  }, (error, stdout, stderr) => {
    resolve({ code: error?.code ?? 0, stdout, stderr });
  });
});

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

test("the published package includes the tests used by npm test", async () => {
  const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));

  assert.ok(
    packageJson.files.includes("tests/"),
    "the published npm test script would otherwise pass after running zero tests"
  );
});
