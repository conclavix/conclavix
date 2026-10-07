import { z } from 'zod';
import { IMAGE_CONTENT_TYPES, refSchema } from './workspace.js';

/** The kinds of media the Media tab lists. */
export const MEDIA_KINDS = ['image', 'video', 'pdf'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Video and document types the raw route serves besides images, by lower-case extension. */
export const EXTRA_MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
};

/** Every type the raw route serves, by lower-case file extension. */
export const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ...IMAGE_CONTENT_TYPES,
  ...EXTRA_MEDIA_CONTENT_TYPES,
};

/** The lower-case extension of the last path segment, or '' when it has none. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The content type the raw route serves `path` with, or null when it is no media file. */
export function mediaContentType(path: string): string | null {
  const extension = extensionOf(path);
  return Object.hasOwn(MEDIA_CONTENT_TYPES, extension)
    ? (MEDIA_CONTENT_TYPES[extension] ?? null)
    : null;
}

/** The media kind of `path`, or null when it is no media file. */
export function mediaKindOf(path: string): MediaKind | null {
  const type = mediaContentType(path);
  if (!type) return null;
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  return 'pdf';
}

export const mediaQuerySchema = z.strictObject({
  kind: z.enum(MEDIA_KINDS).optional(),
  /** Only files present on this branch (`main` or `cvx/<KEY>`). */
  branch: refSchema.optional(),
  /** Case-insensitive substring of the path. */
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

export type MediaQuery = z.infer<typeof mediaQuerySchema>;

/** Where a media file was found: a branch, its issue key and the path there. */
export interface MediaLocation {
  branch: string;
  /** The issue key when the branch is an issue branch (`cvx/<KEY>`). */
  issueKey: string | null;
  path: string;
}

/** One media file, deduplicated by blob id across `main` and the issue branches. */
export interface MediaItem {
  /** The blob id; the same content on several branches or paths is listed once. */
  oid: string;
  /** The path shown for the file: on the first branch it was found on (main first). */
  path: string;
  name: string;
  kind: MediaKind;
  contentType: string;
  size: number;
  /** Every branch and path holding this blob, main first. */
  locations: MediaLocation[];
  /**
   * A full commit id at which `path` holds this blob: the newest commit that wrote it when the
   * history scan found it, otherwise the tip of the first branch. Raw URLs use it as `ref`.
   */
  ref: string;
  /** The newest commit that wrote this blob; null when it lies beyond the history scan. */
  commit: { sha: string; authorName: string; committedAt: string } | null;
}

export interface MediaFacets {
  kinds: Record<MediaKind, number>;
  branches: { name: string; issueKey: string | null; count: number }[];
}

/**
 * How far the history walk that dates the files got: `complete`, `limited` (a commit, size or time
 * limit stopped it, so some files have no `commit`) or `failed` (git failed; no file has one).
 */
export type MediaHistory = 'complete' | 'limited' | 'failed';

export interface MediaListing {
  items: MediaItem[];
  /** Matches of the filters in total, across all pages. */
  total: number;
  /** The `offset` of the next page, or null on the last one. */
  nextOffset: number | null;
  /** Counts over the whole (unfiltered) scan, for the filter controls. */
  facets: MediaFacets;
  /** True when a branch, file or time limit cut the scan short, so files may be missing. */
  truncated: boolean;
  history: MediaHistory;
  /** Branches the scan covered. */
  scannedBranches: number;
  /**
   * Identifies the scan behind this page; every new scan (a branch tip moved, or a failed history
   * walk was retried) gets a new one. A page with another version than the previous one does not
   * continue it: start again at offset 0.
   */
  version: string;
}
