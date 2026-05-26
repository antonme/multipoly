import { randomBytes } from "node:crypto";

export const ERROR_CODES = Object.freeze({
  CONFIG: "CONFIG",
  AUTH: "AUTH",
  INVALID_INPUT: "INVALID_INPUT",
  GIT: "GIT",
  FS: "FS",
  SECRET: "SECRET",
  HTTP: "HTTP",
  TIMEOUT: "TIMEOUT",
  STREAM: "STREAM",
  SCHEMA: "SCHEMA",
  BUDGET: "BUDGET",
  COUNCIL: "COUNCIL",
  INTERNAL: "INTERNAL",
});

export class MultipolyError extends Error {
  constructor(code, message, { cause, correlationId, details } = {}) {
    super(message);
    this.name = "MultipolyError";
    this.code = ERROR_CODES[code] ?? ERROR_CODES.INTERNAL;
    this.correlationId = correlationId ?? newCorrelationId();
    if (cause !== undefined) this.cause = cause;
    if (details !== undefined) this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        correlationId: this.correlationId,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

// Back-compat alias: the class was named GlmError when the server only spoke to
// GLM. Kept so any external importer (or in-flight branch) keeps resolving.
export { MultipolyError as GlmError };

export function newCorrelationId() {
  return randomBytes(6).toString("hex");
}

/**
 * Log an error to stderr as structured JSON. Does not include raw secret bytes —
 * callers are responsible for not putting secrets into error messages/details.
 */
export function logError(err) {
  const payload =
    err instanceof MultipolyError
      ? err.toJSON()
      : {
          error: {
            code: "INTERNAL",
            message: err?.message ?? String(err),
            correlationId: newCorrelationId(),
          },
        };
  process.stderr.write(JSON.stringify(payload) + "\n");
}
