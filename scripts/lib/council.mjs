import { MultipolyError } from "./errors.mjs";
import { MODEL_KEYS, modelSupportsThinking } from "./models.mjs";
import { resolveModelAlias, didYouMean } from "./aliases.mjs";
import { normalizeEffort } from "./reasoning.mjs";
import { prepareReview, runPreparedReview } from "./model-review.mjs";
import { prepareConsult, runPreparedConsult } from "./model-consult.mjs";
import { runModel } from "./run-model.mjs";
import {
  COUNCIL_REVIEW_SYNTHESIS_PROMPT,
  COUNCIL_CONSULT_SYNTHESIS_PROMPT,
  renderCouncilReviewSynthesisMessage,
  renderCouncilConsultSynthesisMessage,
  safeFence,
  parseModelJson,
} from "./prompts.mjs";
import { COUNCIL_REVIEW_SCHEMA, validateCouncilReview, normalizeFindings } from "./schema.mjs";
import { assertContentBudget } from "./budget.mjs";
import {
  resolveMaxTokensForModel,
  normalizeSynthesizerChoice,
  HARNESS_SENTINEL,
  SYNTHESIZER_FALLBACK_ORDER,
} from "./config.mjs";
import { scanMany, formatHitsForError } from "./secrets.mjs";

// Threshold in chars above which a payload hint is surfaced to the harness.
const COUNCIL_LARGE_PAYLOAD_CHARS = 80000;

const COUNCIL_REVIEW_JSON_ONLY_PREFIX =
  "Your previous council synthesis was not valid JSON matching the schema. Respond ONLY with valid JSON exactly matching the schema. No prose, no code fences, no leading or trailing text.";

// Directives handed to the calling harness in defer mode (no server-side
// synthesizer model). The harness is already the orchestrator that invoked
// the tool, so it synthesizes the member outputs itself.
const HARNESS_REVIEW_INSTRUCTIONS =
  "These are independent code reviews from multiple models, each as strict findings. " +
  "Merge them into one de-duplicated review: prefer correctness, security, data-loss, and " +
  "production-risk over style; drop duplicate findings; preserve material disagreements. " +
  "Present a single review to the user.";

const HARNESS_CONSULT_INSTRUCTIONS =
  "Synthesize the member answers above into one concise final answer. Merge the best arguments; " +
  "surface disagreements only when they affect the decision; do not average weak opinions into a " +
  "vague compromise.";

export function resolveCouncilModels(input, config) {
  const known = config.modelKeys ?? MODEL_KEYS;
  let requested;
  if (input.models?.length) {
    requested = input.models.map((raw) => {
      const resolved = resolveModelAlias(raw, known);
      if (!resolved) {
        throw new MultipolyError(
          "INVALID_INPUT",
          `unknown model ${JSON.stringify(raw)}; expected one of ${known.join(", ")}${didYouMean(raw, known)}`,
        );
      }
      return resolved;
    });
  } else {
    requested = known.filter((key) => config.models[key]?.configured);
  }
  const unique = [...new Set(requested)]; // dedups alias collapse silently
  if (unique.length < 2) {
    throw new MultipolyError("INVALID_INPUT", "council requires at least two distinct models");
  }
  const missing = unique.filter((key) => !config.models[key]?.configured);
  if (missing.length > 0) {
    throw new MultipolyError(
      "CONFIG",
      `council requested unconfigured models: ${missing.join(", ")}`,
      { details: { missing } },
    );
  }
  return unique;
}

/**
 * Decide how the council synthesizes.
 *
 *   - { mode: "harness" } → defer: return member outputs to the calling harness.
 *   - { mode: "model", key } → run that configured model as the synthesizer.
 *
 * The "chosen one" is the per-call `synthesizer` arg if present, else the
 * env-configured `config.synthesizer`. When the chosen one is a model key it
 * heads the fall-through chain (chosen → qwen → deepseek → glm → composer →
 * any other configured model) and the first CONFIGURED model wins — an
 * explicitly named but unconfigured synthesizer falls through rather than
 * erroring. When nothing is chosen, or the choice is the "harness" sentinel,
 * we defer to the calling harness.
 */
function resolveSynthesisTarget(input, config) {
  const modelKeys = config.modelKeys ?? MODEL_KEYS;
  let chosen;
  if (input.synthesizer !== undefined) {
    chosen = normalizeSynthesizerChoice(input.synthesizer, modelKeys);
    if (chosen === null) {
      throw new MultipolyError(
        "INVALID_INPUT",
        `unknown synthesizer ${JSON.stringify(input.synthesizer)}; expected one of ${[...modelKeys, "harness", "none", "caller"].join(", ")}`,
      );
    }
  } else {
    chosen = config.synthesizer; // normalized at config load, or undefined
  }

  if (chosen === undefined || chosen === HARNESS_SENTINEL) return { mode: "harness" };

  // Builtin preference order first, then any remaining (custom) configured
  // models, so an explicit-but-unconfigured choice still lands on a real model.
  // When the chosen key is not the one that actually runs, log a diagnostic
  // so the operator knows a fallthrough occurred.
  let firstAttempt = true;
  for (const key of [chosen, ...SYNTHESIZER_FALLBACK_ORDER, ...modelKeys]) {
    if (config.models[key]?.configured) {
      if (!firstAttempt && chosen !== key) {
        process.stderr.write(
          JSON.stringify({
            event: "synthesizer_fallback",
            chosen,
            used: key,
            reason: "chosen synthesizer is not configured; fell through to the next available model",
          }) + "\n",
        );
      }
      return { mode: "model", key };
    }
    firstAttempt = false;
  }
  // Unreachable while the council quorum holds (≥2 configured members). Defer
  // rather than error if it somehow is.
  return { mode: "harness" };
}

function serializeError(e) {
  if (e instanceof MultipolyError) return e.toJSON().error;
  return { code: "INTERNAL", message: e?.message ?? String(e) };
}

/**
 * Run every council member in parallel and collect results. Throws COUNCIL if
 * fewer than two members succeed (a council needs a quorum to be meaningful).
 *
 * `reasoningEffort` is the per-call effort from the council tool input; it is
 * forwarded into the prepared object for each member so each transport can
 * resolve the effective effort against its own per-model baseline (Tasks 8-10).
 */
async function runCouncilMembers({ models, prepared, runPrepared, config, fetchImpl, execFileImpl, reasoningEffort }) {
  const settled = await Promise.allSettled(
    models.map(async (modelKey) => {
      // Forward the per-call effort by patching it onto the prepared object
      // for this member. The prepared object is shared across members so we
      // create a shallow copy rather than mutating the original.
      const memberPrepared = reasoningEffort !== undefined
        ? { ...prepared, reasoningEffort }
        : prepared;
      const out = await runPrepared(modelKey, memberPrepared, { config, fetchImpl, execFileImpl });
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
    throw new MultipolyError("COUNCIL", "council requires at least two successful member results", {
      details: { memberResults },
    });
  }
  return { memberResults, successful };
}

/**
 * Scan council member OUTPUTS before relaying them to a synthesizer model on a
 * (possibly different) provider. Inbound files are already scanned pre-flight;
 * this closes the second hop where a member's output could echo a secret the
 * inbound scan missed. No-op when the operator has allowed secrets.
 */
function assertMemberOutputsClean(pieces, config) {
  if (config.allowSecrets) return;
  const result = scanMany(pieces);
  if (!result.clean) {
    throw new MultipolyError(
      "SECRET",
      `Potential secrets detected in council member outputs before synthesis:\n${formatHitsForError(result.hits)}\nSet MULTIPOLY_ALLOW_SECRETS=1 to override.`,
    );
  }
}

function reviewMemberSecretPieces(memberResults) {
  const pieces = [];
  for (const [key, value] of Object.entries(memberResults)) {
    if (!value.ok) continue;
    pieces.push({ text: value.result.summary_md ?? "", label: `${key}.summary` });
    for (const f of value.result.findings ?? []) {
      // Scan every string field the synthesizer would see, including path —
      // a model can surface a secret in any of them.
      pieces.push({
        text: `${f.path ?? ""}\n${f.message ?? ""}\n${f.suggestion ?? ""}`,
        label: `${key}.finding`,
      });
    }
  }
  return pieces;
}

function consultMemberSecretPieces(memberResults) {
  return Object.entries(memberResults)
    .filter(([, v]) => v.ok)
    .map(([key, v]) => ({ text: v.result, label: `${key}.answer` }));
}

function renderCouncilReviewOriginalRequest(prepared) {
  const request = {
    mode: prepared.gathered.mode,
  };
  if (prepared.gathered.mode === "diff") {
    request.diff_base = prepared.gathered.base;
  } else {
    request.paths = prepared.gathered.files.map((f) => f.path);
  }
  if (typeof prepared.input.focus === "string" && prepared.input.focus.trim()) {
    request.focus = safeTruncate(prepared.input.focus.trim(), 4096);
  }
  request.files_considered = prepared.gathered.files.length;
  request.truncated = Boolean(prepared.gathered.truncated);
  return JSON.stringify(request, null, 2);
}

function budgetContextFor(config, modelKey) {
  return { modelKey, supportsThinking: modelSupportsThinking(config, modelKey) };
}

function buildMemberStatus(memberResults) {
  return Object.fromEntries(
    Object.entries(memberResults).map(([key, value]) => [
      key,
      value.ok
        ? { ok: true, findings: value.result.findings.length }
        : { ok: false, error: value.error },
    ]),
  );
}

function buildFailureSummary(memberResults, models) {
  const failed = Object.entries(memberResults).filter(([, v]) => !v.ok);
  if (failed.length === 0) return "";
  const parts = failed.map(([k, v]) => `${k} (${v.error?.code ?? "UNKNOWN"})`);
  return `${failed.length}/${models.length} members failed: ${parts.join(", ")}`;
}

async function synthesizeCouncilReview({
  config,
  synthesizer,
  prepared,
  memberResults,
  timeoutMs,
  fetchImpl,
  execFileImpl,
}) {
  const messages = [
    { role: "system", content: COUNCIL_REVIEW_SYNTHESIS_PROMPT },
    {
      role: "user",
      content: renderCouncilReviewSynthesisMessage({
        originalPrompt: renderCouncilReviewOriginalRequest(prepared),
        memberResults: reviewMembersForSynthesis(memberResults),
        schema: COUNCIL_REVIEW_SCHEMA,
      }),
    },
  ];
  const responseFormat = {
    type: "json_schema",
    json_schema: { name: "council_review", strict: true, schema: COUNCIL_REVIEW_SCHEMA },
  };

  const attempt1 = await runModel({
    config,
    modelKey: synthesizer,
    messages,
    mode: "review",
    responseFormat,
    timeoutMs,
    fetchImpl,
    execFileImpl,
  });
  const maxTokens = resolveMaxTokensForModel(config, synthesizer, "review");
  const budgetContext = budgetContextFor(config, synthesizer);
  assertContentBudget(attempt1, maxTokens, "review", budgetContext);

  let parsed = parseModelJson(attempt1.content);
  let validation = parsed.ok ? validateCouncilReview(parsed.value) : { valid: false, reason: parsed.error };
  let reasoning = attempt1.reasoning;

  if (!validation.valid) {
    const attempt2 = await runModel({
      config,
      modelKey: synthesizer,
      messages: [
        ...messages,
        { role: "assistant", content: safeTruncate(attempt1.content, 8192) },
        {
          role: "user",
          content:
            COUNCIL_REVIEW_JSON_ONLY_PREFIX +
            (validation.reason ? `\n\nValidation error: ${validation.reason}` : ""),
        },
      ],
      mode: "review",
      responseFormat: attempt1.fellBackFromJsonSchema ? { type: "json_object" } : responseFormat,
      timeoutMs,
      fetchImpl,
      execFileImpl,
    });
    assertContentBudget(attempt2, maxTokens, "review", budgetContext);
    if (attempt2.reasoning) reasoning = attempt2.reasoning;
    parsed = parseModelJson(attempt2.content);
    validation = parsed.ok ? validateCouncilReview(parsed.value) : { valid: false, reason: parsed.error };
    if (!validation.valid) {
      throw new MultipolyError("SCHEMA", `council review output failed validation: ${validation.reason}`);
    }
  }

  return { parsed: parsed.value, reasoning };
}

function safeTruncate(s, max) {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + "\n...[prior invalid output truncated]";
}

/**
 * Project a member review result down to only the fields a synthesizer needs
 * (findings + summary). Drops server-authoritative fields (files, truncated,
 * schema_version, model) so the synthesis prompt isn't bloated by the file
 * roster repeated once per member.
 */
function reviewMembersForSynthesis(memberResults) {
  return Object.fromEntries(
    Object.entries(memberResults).map(([key, value]) => [
      key,
      value.ok
        ? { ok: true, findings: value.result.findings, summary_md: value.result.summary_md }
        : { ok: false, summary: `call failed: ${value.error?.code ?? "UNKNOWN"}` },
    ]),
  );
}

function consultMembersForSynthesis(memberResults) {
  return Object.fromEntries(
    Object.entries(memberResults).map(([key, value]) => [
      key,
      value.ok
        ? { ok: true, answer: value.result }
        : { ok: false, summary: `call failed: ${value.error?.code ?? "UNKNOWN"}` },
    ]),
  );
}

function councilSynthesisError(err, memberResults) {
  return new MultipolyError("COUNCIL", `council synthesis failed: ${err?.message ?? String(err)}`, {
    cause: err,
    details: {
      synthesis: serializeError(err),
      memberResults,
    },
  });
}

function buildHarnessReviewResult({ input, models, memberResults, prepared }) {
  const members = {};
  for (const [key, value] of Object.entries(memberResults)) {
    if (value.ok) {
      // 3b: compact mode drops summary_md to shrink large payloads.
      members[key] = input.compact
        ? { findings: value.result.findings }
        : { findings: value.result.findings, summary_md: value.result.summary_md };
    }
  }
  // 3a: member_results carries only failed members — ok members are fully
  // represented by `members` + `member_status`, so re-embedding them doubles
  // the payload for no benefit.
  const failedMemberResults = input.include_individual_results
    ? Object.fromEntries(Object.entries(memberResults).filter(([, v]) => !v.ok))
    : undefined;

  const result = {
    schema_version: "1",
    synthesizer: HARNESS_SENTINEL,
    mode: "members",
    models,
    instructions: HARNESS_REVIEW_INSTRUCTIONS,
    members,
    files: prepared.gathered.files.map(({ content, ...rest }) => rest),
    truncated: prepared.gathered.truncated,
    member_status: buildMemberStatus(memberResults),
    failure_summary: buildFailureSummary(memberResults, models),
    ...(input.include_individual_results ? { member_results: failedMemberResults } : {}),
  };

  // 3c: surface a hint when the payload is unusually large (>= threshold).
  const serialized = JSON.stringify(result);
  if (serialized.length >= COUNCIL_LARGE_PAYLOAD_CHARS) {
    result.notice =
      `Large council payload (${serialized.length} chars). Pass \`compact: true\` or a \`synthesizer\` ` +
      `(or set MULTIPOLY_SYNTHESIZER) to shrink/merge server-side.`;
  }

  return result;
}

function buildHarnessConsultResult({ models, memberResults, successful, input }) {
  const parts = ["# Council member answers", ""];
  for (const [key, value] of Object.entries(memberResults)) {
    parts.push(`## ${key}`);
    parts.push(value.ok ? value.result : `_call failed: ${value.error?.code ?? "UNKNOWN"}_`);
    parts.push("");
  }
  parts.push("# Your task");
  parts.push(HARNESS_CONSULT_INSTRUCTIONS);
  parts.push(
    `\n---\n\nMember status: ${successful.length}/${models.length} succeeded. ` +
      `No server-side synthesizer was configured; set MULTIPOLY_SYNTHESIZER (or pass a synthesizer) to merge with a model instead.`,
  );
  const individual = input.include_individual_results
    ? `\n\nIndividual results:\n\n${safeFence(JSON.stringify(memberResults, null, 2), "json")}`
    : "";
  const body = parts.join("\n") + individual;
  const summary = buildFailureSummary(memberResults, models);
  const text = summary ? `${summary}\n\n${body}` : body;

  // 3c: surface a hint when the payload is unusually large (>= threshold).
  if (text.length >= COUNCIL_LARGE_PAYLOAD_CHARS) {
    return (
      text +
      `\n\nLarge council payload (${text.length} chars). Pass \`compact: true\` or a \`synthesizer\` ` +
      `(or set MULTIPOLY_SYNTHESIZER) to shrink/merge server-side.`
    );
  }
  return text;
}

export async function handleCouncilReview(input, { config, fetchImpl, execFileImpl } = {}) {
  const models = resolveCouncilModels(input, config);
  const target = resolveSynthesisTarget(input, config);
  const prepared = await prepareReview(input, { config });
  const reasoningEffort = normalizeEffort(input.reasoning_effort);

  const { memberResults } = await runCouncilMembers({
    models,
    prepared,
    runPrepared: runPreparedReview,
    config,
    fetchImpl,
    execFileImpl,
    reasoningEffort,
  });

  if (target.mode === "harness") {
    return { result: buildHarnessReviewResult({ input, models, memberResults, prepared }) };
  }

  // Server-side synthesis: scan member outputs before sending them upstream.
  assertMemberOutputsClean(reviewMemberSecretPieces(memberResults), config);

  let synthesis;
  try {
    synthesis = await synthesizeCouncilReview({
      config,
      synthesizer: target.key,
      prepared,
      memberResults,
      timeoutMs: prepared.timeoutMs,
      fetchImpl,
      execFileImpl,
    });
  } catch (err) {
    throw councilSynthesisError(err, memberResults);
  }
  const { parsed, reasoning } = synthesis;

  // Synthesis mode: include_individual_results returns the FULL memberResults
  // (all members, ok + failed). Unlike harness-defer mode, synthesis results have
  // no `members` block carrying ok-member findings, so filtering to failures-only
  // would silently discard the individual results the caller explicitly requested.
  const synthMemberResults = input.include_individual_results
    ? memberResults
    : undefined;

  return {
    result: {
      schema_version: "1",
      synthesizer: target.key,
      models,
      findings: normalizeFindings(parsed.findings),
      summary_md: parsed.summary_md,
      files: prepared.gathered.files.map(({ content, ...rest }) => rest),
      truncated: prepared.gathered.truncated,
      member_status: buildMemberStatus(memberResults),
      failure_summary: buildFailureSummary(memberResults, models),
      ...(input.include_individual_results ? { member_results: synthMemberResults } : {}),
    },
    reasoning,
  };
}

export async function handleCouncilConsult(input, { config, fetchImpl, execFileImpl } = {}) {
  const models = resolveCouncilModels(input, config);
  const target = resolveSynthesisTarget(input, config);
  const prepared = await prepareConsult(input, { config });
  const reasoningEffort = normalizeEffort(input.reasoning_effort);

  const { memberResults, successful } = await runCouncilMembers({
    models,
    prepared,
    runPrepared: runPreparedConsult,
    config,
    fetchImpl,
    execFileImpl,
    reasoningEffort,
  });

  if (target.mode === "harness") {
    return { result: buildHarnessConsultResult({ models, memberResults, successful, input }) };
  }

  assertMemberOutputsClean(consultMemberSecretPieces(memberResults), config);

  try {
    const attempt = await runModel({
      config,
      modelKey: target.key,
      messages: [
        { role: "system", content: COUNCIL_CONSULT_SYNTHESIS_PROMPT },
        {
          role: "user",
          content: renderCouncilConsultSynthesisMessage({
            originalPrompt: prepared.input.prompt,
            memberResults: consultMembersForSynthesis(memberResults),
          }),
        },
      ],
      mode: "consult",
      timeoutMs: prepared.timeoutMs,
      fetchImpl,
      execFileImpl,
    });
    const maxTokens = resolveMaxTokensForModel(config, target.key, "consult");
    const { truncated } = assertContentBudget(attempt, maxTokens, "consult", budgetContextFor(config, target.key));
    const suffix = truncated
      ? `\n\n> Output truncated at ${maxTokens ?? "provider/default max_tokens"}. Raise MULTIPOLY_MAX_TOKENS_CONSULT or a model-specific cap for a complete answer.`
      : "";
    const failureSummary = buildFailureSummary(memberResults, models);
    const status = `\n\n---\n\nMember status: ${successful.length}/${models.length} succeeded.${failureSummary ? ` ${failureSummary}` : ""}`;
    const individual = input.include_individual_results
      ? `\n\nIndividual results:\n\n${safeFence(JSON.stringify(memberResults, null, 2), "json")}`
      : "";
    return { result: attempt.content + suffix + status + individual, reasoning: attempt.reasoning };
  } catch (err) {
    throw councilSynthesisError(err, memberResults);
  }
}
