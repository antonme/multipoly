---
description: Run a Composer code review over a git diff or a list of files. Args: optional base ref, default "main".
---

Parse `$ARGUMENTS`: if empty, use base ref `main`; if it is a single token, call `composer_review` with `{ "diff_base": "<token>" }`; if the user wrote `paths: X Y Z`, call `composer_review` with `{ "paths": ["X", "Y", "Z"] }`. Preserve steering text as `focus`.

Present returned JSON grouped by severity and mention `truncated`/`files` when content was omitted.
