import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GlmError } from "./errors.mjs";

const execFileP = promisify(execFile);
const GIT_MAX_BUFFER = 16 * 1024 * 1024; // 16 MiB

async function git(args, cwd) {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (e) {
    throw new GlmError("GIT", `git ${args.join(" ")} failed: ${e.stderr?.toString?.().trim() || e.message}`, { cause: e });
  }
}

export async function isGitRepo(cwd) {
  try {
    await execFileP("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function getToplevel(cwd) {
  const out = await git(["rev-parse", "--show-toplevel"], cwd);
  return out.trim();
}

export async function validateRef(ref, cwd) {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new GlmError("INVALID_INPUT", "diff_base must be a non-empty string");
  }
  // Disallow options/flags disguised as refs
  if (ref.startsWith("-")) {
    throw new GlmError("INVALID_INPUT", `diff_base looks like an option flag: ${JSON.stringify(ref)}`);
  }
  try {
    const out = await execFileP("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd });
    return out.stdout.trim();
  } catch (e) {
    throw new GlmError("GIT", `unknown ref: ${ref}`, { cause: e });
  }
}

/**
 * Files changed between base...HEAD. Filter: Added, Copied, Modified, Renamed (skip Deleted).
 * Returns repo-relative paths.
 */
export async function getChangedFiles(base, cwd) {
  // -z emits NUL-separated paths so filenames containing newlines or tabs
  // survive intact. Without -z, git would C-quote such paths with embedded
  // escapes and our naïve newline split would mangle them.
  const out = await git(
    ["diff", "--no-renames", "-z", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`],
    cwd,
  );
  return out.split("\0").filter((s) => s.length > 0);
}

/**
 * Unified diff text for base...HEAD, optionally scoped to specific paths.
 * Rename detection disabled so numstat/name-only/diff agree on path identity.
 */
export async function getDiffText(base, cwd, paths = null) {
  const args = ["diff", "--no-renames", `${base}...HEAD`];
  if (paths && paths.length > 0) {
    args.push("--");
    args.push(...paths);
  }
  return git(args, cwd);
}

/**
 * Returns a Set of repo-relative paths that are binary in the given diff.
 * Per git-diff, binary files appear with "-\t-\t<path>" in --numstat output.
 * We pass --no-renames so each row has a single path in the third column.
 */
export async function getBinaryPathsInDiff(base, cwd) {
  // --numstat -z emits rows as `added<TAB>deleted<TAB>path\0`. With -z, git
  // does NOT C-quote paths, so a path containing embedded tabs or newlines
  // is delivered literally — splitting on the first two tabs only (limit 3)
  // recovers the full path exactly.
  const out = await git(["diff", "--no-renames", "-z", "--numstat", `${base}...HEAD`], cwd);
  const binaries = new Set();
  for (const row of out.split("\0")) {
    if (!row) continue;
    // Manual two-tab split so a tab in the path doesn't split path parts.
    const t1 = row.indexOf("\t");
    if (t1 < 0) continue;
    const t2 = row.indexOf("\t", t1 + 1);
    if (t2 < 0) continue;
    const added = row.slice(0, t1);
    const deleted = row.slice(t1 + 1, t2);
    const path = row.slice(t2 + 1);
    if (added === "-" && deleted === "-" && path.length > 0) {
      binaries.add(path);
    }
  }
  return binaries;
}
