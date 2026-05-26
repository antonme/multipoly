import { GlmError } from "./errors.mjs";

/**
 * GLM 5.1 is a thinking model: reasoning tokens share the `max_tokens` budget
 * with response content. When that budget is exhausted during reasoning, the
 * server returns `finish_reason: "length"` with empty content. Without this
 * check the empty body propagates as a confusing SCHEMA error (for review) or
 * silently returns "" to the caller (for consult/freeform). Surface it as a
 * BUDGET error with an actionable hint instead.
 */
/**
 * Inspect a completion attempt and decide whether the result is usable.
 *
 * Returns { truncated: boolean } when there IS usable content:
 *   - truncated=false: normal completion.
 *   - truncated=true:  non-empty content but finish_reason=length. The caller
 *     gets the partial output and is expected to annotate it (e.g. append a
 *     "[truncated]" marker) rather than discard valuable partial text.
 *
 * Throws BUDGET only when the result is unrecoverable:
 *   - Content is strictly empty (can't return anything useful), OR
 *   - mode is "review" and content was truncated (broken JSON can't be parsed
 *     into the required schema).
 */
export function assertContentBudget(attempt, maxTokens, mode) {
  // Treat whitespace-only content as empty for the budget check. A " " or
  // "\n\n" reply is useless to every caller: review can't parse it as JSON,
  // consult/freeform surface a blank answer with a "truncated" marker that
  // the user can't act on. Coalesce to the unrecoverable branch so they get
  // a clear BUDGET error with remediation hints instead.
  const strictlyEmpty =
    !attempt.content || attempt.content.length === 0 || !/\S/.test(attempt.content);
  const truncated = attempt.finishReason === "length";
  if (!strictlyEmpty && !truncated) return { truncated: false };

  const envVar = `MULTIPOLY_MAX_TOKENS_${mode.toUpperCase()}`;
  const details = { finishReason: attempt.finishReason, usage: attempt.usage };

  if (strictlyEmpty && truncated) {
    throw new GlmError(
      "BUDGET",
      `model exhausted max_tokens (${maxTokens}) during reasoning and emitted no content. ` +
        `Raise ${envVar}, reduce the number of files per call, or set MULTIPOLY_THINKING=off.`,
      { details },
    );
  }
  if (strictlyEmpty) {
    throw new GlmError(
      "BUDGET",
      `model returned empty content (finish_reason=${attempt.finishReason ?? "null"}). ` +
        `For GLM 5.1 in thinking mode the reasoning budget may have consumed max_tokens. ` +
        `Raise ${envVar} or set MULTIPOLY_THINKING=off.`,
      { details },
    );
  }
  // truncated && !strictlyEmpty
  if (mode === "review") {
    // Review requires valid JSON against REVIEW_SCHEMA — partial output is
    // useless, so surface as a hard BUDGET error.
    throw new GlmError(
      "BUDGET",
      `model output was truncated at max_tokens (${maxTokens}); review JSON is incomplete. Raise ${envVar} or reduce the number of files per call.`,
      { details },
    );
  }
  // consult/freeform: preserve the partial content — caller annotates.
  return { truncated: true };
}
