import { crc32 } from 'node:zlib';
import sharp from 'sharp';

/** A solid-colour PNG of the given size. */
export const solidPng = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .png()
    .toBuffer();

/** A landscape JPEG, red on the left and blue on the right, tagged with EXIF orientation 6 and a copyright. */
export async function rotatedJpegWithExif(): Promise<Buffer> {
  const red = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 400, height: 200, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .composite([{ input: red, left: 0, top: 0 }])
    .jpeg()
    .withExif({ IFD0: { Copyright: 'secret-owner', Artist: 'secret-artist' } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/** A tiny PNG whose header claims a huge canvas, the shape of a decompression bomb. */
export function pixelBombPng(side = 50_000): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
);

/** Encode one file as a multipart/form-data body. */
export function multipartBody(
  data: Buffer,
  filename: string,
  contentType: string,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----cvx${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
