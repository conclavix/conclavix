import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for the skillsdirectory.com API v1. The API key picks the behaviour:
 * `free-key` answers like the free tier (no content), `pro-key` adds content, security grade and
 * GitHub URL, `limited-key` answers 429, anything else 401.
 */
export const FREE_KEY = 'free-key-0123456789';
export const PRO_KEY = 'pro-key-0123456789';
export const LIMITED_KEY = 'limited-key-0123456789';
export const RESET_AT = '2099-01-01T00:00:00.000Z';

export const SKILL_MD = [
  '---',
  'name: pdf-tools',
  'description: "Work with PDF files"',
  '---',
  '',
  '# PDF tools',
  '',
  'Use pdftotext to extract text.',
  '',
].join('\n');

const skills = [
  {
    id: 'sk_1',
    name: 'PDF Tools',
    slug: 'pdf-tools',
    description: 'Extract text and tables from PDF files',
    category: 'documents',
    authorName: 'Ada',
    authorUrl: 'https://example.com/ada',
    authorAvatar: 'https://example.com/ada.png',
    githubStars: 42,
    isVerified: true,
    tags: ['pdf', 'documents'],
    voteCount: 7,
    viewCount: 100,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  },
  {
    id: 'sk_2',
    name: 'Release Notes',
    slug: 'release-notes',
    description: 'Write release notes from merged pull requests',
    category: 'writing',
    authorName: 'Grace',
    authorUrl: null,
    authorAvatar: 'http://insecure.example.com/grace.png',
    githubStars: 3,
    isVerified: false,
    tags: ['git'],
    voteCount: 1,
    viewCount: 9,
    active: true,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
  },
];

const pro = (skill: (typeof skills)[number]) => ({
  ...skill,
  content: skill.slug === 'pdf-tools' ? SKILL_MD : `# ${skill.name}\n\nSteps.\n`,
  securityGrade: 'A',
  securityScore: 97,
  githubUrl: `https://github.com/example/${skill.slug}`,
});

export interface FakeDirectory {
  url: string;
  baseUrl: string;
  requests: { path: string; key: string | undefined; userAgent: string | undefined }[];
  close(): Promise<void>;
}

type Tier = 'free' | 'pro';
type Answer = { status: number; body: unknown };

const shape = (tier: Tier, skill: (typeof skills)[number]) => (tier === 'pro' ? pro(skill) : skill);

function list(url: URL, tier: Tier, meta: object): Answer {
  const q = url.searchParams.get('q')?.toLowerCase() ?? '';
  const category = url.searchParams.get('category');
  const limit = Number(url.searchParams.get('limit') ?? 20);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const matches = skills.filter(
    (skill) =>
      (!q || skill.name.toLowerCase().includes(q)) && (!category || skill.category === category),
  );
  const page = matches.slice(offset, offset + limit);
  return {
    status: 200,
    body: {
      data: page.map((skill) => shape(tier, skill)),
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        totalCount: matches.length,
        totalPages: Math.max(1, Math.ceil(matches.length / limit)),
        hasNextPage: offset + limit < matches.length,
        hasPrevPage: offset > 0,
      },
      meta,
    },
  };
}

function respond(request: IncomingMessage): Answer {
  const key = request.headers['x-api-key'];
  const tier: Tier | null = key === PRO_KEY ? 'pro' : key === FREE_KEY ? 'free' : null;
  if (key === LIMITED_KEY) {
    return { status: 429, body: { error: 'Rate limit exceeded', resetAt: RESET_AT } };
  }
  if (!tier) return { status: 401, body: { error: 'Invalid API key' } };
  const url = new URL(request.url ?? '/', 'http://fake');
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const meta = { requestsRemaining: tier === 'pro' ? 990 : 90, tier };
  if (path === '/skills') return list(url, tier, meta);
  const slug = /^\/skills\/([^/]+)$/.exec(path)?.[1];
  if (slug) {
    const skill = skills.find((entry) => entry.slug === slug);
    return skill
      ? { status: 200, body: { data: shape(tier, skill), meta } }
      : { status: 404, body: { error: 'Not found' } };
  }
  if (path === '/categories') {
    return {
      status: 200,
      body: {
        data: [
          {
            id: 'c2',
            slug: 'writing',
            name: 'Writing',
            description: null,
            icon: 'pen',
            orderPosition: 2,
            active: true,
          },
          {
            id: 'c1',
            slug: 'documents',
            name: 'Documents',
            description: 'Files',
            icon: 'doc',
            orderPosition: 1,
            active: true,
          },
          {
            id: 'c3',
            slug: 'hidden',
            name: 'Hidden',
            description: null,
            icon: 'x',
            orderPosition: 3,
            active: false,
          },
        ],
      },
    };
  }
  if (path === '/stats') {
    return {
      status: 200,
      body: {
        data: {
          key: { prefix: 'sd_live_ab', name: 'test', tier, status: 'active' },
          usage: { today: 10, remaining: meta.requestsRemaining, limit: 100, resetAt: RESET_AT },
        },
      },
    };
  }
  return { status: 404, body: { error: 'Not found' } };
}

/** Start the fake directory on a random loopback port. */
export async function startFakeDirectory(): Promise<FakeDirectory> {
  const requests: FakeDirectory['requests'] = [];
  const server: Server = createServer((request, response) => {
    const key = request.headers['x-api-key'];
    requests.push({
      path: request.url ?? '',
      key: Array.isArray(key) ? key[0] : key,
      userAgent: request.headers['user-agent'],
    });
    const { status, body } = respond(request);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    baseUrl: `${url}/api/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
