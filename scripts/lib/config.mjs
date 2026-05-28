import { MultipolyError } from "./errors.mjs";
import {
  MODEL_KEYS,
  envPrefixForModel,
  firstNonEmpty,
  loadModelRegistry,
  CLI_KINDS,
  ANTHROPIC_VERSION,
  validateEnvVarName,
  modelCapability,
} from "./models.mjs";
import { resolveReasoningEffort, thinkingToEffort, CAPABILITY } from "./reasoning.mjs";
import { resolveModelAlias } from "./aliases.mjs";
import { computeDisplayName } from "./display-name.mjs";

const ENDPOINT_PROFILES = Object.freeze({
  "zai-coding-plan": "https://api.z.ai/api/coding/paas/v4",
  "bigmodel-cn": "https://open.bigmodel.cn/api/paas/v4",
});

// GLM 5.1's published output limit is 131072 tokens (models.dev / opencode);
// reasoning tokens share that budget with content. Non-GLM providers do not
// inherit this default: unless the user sets a server-wide or model-specific
// cap, we omit max_tokens and let that provider's default apply.
const MODEL_OUTPUT_CEILING = 131072;

// For reasoning-capable models, reasoning tokens share the max_tokens budget
// with content. On large reviews, reasoning alone can exhaust a small cap →
// empty BUDGET failures (observed in the field for glm and kimi). Apply a
// minimum floor to all reasoning capabilities (any cap != NONE), clamped to
// MODEL_OUTPUT_CEILING. An explicit operator value always wins over the floor.
const REASONING_REVIEW_FLOOR = Math.min(32768, MODEL_OUTPUT_CEILING);
const REASONING_CONSULT_FLOOR = Math.min(8192, MODEL_OUTPUT_CEILING);

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

// Compute the per-model review/consult max_tokens caps. GLM inherits the
// output ceiling by default; other models default to undefined unless the
// server-wide cap was set explicitly. Shared across all transports.
// For any reasoning-capable model (cap !== CAPABILITY.NONE), apply a minimum
// floor of REASONING_REVIEW_FLOOR (review) / REASONING_CONSULT_FLOOR (consult)
// when neither the per-model env nor the server-wide env was set explicitly.
// An explicit value (either source) always wins over the floor so the
// operator's intent is respected.
function resolveModelMaxTokens(env, key, prefix, serverMaxTokens, info) {
  const cap = info?.reasoning;
  const isReasoning = cap !== undefined && cap !== CAPABILITY.NONE;
  // "explicit" = the operator set this value via env; floor must not override it.
  const reviewPerModelExplicit = env[`${prefix}_MAX_TOKENS_REVIEW`] !== undefined && env[`${prefix}_MAX_TOKENS_REVIEW`] !== "";
  const consultPerModelExplicit = env[`${prefix}_MAX_TOKENS_CONSULT`] !== undefined && env[`${prefix}_MAX_TOKENS_CONSULT`] !== "";
  const reviewAnyExplicit = reviewPerModelExplicit || serverMaxTokens.explicit.review;
  const consultAnyExplicit = consultPerModelExplicit || serverMaxTokens.explicit.consult;

  const review = parseInteger(
    env[`${prefix}_MAX_TOKENS_REVIEW`],
    key === "glm" || serverMaxTokens.explicit.review ? serverMaxTokens.values.review : undefined,
  );
  const consult = parseInteger(
    env[`${prefix}_MAX_TOKENS_CONSULT`],
    key === "glm" || serverMaxTokens.explicit.consult ? serverMaxTokens.values.consult : undefined,
  );

  if (isReasoning) {
    // Apply floor only when no explicit value was supplied (neither per-model nor server-wide).
    return Object.freeze({
      review: reviewAnyExplicit ? review : Math.max(review ?? 0, REASONING_REVIEW_FLOOR),
      consult: consultAnyExplicit ? consult : Math.max(consult ?? 0, REASONING_CONSULT_FLOOR),
    });
  }

  return Object.freeze({ review, consult });
}

/**
 * Resolve the baseline reasoning effort for one model at config load time.
 * Precedence (highest → lowest):
 *   MULTIPOLY_<K>_REASONING_EFFORT (per-model effort env)
 *   MULTIPOLY_<K>_THINKING (per-model thinking env, mapped via thinkingToEffort)
 *   GLM_THINKING (legacy, consumed ONLY for glm — never leaks to other models)
 *   MULTIPOLY_REASONING_EFFORT (server-wide effort env)
 *   MULTIPOLY_THINKING (server-wide thinking env, mapped via thinkingToEffort)
 *   info.defaultEffort (baked default from MODEL_INFO or registry)
 * Returns a concrete effort level (one of EFFORT_LEVELS).
 */
function resolveModelReasoningEffort(env, key, prefix, info) {
  const glmLegacyThinking = key === "glm" ? env.GLM_THINKING : undefined;
  return resolveReasoningEffort({
    perCall: undefined,
    modelEffort: env[`${prefix}_REASONING_EFFORT`],
    modelThinking: thinkingToEffort(env[`${prefix}_THINKING`] ?? glmLegacyThinking),
    serverEffort: env.MULTIPOLY_REASONING_EFFORT,
    serverThinking: thinkingToEffort(env.MULTIPOLY_THINKING),
    bakedDefault: info?.defaultEffort ?? "off",
  });
}

function parseCwdMode(raw, label) {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return "repo";
  if (v !== "repo" && v !== "temp") {
    throw new MultipolyError("CONFIG", `${label} must be 'repo' or 'temp', got ${JSON.stringify(raw)}`);
  }
  return v;
}

/**
 * Resolve the display name for a model info entry.
 * When the entry has a `baseName` (all builtins), apply the convention
 * "<baseName> (<transport-suffix>)" via computeDisplayName.
 * Otherwise fall back to `info.displayName`, then `key`.
 * This ensures ALL builtins — both always-on (glm/qwen/deepseek/composer) and
 * promotable (claude/codex/gemini/kimi/mimo) — surface convention-form names
 * from the config-loader path without touching MODEL_INFO literals.
 */
function resolveDisplayName(info, transport) {
  if (info.baseName) return computeDisplayName(info.baseName, transport, info.cliKind);
  return info.displayName ?? info.key;
}

// Dispatch per-model config loading by the registry-declared transport. Each
// branch returns a frozen config with a `transport` discriminant the runModel
// dispatcher reads. http = OpenAI-compatible; anthropic = native Messages;
// cli = local read-only agent subprocess.
function loadOneModelConfig(env, key, info, serverMaxTokens) {
  const transport = info.transport ?? "http";
  if (transport === "anthropic") return loadAnthropicModelConfig(env, key, info, serverMaxTokens);
  if (transport === "cli") return loadCliModelConfig(env, key, info, serverMaxTokens);
  return loadHttpModelConfig(env, key, info, serverMaxTokens);
}

function loadHttpModelConfig(env, key, info, serverMaxTokens) {
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
  const maxTokens = resolveModelMaxTokens(env, key, prefix, serverMaxTokens, info);
  const reasoningEffort = resolveModelReasoningEffort(env, key, prefix, info);
  const missing = [];

  if (!baseUrlRaw) missing.push(`${prefix}_BASE_URL`);
  if (!model) missing.push(`${prefix}_MODEL`);
  if (!keyHit) missing.push(info.apiKeyEnv.join(" or "));

  const reasoningFields = {
    reasoning: info.reasoning,
    ...(info.reasoningVocab !== undefined ? { reasoningVocab: info.reasoningVocab } : {}),
    reasoningEffort,
  };

  const displayName = resolveDisplayName(info, "http");

  if (missing.length > 0) {
    return Object.freeze({
      key,
      displayName,
      transport: "http",
      configured: false,
      missing: Object.freeze(missing),
      model,
      baseUrl: baseUrlRaw || null,
      apiKey: null,
      supportsThinking: Boolean(info.supportsThinking),
      usesMaxCompletionTokens: Boolean(info.usesMaxCompletionTokens),
      maxTokens,
      ...reasoningFields,
    });
  }

  return Object.freeze({
    key,
    displayName,
    transport: "http",
    configured: true,
    missing: Object.freeze([]),
    model,
    baseUrl: validateCustomBaseUrl(baseUrlRaw, baseUrlLabel),
    apiKey: keyHit.value,
    apiKeyEnv: keyHit.name,
    supportsThinking: Boolean(info.supportsThinking),
    usesMaxCompletionTokens: Boolean(info.usesMaxCompletionTokens),
    maxTokens,
    ...reasoningFields,
  });
}

function loadAnthropicModelConfig(env, key, info, serverMaxTokens) {
  const prefix = envPrefixForModel(key);
  const explicitModelBaseUrl = (env[`${prefix}_BASE_URL`] || "").trim();
  const globalAnthropicBaseUrl = (env.ANTHROPIC_BASE_URL || "").trim();
  const baseUrlRaw = explicitModelBaseUrl || globalAnthropicBaseUrl || info.defaultBaseUrl;
  const baseUrlLabel = explicitModelBaseUrl
    ? `${prefix}_BASE_URL`
    : globalAnthropicBaseUrl
      ? "ANTHROPIC_BASE_URL"
      : `${prefix}_BASE_URL`;
  const model = env[`${prefix}_MODEL`] || info.defaultModel;
  const keyHit = firstNonEmpty(env, info.apiKeyEnv);
  const maxTokens = resolveModelMaxTokens(env, key, prefix, serverMaxTokens, info);
  const reasoningEffort = resolveModelReasoningEffort(env, key, prefix, info);

  const missing = [];
  if (!baseUrlRaw) missing.push(`${prefix}_BASE_URL`);
  if (!model) missing.push(`${prefix}_MODEL`);
  if (!keyHit) missing.push(info.apiKeyEnv.join(" or "));

  const reasoningFields = {
    reasoning: info.reasoning,
    ...(info.reasoningVocab !== undefined ? { reasoningVocab: info.reasoningVocab } : {}),
    reasoningEffort,
  };

  const common = {
    key,
    displayName: resolveDisplayName(info, "anthropic"),
    transport: "anthropic",
    model,
    anthropicVersion: ANTHROPIC_VERSION,
    supportsThinking: Boolean(info.supportsThinking),
    maxTokens,
    ...reasoningFields,
  };
  if (missing.length > 0) {
    return Object.freeze({
      ...common,
      configured: false,
      missing: Object.freeze(missing),
      // Match the http transport: malformed optional fields on an otherwise
      // unconfigured model should not block startup for the configured models.
      // The URL is validated before any Anthropic call once credentials are present.
      baseUrl: baseUrlRaw || null,
      apiKey: null,
    });
  }
  return Object.freeze({
    ...common,
    configured: true,
    missing: Object.freeze([]),
    baseUrl: validateCustomBaseUrl(baseUrlRaw, baseUrlLabel),
    apiKey: keyHit.value,
    apiKeyEnv: keyHit.name,
  });
}

function loadCliModelConfig(env, key, info, serverMaxTokens) {
  const prefix = envPrefixForModel(key);
  const cliKind = info.cliKind;
  const kindDef = CLI_KINDS[cliKind];
  if (!kindDef) {
    // Registry validation should have caught this; defensive.
    throw new MultipolyError("CONFIG", `${prefix}: unknown cli kind ${JSON.stringify(cliKind)}`);
  }
  // Env vars take precedence over file-declared (info.*) values, which in turn
  // fall back to the cli-kind defaults. This lets a registry-file model be
  // tuned per-deployment via env without editing the file.
  const binary = (env[`${prefix}_CLI`] || "").trim() || info.binary || kindDef.binary;
  const model =
    (env[`${prefix}_MODEL`] || "").trim() || info.defaultModel || kindDef.defaultModel || null;
  const authTokenEnvRaw = (env[`${prefix}_AUTH_TOKEN_ENV`] || "").trim() || info.authTokenEnv || "";
  const authTokenEnv = authTokenEnvRaw
    ? validateEnvVarName(authTokenEnvRaw, `${prefix}_AUTH_TOKEN_ENV`)
    : null;
  const cwdRaw =
    env[`${prefix}_CWD`] !== undefined && env[`${prefix}_CWD`] !== ""
      ? env[`${prefix}_CWD`]
      : info.cwdMode;
  const cwdMode = parseCwdMode(cwdRaw, `${prefix}_CWD`);
  const unsafe =
    env[`${prefix}_UNSAFE`] !== undefined && env[`${prefix}_UNSAFE`] !== ""
      ? parseBool(env[`${prefix}_UNSAFE`], false)
      : Boolean(info.unsafe);
  const reasoningEffort = resolveModelReasoningEffort(env, key, prefix, info);
  const enabled =
    env[`${prefix}_ENABLED`] !== undefined && env[`${prefix}_ENABLED`] !== ""
      ? parseBool(env[`${prefix}_ENABLED`], false)
      : Boolean(info.enabled);
  const timeoutMs = parseInteger(env[`${prefix}_TIMEOUT_MS`], undefined, TIMEOUT_BOUNDS);
  const maxTokens = resolveModelMaxTokens(env, key, prefix, serverMaxTokens, info);

  // A cli model is opt-in (it shells out to a local agent), so it stays
  // unconfigured until ENABLED. A weak-sandbox kind (agy) additionally
  // requires UNSAFE, since it has no real read-only mode (D3).
  const missing = [];
  if (!enabled) missing.push(`${prefix}_ENABLED=1`);
  if (kindDef.weakSandbox && !unsafe) missing.push(`${prefix}_UNSAFE=1 (weak sandbox)`);
  // Kinds that emit a --model/-m flag need a model id; agy has no model flag.
  if (!kindDef.noModelFlag && !model) missing.push(`${prefix}_MODEL`);

  const reasoningFields = {
    reasoning: info.reasoning,
    ...(info.reasoningVocab !== undefined ? { reasoningVocab: info.reasoningVocab } : {}),
    reasoningEffort,
  };

  return Object.freeze({
    key,
    displayName: resolveDisplayName(info, "cli"),
    transport: "cli",
    cliKind,
    binary,
    model,
    authTokenEnv,
    cwdMode,
    unsafe,
    timeoutMs,
    configured: missing.length === 0,
    missing: Object.freeze(missing),
    supportsThinking: Boolean(info.supportsThinking),
    maxTokens,
    ...reasoningFields,
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
 *   - harness|none|caller → "harness" (defer to the calling harness); checked FIRST
 *   - a known model key or alias thereof → that key (via resolveModelAlias)
 *   - anything else       → null (caller decides which error code to raise)
 */
export function normalizeSynthesizerChoice(raw, modelKeys = MODEL_KEYS) {
  const v = String(raw).toLowerCase();
  if (HARNESS_ALIASES.has(v)) return HARNESS_SENTINEL; // sentinels first — never alias-resolved
  return resolveModelAlias(raw, modelKeys);
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
  if (raw === undefined || raw === "") return "auto";
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
