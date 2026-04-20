---
description: Run a GLM 5.1 code review over a git diff or a list of files. Args: optional base ref (default "main").
---

Parse `$ARGUMENTS`: if empty, use base ref `main`; if it looks like a ref (a single token), use it as `diff_base`; if the user wrote "paths: X Y Z" or named specific files, call with `paths: ["X","Y","Z"]` instead. Pass any steering hints through `focus`.

Then call the `glm_review` MCP tool with the chosen `{ diff_base | paths, focus? }`.

Present the returned JSON to the user grouping by severity (blocker → nit), then surface `truncated`/`files` if the reviewer couldn't see everything.
