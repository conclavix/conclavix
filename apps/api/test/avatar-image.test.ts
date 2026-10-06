import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { detectImageFormat, processAvatar } from '../src/modules/avatars/image.js';
import { pixelBombPng, rotatedJpegWithExif, solidPng, SVG } from './fixtures/images.js';

describe('avatar image processing', () => {
  it('detects formats by magic bytes only', async () => {
    expect(detectImageFormat(await solidPng(4, 4))).toBe('png');
    expect(
      detectImageFormat(
        await sharp(await solidPng(4, 4))
          .jpeg()
          .toBuffer(),
      ),
    ).toBe('jpeg');
    expect(
      detectImageFormat(
        await sharp(await solidPng(4, 4))
          .webp()
          .toBuffer(),
      ),
    ).toBe('webp');
    expect(
      detectImageFormat(
        await sharp(await solidPng(4, 4))
          .gif()
          .toBuffer(),
      ),
    ).toBe('gif');
    expect(detectImageFormat(SVG)).toBeNull();
    expect(detectImageFormat(Buffer.from('hello world, not an image'))).toBeNull();
  });

  it('centre-crops to a 256x256 WebP', async () => {
    const result = await processAvatar(await solidPng(900, 300));
    const metadata = await sharp(result.data).metadata();
    expect(result.contentType).toBe('image/webp');
    expect(metadata).toMatchObject({ format: 'webp', width: 256, height: 256 });
    expect(result.data.length).toBeLessThan(100 * 1024);
  });

  it('applies EXIF orientation and strips all metadata', async () => {
    const input = await rotatedJpegWithExif();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const result = await processAvatar(input);
    const metadata = await sharp(result.data).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(result.data.includes(Buffer.from('secret-owner'))).toBe(false);

    const { data } = await sharp(result.data).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset = (y * 256 + x) * 3;
      return [data[offset], data[offset + 1], data[offset + 2]];
    };
    const [topRed, , topBlue] = pixel(128, 20);
    const [bottomRed, , bottomBlue] = pixel(128, 235);
    expect(topRed).toBeGreaterThan(200);
    expect(topBlue).toBeLessThan(60);
    expect(bottomBlue).toBeGreaterThan(200);
    expect(bottomRed).toBeLessThan(60);
  });

  it('refuses a pixel bomb before decoding it', async () => {
    const error = await processAvatar(pixelBombPng()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 422, code: 'image_too_large' });
  });

  it('rejects truncated images and SVG', async () => {
    const truncated = (await solidPng(64, 64)).subarray(0, 40);
    await expect(processAvatar(truncated)).rejects.toMatchObject({ statusCode: 422 });
    await expect(processAvatar(SVG)).rejects.toMatchObject({ statusCode: 415 });
  });

  it('produces a stable ETag for the same input', async () => {
    const input = await solidPng(300, 300);
    const [first, second] = await Promise.all([processAvatar(input), processAvatar(input)]);
    expect(first.etag).toBe(second.etag);
    expect(first.etag).toMatch(/^[A-Za-z0-9_-]{27}$/);
  });
});
