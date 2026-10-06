import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorFinding, parseDiff } from '../diff.mjs';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' line1',
  '-old2',
  '+new2',
  '+++ starts like a header',
  ' line4',
  ' line5',
  '@@ -20,2 +21,3 @@ function x() {',
  ' ctx21',
  '+add22',
  ' ctx23',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-bye',
  'diff --git a/new file.ts b/new file.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new file.ts',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
  '\\ No newline at end of file',
  '',
].join('\n');

test('parseDiff indexes head-side lines per file', () => {
  const index = parseDiff(DIFF);
  assert.deepEqual([...index.keys()], ['src/a.ts', 'new file.ts']);
  const a = index.get('src/a.ts');
  assert.deepEqual(
    [...a.commentable].sort((x, y) => x - y),
    [1, 2, 3, 4, 5, 21, 22, 23],
  );
  assert.deepEqual(
    [...a.added].sort((x, y) => x - y),
    [2, 3, 22],
  );
  assert.deepEqual(a.hunks, [
    { start: 1, end: 5 },
    { start: 21, end: 23 },
  ]);
  assert.deepEqual([...index.get('new file.ts').commentable], [1, 2]);
});

test('anchorFinding prefers exact lines and ranges inside one hunk', () => {
  const index = parseDiff(DIFF);
  assert.deepEqual(anchorFinding({ file: 'src/a.ts', line: 2 }, index), { kind: 'exact', line: 2 });
  assert.deepEqual(anchorFinding({ file: 'src/a.ts', line: 2, end_line: 4 }, index), {
    kind: 'exact',
    start_line: 2,
    line: 4,
  });
});

test('anchorFinding drops a range that leaves the hunk', () => {
  const index = parseDiff(DIFF);
  assert.deepEqual(anchorFinding({ file: 'src/a.ts', line: 4, end_line: 22 }, index), {
    kind: 'exact',
    line: 4,
  });
});

test('anchorFinding falls back to the nearest changed line, then to the summary', () => {
  const index = parseDiff(DIFF);
  assert.deepEqual(anchorFinding({ file: 'src/a.ts', line: 15 }, index), {
    kind: 'nearest',
    line: 21,
  });
  assert.deepEqual(anchorFinding({ file: 'src/other.ts', line: 3 }, index), { kind: 'summary' });
  assert.deepEqual(anchorFinding({ file: 'src/gone.ts', line: 1 }, index), { kind: 'summary' });
});
