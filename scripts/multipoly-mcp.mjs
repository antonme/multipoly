#!/usr/bin/env node
/**
 * Multipoly MCP server entrypoint.
 *
 * Exposes model-specific review/consult tools and council tools over MCP stdio.
 *
 * Startup:
 *   node scripts/multipoly-mcp.mjs           # serve over stdio
 *   node scripts/multipoly-mcp.mjs --health  # validate config and exit
 */

import * as net from "node:net";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import {
  loadConfig,
  redactedConfig,
  resolveCallTimeoutMs,
  TIMEOUT_BOUNDS,
  normalizeSynthesizerChoice,
} from "./lib/config.mjs";
import { MultipolyError, logError } from "./lib/errors.mjs";
import { MODEL_KEYS, MODEL_INFO, modelHasReasoningControl } from "./lib/models.mjs";
import { EFFORT_LEVELS } from "./lib/reasoning.mjs";
import { handleModelReview } from "./lib/model-review.mjs";
import { handleModelConsult } from "./lib/model-consult.mjs";
import { handleCouncilReview, handleCouncilConsult } from "./lib/council.mjs";
import { scan } from "./lib/secrets.mjs";
import { enableHappyEyeballs } from "./lib/net-config.mjs";

const TIMEOUT_ARG_SCHEMA = {
  type: "integer",
  minimum: TIMEOUT_BOUNDS.min,
  maximum: TIMEOUT_BOUNDS.max,
  description: "Optional upstream stream inactivity timeout override in milliseconds.",
};

const REASONING_EFFORT_ARG_SCHEMA = {
  type: "string",
  enum: [...EFFORT_LEVELS],
  description:
    "Per-call reasoning effort override. One of off|low|medium|high|xhigh. " +
    "Omit to inherit the per-model or server-wide default.",
};

const ALLOW_SECRETS_ARG_SCHEMA = {
  type: "boolean",
  description:
    "Bypass the secret scanner for THIS call only (use when the scanner false-positives on your code). Default false.",
};

const REVIEW_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description: "Exactly one of diff_base or paths is required.",
  properties: {
    diff_base: { type: "string", description: "Git ref to diff HEAD against." },
    paths: { type: "array", items: { type: "string" }, minItems: 1 },
    focus: { type: "string" },
    timeout_ms: TIMEOUT_ARG_SCHEMA,
    allow_secrets: ALLOW_SECRETS_ARG_SCHEMA,
  },
};

const CONSULT_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: { type: "string", minLength: 1 },
    paths: { type: "array", items: { type: "string" } },
    timeout_ms: TIMEOUT_ARG_SCHEMA,
    allow_secrets: ALLOW_SECRETS_ARG_SCHEMA,
  },
};

// Council extra properties depend on the active model registry (the enums must
// list the real model keys), so they're built per-registry rather than static.
function councilExtraProperties(modelKeys) {
  return {
    models: {
      type: "array",
      items: { type: "string", enum: [...modelKeys] },
      minItems: 2,
      description: "Optional council member models. Defaults to all configured models.",
    },
    synthesizer: {
      type: "string",
      enum: [...modelKeys, "harness", "none", "caller"],
      description:
        "A model key to synthesize server-side (falls through to the next configured model if unconfigured), " +
        "or 'harness'/'none'/'caller' to return member outputs for the calling harness to synthesize. " +
        "Defaults to MULTIPOLY_SYNTHESIZER, else defers to the harness.",
    },
    include_individual_results: { type: "boolean" },
    compact: {
      type: "boolean",
      description:
        "Drop per-model prose summaries from members (findings only) to shrink large council payloads.",
    },
  };
}

const BUILTIN_REGISTRY = { keys: MODEL_KEYS, info: MODEL_INFO };

/**
 * Single source of truth for the server's tool surface. Each tool's advertised
 * schema, its runtime allowed-argument-key set, and its handler are defined
 * together, so the three can't drift out of sync — previously they were built
 * by three separate functions each re-deriving the tool list from the model
 * keys, where adding a tool to one and not the others was a latent runtime bug.
 */
function buildToolDefs(registry) {
  const extra = councilExtraProperties(registry.keys);
  // Council tools always advertise reasoning_effort (members may each support it;
  // the per-member capability gate happens inside the council handler at runtime).
  const councilReviewSchema = {
    ...REVIEW_TOOL_SCHEMA,
    properties: { ...REVIEW_TOOL_SCHEMA.properties, ...extra, reasoning_effort: REASONING_EFFORT_ARG_SCHEMA },
  };
  const councilConsultSchema = {
    ...CONSULT_TOOL_SCHEMA,
    properties: { ...CONSULT_TOOL_SCHEMA.properties, ...extra, reasoning_effort: REASONING_EFFORT_ARG_SCHEMA },
  };

  const defs = [];
  for (const key of registry.keys) {
    const displayName = registry.info[key]?.displayName ?? key;
    // Build a config-like object the capability check can use. registryFromConfig
    // copies the `reasoning` field from the loaded config model onto registry.info,
    // so modelHasReasoningControl can read it without a full config object.
    const capConfig = { models: { [key]: registry.info[key] ?? {} } };
    const hasReasoning = modelHasReasoningControl(capConfig, key);
    // Per-key schema clone: add reasoning_effort only for capable models.
    const reviewSchema = hasReasoning
      ? { ...REVIEW_TOOL_SCHEMA, properties: { ...REVIEW_TOOL_SCHEMA.properties, reasoning_effort: REASONING_EFFORT_ARG_SCHEMA } }
      : REVIEW_TOOL_SCHEMA;
    const consultSchema = hasReasoning
      ? { ...CONSULT_TOOL_SCHEMA, properties: { ...CONSULT_TOOL_SCHEMA.properties, reasoning_effort: REASONING_EFFORT_ARG_SCHEMA } }
      : CONSULT_TOOL_SCHEMA;
    // Per-key allowedKeys clone: add reasoning_effort only for capable models.
    const reviewKeys = hasReasoning ? new Set([...REVIEW_KEYS, "reasoning_effort"]) : REVIEW_KEYS;
    const consultKeys = hasReasoning ? new Set([...CONSULT_KEYS, "reasoning_effort"]) : CONSULT_KEYS;
    defs.push({
      name: `${key}_review`,
      description: `Delegate a structured code review to ${displayName}. Supply exactly one of diff_base or paths.`,
      inputSchema: reviewSchema,
      allowedKeys: reviewKeys,
      handler: (input, ctx) => handleModelReview(key, input, ctx),
    });
    defs.push({
      name: `${key}_consult`,
      description: `Ask ${displayName} for a design or implementation consultation.`,
      inputSchema: consultSchema,
      allowedKeys: consultKeys,
      handler: (input, ctx) => handleModelConsult(key, input, ctx),
    });
  }
  defs.push({
    name: "council_review",
    description:
      "Run multiple model reviews in parallel. By default returns each model's findings for you (the calling harness) to merge; " +
      "set `synthesizer` (or MULTIPOLY_SYNTHESIZER) to a model to merge server-side instead. Supply exactly one of diff_base or paths.",
    inputSchema: councilReviewSchema,
    allowedKeys: new Set([...REVIEW_KEYS, ...COUNCIL_EXTRA_KEYS, "reasoning_effort"]),
    handler: handleCouncilReview,
  });
  defs.push({
    name: "council_consult",
    description:
      "Run multiple model consultations in parallel. By default returns each model's answer for you (the calling harness) to synthesize; " +
      "set `synthesizer` (or MULTIPOLY_SYNTHESIZER) to a model to synthesize server-side instead.",
    inputSchema: councilConsultSchema,
    allowedKeys: new Set([...CONSULT_KEYS, ...COUNCIL_EXTRA_KEYS, "reasoning_effort"]),
    handler: handleCouncilConsult,
  });

  // Curated alias tools: <alias>_review/_consult routed to a canonical handler.
  // Registered only when the canonical key is present in the registry. Schema +
  // allowedKeys are shared by reference from the canonical def so they can't drift.
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

  return defs;
}

/**
 * Derive the three parallel structures the server needs — the advertised
 * `tools`, the `handlers` map, and the `toolKeySpec` (allowed argument keys per
 * tool) — from the single tool-def list, so they always agree.
 */
export function buildServerSurface(registry = BUILTIN_REGISTRY) {
  const defs = buildToolDefs(registry);
  return {
    tools: defs.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    handlers: Object.fromEntries(defs.map((d) => [d.name, d.handler])),
    toolKeySpec: Object.fromEntries(defs.map((d) => [d.name, d.allowedKeys])),
  };
}

/**
 * Advertised tool list for a model registry ({ keys, info }). Thin wrapper over
 * buildServerSurface for callers/tests that only want the descriptors.
 */
export function buildTools(registry = BUILTIN_REGISTRY) {
  return buildServerSurface(registry).tools;
}

/** Derive a tool-building registry ({ keys, info }) from a loaded config. */
export function registryFromConfig(config) {
  return {
    keys: config.modelKeys,
    info: Object.fromEntries(
      config.modelKeys.map((k) => {
        const m = config.models[k] ?? {};
        return [
          k,
          {
            key: k,
            displayName: m.displayName ?? k,
            // reasoning capability is needed by buildToolDefs to decide whether
            // to add reasoning_effort to the per-key schema clone and allowedKeys.
            reasoning: m.reasoning,
          },
        ];
      }),
    ),
  };
}

/**
 * Build the MCP Server for a loaded config: advertises the registry's tools and
 * routes tools/call through the shared handler map + validator (all from one
 * buildServerSurface call, so they can't drift). Extracted from main() so it
 * can be driven over an in-memory transport in tests. Does NOT connect a
 * transport — the caller does that.
 */
export function createServer(config) {
  const surface = buildServerSurface(registryFromConfig(config));
  const modelKeys = config.modelKeys;

  const server = new Server(
    { name: "multipoly", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: surface.tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: input } = req.params;
    const handler = surface.handlers[name];
    if (!handler) {
      // Unknown tool is a protocol error, not an application result.
      throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${name}`);
    }
    try {
      validateToolInput(name, input, modelKeys, surface.toolKeySpec);
      // Log the effective timeout so operators can spot MCP-client-tool-timeout mismatches.
      const effectiveTimeoutMs = input?.timeout_ms ?? config.timeoutMs;
      process.stderr.write(
        JSON.stringify({
          event: "tool_call",
          tool: name,
          correlationId: null, // filled on error by the handler chain
          timeout_ms: effectiveTimeoutMs,
          client_warning:
            "MCP client may enforce its own lower tool-call timeout (e.g. Codex ~60s, Claude Code ~60s). " +
            "If the client kills this call before the upstream timeout, raise the client's tool_timeout_sec / MCP_TOOL_TIMEOUT.",
        }) + "\n",
      );
      const { result, reasoning } = await handler(input || {}, { config });
      return buildSuccessResponse(name, result, reasoning, config);
    } catch (e) {
      return buildErrorResponse(e);
    }
  });

  return server;
}

function main() {
  enableHappyEyeballs(net);
  const args = new Set(process.argv.slice(2));
  if (args.has("--health")) {
    try {
      const config = loadConfig();
      process.stdout.write(
        JSON.stringify({ status: "ok", config: redactedConfig(config) }, null, 2) + "\n",
      );
      process.exit(0);
    } catch (e) {
      logError(e);
      process.exit(1);
    }
  }

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    logError(e);
    process.exit(1);
  }

  const server = createServer(config);

  const transport = new StdioServerTransport();
  server.connect(transport).catch((e) => {
    logError(e);
    process.exit(1);
  });

  const configuredModels = Object.values(config.models)
    .filter((m) => m.configured)
    .map((m) => m.key)
    .join(",");
  process.stderr.write(`multipoly-mcp ready | models=${configuredModels || "none"}\n`);
  if (config.progress === "reasoning") {
    // Live reasoning tokens stream to stderr without passing through the
    // secret scanner — unlike MULTIPOLY_DEBUG_REASONING=1, which scans before
    // emitting. Operators enabling this mode should be aware the stream
    // can contain verbatim file/prompt content.
    process.stderr.write(
      `multipoly-mcp WARNING: MULTIPOLY_PROGRESS=reasoning streams raw reasoning tokens to stderr unfiltered. ` +
        `Use MULTIPOLY_PROGRESS=heartbeat for production.\n`,
    );
  }
}

/**
 * Minimal runtime input validation for the tools. We do this ourselves
 * rather than rely on a heavy JSON-schema lib; the surface is tiny.
 */
const REVIEW_KEYS = new Set(["diff_base", "paths", "focus", "timeout_ms", "allow_secrets"]);
const CONSULT_KEYS = new Set(["prompt", "paths", "timeout_ms", "allow_secrets"]);
const COUNCIL_EXTRA_KEYS = new Set(["models", "synthesizer", "include_individual_results", "compact"]);

// Curated alias map: each entry registers <alias>_review and <alias>_consult as
// thin aliases for the corresponding <canonical>_* tools. Defined at module scope
// so the array is not re-allocated on every buildToolDefs call.
const ALIAS_TOOLS = [
  { alias: "opus", canonical: "claude" },
  { alias: "gpt55", canonical: "codex" },
];

/**
 * Allowed argument keys per tool name, for the hand-rolled runtime validator.
 * Derived from the same tool-def source as buildTools (via buildServerSurface)
 * so the advertised schema and the validator key sets can't disagree. `info` is
 * unused for key sets, so an empty info map suffices here.
 */
export function buildToolKeySpec(modelKeys) {
  return buildServerSurface({ keys: modelKeys, info: {} }).toolKeySpec;
}

function validateToolInput(name, raw, modelKeys, toolKeySpec) {
  const input = raw || {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new MultipolyError("INVALID_INPUT", `${name}: arguments must be an object`);
  }
  // Shared across all three tools. Throws INVALID_INPUT on a bad value;
  // returns undefined when absent (handler falls back to config.timeoutMs).
  if ("timeout_ms" in input) resolveCallTimeoutMs(input.timeout_ms);
  const allowedKeySet = toolKeySpec?.[name];
  if (allowedKeySet) {
    for (const k of Object.keys(input)) {
      if (!allowedKeySet.has(k)) {
        throw new MultipolyError("INVALID_INPUT", `${name}: unknown argument '${k}'`);
      }
    }
  }
  // Validate reasoning_effort value when present. The key is only in the
  // allowedKeySet for reasoning-capable tools (so unknown-key rejection above
  // already guards NONE models), but we also validate the concrete value here.
  if ("reasoning_effort" in input) {
    const v = input.reasoning_effort;
    if (typeof v !== "string" || !EFFORT_LEVELS.includes(v.trim().toLowerCase())) {
      throw new MultipolyError(
        "INVALID_INPUT",
        `${name}.reasoning_effort must be a concrete level: ${EFFORT_LEVELS.join("|")}, got ${JSON.stringify(v)}`,
      );
    }
  }
  // Validate allow_secrets value when present. Must be a boolean; any other type
  // is rejected so callers can't accidentally pass a truthy string/number.
  if ("allow_secrets" in input && typeof input.allow_secrets !== "boolean") {
    throw new MultipolyError(
      "INVALID_INPUT",
      `${name}.allow_secrets must be a boolean, got ${JSON.stringify(input.allow_secrets)}`,
    );
  }
  if (name.endsWith("_review")) {
    validateReviewInput(name, input, name.startsWith("council_"), modelKeys);
    return;
  }
  if (name.endsWith("_consult")) {
    validateConsultInput(name, input, name.startsWith("council_"), modelKeys);
    return;
  }
  throw new MultipolyError("INVALID_INPUT", `unknown tool shape: ${name}`);
}

function validateCouncilExtras(name, input, modelKeys) {
  if ("models" in input) {
    if (!Array.isArray(input.models) || input.models.length < 2) {
      throw new MultipolyError("INVALID_INPUT", `${name}.models must be an array with at least two entries`);
    }
    if (!input.models.every((m) => typeof m === "string" && m.length > 0)) {
      throw new MultipolyError("INVALID_INPUT", `${name}.models entries must be non-empty strings`);
    }
  }
  if ("synthesizer" in input) {
    if (typeof input.synthesizer !== "string" || normalizeSynthesizerChoice(input.synthesizer, modelKeys) === null) {
      throw new MultipolyError(
        "INVALID_INPUT",
        `${name}.synthesizer must be one of ${[...modelKeys, "harness", "none", "caller"].join(", ")}`,
      );
    }
  }
  if ("include_individual_results" in input && typeof input.include_individual_results !== "boolean") {
    throw new MultipolyError("INVALID_INPUT", `${name}.include_individual_results must be a boolean`);
  }
  if ("compact" in input && typeof input.compact !== "boolean") {
    throw new MultipolyError("INVALID_INPUT", `${name}.compact must be a boolean`);
  }
}

function validateReviewInput(name, input, isCouncil, modelKeys) {
  if (isCouncil) validateCouncilExtras(name, input, modelKeys);

  const hasBase = "diff_base" in input;
  const hasPaths = "paths" in input;
  if (hasBase === hasPaths) {
    throw new MultipolyError(
      "INVALID_INPUT",
      `${name}: exactly one of 'diff_base' or 'paths' is required`,
    );
  }
  if (hasBase) {
    if (typeof input.diff_base !== "string" || input.diff_base.trim().length === 0) {
      throw new MultipolyError("INVALID_INPUT", `${name}.diff_base must be a non-empty string`);
    }
  }
  if (hasPaths) {
    if (!Array.isArray(input.paths) || input.paths.length === 0) {
      throw new MultipolyError("INVALID_INPUT", `${name}.paths must be a non-empty array`);
    }
    if (!input.paths.every((p) => typeof p === "string" && p.length > 0)) {
      throw new MultipolyError("INVALID_INPUT", `${name}.paths entries must be non-empty strings`);
    }
  }
  if ("focus" in input && typeof input.focus !== "string") {
    throw new MultipolyError("INVALID_INPUT", `${name}.focus must be a string`);
  }
}

function validateConsultInput(name, input, isCouncil, modelKeys) {
  if (isCouncil) validateCouncilExtras(name, input, modelKeys);

  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new MultipolyError("INVALID_INPUT", `${name}.prompt must be a non-empty string`);
  }
  if ("paths" in input) {
    if (!Array.isArray(input.paths)) {
      throw new MultipolyError("INVALID_INPUT", `${name}.paths must be an array`);
    }
    if (!input.paths.every((p) => typeof p === "string" && p.length > 0)) {
      throw new MultipolyError("INVALID_INPUT", `${name}.paths entries must be non-empty strings`);
    }
  }
}

function buildSuccessResponse(name, result, reasoning, config) {
  const blocks = [];
  if (name.endsWith("_review")) {
    blocks.push({ type: "text", text: JSON.stringify(result, null, 2) });
  } else {
    blocks.push({ type: "text", text: result });
  }
  if (config.debugReasoning && reasoning) {
    // The scanner only runs over outbound prompts pre-flight; reasoning is
    // the model's output and may echo file content that included secrets
    // the scanner missed. Scan before surfacing, and redact if anything is
    // flagged (unless the operator has explicitly allowed secrets).
    //
    // A scanner failure (e.g., pathological regex behavior on adversarial
    // input) must not lose the primary tool result. Fall back to the
    // redaction path on any exception.
    let clean;
    try {
      ({ clean } = scan(reasoning, "reasoning"));
    } catch (e) {
      logError(new MultipolyError("INTERNAL", `reasoning secret-scan failed: ${e?.message ?? e}`, { cause: e }));
      clean = false;
    }
    if (clean || config.allowSecrets) {
      blocks.push({ type: "text", text: `--- reasoning ---\n${reasoning}` });
    } else {
      blocks.push({
        type: "text",
        text:
          `--- reasoning (redacted) ---\n` +
          `Model reasoning was withheld (scanner flagged it or failed). ` +
          `Set MULTIPOLY_ALLOW_SECRETS=1 to include it anyway.`,
      });
    }
  }
  return { content: blocks };
}

function buildErrorResponse(err) {
  if (!(err instanceof MultipolyError)) {
    err = new MultipolyError("INTERNAL", err?.message ?? String(err), { cause: err });
  }
  logError(err);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(err.toJSON(), null, 2) }],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
