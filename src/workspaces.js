import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { ConfigError } from "./errors.js";
import { runProcess } from "./adapters/process.js";
import { isWorkspaceLockName } from "./store.js";
import { isRelativeOutside } from "./utils.js";

export class WorkspaceManager {
  constructor({ config, createHerdrWorktree = null }) {
    this.config = config;
    this.createHerdrWorktree = createHerdrWorktree;
  }

  async resolve(task, node) {
    if (node.workspacePath) return node.workspacePath;
    if (node.workspaceFrom) {
      const source = task.workflow.nodes[node.workspaceFrom];
      if (!source?.workspacePath) {
        throw new ConfigError(`Workspace source "${node.workspaceFrom}" is not ready`);
      }
      return source.workspacePath;
    }
    if (node.workspace === "shared") return this.config.workspace;
    if (node.workspace !== "worktree") {
      throw new ConfigError(`Unsupported workspace mode for node "${node.id}": ${node.workspace}`);
    }

    const root = path.join(
      path.dirname(this.config.workspace),
      `.${path.basename(this.config.workspace)}-agent-office-worktrees`
    );
    await mkdir(root, { recursive: true });
    const worktreePath = path.join(root, `${task.id.slice(-8)}-${node.id}`);
    const branch = `agent-office/${task.id.slice(-8)}/${node.id}`;
    const registered = await registeredWorktrees(this.config.workspace);
    const canonicalWorktreePath = await realpath(worktreePath).catch(() => null);
    if (registered.has(path.resolve(worktreePath)) || (canonicalWorktreePath && registered.has(canonicalWorktreePath))) {
      return worktreePath;
    }
    if (await lstat(worktreePath).catch(() => null)) {
      throw new ConfigError(`Refusing to reuse an unregistered worktree path: ${worktreePath}`);
    }
    // git worktree add fails with a bare exit code 128 on a repository that has
    // no commits yet, which is a state a brand new project is very likely in.
    const head = await runProcess({
      command: "git",
      args: ["rev-parse", "--verify", "HEAD"],
      cwd: this.config.workspace,
      timeoutMs: 30_000
    }).catch(() => null);
    if (!head) {
      throw new ConfigError(
        `Workspace ${this.config.workspace} has no commits yet, so a writing node has nothing to branch from. `
        + "Make an initial commit first."
      );
    }
    if (task.workflow.runtime === "herdr" && this.createHerdrWorktree) {
      await this.createHerdrWorktree({
        cwd: this.config.workspace,
        path: worktreePath,
        branch,
        base: "HEAD",
        label: `AO ${node.id}`
      });
    } else {
      await runProcess({
        command: "git",
        args: ["worktree", "add", "-b", branch, worktreePath, "HEAD"],
        cwd: this.config.workspace,
        timeoutMs: 60_000
      });
    }
    return worktreePath;
  }

  async snapshot(workspace) {
    const snapshot = {};
    const root = await realpath(workspace);
    const maxFiles = this.config.execution?.snapshotMaxFiles ?? 50_000;
    let fileCount = 0;
    const visit = async (directory, relativeDirectory = "") => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = normalizePath(path.join(relativeDirectory, entry.name));
        if (!relativeDirectory && (entry.name === ".git" || isWorkspaceLockName(entry.name))) continue;
        if (this.#isControlState(workspace, relativePath)) continue;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath, relativePath);
          continue;
        }
        if (fileCount >= maxFiles) {
          throw new ConfigError(
            `Workspace snapshot exceeded execution.snapshotMaxFiles=${maxFiles}`
          );
        }
        fileCount += 1;
        if (entry.isSymbolicLink()) {
          const target = await readlink(absolutePath);
          const resolved = await realpath(absolutePath).catch(() => null);
          if (resolved) {
            const outside = path.relative(root, resolved);
            if (isRelativeOutside(outside)) {
              throw new ConfigError(`External symbolic links are not allowed in workflow workspaces: ${relativePath}`);
            }
          }
          snapshot[relativePath] = `symlink:${target}`;
          continue;
        }
        if (entry.isFile()) {
          const digest = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
          snapshot[relativePath] = `file:${digest}`;
        } else {
          const fileStat = await lstat(absolutePath);
          snapshot[relativePath] = `other:${fileStat.mode}:${fileStat.size}`;
        }
      }
    };
    await visit(root);
    const gitMetadata = await readGitMetadata(workspace);
    for (const [key, value] of Object.entries(gitMetadata)) {
      snapshot[`@git/${key}`] = value;
    }
    return snapshot;
  }

  #isControlState(workspace, filePath) {
    if (!this.config.stateDir) return false;
    const relative = path.relative(workspace, this.config.stateDir);
    if (!relative || isRelativeOutside(relative)) return false;
    const normalized = normalizePath(relative);
    return filePath === normalized || filePath.startsWith(`${normalized}/`);
  }

  validateChanges(node, before, after) {
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((filePath) => before[filePath] !== after[filePath])
      .sort();
    if (node.access === "read_only" && changed.length) {
      throw new ConfigError(
        `Read-only node "${node.id}" modified the workspace: ${changed.join(", ")}`
      );
    }
    if (node.access === "write") {
      const outside = changed.filter((entry) => !matchesAnyScope(entry, node.writeScopes));
      if (outside.length) {
        throw new ConfigError(
          `Node "${node.id}" changed files outside writeScopes: ${outside.join(", ")}`
        );
      }
    }
    return changed;
  }

  async validateArtifacts(workspace, artifacts) {
    const verified = [];
    for (const artifact of artifacts) {
      if (path.isAbsolute(artifact)) {
        throw new ConfigError(`Artifact paths must be relative to the node workspace: ${artifact}`);
      }
      const normalized = normalizePath(artifact);
      if (!normalized || normalized === ".." || normalized.startsWith("../")) {
        throw new ConfigError(`Artifact path escapes the node workspace: ${artifact}`);
      }
      const absolute = path.resolve(workspace, normalized);
      const relative = path.relative(workspace, absolute);
      if (isRelativeOutside(relative)) {
        throw new ConfigError(`Artifact path escapes the node workspace: ${artifact}`);
      }
      if (!await lstat(absolute).catch(() => null)) {
        throw new ConfigError(`Declared artifact does not exist: ${artifact}`);
      }
      const artifactStat = await lstat(absolute);
      if (artifactStat.isSymbolicLink()) {
        throw new ConfigError(`Declared artifacts cannot be symbolic links: ${artifact}`);
      }
      verified.push(normalized);
    }
    return verified;
  }

  async prepareIntegration(task, node) {
    const sourceNode = task.workflow.nodes[node.source];
    if (!sourceNode?.workspacePath) {
      throw new ConfigError(`Integration source "${node.source}" has no worktree`);
    }
    const taint = task.workflow.workspaceTaints?.[node.source];
    if (taint) {
      throw new ConfigError(
        `Integration source "${node.source}" is tainted by unauthorized workspace changes from "${taint.nodeId}"`
      );
    }
    if (!sourceNode.verifiedSnapshot) {
      throw new ConfigError(`Integration source "${node.source}" has no verified successful snapshot`);
    }
    const sourceWorkspace = sourceNode.workspacePath;
    const baseline = sourceNode.integrationBaseline ?? sourceNode.baselineChanges ?? {};
    const sourceBefore = await this.snapshot(sourceWorkspace);
    if (sourceBefore["@git/branch"] !== baseline["@git/branch"]
      || sourceBefore["@git/config"] !== baseline["@git/config"]) {
      throw new ConfigError("Writing agents may not change the worktree branch or local Git config");
    }
    const baseHead = baseline["@git/head"];
    if (!baseHead || baseHead === "(unborn)") {
      throw new ConfigError("Integration requires a repository with an existing HEAD commit");
    }
    let sourceHead = sourceBefore["@git/head"];
    const projectChanges = snapshotProjectChanges(baseline, sourceBefore);
    this.validateChanges(sourceNode, projectSnapshot(baseline), projectSnapshot(sourceBefore));
    const postWriterChanges = snapshotProjectChanges(sourceNode.verifiedSnapshot, sourceBefore);
    if (postWriterChanges.length) {
      throw new ConfigError(
        `Integration source changed after the writer's verified completion: ${postWriterChanges.join(", ")}`
      );
    }
    const readDirtyFiles = async () => (await listGitChanges(sourceWorkspace))
      .filter((filePath) => !isWorkspaceLockName(filePath) && !this.#isControlState(sourceWorkspace, filePath));
    let dirtyFiles = await readDirtyFiles();
    const expectedMessage = `agent-office: ${task.id} ${sourceNode.id}`;

    if (sourceHead !== baseHead) {
      const [count, message] = await Promise.all([
        runProcess({
          command: "git",
          args: ["rev-list", "--count", `${baseHead}..${sourceHead}`],
          cwd: sourceWorkspace,
          timeoutMs: 30_000
        }),
        runProcess({
          command: "git",
          args: ["log", "-1", "--format=%s", sourceHead],
          cwd: sourceWorkspace,
          timeoutMs: 30_000
        })
      ]);
      if (count.stdout.trim() !== "1" || message.stdout.trim() !== expectedMessage) {
        throw new ConfigError("Writing agents may not create commits; only an Agent Office prepared commit can resume");
      }
      // The subject alone proves nothing — anything with write access to the
      // worktree can copy it. Whenever a previous prepare is on record, the
      // commit must be that exact one; the subject check only stands in for a
      // prepare whose intent never got persisted.
      if (node.invalidatedPreparedHead && sourceHead !== node.invalidatedPreparedHead) {
        // Fail closed rather than publish a commit of unknown provenance. The
        // one benign way to land here is a crash between preparing a commit
        // and recording it, so the message carries the exact recovery instead
        // of leaving the operator to guess.
        throw new ConfigError(
          `Integration source head ${sourceHead} is not the commit Agent Office prepared `
          + `(${node.invalidatedPreparedHead}); refusing to publish it. If a run was killed `
          + `between preparing and recording a commit, restore it with: `
          + `git -C ${sourceWorkspace} reset --mixed ${node.invalidatedPreparedHead}`
        );
      }
      if (dirtyFiles.length) {
        // The writer was reopened and ran again on top of a commit prepared for
        // its previous attempt. That commit is Agent Office's own — the checks
        // above prove it, and publication blocks reopening, so it was never
        // published. Drop it and prepare one commit that contains the rework;
        // keeping it would publish exactly the work a reviewer sent back.
        // --mixed, never --soft: a soft reset would leave the previous
        // attempt's tree staged, and a file that attempt introduced and the
        // rework took back would ride along into the commit even though it
        // exists in neither the base nor the final worktree. Rebuilding the
        // index from the base means only the paths staged below are published.
        await runProcess({
          command: "git",
          args: ["reset", "--mixed", baseHead],
          cwd: sourceWorkspace,
          timeoutMs: 30_000
        });
        sourceHead = baseHead;
        dirtyFiles = await readDirtyFiles();
      }
    }

    if (sourceHead === baseHead) {
      if (!projectChanges.length) {
        throw new ConfigError(`Integration source "${node.source}" has no changes to publish`);
      }
      const invisible = projectChanges.filter((filePath) => !dirtyFiles.includes(filePath));
      if (invisible.length) {
        throw new ConfigError(
          `Changed files are ignored or otherwise not publishable by Git: ${invisible.join(", ")}`
        );
      }
      await runProcess({
        command: "git",
        args: ["add", "--all", "--", ...projectChanges],
        cwd: sourceWorkspace,
        timeoutMs: 30_000
      });
      await runProcess({
        command: "git",
        args: [
          "-c", "user.name=Agent Office",
          "-c", "user.email=agent-office@local",
          "commit", "-m", expectedMessage
        ],
        cwd: sourceWorkspace,
        timeoutMs: 60_000
      });
      sourceHead = (await runProcess({
        command: "git",
        args: ["rev-parse", "HEAD"],
        cwd: sourceWorkspace,
        timeoutMs: 30_000
      })).stdout.trim();
    }
    const changedFiles = await diffNames(sourceWorkspace, baseHead, sourceHead);
    const outside = changedFiles.filter((filePath) => !matchesAnyScope(filePath, sourceNode.writeScopes));
    if (outside.length) {
      throw new ConfigError(`Prepared commit contains files outside writeScopes: ${outside.join(", ")}`);
    }
    if (!changedFiles.length) {
      throw new ConfigError(`Prepared integration commit contains no project changes`);
    }
    const sourceBranchResult = await runProcess({
      command: "git",
      args: ["branch", "--show-current"],
      cwd: sourceWorkspace,
      timeoutMs: 30_000
    });
    const sourceBranch = sourceBranchResult.stdout.trim();
    if (!sourceBranch) throw new ConfigError("Integration source is not on a named branch");
    const targetBranchResult = await runProcess({
      command: "git",
      args: ["branch", "--show-current"],
      cwd: this.config.workspace,
      timeoutMs: 30_000
    });
    const targetBranch = targetBranchResult.stdout.trim();
    if (!targetBranch) throw new ConfigError("Integration target is not on a named branch");
    const targetWorkspace = await realpath(this.config.workspace);
    const targetGitCommonDir = await gitCommonDir(this.config.workspace);
    return {
      taskId: task.id,
      nodeId: node.id,
      sourceId: sourceNode.id,
      sourceWorkspace,
      sourceBranch,
      targetWorkspace,
      targetBranch,
      targetGitCommonDir,
      baseHead,
      sourceHead,
      branch: targetBranch,
      changedFiles,
      preparedAt: new Date().toISOString()
    };
  }

  async publishIntegration(intent) {
    const targetWorkspace = await realpath(this.config.workspace);
    if (!intent || intent.targetWorkspace !== targetWorkspace) {
      throw new ConfigError("Integration publication intent does not match the configured workspace");
    }
    const targetGitCommonDir = await gitCommonDir(this.config.workspace);
    if (intent.targetGitCommonDir !== targetGitCommonDir) {
      throw new ConfigError("Integration target repository identity changed after publication intent was recorded");
    }
    const targetBranch = (await runProcess({
      command: "git",
      args: ["branch", "--show-current"],
      cwd: this.config.workspace,
      timeoutMs: 30_000
    })).stdout.trim();
    if (!intent.targetBranch || targetBranch !== intent.targetBranch) {
      throw new ConfigError(
        `Integration target branch is ${targetBranch || "(detached)"}; expected ${intent.targetBranch}`
      );
    }
    const sourceHead = (await runProcess({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: intent.sourceWorkspace,
      timeoutMs: 30_000
    })).stdout.trim();
    if (sourceHead !== intent.sourceHead) {
      throw new ConfigError("Prepared integration source head changed after publication intent was recorded");
    }
    const targetChanges = (await listGitChanges(this.config.workspace))
      .filter((filePath) => !isWorkspaceLockName(filePath) && !this.#isControlState(this.config.workspace, filePath));
    if (targetChanges.length) {
      throw new ConfigError(
        `Integration target must be clean before ff-only publication: ${targetChanges.join(", ")}`
      );
    }
    let targetHead = (await runProcess({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: this.config.workspace,
      timeoutMs: 30_000
    })).stdout.trim();
    if (targetHead !== intent.sourceHead) {
      if (targetHead !== intent.baseHead) {
        throw new ConfigError(
          `Integration target diverged from prepared base ${intent.baseHead}; current HEAD is ${targetHead}`
        );
      }
      try {
        await runProcess({
          command: "git",
          args: ["merge", "--ff-only", intent.sourceHead],
          cwd: this.config.workspace,
          timeoutMs: 60_000
        });
      } catch (error) {
        targetHead = (await runProcess({
          command: "git",
          args: ["rev-parse", "HEAD"],
          cwd: this.config.workspace,
          timeoutMs: 30_000
        })).stdout.trim();
        if (targetHead !== intent.sourceHead) throw error;
      }
    }
    targetHead = (await runProcess({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: this.config.workspace,
      timeoutMs: 30_000
    })).stdout.trim();
    if (targetHead !== intent.sourceHead) {
      throw new ConfigError("ff-only integration did not publish the prepared source head");
    }
    const afterChanges = (await listGitChanges(this.config.workspace))
      .filter((filePath) => !isWorkspaceLockName(filePath) && !this.#isControlState(this.config.workspace, filePath));
    if (afterChanges.length) {
      throw new ConfigError(
        `Integration target is not clean after publication: ${afterChanges.join(", ")}`
      );
    }
    return {
      ...intent,
      head: targetHead,
      workspace: this.config.workspace,
      publishedAt: new Date().toISOString()
    };
  }

  async integrate(task, node) {
    const intent = await this.prepareIntegration(task, node);
    return this.publishIntegration(intent);
  }
}

export function matchesAnyScope(filePath, scopes) {
  const normalized = normalizePath(filePath);
  return scopes.some((scope) => {
    const clean = normalizePath(scope);
    if (!clean.includes("*")) return normalized === clean || normalized.startsWith(`${clean}/`);
    return globToRegExp(clean).test(normalized);
  });
}

function parsePorcelain(value) {
  const fields = value.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    paths.push({ path: normalizePath(field.slice(3)), status });
    if (status.includes("R") || status.includes("C")) {
      const destination = fields[index + 1];
      if (destination) paths.push({ path: normalizePath(destination), status });
      index += 1;
    }
  }
  const unique = new Map(paths.map((entry) => [entry.path, entry]));
  return [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function normalizePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

async function gitCommonDir(workspace) {
  const result = await runProcess({
    command: "git",
    args: ["rev-parse", "--git-common-dir"],
    cwd: workspace,
    timeoutMs: 30_000
  });
  const raw = result.stdout.trim();
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(workspace, raw);
  return realpath(absolute);
}

async function listGitChanges(workspace) {
  const result = await runProcess({
    command: "git",
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd: workspace,
    timeoutMs: 30_000
  });
  return parsePorcelain(result.stdout).map((entry) => entry.path);
}

function projectSnapshot(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => !key.startsWith("@git/")));
}

function snapshotProjectChanges(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((filePath) => !filePath.startsWith("@git/") && before[filePath] !== after[filePath])
    .sort();
}

async function diffNames(workspace, base, head) {
  const result = await runProcess({
    command: "git",
    args: ["diff", "--name-only", "-z", `${base}..${head}`],
    cwd: workspace,
    timeoutMs: 30_000
  });
  return result.stdout.split("\0").filter(Boolean).map(normalizePath).sort();
}

async function readGitMetadata(workspace) {
  const [head, branch, config] = await Promise.all([
    runProcess({ command: "git", args: ["rev-parse", "--verify", "HEAD"], cwd: workspace, timeoutMs: 30_000 })
      .catch(() => ({ stdout: "(unborn)\n" })),
    runProcess({ command: "git", args: ["branch", "--show-current"], cwd: workspace, timeoutMs: 30_000 }),
    runProcess({ command: "git", args: ["config", "--local", "--null", "--list"], cwd: workspace, timeoutMs: 30_000 })
  ]);
  return {
    head: head.stdout.trim(),
    branch: branch.stdout.trim(),
    config: createHash("sha256").update(config.stdout).digest("hex")
  };
}

function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

async function registeredWorktrees(repository) {
  const result = await runProcess({
    command: "git",
    args: ["worktree", "list", "--porcelain"],
    cwd: repository,
    timeoutMs: 30_000
  });
  const paths = new Set();
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      const worktreePath = path.resolve(line.slice("worktree ".length));
      paths.add(worktreePath);
      paths.add(await realpath(worktreePath).catch(() => worktreePath));
    }
  }
  return paths;
}
