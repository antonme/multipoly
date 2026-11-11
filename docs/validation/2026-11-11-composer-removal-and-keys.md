# Composer removal and credential recheck — 2026-11-11

Composer removed from built-in registry, fallback order, aliases, advertised tools,
slash commands, CLI smoke roster, current documentation, and local launcher secret
settings. Historical design/changelog/validation records are retained. Generic
Cursor CLI transport remains available for explicitly configured custom models;
it no longer has an implicit Composer model. NONE-capability tests now use an
explicit custom fixture, with a regression check that old Composer enable settings
cannot register a built-in model.

Credential source inspected: `/home/anton/dev/librenew/.env` (read-only).
Validated keys copied to `/home/anton/.codex/secrets.env`, outside the repository:

| Multipoly destination | LibreNew source | Result |
| --- | --- | --- |
| Qwen | DASHSCOPE_API_KEY | PASS |
| DeepSeek | DEEPSEEK_API_KEY | PASS |
| Kimi | MOONSHOT_API_KEY | PASS on standard Moonshot API |
| MiMo | XIAOMI_MIMO_API_KEY | PASS on standard MiMo API |
| Optional qwen38 | ALIBABA_CODE_PLAN_API_KEY | PASS |
| Gemini | AI_STUDIO_API_KEY | Rejected; kept existing working Multipoly key |
| GLM | No matching key in LibreNew local .env | Kept existing working key |

Kimi Code still returned subscription-access 403 with LibreNew's KIMI_CODE_API_KEY.
The validated deployment instead uses `https://api.moonshot.ai/v1`,
`kimi-k3.1-pro`, HTTP transport and `openai_effort` reasoning. MiMo's standard API
key was rejected on the Token Plan endpoint but succeeded at
`https://api.xiaomimimo.com/v1` with `mimo-v2.6-pro`. These endpoint-specific fixes
are launcher overrides; no provider credentials or LibreNew files were changed.

Grok 4.7, Claude Opus 5.5, and Claude Fable 5.2 passed live consult checks and
parsed structured-review checks. Their earlier auth/quota failures no longer
reproduced. Existing native CLI authentication was retained.

Verification: `npm test` passes 530/530; `git diff --check` passes. Live configured
surface has 10 model keys and 26 tools (including curated aliases and council),
with no Composer tools. Optional Qwen 3.8 and DeepSeek V4.1 Flash also passed live
consult checks using the saved credentials, without permanent activation.

Local rollback backups:
`/home/anton/.codex/secrets.env.multipoly-20261111-librenew.bak` (mode 0600) and
`/home/anton/.codex/config.toml.multipoly-20261111-librenew.bak`.
Restart/reconnect existing Multipoly MCP processes to load the saved environment.

Final saved-environment consult run: GLM 5.3, Qwen 3.8 Max, DeepSeek V4 Pro,
Kimi K3.1 Pro, Gemini 3.8 Flash, Opus 5.5, GPT-6.1 Sol, MiMo V2.6 Pro and
Fable 5.2 passed the exact-response check. Grok 4.7 had one response-format
mismatch (the transport completed without error); a direct repeat returned
`SMOKE-OK 437` with only a trailing newline and passed the same trimmed check.
Its structured-review contract also passed. This is evidence of working
transports and response parsing, not a guarantee of deterministic formatting.
