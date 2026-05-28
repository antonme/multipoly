import { test } from "node:test";
import assert from "node:assert/strict";
import { runModel } from "../scripts/lib/run-model.mjs";

const enc = new TextEncoder();

// Build a fake fetch returning an Anthropic-style SSE stream from a list of
// event objects (each becomes one `data:` frame; parseSseStream reads the
// `type` from the JSON, so the `event:` line is unnecessary).
function anthropicFetch(events, capture, { status = 200 } = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    capture.body = JSON.parse(init.body);
    if (status !== 200) {
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: capture.errorMessage ?? "bad" } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    const frames = events.map((e) => enc.encode(`data: ${JSON.stringify(e)}\n\n`));
    let i = 0;
    const stream = new ReadableStream({
      pull(c) {
        if (i < frames.length) c.enqueue(frames[i++]);
        else c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

function anthropicConfig(overrides = {}) {
  const modelBase = {
    key: "m",
    displayName: "Opus",
    transport: "anthropic",
    configured: true,
    model: "claude-opus-4-7",
    baseUrl: overrides.baseUrl ?? "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    anthropicVersion: "2023-06-01",
    supportsThinking: overrides.supportsThinking ?? true,
    maxTokens: { review: overrides.reviewMax, consult: overrides.consultMax },
  };
  // Allow tests to set capability (reasoning) and reasoningEffort on the model config.
  if (overrides.reasoning !== undefined) modelBase.reasoning = overrides.reasoning;
  if (overrides.reasoningEffort !== undefined) modelBase.reasoningEffort = overrides.reasoningEffort;
  return {
    models: { m: modelBase },
    thinking: overrides.thinking ?? "off",
    timeoutMs: 5000,
    progress: "off",
  };
}

const basicEvents = [
  { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

const messages = [
  { role: "system", content: "You are a reviewer." },
  { role: "user", content: "Hi." },
];

test("anthropic: streams text_delta into content, maps stop_reason + usage", async () => {
  const cap = {};
  const out = await runModel({
    config: anthropicConfig(),
    modelKey: "m",
    messages,
    mode: "consult",
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.equal(out.content, "Hello world");
  assert.equal(out.reasoning, "");
  assert.equal(out.finishReason, "stop");
  assert.equal(out.fellBackFromJsonSchema, false);
  assert.equal(out.usage.completion_tokens, 5);
  assert.equal(out.usage.prompt_tokens, 110); // input + cache_read
});

test("anthropic: posts to /v1/messages with x-api-key + version, hoists system", async () => {
  const cap = {};
  await runModel({
    config: anthropicConfig(),
    modelKey: "m",
    messages,
    mode: "consult",
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.equal(cap.url, "https://api.anthropic.com/v1/messages");
  assert.equal(cap.init.headers["x-api-key"], "sk-ant-test");
  assert.equal(cap.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(cap.body.system, "You are a reviewer.");
  assert.equal(cap.body.stream, true);
  assert.ok(typeof cap.body.max_tokens === "number"); // required by Anthropic
  // system is hoisted out of messages
  assert.deepEqual(cap.body.messages, [{ role: "user", content: "Hi." }]);
});

test("anthropic: thinking_delta accumulates into reasoning", async () => {
  const cap = {};
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm " } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ok" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  const out = await runModel({
    config: anthropicConfig(),
    modelKey: "m",
    messages,
    mode: "consult",
    fetchImpl: anthropicFetch(events, cap),
  });
  assert.equal(out.reasoning, "hmm ok");
  assert.equal(out.content, "answer");
});

test("anthropic: review mode sends native output_config.format schema (no name/strict)", async () => {
  const cap = {};
  const responseFormat = {
    type: "json_schema",
    json_schema: { name: "m_review", strict: true, schema: { type: "object", properties: {}, additionalProperties: false } },
  };
  await runModel({
    config: anthropicConfig(),
    modelKey: "m",
    messages,
    mode: "review",
    responseFormat,
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.deepEqual(cap.body.output_config, {
    format: { type: "json_schema", schema: { type: "object", properties: {}, additionalProperties: false } },
  });
  assert.equal("response_format" in cap.body, false);
});

test("anthropic: falls back to prompt-JSON when output_config is rejected (400)", async () => {
  let calls = 0;
  const responseFormat = {
    type: "json_schema",
    json_schema: { name: "m_review", strict: true, schema: { type: "object", properties: {} } },
  };
  const fetchImpl = async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    if (calls === 1) {
      assert.ok(body.output_config, "first attempt sends output_config");
      return new Response(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "output_config.format is not supported for this model" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    assert.equal("output_config" in body, false, "fallback drops output_config");
    const frames = basicEvents.map((e) => enc.encode(`data: ${JSON.stringify(e)}\n\n`));
    let i = 0;
    return new Response(
      new ReadableStream({ pull(c) { if (i < frames.length) c.enqueue(frames[i++]); else c.close(); } }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const out = await runModel({ config: anthropicConfig(), modelKey: "m", messages, mode: "review", responseFormat, fetchImpl });
  assert.equal(calls, 2);
  assert.equal(out.fellBackFromJsonSchema, true);
  assert.equal(out.content, "Hello world");
});

test("anthropic: ignores ping/unknown events", async () => {
  const cap = {};
  const events = [
    { type: "ping" },
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "some_future_event", foo: 1 },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const out = await runModel({ config: anthropicConfig(), modelKey: "m", messages, mode: "consult", fetchImpl: anthropicFetch(events, cap) });
  assert.equal(out.content, "ok");
});

test("anthropic: a non-format 400 surfaces as an error (no silent fallback)", async () => {
  const cap = { errorMessage: "credit balance too low" };
  await assert.rejects(
    () =>
      runModel({
        config: anthropicConfig(),
        modelKey: "m",
        messages,
        mode: "consult",
        fetchImpl: anthropicFetch(basicEvents, cap, { status: 400 }),
      }),
    (e) => /credit balance|bad|400/i.test(e.message),
  );
});

test("anthropic: max_tokens uses the model cap when set", async () => {
  const cap = {};
  await runModel({
    config: anthropicConfig({ consultMax: 4096 }),
    modelKey: "m",
    messages,
    mode: "consult",
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.equal(cap.body.max_tokens, 4096);
});

test("anthropic: a stream ending before message_stop logs a warning and still returns content", async () => {
  const cap = {};
  // No message_stop event — the Anthropic API doesn't guarantee this event in
  // all response modes, so we now accept the content and log a warning rather
  // than failing the call.
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ];
  const out = await runModel({ config: anthropicConfig(), modelKey: "m", messages, mode: "consult", fetchImpl: anthropicFetch(events, cap) });
  assert.equal(out.content, "half");
});

test("anthropic: stop_reason max_tokens maps to finish_reason length", async () => {
  const cap = {};
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
    { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const out = await runModel({ config: anthropicConfig(), modelKey: "m", messages, mode: "consult", fetchImpl: anthropicFetch(events, cap) });
  assert.equal(out.finishReason, "length");
});

test("anthropic: enables extended thinking for ANTHROPIC_BUDGET capability", async () => {
  // UPDATED (Task 9): buildThinkingField replaced by capability branch.
  // ANTHROPIC_BUDGET models use effortToAnthropicBudget; the old config.thinking="on"
  // path (buildThinkingField) is removed in favor of resolveReasoningEffort + capability.
  const cap = {};
  const { CAPABILITY } = await import("../scripts/lib/reasoning.mjs");
  await runModel({
    config: anthropicConfig({
      reasoning: CAPABILITY.ANTHROPIC_BUDGET,
      reasoningEffort: "high",
      consultMax: 16384,
    }),
    modelKey: "m",
    messages,
    mode: "consult",
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.ok(cap.body.thinking, "thinking field should be present");
  assert.equal(cap.body.thinking.type, "enabled");
  assert.ok(cap.body.thinking.budget_tokens >= 1024, "budget >= Anthropic floor 1024");
  assert.ok(cap.body.thinking.budget_tokens < cap.body.max_tokens, "budget < max_tokens");
});

test("anthropic: omits thinking when thinking is off", async () => {
  const cap = {};
  await runModel({
    config: anthropicConfig(),
    modelKey: "m",
    messages,
    mode: "consult",
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.equal("thinking" in cap.body, false);
});

test("anthropic: per-call reasoningEffort arg overrides model baseline", async () => {
  // UPDATED (Task 9): the old per-call `thinking` boolean arg path is replaced by
  // `reasoningEffort`. Per-call effort overrides the model config baseline.
  const cap = {};
  const { CAPABILITY } = await import("../scripts/lib/reasoning.mjs");
  await runModel({
    config: anthropicConfig({
      reasoning: CAPABILITY.ANTHROPIC_BUDGET,
      reasoningEffort: "off",  // model baseline = off
      consultMax: 16384,
    }),
    modelKey: "m",
    messages,
    mode: "consult",
    reasoningEffort: "high",   // per-call override → enables thinking
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.ok(cap.body.thinking, "per-call reasoningEffort=high should enable thinking despite model baseline off");
  assert.equal(cap.body.thinking.type, "enabled");
});

test("anthropic: never sends thinking for a model that doesn't support it", async () => {
  const cap = {};
  await runModel({
    config: anthropicConfig({ thinking: "on", supportsThinking: false, consultMax: 16384 }),
    modelKey: "m",
    messages,
    mode: "consult",
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.equal("thinking" in cap.body, false);
});

test("anthropic: ANTHROPIC_BUDGET thinking in review omits output_config.format (uses prompt-JSON)", async () => {
  // UPDATED (Task 9): for ANTHROPIC_BUDGET (legacy), when thinking is enabled,
  // output_config.format is NOT sent (prompt-JSON path). This preserves the old
  // "omit output_config whenever thinking is enabled" behavior for budget models.
  // (ANTHROPIC_EFFORT has a different policy: it tries to send both, see Task9 tests below.)
  const cap = {};
  const { CAPABILITY } = await import("../scripts/lib/reasoning.mjs");
  const responseFormat = {
    type: "json_schema",
    json_schema: { name: "m_review", strict: true, schema: { type: "object", properties: {}, additionalProperties: false } },
  };
  await runModel({
    config: anthropicConfig({
      reasoning: CAPABILITY.ANTHROPIC_BUDGET,
      reasoningEffort: "high",
      reviewMax: 16384,
    }),
    modelKey: "m",
    messages,
    mode: "review",
    responseFormat,
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.ok(cap.body.thinking, "thinking should be enabled for ANTHROPIC_BUDGET");
  assert.equal(cap.body.thinking.type, "enabled");
  assert.equal("output_config" in cap.body, false, "output_config must be omitted when ANTHROPIC_BUDGET thinking is on");
});

test("anthropic: skips thinking when max_tokens is too small for a budget", async () => {
  // UPDATED (Task 9): now exercises ANTHROPIC_BUDGET capability explicitly.
  // With the old buildThinkingField path removed, max_tokens gating is handled by
  // effortToAnthropicBudget; a model must have reasoning: ANTHROPIC_BUDGET to see
  // thinking at all, and a tiny max_tokens collapses to no thinking field.
  const cap = {};
  const { CAPABILITY } = await import("../scripts/lib/reasoning.mjs");
  await runModel({
    config: anthropicConfig({
      reasoning: CAPABILITY.ANTHROPIC_BUDGET,
      reasoningEffort: "high",
      consultMax: 1024,
    }),
    modelKey: "m",
    messages,
    mode: "consult",
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.equal("thinking" in cap.body, false, "1024 max_tokens cannot fit a >=1024 thinking budget plus output");
  assert.equal(cap.body.max_tokens, 1024);
});

// ── Task 9: New capability-based reasoning tests ──────────────────────────────

test("anthropic Task9: ANTHROPIC_EFFORT + xhigh → adaptive thinking, output_config.effort, no budget_tokens, no sampling params", async () => {
  const cap = {};
  const { CAPABILITY } = await import("../scripts/lib/reasoning.mjs");
  await runModel({
    config: anthropicConfig({
      reasoning: CAPABILITY.ANTHROPIC_EFFORT,
      reasoningEffort: "xhigh",
      consultMax: 16384,
    }),
    modelKey: "m",
    messages,
    mode: "consult",
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.deepEqual(cap.body.thinking, { type: "adaptive" }, "thinking must be {type:'adaptive'} for ANTHROPIC_EFFORT");
  assert.equal(cap.body.output_config?.effort, "xhigh", "output_config.effort must be 'xhigh'");
  assert.equal("budget_tokens" in (cap.body.thinking ?? {}), false, "must never have budget_tokens for ANTHROPIC_EFFORT");
  assert.equal("temperature" in cap.body, false, "temperature must be stripped for ANTHROPIC_EFFORT thinking");
  assert.equal("top_p" in cap.body, false, "top_p must be stripped");
  assert.equal("top_k" in cap.body, false, "top_k must be stripped");
  assert.equal("reasoningEffort" in cap.body, false, "camelCase reasoningEffort must never appear on outbound body");
});

test("anthropic Task9: ANTHROPIC_EFFORT + off → no thinking field, no output_config.effort", async () => {
  const cap = {};
  const { CAPABILITY } = await import("../scripts/lib/reasoning.mjs");
  await runModel({
    config: anthropicConfig({
      reasoning: CAPABILITY.ANTHROPIC_EFFORT,
      reasoningEffort: "off",
      consultMax: 16384,
    }),
    modelKey: "m",
    messages,
    mode: "consult",
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.equal("thinking" in cap.body, false, "no thinking when effort=off");
  // output_config.effort should not appear when effort is off (null from adapter)
  assert.equal(cap.body.output_config?.effort, undefined, "no output_config.effort when off");
});

test("anthropic Task9: KIMI_TOGGLE + high → thinking enabled (no budget_tokens), sampling params stripped", async () => {
  const cap = {};
  const { CAPABILITY } = await import("../scripts/lib/reasoning.mjs");
  await runModel({
    config: anthropicConfig({
      reasoning: CAPABILITY.KIMI_TOGGLE,
      reasoningEffort: "high",
      consultMax: 16384,
    }),
    modelKey: "m",
    messages,
    mode: "consult",
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.deepEqual(cap.body.thinking, { type: "enabled" }, "KIMI_TOGGLE high → thinking:{type:'enabled'}");
  assert.equal("budget_tokens" in (cap.body.thinking ?? {}), false, "KIMI_TOGGLE must never have budget_tokens");
  assert.equal("temperature" in cap.body, false, "temperature must be stripped for KIMI_TOGGLE thinking");
  assert.equal("top_p" in cap.body, false, "top_p must be stripped");
  assert.equal("top_k" in cap.body, false, "top_k must be stripped");
});

test("anthropic Task9: ANTHROPIC_BUDGET + high + large max_tokens → budget_tokens in range", async () => {
  const cap = {};
  const { CAPABILITY } = await import("../scripts/lib/reasoning.mjs");
  await runModel({
    config: anthropicConfig({
      reasoning: CAPABILITY.ANTHROPIC_BUDGET,
      reasoningEffort: "high",
      consultMax: 20000,
    }),
    modelKey: "m",
    messages,
    mode: "consult",
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.ok(cap.body.thinking, "thinking must be present for ANTHROPIC_BUDGET + high");
  assert.equal(cap.body.thinking.type, "enabled");
  assert.ok(cap.body.thinking.budget_tokens >= 1024, "budget_tokens must be >= 1024");
  assert.ok(cap.body.thinking.budget_tokens < 20000, "budget_tokens must be < max_tokens");
});

test("anthropic Task9: per-call reasoningEffort overrides model baseline; no camelCase reasoningEffort key on body", async () => {
  const cap = {};
  const { CAPABILITY } = await import("../scripts/lib/reasoning.mjs");
  // model baseline = high; per-call = xhigh → xhigh wins
  await runModel({
    config: anthropicConfig({
      reasoning: CAPABILITY.ANTHROPIC_EFFORT,
      reasoningEffort: "high",
      consultMax: 16384,
    }),
    modelKey: "m",
    messages,
    mode: "consult",
    reasoningEffort: "xhigh",
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.equal(cap.body.output_config?.effort, "xhigh", "per-call effort xhigh must override model baseline high");
  assert.equal("reasoningEffort" in cap.body, false, "camelCase reasoningEffort key must never appear on body");
});

test("anthropic Task9: ANTHROPIC_EFFORT review mode first attempt sends output_config with both effort and format", async () => {
  const calls = [];
  const { CAPABILITY } = await import("../scripts/lib/reasoning.mjs");
  const responseFormat = {
    type: "json_schema",
    json_schema: { name: "m_review", strict: true, schema: { type: "object", properties: {}, additionalProperties: false } },
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const frames = basicEvents.map((e) => enc.encode(`data: ${JSON.stringify(e)}\n\n`));
    let i = 0;
    return new Response(
      new ReadableStream({ pull(c) { if (i < frames.length) c.enqueue(frames[i++]); else c.close(); } }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  await runModel({
    config: anthropicConfig({
      reasoning: CAPABILITY.ANTHROPIC_EFFORT,
      reasoningEffort: "high",
      reviewMax: 16384,
    }),
    modelKey: "m",
    messages,
    mode: "review",
    responseFormat,
    fetchImpl,
  });
  assert.equal(calls.length, 1, "should succeed on first attempt");
  assert.equal(calls[0].output_config?.effort, "high", "first attempt must include output_config.effort");
  assert.ok(calls[0].output_config?.format?.schema, "first attempt must include output_config.format.schema");
});

test("anthropic Task9: ANTHROPIC_EFFORT review mode falls back and KEEPS output_config.effort when format rejected", async () => {
  let callCount = 0;
  const { CAPABILITY } = await import("../scripts/lib/reasoning.mjs");
  const responseFormat = {
    type: "json_schema",
    json_schema: { name: "m_review", strict: true, schema: { type: "object", properties: {}, additionalProperties: false } },
  };
  const bodies = [];
  const fetchImpl = async (url, init) => {
    callCount++;
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (callCount === 1) {
      // First attempt: must have both effort and format in output_config
      assert.equal(body.output_config?.effort, "high", "first attempt: output_config.effort present");
      assert.ok(body.output_config?.format, "first attempt: output_config.format present");
      return new Response(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "output_config.format is not supported for this model" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    // Fallback: must keep output_config.effort but drop format
    assert.equal(body.output_config?.effort, "high", "fallback: output_config.effort preserved");
    assert.equal(body.output_config?.format, undefined, "fallback: output_config.format dropped");
    const frames = basicEvents.map((e) => enc.encode(`data: ${JSON.stringify(e)}\n\n`));
    let i = 0;
    return new Response(
      new ReadableStream({ pull(c) { if (i < frames.length) c.enqueue(frames[i++]); else c.close(); } }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const out = await runModel({
    config: anthropicConfig({
      reasoning: CAPABILITY.ANTHROPIC_EFFORT,
      reasoningEffort: "high",
      reviewMax: 16384,
    }),
    modelKey: "m",
    messages,
    mode: "review",
    responseFormat,
    fetchImpl,
  });
  assert.equal(callCount, 2, "should have retried once");
  assert.equal(out.fellBackFromJsonSchema, true, "fellBackFromJsonSchema must be true");
});

// ── Part A-2: Opus latent-400 regression guard ────────────────────────────────
// ANTHROPIC_EFFORT models (Opus 4.7) must NEVER include budget_tokens in the
// request body at any effort level. budget_tokens causes a 400 from the API.
// This guard covers: xhigh, high, medium, low (off → no thinking at all).

for (const effort of ["low", "medium", "high", "xhigh"]) {
  test(`regression: ANTHROPIC_EFFORT effort=${effort} never sends budget_tokens (latent-400 guard)`, async () => {
    const cap = {};
    const { CAPABILITY: CAP } = await import("../scripts/lib/reasoning.mjs");
    await runModel({
      config: anthropicConfig({
        reasoning: CAP.ANTHROPIC_EFFORT,
        reasoningEffort: effort,
        consultMax: 16384,
      }),
      modelKey: "m",
      messages,
      mode: "consult",
      fetchImpl: anthropicFetch(basicEvents, cap),
    });
    const body = cap.body;
    assert.equal(
      "budget_tokens" in (body.thinking ?? {}),
      false,
      `ANTHROPIC_EFFORT effort=${effort} must never send budget_tokens in thinking, got: ${JSON.stringify(body.thinking)}`,
    );
  });
}

// Also verify the output_config fallback path (review mode) does not add budget_tokens.
test("regression: ANTHROPIC_EFFORT review mode (output_config fallback path) never sends budget_tokens", async () => {
  const bodies = [];
  const { CAPABILITY: CAP } = await import("../scripts/lib/reasoning.mjs");
  const responseFormat = {
    type: "json_schema",
    json_schema: { name: "m_review", strict: true, schema: { type: "object", properties: {}, additionalProperties: false } },
  };
  let call = 0;
  const fetchImpl = async (url, init) => {
    call++;
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (call === 1) {
      // Simulate output_config.format rejection to exercise the fallback path.
      return new Response(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "output_config.format is not supported for this model" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const frames = basicEvents.map((e) => enc.encode(`data: ${JSON.stringify(e)}\n\n`));
    let i = 0;
    return new Response(
      new ReadableStream({ pull(c) { if (i < frames.length) c.enqueue(frames[i++]); else c.close(); } }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  await runModel({
    config: anthropicConfig({ reasoning: CAP.ANTHROPIC_EFFORT, reasoningEffort: "high", reviewMax: 16384 }),
    modelKey: "m",
    messages,
    mode: "review",
    responseFormat,
    fetchImpl,
  });
  for (const body of bodies) {
    assert.equal(
      "budget_tokens" in (body.thinking ?? {}),
      false,
      `ANTHROPIC_EFFORT output_config fallback path must never send budget_tokens, got: ${JSON.stringify(body.thinking)}`,
    );
  }
});

// ── Task D2/2: per-call maxTokensOverride ────────────────────────────────────

test("anthropic[D2]: maxTokensOverride supersedes configured cap on max_tokens", async () => {
  // Model has consultMax: 4096; override 50000 must win.
  const cap = {};
  await runModel({
    config: anthropicConfig({ consultMax: 4096 }),
    modelKey: "m",
    messages,
    mode: "consult",
    maxTokensOverride: 50000,
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.equal(cap.body.max_tokens, 50000, "maxTokensOverride must replace the configured 4096 cap");
});

test("anthropic[D2]: maxTokensOverride scales ANTHROPIC_BUDGET budget_tokens", async () => {
  // With consultMax: 4096, budget_tokens at high would be ~0.6*4096 = 2457.
  // With override 50000, budget_tokens should be ~0.6*50000 = 30000.
  const cap = {};
  const { CAPABILITY: CAP } = await import("../scripts/lib/reasoning.mjs");
  await runModel({
    config: anthropicConfig({
      reasoning: CAP.ANTHROPIC_BUDGET,
      reasoningEffort: "high",
      consultMax: 4096,
    }),
    modelKey: "m",
    messages,
    mode: "consult",
    maxTokensOverride: 50000,
    fetchImpl: anthropicFetch(basicEvents, cap),
  });
  assert.equal(cap.body.max_tokens, 50000, "max_tokens must be the override");
  assert.ok(cap.body.thinking, "thinking field should be present with large override");
  assert.equal(cap.body.thinking.type, "enabled");
  // BUDGET_FRACTION.high = 0.6 → 0.6 * 50000 = 30000; old cap gave ~2457
  assert.ok(cap.body.thinking.budget_tokens > 10000,
    `budget_tokens ${cap.body.thinking.budget_tokens} should scale with override 50000, not configured 4096`);
});
