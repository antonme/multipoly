// tests/budget-retry.test.mjs
// Unit tests for the callWithBudgetRetry helper (budget-retry.mjs).
// Uses a RECORDING fake runModel injected via the runModelImpl parameter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { callWithBudgetRetry } from "../scripts/lib/budget-retry.mjs";
import { EFFORT_LEVELS, EFFORT_ORDER } from "../scripts/lib/reasoning.mjs";

// ---------------------------------------------------------------------------
// Helpers for building fake runModel implementations
// ---------------------------------------------------------------------------

/**
 * Build a valid review-shaped completion (content is big enough to pass
 * assertContentBudget's minimum-chars check for review mode).
 */
function validReviewAttempt() {
  return {
    content: JSON.stringify({
      schema_version: "1",
      findings: [],
      summary_md: "all good",
    }),
    finishReason: "stop",
  };
}

function validConsultAttempt() {
  return { content: "Some detailed answer here.", finishReason: "stop" };
}

/** Empty+length attempt — always triggers a BUDGET error for review mode. */
function budgetFailAttempt() {
  return { content: "", finishReason: "length" };
}

/** Record calls and return pre-canned responses in order. */
function makeRecordingRunModel(responses) {
  const calls = [];
  const fn = async (args) => {
    calls.push({ ...args });
    const resp = responses[calls.length - 1];
    if (resp === undefined) throw new Error(`Unexpected call #${calls.length}`);
    return resp;
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// Shared budget context (review)
// ---------------------------------------------------------------------------
const reviewCtx = { modelKey: "glm", supportsThinking: true };
const consultCtx = { modelKey: "glm", supportsThinking: true };
const MAX_TOKENS_REVIEW = 32768;
const CEILING = 131072;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("budget-retry: single call succeeds — no retry", async () => {
  const fake = makeRecordingRunModel([validReviewAttempt()]);
  const result = await callWithBudgetRetry({
    runModelArgs: { model: "glm-5.1" },
    mode: "review",
    maxTokens: MAX_TOKENS_REVIEW,
    budgetContext: reviewCtx,
    effectiveEffort: "medium",
    runModelImpl: fake,
  });
  assert.equal(fake.calls.length, 1, "should make exactly 1 call");
  assert.equal(result.retried, false);
  assert.equal(result.truncated, false);
  assert.ok(result.attempt, "should have attempt");
});

test("budget-retry: BUDGET on call 1, success on call 2 — retry happens", async () => {
  const fake = makeRecordingRunModel([budgetFailAttempt(), validReviewAttempt()]);
  const result = await callWithBudgetRetry({
    runModelArgs: { model: "glm-5.1" },
    mode: "review",
    maxTokens: MAX_TOKENS_REVIEW,
    budgetContext: reviewCtx,
    effectiveEffort: "medium",
    runModelImpl: fake,
  });
  assert.equal(fake.calls.length, 2, "should make exactly 2 calls");
  assert.equal(result.retried, true);
  assert.equal(result.truncated, false);
  // Call 2 must have bumped maxTokensOverride
  const call2 = fake.calls[1];
  const expectedBumped = Math.min(MAX_TOKENS_REVIEW * 2, CEILING);
  assert.equal(call2.maxTokensOverride, expectedBumped, "retry must double max_tokens (clamped to ceiling)");
  // Call 2 must have stepped effort down from medium
  const mediumIndex = EFFORT_ORDER["medium"];
  const expectedLowered = EFFORT_LEVELS[mediumIndex - 1];
  assert.equal(call2.reasoningEffort, expectedLowered, "retry must step effort down one level");
  // Call 1 must NOT have maxTokensOverride
  assert.equal(fake.calls[0].maxTokensOverride, undefined, "first call must not have override");
});

test("budget-retry: BUDGET on both calls — throws BUDGET after exactly 2 calls", async () => {
  const fake = makeRecordingRunModel([budgetFailAttempt(), budgetFailAttempt()]);
  await assert.rejects(
    () =>
      callWithBudgetRetry({
        runModelArgs: { model: "glm-5.1" },
        mode: "review",
        maxTokens: MAX_TOKENS_REVIEW,
        budgetContext: reviewCtx,
        effectiveEffort: "high",
        runModelImpl: fake,
      }),
    (e) => {
      // Fix A: error must note the adaptive retry already ran
      if (e.code !== "BUDGET") return false;
      assert.ok(e.details?.adaptiveRetry === true, "details.adaptiveRetry must be true");
      assert.match(e.message, /adaptive retry/, "message must mention 'adaptive retry'");
      return true;
    },
    "should throw BUDGET after 2 budget failures",
  );
  assert.equal(fake.calls.length, 2, "should attempt exactly 2 calls");
});

// Fix B: maxTokensUsed returned accurately
test("budget-retry: maxTokensUsed equals original on first-attempt success", async () => {
  const fake = makeRecordingRunModel([validReviewAttempt()]);
  const result = await callWithBudgetRetry({
    runModelArgs: { model: "glm-5.1" },
    mode: "review",
    maxTokens: MAX_TOKENS_REVIEW,
    budgetContext: reviewCtx,
    effectiveEffort: "medium",
    runModelImpl: fake,
  });
  assert.equal(result.maxTokensUsed, MAX_TOKENS_REVIEW, "maxTokensUsed must equal original maxTokens on no-retry path");
});

test("budget-retry: maxTokensUsed equals bumped value on retry path", async () => {
  const fake = makeRecordingRunModel([budgetFailAttempt(), validReviewAttempt()]);
  const result = await callWithBudgetRetry({
    runModelArgs: { model: "glm-5.1" },
    mode: "review",
    maxTokens: 8192,
    budgetContext: reviewCtx,
    effectiveEffort: "medium",
    runModelImpl: fake,
  });
  assert.equal(result.retried, true);
  assert.equal(result.maxTokensUsed, 16384, "maxTokensUsed must equal bumped value (8192*2=16384) on retry path");
});

test("budget-retry: effort=off — retry bumps tokens only, effort stays off", async () => {
  const fake = makeRecordingRunModel([budgetFailAttempt(), validReviewAttempt()]);
  const result = await callWithBudgetRetry({
    runModelArgs: { model: "glm-5.1" },
    mode: "review",
    maxTokens: MAX_TOKENS_REVIEW,
    budgetContext: reviewCtx,
    effectiveEffort: "off",
    runModelImpl: fake,
  });
  assert.equal(result.retried, true);
  const call2 = fake.calls[1];
  // effort=off is the floor — stays off
  assert.equal(call2.reasoningEffort, "off", "off is the floor, should stay off");
  // tokens still bumped
  assert.equal(call2.maxTokensOverride, Math.min(MAX_TOKENS_REVIEW * 2, CEILING));
});

test("budget-retry: undefined maxTokens (NONE model) — no NaN in retry call", async () => {
  const fake = makeRecordingRunModel([budgetFailAttempt(), validConsultAttempt()]);
  // Use consult mode with undefined maxTokens (a NONE-capability model with no cap)
  const result = await callWithBudgetRetry({
    runModelArgs: { model: "some-model" },
    mode: "consult",
    maxTokens: undefined,
    budgetContext: consultCtx,
    effectiveEffort: "medium",
    runModelImpl: fake,
  });
  assert.equal(result.retried, true);
  const call2 = fake.calls[1];
  // maxTokensOverride must NOT be NaN
  assert.ok(
    call2.maxTokensOverride === undefined || !Number.isNaN(call2.maxTokensOverride),
    `maxTokensOverride must not be NaN, got ${call2.maxTokensOverride}`,
  );
  // effort stepped down
  const mediumIndex = EFFORT_ORDER["medium"];
  assert.equal(call2.reasoningEffort, EFFORT_LEVELS[mediumIndex - 1]);
});

test("budget-retry: non-BUDGET error is re-thrown immediately (no retry)", async () => {
  const networkError = new Error("network timeout");
  let callCount = 0;
  const fake = async () => {
    callCount++;
    throw networkError;
  };
  await assert.rejects(
    () =>
      callWithBudgetRetry({
        runModelArgs: { model: "glm-5.1" },
        mode: "review",
        maxTokens: MAX_TOKENS_REVIEW,
        budgetContext: reviewCtx,
        effectiveEffort: "medium",
        runModelImpl: fake,
      }),
    (e) => e === networkError,
    "non-BUDGET error must be re-thrown as-is",
  );
  assert.equal(callCount, 1, "should not retry on non-BUDGET error");
});

test("budget-retry: max_tokens at ceiling — retry clamped to ceiling (no overflow)", async () => {
  const fake = makeRecordingRunModel([budgetFailAttempt(), validReviewAttempt()]);
  await callWithBudgetRetry({
    runModelArgs: { model: "glm-5.1" },
    mode: "review",
    maxTokens: CEILING, // already at the ceiling
    budgetContext: reviewCtx,
    effectiveEffort: "low",
    runModelImpl: fake,
  });
  const call2 = fake.calls[1];
  // 2× CEILING would be 262144 but must be clamped to CEILING
  assert.equal(call2.maxTokensOverride, CEILING, "should clamp to ceiling");
});

test("budget-retry: xhigh effort steps down to high", async () => {
  const fake = makeRecordingRunModel([budgetFailAttempt(), validReviewAttempt()]);
  await callWithBudgetRetry({
    runModelArgs: { model: "glm-5.1" },
    mode: "review",
    maxTokens: MAX_TOKENS_REVIEW,
    budgetContext: reviewCtx,
    effectiveEffort: "xhigh",
    runModelImpl: fake,
  });
  const call2 = fake.calls[1];
  assert.equal(call2.reasoningEffort, "high", "xhigh → high on step-down");
});

test("budget-retry: consult mode with finishReason=stop returns truncated=false (no retry)", async () => {
  const partialAttempt = { content: "Some partial answer...", finishReason: "stop" };
  const fake = makeRecordingRunModel([partialAttempt]);
  const result = await callWithBudgetRetry({
    runModelArgs: { model: "some-model" },
    mode: "consult",
    maxTokens: 8192,
    budgetContext: consultCtx,
    effectiveEffort: "medium",
    runModelImpl: fake,
  });
  assert.equal(result.truncated, false); // stop reason, not truncated
  assert.equal(result.retried, false);
  assert.equal(fake.calls.length, 1);
});

test("budget-retry: non-empty length-truncated consult returns truncated=true WITHOUT retrying", async () => {
  const truncatedAttempt = { content: "Partial answer that got cut off...", finishReason: "length" };
  const fake = makeRecordingRunModel([truncatedAttempt]);
  const result = await callWithBudgetRetry({
    runModelArgs: { model: "some-model" },
    mode: "consult",
    maxTokens: 8192,
    budgetContext: consultCtx,
    effectiveEffort: "medium",
    runModelImpl: fake,
  });
  assert.equal(fake.calls.length, 1, "must not retry a usable truncated consult");
  assert.equal(result.truncated, true);
  assert.equal(result.retried, false);
});
