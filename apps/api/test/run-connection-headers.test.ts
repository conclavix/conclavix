import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { headerReference, knownValues, splitAuthScheme } from '../src/runner/run-connections.js';

const HELPER_ARGS = fileURLToPath(
  new URL('../../../deploy/agent-sandbox/args.mjs', import.meta.url),
);

describe('connection header values', () => {
  it.each([
    ['Bearer abc123', 'Bearer', 'abc123'],
    ['Basic dXNlcjpwYXNz', 'Basic', 'dXNlcjpwYXNz'],
    ['Token abc123', 'Token', 'abc123'],
    ['bearer abc123', 'bearer', 'abc123'],
    ['TOKEN abc123', 'TOKEN', 'abc123'],
    ['Bearer   abc123', 'Bearer', 'abc123'],
    ['Bearer \tabc123', 'Bearer', 'abc123'],
    ['Basic abc def', 'Basic', 'abc def'],
  ])('splits %j into scheme and credential', (value, scheme, credential) => {
    expect(splitAuthScheme(value)).toEqual({ scheme, credential });
  });

  it.each([
    'abc123',
    'Bearer',
    'Bearer ',
    'Bearer   ',
    'Digest abc123',
    'ApiKey abc123',
    'xBearer abc123',
    ' Bearer abc123',
    'Bearer:abc123',
    '',
  ])('keeps %j whole', (value) => {
    expect(splitAuthScheme(value)).toEqual({ scheme: null, credential: value });
  });

  it('writes the scheme into the reference and the credential into the variable', () => {
    expect(headerReference('CONCLAVIX_MCP_HEADER_3', 'Bearer  abc 123')).toEqual({
      reference: 'Bearer ${CONCLAVIX_MCP_HEADER_3}',
      envValue: 'abc 123',
    });
    expect(headerReference('CONCLAVIX_MCP_HEADER_1', 'abc123')).toEqual({
      reference: '${CONCLAVIX_MCP_HEADER_1}',
      envValue: 'abc123',
    });
    expect(headerReference('CONCLAVIX_MCP_HEADER_2', 'Bearer')).toEqual({
      reference: '${CONCLAVIX_MCP_HEADER_2}',
      envValue: 'Bearer',
    });
  });

  it('redacts the whole value and the credential alone', () => {
    expect(knownValues('docs', 'Authorization', 'token abc123').map((k) => k.value)).toEqual([
      'token abc123',
      'abc123',
    ]);
    expect(knownValues('docs', 'X-Key', 'abc123').map((k) => k.value)).toEqual(['abc123']);
  });

  it('produces references the root helper accepts', async () => {
    const helper = (await import(HELPER_ARGS)) as { headerValueValid: (v: unknown) => boolean };
    for (const value of ['Bearer abc', 'basic abc', 'Token a b', 'abc', 'Bearer']) {
      expect(
        helper.headerValueValid(headerReference('CONCLAVIX_MCP_HEADER_32', value).reference),
      ).toBe(true);
    }
  });
});
