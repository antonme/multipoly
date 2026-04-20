import { GlmError } from "./errors.mjs";

const ENDPOINT_PROFILES = Object.freeze({
  "zai-coding-plan": "https://api.z.ai/api/coding/paas/v4",
  "bigmodel-cn": "https://open.bigmodel.cn/api/paas/v4",
});

function parseBool(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const v = String(raw).toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parseInteger(raw, fallback, { min = 1 } = {}) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new GlmError("CONFIG", `expected integer >= ${min}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseThinking(raw) {
  if (raw === undefined || raw === "") return "mode-default";
  const v = String(raw).toLowerCase();
  if (["on", "1", "true", "yes"].includes(v)) return "on";
  if (["off", "0", "false", "no"].includes(v)) return "off";
  if (v === "auto") return "auto";
  throw new GlmError("CONFIG", `GLM_THINKING must be one of on|off|auto, got ${JSON.stringify(raw)}`);
}

export function loadConfig(env = process.env) {
  const endpoint = env.GLM_ENDPOINT || "zai-coding-plan";
  let baseUrl;
  if (endpoint === "custom") {
    if (!env.GLM_BASE_URL) {
      throw new GlmError("CONFIG", "GLM_ENDPOINT=custom requires GLM_BASE_URL");
    }
    baseUrl = env.GLM_BASE_URL.replace(/\/+$/, "");
  } else if (ENDPOINT_PROFILES[endpoint]) {
    baseUrl = ENDPOINT_PROFILES[endpoint];
  } else {
    const valid = [...Object.keys(ENDPOINT_PROFILES), "custom"].join(", ");
    throw new GlmError(
      "CONFIG",
      `GLM_ENDPOINT must be one of ${valid}, got ${JSON.stringify(endpoint)}`,
    );
  }

  const apiKey = env.GLM_API_KEY || env.ZHIPU_API_KEY;
  if (!apiKey) {
    throw new GlmError(
      "AUTH",
      "No API key found. Set GLM_API_KEY (or ZHIPU_API_KEY for opencode compatibility).",
    );
  }

  const model = env.GLM_MODEL || "glm-5.1";
  const thinking = parseThinking(env.GLM_THINKING);

  const maxTokens = {
    review: parseInteger(env.GLM_MAX_TOKENS_REVIEW, 8192),
    consult: parseInteger(env.GLM_MAX_TOKENS_CONSULT, 16384),
    freeform: parseInteger(env.GLM_MAX_TOKENS_FREEFORM, 16384),
  };

  const caps = {
    perFile: parseInteger(env.GLM_PER_FILE_CAP_BYTES, 256 * 1024),
    total: parseInteger(env.GLM_TOTAL_CAP_BYTES, 1536 * 1024),
    fileCount: parseInteger(env.GLM_FILE_COUNT_CAP, 50),
  };

  const timeoutMs = parseInteger(env.GLM_TIMEOUT_MS, 300_000);
  const allowSecrets = parseBool(env.GLM_ALLOW_SECRETS, false);
  const debugReasoning = parseBool(env.GLM_DEBUG_REASONING, false);

  return Object.freeze({
    endpoint,
    baseUrl,
    apiKey,
    model,
    thinking,
    maxTokens: Object.freeze(maxTokens),
    caps: Object.freeze(caps),
    timeoutMs,
    allowSecrets,
    debugReasoning,
  });
}

/** Redact sensitive fields for logging. */
export function redactedConfig(config) {
  const { apiKey, ...rest } = config;
  return { ...rest, apiKey: apiKey ? `***${apiKey.slice(-4)}` : null };
}

export { ENDPOINT_PROFILES };
