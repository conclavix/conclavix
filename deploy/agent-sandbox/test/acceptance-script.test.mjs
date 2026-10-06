import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const script = readFileSync(new URL('../../sandbox-acceptance.sh', import.meta.url), 'utf8');

/** Each systemd-run command line of the script, continuation lines joined. */
function systemdRunCommands(source) {
  const joined = source.replace(/\\\n\s*/g, ' ');
  return joined
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .flatMap((line) =>
      [...line.matchAll(/(?:^|[|;&]\s*|\s)systemd-run\s[^\n]*/g)].map((m) => m[0]),
    );
}

describe('sandbox-acceptance.sh', () => {
  const commands = systemdRunCommands(script);

  it('starts at least one transient unit', () => {
    assert.ok(commands.length > 0);
  });

  it('never lets systemd expand ${...} references in a command line', () => {
    for (const command of commands) {
      assert.match(command, /--expand-environment=no\b/, command.slice(0, 120));
    }
  });

  it('passes the MCP config with an unexpanded bearer reference', () => {
    assert.match(script, /Bearer \\\$\{CONCLAVIX_RUN_BEARER\}/);
  });
});
