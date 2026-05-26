import { GlmError } from "./errors.mjs";

export const MODEL_KEYS = Object.freeze(["glm", "qwen", "deepseek", "composer"]);

export const MODEL_INFO = Object.freeze({
  glm: Object.freeze({
    key: "glm",
    displayName: "GLM 5.1",
    defaultModel: "glm-5.1",
    defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKeyEnv: ["MULTIPOLY_GLM_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY"],
  }),
  qwen: Object.freeze({
    key: "qwen",
    displayName: "Qwen 3.7 Max",
    defaultModel: "qwen3.7max",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_QWEN_API_KEY", "QWEN_API_KEY"],
  }),
  deepseek: Object.freeze({
    key: "deepseek",
    displayName: "DeepSeek V4 Pro",
    defaultModel: "deepseek-v4-pro",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"],
  }),
  composer: Object.freeze({
    key: "composer",
    displayName: "Composer 2.5",
    defaultModel: "composer2.5",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_COMPOSER_API_KEY", "COMPOSER_API_KEY"],
  }),
});

export function assertModelKey(raw) {
  if (MODEL_KEYS.includes(raw)) return raw;
  throw new GlmError(
    "INVALID_INPUT",
    `unknown model ${JSON.stringify(raw)}; expected one of ${MODEL_KEYS.join(", ")}`,
  );
}

export function envPrefixForModel(key) {
  assertModelKey(key);
  return `MULTIPOLY_${key.toUpperCase()}`;
}

export function firstNonEmpty(env, names) {
  for (const name of names) {
    const v = (env[name] || "").trim();
    if (v) return { name, value: v };
  }
  return null;
}
