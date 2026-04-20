import { GlmError } from "./errors.mjs";
import { scan } from "./secrets.mjs";
import { streamChatCompletion } from "./client.mjs";
import { FREEFORM_SYSTEM_PROMPT } from "./prompts.mjs";

export async function handleFreeform(input, { config, fetchImpl } = {}) {
  if (typeof input?.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new GlmError("INVALID_INPUT", "prompt must be a non-empty string");
  }
  const { hits, clean } = scan(input.prompt, "prompt");
  if (!clean && !config.allowSecrets) {
    const formatted = hits.map((h) => `  - ${h.pattern} at ${h.label}:${h.line}`).join("\n");
    throw new GlmError(
      "SECRET",
      `Potential secrets detected in outbound payload:\n${formatted}\nSet GLM_ALLOW_SECRETS=1 to override.`,
    );
  }
  const messages = [
    { role: "system", content: FREEFORM_SYSTEM_PROMPT },
    { role: "user", content: input.prompt },
  ];
  const { content, reasoning } = await streamChatCompletion({
    config,
    messages,
    mode: "freeform",
    fetchImpl,
  });
  return { result: content, reasoning };
}
