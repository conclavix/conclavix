import { z } from 'zod';
import { apiValidated } from './client';
import { skillSchema } from './skills';

export const skillSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  provider: z.string(),
  baseUrl: z.string(),
  baseUrlIsDefault: z.boolean(),
  enabled: z.boolean(),
  hasApiKey: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const providerInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  defaultBaseUrl: z.string(),
  docsUrl: z.string(),
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

const sourceListSchema = z.object({
  items: z.array(skillSourceSchema),
  providers: z.array(providerInfoSchema),
});

export const quotaSchema = z.object({
  remaining: z.number().nullable(),
  limit: z.number().nullable(),
  tier: z.string().nullable(),
  resetAt: z.string().nullable(),
  at: z.string().optional(),
});
export type DirectoryQuota = z.infer<typeof quotaSchema>;

export const directorySkillSchema = z.object({
  externalId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string().nullable(),
  author: z.object({
    name: z.string().nullable(),
    url: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  tags: z.array(z.string()),
  stars: z.number().nullable(),
  votes: z.number().nullable(),
  views: z.number().nullable(),
  verified: z.boolean(),
  securityGrade: z.string().nullable(),
  securityScore: z.number().nullable(),
  githubUrl: z.string().nullable(),
  webUrl: z.string(),
  updatedAt: z.string().nullable(),
  importedSkillId: z.string().nullable(),
});
export type DirectorySkill = z.infer<typeof directorySkillSchema>;

const searchResultSchema = z.object({
  items: z.array(directorySkillSchema),
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
  hasNextPage: z.boolean(),
  quota: quotaSchema,
  cached: z.boolean(),
});
export type DirectorySearchResult = z.infer<typeof searchResultSchema>;

const categoriesSchema = z.object({
  items: z.array(
    z.object({ slug: z.string(), name: z.string(), description: z.string().nullable() }),
  ),
});
export type DirectoryCategory = z.infer<typeof categoriesSchema>['items'][number];

export const contentSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), content: z.string(), contentHash: z.string() }),
  z.object({
    available: z.literal(false),
    reason: z.enum(['tier', 'missing']),
    message: z.string(),
  }),
]);
export type DirectoryContent = z.infer<typeof contentSchema>;

const detailSchema = z.object({
  skill: directorySkillSchema.omit({ importedSkillId: true }),
  content: contentSchema,
  importedSkillId: z.string().nullable(),
  quota: quotaSchema,
  cached: z.boolean(),
});
export type DirectoryDetail = z.infer<typeof detailSchema>;

const statusSchema = z.object({
  ok: z.boolean(),
  tier: z.string().nullable(),
  keyStatus: z.string().nullable(),
  quota: quotaSchema,
});
export type DirectoryStatus = z.infer<typeof statusSchema>;

const importResultSchema = z.object({ skill: skillSchema, replaced: z.boolean() });

export interface SkillSourceInput {
  name?: string;
  provider?: string;
  /** null resets to the provider default. */
  baseUrl?: string | null;
  /** Write-only: omitted or empty keeps the stored key, null removes it. */
  apiKey?: string | null;
  enabled?: boolean;
}

export interface DirectoryQuery {
  q?: string;
  category?: string;
  sort: 'recent' | 'votes' | 'stars';
  page: number;
  limit: number;
}

const json = (method: string, body?: object): RequestInit => ({
  method,
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const path = (id: string, rest = '') => `/skill-sources/${encodeURIComponent(id)}${rest}`;

export function directoryQueryString(query: DirectoryQuery): string {
  const params = new URLSearchParams({
    sort: query.sort,
    page: String(query.page),
    limit: String(query.limit),
  });
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.category) params.set('category', query.category);
  return params.toString();
}

export const skillSourcesApi = {
  list: () => apiValidated(sourceListSchema, '/skill-sources'),
  create: (input: SkillSourceInput) =>
    apiValidated(skillSourceSchema, '/skill-sources', json('POST', input)),
  update: (id: string, input: SkillSourceInput) =>
    apiValidated(skillSourceSchema, path(id), json('PATCH', input)),
  remove: (id: string) => apiValidated(z.undefined(), path(id), { method: 'DELETE' }),
  test: (id: string) => apiValidated(statusSchema, path(id, '/test'), json('POST')),
  categories: (id: string) => apiValidated(categoriesSchema, path(id, '/categories')),
  search: (id: string, query: DirectoryQuery) =>
    apiValidated(searchResultSchema, path(id, `/skills?${directoryQueryString(query)}`)),
  detail: (id: string, slug: string) =>
    apiValidated(detailSchema, path(id, `/skills/${encodeURIComponent(slug)}`)),
  import: (id: string, input: { slug: string; name?: string; replaceExisting?: boolean }) =>
    apiValidated(
      importResultSchema,
      path(id, '/import'),
      json('POST', { ...input, confirmUntrusted: true }),
    ),
};
