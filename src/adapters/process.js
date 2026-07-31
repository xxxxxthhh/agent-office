import { spawn } from "node:child_process";
import { AdapterError } from "../errors.js";
import { truncate } from "../utils.js";

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

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
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let outputLimitExceeded = false;

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
      finishReject(
        new AdapterError(`Process timed out after ${timeoutMs} ms: ${command}`, {
          command,
          args,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          timedOut: true
        })
      );
    }, timeoutMs);
    timer.unref();

    const onAbort = () => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
      finishReject(
        new AdapterError(`Run cancelled: ${command}`, {
          command,
          args,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          cancelled: true
        })
      );
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
