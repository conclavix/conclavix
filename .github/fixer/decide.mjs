import { plain } from './github.mjs';

const DECISIONS = new Set(['fixed', 'already_fixed', 'disputed', 'needs_human']);
const CI_DECISIONS = new Set(['fixed', 'not_reproducible', 'needs_human']);
const SUBJECT = /^(fix|test)(\([a-z0-9._/-]+\))?: [ -~]{8,}$/;

/** CI items (C1..Cn) are failed CI steps; F ids are review findings. */
export function isCi(id) {
  return /^C\d+$/.test(String(id));
}

/** @returns {object|null} the fixer output when it matches schema.json, otherwise null */
export function validateOutput(output, ids) {
  if (!output || typeof output !== 'object' || !Array.isArray(output.findings)) return null;
  const ok = output.findings.every(
    (f) =>
      f &&
      ids.includes(f.id) &&
      (isCi(f.id) ? CI_DECISIONS : DECISIONS).has(f.decision) &&
      typeof f.explanation === 'string',
  );
  return ok && typeof output.summary === 'string' ? output : null;
}

const CI_INFRA_CAUSE =
  'ci_infra: CI failed for a reason outside the code (infrastructure, timeout or not reproducible)';

function gatesFailed(gates) {
  const required = ['install', 'check'];
  const failed = required.filter((g) => gates[g] !== 'success');
  if (gates.smoke !== 'success' && gates.smoke !== 'skipped') failed.push('smoke');
  return failed;
}

function openFindings(selected, output) {
  const byId = new Map(output.findings.map((f) => [f.id, f]));
  const open = [];
  for (const f of selected) {
    const d = byId.get(f.id);
    if (!d)
      open.push({
        id: f.id,
        decision: 'needs_human',
        explanation: 'The fixer did not report on this finding.',
      });
    else if (d.decision !== 'fixed')
      open.push({ id: f.id, decision: d.decision, explanation: d.explanation });
  }
  return open;
}

function blockers({ fixedCount, changed, violations, gates }) {
  const causes = [];
  if (violations.length > 0) causes.push('policy violations');
  if (changed && fixedCount === 0) causes.push('files changed but no finding is reported as fixed');
  if (!changed && fixedCount > 0) causes.push('findings reported as fixed but nothing changed');
  const failed = changed && causes.length === 0 ? gatesFailed(gates) : [];
  if (failed.length > 0) causes.push(`gates failed: ${failed.join(', ')}`);
  return causes;
}

/**
 * Decides whether the round pushes a commit and whether it escalates.
 * @returns {{push: boolean, escalate: boolean, causes: string[], fixed: string[], open: object[]}}
 */
export function decide({
  selected,
  scope,
  ciInfra = [],
  output,
  changed,
  violations,
  gates,
  startError = null,
}) {
  const causes = [];
  const scopeOpen = scope.map((s) => ({ id: s.id, decision: 'scope', explanation: s.description }));
  const infraOpen = ciInfra.map((i) => ({ id: i.id, decision: 'ci_infra', explanation: i.why }));
  const early = [...scopeOpen, ...infraOpen];
  if (selected.length === 0) {
    return {
      push: false,
      escalate: true,
      causes: [infraOpen.length > 0 ? CI_INFRA_CAUSE : 'no fixable findings'],
      fixed: [],
      open: early,
    };
  }
  if (!output) {
    return {
      push: false,
      escalate: true,
      causes: [
        startError ? `Claude could not start: ${startError}` : 'the fixer returned no valid result',
      ],
      fixed: [],
      open: early,
    };
  }
  const fixed = output.findings.filter((f) => f.decision === 'fixed').map((f) => f.id);
  const open = [...openFindings(selected, output), ...early];
  causes.push(...blockers({ fixedCount: fixed.length, changed, violations, gates }));
  const push = changed && causes.length === 0;
  const unproven = output.findings
    .filter((f) => f.decision === 'fixed' && f.proof_failed_before !== true)
    .map((f) => f.id);
  if (push && unproven.length > 0) causes.push(`no failing proof test for ${unproven.join(', ')}`);
  if (open.some((o) => o.decision === 'ci_infra' || o.decision === 'not_reproducible'))
    causes.push(CI_INFRA_CAUSE);
  if (open.length > 0) causes.push('findings left for a human');
  return { push, escalate: causes.length > 0, causes, fixed: push ? fixed : [], open };
}

/** @returns {string} commit message for one fixer round */
export function commitMessage({ output, selected, round, trailer, reviewRun, ciRuns = [] }) {
  const byId = new Map(selected.map((f) => [f.id, f]));
  const fixed = output.findings.filter((f) => f.decision === 'fixed');
  const onlyCi = fixed.length > 0 && fixed.every((d) => isCi(d.id));
  const anyCi = fixed.some((d) => isCi(d.id));
  const proposed = plain(output.commit_subject, 72);
  const fallback = onlyCi
    ? `fix: make the failing CI steps pass (round ${round})`
    : `fix: address blocking review findings (round ${round})`;
  const subject = SUBJECT.test(proposed) ? proposed : fallback;
  const what = anyCi
    ? onlyCi
      ? 'Failed CI steps addressed:'
      : 'Blocking review findings and failed CI steps addressed:'
    : 'Blocking review findings addressed:';
  const lines = [subject, '', `Fixer round ${round}. ${what}`, ''];
  for (const d of fixed) {
    const f = byId.get(d.id);
    if (isCi(d.id)) lines.push(`- ${d.id} CI ${plain(f.title, 200)}`);
    else lines.push(`- ${d.id} ${f.rule} ${f.file}:${f.line}: ${plain(f.title, 160)}`);
    lines.push(`  Fix: ${plain(d.explanation, 400)}`);
    if (d.proof_test) {
      const before = d.proof_failed_before
        ? 'failed before the fix'
        : 'not shown to fail before the fix';
      lines.push(`  Proof: ${plain(d.proof_test, 200)} (${before})`);
    }
  }
  lines.push('');
  if (reviewRun) lines.push(`Review run: ${reviewRun}`);
  for (const url of ciRuns) lines.push(`CI run: ${plain(url, 200)}`);
  lines.push('', `${trailer}: ${round}`);
  lines.push('Co-Authored-By: Claude <noreply@anthropic.com>');
  return `${lines.join('\n')}\n`;
}
