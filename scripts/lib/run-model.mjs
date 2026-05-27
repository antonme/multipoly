import { MultipolyError } from "./errors.mjs";
import { streamChatCompletion } from "./client.mjs";
import { runCliModel } from "./transport/cli.mjs";
import { runAnthropicModel } from "./transport/anthropic.mjs";

/**
 * Transport dispatcher: the single seam through which every model call flows,
 * regardless of how the model is reached. Returns the uniform completion shape
 *   { content, reasoning, finishReason, usage, fellBackFromJsonSchema }
 * so callers (review / consult / council) stay transport-agnostic.
 *
 * Budget checks, JSON validation/reprompt, and the secret-scan-before-synthesis
 * all live ABOVE this seam in the caller — runModel only performs the wire call.
 *
 * Transports:
 *   - "http" (default): OpenAI-compatible streaming /chat/completions.
 *   - "anthropic": native Anthropic Messages API (added in a later task).
 *   - "cli": local agent harness subprocess (added in a later task).
 *
 * @param {object} args — streamChatCompletion args plus `execFileImpl` (the
 *   process-spawn seam used by the future cli transport; accepted now so the
 *   call sites and their tests don't change again when cli lands).
 */
export async function runModel(args) {
  const { config, modelKey } = args;
  const transport = config?.models?.[modelKey]?.transport ?? "http";

  if (transport === "http") {
    // Forward exactly the args streamChatCompletion understands; execFileImpl
    // is ignored by the http path. reasoningEffort is passed through so the
    // transport can resolve and apply it (Tasks 8-10 consume it).
    const { execFileImpl, ...httpArgs } = args;
    return streamChatCompletion(httpArgs);
  }

  if (transport === "cli") {
    return runCliModel(args);
  }

  if (transport === "anthropic") {
    const { execFileImpl, ...anthropicArgs } = args;
    return runAnthropicModel(anthropicArgs);
  }

  throw new MultipolyError(
    "CONFIG",
    `transport "${transport}" is not implemented yet for model "${modelKey}"`,
  );
}
