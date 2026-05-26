# Multi-Transport Model Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let multipoly drive models over three transports — OpenAI-compatible HTTP (today), native Anthropic Messages API, and local agent CLIs (Claude Code, Codex, Cursor/Composer, Gemini, agy/Antigravity, Kimi) — behind one model contract, so review/consult/council work unchanged regardless of how a model is reached.

**Architecture:** Add a `transport` discriminant per registry model and a `runModel()` dispatcher returning the existing `{content, reasoning, finishReason, usage, fellBackFromJsonSchema}` shape. `http` keeps `streamChatCompletion`; `anthropic` adds a `/v1/messages` adapter; `cli` spawns a read-only agent subprocess (per-kind recipe), flattening `messages[]` to one prompt and capturing the final text. Reference implementation: `../r7-project` (`pipelines/aictrl-cs/external-cli-runtime.ts`, `api-profile.ts`, `pipelines/aictrl-faithful/anthropic-transport.ts`).

**Tech Stack:** Node ESM, `node:child_process` (spawn), `fetch`+SSE, `node:test`.

---

## Research summary (ground truth)

### CLI recipes (read-only, headless), verified against installed binaries / r7
| Kind | Binary | One-shot invocation | Read-only flag | Prompt delivery | Output | Auth |
|---|---|---|---|---|---|---|
| claude | `claude` | `-p --model <m> --output-format text --tools "" "<instr>"` | `--tools ""` (no tools) | stdin | stdout | OAuth |
| codex | `codex` | `exec [-c model_reasoning_effort="<e>"] -m <m> -C <cwd> --skip-git-repo-check --sandbox read-only --output-last-message <f> -` | `--sandbox read-only` | stdin (`-`) | `<f>` file | login/`OPENAI_API_KEY` |
| cursor | `cursor-agent` | `-p --model <m> --output-format text --mode plan --workspace <cwd> --trust "<instr>"` | `--mode plan` | **file + positional** (ignores stdin) | stdout | `CURSOR_API_KEY` env; **needs unlocked macOS keychain** |
| gemini | `gemini` | `-m <m> -o text --approval-mode plan -p "<instr>"` + `GEMINI_CLI_TRUST_WORKSPACE=true` | `--approval-mode plan` | stdin | stdout | OAuth/`GEMINI_API_KEY` |
| agy | `agy` | `--print --sandbox --add-dir <cwd>` (no `--model`/`--output-format`) | `--sandbox` (weak) | stdin | stdout | gemini OAuth |
| kimi | `kimi` | `--print --plan -m <m> --prompt "<instr>"` | **`--plan`** (REQUIRED: `--print` implies `--afk` → auto-executes writes; `--plan` makes it read-only) | `--prompt`/stdin (verify) | stdout | `kimi login` / `KIMI_API_KEY` (verify) |

Cross-cutting (from r7 `external-cli-runtime.ts`):
- spawn with stdin input, SIGKILL on `timeout`, `maxBuffer` cap, capture stdout+stderr.
- empty output ⇒ treat as failure, not "0 findings".
- redact secrets/abs-paths from any surfaced error/artifact.
- inject `authTokenEnv` value into the child env (e.g. `ANTHROPIC_AUTH_TOKEN`, `CURSOR_API_KEY`), never on argv.

### Anthropic native (`wireApi: "anthropic"`, r7 `anthropic-transport.ts`)
- `POST {baseUrl}/v1/messages`, headers `x-api-key: <key>` + `anthropic-version: 2023-06-01`.
- `system` is a top-level field (not a message); `messages` are user/assistant turns.
- SSE event types: `message_start`, `content_block_start/delta/stop` (`text_delta`, `thinking_delta`), `message_delta` (stop_reason, usage), `message_stop`.
- Optional adaptive thinking (`thinking:{type:"adaptive"}` + `output_config:{effort}`) and prompt caching (`cache_control`).

---

## Design decisions (revised after Codex collaboration — ✦ = changed by Codex)

**D1 — Config surface: explicit JSON registry file only ✦.** Add a JSON registry modeled on r7's `config/models.json` (strict key allowlist, secrets rejected, `authTokenEnv` validated as an env-var NAME, **no arbitrary argv** — only `cliKind` + a controlled binary default). **Loaded ONLY from an explicit `MULTIPOLY_MODELS_FILE` path — never auto-loaded from cwd**, because the MCP server frequently runs inside the repo under review and a repo-local file naming CLI commands is a code-execution footgun. Env builtins + file entries merge into one registry.

**D2 — Structured output (review JSON) ✦.** CLI: prompt-instructed JSON + the existing `validateReview` → `REVIEW_JSON_ONLY_PREFIX` reprompt loop. **Anthropic: use native structured outputs** (`output_config.format` with `type:"json_schema"`, GA for Opus 4.7) mapped from OpenAI `responseFormat`, with `output_config.effort` merged separately — not best-effort prompting. `fellBackFromJsonSchema` semantics per transport: http = today's behavior; anthropic = true only when native format was unavailable and we fell back to prompt JSON; cli = always false (never attempted provider-native schema).

**D3 — Read-only + isolation ✦ (most important change).** Each cli kind runs in its read-only mode AND with user-config/MCP isolation (`codex exec --ignore-user-config --ignore-rules`, claude equivalent) so the spawned agent can't auto-load the operator's MCP servers/rules. Refuse to run a cli model whose read-only flag is unknown. **`agy` = weak sandbox (no real read-only mode) → opt-in "unsafe" only.** On timeout, **kill the process group** (detached spawn + negative-pid SIGKILL), not just the immediate child, so agent grandchildren don't orphan.

**D4 — Builtins ✦ (DECIDED).** Keep the 4 HTTP builtins. Add `opus` as a native-Anthropic builtin (configured only when `ANTHROPIC_API_KEY` present). Ship claude/codex/agy/kimi/gemini as **documented registry examples**, not always-on. **DECIDED (user): repurpose `composer`** → transport=cli/cursor (composer-2.5 via cursor-agent); the HTTP form never worked (no Composer HTTP API), so this is a fix. `composer_review`/`composer_consult` keep their names. Document the config-contract change in CHANGELOG.

**D5 — Workspace/cwd ✦ (DECIDED).** **DECIDED (user): repo `cwd` by default** — CLI agents run in the repo so they can explore beyond the inlined gathered files (richer review). Provide a per-model **opt-in to an isolated temp cwd** for operators who want the tighter boundary. **Document prominently** that with repo cwd the trust boundary is "the agent may read the entire workspace, including files multipoly never gathered or secret-scanned" — the pre-flight secret scan only covers the gathered payload (`model-review.mjs`, `model-consult.mjs`).

**D6 — Cost/usage ✦.** Anthropic returns real `usage` (incl. cache fields), mapped like r7's `anthropic-transport.ts`. CLI: `usage: null` meaning **unknown** (not zero/free) — keep the distinction. CLI agents consume the operator's subscriptions; note in docs.

---

## File structure

- `scripts/lib/models.mjs` — extend registry entries with `transport` + transport-specific fields; add JSON-file loader (D1).
- `scripts/lib/transport/run-model.mjs` (new) — `runModel(...)` dispatcher → `{content, reasoning, finishReason, usage, fellBackFromJsonSchema}`.
- `scripts/lib/transport/http.mjs` — existing `streamChatCompletion` (moved/re-exported; unchanged behavior).
- `scripts/lib/transport/anthropic.mjs` (new) — `/v1/messages` adapter (mirror r7 `anthropic-transport.ts`).
- `scripts/lib/transport/cli.mjs` (new) — spawn-based read-only agent runner with per-kind recipes + injectable `execFile` seam for tests.
- `scripts/lib/config.mjs` — parse/validate transport fields; merge file registry; redact tokens.
- `scripts/lib/model-review.mjs` / `model-consult.mjs` / `council.mjs` — call `runModel` instead of `streamChatCompletion` directly (transport-agnostic).
- `scripts/multipoly-mcp.mjs` — registry → tools/handlers unchanged (already registry-driven).
- Tests: `tests/transport-cli.test.mjs`, `tests/transport-anthropic.test.mjs`, `tests/run-model.test.mjs`, plus config/registry-file tests.

## Task breakdown (revised; bite-sized TDD steps expanded per task during execution)

1. **No-op dispatcher seam** — add `runModel({..., fetchImpl, execFileImpl})` that for now only delegates to `streamChatCompletion`; route `model-review.mjs:65`, `model-consult.mjs:40`, `council.mjs:247/452` through it. Keep budget checks, JSON validation/reprompt, and secret-scan-before-synthesis ABOVE the seam. Keep `streamChatCompletion` exported. **Gate: all 173 existing tests green.**
2. **Registry + config validation (before any transport)** — add `transport` (`http`|`anthropic`|`cli`) + transport fields; validate `cliKind`, `authTokenEnv` (env-var NAME), timeout bounds, non-secret env, no argv secrets, no repo-local auto-load. TDD config/registry tests. Decide `composer` migration (D4).
3. **JSON registry file (D1)** — explicit `MULTIPOLY_MODELS_FILE` loader + merge + strict validation (port r7's allowlist/secret rejection). TDD.
4. **CLI transport** — `cli.mjs` with injectable `execFileImpl`; per-kind argv builders incl. **isolation flags**; role-preserving prompt flattening (must represent the review **retry transcript**: system→user→assistant→json-only-user); stdin-vs-file delivery (cursor file+positional); codex `--output-last-message`; **isolated temp cwd** (D5) with per-call unique paths + cleanup; **process-group kill** on timeout; empty-output-as-failure; token/path redaction. TDD with a fake `execFileImpl` (no real agents). Concurrency test (council `Promise.allSettled`) for unique temp/last-message/prompt files.
5. **Anthropic transport** — `anthropic.mjs` `/v1/messages` + SSE adapter handling named events / `ping` / `error` / unknown events / `thinking_delta` / no `[DONE]`; native `output_config.format` for review JSON (D2); real `usage` mapping (D6); add `opus` builtin (only when `ANTHROPIC_API_KEY` set). TDD with a fake `fetch` streaming Anthropic SSE.
6. **Docs** — README transports section, example registry entries, read-only/auth/keychain/isolation caveats, cwd-isolation default; CHANGELOG.
7. **Verification smoke tests** — one real call per cli kind + opus (costs money/subscriptions → gated behind explicit user go-ahead). Confirm kimi `--plan` holds read-only under `--print/--afk`; cursor keychain; native kimi vs kimi-via-claude.
8. **Dual review** (superpowers code-reviewer + Codex) before merge.

---

## Verification points (carry into execution)
- kimi: confirm `--prompt` vs stdin and that `--plan` holds read-only under `--print/--afk`.
- cursor-agent: macOS keychain must be unlocked; document the failure mode.
- anthropic: confirm current `anthropic-version` and streaming event names against live API (web).
- All cli kinds: a first real smoke test per kind (costs money — gate behind explicit user go-ahead).
