import { test } from "node:test";
import assert from "node:assert/strict";
import { streamChatCompletion } from "../scripts/lib/client.mjs";

function okStream(chunks) {
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
}

function makeFetch(seq) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const next = seq[calls.length - 1];
    return typeof next === "function" ? next() : next;
  };
  fn.calls = calls;
  return fn;
}

const baseConfig = {
  baseUrl: "https://api.test/v1",
  apiKey: "k",
  model: "glm-5.2",
  models: {
    glm: {
      configured: true,
      key: "glm",
      displayName: "GLM",
      baseUrl: "https://api.test/v1",
      apiKey: "k",
      model: "glm-5.2",
    },
  },
  thinking: "mode-default",
  timeoutMs: 5000,
  maxTokens: { review: 8192, consult: 16384, freeform: 16384 },
  progress: "off",
};

test("client: falls back from json_schema to json_object on 'not implemented'", async () => {
  const fetchImpl = makeFetch([
    {
      ok: false,
      status: 400,
      body: okStream(['{"error":{"message":"response_format json_schema is not implemented for this model"}}']),
      text: async () => '{"error":{"message":"response_format json_schema is not implemented for this model"}}',
      headers: { get: () => null },
    },
    {
      ok: true,
      body: okStream(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"]),
    },
  ]);
  const out = await streamChatCompletion({
    config: baseConfig,
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "consult",
    responseFormat: { type: "json_schema", json_schema: { name: "x", schema: {}, strict: true } },
    fetchImpl,
  });
  assert.equal(out.content, "hi");
  assert.equal(out.fellBackFromJsonSchema, true);
  assert.equal(fetchImpl.calls.length, 2);
  // Second call must not include json_schema in the body
  const retryBody = JSON.parse(fetchImpl.calls[1].opts.body);
  assert.equal(retryBody.response_format?.type, "json_object");
});

test("client: falls back on 'response_format not available' without the literal json_schema phrase", async () => {
  const fetchImpl = makeFetch([
    {
      ok: false,
      status: 422,
      body: okStream(['{"error":{"message":"response_format is not available on this endpoint"}}']),
      text: async () => '{"error":{"message":"response_format is not available on this endpoint"}}',
      headers: { get: () => null },
    },
    {
      ok: true,
      body: okStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]),
    },
  ]);
  const out = await streamChatCompletion({
    config: baseConfig,
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "consult",
    responseFormat: { type: "json_schema", json_schema: { name: "x", schema: {}, strict: true } },
    fetchImpl,
  });
  assert.equal(out.fellBackFromJsonSchema, true);
});

test("client: falls back when the server 200s then emits an in-stream json_schema error event", async () => {
  // Many OpenAI-compatible backends accept the request (200 OK) and only then
  // report an unsupported response_format inside the SSE body.
  const fetchImpl = makeFetch([
    {
      ok: true,
      body: okStream([
        'data: {"error":{"message":"response_format json_schema is not supported by this model"}}\n\n',
      ]),
    },
    {
      ok: true,
      body: okStream(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"]),
    },
  ]);
  const out = await streamChatCompletion({
    config: baseConfig,
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "consult",
    responseFormat: { type: "json_schema", json_schema: { name: "x", schema: {}, strict: true } },
    fetchImpl,
  });
  assert.equal(out.content, "hi");
  assert.equal(out.fellBackFromJsonSchema, true);
  assert.equal(fetchImpl.calls.length, 2);
  const retryBody = JSON.parse(fetchImpl.calls[1].opts.body);
  assert.equal(retryBody.response_format?.type, "json_object");
});

test("client: does NOT fall back on an in-stream error unrelated to response_format", async () => {
  const fetchImpl = makeFetch([
    {
      ok: true,
      body: okStream(['data: {"error":{"message":"model is overloaded"}}\n\n']),
    },
  ]);
  await assert.rejects(
    streamChatCompletion({
      config: baseConfig,
      modelKey: "glm",
      messages: [{ role: "user", content: "x" }],
      mode: "consult",
      responseFormat: { type: "json_schema", json_schema: { name: "x", schema: {}, strict: true } },
      fetchImpl,
    }),
    (e) => e.code === "STREAM",
  );
  assert.equal(fetchImpl.calls.length, 1); // no retry
});

test("client: does NOT fall back on 'unsupported property' client-side schema bugs", async () => {
  const fetchImpl = makeFetch([
    {
      ok: false,
      status: 400,
      body: okStream(['{"error":{"message":"unsupported property \\"additionalProperties\\" in json_schema"}}']),
      text: async () => '{"error":{"message":"unsupported property \\"additionalProperties\\" in json_schema"}}',
      headers: { get: () => null },
    },
  ]);
  await assert.rejects(
    streamChatCompletion({
      config: baseConfig,
      modelKey: "glm",
      messages: [{ role: "user", content: "x" }],
      mode: "consult",
      responseFormat: { type: "json_schema", json_schema: { name: "x", schema: {}, strict: true } },
      fetchImpl,
    }),
    (e) => e.code === "HTTP",
  );
  assert.equal(fetchImpl.calls.length, 1); // no retry — surface the real bug
});

test("client: does NOT fall back on client-side 'invalid response_format' errors", async () => {
  const fetchImpl = makeFetch([
    {
      ok: false,
      status: 400,
      body: okStream(['{"error":{"message":"response_format has invalid schema: missing type"}}']),
      text: async () => '{"error":{"message":"response_format has invalid schema: missing type"}}',
      headers: { get: () => null },
    },
  ]);
  await assert.rejects(
    streamChatCompletion({
      config: baseConfig,
      modelKey: "glm",
      messages: [{ role: "user", content: "x" }],
      mode: "consult",
      responseFormat: { type: "json_schema", json_schema: { name: "x", schema: {}, strict: true } },
      fetchImpl,
    }),
    (e) => e.code === "HTTP",
  );
  assert.equal(fetchImpl.calls.length, 1); // no retry
});
