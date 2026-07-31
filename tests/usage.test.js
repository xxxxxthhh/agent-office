import test from "node:test";
import assert from "node:assert/strict";
import { totalUsage, usageFromClaude, usageFromCodex } from "../src/usage.js";

test("reads tokens and cost from a real Claude result envelope", () => {
  // Shape taken from `claude -p --output-format stream-json` output.
  const usage = usageFromClaude({
    total_cost_usd: 0.0697726,
    usage: {
      input_tokens: 19,
      output_tokens: 785,
      cache_read_input_tokens: 30596,
      cache_creation_input_tokens: 31078
    }
  });

  assert.equal(usage.inputTokens, 19);
  assert.equal(usage.outputTokens, 785);
  assert.equal(usage.cachedInputTokens, 30596);
  assert.equal(usage.costUsd, 0.0697726);
});

test("reads tokens from a real Codex turn.completed event and reports no cost", () => {
  // Shape taken from `codex exec --json` output.
  const usage = usageFromCodex({
    input_tokens: 19807,
    cached_input_tokens: 4480,
    output_tokens: 29,
    reasoning_output_tokens: 22
  });

  assert.equal(usage.inputTokens, 19807);
  assert.equal(usage.cachedInputTokens, 4480);
  assert.equal(usage.reasoningOutputTokens, 22);
  // Codex reports no dollar figure; null must never be read as zero spend.
  assert.equal(usage.costUsd, null);
});

test("marks a mixed-provider total as partial instead of understating spend", () => {
  const total = totalUsage([
    { usage: usageFromClaude({ total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5 } }) },
    { usage: usageFromCodex({ input_tokens: 100, output_tokens: 20 }) }
  ]);

  assert.equal(total.inputTokens, 110, "tokens are comparable across providers");
  assert.equal(total.outputTokens, 25);
  assert.equal(total.costUsd, 0.5);
  assert.equal(total.costIsPartial, true, "a Codex turn contributed no cost");
});

test("reports no cost at all rather than a misleading zero", () => {
  const total = totalUsage([
    { usage: usageFromCodex({ input_tokens: 100, output_tokens: 20 }) }
  ]);

  assert.equal(total.costUsd, null);
  assert.equal(total.costIsPartial, false, "nothing is partial when no cost exists anywhere");
});

test("ignores turns recorded before usage was captured", () => {
  const total = totalUsage([{ usage: null }, { summary: "legacy turn" }]);

  assert.equal(total.turnsWithUsage, 0);
  assert.equal(total.inputTokens, 0);
  assert.equal(total.costUsd, null);
});
