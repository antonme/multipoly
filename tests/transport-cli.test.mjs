import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { runModel } from "../scripts/lib/run-model.mjs";

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
    const e = new Error("auth failed using token sk-cursor-SECRET-9999 at /Users/anton/.cursor");
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
