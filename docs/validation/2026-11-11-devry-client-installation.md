# Devry client installations — 2026-11-11

Multipoly dependencies reinstalled with `npm ci` in
`/home/anton/dev/multipoly`. All clients launch that checkout through
`/home/anton/.codex/mcp-with-secrets.sh`, which loads the protected machine-local
`/home/anton/.codex/secrets.env`. Credentials remain outside this repository.

| Client | Configuration | Verification |
| --- | --- | --- |
| Codex | `~/.codex/config.toml` | Native registration recognized; real MCP handshake, 26 tools, authenticated Kimi and MiMo calls PASS |
| Claude | `~/.claude.json` | Old pins/endpoints repaired, Composer removed; native status Connected; real MCP handshake, 30 tools, authenticated Kimi and MiMo calls PASS |
| Grok | `~/.grok/config.toml` | User MCP registration installed; native doctor healthy, 26 tools; real MCP handshake and authenticated Kimi and MiMo calls PASS |

Claude's existing AGY and Qwen38 opt-ins were preserved. AGY was not exercised;
its previously approved weak-sandbox opt-in was not changed. Grok and Codex use
the existing ten-model Codex roster. Model pins, Kimi/MiMo endpoint corrections,
and the validated credential mappings from the prior checks are shared across
all three clients. No Composer tool appears in any client surface.

Client verification launched the server from each client's actual saved
command/args/environment and used the MCP SDK for tools/list and tools/call,
without relying on the interactive shell to supply provider keys. Native
`claude mcp get multipoly`, `codex mcp get multipoly`, and
`grok mcp doctor multipoly --json` also succeeded.

Fresh verification: 530/530 automated tests pass; `git diff --check` passes.
The existing dependency audit findings reported by npm were not changed by this
model/configuration update.

Before-change client backups:
`~/.claude.json.20261111-client-install.bak` and
`~/.grok/config.toml.20261111-client-install.bak`.
Earlier protected credential and Codex configuration backups are recorded in
`2026-11-11-composer-removal-and-keys.md`.

Already-running client sessions may retain their old MCP processes; reconnect
Multipoly or restart the client session to pick up the refreshed installation.
