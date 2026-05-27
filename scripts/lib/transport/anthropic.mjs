import { MultipolyError, newCorrelationId } from "../errors.mjs";
import { parseSseStream } from "../sse.mjs";
import { resolveMaxTokensForModel } from "../config.mjs";
import { ANTHROPIC_VERSION, modelCapability } from "../models.mjs";
import {
  CAPABILITY,
  resolveReasoningEffort,
  effortToAnthropicEffort,
  effortToAnthropicBudget,
  effortToKimiThinking,
} from "../reasoning.mjs";

// Anthropic requires max_tokens, but multipoly leaves model caps undefined by
// default (the http path omits the field). Use a generous default so a review
// JSON isn't truncated; operators raise it via MULTIPOLY_<K>_MAX_TOKENS_*.
const DEFAULT_MAX_TOKENS = 16384;

// Sampling parameters that Anthropic/Kimi lock when thinking is active.
// Opus 4.7 returns 400 on non-default temperature/top_p/top_k when adaptive
// thinking is on; Kimi K2.6 also locks temperature. Strip them defensively
// for any anthropic-family capability whenever effort is not "off".
const LOCKED_SAMPLING_PARAMS = Object.freeze(["temperature", "top_p", "top_k"]);

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

  // Resolve capability and effective reasoning effort.
  const cap = m.reasoning ?? modelCapability(config, modelKey);
  const effort = resolveReasoningEffort({
    perCall: reasoningEffort,
    modelEffort: m.reasoningEffort,
    bakedDefault: m.reasoningEffort ?? "off",
  });

  // Build the thinking/output_config fields for the base body by capability.
  let thinkingFields = null;   // fields to spread onto baseBody
  let effortValue = null;      // the effort string (for ANTHROPIC_EFFORT output_config)
  let isThinkingActive = false; // controls sampling-param strip and outputConfig gating

  if (cap === CAPABILITY.ANTHROPIC_EFFORT) {
    thinkingFields = effortToAnthropicEffort(effort);
    if (thinkingFields !== null) {
      // thinkingFields = { thinking: {type:"adaptive"}, output_config: {effort} }
      // We split output_config.effort out so review mode can add .format to it.
      effortValue = thinkingFields.output_config.effort;
      isThinkingActive = true;
    }
  } else if (cap === CAPABILITY.KIMI_TOGGLE) {
    thinkingFields = effortToKimiThinking(effort);
    isThinkingActive = effort !== "off";
  } else if (cap === CAPABILITY.ANTHROPIC_BUDGET) {
    thinkingFields = effortToAnthropicBudget(effort, { maxTokens });
    if (thinkingFields === null && effort !== "off") {
      process.stderr.write(
        JSON.stringify({
          event: "anthropic_thinking_skipped",
          correlationId,
          reason: `max_tokens (${maxTokens}) too small to fit a thinking budget; proceeding without extended thinking`,
        }) + "\n",
      );
    }
    isThinkingActive = thinkingFields !== null;
  }
  // CAPABILITY.NONE (and unknown): no thinking fields applied.

  const baseBody = {
    model: m.model,
    max_tokens: maxTokens,
    stream: true,
    messages: turns,
  };
  if (system) baseBody.system = system;

  // Apply thinking fields. For ANTHROPIC_EFFORT we hoist the thinking key
  // directly and manage output_config separately (to merge .format in review).
  if (thinkingFields !== null) {
    if (cap === CAPABILITY.ANTHROPIC_EFFORT) {
      baseBody.thinking = thinkingFields.thinking;
      // output_config.effort is added in the attempt() closure (may include .format)
    } else {
      // KIMI_TOGGLE / ANTHROPIC_BUDGET: spread everything at once (just `thinking`)
      Object.assign(baseBody, thinkingFields);
    }
  }

  // Strip sampling params that Anthropic/Kimi lock when thinking is active.
  if (isThinkingActive) {
    for (const p of LOCKED_SAMPLING_PARAMS) delete baseBody[p];
  }

  // Review JSON schema. Policy varies by capability:
  //   ANTHROPIC_EFFORT: attempt output_config:{effort, format} together first;
  //     on format rejection fall back to prompt-JSON but KEEP output_config:{effort}.
  //   KIMI_TOGGLE / ANTHROPIC_BUDGET with thinking on: omit format (prompt-JSON path).
  //   All others (no thinking): send output_config:{format} as before.
  const reviewSchema =
    mode === "review" && responseFormat?.type === "json_schema" && responseFormat.json_schema?.schema
      ? responseFormat.json_schema.schema
      : null;

  // For non-ANTHROPIC_EFFORT paths with thinking, fall through to prompt-JSON (omit format).
  const formatConfig =
    !isThinkingActive && reviewSchema
      ? { format: { type: "json_schema", schema: reviewSchema } }
      : null;

  const attempt = async ({ includeFormat }) => {
    const body = { ...baseBody };
    if (cap === CAPABILITY.ANTHROPIC_EFFORT && effortValue !== null) {
      // Always include effort; optionally include format on first try.
      body.output_config = includeFormat && reviewSchema
        ? { effort: effortValue, format: { type: "json_schema", schema: reviewSchema } }
        : { effort: effortValue };
    } else if (includeFormat && formatConfig) {
      body.output_config = formatConfig;
    }
    // Strip sampling params in case any caller-constructed baseBody contains them
    // (defensive: baseBody.delete already ran above, but attempt() spreads baseBody).
    if (isThinkingActive) {
      for (const p of LOCKED_SAMPLING_PARAMS) delete body[p];
    }
    return runOnce({ m, body, timeoutMs: timeoutMs ?? config.timeoutMs, correlationId, fetchImpl });
  };

  let fellBack = false;
  let result;
  const hasOutputConfig = (cap === CAPABILITY.ANTHROPIC_EFFORT && effortValue !== null) || formatConfig;
  try {
    result = await attempt({ includeFormat: true });
  } catch (e) {
    if (hasOutputConfig && isStructuredOutputUnsupported(e)) {
      fellBack = true;
      result = await attempt({ includeFormat: false });
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
