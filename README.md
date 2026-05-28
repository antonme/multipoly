# multipoly - multimodel MCP plugin

Multipoly exposes multiple coding models through one MCP server. It supports direct model-specific review/consult tools and council tools that run multiple models in parallel and, by default, hand their outputs back to the calling harness to synthesize (or merge server-side with a configured synthesizer model).

## Tools

| Tool family | Purpose |
|---|---|
| `<model>_review` (`glm`, `qwen`, `deepseek`, `composer`, `claude`, `codex`, …) | Structured code review from one model |
| `<model>_consult` | Design/implementation consultation from one model |
| `opus_review`, `opus_consult` | Alias tools routed to `claude` (registered when `claude` is configured) |
| `gpt55_review`, `gpt55_consult` | Alias tools routed to `codex` (registered when `codex` is configured) |
| `council_review`, `council_consult` | Parallel member calls; harness-side synthesis by default, or server-side with a configured synthesizer |

Tools are generated per configured model — builtins, baked models opted-in via `MULTIPOLY_MODELS` (see below), CLI agents, and any custom/registry-file models all expose `<key>_review` / `<key>_consult`. See [Transports](#transports).

## Install

multipoly is a stdio MCP server — Node ≥18.18, no build step. Clone it, install
dependencies, and verify it starts:

```sh
git clone https://github.com/antonme/multipoly.git ~/dev/multipoly
cd ~/dev/multipoly
npm install
MULTIPOLY_GLM_API_KEY=dummy npm run health   # prints the resolved model registry; no network, no spend
```

`npm run health` (i.e. `node scripts/multipoly-mcp.mjs --health`) prints every
model and whether it is `configured`, **without spending any tokens** — use it to
validate a config before wiring it into a client.

### Example configuration

multipoly never reads a `.env` — every credential is passed to the server as an
environment variable by the client that launches it. A good starting council
(three API models + two local CLI agents) looks like this:

```sh
# ── API models (HTTP) ──
MULTIPOLY_GLM_API_KEY=<glm-key>              # GLM 5.1 — always on
MULTIPOLY_DEEPSEEK_API_KEY=<deepseek-key>    # DeepSeek
MULTIPOLY_DEEPSEEK_BASE_URL=https://api.deepseek.com

# ── Opt-in baked builtins: list the keys, then enable/key each one ──
MULTIPOLY_MODELS=gemini,grok,claude
MULTIPOLY_GEMINI_API_KEY=<gemini-key>        # Gemini — HTTP
MULTIPOLY_GROK_ENABLED=1                      # Grok Build — local CLI (run `grok login` once)
MULTIPOLY_CLAUDE_ENABLED=1                     # Claude Code — local CLI (OAuth)

# ── Optional: 60-min cap so slow CLI reviews aren't killed early ──
MULTIPOLY_TIMEOUT_MS=3600000
```

Each model exposes `<key>_review` / `<key>_consult` tools, and `council_review` /
`council_consult` **default to all configured models** — so the set above gives a
five-member council (`glm`, `deepseek`, `gemini`, `grok`, `claude`). See
[Configuration](#configuration) for the full env reference and
[Transports](#transports) for the CLI-agent auth details.

### Set up in Claude Code

Register at **user scope** (available in every project), passing each credential
as an `-e` flag:

```sh
claude mcp add multipoly -s user \
  -e MULTIPOLY_GLM_API_KEY=<glm-key> \
  -e MULTIPOLY_DEEPSEEK_API_KEY=<deepseek-key> \
  -e MULTIPOLY_DEEPSEEK_BASE_URL=https://api.deepseek.com \
  -e MULTIPOLY_MODELS=gemini,grok,claude \
  -e MULTIPOLY_GEMINI_API_KEY=<gemini-key> \
  -e MULTIPOLY_GROK_ENABLED=1 \
  -e MULTIPOLY_CLAUDE_ENABLED=1 \
  -- node /path/to/multipoly/scripts/multipoly-mcp.mjs
```

**Restart Claude Code afterwards** — MCP tools are loaded at startup, so new
`mcp__multipoly__*` tools (and council members) only appear after a relaunch.
Verify with `claude mcp get multipoly` or `/mcp`. To change the config later,
`claude mcp remove multipoly -s user` and re-add, or hand-edit the
`mcpServers.multipoly` block in `~/.claude.json`.

Alternatively, register it as a local plugin in `~/.claude/settings.json`:

```json
{
  "plugins": { "multipoly": { "path": "/path/to/multipoly" } }
}
```

### Set up in Codex

Codex (`codex-cli`) reads MCP servers from `~/.codex/config.toml`. Add an
`mcp_servers` entry with the same env values:

```toml
[mcp_servers.multipoly]
command = "node"
args = ["/path/to/multipoly/scripts/multipoly-mcp.mjs"]

[mcp_servers.multipoly.env]
MULTIPOLY_GLM_API_KEY = "<glm-key>"
MULTIPOLY_DEEPSEEK_API_KEY = "<deepseek-key>"
MULTIPOLY_DEEPSEEK_BASE_URL = "https://api.deepseek.com"
MULTIPOLY_MODELS = "gemini,grok,claude"
MULTIPOLY_GEMINI_API_KEY = "<gemini-key>"
MULTIPOLY_GROK_ENABLED = "1"
MULTIPOLY_CLAUDE_ENABLED = "1"
```

Or from the CLI (`--env` repeats per variable):

```sh
codex mcp add multipoly \
  --env MULTIPOLY_GLM_API_KEY=<glm-key> \
  --env MULTIPOLY_MODELS=gemini,grok,claude \
  --env MULTIPOLY_GEMINI_API_KEY=<gemini-key> \
  --env MULTIPOLY_GROK_ENABLED=1 \
  --env MULTIPOLY_CLAUDE_ENABLED=1 \
  -- node /path/to/multipoly/scripts/multipoly-mcp.mjs
```

Check it loaded with `codex mcp list` / `codex mcp get multipoly`. (Editing
`config.toml` keeps secrets out of your shell history — prefer it over `mcp add`
for credential-bearing servers.)

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

Compatibility aliases are accepted for API keys: GLM also accepts `GLM_API_KEY` and `ZHIPU_API_KEY`; Qwen accepts `QWEN_API_KEY`; DeepSeek accepts `DEEPSEEK_API_KEY`.

> **Migration (Composer):** Composer 2.5 has no HTTP API and the old HTTP form never worked. Composer is now a `cursor-agent` CLI model and is **off by default**. Setting only `MULTIPOLY_COMPOSER_API_KEY` no longer configures it — opt in with `MULTIPOLY_COMPOSER_ENABLED=1` and ensure `cursor-agent` is installed and authenticated. See [Transports](#transports).

### Baked builtins (opt-in)

`claude`, `codex`, `gemini`, `kimi`, `mimo`, and `grok` are **baked builtins** — they carry pre-configured capability metadata (transport, reasoning capability, default effort, base URL) but are **not registered by default**. Add them to `MULTIPOLY_MODELS` to enable their tools:

| Key | Default transport | Baked display name | Env override |
|---|---|---|---|
| `claude` | `cli` (flips to `anthropic` when an Anthropic key is present; see [claude transport-flip rule](#model-names--aliases)) | `opus (claude cli)` / `opus (api)` | `MULTIPOLY_CLAUDE_API_KEY`, `ANTHROPIC_API_KEY` |
| `codex` | `cli` | `gpt5.5 (codex cli)` | `MULTIPOLY_CODEX_API_KEY`, `OPENAI_API_KEY` |
| `gemini` | `http` | `gemini-3.5-flash (api)` | `MULTIPOLY_GEMINI_API_KEY`, `GEMINI_API_KEY` |
| `kimi` | `anthropic` | `kimi-k2.6 (api)` | `MULTIPOLY_KIMI_API_KEY`, `MOONSHOT_API_KEY` |
| `mimo` | `http` | `mimo-v2.5-pro (api)` | `MULTIPOLY_MIMO_API_KEY`, `XIAOMIMIMO_API_KEY` |
| `grok` | `cli` | `grok-build (grok cli)` | `MULTIPOLY_GROK_API_KEY`, `XAI_API_KEY` |

All env overrides from the custom-model table apply (`MULTIPOLY_<K>_TRANSPORT`, `_MODEL`, `_DISPLAY_NAME`, etc.). You no longer need to supply `MULTIPOLY_CLAUDE_DISPLAY_NAME` or `MULTIPOLY_CLAUDE_REASONING` — they are baked; env still overrides.

`mimo` (Xiaomi MiMo V2.5 Pro) uses the same reasoning capability class as GLM: a top-level `thinking:{type}` toggle with no graded effort — `off` disables thinking, any other effort value enables it (default `high`). It gets a minimum token floor of 8192 (review) / 4096 (consult) when no explicit cap is set, preventing empty-response failures. On the wire it sends `max_completion_tokens` instead of `max_tokens` (the MiMo API rejects the legacy field). To enable mimo, add it to `MULTIPOLY_MODELS` and supply a key — `XIAOMIMIMO_API_KEY` is recognized so existing deployments need no rename. The per-deployment `MULTIPOLY_MIMO_DISPLAY_NAME`, `_REASONING`, `_BASE_URL`, and `_MODEL` env vars are no longer needed (baked); keep only `MULTIPOLY_MIMO_MAX_TOKENS_*` if you tuned the token cap.

`grok` (xAI **Grok Build**) is a local coding-agent CLI, driven read-only like Claude Code/Codex. It is **cli-only** (no HTTP API is exposed here) and authenticates with the grok CLI's own OAuth — run `grok login` once; no API key env is required. Its `--effort` flag is graded and `xhigh`-native, so it shares Claude's effort class (default `xhigh`). multipoly's effort scale tops out at `xhigh` (which maps to `--effort xhigh`); grok's CLI also accepts a native `max`, but that level is not exposed through multipoly. To enable it: install the grok CLI, then add `grok` to `MULTIPOLY_MODELS` and set `MULTIPOLY_GROK_ENABLED=1` (cli models are off by default). The default model is `grok-build`; override with `MULTIPOLY_GROK_MODEL`.

> **Migration from `MULTIPOLY_OPUS_*`.** The standalone `opus` model is removed. Use `MULTIPOLY_MODELS=claude` instead, and rename `MULTIPOLY_OPUS_*` env vars to `MULTIPOLY_CLAUDE_*`. At startup the server emits a structured stderr warning naming any `MULTIPOLY_OPUS_*` or `MULTIPOLY_GPT55_*` vars it finds — their values are no longer used to configure a model and are ignored as credentials (use `MULTIPOLY_CLAUDE_*` / `MULTIPOLY_CODEX_*` instead). Note: the mere presence of `MULTIPOLY_OPUS_API_KEY` is still honored as a legacy Anthropic-key signal for the claude transport-flip default (see below).

### Custom models

Beyond the four always-on builtins (glm/qwen/deepseek/composer) and the four opt-in baked builtins above, you can register additional models without code changes via `MULTIPOLY_MODELS` (comma-separated keys). Each custom key `<K>` (lowercase, starting with a letter; may not collide with a builtin or the reserved words `harness`/`none`/`caller`) is configured from:

| Env | Required | Notes |
|---|---|---|
| `MULTIPOLY_<K>_TRANSPORT` | no | `http` (default), `anthropic`, or `cli` — see [Transports](#transports) |
| `MULTIPOLY_<K>_API_KEY` | http/anthropic | |
| `MULTIPOLY_<K>_BASE_URL` | http (yes), anthropic (no) | https (http allowed only for loopback); anthropic defaults to `https://api.anthropic.com` |
| `MULTIPOLY_<K>_MODEL` | http/anthropic (yes), cli (no) | upstream model id |
| `MULTIPOLY_<K>_DISPLAY_NAME` | no | defaults to the key |
| `MULTIPOLY_<K>_THINKING` | no | `1`/`true` if the model accepts the `thinking` request field |

For example, `MULTIPOLY_MODELS=mymodel` plus `MULTIPOLY_MYMODEL_API_KEY`/`_BASE_URL`/`_MODEL` exposes `mymodel_review`, `mymodel_consult`, and makes `mymodel` selectable as a council member or synthesizer. A custom model missing a required field is simply left unconfigured (not fatal), exactly like a builtin.

For `anthropic` and `cli` custom models, see the per-transport env in [Transports](#transports).

Server-wide settings:

| Var | Default | Notes |
|---|---|---|
| `MULTIPOLY_REASONING_EFFORT` | (per-model default) | `off\|low\|medium\|high\|xhigh` — server-wide effort baseline for all models. |
| `MULTIPOLY_THINKING` | `auto` | Coarse alias: `on` → `medium` effort, `off` → `off`, `auto` → inherit. `MULTIPOLY_REASONING_EFFORT` takes precedence when both are set. |
| `MULTIPOLY_SYNTHESIZER` | (unset) | Default council synthesizer: any active model key (`glm`/`qwen`/`deepseek`/`composer`/`claude`/`codex`/custom), or `harness`/`none`/`caller` to defer to the calling harness. Unset = defer. Overridable per-call. |
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
| `claude` | `xhigh` | `output_config.effort` + `thinking: {type: "adaptive"}` |
| `codex` | `xhigh` | `reasoning_effort` (OpenAI effort) |
| `gemini` | `high` | `reasoning_effort` (OpenAI effort) |
| `kimi` | `high` | `thinking: {type: "enabled"\|"disabled"}` toggle |
| `mimo` | `high` | `thinking: {type: "enabled"\|"disabled"}` toggle (same class as GLM; no graded effort) |
| `grok` | `xhigh` | `--effort` cli flag (graded `low`–`xhigh`, `xhigh`-native; same class as claude) |
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

### Anthropic (`claude` + custom)

To use Claude Opus 4.7 over the Anthropic API, add `claude` to `MULTIPOLY_MODELS` and set `ANTHROPIC_API_KEY` (or `MULTIPOLY_CLAUDE_API_KEY`). The `claude` transport-flip rule automatically selects the `anthropic` transport when an Anthropic key is present and `MULTIPOLY_CLAUDE_TRANSPORT` is unset. Override the endpoint with `ANTHROPIC_BASE_URL`. Review JSON uses Anthropic's native structured outputs; if the endpoint rejects the schema, it transparently falls back to prompt-instructed JSON. Anthropic requires `max_tokens`; when no model-specific cap is set it defaults to 16384 — raise `MULTIPOLY_CLAUDE_MAX_TOKENS_REVIEW` (or the server-wide cap) for large reviews.

Claude uses Anthropic's `output_config.effort` + `thinking: {type: "adaptive"}` mechanism (no `budget_tokens`). Effort defaults to `xhigh`; override per-call or via `MULTIPOLY_CLAUDE_REASONING_EFFORT`. Review mode attempts to send the JSON schema alongside the effort in `output_config`; if the endpoint rejects the format field, it falls back to prompt-instructed JSON while keeping the effort setting. If reasoning is set to `off`, the thinking field is omitted entirely.

A custom anthropic model:

```
MULTIPOLY_MODELS=haiku
MULTIPOLY_HAIKU_TRANSPORT=anthropic
MULTIPOLY_HAIKU_API_KEY=...      # or rely on ANTHROPIC_API_KEY via the file registry
MULTIPOLY_HAIKU_MODEL=claude-haiku-4-5
```

> **Non-Claude Anthropic-compatible models (e.g. Kimi):** The default reasoning
> capability for an `anthropic`-transport custom model is `ANTHROPIC_EFFORT` —
> the `output_config.effort` + `thinking: {type: "adaptive"}` shape used by
> Claude Opus 4.7. Models that do **not** speak that protocol (Kimi uses a bare
> `thinking: {type: "enabled"|"disabled"}` toggle instead) must declare their
> capability explicitly:
>
> ```
> MULTIPOLY_KIMI_REASONING=kimi_toggle
> ```
>
> The general form is `MULTIPOLY_<KEY>_REASONING=<cap>` where `<cap>` is one of
> the values listed in `CAPABILITY` (`kimi_toggle`, `glm_toggle`,
> `anthropic_budget`, `openai_effort`, `qwen_budget`, `none`). Without this
> override, sending the Opus-style payload to a non-Claude endpoint will result
> in an API error.

### CLI agents (Claude Code, Codex, Cursor/Composer, Gemini, agy, Kimi, Grok)

A `cli` model shells out to a local agent in its **read-only** mode. CLI models
are **opt-in** (`MULTIPOLY_<K>_ENABLED=1`). Config/MCP isolation varies by kind:
`claude` (`--strict-mcp-config`) and `codex` (an isolated `CODEX_HOME`) fully
prevent auto-loading your operator MCP servers and rules; the plan-mode kinds
(`cursor`, `gemini`, `kimi`, `grok`) rely on read-only/plan mode and may still
load operator config — `grok` additionally gets `--no-memory` (no cross-session
memory) but has no single-run MCP-disable flag. All kinds run read-only, so none
can write.

| `cliKind` | Binary | Read-only mode | Auth |
|---|---|---|---|
| `claude` | `claude` | `--tools ""` (no tools) + `--strict-mcp-config` | OAuth (preserved) |
| `codex` | `codex` | `--sandbox read-only` + isolated `CODEX_HOME` | login / `OPENAI_API_KEY` |
| `cursor` | `cursor-agent` | `--mode plan` | `CURSOR_API_KEY` — **needs an unlocked macOS keychain** |
| `gemini` | `gemini` | `--approval-mode plan` + workspace-trust env | OAuth / `GEMINI_API_KEY` |
| `agy` | `agy` | weak sandbox only — **opt-in unsafe** (`MULTIPOLY_<K>_UNSAFE=1`) | gemini OAuth |
| `kimi` | `kimi` | `--print --plan` (`--print` implies auto-run, so `--plan` is mandatory) | `kimi login` / `KIMI_API_KEY` |
| `grok` | `grok` | `--permission-mode plan` (+ `--no-subagents`, `--disable-web-search`, `--no-memory`); prompt via `--prompt-file` (0600) | `grok login` (OAuth) |

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
- **grok** runs headless via `--prompt-file` (prompt in a scratch file, not argv,
  so large reviews are safe) and prints the final message to stdout. The default
  model is `grok-build`; `--effort` is graded (`low`–`xhigh`). A benign background
  worker may log an auth warning to stderr even on success — it does not affect
  the result (exit 0 with output is treated as success).

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

## Model names & aliases

### Display-name convention

Every registered model surfaces a human-readable display name in the form `<base> (<transport>)`:

- CLI models: `<base> (<kind> cli)` — e.g. `opus (claude cli)`, `gpt5.5 (codex cli)`, `composer-2.5 (cursor cli)`
- API models (http or anthropic transport): `<base> (api)` — e.g. `opus (api)`, `gemini-3.5-flash (api)`, `glm-5.1 (api)`

The display name is shown in descriptions and logs. Override it per-model with `MULTIPOLY_<K>_DISPLAY_NAME`.

### Alias table

Lenient name resolution applies wherever a model name is accepted as input: the `models[]` array and `synthesizer` argument in council tool calls. Routing is **exact-key first, then alias table** — never a silent fuzzy reroute. An unknown name returns an `INVALID_INPUT` error with a `(did you mean \`x\`?)` hint computed by edit-distance.

| Alias(es) | Resolves to |
|---|---|
| `gpt`, `gpt5`, `gpt5.5`, `openai` | `codex` |
| `opus`, `claude-opus`, `opus-4.7` | `claude` |
| `flash`, `gemini-flash`, `gemini-3.5` | `gemini` |
| `zhipu`, `glm5.1` | `glm` |
| `k2`, `moonshot` | `kimi` |
| `cursor` | `composer` |
| `deepseek-v4` | `deepseek` |
| `qwen-max` | `qwen` |
| `xiaomi`, `mi-mo` | `mimo` |

Aliases resolve only when the **canonical key is configured**. For example, `opus` resolves to `claude` only if `claude` is in the registry; otherwise it returns an error.

### Alias tools (`opus_*`, `gpt55_*`)

When `claude` is configured, `opus_review` and `opus_consult` tools are registered as curated aliases that route to the `claude` handler with the same schema. When `codex` is configured, `gpt55_review` and `gpt55_consult` are similarly registered. These tools exist so existing slash commands and harness prompts that reference `opus_*` or `gpt55_*` by name continue to work without changes.

### Claude transport-flip rule

The `claude` builtin defaults to `cli` transport (Claude Code CLI). However, if `MULTIPOLY_CLAUDE_TRANSPORT` is unset and an Anthropic API key is present (`ANTHROPIC_API_KEY`, `MULTIPOLY_CLAUDE_API_KEY`, or the legacy `MULTIPOLY_OPUS_API_KEY`), the transport is automatically flipped to `anthropic` to avoid silently routing an API deployment to a local CLI. The chosen transport is logged to stderr at startup. To force CLI mode with an Anthropic key in env, set `MULTIPOLY_CLAUDE_TRANSPORT=cli` explicitly.

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
  "include_individual_results": false,
  "compact": true               // optional — drop per-model prose summaries (findings only)
}
```

`models` defaults to all configured models.

**Synthesis** is opt-in. By default — when no `synthesizer` argument is passed and `MULTIPOLY_SYNTHESIZER` is unset — the council runs the members in parallel and returns each member's output (per-member strict findings for review, answers for consult) plus a merge directive, leaving the final synthesis to the calling harness model. No extra model call is made.

To merge server-side instead, set a `synthesizer`:

- A model key (`glm`, `qwen`, `deepseek`, `composer`, `claude`, `codex`, or a custom key) runs that model as the synthesizer. Lenient name resolution applies: `opus` resolves to `claude`, `gpt`/`gpt5.5` to `codex`, etc. (see [Model names & aliases](#model-names--aliases)). If the named model isn't configured, resolution falls through the chain `chosen → qwen → deepseek → glm → composer → any other configured model` and uses the first configured model.
- `harness` / `none` / `caller` forces the default defer-to-harness behavior even when `MULTIPOLY_SYNTHESIZER` names a model.

The per-call `synthesizer` argument overrides the `MULTIPOLY_SYNTHESIZER` env default. When server-side synthesis runs, member outputs are re-scanned for secrets before being sent to the synthesizer provider.

**`compact: true`** drops per-model prose summaries (`summary_md`) from the **default (harness-defer) `council_review`** payload, keeping only structured findings. Use this when the harness reports a large-payload notice (triggered at ≥80000 chars) to shrink the payload the calling harness must synthesize. It is a no-op under server-side synthesis (a `synthesizer` is set) and in `council_consult`.

**`failure_summary`** — when one or more council members fail, a `failure_summary` line is included in the result (e.g. `"3/10 members failed: glm (BUDGET), kimi (BUDGET)"`). In the **default (harness-defer) `council_review`** mode, successful members are listed under `members` and `member_results` (when `include_individual_results` is set) carries only the failed members, avoiding duplication. Under server-side synthesis and in `council_consult` there is no separate `members` block, so `member_results` carries all members (successful and failed).

#### Interpreting council output

Council results are strong candidate-finding generators, not ground truth. Members can disagree on severity, and a plurality can be wrong — for example, a field case found that a plurality of members mis-rated a fail-closed guard as a high-severity bug when it was correct code. **Always verify severity and correctness against the actual code before acting on a finding, especially for security issues.**

Callers can reduce false confidence by asking council members to state their confidence level and cite the specific line they verified. A finding reported without a concrete line reference warrants extra skepticism.

## Large Reviews

### Reasoning-model token floors

Reasoning models need a generous output budget to avoid empty-response `BUDGET` failures during large reviews. Multipoly enforces a minimum `max_tokens` floor for every model whose reasoning capability class uses an explicit token cap:

| Scenario | Floor |
|---|---|
| `*_review` / `council_review` | 32768 tokens |
| `*_consult` / `council_consult` | 8192 tokens |

These floors apply unless you have set a model-specific cap smaller than the floor, in which case your explicit cap wins. The previous floor (GLM/MiMo only, 8192/4096) was raised and extended to all reasoning models.

To raise the cap beyond the floor for an especially large review, set:

```sh
# Per-model (e.g. GLM):
MULTIPOLY_GLM_MAX_TOKENS_REVIEW=65536

# Server-wide (all models):
MULTIPOLY_MAX_TOKENS_REVIEW=65536
```

### Adaptive BUDGET retry

When a member returns a `BUDGET` error (output truncated), multipoly automatically retries once with `max_tokens` doubled and `reasoning_effort` stepped down one level (e.g. `xhigh` → `high`). If the retry also fails, the original `BUDGET` error is returned. This handles transient budget exhaustion on large payloads without manual tuning.

### Reducing council payload size

If the harness reports that the default (harness-defer) `council_review` payload is large (≥80000 chars), use `compact: true` to drop per-model prose summaries (keeping only structured findings). This is the fastest way to shrink the payload the calling harness must synthesize. (`compact` is a no-op once a server-side `synthesizer` is set — there, the member outputs are consumed by the synthesizer model, not returned in full.)

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

### Secret scanner

The scanner flags common secret shapes — AWS keys, GitHub tokens, OpenAI/Anthropic `sk-` keys, PEM private keys, quoted and unquoted `NAME=value` assignments, and more. When a hit is found the call is refused and no matched content is logged.

**Precision improvements:** The unquoted `NAME=value` pattern (`env_style_secret`) is case-sensitive (SCREAMING_CASE keys only) to avoid false-positives on camelCase identifiers in code. Both assignment patterns suppress hits when the value is plainly a code expression (function call, template literal, member/index reference) or a plain base URL with no long opaque token in the path. This eliminates the most common false-positives from ordinary code reviews.

**Known recall tradeoff:** Unquoted lowercase keys (e.g. `apikey=...`) are not flagged by the unquoted pattern (only SCREAMING_CASE there); quoted forms (e.g. `apiKey: "..."`) and the dedicated provider key patterns still catch them.

**Per-call override:** Pass `allow_secrets: true` on any `*_review`, `*_consult`, or `council_*` call to bypass the scanner for that one call. Use this when the scanner false-positives on your code and you have confirmed no real secrets are present.

```jsonc
{ "diff_base": "main", "allow_secrets": true }
```

**Global override:** `MULTIPOLY_ALLOW_SECRETS=1` bypasses the scanner for all calls on this server instance. Prefer the per-call form — the global escape requires a server restart and applies to every call.

## Runtime Requirements

**Node.js ≥18.18** is required. The server uses `net.setDefaultAutoSelectFamily` (happy-eyeballs dual-stack DNS) at startup to reduce connection latency on IPv6-capable networks. This call is a no-op on older Node versions, so the server still starts, but happy-eyeballs is not active below 18.18.

If happy-eyeballs causes unexpected behaviour on your network (e.g. a provider that mis-advertises IPv6 support), disable it with:

```sh
NODE_OPTIONS=--dns-result-order=ipv4first node /path/to/multipoly/scripts/multipoly-mcp.mjs
```

## Development

```sh
npm test
npm run health
npm run start
```

## Status

v0.1.0 — multimodel fork in active development.
