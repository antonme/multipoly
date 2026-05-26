---
description: Run a multi-model design consultation and synthesize member answers. Args: the question.
---

Call `council_consult` with `{ "prompt": "$ARGUMENTS" }`. If the user explicitly named files to attach, include them as `paths`.

By default the tool returns member answers plus synthesis instructions for you, the calling harness. Synthesize those member answers into one concise markdown answer first, surface meaningful disagreements, and keep member status visible. If the tool returns an already synthesized markdown answer because a server-side `synthesizer` was configured, return that answer as-is and keep member status visible.
