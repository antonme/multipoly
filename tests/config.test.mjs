import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  ENDPOINT_PROFILES,
  resolveCallTimeoutMs,
  TIMEOUT_BOUNDS,
} from "../scripts/lib/config.mjs";
import { MODEL_INFO, MODEL_KEYS } from "../scripts/lib/models.mjs";

const base = { GLM_API_KEY: "test-key" };

test("config: defaults", () => {
  const c = loadConfig({ ...base });
  assert.equal(c.models.glm.configured, true);
  assert.equal(c.models.glm.baseUrl, ENDPOINT_PROFILES["zai-coding-plan"]);
  assert.equal(c.models.glm.model, "glm-5.1");
  assert.equal(c.models.glm.apiKey, "test-key");
  assert.deepEqual(c.models.glm.maxTokens, { review: 131072, consult: 131072 });
  assert.equal(c.models.qwen.configured, false);
  assert.deepEqual(c.models.qwen.maxTokens, { review: undefined, consult: undefined });
  assert.equal(c.models.deepseek.configured, false);
  assert.equal(c.models.composer.configured, false);
  assert.equal(c.thinking, "auto"); // mode-default retired: unset MULTIPOLY_THINKING now means "auto" (don't send a thinking toggle; rely on per-model reasoningEffort)
  assert.equal(c.maxTokens.review, 131072);
  assert.equal(c.maxTokens.consult, 131072);
  assert.equal("freeform" in c.maxTokens, false);
  assert.equal(c.timeoutMs, 600000);
  assert.equal(c.allowSecrets, false);
  assert.equal(c.debugReasoning, false);
  assert.equal(c.caps.perFile, 256 * 1024);
  assert.equal(c.caps.total, 1536 * 1024);
  assert.equal(c.caps.fileCount, 50);
  assert.equal(c.progress, "heartbeat");
});

test("config: GLM_PROGRESS parsed", () => {
  assert.equal(loadConfig({ ...base, GLM_PROGRESS: "off" }).progress, "off");
  assert.equal(loadConfig({ ...base, GLM_PROGRESS: "heartbeat" }).progress, "heartbeat");
  assert.equal(loadConfig({ ...base, GLM_PROGRESS: "reasoning" }).progress, "reasoning");
  assert.equal(loadConfig({ ...base, GLM_PROGRESS: "FULL" }).progress, "reasoning");
  assert.throws(
    () => loadConfig({ ...base, GLM_PROGRESS: "chatty" }),
    (e) => e.code === "CONFIG",
  );
});

test("config: ZHIPU_API_KEY falls back when GLM_API_KEY is missing", () => {
  const c = loadConfig({ ZHIPU_API_KEY: "zk" });
  assert.equal(c.models.glm.apiKey, "zk");
});

test("config: missing key throws AUTH", () => {
  assert.throws(() => loadConfig({}), (e) => e.code === "AUTH");
});

test("config: custom endpoint requires GLM_BASE_URL", () => {
  assert.throws(
    () => loadConfig({ ...base, GLM_ENDPOINT: "custom" }),
    (e) => e.code === "CONFIG",
  );
});

test("config: custom endpoint accepts GLM_BASE_URL and trims trailing slashes", () => {
  const c = loadConfig({
    ...base,
    GLM_ENDPOINT: "custom",
    GLM_BASE_URL: "https://example.com/v1/////",
  });
  assert.equal(c.models.glm.baseUrl, "https://example.com/v1");
});

test("config: unknown endpoint rejected", () => {
  assert.throws(
    () => loadConfig({ ...base, GLM_ENDPOINT: "nope" }),
    (e) => e.code === "CONFIG",
  );
});

test("config: bigmodel-cn endpoint resolves", () => {
  const c = loadConfig({ ...base, GLM_ENDPOINT: "bigmodel-cn" });
  assert.equal(c.models.glm.baseUrl, ENDPOINT_PROFILES["bigmodel-cn"]);
});

test("config: thinking parsed", () => {
  assert.equal(loadConfig({ ...base, GLM_THINKING: "on" }).thinking, "on");
  assert.equal(loadConfig({ ...base, GLM_THINKING: "off" }).thinking, "off");
  assert.equal(loadConfig({ ...base, GLM_THINKING: "auto" }).thinking, "auto");
  assert.throws(
    () => loadConfig({ ...base, GLM_THINKING: "maybe" }),
    (e) => e.code === "CONFIG",
  );
});

test("config: GLM_API_KEY wins over ZHIPU_API_KEY", () => {
  const c = loadConfig({ GLM_API_KEY: "glm", ZHIPU_API_KEY: "zk" });
  assert.equal(c.models.glm.apiKey, "glm");
});

test("config: numeric overrides accepted", () => {
  const c = loadConfig({
    ...base,
    GLM_MAX_TOKENS_REVIEW: "1000",
    GLM_TIMEOUT_MS: "60000",
    GLM_PER_FILE_CAP_BYTES: "1024",
  });
  assert.equal(c.maxTokens.review, 1000);
  assert.equal(c.timeoutMs, 60000);
  assert.equal(c.caps.perFile, 1024);
});

test("config: MULTIPOLY server-wide env vars override legacy GLM env vars", () => {
  const c = loadConfig({
    ...base,
    GLM_THINKING: "off",
    MULTIPOLY_THINKING: "on",
    GLM_MAX_TOKENS_REVIEW: "1000",
    MULTIPOLY_MAX_TOKENS_REVIEW: "2000",
    GLM_TIMEOUT_MS: "60000",
    MULTIPOLY_TIMEOUT_MS: "70000",
    GLM_PROGRESS: "off",
    MULTIPOLY_PROGRESS: "heartbeat",
    GLM_ALLOW_SECRETS: "0",
    MULTIPOLY_ALLOW_SECRETS: "1",
    GLM_DEBUG_REASONING: "0",
    MULTIPOLY_DEBUG_REASONING: "1",
    GLM_PER_FILE_CAP_BYTES: "1024",
    MULTIPOLY_PER_FILE_CAP_BYTES: "2048",
    GLM_TOTAL_CAP_BYTES: "4096",
    MULTIPOLY_TOTAL_CAP_BYTES: "8192",
    GLM_FILE_COUNT_CAP: "5",
    MULTIPOLY_FILE_COUNT_CAP: "9",
  });
  assert.equal(c.thinking, "on");
  assert.equal(c.maxTokens.review, 2000);
  assert.equal(c.timeoutMs, 70000);
  assert.equal(c.progress, "heartbeat");
  assert.equal(c.allowSecrets, true);
  assert.equal(c.debugReasoning, true);
  assert.equal(c.caps.perFile, 2048);
  assert.equal(c.caps.total, 8192);
  assert.equal(c.caps.fileCount, 9);
});

test("config: dead freeform token env var is ignored", () => {
  const c = loadConfig({
    ...base,
    MULTIPOLY_MAX_TOKENS_FREEFORM: "not-an-integer",
    GLM_MAX_TOKENS_FREEFORM: "-5",
  });
  assert.equal(c.maxTokens.review, 131072);
  assert.equal("freeform" in c.maxTokens, false);
});

test("config: resolveCallTimeoutMs — absent returns undefined", () => {
  assert.equal(resolveCallTimeoutMs(undefined), undefined);
  assert.equal(resolveCallTimeoutMs(null), undefined);
});

test("config: resolveCallTimeoutMs — valid integer passes through", () => {
  assert.equal(resolveCallTimeoutMs(90000), 90000);
  assert.equal(resolveCallTimeoutMs(TIMEOUT_BOUNDS.min), TIMEOUT_BOUNDS.min);
  assert.equal(resolveCallTimeoutMs(TIMEOUT_BOUNDS.max), TIMEOUT_BOUNDS.max);
});

test("config: resolveCallTimeoutMs — rejects non-integer / out-of-range / wrong type", () => {
  for (const bad of [0, -1, 1.5, TIMEOUT_BOUNDS.max + 1, "60000", NaN, Infinity, {}]) {
    assert.throws(
      () => resolveCallTimeoutMs(bad),
      (e) => e.code === "INVALID_INPUT",
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test("config: bogus numeric rejected", () => {
  assert.throws(
    () => loadConfig({ ...base, GLM_TIMEOUT_MS: "abc" }),
    (e) => e.code === "CONFIG",
  );
  assert.throws(
    () => loadConfig({ ...base, GLM_MAX_TOKENS_REVIEW: "-5" }),
    (e) => e.code === "CONFIG",
  );
});

test("config: GLM_BASE_URL http is rejected for non-loopback", () => {
  assert.throws(
    () => loadConfig({
      ...base,
      GLM_ENDPOINT: "custom",
      GLM_BASE_URL: "http://evil.example.com/v1",
    }),
    (e) => e.code === "CONFIG",
  );
});

test("config: GLM_BASE_URL http allowed for loopback", () => {
  const c = loadConfig({
    ...base,
    GLM_ENDPOINT: "custom",
    GLM_BASE_URL: "http://localhost:8080/v1",
  });
  assert.equal(c.models.glm.baseUrl, "http://localhost:8080/v1");
  const c2 = loadConfig({
    ...base,
    GLM_ENDPOINT: "custom",
    GLM_BASE_URL: "http://127.0.0.1:8080/v1",
  });
  assert.equal(c2.models.glm.baseUrl, "http://127.0.0.1:8080/v1");
});

test("config: GLM_BASE_URL rejects file:// and garbage", () => {
  assert.throws(
    () => loadConfig({ ...base, GLM_ENDPOINT: "custom", GLM_BASE_URL: "file:///etc" }),
    (e) => e.code === "CONFIG",
  );
  assert.throws(
    () => loadConfig({ ...base, GLM_ENDPOINT: "custom", GLM_BASE_URL: "not a url" }),
    (e) => e.code === "CONFIG",
  );
});

test("config: GLM_BASE_URL rejects userinfo (prevents exfil via credentials)", () => {
  assert.throws(
    () => loadConfig({ ...base, GLM_ENDPOINT: "custom", GLM_BASE_URL: "https://user:pw@api.test/v1" }),
    (e) => e.code === "CONFIG",
  );
});

test("config: GLM_BASE_URL accepts IPv6 loopback (bracketed hostname)", () => {
  const c = loadConfig({
    ...base,
    GLM_ENDPOINT: "custom",
    GLM_BASE_URL: "http://[::1]:8080/v1",
  });
  assert.equal(c.models.glm.baseUrl, "http://[::1]:8080/v1");
});

test("config: GLM_BASE_URL accepts 127.x.x.x loopback range", () => {
  const c = loadConfig({
    ...base,
    GLM_ENDPOINT: "custom",
    GLM_BASE_URL: "http://127.0.0.2:8080/v1",
  });
  assert.equal(c.models.glm.baseUrl, "http://127.0.0.2:8080/v1");
});

test("config: GLM_BASE_URL accepts IPv4-mapped IPv6 loopback (any form)", () => {
  // Both the dotted "::ffff:127.0.0.1" and its canonical "::ffff:7f00:1"
  // normalization must be accepted, and the canonical form round-trips.
  const c1 = loadConfig({
    ...base,
    GLM_ENDPOINT: "custom",
    GLM_BASE_URL: "http://[::ffff:127.0.0.1]:8080/v1",
  });
  assert.ok(c1.models.glm.baseUrl.startsWith("http://[::ffff:"));
  const c2 = loadConfig({
    ...base,
    GLM_ENDPOINT: "custom",
    GLM_BASE_URL: "http://[::ffff:7fff:ffff]:8080/v1",
  });
  assert.equal(c2.models.glm.baseUrl, "http://[::ffff:7fff:ffff]:8080/v1");
});

test("config: GLM_BASE_URL rejects 127-lookalike non-loopback host", () => {
  // Guardrail: "127.0.0.1.evil.com" must not be treated as loopback.
  assert.throws(
    () => loadConfig({
      ...base,
      GLM_ENDPOINT: "custom",
      GLM_BASE_URL: "http://127.0.0.1.evil.com/v1",
    }),
    (e) => e.code === "CONFIG",
  );
});

test("config: GLM_TIMEOUT_MS rejects setTimeout overflow", () => {
  assert.throws(
    () => loadConfig({ ...base, GLM_TIMEOUT_MS: "999999999999" }),
    (e) => e.code === "CONFIG",
  );
});

test("config: GLM_BASE_URL rejects query/fragment", () => {
  assert.throws(
    () => loadConfig({ ...base, GLM_ENDPOINT: "custom", GLM_BASE_URL: "https://api.test/v1?leak=1" }),
    (e) => e.code === "CONFIG",
  );
  assert.throws(
    () => loadConfig({ ...base, GLM_ENDPOINT: "custom", GLM_BASE_URL: "https://api.test/v1#x" }),
    (e) => e.code === "CONFIG",
  );
});

test("config: non-GLM base URL errors name the model-specific env var", () => {
  assert.throws(
    () =>
      loadConfig({
        MULTIPOLY_GLM_API_KEY: "glm-key",
        MULTIPOLY_QWEN_API_KEY: "qwen-key",
        MULTIPOLY_QWEN_BASE_URL: "http://qwen.example/v1",
      }),
    (e) =>
      e.code === "CONFIG" &&
      /MULTIPOLY_QWEN_BASE_URL/.test(e.message) &&
      !/GLM_BASE_URL/.test(e.message),
  );
});

test("config: loads configured model endpoints independently", () => {
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "glm-key",
    MULTIPOLY_QWEN_API_KEY: "qwen-key",
    MULTIPOLY_QWEN_BASE_URL: "https://qwen.example/v1",
    MULTIPOLY_QWEN_MODEL: "qwen3.7max",
  });
  assert.equal(c.models.glm.configured, true);
  assert.equal(c.models.qwen.configured, true);
  assert.equal(c.models.deepseek.configured, false);
  assert.equal(c.models.composer.configured, false);
  assert.equal(c.models.qwen.model, "qwen3.7max");
  assert.equal(c.models.qwen.baseUrl, "https://qwen.example/v1");
  assert.equal(c.models.qwen.apiKey, "qwen-key");
  assert.deepEqual(c.models.qwen.maxTokens, { review: undefined, consult: undefined });
});

test("config: model-specific max token env vars configure non-GLM caps", () => {
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "glm-key",
    MULTIPOLY_QWEN_API_KEY: "qwen-key",
    MULTIPOLY_QWEN_BASE_URL: "https://qwen.example/v1",
    MULTIPOLY_QWEN_MAX_TOKENS_REVIEW: "32768",
    MULTIPOLY_QWEN_MAX_TOKENS_CONSULT: "16384",
  });
  assert.deepEqual(c.models.qwen.maxTokens, { review: 32768, consult: 16384 });
});

test("config: server-wide max token env vars apply to every configured model", () => {
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "glm-key",
    MULTIPOLY_QWEN_API_KEY: "qwen-key",
    MULTIPOLY_QWEN_BASE_URL: "https://qwen.example/v1",
    MULTIPOLY_MAX_TOKENS_REVIEW: "4096",
    MULTIPOLY_MAX_TOKENS_CONSULT: "2048",
  });
  assert.deepEqual(c.models.glm.maxTokens, { review: 4096, consult: 2048 });
  assert.deepEqual(c.models.qwen.maxTokens, { review: 4096, consult: 2048 });
});

test("config: model-specific env vars override legacy GLM env vars", () => {
  const c = loadConfig({
    GLM_API_KEY: "legacy",
    MULTIPOLY_GLM_API_KEY: "specific",
  });
  assert.equal(c.models.glm.apiKey, "specific");
});

test("config: MULTIPOLY_MODELS registers an env-defined custom model", () => {
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "kimi",
    MULTIPOLY_KIMI_API_KEY: "k",
    MULTIPOLY_KIMI_BASE_URL: "https://kimi.example/v1",
    MULTIPOLY_KIMI_MODEL: "kimi-k2",
    MULTIPOLY_KIMI_DISPLAY_NAME: "Kimi K2",
    MULTIPOLY_KIMI_THINKING: "1",
  });
  assert.ok(c.modelKeys.includes("kimi"));
  assert.equal(c.models.kimi.configured, true);
  assert.equal(c.models.kimi.model, "kimi-k2");
  assert.equal(c.models.kimi.baseUrl, "https://kimi.example/v1");
  assert.equal(c.models.kimi.displayName, "Kimi K2");
  assert.equal(c.models.kimi.supportsThinking, true);
  // Builtins are still present alongside customs.
  assert.ok(c.modelKeys.includes("glm"));
});

test("config: a custom model missing its base URL is unconfigured, not fatal", () => {
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "kimi",
    MULTIPOLY_KIMI_API_KEY: "k",
    MULTIPOLY_KIMI_MODEL: "kimi-k2",
  });
  assert.equal(c.models.kimi.configured, false);
  assert.equal(c.models.glm.configured, true);
});

test("config: MULTIPOLY_MODELS rejects builtin collisions, reserved words, and bad names", () => {
  for (const bad of ["glm", "council", "harness", "none", "caller", "Bad-Name", "1kimi", "constructor", "prototype"]) {
    assert.throws(
      () => loadConfig({ MULTIPOLY_GLM_API_KEY: "g", MULTIPOLY_MODELS: bad }),
      (e) => e.code === "CONFIG",
      `expected ${bad} rejected`,
    );
  }
});

test("config: a custom model can be the synthesizer via env and per-call", () => {
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "kimi",
    MULTIPOLY_KIMI_API_KEY: "k",
    MULTIPOLY_KIMI_BASE_URL: "https://kimi.example/v1",
    MULTIPOLY_KIMI_MODEL: "kimi-k2",
    MULTIPOLY_SYNTHESIZER: "kimi",
  });
  assert.equal(c.synthesizer, "kimi");
});

test("config: MULTIPOLY_SYNTHESIZER parsed and normalized", () => {
  // Unset means "no preferred synthesizer" → council defers to the harness.
  assert.equal(loadConfig({ ...base }).synthesizer, undefined);
  assert.equal(loadConfig({ ...base, MULTIPOLY_SYNTHESIZER: "qwen" }).synthesizer, "qwen");
  // "harness"/"none"/"caller" all normalize to the defer sentinel.
  assert.equal(loadConfig({ ...base, MULTIPOLY_SYNTHESIZER: "HARNESS" }).synthesizer, "harness");
  assert.equal(loadConfig({ ...base, MULTIPOLY_SYNTHESIZER: "none" }).synthesizer, "harness");
  assert.equal(loadConfig({ ...base, MULTIPOLY_SYNTHESIZER: "caller" }).synthesizer, "harness");
  // An unknown model name is a config error.
  assert.throws(
    () => loadConfig({ ...base, MULTIPOLY_SYNTHESIZER: "gpt9" }),
    (e) => e.code === "CONFIG",
  );
});

test("config: malformed legacy GLM_ENDPOINT does not block a non-GLM startup", () => {
  // A stray legacy GLM_ENDPOINT in the environment must not prevent a
  // qwen-only deployment from starting: GLM isn't keyed, so its endpoint
  // is irrelevant.
  const c = loadConfig({
    MULTIPOLY_QWEN_API_KEY: "qwen-key",
    MULTIPOLY_QWEN_BASE_URL: "https://qwen.example/v1",
    GLM_ENDPOINT: "garbage-typo",
  });
  assert.equal(c.models.qwen.configured, true);
  assert.equal(c.models.glm.configured, false);
});

test("config: malformed GLM_ENDPOINT still throws when GLM is keyed", () => {
  // When GLM IS being configured (has a key), a bad endpoint is a real
  // misconfiguration and must surface.
  assert.throws(
    () => loadConfig({ GLM_API_KEY: "k", GLM_ENDPOINT: "garbage-typo" }),
    (e) => e.code === "CONFIG",
  );
});

test("config: missing qwen config does not prevent GLM-only startup", () => {
  const c = loadConfig({ MULTIPOLY_GLM_API_KEY: "glm-key" });
  assert.equal(c.models.glm.configured, true);
  assert.equal(c.models.qwen.configured, false);
  assert.equal(c.models.qwen.missing.length > 0, true);
});

// ── Task 3: baked MODEL_INFO entries for claude/codex/gemini/kimi ──

test("claude/codex/gemini/kimi are baked MODEL_INFO entries with capability + base name", () => {
  for (const k of ["claude", "codex", "gemini", "kimi"]) {
    assert.ok(MODEL_INFO[k], `${k} should be in MODEL_INFO`);
    assert.ok(MODEL_INFO[k].reasoning, `${k} should declare a reasoning capability`);
    assert.ok(MODEL_INFO[k].baseName, `${k} should declare a display base name`);
  }
});

test("OPUS_INFO is no longer exported (folded into claude)", async () => {
  const mod = await import("../scripts/lib/models.mjs");
  assert.equal(mod.OPUS_INFO, undefined);
});

test("baked builtins are NOT auto-registered (MODEL_KEYS unchanged)", async () => {
  const { MODEL_KEYS: keys } = await import("../scripts/lib/models.mjs");
  assert.deepEqual([...keys], ["glm", "qwen", "deepseek", "composer"]);
});
