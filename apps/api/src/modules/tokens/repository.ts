import { createHash, randomBytes } from 'node:crypto';
import { ObjectId, type ClientSession } from 'mongodb';
import type { ApiTokenSummary, CreateApiTokenInput } from '@conclavix/core';
import type { ApiTokenDoc, Collections } from '../../db.js';

export const API_TOKEN_PREFIX = 'cvx_pat_';
const LAST_USED_RESOLUTION_MS = 60_000;
const DAY_MS = 86_400_000;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

function toSummary(doc: ApiTokenDoc): ApiTokenSummary {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    prefix: doc.prefix,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
    lastUsedAt: doc.lastUsedAt,
  };
}

/**
 * Personal API tokens. Only a SHA-256 hash is stored; the token itself is returned once at
 * creation. Lookups go by hash, so the comparison never touches the secret directly.
 */
export class ApiTokenRepository {
  constructor(private readonly collections: Collections) {}

  async create(
    userId: ObjectId,
    input: CreateApiTokenInput,
    session?: ClientSession,
  ): Promise<{ token: string; summary: ApiTokenSummary }> {
    const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const now = new Date();
    const doc: ApiTokenDoc = {
      _id: new ObjectId(),
      userId,
      name: input.name,
      prefix: token.slice(0, API_TOKEN_PREFIX.length + 4),
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt: input.expiresInDays
        ? new Date(now.getTime() + input.expiresInDays * DAY_MS)
        : null,
      lastUsedAt: null,
    };
    await this.collections.apiTokens.insertOne(doc, session ? { session } : {});
    return { token, summary: toSummary(doc) };
  }

  async list(userId: ObjectId): Promise<ApiTokenSummary[]> {
    const docs = await this.collections.apiTokens
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();
    return docs.map(toSummary);
  }

  async revoke(
    userId: ObjectId,
    id: ObjectId,
    session?: ClientSession,
  ): Promise<ApiTokenSummary | null> {
    const doc = await this.collections.apiTokens.findOneAndDelete(
      { _id: id, userId },
      session ? { session } : {},
    );
    return doc ? toSummary(doc) : null;
  }

  /** Revoke every token of the user; returns how many were removed. */
  async revokeAll(userId: ObjectId, session?: ClientSession): Promise<number> {
    const result = await this.collections.apiTokens.deleteMany(
      { userId },
      session ? { session } : {},
    );
    return result.deletedCount;
  }

  /** The token's owner id when the token exists and has not expired. */
  async authenticate(token: string): Promise<ObjectId | null> {
    if (!token.startsWith(API_TOKEN_PREFIX)) return null;
    const doc = await this.collections.apiTokens.findOne({ tokenHash: hashToken(token) });
    const now = new Date();
    if (!doc || (doc.expiresAt && doc.expiresAt <= now)) return null;
    if (!doc.lastUsedAt || now.getTime() - doc.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
      await this.collections.apiTokens.updateOne({ _id: doc._id }, { $set: { lastUsedAt: now } });
    }
    return doc.userId;
  }
}
