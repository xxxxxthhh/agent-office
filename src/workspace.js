import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { runProcess } from "./adapters/process.js";
import { WORKSPACE_LOCK_NAME } from "./store.js";

const GIT_TIMEOUT_MS = 10_000;
const MAX_TRACKED_FILES = 500;
const MAX_DIFF_BYTES = 512 * 1024;

async function git(workspace, args) {
  return runProcess({ command: "git", args, cwd: workspace, timeoutMs: GIT_TIMEOUT_MS });
}

// `git diff --no-index` exits 1 when the files differ, which is its success
// case here; anything else is a real failure.
async function gitDiffOutput(workspace, args) {
  try {
    return (await git(workspace, args)).stdout;
  } catch (error) {
    if (error.details?.code === 1) return error.details.stdout ?? "";
    return "";
  }
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

// The task's diff must be consistent with itself: the file list and the patch
// describe the same set of files. Three rules make that hold:
//   - pre-task dirty files that the task never touched are excluded from BOTH;
//   - files the task committed still count (the working tree being clean does
//     not mean the task changed nothing);
//   - untracked files the task created appear in the patch via --no-index,
//     since `git diff` alone never shows them.
export async function diffSince(workspace, baseline, { stateDir } = {}) {
  if (!(await isGitWorkspace(workspace))) {
    return { available: false, reason: "工作区不是 git 仓库，无法生成 diff。" };
  }
  try {
    const currentHead = await headOf(workspace);
    const [statusResult, current] = await Promise.all([
      git(workspace, ["status", "--porcelain"]),
      hashDirtyFiles(workspace, stateDir)
    ]);
    const ignored = ignoredPrefixes(workspace, stateDir);
    const status = statusResult.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((line) => !isInternal(line.slice(3).trim(), ignored));

    // Files whose changes the task already committed. Without this a task that
    // commits its work would report an empty change list while its patch shows
    // content — mutually contradictory audit evidence.
    const committed = baseline?.head && currentHead && baseline.head !== currentHead
      ? await namesBetween(workspace, baseline.head, currentHead)
      : [];

    const base = baseline?.files ?? {};
    const changed = new Set(committed.filter((file) => !isInternal(file, ignored)));
    const preexisting = [];
    for (const [file, hash] of Object.entries(current)) {
      // Dirty before the task and byte-identical since means the task did not
      // touch it, so it must not be attributed to the task.
      if (file in base && base[file] === hash && !changed.has(file)) preexisting.push(file);
      else changed.add(file);
    }
    for (const file of Object.keys(base)) {
      // Dirty before, no longer dirty now: either the task committed it (in
      // `committed`) or the task reverted it — a change either way.
      if (!(file in current)) changed.add(file);
    }

    const changedDuringTask = [...changed].sort();
    const untrackedNow = new Set(
      status.filter((line) => line.startsWith("??")).map((line) => line.slice(3).trim())
    );

    let patch = "";
    let stat = "";
    if (baseline && changedDuringTask.length) {
      const tracked = changedDuringTask.filter((file) => !untrackedNow.has(file));
      const diffBase = baseline.head ?? currentHead;
      if (tracked.length && diffBase) {
        stat = await gitDiffOutput(workspace, ["diff", diffBase, "--stat", "--", ...tracked]);
        patch = await gitDiffOutput(workspace, ["diff", diffBase, "--", ...tracked]);
      }
      for (const file of changedDuringTask) {
        if (!untrackedNow.has(file)) continue;
        patch += await gitDiffOutput(
          workspace,
          ["diff", "--no-index", "--", "/dev/null", file]
        );
      }
    } else if (!baseline) {
      // No baseline: an honest global view rather than a fake task view.
      const diffBase = currentHead;
      if (diffBase) {
        stat = await gitDiffOutput(workspace, ["diff", diffBase, "--stat"]);
        patch = await gitDiffOutput(workspace, ["diff", diffBase]);
      }
    }

    return {
      available: true,
      baseline: baseline
        ? { head: baseline.head, capturedAt: baseline.capturedAt }
        : null,
      // Present when no baseline exists, so callers can say the view is global.
      scope: baseline ? "task" : "workspace",
      status: status.slice(0, 200),
      changedDuringTask,
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

async function namesBetween(workspace, from, to) {
  try {
    const result = await git(workspace, ["diff", "--name-only", from, to]);
    return result.stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// Content hashes for everything git reports as changed or untracked, which is
// what lets a later comparison tell "already dirty" from "the task changed it".
async function hashDirtyFiles(workspace, stateDir) {
  const hashes = {};
  const ignored = ignoredPrefixes(workspace, stateDir);
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
    if (isInternal(file, ignored)) continue;
    hashes[file] = await hashFile(path.join(workspace, file));
  }
  return hashes;
}

// Agent Office's own bookkeeping — the state directory and the workspace lock
// file — must never show up as "changes" in anyone's diff.
function ignoredPrefixes(workspace, stateDir) {
  const prefixes = [];
  if (stateDir) {
    const relative = path.relative(path.resolve(workspace), path.resolve(stateDir));
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      prefixes.push(`${relative}/`);
    }
  }
  return { prefixes, names: new Set([WORKSPACE_LOCK_NAME]) };
}

function isInternal(file, ignored) {
  if (ignored.names.has(file)) return true;
  return ignored.prefixes.some((prefix) => file.startsWith(prefix));
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
