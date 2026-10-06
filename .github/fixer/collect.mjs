import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, loadConfig, setOutput, summary } from './github.mjs';
import { checkResolution } from './merge.mjs';
import { checkChanges, collectDiff, git } from './policy.mjs';

/** @returns {number} total_cost_usd of the last result in a Claude execution file, 0 without one */
export function claudeCost(file) {
  if (!file || !existsSync(file)) return 0;
  const messages = JSON.parse(readFileSync(file, 'utf8'));
  const result = Array.isArray(messages)
    ? [...messages].reverse().find((m) => m && m.type === 'result')
    : null;
  const cost = Number(result?.total_cost_usd);
  return Number.isFinite(cost) && cost >= 0 ? cost : 0;
}

/** @returns {string} tree id of the index after staging every change in the work tree */
export function stageAll(cwd) {
  git(['add', '-A'], cwd);
  return git(['write-tree'], cwd).trim();
}

/**
 * Merge mode: the staged tree is checked against the merge git computes for the head and the base
 * tip, with the same function the push job uses on the bundled commit.
 * @returns {object} the policy result written to policy.json
 */
function collectMerge({ cwd, head, config }) {
  const tree = stageAll(cwd);
  const result = checkResolution({ cwd, head, base: env('BASE_SHA'), tree, config });
  return { ...result, files: [...result.conflicts, ...result.extra], tree, changed: true };
}

function main() {
  setOutput('claude_cost', String(claudeCost(process.env.EXECUTION_FILE)));
  const config = loadConfig();
  const cwd = env('WORK_DIR');
  const inputDir = env('INPUT_DIR');
  const head = env('HEAD_SHA');
  if (process.env.MODE === 'merge') {
    const policy = collectMerge({ cwd, head, config });
    writeFileSync(join(inputDir, 'policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
    setOutput('changed', 'true');
    setOutput('policy_ok', String(policy.violations.length === 0));
    setOutput('tree', policy.tree);
    setOutput('files', JSON.stringify(policy.files));
    const list = policy.violations.map((v) => `- ${v}`).join('\n') || '- none';
    summary(
      `### Merge policy\n\n${policy.conflicts.length} conflicted file(s), ${policy.extra.length} other file(s) changed.\n\nViolations:\n${list}\n`,
    );
    process.stdout.write(`collect: merge violations=${policy.violations.length}\n`);
    return;
  }
  const { fixable } = JSON.parse(readFileSync(join(inputDir, 'selection.json'), 'utf8'));
  const tree = stageAll(cwd);
  const headTree = git(['rev-parse', `${head}^{tree}`], cwd).trim();
  const result = checkChanges(collectDiff(head, null, cwd), fixable, config);
  const changed = tree !== headTree;
  writeFileSync(
    join(inputDir, 'policy.json'),
    `${JSON.stringify({ ...result, tree, changed }, null, 2)}\n`,
  );
  setOutput('changed', String(changed));
  setOutput('policy_ok', String(result.violations.length === 0));
  setOutput('tree', tree);
  setOutput('files', JSON.stringify(result.files));
  const list = result.violations.map((v) => `- ${v}`).join('\n') || '- none';
  summary(
    `### Policy\n\n${result.files.length} file(s), ${result.lines} non-test line(s) changed.\n\nViolations:\n${list}\n`,
  );
  process.stdout.write(`collect: changed=${changed} violations=${result.violations.length}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`collect: ${error.message}\n`);
    process.exit(1);
  }
}
