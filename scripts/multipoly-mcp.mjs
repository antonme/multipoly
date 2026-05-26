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

import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, redactedConfig, resolveCallTimeoutMs, TIMEOUT_BOUNDS } from "./lib/config.mjs";
import { GlmError, logError } from "./lib/errors.mjs";
import { MODEL_KEYS, MODEL_INFO } from "./lib/models.mjs";
import { handleModelReview } from "./lib/model-review.mjs";
import { handleModelConsult } from "./lib/model-consult.mjs";
import { handleCouncilReview, handleCouncilConsult } from "./lib/council.mjs";
import { scan } from "./lib/secrets.mjs";

const TIMEOUT_ARG_SCHEMA = {
  type: "integer",
  minimum: TIMEOUT_BOUNDS.min,
  maximum: TIMEOUT_BOUNDS.max,
  description: "Optional upstream stream inactivity timeout override in milliseconds.",
};

const REVIEW_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    diff_base: { type: "string", description: "Git ref to diff HEAD against." },
    paths: { type: "array", items: { type: "string" }, minItems: 1 },
    focus: { type: "string" },
    timeout_ms: TIMEOUT_ARG_SCHEMA,
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
  },
};

const COUNCIL_REVIEW_TOOL_SCHEMA = {
  ...REVIEW_TOOL_SCHEMA,
  properties: {
    ...REVIEW_TOOL_SCHEMA.properties,
    models: {
      type: "array",
      items: { type: "string", enum: MODEL_KEYS },
      minItems: 2,
      description: "Optional council member models. Defaults to all configured models.",
    },
    synthesizer: { type: "string", enum: MODEL_KEYS, description: "Defaults to qwen." },
    include_individual_results: { type: "boolean" },
  },
};

const COUNCIL_CONSULT_TOOL_SCHEMA = {
  ...CONSULT_TOOL_SCHEMA,
  properties: {
    ...CONSULT_TOOL_SCHEMA.properties,
    models: {
      type: "array",
      items: { type: "string", enum: MODEL_KEYS },
      minItems: 2,
      description: "Optional council member models. Defaults to all configured models.",
    },
    synthesizer: { type: "string", enum: MODEL_KEYS, description: "Defaults to qwen." },
    include_individual_results: { type: "boolean" },
  },
};

export function buildTools() {
  const tools = [];
  for (const key of MODEL_KEYS) {
    const info = MODEL_INFO[key];
    tools.push({
      name: `${key}_review`,
      description: `Delegate a structured code review to ${info.displayName}.`,
      inputSchema: REVIEW_TOOL_SCHEMA,
    });
    tools.push({
      name: `${key}_consult`,
      description: `Ask ${info.displayName} for a design or implementation consultation.`,
      inputSchema: CONSULT_TOOL_SCHEMA,
    });
  }
  tools.push({
    name: "council_review",
    description: "Run multiple model reviews in parallel, then synthesize with Qwen.",
    inputSchema: COUNCIL_REVIEW_TOOL_SCHEMA,
  });
  tools.push({
    name: "council_consult",
    description: "Run multiple model consultations in parallel, then synthesize with Qwen.",
    inputSchema: COUNCIL_CONSULT_TOOL_SCHEMA,
  });
  return tools;
}

const TOOLS = buildTools();

function main() {
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

  const server = new Server(
    { name: "multipoly", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: input } = req.params;
    const handler = HANDLERS[name];
    if (!handler) {
      // Unknown tool is a protocol error, not an application result.
      throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${name}`);
    }
    try {
      validateToolInput(name, input);
      const { result, reasoning } = await handler(input || {}, { config });
      return buildSuccessResponse(name, result, reasoning, config);
    } catch (e) {
      return buildErrorResponse(e);
    }
  });

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
    // secret scanner — unlike GLM_DEBUG_REASONING=1, which scans before
    // emitting. Operators enabling this mode should be aware the stream
    // can contain verbatim file/prompt content.
    process.stderr.write(
      `multipoly-mcp WARNING: GLM_PROGRESS=reasoning streams raw reasoning tokens to stderr unfiltered. ` +
        `Use GLM_PROGRESS=heartbeat for production.\n`,
    );
  }
}

const HANDLERS = Object.fromEntries([
  ...MODEL_KEYS.flatMap((key) => [
    [`${key}_review`, (input, ctx) => handleModelReview(key, input, ctx)],
    [`${key}_consult`, (input, ctx) => handleModelConsult(key, input, ctx)],
  ]),
  ["council_review", handleCouncilReview],
  ["council_consult", handleCouncilConsult],
]);

/**
 * Minimal runtime input validation for the tools. We do this ourselves
 * rather than rely on a heavy JSON-schema lib; the surface is tiny.
 */
const REVIEW_KEYS = new Set(["diff_base", "paths", "focus", "timeout_ms"]);
const CONSULT_KEYS = new Set(["prompt", "paths", "timeout_ms"]);
const COUNCIL_EXTRA_KEYS = new Set(["models", "synthesizer", "include_individual_results"]);

function rejectUnknownKeys(name, input, allowed) {
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) {
      throw new GlmError("INVALID_INPUT", `${name}: unknown argument '${k}'`);
    }
  }
}

function validateToolInput(name, raw) {
  const input = raw || {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new GlmError("INVALID_INPUT", `${name}: arguments must be an object`);
  }
  // Shared across all three tools. Throws INVALID_INPUT on a bad value;
  // returns undefined when absent (handler falls back to config.timeoutMs).
  if ("timeout_ms" in input) resolveCallTimeoutMs(input.timeout_ms);
  if (name.endsWith("_review")) {
    validateReviewInput(name, input, name.startsWith("council_"));
    return;
  }
  if (name.endsWith("_consult")) {
    validateConsultInput(name, input, name.startsWith("council_"));
    return;
  }
  throw new GlmError("INVALID_INPUT", `unknown tool shape: ${name}`);
}

function allowedKeys(baseKeys, isCouncil) {
  return isCouncil ? new Set([...baseKeys, ...COUNCIL_EXTRA_KEYS]) : baseKeys;
}

function validateCouncilExtras(name, input) {
  if ("models" in input) {
    if (!Array.isArray(input.models) || input.models.length < 2) {
      throw new GlmError("INVALID_INPUT", `${name}.models must be an array with at least two entries`);
    }
    if (!input.models.every((m) => typeof m === "string" && m.length > 0)) {
      throw new GlmError("INVALID_INPUT", `${name}.models entries must be non-empty strings`);
    }
  }
  if ("synthesizer" in input && (typeof input.synthesizer !== "string" || input.synthesizer.length === 0)) {
    throw new GlmError("INVALID_INPUT", `${name}.synthesizer must be a non-empty string`);
  }
  if ("include_individual_results" in input && typeof input.include_individual_results !== "boolean") {
    throw new GlmError("INVALID_INPUT", `${name}.include_individual_results must be a boolean`);
  }
}

function validateReviewInput(name, input, isCouncil) {
  rejectUnknownKeys(name, input, allowedKeys(REVIEW_KEYS, isCouncil));
  if (isCouncil) validateCouncilExtras(name, input);

  const hasBase = "diff_base" in input;
  const hasPaths = "paths" in input;
  if (hasBase === hasPaths) {
    throw new GlmError(
      "INVALID_INPUT",
      `${name}: exactly one of 'diff_base' or 'paths' is required`,
    );
  }
  if (hasBase) {
    if (typeof input.diff_base !== "string" || input.diff_base.trim().length === 0) {
      throw new GlmError("INVALID_INPUT", `${name}.diff_base must be a non-empty string`);
    }
  }
  if (hasPaths) {
    if (!Array.isArray(input.paths) || input.paths.length === 0) {
      throw new GlmError("INVALID_INPUT", `${name}.paths must be a non-empty array`);
    }
    if (!input.paths.every((p) => typeof p === "string" && p.length > 0)) {
      throw new GlmError("INVALID_INPUT", `${name}.paths entries must be non-empty strings`);
    }
  }
  if ("focus" in input && typeof input.focus !== "string") {
    throw new GlmError("INVALID_INPUT", `${name}.focus must be a string`);
  }
}

function validateConsultInput(name, input, isCouncil) {
  rejectUnknownKeys(name, input, allowedKeys(CONSULT_KEYS, isCouncil));
  if (isCouncil) validateCouncilExtras(name, input);

  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new GlmError("INVALID_INPUT", `${name}.prompt must be a non-empty string`);
  }
  if ("paths" in input) {
    if (!Array.isArray(input.paths)) {
      throw new GlmError("INVALID_INPUT", `${name}.paths must be an array`);
    }
    if (!input.paths.every((p) => typeof p === "string" && p.length > 0)) {
      throw new GlmError("INVALID_INPUT", `${name}.paths entries must be non-empty strings`);
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
      logError(new GlmError("INTERNAL", `reasoning secret-scan failed: ${e?.message ?? e}`, { cause: e }));
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
          `Set GLM_ALLOW_SECRETS=1 to include it anyway.`,
      });
    }
  }
  return { content: blocks };
}

function buildErrorResponse(err) {
  if (!(err instanceof GlmError)) {
    err = new GlmError("INTERNAL", err?.message ?? String(err), { cause: err });
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
