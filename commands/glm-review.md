---
description: Run a GLM 5.1 code review over a git diff or a list of files. Args: optional base ref (default "main").
---

Call the `glm_review` MCP tool with `{ "diff_base": "$1" }` if `$1` is provided, else `{ "diff_base": "main" }`. If the user said "review these paths: X Y Z" instead of a base ref, call with `{ "paths": ["X","Y","Z"] }`. Pass the user's steering hints through `focus` when present.

Present the returned JSON to the user grouping by severity (blocker → nit), then surface `truncated`/`files` if the reviewer couldn't see everything.
