# Multipoly upgrade D2 — budgets, adaptive retry, CLI JSON Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop reasoning models from `BUDGET`-failing on large reviews and recover the ones that do (§1: raise per-capability max_tokens floors + a one-shot adaptive retry), and stop CLI agents that emit prose from failing the JSON contract (§4: extract-JSON-from-prose in the parse path).

**Architecture:** Second of three plans from `docs/superpowers/specs/2026-05-28-multipoly-upgrade-design.md` (read the spec's §1, §4, and "Resolved decisions"). Builds on D1 but is independent of it. Branch `feat/multipoly-upgrade`.

**Tech Stack:** Node.js ESM (`.mjs`), `node --test`. No new dependencies.

**Test runner:** `node --test --test-reporter=spec tests/<file>.test.mjs`; full: `node --test tests/*.test.mjs 2>&1 | tail -6` (Bash tool = bash). Secret-scanner caveat: short fake values in tests only.

---

## Existing-code orientation (read before starting)

- `scripts/lib/config.mjs` — `MODEL_OUTPUT_CEILING = 131072`; `resolveModelMaxTokens(env, key, prefix, serverMaxTokens, info)` (~L142-168) currently applies an 8192/4096 floor ONLY when `info.reasoning === CAPABILITY.GLM_TOGGLE` (`isGlmToggle`). `resolveMaxTokensForModel(config, modelKey, mode)` reads the loaded `model.maxTokens[mode]`.
- `scripts/lib/reasoning.mjs` — `CAPABILITY` (NONE/GLM_TOGGLE/QWEN_BUDGET/OPENAI_EFFORT/ANTHROPIC_EFFORT/ANTHROPIC_BUDGET/KIMI_TOGGLE), `EFFORT_LEVELS`/`EFFORT_ORDER`, `resolveReasoningEffort`, the effort adapters. `effortToQwenFields(e,{maxTokens})` / `effortToAnthropicBudget(e,{maxTokens})` compute `thinking_budget` as a FRACTION of `maxTokens`.
- `scripts/lib/budget.mjs` — `assertContentBudget(attempt, maxTokens, mode, {modelKey, supportsThinking})`: THROWS `MultipolyError("BUDGET", …)` on empty / length-truncated review / too-short review; RETURNS `{truncated:false}` for a clean completion and `{truncated:true}` for a non-empty length-truncated consult/freeform.
- `scripts/lib/run-model.mjs` — `runModel(args)` dispatches by transport to `streamChatCompletion` (http), `runAnthropicModel` (anthropic), `runCliModel` (cli). All accept `reasoningEffort`; NONE accept a max_tokens override yet.
- `scripts/lib/client.mjs` — http transport: `const maxTokens = resolveMaxTokensForModel(config, key, mode); if (maxTokens !== undefined) body.max_tokens/max_completion_tokens = maxTokens;` and passes `maxTokens` to `effortToQwenFields`.
- `scripts/lib/transport/anthropic.mjs` — `const maxTokens = resolveMaxTokensForModel(config, modelKey, mode) ?? DEFAULT_MAX_TOKENS (16384);` and passes it to `effortToAnthropicBudget`.
- `scripts/lib/transport/cli.mjs` — `runCliModel`; max_tokens is not sent to a CLI (the agent uses its own), so a maxTokensOverride is a no-op there (accept + ignore for signature uniformity).
- `scripts/lib/model-review.mjs` — `runPreparedReview`: attempt1 = runModel(...); `assertContentBudget(attempt1, maxTokens, "review", ctx)`; parse/validate; if invalid → attempt2 (JSON reprompt) + `assertContentBudget`; throw SCHEMA if still invalid. Local `tryParseJson` uses `stripCodeFence`.
- `scripts/lib/model-consult.mjs` — `runPreparedConsult`: single runModel + `assertContentBudget` (uses the `{truncated}` return).
- `scripts/lib/council.mjs` — has its own duplicate `tryParseJson`; council members go through `runPreparedReview`/`runPreparedConsult`, so they inherit the retry automatically.
- `scripts/lib/prompts.mjs` — `stripCodeFence(text)`.

Cited line numbers are approximate; match on surrounding code.

---

## Task 1: §1 — Generalize the max_tokens floor to all reasoning capabilities

**Files:**
- Modify: `scripts/lib/config.mjs` (`resolveModelMaxTokens`, add floor constants)
- Test: extend `tests/config.test.mjs`

- [ ] **Step 1: Failing tests** (extend `tests/config.test.mjs`):
  - A configured `kimi` (KIMI_TOGGLE) with no explicit cap → `maxTokens.review === 32768`, `maxTokens.consult === 8192`.
  - A configured `deepseek` (OPENAI_EFFORT) with no explicit cap → review 32768 / consult 8192.
  - `glm` (GLM_TOGGLE) with no explicit cap → review 32768 / consult 8192 (raised from 8192/4096).
  - A NONE-capability model (e.g. composer or a custom NONE) → NO floor (review stays undefined unless server cap set).
  - An explicit `MULTIPOLY_<K>_MAX_TOKENS_REVIEW=20000` still wins (floor does not override).
  - (Ceiling) if a hypothetical floor exceeded `MODEL_OUTPUT_CEILING` it would clamp — assert the floor value ≤ ceiling (32768 < 131072, trivially true; include a guard test that the returned value never exceeds ceiling).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Replace the `isGlmToggle` gate with a reasoning-capability gate:

```javascript
// near MODEL_OUTPUT_CEILING:
const REASONING_REVIEW_FLOOR = 32768;
const REASONING_CONSULT_FLOOR = 8192;

// in resolveModelMaxTokens, replace `isGlmToggle`:
const cap = info?.reasoning;
const isReasoning = cap !== undefined && cap !== CAPABILITY.NONE;
// …compute review/consult as today…
if (isReasoning) {
  const rf = Math.min(REASONING_REVIEW_FLOOR, MODEL_OUTPUT_CEILING);
  const cf = Math.min(REASONING_CONSULT_FLOOR, MODEL_OUTPUT_CEILING);
  return Object.freeze({
    review: reviewAnyExplicit ? review : Math.max(review ?? 0, rf),
    consult: consultAnyExplicit ? consult : Math.max(consult ?? 0, cf),
  });
}
return Object.freeze({ review, consult });
```
Import `CAPABILITY` (already imported in config.mjs). Keep the `reviewAnyExplicit`/`consultAnyExplicit` logic that respects explicit operator caps. Update the function's doc comment (the GLM-specific wording).

> Note: this raises GLM's floor from 8192→32768 too. Update any existing test that asserted the old 8192/4096 GLM floor to the new values (search: `8192`, `4096` in `tests/config.test.mjs` / `tests/reasoning.test.mjs`). The "GLM default config yields maxTokens.review >= 8192" regression test still passes (32768 ≥ 8192) but tighten it to 32768 if it asserts equality.

- [ ] **Step 4: Run → PASS + full suite** (fix any floor-value assertions that changed).

- [ ] **Step 5: Commit**
```bash
git add scripts/lib/config.mjs tests/config.test.mjs tests/reasoning.test.mjs
git commit -m "fix: raise max_tokens floor to 32768/8192 for all reasoning capabilities"
```

---

## Task 2: §1 — Thread a per-call maxTokensOverride through runModel + transports

**Files:**
- Modify: `scripts/lib/run-model.mjs`, `scripts/lib/client.mjs`, `scripts/lib/transport/anthropic.mjs`, `scripts/lib/transport/cli.mjs`
- Test: extend `tests/client.test.mjs`, `tests/transport-anthropic.test.mjs`, `tests/run-model.test.mjs`

The adaptive retry (Task 3) needs to re-issue a call with a higher max_tokens. Add an optional `maxTokensOverride` arg that supersedes `resolveMaxTokensForModel(...)` for that one call. It must flow to BOTH the emitted `max_tokens`/`max_completion_tokens` AND the budget-fraction reasoning adapters (qwen/anthropic_budget) so `thinking_budget` scales with it.

- [ ] **Step 1: Failing tests:**
  - http (`tests/client.test.mjs`): calling `streamChatCompletion({..., maxTokensOverride: 50000})` for a model whose configured cap is 8192 → the sent body has `max_tokens === 50000` (or `max_completion_tokens` for mimo). For a qwen (QWEN_BUDGET) config, assert the `thinking_budget` in the body reflects the override (fraction × 50000), not × 8192.
  - anthropic (`tests/transport-anthropic.test.mjs`): `runAnthropicModel({..., maxTokensOverride: 50000})` → body `max_tokens === 50000`; for an ANTHROPIC_BUDGET model the `budget_tokens` reflects × 50000.
  - run-model (`tests/run-model.test.mjs`): `maxTokensOverride` is forwarded to the http/anthropic transports (cli ignores it without error).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.**
  - `run-model.mjs`: include `maxTokensOverride` in the args passed through to each transport (it's already a pass-through of `args`; just ensure it isn't stripped — like `reasoningEffort`).
  - `client.mjs`: `const maxTokens = args.maxTokensOverride ?? resolveMaxTokensForModel(config, key, mode);` use this single `maxTokens` for both the body field AND the `effortToQwenFields(effort, { maxTokens })` call.
  - `anthropic.mjs`: `const maxTokens = reasoningEffort?…; const effectiveMax = maxTokensOverride ?? resolveMaxTokensForModel(...) ?? DEFAULT_MAX_TOKENS;` use `effectiveMax` for the body and for `effortToAnthropicBudget(effort, { maxTokens: effectiveMax })`.
  - `cli.mjs`: accept `maxTokensOverride` in the destructure and ignore it (CLI agents manage their own budget). Add a one-line comment.

- [ ] **Step 4: Run → PASS + full suite.**

- [ ] **Step 5: Commit**
```bash
git add scripts/lib/run-model.mjs scripts/lib/client.mjs scripts/lib/transport/anthropic.mjs scripts/lib/transport/cli.mjs tests/client.test.mjs tests/transport-anthropic.test.mjs tests/run-model.test.mjs
git commit -m "feat: thread per-call maxTokensOverride through runModel and transports"
```

---

## Task 3: §1 — One-shot adaptive BUDGET retry

**Files:**
- Create: `scripts/lib/budget-retry.mjs` (the helper) OR add to `budget.mjs`
- Modify: `scripts/lib/model-review.mjs`, `scripts/lib/model-consult.mjs`
- Modify: `scripts/lib/reasoning.mjs` (add a small `stepEffortDown` helper if not present)
- Test: `tests/budget-retry.test.mjs`, extend review/consult tests

- [ ] **Step 1: Failing test** (`tests/budget-retry.test.mjs`) using a RECORDING fake `runModel`:
  - Fake returns `{content:"", finishReason:"length"}` on call 1 and valid content on call 2 → `callWithBudgetRetry` resolves with the call-2 attempt; assert call 2 received `maxTokensOverride === min(2×maxTokens, ceiling)` and a `reasoningEffort` one EFFORT_ORDER step below the effective effort.
  - Fake returns empty+length on BOTH calls → `callWithBudgetRetry` throws `MultipolyError` code `BUDGET` (after exactly 2 calls).
  - Fake returns valid content on call 1 → exactly ONE call (no retry).
  - When effective effort is `off` → retry bumps tokens only (effort stays `off`).
  - When `maxTokens` is undefined (NONE model) → retry still happens (effort step-down) without producing `NaN`; bumped override is a sane value (spec: leave override undefined / use ceiling-capped default) — assert no NaN reaches the fake.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.**

```javascript
// scripts/lib/budget-retry.mjs
import { assertContentBudget } from "./budget.mjs";
import { runModel as defaultRunModel } from "./run-model.mjs";
import { resolveReasoningEffort, EFFORT_LEVELS, EFFORT_ORDER } from "./reasoning.mjs";
const MODEL_OUTPUT_CEILING = 131072;

function stepEffortDown(effort) {
  const i = EFFORT_ORDER[effort];
  if (i === undefined || i <= 0) return "off";
  return EFFORT_LEVELS[i - 1];
}

/**
 * Run one model call and enforce the budget; on a BUDGET failure, retry ONCE
 * with more room (2x max_tokens, clamped) and one step less reasoning effort.
 * Returns { attempt, truncated, retried }. Re-throws non-BUDGET errors as-is.
 */
export async function callWithBudgetRetry({
  runModelArgs, mode, maxTokens, budgetContext,
  effectiveEffort, runModelImpl = defaultRunModel,
}) {
  const a1 = await runModelImpl(runModelArgs);
  try {
    const b = assertContentBudget(a1, maxTokens, mode, budgetContext);
    return { attempt: a1, truncated: b.truncated, retried: false };
  } catch (e) {
    if (e.code !== "BUDGET") throw e;
    const bumped = maxTokens ? Math.min(maxTokens * 2, MODEL_OUTPUT_CEILING) : undefined;
    const lowered = stepEffortDown(effectiveEffort);
    const a2 = await runModelImpl({ ...runModelArgs, maxTokensOverride: bumped, reasoningEffort: lowered });
    const b2 = assertContentBudget(a2, bumped ?? maxTokens, mode, budgetContext); // throws BUDGET → propagate
    return { attempt: a2, truncated: b2.truncated, retried: true };
  }
}
```
Export `stepEffortDown` from `reasoning.mjs` instead if you prefer it co-located with EFFORT_ORDER (either is fine; keep ONE definition). The `effectiveEffort` passed in is the already-resolved effort for the call (compute it in the caller via `resolveReasoningEffort` or read `prepared.reasoningEffort` + model baseline).

- [ ] **Step 4: Integrate into `runPreparedReview`.** Replace each `const attemptN = await runModel({...}); assertContentBudget(attemptN, maxTokens, "review", ctx);` with `const { attempt: attemptN } = await callWithBudgetRetry({ runModelArgs: {...}, mode: "review", maxTokens, budgetContext: ctx, effectiveEffort });` where `runModelArgs` is the existing object. Compute `effectiveEffort` once (resolve `prepared.reasoningEffort` against the model baseline). Keep the parse/validate/reprompt logic; attempt2 also goes through `callWithBudgetRetry`.

- [ ] **Step 5: Integrate into `runPreparedConsult`.** Same wrap; use the returned `truncated` for the existing truncation-annotation logic.

- [ ] **Step 6: Run → PASS + full suite** (review/consult/council tests must stay green; council inherits the retry through runPrepared*).

- [ ] **Step 7: Commit**
```bash
git add scripts/lib/budget-retry.mjs scripts/lib/reasoning.mjs scripts/lib/model-review.mjs scripts/lib/model-consult.mjs tests/budget-retry.test.mjs tests/review.test.mjs tests/council.test.mjs
git commit -m "feat: one-shot adaptive BUDGET retry (bump max_tokens + step effort down)"
```

---

## Task 4: §4 — extractJsonObject + centralized JSON parse (prose-wrapped JSON)

**Files:**
- Modify: `scripts/lib/prompts.mjs` (add `extractJsonObject`) and a shared `parseModelJson`
- Modify: `scripts/lib/model-review.mjs`, `scripts/lib/council.mjs` (use the shared helper; remove the two duplicate `tryParseJson`)
- Test: `tests/prompts.test.mjs` (or `tests/json-extract.test.mjs`), extend `tests/review.test.mjs`

- [ ] **Step 1: Failing tests** for `extractJsonObject(text)`:
  - plain JSON object → parses;
  - ```json fenced → parses (after stripCodeFence);
  - prose preamble + JSON (`"I will start…\n{...}"`) → returns the JSON;
  - JSON + trailing prose → returns the JSON;
  - string values containing braces / escaped quotes (`{"a":"}{"}`) → correct span;
  - multiple top-level objects → returns the LARGEST;
  - no object → returns null.
  And for the shared `parseModelJson(text)`: returns `{ok, value}` for any of the above that contain valid JSON, `{ok:false, error}` otherwise.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `extractJsonObject` in `prompts.mjs`: scan for `{`, walk tracking depth, skip string literals (respect `\"` escapes), record each balanced top-level `{...}` span; return the LARGEST by length (or null). Then a `parseModelJson(text)` that does `stripCodeFence` → `JSON.parse`; on throw → `extractJsonObject` → `JSON.parse`; returns `{ok,value}|{ok:false,error}`. Replace the two `tryParseJson` definitions (model-review.mjs, council.mjs) with imports of `parseModelJson`.

> Safe for all transports: `parseModelJson` only invokes the extractor when the direct parse fails, so clean http/anthropic JSON is unaffected. When multiple objects parse, the review/synthesis `validate*` step arbitrates (an extracted non-schema object fails validation → existing reprompt path).

- [ ] **Step 4: Run → PASS + full suite.** Add a review test: a (fake cli) model whose first attempt returns `"prose...\n{valid review json}"` → the review validates without needing the reprompt.

- [ ] **Step 5: Commit**
```bash
git add scripts/lib/prompts.mjs scripts/lib/model-review.mjs scripts/lib/council.mjs tests/prompts.test.mjs tests/review.test.mjs
git commit -m "feat: extract JSON object from prose-wrapped model output (recovers cli members)"
```

---

## Final verification (after all tasks)

- [ ] Full suite green: `node --test tests/*.test.mjs 2>&1 | tail -6`.
- [ ] Sanity: a fake-runner council review where one member returns empty+length recovers via the adaptive retry (covered by a test).
- [ ] Dual review per task: superpowers:code-reviewer AND codex (codex:codex-rescue) on each task's diff.
