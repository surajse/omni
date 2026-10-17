// Secret scrubbing: redact credential-looking assignments before text is
// persisted to transcripts, memory exports, or logs.
//
// Matches, case-insensitively:
//   - JSON style:  "api_key": "sk-..."   "password": "..."
//   - env/ini style: API_KEY=sk-...   token: abc123
//   - Authorization headers: Bearer <token>
// The value is always fully replaced with [REDACTED]; keys are preserved so
// the redaction itself stays auditable.
//
// NOTE on construction: the alternation MUST live inside a non-capturing
// group with the surrounding quotes OUTSIDE it — "(?:a|b)", never ("a|b"),
// because | splits everything inside its own group.
const SECRET_KEYS =
  'api[_-]?key|apikey|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|secret|password|passwd';

const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // JSON: "key": "value" (quoted value). Keys are matched exactly inside the
  // quotes to avoid false positives like "my_password_hint".
  { re: new RegExp('("(?:' + SECRET_KEYS + ')"\\s*:\\s*)"[^"]*"', 'gi'), replacement: '$1"[REDACTED]"' },
  // JSON: "key": value (unquoted value: numbers, booleans, bare tokens)
  { re: new RegExp('("(?:' + SECRET_KEYS + ')"\\s*:\\s*)([^",\\s}\\]]+)', 'gi'), replacement: '$1[REDACTED]' },
  // env/ini: [PREFIX_]KEY=value or KEY: value. A word-char prefix is allowed
  // (OPENAI_API_KEY, DB_PASSWD) but a : or = must follow the key itself.
  {
    re: new RegExp('([A-Za-z0-9_-]*?(?:' + SECRET_KEYS + '))(\\s*[:=]\\s*)([^\\s"\';,}]+)', 'gi'),
    replacement: '$1$2[REDACTED]',
  },
  // Authorization: Bearer <token>
  { re: /\b(Bearer\s+)([A-Za-z0-9\-._~+/=]+)/g, replacement: '$1[REDACTED]' },
];

/** Replace credential-looking values in `text` with `[REDACTED]`. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const { re, replacement } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return out;
}

const SECRET_KEY_RE = new RegExp('^[A-Za-z0-9_-]*?(?:' + SECRET_KEYS + ')$', 'i');

/**
 * True when `key` itself looks like a credential name (`api_key`,
 * `OPENAI_API_KEY`, `token`, `passwd`, ...). Used to redact the *value* of
 * key/value entries (e.g. memory exports) where the secret lives in the value
 * field rather than next to a secret-looking key in text.
 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}
