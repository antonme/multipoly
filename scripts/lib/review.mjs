import { GlmError } from "./errors.mjs";
import { gatherReview } from "./gather.mjs";
import { scanMany } from "./secrets.mjs";
import { streamChatCompletion } from "./client.mjs";
import {
  REVIEW_SYSTEM_PROMPT,
  REVIEW_JSON_ONLY_PREFIX,
  renderReviewUserMessage,
} from "./prompts.mjs";
import { REVIEW_SCHEMA, validateReview } from "./schema.mjs";

function formatSecretHits(hits) {
  return hits
    .map((h) => `  - ${h.pattern} at ${h.label}:${h.line}`)
    .join("\n");
}

export async function handleReview(input, { config, fetchImpl } = {}) {
  const gathered = await gatherReview({
    diffBase: input.diff_base,
    paths: input.paths,
    cwd: process.cwd(),
    caps: config.caps,
  });

  // Secret scan on diff + inlined contents only (listed_only/omitted weren't read).
  const pieces = [];
  if (gathered.mode === "diff" && gathered.diffText) {
    pieces.push({ text: gathered.diffText, label: "diff" });
  }
  for (const f of gathered.files) {
    if (f.status === "inlined") pieces.push({ text: f.content, label: f.path });
  }
  const secretScan = scanMany(pieces);
  if (!secretScan.clean && !config.allowSecrets) {
    throw new GlmError(
      "SECRET",
      `Potential secrets detected in outbound payload:\n${formatSecretHits(secretScan.hits)}\nSet GLM_ALLOW_SECRETS=1 to override.`,
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

  // Attempt 1
  const attempt1 = await streamChatCompletion({
    config,
    messages: baseMessages,
    mode: "review",
    responseFormat,
    fetchImpl,
  });

  let parsed = tryParseJson(attempt1.content);
  let validation = parsed.ok ? validateReview(parsed.value) : { valid: false, reason: parsed.error };

  // If invalid, single retry with strict-JSON prefix.
  let reasoning = attempt1.reasoning;
  if (!validation.valid) {
    const retryMessages = [
      { role: "system", content: REVIEW_SYSTEM_PROMPT + "\n\n" + REVIEW_JSON_ONLY_PREFIX },
      { role: "user", content: userMessage },
      { role: "assistant", content: attempt1.content },
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
      fetchImpl,
    });
    reasoning = reasoning + (attempt2.reasoning || "");
    parsed = tryParseJson(attempt2.content);
    validation = parsed.ok ? validateReview(parsed.value) : { valid: false, reason: parsed.error };
    if (!validation.valid) {
      throw new GlmError("SCHEMA", `review output failed validation: ${validation.reason}`, {
        details: { raw: attempt2.content.slice(0, 4096) },
      });
    }
  }

  // Merge server-authoritative fields (files, truncated) over the model's output.
  const merged = {
    schema_version: "1",
    findings: parsed.value.findings,
    summary_md: parsed.value.summary_md,
    truncated: gathered.truncated,
    files: gathered.files.map(({ content, ...rest }) => rest),
  };

  return { result: merged, reasoning };
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
  const m = text.match(/^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  return m ? m[1] : text;
}
