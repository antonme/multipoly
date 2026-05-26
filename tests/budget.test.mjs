import { test } from "node:test";
import assert from "node:assert/strict";
import { assertContentBudget } from "../scripts/lib/budget.mjs";

test("budget: normal completion returns {truncated: false}", () => {
  const r = assertContentBudget(
    { content: "hi there", finishReason: "stop" },
    131072,
    "consult",
  );
  assert.deepEqual(r, { truncated: false });
});

test("budget: consult with truncated non-empty content returns {truncated: true}", () => {
  const r = assertContentBudget(
    { content: "partial markdown...", finishReason: "length" },
    131072,
    "consult",
  );
  assert.deepEqual(r, { truncated: true });
});

test("budget: freeform with truncated non-empty content returns {truncated: true}", () => {
  const r = assertContentBudget(
    { content: "partial answer", finishReason: "length" },
    131072,
    "freeform",
  );
  assert.deepEqual(r, { truncated: true });
});

test("budget: review with truncated content throws (JSON would be incomplete)", () => {
  // Short truncated review JSON (< 64 chars) now triggers the too-short guard
  // before the truncated-at-max_tokens path. Both are valid BUDGET errors.
  assert.throws(
    () =>
      assertContentBudget(
        { content: "{ partial json", finishReason: "length" },
        131072,
        "review",
      ),
    (e) => e.code === "BUDGET" && /too short to be valid review JSON/i.test(e.message),
  );
});

test("budget: strictly-empty content throws for all modes", () => {
  for (const mode of ["review", "consult", "freeform"]) {
    assert.throws(
      () => assertContentBudget({ content: "", finishReason: "length" }, 131072, mode),
      (e) => e.code === "BUDGET",
      `mode=${mode} should throw`,
    );
    assert.throws(
      () => assertContentBudget({ content: "", finishReason: "stop" }, 131072, mode),
      (e) => e.code === "BUDGET",
      `mode=${mode} empty+stop should throw`,
    );
  }
});

test("budget: whitespace-only content is treated as empty and throws BUDGET", () => {
  // A " " / "\n\n" reply is useless — review can't parse it as JSON and
  // consult/freeform would otherwise surface a blank answer with a
  // "truncated" marker. Coalesce to the unrecoverable branch.
  for (const mode of ["review", "consult", "freeform"]) {
    for (const finishReason of ["stop", "length"]) {
      assert.throws(
        () =>
          assertContentBudget(
            { content: "   \n\t ", finishReason },
            131072,
            mode,
          ),
        (e) => e.code === "BUDGET",
        `mode=${mode} finish=${finishReason} whitespace should throw`,
      );
    }
  }
});

test("budget: non-thinking model hint names model cap and avoids thinking advice", () => {
  assert.throws(
    () =>
      assertContentBudget(
        { content: "", finishReason: "length" },
        undefined,
        "review",
        { modelKey: "qwen", supportsThinking: false },
      ),
    (e) =>
      e.code === "BUDGET" &&
      /MULTIPOLY_QWEN_MAX_TOKENS_REVIEW/.test(e.message) &&
      /MULTIPOLY_MAX_TOKENS_REVIEW/.test(e.message) &&
      !/MULTIPOLY_THINKING/.test(e.message) &&
      !/reasoning/.test(e.message),
  );
});
