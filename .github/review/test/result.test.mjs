import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalize } from '../finalize.mjs';
import { decodeMarker, encodeMarker, resolvedSince, sanitize } from '../render.mjs';
import { extractResult, validateReview } from '../result.mjs';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,4 @@',
  ' one',
  '+two',
  '+three',
  ' four',
  '',
].join('\n');

const META = { mode: 'live', pr: 7, head_sha: 'a'.repeat(40), merge_base: 'b'.repeat(40) };

function finding(overrides) {
  return {
    file: 'src/a.ts',
    line: 2,
    severity: 'blocking',
    rule: 'B1',
    category: 'atomicity',
    title: 'Two writes are not atomic',
    rationale: 'Step 1 then crash.',
    evidence: [{ file: 'src/a.ts', line: 3, note: 'second write' }],
    confidence: 0.9,
    ...overrides,
  };
}

test('extractResult reads structured output and metrics from the last result message', () => {
  const messages = [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
    { type: 'assistant' },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 120000,
      num_turns: 12,
      total_cost_usd: 1.5,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 },
      permission_denials: [{}],
      structured_output: { findings: [], scope_findings: [], summary: 'ok' },
    },
  ];
  const { structured, metrics } = extractResult(messages);
  assert.equal(structured.summary, 'ok');
  assert.equal(metrics.model, 'claude-opus-5-5');
  assert.equal(metrics.total_cost_usd, 1.5);
  assert.equal(metrics.cache_creation_input_tokens, 0);
  assert.equal(metrics.permission_denials, 1);
  assert.deepEqual(extractResult([{ type: 'assistant' }]), { structured: null, metrics: null });
});

test('validateReview rejects malformed output', () => {
  assert.throws(() => validateReview(null), /missing/);
  assert.throws(
    () => validateReview({ findings: [{ file: 'x' }], scope_findings: [], summary: '' }),
    /do not match/,
  );
});

test('finalize anchors findings, downgrades low confidence and counts blocking', () => {
  const structured = {
    findings: [
      finding({ suggestion: 'fixed two' }),
      finding({ line: 40, title: 'Outside', confidence: 0.95 }),
      finding({ file: 'src/b.ts', line: 1, title: 'Low confidence', confidence: 0.3 }),
    ],
    scope_findings: [{ kind: 'out_of_scope', severity: 'blocking', description: 'Adds a game' }],
    summary: 'Summary @someone <!-- hidden -->',
  };
  const { document, payload } = finalize({
    meta: META,
    structured,
    metrics: null,
    diffText: DIFF,
    minBlockingConfidence: 0.6,
  });
  assert.equal(document.blocking, 3);
  assert.equal(document.review.findings[2].severity, 'non-blocking');
  assert.equal(document.review.findings[2].anchor.kind, 'summary');
  assert.equal(payload.comments.length, 2);
  assert.match(payload.comments[0].body, /```suggestion\nfixed two\n```/);
  assert.equal(payload.comments[1].line, 4);
  assert.doesNotMatch(payload.comments[1].body, /suggestion/);
  assert.match(payload.comments[1].body, /Real location: `src\/a.ts:40`/);
  assert.doesNotMatch(payload.body, /<!--|@someone/);
  assert.match(payload.body, /Findings outside the diff/);
});

test('sanitize neutralises mentions and comments and truncates', () => {
  assert.equal(sanitize('hi @team <!-- x'), 'hi &#64;team &lt;!-- x');
  assert.equal(sanitize('abcdef', 3), 'abc [truncated]');
});

test('marker round-trips and resolvedSince keeps moved findings open', () => {
  const marker = encodeMarker({ head: 'x', findings: [{ file: 'a', line: 1, title: 't --> y' }] });
  assert.deepEqual(decodeMarker(`body\n\n${marker}`).findings[0].title, 't --> y');
  assert.equal(decodeMarker('no marker'), null);
  const previous = [
    { file: 'a.ts', line: 10, title: 'Cost is not persisted before finish' },
    { file: 'b.ts', line: 5, title: 'Race in lock' },
    { file: 'c.ts', line: 100, title: 'Unvalidated request body' },
  ];
  const current = [
    { file: 'a.ts', line: 18, title: 'Different words' },
    { file: 'c.ts', line: 300, title: 'Request body is unvalidated' },
  ];
  assert.deepEqual(
    resolvedSince(previous, current).map((r) => r.file),
    ['b.ts'],
  );
});
