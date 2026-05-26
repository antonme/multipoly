import { GlmError, newCorrelationId } from "./errors.mjs";
import { parseSseStream } from "./sse.mjs";

/**
 * GLM streaming chat completion client.
 *
 * @param {object} args
 * @param {object} args.config — loaded config object
 * @param {string} args.modelKey — configured model key to call
 * @param {Array<{role:string,content:string}>} args.messages
 * @param {"review"|"consult"|"freeform"} args.mode
 * @param {object} [args.responseFormat] — e.g. {type:"json_schema", json_schema:{name,schema,strict:true}}
 * @param {boolean} [args.thinking] — overrides config.thinking for this call
 * @param {function} [args.fetchImpl] — for tests
 * @returns {Promise<{content:string, reasoning:string, finishReason:string|null, usage:object|null, fellBackFromJsonSchema: boolean}>}
 */
export async function streamChatCompletion({
  config,
  modelKey,
  messages,
  mode,
  responseFormat,
  thinking,
  timeoutMs,
  fetchImpl = globalThis.fetch,
}) {
  const correlationId = newCorrelationId();
  // Per-call override (validated upstream) takes precedence over the
  // env-derived config.timeoutMs. Both are the upstream stream inactivity
  // budget — not the MCP client's tool-call timeout, which sits above us.
  const effectiveTimeoutMs = timeoutMs ?? config.timeoutMs;
  const effectiveModelKey = modelKey ?? "glm";
  const legacyModelConfig = {
    configured: true,
    key: "glm",
    displayName: "GLM 5.1",
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    missing: [],
  };
  const modelConfig = config.models
    ? config.models[effectiveModelKey]
    : legacyModelConfig;

  if (!modelConfig?.configured) {
    const missing = modelConfig?.missing ?? [`unknown model ${effectiveModelKey}`];
    throw new GlmError(
      "CONFIG",
      `${effectiveModelKey} is not configured: missing ${missing.join(", ")}`,
      { details: { model: effectiveModelKey, missing } },
    );
  }

  // Resolve effective thinking.
  let wantThinking;
  if (thinking !== undefined) {
    wantThinking = thinking;
  } else if (config.thinking === "auto") {
    wantThinking = null; // omit the field entirely
  } else if (config.thinking === "on") {
    wantThinking = true;
  } else if (config.thinking === "off") {
    wantThinking = false;
  } else {
    // mode-default
    wantThinking = mode === "review";
  }

  const body = {
    model: modelConfig.model,
    messages,
    stream: true,
    max_tokens: config.maxTokens[mode],
  };
  if (wantThinking === true) body.thinking = { type: "enabled" };
  else if (wantThinking === false) body.thinking = { type: "disabled" };

  let effectiveResponseFormat = responseFormat;
  let fellBack = false;

  const doRequest = async (rf) => {
    const reqBody = { ...body };
    if (rf) reqBody.response_format = rf;
    return callWithRetry({
      url: `${modelConfig.baseUrl}/chat/completions`,
      apiKey: modelConfig.apiKey,
      body: reqBody,
      timeoutMs: effectiveTimeoutMs,
      correlationId,
      fetchImpl,
    });
  };

  let res;
  try {
    res = await doRequest(effectiveResponseFormat);
  } catch (e) {
    if (
      effectiveResponseFormat?.type === "json_schema" &&
      isJsonSchemaUnsupported(e)
    ) {
      // Narrow fallback: only on explicit "unsupported" signal.
      effectiveResponseFormat = { type: "json_object" };
      fellBack = true;
      res = await doRequest(effectiveResponseFormat);
    } else {
      throw e;
    }
  }

  // Stream-read the body via parseSseStream. The per-call timer is an
  // INACTIVITY timer: we refresh it via res.__refreshTimer on every SSE event,
  // and cancel it via res.__cancelTimer when the stream ends. A server that
  // sends headers and then stalls still trips the timer after timeoutMs of
  // silence — but a server that keeps streaming (including reasoning tokens)
  // will never trip it.
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let usage = null;

  const progress = new ProgressReporter(
    config.progress,
    `${effectiveModelKey}:${mode}`,
    correlationId,
  );
  progress.start();

  try {
    // Refresh the inactivity timer on every raw chunk, not just completed SSE
    // events. A slow connection streaming a single large event (e.g. a huge
    // reasoning burst) would otherwise trip the timer even though bytes are
    // actively arriving.
    const source = bodyToAsyncIterable(res.body, () => res.__refreshTimer?.());
    for await (const ev of parseSseStream(source)) {
      res.__refreshTimer?.();
      if (ev.type === "done") break;
      const v = ev.value;
      const choice = v?.choices?.[0];
      if (choice) {
        const delta = choice.delta || {};
        if (typeof delta.content === "string") content += delta.content;
        if (typeof delta.reasoning_content === "string") {
          reasoning += delta.reasoning_content;
          progress.onReasoning(delta.reasoning_content);
        }
        if (typeof delta.content === "string" && delta.content.length > 0) {
          progress.onContent(delta.content.length);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      if (v?.usage) usage = v.usage;
    }
  } catch (e) {
    const aborted = e?.name === "AbortError" || e?.code === "ABORT_ERR";
    progress.end({ reasoningChars: reasoning.length, contentChars: content.length, aborted });
    if (aborted) {
      throw new GlmError(
        "TIMEOUT",
        `stream went silent for more than ${effectiveTimeoutMs}ms`,
        { correlationId, cause: e },
      );
    }
    throw e;
  } finally {
    res.__cancelTimer?.();
  }

  progress.end({ reasoningChars: reasoning.length, contentChars: content.length, finishReason });

  return { content, reasoning, finishReason, usage, fellBackFromJsonSchema: fellBack };
}

/**
 * Surface live progress to stderr so the user can see that a long-running
 * request is still making forward progress. Three modes:
 *   - "off":       no output at all
 *   - "heartbeat": short periodic summary lines with elapsed + char counts
 *   - "reasoning": raw reasoning_content deltas flushed live, useful for
 *                  watching the model think
 *
 * All output goes to stderr so MCP stdio (stdin/stdout) stays clean.
 */
class ProgressReporter {
  constructor(mode, callMode, correlationId) {
    this.mode = mode ?? "heartbeat";
    this.callMode = callMode;
    this.correlationId = correlationId;
    this.start_ms = 0;
    this.reasoningChars = 0;
    this.contentChars = 0;
    this.lastHeartbeat = 0;
    this.heartbeatPhase = "waiting";
    this.reasoningEmittedAny = false;
  }

  start() {
    if (this.mode === "off") return;
    this.start_ms = Date.now();
    this.lastHeartbeat = this.start_ms;
    process.stderr.write(
      `[glm ${this.callMode} ${this.correlationId}] streaming…\n`,
    );
  }

  onReasoning(delta) {
    if (this.mode === "off") return;
    this.reasoningChars += delta.length;
    if (this.mode === "reasoning") {
      if (!this.reasoningEmittedAny) {
        process.stderr.write(`[glm ${this.callMode}] thinking:\n`);
        this.reasoningEmittedAny = true;
      }
      process.stderr.write(delta);
    } else {
      this.maybeHeartbeat("thinking");
    }
  }

  onContent(len) {
    if (this.mode === "off") return;
    this.contentChars += len;
    if (this.mode === "reasoning" && this.heartbeatPhase !== "content") {
      // Close out the reasoning dump with a newline so the next line is clean.
      if (this.reasoningEmittedAny) process.stderr.write("\n");
      process.stderr.write(`[glm ${this.callMode}] generating…\n`);
    }
    this.heartbeatPhase = "content";
    if (this.mode === "heartbeat") this.maybeHeartbeat("generating");
  }

  maybeHeartbeat(phase) {
    if (this.mode !== "heartbeat") return;
    const now = Date.now();
    if (now - this.lastHeartbeat < 3000) return;
    this.lastHeartbeat = now;
    this.heartbeatPhase = phase;
    const elapsed = Math.round((now - this.start_ms) / 1000);
    process.stderr.write(
      `[glm ${this.callMode}] ${phase} reasoning=${this.reasoningChars}c content=${this.contentChars}c elapsed=${elapsed}s\n`,
    );
  }

  end({ reasoningChars, contentChars, finishReason, aborted }) {
    if (this.mode === "off") return;
    const elapsed = Math.round((Date.now() - this.start_ms) / 1000);
    const tag = aborted ? "aborted" : `done${finishReason ? `:${finishReason}` : ""}`;
    process.stderr.write(
      `[glm ${this.callMode}] ${tag} reasoning=${reasoningChars}c content=${contentChars}c elapsed=${elapsed}s\n`,
    );
  }
}

function isJsonSchemaUnsupported(err) {
  if (!(err instanceof GlmError)) return false;
  if (err.code !== "HTTP") return false;
  const status = err.details?.status;
  if (status !== 400 && status !== 422) return false;
  const msg = `${err.message} ${JSON.stringify(err.details?.body ?? "")}`.toLowerCase();
  // The server can name the feature either way. Require one of those
  // tokens so generic 4xx errors don't trigger fallback.
  const mentionsFeature =
    msg.includes("json_schema") || msg.includes("response_format");
  if (!mentionsFeature) return false;
  // Signals that a backend simply doesn't implement json_schema — in that
  // case fall back to json_object. We deliberately do NOT match "invalid",
  // "bad", "malformed", "unknown property", or the bare word "unsupported"
  // (which also appears in "unsupported property 'X' in json_schema" — a
  // client-side schema bug that must surface, not silently degrade).
  const unsupportedPhrases = [
    "not supported",
    "does not support",
    "not available",
    "not implemented",
    "unavailable",
  ];
  return unsupportedPhrases.some((p) => msg.includes(p));
}

async function callWithRetry({ url, apiKey, body, timeoutMs, correlationId, fetchImpl }) {
  const MAX_RETRIES = 3;
  let attempt = 0;
  let lastErr;

  while (attempt <= MAX_RETRIES) {
    const ac = new AbortController();
    // `timer` is let (not const) so __refreshTimer can re-arm it on Node
    // versions without Timeout.refresh(). Callers reference the latest value
    // through the closure, so reassignment is safe.
    let timer = setTimeout(() => ac.abort(), timeoutMs);
    let headersOk = false;
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${apiKey}`,
          "x-request-id": correlationId,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (res.ok) {
        // The timer is used as an INACTIVITY timer during body consumption:
        // it fires if no chunk arrives for `timeoutMs`. The caller refreshes
        // it via __refreshTimer on every chunk/event and cancels via
        // __cancelTimer when the stream ends. Do NOT abort the
        // AbortController in __cancelTimer — by the time we call it the body
        // is already drained, and aborting after success can trip keep-alive
        // cleanup or confuse fetch adapters.
        headersOk = true;
        res.__cancelTimer = () => clearTimeout(timer);
        res.__refreshTimer = () => {
          // Node 18+: setTimeout returns a Timeout with refresh(); prefer it.
          // Fall back to clear+recreate for older / non-Node runtimes so the
          // inactivity guarantee holds everywhere (previously this branch was
          // a silent no-op after the first refresh, disabling stall detection
          // for the rest of the stream).
          if (typeof timer.refresh === "function") {
            timer.refresh();
          } else {
            clearTimeout(timer);
            timer = setTimeout(() => ac.abort(), timeoutMs);
          }
        };
        // Refresh the inactivity budget now that headers are in. Without this,
        // a server that takes most of timeoutMs to return headers would leave
        // almost no budget before the first body chunk must arrive.
        res.__refreshTimer();
        return res;
      }

      // Read error body with the timer still armed so a hostile or
      // misbehaving server that sends 4xx/5xx headers and then stalls on
      // the body can't pin this request forever. readBoundedBody uses the
      // response's body stream, which is tied to `ac.signal`; if the timer
      // fires, the abort propagates into the body read and rejects the
      // chunk pump with AbortError. Clear the timer only AFTER the read
      // completes or throws.
      const text = await readBoundedBody(res, 8 * 1024).catch(() => "");
      clearTimeout(timer);
      const details = { status: res.status, body: safeSnippet(text) };

      if (res.status === 401 || res.status === 403) {
        throw new GlmError("AUTH", `upstream auth failed (${res.status})`, {
          correlationId,
          details,
        });
      }

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        lastErr = new GlmError(
          "HTTP",
          `upstream error ${res.status}`,
          { correlationId, details },
        );
        if (attempt < MAX_RETRIES) {
          // Honor Retry-After when the server sets it. Previously we silently
          // clamped to 60s, so a server asking for a 5-minute wait would burn
          // three retries in 3 minutes and then fail — the server's pacing
          // request was effectively ignored. Now we respect the full value up
          // to a larger ceiling, and if the server asks for longer than the
          // ceiling we surface the HTTP error rather than pretend a shorter
          // wait will help. Either outcome — honor or surface — is better than
          // silent truncation.
          const raHeader = res.headers?.get?.("retry-after");
          const retryAfter = parseRetryAfter(raHeader);
          if (retryAfter === "TOO_LONG") {
            lastErr.details.retryAfter = raHeader;
            throw lastErr;
          }
          await sleep(retryAfter ?? backoffMs(attempt));
          attempt++;
          continue;
        }
        throw lastErr;
      }

      // 4xx non-auth → fail fast
      throw new GlmError("HTTP", `upstream error ${res.status}`, {
        correlationId,
        details,
      });
    } catch (e) {
      if (!headersOk) clearTimeout(timer);
      if (e instanceof GlmError) throw e;
      if (e?.name === "AbortError" || e?.code === "ABORT_ERR") {
        throw new GlmError("TIMEOUT", `request timed out after ${timeoutMs}ms`, {
          correlationId,
          cause: e,
        });
      }
      // Network errors: retry
      lastErr = new GlmError("HTTP", `network error: ${e.message}`, {
        correlationId,
        cause: e,
      });
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        attempt++;
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new GlmError("HTTP", "exhausted retries", { correlationId });
}

function backoffMs(attempt) {
  const base = 500 * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

// Upper bound on how long we're willing to block a request waiting for a
// server-requested retry. Five minutes is long enough for typical 429 backoff
// windows (per-minute rate limits on most OpenAI-compatible APIs) but short
// enough that a pathological server can't pin us indefinitely.
const RETRY_AFTER_MAX_MS = 300_000;

function parseRetryAfter(raw) {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) {
    const ms = n * 1000;
    return ms > RETRY_AFTER_MAX_MS ? "TOO_LONG" : ms;
  }
  const when = Date.parse(raw);
  if (Number.isFinite(when)) {
    const ms = Math.max(0, when - Date.now());
    return ms > RETRY_AFTER_MAX_MS ? "TOO_LONG" : ms;
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readBoundedBody(res, maxBytes) {
  const body = res.body;
  if (!body) return "";
  const chunks = [];
  let total = 0;
  const decoder = new TextDecoder();

  // Slice each incoming chunk so we never buffer more than `maxBytes` even
  // when a single transport frame is larger than the cap.
  const pushCapped = (u8) => {
    const remaining = maxBytes - total;
    if (remaining <= 0) return true; // signal: done
    if (u8.byteLength <= remaining) {
      chunks.push(u8);
      total += u8.byteLength;
      return total >= maxBytes;
    }
    chunks.push(u8.subarray(0, remaining));
    total = maxBytes;
    return true;
  };

  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const raw of body) {
      const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (pushCapped(chunk)) break;
    }
    // Best-effort cancel; some body types expose .cancel() or .destroy()
    try { body.cancel?.(); } catch {}
    try { body.destroy?.(); } catch {}
  } else if (typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (total < maxBytes) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && pushCapped(value)) break;
      }
      try { reader.cancel(); } catch {}
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  } else {
    // No streaming body exposed — fall back to text() and slice. Bounded
    // afterwards, but may buffer the whole body in memory. Rare path.
    const full = await res.text();
    return full.slice(0, maxBytes);
  }

  let text = "";
  for (const c of chunks) text += decoder.decode(c, { stream: true });
  text += decoder.decode();
  return text;
}

function safeSnippet(s, max = 2048) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[truncated ${s.length - max} bytes]`;
}

/**
 * Convert a fetch Response body (WHATWG ReadableStream or Node Readable) into
 * an async iterable of Uint8Array, which is what parseSseStream expects.
 *
 * `onChunk` is invoked for each raw chunk so the caller can refresh an
 * inactivity timer at byte-arrival granularity, not just at SSE-event
 * granularity.
 */
async function* bodyToAsyncIterable(body, onChunk) {
  if (!body) return;
  // Node 18+ ReadableStream has Symbol.asyncIterator.
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      onChunk?.();
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    }
    return;
  }
  // WHATWG streams with getReader fallback — release the reader on any exit
  // path so the underlying stream can be cancelled / GC'd.
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        onChunk?.();
        if (value) yield value;
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }
}
