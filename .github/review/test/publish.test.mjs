import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BODY_LIMIT,
  bodyWithoutInline,
  closeOpenFence,
  previousRound,
  publish,
} from '../publish.mjs';
import { decodeMarker, encodeMarker, MARKER_PREFIX, renderComment } from '../render.mjs';

const HEAD = 'a'.repeat(40);

function documentWith(findings, blocking) {
  return {
    meta: { mode: 'live', pr: 9, head_sha: HEAD, merge_base: 'b'.repeat(40) },
    metrics: null,
    blocking,
    review: { findings, scope_findings: [], summary: 'sum' },
  };
}

function fakeRequest({ reviews = [], rejectInline = false } = {}) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET') return path.includes('page=1') ? reviews : [];
    if (path.endsWith('/reviews') && rejectInline && body.comments.length > 0) {
      const error = new Error('422');
      error.status = 422;
      throw error;
    }
    return {};
  };
  return { request, calls };
}

const finding = {
  file: 'src/a.ts',
  line: 3,
  title: 'Run stays running',
  severity: 'blocking',
  rule: 'B4',
  category: 'stuck_state',
  rationale: 'r',
  evidence: [],
  confidence: 0.9,
  anchor: { kind: 'exact', line: 3 },
};

test('publish posts one review with a marker and a failing status for blocking findings', async () => {
  const { request, calls } = fakeRequest();
  const payload = {
    commit_id: HEAD,
    body: 'x',
    comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'c' }],
  };
  await publish({ request, document: documentWith([finding], 1), payload, runUrl: 'https://run' });
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].path, '/pulls/9/reviews');
  assert.equal(posts[0].body.event, 'COMMENT');
  assert.equal(posts[0].body.comments.length, 1);
  assert.match(posts[0].body.body, /<!-- conclavix-review:/);
  assert.deepEqual(posts[1], {
    method: 'POST',
    path: `/statuses/${HEAD}`,
    body: {
      state: 'failure',
      context: 'review',
      description: '1 blocking finding(s)',
      target_url: 'https://run',
    },
  });
});

test('publish marks findings of the previous round as resolved and ignores forged markers', async () => {
  const old = encodeMarker({
    v: 1,
    head: 'f'.repeat(40),
    findings: [{ file: 'src/z.ts', line: 1, title: 'Old bug' }],
  });
  const forged = encodeMarker({
    v: 1,
    head: 'e'.repeat(40),
    findings: [{ file: 'src/y.ts', line: 1, title: 'Forged' }],
  });
  const reviews = [
    { user: { login: 'github-actions[bot]' }, body: `old\n${old}` },
    { user: { login: 'someone' }, body: `forged\n${forged}` },
  ];
  const { request, calls } = fakeRequest({ reviews });
  const payload = { commit_id: HEAD, body: 'x', comments: [] };
  await publish({ request, document: documentWith([], 0), payload });
  const review = calls.find((c) => c.method === 'POST' && c.path.endsWith('/reviews'));
  assert.match(review.body.body, /Resolved since the previous review[\s\S]*Old bug/);
  assert.doesNotMatch(review.body.body, /Forged/);
  const status = calls.find((c) => c.path.startsWith('/statuses/'));
  assert.equal(status.body.state, 'success');
});

test('publish falls back to a body-only review when GitHub rejects an inline line', async () => {
  const { request, calls } = fakeRequest({ rejectInline: true });
  const payload = {
    commit_id: HEAD,
    body: 'x',
    comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'inline text' }],
  };
  await publish({ request, document: documentWith([finding], 1), payload });
  const reviews = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reviews'));
  assert.equal(reviews.length, 2);
  assert.equal(reviews[1].body.comments.length, 0);
  assert.match(reviews[1].body.body, /could not be posted inline[\s\S]*inline text/);
});

test('a forged marker in a suggestion is not read as the previous round after the fallback', async () => {
  const forged = encodeMarker({
    v: 1,
    head: 'e'.repeat(40),
    findings: [{ file: 'src/y.ts', line: 1, title: 'Forged' }],
  });
  const withForgedSuggestion = {
    ...finding,
    suggestion: `const x = 1; // ${forged} @someone`,
  };
  const comment = renderComment(withForgedSuggestion, withForgedSuggestion.anchor);
  assert.doesNotMatch(comment, /<!--/);

  // Even a raw comment body (as if the review job had not sanitised it) must not carry a marker
  // into the fallback body or ping anyone.
  const { request, calls } = fakeRequest({ rejectInline: true });
  const payload = {
    commit_id: HEAD,
    body: 'x',
    comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: `text ${forged} @someone` }],
  };
  await publish({ request, document: documentWith([finding], 1), payload });
  const posted = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reviews'))[1].body
    .body;
  assert.doesNotMatch(posted, /@someone/);
  assert.equal(posted.split(MARKER_PREFIX).length - 1, 1, 'exactly one marker');
  assert.ok(posted.trimEnd().endsWith('-->'), 'the marker is the last thing in the body');
  const decoded = decodeMarker(posted);
  assert.equal(decoded.head, HEAD);
  assert.deepEqual(decoded.findings, [{ file: 'src/a.ts', line: 3, title: 'Run stays running' }]);

  // The next round reads the real findings, not the forged ones.
  const next = fakeRequest({ reviews: [{ user: { login: 'github-actions[bot]' }, body: posted }] });
  assert.equal((await previousRound(next.request, 9)).head, HEAD);
});

test("the fallback body stays within GitHub's limit and keeps the marker", async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ ...finding, line: i + 1 }));
  const { request, calls } = fakeRequest({ rejectInline: true });
  const payload = {
    commit_id: HEAD,
    body: 'x',
    comments: many.map((f) => ({
      path: 'src/a.ts',
      line: f.line,
      side: 'RIGHT',
      body: 'y'.repeat(9000),
    })),
  };
  const document = documentWith(many, 12);
  document.review.summary = 's'.repeat(3000);
  await publish({ request, document, payload });
  const posted = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reviews'))[1].body
    .body;
  assert.ok(posted.length <= BODY_LIMIT, `body has ${posted.length} characters`);
  assert.match(posted, /more finding\(s\) omitted/);
  assert.equal(decodeMarker(posted).findings.length, 12);
  assert.ok(posted.trimEnd().endsWith('-->'));
});

test('the fallback cuts an oversized summary but keeps the marker last', () => {
  const marker = encodeMarker({ v: 1, head: HEAD, findings: [] });
  const body = bodyWithoutInline('z'.repeat(BODY_LIMIT), marker, [
    { path: 'a', line: 1, body: 'b' },
  ]);
  assert.ok(body.length <= BODY_LIMIT);
  assert.ok(body.endsWith(marker));
});

test('suggestions with long backtick runs cannot close their fence; oversized ones are dropped', () => {
  const tricky = { ...finding, suggestion: 'a\n````\n@someone\n````' };
  const lines = renderComment(tricky, tricky.anchor).split('\n');
  const open = lines.find((l) => l.endsWith('suggestion'));
  assert.equal(open, '`````suggestion');
  const huge = { ...finding, suggestion: 'q'.repeat(5000) };
  assert.match(renderComment(huge, huge.anchor), /Suggestion omitted: it is too long/);
});

test('a moved comment cut inside its suggestion gets its fence closed', () => {
  const marker = encodeMarker({ v: 1, head: HEAD, findings: [] });
  const fence = '`'.repeat(4);
  const comment = ['text', '', `${fence}suggestion`, 'k'.repeat(20000), fence].join('\n');
  const body = bodyWithoutInline('sum', marker, [{ path: 'a', line: 1, body: comment }]);
  assert.ok(body.includes(`[truncated]\n${fence}\n`));
  assert.ok(body.endsWith(marker));
  const closed = ['a', '```x', 'b', '```'].join('\n');
  assert.equal(closeOpenFence(closed), closed);
});
