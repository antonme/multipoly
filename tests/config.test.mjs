import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  ENDPOINT_PROFILES,
  resolveCallTimeoutMs,
  TIMEOUT_BOUNDS,
} from "../scripts/lib/config.mjs";

const base = { GLM_API_KEY: "test-key" };

test("config: defaults", () => {
  const c = loadConfig({ ...base });
  assert.equal(c.endpoint, "zai-coding-plan");
  assert.equal(c.baseUrl, ENDPOINT_PROFILES["zai-coding-plan"]);
  assert.equal(c.model, "glm-5.1");
  assert.equal(c.thinking, "mode-default");
  assert.equal(c.maxTokens.review, 131072);
  assert.equal(c.maxTokens.consult, 131072);
  assert.equal(c.maxTokens.freeform, 131072);
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
  assert.equal(c.apiKey, "zk");
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
  assert.equal(c.baseUrl, "https://example.com/v1");
});

test("config: unknown endpoint rejected", () => {
  assert.throws(
    () => loadConfig({ ...base, GLM_ENDPOINT: "nope" }),
    (e) => e.code === "CONFIG",
  );
});

test("config: bigmodel-cn endpoint resolves", () => {
  const c = loadConfig({ ...base, GLM_ENDPOINT: "bigmodel-cn" });
  assert.equal(c.baseUrl, ENDPOINT_PROFILES["bigmodel-cn"]);
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
  assert.equal(c.apiKey, "glm");
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
  assert.equal(c.baseUrl, "http://localhost:8080/v1");
  const c2 = loadConfig({
    ...base,
    GLM_ENDPOINT: "custom",
    GLM_BASE_URL: "http://127.0.0.1:8080/v1",
  });
  assert.equal(c2.baseUrl, "http://127.0.0.1:8080/v1");
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
  assert.equal(c.baseUrl, "http://[::1]:8080/v1");
});

test("config: GLM_BASE_URL accepts 127.x.x.x loopback range", () => {
  const c = loadConfig({
    ...base,
    GLM_ENDPOINT: "custom",
    GLM_BASE_URL: "http://127.0.0.2:8080/v1",
  });
  assert.equal(c.baseUrl, "http://127.0.0.2:8080/v1");
});

test("config: GLM_BASE_URL accepts IPv4-mapped IPv6 loopback (any form)", () => {
  // Both the dotted "::ffff:127.0.0.1" and its canonical "::ffff:7f00:1"
  // normalization must be accepted, and the canonical form round-trips.
  const c1 = loadConfig({
    ...base,
    GLM_ENDPOINT: "custom",
    GLM_BASE_URL: "http://[::ffff:127.0.0.1]:8080/v1",
  });
  assert.ok(c1.baseUrl.startsWith("http://[::ffff:"));
  const c2 = loadConfig({
    ...base,
    GLM_ENDPOINT: "custom",
    GLM_BASE_URL: "http://[::ffff:7fff:ffff]:8080/v1",
  });
  assert.equal(c2.baseUrl, "http://[::ffff:7fff:ffff]:8080/v1");
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
