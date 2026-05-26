import { GlmError } from "./errors.mjs";
import { gatherReview } from "./gather.mjs";
import { scanMany, formatHitsForError } from "./secrets.mjs";
import { streamChatCompletion } from "./client.mjs";
import {
  REVIEW_SYSTEM_PROMPT,
  REVIEW_JSON_ONLY_PREFIX,
  renderReviewUserMessage,
} from "./prompts.mjs";
import { REVIEW_SCHEMA, validateReview } from "./schema.mjs";
import { assertContentBudget } from "./budget.mjs";
import { resolveCallTimeoutMs } from "./config.mjs";

export async function handleReview(input, { config, fetchImpl } = {}) {
  const gathered = await gatherReview({
    diffBase: input.diff_base,
    paths: input.paths,
    cwd: process.cwd(),
    caps: config.caps,
  });

  // Secret scan on diff + inlined contents + user-supplied focus text.
  // listed_only/omitted files weren't read so they don't need scanning.
  const pieces = [];
  if (gathered.mode === "diff" && gathered.diffText) {
    pieces.push({ text: gathered.diffText, label: "diff" });
  }
  for (const f of gathered.files) {
    if (f.status === "inlined") pieces.push({ text: f.content, label: f.path });
  }
  if (typeof input.focus === "string" && input.focus.length > 0) {
    pieces.push({ text: input.focus, label: "focus" });
  }
  const secretScan = scanMany(pieces);
  if (!secretScan.clean && !config.allowSecrets) {
    throw new GlmError(
      "SECRET",
      `Potential secrets detected in outbound payload:\n${formatHitsForError(secretScan.hits)}\nSet GLM_ALLOW_SECRETS=1 to override.`,
    );
  }

  const userMessage = renderReviewUserMessage(gathered, input.focus);
  const baseMessages = [
    { role: "system", content: REVIEW_SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "glm_review",
      strict: true,
      schema: REVIEW_SCHEMA,
    },
  };

  // Per-call override resolved once; applies to both the initial attempt and
  // the strict-JSON retry so a long review keeps its full budget on retry.
  const callTimeoutMs = resolveCallTimeoutMs(input.timeout_ms);

  // Attempt 1
  const attempt1 = await streamChatCompletion({
    config,
    messages: baseMessages,
    mode: "review",
    responseFormat,
    timeoutMs: callTimeoutMs,
    fetchImpl,
  });

  assertContentBudget(attempt1, config.maxTokens.review, "review");

  let parsed = tryParseJson(attempt1.content);
  let validation = parsed.ok ? validateReview(parsed.value) : { valid: false, reason: parsed.error };

  // If invalid, single retry with strict-JSON prefix.
  let reasoning = attempt1.reasoning;
  if (!validation.valid) {
    // One retry with a single strict-JSON correction turn. The system prompt
    // already contains the schema; we only add the correction in the user turn.
    //
    // Truncate the invalid assistant turn to avoid doubling the context
    // window: a review that produced 128K tokens of malformed JSON would
    // otherwise make the retry ~2× the original size and risk context-window
    // overflow. An 8KB prefix is enough for the model to recognize the shape
    // of its prior (bad) attempt without resending the entire payload.
    //
    // `slice` is by UTF-16 code units, so the cut can land between the two
    // halves of a surrogate pair (astral char like an emoji). Drop a trailing
    // lone high-surrogate so we don't emit malformed Unicode to the model.
    const attempt1Echo = safeTruncate(attempt1.content, 8192);
    const retryMessages = [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
      { role: "assistant", content: attempt1Echo },
      {
        role: "user",
        content:
          REVIEW_JSON_ONLY_PREFIX +
          (validation.reason ? `\n\nValidation error: ${validation.reason}` : ""),
      },
    ];
    const attempt2 = await streamChatCompletion({
      config,
      messages: retryMessages,
      mode: "review",
      responseFormat: attempt1.fellBackFromJsonSchema ? { type: "json_object" } : responseFormat,
      timeoutMs: callTimeoutMs,
      fetchImpl,
    });
    assertContentBudget(attempt2, config.maxTokens.review, "review");
    // Keep only the retry's reasoning: attempt1 produced invalid JSON, so
    // its reasoning is no longer the authoritative trace. Avoids peaking
    // memory at ~2× by concatenating two large reasoning strings.
    if (attempt2.reasoning) reasoning = attempt2.reasoning;
    parsed = tryParseJson(attempt2.content);
    validation = parsed.ok ? validateReview(parsed.value) : { valid: false, reason: parsed.error };
    if (!validation.valid) {
      // validation.reason already describes WHAT was wrong; don't echo the
      // raw model output into the error because it can contain reviewed
      // file content (potentially including secrets that passed the
      // scanner). A small prefix is enough to identify the shape of the bad
      // output without leaking substantial code.
      throw new GlmError("SCHEMA", `review output failed validation: ${validation.reason}`, {
        details: { rawPrefix: attempt2.content.slice(0, 200) },
      });
    }
  }

  // Normalize each finding to a consistent shape. The schema sent to the
  // model requires `line`/`end_line`/`suggestion` (nullable); the validator
  // tolerates them missing to handle json_object-fallback output. Fill them
  // with null here so downstream consumers always see the same shape.
  const normalizedFindings = parsed.value.findings.map((f) => ({
    severity: f.severity,
    path: f.path,
    line: f.line ?? null,
    end_line: f.end_line ?? null,
    message: f.message,
    suggestion: f.suggestion ?? null,
  }));

  // Merge server-authoritative fields (files, truncated) over the model's output.
  const merged = {
    schema_version: "1",
    findings: normalizedFindings,
    summary_md: parsed.value.summary_md,
    truncated: gathered.truncated,
    files: gathered.files.map(({ content, ...rest }) => rest),
  };

  return { result: merged, reasoning };
}

function safeTruncate(s, max) {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  // Drop a trailing lone high-surrogate (0xD800..0xDBFF) so JSON.stringify
  // doesn't encode a malformed UTF-16 pair.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + "\n…[prior invalid output truncated]";
}

function tryParseJson(text) {
  // The model may wrap JSON in code fences despite instructions; tolerate that.
  const stripped = stripCodeFence(text).trim();
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function stripCodeFence(text) {
  // Tolerant to common model output variance:
  //   - CRLF or LF line endings
  //   - optional language tag in any case (```json, ```JSON)
  //   - optional whitespace between the fence and the language tag (``` json)
  //   - trailing prose after the close fence, whether on the same line
  //     (`\`\`\` done.`) or on subsequent lines (`\`\`\`\nLooks good.`).
  // The close fence must sit on its own line (preceded by \n, followed by
  // \s* then either EOS or \n) so we don't mistakenly strip a `\`\`\`` that
  // appears inside a JSON string value. JSON can't contain raw newlines in
  // strings, so a fence-on-its-own-line is an unambiguous structural marker.
  const openMatch = text.match(/^\s*```(?:\s*json)?\s*\r?\n/i);
  if (!openMatch) return text;
  const afterOpen = text.slice(openMatch[0].length);
  // Strip the closing fence plus any trailing content from the end. Match
  // only when the fence is on its own line; anchoring on `$` ensures we
  // take the last such fence in the string.
  const stripped = afterOpen.replace(/\r?\n\s*```\s*(?:\r?\n[\s\S]*)?$/, "");
  return stripped;
}
