import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTools } from "../scripts/multipoly-mcp.mjs";

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
