# Model-naming convention + lenient aliases (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the multipoly fleet a stable `<model> (<agent/transport>)` display-name convention with baked-in metadata for `claude`/`codex`/`gemini`/`kimi`, fold the standalone `opus` builtin into `claude` (with `opus_*` alias tools), and add lenient model-name resolution (exact+alias routing; fuzzy match for error hints only) plus a loud migration warning for legacy `MULTIPOLY_OPUS_*` vars.

**Architecture:** This is the second of three plans derived from `docs/superpowers/specs/2026-05-27-reasoning-effort-and-model-naming-design.md` (Plan A — the reasoning-effort core — is already merged to `main`). The work is metadata + resolution plumbing only; no transport wire-format changes. We promote `claude`/`codex`/`gemini`/`kimi` from per-deployment custom models to baked `MODEL_INFO` entries (so they carry capability/display-name/default-effort without env), but DELIBERATELY keep them out of `MODEL_KEYS` so the default registry and tool surface are unchanged and existing `MULTIPOLY_MODELS=claude,...` deployments keep working (the registry loader merges the baked `MODEL_INFO` base under env overrides when a custom key names a known builtin). We remove the separate `OPUS_INFO` const; `opus` becomes an alias of `claude`. A new pure `aliases.mjs` module owns the alias table and resolution; it is wired into council `models[]`/`synthesizer` resolution and into the tool surface (curated `opus_*`/`gpt55_*` alias tools routing to the canonical handlers).

**Tech Stack:** Node.js ESM (`.mjs`), `node --test` (spec reporter), MCP SDK stdio server. No new dependencies.

**Key design decision (locked):** `claude`/`codex`/`gemini`/`kimi` get **baked `MODEL_INFO` metadata only**, NOT auto-registration. Registration stays opt-in via `MULTIPOLY_MODELS` (matching how the operator's `~/.claude.json` already works). Rationale: spec-faithful ("baked defaults without per-deployment env"), breaks no existing deployment, and avoids advertising local-CLI tools in minimal deployments that never opted in. `mimo` is owned by Plan C, not this plan.

**Test runner:** `node --test --test-reporter=spec tests/<file>.test.mjs` for one file; `node --test --test-reporter=spec tests/*.test.mjs` for the full suite. The Bash tool runs bash, not the fish login shell. The full suite currently passes at 360 tests on `main`.

**Secret-scanner caveat:** multipoly scans outbound content (and the registry file) for secret-shaped tokens. When writing tests/docs, avoid literal strings that look like real keys; use short fake values like `"glm"` for an apiKey, never `MULTIPOLY_X_API_KEY: "sk-…"`-shaped values. Env-var *names* (e.g. `MULTIPOLY_OPUS_API_KEY`) are fine as identifiers.

---

## Existing-code orientation (read before starting)

- `scripts/lib/models.mjs` — `MODEL_KEYS` (frozen: glm/qwen/deepseek/composer), `MODEL_INFO` (frozen object of builtin metadata), `OPUS_INFO` (separate const, registered only when an Anthropic key is present), `CLI_KINDS`, `loadModelRegistry(env)` (builds `{keys, info}`: builtins + opus-when-keyed + `MULTIPOLY_MODELS` custom + registry-file), `modelCapability`/`modelHasReasoningControl`/`modelSupportsThinking`.
- `scripts/lib/config.mjs` — `loadConfig(env)`, per-transport `loadOneModelConfig`, `normalizeSynthesizerChoice(raw, modelKeys)` (maps harness/none/caller→`"harness"`, known key→key, else null), `SYNTHESIZER_FALLBACK_ORDER`.
- `scripts/lib/council.mjs` — `resolveCouncilModels(input, config)` (currently strict `known.includes(m)`), `resolveSynthesisTarget`.
- `scripts/multipoly-mcp.mjs` — `buildToolDefs(registry)` (single source of truth: each def has `name`/`description`/`inputSchema`/`allowedKeys`/`handler`), `buildServerSurface`, `registryFromConfig`, the hand-rolled `validateToolInput`. Anti-drift is enforced by `tests/mcp-tools.test.mjs` / `tests/mcp-integration.test.mjs`.
- `scripts/lib/reasoning.mjs` — `CAPABILITY`, `EFFORT_LEVELS`.

When a step says "Modify `path:NN`", treat the line number as approximate — match on the surrounding code shown in the step, not the literal line.

---

## File Structure

- **Create** `scripts/lib/aliases.mjs` — pure module: `MODEL_ALIASES` seed table, `resolveModelAlias(raw, configuredKeys)` (normalize → exact key → alias table → null), `nearestModelKey(raw, candidateKeys)` (Levenshtein-ratio nearest match, **for error hints only**), `didYouMean(raw, candidateKeys)` (returns a hint string or ""). No imports except `errors.mjs`.
- **Create** `scripts/lib/display-name.mjs` — pure helper `transportSuffix(transport, cliKind)` and `computeDisplayName(baseName, transport, cliKind)` implementing the `<model> (<agent/transport>)` convention. (Kept separate from `models.mjs` so it can be unit-tested in isolation and reused by the registry loader.)
- **Modify** `scripts/lib/models.mjs` — add `claude`/`codex`/`gemini`/`kimi` to `MODEL_INFO`; remove `OPUS_INFO`; teach `loadModelRegistry` to (a) merge a baked `MODEL_INFO` base when a `MULTIPOLY_MODELS` custom key names a known builtin, (b) honor `MULTIPOLY_<K>_TRANSPORT` override for such keys, (c) apply the display-name convention, (d) the claude/codex transport-flip guard, (e) emit the `MULTIPOLY_OPUS_*`/`MULTIPOLY_GPT55_*` migration warning.
- **Modify** `scripts/lib/council.mjs` — route `resolveCouncilModels` member names through `resolveModelAlias`, dedup after resolution, error with a "did you mean" hint when unresolved.
- **Modify** `scripts/lib/config.mjs` — route `normalizeSynthesizerChoice` through `resolveModelAlias` (after the harness-sentinel check), so a synthesizer named `gpt`/`opus` resolves.
- **Modify** `scripts/multipoly-mcp.mjs` — emit curated `opus_*`/`gpt55_*` alias tool defs routed to the canonical `claude`/`codex` handlers; keep the validator/key-spec in sync (it already derives from the same def list).
- **Modify** `README.md` / `CHANGELOG.md` — document the convention, alias table, alias tools, and the `MULTIPOLY_OPUS_*` migration.
- **Test files (create):** `tests/aliases.test.mjs`, `tests/display-name.test.mjs`. **Test files (extend):** `tests/config.test.mjs`, `tests/council.test.mjs`, `tests/mcp-tools.test.mjs`.

---

## Task 1: Alias resolution module

**Files:**
- Create: `scripts/lib/aliases.mjs`
- Test: `tests/aliases.test.mjs`

The contract (from spec §4): **routing is exact+alias only.** Normalize the raw string (lowercase, strip `-`, `_`, `.`, spaces), match an exact configured key first, then the alias table (also normalized). Nearest-match is computed ONLY to build a "did you mean" hint after a hard failure — it must NEVER silently route. The synthesizer sentinels `harness`/`none`/`caller` are not model names and must not be in the alias table.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/aliases.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModelAlias, nearestModelKey, didYouMean, MODEL_ALIASES } from "../scripts/lib/aliases.mjs";

const KEYS = ["glm", "qwen", "deepseek", "composer", "claude", "codex", "gemini", "kimi"];

test("exact configured key resolves to itself", () => {
  assert.equal(resolveModelAlias("codex", KEYS), "codex");
  assert.equal(resolveModelAlias("GLM", KEYS), "glm"); // case-insensitive
});

test("alias maps to canonical key when configured", () => {
  assert.equal(resolveModelAlias("gpt", KEYS), "codex");
  assert.equal(resolveModelAlias("gpt5.5", KEYS), "codex"); // punctuation stripped
  assert.equal(resolveModelAlias("opus", KEYS), "claude");
  assert.equal(resolveModelAlias("flash", KEYS), "gemini");
});

test("alias to an UNCONFIGURED canonical key does not resolve", () => {
  // claude not in the configured set → its alias must not resolve to it
  assert.equal(resolveModelAlias("opus", ["glm", "qwen"]), null);
});

test("unknown name resolves to null (no silent nearest-match routing)", () => {
  assert.equal(resolveModelAlias("totallyunknown", KEYS), null);
  // a near-miss must NOT route:
  assert.equal(resolveModelAlias("codexx", KEYS), null);
});

test("a custom key shadows an alias that would otherwise map elsewhere", () => {
  // if the deployment has a real key named "gpt", exact-match wins over the alias.
  assert.equal(resolveModelAlias("gpt", [...KEYS, "gpt"]), "gpt");
});

test("nearestModelKey is for hints only and respects a threshold", () => {
  assert.equal(nearestModelKey("codexx", KEYS), "codex"); // close
  assert.equal(nearestModelKey("zzzzzz", KEYS), null); // too far → no suggestion
});

test("didYouMean returns a hint string or empty", () => {
  assert.match(didYouMean("codexx", KEYS), /did you mean .*codex/i);
  assert.equal(didYouMean("zzzzzz", KEYS), "");
});

test("MODEL_ALIASES never maps to a synthesizer sentinel", () => {
  for (const target of Object.values(MODEL_ALIASES)) {
    assert.ok(!["harness", "none", "caller"].includes(target));
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-reporter=spec tests/aliases.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/lib/aliases.mjs'`.

- [ ] **Step 3: Implement `scripts/lib/aliases.mjs`**

```javascript
// scripts/lib/aliases.mjs
// Lenient model-name resolution. ROUTING is exact-key + alias-table only;
// nearest-match is computed solely to build a "did you mean?" error hint and
// must never silently reroute a call (that would mis-bill / hijack a model).

// Normalize for matching: lowercase and drop separators humans vary on.
function norm(raw) {
  return String(raw).toLowerCase().replace(/[-_.\s]/g, "");
}

// Seed alias table (extensible). Keys are NORMALIZED alias forms; values are
// canonical model keys. Must never target a synthesizer sentinel.
const RAW_ALIASES = {
  gpt: "codex", gpt5: "codex", "gpt5.5": "codex", openai: "codex",
  opus: "claude", "claude-opus": "claude", "opus-4.7": "claude",
  flash: "gemini", "gemini-flash": "gemini", "gemini-3.5": "gemini",
  zhipu: "glm", "glm5.1": "glm",
  k2: "kimi", moonshot: "kimi",
  cursor: "composer",
  "deepseek-v4": "deepseek",
  "qwen-max": "qwen",
  xiaomi: "mimo", "mi-mo": "mimo",
};

// Exposed (normalized) for tests / introspection.
export const MODEL_ALIASES = Object.freeze(
  Object.fromEntries(Object.entries(RAW_ALIASES).map(([k, v]) => [norm(k), v])),
);

/**
 * Resolve a raw model-name argument to a CONFIGURED canonical key, or null.
 * Order: exact configured key → alias table (only if the alias target is itself
 * configured) → null. NEVER nearest-match here.
 *
 * @param {string} raw
 * @param {string[]} configuredKeys
 * @returns {string|null}
 */
export function resolveModelAlias(raw, configuredKeys) {
  const keys = Array.isArray(configuredKeys) ? configuredKeys : [];
  const n = norm(raw);
  // Exact match against a configured key wins (a real key named "gpt" shadows
  // the alias). Compare on normalized forms so "GLM" matches "glm".
  for (const k of keys) {
    if (norm(k) === n) return k;
  }
  const aliasTarget = MODEL_ALIASES[n];
  if (aliasTarget && keys.includes(aliasTarget)) return aliasTarget;
  return null;
}

// Levenshtein distance (small inputs; simple DP).
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Nearest configured key by normalized edit-distance ratio, FOR HINTS ONLY.
 * Returns null when nothing is similar enough (ratio threshold) or when the
 * best match is ambiguous (two keys tie within the threshold).
 */
export function nearestModelKey(raw, candidateKeys) {
  const keys = Array.isArray(candidateKeys) ? candidateKeys : [];
  const n = norm(raw);
  if (!n || keys.length === 0) return null;
  let best = null, bestDist = Infinity, tie = false;
  for (const k of keys) {
    const d = levenshtein(n, norm(k));
    if (d < bestDist) { bestDist = d; best = k; tie = false; }
    else if (d === bestDist) tie = true;
  }
  if (best === null || tie) return null;
  // Accept only when the edit distance is a small fraction of the length.
  const ratio = bestDist / Math.max(n.length, norm(best).length);
  return ratio <= 0.34 ? best : null;
}

/** Build a "(did you mean `x`?)" suffix, or "" when there's no good suggestion. */
export function didYouMean(raw, candidateKeys) {
  const near = nearestModelKey(raw, candidateKeys);
  return near ? ` (did you mean \`${near}\`?)` : "";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-reporter=spec tests/aliases.test.mjs`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/aliases.mjs tests/aliases.test.mjs
git commit -m "feat: add lenient model-name alias resolution (exact+alias routing, fuzzy hints only)"
```

---

## Task 2: Display-name convention helper

**Files:**
- Create: `scripts/lib/display-name.mjs`
- Test: `tests/display-name.test.mjs`

From spec §3: display name = `<model> (<agent-or-transport>)`. The suffix is derived from transport (+ cliKind): `cli` with kind `claude`→`claude cli`, kind `codex`→`codex cli`, kind `cursor`→`cursor cli`, kind `gemini`→`gemini cli`, kind `agy`→`agy cli`, kind `kimi`→`kimi cli`; `anthropic`/`http`→`api`. The base name (e.g. `opus`, `gpt5.5`) is supplied per model.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/display-name.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { transportSuffix, computeDisplayName } from "../scripts/lib/display-name.mjs";

test("transportSuffix maps cli kinds to '<kind> cli'", () => {
  assert.equal(transportSuffix("cli", "claude"), "claude cli");
  assert.equal(transportSuffix("cli", "codex"), "codex cli");
  assert.equal(transportSuffix("cli", "cursor"), "cursor cli");
  assert.equal(transportSuffix("cli", "agy"), "agy cli");
});

test("transportSuffix maps api transports to 'api'", () => {
  assert.equal(transportSuffix("anthropic"), "api");
  assert.equal(transportSuffix("http"), "api");
});

test("computeDisplayName follows '<base> (<suffix>)'", () => {
  assert.equal(computeDisplayName("opus", "cli", "claude"), "opus (claude cli)");
  assert.equal(computeDisplayName("opus", "anthropic"), "opus (api)");
  assert.equal(computeDisplayName("gpt5.5", "cli", "codex"), "gpt5.5 (codex cli)");
  assert.equal(computeDisplayName("gpt5.5", "http"), "gpt5.5 (api)");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-reporter=spec tests/display-name.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/lib/display-name.mjs`**

```javascript
// scripts/lib/display-name.mjs
// The display-name convention: "<model base> (<agent-or-transport>)".
// Transport+cliKind decide the suffix; the base name is per-model.

export function transportSuffix(transport, cliKind) {
  if (transport === "cli") return `${cliKind ?? "cli"} cli`;
  // anthropic + http are both network APIs from the caller's perspective.
  return "api";
}

export function computeDisplayName(baseName, transport, cliKind) {
  return `${baseName} (${transportSuffix(transport, cliKind)})`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-reporter=spec tests/display-name.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/display-name.mjs tests/display-name.test.mjs
git commit -m "feat: add '<model> (<transport>)' display-name helper"
```

---

## Task 3: Bake `claude`/`codex`/`gemini`/`kimi` into MODEL_INFO; remove OPUS_INFO

**Files:**
- Modify: `scripts/lib/models.mjs` (`MODEL_INFO`, remove `OPUS_INFO`, `loadModelRegistry`)
- Test: extend `tests/config.test.mjs` (new describe block) or add `tests/registry-builtins.test.mjs`

This task adds the baked metadata entries and removes the standalone `OPUS_INFO`. It also teaches `loadModelRegistry` to MERGE a baked `MODEL_INFO` base when a `MULTIPOLY_MODELS` custom key names one of these builtins, so existing `MULTIPOLY_MODELS=claude,codex,...` deployments keep working but no longer need to supply display/reasoning/vocab env. The new entries are NOT added to `MODEL_KEYS` (default registry unchanged — see the locked design decision in the header).

Baked metadata to add to `MODEL_INFO` (these mirror the operator's working `~/.claude.json`, drawn from the spec §3 table):

```javascript
// claude: Opus 4.7, default transport cli (kind claude). API key envs let an
// anthropic-transport deployment configure it without per-model display env.
claude: Object.freeze({
  key: "claude",
  baseName: "opus",                 // display base; full name computed by transport
  transport: "cli",
  cliKind: "claude",
  defaultModel: "claude-opus-4-7",
  defaultBaseUrl: null,             // anthropic transport falls back to ANTHROPIC_DEFAULT_BASE_URL in config
  apiKeyEnv: ["MULTIPOLY_CLAUDE_API_KEY", "ANTHROPIC_API_KEY"],
  supportsThinking: true,
  reasoning: CAPABILITY.ANTHROPIC_EFFORT, // when reached over anthropic; cli ignores at the wire but --effort flag honors it
  defaultEffort: "xhigh",
}),
codex: Object.freeze({
  key: "codex",
  baseName: "gpt5.5",
  transport: "cli",
  cliKind: "codex",
  defaultModel: "gpt-5.5",
  defaultBaseUrl: null,
  apiKeyEnv: ["MULTIPOLY_CODEX_API_KEY", "OPENAI_API_KEY"],
  supportsThinking: false,
  reasoning: CAPABILITY.OPENAI_EFFORT, // http transport; cli uses -c model_reasoning_effort
  defaultEffort: "xhigh",
}),
gemini: Object.freeze({
  key: "gemini",
  baseName: "gemini-3.5-flash",
  transport: "http",
  defaultModel: "gemini-3.5-flash",
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKeyEnv: ["MULTIPOLY_GEMINI_API_KEY", "GEMINI_API_KEY"],
  supportsThinking: false,
  reasoning: CAPABILITY.OPENAI_EFFORT,
  reasoningVocab: "gemini",
  defaultEffort: "high",
}),
kimi: Object.freeze({
  key: "kimi",
  baseName: "kimi-k2.6",
  transport: "anthropic",
  defaultModel: "kimi-k2.6",
  defaultBaseUrl: "https://api.kimi.com/coding",
  apiKeyEnv: ["MULTIPOLY_KIMI_API_KEY", "MOONSHOT_API_KEY"],
  supportsThinking: true,
  reasoning: CAPABILITY.KIMI_TOGGLE,
  defaultEffort: "high",
}),
```

> NOTE on `cliKind: "claude"`/`"codex"` baked into MODEL_INFO: `CLI_KINDS` already has `claude` and `codex` entries, so this is consistent. The `claude`/`codex` MODEL_INFO entries carry `cliKind`; the existing custom-model loader (`loadModelRegistry`) and `loadCliModelConfig` read `info.cliKind`.

> NOTE on `baseName`: existing entries use `displayName` directly. The new entries add a `baseName` field; the registry loader (Task 4) computes the final `displayName` from `baseName` + transport. Existing entries (glm/qwen/deepseek/composer) keep their literal `displayName` and have no `baseName`, so the loader must fall back to `displayName` when `baseName` is absent. To keep the spec's `(api)` convention for the existing http builtins too, optionally also give them `baseName` (`glm-5.1`, `qwen3.7-max`, `deepseek-v4-pro`, `composer-2.5`) — do this so the convention is uniform (spec §3 table lists them with `(api)`/`(cursor cli)` suffixes). Keep `displayName` as a literal fallback so nothing breaks if `baseName` is later removed.

- [ ] **Step 1: Write the failing test** (add to `tests/config.test.mjs`)

```javascript
import { MODEL_INFO } from "../scripts/lib/models.mjs";

test("claude/codex/gemini/kimi are baked MODEL_INFO entries with capability + base name", () => {
  for (const k of ["claude", "codex", "gemini", "kimi"]) {
    assert.ok(MODEL_INFO[k], `${k} should be in MODEL_INFO`);
    assert.ok(MODEL_INFO[k].reasoning, `${k} should declare a reasoning capability`);
    assert.ok(MODEL_INFO[k].baseName, `${k} should declare a display base name`);
  }
});

test("OPUS_INFO is no longer exported (folded into claude)", async () => {
  const mod = await import("../scripts/lib/models.mjs");
  assert.equal(mod.OPUS_INFO, undefined);
});

test("baked builtins are NOT auto-registered (MODEL_KEYS unchanged)", async () => {
  const { MODEL_KEYS } = await import("../scripts/lib/models.mjs");
  assert.deepEqual([...MODEL_KEYS], ["glm", "qwen", "deepseek", "composer"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-reporter=spec tests/config.test.mjs`
Expected: FAIL — `MODEL_INFO.claude` undefined / `OPUS_INFO` still exported.

- [ ] **Step 3: Implement**

In `scripts/lib/models.mjs`:
1. Add the four entries above into the `MODEL_INFO` frozen object.
2. (Optional, recommended) add `baseName` to glm/qwen/deepseek/composer.
3. **Delete** the `export const OPUS_INFO = …` block.
4. **Delete** the opus-registration block in `loadModelRegistry`:
   ```javascript
   // REMOVE:
   if (firstNonEmpty(env, OPUS_INFO.apiKeyEnv)) {
     info.opus = OPUS_INFO;
     keys.push("opus");
   }
   ```
   (The `claude` alias replaces it; `claude` is registered only when an operator lists it in `MULTIPOLY_MODELS`, per the locked decision.)

- [ ] **Step 4: Run the test to verify it passes** (and the whole suite, since removing OPUS_INFO touches existing tests)

Run: `node --test --test-reporter=spec tests/config.test.mjs`
Then: `node --test --test-reporter=spec tests/*.test.mjs`
Expected: the new tests PASS. **Removing `OPUS_INFO` breaks exactly these existing tests — fix them in THIS task (do not re-add `OPUS_INFO`):**

1. `tests/reasoning.test.mjs:8` — `import { MODEL_INFO, OPUS_INFO } from "../scripts/lib/models.mjs";`. Removing the export makes the WHOLE FILE fail to load (a module-load error, not a single assertion). Fix: drop `OPUS_INFO` from the import. Then delete the regression test at `tests/reasoning.test.mjs:133-143` (`regression: OPUS_INFO has a valid CAPABILITY value…`) — its intent is now covered by the new "claude/codex/gemini/kimi are baked MODEL_INFO entries with capability" test in Task 3 Step 1, and the capability-completeness block at line ~117 already iterates `MODEL_INFO` (which now includes claude/codex/gemini/kimi). Confirm that completeness loop still passes for the new entries (each must have a valid `reasoning` CAPABILITY and concrete `defaultEffort`).
2. `tests/transport-config.test.mjs` — three opus-auto-registration tests must be converted to the new `claude`-via-`MULTIPOLY_MODELS` path:
   - `:38-51` (`opus anthropic builtin appears + configured only when ANTHROPIC_API_KEY set`) → rewrite as: with only `ANTHROPIC_API_KEY` set and NO `MULTIPOLY_MODELS=claude`, `claude` is NOT in the registry (baked builtins are opt-in); with `MULTIPOLY_MODELS=claude` + `ANTHROPIC_API_KEY`, `claude` is configured, `transport==="anthropic"` (transport-flip guard, Task 5), `model==="claude-opus-4-7"`, `baseUrl==="https://api.anthropic.com"`, `displayName==="opus (api)"`.
   - `:53-60` (`opus base URL overridable`) → same, keyed on `claude` with `MULTIPOLY_MODELS=claude` + `MULTIPOLY_CLAUDE_BASE_URL` (and `MULTIPOLY_CLAUDE_TRANSPORT=anthropic` so a base URL is meaningful).
   - `:254-257` (`registry includes opus only via loadModelRegistry env gate`) → rewrite as `loadModelRegistry({ MULTIPOLY_MODELS: "claude" })` includes `claude` with `transport` per the guard.
   - The fixture at `:242` uses a fake key value resembling a real Anthropic key (`sk-ant-…`); when rewriting, keep using a short fake value (e.g. `"x"`) to avoid the secret scanner and because the assertions only check presence/length.

Note these fixes in the commit body. If any OTHER test fails, it is genuinely asserting old behavior — fix it the same way (convert to the `claude`/`MULTIPOLY_MODELS` model) rather than restoring `OPUS_INFO`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/models.mjs tests/config.test.mjs
git commit -m "feat: bake claude/codex/gemini/kimi into MODEL_INFO; remove standalone OPUS_INFO"
```

---

## Task 4: Registry merge for baked builtins + display-name convention + transport override

**Files:**
- Modify: `scripts/lib/models.mjs` (`loadModelRegistry` custom-key branch)
- Modify: `scripts/lib/config.mjs` (display-name computation is fine to keep in the registry; config reads `info.displayName`)
- Test: extend `tests/config.test.mjs`

When `MULTIPOLY_MODELS` lists a key that exists in `MODEL_INFO` (e.g. `claude`), the loader must use the baked `MODEL_INFO[key]` as the BASE and overlay env-provided overrides (`MULTIPOLY_<K>_TRANSPORT`, `_MODEL`, `_BASE_URL`, `_DISPLAY_NAME`, `_REASONING`, `_REASONING_VOCAB`, `_CLI_KIND`). Today that branch builds `base` from scratch and would (a) duplicate-error on a builtin name and (b) lose the baked capability. After this change:
- A `MULTIPOLY_MODELS` entry naming a known `MODEL_INFO` key is allowed (no "duplicates a builtin" error for these promotable keys — but still error for the always-on `MODEL_KEYS` four).
- Baked fields fill in; env overrides win.
- The final `displayName`: if `MULTIPOLY_<K>_DISPLAY_NAME` is set, use it verbatim; else if `info.baseName` exists, `computeDisplayName(baseName, transport, cliKind)`; else `info.displayName` ?? key.

> **Promotable vs always-on:** Define `PROMOTABLE_BUILTINS = new Set(["claude","codex","gemini","kimi"])` (and in Plan C, `mimo`). A `MULTIPOLY_MODELS` entry in this set merges the baked base. A `MULTIPOLY_MODELS` entry equal to one of the `MODEL_KEYS` four remains a "duplicates a builtin" error (those are always registered).

- [ ] **Step 1: Write the failing test** (add to `tests/config.test.mjs`)

```javascript
import { loadModelRegistry } from "../scripts/lib/models.mjs";

test("MULTIPOLY_MODELS=claude merges baked MODEL_INFO base (capability, base name)", () => {
  const { keys, info } = loadModelRegistry({
    MULTIPOLY_MODELS: "claude",
    MULTIPOLY_CLAUDE_TRANSPORT: "anthropic",
    MULTIPOLY_CLAUDE_API_KEY: "x", // fake; just needs to be present for downstream config
  });
  assert.ok(keys.includes("claude"));
  assert.equal(info.claude.reasoning, "anthropic_effort"); // baked
  assert.equal(info.claude.transport, "anthropic"); // env override applied
  // display name follows the convention for the chosen transport:
  assert.equal(info.claude.displayName, "opus (api)");
});

test("MULTIPOLY_MODELS=claude with default (cli) transport names it 'opus (claude cli)'", () => {
  const { info } = loadModelRegistry({ MULTIPOLY_MODELS: "claude" });
  assert.equal(info.claude.transport, "cli");
  assert.equal(info.claude.displayName, "opus (claude cli)");
});

test("listing an always-on builtin (glm) in MULTIPOLY_MODELS still errors", () => {
  assert.throws(
    () => loadModelRegistry({ MULTIPOLY_MODELS: "glm" }),
    /duplicates a builtin/,
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-reporter=spec tests/config.test.mjs`
Expected: FAIL — current loader throws "duplicates a builtin" for `claude` (it's now in `MODEL_INFO`, and the loader's `seen` set or the new merge logic isn't there yet).

- [ ] **Step 3: Implement the merge in `loadModelRegistry`**

In the `MULTIPOLY_MODELS` loop, before the `seen.has(key)` duplicate check, special-case promotable builtins:

```javascript
import { computeDisplayName } from "./display-name.mjs";

const PROMOTABLE_BUILTINS = new Set(["claude", "codex", "gemini", "kimi"]); // + "mimo" in Plan C

// inside the for-loop over MULTIPOLY_MODELS entries, after key validation:
const baked = PROMOTABLE_BUILTINS.has(key) ? MODEL_INFO[key] : undefined;

if (seen.has(key) && !baked) {
  throw new MultipolyError("CONFIG", `MULTIPOLY_MODELS entry ${JSON.stringify(key)} duplicates a builtin or earlier model.`);
}
// (a promotable builtin is in MODEL_INFO but NOT in MODEL_KEYS, so it isn't in
//  `seen` yet unless listed twice; guard against double-listing explicitly:)
if (seen.has(key) && baked) {
  throw new MultipolyError("CONFIG", `MULTIPOLY_MODELS entry ${JSON.stringify(key)} is listed more than once.`);
}
seen.add(key);
keys.push(key);

const prefix = envPrefixForModel(key);
const transport = parseTransport(
  env[`${prefix}_TRANSPORT`],
  `${prefix}_TRANSPORT`,
  baked?.transport, // NEW optional 3rd arg: default when env unset (see below)
);
const base = {
  key,
  transport,
  // env DISPLAY_NAME wins; else convention from baseName; else baked/legacy displayName; else key
  displayName:
    (env[`${prefix}_DISPLAY_NAME`] || "").trim() ||
    (baked?.baseName ? computeDisplayName(baked.baseName, transport, baked.cliKind ?? parseOptionalCliKind(env, prefix)) :
      baked?.displayName) ||
    key,
  defaultModel: baked?.defaultModel ?? null,
  defaultBaseUrl:
    baked?.defaultBaseUrl ??
    (transport === "anthropic" ? ANTHROPIC_DEFAULT_BASE_URL : null),
  apiKeyEnv: baked?.apiKeyEnv ?? Object.freeze([`${prefix}_API_KEY`]),
  supportsThinking:
    env[`${prefix}_THINKING`] !== undefined && env[`${prefix}_THINKING`] !== ""
      ? parseThinkingFlag(env[`${prefix}_THINKING`])
      : Boolean(baked?.supportsThinking),
  // Carry the OpenAI-compat token-cap field switch from the baked entry so the
  // http loader/client can read it for promotable builtins (e.g. mimo in Plan C).
  ...(baked?.usesMaxCompletionTokens ? { usesMaxCompletionTokens: true } : {}),
};
```

Then the existing capability-inference block must prefer the baked capability when no explicit `MULTIPOLY_<K>_REASONING` is set:

```javascript
const explicitReasoning = (env[`${prefix}_REASONING`] || "").trim();
if (explicitReasoning) {
  // …existing validation… base.reasoning = explicitReasoning;
} else if (baked?.reasoning) {
  base.reasoning = baked.reasoning;          // NEW: baked capability wins over transport inference
} else if (transport === "anthropic") {
  base.reasoning = CAPABILITY.ANTHROPIC_EFFORT;
} // …rest unchanged (http vocab inference, cli→NONE)…

// reasoningVocab: env override, else baked
const vocabEnv = (env[`${prefix}_REASONING_VOCAB`] || "").trim();
if (vocabEnv && base.reasoning === CAPABILITY.OPENAI_EFFORT) base.reasoningVocab = vocabEnv;
else if (baked?.reasoningVocab && base.reasoning === CAPABILITY.OPENAI_EFFORT) base.reasoningVocab = baked.reasoningVocab;

// cliKind: env override, else baked
if (transport === "cli") {
  base.cliKind = (env[`${prefix}_CLI_KIND`] || "").trim()
    ? parseCliKind(env[`${prefix}_CLI_KIND`], `${prefix}_CLI_KIND`)
    : (baked?.cliKind ?? parseCliKind(env[`${prefix}_CLI_KIND`], `${prefix}_CLI_KIND`));
}

// defaultEffort: baked wins, else "off" (existing behavior)
base.defaultEffort = baked?.defaultEffort ?? "off";
```

Add a small helper `parseTransport(raw, label, fallback = "http")` — change its default branch from `if (!v) return "http"` to `if (!v) return fallback ?? "http"`. Add `parseOptionalCliKind(env, prefix)` returning the cli kind or undefined when transport isn't cli (used only for the displayName computation when transport is cli but cliKind comes from baked).

> Keep the change surgical: the cleanest implementation factors a `bakedBaseFor(key)` helper and a `mergeEnvOverEntry(baked, env, prefix)` function rather than inflating the loop. Use your judgment; the tests define the contract.

- [ ] **Step 4: Run to verify pass + full suite**

Run: `node --test --test-reporter=spec tests/config.test.mjs`
Then: `node --test --test-reporter=spec tests/*.test.mjs`
Expected: new tests PASS; fix any remaining OPUS-era test fallout.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/models.mjs scripts/lib/config.mjs tests/config.test.mjs
git commit -m "feat: merge baked builtin metadata under env overrides; apply display-name convention"
```

---

## Task 5: Transport-flip guard + startup transport log for claude/codex

**Files:**
- Modify: `scripts/lib/models.mjs` (`loadModelRegistry`, claude/codex transport resolution)
- Test: extend `tests/config.test.mjs`

From spec §3 "Transport-default safety": to avoid silently flipping an Anthropic-API `opus` to a local CLI, if `MULTIPOLY_CLAUDE_TRANSPORT` is UNSET and an Anthropic key (`ANTHROPIC_API_KEY` or `MULTIPOLY_CLAUDE_API_KEY`, or a legacy `MULTIPOLY_OPUS_API_KEY`) is present, default `claude`'s transport to `anthropic` rather than the baked `cli`. Symmetric guard is NOT required for codex (no prior API deployment to protect) but apply the same shape if `MULTIPOLY_CODEX_TRANSPORT` unset and `OPENAI_API_KEY`/`MULTIPOLY_CODEX_API_KEY` present → keep baked `cli` (codex's baked default is cli and there's no legacy to protect, so just log). Always emit a structured stderr line noting the chosen transport for claude/codex so the operator can see it.

> **Simplification (documented):** the spec says "no Claude CLI auth detected." We cannot reliably detect Claude CLI auth from env, so we use the simpler, safe rule above (unset transport + Anthropic key present ⇒ anthropic). An operator who wants the CLI with an Anthropic key in env sets `MULTIPOLY_CLAUDE_TRANSPORT=cli` explicitly. This is strictly safer than the old behavior and is logged.

- [ ] **Step 1: Write the failing test**

```javascript
test("claude defaults to anthropic transport when an Anthropic key is present and transport is unset", () => {
  const { info } = loadModelRegistry({
    MULTIPOLY_MODELS: "claude",
    ANTHROPIC_API_KEY: "x",
  });
  assert.equal(info.claude.transport, "anthropic");
  assert.equal(info.claude.displayName, "opus (api)");
});

test("explicit MULTIPOLY_CLAUDE_TRANSPORT=cli wins over the Anthropic-key guard", () => {
  const { info } = loadModelRegistry({
    MULTIPOLY_MODELS: "claude",
    ANTHROPIC_API_KEY: "x",
    MULTIPOLY_CLAUDE_TRANSPORT: "cli",
  });
  assert.equal(info.claude.transport, "cli");
});

test("claude with no key and unset transport keeps baked cli", () => {
  const { info } = loadModelRegistry({ MULTIPOLY_MODELS: "claude" });
  assert.equal(info.claude.transport, "cli");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-reporter=spec tests/config.test.mjs`
Expected: FAIL — claude stays `cli` even with `ANTHROPIC_API_KEY`.

- [ ] **Step 3: Implement the guard** in the transport-resolution portion of the custom-key loop:

```javascript
function resolveBuiltinTransport(key, env, prefix, baked) {
  const explicit = (env[`${prefix}_TRANSPORT`] || "").trim();
  if (explicit) return parseTransport(explicit, `${prefix}_TRANSPORT`);
  if (key === "claude") {
    const anthropicKeyPresent = firstNonEmpty(env, ["ANTHROPIC_API_KEY", "MULTIPOLY_CLAUDE_API_KEY", "MULTIPOLY_OPUS_API_KEY"]);
    const chosen = anthropicKeyPresent ? "anthropic" : (baked?.transport ?? "cli");
    process.stderr.write(JSON.stringify({ event: "transport_default", model: "claude", chosen, reason: anthropicKeyPresent ? "anthropic key present, transport unset" : "no anthropic key; baked default" }) + "\n");
    return chosen;
  }
  if (key === "codex") {
    const chosen = baked?.transport ?? "cli";
    process.stderr.write(JSON.stringify({ event: "transport_default", model: "codex", chosen, reason: "baked default" }) + "\n");
    return chosen;
  }
  return parseTransport(undefined, `${prefix}_TRANSPORT`, baked?.transport);
}
```

Wire `resolveBuiltinTransport(key, env, prefix, baked)` in place of the bare `parseTransport(env[...])` for promotable builtins. (Non-promotable custom models keep the existing `parseTransport`.)

> Tests assert on the returned registry, not on stderr. The stderr log is best-effort observability; do not assert its exact text (keep tests robust). If you want a log assertion, capture `process.stderr.write` via a spy in one focused test.

- [ ] **Step 4: Run to verify pass + full suite**

Run: `node --test --test-reporter=spec tests/config.test.mjs && node --test --test-reporter=spec tests/*.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/models.mjs tests/config.test.mjs
git commit -m "feat: claude transport-flip guard (anthropic key ⇒ anthropic) + transport log"
```

---

## Task 6: `MULTIPOLY_OPUS_*` / `MULTIPOLY_GPT55_*` migration warning

**Files:**
- Modify: `scripts/lib/models.mjs` (`loadModelRegistry`, once near the end) OR `scripts/lib/config.mjs` (`loadConfig`)
- Test: extend `tests/config.test.mjs`

From spec §7: scan for `MULTIPOLY_OPUS_*` and `MULTIPOLY_GPT55_*` env vars at startup; if any are present, emit a LOUD structured stderr warning pointing at the canonical `MULTIPOLY_CLAUDE_*` / `MULTIPOLY_CODEX_*` keys so the operator knows the old vars are no-ops. Do not throw. Emit at most once.

- [ ] **Step 1: Write the failing test**

```javascript
test("a MULTIPOLY_OPUS_* var present emits a migration warning to stderr", () => {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    loadModelRegistry({ MULTIPOLY_OPUS_API_KEY: "x", MULTIPOLY_GLM_API_KEY: "y" });
  } finally {
    process.stderr.write = orig;
  }
  const blob = lines.join("");
  assert.match(blob, /MULTIPOLY_OPUS_/);
  assert.match(blob, /MULTIPOLY_CLAUDE_/);
});

test("no warning when no legacy vars are present", () => {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    loadModelRegistry({ MULTIPOLY_GLM_API_KEY: "y" });
  } finally {
    process.stderr.write = orig;
  }
  assert.ok(!lines.join("").includes("MULTIPOLY_OPUS_"));
});
```

- [ ] **Step 2: Run to verify failure** → no warning emitted yet.

- [ ] **Step 3: Implement** near the end of `loadModelRegistry` (after the registry is built, before `return`):

```javascript
warnLegacyMigration(env);

// …

const LEGACY_PREFIXES = [
  { prefix: "MULTIPOLY_OPUS_", canonical: "MULTIPOLY_CLAUDE_*" },
  { prefix: "MULTIPOLY_GPT55_", canonical: "MULTIPOLY_CODEX_*" },
];
function warnLegacyMigration(env) {
  for (const { prefix, canonical } of LEGACY_PREFIXES) {
    const hits = Object.keys(env).filter((k) => k.startsWith(prefix));
    if (hits.length === 0) continue;
    process.stderr.write(
      JSON.stringify({
        event: "legacy_env_ignored",
        vars: hits,
        message: `${prefix}* is no longer used; the model folded into its canonical key. Use ${canonical} instead. These vars are currently IGNORED.`,
      }) + "\n",
    );
  }
}
```

- [ ] **Step 4: Run to verify pass + full suite.**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/models.mjs tests/config.test.mjs
git commit -m "feat: warn on legacy MULTIPOLY_OPUS_*/GPT55_* env at startup"
```

---

## Task 7: Lenient resolution for council `models[]` and `synthesizer`

**Files:**
- Modify: `scripts/lib/council.mjs` (`resolveCouncilModels`)
- Modify: `scripts/lib/config.mjs` (`normalizeSynthesizerChoice`)
- Test: extend `tests/council.test.mjs` and `tests/config.test.mjs`

From spec §4: route `models[]` entries and the `synthesizer` arg through `resolveModelAlias`. Dedup after resolution (e.g. `[gpt, codex] → [codex]`). If unresolved, throw `INVALID_INPUT` listing valid configured names + a "did you mean" hint. Sentinels `harness`/`none`/`caller` must NOT be alias-resolved (handle them before alias lookup in the synthesizer path). Do NOT strip a `_review`/`_consult` suffix.

- [ ] **Step 1: Write the failing test** (council)

```javascript
// in tests/council.test.mjs — assuming a helper that builds a config with
// configured glm+codex (+ others). Follow the file's existing config fixture pattern.
test("council resolves aliased member names and dedups", async () => {
  // models: ["gpt", "codex"] should collapse to a single "codex" → then needs ≥2
  // so use ["gpt", "glm"] → ["codex"? no]; use a 2-distinct case:
  // ["openai", "zhipu"] → ["codex", "glm"]
  // assert resolveCouncilModels returns ["codex","glm"] (order-insensitive)
});

test("council errors with a did-you-mean hint on an unknown member", async () => {
  // models: ["codexx", "glm"] → throws INVALID_INPUT matching /did you mean .*codex/
});

test("council dedups alias collapse but errors if <2 remain", async () => {
  // models: ["gpt", "codex"] → both → "codex" → single → INVALID_INPUT (needs ≥2)
});
```

Fill these in against the existing council test fixtures (the file already constructs configs and calls `handleCouncilReview`/`handleCouncilConsult`; reuse that). If `resolveCouncilModels` is not exported, export it for direct unit testing (preferred — add `export` to the function) and test it directly with a hand-built `{ modelKeys, models: { … } }` config.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — rewrite `resolveCouncilModels`:

```javascript
import { resolveModelAlias, didYouMean } from "./aliases.mjs";

export function resolveCouncilModels(input, config) {
  const known = config.modelKeys ?? MODEL_KEYS;
  let requested;
  if (input.models?.length) {
    requested = input.models.map((raw) => {
      const resolved = resolveModelAlias(raw, known);
      if (!resolved) {
        throw new MultipolyError(
          "INVALID_INPUT",
          `unknown model ${JSON.stringify(raw)}; expected one of ${known.join(", ")}${didYouMean(raw, known)}`,
        );
      }
      return resolved;
    });
  } else {
    requested = known.filter((key) => config.models[key]?.configured);
  }
  const unique = [...new Set(requested)]; // dedups alias collapse silently
  if (unique.length < 2) {
    throw new MultipolyError("INVALID_INPUT", "council requires at least two distinct models");
  }
  const missing = unique.filter((key) => !config.models[key]?.configured);
  if (missing.length > 0) {
    throw new MultipolyError("CONFIG", `council requested unconfigured models: ${missing.join(", ")}`, { details: { missing } });
  }
  return unique;
}
```

And `normalizeSynthesizerChoice` in `config.mjs`:

```javascript
import { resolveModelAlias } from "./aliases.mjs";

export function normalizeSynthesizerChoice(raw, modelKeys = MODEL_KEYS) {
  const v = String(raw).toLowerCase();
  if (HARNESS_ALIASES.has(v)) return HARNESS_SENTINEL; // sentinels first — never alias-resolved
  const resolved = resolveModelAlias(raw, modelKeys);
  return resolved ?? null;
}
```

> Note: `config.mjs` importing `aliases.mjs` is fine (aliases.mjs imports only errors.mjs — no cycle). Verify with `node -e "import('./scripts/lib/config.mjs').then(()=>console.log('ok'))"`.

- [ ] **Step 4: Run to verify pass + full suite.**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/council.mjs scripts/lib/config.mjs tests/council.test.mjs tests/config.test.mjs
git commit -m "feat: lenient council model + synthesizer name resolution (alias routing, hints on miss)"
```

---

## Task 8: Curated `opus_*` / `gpt55_*` alias tools

**Files:**
- Modify: `scripts/multipoly-mcp.mjs` (`buildToolDefs`)
- Test: extend `tests/mcp-tools.test.mjs` (anti-drift) + add a focused alias-tool test

From spec §4/§5: emit alias tools `opus_review`/`opus_consult` routed to the `claude` handler, and `gpt55_review`/`gpt55_consult` routed to the `codex` handler — BUT ONLY when the canonical target key is in the registry. The alias tool's schema and `allowedKeys` must equal the canonical tool's (including `reasoning_effort` when the target is reasoning-capable). The anti-drift test (tools ≡ handlers ≡ validator keys) must continue to pass and now also assert the alias tools route to the canonical handler.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/mcp-tools.test.mjs (extend)
import { buildTools, buildServerSurface } from "../scripts/multipoly-mcp.mjs";

test("opus_* alias tools appear only when claude is registered, routed to claude handler", () => {
  const registryWithClaude = {
    keys: ["glm", "claude"],
    info: { glm: { key: "glm", displayName: "GLM 5.1", reasoning: "http_thinking_toggle" },
            claude: { key: "claude", displayName: "opus (claude cli)", reasoning: "anthropic_effort" } },
  };
  const tools = buildTools(registryWithClaude).map((t) => t.name);
  assert.ok(tools.includes("opus_review"));
  assert.ok(tools.includes("opus_consult"));

  const noClaude = { keys: ["glm"], info: { glm: { key: "glm", displayName: "GLM 5.1", reasoning: "http_thinking_toggle" } } };
  const tools2 = buildTools(noClaude).map((t) => t.name);
  assert.ok(!tools2.includes("opus_review"));
});

test("alias tool schema matches its canonical tool's schema", () => {
  const reg = { keys: ["claude"], info: { claude: { key: "claude", displayName: "opus (claude cli)", reasoning: "anthropic_effort" } } };
  const tools = Object.fromEntries(buildTools(reg).map((t) => [t.name, t]));
  assert.deepEqual(tools["opus_review"].inputSchema, tools["claude_review"].inputSchema);
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** in `buildToolDefs`, after the per-model loop and the council defs, before `return defs`:

```javascript
// Curated alias tools: <alias>_review/_consult routed to a canonical handler.
// Registered only when the canonical key is present in the registry. Schema +
// allowedKeys are copied from the canonical def so they can't drift.
const ALIAS_TOOLS = [
  { alias: "opus", canonical: "claude" },
  { alias: "gpt55", canonical: "codex" },
];
const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
for (const { alias, canonical } of ALIAS_TOOLS) {
  for (const suffix of ["review", "consult"]) {
    const target = byName[`${canonical}_${suffix}`];
    if (!target) continue; // canonical not registered → no alias tool
    defs.push({
      name: `${alias}_${suffix}`,
      description: `Alias for ${canonical}_${suffix} (${registry.info[canonical]?.displayName ?? canonical}).`,
      inputSchema: target.inputSchema,
      allowedKeys: target.allowedKeys,
      handler: target.handler,
    });
  }
}
```

> Because `buildServerSurface` derives `handlers` and `toolKeySpec` from the same `defs`, the alias tools automatically get a routed handler and the right validator key set. No change needed in `validateToolInput` (it dispatches on `_review`/`_consult` suffix, which the alias names share).

- [ ] **Step 4: Run to verify pass + full suite** (the anti-drift integration test must stay green).

Run: `node --test --test-reporter=spec tests/mcp-tools.test.mjs tests/mcp-integration.test.mjs && node --test --test-reporter=spec tests/*.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/multipoly-mcp.mjs tests/mcp-tools.test.mjs
git commit -m "feat: register curated opus_*/gpt55_* alias tools routed to canonical handlers"
```

---

## Task 9: Docs — naming convention, aliases, migration

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1** — README: add a "Model names & aliases" section documenting the `<model> (<transport>)` convention, the alias table (gpt/opus/flash/etc.), the `opus_*`/`gpt55_*` alias tools, that `claude`/`codex`/`gemini`/`kimi` are baked builtins opted-in via `MULTIPOLY_MODELS`, and the claude transport-flip rule. Note (per spec) that aliases route by exact+alias only and that an unknown name returns a "did you mean" hint, never a silent reroute.
- [ ] **Step 2** — CHANGELOG: an entry summarizing Plan B (display-name convention, baked builtins, OPUS_INFO removal + `MULTIPOLY_OPUS_*` migration warning, lenient council/synthesizer resolution, alias tools).
- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: model-naming convention, alias table, alias tools, OPUS migration"
```

---

## Final verification (after all tasks)

- [ ] Full suite green: `node --test --test-reporter=spec tests/*.test.mjs` (expect ≥ 360 + new tests).
- [ ] Health check with a claude-via-anthropic config does not throw:
  `MULTIPOLY_MODELS=claude ANTHROPIC_API_KEY=x MULTIPOLY_GLM_API_KEY=y node scripts/multipoly-mcp.mjs --health` → JSON `status: ok`, `claude` present with `displayName: "opus (api)"`.
- [ ] `git grep -n OPUS_INFO scripts/` returns nothing (fully removed).
- [ ] Dispatch the final code-reviewer subagent for the whole branch, then use superpowers:finishing-a-development-branch.
```
