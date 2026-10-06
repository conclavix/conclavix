import { createHash, randomBytes } from 'node:crypto';
import type { Collections, RunDoc } from '../../db.js';

export const RUN_TOKEN_PREFIX = 'cvx_run_';

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Generate a run token and its persisted fields without writing to the database. */
export function generateRunToken(
  ttlMs: number,
  now: Date,
): { token: string; tokenHash: string; tokenExpiresAt: Date } {
  const token = `${RUN_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashToken(token), tokenExpiresAt: new Date(now.getTime() + ttlMs) };
}

/** Resolve a token to its run if the run is still running and the token has not expired. */
export async function resolveRunToken(
  collections: Collections,
  token: string,
  now: Date,
): Promise<RunDoc | null> {
  if (!token.startsWith(RUN_TOKEN_PREFIX)) {
    return null;
  }
  return collections.runs.findOne({
    tokenHash: hashToken(token),
    status: 'running',
    tokenExpiresAt: { $gt: now },
  });
}
