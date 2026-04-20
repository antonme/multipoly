import { GlmError } from "./errors.mjs";
import { gatherConsult } from "./gather.mjs";
import { scanMany } from "./secrets.mjs";
import { streamChatCompletion } from "./client.mjs";
import { CONSULT_SYSTEM_PROMPT, renderConsultUserMessage } from "./prompts.mjs";

function formatSecretHits(hits) {
  return hits.map((h) => `  - ${h.pattern} at ${h.label}:${h.line}`).join("\n");
}

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
      `Potential secrets detected in outbound payload:\n${formatSecretHits(secretScan.hits)}\nSet GLM_ALLOW_SECRETS=1 to override.`,
    );
  }

  const messages = [
    { role: "system", content: CONSULT_SYSTEM_PROMPT },
    { role: "user", content: renderConsultUserMessage(gathered.prompt, gathered.files) },
  ];

  const { content, reasoning } = await streamChatCompletion({
    config,
    messages,
    mode: "consult",
    fetchImpl,
  });
  return { result: content, reasoning };
}
