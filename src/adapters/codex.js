import { readFile, writeFile } from "node:fs/promises";
import { parseTurnEnvelope } from "../protocol.js";
import { runProcess } from "./process.js";

export class CodexAdapter {
  constructor(agent, context) {
    this.agent = agent;
    this.schemaPath = context.schemaPath;
    this.store = context.store;
  }

  async runTurn({ prompt, workspace, timeoutMs, model, effort }) {
    const outputPath = this.store.createRunPath(this.agent.id, "codex.json");
    const args = [
      ...(this.agent.commandArgs ?? []),
      "exec",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--sandbox",
      this.agent.sandbox ?? "workspace-write",
      "--cd",
      workspace,
      "--output-schema",
      this.schemaPath,
      "--output-last-message",
      outputPath
    ];
    const selectedModel = model ?? this.agent.model;
    const selectedEffort = effort ?? this.agent.effort;
    if (selectedModel) args.push("--model", selectedModel);
    if (selectedEffort) args.push("-c", `model_reasoning_effort="${selectedEffort}"`);
    if (this.agent.ephemeral !== false) args.push("--ephemeral");
    args.push("-");

    const result = await runProcess({
      command: this.agent.command ?? "codex",
      args,
      cwd: workspace,
      input: prompt,
      timeoutMs,
      env: this.agent.env
    });
    const finalText = await readFile(outputPath, "utf8").catch(() => result.stdout);
    if (!finalText.trim() && result.stdout.trim()) {
      await writeFile(outputPath, result.stdout, "utf8");
    }

    return {
      response: parseTurnEnvelope(finalText || result.stdout),
      tracePath: outputPath,
      stderr: result.stderr
    };
  }

  describe() {
    return {
      command: this.agent.command ?? "codex",
      kind: "Codex CLI",
      safety: `sandbox=${this.agent.sandbox ?? "workspace-write"}`
    };
  }
}
