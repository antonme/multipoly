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
  INTERNAL: "INTERNAL",
});

export class GlmError extends Error {
  constructor(code, message, { cause, correlationId, details } = {}) {
    super(message);
    this.name = "GlmError";
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

export function newCorrelationId() {
  return randomBytes(6).toString("hex");
}

/**
 * Log an error to stderr as structured JSON. Does not include raw secret bytes —
 * callers are responsible for not putting secrets into error messages/details.
 */
export function logError(err) {
  const payload =
    err instanceof GlmError
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
