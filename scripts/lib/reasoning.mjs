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
