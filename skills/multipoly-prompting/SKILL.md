---
name: multipoly-prompting
description: Guidance for delegating to Multipoly model-specific and council MCP tools.
---

# Using Multipoly

Use model-specific tools when you want one model's independent opinion:

- `glm_review`, `qwen_review`, `deepseek_review`, `composer_review`
- `glm_consult`, `qwen_consult`, `deepseek_consult`, `composer_consult`
- Additional configured model keys expose the same `<key>_review` / `<key>_consult` pattern, such as `opus_review` when Anthropic is configured.

Use council tools when disagreement or synthesis is valuable:

- `council_review`: parallel member reviews; by default the calling harness synthesizes returned member findings.
- `council_consult`: parallel member consultations; by default the calling harness synthesizes returned member answers.

Prefer model-specific tools for quick checks. Prefer council tools for risky code, ambiguous design decisions, or when the user explicitly asks for multiple opinions.
