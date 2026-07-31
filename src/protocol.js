import { readFile } from "node:fs/promises";
import { ConfigError } from "./errors.js";

const STATUSES = new Set(["working", "blocked", "done"]);

export async function loadTurnSchema(schemaPath) {
  return JSON.parse(await readFile(schemaPath, "utf8"));
}

export function parseTurnEnvelope(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return normalizeTurnEnvelope(input);
  }

  if (typeof input !== "string" || input.trim() === "") {
    throw new ConfigError("Agent returned an empty response");
  }

  const trimmed = input.trim();
  const candidates = [
    trimmed,
    extractFencedJson(trimmed),
    extractBalancedObject(trimmed)
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return normalizeTurnEnvelope(JSON.parse(candidate));
    } catch {
      // Continue to the next representation.
    }
  }

  return normalizeTurnEnvelope({
    summary: trimmed,
    status: "working",
    messages: [],
    artifacts: [],
    needsUser: false
  });
}

export function normalizeTurnEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("Agent response must be a JSON object");
  }

  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (!summary) {
    throw new ConfigError("Agent response is missing a non-empty summary");
  }

  const status = STATUSES.has(value.status) ? value.status : "working";
  const messages = Array.isArray(value.messages)
    ? value.messages
        .filter((message) => message && typeof message === "object")
        .map((message) => ({
          to: typeof message.to === "string" ? message.to.trim() : "",
          body: typeof message.body === "string" ? message.body.trim() : ""
        }))
        .filter((message) => message.to && message.body)
    : [];
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];

  return {
    summary,
    status,
    messages,
    artifacts,
    needsUser: value.needsUser === true
  };
}

function extractFencedJson(value) {
  const match = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim();
}

function extractBalancedObject(value) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return value.slice(start, end + 1);
}
