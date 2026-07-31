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
  timeoutMs = 600_000
}) {
  return new Promise((resolve, reject) => {
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

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
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
      clearTimeout(timer);
      resolve(result);
    }

    function finishReject(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}
