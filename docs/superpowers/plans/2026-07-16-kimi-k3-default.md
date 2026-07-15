# Kimi K3 Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Multipoly's canonical opt-in `kimi` builtin from Kimi K2.6 to Kimi K3 while preserving its stable tools, first-party transport, and explicit operator overrides.

**Architecture:** Keep the registry key and transport contract unchanged, but split the human-facing display base (`kimi-k3`) from the exact upstream wire model (`kimi-k.3.0`). Extend alias resolution to recognize K3 names, then verify the inherited Kimi thinking toggle against the live first-party endpoint at both enabled and disabled effort.

**Tech Stack:** Node.js ESM, `node:test`, MCP model registry/config loader, native Anthropic-compatible Kimi Code transport, Markdown documentation.

## Global Constraints

- The canonical registry key remains `kimi`; do not add a second `k3` builtin.
- The exact upstream model identifier is `kimi-k.3.0`.
- Preserve `https://api.kimi.com/coding`, `MULTIPOLY_KIMI_API_KEY` / `MOONSHOT_API_KEY`, `KIMI_TOGGLE`, default effort `high`, and current token floors unless live provider evidence disproves the toggle contract.
- Explicit `MULTIPOLY_KIMI_MODEL` overrides must continue to win.
- Display name is `kimi-k3 (api)`; wire model is `kimi-k.3.0`.
- Add release notes under `Unreleased`; do not rewrite released `0.3.0` and do not bump the package version.
- Document `MULTIPOLY_KIMI_MODEL=kimi-k2.6` as the rollback pin.
- Do not claim K3 transport verification until live `high` and `off` probes both succeed.

## File map

- `scripts/lib/models.mjs`: baked Kimi display base, exact default wire model, provider and reasoning metadata.
- `scripts/lib/aliases.mjs`: normalized human aliases to the stable `kimi` key.
- `tests/config.test.mjs`: baked metadata, resolved config, display name, and override-precedence assertions.
- `tests/aliases.test.mjs`: K3 alias routing and unconfigured-model fail-closed assertions.
- `README.md`: user-facing builtin, alias, default model, and rollback documentation.
- `CHANGELOG.md`: Unreleased K3 default-upgrade note.

---

### Task 1: K3 registry identity and aliases

**Files:**
- Modify: `tests/config.test.mjs`
- Modify: `tests/aliases.test.mjs`
- Modify: `scripts/lib/models.mjs`
- Modify: `scripts/lib/aliases.mjs`

**Interfaces:**
- Consumes: `MODEL_INFO.kimi`, `loadConfig(env)`, and `resolveModelAlias(raw, configuredKeys)`.
- Produces: baked display base `kimi-k3`, baked wire model `kimi-k.3.0`, and aliases `k3`, `kimi-k3`, `kimi-k.3.0` resolving to `kimi` only when configured.

- [ ] **Step 1: Add failing registry/config assertions**

Add after the existing baked-entry assertions in `tests/config.test.mjs`:

```js
test("kimi baked builtin defaults to K3 while explicit model overrides still win", () => {
  assert.equal(MODEL_INFO.kimi.baseName, "kimi-k3");
  assert.equal(MODEL_INFO.kimi.defaultModel, "kimi-k.3.0");
  assert.equal(MODEL_INFO.kimi.defaultBaseUrl, "https://api.kimi.com/coding");
  assert.equal(MODEL_INFO.kimi.reasoning, "kimi_toggle");
  assert.equal(MODEL_INFO.kimi.defaultEffort, "high");

  const baked = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "kimi",
    MULTIPOLY_KIMI_API_KEY: "k",
  });
  assert.equal(baked.models.kimi.model, "kimi-k.3.0");
  assert.equal(baked.models.kimi.displayName, "kimi-k3 (api)");

  const pinned = loadConfig({
    MULTIPOLY_GLM_API_KEY: "g",
    MULTIPOLY_MODELS: "kimi",
    MULTIPOLY_KIMI_API_KEY: "k",
    MULTIPOLY_KIMI_MODEL: "kimi-k2.6",
  });
  assert.equal(pinned.models.kimi.model, "kimi-k2.6");
});
```

- [ ] **Step 2: Add failing K3 alias assertions**

Add to `tests/aliases.test.mjs`:

```js
test("Kimi K3 aliases resolve to kimi only when kimi is configured", () => {
  for (const alias of ["k3", "kimi-k3", "kimi-k.3.0"]) {
    assert.equal(resolveModelAlias(alias, KEYS), "kimi");
    assert.equal(resolveModelAlias(alias, KEYS.filter((key) => key !== "kimi")), null);
  }
  assert.equal(resolveModelAlias("k2", KEYS), "kimi");
  assert.equal(resolveModelAlias("moonshot", KEYS), "kimi");
});
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test tests/config.test.mjs tests/aliases.test.mjs
```

Expected: failures show `kimi-k2.6 !== kimi-k3`, `kimi-k2.6 !== kimi-k.3.0`, and new K3 aliases resolving to `null`.

- [ ] **Step 4: Make the minimal registry and alias implementation**

Change the Kimi entry in `scripts/lib/models.mjs` to:

```js
kimi: Object.freeze({
  key: "kimi",
  baseName: "kimi-k3",
  transport: "anthropic",
  defaultModel: "kimi-k.3.0",
  defaultBaseUrl: "https://api.kimi.com/coding",
  apiKeyEnv: ["MULTIPOLY_KIMI_API_KEY", "MOONSHOT_API_KEY"],
  supportsThinking: true,
  reasoning: CAPABILITY.KIMI_TOGGLE,
  defaultEffort: "high",
}),
```

Change the Kimi alias entry in `scripts/lib/aliases.mjs` to:

```js
k2: "kimi", k3: "kimi", "kimi-k3": "kimi", "kimi-k.3.0": "kimi", moonshot: "kimi",
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --test tests/config.test.mjs tests/aliases.test.mjs
```

Expected: all config and alias tests pass.

- [ ] **Step 6: Commit the behavior change**

```bash
git add scripts/lib/models.mjs scripts/lib/aliases.mjs tests/config.test.mjs tests/aliases.test.mjs
git commit -m "feat: default kimi builtin to K3"
```

### Task 2: User-facing K3 documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1's stable key `kimi`, display `kimi-k3 (api)`, wire model `kimi-k.3.0`, and explicit model override behavior.
- Produces: operator instructions for enabling K3, selecting it by aliases, and pinning K2.6 for rollback.

- [ ] **Step 1: Update active README surfaces**

Make the baked-builtin table identify `kimi` as `kimi-k3 (api)`. Add a short Kimi paragraph that states:

```markdown
`kimi` defaults to **Kimi K3** using the exact first-party Kimi Code model ID
`kimi-k.3.0`. The stable tools remain `kimi_review` / `kimi_consult`. To keep
the previous upstream model temporarily, set
`MULTIPOLY_KIMI_MODEL=kimi-k2.6`.
```

Change the alias-table Kimi row to:

```markdown
| `k3`, `kimi-k3`, `kimi-k.3.0`, `k2`, `moonshot` | `kimi` |
```

- [ ] **Step 2: Add an Unreleased changelog entry**

Insert above `## 0.3.0` in `CHANGELOG.md`:

```markdown
## Unreleased

### Kimi K3 default

- The opt-in canonical `kimi` builtin now defaults to first-party Kimi K3:
  display `kimi-k3 (api)`, exact wire model `kimi-k.3.0`. Existing
  `kimi_review` / `kimi_consult`, provider routing, credentials, reasoning
  controls, and explicit `MULTIPOLY_KIMI_MODEL` overrides are unchanged.
- New aliases `k3`, `kimi-k3`, and `kimi-k.3.0` resolve to `kimi`; legacy `k2`
  and `moonshot` aliases remain. Set `MULTIPOLY_KIMI_MODEL=kimi-k2.6` to pin
  the previous model.
```

- [ ] **Step 3: Check for stale active default references and formatting errors**

Run:

```bash
rg -n "kimi-k2\.6|kimi-k\.3\.0|kimi-k3" README.md CHANGELOG.md scripts tests
git diff --check
```

Expected: K2.6 remains only in intentional rollback/override fixtures and historical released notes; no whitespace errors.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document Kimi K3 default"
```

### Task 3: Full and live verification

**Files:**
- Verify only: all implementation files from Tasks 1 and 2

**Interfaces:**
- Consumes: the resolved K3 registry config and existing `handleModelConsult` Anthropic transport path.
- Produces: evidence that the suite passes, health displays the intended identity, and K3 accepts both enabled and disabled thinking toggles.

- [ ] **Step 1: Run the full automated suite**

Run:

```bash
npm test
```

Expected: every test passes with zero failures.

- [ ] **Step 2: Run the no-spend health check**

Run:

```bash
MULTIPOLY_GLM_API_KEY=dummy MULTIPOLY_MODELS=kimi MULTIPOLY_KIMI_API_KEY=dummy npm run health
```

Expected: the Kimi row reports display `kimi-k3 (api)`, transport `anthropic`, model `kimi-k.3.0`, reasoning `kimi_toggle`, and configured status.

- [ ] **Step 3: Run minimal live K3 high/off probes without printing credentials**

Run this one-off ESM probe with `MULTIPOLY_KIMI_API_KEY` (or
`MOONSHOT_API_KEY`) supplied from the operator's credential manager. It never
prints the key, caps each response to 256 tokens, and invokes Multipoly's real
consult/Anthropic path:

```bash
node --input-type=module -e '
import { loadConfig } from "./scripts/lib/config.mjs";
import { handleModelConsult } from "./scripts/lib/model-consult.mjs";
const key = process.env.MULTIPOLY_KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY;
if (!key) throw new Error("Set MULTIPOLY_KIMI_API_KEY or MOONSHOT_API_KEY");
const config = loadConfig({
  MULTIPOLY_GLM_API_KEY: "unused",
  MULTIPOLY_MODELS: "kimi",
  MULTIPOLY_KIMI_API_KEY: key,
  MULTIPOLY_KIMI_MAX_TOKENS_CONSULT: "256",
});
for (const effort of ["high", "off"]) {
  const out = await handleModelConsult("kimi", {
    prompt: "Reply with exactly OK.",
    reasoning_effort: effort,
    timeout_ms: 600000,
  }, { config, cwd: process.cwd() });
  console.log(`${effort}: ${out.result.trim()}`);
}
'
```

Expected: both calls succeed and print `high: OK` and `off: OK` (minor harmless punctuation is acceptable). If `off` returns a provider 400 about disabled thinking, stop and amend the Kimi reasoning capability/tests before proceeding. If credentials, billing, or network fail, report that external blocker without changing the design contract speculatively.

- [ ] **Step 4: Request Fable's final implementation review**

Use `mcp__multipoly__fable_review` with `diff_base` set to the design-spec commit's parent and focus on exact K3 identity, override compatibility, aliases, docs, TDD evidence, and both live toggle probes. Resolve every verified blocker and rerun affected checks.

- [ ] **Step 5: Record final repository evidence**

Run:

```bash
git status --short --branch
git log -4 --oneline
```

Expected: only the intended committed changes are present and the recent commits separately show design, implementation, and documentation.
