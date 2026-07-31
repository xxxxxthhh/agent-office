import { spawn } from "node:child_process";
import { AdapterError } from "../errors.js";
import { sleep, truncate } from "../utils.js";

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const KILL_GRACE_MS = 500;
const FORCE_EXIT_MS = 2000;
const GROUP_POLL_MS = 25;

// Signals the child's whole process tree. On POSIX the child is spawned as a
// process-group leader and the group is signalled; on Windows taskkill /T walks
// the tree, since there is no group signal to send.
function killTree(child, signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    try {
      spawn("taskkill", args, { stdio: "ignore" }).on("error", () => {});
    } catch {
      try { child.kill(signal); } catch { /* already exited */ }
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

// True while any member of the child's process group is still alive. This is
// what "the tree has exited" actually means: the direct child's `close` event
// only proves the child and its stdio are gone, not its descendants.
function isTreeAlive(child) {
  if (!child.pid) return false;
  // No group probe on Windows; taskkill /T /F is the only guarantee available.
  if (process.platform === "win32") return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function runProcess({
  command,
  args = [],
  cwd,
  input = "",
  env = {},
  timeoutMs = 600_000,
  signal = null,
  onStdoutLine = null
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AdapterError(`Run cancelled before starting ${command}`, {
        command,
        args,
        cancelled: true
      }));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // Makes the child a process-group leader so the whole tree can be
      // signalled. An agent CLI spawns shells and tools of its own; signalling
      // only the direct child leaves those descendants writing to the workspace.
      detached: process.platform !== "win32"
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let outputLimitExceeded = false;
    let termination = null;
    let escalateTimer = null;
    let forceTimer = null;

    const timer = setTimeout(() => {
      beginTermination({
        message: `Process timed out after ${timeoutMs} ms: ${command}`,
        extra: { timedOut: true }
      });
    }, timeoutMs);
    timer.unref();

    // Signals the whole tree, then settles only once the tree has actually
    // exited — releasing a run lease while descendants are still alive would
    // let the next run write the same files concurrently.
    function beginTermination({ message, extra }) {
      if (settled || termination) return;
      termination = { message, extra };
      killTree(child, "SIGTERM");
      escalateTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
      escalateTimer.unref();
      forceTimer = setTimeout(() => {
        // SIGKILL cannot be caught, so reaching here means something is truly
        // wedged (uninterruptible I/O). Report it rather than hanging forever;
        // the caller knows the tree may still exist via treeUnresponsive.
        finishReject(terminationError({ ...termination, unresponsive: true }));
      }, KILL_GRACE_MS + FORCE_EXIT_MS);
      forceTimer.unref();
      // `close` may never fire if a descendant inherited the stdio pipes died
      // with them open in an odd order; poll the group as an independent path
      // to settling.
      settleWhenTreeExits();
    }

    // The direct child's `close` proves nothing about grandchildren: a parent
    // that obeys SIGTERM closes immediately while a SIGTERM-ignoring
    // grandchild keeps writing until the SIGKILL escalation. Both settle paths
    // funnel here and wait for the whole group to disappear.
    async function settleWhenTreeExits() {
      const deadline = Date.now() + KILL_GRACE_MS + FORCE_EXIT_MS;
      while (!settled && isTreeAlive(child) && Date.now() < deadline) {
        await sleep(GROUP_POLL_MS);
      }
      if (settled) return;
      finishReject(terminationError({
        ...termination,
        unresponsive: isTreeAlive(child)
      }));
    }

    function terminationError({ message, extra, unresponsive }) {
      return new AdapterError(message, {
        command,
        args,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        ...extra,
        ...(unresponsive ? { treeUnresponsive: true } : {})
      });
    }

    const onAbort = () => {
      beginTermination({
        message: `Run cancelled: ${command}`,
        extra: { cancelled: true }
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let lineBuffer = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      // Adapters that stream read complete lines as they arrive; a partial line
      // is held back until its newline shows up in a later chunk.
      if (onStdoutLine) {
        lineBuffer += chunk;
        let newlineIndex = lineBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = lineBuffer.slice(0, newlineIndex);
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
          if (line.trim()) emitLine(line);
          newlineIndex = lineBuffer.indexOf("\n");
        }
      }
      if (Buffer.byteLength(stdout) > MAX_CAPTURE_BYTES) {
        outputLimitExceeded = true;
        beginTermination({
          message: `Process exceeded the ${MAX_CAPTURE_BYTES} byte output limit: ${command}`,
          extra: { outputLimitExceeded: true }
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_CAPTURE_BYTES) {
        outputLimitExceeded = true;
        beginTermination({
          message: `Process exceeded the ${MAX_CAPTURE_BYTES} byte output limit: ${command}`,
          extra: { outputLimitExceeded: true }
        });
      }
    });

    child.on("error", (error) => {
      finishReject(
        new AdapterError(`Unable to start ${command}: ${error.message}`, {
          command,
          args,
          cause: error
        })
      );
    });

    child.on("close", (code, signal) => {
      if (onStdoutLine && lineBuffer.trim()) emitLine(lineBuffer);
      // A termination is in flight: the child is gone, but descendants may not
      // be. Hand off to the group poll instead of settling here.
      if (termination) {
        settleWhenTreeExits();
        return;
      }
      if (code !== 0) {
        finishReject(
          new AdapterError(`${command} exited with code ${code}${signal ? ` (${signal})` : ""}`, {
            command,
            args,
            code,
            signal,
            stdout: truncate(stdout),
            stderr: truncate(stderr)
          })
        );
        return;
      }
      finishResolve({ code, signal, stdout, stderr });
    });

    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") finishReject(error);
    });
    child.stdin.end(input);

    function finishResolve(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function finishReject(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function cleanup() {
      clearTimeout(timer);
      clearTimeout(escalateTimer);
      clearTimeout(forceTimer);
      signal?.removeEventListener("abort", onAbort);
    }

    // A listener that throws must never take down the turn it is reporting on.
    function emitLine(line) {
      try {
        onStdoutLine(line);
      } catch {
        // Progress reporting is best-effort.
      }
    }
  });
}
