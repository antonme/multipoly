# Gemini 4 Carbon — 2026-11-12

The `gemini` builtin now selects `gemini-4-carbon`, with display name
`gemini-4-carbon (api)`. The checkout and all three saved client configurations
previously selected Gemini 3.8 Flash; no Gemini 4 Argon entry was present.
Added `carbon`, `gemini4`, and `gemini-4-carbon` selection aliases while retaining
existing aliases and the `gemini_review` / `gemini_consult` tool identities.

Carbon's `gemini4` reasoning vocabulary accepts low/medium/high: `off` maps to
low (thinking remains enabled), `xhigh` maps to high. Existing `gemini` reasoning
vocabulary for explicitly pinned Gemini 3 models remains available. Provider
credentials, endpoint, other models, and other client customizations are retained.

Source: [Google's Carbon model documentation](https://aistudio.google.com/docs/models/gemini-4-carbon).

Verification: 532 automated tests pass; `git diff --check` passes. Live Carbon
consult checks pass at default high, off and medium. A live structured-review
call returns parsed findings and summary successfully. The saved Codex launcher
also passes the exact arithmetic smoke check with Carbon.

Gemini model and reasoning-vocabulary pins updated in `~/.codex/config.toml`,
`~/.claude.json`, and `~/.grok/config.toml`. Before-change backups use the suffix
`.carbon-20261112.bak`. Existing client sessions need Multipoly reconnect/restart.

Real MCP checks from each saved Codex, Claude, and Grok launch configuration
also pass: Carbon tool description verified and an authenticated Carbon consult
returns the expected response through tools/call in all three installations.
