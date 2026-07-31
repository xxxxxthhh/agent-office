// Normalised accounting for one agent turn.
//
// The two providers report different things: Codex emits token counts only,
// Claude Code emits token counts *and* a dollar figure. Tokens are therefore the
// comparable metric across adapters, and `costUsd` is deliberately nullable —
// callers must treat a null as "this provider does not report cost", never as
// zero, or a mixed-adapter total would silently understate spend.

export function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    costUsd: null
  };
}

export function usageFromClaude(payload) {
  const usage = payload?.usage;
  const cost = typeof payload?.total_cost_usd === "number" ? payload.total_cost_usd : null;
  if (!usage || typeof usage !== "object") {
    return cost === null ? null : { ...emptyUsage(), costUsd: cost };
  }
  return {
    inputTokens: numberOr(usage.input_tokens, 0),
    outputTokens: numberOr(usage.output_tokens, 0),
    cachedInputTokens: numberOr(usage.cache_read_input_tokens, 0),
    reasoningOutputTokens: 0,
    costUsd: cost
  };
}

export function usageFromCodex(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    inputTokens: numberOr(usage.input_tokens, 0),
    outputTokens: numberOr(usage.output_tokens, 0),
    cachedInputTokens: numberOr(usage.cached_input_tokens, 0),
    reasoningOutputTokens: numberOr(usage.reasoning_output_tokens, 0),
    // Codex does not report a dollar amount.
    costUsd: null
  };
}

// Sums turn usage. `costUsd` stays null until at least one turn reports a cost;
// `costIsPartial` says whether some turns contributed tokens but no cost, so the
// UI can label an incomplete total instead of presenting it as authoritative.
export function totalUsage(turns) {
  const total = { ...emptyUsage(), costIsPartial: false, turnsWithUsage: 0 };
  let sawCost = false;
  for (const turn of turns ?? []) {
    const usage = turn?.usage;
    if (!usage) continue;
    total.turnsWithUsage += 1;
    total.inputTokens += numberOr(usage.inputTokens, 0);
    total.outputTokens += numberOr(usage.outputTokens, 0);
    total.cachedInputTokens += numberOr(usage.cachedInputTokens, 0);
    total.reasoningOutputTokens += numberOr(usage.reasoningOutputTokens, 0);
    if (typeof usage.costUsd === "number") {
      sawCost = true;
      total.costUsd = (total.costUsd ?? 0) + usage.costUsd;
    } else {
      total.costIsPartial = true;
    }
  }
  if (!sawCost) {
    total.costUsd = null;
    // With no cost anywhere there is nothing partial to warn about.
    total.costIsPartial = false;
  }
  return total;
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}
