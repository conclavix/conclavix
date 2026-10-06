import type {
  BranchInfo,
  CommitSummary,
  FileChangeStatus,
  FileDiff,
  TreeEntry,
  TreeEntryType,
} from '@conclavix/core';
import { DEFAULT_BRANCH, ISSUE_BRANCH_PREFIX, issueKeySchema } from '@conclavix/core';

export const FIELD = '\u001f';

/** `git log` format of a commit summary: fixed fields first, the free-text subject last. */
export const COMMIT_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%cn', '%cI', '%s'].join(
  '%x1f',
);

/** Parse one record written with COMMIT_FORMAT (plus optional extra fields after the subject). */
export function parseCommit(record: string): CommitSummary & { rest: string[] } {
  const fields = record.replace(/^\n+/, '').split(FIELD);
  const [sha, shortSha, parents, authorName, authorEmail, authoredAt, committerName, committedAt] =
    fields;
  return {
    sha: sha ?? '',
    shortSha: shortSha ?? '',
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    authorName: authorName ?? '',
    authorEmail: authorEmail ?? '',
    authoredAt: authoredAt ?? '',
    committerName: committerName ?? '',
    committedAt: committedAt ?? '',
    subject: fields[8] ?? '',
    rest: fields.slice(9),
  };
}

/** Parse `git log -z --format=COMMIT_FORMAT` output. */
export function parseCommitLog(output: string): CommitSummary[] {
  return output
    .split('\0')
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const { rest, ...commit } = parseCommit(record);
      void rest;
      return commit;
    });
}

/** `git for-each-ref` format for branches; fields separated by NUL, one branch per line. */
export const BRANCH_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(objectname:short)',
  `%(ahead-behind:refs/heads/${DEFAULT_BRANCH})`,
  '%(authorname)',
  '%(committerdate:iso-strict)',
  '%(subject)',
].join('%00');

/** Parse `git for-each-ref --format=BRANCH_FORMAT refs/heads/` output. */
export function parseBranches(output: string): BranchInfo[] {
  const branches: BranchInfo[] = [];
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const [refname, sha, shortSha, aheadBehind, authorName, committedAt, subject] =
      line.split('\0');
    if (!refname?.startsWith('refs/heads/') || !sha) continue;
    const name = refname.slice('refs/heads/'.length);
    const [ahead, behind] = (aheadBehind ?? '0 0').split(' ').map((n) => Number(n) || 0);
    const key = name.startsWith(ISSUE_BRANCH_PREFIX) ? name.slice(ISSUE_BRANCH_PREFIX.length) : '';
    branches.push({
      name,
      sha,
      ahead: ahead ?? 0,
      behind: behind ?? 0,
      isDefault: name === DEFAULT_BRANCH,
      issueKey: issueKeySchema.safeParse(key).success ? key : null,
      lastCommit: {
        sha,
        shortSha: shortSha ?? sha.slice(0, 7),
        subject: subject ?? '',
        authorName: authorName ?? '',
        committedAt: committedAt ?? '',
      },
    });
  }
  return branches.sort((a, b) =>
    a.isDefault !== b.isDefault
      ? a.isDefault
        ? -1
        : 1
      : Date.parse(b.lastCommit.committedAt) - Date.parse(a.lastCommit.committedAt),
  );
}

interface RawTreeEntry {
  mode: string;
  type: TreeEntryType;
  oid: string;
  size: number | null;
  path: string;
}

/** Parse `git ls-tree -z -l` output. */
export function parseLsTree(output: string): RawTreeEntry[] {
  const entries: RawTreeEntry[] = [];
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid, size] = record.slice(0, tab).split(/ +/);
    if (!mode || !oid || (type !== 'tree' && type !== 'blob' && type !== 'commit')) continue;
    entries.push({
      mode,
      type,
      oid,
      size: size === undefined || size === '-' ? null : Number(size),
      path: record.slice(tab + 1),
    });
  }
  return entries;
}

/** Turn ls-tree entries of the directory `dir` into API entries: directories first, then by name. */
export function toTreeEntries(raw: RawTreeEntry[], dir: string): TreeEntry[] {
  const order = { tree: 0, commit: 1, blob: 2 } as const;
  return raw
    .map((entry) => ({
      name: entry.path,
      path: dir === '' ? entry.path : `${dir}/${entry.path}`,
      type: entry.type,
      mode: entry.mode,
      size: entry.type === 'blob' ? entry.size : null,
    }))
    .sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name));
}

const STATUS: Record<string, FileChangeStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
};

interface RawChange {
  status: FileChangeStatus;
  path: string;
  oldPath: string | null;
}

/** Parse `git diff --raw -z` output: `:modes oids STATUS\0path\0` plus a second path for R/C. */
export function parseRawDiff(output: string): RawChange[] {
  const parts = output.split('\0');
  const changes: RawChange[] = [];
  let i = 0;
  while (i < parts.length) {
    const head = parts[i];
    if (!head?.startsWith(':')) {
      i += 1;
      continue;
    }
    const letter = head.trim().split(' ').at(-1)?.charAt(0) ?? 'M';
    const status = STATUS[letter] ?? 'changed';
    if (letter === 'R' || letter === 'C') {
      changes.push({ status, oldPath: parts[i + 1] ?? '', path: parts[i + 2] ?? '' });
      i += 3;
    } else {
      changes.push({ status, oldPath: null, path: parts[i + 1] ?? '' });
      i += 2;
    }
  }
  return changes;
}

interface RawStat {
  binary: boolean;
  additions: number;
  deletions: number;
}

/** Parse `git diff --numstat -z` output; renames carry an empty path and two extra records. */
export function parseNumstat(output: string): RawStat[] {
  const parts = output.split('\0');
  const stats: RawStat[] = [];
  let i = 0;
  while (i < parts.length) {
    const record = parts[i] ?? '';
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
    if (!match) {
      i += 1;
      continue;
    }
    const binary = match[1] === '-' && match[2] === '-';
    stats.push({
      binary,
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
    });
    i += match[3] === '' ? 3 : 1;
  }
  return stats;
}

/** Split `git diff -p` output into one section per file, in the order git printed them. */
export function splitPatch(output: string): string[] {
  if (!output.startsWith('diff --git ')) return [];
  return output.split(/\n(?=diff --git )/);
}

/** The hunks of one file section, from its first `@@` line; null when there are none. */
export function hunksOf(section: string): string | null {
  const start = section.startsWith('@@') ? 0 : section.indexOf('\n@@');
  if (start < 0) return null;
  const hunks = section.slice(start === 0 ? 0 : start + 1);
  return hunks.endsWith('\n') ? hunks.slice(0, -1) : hunks;
}

/** Cut text at the last line break before `maxBytes` UTF-8 bytes. */
export function cutText(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, cut: false };
  const head = bytes.subarray(0, maxBytes).toString('utf8');
  const lastBreak = head.lastIndexOf('\n');
  return { text: lastBreak > 0 ? head.slice(0, lastBreak) : head, cut: true };
}

export interface DiffLimits {
  maxFiles: number;
  maxFilePatchBytes: number;
}

/** Combine raw changes, numstat and the patch sections into per-file diffs. */
export function buildFileDiffs(
  raw: RawChange[],
  stats: RawStat[],
  sections: string[],
  patchTruncated: boolean,
  limits: DiffLimits,
): { files: FileDiff[]; truncated: boolean } {
  let truncated = patchTruncated || raw.length > limits.maxFiles;
  const files = raw.slice(0, limits.maxFiles).map((change, index): FileDiff => {
    const stat = stats[index] ?? { binary: false, additions: 0, deletions: 0 };
    const section = sections[index];
    const isLastSection = index === sections.length - 1;
    let patch: string | null = null;
    let fileTruncated = false;
    if (section === undefined) {
      fileTruncated = patchTruncated && !stat.binary;
    } else if (!stat.binary) {
      const hunks = hunksOf(section);
      if (hunks !== null) {
        const cut = cutText(hunks, limits.maxFilePatchBytes);
        patch = cut.text;
        fileTruncated = cut.cut || (patchTruncated && isLastSection);
      } else {
        fileTruncated = patchTruncated && isLastSection;
      }
    }
    if (fileTruncated) truncated = true;
    return {
      path: change.path,
      oldPath: change.oldPath,
      status: change.status,
      binary: stat.binary,
      additions: stat.additions,
      deletions: stat.deletions,
      patch,
      truncated: fileTruncated,
    };
  });
  return { files, truncated };
}

/** True when the first 8000 bytes contain a NUL byte, the same check git itself uses. */
export function looksBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}
