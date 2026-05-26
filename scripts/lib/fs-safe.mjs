import { realpath, stat, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { MultipolyError } from "./errors.mjs";

// O_NOFOLLOW rejects symlinks at open time on Linux/macOS/BSD. Windows
// doesn't define it in the same way; we fall back to default read flags
// there. This narrows the TOCTOU window between realpath() containment
// and the subsequent read: a symlink swapped in after containment would
// be refused at open.
const READ_FLAGS = fsConstants.O_NOFOLLOW !== undefined
  ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
  : "r";

/**
 * Resolve candidate via realpath, assert it is inside (or equal to) rootRealpath.
 * rootRealpath must already be realpath'd by the caller.
 * Returns the resolved real path.
 */
export async function containPath(rootRealpath, candidate, { cwd = process.cwd() } = {}) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new MultipolyError("INVALID_INPUT", "path must be a non-empty string");
  }
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  let resolved;
  try {
    resolved = await realpath(absolute);
  } catch (e) {
    // Tag the error kind so callers can render a meaningful reason without
    // re-parsing the message string. `kind` is not rendered into the LLM-facing
    // prompt — callers translate it into a fixed taxonomy.
    if (e.code === "ENOENT") {
      throw new MultipolyError("FS", `path does not exist: ${candidate}`, {
        cause: e,
        details: { kind: "missing" },
      });
    }
    throw new MultipolyError("FS", `cannot resolve path: ${candidate}: ${e.message}`, {
      cause: e,
      details: { kind: "resolve_failed" },
    });
  }
  const root = rootRealpath.endsWith(path.sep) ? rootRealpath : rootRealpath + path.sep;
  if (resolved !== rootRealpath && !resolved.startsWith(root)) {
    throw new MultipolyError("FS", `path escapes root: ${candidate}`, {
      details: { kind: "escapes_root" },
    });
  }
  return resolved;
}

/**
 * Sniff first N bytes to detect binary content (presence of NUL byte).
 */
export async function isBinaryFile(absPath, sniffBytes = 4096) {
  let fh;
  try {
    fh = await open(absPath, READ_FLAGS);
    const buf = Buffer.alloc(sniffBytes);
    const { bytesRead } = await fh.read(buf, 0, sniffBytes, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch (e) {
    throw new MultipolyError("FS", `cannot read: ${absPath}: ${e.message}`, { cause: e });
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

export async function getSize(absPath) {
  try {
    const st = await stat(absPath);
    if (!st.isFile()) {
      throw new MultipolyError("FS", `not a regular file: ${absPath}`);
    }
    return st.size;
  } catch (e) {
    if (e instanceof MultipolyError) throw e;
    throw new MultipolyError("FS", `cannot stat: ${absPath}: ${e.message}`, { cause: e });
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
    // O_NOFOLLOW rejects symlink races between stat and read (see READ_FLAGS
    // above). Slice the buffer to the actual bytesRead — if the file shrunk
    // between stat and read we'd otherwise emit trailing NUL bytes.
    fh = await open(absPath, READ_FLAGS);
    const readLen = Math.min(size, cap);
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, 0);
    return {
      content: buf.toString("utf8", 0, bytesRead),
      size,
      truncated: size > cap,
      overCap: false,
    };
  } catch (e) {
    throw new MultipolyError("FS", `cannot read: ${absPath}: ${e.message}`, { cause: e });
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}
