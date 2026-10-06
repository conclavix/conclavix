import type { BranchInfo, FileDiff } from '@conclavix/core';

export const DEFAULT_BRANCH = 'main';

export type DiffLineKind = 'hunk' | 'add' | 'del' | 'context' | 'note';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line numbers in the old and new file; null where the line does not exist on that side. */
  oldLine: number | null;
  newLine: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Split the hunks of a unified diff into display lines with old and new line numbers. */
export function parsePatch(patch: string | null): DiffLine[] {
  if (!patch) return [];
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const text of patch.split('\n')) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: 'hunk', text, oldLine: null, newLine: null });
    } else if (text.startsWith('+')) {
      lines.push({ kind: 'add', text: text.slice(1), oldLine: null, newLine: newLine++ });
    } else if (text.startsWith('-')) {
      lines.push({ kind: 'del', text: text.slice(1), oldLine: oldLine++, newLine: null });
    } else if (text.startsWith('\\')) {
      lines.push({ kind: 'note', text, oldLine: null, newLine: null });
    } else {
      lines.push({ kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return lines;
}

/** One line of a file diff's header, e.g. "renamed: old.ts -> new.ts". */
export function fileTitle(file: FileDiff): string {
  return file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
}

/** Files shown expanded at first: all of a small diff, otherwise none. */
export function initiallyOpen(files: FileDiff[], maxOpen = 10): string[] {
  return files.length <= maxOpen ? files.map((file) => file.path) : [];
}

/** Totals of a diff for its header. */
export function diffStats(files: FileDiff[]): {
  files: number;
  additions: number;
  deletions: number;
} {
  return files.reduce(
    (sum, file) => ({
      files: sum.files + 1,
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

/** The breadcrumb of a path: the root, then one entry per directory. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  const crumbs = [{ name: 'root', path: '' }];
  let current = '';
  for (const segment of path.split('/').filter(Boolean)) {
    current = current ? `${current}/${segment}` : segment;
    crumbs.push({ name: segment, path: current });
  }
  return crumbs;
}

/** The directory containing `path`; the root for top-level entries. */
export function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** Pick the branch to show: the requested one if it exists, else main, else the first one. */
export function pickBranch(branches: BranchInfo[], wanted: string | null | undefined): string {
  if (wanted && branches.some((branch) => branch.name === wanted)) return wanted;
  if (branches.some((branch) => branch.name === DEFAULT_BRANCH)) return DEFAULT_BRANCH;
  return branches[0]?.name ?? DEFAULT_BRANCH;
}

export type EmptyState = 'repository' | 'branch' | null;

/**
 * Which empty-state hint fits: `repository` while only an empty main exists, `branch` when the
 * shown root is empty but other branches exist, otherwise none.
 */
export function emptyState(
  branches: BranchInfo[],
  path: string,
  rootEntries: number | null,
): EmptyState {
  if (path !== '' || rootEntries !== 0) return null;
  return branches.every((branch) => branch.isDefault) ? 'repository' : 'branch';
}

/** A readable byte size. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The label of a branch in the selector: name plus ahead/behind against main. */
export function branchLabel(branch: BranchInfo): string {
  if (branch.isDefault) return branch.name;
  return `${branch.name} (+${branch.ahead} / -${branch.behind})`;
}

/** File name of a ZIP download, as the server builds it. */
export function archiveName(projectKey: string, ref: string, sha: string): string {
  const safeRef = ref.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'ref';
  return `${projectKey}-${safeRef}-${sha.slice(0, 12)}.zip`;
}

/** File extensions the API serves raw as images (see `IMAGE_CONTENT_TYPES` in core). */
const IMAGE_NAME = /.\.(png|jpe?g|gif|webp|svg)$/i;

/** Largest image the API serves raw (`MAX_RAW_BYTES` in core). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** True when the API serves the file at `path` as an image. */
export const isImagePath = (path: string): boolean =>
  IMAGE_NAME.test(path.slice(path.lastIndexOf('/') + 1));
