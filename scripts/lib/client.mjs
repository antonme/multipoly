import { GlmError, newCorrelationId } from "./errors.mjs";
import { parseSseStream } from "./sse.mjs";

/**
 * GLM streaming chat completion client.
 *
 * @param {object} args
 * @param {object} args.config — loaded config object
 * @param {Array<{role:string,content:string}>} args.messages
 * @param {"review"|"consult"|"freeform"} args.mode
 * @param {object} [args.responseFormat] — e.g. {type:"json_schema", json_schema:{name,schema,strict:true}}
 * @param {boolean} [args.thinking] — overrides config.thinking for this call
 * @param {function} [args.fetchImpl] — for tests
 * @returns {Promise<{content:string, reasoning:string, finishReason:string|null, usage:object|null, fellBackFromJsonSchema: boolean}>}
 */
export async function streamChatCompletion({
  config,
  messages,
  mode,
  responseFormat,
  thinking,
  fetchImpl = globalThis.fetch,
}) {
  const correlationId = newCorrelationId();

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
    model: config.model,
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
      url: `${config.baseUrl}/chat/completions`,
      apiKey: config.apiKey,
      body: reqBody,
      timeoutMs: config.timeoutMs,
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

  // Stream-read the body via parseSseStream.
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let usage = null;

  const source = bodyToAsyncIterable(res.body);
  for await (const ev of parseSseStream(source)) {
    if (ev.type === "done") break;
    const v = ev.value;
    const choice = v?.choices?.[0];
    if (choice) {
      const delta = choice.delta || {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (v?.usage) usage = v.usage;
  }

  return { content, reasoning, finishReason, usage, fellBackFromJsonSchema: fellBack };
}

function isJsonSchemaUnsupported(err) {
  if (!(err instanceof GlmError)) return false;
  if (err.code !== "HTTP") return false;
  const status = err.details?.status;
  if (status !== 400 && status !== 422) return false;
  const msg = `${err.message} ${JSON.stringify(err.details?.body ?? "")}`.toLowerCase();
  if (!msg.includes("response_format")) return false;
  return (
    msg.includes("json_schema") &&
    (msg.includes("unsupported") ||
      msg.includes("not supported") ||
      msg.includes("invalid") ||
      msg.includes("unknown"))
  );
}

async function callWithRetry({ url, apiKey, body, timeoutMs, correlationId, fetchImpl }) {
  const MAX_RETRIES = 3;
  let attempt = 0;
  let lastErr;

  while (attempt <= MAX_RETRIES) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
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
      clearTimeout(timer);

      if (res.ok) return res;

      // Read body for error details (bounded)
      const text = await res.text().catch(() => "");
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
          const retryAfter = parseRetryAfter(res.headers?.get?.("retry-after"));
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
      clearTimeout(timer);
      if (e instanceof GlmError) throw e;
      if (e?.name === "AbortError") {
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

function parseRetryAfter(raw) {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, 60_000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) {
    return Math.max(0, Math.min(when - Date.now(), 60_000));
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeSnippet(s, max = 2048) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[truncated ${s.length - max} bytes]`;
}

/**
 * Convert a fetch Response body (WHATWG ReadableStream or Node Readable) into
 * an async iterable of Uint8Array, which is what parseSseStream expects.
 */
async function* bodyToAsyncIterable(body) {
  if (!body) return;
  // Node 18+ ReadableStream has Symbol.asyncIterator.
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    }
    return;
  }
  // WHATWG streams with getReader fallback.
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  }
}
