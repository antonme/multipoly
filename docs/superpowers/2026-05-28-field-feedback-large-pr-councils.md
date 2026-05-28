# Field feedback — large-PR council reviews (2026-05-28)

Source: a real working session using multipoly to review a large PR
(~4.7k-line diff, 26 files) twice via `council_review` against a git base,
plus a `qwen_consult` smoke test. Panel configured with 10 members
(glm, qwen, deepseek, composer, kimi, gemini, claude, codex, agy, mimo).

This is grounded feedback for whoever develops multipoly — concrete failures
observed, with file:line pointers into the current code. Ordered by impact.

---

## 1. Token budgets are too small for reasoning models on large diffs

**Observed:** on the second `council_review` (≈114k-char aggregated output),
three members produced **no usable output**:

- **glm** — `member_status` BUDGET: consumed ~8185 reasoning tokens against an
  8192 cap, leaving ~0 tokens for content. Empty body.
- **kimi** — BUDGET: exhausted its 16384 cap during reasoning, no content.
- **agy** — SCHEMA (separate issue, see §4).

So **3 of 10 members were lost**, and 2 purely because the reasoning phase ate
the entire output budget.

**Root cause in code:** `resolveModelMaxTokens()` (`scripts/lib/config.mjs:137-170`)
applies a floor of **8192 (review)** for GLM_TOGGLE models and otherwise passes
the operator's cap straight through. But for reasoning-capable models the
`max_tokens` ceiling covers **reasoning + content combined** (the comment at
`config.mjs:22-24` acknowledges "reasoning tokens share that budget with
content"). On a large review prompt, reasoning alone blows past 8192/16384, so
the floor is effectively a guarantee of failure, not a safety net.

`budget.mjs` already does the right *detection* (`finish_reason: "length"` +
empty body → actionable BUDGET error, `budget.mjs:6-46`) — the gap is that the
**defaults make this fire routinely** on exactly the workload councils are most
useful for (big diffs).

**Recommendations:**
1. Raise the review floor substantially for reasoning models — 8192 is below the
   reasoning footprint of a single large review. Consider 32k+ as the review
   default for reasoning-capable members, or scale the cap with input size.
2. Where the provider API distinguishes them, set a **separate reasoning budget**
   vs. output budget so reasoning can't starve content.
3. On a BUDGET failure, **auto-retry once** with (a) a higher `max_tokens` and/or
   (b) reduced `reasoning_effort` (e.g. step `high`→`medium`), instead of
   dropping the member. A council silently losing 30% of its panel is a bad
   default; a one-shot adaptive retry would have recovered glm and kimi.
4. Document the per-model `*_MAX_TOKENS_REVIEW` knobs prominently as the lever
   for large reviews — operators won't discover they need to raise them until
   members start vanishing.

---

## 2. Aggregated council output is ~2× larger than necessary (verbatim duplication)

**Observed:** both `council_review` results exceeded the calling harness's
token limit (156k and 114k chars) and had to be spilled to a file and
synthesized by a subagent. On inspection, the `member_results` block is a
**byte-for-byte duplicate** of the `members` block — the same per-model
findings/summaries appear twice in one payload.

**Impact:** doubles an already-large payload, pushing it over caller context
limits and forcing out-of-band handling. For a 10-member council on a big diff
this is the difference between "fits in context" and "doesn't."

**Recommendations:**
- Don't emit both `members` and a duplicate `member_results`. If they serve
  different consumers, make one a reference/summary, not a full copy.
- Offer a **compact result mode** (findings only, drop per-model prose
  summaries; or top-N-by-severity) for `include_individual_results`.
- Consider defaulting large councils (≥N members or ≥M diff size) to
  **server-side synthesis** so the caller gets the merged report, not the raw
  envelope — the harness-side path is what blew context here.

---

## 3. Secret scanner: high false-positive rate on ordinary code; override is too coarse

**Observed:** the **first** `council_review` was **fully blocked** by the secret
scanner. Every hit was a false positive in normal TypeScript:

| Flagged | Why it matched |
|---|---|
| `const headerToken = req.headers.authorization?...` | identifier contains "Token" |
| `const registryKey = \`${organizationId}::${kind}\`` | "Key" |
| `const key = stringValue(value.key);` | "key" |
| `GITHUB_API_BASE = 'https://api.github.com'` | "API" + 16+ char URL |
| `` `${base}?token=${encodeURIComponent(...)}` `` | "token=" + long expr |

**Root cause:** `scripts/lib/secrets.mjs:40-48`. The `env_style_secret` and
`generic_api_secret_assignment` patterns use the **`/i` (case-insensitive)
flag**. That's correct intent for SCREAMING_CASE `FOO_API_KEY=...` env lines,
but with `/i` the keyword group matches **camelCase code identifiers**
(`headerToken`, `registryKey`, `queryToken`), and the RHS `[^\s"']{16,}` matches
ordinary code expressions (`stringValue(value.key);`, a URL, a template literal).
A codebase full of `token`/`key`/`api` variable names trips it constantly.

**The override is also too blunt:** the only escape is the server-env
`MULTIPOLY_ALLOW_SECRETS=1` (`config.mjs:526`), which (a) disables the scanner
**globally for all calls**, losing the guard's value, and (b) requires an **MCP
server restart** to take effect — there is no per-call parameter. In practice we
had to edit `~/.claude.json` and restart the whole client to get one review
through.

**Recommendations:**
1. **Drop `/i` on the env-style patterns** (or split: keep an uppercase-only
   `[A-Z0-9_]` env pattern, and a separate, much stricter pattern for other
   cases). `API_KEY=...` is SCREAMING_CASE by convention; matching `headerToken`
   buys nothing but noise. This single change removes nearly all the false
   positives we saw.
2. **Look at the RHS shape**, not just length: suppress when the value is plainly
   code — starts with an identifier+`(` (function call), is a template literal
   (`` ` ``), references `req.`/`process.env`/`value.`, or is a recognizable URL.
   Real secrets are high-entropy opaque blobs, not `stringValue(value.key);`.
   The dedicated key patterns (`openai_style_sk_key`, `secrets.mjs:32`) already
   catch the actual-secret case with high precision — the generic assignment
   patterns are the noisy ones.
3. Add a **per-call `allow_secrets` parameter** to `*_review`/`*_consult`/
   `council_*` so an operator can override one run without a global env change +
   restart.
4. Consider **report-and-redact** instead of hard-fail: redact the matched span,
   proceed, and include a note ("N potential secrets redacted") — a hard block on
   a false positive halts the entire workflow.

---

## 4. CLI-transport members can break the JSON contract (agy)

**Observed:** `agy` failed `council_review` with a SCHEMA error — it returned
prose ("I will start by listing the directory structure…") instead of the JSON
findings object, failing validation at position 0. (This was consistent across
the run; it wasn't a one-off.)

**Recommendation:** CLI-kind members need stronger output-format enforcement:
a JSON-only system instruction, a **parse-or-repair** pass (extract the JSON
object if the model wrapped it in prose), and a one-shot retry with an explicit
"respond with ONLY the JSON object, no preamble" reminder before giving up.
Right now an agentic CLI model that "thinks out loud" is just lost.

---

## 5. HTTP transport hangs on dual-stack endpoints with broken IPv6 (Node 18)

**Observed:** `qwen` failed with an opaque `network error: fetch failed`. Root
cause: its endpoint (`...maas.aliyuncs.com`, Alibaba) resolves to **both A and
AAAA**, but the **IPv6 path is black-holed** (confirmed 100% packet loss, from
multiple vantage points — it's the provider's v6, not local routing). The
multipoly runtime is on **Node 18**, where undici's happy-eyeballs
(`autoSelectFamily`) is **off by default** (it became default-on in Node 20). So
Node picks the AAAA address and hangs until `UND_ERR_CONNECT_TIMEOUT`.

**Workaround that fixed it:** `NODE_OPTIONS=--dns-result-order=ipv4first` in the
server env (verified — qwen then returned 200). `setDefaultAutoSelectFamily(true)`
also works.

**Recommendations:**
1. Set a **global undici dispatcher with `autoSelectFamily: true`** at startup
   (works on Node 18.13+), so HTTP members are resilient to broken-IPv6 endpoints
   regardless of Node version / operator env. This is the robust fix.
2. Or bump the documented minimum runtime to **Node 20+**.
3. Either way, **document** the dual-stack/IPv6 failure mode and the
   `--dns-result-order=ipv4first` escape hatch.

---

## 6. Failure errors are opaque / under-surfaced

**Observed:** `qwen`'s failure surfaced only as `network error: fetch failed`
with a correlationId — no `cause.code`, no address family, nothing pointing at
IPv6. Diagnosing it required reproducing in Node + curl by hand.

**Recommendations:**
- Include `err.cause?.code` (e.g. `UND_ERR_CONNECT_TIMEOUT`) and, when available,
  the resolved address/family in HTTP error messages.
- In `council_*` results, surface a concise **top-line failure summary**
  ("3/10 members failed: glm (budget), kimi (budget), agy (schema)") so the
  caller sees panel attrition immediately rather than diffing `member_status`.

---

## What worked well (keep)

- **Panel diversity paid off.** Single-model catches that a 2-model review
  missed: a GitHub rate-limit/quota-waste bug (gemini), an SSE init-ordering bug
  (kimi), an unbounded-payload DoS (mimo), and a cross-tenant ID leak surfaced by
  6 of 7 models. The breadth is the product's value.
- **`member_status` classification** (BUDGET / SCHEMA / HTTP) is genuinely
  useful once you find it — just surface it more prominently (§6).
- **`budget.mjs` truncation detection** is the right design; it's the *defaults*
  feeding it that need raising (§1).
- The **ReDoS-hardening** in `secrets.mjs` (bounded quantifiers, prebuilt newline
  index) is good — the precision problem is orthogonal to that.

## One caveat for the docs (how to USE councils)

In our run a **plurality of members (4/7) mis-rated** an auth finding as a
"blocker" by pattern-matching the wrong middleware guard; direct code inspection
showed it was fail-closed and not exploitable. Worth a line in the user-facing
docs: **council consensus is a strong candidate-finding generator, not ground
truth** — severity, especially for security findings, should be verified against
the actual code before acting. Optionally, prompt members to state a
**confidence** level and to cite the specific guard/line they verified before
assigning a security severity.
