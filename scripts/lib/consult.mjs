import { GlmError } from "./errors.mjs";
import { gatherConsult } from "./gather.mjs";
import { scanMany, formatHitsForError } from "./secrets.mjs";
import { streamChatCompletion } from "./client.mjs";
import { CONSULT_SYSTEM_PROMPT, renderConsultUserMessage } from "./prompts.mjs";
import { assertContentBudget } from "./budget.mjs";
import { resolveCallTimeoutMs } from "./config.mjs";

export async function handleConsult(input, { config, fetchImpl } = {}) {
  const gathered = await gatherConsult({
    prompt: input.prompt,
    paths: input.paths,
    cwd: process.cwd(),
    caps: config.caps,
  });

  const pieces = [{ text: gathered.prompt, label: "prompt" }];
  for (const f of gathered.files) pieces.push({ text: f.content, label: f.path });
  const secretScan = scanMany(pieces);
  if (!secretScan.clean && !config.allowSecrets) {
    throw new GlmError(
      "SECRET",
      `Potential secrets detected in outbound payload:\n${formatHitsForError(secretScan.hits)}\nSet GLM_ALLOW_SECRETS=1 to override.`,
    );
  }

  const messages = [
    { role: "system", content: CONSULT_SYSTEM_PROMPT },
    { role: "user", content: renderConsultUserMessage(gathered.prompt, gathered.files) },
  ];

  const attempt = await streamChatCompletion({
    config,
    messages,
    mode: "consult",
    timeoutMs: resolveCallTimeoutMs(input.timeout_ms),
    fetchImpl,
  });
  const { truncated } = assertContentBudget(attempt, config.maxTokens.consult, "consult");
  const result = truncated
    ? `${attempt.content}\n\n> ⚠ Output truncated at GLM_MAX_TOKENS_CONSULT (${config.maxTokens.consult}). Raise the cap for a complete answer.`
    : attempt.content;
  return { result, reasoning: attempt.reasoning };
}
