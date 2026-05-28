/**
 * Secret scanner.
 *
 * Pre-flight regex scan over an outbound payload (diff text, file content, prompt).
 * Returns { hits: [{ pattern, label, line }], clean: boolean }.
 *
 * Matched secret *bytes* are NEVER returned or surfaced. Callers must not echo
 * them to output, logs, or errors. The scanner only reports pattern name + line.
 */

/**
 * Returns true when the captured RHS value is plainly code or a bare URL rather
 * than a hard-coded secret — used as the `suppress` predicate on the two broad
 * assignment patterns so they skip the hit rather than recording it.
 *
 * Intentionally conservative: only well-defined syntactic shapes are suppressed.
 * Anything ambiguous falls through to false (the hit is kept).
 *
 * URL suppression has a deliberate carve-out: a URL whose userinfo holds
 * credentials, or whose path/query/fragment contains a 24+ character opaque run
 * (e.g. a Slack/GitHub webhook secret embedded in the URL), is NOT suppressed —
 * those are real secrets.
 *
 * Camouflage defence: the template / function-call / member-access suppressors
 * only fire when the value does NOT also embed a high-entropy opaque blob (a
 * contiguous 24+ alphanumeric run). A code-shaped *prefix* must not hide a
 * full-length hard-coded secret in the tail — e.g. `${x}<SECRET>`,
 * `makeToken(<SECRET>)`, `process.env.<SECRET>`.
 *
 * Accepted recall boundary (tier-2): these generic heuristics sit BEHIND the
 * dedicated high-precision patterns (sk-, ghp_, AKIA, Slack, PEM). A secret that
 * is BOTH short (<24 contiguous alnum) AND wrapped in a code shape is
 * indistinguishable from legitimate code (e.g. `makeToken(oauth2Client)`), so it
 * is intentionally NOT flagged here — the dedicated patterns still catch any
 * KNOWN format regardless of wrapping, and the scanner is hard-fail by default.
 *
 * @param {string|null|undefined} v — the captured value span (groups.val)
 * @returns {boolean} true ⇒ skip this hit; false ⇒ record it
 */
function embedsOpaqueSecret(s) {
  // A contiguous run of 24+ alphanumeric characters (NO separators) is the
  // signature of a high-entropy opaque secret token. Real identifiers, env-var
  // names (SCREAMING_SNAKE), function names and URL hosts are broken up by
  // separators (_, -, ., /) into shorter runs, so they don't trip this.
  return /[A-Za-z0-9]{24,}/.test(s);
}

function decodePercentEscapesLoose(s) {
  // Decode each %XX escape to its single byte INDEPENDENTLY. decodeURIComponent
  // throws on invalid UTF-8 (e.g. a stray %FF), and a whole-string fall-back to
  // the undecoded tail would let an attacker re-enable the encoding bypass by
  // appending one malformed escape. Per-escape decoding never throws, and only
  // affects opaque-run detection: %XX that maps to an alnum byte joins a run,
  // anything else (incl. malformed/non-ASCII) breaks it — exactly like the raw
  // escape did. The regex guarantees two hex digits, so parseInt is always valid.
  return s.replace(/%[0-9A-Fa-f]{2}/g, (m) => String.fromCharCode(parseInt(m.slice(1), 16)));
}

function looksLikeNonSecretValue(v) {
  if (v == null) return false;
  const s = String(v).trim();
  // A code-shaped prefix must not camouflage a secret embedded in the tail.
  const opaque = embedsOpaqueSecret(s);
  // Template literal (bare or interpolated): `...` or contains ${
  if ((s.startsWith("`") || s.includes("${")) && !opaque) return true;
  // Function call: starts with an identifier followed by (
  if (/^[A-Za-z_$][\w$]*\s*\(/.test(s) && !opaque) return true;
  // Member / index access on well-known runtime objects
  if (/^(req|res|process\.env|value|this|config|ctx|opts|options)\b[.[]/.test(s) && !opaque) return true;
  // URL: suppress plain base URLs, but keep URLs that carry credentials in the
  // userinfo or embed a long opaque token in the path/query/fragment. Parse with
  // the URL API so userinfo (`user:pass@host`) is never mistaken for the host —
  // a naive `https?://[^/]+` strip swallows the password and misses it.
  if (/^https?:\/\//.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch {
      return false; // unparseable URL-ish value — keep flagged (conservative)
    }
    if (u.username || u.password) return false; // embedded credentials are secrets
    // Decode the tail first so percent-encoding can't break up an opaque run
    // (e.g. `abcdEFGH1234ijkl%4dNOP5678qrst` -> `abcd...MNOP...qrst`). Per-escape
    // decoding tolerates malformed escapes so one bad byte can't disable the rest.
    const tail = decodePercentEscapesLoose(u.pathname + u.search + u.hash);
    // 24 chars ≈ minimum Slack/GitHub webhook secret length in a URL path;
    // a longer opaque tail => treat as a secret-bearing URL, not a plain base URL.
    if (/[A-Za-z0-9_\-]{24,}/.test(tail)) return false; // opaque token — keep flagged
    return true; // plain base URL — not a secret
  }
  return false;
}

const PATTERNS = Object.freeze([
  { name: "aws_access_key_id", re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/ },
  {
    name: "aws_secret_access_key",
    re: /aws_secret_access_key\s*=\s*["']?[A-Za-z0-9/+=]{40}["']?/i,
  },
  // Full GitHub token family: classic (ghp_, gho_, ghu_, ghs_, ghr_) and
  // fine-grained (github_pat_). Fine-grained tokens are longer and prefixed.
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "github_fine_grained_token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  // Slack: any `xox<letter>-` token — user (xoxp), bot (xoxb), app (xoxa),
  // refresh (xoxr), config (xoxc) and the sensitive session-cookie token
  // (xoxd), plus future subtypes. `xox[a-z]` keeps coverage broad rather than
  // enumerating a subset that silently misses new prefixes. App-level tokens
  // (xapp) are caught by the dedicated pattern below.
  { name: "slack_token", re: /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/ },
  { name: "slack_app_token", re: /\bxapp-[A-Za-z0-9-]{10,}\b/ },
  {
    name: "pem_private_key",
    re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  },
  // SSH public keys — not a secret by themselves, but pairing is suspicious.
  { name: "ssh_public_key", re: /(?:ssh-(?:rsa|dss|ed25519|ed448)|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/=]{20,}/ },
  // OpenAI / Anthropic / admin API keys: sk-, sk-proj-, sk-ant-, sk-admin-.
  { name: "openai_style_sk_key", re: /\bsk-(?:proj-|ant-|admin-)?[A-Za-z0-9_\-]{20,}\b/ },
  // .env-style unquoted assignment (splits on whitespace so it catches
  // SECRET=rawvalue as well as quoted forms). The identifier quantifiers are
  // bounded ({0,64}) rather than unbounded (*): two adjacent `[A-Z0-9_]*`
  // around the keyword backtrack O(n^2) on a long word-char run (a ReDoS that
  // froze the synchronous scan), whereas a constant bound keeps it linear.
  // 64 chars of prefix/suffix is far beyond any real env-var name.
  //
  // Precision note: /i is intentionally DROPPED here. With /i the pattern matched
  // camelCase identifiers containing keyword substrings (headerToken=, registryKey=).
  // Unquoted assignments in real env files / shell use SCREAMING_CASE; camelCase
  // identifiers with code on the RHS are suppressed further by looksLikeNonSecretValue.
  // Named capture (?<val>...) feeds the suppressor.
  {
    name: "env_style_secret",
    re: /\b[A-Z0-9_]{0,64}(?:API|SECRET|TOKEN|PASSWORD|PASS|KEY)[A-Z0-9_]{0,64}\s*=\s*(?<val>[^\s"']{16,})/,
    suppress: looksLikeNonSecretValue,
  },
  // Quoted assignment — JSON / YAML / TOML / .env with quotes. Bounded for the
  // same ReDoS reason as env_style_secret above.
  //
  // /i is KEPT here so lowercase config keys (apiKey, api_key) with opaque quoted
  // values are still caught. Named capture (?<val>...) feeds the suppressor which
  // drops plain base URLs but keeps webhook URLs with long opaque path segments.
  {
    name: "generic_api_secret_assignment",
    re: /\b[A-Z0-9_]{0,64}(?:API|SECRET|TOKEN|PASSWORD|PASS|KEY)[A-Z0-9_]{0,64}\s*[:=]\s*["'](?<val>[^"']{16,})["']/i,
    suppress: looksLikeNonSecretValue,
  },
]);

function buildNewlineIndex(text) {
  // Sorted positions of '\n' in `text`. Built once per scan so per-hit line
  // lookup is O(log n) instead of O(index): a payload with MANY secret-shaped
  // matches previously made scan() O(n * hits) ~ O(n^2) — a synchronous CPU
  // DoS on attacker-controlled outbound content — because every hit rescanned
  // from offset 0 to compute its line number.
  const offsets = [];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) offsets.push(i);
  }
  return offsets;
}

function lineNumberOf(newlineOffsets, index) {
  // 1-based line = (count of newline offsets strictly before `index`) + 1,
  // found by binary search over the precomputed offsets.
  let lo = 0;
  let hi = newlineOffsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (newlineOffsets[mid] < index) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/**
 * Scan one piece of text.
 * @param {string} text
 * @param {string} label — e.g. "diff", "paths/foo.ts", "prompt"
 * @returns {{hits: Array<{pattern:string,label:string,line:number}>, clean: boolean}}
 */
export function scan(text, label) {
  if (typeof text !== "string" || text.length === 0) {
    return { hits: [], clean: true };
  }
  const hits = [];
  // Built lazily on the first hit so clean payloads (the common case) pay
  // nothing, and a payload with many hits builds it exactly once.
  let newlineOffsets = null;
  for (const { name, re, suppress } of PATTERNS) {
    // Use a global copy to walk all matches without mutating the shared regex.
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = g.exec(text)) !== null) {
      // Suppressor: if this pattern has a `suppress` predicate and the captured
      // value looks like code / a plain URL rather than a hard-coded secret, skip
      // the hit. Advance lastIndex first (zero-length guard) to avoid an infinite
      // loop when the match is zero-width (in practice these patterns have a 16+
      // quantifier so zero-length is impossible, but the guard is cheap insurance).
      if (suppress !== undefined) {
        const val = m.groups != null ? m.groups.val : undefined;
        if (suppress(val)) {
          if (m.index === g.lastIndex) g.lastIndex++;
          continue;
        }
      }
      if (newlineOffsets === null) newlineOffsets = buildNewlineIndex(text);
      hits.push({ pattern: name, label, line: lineNumberOf(newlineOffsets, m.index) });
      if (m.index === g.lastIndex) g.lastIndex++; // zero-length guard
    }
  }
  return { hits, clean: hits.length === 0 };
}

/**
 * Scan multiple labeled pieces. Returns combined result.
 */
export function scanMany(pieces) {
  const allHits = [];
  for (const { text, label } of pieces) {
    const { hits } = scan(text, label);
    // Append element-by-element: `push(...hits)` spreads the array as call
    // arguments and throws RangeError ("Maximum call stack size exceeded") when
    // a single piece yields a very large number of hits (attacker-controlled
    // outbound content). A loop stays linear with no argument-count limit.
    for (const h of hits) allHits.push(h);
  }
  return { hits: allHits, clean: allHits.length === 0 };
}

export { PATTERNS };

/**
 * Format a list of secret hits for an error message. Never includes matched bytes.
 * Deduplicates identical (pattern, label, line) triples to keep the error tight
 * when a regex hits the same line multiple times.
 */
export function formatHitsForError(hits) {
  const seen = new Set();
  const lines = [];
  for (const h of hits) {
    const label = sanitizeHitLabel(h.label);
    const key = `${h.pattern}\0${label}\0${h.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  - ${h.pattern} at ${label}:${h.line}`);
  }
  return lines.join("\n");
}

const HIT_LABEL_MAX = 512;

function sanitizeHitLabel(label) {
  const raw = String(label ?? "");
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    // Output is capped at HIT_LABEL_MAX; stop scanning once we have enough so a
    // pathologically long label can't make sanitization cost scale with its
    // full length. One extra char past the cap is enough to trigger truncation.
    if (out.length > HIT_LABEL_MAX) break;
    const cp = raw.codePointAt(i);
    if (cp === undefined) break;
    if (cp < 0x20 || cp === 0x7f) out += "?";
    else if (cp >= 0xd800 && cp <= 0xdfff) out += "?";
    else out += String.fromCodePoint(cp);
    if (cp >= 0x10000) i++;
  }
  return out.length > HIT_LABEL_MAX ? out.slice(0, HIT_LABEL_MAX) + "..." : out;
}
