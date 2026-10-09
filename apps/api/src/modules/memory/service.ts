import { ObjectId } from 'mongodb';
import type {
  CreateMemoryInput,
  ListMemoriesQuery,
  Memory,
  UpdateMemoryInput,
} from '@conclavix/core';
import type { Collections } from '../../db.js';
import type { BoardSideAuthor } from '../auth/principal.js';
import { conflict, isDuplicateKeyError, notFound, unprocessable } from '../../errors.js';
import type { MemoryBucket, MemoryStore } from './store.js';

export interface AgentContext {
  agentId: string;
  /** The run's project; null for chat runs without a referenced project (no project memory). */
  projectId: string | null;
}

export type AgentSearchScope = 'global' | 'project' | 'agent' | 'all';

/**
 * Who may read and write which memory. Agents read global, their run's project and their own;
 * they write their project's and their own, never global. The board sees and edits everything.
 */
export class MemoryService {
  constructor(
    private readonly store: MemoryStore,
    private readonly collections: Collections,
  ) {}

  readableBuckets(context: AgentContext, scope: AgentSearchScope): MemoryBucket[] {
    const project: MemoryBucket[] =
      context.projectId === null ? [] : [{ scope: 'project', projectId: context.projectId }];
    const all: Record<Exclude<AgentSearchScope, 'all'>, MemoryBucket[]> = {
      global: [{ scope: 'global' }],
      project,
      agent: [{ scope: 'agent', agentId: context.agentId }],
    };
    return scope === 'all' ? Object.values(all).flat() : all[scope];
  }

  agentSearch(
    context: AgentContext,
    query: string,
    scope: AgentSearchScope,
    limit: number,
  ): Promise<Memory[]> {
    return this.store.search({ buckets: this.readableBuckets(context, scope), text: query, limit });
  }

  async agentSave(
    context: AgentContext,
    input: { scope: 'project' | 'agent'; title: string; body: string; tags: string[] },
  ): Promise<{ memory: Memory; created: boolean }> {
    if (input.scope === 'project' && context.projectId === null) {
      throw unprocessable('this run has no project; save with scope "agent"');
    }
    const bucket: MemoryBucket =
      input.scope === 'project' && context.projectId !== null
        ? { scope: 'project', projectId: context.projectId }
        : { scope: 'agent', agentId: context.agentId };
    return this.store.save({
      bucket,
      title: input.title,
      body: input.body,
      tags: input.tags,
      author: { type: 'agent', agentId: context.agentId },
    });
  }

  list(query: ListMemoriesQuery): Promise<Memory[]> {
    const buckets: MemoryBucket[] | 'any' =
      query.projectId !== undefined
        ? [{ scope: 'project', projectId: query.projectId }]
        : query.agentId !== undefined
          ? [{ scope: 'agent', agentId: query.agentId }]
          : 'any';
    return this.store.search({
      buckets,
      ...(query.scope ? { scope: query.scope } : {}),
      text: query.q ?? '',
      limit: query.limit,
    });
  }

  async create(
    input: CreateMemoryInput,
    author: BoardSideAuthor,
  ): Promise<{ memory: Memory; created: boolean }> {
    const bucket = await this.boardBucket(input);
    return this.store.save({
      bucket,
      title: input.title,
      body: input.body,
      tags: input.tags,
      author,
    });
  }

  async get(id: string): Promise<Memory> {
    const memory = await this.store.get(id);
    if (!memory) throw notFound('Memory');
    return memory;
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
    const changes = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    try {
      const memory = await this.store.update(id, changes);
      if (!memory) throw notFound('Memory');
      return memory;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw conflict('another memory in this scope already has that title');
      }
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    if (!(await this.store.remove(id))) throw notFound('Memory');
  }

  private async boardBucket(input: CreateMemoryInput): Promise<MemoryBucket> {
    if (input.scope === 'project' && input.projectId) {
      if (!(await this.collections.projects.findOne({ _id: new ObjectId(input.projectId) }))) {
        throw unprocessable('projectId refers to a project that does not exist');
      }
      return { scope: 'project', projectId: input.projectId };
    }
    if (input.scope === 'agent' && input.agentId) {
      if (!(await this.collections.agents.findOne({ _id: new ObjectId(input.agentId) }))) {
        throw unprocessable('agentId refers to an agent that does not exist');
      }
      return { scope: 'agent', agentId: input.agentId };
    }
    return { scope: 'global' };
  }
}
