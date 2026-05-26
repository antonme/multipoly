import { MultipolyError } from "./errors.mjs";
import { MODEL_KEYS, envPrefixForModel, firstNonEmpty, loadModelRegistry } from "./models.mjs";

const ENDPOINT_PROFILES = Object.freeze({
  "zai-coding-plan": "https://api.z.ai/api/coding/paas/v4",
  "bigmodel-cn": "https://open.bigmodel.cn/api/paas/v4",
});

// GLM 5.1's published output limit is 131072 tokens (models.dev / opencode);
// reasoning tokens share that budget with content. Non-GLM providers do not
// inherit this default: unless the user sets a server-wide or model-specific
// cap, we omit max_tokens and let that provider's default apply.
const MODEL_OUTPUT_CEILING = 131072;

// Shared bounds for the upstream stream inactivity timeout, applied to both
// the env-derived timeout and the per-call `timeout_ms` tool argument so they
// can't disagree. Max stays below Node's setTimeout 32-bit overflow.
export const TIMEOUT_BOUNDS = Object.freeze({ min: 1, max: 3_600_000 });

/**
 * Validate a per-call timeout override (the `timeout_ms` tool argument).
 * Returns the integer ms, or undefined when not supplied. Throws
 * INVALID_INPUT on a malformed or out-of-range value so the caller gets a
 * clear error instead of a silently-ignored argument.
 */
export function resolveCallTimeoutMs(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < TIMEOUT_BOUNDS.min ||
    raw > TIMEOUT_BOUNDS.max
  ) {
    throw new MultipolyError(
      "INVALID_INPUT",
      `timeout_ms must be an integer in [${TIMEOUT_BOUNDS.min}, ${TIMEOUT_BOUNDS.max}] ms, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function parseBool(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const v = String(raw).toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parseInteger(raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new MultipolyError(
      "CONFIG",
      `expected integer in [${min}, ${max}], got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/**
 * Validate a caller-supplied GLM_BASE_URL. The API key is sent as a bearer to
 * this URL, so arbitrary schemes (file://, ftp://, http://) or empty hosts
 * would be a credential-exfiltration risk. Require https by default; allow
 * http only for loopback hosts (dev proxies).
 */
function validateCustomBaseUrl(raw, label = "GLM_BASE_URL") {
  const trimmed = String(raw).trim().replace(/\/+$/, "");
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    throw new MultipolyError("CONFIG", `${label} is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (u.username || u.password) {
    throw new MultipolyError("CONFIG", `${label} must not contain userinfo`);
  }
  if (!u.hostname) {
    throw new MultipolyError("CONFIG", `${label} must have a hostname`);
  }
  if (u.search || u.hash) {
    // A query or fragment would be clobbered when the client appends
    // `/chat/completions`, so reject at parse time rather than misroute later.
    throw new MultipolyError("CONFIG", `${label} must not contain a query or fragment`);
  }
  // WHATWG URL returns IPv6 hosts in bracket form (e.g. "[::1]"). Strip the
  // brackets before comparing against loopback literals. Accept the full
  // 127.0.0.0/8 range plus IPv6 loopback variants (including the v4-mapped
  // form ::ffff:127.0.0.1) so local dev proxies aren't rejected on
  // platforms that prefer them.
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // WHATWG URL normalizes "::ffff:127.0.0.1" to "::ffff:7f00:1", so the
  // IPv4-mapped loopback range lands as "::ffff:7f[00-ff]:[0-ffff]".
  const isLoopback =
    host === "localhost" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host);
  if (u.protocol === "https:") return trimmed;
  if (u.protocol === "http:" && isLoopback) return trimmed;
  throw new MultipolyError(
    "CONFIG",
    `${label} must use https:// (http:// allowed only for loopback), got ${u.protocol}//${u.hostname}`,
  );
}

function resolveLegacyGlmBaseUrl(env) {
  const explicit = (env.GLM_BASE_URL || "").trim();
  if (explicit) return explicit;

  const endpoint = env.GLM_ENDPOINT || "zai-coding-plan";
  if (endpoint === "custom") {
    throw new MultipolyError("CONFIG", "GLM_ENDPOINT=custom requires GLM_BASE_URL");
  }
  if (ENDPOINT_PROFILES[endpoint]) return ENDPOINT_PROFILES[endpoint];

  const valid = [...Object.keys(ENDPOINT_PROFILES), "custom"].join(", ");
  throw new MultipolyError(
    "CONFIG",
    `GLM_ENDPOINT must be one of ${valid}, got ${JSON.stringify(endpoint)}`,
  );
}

function loadOneModelConfig(env, key, info, serverMaxTokens) {
  const prefix = envPrefixForModel(key);
  const explicitModelBaseUrl = (env[`${prefix}_BASE_URL`] || "").trim();
  const explicitLegacyGlmBaseUrl = key === "glm" ? (env.GLM_BASE_URL || "").trim() : "";
  const keyHit = firstNonEmpty(env, info.apiKeyEnv);

  // Resolve the legacy GLM endpoint profile only when GLM is unset via the
  // model-specific base URL. A malformed legacy GLM_ENDPOINT/GLM_BASE_URL is a
  // hard error ONLY when GLM is actually being configured (has an API key);
  // for a deployment that doesn't use GLM at all, a stray legacy endpoint must
  // not block startup — GLM simply stays unconfigured for lack of a key.
  let legacyGlmBaseUrl = null;
  if (key === "glm" && !explicitModelBaseUrl) {
    try {
      legacyGlmBaseUrl = resolveLegacyGlmBaseUrl(env);
    } catch (e) {
      if (keyHit) throw e;
      legacyGlmBaseUrl = null;
    }
  }
  const baseUrlRaw = explicitModelBaseUrl || legacyGlmBaseUrl || info.defaultBaseUrl;
  const baseUrlLabel = explicitModelBaseUrl
    ? `${prefix}_BASE_URL`
    : explicitLegacyGlmBaseUrl
      ? "GLM_BASE_URL"
      : `${prefix}_BASE_URL`;
  const model =
    env[`${prefix}_MODEL`] ||
    (key === "glm" ? env.GLM_MODEL : null) ||
    info.defaultModel;
  const reviewMaxTokens = parseInteger(
    env[`${prefix}_MAX_TOKENS_REVIEW`],
    key === "glm" || serverMaxTokens.explicit.review ? serverMaxTokens.values.review : undefined,
  );
  const consultMaxTokens = parseInteger(
    env[`${prefix}_MAX_TOKENS_CONSULT`],
    key === "glm" || serverMaxTokens.explicit.consult ? serverMaxTokens.values.consult : undefined,
  );
  const maxTokens = Object.freeze({ review: reviewMaxTokens, consult: consultMaxTokens });
  const missing = [];

  if (!baseUrlRaw) missing.push(`${prefix}_BASE_URL`);
  if (!model) missing.push(`${prefix}_MODEL`);
  if (!keyHit) missing.push(info.apiKeyEnv.join(" or "));

  if (missing.length > 0) {
    return Object.freeze({
      key,
      displayName: info.displayName,
      configured: false,
      missing: Object.freeze(missing),
      model,
      baseUrl: baseUrlRaw || null,
      apiKey: null,
      supportsThinking: Boolean(info.supportsThinking),
      maxTokens,
    });
  }

  return Object.freeze({
    key,
    displayName: info.displayName,
    configured: true,
    missing: Object.freeze([]),
    model,
    baseUrl: validateCustomBaseUrl(baseUrlRaw, baseUrlLabel),
    apiKey: keyHit.value,
    apiKeyEnv: keyHit.name,
    supportsThinking: Boolean(info.supportsThinking),
    maxTokens,
  });
}

// Sentinel meaning "do not run a server-side synthesizer model; hand the
// council member outputs back to the calling harness to synthesize".
export const HARNESS_SENTINEL = "harness";
const HARNESS_ALIASES = new Set(["harness", "none", "caller"]);

// Allowed values for a synthesizer choice (env default or per-call arg),
// surfaced for the MCP tool schema enum so it stays in sync with the parser.
export const SYNTHESIZER_CHOICES = Object.freeze([...MODEL_KEYS, "harness", "none", "caller"]);

// Fall-through order applied after the "chosen one" when resolving which
// configured model synthesizes: chosen → qwen → deepseek → glm → composer.
export const SYNTHESIZER_FALLBACK_ORDER = Object.freeze(["qwen", "deepseek", "glm", "composer"]);

/**
 * Normalize a synthesizer choice string.
 *   - harness|none|caller → "harness" (defer to the calling harness)
 *   - a known model key   → that key
 *   - anything else       → null (caller decides which error code to raise)
 */
export function normalizeSynthesizerChoice(raw, modelKeys = MODEL_KEYS) {
  const v = String(raw).toLowerCase();
  if (HARNESS_ALIASES.has(v)) return HARNESS_SENTINEL;
  if (modelKeys.includes(v)) return v;
  return null;
}

/**
 * Parse the MULTIPOLY_SYNTHESIZER env preference against the active registry.
 *   - unset/"" → undefined (council defers to the harness by default)
 *   - otherwise normalized via normalizeSynthesizerChoice; invalid → CONFIG error
 */
function parseSynthesizer(raw, modelKeys) {
  if (raw === undefined || raw === "") return undefined;
  const normalized = normalizeSynthesizerChoice(raw, modelKeys);
  if (normalized === null) {
    throw new MultipolyError(
      "CONFIG",
      `MULTIPOLY_SYNTHESIZER must be one of ${modelKeys.join(", ")}, harness, none, or caller; got ${JSON.stringify(raw)}`,
    );
  }
  return normalized;
}

function parseThinking(raw) {
  if (raw === undefined || raw === "") return "mode-default";
  const v = String(raw).toLowerCase();
  if (["on", "1", "true", "yes"].includes(v)) return "on";
  if (["off", "0", "false", "no"].includes(v)) return "off";
  if (v === "auto") return "auto";
  throw new MultipolyError("CONFIG", `MULTIPOLY_THINKING must be one of on|off|auto, got ${JSON.stringify(raw)}`);
}

export function loadConfig(env = process.env) {
  const registry = loadModelRegistry(env);
  const serverMaxTokens = parseServerMaxTokens(env);
  const models = Object.freeze(
    Object.fromEntries(
      registry.keys.map((key) => [key, loadOneModelConfig(env, key, registry.info[key], serverMaxTokens)]),
    ),
  );

  if (!Object.values(models).some((m) => m.configured)) {
    throw new MultipolyError(
      "AUTH",
      "No model API key found. Configure at least one model, for example MULTIPOLY_GLM_API_KEY.",
    );
  }

  const thinking = parseThinking(env.MULTIPOLY_THINKING ?? env.GLM_THINKING);
  const synthesizer = parseSynthesizer(env.MULTIPOLY_SYNTHESIZER, registry.keys);

  const maxTokens = serverMaxTokens.values;

  const caps = {
    perFile: parseInteger(env.MULTIPOLY_PER_FILE_CAP_BYTES ?? env.GLM_PER_FILE_CAP_BYTES, 256 * 1024),
    total: parseInteger(env.MULTIPOLY_TOTAL_CAP_BYTES ?? env.GLM_TOTAL_CAP_BYTES, 1536 * 1024),
    fileCount: parseInteger(env.MULTIPOLY_FILE_COUNT_CAP ?? env.GLM_FILE_COUNT_CAP, 50),
  };

  // Default 600s: GLM 5.1 in thinking mode can stream reasoning for several
  // minutes on a large multi-file review before the first content byte. This
  // is an INACTIVITY timeout (every SSE chunk resets it), so a healthy long
  // review never trips it; 600s only bounds a genuinely stalled upstream.
  // Cap at 1h, comfortably below Node's setTimeout 32-bit overflow
  // (2^31-1 ms ≈ 24.8d, beyond which the timer wraps and fires immediately).
  // NOTE: this only governs the GLM<->upstream stream. The MCP *client*
  // (Claude Code, Codex, opencode) imposes its own tool-call timeout on top —
  // e.g. Codex's is a fixed 120s — which this value cannot extend. A per-call
  // `timeout_ms` argument can lower this for a single call but likewise can't
  // exceed the client's ceiling.
  const timeoutMs = parseInteger(env.MULTIPOLY_TIMEOUT_MS ?? env.GLM_TIMEOUT_MS, 600_000, TIMEOUT_BOUNDS);
  const allowSecrets = parseBool(env.MULTIPOLY_ALLOW_SECRETS ?? env.GLM_ALLOW_SECRETS, false);
  const debugReasoning = parseBool(env.MULTIPOLY_DEBUG_REASONING ?? env.GLM_DEBUG_REASONING, false);
  const progress = parseProgress(env.MULTIPOLY_PROGRESS ?? env.GLM_PROGRESS);

  return Object.freeze({
    models,
    modelKeys: Object.freeze([...registry.keys]),
    thinking,
    synthesizer,
    maxTokens: Object.freeze(maxTokens),
    caps: Object.freeze(caps),
    timeoutMs,
    allowSecrets,
    debugReasoning,
    progress,
  });
}

function parseServerMaxTokens(env) {
  const reviewRaw = env.MULTIPOLY_MAX_TOKENS_REVIEW ?? env.GLM_MAX_TOKENS_REVIEW;
  const consultRaw = env.MULTIPOLY_MAX_TOKENS_CONSULT ?? env.GLM_MAX_TOKENS_CONSULT;
  return {
    values: Object.freeze({
      review: parseInteger(reviewRaw, MODEL_OUTPUT_CEILING),
      consult: parseInteger(consultRaw, MODEL_OUTPUT_CEILING),
    }),
    explicit: Object.freeze({
      review: reviewRaw !== undefined && reviewRaw !== "",
      consult: consultRaw !== undefined && consultRaw !== "",
    }),
  };
}

export function resolveMaxTokensForModel(config, modelKey, mode) {
  const modelConfig = config.models?.[modelKey];
  if (modelConfig) return modelConfig.maxTokens?.[mode];
  return config.maxTokens?.[mode];
}

function parseProgress(raw) {
  if (raw === undefined || raw === "") return "heartbeat";
  const v = String(raw).toLowerCase();
  if (v === "off" || v === "none" || v === "0" || v === "false") return "off";
  if (v === "heartbeat" || v === "on" || v === "1" || v === "true") return "heartbeat";
  if (v === "reasoning" || v === "full") return "reasoning";
  throw new MultipolyError(
    "CONFIG",
    `MULTIPOLY_PROGRESS must be one of off|heartbeat|reasoning, got ${JSON.stringify(raw)}`,
  );
}

/** Redact sensitive fields for logging. */
export function redactedConfig(config) {
  const models = Object.fromEntries(
    Object.entries(config.models).map(([key, m]) => [
      key,
      {
        ...m,
        apiKey: m.apiKey ? `***${m.apiKey.slice(-4)}` : null,
      },
    ]),
  );
  return { ...config, models };
}

export { ENDPOINT_PROFILES };
