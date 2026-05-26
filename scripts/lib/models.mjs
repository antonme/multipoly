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

// The three transports a model can be reached over. `http` is the default
// OpenAI-compatible streaming client; `anthropic` is the native Messages API;
// `cli` shells out to a local read-only agent harness.
export const TRANSPORTS = Object.freeze(["http", "anthropic", "cli"]);

// Local agent CLIs we know how to drive read-only. `binary` is the default
// executable name (overridable per model); `weakSandbox` marks a kind that has
// no real read-only mode and so must be opted into explicitly (D3: agy).
// `defaultModel` is the `-m`/`--model` value when the model field is omitted.
export const CLI_KINDS = Object.freeze({
  claude: Object.freeze({ binary: "claude" }),
  codex: Object.freeze({ binary: "codex" }),
  cursor: Object.freeze({ binary: "cursor-agent", defaultModel: "composer-2.5" }),
  gemini: Object.freeze({ binary: "gemini" }),
  agy: Object.freeze({ binary: "agy", weakSandbox: true }),
  kimi: Object.freeze({ binary: "kimi" }),
});

// The native Anthropic API endpoint and pinned version header.
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

export const MODEL_INFO = Object.freeze({
  glm: Object.freeze({
    key: "glm",
    displayName: "GLM 5.1",
    transport: "http",
    defaultModel: "glm-5.1",
    defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKeyEnv: ["MULTIPOLY_GLM_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY"],
    supportsThinking: true,
  }),
  qwen: Object.freeze({
    key: "qwen",
    displayName: "Qwen 3.7 Max",
    transport: "http",
    defaultModel: "qwen3.7max",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_QWEN_API_KEY", "QWEN_API_KEY"],
    supportsThinking: false,
  }),
  deepseek: Object.freeze({
    key: "deepseek",
    displayName: "DeepSeek V4 Pro",
    transport: "http",
    defaultModel: "deepseek-v4-pro",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"],
    supportsThinking: false,
  }),
  // Composer 2.5 has no HTTP API — it is only reachable through cursor-agent.
  // It is shipped as a cli/cursor builtin but stays unconfigured until the
  // operator opts in with MULTIPOLY_COMPOSER_ENABLED (see CHANGELOG migration).
  composer: Object.freeze({
    key: "composer",
    displayName: "Composer 2.5",
    transport: "cli",
    cliKind: "cursor",
    defaultModel: null,
    apiKeyEnv: [],
    supportsThinking: false,
  }),
});

// Native-Anthropic builtin, registered only when an Anthropic key is present
// (see loadModelRegistry). Kept out of MODEL_KEYS so default deployments keep
// the four-builtin registry unchanged.
export const OPUS_INFO = Object.freeze({
  key: "opus",
  displayName: "Claude Opus 4.7",
  transport: "anthropic",
  defaultModel: "claude-opus-4-7",
  defaultBaseUrl: ANTHROPIC_DEFAULT_BASE_URL,
  apiKeyEnv: ["MULTIPOLY_OPUS_API_KEY", "ANTHROPIC_API_KEY"],
  supportsThinking: true,
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

  // The native-Anthropic `opus` builtin is registered only when an Anthropic
  // key is present, so deployments without one keep the four-builtin registry
  // (and its advertised tools) exactly as before.
  if (firstNonEmpty(env, OPUS_INFO.apiKeyEnv)) {
    info.opus = OPUS_INFO;
    keys.push("opus");
  }

  const raw = (env.MULTIPOLY_MODELS || "").trim();
  if (!raw) return { keys: Object.freeze(keys), info: Object.freeze(info) };

  const seen = new Set(keys);
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
    const transport = parseTransport(env[`${prefix}_TRANSPORT`], prefix);
    const base = {
      key,
      transport,
      displayName: (env[`${prefix}_DISPLAY_NAME`] || "").trim() || key,
      // Custom models have no built-in defaults; loadOneModelConfig reads the
      // model-specific MULTIPOLY_<K>_{MODEL,BASE_URL} envs directly.
      defaultModel: null,
      defaultBaseUrl: transport === "anthropic" ? ANTHROPIC_DEFAULT_BASE_URL : null,
      apiKeyEnv: Object.freeze([`${prefix}_API_KEY`]),
      supportsThinking: parseThinkingFlag(env[`${prefix}_THINKING`]),
    };
    if (transport === "cli") {
      base.cliKind = parseCliKind(env[`${prefix}_CLI_KIND`], prefix);
    }
    info[key] = Object.freeze(base);
  }
  return { keys: Object.freeze(keys), info: Object.freeze(info) };
}

function parseTransport(raw, prefix) {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return "http";
  if (!TRANSPORTS.includes(v)) {
    throw new MultipolyError(
      "CONFIG",
      `${prefix}_TRANSPORT must be one of ${TRANSPORTS.join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return v;
}

function parseCliKind(raw, prefix) {
  const v = (raw || "").trim().toLowerCase();
  if (!v) {
    throw new MultipolyError(
      "CONFIG",
      `${prefix}_CLI_KIND is required for a cli transport; one of ${Object.keys(CLI_KINDS).join(", ")}`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(CLI_KINDS, v)) {
    throw new MultipolyError(
      "CONFIG",
      `${prefix}_CLI_KIND must be one of ${Object.keys(CLI_KINDS).join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return v;
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
