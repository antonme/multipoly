import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gatherReview, gatherConsult } from "../scripts/lib/gather.mjs";

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
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "glm-gather-")));
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(path.join(repo, "a.txt"), "original\n");
  await writeFile(path.join(repo, "huge.txt"), "x".repeat(2000));
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base");
  const baseSha = (await git(repo, "rev-parse", "HEAD")).stdout.trim();

  await writeFile(path.join(repo, "a.txt"), "updated\n");
  await writeFile(path.join(repo, "b.txt"), "new content\n");
  await writeFile(path.join(repo, "huge.txt"), "x".repeat(5000));
  await writeFile(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 0]));
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "changes");
  return { repo, baseSha };
}

const defaultCaps = { perFile: 1024, total: 10000, fileCount: 10 };

test("gather: review diff mode classifies files by caps", async () => {
  const { repo, baseSha } = await makeRepo();
  const g = await gatherReview({
    diffBase: baseSha,
    cwd: repo,
    caps: defaultCaps,
  });
  assert.equal(g.mode, "diff");
  assert.ok(g.diffText.length > 0);

  const byPath = Object.fromEntries(g.files.map((f) => [f.path, f]));
  assert.equal(byPath["a.txt"].status, "inlined");
  assert.equal(byPath["b.txt"].status, "inlined");
  // huge.txt is 5000 bytes > perFile 1024 → omitted
  assert.equal(byPath["huge.txt"].status, "omitted");
  // blob.bin is binary (numstat -\t-) → listed_only
  assert.equal(byPath["blob.bin"].status, "listed_only");
  assert.equal(g.truncated, true);
});

test("gather: review file-count cap", async () => {
  const { repo, baseSha } = await makeRepo();
  const g = await gatherReview({
    diffBase: baseSha,
    cwd: repo,
    caps: { ...defaultCaps, fileCount: 1 },
  });
  const inlined = g.files.filter((f) => f.status === "inlined");
  assert.equal(inlined.length, 1);
  const listed = g.files.filter((f) => f.status === "listed_only");
  assert.ok(listed.length >= 1);
});

test("gather: review total cap triggers listed_only", async () => {
  const { repo, baseSha } = await makeRepo();
  // total cap only allows first small file
  const g = await gatherReview({
    diffBase: baseSha,
    cwd: repo,
    caps: { perFile: 1024, total: 10, fileCount: 10 },
  });
  const inlined = g.files.filter((f) => f.status === "inlined");
  assert.equal(inlined.length, 1);
});

test("gather: review rejects both diff_base and paths missing", async () => {
  await assert.rejects(
    () => gatherReview({ cwd: process.cwd(), caps: defaultCaps }),
    (e) => e.code === "INVALID_INPUT",
  );
});

test("gather: review rejects both diff_base and paths set", async () => {
  await assert.rejects(
    () =>
      gatherReview({
        diffBase: "HEAD",
        paths: ["foo"],
        cwd: process.cwd(),
        caps: defaultCaps,
      }),
    (e) => e.code === "INVALID_INPUT",
  );
});

test("gather: consult attaches files, rejects oversize", async () => {
  const tmp = await realpath(await mkdtemp(path.join(tmpdir(), "glm-gather-consult-")));
  await writeFile(path.join(tmp, "small.txt"), "hi");
  const g = await gatherConsult({
    prompt: "what?",
    paths: ["small.txt"],
    cwd: tmp,
    caps: defaultCaps,
  });
  assert.equal(g.files.length, 1);
  assert.equal(g.files[0].content, "hi");

  await writeFile(path.join(tmp, "big.txt"), "y".repeat(2000));
  await assert.rejects(
    () =>
      gatherConsult({
        prompt: "q",
        paths: ["big.txt"],
        cwd: tmp,
        caps: { ...defaultCaps, perFile: 100 },
      }),
    (e) => e.code === "INVALID_INPUT",
  );
});

test("gather: consult rejects empty prompt", async () => {
  await assert.rejects(
    () => gatherConsult({ prompt: "   ", cwd: process.cwd(), caps: defaultCaps }),
    (e) => e.code === "INVALID_INPUT",
  );
});

test("gather: diff mode only inlines files under caps — diff text never mentions omitted paths", async () => {
  const { repo, baseSha } = await makeRepo();
  const g = await gatherReview({
    diffBase: baseSha,
    cwd: repo,
    caps: defaultCaps,
  });
  // huge.txt is omitted; its content should not appear in diffText (it's scoped).
  assert.ok(!g.diffText.includes("huge.txt"), "diff text leaked omitted file name");
  // And inlined files ARE present.
  assert.ok(g.diffText.includes("a.txt"));
});

test("gather: diff-mode symlink that escapes repo is listed_only, not inlined", async () => {
  const { repo, baseSha } = await makeRepo();
  // Create a target outside the repo
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "glm-outside-")));
  await writeFile(path.join(outside, "secret.txt"), "leak");
  // Add a symlink inside the repo pointing outside, commit it
  await symlink(path.join(outside, "secret.txt"), path.join(repo, "link.txt"));
  await execFileP("git", ["add", "link.txt"], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  await execFileP("git", ["commit", "-q", "-m", "add symlink"], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  const g = await gatherReview({ diffBase: baseSha, cwd: repo, caps: defaultCaps });
  const link = g.files.find((f) => f.path === "link.txt");
  assert.ok(link, "link.txt not classified");
  assert.equal(link.status, "listed_only");
  assert.ok(!g.diffText.includes("leak"), "diff text leaked contents of symlink target");
});
