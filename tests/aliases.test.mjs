// tests/aliases.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModelAlias, nearestModelKey, didYouMean, MODEL_ALIASES } from "../scripts/lib/aliases.mjs";

const KEYS = ["glm", "qwen", "deepseek", "composer", "claude", "codex", "gemini", "kimi"];

test("exact configured key resolves to itself", () => {
  assert.equal(resolveModelAlias("codex", KEYS), "codex");
  assert.equal(resolveModelAlias("GLM", KEYS), "glm"); // case-insensitive
});

test("alias maps to canonical key when configured", () => {
  assert.equal(resolveModelAlias("gpt", KEYS), "codex");
  assert.equal(resolveModelAlias("gpt5.5", KEYS), "codex"); // punctuation stripped
  assert.equal(resolveModelAlias("opus", KEYS), "claude");
  assert.equal(resolveModelAlias("flash", KEYS), "gemini");
});

test("alias to an UNCONFIGURED canonical key does not resolve", () => {
  // claude not in the configured set → its alias must not resolve to it
  assert.equal(resolveModelAlias("opus", ["glm", "qwen"]), null);
});

test("unknown name resolves to null (no silent nearest-match routing)", () => {
  assert.equal(resolveModelAlias("totallyunknown", KEYS), null);
  // a near-miss must NOT route:
  assert.equal(resolveModelAlias("codexx", KEYS), null);
});

test("a custom key shadows an alias that would otherwise map elsewhere", () => {
  // if the deployment has a real key named "gpt", exact-match wins over the alias.
  assert.equal(resolveModelAlias("gpt", [...KEYS, "gpt"]), "gpt");
});

test("nearestModelKey is for hints only and respects a threshold", () => {
  assert.equal(nearestModelKey("codexx", KEYS), "codex"); // close
  assert.equal(nearestModelKey("zzzzzz", KEYS), null); // too far → no suggestion
});

test("didYouMean returns a hint string or empty", () => {
  assert.match(didYouMean("codexx", KEYS), /did you mean .*codex/i);
  assert.equal(didYouMean("zzzzzz", KEYS), "");
});

test("non-string input is tolerated and resolves to null", () => {
  assert.equal(resolveModelAlias(null, KEYS), null);
  assert.equal(resolveModelAlias(undefined, KEYS), null);
  assert.equal(resolveModelAlias(42, KEYS), null);
});

test("MODEL_ALIASES never maps to a synthesizer sentinel", () => {
  for (const target of Object.values(MODEL_ALIASES)) {
    assert.ok(!["harness", "none", "caller"].includes(target));
  }
});
