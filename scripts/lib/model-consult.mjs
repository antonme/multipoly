import { MultipolyError } from "./errors.mjs";
import { gatherConsult } from "./gather.mjs";
import { scanMany, formatHitsForError } from "./secrets.mjs";
import { CONSULT_SYSTEM_PROMPT, renderConsultUserMessage } from "./prompts.mjs";
import { resolveCallTimeoutMs, resolveMaxTokensForModel } from "./config.mjs";
import { modelSupportsThinking } from "./models.mjs";
import { normalizeEffort, resolveReasoningEffort } from "./reasoning.mjs";
import { callWithBudgetRetry } from "./budget-retry.mjs";

export async function prepareConsult(input, { config, cwd = process.cwd() } = {}) {
  const gathered = await gatherConsult({
    prompt: input.prompt,
    paths: input.paths,
    cwd,
    caps: config.caps,
  });

  const pieces = [{ text: gathered.prompt, label: "prompt" }];
  for (const f of gathered.files) pieces.push({ text: f.content, label: f.path });
  const secretScan = scanMany(pieces);
  if (!secretScan.clean && !(config.allowSecrets || input.allow_secrets === true)) {
    throw new MultipolyError(
      "SECRET",
      `Potential secrets detected in outbound payload:\n${formatHitsForError(secretScan.hits)}\nSet MULTIPOLY_ALLOW_SECRETS=1 or pass allow_secrets:true to override.`,
    );
  }

  return {
    input,
    gathered,
    messages: [
      { role: "system", content: CONSULT_SYSTEM_PROMPT },
      { role: "user", content: renderConsultUserMessage(gathered.prompt, gathered.files) },
    ],
    timeoutMs: resolveCallTimeoutMs(input.timeout_ms),
    reasoningEffort: normalizeEffort(input.reasoning_effort),
  };
}

export async function runPreparedConsult(modelKey, prepared, { config, fetchImpl, execFileImpl, cwd } = {}) {
  const maxTokens = resolveMaxTokensForModel(config, modelKey, "consult");
  const budgetContext = {
    modelKey,
    supportsThinking: modelSupportsThinking(config, modelKey),
  };

  // Compute the effective reasoning effort (mirrors transport resolution).
  const modelConfig = config?.models?.[modelKey];
  const bakedDefault = modelConfig?.reasoningEffort ?? "off";
  const effectiveEffort = resolveReasoningEffort({
    perCall: prepared.reasoningEffort,
    bakedDefault,
  });

  const { attempt, truncated, maxTokensUsed } = await callWithBudgetRetry({
    runModelArgs: {
      config,
      modelKey,
      messages: prepared.messages,
      mode: "consult",
      timeoutMs: prepared.timeoutMs,
      reasoningEffort: prepared.reasoningEffort,
      fetchImpl,
      execFileImpl,
      cwd,
    },
    mode: "consult",
    maxTokens,
    budgetContext,
    effectiveEffort,
  });

  const result = truncated
    ? `${attempt.content}\n\n> Output truncated at ${maxTokensUsed ?? "provider/default max_tokens"}. Raise MULTIPOLY_MAX_TOKENS_CONSULT or a model-specific cap for a complete answer.`
    : attempt.content;
  return { result, reasoning: attempt.reasoning };
}

export async function handleModelConsult(modelKey, input, { config, fetchImpl, execFileImpl, cwd } = {}) {
  const prepared = await prepareConsult(input, { config, cwd });
  return runPreparedConsult(modelKey, prepared, { config, fetchImpl, execFileImpl, cwd });
}
