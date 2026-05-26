#!/usr/bin/env node
/**
 * GLM MCP server entrypoint.
 *
 * Exposes three tools over MCP stdio:
 *   - glm_review   — structured JSON code review over a git diff or file list
 *   - glm_consult  — markdown second-opinion / design consultation
 *   - glm_freeform — free-form single-shot chat
 *
 * Startup:
 *   node scripts/glm-mcp.mjs           # serve over stdio
 *   node scripts/glm-mcp.mjs --health  # validate config and exit
 */

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
import { handleReview } from "./lib/review.mjs";
import { handleConsult } from "./lib/consult.mjs";
import { handleFreeform } from "./lib/freeform.mjs";
import { scan } from "./lib/secrets.mjs";

const TOOLS = [
  {
    name: "glm_review",
    description:
      "Delegate a code review to GLM 5.1 and receive structured findings. " +
      "Supply exactly one of: `diff_base` (git ref for diff-based review, preferred) " +
      "or `paths` (list of file paths). " +
      "Returns JSON with per-finding severity/path/line/message/suggestion.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff_base: {
          type: "string",
          description:
            "Git ref to diff HEAD against (e.g. 'main', 'origin/main', a SHA). " +
            "Mutually exclusive with `paths`.",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Explicit file paths (repo-relative or absolute) to review. " +
            "Mutually exclusive with `diff_base`.",
        },
        focus: { type: "string", description: "Optional steering text for the reviewer." },
        timeout_ms: {
          type: "integer",
          minimum: TIMEOUT_BOUNDS.min,
          maximum: TIMEOUT_BOUNDS.max,
          description:
            "Optional override for the upstream stream inactivity timeout (ms). " +
            "Defaults to GLM_TIMEOUT_MS (600000). NOTE: this cannot exceed the MCP " +
            "client's own tool-call timeout (e.g. Codex's tool_timeout_sec).",
        },
      },
    },
  },
  {
    name: "glm_consult",
    description:
      "Ask GLM 5.1 for a second opinion on a hard design or implementation question. " +
      "Optionally attach specific files as context. Returns markdown.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: { type: "string", minLength: 1, description: "The question or discussion topic." },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional files to attach verbatim as context.",
        },
        timeout_ms: {
          type: "integer",
          minimum: TIMEOUT_BOUNDS.min,
          maximum: TIMEOUT_BOUNDS.max,
          description:
            "Optional override for the upstream stream inactivity timeout (ms). " +
            "Defaults to GLM_TIMEOUT_MS (600000). NOTE: this cannot exceed the MCP " +
            "client's own tool-call timeout (e.g. Codex's tool_timeout_sec).",
        },
      },
    },
  },
  {
    name: "glm_freeform",
    description:
      "Free-form single-shot prompt to GLM 5.1. Use this only when neither glm_review nor glm_consult fits.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: { type: "string", minLength: 1 },
        timeout_ms: {
          type: "integer",
          minimum: TIMEOUT_BOUNDS.min,
          maximum: TIMEOUT_BOUNDS.max,
          description:
            "Optional override for the upstream stream inactivity timeout (ms). " +
            "Defaults to GLM_TIMEOUT_MS (600000). NOTE: this cannot exceed the MCP " +
            "client's own tool-call timeout (e.g. Codex's tool_timeout_sec).",
        },
      },
    },
  },
];

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
    { name: "glm", version: "0.1.0" },
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

  process.stderr.write(
    `glm-mcp ready | model=${config.model} endpoint=${config.endpoint}\n`,
  );
  if (config.progress === "reasoning") {
    // Live reasoning tokens stream to stderr without passing through the
    // secret scanner — unlike GLM_DEBUG_REASONING=1, which scans before
    // emitting. Operators enabling this mode should be aware the stream
    // can contain verbatim file/prompt content.
    process.stderr.write(
      `glm-mcp WARNING: GLM_PROGRESS=reasoning streams raw reasoning tokens to stderr unfiltered. ` +
        `Use GLM_PROGRESS=heartbeat for production.\n`,
    );
  }
}

const HANDLERS = {
  glm_review: handleReview,
  glm_consult: handleConsult,
  glm_freeform: handleFreeform,
};

/**
 * Minimal runtime input validation for the three tools. We do this ourselves
 * rather than rely on a heavy JSON-schema lib; the surface is tiny.
 */
const ALLOWED_KEYS = Object.freeze({
  glm_review: new Set(["diff_base", "paths", "focus", "timeout_ms"]),
  glm_consult: new Set(["prompt", "paths", "timeout_ms"]),
  glm_freeform: new Set(["prompt", "timeout_ms"]),
});

function rejectUnknownKeys(name, input) {
  const allowed = ALLOWED_KEYS[name];
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
  rejectUnknownKeys(name, input);
  // Shared across all three tools. Throws INVALID_INPUT on a bad value;
  // returns undefined when absent (handler falls back to config.timeoutMs).
  if ("timeout_ms" in input) resolveCallTimeoutMs(input.timeout_ms);
  if (name === "glm_review") {
    const hasBase = "diff_base" in input;
    const hasPaths = "paths" in input;
    if (hasBase === hasPaths) {
      throw new GlmError(
        "INVALID_INPUT",
        `glm_review: exactly one of 'diff_base' or 'paths' is required`,
      );
    }
    if (hasBase) {
      if (typeof input.diff_base !== "string" || input.diff_base.trim().length === 0) {
        throw new GlmError("INVALID_INPUT", `glm_review.diff_base must be a non-empty string`);
      }
    }
    if (hasPaths) {
      if (!Array.isArray(input.paths) || input.paths.length === 0) {
        throw new GlmError("INVALID_INPUT", `glm_review.paths must be a non-empty array`);
      }
      if (!input.paths.every((p) => typeof p === "string" && p.length > 0)) {
        throw new GlmError("INVALID_INPUT", `glm_review.paths entries must be non-empty strings`);
      }
    }
    if ("focus" in input && typeof input.focus !== "string") {
      throw new GlmError("INVALID_INPUT", `glm_review.focus must be a string`);
    }
    return;
  }
  if (name === "glm_consult") {
    if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
      throw new GlmError("INVALID_INPUT", `glm_consult.prompt must be a non-empty string`);
    }
    if ("paths" in input) {
      if (!Array.isArray(input.paths)) {
        throw new GlmError("INVALID_INPUT", `glm_consult.paths must be an array`);
      }
      if (!input.paths.every((p) => typeof p === "string" && p.length > 0)) {
        throw new GlmError("INVALID_INPUT", `glm_consult.paths entries must be non-empty strings`);
      }
    }
    return;
  }
  if (name === "glm_freeform") {
    if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
      throw new GlmError("INVALID_INPUT", `glm_freeform.prompt must be a non-empty string`);
    }
    return;
  }
}

function buildSuccessResponse(name, result, reasoning, config) {
  const blocks = [];
  if (name === "glm_review") {
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

main();
