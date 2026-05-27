# Reasoning effort + model-naming convention — design (v2)

**Date:** 2026-05-27
**Status:** Draft for review (v2 — revised after a 9-model council review + web verification of provider APIs)

## Problem

Two gaps surfaced while live-testing the full model fleet with a parallel
code review:

1. **No graded reasoning control.** GLM 5.1 ran with thinking on, spent its
   entire `max_tokens` budget on reasoning, and returned empty content
   (`BUDGET` error). Today the only reasoning knob is `MULTIPOLY_THINKING`
   (`on|off|auto`) — a single **server-wide** boolean. There is no per-model
   control, no graded effort, and no per-call control. The http transport only
   sends `thinking: {type:enabled/disabled}`; the anthropic transport sends a
   fixed `budget_tokens`; only the `codex` CLI passes a reasoning flag.

2. **Ambiguous model identity.** The same underlying model is reachable over
   multiple transports (Opus 4.7 via the `claude` CLI *or* the Anthropic API;
   GPT-5.5 via the `codex` CLI *or* the OpenAI API; Gemini via http API, the
   `gemini` CLI, or `agy`). Names don't make transport/version obvious, and
   callers may refer to a model by an alternate name and hit a hard error.

## Verified provider facts (web-checked 2026-05-27 — see §8 for sources)

These corrected several wrong assumptions in v1 and drive the per-model matrix:

- **Anthropic Opus 4.7:** `thinking.budget_tokens` is **removed → 400**. Use
  `thinking: {type:"adaptive"}` (off by default) **+ `output_config.effort`**
  with values `low|medium|high|xhigh|max` (`high` default, `xhigh` Opus-4.7-only,
  `max` ceiling). Non-default `temperature`/`top_p`/`top_k` also **400**.
  `budget_tokens` survives only on older models (Opus 4.6 / Sonnet 4.6, min
  1024, `< max_tokens`).
- **DeepSeek V4 Pro:** accepts `reasoning_effort` but only `high`/`max`
  (`low`/`medium`→`high`, `xhigh`→`max`); `extra_body.thinking.{type}` toggles
  thinking off. (The legacy `deepseek-reasoner` reasons unconditionally — not
  our model.)
- **Qwen 3.7 Max (DashScope):** does **not** accept `reasoning_effort`; uses
  `enable_thinking` (bool) + `thinking_budget` (int) in `extra_body`. Qwen 3.7
  Max is **thinking-only — thinking cannot be disabled**.
- **Gemini 3.5 Flash (OpenAI-compat):** accepts `reasoning_effort` =
  `none|minimal|low|medium|high`, mapped to a thinking budget/level. Thinking
  **cannot be fully disabled** on Gemini-3-class models (`none` only disables
  on 2.5-Flash-class).
- **Kimi K2.6 (Moonshot, Anthropic-compatible at `api.kimi.com/coding`):** the
  `thinking:{type:enabled/disabled, keep}` object is correct, but
  **`budget_tokens` is undocumented and a no-op (drop it)** — depth is governed
  by `max_tokens`. K2.6 also locks temperature; don't send off-spec values.
- **Xiaomi MiMo V2.5 Pro:** http/OpenAI-compat (`mimo-v2.5-pro`); reasoning via
  the top-level `thinking:{type:enabled/disabled}` toggle (no graded effort),
  output in `reasoning_content`; expects `max_completion_tokens`.

## Goals

- A single graded reasoning-effort scale, settable at four precedence layers,
  mapped onto each backend's **verified, per-model** native mechanism.
- Sensible per-model defaults so the fleet reasons well out of the box without
  starving output (the GLM failure must not recur with default config).
- A clear `<model> (<agent/transport>)` display-name convention, transport and
  version chosen at config time, tool name stable.
- Lenient model-name resolution wherever the server controls the lookup —
  **routing by exact+alias only; fuzzy matching for error hints only.**

## Non-goals

- No 400-probe "send and retry" to discover capability — capability is tagged
  statically per model (§2), because probing doubles latency, breaks prompt
  caching, and risks rate limits.
- `gpt5.5 (api)` and `gemini-3.1-pro (gemini cli)` are named by the convention
  but stay dormant until credentials/binaries are configured.

---

## 1. Reasoning-effort scale

Ordinal scale plus an `inherit` sentinel:

```
off  <  low  <  medium  <  high  <  xhigh        (+ inherit)
```

- `inherit` = unset; resolution falls through to the next precedence layer,
  ending at the model's baked default. **A baked default may never be
  `inherit`** (validated at registry-build time). Env value `inherit` ≡ unset.
- The per-call tool argument has **no `inherit` value**; omitting the argument
  *is* `inherit`.
- `off` means "minimum reasoning." For **thinking-only models that cannot
  disable reasoning** (qwen-3.7-max, gemini-3-class), `off` maps to the
  smallest budget / `minimal`, not a true disable, and that is documented in
  the tool description.
- `xhigh` is the scale ceiling. It maps to each backend's top (Anthropic
  `xhigh`, DeepSeek `max`, OpenAI `high`); Anthropic's `max` is reachable only
  via the per-model raw escape hatch (below), not the scale.

### Precedence (fully ordered, highest wins)

```
1. per-call tool argument  (reasoning_effort on the *_review/*_consult/council_* tool)
2. MULTIPOLY_<KEY>_REASONING_EFFORT        (per-model env)
3. MULTIPOLY_<KEY>_THINKING                (per-model legacy alias, mapped)
4. MULTIPOLY_REASONING_EFFORT              (server-wide env)
5. MULTIPOLY_THINKING / GLM_THINKING       (server-wide legacy alias, mapped)
6. MODEL_INFO baked default                (per-model)
```

Rule: a **per-model** signal always outranks a **server-wide** one; within the
same scope, the new `*_REASONING_EFFORT` form outranks the legacy `*_THINKING`
form. The MCP `env` block in `~/.claude.json` / Codex config is just how the
env layers are supplied — not a separate layer.

### Legacy `THINKING` → effort mapping

| `*_THINKING` | effort |
| --- | --- |
| `off` | `off` |
| `on`  | `medium` |
| `auto`| `inherit` |

A one-time structured stderr note logs when a legacy var is the effective
source, pointing at the new var.

### Raw escape hatch (per-model env, power users)

- `MULTIPOLY_<KEY>_MAX_TOKENS_{REVIEW,CONSULT}` — existing.
- `MULTIPOLY_<KEY>_THINKING_BUDGET` — explicit integer for the `budget`-style
  backends (older-anthropic `budget_tokens`, qwen `thinking_budget`). Bypasses
  the scale→budget computation. Must satisfy that backend's constraints
  (e.g. ≥1024 and `< max_tokens` for anthropic).
- `MULTIPOLY_<KEY>_EFFORT_RAW` — pass an exact backend effort string
  (e.g. anthropic/`deepseek` `max`) verbatim, for reaching values above the
  scale ceiling. Validated against the model's known vocabulary.

---

## 2. Per-model reasoning capability + mapping

Replace the boolean `supportsThinking` with a per-model capability descriptor
in `MODEL_INFO` (keep `supportsThinking` as a derived getter: `true` unless
capability is `none`). **Capability is a static per-model property — it is NOT
derived from `transport`** (DeepSeek and GLM are both http but behave
differently).

| capability | mechanism | applies to (verified) |
| --- | --- | --- |
| `none` | no control; effort ignored, param hidden from schema | models with no reasoning control |
| `http_thinking_toggle` | http `thinking:{type:enabled/disabled}` (top-level) | `glm` (z.ai), `mimo` (Xiaomi MiMo) |
| `qwen_budget` | http `extra_body.enable_thinking=true` (always) + `extra_body.thinking_budget:int` | `qwen` (DashScope) — cannot disable |
| `openai_effort` | http top-level `reasoning_effort:string` (+ optional `extra_body.thinking` to disable) | `deepseek` (high/max), `gemini` (none..high), `codex` http |
| `anthropic_effort` | `thinking:{type:adaptive}` + `output_config.effort` | Opus 4.7+ on anthropic transport |
| `anthropic_budget` | `thinking:{type:enabled, budget_tokens}` (legacy) | older anthropic models (Opus 4.6 / Sonnet 4.6) |
| `kimi_toggle` | anthropic `thinking:{type:enabled/disabled}` — **no budget_tokens** | `kimi` (K2.6) |
| `cli:<kind>` | per-agent flag (§4) | cli transport |

### Scale → backend mapping

| effort | `http_thinking_toggle` (glm / mimo) | `qwen_budget` | `openai_effort` (deepseek / gemini) | `anthropic_effort` (Opus 4.7) | `anthropic_budget` (legacy) | `kimi_toggle` |
| --- | --- | --- | --- | --- | --- | --- |
| `off` | `disabled` | smallest budget (cannot disable) | deepseek: `thinking:disabled`; gemini: `none`→`minimal` (cannot disable) | omit `thinking` | omit `thinking` | `disabled` |
| `low` | `enabled` + floor | ~25% budget | deepseek `high`; gemini `low` | effort `low` | ~25% budget* | `enabled` |
| `medium` | `enabled` | ~40% budget | deepseek `high`; gemini `medium` | effort `medium` | ~40%* | `enabled` |
| `high` | `enabled` | ~60% budget | deepseek `high`; gemini `high` | effort `high` | ~60%* | `enabled` |
| `xhigh` | `enabled` | ~80% budget | deepseek `max`; gemini `high` | effort `xhigh` | ~80%* (bounded) | `enabled` |

\* **`anthropic_budget` / `qwen_budget` clamp (fixed from v1):** compute
`raw = round(fraction × max_tokens)`, then **pre-check**:
`if max_tokens < MIN_THINKING_BUDGET(1024) + MIN_OUTPUT_RESERVE → skip thinking
(omit the field) and log`. Otherwise
`budget = min(max(raw, 1024), max_tokens − MIN_OUTPUT_RESERVE)`, and assert the
upper bound `> 1024` (else skip). This removes the v1 inverted-interval bug.

**GLM / MiMo (`http_thinking_toggle`) floor:** GLM and MiMo have no graded levels, so `low|medium|high|xhigh`
all `enable`. The real fix for the empty-response bug is token headroom — set a
concrete **default `MAX_TOKENS_{REVIEW,CONSULT}` floor for GLM** (constant:
`GLM_THINKING_MAX_TOKENS_FLOOR = 8192` review / 4096 consult, applied to both
modes; tuned so a thinking-on review reliably leaves output room). The floor is
a *default* only — an explicit `MULTIPOLY_GLM_MAX_TOKENS_*` or per-call
`max_tokens` still wins (but if a caller sets a tiny cap with thinking on,
`assertContentBudget` already surfaces a `BUDGET` error with guidance). Note
the floor alone does not *guarantee* output (a model can still spend the whole
cap reasoning); `off` remains the hard guarantee.

**Anthropic transport rewrite:** the existing `anthropic.mjs` sends
`thinking:{type:"enabled", budget_tokens}`, which **400s on Opus 4.7** (latent
bug — currently unhit because Opus is reached via the `claude` CLI and `kimi`
ignores the field). The transport must branch on capability:
`anthropic_effort` → `{thinking:{type:"adaptive"}, output_config:{effort}}` and
**must not send `temperature`/`top_p`/`top_k`** for Opus-4.7-class;
`anthropic_budget` → legacy `budget_tokens` path; `kimi_toggle` → bare
`thinking:{type}` with **no** `budget_tokens`.

**`openai_effort` value fitting + fallback:** map the scale to each model's
*known* vocabulary (deepseek: only `high`/`max`; gemini: `none..high`). Because
capability is tagged statically, no live 400-probe is needed; but keep a single
defensive catch that, on a `reasoning_effort`-shaped rejection, retries once
without the field and logs `reasoning_effort_unsupported` (covers proxies /
version drift), mirroring the existing `json_schema → json_object` fallback.

### Shared resolver

Generalize `resolveThinkingPreference()` to
`resolveReasoningEffort({ perCall, config, modelKey, mode })` returning a scale
value, plus thin per-capability adapters
(`effortToGlmThinking`, `effortToQwenBudget`, `effortToOpenAiEffort`,
`effortToAnthropicEffort`, `effortToAnthropicBudget`, `effortToKimiThinking`,
`effortToCliArgs`). One resolver, one place to test precedence.

---

## 3. Model-naming / transport convention

Display name = **`<model> (<agent-or-transport>)`**. Tool **key** stays a bare
identifier so it maps to `MULTIPOLY_<KEY>_*` and `<key>_review`. Transport,
model, and version are config-time choices (`MULTIPOLY_<KEY>_TRANSPORT`,
`_MODEL`, `_DISPLAY_NAME`). Builtins get baked display-name defaults.

**Registry change:** `claude`, `codex`, `gemini`, `kimi`, `agy` are currently
*custom* models (configured via `MULTIPOLY_MODELS` in the deployment env);
`MODEL_KEYS` builtins are only `glm`/`qwen`/`deepseek`/`composer`. This design
**promotes `claude`, `codex`, `gemini`, `kimi` to first-class entries in
`MODEL_INFO`** (so they carry baked capability + display-name + default-effort
without per-deployment env), while keeping the same keys. `agy` stays a
cli-only entry. (This is a real change — the v1 table implied they were already
builtins; they were not.)

| key | default display name | underlying | default transport | notes |
| --- | --- | --- | --- | --- |
| `claude` | `opus (claude cli)` | Opus 4.7 | cli | `=anthropic` → `opus (api)` |
| `codex` | `gpt5.5 (codex cli)` | GPT-5.5 | cli | `=http` → `gpt5.5 (api)` |
| `gemini` | `gemini-3.5-flash (api)` | Gemini 3.5 Flash | http | cli → `gemini-3.1-pro (gemini cli)` |
| `agy` | `gemini-3.5-flash (agy cli)` | Gemini 3.5 Flash | cli (agy) | distinct agent, own key |
| `kimi` | `kimi-k2.6 (api)` | Kimi K2.6 | anthropic | |
| `glm` | `glm-5.1 (api)` | GLM 5.1 | http | |
| `qwen` | `qwen3.7-max (api)` | Qwen 3.7 Max | http | thinking-only |
| `deepseek` | `deepseek-v4-pro (api)` | DeepSeek V4 Pro | http | |
| `composer` | `composer-2.5 (cursor cli)` | Composer 2.5 | cli (cursor) | |
| `mimo` | `mimo-v2.5-pro (api)` | Xiaomi MiMo V2.5 Pro | http | NEW — `http_thinking_toggle`; recognizes `XIAOMIMIMO_*` env aliases |

### `opus` folds into `claude` (alias)

The standalone `opus` Anthropic builtin (`OPUS_INFO`) is removed as a distinct
model:

- `claude` is the single canonical "Opus 4.7" slot; transport configurable
  (`cli` default → `opus (claude cli)`, `anthropic` → `opus (api)`).
- `opus_review`/`opus_consult` register as **alias tools** routing to the
  `claude` handler; `opus` resolves to `claude` in arguments.
- Symmetrically `codex` is the single GPT-5.5 slot, `gpt55` aliased to it.

**Transport-default safety (consensus F):** to avoid silently flipping the old
Anthropic-API `opus` to a local CLI: if `ANTHROPIC_API_KEY` (or legacy
`MULTIPOLY_OPUS_*`) is present and no Claude CLI auth is detected, default
`claude`'s transport to `anthropic`, not `cli`; otherwise log the chosen
transport at startup.

---

## 4. Lenient model-name resolution

**MCP constraint:** the client rejects a call to an unregistered tool before the
server sees it, so unbounded tool-name fuzziness is impossible. Leniency lives
where the server controls the lookup:

1. **Model-name arguments** — `council_*`'s `models[]` / `synthesizer`.
   `resolveModelAlias(raw, configuredKeys)`:
   normalize (lowercase, strip `-_. `) → **exact key** → **alias table** →
   **(no silent nearest-match routing)**. If unresolved, throw `INVALID_INPUT`
   listing valid configured names, and *only then* compute a nearest-match for
   a "did you mean `<key>`?" hint (similarity threshold; ambiguous within the
   threshold → no suggestion). **Routing is exact+alias only** — this closes the
   v1 silent-misroute / wrong-billing / `codexx`-hijacks-`codex` hazard.
   - Must **not** remap the synthesizer sentinels `harness`/`none`/`caller`.
   - Must **not** strip a `_review`/`_consult` suffix (would break a custom key
     legitimately ending in those); match the whole token.
   - Wire `resolveModelAlias` into `resolveCouncilModels` (today strict
     `known.includes`) and dedup after resolution: if aliases collapse members
     to the same key (`[gpt, codex] → [codex]`), dedup silently; a single
     remaining member is an error (council needs ≥2).

2. **Alias table** (seed; extensible):

   | aliases | → key |
   | --- | --- |
   | `gpt`, `gpt5`, `gpt55`, `gpt-5.5`, `openai` | `codex` |
   | `opus`, `claude-opus`, `opus-4.7` | `claude` |
   | `flash`, `gemini-flash`, `gemini-3.5` | `gemini` |
   | `zhipu`, `glm5.1` | `glm` |
   | `k2`, `moonshot` | `kimi` |
   | `cursor` | `composer` |
   | `deepseek-v4` | `deepseek` |
   | `qwen-max` | `qwen` |
   | `xiaomi`, `mi-mo` | `mimo` |

3. **Alias tools** — a curated set routing to a canonical handler:
   `opus_*` → `claude` (confirmed wanted) and `gpt55_*` → `codex` (symmetry,
   trimmable). Kept minimal.

4. **Enriched descriptions** — each canonical tool names its display name +
   aliases so the calling harness picks correctly up front, and (for
   thinking-only models) notes that `off` is "minimum reasoning."

---

## 5. Tool-surface changes

- Add optional `reasoning_effort` enum (`off|low|medium|high|xhigh`) to every
  `*_review`/`*_consult` and `council_*` tool **except `none`-capability
  models** (param omitted there so callers aren't misled). Highest precedence.
- Update the runtime validator key spec (`REVIEW_KEYS`/`CONSULT_KEYS`/
  council extra keys) **and** the advertised JSON-Schema enums together — the
  anti-drift test already asserts tools/handlers/validator agree; extend it to
  cover the new key + the alias tools.
- `buildServerSurface` emits the curated alias tools routed to canonical
  handlers.
- Alias resolution for council `models[]`/`synthesizer` runs before enum
  validation.

---

## 6. Testing (TDD)

- `resolveReasoningEffort` full precedence (1–6 above); `inherit` fallthrough;
  baked-default-not-`inherit` validation; legacy-alias mapping + new-wins.
- Per-capability adapters: glm enable/disable; qwen budget (incl. cannot-disable
  → `off`=min budget); openai effort fitting (deepseek `high`/`max`, gemini
  `none..high`, `xhigh→` each ceiling); anthropic_effort shape
  (`thinking:adaptive`+`output_config.effort`, **no temperature/top_p/top_k**);
  anthropic_budget clamp **incl. the inverted-interval skip case and ≥1024 /
  `<max_tokens` bounds**; kimi (no `budget_tokens` emitted).
- **Regression:** GLM default config (with the new max_tokens floor) does not
  return empty on a thinking-on review; and Opus-4.7 anthropic path never emits
  `budget_tokens` (guards the latent 400).
- `openai_effort` reject-fallback: simulated rejection retries without the field.
- `resolveModelAlias`: exact/alias hits; **no silent nearest-match routing**;
  sentinel protection; suffix-not-stripped; ambiguous → error with optional
  hint; council dedup after alias collapse; `codexx` custom key does NOT hijack
  `codex`.
- Display-name defaults follow the convention; `claude` transport switch flips
  `opus (claude cli)` ↔ `opus (api)`.
- Migration: a `MULTIPOLY_OPUS_*` var present at startup emits the warning.
- Anti-drift: advertised tools (incl. aliases) ≡ handlers ≡ validator keys.

## 7. Migration / compatibility notes

- **`OPUS_INFO` removed as a distinct model.** Startup scans for
  `MULTIPOLY_OPUS_*` (and `MULTIPOLY_GPT55_*`) and emits a **loud structured
  stderr warning** pointing at the canonical `MULTIPOLY_CLAUDE_*` /
  `MULTIPOLY_CODEX_*` keys, so those vars don't silently become no-ops.
  `opus_*` tools still exist (aliases to `claude`) — no tool-name break.
- **Transport-flip guard** (§3) prevents an API→CLI silent regression.
- **Anthropic transport rewrite** (§2) — required for Opus 4.7 correctness and
  to stop sending `budget_tokens`/temperature to it.
- `MULTIPOLY_THINKING` continues to work (mapped per §1).
- **CLI reasoning flags** beyond `codex` (`claude`, `gemini`, `cursor`, `agy`)
  must be **verified against each binary** during implementation; where an
  agent has no reasoning flag, effort is a logged no-op and the display/desc
  says so (do not guess flags).
- **Xiaomi MiMo (`mimo`)** — http/OpenAI-compatible, model id `mimo-v2.5-pro`,
  base URL `https://token-plan-sgp.xiaomimimo.com/v1` (or `api.xiaomimimo.com/v1`).
  Capability `http_thinking_toggle` (`thinking:{type:enabled/disabled}`, no
  graded effort) — same class as GLM, gets the same max_tokens floor. Reasoning
  returns in `reasoning_content` (already parsed by the http client). Two quirks:
  it expects **`max_completion_tokens`** rather than legacy `max_tokens` (needs a
  per-model flag to emit the former), and multi-turn tool calls must echo
  `reasoning_content` (N/A for single-shot review/consult). The `mimo` builtin
  recognizes the existing `XIAOMIMIMO_API_KEY` / `XIAOMIMIMO_BASE_URL_OPENAI`
  env names as aliases (mirroring glm's `ZHIPU_API_KEY`/`GLM_API_KEY`).
- Defaults: `high` everywhere except `claude`/`codex` at `xhigh`; for
  thinking-only `qwen`/`gemini`, `high` is honored, `off` is min-reasoning.

## 8. Sources (verified 2026-05-27)

- Anthropic Opus 4.7 / effort / adaptive thinking:
  `platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7`,
  `…/build-with-claude/effort`, `…/build-with-claude/adaptive-thinking`,
  `…/build-with-claude/extended-thinking`.
- DeepSeek thinking mode: `api-docs.deepseek.com/guides/thinking_mode`,
  `…/guides/reasoning_model`.
- Qwen/DashScope deep thinking: `alibabacloud.com/help/en/model-studio/deep-thinking`,
  `…/compatibility-of-openai-with-dashscope`.
- Gemini OpenAI-compat reasoning_effort: `ai.google.dev/gemini-api/docs/openai`.
- Kimi/Moonshot: `kimi.com/code/docs/en/`,
  `platform.kimi.ai/docs/guide/kimi-k2-6-quickstart`,
  `platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model`.
- Xiaomi MiMo: `platform.xiaomimimo.com/docs/en-US/api/chat/openai-api`.
