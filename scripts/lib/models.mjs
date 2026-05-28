import { readFileSync } from "node:fs";
import { MultipolyError } from "./errors.mjs";
import { scanMany, formatHitsForError } from "./secrets.mjs";
import { CAPABILITY, EFFORT_LEVELS } from "./reasoning.mjs";
import { computeDisplayName } from "./display-name.mjs";

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

// Promotable builtins: present in MODEL_INFO but NOT in MODEL_KEYS (opt-in via
// MULTIPOLY_MODELS). When listed, the registry loader merges the baked MODEL_INFO
// base under env overrides instead of building from scratch.
const PROMOTABLE_BUILTINS = new Set(["claude", "codex", "gemini", "kimi", "mimo", "grok"]);

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
  // xAI "Grok Build" coding CLI: claude-code-like agent with a graded --effort
  // flag and a read-only `--permission-mode plan`.
  grok: Object.freeze({ binary: "grok", defaultModel: "grok-build" }),
});

// The native Anthropic API endpoint and pinned version header.
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

export const MODEL_INFO = Object.freeze({
  glm: Object.freeze({
    key: "glm",
    baseName: "glm-5.1",
    displayName: "GLM 5.1",
    transport: "http",
    defaultModel: "glm-5.1",
    defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKeyEnv: ["MULTIPOLY_GLM_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY"],
    supportsThinking: true,
    reasoning: CAPABILITY.GLM_TOGGLE,
    defaultEffort: "high",
  }),
  qwen: Object.freeze({
    key: "qwen",
    baseName: "qwen3.7-max",
    displayName: "Qwen 3.7 Max",
    transport: "http",
    defaultModel: "qwen3.7max",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_QWEN_API_KEY", "QWEN_API_KEY"],
    supportsThinking: false,
    reasoning: CAPABILITY.QWEN_BUDGET,
    defaultEffort: "high",
  }),
  deepseek: Object.freeze({
    key: "deepseek",
    baseName: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    transport: "http",
    defaultModel: "deepseek-v4-pro",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"],
    supportsThinking: false,
    reasoning: CAPABILITY.OPENAI_EFFORT,
    reasoningVocab: "deepseek",
    defaultEffort: "high",
  }),
  // Composer 2.5 has no HTTP API — it is only reachable through cursor-agent.
  // It is shipped as a cli/cursor builtin but stays unconfigured until the
  // operator opts in with MULTIPOLY_COMPOSER_ENABLED (see CHANGELOG migration).
  composer: Object.freeze({
    key: "composer",
    baseName: "composer-2.5",
    displayName: "Composer 2.5",
    transport: "cli",
    cliKind: "cursor",
    defaultModel: null,
    apiKeyEnv: [],
    supportsThinking: false,
    reasoning: CAPABILITY.NONE,
    defaultEffort: "off",
  }),
  // ── Promotable builtins: baked metadata, NOT auto-registered ──────────────
  // These entries carry capability/baseName/defaultEffort so operator deployments
  // that list them in MULTIPOLY_MODELS don't need per-model display env.
  // They are intentionally absent from MODEL_KEYS (opt-in via MULTIPOLY_MODELS).
  claude: Object.freeze({
    key: "claude",
    baseName: "opus",                // display base; full name computed by transport
    transport: "cli",
    cliKind: "claude",
    defaultModel: "claude-opus-4-7",
    defaultBaseUrl: null,            // anthropic transport falls back to ANTHROPIC_DEFAULT_BASE_URL in config
    apiKeyEnv: ["MULTIPOLY_CLAUDE_API_KEY", "ANTHROPIC_API_KEY"],
    supportsThinking: true,
    reasoning: CAPABILITY.ANTHROPIC_EFFORT, // baked as anthropic_effort; Task 5 transport-flip (cli→anthropic) inherits this capability
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
    reasoning: CAPABILITY.OPENAI_EFFORT, // api flavor maps to openai_effort; cli flavor uses -c model_reasoning_effort
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
  mimo: Object.freeze({
    key: "mimo",
    baseName: "mimo-v2.5-pro",
    transport: "http",
    defaultModel: "mimo-v2.5-pro",
    defaultBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    // Recognize the existing XIAOMIMIMO_* env names as aliases, mirroring glm's
    // ZHIPU_API_KEY/GLM_API_KEY fallbacks.
    apiKeyEnv: ["MULTIPOLY_MIMO_API_KEY", "XIAOMIMIMO_API_KEY"],
    supportsThinking: true,           // top-level thinking toggle, same class as glm
    reasoning: CAPABILITY.GLM_TOGGLE, // "http_thinking_toggle"
    defaultEffort: "high",
    usesMaxCompletionTokens: true,    // MiMo expects max_completion_tokens, not max_tokens
  }),
  // xAI Grok Build — local coding-agent CLI (cli-only; no http API exposed here).
  // Auth is the grok CLI's own OAuth (grok login), so no authTokenEnv is required;
  // apiKeyEnv is named for symmetry/future use. `--effort` is graded and xhigh-native
  // (low|medium|high|xhigh|max), so it inherits the ANTHROPIC_EFFORT capability class
  // like claude — the cli transport maps it to argv via effortToCliReasoningArgs.
  grok: Object.freeze({
    key: "grok",
    baseName: "grok-build",
    transport: "cli",
    cliKind: "grok",
    defaultModel: "grok-build",
    defaultBaseUrl: null,
    apiKeyEnv: ["MULTIPOLY_GROK_API_KEY", "XAI_API_KEY"],
    supportsThinking: false,
    reasoning: CAPABILITY.ANTHROPIC_EFFORT, // graded effort, xhigh-native (matches grok --effort)
    defaultEffort: "xhigh",
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
    // Promotable builtins (claude/codex/gemini/kimi/mimo) live in MODEL_INFO but NOT in
    // MODEL_KEYS, so they are not in `seen` yet. Allow them once; error on double-list.
    const baked = PROMOTABLE_BUILTINS.has(key) ? MODEL_INFO[key] : undefined;
    if (seen.has(key) && baked) {
      throw new MultipolyError(
        "CONFIG",
        `MULTIPOLY_MODELS entry ${JSON.stringify(key)} is listed more than once.`,
      );
    }
    if (seen.has(key) && !baked) {
      throw new MultipolyError(
        "CONFIG",
        `MULTIPOLY_MODELS entry ${JSON.stringify(key)} duplicates a builtin or earlier model.`,
      );
    }
    seen.add(key);
    keys.push(key);
    const prefix = envPrefixForModel(key);
    // For promotable builtins, use the transport-flip guard; for custom keys,
    // fall back to "http" as before.
    const transport = baked
      ? resolveBuiltinTransport(key, env, prefix, baked)
      : parseTransport(env[`${prefix}_TRANSPORT`], `${prefix}_TRANSPORT`);

    if (baked) {
      // ── Promotable builtin path: merge baked MODEL_INFO base under env overrides ──
      const thinkingEnv = env[`${prefix}_THINKING`];
      const base = {
        key,
        transport,
        // DISPLAY_NAME env wins; else convention from baseName; else baked displayName; else key
        displayName:
          (env[`${prefix}_DISPLAY_NAME`] || "").trim() ||
          (baked.baseName
            ? computeDisplayName(
                baked.baseName,
                transport,
                // cliKind for the display: baked value or env override
                (env[`${prefix}_CLI_KIND`] || "").trim().toLowerCase() || baked.cliKind,
              )
            : baked.displayName) ||
          key,
        defaultModel: baked.defaultModel ?? null,
        defaultBaseUrl:
          baked.defaultBaseUrl ??
          (transport === "anthropic" ? ANTHROPIC_DEFAULT_BASE_URL : null),
        apiKeyEnv: baked.apiKeyEnv ?? Object.freeze([`${prefix}_API_KEY`]),
        supportsThinking:
          thinkingEnv !== undefined && thinkingEnv !== ""
            ? parseThinkingFlag(thinkingEnv)
            : Boolean(baked.supportsThinking),
        // Carry the OpenAI-compat token-cap field switch from the baked entry so the
        // http loader/client can read it for promotable builtins (e.g. mimo in Plan C).
        ...(baked.usesMaxCompletionTokens ? { usesMaxCompletionTokens: true } : {}),
      };

      // Reasoning: explicit env override wins; else prefer baked capability; else infer
      const explicitReasoning = (env[`${prefix}_REASONING`] || "").trim();
      if (explicitReasoning) {
        const validCaps = Object.values(CAPABILITY);
        if (!validCaps.includes(explicitReasoning)) {
          throw new MultipolyError(
            "CONFIG",
            `${prefix}_REASONING must be one of ${validCaps.join(", ")}, got ${JSON.stringify(explicitReasoning)}`,
          );
        }
        base.reasoning = explicitReasoning;
      // Baked capability wins over transport inference and is carried as-is even across a
      // transport flip — an operator flipping kimi anthropic→http should also set
      // MULTIPOLY_KIMI_REASONING. (All current baked entries declare reasoning explicitly,
      // so the transport-inference arms below are unreached for them but kept defensively.)
      } else if (baked.reasoning) {
        base.reasoning = baked.reasoning;
      } else if (transport === "anthropic") {
        base.reasoning = CAPABILITY.ANTHROPIC_EFFORT;
      } else if (transport === "http") {
        base.reasoning = CAPABILITY.NONE;
      } else {
        base.reasoning = CAPABILITY.NONE;
      }

      // reasoningVocab: env override, else baked
      const vocabEnv = (env[`${prefix}_REASONING_VOCAB`] || "").trim();
      if (vocabEnv && base.reasoning === CAPABILITY.OPENAI_EFFORT) {
        base.reasoningVocab = vocabEnv;
      } else if (baked.reasoningVocab && base.reasoning === CAPABILITY.OPENAI_EFFORT) {
        base.reasoningVocab = baked.reasoningVocab;
      }

      // cliKind: env override, else baked
      if (transport === "cli") {
        const cliKindEnv = (env[`${prefix}_CLI_KIND`] || "").trim();
        base.cliKind = cliKindEnv
          ? parseCliKind(cliKindEnv, `${prefix}_CLI_KIND`)
          : (baked.cliKind ?? parseCliKind(undefined, `${prefix}_CLI_KIND`));
      }

      // defaultEffort: baked wins, else "off"
      base.defaultEffort = baked.defaultEffort ?? "off";

      info[key] = Object.freeze(base);
    } else {
      // ── From-scratch path for genuinely-custom keys ──
      // `transport` already resolved above (falls back to "http" for custom keys).
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
      // Reasoning capability: MULTIPOLY_<K>_REASONING overrides; otherwise infer by transport.
      // http: from MULTIPOLY_<K>_REASONING_VOCAB (deepseek|gemini → OPENAI_EFFORT, glm → GLM_TOGGLE, qwen → QWEN_BUDGET);
      //        else from MULTIPOLY_<K>_REASONING explicit; else NONE.
      // anthropic: ANTHROPIC_EFFORT default (or KIMI_TOGGLE if explicitly declared).
      // cli: NONE (cli reasoning handled by kind in Task 10).
      const explicitReasoning = (env[`${prefix}_REASONING`] || "").trim();
      if (explicitReasoning) {
        const validCaps = Object.values(CAPABILITY);
        if (!validCaps.includes(explicitReasoning)) {
          throw new MultipolyError(
            "CONFIG",
            `${prefix}_REASONING must be one of ${validCaps.join(", ")}, got ${JSON.stringify(explicitReasoning)}`,
          );
        }
        base.reasoning = explicitReasoning;
      } else if (transport === "anthropic") {
        base.reasoning = CAPABILITY.ANTHROPIC_EFFORT;
      } else if (transport === "http") {
        // Infer from REASONING_VOCAB when available.
        const vocab = (env[`${prefix}_REASONING_VOCAB`] || "").trim().toLowerCase();
        if (vocab === "deepseek" || vocab === "gemini") {
          base.reasoning = CAPABILITY.OPENAI_EFFORT;
        } else if (vocab === "glm") {
          base.reasoning = CAPABILITY.GLM_TOGGLE;
        } else if (vocab === "qwen") {
          base.reasoning = CAPABILITY.QWEN_BUDGET;
        } else {
          base.reasoning = CAPABILITY.NONE;
        }
      } else {
        // cli transport
        base.reasoning = CAPABILITY.NONE;
      }
      // reasoningVocab: carry forward when OPENAI_EFFORT and REASONING_VOCAB is set.
      const vocab = (env[`${prefix}_REASONING_VOCAB`] || "").trim();
      if (vocab && base.reasoning === CAPABILITY.OPENAI_EFFORT) {
        base.reasoningVocab = vocab;
      }
      // defaultEffort: env-defined custom models use "off" as baked default unless
      // a reasoning effort or thinking env is set (Part A's resolution handles it).
      base.defaultEffort = "off";
      info[key] = Object.freeze(base);
    }
  }

  loadModelsFileInto(env, { keys, info, seen });
  warnLegacyMigration(env);
  return { keys: Object.freeze(keys), info: Object.freeze(info) };
}

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
        message: `${prefix}* are no longer used to configure a model (values ignored as credentials). Use ${canonical} instead.`,
      }) + "\n",
    );
  }
}

/**
 * Resolve the effective transport for a promotable builtin (claude/codex/etc.)
 * applying the transport-flip guard for claude:
 *   - explicit MULTIPOLY_<K>_TRANSPORT always wins
 *   - claude: if transport unset AND an Anthropic key is present, default to
 *     "anthropic" (overrides the baked "cli" default). Strictly safer: avoids
 *     silently routing API keys through the local CLI. Operator who wants CLI
 *     with an Anthropic key in env sets MULTIPOLY_CLAUDE_TRANSPORT=cli explicitly.
 *     NOTE: we do not detect CLI auth; unset transport + anthropic key ⇒ anthropic.
 *   - codex: keeps baked cli (no prior API deployment to protect), just logs
 *   - all other builtins: fall back to baked transport default
 * Always emits a structured stderr transport_default log for claude/codex.
 *
 * @param {string} key - model key (e.g. "claude", "codex")
 * @param {object} env - process.env or test env
 * @param {string} prefix - e.g. "MULTIPOLY_CLAUDE"
 * @param {object} baked - MODEL_INFO entry for this key
 * @returns {string} resolved transport
 */
function resolveBuiltinTransport(key, env, prefix, baked) {
  const explicit = (env[`${prefix}_TRANSPORT`] || "").trim();
  if (explicit) return parseTransport(explicit, `${prefix}_TRANSPORT`);

  if (key === "claude") {
    const anthropicKeyPresent = firstNonEmpty(env, [
      "ANTHROPIC_API_KEY",
      "MULTIPOLY_CLAUDE_API_KEY",
      "MULTIPOLY_OPUS_API_KEY",
    ]);
    const chosen = anthropicKeyPresent ? "anthropic" : (baked?.transport ?? "cli");
    process.stderr.write(
      JSON.stringify({
        event: "transport_default",
        model: "claude",
        chosen,
        reason: anthropicKeyPresent
          ? "anthropic key present, transport unset"
          : "no anthropic key; baked default",
      }) + "\n",
    );
    return chosen;
  }

  if (key === "codex") {
    const chosen = baked?.transport ?? "cli";
    const codexKey = firstNonEmpty(env, ["OPENAI_API_KEY", "MULTIPOLY_CODEX_API_KEY"]);
    if (codexKey) {
      process.stderr.write(
        JSON.stringify({
          event: "transport_default",
          model: "codex",
          chosen,
          reason: "baked default",
        }) + "\n",
      );
    }
    return chosen;
  }

  return parseTransport(undefined, `${prefix}_TRANSPORT`, baked?.transport);
}

function parseTransport(raw, label, fallback = "http") {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return fallback ?? "http";
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
  "reasoning",
  "reasoningVocab",
  "defaultEffort",
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

  // Reasoning capability: explicit field wins; otherwise default by transport.
  // Custom/file models default to NONE unless an explicit capability is declared.
  if (typeof entry.reasoning === "string" && entry.reasoning.trim()) {
    const cap = entry.reasoning.trim();
    const validCaps = Object.values(CAPABILITY);
    if (!validCaps.includes(cap)) {
      throw new MultipolyError(
        "CONFIG",
        `${where} reasoning must be one of ${validCaps.join(", ")}, got ${JSON.stringify(cap)}`,
      );
    }
    base.reasoning = cap;
  } else {
    // Default reasoning capability by transport when not explicitly set.
    // http models could be any vocab; anthropic custom models get ANTHROPIC_EFFORT by default.
    // All others default to NONE (safe: disables reasoning controls until explicitly set).
    if (transport === "anthropic") {
      base.reasoning = CAPABILITY.ANTHROPIC_EFFORT;
    } else {
      base.reasoning = CAPABILITY.NONE;
    }
  }

  if (typeof entry.reasoningVocab === "string" && entry.reasoningVocab.trim()) {
    base.reasoningVocab = entry.reasoningVocab.trim();
  }
  if (typeof entry.defaultEffort === "string" && entry.defaultEffort.trim()) {
    const de = entry.defaultEffort.trim();
    if (!EFFORT_LEVELS.includes(de)) {
      throw new MultipolyError(
        "CONFIG",
        `${where} defaultEffort must be one of ${EFFORT_LEVELS.join("|")}, got ${JSON.stringify(de)}`,
      );
    }
    base.defaultEffort = de;
  }

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
 *
 * SEMANTICS: returns true only for models that take a bare top-level `thinking`
 * toggle — i.e. GLM_TOGGLE, KIMI_TOGGLE, ANTHROPIC_BUDGET. Does NOT include
 * OPENAI_EFFORT (deepseek/qwen), QWEN_BUDGET, or ANTHROPIC_EFFORT. This
 * preserves the existing wire behavior until transports are rewritten (Task 8+).
 */
export function modelSupportsThinking(config, key) {
  const fromConfig = config?.models?.[key]?.supportsThinking;
  if (fromConfig !== undefined) return fromConfig;
  return Boolean(MODEL_INFO[key]?.supportsThinking);
}

/**
 * Resolve the reasoning capability for a model. Prefers the `reasoning` field
 * on the loaded model config, falling back to MODEL_INFO, then NONE.
 */
export function modelCapability(config, key) {
  const fromConfig = config?.models?.[key]?.reasoning;
  if (fromConfig !== undefined) return fromConfig;
  return MODEL_INFO[key]?.reasoning ?? CAPABILITY.NONE;
}

/**
 * Whether a model has any reasoning control at all (capability !== NONE).
 * Use this to gate the new reasoning-effort plumbing; use modelSupportsThinking
 * only to decide whether to send a bare top-level `thinking` toggle field.
 */
export function modelHasReasoningControl(config, key) {
  return modelCapability(config, key) !== CAPABILITY.NONE;
}

export function firstNonEmpty(env, names) {
  for (const name of names) {
    const v = (env[name] || "").trim();
    if (v) return { name, value: v };
  }
  return null;
}
