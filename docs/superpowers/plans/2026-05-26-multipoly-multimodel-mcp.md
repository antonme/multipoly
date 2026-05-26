# Multipoly Multimodel MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the copied `glm` MCP plugin into `multipoly`, a multimodel MCP server with model-specific review/consult tools plus council review/consult tools.

**Architecture:** Keep the existing safe git/file gathering, secret scanning, SSE parsing, schema validation, and budget handling. Add a model registry and route the same review/consult core through model keys (`glm`, `qwen`, `deepseek`, `composer`). Council tools gather context once, run member models in parallel, then ask Qwen to synthesize the member outputs.

**Tech Stack:** Node 18+ ES modules, native `fetch`, `@modelcontextprotocol/sdk`, `node:test`, OpenAI-compatible chat-completions streaming APIs.

---

## Public API

The MCP server exposes these tools:

- `glm_review`, `qwen_review`, `deepseek_review`, `composer_review`
- `glm_consult`, `qwen_consult`, `deepseek_consult`, `composer_consult`
- `council_review`, `council_consult`

The project/plugin/package name is `multipoly`. `multipoly` is not used as the common prefix for individual tools because explicit model names make MCP discovery and slash-command use clearer.

No freeform tools are included in v1. The old `glm_freeform` implementation is removed from the public MCP surface but can be reintroduced later as `*_freeform` if there is a concrete use case.

## File Structure

- Modify `package.json`: rename package and scripts from `glm-mcp`/`glm` to `multipoly`.
- Modify `.claude-plugin/plugin.json`: rename plugin and server command metadata.
- Rename `scripts/glm-mcp.mjs` to `scripts/multipoly-mcp.mjs`: MCP entrypoint, generated tool descriptors, dispatch.
- Create `scripts/lib/models.mjs`: model keys, display names, default env variable names, per-model config loader.
- Modify `scripts/lib/config.mjs`: server-level config plus per-model config map.
- Modify `scripts/lib/client.mjs`: call a selected model config instead of hardcoded `config.model/baseUrl/apiKey`.
- Create `scripts/lib/model-review.mjs`: model-parameterized review core.
- Create `scripts/lib/model-consult.mjs`: model-parameterized consult core.
- Create `scripts/lib/council.mjs`: council orchestration and Qwen synthesis.
- Modify `scripts/lib/prompts.mjs`: add council synthesis prompts.
- Modify `scripts/lib/schema.mjs`: add council review schema and validator.
- Keep `scripts/lib/gather.mjs`, `git.mjs`, `fs-safe.mjs`, `secrets.mjs`, `sse.mjs`, `budget.mjs`, `errors.mjs`: reuse with minimal edits only where imports change.
- Rename commands in `commands/`: add per-model and council slash commands.
- Rename skill `skills/glm-prompting` to `skills/multipoly-prompting`.
- Update tests under `tests/`: config, client, model review/consult, council, MCP tool list, prompts, schema.
- Update `README.md`: install, env vars, tool reference, council behavior, timeout guidance.

---

## Task 1: Baseline Rename To Multipoly

**Files:**
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`
- Move: `scripts/glm-mcp.mjs` -> `scripts/multipoly-mcp.mjs`
- Modify: `README.md`
- Test: `tests/config.test.mjs`

- [ ] **Step 1: Rename package metadata**

Replace `package.json` with:

```json
{
  "name": "multipoly-mcp",
  "version": "0.1.0",
  "description": "MCP server for multimodel code review, design consultation, and model councils.",
  "type": "module",
  "private": true,
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "start": "node scripts/multipoly-mcp.mjs",
    "health": "node scripts/multipoly-mcp.mjs --health",
    "test": "node --test --test-reporter=spec tests/*.test.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

- [ ] **Step 2: Rename plugin manifest**

Replace `.claude-plugin/plugin.json` with:

```json
{
  "name": "multipoly",
  "version": "0.1.0",
  "description": "Use multiple coding models from Claude Code for review, consultation, and council synthesis.",
  "author": {
    "name": "Anton Volnuhin"
  },
  "mcpServers": {
    "multipoly": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/multipoly-mcp.mjs"]
    }
  }
}
```

- [ ] **Step 3: Rename entrypoint file**

Run:

```bash
mv scripts/glm-mcp.mjs scripts/multipoly-mcp.mjs
```

Then replace the header comment and server identity in `scripts/multipoly-mcp.mjs`:

```js
/**
 * Multipoly MCP server entrypoint.
 *
 * Exposes model-specific review/consult tools and council tools over MCP stdio.
 *
 * Startup:
 *   node scripts/multipoly-mcp.mjs           # serve over stdio
 *   node scripts/multipoly-mcp.mjs --health  # validate config and exit
 */
```

In the `new Server(...)` call, change:

```js
{ name: "multipoly", version: "0.1.0" }
```

- [ ] **Step 4: Run package rename smoke**

Run:

```bash
GLM_API_KEY=dummy npm run health
```

Expected: command launches `scripts/multipoly-mcp.mjs`. It may still show old `glm` config fields before Task 2; the important check is that the renamed package script works with the pre-registry config.

- [ ] **Step 5: Commit baseline rename**

```bash
git add package.json .claude-plugin/plugin.json scripts/multipoly-mcp.mjs README.md
git add -u scripts/glm-mcp.mjs
git commit -m "chore: rename plugin to multipoly"
```

---

## Task 2: Add Model Registry And Multimodel Config

**Files:**
- Create: `scripts/lib/models.mjs`
- Modify: `scripts/lib/config.mjs`
- Modify: `tests/config.test.mjs`

- [ ] **Step 1: Write failing registry tests**

Append to `tests/config.test.mjs`:

```js
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
});

test("config: model-specific env vars override legacy GLM env vars", () => {
  const c = loadConfig({
    GLM_API_KEY: "legacy",
    MULTIPOLY_GLM_API_KEY: "specific",
  });
  assert.equal(c.models.glm.apiKey, "specific");
});

test("config: missing qwen config does not prevent GLM-only startup", () => {
  const c = loadConfig({ MULTIPOLY_GLM_API_KEY: "glm-key" });
  assert.equal(c.models.glm.configured, true);
  assert.equal(c.models.qwen.configured, false);
  assert.equal(c.models.qwen.missing.length > 0, true);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --test --test-reporter=spec tests/config.test.mjs
```

Expected: FAIL because `config.models` does not exist.

- [ ] **Step 3: Create model registry**

Create `scripts/lib/models.mjs`:

```js
import { GlmError } from "./errors.mjs";

export const MODEL_KEYS = Object.freeze(["glm", "qwen", "deepseek", "composer"]);

export const MODEL_INFO = Object.freeze({
  glm: Object.freeze({
    key: "glm",
    displayName: "GLM 5.1",
    defaultModel: "glm-5.1",
    defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKeyEnv: ["MULTIPOLY_GLM_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY"],
  }),
  qwen: Object.freeze({
    key: "qwen",
    displayName: "Qwen 3.7 Max",
    defaultModel: "qwen3.7max",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_QWEN_API_KEY", "QWEN_API_KEY"],
  }),
  deepseek: Object.freeze({
    key: "deepseek",
    displayName: "DeepSeek V4 Pro",
    defaultModel: "deepseek-v4-pro",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"],
  }),
  composer: Object.freeze({
    key: "composer",
    displayName: "Composer 2.5",
    defaultModel: "composer2.5",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_COMPOSER_API_KEY", "COMPOSER_API_KEY"],
  }),
});

export function assertModelKey(raw) {
  if (MODEL_KEYS.includes(raw)) return raw;
  throw new GlmError(
    "INVALID_INPUT",
    `unknown model ${JSON.stringify(raw)}; expected one of ${MODEL_KEYS.join(", ")}`,
  );
}

export function envPrefixForModel(key) {
  assertModelKey(key);
  return `MULTIPOLY_${key.toUpperCase()}`;
}

export function firstNonEmpty(env, names) {
  for (const name of names) {
    const v = (env[name] || "").trim();
    if (v) return { name, value: v };
  }
  return null;
}
```

- [ ] **Step 4: Modify config loader**

In `scripts/lib/config.mjs`, import the registry:

```js
import { MODEL_KEYS, MODEL_INFO, envPrefixForModel, firstNonEmpty } from "./models.mjs";
```

Add these helpers below `validateCustomBaseUrl`:

```js
function resolveLegacyGlmBaseUrl(env) {
  const explicit = (env.GLM_BASE_URL || "").trim();
  if (explicit) return explicit;
  const endpoint = env.GLM_ENDPOINT || "zai-coding-plan";
  if (endpoint === "custom") return explicit || null;
  return ENDPOINT_PROFILES[endpoint] || null;
}

function loadOneModelConfig(env, key) {
  const info = MODEL_INFO[key];
  const prefix = envPrefixForModel(key);
  const baseUrlRaw =
    env[`${prefix}_BASE_URL`] ||
    (key === "glm" ? resolveLegacyGlmBaseUrl(env) : null) ||
    info.defaultBaseUrl;
  const model = env[`${prefix}_MODEL`] || (key === "glm" ? env.GLM_MODEL : null) || info.defaultModel;
  const keyHit = firstNonEmpty(env, info.apiKeyEnv);
  const missing = [];

  if (!baseUrlRaw) missing.push(`${prefix}_BASE_URL`);
  if (!model) missing.push(`${prefix}_MODEL`);
  if (!keyHit) missing.push(info.apiKeyEnv.join(" or "));

  if (missing.length > 0) {
    return Object.freeze({
      key,
      displayName: info.displayName,
      configured: false,
      missing: Object.freeze(missing),
      model,
      baseUrl: baseUrlRaw || null,
      apiKey: null,
    });
  }

  return Object.freeze({
    key,
    displayName: info.displayName,
    configured: true,
    missing: Object.freeze([]),
    model,
    baseUrl: validateCustomBaseUrl(baseUrlRaw),
    apiKey: keyHit.value,
    apiKeyEnv: keyHit.name,
  });
}
```

In `loadConfig`, replace the single `apiKey`, `model`, `endpoint`, and `baseUrl` fields with a model map:

```js
const models = Object.fromEntries(
  MODEL_KEYS.map((key) => [key, loadOneModelConfig(env, key)]),
);

if (!Object.values(models).some((m) => m.configured)) {
  throw new GlmError(
    "AUTH",
    "No model API key found. Configure at least one model, for example MULTIPOLY_GLM_API_KEY.",
  );
}
```

Return these fields:

```js
return Object.freeze({
  models: Object.freeze(models),
  thinking,
  maxTokens: Object.freeze(maxTokens),
  caps: Object.freeze(caps),
  timeoutMs,
  allowSecrets,
  debugReasoning,
  progress,
});
```

Update `redactedConfig`:

```js
export function redactedConfig(config) {
  const models = Object.fromEntries(
    Object.entries(config.models).map(([key, m]) => [
      key,
      {
        ...m,
        apiKey: m.apiKey ? `***${m.apiKey.slice(-4)}` : null,
      },
    ]),
  );
  return { ...config, models };
}
```

Update the existing config tests in `tests/config.test.mjs` so single-model expectations read from `c.models.glm` instead of `c.baseUrl`, `c.apiKey`, or `c.model`. For example:

```js
const c = loadConfig({ GLM_API_KEY: "k" });
assert.equal(c.models.glm.configured, true);
assert.equal(c.models.glm.model, "glm-5.1");
assert.equal(c.models.glm.apiKey, "k");
assert.equal(c.models.glm.baseUrl, "https://api.z.ai/api/coding/paas/v4");
```

- [ ] **Step 5: Run config tests**

Run:

```bash
node --test --test-reporter=spec tests/config.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit config registry**

```bash
git add scripts/lib/models.mjs scripts/lib/config.mjs tests/config.test.mjs
git commit -m "feat: add multipoly model registry"
```

---

## Task 3: Generalize The Streaming Client

**Files:**
- Modify: `scripts/lib/client.mjs`
- Modify: `tests/client.test.mjs`
- Modify: `tests/client-fallback.test.mjs`

- [ ] **Step 1: Write failing client routing test**

Append to `tests/client.test.mjs`:

```js
test("client: sends request to selected model config", async () => {
  const fetchImpl = makeFetch({});
  const out = await streamChatCompletion({
    config: {
      ...baseConfig,
      models: {
        qwen: {
          configured: true,
          key: "qwen",
          displayName: "Qwen",
          baseUrl: "https://qwen.example/v1",
          apiKey: "qwen-key",
          model: "qwen3.7max",
        },
      },
    },
    modelKey: "qwen",
    messages: [{ role: "user", content: "hi" }],
    mode: "consult",
    fetchImpl,
  });
  assert.equal(out.content, "ok");
  assert.equal(fetchImpl.calls[0].url, "https://qwen.example/v1/chat/completions");
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.model, "qwen3.7max");
  assert.equal(fetchImpl.calls[0].opts.headers.authorization, "Bearer qwen-key");
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --test --test-reporter=spec tests/client.test.mjs
```

Expected: FAIL because `streamChatCompletion` does not accept `modelKey`.

- [ ] **Step 3: Modify client signature and model selection**

In `scripts/lib/client.mjs`, update the exported function signature:

```js
export async function streamChatCompletion({
  config,
  modelKey,
  messages,
  mode,
  responseFormat,
  thinking,
  timeoutMs,
  fetchImpl = globalThis.fetch,
}) {
```

Add this block after `effectiveTimeoutMs`:

```js
const modelConfig = config.models?.[modelKey] ?? {
  configured: true,
  key: "glm",
  displayName: "GLM 5.1",
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  model: config.model,
};

if (!modelConfig?.configured) {
  throw new GlmError(
    "CONFIG",
    `${modelKey} is not configured: missing ${modelConfig.missing.join(", ")}`,
    { details: { model: modelKey, missing: modelConfig.missing } },
  );
}
```

Change request body model:

```js
model: modelConfig.model,
```

Change `callWithRetry` arguments:

```js
url: `${modelConfig.baseUrl}/chat/completions`,
apiKey: modelConfig.apiKey,
```

Change progress reporter construction:

```js
const progress = new ProgressReporter(config.progress, `${modelKey}:${mode}`, correlationId);
```

- [ ] **Step 4: Update existing tests to pass `modelKey`**

In `tests/client.test.mjs` and `tests/client-fallback.test.mjs`, add `modelKey: "glm"` to every `streamChatCompletion({ ... })` call.

Update the test `baseConfig` objects to include both legacy and new fields during transition:

```js
const baseConfig = {
  baseUrl: "https://api.test/v1",
  apiKey: "k",
  model: "glm-5.1",
  models: {
    glm: {
      configured: true,
      key: "glm",
      displayName: "GLM",
      baseUrl: "https://api.test/v1",
      apiKey: "k",
      model: "glm-5.1",
    },
  },
  thinking: "mode-default",
  timeoutMs: 5000,
  maxTokens: { review: 8192, consult: 16384, freeform: 16384 },
  progress: "off",
};
```

- [ ] **Step 5: Run client tests**

Run:

```bash
node --test --test-reporter=spec tests/client.test.mjs tests/client-fallback.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit generalized client**

```bash
git add scripts/lib/client.mjs tests/client.test.mjs tests/client-fallback.test.mjs
git commit -m "feat: route client calls by model"
```

---

## Task 4: Split Review And Consult Into Model-Parameterized Cores

**Files:**
- Create: `scripts/lib/model-review.mjs`
- Create: `scripts/lib/model-consult.mjs`
- Modify: `scripts/lib/review.mjs`
- Modify: `scripts/lib/consult.mjs`
- Modify: `tests/review.test.mjs`

- [ ] **Step 1: Create `model-review.mjs`**

Move the body of `handleReview` into a model-parameterized function in `scripts/lib/model-review.mjs`:

```js
import { GlmError } from "./errors.mjs";
import { gatherReview } from "./gather.mjs";
import { scanMany, formatHitsForError } from "./secrets.mjs";
import { streamChatCompletion } from "./client.mjs";
import {
  REVIEW_SYSTEM_PROMPT,
  REVIEW_JSON_ONLY_PREFIX,
  renderReviewUserMessage,
} from "./prompts.mjs";
import { REVIEW_SCHEMA, validateReview } from "./schema.mjs";
import { assertContentBudget } from "./budget.mjs";
import { resolveCallTimeoutMs } from "./config.mjs";

export async function prepareReview(input, { config, cwd = process.cwd() } = {}) {
  const gathered = await gatherReview({
    diffBase: input.diff_base,
    paths: input.paths,
    cwd,
    caps: config.caps,
  });

  const pieces = [];
  if (gathered.mode === "diff" && gathered.diffText) pieces.push({ text: gathered.diffText, label: "diff" });
  for (const f of gathered.files) {
    if (f.status === "inlined") pieces.push({ text: f.content, label: f.path });
  }
  if (typeof input.focus === "string" && input.focus.length > 0) {
    pieces.push({ text: input.focus, label: "focus" });
  }
  const secretScan = scanMany(pieces);
  if (!secretScan.clean && !config.allowSecrets) {
    throw new GlmError(
      "SECRET",
      `Potential secrets detected in outbound payload:\n${formatHitsForError(secretScan.hits)}\nSet MULTIPOLY_ALLOW_SECRETS=1 to override.`,
    );
  }

  const userMessage = renderReviewUserMessage(gathered, input.focus);
  return {
    input,
    gathered,
    messages: [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    userMessage,
    timeoutMs: resolveCallTimeoutMs(input.timeout_ms),
  };
}

export async function runPreparedReview(modelKey, prepared, { config, fetchImpl } = {}) {
  const responseFormat = {
    type: "json_schema",
    json_schema: { name: `${modelKey}_review`, strict: true, schema: REVIEW_SCHEMA },
  };

  const attempt1 = await streamChatCompletion({
    config,
    modelKey,
    messages: prepared.messages,
    mode: "review",
    responseFormat,
    timeoutMs: prepared.timeoutMs,
    fetchImpl,
  });

  assertContentBudget(attempt1, config.maxTokens.review, "review");
  let parsed = tryParseJson(attempt1.content);
  let validation = parsed.ok ? validateReview(parsed.value) : { valid: false, reason: parsed.error };
  let reasoning = attempt1.reasoning;

  if (!validation.valid) {
    const attempt1Echo = safeTruncate(attempt1.content, 8192);
    const attempt2 = await streamChatCompletion({
      config,
      modelKey,
      messages: [
        ...prepared.messages,
        { role: "assistant", content: attempt1Echo },
        {
          role: "user",
          content: REVIEW_JSON_ONLY_PREFIX + (validation.reason ? `\n\nValidation error: ${validation.reason}` : ""),
        },
      ],
      mode: "review",
      responseFormat: attempt1.fellBackFromJsonSchema ? { type: "json_object" } : responseFormat,
      timeoutMs: prepared.timeoutMs,
      fetchImpl,
    });
    assertContentBudget(attempt2, config.maxTokens.review, "review");
    if (attempt2.reasoning) reasoning = attempt2.reasoning;
    parsed = tryParseJson(attempt2.content);
    validation = parsed.ok ? validateReview(parsed.value) : { valid: false, reason: parsed.error };
    if (!validation.valid) {
      throw new GlmError("SCHEMA", `${modelKey} review output failed validation: ${validation.reason}`, {
        details: { rawPrefix: attempt2.content.slice(0, 200) },
      });
    }
  }

  const normalizedFindings = parsed.value.findings.map((f) => ({
    severity: f.severity,
    path: f.path,
    line: f.line ?? null,
    end_line: f.end_line ?? null,
    message: f.message,
    suggestion: f.suggestion ?? null,
  }));

  return {
    result: {
      schema_version: "1",
      model: modelKey,
      findings: normalizedFindings,
      summary_md: parsed.value.summary_md,
      truncated: prepared.gathered.truncated,
      files: prepared.gathered.files.map(({ content, ...rest }) => rest),
    },
    reasoning,
  };
}

export async function handleModelReview(modelKey, input, { config, fetchImpl } = {}) {
  const prepared = await prepareReview(input, { config });
  return runPreparedReview(modelKey, prepared, { config, fetchImpl });
}

function safeTruncate(s, max) {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + "\n...[prior invalid output truncated]";
}

function tryParseJson(text) {
  const stripped = stripCodeFence(text).trim();
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function stripCodeFence(text) {
  const openMatch = text.match(/^\s*```(?:\s*json)?\s*\r?\n/i);
  if (!openMatch) return text;
  const afterOpen = text.slice(openMatch[0].length);
  return afterOpen.replace(/\r?\n\s*```\s*(?:\r?\n[\s\S]*)?$/, "");
}
```

- [ ] **Step 2: Create `model-consult.mjs`**

Create `scripts/lib/model-consult.mjs`:

```js
import { GlmError } from "./errors.mjs";
import { gatherConsult } from "./gather.mjs";
import { scanMany, formatHitsForError } from "./secrets.mjs";
import { streamChatCompletion } from "./client.mjs";
import { CONSULT_SYSTEM_PROMPT, renderConsultUserMessage } from "./prompts.mjs";
import { assertContentBudget } from "./budget.mjs";
import { resolveCallTimeoutMs } from "./config.mjs";

export async function prepareConsult(input, { config, cwd = process.cwd() } = {}) {
  const gathered = await gatherConsult({
    prompt: input.prompt,
    paths: input.paths,
    cwd,
    caps: config.caps,
  });

  const pieces = [{ text: gathered.prompt, label: "prompt" }];
  for (const f of gathered.files) pieces.push({ text: f.content, label: f.path });
  const secretScan = scanMany(pieces);
  if (!secretScan.clean && !config.allowSecrets) {
    throw new GlmError(
      "SECRET",
      `Potential secrets detected in outbound payload:\n${formatHitsForError(secretScan.hits)}\nSet MULTIPOLY_ALLOW_SECRETS=1 to override.`,
    );
  }

  return {
    input,
    gathered,
    messages: [
      { role: "system", content: CONSULT_SYSTEM_PROMPT },
      { role: "user", content: renderConsultUserMessage(gathered.prompt, gathered.files) },
    ],
    timeoutMs: resolveCallTimeoutMs(input.timeout_ms),
  };
}

export async function runPreparedConsult(modelKey, prepared, { config, fetchImpl } = {}) {
  const attempt = await streamChatCompletion({
    config,
    modelKey,
    messages: prepared.messages,
    mode: "consult",
    timeoutMs: prepared.timeoutMs,
    fetchImpl,
  });
  const { truncated } = assertContentBudget(attempt, config.maxTokens.consult, "consult");
  const result = truncated
    ? `${attempt.content}\n\n> Output truncated at MULTIPOLY_MAX_TOKENS_CONSULT (${config.maxTokens.consult}). Raise the cap for a complete answer.`
    : attempt.content;
  return { result, reasoning: attempt.reasoning };
}

export async function handleModelConsult(modelKey, input, { config, fetchImpl } = {}) {
  const prepared = await prepareConsult(input, { config });
  return runPreparedConsult(modelKey, prepared, { config, fetchImpl });
}
```

- [ ] **Step 3: Keep compatibility wrappers**

Replace `scripts/lib/review.mjs` with:

```js
import { handleModelReview } from "./model-review.mjs";

export async function handleReview(input, ctx = {}) {
  return handleModelReview("glm", input, ctx);
}
```

Replace `scripts/lib/consult.mjs` with:

```js
import { handleModelConsult } from "./model-consult.mjs";

export async function handleConsult(input, ctx = {}) {
  return handleModelConsult("glm", input, ctx);
}
```

- [ ] **Step 4: Update review tests for model config**

In `tests/review.test.mjs`, add this to `baseConfig`:

```js
models: {
  glm: {
    configured: true,
    key: "glm",
    displayName: "GLM",
    baseUrl: "https://api.test/v1",
    apiKey: "k",
    model: "glm-5.1",
  },
},
```

- [ ] **Step 5: Run review tests**

Run:

```bash
node --test --test-reporter=spec tests/review.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit model-parameterized core**

```bash
git add scripts/lib/model-review.mjs scripts/lib/model-consult.mjs scripts/lib/review.mjs scripts/lib/consult.mjs tests/review.test.mjs
git commit -m "refactor: parameterize review and consult by model"
```

---

## Task 5: Generate Model-Specific MCP Tools

**Files:**
- Modify: `scripts/multipoly-mcp.mjs`
- Create: `tests/mcp-tools.test.mjs`

- [ ] **Step 1: Write tool list tests**

Create `tests/mcp-tools.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTools } from "../scripts/multipoly-mcp.mjs";

test("mcp tools: exposes model-specific review and consult tools plus council tools", () => {
  const names = buildTools().map((t) => t.name).sort();
  assert.deepEqual(names, [
    "composer_consult",
    "composer_review",
    "council_consult",
    "council_review",
    "deepseek_consult",
    "deepseek_review",
    "glm_consult",
    "glm_review",
    "qwen_consult",
    "qwen_review",
  ]);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --test --test-reporter=spec tests/mcp-tools.test.mjs
```

Expected: FAIL because `buildTools` is not exported.

- [ ] **Step 3: Export tool builder**

In `scripts/multipoly-mcp.mjs`, import model registry and generic handlers:

```js
import { MODEL_KEYS, MODEL_INFO } from "./lib/models.mjs";
import { handleModelReview } from "./lib/model-review.mjs";
import { handleModelConsult } from "./lib/model-consult.mjs";
import { handleCouncilReview, handleCouncilConsult } from "./lib/council.mjs";
```

Replace the hardcoded `TOOLS` constant with:

```js
export function buildTools() {
  const tools = [];
  for (const key of MODEL_KEYS) {
    const info = MODEL_INFO[key];
    tools.push({
      name: `${key}_review`,
      description: `Delegate a structured code review to ${info.displayName}.`,
      inputSchema: REVIEW_TOOL_SCHEMA,
    });
    tools.push({
      name: `${key}_consult`,
      description: `Ask ${info.displayName} for a design or implementation consultation.`,
      inputSchema: CONSULT_TOOL_SCHEMA,
    });
  }
  tools.push({
    name: "council_review",
    description: "Run multiple model reviews in parallel, then synthesize with Qwen.",
    inputSchema: COUNCIL_REVIEW_TOOL_SCHEMA,
  });
  tools.push({
    name: "council_consult",
    description: "Run multiple model consultations in parallel, then synthesize with Qwen.",
    inputSchema: COUNCIL_CONSULT_TOOL_SCHEMA,
  });
  return tools;
}
```

Add schema constants near the top:

```js
const TIMEOUT_ARG_SCHEMA = {
  type: "integer",
  minimum: TIMEOUT_BOUNDS.min,
  maximum: TIMEOUT_BOUNDS.max,
  description: "Optional upstream stream inactivity timeout override in milliseconds.",
};

const REVIEW_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    diff_base: { type: "string", description: "Git ref to diff HEAD against." },
    paths: { type: "array", items: { type: "string" }, minItems: 1 },
    focus: { type: "string" },
    timeout_ms: TIMEOUT_ARG_SCHEMA,
  },
};

const CONSULT_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: { type: "string", minLength: 1 },
    paths: { type: "array", items: { type: "string" } },
    timeout_ms: TIMEOUT_ARG_SCHEMA,
  },
};

const COUNCIL_REVIEW_TOOL_SCHEMA = {
  ...REVIEW_TOOL_SCHEMA,
  properties: {
    ...REVIEW_TOOL_SCHEMA.properties,
    models: {
      type: "array",
      items: { type: "string", enum: MODEL_KEYS },
      minItems: 2,
      description: "Optional council member models. Defaults to all configured models.",
    },
    synthesizer: { type: "string", enum: MODEL_KEYS, description: "Defaults to qwen." },
    include_individual_results: { type: "boolean" },
  },
};

const COUNCIL_CONSULT_TOOL_SCHEMA = {
  ...CONSULT_TOOL_SCHEMA,
  properties: {
    ...CONSULT_TOOL_SCHEMA.properties,
    models: {
      type: "array",
      items: { type: "string", enum: MODEL_KEYS },
      minItems: 2,
      description: "Optional council member models. Defaults to all configured models.",
    },
    synthesizer: { type: "string", enum: MODEL_KEYS, description: "Defaults to qwen." },
    include_individual_results: { type: "boolean" },
  },
};
```

Set:

```js
const TOOLS = buildTools();
```

- [ ] **Step 4: Replace handler map**

Replace `HANDLERS` with:

```js
const HANDLERS = Object.fromEntries([
  ...MODEL_KEYS.flatMap((key) => [
    [`${key}_review`, (input, ctx) => handleModelReview(key, input, ctx)],
    [`${key}_consult`, (input, ctx) => handleModelConsult(key, input, ctx)],
  ]),
  ["council_review", handleCouncilReview],
  ["council_consult", handleCouncilConsult],
]);
```

Update `buildSuccessResponse` so any tool ending in `_review` returns JSON:

```js
if (name.endsWith("_review")) {
  blocks.push({ type: "text", text: JSON.stringify(result, null, 2) });
} else {
  blocks.push({ type: "text", text: result });
}
```

- [ ] **Step 5: Update validation**

Replace `ALLOWED_KEYS` with generated sets:

```js
const REVIEW_KEYS = new Set(["diff_base", "paths", "focus", "timeout_ms"]);
const CONSULT_KEYS = new Set(["prompt", "paths", "timeout_ms"]);
const COUNCIL_EXTRA_KEYS = new Set(["models", "synthesizer", "include_individual_results"]);
```

In `validateToolInput`, route by suffix:

```js
if (name.endsWith("_review")) validateReviewInput(name, input, name.startsWith("council_"));
else if (name.endsWith("_consult")) validateConsultInput(name, input, name.startsWith("council_"));
else throw new GlmError("INVALID_INPUT", `unknown tool shape: ${name}`);
```

Implement `validateReviewInput` and `validateConsultInput` by reusing the existing review/consult checks and allowing council extra keys when `isCouncil` is true.

- [ ] **Step 6: Run MCP tool tests**

Run:

```bash
node --test --test-reporter=spec tests/mcp-tools.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit generated tool surface**

```bash
git add scripts/multipoly-mcp.mjs tests/mcp-tools.test.mjs
git commit -m "feat: expose model-specific MCP tools"
```

---

## Task 6: Add Council Review And Consult

**Files:**
- Create: `scripts/lib/council.mjs`
- Modify: `scripts/lib/prompts.mjs`
- Modify: `scripts/lib/schema.mjs`
- Create: `tests/council.test.mjs`
- Modify: `tests/schema.test.mjs`

- [ ] **Step 1: Add council prompt constants**

Append to `scripts/lib/prompts.mjs`:

```js
export const COUNCIL_REVIEW_SYNTHESIS_PROMPT = `You are Qwen acting as a council chair.

You will receive structured review outputs from multiple models. Merge them into one high-signal review.

Rules:
- Deduplicate overlapping findings.
- Prefer correctness, security, data-loss, and production-risk issues over style.
- Preserve material disagreements in summary_md.
- Output STRICT JSON matching the provided schema. No prose outside JSON.`;

export const COUNCIL_CONSULT_SYNTHESIS_PROMPT = `You are Qwen acting as a council chair.

You will receive answers from multiple models. Produce one concise final answer.

Rules:
- Merge the best arguments.
- Call out disagreements only when they affect the decision.
- Do not average weak opinions into a vague compromise.
- Use markdown with short sections or bullets.`;

export function renderCouncilReviewSynthesisMessage({ originalPrompt, memberResults, schema }) {
  return [
    "# Original review request",
    originalPrompt,
    "# Member review outputs",
    JSON.stringify(memberResults, null, 2),
    "# Required output schema",
    JSON.stringify(schema, null, 2),
  ].join("\n\n");
}

export function renderCouncilConsultSynthesisMessage({ originalPrompt, memberResults }) {
  return [
    "# Original consult request",
    originalPrompt,
    "# Member consult outputs",
    JSON.stringify(memberResults, null, 2),
  ].join("\n\n");
}
```

- [ ] **Step 2: Add council review schema**

Append to `scripts/lib/schema.mjs`:

```js
export const COUNCIL_REVIEW_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "synthesizer", "models", "findings", "summary_md"],
  properties: {
    schema_version: { type: "string", const: "1" },
    synthesizer: { type: "string", enum: ["glm", "qwen", "deepseek", "composer"] },
    models: {
      type: "array",
      items: { type: "string", enum: ["glm", "qwen", "deepseek", "composer"] },
    },
    findings: REVIEW_SCHEMA.properties.findings,
    summary_md: { type: "string" },
  },
});

export function validateCouncilReview(obj) {
  const base = validateReview({
    schema_version: obj?.schema_version,
    findings: obj?.findings,
    summary_md: obj?.summary_md,
  });
  if (!base.valid) return base;
  if (!["glm", "qwen", "deepseek", "composer"].includes(obj.synthesizer)) {
    return { valid: false, reason: `synthesizer invalid: ${JSON.stringify(obj.synthesizer)}` };
  }
  if (!Array.isArray(obj.models) || obj.models.length < 2) {
    return { valid: false, reason: "models must contain at least two model keys" };
  }
  for (const m of obj.models) {
    if (!["glm", "qwen", "deepseek", "composer"].includes(m)) {
      return { valid: false, reason: `models contains invalid key: ${JSON.stringify(m)}` };
    }
  }
  return { valid: true };
}
```

- [ ] **Step 3: Create council implementation**

Create `scripts/lib/council.mjs`:

```js
import { GlmError } from "./errors.mjs";
import { MODEL_KEYS, assertModelKey } from "./models.mjs";
import { prepareReview, runPreparedReview } from "./model-review.mjs";
import { prepareConsult, runPreparedConsult } from "./model-consult.mjs";
import { streamChatCompletion } from "./client.mjs";
import {
  COUNCIL_REVIEW_SYNTHESIS_PROMPT,
  COUNCIL_CONSULT_SYNTHESIS_PROMPT,
  renderCouncilReviewSynthesisMessage,
  renderCouncilConsultSynthesisMessage,
} from "./prompts.mjs";
import { COUNCIL_REVIEW_SCHEMA, validateCouncilReview } from "./schema.mjs";
import { assertContentBudget } from "./budget.mjs";

function resolveCouncilModels(input, config) {
  const requested = input.models?.length ? input.models.map(assertModelKey) : MODEL_KEYS;
  const unique = [...new Set(requested)];
  if (unique.length < 2) {
    throw new GlmError("INVALID_INPUT", "council requires at least two distinct models");
  }
  const missing = unique.filter((key) => !config.models[key]?.configured);
  if (missing.length > 0) {
    throw new GlmError(
      "CONFIG",
      `council requested unconfigured models: ${missing.join(", ")}`,
      { details: { missing } },
    );
  }
  return unique;
}

function resolveSynthesizer(input, config) {
  const key = assertModelKey(input.synthesizer || "qwen");
  if (!config.models[key]?.configured) {
    throw new GlmError("CONFIG", `council synthesizer ${key} is not configured`);
  }
  return key;
}

function serializeError(e) {
  if (e instanceof GlmError) return e.toJSON().error;
  return { code: "INTERNAL", message: e?.message ?? String(e) };
}

export async function handleCouncilReview(input, { config, fetchImpl } = {}) {
  const models = resolveCouncilModels(input, config);
  const synthesizer = resolveSynthesizer(input, config);
  const prepared = await prepareReview(input, { config });

  const settled = await Promise.allSettled(
    models.map(async (modelKey) => {
      const out = await runPreparedReview(modelKey, prepared, { config, fetchImpl });
      return [modelKey, out.result];
    }),
  );
  const memberResults = {};
  for (let i = 0; i < settled.length; i++) {
    const modelKey = models[i];
    const r = settled[i];
    memberResults[modelKey] = r.status === "fulfilled"
      ? { ok: true, result: r.value[1] }
      : { ok: false, error: serializeError(r.reason) };
  }

  const successful = Object.entries(memberResults).filter(([, r]) => r.ok);
  if (successful.length < 2) {
    throw new GlmError("HTTP", "council requires at least two successful member results", {
      details: { memberResults },
    });
  }

  const attempt = await streamChatCompletion({
    config,
    modelKey: synthesizer,
    messages: [
      { role: "system", content: COUNCIL_REVIEW_SYNTHESIS_PROMPT },
      {
        role: "user",
        content: renderCouncilReviewSynthesisMessage({
          originalPrompt: prepared.userMessage,
          memberResults,
          schema: COUNCIL_REVIEW_SCHEMA,
        }),
      },
    ],
    mode: "review",
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "council_review", strict: true, schema: COUNCIL_REVIEW_SCHEMA },
    },
    timeoutMs: prepared.timeoutMs,
    fetchImpl,
  });
  assertContentBudget(attempt, config.maxTokens.review, "review");
  const parsed = JSON.parse(attempt.content.trim());
  const validation = validateCouncilReview(parsed);
  if (!validation.valid) {
    throw new GlmError("SCHEMA", `council review output failed validation: ${validation.reason}`);
  }

  return {
    result: {
      ...parsed,
      files: prepared.gathered.files.map(({ content, ...rest }) => rest),
      truncated: prepared.gathered.truncated,
      member_status: Object.fromEntries(
        Object.entries(memberResults).map(([key, value]) => [
          key,
          value.ok ? { ok: true, findings: value.result.findings.length } : { ok: false, error: value.error },
        ]),
      ),
      ...(input.include_individual_results ? { member_results: memberResults } : {}),
    },
    reasoning: attempt.reasoning,
  };
}

export async function handleCouncilConsult(input, { config, fetchImpl } = {}) {
  const models = resolveCouncilModels(input, config);
  const synthesizer = resolveSynthesizer(input, config);
  const prepared = await prepareConsult(input, { config });
  const settled = await Promise.allSettled(
    models.map(async (modelKey) => {
      const out = await runPreparedConsult(modelKey, prepared, { config, fetchImpl });
      return [modelKey, out.result];
    }),
  );
  const memberResults = {};
  for (let i = 0; i < settled.length; i++) {
    const modelKey = models[i];
    const r = settled[i];
    memberResults[modelKey] = r.status === "fulfilled"
      ? { ok: true, result: r.value[1] }
      : { ok: false, error: serializeError(r.reason) };
  }
  const successful = Object.entries(memberResults).filter(([, r]) => r.ok);
  if (successful.length < 2) {
    throw new GlmError("HTTP", "council requires at least two successful member results", {
      details: { memberResults },
    });
  }
  const attempt = await streamChatCompletion({
    config,
    modelKey: synthesizer,
    messages: [
      { role: "system", content: COUNCIL_CONSULT_SYNTHESIS_PROMPT },
      {
        role: "user",
        content: renderCouncilConsultSynthesisMessage({
          originalPrompt: prepared.input.prompt,
          memberResults,
        }),
      },
    ],
    mode: "consult",
    timeoutMs: prepared.timeoutMs,
    fetchImpl,
  });
  const { truncated } = assertContentBudget(attempt, config.maxTokens.consult, "consult");
  const suffix = truncated
    ? `\n\n> Output truncated at MULTIPOLY_MAX_TOKENS_CONSULT (${config.maxTokens.consult}). Raise the cap for a complete answer.`
    : "";
  const status = `\n\n---\n\nMember status: ${successful.length}/${models.length} succeeded.`;
  const individual = input.include_individual_results
    ? `\n\nIndividual results:\n\n\`\`\`json\n${JSON.stringify(memberResults, null, 2)}\n\`\`\``
    : "";
  return { result: attempt.content + suffix + status + individual, reasoning: attempt.reasoning };
}
```

- [ ] **Step 4: Write council tests**

Create `tests/council.test.mjs` with:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { handleCouncilConsult } from "../scripts/lib/council.mjs";

const execFileP = promisify(execFile);
const enc = new TextEncoder();

async function git(cwd, ...args) {
  return execFileP("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function stream(content) {
  const body = [
    `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}\n\n`,
    "data: [DONE]\n\n",
  ].map((s) => enc.encode(s));
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < body.length) controller.enqueue(body[i++]);
      else controller.close();
    },
  });
}

const config = {
  models: {
    glm: { configured: true, key: "glm", displayName: "GLM", baseUrl: "https://glm.test/v1", apiKey: "g", model: "glm" },
    qwen: { configured: true, key: "qwen", displayName: "Qwen", baseUrl: "https://qwen.test/v1", apiKey: "q", model: "qwen" },
    deepseek: { configured: true, key: "deepseek", displayName: "DeepSeek", baseUrl: "https://deepseek.test/v1", apiKey: "d", model: "deepseek" },
    composer: { configured: true, key: "composer", displayName: "Composer", baseUrl: "https://composer.test/v1", apiKey: "c", model: "composer" },
  },
  thinking: "off",
  timeoutMs: 5000,
  maxTokens: { review: 8192, consult: 16384, freeform: 16384 },
  caps: { perFile: 1024 * 1024, total: 2 * 1024 * 1024, fileCount: 50 },
  allowSecrets: false,
  debugReasoning: false,
  progress: "off",
};

test("council consult: runs members then synthesizer", async () => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "multipoly-council-")));
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(path.join(repo, "a.txt"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base");
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (url.includes("qwen.test") && urls.filter((u) => u.includes("qwen.test")).length === 2) {
        return new Response(stream("synthesis"), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(stream(`member:${url}`), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const out = await handleCouncilConsult(
      { prompt: "what now?", models: ["glm", "qwen"], include_individual_results: true },
      { config, fetchImpl },
    );
    assert.match(out.result, /synthesis/);
    assert.match(out.result, /Individual results/);
    assert.equal(urls.length, 3);
  } finally {
    process.chdir(prev);
  }
});
```

- [ ] **Step 5: Run council tests**

Run:

```bash
node --test --test-reporter=spec tests/council.test.mjs tests/schema.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit council implementation**

```bash
git add scripts/lib/council.mjs scripts/lib/prompts.mjs scripts/lib/schema.mjs tests/council.test.mjs tests/schema.test.mjs
git commit -m "feat: add model council tools"
```

---

## Task 7: Commands, Skill, And README

**Files:**
- Delete: `commands/glm.md`
- Create: `commands/qwen-review.md`
- Create: `commands/deepseek-review.md`
- Create: `commands/composer-review.md`
- Create: `commands/qwen-consult.md`
- Create: `commands/deepseek-consult.md`
- Create: `commands/composer-consult.md`
- Create: `commands/council-review.md`
- Create: `commands/council-consult.md`
- Move: `skills/glm-prompting/SKILL.md` -> `skills/multipoly-prompting/SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: Create qwen review command**

Create `commands/qwen-review.md`:

```markdown
---
description: Run a Qwen code review over a git diff or a list of files. Args: optional base ref, default "main".
---

Parse `$ARGUMENTS`: if empty, use base ref `main`; if it is a single token, call `qwen_review` with `{ "diff_base": "<token>" }`; if the user wrote `paths: X Y Z`, call `qwen_review` with `{ "paths": ["X", "Y", "Z"] }`. Preserve steering text as `focus`.

Present returned JSON grouped by severity and mention `truncated`/`files` when content was omitted.
```

- [ ] **Step 2: Create deepseek and composer review commands**

Copy `commands/qwen-review.md` to:

```bash
cp commands/qwen-review.md commands/deepseek-review.md
cp commands/qwen-review.md commands/composer-review.md
```

Then replace tool names and descriptions:

```text
qwen_review -> deepseek_review
Qwen -> DeepSeek
qwen_review -> composer_review
Qwen -> Composer
```

- [ ] **Step 3: Create consult commands**

Create `commands/qwen-consult.md`:

```markdown
---
description: Ask Qwen for a second opinion on a design or implementation question. Args: the question.
---

Call `qwen_consult` with `{ "prompt": "$ARGUMENTS" }`. If the user explicitly named files to attach, include them as `paths`. Return the markdown response as-is.
```

Create `commands/deepseek-consult.md` and `commands/composer-consult.md` by replacing `Qwen`/`qwen_consult` with `DeepSeek`/`deepseek_consult` and `Composer`/`composer_consult`.

- [ ] **Step 4: Create council commands**

Create `commands/council-review.md`:

```markdown
---
description: Run a multi-model council review, then synthesize with Qwen. Args: optional base ref, default "main".
---

Parse `$ARGUMENTS`: if empty, use base ref `main`; if it is a single token, call `council_review` with `{ "diff_base": "<token>" }`; if the user wrote `paths: X Y Z`, call `council_review` with `{ "paths": ["X", "Y", "Z"] }`. Preserve steering text as `focus`.

Present synthesized findings first. Then show member status. If `member_results` is present, summarize only when the user asks.
```

Create `commands/council-consult.md`:

```markdown
---
description: Run a multi-model design consultation, then synthesize with Qwen. Args: the question.
---

Call `council_consult` with `{ "prompt": "$ARGUMENTS" }`. If the user explicitly named files to attach, include them as `paths`. Return the synthesized markdown answer first and keep member status visible.
```

- [ ] **Step 5: Rename skill**

Run:

```bash
mkdir -p skills/multipoly-prompting
mv skills/glm-prompting/SKILL.md skills/multipoly-prompting/SKILL.md
rmdir skills/glm-prompting
```

Replace skill frontmatter and body with:

```markdown
---
name: multipoly-prompting
description: Guidance for delegating to Multipoly model-specific and council MCP tools.
---

# Using Multipoly

Use model-specific tools when you want one model's independent opinion:

- `glm_review`, `qwen_review`, `deepseek_review`, `composer_review`
- `glm_consult`, `qwen_consult`, `deepseek_consult`, `composer_consult`

Use council tools when disagreement or synthesis is valuable:

- `council_review`: parallel member reviews, Qwen synthesis.
- `council_consult`: parallel member consultations, Qwen synthesis.

Prefer model-specific tools for quick checks. Prefer council tools for risky code, ambiguous design decisions, or when the user explicitly asks for multiple opinions.
```

- [ ] **Step 6: Rewrite README**

Update `README.md` sections:

```markdown
# multipoly - multimodel MCP plugin

Multipoly exposes multiple coding models through one MCP server. It supports direct model-specific review/consult tools and council tools that run multiple models in parallel and synthesize with Qwen.

## Tools

| Tool family | Purpose |
|---|---|
| `glm_review`, `qwen_review`, `deepseek_review`, `composer_review` | Structured code review from one model |
| `glm_consult`, `qwen_consult`, `deepseek_consult`, `composer_consult` | Design/implementation consultation from one model |
| `council_review`, `council_consult` | Parallel member calls plus Qwen synthesis |

## Configuration

Configure any subset of models. A tool returns a typed config error when its model is not configured.

| Model | Required env |
|---|---|
| GLM | `MULTIPOLY_GLM_API_KEY`; optional `MULTIPOLY_GLM_BASE_URL`, `MULTIPOLY_GLM_MODEL` |
| Qwen | `MULTIPOLY_QWEN_API_KEY`, `MULTIPOLY_QWEN_BASE_URL`; optional `MULTIPOLY_QWEN_MODEL` |
| DeepSeek | `MULTIPOLY_DEEPSEEK_API_KEY`, `MULTIPOLY_DEEPSEEK_BASE_URL`; optional `MULTIPOLY_DEEPSEEK_MODEL` |
| Composer | `MULTIPOLY_COMPOSER_API_KEY`, `MULTIPOLY_COMPOSER_BASE_URL`; optional `MULTIPOLY_COMPOSER_MODEL` |
```

Keep the existing safety, timeout, and development sections, replacing `GLM_` names with `MULTIPOLY_` where the setting is server-wide.

- [ ] **Step 7: Commit docs and commands**

```bash
git add README.md commands skills
git add -u commands/glm.md skills/glm-prompting/SKILL.md
git commit -m "docs: document multipoly tools and commands"
```

---

## Task 8: Compatibility Cleanup And Final Verification

**Files:**
- Modify: `scripts/lib/config.mjs`
- Modify: `scripts/lib/errors.mjs`
- Modify: all affected tests

- [ ] **Step 1: Rename server-wide env vars**

In `scripts/lib/config.mjs`, support both new and legacy env names:

```js
const thinking = parseThinking(env.MULTIPOLY_THINKING ?? env.GLM_THINKING);
const maxTokens = {
  review: parseInteger(env.MULTIPOLY_MAX_TOKENS_REVIEW ?? env.GLM_MAX_TOKENS_REVIEW, MODEL_OUTPUT_CEILING),
  consult: parseInteger(env.MULTIPOLY_MAX_TOKENS_CONSULT ?? env.GLM_MAX_TOKENS_CONSULT, MODEL_OUTPUT_CEILING),
  freeform: parseInteger(env.MULTIPOLY_MAX_TOKENS_FREEFORM ?? env.GLM_MAX_TOKENS_FREEFORM, MODEL_OUTPUT_CEILING),
};
const caps = {
  perFile: parseInteger(env.MULTIPOLY_PER_FILE_CAP_BYTES ?? env.GLM_PER_FILE_CAP_BYTES, 256 * 1024),
  total: parseInteger(env.MULTIPOLY_TOTAL_CAP_BYTES ?? env.GLM_TOTAL_CAP_BYTES, 1536 * 1024),
  fileCount: parseInteger(env.MULTIPOLY_FILE_COUNT_CAP ?? env.GLM_FILE_COUNT_CAP, 50),
};
const timeoutMs = parseInteger(env.MULTIPOLY_TIMEOUT_MS ?? env.GLM_TIMEOUT_MS, 600_000, TIMEOUT_BOUNDS);
const allowSecrets = parseBool(env.MULTIPOLY_ALLOW_SECRETS ?? env.GLM_ALLOW_SECRETS, false);
const debugReasoning = parseBool(env.MULTIPOLY_DEBUG_REASONING ?? env.GLM_DEBUG_REASONING, false);
const progress = parseProgress(env.MULTIPOLY_PROGRESS ?? env.GLM_PROGRESS);
```

- [ ] **Step 2: Rename runtime stderr prefixes**

In `scripts/lib/client.mjs`, change progress output from `[glm ...]` to `[multipoly ...]`:

```js
process.stderr.write(`[multipoly ${this.callMode} ${this.correlationId}] streaming...\n`);
```

Update all progress lines in `ProgressReporter`.

- [ ] **Step 3: Remove old `freeform` public imports**

If `scripts/lib/freeform.mjs` is no longer imported by the MCP entrypoint, leave the file for now only if tests still cover it. If no public tool uses it, remove it and remove `tests/freeform` coverage if present. The current repo has no dedicated freeform test file, so prefer deleting the file to avoid a dead public-seeming module:

```bash
rm scripts/lib/freeform.mjs
```

- [ ] **Step 4: Run full tests**

Run:

```bash
npm test
```

Expected:

```text
pass
fail 0
```

The exact test count will increase from the current 123 after council and MCP tool tests are added.

- [ ] **Step 5: Run health check**

Run:

```bash
MULTIPOLY_GLM_API_KEY=dummy npm run health
```

Expected: JSON status `ok`, with `models.glm.configured: true` and qwen/deepseek/composer shown as unconfigured.

- [ ] **Step 6: Verify original fork source is untouched**

Run from `/Users/anton/dev/glm`:

```bash
git status --short --branch
```

Expected: the same original dirty state as before creating `multipoly`; no new files from the fork should appear there.

- [ ] **Step 7: Commit final cleanup**

```bash
git add scripts tests README.md package.json package-lock.json .claude-plugin commands skills
git add -u
git commit -m "chore: finalize multipoly multimodel fork"
```

---

## Self-Review Notes

- Scope is one coherent subsystem: convert one MCP plugin into a multimodel MCP plugin.
- The plan keeps existing safety-critical modules and routes through them rather than rewriting git/file/secret/SSE handling.
- The external tool contract is explicit model names plus `council_*`, matching the agreed naming direction.
- Model provider endpoints are config-driven. The plan does not assume public base URLs for Qwen, DeepSeek, or Composer because those are deployment-specific and easy to misconfigure if hardcoded.
- Council failure policy is explicit: at least two member models must succeed before synthesis.
- No implementation step edits the original `/Users/anton/dev/glm` checkout.
