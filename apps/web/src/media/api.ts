import type { MediaKind, MediaListing } from '@conclavix/core';
import { api } from '../api/client';
import { query } from '../code/api';

export type { MediaItem, MediaKind, MediaListing, MediaLocation } from '@conclavix/core';

export interface MediaFilters {
  kind?: MediaKind | undefined;
  branch?: string | undefined;
  q?: string | undefined;
  sort: 'newest' | 'oldest';
}

export const mediaApi = {
  list: (projectId: string, filters: MediaFilters, offset = 0, limit = 60) =>
    api<MediaListing>(
      `/projects/${encodeURIComponent(projectId)}/media${query({
        kind: filters.kind,
        branch: filters.branch,
        q: filters.q?.trim() || undefined,
        sort: filters.sort,
        offset,
        limit,
      })}`,
    ),
};
