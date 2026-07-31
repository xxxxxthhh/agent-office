import { spawn } from "node:child_process";
import { AdapterError } from "../errors.js";
import { truncate } from "../utils.js";

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const KILL_GRACE_MS = 500;
const FORCE_EXIT_MS = 2000;

// Signals the child's whole process group. Falls back to the direct child when
// the group is already gone or the platform has no process groups.
function killTree(child, signal) {
  if (!child.pid || child.killed && signal === "SIGTERM") {
    try { child.kill(signal); } catch { /* already exited */ }
    return;
  }
  if (process.platform === "win32") {
    try { child.kill(signal); } catch { /* already exited */ }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
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
    let forceTimer = null;

    const timer = setTimeout(() => {
      beginTermination({
        message: `Process timed out after ${timeoutMs} ms: ${command}`,
        extra: { timedOut: true }
      });
    }, timeoutMs);
    timer.unref();

    // Signals the whole process group, then settles only once the tree has
    // actually exited — releasing a run lease while descendants are still alive
    // would let the next run write the same files concurrently.
    function beginTermination({ message, extra }) {
      if (settled || termination) return;
      termination = { message, extra };
      killTree(child, "SIGTERM");
      const escalate = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
      escalate.unref();
      forceTimer = setTimeout(() => {
        // SIGKILL cannot be caught, so reaching here means a descendant is
        // holding the pipes open. Report it rather than hanging forever.
        finishReject(terminationError({ ...termination, unresponsive: true }));
      }, KILL_GRACE_MS + FORCE_EXIT_MS);
      forceTimer.unref();
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
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_CAPTURE_BYTES) {
        outputLimitExceeded = true;
        child.kill("SIGTERM");
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
      // The tree is gone; only now is it safe to report the cancellation.
      if (termination) {
        finishReject(terminationError(termination));
        return;
      }
      if (outputLimitExceeded) {
        finishReject(
          new AdapterError(`Process exceeded the ${MAX_CAPTURE_BYTES} byte output limit: ${command}`, {
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
