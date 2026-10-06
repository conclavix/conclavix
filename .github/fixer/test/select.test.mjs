import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../github.mjs';
import { buildPrompt, compactSchema, toolRules } from '../prepare.mjs';
import { findingsMarkdown, selectFindings, validateDocument } from '../select.mjs';

const HEAD = 'a'.repeat(40);

function finding(overrides) {
  return {
    file: './apps/api/src/a.ts',
    line: 3,
    severity: 'blocking',
    rule: 'B3',
    category: 'stuck_state',
    title: 'Lock stays held',
    rationale: 'Throw after acquire.',
    evidence: [{ file: 'apps/api/src/a.ts', line: 5, note: 'acquire' }],
    confidence: 0.9,
    ...overrides,
  };
}

function doc(overrides = {}) {
  return {
    meta: { mode: 'live', pr: 7, head_sha: HEAD },
    blocking: 2,
    review: {
      findings: [
        finding({}),
        finding({ severity: 'non-blocking', title: 'nit' }),
        finding({ rule: 'B1', line: 9, title: 'second' }),
      ],
      scope_findings: [
        {
          kind: 'out_of_scope',
          severity: 'blocking',
          file: 'apps/web/x.vue',
          description: 'unrelated page',
        },
        { kind: 'missing_requirement', severity: 'non-blocking', description: 'docs' },
      ],
      summary: 's',
    },
    ...overrides,
  };
}

test('validateDocument requires a live review of the expected PR and head', () => {
  assert.ok(validateDocument(doc(), { pr: '7', headSha: HEAD }));
  assert.throws(() => validateDocument(doc(), { pr: '8', headSha: HEAD }), /expected #8/);
  assert.throws(() => validateDocument(doc(), { pr: '7', headSha: 'b'.repeat(40) }), /expected b/);
  assert.throws(
    () =>
      validateDocument(doc({ meta: { mode: 'eval', pr: 7, head_sha: HEAD } }), {
        pr: '7',
        headSha: HEAD,
      }),
    /eval/,
  );
  assert.throws(
    () =>
      validateDocument(
        { meta: { mode: 'live', pr: 7, head_sha: HEAD } },
        { pr: '7', headSha: HEAD },
      ),
    /arrays/,
  );
});

test('selectFindings keeps blocking code findings for the fixer and blocking scope findings for a human', () => {
  const { fixable, scope } = selectFindings(doc());
  assert.deepEqual(
    fixable.map((f) => [f.id, f.file, f.line]),
    [
      ['F1', 'apps/api/src/a.ts', 3],
      ['F2', 'apps/api/src/a.ts', 9],
    ],
  );
  assert.deepEqual(
    scope.map((s) => [s.id, s.kind]),
    [['S1', 'out_of_scope']],
  );
});

test('findingsMarkdown fences reviewer text so it cannot break out', () => {
  const md = findingsMarkdown(
    selectFindings(
      doc({
        review: { ...doc().review, findings: [finding({ title: 'a ``` b', suggestion: 'x()' })] },
      }),
    ).fixable,
  );
  assert.match(md, /## F1: B3 stuck_state at `apps\/api\/src\/a.ts:3`/);
  assert.match(md, /````text\na ``` b\n````/);
  assert.match(md, /Reviewer suggestion \(untrusted, verify it\)/);
});

test('toolRules allow only the configured pnpm and read-only git commands', () => {
  const { allowed, denied } = toolRules(loadConfig());
  const rules = allowed.split(',');
  assert.ok(rules.includes('Bash(pnpm check *)'));
  assert.ok(rules.includes('Bash(pnpm --filter @conclavix/api test *)'));
  assert.ok(rules.includes('Bash(git diff *)'));
  assert.equal(
    rules.some((r) => /git (add|commit|push|checkout|reset)/.test(r)),
    false,
  );
  assert.equal(
    rules.some((r) => r === 'Bash' || r === 'Bash(*)'),
    false,
  );
  assert.match(denied, /Write\(\.\/\.git\/\*\*\)/);
  assert.throws(
    () => toolRules({ ...loadConfig(), bash_allow: ['pnpm test; curl x'] }),
    /must not contain/,
  );
});

test('the prompt contains the rules and the input directory, the schema is compact', () => {
  const prompt = buildPrompt({ inputDir: '/tmp/in', round: 2, maxRounds: 3 });
  assert.match(prompt, /# Pull request auto-fixer/);
  assert.match(prompt, /# Fixer rules/);
  assert.match(prompt, /round 2 of at most 3/);
  assert.match(prompt, /\/tmp\/in\/findings.md/);
  assert.ok(JSON.parse(compactSchema()).properties.findings);
});
