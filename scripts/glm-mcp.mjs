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

import { loadConfig, redactedConfig } from "./lib/config.mjs";
import { GlmError, logError } from "./lib/errors.mjs";
import { handleReview } from "./lib/review.mjs";
import { handleConsult } from "./lib/consult.mjs";
import { handleFreeform } from "./lib/freeform.mjs";

const TOOLS = [
  {
    name: "glm_review",
    description:
      "Delegate a code review to GLM 5.1 and receive structured findings. " +
      "Supply a git ref for diff-based review (preferred) or a list of file paths. " +
      "Returns JSON with per-finding severity/path/line/message/suggestion.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff_base: {
          type: "string",
          description: "Git ref to diff HEAD against (e.g. 'main', 'origin/main', a SHA).",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Explicit file paths (repo-relative or absolute) to review.",
        },
        focus: { type: "string", description: "Optional steering text for the reviewer." },
      },
      oneOf: [{ required: ["diff_base"] }, { required: ["paths"] }],
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
function validateToolInput(name, raw) {
  const input = raw || {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new GlmError("INVALID_INPUT", `${name}: arguments must be an object`);
  }
  if (name === "glm_review") {
    const hasBase = "diff_base" in input;
    const hasPaths = "paths" in input;
    if (hasBase === hasPaths) {
      throw new GlmError(
        "INVALID_INPUT",
        `glm_review: exactly one of 'diff_base' or 'paths' is required`,
      );
    }
    if (hasBase && typeof input.diff_base !== "string") {
      throw new GlmError("INVALID_INPUT", `glm_review.diff_base must be a string`);
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
    blocks.push({ type: "text", text: `--- reasoning ---\n${reasoning}` });
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
