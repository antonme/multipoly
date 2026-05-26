import { readFileSync } from "node:fs";
import { MultipolyError } from "./errors.mjs";
import { scanMany, formatHitsForError } from "./secrets.mjs";

// An environment variable NAME (not value): used to validate apiKeyEnv /
// authTokenEnv, which name the env var whose value a transport reads — the
// secret itself never lives in config or the registry file.
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateEnvVarName(raw, label) {
  const v = String(raw).trim();
  if (!ENV_NAME_RE.test(v)) {
    throw new MultipolyError(
      "CONFIG",
      `${label} must be a valid environment variable NAME (letters/digits/underscore, no leading digit), got ${JSON.stringify(raw)}`,
    );
  }
  return v;
}

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
  // agy has no --model flag and only a weak sandbox.
  agy: Object.freeze({ binary: "agy", weakSandbox: true, noModelFlag: true }),
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

  const seen = new Set(keys);
  const raw = (env.MULTIPOLY_MODELS || "").trim();
  for (const entry of raw ? raw.split(",") : []) {
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
    const transport = parseTransport(env[`${prefix}_TRANSPORT`], `${prefix}_TRANSPORT`);
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
      base.cliKind = parseCliKind(env[`${prefix}_CLI_KIND`], `${prefix}_CLI_KIND`);
    }
    info[key] = Object.freeze(base);
  }

  loadModelsFileInto(env, { keys, info, seen });
  return { keys: Object.freeze(keys), info: Object.freeze(info) };
}

function parseTransport(raw, label) {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return "http";
  if (!TRANSPORTS.includes(v)) {
    throw new MultipolyError(
      "CONFIG",
      `${label} must be one of ${TRANSPORTS.join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return v;
}

function parseCliKind(raw, label) {
  const v = (raw || "").trim().toLowerCase();
  if (!v) {
    throw new MultipolyError(
      "CONFIG",
      `${label} is required for a cli transport; one of ${Object.keys(CLI_KINDS).join(", ")}`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(CLI_KINDS, v)) {
    throw new MultipolyError(
      "CONFIG",
      `${label} must be one of ${Object.keys(CLI_KINDS).join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return v;
}

// Fields a registry-file model entry may declare. Deliberately excludes any
// secret-bearing field: credentials live in env, named via apiKeyEnv /
// authTokenEnv. There is also no argv/args field — argv is built by the cli
// transport from the controlled cliKind recipe, never supplied by config.
const FILE_ENTRY_FIELDS = new Set([
  "transport",
  "displayName",
  "model",
  "baseUrl",
  "apiKeyEnv",
  "supportsThinking",
  "cliKind",
  "binary",
  "authTokenEnv",
  "cwd",
  "unsafe",
  "reasoningEffort",
  "enabled",
]);

/**
 * Merge models from an explicit JSON registry file into the in-progress
 * registry. Loaded ONLY from `MULTIPOLY_MODELS_FILE` (an explicit path) —
 * never auto-discovered from cwd, because the MCP server commonly runs inside
 * the repo under review and a repo-local file naming CLI binaries would be a
 * code-execution footgun. Mutates `keys`/`info`/`seen` in place.
 */
function loadModelsFileInto(env, { keys, info, seen }) {
  const path = (env.MULTIPOLY_MODELS_FILE || "").trim();
  if (!path) return;

  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new MultipolyError("CONFIG", `MULTIPOLY_MODELS_FILE could not be read (${path}): ${e.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new MultipolyError("CONFIG", `MULTIPOLY_MODELS_FILE is not valid JSON (${path}): ${e.message}`);
  }
  if (!doc || typeof doc !== "object" || typeof doc.models !== "object" || doc.models === null) {
    throw new MultipolyError("CONFIG", `MULTIPOLY_MODELS_FILE must be a JSON object with a "models" object`);
  }

  for (const [rawKey, entry] of Object.entries(doc.models)) {
    const key = String(rawKey).trim().toLowerCase();
    const where = `MULTIPOLY_MODELS_FILE model ${JSON.stringify(rawKey)}`;
    if (!MODEL_KEY_RE.test(key)) {
      throw new MultipolyError("CONFIG", `${where} is not a valid model key (lowercase letters/digits, leading letter).`);
    }
    if (RESERVED_MODEL_KEYS.has(key)) {
      throw new MultipolyError("CONFIG", `${where} is a reserved word.`);
    }
    if (seen.has(key)) {
      throw new MultipolyError("CONFIG", `${where} duplicates a builtin or earlier model.`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MultipolyError("CONFIG", `${where} must be an object.`);
    }
    for (const field of Object.keys(entry)) {
      if (!FILE_ENTRY_FIELDS.has(field)) {
        throw new MultipolyError(
          "CONFIG",
          `${where} has unknown field ${JSON.stringify(field)} (secrets and argv are not allowed in the registry file; use apiKeyEnv/authTokenEnv to name env vars).`,
        );
      }
    }
    // No string value may contain a secret — the file is for shapes, not keys.
    const scanPieces = Object.entries(entry)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => ({ text: v, label: `${where}.${k}` }));
    const scanned = scanMany(scanPieces);
    if (!scanned.clean) {
      throw new MultipolyError(
        "CONFIG",
        `${where} contains a value that looks like a secret:\n${formatHitsForError(scanned.hits)}\nKeep credentials in env vars and reference them via apiKeyEnv/authTokenEnv.`,
      );
    }

    seen.add(key);
    keys.push(key);
    info[key] = Object.freeze(fileEntryToInfo(key, entry, where));
  }
}

function fileEntryToInfo(key, entry, where) {
  const transport = parseTransport(entry.transport, `${where} transport`);
  const base = {
    key,
    transport,
    displayName: (typeof entry.displayName === "string" && entry.displayName.trim()) || key,
    defaultModel: typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : null,
    defaultBaseUrl:
      typeof entry.baseUrl === "string" && entry.baseUrl.trim()
        ? entry.baseUrl.trim()
        : transport === "anthropic"
          ? ANTHROPIC_DEFAULT_BASE_URL
          : null,
    apiKeyEnv: entry.apiKeyEnv
      ? Object.freeze([validateEnvVarName(entry.apiKeyEnv, `${where} apiKeyEnv`)])
      : Object.freeze([]),
    supportsThinking: Boolean(entry.supportsThinking),
  };
  if (transport === "cli") {
    base.cliKind = parseCliKind(entry.cliKind, `${where} cliKind`);
    if (typeof entry.binary === "string" && entry.binary.trim()) base.binary = entry.binary.trim();
    if (entry.authTokenEnv) base.authTokenEnv = validateEnvVarName(entry.authTokenEnv, `${where} authTokenEnv`);
    if (entry.cwd !== undefined) {
      const c = String(entry.cwd).trim().toLowerCase();
      if (c !== "repo" && c !== "temp") {
        throw new MultipolyError("CONFIG", `${where} cwd must be 'repo' or 'temp', got ${JSON.stringify(entry.cwd)}`);
      }
      base.cwdMode = c;
    }
    if (typeof entry.unsafe === "boolean") base.unsafe = entry.unsafe;
    if (typeof entry.reasoningEffort === "string" && entry.reasoningEffort.trim()) {
      base.reasoningEffort = entry.reasoningEffort.trim();
    }
    if (typeof entry.enabled === "boolean") base.enabled = entry.enabled;
  }
  return base;
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

/**
 * Resolve the effective thinking preference for one call, shared by the http
 * and anthropic transports so they can't drift.
 *
 *   - explicit per-call `thinking` (boolean) wins,
 *   - else config.thinking: "auto" → null (omit the field entirely),
 *     "on" → true, "off" → false,
 *   - else "mode-default": on for review, off for consult.
 *
 * Returns true | false | null. The caller maps that onto its transport's wire
 * shape (GLM `{type:"enabled"|"disabled"}`; Anthropic `{type:"enabled",
 * budget_tokens}` or omitted) and gates it on whether the model supports it.
 */
export function resolveThinkingPreference({ thinking, configThinking, mode }) {
  if (thinking !== undefined) return thinking;
  if (configThinking === "auto") return null;
  if (configThinking === "on") return true;
  if (configThinking === "off") return false;
  return mode === "review";
}

export function firstNonEmpty(env, names) {
  for (const name of names) {
    const v = (env[name] || "").trim();
    if (v) return { name, value: v };
  }
  return null;
}
