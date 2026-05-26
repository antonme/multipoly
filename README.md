# multipoly - multimodel MCP plugin

Multipoly exposes multiple coding models through one MCP server. It supports direct model-specific review/consult tools and council tools that run multiple models in parallel and, by default, hand their outputs back to the calling harness to synthesize (or merge server-side with a configured synthesizer model).

## Tools

| Tool family | Purpose |
|---|---|
| `glm_review`, `qwen_review`, `deepseek_review`, `composer_review` | Structured code review from one model |
| `glm_consult`, `qwen_consult`, `deepseek_consult`, `composer_consult` | Design/implementation consultation from one model |
| `council_review`, `council_consult` | Parallel member calls; harness-side synthesis by default, or server-side with a configured synthesizer |

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

Compatibility aliases are accepted for API keys: GLM also accepts `GLM_API_KEY` and `ZHIPU_API_KEY`; Qwen accepts `QWEN_API_KEY`; DeepSeek accepts `DEEPSEEK_API_KEY`; Composer accepts `COMPOSER_API_KEY`.

### Custom models

Beyond the four builtins, you can register additional models without code changes via `MULTIPOLY_MODELS` (comma-separated keys). Each custom key `<K>` (lowercase, starting with a letter; may not collide with a builtin or the reserved words `harness`/`none`/`caller`) is configured from:

| Env | Required | Notes |
|---|---|---|
| `MULTIPOLY_<K>_API_KEY` | yes | |
| `MULTIPOLY_<K>_BASE_URL` | yes | https (http allowed only for loopback) |
| `MULTIPOLY_<K>_MODEL` | yes | upstream model id |
| `MULTIPOLY_<K>_DISPLAY_NAME` | no | defaults to the key |
| `MULTIPOLY_<K>_THINKING` | no | `1`/`true` if the model accepts the `thinking` request field |

For example, `MULTIPOLY_MODELS=kimi` plus `MULTIPOLY_KIMI_API_KEY`/`_BASE_URL`/`_MODEL` exposes `kimi_review`, `kimi_consult`, and makes `kimi` selectable as a council member or synthesizer. A custom model missing a required field is simply left unconfigured (not fatal), exactly like a builtin.

Server-wide settings:

| Var | Default | Notes |
|---|---|---|
| `MULTIPOLY_THINKING` | mode-default | `on` / `off` / `auto`. Default: on for review, off for consult. |
| `MULTIPOLY_SYNTHESIZER` | (unset) | Default council synthesizer: a model key (`glm`/`qwen`/`deepseek`/`composer`), or `harness`/`none`/`caller` to defer to the calling harness. Unset = defer. Overridable per-call. |
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

`MULTIPOLY_THINKING` is only sent to models that declare support for the `thinking` request field; currently that is the GLM profile. Non-GLM profiles omit the field even when the server-wide setting is `on`.

The 131072 token default is GLM-specific. Non-GLM profiles omit `max_tokens` by default so their provider default applies. Set `MULTIPOLY_MAX_TOKENS_REVIEW` / `MULTIPOLY_MAX_TOKENS_CONSULT` to apply one cap to every model, or use model-specific caps such as `MULTIPOLY_QWEN_MAX_TOKENS_REVIEW` and `MULTIPOLY_QWEN_MAX_TOKENS_CONSULT`.

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
  "synthesizer": "qwen",        // optional — see below
  "include_individual_results": false
}
```

`models` defaults to all configured models.

**Synthesis** is opt-in. By default — when no `synthesizer` argument is passed and `MULTIPOLY_SYNTHESIZER` is unset — the council runs the members in parallel and returns each member's output (per-member strict findings for review, answers for consult) plus a merge directive, leaving the final synthesis to the calling harness model. No extra model call is made.

To merge server-side instead, set a `synthesizer`:

- A model key (`glm`, `qwen`, `deepseek`, `composer`) runs that model as the synthesizer. If the named model isn't configured, resolution falls through the chain `chosen → qwen → deepseek → glm → composer` and uses the first configured model.
- `harness` / `none` / `caller` forces the default defer-to-harness behavior even when `MULTIPOLY_SYNTHESIZER` names a model.

The per-call `synthesizer` argument overrides the `MULTIPOLY_SYNTHESIZER` env default. When server-side synthesis runs, member outputs are re-scanned for secrets before being sent to the synthesizer provider.

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
