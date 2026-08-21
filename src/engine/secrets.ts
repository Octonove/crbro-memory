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

  // WordPress application password: six groups of four. Requires at least one
  // digit and one letter per group, otherwise ordinary prose matches it —
  // "ough them with offs" does, and that is not a credential.
  {
    kind: 'WordPress application password',
    re: /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{4}(?: (?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{4}){5}\b/g,
  },

  // A password stated as such. Needs the label, so "the password policy is
  // strict" does not trip it.
  {
    kind: 'password',
    re: /\b(?:password|passwd|contrase[nñ]a|clave)\s*(?:es|is)?\s*[:=]\s*["'`]?([^\s"'`,;]{8,})/gi,
  },
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

  // Right to left, so earlier offsets stay valid.
  let out = text;
  const found: string[] = [];
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    out = out.slice(0, h.index) + `[REDACTED: ${h.kind}]` + out.slice(h.index + h.length);
    found.unshift(h.kind);
  }
  return { text: out, found };
}

/** Just the kinds present, for auditing without touching the values. */
export function secretKinds(text: string): string[] {
  return [...new Set(findSecrets(text).map(h => h.kind))];
}
