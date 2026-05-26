import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultipolyError } from "../errors.mjs";
import { CLI_KINDS } from "../models.mjs";

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
  const { config, modelKey, messages, mode, responseFormat, timeoutMs } = args;
  const env = args.env ?? process.env;
  const repoCwd = args.cwd ?? process.cwd();
  const execFile = args.execFileImpl ?? defaultExecFile;

  const m = config?.models?.[modelKey];
  if (!m || m.transport !== "cli") {
    throw new MultipolyError("CONFIG", `model "${modelKey}" is not a cli transport`);
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
    const recipe = buildInvocation({ kind: m.cliKind, binary, model: m.model, cwd: childCwd, reasoningEffort: m.reasoningEffort, prompt, scratch });

    const childEnv = { ...env, ...recipe.env };
    let stdout;
    try {
      stdout = await Promise.resolve(
        execFile(binary, recipe.args, {
          cwd: childCwd,
          input: recipe.stdin,
          encoding: "utf8",
          timeout: timeoutMs ?? config?.timeoutMs ?? 600000,
          maxBuffer: MAX_BUFFER,
          env: childEnv,
        }),
      );
    } catch (err) {
      const secrets = m.authTokenEnv && env[m.authTokenEnv] ? [env[m.authTokenEnv]] : [];
      throw new MultipolyError(
        "CLI",
        `${m.cliKind} cli failed: ${redact(sanitizeExecError(err), { paths: [childCwd, scratch], secrets })}`,
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
        env: { CODEX_HOME: join(scratch, "codex-home") },
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
          `Read ${promptFile} and complete the task described inside. Do not write any files; emit only the requested output as your final message.`,
        ],
        stdin: "", // cursor-agent ignores stdin in --print mode
        env: {},
      };
    }
    case "gemini":
      return {
        args: ["-m", model, "-o", "text", "--approval-mode", "plan", "-p", "Complete the task described on stdin."],
        stdin: prompt,
        env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
      };
    case "agy":
      return {
        // No --model / --output-format / read-only mode on agy; weak sandbox
        // only. The prompt arrives on stdin.
        args: ["--print", "--sandbox", "--add-dir", cwd],
        stdin: prompt,
        env: {},
      };
    case "kimi":
      return {
        args: ["--print", "--plan", "-m", model, "--prompt", prompt],
        stdin: "",
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
function defaultExecFile(file, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
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

    child.stdout.on("data", (b) => {
      outBytes += b.length;
      if (outBytes > opts.maxBuffer) {
        overflow = true;
        killGroup();
        return;
      }
      stdout.push(b);
    });
    child.stderr.on("data", (b) => stderr.push(b));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
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
  });
}

function withIo(err, stdout, stderr) {
  err.stdout = stdout;
  err.stderr = stderr;
  return err;
}

function sanitizeExecError(err) {
  const base = err?.message ?? String(err);
  const stderr = err?.stderr ? `\n${err.stderr}` : "";
  return (base + stderr).slice(0, 4000);
}

/**
 * Redact known secret values and absolute scratch/cwd paths from a string
 * before it is surfaced in an error. Best-effort: the structured cause is
 * preserved separately for debugging.
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
