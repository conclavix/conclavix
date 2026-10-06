/** A credential format that is recognised without knowing the secret value. */
export interface SecretPattern {
  label: string;
  regex: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const placeholder = (label: string): string => `[redacted:${label}]`;

const whole = (label: string) => (): string => placeholder(label);

const SECRET_WORDS = new Set([
  'token',
  'secret',
  'secrets',
  'password',
  'pass',
  'passwd',
  'pwd',
  'passphrase',
  'apikey',
  'auth',
  'credential',
  'credentials',
  'privatekey',
  'accesskey',
  'secretkey',
  'clientsecret',
]);

const NOT_A_VALUE = new Set(['error', 'exception', 'warning', 'count', 'length', 'type']);

const SECRET_JOINED = /(apikey|privatekey|accesskey|secretkey|clientsecret|authtoken|accesstoken)/;

/** True when an identifier such as DB_PASSWORD, apiKey or x-litellm-api-key names a secret. */
export function isSecretKeyName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (NOT_A_VALUE.has(words.at(-1) ?? '')) {
    return false;
  }
  if (words.some((word) => SECRET_WORDS.has(word))) {
    return true;
  }
  return SECRET_JOINED.test(words.join(''));
}

const TRIVIAL_VALUE =
  /^(null|nil|none|true|false|undefined|bearer|basic|token|required|optional|string|await|new|this|async|function|self)$/i;

const MEMBER_EXPRESSION = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;

/** Values that are clearly not a secret: empty, booleans, references to other variables. */
function isTrivialValue(value: string): boolean {
  return (
    value.length < 4 ||
    TRIVIAL_VALUE.test(value) ||
    value.startsWith('[redacted') ||
    /^(\$\{|\$[A-Z_]|<|\*{3}|process\.env|env\.|os\.environ)/.test(value) ||
    /[()]/.test(value) ||
    MEMBER_EXPRESSION.test(value)
  );
}

function redactAssignment(
  match: string,
  key: string,
  quote: string | undefined,
  quoted: string | undefined,
  bare: string | undefined,
): string {
  const value = quoted ?? bare ?? '';
  if (!isSecretKeyName(key) || isTrivialValue(value)) {
    return match;
  }
  const head = match.slice(0, match.length - (quote ? quote.length * 2 : 0) - value.length);
  const masked = placeholder('secret');
  return quote ? `${head}${quote}${masked}${quote}` : `${head}${masked}`;
}

const TOKEN_CHARS = '[A-Za-z0-9._~+/=-]';

/** Ordered: structural formats first, then prefixed tokens, then generic key/value assignments. */
export const SECRET_PATTERNS: SecretPattern[] = [
  {
    label: 'private-key',
    regex:
      /-----BEGIN[A-Z0-9 ]{0,40}PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END[A-Z0-9 ]{0,40}PRIVATE KEY( BLOCK)?-----|$)/g,
    replace: whole('private-key'),
  },
  {
    label: 'url-password',
    regex: /\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s:@/?#'"]+):([^\s@/?#'"]+)@/gi,
    replace: (_match, scheme = '', user = '') => `${scheme}${user}:${placeholder('password')}@`,
  },
  {
    label: 'authorization',
    regex:
      /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+)([^\s"',;]+)/gi,
    replace: (_match, head = '') => `${head}${placeholder('authorization')}`,
  },
  {
    label: 'bearer',
    regex: new RegExp(
      `\\b(Bearer\\s+)((?=${TOKEN_CHARS}*[0-9._~+/=-])${TOKEN_CHARS}{8,})(?![A-Za-z0-9._~+/=-])`,
      'g',
    ),
    replace: (_match, head = '') => `${head}${placeholder('bearer')}`,
  },
  {
    label: 'anthropic-key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
    replace: whole('anthropic-key'),
  },
  {
    label: 'openai-key',
    regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    replace: whole('openai-key'),
  },
  {
    label: 'github-token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/g,
    replace: whole('github-token'),
  },
  {
    label: 'aws-access-key',
    regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g,
    replace: whole('aws-access-key'),
  },
  {
    label: 'google-api-key',
    regex: /\bAIza[0-9A-Za-z_-]{20,}/g,
    replace: whole('google-api-key'),
  },
  {
    label: 'slack-token',
    regex: /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
    replace: whole('slack-token'),
  },
  {
    label: 'payment-key',
    regex: /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|pdl_[A-Za-z0-9_]{12,})/g,
    replace: whole('payment-key'),
  },
  {
    label: 'run-token',
    regex: /\bcvx_run_[A-Za-z0-9_-]{8,}/g,
    replace: whole('run-token'),
  },
  {
    label: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g,
    replace: whole('jwt'),
  },
  {
    label: 'secret',
    regex:
      /(?<![A-Za-z0-9_])\\?["']?([A-Za-z0-9_.-]{0,40}?(?:token|secret|passw(?:or)?d|pwd|passphrase|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]{0,40})\\?["']?(\s*(?::=|=>|:|=)\s*)(?:(\\?["'])(.*?)\3|([^\s"'`,;&\\}\]]+))/gi,
    replace: (match, key = '', _separator, quote, quoted, bare) =>
      redactAssignment(match, key, quote, quoted, bare),
  },
];

/** Apply every credential pattern to one string. */
export function redactPatterns(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    result = result.replace(pattern.regex, pattern.replace);
  }
  return result;
}
