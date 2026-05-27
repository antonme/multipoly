# Reasoning-Effort Core — Implementation Plan (Plan A of 3) — v2

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every model a graded reasoning-effort knob (`off|low|medium|high|xhigh`, default per-model) that maps onto each backend's verified native mechanism, settable per-call > per-model env > server env > baked default.

**Architecture:** A new pure module `scripts/lib/reasoning.mjs` owns the scale, the precedence resolver, the per-model capability descriptor, and the per-capability adapter functions. `config.mjs` resolves the *baseline* effort + capability per model at load; a per-call `reasoning_effort` tool argument is threaded through the orchestrators to the transports, where the matching adapter builds the request fields. No live capability probing — capability is static per model.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert/strict` (run: `node --test --test-reporter=spec tests/*.test.mjs`). No new deps. `client.mjs` is raw `fetch`+`JSON.stringify` (no OpenAI SDK), so any provider field must be a literal top-level body key — there is NO `extra_body` flattening.

**Spec:** `docs/superpowers/specs/2026-05-27-reasoning-effort-and-model-naming-design.md` (§1, §2, §6).

**Scope:** No model naming, `opus`→`claude` fold, alias resolution, or MiMo-as-builtin (Plans B/C). `mimo` and `kimi` are reached as custom models in the current deployment; this plan only assigns/uses their capability.

**v2 changes (from a 9-model review of v1, verified against the code):** added the per-call plumbing task (Task 7) before transport wiring; fixed `thinkingToEffort` to accept all `parseThinking` synonyms; flatten provider fields into the body root (no `extra_body`); removed dead clamp code; split `modelHasReasoningControl` from `modelSupportsThinking`; corrected `FILE_ENTRY_FIELDS`; clamp codex `xhigh→high`; gemini `off→minimal`; floor never overrides an explicit max_tokens; per-key tool-schema clones + `allowedKeys`; retire mode-default explicitly.

---

## File Structure

- **Create** `scripts/lib/reasoning.mjs` — scale, `normalizeEffort`, `EFFORT_ORDER`, `thinkingToEffort`, `resolveReasoningEffort`, `CAPABILITY`, adapters (`effortToGlmThinking`, `effortToQwenFields`, `effortToOpenAiFields`, `effortToAnthropicEffort`, `effortToAnthropicBudget`, `effortToKimiThinking`, `effortToCliReasoningArgs`). Pure; imports only `errors.mjs`.
- **Create** `tests/reasoning.test.mjs`.
- **Modify** `scripts/lib/models.mjs` — `reasoning`/`reasoningVocab`/`defaultEffort` on `MODEL_INFO`+`OPUS_INFO`; capability-by-transport default for custom/file models (`fileEntryToInfo`); add `modelCapability` + `modelHasReasoningControl`; keep `modelSupportsThinking` = "sends a top-level `thinking` toggle" (glm/mimo/kimi-anthropic only); extend `FILE_ENTRY_FIELDS`.
- **Modify** `scripts/lib/config.mjs` — resolve per-model baseline `reasoningEffort`; GLM/MiMo `max_tokens` floor that respects the existing `explicit` flag; retire `mode-default`.
- **Modify** `scripts/lib/run-model.mjs`, `scripts/lib/model-review.mjs`, `scripts/lib/model-consult.mjs`, `scripts/lib/council.mjs` — thread a per-call `reasoningEffort` from tool input to `runModel`/transports.
- **Modify** `scripts/lib/client.mjs` — capability-dispatch the http reasoning fields onto the body root.
- **Modify** `scripts/lib/transport/anthropic.mjs` — capability branch; strip `temperature`/`top_p`/`top_k` whenever thinking is active.
- **Modify** `scripts/lib/transport/cli.mjs` — per-agent reasoning args via the adapter; resolve effective effort in `runCliModel`.
- **Modify** `scripts/multipoly-mcp.mjs` — per-key tool-schema clones with optional `reasoning_effort` (omitted for `NONE`); add to `allowedKeys`; pass capability via `registryFromConfig`; thread per-call value.

---

### Task 1: Scale + normalization

**Files:** Create `scripts/lib/reasoning.mjs`; Test `tests/reasoning.test.mjs`

- [ ] **Step 1: Failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFORT_LEVELS, EFFORT_ORDER, normalizeEffort } from "../scripts/lib/reasoning.mjs";

test("reasoning: levels + ordering", () => {
  assert.deepEqual(EFFORT_LEVELS, ["off", "low", "medium", "high", "xhigh"]);
  assert.ok(EFFORT_ORDER.high > EFFORT_ORDER.low);
});
test("reasoning: normalizeEffort", () => {
  assert.equal(normalizeEffort("HIGH"), "high");
  assert.equal(normalizeEffort("  off "), "off");
  assert.equal(normalizeEffort("inherit"), "inherit");
  assert.equal(normalizeEffort(""), "inherit");
  assert.equal(normalizeEffort(undefined), "inherit");
  assert.throws(() => normalizeEffort("turbo"), (e) => e.code === "CONFIG");
});
```

- [ ] **Step 2: Run → FAIL** (module missing).
- [ ] **Step 3: Implement**

```js
// scripts/lib/reasoning.mjs
import { MultipolyError } from "./errors.mjs";

export const EFFORT_LEVELS = Object.freeze(["off", "low", "medium", "high", "xhigh"]);
export const EFFORT_ORDER = Object.freeze(Object.fromEntries(EFFORT_LEVELS.map((l, i) => [l, i])));

export function normalizeEffort(raw) {
  if (raw === undefined || raw === null) return "inherit";
  const v = String(raw).trim().toLowerCase();
  if (v === "" || v === "inherit") return "inherit";
  if (EFFORT_LEVELS.includes(v)) return v;
  throw new MultipolyError("CONFIG", `reasoning effort must be one of ${EFFORT_LEVELS.join("|")}|inherit, got ${JSON.stringify(raw)}`);
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(reasoning): effort scale + normalizeEffort`.

---

### Task 2: Legacy `thinking` → effort (accept ALL `parseThinking` synonyms)

**Files:** Modify `scripts/lib/reasoning.mjs`; Test `tests/reasoning.test.mjs`

> `config.mjs:parseThinking` accepts `on|1|true|yes` / `off|0|false|no` / `auto`. `thinkingToEffort` MUST accept the same set or a live server with `MULTIPOLY_THINKING=1` crashes.

- [ ] **Step 1: Failing test**

```js
import { thinkingToEffort } from "../scripts/lib/reasoning.mjs";
test("reasoning: legacy thinking → effort (all synonyms)", () => {
  for (const on of ["on", "1", "true", "yes", "ON"]) assert.equal(thinkingToEffort(on), "medium");
  for (const off of ["off", "0", "false", "no"]) assert.equal(thinkingToEffort(off), "off");
  assert.equal(thinkingToEffort("auto"), "inherit");
  assert.equal(thinkingToEffort(undefined), "inherit");
  assert.equal(thinkingToEffort(""), "inherit");
  assert.throws(() => thinkingToEffort("maybe"), (e) => e.code === "CONFIG");
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```js
const THINK_ON = new Set(["on", "1", "true", "yes"]);
const THINK_OFF = new Set(["off", "0", "false", "no"]);
export function thinkingToEffort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return "inherit";
  const v = String(raw).trim().toLowerCase();
  if (v === "auto") return "inherit";
  if (THINK_ON.has(v)) return "medium";
  if (THINK_OFF.has(v)) return "off";
  throw new MultipolyError("CONFIG", `thinking must be on|off|auto (or 1/0/true/false/yes/no), got ${JSON.stringify(raw)}`);
}
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(reasoning): legacy thinking→effort with synonyms`.

---

### Task 3: `resolveReasoningEffort` precedence (normalize every layer)

**Files:** Modify `scripts/lib/reasoning.mjs`; Test `tests/reasoning.test.mjs`

- [ ] **Step 1: Failing test**

```js
import { resolveReasoningEffort } from "../scripts/lib/reasoning.mjs";
const L = (o) => ({ perCall: undefined, modelEffort: "inherit", modelThinking: "inherit", serverEffort: "inherit", serverThinking: "inherit", bakedDefault: "high", ...o });
test("resolve: per-call wins", () => assert.equal(resolveReasoningEffort(L({ perCall: "low", modelEffort: "xhigh" })), "low"));
test("resolve: per-model effort > server effort", () => assert.equal(resolveReasoningEffort(L({ modelEffort: "medium", serverEffort: "high" })), "medium"));
test("resolve: per-model effort > per-model thinking", () => assert.equal(resolveReasoningEffort(L({ modelEffort: "low", modelThinking: "off" })), "low"));
test("resolve: server effort > server thinking", () => assert.equal(resolveReasoningEffort(L({ serverEffort: "low", serverThinking: "off" })), "low"));
test("resolve: all inherit → default", () => assert.equal(resolveReasoningEffort(L({})), "high"));
test("resolve: per-call 'inherit' string falls through", () => assert.equal(resolveReasoningEffort(L({ perCall: "inherit", modelEffort: "low" })), "low"));
test("resolve: bad default throws", () => assert.throws(() => resolveReasoningEffort(L({ bakedDefault: "inherit" }))));
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — normalize each layer (so a raw per-call string, or any caller-supplied value, is validated here; callers may pass already-normalized values, `normalizeEffort` is idempotent):

```js
export function resolveReasoningEffort({ perCall, modelEffort, modelThinking, serverEffort, serverThinking, bakedDefault }) {
  const chain = [perCall, modelEffort, modelThinking, serverEffort, serverThinking].map(normalizeEffort);
  for (const lvl of chain) if (lvl !== "inherit") return lvl;
  if (!EFFORT_LEVELS.includes(bakedDefault)) {
    throw new MultipolyError("INTERNAL", `baked default effort must be a concrete level, got ${JSON.stringify(bakedDefault)}`);
  }
  return bakedDefault;
}
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(reasoning): precedence resolver`.

---

### Task 4: Capability constants + adapters

**Files:** Modify `scripts/lib/reasoning.mjs`; Test `tests/reasoning.test.mjs`

Adapters return a flat object of body keys to merge (or `null` to add nothing). All keys are top-level (no `extra_body`).

- [ ] **Step 1: Failing tests**

```js
import { CAPABILITY, effortToGlmThinking, effortToOpenAiFields, effortToAnthropicEffort,
  effortToAnthropicBudget, effortToKimiThinking, effortToQwenFields, effortToCliReasoningArgs } from "../scripts/lib/reasoning.mjs";

test("glm toggle", () => {
  assert.deepEqual(effortToGlmThinking("off"), { thinking: { type: "disabled" } });
  assert.deepEqual(effortToGlmThinking("high"), { thinking: { type: "enabled" } });
});
test("kimi toggle: never budget_tokens", () => {
  assert.deepEqual(effortToKimiThinking("high"), { thinking: { type: "enabled" } });
  assert.equal("budget_tokens" in (effortToKimiThinking("high").thinking), false);
});
test("openai fields: deepseek high/max, gemini none..high, off varies", () => {
  assert.equal(effortToOpenAiFields("xhigh", { vocab: "deepseek" }).reasoning_effort, "max");
  assert.equal(effortToOpenAiFields("low", { vocab: "deepseek" }).reasoning_effort, "high");
  assert.deepEqual(effortToOpenAiFields("off", { vocab: "deepseek" }), { thinking: { type: "disabled" } }); // flattened, top-level
  assert.equal(effortToOpenAiFields("medium", { vocab: "gemini" }).reasoning_effort, "medium");
  assert.equal(effortToOpenAiFields("xhigh", { vocab: "gemini" }).reasoning_effort, "high");
  assert.equal(effortToOpenAiFields("off", { vocab: "gemini" }).reasoning_effort, "minimal"); // Gemini-3 can't fully disable (spec §2)
});
test("qwen fields: enable_thinking always true (thinking-only), budget scales", () => {
  const off = effortToQwenFields("off", { maxTokens: 20000 });
  assert.equal(off.enable_thinking, true);
  assert.ok(effortToQwenFields("high", { maxTokens: 20000 }).thinking_budget > off.thinking_budget);
});
test("anthropic effort (Opus 4.7)", () => {
  assert.equal(effortToAnthropicEffort("off"), null);
  assert.deepEqual(effortToAnthropicEffort("xhigh"), { thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } });
});
test("anthropic budget (legacy): clamp + skip", () => {
  assert.equal(effortToAnthropicBudget("high", { maxTokens: 1200 }), null); // no room
  const r = effortToAnthropicBudget("high", { maxTokens: 20000 });
  assert.ok(r.thinking.budget_tokens >= 1024 && r.thinking.budget_tokens < 20000);
});
test("cli args: codex clamps xhigh→high, off→none, other kinds →[]", () => {
  assert.deepEqual(effortToCliReasoningArgs("codex", "high"), ["-c", 'model_reasoning_effort="high"']);
  assert.deepEqual(effortToCliReasoningArgs("codex", "xhigh"), ["-c", 'model_reasoning_effort="high"']);
  assert.deepEqual(effortToCliReasoningArgs("codex", "off"), []);
  assert.deepEqual(effortToCliReasoningArgs("agy", "high"), []);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```js
export const CAPABILITY = Object.freeze({
  NONE: "none", GLM_TOGGLE: "http_thinking_toggle", QWEN_BUDGET: "qwen_budget",
  OPENAI_EFFORT: "openai_effort", ANTHROPIC_EFFORT: "anthropic_effort",
  ANTHROPIC_BUDGET: "anthropic_budget", KIMI_TOGGLE: "kimi_toggle",
});
const MIN_THINKING_BUDGET = 1024, MIN_OUTPUT_RESERVE = 1024;
const BUDGET_FRACTION = Object.freeze({ low: 0.25, medium: 0.4, high: 0.6, xhigh: 0.8 });

export function effortToGlmThinking(e) { return { thinking: { type: e === "off" ? "disabled" : "enabled" } }; }
export function effortToKimiThinking(e) { return { thinking: { type: e === "off" ? "disabled" : "enabled" } }; }

export function effortToOpenAiFields(e, { vocab }) {
  if (e === "off") {
    if (vocab === "deepseek") return { thinking: { type: "disabled" } }; // top-level (raw fetch)
    return { reasoning_effort: "minimal" }; // gemini etc. cannot fully disable
  }
  if (vocab === "deepseek") return { reasoning_effort: e === "xhigh" ? "max" : "high" };
  return { reasoning_effort: e === "xhigh" ? "high" : e }; // gemini/generic top at high
}

export function effortToAnthropicEffort(e) {
  return e === "off" ? null : { thinking: { type: "adaptive" }, output_config: { effort: e } };
}

export function effortToAnthropicBudget(e, { maxTokens }) {
  if (e === "off" || maxTokens === undefined) return null;
  if (maxTokens < MIN_THINKING_BUDGET + MIN_OUTPUT_RESERVE) return null;
  const raw = Math.round(BUDGET_FRACTION[e] * maxTokens);
  const budget = Math.min(Math.max(raw, MIN_THINKING_BUDGET), maxTokens - MIN_OUTPUT_RESERVE);
  return { thinking: { type: "enabled", budget_tokens: budget } };
}

export function effortToQwenFields(e, { maxTokens }) {
  const cap = maxTokens ?? 16384;
  const frac = e === "off" ? 0.1 : BUDGET_FRACTION[e];
  return { enable_thinking: true, thinking_budget: Math.max(256, Math.round(frac * cap)) };
}

const CODEX_EFFORTS = new Set(["low", "medium", "high"]);
export function effortToCliReasoningArgs(kind, e) {
  if (e === "off") return [];
  if (kind === "codex") { const v = CODEX_EFFORTS.has(e) ? e : "high"; return ["-c", `model_reasoning_effort="${v}"`]; }
  return []; // claude/gemini/cursor/agy: verify real flag before wiring (Task 10 note)
}
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(reasoning): per-capability adapters`.

> **Worker note:** the qwen/openai adapters return flattened top-level keys because `client.mjs` posts a raw JSON body (no SDK `extra_body`). Verify each provider accepts the field at the body root when you wire Task 8.

---

### Task 5: Capability + defaults on `MODEL_INFO`; split `modelHasReasoningControl`

**Files:** Modify `scripts/lib/models.mjs`; Test `tests/transport-config.test.mjs`

- [ ] **Step 1: Failing test**

```js
import { MODEL_INFO, modelCapability, modelHasReasoningControl, modelSupportsThinking } from "../scripts/lib/models.mjs";
import { CAPABILITY } from "../scripts/lib/reasoning.mjs";
test("models: capability + default effort", () => {
  assert.equal(MODEL_INFO.glm.reasoning, CAPABILITY.GLM_TOGGLE);
  assert.equal(MODEL_INFO.deepseek.reasoning, CAPABILITY.OPENAI_EFFORT);
  assert.equal(MODEL_INFO.deepseek.reasoningVocab, "deepseek");
  assert.equal(MODEL_INFO.glm.defaultEffort, "high");
  // modelSupportsThinking stays "sends a top-level thinking toggle" (NOT deepseek/qwen)
  const c = { models: { glm: MODEL_INFO.glm, deepseek: MODEL_INFO.deepseek } };
  assert.equal(modelSupportsThinking(c, "glm"), true);
  assert.equal(modelSupportsThinking(c, "deepseek"), false);
  assert.equal(modelHasReasoningControl(c, "deepseek"), true);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
  - Add to each `MODEL_INFO` entry + `OPUS_INFO`: `glm`→`{reasoning: GLM_TOGGLE, defaultEffort:"high"}`; `qwen`→`{reasoning: QWEN_BUDGET, defaultEffort:"high"}`; `deepseek`→`{reasoning: OPENAI_EFFORT, reasoningVocab:"deepseek", defaultEffort:"high"}`; `composer`→`{reasoning: NONE, defaultEffort:"off"}`; `OPUS_INFO`→`{reasoning: ANTHROPIC_EFFORT, defaultEffort:"xhigh"}`.
  - `modelCapability(config,key)` = config model `.reasoning` ?? `MODEL_INFO[key]?.reasoning` ?? `NONE`.
  - `modelHasReasoningControl(config,key)` = `modelCapability(...) !== NONE`.
  - Keep `modelSupportsThinking` = capability is one of `{GLM_TOGGLE, KIMI_TOGGLE, ANTHROPIC_BUDGET}` (the "top-level/native `thinking` field" set) — preserves current GLM behavior; deepseek/qwen are `false` (they don't take a bare `thinking` toggle).
  - `fileEntryToInfo` (custom/env models): default `reasoning` from transport + a `MULTIPOLY_<K>_REASONING` override — `http`→infer from a `MULTIPOLY_<K>_REASONING_VOCAB` (`deepseek|gemini|glm|qwen`) else `NONE`; `anthropic`→`ANTHROPIC_EFFORT` (or `KIMI_TOGGLE` if `MULTIPOLY_<K>_REASONING=kimi_toggle`); `cli`→handled by cli kind. Default `defaultEffort` for custom models = `"off"` unless `MULTIPOLY_<K>_REASONING_EFFORT`/`_THINKING` set.
  - Extend `FILE_ENTRY_FIELDS` (models.mjs:235; already has `reasoningEffort`) with `reasoning`, `reasoningVocab`, `defaultEffort`.

- [ ] **Step 4: Run → PASS** (full suite green; old `modelSupportsThinking` callers in client.mjs/budget.mjs unaffected because GLM stays `true`).
- [ ] **Step 5: Commit** `feat(models): static capability, defaults, modelHasReasoningControl`.

---

### Task 6: Resolve baseline effort in `config.mjs`; floor respects explicit; retire mode-default

**Files:** Modify `scripts/lib/config.mjs`; Test `tests/transport-config.test.mjs`

- [ ] **Step 1: Failing tests**

```js
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
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
  - In each per-model loader compute `reasoningEffort` = `resolveReasoningEffort({ perCall: undefined, modelEffort: env[\`${prefix}_REASONING_EFFORT\`], modelThinking: thinkingToEffort(env[\`${prefix}_THINKING\`] ?? (key==="glm" ? env.GLM_THINKING : undefined)), serverEffort: env.MULTIPOLY_REASONING_EFFORT, serverThinking: thinkingToEffort(env.MULTIPOLY_THINKING), bakedDefault: info.defaultEffort ?? "off" })`. Note: `GLM_THINKING` is consumed ONLY in glm's `modelThinking`, never the server layer. Copy `reasoning`/`reasoningVocab` onto the model config.
  - In `resolveModelMaxTokens`: when `modelCapability` is `GLM_TOGGLE` (covers glm and, in Plan C, mimo) and the value is NOT explicit (reuse the `serverMaxTokens.explicit` flags + the per-model `env[\`${prefix}_MAX_TOKENS_*\`]` presence check already used at config.mjs:138-143), apply `review = max(value ?? 0, 8192)`, `consult = max(value ?? 0, 4096)`.
  - **Retire mode-default:** the per-model baseline effort now fully determines reasoning; `resolveThinkingPreference`'s `review→on / consult→off` asymmetry is removed (consult honors the same `defaultEffort`). Update/replace the `mode-default` test in models.test/transport tests to assert the new behavior and add a CHANGELOG note (Task 12).

- [ ] **Step 4: Run → PASS** (full suite green).
- [ ] **Step 5: Commit** `feat(config): per-model reasoning baseline + GLM floor; retire mode-default`.

---

### Task 7: Thread per-call `reasoningEffort` through the orchestrators (the seam)

**Files:** Modify `scripts/lib/run-model.mjs`, `model-review.mjs`, `model-consult.mjs`, `council.mjs`; Test a new `tests/effort-threading.test.mjs` with a stub transport.

> Without this, Tasks 8-11 can't actually receive a per-call override. `runPrepared*` currently forward only `{messages, timeoutMs}`; the tool `input` is dropped (verified: model-review.mjs:65,90; model-consult.mjs:40; council.mjs:135-138).

- [ ] **Step 1: Failing test** — inject a stub `runModel` (or stub transport) and assert the resolved effort reaches it:

```js
// Build a config with glm; call the review path with input.reasoning_effort = "low";
// assert the stubbed transport received effort "low" (per-call beats glm's "high" default).
// Second case: omit reasoning_effort → transport receives "high" (baseline).
// Third case: council with [glm(high default), composer(NONE)] + per-call "low" →
//   glm member gets "low", composer member ignores it (NONE).
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
  - Add an optional `reasoningEffort` (normalized, may be `"inherit"`/`undefined`) parameter to `runModel` and pass it to the transport call (http/anthropic/cli).
  - In `prepareReview`/`prepareConsult` capture `input.reasoning_effort` (validate via `normalizeEffort`) onto `prepared.reasoningEffort`; `runPreparedReview` (both attempt1 and the retry attempt2) and `runPreparedConsult` forward it to `runModel`.
  - The transport resolves the effective effort: `resolveReasoningEffort({ perCall: prepared.reasoningEffort, modelEffort: modelConfig.reasoningEffort, bakedDefault: modelConfig.reasoningEffort })` — i.e. per-call overrides the config baseline; baseline is already fully resolved so it doubles as both layers and default.
  - `runCouncilMembers` forwards the single per-call effort to each member's `runPrepared`; each member resolves through its own capability adapter.

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat: thread per-call reasoning_effort to transports`.

---

### Task 8: Wire http transport (`client.mjs`)

**Files:** Modify `scripts/lib/client.mjs:49-58`; Test `tests/client.test.mjs` (assert the serialized `fetchImpl` body — existing pattern; no body-builder extraction needed).

- [ ] **Step 1: Failing tests** — drive `streamChatCompletion` with a stub `fetchImpl`, assert `JSON.parse(fetchImpl.calls[0].body)`:
  - glm + `off` → `body.thinking == {type:"disabled"}`.
  - deepseek + `xhigh` → `body.reasoning_effort == "max"`; deepseek + `off` → `body.thinking == {type:"disabled"}`, no `reasoning_effort`.
  - qwen + `high` → `body.enable_thinking === true`, `body.thinking_budget > 0` (top-level, NOT under extra_body).
  - gemini + `off` → `body.reasoning_effort == "minimal"`.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — replace the `modelSupportsThinking`/`wantThinking` block:

```js
const cap = modelConfig.reasoning ?? modelCapability(config, effectiveModelKey);
const effort = resolveReasoningEffort({ perCall: reasoningEffort, modelEffort: modelConfig.reasoningEffort, bakedDefault: modelConfig.reasoningEffort });
let fields = null;
if (cap === CAPABILITY.GLM_TOGGLE) fields = effortToGlmThinking(effort);
else if (cap === CAPABILITY.OPENAI_EFFORT) fields = effortToOpenAiFields(effort, { vocab: modelConfig.reasoningVocab });
else if (cap === CAPABILITY.QWEN_BUDGET) fields = effortToQwenFields(effort, { maxTokens });
if (fields) Object.assign(body, fields); // all top-level keys (raw fetch — no extra_body)
```

  Keep the `json_schema → json_object` fallback; add a sibling that, on a `reasoning_effort`-shaped rejection, retries once with `reasoning_effort` deleted from `body` and logs `reasoning_effort_unsupported`.

- [ ] **Step 4: Run → PASS** (full suite green; GLM `enabled` behavior preserved).
- [ ] **Step 5: Commit** `feat(client): capability-dispatched http reasoning fields`.

---

### Task 9: Wire anthropic transport

**Files:** Modify `scripts/lib/transport/anthropic.mjs`; Test `tests/transport-anthropic.test.mjs`

- [ ] **Step 1: Failing tests**
  - `ANTHROPIC_EFFORT` (opus, effort `xhigh`): body has `thinking:{type:"adaptive"}`, `output_config.effort=="xhigh"`, and **no** `temperature`/`top_p`/`top_k`.
  - `KIMI_TOGGLE`: `thinking:{type:"enabled"}`, **no** `budget_tokens`, and temp/top_p/top_k stripped.
  - `ANTHROPIC_BUDGET`: clamp + skip-when-small.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
  - Resolve effort (as Task 8). Branch on `modelConfig.reasoning`: `ANTHROPIC_EFFORT`→`effortToAnthropicEffort`; `KIMI_TOGGLE`→`effortToKimiThinking`; `ANTHROPIC_BUDGET`→`effortToAnthropicBudget`.
  - **Strip** `temperature`/`top_p`/`top_k` from the request body whenever the resolved effort is not `off` for ANY thinking-capable anthropic capability (do a `delete`; baseBody at anthropic.mjs:92-99 may add them in future, and K2.6 locks temperature).
  - **Pin the structured-output rule (replaces v1's "when unsure"):** for `ANTHROPIC_EFFORT`, attempt `output_config: { effort, format: <review schema> }` together; on a rejection of `output_config.format`, fall back to prompt-JSON (the existing validate/reprompt loop) while keeping `effort`. Assert the exact first-attempt shape and the fallback path. (The current code's "omit output_config whenever thinking is enabled", anthropic.mjs:105-106, is replaced by this.)

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `fix(anthropic): Opus 4.7 effort/adaptive; strip locked sampling; drop budget_tokens for kimi`.

---

### Task 10: Wire cli transport

**Files:** Modify `scripts/lib/transport/cli.mjs` (`runCliModel` effective-effort + `buildInvocation`); Test `tests/transport-cli.test.mjs`

- [ ] **Step 1: Failing test** — `buildInvocation({kind:"codex", reasoningEffort:"xhigh"})` → `["-c", 'model_reasoning_effort="high"']`; `"off"`→none; `kind:"agy"`→none. And `runCliModel` resolves per-call over `m.reasoningEffort`.

- [ ] **Step 2: Run → FAIL** (current code at cli.mjs:256 emits the raw value whenever truthy).
- [ ] **Step 3: Implement** — in `runCliModel` (cli.mjs:130) compute `const effort = resolveReasoningEffort({ perCall, modelEffort: m.reasoningEffort, bakedDefault: m.reasoningEffort ?? "off" })` and pass to `buildInvocation`; replace the inline codex line with `args.push(...effortToCliReasoningArgs(kind, effort))`. **Before wiring `claude`/`gemini`/`cursor`/`agy`, run `<binary> --help` and add the real reasoning flag if one exists; otherwise leave `[]` and emit a one-time `cli_reasoning_unsupported` stderr note** (do NOT invent flags — spec §7).

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(cli): map reasoning effort to per-agent flags`.

---

### Task 11: Per-call `reasoning_effort` tool argument

**Files:** Modify `scripts/multipoly-mcp.mjs` (`buildToolDefs`, `REVIEW_TOOL_SCHEMA`/`CONSULT_TOOL_SCHEMA` cloning, `allowedKeys`, `registryFromConfig`); Test `tests/mcp-integration.test.mjs`

- [ ] **Step 1: Failing tests**
  - `tools/list`: `glm_review` has `reasoning_effort` (enum `off|low|medium|high|xhigh`); a `NONE`-capability tool (e.g. composer) does NOT.
  - `tools/call glm_review {reasoning_effort:"low", ...}` threads `"low"` to the run path (stub runner); an invalid value is rejected by the key/enum validator.
  - council per-member: `council_review {models:["glm","composer"], reasoning_effort:"low"}` → glm member runs `"low"`, composer ignores.
  - Anti-drift test still passes (tools ≡ handlers ≡ validator keys).

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
  - `REVIEW_TOOL_SCHEMA`/`CONSULT_TOOL_SCHEMA` are shared static objects → in `buildToolDefs`, build a per-key **clone** of `inputSchema`, adding `reasoning_effort` (enum) only when `modelHasReasoningControl`. `registryFromConfig` (multipoly-mcp.mjs:170) must include `reasoning`/capability so `buildToolDefs` can decide.
  - Add `reasoning_effort` to the per-tool `allowedKeys` (REVIEW_KEYS/CONSULT_KEYS/council extra) or the validator rejects it; validate the value with `normalizeEffort` (reject `inherit` at the per-call boundary — per-call must be a concrete level; omission ≡ inherit).
  - Thread the value into `prepare*`/`runCouncilMembers` (Task 7 seam).
  - Council maps the single value per-member through each member's own adapter (no council-wide assumption).

- [ ] **Step 4: Run → PASS** (full suite green).
- [ ] **Step 5: Commit** `feat(mcp): per-call reasoning_effort argument (per-key schema)`.

---

### Task 12: Regression guard + docs

**Files:** Test `tests/reasoning.test.mjs`/`tests/transport-config.test.mjs`; Modify `CHANGELOG.md`, `README.md`

- [ ] **Step 1:** Regression tests: (a) GLM default config `maxTokens.review >= MIN_THINKING_BUDGET + MIN_OUTPUT_RESERVE`; (b) `ANTHROPIC_EFFORT` path never emits `budget_tokens` (guards the latent 400); (c) a builtin-capability completeness assertion (every `MODEL_INFO` entry has a valid `reasoning` + concrete `defaultEffort`).
- [ ] **Step 2: Run → PASS.**
- [ ] **Step 3:** Document `reasoning_effort` (per-call arg + `MULTIPOLY_[<K>_]REASONING_EFFORT` env + per-model defaults + the retired mode-default behavior) in README; CHANGELOG entry under Unreleased.
- [ ] **Step 4:** Full suite: `node --test --test-reporter=spec tests/*.test.mjs` → all green.
- [ ] **Step 5: Commit** `docs+test: reasoning effort regression guard and docs`.

---

## Done-when

- Full suite green.
- A per-call `reasoning_effort` overrides the per-model baseline and reaches every transport (verified by the Task 7 threading tests); council maps it per-member.
- Opus path uses `output_config.effort`+`adaptive`, never `budget_tokens`, and strips temp/top_p/top_k; kimi never sends `budget_tokens`; GLM/MiMo have a max_tokens floor that yields to explicit values.
- `modelSupportsThinking` semantics unchanged for existing callers; `modelHasReasoningControl` is the new gate.
- No naming/opus-fold/alias/MiMo-builtin changes leaked in (Plans B/C).
