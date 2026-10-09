import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertWithinLimits,
  parseRunArgs,
  parseTool,
  UsageError,
  validateClaudeArgs,
} from '../args.mjs';
import { DEFAULTS } from '../config.mjs';

const RUN = 'a'.repeat(24);
const PROJECT = 'b'.repeat(24);
const TAG = 'c'.repeat(32);
const CLAUDE = [
  '-p',
  '--strict-mcp-config',
  '--permission-mode',
  'dontAsk',
  '--setting-sources',
  'user',
];
const base = (...extra) => [
  'run',
  '--run-id',
  RUN,
  '--project',
  PROJECT,
  '--issue',
  'CVX-12',
  '--status-tag',
  TAG,
  ...extra,
  '--',
  ...CLAUDE,
];

describe('parseRunArgs', () => {
  it('accepts the required options and fills in default limits', () => {
    const options = parseRunArgs(base());
    assert.equal(options.runId, RUN);
    assert.equal(options.projectId, PROJECT);
    assert.equal(options.issueKey, 'CVX-12');
    assert.equal(options.memoryMaxBytes, 4 * 1024 ** 3);
    assert.equal(options.runtimeMaxSec, 1800);
    assert.deepEqual(options.extraDomains, []);
    assert.deepEqual(options.claudeArgs, CLAUDE);
  });

  it('parses limits, skills and repeated domains', () => {
    const options = parseRunArgs(
      base(
        '--memory-max',
        '512M',
        '--cpu-quota',
        '150',
        '--tasks-max',
        '64',
        '--runtime-max-sec',
        '600',
        '--disk-limit-mb',
        '100',
        '--skills',
        '/srv/conclavix/workspaces/x/CVX/.claude/skills',
        '--allow-domain',
        'registry.yarnpkg.com',
        '--allow-domain',
        '*.example.org',
      ),
    );
    assert.equal(options.memoryMaxBytes, 512 * 1024 ** 2);
    assert.equal(options.cpuQuotaPercent, 150);
    assert.equal(options.diskLimitBytes, 100 * 1024 ** 2);
    assert.deepEqual(options.extraDomains, ['registry.yarnpkg.com', '*.example.org']);
  });

  const refused = {
    'a missing run id': [
      'run',
      '--project',
      PROJECT,
      '--issue',
      'CVX-1',
      '--status-tag',
      TAG,
      '--',
      ...CLAUDE,
    ],
    'an issue key with a path': base('--issue', '../X-1'),
    'a project id with a slash': [
      'run',
      '--run-id',
      RUN,
      '--project',
      '../etc',
      '--issue',
      'CVX-1',
      '--status-tag',
      TAG,
      '--',
      ...CLAUDE,
    ],
    'an unknown option': base('--unit', 'x'),
    'a single option twice': base('--memory-max', '1G', '--memory-max', '2G'),
    'a relative skills path': base('--skills', 'skills'),
    'a skills path with ..': base('--skills', '/srv/x/../etc'),
    'a domain with a scheme': base('--allow-domain', 'https://evil.example'),
    'a domain with a port': base('--allow-domain', 'evil.example:443'),
    'an IP address': base('--allow-domain', '127.0.0.1'),
    'a memory limit in bytes': base('--memory-max', '1000'),
    'a negative quota': base('--cpu-quota', '-5'),
    'a missing separator': base().filter((arg) => arg !== '--'),
    'a short status tag': base('--status-tag', 'abc'),
  };
  for (const [name, argv] of Object.entries(refused)) {
    it(`refuses ${name}`, () => {
      assert.throws(() => parseRunArgs(argv), UsageError);
    });
  }

  it('refuses limits above the configured maxima', () => {
    const options = parseRunArgs(base('--memory-max', '64G'));
    assert.throws(() => assertWithinLimits(options, DEFAULTS.maxLimits), /exceeds/);
    assertWithinLimits(parseRunArgs(base()), DEFAULTS.maxLimits);
  });
});

describe('validateClaudeArgs', () => {
  const mcp = JSON.stringify({
    mcpServers: { conclavix: { type: 'http', url: 'http://127.0.0.1:3300/mcp', headers: {} } },
  });

  it('accepts the flags the runner uses', () => {
    const args = [
      ...CLAUDE,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--mcp-config',
      mcp,
      '--max-budget-usd',
      '2',
      '--tools',
      'Read,Grep,Glob,Skill,Edit,Write,Bash',
      '--disallowedTools',
      'WebFetch WebSearch',
      '--model',
      'opus',
    ];
    assert.deepEqual(validateClaudeArgs(args), args);
  });

  const headerConfig = (value) => [
    '--mcp-config',
    JSON.stringify({
      mcpServers: {
        x: { type: 'http', url: 'https://mcp.example.com/', headers: { Authorization: value } },
      },
    }),
  ];
  const refused = {
    'skipping permissions': ['--dangerously-skip-permissions'],
    'another permission mode': ['--permission-mode', 'bypassPermissions'],
    'project settings': ['--setting-sources', 'user,project'],
    'an extra directory': ['--add-dir', '/'],
    'a settings file': ['--settings', '{}'],
    'a plugin directory': ['--plugin-dir', '/tmp'],
    'an allow rule': ['--allowedTools', 'Bash(*)'],
    'an unknown tool': ['--tools', 'Read,WebFetch'],
    'the board server off loopback': [
      '--mcp-config',
      JSON.stringify({ mcpServers: { conclavix: { type: 'http', url: 'http://10.0.0.1/mcp' } } }),
    ],
    'a stdio MCP server': [
      '--mcp-config',
      JSON.stringify({ mcpServers: { x: { type: 'stdio', command: '/bin/sh' } } }),
    ],
    'a literal header value': [
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          x: {
            type: 'http',
            url: 'https://mcp.example.com/',
            headers: { Authorization: 'Bearer abc' },
          },
        },
      }),
    ],
    ...Object.fromEntries(
      Object.entries({
        'another scheme before a header reference': 'Digest ${CONCLAVIX_MCP_HEADER_1}',
        'two blanks after the scheme': 'Bearer  ${CONCLAVIX_MCP_HEADER_1}',
        'a tab after the scheme': 'Bearer\t${CONCLAVIX_MCP_HEADER_1}',
        'text after a header reference': '${CONCLAVIX_MCP_HEADER_1} x',
        'a literal credential before a header reference': 'Bearer abc ${CONCLAVIX_MCP_HEADER_1}',
        'two header references': 'Bearer ${CONCLAVIX_MCP_HEADER_1}${CONCLAVIX_MCP_HEADER_2}',
        'a scheme without a reference': 'Bearer ',
        'a scheme before another variable': 'Bearer ${CONCLAVIX_RUN_BEARER}',
        'a header reference out of range': 'Bearer ${CONCLAVIX_MCP_HEADER_33}',
      }).map(([name, value]) => [name, headerConfig(value)]),
    ),
    'a header reference to another variable': [
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          x: {
            type: 'http',
            url: 'https://mcp.example.com/',
            headers: { A: '${CONCLAVIX_RUN_BEARER}' },
          },
        },
      }),
    ],
    'a variable reference in a server URL': [
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          x: { type: 'http', url: 'https://x.example.com/?t=${CONCLAVIX_RUN_BEARER}' },
        },
      }),
    ],
    'credentials in a server URL': [
      '--mcp-config',
      JSON.stringify({ mcpServers: { x: { type: 'http', url: 'https://u:p@mcp.example.com/' } } }),
    ],
    'a server name with capitals': [
      '--mcp-config',
      JSON.stringify({ mcpServers: { X: { type: 'http', url: 'https://mcp.example.com/' } } }),
    ],
    'a non-http server URL': [
      '--mcp-config',
      JSON.stringify({ mcpServers: { x: { type: 'http', url: 'file:///etc/passwd' } } }),
    ],
    'a flag without its value': ['--model'],
  };
  for (const [name, extra] of Object.entries(refused)) {
    it(`refuses ${name}`, () => {
      const args = [
        ...CLAUDE.filter((a, i, all) => !extra.includes(a) && !extra.includes(all[i - 1])),
        ...extra,
      ];
      assert.throws(() => validateClaudeArgs(args), UsageError);
    });
  }

  it('accepts connection servers with header references and names them', async () => {
    const { parseRunArgs } = await import('../args.mjs');
    const config = JSON.stringify({
      mcpServers: {
        conclavix: { type: 'http', url: 'http://127.0.0.1:3300/mcp' },
        docs: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: {
            Authorization: 'Bearer ${CONCLAVIX_MCP_HEADER_1}',
            'X-Team': '${CONCLAVIX_MCP_HEADER_32}',
            'X-Basic': 'basic ${CONCLAVIX_MCP_HEADER_2}',
            'X-Token': 'TOKEN ${CONCLAVIX_MCP_HEADER_3}',
          },
        },
        lan: { type: 'http', url: 'http://192.168.10.5:8080/mcp' },
      },
    });
    const args = [
      ...CLAUDE.filter((a, i, all) => a !== '--mcp-config' && all[i - 1] !== '--mcp-config'),
      '--mcp-config',
      config,
    ];
    assert.deepEqual(validateClaudeArgs(args), args);
    const options = parseRunArgs([
      'run',
      '--run-id',
      'a'.repeat(24),
      '--project',
      PROJECT,
      '--issue',
      'CVX-2',
      '--status-tag',
      'b'.repeat(32),
      '--allow-address',
      '192.168.10.5',
      '--',
      ...args,
    ]);
    assert.deepEqual(options.mcpServers, ['conclavix', 'docs', 'lan']);
    assert.deepEqual(options.allowAddresses, ['192.168.10.5']);
  });

  it('requires dontAsk, strict MCP config and the user setting source', () => {
    assert.throws(() => validateClaudeArgs(['-p']), /required/);
    assert.throws(() => validateClaudeArgs([...CLAUDE, '-p']), /twice/);
  });
});

describe('parseReleaseArgs', () => {
  it('accepts a project and an issue and nothing else', async () => {
    const { parseReleaseArgs } = await import('../args.mjs');
    assert.deepEqual(parseReleaseArgs(['release', '--project', PROJECT, '--issue', 'CVX-2']), {
      projectId: PROJECT,
      issueKey: 'CVX-2',
    });
    for (const argv of [
      ['release', '--project', PROJECT],
      ['release', '--issue', 'CVX-2', '--project', PROJECT],
      ['release', '--project', '../x', '--issue', 'CVX-2'],
      ['release', '--project', PROJECT, '--issue', 'CVX-2', '--force'],
    ]) {
      assert.throws(() => parseReleaseArgs(argv), UsageError);
    }
  });
});

describe('headerValueValid', () => {
  it('accepts a reference with at most an authorization scheme in front', async () => {
    const { headerValueValid } = await import('../args.mjs');
    for (const value of [
      '${CONCLAVIX_MCP_HEADER_1}',
      'Bearer ${CONCLAVIX_MCP_HEADER_9}',
      'bearer ${CONCLAVIX_MCP_HEADER_10}',
      'Basic ${CONCLAVIX_MCP_HEADER_20}',
      'token ${CONCLAVIX_MCP_HEADER_32}',
    ]) {
      assert.ok(headerValueValid(value), value);
    }
    for (const value of [
      'Bearer abc',
      'Digest ${CONCLAVIX_MCP_HEADER_1}',
      'Bearer  ${CONCLAVIX_MCP_HEADER_1}',
      ' ${CONCLAVIX_MCP_HEADER_1}',
      'Bearer ${CONCLAVIX_MCP_HEADER_1} ',
      'Bearer ${CONCLAVIX_MCP_HEADER_0}',
      'Bearer ${CONCLAVIX_RUN_BEARER}',
      'Bearer Basic ${CONCLAVIX_MCP_HEADER_1}',
      'Bearer\n${CONCLAVIX_MCP_HEADER_1}',
      '$CONCLAVIX_MCP_HEADER_1',
      42,
      null,
    ]) {
      assert.ok(!headerValueValid(value), String(value));
    }
  });
});

describe('--tool', () => {
  it('parses repeated NAME_BIN=/path values', () => {
    const options = parseRunArgs(
      base('--tool', 'MONGOD_BIN=/usr/local/lib/t/mongod', '--tool', 'CHROME_BIN=/opt/c/chrome'),
    );
    assert.deepEqual(options.tools, [
      { name: 'MONGOD_BIN', path: '/usr/local/lib/t/mongod' },
      { name: 'CHROME_BIN', path: '/opt/c/chrome' },
    ]);
    assert.deepEqual(parseRunArgs(base()).tools, []);
  });

  it('refuses names that are not *_BIN or that a reserved prefix claims', () => {
    for (const name of [
      'MONGOD',
      'mongod_BIN',
      '_BIN',
      'CLAUDE_CODE_BIN',
      'LD_BIN',
      'NODE_X_BIN',
    ]) {
      assert.equal(parseTool(`${name}=/usr/bin/true`), null, name);
    }
  });

  it('refuses relative, unnormalised or unusual paths', () => {
    for (const path of [
      'usr/bin/true',
      '/usr/../bin/true',
      '/usr/./bin/true',
      '/usr//bin/true',
      '/usr/bin/',
      '/usr/bin/a b',
      '/usr/bin/%n',
      '/usr/bin/$HOME',
      '/',
      '',
    ]) {
      assert.equal(parseTool(`X_BIN=${path}`), null, path);
    }
    assert.equal(parseTool('X_BIN'), null);
  });

  it('refuses a name given twice and more than 16 tools', () => {
    assert.throws(
      () => parseRunArgs(base('--tool', 'A_BIN=/usr/bin/a', '--tool', 'A_BIN=/usr/bin/b')),
      UsageError,
    );
    const many = Array.from({ length: 17 }, (_, i) => ['--tool', `T${i}_BIN=/usr/bin/t${i}`]);
    assert.throws(() => parseRunArgs(base(...many.flat())), /too many --tool/);
    assert.throws(() => parseRunArgs(base('--tool', 'X_BIN=relative')), UsageError);
  });
});
