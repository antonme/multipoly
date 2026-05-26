import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../scripts/lib/config.mjs";
import { loadModelRegistry, CLI_KINDS } from "../scripts/lib/models.mjs";

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

test("transport: opus anthropic builtin appears + configured only when ANTHROPIC_API_KEY set", () => {
  const without = loadConfig({ ...glm });
  assert.equal(without.modelKeys.includes("opus"), false);
  assert.equal("opus" in without.models, false);

  const withKey = loadConfig({ ...glm, ANTHROPIC_API_KEY: "sk-ant-xxx" });
  assert.equal(withKey.modelKeys.includes("opus"), true);
  assert.equal(withKey.models.opus.transport, "anthropic");
  assert.equal(withKey.models.opus.configured, true);
  assert.equal(withKey.models.opus.apiKey, "sk-ant-xxx");
  assert.equal(withKey.models.opus.model, "claude-opus-4-7");
  assert.equal(withKey.models.opus.baseUrl, "https://api.anthropic.com");
  assert.equal(withKey.models.opus.supportsThinking, true);
});

test("transport: opus base URL overridable and validated", () => {
  const c = loadConfig({ ...glm, ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://proxy.test" });
  assert.equal(c.models.opus.baseUrl, "https://proxy.test");
  assert.throws(
    () => loadConfig({ ...glm, ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "ftp://nope" }),
    (e) => e.code === "CONFIG",
  );
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
    MULTIPOLY_K_CLI: "/Users/anton/.local/bin/kimi",
  });
  assert.equal(c.models.k.binary, "/Users/anton/.local/bin/kimi");
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

test("transport: redactedConfig still masks the api key for anthropic models", () => {
  const c = loadConfig({ ...glm, ANTHROPIC_API_KEY: "sk-ant-secret-1234" });
  assert.equal(c.models.opus.apiKey, "sk-ant-secret-1234");
});

test("transport: CLI_KINDS exposes the known agent kinds", () => {
  assert.deepEqual(
    Object.keys(CLI_KINDS).sort(),
    ["agy", "claude", "codex", "cursor", "gemini", "kimi"],
  );
  assert.equal(CLI_KINDS.agy.weakSandbox, true);
  assert.equal(CLI_KINDS.cursor.binary, "cursor-agent");
});

test("transport: registry includes opus only via loadModelRegistry env gate", () => {
  const r = loadModelRegistry({ ANTHROPIC_API_KEY: "k" });
  assert.ok(r.keys.includes("opus"));
  assert.equal(r.info.opus.transport, "anthropic");
});
