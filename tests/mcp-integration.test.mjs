import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, buildServerSurface } from "../scripts/multipoly-mcp.mjs";
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
