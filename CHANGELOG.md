# Changelog

All notable changes to this project are documented here.

## Unreleased

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
