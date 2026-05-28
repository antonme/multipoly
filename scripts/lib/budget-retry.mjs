// scripts/lib/budget-retry.mjs
//
// One-shot adaptive BUDGET retry: when a model call fails the budget check
// (empty / length-truncated → assertContentBudget throws BUDGET), retry the
// SAME model ONCE with more room:
//   • maxTokensOverride = min(maxTokens * 2, MODEL_OUTPUT_CEILING)  (or undefined when maxTokens is undefined)
//   • reasoningEffort   = stepEffortDown(effectiveEffort)
//
// On a second BUDGET failure the error propagates to the caller.
// Non-BUDGET errors are re-thrown immediately without retrying.

import { assertContentBudget } from "./budget.mjs";
import { runModel as defaultRunModel } from "./run-model.mjs";
import { stepEffortDown } from "./reasoning.mjs";

const MODEL_OUTPUT_CEILING = 131072;

/**
 * Run one model call and enforce the content budget.  On a BUDGET failure,
 * retry ONCE with more token headroom and one step less reasoning effort.
 *
 * @param {object} opts
 * @param {object}   opts.runModelArgs    - Args forwarded to runModel (no maxTokensOverride/reasoningEffort on first call — those stay inside opts).
 * @param {string}   opts.mode            - "review" | "consult" | "freeform"
 * @param {number|undefined} opts.maxTokens      - Resolved max_tokens for this call (undefined = no explicit cap).
 * @param {object}   opts.budgetContext   - { modelKey, supportsThinking } forwarded to assertContentBudget.
 * @param {string}   opts.effectiveEffort - Already-resolved concrete effort level for this call.
 * @param {Function} [opts.runModelImpl]  - Injected runModel implementation (for testing); defaults to runModel.
 *
 * @returns {Promise<{attempt, truncated: boolean, retried: boolean}>}
 */
export async function callWithBudgetRetry({
  runModelArgs,
  mode,
  maxTokens,
  budgetContext,
  effectiveEffort,
  runModelImpl = defaultRunModel,
}) {
  // --- Attempt 1 ---
  const a1 = await runModelImpl(runModelArgs);
  let budgetResult1;
  try {
    budgetResult1 = assertContentBudget(a1, maxTokens, mode, budgetContext);
  } catch (e) {
    if (e.code !== "BUDGET") throw e; // non-BUDGET: propagate immediately

    // --- Attempt 2: bump tokens + step down effort ---
    // Guard against NaN: if maxTokens is undefined (NONE model), leave override undefined.
    const bumped = maxTokens !== undefined ? Math.min(maxTokens * 2, MODEL_OUTPUT_CEILING) : undefined;
    const lowered = stepEffortDown(effectiveEffort);

    const a2 = await runModelImpl({
      ...runModelArgs,
      maxTokensOverride: bumped,
      reasoningEffort: lowered,
    });

    // Use bumped ?? maxTokens so assertContentBudget uses the correct limit
    // in its error message when bumped is undefined.
    const budgetResult2 = assertContentBudget(a2, bumped ?? maxTokens, mode, budgetContext);
    return { attempt: a2, truncated: budgetResult2.truncated, retried: true };
  }

  return { attempt: a1, truncated: budgetResult1.truncated, retried: false };
}
