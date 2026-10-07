import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts secrets at rest with a key derived from AUTH_SECRET. `purpose` separates the keys of
 * different stores (settings, project secrets); an optional context is bound to each sealed value
 * as additional authenticated data, so a value cannot be moved to another record.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string, purpose = 'settings-secret-box') {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'conclavix', purpose, 32));
  }

  seal(plain: string, context?: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    if (context !== undefined) cipher.setAAD(Buffer.from(context, 'utf8'));
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }

  open(sealed: string, context?: string): string {
    const raw = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv(ALGORITHM, this.key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    if (context !== undefined) decipher.setAAD(Buffer.from(context, 'utf8'));
    return Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** The box project secrets are sealed with; its key differs from the settings key. */
export const vaultBox = (authSecret: string): SecretBox =>
  new SecretBox(authSecret, 'project-secret-box');
