import { randomBytes } from 'node:crypto';
import { ObjectId, type ClientSession } from 'mongodb';
import type { CreateUserInput, UpdateUserInput, UserSummary } from '@conclavix/core';
import { LOCKS, lock, type Database, type UserDoc } from '../../db.js';
import { AppError, conflict, isDuplicateKeyError, notFound } from '../../errors.js';
import { definedOnly, toObjectId } from '../../validation.js';
import type { AuditActor, AuditLog } from '../audit/audit.js';
import { requestPasswordResetEmail, type Auth } from '../auth/better-auth.js';
import { userRole, type Principal } from '../auth/principal.js';
import type { SettingsService } from '../settings/service.js';
import type { ApiTokenRepository } from '../tokens/repository.js';
import { toUserSummary } from './mapping.js';

/** How a new or reset password reaches the user. */
export type PasswordDelivery =
  | { delivery: 'manual' }
  | { delivery: 'email' }
  | { delivery: 'temporary'; temporaryPassword: string; reason?: 'mail_failed' };

export type Actor = Principal | 'system';

/** Audit actions that mark a completed sign-in (password only, or the second factor). */
const SIGN_IN_ACTIONS = ['auth.sign_in', 'auth.mfa_verified', 'auth.mfa_recovery_code_used'];

const forbidden = (code: string, message: string) => new AppError(403, code, message);
const isOwner = (actor: Actor) => actor === 'system' || actor.role === 'owner';
const selfId = (actor: Actor) =>
  actor !== 'system' && actor.kind === 'user' ? actor.userId : null;
const auditActor = (actor: Actor): AuditActor =>
  actor === 'system'
    ? { type: 'system' }
    : actor.kind === 'user'
      ? { type: 'user', userId: actor.userId }
      : { type: 'board' };

/**
 * User administration on top of better-auth's user, account, session and twoFactor
 * collections. Owners can only be granted or changed by owners, nobody changes their own role,
 * bans or deletes themselves, and the last active owner can never be removed.
 */
export class UserService {
  constructor(
    private readonly database: Database,
    private readonly auth: Auth,
    private readonly settings: SettingsService,
    private readonly tokens: ApiTokenRepository,
    private readonly audit: AuditLog,
    private readonly boardUrl: string,
  ) {}

  private get users() {
    return this.database.collections.users;
  }

  async list(): Promise<UserSummary[]> {
    const docs = await this.users.find().sort({ createdAt: 1 }).toArray();
    const lastSignIn = await this.lastSignIns();
    return docs.map((doc) => ({
      ...toUserSummary(doc),
      lastSignInAt: lastSignIn.get(doc._id.toHexString()) ?? null,
    }));
  }

  /** The latest successful sign-in per user, taken from the audit log. */
  private async lastSignIns(): Promise<Map<string, Date>> {
    const rows = await this.database.collections.audit
      .aggregate<{ _id: string; at: Date }>([
        { $match: { action: { $in: SIGN_IN_ACTIONS }, targetUserId: { $type: 'string' } } },
        { $group: { _id: '$targetUserId', at: { $max: '$at' } } },
      ])
      .toArray();
    return new Map(rows.map((row) => [row._id, row.at]));
  }

  async names(): Promise<{ id: string; name: string }[]> {
    const docs = await this.users
      .find({}, { projection: { name: 1 } })
      .sort({ createdAt: 1 })
      .toArray();
    return docs.map((doc) => ({ id: doc._id.toHexString(), name: doc.name }));
  }

  async get(id: string): Promise<UserSummary> {
    return toUserSummary(await this.load(id));
  }

  async countOwners(): Promise<number> {
    return this.users.countDocuments({ role: 'owner', banned: { $ne: true } });
  }

  async create(
    input: CreateUserInput,
    actor: Actor,
  ): Promise<{ user: UserSummary } & PasswordDelivery> {
    if (input.role === 'owner' && !isOwner(actor)) {
      throw forbidden('owner_required', 'Only an owner can grant the owner role');
    }
    const ctx = await this.auth.$context;
    const password = input.password ?? randomBytes(24).toString('base64url');
    const hash = await ctx.password.hash(password);
    const delivery: PasswordDelivery = input.password
      ? { delivery: 'manual' }
      : await this.passwordDelivery(password);
    const now = new Date();
    const user: UserDoc = {
      _id: new ObjectId(),
      email: input.email.toLowerCase(),
      name: input.name,
      role: input.role,
      banned: false,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    };
    const id = user._id.toHexString();
    try {
      await this.database.inTransaction(async (session) => {
        await this.users.insertOne(user, { session });
        await this.writePassword(user._id, hash, session);
        await this.audit.write(
          {
            action: 'user.created',
            actor: auditActor(actor),
            targetUserId: id,
            details: { role: input.role, delivery: delivery.delivery },
          },
          session,
        );
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw conflict('a user with this e-mail already exists');
      throw error;
    }
    try {
      // The reset endpoint must be able to read the committed user before sending mail.
      await this.deliverPassword(user.email, delivery);
    } catch (error) {
      await this.database.inTransaction(async (session) => {
        await this.database.collections.sessions.deleteMany({ userId: user._id }, { session });
        await this.database.db.collection('account').deleteMany({ userId: user._id }, { session });
        await this.users.deleteOne({ _id: user._id }, { session });
        await this.audit.write(
          {
            action: 'user.deleted',
            actor: auditActor(actor),
            targetUserId: id,
            details: { reason: 'password_delivery_failed' },
          },
          session,
        );
      });
      throw error;
    }
    return { user: toUserSummary(user), ...delivery };
  }

  async update(id: string, input: UpdateUserInput, actor: Actor): Promise<UserSummary> {
    const userId = toObjectId(id, 'User');
    await this.database.inTransaction(async (session) => {
      const target = await this.guard(userId, actor, session, input.role !== undefined);
      if (input.role !== undefined && input.role !== userRole(target)) {
        if (input.role === 'owner' && !isOwner(actor)) {
          throw forbidden('owner_required', 'Only an owner can grant the owner role');
        }
        if (userRole(target) === 'owner') await this.assertOtherOwner(userId, session);
      }
      await this.users.updateOne(
        { _id: userId },
        { $set: { ...definedOnly(input), updatedAt: new Date() } },
        { session },
      );
      if (input.role !== undefined && input.role !== userRole(target)) {
        await this.audit.write(
          {
            action: 'user.role_changed',
            actor: auditActor(actor),
            targetUserId: id,
            details: { from: userRole(target), to: input.role },
          },
          session,
        );
      }
    });
    return this.get(id);
  }

  async setBanned(id: string, banned: boolean, actor: Actor): Promise<UserSummary> {
    const userId = toObjectId(id, 'User');
    await this.database.inTransaction(async (session) => {
      const target = await this.guard(userId, actor, session, true);
      if (banned && userRole(target) === 'owner') await this.assertOtherOwner(userId, session);
      await this.users.updateOne(
        { _id: userId },
        { $set: { banned, updatedAt: new Date() } },
        { session },
      );
      if (banned) await this.endAccess(userId, session);
      await this.audit.write(
        {
          action: banned ? 'user.banned' : 'user.unbanned',
          actor: auditActor(actor),
          targetUserId: id,
        },
        session,
      );
    });
    return this.get(id);
  }

  async remove(id: string, actor: Actor): Promise<void> {
    const userId = toObjectId(id, 'User');
    await this.database.inTransaction(async (session) => {
      const target = await this.guard(userId, actor, session, true);
      if (userRole(target) === 'owner') await this.assertOtherOwner(userId, session);
      const byUser = { userId: { $in: [userId, id] } };
      await this.database.collections.sessions.deleteMany({ userId }, { session });
      await this.database.db.collection('account').deleteMany(byUser, { session });
      await this.database.db.collection('twoFactor').deleteMany(byUser, { session });
      await this.database.collections.apiTokens.deleteMany({ userId }, { session });
      await this.database.collections.avatars.deleteOne(
        { 'owner.type': 'user', 'owner.id': id },
        { session },
      );
      await this.users.deleteOne({ _id: userId }, { session });
      await this.audit.write(
        { action: 'user.deleted', actor: auditActor(actor), targetUserId: id },
        session,
      );
    });
  }

  /**
   * Reset another user's password. The reset, the end of all their sessions and API tokens and
   * the audit entry commit first; only then is the reset mail sent, so revocation never depends
   * on mail. If the mail fails, the admin gets a temporary password instead (written and audited
   * in a second transaction), so the user is never left without a way back in.
   */
  async resetPassword(id: string, password: string | undefined, actor: Actor) {
    const userId = toObjectId(id, 'User');
    const ctx = await this.auth.$context;
    const next = password ?? randomBytes(24).toString('base64url');
    const hash = await ctx.password.hash(next);
    const delivery: PasswordDelivery = password
      ? { delivery: 'manual' }
      : await this.passwordDelivery(next);
    const target = await this.database.inTransaction(async (session) => {
      const doc = await this.guard(userId, actor, session, true);
      // For e-mail delivery, the reset link sets the eventual password.
      if (delivery.delivery !== 'email') await this.writePassword(userId, hash, session);
      await this.endAccess(userId, session);
      await this.audit.write(
        {
          action: 'user.password_reset',
          actor: auditActor(actor),
          targetUserId: id,
          details: { delivery: delivery.delivery },
        },
        session,
      );
      return doc;
    });
    if (delivery.delivery !== 'email') return delivery;
    try {
      await this.deliverPassword(target.email, delivery);
      return delivery;
    } catch {
      const fallback: PasswordDelivery = {
        delivery: 'temporary',
        temporaryPassword: next,
        reason: 'mail_failed',
      };
      await this.database.inTransaction(async (session) => {
        await this.writePassword(userId, hash, session);
        await this.audit.write(
          {
            action: 'user.password_reset_mail_failed',
            actor: auditActor(actor),
            targetUserId: id,
            details: { delivery: 'temporary' },
          },
          session,
        );
      });
      return fallback;
    }
  }

  /** End every way the user is signed in: browser sessions and personal API tokens. */
  private async endAccess(userId: ObjectId, session: ClientSession): Promise<void> {
    await this.database.collections.sessions.deleteMany({ userId }, { session });
    await this.tokens.revokeAll(userId, session);
  }

  /** Native writes let credentials and audit entries share the application's MongoDB session. */
  private async writePassword(userId: ObjectId, password: string, session: ClientSession) {
    const now = new Date();
    await this.database.db
      .collection('account')
      .updateOne(
        { userId, providerId: 'credential', accountId: userId.toHexString() },
        { $set: { password, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true, session },
      );
  }

  /** Remove another user's TOTP secret and recovery codes; they enrol again on next sign-in. */
  async resetMfa(id: string, actor: Actor): Promise<UserSummary> {
    const userId = toObjectId(id, 'User');
    await this.database.inTransaction(async (session) => {
      await this.guard(userId, actor, session, true);
      await this.database.db
        .collection('twoFactor')
        .deleteMany({ userId: { $in: [userId, id] } }, { session });
      await this.users.updateOne(
        { _id: userId },
        { $set: { twoFactorEnabled: false, updatedAt: new Date() } },
        { session },
      );
      await this.audit.write(
        {
          action: 'user.mfa_reset',
          actor: auditActor(actor),
          targetUserId: id,
        },
        session,
      );
    });
    return this.get(id);
  }

  async load(id: string, session?: ClientSession): Promise<UserDoc> {
    const doc = await this.users.findOne(
      { _id: toObjectId(id, 'User') },
      session ? { session } : {},
    );
    if (!doc) throw notFound('User');
    return doc;
  }

  /** Load the target and apply the rules that hold for every change to another user. */
  private async guard(
    userId: ObjectId,
    actor: Actor,
    session: ClientSession | undefined,
    selfForbidden: boolean,
  ): Promise<UserDoc> {
    if (session) await lock(this.database.collections, LOCKS.owners, session);
    const target = await this.load(userId.toHexString(), session);
    if (selfForbidden && selfId(actor) === userId.toHexString()) {
      throw conflict('you cannot do this to your own account');
    }
    if (userRole(target) === 'owner' && !isOwner(actor)) {
      throw forbidden('owner_required', 'Only an owner can change an owner');
    }
    return target;
  }

  private async assertOtherOwner(userId: ObjectId, session: ClientSession): Promise<void> {
    const others = await this.users.countDocuments(
      { _id: { $ne: userId }, role: 'owner', banned: { $ne: true } },
      { session },
    );
    if (others === 0) {
      throw new AppError(409, 'last_owner', 'At least one active owner must remain');
    }
  }

  private async passwordDelivery(password: string): Promise<PasswordDelivery> {
    const { smtp } = await this.settings.current();
    return smtp.host && smtp.from
      ? { delivery: 'email' }
      : { delivery: 'temporary', temporaryPassword: password };
  }

  private async deliverPassword(email: string, delivery: PasswordDelivery): Promise<void> {
    if (delivery.delivery !== 'email') return;
    await requestPasswordResetEmail(this.auth, email, this.boardUrl);
  }
}
