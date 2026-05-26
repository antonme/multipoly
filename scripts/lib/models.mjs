import { MultipolyError } from "./errors.mjs";

// Reserved model keys:
//  - synthesizer sentinels (harness/none/caller),
//  - "council" — a model key becomes the tool-name prefix <key>_review /
//    <key>_consult, which for "council" would collide with the built-in
//    council_review / council_consult tools (duplicate tool names + handler
//    overwrite),
//  - Object.prototype member names — harmless with own-property lookups, but
//    rejected as belt-and-suspenders against prototype shadowing.
const RESERVED_MODEL_KEYS = new Set([
  "harness",
  "none",
  "caller",
  "council",
  "constructor",
  "prototype",
  "__proto__",
]);

export const MODEL_KEYS = Object.freeze(["glm", "qwen", "deepseek", "composer"]);

export const MODEL_INFO = Object.freeze({
  glm: Object.freeze({
    key: "glm",
    displayName: "GLM 5.1",
    defaultModel: "glm-5.1",
    defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKeyEnv: ["MULTIPOLY_GLM_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY"],
    supportsThinking: true,
  }),
  qwen: Object.freeze({
    key: "qwen",
    displayName: "Qwen 3.7 Max",
    defaultModel: "qwen3.7max",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_QWEN_API_KEY", "QWEN_API_KEY"],
    supportsThinking: false,
  }),
  deepseek: Object.freeze({
    key: "deepseek",
    displayName: "DeepSeek V4 Pro",
    defaultModel: "deepseek-v4-pro",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"],
    supportsThinking: false,
  }),
  composer: Object.freeze({
    key: "composer",
    displayName: "Composer 2.5",
    defaultModel: "composer2.5",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_COMPOSER_API_KEY", "COMPOSER_API_KEY"],
    supportsThinking: false,
  }),
});

export function assertModelKey(raw) {
  if (MODEL_KEYS.includes(raw)) return raw;
  throw new MultipolyError(
    "INVALID_INPUT",
    `unknown model ${JSON.stringify(raw)}; expected one of ${MODEL_KEYS.join(", ")}`,
  );
}

// A model key must be a clean lowercase identifier so it maps to an env prefix
// (MULTIPOLY_<KEY>_*) and a tool name (<key>_review) without ambiguity.
const MODEL_KEY_RE = /^[a-z][a-z0-9]*$/;

export function envPrefixForModel(key) {
  return `MULTIPOLY_${key.toUpperCase()}`;
}

/**
 * Build the model registry for an environment: the four builtins plus any
 * custom models declared via MULTIPOLY_MODELS (comma-separated keys). Each
 * custom key <K> draws its identity from MULTIPOLY_<K>_{MODEL,BASE_URL,
 * DISPLAY_NAME,THINKING} and its API key from MULTIPOLY_<K>_API_KEY; whether it
 * is actually *configured* is decided later by loadOneModelConfig (a custom
 * model missing its base URL/model/key is simply unconfigured, not fatal).
 *
 * @returns {{ keys: string[], info: Record<string, object> }}
 */
export function loadModelRegistry(env = process.env) {
  const info = { ...MODEL_INFO };
  const keys = [...MODEL_KEYS];

  const raw = (env.MULTIPOLY_MODELS || "").trim();
  if (!raw) return { keys: Object.freeze(keys), info: Object.freeze(info) };

  const seen = new Set(MODEL_KEYS);
  for (const entry of raw.split(",")) {
    const key = entry.trim().toLowerCase();
    if (!key) continue;
    if (!MODEL_KEY_RE.test(key)) {
      throw new MultipolyError(
        "CONFIG",
        `MULTIPOLY_MODELS entry ${JSON.stringify(entry)} is not a valid model key (lowercase letters/digits, leading letter).`,
      );
    }
    if (RESERVED_MODEL_KEYS.has(key)) {
      throw new MultipolyError("CONFIG", `MULTIPOLY_MODELS entry ${JSON.stringify(key)} is a reserved word.`);
    }
    if (seen.has(key)) {
      throw new MultipolyError(
        "CONFIG",
        `MULTIPOLY_MODELS entry ${JSON.stringify(key)} duplicates a builtin or earlier model.`,
      );
    }
    seen.add(key);
    keys.push(key);
    const prefix = envPrefixForModel(key);
    info[key] = Object.freeze({
      key,
      displayName: (env[`${prefix}_DISPLAY_NAME`] || "").trim() || key,
      // Custom models have no built-in defaults; loadOneModelConfig reads the
      // model-specific MULTIPOLY_<K>_{MODEL,BASE_URL} envs directly.
      defaultModel: null,
      defaultBaseUrl: null,
      apiKeyEnv: Object.freeze([`${prefix}_API_KEY`]),
      supportsThinking: parseThinkingFlag(env[`${prefix}_THINKING`]),
    });
  }
  return { keys: Object.freeze(keys), info: Object.freeze(info) };
}

function parseThinkingFlag(raw) {
  if (raw === undefined || raw === "") return false;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

/**
 * Whether a model supports the `thinking` request field. Prefers the value on
 * the loaded model config (set by loadConfig), falling back to the static
 * MODEL_INFO declaration for callers/tests that pass bare config objects.
 * Centralizes what used to be a `?? key === "glm"` fallback duplicated across
 * the client, review, consult, and council modules.
 */
export function modelSupportsThinking(config, key) {
  const fromConfig = config?.models?.[key]?.supportsThinking;
  if (fromConfig !== undefined) return fromConfig;
  return Boolean(MODEL_INFO[key]?.supportsThinking);
}

export function firstNonEmpty(env, names) {
  for (const name of names) {
    const v = (env[name] || "").trim();
    if (v) return { name, value: v };
  }
  return null;
}
