import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { runModel } from "../scripts/lib/run-model.mjs";
import { buildInvocation } from "../scripts/lib/transport/cli.mjs";

// Build a config whose single model uses the cli transport for `kind`.
function cliConfig(kind, overrides = {}) {
  return {
    models: {
      m: {
        key: "m",
        displayName: kind,
        transport: "cli",
        cliKind: kind,
        binary: overrides.binary ?? null, // null → default per kind
        model: overrides.model ?? "the-model",
        authTokenEnv: overrides.authTokenEnv ?? null,
        cwdMode: overrides.cwdMode ?? "repo",
        unsafe: overrides.unsafe ?? false,
        reasoningEffort: overrides.reasoningEffort ?? null,
        timeoutMs: overrides.timeoutMs ?? null,
        configured: true,
        supportsThinking: false,
        maxTokens: { review: undefined, consult: undefined },
      },
    },
    timeoutMs: 5000,
  };
}

// A fake execFile that records the invocation and returns canned stdout.
// For codex it also writes the --output-last-message file so the runner can
// read the final message from there (mirrors the real codex contract).
function fakeExec(stdout, capture, { lastMessageContent } = {}) {
  return (file, args, opts) => {
    capture.push({ file, args, opts });
    if (lastMessageContent !== undefined) {
      const i = args.indexOf("--output-last-message");
      if (i >= 0 && args[i + 1]) writeFileSync(args[i + 1], lastMessageContent);
    }
    return stdout;
  };
}

const messages = [
  { role: "system", content: "You are a reviewer." },
  { role: "user", content: "Review this." },
];

test("cli: claude — read-only + MCP-isolated argv, prompt on stdin", async () => {
  const cap = [];
  const out = await runModel({
    config: cliConfig("claude"),
    modelKey: "m",
    messages,
    mode: "consult",
    execFileImpl: fakeExec("claude says hi", cap),
    env: {},
  });
  assert.equal(out.content, "claude says hi");
  assert.equal(out.reasoning, null);
  assert.equal(out.usage, null);
  assert.equal(out.fellBackFromJsonSchema, false);
  const { file, args, opts } = cap[0];
  assert.equal(file, "claude");
  assert.ok(args.includes("-p"));
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "the-model"]);
  assert.ok(args.includes("--tools")); // followed by "" (read-only)
  assert.ok(args.includes("--strict-mcp-config")); // isolation, no user MCP
  assert.ok(opts.input.includes("You are a reviewer."));
  assert.ok(opts.input.includes("Review this."));
});

test("cli: codex — sandbox read-only, output-last-message file, stdin via '-', CODEX_HOME isolation", async () => {
  const cap = [];
  const out = await runModel({
    config: cliConfig("codex", { reasoningEffort: "high" }),
    modelKey: "m",
    messages,
    mode: "consult",
    execFileImpl: fakeExec("", cap, { lastMessageContent: "codex final answer" }),
    env: {},
  });
  assert.equal(out.content, "codex final answer");
  const { file, args, opts } = cap[0];
  assert.equal(file, "codex");
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--sandbox"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.equal(args[args.length - 1], "-"); // stdin marker last
  assert.ok(args.includes("--output-last-message"));
  // reasoning effort threads through as a -c override
  assert.ok(args.some((a) => /model_reasoning_effort="high"/.test(a)));
  // CODEX_HOME points somewhere isolated (not the user's ~/.codex)
  assert.ok(opts.env.CODEX_HOME && opts.env.CODEX_HOME.length > 0);
  assert.ok(opts.input.includes("Review this."));
});

test("cli: cursor — prompt delivered by file + positional, stdin empty, plan mode", async () => {
  const cap = [];
  // The prompt file lives in a per-call scratch dir that is cleaned up after
  // the call, so read its content DURING exec (as real cursor would).
  let promptFileContent = null;
  const exec = (file, args, opts) => {
    cap.push({ file, args, opts });
    const positional = args[args.length - 1];
    const m = positional.match(/Read (\S+)/);
    if (m) promptFileContent = readFileSync(m[1], "utf8");
    return "cursor output";
  };
  const out = await runModel({
    config: cliConfig("cursor", { authTokenEnv: "CURSOR_API_KEY" }),
    modelKey: "m",
    messages,
    mode: "consult",
    execFileImpl: exec,
    env: { CURSOR_API_KEY: "ck" },
  });
  assert.equal(out.content, "cursor output");
  const { file, args, opts } = cap[0];
  assert.equal(file, "cursor-agent"); // default binary for cursor
  assert.ok(args.includes("--mode"));
  assert.equal(args[args.indexOf("--mode") + 1], "plan");
  assert.equal(opts.input, ""); // cursor ignores stdin
  assert.ok(promptFileContent && promptFileContent.includes("Review this."));
});

test("cli: cursor — missing auth token env fails fast before spawning", async () => {
  const cap = [];
  await assert.rejects(
    () =>
      runModel({
        config: cliConfig("cursor", { authTokenEnv: "CURSOR_API_KEY" }),
        modelKey: "m",
        messages,
        mode: "consult",
        execFileImpl: fakeExec("x", cap),
        env: {}, // CURSOR_API_KEY absent
      }),
    (e) => e.code === "CONFIG" && /CURSOR_API_KEY/.test(e.message),
  );
  assert.equal(cap.length, 0, "must not spawn when auth env is missing");
});

test("cli: gemini — plan approval mode + workspace trust env", async () => {
  const cap = [];
  await runModel({
    config: cliConfig("gemini"),
    modelKey: "m",
    messages,
    mode: "consult",
    execFileImpl: fakeExec("gemini out", cap),
    env: {},
  });
  const { args, opts } = cap[0];
  assert.ok(args.includes("--approval-mode"));
  assert.equal(args[args.indexOf("--approval-mode") + 1], "plan");
  assert.equal(opts.env.GEMINI_CLI_TRUST_WORKSPACE, "true");
});

test("cli: gemini — overlarge argv prompt rejects with correct cap guidance", async () => {
  const cap = [];
  await assert.rejects(
    () =>
      runModel({
        config: cliConfig("gemini"),
        modelKey: "m",
        messages: [{ role: "user", content: "x".repeat(201_000) }],
        mode: "consult",
        execFileImpl: fakeExec("gemini out", cap),
        env: {},
      }),
    (e) =>
      e.code === "INVALID_INPUT" &&
      /lower MULTIPOLY_PER_FILE_CAP_BYTES/.test(e.message) &&
      !/raise MULTIPOLY_PER_FILE_CAP_BYTES/.test(e.message),
  );
  assert.equal(cap.length, 0, "must reject before spawning");
});

test("cli: agy — minimal flags, no --model, add-dir cwd", async () => {
  const cap = [];
  await runModel({
    config: cliConfig("agy", { unsafe: true }),
    modelKey: "m",
    messages,
    mode: "consult",
    execFileImpl: fakeExec("agy out", cap),
    env: {},
  });
  const { args } = cap[0];
  assert.ok(args.includes("--print"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("--add-dir"));
  assert.equal(args.includes("--model"), false);
});

test("cli: kimi — print + plan (read-only) + model, prompt on stdin (not argv)", async () => {
  const cap = [];
  await runModel({
    config: cliConfig("kimi"),
    modelKey: "m",
    messages,
    mode: "consult",
    execFileImpl: fakeExec("kimi out", cap),
    env: {},
  });
  const { args, opts } = cap[0];
  assert.ok(args.includes("--quiet")); // = --print --output-format text --final-message-only
  assert.ok(args.includes("--plan")); // mandatory read-only (--print implies --afk)
  assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2), ["-m", "the-model"]);
  // The prompt must NOT be in argv (leaks reviewed code / risks E2BIG).
  assert.equal(args.includes("--prompt"), false);
  assert.ok(opts.input.includes("Review this."));
});

test("cli: grok — read-only plan mode, prompt via file, plain output, prompt NOT in argv", async () => {
  const cap = [];
  // grok reads the prompt from --prompt-file (scratch dir, cleaned after the
  // call), so capture its content DURING exec like real grok would.
  let promptFileContent = null;
  const exec = (file, args, opts) => {
    cap.push({ file, args, opts });
    const i = args.indexOf("--prompt-file");
    if (i >= 0 && args[i + 1]) promptFileContent = readFileSync(args[i + 1], "utf8");
    return "grok output";
  };
  const out = await runModel({
    config: cliConfig("grok"),
    modelKey: "m",
    messages,
    mode: "consult",
    execFileImpl: exec,
    env: {},
  });
  assert.equal(out.content, "grok output");
  const { file, args, opts } = cap[0];
  assert.equal(file, "grok"); // default binary for grok
  assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2), ["-m", "the-model"]);
  assert.ok(args.includes("--permission-mode"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan"); // read-only
  assert.ok(args.includes("--no-memory")); // don't auto-load operator cross-session memory
  assert.deepEqual(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2), ["--output-format", "plain"]);
  assert.ok(args.includes("--prompt-file"));
  assert.equal(opts.input, ""); // prompt is in the file, not stdin
  // The prompt must NOT be on argv (leaks reviewed code / risks E2BIG on large reviews).
  assert.ok(!args.some((a) => a.includes("Review this.")));
  assert.ok(promptFileContent && promptFileContent.includes("Review this."));
});

test("cli: grok + xhigh effort → --effort xhigh in argv (xhigh native, no clamp)", () => {
  const { args } = buildInvocation({ kind: "grok", binary: "grok", model: "m", cwd: "/tmp", reasoningEffort: "xhigh", prompt: "p", scratch: scratch() });
  assert.ok(args.includes("--effort"), `expected --effort flag for grok: ${args.join(" ")}`);
  assert.equal(args[args.indexOf("--effort") + 1], "xhigh");
});

test("cli: grok + off effort → no --effort flag in argv", () => {
  const { args } = buildInvocation({ kind: "grok", binary: "grok", model: "m", cwd: "/tmp", reasoningEffort: "off", prompt: "p", scratch: scratch() });
  assert.ok(!args.includes("--effort"), `off must produce no --effort flag: ${args.join(" ")}`);
});

test("cli: grok — prompt file is written 0600 (not world-readable)", () => {
  const { args } = buildInvocation({ kind: "grok", binary: "grok", model: "m", cwd: "/tmp", reasoningEffort: "off", prompt: "sensitive review content", scratch: scratch() });
  const pf = args[args.indexOf("--prompt-file") + 1];
  assert.equal(statSync(pf).mode & 0o777, 0o600, "grok prompt file must be owner-only (0600)");
});

test("cli: cursor — prompt file is written 0600 (not world-readable)", () => {
  // The cursor recipe references the prompt file by a "Read <path>" positional.
  const { args } = buildInvocation({ kind: "cursor", binary: "cursor-agent", model: "m", cwd: "/tmp", reasoningEffort: "off", prompt: "sensitive review content", scratch: scratch() });
  const m = args[args.length - 1].match(/Read (\S+)/);
  assert.ok(m, "cursor positional should reference the prompt file");
  assert.equal(statSync(m[1]).mode & 0o777, 0o600, "cursor prompt file must be owner-only (0600)");
});

test("cli: an unconfigured model is refused before spawning (opt-in gate)", async () => {
  const cap = [];
  const cfg = cliConfig("cursor");
  cfg.models.m.configured = false;
  cfg.models.m.missing = ["MULTIPOLY_M_ENABLED=1"];
  await assert.rejects(
    () => runModel({ config: cfg, modelKey: "m", messages, mode: "consult", execFileImpl: fakeExec("x", cap), env: {} }),
    (e) => e.code === "CONFIG" && /not configured/.test(e.message),
  );
  assert.equal(cap.length, 0, "must not spawn an unconfigured cli model");
});

test("cli: per-model timeout override is passed to the child", async () => {
  const cap = [];
  await runModel({
    config: cliConfig("claude", { timeoutMs: 12345 }),
    modelKey: "m",
    messages,
    mode: "consult",
    execFileImpl: fakeExec("ok", cap),
    env: {},
  });
  assert.equal(cap[0].opts.timeout, 12345);
});

test("cli: secret-shaped stderr is withheld from the surfaced error", async () => {
  const leakyExec = () => {
    const e = new Error("agent crashed");
    // Unrelated env secret echoed to stderr (not the auth token).
    e.stderr = "Traceback: using OPENAI_API_KEY=sk-proj-ABCDEF1234567890ABCDEF1234567890\n";
    throw e;
  };
  await assert.rejects(
    () => runModel({ config: cliConfig("claude"), modelKey: "m", messages, mode: "consult", execFileImpl: leakyExec, env: {} }),
    (e) => /withheld/.test(e.message) && !/sk-proj-ABCDEF/.test(e.message),
  );
});

test("cli: empty output is a failure (not a 0-finding success)", async () => {
  const cap = [];
  await assert.rejects(
    () =>
      runModel({
        config: cliConfig("claude"),
        modelKey: "m",
        messages,
        mode: "consult",
        execFileImpl: fakeExec("   \n  ", cap),
        env: {},
      }),
    (e) => e.code === "CLI" || /empty/i.test(e.message),
  );
});

test("cli: a secret in the child error is redacted from the thrown error", async () => {
  const cap = [];
  const leakyExec = () => {
    const e = new Error("auth failed using token sk-cursor-SECRET-9999 at /home/user/.cursor");
    throw e;
  };
  await assert.rejects(
    () =>
      runModel({
        config: cliConfig("cursor", { authTokenEnv: "CURSOR_API_KEY" }),
        modelKey: "m",
        messages,
        mode: "consult",
        execFileImpl: leakyExec,
        env: { CURSOR_API_KEY: "sk-cursor-SECRET-9999" },
      }),
    (e) => !/sk-cursor-SECRET-9999/.test(e.message),
  );
});

test("cli: review mode appends a JSON-only instruction to the flattened prompt", async () => {
  const cap = [];
  await runModel({
    config: cliConfig("claude"),
    modelKey: "m",
    messages,
    mode: "review",
    responseFormat: { type: "json_schema", json_schema: { name: "x", schema: {} } },
    execFileImpl: fakeExec('{"findings":[],"summary_md":"ok"}', cap),
    env: {},
  });
  assert.match(cap[0].opts.input, /JSON/i);
});

test("cli: temp cwd mode runs the child in an isolated directory, not the repo", async () => {
  const cap = [];
  await runModel({
    config: cliConfig("claude", { cwdMode: "temp" }),
    modelKey: "m",
    messages,
    mode: "consult",
    cwd: process.cwd(),
    execFileImpl: fakeExec("ok", cap),
    env: {},
  });
  assert.notEqual(cap[0].opts.cwd, process.cwd());
});

test("cli: concurrent calls get distinct scratch paths (council safety)", async () => {
  const seen = [];
  const exec = (file, args) => {
    const i = args.indexOf("--output-last-message");
    const path = args[i + 1];
    seen.push(path);
    writeFileSync(path, "answer");
    return "";
  };
  await Promise.all(
    [0, 1, 2].map(() =>
      runModel({
        config: cliConfig("codex"),
        modelKey: "m",
        messages,
        mode: "consult",
        execFileImpl: exec,
        env: {},
      }),
    ),
  );
  assert.equal(new Set(seen).size, 3, "each call must use a unique last-message file");
});

// ── Task 10: reasoning-effort adapter wiring ──────────────────────────────

// buildInvocation helper: creates a minimal scratch dir path stub for tests
// that only need argv inspection (no real file I/O). We pass a real tmpdir
// scratch because buildInvocation(codex) calls mkdirSync on CODEX_HOME inside.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function scratch() { return mkdtempSync(join(tmpdir(), "cli-test-")); }

test("cli: codex + high effort → -c model_reasoning_effort in argv", () => {
  const { args } = buildInvocation({ kind: "codex", binary: "codex", model: "m", cwd: "/tmp", reasoningEffort: "high", prompt: "p", scratch: scratch() });
  assert.ok(args.includes("-c"), "expected -c flag");
  assert.ok(args.some((a) => a === 'model_reasoning_effort="high"'), `expected model_reasoning_effort="high" in args: ${args.join(" ")}`);
});

test("cli: codex + xhigh effort → clamped to high in argv", () => {
  const { args } = buildInvocation({ kind: "codex", binary: "codex", model: "m", cwd: "/tmp", reasoningEffort: "xhigh", prompt: "p", scratch: scratch() });
  assert.ok(args.some((a) => a === 'model_reasoning_effort="high"'), `xhigh must be clamped to high: ${args.join(" ")}`);
  assert.ok(!args.some((a) => a === 'model_reasoning_effort="xhigh"'), "xhigh must not appear in argv");
});

test("cli: codex + off effort → no -c reasoning flag in argv", () => {
  const { args } = buildInvocation({ kind: "codex", binary: "codex", model: "m", cwd: "/tmp", reasoningEffort: "off", prompt: "p", scratch: scratch() });
  assert.ok(!args.some((a) => /model_reasoning_effort/.test(a)), `off must produce no reasoning flag: ${args.join(" ")}`);
});

test("cli: agy + high effort → no reasoning flag in argv", () => {
  const { args } = buildInvocation({ kind: "agy", binary: "agy", model: "m", cwd: "/tmp", reasoningEffort: "high", prompt: "p", scratch: scratch() });
  assert.ok(!args.some((a) => /effort|reason|think/.test(a)), `agy should produce no reasoning flag: ${args.join(" ")}`);
});

test("cli: claude + high effort → --effort flag in argv", () => {
  const { args } = buildInvocation({ kind: "claude", binary: "claude", model: "m", cwd: "/tmp", reasoningEffort: "high", prompt: "p", scratch: scratch() });
  assert.ok(args.includes("--effort"), `expected --effort flag for claude: ${args.join(" ")}`);
  assert.equal(args[args.indexOf("--effort") + 1], "high");
});

test("cli: claude + xhigh effort → --effort xhigh in argv (no clamping for claude)", () => {
  const { args } = buildInvocation({ kind: "claude", binary: "claude", model: "m", cwd: "/tmp", reasoningEffort: "xhigh", prompt: "p", scratch: scratch() });
  assert.ok(args.includes("--effort"), `expected --effort flag for claude: ${args.join(" ")}`);
  assert.equal(args[args.indexOf("--effort") + 1], "xhigh");
});

test("cli: claude + off effort → no --effort flag in argv", () => {
  const { args } = buildInvocation({ kind: "claude", binary: "claude", model: "m", cwd: "/tmp", reasoningEffort: "off", prompt: "p", scratch: scratch() });
  assert.ok(!args.includes("--effort"), `off must produce no --effort flag: ${args.join(" ")}`);
});

test("cli: per-call effort overrides model baseline in resulting argv (codex)", async () => {
  // model baseline = "low", per-call = "high" → argv must contain "high"
  const cap = [];
  await runModel({
    config: cliConfig("codex", { reasoningEffort: "low" }),
    modelKey: "m",
    messages,
    mode: "consult",
    reasoningEffort: "high",
    execFileImpl: fakeExec("", cap, { lastMessageContent: "answer" }),
    env: {},
  });
  const { args } = cap[0];
  assert.ok(args.some((a) => a === 'model_reasoning_effort="high"'), `per-call "high" must override baseline "low": ${args.join(" ")}`);
  assert.ok(!args.some((a) => a === 'model_reasoning_effort="low"'), `baseline "low" must not appear when overridden: ${args.join(" ")}`);
});

test("cli: cli_reasoning_unsupported note appears on stderr for unsupported kind with non-off effort", async () => {
  // Capture stderr via a writable mock; agy has no reasoning flag so the unsupported path fires.
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (msg, ...rest) => { stderrLines.push(String(msg)); return origWrite(msg, ...rest); };
  try {
    await runModel({
      config: cliConfig("agy", { reasoningEffort: "high" }),
      modelKey: "m",
      messages,
      mode: "consult",
      execFileImpl: fakeExec("agy result", []),
      env: {},
    });
  } finally {
    process.stderr.write = origWrite;
  }
  assert.ok(stderrLines.some((l) => /cli_reasoning_unsupported/.test(l)), `expected cli_reasoning_unsupported in stderr: ${stderrLines.join("")}`);
});
