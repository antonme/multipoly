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

test("secrets: scanMany handles a piece with a very large hit count without overflowing the call stack", () => {
  // scanMany used `allHits.push(...hits)`, spreading the hits array as call
  // arguments. A piece producing ~150k matches blew the argument limit with
  // `RangeError: Maximum call stack size exceeded` — a DoS on attacker-
  // controlled outbound content. Appending without spreading keeps it linear.
  const N = 150000;
  const lines = new Array(N);
  for (let i = 0; i < N; i++) lines[i] = "AKIA" + String(i).padStart(16, "A");
  const text = lines.join("\n");
  const r = scanMany([{ text, label: "huge" }]);
  assert.equal(r.clean, false);
  assert.equal(r.hits.length, N);
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

// --- Precision tests (Task 1 / Plan D3 §3a) ---

test("secrets: false-positives: camelCase identifier RHS should be clean", () => {
  // headerToken= is a camelCase identifier — the old /i flag made it match KEY.
  // After dropping /i on the unquoted pattern it should be clean.
  const r = scan("const headerToken = req.headers.authorization?.split(' ')[1];", "t");
  assert.equal(r.clean, true, "headerToken= should not be flagged");
});

test("secrets: false-positives: template-literal RHS should be clean", () => {
  // registryKey=`${...}` — template literal on the RHS is code, not a secret.
  const r = scan("const registryKey = `${organizationId}::${kind}`;", "t");
  assert.equal(r.clean, true, "registryKey=`${...}` should not be flagged");
});

test("secrets: false-positives: function-call RHS should be clean", () => {
  // key = stringValue(value.key) — function call on the RHS is code, not a secret.
  const r = scan("const key = stringValue(value.key);", "t");
  assert.equal(r.clean, true, "key=functionCall() should not be flagged");
});

test("secrets: false-positives: plain URL RHS should be clean", () => {
  // GITHUB_API_BASE = 'https://api.github.com' — plain base URL, no opaque tail.
  const r = scan("const GITHUB_API_BASE = 'https://api.github.com';", "t");
  assert.equal(r.clean, true, "plain URL RHS should not be flagged");
});

test("secrets: false-positives: template-literal URL with token interpolation should be clean", () => {
  // `${base}?token=${encodeURIComponent(x)}` — the token value is interpolated,
  // not hard-coded; the raw string has no 16+ char opaque segment.
  const r = scan("const u = `${base}?token=${encodeURIComponent(x)}`;", "t");
  assert.equal(r.clean, true, "`${base}?token=${...}` should not be flagged");
});

test("secrets: true-positives: SCREAMING_CASE unquoted opaque value flagged", () => {
  // API_KEY=<opaque> — unquoted, SCREAMING_CASE identifier, must be caught.
  const r = scan("API_KEY=abcdEFGH1234ijklMNOP5678qrst", "t");
  assert.equal(r.clean, false, "API_KEY=<opaque> must be flagged");
});

test("secrets: true-positives: quoted opaque value flagged", () => {
  // FOO_API_KEY = "..." — quoted opaque value, must be caught.
  const r = scan('FOO_API_KEY = "abcdEFGH1234ijklMNOP5678"', "t");
  assert.equal(r.clean, false, 'FOO_API_KEY = "<opaque>" must be flagged');
});

test("secrets: true-positives: lowercase key with quoted opaque value flagged (quoted /i kept)", () => {
  // apiKey: "..." — lowercase key, but quoted pattern keeps /i, must be caught.
  const r = scan('apiKey: "abcdEFGH1234ijklMNOP5678qrst"', "t");
  assert.equal(r.clean, false, 'apiKey: "<opaque>" must be flagged');
});

test("secrets: true-positives: sk- key detected by dedicated pattern (unchanged)", () => {
  const r = scan("sk-abcdEFGH1234ijklMNOP5678", "t");
  assert.equal(r.clean, false, "sk- key must be flagged");
});

test("secrets: true-positives: webhook URL with long opaque tail must stay flagged", () => {
  // A URL with a 24+ char opaque path segment is a secret (e.g. Slack/GitHub webhook).
  // The plain-URL suppressor must NOT drop this because of the long opaque tail.
  // Variable name contains TOKEN so the quoted pattern fires; then the suppressor
  // sees afterHost has a 28-char opaque segment and returns false => hit is kept.
  const r = scan('WEBHOOK_TOKEN = "https://hooks.example.com/services/T00/B00/abcdEFGH1234ijklMNOP5678qrst"', "t");
  assert.equal(r.clean, false, "webhook URL with opaque tail must be flagged");
});

// Fix D: document the known, spec-accepted recall boundary for unquoted lowercase keys
test("scanner: KNOWN GAP — unquoted lowercase key is not flagged (SCREAMING_CASE only); quoted form still caught", () => {
  // The unquoted pattern intentionally drops /i (SCREAMING_CASE only) to avoid
  // camelCase false-positives. An unquoted lowercase key with an opaque value
  // is therefore NOT flagged — this is an accepted tradeoff.
  const unquoted = "apikey=abcdEFGH1234ijklMNOP5678qrst";
  assert.equal(scan(unquoted, "t").clean, true, "unquoted lowercase key must NOT be flagged (known gap, SCREAMING_CASE only)");

  // The quoted pattern retains /i, so the same secret in quoted form IS caught.
  const quoted = 'apikey: "abcdEFGH1234ijklMNOP5678qrst"';
  assert.equal(scan(quoted, "t").clean, false, "quoted lowercase key MUST be flagged (quoted pattern keeps /i)");
});

// --- Scanner hardening: code-shaped camouflage must not hide embedded secrets (codex D3 review) ---

test("secrets: camouflage — template-interpolation prefix in front of an opaque secret must be flagged", () => {
  // ${prefix} makes the value look like a template literal, but it embeds a
  // 28-char contiguous opaque blob — a real hard-coded secret. The suppressor
  // must NOT drop it just because it starts with code-shaped interpolation.
  const r = scan('API_KEY="${prefix}abcdEFGH1234ijklMNOP5678qrst"', "t");
  assert.equal(r.clean, false, "template-prefixed opaque secret must be flagged");
});

test("secrets: camouflage — function-call wrapper around an opaque secret must be flagged", () => {
  // makeToken(<SECRET>) looks like a function call, but the argument is a real
  // 28-char opaque secret. Must NOT be suppressed.
  const r = scan('API_KEY="makeToken(abcdEFGH1234ijklMNOP5678qrst)"', "t");
  assert.equal(r.clean, false, "func-call-wrapped opaque secret must be flagged");
});

test("secrets: camouflage — member-access prefix in front of an opaque secret must be flagged", () => {
  // process.env.<SECRET> looks like a runtime reference, but the tail is a
  // contiguous opaque blob, not a SCREAMING_SNAKE env-var name. Must be flagged.
  const r = scan('API_KEY="process.env.abcdEFGH1234ijklMNOP5678qrst"', "t");
  assert.equal(r.clean, false, "member-ref-prefixed opaque secret must be flagged");
});

test("secrets: URL userinfo credentials must be flagged (not swallowed as host)", () => {
  // The opaque password lives in the userinfo, BEFORE the host. The old
  // [^/]+ host-strip treated `user:pass@host` as the 'host' and missed it.
  const r = scan('API_URL="https://user:abcdEFGH1234ijklMNOP5678qrst@example.com/path"', "t");
  assert.equal(r.clean, false, "URL userinfo password must be flagged");
});

test("secrets: legit env-var reference in a secret assignment stays clean (no false positive)", () => {
  // process.env.SCREAMING_SNAKE is a legitimate runtime reference, not a
  // hard-coded secret: underscore-separated names have no 24-char opaque run,
  // so the member-ref suppressor still drops it.
  const r = scan("API_KEY = process.env.MY_SERVICE_API_KEY_NAME", "t");
  assert.equal(r.clean, true, "process.env.<NAME> reference must stay clean");
});

test("secrets: URL with a percent-encoded opaque token in the path must be flagged", () => {
  // %4d decodes to 'M'; the RAW path breaks the 24-run (abcdEFGH1234ijkl / NOP5678qrst),
  // but the DECODED path reassembles the 28-char opaque webhook secret. The tail
  // check must decode before testing so encoding can't be used to evade it.
  const r = scan('WEBHOOK_TOKEN = "https://hooks.example.com/services/abcdEFGH1234ijkl%4dNOP5678qrst"', "t");
  assert.equal(r.clean, false, "percent-encoded opaque URL token must be flagged");
});

test("secrets: a trailing malformed percent-escape must not re-enable the encoded URL bypass", () => {
  // %FF is invalid UTF-8 and makes decodeURIComponent throw. A whole-string
  // fall-back to the raw tail would let `%4d` stay encoded and revive the bypass.
  // Per-escape decoding must still reassemble the opaque run from `%4d` -> M.
  const r = scan('WEBHOOK_TOKEN = "https://hooks.example.com/services/abcdEFGH1234ijkl%4dNOP5678qrst%FF"', "t");
  assert.equal(r.clean, false, "malformed trailing escape must not disable decoding of the rest");
});

test("scanner: KNOWN GAP — code-shaped camouflage with a short/separator-broken tail is not flagged (tier-2 boundary)", () => {
  // The generic assignment heuristics are a tier-2 best-effort catch-all that
  // sits BEHIND the dedicated high-precision patterns (sk-, ghp_, AKIA, Slack,
  // PEM). They suppress code-shaped RHS values to avoid false positives on real
  // code. A secret that is BOTH short (<24 contiguous alnum) AND hidden behind a
  // code-shaped prefix is indistinguishable from legitimate code such as
  // `makeToken(oauth2Client)` or `process.env.SOME_NAME`, so it is an accepted
  // recall boundary. A FULL-length (24+) opaque secret behind a prefix IS caught
  // (see the camouflage tests above).
  const shortTail = 'API_KEY="makeToken(abcdEFGH1234ijkl)"'; // 16-char opaque tail
  assert.equal(scan(shortTail, "t").clean, true, "short code-wrapped tail: accepted gap");

  // Compensating control: the dedicated patterns still catch KNOWN secret
  // formats regardless of any code wrapper, because they carry no suppressor.
  const knownFmt = 'API_KEY="makeToken(sk-abcdEFGH1234ijklMNOP)"';
  assert.equal(scan(knownFmt, "t").clean, false, "known sk- format caught despite code wrapper");
});

// --- End scanner-hardening tests ---

// --- End precision tests ---

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
