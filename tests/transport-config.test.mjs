import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../scripts/lib/config.mjs";
import { loadModelRegistry, CLI_KINDS, MODEL_INFO, modelCapability, modelHasReasoningControl, modelSupportsThinking } from "../scripts/lib/models.mjs";
import { CAPABILITY } from "../scripts/lib/reasoning.mjs";

const glm = { MULTIPOLY_GLM_API_KEY: "g" };

test("transport: http builtins carry transport 'http'", () => {
  const c = loadConfig({ ...glm });
  assert.equal(c.models.glm.transport, "http");
  assert.equal(c.models.qwen.transport, "http");
  assert.equal(c.models.deepseek.transport, "http");
});

test("transport: composer is a cli/cursor builtin, unconfigured by default", () => {
  const c = loadConfig({ ...glm });
  assert.equal(c.models.composer.transport, "cli");
  assert.equal(c.models.composer.cliKind, "cursor");
  assert.equal(c.models.composer.configured, false);
});

test("transport: composer becomes configured when MULTIPOLY_COMPOSER_ENABLED is set", () => {
  const c = loadConfig({ ...glm, MULTIPOLY_COMPOSER_ENABLED: "1" });
  assert.equal(c.models.composer.configured, true);
  assert.equal(c.models.composer.cliKind, "cursor");
  assert.equal(c.models.composer.binary, "cursor-agent");
  assert.equal(c.models.composer.cwdMode, "repo");
});

test("transport: a setting an API key alone does NOT configure the cli composer (migration)", () => {
  // The old HTTP composer never worked; setting only its API key must not
  // silently shell out to cursor-agent. Enabling is explicit now.
  const c = loadConfig({ ...glm, MULTIPOLY_COMPOSER_API_KEY: "x", MULTIPOLY_COMPOSER_BASE_URL: "https://x/v1" });
  assert.equal(c.models.composer.configured, false);
});


test("transport: custom model can declare anthropic transport", () => {
  const c = loadConfig({
    ...glm,
    MULTIPOLY_MODELS: "haiku",
    MULTIPOLY_HAIKU_TRANSPORT: "anthropic",
    MULTIPOLY_HAIKU_API_KEY: "k",
    MULTIPOLY_HAIKU_MODEL: "claude-haiku-4-5",
  });
  assert.equal(c.models.haiku.transport, "anthropic");
  assert.equal(c.models.haiku.configured, true);
  assert.equal(c.models.haiku.model, "claude-haiku-4-5");
  assert.equal(c.models.haiku.baseUrl, "https://api.anthropic.com");
});

test("transport: unconfigured anthropic model with bad base URL does not block other models", () => {
  const c = loadConfig({
    ...glm,
    MULTIPOLY_MODELS: "haiku",
    MULTIPOLY_HAIKU_TRANSPORT: "anthropic",
    MULTIPOLY_HAIKU_MODEL: "claude-haiku-4-5",
    MULTIPOLY_HAIKU_BASE_URL: "ftp://bad",
  });
  assert.equal(c.models.glm.configured, true);
  assert.equal(c.models.haiku.configured, false);
  assert.ok(c.models.haiku.missing.some((m) => /API_KEY/.test(m)));
  assert.equal(c.models.haiku.baseUrl, "ftp://bad");
});

test("transport: custom cli model with cliKind + auth token env + temp cwd", () => {
  const c = loadConfig({
    ...glm,
    MULTIPOLY_MODELS: "gem",
    MULTIPOLY_GEM_TRANSPORT: "cli",
    MULTIPOLY_GEM_CLI_KIND: "gemini",
    MULTIPOLY_GEM_ENABLED: "1",
    MULTIPOLY_GEM_MODEL: "gemini-3-pro",
    MULTIPOLY_GEM_AUTH_TOKEN_ENV: "GEMINI_API_KEY",
    MULTIPOLY_GEM_CWD: "temp",
  });
  assert.equal(c.models.gem.transport, "cli");
  assert.equal(c.models.gem.cliKind, "gemini");
  assert.equal(c.models.gem.binary, "gemini");
  assert.equal(c.models.gem.model, "gemini-3-pro");
  assert.equal(c.models.gem.authTokenEnv, "GEMINI_API_KEY");
  assert.equal(c.models.gem.cwdMode, "temp");
  assert.equal(c.models.gem.configured, true);
});

test("transport: custom cli binary override", () => {
  const c = loadConfig({
    ...glm,
    MULTIPOLY_MODELS: "k",
    MULTIPOLY_K_TRANSPORT: "cli",
    MULTIPOLY_K_CLI_KIND: "kimi",
    MULTIPOLY_K_ENABLED: "1",
    MULTIPOLY_K_CLI: "/home/user/.local/bin/kimi",
  });
  assert.equal(c.models.k.binary, "/home/user/.local/bin/kimi");
});

test("transport: agy requires explicit unsafe opt-in (weak sandbox)", () => {
  const enabledNoUnsafe = loadConfig({
    ...glm,
    MULTIPOLY_MODELS: "a",
    MULTIPOLY_A_TRANSPORT: "cli",
    MULTIPOLY_A_CLI_KIND: "agy",
    MULTIPOLY_A_ENABLED: "1",
  });
  assert.equal(enabledNoUnsafe.models.a.configured, false);
  assert.ok(enabledNoUnsafe.models.a.missing.some((m) => /UNSAFE/.test(m)));

  const withUnsafe = loadConfig({
    ...glm,
    MULTIPOLY_MODELS: "a",
    MULTIPOLY_A_TRANSPORT: "cli",
    MULTIPOLY_A_CLI_KIND: "agy",
    MULTIPOLY_A_ENABLED: "1",
    MULTIPOLY_A_UNSAFE: "1",
  });
  assert.equal(withUnsafe.models.a.configured, true);
  assert.equal(withUnsafe.models.a.unsafe, true);
});

test("transport: an enabled cli model that emits a model flag needs a model id", () => {
  // claude takes --model, so an enabled claude model without a model is
  // unconfigured (not silently spawning with `--model null`).
  const c = loadConfig({
    ...glm,
    MULTIPOLY_MODELS: "cc",
    MULTIPOLY_CC_TRANSPORT: "cli",
    MULTIPOLY_CC_CLI_KIND: "claude",
    MULTIPOLY_CC_ENABLED: "1",
  });
  assert.equal(c.models.cc.configured, false);
  assert.ok(c.models.cc.missing.some((m) => /MODEL/.test(m)));

  // agy has no model flag, so it does not require one.
  const a = loadConfig({
    ...glm,
    MULTIPOLY_MODELS: "aa",
    MULTIPOLY_AA_TRANSPORT: "cli",
    MULTIPOLY_AA_CLI_KIND: "agy",
    MULTIPOLY_AA_ENABLED: "1",
    MULTIPOLY_AA_UNSAFE: "1",
  });
  assert.equal(a.models.aa.configured, true);
});

test("transport: invalid transport value is a CONFIG error", () => {
  assert.throws(
    () =>
      loadConfig({
        ...glm,
        MULTIPOLY_MODELS: "x",
        MULTIPOLY_X_TRANSPORT: "carrier-pigeon",
        MULTIPOLY_X_API_KEY: "k",
      }),
    (e) => e.code === "CONFIG",
  );
});

test("transport: invalid cliKind is a CONFIG error", () => {
  assert.throws(
    () =>
      loadConfig({
        ...glm,
        MULTIPOLY_MODELS: "x",
        MULTIPOLY_X_TRANSPORT: "cli",
        MULTIPOLY_X_CLI_KIND: "emacs",
        MULTIPOLY_X_ENABLED: "1",
      }),
    (e) => e.code === "CONFIG",
  );
});

test("transport: cli transport without cliKind is a CONFIG error", () => {
  assert.throws(
    () =>
      loadConfig({
        ...glm,
        MULTIPOLY_MODELS: "x",
        MULTIPOLY_X_TRANSPORT: "cli",
        MULTIPOLY_X_ENABLED: "1",
      }),
    (e) => e.code === "CONFIG",
  );
});

test("transport: malformed authTokenEnv NAME is a CONFIG error", () => {
  assert.throws(
    () =>
      loadConfig({
        ...glm,
        MULTIPOLY_MODELS: "x",
        MULTIPOLY_X_TRANSPORT: "cli",
        MULTIPOLY_X_CLI_KIND: "claude",
        MULTIPOLY_X_ENABLED: "1",
        MULTIPOLY_X_AUTH_TOKEN_ENV: "not a valid name",
      }),
    (e) => e.code === "CONFIG",
  );
});

test("transport: invalid cwd mode is a CONFIG error", () => {
  assert.throws(
    () =>
      loadConfig({
        ...glm,
        MULTIPOLY_MODELS: "x",
        MULTIPOLY_X_TRANSPORT: "cli",
        MULTIPOLY_X_CLI_KIND: "claude",
        MULTIPOLY_X_ENABLED: "1",
        MULTIPOLY_X_CWD: "sideways",
      }),
    (e) => e.code === "CONFIG",
  );
});

test("transport: CLI_KINDS exposes the known agent kinds", () => {
  assert.deepEqual(
    Object.keys(CLI_KINDS).sort(),
    ["agy", "claude", "codex", "cursor", "gemini", "kimi"],
  );
  assert.equal(CLI_KINDS.agy.weakSandbox, true);
  assert.equal(CLI_KINDS.cursor.binary, "cursor-agent");
});


// --- Task 5: static capability + defaults on MODEL_INFO; modelHasReasoningControl ---

test("models: capability + default effort on builtins", () => {
  assert.equal(MODEL_INFO.glm.reasoning, CAPABILITY.GLM_TOGGLE);
  assert.equal(MODEL_INFO.glm.defaultEffort, "high");
  assert.equal(MODEL_INFO.qwen.reasoning, CAPABILITY.QWEN_BUDGET);
  assert.equal(MODEL_INFO.qwen.defaultEffort, "high");
  assert.equal(MODEL_INFO.deepseek.reasoning, CAPABILITY.OPENAI_EFFORT);
  assert.equal(MODEL_INFO.deepseek.reasoningVocab, "deepseek");
  assert.equal(MODEL_INFO.deepseek.defaultEffort, "high");
  assert.equal(MODEL_INFO.composer.reasoning, CAPABILITY.NONE);
  assert.equal(MODEL_INFO.composer.defaultEffort, "off");
});

test("models: modelSupportsThinking stays true only for GLM_TOGGLE/KIMI_TOGGLE/ANTHROPIC_BUDGET", () => {
  const c = { models: { glm: MODEL_INFO.glm, deepseek: MODEL_INFO.deepseek } };
  assert.equal(modelSupportsThinking(c, "glm"), true);
  assert.equal(modelSupportsThinking(c, "deepseek"), false);
});

test("models: modelCapability reads from model info", () => {
  const c = { models: { glm: MODEL_INFO.glm, deepseek: MODEL_INFO.deepseek, composer: MODEL_INFO.composer } };
  assert.equal(modelCapability(c, "glm"), CAPABILITY.GLM_TOGGLE);
  assert.equal(modelCapability(c, "deepseek"), CAPABILITY.OPENAI_EFFORT);
  assert.equal(modelCapability(c, "composer"), CAPABILITY.NONE);
});

test("models: modelHasReasoningControl is true for non-NONE, false for NONE", () => {
  const c = { models: { glm: MODEL_INFO.glm, deepseek: MODEL_INFO.deepseek, composer: MODEL_INFO.composer } };
  assert.equal(modelHasReasoningControl(c, "deepseek"), true);
  assert.equal(modelHasReasoningControl(c, "glm"), true);
  assert.equal(modelHasReasoningControl(c, "composer"), false);
});

test("models: modelCapability falls back to NONE for custom models without a reasoning field", () => {
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "mykimi",
    MULTIPOLY_MYKIMI_TRANSPORT: "cli",
    MULTIPOLY_MYKIMI_CLI_KIND: "kimi",
    MULTIPOLY_MYKIMI_ENABLED: "1",
  });
  // custom cli model is created without reasoning field; modelCapability falls back to NONE
  assert.equal(modelCapability(c, "mykimi"), CAPABILITY.NONE);
});

// --- Task 6: per-model baseline reasoning effort + GLM floor; retire mode-default ---

test("config: per-model effort beats server; legacy GLM_THINKING is per-model only", () => {
  const c = loadConfig({ ...glm, MULTIPOLY_REASONING_EFFORT: "low", MULTIPOLY_GLM_REASONING_EFFORT: "xhigh" });
  assert.equal(c.models.glm.reasoningEffort, "xhigh");
});

test("config: server THINKING=off → effort off when nothing more specific", () => {
  const c = loadConfig({ ...glm, MULTIPOLY_THINKING: "off" });
  assert.equal(c.models.glm.reasoningEffort, "off");
});

test("config: GLM_THINKING does NOT leak onto deepseek", () => {
  const c = loadConfig({ ...glm, MULTIPOLY_DEEPSEEK_API_KEY: "d", GLM_THINKING: "off" });
  assert.equal(c.models.deepseek.reasoningEffort, "high"); // unaffected
  assert.equal(c.models.glm.reasoningEffort, "off");       // glm honors its legacy var
});

test("config: GLM max_tokens floor applies by default but not over explicit", () => {
  assert.ok(loadConfig({ ...glm }).models.glm.maxTokens.review >= 8192);
  assert.equal(loadConfig({ ...glm, MULTIPOLY_GLM_MAX_TOKENS_REVIEW: "2048" }).models.glm.maxTokens.review, 2048);
});

test("config: model config carries reasoning and reasoningVocab from model info", () => {
  const c = loadConfig({ ...glm, MULTIPOLY_DEEPSEEK_API_KEY: "d" });
  assert.equal(c.models.glm.reasoning, CAPABILITY.GLM_TOGGLE);
  assert.equal(c.models.deepseek.reasoning, CAPABILITY.OPENAI_EFFORT);
  assert.equal(c.models.deepseek.reasoningVocab, "deepseek");
});

test("config: retire mode-default — unset MULTIPOLY_THINKING gives auto", () => {
  const c = loadConfig({ ...glm });
  assert.equal(c.thinking, "auto");
});

test("config: all-inherit resolves to baked default effort (glm → high)", () => {
  const c = loadConfig({ ...glm });
  assert.equal(c.models.glm.reasoningEffort, "high");
});

test("config: composer baseline resolves to off (NONE capability)", () => {
  const c = loadConfig({ ...glm });
  assert.equal(c.models.composer.reasoningEffort, "off");
});

// --- Part B: env-defined custom models get capability ---

test("models: env-defined anthropic custom model gets ANTHROPIC_EFFORT capability", () => {
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "claude",
    MULTIPOLY_CLAUDE_TRANSPORT: "anthropic",
    MULTIPOLY_CLAUDE_API_KEY: "sk-ant-xxx",
    MULTIPOLY_CLAUDE_MODEL: "claude-sonnet-4-5",
  });
  assert.equal(modelCapability(c, "claude"), CAPABILITY.ANTHROPIC_EFFORT);
});

test("models: env-defined http model with REASONING_VOCAB=deepseek gets OPENAI_EFFORT", () => {
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "mydeep",
    MULTIPOLY_MYDEEP_API_KEY: "k",
    MULTIPOLY_MYDEEP_BASE_URL: "https://ds.example/v1",
    MULTIPOLY_MYDEEP_MODEL: "deepseek-v3",
    MULTIPOLY_MYDEEP_REASONING_VOCAB: "deepseek",
  });
  assert.equal(modelCapability(c, "mydeep"), CAPABILITY.OPENAI_EFFORT);
  assert.equal(c.models.mydeep.reasoningVocab, "deepseek");
});

test("models: env-defined http model with REASONING=kimi_toggle gets KIMI_TOGGLE", () => {
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "kimi",
    MULTIPOLY_KIMI_API_KEY: "k",
    MULTIPOLY_KIMI_BASE_URL: "https://kimi.example/v1",
    MULTIPOLY_KIMI_MODEL: "kimi-k2",
    MULTIPOLY_KIMI_REASONING: "kimi_toggle",
  });
  assert.equal(modelCapability(c, "kimi"), CAPABILITY.KIMI_TOGGLE);
});

test("models: env-defined http model with no reasoning hint gets NONE", () => {
  const c = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "mymodel",
    MULTIPOLY_MYMODEL_API_KEY: "k",
    MULTIPOLY_MYMODEL_BASE_URL: "https://my.example/v1",
    MULTIPOLY_MYMODEL_MODEL: "my-model-1",
  });
  assert.equal(modelCapability(c, "mymodel"), CAPABILITY.NONE);
});

// ── Part A-1: GLM floor regression guard ──────────────────────────────────────
// Guards the original empty-BUDGET bug: when GLM_MAX_TOKENS_REVIEW is not
// explicitly set, the floor must kick in and yield at least 32768 tokens
// (floor raised from 8192 to 32768 in D2; MIN_THINKING_BUDGET + MIN_OUTPUT_RESERVE
// = 1024 + 1024 comfortably fits inside that).

test("regression: GLM default config yields maxTokens.review >= 32768 (floor guard)", () => {
  const c = loadConfig({ ...glm });
  assert.ok(
    c.models.glm.maxTokens.review >= 32768,
    `Expected GLM maxTokens.review >= 32768 (floor), got ${c.models.glm.maxTokens.review}`,
  );
});
