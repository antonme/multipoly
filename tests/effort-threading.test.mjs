/**
 * Task 7 — Thread per-call reasoningEffort through the orchestrators.
 *
 * Test seam: we use a fetchImpl that returns valid SSE responses AND records
 * the `reasoningEffort` field from the request args that streamChatCompletion
 * receives (it is added to the body as an observable extra field in Task 7).
 *
 * For council tests we use the handleCouncilReview / handleCouncilConsult
 * entry points with a fetchImpl that routes by URL and records per-model bodies.
 *
 * For the prepare* functions we test the prepared object directly (pure unit tests).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { prepareReview, runPreparedReview } from "../scripts/lib/model-review.mjs";
import { prepareConsult, runPreparedConsult } from "../scripts/lib/model-consult.mjs";
import { handleCouncilReview, handleCouncilConsult } from "../scripts/lib/council.mjs";

const execFileP = promisify(execFile);
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

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

async function makeRepo(prefix = "multipoly-effort-") {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
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

async function makeSimpleRepo(prefix = "multipoly-effort-consult-") {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(path.join(repo, "a.txt"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base");
  return repo;
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseStream(content) {
  const chunks = [
    `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}\n\n`,
    "data: [DONE]\n\n",
  ].map((s) => enc.encode(s));
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
  });
}

function reviewJson(summary = "ok") {
  return JSON.stringify({
    schema_version: "1",
    findings: [],
    summary_md: summary,
  });
}

// ---------------------------------------------------------------------------
// A fetchImpl that records the bodies it receives, keyed by URL.
// Returns valid SSE so the call completes.
// ---------------------------------------------------------------------------
function makeSpyFetch(responseBody) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    return new Response(sseStream(responseBody), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  fn.calls = calls;
  return fn;
}

// A fetchImpl that dispatches by hostname.
function makeMultiModelFetch(handlers) {
  const calls = { byKey: {} };
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    // find the matching key
    for (const [key, handler] of Object.entries(handlers)) {
      if (url.includes(key)) {
        if (!calls.byKey[key]) calls.byKey[key] = [];
        calls.byKey[key].push({ url, body });
        return handler(url, opts);
      }
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------

const glmConfig = {
  baseUrl: "https://glm.test/v1",
  apiKey: "k",
  model: "glm-5.1",
  models: {
    glm: {
      configured: true,
      key: "glm",
      displayName: "GLM",
      baseUrl: "https://glm.test/v1",
      apiKey: "k",
      model: "glm-5.1",
      reasoningEffort: "high", // baseline effort set on model config
    },
  },
  thinking: "off",
  timeoutMs: 5000,
  maxTokens: { review: 8192, consult: 16384, freeform: 16384 },
  caps: { perFile: 1024 * 1024, total: 2 * 1024 * 1024, fileCount: 50 },
  allowSecrets: false,
  debugReasoning: false,
  progress: "off",
};

const composerConfig = {
  ...glmConfig,
  models: {
    ...glmConfig.models,
    composer: {
      configured: true,
      key: "composer",
      displayName: "Composer",
      baseUrl: "https://composer.test/v1",
      apiKey: "c",
      model: "composer",
      reasoningEffort: undefined, // NONE capability — no reasoning effort
    },
  },
};

// ---------------------------------------------------------------------------
// Unit tests: prepareReview stores reasoningEffort
// ---------------------------------------------------------------------------

test("effort-threading: prepareReview stores reasoning_effort=low on prepared", async () => {
  const { repo, baseSha } = await makeRepo("multipoly-effort-prepare-review-");
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const prepared = await prepareReview(
      { diff_base: baseSha, reasoning_effort: "low" },
      { config: glmConfig, cwd: repo },
    );
    assert.equal(prepared.reasoningEffort, "low");
  } finally {
    process.chdir(prev);
  }
});

test("effort-threading: prepareReview omitting reasoning_effort defaults to 'inherit'", async () => {
  const { repo, baseSha } = await makeRepo("multipoly-effort-prepare-review-inh-");
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const prepared = await prepareReview(
      { diff_base: baseSha },
      { config: glmConfig, cwd: repo },
    );
    assert.equal(prepared.reasoningEffort, "inherit");
  } finally {
    process.chdir(prev);
  }
});

test("effort-threading: prepareConsult stores reasoning_effort=medium on prepared", async () => {
  const repo = await makeSimpleRepo("multipoly-effort-prepare-consult-");
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const prepared = await prepareConsult(
      { prompt: "test question", reasoning_effort: "medium" },
      { config: glmConfig, cwd: repo },
    );
    assert.equal(prepared.reasoningEffort, "medium");
  } finally {
    process.chdir(prev);
  }
});

test("effort-threading: prepareConsult omitting reasoning_effort defaults to 'inherit'", async () => {
  const repo = await makeSimpleRepo("multipoly-effort-prepare-consult-inh-");
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const prepared = await prepareConsult(
      { prompt: "test question" },
      { config: glmConfig, cwd: repo },
    );
    assert.equal(prepared.reasoningEffort, "inherit");
  } finally {
    process.chdir(prev);
  }
});

test("effort-threading: prepareReview normalizes invalid reasoning_effort to throw", async () => {
  const { repo, baseSha } = await makeRepo("multipoly-effort-prepare-review-bad-");
  const prev = process.cwd();
  process.chdir(repo);
  try {
    await assert.rejects(
      () => prepareReview(
        { diff_base: baseSha, reasoning_effort: "turbo" },
        { config: glmConfig, cwd: repo },
      ),
      (e) => e.code === "CONFIG",
    );
  } finally {
    process.chdir(prev);
  }
});

// ---------------------------------------------------------------------------
// Integration: runPreparedReview forwards prepared.reasoningEffort to runModel
// The spy fetchImpl captures that the call completes. The transport boundary
// receives `reasoningEffort` in the request body (streamChatCompletion forwards it).
// ---------------------------------------------------------------------------

test("effort-threading: runPreparedReview forwards reasoningEffort=low to transport", async () => {
  const { repo, baseSha } = await makeRepo("multipoly-effort-run-review-");
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const fetchImpl = makeSpyFetch(reviewJson("ok"));
    const prepared = await prepareReview(
      { diff_base: baseSha, reasoning_effort: "low" },
      { config: glmConfig, cwd: repo },
    );
    assert.equal(prepared.reasoningEffort, "low");

    await runPreparedReview("glm", prepared, { config: glmConfig, fetchImpl });

    // Verify transport received reasoningEffort in the request body
    assert.ok(fetchImpl.calls.length >= 1, "at least one fetch call expected");
    const body = fetchImpl.calls[0].body;
    assert.equal(body.reasoningEffort, "low",
      "streamChatCompletion should forward reasoningEffort to the HTTP body");
  } finally {
    process.chdir(prev);
  }
});

test("effort-threading: runPreparedReview without reasoning_effort → transport receives 'inherit'", async () => {
  const { repo, baseSha } = await makeRepo("multipoly-effort-run-review-inh-");
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const fetchImpl = makeSpyFetch(reviewJson("ok"));
    const prepared = await prepareReview(
      { diff_base: baseSha },
      { config: glmConfig, cwd: repo },
    );
    assert.equal(prepared.reasoningEffort, "inherit");

    await runPreparedReview("glm", prepared, { config: glmConfig, fetchImpl });

    assert.ok(fetchImpl.calls.length >= 1);
    const body = fetchImpl.calls[0].body;
    // "inherit" means fall back to model baseline (handled by transports in Tasks 8-10).
    // The transport boundary receives "inherit" (or undefined) for this case.
    const received = body.reasoningEffort;
    assert.ok(
      received === "inherit" || received === undefined,
      `expected "inherit" or undefined, got ${JSON.stringify(received)}`,
    );
  } finally {
    process.chdir(prev);
  }
});

test("effort-threading: runPreparedConsult forwards reasoningEffort=xhigh to transport", async () => {
  const repo = await makeSimpleRepo("multipoly-effort-run-consult-");
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const fetchImpl = makeSpyFetch("consult answer");
    const prepared = await prepareConsult(
      { prompt: "what now?", reasoning_effort: "xhigh" },
      { config: glmConfig, cwd: repo },
    );
    assert.equal(prepared.reasoningEffort, "xhigh");

    await runPreparedConsult("glm", prepared, { config: glmConfig, fetchImpl });

    assert.ok(fetchImpl.calls.length >= 1);
    const body = fetchImpl.calls[0].body;
    assert.equal(body.reasoningEffort, "xhigh");
  } finally {
    process.chdir(prev);
  }
});

// ---------------------------------------------------------------------------
// Council: per-call effort is forwarded to each member
// ---------------------------------------------------------------------------

test("effort-threading: council review with reasoning_effort=low → each member transport receives 'low'", async () => {
  const { repo } = await makeRepo("multipoly-effort-council-review-");
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const bodiesByModel = { glm: [], composer: [] };
    const fetchImpl = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (url.includes("glm.test")) bodiesByModel.glm.push(body);
      else if (url.includes("composer.test")) bodiesByModel.composer.push(body);
      return new Response(sseStream(reviewJson("ok")), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    await handleCouncilReview(
      { paths: ["a.txt"], models: ["glm", "composer"], reasoning_effort: "low" },
      { config: composerConfig, fetchImpl },
    );

    assert.ok(bodiesByModel.glm.length >= 1, "glm was called");
    assert.ok(bodiesByModel.composer.length >= 1, "composer was called");

    // GLM member should receive reasoningEffort: "low"
    assert.equal(bodiesByModel.glm[0].reasoningEffort, "low",
      "glm transport should receive reasoningEffort='low'");

    // Composer member should also receive reasoningEffort: "low"
    assert.equal(bodiesByModel.composer[0].reasoningEffort, "low",
      "composer transport should receive reasoningEffort='low'");
  } finally {
    process.chdir(prev);
  }
});

test("effort-threading: council consult with reasoning_effort=low → each member transport receives 'low'", async () => {
  const repo = await makeSimpleRepo("multipoly-effort-council-consult-");
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const bodiesByModel = { glm: [], composer: [] };
    const fetchImpl = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (url.includes("glm.test")) bodiesByModel.glm.push(body);
      else if (url.includes("composer.test")) bodiesByModel.composer.push(body);
      return new Response(sseStream("member answer"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    await handleCouncilConsult(
      { prompt: "what now?", models: ["glm", "composer"], reasoning_effort: "low" },
      { config: composerConfig, fetchImpl },
    );

    assert.ok(bodiesByModel.glm.length >= 1, "glm was called");
    assert.ok(bodiesByModel.composer.length >= 1, "composer was called");

    assert.equal(bodiesByModel.glm[0].reasoningEffort, "low",
      "glm transport should receive reasoningEffort='low'");
    assert.equal(bodiesByModel.composer[0].reasoningEffort, "low",
      "composer transport should receive reasoningEffort='low'");
  } finally {
    process.chdir(prev);
  }
});
