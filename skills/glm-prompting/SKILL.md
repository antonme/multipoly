---
name: glm-prompting
description: Guidance for delegating to the GLM 5.1 MCP server (glm_review, glm_consult, glm_freeform). Use when considering whether to ask GLM for a code review or design second opinion.
---

# Using the GLM 5.1 MCP server

The `glm` plugin exposes three tools over MCP, backed by GLM 5.1 (Z.AI). Use them to delegate code review or design consultation when a second opinion is genuinely useful — not as a reflex.

## When to use which tool

- **`glm_review`** — Use for code review. Supply either:
  - `diff_base` (preferred): a git ref like `"main"`, `"origin/main"`, or a SHA. The tool computes `git diff <base>...HEAD` and inlines changed files for GLM to examine.
  - `paths`: explicit file paths when the work isn't committed or you want GLM to focus on specific files.
  - Add `focus` for steering ("concurrency correctness", "API ergonomics") — keeps findings tight.
  - Output is **structured JSON** with severity-graded findings. Present it grouping by severity.

- **`glm_consult`** — Use for design questions, architectural second opinions, or "is this approach reasonable?" conversations. Pass the question as `prompt` and attach any specific files via `paths` (do not paste file contents into the prompt). Output is markdown — return it to the user verbatim rather than paraphrasing.

- **`glm_freeform`** — Last resort. Use only when neither review nor consult fits. If you're reaching for this, ask yourself whether the main model can answer without delegation.

## Do

- Prefer `glm_review` with `diff_base` over `paths` when the work is committed — the diff context sharpens findings.
- Use `focus` to narrow the review when the caller is only interested in a slice (security, correctness, API shape).
- For consult, include the *specific* files GLM needs — not the whole repo. Over-attaching drowns the signal.
- Surface the returned `truncated`/`files` metadata to the user if review omitted anything; those files weren't seen.

## Don't

- Don't call `glm_freeform` with a code diff in the prompt — that's what `glm_review` is for.
- Don't paraphrase `glm_consult`'s markdown response. The user wants GLM's voice, not yours.
- Don't call GLM to double-check trivial answers — it's a second opinion, not a safety net.

## Caveats

- The plugin refuses to send payloads containing likely secrets (AWS/GH/Slack tokens, PEM keys, `sk-*`). Override via env `GLM_ALLOW_SECRETS=1` if the caller consents.
- Review results are capped: oversized or binary files are reported as `omitted`/`listed_only` rather than inlined.
- `glm_consult` and `glm_freeform` run with GLM's reasoning mode **off** by default; `glm_review` runs with it on. Override via `GLM_THINKING=on|off|auto`.
