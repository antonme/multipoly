import { test } from "node:test";
import assert from "node:assert/strict";
import { runModel } from "../scripts/lib/run-model.mjs";

const enc = new TextEncoder();

function sseStream(content) {
  const body = [
    `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}\n\n`,
    "data: [DONE]\n\n",
  ].map((s) => enc.encode(s));
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < body.length) c.enqueue(body[i++]);
      else c.close();
    },
  });
}

const httpConfig = {
  models: {
    glm: {
      configured: true,
      key: "glm",
      transport: "http",
      baseUrl: "https://api.test/v1",
      apiKey: "k",
      model: "glm-5.1",
    },
  },
  thinking: "off",
  timeoutMs: 5000,
  progress: "off",
};

test("runModel: http transport delegates to the OpenAI-compatible client", async () => {
  let calledUrl = null;
  const fetchImpl = async (url) => {
    calledUrl = url;
    return new Response(sseStream("hi"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const out = await runModel({
    config: httpConfig,
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "consult",
    fetchImpl,
  });
  assert.equal(out.content, "hi");
  assert.equal(out.finishReason, null);
  assert.equal(calledUrl, "https://api.test/v1/chat/completions");
  // Shape contract preserved for downstream callers.
  assert.equal("fellBackFromJsonSchema" in out, true);
});

test("runModel: a model with no transport field defaults to http", async () => {
  const cfg = {
    ...httpConfig,
    models: { glm: { ...httpConfig.models.glm, transport: undefined } },
  };
  const fetchImpl = async () =>
    new Response(sseStream("ok"), { status: 200, headers: { "content-type": "text/event-stream" } });
  const out = await runModel({
    config: cfg,
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "consult",
    fetchImpl,
  });
  assert.equal(out.content, "ok");
});
