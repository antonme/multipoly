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
  return {
    models: {
      m: {
        key: "m",
        displayName: "Opus",
        transport: "anthropic",
        configured: true,
        model: "claude-opus-4-7",
        baseUrl: overrides.baseUrl ?? "https://api.anthropic.com",
        apiKey: "sk-ant-test",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        anthropicVersion: "2023-06-01",
        supportsThinking: true,
        maxTokens: { review: overrides.reviewMax, consult: overrides.consultMax },
      },
    },
    thinking: "off",
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

test("anthropic: a stream ending before message_stop is a truncation error", async () => {
  const cap = {};
  // No message_stop event → truncated mid-flight.
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ];
  await assert.rejects(
    () => runModel({ config: anthropicConfig(), modelKey: "m", messages, mode: "consult", fetchImpl: anthropicFetch(events, cap) }),
    (e) => e.code === "STREAM" && /message_stop|truncated/.test(e.message),
  );
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
