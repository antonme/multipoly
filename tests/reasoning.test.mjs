import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFORT_LEVELS, EFFORT_ORDER, normalizeEffort } from "../scripts/lib/reasoning.mjs";
import { thinkingToEffort } from "../scripts/lib/reasoning.mjs";

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
