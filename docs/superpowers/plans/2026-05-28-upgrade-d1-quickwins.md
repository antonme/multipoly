# Multipoly upgrade D1 — quick wins (IPv6, error surfacing, payload) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three low-risk reliability/UX fixes from the field feedback: make HTTP resilient to black-holed-IPv6 dual-stack endpoints (§5), surface failure causes + council panel attrition (§6), and stop the council harness payload from duplicating per-member content + add a compact mode (§2).

**Architecture:** First of three plans from `docs/superpowers/specs/2026-05-28-multipoly-upgrade-design.md`. All three changes are additive and isolated; no transport wire-format or capability changes. Branch `feat/multipoly-upgrade` (already checked out off `main`).

**Tech Stack:** Node.js ESM (`.mjs`), `node --test`. No new dependencies.

**Test runner:** `node --test --test-reporter=spec tests/<file>.test.mjs` for one file; `node --test tests/*.test.mjs 2>&1 | tail -6` for the full suite (run via the Bash tool = bash, not fish). Baseline on this branch: full suite passes (same count as `main` plus any earlier upgrade commits).

**Secret-scanner caveat:** the repo scans content for secret-shaped strings. In tests use short fake values; never paste real-key-shaped literals.

---

## Existing-code orientation

- `scripts/multipoly-mcp.mjs` — `main()` starts the server; this is where startup-time process config goes.
- `scripts/lib/client.mjs` — `callWithRetry` (~L434-453) wraps network errors as `HTTP: network error: ${e.message}` with no `cause.code`.
- `scripts/lib/council.mjs` — `buildMemberStatus(memberResults)` builds the per-member ok/fail map; `buildHarnessReviewResult({input, models, memberResults, prepared})` builds the defer-mode review payload; `buildHarnessConsultResult({models, memberResults, successful, input})` the consult one; `handleCouncilReview`/`handleCouncilConsult` are the entrypoints. The synthesis-mode review result is built inline in `handleCouncilReview`.
- `scripts/multipoly-mcp.mjs` — `councilExtraProperties(modelKeys)` defines the council tool schema extras (`models`/`synthesizer`/`include_individual_results`); `COUNCIL_EXTRA_KEYS` is the validator key set; `validateCouncilExtras` validates them.

Treat cited line numbers as approximate; match on surrounding code.

---

## Task 1: §5 — Enable happy-eyeballs at startup (IPv6 resilience)

**Files:**
- Create: `scripts/lib/net-config.mjs` (tiny, unit-testable)
- Modify: `scripts/multipoly-mcp.mjs` (`main()`)
- Test: `tests/net-config.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/net-config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { enableHappyEyeballs } from "../scripts/lib/net-config.mjs";

test("calls setDefaultAutoSelectFamily(true) when present", () => {
  let called = null;
  enableHappyEyeballs({ setDefaultAutoSelectFamily: (v) => { called = v; } });
  assert.equal(called, true);
});

test("is a no-op when the API is absent (old Node)", () => {
  // must not throw
  assert.doesNotThrow(() => enableHappyEyeballs({}));
  assert.equal(enableHappyEyeballs({}), false);
});

test("returns true when it enabled happy-eyeballs", () => {
  assert.equal(enableHappyEyeballs({ setDefaultAutoSelectFamily: () => {} }), true);
});
```

- [ ] **Step 2: Run → FAIL** (`node --test --test-reporter=spec tests/net-config.test.mjs`) — module missing.

- [ ] **Step 3: Implement**

```javascript
// scripts/lib/net-config.mjs
// Node 18 has undici happy-eyeballs (autoSelectFamily) OFF by default; an
// endpoint with a black-holed AAAA hangs until connect-timeout. Node 18.13+
// exposes the public net.setDefaultAutoSelectFamily — enable it process-wide so
// the built-in fetch races A/AAAA and falls back. No-op on older runtimes.
export function enableHappyEyeballs(net) {
  if (net && typeof net.setDefaultAutoSelectFamily === "function") {
    net.setDefaultAutoSelectFamily(true);
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Wire into `main()`** in `scripts/multipoly-mcp.mjs`: import `node:net` and the helper, call once at the top of `main()` (before `loadConfig`/serving). Example:

```javascript
import * as net from "node:net";
import { enableHappyEyeballs } from "./lib/net-config.mjs";
// inside main(), first line:
enableHappyEyeballs(net);
```

- [ ] **Step 5: Run → PASS** (the file test + full suite `node --test tests/*.test.mjs 2>&1 | tail -6`, 0 failures).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/net-config.mjs scripts/multipoly-mcp.mjs tests/net-config.test.mjs
git commit -m "fix: enable happy-eyeballs at startup so HTTP survives black-holed IPv6 (Node 18)"
```

---

## Task 2: §6 — Surface error cause + council failure summary

**Files:**
- Modify: `scripts/lib/client.mjs` (`callWithRetry` network-error wrap)
- Modify: `scripts/lib/council.mjs` (add `failure_summary`)
- Test: extend `tests/client.test.mjs`, `tests/council.test.mjs`

### 2a — HTTP error cause

- [ ] **Step 1: Failing test** (extend `tests/client.test.mjs`): make `fetchImpl` reject with `Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })`; assert the thrown `MultipolyError` has `details.cause === "UND_ERR_CONNECT_TIMEOUT"` (or the message includes it). Note: `callWithRetry` retries network errors `MAX_RETRIES` times — the fake must reject every time; assert on the final thrown error.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** in `client.mjs` the network-error branch (currently):

```javascript
lastErr = new MultipolyError("HTTP", `network error: ${e.message}`, { correlationId, cause: e });
```
change to include the underlying code:
```javascript
const causeCode = e?.cause?.code ?? e?.code;
lastErr = new MultipolyError(
  "HTTP",
  `network error: ${e.message}${causeCode ? ` (${causeCode})` : ""}`,
  { correlationId, cause: e, details: causeCode ? { cause: causeCode } : undefined },
);
```

- [ ] **Step 4: Run → PASS.**

### 2b — Council failure summary

- [ ] **Step 5: Failing tests** (extend `tests/council.test.mjs`): using the file's existing config + fake-runner fixtures, assert that a council review/consult result where some members failed includes a `failure_summary` like `/\d+\/\d+ members failed/` naming the failed keys + codes; and that an all-success panel yields `failure_summary === ""`. For the harness **consult** text, assert the summary line is prepended.

- [ ] **Step 6: Run → FAIL.**

- [ ] **Step 7: Implement** a helper in `council.mjs`:

```javascript
function buildFailureSummary(memberResults, models) {
  const failed = Object.entries(memberResults).filter(([, v]) => !v.ok);
  if (failed.length === 0) return "";
  const parts = failed.map(([k, v]) => `${k} (${v.error?.code ?? "UNKNOWN"})`);
  return `${failed.length}/${models.length} members failed: ${parts.join(", ")}`;
}
```
Add `failure_summary: buildFailureSummary(memberResults, models)` to: the harness review result (`buildHarnessReviewResult`), the synthesis review result (inline in `handleCouncilReview`), and the synthesis consult return. For `buildHarnessConsultResult`, prepend the summary (when non-empty) as the first line of the returned text. Keep `member_status` unchanged (the summary is derived/additive).

- [ ] **Step 8: Run → PASS + full suite.**

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/client.mjs scripts/lib/council.mjs tests/client.test.mjs tests/council.test.mjs
git commit -m "feat: surface HTTP error cause code + council failure-summary line"
```

---

## Task 3: §2 — De-duplicate council payload + compact mode

**Files:**
- Modify: `scripts/lib/council.mjs` (`buildHarnessReviewResult`, member_results handling)
- Modify: `scripts/multipoly-mcp.mjs` (`councilExtraProperties` + `COUNCIL_EXTRA_KEYS` + `validateCouncilExtras` — add `compact`)
- Test: extend `tests/council.test.mjs`, `tests/mcp-tools.test.mjs`

**Current shape (the problem):** `buildHarnessReviewResult` returns `members` (trimmed `{findings, summary_md}` per ok member) AND `member_status`, and when `input.include_individual_results` is set, also `member_results` = the raw `memberResults` map whose ok entries embed the FULL per-member review result (including a per-member `files` roster), duplicating `members` and the file list N times.

### 3a — Stop the duplication

- [ ] **Step 1: Failing test** (extend `tests/council.test.mjs`): run a harness-defer `council_review` with `include_individual_results: true` over a 2+ member panel where each member's result carries a `files` array. Assert the serialized result does NOT contain the per-member `files` roster duplicated (e.g. the top-level `files` appears once; `member_results` for ok members does not re-embed `files`/`schema_version`/`model`). Assert a FAILED member's error detail IS present in `member_results`.

- [ ] **Step 2: Run → FAIL** (today member_results embeds the full result).

- [ ] **Step 3: Implement.** Change the `include_individual_results` branch so `member_results` carries only the non-duplicated diagnostics:
  - failed members → `{ ok: false, error }` (as today),
  - ok members → omit, OR `{ ok: true }` with no re-embedded findings/files (their findings are already in `members`).
  Simplest: build `member_results` as `Object.fromEntries(Object.entries(memberResults).filter(([,v]) => !v.ok))` so only failures are detailed; ok members are fully represented by `members` + `member_status`. Apply the same de-dup to the synthesis-mode `member_results` inclusion in `handleCouncilReview`.

- [ ] **Step 4: Run → PASS.**

### 3b — Compact mode

- [ ] **Step 5: Failing test**: a `council_review` with `compact: true` → `members` entries have `findings` but NO `summary_md`. Without `compact`, `summary_md` present. Add a schema/validator test in `tests/mcp-tools.test.mjs` that `compact` is an accepted boolean key on `council_review`/`council_consult` and rejected as unknown elsewhere.

- [ ] **Step 6: Run → FAIL.**

- [ ] **Step 7: Implement.**
  - In `multipoly-mcp.mjs`: add `compact: { type: "boolean", description: "Drop per-model prose summaries from members (findings only) to shrink large council payloads." }` to `councilExtraProperties`; add `"compact"` to `COUNCIL_EXTRA_KEYS`; validate boolean in `validateCouncilExtras`.
  - In `council.mjs` `buildHarnessReviewResult`: when `input.compact`, build `members[k]` as `{ findings }` only (omit `summary_md`).
  - (Council consult: `compact` is a no-op for now — consult members are prose answers; document that. Do not error on it.)

- [ ] **Step 8: Run → PASS + full suite.**

### 3c — Large-payload hint

- [ ] **Step 9: Failing test**: when the assembled harness review result serializes beyond a threshold (e.g. set a small threshold via the constant, or build a large panel), the result includes a `notice`/hint field mentioning `synthesizer` or `compact`. Below the threshold, no hint.

- [ ] **Step 10: Implement** a constant `COUNCIL_LARGE_PAYLOAD_CHARS = 80000` and, in the harness review/consult builders, after assembling, measure `JSON.stringify(result).length` (review) / text length (consult); if over the threshold, add a `notice` field (review) or append a hint line (consult): "Large council payload (N chars). Pass `compact: true` or a `synthesizer` (or set MULTIPOLY_SYNTHESIZER) to shrink/merge server-side." Keep it a single derived field; don't recompute expensively (one stringify is fine).

- [ ] **Step 11: Run → PASS + full suite.**

- [ ] **Step 12: Commit**

```bash
git add scripts/lib/council.mjs scripts/multipoly-mcp.mjs tests/council.test.mjs tests/mcp-tools.test.mjs
git commit -m "feat: de-duplicate council member_results, add compact mode + large-payload hint"
```

---

## Final verification (after all tasks)

- [ ] Full suite green: `node --test tests/*.test.mjs 2>&1 | tail -6`.
- [ ] `node scripts/multipoly-mcp.mjs --health` with a minimal config still returns `status: ok` (startup happy-eyeballs call doesn't throw).
- [ ] Dual review per task: superpowers:code-reviewer AND codex (codex:codex-rescue) on each task's diff; address findings.
