import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiff } from './diff.mjs';
import { metricsLine, renderCarried, renderComment, renderSummary } from './render.mjs';
import { countBlocking, extractResult, prepareFindings, validateReview } from './result.mjs';
import { carryOver, isComplete } from './reuse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function readJson(path, fallback) {
  if (!path || !existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function stepSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function copyTool(resultDir) {
  const toolDir = join(resultDir, 'tool');
  mkdirSync(toolDir, { recursive: true });
  for (const name of readdirSync(HERE)) {
    if (name.endsWith('.mjs')) copyFileSync(join(HERE, name), join(toolDir, name));
  }
}

/** Builds the review payload (body and inline comments) and the stored findings document. */
export function finalize({ meta, structured, metrics, diffText, minBlockingConfidence }) {
  const review = validateReview(structured);
  const findings = prepareFindings(review, parseDiff(diffText), minBlockingConfidence);
  const blocking = countBlocking(findings, review);
  const comments = findings
    .filter((f) => f.anchor.kind !== 'summary')
    .map((f) => ({
      path: f.file,
      line: f.anchor.line,
      ...(f.anchor.start_line === undefined
        ? {}
        : { start_line: f.anchor.start_line, start_side: 'RIGHT' }),
      side: 'RIGHT',
      body: renderComment(f, f.anchor),
    }));
  const body = renderSummary({ review, findings, blocking, meta, metrics });
  return {
    document: {
      meta,
      metrics,
      blocking,
      complete: isComplete(metrics),
      review: { ...review, findings },
    },
    payload: { commit_id: meta.head_sha, body, comments },
  };
}

/** Builds the document and a comment-free payload from the verdict of an earlier run. */
export function finalizeCarried({ meta, previousDoc }) {
  const document = carryOver({ meta, previousDoc, from: meta.reuse_candidate });
  const body = renderCarried(document);
  return { document, payload: { commit_id: meta.head_sha, body, comments: [] } };
}

function writeResult(resultDir, document, payload) {
  writeJson(join(resultDir, 'findings.json'), document);
  writeJson(join(resultDir, 'review-payload.json'), payload);
  writeFileSync(join(resultDir, 'summary.md'), `${payload.body}\n`);
  stepSummary(payload.body);
  setOutput('blocking', String(document.blocking));
}

function main() {
  const inputDir = process.env.INPUT_DIR;
  const resultDir = process.env.RESULT_DIR;
  if (!inputDir || !resultDir) throw new Error('INPUT_DIR and RESULT_DIR are required');
  mkdirSync(resultDir, { recursive: true });
  copyTool(resultDir);
  const meta = readJson(join(inputDir, 'meta.json'), null);
  if (!meta) throw new Error('meta.json is missing, prepare did not run');
  writeJson(join(resultDir, 'meta.json'), meta);
  copyFileSync(join(inputDir, 'diff.patch'), join(resultDir, 'diff.patch'));

  if (process.env.CARRY === 'true') {
    const previousDoc = readJson(join(process.env.PREVIOUS_DIR ?? '', 'findings.json'), null);
    const { document, payload } = finalizeCarried({ meta, previousDoc });
    stepSummary(`## Review of PR #${meta.pr} (verdict carried over)\n`);
    writeResult(resultDir, document, payload);
    process.stdout.write(
      `PR #${meta.pr}: verdict of ${document.meta.carried_from.head} carried over, ${document.blocking} blocking\n`,
    );
    return;
  }

  const executionFile =
    process.env.EXECUTION_FILE ||
    join(process.env.RUNNER_TEMP ?? '', 'claude-execution-output.json');
  const { structured, metrics } = extractResult(readJson(executionFile, []));
  writeJson(join(resultDir, 'metrics.json'), { ...meta, ...metrics });
  stepSummary(`## Review of PR #${meta.pr} (${meta.mode})\n`);
  stepSummary(metrics ? `${metricsLine(metrics)}\n` : 'No result message from Claude.\n');
  if (!structured)
    throw new Error(`Claude returned no structured output (${metrics?.subtype ?? 'no result'})`);

  const { document, payload } = finalize({
    meta,
    structured,
    metrics,
    diffText: readFileSync(join(inputDir, 'diff.patch'), 'utf8'),
    minBlockingConfidence: Number(process.env.MIN_BLOCKING_CONFIDENCE || '0.6'),
  });
  writeResult(resultDir, document, payload);
  process.stdout.write(
    `PR #${meta.pr}: ${document.review.findings.length} finding(s), ${document.blocking} blocking, ${payload.comments.length} inline\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`finalize: ${error.message}\n`);
    process.exit(1);
  }
}
