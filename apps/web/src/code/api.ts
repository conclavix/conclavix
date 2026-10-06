import type {
  BranchComparison,
  BranchInfo,
  CommitDetail,
  CommitPage,
  FileContent,
  TreeListing,
} from '@conclavix/core';
import { api } from '../api/client';

export type {
  BranchComparison,
  BranchInfo,
  CommitDetail,
  CommitPage,
  CommitSummary,
  Diff,
  FileContent,
  FileDiff,
  TreeEntry,
  TreeListing,
} from '@conclavix/core';

/** A query string from defined values, each one URI-encoded. */
export function query(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export const codeApi = {
  branches: (projectId: string) => api<{ items: BranchInfo[] }>(`${base(projectId)}/branches`),
  tree: (projectId: string, ref: string, path: string) =>
    api<TreeListing>(`${base(projectId)}/tree${query({ ref, path })}`),
  file: (projectId: string, ref: string, path: string) =>
    api<FileContent>(`${base(projectId)}/file${query({ ref, path })}`),
  commits: (projectId: string, ref: string, skip = 0, limit = 30) =>
    api<CommitPage>(`${base(projectId)}/commits${query({ ref, skip, limit })}`),
  commit: (projectId: string, sha: string) =>
    api<CommitDetail>(`${base(projectId)}/commits/${encodeURIComponent(sha)}`),
  compare: (projectId: string, branch: string) =>
    api<BranchComparison>(`${base(projectId)}/compare${query({ branch })}`),
};

/** The URL of the ZIP download of `ref`. */
export const archiveUrl = (projectId: string, ref: string): string =>
  `/api${base(projectId)}/archive${query({ ref })}`;

/** The URL of an image at `ref` served raw by the API. */
export const rawUrl = (projectId: string, ref: string, path: string): string =>
  `/api${base(projectId)}/raw${query({ ref, path })}`;
