import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, scanMany } from "../scripts/lib/secrets.mjs";

test("secrets: clean text passes", () => {
  const r = scan("just some harmless code\nconst x = 1\n", "foo");
  assert.equal(r.clean, true);
  assert.deepEqual(r.hits, []);
});

test("secrets: AWS access key id detected", () => {
  const r = scan("const key = AKIAABCDEFGHIJKLMNOP", "foo.ts");
  assert.equal(r.clean, false);
  assert.equal(r.hits[0].pattern, "aws_access_key_id");
  assert.equal(r.hits[0].label, "foo.ts");
  assert.equal(r.hits[0].line, 1);
});

test("secrets: GitHub token detected", () => {
  const r = scan("line1\nexport GH=ghp_" + "a".repeat(36), "env");
  assert.equal(r.clean, false);
  assert.equal(r.hits[0].pattern, "github_token");
  assert.equal(r.hits[0].line, 2);
});

test("secrets: Slack token detected", () => {
  const r = scan("token=xoxb-" + "1234567890abcdef", "src");
  assert.equal(r.clean, false);
  assert.equal(r.hits[0].pattern, "slack_token");
});

test("secrets: PEM private key detected", () => {
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nstuff\n-----END-----";
  const r = scan(pem, "id_rsa");
  assert.equal(r.clean, false);
  assert.equal(r.hits[0].pattern, "pem_private_key");
});

test("secrets: openai-style sk- key detected", () => {
  const r = scan("OPENAI=sk-abcd1234567890abcdef1234", "env");
  assert.equal(r.clean, false);
  assert.equal(r.hits[0].pattern, "openai_style_sk_key");
});

test("secrets: generic API_KEY assignment detected", () => {
  const r = scan('API_KEY = "abcd1234efgh5678ijkl"', "cfg");
  assert.equal(r.clean, false);
  assert.equal(r.hits[0].pattern, "generic_api_secret_assignment");
});

test("secrets: scanner never echoes matched bytes", () => {
  const src = "AKIAABCDEFGHIJKLMNOP";
  const r = scan(src, "foo");
  for (const hit of r.hits) {
    // Spot-check fields exist and contain no part of the key
    assert.ok(!JSON.stringify(hit).includes("AKIAABCDEFGHIJKLMNOP"));
  }
});

test("secrets: scanMany aggregates", () => {
  const r = scanMany([
    { text: "clean", label: "a" },
    { text: "AKIAABCDEFGHIJKLMNOP", label: "b" },
  ]);
  assert.equal(r.clean, false);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].label, "b");
});

test("secrets: short values don't match generic pattern", () => {
  const r = scan('API_KEY = "short"', "cfg");
  assert.equal(r.clean, true);
});
