import type { ObjectId } from 'mongodb';
import type { SkillSourceProvider } from '@conclavix/core';

/** Provenance of a skill imported from an external directory. */
export interface SkillProvenanceDoc {
  sourceId: ObjectId;
  provider: SkillSourceProvider;
  externalId: string;
  slug: string;
  url: string;
  importedAt: Date;
  contentHash: string;
}

/** A configured external skill directory; the API key is sealed with the settings SecretBox. */
export interface SkillSourceDoc {
  _id: ObjectId;
  name: string;
  provider: SkillSourceProvider;
  /** null means the provider's default endpoint. */
  baseUrl: string | null;
  apiKeyEncrypted: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}
