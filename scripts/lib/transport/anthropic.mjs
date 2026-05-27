import { MultipolyError, newCorrelationId } from "../errors.mjs";
import { parseSseStream } from "../sse.mjs";
import { resolveMaxTokensForModel } from "../config.mjs";
import { ANTHROPIC_VERSION, modelSupportsThinking, resolveThinkingPreference } from "../models.mjs";

// Anthropic requires max_tokens, but multipoly leaves model caps undefined by
// default (the http path omits the field). Use a generous default so a review
// JSON isn't truncated; operators raise it via MULTIPOLY_<K>_MAX_TOKENS_*.
const DEFAULT_MAX_TOKENS = 16384;

// Anthropic extended-thinking budget tuning. budget_tokens must be >= 1024 and
// strictly < max_tokens (the thinking budget is carved out of max_tokens), so
// we also reserve a minimum for the visible answer. When the cap is too small
// to fit both, thinking is skipped rather than starving the output.
const MIN_THINKING_BUDGET_TOKENS = 1024; // Anthropic's documented floor
const DEFAULT_THINKING_BUDGET_TOKENS = 8192;
const MIN_OUTPUT_TOKENS = 1024;

/**
 * Build the Anthropic `thinking` request field, or null to omit it.
 * Mirrors the http transport's gating (model must support thinking and the
 * resolved preference must be true) but maps onto Anthropic's budgeted shape.
 */
function buildThinkingField({ supportsThinking, wantThinking, maxTokens, correlationId }) {
  if (!supportsThinking || wantThinking !== true) return null;
  const budget = Math.min(DEFAULT_THINKING_BUDGET_TOKENS, maxTokens - MIN_OUTPUT_TOKENS);
  if (budget < MIN_THINKING_BUDGET_TOKENS) {
    process.stderr.write(
      JSON.stringify({
        event: "anthropic_thinking_skipped",
        correlationId,
        reason: `max_tokens (${maxTokens}) too small to fit a thinking budget (need >= ${MIN_THINKING_BUDGET_TOKENS + MIN_OUTPUT_TOKENS}); proceeding without extended thinking`,
      }) + "\n",
    );
    return null;
  }
  return { type: "enabled", budget_tokens: budget };
}

/**
 * Native Anthropic Messages API transport. Mirrors the http client's return
 * contract — { content, reasoning, finishReason, usage, fellBackFromJsonSchema }
 * — so review/consult/council stay transport-agnostic. Budget checks and (for
 * review) JSON validation + reprompt live ABOVE this seam in the caller.
 *
 * Structured outputs: in review mode the OpenAI-style responseFormat is mapped
 * to Anthropic's native `output_config.format` (GA: { type:"json_schema",
 * schema }). If the model/endpoint rejects it, we transparently retry without
 * it and set fellBackFromJsonSchema=true, leaving the caller's prompt-JSON
 * validate/reprompt loop as the safety net.
 *
 * WIRE-FORMAT NOTE (unverified against a live endpoint). The exact request
 * shapes used here — `output_config.format = { type:"json_schema", schema }`
 * and `thinking = { type:"enabled", budget_tokens }` — target a future Anthropic
 * model (claude-opus-4-7) and have NOT been exercised against the live API in
 * this codebase. They are best-effort and should be re-verified when a real
 * endpoint is available. The two fields degrade differently on rejection:
 *   - output_config: a rejection is detected (isStructuredOutputUnsupported) and
 *     transparently retried without it (prompt-JSON), so a wrong shape self-heals.
 *   - thinking: there is NO auto-fallback — if the endpoint rejects the thinking
 *     field, the call surfaces an HTTP error. Disable with MULTIPOLY_THINKING=off
 *     (or a per-model cap) if a deployment's endpoint doesn't accept it.
 */
export async function runAnthropicModel({
  config,
  modelKey,
  messages,
  mode,
  responseFormat,
  thinking,
  reasoningEffort,
  timeoutMs,
  fetchImpl = globalThis.fetch,
}) {
  const correlationId = newCorrelationId();
  const m = config?.models?.[modelKey];
  if (!m || m.transport !== "anthropic") {
    throw new MultipolyError("CONFIG", `model "${modelKey}" is not an anthropic transport`);
  }
  if (!m.configured) {
    throw new MultipolyError("CONFIG", `${modelKey} is not configured: missing ${(m.missing ?? []).join(", ")}`, {
      details: { model: modelKey, missing: m.missing },
    });
  }

  const { system, turns } = splitSystem(messages);
  const maxTokens = resolveMaxTokensForModel(config, modelKey, mode) ?? DEFAULT_MAX_TOKENS;

  const supportsThinking = m.supportsThinking ?? modelSupportsThinking(config, modelKey);
  const wantThinking = resolveThinkingPreference({ thinking, configThinking: config?.thinking, mode });
  const thinkingField = buildThinkingField({ supportsThinking, wantThinking, maxTokens, correlationId });

  const baseBody = {
    model: m.model,
    max_tokens: maxTokens,
    stream: true,
    messages: turns,
  };
  if (system) baseBody.system = system;
  if (thinkingField) baseBody.thinking = thinkingField;

  // Native structured output for review JSON. Extended thinking and native
  // structured output are not safely combinable across all model/endpoint
  // versions, so when thinking is enabled we omit output_config and rely on
  // prompt-instructed JSON (the caller's validate/reprompt loop) instead.
  const outputConfig =
    !thinkingField &&
    mode === "review" && responseFormat?.type === "json_schema" && responseFormat.json_schema?.schema
      ? { format: { type: "json_schema", schema: responseFormat.json_schema.schema } }
      : null;

  // TEMP test seam — Task 9 replaces with output_config.effort / thinking.
  if (reasoningEffort !== undefined) baseBody.reasoningEffort = reasoningEffort;

  const attempt = async (withSchema) => {
    const body = { ...baseBody };
    if (withSchema && outputConfig) body.output_config = outputConfig;
    return runOnce({ m, body, timeoutMs: timeoutMs ?? config.timeoutMs, correlationId, fetchImpl });
  };

  let fellBack = false;
  let result;
  try {
    result = await attempt(true);
  } catch (e) {
    if (outputConfig && isStructuredOutputUnsupported(e)) {
      fellBack = true;
      result = await attempt(false);
    } else {
      throw e;
    }
  }
  return { ...result, fellBackFromJsonSchema: fellBack };
}

/** Hoist system message(s) to Anthropic's top-level `system`; keep user/assistant turns. */
function splitSystem(messages) {
  const systemParts = [];
  const turns = [];
  for (const msg of messages) {
    if (msg.role === "system") systemParts.push(msg.content);
    else turns.push({ role: msg.role, content: msg.content });
  }
  return { system: systemParts.length ? systemParts.join("\n\n") : null, turns };
}

async function runOnce({ m, body, timeoutMs, correlationId, fetchImpl }) {
  const ac = new AbortController();
  let timer = setTimeout(() => ac.abort(), timeoutMs);
  const refresh = () => {
    if (typeof timer.refresh === "function") timer.refresh();
    else {
      clearTimeout(timer);
      timer = setTimeout(() => ac.abort(), timeoutMs);
    }
  };

  let res;
  try {
    res = await fetchImpl(`${m.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-api-key": m.apiKey,
        "anthropic-version": m.anthropicVersion ?? ANTHROPIC_VERSION,
        "x-request-id": correlationId,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === "AbortError" || e?.code === "ABORT_ERR") {
      throw new MultipolyError("TIMEOUT", `request timed out after ${timeoutMs}ms`, { correlationId, cause: e });
    }
    throw new MultipolyError("HTTP", `network error: ${e.message}`, { correlationId, cause: e });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    clearTimeout(timer);
    const details = { status: res.status, body: text.slice(0, 2048) };
    if (res.status === 401 || res.status === 403) {
      throw new MultipolyError("AUTH", `anthropic auth failed (${res.status})`, { correlationId, details });
    }
    throw new MultipolyError("HTTP", `anthropic error ${res.status}`, { correlationId, details });
  }

  let content = "";
  let reasoning = "";
  let finishReason = null;
  let usage = null;
  let sawStop = false;
  try {
    for await (const ev of parseSseStream(bodyToAsyncIterable(res.body, refresh))) {
      refresh();
      if (ev.type === "done") break;
      const v = ev.value;
      if (!v || typeof v !== "object") continue;
      switch (v.type) {
        case "message_start":
          usage = mergeUsage(usage, v.message?.usage);
          break;
        case "content_block_delta": {
          const d = v.delta || {};
          if (d.type === "text_delta" && typeof d.text === "string") content += d.text;
          else if (d.type === "thinking_delta" && typeof d.thinking === "string") reasoning += d.thinking;
          break;
        }
        case "message_delta":
          if (v.delta?.stop_reason) finishReason = finishFromStop(v.delta.stop_reason);
          usage = mergeUsage(usage, v.usage);
          break;
        case "message_stop":
          // Anthropic's explicit end-of-message marker (there is no [DONE]).
          sawStop = true;
          break;
        // ping / content_block_start / content_block_stop / unknown future
        // events: nothing to accumulate.
        default:
          break;
      }
    }
  } catch (e) {
    if (e?.name === "AbortError" || e?.code === "ABORT_ERR") {
      throw new MultipolyError("TIMEOUT", `stream went silent for more than ${timeoutMs}ms`, { correlationId, cause: e });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  // A stream that ended without `message_stop` may have been truncated
  // mid-flight, but the Anthropic API does not guarantee this event in all
  // response modes. Rather than fail a potentially-complete response, log a
  // warning and accept whatever content was received. The caller's budget /
  // JSON-validation layers will catch genuine truncation.
  if (!sawStop) {
    process.stderr.write(
      JSON.stringify({
        event: "anthropic_no_message_stop",
        correlationId,
        warning:
          "Anthropic stream ended without the message_stop event. " +
          "The response may be truncated; if review JSON fails validation, " +
          "raise MULTIPOLY_<K>_MAX_TOKENS_REVIEW.",
      }) + "\n",
    );
  }

  return { content, reasoning, finishReason, usage: finalizeUsage(usage) };
}

/** Map Anthropic stop_reason → OpenAI-style finish_reason. */
function finishFromStop(stop) {
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return stop ?? null;
  }
}

function mergeUsage(prev, u) {
  if (!u || typeof u !== "object") return prev;
  return { ...(prev || {}), ...u };
}

// Map Anthropic's usage to the OpenAI-shaped usage the rest of the code reads,
// folding cache fields into prompt_tokens (real cost), never zero-for-unknown.
function finalizeUsage(u) {
  if (!u) return null;
  const input = num(u.input_tokens);
  const create = num(u.cache_creation_input_tokens);
  const read = num(u.cache_read_input_tokens);
  const output = num(u.output_tokens);
  const prompt = input + create + read;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: read, cache_creation_input_tokens: create },
  };
}

function num(x) {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

// A 400 that names the structured-output field means this model/endpoint can't
// honor a native schema — fall back to prompt JSON. Other 400s must surface.
function isStructuredOutputUnsupported(err) {
  if (!(err instanceof MultipolyError)) return false;
  let msg;
  if (err.code === "HTTP" && err.details?.status === 400) {
    msg = `${err.message} ${JSON.stringify(err.details?.body ?? "")}`.toLowerCase();
  } else if (err.code === "STREAM") {
    msg = `${err.message} ${JSON.stringify(err.details ?? "")}`.toLowerCase();
  } else {
    return false;
  }
  return msg.includes("output_config") || msg.includes("json_schema") || msg.includes("output_format");
}

async function* bodyToAsyncIterable(body, onChunk) {
  if (!body) return;
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      onChunk?.();
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    }
    return;
  }
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
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }
}
