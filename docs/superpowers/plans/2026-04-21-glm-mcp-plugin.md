# GLM 5.1 MCP Plugin — Implementation Plan

**Goal:** Build a Claude Code plugin that wraps GLM 5.1 via an MCP server with three tools: `glm_review`, `glm_consult`, `glm_freeform`.

**Architecture:** Node 18+, single MCP dep (`@modelcontextprotocol/sdk`). Stdio MCP server launched by the plugin. One module per concern under `scripts/lib/`. Pure modules tested with `node:test`.

**Tech stack:** ES modules, native `fetch`, `execFile` (no shell), `TextDecoder` streaming, MCP SDK stdio transport.

---

## File structure

```
.claude-plugin/plugin.json        # plugin manifest + MCP server registration
package.json                       # {"type":"module"}, one dep
scripts/glm-mcp.mjs                # MCP entrypoint — registers tools, dispatches
scripts/lib/
  config.mjs                       # env parsing, endpoint profiles, validation
  errors.mjs                       # typed errors, correlation IDs
  sse.mjs                          # OpenAI-compatible SSE parser (stream)
  client.mjs                       # GLM HTTP client (streaming + retries)
  git.mjs                          # base-ref validation, diff, toplevel, changed files
  fs-safe.mjs                      # realpath containment, binary detection, size read
  secrets.mjs                      # regex scanner over outbound payload
  gather.mjs                       # build review/consult payloads with caps
  prompts.mjs                      # system prompts per mode
  schema.mjs                       # review JSON schema + validator
  review.mjs                       # glm_review handler
  consult.mjs                      # glm_consult handler
  freeform.mjs                     # glm_freeform handler
commands/glm-review.md
commands/glm-consult.md
commands/glm.md
skills/glm-prompting/SKILL.md
tests/sse.test.mjs
tests/secrets.test.mjs
tests/fs-safe.test.mjs
tests/gather.test.mjs
tests/git.test.mjs                 # uses tmpdir git repo fixtures
tests/schema.test.mjs
tests/config.test.mjs
README.md
.gitignore
```

## Task list

### Task 1: Package + manifest scaffolding

- Create `package.json` (`type: "module"`, scripts for test/start, `@modelcontextprotocol/sdk` dep).
- Create `.claude-plugin/plugin.json` declaring the MCP server (stdio, `node scripts/glm-mcp.mjs`).
- Create `.gitignore` (node_modules, .env).
- `npm install` to populate lockfile.

### Task 2: `errors.mjs`

- `GlmError` class with `code`, `message`, `cause`, `correlationId`.
- Error codes: `CONFIG`, `AUTH`, `INVALID_INPUT`, `GIT`, `FS`, `SECRET`, `HTTP`, `TIMEOUT`, `STREAM`, `SCHEMA`.
- `newCorrelationId()` helper (short random).
- `logError(err)` writes to stderr as structured JSON (never echoes secret bytes).

### Task 3: `config.mjs`

- Parse and validate env at MCP startup.
- Endpoint profile resolution: `zai-coding-plan` | `bigmodel-cn` | `custom`.
- Auth lookup: `GLM_API_KEY` || `ZHIPU_API_KEY`.
- Defaults: `GLM_MODEL=glm-5.1`, caps, timeouts.
- Throw `CONFIG`/`AUTH` errors with clear messages if invalid.
- Export frozen `config` object.

Tests (`tests/config.test.mjs`):
- happy path: defaults populated.
- missing key: throws AUTH.
- `GLM_ENDPOINT=custom` without `GLM_BASE_URL`: throws CONFIG.
- each profile resolves to the expected base URL.

### Task 4: `sse.mjs`

- `parseSseStream(readable)` → async generator yielding events `{data: object} | {error}`.
- Handles `\r\n` / `\r` / `\n`, multi-line `data:` joined with `\n`, `:` comments, `event:`/`id:`/`retry:` (captured), UTF-8 streaming via `TextDecoder('utf-8', {fatal:false})`, top-level `{error: {...}}` yields error event + aborts, `[DONE]` ends stream.
- Pure: takes an async iterable of `Uint8Array`; no fetch coupling.

Tests:
- CRLF boundaries across chunks.
- Multi-line `data:` aggregation.
- UTF-8 split across chunks (3-byte char).
- Comment lines ignored.
- `[DONE]` terminates cleanly.
- Top-level error surfaces typed error.

### Task 5: `client.mjs`

- `streamChatCompletion({messages, mode, options})`.
- Builds request body: `model`, `messages`, `stream: true`, `max_tokens` (per mode), `thinking: {type: "disabled"}` when off.
- POST to `<baseUrl>/chat/completions` with `Authorization: Bearer <key>`.
- Uses `AbortController` for timeout.
- Retry policy per spec (401/403 fail fast; 429/5xx/network exp backoff × 3; honor `Retry-After`).
- Streams via `parseSseStream`, accumulates `delta.content`; returns `{content, reasoning, usage, finishReason}`.
- On `response_format: json_schema` → if server returns 400 with `unsupported`/`not supported` message about `response_format`, one-shot fall back to `json_object` and re-issue (callers pass flag).

Tests: light — mock `fetch` via dependency-injected `fetchImpl` parameter. Cover: happy path, 429 retry, 401 fail-fast, timeout.

### Task 6: `git.mjs`

- `getToplevel(cwd)` — run `git rev-parse --show-toplevel`; returns path or throws `GIT`.
- `isGitRepo(cwd)` — boolean.
- `validateRef(ref, cwd)` — `git rev-parse --verify <ref>^{commit}`; throws `GIT` with clear message.
- `getChangedFiles(base, cwd)` — `git diff --name-only --diff-filter=ACMR <base>...HEAD`.
- `getDiff(base, cwd)` — `git diff <base>...HEAD` (unified diff text).
- `isBinaryPath(base, path, cwd)` — `git diff --numstat <base>...HEAD -- <path>`, checks for `-\t-`.
- All calls via `execFile('git', [...args], {cwd, maxBuffer: 8 * 1024 * 1024})`.

Tests (`tests/git.test.mjs`): creates a tmp git repo, commits fixtures, covers toplevel, ref validation (valid + invalid), changed files, detached HEAD works.

### Task 7: `fs-safe.mjs`

- `containPath(rootRealpath, candidatePath)` — resolves candidate via `fs.realpath`, asserts it starts with root + sep.
- `readFileCapped(path, cap)` — reads up to `cap` bytes; returns `{content, size, truncated}`. Binary detection: sniff first 4 KiB for null bytes.
- `safeStatSize(path)` — size or throws FS.

Tests: path outside root rejected; symlink escape rejected; cap enforced; binary detection.

### Task 8: `secrets.mjs`

- `scan(text, sourceLabel)` → `{hits: [{pattern, label, line}], clean}`.
- `sourceLabel` is e.g. "diff" or "src/foo.ts" — used in errors only; **matched bytes never logged**.
- Line number computed by counting `\n` before match index (not by reading file again).
- All patterns as specified.

Tests: each pattern; multiple hits; no false-positive on `.gitignore`-style `SECRET_KEY=xxx` placeholder (we allow placeholders ≥16 chars — intentional overscan, refuse is the right answer).

### Task 9: `gather.mjs`

- `gatherReview({diffBase?, paths?, cwd})` → `{mode: "diff"|"paths", diffText?, files: [{path, status, content?, reason?}], truncated}`.
  - `diff` branch: validate base, get diff text, get changed files, for each: if binary → `listed_only` with reason; else read capped content and apply per-file/total/count caps.
  - `paths` branch: for each: resolve + contain, read capped content (same cap logic), binary skip.
  - Enforces the atomic-per-file rule: if per-file cap exceeded → `omitted`; if total cap hit → `listed_only`; if count cap hit → `listed_only`.
  - `truncated = any file not "inlined"`.
- `gatherConsult({prompt, paths?, cwd})` → `{prompt, files: [{path, content}]}`; oversized single file throws `INVALID_INPUT`.

Tests: diff size accounting, per-file and total caps, count cap, binary path skipped, path outside repo rejected.

### Task 10: `schema.mjs`

- Export the review JSON schema (object literal) as `REVIEW_SCHEMA`.
- `validateReview(obj)` returns `{valid: true} | {valid: false, reason: string}`. Hand-written validator (no deps) — checks required fields, severity enum, findings array shape.

Tests: valid doc passes; missing `schema_version` fails; bad severity fails; non-array findings fails.

### Task 11: `prompts.mjs`

- Three exported strings:
  - `REVIEW_SYSTEM_PROMPT` — "senior reviewer, terse, structured, output JSON strictly matching schema".
  - `CONSULT_SYSTEM_PROMPT` — "senior engineer, second opinion, point out tradeoffs and blind spots, markdown".
  - `FREEFORM_SYSTEM_PROMPT` — short, neutral.
- Plus `renderReviewUserMessage(gathered, focus)` and `renderConsultUserMessage(prompt, files)`.

### Task 12: `review.mjs`

- `handleReview(input)`:
  1. Validate input shape (oneOf diffBase/paths).
  2. `gather.gatherReview`.
  3. `secrets.scan` over diff + inlined contents; on hit without override → `SECRET` error.
  4. Build messages via `prompts`, call `client.streamChatCompletion` with `response_format: json_schema` (falls back internally on unsupported).
  5. `JSON.parse` + `validateReview`. On fail → one retry with strict-JSON prefix. On second fail → `SCHEMA` error with raw attached.
  6. Merge `files`/`truncated` from gather into the parsed object (authoritative) and return.

### Task 13: `consult.mjs`

- `handleConsult(input)`:
  1. Validate.
  2. `gather.gatherConsult`.
  3. `secrets.scan` on prompt + file contents.
  4. Build messages, call `client.streamChatCompletion` with thinking off, no `response_format`.
  5. Return `content` markdown.

### Task 14: `freeform.mjs`

- `handleFreeform(input)`: validate prompt non-empty, scan secrets, call client (thinking off), return content.

### Task 15: `scripts/glm-mcp.mjs`

- `import { Server } from "@modelcontextprotocol/sdk/server/index.js"` and stdio transport.
- Register three tools with input schemas.
- On `tools/call`: dispatch by name to handler; wrap in try/catch translating `GlmError` to MCP error content (text block with structured error + code).
- Successful calls return `{content: [{type: "text", text: payload}]}`.
- If `GLM_DEBUG_REASONING=1`, append a second text block with `reasoning_content`.
- On startup: call `loadConfig()` (fail-fast). Log readiness to stderr.

### Task 16: Slash commands

- `commands/glm-review.md`: frontmatter + body that invokes `glm_review` with `{diff_base: "$1" || "main"}`.
- `commands/glm-consult.md`: invokes `glm_consult { prompt: "$ARGS" }`.
- `commands/glm.md`: invokes `glm_freeform { prompt: "$ARGS" }`.

### Task 17: `skills/glm-prompting/SKILL.md`

- Explains when to use each mode: review for diffs/files, consult for open questions with context, freeform rarely.
- Notes on GLM's tendencies (terse, strong on Chinese+English, good at code review with thinking on).

### Task 18: README

- Install steps (marketplace OR local).
- Env vars table.
- Usage from Claude Code and opencode.
- Troubleshooting.

### Task 19: Tests + smoke

- `npm test` runs `node --test tests/*.test.mjs`.
- Smoke: `node scripts/glm-mcp.mjs --health` prints "ok" + config summary (with key redacted) and exits 0.

### Task 20: External review loop

- Dispatch `codex-rescue` agent with: plan + full implementation tree + test output.
- Dispatch `superpowers:code-reviewer` agent in parallel with: plan + implementation tree.
- Iterate on findings until both approve (max 3 rounds).

### Task 21: Present to user

- Summarize what got built, the key decisions (split tools, JSON schema, atomic per-file, ZHIPU_API_KEY fallback), install steps, and a quick-reference cheat sheet.
