# Model refresh — 2026-11-11

Registry and Codex launcher pins updated; transports, endpoints, credentials,
canonical model keys, and existing aliases retained. Codex stays on the Sol
coding tier (6.1), Gemini stays on Flash (3.8). Composer 2.5 and DeepSeek V4
Pro are unchanged. Claude invocations now pass `--setting-sources ""` so an
unrelated parent settings file cannot stop this tool-free MCP-isolated call.

| Key | Model | Live consult result |
| --- | --- | --- |
| glm | glm-5.3 | PASS |
| qwen | qwen3.8-max | PASS |
| deepseek | deepseek-v4-pro | PASS |
| gemini | gemini-3.8-flash | PASS |
| codex | gpt-6.1-sol | PASS |
| qwen38 | qwen3.8-max | PASS (temporary opt-in for verification) |
| deepseekflash | deepseek-flash | PASS (temporary opt-in for verification) |
| claude | claude-opus-5-5 | Shared five-hour usage limit |
| fable | claude-fable-5-2 | Shared five-hour usage limit |
| kimi | k3.1-pro (Kimi Code) | 403: subscription has no current access |
| mimo | mimo-v2.6-pro | 401: invalid API key |
| grok | grok-4.7 | CLI not signed in |
| composer | composer-2.5 | Not configured; not enabled by this change |

Qwen4 Max appeared in the authenticated catalog but returned 403 on generation;
3.8 Max generated successfully on the same endpoint/key. Both the old and new
Kimi model IDs returned the same subscription-access rejection. Claude's limit
was confirmed after isolating settings, with both new IDs. These account gates
prevent claiming every model is operational.

Run `npm run smoke` in the server's credential-bearing environment, or pass
canonical keys to check selected models. It checks an exact arithmetic response,
skips unconfigured models, and exits nonzero for failed calls. No credentials or
provider response bodies are printed by this script.

Local launcher: `/home/anton/.codex/config.toml`; pre-change backup:
`/home/anton/.codex/config.toml.multipoly-20261111.bak`. Existing MCP processes
retain their startup config; reconnect/restart Multipoly to load these pins.

Sources: provider catalogs plus
[Claude](https://platform.claude.com/docs/en/models/overview),
[OpenAI](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md),
[Gemini](https://aistudio.google.com/docs/models),
[DeepSeek](https://api-docs.deepseek.com/updates/), and
[MiMo](https://mimo.mi.com/).

Verification: `npm test` passed 533/533 tests; `git diff --check` passed.
Live consult checks exercised the same `handleModelConsult` dispatcher used by
MCP, including provider reasoning fields, streaming, and CLI response extraction.
The optional entries were enabled only for their test process.

Live structured-review checks also passed for GLM, Qwen, DeepSeek Pro, Gemini,
and Codex: each returned parsed findings and a summary through
`handleModelReview`. This verifies the output contract, not the accuracy of
individual review findings.
