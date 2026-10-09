import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHA, git } from './git.mjs';

const HEX64 = /^[0-9a-f]{64}$/;

function hashParts(parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    const text = String(part ?? '');
    hash.update(`${Buffer.byteLength(text, 'utf8')}:`).update(text, 'utf8');
  }
  return hash.digest('hex');
}

/**
 * Fingerprint of the author-controlled review input: the full diff from the merge base to the head
 * (byte for byte, with full blob ids, binary content, modes and renames), the PR title and
 * description, and the messages of the non-merge commits. Commit ids and merge commits are not part
 * of it.
 * @returns {string} sha256 hex
 */
export function changeFingerprint({ base, head, title, body, run = git }) {
  const diff = run([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--full-index',
    '--binary',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '-M',
    base,
    head,
  ]);
  const messages = run(['log', '--no-merges', '--format=%s%n%n%b%x00', `${base}..${head}`]);
  return hashParts(['diff', diff, 'title', title, 'body', body, 'commits', messages]);
}

/**
 * Identity of the reviewer: the trusted `.github/review` tree, the trusted workflow file, the model
 * and the blocking threshold.
 * @returns {string} sha256 hex
 */
export function reviewerId({ source, model, minConfidence, run = git }) {
  const object = (path) => {
    try {
      return run(['rev-parse', '--verify', '--quiet', `${source}:${path}`]);
    } catch {
      return '';
    }
  };
  const tree = object('.github/review');
  if (!SHA.test(tree)) throw new Error(`no reviewer tree on ${source}`);
  return hashParts([
    'tree',
    tree,
    'workflow',
    object('.github/workflows/review.yml'),
    'model',
    model,
    'min-confidence',
    minConfidence,
  ]);
}

/** @returns {boolean} the Claude run finished successfully */
export function isComplete(metrics) {
  return Boolean(metrics) && metrics.subtype === 'success' && metrics.is_error !== true;
}

/** @returns {string | null} why the current run cannot reuse any verdict, or null */
export function notEligible({ enabled, meta }) {
  if (!enabled) return 'reuse is disabled (REVIEW_REUSE_UNCHANGED=false)';
  if (meta.mode !== 'live') return 'eval mode always reviews';
  if (!meta.reviewer) return 'the reviewer is not loaded from the base revision (bootstrap)';
  if (!HEX64.test(meta.fingerprint ?? '')) return 'no fingerprint for this change';
  return null;
}

/**
 * Compares the current change with the latest marker the workflow's bot posted on the PR
 * (publish.previousRound).
 * @returns {{reuse: boolean, run?: number, head?: string, detail?: string}}
 */
export function reuseDecision({ enabled, meta, previous }) {
  const no = (detail) => ({ reuse: false, detail });
  const blocked = notEligible({ enabled, meta });
  if (blocked) return no(blocked);
  if (!previous) return no('no earlier review on this pull request');
  if (previous.v !== 2) return no('the earlier review has no fingerprint');
  if (!SHA.test(previous.head ?? '')) return no('the earlier review has no valid head');
  if (previous.head === meta.head_sha) return no('the earlier review is for the same head');
  if (previous.complete !== true) return no('the earlier review did not complete');
  if (!Number.isSafeInteger(previous.run) || previous.run <= 0)
    return no('the earlier review has no run id');
  if (!Number.isInteger(previous.blocking) || previous.blocking < 0)
    return no('the earlier review has no verdict');
  if (previous.reviewer !== meta.reviewer)
    return no('the reviewer changed since the earlier review');
  if (previous.fingerprint !== meta.fingerprint)
    return no('the change differs from the earlier review');
  return { reuse: true, run: previous.run, head: previous.head };
}

function checkEarlierMeta(prev, meta, from) {
  if (prev.mode !== 'live') throw new Error('the earlier document is not a live review');
  if (String(prev.pr) !== String(meta.pr))
    throw new Error('the earlier document is for another PR');
  if (prev.head_sha !== from.head) throw new Error('the earlier document is for another head');
  if (prev.fingerprint !== meta.fingerprint) throw new Error('the earlier fingerprint differs');
  if (prev.reviewer !== meta.reviewer) throw new Error('the earlier reviewer differs');
}

/**
 * Checks the findings document of the earlier run against the marker and the current change.
 * @returns {object} the findings document for the current head with the earlier verdict
 * @throws when the earlier document does not match
 */
export function carryOver({ meta, previousDoc, from }) {
  const prev = previousDoc?.meta ?? {};
  checkEarlierMeta(prev, meta, from);
  if (previousDoc.complete !== true) throw new Error('the earlier review did not complete');
  const review = previousDoc.review;
  if (!Array.isArray(review?.findings) || !Array.isArray(review?.scope_findings))
    throw new Error('the earlier document has no findings');
  const blocking =
    review.findings.filter((f) => f.severity === 'blocking').length +
    review.scope_findings.filter((s) => s.severity === 'blocking').length;
  if (blocking !== previousDoc.blocking)
    throw new Error('the earlier blocking count does not match its findings');
  const reviewed = prev.carried_from?.reviewed_head ?? prev.head_sha;
  return {
    meta: {
      ...meta,
      carried_from: { head: from.head, reviewed_head: reviewed, run: from.run },
    },
    metrics: null,
    blocking,
    complete: true,
    review,
  };
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** Workflow step: sets the output `carry` to true when the downloaded earlier result is usable. */
function main() {
  const inputDir = process.env.INPUT_DIR;
  const previousDir = process.env.PREVIOUS_DIR;
  if (!inputDir || !previousDir) throw new Error('INPUT_DIR and PREVIOUS_DIR are required');
  const meta = JSON.parse(readFileSync(join(inputDir, 'meta.json'), 'utf8'));
  const from = meta.reuse_candidate;
  const file = join(previousDir, 'findings.json');
  try {
    if (!from) throw new Error('prepare found no earlier verdict to reuse');
    if (!existsSync(file)) throw new Error('the result of the earlier run could not be downloaded');
    carryOver({ meta, previousDoc: JSON.parse(readFileSync(file, 'utf8')), from });
    setOutput('carry', 'true');
    process.stdout.write(`Change unchanged since ${from.head}; carrying over its verdict.\n`);
  } catch (error) {
    setOutput('carry', 'false');
    process.stdout.write(`::notice::Reviewing anyway: ${error.message}.\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`reuse: ${error.message}\n`);
    process.exit(1);
  }
}
