import { describe, expect, it } from 'vitest';
import { isSecretKeyName, redactPatterns } from '../src/runner/redact-patterns.js';
import { REDACTION_FAILED, Redactor, redactOrWithhold } from '../src/runner/redact.js';
import { knownSecretsFromEnv } from '../src/runner/secrets.js';

/** Same output format as capText in @conclavix/core. */
const capText = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`;
const join = (...parts: string[]): string => parts.join('');
const FILLER = 'FAKEfakeFAKEfake0123456789abcdef';

const POSITIVES: [string, string, string][] = [
  ['anthropic', join('key ', 'sk-ant-', 'api03-', FILLER), 'anthropic-key'],
  ['openai', join('use ', 'sk-', 'proj-', FILLER), 'openai-key'],
  ['openai legacy', join('use ', 'sk-', FILLER), 'openai-key'],
  ['github classic', join('token ', 'ghp', '_', FILLER), 'github-token'],
  ['github oauth', join('token ', 'gho', '_', FILLER), 'github-token'],
  ['github app', join('token ', 'ghs', '_', FILLER), 'github-token'],
  ['github fine grained', join('token ', 'github', '_pat_', FILLER), 'github-token'],
  ['aws access key', join('id ', 'AKIA', 'IOSFODNN7EXAMPLE'), 'aws-access-key'],
  ['aws session key', join('id ', 'ASIA', 'IOSFODNN7EXAMPLE'), 'aws-access-key'],
  ['google', join('key ', 'AIza', 'SyFAKEfakeFAKEfake0123456789abc'), 'google-api-key'],
  ['slack', join('slack ', 'xoxb', '-123456789-', FILLER), 'slack-token'],
  ['stripe', join('pay ', 'sk_', 'live_', FILLER), 'payment-key'],
  ['paddle', join('pay ', 'pdl_', 'sdbx_apikey_', FILLER), 'payment-key'],
  ['run token', join('run ', 'cvx_', 'run_', FILLER), 'run-token'],
  [
    'jwt',
    join(
      'jwt ',
      'eyJhbGciOiJIUzI1NiJ9',
      '.',
      'eyJzdWIiOiJmYWtlLXVzZXIifQ',
      '.',
      'c2lnbmF0dXJlZmFrZQ',
    ),
    'jwt',
  ],
  [
    'private key',
    join('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIfake\nfake\n-----END ', 'RSA PRIVATE KEY-----'),
    'private-key',
  ],
  ['cut private key', join('-----BEGIN ', 'PRIVATE KEY-----\nMIIfakefake'), 'private-key'],
  ['authorization header', 'Authorization: Bearer abc.DEF-ghi_jkl', 'authorization'],
  ['basic auth header', 'authorization: Basic ZmFrZTpmYWtl', 'authorization'],
  ['bare bearer', 'curl -H "x: Bearer FAKEtoken0123"', 'bearer'],
  ['x-api-key header', 'x-api-key: FAKEapikey0123', 'secret'],
  ['litellm header', 'x-litellm-api-key: Bearer FAKEgateway0123', 'bearer'],
  ['url credentials', 'mongodb://admin:FAKEpass0123@db.local:27017/x', 'password'],
  ['env assignment', 'DB_PASSWORD=FAKEpass0123', 'secret'],
  ['export assignment', 'export STRIPE_SECRET_KEY="FAKE secret with spaces"', 'secret'],
  ['json assignment', '{"client_secret": "FAKEclient0123"}', 'secret'],
  ['escaped json', '{\\"apiKey\\": \\"FAKEapi0123\\"}', 'secret'],
  ['yaml assignment', 'auth_token: FAKEyaml0123', 'secret'],
  ['query string', 'https://x.test/cb?access_token=FAKEquery0123&state=1', 'secret'],
  ['aws secret', 'aws_secret_access_key = FAKEawsSecretValue0123456789', 'secret'],
  ['cli flag', 'mysql --password=FAKEflag0123', 'secret'],
];

const NEGATIVES: [string, string][] = [
  ['uuid', 'run 3f2b8c1e-9d4a-4f6b-8e2a-1c3d5e7f9a0b started'],
  ['git sha', 'commit 9e69bc5d04f186cc28a5067982fff35a0cd8a45d merged'],
  ['short sha', 'see 9e69bc5 and d04f186'],
  ['object id', 'issue 66fd1a2b3c4d5e6f7a8b9c0d updated'],
  [
    'base64 image',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ],
  ['prose', 'The token is valid. Authentication passed; the password policy was updated.'],
  ['bearer prose', 'Bearer authentication is described in RFC 6750.'],
  ['token counts', '{"input_tokens": 1200, "output_tokens": 300, "max_tokens": 4096}'],
  ['nulls', '{"tokenHash": null, "secret": "", "password": true}'],
  ['references', 'API_KEY=${API_KEY} token = process.env.TOKEN password: <your password>'],
  ['code', 'const token = await getToken(); const auth = this.auth;'],
  ['author', '{"author": "Alice", "authority": "board"}'],
  ['task ids', 'task-0123456789abcdefghij and desk-0123456789abcdefghij'],
  ['plain url', 'https://github.com/conclavix/conclavix/pull/28'],
  ['email', 'mail alice@example.com about it'],
  [
    'error names',
    'MissingSecretError: secret CEO is not configured; TokenExpiredError: jwt expired',
  ],
];

describe('credential patterns', () => {
  it.each(POSITIVES)('redacts %s', (_name, input, label) => {
    const output = redactPatterns(input);
    expect(output).toContain(`[redacted:${label}]`);
    expect(output).not.toMatch(/FAKE|fake/);
  });

  it.each(NEGATIVES)('keeps %s', (_name, input) => {
    expect(redactPatterns(input)).toBe(input);
  });

  it('keeps the key and the user, only the value goes', () => {
    expect(redactPatterns('DB_PASSWORD=FAKEpass0123 NEXT=1')).toBe(
      'DB_PASSWORD=[redacted:secret] NEXT=1',
    );
    expect(redactPatterns('{"password": "FAKEpass0123"}')).toBe(
      '{"password": "[redacted:secret]"}',
    );
    expect(redactPatterns('redis://cvx:FAKEpass0123@r:6379')).toBe(
      'redis://cvx:[redacted:password]@r:6379',
    );
  });

  it('recognises secret key names', () => {
    for (const name of [
      'DB_PASSWORD',
      'apiKey',
      'x-litellm-api-key',
      'clientSecret',
      'AUTH',
      'SMTP_PASS',
    ]) {
      expect(isSecretKeyName(name)).toBe(true);
    }
    for (const name of [
      'author',
      'input_tokens',
      'keyboard',
      'monkey',
      'data',
      'Authorization',
      'passenger',
    ]) {
      expect(isSecretKeyName(name)).toBe(false);
    }
  });

  it('is idempotent', () => {
    for (const [, input] of POSITIVES) {
      const once = redactPatterns(input);
      expect(redactPatterns(once)).toBe(once);
    }
  });
});

describe('known values', () => {
  const secret = 'FAKE-known-secret-value-0123456789';
  const redactor = new Redactor([
    { name: 'CVX_SECRET_CEO', value: secret },
    { name: 'SHORT', value: 'abc12' },
  ]);

  it('replaces exact matches with the secret name', () => {
    expect(redactor.text(`x ${secret} y ${secret}`)).toBe(
      'x [redacted:CVX_SECRET_CEO] y [redacted:CVX_SECRET_CEO]',
    );
  });

  it('ignores values that are too short to match safely', () => {
    expect(redactor.text('abc12 stays')).toBe('abc12 stays');
  });

  it('catches URL- and base64-encoded values at any offset', () => {
    const special = new Redactor([{ name: 'S', value: 'FAKE pass/word+0123' }]);
    expect(special.text(`u=${encodeURIComponent('FAKE pass/word+0123')}`)).toBe('u=[redacted:S]');
    for (const prefix of ['', 'a', 'ab']) {
      const blob = Buffer.from(`${prefix}FAKE pass/word+0123 tail`).toString('base64');
      expect(special.text(blob)).toContain('[redacted:S]');
      const url = Buffer.from(`${prefix}FAKE pass/word+0123 tail`).toString('base64url');
      expect(special.text(url)).toContain('[redacted:S]');
    }
  });

  it('redacts partial values only at explicitly marked boundaries', () => {
    const prefix = secret.slice(0, 12);
    const suffix = secret.slice(-12);
    expect(redactor.text(`before ${prefix}`, { end: true })).toBe(
      'before [redacted:CVX_SECRET_CEO]',
    );
    expect(redactor.text(`${suffix} rest`, { start: true })).toBe('[redacted:CVX_SECRET_CEO] rest');
    expect(redactor.text(`${suffix} middle ${prefix}`, { start: true, end: true })).toBe(
      '[redacted:CVX_SECRET_CEO] middle [redacted:CVX_SECRET_CEO]',
    );
    expect(redactor.text(`${suffix} rest`, { end: true })).toBe(`${suffix} rest`);
    expect(redactor.text(`before ${prefix}`, { start: true })).toBe(`before ${prefix}`);
  });

  it('preserves ordinary partial matches, even next to marker-like text', () => {
    const ordinary = new Redactor([{ name: 'DB_PASSWORD', value: 'postgres1' }]);
    for (const text of [
      'ostgres1 is a value',
      'value postgres',
      'postgres...',
      `${'p'.repeat(4000)} postgres...`,
    ]) {
      expect(ordinary.text(text)).toBe(text);
      expect(ordinary.deep({ text })).toEqual({ text });
    }
  });

  it('redacts a value cut by a truncation marker without the caller marking the edge', () => {
    const cut = capText(`${'x'.repeat(90)}${secret}`, 100);
    expect(cut).toMatch(/\n\[truncated \d+ chars\]$/);
    const output = redactor.deep({ data: { kind: 'tool_result', content: cut } });
    expect(output.data.content).toBe(`${'x'.repeat(90)}[redacted:CVX_SECRET_CEO]${cut.slice(100)}`);
    expect(JSON.stringify(output)).not.toContain(secret.slice(0, 8));
    const ordinary = new Redactor([{ name: 'DB_PASSWORD', value: 'postgres1' }]);
    expect(ordinary.text('postgres\n[truncated 1 chars]')).toBe(
      '[redacted:DB_PASSWORD]\n[truncated 1 chars]',
    );
  });

  it('redacts a value cut by the old recorder cap in stored text', () => {
    const legacy = `${'x'.repeat(3990)}${secret}`.slice(0, 4000) + '...';
    expect(legacy).toHaveLength(4003);
    const output = redactor.deep({ text: legacy });
    expect(output.text).toBe(`${'x'.repeat(3990)}[redacted:CVX_SECRET_CEO]...`);
  });

  it('redacts a value with a quote, a backslash and a control character in JSON-encoded tool input', () => {
    const tricky = 'FAKE"quo\\te\u0001ctl-0123456789';
    const json = new Redactor([{ name: 'CVX_SECRET_JSON', value: tricky }]);
    const input = { command: `curl -H "x-key: ${tricky}" https://example.test` };
    const event = {
      type: 'tool_use',
      text: `Bash ${JSON.stringify(input)}`,
      data: { kind: 'tool_use', name: 'Bash', input: JSON.stringify(input, null, 2) },
    };
    const escaped = JSON.stringify(tricky).slice(1, -1);
    expect(event.text).toContain(escaped);
    const output = json.deep(event);
    const stored = JSON.stringify(output);
    expect(output.text).toContain('[redacted:CVX_SECRET_JSON]');
    expect(output.data.input).toContain('[redacted:CVX_SECRET_JSON]');
    for (const fragment of [tricky, escaped, 'quo\\te', 'FAKE\\"quo']) {
      expect(stored).not.toContain(fragment);
    }
    const cut = capText(`${'x'.repeat(90)}${escaped}`, 100);
    expect(json.text(cut)).toBe(`${'x'.repeat(90)}[redacted:CVX_SECRET_JSON]${cut.slice(100)}`);
  });

  it('walks nested data and leaves non-plain values alone', () => {
    const at = new Date(0);
    const input = {
      text: secret,
      at,
      data: { kind: 'tool_result', items: [{ content: `env\nKEY=${secret}` }, 3, null] },
    };
    const output = redactor.deep(input);
    expect(output.at).toBe(at);
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(output.data.items[0]).toEqual({ content: 'env\nKEY=[redacted:CVX_SECRET_CEO]' });
    expect(output.data.items.slice(1)).toEqual([3, null]);
  });

  it('extends a redactor with more values', () => {
    const more = redactor.with([{ name: 'RUN_TOKEN', value: 'FAKE-run-token-0123' }]);
    expect(more.text(`${secret} FAKE-run-token-0123`)).toBe(
      '[redacted:CVX_SECRET_CEO] [redacted:RUN_TOKEN]',
    );
  });

  it('withholds the value when redaction throws', () => {
    const broken = new Redactor();
    broken.text = () => {
      throw new Error(`cannot handle ${secret}`);
    };
    const errors: unknown[] = [];
    expect(redactOrWithhold(broken, secret, (error) => errors.push(error))).toBe(REDACTION_FAILED);
    expect(errors).toHaveLength(1);
  });
});

describe('knownSecretsFromEnv', () => {
  it('collects secret variables, header values and URL passwords', () => {
    const found = knownSecretsFromEnv({
      CVX_SECRET_CEO: 'FAKE-ceo-0123',
      BOARD_TOKEN: 'FAKE-board-token-0123',
      HINDSIGHT_API_KEY: 'FAKE-hindsight-0123',
      SMTP_PASS: 'FAKE-smtp-pass-0123',
      PASSENGER_COUNT: 'ordinary-passenger-value',
      AWS_ACCESS_KEY_ID: 'synthetic-access-id-0123',
      SERVICE_ACCESS_KEY_VALUE: 'synthetic-access-value-0123',
      SERVICE_KEY_ID: 'synthetic-key-id-0123',
      KEYBOARD: 'ordinary-keyboard-value',
      CLAUDE_CODE_OAUTH_TOKEN: 'FAKE-oauth-0123',
      ANTHROPIC_CUSTOM_HEADERS: 'x-litellm-api-key: Bearer FAKE-gateway-0123',
      MONGO_URI: 'mongodb://cvx:FAKE%2Fmongo0123@db:27017/x',
      HOME: '/home/cvx-agent',
      LANG: 'C.UTF-8',
      XAUTHORITY: '/run/user/1000/xauth',
    });
    const values = found.map((secret) => secret.value);
    expect(values).toEqual(
      expect.arrayContaining([
        'FAKE-ceo-0123',
        'FAKE-board-token-0123',
        'FAKE-hindsight-0123',
        'FAKE-smtp-pass-0123',
        'synthetic-access-id-0123',
        'synthetic-access-value-0123',
        'synthetic-key-id-0123',
        'FAKE-oauth-0123',
        'FAKE-gateway-0123',
        'FAKE/mongo0123',
      ]),
    );
    const redactor = new Redactor(found);
    for (const value of [
      'synthetic-access-id-0123',
      'synthetic-access-value-0123',
      'synthetic-key-id-0123',
    ]) {
      expect(redactor.text(`value ${value}`)).not.toContain(value);
    }
    expect(values).not.toContain('ordinary-keyboard-value');
    expect(values).not.toContain('ordinary-passenger-value');
    expect(values).not.toContain('/home/cvx-agent');
    expect(values).not.toContain('/run/user/1000/xauth');
  });
});
