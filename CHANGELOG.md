# Changelog

All notable changes to this project are documented here.

## Unreleased

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
