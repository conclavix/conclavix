import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageAll } from './collect.mjs';
import { commitMessage, decide, validateOutput } from './decide.mjs';
import { env, loadConfig, plain, setOutput, summary } from './github.mjs';
import { decideMerge, mergeCommitMessage, validateMergeOutput } from './mergedecide.mjs';
import { git } from './policy.mjs';
import { finalRepairCauses, parsePathList, validateRepairOutput } from './repair.mjs';

function readJson(path, fallback) {
  if (!path || !existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** @returns {{output: object|null, metrics: object|null}} structured output and cost of the Claude run */
export function extractRun(messages) {
  if (!Array.isArray(messages)) return { output: null, metrics: null };
  const result = [...messages].reverse().find((m) => m && m.type === 'result');
  if (!result) return { output: null, metrics: null };
  const metrics = {
    subtype: result.subtype ?? null,
    duration_ms: result.duration_ms ?? null,
    num_turns: result.num_turns ?? null,
    total_cost_usd: result.total_cost_usd ?? null,
    permission_denials: Array.isArray(result.permission_denials)
      ? result.permission_denials.length
      : 0,
  };
  return { output: result.structured_output ?? null, metrics };
}

const NO_OUTPUT =
  'the Claude step failed before it produced any output, see the "Fix with Claude" step log';

const NO_DEPS =
  'the dependencies could not be installed with the frozen lockfile, see the "Install dependencies" step log';

/**
 * First line of the error recorded by the sandbox step (only when that step failed, so a file
 * written while Claude ran is ignored), or a fixed text when the Claude step failed without writing
 * a single message. Never echoes the environment, so no secret can end up here.
 * @returns {string|null} why Claude could not start, null when it started
 */

export function startFailure({ errorText, sandboxOutcome, depsOutcome, claudeOutcome, messages }) {
  if (depsOutcome === 'failure') return NO_DEPS;
  if (sandboxOutcome === 'failure') {
    const line = String(errorText ?? '')
      .split('\n')
      .map((l) => plain(l, 240))
      .find(Boolean);
    return line || 'the bubblewrap sandbox step failed, see its step log';
  }
  const started = Array.isArray(messages) && messages.length > 0;
  return claudeOutcome === 'failure' && !started ? NO_OUTPUT : null;
}

function readText(path) {
  return path && existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function describe(list, selected) {
  const byId = new Map(selected.map((f) => [f.id, f]));
  return list.map((d) => {
    const f = byId.get(d.id) ?? {};
    return { ...d, title: f.title ?? d.title, file: f.file, line: f.line, rule: f.rule };
  });
}

function commitAndBundle({ cwd, resultDir, message, config }) {
  const file = join(resultDir, 'commit-message.txt');
  writeFileSync(file, message);
  git(
    [
      '-c',
      `user.name=${config.bot_login}`,
      '-c',
      `user.email=${config.bot_email}`,
      'commit',
      '--no-verify',
      '-q',
      '-F',
      file,
    ],
    cwd,
  );
  const sha = git(['rev-parse', 'HEAD'], cwd).trim();
  git(['branch', '-f', 'fixer-out', sha], cwd);
  git(['bundle', 'create', join(resultDir, 'fix.bundle'), 'fixer-out', `^${env('HEAD_SHA')}`], cwd);
  return sha;
}

function gateStates(prefix = 'GATE_') {
  return {
    install: process.env[`${prefix}INSTALL`] || 'skipped',
    check: process.env[`${prefix}CHECK`] || 'skipped',
    smoke: process.env[`${prefix}SMOKE`] || 'skipped',
  };
}

/** @returns {object} the gates of the round: the re-run after a repair pass when it ran */
export function finalGates({ first, second, repairRan }) {
  return repairRan && second.install !== 'skipped' ? second : first;
}

function readInputs(inputDir) {
  const selection = readJson(join(inputDir, 'selection.json'), {});
  const { fixable = [], scope = [], ci = [], ci_infra: ciInfra = [] } = selection;
  const policy = readJson(join(inputDir, 'policy.json'), {
    violations: [],
    changed: false,
    tree: '',
  });
  return { selected: [...fixable, ...ci], scope, ci, ciInfra, policy };
}

/** @returns {object} structured output, metrics and start error of the Claude step */
function readClaudeRun(executionFile) {
  const messages = readJson(executionFile, []);
  const { output, metrics } = extractRun(messages);
  const startError = startFailure({
    errorText: readText(process.env.START_ERROR_FILE),
    sandboxOutcome: process.env.SANDBOX_OUTCOME ?? '',
    depsOutcome: process.env.DEPS_OUTCOME ?? '',
    claudeOutcome: process.env.CLAUDE_OUTCOME ?? '',
    messages,
  });
  return { raw: output, metrics, startError };
}

function evaluateFix({ cwd, inputDir, gates, claude }) {
  const { selected, scope, ci, ciInfra, policy } = readInputs(inputDir);
  const output = validateOutput(
    claude.raw,
    selected.map((f) => f.id),
  );
  const violations = [...policy.violations];
  if (policy.changed && stageAll(cwd) !== policy.tree)
    violations.push('the gates changed tracked files');
  const verdict = decide({
    selected,
    scope,
    ciInfra,
    output,
    changed: policy.changed,
    violations,
    gates,
    startError: claude.startError,
  });
  return { mode: 'fix', verdict, output, selected, ci, ciInfra, violations, policy };
}

function evaluateMerge({ cwd, inputDir, gates, claude, repairPaths }) {
  const state = readJson(join(inputDir, 'merge-state.json'), null);
  if (!state) throw new Error('merge-state.json is missing');
  const policy = readJson(join(inputDir, 'policy.json'), {
    violations: [],
    extra: [],
    changed: false,
    tree: '',
  });
  const output = validateMergeOutput(
    claude.raw,
    (state.claude ?? []).map((c) => c.path),
  );
  const violations = [...(policy.violations ?? [])];
  if (state.merge && policy.changed && stageAll(cwd) !== policy.tree)
    violations.push('the gates changed tracked files');
  const verdict = decideMerge({
    state,
    output,
    changed: Boolean(state.merge && policy.changed),
    violations,
    extra: (policy.extra ?? []).filter((p) => !repairPaths.includes(p)),
    gates,
    startError: claude.startError,
  });
  return { mode: 'merge', verdict, output, state, violations, policy };
}

/**
 * Evaluates the round (fix or merge mode) for the given gate results without committing.
 * @returns {object} mode, verdict, the validated Claude output and the inputs used
 */
export function evaluate({ cwd, inputDir, gates, executionFile, repairPaths = [] }) {
  const claude = readClaudeRun(executionFile);
  const args = { cwd, inputDir, gates, claude, repairPaths };
  const result = process.env.MODE === 'merge' ? evaluateMerge(args) : evaluateFix(args);
  return { ...result, metrics: claude.metrics };
}

/** @returns {object|null} the metrics of a run with total_cost_usd from a step output when set */
export function withTrustedCost(metrics, cost) {
  const value = Number(cost);
  if (!metrics || cost === undefined || cost === '' || !Number.isFinite(value)) return metrics;
  return { ...metrics, total_cost_usd: value };
}

/** @returns {object} the verdict with the repair pass causes added; any cause stops the push */
export function withRepair(verdict, repair) {
  const causes = finalRepairCauses(repair);
  if (causes.length === 0) return verdict;
  return {
    ...verdict,
    push: false,
    escalate: true,
    causes: [...verdict.causes, ...causes],
    fixed: [],
  };
}

/** @returns {string} the commit message with the repair edits listed before the round trailer */
export function repairMessage(message, repair, trailer) {
  if (!repair?.ran || !repair.output) return message;
  const lines = [`Gate repair (pnpm ${plain(repair.gate, 20)} failed first, passed after):`];
  for (const e of repair.output.repair_edits)
    lines.push(`- ${plain(e.path, 200)}: ${plain(e.reason, 300)}`);
  const at = message.lastIndexOf(`\n${trailer}:`);
  if (at < 0) return message;
  return `${message.slice(0, at)}\n${lines.join('\n')}\n${message.slice(at)}`;
}

function repairSummary(repair, gatesBefore) {
  if (!repair?.ran) return null;
  return {
    gate: repair.gate,
    decision: repair.output?.decision ?? null,
    edits: repair.output?.repair_edits ?? [],
    summary: repair.output?.summary ?? '',
    violations: repair.violations,
    gates_before: gatesBefore,
    metrics: repair.metrics ?? null,
  };
}

/**
 * Writes the merge commit with exactly two parents, the reviewed PR head and the base tip, from the
 * tree the policy and the gates saw. `git commit` is not used, so nothing Claude or a test did to
 * HEAD or MERGE_HEAD can change the parents.
 * @returns {string} the merge commit
 */
function commitMerge({ cwd, resultDir, message, config, tree, head, base }) {
  const file = join(resultDir, 'commit-message.txt');
  writeFileSync(file, message);
  const sha = git(
    [
      '-c',
      `user.name=${config.bot_login}`,
      '-c',
      `user.email=${config.bot_email}`,
      'commit-tree',
      tree,
      '-p',
      head,
      '-p',
      base,
      '-F',
      file,
    ],
    cwd,
  ).trim();
  git(['branch', '-f', 'fixer-out', sha], cwd);
  git(
    ['bundle', 'create', join(resultDir, 'fix.bundle'), 'fixer-out', `^${head}`, `^${base}`],
    cwd,
  );
  return sha;
}

function finalizeMerge({ config, cwd, resultDir, round, result, verdict, repair }) {
  const { output, state, violations, policy } = result;
  const head = env('HEAD_SHA');
  const base = env('BASE_SHA');
  let commit = null;
  if (verdict.push) {
    const message = mergeCommitMessage({
      baseRef: env('BASE_REF'),
      headRef: env('HEAD_REF'),
      base,
      head,
      round,
      trailer: config.round_trailer,
      files: verdict.files,
      output,
    });
    commit = commitMerge({
      cwd,
      resultDir,
      message: repairMessage(message, repair, config.round_trailer),
      config,
      tree: policy.tree,
      head,
      base,
    });
  }
  return {
    kind: 'merge',
    head_sha: head,
    base_sha: base,
    base_ref: env('BASE_REF'),
    up_to_date: Boolean(state.up_to_date),
    commit,
    files: verdict.files,
    extra_edits: output?.extra_edits ?? [],
    fixed: [],
    open: [],
    violations,
  };
}

function finalizeFix({ config, cwd, resultDir, round, result, verdict, repair }) {
  const { output, selected, ci, ciInfra, violations } = result;
  let commit = null;
  if (verdict.push) {
    const message = commitMessage({
      output,
      selected,
      round,
      trailer: config.round_trailer,
      reviewRun: process.env.REVIEW_RUN_URL ?? '',
      ciRuns: [...new Set(ci.map((c) => c.run_url).filter(Boolean))],
    });
    commit = commitAndBundle({
      cwd,
      resultDir,
      message: repairMessage(message, repair, config.round_trailer),
      config,
    });
  }
  const fixed = output
    ? describe(
        output.findings.filter((f) => verdict.fixed.includes(f.id)),
        selected,
      )
    : [];
  return {
    head_sha: env('HEAD_SHA'),
    commit,
    fixed,
    open: describe(verdict.open, [...selected, ...ciInfra]),
    violations,
  };
}

function writeOutcome(resultDir, outcome) {
  writeFileSync(join(resultDir, 'outcome.json'), `${JSON.stringify(outcome, null, 2)}\n`);
  setOutput('push', String(outcome.push));
  setOutput('commit', outcome.commit ?? '');
  summary(
    `### Outcome\n\n- Push: ${outcome.push}${outcome.commit ? ` (${outcome.commit})` : ''}\n- Escalate: ${outcome.escalate}\n- Causes: ${outcome.causes.join('; ') || 'none'}\n`,
  );
  process.stdout.write(`finalize: push=${outcome.push} escalate=${outcome.escalate}\n`);
}

/**
 * The repair pass as finalize sees it: `ok`, `gate` and `paths` from the repair steps' outputs,
 * output and metrics from the repair run's execution file, `changed` and `violations` from the
 * descriptive state file.
 * @returns {object|null} null when no repair pass ran
 */
export function repairFrom({ ran, ok, gate, paths, messages, state, started = true }) {
  if (!ran) return null;
  const { output, metrics } = extractRun(messages);
  const accepted = ok === 'true';
  return {
    ran: true,
    started,
    ok: accepted,
    gate: gate || 'check',
    paths: accepted ? parsePathList(paths, 50) : [],
    output: validateRepairOutput(output),
    metrics,
    changed: state?.changed ?? false,
    violations: state?.violations ?? [],
  };
}

function readRepair() {
  return repairFrom({
    ran: process.env.REPAIR_RAN === 'true',
    ok: process.env.REPAIR_OK,
    started: !['skipped', ''].includes(process.env.REPAIR_STARTED ?? ''),
    gate: process.env.REPAIR_GATE,
    paths: process.env.REPAIR_PATHS,
    messages: readJson(process.env.REPAIR_EXECUTION_FILE, []),
    state: readJson(join(process.env.STATE_DIR ?? '', 'repair.json'), null),
  });
}

function main() {
  const config = loadConfig();
  const cwd = env('WORK_DIR');
  const inputDir = env('INPUT_DIR');
  const resultDir = env('RESULT_DIR');
  const round = Number(env('ROUND'));
  mkdirSync(resultDir, { recursive: true });
  const repairRan = process.env.REPAIR_RAN === 'true';
  const repair = readRepair();
  const first = gateStates('GATE_');
  const gates = finalGates({ first, second: gateStates('GATE2_'), repairRan });
  const repairPaths = repair?.paths ?? [];
  const result = evaluate({
    cwd,
    inputDir,
    gates,
    executionFile: process.env.EXECUTION_FILE,
    repairPaths,
  });
  const verdict = withRepair(result.verdict, repair);
  const metrics = withTrustedCost(result.metrics, process.env.FIRST_COST);
  const args = { config, cwd, resultDir, round, result, verdict, repair };
  const specific = result.mode === 'merge' ? finalizeMerge(args) : finalizeFix(args);
  const outcome = {
    pr: Number(env('PR_NUMBER')),
    round,
    push: verdict.push,
    escalate: verdict.escalate,
    causes: verdict.causes,
    gates,
    metrics,
    summary: result.output?.summary ?? '',
    repair: repairSummary(
      repair && { ...repair, metrics: withTrustedCost(repair.metrics, process.env.REPAIR_COST) },
      repairRan ? first : null,
    ),
    ...specific,
  };
  return writeOutcome(resultDir, outcome);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`finalize: ${error.message}\n`);
    process.exit(1);
  }
}
