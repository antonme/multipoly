import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFORT_LEVELS, EFFORT_ORDER, normalizeEffort } from "../scripts/lib/reasoning.mjs";

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
