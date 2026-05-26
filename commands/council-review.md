---
description: Run a multi-model council review and synthesize member findings. Args: optional base ref, default "main".
---

Parse `$ARGUMENTS`: if empty, use base ref `main`; if it is a single token, call `council_review` with `{ "diff_base": "<token>" }`; if the user wrote `paths: X Y Z`, call `council_review` with `{ "paths": ["X", "Y", "Z"] }`. Preserve steering text as `focus`.

By default the tool returns member findings plus synthesis instructions for you, the calling harness. Merge the member findings into one de-duplicated review first, prioritizing correctness/security/data-loss risks over style. Then show member status. If the tool returns an already synthesized review because a server-side `synthesizer` was configured, present those synthesized findings first. If `member_results` is present, summarize only when the user asks.
