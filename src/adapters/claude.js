import { writeFile } from "node:fs/promises";
import { parseTurnEnvelope } from "../protocol.js";
import { runProcess } from "./process.js";

export class ClaudeAdapter {
  constructor(agent, context) {
    this.agent = agent;
    this.schema = context.schema;
    this.store = context.store;
  }

  async runTurn({ prompt, workspace, timeoutMs, model, effort }) {
    const outputPath = this.store.createRunPath(this.agent.id, "claude.json");
    const args = [
      ...(this.agent.commandArgs ?? []),
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(this.schema),
      "--permission-mode",
      this.agent.permissionMode ?? "acceptEdits"
    ];
    const selectedModel = model ?? this.agent.model;
    const selectedEffort = effort ?? this.agent.effort;
    if (selectedModel) args.push("--model", selectedModel);
    if (selectedEffort) args.push("--effort", selectedEffort);
    if (this.agent.maxBudgetUsd !== undefined) {
      args.push("--max-budget-usd", String(this.agent.maxBudgetUsd));
    }
    if (this.agent.noSessionPersistence !== false) args.push("--no-session-persistence");

    const result = await runProcess({
      command: this.agent.command ?? "claude",
      args,
      cwd: workspace,
      input: prompt,
      timeoutMs,
      env: this.agent.env
    });
    await writeFile(outputPath, result.stdout, "utf8");

    const payload = parseClaudeOutput(result.stdout);
    return {
      response: parseTurnEnvelope(payload),
      tracePath: outputPath,
      stderr: result.stderr
    };
  }

  describe() {
    return {
      command: this.agent.command ?? "claude",
      kind: "Claude Code CLI",
      safety: `permissionMode=${this.agent.permissionMode ?? "acceptEdits"}`
    };
  }
}

function parseClaudeOutput(stdout) {
  const trimmed = stdout.trim();
  try {
    const payload = JSON.parse(trimmed);
    if (payload.structured_output) return payload.structured_output;
    if (payload.result && typeof payload.result === "object") return payload.result;
    if (typeof payload.result === "string") return payload.result;
    return payload;
  } catch {
    return trimmed;
  }
}
