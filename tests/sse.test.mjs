import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSseStream } from "../scripts/lib/sse.mjs";

const enc = new TextEncoder();

async function* chunksFrom(strings) {
  for (const s of strings) yield enc.encode(s);
}

async function collect(source) {
  const out = [];
  for await (const ev of parseSseStream(source)) out.push(ev);
  return out;
}

test("sse: single data event", async () => {
  const events = await collect(chunksFrom(['data: {"a":1}\n\n']));
  assert.deepEqual(events, [{ type: "data", value: { a: 1 } }]);
});

test("sse: [DONE] sentinel ends stream", async () => {
  const events = await collect(chunksFrom(['data: {"a":1}\n\n', "data: [DONE]\n\n"]));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { type: "data", value: { a: 1 } });
  assert.deepEqual(events[1], { type: "done" });
});

test("sse: CRLF line endings", async () => {
  const events = await collect(chunksFrom(['data: {"a":1}\r\n\r\n']));
  assert.deepEqual(events, [{ type: "data", value: { a: 1 } }]);
});

test("sse: multi-line data joined with \\n", async () => {
  const events = await collect(chunksFrom(['data: {"a":\ndata: 1}\n\n']));
  assert.deepEqual(events, [{ type: "data", value: { a: 1 } }]);
});

test("sse: comment lines ignored", async () => {
  const events = await collect(chunksFrom([': keepalive\n\ndata: {"a":1}\n\n']));
  assert.deepEqual(events, [{ type: "data", value: { a: 1 } }]);
});

test("sse: event: and id: fields ignored (but don't break parsing)", async () => {
  const events = await collect(
    chunksFrom(['event: message\nid: 42\ndata: {"a":1}\n\n']),
  );
  assert.deepEqual(events, [{ type: "data", value: { a: 1 } }]);
});

test("sse: top-level error surfaces STREAM", async () => {
  await assert.rejects(
    () => collect(chunksFrom(['data: {"error":{"message":"bad"}}\n\n'])),
    (e) => e.code === "STREAM" && e.message.includes("bad"),
  );
});

test("sse: chunk boundary mid-event", async () => {
  const events = await collect(chunksFrom(['data: {"a":', "1}\n\n"]));
  assert.deepEqual(events, [{ type: "data", value: { a: 1 } }]);
});

test("sse: UTF-8 split across chunks", async () => {
  // "€" = 0xE2 0x82 0xAC
  const payload = 'data: {"s":"€"}\n\n';
  const bytes = enc.encode(payload);
  // split in the middle of the € multibyte sequence
  const euroStart = payload.indexOf("€");
  const cut = bytes.indexOf(0xe2) + 1;
  assert.ok(euroStart > 0 && cut > 0);
  const a = bytes.slice(0, cut);
  const b = bytes.slice(cut);
  async function* src() {
    yield a;
    yield b;
  }
  const events = await collect(src());
  assert.deepEqual(events, [{ type: "data", value: { s: "€" } }]);
});

test("sse: invalid JSON raises STREAM", async () => {
  await assert.rejects(
    () => collect(chunksFrom(["data: not json\n\n"])),
    (e) => e.code === "STREAM",
  );
});

test("sse: multiple events in one chunk", async () => {
  const events = await collect(
    chunksFrom(['data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n']),
  );
  assert.equal(events.length, 3);
  assert.deepEqual(events[0].value, { a: 1 });
  assert.deepEqual(events[1].value, { b: 2 });
  assert.equal(events[2].type, "done");
});

test("sse: mixed \\r\\n and \\n", async () => {
  const events = await collect(
    chunksFrom(['data: {"a":1}\r\n\r\ndata: {"b":2}\n\n']),
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].value, { a: 1 });
  assert.deepEqual(events[1].value, { b: 2 });
});

test("sse: split CRLF across chunks inside multi-line event", async () => {
  // data: {"a":\r\ndata: 1}\r\n\r\n — but split mid-CRLF so first chunk ends with \r
  const first = 'data: {"a":\r';
  const second = '\ndata: 1}\r\n\r\n';
  const events = await collect(chunksFrom([first, second]));
  assert.deepEqual(events, [{ type: "data", value: { a: 1 } }]);
});

test("sse: split CRLF across chunks at event boundary", async () => {
  // end of event "\r\n\r\n" split: first chunk ends right after first \r
  const first = 'data: {"x":1}\r';
  const second = '\n\r\ndata: {"y":2}\r\n\r\n';
  const events = await collect(chunksFrom([first, second]));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].value, { x: 1 });
  assert.deepEqual(events[1].value, { y: 2 });
});
