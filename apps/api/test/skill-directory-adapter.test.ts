import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors.js';
import type { HttpResponse, HttpTransport } from '../src/modules/skill-sources/http.js';
import {
  CONTENT_ON_PAID_PLAN,
  SkillsDirectoryAdapter,
  contentHash,
  nextUtcMidnight,
  resetAtOf,
} from '../src/modules/skill-sources/skillsdirectory.js';
import { frontmatterDescription, splitFrontmatter } from '../src/modules/skill-sources/service.js';

const BASE = 'https://www.skillsdirectory.com/api/v1';

const freeSkill = {
  id: 'abc',
  name: 'PDF   Tools',
  slug: 'pdf-tools',
  description: 'Extract\ntext',
  category: 'documents',
  authorName: 'Ada',
  authorUrl: 'https://example.com/ada',
  authorAvatar: 'http://example.com/ada.png',
  githubStars: 42,
  isVerified: true,
  tags: ['pdf', { name: 'docs' }],
  voteCount: 7,
  viewCount: 100,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
};

const listBody = (data: unknown[], meta = { requestsRemaining: 97, tier: 'free' }) => ({
  data,
  pagination: {
    page: 2,
    limit: 10,
    totalCount: 11,
    totalPages: 2,
    hasNextPage: false,
    hasPrevPage: true,
  },
  meta,
});

const reply = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

function adapterWith(
  response: HttpResponse | (() => Promise<HttpResponse>),
  apiKey: string | null = 'secret-key',
) {
  const transport = vi.fn<HttpTransport>(async () =>
    typeof response === 'function' ? response() : response,
  );
  const adapter = new SkillsDirectoryAdapter({
    baseUrl: `${BASE}/`,
    apiKey,
    transport,
    userAgent: 'Conclavix/test',
  });
  return { adapter, transport };
}

const errorOf = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an error');
};

describe('skillsdirectory adapter', () => {
  it('maps a free-tier search page and sends key, user agent and paging', async () => {
    const { adapter, transport } = adapterWith(reply(200, listBody([freeSkill])));
    const result = await adapter.search({
      q: 'pdf',
      category: 'documents',
      sort: 'stars',
      page: 2,
      limit: 10,
    });
    const [url, request] = transport.mock.calls[0] ?? [];
    expect(url?.toString()).toBe(
      `${BASE}/skills?sort=stars&limit=10&offset=10&q=pdf&category=documents`,
    );
    expect(request?.headers).toMatchObject({
      'x-api-key': 'secret-key',
      'user-agent': 'Conclavix/test',
    });
    expect(result).toMatchObject({
      page: 2,
      limit: 10,
      total: 11,
      totalPages: 2,
      hasNextPage: false,
    });
    expect(result.quota).toEqual({ remaining: 97, limit: null, tier: 'free', resetAt: null });
    expect(result.items[0]).toEqual({
      externalId: 'abc',
      slug: 'pdf-tools',
      name: 'PDF Tools',
      description: 'Extract text',
      category: 'documents',
      author: { name: 'Ada', url: 'https://example.com/ada', avatarUrl: null },
      tags: ['pdf', 'docs'],
      stars: 42,
      votes: 7,
      views: 100,
      verified: true,
      securityGrade: null,
      securityScore: null,
      githubUrl: null,
      webUrl: 'https://www.skillsdirectory.com/skills/pdf-tools',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('omits the key header when no key is stored', async () => {
    const { adapter, transport } = adapterWith(reply(200, listBody([])), null);
    await adapter.search({ sort: 'recent', page: 1, limit: 20 });
    expect(transport.mock.calls[0]?.[1].headers).not.toHaveProperty('x-api-key');
  });

  it('reports content as unavailable on the free tier', async () => {
    const { adapter } = adapterWith(
      reply(200, { data: freeSkill, meta: { requestsRemaining: 5, tier: 'free' } }),
    );
    const detail = await adapter.get('pdf-tools');
    expect(detail.content).toEqual({
      available: false,
      reason: 'tier',
      message: CONTENT_ON_PAID_PLAN,
    });
    expect(await adapter.fetchContent('pdf-tools')).toEqual(detail.content);
  });

  it('reads paid-plan content, security grade and GitHub URL when present', async () => {
    const content = '# PDF\n\nSteps';
    const { adapter, transport } = adapterWith(
      reply(200, {
        data: {
          ...freeSkill,
          content,
          security: { grade: 'B', score: 81 },
          repoUrl: 'https://github.com/example/pdf',
        },
        meta: { requestsRemaining: 900, tier: 'pro' },
      }),
    );
    const detail = await adapter.get('pdf tools/../x');
    expect(transport.mock.calls[0]?.[0].pathname).toBe('/api/v1/skills/pdf%20tools%2F..%2Fx');
    expect(detail.content).toEqual({ available: true, content, contentHash: contentHash(content) });
    expect(detail.skill).toMatchObject({
      securityGrade: 'B',
      securityScore: 81,
      githubUrl: 'https://github.com/example/pdf',
    });
  });

  it('says "missing" when a paid plan sends no content', async () => {
    const { adapter } = adapterWith(reply(200, { data: freeSkill, meta: { tier: 'pro' } }));
    expect((await adapter.get('pdf-tools')).content).toMatchObject({
      available: false,
      reason: 'missing',
    });
  });

  it('ignores GitHub URLs that are not on github.com', async () => {
    const { adapter } = adapterWith(
      reply(200, {
        data: { ...freeSkill, githubUrl: 'https://evil.example/x' },
        meta: { tier: 'pro' },
      }),
    );
    expect((await adapter.get('pdf-tools')).skill.githubUrl).toBeNull();
  });

  it('maps categories in order without inactive ones, and the stats', async () => {
    const categories = adapterWith(
      reply(200, {
        data: [
          {
            id: '2',
            slug: 'b',
            name: 'B',
            description: null,
            icon: 'x',
            orderPosition: 2,
            active: true,
          },
          {
            id: '1',
            slug: 'a',
            name: 'A',
            description: 'first',
            icon: 'x',
            orderPosition: 1,
            active: true,
          },
          {
            id: '3',
            slug: 'c',
            name: 'C',
            description: null,
            icon: 'x',
            orderPosition: 0,
            active: false,
          },
        ],
      }),
    );
    expect(await categories.adapter.categories()).toEqual([
      { slug: 'a', name: 'A', description: 'first' },
      { slug: 'b', name: 'B', description: null },
    ]);
    const stats = adapterWith(
      reply(200, {
        data: {
          key: { prefix: 'sd_abc', name: 'k', tier: 'free', status: 'active' },
          usage: { today: 3, remaining: 97, limit: 100, resetAt: '2026-10-06T00:00:00.000Z' },
        },
      }),
    );
    const status = await stats.adapter.status();
    expect(status).toEqual({
      tier: 'free',
      keyStatus: 'active',
      quota: { remaining: 97, limit: 100, tier: 'free', resetAt: '2026-10-06T00:00:00.000Z' },
    });
    expect(JSON.stringify(status)).not.toContain('sd_abc');
  });

  it('maps 401, 403, 404, 5xx and malformed answers to directory errors', async () => {
    expect((await errorOf(adapterWith(reply(401, {})).adapter.categories())).code).toBe(
      'directory_auth_failed',
    );
    expect((await errorOf(adapterWith(reply(403, {})).adapter.categories())).code).toBe(
      'directory_auth_failed',
    );
    expect((await errorOf(adapterWith(reply(404, {})).adapter.get('x'))).statusCode).toBe(404);
    const server = await errorOf(adapterWith(reply(503, 'down')).adapter.categories());
    expect(server).toMatchObject({ statusCode: 502, code: 'directory_unavailable' });
    expect((await errorOf(adapterWith(reply(200, 'not json')).adapter.categories())).code).toBe(
      'directory_invalid_response',
    );
    expect(
      (await errorOf(adapterWith(reply(200, { data: [{ slug: 1 }] })).adapter.categories())).code,
    ).toBe('directory_invalid_response');
    expect(
      (
        await errorOf(
          adapterWith(reply(200, { items: [] })).adapter.search({
            sort: 'recent',
            page: 1,
            limit: 5,
          }),
        )
      ).code,
    ).toBe('directory_invalid_response');
  });

  it('maps 429 with the reset time from the body, the headers or the next UTC midnight', async () => {
    const fromBody = await errorOf(
      adapterWith(
        reply(429, { error: 'limit', resetAt: '2026-10-06T00:00:00Z' }),
      ).adapter.categories(),
    );
    expect(fromBody).toMatchObject({
      statusCode: 429,
      code: 'directory_rate_limited',
      details: { resetAt: '2026-10-06T00:00:00.000Z' },
    });
    const now = new Date('2026-10-05T12:00:00Z');
    expect(resetAtOf(reply(429, '', { 'x-ratelimit-reset': '1791244800' }), now)).toBe(
      new Date(1791244800 * 1000).toISOString(),
    );
    expect(resetAtOf(reply(429, '', { 'retry-after': '60' }), now)).toBe(
      '2026-10-05T12:01:00.000Z',
    );
    expect(resetAtOf(reply(429, 'nope'), now)).toBe('2026-10-06T00:00:00.000Z');
    expect(nextUtcMidnight(now)).toBe('2026-10-06T00:00:00.000Z');
  });

  it('passes transport errors such as timeouts through unchanged', async () => {
    const timeout = new AppError(504, 'directory_timeout', 'slow');
    const { adapter } = adapterWith(() => Promise.reject(timeout));
    expect(await errorOf(adapter.categories())).toBe(timeout);
  });
});

describe('SKILL.md frontmatter handling', () => {
  it('splits the frontmatter off and reads its description', () => {
    const text = '---\nname: x\ndescription: "Does \\"x\\""\n---\n\n# Body\n';
    const { frontmatter, body } = splitFrontmatter(text);
    expect(body).toBe('# Body\n');
    expect(frontmatterDescription(frontmatter)).toBe('Does "x"');
    expect(frontmatterDescription('description: plain words')).toBe('plain words');
    expect(frontmatterDescription("description: 'single'")).toBe('single');
    expect(splitFrontmatter('# No frontmatter')).toEqual({
      frontmatter: null,
      body: '# No frontmatter',
    });
  });
});
