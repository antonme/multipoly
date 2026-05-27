import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, buildServerSurface, registryFromConfig } from "../scripts/multipoly-mcp.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

const BUILTIN_TOOL_NAMES = [
  "composer_consult",
  "composer_review",
  "council_consult",
  "council_review",
  "deepseek_consult",
  "deepseek_review",
  "glm_consult",
  "glm_review",
  "qwen_consult",
  "qwen_review",
];

// Boot the real Server over an in-memory transport linked to a real Client —
// exercises the actual tools/list + tools/call request path end to end, which
// the unit tests (which call builders directly) never wire together.
async function connect(config) {
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, async close() { await client.close(); await server.close(); } };
}

test("integration: lists model + council tools over a real transport", async () => {
  const config = loadConfig({ MULTIPOLY_GLM_API_KEY: "dummy" });
  const conn = await connect(config);
  try {
    const { tools } = await conn.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), BUILTIN_TOOL_NAMES);
  } finally {
    await conn.close();
  }
});

test("integration: invalid tool arguments return an INVALID_INPUT error envelope", async () => {
  const config = loadConfig({ MULTIPOLY_GLM_API_KEY: "dummy" });
  const conn = await connect(config);
  try {
    // diff_base AND paths together is mutually exclusive — rejected by the
    // validator before any model/network work, so this needs no upstream.
    const res = await conn.client.callTool({
      name: "glm_review",
      arguments: { diff_base: "main", paths: ["x"] },
    });
    assert.equal(res.isError, true);
    const text = res.content.map((c) => c.text).join("");
    assert.match(text, /INVALID_INPUT/);
    assert.match(text, /exactly one of/i);
  } finally {
    await conn.close();
  }
});

test("integration: an unknown tool name is a protocol error", async () => {
  const config = loadConfig({ MULTIPOLY_GLM_API_KEY: "dummy" });
  const conn = await connect(config);
  try {
    await assert.rejects(() => conn.client.callTool({ name: "bogus_review", arguments: { paths: ["x"] } }));
  } finally {
    await conn.close();
  }
});

test("surface: tools, handlers, and keySpec cover exactly the same tool names (no drift)", () => {
  const { tools, handlers, toolKeySpec } = buildServerSurface();
  const toolNames = tools.map((t) => t.name).sort();
  assert.deepEqual(Object.keys(handlers).sort(), toolNames);
  assert.deepEqual(Object.keys(toolKeySpec).sort(), toolNames);
});

test("surface: every advertised schema's keys equal its validator key set", () => {
  const { tools, toolKeySpec } = buildServerSurface();
  for (const tool of tools) {
    const schemaKeys = Object.keys(tool.inputSchema.properties).sort();
    const allowed = [...(toolKeySpec[tool.name] ?? [])].sort();
    assert.deepEqual(schemaKeys, allowed, tool.name);
  }
});

// ── Task 11: per-call reasoning_effort tool argument ──────────────────────────

test("schema: glm_review has reasoning_effort with correct enum; composer_review does not", () => {
  const { tools } = buildServerSurface();
  const glmReview = tools.find((t) => t.name === "glm_review");
  const composerReview = tools.find((t) => t.name === "composer_review");
  assert.ok(glmReview, "glm_review not found");
  assert.ok(composerReview, "composer_review not found");
  // GLM has reasoning control — must expose reasoning_effort
  assert.ok("reasoning_effort" in glmReview.inputSchema.properties, "glm_review missing reasoning_effort");
  const re = glmReview.inputSchema.properties.reasoning_effort;
  assert.equal(re.type, "string");
  assert.deepEqual(re.enum, ["off", "low", "medium", "high", "xhigh"]);
  // Composer has NONE capability — must NOT expose reasoning_effort
  assert.ok(!("reasoning_effort" in composerReview.inputSchema.properties), "composer_review should not have reasoning_effort");
});

test("schema: glm_consult has reasoning_effort; composer_consult does not", () => {
  const { tools } = buildServerSurface();
  const glmConsult = tools.find((t) => t.name === "glm_consult");
  const composerConsult = tools.find((t) => t.name === "composer_consult");
  assert.ok("reasoning_effort" in glmConsult.inputSchema.properties, "glm_consult missing reasoning_effort");
  assert.ok(!("reasoning_effort" in composerConsult.inputSchema.properties), "composer_consult should not have reasoning_effort");
});

test("schema: council_review and council_consult have reasoning_effort", () => {
  const { tools } = buildServerSurface();
  const councilReview = tools.find((t) => t.name === "council_review");
  const councilConsult = tools.find((t) => t.name === "council_consult");
  assert.ok("reasoning_effort" in councilReview.inputSchema.properties, "council_review missing reasoning_effort");
  assert.ok("reasoning_effort" in councilConsult.inputSchema.properties, "council_consult missing reasoning_effort");
});

test("integration: glm_review accepts reasoning_effort:'low' (validates without error)", async () => {
  const config = loadConfig({ MULTIPOLY_GLM_API_KEY: "dummy" });
  const conn = await connect(config);
  try {
    // diff_base AND paths together → INVALID_INPUT before reasoning_effort check,
    // so use only the reasoning_effort-related rejection path by sending a bad value.
    // For the "accepted" case we can't actually call the model, but the validator
    // must NOT reject reasoning_effort:'low' as an unknown key.  We confirm by
    // sending a known-bad combo that fails on the mutual-exclusion rule, not the
    // key validator — meaning the key was accepted.
    // Actually, test that unknown key "turbo" is rejected, and valid key is not.
    // Send a minimally valid review input with reasoning_effort:'low' → should fail
    // on model-call (no real API) but NOT on validation (INVALID_INPUT).
    // We check the rejection is NOT about reasoning_effort being unknown/invalid.
    const res = await conn.client.callTool({
      name: "glm_review",
      arguments: { diff_base: "main", reasoning_effort: "low" },
    });
    // May be an error (model not reachable) but must NOT be about reasoning_effort validation
    const text = res.content.map((c) => c.text).join("");
    assert.ok(!text.includes("unknown argument 'reasoning_effort'"), `should not reject reasoning_effort as unknown: ${text}`);
    assert.ok(!text.includes("reasoning effort must be"), `should not reject 'low' as invalid: ${text}`);
  } finally {
    await conn.close();
  }
});

test("integration: glm_review rejects invalid reasoning_effort value 'turbo'", async () => {
  const config = loadConfig({ MULTIPOLY_GLM_API_KEY: "dummy" });
  const conn = await connect(config);
  try {
    const res = await conn.client.callTool({
      name: "glm_review",
      arguments: { diff_base: "main", reasoning_effort: "turbo" },
    });
    assert.equal(res.isError, true);
    const text = res.content.map((c) => c.text).join("");
    assert.match(text, /INVALID_INPUT/);
    assert.match(text, /reasoning_effort/i);
  } finally {
    await conn.close();
  }
});

test("integration: composer_review rejects reasoning_effort argument (unknown key for NONE model)", async () => {
  const config = loadConfig({ MULTIPOLY_COMPOSER_ENABLED: "1" });
  const conn = await connect(config);
  try {
    const res = await conn.client.callTool({
      name: "composer_review",
      arguments: { diff_base: "main", reasoning_effort: "low" },
    });
    assert.equal(res.isError, true);
    const text = res.content.map((c) => c.text).join("");
    assert.match(text, /INVALID_INPUT/);
  } finally {
    await conn.close();
  }
});

test("integration: council_review accepts reasoning_effort:'low' (not an unknown-key error)", async () => {
  const config = loadConfig({ MULTIPOLY_GLM_API_KEY: "dummy" });
  const conn = await connect(config);
  try {
    const res = await conn.client.callTool({
      name: "council_review",
      arguments: { diff_base: "main", models: ["glm", "glm"], reasoning_effort: "low" },
    });
    const text = res.content.map((c) => c.text).join("");
    assert.ok(!text.includes("unknown argument 'reasoning_effort'"), `should not reject reasoning_effort: ${text}`);
    assert.ok(!text.includes("reasoning effort must be"), `should not reject 'low' value: ${text}`);
  } finally {
    await conn.close();
  }
});

// ── Alias-tool end-to-end seam: loadConfig → registryFromConfig → buildServerSurface ──

test("integration: opus alias tools present with correct handler identity and claude reasoning schema (real config path)", () => {
  // Build config via the real loadConfig path: claude is promoted with anthropic transport.
  // MULTIPOLY_CLAUDE_TRANSPORT=anthropic is set explicitly so the transport-flip
  // default log doesn't depend on which Anthropic env vars are set in CI.
  const config = loadConfig({
    MULTIPOLY_MODELS: "claude",
    MULTIPOLY_CLAUDE_TRANSPORT: "anthropic",
    MULTIPOLY_CLAUDE_API_KEY: "x",
    MULTIPOLY_GLM_API_KEY: "y",
  });

  // Derive the surface the same way createServer does.
  const surface = buildServerSurface(registryFromConfig(config));

  // opus_review and opus_consult must be present (alias tools for claude).
  const toolNames = surface.tools.map((t) => t.name);
  assert.ok(toolNames.includes("opus_review"), "opus_review must be present");
  assert.ok(toolNames.includes("opus_consult"), "opus_consult must be present");

  // Handler identity: alias routes to the same function as the canonical tool.
  assert.strictEqual(
    surface.handlers["opus_review"],
    surface.handlers["claude_review"],
    "opus_review handler must be identical to claude_review handler",
  );
  assert.strictEqual(
    surface.handlers["opus_consult"],
    surface.handlers["claude_consult"],
    "opus_consult handler must be identical to claude_consult handler",
  );

  // claude is reasoning-capable (anthropic_effort) — schema must include reasoning_effort.
  const claudeReview = surface.tools.find((t) => t.name === "claude_review");
  assert.ok(claudeReview, "claude_review tool must exist");
  assert.ok(
    "reasoning_effort" in claudeReview.inputSchema.properties,
    "claude_review schema must include reasoning_effort (claude is anthropic_effort capable)",
  );
});
