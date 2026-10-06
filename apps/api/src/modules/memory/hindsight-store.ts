import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Memory } from '@conclavix/core';
import { conflict } from '../../errors.js';
import type { HindsightClient, HindsightDocument } from './hindsight-client.js';
import {
  scopeFields,
  type MemoryBucket,
  type MemoryQuery,
  type MemoryStore,
  type MemoryWrite,
} from './store.js';

const ID_PREFIX = 'cvx_';
const OVERFETCH = 5;
const MAX_FETCH = 500;
const TITLE_MATCH_SCAN = 10;

const titleKey = (title: string): string => title.trim().toLowerCase().replace(/\s+/g, ' ');

/** The tag that says which bucket a document belongs to; recall filters on exactly these. */
export const bucketTag = (bucket: MemoryBucket): string =>
  bucket.scope === 'global'
    ? 'scope:global'
    : bucket.scope === 'project'
      ? `project:${bucket.projectId}`
      : `agent:${bucket.agentId}`;

/** A second tag that identifies "this title in this bucket" without using the title as id. */
const titleTag = (bucket: MemoryBucket, title: string): string =>
  `t:${createHash('sha256')
    .update(`${bucketTag(bucket)}\n${titleKey(title)}`)
    .digest('hex')
    .slice(0, 24)}`;

const jsonOf = <T>(schema: z.ZodType<T>, fallback: T) =>
  z
    .string()
    .transform((text, ctx) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'invalid JSON' });
        return z.NEVER;
      }
    })
    .pipe(schema)
    .catch(fallback);

/** What Conclavix writes into a document's metadata; anything else in a bank is ignored. */
const metadataSchema = z
  .object({
    title: z.string().min(1),
    scope: z.enum(['global', 'project', 'agent']),
    projectId: z.string().catch(''),
    agentId: z.string().catch(''),
    tags: jsonOf(z.array(z.string()), []),
    author: jsonOf(
      z.union([
        z.object({ type: z.literal('board') }),
        z.object({ type: z.literal('user'), userId: z.string() }),
        z.object({ type: z.literal('agent'), agentId: z.string() }),
      ]),
      { type: 'board' } as const,
    ),
    revision: z.coerce.number().int().min(1).catch(1),
    createdAt: z.iso.datetime({ offset: true }).optional().catch(undefined),
  })
  .refine(
    (meta) =>
      (meta.scope !== 'project' || meta.projectId !== '') &&
      (meta.scope !== 'agent' || meta.agentId !== ''),
    'project and agent memories need their owner',
  );

/** A Conclavix memory from a Hindsight document or fact, or null when it is not one of ours. */
function toMemory(
  id: string | null,
  metadata: unknown,
  body: string,
  updatedAt: string,
): Memory | null {
  const meta = metadataSchema.safeParse(metadata);
  if (!id?.startsWith(ID_PREFIX) || !meta.success) {
    return null;
  }
  const { title, scope, projectId, agentId, tags, author, revision, createdAt } = meta.data;
  return {
    id,
    scope,
    projectId: projectId || null,
    agentId: agentId || null,
    title,
    body,
    tags,
    author,
    revision,
    createdAt: new Date(createdAt ?? updatedAt),
    updatedAt: new Date(updatedAt),
  };
}

/** Documents are stored as title, blank line, body; the board wants the body alone. */
function fromDocument(doc: HindsightDocument): Memory | null {
  const memory = toMemory(doc.id, doc.document_metadata, doc.original_text ?? '', doc.updated_at);
  const prefix = `${memory?.title}\n\n`;
  return memory?.body.startsWith(prefix)
    ? { ...memory, body: memory.body.slice(prefix.length) }
    : memory;
}

const bucketOfMemory = (memory: Memory): MemoryBucket =>
  memory.scope === 'project' && memory.projectId
    ? { scope: 'project', projectId: memory.projectId }
    : memory.scope === 'agent' && memory.agentId
      ? { scope: 'agent', agentId: memory.agentId }
      : { scope: 'global' };

/**
 * Memory backed by Hindsight: one bank for the organisation, buckets as tags, Conclavix in front
 * deciding who may see which bucket. Agents searching get Hindsight's extracted facts (with the
 * source title); the board works on the original documents.
 */
export class HindsightMemoryStore implements MemoryStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly client: HindsightClient) {}

  async search(query: MemoryQuery): Promise<Memory[]> {
    if (query.buckets !== 'any' && query.buckets.length === 0) {
      return [];
    }
    const tags = query.buckets === 'any' ? null : query.buckets.map(bucketTag);
    const fetch = query.scope ? Math.min(query.limit * OVERFETCH, MAX_FETCH) : query.limit;
    const found = query.text
      ? await this.recallFacts(query.text, tags)
      : (await this.client.listDocuments(tags, 'any_strict', fetch)).map(fromDocument);
    const page = found
      .filter((memory): memory is Memory => memory !== null)
      .filter((memory) => !query.scope || memory.scope === query.scope)
      .slice(0, query.limit);
    return query.text ? page : this.withBodies(page);
  }

  /** Hindsight's document list has no text, so each listed entry is loaded on its own. */
  private async withBodies(memories: Memory[]): Promise<Memory[]> {
    const loaded = await Promise.all(memories.map((memory) => this.get(memory.id)));
    return loaded.filter((memory): memory is Memory => memory !== null);
  }

  private async recallFacts(text: string, tags: string[] | null): Promise<Memory[]> {
    const results = await this.client.recall(text, tags, 4096);
    const seen = new Set<string>();
    const now = new Date().toISOString();
    return results
      .map((result) => toMemory(result.document_id, result.metadata, result.text, now))
      .filter((memory): memory is Memory => memory !== null)
      .filter((memory) => !seen.has(memory.body) && seen.add(memory.body));
  }

  save(write: MemoryWrite): Promise<{ memory: Memory; created: boolean }> {
    return this.serialized([titleTag(write.bucket, write.title)], async () => {
      const existing = await this.findByTitle(write.bucket, write.title);
      const memory = await this.write(existing?.id ?? `${ID_PREFIX}${randomUUID()}`, write.bucket, {
        title: write.title.trim(),
        body: write.body,
        tags: write.tags,
        author: write.author,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? new Date(),
      });
      return { memory, created: !existing };
    });
  }

  async get(id: string): Promise<Memory | null> {
    if (!id.startsWith(ID_PREFIX)) return null;
    const doc = await this.client.getDocument(id);
    return doc ? fromDocument(doc) : null;
  }

  async update(
    id: string,
    changes: Partial<Pick<Memory, 'title' | 'body' | 'tags'>>,
  ): Promise<Memory | null> {
    const current = await this.get(id);
    if (!current) return null;
    const bucket = bucketOfMemory(current);
    const title = changes.title?.trim() ?? current.title;
    return this.serialized([titleTag(bucket, current.title), titleTag(bucket, title)], async () => {
      const latest = await this.get(id);
      if (!latest) return null;
      if (titleKey(latest.title) !== titleKey(current.title)) {
        throw conflict('the memory changed while you edited it; reload and try again');
      }
      const clash = await this.findByTitle(bucket, title);
      if (clash && clash.id !== id) {
        throw conflict('another memory in this scope already has that title');
      }
      return this.write(id, bucket, {
        title,
        body: changes.body ?? latest.body,
        tags: changes.tags ?? latest.tags,
        author: latest.author,
        revision: latest.revision + 1,
        createdAt: latest.createdAt,
      });
    });
  }

  remove(id: string): Promise<boolean> {
    return id.startsWith(ID_PREFIX) ? this.client.deleteDocument(id) : Promise.resolve(false);
  }

  private async findByTitle(bucket: MemoryBucket, title: string): Promise<Memory | null> {
    const docs = await this.client.listDocuments(
      [bucketTag(bucket), titleTag(bucket, title)],
      'all_strict',
      TITLE_MATCH_SCAN,
    );
    return (
      docs
        .map(fromDocument)
        .find((memory) => memory !== null && titleKey(memory.title) === titleKey(title)) ?? null
    );
  }

  private async write(
    id: string,
    bucket: MemoryBucket,
    fields: Pick<Memory, 'title' | 'body' | 'tags' | 'author' | 'revision' | 'createdAt'>,
  ): Promise<Memory> {
    const scope = scopeFields(bucket);
    await this.client.retain({
      documentId: id,
      content: `${fields.title}\n\n${fields.body}`,
      tags: [bucketTag(bucket), titleTag(bucket, fields.title)],
      metadata: {
        title: fields.title,
        scope: scope.scope,
        projectId: scope.projectId ?? '',
        agentId: scope.agentId ?? '',
        tags: JSON.stringify(fields.tags),
        author: JSON.stringify(fields.author),
        revision: String(fields.revision),
        createdAt: fields.createdAt.toISOString(),
      },
    });
    return { id, ...scope, ...fields, updatedAt: new Date() };
  }

  /** Writes touching the same titles run one after another within this process. */
  private serialized<T>(keys: string[], work: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)].sort();
    const previous = Promise.all(
      unique.map((key) => (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined)),
    );
    const next = previous.then(work);
    for (const key of unique) this.locks.set(key, next);
    const release = (): void => {
      for (const key of unique) if (this.locks.get(key) === next) this.locks.delete(key);
    };
    next.then(release, release);
    return next;
  }
}
