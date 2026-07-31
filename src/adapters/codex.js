import { readFile, writeFile } from "node:fs/promises";
import { parseTurnEnvelope } from "../protocol.js";
import { usageFromCodex } from "../usage.js";
import { runProcess } from "./process.js";

export class CodexAdapter {
  constructor(agent, context) {
    this.agent = agent;
    this.schemaPath = context.schemaPath;
    this.store = context.store;
  }

  async runTurn({ prompt, workspace, timeoutMs, model, effort, signal, onProgress }) {
    const outputPath = this.store.createRunPath(this.agent.id, "codex.json");
    // With --json the agent's reasoning, tool calls and notices live in the
    // event stream, not in the final message. Keeping only the final message
    // would leave the trace viewer with no evidence of what Codex actually did.
    const eventsPath = `${outputPath.replace(/\.codex\.json$/, "")}.codex.jsonl`;
    const args = [
      ...(this.agent.commandArgs ?? []),
      "exec",
      "--color",
      "never",
      // JSONL events give live progress and the turn's token usage; the final
      // envelope still comes from --output-last-message.
      "--json",
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

    let usage = null;
    let lastAgentMessage = "";
    const result = await runProcess({
      command: this.agent.command ?? "codex",
      args,
      cwd: workspace,
      input: prompt,
      timeoutMs,
      env: this.agent.env,
      signal,
      onStdoutLine: (line) => {
        const event = safeParse(line);
        if (!event) return;
        if (event.type === "turn.completed" && event.usage) {
          usage = usageFromCodex(event.usage);
        }
        if (event.item?.type === "agent_message" && event.item.text) {
          lastAgentMessage = event.item.text;
        }
        const progress = describeCodexEvent(event);
        if (progress && onProgress) onProgress(progress);
      }
    });

    // With --json the stdout is an event stream, so the agent's final answer
    // comes from the message file, falling back to the last agent_message event.
    const finalText = await readFile(outputPath, "utf8").catch(() => "");
    const envelopeSource = finalText.trim() || lastAgentMessage;
    if (!finalText.trim() && envelopeSource) {
      await writeFile(outputPath, envelopeSource, "utf8");
    }
    let tracePath = outputPath;
    if (result.stdout.trim()) {
      await writeFile(eventsPath, result.stdout, "utf8");
      // The event stream contains the final message too, so it is the richer trace.
      tracePath = eventsPath;
    }

    return {
      response: parseTurnEnvelope(envelopeSource),
      tracePath,
      stderr: result.stderr,
      usage
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

function describeCodexEvent(event) {
  if (event.type === "turn.completed") return { kind: "result", detail: "completed" };
  const item = event.item;
  if (event.type !== "item.completed" || !item) return null;
  if (item.type === "agent_message" && item.text?.trim()) {
    return { kind: "message", detail: item.text.trim() };
  }
  if (item.type === "command_execution") {
    return { kind: "tool", detail: item.command ?? "command" };
  }
  if (item.type === "file_change") {
    return { kind: "tool", detail: "file change" };
  }
  if (item.type === "reasoning") return { kind: "thinking", detail: "thinking" };
  // Codex reports non-fatal notices as `error` items, so this is surfaced as a
  // notice rather than treated as a turn failure.
  if (item.type === "error" && item.message) {
    return { kind: "notice", detail: item.message };
  }
  return null;
}

function safeParse(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
