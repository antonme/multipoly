# Changelog

All notable changes to this project are documented here.

## Unreleased

### Public-repo hygiene (2026-05-27)

Prep for publishing: removed personal/identifying details and internal-doc
links from user-facing files.

- **README:** use a `/path/to/multipoly` placeholder in the install/config
  examples instead of an absolute home-directory path, and drop the
  `docs/superpowers/` design/plan pointers from Status (internal notes, not
  user-facing docs).
- **`scripts/smoke-cli.mjs`:** resolve the `kimi` binary from `PATH` like the
  other agents instead of a hardcoded absolute path — also makes the smoke
  script portable across machines.
- **Tests:** genericize `/Users/…` fixtures in `transport-cli` /
  `transport-config` to neutral `/home/user/…` paths.

### Second-pass review fixes (2026-05-27)

Found by a follow-up multi-reviewer pass (self-review + Codex) over the
multi-transport work:

- **Secret-scanner ReDoS (regex backtracking) — fixed.** The `env_style_secret`
  and `generic_api_secret_assignment` patterns had unbounded `[A-Z0-9_]*` on
  both sides of the keyword alternation, which backtracks O(n²) on a long
  word-char run. A crafted file in the payload under review (e.g. a long
  `KEY_KEY_…` run) could pin the synchronous scanner — and the whole Node event
  loop — for tens of seconds (~17 s at 300 KB, measured). Both quantifiers are
  now bounded to `{0,64}`: linear, and still detects every realistic prefixed
  identifier name. A regression test asserts the scan stays sub-second.
- **Secret-scanner per-hit line numbering — fixed (O(n²) → ~linear).** `scan()`
  recomputed each hit's line number by rescanning from offset 0, so a payload
  with many secret-shaped matches (e.g. 24 000 `AKIA…` lines, ~336 KB) was
  O(n·hits) — ~7 s, freezing the event loop. Newline offsets are now built once
  per scan (lazily, only when there is a hit) and each line is found by binary
  search; line numbers are byte-identical to the previous implementation.
- **Anthropic extended thinking — now actually sent.** The native Anthropic
  transport accumulated `thinking_delta` output but never enabled thinking in
  the request, so `opus` reasoning was always empty and `MULTIPOLY_THINKING` was
  silently ignored for anthropic-transport models. It now sends
  `thinking: { type: "enabled", budget_tokens }` (budget = `min(8192,
  max_tokens − 1024)`, skipped when the cap is too small to leave output room),
  gated on the model declaring thinking support. The on/off/auto/mode-default
  resolution is now a single shared `resolveThinkingPreference` used by both the
  http and anthropic transports. Because extended thinking and native structured
  output are not safely combinable across all model/endpoint versions, review
  mode omits `output_config` when thinking is on and relies on the existing
  prompt-JSON validate/reprompt loop.
- **CLI subprocess cleanup on signals — fixed.** Cleanup was registered only on
  `exit`/`beforeExit`, which do not fire on signal termination — the usual way
  an MCP client stops a server — so a SIGTERM orphaned detached agent process
  groups. `installGroupCleanup` now also handles SIGINT/SIGTERM, killing every
  tracked group and then exiting `128 + signo` (installing a signal listener
  suppresses Node's default termination, so the explicit exit is required).
  Registration is dependency-injected so it can be unit-tested without real
  signals.

### Maintainability (2026-05-27)

- **Unified tool surface.** `buildTools`, the handler map, and the argument-key
  validator spec were three functions each independently re-deriving the tool
  list from the model keys, so adding a tool to one and not the others was a
  latent runtime mismatch. They now derive from a single `buildServerSurface`
  (one tool-def list → `{ tools, handlers, toolKeySpec }`), and
  `createServer(config)` is extracted from `main()` so the server can be driven
  over a transport.
- **MCP integration test.** A new in-memory-transport test boots the real
  server and a real client and exercises `tools/list` plus network-free
  `tools/call` paths (invalid-argument error envelope, unknown-tool protocol
  error), with an anti-drift assertion that the advertised tools, handlers, and
  validator key sets cover exactly the same names.
- **Anthropic wire-format documented.** The transport now documents that its
  `output_config.format` and `thinking.budget_tokens` request shapes target a
  future model and are unverified against a live endpoint, and that — unlike
  `output_config` — a rejected `thinking` field is not auto-fallback'd (disable
  with `MULTIPOLY_THINKING=off`).

### Audit fixes (2026-05-27)

**High priority:**
- **Dynamic `TOOL_KEY_SPEC`:** The runtime argument-key validator was built from
  the static `MODEL_KEYS` constant (glm/qwen/deepseek/composer), so custom
  models and `opus` silently passed unrecognized arguments through. It is now
  built from the active model registry in `main()`, covering every configured
  model.
- **Gemini E2BIG guard:** A gemini review whose prompt exceeds 200 KB (UTF-8)
  on argv now fails with `INVALID_INPUT` and remediation hints instead of a
  cryptic OS-spawn `E2BIG` crash.
- **Secret scanner expansion:** Added `ASIA` (AWS temporary), `github_pat_`,
  `xapp-` (Slack app), SSH public key, `sk-proj-`/`sk-ant-`/`sk-admin-`
  (OpenAI/Anthropic/admin), and unquoted `.env`-style (`KEY=value`) patterns.
  Fixed a typo that dropped `ghr_` refresh-token detection, and sanitized hit
  labels in formatted errors so malicious filenames cannot inject extra lines.
- **Timeout visibility:** Every tool call now emits a structured `tool_call`
  event to stderr showing the effective upstream timeout and a warning about the
  MCP client's own lower tool-call ceiling (Codex/Claude Code ~60s).
- **Anthropic `message_stop`:** A missing `message_stop` event no longer throws;
  it logs a structured warning and returns whatever content was received. The
  caller's budget / JSON-validation layers catch genuine truncation.

**Medium priority:**
- **Synthesizer fallback logging:** When the configured synthesizer model is not
  actually configured and the fallthrough chain activates, a structured
  `synthesizer_fallback` event is logged to stderr.
- **Git TOCTOU hardening:** `gatherReviewDiff` now resolves `diffBase` and
  `HEAD` to commit hashes and then pins their merge base before any diff
  queries, so concurrent commits/amends/resets can't cause file-list/diff-text
  disagreement while preserving `diff_base...HEAD` semantics when the base
  branch has advanced.
- **Orphaned CLI agent cleanup:** Spawned CLI subprocess PIDs are tracked in a
  `_liveGroups` Set; `process.on('exit')` and `beforeExit` handlers SIGKILL
  every tracked group so a crashed MCP server doesn't leave agent grandchildren.
- **Unicode-safe `sanitizeDisplay`:** Uses `codePointAt` so surrogate pairs
  (non-BMP characters like emoji) are handled as single units, and lone
  surrogates are replaced with `?` instead of passed through.
- **1‑token budget detection:** In review mode, content that is non-empty but
  too short to be valid JSON (< 64 chars) now surfaces as `BUDGET` rather than
  a confusing `SCHEMA` error.
- **Unconfigured Anthropic custom models:** A malformed optional Anthropic base
  URL no longer blocks startup when that custom model is missing credentials;
  it is validated once the model is actually configured.
- **Council docs/commands:** Slash-command and skill guidance now reflect the
  current default harness-side council synthesis instead of the old
  Qwen-as-default behavior.

### Multi-transport models (http / anthropic / cli)

Models can now be reached over three transports behind one model contract, so
review/consult/council work unchanged regardless of how a model is reached:

- **`http`** (default) — the existing OpenAI-compatible streaming client.
- **`anthropic`** — the native Anthropic Messages API (`/v1/messages`, SSE,
  real token usage, native structured outputs for review JSON with a prompt-JSON
  fallback). Set `ANTHROPIC_API_KEY` to auto-register an **`opus`** builtin
  (Claude Opus 4.7); `ANTHROPIC_BASE_URL` overrides the endpoint.
- **`cli`** — drive a local agent harness read-only as a subprocess:
  `claude`, `codex`, `cursor-agent`, `gemini`, `agy`, `kimi`. Each runs in its
  read-only mode with config/MCP isolation, in its own process group (timeouts
  kill the group), with empty-output-as-failure and secret/path redaction. CLI
  models are opt-in via `MULTIPOLY_<K>_ENABLED=1`.

Custom models accept `MULTIPOLY_<K>_TRANSPORT` plus transport-specific env. A
new **`MULTIPOLY_MODELS_FILE`** declares models from an explicit JSON path
(never auto-loaded from cwd; no secrets, no argv).

**⚠️ Breaking — Composer migration.** Composer 2.5 has no HTTP API (the old
HTTP form never worked); it is now a `cursor-agent` cli model and is **off by
default**. Setting only `MULTIPOLY_COMPOSER_API_KEY` no longer configures it —
opt in with `MULTIPOLY_COMPOSER_ENABLED=1` (requires `cursor-agent` installed,
authenticated, with an unlocked macOS keychain).

**Trust boundary (cli, repo cwd).** By default a cli agent runs in the repo
working directory and may read the entire workspace, including files multipoly
never gathered or secret-scanned (the pre-flight scan covers only the gathered
payload). Set `MULTIPOLY_<K>_CWD=temp` for an isolated empty cwd.

### Council synthesis is now opt-in (defer-to-harness by default)

`council_review` / `council_consult` previously always merged member outputs
server-side with a hardcoded Qwen synthesizer, which failed when Qwen wasn't
configured. Now:

- **Default:** members run in parallel and their outputs are returned to the
  calling harness with a merge directive (review → per-member strict findings
  under `mode: "members"`; consult → markdown). No extra model call.
- **Opt-in server-side merge:** set `MULTIPOLY_SYNTHESIZER` (or pass a per-call
  `synthesizer`) to a model key. Resolution falls through
  `chosen → qwen → deepseek → glm → composer → any configured model`, picking the
  first configured one. `harness` / `none` / `caller` force defer mode.

### Added

- **Env-defined custom models** via `MULTIPOLY_MODELS` (comma-separated keys),
  each configured through `MULTIPOLY_<KEY>_{API_KEY,BASE_URL,MODEL,DISPLAY_NAME,THINKING}`.
  Custom models are exposed as `<key>_review`/`<key>_consult` tools and are
  selectable as council members or synthesizers — no code change required.
- `MULTIPOLY_SYNTHESIZER` server-wide setting for the default council synthesizer.

### Fixed

- A malformed legacy `GLM_ENDPOINT` no longer blocks startup for deployments
  that don't use GLM (it's only fatal when GLM is actually keyed).
- The `json_schema` → `json_object` fallback now also triggers when an
  OpenAI-compatible backend returns `200 OK` and then emits an unsupported
  `response_format` error inside the SSE stream (previously only a pre-stream
  HTTP 4xx triggered it).
- Council member outputs are now secret-scanned (including finding paths) before
  being relayed to a server-side synthesizer on another provider.

### Changed

- The error class is now `MultipolyError` (`GlmError` kept as a back-compat alias).
- Internal cleanup: extracted the parallel council-member runner, shared the
  council tool-schema fragment and `normalizeFindings`, removed dead shim modules
  and the legacy single-model client config branch, and added a test that keeps
  the advertised tool schemas in lockstep with runtime validation.
