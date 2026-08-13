import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { runProcess } from "../src/adapters/process.js";

test("waits for timeout termination and kills the command process tree", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-office-process-tree-"));
  const marker = path.join(directory, "late-write.txt");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const childCode = [
    "const fs = require('node:fs');",
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'late'), 300);`,
    "setInterval(() => {}, 1000);"
  ].join(" ");
  const parentCode = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });`,
    "setInterval(() => {}, 1000);"
  ].join(" ");

  await assert.rejects(
    () => runProcess({
      command: process.execPath,
      args: ["-e", parentCode],
      cwd: directory,
      timeoutMs: 80
    }),
    /timed out after 80 ms/
  );
  await new Promise((resolve) => setTimeout(resolve, 450));
  await assert.rejects(() => access(marker), /ENOENT/);
});
