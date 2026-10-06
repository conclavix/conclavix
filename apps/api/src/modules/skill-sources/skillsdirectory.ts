import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  DirectoryCategory,
  DirectoryContent,
  DirectoryQuota,
  DirectorySearchInput,
  DirectorySearchResult,
  DirectorySkill,
  DirectoryStatus,
} from '@conclavix/core';
import {
  EMPTY_QUOTA,
  directoryAuthFailed,
  directoryFailed,
  directoryInvalidResponse,
  directoryNotFound,
  directoryRateLimited,
  type AdapterOptions,
  type DirectoryAdapter,
  type DirectoryDetail,
} from './adapter.js';
import type { HttpResponse } from './http.js';

/**
 * Adapter for the skillsdirectory.com REST API v1 (https://www.skillsdirectory.com/api-docs),
 * authenticated with `x-api-key`.
 *
 * Fields without a note are the free-tier fields of the list, detail, categories and stats
 * responses. Fields marked "Pro (unverified)" are guessed names for paid-plan content, security
 * grade and GitHub metadata; they are parsed leniently and a missing field reads as "not provided".
 */

const DEFAULT_TIMEOUT_MS = 10_000;
export const CONTENT_ON_PAID_PLAN = 'This directory only provides skill content on a paid plan';

const optionalString = z.string().nullish().catch(null);
const optionalNumber = z.number().nullish().catch(null);

const tagSchema = z.union([z.string(), z.looseObject({ name: z.string() })]);

const skillSchema = z.looseObject({
  id: z.union([z.string().min(1), z.number()]).transform(String),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: optionalString,
  category: z
    .union([
      z.string(),
      z.looseObject({ name: z.string().optional(), slug: z.string().optional() }),
    ])
    .nullish()
    .catch(null),
  authorName: optionalString,
  authorUrl: optionalString,
  authorAvatar: optionalString,
  githubStars: optionalNumber,
  isVerified: z.boolean().nullish().catch(null),
  tags: z.array(tagSchema).nullish().catch(null),
  voteCount: optionalNumber,
  viewCount: optionalNumber,
  updatedAt: optionalString,
  // Pro (unverified): content, security and GitHub fields.
  content: optionalString,
  skillContent: optionalString,
  skillMd: optionalString,
  securityGrade: optionalString,
  securityScore: optionalNumber,
  security: z.looseObject({ grade: optionalString, score: optionalNumber }).nullish().catch(null),
  githubUrl: optionalString,
  repoUrl: optionalString,
  repositoryUrl: optionalString,
});
type RawSkill = z.infer<typeof skillSchema>;

const metaSchema = z
  .looseObject({
    requestsRemaining: optionalNumber,
    tier: optionalString,
  })
  .nullish()
  .catch(null);

const listSchema = z.looseObject({
  data: z.array(skillSchema),
  pagination: z.looseObject({
    page: z.number().int(),
    limit: z.number().int(),
    totalCount: z.number().int(),
    totalPages: z.number().int(),
    hasNextPage: z.boolean(),
  }),
  meta: metaSchema,
});

const detailSchema = z.looseObject({ data: skillSchema, meta: metaSchema });

const categoriesSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      slug: z.string().min(1),
      name: z.string().min(1),
      description: optionalString,
      active: z.boolean().nullish().catch(null),
      orderPosition: optionalNumber,
    }),
  ),
});

const statsSchema = z.looseObject({
  data: z.looseObject({
    key: z.looseObject({ tier: optionalString, status: optionalString }).nullish().catch(null),
    usage: z
      .looseObject({
        today: optionalNumber,
        remaining: optionalNumber,
        limit: optionalNumber,
        resetAt: optionalString,
      })
      .nullish()
      .catch(null),
  }),
});

const httpsUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
};

const githubUrl = (value: string | null | undefined): string | null => {
  const url = httpsUrl(value);
  return url && new URL(url).hostname === 'github.com' ? url : null;
};

/** Collapse whitespace and cut a provider string to a display length. */
const clean = (value: string | null | undefined, max: number): string =>
  (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The next midnight UTC, when the documented daily budget resets. */
export function nextUtcMidnight(now = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

const isoOrNull = (value: unknown): string | null =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

/** When a 429 lifts: body `resetAt`, then the rate-limit headers, then the next midnight UTC. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

export function resetAtOf(response: HttpResponse, now = new Date()): string {
  const body = parseJson(response.body);
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const nested = record['error'];
    const fromBody =
      isoOrNull(record['resetAt']) ??
      (nested !== null && typeof nested === 'object'
        ? isoOrNull((nested as Record<string, unknown>)['resetAt'])
        : null);
    if (fromBody) return fromBody;
  }
  const reset = Number(response.headers['x-ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) {
    return new Date(reset > 1e12 ? reset : reset * 1000).toISOString();
  }
  const retryAfter = Number(response.headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return new Date(now.getTime() + retryAfter * 1000).toISOString();
  }
  return nextUtcMidnight(now);
}

const categoryOf = (raw: RawSkill): string | null => {
  const value =
    typeof raw.category === 'string' ? raw.category : (raw.category?.name ?? raw.category?.slug);
  return value ? clean(value, 100) : null;
};

const tagsOf = (raw: RawSkill): string[] =>
  (raw.tags ?? [])
    .map((tag) => clean(typeof tag === 'string' ? tag : tag.name, 50))
    .filter((tag) => tag.length > 0)
    .slice(0, 20);

const securityOf = (raw: RawSkill) => ({
  securityGrade: raw.securityGrade ?? raw.security?.grade ?? null,
  securityScore: raw.securityScore ?? raw.security?.score ?? null,
});

export const contentHash = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

export class SkillsDirectoryAdapter implements DirectoryAdapter {
  private readonly baseUrl: string;
  private readonly webOrigin: string;

  constructor(private readonly options: AdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.webOrigin = new URL(this.baseUrl).origin;
  }

  private async call(path: string, params?: URLSearchParams): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) url.search = params.toString();
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.options.userAgent,
    };
    if (this.options.apiKey) headers['x-api-key'] = this.options.apiKey;
    const response = await this.options.transport(url, {
      headers,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (response.status === 401 || response.status === 403) throw directoryAuthFailed();
    if (response.status === 429) throw directoryRateLimited(resetAtOf(response));
    if (response.status === 404) throw directoryNotFound();
    if (response.status < 200 || response.status >= 300) throw directoryFailed(response.status);
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw directoryInvalidResponse();
    }
  }

  private parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
    const result = schema.safeParse(value);
    if (!result.success) throw directoryInvalidResponse();
    return result.data;
  }

  /** The skill's page on the directory website, `/skills/:slug` on the API's origin. */
  private webUrl(slug: string): string {
    return `${this.webOrigin}/skills/${encodeURIComponent(slug)}`;
  }

  private toSkill(raw: RawSkill): DirectorySkill {
    return {
      externalId: raw.id,
      slug: raw.slug,
      name: clean(raw.name, 200),
      description: clean(raw.description, 2000),
      category: categoryOf(raw),
      author: {
        name: raw.authorName ? clean(raw.authorName, 100) : null,
        url: httpsUrl(raw.authorUrl),
        avatarUrl: httpsUrl(raw.authorAvatar),
      },
      tags: tagsOf(raw),
      stars: raw.githubStars ?? null,
      votes: raw.voteCount ?? null,
      views: raw.viewCount ?? null,
      verified: raw.isVerified === true,
      ...securityOf(raw),
      githubUrl: githubUrl(raw.githubUrl ?? raw.repoUrl ?? raw.repositoryUrl),
      webUrl: this.webUrl(raw.slug),
      updatedAt: raw.updatedAt ?? null,
    };
  }

  private quota(meta: z.infer<typeof metaSchema>): DirectoryQuota {
    return {
      ...EMPTY_QUOTA,
      remaining: meta?.requestsRemaining ?? null,
      tier: meta?.tier ?? null,
    };
  }

  private content(raw: RawSkill, tier: string | null): DirectoryContent {
    const text = [raw.content, raw.skillContent, raw.skillMd].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    if (text !== undefined) {
      return { available: true, content: text, contentHash: contentHash(text) };
    }
    if (tier === null || tier.toLowerCase() === 'free') {
      return { available: false, reason: 'tier', message: CONTENT_ON_PAID_PLAN };
    }
    return {
      available: false,
      reason: 'missing',
      message: 'The directory sent no content for this skill',
    };
  }

  async search(query: DirectorySearchInput): Promise<DirectorySearchResult> {
    const params = new URLSearchParams({
      sort: query.sort,
      limit: String(query.limit),
      offset: String((query.page - 1) * query.limit),
    });
    if (query.q) params.set('q', query.q);
    if (query.category) params.set('category', query.category);
    if (query.verified !== undefined) params.set('verified', String(query.verified));
    const body = this.parse(listSchema, await this.call('/skills', params));
    return {
      items: body.data.map((raw) => this.toSkill(raw)),
      page: query.page,
      limit: query.limit,
      total: body.pagination.totalCount,
      totalPages: body.pagination.totalPages,
      hasNextPage: body.pagination.hasNextPage,
      quota: this.quota(body.meta),
    };
  }

  async get(slug: string): Promise<DirectoryDetail> {
    const body = this.parse(detailSchema, await this.call(`/skills/${encodeURIComponent(slug)}`));
    const quota = this.quota(body.meta);
    return { skill: this.toSkill(body.data), content: this.content(body.data, quota.tier), quota };
  }

  async fetchContent(slug: string): Promise<DirectoryContent> {
    return (await this.get(slug)).content;
  }

  async categories(): Promise<DirectoryCategory[]> {
    const body = this.parse(categoriesSchema, await this.call('/categories'));
    return body.data
      .filter((category) => category.active !== false)
      .sort((a, b) => (a.orderPosition ?? 0) - (b.orderPosition ?? 0))
      .map((category) => ({
        slug: category.slug,
        name: clean(category.name, 100),
        description: category.description ? clean(category.description, 500) : null,
      }));
  }

  async status(): Promise<DirectoryStatus> {
    const { data } = this.parse(statsSchema, await this.call('/stats'));
    return {
      tier: data.key?.tier ?? null,
      keyStatus: data.key?.status ?? null,
      quota: {
        remaining: data.usage?.remaining ?? null,
        limit: data.usage?.limit ?? null,
        tier: data.key?.tier ?? null,
        resetAt: data.usage?.resetAt ?? null,
      },
    };
  }
}
