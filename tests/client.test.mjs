import { test } from "node:test";
import assert from "node:assert/strict";
import { streamChatCompletion } from "../scripts/lib/client.mjs";
import { CAPABILITY } from "../scripts/lib/reasoning.mjs";

const enc = new TextEncoder();

function makeFetch({ status = 200, chunks, headers = {} } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (status >= 400) {
      return new Response("err: " + status, { status });
    }
    const body = chunks
      ? chunksToReadableStream(chunks)
      : chunksToReadableStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]);
    return new Response(body, { status, headers: { "content-type": "text/event-stream", ...headers } });
  };
  fn.calls = calls;
  return fn;
}

function chunksToReadableStream(strings) {
  const encoded = strings.map((s) => enc.encode(s));
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < encoded.length) {
        controller.enqueue(encoded[i++]);
      } else {
        controller.close();
      }
    },
  });
}

const baseConfig = {
  baseUrl: "https://api.test/v1",
  apiKey: "k",
  model: "glm-5.1",
  models: {
    glm: {
      configured: true,
      key: "glm",
      displayName: "GLM",
      baseUrl: "https://api.test/v1",
      apiKey: "k",
      model: "glm-5.1",
      supportsThinking: true,
      reasoning: CAPABILITY.GLM_TOGGLE,
      reasoningEffort: "high",
      maxTokens: { review: 8192, consult: 16384 },
    },
  },
  thinking: "mode-default",
  timeoutMs: 5000,
  maxTokens: { review: 8192, consult: 16384, freeform: 16384 },
  progress: "off",
};

test("client: happy path streams content", async () => {
  const fetchImpl = makeFetch({});
  const out = await streamChatCompletion({
    config: baseConfig,
    modelKey: "glm",
    messages: [{ role: "user", content: "hi" }],
    mode: "consult",
    fetchImpl,
  });
  assert.equal(out.content, "ok");
  assert.equal(fetchImpl.calls.length, 1);
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.model, "glm-5.1");
  assert.equal(sent.stream, true);
  // GLM_TOGGLE capability with reasoningEffort="high" → thinking enabled (mode no longer drives effort)
  assert.deepEqual(sent.thinking, { type: "enabled" });
});

test("client: sends request to selected model config", async () => {
  const fetchImpl = makeFetch({});
  const out = await streamChatCompletion({
    config: {
      ...baseConfig,
      models: {
        qwen: {
          configured: true,
          key: "qwen",
          displayName: "Qwen",
          baseUrl: "https://qwen.example/v1",
          apiKey: "qwen-key",
          model: "qwen3.7max",
        },
      },
    },
    modelKey: "qwen",
    messages: [{ role: "user", content: "hi" }],
    mode: "consult",
    fetchImpl,
  });
  assert.equal(out.content, "ok");
  assert.equal(fetchImpl.calls[0].url, "https://qwen.example/v1/chat/completions");
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.model, "qwen3.7max");
  assert.equal(sent.thinking, undefined);
  assert.equal(sent.max_tokens, undefined);
  assert.equal(fetchImpl.calls[0].opts.headers.authorization, "Bearer qwen-key");
});

test("client: hand-built non-GLM model config without maxTokens omits global cap", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: {
      ...baseConfig,
      maxTokens: { review: 99999, consult: 88888 },
      models: {
        qwen: {
          configured: true,
          key: "qwen",
          displayName: "Qwen",
          baseUrl: "https://qwen.example/v1",
          apiKey: "qwen-key",
          model: "qwen3.7max",
          supportsThinking: false,
        },
      },
    },
    modelKey: "qwen",
    messages: [{ role: "user", content: "hi" }],
    mode: "review",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.max_tokens, undefined);
});

test("client: sends explicit non-GLM max token cap when configured", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: {
      ...baseConfig,
      models: {
        qwen: {
          configured: true,
          key: "qwen",
          displayName: "Qwen",
          baseUrl: "https://qwen.example/v1",
          apiKey: "qwen-key",
          model: "qwen3.7max",
          maxTokens: { review: 32768, consult: 16384 },
          supportsThinking: false,
        },
      },
    },
    modelKey: "qwen",
    messages: [{ role: "user", content: "hi" }],
    mode: "review",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.max_tokens, 32768);
  assert.equal(sent.thinking, undefined);
});

test("client: review mode enables thinking by default", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: baseConfig,
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.deepEqual(sent.thinking, { type: "enabled" });
});

test("client: GLM capability ignores legacy config.thinking (capability drives thinking field)", async () => {
  // Previously config.thinking="auto" omitted the thinking field. After capability dispatch,
  // GLM_TOGGLE always sends thinking based on effort — config.thinking is no longer consulted
  // by the http transport.
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: { ...baseConfig, thinking: "auto" },
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  // reasoningEffort="high" → thinking enabled regardless of config.thinking
  assert.deepEqual(sent.thinking, { type: "enabled" });
});

test("client: 401 fails fast (no retry)", async () => {
  const fetchImpl = makeFetch({ status: 401 });
  await assert.rejects(
    () =>
      streamChatCompletion({
        config: baseConfig,
        modelKey: "glm",
        messages: [{ role: "user", content: "x" }],
        mode: "consult",
        fetchImpl,
      }),
    (e) => e.code === "AUTH",
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test("client: 429 retries with backoff", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    if (callCount < 3) {
      return new Response("rate", { status: 429 });
    }
    return new Response(
      chunksToReadableStream(['data: {"choices":[{"delta":{"content":"after-retry"}}]}\n\n', "data: [DONE]\n\n"]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const out = await streamChatCompletion({
    config: { ...baseConfig, timeoutMs: 2000 },
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "consult",
    fetchImpl,
  });
  assert.equal(out.content, "after-retry");
  assert.equal(callCount, 3);
});

test("client: 429 with Retry-After > cap fails fast (no retry)", async () => {
  // The server is asking for a wait longer than we are willing to block a
  // request for. Previously we silently clamped to 60s and retried, which
  // meant three failures inside the real rate-limit window and a confusing
  // 429 surface. Now we surface the 429 immediately.
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("rate", {
      status: 429,
      headers: { "retry-after": "900" }, // 15 minutes
    });
  };
  await assert.rejects(
    () =>
      streamChatCompletion({
        config: { ...baseConfig, timeoutMs: 2000 },
        modelKey: "glm",
        messages: [{ role: "user", content: "x" }],
        mode: "consult",
        fetchImpl,
      }),
    (e) => e.code === "HTTP" && /429/.test(e.message),
  );
  assert.equal(calls, 1, "no retries when Retry-After exceeds cap");
});

test("client: 429 with Retry-After within cap is honored (not silently clamped)", async () => {
  let calls = 0;
  let waitedMs = null;
  const start = Date.now();
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      return new Response("rate", {
        status: 429,
        headers: { "retry-after": "2" }, // 2 seconds — within cap
      });
    }
    waitedMs = Date.now() - start;
    return new Response(
      chunksToReadableStream([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const out = await streamChatCompletion({
    config: { ...baseConfig, timeoutMs: 10_000 },
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "consult",
    fetchImpl,
  });
  assert.equal(out.content, "ok");
  assert.ok(waitedMs >= 1800, `expected ~2s wait, saw ${waitedMs}ms`);
});

test("client: unknown 400 does NOT fall back from json_schema", async () => {
  const fetchImpl = async () => new Response("bad input", { status: 400 });
  await assert.rejects(
    () =>
      streamChatCompletion({
        config: baseConfig,
        modelKey: "glm",
        messages: [{ role: "user", content: "x" }],
        mode: "review",
        responseFormat: { type: "json_schema", json_schema: {} },
        fetchImpl,
      }),
    (e) => e.code === "HTTP",
  );
});

test("client: explicit 'json_schema not supported' triggers fallback", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ error: { message: "response_format type 'json_schema' not supported" } }),
        { status: 400 },
      );
    }
    return new Response(
      chunksToReadableStream(['data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n', "data: [DONE]\n\n"]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const out = await streamChatCompletion({
    config: baseConfig,
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    responseFormat: { type: "json_schema", json_schema: { name: "x", schema: {} } },
    fetchImpl,
  });
  assert.equal(out.fellBackFromJsonSchema, true);
  assert.equal(calls, 2);
});

test("client: timeout aborts", async () => {
  const fetchImpl = async (_url, opts) => {
    return await new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  };
  await assert.rejects(
    () =>
      streamChatCompletion({
        config: { ...baseConfig, timeoutMs: 50 },
        modelKey: "glm",
        messages: [{ role: "user", content: "x" }],
        mode: "consult",
        fetchImpl,
      }),
    (e) => e.code === "TIMEOUT",
  );
});

test("client: per-call timeoutMs overrides config.timeoutMs", async () => {
  // config says 60s; the call passes 80ms. A server that never responds must
  // trip the per-call budget, proving the override wins over config.
  const fetchImpl = async (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  const start = Date.now();
  await assert.rejects(
    () =>
      streamChatCompletion({
        config: { ...baseConfig, timeoutMs: 60_000 },
        modelKey: "glm",
        messages: [{ role: "user", content: "x" }],
        mode: "consult",
        timeoutMs: 80,
        fetchImpl,
      }),
    (e) => e.code === "TIMEOUT",
  );
  // Aborted on the 80ms per-call budget, not the 60s config one.
  assert.ok(Date.now() - start < 5_000, "should abort on the per-call 80ms timeout");
});

test("client: timeout aborts stalled body after headers", async () => {
  // Respond 200 with headers, then stall the body indefinitely (until abort).
  const fetchImpl = async (_url, opts) => {
    const body = new ReadableStream({
      start(controller) {
        // Send one initial chunk so the parser starts, then stall.
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":""}}]}\n\n'));
        opts.signal.addEventListener("abort", () => {
          controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await assert.rejects(
    () =>
      streamChatCompletion({
        config: { ...baseConfig, timeoutMs: 100 },
        modelKey: "glm",
        messages: [{ role: "user", content: "x" }],
        mode: "consult",
        fetchImpl,
      }),
    (e) => e.code === "TIMEOUT",
  );
});

test("client: reasoning progress skips generating line when no reasoning emitted", async () => {
  const fetchImpl = makeFetch({
    chunks: [
      'data: {"choices":[{"delta":{"content":"one"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"two"}}]}\n\n',
      "data: [DONE]\n\n",
    ],
  });
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = function patchedWrite(chunk, ...args) {
    writes.push(String(chunk));
    if (typeof args.at(-1) === "function") args.at(-1)();
    return true;
  };
  try {
    const out = await streamChatCompletion({
      config: {
        ...baseConfig,
        progress: "reasoning",
        models: {
          qwen: {
            configured: true,
            key: "qwen",
            displayName: "Qwen",
            baseUrl: "https://qwen.example/v1",
            apiKey: "qwen-key",
            model: "qwen3.7max",
            supportsThinking: false,
            maxTokens: { review: undefined, consult: undefined },
          },
        },
      },
      modelKey: "qwen",
      messages: [{ role: "user", content: "hi" }],
      mode: "consult",
      fetchImpl,
    });
    assert.equal(out.content, "onetwo");
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(writes.some((s) => /generating/.test(s)), false);
});

// ─── Task 8: capability-dispatched http reasoning fields ─────────────────────

function makeCapConfig({ key, capability, vocab, reasoningEffort, model, baseUrl, maxTokens }) {
  return {
    ...baseConfig,
    models: {
      [key]: {
        configured: true,
        key,
        displayName: key,
        baseUrl: baseUrl ?? "https://api.test/v1",
        apiKey: "k",
        model: model ?? key + "-model",
        reasoning: capability,
        ...(vocab !== undefined ? { reasoningVocab: vocab } : {}),
        reasoningEffort: reasoningEffort ?? "high",
        maxTokens: maxTokens ?? { review: 8192, consult: 16384 },
      },
    },
  };
}

test("client[Task8]: GLM + per-call off → thinking disabled, no reasoningEffort key", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: makeCapConfig({ key: "glm", capability: CAPABILITY.GLM_TOGGLE, reasoningEffort: "high" }),
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    reasoningEffort: "off",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.deepEqual(sent.thinking, { type: "disabled" });
  assert.equal("reasoningEffort" in sent, false, "junk reasoningEffort key must not be sent");
});

test("client[Task8]: GLM + no per-call → thinking enabled (baseline high preserved)", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: makeCapConfig({ key: "glm", capability: CAPABILITY.GLM_TOGGLE, reasoningEffort: "high" }),
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "consult",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.deepEqual(sent.thinking, { type: "enabled" });
  assert.equal("reasoningEffort" in sent, false);
});

test("client[Task8]: deepseek + xhigh → reasoning_effort=max", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: makeCapConfig({ key: "deepseek", capability: CAPABILITY.OPENAI_EFFORT, vocab: "deepseek", reasoningEffort: "high" }),
    modelKey: "deepseek",
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    reasoningEffort: "xhigh",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.reasoning_effort, "max");
  assert.equal("reasoningEffort" in sent, false);
});

test("client[Task8]: deepseek + off → thinking disabled, no reasoning_effort", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: makeCapConfig({ key: "deepseek", capability: CAPABILITY.OPENAI_EFFORT, vocab: "deepseek", reasoningEffort: "high" }),
    modelKey: "deepseek",
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    reasoningEffort: "off",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.deepEqual(sent.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in sent, false);
  assert.equal("reasoningEffort" in sent, false);
});

test("client[Task8]: qwen (QWEN_BUDGET) + high → top-level enable_thinking + thinking_budget (not under extra_body)", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: makeCapConfig({ key: "qwen", capability: CAPABILITY.QWEN_BUDGET, reasoningEffort: "high", maxTokens: { review: 20000, consult: 20000 } }),
    modelKey: "qwen",
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.enable_thinking, true);
  assert.ok(typeof sent.thinking_budget === "number" && sent.thinking_budget > 0, "thinking_budget must be a positive number");
  assert.equal(sent.extra_body, undefined, "must NOT be nested under extra_body");
  assert.equal("reasoningEffort" in sent, false);
});

test("client[Task8]: gemini vocab + off → reasoning_effort=minimal", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: makeCapConfig({ key: "gemini", capability: CAPABILITY.OPENAI_EFFORT, vocab: "gemini", reasoningEffort: "high" }),
    modelKey: "gemini",
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    reasoningEffort: "off",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.reasoning_effort, "minimal");
  assert.equal("reasoningEffort" in sent, false);
});

test("client[Task8]: per-call effort overrides model baseline", async () => {
  const fetchImpl = makeFetch({});
  // baseline is "high" → thinking enabled; per-call "off" must win
  await streamChatCompletion({
    config: makeCapConfig({ key: "glm", capability: CAPABILITY.GLM_TOGGLE, reasoningEffort: "high" }),
    modelKey: "glm",
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    reasoningEffort: "off",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.deepEqual(sent.thinking, { type: "disabled" });
});

test("client[Task8]: NONE capability → no reasoning fields added to body", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: makeCapConfig({ key: "composer", capability: CAPABILITY.NONE, reasoningEffort: "off" }),
    modelKey: "composer",
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.thinking, undefined);
  assert.equal(sent.reasoning_effort, undefined);
  assert.equal(sent.enable_thinking, undefined);
  assert.equal("reasoningEffort" in sent, false);
});

test("client: mimo emits max_completion_tokens, not max_tokens", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: {
      ...baseConfig,
      models: {
        mimo: {
          configured: true,
          key: "mimo",
          displayName: "mimo-v2.5-pro (api)",
          baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
          apiKey: "mimo",
          model: "mimo-v2.5-pro",
          supportsThinking: true,
          reasoning: CAPABILITY.GLM_TOGGLE,
          reasoningEffort: "high",
          usesMaxCompletionTokens: true,
          maxTokens: { review: 8192, consult: 4096 },
        },
      },
    },
    modelKey: "mimo",
    messages: [{ role: "user", content: "hi" }],
    mode: "review",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.max_completion_tokens, 8192);
  assert.equal(sent.max_tokens, undefined);
});

test("client: glm still emits max_tokens, not max_completion_tokens", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: baseConfig, // baseConfig's glm has no usesMaxCompletionTokens
    modelKey: "glm",
    messages: [{ role: "user", content: "hi" }],
    mode: "review",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.max_tokens, 8192);
  assert.equal(sent.max_completion_tokens, undefined);
});

test("client[Task8]: reasoning_effort rejection retries once without it and succeeds", async () => {
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    if (calls === 1) {
      // First call: reject with reasoning_effort-shaped error
      return new Response(
        JSON.stringify({ error: { message: "reasoning_effort is not supported by this model" } }),
        { status: 400 },
      );
    }
    // Second call: succeed; assert reasoning_effort was removed
    assert.equal("reasoning_effort" in body, false, "retry must not include reasoning_effort");
    return new Response(
      chunksToReadableStream(['data: {"choices":[{"delta":{"content":"ok-retry"}}]}\n\n', "data: [DONE]\n\n"]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const out = await streamChatCompletion({
    config: makeCapConfig({ key: "deepseek", capability: CAPABILITY.OPENAI_EFFORT, vocab: "deepseek", reasoningEffort: "high" }),
    modelKey: "deepseek",
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    fetchImpl,
  });
  assert.equal(out.content, "ok-retry");
  assert.equal(calls, 2);
});

// ── Task D1/2a: surface HTTP error cause code in network error ───────────────

test("client: network error includes cause code in MultipolyError details and message", async () => {
  // callWithRetry retries network errors MAX_RETRIES (3) times; fake must reject
  // all 4 attempts (initial + 3 retries) so the final thrown error is inspectable.
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    const e = Object.assign(new Error("fetch failed"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    throw e;
  };
  const err = await assert.rejects(
    () =>
      streamChatCompletion({
        config: { ...baseConfig, timeoutMs: 100 },
        modelKey: "glm",
        messages: [{ role: "user", content: "x" }],
        mode: "consult",
        fetchImpl,
      }),
    (e) => {
      assert.equal(e.code, "HTTP");
      assert.equal(e.details?.cause, "UND_ERR_CONNECT_TIMEOUT");
      assert.match(e.message, /UND_ERR_CONNECT_TIMEOUT/);
      return true;
    },
  );
  // All 4 attempts must have been made (initial + 3 retries)
  assert.equal(attempts, 4, `expected 4 attempts, got ${attempts}`);
});
