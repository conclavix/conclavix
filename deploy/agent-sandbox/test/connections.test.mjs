import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { partitionAddresses } from '../agent-run.mjs';
import { parseRunArgs } from '../args.mjs';
import { mergeConfig } from '../config.mjs';
import { managedSettings, SECRET_ENV, unitProperties } from '../policy.mjs';

const MCP = JSON.stringify({
  mcpServers: {
    conclavix: {
      type: 'http',
      url: 'http://127.0.0.1:3300/mcp',
      headers: { Authorization: 'Bearer ${CONCLAVIX_RUN_BEARER}' },
    },
    docs: {
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: '${CONCLAVIX_MCP_HEADER_1}' },
    },
  },
});

const run = (extra = []) =>
  parseRunArgs([
    'run',
    '--run-id',
    'a'.repeat(24),
    '--project',
    'b'.repeat(24),
    '--issue',
    'CVX-3',
    '--status-tag',
    'c'.repeat(32),
    ...extra,
    '--',
    '-p',
    '--strict-mcp-config',
    '--mcp-config',
    MCP,
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'user',
  ]);

const ids = { agent: { uid: 999, gid: 987 }, owner: { uid: 995, gid: 986 }, codeGid: 990 };

describe('connection MCP servers in the sandbox', () => {
  it('allows the tools of every server in the run config, nothing else', () => {
    const settings = managedSettings(mergeConfig({}), run());
    const rules = settings.permissions.allow.filter((rule) => rule.startsWith('mcp__'));
    assert.deepEqual(rules, ['mcp__conclavix', 'mcp__docs']);
  });

  it('hides every header variable from Bash and the wrapper accepts exactly those', () => {
    const script = readFileSync(new URL('../agent-exec.sh', import.meta.url), 'utf8');
    const allowed = new RegExp(/^readonly allowed='([^']+)'$/m.exec(script)[1]);
    for (let index = 1; index <= 32; index += 1) {
      const name = `CONCLAVIX_MCP_HEADER_${index}`;
      assert.ok(SECRET_ENV.includes(name), name);
      assert.ok(allowed.test(name), name);
    }
    assert.ok(!allowed.test('CONCLAVIX_MCP_HEADER_33'));
    assert.ok(!allowed.test('CONCLAVIX_MCP_HEADER_0'));
  });

  it('keeps only addresses inside mcpAllowedAddresses and opens them with IPAddressAllow', () => {
    const { kept, refused } = partitionAddresses(
      ['192.168.10.5', '10.1.2.3', 'fd00::5'],
      ['192.168.10.0/24', 'fd00::/8'],
    );
    assert.deepEqual(kept, ['192.168.10.5', 'fd00::5']);
    assert.deepEqual(refused, ['10.1.2.3']);
    assert.deepEqual(partitionAddresses(['192.168.10.5'], []).kept, []);

    const options = run(['--allow-address', '192.168.10.5']);
    options.allowAddresses = kept;
    const properties = unitProperties(mergeConfig({}), options, ids);
    assert.ok(properties.includes('IPAddressAllow=192.168.10.5 fd00::5'));
    const without = unitProperties(mergeConfig({}), run(), ids);
    assert.ok(!without.some((property) => property.startsWith('IPAddressAllow=')));
  });

  it('validates the configured private ranges', () => {
    assert.deepEqual(mergeConfig({ mcpAllowedAddresses: ['192.168.0.0/16'] }).mcpAllowedAddresses, [
      '192.168.0.0/16',
    ]);
    for (const bad of [['192.168.0.0'], ['192.168.0.0/33'], ['host/24'], 'x']) {
      assert.throws(() => mergeConfig({ mcpAllowedAddresses: bad }), /mcpAllowedAddresses/);
    }
  });

  it('refuses a malformed --allow-address', () => {
    assert.throws(() => run(['--allow-address', 'example.com']), /allow-address/);
  });
});
