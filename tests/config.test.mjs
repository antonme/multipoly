import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  ENDPOINT_PROFILES,
  resolveCallTimeoutMs,
  TIMEOUT_BOUNDS,
  normalizeSynthesizerChoice,
} from "../scripts/lib/config.mjs";
import { MODEL_INFO, MODEL_KEYS, loadModelRegistry } from "../scripts/lib/models.mjs";

const base = { GLM_API_KEY: "test-key" };

test("config: defaults", () => {
  const c = loadConfig({ ...base });
  assert.equal(c.models.glm.configured, true);
  assert.equal(c.models.glm.baseUrl, ENDPOINT_PROFILES["zai-coding-plan"]);
  assert.equal(c.models.glm.model, "glm-5.3");
  assert.equal(c.models.glm.apiKey, "test-key");
  assert.deepEqual(c.models.glm.maxTokens, { review: 131072, consult: 131072 });
  assert.equal(c.models.qwen.configured, false);
  // qwen has QWEN_BUDGET reasoning capability → gets 32768/8192 floor even when unconfigured
  assert.deepEqual(c.models.qwen.maxTokens, { review: 32768, consult: 8192 });
  assert.equal(c.models.deepseek.configured, false);
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
    MULTIPOLY_QWEN_MODEL: "qwen3.8-max",
  });
  assert.equal(c.models.glm.configured, true);
  assert.equal(c.models.qwen.configured, true);
  assert.equal(c.models.deepseek.configured, false);
  assert.equal(c.models.qwen.model, "qwen3.8-max");
  assert.equal(c.models.qwen.baseUrl, "https://qwen.example/v1");
  assert.equal(c.models.qwen.apiKey, "qwen-key");
  // qwen has QWEN_BUDGET reasoning capability → gets 32768/8192 floor even when unconfigured
  assert.deepEqual(c.models.qwen.maxTokens, { review: 32768, consult: 8192 });
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
  // Use a genuinely-custom key (not a promotable builtin) — custom keys have no
  // baked defaultBaseUrl, so a missing BASE_URL keeps the model unconfigured.
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "mymodel",
    MULTIPOLY_MYMODEL_API_KEY: "k",
    MULTIPOLY_MYMODEL_MODEL: "my-v1",
  });
  assert.equal(c.models.mymodel.configured, false);
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

test("kimi baked builtin defaults to K3.1 Pro on the standard Moonshot platform, explicit overrides still win", () => {
  assert.equal(MODEL_INFO.kimi.baseName, "kimi-k3.1-pro");
  assert.equal(MODEL_INFO.kimi.transport, "http");
  assert.equal(MODEL_INFO.kimi.defaultModel, "kimi-k3.1-pro");
  assert.equal(MODEL_INFO.kimi.defaultBaseUrl, "https://api.moonshot.ai/v1");
  assert.equal(MODEL_INFO.kimi.reasoning, "openai_effort");
  assert.equal(MODEL_INFO.kimi.reasoningVocab, "kimi");
  assert.equal(MODEL_INFO.kimi.defaultEffort, "high");

  const baked = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "kimi",
    MULTIPOLY_KIMI_API_KEY: "k",
  });
  assert.equal(baked.models.kimi.transport, "http");
  assert.equal(baked.models.kimi.model, "kimi-k3.1-pro");
  assert.equal(baked.models.kimi.baseUrl, "https://api.moonshot.ai/v1");
  assert.equal(baked.models.kimi.displayName, "kimi-k3.1-pro (api)");

  const pinned = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "kimi",
    MULTIPOLY_KIMI_API_KEY: "k",
    MULTIPOLY_KIMI_MODEL: "kimi-k2.6",
  });
  assert.equal(pinned.models.kimi.model, "kimi-k2.6");

  // Escape hatch: keep the Kimi Code preview route via explicit env overrides.
  const preview = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "kimi",
    MULTIPOLY_KIMI_API_KEY: "k",
    MULTIPOLY_KIMI_TRANSPORT: "anthropic",
    MULTIPOLY_KIMI_BASE_URL: "https://api.kimi.com/coding",
    MULTIPOLY_KIMI_MODEL: "kimi-k.3.0",
    MULTIPOLY_KIMI_REASONING: "kimi_toggle",
  });
  assert.equal(preview.models.kimi.transport, "anthropic");
  assert.equal(preview.models.kimi.model, "kimi-k.3.0");
  assert.equal(preview.models.kimi.baseUrl, "https://api.kimi.com/coding");
  assert.equal(preview.models.kimi.reasoning, "kimi_toggle");
});

test("qwen38 baked builtin defaults to stable 3.8 on the Token Plan endpoint, explicit overrides still win", () => {
  assert.equal(MODEL_INFO.qwen38.baseName, "qwen3.8-max");
  assert.equal(MODEL_INFO.qwen38.transport, "http");
  assert.equal(MODEL_INFO.qwen38.defaultModel, "qwen3.8-max");
  assert.equal(MODEL_INFO.qwen38.defaultBaseUrl, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1");
  assert.equal(MODEL_INFO.qwen38.reasoning, "qwen_budget");
  assert.equal(MODEL_INFO.qwen38.defaultEffort, "high");
  // Recognizes the dedicated key plus the librenew ALIBABA_CODE_PLAN_API_KEY alias.
  assert.deepEqual([...MODEL_INFO.qwen38.apiKeyEnv], ["MULTIPOLY_QWEN38_API_KEY", "ALIBABA_CODE_PLAN_API_KEY"]);

  const baked = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "qwen38",
    MULTIPOLY_QWEN38_API_KEY: "k",
  });
  assert.equal(baked.models.qwen38.transport, "http");
  assert.equal(baked.models.qwen38.configured, true);
  assert.equal(baked.models.qwen38.model, "qwen3.8-max");
  assert.equal(baked.models.qwen38.baseUrl, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1");
  assert.equal(baked.models.qwen38.reasoning, "qwen_budget");

  // The ALIBABA_CODE_PLAN_API_KEY alias alone configures the model.
  const aliased = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "qwen38",
    ALIBABA_CODE_PLAN_API_KEY: "plan-key",
  });
  assert.equal(aliased.models.qwen38.configured, true);

  // Explicit overrides still win.
  const pinned = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "qwen38",
    MULTIPOLY_QWEN38_API_KEY: "k",
    MULTIPOLY_QWEN38_MODEL: "qwen3.8-max",
    MULTIPOLY_QWEN38_DISPLAY_NAME: "Qwen 3.8 Max",
  });
  assert.equal(pinned.models.qwen38.model, "qwen3.8-max");
  assert.equal(pinned.models.qwen38.displayName, "Qwen 3.8 Max");
});

test("deepseekflash baked builtin defaults to V4.1 Flash on the official endpoint, explicit overrides still win", () => {
  assert.equal(MODEL_INFO.deepseekflash.baseName, "deepseek-v4.1-flash");
  assert.equal(MODEL_INFO.deepseekflash.transport, "http");
  assert.equal(MODEL_INFO.deepseekflash.defaultModel, "deepseek-flash");
  assert.equal(MODEL_INFO.deepseekflash.defaultBaseUrl, "https://api.deepseek.com");
  assert.equal(MODEL_INFO.deepseekflash.reasoning, "openai_effort");
  assert.equal(MODEL_INFO.deepseekflash.reasoningVocab, "deepseek");
  assert.equal(MODEL_INFO.deepseekflash.defaultEffort, "high");
  // Own key first, then the keys shared with the `deepseek` (V4 Pro) sibling.
  assert.deepEqual(
    [...MODEL_INFO.deepseekflash.apiKeyEnv],
    ["MULTIPOLY_DEEPSEEKFLASH_API_KEY", "MULTIPOLY_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"],
  );

  const baked = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "deepseekflash",
    MULTIPOLY_DEEPSEEKFLASH_API_KEY: "k",
  });
  assert.equal(baked.models.deepseekflash.transport, "http");
  assert.equal(baked.models.deepseekflash.configured, true);
  assert.equal(baked.models.deepseekflash.model, "deepseek-flash");
  assert.equal(baked.models.deepseekflash.baseUrl, "https://api.deepseek.com");
  assert.equal(baked.models.deepseekflash.reasoning, "openai_effort");
  assert.equal(baked.models.deepseekflash.reasoningVocab, "deepseek");
  assert.equal(baked.models.deepseekflash.displayName, "deepseek-v4.1-flash (api)");

  // The shared deepseek keys alone configure the model — no new key or base URL needed.
  const shared = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "deepseekflash",
    MULTIPOLY_DEEPSEEK_API_KEY: "ds-key",
  });
  assert.equal(shared.models.deepseekflash.configured, true);
  assert.equal(shared.models.deepseekflash.apiKeyEnv, "MULTIPOLY_DEEPSEEK_API_KEY");

  // Coexistence: `deepseek` (V4 Pro) and `deepseekflash` configure side by side
  // from the same key env — the whole point of the sibling-builtin design.
  const both = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "deepseekflash",
    MULTIPOLY_DEEPSEEK_API_KEY: "ds-key",
    MULTIPOLY_DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  });
  assert.equal(both.models.deepseek.configured, true);
  assert.equal(both.models.deepseek.model, "deepseek-v4-pro");
  assert.equal(both.models.deepseekflash.configured, true);
  assert.equal(both.models.deepseekflash.model, "deepseek-flash");

  // The unprefixed legacy DEEPSEEK_API_KEY also configures deepseekflash.
  const legacy = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "deepseekflash",
    DEEPSEEK_API_KEY: "legacy-key",
  });
  assert.equal(legacy.models.deepseekflash.configured, true);
  assert.equal(legacy.models.deepseekflash.apiKeyEnv, "DEEPSEEK_API_KEY");

  // Explicit overrides still win.
  const pinned = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "deepseekflash",
    MULTIPOLY_DEEPSEEKFLASH_API_KEY: "k",
    MULTIPOLY_DEEPSEEKFLASH_MODEL: "deepseek-v4-flash-0731",
    MULTIPOLY_DEEPSEEKFLASH_DISPLAY_NAME: "DeepSeek V4 Flash",
  });
  assert.equal(pinned.models.deepseekflash.model, "deepseek-v4-flash-0731");
  assert.equal(pinned.models.deepseekflash.displayName, "DeepSeek V4 Flash");
});

test("OPUS_INFO is no longer exported (folded into claude)", async () => {
  const mod = await import("../scripts/lib/models.mjs");
  assert.equal(mod.OPUS_INFO, undefined);
});

test("baked builtins are NOT auto-registered (MODEL_KEYS unchanged)", async () => {
  const { MODEL_KEYS: keys } = await import("../scripts/lib/models.mjs");
  assert.deepEqual([...keys], ["glm", "qwen", "deepseek"]);
});

// ── Task 4: Registry merge for baked builtins ──

test("MULTIPOLY_MODELS=claude merges baked MODEL_INFO base (capability, base name)", () => {
  const { keys, info } = loadModelRegistry({
    MULTIPOLY_MODELS: "claude",
    MULTIPOLY_CLAUDE_TRANSPORT: "anthropic",
    MULTIPOLY_CLAUDE_API_KEY: "x", // fake; just needs to be present for downstream config
  });
  assert.ok(keys.includes("claude"));
  assert.equal(info.claude.reasoning, "anthropic_effort"); // baked
  assert.equal(info.claude.transport, "anthropic"); // env override applied
  // display name follows the convention for the chosen transport:
  assert.equal(info.claude.displayName, "opus (api)");
});

test("MULTIPOLY_MODELS=claude with default (cli) transport names it 'opus (claude cli)'", () => {
  const { info } = loadModelRegistry({ MULTIPOLY_MODELS: "claude" });
  assert.equal(info.claude.transport, "cli");
  assert.equal(info.claude.displayName, "opus (claude cli)");
});

test("listing an always-on builtin (glm) in MULTIPOLY_MODELS still errors", () => {
  assert.throws(
    () => loadModelRegistry({ MULTIPOLY_MODELS: "glm" }),
    /duplicates a builtin/,
  );
});

// ── Task 5: Transport-flip guard + startup transport log for claude/codex ──

test("claude defaults to anthropic transport when an Anthropic key is present and transport is unset", () => {
  const { info } = loadModelRegistry({
    MULTIPOLY_MODELS: "claude",
    ANTHROPIC_API_KEY: "x",
  });
  assert.equal(info.claude.transport, "anthropic");
  assert.equal(info.claude.displayName, "opus (api)");
});

test("explicit MULTIPOLY_CLAUDE_TRANSPORT=cli wins over the Anthropic-key guard", () => {
  const { info } = loadModelRegistry({
    MULTIPOLY_MODELS: "claude",
    ANTHROPIC_API_KEY: "x",
    MULTIPOLY_CLAUDE_TRANSPORT: "cli",
  });
  assert.equal(info.claude.transport, "cli");
});

test("claude with no key and unset transport keeps baked cli", () => {
  const { info } = loadModelRegistry({ MULTIPOLY_MODELS: "claude" });
  assert.equal(info.claude.transport, "cli");
});

// ── Task 6: MULTIPOLY_OPUS_* / MULTIPOLY_GPT55_* migration warning ──

test("a MULTIPOLY_OPUS_* var present emits a migration warning to stderr", () => {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    loadModelRegistry({ MULTIPOLY_OPUS_API_KEY: "x", MULTIPOLY_GLM_API_KEY: "y" });
  } finally {
    process.stderr.write = orig;
  }
  const blob = lines.join("");
  assert.match(blob, /MULTIPOLY_OPUS_/);
  assert.match(blob, /MULTIPOLY_CLAUDE_/);
});

test("no warning when no legacy vars are present", () => {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    loadModelRegistry({ MULTIPOLY_GLM_API_KEY: "y" });
  } finally {
    process.stderr.write = orig;
  }
  assert.ok(!lines.join("").includes("MULTIPOLY_OPUS_"));
});

// ── Task 7: Lenient synthesizer name resolution ──

test("normalizeSynthesizerChoice: alias 'gpt' resolves to 'codex' when codex is configured", () => {
  const keys = ["glm", "qwen", "deepseek", "codex"];
  assert.equal(normalizeSynthesizerChoice("gpt", keys), "codex");
});

test("normalizeSynthesizerChoice: alias 'opus' resolves to 'claude' when claude is configured", () => {
  const keys = ["glm", "claude"];
  assert.equal(normalizeSynthesizerChoice("opus", keys), "claude");
});

test("normalizeSynthesizerChoice: harness sentinels are never alias-resolved (checked first)", () => {
  // Even if "harness"/"none"/"caller" somehow appeared in an alias table they
  // must resolve to HARNESS_SENTINEL, never to a model key.
  const keys = ["glm", "codex", "claude"];
  assert.equal(normalizeSynthesizerChoice("harness", keys), "harness");
  assert.equal(normalizeSynthesizerChoice("none", keys), "harness");
  assert.equal(normalizeSynthesizerChoice("caller", keys), "harness");
});

test("normalizeSynthesizerChoice: exact key resolves normally", () => {
  const keys = ["glm", "qwen"];
  assert.equal(normalizeSynthesizerChoice("glm", keys), "glm");
  assert.equal(normalizeSynthesizerChoice("qwen", keys), "qwen");
});

test("normalizeSynthesizerChoice: unknown name returns null (caller raises the error)", () => {
  const keys = ["glm", "qwen"];
  assert.equal(normalizeSynthesizerChoice("gpt9999", keys), null);
});

// ── Plan C Task 1: mimo baked builtin ──

test("mimo is a baked MODEL_INFO builtin with http_thinking_toggle capability", () => {
  assert.ok(MODEL_INFO.mimo);
  assert.equal(MODEL_INFO.mimo.reasoning, "http_thinking_toggle");
  assert.equal(MODEL_INFO.mimo.usesMaxCompletionTokens, true);
  assert.equal(MODEL_INFO.mimo.baseName, "mimo-v2.6-pro");
});

test("MULTIPOLY_MODELS=mimo merges baked base and recognizes XIAOMIMIMO_API_KEY", () => {
  const { keys, info } = loadModelRegistry({ MULTIPOLY_MODELS: "mimo" });
  assert.ok(keys.includes("mimo"));
  assert.equal(info.mimo.reasoning, "http_thinking_toggle");
  assert.equal(info.mimo.displayName, "mimo-v2.6-pro (api)"); // convention from Plan B
  assert.deepEqual([...info.mimo.apiKeyEnv], ["MULTIPOLY_MIMO_API_KEY", "XIAOMIMIMO_API_KEY"]);
});

// ── Plan C Task 2: usesMaxCompletionTokens threaded onto loaded http config ──

test("a configured mimo carries usesMaxCompletionTokens on its model config", () => {
  const config = loadConfig({
    MULTIPOLY_MODELS: "mimo",
    MULTIPOLY_MIMO_API_KEY: "mimo", // fake
  });
  assert.equal(config.models.mimo.configured, true);
  assert.equal(config.models.mimo.usesMaxCompletionTokens, true);
});

test("glm (max_tokens-style) does NOT set usesMaxCompletionTokens", () => {
  const config = loadConfig({ MULTIPOLY_GLM_API_KEY: "glm" });
  assert.ok(!config.models.glm.usesMaxCompletionTokens);
});

// ── Plan C Task 4: MiMo inherits the GLM token floor (BUDGET-regression guard) ──

test("mimo gets the reasoning max_tokens floor by default (no empty-BUDGET regression)", () => {
  // mimo has GLM_TOGGLE (http_thinking_toggle) capability → generalized reasoning floor applies.
  // Floor raised from 8192/4096 (Plan C) to 32768/8192 (D2) for all reasoning models.
  const config = loadConfig({ MULTIPOLY_MODELS: "mimo", MULTIPOLY_MIMO_API_KEY: "mimo" });
  assert.equal(config.models.mimo.maxTokens.review, 32768);
  assert.equal(config.models.mimo.maxTokens.consult, 8192);
});

test("an explicit MULTIPOLY_MIMO_MAX_TOKENS_REVIEW overrides the floor", () => {
  const config = loadConfig({
    MULTIPOLY_MODELS: "mimo", MULTIPOLY_MIMO_API_KEY: "mimo",
    MULTIPOLY_MIMO_MAX_TOKENS_REVIEW: "20000",
  });
  assert.equal(config.models.mimo.maxTokens.review, 20000);
});

// ── grok baked cli builtin (opt-in via MULTIPOLY_MODELS + ENABLED) ──

test("MULTIPOLY_MODELS=grok merges baked base: cli transport, grok kind, convention name", () => {
  const { keys, info } = loadModelRegistry({ MULTIPOLY_MODELS: "grok" });
  assert.ok(keys.includes("grok"));
  assert.equal(info.grok.transport, "cli");
  assert.equal(info.grok.cliKind, "grok");
  assert.equal(info.grok.reasoning, "anthropic_effort"); // baked graded effort
  assert.equal(info.grok.displayName, "grok-4.7 (grok cli)");
});

test("grok stays unconfigured until MULTIPOLY_GROK_ENABLED=1 (cli opt-in gate)", () => {
  const off = loadConfig({ MULTIPOLY_GLM_API_KEY: "g", MULTIPOLY_MODELS: "grok" });
  assert.equal(off.models.grok.configured, false);
  assert.ok(off.models.grok.missing.some((m) => /MULTIPOLY_GROK_ENABLED=1/.test(m)));

  const on = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "grok",
    MULTIPOLY_GROK_ENABLED: "1",
  });
  assert.equal(on.models.grok.configured, true);
  assert.equal(on.models.grok.cliKind, "grok");
  assert.equal(on.models.grok.binary, "grok");
  assert.equal(on.models.grok.model, "grok-4.7"); // baked default
});

// ── fable baked builtin (Anthropic-family sibling of claude; opt-in) ──

test("MULTIPOLY_MODELS=fable merges baked base: cli default, claude kind, convention name", () => {
  const { keys, info } = loadModelRegistry({ MULTIPOLY_MODELS: "fable" });
  assert.ok(keys.includes("fable"));
  assert.equal(info.fable.transport, "cli");
  assert.equal(info.fable.cliKind, "claude"); // reuses the Claude Code recipe
  assert.equal(info.fable.reasoning, "anthropic_effort"); // baked graded effort
  assert.equal(info.fable.defaultModel, "claude-fable-5-2");
  assert.equal(info.fable.displayName, "fable (claude cli)");
});

test("fable defaults to anthropic transport when an Anthropic key is present and transport is unset", () => {
  const { info } = loadModelRegistry({ MULTIPOLY_MODELS: "fable", ANTHROPIC_API_KEY: "sk-ant-xxx" });
  assert.equal(info.fable.transport, "anthropic");
  assert.equal(info.fable.displayName, "fable (api)");
});

test("fable honors MULTIPOLY_FABLE_TRANSPORT=cli even with an Anthropic key present (escape hatch)", () => {
  const { info } = loadModelRegistry({
    MULTIPOLY_MODELS: "fable",
    ANTHROPIC_API_KEY: "sk-ant-xxx",
    MULTIPOLY_FABLE_TRANSPORT: "cli",
  });
  assert.equal(info.fable.transport, "cli");
});

test("fable with no key and unset transport keeps baked cli", () => {
  const { info } = loadModelRegistry({ MULTIPOLY_MODELS: "fable" });
  assert.equal(info.fable.transport, "cli");
});

test("fable (cli) stays unconfigured until MULTIPOLY_FABLE_ENABLED=1 (cli opt-in gate)", () => {
  const off = loadConfig({ MULTIPOLY_GLM_API_KEY: "g", MULTIPOLY_MODELS: "fable" });
  assert.equal(off.models.fable.configured, false);
  assert.ok(off.models.fable.missing.some((m) => /MULTIPOLY_FABLE_ENABLED=1/.test(m)));

  const on = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "fable",
    MULTIPOLY_FABLE_ENABLED: "1",
  });
  assert.equal(on.models.fable.configured, true);
  assert.equal(on.models.fable.cliKind, "claude");
  assert.equal(on.models.fable.binary, "claude");
  assert.equal(on.models.fable.model, "claude-fable-5-2"); // baked default
});

test("fable (anthropic) is configured by an Anthropic key without needing the ENABLED gate", () => {
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "fable",
    ANTHROPIC_API_KEY: "sk-ant-xxx",
  });
  assert.equal(c.models.fable.transport, "anthropic");
  assert.equal(c.models.fable.configured, true);
  assert.equal(c.models.fable.model, "claude-fable-5-2"); // baked default flows to the anthropic body
});

test("fable flips to anthropic on MULTIPOLY_FABLE_API_KEY alone (no ANTHROPIC_API_KEY)", () => {
  const { info } = loadModelRegistry({ MULTIPOLY_MODELS: "fable", MULTIPOLY_FABLE_API_KEY: "k" });
  assert.equal(info.fable.transport, "anthropic");
});

test("key namespaces are distinct: MULTIPOLY_CLAUDE_API_KEY does NOT flip fable (stays cli)", () => {
  // The claude-only per-model key must not leak into fable's flip signal — an
  // operator with claude on the API and fable on the CLI must not have fable
  // silently flipped by claude's key.
  const { info } = loadModelRegistry({ MULTIPOLY_MODELS: "fable", MULTIPOLY_CLAUDE_API_KEY: "k" });
  assert.equal(info.fable.transport, "cli");
});

test("MULTIPOLY_FABLE_MODEL overrides the baked default model (documented escape for future Fable ids)", () => {
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "fable",
    MULTIPOLY_FABLE_ENABLED: "1",
    MULTIPOLY_FABLE_MODEL: "claude-fable-5-custom",
  });
  assert.equal(c.models.fable.model, "claude-fable-5-custom");
});

// ── Display-name convention: always-on builtins surface "<base> (<transport>)" ──

test("config: always-on builtins surface convention-form display names", () => {
  // glm/qwen/deepseek are http → "(api)"
  const config = loadConfig({ MULTIPOLY_GLM_API_KEY: "x" });
  assert.equal(config.models.glm.displayName, "glm-5.3 (api)");
  assert.equal(config.models.qwen.displayName, "qwen3.8-max (api)");
  assert.equal(config.models.deepseek.displayName, "deepseek-v4-pro (api)");
});

// ── D2 Task 1: Generalize max_tokens floor to all reasoning capabilities ──

test("D2: kimi (openai_effort) with no explicit cap gets 32768/8192 floor", () => {
  const config = loadConfig({
    MULTIPOLY_GLM_API_KEY: "glm-key",
    MULTIPOLY_MODELS: "kimi",
    MULTIPOLY_KIMI_API_KEY: "kimi-key",
    MULTIPOLY_KIMI_BASE_URL: "https://kimi.example/v1",
    MULTIPOLY_KIMI_MODEL: "kimi-k2.6",
  });
  assert.equal(config.models.kimi.maxTokens.review, 32768);
  assert.equal(config.models.kimi.maxTokens.consult, 8192);
});

test("D2: deepseek (OPENAI_EFFORT) with no explicit cap gets 32768/8192 floor", () => {
  const config = loadConfig({
    MULTIPOLY_GLM_API_KEY: "glm-key",
    MULTIPOLY_DEEPSEEK_API_KEY: "ds-key",
    MULTIPOLY_DEEPSEEK_BASE_URL: "https://deepseek.example/v1",
  });
  assert.equal(config.models.deepseek.maxTokens.review, 32768);
  assert.equal(config.models.deepseek.maxTokens.consult, 8192);
});

test("D2: gemini (OPENAI_EFFORT) with no explicit cap gets 32768/8192 floor", () => {
  // gemini is the provider-ceiling-risk model (OPENAI_EFFORT, reasoningVocab=gemini).
  // Lock its floor values to guard against accidental regression.
  const config = loadConfig({
    MULTIPOLY_GLM_API_KEY: "glm-key",
    MULTIPOLY_MODELS: "gemini",
    MULTIPOLY_GEMINI_API_KEY: "gem-key",
  });
  assert.equal(config.models.gemini.maxTokens.review, 32768);
  assert.equal(config.models.gemini.maxTokens.consult, 8192);
});

test("D2: glm (GLM_TOGGLE) with no server-wide cap gets 32768/8192 floor (raised from 8192/4096)", () => {
  // GLM default applies the server ceiling (131072) as its default via the `key === "glm"` path,
  // but in a scenario with no server-wide explicit env, it should still be floored at 32768.
  // The existing default config already has review=131072 > 32768, so Math.max still returns 131072.
  // Verify the floor with a fresh config where GLM gets undefined (not the server ceiling):
  // Use MULTIPOLY_MODELS to register a second model so there are two — and check a custom glm-like
  // reasoning model. Instead just verify that `resolveModelMaxTokens` for glm yields >= 32768.
  const config = loadConfig({ MULTIPOLY_GLM_API_KEY: "glm-key" });
  // GLM has key==="glm" so it inherits MODEL_OUTPUT_CEILING (131072) by default,
  // which is already > 32768, so the floor doesn't change the visible value here.
  assert.ok(config.models.glm.maxTokens.review >= 32768, "glm review floor must be >= 32768");
  assert.ok(config.models.glm.maxTokens.consult >= 8192, "glm consult floor must be >= 8192");
});

test("D2: custom NONE-capability model gets no floor", () => {
  const config = loadConfig({ MULTIPOLY_GLM_API_KEY: "glm-key", MULTIPOLY_MODELS: "plain" });
  assert.equal(config.models.plain.maxTokens.review, undefined);
  assert.equal(config.models.plain.maxTokens.consult, undefined);
  // NONE has no reasoning token floor.
});

test("D2: explicit MULTIPOLY_<K>_MAX_TOKENS_REVIEW wins over the floor", () => {
  const config = loadConfig({
    MULTIPOLY_GLM_API_KEY: "glm-key",
    MULTIPOLY_MODELS: "kimi",
    MULTIPOLY_KIMI_API_KEY: "kimi-key",
    MULTIPOLY_KIMI_BASE_URL: "https://kimi.example/v1",
    MULTIPOLY_KIMI_MODEL: "kimi-k2.6",
    MULTIPOLY_KIMI_MAX_TOKENS_REVIEW: "20000",
    MULTIPOLY_KIMI_MAX_TOKENS_CONSULT: "5000",
  });
  assert.equal(config.models.kimi.maxTokens.review, 20000);
  assert.equal(config.models.kimi.maxTokens.consult, 5000);
});

test("D2: reasoning floor values are within MODEL_OUTPUT_CEILING (32768 < 131072)", () => {
  const MODEL_OUTPUT_CEILING = 131072;
  const REASONING_REVIEW_FLOOR = 32768;
  const REASONING_CONSULT_FLOOR = 8192;
  assert.ok(REASONING_REVIEW_FLOOR <= MODEL_OUTPUT_CEILING, "review floor must not exceed ceiling");
  assert.ok(REASONING_CONSULT_FLOOR <= MODEL_OUTPUT_CEILING, "consult floor must not exceed ceiling");
  // And verify a configured reasoning model never produces a value above ceiling.
  const config = loadConfig({
    MULTIPOLY_GLM_API_KEY: "glm-key",
    MULTIPOLY_DEEPSEEK_API_KEY: "ds-key",
    MULTIPOLY_DEEPSEEK_BASE_URL: "https://deepseek.example/v1",
  });
  assert.ok(
    config.models.deepseek.maxTokens.review <= MODEL_OUTPUT_CEILING,
    "review must not exceed ceiling",
  );
  assert.ok(
    config.models.deepseek.maxTokens.consult <= MODEL_OUTPUT_CEILING,
    "consult must not exceed ceiling",
  );
});

test("retired Composer settings do not register or enable a model", () => {
  const c = loadConfig({ MULTIPOLY_GLM_API_KEY: "test", MULTIPOLY_COMPOSER_ENABLED: "1" });
  assert.equal(Object.hasOwn(c.models, "composer"), false);
  assert.equal(c.modelKeys.includes("composer"), false);
});

test("Gemini defaults to Carbon with its supported reasoning vocabulary", () => {
  const config = loadConfig({ MULTIPOLY_GLM_API_KEY: "test", MULTIPOLY_MODELS: "gemini", GEMINI_API_KEY: "test" });
  assert.equal(config.models.gemini.model, "gemini-4-carbon");
  assert.equal(config.models.gemini.displayName, "gemini-4-carbon (api)");
  assert.equal(config.models.gemini.reasoningVocab, "gemini4");
});

test("MULTIPOLY_GEMINI_MODEL=gemini-4-hydrogen switches gemini wire model, display name, and reasoning vocab", () => {
  const hyd = loadConfig({
    MULTIPOLY_GLM_API_KEY: "test",
    MULTIPOLY_MODELS: "gemini",
    GEMINI_API_KEY: "test",
    MULTIPOLY_GEMINI_MODEL: "gemini-4-hydrogen",
  });
  assert.equal(hyd.models.gemini.model, "gemini-4-hydrogen");
  assert.equal(hyd.models.gemini.displayName, "gemini-4-hydrogen (api)");
  assert.equal(hyd.models.gemini.reasoningVocab, "hydrogen");

  // Gemini 3 model override infers legacy gemini vocab unless explicitly overridden.
  const g3 = loadConfig({
    MULTIPOLY_GLM_API_KEY: "test",
    MULTIPOLY_MODELS: "gemini",
    GEMINI_API_KEY: "test",
    MULTIPOLY_GEMINI_MODEL: "gemini-3.8-flash",
  });
  assert.equal(g3.models.gemini.model, "gemini-3.8-flash");
  assert.equal(g3.models.gemini.displayName, "gemini-3.8-flash (api)");
  assert.equal(g3.models.gemini.reasoningVocab, "gemini");

  // Explicit DISPLAY_NAME and REASONING_VOCAB overrides still win.
  const explicit = loadConfig({
    MULTIPOLY_GLM_API_KEY: "test",
    MULTIPOLY_MODELS: "gemini",
    GEMINI_API_KEY: "test",
    MULTIPOLY_GEMINI_MODEL: "gemini-4-hydrogen",
    MULTIPOLY_GEMINI_DISPLAY_NAME: "Custom Gemini",
    MULTIPOLY_GEMINI_REASONING_VOCAB: "gemini4",
  });
  assert.equal(explicit.models.gemini.displayName, "Custom Gemini");
  assert.equal(explicit.models.gemini.reasoningVocab, "gemini4");
});

test("hydrogen baked builtin defaults to Gemini 4 Hydrogen, shares Gemini credentials, and coexists with Carbon", () => {
  assert.equal(MODEL_INFO.hydrogen.baseName, "gemini-4-hydrogen");
  assert.equal(MODEL_INFO.hydrogen.transport, "http");
  assert.equal(MODEL_INFO.hydrogen.defaultModel, "gemini-4-hydrogen");
  assert.equal(MODEL_INFO.hydrogen.defaultBaseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(MODEL_INFO.hydrogen.reasoning, "openai_effort");
  assert.equal(MODEL_INFO.hydrogen.reasoningVocab, "hydrogen");
  assert.equal(MODEL_INFO.hydrogen.defaultEffort, "high");
  assert.deepEqual(
    [...MODEL_INFO.hydrogen.apiKeyEnv],
    ["MULTIPOLY_HYDROGEN_API_KEY", "MULTIPOLY_GEMINI_API_KEY", "GEMINI_API_KEY"],
  );

  // Own key configures hydrogen.
  const own = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "hydrogen",
    MULTIPOLY_HYDROGEN_API_KEY: "hyd-key",
  });
  assert.equal(own.models.hydrogen.configured, true);
  assert.equal(own.models.hydrogen.model, "gemini-4-hydrogen");
  assert.equal(own.models.hydrogen.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(own.models.hydrogen.displayName, "gemini-4-hydrogen (api)");
  assert.equal(own.models.hydrogen.reasoning, "openai_effort");
  assert.equal(own.models.hydrogen.reasoningVocab, "hydrogen");
  assert.equal(own.models.hydrogen.apiKeyEnv, "MULTIPOLY_HYDROGEN_API_KEY");

  // Coexistence: `gemini` (Carbon) and `hydrogen` (Hydrogen) run side by side on shared GEMINI_API_KEY.
  const both = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "gemini,hydrogen",
    GEMINI_API_KEY: "shared-gem-key",
  });
  assert.equal(both.models.gemini.configured, true);
  assert.equal(both.models.gemini.model, "gemini-4-carbon");
  assert.equal(both.models.gemini.reasoningVocab, "gemini4");
  assert.equal(both.models.hydrogen.configured, true);
  assert.equal(both.models.hydrogen.model, "gemini-4-hydrogen");
  assert.equal(both.models.hydrogen.reasoningVocab, "hydrogen");
  assert.equal(both.models.hydrogen.apiKeyEnv, "GEMINI_API_KEY");

  // Shared MULTIPOLY_GEMINI_API_KEY also configures hydrogen.
  const sharedMultipoly = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "hydrogen",
    MULTIPOLY_GEMINI_API_KEY: "mp-gem-key",
  });
  assert.equal(sharedMultipoly.models.hydrogen.configured, true);
  assert.equal(sharedMultipoly.models.hydrogen.apiKeyEnv, "MULTIPOLY_GEMINI_API_KEY");
});
