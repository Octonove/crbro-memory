// ─── CRBRO Secret Detection ──────────────────────────────────────
//
// A memory stores whatever the assistant hands it, and assistants handle
// credentials all day. On the brain this was built against, five were sitting
// in the cortex — a cloud API key, a password in plain text, three WordPress
// application passwords — and all five were inside the search index too, so a
// recall could hand them straight back. Nothing in the tool surface could
// remove them: no tool deleted anything.
//
// Precision over recall, deliberately. A false positive corrupts real
// knowledge by redacting it, and the user may never notice. So these patterns
// only match shapes that are credentials and essentially nothing else.

export interface SecretHit {
  kind: string;
  /** Where it starts, so the caller can redact without ever logging the value. */
  index: number;
  length: number;
}

interface Pattern {
  kind: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  // Vendor-prefixed tokens: the prefix makes these unambiguous.
  { kind: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'OpenAI key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'Google API key', re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { kind: 'Supabase token', re: /\bsbp_[a-f0-9]{40,}\b/g },
  { kind: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'Stripe key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },

  // WordPress application password: six groups of four, anchored to the label.
  //
  // The first attempt required a digit AND a letter inside every one of the six
  // groups, to stop ordinary prose from matching. That is 0.505^6 of random
  // groups — about 1.6% — and it caught 0 of the 3 real ones sitting in the
  // reference brain, because real passwords contain all-letter and all-digit
  // groups. Anchoring to the words that always accompany them gives 3 of 3 and
  // no false positives: prose does not say "application password" and then
  // produce six quads.
  {
    kind: 'WordPress application password',
    re: /\b(?:application|app)[ _-]?password\b[^\n]{0,80}?\b([A-Za-z0-9]{4}(?: [A-Za-z0-9]{4}){5})\b/gi,
  },

  // A password stated as such. Needs the label, so "the password policy is
  // strict" does not trip it. Two forms: label + separator (:/=), and label +
  // copula ("la contraseña es X", "the password is X") with no separator,
  // requiring the value to mix classes so plain words do not match.
  {
    kind: 'password',
    re: /\b(?:password|passwd|contrase[nñ]a|clave)\s*(?:es|is)?\s*[:=]\s*["'`]?([^\s"'`,;]{8,})/gi,
  },
  {
    // The value must mix a letter AND a digit — that is what separates a
    // password from emphatic prose. It used to accept !/@/* as "the digit
    // class", so "la clave es importante!" redacted a sentence. Only a real
    // digit qualifies now.
    kind: 'password (prose)',
    re: /\b(?:password|passwd|contrase[nñ]a|clave)\b\s+(?:es|is)\s+["'`]?((?=[^\s"'`,;]*[A-Za-z])(?=[^\s"'`,;]*[0-9])[^\s"'`,;]{8,})/gi,
  },

  // Connection strings that carry the credentials inline. The scheme + "://" +
  // "user:pass@host" shape is unambiguous — no prose produces it.
  {
    kind: 'connection string credentials',
    re: /\b[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi,
  },

  // Generic KEY/TOKEN/SECRET = long opaque value. Anchored to the assignment
  // label; the value must be long and token-shaped, which ordinary config
  // values (paths, numbers, words) are not.
  {
    // The value must be long AND mix a letter with a digit — a real token,
    // not a filesystem path or a prose placeholder. It used to include "/" in
    // the value class, so `secret: /etc/ssl/private/servers/keystore` (a path
    // to where a key lives, not a key) was redacted. No leading slash, and the
    // letter+digit requirement drops all-alpha placeholders too.
    kind: 'generic API key/secret',
    re: /\b(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|secret|token)\s*[:=]\s*["'`]?(?!\/)((?=[A-Za-z0-9_\-+]*[A-Za-z])(?=[A-Za-z0-9_\-+]*[0-9])[A-Za-z0-9_\-+]{24,})/gi,
  },

  // SendGrid: SG. + two base64 chunks.
  { kind: 'SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },

  // GitHub fine-grained PAT: github_pat_ + long body.
  { kind: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
];

/** Find credentials in a piece of text. Never returns the values themselves. */
export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // For the labelled-password pattern, redact only the value, not the label.
      const value = m[1] !== undefined ? m[1] : m[0];
      const at = m[1] !== undefined ? m.index + m[0].indexOf(m[1]) : m.index;
      hits.push({ kind, index: at, length: value.length });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * Replace every credential with a marker naming what it was.
 * The surrounding sentence survives, so the knowledge is kept and only the
 * secret is gone: "the token is [REDACTED: npm token]" still tells you a token
 * exists and what kind.
 */
export function redact(text: string): { text: string; found: string[] } {
  const hits = findSecrets(text);
  if (hits.length === 0) return { text, found: [] };

  // Left to right with a cursor over ORIGINAL offsets, skipping any hit that
  // overlaps a span already redacted. Two patterns can match the same span —
  // "generic API key/secret" and a vendor pattern both fire on "la clave es
  // AIza...". The old right-to-left pass then applied the second hit's stale
  // index/length to an already-shortened string and swallowed the legitimate
  // prose after it. On a tie of index, the longer span wins.
  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  let out = '';
  let cursor = 0;
  const found: string[] = [];
  for (const h of hits) {
    if (h.index < cursor) continue;   // overlaps a span already redacted
    out += text.slice(cursor, h.index) + `[REDACTED: ${h.kind}]`;
    found.push(h.kind);
    cursor = h.index + h.length;
  }
  out += text.slice(cursor);
  return { text: out, found };
}

/** Just the kinds present, for auditing without touching the values. */
export function secretKinds(text: string): string[] {
  return [...new Set(findSecrets(text).map(h => h.kind))];
}
