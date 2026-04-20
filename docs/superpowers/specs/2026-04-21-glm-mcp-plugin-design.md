# GLM 5.1 MCP Plugin — Design Spec

**Date:** 2026-04-21
**Status:** Approved, ready for implementation.

## Purpose

Claude Code plugin that exposes an MCP server wrapping GLM 5.1 (via Z.AI's OpenAI-compatible API) so the main agent can delegate two classes of work:

1. **Code review** — on a git diff or a list of file paths, returning structured findings.
2. **Design consultation** — free-form question + optional attached files, for second opinions on hard problems.

Plus a `glm_freeform` escape hatch for arbitrary prompts.

The plugin is analogous to the official `openai-codex` plugin but targets GLM 5.1 via Z.AI.

## Non-goals (v1)

- Stateful conversation / multi-turn sessions
- Web search
- Opencode subprocess backend (opencode can be the MCP *client*, no wrapping needed)
- Patch application / auto-fix
- Auto-redaction of secrets (we refuse + require override instead)

## Package shape

Claude Code plugin at `~/dev/glm`:

```
glm/
├── .claude-plugin/plugin.json     # manifest + MCP server registration
├── commands/{glm-review,glm-consult,glm}.md
├── skills/glm-prompting/SKILL.md
├── scripts/glm-mcp.mjs            # MCP entrypoint
├── scripts/lib/*.mjs              # one module per concern
├── tests/*.test.mjs               # node:test
├── package.json                   # deps: @modelcontextprotocol/sdk only
└── README.md
```

Node ≥ 18, single runtime dep: `@modelcontextprotocol/sdk`. Uses native `fetch` for HTTP.

## MCP tool surface

Three specialized tools sharing one implementation core.

### `glm_review`
- Inputs (JSON Schema `oneOf` ensures exactly one of `diff_base`/`paths`):
  - `diff_base: string` — git ref; reviewer sees `git diff <base>...HEAD` plus inlined changed file contents.
  - `paths: string[]` — explicit file list (caller-supplied); each must resolve inside the repo root.
  - `focus?: string` — optional steering text ("focus on concurrency", "API design only").
- Output: one MCP text block containing JSON conforming to the review schema below.

### `glm_consult`
- Inputs: `prompt: string`, `paths?: string[]` (attached verbatim as context).
- Output: one MCP text block, markdown.

### `glm_freeform`
- Inputs: `prompt: string`.
- Output: one MCP text block, markdown.

## Review output schema

```json
{
  "schema_version": "1",
  "findings": [
    {
      "severity": "blocker | high | medium | low | nit",
      "path": "<repo-relative path>",
      "line": 42,
      "end_line": 50,
      "message": "...",
      "suggestion": "..."
    }
  ],
  "summary_md": "rendered markdown summary",
  "truncated": false,
  "files": [
    { "path": "src/foo.ts", "status": "inlined" },
    { "path": "src/huge.json", "status": "omitted", "reason": "over PER_FILE_CAP" },
    { "path": "src/later.ts", "status": "listed_only", "reason": "total-cap reached" }
  ]
}
```

Request sends `response_format: { type: "json_schema", json_schema: <schema> }`. If the server rejects with a specific "unsupported response_format" error, fall back to `{ type: "json_object" }` + strict system instruction. Post-parse schema validation in both phases. On parse/validate failure: one retry with a "JSON only, exact schema" prefix prepended; if still invalid, typed error with raw response attached.

## Git / FS safety

- All shell calls via `execFile` with arg arrays; no shell, no interpolation.
- `diff_base` validated: `git rev-parse --verify <base>^{commit}`; on failure typed error with message.
- Non-git workspace is fine for `paths` mode; fail-fast for `diff_base`.
- Detached HEAD is fine — diff and read operations work either way.
- All caller paths: `fs.realpath` then containment check against `git rev-parse --show-toplevel` (or `process.cwd()` if non-git in `paths` mode). Reject otherwise.
- Binaries skipped (MIME sniff of first 4 KiB; also `git diff --numstat` `-` sentinel).
- Caps (review mode):
  - `PER_FILE_CAP = 256 KiB`
  - `TOTAL_CAP = 1.5 MiB`
  - `FILE_COUNT_CAP = 50`
- Review mode is **atomic per file**: if file exceeds per-file cap → `status: "omitted"`; if adding it would cross total cap → `status: "listed_only"`. No mid-file truncation. `truncated: true` set whenever any omission occurs.
- Consult/freeform: oversized attached file → typed error (no silent trim).

## GLM client

- Endpoint profiles (selected via `GLM_ENDPOINT`):
  - `zai-coding-plan` (default) → `https://api.z.ai/api/coding/paas/v4`
  - `bigmodel-cn` → `https://open.bigmodel.cn/api/paas/v4`
  - `custom` → reads `GLM_BASE_URL`
- Auth: `GLM_API_KEY`, falling back to `ZHIPU_API_KEY` (matches opencode). Required at startup.
- Model: `GLM_MODEL`, default `glm-5.1`.
- Thinking:
  - `review` mode: on by default.
  - `consult`/`freeform`: off by default (sends `thinking: {type: "disabled"}`).
  - Override via `GLM_THINKING=on|off|auto` (auto = server default).
- Per-mode `max_tokens` (overridable):
  - `GLM_MAX_TOKENS_REVIEW=8192`
  - `GLM_MAX_TOKENS_CONSULT=16384`
  - `GLM_MAX_TOKENS_FREEFORM=16384`
- Timeout: `GLM_TIMEOUT_MS=300000`.

## SSE parser

Handles `\r\n`/`\r`/`\n`, multi-line `data:` joined with `\n`, `:` comment lines, `event:`/`id:`/`retry:` fields (captured, not required), UTF-8 split across chunks via streaming `TextDecoder`, top-level `{error: {...}}` payload (typed error, abort), `[DONE]` sentinel ends cleanly.

Accumulates `choices[0].delta.content`. `choices[0].delta.reasoning_content` is dropped by default; surfaced as a second text block when `GLM_DEBUG_REASONING=1`.

## Retry / error policy

- `401/403` → fail fast, no retry.
- `429` / `5xx` / network errors → exponential backoff `500ms × 2^n`, jitter, max 3 retries. Honor `Retry-After` header when present.
- Timeout → no retry, typed error.
- All errors carry a `correlation_id` in logs for grepping.

## Secret scanner

Pre-flight regex scan over the full outbound payload (diffs, files, prompt). Patterns:

- `AKIA[0-9A-Z]{16}` (AWS access key id)
- `aws_secret_access_key\s*=\s*["']?[A-Za-z0-9/+=]{40}["']?`
- `gh[pousr]_[A-Za-z0-9]{20,}` (GitHub)
- `xox[baprs]-[A-Za-z0-9-]{10,}` (Slack)
- `-----BEGIN (RSA|OPENSSH|EC|DSA|PRIVATE) (PRIVATE )?KEY-----` (PEM)
- `\bsk-[A-Za-z0-9_\-]{20,}\b` (OpenAI-style)
- Generic: `[A-Z][A-Z0-9_]*(API|SECRET|TOKEN|PASS(WORD)?)[A-Z0-9_]*\s*[:=]\s*["'][^"']{16,}["']`

On match: refuse with a typed error listing pattern name + `path:line`. **Matched secret bytes are never echoed** to output, stdout, or stderr. Override with `GLM_ALLOW_SECRETS=1`.

## Input validation

Each tool declares its input schema (JSON Schema) to the MCP runtime, including `glm_review`'s `oneOf` for `diff_base`/`paths`. Missing-required or mutually-exclusive violations fail at schema level with typed errors.

## Plugin UX

Slash commands (thin wrappers over the MCP tools):

- `/glm-review [base-ref]` → `glm_review { diff_base: arg ?? "main" }`
- `/glm-consult <question>` → `glm_consult { prompt: arg }`
- `/glm <prompt>` → `glm_freeform { prompt: arg }`

Skill `glm-prompting`: tells the main agent when to pick each mode (`review` for code diffs, `consult` for design questions + attached files, `freeform` only when neither fits).

## Env summary

| Var | Default | Required |
|---|---|---|
| `GLM_API_KEY` | — | yes (or `ZHIPU_API_KEY`) |
| `ZHIPU_API_KEY` | — | fallback for `GLM_API_KEY` |
| `GLM_MODEL` | `glm-5.1` | no |
| `GLM_ENDPOINT` | `zai-coding-plan` | no |
| `GLM_BASE_URL` | — | only with `GLM_ENDPOINT=custom` |
| `GLM_THINKING` | mode-default | no |
| `GLM_MAX_TOKENS_REVIEW` | 8192 | no |
| `GLM_MAX_TOKENS_CONSULT` | 16384 | no |
| `GLM_MAX_TOKENS_FREEFORM` | 16384 | no |
| `GLM_TIMEOUT_MS` | 300000 | no |
| `GLM_ALLOW_SECRETS` | 0 | no |
| `GLM_DEBUG_REASONING` | 0 | no |
