import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, scanMany, formatHitsForError } from "../scripts/lib/secrets.mjs";

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

test("secrets: formatted hit labels cannot inject extra lines", () => {
  const out = formatHitsForError([{ pattern: "aws_access_key_id", label: "evil\n- injected", line: 7 }]);
  assert.equal(out.split("\n").length, 1);
  assert.match(out, /evil\?- injected:7/);
});

test("secrets: short values don't match generic pattern", () => {
  const r = scan('API_KEY = "short"', "cfg");
  assert.equal(r.clean, true);
});

test("secrets: detects a prefixed env-style name with a long value", () => {
  // The keyword (KEY) appears as a substring of a longer identifier. This must
  // still be caught after bounding the identifier quantifiers for the ReDoS fix.
  const r = scan("MY_SERVICE_API_KEY=abcdefghij0123456789", "cfg");
  assert.equal(r.clean, false);
  assert.equal(r.hits[0].pattern, "env_style_secret");
});

test("secrets: scanning a payload with many matches is bounded (no per-hit line-number DoS)", () => {
  // Distinct from the regex-backtracking ReDoS: every hit recomputed its line
  // number by rescanning from offset 0, so a payload with MANY secret-shaped
  // matches was O(n*hits) ~ O(n^2). ~336KB / 16000 hits took ~2.7s on a dev
  // box, freezing the synchronous scanner. With a precomputed line index it is
  // ~linear. 24000 hits keeps the pre-fix cost well above the threshold while
  // the fixed cost stays orders of magnitude below it.
  const lines = [];
  for (let i = 0; i < 24000; i++) lines.push("AKIA" + String(i).padStart(16, "A"));
  const payload = lines.join("\n");
  const t0 = process.hrtime.bigint();
  const r = scan(payload, "many");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.clean, false);
  assert.equal(r.hits.length, 24000);
  assert.equal(r.hits[1].line, 2); // line numbers still correct
  assert.ok(ms < 1000, `scan took ${ms.toFixed(0)}ms; expected < 1000ms (per-hit line-number DoS)`);
});

test("secrets: scanning a long word-char run is bounded (no ReDoS)", () => {
  // A long single-line run of KEY-like tokens used to trigger O(n^2)
  // backtracking in the env/assignment patterns (~17s at 300KB on a dev box),
  // freezing the synchronous scan and the whole event loop. After bounding the
  // identifier quantifiers it is linear (~1-2ms). The threshold sits ~1000x
  // above the fixed cost and ~8x below the pre-fix cost, so it is robust to
  // machine variance in both directions. There is no 16+ char value after the
  // trailing '=', so the correct result is "clean" — only the timing changed.
  const pathological = "KEY_".repeat(75000) + "="; // ~300KB, no newlines
  const t0 = process.hrtime.bigint();
  const r = scan(pathological, "huge");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.clean, true);
  assert.ok(ms < 2000, `scan took ${ms.toFixed(0)}ms; expected < 2000ms (ReDoS regression)`);
});
