import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { runProcess } from "../src/adapters/process.js";
import { ConfigError } from "../src/errors.js";
import { matchesAnyScope, WorkspaceManager } from "../src/workspaces.js";

test("creates an isolated worktree once, adopts it after restart, and enforces write scopes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-worktree-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo");
  await mkdir(repository);
  await runProcess({ command: "git", args: ["init"], cwd: repository, timeoutMs: 10_000 });
  await runProcess({ command: "git", args: ["config", "user.email", "test@example.com"], cwd: repository });
  await runProcess({ command: "git", args: ["config", "user.name", "Test"], cwd: repository });
  await mkdir(path.join(repository, "src"));
  await writeFile(path.join(repository, "src", "index.js"), "export const value = 1;\n");
  await runProcess({ command: "git", args: ["add", "."], cwd: repository });
  await runProcess({ command: "git", args: ["commit", "-m", "initial"], cwd: repository });
  const manager = new WorkspaceManager({ config: { workspace: repository } });
  const task = { id: "task-20260813-abcdef12", workflow: { runtime: "process", nodes: {} } };
  const node = {
    id: "build",
    workspace: "worktree",
    workspaceFrom: null,
    access: "write",
    writeScopes: ["src/**"]
  };
  task.workflow.nodes.build = node;

  const first = await manager.resolve(task, node);
  const second = await manager.resolve(task, node);
  assert.equal(second, first);

  const before = await manager.snapshot(first);
  await writeFile(path.join(first, "src", "index.js"), "export const value = 2;\n");
  const after = await manager.snapshot(first);
  assert.deepEqual(manager.validateChanges(node, before, after), ["src/index.js"]);

  await writeFile(path.join(first, "README.md"), "outside\n");
  const outside = await manager.snapshot(first);
  assert.throws(() => manager.validateChanges(node, before, outside), ConfigError);
});

test("detects edits to an already dirty file and supports bounded glob syntax", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-dirty-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await runProcess({ command: "git", args: ["init"], cwd: root });
  await runProcess({ command: "git", args: ["config", "user.email", "test@example.com"], cwd: root });
  await runProcess({ command: "git", args: ["config", "user.name", "Test"], cwd: root });
  await writeFile(path.join(root, "dirty.txt"), "clean\n");
  await runProcess({ command: "git", args: ["add", "."], cwd: root });
  await runProcess({ command: "git", args: ["commit", "-m", "initial"], cwd: root });
  await writeFile(path.join(root, "dirty.txt"), "first dirty\n");
  const manager = new WorkspaceManager({ config: { workspace: root } });
  const before = await manager.snapshot(root);
  await writeFile(path.join(root, "dirty.txt"), "second dirty\n");
  const after = await manager.snapshot(root);
  assert.throws(
    () => manager.validateChanges({ id: "read", access: "read_only", writeScopes: [] }, before, after),
    /modified the workspace/
  );
  assert.equal(matchesAnyScope("src/lib/a.js", ["src/**"]), true);
  assert.equal(matchesAnyScope("test/a.js", ["src/**"]), false);
});

test("does not treat Agent Office control-state writes as project edits", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-control-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await runProcess({ command: "git", args: ["init"], cwd: root });
  const stateDir = path.join(root, ".agent-office");
  await mkdir(stateDir);
  const manager = new WorkspaceManager({ config: { workspace: root, stateDir } });
  const before = await manager.snapshot(root);
  await writeFile(path.join(stateDir, "events.jsonl"), "{}\n");
  const after = await manager.snapshot(root);
  assert.deepEqual(after, before);
});

test("rejects an agent-created commit instead of silently publishing it", async (context) => {
  const fixture = await integrationFixture(context, "agent-office-agent-commit-");
  const { manager, repository, task, node, worktree } = fixture;
  node.baselineChanges = await manager.snapshot(worktree);
  node.workspacePath = worktree;
  await writeFile(path.join(worktree, "src", "agent.js"), "export const agent = true;\n");
  node.verifiedSnapshot = await manager.snapshot(worktree);
  await runProcess({ command: "git", args: ["add", "."], cwd: worktree });
  await runProcess({ command: "git", args: ["commit", "-m", "agent commit"], cwd: worktree });
  assert.equal((await runProcess({ command: "git", args: ["status", "--porcelain"], cwd: repository })).stdout, "");

  await assert.rejects(
    () => manager.integrate(task, task.workflow.nodes.publish),
    /Writing agents may not create commits/
  );
});

test("keeps a prepared integration commit retryable after ff-only divergence", async (context) => {
  const fixture = await integrationFixture(context, "agent-office-ff-retry-");
  const { manager, repository, task, node, worktree } = fixture;
  node.baselineChanges = await manager.snapshot(worktree);
  node.workspacePath = worktree;
  await writeFile(path.join(worktree, "src", "answer.js"), "export const answer = 42;\n");
  node.verifiedSnapshot = await manager.snapshot(worktree);
  await writeFile(path.join(repository, "main-only.txt"), "main diverged\n");
  await runProcess({ command: "git", args: ["add", "."], cwd: repository });
  await runProcess({ command: "git", args: ["commit", "-m", "main diverged"], cwd: repository });

  await assert.rejects(() => manager.integrate(task, task.workflow.nodes.publish), /target diverged/);
  const preparedHead = (await runProcess({ command: "git", args: ["rev-parse", "HEAD"], cwd: worktree })).stdout.trim();
  await assert.rejects(() => manager.integrate(task, task.workflow.nodes.publish), /target diverged/);
  const retriedHead = (await runProcess({ command: "git", args: ["rev-parse", "HEAD"], cwd: worktree })).stdout.trim();
  assert.equal(retriedHead, preparedHead);
  assert.equal(
    (await runProcess({ command: "git", args: ["log", "-1", "--format=%s"], cwd: worktree })).stdout.trim(),
    `agent-office: ${task.id} build`
  );
});

test("refuses to publish after the target workspace switches branch", async (context) => {
  const fixture = await integrationFixture(context, "agent-office-target-branch-");
  const { manager, repository, task, node, worktree } = fixture;
  node.baselineChanges = await manager.snapshot(worktree);
  node.workspacePath = worktree;
  await writeFile(path.join(worktree, "src", "answer.js"), "export const answer = 42;\n");
  node.verifiedSnapshot = await manager.snapshot(worktree);

  const intent = await manager.prepareIntegration(task, task.workflow.nodes.publish);
  const originalBranch = intent.targetBranch;
  const originalHead = (await runProcess({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: repository
  })).stdout.trim();
  assert.ok(originalBranch);
  assert.notEqual(intent.sourceHead, originalHead);

  await runProcess({ command: "git", args: ["checkout", "-b", "wrong-target"], cwd: repository });
  await assert.rejects(
    () => manager.publishIntegration(intent),
    /target branch is wrong-target/
  );
  assert.equal(
    (await runProcess({ command: "git", args: ["rev-parse", originalBranch], cwd: repository })).stdout.trim(),
    originalHead
  );
  assert.equal(
    (await runProcess({ command: "git", args: ["rev-parse", "wrong-target"], cwd: repository })).stdout.trim(),
    originalHead
  );
});

test("publishes the complete writer history after a review-driven second attempt", async (context) => {
  const fixture = await integrationFixture(context, "agent-office-rework-baseline-");
  const { manager, repository, task, node, worktree } = fixture;
  node.integrationBaseline = await manager.snapshot(worktree);
  node.workspacePath = worktree;

  await writeFile(path.join(worktree, "src", "feature.js"), "export const feature = true;\n");
  node.baselineChanges = await manager.snapshot(worktree);
  await writeFile(path.join(worktree, "src", "fix.js"), "export const fixed = true;\n");
  node.verifiedSnapshot = await manager.snapshot(worktree);

  const publication = await manager.integrate(task, task.workflow.nodes.publish);
  assert.deepEqual(publication.changedFiles, ["src/feature.js", "src/fix.js"]);
  assert.equal(
    (await runProcess({ command: "git", args: ["show", "HEAD:src/feature.js"], cwd: repository })).stdout,
    "export const feature = true;\n"
  );
  assert.equal(
    (await runProcess({ command: "git", args: ["show", "HEAD:src/fix.js"], cwd: repository })).stdout,
    "export const fixed = true;\n"
  );
});

test("fails closed on external symlinks and ignored outputs", async (context) => {
  const fixture = await integrationFixture(context, "agent-office-snapshot-guard-");
  const { manager, task, node, worktree } = fixture;
  await symlink(os.tmpdir(), path.join(worktree, "src", "outside"));
  await assert.rejects(() => manager.snapshot(worktree), /External symbolic links/);
  await rm(path.join(worktree, "src", "outside"));
  node.writeScopes = ["ignored/**"];
  node.baselineChanges = await manager.snapshot(worktree);
  node.workspacePath = worktree;
  await writeFile(path.join(worktree, ".gitignore"), "ignored/\n");
  await runProcess({ command: "git", args: ["add", ".gitignore"], cwd: worktree });
  await runProcess({ command: "git", args: ["commit", "-m", "fixture ignore rule"], cwd: worktree });
  // Reset the baseline after fixture setup so only the ignored output belongs to the node.
  node.baselineChanges = await manager.snapshot(worktree);
  await mkdir(path.join(worktree, "ignored"));
  await writeFile(path.join(worktree, "ignored", "output.txt"), "not publishable\n");
  node.verifiedSnapshot = await manager.snapshot(worktree);
  await assert.rejects(
    () => manager.integrate(task, task.workflow.nodes.publish),
    /ignored or otherwise not publishable/
  );
});

async function integrationFixture(context, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo");
  await mkdir(repository);
  await runProcess({ command: "git", args: ["init"], cwd: repository });
  await runProcess({ command: "git", args: ["config", "user.email", "test@example.com"], cwd: repository });
  await runProcess({ command: "git", args: ["config", "user.name", "Test"], cwd: repository });
  await mkdir(path.join(repository, "src"));
  await writeFile(path.join(repository, "src", "seed.js"), "export const seed = true;\n");
  await runProcess({ command: "git", args: ["add", "."], cwd: repository });
  await runProcess({ command: "git", args: ["commit", "-m", "initial"], cwd: repository });
  const manager = new WorkspaceManager({ config: { workspace: repository } });
  const node = {
    id: "build",
    workspace: "worktree",
    workspaceFrom: null,
    access: "write",
    writeScopes: ["src/**"]
  };
  const task = {
    id: `task-20260813-${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`,
    workflow: {
      runtime: "process",
      nodes: {
        build: node,
        publish: { id: "publish", type: "integration", source: "build" }
      }
    }
  };
  const worktree = await manager.resolve(task, node);
  return { root, repository, manager, task, node, worktree };
}
