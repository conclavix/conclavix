import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import {
  SKILL_LIMITS,
  createSkillSchema,
  skillNameFromSlug,
  skillNameSchema,
  type DirectoryCategory,
  type DirectoryQuota,
  type DirectorySearchInput,
  type DirectorySearchResult,
  type DirectoryStatus,
  type ImportDirectorySkillInput,
  type Skill,
  type SkillSourceProvider,
} from '@conclavix/core';
import type { Database, SkillDoc, SkillSourceDoc } from '../../db.js';
import { AppError, conflict, isDuplicateKeyError } from '../../errors.js';
import type { AuditActor, AuditLog } from '../audit/audit.js';
import {
  EMPTY_QUOTA,
  directoryRateLimited,
  type AdapterFactory,
  type DirectoryAdapter,
  type DirectoryDetail,
} from './adapter.js';
import type { DirectoryCache } from './cache.js';
import type { HttpTransport } from './http.js';
import { effectiveBaseUrl, type SkillSourceRepository } from './repository.js';
import { SkillsDirectoryAdapter } from './skillsdirectory.js';

export const ADAPTERS: Readonly<Record<SkillSourceProvider, AdapterFactory>> = {
  skillsdirectory: (options) => new SkillsDirectoryAdapter(options),
};

const TTL_SECONDS = { search: 300, detail: 300, categories: 3600, quota: 86_400 } as const;
const MAX_RATE_LIMIT_SECONDS = 86_400;
const UNKNOWN_RESET_SECONDS = 3600;

export interface DirectoryServiceOptions {
  database: Database;
  sources: SkillSourceRepository;
  cache: DirectoryCache;
  transport: HttpTransport;
  audit: AuditLog;
  userAgent: string;
}

export type StoredQuota = DirectoryQuota & { at?: string };

/** Split a leading YAML frontmatter block from the rest of a SKILL.md text. */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { frontmatter: null, body: text };
  return { frontmatter: match[1] ?? '', body: text.slice(match[0].length).replace(/^\s*\n/, '') };
}

/** The `description:` value of a SKILL.md frontmatter, unquoted, or null. */
export function frontmatterDescription(frontmatter: string | null): string | null {
  if (!frontmatter) return null;
  const line = /^description:[ \t]*(.+)$/m.exec(frontmatter)?.[1]?.trim();
  if (!line) return null;
  if (line.startsWith('"')) {
    try {
      return String(JSON.parse(line));
    } catch {
      return line.slice(1, -1);
    }
  }
  return line.replace(/^'(.*)'$/, '$1');
}

/** Replace control characters and runs of whitespace with single spaces. */
const singleLine = (value: string): string =>
  [...value]
    .map((char) => (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

type ImportFields = Pick<SkillDoc, 'name' | 'description' | 'body' | 'source' | 'updatedAt'>;

/**
 * The library fields for an imported directory entry: body without frontmatter, a one-line
 * description and a valid name. Raises 422 when the content cannot become a skill.
 */
export function importFields(
  doc: SkillSourceDoc,
  detail: DirectoryDetail,
  requestedName: string | null,
  now: Date,
): ImportFields {
  const { content } = detail;
  if (!content.available) {
    throw new AppError(422, 'content_unavailable', content.message, {
      reason: content.reason,
      url: detail.skill.webUrl,
    });
  }
  const { frontmatter, body } = splitFrontmatter(content.content);
  if (body.length > SKILL_LIMITS.bodyLength) {
    throw new AppError(422, 'content_too_large', 'The skill content exceeds the library limit', {
      limit: SKILL_LIMITS.bodyLength,
    });
  }
  const name = skillNameSchema.safeParse(requestedName ?? skillNameFromSlug(detail.skill.slug));
  if (!name.success) {
    throw new AppError(422, 'invalid_name', 'Choose a valid skill name for the import', {
      suggestion: skillNameFromSlug(detail.skill.slug),
    });
  }
  const description = singleLine(
    detail.skill.description || frontmatterDescription(frontmatter) || detail.skill.name,
  ).slice(0, SKILL_LIMITS.descriptionLength);
  const valid = createSkillSchema.safeParse({ name: name.data, description, body });
  if (!valid.success) {
    throw new AppError(422, 'content_invalid', 'The directory content is not a valid skill', {
      issues: valid.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return {
    name: valid.data.name,
    description: valid.data.description,
    body: valid.data.body,
    source: {
      sourceId: doc._id,
      provider: doc.provider,
      externalId: detail.skill.externalId,
      slug: detail.skill.slug,
      url: detail.skill.webUrl,
      importedAt: now,
      contentHash: content.contentHash,
    },
    updatedAt: now,
  };
}

/** Translate duplicate keys from an import into "already imported" or "name taken". */
function importConflict(error: unknown, name: string): unknown {
  if (!isDuplicateKeyError(error)) return error;
  const keyPattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern ?? {};
  if ('source.externalId' in keyPattern) {
    return new AppError(409, 'already_imported', 'This skill was already imported', {});
  }
  return conflict(`A skill named ${name} already exists`, { suggestion: name });
}

const toSkill = (doc: SkillDoc): Skill => ({
  id: doc._id.toHexString(),
  name: doc.name,
  description: doc.description,
  body: doc.body,
  files: doc.files,
  source: doc.source ? { ...doc.source, sourceId: doc.source.sourceId.toHexString() } : null,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

/**
 * Browsing and importing for configured skill directories. Provider answers are cached per source
 * version (its `updatedAt`), a rate-limit answer is remembered until it lifts, and the last quota
 * a provider reported is kept so cached pages still show the current remaining budget.
 */
export class SkillDirectoryService {
  constructor(private readonly options: DirectoryServiceOptions) {}

  private adapter(doc: SkillSourceDoc): DirectoryAdapter {
    return ADAPTERS[doc.provider]({
      baseUrl: effectiveBaseUrl(doc),
      apiKey: this.options.sources.apiKey(doc),
      transport: this.options.transport,
      userAgent: this.options.userAgent,
    });
  }

  private prefix(doc: SkillSourceDoc): string {
    return `${doc._id.toHexString()}:${doc.updatedAt.getTime()}:`;
  }

  private async enabledSource(id: ObjectId): Promise<SkillSourceDoc> {
    const doc = await this.options.sources.getDoc(id);
    if (!doc.enabled) {
      throw new AppError(409, 'directory_disabled', 'This skill directory is disabled');
    }
    return doc;
  }

  /** Store the newest quota; fields a provider answer leaves out keep their last known value. */
  private async rememberQuota(doc: SkillSourceDoc, quota: DirectoryQuota): Promise<void> {
    if (quota.remaining === null && quota.tier === null && quota.limit === null) return;
    const previous = await this.quota(doc);
    const merged: StoredQuota = {
      remaining: quota.remaining ?? previous.remaining,
      limit: quota.limit ?? previous.limit,
      tier: quota.tier ?? previous.tier,
      resetAt: quota.resetAt ?? previous.resetAt,
      at: new Date().toISOString(),
    };
    await this.options.cache.set(
      `${this.prefix(doc)}quota`,
      JSON.stringify(merged),
      TTL_SECONDS.quota,
    );
  }

  /** The last quota the provider reported for this source, if any. */
  async quota(doc: SkillSourceDoc): Promise<StoredQuota> {
    const raw = await this.options.cache.get(`${this.prefix(doc)}quota`);
    if (!raw) return EMPTY_QUOTA;
    try {
      return JSON.parse(raw) as StoredQuota;
    } catch {
      return EMPTY_QUOTA;
    }
  }

  /**
   * Serve from the cache, or call the provider once and cache the answer. A 429 is remembered
   * until its reset so further calls fail fast instead of spending requests.
   */
  private async cached<T>(
    doc: SkillSourceDoc,
    key: string,
    ttlSeconds: number,
    load: (adapter: DirectoryAdapter) => Promise<T>,
    quotaOf: (value: T) => DirectoryQuota | null,
  ): Promise<{ value: T; cached: boolean }> {
    const prefix = this.prefix(doc);
    const hit = await this.options.cache.get(prefix + key);
    if (hit) {
      try {
        return { value: JSON.parse(hit) as T, cached: true };
      } catch {
        await this.options.cache.set(prefix + key, '', 1);
      }
    }
    const limited = await this.options.cache.get(`${prefix}ratelimited`);
    if (limited !== null) throw directoryRateLimited(limited || null);
    let value: T;
    try {
      value = await load(this.adapter(doc));
    } catch (error) {
      if (error instanceof AppError && error.code === 'directory_rate_limited') {
        await this.rememberRateLimit(doc, error);
      }
      throw error;
    }
    await this.options.cache.set(prefix + key, JSON.stringify(value), ttlSeconds);
    const quota = quotaOf(value);
    if (quota) await this.rememberQuota(doc, quota);
    return { value, cached: false };
  }

  private async rememberRateLimit(doc: SkillSourceDoc, error: AppError): Promise<void> {
    const resetAt = (error.details as { resetAt?: string | null } | undefined)?.resetAt ?? null;
    const seconds = resetAt ? (Date.parse(resetAt) - Date.now()) / 1000 : UNKNOWN_RESET_SECONDS;
    if (!(seconds > 0)) return;
    await this.options.cache.set(
      `${this.prefix(doc)}ratelimited`,
      resetAt ?? '',
      Math.min(seconds, MAX_RATE_LIMIT_SECONDS),
    );
    const quota = await this.quota(doc);
    await this.rememberQuota(doc, { ...quota, remaining: 0, resetAt });
  }

  private static keyOf(kind: string, params: unknown): string {
    const digest = createHash('sha256').update(JSON.stringify(params)).digest('hex');
    return `${kind}:${digest.slice(0, 32)}`;
  }

  /** Library skill ids imported from these directory entries, keyed by external id. */
  private async importedIds(
    sourceId: ObjectId,
    externalIds: string[],
  ): Promise<Record<string, string>> {
    if (externalIds.length === 0) return {};
    const docs = await this.options.database.collections.skills
      .find(
        { 'source.sourceId': sourceId, 'source.externalId': { $in: externalIds } },
        { projection: { _id: 1, 'source.externalId': 1 } },
      )
      .toArray();
    return Object.fromEntries(
      docs.map((doc) => [doc.source?.externalId ?? '', doc._id.toHexString()]),
    );
  }

  async search(id: ObjectId, query: DirectorySearchInput) {
    const doc = await this.enabledSource(id);
    const { value, cached } = await this.cached<DirectorySearchResult>(
      doc,
      SkillDirectoryService.keyOf('search', query),
      TTL_SECONDS.search,
      (adapter) => adapter.search(query),
      (result) => result.quota,
    );
    const imported = await this.importedIds(
      doc._id,
      value.items.map((item) => item.externalId),
    );
    return {
      ...value,
      items: value.items.map((item) => ({
        ...item,
        importedSkillId: imported[item.externalId] ?? null,
      })),
      quota: await this.quota(doc),
      cached,
    };
  }

  async categories(id: ObjectId): Promise<{ items: DirectoryCategory[]; cached: boolean }> {
    const doc = await this.enabledSource(id);
    const { value, cached } = await this.cached(
      doc,
      'categories',
      TTL_SECONDS.categories,
      (adapter) => adapter.categories(),
      () => null,
    );
    return { items: value, cached };
  }

  private loadDetail(doc: SkillSourceDoc, slug: string) {
    return this.cached<DirectoryDetail>(
      doc,
      SkillDirectoryService.keyOf('detail', slug),
      TTL_SECONDS.detail,
      (adapter) => adapter.get(slug),
      (detail) => detail.quota,
    );
  }

  async detail(id: ObjectId, slug: string) {
    const doc = await this.enabledSource(id);
    const { value, cached } = await this.loadDetail(doc, slug);
    const imported = await this.importedIds(doc._id, [value.skill.externalId]);
    return {
      skill: value.skill,
      content: value.content,
      importedSkillId: imported[value.skill.externalId] ?? null,
      quota: await this.quota(doc),
      cached,
    };
  }

  /** Ask the provider for its status now, without the cache, e.g. for "Test connection". */
  async status(id: ObjectId): Promise<DirectoryStatus> {
    const doc = await this.options.sources.getDoc(id);
    try {
      const status = await this.adapter(doc).status();
      await this.rememberQuota(doc, status.quota);
      return status;
    } catch (error) {
      if (error instanceof AppError && error.code === 'directory_rate_limited') {
        await this.rememberRateLimit(doc, error);
      }
      throw error;
    }
  }

  /**
   * Import a directory entry into the skill library, or replace the earlier import of the same
   * entry when asked to. The skill is never assigned to an agent here.
   */
  async import(
    id: ObjectId,
    input: ImportDirectorySkillInput,
    actor: AuditActor,
    ip: string | null,
  ): Promise<{ skill: Skill; replaced: boolean }> {
    const doc = await this.enabledSource(id);
    const { value: detail } = await this.loadDetail(doc, input.slug);
    const skills = this.options.database.collections.skills;
    const existing = await skills.findOne({
      'source.sourceId': doc._id,
      'source.externalId': detail.skill.externalId,
    });
    if (existing && !input.replaceExisting) {
      throw new AppError(409, 'already_imported', 'This skill was already imported', {
        skillId: existing._id.toHexString(),
        name: existing.name,
      });
    }
    const now = new Date();
    const fields = importFields(doc, detail, input.name ?? existing?.name ?? null, now);
    try {
      const saved = await this.options.database.inTransaction(async (session) => {
        const stored = existing
          ? await skills.findOneAndUpdate(
              { _id: existing._id },
              { $set: fields },
              { returnDocument: 'after', session },
            )
          : { _id: new ObjectId(), ...fields, files: [], createdAt: now };
        if (!stored) throw new AppError(404, 'not_found', 'Skill not found');
        if (!existing) await skills.insertOne(stored, { session });
        await this.options.audit.write(
          {
            action: 'skill.imported',
            actor,
            ip,
            details: {
              skillId: stored._id.toHexString(),
              sourceId: doc._id.toHexString(),
              provider: doc.provider,
              slug: detail.skill.slug,
              externalId: detail.skill.externalId,
              contentHash: fields.source?.contentHash ?? null,
              replaced: existing !== null,
            },
          },
          session,
        );
        return stored;
      });
      return { skill: toSkill(saved), replaced: existing !== null };
    } catch (error) {
      throw importConflict(error, fields.name);
    }
  }
}
