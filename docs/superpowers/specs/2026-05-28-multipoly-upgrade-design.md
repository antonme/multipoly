# Multipoly upgrade — large-PR council reliability (design)

**Date:** 2026-05-28
**Status:** Draft for codex + council review
**Source:** `docs/superpowers/2026-05-28-field-feedback-large-pr-councils.md` (real
large-PR `council_review` run; 3/10 members lost to budget/schema, a whole review
blocked by scanner false-positives, an opaque IPv6 hang, 2× payload bloat).

## Goal

Make `council_review` (and the single-model paths) reliable on the workload they
are most useful for — large diffs reviewed by a many-model panel — by fixing the
six observed failure modes without weakening the safety guards that work.

## Non-goals

- No new transports or providers.
- No change to the reasoning-effort scale / capability model (Plans A/B/C).
- The secret scanner stays **hard-fail by default**; we improve precision and add
  a per-call escape, but do not switch to silent report-and-redact as the default.

## Decomposition (three plans)

- **Plan D1 — quick wins (low risk):** §5 IPv6/happy-eyeballs, §6 error
  surfacing, §2 payload de-duplication + compact mode.
- **Plan D2 — reliability core:** §1 token budgets + one-shot adaptive retry,
  §4 CLI JSON extraction/repair.
- **Plan D3 — scanner precision + per-call override (security-sensitive):** §3,
  plus the docs caveat (§7).

Each plan is independently shippable and leaves the suite green.

---

## §5 — HTTP resilient to broken-IPv6 dual-stack endpoints (Plan D1)

**Problem:** On Node 18, undici happy-eyeballs (`autoSelectFamily`) is OFF by
default. An endpoint that resolves to both A and AAAA with a black-holed IPv6
path (observed: Alibaba qwen endpoint) hangs until `UND_ERR_CONNECT_TIMEOUT`.

**Design:** At server startup, enable happy-eyeballs process-wide using the
public Node API (no new dependency):

```js
// scripts/multipoly-mcp.mjs, in main() before serving (and guarded for old Node)
import { setDefaultAutoSelectFamily } from "node:net";
if (typeof setDefaultAutoSelectFamily === "function") setDefaultAutoSelectFamily(true);
```

`setDefaultAutoSelectFamily` is public since Node 18.13. This makes the built-in
`fetch` race A/AAAA and fall back, so a black-holed AAAA no longer hangs the call.
Document `NODE_OPTIONS=--dns-result-order=ipv4first` as the operator escape hatch
and note Node 20+ has this on by default. Keep min runtime at Node ≥18.13.

**Tests:** unit-test a small helper `enableHappyEyeballs(net)` that calls
`setDefaultAutoSelectFamily(true)` when present and is a no-op otherwise (inject a
fake `net` with/without the function). We do not integration-test real IPv6.

---

## §6 — Surface failure causes and panel attrition (Plan D1)

**Problem:** `qwen`'s failure surfaced only as `network error: fetch failed` with
no `cause.code`. Council attrition (3/10 failed) was only discoverable by diffing
`member_status`.

**Design:**
1. **Error cause in the HTTP transport.** In `client.mjs` `callWithRetry`, the
   network-error branch wraps as `HTTP: network error: ${e.message}`. Include the
   underlying code: `e.cause?.code ?? e.code` (e.g. `UND_ERR_CONNECT_TIMEOUT`,
   `ENOTFOUND`) in both the message and `details` (e.g.
   `details: { cause: e.cause?.code ?? e.code }`). Never include addresses that
   could leak; the code is safe.
2. **Council failure summary.** Add a `failure_summary` string to BOTH council
   result shapes (harness-defer and server-synthesis), derived from
   `member_status`: e.g. `"3/10 members failed: glm (BUDGET), kimi (BUDGET), agy
   (SCHEMA)"` (empty string when all succeeded). For the harness-defer **consult**
   text, prepend the summary line so a human/harness sees attrition immediately.
   `member_status` already carries the per-member code; this is a derived
   convenience, additive (no field removed).

**Tests:** client unit test asserting a simulated `fetch` rejection with a
`.cause.code` surfaces that code in the MultipolyError details. Council unit test
asserting `failure_summary` content for a mixed ok/fail panel and `""` for an
all-ok panel.

---

## §2 — Council payload: kill duplication, add compact mode (Plan D1)

**Problem:** `council_review` harness output carried both a `members` block
(trimmed findings + summary per model) AND, when `include_individual_results`, a
`member_results` block that re-embeds each member's **full** review result —
including a per-member copy of the file roster — roughly doubling an already
context-busting payload (observed 114k–156k chars).

**Design:**
1. **De-duplicate.** `members` (findings + `summary_md` for ok members) +
   `member_status` (ok/fail + finding count + error code) already cover the
   success case. Change `include_individual_results` so `member_results` carries
   ONLY what `members`/`member_status` lack: for **failed** members, the full
   serialized error; for ok members, nothing extra (their findings are already in
   `members`). Concretely: stop embedding the full per-member review result
   (with its duplicate `files`/`schema_version`/`model`/`truncated`) — at most
   include the ok members' findings once, which `members` already has, so the ok
   branch contributes nothing new. Net effect: `include_individual_results` adds
   failed-member diagnostics, not a second copy of the panel.
2. **Compact mode.** Add an optional `compact` boolean to `council_review` (and
   `council_consult` where meaningful). When true, `members` carries findings
   only (drop the per-model `summary_md` prose). This is the lever for very large
   panels where the prose summaries are the bulk.
3. **Large-payload hint, not auto-synthesis.** Do NOT silently switch large
   councils to server-side synthesis (surprising default; changes billing/owner
   of the merge). Instead, when the assembled harness payload is large (≥ a
   threshold, e.g. 80k chars), append a one-line hint to the result advising the
   caller to pass a `synthesizer` (or set `MULTIPOLY_SYNTHESIZER`) or `compact:
   true`. (Open for codex: should the threshold instead flip the default? Leaning
   no.)

**Tests:** council unit tests: (a) `include_individual_results` no longer
duplicates ok-member findings / file roster (assert the result does not contain
two copies of a member's findings; assert failed-member error is present);
(b) `compact: true` omits `summary_md` from members; (c) the large-payload hint
appears past the threshold and is absent below it.

---

## §1 — Token budgets + one-shot adaptive retry (Plan D2)

**Problem:** For reasoning models the `max_tokens` ceiling covers reasoning +
content. Defaults are too low for large reviews: glm (8192 floor) and kimi
(16384 anthropic default) both `BUDGET`-failed with empty bodies — reasoning ate
the whole budget. The current floor only applies to `GLM_TOGGLE`; other reasoning
capabilities get the operator's cap or a provider default with no floor.

**Design — two layers:**

### (a) Raise review/consult floors for ALL reasoning-capable capabilities

Generalize the floor in `resolveModelMaxTokens` (`config.mjs`) from "GLM_TOGGLE
only" to "any reasoning-capable capability" (`GLM_TOGGLE`, `QWEN_BUDGET`,
`OPENAI_EFFORT`, `ANTHROPIC_EFFORT`, `ANTHROPIC_BUDGET`, `KIMI_TOGGLE`; NOT
`NONE`). New default floors (applied only when neither per-model nor server cap
is set explicitly):

```
REASONING_REVIEW_FLOOR  = 32768   (was 8192 for GLM_TOGGLE)
REASONING_CONSULT_FLOOR = 8192    (was 4096 for GLM_TOGGLE)
```

Clamp the floor to `MODEL_OUTPUT_CEILING` (131072). The floors are *defaults*: an
explicit `MULTIPOLY_<K>_MAX_TOKENS_*` or server cap still wins. Also raise the
anthropic transport `DEFAULT_MAX_TOKENS` fallback (16384) so kimi/anthropic
inherit a 32768 review default when no cap is configured (reuse the same floor
via `resolveMaxTokensForModel`, so the transport default is only the last resort).

> **Provider-ceiling risk (flag for codex):** 32768 must not exceed a provider's
> output ceiling (→ 400). The providers we ship (glm 131072, qwen, deepseek,
> gemini, kimi, mimo) all support ≥32k output, so 32768 is safe for the builtins.
> For unknown custom models the floor still applies; if that's a risk, gate the
> floor on known builtins only. Leaning: apply to all reasoning-capable, document
> the override.

### (b) One-shot adaptive BUDGET retry

When a call fails the budget check, retry the SAME model once with more room,
then give up (instead of dropping the member):

- **Where:** a helper `runModelWithBudgetRetry({...runModelArgs, mode, maxTokens,
  budgetContext})` that wraps `runModel` + `assertContentBudget`. Used by
  `runPreparedReview` and `runPreparedConsult`, so council members (which call
  `runPrepared*` per member) inherit it automatically, as do single-model calls.
- **Retry strategy:** on a `BUDGET` outcome (assertContentBudget throws, or
  `finish_reason==="length"` with empty/too-short content), re-issue once with:
  1. `maxTokensOverride = min(2 × current, MODEL_OUTPUT_CEILING)`, AND
  2. `reasoningEffort` stepped DOWN one level via `EFFORT_ORDER` (e.g. high→medium;
     `off` is the floor — if already `off`, only the token bump applies).
  Then re-check budget; if it still fails, surface the BUDGET error (now with a
  note that an adaptive retry was attempted).
- **Plumbing:** `runModel` and the three transports accept an optional
  `maxTokensOverride` that supersedes `resolveMaxTokensForModel(...)` for that
  call. `reasoningEffort` already threads through as a per-call override.
- **Budget-fraction models** (`QWEN_BUDGET`, `ANTHROPIC_BUDGET`) compute
  `thinking_budget` as a fraction of `max_tokens`, so a higher `maxTokensOverride`
  raises both thinking and output proportionally while preserving the output
  reserve (the existing clamp). Stepping effort down further frees output room.

**Tests:** 
- `resolveModelMaxTokens`: each reasoning capability gets the 32768/8192 floor by
  default; `NONE` does not; explicit caps still win; clamp to ceiling.
- `runModelWithBudgetRetry`: a fake model that returns empty+length on attempt 1
  and valid content on attempt 2 → succeeds, and the second call received a
  higher `maxTokensOverride` and a stepped-down effort (assert via a recording
  fake `runModel`). A model that fails twice → BUDGET error surfaced. A model
  that succeeds on attempt 1 → no retry (one call only).
- Regression: single-model + council review still pass with the wrapper in place.

---

## §4 — CLI members that emit prose, not JSON (Plan D2)

**Problem:** `agy` returned prose ("I will start by listing the directory…")
instead of the review JSON, failing schema validation at position 0. Agentic CLI
models "think out loud."

**Design:**
1. **Extractor.** Add `extractJsonObject(text)` to `prompts.mjs` (next to
   `stripCodeFence`). Algorithm: run `stripCodeFence` first; if the result parses,
   use it; else scan for the first top-level `{`, walk forward tracking brace
   depth while respecting string literals and escapes, and return the balanced
   `{...}` span. Returns `null` when no balanced object is found.
2. **Use it in the parse path.** Centralize the two duplicated `tryParseJson`
   helpers (`model-review.mjs`, `council.mjs`) into one shared helper (in
   `prompts.mjs` or `schema.mjs`) that does: `stripCodeFence` → `JSON.parse`; on
   failure → `extractJsonObject` → `JSON.parse`; returns `{ok, value|error}`.
   Apply to ALL transports' review/synthesis output (harmless for already-clean
   JSON; recovers prose-wrapped JSON from any model, not just cli).
3. **Keep the reprompt loop.** The existing JSON-only reprompt
   (`flattenMessages` directive + `REVIEW_JSON_ONLY_PREFIX`) stays as the second
   line of defense if extraction still fails.

**Risk (flag for codex):** extracting the "first balanced brace span" could grab
the wrong object if a model emits prose containing an unrelated `{...}` before the
real answer. Mitigation: prefer the LARGEST balanced top-level object, or the one
that validates against the schema; if multiple, the last/largest. Spec the
extractor to return the largest top-level object and let validation arbitrate.

**Tests:** `extractJsonObject` unit tests: plain JSON; ```json fenced; prose
preamble + JSON; JSON + trailing prose; nested braces + strings containing
braces/escaped quotes; no-object → null; multiple objects → largest. Plus a cli
review test where the model returns prose+JSON and the review still validates.

---

## §3 — Secret-scanner precision + per-call override (Plan D3)

**Problem:** The first `council_review` was fully blocked by false positives. The
`env_style_secret` and `generic_api_secret_assignment` patterns use `/i`, so the
uppercase keyword group matches camelCase identifiers (`headerToken`,
`registryKey`) and the `[^\s"']{16,}` RHS matches ordinary code
(`stringValue(value.key);`, URLs, template literals). The only override is the
global `MULTIPOLY_ALLOW_SECRETS=1` env (requires a server restart; all-or-nothing).

**Design — three parts (security-sensitive; codex review required):**

### (a) Precision: drop `/i` on the unquoted env pattern; add code-RHS suppression

- **`env_style_secret`** (unquoted `NAME=value`): remove the `/i` flag so it only
  matches a SCREAMING_CASE keyword (`API`/`SECRET`/`TOKEN`/`PASSWORD`/`PASS`/`KEY`
  with `[A-Z0-9_]` neighbors). `headerToken=` (camelCase) no longer matches. This
  alone removes the camelCase-identifier class of false positives. (`API_KEY=...`
  remains matched — it is SCREAMING_CASE by convention.)
- **`generic_api_secret_assignment`** (quoted `name: "value"`): KEEP `/i` (config
  files legitimately use lowercase `api_key`/`apiKey`), but add a **code/URL RHS
  suppressor**: when the pattern matches, extract the quoted value and DROP the
  hit if the value `looksLikeNonSecret`:
  - starts with a backtick (template literal) or contains `${`,
  - matches `^[A-Za-z_$][\w$]*\s*\(` (a function call like `stringValue(...)`),
  - starts with `req.` / `process.env` / `value.` / `this.` / `config.` (a member
    reference),
  - matches `^https?://` (a URL).
  Real secrets are opaque high-entropy blobs, not code expressions. The dedicated
  high-precision patterns (`openai_style_sk_key`, `github_token`, `aws_*`,
  `slack_*`, `pem_private_key`) are UNCHANGED — they catch the actual-secret case.

> The unquoted pattern's RHS is `[^\s"']{16,}` (no quotes), which is where the
> `stringValue(value.key);` / URL false positives came from. Apply the same
> `looksLikeNonSecret` suppressor to BOTH patterns (the suppressor inspects the
> matched RHS span). Keep ReDoS-hardening (bounded quantifiers) intact.

### (b) Per-call `allow_secrets` override

Add an optional `allow_secrets` boolean to `*_review`, `*_consult`, and
`council_*` tool schemas + the runtime validator. Thread it from the tool input
into `prepareReview`/`prepareConsult` and council's `assertMemberOutputsClean`,
where the gate becomes `config.allowSecrets || input.allow_secrets`. One run can
bypass the scanner without a global env change + restart. The global
`MULTIPOLY_ALLOW_SECRETS` env still works.

### (c) Keep hard-fail default; no redact-by-default

Hard-fail with the precise hit list remains the default (redaction silently alters
the payload the model reviews). Report-and-redact stays out of scope (note as a
possible future opt-in mode).

**Tests:**
- The five documented false positives (`headerToken`, `registryKey`,
  `const key = stringValue(value.key);`, `GITHUB_API_BASE = 'https://...'`,
  `` `${base}?token=${...}` ``) now scan **clean**.
- True positives still caught: `API_KEY=AKIA...`/`sk-...`/`ghp_...`, and a real
  SCREAMING_CASE `FOO_API_KEY="<40-char-opaque-blob>"` quoted assignment.
- A real opaque secret on the RHS of a quoted lowercase `api_key: "<blob>"` is
  still flagged (suppressor only drops code/URL-shaped values).
- Per-call `allow_secrets: true` lets a payload with a (real-looking) secret
  through `prepareReview`; `false`/absent still blocks. Anti-drift: the new key is
  in tool schema + validator together.

---

## §7 — Docs caveat: council consensus ≠ ground truth (Plan D3)

In the field run, 4/7 members mis-rated a fail-closed auth guard as a "blocker"
by pattern-matching the wrong middleware. Add a short README section: **council
output is a strong candidate-finding generator, not ground truth** — verify
severity (especially security) against the actual code before acting. Optionally
note that callers can ask members to state confidence + cite the specific
line/guard they verified. Also document (from §1) the `*_MAX_TOKENS_REVIEW`
knobs as the lever for large reviews, and (from §5) the IPv6 escape hatch.

---

## Resolved decisions (2026-05-28)

(An async codex design-review round was attempted but the codex-companion's
background mechanism could not return output in-band; these are the implementer's
decisions, to be challenged by codex's per-task diff reviews during the build and
by any late design-review feedback.)

1. **§1 floors:** 32768 review / 8192 consult, applied to ALL reasoning-capable
   capabilities (capability !== NONE), clamped to `MODEL_OUTPUT_CEILING`. Safe for
   every shipped builtin (all support ≥32k output). For a custom reasoning model
   whose provider caps lower, the explicit `MULTIPOLY_<K>_MAX_TOKENS_REVIEW` wins;
   document this. (A too-high cap would surface as a provider 4xx, not a silent
   loss — acceptable and operator-correctable.)
2. **§1 retry:** Bump max_tokens (2×, clamp ceiling) AND step `reasoning_effort`
   down one level (`off` is the floor → tokens-only there). Seam: a
   `callWithBudgetRetry` helper wrapping `runModel`+`assertContentBudget`, used
   inside `runPreparedReview`/`runPreparedConsult` for EACH model call (so the
   existing JSON-reprompt attempt2 also benefits, and council members inherit it).
   Bounded: budget-retry is one-shot, so worst case is 2 (budget) × 2 (schema) = 4
   calls for review, 2 for consult.
3. **§2:** Hint only — do NOT auto-flip large councils to synthesis (surprising;
   changes merge owner/billing). Eliminate duplication + compact mode + a
   `notice` hint past `COUNCIL_LARGE_PAYLOAD_CHARS`.
4. **§3:** Drop `/i` on the unquoted `env_style_secret`; keep `/i` on the quoted
   `generic_api_secret_assignment`; add an RHS code/URL suppressor to BOTH (the
   patterns must capture the value span). Suppressor drops a value that: starts
   with a backtick or contains `${` (template literal); matches `^ident(` (call);
   starts with `req.`/`process.env`/`value.`/`this.`/`config.` (member ref); or is
   a **plain URL** — `^https?://` with NO 24+ char opaque token after the host
   (so a Slack-webhook-style URL with a long secret tail is STILL flagged). The
   dedicated high-precision key patterns are untouched. Per-call `allow_secrets`
   boolean is the escape; hard-fail stays the default. **This is the
   security-sensitive change — codex per-task review is mandatory here.**
5. **§4:** `extractJsonObject` returns the LARGEST balanced top-level `{...}`;
   validation arbitrates. Applied to ALL transports via the centralized parse
   helper — safe because it is a FALLBACK only reached when direct
   `stripCodeFence`+`JSON.parse` fails, so clean http/anthropic JSON never touches
   it.

Plan split confirmed: D1 (§5/§6/§2), D2 (§1/§4), D3 (§3 + §7 docs).
