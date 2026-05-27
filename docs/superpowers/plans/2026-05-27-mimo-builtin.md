# Xiaomi MiMo first-class builtin + `max_completion_tokens` (Plan C) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote Xiaomi MiMo V2.5 Pro from a per-deployment env-custom model to a baked `MODEL_INFO` builtin (capability `http_thinking_toggle`, recognizing the `XIAOMIMIMO_*` env names), and add a per-model `max_completion_tokens` switch so MiMo (which rejects the legacy `max_tokens` field) gets the correct token-cap field on the wire.

**Architecture:** Third of three plans from `docs/superpowers/specs/2026-05-27-reasoning-effort-and-model-naming-design.md`. **Depends on Plan B** — specifically Plan B's `PROMOTABLE_BUILTINS` registry-merge mechanism, the baked-builtin `baseName`/display-name convention, and the alias table (which already seeds `xiaomi`/`mi-mo`→`mimo`). Execute this plan only after Plan B is merged. MiMo is in the same capability class as GLM (`http_thinking_toggle`: top-level `thinking:{type:enabled/disabled}`, no graded effort, reasoning returned in `reasoning_content`), so it inherits the existing GLM token-floor that prevents the empty-response (`BUDGET`) failure. The one MiMo-specific wire quirk is that it expects `max_completion_tokens` instead of `max_tokens`; we add a per-model boolean that the http client honors when emitting the cap.

**Tech Stack:** Node.js ESM (`.mjs`), `node --test` (spec reporter). No new dependencies.

**Verified provider facts (spec §2, §7):** MiMo `mimo-v2.5-pro`, OpenAI-compatible base `https://token-plan-sgp.xiaomimimo.com/v1` (or `https://api.xiaomimimo.com/v1`); capability `http_thinking_toggle`; reasoning in `reasoning_content` (already parsed by the http client); expects `max_completion_tokens`; multi-turn tool-call `reasoning_content` echo is N/A for single-shot review/consult.

**Test runner:** `node --test --test-reporter=spec tests/<file>.test.mjs`. Full suite: `node --test --test-reporter=spec tests/*.test.mjs`.

**Secret-scanner caveat:** the registry/file scanner and outbound scanner reject secret-shaped strings. In tests use short fake apiKey values (e.g. `"mimo"`); env-var *names* like `XIAOMIMIMO_API_KEY` are fine as identifiers.

---

## Existing-code orientation (read before starting)

- `scripts/lib/models.mjs` — `MODEL_INFO` (Plan B added claude/codex/gemini/kimi here), `PROMOTABLE_BUILTINS` set (Plan B), `loadModelRegistry` merge-for-promotable logic, `CAPABILITY` import.
- `scripts/lib/reasoning.mjs` — `CAPABILITY.GLM_TOGGLE === "http_thinking_toggle"`.
- `scripts/lib/config.mjs` — `resolveModelMaxTokens(env, key, prefix, serverMaxTokens, info)`: already applies an 8192/4096 floor when `info.reasoning === CAPABILITY.GLM_TOGGLE` and no explicit cap is set (the `isGlmToggle` branch). MiMo gets this floor for free once its capability is `GLM_TOGGLE`. `loadHttpModelConfig` builds the per-model http config (this is where the `usesMaxCompletionTokens` flag must be threaded onto the frozen config).
- `scripts/lib/client.mjs` — `streamChatCompletion`: builds `body`, sets `body.max_tokens = maxTokens` when defined (around line 59-60). This is the single place the token cap is emitted for the http transport.

When a step cites a line number, match the surrounding code, not the literal line (Plan B shifted lines).

---

## File Structure

- **Modify** `scripts/lib/models.mjs` — add the `mimo` entry to `MODEL_INFO`; add `mimo` to `PROMOTABLE_BUILTINS`.
- **Modify** `scripts/lib/config.mjs` — thread a `usesMaxCompletionTokens` boolean from `info` onto the loaded http model config (configured + unconfigured branches).
- **Modify** `scripts/lib/client.mjs` — emit `max_completion_tokens` instead of `max_tokens` when the model config sets `usesMaxCompletionTokens`.
- **Modify** `README.md` / `CHANGELOG.md` — document MiMo as a builtin + the `max_completion_tokens` note.
- **Test files (extend):** `tests/config.test.mjs` (mimo registry + floor + flag), `tests/client.test.mjs` (body emits `max_completion_tokens`).

---

## Task 1: Add `mimo` to MODEL_INFO + PROMOTABLE_BUILTINS

**Files:**
- Modify: `scripts/lib/models.mjs`
- Test: extend `tests/config.test.mjs`

Baked entry (mirrors the operator's working env-custom mimo config, per spec §3/§7):

```javascript
mimo: Object.freeze({
  key: "mimo",
  baseName: "mimo-v2.5-pro",
  transport: "http",
  defaultModel: "mimo-v2.5-pro",
  defaultBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
  // Recognize the existing XIAOMIMIMO_* env names as aliases, mirroring glm's
  // ZHIPU_API_KEY/GLM_API_KEY fallbacks.
  apiKeyEnv: ["MULTIPOLY_MIMO_API_KEY", "XIAOMIMIMO_API_KEY"],
  supportsThinking: true,           // top-level thinking toggle, same class as glm
  reasoning: CAPABILITY.GLM_TOGGLE, // "http_thinking_toggle"
  defaultEffort: "high",
  usesMaxCompletionTokens: true,    // MiMo expects max_completion_tokens, not max_tokens
}),
```

And add `mimo` to the `PROMOTABLE_BUILTINS` set introduced in Plan B:
```javascript
const PROMOTABLE_BUILTINS = new Set(["claude", "codex", "gemini", "kimi", "mimo"]);
```

- [ ] **Step 1: Write the failing test** (add to `tests/config.test.mjs`)

```javascript
import { MODEL_INFO, loadModelRegistry } from "../scripts/lib/models.mjs";

test("mimo is a baked MODEL_INFO builtin with http_thinking_toggle capability", () => {
  assert.ok(MODEL_INFO.mimo);
  assert.equal(MODEL_INFO.mimo.reasoning, "http_thinking_toggle");
  assert.equal(MODEL_INFO.mimo.usesMaxCompletionTokens, true);
  assert.equal(MODEL_INFO.mimo.baseName, "mimo-v2.5-pro");
});

test("MULTIPOLY_MODELS=mimo merges baked base and recognizes XIAOMIMIMO_API_KEY", () => {
  const { keys, info } = loadModelRegistry({ MULTIPOLY_MODELS: "mimo" });
  assert.ok(keys.includes("mimo"));
  assert.equal(info.mimo.reasoning, "http_thinking_toggle");
  assert.equal(info.mimo.displayName, "mimo-v2.5-pro (api)"); // convention from Plan B
  assert.deepEqual([...info.mimo.apiKeyEnv], ["MULTIPOLY_MIMO_API_KEY", "XIAOMIMIMO_API_KEY"]);
});
```

> **Plan B precondition (already satisfied):** Plan B's `loadModelRegistry` merge copies `apiKeyEnv` and (after the review fix) `usesMaxCompletionTokens` onto the registry `info` entry for promotable builtins, and sets `reasoning` from the baked entry. So `info.mimo.{apiKeyEnv,reasoning,usesMaxCompletionTokens}` resolve correctly. If you are building Plan C against a Plan B that predates that fix, add `...(baked?.usesMaxCompletionTokens ? { usesMaxCompletionTokens: true } : {})` to the merge `base` in `loadModelRegistry`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-reporter=spec tests/config.test.mjs`
Expected: FAIL — `MODEL_INFO.mimo` undefined.

- [ ] **Step 3: Implement** — add the `mimo` entry to `MODEL_INFO` and `mimo` to `PROMOTABLE_BUILTINS`.

- [ ] **Step 4: Run to verify pass + full suite.**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/models.mjs tests/config.test.mjs
git commit -m "feat: add Xiaomi MiMo as a baked http_thinking_toggle builtin"
```

---

## Task 2: Thread `usesMaxCompletionTokens` onto the loaded http config

**Files:**
- Modify: `scripts/lib/config.mjs` (`loadHttpModelConfig`)
- Test: extend `tests/config.test.mjs`

`loadHttpModelConfig` builds the frozen per-model config from `info`. Add `usesMaxCompletionTokens: Boolean(info.usesMaxCompletionTokens)` to BOTH the configured and unconfigured return objects (so the client can read it regardless). Keep it out of the anthropic/cli loaders — it's an OpenAI-compat-only concern.

> **Plan B merge dependency (satisfied):** the registry `info` entry for a promotable builtin carries `usesMaxCompletionTokens` because Plan B's merge copies it. `loadHttpModelConfig` receives the MERGED entry (`registry.info[key]`, not `MODEL_INFO.mimo`), so reading `info.usesMaxCompletionTokens` here works. (If building against a pre-fix Plan B, add the copy line to Plan B's loader first — see Task 1's precondition note.)

- [ ] **Step 1: Write the failing test**

```javascript
import { loadConfig } from "../scripts/lib/config.mjs";

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
```

- [ ] **Step 2: Run to verify failure** — `usesMaxCompletionTokens` undefined on the config.

- [ ] **Step 3: Implement** in `loadHttpModelConfig` — add `usesMaxCompletionTokens: Boolean(info.usesMaxCompletionTokens)` to the shared fields (alongside `supportsThinking`) in both the configured and unconfigured frozen returns.

- [ ] **Step 4: Run to verify pass + full suite.**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/config.mjs tests/config.test.mjs
git commit -m "feat: thread usesMaxCompletionTokens onto loaded http model config"
```

---

## Task 3: Emit `max_completion_tokens` in the http client when flagged

**Files:**
- Modify: `scripts/lib/client.mjs` (`streamChatCompletion` body build)
- Test: extend `tests/client.test.mjs`

Replace the unconditional `body.max_tokens = maxTokens` with a switch on the model config flag.

- [ ] **Step 1: Write the failing test** — use `tests/client.test.mjs`'s EXISTING harness. That file defines `makeFetch({...})` which returns a fetch fn with a `.calls` array; the sent body is read via `JSON.parse(fetchImpl.calls[0].opts.body)`. Configs are hand-built inline objects (NOT `loadConfig`). Mirror the qwen `max_tokens` tests in that file (≈lines 80-163) as your template.

```javascript
// tests/client.test.mjs (extend) — reuses the file's makeFetch + inline-config style.
test("mimo emits max_completion_tokens, not max_tokens", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: {
      ...baseConfig,
      models: {
        mimo: {
          configured: true,
          key: "mimo",
          displayName: "mimo-v2.5-pro (api)",
          baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
          apiKey: "mimo",
          model: "mimo-v2.5-pro",
          supportsThinking: true,
          reasoning: CAPABILITY.GLM_TOGGLE,
          reasoningEffort: "high",
          usesMaxCompletionTokens: true,
          maxTokens: { review: 8192, consult: 4096 },
        },
      },
    },
    modelKey: "mimo",
    messages: [{ role: "user", content: "hi" }],
    mode: "review",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.max_completion_tokens, 8192);
  assert.equal(sent.max_tokens, undefined);
});

test("glm still emits max_tokens, not max_completion_tokens", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: baseConfig, // baseConfig's glm has no usesMaxCompletionTokens
    modelKey: "glm",
    messages: [{ role: "user", content: "hi" }],
    mode: "review",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.max_tokens, 8192);
  assert.equal(sent.max_completion_tokens, undefined);
});
```

> `baseConfig` and `CAPABILITY` are already imported/defined at the top of `tests/client.test.mjs`. Don't invent a new harness — extend this file.

- [ ] **Step 2: Run to verify failure** — body has `max_tokens`, not `max_completion_tokens`.

- [ ] **Step 3: Implement** — in `streamChatCompletion`, change:

```javascript
const maxTokens = resolveMaxTokensForModel(config, effectiveModelKey, mode);
if (maxTokens !== undefined) {
  if (modelConfig.usesMaxCompletionTokens) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
}
```

> NOTE: the `reasoning_effort_unsupported` retry path (`if ("reasoning_effort" in body)`) is unaffected; QWEN_BUDGET's `effortToQwenFields` and the GLM toggle still merge onto the body root as before. MiMo is `GLM_TOGGLE`, so only `thinking:{type}` is added — no `reasoning_effort` field — and the budget floor (Task in Plan-A/config) governs depth.

- [ ] **Step 4: Run to verify pass + full suite.**

Run: `node --test --test-reporter=spec tests/client.test.mjs && node --test --test-reporter=spec tests/*.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/client.mjs tests/client.test.mjs
git commit -m "feat: emit max_completion_tokens for models that require it (MiMo)"
```

---

## Task 4: Regression test — MiMo inherits the GLM token floor

**Files:**
- Test: extend `tests/config.test.mjs`

`resolveModelMaxTokens` already applies the 8192/4096 floor for any `info.reasoning === CAPABILITY.GLM_TOGGLE` when no explicit cap is set. MiMo now qualifies. Lock this with a regression test so the empty-response (`BUDGET`) failure mode can't reappear for MiMo via a config regression.

- [ ] **Step 1: Write the test**

```javascript
test("mimo gets the http_thinking_toggle max_tokens floor by default (no empty-BUDGET regression)", () => {
  const config = loadConfig({ MULTIPOLY_MODELS: "mimo", MULTIPOLY_MIMO_API_KEY: "mimo" });
  assert.equal(config.models.mimo.maxTokens.review, 8192);
  assert.equal(config.models.mimo.maxTokens.consult, 4096);
});

test("an explicit MULTIPOLY_MIMO_MAX_TOKENS_REVIEW overrides the floor", () => {
  const config = loadConfig({
    MULTIPOLY_MODELS: "mimo", MULTIPOLY_MIMO_API_KEY: "mimo",
    MULTIPOLY_MIMO_MAX_TOKENS_REVIEW: "20000",
  });
  assert.equal(config.models.mimo.maxTokens.review, 20000);
});
```

- [ ] **Step 2: Run** — these should PASS immediately if Tasks 1-2 are correct (the floor is pre-existing). If the first fails because `resolveModelMaxTokens`'s default-value branch hard-codes `key === "glm"` in a way that breaks the floor for mimo, generalize that branch to `info?.reasoning === CAPABILITY.GLM_TOGGLE` and re-run.

> Read `resolveModelMaxTokens` carefully: the floor branch uses `isGlmToggle = info?.reasoning === CAPABILITY.GLM_TOGGLE`, so it should already cover mimo. The `key === "glm"` appears only in the pre-floor default-value computation, which the `Math.max(review ?? 0, 8192)` floor overrides anyway. Confirm with the test; only touch the code if the test demands it.

- [ ] **Step 3: Commit**

```bash
git add tests/config.test.mjs scripts/lib/config.mjs
git commit -m "test: lock MiMo's default max_tokens floor (BUDGET-regression guard)"
```

---

## Task 5: Docs — MiMo builtin + max_completion_tokens

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1** — README: list `mimo` (`mimo-v2.5-pro (api)`) among the builtins; note it recognizes `XIAOMIMIMO_API_KEY`, reasons by default via the top-level thinking toggle (same class as GLM, no graded effort — `off` disables, any other effort enables), gets the 8192/4096 token floor, and uses `max_completion_tokens` on the wire. Note the operator can now drop the redundant per-deployment `MULTIPOLY_MIMO_DISPLAY_NAME`/`_REASONING`/`_BASE_URL`/`_MODEL` env (baked) and need only opt in via `MULTIPOLY_MODELS=…,mimo` + a key.
- [ ] **Step 2** — CHANGELOG: entry for Plan C (MiMo promoted to builtin; `max_completion_tokens` per-model switch).
- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: MiMo first-class builtin + max_completion_tokens"
```

---

## Final verification (after all tasks)

- [ ] Full suite green: `node --test --test-reporter=spec tests/*.test.mjs`.
- [ ] Health check: `MULTIPOLY_MODELS=mimo MULTIPOLY_MIMO_API_KEY=x MULTIPOLY_GLM_API_KEY=y node scripts/multipoly-mcp.mjs --health` → `status: ok`, `mimo` configured, `displayName: "mimo-v2.5-pro (api)"`, `maxTokens.review: 8192`.
- [ ] Dispatch the final code-reviewer subagent for the whole branch, then use superpowers:finishing-a-development-branch.
- [ ] **Operator note (not a code task):** after merge, the operator's `~/.claude.json` can be simplified — `mimo` only needs `MULTIPOLY_MODELS=…,mimo` and a key; the `_DISPLAY_NAME`/`_REASONING`/`_BASE_URL`/`_MODEL`/`_TRANSPORT` entries become redundant (baked). Leave their explicit `MULTIPOLY_MIMO_MAX_TOKENS_REVIEW` if they tuned it.
```
