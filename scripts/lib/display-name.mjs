// scripts/lib/display-name.mjs
// The display-name convention: "<model base> (<agent-or-transport>)".
// Transport+cliKind decide the suffix; the base name is per-model.

export function transportSuffix(transport, cliKind) {
  if (transport === "cli") return `${cliKind ?? "cli"} cli`;
  // anthropic + http are both network APIs from the caller's perspective.
  return "api";
}

export function computeDisplayName(baseName, transport, cliKind) {
  return `${baseName} (${transportSuffix(transport, cliKind)})`;
}
