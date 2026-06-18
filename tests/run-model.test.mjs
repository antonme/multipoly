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
      model: "glm-5.2",
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

// ── Task D2/2: maxTokensOverride forwarding ───────────────────────────────────

test("runModel[D2]: maxTokensOverride is forwarded to http transport", async () => {
  // The http transport must receive maxTokensOverride in its args so it uses it
  // instead of the configured cap. Verify by inspecting the sent body.
  let sentBody = null;
  const fetchImpl = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return new Response(sseStream("hi"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const cfg = {
    ...httpConfig,
    models: {
      glm: {
        ...httpConfig.models.glm,
        maxTokens: { review: 8192, consult: 8192 },
      },
    },
  };
  await runModel({
    config: cfg,
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    maxTokensOverride: 50000,
    fetchImpl,
  });
  assert.equal(sentBody.max_tokens, 50000, "http transport should receive and apply maxTokensOverride");
});

test("runModel[D2]: cli transport accepts maxTokensOverride without error (ignores it)", async () => {
  // CLI agents manage their own budget; maxTokensOverride must be silently accepted.
  const cliConfig = {
    models: {
      myagent: {
        configured: true,
        key: "myagent",
        transport: "cli",
        cliKind: "claude",
        binary: "claude",
        model: "claude-opus-4-7",
        authTokenEnv: "ANTHROPIC_API_KEY",
      },
    },
    timeoutMs: 5000,
    progress: "off",
  };
  const execFileImpl = async () => '{"findings":[]}';
  // Should NOT throw even though maxTokensOverride is passed.
  // Provide a fake env with the required auth token so the config check passes.
  await assert.doesNotReject(async () => {
    await runModel({
      config: cliConfig,
      modelKey: "myagent",
      messages: [{ role: "user", content: "x" }],
      mode: "consult",
      maxTokensOverride: 50000,
      execFileImpl,
      env: { ANTHROPIC_API_KEY: "sk-ant-fake-test-value" },
    });
  }, "cli transport must accept maxTokensOverride without error");
});
