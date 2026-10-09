import type { MediaItem, MediaKind } from '@conclavix/core';
import type { RouteLocationRaw } from 'vue-router';
import { rawUrl } from '../code/api';
import { MAX_IMAGE_BYTES } from '../code/logic';

/** The raw URL of an item, addressed by commit id so the browser keeps it. */
export const mediaUrl = (projectId: string, item: MediaItem): string =>
  rawUrl(projectId, item.ref, item.path);

/** True when the raw route refuses the item for its size, so no preview can be loaded. */
export const tooLarge = (item: MediaItem): boolean => item.size > MAX_IMAGE_BYTES;

/** True when the grid shows the item itself as thumbnail (images within the raw limit). */
export const hasThumbnail = (item: MediaItem): boolean => item.kind === 'image' && !tooLarge(item);

/** The issue keys of an item's branches, in branch order, without duplicates. */
export function issueKeys(item: MediaItem): string[] {
  return [...new Set(item.locations.flatMap((l) => (l.issueKey ? [l.issueKey] : [])))];
}

/** The branches holding an item, in scan order (main first), without duplicates. */
export function branchesOf(item: MediaItem): string[] {
  return [...new Set(item.locations.map((l) => l.branch))];
}

/** The Code tab showing the item's file on the first branch that holds it. */
export function codeTabLink(projectKey: string, item: MediaItem): RouteLocationRaw {
  const location = item.locations[0] ?? { branch: 'main', path: item.path };
  const slash = location.path.lastIndexOf('/');
  const query: Record<string, string> = {
    tab: 'code',
    branch: location.branch,
    file: location.path,
  };
  if (slash > 0) query['path'] = location.path.slice(0, slash);
  return { name: 'project', params: { projectKey }, query };
}

export const KIND_LABELS: Record<MediaKind, string> = {
  image: 'Images',
  video: 'Videos',
  pdf: 'PDFs',
};

/** The label of a branch in the filter: the issue key for issue branches. */
export const branchFilterLabel = (branch: { name: string; issueKey: string | null }): string =>
  branch.issueKey ? `${branch.issueKey} (${branch.name})` : branch.name;

/** The index after `index` in a list of `length`, or null past the end. */
export const stepIndex = (index: number, delta: number, length: number): number | null => {
  const next = index + delta;
  return next >= 0 && next < length ? next : null;
};
