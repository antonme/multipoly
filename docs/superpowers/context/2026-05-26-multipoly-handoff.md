# Multipoly Handoff Context

Date: 2026-05-26
Repo: `/Users/anton/dev/multipoly`
Source repo copied from: `/Users/anton/dev/glm`

## Objective

Build `multipoly`: a full fork of the existing GLM-only MCP plugin that supports multiple model-specific tools and council tools.

The public MCP tool surface should be:

- `glm_review`, `qwen_review`, `deepseek_review`, `composer_review`
- `glm_consult`, `qwen_consult`, `deepseek_consult`, `composer_consult`
- `council_review`, `council_consult`

The project/plugin/package name is `multipoly`. Individual tools should use model-specific names rather than `multipoly_review { model: ... }`, because explicit MCP tool names are easier for agents to discover and call correctly.

## Model Targets

Initial model keys:

- `glm`: default model id `glm-5.1`
- `qwen`: default model id `qwen3.7max`
- `deepseek`: default model id `deepseek-v4-pro`
- `composer`: default model id `composer2.5`

Provider endpoints for Qwen, DeepSeek, and Composer should be config-driven, not hardcoded unless the user later provides authoritative endpoint details.

## Council Behavior

Council tools should:

1. Gather review/consult context once.
2. Run member models in parallel.
3. Require at least two successful member results.
4. Ask Qwen to synthesize the member outputs by default.
5. Return the synthesized answer first.
6. Preserve member status, and optionally include individual member outputs when `include_individual_results` is true.

For review councils, synthesis output should be structured JSON. For consult councils, synthesis output should be markdown.

## Current State

The `multipoly` folder was created by copying the current dirty working tree from `/Users/anton/dev/glm`, excluding `node_modules`.

Baseline commit in `multipoly`:

- `b988628 chore: import glm baseline for multipoly`

This commit captures:

- the copied GLM implementation,
- the latest local timeout/budget/progress work from the source checkout,
- the implementation plan.

Existing baseline verification passed in `multipoly`:

```bash
npm test
```

Result: 123 tests, 0 failures.

## Implementation Plan

Primary plan:

```text
docs/superpowers/plans/2026-05-26-multipoly-multimodel-mcp.md
```

The plan has eight implementation tasks:

1. Baseline Rename To Multipoly
2. Add Model Registry And Multimodel Config
3. Generalize The Streaming Client
4. Split Review And Consult Into Model-Parameterized Cores
5. Generate Model-Specific MCP Tools
6. Add Council Review And Consult
7. Commands, Skill, And README
8. Compatibility Cleanup And Final Verification

Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to execute it. The user selected subagent-driven execution in the original session.

## Progress So Far

Task 1 was implemented by a subagent and committed:

- `7f2e143 chore: rename plugin to multipoly`

Task 1 changed:

- `.claude-plugin/plugin.json`
- `README.md`
- `package.json`
- `scripts/glm-mcp.mjs` renamed to `scripts/multipoly-mcp.mjs`

Task 1 reported verification:

```bash
GLM_API_KEY=dummy npm run health
npm test
```

Result: passed, 123 tests, 0 failures.

At the time this context file was written, Task 1 spec-compliance review had been dispatched but its result had not yet been incorporated into this file.

## Important Implementation Notes

- Keep the original `/Users/anton/dev/glm` checkout untouched.
- Work only in `/Users/anton/dev/multipoly`.
- The repo is intentionally a separate folder/fork, not a nested git worktree.
- Use TDD for behavior changes: write failing tests, verify red, implement, verify green.
- Preserve the existing safety-critical code paths:
  - safe git/file gathering,
  - path containment,
  - secret scanning,
  - SSE parsing,
  - upstream retry/timeout behavior,
  - review schema validation,
  - budget checks for thinking-token exhaustion.
- Prefer generic internal handlers with explicit public tool names:
  - public: `qwen_review`
  - internal: `handleModelReview("qwen", input, ctx)`
- Do not add public freeform tools in v1 unless the user asks. The agreed v1 surface is review, consult, and council.

## Suggested Fresh-Session Start

From a new session:

```bash
cd /Users/anton/dev/multipoly
git status --short --branch
git log --oneline --decorate -n 5
npm test
```

Then inspect:

```bash
sed -n '1,220p' docs/superpowers/plans/2026-05-26-multipoly-multimodel-mcp.md
```

Continue from Task 1 review status if it is not already complete. Otherwise proceed to Task 2.
