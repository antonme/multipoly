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
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { prepareReview, runPreparedReview } from "../scripts/lib/model-review.mjs";
import { prepareConsult, runPreparedConsult } from "../scripts/lib/model-consult.mjs";
import { handleCouncilReview, handleCouncilConsult } from "../scripts/lib/council.mjs";
import { runModel } from "../scripts/lib/run-model.mjs";

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
  model: "glm-5.2",
  models: {
    glm: {
      configured: true,
      key: "glm",
      displayName: "GLM",
      baseUrl: "https://glm.test/v1",
      apiKey: "k",
      model: "glm-5.2",
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

    // After Task 8: capability-dispatched fields replace the raw reasoningEffort key.
    // GLM (GLM_TOGGLE capability) + effort="low" → thinking:{type:"enabled"}.
    // The junk body.reasoningEffort passthrough from Task 7 must be gone.
    assert.ok(fetchImpl.calls.length >= 1, "at least one fetch call expected");
    const body = fetchImpl.calls[0].body;
    assert.deepEqual(body.thinking, { type: "enabled" },
      "GLM + low effort → thinking:enabled dispatched onto body");
    assert.equal("reasoningEffort" in body, false,
      "raw reasoningEffort key must not appear in the HTTP body after Task 8");
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
    // After Task 8: "inherit" falls through to the model baseline (GLM "high").
    // GLM (GLM_TOGGLE) + high → thinking:{type:"enabled"}.
    // The raw reasoningEffort key must NOT appear in the HTTP body.
    assert.deepEqual(body.thinking, { type: "enabled" },
      "GLM baseline high → thinking:enabled when per-call is inherit");
    assert.equal("reasoningEffort" in body, false,
      "raw reasoningEffort key must not appear in the HTTP body after Task 8");
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

    // After Task 8: GLM (GLM_TOGGLE) + xhigh → thinking:{type:"enabled"}.
    assert.ok(fetchImpl.calls.length >= 1);
    const body = fetchImpl.calls[0].body;
    assert.deepEqual(body.thinking, { type: "enabled" },
      "GLM + xhigh effort → thinking:enabled dispatched onto body");
    assert.equal("reasoningEffort" in body, false,
      "raw reasoningEffort key must not appear in the HTTP body after Task 8");
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

    // After Task 8: per-call effort="low" is capability-dispatched.
    // GLM (GLM_TOGGLE) + low → thinking:{type:"enabled"} on body root.
    assert.deepEqual(bodiesByModel.glm[0].thinking, { type: "enabled" },
      "glm transport should receive thinking:enabled for low effort (GLM_TOGGLE)");
    // Composer (NONE capability) receives no reasoning fields.
    assert.equal(bodiesByModel.composer[0].thinking, undefined,
      "composer (NONE) should receive no thinking field");
    // Neither should have the raw reasoningEffort passthrough key.
    assert.equal("reasoningEffort" in bodiesByModel.glm[0], false);
    assert.equal("reasoningEffort" in bodiesByModel.composer[0], false);
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

    // After Task 8: GLM (GLM_TOGGLE) + low → thinking:enabled.
    assert.deepEqual(bodiesByModel.glm[0].thinking, { type: "enabled" },
      "glm transport should receive thinking:enabled for low effort (GLM_TOGGLE)");
    // Composer (NONE) receives no reasoning fields.
    assert.equal(bodiesByModel.composer[0].thinking, undefined,
      "composer (NONE) should receive no thinking field");
    assert.equal("reasoningEffort" in bodiesByModel.glm[0], false);
    assert.equal("reasoningEffort" in bodiesByModel.composer[0], false);
  } finally {
    process.chdir(prev);
  }
});

// ---------------------------------------------------------------------------
// Anthropic transport boundary: per-call reasoningEffort lands in request body
// ---------------------------------------------------------------------------

// Anthropic SSE events for a minimal successful response.
const anthropicBasicEvents = [
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
];

// Build a fetchImpl that records the parsed request body and returns a
// minimal Anthropic-style SSE stream so the call completes.
function makeAnthropicSpyFetch(events) {
  const enc2 = new TextEncoder();
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const frames = events.map((e) => enc2.encode(`data: ${JSON.stringify(e)}\n\n`));
    let i = 0;
    const stream = new ReadableStream({
      pull(c) {
        if (i < frames.length) c.enqueue(frames[i++]);
        else c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  fn.calls = calls;
  return fn;
}

// Build a minimal anthropic-transport config.
function anthropicTransportConfig(overrides = {}) {
  return {
    models: {
      ant: {
        key: "ant",
        displayName: "Claude",
        transport: "anthropic",
        configured: true,
        model: "claude-opus-4-7",
        baseUrl: "https://api.anthropic.test",
        apiKey: "sk-ant-test",
        anthropicVersion: "2023-06-01",
        supportsThinking: false,
        reasoningEffort: overrides.reasoningEffort ?? "medium",
        maxTokens: { review: undefined, consult: undefined },
      },
    },
    thinking: "off",
    timeoutMs: 5000,
    progress: "off",
  };
}

test("effort-threading(anthropic): camelCase reasoningEffort key is NEVER on the outbound body (Task-7 temp seam removed)", async () => {
  // UPDATED (Task 9): the Task-7 temporary `baseBody.reasoningEffort = reasoningEffort`
  // passthrough is removed. The camelCase key must NEVER appear on the wire body.
  // For a NONE-capability model, the per-call effort is accepted but produces no body fields.
  const { CAPABILITY } = await import("../scripts/lib/reasoning.mjs");
  const fetchImpl = makeAnthropicSpyFetch(anthropicBasicEvents);
  await runModel({
    config: anthropicTransportConfig(),
    modelKey: "ant",
    messages: [{ role: "user", content: "hi" }],
    mode: "consult",
    reasoningEffort: "low",
    fetchImpl,
  });
  assert.ok(fetchImpl.calls.length >= 1, "at least one fetch call expected");
  assert.equal(
    fetchImpl.calls[0].body.reasoningEffort,
    undefined,
    "camelCase reasoningEffort must never appear on outbound body (Task-7 temp seam removed in Task 9)",
  );
});

test("effort-threading(anthropic): omitting per-call reasoningEffort does not add field to body", async () => {
  const fetchImpl = makeAnthropicSpyFetch(anthropicBasicEvents);
  await runModel({
    config: anthropicTransportConfig(),
    modelKey: "ant",
    messages: [{ role: "user", content: "hi" }],
    mode: "consult",
    // reasoningEffort deliberately omitted
    fetchImpl,
  });
  assert.ok(fetchImpl.calls.length >= 1);
  assert.equal(
    fetchImpl.calls[0].body.reasoningEffort,
    undefined,
    "anthropic transport must not add reasoningEffort when not provided",
  );
});

// ---------------------------------------------------------------------------
// CLI transport boundary: per-call reasoningEffort resolves and lands in argv
// ---------------------------------------------------------------------------

// Minimal codex cli config with an optional model baseline.
function codexConfig(overrides = {}) {
  return {
    models: {
      cx: {
        key: "cx",
        displayName: "Codex",
        transport: "cli",
        cliKind: "codex",
        binary: null,
        model: "codex-model",
        authTokenEnv: null,
        cwdMode: "repo",
        unsafe: false,
        reasoningEffort: overrides.reasoningEffort ?? "medium", // model baseline
        timeoutMs: null,
        configured: true,
        supportsThinking: false,
        maxTokens: { review: undefined, consult: undefined },
      },
    },
    timeoutMs: 5000,
  };
}


test("effort-threading(cli): per-call reasoningEffort='low' overrides model baseline in codex argv", async () => {
  const cap = [];
  const execFileImpl = (file, args, opts) => {
    cap.push({ file, args, opts });
    const i = args.indexOf("--output-last-message");
    if (i >= 0 && args[i + 1]) writeFileSync(args[i + 1], "codex answer");
    return "";
  };
  await runModel({
    config: codexConfig({ reasoningEffort: "high" }), // model baseline is "high"
    modelKey: "cx",
    messages: [{ role: "user", content: "hi" }],
    mode: "consult",
    reasoningEffort: "low", // per-call override
    execFileImpl,
    env: {},
  });
  assert.ok(cap.length >= 1, "codex was spawned");
  const { args } = cap[0];
  // The resolved effort ("low") must appear in the -c flag, not the baseline ("high").
  assert.ok(
    args.some((a) => /model_reasoning_effort="low"/.test(a)),
    `expected model_reasoning_effort="low" in argv, got: ${JSON.stringify(args)}`,
  );
  assert.equal(
    args.some((a) => /model_reasoning_effort="high"/.test(a)),
    false,
    "model baseline 'high' must not appear when per-call override is 'low'",
  );
});

test("effort-threading(cli): omitting per-call reasoningEffort falls back to model baseline in codex argv", async () => {
  const cap = [];
  const execFileImpl = (file, args, opts) => {
    cap.push({ file, args, opts });
    const i = args.indexOf("--output-last-message");
    if (i >= 0 && args[i + 1]) writeFileSync(args[i + 1], "codex answer");
    return "";
  };
  await runModel({
    config: codexConfig({ reasoningEffort: "high" }), // model baseline is "high"
    modelKey: "cx",
    messages: [{ role: "user", content: "hi" }],
    mode: "consult",
    // reasoningEffort deliberately omitted → should fall back to model "high"
    execFileImpl,
    env: {},
  });
  assert.ok(cap.length >= 1, "codex was spawned");
  const { args } = cap[0];
  assert.ok(
    args.some((a) => /model_reasoning_effort="high"/.test(a)),
    `expected model_reasoning_effort="high" (baseline) in argv, got: ${JSON.stringify(args)}`,
  );
});

test("effort-threading(cli): per-call reasoningEffort='inherit' falls back to model baseline in codex argv", async () => {
  const cap = [];
  const execFileImpl = (file, args, opts) => {
    cap.push({ file, args, opts });
    const i = args.indexOf("--output-last-message");
    if (i >= 0 && args[i + 1]) writeFileSync(args[i + 1], "codex answer");
    return "";
  };
  await runModel({
    config: codexConfig({ reasoningEffort: "medium" }), // model baseline is "medium"
    modelKey: "cx",
    messages: [{ role: "user", content: "hi" }],
    mode: "consult",
    reasoningEffort: "inherit", // explicit inherit → use model baseline
    execFileImpl,
    env: {},
  });
  assert.ok(cap.length >= 1, "codex was spawned");
  const { args } = cap[0];
  assert.ok(
    args.some((a) => /model_reasoning_effort="medium"/.test(a)),
    `expected model_reasoning_effort="medium" (baseline for inherit) in argv, got: ${JSON.stringify(args)}`,
  );
});
