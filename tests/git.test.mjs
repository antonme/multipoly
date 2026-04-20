import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isGitRepo,
  getToplevel,
  validateRef,
  getChangedFiles,
  getDiffText,
  getBinaryPathsInDiff,
} from "../scripts/lib/git.mjs";

const execFileP = promisify(execFile);

async function git(cwd, ...args) {
  return execFileP("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

async function makeRepo() {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "glm-git-")));
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(path.join(repo, "a.txt"), "original\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base");
  const baseSha = (await git(repo, "rev-parse", "HEAD")).stdout.trim();

  await writeFile(path.join(repo, "a.txt"), "updated\n");
  await writeFile(path.join(repo, "new.txt"), "new\n");
  // binary-ish file
  await writeFile(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 0]));
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "changes");

  return { repo, baseSha };
}

test("git: isGitRepo true inside repo, false outside", async () => {
  const { repo } = await makeRepo();
  assert.equal(await isGitRepo(repo), true);
  const outside = await mkdtemp(path.join(tmpdir(), "glm-notgit-"));
  assert.equal(await isGitRepo(outside), false);
});

test("git: getToplevel returns root", async () => {
  const { repo } = await makeRepo();
  const top = await getToplevel(repo);
  assert.equal(await realpath(top), repo);
});

test("git: validateRef accepts HEAD and unknown ref rejected", async () => {
  const { repo } = await makeRepo();
  const sha = await validateRef("HEAD", repo);
  assert.match(sha, /^[0-9a-f]{40}$/);
  await assert.rejects(
    () => validateRef("does-not-exist", repo),
    (e) => e.code === "GIT",
  );
});

test("git: validateRef rejects leading dash", async () => {
  const { repo } = await makeRepo();
  await assert.rejects(
    () => validateRef("-oops", repo),
    (e) => e.code === "INVALID_INPUT",
  );
});

test("git: getChangedFiles returns modified and new files", async () => {
  const { repo, baseSha } = await makeRepo();
  const files = await getChangedFiles(baseSha, repo);
  const set = new Set(files);
  assert.ok(set.has("a.txt"));
  assert.ok(set.has("new.txt"));
  assert.ok(set.has("blob.bin"));
});

test("git: getDiffText contains a marker from the diff", async () => {
  const { repo, baseSha } = await makeRepo();
  const diff = await getDiffText(baseSha, repo);
  assert.ok(diff.includes("a.txt"));
  assert.ok(diff.includes("updated"));
});

test("git: getBinaryPathsInDiff flags the blob", async () => {
  const { repo, baseSha } = await makeRepo();
  const bin = await getBinaryPathsInDiff(baseSha, repo);
  assert.ok(bin.has("blob.bin"));
  assert.ok(!bin.has("a.txt"));
});
