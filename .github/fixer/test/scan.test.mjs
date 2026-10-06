import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../github.mjs';
import { dispatchAll, eligible, fetchAll, pickConflicting } from '../scan.mjs';

const config = loadConfig();
const REPO = 'conclavix/conclavix';

function pr(number, overrides = {}) {
  return {
    number,
    state: 'open',
    draft: false,
    user: { login: config.trusted_logins[0] },
    head: { sha: 'a'.repeat(40), ref: `b${number}`, repo: { full_name: REPO } },
    labels: [],
    ...overrides,
  };
}

test('scan: every trusted, same-repo, non-draft PR without a skip label, oldest first, uncapped', () => {
  const pulls = [
    pr(35),
    pr(29),
    pr(30, { draft: true }),
    pr(31, { user: { login: 'mallory' } }),
    pr(32, { head: { sha: 'a'.repeat(40), ref: 'x', repo: { full_name: 'm/conclavix' } } }),
    pr(33, { labels: [{ name: 'needs-human' }] }),
    pr(34, { labels: [{ name: 'no-autofix' }] }),
  ];
  assert.deepEqual(
    eligible(pulls, { repository: REPO, config }).map((p) => p.number),
    [29, 35],
  );
  const many = Array.from({ length: 60 }, (_, i) => pr(i + 1));
  assert.equal(eligible(many, { repository: REPO, config }).length, 60);
});

test('scan: dispatches only PRs that actually conflict, bounded per run', () => {
  const details = [
    pr(1, { mergeable: false, mergeable_state: 'dirty' }),
    pr(2, { mergeable: true, mergeable_state: 'clean' }),
    pr(3, { mergeable: null, mergeable_state: 'unknown' }),
    pr(4, { mergeable: true, mergeable_state: 'unstable' }),
  ];
  assert.deepEqual(pickConflicting(details, config), [1]);
  const all = Array.from({ length: 9 }, (_, i) => pr(i + 1, { mergeable: false }));
  assert.equal(pickConflicting(all, config).length, config.merge.max_dispatch);
});

test('scan: reads every PR, re-reads only unknown ones, and one failing PR never stops the rest', async () => {
  const answers = {
    1: [null, false],
    2: [true],
    3: ['fail', 'fail', 'fail', 'fail', 'fail', 'fail'],
    4: [false],
  };
  const seen = {};
  const request = async (method, path) => {
    const n = Number(path.split('/').pop());
    seen[n] = (seen[n] ?? 0) + 1;
    const a = answers[n][Math.min(seen[n] - 1, answers[n].length - 1)];
    if (a === 'fail') throw new Error('502');
    return pr(n, { mergeable: a });
  };
  const waits = [];
  const { details, failed } = await fetchAll(request, [1, 2, 3, 4], config, async (ms) => {
    waits.push(ms);
  });
  assert.deepEqual(
    details.map((d) => [d.number, d.mergeable]),
    [
      [1, false],
      [2, true],
      [4, false],
    ],
  );
  assert.deepEqual(failed, [3]);
  assert.deepEqual([seen[1], seen[2], seen[4]], [2, 1, 1]);
  assert.equal(seen[3], config.merge.mergeable_polls + 1);
  assert.equal(waits.length, config.merge.mergeable_polls);
  assert.deepEqual(pickConflicting(details, config), [1, 4]);
});

test('scan: a failed dispatch is reported and the remaining PRs are still dispatched', async () => {
  const posted = [];
  const request = async (method, path, body) => {
    if (body.inputs.pr_number === '1') throw new Error('422');
    posted.push([method, path, body]);
  };
  const failed = await dispatchAll(request, [1, 4], { workflow: 'fix.yml', ref: 'main' });
  assert.deepEqual(failed, [1]);
  assert.deepEqual(posted, [
    [
      'POST',
      '/actions/workflows/fix.yml/dispatches',
      { ref: 'main', inputs: { pr_number: '4', conflicts_only: 'true' } },
    ],
  ]);
});
