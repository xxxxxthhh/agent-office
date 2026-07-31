import { writeFile } from "node:fs/promises";
import { parseTurnEnvelope } from "../protocol.js";
import { usageFromClaude } from "../usage.js";
import { runProcess } from "./process.js";

export class ClaudeAdapter {
  constructor(agent, context) {
    this.agent = agent;
    this.schema = context.schema;
    this.store = context.store;
  }

  // Claude Code validates --json-schema against its own bundled meta-schemas and
  // rejects a `$schema` it cannot resolve by URL, so the declaration is dropped
  // here rather than from schemas/turn.schema.json, which Codex and the docs use.
  #inlineSchema() {
    const { $schema, ...schema } = this.schema ?? {};
    return JSON.stringify(schema);
  }

  async runTurn({ prompt, workspace, timeoutMs, model, effort, signal, onProgress }) {
    const outputPath = this.store.createRunPath(this.agent.id, "claude.json");
    const args = [
      ...(this.agent.commandArgs ?? []),
      "-p",
      // stream-json reports progress while the turn runs and still carries the
      // same final `result` event that `--output-format json` returns.
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      this.#inlineSchema(),
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

    let resultEvent = null;
    const result = await runProcess({
      command: this.agent.command ?? "claude",
      args,
      cwd: workspace,
      input: prompt,
      timeoutMs,
      env: this.agent.env,
      signal,
      onStdoutLine: (line) => {
        const event = safeParse(line);
        if (!event) return;
        if (event.type === "result") resultEvent = event;
        if (!onProgress) return;
        for (const progress of describeClaudeEvent(event)) onProgress(progress);
      }
    });
    await writeFile(outputPath, result.stdout, "utf8");

    const payload = resultEvent ?? parseTrailingResult(result.stdout);
    return {
      response: parseTurnEnvelope(extractClaudePayload(payload) ?? result.stdout),
      tracePath: outputPath,
      stderr: result.stderr,
      usage: usageFromClaude(payload)
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

function extractClaudePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.structured_output) return payload.structured_output;
  if (payload.result && typeof payload.result === "object") return payload.result;
  if (typeof payload.result === "string") return payload.result;
  return null;
}

// Falls back to scanning captured output when the stream produced no `result`
// event, so a malformed stream still yields whatever the agent managed to say.
function parseTrailingResult(stdout) {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    const event = safeParse(line);
    if (event?.type === "result") return event;
  }
  return safeParse(stdout.trim());
}

// One assistant message can hold reasoning followed by several tool calls, so
// every interesting block is reported — returning only the first would make the
// activity feed look far sparser than the turn actually is.
function describeClaudeEvent(event) {
  if (event.type === "assistant") {
    const progress = [];
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use") {
        progress.push({ kind: "tool", detail: block.name ?? "tool" });
      } else if (block.type === "text" && block.text?.trim()) {
        progress.push({ kind: "message", detail: block.text.trim() });
      } else if (block.type === "thinking") {
        progress.push({ kind: "thinking", detail: "thinking" });
      }
    }
    return progress;
  }
  if (event.type === "result") {
    return [{ kind: "result", detail: event.is_error ? "error" : "completed" }];
  }
  return [];
}

function safeParse(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
