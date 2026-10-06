import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ciMarkdown, downloadJobLog, excerpt, sliceStep, transientCause } from './cilog.mjs';
import { clientFromEnv, env, loadConfig, setOutput, summary } from './github.mjs';
import {
  classifyConflicts,
  conflictMarkdown,
  gitStatus,
  hasMarkers,
  isAncestor,
  mergeTree,
  parseUnmerged,
  readBlob,
  unionFor,
} from './merge.mjs';
import { git } from './policy.mjs';
import { findingsMarkdown, selectFindings, validateDocument } from './select.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** @returns {{allowed: string, denied: string}} comma-separated tool rules for claude_args */
export function toolRules(config) {
  const bash = [...config.bash_allow];
  for (const pkg of config.workspace_packages) {
    for (const cmd of config.bash_allow_per_package) bash.push(`pnpm --filter ${pkg} ${cmd}`);
  }
  const allowed = ['Read', 'Grep', 'Glob', 'Edit', 'Write', ...bash.map((b) => `Bash(${b})`)];
  const all = [...allowed, ...config.denied_tools];
  if (all.some((r) => /["'$`\\,;|&<>]/.test(r.replace(/^[A-Za-z]+\((.*)\)$/, '$1'))))
    throw new Error('tool rules must not contain quotes, commas, shell operators or backslashes');
  return { allowed: allowed.join(','), denied: config.denied_tools.join(',') };
}

export function buildPrompt({ dir = HERE, inputDir, round, maxRounds, findings = 1, ci = 0 }) {
  const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8');
  const rules = readFileSync(join(dir, 'rules.md'), 'utf8');
  const inputs = [];
  if (findings > 0) inputs.push(`\`${join(inputDir, 'findings.md')}\` (${findings} finding(s))`);
  if (ci > 0) inputs.push(`\`${join(inputDir, 'ci-failures.md')}\` (${ci} failed CI step(s))`);
  return [
    prompt,
    '',
    rules,
    '',
    '## Run inputs',
    '',
    `This is fixer round ${round} of at most ${maxRounds}.`,
    `Input directory: \`${inputDir}\`. Read ${inputs.join(' and ') || 'nothing (no input)'} first.`,
    '',
  ].join('\n');
}

/**
 * Turns the failed CI steps from the route job into fixer items C1..Cn with a safe log excerpt.
 * A step whose excerpt matches a transient pattern, and every infrastructure failure, is not given
 * to Claude; it is reported as `ci_infra`.
 * @returns {{ci: object[], ciInfra: object[]}}
 */
export function selectCi({ failures, logs, config }) {
  const ci = [];
  const ciInfra = failures.infra.map((i) => ({ ...i }));
  const limits = {
    maxLines: config.ci.excerpt_lines,
    maxLineChars: config.ci.excerpt_line_chars,
    maxBytes: config.ci.excerpt_bytes,
  };
  for (const step of failures.steps) {
    const log = logs[step.job_id];
    const ex =
      typeof log === 'string'
        ? excerpt(sliceStep(log, step), limits)
        : {
            text: `(the job log could not be downloaded: ${log?.error ?? 'unknown'})`,
            lines: 1,
            truncated: false,
          };
    const item = {
      workflow: step.workflow,
      run_url: step.run_url,
      job: step.job,
      step: step.step,
      number: step.number,
      excerpt: ex.text,
      lines: ex.lines,
      truncated: ex.truncated,
    };
    const transient = transientCause(ex.text, config.ci.transient_patterns);
    if (transient)
      ciInfra.push({ ...item, why: `the log matches the transient pattern /${transient}/` });
    else ci.push(item);
  }
  ci.forEach((c, i) =>
    Object.assign(c, { id: `C${i + 1}`, rule: 'CI', title: `${c.job} / ${c.step}` }),
  );
  ciInfra.forEach((c, i) => {
    delete c.excerpt;
    const title = [c.workflow, c.job, c.step].filter(Boolean).join(' / ');
    Object.assign(c, { id: `I${i + 1}`, rule: 'CI', title });
  });
  return { ci, ciInfra };
}

async function fetchLogs(steps, config) {
  const request = clientFromEnv();
  const logs = {};
  for (const id of new Set(steps.map((s) => s.job_id))) {
    try {
      logs[id] = await downloadJobLog({ request, jobId: id, maxBytes: config.ci.log_bytes });
    } catch (error) {
      logs[id] = { error: String(error.status ?? 'request failed') };
    }
  }
  return logs;
}

function readFindings() {
  if (!process.env.REVIEW_RUN) return { fixable: [], scope: [] };
  const file = env('FINDINGS_FILE');
  if (!existsSync(file)) throw new Error('the review result is missing');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  validateDocument(doc, { pr: env('PR_NUMBER'), headSha: env('HEAD_SHA') });
  return selectFindings(doc);
}

export function compactSchema(dir = HERE, file = 'schema.json') {
  const schema = JSON.stringify(JSON.parse(readFileSync(join(dir, file), 'utf8')));
  if (schema.includes("'")) throw new Error('schema must not contain single quotes');
  return schema;
}

export function buildMergePrompt({ dir = HERE, inputDir, round, maxRounds, files }) {
  const prompt = readFileSync(join(dir, 'merge-prompt.md'), 'utf8');
  return [
    prompt,
    '',
    '## Run inputs',
    '',
    `This is fixer round ${round} of at most ${maxRounds}.`,
    `Input directory: \`${inputDir}\`. Read \`${join(inputDir, 'conflicts.md')}\` (${files} conflicted file(s)) first.`,
    '',
  ].join('\n');
}

function writeMergeState(inputDir, state) {
  writeFileSync(join(inputDir, 'merge-state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Merges the base tip into the PR head without committing, before any PR code runs (hooks are off;
 * merge drivers can only be git's built-in ones). The conflicts come from `git merge-tree`, the same
 * computation the push job repeats, and must match what `git merge` left in the index. Conflicts in
 * protected files stop the round before Claude; package.json script conflicts are merged by union;
 * the remaining text conflicts are handed to Claude with the history of both sides.
 * @returns {object} the merge state written to merge-state.json
 */
export function prepareMergeState({ cwd, head, base, config }) {
  if (git(['rev-parse', 'HEAD'], cwd).trim() !== head)
    throw new Error('the checkout is not the PR head');
  git(['cat-file', '-e', `${base}^{commit}`], cwd);
  if (isAncestor(cwd, base, head))
    return { up_to_date: true, merge: false, claude: [], union: [], blocked: [] };
  const auto = mergeTree(cwd, head, base);
  const classes = classifyConflicts(auto.conflicts, config, (oid) => readBlob(cwd, oid));
  const r = gitStatus(
    [
      '-c',
      `user.name=${config.bot_login}`,
      '-c',
      `user.email=${config.bot_email}`,
      'merge',
      '--no-ff',
      '--no-commit',
      '--no-edit',
      base,
    ],
    cwd,
  );
  if (r.status !== 0 && r.status !== 1) throw new Error('git merge failed');
  const unmerged = parseUnmerged(git(['ls-files', '-u', '-z'], cwd)).map((c) => c.path);
  if (unmerged.join('\n') !== auto.conflicts.map((c) => c.path).join('\n'))
    throw new Error('git merge and git merge-tree disagree about the conflicted files');
  const blocked = [...classes.blocked];
  if (auto.conflicts.length > config.merge.max_files)
    blocked.push({
      path: `${auto.conflicts.length} files`,
      why: `more conflicted files than the limit of ${config.merge.max_files}`,
    });
  const claude = [];
  for (const c of classes.claude) {
    const text = readFileSync(join(cwd, c.path), 'utf8');
    if (hasMarkers(text)) claude.push({ path: c.path });
    else
      blocked.push({ path: c.path, why: 'no conflict markers in the file (not a text conflict)' });
  }
  const union = [];
  for (const c of classes.union) {
    const result = unionFor(cwd, c);
    if (result.error) blocked.push({ path: c.path, why: `package.json: ${result.error}` });
    else union.push({ path: c.path, scripts: result.scripts, text: result.text });
  }
  const ok = blocked.length === 0;
  if (ok) for (const u of union) writeFileSync(join(cwd, u.path), u.text);
  return {
    up_to_date: false,
    merge: ok,
    clean: auto.clean,
    claude: ok ? claude : [],
    union: union.map(({ path, scripts }) => ({ path, scripts })),
    blocked,
    conflicts: auto.conflicts.map((c) => c.path),
  };
}

function prepareMerge(config) {
  const cwd = env('WORK_DIR');
  const inputDir = env('INPUT_DIR');
  const head = env('HEAD_SHA');
  const base = env('BASE_SHA');
  const baseRef = env('BASE_REF');
  const round = Number(env('ROUND'));
  mkdirSync(inputDir, { recursive: true });
  const state = prepareMergeState({ cwd, head, base, config });
  writeMergeState(inputDir, { ...state, base_sha: base, base_ref: baseRef });
  if (state.claude.length > 0)
    writeFileSync(
      join(inputDir, 'conflicts.md'),
      conflictMarkdown({
        cwd,
        head,
        base,
        baseRef,
        claude: state.claude,
        union: state.union,
        config,
      }),
    );
  const rules = toolRules(config);
  setOutput('run_claude', String(state.claude.length > 0));
  setOutput('merge', String(state.merge));
  setOutput(
    'prompt',
    buildMergePrompt({ inputDir, round, maxRounds: config.max_rounds, files: state.claude.length }),
  );
  setOutput('schema', compactSchema(HERE, 'merge-schema.json'));
  setOutput('allowed_tools', rules.allowed);
  setOutput('denied_tools', rules.denied);
  summary(
    `## Fixer round ${round}: merge ${baseRef}\n\n${state.up_to_date ? 'Already up to date.' : `${state.conflicts.length} conflicted file(s): ${state.claude.length} for Claude, ${state.union.length} package.json union(s), ${state.blocked.length} for a human.`}\n`,
  );
  process.stdout.write(
    `prepare: merge up_to_date=${state.up_to_date} claude=${state.claude.length} union=${state.union.length} blocked=${state.blocked.length}\n`,
  );
}

async function main() {
  const config = loadConfig();
  if (process.env.MODE === 'merge') return prepareMerge(config);
  setOutput('merge', 'false');
  const inputDir = env('INPUT_DIR');
  const round = Number(env('ROUND'));
  mkdirSync(inputDir, { recursive: true });
  const { fixable, scope } = readFindings();
  const failures = JSON.parse(process.env.CI_FAILURES || '{"steps":[],"infra":[]}');
  const logs = failures.steps.length > 0 ? await fetchLogs(failures.steps, config) : {};
  const { ci, ciInfra } = selectCi({ failures, logs, config });
  const forSelection = ci.map((c) =>
    Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'excerpt')),
  );
  writeFileSync(
    join(inputDir, 'selection.json'),
    `${JSON.stringify({ fixable, scope, ci: forSelection, ci_infra: ciInfra }, null, 2)}\n`,
  );
  writeFileSync(join(inputDir, 'findings.md'), findingsMarkdown(fixable));
  writeFileSync(join(inputDir, 'ci-failures.md'), ciMarkdown(ci));
  const rules = toolRules(config);
  const prompt = buildPrompt({
    inputDir,
    round,
    maxRounds: config.max_rounds,
    findings: fixable.length,
    ci: ci.length,
  });
  setOutput('run_claude', String(fixable.length + ci.length > 0));
  setOutput('prompt', prompt);
  setOutput('schema', compactSchema());
  setOutput('allowed_tools', rules.allowed);
  setOutput('denied_tools', rules.denied);
  summary(
    `## Fixer round ${round}\n\n${fixable.length} blocking code finding(s), ${scope.length} blocking scope finding(s), ${ci.length} failed CI step(s), ${ciInfra.length} CI infrastructure failure(s).\n`,
  );
  process.stdout.write(
    `prepare: ${fixable.length} fixable, ${scope.length} scope, ${ci.length} ci, ${ciInfra.length} ci_infra\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`prepare: ${error.message}\n`);
    process.exit(1);
  });
}
