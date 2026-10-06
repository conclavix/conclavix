import { z } from 'zod';

/** The branch every project repository starts with and every issue branch is cut from. */
export const DEFAULT_BRANCH = 'main';

/** Prefix of the branch an issue's workspace works on: `cvx/<ISSUE-KEY>`. */
export const ISSUE_BRANCH_PREFIX = 'cvx/';

/** Branch an issue's workspace uses. */
export const issueBranchName = (issueKey: string): string => `${ISSUE_BRANCH_PREFIX}${issueKey}`;

/**
 * A ref as the board API accepts it: a branch name or an abbreviated or full commit id. This is
 * only the shape check; the server additionally runs `git check-ref-format --branch` and resolves
 * the ref to a commit before any other git command sees it. A leading `-` is never accepted.
 */
export const refSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/][A-Za-z0-9._/+-]*$/, 'must be a branch name or a commit id')
  .refine((value) => !value.includes('..'), 'must not contain ".."');

/** True when `value` contains a C0 control character or DEL. */
export const hasControlCharacter = (value: string): boolean =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

/** A full or abbreviated object id. */
export const commitIdSchema = z.string().regex(/^[0-9a-f]{7,64}$/, 'must be a commit id');

/**
 * A repository-relative path: segments separated by `/`, no empty, `.` or `..` segments, no
 * leading `/` or `-`, no control characters. The empty string is the repository root.
 */
export const repoPathSchema = z
  .string()
  .max(4096)
  .refine((value) => !hasControlCharacter(value), 'must not contain control characters')
  .refine(
    (value) =>
      value === '' ||
      value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'must be a relative path without ".", ".." or empty segments',
  )
  .refine((value) => !value.startsWith('-'), 'must not start with "-"');

export const refQuerySchema = z.strictObject({
  ref: refSchema.default(DEFAULT_BRANCH),
});

export const treeQuerySchema = z.strictObject({
  ref: refSchema.default(DEFAULT_BRANCH),
  path: repoPathSchema.default(''),
});

export const fileQuerySchema = z.strictObject({
  ref: refSchema.default(DEFAULT_BRANCH),
  path: repoPathSchema.refine((value) => value !== '', 'a file path is required'),
});

/** Image types the raw route serves, by lower-case file extension. */
export const IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** Largest file the raw route serves. */
export const MAX_RAW_BYTES = 10 * 1024 * 1024;

/** The image content type of a repository path, or null when it is no supported image. */
export function imageContentType(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(IMAGE_CONTENT_TYPES, extension)
    ? (IMAGE_CONTENT_TYPES[extension] ?? null)
    : null;
}

export const commitLogQuerySchema = z.strictObject({
  ref: refSchema.default(DEFAULT_BRANCH),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  skip: z.coerce.number().int().min(0).max(100000).default(0),
});

export const compareQuerySchema = z.strictObject({
  branch: refSchema,
});

export const removeWorkspaceQuerySchema = z.strictObject({
  force: z.stringbool().default(false),
});

export const syncBranchSchema = z.strictObject({
  force: z.boolean().default(false),
});

export interface CommitSummary {
  sha: string;
  shortSha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committedAt: string;
  subject: string;
}

export interface CommitDetail extends CommitSummary {
  body: string;
  diff: Diff;
}

export interface BranchInfo {
  name: string;
  sha: string;
  /** Commits on the branch that main lacks, and the reverse; zero for main itself. */
  ahead: number;
  behind: number;
  isDefault: boolean;
  /** The issue key when the branch is an issue branch (`cvx/<KEY>`). */
  issueKey: string | null;
  lastCommit: Pick<CommitSummary, 'sha' | 'shortSha' | 'subject' | 'authorName' | 'committedAt'>;
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'changed';

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileChangeStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  /** The hunks of the unified diff (from the first `@@` line); null for binary files or no hunks. */
  patch: string | null;
  /** True when the patch was cut at the per-file or total size limit. */
  truncated: boolean;
}

export interface Diff {
  files: FileDiff[];
  /** True when files or patch text are missing past a size or count limit. */
  truncated: boolean;
}

export interface CommitPage {
  items: CommitSummary[];
  /** The `skip` value for the next page, or null at the end of the history. */
  nextSkip: number | null;
}

export type TreeEntryType = 'tree' | 'blob' | 'commit';

export interface TreeEntry {
  name: string;
  path: string;
  type: TreeEntryType;
  mode: string;
  /** Blob size in bytes; null for directories and submodules. */
  size: number | null;
}

export interface TreeListing {
  ref: string;
  sha: string;
  path: string;
  entries: TreeEntry[];
}

export interface FileContent {
  ref: string;
  sha: string;
  path: string;
  size: number;
  binary: boolean;
  /** True when the file is larger than the viewer limit; `content` is null then. */
  tooLarge: boolean;
  content: string | null;
}

export interface BranchComparison {
  base: string;
  head: string;
  baseSha: string;
  headSha: string;
  mergeBase: string | null;
  ahead: number;
  behind: number;
  commits: CommitSummary[];
  diff: Diff;
}

export interface IssueWorkspaceInfo {
  issueKey: string;
  branch: string;
  /** The branch tip: on the server for a new workspace, inside the clone for an existing one. */
  head: string;
  /** True when this call created the workspace, false when it already existed. */
  created: boolean;
  /** Stays the same while the clone exists; a removed and re-created clone gets a new one. */
  cloneId: string;
}

export interface BranchSync {
  issueKey: string;
  branch: string;
  /** The server branch tip before the sync; null when the branch did not exist. */
  before: string | null;
  after: string;
  updated: boolean;
  forced: boolean;
}

export type RefQuery = z.infer<typeof refQuerySchema>;
export type TreeQuery = z.infer<typeof treeQuerySchema>;
export type FileQuery = z.infer<typeof fileQuerySchema>;
export type CommitLogQuery = z.infer<typeof commitLogQuerySchema>;
export type CompareQuery = z.infer<typeof compareQuerySchema>;
