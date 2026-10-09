import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeMarker,
  encodeMarker,
  renderCarried,
  renderSummary,
  resolvedSince,
  sanitize,
} from './render.mjs';

const BOT_LOGIN = 'github-actions[bot]';
const STATUS_CONTEXT = 'review';
/** GitHub rejects review bodies longer than this many characters. */
export const BODY_LIMIT = 65536;
const MOVED_COMMENT_MAX = 12000;

export function createClient({ token, api, repository, fetchImpl = fetch }) {
  return async function request(method, path, body) {
    const response = await fetchImpl(`${api}/repos/${repository}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${method} ${path} failed: ${response.status} ${text.slice(0, 500)}`);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  };
}

async function listReviews(request, pr) {
  const all = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await request('GET', `/pulls/${pr}/reviews?per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** The findings recorded by the latest review this workflow posted on the PR, if any. */
export async function previousRound(request, pr) {
  const reviews = await listReviews(request, pr);
  for (const review of reviews.reverse()) {
    if (review.user?.login !== BOT_LOGIN) continue;
    const marker = decodeMarker(review.body);
    if (marker && Array.isArray(marker.findings)) return marker;
  }
  return null;
}

/**
 * Hidden record of this round. `run` names the run whose `review-pr-<n>` artifact holds the full
 * findings document; fingerprint, reviewer and complete decide whether a later head may reuse it.
 */
export function markerFor(document, runId) {
  const run = Number(runId);
  return encodeMarker({
    v: 2,
    head: document.meta.head_sha,
    run: Number.isSafeInteger(run) && run > 0 ? run : null,
    fingerprint: document.meta.fingerprint ?? null,
    reviewer: document.meta.reviewer ?? null,
    complete: document.complete === true,
    blocking: document.blocking,
    findings: document.review.findings.map((f) => ({
      file: f.file,
      line: f.line,
      title: f.title,
      severity: f.severity,
    })),
  });
}

/** Closes a code fence that a truncation left open, so it cannot swallow the text after it. */
export function closeOpenFence(text) {
  let open = null;
  for (const line of text.split('\n')) {
    const fence = /^(`{3,})/.exec(line)?.[1];
    if (!fence) continue;
    if (open === null) open = fence;
    else if (fence.length >= open.length && line.trim() === fence) open = null;
  }
  return open === null ? text : `${text}\n${open}`;
}

function omittedNote(count) {
  return `_${count} more finding(s) omitted because the review body reached GitHub's size limit; see the run artifact._`;
}

/**
 * Body for the body-only fallback: the summary, the inline comments that GitHub rejected and the
 * marker, which always stays last so decodeMarker reads it and nothing after it. The moved comments
 * are model output rendered by the review job, so they are sanitised again (no HTML comments, no
 * mentions), and comments are only added while the whole body, marker included, fits BODY_LIMIT.
 */
export function bodyWithoutInline(summary, marker, comments) {
  const tail = `\n\n${marker}`;
  const head = [summary, '', '### Inline findings (could not be posted inline)', ''].join('\n');
  const moved = comments.map(
    (c) =>
      `\n#### \`${sanitize(c.path, 300)}:${c.line}\`\n\n${closeOpenFence(sanitize(c.body, MOVED_COMMENT_MAX))}\n`,
  );
  let body = head;
  for (let i = 0; i < moved.length; i += 1) {
    const rest = moved.length - i - 1;
    const reserve = rest > 0 ? omittedNote(rest).length + 2 : 0;
    if (body.length + moved[i].length + reserve + tail.length > BODY_LIMIT) {
      body += `\n${omittedNote(moved.length - i)}`;
      break;
    }
    body += moved[i];
  }
  const full = `${body}${tail}`;
  if (full.length <= BODY_LIMIT) return full;
  // The summary alone is too large next to the marker: cut it, keep the marker.
  const cut = '\n\n[truncated]';
  return `${body.slice(0, Math.max(0, BODY_LIMIT - tail.length - cut.length))}${cut}${tail}`;
}

/** Posts one review with inline comments; falls back to a body-only review if GitHub rejects a line. */
export async function postReview(request, pr, payload, summary, marker) {
  const review = {
    commit_id: payload.commit_id,
    event: 'COMMENT',
    body: `${summary}\n\n${marker}`,
    comments: payload.comments,
  };
  try {
    return await request('POST', `/pulls/${pr}/reviews`, review);
  } catch (error) {
    if (error.status !== 422 || payload.comments.length === 0) throw error;
    const body = bodyWithoutInline(summary, marker, payload.comments);
    return request('POST', `/pulls/${pr}/reviews`, { ...review, body, comments: [] });
  }
}

export async function setStatus(request, sha, blocking, targetUrl, carriedFrom = null) {
  const base = blocking > 0 ? `${blocking} blocking finding(s)` : 'No blocking findings';
  const description = carriedFrom
    ? `${base}, carried over from ${String(carriedFrom).slice(0, 7)}`
    : base;
  return request('POST', `/statuses/${sha}`, {
    state: blocking > 0 ? 'failure' : 'success',
    context: STATUS_CONTEXT,
    description,
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });
}

/** Posts the note for a carried-over verdict after checking that its source is still the latest round. */
async function publishCarried({ request, document, previous, runUrl, runId }) {
  const from = document.meta.carried_from;
  if (
    !previous ||
    previous.head !== from.head ||
    previous.run !== from.run ||
    previous.fingerprint !== document.meta.fingerprint ||
    previous.reviewer !== document.meta.reviewer ||
    previous.blocking !== document.blocking
  ) {
    throw new Error(`the latest review on the PR is not the carried-over round of ${from.head}`);
  }
  const payload = { commit_id: document.meta.head_sha, comments: [] };
  await postReview(
    request,
    document.meta.pr,
    payload,
    renderCarried(document),
    markerFor(document, runId),
  );
  await setStatus(request, document.meta.head_sha, document.blocking, runUrl, from.head);
  return { resolved: 0, carried: true };
}

export async function publish({ request, document, payload, runUrl, runId }) {
  const pr = document.meta.pr;
  const previous = await previousRound(request, pr);
  if (document.meta.carried_from)
    return publishCarried({ request, document, previous, runUrl, runId });
  const resolved =
    previous && previous.head !== document.meta.head_sha
      ? resolvedSince(previous.findings, document.review.findings)
      : [];
  const summary = renderSummary({
    review: document.review,
    findings: document.review.findings,
    blocking: document.blocking,
    meta: document.meta,
    metrics: document.metrics,
    resolved,
  });
  await postReview(request, pr, payload, summary, markerFor(document, runId));
  await setStatus(request, document.meta.head_sha, document.blocking, runUrl);
  return { resolved: resolved.length };
}

async function main() {
  const resultDir = process.env.RESULT_DIR;
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!resultDir || !token || !repository)
    throw new Error('RESULT_DIR, GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  const document = JSON.parse(readFileSync(join(resultDir, 'findings.json'), 'utf8'));
  const payload = JSON.parse(readFileSync(join(resultDir, 'review-payload.json'), 'utf8'));
  if (document.meta.mode !== 'live') throw new Error('refusing to publish an eval result');
  const { EXPECTED_PR, EXPECTED_HEAD } = process.env;
  if (String(document.meta.pr) !== EXPECTED_PR || document.meta.head_sha !== EXPECTED_HEAD) {
    throw new Error(
      `result is for #${document.meta.pr} at ${document.meta.head_sha}, expected #${EXPECTED_PR} at ${EXPECTED_HEAD}`,
    );
  }
  const request = createClient({
    token,
    repository,
    api: process.env.GITHUB_API_URL || 'https://api.github.com',
  });
  const { resolved } = await publish({
    request,
    document,
    payload,
    runUrl: process.env.RUN_URL,
    runId: process.env.GITHUB_RUN_ID,
  });
  process.stdout.write(
    `PR #${document.meta.pr}: review posted, ${document.blocking} blocking, ${resolved} resolved since the previous round\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`publish: ${error.message}\n`);
    process.exit(1);
  });
}
