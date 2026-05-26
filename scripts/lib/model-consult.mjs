import { MultipolyError } from "./errors.mjs";
import { gatherConsult } from "./gather.mjs";
import { scanMany, formatHitsForError } from "./secrets.mjs";
import { runModel } from "./run-model.mjs";
import { CONSULT_SYSTEM_PROMPT, renderConsultUserMessage } from "./prompts.mjs";
import { assertContentBudget } from "./budget.mjs";
import { resolveCallTimeoutMs, resolveMaxTokensForModel } from "./config.mjs";
import { modelSupportsThinking } from "./models.mjs";

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
  if (!secretScan.clean && !config.allowSecrets) {
    throw new MultipolyError(
      "SECRET",
      `Potential secrets detected in outbound payload:\n${formatHitsForError(secretScan.hits)}\nSet MULTIPOLY_ALLOW_SECRETS=1 to override.`,
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
  };
}

export async function runPreparedConsult(modelKey, prepared, { config, fetchImpl, execFileImpl, cwd } = {}) {
  const attempt = await runModel({
    config,
    modelKey,
    messages: prepared.messages,
    mode: "consult",
    timeoutMs: prepared.timeoutMs,
    fetchImpl,
    execFileImpl,
    cwd,
  });
  const maxTokens = resolveMaxTokensForModel(config, modelKey, "consult");
  const { truncated } = assertContentBudget(attempt, maxTokens, "consult", {
    modelKey,
    supportsThinking: modelSupportsThinking(config, modelKey),
  });
  const result = truncated
    ? `${attempt.content}\n\n> Output truncated at ${maxTokens ?? "provider/default max_tokens"}. Raise MULTIPOLY_MAX_TOKENS_CONSULT or a model-specific cap for a complete answer.`
    : attempt.content;
  return { result, reasoning: attempt.reasoning };
}

export async function handleModelConsult(modelKey, input, { config, fetchImpl, execFileImpl, cwd } = {}) {
  const prepared = await prepareConsult(input, { config, cwd });
  return runPreparedConsult(modelKey, prepared, { config, fetchImpl, execFileImpl, cwd });
}
