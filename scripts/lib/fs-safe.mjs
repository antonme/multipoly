import { realpath, stat, open } from "node:fs/promises";
import path from "node:path";
import { GlmError } from "./errors.mjs";

/**
 * Resolve candidate via realpath, assert it is inside (or equal to) rootRealpath.
 * rootRealpath must already be realpath'd by the caller.
 * Returns the resolved real path.
 */
export async function containPath(rootRealpath, candidate, { cwd = process.cwd() } = {}) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new GlmError("INVALID_INPUT", "path must be a non-empty string");
  }
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  let resolved;
  try {
    resolved = await realpath(absolute);
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new GlmError("FS", `path does not exist: ${candidate}`, { cause: e });
    }
    throw new GlmError("FS", `cannot resolve path: ${candidate}: ${e.message}`, { cause: e });
  }
  const root = rootRealpath.endsWith(path.sep) ? rootRealpath : rootRealpath + path.sep;
  if (resolved !== rootRealpath && !resolved.startsWith(root)) {
    throw new GlmError("FS", `path escapes root: ${candidate}`);
  }
  return resolved;
}

/**
 * Sniff first N bytes to detect binary content (presence of NUL byte).
 */
export async function isBinaryFile(absPath, sniffBytes = 4096) {
  let fh;
  try {
    fh = await open(absPath, "r");
    const buf = Buffer.alloc(sniffBytes);
    const { bytesRead } = await fh.read(buf, 0, sniffBytes, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch (e) {
    throw new GlmError("FS", `cannot read: ${absPath}: ${e.message}`, { cause: e });
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

export async function getSize(absPath) {
  try {
    const st = await stat(absPath);
    if (!st.isFile()) {
      throw new GlmError("FS", `not a regular file: ${absPath}`);
    }
    return st.size;
  } catch (e) {
    if (e instanceof GlmError) throw e;
    throw new GlmError("FS", `cannot stat: ${absPath}: ${e.message}`, { cause: e });
  }
}

/**
 * Read up to `cap` bytes. If the file exceeds cap, throws unless { allowTruncate: true },
 * in which case returns { content, size, truncated: true }.
 * Default mode: refuse overflow (atomic-per-file).
 */
export async function readFileCapped(absPath, cap, { allowTruncate = false } = {}) {
  const size = await getSize(absPath);
  if (size > cap && !allowTruncate) {
    return { content: null, size, truncated: true, overCap: true };
  }
  let fh;
  try {
    fh = await open(absPath, "r");
    const readLen = Math.min(size, cap);
    const buf = Buffer.alloc(readLen);
    await fh.read(buf, 0, readLen, 0);
    return {
      content: buf.toString("utf8"),
      size,
      truncated: size > cap,
      overCap: false,
    };
  } catch (e) {
    throw new GlmError("FS", `cannot read: ${absPath}: ${e.message}`, { cause: e });
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}
