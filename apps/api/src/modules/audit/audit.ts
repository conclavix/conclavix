import { ObjectId, type ClientSession, type Filter } from 'mongodb';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditDoc, Collections } from '../../db.js';

export type AuditActor = AuditDoc['actor'];

export interface AuditEntry {
  action: string;
  actor: AuditActor;
  targetUserId?: string | null;
  ip?: string | null;
  details?: Record<string, unknown>;
}

/** Narrow the log: exact action names, one actor, and an `at` range (`to` exclusive). */
export interface AuditFilter {
  actions?: string[];
  actor?: string;
  from?: Date;
  to?: Date;
}

function toFilter(filter: AuditFilter, before?: ObjectId): Filter<AuditDoc> {
  const query: Filter<AuditDoc> = {};
  if (before) query._id = { $lt: before };
  if (filter.actions) query.action = { $in: filter.actions };
  if (filter.actor === 'board' || filter.actor === 'system' || filter.actor === 'agent') {
    query['actor.type'] = filter.actor;
  } else if (filter.actor) query['actor.userId'] = filter.actor;
  if (filter.from || filter.to) {
    query.at = {
      ...(filter.from ? { $gte: filter.from } : {}),
      ...(filter.to ? { $lt: filter.to } : {}),
    };
  }
  return query;
}

function toDoc(entry: AuditEntry): AuditDoc {
  return {
    _id: new ObjectId(),
    at: new Date(),
    action: entry.action,
    actor: entry.actor,
    targetUserId: entry.targetUserId ?? null,
    ip: entry.ip ?? null,
    details: entry.details ?? {},
  };
}

/**
 * Security events go to the audit_log collection. Callers pass ids, names and changed groups
 * only, never secrets or values.
 *
 * `write` belongs inside the transaction that makes the change: it throws, so the change and its
 * audit entry commit together or not at all. `record` is only for events whose change already
 * happened outside our transactions (better-auth's own sign-in, 2FA and password endpoints): a
 * failure there is logged, because failing the response would not undo the change.
 */
export class AuditLog {
  constructor(
    private readonly collections: Collections,
    private readonly log: FastifyBaseLogger,
  ) {}

  async write(entry: AuditEntry, session: ClientSession): Promise<void> {
    await this.collections.audit.insertOne(toDoc(entry), { session });
  }

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.collections.audit.insertOne(toDoc(entry));
    } catch (error) {
      this.log.error({ err: error, action: entry.action }, 'audit write failed');
    }
  }

  async list(limit: number, before?: ObjectId, filter: AuditFilter = {}): Promise<AuditDoc[]> {
    return this.collections.audit
      .find(toFilter(filter, before))
      .sort({ _id: -1 })
      .limit(limit)
      .toArray();
  }
}
