import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFORT_LEVELS, EFFORT_ORDER, normalizeEffort } from "../scripts/lib/reasoning.mjs";
import { thinkingToEffort } from "../scripts/lib/reasoning.mjs";
import { resolveReasoningEffort } from "../scripts/lib/reasoning.mjs";
import { CAPABILITY, effortToGlmThinking, effortToOpenAiFields, effortToAnthropicEffort,
  effortToAnthropicBudget, effortToKimiThinking, effortToQwenFields, effortToCliReasoningArgs } from "../scripts/lib/reasoning.mjs";

test("reasoning: levels + ordering", () => {
  assert.deepEqual(EFFORT_LEVELS, ["off", "low", "medium", "high", "xhigh"]);
  assert.ok(EFFORT_ORDER.high > EFFORT_ORDER.low);
});
test("reasoning: normalizeEffort", () => {
  assert.equal(normalizeEffort("HIGH"), "high");
  assert.equal(normalizeEffort("  off "), "off");
  assert.equal(normalizeEffort("inherit"), "inherit");
  assert.equal(normalizeEffort(""), "inherit");
  assert.equal(normalizeEffort(undefined), "inherit");
  assert.throws(() => normalizeEffort("turbo"), (e) => e.code === "CONFIG");
});
test("reasoning: legacy thinking → effort (all synonyms)", () => {
  for (const on of ["on", "1", "true", "yes", "ON"]) assert.equal(thinkingToEffort(on), "medium");
  for (const off of ["off", "0", "false", "no"]) assert.equal(thinkingToEffort(off), "off");
  assert.equal(thinkingToEffort("auto"), "inherit");
  assert.equal(thinkingToEffort(undefined), "inherit");
  assert.equal(thinkingToEffort(""), "inherit");
  assert.throws(() => thinkingToEffort("maybe"), (e) => e.code === "CONFIG");
});
const L = (o) => ({ perCall: undefined, modelEffort: "inherit", modelThinking: "inherit", serverEffort: "inherit", serverThinking: "inherit", bakedDefault: "high", ...o });
test("resolve: per-call wins", () => assert.equal(resolveReasoningEffort(L({ perCall: "low", modelEffort: "xhigh" })), "low"));
test("resolve: per-model effort > server effort", () => assert.equal(resolveReasoningEffort(L({ modelEffort: "medium", serverEffort: "high" })), "medium"));
test("resolve: per-model effort > per-model thinking", () => assert.equal(resolveReasoningEffort(L({ modelEffort: "low", modelThinking: "off" })), "low"));
test("resolve: server effort > server thinking", () => assert.equal(resolveReasoningEffort(L({ serverEffort: "low", serverThinking: "off" })), "low"));
test("resolve: all inherit → default", () => assert.equal(resolveReasoningEffort(L({})), "high"));
test("resolve: per-call 'inherit' string falls through", () => assert.equal(resolveReasoningEffort(L({ perCall: "inherit", modelEffort: "low" })), "low"));
test("resolve: bad default throws", () => assert.throws(() => resolveReasoningEffort(L({ bakedDefault: "inherit" }))));
test("glm toggle", () => {
  assert.deepEqual(effortToGlmThinking("off"), { thinking: { type: "disabled" } });
  assert.deepEqual(effortToGlmThinking("high"), { thinking: { type: "enabled" } });
});
test("kimi toggle: never budget_tokens", () => {
  assert.deepEqual(effortToKimiThinking("high"), { thinking: { type: "enabled" } });
  assert.equal("budget_tokens" in (effortToKimiThinking("high").thinking), false);
});
test("openai fields: deepseek high/max, gemini none..high, off varies", () => {
  assert.equal(effortToOpenAiFields("xhigh", { vocab: "deepseek" }).reasoning_effort, "max");
  assert.equal(effortToOpenAiFields("low", { vocab: "deepseek" }).reasoning_effort, "high");
  assert.deepEqual(effortToOpenAiFields("off", { vocab: "deepseek" }), { thinking: { type: "disabled" } }); // flattened, top-level
  assert.equal(effortToOpenAiFields("medium", { vocab: "gemini" }).reasoning_effort, "medium");
  assert.equal(effortToOpenAiFields("xhigh", { vocab: "gemini" }).reasoning_effort, "high");
  assert.equal(effortToOpenAiFields("off", { vocab: "gemini" }).reasoning_effort, "minimal"); // Gemini-3 can't fully disable (spec §2)
});
test("qwen fields: enable_thinking always true (thinking-only), budget scales", () => {
  const off = effortToQwenFields("off", { maxTokens: 20000 });
  assert.equal(off.enable_thinking, true);
  assert.ok(effortToQwenFields("high", { maxTokens: 20000 }).thinking_budget > off.thinking_budget);
});
test("anthropic effort (Opus 4.7)", () => {
  assert.equal(effortToAnthropicEffort("off"), null);
  assert.deepEqual(effortToAnthropicEffort("xhigh"), { thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } });
});
test("anthropic budget (legacy): clamp + skip", () => {
  assert.equal(effortToAnthropicBudget("high", { maxTokens: 1200 }), null); // no room
  const r = effortToAnthropicBudget("high", { maxTokens: 20000 });
  assert.ok(r.thinking.budget_tokens >= 1024 && r.thinking.budget_tokens < 20000);
});
test("cli args: codex clamps xhigh→high, off→none, other kinds →[]", () => {
  assert.deepEqual(effortToCliReasoningArgs("codex", "high"), ["-c", 'model_reasoning_effort="high"']);
  assert.deepEqual(effortToCliReasoningArgs("codex", "xhigh"), ["-c", 'model_reasoning_effort="high"']);
  assert.deepEqual(effortToCliReasoningArgs("codex", "off"), []);
  assert.deepEqual(effortToCliReasoningArgs("agy", "high"), []);
});

// --- Contract enforcement: adapters must receive a resolved concrete effort level ---
test("adapters reject 'inherit': effortToGlmThinking", () => {
  assert.throws(() => effortToGlmThinking("inherit"), (e) => e instanceof Error && e.code === "INTERNAL");
  assert.throws(() => effortToGlmThinking("turbo"),   (e) => e instanceof Error && e.code === "INTERNAL");
});
test("adapters reject 'inherit': effortToKimiThinking", () => {
  assert.throws(() => effortToKimiThinking("inherit"), (e) => e instanceof Error && e.code === "INTERNAL");
  assert.throws(() => effortToKimiThinking("turbo"),   (e) => e instanceof Error && e.code === "INTERNAL");
});
test("adapters reject 'inherit': effortToOpenAiFields", () => {
  assert.throws(() => effortToOpenAiFields("inherit", { vocab: "gemini" }), (e) => e instanceof Error && e.code === "INTERNAL");
  assert.throws(() => effortToOpenAiFields("turbo",   { vocab: "gemini" }), (e) => e instanceof Error && e.code === "INTERNAL");
});
test("adapters reject 'inherit': effortToAnthropicEffort", () => {
  assert.throws(() => effortToAnthropicEffort("inherit"), (e) => e instanceof Error && e.code === "INTERNAL");
  assert.throws(() => effortToAnthropicEffort("turbo"),   (e) => e instanceof Error && e.code === "INTERNAL");
});
test("adapters reject 'inherit': effortToAnthropicBudget", () => {
  assert.throws(() => effortToAnthropicBudget("inherit", { maxTokens: 20000 }), (e) => e instanceof Error && e.code === "INTERNAL");
  assert.throws(() => effortToAnthropicBudget("turbo",   { maxTokens: 20000 }), (e) => e instanceof Error && e.code === "INTERNAL");
});
test("adapters reject 'inherit': effortToQwenFields", () => {
  assert.throws(() => effortToQwenFields("inherit", { maxTokens: 20000 }), (e) => e instanceof Error && e.code === "INTERNAL");
  assert.throws(() => effortToQwenFields("turbo",   { maxTokens: 20000 }), (e) => e instanceof Error && e.code === "INTERNAL");
});
test("adapters reject 'inherit': effortToCliReasoningArgs", () => {
  assert.throws(() => effortToCliReasoningArgs("codex", "inherit"), (e) => e instanceof Error && e.code === "INTERNAL");
  assert.throws(() => effortToCliReasoningArgs("codex", "turbo"),   (e) => e instanceof Error && e.code === "INTERNAL");
});
