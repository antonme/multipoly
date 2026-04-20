---
description: Ask GLM 5.1 for a second opinion on a hard design or implementation question. Args: the question.
---

Call the `glm_consult` MCP tool with `{ "prompt": "$ARGUMENTS" }`. If there are specific files the user wants GLM to see, include them as `paths`. Do NOT paste file contents into the prompt — let the tool attach them verbatim.

Return the markdown response as-is. Do not re-summarize it; the user asked for GLM's take.
