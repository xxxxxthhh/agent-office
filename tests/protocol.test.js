import "./_hang-watchdog.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseTurnEnvelope } from "../src/protocol.js";

test("parses a strict protocol response", () => {
  const response = parseTurnEnvelope(JSON.stringify({
    summary: "Implemented the slice.",
    status: "done",
    messages: [{ to: "reviewer", body: "Please review the tests." }],
    artifacts: ["src/index.js"],
    needsUser: false
  }));

  assert.equal(response.status, "done");
  assert.deepEqual(response.messages, [{ to: "reviewer", body: "Please review the tests." }]);
  assert.deepEqual(response.artifacts, ["src/index.js"]);
});

test("extracts JSON from a fenced model response", () => {
  const response = parseTurnEnvelope(`Result:
\`\`\`json
{"summary":"Reviewed it.","status":"done","messages":[],"artifacts":[],"needsUser":false}
\`\`\``);

  assert.equal(response.summary, "Reviewed it.");
  assert.equal(response.status, "done");
});

test("preserves useful plain text as a working response", () => {
  const response = parseTurnEnvelope("I inspected the repository and need another turn.");

  assert.equal(response.summary, "I inspected the repository and need another turn.");
  assert.equal(response.status, "working");
});

test("drops malformed message and artifact entries", () => {
  const response = parseTurnEnvelope({
    summary: "Handled invalid fields.",
    status: "unexpected",
    messages: [{ to: "", body: "ignored" }, null, { to: "team", body: "valid" }],
    artifacts: ["ok.txt", "", 42],
    needsUser: "yes"
  });

  assert.equal(response.status, "working");
  assert.deepEqual(response.messages, [{ to: "team", body: "valid" }]);
  assert.deepEqual(response.artifacts, ["ok.txt"]);
  assert.equal(response.needsUser, false);
});
