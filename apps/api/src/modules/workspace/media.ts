import {
  DEFAULT_BRANCH,
  ISSUE_BRANCH_PREFIX,
  MEDIA_KINDS,
  issueKeySchema,
  mediaContentType,
  mediaKindOf,
  type MediaFacets,
  type MediaItem,
  type MediaKind,
  type MediaListing,
  type MediaQuery,
} from '@conclavix/core';
import { GitError } from './git.js';
import { parseLsTree } from './parse.js';
import { OBJECT_ID } from './repo-base.js';
import { RepoReader } from './reader.js';

/** A branch the media scan covers. */
interface ScanRef {
  branch: string;
  sha: string;
  tree: string;
}

/** The result of one scan of a repository, before filters and pages. */
export interface MediaScan {
  items: MediaItem[];
  facets: MediaFacets;
  truncated: boolean;
  scannedBranches: number;
}

/** Projects whose last scan stays cached; the least recently used one is dropped first. */
const MEDIA_CACHE_SIZE = 32;
/** Above this many distinct paths, or this many bytes of them, the history walk runs without pathspecs. */
const MAX_LOG_PATHSPECS = 200;
const MAX_LOG_PATHSPEC_BYTES = 64 * 1024;
/** Trees listed at the same time. */
const LS_TREE_CONCURRENCY = 4;

const issueKeyOf = (branch: string): string | null => {
  if (!branch.startsWith(ISSUE_BRANCH_PREFIX)) return null;
  const key = branch.slice(ISSUE_BRANCH_PREFIX.length);
  return issueKeySchema.safeParse(key).success ? key : null;
};

/**
 * Parse `for-each-ref --format=%(refname)%00%(objectname)%00%(tree)` output into `main` first,
 * then the issue branches in the order git printed them (newest commit first).
 */
export function parseScanRefs(output: string): ScanRef[] {
  const refs: ScanRef[] = [];
  for (const line of output.split('\n')) {
    const [refname = '', sha = '', tree = ''] = line.split('\0');
    if (!refname.startsWith('refs/heads/') || !OBJECT_ID.test(sha) || !OBJECT_ID.test(tree)) {
      continue;
    }
    const branch = refname.slice('refs/heads/'.length);
    if (branch !== DEFAULT_BRANCH && issueKeyOf(branch) === null) continue;
    refs.push({ branch, sha, tree });
  }
  return refs.sort(
    (a, b) => Number(b.branch === DEFAULT_BRANCH) - Number(a.branch === DEFAULT_BRANCH),
  );
}

/** A commit that wrote a blob at a path, from the history walk. */
export interface BlobWrite {
  sha: string;
  authorName: string;
  committedAt: string;
  oid: string;
  path: string;
}

/**
 * Parse `git log -z --raw --no-abbrev --no-renames --format=%x1e%H%x1f%an%x1f%cI` output into
 * the blobs each commit wrote (added, modified or type-changed files; deletions are skipped).
 */
export function parseBlobWrites(output: string): BlobWrite[] {
  const writes: BlobWrite[] = [];
  for (const record of output.split('\u001e')) {
    const end = record.indexOf('\0');
    if (end < 0) continue;
    const [sha = '', authorName = '', committedAt = ''] = record.slice(0, end).split('\u001f');
    if (!OBJECT_ID.test(sha)) continue;
    for (const { oid, path } of rawWrites(record.slice(end + 1))) {
      writes.push({ sha, authorName, committedAt, oid, path });
    }
  }
  return writes;
}

/** The new blob and path of each non-deleting `--raw -z` record of one commit. */
function rawWrites(raw: string): { oid: string; path: string }[] {
  const parts = raw.split('\0');
  const writes: { oid: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = (parts[i] ?? '').replace(/^\n/, '');
    if (!meta.startsWith(':')) break;
    const [, , , oid = '', status = ''] = meta.slice(1).split(' ');
    if (status.startsWith('D') || !OBJECT_ID.test(oid) || /^0+$/.test(oid)) continue;
    writes.push({ oid, path: parts[i + 1] ?? '' });
  }
  return writes;
}

/** The scan's items narrowed by the query's filters and sorted; not yet paged. */
export function filterMedia(items: readonly MediaItem[], query: MediaQuery): MediaItem[] {
  const needle = (query.q ?? '').toLowerCase();
  const matches = items.filter(
    (item) =>
      (!query.kind || item.kind === query.kind) &&
      (!query.branch || item.locations.some((l) => l.branch === query.branch)) &&
      (needle === '' || item.locations.some((l) => l.path.toLowerCase().includes(needle))),
  );
  const direction = query.sort === 'oldest' ? -1 : 1;
  return matches.sort((a, b) => {
    const at = a.commit?.committedAt ?? '';
    const bt = b.commit?.committedAt ?? '';
    if (at !== bt) {
      if (!at) return 1;
      if (!bt) return -1;
      return direction * (Date.parse(bt) - Date.parse(at));
    }
    return a.path.localeCompare(b.path);
  });
}

/** One page of a scan for the media route. */
export function pageMedia(scan: MediaScan, query: MediaQuery): MediaListing {
  const matches = filterMedia(scan.items, query);
  const end = query.offset + query.limit;
  return {
    items: matches.slice(query.offset, end),
    total: matches.length,
    nextOffset: end < matches.length ? end : null,
    facets: scan.facets,
    truncated: scan.truncated,
    scannedBranches: scan.scannedBranches,
  };
}

function facetsOf(items: readonly MediaItem[], refs: readonly ScanRef[]): MediaFacets {
  const kinds = Object.fromEntries(MEDIA_KINDS.map((kind) => [kind, 0])) as Record<
    MediaKind,
    number
  >;
  const perBranch = new Map<string, number>();
  for (const item of items) {
    kinds[item.kind] += 1;
    for (const branch of new Set(item.locations.map((l) => l.branch))) {
      perBranch.set(branch, (perBranch.get(branch) ?? 0) + 1);
    }
  }
  return {
    kinds,
    branches: refs
      .filter((ref) => perBranch.has(ref.branch))
      .map((ref) => ({
        name: ref.branch,
        issueKey: issueKeyOf(ref.branch),
        count: perBranch.get(ref.branch) ?? 0,
      })),
  };
}

/**
 * The media files (images, videos, PDFs) of a project repository across `main` and every issue
 * branch, deduplicated by blob id. A scan is cached per project until a branch tip changes.
 */
export class MediaReader extends RepoReader {
  private readonly mediaCache = new Map<string, { key: string; scan: Promise<MediaScan> }>();

  /** One page of the project's media, filtered and sorted as `query` asks. */
  async media(projectId: string, query: MediaQuery): Promise<MediaListing> {
    return pageMedia(await this.mediaScan(projectId), query);
  }

  /** The scan for the current branch tips, from the cache when no tip moved. */
  async mediaScan(projectId: string): Promise<MediaScan> {
    await this.ensureRepo(projectId);
    const { refs, truncated } = await this.scanRefs(projectId);
    const key = refs.map((ref) => `${ref.branch}\0${ref.sha}`).join('\n');
    const cached = this.mediaCache.get(projectId);
    if (cached?.key === key) {
      this.mediaCache.delete(projectId);
      this.mediaCache.set(projectId, cached);
      return cached.scan;
    }
    const scan = this.scanMedia(projectId, refs, truncated);
    this.mediaCache.delete(projectId);
    this.mediaCache.set(projectId, { key, scan });
    while (this.mediaCache.size > MEDIA_CACHE_SIZE) {
      const oldest = this.mediaCache.keys().next().value;
      if (oldest === undefined) break;
      this.mediaCache.delete(oldest);
    }
    scan.catch(() => {
      if (this.mediaCache.get(projectId)?.scan === scan) this.mediaCache.delete(projectId);
    });
    return scan;
  }

  /** `main` and the issue branches, up to the branch limit. */
  private async scanRefs(projectId: string): Promise<{ refs: ScanRef[]; truncated: boolean }> {
    const { stdout, truncated } = await this.git.run(
      this.repoArgs(projectId, [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(tree)',
        '--sort=-committerdate',
        `refs/heads/${DEFAULT_BRANCH}`,
        `refs/heads/${ISSUE_BRANCH_PREFIX}`,
      ]),
      { timeoutMs: this.limits.timeoutMs, maxBytes: this.limits.maxListBytes, allowTruncate: true },
    );
    let text = stdout.toString('utf8');
    if (truncated) text = text.slice(0, text.lastIndexOf('\n') + 1);
    const refs = parseScanRefs(text);
    const max = this.limits.maxMediaBranches;
    return { refs: refs.slice(0, max), truncated: truncated || refs.length > max };
  }

  /** The media entries of one tree, recursively; cut at the list limit. */
  private async mediaInTree(projectId: string, tree: string) {
    const { stdout, truncated } = await this.git.run(
      this.repoArgs(projectId, ['ls-tree', '-r', '-z', '-l', '--full-tree', tree]),
      { timeoutMs: this.limits.timeoutMs, maxBytes: this.limits.maxListBytes, allowTruncate: true },
    );
    let text = stdout.toString('utf8');
    if (truncated) text = text.slice(0, text.lastIndexOf('\0') + 1);
    const entries = parseLsTree(text).filter(
      (entry) => entry.type === 'blob' && mediaKindOf(entry.path) !== null,
    );
    return { entries, truncated };
  }

  private async scanMedia(
    projectId: string,
    refs: ScanRef[],
    refsTruncated: boolean,
  ): Promise<MediaScan> {
    const deadline = Date.now() + this.limits.mediaScanBudgetMs;
    let truncated = refsTruncated;
    const byOid = new Map<string, MediaItem>();
    const trees = new Map<string, ReturnType<MediaReader['mediaInTree']>>();
    const scanned: ScanRef[] = [];

    for (let start = 0; start < refs.length; start += LS_TREE_CONCURRENCY) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      const batch = refs.slice(start, start + LS_TREE_CONCURRENCY);
      const listings = await Promise.all(
        batch.map((ref) => {
          let listing = trees.get(ref.tree);
          if (!listing) {
            listing = this.mediaInTree(projectId, ref.tree);
            trees.set(ref.tree, listing);
          }
          return listing;
        }),
      );
      batch.forEach((ref, index) => {
        const listing = listings[index];
        if (!listing) return;
        scanned.push(ref);
        if (listing.truncated) truncated = true;
        const issueKey = issueKeyOf(ref.branch);
        for (const entry of listing.entries) {
          let item = byOid.get(entry.oid);
          if (!item) {
            if (byOid.size >= this.limits.maxMediaItems) {
              truncated = true;
              continue;
            }
            const kind = mediaKindOf(entry.path);
            const contentType = mediaContentType(entry.path);
            if (!kind || !contentType) continue;
            item = {
              oid: entry.oid,
              path: entry.path,
              name: entry.path.slice(entry.path.lastIndexOf('/') + 1),
              kind,
              contentType,
              size: entry.size ?? 0,
              locations: [],
              ref: ref.sha,
              commit: null,
            };
            byOid.set(entry.oid, item);
          }
          item.locations.push({ branch: ref.branch, issueKey, path: entry.path });
        }
      });
    }

    const items = [...byOid.values()];
    if (items.length > 0 && Date.now() <= deadline) {
      try {
        await this.attachCommits(projectId, scanned, items, deadline);
      } catch (error) {
        // Without the history the files are still listed, only without author and date.
        if (!(error instanceof GitError)) throw error;
      }
    }
    return {
      items,
      facets: facetsOf(items, scanned),
      truncated,
      scannedBranches: scanned.length,
    };
  }

  /**
   * Find the newest commit that wrote each item's blob at its path, walking the history of the
   * scanned branches up to the commit limit. Items it does not find keep the branch tip as `ref`.
   */
  private async attachCommits(
    projectId: string,
    refs: ScanRef[],
    items: MediaItem[],
    deadline: number,
  ): Promise<void> {
    const paths = [...new Set(items.map((item) => item.path))];
    const tips = [...new Set(refs.map((ref) => ref.sha))];
    const args = [
      'log',
      '-z',
      '--raw',
      '--no-abbrev',
      '--no-renames',
      '--full-history',
      '--format=%x1e%H%x1f%an%x1f%cI',
      `--max-count=${this.limits.maxMediaLogCommits}`,
      ...tips,
      '--',
      ...(paths.length <= MAX_LOG_PATHSPECS &&
      paths.reduce((sum, path) => sum + Buffer.byteLength(path), 0) <= MAX_LOG_PATHSPEC_BYTES
        ? paths
        : []),
    ];
    const { stdout, truncated } = await this.git.run(this.repoArgs(projectId, args), {
      timeoutMs: Math.max(1000, Math.min(this.limits.timeoutMs, deadline - Date.now())),
      maxBytes: this.limits.maxListBytes,
      allowTruncate: true,
    });
    let text = stdout.toString('utf8');
    if (truncated) text = text.slice(0, text.lastIndexOf('\u001e'));
    const byOid = new Map(items.map((item) => [item.oid, item]));
    for (const write of parseBlobWrites(text)) {
      const item = byOid.get(write.oid);
      if (!item || item.path !== write.path) continue;
      const current = item.commit ? Date.parse(item.commit.committedAt) : -Infinity;
      if (Date.parse(write.committedAt) > current) {
        item.commit = {
          sha: write.sha,
          authorName: write.authorName,
          committedAt: write.committedAt,
        };
        item.ref = write.sha;
      }
    }
  }
}
