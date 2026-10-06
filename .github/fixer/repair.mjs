import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { excerpt } from './cilog.mjs';
import { stageAll } from './collect.mjs';
import { env, loadConfig, setOutput, summary } from './github.mjs';
import { checkResolution } from './merge.mjs';
import { checkChanges, collectDiff, git, matchesAny } from './policy.mjs';
import {
  MAX_NAMED,
  REPAIRABLE,
  checkRepair,
  failedGate,
  namedFiles,
  parsePathList,
  repairBudget,
  repairCauses,
  repairMarkdown,
  repairableRound,
  shouldRepair,
  validateRepairOutput,
} from './repairpolicy.mjs';
import { selectFindings, validateDocument } from './select.mjs';

export * from './repairpolicy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function readJson(path, fallback) {
  if (!path || !existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function gateStates(prefix) {
  return {
    install: process.env[`${prefix}INSTALL`] || 'skipped',
    check: process.env[`${prefix}CHECK`] || 'skipped',
    smoke: process.env[`${prefix}SMOKE`] || 'skipped',
  };
}

export function buildRepairPrompt({ dir = HERE, inputDir, gate }) {
  const prompt = readFileSync(join(dir, 'repair-prompt.md'), 'utf8');
  return [
    prompt,
    '',
    '## Run inputs',
    '',
    `The gate \`pnpm ${gate}\` failed. Read \`${join(inputDir, 'repair.md')}\` first.`,
    '',
  ].join('\n');
}

function repairSchema() {
  const schema = JSON.stringify(JSON.parse(readFileSync(join(HERE, 'repair-schema.json'), 'utf8')));
  if (schema.includes("'")) throw new Error('schema must not contain single quotes');
  return schema;
}

const SHA = /^[0-9a-f]{40}$/;

function collectTree() {
  const tree = env('COLLECT_TREE');
  if (!SHA.test(tree)) throw new Error('invalid tree from the collect step');
  return tree;
}

/**
 * Writes the round for the repair job: `wip.bundle` with one commit of the policy-checked tree on
 * the PR head, the input directory (with `repair.md`) and the first Claude execution file.
 */
export function handoff({ cwd, inputDir, first, tree, dir, head, named, ex }) {
  mkdirSync(dir, { recursive: true });
  const ident = ['-c', 'user.name=fixer', '-c', 'user.email=fixer@localhost'];
  const message = 'fixer round before the repair';
  const wip = git([...ident, 'commit-tree', tree, '-p', head, '-m', message], cwd).trim();
  git(['branch', '-f', 'fixer-wip', wip], cwd);
  git(['bundle', 'create', join(dir, 'wip.bundle'), 'fixer-wip', `^${head}`], cwd);
  cpSync(inputDir, join(dir, 'input'), { recursive: true });
  if (existsSync(first)) copyFileSync(first, join(dir, 'first-execution.json'));
  writeFileSync(join(dir, 'gate.json'), `${JSON.stringify({ named, excerpt: ex.text })}\n`);
}

/**
 * Prepare step (fix job): evaluates the round with green gates and, when one repair pass runs,
 * writes `repair.md`, hands the round over to the repair job and sets the step outputs gate,
 * allowed, before, budget and run_repair. The tree and the changed files come from the collect
 * step's outputs.
 */
async function prepare() {
  const { evaluate } = await import('./finalize.mjs');
  const config = loadConfig();
  const cwd = env('WORK_DIR');
  const inputDir = env('INPUT_DIR');
  const stateDir = env('STATE_DIR');
  mkdirSync(stateDir, { recursive: true });
  const gates = gateStates('GATE_');
  const first = join(stateDir, 'first-execution.json');
  if (process.env.EXECUTION_FILE && existsSync(process.env.EXECUTION_FILE))
    copyFileSync(process.env.EXECUTION_FILE, first);
  const green = { install: 'success', check: 'success', smoke: 'success' };
  const { verdict } = evaluate({ config, cwd, inputDir, gates: green, executionFile: first });
  const gate = failedGate(gates);
  const budget = repairBudget({
    roundMax: Number(process.env.ROUND_MAX_BUDGET_USD || '25'),
    repairMax: Number(process.env.REPAIR_MAX_BUDGET_USD || '10'),
    spent: Number(process.env.FIRST_COST || '0'),
  });
  const touched = parsePathList(process.env.COLLECT_FILES);
  const run =
    shouldRepair({ gates, pushWithGreenGates: verdict.push }) &&
    budget > 0 &&
    repairableRound(process.env.MODE, touched, config);
  if (!run) {
    setOutput('run_repair', 'false');
    process.stdout.write(
      `repair: not eligible (gate ${gate ?? 'none'}, push=${verdict.push}, budget=${budget})\n`,
    );
    return;
  }
  const log = readFileSync(join(env('GATE_LOG_DIR'), `${gate}.log`), 'utf8');
  const ex = excerpt(log.split('\n'), {
    maxLines: config.ci.excerpt_lines,
    maxLineChars: config.ci.excerpt_line_chars,
    maxBytes: config.ci.excerpt_bytes,
  });
  const tracked = git(['ls-files', '-z'], cwd).split('\0').filter(Boolean);
  const named = namedFiles(ex.text, tracked, cwd);
  const allowed = [...new Set([...named, ...touched])].sort();
  writeFileSync(join(inputDir, 'repair.md'), repairMarkdown({ gate, allowed, ex }));
  const tree = collectTree();
  const dir = env('HANDOFF_DIR');
  handoff({ cwd, inputDir, first, tree, dir, head: env('HEAD_SHA'), named, ex });
  setOutput('gate', gate);
  setOutput('run_repair', 'true');
  summary(
    `### Repair pass\n\n\`pnpm ${gate}\` failed; one repair pass on ${allowed.length} allowed file(s), budget $${budget.toFixed(2)}.\n`,
  );
  process.stdout.write(`repair: gate ${gate}, ${named.length} named, ${allowed.length} allowed\n`);
}

/**
 * Puts the handed-over round into the checkout: the bundle's commit must have the PR head as its
 * only parent; afterwards HEAD is the PR head and the index and the work tree hold its tree.
 * @returns {string} the tree id of the handed-over round
 */
export function restoreRound({ cwd, dir, head }) {
  const bundle = join(dir, 'wip.bundle');
  git(['bundle', 'verify', '-q', bundle], cwd);
  git(['fetch', '-q', '--no-tags', bundle, '+fixer-wip:refs/fixer/wip'], cwd);
  const wip = git(['rev-parse', 'refs/fixer/wip^{commit}'], cwd).trim();
  const parents = git(['rev-list', '--parents', '-n', '1', wip], cwd).trim().split(' ').slice(1);
  if (parents.length !== 1 || parents[0] !== head)
    throw new Error('the handed-over round is not based on the PR head');
  git(['checkout', '-q', '--detach', wip], cwd);
  git(['reset', '-q', '--soft', head], cwd);
  return git(['rev-parse', `${wip}^{tree}`], cwd).trim();
}

/**
 * Checks the handed-over tree with the round policy before any code of it runs on the repair
 * runner: a fix round against the selected findings (and without any package.json change), a
 * merge round with `checkResolution`.
 * @returns {{violations: string[], touched: string[]}}
 */
export function checkHandedTree({ cwd, mode, head, base, tree, fixable, config }) {
  if (mode === 'merge') {
    const r = checkResolution({ cwd, head, base, tree, config });
    return { violations: r.violations, touched: [...r.conflicts, ...r.extra].sort() };
  }
  const r = checkChanges(collectDiff(head, tree, cwd), fixable, config);
  const violations = [...r.violations];
  for (const path of r.files)
    if (matchesAny(path, config.merge.union_paths))
      violations.push(`${path}: a round that changes package.json is not repaired`);
  return { violations, touched: [...r.files].sort() };
}

function reviewFixable() {
  if (!process.env.REVIEW_RUN) return [];
  const doc = JSON.parse(readFileSync(env('FINDINGS_FILE'), 'utf8'));
  validateDocument(doc, { pr: env('PR_NUMBER'), headSha: env('HEAD_SHA') });
  return selectFindings(doc).fixable;
}

function readGateHandoff(dir, cwd, config) {
  const doc = readJson(join(dir, 'gate.json'), {});
  const tracked = new Set(git(['ls-files', '-z'], cwd).split('\0').filter(Boolean));
  let named;
  try {
    named = parsePathList(JSON.stringify(doc.named ?? []), MAX_NAMED);
  } catch {
    named = [];
  }
  const ex = excerpt(String(doc.excerpt ?? '').split('\n'), {
    maxLines: config.ci.excerpt_lines,
    maxLineChars: config.ci.excerpt_line_chars,
    maxBytes: config.ci.excerpt_bytes,
  });
  return { named: named.filter((p) => tracked.has(p)), ex };
}

/**
 * Restore step (repair job, before any PR code runs): restores the handed-over tree, checks it
 * with the round policy, and computes everything the repair needs on this runner: allowed files
 * (files the round changed plus at most 20 tracked files named by the gate), `repair.md`, the
 * budget, prompt, schema and tool rules. Sets the outputs before, allowed, budget, prompt,
 * schema, allowed_tools, denied_tools and first_execution.
 */
async function restore() {
  const { toolRules } = await import('./prepare.mjs');
  const config = loadConfig();
  const cwd = env('WORK_DIR');
  const dir = env('HANDOFF_DIR');
  const inputDir = env('INPUT_DIR');
  const stateDir = env('STATE_DIR');
  const head = env('HEAD_SHA');
  const gate = env('REPAIR_GATE');
  if (!REPAIRABLE.includes(gate)) throw new Error(`unexpected gate ${gate}`);
  const tree = restoreRound({ cwd, dir, head });
  const mode = process.env.MODE === 'merge' ? 'merge' : 'fix';
  const base = mode === 'merge' ? env('BASE_SHA') : '';
  const fixable = mode === 'fix' ? reviewFixable() : [];
  const handed = checkHandedTree({ cwd, mode, head, base, tree, fixable, config });
  if (handed.violations.length > 0)
    throw new Error(`the handed-over round fails the policy:\n- ${handed.violations.join('\n- ')}`);
  const { named, ex } = readGateHandoff(dir, cwd, config);
  const allowed = [...new Set([...named, ...handed.touched])].sort();
  const spent = Number(process.env.FIRST_COST || '0');
  const budget = repairBudget({
    roundMax: Number(process.env.ROUND_MAX_BUDGET_USD || '25'),
    repairMax: Number(process.env.REPAIR_MAX_BUDGET_USD || '10'),
    spent,
  });
  if (budget <= 0) throw new Error('no budget left for the repair pass');
  mkdirSync(stateDir, { recursive: true });
  cpSync(join(dir, 'input'), inputDir, { recursive: true });
  writeFileSync(join(inputDir, 'repair.md'), repairMarkdown({ gate, allowed, ex }));
  const first = join(stateDir, 'first-execution.json');
  if (existsSync(join(dir, 'first-execution.json')))
    copyFileSync(join(dir, 'first-execution.json'), first);
  const rules = toolRules(config);
  setOutput('before', tree);
  setOutput('allowed', JSON.stringify(allowed));
  setOutput('budget', budget.toFixed(2));
  setOutput('prompt', buildRepairPrompt({ inputDir, gate }));
  setOutput('schema', repairSchema());
  setOutput('allowed_tools', rules.allowed);
  setOutput('denied_tools', rules.denied);
  setOutput('first_execution', existsSync(first) ? first : '');
  process.stdout.write(`repair: restored and checked tree ${tree} on ${head}\n`);
}

/** @returns {object} the round policy (fix or merge mode) on `tree`, with the repair paths allowed */
function roundPolicy({ config, cwd, inputDir, tree, repairPaths }) {
  const head = env('HEAD_SHA');
  if (process.env.MODE === 'merge') {
    const r = checkResolution({ cwd, head, base: env('BASE_SHA'), tree, config, repairPaths });
    return { ...r, files: [...r.conflicts, ...r.extra] };
  }
  const { fixable } = readJson(join(inputDir, 'selection.json'), { fixable: [] });
  return checkChanges(collectDiff(head, null, cwd), fixable, config);
}

/**
 * Collect step after the repair: checks the repair edits and the whole round on the staged tree,
 * rewrites `policy.json`, writes the descriptive `repair.json` and sets the outputs `ok` and
 * `paths` (the verdict and the repair paths finalize and verify use).
 */
async function collect() {
  const { extractRun } = await import('./finalize.mjs');
  const config = loadConfig();
  const cwd = env('WORK_DIR');
  const inputDir = env('INPUT_DIR');
  const stateDir = env('STATE_DIR');
  const gate = env('REPAIR_GATE');
  const before = env('REPAIR_BEFORE');
  if (!SHA.test(before)) throw new Error('invalid tree before the repair');
  const allowed = parsePathList(process.env.REPAIR_ALLOWED);
  const run = extractRun(readJson(process.env.REPAIR_EXECUTION_FILE, []));
  const output = validateRepairOutput(run.output);
  const tree = stageAll(cwd);
  const changed = tree !== before;
  const repair = checkRepair({ diff: collectDiff(before, tree, cwd), allowed, output, config });
  const round = roundPolicy({ config, cwd, inputDir, tree, repairPaths: repair.paths });
  const previous = readJson(join(inputDir, 'policy.json'), {});
  const policy = { ...previous, ...round, tree, changed: true };
  writeFileSync(join(inputDir, 'policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
  const result = {
    ran: true,
    gate,
    output,
    changed,
    paths: repair.paths,
    lines: repair.lines,
    violations: [...repair.violations, ...round.violations],
  };
  writeFileSync(join(stateDir, 'repair.json'), `${JSON.stringify(result, null, 2)}\n`);
  const ok = repairCauses(result).length === 0;
  setOutput('claude_cost', String(run.metrics?.total_cost_usd ?? ''));
  setOutput('ok', String(ok));
  setOutput('paths', JSON.stringify(ok ? repair.paths : []));
  const list = result.violations.map((v) => `- ${v}`).join('\n') || '- none';
  summary(
    `### Repair policy\n\n${repair.paths.length} file(s), ${repair.lines} line(s).\n\nViolations:\n${list}\n`,
  );
  process.stdout.write(`repair: changed=${changed} ok=${ok}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const commands = { prepare, restore, collect };
  const command = commands[process.argv[2]];
  if (!command) {
    process.stderr.write('usage: repair.mjs prepare|restore|collect\n');
    process.exit(2);
  }
  command().catch((error) => {
    process.stderr.write(`repair: ${error.message}\n`);
    process.exit(1);
  });
}
