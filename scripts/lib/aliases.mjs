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
  xai: "grok", "grok-build": "grok",
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
  // Model keys are lowercase by convention, but use norm() here so both lookup
  // paths (exact-match above and alias-target below) are consistently case-insensitive.
  if (aliasTarget && keys.some((k) => norm(k) === aliasTarget)) return aliasTarget;
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
