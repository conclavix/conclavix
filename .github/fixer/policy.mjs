import { execFileSync } from 'node:child_process';

/** @returns {RegExp} anchored regex for a glob with `*` (no slash) and `**` (any depth) */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** @returns {{status: string, path: string, from?: string}[]} parsed `git diff --name-status -M` */
export function parseNameStatus(text) {
  return String(text ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, a, b] = line.split('\t');
      return b === undefined
        ? { status: status[0], path: a }
        : { status: status[0], path: b, from: a };
    });
}

/** @returns {{path: string, added: number, deleted: number, binary: boolean}[]} parsed `--numstat` */
export function parseNumstat(text) {
  return String(text ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, ...rest] = line.split('\t');
      const path = rest.join('\t');
      const binary = added === '-' || deleted === '-';
      return {
        path,
        added: binary ? 0 : Number(added),
        deleted: binary ? 0 : Number(deleted),
        binary,
      };
    });
}

/** @returns {{path: string, text: string}[]} added lines of a `git diff -U0` patch */
export function addedLines(patch) {
  const out = [];
  let path = null;
  for (const line of String(patch ?? '').split('\n')) {
    if (line.startsWith('+++ ')) path = line === '+++ /dev/null' ? null : line.slice(6);
    else if (line.startsWith('+') && path) out.push({ path, text: line.slice(1) });
  }
  return out;
}

function checkPaths(files, allowedFiles, config, violations) {
  for (const f of files) {
    for (const path of [f.path, f.from].filter(Boolean)) {
      if (matchesAny(path, config.forbidden_paths))
        violations.push(`${path}: changes to this path are never made by the fixer`);
      else if (matchesAny(path, config.guarded_paths) && !allowedFiles.has(path))
        violations.push(`${path}: guarded path, no selected finding is about this file`);
    }
    const old = f.from ?? f.path;
    if ((f.status === 'D' || f.status === 'R') && matchesAny(old, config.test_paths))
      violations.push(`${old}: a test file was deleted or renamed`);
  }
}

function checkSize(numstat, config, violations) {
  let lines = 0;
  for (const n of numstat) {
    if (n.binary) violations.push(`${n.path}: binary change`);
    if (!matchesAny(n.path, config.test_paths)) lines += n.added + n.deleted;
  }
  if (lines > config.max_fix_lines)
    violations.push(`${lines} changed non-test lines, the limit is ${config.max_fix_lines}`);
  return lines;
}

/**
 * Checks a working-tree change against the fixer policy in config.json.
 * @returns {{violations: string[], files: string[], lines: number}}
 */
export function checkChanges({ nameStatus, numstat, patch }, findings, config) {
  const files = parseNameStatus(nameStatus);
  const allowedFiles = new Set(findings.map((f) => f.file).filter(Boolean));
  const violations = [];
  checkPaths(files, allowedFiles, config, violations);
  const lines = checkSize(parseNumstat(numstat), config, violations);
  const patterns = config.weakening_patterns.map((p) => new RegExp(p));
  for (const { path, text } of addedLines(patch)) {
    const hit = patterns.find((p) => p.test(text));
    if (hit) violations.push(`${path}: added line matches ${hit.source}`);
  }
  return { violations, files: files.map((f) => f.path), lines };
}

function git(args, cwd) {
  return execFileSync(
    'git',
    ['-c', 'core.quotePath=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

/** @returns {{nameStatus: string, numstat: string, patch: string}} diff between two revisions or `from` and the index */
export function collectDiff(from, to, cwd) {
  const range = to ? [from, to] : ['--cached', from];
  return {
    nameStatus: git(['diff', '--no-ext-diff', '--name-status', '-M', ...range], cwd),
    numstat: git(['diff', '--no-ext-diff', '--numstat', '-M', ...range], cwd),
    patch: git(['diff', '--no-ext-diff', '--no-color', '-U0', '-M', ...range], cwd),
  };
}

export { git };
