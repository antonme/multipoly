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
      oneOf: [
        {
          required: ["diff_base"],
          properties: {
            diff_base: {
              type: "string",
              description: "Git ref to diff HEAD against (e.g. 'main', 'origin/main', a SHA).",
            },
            focus: { type: "string", description: "Optional steering text for the reviewer." },
          },
        },
        {
          required: ["paths"],
          properties: {
            paths: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description: "Explicit file paths (repo-relative or absolute) to review.",
            },
            focus: { type: "string", description: "Optional steering text for the reviewer." },
          },
        },
      ],
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
    {
      capabilities: { tools: {} },
      // We do our own input validation to keep plain JSON Schema portable across SDK versions.
      jsonSchemaValidator: {
        compile: () => () => true,
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: input } = req.params;
    try {
      const handler = pickHandler(name);
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

function pickHandler(name) {
  switch (name) {
    case "glm_review":
      return handleReview;
    case "glm_consult":
      return handleConsult;
    case "glm_freeform":
      return handleFreeform;
    default:
      throw new GlmError("INVALID_INPUT", `unknown tool: ${name}`);
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
