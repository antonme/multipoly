import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { handleCouncilConsult } from "../scripts/lib/council.mjs";

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

function stream(content) {
  const body = [
    `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}\n\n`,
    "data: [DONE]\n\n",
  ].map((s) => enc.encode(s));
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < body.length) controller.enqueue(body[i++]);
      else controller.close();
    },
  });
}

const config = {
  models: {
    glm: {
      configured: true,
      key: "glm",
      displayName: "GLM",
      baseUrl: "https://glm.test/v1",
      apiKey: "g",
      model: "glm",
    },
    qwen: {
      configured: true,
      key: "qwen",
      displayName: "Qwen",
      baseUrl: "https://qwen.test/v1",
      apiKey: "q",
      model: "qwen",
    },
    deepseek: {
      configured: true,
      key: "deepseek",
      displayName: "DeepSeek",
      baseUrl: "https://deepseek.test/v1",
      apiKey: "d",
      model: "deepseek",
    },
    composer: {
      configured: true,
      key: "composer",
      displayName: "Composer",
      baseUrl: "https://composer.test/v1",
      apiKey: "c",
      model: "composer",
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

test("council consult: runs members then synthesizer", async () => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "multipoly-council-")));
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(path.join(repo, "a.txt"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base");
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (url.includes("qwen.test") && urls.filter((u) => u.includes("qwen.test")).length === 2) {
        return new Response(stream("synthesis"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(stream(`member:${url}`), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const out = await handleCouncilConsult(
      { prompt: "what now?", models: ["glm", "qwen"], include_individual_results: true },
      { config, fetchImpl },
    );
    assert.match(out.result, /synthesis/);
    assert.match(out.result, /Individual results/);
    assert.equal(urls.length, 3);
  } finally {
    process.chdir(prev);
  }
});
