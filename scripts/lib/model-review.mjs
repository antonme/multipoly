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

export async function prepareReview(input, { config, cwd = process.cwd() } = {}) {
  const gathered = await gatherReview({
    diffBase: input.diff_base,
    paths: input.paths,
    cwd,
    caps: config.caps,
  });

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
      `Potential secrets detected in outbound payload:\n${formatHitsForError(secretScan.hits)}\nSet MULTIPOLY_ALLOW_SECRETS=1 to override.`,
    );
  }

  const userMessage = renderReviewUserMessage(gathered, input.focus);
  return {
    input,
    gathered,
    messages: [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    userMessage,
    timeoutMs: resolveCallTimeoutMs(input.timeout_ms),
  };
}

export async function runPreparedReview(modelKey, prepared, { config, fetchImpl } = {}) {
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: `${modelKey}_review`,
      strict: true,
      schema: REVIEW_SCHEMA,
    },
  };

  const attempt1 = await streamChatCompletion({
    config,
    modelKey,
    messages: prepared.messages,
    mode: "review",
    responseFormat,
    timeoutMs: prepared.timeoutMs,
    fetchImpl,
  });

  assertContentBudget(attempt1, config.maxTokens.review, "review");

  let parsed = tryParseJson(attempt1.content);
  let validation = parsed.ok ? validateReview(parsed.value) : { valid: false, reason: parsed.error };

  let reasoning = attempt1.reasoning;
  if (!validation.valid) {
    const attempt1Echo = safeTruncate(attempt1.content, 8192);
    const attempt2 = await streamChatCompletion({
      config,
      modelKey,
      messages: [
        ...prepared.messages,
        { role: "assistant", content: attempt1Echo },
        {
          role: "user",
          content:
            REVIEW_JSON_ONLY_PREFIX +
            (validation.reason ? `\n\nValidation error: ${validation.reason}` : ""),
        },
      ],
      mode: "review",
      responseFormat: attempt1.fellBackFromJsonSchema ? { type: "json_object" } : responseFormat,
      timeoutMs: prepared.timeoutMs,
      fetchImpl,
    });
    assertContentBudget(attempt2, config.maxTokens.review, "review");
    if (attempt2.reasoning) reasoning = attempt2.reasoning;
    parsed = tryParseJson(attempt2.content);
    validation = parsed.ok ? validateReview(parsed.value) : { valid: false, reason: parsed.error };
    if (!validation.valid) {
      throw new GlmError("SCHEMA", `${modelKey} review output failed validation: ${validation.reason}`, {
        details: { rawPrefix: attempt2.content.slice(0, 200) },
      });
    }
  }

  const normalizedFindings = parsed.value.findings.map((f) => ({
    severity: f.severity,
    path: f.path,
    line: f.line ?? null,
    end_line: f.end_line ?? null,
    message: f.message,
    suggestion: f.suggestion ?? null,
  }));

  return {
    result: {
      schema_version: "1",
      model: modelKey,
      findings: normalizedFindings,
      summary_md: parsed.value.summary_md,
      truncated: prepared.gathered.truncated,
      files: prepared.gathered.files.map(({ content, ...rest }) => rest),
    },
    reasoning,
  };
}

export async function handleModelReview(modelKey, input, { config, fetchImpl, cwd } = {}) {
  const prepared = await prepareReview(input, { config, cwd });
  return runPreparedReview(modelKey, prepared, { config, fetchImpl });
}

function safeTruncate(s, max) {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + "\n...[prior invalid output truncated]";
}

function tryParseJson(text) {
  const stripped = stripCodeFence(text).trim();
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function stripCodeFence(text) {
  const openMatch = text.match(/^\s*```(?:\s*json)?\s*\r?\n/i);
  if (!openMatch) return text;
  const afterOpen = text.slice(openMatch[0].length);
  return afterOpen.replace(/\r?\n\s*```\s*(?:\r?\n[\s\S]*)?$/, "");
}
