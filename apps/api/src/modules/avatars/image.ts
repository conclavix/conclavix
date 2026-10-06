import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { AppError } from '../../errors.js';

export const AVATAR_SIZE = 256;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 40_000_000;
export const AVATAR_CONTENT_TYPE = 'image/webp';

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif';

export interface ProcessedAvatar {
  data: Buffer;
  contentType: string;
  width: number;
  height: number;
  etag: string;
}

const startsWith = (buffer: Buffer, bytes: number[], offset = 0): boolean =>
  buffer.length >= offset + bytes.length &&
  bytes.every((byte, index) => buffer[offset + index] === byte);

/** Identify an accepted raster format from its magic bytes; anything else, SVG included, is null. */
export function detectImageFormat(buffer: Buffer): ImageFormat | null {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'png';
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return 'jpeg';
  }
  if (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'webp';
  }
  if (
    startsWith(buffer, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(buffer, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'gif';
  }
  return null;
}

const unsupported = (): AppError =>
  new AppError(415, 'unsupported_media_type', 'Avatar must be a PNG, JPEG, WebP, or GIF image');

/** Treat a decoder failure on untrusted input as a client error, keeping the cause for logs. */
function invalidImage(cause: unknown): AppError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/pixel limit/i.test(message)) {
    return new AppError(422, 'image_too_large', 'Image dimensions exceed the allowed pixel count');
  }
  return new AppError(422, 'invalid_image', 'Image could not be decoded', { reason: message });
}

/**
 * Normalise an uploaded image into a square WebP avatar.
 * The format is checked by magic bytes and again by the decoder; EXIF orientation is applied,
 * all metadata is dropped, and inputs above MAX_INPUT_PIXELS are refused before decoding.
 */
export async function processAvatar(input: Buffer): Promise<ProcessedAvatar> {
  const format = detectImageFormat(input);
  if (!format) {
    throw unsupported();
  }
  let data: Buffer;
  try {
    const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', pages: 1 });
    const metadata = await image.metadata();
    if (metadata.format !== format) {
      throw unsupported();
    }
    data = await image
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
  } catch (error) {
    throw error instanceof AppError ? error : invalidImage(error);
  }
  const etag = createHash('sha256').update(data).digest('base64url').slice(0, 27);
  return {
    data,
    contentType: AVATAR_CONTENT_TYPE,
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    etag,
  };
}
