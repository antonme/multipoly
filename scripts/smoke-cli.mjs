// Gated live smoke test for the cli transport (Task 7). Spawns each installed
// agent read-only with a trivial consult and reports pass/fail. NOT part of the
// test suite — run manually with explicit user go-ahead (consumes subscriptions).
import { runModel } from "./lib/run-model.mjs";

const PROMPT = "Reply with exactly this token and nothing else: SMOKE-OK";

const KINDS = [
  { kind: "claude", model: "haiku" },
  { kind: "codex", model: "gpt-5.5" },
  { kind: "cursor", model: "composer-2.5", authTokenEnv: "CURSOR_API_KEY" },
  { kind: "gemini", model: "gemini-2.5-flash" },
  { kind: "kimi", model: "kimi-code/kimi-for-coding" },
  { kind: "agy", model: null, unsafe: true },
];

function cfg(spec) {
  return {
    models: {
      m: {
        key: "m",
        displayName: spec.kind,
        transport: "cli",
        cliKind: spec.kind,
        binary: spec.binary ?? null,
        model: spec.model,
        authTokenEnv: spec.authTokenEnv ?? null,
        cwdMode: "temp",
        unsafe: spec.unsafe ?? false,
        reasoningEffort: null,
        timeoutMs: 120000,
        configured: true,
        supportsThinking: false,
        maxTokens: { review: undefined, consult: undefined },
      },
    },
    timeoutMs: 120000,
  };
}

const only = new Set(process.argv.slice(2));
const selected = only.size ? KINDS.filter((k) => only.has(k.kind)) : KINDS;
for (const spec of selected) {
  const t0 = Date.now();
  process.stdout.write(`\n=== ${spec.kind} (model=${spec.model ?? "—"}) ===\n`);
  try {
    const out = await runModel({
      config: cfg(spec),
      modelKey: "m",
      messages: [{ role: "user", content: PROMPT }],
      mode: "consult",
      env: process.env,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const body = (out.content || "").trim().replace(/\s+/g, " ").slice(0, 200);
    const ok = /SMOKE-OK/.test(out.content || "");
    process.stdout.write(`${ok ? "PASS" : "RAN (no token match)"} in ${secs}s — "${body}"\n`);
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`FAIL in ${secs}s — [${e.code ?? "ERR"}] ${(e.message || String(e)).slice(0, 300)}\n`);
  }
}
process.stdout.write("\n=== smoke complete ===\n");
