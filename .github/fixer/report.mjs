import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clientFromEnv, env, loadConfig, sanitize, summary } from './github.mjs';

const ROUTE_TEXT = {
  round_limit:
    'The fixer has used all of its rounds since the last human commit, and the pull request is still not green:',
  ci_infra:
    'CI failed on the current head for a reason outside the code (setup step, timeout, cancellation or lost runner). The fixer does not change code for that and does not re-run CI; re-run the failed jobs or look at the run.',
};

const DECISION_TEXT = {
  disputed: 'disputed by the fixer',
  needs_human: 'needs a human decision',
  already_fixed: 'reported as already fixed on the head',
  scope: 'scope finding, never fixed automatically',
  not_reproducible: 'CI failure not reproducible on the head (ci_infra, likely flaky)',
  ci_infra: 'CI infrastructure failure, not fixed in code (ci_infra)',
};

function findingLine(f) {
  const where = f.file ? ` \`${sanitize(f.file, 200)}:${f.line ?? ''}\`` : '';
  return `- **${f.id}**${f.rule ? ` ${f.rule}` : ''}${where}: ${sanitize(f.title ?? '', 300)}`;
}

function fixedSection(outcome, commit) {
  if (!commit || outcome.fixed.length === 0) return [];
  const lines = [`Pushed \`${commit}\` addressing:`, ''];
  for (const f of outcome.fixed) {
    lines.push(findingLine(f), `  ${sanitize(f.explanation, 800)}`);
    if (f.proof_test) lines.push(`  Proof: ${sanitize(f.proof_test, 300)}`);
  }
  return [...lines, ''];
}

function openSection(outcome) {
  if (outcome.open.length === 0) return [];
  const lines = ['Open findings:', ''];
  for (const f of outcome.open) {
    lines.push(
      `${findingLine(f)} (${DECISION_TEXT[f.decision] ?? f.decision})`,
      `  ${sanitize(f.explanation, 1500)}`,
    );
  }
  return [...lines, ''];
}

/** @returns {string[]} comment lines describing the gate repair pass, empty when none ran */
function repairSection(outcome) {
  const r = outcome.repair;
  if (!r) return [];
  const gate = `\`pnpm ${sanitize(r.gate, 20)}\``;
  if (r.decision === 'repaired' && outcome.push)
    return [
      `${gate} failed after the change; one repair pass made the gates pass:`,
      '',
      ...r.edits.map((e) => `- \`${sanitize(e.path, 200)}\`: ${sanitize(e.reason, 600)}`),
      '',
    ];
  const what = r.decision === 'needs_human' ? 'needs a human' : 'did not make the gates pass';
  const lines = [`${gate} failed after the change; the repair pass ${what}.`];
  if (r.summary) lines.push(`Repair: ${sanitize(r.summary, 800)}`);
  return [...lines, ''];
}

function detailSection(outcome) {
  const lines = [...repairSection(outcome)];
  if (outcome.causes.length > 0)
    lines.push(`Why it stopped: ${outcome.causes.map((c) => sanitize(c, 300)).join('; ')}.`, '');
  if (outcome.violations.length > 0)
    lines.push(
      'Policy violations:',
      '',
      ...outcome.violations.map((v) => `- ${sanitize(v, 300)}`),
      '',
    );
  const g = outcome.gates;
  lines.push(`Gates: install ${g.install}, check ${g.check}, smoke ${g.smoke}.`, '');
  return lines;
}

function escalation(config, text, runUrl) {
  return `@${config.escalation_mention} the auto-fixer needs you on this pull request.\n\n${text}\n\n[Fixer run](${runUrl})`;
}

const HOW_TEXT = {
  claude: 'resolved by the fixer',
  union: "union of both sides' package.json scripts",
  human: 'needs a human',
};

function mergeFileLines(files) {
  const lines = [];
  for (const f of files) {
    const how = f.decision === 'resolved' ? HOW_TEXT[f.how] : 'needs a human';
    lines.push(`- \`${sanitize(f.path, 200)}\` (${how})`);
    if (f.resolution) lines.push(`  Resolution: ${sanitize(f.resolution, 800)}`);
    if (f.reasoning) lines.push(`  Why: ${sanitize(f.reasoning, 1200)}`);
  }
  return lines;
}

function extraLines(outcome) {
  const extra = outcome.extra_edits ?? [];
  if (extra.length === 0) return [];
  return [
    '',
    'Also changed outside the conflicted files:',
    '',
    ...extra.map((e) => `- \`${sanitize(e.path, 200)}\`: ${sanitize(e.reason, 600)}`),
  ];
}

/**
 * Comment for a merge round: which files conflicted and how each was resolved, or why the merge
 * needs a human.
 */
function mergePlan({ config, outcome, pushResult, pushedSha, runUrl, header }) {
  const base = `\`${sanitize(outcome.base_ref, 100)}\``;
  if (outcome.up_to_date)
    return {
      escalate: false,
      comment: `${header}\n\nThe branch already contains ${base}; nothing to merge.\n\n[Fixer run](${runUrl})`,
    };
  const files = outcome.files ?? [];
  const conflicts =
    files.length === 0
      ? [`${base} merged without conflicts.`]
      : [`Conflicts with ${base}:`, '', ...mergeFileLines(files), ...extraLines(outcome)];
  const pushed = outcome.push && pushResult === 'success' ? pushedSha || outcome.commit : null;
  if (pushed) {
    const body = [
      header,
      '',
      `Merged ${base} (\`${sanitize(outcome.base_sha, 40)}\`) into this branch with \`${pushed}\`.`,
      '',
      ...conflicts,
      '',
      ...repairSection(outcome),
      'CI and the review run again on the merge commit. Please check the resolutions before merging.',
      '',
      `[Fixer run](${runUrl})`,
    ];
    return { escalate: false, comment: body.join('\n') };
  }
  const body = [header, '', `Merging ${base} into this branch needs you.`, '', ...conflicts, ''];
  if (outcome.push)
    body.push(
      'The merge commit could not be pushed (the branch moved, verification refused it, or the push was rejected; a merge that brings in changes under `.github/workflows/` needs the `workflow` scope on `FIXER_BOT_PAT`).',
      '',
    );
  body.push(...detailSection(outcome));
  return { escalate: true, comment: escalation(config, body.join('\n'), runUrl) };
}

function fixPlan({ config, outcome, fixResult, pushResult, pushedSha, runUrl, round }) {
  const header = `**Auto-fixer, round ${round} of ${config.max_rounds}**`;
  if (!outcome) {
    const job = fixResult ? ` (job result: ${sanitize(fixResult, 20)})` : '';
    return {
      escalate: true,
      comment: escalation(
        config,
        `${header}\n\nThe fixer run failed before it produced a result${job}.`,
        runUrl,
      ),
    };
  }
  if (outcome.kind === 'merge')
    return mergePlan({ config, outcome, pushResult, pushedSha, runUrl, header });
  const pushed = outcome.push && pushResult === 'success' ? pushedSha || outcome.commit : null;
  const pushFailed = outcome.push && !pushed;
  const body = [header, '', ...fixedSection(outcome, pushed)];
  if (pushFailed)
    body.push('The fix commit could not be pushed (the branch moved or the push was refused).', '');
  const escalate = outcome.escalate || pushFailed;
  if (!escalate) {
    body.push(...repairSection(outcome));
    body.push('The review runs again on the new commit.', '', `[Fixer run](${runUrl})`);
    return { escalate: false, comment: body.join('\n') };
  }
  body.push(...openSection(outcome), ...detailSection(outcome));
  return { escalate: true, comment: escalation(config, body.join('\n'), runUrl) };
}

/** @returns {{add: string[], remove: string[], comment: string|null}} label changes and the PR comment */
export function plan({
  config,
  mode,
  routeReason,
  routeDetail = '',
  dropReady,
  headSha,
  outcome,
  fixResult,
  pushResult,
  pushedSha,
  runUrl,
  round,
}) {
  const { ready, escalated } = config.labels;
  const out = { add: [], remove: dropReady ? [ready] : [], comment: null };
  if (mode === 'ready') {
    out.add.push(ready);
    out.remove.push(escalated);
    out.comment = `Review and CI are green on \`${headSha}\`. Labelled \`${ready}\`. Next step: a maintainer checks the scope and merges. Nothing is merged automatically.`;
  } else if (mode === 'escalate') {
    const known = ROUTE_TEXT[routeReason] ?? sanitize(routeReason, 300);
    const detail = routeDetail
      ? `\n\n${String(routeDetail)
          .split('\n')
          .slice(0, 10)
          .map((l) => `- ${sanitize(l, 300)}`)
          .join('\n')}`
      : '';
    const text = `${known}${detail}`;
    Object.assign(out, {
      add: [escalated],
      remove: [ready],
      comment: escalation(config, text, runUrl),
    });
  } else if (mode === 'fix' || mode === 'merge') {
    const result = fixPlan({
      config,
      outcome,
      fixResult,
      pushResult,
      pushedSha,
      runUrl,
      round,
    });
    out.comment = result.comment;
    if (result.escalate) Object.assign(out, { add: [escalated], remove: [ready] });
  }
  out.remove = [...new Set(out.remove)].filter((l) => !out.add.includes(l));
  return out;
}

const LABEL_COLORS = { 'needs-human': 'b60205', 'merge-ready': '0e8a16' };

async function apply(request, pr, actions) {
  for (const name of actions.add) {
    try {
      await request('POST', '/labels', { name, color: LABEL_COLORS[name] ?? 'ededed' });
    } catch (error) {
      if (error.status !== 422) throw error;
    }
  }
  if (actions.add.length > 0)
    await request('POST', `/issues/${pr}/labels`, { labels: actions.add });
  for (const name of actions.remove) {
    try {
      await request('DELETE', `/issues/${pr}/labels/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  if (actions.comment) await request('POST', `/issues/${pr}/comments`, { body: actions.comment });
}

function runLine(label, m) {
  const cost = m.total_cost_usd === null ? 'n/a' : `$${Number(m.total_cost_usd).toFixed(2)}`;
  const minutes = m.duration_ms === null ? 'n/a' : `${(m.duration_ms / 60000).toFixed(1)} min`;
  return `${label}: ${cost}, ${minutes}, ${m.num_turns ?? 'n/a'} turns, ${m.permission_denials ?? 0} permission denial(s).`;
}

/** @returns {string} cost and duration of every Claude run of the round, with the total cost */
export function metricsLine(outcome, firstCost = '') {
  if (!outcome && firstCost !== '' && Number.isFinite(Number(firstCost)))
    return `No fixer result; the first Claude run cost $${Number(firstCost).toFixed(2)}.`;
  const runs = [
    ['Claude', outcome?.metrics],
    ['Claude repair pass', outcome?.repair?.metrics],
  ].filter(([, m]) => m);
  if (runs.length === 0) return 'No Claude metrics.';
  const lines = runs.map(([label, m]) => runLine(label, m));
  if (runs.length > 1) {
    const costs = runs.map(([, m]) => m.total_cost_usd);
    const total = costs.every((c) => c !== null)
      ? `$${costs.reduce((a, c) => a + Number(c), 0).toFixed(2)}`
      : 'n/a';
    lines.push(`Claude total for the round: ${total}.`);
  }
  return lines.join(' ');
}

async function main() {
  const config = loadConfig();
  const file = process.env.OUTCOME_FILE;
  const outcome = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const pr = env('PR_NUMBER');
  const actions = plan({
    config,
    outcome,
    mode: env('MODE'),
    routeReason: process.env.ROUTE_REASON ?? '',
    routeDetail: process.env.ROUTE_DETAIL ?? '',
    dropReady: process.env.DROP_READY === 'true',
    headSha: process.env.HEAD_SHA ?? '',
    fixResult: process.env.FIX_RESULT ?? '',
    pushResult: process.env.PUSH_RESULT ?? '',
    pushedSha: process.env.PUSHED_SHA ?? '',
    runUrl: env('RUN_URL'),
    round: Number(process.env.ROUND || '0'),
  });
  await apply(clientFromEnv(), pr, actions);
  summary(
    `## Fixer report for #${pr}\n\n- Added labels: ${actions.add.join(', ') || 'none'}\n- Removed labels: ${actions.remove.join(', ') || 'none'}\n- ${metricsLine(outcome, process.env.FIRST_COST ?? '')}\n`,
  );
  if (actions.comment) summary(`\n${actions.comment}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`report: ${error.message}\n`);
    process.exit(1);
  });
}
