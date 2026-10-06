import type { FastifyBaseLogger } from 'fastify';
import { ObjectId, type ClientSession } from 'mongodb';
import {
  SKILL_SOURCE_PROVIDER_INFO,
  type CreateSkillSourceInput,
  type SkillSource,
  type UpdateSkillSourceInput,
} from '@conclavix/core';
import type { Collections, SkillSourceDoc } from '../../db.js';
import { AppError, conflict, isDuplicateKeyError, notFound } from '../../errors.js';
import type { SecretBox } from '../settings/secret-box.js';
import { assertSafeDirectoryUrl } from './net-guard.js';

/** The endpoint a source talks to: its own base URL or the provider default. */
export const effectiveBaseUrl = (doc: Pick<SkillSourceDoc, 'baseUrl' | 'provider'>): string =>
  doc.baseUrl ?? SKILL_SOURCE_PROVIDER_INFO[doc.provider].defaultBaseUrl;

/** The API view of a source: never the key, only whether one is stored. */
export const toSkillSource = (doc: SkillSourceDoc): SkillSource => ({
  id: doc._id.toHexString(),
  name: doc.name,
  provider: doc.provider,
  baseUrl: effectiveBaseUrl(doc),
  baseUrlIsDefault: doc.baseUrl === null,
  enabled: doc.enabled,
  hasApiKey: doc.apiKeyEncrypted !== null,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

/** Names of the changed fields for the audit log; the key shows as set or removed, never its value. */
export type SourceChanges = Record<string, string | boolean>;

async function uniqueName<T>(name: string | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw conflict(`A skill directory named ${name ?? ''} already exists`);
    }
    throw error;
  }
}

/** Skill directory sources with their API keys sealed by the settings SecretBox. */
export class SkillSourceRepository {
  constructor(
    private readonly collections: Collections,
    private readonly box: SecretBox,
    private readonly allowPrivate: boolean,
    private readonly log: FastifyBaseLogger,
  ) {}

  private checkUrl(baseUrl: string | null | undefined): void {
    if (baseUrl) assertSafeDirectoryUrl(baseUrl, this.allowPrivate);
  }

  async list(): Promise<SkillSource[]> {
    const docs = await this.collections.skillSources
      .find({}, { collation: { locale: 'en', strength: 2 } })
      .sort({ name: 1 })
      .toArray();
    return docs.map(toSkillSource);
  }

  async getDoc(id: ObjectId, session?: ClientSession): Promise<SkillSourceDoc> {
    const doc = await this.collections.skillSources.findOne(
      { _id: id },
      session ? { session } : {},
    );
    if (!doc) throw notFound('Skill directory');
    return doc;
  }

  /** The decrypted API key, or null when none is stored. */
  apiKey(doc: SkillSourceDoc): string | null {
    if (doc.apiKeyEncrypted === null) return null;
    try {
      return this.box.open(doc.apiKeyEncrypted);
    } catch (error) {
      this.log.error(
        { err: error, sourceId: doc._id.toHexString() },
        'stored skill directory API key could not be decrypted',
      );
      throw new AppError(
        422,
        'api_key_unreadable',
        'The stored API key of this directory cannot be read; enter it again',
      );
    }
  }

  async create(input: CreateSkillSourceInput, session: ClientSession): Promise<SkillSource> {
    this.checkUrl(input.baseUrl);
    const now = new Date();
    const doc: SkillSourceDoc = {
      _id: new ObjectId(),
      name: input.name,
      provider: input.provider,
      baseUrl:
        input.baseUrl && input.baseUrl !== SKILL_SOURCE_PROVIDER_INFO[input.provider].defaultBaseUrl
          ? input.baseUrl
          : null,
      apiKeyEncrypted: input.apiKey ? this.box.seal(input.apiKey) : null,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    };
    await uniqueName(input.name, () => this.collections.skillSources.insertOne(doc, { session }));
    return toSkillSource(doc);
  }

  async update(
    id: ObjectId,
    input: UpdateSkillSourceInput,
    session: ClientSession,
  ): Promise<{ source: SkillSource; changes: SourceChanges }> {
    const current = await this.getDoc(id, session);
    this.checkUrl(input.baseUrl);
    const set: Partial<SkillSourceDoc> = { updatedAt: new Date() };
    const changes: SourceChanges = {};
    if (input.name !== undefined && input.name !== current.name) {
      set.name = input.name;
      changes['name'] = true;
    }
    if (input.enabled !== undefined && input.enabled !== current.enabled) {
      set.enabled = input.enabled;
      changes['enabled'] = input.enabled;
    }
    if (input.baseUrl !== undefined) {
      const defaultUrl = SKILL_SOURCE_PROVIDER_INFO[current.provider].defaultBaseUrl;
      const next = input.baseUrl === null || input.baseUrl === defaultUrl ? null : input.baseUrl;
      if (next !== current.baseUrl) {
        set.baseUrl = next;
        changes['baseUrl'] = true;
      }
    }
    if (input.apiKey === null && current.apiKeyEncrypted !== null) {
      set.apiKeyEncrypted = null;
      changes['apiKey'] = 'removed';
    } else if (input.apiKey) {
      set.apiKeyEncrypted = this.box.seal(input.apiKey);
      changes['apiKey'] = 'set';
    } else if (changes['baseUrl'] && current.apiKeyEncrypted !== null) {
      // A stored key must never follow a changed endpoint; it has to be entered again.
      set.apiKeyEncrypted = null;
      changes['apiKey'] = 'removed';
    }
    const doc = await uniqueName(input.name, () =>
      this.collections.skillSources.findOneAndUpdate(
        { _id: id },
        { $set: set },
        { returnDocument: 'after', session },
      ),
    );
    if (!doc) throw notFound('Skill directory');
    return { source: toSkillSource(doc), changes };
  }

  async remove(id: ObjectId, session: ClientSession): Promise<SkillSourceDoc> {
    const doc = await this.collections.skillSources.findOneAndDelete({ _id: id }, { session });
    if (!doc) throw notFound('Skill directory');
    return doc;
  }
}
