import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const WRAPPER = fileURLToPath(new URL('../agent-exec.sh', import.meta.url));

const line = (name, value) => `${name}=${Buffer.from(value, 'utf8').toString('base64')}`;

/** Run the wrapper with an environment block and print what env sees. */
function wrap(lines, rest = '') {
  const result = spawnSync('/bin/bash', [WRAPPER, '/usr/bin/env', '-0'], {
    input: `${lines.join('\n')}\n\n${rest}`,
    env: { PATH: '/usr/bin:/bin' },
  });
  const env = Object.fromEntries(
    result.stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]),
  );
  return { status: result.status, env, stderr: result.stderr.toString('utf8') };
}

describe('agent-exec.sh environment block', () => {
  it('exports project secrets next to the run variables, values byte for byte', () => {
    const value = 'multi\nline "value" with = and $HOME';
    const { status, env } = wrap([
      line('STRIPE_TEST_KEY', value),
      line('API_BASE', 'https://api.example.com/v1'),
      line('CONCLAVIX_RUN_BEARER', 'bearer-value-123'),
    ]);
    assert.equal(status, 0);
    assert.equal(env['STRIPE_TEST_KEY'], value);
    assert.equal(env['API_BASE'], 'https://api.example.com/v1');
    assert.equal(env['CONCLAVIX_RUN_BEARER'], 'bearer-value-123');
    // The wrapper's own settings win over anything in the block.
    assert.equal(env['HOME'], '/tmp/cvx-home');
    assert.equal(env['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'], '1');
  });

  for (const name of [
    'PATH',
    'HOME',
    'LD_PRELOAD',
    'NODE_OPTIONS',
    'BASH_ENV',
    'CLAUDE_CONFIG_DIR',
    'CONCLAVIX_RUN_TOKEN',
    'CVX_SECRET_X',
    'GIT_SSH_COMMAND',
    'UID',
    'HTTPS_PROXY',
    'lowercase',
    'A-B',
  ]) {
    it(`refuses ${name} as a project secret`, () => {
      const { status, stderr } = wrap([line(name, 'some-value-1234')]);
      assert.equal(status, 64);
      assert.match(stderr, /refusing an environment line/);
    });
  }

  it('refuses more than 128 lines', () => {
    const lines = Array.from({ length: 129 }, (_, i) => line(`SECRET_${i}`, 'value-12345'));
    assert.equal(wrap(lines).status, 64);
    assert.equal(wrap(lines.slice(0, 128)).status, 0);
  });
});
