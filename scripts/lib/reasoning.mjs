// scripts/lib/reasoning.mjs
import { MultipolyError } from "./errors.mjs";

export const EFFORT_LEVELS = Object.freeze(["off", "low", "medium", "high", "xhigh"]);
export const EFFORT_ORDER = Object.freeze(Object.fromEntries(EFFORT_LEVELS.map((l, i) => [l, i])));

/** Guard: all adapter functions require a resolved, concrete effort level (one of EFFORT_LEVELS). */
function assertConcreteEffort(e) {
  if (!EFFORT_LEVELS.includes(e))
    throw new MultipolyError("INTERNAL", `reasoning adapter requires a resolved effort level, got ${JSON.stringify(e)}`);
}

export function normalizeEffort(raw) {
  if (raw === undefined || raw === null) return "inherit";
  const v = String(raw).trim().toLowerCase();
  if (v === "" || v === "inherit") return "inherit";
  if (EFFORT_LEVELS.includes(v)) return v;
  throw new MultipolyError("CONFIG", `reasoning effort must be one of ${EFFORT_LEVELS.join("|")}|inherit, got ${JSON.stringify(raw)}`);
}

const THINK_ON = new Set(["on", "1", "true", "yes"]);
const THINK_OFF = new Set(["off", "0", "false", "no"]);
export function thinkingToEffort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return "inherit";
  const v = String(raw).trim().toLowerCase();
  if (v === "auto") return "inherit";
  if (THINK_ON.has(v)) return "medium";
  if (THINK_OFF.has(v)) return "off";
  throw new MultipolyError("CONFIG", `thinking must be on|off|auto (or 1/0/true/false/yes/no), got ${JSON.stringify(raw)}`);
}

export const CAPABILITY = Object.freeze({
  NONE: "none", GLM_TOGGLE: "http_thinking_toggle", QWEN_BUDGET: "qwen_budget",
  OPENAI_EFFORT: "openai_effort", ANTHROPIC_EFFORT: "anthropic_effort",
  ANTHROPIC_BUDGET: "anthropic_budget", KIMI_TOGGLE: "kimi_toggle",
});
const MIN_THINKING_BUDGET = 1024, MIN_OUTPUT_RESERVE = 1024;
const BUDGET_FRACTION = Object.freeze({ low: 0.25, medium: 0.4, high: 0.6, xhigh: 0.8 });

export function effortToGlmThinking(e) { assertConcreteEffort(e); return { thinking: { type: e === "off" ? "disabled" : "enabled" } }; }
export function effortToKimiThinking(e) { assertConcreteEffort(e); return { thinking: { type: e === "off" ? "disabled" : "enabled" } }; }

export function effortToOpenAiFields(e, { vocab }) {
  assertConcreteEffort(e);
  if (e === "off") {
    if (vocab === "deepseek") return { thinking: { type: "disabled" } }; // top-level (raw fetch)
    return { reasoning_effort: "minimal" }; // gemini etc. cannot fully disable
  }
  if (vocab === "deepseek") return { reasoning_effort: e === "xhigh" ? "max" : "high" };
  // Non-deepseek vocab (gemini, generic): uses OpenAI reasoning_effort (none..high) intentionally.
  return { reasoning_effort: e === "xhigh" ? "high" : e }; // gemini/generic top at high
}

export function effortToAnthropicEffort(e) {
  assertConcreteEffort(e);
  return e === "off" ? null : { thinking: { type: "adaptive" }, output_config: { effort: e } };
}

export function effortToAnthropicBudget(e, { maxTokens }) {
  assertConcreteEffort(e);
  if (e === "off" || maxTokens === undefined) return null;
  if (maxTokens < MIN_THINKING_BUDGET + MIN_OUTPUT_RESERVE) return null;
  const raw = Math.round(BUDGET_FRACTION[e] * maxTokens);
  const budget = Math.min(Math.max(raw, MIN_THINKING_BUDGET), maxTokens - MIN_OUTPUT_RESERVE);
  return { thinking: { type: "enabled", budget_tokens: budget } };
}

export function effortToQwenFields(e, { maxTokens }) {
  assertConcreteEffort(e);
  const cap = maxTokens ?? 16384;
  const frac = e === "off" ? 0.1 : BUDGET_FRACTION[e];
  return { enable_thinking: true, thinking_budget: Math.max(256, Math.round(frac * cap)) };
}

const CODEX_EFFORTS = new Set(["low", "medium", "high"]);
export function effortToCliReasoningArgs(kind, e) {
  assertConcreteEffort(e);
  if (e === "off") return [];
  if (kind === "codex") { const v = CODEX_EFFORTS.has(e) ? e : "high"; return ["-c", `model_reasoning_effort="${v}"`]; }
  return []; // claude/gemini/cursor/agy: verify real flag before wiring (Task 10 note)
}

export function resolveReasoningEffort({ perCall, modelEffort, modelThinking, serverEffort, serverThinking, bakedDefault }) {
  const chain = [perCall, modelEffort, modelThinking, serverEffort, serverThinking].map(normalizeEffort);
  for (const lvl of chain) if (lvl !== "inherit") return lvl;
  if (!EFFORT_LEVELS.includes(bakedDefault)) {
    throw new MultipolyError("INTERNAL", `baked default effort must be a concrete level, got ${JSON.stringify(bakedDefault)}`);
  }
  return bakedDefault;
}
