import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toStreamEvent } from '../src/modules/stream/events.js';
import { MAX_UPLOAD_BYTES } from '../src/modules/avatars/image.js';
import { createTestContext, type TestContext } from './helpers.js';
import { multipartBody, pixelBombPng, solidPng, SVG } from './fixtures/images.js';

const claude = { type: 'claude_cli', model: 'opus' } as const;

describe('avatars', () => {
  let ctx: TestContext;

  const createAgent = async (name: string): Promise<{ id: string }> =>
    (
      await ctx.request({
        method: 'POST',
        url: '/api/agents',
        payload: { name, role: 'engineer', adapter: claude },
      })
    ).json();

  const upload = (id: string, data: Buffer, filename = 'avatar.png', type = 'image/png') =>
    ctx.request({
      method: 'PUT',
      url: `/api/avatars/agent/${id}`,
      ...multipartBody(data, filename, type),
    });

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('stores a 256x256 WebP and exposes it on the agent', async () => {
    const agent = await createAgent('Avatar One');
    const response = await upload(agent.id, await solidPng(640, 480));
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      owner: { type: 'agent', id: agent.id },
      contentType: 'image/webp',
      width: 256,
      height: 256,
      url: `/api/avatars/agent/${agent.id}?v=${body.etag}`,
    });

    const image = await ctx.request({ method: 'GET', url: body.url });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/webp');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.headers['cache-control']).toBe('private, max-age=60, must-revalidate');
    expect(image.headers['etag']).toBe(`"${body.etag}"`);
    expect(await sharp(image.rawPayload).metadata()).toMatchObject({
      format: 'webp',
      width: 256,
      height: 256,
    });

    const fetched = (await ctx.request({ method: 'GET', url: `/api/agents/${agent.id}` })).json();
    expect(fetched.avatarUrl).toBe(body.url);
    const listed = (await ctx.request({ method: 'GET', url: '/api/agents' })).json();
    expect(listed.items.find((item: { id: string }) => item.id === agent.id).avatarUrl).toBe(
      body.url,
    );
    const chart = (await ctx.request({ method: 'GET', url: '/api/org-chart' })).json();
    expect(chart.roots.find((node: { id: string }) => node.id === agent.id).avatarUrl).toBe(
      body.url,
    );
  });

  it('answers 304 when If-None-Match carries the current ETag', async () => {
    const agent = await createAgent('Avatar Cache');
    const { etag } = (await upload(agent.id, await solidPng(64, 64))).json();
    const url = `/api/avatars/agent/${agent.id}`;
    const fresh = await ctx.request({
      method: 'GET',
      url,
      headers: { 'if-none-match': `W/"other", "${etag}"` },
    });
    expect(fresh.statusCode).toBe(304);
    expect(fresh.rawPayload.length).toBe(0);
    expect(fresh.headers['etag']).toBe(`"${etag}"`);

    const stale = await ctx.request({ method: 'GET', url, headers: { 'if-none-match': '"old"' } });
    expect(stale.statusCode).toBe(200);
  });

  it('replaces an avatar and changes the ETag', async () => {
    const agent = await createAgent('Avatar Replace');
    const first = (await upload(agent.id, await solidPng(64, 64))).json();
    const second = (
      await upload(
        agent.id,
        await sharp(await solidPng(64, 64))
          .negate()
          .jpeg()
          .toBuffer(),
      )
    ).json();
    expect(second.etag).not.toBe(first.etag);
    expect(await ctx.database.collections.avatars.countDocuments({ 'owner.id': agent.id })).toBe(1);
  });

  it('deletes an avatar and clears the agent URL', async () => {
    const agent = await createAgent('Avatar Delete');
    await upload(agent.id, await solidPng(64, 64));
    const url = `/api/avatars/agent/${agent.id}`;
    expect((await ctx.request({ method: 'DELETE', url })).statusCode).toBe(204);
    expect((await ctx.request({ method: 'GET', url })).statusCode).toBe(404);
    expect((await ctx.request({ method: 'DELETE', url })).statusCode).toBe(404);
    const fetched = (await ctx.request({ method: 'GET', url: `/api/agents/${agent.id}` })).json();
    expect(fetched.avatarUrl).toBeNull();
  });

  it('removes the avatar together with its agent', async () => {
    const agent = await createAgent('Avatar Gone');
    await upload(agent.id, await solidPng(64, 64));
    await ctx.request({ method: 'DELETE', url: `/api/agents/${agent.id}` });
    expect(await ctx.database.collections.avatars.countDocuments({ 'owner.id': agent.id })).toBe(0);
  });

  it('rejects SVG and text renamed to .png by their magic bytes', async () => {
    const agent = await createAgent('Avatar Spoof');
    const svg = await upload(agent.id, SVG, 'evil.png', 'image/png');
    expect(svg.statusCode).toBe(415);
    const text = await upload(agent.id, Buffer.from('just text'), 'notes.png', 'image/png');
    expect(text.statusCode).toBe(415);
    const realSvg = await upload(agent.id, SVG, 'logo.svg', 'image/svg+xml');
    expect(realSvg.statusCode).toBe(415);
  });

  it('rejects files over the size limit', async () => {
    const agent = await createAgent('Avatar Huge');
    const oversized = Buffer.concat([await solidPng(8, 8), Buffer.alloc(MAX_UPLOAD_BYTES)]);
    const response = await upload(agent.id, oversized);
    expect(response.statusCode).toBe(413);
  });

  it('accepts uploads above the JSON body limit but under the avatar limit', async () => {
    const agent = await createAgent('Avatar Noise');
    const noise = await sharp(randomBytes(1000 * 1000 * 3), {
      raw: { width: 1000, height: 1000, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(noise.length).toBeGreaterThan(2 * 1024 * 1024);
    const response = await upload(agent.id, noise);
    expect(response.statusCode).toBe(200);
  });

  it('rejects a pixel bomb', async () => {
    const agent = await createAgent('Avatar Bomb');
    const response = await upload(agent.id, pixelBombPng());
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('image_too_large');
  });

  it('rejects requests without a multipart file', async () => {
    const agent = await createAgent('Avatar Empty');
    const json = await ctx.request({
      method: 'PUT',
      url: `/api/avatars/agent/${agent.id}`,
      payload: { file: 'x' },
    });
    expect(json.statusCode).toBe(415);
  });

  it('answers 404 for unknown or malformed agents', async () => {
    const missing = new ObjectId().toHexString();
    expect((await upload(missing, await solidPng(8, 8))).statusCode).toBe(404);
    expect((await upload('not-an-id', await solidPng(8, 8))).statusCode).toBe(404);
    const get = await ctx.request({ method: 'GET', url: `/api/avatars/agent/${missing}` });
    expect(get.statusCode).toBe(404);
  });

  it('rejects owner types that do not exist', async () => {
    const id = new ObjectId().toHexString();
    const other = await ctx.request({ method: 'GET', url: `/api/avatars/team/${id}` });
    expect(other.statusCode).toBe(400);
  });

  it('requires the board token', async () => {
    const response = await ctx.request({
      method: 'GET',
      url: `/api/avatars/agent/${new ObjectId().toHexString()}`,
      headers: { authorization: '' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('streams the avatar URL with agent changes', () => {
    const _id = new ObjectId();
    const event = toStreamEvent({
      operationType: 'update',
      ns: { db: 'x', coll: 'agents' },
      fullDocument: { _id, name: 'A', status: 'active', avatarEtag: 'abc' },
    } as never);
    expect(event?.data['avatarUrl']).toBe(`/api/avatars/agent/${_id.toHexString()}?v=abc`);
  });
});
