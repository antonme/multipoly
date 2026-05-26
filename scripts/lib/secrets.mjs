/**
 * Secret scanner.
 *
 * Pre-flight regex scan over an outbound payload (diff text, file content, prompt).
 * Returns { hits: [{ pattern, label, line }], clean: boolean }.
 *
 * Matched secret *bytes* are NEVER returned or surfaced. Callers must not echo
 * them to output, logs, or errors. The scanner only reports pattern name + line.
 */

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
  // Slack: user tokens (xoxp, xoxb, xoxa, xoxr, xoxs), bot tokens, and
  // app-level tokens (xapp).
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
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
  // SECRET=rawvalue as well as quoted forms).
  {
    name: "env_style_secret",
    re: /\b[A-Z0-9_]*(?:API|SECRET|TOKEN|PASSWORD|PASS|KEY)[A-Z0-9_]*\s*=\s*[^\s"']{16,}/i,
  },
  // Quoted assignment — JSON / YAML / TOML / .env with quotes.
  {
    name: "generic_api_secret_assignment",
    re: /\b[A-Z0-9_]*(?:API|SECRET|TOKEN|PASSWORD|PASS|KEY)[A-Z0-9_]*\s*[:=]\s*["'][^"']{16,}["']/i,
  },
]);

function lineNumberOf(text, index) {
  // 1-based line number of position `index` in `text`.
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
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
  for (const { name, re } of PATTERNS) {
    // Use a global copy to walk all matches without mutating the shared regex.
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = g.exec(text)) !== null) {
      hits.push({ pattern: name, label, line: lineNumberOf(text, m.index) });
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
    allHits.push(...hits);
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
    const key = `${h.pattern}\0${h.label}\0${h.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  - ${h.pattern} at ${h.label}:${h.line}`);
  }
  return lines.join("\n");
}
