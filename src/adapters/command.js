import { writeFile } from "node:fs/promises";
import { ConfigError } from "../errors.js";
import { parseTurnEnvelope } from "../protocol.js";
import { runProcess } from "./process.js";

export class CommandAdapter {
  constructor(agent, context) {
    if (typeof agent.command !== "string" || !agent.command.trim()) {
      throw new ConfigError(`Command adapter "${agent.id}" requires a command`);
    }
    if (agent.args !== undefined && !Array.isArray(agent.args)) {
      throw new ConfigError(`Command adapter "${agent.id}" args must be an array`);
    }
    this.agent = agent;
    this.context = context;
  }

  async runTurn({ prompt, workspace, timeoutMs, signal, onProgress }) {
    const outputPath = this.context.store.createRunPath(this.agent.id, "command.txt");
    const substitutions = {
      "{{workspace}}": workspace,
      "{{agentId}}": this.agent.id,
      "{{schema}}": this.context.schemaPath
    };
    const args = (this.agent.args ?? []).map((arg) => substitute(String(arg), substitutions));
    const result = await runProcess({
      command: this.agent.command,
      args,
      cwd: workspace,
      input: prompt,
      timeoutMs,
      env: this.agent.env,
      signal,
      // A generic program has no known event format, so each stdout line is
      // reported verbatim as coarse progress.
      onStdoutLine: onProgress
        ? (line) => onProgress({ kind: "output", detail: line })
        : null
    });
    await writeFile(outputPath, result.stdout, "utf8");
    return {
      response: parseTurnEnvelope(result.stdout),
      tracePath: outputPath,
      stderr: result.stderr
    };
  }

  describe() {
    return {
      command: this.agent.command,
      kind: "Generic command",
      safety: "inherits command-specific policy"
    };
  }
}

function substitute(value, substitutions) {
  let result = value;
  for (const [token, replacement] of Object.entries(substitutions)) {
    result = result.replaceAll(token, replacement);
  }
  return result;
}
