import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { runProcess } from "./adapters/process.js";
import { WORKSPACE_FENCE_NAME, WORKSPACE_LOCK_NAME } from "./store.js";
import { isRelativeOutside } from "./utils.js";

const GIT_TIMEOUT_MS = 10_000;
const MAX_TRACKED_FILES = 500;
const MAX_DIFF_BYTES = 512 * 1024;
// Dirty files up to this size get a content snapshot at baseline time, so a
// later patch can show only the task's delta on top of the pre-task content.
const BASELINE_BLOB_MAX_BYTES = 1024 * 1024;

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

// Records what the workspace looked like before a task first ran: the HEAD
// commit, and for every already-dirty file both a content hash and (when a
// blob directory is available and the file is not huge) a content snapshot.
// The hash alone can classify a file as task-changed, but only the snapshot
// can later produce a patch that excludes the pre-task content.
export async function captureBaseline(workspace, { stateDir, blobDir } = {}) {
  if (!(await isGitWorkspace(workspace))) return null;
  const head = await git(workspace, ["rev-parse", "HEAD"])
    .then((result) => result.stdout.trim())
    // A repository with no commits has no HEAD to diff against.
    .catch(() => null);
  const files = await hashDirtyFiles(workspace, stateDir);
  if (blobDir) {
    await mkdir(blobDir, { recursive: true }).catch(() => {});
    for (const [file, hash] of Object.entries(files)) {
      if (hash === "absent") continue;
      const source = path.join(workspace, file);
      const target = path.join(blobDir, hash);
      try {
        const contents = await readFile(source);
        if (contents.byteLength <= BASELINE_BLOB_MAX_BYTES) {
          await writeFile(target, contents, { flag: "wx" }).catch((error) => {
            // Content-addressed: an existing blob with this hash is this blob.
            if (error.code !== "EEXIST") throw error;
          });
        }
      } catch {
        // Snapshot is best-effort; the hash still classifies the file.
      }
    }
  }
  return {
    head,
    capturedAt: new Date().toISOString(),
    files
  };
}

// The task's diff must be consistent with itself: the file list and the patch
// describe the same set of files, and the patch shows ONLY what changed during
// the task:
//   - pre-task dirty files the task never touched are excluded from both;
//   - a pre-task dirty file the task DID touch is diffed against its baseline
//     snapshot, so the user's pre-task edit does not leak into the task patch;
//   - files the task committed still count;
//   - untracked files the task created appear via --no-index.
export async function diffSince(workspace, baseline, { stateDir, blobDir } = {}) {
  if (!(await isGitWorkspace(workspace))) {
    return { available: false, reason: "工作区不是 git 仓库，无法生成 diff。" };
  }
  try {
    const currentHead = await headOf(workspace);
    const [statusResult, current] = await Promise.all([
      git(workspace, ["status", "--porcelain", "--untracked-files=all"]),
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
      const headBased = [];
      for (const file of changedDuringTask) {
        // What matters for the patch target is what is actually on disk NOW;
        // `current` only lists files git still reports as dirty, so a file the
        // task committed or restored is missing from it while very much present.
        const onDisk = existsSync(path.join(workspace, file));
        const inBase = file in base;
        const blobPath = blobDir && inBase && base[file] !== "absent"
          ? path.join(blobDir, base[file])
          : null;
        const hasBlob = blobPath && existsSync(blobPath);

        if (inBase && base[file] === "absent") {
          // Deleted before the task, present again now: the task restored it,
          // and the whole current content is the task's delta.
          if (onDisk) {
            patch += await gitDiffOutput(
              workspace,
              ["diff", "--no-index", "--", "/dev/null", file]
            );
            stat += `${file} | restored during the task\n`;
          } else {
            // Absent on both sides of the task; only a commit in between can
            // have listed it, and the head-based diff covers that.
            headBased.push(file);
          }
        } else if (hasBlob) {
          // Pre-task dirty file with a snapshot: diff snapshot -> now shows
          // only the task's delta, whether the task edited, committed or
          // deleted it.
          const target = onDisk ? file : "/dev/null";
          const filePatch = await gitDiffOutput(
            workspace,
            ["diff", "--no-index", "--", blobPath, target]
          );
          patch += relabel(filePatch, blobPath, file);
          stat += `${file} | changed during the task (vs pre-task snapshot)\n`;
        } else if (inBase && !onDisk) {
          // Pre-task dirty (e.g. untracked) file the task deleted, with no
          // surviving snapshot: nothing left to diff. Say so explicitly rather
          // than emitting an empty patch that contradicts the file list.
          stat += `${file} | deleted during the task (no snapshot of the `
            + "pre-task content survives)\n";
        } else if (untrackedNow.has(file)) {
          patch += await gitDiffOutput(
            workspace,
            ["diff", "--no-index", "--", "/dev/null", file]
          );
          stat += `${file} | new file\n`;
        } else {
          headBased.push(file);
          // Pre-dirty but no snapshot survives (legacy task or oversized file):
          // the head-diff below unavoidably includes the pre-task edit. Say so
          // instead of presenting it as pure task output.
          if (inBase) {
            stat += `${file} | WARNING: no baseline snapshot; the patch below may `
              + "include pre-task edits\n";
          }
        }
      }
      const diffBase = baseline.head ?? currentHead;
      if (headBased.length && diffBase) {
        stat += await gitDiffOutput(workspace, ["diff", diffBase, "--stat", "--", ...headBased]);
        patch += await gitDiffOutput(workspace, ["diff", diffBase, "--", ...headBased]);
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

// --no-index prints the blob's real path in the headers; label the patch with
// the workspace-relative file it describes instead.
function relabel(filePatch, blobPath, file) {
  return filePatch.replaceAll(blobPath, file);
}

async function headOf(workspace) {
  return git(workspace, ["rev-parse", "HEAD"])
    .then((result) => result.stdout.trim())
    .catch(() => null);
}

async function namesBetween(workspace, from, to) {
  try {
    const result = await git(workspace, ["diff", "--name-only", "--no-renames", from, to]);
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
    status = await git(workspace, ["status", "--porcelain", "--untracked-files=all", "-z"]);
  } catch {
    return hashes;
  }
  // NUL-separated porcelain: `XY PATH` records, but a rename/copy carries the
  // ORIGIN as an extra NUL-separated field. Splitting blindly would read that
  // origin as its own record and mangle it with slice(3).
  const tokens = status.stdout.split("\0");
  let recorded = 0;
  for (let index = 0; index < tokens.length && recorded < MAX_TRACKED_FILES; index += 1) {
    const entry = tokens[index];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3).trim();
    if (!file) continue;
    let origin = null;
    if (xy.includes("R") || xy.includes("C")) {
      index += 1;
      origin = (tokens[index] ?? "").trim() || null;
    }
    if (!isInternal(file, ignored)) {
      hashes[file] = await hashFile(path.join(workspace, file));
      recorded += 1;
    }
    // The origin path of a rename no longer exists; recording it as absent
    // lets the diff attribute the disappearance (and show the deletion).
    if (origin && !isInternal(origin, ignored)) {
      hashes[origin] = await hashFile(path.join(workspace, origin));
      recorded += 1;
    }
  }
  return hashes;
}

// Agent Office's own bookkeeping — the state directory, the workspace lock and
// its takeover mutex — must never show up as "changes" in anyone's diff.
function ignoredPrefixes(workspace, stateDir) {
  const prefixes = [];
  if (stateDir) {
    const relative = path.relative(path.resolve(workspace), path.resolve(stateDir));
    if (relative && !isRelativeOutside(relative)) {
      prefixes.push(`${relative}/`);
    }
  }
  return { prefixes };
}

function isInternal(file, ignored) {
  // The lock, its takeover mutex, and heartbeat temp files all share the lock
  // name as a prefix; none of them is user content.
  if (file.startsWith(WORKSPACE_LOCK_NAME) || file.startsWith(WORKSPACE_FENCE_NAME)) return true;
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
