import { GlmError } from "./errors.mjs";
import { MODEL_KEYS, assertModelKey } from "./models.mjs";
import { prepareReview, runPreparedReview } from "./model-review.mjs";
import { prepareConsult, runPreparedConsult } from "./model-consult.mjs";
import { streamChatCompletion } from "./client.mjs";
import {
  COUNCIL_REVIEW_SYNTHESIS_PROMPT,
  COUNCIL_CONSULT_SYNTHESIS_PROMPT,
  renderCouncilReviewSynthesisMessage,
  renderCouncilConsultSynthesisMessage,
} from "./prompts.mjs";
import { COUNCIL_REVIEW_SCHEMA, validateCouncilReview } from "./schema.mjs";
import { assertContentBudget } from "./budget.mjs";

function resolveCouncilModels(input, config) {
  const requested = input.models?.length
    ? input.models.map(assertModelKey)
    : MODEL_KEYS.filter((key) => config.models[key]?.configured);
  const unique = [...new Set(requested)];
  if (unique.length < 2) {
    throw new GlmError("INVALID_INPUT", "council requires at least two distinct models");
  }
  const missing = unique.filter((key) => !config.models[key]?.configured);
  if (missing.length > 0) {
    throw new GlmError(
      "CONFIG",
      `council requested unconfigured models: ${missing.join(", ")}`,
      { details: { missing } },
    );
  }
  return unique;
}

function resolveSynthesizer(input, config) {
  const key = assertModelKey(input.synthesizer || "qwen");
  if (!config.models[key]?.configured) {
    throw new GlmError("CONFIG", `council synthesizer ${key} is not configured`);
  }
  return key;
}

function serializeError(e) {
  if (e instanceof GlmError) return e.toJSON().error;
  return { code: "INTERNAL", message: e?.message ?? String(e) };
}

export async function handleCouncilReview(input, { config, fetchImpl } = {}) {
  const models = resolveCouncilModels(input, config);
  const synthesizer = resolveSynthesizer(input, config);
  const prepared = await prepareReview(input, { config });

  const settled = await Promise.allSettled(
    models.map(async (modelKey) => {
      const out = await runPreparedReview(modelKey, prepared, { config, fetchImpl });
      return [modelKey, out.result];
    }),
  );
  const memberResults = {};
  for (let i = 0; i < settled.length; i++) {
    const modelKey = models[i];
    const r = settled[i];
    memberResults[modelKey] = r.status === "fulfilled"
      ? { ok: true, result: r.value[1] }
      : { ok: false, error: serializeError(r.reason) };
  }

  const successful = Object.entries(memberResults).filter(([, r]) => r.ok);
  if (successful.length < 2) {
    throw new GlmError("HTTP", "council requires at least two successful member results", {
      details: { memberResults },
    });
  }

  const attempt = await streamChatCompletion({
    config,
    modelKey: synthesizer,
    messages: [
      { role: "system", content: COUNCIL_REVIEW_SYNTHESIS_PROMPT },
      {
        role: "user",
        content: renderCouncilReviewSynthesisMessage({
          originalPrompt: prepared.userMessage,
          memberResults,
          schema: COUNCIL_REVIEW_SCHEMA,
        }),
      },
    ],
    mode: "review",
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "council_review", strict: true, schema: COUNCIL_REVIEW_SCHEMA },
    },
    timeoutMs: prepared.timeoutMs,
    fetchImpl,
  });
  assertContentBudget(attempt, config.maxTokens.review, "review");
  const parsed = JSON.parse(attempt.content.trim());
  const validation = validateCouncilReview(parsed);
  if (!validation.valid) {
    throw new GlmError("SCHEMA", `council review output failed validation: ${validation.reason}`);
  }

  return {
    result: {
      ...parsed,
      files: prepared.gathered.files.map(({ content, ...rest }) => rest),
      truncated: prepared.gathered.truncated,
      member_status: Object.fromEntries(
        Object.entries(memberResults).map(([key, value]) => [
          key,
          value.ok ? { ok: true, findings: value.result.findings.length } : { ok: false, error: value.error },
        ]),
      ),
      ...(input.include_individual_results ? { member_results: memberResults } : {}),
    },
    reasoning: attempt.reasoning,
  };
}

export async function handleCouncilConsult(input, { config, fetchImpl } = {}) {
  const models = resolveCouncilModels(input, config);
  const synthesizer = resolveSynthesizer(input, config);
  const prepared = await prepareConsult(input, { config });
  const settled = await Promise.allSettled(
    models.map(async (modelKey) => {
      const out = await runPreparedConsult(modelKey, prepared, { config, fetchImpl });
      return [modelKey, out.result];
    }),
  );
  const memberResults = {};
  for (let i = 0; i < settled.length; i++) {
    const modelKey = models[i];
    const r = settled[i];
    memberResults[modelKey] = r.status === "fulfilled"
      ? { ok: true, result: r.value[1] }
      : { ok: false, error: serializeError(r.reason) };
  }
  const successful = Object.entries(memberResults).filter(([, r]) => r.ok);
  if (successful.length < 2) {
    throw new GlmError("HTTP", "council requires at least two successful member results", {
      details: { memberResults },
    });
  }
  const attempt = await streamChatCompletion({
    config,
    modelKey: synthesizer,
    messages: [
      { role: "system", content: COUNCIL_CONSULT_SYNTHESIS_PROMPT },
      {
        role: "user",
        content: renderCouncilConsultSynthesisMessage({
          originalPrompt: prepared.input.prompt,
          memberResults,
        }),
      },
    ],
    mode: "consult",
    timeoutMs: prepared.timeoutMs,
    fetchImpl,
  });
  const { truncated } = assertContentBudget(attempt, config.maxTokens.consult, "consult");
  const suffix = truncated
    ? `\n\n> Output truncated at MULTIPOLY_MAX_TOKENS_CONSULT (${config.maxTokens.consult}). Raise the cap for a complete answer.`
    : "";
  const status = `\n\n---\n\nMember status: ${successful.length}/${models.length} succeeded.`;
  const individual = input.include_individual_results
    ? `\n\nIndividual results:\n\n\`\`\`json\n${JSON.stringify(memberResults, null, 2)}\n\`\`\``
    : "";
  return { result: attempt.content + suffix + status + individual, reasoning: attempt.reasoning };
}
