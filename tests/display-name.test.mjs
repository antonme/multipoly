// tests/display-name.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { transportSuffix, computeDisplayName } from "../scripts/lib/display-name.mjs";

test("transportSuffix maps cli kinds to '<kind> cli'", () => {
  assert.equal(transportSuffix("cli", "claude"), "claude cli");
  assert.equal(transportSuffix("cli", "codex"), "codex cli");
  assert.equal(transportSuffix("cli", "cursor"), "cursor cli");
  assert.equal(transportSuffix("cli", "agy"), "agy cli");
});

test("transportSuffix maps api transports to 'api'", () => {
  assert.equal(transportSuffix("anthropic"), "api");
  assert.equal(transportSuffix("http"), "api");
});

test("computeDisplayName follows '<base> (<suffix>)'", () => {
  assert.equal(computeDisplayName("opus", "cli", "claude"), "opus (claude cli)");
  assert.equal(computeDisplayName("opus", "anthropic"), "opus (api)");
  assert.equal(computeDisplayName("gpt5.5", "cli", "codex"), "gpt5.5 (codex cli)");
  assert.equal(computeDisplayName("gpt5.5", "http"), "gpt5.5 (api)");
});
