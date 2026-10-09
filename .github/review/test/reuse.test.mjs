import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { finalize, finalizeCarried } from '../finalize.mjs';
import { markerFor, previousRound, publish } from '../publish.mjs';
import { decodeMarker, encodeMarker } from '../render.mjs';
import { carryOver, changeFingerprint, isComplete, reuseDecision, reviewerId } from '../reuse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PREPARE = join(HERE, '..', 'prepare.mjs');
const REUSE = join(HERE, '..', 'reuse.mjs');
const BOT = { login: 'github-actions[bot]' };
const OLD = 'e'.repeat(40);
const NEW = 'f'.repeat(40);
const FP = '1'.repeat(64);
const REVIEWER = '2'.repeat(64);

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitAll(dir, message) {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', message);
  return sh(dir, 'rev-parse', 'HEAD');
}

/** main with a.ts and b.ts, branch feat changing a.ts, then a later main commit touching only b.ts. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'review-reuse-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  sh(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\nexport const keep = 0;\n');
  writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
  mkdirSync(join(dir, '.github', 'review'), { recursive: true });
  writeFileSync(join(dir, '.github', 'review', 'prompt.md'), 'review\n');
  const root = commitAll(dir, 'base');
  sh(dir, 'checkout', '-qb', 'feat');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\nexport const keep = 0;\n');
  const head = commitAll(dir, 'feat: change a\n\nBody.');
  sh(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'b.ts'), 'export const b = 2;\n');
  const later = commitAll(dir, 'later on main');
  sh(dir, 'checkout', '-q', 'feat');
  return { dir, root, head, later };
}

function fingerprintAt(dir, baseTip, head, extra = {}) {
  const run = (args) => sh(dir, '-c', 'core.quotePath=false', ...args);
  const base = sh(dir, 'merge-base', baseTip, head);
  return changeFingerprint({ base, head, title: 't', body: 'b', run, ...extra });
}

test('the fingerprint survives taking over main by merge or rebase', () => {
  const { dir, root, head, later } = repo();
  const before = fingerprintAt(dir, root, head);
  sh(dir, 'merge', '-q', '--no-edit', 'main');
  const merged = sh(dir, 'rev-parse', 'HEAD');
  assert.equal(fingerprintAt(dir, later, merged), before);
  sh(dir, 'reset', '-q', '--hard', head);
  sh(dir, 'rebase', '-q', 'main');
  const rebased = sh(dir, 'rev-parse', 'HEAD');
  assert.notEqual(rebased, head);
  assert.equal(fingerprintAt(dir, later, rebased), before);
});

test('the fingerprint changes with one changed line, whitespace, mode, rename and claims', () => {
  const { dir, root, head } = repo();
  const before = fingerprintAt(dir, root, head);
  const variant = (change) => {
    sh(dir, 'checkout', '-q', '--detach', head);
    change();
    return fingerprintAt(dir, root, commitAll(dir, 'feat: change a\n\nBody.'));
  };
  const seen = new Set([before]);
  for (const change of [
    () => writeFileSync(join(dir, 'a.ts'), 'export const a = 3;\nexport const keep = 0;\n'),
    () => writeFileSync(join(dir, 'a.ts'), 'export const a = 2; \nexport const keep = 0;\n'),
    () => chmodSync(join(dir, 'a.ts'), 0o755),
    () => renameSync(join(dir, 'b.ts'), join(dir, 'c.ts')),
  ]) {
    const fp = variant(change);
    assert.equal(seen.has(fp), false);
    seen.add(fp);
  }
  assert.notEqual(fingerprintAt(dir, root, head, { title: 'other' }), before);
  assert.notEqual(fingerprintAt(dir, root, head, { body: 'other' }), before);
});

test('the reviewer id follows the trusted tree, the model and the threshold', () => {
  const { dir, root, later } = repo();
  const run = (args) => sh(dir, ...args);
  const id = (source, model = 'm', minConfidence = '0.6') =>
    reviewerId({ source, model, minConfidence, run });
  assert.equal(id(root), id(later));
  sh(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, '.github', 'review', 'prompt.md'), 'review harder\n');
  const changed = commitAll(dir, 'reviewer change');
  assert.notEqual(id(changed), id(root));
  assert.notEqual(id(root, 'other'), id(root));
  assert.notEqual(id(root, 'm', '0.7'), id(root));
  assert.throws(() => reviewerId({ source: 'nope', model: 'm', minConfidence: '0.6', run }));
});

const META = {
  mode: 'live',
  pr: 9,
  head_sha: NEW,
  merge_base: 'b'.repeat(40),
  fingerprint: FP,
  reviewer: REVIEWER,
};

function marker(overrides = {}) {
  return {
    v: 2,
    head: OLD,
    run: 100,
    fingerprint: FP,
    reviewer: REVIEWER,
    complete: true,
    blocking: 0,
    findings: [],
    ...overrides,
  };
}

test('reuseDecision reuses an unchanged diff and reviews everything else', () => {
  const decide = (previous, meta = META, enabled = true) =>
    reuseDecision({ enabled, meta, previous });
  assert.deepEqual(decide(marker()), { reuse: true, run: 100, head: OLD });
  assert.match(decide(marker({ fingerprint: '3'.repeat(64) })).detail, /change differs/);
  assert.match(decide(marker({ reviewer: '4'.repeat(64) })).detail, /reviewer changed/);
  assert.match(decide(marker({ complete: false })).detail, /did not complete/);
  assert.match(decide(marker({ head: NEW })).detail, /same head/);
  assert.match(decide(marker({ run: null })).detail, /run id/);
  assert.match(decide(marker({ blocking: undefined })).detail, /verdict/);
  assert.match(decide({ v: 1, head: OLD, findings: [] }).detail, /no fingerprint/);
  assert.match(decide(null).detail, /no earlier review/);
  assert.match(decide(marker(), { ...META, mode: 'eval' }).detail, /eval mode/);
  assert.match(decide(marker(), { ...META, reviewer: null }).detail, /bootstrap/);
  assert.match(decide(marker(), META, false).detail, /disabled/);
});

test('a forged marker by someone other than the bot is ignored', async () => {
  const forged = encodeMarker(marker({ head: 'c'.repeat(40), blocking: 0 }));
  const genuine = encodeMarker(marker({ fingerprint: '5'.repeat(64), blocking: 1 }));
  const request = async (method, path) =>
    path.includes('page=1')
      ? [
          { user: BOT, body: `old\n${genuine}` },
          { user: { login: 'author' }, body: `looks fine\n${forged}` },
        ]
      : [];
  const previous = await previousRound(request, 9);
  assert.equal(previous.fingerprint, '5'.repeat(64));
  assert.equal(reuseDecision({ enabled: true, meta: META, previous }).reuse, false);
  const onlyForged = async (method, path) =>
    path.includes('page=1') ? [{ user: { login: 'author' }, body: forged }] : [];
  assert.equal(await previousRound(onlyForged, 9), null);
});

const BLOCKING = {
  file: 'src/a.ts',
  line: 2,
  severity: 'blocking',
  rule: 'B1',
  category: 'atomicity',
  title: 'Two writes are not atomic',
  rationale: 'r',
  evidence: [],
  confidence: 0.9,
  anchor: { kind: 'exact', line: 2 },
};

function earlierDoc(overrides = {}) {
  return {
    meta: { ...META, head_sha: OLD },
    metrics: { subtype: 'success' },
    blocking: 1,
    complete: true,
    review: { findings: [BLOCKING], scope_findings: [], summary: 's' },
    ...overrides,
  };
}

test('a blocking verdict carries over as blocking', () => {
  const meta = { ...META, reuse_candidate: { head: OLD, run: 100 } };
  const { document, payload } = finalizeCarried({ meta, previousDoc: earlierDoc() });
  assert.equal(document.blocking, 1);
  assert.equal(document.complete, true);
  assert.equal(document.meta.head_sha, NEW);
  assert.deepEqual(document.meta.carried_from, { head: OLD, reviewed_head: OLD, run: 100 });
  assert.equal(document.review.findings[0].severity, 'blocking');
  assert.deepEqual(payload.comments, []);
  assert.match(payload.body, /changes required \(carried over\)/);
  assert.match(payload.body, /Diff unchanged since `eeeeeee`, verdict carried over/);
  assert.match(payload.body, /Two writes are not atomic/);
});

test('carryOver refuses an earlier document that does not match', () => {
  const from = { head: OLD, run: 100 };
  const check = (previousDoc) => () => carryOver({ meta: META, previousDoc, from });
  assert.throws(check(earlierDoc({ blocking: 0 })), /blocking count/);
  assert.throws(check(earlierDoc({ complete: false })), /did not complete/);
  assert.throws(check(earlierDoc({ meta: { ...META, head_sha: NEW } })), /another head/);
  assert.throws(check(earlierDoc({ meta: { ...META, head_sha: OLD, pr: 8 } })), /another PR/);
  assert.throws(
    check(earlierDoc({ meta: { ...META, head_sha: OLD, fingerprint: '3'.repeat(64) } })),
    /fingerprint/,
  );
  assert.throws(
    check(earlierDoc({ meta: { ...META, head_sha: OLD, reviewer: '4'.repeat(64) } })),
    /reviewer/,
  );
  assert.throws(check(null), /not a live review/);
});

test('a full review records fingerprint, reviewer, completeness and run in its marker', () => {
  const structured = { findings: [], scope_findings: [], summary: 's' };
  const done = finalize({
    meta: META,
    structured,
    metrics: { subtype: 'success', is_error: false },
    diffText: '',
    minBlockingConfidence: 0.6,
  }).document;
  assert.equal(done.complete, true);
  const data = decodeMarker(markerFor(done, '4242'));
  assert.deepEqual(
    { ...data, findings: undefined },
    { ...marker({ head: NEW, run: 4242 }), findings: undefined },
  );
  assert.equal(isComplete({ subtype: 'error_max_budget_usd', is_error: true }), false);
  assert.equal(isComplete(null), false);
  assert.equal(decodeMarker(markerFor(done, undefined)).run, null);
});

function fakeRequest(reviews) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET') return path.includes('page=1') ? reviews : [];
    return {};
  };
  return { request, calls };
}

test('publish posts the carry-over note, a new marker and the blocking status', async () => {
  const meta = { ...META, reuse_candidate: { head: OLD, run: 100 } };
  const { document, payload } = finalizeCarried({ meta, previousDoc: earlierDoc() });
  const earlier = encodeMarker(marker({ blocking: 1, findings: [] }));
  const { request, calls } = fakeRequest([{ user: BOT, body: `earlier\n${earlier}` }]);
  await publish({ request, document, payload, runUrl: 'https://run', runId: '200' });
  const review = calls.find((c) => c.method === 'POST' && c.path.endsWith('/reviews'));
  assert.equal(review.body.commit_id, NEW);
  assert.deepEqual(review.body.comments, []);
  assert.match(review.body.body, /verdict carried over/);
  const next = decodeMarker(review.body.body);
  assert.equal(next.head, NEW);
  assert.equal(next.run, 200);
  assert.equal(next.blocking, 1);
  assert.equal(next.complete, true);
  assert.equal(next.findings[0].severity, 'blocking');
  const status = calls.find((c) => c.path.startsWith('/statuses/'));
  assert.equal(status.path, `/statuses/${NEW}`);
  assert.equal(status.body.state, 'failure');
  assert.match(status.body.description, /1 blocking finding\(s\), carried over from eeeeeee/);
});

test('publish refuses to carry over when the latest round is not the source', async () => {
  const meta = { ...META, reuse_candidate: { head: OLD, run: 100 } };
  const { document, payload } = finalizeCarried({ meta, previousDoc: earlierDoc() });
  const other = encodeMarker(marker({ head: 'c'.repeat(40), blocking: 1 }));
  const { request, calls } = fakeRequest([{ user: BOT, body: other }]);
  await assert.rejects(publish({ request, document, payload, runId: '200' }), /not the carried/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

async function servePullReviews(reviews) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.includes('page=1') ? reviews : []));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function runPrepare({ dir, head, later, reviews, extraEnv = {} }) {
  const server = await servePullReviews(reviews);
  try {
    const event = join(dir, '..', `event-reuse-${process.hrtime.bigint()}.json`);
    writeFileSync(
      event,
      JSON.stringify({
        pull_request: {
          number: 9,
          title: 'feat: change a',
          body: 'Body',
          base: { sha: later, ref: 'main' },
          head: { sha: head },
        },
      }),
    );
    const inputDir = join(dir, '..', `input-reuse-${process.hrtime.bigint()}`);
    const output = join(dir, '..', `output-reuse-${process.hrtime.bigint()}`);
    writeFileSync(output, '');
    await promisify(execFile)('node', [PREPARE], {
      cwd: dir,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: event,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_OUTPUT: output,
        GITHUB_TOKEN: 'test-token',
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        INPUT_DIR: inputDir,
        TRUSTED_SOURCE: later,
        REVIEW_MODEL: 'm',
        MIN_BLOCKING_CONFIDENCE: '0.6',
        ...extraEnv,
      },
    });
    return {
      meta: JSON.parse(readFileSync(join(inputDir, 'meta.json'), 'utf8')),
      outputs: readFileSync(output, 'utf8'),
    };
  } finally {
    server.close();
  }
}

test('prepare finds the earlier verdict after main was merged into the branch', async () => {
  const { dir, root, head, later } = repo();
  const first = await runPrepare({ dir, head, later: root, reviews: [] });
  assert.match(first.outputs, /^reuse<<EOF_[^\n]+\nfalse$/m);
  const earlier = encodeMarker(
    marker({ fingerprint: first.meta.fingerprint, reviewer: first.meta.reviewer, head }),
  );
  sh(dir, 'merge', '-q', '--no-edit', 'main');
  const merged = sh(dir, 'rev-parse', 'HEAD');
  const second = await runPrepare({
    dir,
    head: merged,
    later,
    reviews: [{ user: BOT, body: `earlier\n${earlier}` }],
  });
  assert.equal(second.meta.fingerprint, first.meta.fingerprint);
  assert.deepEqual(second.meta.reuse_candidate, { head, run: 100 });
  assert.match(second.outputs, /^reuse<<EOF_[^\n]+\ntrue$/m);
  assert.match(second.outputs, /^reuse_run<<EOF_[^\n]+\n100$/m);
  const disabled = await runPrepare({
    dir,
    head: merged,
    later,
    reviews: [{ user: BOT, body: earlier }],
    extraEnv: { REUSE_UNCHANGED: 'false' },
  });
  assert.equal(disabled.meta.reuse_candidate, undefined);
});

test('the check step carries over only a matching downloaded result', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-carry-'));
  const inputDir = join(root, 'input');
  const previousDir = join(root, 'previous');
  mkdirSync(inputDir);
  mkdirSync(previousDir);
  const meta = { ...META, reuse_candidate: { head: OLD, run: 100 } };
  writeFileSync(join(inputDir, 'meta.json'), JSON.stringify(meta));
  const check = () => {
    const output = join(root, `out-${process.hrtime.bigint()}`);
    writeFileSync(output, '');
    execFileSync('node', [REUSE], {
      env: {
        ...process.env,
        INPUT_DIR: inputDir,
        PREVIOUS_DIR: previousDir,
        GITHUB_OUTPUT: output,
      },
    });
    return readFileSync(output, 'utf8');
  };
  assert.equal(check(), 'carry=false\n');
  writeFileSync(join(previousDir, 'findings.json'), JSON.stringify(earlierDoc({ blocking: 0 })));
  assert.equal(check(), 'carry=false\n');
  writeFileSync(join(previousDir, 'findings.json'), JSON.stringify(earlierDoc()));
  assert.equal(check(), 'carry=true\n');
});
