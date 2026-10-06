import type {
  DirectoryCategory,
  DirectoryContent,
  DirectoryQuota,
  DirectorySearchInput,
  DirectorySearchResult,
  DirectorySkill,
  DirectoryStatus,
} from '@conclavix/core';
import { AppError } from '../../errors.js';
import type { HttpTransport } from './http.js';

/** One directory entry with whatever content the provider's plan hands out. */
export interface DirectoryDetail {
  skill: DirectorySkill;
  content: DirectoryContent;
  quota: DirectoryQuota;
}

/**
 * What Conclavix needs from an external skill directory. Every provider maps its own API onto
 * these shapes; errors are AppErrors with the `directory_*` codes below.
 */
export interface DirectoryAdapter {
  search(query: DirectorySearchInput): Promise<DirectorySearchResult>;
  get(slug: string): Promise<DirectoryDetail>;
  categories(): Promise<DirectoryCategory[]>;
  status(): Promise<DirectoryStatus>;
  fetchContent(slug: string): Promise<DirectoryContent>;
}

export interface AdapterOptions {
  baseUrl: string;
  apiKey: string | null;
  transport: HttpTransport;
  userAgent: string;
  timeoutMs?: number;
}

export type AdapterFactory = (options: AdapterOptions) => DirectoryAdapter;

export const directoryAuthFailed = (): AppError =>
  new AppError(502, 'directory_auth_failed', 'The directory rejected the API key');

export const directoryRateLimited = (resetAt: string | null): AppError =>
  new AppError(
    429,
    'directory_rate_limited',
    'The daily request limit of this directory is used up',
    { resetAt },
  );

export const directoryInvalidResponse = (): AppError =>
  new AppError(502, 'directory_invalid_response', 'The directory sent an unexpected answer');

export const directoryNotFound = (): AppError =>
  new AppError(404, 'not_found', 'Skill not found in the directory');

export const directoryFailed = (status: number): AppError =>
  new AppError(502, 'directory_unavailable', `The directory answered with HTTP ${status}`);

export const EMPTY_QUOTA: DirectoryQuota = {
  remaining: null,
  limit: null,
  tier: null,
  resetAt: null,
};
