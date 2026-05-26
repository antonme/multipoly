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

/**
 * Wrap `content` in a fenced code block using a fence longer than any run of
 * backticks inside the content. Prevents a reviewed file that itself contains
 * ``` from breaking out of the fence and injecting prompt text.
 */
export function safeFence(content, lang = "") {
  const runs = String(content).match(/`{3,}/g) || [];
  const maxRun = runs.reduce((m, s) => Math.max(m, s.length), 2);
  const delim = "`".repeat(maxRun + 1);
  return `${delim}${lang}\n${content}\n${delim}`;
}

export function stripCodeFence(text) {
  const s = String(text);
  const labeled = s.match(/(?:^|\r?\n)\s*(`{3,})\s*json\s*\r?\n/i);
  if (labeled) return stripFenceAt(s, labeled.index + labeled[0].search(/`{3,}/));
  const leading = s.match(/^\s*(`{3,})(?:\s*json)?\s*\r?\n/i);
  if (!leading) return text;
  return stripFenceAt(s, leading.index + leading[0].search(/`{3,}/));
}

function stripFenceAt(text, fenceStart) {
  const openMatch = text.slice(fenceStart).match(/^(`{3,})(?:\s*json)?\s*\r?\n/i);
  if (!openMatch) return text;
  const afterOpen = text.slice(fenceStart + openMatch[0].length);
  const closing = openMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return afterOpen.replace(new RegExp(`\\r?\\n\\s*${closing}\\s*(?:\\r?\\n[\\s\\S]*)?$`), "");
}

/**
 * Sanitize repo-derived strings (file paths, omission reasons) before they
 * appear in markdown structure. Git tracks filenames with embedded newlines,
 * tabs, and control bytes; interpolating them raw into a `## ${f.path}`
 * heading or `- ${f.path}` bullet lets a malicious repo inject new headings
 * or list items into the prompt sent to the model. Replace control chars and
 * surrounding backticks with a visible `?` so the display is unambiguous and
 * the structural layer of the prompt stays intact. Length-capped so a
 * pathological 10KB filename can't dominate the prompt.
 */
function sanitizeDisplay(s) {
  const MAX = 512;
  const raw = String(s ?? "");
  // Build the replacement manually rather than with a raw-byte regex
  // literal: embedding /[\x00-\x1f\x7f]/ here as literal bytes would
  // write a NUL into the source file and git would flag it as binary,
  // breaking diffs and many editors. Walking codepoints is slightly
  // slower but keeps the source text-clean.
  let cleaned = "";
  for (let i = 0; i < raw.length; i++) {
    const cp = raw.charCodeAt(i);
    if (cp < 0x20 || cp === 0x7f || cp === 0x60 /* backtick */) cleaned += "?";
    else cleaned += raw[i];
  }
  return cleaned.length > MAX ? cleaned.slice(0, MAX) + "…" : cleaned;
}

/**
 * Build user message for review mode.
 * @param {object} gathered — result of gather.gatherReview.
 * @param {string} [focus] — optional caller focus/steering text.
 */
export function renderReviewUserMessage(gathered, focus) {
  const parts = [];
  if (focus && focus.trim()) {
    // Fence the focus so any markdown headings in it can't be misread as
    // structural sections of the prompt.
    parts.push(`# Reviewer focus\n${safeFence(focus.trim())}`);
  }
  if (gathered.mode === "diff") {
    parts.push(`# Git diff (${gathered.base}...HEAD)\n\n${safeFence(gathered.diffText, "diff")}`);
  }
  const inlined = gathered.files.filter((f) => f.status === "inlined");
  if (inlined.length) {
    parts.push("# Changed files (full contents)");
    for (const f of inlined) {
      parts.push(`\n## \`${sanitizeDisplay(f.path)}\`\n\n${safeFence(f.content)}`);
    }
  }
  const listedOnly = gathered.files.filter((f) => f.status === "listed_only");
  if (listedOnly.length) {
    parts.push(
      `# Files listed but not inlined (over budget)\n${listedOnly.map((f) => `- ${sanitizeDisplay(f.path)} (${sanitizeDisplay(f.reason)})`).join("\n")}`,
    );
  }
  const omitted = gathered.files.filter((f) => f.status === "omitted");
  if (omitted.length) {
    parts.push(
      `# Files omitted (exceed per-file cap)\n${omitted.map((f) => `- ${sanitizeDisplay(f.path)} (${sanitizeDisplay(f.reason)})`).join("\n")}`,
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
      parts.push(`\n## \`${sanitizeDisplay(f.path)}\`\n\n${safeFence(f.content)}`);
    }
    parts.push("# Question");
  }
  parts.push(prompt);
  return parts.join("\n\n");
}

export const COUNCIL_REVIEW_SYNTHESIS_PROMPT = `You are a council chair synthesizing review outputs from multiple models.

You will receive structured review outputs from multiple models. Merge them into one high-signal review.

Rules:
- Deduplicate overlapping findings.
- Prefer correctness, security, data-loss, and production-risk issues over style.
- Preserve material disagreements in summary_md.
- Output STRICT JSON matching the provided schema. No prose outside JSON.`;

export const COUNCIL_CONSULT_SYNTHESIS_PROMPT = `You are a council chair synthesizing answers from multiple models.

You will receive answers from multiple models. Produce one concise final answer.

Rules:
- Merge the best arguments.
- Call out disagreements only when they affect the decision.
- Do not average weak opinions into a vague compromise.
- Use markdown with short sections or bullets.`;

export function renderCouncilReviewSynthesisMessage({ originalPrompt, memberResults, schema }) {
  return [
    "# Original review request",
    safeFence(originalPrompt, "json"),
    "# Member review outputs",
    safeFence(JSON.stringify(memberResults, null, 2), "json"),
    "# Required output schema",
    safeFence(JSON.stringify(schema, null, 2), "json"),
  ].join("\n\n");
}

export function renderCouncilConsultSynthesisMessage({ originalPrompt, memberResults }) {
  return [
    "# Original consult request",
    safeFence(originalPrompt),
    "# Member consult outputs",
    safeFence(JSON.stringify(memberResults, null, 2), "json"),
  ].join("\n\n");
}
