# Multipoly — Claude Code multimodel MCP plugin

Use multiple coding models from Claude Code (or any other MCP-aware client, e.g. opencode) for code review, design consultation, and council-style synthesis. This baseline still exposes the inherited GLM-backed tools while the multimodel behavior is built out.

Three tools:

| Tool | Purpose | Output |
|---|---|---|
| `glm_review` | Structured code review over a git diff or file list | JSON |
| `glm_consult` | Second opinion on a design/implementation question, with optional attached files | Markdown |
| `glm_freeform` | Free-form single-shot prompt (escape hatch) | Markdown |

## Install

### Local (for development on this repo)

```sh
cd ~/dev/multipoly
npm install
# Health check (validates env and endpoint resolution)
node scripts/multipoly-mcp.mjs --health
```

Register with Claude Code:

```sh
claude mcp add multipoly -- node /Users/anton/dev/multipoly/scripts/multipoly-mcp.mjs
```

Or register as a local plugin in `~/.claude/settings.json`:

```json
{
  "plugins": {
    "multipoly": { "path": "/Users/anton/dev/multipoly" }
  }
}
```

### With opencode

Opencode is an MCP client. Register the same MCP server via opencode's MCP config (see `opencode mcp add --help`):

```sh
opencode mcp add multipoly -- node /Users/anton/dev/multipoly/scripts/multipoly-mcp.mjs
```

## Configuration

All via env vars. Required: an API key.

| Var | Default | Notes |
|---|---|---|
| `GLM_API_KEY` | — | Required (or use `ZHIPU_API_KEY`). |
| `ZHIPU_API_KEY` | — | Fallback for `GLM_API_KEY` — matches opencode's convention so existing setups work. |
| `GLM_MODEL` | `glm-5.1` | Any Z.AI or Bigmodel model id. |
| `GLM_ENDPOINT` | `zai-coding-plan` | One of `zai-coding-plan`, `bigmodel-cn`, `custom`. |
| `GLM_BASE_URL` | — | Required when `GLM_ENDPOINT=custom`. |
| `GLM_THINKING` | mode-default | `on` / `off` / `auto`. Default: on for review, off for consult/freeform. |
| `GLM_MAX_TOKENS_REVIEW` | 131072 | GLM 5.1's published output ceiling. Reasoning + content share this budget in thinking mode. |
| `GLM_MAX_TOKENS_CONSULT` | 131072 | |
| `GLM_MAX_TOKENS_FREEFORM` | 131072 | |
| `GLM_TIMEOUT_MS` | 600000 | Inactivity timeout (ms), range `[1, 3600000]`. The timer fires only if the upstream goes silent for this long; every SSE chunk (including reasoning deltas) resets it. A long-thinking review that keeps streaming will not trip it. Overridable per call via the `timeout_ms` argument. **This bounds only the GLM↔upstream stream — the MCP client (Claude Code / Codex / opencode) imposes its own tool-call timeout on top; see [Client-side timeout](#client-side-timeout).** |
| `GLM_PROGRESS` | `heartbeat` | Live progress on stderr: `off` (silent), `heartbeat` (short summary every 3s), `reasoning` (streams the model's thinking tokens as they arrive). |
| `GLM_PER_FILE_CAP_BYTES` | 262144 | Review mode: files larger than this are omitted. |
| `GLM_TOTAL_CAP_BYTES` | 1572864 | Review mode: total bytes of inlined content. |
| `GLM_FILE_COUNT_CAP` | 50 | Review mode. |
| `GLM_ALLOW_SECRETS` | 0 | Override the secret scanner (unsafe). |
| `GLM_DEBUG_REASONING` | 0 | Surface `reasoning_content` as a second text block. |

The plugin will work out of the box if you already use opencode with Z.AI:

```sh
# Already-exported opencode env is enough
export ZHIPU_API_KEY="$(opencode ... )"  # or however you set it
```

## Tool reference

### `glm_review`

```jsonc
// Either diff_base OR paths (exactly one):
{
  "diff_base": "main",          // diff HEAD against this ref
  "focus": "concurrency safety" // optional steering
}
// or
{
  "paths": ["src/foo.ts", "src/bar.ts"],
  "focus": "API shape",
  "timeout_ms": 540000 // optional per-call inactivity timeout override
}
```

All three tools accept an optional `timeout_ms` (integer, `[1, 3600000]`) that overrides `GLM_TIMEOUT_MS` for that single call.

Returns JSON:

```jsonc
{
  "schema_version": "1",
  "findings": [
    { "severity": "high", "path": "src/foo.ts", "line": 42, "message": "…", "suggestion": "…" }
  ],
  "summary_md": "## Summary\n- …",
  "truncated": false,
  "files": [
    { "path": "src/foo.ts", "status": "inlined" },
    { "path": "vendor.min.js", "status": "omitted", "reason": "size 400000 > per-file cap 262144" }
  ]
}
```

### `glm_consult`

```jsonc
{
  "prompt": "Is using a global lock here reasonable given X and Y?",
  "paths": ["src/lock.ts"], // optional attached context
  "timeout_ms": 540000      // optional
}
```

Returns markdown.

### `glm_freeform`

```jsonc
{ "prompt": "…", "timeout_ms": 540000 /* optional */ }
```

Returns markdown.

## Client-side timeout

`GLM_TIMEOUT_MS` / `timeout_ms` only govern the GLM↔upstream HTTP stream. The
MCP **client** that launched this server enforces its own, separate tool-call
timeout — and a long GLM 5.1 thinking review can easily exceed a client default:

| Client | Setting | Default | How to raise |
|---|---|---|---|
| **Codex CLI** | `tool_timeout_sec` under `[mcp_servers.<id>]` in `~/.codex/config.toml` | 60s | Set `tool_timeout_sec = 600` (seconds, not ms) |
| Claude Code | `MCP_TOOL_TIMEOUT` env (ms) | ~60s | Export `MCP_TOOL_TIMEOUT=600000` |

Example `~/.codex/config.toml`:

```toml
[mcp_servers.multipoly]
command = "node"
args = ["/Users/anton/dev/multipoly/scripts/multipoly-mcp.mjs"]
startup_timeout_sec = 15
tool_timeout_sec = 600
```

If the client kills the call first, no server-side setting can save it —
raise the client timeout, lower `timeout_ms` to fail fast, or split the
review into smaller calls.

## Slash commands

- `/glm-review [base-ref]` — defaults to `main`.
- `/glm-consult <question>` — open-ended consultation.
- `/glm <prompt>` — escape hatch.

## Safety

- All git/file operations use `execFile` with arg arrays (no shell), real-path containment against the repo root, atomic-per-file caps, and binary detection.
- Payloads are pre-scanned for common secret shapes (AWS, GH, Slack, PEM, generic API_KEY). Hits refuse the request by default; matched bytes are never echoed to output or logs. Override with `GLM_ALLOW_SECRETS=1`.
- All HTTP calls use an `AbortController` timeout; 401/403 fail fast, 429/5xx use exponential backoff (max 3 retries) honoring `Retry-After`.

## Development

```sh
npm test        # node:test against pure modules + git-backed fixtures
npm run health  # load config + print redacted summary
npm run start   # launch the MCP server over stdio (for piping tests)
```

## Status

v0.1.0 — initial release. See `docs/superpowers/specs/` for the design spec and `docs/superpowers/plans/` for the implementation plan.
