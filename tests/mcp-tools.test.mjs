import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTools, TOOL_KEY_SPEC } from "../scripts/multipoly-mcp.mjs";
import { SYNTHESIZER_CHOICES } from "../scripts/lib/config.mjs";

test("mcp tools: exposes model-specific review and consult tools plus council tools", () => {
  const names = buildTools().map((t) => t.name).sort();
  assert.deepEqual(names, [
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
  ]);
});

test("mcp tools: buildTools exposes tools and enums for env-defined custom models", () => {
  const registry = {
    keys: ["glm", "kimi"],
    info: {
      glm: { key: "glm", displayName: "GLM 5.1" },
      kimi: { key: "kimi", displayName: "Kimi K2" },
    },
  };
  const tools = buildTools(registry);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("kimi_review"));
  assert.ok(names.includes("kimi_consult"));
  assert.equal(names.includes("qwen_review"), false); // qwen not in this registry
  const council = tools.find((t) => t.name === "council_review");
  assert.ok(council.inputSchema.properties.models.items.enum.includes("kimi"));
  assert.ok(council.inputSchema.properties.synthesizer.enum.includes("kimi"));
  assert.ok(council.inputSchema.properties.synthesizer.enum.includes("harness"));
});

test("mcp tools: council synthesizer enum lists model keys plus harness sentinels", () => {
  for (const name of ["council_review", "council_consult"]) {
    const tool = buildTools().find((t) => t.name === name);
    const enumVals = tool.inputSchema.properties.synthesizer.enum;
    assert.deepEqual([...enumVals].sort(), [...SYNTHESIZER_CHOICES].sort(), name);
  }
});

test("mcp tools: advertised schema keys match the hand-rolled validator key sets", () => {
  // Guards against the advertised inputSchema and the runtime validator drifting.
  for (const tool of buildTools()) {
    const schemaKeys = Object.keys(tool.inputSchema.properties).sort();
    const allowedKeys = [...TOOL_KEY_SPEC[tool.name]].sort();
    assert.deepEqual(schemaKeys, allowedKeys, tool.name);
  }
});

test("mcp tools: review descriptions state diff_base/paths exclusivity", () => {
  for (const tool of buildTools().filter((t) => t.name.endsWith("_review"))) {
    assert.match(tool.description, /exactly one of/i, tool.name);
    assert.match(tool.description, /diff_base/i, tool.name);
    assert.match(tool.description, /paths/i, tool.name);
  }
});
