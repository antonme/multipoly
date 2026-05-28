import { MultipolyError } from "./errors.mjs";
import { gatherReview } from "./gather.mjs";
import { scanMany, formatHitsForError } from "./secrets.mjs";
import {
  REVIEW_SYSTEM_PROMPT,
  REVIEW_JSON_ONLY_PREFIX,
  renderReviewUserMessage,
  stripCodeFence,
} from "./prompts.mjs";
import { REVIEW_SCHEMA, validateReview, normalizeFindings } from "./schema.mjs";
import { resolveCallTimeoutMs, resolveMaxTokensForModel } from "./config.mjs";
import { modelSupportsThinking } from "./models.mjs";
import { normalizeEffort, resolveReasoningEffort } from "./reasoning.mjs";
import { callWithBudgetRetry } from "./budget-retry.mjs";

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
    throw new MultipolyError(
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
    reasoningEffort: normalizeEffort(input.reasoning_effort),
  };
}

export async function runPreparedReview(modelKey, prepared, { config, fetchImpl, execFileImpl, cwd } = {}) {
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: `${modelKey}_review`,
      strict: true,
      schema: REVIEW_SCHEMA,
    },
  };

  const maxTokens = resolveMaxTokensForModel(config, modelKey, "review");
  const budgetContext = {
    modelKey,
    supportsThinking: modelSupportsThinking(config, modelKey),
  };

  // Compute the effective reasoning effort for this call (mirrors transport resolution):
  // the per-call override (prepared.reasoningEffort) applied on top of the model
  // config baseline (modelConfig.reasoningEffort, already a concrete level).
  const modelConfig = config?.models?.[modelKey];
  const bakedDefault = modelConfig?.reasoningEffort ?? "off";
  const effectiveEffort = resolveReasoningEffort({
    perCall: prepared.reasoningEffort,
    bakedDefault,
  });

  const { attempt: attempt1 } = await callWithBudgetRetry({
    runModelArgs: {
      config,
      modelKey,
      messages: prepared.messages,
      mode: "review",
      responseFormat,
      timeoutMs: prepared.timeoutMs,
      reasoningEffort: prepared.reasoningEffort,
      fetchImpl,
      execFileImpl,
      cwd,
    },
    mode: "review",
    maxTokens,
    budgetContext,
    effectiveEffort,
  });

  let parsed = tryParseJson(attempt1.content);
  let validation = parsed.ok ? validateReview(parsed.value) : { valid: false, reason: parsed.error };

  let reasoning = attempt1.reasoning;
  if (!validation.valid) {
    const attempt1Echo = safeTruncate(attempt1.content, 8192);
    const { attempt: attempt2 } = await callWithBudgetRetry({
      runModelArgs: {
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
        reasoningEffort: prepared.reasoningEffort,
        fetchImpl,
        execFileImpl,
        cwd,
      },
      mode: "review",
      maxTokens,
      budgetContext,
      effectiveEffort,
    });
    if (attempt2.reasoning) reasoning = attempt2.reasoning;
    parsed = tryParseJson(attempt2.content);
    validation = parsed.ok ? validateReview(parsed.value) : { valid: false, reason: parsed.error };
    if (!validation.valid) {
      throw new MultipolyError("SCHEMA", `${modelKey} review output failed validation: ${validation.reason}`, {
        details: { rawPrefix: attempt2.content.slice(0, 200) },
      });
    }
  }

  return {
    result: {
      schema_version: "1",
      model: modelKey,
      findings: normalizeFindings(parsed.value.findings),
      summary_md: parsed.value.summary_md,
      truncated: prepared.gathered.truncated,
      files: prepared.gathered.files.map(({ content, ...rest }) => rest),
    },
    reasoning,
  };
}

export async function handleModelReview(modelKey, input, { config, fetchImpl, execFileImpl, cwd } = {}) {
  const prepared = await prepareReview(input, { config, cwd });
  return runPreparedReview(modelKey, prepared, { config, fetchImpl, execFileImpl, cwd });
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
