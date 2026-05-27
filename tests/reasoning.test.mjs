import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFORT_LEVELS, EFFORT_ORDER, normalizeEffort } from "../scripts/lib/reasoning.mjs";
import { thinkingToEffort } from "../scripts/lib/reasoning.mjs";
import { resolveReasoningEffort } from "../scripts/lib/reasoning.mjs";

test("reasoning: levels + ordering", () => {
  assert.deepEqual(EFFORT_LEVELS, ["off", "low", "medium", "high", "xhigh"]);
  assert.ok(EFFORT_ORDER.high > EFFORT_ORDER.low);
});
test("reasoning: normalizeEffort", () => {
  assert.equal(normalizeEffort("HIGH"), "high");
  assert.equal(normalizeEffort("  off "), "off");
  assert.equal(normalizeEffort("inherit"), "inherit");
  assert.equal(normalizeEffort(""), "inherit");
  assert.equal(normalizeEffort(undefined), "inherit");
  assert.throws(() => normalizeEffort("turbo"), (e) => e.code === "CONFIG");
});
test("reasoning: legacy thinking → effort (all synonyms)", () => {
  for (const on of ["on", "1", "true", "yes", "ON"]) assert.equal(thinkingToEffort(on), "medium");
  for (const off of ["off", "0", "false", "no"]) assert.equal(thinkingToEffort(off), "off");
  assert.equal(thinkingToEffort("auto"), "inherit");
  assert.equal(thinkingToEffort(undefined), "inherit");
  assert.equal(thinkingToEffort(""), "inherit");
  assert.throws(() => thinkingToEffort("maybe"), (e) => e.code === "CONFIG");
});
const L = (o) => ({ perCall: undefined, modelEffort: "inherit", modelThinking: "inherit", serverEffort: "inherit", serverThinking: "inherit", bakedDefault: "high", ...o });
test("resolve: per-call wins", () => assert.equal(resolveReasoningEffort(L({ perCall: "low", modelEffort: "xhigh" })), "low"));
test("resolve: per-model effort > server effort", () => assert.equal(resolveReasoningEffort(L({ modelEffort: "medium", serverEffort: "high" })), "medium"));
test("resolve: per-model effort > per-model thinking", () => assert.equal(resolveReasoningEffort(L({ modelEffort: "low", modelThinking: "off" })), "low"));
test("resolve: server effort > server thinking", () => assert.equal(resolveReasoningEffort(L({ serverEffort: "low", serverThinking: "off" })), "low"));
test("resolve: all inherit → default", () => assert.equal(resolveReasoningEffort(L({})), "high"));
test("resolve: per-call 'inherit' string falls through", () => assert.equal(resolveReasoningEffort(L({ perCall: "inherit", modelEffort: "low" })), "low"));
test("resolve: bad default throws", () => assert.throws(() => resolveReasoningEffort(L({ bakedDefault: "inherit" }))));
