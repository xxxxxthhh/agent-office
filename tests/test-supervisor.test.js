import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

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
