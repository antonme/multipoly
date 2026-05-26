---
name: multipoly-prompting
description: Guidance for delegating to Multipoly model-specific and council MCP tools.
---

# Using Multipoly

Use model-specific tools when you want one model's independent opinion:

- `glm_review`, `qwen_review`, `deepseek_review`, `composer_review`
- `glm_consult`, `qwen_consult`, `deepseek_consult`, `composer_consult`

Use council tools when disagreement or synthesis is valuable:

- `council_review`: parallel member reviews, Qwen synthesis.
- `council_consult`: parallel member consultations, Qwen synthesis.

Prefer model-specific tools for quick checks. Prefer council tools for risky code, ambiguous design decisions, or when the user explicitly asks for multiple opinions.
