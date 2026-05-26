---
description: Run a multi-model council review, then synthesize with Qwen. Args: optional base ref, default "main".
---

Parse `$ARGUMENTS`: if empty, use base ref `main`; if it is a single token, call `council_review` with `{ "diff_base": "<token>" }`; if the user wrote `paths: X Y Z`, call `council_review` with `{ "paths": ["X", "Y", "Z"] }`. Preserve steering text as `focus`.

Present synthesized findings first. Then show member status. If `member_results` is present, summarize only when the user asks.
