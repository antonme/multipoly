# Kimi K3 Default Design

## Goal

Upgrade Multipoly's opt-in canonical `kimi` builtin from Kimi K2.6 to Kimi K3 without changing its stable model key, MCP tool names, provider route, authentication contract, or explicit operator overrides.

The exact upstream model identifier is `kimi-k.3.0`. The existing first-party Kimi Code Anthropic-compatible route remains `https://api.kimi.com/coding`.

## Selected approach

Keep `kimi` as the canonical registry key and change only its baked default identity:

- `MODEL_INFO.kimi.defaultModel`: `kimi-k2.6` to `kimi-k.3.0`
- `MODEL_INFO.kimi.baseName`: `kimi-k2.6` to `kimi-k3`

This preserves `kimi_review`, `kimi_consult`, council selection by `kimi`, `MULTIPOLY_KIMI_*` configuration, and existing client registrations. `MULTIPOLY_KIMI_MODEL` continues to override the baked default, including as the rollback mechanism for operators who need to pin `kimi-k2.6`.

A separate `k3` builtin is intentionally not introduced because it would duplicate credentials and configuration while fragmenting the stable tool and council identity. A documentation-only override is also rejected because it would leave the shipped default stale.

## Preserved transport contract

The change does not alter:

- transport: native Anthropic Messages compatibility
- base URL: `https://api.kimi.com/coding`
- credentials: `MULTIPOLY_KIMI_API_KEY` or `MOONSHOT_API_KEY`
- reasoning capability: `KIMI_TOGGLE`
- default reasoning effort: `high`
- reasoning-model output-token floors
- precedence of explicit environment overrides

Multipoly does not currently model context-window or multimodal capabilities in its registry, so the upstream 1,048,576-token context and image/video support do not require a new local capability mechanism.

## Aliases

Add `k3`, `kimi-k3`, and `kimi-k.3.0` as aliases for the configured canonical `kimi` key. Retain `k2` and `moonshot` as compatibility aliases. Alias resolution remains gated on `kimi` being configured and never silently routes to an unavailable model.

## Documentation and release notes

Update the baked-builtin table, Kimi-specific model references, alias table, and any active examples that describe the baked default. Add the change under a new `Unreleased` changelog section rather than modifying the released `0.3.0` section.

Document the compatibility escape hatch explicitly: set `MULTIPOLY_KIMI_MODEL=kimi-k2.6` to retain the old upstream model while keeping the same Multipoly tool names.

No package version bump is part of this change. The release note remains Unreleased until the next release, matching the repository's prior default-model bump workflow.

## Testing and live verification

Follow red-green TDD:

1. Add assertions that fail against the old implementation for the baked K3 model ID, human display base, resolved default config, and new aliases.
2. Confirm those tests fail for the expected K2.6 values or missing aliases.
3. Make the minimal metadata and alias changes.
4. Run the focused tests, then the complete `npm test` suite.
5. Run the no-spend health command with Kimi configured and confirm it reports `kimi-k3 (api)` with wire model `kimi-k.3.0`.
6. Before declaring the transport contract verified, make one minimal live K3 consult at `high` effort and one at `off` effort through Multipoly's Anthropic transport. The pair must prove both `thinking: {type:"enabled"}` and `thinking: {type:"disabled"}` remain accepted by K3.

If the `off` probe is rejected because K3 is always-thinking, do not ship the inherited toggle claim. Adjust the reasoning capability and tests to the provider-observed contract, then return the amended detail to Fable for review. A live-provider failure caused by credentials, billing, or network state is reported separately and must not be misclassified as a code defect.

## Scope

The implementation is limited to model metadata, aliases, tests, README documentation, and the Unreleased changelog entry. It does not add a second builtin, change MCP schemas, introduce context-window metadata, alter provider routing, or modify unrelated model examples that intentionally test explicit overrides.
