// tests/net-config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { enableHappyEyeballs } from "../scripts/lib/net-config.mjs";

test("calls setDefaultAutoSelectFamily(true) when present", () => {
  let called = null;
  enableHappyEyeballs({ setDefaultAutoSelectFamily: (v) => { called = v; } });
  assert.equal(called, true);
});

test("is a no-op when the API is absent (old Node)", () => {
  // must not throw
  assert.doesNotThrow(() => enableHappyEyeballs({}));
  assert.equal(enableHappyEyeballs({}), false);
});

test("returns true when it enabled happy-eyeballs", () => {
  assert.equal(enableHappyEyeballs({ setDefaultAutoSelectFamily: () => {} }), true);
});
