import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { runProcess } from "./adapters/process.js";

const GIT_TIMEOUT_MS = 10_000;
const MAX_TRACKED_FILES = 500;
const MAX_DIFF_BYTES = 512 * 1024;

async function git(workspace, args) {
  return runProcess({ command: "git", args, cwd: workspace, timeoutMs: GIT_TIMEOUT_MS });
}

export async function isGitWorkspace(workspace) {
  try {
    await git(workspace, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

// Records what the workspace looked like before a task first ran, so its diff
// can later be separated from changes that were already there. Without this a
// "task diff" is just the global working-tree diff and says nothing about the
// task.
export async function captureBaseline(workspace, { stateDir } = {}) {
  if (!(await isGitWorkspace(workspace))) return null;
  const head = await git(workspace, ["rev-parse", "HEAD"])
    .then((result) => result.stdout.trim())
    // A repository with no commits has no HEAD to diff against.
    .catch(() => null);
  return {
    head,
    capturedAt: new Date().toISOString(),
    files: await hashDirtyFiles(workspace, stateDir)
  };
}

export async function diffSince(workspace, baseline, { stateDir } = {}) {
  if (!(await isGitWorkspace(workspace))) {
    return { available: false, reason: "工作区不是 git 仓库，无法生成 diff。" };
  }
  try {
    const [statusResult, current] = await Promise.all([
      git(workspace, ["status", "--porcelain"]),
      hashDirtyFiles(workspace, stateDir)
    ]);
    const ignored = internalPrefix(workspace, stateDir);
    const status = statusResult.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((line) => !ignored || !line.slice(3).trim().startsWith(ignored));

    const base = baseline?.files ?? {};
    const changedDuringTask = [];
    const preexisting = [];
    for (const [file, hash] of Object.entries(current)) {
      // Dirty before the task and byte-identical since means the task did not
      // touch it, so it must not be attributed to the task.
      if (file in base && base[file] === hash) preexisting.push(file);
      else changedDuringTask.push(file);
    }
    for (const file of Object.keys(base)) {
      if (!(file in current)) changedDuringTask.push(file);
    }

    const diffTarget = baseline?.head ?? (await headOf(workspace));
    const [stat, patch] = await Promise.all([
      diffText(workspace, diffTarget, ["--stat"]),
      diffText(workspace, diffTarget, [])
    ]);

    return {
      available: true,
      baseline: baseline
        ? { head: baseline.head, capturedAt: baseline.capturedAt }
        : null,
      // Present when no baseline exists, so callers can say the view is global.
      scope: baseline ? "task" : "workspace",
      status: status.slice(0, 200),
      changedDuringTask: changedDuringTask.sort(),
      preexisting: preexisting.sort(),
      stat: stat.trim(),
      patch: patch.length > MAX_DIFF_BYTES ? patch.slice(0, MAX_DIFF_BYTES) : patch,
      truncated: patch.length > MAX_DIFF_BYTES
    };
  } catch (error) {
    return { available: false, reason: `git 无法生成 diff：${error.message}` };
  }
}

async function headOf(workspace) {
  return git(workspace, ["rev-parse", "HEAD"])
    .then((result) => result.stdout.trim())
    .catch(() => null);
}

async function diffText(workspace, target, extraArgs) {
  const args = target ? ["diff", target, ...extraArgs] : ["diff", ...extraArgs];
  return git(workspace, args).then((result) => result.stdout).catch(() => "");
}

// Content hashes for everything git reports as changed or untracked, which is
// what lets a later comparison tell "already dirty" from "the task changed it".
async function hashDirtyFiles(workspace, stateDir) {
  const hashes = {};
  const ignored = internalPrefix(workspace, stateDir);
  let status;
  try {
    status = await git(workspace, ["status", "--porcelain", "-z"]);
  } catch {
    return hashes;
  }
  const entries = status.stdout.split("\0").filter(Boolean).slice(0, MAX_TRACKED_FILES);
  for (const entry of entries) {
    // Porcelain format is "XY <path>"; renames carry a second path we skip.
    const file = entry.slice(3).trim();
    if (!file) continue;
    // Agent Office's own state lives in the workspace by default; it is
    // bookkeeping, not something a task changed.
    if (ignored && file.startsWith(ignored)) continue;
    hashes[file] = await hashFile(path.join(workspace, file));
  }
  return hashes;
}

// Workspace-relative prefix of the state directory, or null when it lives
// outside the workspace and cannot appear in git status at all.
function internalPrefix(workspace, stateDir) {
  if (!stateDir) return null;
  const relative = path.relative(path.resolve(workspace), path.resolve(stateDir));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return `${relative}/`;
}

async function hashFile(filePath) {
  try {
    return createHash("sha1").update(await readFile(filePath)).digest("hex");
  } catch {
    // Missing (deleted) or unreadable: a stable marker still differs from any
    // real hash, so the file registers as changed.
    return "absent";
  }
}
