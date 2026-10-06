import { plain } from './github.mjs';

const CAUSE = 'conflict_unresolved';

/** @returns {object|null} the merge output when it matches merge-schema.json, otherwise null */
export function validateMergeOutput(output, paths) {
  if (!output || typeof output !== 'object' || !Array.isArray(output.files)) return null;
  const files = output.files.every(
    (f) =>
      f &&
      paths.includes(f.path) &&
      (f.decision === 'resolved' || f.decision === 'needs_human') &&
      typeof f.resolution === 'string' &&
      typeof f.reasoning === 'string',
  );
  const extra =
    Array.isArray(output.extra_edits) &&
    output.extra_edits.every(
      (e) => e && typeof e.path === 'string' && typeof e.reason === 'string',
    );
  return files && extra && typeof output.summary === 'string' ? output : null;
}

function gatesFailed(gates) {
  const failed = ['install', 'check'].filter((g) => gates[g] !== 'success');
  if (gates.smoke !== 'success' && gates.smoke !== 'skipped') failed.push('smoke');
  return failed;
}

function unionEntry(u) {
  const scripts = u.scripts?.length ? ` (${u.scripts.join(', ')})` : '';
  return {
    path: u.path,
    how: 'union',
    decision: 'resolved',
    resolution: `union of both sides' scripts${scripts}`,
    reasoning: 'each side changed different scripts, so both changes are kept',
  };
}

function claudeEntry(c, reported) {
  if (!reported)
    return {
      path: c.path,
      how: 'claude',
      decision: 'needs_human',
      resolution: '',
      reasoning: 'The fixer did not report on this file.',
    };
  const { decision, resolution, reasoning } = reported;
  return { path: c.path, how: 'claude', decision, resolution, reasoning };
}

/**
 * One entry per conflicted file with how it was resolved, for the commit message and the comment.
 * @returns {object[]}
 */
export function describeFiles(state, output) {
  const byPath = new Map((output?.files ?? []).map((f) => [f.path, f]));
  const blocked = (state.blocked ?? []).map((b) => ({
    path: b.path,
    how: 'human',
    decision: 'needs_human',
    resolution: '',
    reasoning: b.why,
  }));
  const union = (state.union ?? []).map(unionEntry);
  const claude = (state.claude ?? []).map((c) => claudeEntry(c, byPath.get(c.path)));
  return [...blocked, ...union, ...claude].sort((a, b) => (a.path < b.path ? -1 : 1));
}

function resolutionCauses({ files, output, violations, extra, changed }) {
  const causes = [];
  const open = files.filter((f) => f.decision !== 'resolved');
  if (open.length > 0) causes.push(`${CAUSE}: ${open.length} file(s) need a human decision`);
  if (violations.length > 0) causes.push(`${CAUSE}: policy violations`);
  const explained = new Set((output?.extra_edits ?? []).map((e) => e.path));
  const unexplained = extra.filter((p) => !explained.has(p));
  if (unexplained.length > 0)
    causes.push(
      `${CAUSE}: edits outside the conflicted files without a reason: ${unexplained.join(', ')}`,
    );
  if (!changed) causes.push(`${CAUSE}: no merge was prepared`);
  return causes;
}

function earlyCause(state, output, startError) {
  if ((state.blocked ?? []).length > 0)
    return `${CAUSE}: conflicts in files the fixer never resolves`;
  if ((state.claude ?? []).length > 0 && !output) {
    const why = startError
      ? `Claude could not start: ${startError}`
      : 'the fixer returned no valid result';
    return `${CAUSE}: ${why}`;
  }
  return null;
}

/**
 * Decides whether a merge round pushes its merge commit. Every conflicted file must be resolved,
 * the policy must hold, every edit outside the conflicted files must be explained, and the gates
 * must be green; otherwise nothing is pushed and the PR goes to a human.
 * @returns {{push: boolean, escalate: boolean, causes: string[], files: object[]}}
 */
export function decideMerge({ state, output, changed, violations, extra = [], gates, startError }) {
  if (state.up_to_date) return { push: false, escalate: false, causes: [], files: [] };
  const files = describeFiles(state, output);
  const early = earlyCause(state, output, startError);
  const causes = early ? [early] : resolutionCauses({ files, output, violations, extra, changed });
  if (causes.length === 0) {
    const failed = gatesFailed(gates);
    if (failed.length > 0) causes.push(`gates failed: ${failed.join(', ')}`);
  }
  const push = causes.length === 0;
  return { push, escalate: !push, causes, files };
}

/** @returns {string} commit message of the merge commit the workflow writes */
export function mergeCommitMessage({
  baseRef,
  headRef,
  base,
  head,
  round,
  trailer,
  files,
  output,
}) {
  const lines = [
    `Merge branch '${plain(baseRef, 100)}' into ${plain(headRef, 150)}`,
    '',
    `Fixer round ${round}. Merges ${plain(baseRef, 100)} at ${base} into the pull request head ${head}.`,
    '',
    files.length === 0 ? 'The base merged without conflicts.' : 'Conflicts resolved:',
  ];
  for (const f of files) {
    lines.push(`- ${plain(f.path, 200)} (${f.how === 'union' ? 'workflow' : 'fixer'})`);
    lines.push(`  Resolution: ${plain(f.resolution, 400)}`);
    lines.push(`  Why: ${plain(f.reasoning, 400)}`);
  }
  for (const e of output?.extra_edits ?? [])
    lines.push(`- ${plain(e.path, 200)} (also changed): ${plain(e.reason, 300)}`);
  lines.push('', `${trailer}: ${round}`);
  if (files.some((f) => f.how === 'claude'))
    lines.push('Co-Authored-By: Claude <noreply@anthropic.com>');
  return `${lines.join('\n')}\n`;
}
