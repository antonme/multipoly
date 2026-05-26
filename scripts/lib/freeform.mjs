import { GlmError } from "./errors.mjs";
import { scan, formatHitsForError } from "./secrets.mjs";
import { streamChatCompletion } from "./client.mjs";
import { FREEFORM_SYSTEM_PROMPT } from "./prompts.mjs";
import { assertContentBudget } from "./budget.mjs";
import { resolveCallTimeoutMs } from "./config.mjs";

export async function handleFreeform(input, { config, fetchImpl } = {}) {
  if (typeof input?.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new GlmError("INVALID_INPUT", "prompt must be a non-empty string");
  }
  const { hits, clean } = scan(input.prompt, "prompt");
  if (!clean && !config.allowSecrets) {
    throw new GlmError(
      "SECRET",
      `Potential secrets detected in outbound payload:\n${formatHitsForError(hits)}\nSet GLM_ALLOW_SECRETS=1 to override.`,
    );
  }
  const messages = [
    { role: "system", content: FREEFORM_SYSTEM_PROMPT },
    { role: "user", content: input.prompt },
  ];
  const attempt = await streamChatCompletion({
    config,
    messages,
    mode: "freeform",
    timeoutMs: resolveCallTimeoutMs(input.timeout_ms),
    fetchImpl,
  });
  const { truncated } = assertContentBudget(attempt, config.maxTokens.freeform, "freeform");
  const result = truncated
    ? `${attempt.content}\n\n> ⚠ Output truncated at GLM_MAX_TOKENS_FREEFORM (${config.maxTokens.freeform}). Raise the cap for a complete answer.`
    : attempt.content;
  return { result, reasoning: attempt.reasoning };
}
