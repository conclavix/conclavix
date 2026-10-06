import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../github.mjs';
import { mergeTree } from '../merge.mjs';
import { verifyMerge } from '../verify.mjs';

const config = loadConfig();
const TRAILER = config.round_trailer;

/** A throwaway repository with a `main` and a `pr` branch that diverge from one base commit. */
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-merge-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      const full = join(dir, path);
      if (text === null) rmSync(full);
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
    }
  };
  const commit = (files, message) => {
    write(files);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  return {
    dir,
    git,
    write,
    commit,
    /** Writes `files` on top of the merge result (git's merge of head and base) as a merge commit. */
    merge(head, base, files, parents = [head, base], message = `x\n\n${TRAILER}: 1\n`) {
      const auto = mergeTree(dir, head, base);
      git('read-tree', auto.tree);
      git('checkout-index', '-a', '-f');
      write(files);
      git('add', '-A');
      const tree = git('write-tree');
      const args = parents.flatMap((p) => ['-p', p]);
      const sha = git('commit-tree', tree, ...args, '-m', message);
      git('reset', '-q', '--hard', 'HEAD');
      git('clean', '-fdq');
      return sha;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** main and pr both change line 2 of src/a.ts. */
export function conflicting(extraBase = {}, extraHead = {}, extraMain = {}) {
  const f = fixture();
  const lines = (mid) => `export const a = 1;\n${mid}\nexport const c = 3;\n`;
  const root = f.commit(
    { 'src/a.ts': lines('export const b = 2;'), 'README.md': 'x\n', ...extraBase },
    'base',
  );
  f.git('checkout', '-q', '-b', 'pr');
  const head = f.commit(
    { 'src/a.ts': lines('export const b = 20; // pr'), ...extraHead },
    'pr change',
  );
  f.git('checkout', '-q', 'main');
  const base = f.commit(
    { 'src/a.ts': lines('export const b = 2;\nexport const d = 4;'), ...extraMain },
    'main change',
  );
  f.git('checkout', '-q', '--detach', head);
  return { ...f, root, head, base, lines };
}

export const RESOLVED =
  'export const a = 1;\nexport const b = 20; // pr\nexport const d = 4;\nexport const c = 3;\n';

export function verify(f, sha, overrides = {}) {
  const parents = f.git('rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);
  const message = f.git('log', '-1', '--format=%B', sha);
  return verifyMerge({
    cwd: f.dir,
    sha,
    parents,
    message,
    head: f.head,
    base: f.base,
    baseTip: f.base,
    round: 1,
    branch: 'feat/x',
    config,
    ...overrides,
  });
}
