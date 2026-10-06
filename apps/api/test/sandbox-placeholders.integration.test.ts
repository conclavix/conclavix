// Runs a stand-in agent in a real transient unit through agent-run in probe mode, lets bubblewrap
// leave its mount points in the clone's .git the way Claude Code's Bash sandbox does, and commits
// afterwards like the runner. Runs only as root with CVX_SANDBOX_INTEGRATION=1 on a host with
// systemd-run and bubblewrap.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeWorkspace } from '../src/modules/workspace/commit.js';

const SANDBOX = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'deploy',
  'agent-sandbox',
);
const enabled =
  process.env['CVX_SANDBOX_INTEGRATION'] === '1' &&
  process.getuid?.() === 0 &&
  existsSync('/usr/bin/systemd-run') &&
  existsSync('/usr/bin/bwrap');

const PROJECT = 'd'.repeat(24);
const ISSUE = 'ITP-1';
const TAG = 'c'.repeat(32);

// Claude Code creates config.worktree and commondir before it starts bubblewrap and mounts them
// read-only; bubblewrap creates the mount points of the missing directories itself.
const PROBE = `#!/bin/bash
set -e
: > .git/config.worktree
printf . > .git/commondir
empty=$(mktemp -d)
bwrap --unshare-all --die-with-parent --bind / / --proc /proc --dev /dev \\
  --ro-bind /dev/null "$PWD/.git/config.worktree" \\
  --ro-bind /dev/null "$PWD/.git/commondir" \\
  --ro-bind "$empty" "$PWD/.git/worktrees" \\
  --ro-bind "$empty" "$PWD/.git/modules" \\
  --ro-bind "$empty" "$PWD/.git/glab-cli" \\
  -- /bin/sh -c 'echo "agent work" > work.txt'
echo "listing=$(ls -A .git | tr '\\n' ' ')"
`;

describe.skipIf(!enabled)('sandbox placeholders after a real unit', () => {
  let root: string;
  let config: string;
  let probe: string;
  let ws: CodeWorkspace;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cvx-placeholder-it-'));
    chmodSync(root, 0o755);
    for (const dir of ['runner', 'managed', 'policy']) mkdirSync(join(root, dir));
    mkdirSync(join(root, 'libexec'), { mode: 0o755 });
    copyFileSync(join(SANDBOX, 'agent-exec.sh'), join(root, 'libexec', 'agent-exec.sh'));
    chmodSync(join(root, 'libexec', 'agent-exec.sh'), 0o755);
    probe = join(root, 'probe.sh');
    writeFileSync(probe, PROBE, { mode: 0o755 });
    config = join(root, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        codeRoot: join(root, 'code'),
        runnerWorkspacesRoot: join(root, 'runner'),
        agentUser: 'nobody',
        ownerUser: 'daemon',
        codeGroup: 'users',
        execWrapper: join(root, 'libexec', 'agent-exec.sh'),
        policyRoot: join(root, 'policy'),
        managedSettingsDir: join(root, 'managed'),
        hiddenPaths: ['/srv', '/opt', join(root, 'code')],
      }),
      { mode: 0o644 },
    );
    ws = new CodeWorkspace(join(root, 'code'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('commits the agent’s work although the sandbox left placeholders in .git', async () => {
    await ws.createIssueWorkspace(PROJECT, ISSUE);
    const base = await ws.branchTip(PROJECT, ISSUE);
    const clone = ws.issueWorkspaceDir(PROJECT, ISSUE);
    const before = readdirSync(join(clone, '.git')).sort();

    const result = spawnSync(
      process.execPath,
      [
        join(SANDBOX, 'agent-run.mjs'),
        'probe',
        probe,
        'run',
        '--run-id',
        'a'.repeat(24),
        '--project',
        PROJECT,
        '--issue',
        ISSUE,
        '--status-tag',
        TAG,
        '--',
        'placeholders',
      ],
      {
        input: `CLAUDE_CODE_OAUTH_TOKEN=${Buffer.from('not-a-real-token').toString('base64')}\n\n`,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', CVX_AGENT_SANDBOX_CONFIG: config },
        timeout: 120_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/"result":"success"/);
    const gitDir = join(clone, '.git');
    for (const name of ['commondir', 'config.worktree', 'worktrees', 'modules', 'glab-cli']) {
      expect(existsSync(join(gitDir, name)), name).toBe(true);
    }
    expect(readFileSync(join(gitDir, 'commondir'), 'utf8')).toBe('.');

    const commit = await ws.commitIssueWork(PROJECT, ISSUE, {
      author: { name: 'Conclavix Coder', email: 'agent-1@conclavix.invalid' },
      message: 'work',
      base,
    });
    expect(commit.commit).not.toBeNull();
    expect(commit.stats.files).toBe(1);
    expect(readdirSync(gitDir).sort()).toEqual(before);
    expect((await ws.syncIssueBranch(PROJECT, ISSUE, false)).after).toBe(commit.commit);
  });
});
