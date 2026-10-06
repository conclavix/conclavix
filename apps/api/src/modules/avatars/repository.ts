import { Binary, ObjectId } from 'mongodb';
import type { AvatarDoc, AvatarOwnerType, Database } from '../../db.js';
import { notFound } from '../../errors.js';
import type { ProcessedAvatar } from './image.js';
import type { AvatarOwnerHandler } from './owners.js';

export interface AvatarOwner {
  type: AvatarOwnerType;
  id: string;
}

export interface StoredAvatar {
  data: Buffer;
  contentType: string;
  etag: string;
  updatedAt: Date;
}

export interface AvatarSummary {
  owner: AvatarOwner;
  contentType: string;
  size: number;
  width: number;
  height: number;
  etag: string;
  updatedAt: Date;
}

const ownerFilter = (owner: AvatarOwner) => ({ 'owner.type': owner.type, 'owner.id': owner.id });

const toSummary = (doc: AvatarDoc): AvatarSummary => ({
  owner: doc.owner,
  contentType: doc.contentType,
  size: doc.size,
  width: doc.width,
  height: doc.height,
  etag: doc.etag,
  updatedAt: doc.updatedAt,
});

export class AvatarRepository {
  constructor(private readonly database: Database) {}

  private get avatars() {
    return this.database.collections.avatars;
  }

  /** Return the stored image for an owner, or null when none is set. */
  async find(owner: AvatarOwner): Promise<StoredAvatar | null> {
    const doc = await this.avatars.findOne(ownerFilter(owner));
    if (!doc) {
      return null;
    }
    return {
      data: Buffer.from(doc.data.buffer),
      contentType: doc.contentType,
      etag: doc.etag,
      updatedAt: doc.updatedAt,
    };
  }

  /** Replace the owner's avatar and mirror its ETag onto the owner in one transaction. */
  async save(
    owner: AvatarOwner,
    handler: AvatarOwnerHandler,
    image: ProcessedAvatar,
  ): Promise<AvatarSummary> {
    const now = new Date();
    const doc = await this.database.inTransaction(async (session) => {
      await handler.assertExists(owner.id, session);
      const saved = await this.avatars.findOneAndUpdate(
        ownerFilter(owner),
        {
          $set: {
            contentType: image.contentType,
            data: new Binary(image.data),
            size: image.data.length,
            width: image.width,
            height: image.height,
            etag: image.etag,
            updatedAt: now,
          },
          $setOnInsert: { _id: new ObjectId(), createdAt: now },
        },
        { upsert: true, returnDocument: 'after', session },
      );
      await handler.onChange(owner.id, image.etag, session);
      return saved;
    });
    if (!doc) {
      throw notFound(`${handler.label} avatar`);
    }
    return toSummary(doc);
  }

  /** Delete the owner's avatar and clear the mirrored ETag, raising 404 when there is none. */
  async remove(owner: AvatarOwner, handler: AvatarOwnerHandler): Promise<void> {
    await this.database.inTransaction(async (session) => {
      const result = await this.avatars.deleteOne(ownerFilter(owner), { session });
      if (result.deletedCount === 0) {
        throw notFound(`${handler.label} avatar`);
      }
      await handler.onChange(owner.id, null, session);
    });
  }
}
