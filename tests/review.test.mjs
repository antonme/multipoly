import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { handleReview } from "../scripts/lib/review.mjs";

const execFileP = promisify(execFile);
const enc = new TextEncoder();

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
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "glm-review-")));
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(path.join(repo, "a.txt"), "old\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base");
  const baseSha = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(repo, "a.txt"), "new\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "change");
  return { repo, baseSha };
}

function streamOf(strings) {
  const chunks = strings.map((s) => enc.encode(s));
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

function makeFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return new Response(streamOf(body), {
      status,
      headers: { "content-type": "text/event-stream" },
    });
  };
  fn.calls = calls;
  return fn;
}

const baseConfig = {
  baseUrl: "https://api.test/v1",
  apiKey: "k",
  model: "glm-5.1",
  thinking: "mode-default",
  timeoutMs: 5000,
  maxTokens: { review: 8192, consult: 16384, freeform: 16384 },
  caps: { perFile: 1024 * 1024, total: 2 * 1024 * 1024, fileCount: 50 },
  allowSecrets: false,
  debugReasoning: false,
};

test("review: happy path — valid JSON passes on first attempt, server-authoritative files merged", async () => {
  const { repo, baseSha } = await makeRepo();
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const payload = JSON.stringify({
      schema_version: "1",
      findings: [{ severity: "nit", path: "a.txt", message: "fine", line: 1 }],
      summary_md: "ok",
    });
    // Escape for JSON string inside the data line
    const esc = JSON.stringify(payload);
    const body = [
      `data: {"choices":[{"delta":{"content":${esc}}}]}\n\n`,
      "data: [DONE]\n\n",
    ];
    const fetchImpl = makeFetch(body);
    const out = await handleReview(
      { diff_base: baseSha },
      { config: baseConfig, fetchImpl },
    );
    assert.equal(out.result.schema_version, "1");
    assert.deepEqual(
      out.result.findings[0],
      { severity: "nit", path: "a.txt", message: "fine", line: 1 },
    );
    // Server-authoritative: files[] comes from gather, not the model
    assert.ok(Array.isArray(out.result.files));
    assert.ok(out.result.files.some((f) => f.path === "a.txt"));
    // And model's finding keys restricted to schema
    for (const f of out.result.files) assert.ok(!("content" in f));
    // Only one fetch call (no retry)
    assert.equal(fetchImpl.calls.length, 1);
  } finally {
    process.chdir(prev);
  }
});

test("review: invalid JSON triggers retry with correction", async () => {
  const { repo, baseSha } = await makeRepo();
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const validPayload = JSON.stringify({
      schema_version: "1",
      findings: [],
      summary_md: "ok",
    });
    let call = 0;
    const fetchImpl = async () => {
      call++;
      const body =
        call === 1
          ? ['data: {"choices":[{"delta":{"content":"not valid json"}}]}\n\n', "data: [DONE]\n\n"]
          : [
              `data: {"choices":[{"delta":{"content":${JSON.stringify(validPayload)}}}]}\n\n`,
              "data: [DONE]\n\n",
            ];
      return new Response(streamOf(body), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const out = await handleReview(
      { diff_base: baseSha },
      { config: baseConfig, fetchImpl },
    );
    assert.equal(out.result.schema_version, "1");
    assert.equal(call, 2);
  } finally {
    process.chdir(prev);
  }
});

test("review: secret in diff → SECRET error (no model call)", async () => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "glm-review-secret-")));
  const prev = process.cwd();
  process.chdir(repo);
  try {
    await git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(repo, "f.txt"), "clean\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "base");
    const baseSha = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(path.join(repo, "f.txt"), "const k = AKIAABCDEFGHIJKLMNOP\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "oops");

    let called = 0;
    const fetchImpl = async () => {
      called++;
      return new Response(streamOf(["data: [DONE]\n\n"]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    await assert.rejects(
      () => handleReview({ diff_base: baseSha }, { config: baseConfig, fetchImpl }),
      (e) => e.code === "SECRET",
    );
    assert.equal(called, 0, "upstream should not have been called");
  } finally {
    process.chdir(prev);
  }
});

test("review: secret allowed when GLM_ALLOW_SECRETS enabled", async () => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "glm-review-secret-ok-")));
  const prev = process.cwd();
  process.chdir(repo);
  try {
    await git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(repo, "f.txt"), "clean\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "base");
    const baseSha = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(path.join(repo, "f.txt"), "const k = AKIAABCDEFGHIJKLMNOP\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "deliberate");

    const payload = JSON.stringify({
      schema_version: "1",
      findings: [],
      summary_md: "ok",
    });
    const body = [
      `data: {"choices":[{"delta":{"content":${JSON.stringify(payload)}}}]}\n\n`,
      "data: [DONE]\n\n",
    ];
    const fetchImpl = makeFetch(body);
    const out = await handleReview(
      { diff_base: baseSha },
      { config: { ...baseConfig, allowSecrets: true }, fetchImpl },
    );
    assert.equal(out.result.schema_version, "1");
    assert.equal(fetchImpl.calls.length, 1);
  } finally {
    process.chdir(prev);
  }
});
