import path from "node:path";
import { realpath } from "node:fs/promises";
import { GlmError } from "./errors.mjs";
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
    throw new GlmError(
      "INVALID_INPUT",
      "glm_review requires exactly one of `diff_base` or `paths`",
    );
  }

  if (hasBase) {
    return gatherReviewDiff({ diffBase, cwd, caps });
  }
  return gatherReviewPaths({ paths, cwd, caps });
}

async function gatherReviewDiff({ diffBase, cwd, caps }) {
  if (!(await isGitRepo(cwd))) {
    throw new GlmError("GIT", `not a git repository: ${cwd}`);
  }
  const topRaw = await getToplevel(cwd);
  const top = await realpath(topRaw);

  await validateRef(diffBase, top);
  const changed = await getChangedFiles(diffBase, top);
  const binariesInDiff = await getBinaryPathsInDiff(diffBase, top);

  // Containment check: reject any changed path whose realpath escapes the repo
  // (can happen via in-repo symlinks pointing outside).
  const containSet = new Set();
  const containOmitted = [];
  for (const rel of changed) {
    try {
      await containPath(top, rel, { cwd: top });
      containSet.add(rel);
    } catch (e) {
      containOmitted.push({
        path: rel,
        status: "listed_only",
        reason: e instanceof GlmError ? `escapes repo root: ${e.message}` : String(e),
      });
    }
  }
  const safeChanged = changed.filter((p) => containSet.has(p));

  const files = await classifyFiles({
    relPaths: safeChanged,
    rootRealpath: top,
    caps,
    forcedBinaries: binariesInDiff,
  });
  // Merge containment rejections back in so the model sees that they exist but weren't inlined.
  const allFiles = [...containOmitted, ...files];

  // Build diff scoped to inlined files ONLY. Omitted/listed files never leak content.
  const inlinedPaths = files.filter((f) => f.status === "inlined").map((f) => f.path);
  const diffText = inlinedPaths.length > 0
    ? await getDiffText(diffBase, top, inlinedPaths)
    : "";

  const truncated = allFiles.some((f) => f.status !== "inlined");

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

  const relPaths = [];
  for (const p of paths) {
    const abs = await containPath(rootRealpath, p, { cwd });
    relPaths.push(path.relative(rootRealpath, abs) || ".");
  }

  const files = await classifyFiles({
    relPaths,
    rootRealpath,
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

async function classifyFiles({ relPaths, rootRealpath, caps, forcedBinaries }) {
  const out = [];
  let bytesUsed = 0;
  let inlinedCount = 0;

  for (const rel of relPaths) {
    const abs = path.join(rootRealpath, rel);

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
        reason: e instanceof GlmError ? e.message : String(e),
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
        reason: e instanceof GlmError ? e.message : String(e),
      });
      continue;
    }

    const { content } = await readFileCapped(abs, caps.perFile);
    if (content === null) {
      out.push({ path: rel, status: "omitted", reason: "over per-file cap" });
      continue;
    }
    out.push({ path: rel, status: "inlined", content });
    bytesUsed += size;
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
    throw new GlmError("INVALID_INPUT", "prompt must be a non-empty string");
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
    const abs = await containPath(rootRealpath, p, { cwd });
    const rel = path.relative(rootRealpath, abs) || p;
    const size = await getSize(abs);
    if (size > caps.perFile) {
      throw new GlmError(
        "INVALID_INPUT",
        `attached file ${rel} is ${size} bytes (over per-file cap ${caps.perFile}). Split the file or increase GLM_PER_FILE_CAP_BYTES.`,
      );
    }
    if (bytesUsed + size > caps.total) {
      throw new GlmError(
        "INVALID_INPUT",
        `attached files exceed total cap ${caps.total} bytes. Reduce the attachment set or increase GLM_TOTAL_CAP_BYTES.`,
      );
    }
    if (await isBinaryFile(abs)) {
      throw new GlmError("INVALID_INPUT", `attached file ${rel} is binary; refusing to send.`);
    }
    const { content } = await readFileCapped(abs, caps.perFile);
    files.push({ path: rel, content });
    bytesUsed += size;
  }

  return { prompt, files };
}
