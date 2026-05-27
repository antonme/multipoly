import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { MultipolyError } from "../errors.mjs";
import { CLI_KINDS } from "../models.mjs";
import { scan } from "../secrets.mjs";

// Track all spawned CLI process groups so they can be cleaned up on shutdown.
// `defaultExecFile` adds the group PID before spawning; the cleanup hooks below
// SIGKILL every group. Using a Set so concurrent adds are safe and duplicates
// are idempotent.
const _liveGroups = new Set();
let _cleanupRegistered = false;
function _registerCleanup() {
  if (_cleanupRegistered) return;
  _cleanupRegistered = true;
  installGroupCleanup(_liveGroups);
}

/**
 * Install shutdown cleanup that SIGKILLs every tracked process group.
 *
 * `exit`/`beforeExit` only kill (the process is already going down). But those
 * do NOT fire on signal termination — which is exactly how an MCP client stops
 * a server — so we also handle SIGINT/SIGTERM. A signal handler must terminate
 * the process itself: installing a listener suppresses Node's default
 * termination, so without the explicit `exit(128+signo)` the server would
 * survive a SIGTERM. Children are spawned detached (own group), so a parent
 * that died without running this would orphan in-flight agents.
 *
 * Dependencies are injected for testing (so tests never register real OS signal
 * handlers or kill the test process).
 *
 * @param {Set<number>} liveGroups — tracked group PIDs (group leader pids).
 */
export function installGroupCleanup(
  liveGroups,
  {
    proc = process,
    killGroup = (pgid) => process.kill(-pgid, "SIGKILL"), // negative pid → whole group
    exit = (code) => process.exit(code),
  } = {},
) {
  const killAll = () => {
    for (const pgid of liveGroups) {
      try {
        killGroup(pgid);
      } catch {
        /* already gone */
      }
    }
    liveGroups.clear();
  };
  proc.on("exit", killAll);
  proc.on("beforeExit", killAll);
  // 128 + signal number is the conventional exit code for signal termination.
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    proc.on(signal, () => {
      killAll();
      exit(code);
    });
  }
}

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Drive a local read-only agent CLI as a model transport. Flattens the
 * OpenAI-style messages[] into one prompt, runs the per-kind read-only recipe
 * in a subprocess, and returns the uniform completion shape. The caller
 * (review/consult/council) keeps doing budget checks and — for review — JSON
 * validation + reprompt above this seam, exactly as for the http transport.
 *
 * @param {object} args
 *   - config, modelKey: locate the model's cli config.
 *   - messages, mode, responseFormat, timeoutMs: the call.
 *   - execFileImpl: test seam; (file, args, opts) => string | Promise<string>.
 *   - env: env source for auth lookups + child env (default process.env).
 *   - cwd: repo working dir (default process.cwd()); used when cwdMode==="repo".
 */
export async function runCliModel(args) {
  const { config, modelKey, messages, mode, responseFormat, timeoutMs, reasoningEffort } = args;
  const env = args.env ?? process.env;
  const repoCwd = args.cwd ?? process.cwd();
  const execFile = args.execFileImpl ?? defaultExecFile;

  const m = config?.models?.[modelKey];
  if (!m || m.transport !== "cli") {
    throw new MultipolyError("CONFIG", `model "${modelKey}" is not a cli transport`);
  }
  // Refuse to spawn an unconfigured/un-opted-in cli model. Every model's tools
  // are advertised regardless of `configured`, so without this guard a direct
  // `composer_review` / `<agy>_consult` call would shell out to the agent and
  // bypass the MULTIPOLY_<K>_ENABLED (and agy UNSAFE) opt-in gate. Mirrors the
  // http (client.mjs) and anthropic (anthropic.mjs) configured checks.
  if (!m.configured) {
    throw new MultipolyError(
      "CONFIG",
      `${modelKey} is not configured: missing ${(m.missing ?? []).join(", ")}`,
      { details: { model: modelKey, missing: m.missing } },
    );
  }
  const kindDef = CLI_KINDS[m.cliKind];
  if (!kindDef) {
    throw new MultipolyError("CONFIG", `model "${modelKey}" has unknown cli kind ${JSON.stringify(m.cliKind)}`);
  }
  const binary = m.binary || kindDef.binary;

  // Fail fast (before spawning) when the kind needs an auth env var that isn't
  // present — a clearer error than the agent's own opaque auth failure.
  if (m.authTokenEnv && !env[m.authTokenEnv]) {
    throw new MultipolyError(
      "CONFIG",
      `model "${modelKey}" (${m.cliKind}) needs ${m.authTokenEnv} in the environment, but it is unset`,
    );
  }

  const wantJson = mode === "review" && Boolean(responseFormat);
  const prompt = flattenMessages(messages, wantJson);

  // Per-call scratch dir holds aux files (codex last-message, cursor prompt),
  // so concurrent council members never collide. Cleaned in finally. When
  // cwdMode==="temp" the child also runs in its own empty dir (tighter
  // boundary than the repo); default is the repo (D5).
  const scratch = mkdtempSync(join(tmpdir(), `multipoly-cli-${m.cliKind}-`));
  let tempCwd;
  try {
    const childCwd = m.cwdMode === "temp" ? (tempCwd = mkdtempSync(join(tmpdir(), "multipoly-cwd-"))) : repoCwd;
    const effectiveEffort = (reasoningEffort && reasoningEffort !== "inherit") ? reasoningEffort : m.reasoningEffort;
    const recipe = buildInvocation({ kind: m.cliKind, binary, model: m.model, cwd: childCwd, reasoningEffort: effectiveEffort, prompt, scratch });

    // codex authenticates from $CODEX_HOME/auth.json. We isolate CODEX_HOME to
    // an empty temp dir (so the operator's config.toml / MCP servers / rules
    // don't auto-load), which also strips auth — so seed JUST the credential
    // file from the operator's real codex home. The temp home (and this copy)
    // is removed in the finally below.
    if (m.cliKind === "codex" && recipe.env?.CODEX_HOME) {
      const srcAuth = join(env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
      if (existsSync(srcAuth)) {
        try {
          copyFileSync(srcAuth, join(recipe.env.CODEX_HOME, "auth.json"));
        } catch {
          /* best-effort; codex will surface its own auth error if missing */
        }
      }
    }

    const childEnv = { ...env, ...recipe.env };
    let stdout;
    try {
      stdout = await Promise.resolve(
        execFile(binary, recipe.args, {
          cwd: childCwd,
          input: recipe.stdin,
          encoding: "utf8",
          timeout: timeoutMs ?? m.timeoutMs ?? config?.timeoutMs ?? 600000,
          maxBuffer: MAX_BUFFER,
          env: childEnv,
        }),
      );
    } catch (err) {
      const secrets = m.authTokenEnv && env[m.authTokenEnv] ? [env[m.authTokenEnv]] : [];
      throw new MultipolyError(
        "CLI",
        `${m.cliKind} cli failed: ${buildErrorMessage(err, { paths: [childCwd, scratch], secrets })}`,
        { cause: err },
      );
    }

    // codex writes its final message to a file; the others emit on stdout.
    let content = stdout;
    if (recipe.lastMessageFile) {
      content = existsSync(recipe.lastMessageFile) ? readFileSync(recipe.lastMessageFile, "utf8") : "";
    }

    if (!content || content.trim().length === 0) {
      // An agent that returned nothing is a failure, not a real "0 findings"
      // / empty answer — fail loudly so it isn't mistaken for a clean result.
      throw new MultipolyError("CLI", `${m.cliKind} cli produced empty output (treated as failure, not a result)`);
    }

    return {
      content,
      reasoning: null,
      finishReason: "stop",
      usage: null, // unknown — the agent consumes its own subscription/quota
      fellBackFromJsonSchema: false, // cli never attempts provider-native schema
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (tempCwd) rmSync(tempCwd, { recursive: true, force: true });
  }
}

/**
 * Flatten a role-tagged message list into a single prompt. Preserves the
 * review retry transcript (system → user → assistant(prev attempt) →
 * json-only user) so a cli model gets the same correction signal an http
 * model would. Appends an explicit JSON-only directive in review mode, since
 * a cli agent can't be given a provider-native response schema.
 */
export function flattenMessages(messages, wantJson) {
  const label = (role) =>
    role === "system" ? "SYSTEM" : role === "assistant" ? "ASSISTANT (your previous attempt)" : "USER";
  const parts = messages.map((msg) => `### ${label(msg.role)}\n${msg.content}`);
  if (wantJson) {
    parts.push(
      "### REQUIRED OUTPUT FORMAT\nRespond with ONLY valid JSON matching the requested schema. " +
        "No prose, no explanation, no markdown code fences — just the JSON object.",
    );
  }
  return parts.join("\n\n");
}

/**
 * Per-kind read-only invocation recipe. Returns { args, stdin, env,
 * lastMessageFile? }. Read-only + config/MCP isolation flags are baked in per
 * kind (verified against installed CLIs):
 *   - claude:  --tools "" (no tools) + --strict-mcp-config (no user MCP),
 *              OAuth preserved (NOT --bare, which would force api-key auth).
 *   - codex:   --sandbox read-only + isolated CODEX_HOME; final message via
 *              --output-last-message; prompt on stdin via the "-" marker.
 *   - cursor:  --mode plan; ignores stdin, so the prompt is written to a file
 *              and referenced by the trailing positional.
 *   - gemini:  --approval-mode plan + GEMINI_CLI_TRUST_WORKSPACE=true.
 *   - agy:     --print --sandbox --add-dir <cwd> (weak sandbox; gated on unsafe
 *              opt-in at config time).
 *   - kimi:    --print --plan (--print implies --afk → --plan makes it
 *              read-only) -m <model> --prompt <prompt>.
 */
export function buildInvocation({ kind, binary, model, cwd, reasoningEffort, prompt, scratch }) {
  switch (kind) {
    case "claude":
      return {
        args: [
          "-p",
          "--model",
          model,
          "--output-format",
          "text",
          "--tools",
          "",
          "--strict-mcp-config",
          "Complete the task described on stdin. Emit only the requested output as your final message.",
        ],
        stdin: prompt,
        env: {},
      };
    case "codex": {
      const lastMessageFile = join(scratch, "codex-last-message.txt");
      // codex refuses to start if CODEX_HOME doesn't exist — create the
      // isolated home up front (it can't reach the operator's ~/.codex).
      const codexHome = join(scratch, "codex-home");
      mkdirSync(codexHome, { recursive: true });
      const args = ["exec"];
      if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
      args.push(
        "-m",
        model,
        "-C",
        cwd,
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--output-last-message",
        lastMessageFile,
        "-",
      );
      return {
        args,
        stdin: prompt,
        // Isolate codex from the operator's ~/.codex config/profiles/rules.
        env: { CODEX_HOME: codexHome },
        lastMessageFile,
      };
    }
    case "cursor": {
      const promptFile = join(scratch, "cursor-prompt.md");
      writeFileSync(promptFile, prompt);
      return {
        args: [
          "-p",
          "--model",
          model,
          "--output-format",
          "text",
          "--mode",
          "plan",
          "--workspace",
          cwd,
          "--trust", // skip the interactive workspace-trust prompt (else it hangs to timeout)
          `Read ${promptFile} and complete the task described inside. Do not write any files; emit only the requested output as your final message.`,
        ],
        stdin: "", // cursor-agent ignores stdin in --print mode
        env: {},
      };
    }
    case "gemini": {
      // gemini's `-p` IS the prompt in headless mode (it's appended to stdin if
      // any). A separate "task is on stdin" meta-instruction confused the model
      // (it ignored stdin), so pass the full prompt as `-p`. This puts the
      // prompt in argv — guard against the OS E2BIG limit (128KB conservative
      // floor; most platforms allow 200-260 KB).
      const GEMINI_ARGV_SAFETY_LIMIT = 200_000;
      const promptBytes = Buffer.byteLength(prompt, "utf8");
      if (promptBytes > GEMINI_ARGV_SAFETY_LIMIT) {
        throw new MultipolyError(
          "INVALID_INPUT",
          `gemini prompt is ${promptBytes} bytes, which risks OS argv limit. ` +
            `Shorten the prompt or reduce the file set; for reviews, lower MULTIPOLY_PER_FILE_CAP_BYTES or MULTIPOLY_TOTAL_CAP_BYTES, ` +
            `or use a different transport for large reviews.`,
        );
      }
      return {
        args: ["-m", model, "-o", "text", "--approval-mode", "plan", "-p", prompt],
        stdin: "",
        env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
      };
    }
    case "agy":
      return {
        // No --model / --output-format / read-only mode on agy; weak sandbox
        // only. The prompt arrives on stdin.
        args: ["--print", "--sandbox", "--add-dir", cwd],
        stdin: prompt,
        env: {},
      };
    case "kimi":
      // --quiet = `--print --output-format text --final-message-only`, so the
      // output is just the final assistant message (no TurnBegin/ThinkPart
      // transcript noise). --print implies --afk (auto-runs writes), so --plan
      // is mandatory to keep it read-only. Prompt on stdin (NOT --prompt, which
      // would leak reviewed code into argv and risk E2BIG on large reviews).
      return {
        args: ["--quiet", "--plan", "-m", model],
        stdin: prompt,
        env: {},
      };
    default:
      throw new MultipolyError("CONFIG", `unsupported cli kind ${JSON.stringify(kind)}`);
  }
}

/**
 * Default production execFile: spawn the child in its OWN process group
 * (detached) so a timeout SIGKILLs the whole group — agent grandchildren don't
 * orphan. Mirrors the execFileSync(input/timeout/maxBuffer) contract; resolves
 * stdout, rejects with stdout/stderr attached on non-zero exit / timeout.
 */
export function defaultExecFile(file, args, opts) {
  _registerCleanup();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Track the process group for shutdown cleanup so a SIGKILL'd server
    // doesn't orphan agent grandchildren.
    _liveGroups.add(child.pid);
    const untrack = () => _liveGroups.delete(child.pid);

    const stdout = [];
    const stderr = [];
    let outBytes = 0;
    let overflow = false;
    let timedOut = false;
    let timer;

    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL"); // negative pid → whole group
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    let errBytes = 0;
    child.stdout.on("data", (b) => {
      outBytes += b.length;
      if (outBytes > opts.maxBuffer) {
        overflow = true;
        killGroup();
        return;
      }
      stdout.push(b);
    });
    child.stderr.on("data", (b) => {
      // Cap stderr too: a noisy/broken agent could otherwise exhaust memory.
      errBytes += b.length;
      if (errBytes > opts.maxBuffer) {
        overflow = true;
        killGroup();
        return;
      }
      stderr.push(b);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      untrack();
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      untrack();
      const out = Buffer.concat(stdout).toString(opts.encoding);
      const err = Buffer.concat(stderr).toString(opts.encoding);
      if (overflow) return reject(withIo(new Error("stdout maxBuffer exceeded"), out, err));
      if (timedOut) return reject(withIo(new Error(`process timed out after ${opts.timeout}ms`), out, err));
      if (code !== 0 || signal) {
        return reject(withIo(new Error(`child exited with ${code !== null ? `code ${code}` : `signal ${signal}`}`), out, err));
      }
      resolve(out);
    });

    if (opts.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, opts.timeout);
    }
    if (child.stdin) {
      child.stdin.on("error", () => {
        // EPIPE is expected when the child closes stdin early (e.g. cursor in
        // --print mode). Let the error surface via close/error instead.
      });
      child.stdin.end(opts.input ?? "");
    }
    // NOTE: do NOT child.unref() here. We always settle this promise from the
    // close/error/timeout handlers, so the child legitimately keeps the loop
    // alive until then. unref'ing a detached child lets a quiet event loop
    // drain before close fires ("Promise resolution is still pending but the
    // event loop has already resolved"), which the timeout/maxBuffer/ENOENT
    // tests hit on CI.
  });
}

function withIo(err, stdout, stderr) {
  err.stdout = stdout;
  err.stderr = stderr;
  return err;
}

/**
 * Build a safe, surfaced error message from a failed child. The child inherits
 * the full parent env (agents need HOME/PATH/their own creds), so its stderr
 * may echo an UNRELATED secret (OPENAI_API_KEY, GITHUB_TOKEN, …) — and with the
 * repo cwd, file content the gathered-payload scan never saw. So:
 *   1. redact the known auth-token value + scratch/cwd paths, then
 *   2. secret-scan the stderr; if anything secret-shaped remains, withhold the
 *      stderr entirely rather than surface it.
 * The structured `cause` is preserved separately for local debugging.
 */
function buildErrorMessage(err, { paths = [], secrets = [] } = {}) {
  const base = redact(err?.message ?? String(err), { paths, secrets });
  if (!err?.stderr) return base.slice(0, 4000);
  const redactedStderr = redact(String(err.stderr), { paths, secrets });
  const stderrPart = scan(redactedStderr, "cli-stderr").clean
    ? redactedStderr
    : "[stderr withheld: secret-shaped content detected]";
  return `${base}\n${stderrPart}`.slice(0, 4000);
}

/**
 * Redact known secret values and absolute scratch/cwd paths from a string.
 * Best-effort literal masking; secret DETECTION (for withholding) is done by
 * the scanner in buildErrorMessage.
 */
function redact(text, { paths = [], secrets = [] } = {}) {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join("«redacted-secret»");
  }
  for (const p of paths) {
    if (p) out = out.split(p).join("«path»");
  }
  return out;
}
