import { MultipolyError } from "./errors.mjs";

/**
 * Parse an OpenAI-compatible SSE stream.
 *
 * Input: async iterable of Uint8Array chunks (e.g. fetch Response body).
 * Output: async generator of events, each either:
 *   - { type: "data", value: <parsed JSON object> }
 *   - { type: "done" } — emitted on `[DONE]` sentinel
 *   - throws MultipolyError("STREAM", ...) on protocol error or top-level {error}
 *
 * Handles:
 *   - \r\n / \r / \n line endings
 *   - multiple `data:` lines per event (joined with \n before JSON.parse)
 *   - `:` comment lines (ignored)
 *   - `event:` / `id:` / `retry:` fields (captured but not required)
 *   - UTF-8 bytes split across chunks via streaming TextDecoder
 *   - `[DONE]` sentinel terminates cleanly
 *   - top-level {error: {...}} payload — surfaces typed STREAM error
 */
// Cap for the in-memory SSE buffer. An upstream that never emits a blank-line
// event delimiter (malicious or broken) would otherwise grow `buffer`
// without bound. 8 MiB is comfortably larger than any real SSE event we
// expect while still stopping runaway allocation.
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

export async function* parseSseStream(source) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  // UTF-8 byte count of the current `buffer`. Tracked incrementally so the
  // DoS cap check is O(1) per chunk instead of O(n) — a pathological
  // never-delimited stream was previously O(n²) cumulative CPU. We only
  // recompute exactly (via Buffer.byteLength) when a drain actually shrinks
  // the buffer, which never happens in the pathological case.
  let bufferBytes = 0;

  // Normalize line endings. A trailing bare '\r' at the end of a chunk is held
  // back (in `buffer`) so that an incoming leading '\n' on the next chunk can
  // still combine into '\r\n' — otherwise a split CRLF inside a multi-line
  // event would erroneously become '\n\n' and prematurely terminate it.
  const normalize = (s) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const flushEvent = (rawLines) => {
    // An event is a series of field lines terminated by a blank line.
    // We care about `data:` primarily; other fields captured but unused.
    const dataParts = [];
    for (const line of rawLines) {
      if (line === "") continue;
      if (line.startsWith(":")) continue; // comment
      const colon = line.indexOf(":");
      let field, value;
      if (colon === -1) {
        field = line;
        value = "";
      } else {
        field = line.slice(0, colon);
        value = line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
      }
      if (field === "data") dataParts.push(value);
      // ignore event:/id:/retry: for our use case
    }
    if (dataParts.length === 0) return null;
    return dataParts.join("\n");
  };

  // `drained` is set true whenever processBuffer consumes at least one event
  // so the outer loop knows to re-sync `bufferBytes` from the trimmed buffer.
  let drained = false;
  const processBuffer = function* () {
    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      drained = true;
      const lines = raw.split("\n");
      const data = flushEvent(lines);
      if (data === null) continue;
      yield data;
    }
  };

  for await (const chunk of source) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    // Count raw bytes BEFORE decoding — incremental UTF-8 byte accounting.
    // Slightly overestimates when we later drop a '\r' during CRLF merging,
    // but that's fine: the cap is a safety ceiling, not a precise budget.
    bufferBytes += bytes.byteLength;
    let decoded = decoder.decode(bytes, { stream: true });

    // If the previous chunk ended on a trailing '\r', we stashed it by leaving
    // it in `buffer` unnormalized. Combine it with the current chunk now so
    // '\r' + '\n' is normalized as a unit.
    let pending = decoded;
    if (pending.endsWith("\r")) {
      // Hold back the trailing \r for the next chunk. Combine first with any
      // pre-existing held-back '\r' in the buffer so two consecutive trailing-
      // \r chunks don't leave a literal \r sitting un-normalized (which would
      // stall the event-delimiter search until the buffer cap trips).
      pending = pending.slice(0, -1);
      if (buffer.endsWith("\r")) {
        buffer = buffer.slice(0, -1) + normalize("\r" + pending);
      } else {
        buffer += normalize(pending);
      }
      buffer += "\r";
    } else {
      if (buffer.endsWith("\r")) {
        buffer = buffer.slice(0, -1) + normalize("\r" + pending);
      } else {
        buffer += normalize(pending);
      }
    }

    drained = false;
    for (const data of processBuffer()) {
      if (data === "[DONE]") {
        yield { type: "done" };
        return;
      }
      const parsed = safeParse(data);
      if (parsed.error) {
        throw new MultipolyError("STREAM", `invalid JSON in SSE data: ${parsed.error}`);
      }
      // OpenAI-compatible top-level error shape
      if (parsed.value && typeof parsed.value === "object" && parsed.value.error) {
        const e = parsed.value.error;
        throw new MultipolyError(
          "STREAM",
          typeof e?.message === "string" ? e.message : "upstream error",
          { details: e },
        );
      }
      yield { type: "data", value: parsed.value };
    }

    // If any events were drained this round, re-sync the byte counter from
    // the (now-shorter) buffer. In the pathological "no delimiter ever" case
    // this branch is never taken, so the cap check stays O(1) per chunk and
    // the whole stream is O(n) cumulative instead of O(n²).
    if (drained) bufferBytes = Buffer.byteLength(buffer, "utf8");

    // Cap measures "undelimited tail" bytes — with no `\n\n` ahead — which
    // is the real DoS signal. Units are UTF-8 bytes, not UTF-16 code units.
    if (bufferBytes > MAX_SSE_BUFFER_BYTES) {
      throw new MultipolyError(
        "STREAM",
        `SSE buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes without an event delimiter`,
      );
    }
  }

  // Flush any trailing final decode + any remaining complete event
  let tail = decoder.decode();
  if (buffer.endsWith("\r")) {
    buffer = buffer.slice(0, -1) + normalize("\r" + tail);
  } else {
    buffer += normalize(tail);
  }
  // In case the stream ended without a trailing blank line but had one last event
  if (buffer.trim().length > 0) {
    const lines = buffer.split("\n");
    buffer = "";
    const data = flushEvent(lines);
    if (data !== null) {
      if (data === "[DONE]") {
        yield { type: "done" };
        return;
      }
      const parsed = safeParse(data);
      if (parsed.error) {
        throw new MultipolyError("STREAM", `invalid JSON in SSE data: ${parsed.error}`);
      }
      if (parsed.value && typeof parsed.value === "object" && parsed.value.error) {
        const e = parsed.value.error;
        throw new MultipolyError(
          "STREAM",
          typeof e?.message === "string" ? e.message : "upstream error",
          { details: e },
        );
      }
      yield { type: "data", value: parsed.value };
    }
  }
}

function safeParse(s) {
  try {
    return { value: JSON.parse(s) };
  } catch (e) {
    return { error: e.message };
  }
}
