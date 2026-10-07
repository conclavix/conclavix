import { describe, expect, it } from 'vitest';
import { assertSafeConnectionUrl, privateAddressesFor } from '../src/modules/connections/net.js';

describe('connection network rules', () => {
  it('refuses private addresses at run time unless the connection allows them', async () => {
    await expect(privateAddressesFor(new URL('http://127.0.0.1:1/'), false)).rejects.toThrow(
      /private/,
    );
    await expect(privateAddressesFor(new URL('http://127.0.0.1:1/'), true)).resolves.toEqual([
      '127.0.0.1',
    ]);
  });

  it('accepts public https URLs and refuses the rest without the owner flag', () => {
    expect(assertSafeConnectionUrl('https://mcp.example.com/mcp', false).hostname).toBe(
      'mcp.example.com',
    );
    for (const url of ['http://mcp.example.com/', 'https://10.0.0.1/', 'https://nas.local/']) {
      expect(() => assertSafeConnectionUrl(url, false), url).toThrow();
    }
    expect(() => assertSafeConnectionUrl('https://u:p@mcp.example.com/', true)).toThrow();
    expect(assertSafeConnectionUrl('http://10.0.0.1/mcp', true).protocol).toBe('http:');
  });
});
