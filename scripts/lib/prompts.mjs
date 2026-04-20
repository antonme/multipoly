import { REVIEW_SCHEMA } from "./schema.mjs";

export const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer giving a focused, blunt second-opinion review.

Rules:
- Output STRICT JSON conforming exactly to the provided schema. No prose outside the JSON.
- Severity scale: blocker (will break prod / security) > high (correctness / data) > medium (maintainability / perf) > low > nit.
- Prefer fewer, high-signal findings over volume. Skip style nits unless they cause real bugs.
- Cite specific file + line. If uncertain about the line, omit it rather than guess.
- Suggestions should be concrete (diff-style when helpful), not generic advice.
- Keep summary_md tight — 3-8 bullets.

Schema:
${JSON.stringify(REVIEW_SCHEMA, null, 2)}`;

export const REVIEW_JSON_ONLY_PREFIX = `Your previous response was not valid JSON matching the schema. Respond ONLY with valid JSON exactly matching the schema. No prose, no code fences, no leading or trailing text.`;

export const CONSULT_SYSTEM_PROMPT = `You are a senior engineer giving a second opinion on a hard design or implementation question.

- Engage with the concrete problem, not meta-advice.
- Highlight tradeoffs, hidden assumptions, and likely blind spots in the approach presented.
- If the premise is wrong, say so plainly and suggest a better framing.
- Be concise. Markdown with light structure (short sections or bullets) is fine.
- No sycophancy, no "great question" openers.`;

export const FREEFORM_SYSTEM_PROMPT = `You are a capable, terse assistant. Answer directly. Use markdown when helpful.`;

/**
 * Build user message for review mode.
 * @param {object} gathered — result of gather.gatherReview.
 * @param {string} [focus] — optional caller focus/steering text.
 */
export function renderReviewUserMessage(gathered, focus) {
  const parts = [];
  if (focus && focus.trim()) {
    parts.push(`# Reviewer focus\n${focus.trim()}`);
  }
  if (gathered.mode === "diff") {
    parts.push(`# Git diff (${gathered.base}...HEAD)\n\n\`\`\`diff\n${gathered.diffText}\n\`\`\``);
  }
  const inlined = gathered.files.filter((f) => f.status === "inlined");
  if (inlined.length) {
    parts.push("# Changed files (full contents)");
    for (const f of inlined) {
      parts.push(`\n## \`${f.path}\`\n\n\`\`\`\n${f.content}\n\`\`\``);
    }
  }
  const listedOnly = gathered.files.filter((f) => f.status === "listed_only");
  if (listedOnly.length) {
    parts.push(
      `# Files listed but not inlined (over budget)\n${listedOnly.map((f) => `- ${f.path} (${f.reason})`).join("\n")}`,
    );
  }
  const omitted = gathered.files.filter((f) => f.status === "omitted");
  if (omitted.length) {
    parts.push(
      `# Files omitted (exceed per-file cap)\n${omitted.map((f) => `- ${f.path} (${f.reason})`).join("\n")}`,
    );
  }
  parts.push(
    "# Your task\nReview the above. Return JSON exactly matching the schema. Do not include omitted/listed_only files in findings — you cannot see their contents.",
  );
  return parts.join("\n\n");
}

/**
 * Build user message for consult mode.
 */
export function renderConsultUserMessage(prompt, files) {
  const parts = [];
  if (files && files.length) {
    parts.push("# Attached context");
    for (const f of files) {
      parts.push(`\n## \`${f.path}\`\n\n\`\`\`\n${f.content}\n\`\`\``);
    }
    parts.push("# Question");
  }
  parts.push(prompt);
  return parts.join("\n\n");
}
