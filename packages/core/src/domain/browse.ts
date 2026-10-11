import { z } from 'zod';
import { MEDIA_CONTENT_TYPES } from './media.js';
import {
  DEFAULT_BRANCH,
  commitIdSchema,
  fileQuerySchema,
  refSchema,
  repoPathSchema,
  type CommitSummary,
  type Diff,
} from './workspace.js';

/** `GET /raw`: `download=1` sends any file as an attachment instead of inline media only. */
export const rawQuerySchema = fileQuerySchema.extend({
  download: z.stringbool().default(false),
});

/** `GET /archive`: the whole ref, or with `path` only that directory. */
export const archiveQuerySchema = z.strictObject({
  ref: refSchema.default(DEFAULT_BRANCH),
  path: repoPathSchema.default(''),
});

/** Largest file the download mode of the raw route sends, unless configured otherwise. */
export const DEFAULT_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

/**
 * The content type of a download: the media type for raster images, videos and PDFs, otherwise
 * `application/octet-stream`. SVG, HTML and scripts are always octet-stream.
 */
export function downloadContentType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
  if (extension === 'svg' || !Object.hasOwn(MEDIA_CONTENT_TYPES, extension)) {
    return 'application/octet-stream';
  }
  return MEDIA_CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export const DIFF_MODES = ['merge-base', 'direct'] as const;
export type DiffMode = (typeof DIFF_MODES)[number];

const diffPathSchema = repoPathSchema.refine((value) => value !== '', 'must not be empty');

/**
 * `GET /diff`: either one commit against its first parent (`commit`), or `from` (default main)
 * against `to`, from their merge base (`merge-base`, like a pull request) or directly. `path`
 * restricts the diff to one file or directory and lifts the per-file size limit; `oldPath` adds
 * the previous name of a renamed file, so git still sees the rename.
 */
export const diffQuerySchema = z
  .strictObject({
    commit: commitIdSchema.optional(),
    from: refSchema.optional(),
    to: refSchema.optional(),
    mode: z.enum(DIFF_MODES).default('merge-base'),
    path: diffPathSchema.optional(),
    oldPath: diffPathSchema.optional(),
  })
  .refine((value) => (value.commit === undefined) !== (value.to === undefined), {
    message: 'give either commit or to',
  })
  .refine((value) => value.commit === undefined || value.from === undefined, {
    message: 'from does not apply to a commit diff',
  })
  .refine((value) => value.oldPath === undefined || value.path !== undefined, {
    message: 'oldPath needs path',
  });

export type DiffQuery = z.infer<typeof diffQuerySchema>;

export interface RefDiff {
  mode: DiffMode | 'commit';
  /** The ref the diff compares against as given; null for the parent of a root commit. */
  from: string | null;
  to: string;
  fromSha: string | null;
  toSha: string;
  mergeBase: string | null;
  /** The commit the diff starts at (merge base, `from` or the parent); null for the empty tree. */
  diffBase: string | null;
  /** Commits `to` has that `from` lacks, and the reverse; zero for a commit diff. */
  ahead: number;
  behind: number;
  /** The commits `to` has that `from` lacks, newest first, up to the comparison limit. */
  commits: CommitSummary[];
  path: string | null;
  diff: Diff;
}
