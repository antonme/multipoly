# Multipoly upgrade D3 — scanner precision, per-call override, docs Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the secret scanner precise on ordinary code so a real review isn't blocked by false positives (§3a), add a per-call `allow_secrets` escape that doesn't need a global env + restart (§3b), and document the council-usage caveat + the new levers (§7).

**Architecture:** Third of three plans from `docs/superpowers/specs/2026-05-28-multipoly-upgrade-design.md` (read §3, §7, and "Resolved decisions"). **Security-sensitive** — the scanner is a guard; the precision change must not let true secrets through. Branch `feat/multipoly-upgrade`.

**Tech Stack:** Node.js ESM (`.mjs`), `node --test`. No new dependencies.

**Test runner:** `node --test --test-reporter=spec tests/<file>.test.mjs`; full: `node --test tests/*.test.mjs 2>&1 | tail -6`.

**Secret-scanner caveat (acute here):** the test file `tests/secrets.test.mjs` necessarily contains secret-shaped strings. Keep using clearly-fake values (e.g. `AKIA` + 16 uppercase, `sk-` + fake) — the scanner's own test fixtures are exempt from the outbound scan (they're test data, not sent anywhere). Do NOT paste a real key.

---

## Existing-code orientation

- `scripts/lib/secrets.mjs` — `PATTERNS` array. The two noisy entries:
  - `env_style_secret`: `/\b[A-Z0-9_]{0,64}(?:API|SECRET|TOKEN|PASSWORD|PASS|KEY)[A-Z0-9_]{0,64}\s*=\s*[^\s"']{16,}/i` (unquoted `NAME=value`).
  - `generic_api_secret_assignment`: `/\b[A-Z0-9_]{0,64}(?:API|SECRET|TOKEN|PASSWORD|PASS|KEY)[A-Z0-9_]{0,64}\s*[:=]\s*["'][^"']{16,}["']/i` (quoted).
  `scan(text, label)` iterates PATTERNS with a global-flag copy and records `{pattern,label,line}` per match. Bounded quantifiers (`{0,64}`) are ReDoS-hardening — keep them. The high-precision patterns (`aws_*`, `github_*`, `slack_*`, `pem_private_key`, `openai_style_sk_key`) are UNCHANGED.
- `scripts/lib/model-review.mjs:36` and `scripts/lib/model-consult.mjs:22` — inbound scan gate: `if (!secretScan.clean && !config.allowSecrets) throw SECRET`.
- `scripts/lib/council.mjs:182` — `assertMemberOutputsClean(pieces, config)`: `if (config.allowSecrets) return;` then scan.
- `scripts/multipoly-mcp.mjs` — `REVIEW_KEYS`/`CONSULT_KEYS`/`COUNCIL_EXTRA_KEYS`; per-key schema clones in `buildToolDefs`; `validateToolInput`. `prepareReview`/`prepareConsult` receive `input` + `{config}`.

Cited line numbers are approximate.

---

## Task 1: §3a — Scanner precision (drop /i on unquoted; code/URL RHS suppressor)

**Files:**
- Modify: `scripts/lib/secrets.mjs`
- Test: extend `tests/secrets.test.mjs`

The two assignment patterns must (1) capture the secret VALUE span and (2) skip the hit when the value is plainly code or a plain URL.

- [ ] **Step 1: Failing tests** (extend `tests/secrets.test.mjs`):

  Now-CLEAN (regression for the field false-positives):
  ```javascript
  for (const code of [
    "const headerToken = req.headers.authorization?.split(' ')[1];",
    "const registryKey = `${organizationId}::${kind}`;",
    "const key = stringValue(value.key);",
    "const GITHUB_API_BASE = 'https://api.github.com';",
    "const u = `${base}?token=${encodeURIComponent(x)}`;",
  ]) assert.equal(scan(code, "t").clean, true, code);
  ```

  Still-FLAGGED (true positives must NOT regress):
  ```javascript
  assert.equal(scan("API_KEY=abcdEFGH1234ijklMNOP5678qrst", "t").clean, false);     // SCREAMING unquoted opaque
  assert.equal(scan(`FOO_API_KEY = "abcdEFGH1234ijklMNOP5678"`, "t").clean, false);  // quoted opaque
  assert.equal(scan(`apiKey: "abcdEFGH1234ijklMNOP5678qrst"`, "t").clean, false);    // lowercase key, opaque value (quoted /i kept)
  assert.equal(scan("sk-abcdEFGH1234ijklMNOP5678", "t").clean, false);              // dedicated pattern untouched
  // Webhook-style URL with a long opaque tail is a SECRET and must stay flagged:
  assert.equal(scan(`HOOK = "https://hooks.example.com/services/T00/B00/abcdEFGH1234ijklMNOP5678qrst"`, "t").clean, false);
  ```

- [ ] **Step 2: Run → FAIL** (today the five code lines are flagged).

- [ ] **Step 3: Implement.**
  1. Add a named capture for the value to both patterns and drop `/i` on the UNQUOTED one:
     - `env_style_secret`: `/\b[A-Z0-9_]{0,64}(?:API|SECRET|TOKEN|PASSWORD|PASS|KEY)[A-Z0-9_]{0,64}\s*=\s*(?<val>[^\s"']{16,})/` (NO `/i`).
     - `generic_api_secret_assignment`: `/\b[A-Z0-9_]{0,64}(?:API|SECRET|TOKEN|PASSWORD|PASS|KEY)[A-Z0-9_]{0,64}\s*[:=]\s*["'](?<val>[^"']{16,})["']/i` (KEEP `/i`).
     Keep the `{0,64}` bounds.
  2. Add a per-pattern optional `suppress(val)` predicate; mark these two with `suppress: looksLikeNonSecretValue`.
  3. Implement the suppressor:
     ```javascript
     function looksLikeNonSecretValue(v) {
       if (v == null) return false;
       const s = String(v).trim();
       if (s.startsWith("`") || s.includes("${")) return true;            // template literal
       if (/^[A-Za-z_$][\w$]*\s*\(/.test(s)) return true;                 // function call: ident(
       if (/^(req|res|process\.env|value|this|config|ctx|opts|options)\b[.[]/.test(s)) return true; // member/index ref
       if (/^https?:\/\//.test(s)) {                                      // URL: suppress ONLY plain base URLs
         const afterHost = s.replace(/^https?:\/\/[^/]+/, "");            // path+query+fragment
         if (!/[A-Za-z0-9_\-]{24,}/.test(afterHost)) return true;        // no long opaque token => plain URL => not a secret
         return false;                                                    // long opaque tail (e.g. webhook) => keep flagged
       }
       return false;
     }
     ```
  4. In `scan()`, when a pattern has `suppress` and the match's `groups.val` satisfies it, do NOT record the hit (continue the while-loop, advancing lastIndex). Leave patterns without `suppress` untouched.

  > Rationale recap: dropping `/i` on the unquoted pattern kills the camelCase-identifier matches (`headerToken=`). The suppressor kills the code-RHS / plain-URL matches on both. The quoted pattern keeps `/i` so lowercase `api_key`/`apiKey` config keys with opaque values stay caught. The webhook test guards that we don't blanket-drop URLs.

- [ ] **Step 4: Run → PASS + full suite** (existing `tests/secrets.test.mjs` assertions for the dedicated patterns must remain green; if any existing assertion depended on the old /i behavior of the unquoted pattern, evaluate whether it was testing a real-secret case — keep it green by adjusting the fixture to SCREAMING_CASE, not by reverting the precision fix).

- [ ] **Step 5: Commit**
```bash
git add scripts/lib/secrets.mjs tests/secrets.test.mjs
git commit -m "fix: scanner precision — drop /i on unquoted env pattern, suppress code/plain-URL RHS"
```

---

## Task 2: §3b — Per-call `allow_secrets` override

**Files:**
- Modify: `scripts/multipoly-mcp.mjs` (tool schemas + validator), `scripts/lib/model-review.mjs`, `scripts/lib/model-consult.mjs`, `scripts/lib/council.mjs`
- Test: extend `tests/review.test.mjs`/`tests/council.test.mjs`, `tests/mcp-tools.test.mjs`

- [ ] **Step 1: Failing tests:**
  - `prepareReview` with `input.allow_secrets === true` over a payload containing a (fake) real-looking secret → does NOT throw SECRET; with `allow_secrets` absent/false → still throws SECRET. Same for `prepareConsult`.
  - Council `assertMemberOutputsClean` honors a per-call allow_secrets (thread it).
  - Schema/validator (`tests/mcp-tools.test.mjs`): `allow_secrets` is an accepted boolean key on every `*_review`/`*_consult`/`council_*` tool; a non-boolean is rejected; anti-drift (tools ≡ validator keys) holds.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.**
  - `multipoly-mcp.mjs`: add `allow_secrets: { type: "boolean", description: "Bypass the secret scanner for THIS call only (use when the scanner false-positives on your code). Default false." }` to `REVIEW_TOOL_SCHEMA.properties` and `CONSULT_TOOL_SCHEMA.properties` (so every model + council tool gets it), and add `"allow_secrets"` to `REVIEW_KEYS` and `CONSULT_KEYS`. Validate boolean in `validateToolInput` (alongside the `reasoning_effort` value check).
  - `model-review.mjs` / `model-consult.mjs`: in `prepareReview`/`prepareConsult`, change the gate to `if (!secretScan.clean && !(config.allowSecrets || input.allow_secrets === true)) throw …`.
  - `council.mjs`: thread the per-call flag into `assertMemberOutputsClean` (pass `input.allow_secrets`) — gate becomes `if (config.allowSecrets || input.allow_secrets) return;`. (Council members call `prepareReview`/`prepareConsult` which already honor it for the inbound scan; this covers the outbound-to-synthesizer scan.)

  > Because `allow_secrets` lives in the shared REVIEW/CONSULT schema (not per-key), every model tool, the alias tools, and council tools inherit it with no per-key clone. The validator dispatches on suffix, so no extra wiring.

- [ ] **Step 4: Run → PASS + full suite** (anti-drift integration test stays green).

- [ ] **Step 5: Commit**
```bash
git add scripts/multipoly-mcp.mjs scripts/lib/model-review.mjs scripts/lib/model-consult.mjs scripts/lib/council.mjs tests/review.test.mjs tests/council.test.mjs tests/mcp-tools.test.mjs
git commit -m "feat: per-call allow_secrets to bypass the scanner for one call"
```

---

## Task 3: §7 — Documentation

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1** — README additions:
  - **Using councils:** council output is a strong candidate-finding generator, **not ground truth** — verify severity (especially security) against the actual code before acting (cite the field case: a plurality mis-rated a fail-closed guard). Note callers can ask members to state confidence + cite the verified line.
  - **Large reviews:** document `MULTIPOLY_<K>_MAX_TOKENS_REVIEW` / `MULTIPOLY_MAX_TOKENS_REVIEW` as the lever, the new 32768/8192 reasoning floors, and the one-shot adaptive BUDGET retry. Document `council_review` `compact: true` and the large-payload hint (from D1).
  - **Secrets:** document the per-call `allow_secrets` param and that the scanner now suppresses code/plain-URL false positives; `MULTIPOLY_ALLOW_SECRETS` remains the global escape.
  - **IPv6:** note happy-eyeballs is enabled at startup and the `NODE_OPTIONS=--dns-result-order=ipv4first` escape hatch; min runtime Node ≥18.13.
- [ ] **Step 2** — CHANGELOG: one "Large-PR council reliability upgrade (2026-05-28)" entry summarizing D1+D2+D3 (IPv6 happy-eyeballs, error-cause surfacing, council payload de-dup + compact + failure_summary, reasoning max_tokens floors + adaptive retry, prose-JSON extraction, scanner precision + per-call allow_secrets).
- [ ] **Step 3** — run full suite (docs shouldn't affect it) and commit:
```bash
git add README.md CHANGELOG.md
git commit -m "docs: council-usage caveat, large-review knobs, allow_secrets, IPv6 note"
```

---

## Final verification (after all tasks)

- [ ] Full suite green: `node --test tests/*.test.mjs 2>&1 | tail -6`.
- [ ] Re-scan the five field false-positives → clean; the documented true positives → flagged.
- [ ] Dual review per task: superpowers:code-reviewer AND codex (codex:codex-rescue) — **especially Task 1** (the scanner precision change); confirm no true-secret regression.
