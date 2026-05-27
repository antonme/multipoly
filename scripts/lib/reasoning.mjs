// scripts/lib/reasoning.mjs
import { MultipolyError } from "./errors.mjs";

export const EFFORT_LEVELS = Object.freeze(["off", "low", "medium", "high", "xhigh"]);
export const EFFORT_ORDER = Object.freeze(Object.fromEntries(EFFORT_LEVELS.map((l, i) => [l, i])));

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

export function resolveReasoningEffort({ perCall, modelEffort, modelThinking, serverEffort, serverThinking, bakedDefault }) {
  const chain = [perCall, modelEffort, modelThinking, serverEffort, serverThinking].map(normalizeEffort);
  for (const lvl of chain) if (lvl !== "inherit") return lvl;
  if (!EFFORT_LEVELS.includes(bakedDefault)) {
    throw new MultipolyError("INTERNAL", `baked default effort must be a concrete level, got ${JSON.stringify(bakedDefault)}`);
  }
  return bakedDefault;
}
