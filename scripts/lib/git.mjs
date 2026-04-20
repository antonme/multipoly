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
  const out = await git(
    ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`],
    cwd,
  );
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * Unified diff text for base...HEAD.
 */
export async function getDiffText(base, cwd) {
  return git(["diff", `${base}...HEAD`], cwd);
}

/**
 * Returns a Set of repo-relative paths that are binary in the given diff.
 * Per git-diff, binary files appear with "-\t-\t<path>" in --numstat output.
 */
export async function getBinaryPathsInDiff(base, cwd) {
  const out = await git(["diff", "--numstat", `${base}...HEAD`], cwd);
  const binaries = new Set();
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    if (parts.length >= 3 && parts[0] === "-" && parts[1] === "-") {
      binaries.add(parts.slice(2).join("\t"));
    }
  }
  return binaries;
}
