/**
 * Review output schema (JSON Schema + hand-rolled validator).
 * Keeping this dependency-free keeps the install surface small.
 */

/**
 * Schema sent to the model via response_format. Permissive at the root
 * (server adds `truncated` and `files` post-merge). Strict inside `findings`
 * so we catch garbage fields the model might emit per-finding.
 */
export const REVIEW_SCHEMA = Object.freeze({
  type: "object",
  required: ["schema_version", "findings", "summary_md"],
  properties: {
    schema_version: { type: "string", const: "1" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "path", "message"],
        properties: {
          severity: { type: "string", enum: ["blocker", "high", "medium", "low", "nit"] },
          path: { type: "string", minLength: 1 },
          line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
          message: { type: "string", minLength: 1 },
          suggestion: { type: "string" },
        },
      },
    },
    summary_md: { type: "string" },
  },
});

const FINDING_KEYS = new Set([
  "severity",
  "path",
  "line",
  "end_line",
  "message",
  "suggestion",
]);

const SEVERITIES = new Set(["blocker", "high", "medium", "low", "nit"]);

/**
 * Validate a parsed object against the review schema (subset of fields we care about).
 * Returns { valid: true } | { valid: false, reason: string }.
 *
 * Permissive on extra top-level fields we add server-side (truncated, files) — those
 * are merged authoritatively by the caller; model-emitted extras are allowed but ignored.
 */
export function validateReview(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { valid: false, reason: "root must be an object" };
  }
  if (obj.schema_version !== "1") {
    return { valid: false, reason: `schema_version must be "1", got ${JSON.stringify(obj.schema_version)}` };
  }
  if (!Array.isArray(obj.findings)) {
    return { valid: false, reason: "findings must be an array" };
  }
  if (typeof obj.summary_md !== "string") {
    return { valid: false, reason: "summary_md must be a string" };
  }
  for (let i = 0; i < obj.findings.length; i++) {
    const f = obj.findings[i];
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      return { valid: false, reason: `findings[${i}] must be an object` };
    }
    for (const k of Object.keys(f)) {
      if (!FINDING_KEYS.has(k)) {
        return { valid: false, reason: `findings[${i}] has unknown field: ${k}` };
      }
    }
    if (!SEVERITIES.has(f.severity)) {
      return { valid: false, reason: `findings[${i}].severity invalid: ${JSON.stringify(f.severity)}` };
    }
    if (typeof f.path !== "string" || f.path.length === 0) {
      return { valid: false, reason: `findings[${i}].path must be a non-empty string` };
    }
    if (typeof f.message !== "string" || f.message.length === 0) {
      return { valid: false, reason: `findings[${i}].message must be a non-empty string` };
    }
    if (f.line !== undefined && (!Number.isInteger(f.line) || f.line < 1)) {
      return { valid: false, reason: `findings[${i}].line must be a positive integer` };
    }
    if (f.end_line !== undefined && (!Number.isInteger(f.end_line) || f.end_line < 1)) {
      return { valid: false, reason: `findings[${i}].end_line must be a positive integer` };
    }
    if (f.suggestion !== undefined && typeof f.suggestion !== "string") {
      return { valid: false, reason: `findings[${i}].suggestion must be a string` };
    }
  }
  return { valid: true };
}
