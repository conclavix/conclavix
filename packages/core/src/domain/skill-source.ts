import { z } from 'zod';

/** External skill directories Conclavix can browse and import from. */
export const SKILL_SOURCE_PROVIDERS = ['skillsdirectory'] as const;
export type SkillSourceProvider = (typeof SKILL_SOURCE_PROVIDERS)[number];

export interface SkillSourceProviderInfo {
  id: SkillSourceProvider;
  label: string;
  defaultBaseUrl: string;
  docsUrl: string;
}

export const SKILL_SOURCE_PROVIDER_INFO: Readonly<
  Record<SkillSourceProvider, SkillSourceProviderInfo>
> = {
  skillsdirectory: {
    id: 'skillsdirectory',
    label: 'Skills Directory',
    defaultBaseUrl: 'https://www.skillsdirectory.com/api/v1',
    docsUrl: 'https://www.skillsdirectory.com/api-docs',
  },
};

export const SKILL_SOURCE_LIMITS = {
  nameLength: 80,
  apiKeyLength: 512,
  baseUrlLength: 2048,
  queryLength: 200,
  pageLimit: 50,
} as const;

const nameSchema = z.string().trim().min(1).max(SKILL_SOURCE_LIMITS.nameLength);
const baseUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(SKILL_SOURCE_LIMITS.baseUrlLength)
  .transform((value) => value.replace(/\/+$/, ''));
/** API keys are opaque tokens; whitespace or control characters would break the header. */
const apiKeySchema = z
  .string()
  .max(SKILL_SOURCE_LIMITS.apiKeyLength)
  .regex(/^[\x21-\x7e]*$/, 'must not contain spaces or control characters');

export const createSkillSourceSchema = z.strictObject({
  name: nameSchema,
  provider: z.enum(SKILL_SOURCE_PROVIDERS),
  /** Omitted means the provider's default endpoint. */
  baseUrl: baseUrlSchema.optional(),
  apiKey: apiKeySchema.optional(),
  enabled: z.boolean().default(true),
});

export const updateSkillSourceSchema = z
  .strictObject({
    name: nameSchema,
    /** null resets to the provider's default endpoint. */
    baseUrl: baseUrlSchema.nullable(),
    /** Write-only: an empty string keeps the stored key, null removes it. */
    apiKey: apiKeySchema.nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export type CreateSkillSourceInput = z.infer<typeof createSkillSourceSchema>;
export type UpdateSkillSourceInput = z.infer<typeof updateSkillSourceSchema>;

/** A configured directory as the API shows it: the API key is never returned, only whether one is set. */
export interface SkillSource {
  id: string;
  name: string;
  provider: SkillSourceProvider;
  baseUrl: string;
  baseUrlIsDefault: boolean;
  enabled: boolean;
  hasApiKey: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const DIRECTORY_SORTS = ['recent', 'votes', 'stars'] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];

export const directorySearchSchema = z.strictObject({
  q: z.string().trim().max(SKILL_SOURCE_LIMITS.queryLength).optional(),
  category: z
    .string()
    .trim()
    .max(100)
    .regex(/^[\w-]*$/)
    .optional(),
  sort: z.enum(DIRECTORY_SORTS).default('recent'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(SKILL_SOURCE_LIMITS.pageLimit).default(20),
  verified: z.stringbool().optional(),
});
export type DirectorySearchInput = z.infer<typeof directorySearchSchema>;

/** Directory slugs end up in provider URLs, so they are restricted to URL-safe characters. */
export const directorySlugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a directory slug');

export const importDirectorySkillSchema = z.strictObject({
  slug: directorySlugSchema,
  /** Library name for the new skill; defaults to one derived from the directory slug. */
  name: z.string().max(64).optional(),
  /** Imported text becomes part of agent prompts; the importer has to acknowledge that. */
  confirmUntrusted: z.literal(true),
  /** Overwrite the skill imported earlier from the same directory entry. */
  replaceExisting: z.boolean().default(false),
});
export type ImportDirectorySkillInput = z.infer<typeof importDirectorySkillSchema>;

/** Where an imported skill came from; kept when the skill is edited later. */
export interface SkillProvenance {
  sourceId: string;
  provider: SkillSourceProvider;
  externalId: string;
  slug: string;
  url: string;
  importedAt: Date;
  /** sha256 of the imported SKILL.md text, to tell later whether the directory copy changed. */
  contentHash: string;
}

export interface DirectoryAuthor {
  name: string | null;
  url: string | null;
  avatarUrl: string | null;
}

export interface DirectorySkill {
  externalId: string;
  slug: string;
  name: string;
  description: string;
  category: string | null;
  author: DirectoryAuthor;
  tags: string[];
  stars: number | null;
  votes: number | null;
  views: number | null;
  verified: boolean;
  /** Only on paid plans; null when the directory did not send one. */
  securityGrade: string | null;
  securityScore: number | null;
  githubUrl: string | null;
  /** The skill's page on the directory website. */
  webUrl: string;
  updatedAt: string | null;
}

export type ContentUnavailableReason = 'tier' | 'missing';

export type DirectoryContent =
  | { available: true; content: string; contentHash: string }
  | { available: false; reason: ContentUnavailableReason; message: string };

export interface DirectoryQuota {
  remaining: number | null;
  limit: number | null;
  tier: string | null;
  resetAt: string | null;
}

export interface DirectorySearchResult {
  items: DirectorySkill[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  quota: DirectoryQuota;
}

export interface DirectoryCategory {
  slug: string;
  name: string;
  description: string | null;
}

export interface DirectoryStatus {
  tier: string | null;
  keyStatus: string | null;
  quota: DirectoryQuota;
}

/**
 * A valid library name from a directory slug: lowercase, single hyphens, at most 64 characters.
 * Returns null when nothing usable is left.
 */
export function skillNameFromSlug(slug: string): string | null {
  const name = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return name.length > 0 ? name : null;
}
