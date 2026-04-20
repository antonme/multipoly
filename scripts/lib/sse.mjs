import { GlmError } from "./errors.mjs";

/**
 * Parse an OpenAI-compatible SSE stream.
 *
 * Input: async iterable of Uint8Array chunks (e.g. fetch Response body).
 * Output: async generator of events, each either:
 *   - { type: "data", value: <parsed JSON object> }
 *   - { type: "done" } — emitted on `[DONE]` sentinel
 *   - throws GlmError("STREAM", ...) on protocol error or top-level {error}
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
export async function* parseSseStream(source) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";

  // Normalize line endings: we split on '\n' after replacing '\r\n' and lone '\r'.
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

  const processBuffer = function* () {
    // Split on \n\n (event delimiter) — keep last unterminated piece in buffer.
    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = raw.split("\n");
      const data = flushEvent(lines);
      if (data === null) continue;
      yield data;
    }
  };

  for await (const chunk of source) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    buffer += normalize(decoder.decode(bytes, { stream: true }));

    for (const data of processBuffer()) {
      if (data === "[DONE]") {
        yield { type: "done" };
        return;
      }
      const parsed = safeParse(data);
      if (parsed.error) {
        throw new GlmError("STREAM", `invalid JSON in SSE data: ${parsed.error}`);
      }
      // OpenAI-compatible top-level error shape
      if (parsed.value && typeof parsed.value === "object" && parsed.value.error) {
        const e = parsed.value.error;
        throw new GlmError(
          "STREAM",
          typeof e?.message === "string" ? e.message : "upstream error",
          { details: e },
        );
      }
      yield { type: "data", value: parsed.value };
    }
  }

  // Flush any trailing final decode + any remaining complete event
  buffer += normalize(decoder.decode());
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
        throw new GlmError("STREAM", `invalid JSON in SSE data: ${parsed.error}`);
      }
      if (parsed.value && typeof parsed.value === "object" && parsed.value.error) {
        const e = parsed.value.error;
        throw new GlmError(
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
