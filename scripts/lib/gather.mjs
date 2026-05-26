import path from "node:path";
import { realpath } from "node:fs/promises";
import { MultipolyError } from "./errors.mjs";
import {
  isGitRepo,
  getToplevel,
  validateRef,
  getChangedFiles,
  getDiffText,
  getBinaryPathsInDiff,
} from "./git.mjs";
import { containPath, isBinaryFile, getSize, readFileCapped } from "./fs-safe.mjs";

/**
 * Build the review payload.
 *
 * Inputs are mutually exclusive: exactly one of `diffBase` or `paths` must be set.
 *
 * Atomic-per-file policy:
 *   - File > perFile cap → status "omitted".
 *   - File fits but adding it would exceed total cap → status "listed_only".
 *   - File count beyond fileCount cap → status "listed_only".
 *   - Binary file → status "listed_only" with reason "binary".
 *   - Otherwise → status "inlined", content read.
 */
export async function gatherReview({ diffBase, paths, cwd = process.cwd(), caps }) {
  const hasBase = typeof diffBase === "string" && diffBase.length > 0;
  const hasPaths = Array.isArray(paths) && paths.length > 0;
  if (hasBase === hasPaths) {
    throw new MultipolyError(
      "INVALID_INPUT",
      "review requires exactly one of `diff_base` or `paths`",
    );
  }

  if (hasBase) {
    return gatherReviewDiff({ diffBase, cwd, caps });
  }
  return gatherReviewPaths({ paths, cwd, caps });
}

async function gatherReviewDiff({ diffBase, cwd, caps }) {
  if (!(await isGitRepo(cwd))) {
    throw new MultipolyError("GIT", `not a git repository: ${cwd}`);
  }
  const topRaw = await getToplevel(cwd);
  const top = await realpath(topRaw);

  await validateRef(diffBase, top);
  const changed = await getChangedFiles(diffBase, top);
  const binariesInDiff = await getBinaryPathsInDiff(diffBase, top);

  // Containment check: reject any changed path whose realpath escapes the repo
  // (can happen via in-repo symlinks pointing outside). Keep the resolved
  // realpath so the later read uses the canonical path, not a re-joined one.
  const entries = [];
  const containOmitted = [];
  for (const rel of changed) {
    try {
      const abs = await containPath(top, rel, { cwd: top });
      entries.push({ rel, abs });
    } catch (e) {
      // Translate the tagged failure kind into a fixed, safe-to-render reason
      // so the LLM-facing output is predictable and doesn't echo raw paths or
      // internal error strings.
      const kind = e instanceof MultipolyError ? e.details?.kind : null;
      const reason =
        kind === "escapes_root" ? "escapes repo root" :
        kind === "missing" ? "file no longer exists" :
        kind === "resolve_failed" ? "path resolution failed" :
        "containment check failed";
      containOmitted.push({ path: rel, status: "listed_only", reason });
    }
  }

  const files = await classifyFiles({
    entries,
    caps,
    forcedBinaries: binariesInDiff,
  });
  // Merge containment rejections back in so the model sees that they exist but weren't inlined.
  const allFiles = [...containOmitted, ...files];

  // Share the caps.total budget across inlined files AND the diff so the
  // total outbound payload can't be ~2× caps.total (files fill it, diff
  // fills it again independently). Inlined files have first claim — we
  // already know their byte usage — and the diff gets whatever remains.
  // Compute the budget BEFORE the git call so we skip the diff fetch
  // entirely when files already filled the total cap.
  const inlinedFiles = files.filter((f) => f.status === "inlined");
  const filesBytesUsed = inlinedFiles.reduce(
    (sum, f) => sum + Buffer.byteLength(f.content, "utf8"),
    0,
  );
  const diffBudget = Math.max(0, caps.total - filesBytesUsed);

  // Build diff scoped to inlined files ONLY. Omitted/listed files never leak content.
  const inlinedPaths = inlinedFiles.map((f) => f.path);
  let diffText = inlinedPaths.length > 0 && diffBudget > 0
    ? await getDiffText(diffBase, top, inlinedPaths)
    : "";

  let diffTruncated = false;
  const diffBytes = Buffer.byteLength(diffText, "utf8");
  if (diffBytes > diffBudget) {
    // Truncate by UTF-8 bytes, not UTF-16 code units, and let `toString` drop
    // any incomplete trailing codepoint so we never emit a lone surrogate.
    // Reserve the suffix bytes from the budget so the final length obeys
    // diffBudget (and therefore caps.total) strictly.
    const suffix = `\n…[diff truncated: ${diffBytes} bytes > remaining cap ${diffBudget} of ${caps.total} total]`;
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    const headBytes = Math.max(0, diffBudget - suffixBytes);
    const buf = Buffer.from(diffText, "utf8");
    diffText = buf.toString("utf8", 0, headBytes) + suffix;
    diffTruncated = true;
  }

  const truncated = diffTruncated || allFiles.some((f) => f.status !== "inlined");

  return {
    mode: "diff",
    base: diffBase,
    diffText,
    files: allFiles,
    truncated,
  };
}

async function gatherReviewPaths({ paths, cwd, caps }) {
  // Root: git toplevel if available, else cwd realpath.
  let rootRealpath;
  if (await isGitRepo(cwd)) {
    rootRealpath = await realpath(await getToplevel(cwd));
  } else {
    rootRealpath = await realpath(cwd);
  }

  // Resolve relative paths against the repo root, not the process cwd. If the
  // MCP server was launched from a subdirectory, a caller passing "foo.ts"
  // means <root>/foo.ts, not <cwd>/foo.ts.
  const entries = [];
  for (const p of paths) {
    const abs = await containPath(rootRealpath, p, { cwd: rootRealpath });
    const rel = path.relative(rootRealpath, abs) || ".";
    entries.push({ rel, abs });
  }

  const files = await classifyFiles({
    entries,
    caps,
    forcedBinaries: new Set(),
  });

  const truncated = files.some((f) => f.status !== "inlined");

  return {
    mode: "paths",
    files,
    truncated,
  };
}

async function classifyFiles({ entries, caps, forcedBinaries }) {
  const out = [];
  let bytesUsed = 0;
  let inlinedCount = 0;

  for (const { rel, abs } of entries) {
    if (inlinedCount >= caps.fileCount) {
      out.push({ path: rel, status: "listed_only", reason: `over file-count cap (${caps.fileCount})` });
      continue;
    }

    if (forcedBinaries.has(rel)) {
      out.push({ path: rel, status: "listed_only", reason: "binary" });
      continue;
    }

    let size;
    try {
      size = await getSize(abs);
    } catch (e) {
      // Missing or non-regular files (e.g., deletion survived filter) → listed
      out.push({
        path: rel,
        status: "listed_only",
        reason: e instanceof MultipolyError ? e.message : String(e),
      });
      continue;
    }

    if (size > caps.perFile) {
      out.push({
        path: rel,
        status: "omitted",
        reason: `size ${size} > per-file cap ${caps.perFile}`,
      });
      continue;
    }

    if (bytesUsed + size > caps.total) {
      out.push({
        path: rel,
        status: "listed_only",
        reason: `would exceed total cap ${caps.total}`,
      });
      continue;
    }

    // Check binary-by-content for non-git cases
    try {
      if (await isBinaryFile(abs)) {
        out.push({ path: rel, status: "listed_only", reason: "binary" });
        continue;
      }
    } catch (e) {
      out.push({
        path: rel,
        status: "listed_only",
        reason: e instanceof MultipolyError ? e.message : String(e),
      });
      continue;
    }

    const { content } = await readFileCapped(abs, caps.perFile);
    if (content === null) {
      out.push({ path: rel, status: "omitted", reason: "over per-file cap" });
      continue;
    }
    // Retroactive total-cap check. `readFileCapped` already clamps the
    // buffer to min(size, cap), so the pure file-grew case is bounded.
    // But UTF-8 expansion after invalid bytes (each → U+FFFD = 3 bytes)
    // can make `actual` larger than `bytesRead`. Downgrade the file to
    // listed_only if it would push the total past the cap.
    const actual = Buffer.byteLength(content, "utf8");
    if (bytesUsed + actual > caps.total) {
      out.push({
        path: rel,
        status: "listed_only",
        reason: `UTF-8 content would exceed total cap ${caps.total}`,
      });
      continue;
    }
    out.push({ path: rel, status: "inlined", content });
    bytesUsed += actual;
    inlinedCount++;
  }

  return out;
}

/**
 * Consult/freeform gathering: attach files verbatim (no mid-file trim).
 * Oversized file → INVALID_INPUT (caller's responsibility to split or trim).
 */
export async function gatherConsult({ prompt, paths, cwd = process.cwd(), caps }) {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new MultipolyError("INVALID_INPUT", "prompt must be a non-empty string");
  }
  if (!paths || paths.length === 0) {
    return { prompt, files: [] };
  }

  let rootRealpath;
  if (await isGitRepo(cwd)) {
    rootRealpath = await realpath(await getToplevel(cwd));
  } else {
    rootRealpath = await realpath(cwd);
  }

  const files = [];
  let bytesUsed = 0;
  for (const p of paths) {
    if (files.length >= caps.fileCount) {
      throw new MultipolyError(
        "INVALID_INPUT",
        `too many attached files (cap ${caps.fileCount}). Reduce the attachment set or raise MULTIPOLY_FILE_COUNT_CAP.`,
      );
    }
    // Resolve relative paths against the repo root, not the process cwd.
    const abs = await containPath(rootRealpath, p, { cwd: rootRealpath });
    const rel = path.relative(rootRealpath, abs) || p;
    const size = await getSize(abs);
    if (size > caps.perFile) {
      throw new MultipolyError(
        "INVALID_INPUT",
        `attached file ${rel} is ${size} bytes (over per-file cap ${caps.perFile}). Split the file or increase MULTIPOLY_PER_FILE_CAP_BYTES.`,
      );
    }
    if (bytesUsed + size > caps.total) {
      throw new MultipolyError(
        "INVALID_INPUT",
        `attached files exceed total cap ${caps.total} bytes. Reduce the attachment set or increase MULTIPOLY_TOTAL_CAP_BYTES.`,
      );
    }
    if (await isBinaryFile(abs)) {
      throw new MultipolyError("INVALID_INPUT", `attached file ${rel} is binary; refusing to send.`);
    }
    const { content } = await readFileCapped(abs, caps.perFile);
    if (content === null) {
      // TOCTOU: file grew past perFile cap between getSize and read.
      throw new MultipolyError(
        "INVALID_INPUT",
        `attached file ${rel} grew past per-file cap during read.`,
      );
    }
    // Retroactive total-cap check: the pre-read `size` passed, but UTF-8
    // expansion of invalid bytes (each → U+FFFD = 3 bytes) or a mid-read
    // file grow can push `actual` above `size`. Mirror classifyFiles.
    const actual = Buffer.byteLength(content, "utf8");
    if (bytesUsed + actual > caps.total) {
      throw new MultipolyError(
        "INVALID_INPUT",
        `attached file ${rel} would push total past cap ${caps.total} after UTF-8 decoding. Reduce the attachment set or increase MULTIPOLY_TOTAL_CAP_BYTES.`,
      );
    }
    files.push({ path: rel, content });
    bytesUsed += actual;
  }

  return { prompt, files };
}
