# multipoly - multimodel MCP plugin

Multipoly exposes multiple coding models through one MCP server. It supports direct model-specific review/consult tools and council tools that run multiple models in parallel and, by default, hand their outputs back to the calling harness to synthesize (or merge server-side with a configured synthesizer model).

## Tools

| Tool family | Purpose |
|---|---|
| `<model>_review` (`glm`, `qwen`, `deepseek`, `composer`, `opus`, …) | Structured code review from one model |
| `<model>_consult` | Design/implementation consultation from one model |
| `council_review`, `council_consult` | Parallel member calls; harness-side synthesis by default, or server-side with a configured synthesizer |

Tools are generated per configured model — builtins, the `opus` Anthropic model (when `ANTHROPIC_API_KEY` is set), CLI agents, and any custom/registry-file models all expose `<key>_review` / `<key>_consult`. See [Transports](#transports).

## Install

### Local Development

```sh
cd ~/dev/multipoly
npm install
MULTIPOLY_GLM_API_KEY=dummy npm run health
```

Register with Claude Code:

```sh
claude mcp add multipoly -- node /path/to/multipoly/scripts/multipoly-mcp.mjs
```

Or register as a local plugin in `~/.claude/settings.json`:

```json
{
  "plugins": {
    "multipoly": { "path": "/path/to/multipoly" }
  }
}
```

### With Opencode

Opencode is an MCP client. Register the same MCP server via opencode's MCP config:

```sh
opencode mcp add multipoly -- node /path/to/multipoly/scripts/multipoly-mcp.mjs
```

## Configuration

Configure any subset of models. A model-specific tool returns a typed config error when its model is not configured. Council tools default to all configured models and require at least two successful member results.

| Model | Transport | Required env |
|---|---|---|
| GLM | http | `MULTIPOLY_GLM_API_KEY`; optional `MULTIPOLY_GLM_BASE_URL`, `MULTIPOLY_GLM_MODEL` |
| Qwen | http | `MULTIPOLY_QWEN_API_KEY`, `MULTIPOLY_QWEN_BASE_URL`; optional `MULTIPOLY_QWEN_MODEL` |
| DeepSeek | http | `MULTIPOLY_DEEPSEEK_API_KEY`, `MULTIPOLY_DEEPSEEK_BASE_URL`; optional `MULTIPOLY_DEEPSEEK_MODEL` |
| Composer | cli (cursor) | `MULTIPOLY_COMPOSER_ENABLED=1`; runs via `cursor-agent` (see [Transports](#transports)) |
| Opus | anthropic | `ANTHROPIC_API_KEY` (auto-registered as `opus` when present) |

Compatibility aliases are accepted for API keys: GLM also accepts `GLM_API_KEY` and `ZHIPU_API_KEY`; Qwen accepts `QWEN_API_KEY`; DeepSeek accepts `DEEPSEEK_API_KEY`. Opus also accepts `MULTIPOLY_OPUS_API_KEY`.

> **Migration (Composer):** Composer 2.5 has no HTTP API and the old HTTP form never worked. Composer is now a `cursor-agent` CLI model and is **off by default**. Setting only `MULTIPOLY_COMPOSER_API_KEY` no longer configures it — opt in with `MULTIPOLY_COMPOSER_ENABLED=1` and ensure `cursor-agent` is installed and authenticated. See [Transports](#transports).

### Custom models

Beyond the four builtins, you can register additional models without code changes via `MULTIPOLY_MODELS` (comma-separated keys). Each custom key `<K>` (lowercase, starting with a letter; may not collide with a builtin or the reserved words `harness`/`none`/`caller`) is configured from:

| Env | Required | Notes |
|---|---|---|
| `MULTIPOLY_<K>_TRANSPORT` | no | `http` (default), `anthropic`, or `cli` — see [Transports](#transports) |
| `MULTIPOLY_<K>_API_KEY` | http/anthropic | |
| `MULTIPOLY_<K>_BASE_URL` | http (yes), anthropic (no) | https (http allowed only for loopback); anthropic defaults to `https://api.anthropic.com` |
| `MULTIPOLY_<K>_MODEL` | http/anthropic (yes), cli (no) | upstream model id |
| `MULTIPOLY_<K>_DISPLAY_NAME` | no | defaults to the key |
| `MULTIPOLY_<K>_THINKING` | no | `1`/`true` if the model accepts the `thinking` request field |

For example, `MULTIPOLY_MODELS=kimi` plus `MULTIPOLY_KIMI_API_KEY`/`_BASE_URL`/`_MODEL` exposes `kimi_review`, `kimi_consult`, and makes `kimi` selectable as a council member or synthesizer. A custom model missing a required field is simply left unconfigured (not fatal), exactly like a builtin.

For `anthropic` and `cli` custom models, see the per-transport env in [Transports](#transports).

Server-wide settings:

| Var | Default | Notes |
|---|---|---|
| `MULTIPOLY_REASONING_EFFORT` | (per-model default) | `off\|low\|medium\|high\|xhigh` — server-wide effort baseline for all models. |
| `MULTIPOLY_THINKING` | `auto` | Coarse alias: `on` → `medium` effort, `off` → `off`, `auto` → inherit. `MULTIPOLY_REASONING_EFFORT` takes precedence when both are set. |
| `MULTIPOLY_SYNTHESIZER` | (unset) | Default council synthesizer: any active model key (`glm`/`qwen`/`deepseek`/`composer`/`opus`/custom), or `harness`/`none`/`caller` to defer to the calling harness. Unset = defer. Overridable per-call. |
| `MULTIPOLY_MAX_TOKENS_REVIEW` | 131072 | Output-token cap for review and council review synthesis. |
| `MULTIPOLY_MAX_TOKENS_CONSULT` | 131072 | Output-token cap for consult and council consult synthesis. |
| `MULTIPOLY_TIMEOUT_MS` | 600000 | Upstream stream inactivity timeout in ms, range `[1, 3600000]`. |
| `MULTIPOLY_PROGRESS` | `heartbeat` | `off`, `heartbeat`, or `reasoning` progress output on stderr. |
| `MULTIPOLY_PER_FILE_CAP_BYTES` | 262144 | Review mode: files larger than this are omitted. |
| `MULTIPOLY_TOTAL_CAP_BYTES` | 1572864 | Review mode: total bytes of inlined content. |
| `MULTIPOLY_FILE_COUNT_CAP` | 50 | Review mode file count cap. |
| `MULTIPOLY_ALLOW_SECRETS` | 0 | Override the secret scanner after explicit user consent. |
| `MULTIPOLY_DEBUG_REASONING` | 0 | Surface `reasoning_content` as a second text block. |

Per-model reasoning effort overrides (replace `<K>` with the uppercase model key, e.g. `GLM`):

| Var | Notes |
|---|---|
| `MULTIPOLY_<K>_REASONING_EFFORT` | Per-model effort, overrides server-wide `MULTIPOLY_REASONING_EFFORT`. |
| `MULTIPOLY_<K>_THINKING` | Per-model coarse alias (same mapping as the server-wide `MULTIPOLY_THINKING`). |

Legacy `GLM_*` names are still accepted for server-wide settings during migration. `GLM_THINKING` (without the `MULTIPOLY_` prefix) is accepted as a per-GLM override only, and never leaks to other models.

The 131072 token default is GLM-specific. Non-GLM profiles omit `max_tokens` by default so their provider default applies. Set `MULTIPOLY_MAX_TOKENS_REVIEW` / `MULTIPOLY_MAX_TOKENS_CONSULT` to apply one cap to every model, or use model-specific caps such as `MULTIPOLY_QWEN_MAX_TOKENS_REVIEW` and `MULTIPOLY_QWEN_MAX_TOKENS_CONSULT`.

### Reasoning effort

Every model that supports graded reasoning exposes a `reasoning_effort` argument on its `_review` and `_consult` tools (`off|low|medium|high|xhigh`). Omitting it uses the per-model default.

**Per-model defaults:**

| Model | Default effort | Backend mechanism |
|---|---|---|
| `glm` | `high` | `thinking: {type: "enabled"\|"disabled"}` toggle |
| `qwen` | `high` | `enable_thinking` + `thinking_budget` |
| `deepseek` | `high` | `reasoning_effort` (`high`/`max`) |
| `opus` | `xhigh` | `output_config.effort` + `thinking: {type: "adaptive"}` |
| `composer` | `off` | no reasoning control (cursor-agent) |

**Precedence order (highest to lowest):**

1. Per-call `reasoning_effort` tool argument
2. Per-model env `MULTIPOLY_<K>_REASONING_EFFORT`
3. Per-model env `MULTIPOLY_<K>_THINKING` (coarse alias)
4. Server-wide `MULTIPOLY_REASONING_EFFORT`
5. Server-wide `MULTIPOLY_THINKING` (coarse alias)
6. Per-model baked default (table above)

Models with `CAPABILITY.NONE` (e.g. `composer`) do not expose the `reasoning_effort` argument and ignore all effort settings.

> **Note:** The old review-on / consult-off "mode-default" asymmetry was retired. All modes now use the same per-model default effort. Use `MULTIPOLY_REASONING_EFFORT=off` if you want to disable reasoning server-wide.

## Transports

Every model is reached over one of three transports, behind a single model
contract — review, consult, and council work the same regardless of transport.

| Transport | How the model is reached | Auth | Cost/usage |
|---|---|---|---|
| `http` | OpenAI-compatible streaming `/chat/completions` (the default) | `MULTIPOLY_<K>_API_KEY` bearer | reported by the provider |
| `anthropic` | Native Anthropic Messages API `/v1/messages` | `x-api-key` (`ANTHROPIC_API_KEY`) | real token usage (incl. cache) |
| `cli` | A local agent CLI run read-only as a subprocess | the agent's own login / an env token | **unknown** (consumes your subscription) |

### Anthropic (`opus` + custom)

Set `ANTHROPIC_API_KEY` and an `opus` model (Claude Opus 4.7) is auto-registered
as `opus_review` / `opus_consult` and becomes council-selectable. Override the
endpoint with `ANTHROPIC_BASE_URL`. Review JSON uses Anthropic's native
structured outputs; if the endpoint rejects the schema, it transparently falls
back to prompt-instructed JSON. Anthropic requires `max_tokens`; when no
model-specific cap is set it defaults to 16384 — raise
`MULTIPOLY_OPUS_MAX_TOKENS_REVIEW` (or the server-wide cap) for large reviews.

Opus 4.7 uses Anthropic's `output_config.effort` + `thinking: {type: "adaptive"}` mechanism (no `budget_tokens`). Effort defaults to `xhigh`; override per-call or via `MULTIPOLY_OPUS_REASONING_EFFORT`. Review mode attempts to send the JSON schema alongside the effort in `output_config`; if the endpoint rejects the format field, it falls back to prompt-instructed JSON while keeping the effort setting. If reasoning is set to `off`, the thinking field is omitted entirely.
A custom anthropic model:

```
MULTIPOLY_MODELS=haiku
MULTIPOLY_HAIKU_TRANSPORT=anthropic
MULTIPOLY_HAIKU_API_KEY=...      # or rely on ANTHROPIC_API_KEY via the file registry
MULTIPOLY_HAIKU_MODEL=claude-haiku-4-5
```

### CLI agents (Claude Code, Codex, Cursor/Composer, Gemini, agy, Kimi)

A `cli` model shells out to a local agent in its **read-only** mode. Each kind
also runs with config/MCP isolation so the spawned agent can't auto-load your
operator MCP servers or rules. CLI models are **opt-in** (`MULTIPOLY_<K>_ENABLED=1`).

| `cliKind` | Binary | Read-only mode | Auth |
|---|---|---|---|
| `claude` | `claude` | `--tools ""` (no tools) + `--strict-mcp-config` | OAuth (preserved) |
| `codex` | `codex` | `--sandbox read-only` + isolated `CODEX_HOME` | login / `OPENAI_API_KEY` |
| `cursor` | `cursor-agent` | `--mode plan` | `CURSOR_API_KEY` — **needs an unlocked macOS keychain** |
| `gemini` | `gemini` | `--approval-mode plan` + workspace-trust env | OAuth / `GEMINI_API_KEY` |
| `agy` | `agy` | weak sandbox only — **opt-in unsafe** (`MULTIPOLY_<K>_UNSAFE=1`) | gemini OAuth |
| `kimi` | `kimi` | `--print --plan` (`--print` implies auto-run, so `--plan` is mandatory) | `kimi login` / `KIMI_API_KEY` |

Per-cli env (`<K>` is the model key, e.g. `COMPOSER`):

| Env | Notes |
|---|---|
| `MULTIPOLY_<K>_ENABLED` | `1` to enable (required — cli models are off by default) |
| `MULTIPOLY_<K>_CLI_KIND` | one of the kinds above (builtin `composer` is fixed to `cursor`) |
| `MULTIPOLY_<K>_MODEL` | the `--model`/`-m` value |
| `MULTIPOLY_<K>_CLI` | override the binary path |
| `MULTIPOLY_<K>_AUTH_TOKEN_ENV` | name of an env var the agent needs (e.g. `CURSOR_API_KEY`); presence is checked before spawning |
| `MULTIPOLY_<K>_CWD` | `repo` (default) or `temp` — see the trust boundary below |
| `MULTIPOLY_<K>_UNSAFE` | `1`, required for `agy` (no real read-only mode) |
| `MULTIPOLY_<K>_REASONING_EFFORT` | override reasoning effort for this cli model |
| `MULTIPOLY_<K>_TIMEOUT_MS` | per-model timeout override |

> **⚠️ Trust boundary (cli, repo cwd).** By default a cli agent runs in the
> **repo working directory** so it can explore beyond the files multipoly
> gathered (a richer review). This means **the agent may read the entire
> workspace, including files multipoly never gathered or secret-scanned** (e.g.
> `.env`, private keys) — the pre-flight secret scan only covers the
> gathered/inlined payload. A prompt-injected instruction inside reviewed code
> could direct the agent to read such a file. The agent runs read-only, so it
> can't exfiltrate via writes, but treat its output accordingly. Set
> `MULTIPOLY_<K>_CWD=temp` to run the agent in an isolated empty directory
> instead (tighter boundary, no repo exploration). CLI agents also consume your
> local subscription/quota, and their token usage is reported as unknown.

> **macOS keychain (cursor).** `cursor-agent` reads `CURSOR_API_KEY` from the
> login keychain; on a headless/locked session it fails to authenticate.

Notes from live verification:

- **codex** runs in an isolated `CODEX_HOME` (the operator's config/MCP/rules
  don't auto-load); its `auth.json` is copied in so login still works. A
  ChatGPT-account codex rejects unsupported model ids — set
  `MULTIPOLY_<K>_MODEL` to a model your account allows (the codex default works).
- **kimi** model ids look like `kimi-code/kimi-for-coding`; output uses
  `--quiet` so only the final message is returned.
- **gemini**'s prompt is passed on argv (`-p`), so prefer another transport for
  very large reviews.

Example — enable codex as a council-eligible cli model:

```
MULTIPOLY_MODELS=cdx
MULTIPOLY_CDX_TRANSPORT=cli
MULTIPOLY_CDX_CLI_KIND=codex
MULTIPOLY_CDX_ENABLED=1
MULTIPOLY_CDX_MODEL=gpt-5.5
```

### JSON registry file

For declarative setups, point `MULTIPOLY_MODELS_FILE` at an explicit JSON path
(it is **never** auto-discovered from the cwd, since the server commonly runs
inside the repo under review). Entries merge with the env builtins. Secrets are
**not** allowed in the file — name env vars via `apiKeyEnv` / `authTokenEnv`;
there is no `argv` field (argv is built from the controlled `cliKind` recipe).

```jsonc
{
  "models": {
    "myopus": { "transport": "anthropic", "model": "claude-opus-4-7", "apiKeyEnv": "ANTHROPIC_API_KEY" },
    "mygem":  { "transport": "cli", "cliKind": "gemini", "model": "gemini-3-pro",
                "authTokenEnv": "GEMINI_API_KEY", "cwd": "temp", "enabled": true }
  }
}
```

Allowed entry fields: `transport`, `displayName`, `model`, `baseUrl`,
`apiKeyEnv`, `supportsThinking`, `cliKind`, `binary`, `authTokenEnv`, `cwd`,
`unsafe`, `reasoningEffort`, `reasoning`, `reasoningVocab`, `defaultEffort`,
`enabled`. Env vars override file-declared values.

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

- A model key (`glm`, `qwen`, `deepseek`, `composer`, `opus`, or a custom key) runs that model as the synthesizer. If the named model isn't configured, resolution falls through the chain `chosen → qwen → deepseek → glm → composer → any other configured model` and uses the first configured model.
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
args = ["/path/to/multipoly/scripts/multipoly-mcp.mjs"]
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
- CLI-transport agents run in their read-only mode with config/MCP isolation, in their own process group (timeouts kill the whole group), and surface errors with secrets/paths redacted. Note the [repo-cwd trust boundary](#transports): the pre-flight secret scan covers only the gathered payload, not the whole workspace a repo-cwd agent can read.
- The JSON registry file is loaded only from an explicit `MULTIPOLY_MODELS_FILE` path (never the cwd), rejects secret-bearing fields, and never accepts arbitrary argv.

## Development

```sh
npm test
npm run health
npm run start
```

## Status

v0.1.0 — multimodel fork in active development.
