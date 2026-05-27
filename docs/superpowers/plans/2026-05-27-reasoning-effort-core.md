# Reasoning-Effort Core — Implementation Plan (Plan A of 3)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every model a graded reasoning-effort knob (`off|low|medium|high|xhigh`, default per-model) that maps onto each backend's verified native mechanism, settable per-call > per-model env > server env > baked default.

**Architecture:** A new pure module `scripts/lib/reasoning.mjs` owns the scale, the precedence resolver, the per-model capability descriptor, and six small per-capability adapter functions. `config.mjs` resolves the effective effort + capability per model at load; each transport (`client.mjs`, `transport/anthropic.mjs`, `transport/cli.mjs`) calls the matching adapter to build its request fields. No live capability probing — capability is static per model.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert/strict` (run: `node --test --test-reporter=spec tests/*.test.mjs`). No new deps.

**Spec:** `docs/superpowers/specs/2026-05-27-reasoning-effort-and-model-naming-design.md` (§1, §2, §6).

**Scope note:** This plan does NOT touch model naming, the `opus`→`claude` fold, alias resolution, or MiMo-as-builtin — those are Plans B and C. Here `mimo` is treated via its existing capability (`http_thinking_toggle`), same as `glm`.

---

## File Structure

- **Create** `scripts/lib/reasoning.mjs` — scale constants, `normalizeEffort`, `EFFORT_ORDER`, `CAPABILITY` constants, `resolveReasoningEffort()`, legacy-`thinking` mapping, and adapters: `effortToGlmThinking`, `effortToQwenBudget`, `effortToOpenAiEffort`, `effortToAnthropicEffort`, `effortToAnthropicBudget`, `effortToKimiThinking`, `effortToCliReasoningArgs`. Pure functions, no I/O.
- **Create** `tests/reasoning.test.mjs` — unit tests for the module.
- **Modify** `scripts/lib/models.mjs` — add a static `reasoning` capability + `defaultEffort` to each `MODEL_INFO` entry and `OPUS_INFO`; add `modelCapability(config,key)`; keep `modelSupportsThinking` as `capability !== "none"`.
- **Modify** `scripts/lib/config.mjs` — parse `MULTIPOLY_REASONING_EFFORT` / `MULTIPOLY_<K>_REASONING_EFFORT`, map legacy `*_THINKING`, store `reasoningEffort` + `capability` on each model config; apply GLM/MiMo `max_tokens` floor default.
- **Modify** `scripts/lib/client.mjs` — replace the `body.thinking = {type:enabled/disabled}` block with capability-dispatched http adapters (glm toggle / qwen budget / openai effort).
- **Modify** `scripts/lib/transport/anthropic.mjs` — replace `buildThinkingField` with capability branch (`anthropic_effort` adaptive+`output_config.effort` and strip temperature/top_p/top_k; `anthropic_budget` legacy clamp; `kimi_toggle` bare toggle).
- **Modify** `scripts/lib/transport/cli.mjs` — `buildInvocation` uses `effortToCliReasoningArgs(kind, effort)` instead of the inline codex-only line.
- **Modify** the tool builder (`scripts/multipoly-mcp.mjs` `buildServerSurface` / tool schemas) — add optional `reasoning_effort` enum to `*_review`/`*_consult`/`council_*` (omit for `none`-capability models) and thread it to the run path.

Tasks are ordered so the pure module + capability data land first (everything depends on them), then config, then each transport, then the tool surface.

---

### Task 1: Scale + normalization in `reasoning.mjs`

**Files:**
- Create: `scripts/lib/reasoning.mjs`
- Test: `tests/reasoning.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFORT_LEVELS, EFFORT_ORDER, normalizeEffort } from "../scripts/lib/reasoning.mjs";

test("reasoning: effort levels and ordering", () => {
  assert.deepEqual(EFFORT_LEVELS, ["off", "low", "medium", "high", "xhigh"]);
  assert.ok(EFFORT_ORDER.high > EFFORT_ORDER.low);
});

test("reasoning: normalizeEffort accepts levels + inherit, case/space-insensitive", () => {
  assert.equal(normalizeEffort("HIGH"), "high");
  assert.equal(normalizeEffort("  off "), "off");
  assert.equal(normalizeEffort("inherit"), "inherit");
  assert.equal(normalizeEffort(""), "inherit");        // empty ≡ unset
  assert.equal(normalizeEffort(undefined), "inherit");
});

test("reasoning: normalizeEffort rejects junk", () => {
  assert.throws(() => normalizeEffort("turbo"), (e) => e.code === "CONFIG");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-reporter=spec tests/reasoning.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/lib/reasoning.mjs'`.

- [ ] **Step 3: Minimal implementation**

```js
// scripts/lib/reasoning.mjs
import { MultipolyError } from "./errors.mjs";

export const EFFORT_LEVELS = Object.freeze(["off", "low", "medium", "high", "xhigh"]);
export const EFFORT_ORDER = Object.freeze(
  Object.fromEntries(EFFORT_LEVELS.map((lvl, i) => [lvl, i])),
);

/** Normalize a raw effort string. "" / undefined / "inherit" → "inherit". Throws CONFIG on junk. */
export function normalizeEffort(raw) {
  if (raw === undefined || raw === null) return "inherit";
  const v = String(raw).trim().toLowerCase();
  if (v === "" || v === "inherit") return "inherit";
  if (EFFORT_LEVELS.includes(v)) return v;
  throw new MultipolyError(
    "CONFIG",
    `reasoning effort must be one of ${EFFORT_LEVELS.join("|")}|inherit, got ${JSON.stringify(raw)}`,
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-reporter=spec tests/reasoning.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/reasoning.mjs tests/reasoning.test.mjs
git commit -m "feat(reasoning): effort scale + normalizeEffort"
```

---

### Task 2: Legacy `thinking` → effort mapping

**Files:** Modify `scripts/lib/reasoning.mjs`; Test `tests/reasoning.test.mjs`

- [ ] **Step 1: Failing test**

```js
import { thinkingToEffort } from "../scripts/lib/reasoning.mjs";

test("reasoning: legacy thinking maps to effort", () => {
  assert.equal(thinkingToEffort("off"), "off");
  assert.equal(thinkingToEffort("on"), "medium");
  assert.equal(thinkingToEffort("auto"), "inherit");
  assert.equal(thinkingToEffort(undefined), "inherit");
});
```

- [ ] **Step 2: Run → FAIL** (`thinkingToEffort is not a function`).

- [ ] **Step 3: Implement**

```js
export function thinkingToEffort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return "inherit";
  const v = String(raw).trim().toLowerCase();
  if (v === "off") return "off";
  if (v === "on") return "medium";
  if (v === "auto") return "inherit";
  throw new MultipolyError("CONFIG", `thinking must be on|off|auto, got ${JSON.stringify(raw)}`);
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(reasoning): legacy thinking→effort mapping`.

---

### Task 3: `resolveReasoningEffort` precedence

**Files:** Modify `scripts/lib/reasoning.mjs`; Test `tests/reasoning.test.mjs`

Precedence (highest first): per-call → per-model effort → per-model legacy thinking → server effort → server legacy thinking → baked default. `inherit` at any layer falls through. A baked default of `inherit` is a programming error (assert).

- [ ] **Step 1: Failing test**

```js
import { resolveReasoningEffort } from "../scripts/lib/reasoning.mjs";

const layers = (o) => ({
  perCall: undefined, modelEffort: "inherit", modelThinking: "inherit",
  serverEffort: "inherit", serverThinking: "inherit", bakedDefault: "high", ...o,
});

test("reasoning: per-call wins over everything", () => {
  assert.equal(resolveReasoningEffort(layers({ perCall: "low", modelEffort: "xhigh" })), "low");
});
test("reasoning: per-model effort beats server effort", () => {
  assert.equal(resolveReasoningEffort(layers({ modelEffort: "medium", serverEffort: "high" })), "medium");
});
test("reasoning: per-model effort beats per-model legacy thinking", () => {
  assert.equal(resolveReasoningEffort(layers({ modelEffort: "low", modelThinking: "off" })), "low");
});
test("reasoning: server effort beats server legacy thinking", () => {
  assert.equal(resolveReasoningEffort(layers({ serverEffort: "low", serverThinking: "off" })), "low");
});
test("reasoning: all inherit → baked default", () => {
  assert.equal(resolveReasoningEffort(layers({})), "high");
});
test("reasoning: baked default must not be inherit", () => {
  assert.throws(() => resolveReasoningEffort(layers({ bakedDefault: "inherit" })));
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```js
/**
 * Resolve effective effort from already-normalized layer values.
 * Each layer is an effort level or "inherit". perCall may be undefined (≡ inherit).
 */
export function resolveReasoningEffort({
  perCall, modelEffort, modelThinking, serverEffort, serverThinking, bakedDefault,
}) {
  const chain = [
    normalizeEffort(perCall),
    modelEffort ?? "inherit",
    modelThinking ?? "inherit",
    serverEffort ?? "inherit",
    serverThinking ?? "inherit",
  ];
  for (const lvl of chain) if (lvl !== "inherit") return lvl;
  if (!EFFORT_LEVELS.includes(bakedDefault)) {
    throw new MultipolyError("INTERNAL", `baked default effort must be a concrete level, got ${JSON.stringify(bakedDefault)}`);
  }
  return bakedDefault;
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(reasoning): precedence resolver`.

---

### Task 4: Capability constants + per-backend adapters

**Files:** Modify `scripts/lib/reasoning.mjs`; Test `tests/reasoning.test.mjs`

Adapters return a small object describing what each transport should add (or `null`/`{skip}` to omit). Verified mappings from spec §2.

- [ ] **Step 1: Failing tests** (one per adapter — abbreviated; write all)

```js
import {
  CAPABILITY, effortToGlmThinking, effortToOpenAiEffort, effortToAnthropicEffort,
  effortToAnthropicBudget, effortToKimiThinking, effortToQwenBudget, effortToCliReasoningArgs,
} from "../scripts/lib/reasoning.mjs";

test("glm toggle: off disables, any level enables", () => {
  assert.deepEqual(effortToGlmThinking("off"), { thinking: { type: "disabled" } });
  assert.deepEqual(effortToGlmThinking("high"), { thinking: { type: "enabled" } });
});

test("openai effort: deepseek caps at high/max, gemini full range, off varies", () => {
  assert.equal(effortToOpenAiEffort("xhigh", { vocab: "deepseek" }).reasoning_effort, "max");
  assert.equal(effortToOpenAiEffort("low", { vocab: "deepseek" }).reasoning_effort, "high"); // low/med→high
  assert.equal(effortToOpenAiEffort("medium", { vocab: "gemini" }).reasoning_effort, "medium");
  assert.equal(effortToOpenAiEffort("xhigh", { vocab: "gemini" }).reasoning_effort, "high");  // tops at high
  // off: deepseek disables via extra_body.thinking; gemini sends none (can't truly disable)
  assert.deepEqual(effortToOpenAiEffort("off", { vocab: "deepseek" }), { extra_body: { thinking: { type: "disabled" } } });
  assert.equal(effortToOpenAiEffort("off", { vocab: "gemini" }).reasoning_effort, "none");
});

test("anthropic effort (Opus 4.7): adaptive + output_config.effort, off omits", () => {
  assert.equal(effortToAnthropicEffort("off"), null);
  assert.deepEqual(effortToAnthropicEffort("xhigh"), {
    thinking: { type: "adaptive" }, output_config: { effort: "xhigh" },
  });
});

test("anthropic budget (legacy): clamp + skip when no room", () => {
  // max_tokens too small to fit budget + reserve → skip (null)
  assert.equal(effortToAnthropicBudget("high", { maxTokens: 1200 }), null);
  const r = effortToAnthropicBudget("high", { maxTokens: 20000 });
  assert.equal(r.thinking.type, "enabled");
  assert.ok(r.thinking.budget_tokens >= 1024 && r.thinking.budget_tokens < 20000);
});

test("kimi toggle: no budget_tokens ever", () => {
  assert.deepEqual(effortToKimiThinking("high"), { thinking: { type: "enabled" } });
  assert.deepEqual(effortToKimiThinking("off"), { thinking: { type: "disabled" } });
});

test("qwen budget: enable_thinking always true, budget scales, cannot disable", () => {
  const off = effortToQwenBudget("off", { maxTokens: 20000 });
  assert.equal(off.extra_body.enable_thinking, true);             // thinking-only
  const hi = effortToQwenBudget("high", { maxTokens: 20000 });
  assert.ok(hi.extra_body.thinking_budget > off.extra_body.thinking_budget);
});

test("cli reasoning args: codex maps, agy/no-flag kinds get []", () => {
  assert.deepEqual(effortToCliReasoningArgs("codex", "high"), ["-c", 'model_reasoning_effort="high"']);
  assert.deepEqual(effortToCliReasoningArgs("agy", "high"), []);
  assert.deepEqual(effortToCliReasoningArgs("codex", "off"), []); // off → no reasoning flag
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (constants + adapters)

```js
export const CAPABILITY = Object.freeze({
  NONE: "none",
  GLM_TOGGLE: "http_thinking_toggle",      // glm, mimo
  QWEN_BUDGET: "qwen_budget",
  OPENAI_EFFORT: "openai_effort",          // deepseek, gemini, codex-http
  ANTHROPIC_EFFORT: "anthropic_effort",    // Opus 4.7+
  ANTHROPIC_BUDGET: "anthropic_budget",    // legacy anthropic
  KIMI_TOGGLE: "kimi_toggle",
});

const MIN_THINKING_BUDGET = 1024;
const MIN_OUTPUT_RESERVE = 1024;
const BUDGET_FRACTION = Object.freeze({ off: 0, low: 0.25, medium: 0.4, high: 0.6, xhigh: 0.8 });

export function effortToGlmThinking(effort) {
  return { thinking: { type: effort === "off" ? "disabled" : "enabled" } };
}

export function effortToKimiThinking(effort) {
  return { thinking: { type: effort === "off" ? "disabled" : "enabled" } };
}

export function effortToOpenAiEffort(effort, { vocab }) {
  if (effort === "off") {
    if (vocab === "deepseek") return { extra_body: { thinking: { type: "disabled" } } };
    return { reasoning_effort: "none" }; // gemini etc. cannot truly disable
  }
  if (vocab === "deepseek") return { reasoning_effort: effort === "xhigh" ? "max" : "high" };
  // gemini / generic OpenAI: none|minimal|low|medium|high — xhigh tops at high
  return { reasoning_effort: effort === "xhigh" ? "high" : effort };
}

export function effortToAnthropicEffort(effort) {
  if (effort === "off") return null; // omit thinking
  return { thinking: { type: "adaptive" }, output_config: { effort } };
}

export function effortToAnthropicBudget(effort, { maxTokens }) {
  if (effort === "off" || maxTokens === undefined) return null;
  if (maxTokens < MIN_THINKING_BUDGET + MIN_OUTPUT_RESERVE) return null; // no room → skip
  const raw = Math.round(BUDGET_FRACTION[effort] * maxTokens);
  const upper = maxTokens - MIN_OUTPUT_RESERVE;
  const budget = Math.min(Math.max(raw, MIN_THINKING_BUDGET), upper);
  if (budget < MIN_THINKING_BUDGET) return null;
  return { thinking: { type: "enabled", budget_tokens: budget } };
}

export function effortToQwenBudget(effort, { maxTokens }) {
  // Qwen 3.7 Max is thinking-only: enable_thinking is always true; off = smallest budget.
  const cap = maxTokens ?? 16384;
  const frac = effort === "off" ? 0.1 : BUDGET_FRACTION[effort];
  const budget = Math.max(256, Math.round(frac * cap));
  return { extra_body: { enable_thinking: true, thinking_budget: budget } };
}

export function effortToCliReasoningArgs(kind, effort) {
  if (effort === "off") return [];
  if (kind === "codex") return ["-c", `model_reasoning_effort="${effort}"`];
  // claude / gemini / cursor / agy: no verified reasoning-effort flag yet (Plan note).
  return [];
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(reasoning): per-capability adapters`.

> **Implementation note for the worker:** the CLI reasoning flags for `claude`, `gemini`, `cursor`, `agy` are unverified. Before wiring them in Task 8, run `<binary> --help` for each and add the real flag; if none exists, leave `[]` (logged no-op). Do NOT invent flags. See spec §7.

---

### Task 5: Capability + default effort on `MODEL_INFO`

**Files:** Modify `scripts/lib/models.mjs`; Test `tests/transport-config.test.mjs`

- [ ] **Step 1: Failing test** (add to transport-config.test.mjs)

```js
import { MODEL_INFO, modelCapability } from "../scripts/lib/models.mjs";
import { CAPABILITY } from "../scripts/lib/reasoning.mjs";

test("models: builtins carry verified reasoning capability + default effort", () => {
  assert.equal(MODEL_INFO.glm.reasoning, CAPABILITY.GLM_TOGGLE);
  assert.equal(MODEL_INFO.qwen.reasoning, CAPABILITY.QWEN_BUDGET);
  assert.equal(MODEL_INFO.deepseek.reasoning, CAPABILITY.OPENAI_EFFORT);
  assert.equal(MODEL_INFO.glm.defaultEffort, "high");
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — add `reasoning` + `defaultEffort` to each `MODEL_INFO` entry and `OPUS_INFO`:
  - `glm` → `GLM_TOGGLE`, `high`
  - `qwen` → `QWEN_BUDGET`, `high`
  - `deepseek` → `OPENAI_EFFORT` (vocab `deepseek`), `high`
  - `composer` → `NONE` (cursor cli; revisit in Plan B), default `off`
  - `OPUS_INFO` → `ANTHROPIC_EFFORT`, `xhigh`
  Add a `reasoningVocab` field where capability is `OPENAI_EFFORT` (`"deepseek"`/`"gemini"`).
  Add:

```js
export function modelCapability(config, key) {
  return config?.models?.[key]?.reasoning ?? MODEL_INFO[key]?.reasoning ?? CAPABILITY.NONE;
}
```
  Redefine `modelSupportsThinking` as `modelCapability(...) !== CAPABILITY.NONE` (keep the export name for back-compat).
  Extend `CONFIG_FIELDS`/registry copy lists (lines ~241–247) to carry `reasoning`, `reasoningVocab`, `defaultEffort`.

- [ ] **Step 4: Run → PASS** (and full suite stays green — `modelSupportsThinking` semantics preserved).
- [ ] **Step 5: Commit** `feat(models): static reasoning capability + default effort`.

---

### Task 6: Resolve effort + capability in `config.mjs`

**Files:** Modify `scripts/lib/config.mjs`; Test `tests/transport-config.test.mjs`

- [ ] **Step 1: Failing tests**

```js
test("config: per-model REASONING_EFFORT beats server, legacy THINKING maps", () => {
  const c = loadConfig({ ...glm, MULTIPOLY_REASONING_EFFORT: "low", MULTIPOLY_GLM_REASONING_EFFORT: "xhigh" });
  assert.equal(c.models.glm.reasoningEffort, "xhigh");
});
test("config: server THINKING=off maps to effort off when nothing more specific", () => {
  const c = loadConfig({ ...glm, MULTIPOLY_THINKING: "off" });
  assert.equal(c.models.glm.reasoningEffort, "off");
});
test("config: glm/mimo get a max_tokens review floor", () => {
  const c = loadConfig({ ...glm });
  assert.ok(c.models.glm.maxTokens.review >= 8192);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**
  - In the per-model loaders (`loadHttpModelConfig`/`loadAnthropicModelConfig`/`loadCliModelConfig`), compute and store `reasoningEffort` via `resolveReasoningEffort` using: `modelEffort = normalizeEffort(env[\`${prefix}_REASONING_EFFORT\`])`, `modelThinking = thinkingToEffort(env[\`${prefix}_THINKING\`])`, `serverEffort = normalizeEffort(env.MULTIPOLY_REASONING_EFFORT)`, `serverThinking = thinkingToEffort(env.MULTIPOLY_THINKING ?? env.GLM_THINKING)`, `bakedDefault = info.defaultEffort ?? "off"`. Also copy `reasoning`/`reasoningVocab` onto the model config.
  - In `resolveModelMaxTokens`, when `key === "glm"` (and `mimo` once it's a builtin in Plan C; for now also when `info.reasoning === GLM_TOGGLE`) and no explicit value is set, default review→`max(existing, 8192)`, consult→`max(existing, 4096)`.
  - Log a one-time `legacy_thinking_source` stderr event when a `*_THINKING` var is the effective source (optional; can be a follow-up).
  - Keep `parseThinking` for back-compat but route through `thinkingToEffort` semantics.

- [ ] **Step 4: Run → PASS** (full suite green).
- [ ] **Step 5: Commit** `feat(config): resolve per-model reasoning effort + GLM token floor`.

---

### Task 7: Wire http transport (`client.mjs`)

**Files:** Modify `scripts/lib/client.mjs:56-58`; Test `tests/transport-*.test.mjs` (or a focused client test)

- [ ] **Step 1: Failing test** — assert the request body for each http capability. Use the existing test seam that builds the request body (extract `buildHttpBody` if needed for testability), e.g.:
  - glm + effort `off` → `body.thinking == {type:"disabled"}`
  - deepseek + `xhigh` → `body.reasoning_effort == "max"`
  - qwen + `high` → `body.enable_thinking === true` and `body.thinking_budget > 0`
  - gemini + `off` → `body.reasoning_effort == "none"`

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — replace the current block:

```js
// OLD (client.mjs ~56-58):
const supportsThinking = modelConfig.supportsThinking ?? modelSupportsThinking(config, effectiveModelKey);
if (supportsThinking && wantThinking === true) body.thinking = { type: "enabled" };
else if (supportsThinking && wantThinking === false) body.thinking = { type: "disabled" };
```

with capability dispatch using the resolved `effort = modelConfig.reasoningEffort` (allow a per-call override param to win — plumb `reasoningEffort` arg into `runModel`):

```js
const cap = modelConfig.reasoning ?? modelCapability(config, effectiveModelKey);
const effort = perCallEffort ?? modelConfig.reasoningEffort ?? "off";
let extra = null;
if (cap === CAPABILITY.GLM_TOGGLE) extra = effortToGlmThinking(effort);
else if (cap === CAPABILITY.OPENAI_EFFORT) extra = effortToOpenAiEffort(effort, { vocab: modelConfig.reasoningVocab });
else if (cap === CAPABILITY.QWEN_BUDGET) extra = effortToQwenBudget(effort, { maxTokens });
if (extra?.thinking) body.thinking = extra.thinking;
if (extra?.reasoning_effort) body.reasoning_effort = extra.reasoning_effort;
if (extra?.extra_body) body.extra_body = { ...(body.extra_body ?? {}), ...extra.extra_body };
```

  Keep the existing `json_schema → json_object` fallback; add a sibling catch that, on a `reasoning_effort`-shaped error, retries once with `reasoning_effort` removed and logs `reasoning_effort_unsupported` (mirror `looksLikeResponseFormatError`).

- [ ] **Step 4: Run → PASS** (full suite green; existing GLM behavior preserved for `enabled`).
- [ ] **Step 5: Commit** `feat(client): capability-dispatched http reasoning fields`.

---

### Task 8: Wire anthropic transport (`transport/anthropic.mjs`)

**Files:** Modify `scripts/lib/transport/anthropic.mjs`; Test `tests/transport-anthropic.test.mjs`

- [ ] **Step 1: Failing tests**
  - `anthropic_effort` (opus): body has `thinking:{type:"adaptive"}`, `output_config.effort` set, and **no** `temperature`/`top_p`/`top_k`.
  - `kimi_toggle`: body has `thinking:{type:"enabled"}` and **no** `budget_tokens`.
  - `anthropic_budget` (legacy model): clamp + skip-when-small as in Task 4.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — replace `buildThinkingField` usage with a capability branch driven by `modelConfig.reasoning`:
  - `ANTHROPIC_EFFORT` → spread `effortToAnthropicEffort(effort)`; ensure the request omits `temperature`/`top_p`/`top_k` for this capability.
  - `KIMI_TOGGLE` → spread `effortToKimiThinking(effort)`; never set `budget_tokens`.
  - `ANTHROPIC_BUDGET` → `effortToAnthropicBudget(effort, { maxTokens })`.
  Keep the existing "thinking + structured output not combinable → omit output_config" guard, adapting it: when `ANTHROPIC_EFFORT` is on, `output_config.effort` and the JSON `output_config.format` must coexist or fall back to prompt-JSON (preserve current behavior — prefer prompt-JSON when unsure).

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `fix(anthropic): Opus 4.7 effort/adaptive shape; drop budget_tokens for kimi`.

---

### Task 9: Wire cli transport (`transport/cli.mjs`)

**Files:** Modify `scripts/lib/transport/cli.mjs:231-256`; Test `tests/transport-cli.test.mjs`

- [ ] **Step 1: Failing test** — `buildInvocation({kind:"codex", reasoningEffort:"high", ...})` includes `["-c", 'model_reasoning_effort="high"']`; `kind:"agy"` includes no reasoning args; `reasoningEffort:"off"` includes none.

- [ ] **Step 2: Run → FAIL** (current code emits the flag whenever `reasoningEffort` is truthy, regardless of value/kind).

- [ ] **Step 3: Implement** — replace the inline line with
  `args.push(...effortToCliReasoningArgs(kind, reasoningEffort))`. Verify each non-codex binary's real flag first (see Task 4 note); wire any that genuinely exist.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(cli): map reasoning effort to per-agent flags`.

---

### Task 10: Per-call `reasoning_effort` tool argument

**Files:** Modify `scripts/multipoly-mcp.mjs` (`buildServerSurface` / tool-def list + handler + key-spec); Test `tests/mcp-integration.test.mjs`

- [ ] **Step 1: Failing tests**
  - `tools/list` shows `reasoning_effort` (enum `off|low|medium|high|xhigh`) on `glm_review`, absent on any `NONE`-capability tool.
  - A `tools/call` with `reasoning_effort:"low"` threads through to the run path (assert via a stubbed runner that it received `perCallEffort:"low"`).
  - Anti-drift test still passes (tools ≡ handlers ≡ validator keys).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — in the single tool-def source, add the optional `reasoning_effort` enum to review/consult/council schemas for models whose capability ≠ `NONE`; add `reasoning_effort` to the per-tool key-spec validator; thread the value into `runModel`/council member runs as `perCallEffort`. Council maps it per-member through each member's own adapter (no council-wide assumption).

- [ ] **Step 4: Run → PASS** (full suite green).
- [ ] **Step 5: Commit** `feat(mcp): per-call reasoning_effort argument`.

---

### Task 11: Regression guard + docs

**Files:** Test `tests/reasoning.test.mjs` / `tests/budget.test.mjs`; Modify `CHANGELOG.md`, `README.md`

- [ ] **Step 1:** Add a regression test asserting GLM's default config yields `maxTokens.review >= MIN_THINKING_BUDGET + MIN_OUTPUT_RESERVE` and that the anthropic `ANTHROPIC_EFFORT` path never emits `budget_tokens` (guards the v1 latent 400).
- [ ] **Step 2: Run → PASS.**
- [ ] **Step 3:** Document the `reasoning_effort` arg + `MULTIPOLY_[<K>_]REASONING_EFFORT` env + per-model defaults in README; add a CHANGELOG entry under Unreleased.
- [ ] **Step 4:** Run the **full** suite: `node --test --test-reporter=spec tests/*.test.mjs` → all green.
- [ ] **Step 5: Commit** `docs+test: reasoning effort regression guard and docs`.

---

## Done-when

- `node --test --test-reporter=spec tests/*.test.mjs` is fully green.
- Every transport builds reasoning fields from the resolved per-model effort; Opus path uses `output_config.effort`+`adaptive` and never `budget_tokens`; kimi never sends `budget_tokens`; GLM/MiMo have a max_tokens floor.
- `reasoning_effort` is settable per-call and via env at both scopes with the documented precedence.
- No model naming / `opus` fold / alias / MiMo-builtin changes leaked in (those are Plans B/C).
