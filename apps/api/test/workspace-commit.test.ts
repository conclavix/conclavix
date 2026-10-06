import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeWorkspace, safeIdent, sumNumstat } from '../src/modules/workspace/commit.js';
import { commitAll, git, tempRoot } from './workspace-helpers.js';

const PROJECT = 'cccccccccccccccccccccccc';
const ISSUE = 'COD-4';
const AUTHOR = { name: 'Conclavix Coder', email: 'agent-1@conclavix.invalid' };

describe('CodeWorkspace.commitIssueWork', () => {
  let root: { dir: string; cleanup: () => void };
  let ws: CodeWorkspace;
  let clone: string;
  let base: string | null;

  beforeEach(async () => {
    root = tempRoot('cvx-commit-');
    ws = new CodeWorkspace(root.dir);
    await ws.createIssueWorkspace(PROJECT, ISSUE);
    clone = ws.issueWorkspaceDir(PROJECT, ISSUE);
    base = await ws.branchTip(PROJECT, ISSUE);
  });

  afterEach(() => root.cleanup());

  it('commits every change with the fixed author and a fresh index', async () => {
    writeFileSync(join(clone, 'main.py'), 'print("hi")\nprint("there")\n');
    mkdirSync(join(clone, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(clone, 'node_modules', 'left-pad', 'index.js'), 'x');
    const result = await ws.commitIssueWork(PROJECT, ISSUE, {
      author: AUTHOR,
      message: 'Add main.py\n\nConclavix-Run: 1\n',
      base,
    });
    expect(result.commit).not.toBeNull();
    expect(result.head).toBe(result.commit);
    expect(result.agentCommits).toBe(0);
    expect(result.stats).toEqual({ files: 1, insertions: 2, deletions: 0 });
    expect(git(clone, 'log', '-1', '--format=%an <%ae>|%cn|%s')).toBe(
      'Conclavix Coder <agent-1@conclavix.invalid>|Conclavix Coder|Add main.py',
    );
    expect(git(clone, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('main.py');
    expect(git(clone, 'status', '--porcelain')).toBe('?? node_modules/');

    const sync = await ws.syncIssueBranch(PROJECT, ISSUE, false);
    expect(sync.after).toBe(result.commit);
  });

  it('keeps the agent’s own commits and commits the rest on top', async () => {
    writeFileSync(join(clone, 'a.txt'), 'a\n');
    commitAll(clone, 'agent commit');
    writeFileSync(join(clone, 'b.txt'), 'b\n');
    const result = await ws.commitIssueWork(PROJECT, ISSUE, {
      author: AUTHOR,
      message: 'rest',
      base,
    });
    expect(result.agentCommits).toBe(1);
    expect(result.stats.files).toBe(2);
    expect(git(clone, 'rev-list', '--count', `${base}..HEAD`)).toBe('2');
  });

  it('makes no commit when nothing changed', async () => {
    const result = await ws.commitIssueWork(PROJECT, ISSUE, {
      author: AUTHOR,
      message: 'none',
      base,
    });
    expect(result.commit).toBeNull();
    expect(result.head).toBe(base);
    expect(result.stats).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  it('replaces the clone configuration, so filters and hooks planted there never run', async () => {
    const marker = join(root.dir, 'pwned');
    const config = join(clone, '.git', 'config');
    writeFileSync(
      config,
      `${readFileSync(config, 'utf8')}[filter "evil"]\n\tclean = touch ${marker}\n[core]\n\thooksPath = ${clone}/.githooks\n\tfsmonitor = touch ${marker}\n`,
    );
    writeFileSync(join(clone, '.gitattributes'), '* filter=evil\n');
    mkdirSync(join(clone, '.githooks'));
    writeFileSync(join(clone, '.githooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, {
      mode: 0o755,
    });
    writeFileSync(join(clone, 'file.txt'), 'content\n');
    const result = await ws.commitIssueWork(PROJECT, ISSUE, { author: AUTHOR, message: 'x', base });
    expect(result.commit).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(config, 'utf8')).not.toContain('evil');
  });

  it('cleans author identities and sums numstat output', () => {
    expect(safeIdent('Evil <x@y>\nInjected: 1', 'fallback')).toBe('Evil x@y Injected: 1');
    expect(safeIdent('\u0000', 'fallback')).toBe('fallback');
    expect(sumNumstat('3\t1\ta.txt\n-\t-\timg.png\n')).toEqual({
      files: 2,
      insertions: 3,
      deletions: 1,
    });
  });
});
