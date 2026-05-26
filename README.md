# multipoly - multimodel MCP plugin

Multipoly exposes multiple coding models through one MCP server. It supports direct model-specific review/consult tools and council tools that run multiple models in parallel and synthesize with Qwen.

## Tools

| Tool family | Purpose |
|---|---|
| `glm_review`, `qwen_review`, `deepseek_review`, `composer_review` | Structured code review from one model |
| `glm_consult`, `qwen_consult`, `deepseek_consult`, `composer_consult` | Design/implementation consultation from one model |
| `council_review`, `council_consult` | Parallel member calls plus Qwen synthesis |

## Install

### Local Development

```sh
cd ~/dev/multipoly
npm install
MULTIPOLY_GLM_API_KEY=dummy npm run health
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

### With Opencode

Opencode is an MCP client. Register the same MCP server via opencode's MCP config:

```sh
opencode mcp add multipoly -- node /Users/anton/dev/multipoly/scripts/multipoly-mcp.mjs
```

## Configuration

Configure any subset of models. A model-specific tool returns a typed config error when its model is not configured. Council tools default to all configured models and require at least two successful member results.

| Model | Required env |
|---|---|
| GLM | `MULTIPOLY_GLM_API_KEY`; optional `MULTIPOLY_GLM_BASE_URL`, `MULTIPOLY_GLM_MODEL` |
| Qwen | `MULTIPOLY_QWEN_API_KEY`, `MULTIPOLY_QWEN_BASE_URL`; optional `MULTIPOLY_QWEN_MODEL` |
| DeepSeek | `MULTIPOLY_DEEPSEEK_API_KEY`, `MULTIPOLY_DEEPSEEK_BASE_URL`; optional `MULTIPOLY_DEEPSEEK_MODEL` |
| Composer | `MULTIPOLY_COMPOSER_API_KEY`, `MULTIPOLY_COMPOSER_BASE_URL`; optional `MULTIPOLY_COMPOSER_MODEL` |

GLM also accepts legacy `GLM_API_KEY` and `ZHIPU_API_KEY` for compatibility.

Server-wide settings:

| Var | Default | Notes |
|---|---|---|
| `MULTIPOLY_THINKING` | mode-default | `on` / `off` / `auto`. Default: on for review, off for consult. |
| `MULTIPOLY_MAX_TOKENS_REVIEW` | 131072 | Output-token cap for review and council review synthesis. |
| `MULTIPOLY_MAX_TOKENS_CONSULT` | 131072 | Output-token cap for consult and council consult synthesis. |
| `MULTIPOLY_TIMEOUT_MS` | 600000 | Upstream stream inactivity timeout in ms, range `[1, 3600000]`. |
| `MULTIPOLY_PROGRESS` | `heartbeat` | `off`, `heartbeat`, or `reasoning` progress output on stderr. |
| `MULTIPOLY_PER_FILE_CAP_BYTES` | 262144 | Review mode: files larger than this are omitted. |
| `MULTIPOLY_TOTAL_CAP_BYTES` | 1572864 | Review mode: total bytes of inlined content. |
| `MULTIPOLY_FILE_COUNT_CAP` | 50 | Review mode file count cap. |
| `MULTIPOLY_ALLOW_SECRETS` | 0 | Override the secret scanner after explicit user consent. |
| `MULTIPOLY_DEBUG_REASONING` | 0 | Surface `reasoning_content` as a second text block. |

Legacy `GLM_*` names are still accepted for server-wide settings during migration.

## Tool Reference

### Review Tools

```jsonc
// Either diff_base OR paths, exactly one:
{
  "diff_base": "main",
  "focus": "concurrency safety",
  "timeout_ms": 540000
}
```

```jsonc
{
  "paths": ["src/foo.ts", "src/bar.ts"],
  "focus": "API shape",
  "timeout_ms": 540000
}
```

Returns JSON:

```jsonc
{
  "schema_version": "1",
  "model": "qwen",
  "findings": [
    { "severity": "high", "path": "src/foo.ts", "line": 42, "message": "...", "suggestion": "..." }
  ],
  "summary_md": "## Summary\n- ...",
  "truncated": false,
  "files": [
    { "path": "src/foo.ts", "status": "inlined" },
    { "path": "vendor.min.js", "status": "omitted", "reason": "size 400000 > per-file cap 262144" }
  ]
}
```

### Consult Tools

```jsonc
{
  "prompt": "Is using a global lock here reasonable given X and Y?",
  "paths": ["src/lock.ts"],
  "timeout_ms": 540000
}
```

Returns markdown.

### Council Tools

Council tools accept the same review/consult arguments plus:

```jsonc
{
  "models": ["glm", "qwen"],
  "synthesizer": "qwen",
  "include_individual_results": false
}
```

`models` defaults to all configured models. `synthesizer` defaults to `qwen`.

## Client-Side Timeout

`MULTIPOLY_TIMEOUT_MS` / `timeout_ms` only govern the model upstream HTTP stream. The MCP client that launched this server enforces its own separate tool-call timeout, and long thinking reviews can exceed a client default.

| Client | Setting | Default | How to raise |
|---|---|---|---|
| Codex CLI | `tool_timeout_sec` under `[mcp_servers.<id>]` in `~/.codex/config.toml` | 60s | Set `tool_timeout_sec = 600` |
| Claude Code | `MCP_TOOL_TIMEOUT` env in ms | about 60s | Export `MCP_TOOL_TIMEOUT=600000` |

Example `~/.codex/config.toml`:

```toml
[mcp_servers.multipoly]
command = "node"
args = ["/Users/anton/dev/multipoly/scripts/multipoly-mcp.mjs"]
startup_timeout_sec = 15
tool_timeout_sec = 600
```

If the client kills the call first, no server-side setting can save it. Raise the client timeout, lower `timeout_ms` to fail fast, or split the review into smaller calls.

## Slash Commands

- `/glm-review [base-ref]`, `/qwen-review [base-ref]`, `/deepseek-review [base-ref]`, `/composer-review [base-ref]`
- `/glm-consult <question>`, `/qwen-consult <question>`, `/deepseek-consult <question>`, `/composer-consult <question>`
- `/council-review [base-ref]`
- `/council-consult <question>`

## Safety

- All git/file operations use `execFile` with arg arrays, real-path containment against the repo root, atomic per-file caps, and binary detection.
- Payloads are pre-scanned for common secret shapes. Hits refuse the request by default; matched bytes are never echoed to output or logs. Override only with explicit user consent.
- All HTTP calls use an `AbortController` timeout; 401/403 fail fast, and 429/5xx use exponential backoff with bounded `Retry-After` handling.

## Development

```sh
npm test
npm run health
npm run start
```

## Status

v0.1.0 - multimodel fork in active development. See `docs/superpowers/specs/` for design context and `docs/superpowers/plans/` for the implementation plan.
