import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { ObjectId } from 'mongodb';
import { roleSchema, type Author, type Role } from '@conclavix/core';
import type { Collections, UserDoc } from '../../db.js';
import { AppError } from '../../errors.js';
import type { AuditActor } from '../audit/audit.js';
import type { ApiTokenRepository } from '../tokens/repository.js';
import type { Auth } from './better-auth.js';

export type Principal =
  | {
      kind: 'user';
      userId: string;
      role: Role;
      name: string;
      email: string;
      twoFactorEnabled: boolean;
      via: 'session' | 'token';
    }
  | { kind: 'board'; role: 'owner' };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const BOARD_TOKEN_WARN_INTERVAL_MS = 10 * 60_000;

export const userRole = (doc: Pick<UserDoc, 'role'>): Role =>
  roleSchema.safeParse(doc.role).data ?? 'viewer';

function fromUserDoc(doc: UserDoc, via: 'session' | 'token'): Principal | null {
  if (doc.banned) return null;
  return {
    kind: 'user',
    userId: doc._id.toHexString(),
    role: userRole(doc),
    name: doc.name,
    email: doc.email,
    twoFactorEnabled: doc.twoFactorEnabled === true,
    via,
  };
}

/** Whoever acts on the board: a session user, a personal API token, or the legacy board token. */
export class PrincipalResolver {
  private readonly boardDigest: Buffer | null;
  private lastBoardWarning = 0;

  constructor(
    private readonly auth: Auth,
    private readonly collections: Collections,
    private readonly tokens: ApiTokenRepository,
    boardToken: string | undefined,
    private readonly log: FastifyBaseLogger,
  ) {
    this.boardDigest = boardToken ? digest(boardToken) : null;
  }

  /** A bearer header is authoritative: when it is invalid the session cookie is not consulted. */
  async resolve(request: FastifyRequest, allowBearer = true): Promise<Principal | null> {
    const header = request.headers.authorization ?? '';
    if (allowBearer && header.startsWith('Bearer ')) {
      return this.fromBearer(header.slice('Bearer '.length).trim());
    }
    return this.fromSession(request);
  }

  private async fromBearer(token: string): Promise<Principal | null> {
    if (!token) return null;
    if (this.boardDigest && timingSafeEqual(digest(token), this.boardDigest)) {
      this.warnBoardToken();
      return { kind: 'board', role: 'owner' };
    }
    const userId = await this.tokens.authenticate(token);
    if (!userId) return null;
    const user = await this.collections.users.findOne({ _id: userId });
    return user ? fromUserDoc(user, 'token') : null;
  }

  private async fromSession(request: FastifyRequest): Promise<Principal | null> {
    if (!request.headers.cookie) return null;
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session || !ObjectId.isValid(session.user.id)) return null;
    const user = await this.collections.users.findOne({ _id: new ObjectId(session.user.id) });
    return user ? fromUserDoc(user, 'session') : null;
  }

  private warnBoardToken(): void {
    const now = Date.now();
    if (now - this.lastBoardWarning < BOARD_TOKEN_WARN_INTERVAL_MS) return;
    this.lastBoardWarning = now;
    this.log.warn(
      'BOARD_TOKEN was used: it is deprecated, acts as an owner and will be removed; use a personal API token',
    );
  }
}

export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) {
    throw new AppError(401, 'unauthorized', 'Missing or invalid credentials');
  }
  return request.principal;
}

/** The signed-in user; the board token is no user and cannot use per-user endpoints. */
export function requireUser(request: FastifyRequest): Extract<Principal, { kind: 'user' }> {
  const principal = requirePrincipal(request);
  if (principal.kind !== 'user') {
    throw new AppError(422, 'not_a_user', 'The board token has no user profile');
  }
  return principal;
}

export type BoardSideAuthor = Extract<Author, { type: 'board' } | { type: 'user' }>;

export function authorOf(principal: Principal): BoardSideAuthor {
  return principal.kind === 'user' ? { type: 'user', userId: principal.userId } : { type: 'board' };
}

export function actorOf(principal: Principal | null): AuditActor {
  if (!principal) return null;
  return principal.kind === 'user' ? { type: 'user', userId: principal.userId } : { type: 'board' };
}
