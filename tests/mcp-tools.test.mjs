import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTools, buildToolKeySpec, buildServerSurface } from "../scripts/multipoly-mcp.mjs";
import { SYNTHESIZER_CHOICES } from "../scripts/lib/config.mjs";
import { MODEL_KEYS } from "../scripts/lib/models.mjs";

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
      glm: { key: "glm", displayName: "glm-5.1 (api)" },
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
  // buildToolKeySpec is now dynamic so it can cover custom + opus models;
  // for the builtin-only test suite we pass MODEL_KEYS.
  const keySpec = buildToolKeySpec(MODEL_KEYS);
  for (const tool of buildTools()) {
    const schemaKeys = Object.keys(tool.inputSchema.properties).sort();
    const allowedKeys = [...keySpec[tool.name] ?? []].sort();
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

test("opus_* alias tools appear only when claude is registered, routed to claude handler", () => {
  const registryWithClaude = {
    keys: ["glm", "claude"],
    info: { glm: { key: "glm", displayName: "glm-5.1 (api)", reasoning: "http_thinking_toggle" },
            claude: { key: "claude", displayName: "opus (claude cli)", reasoning: "anthropic_effort" } },
  };
  const tools = buildTools(registryWithClaude).map((t) => t.name);
  assert.ok(tools.includes("opus_review"));
  assert.ok(tools.includes("opus_consult"));

  const noClaude = { keys: ["glm"], info: { glm: { key: "glm", displayName: "glm-5.1 (api)", reasoning: "http_thinking_toggle" } } };
  const tools2 = buildTools(noClaude).map((t) => t.name);
  assert.ok(!tools2.includes("opus_review"));
});

test("alias tool schema matches its canonical tool's schema", () => {
  const reg = { keys: ["claude"], info: { claude: { key: "claude", displayName: "opus (claude cli)", reasoning: "anthropic_effort" } } };
  const tools = Object.fromEntries(buildTools(reg).map((t) => [t.name, t]));
  assert.deepEqual(tools["opus_review"].inputSchema, tools["claude_review"].inputSchema);
});

test("opus_*/gpt55_* alias handlers are the SAME function as their canonical handlers", () => {
  const reg = {
    keys: ["claude", "codex"],
    info: {
      claude: { key: "claude", displayName: "opus (claude cli)", reasoning: "anthropic_effort" },
      codex: { key: "codex", displayName: "gpt5.5 (codex cli)", reasoning: "openai_effort" },
    },
  };
  const surf = buildServerSurface(reg);
  assert.strictEqual(surf.handlers["opus_review"], surf.handlers["claude_review"]);
  assert.strictEqual(surf.handlers["opus_consult"], surf.handlers["claude_consult"]);
  assert.strictEqual(surf.handlers["gpt55_review"], surf.handlers["codex_review"]);
  assert.strictEqual(surf.handlers["gpt55_consult"], surf.handlers["codex_consult"]);
});

test("gpt55_* alias tools appear only when codex is registered, schema matches codex schema", () => {
  const registryWithCodex = {
    keys: ["glm", "codex"],
    info: {
      glm: { key: "glm", displayName: "glm-5.1 (api)", reasoning: "http_thinking_toggle" },
      codex: { key: "codex", displayName: "gpt5.5 (codex cli)", reasoning: "openai_effort" },
    },
  };
  const tools = buildTools(registryWithCodex).map((t) => t.name);
  assert.ok(tools.includes("gpt55_review"));
  assert.ok(tools.includes("gpt55_consult"));

  const noCodex = { keys: ["glm"], info: { glm: { key: "glm", displayName: "glm-5.1 (api)", reasoning: "http_thinking_toggle" } } };
  const tools2 = buildTools(noCodex).map((t) => t.name);
  assert.ok(!tools2.includes("gpt55_review"));

  // Schema parity: alias inputSchema deepEquals canonical inputSchema.
  const allTools = Object.fromEntries(buildTools(registryWithCodex).map((t) => [t.name, t]));
  assert.deepEqual(allTools["gpt55_review"].inputSchema, allTools["codex_review"].inputSchema);
});

// ── Task D1/3b: compact key on council tools ──────────────────────────────────

test("mcp tools: council_review and council_consult advertise compact boolean property", () => {
  for (const toolName of ["council_review", "council_consult"]) {
    const tool = buildTools().find((t) => t.name === toolName);
    assert.ok(tool, `${toolName} must exist`);
    const compactProp = tool.inputSchema.properties.compact;
    assert.ok(compactProp, `${toolName} must have a compact property`);
    assert.equal(compactProp.type, "boolean", `${toolName}.compact must be boolean`);
  }
});

test("mcp tools: compact is in council tool allowedKeys, not in per-model tool allowedKeys", () => {
  const keySpec = buildToolKeySpec(MODEL_KEYS);
  // Council tools allow compact
  assert.ok(keySpec["council_review"].has("compact"), "council_review must allow compact");
  assert.ok(keySpec["council_consult"].has("compact"), "council_consult must allow compact");
  // Per-model tools do not allow compact
  assert.equal(keySpec["glm_review"].has("compact"), false, "glm_review must not allow compact");
  assert.equal(keySpec["qwen_consult"].has("compact"), false, "qwen_consult must not allow compact");
});

test("mcp tools: advertised schema keys match the hand-rolled validator key sets after adding compact", () => {
  // Re-run the anti-drift guard to ensure compact stays in sync.
  const keySpec = buildToolKeySpec(MODEL_KEYS);
  for (const tool of buildTools()) {
    const schemaKeys = Object.keys(tool.inputSchema.properties).sort();
    const allowedKeys = [...keySpec[tool.name] ?? []].sort();
    assert.deepEqual(schemaKeys, allowedKeys, `schema/keySpec drift on ${tool.name}`);
  }
});
