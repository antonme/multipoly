import { test } from "node:test";
import assert from "node:assert/strict";
import { streamChatCompletion } from "../scripts/lib/client.mjs";

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
  thinking: "mode-default",
  timeoutMs: 5000,
  maxTokens: { review: 8192, consult: 16384, freeform: 16384 },
  progress: "off",
};

test("client: happy path streams content", async () => {
  const fetchImpl = makeFetch({});
  const out = await streamChatCompletion({
    config: baseConfig,
    messages: [{ role: "user", content: "hi" }],
    mode: "consult",
    fetchImpl,
  });
  assert.equal(out.content, "ok");
  assert.equal(fetchImpl.calls.length, 1);
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.model, "glm-5.1");
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.thinking, { type: "disabled" }); // consult default off
});

test("client: review mode enables thinking by default", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: baseConfig,
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.deepEqual(sent.thinking, { type: "enabled" });
});

test("client: GLM_THINKING=auto omits thinking field", async () => {
  const fetchImpl = makeFetch({});
  await streamChatCompletion({
    config: { ...baseConfig, thinking: "auto" },
    messages: [{ role: "user", content: "x" }],
    mode: "review",
    fetchImpl,
  });
  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(sent.thinking, undefined);
});

test("client: 401 fails fast (no retry)", async () => {
  const fetchImpl = makeFetch({ status: 401 });
  await assert.rejects(
    () =>
      streamChatCompletion({
        config: baseConfig,
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
        messages: [{ role: "user", content: "x" }],
        mode: "consult",
        fetchImpl,
      }),
    (e) => e.code === "TIMEOUT",
  );
});
