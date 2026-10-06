export const MARKER_PREFIX = '<!-- conclavix-review:';
const MARKER_SUFFIX = ' -->';
const MAX_BODY = 60000;
const MAX_SUGGESTION = 4000;

/** Neutralises mentions and HTML comments in model output before it is posted. */
export function sanitize(text, max = 4000) {
  const clean = String(text ?? '')
    .replace(/<!--/g, '&lt;!--')
    .replace(/@(?=[A-Za-z0-9])/g, '&#64;');
  return clean.length > max ? `${clean.slice(0, max)} [truncated]` : clean;
}

const STOP_WORDS = new Set(
  'a an the and or of to in on for is are be can when if it its this that with without from by not as at'.split(
    ' ',
  ),
);

export function tokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
  );
}

/** Jaccard similarity of the word sets of two texts, 0..1. */
export function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

function label(finding) {
  return `${finding.severity === 'blocking' ? 'Blocking' : 'Non-blocking'} ${finding.rule}`;
}

function evidenceLines(finding) {
  return (finding.evidence ?? []).map(
    (e) => `- \`${sanitize(e.file, 300)}:${e.line}\` ${sanitize(e.note, 500)}`,
  );
}

export function suggestionApplies(finding, anchor) {
  if (!finding.suggestion || anchor.kind !== 'exact') return false;
  if (anchor.start_line !== undefined) return true;
  return !finding.end_line || finding.end_line === finding.line;
}

/**
 * A suggestion is code that GitHub applies verbatim, so it is not entity-escaped like prose. It is
 * dropped when it contains an HTML comment (which could forge a review marker) or is longer than
 * MAX_SUGGESTION, and fenced with a fence longer than any backtick run inside it, so it cannot close the block and turn its text
 * (including mentions) into rendered markdown.
 */
export function suggestionBlock(suggestion) {
  const code = String(suggestion).replace(/\n$/, '');
  if (code.includes('<!--')) return ['', '_Suggestion omitted: it contains an HTML comment._'];
  if (code.length > MAX_SUGGESTION) return ['', '_Suggestion omitted: it is too long._'];
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return ['', `${fence}suggestion`, code, fence];
}

/** Markdown body of one inline review comment. */
export function renderComment(finding, anchor) {
  const parts = [`**[${label(finding)}] ${sanitize(finding.title, 300)}**`, ''];
  if (anchor.kind === 'nearest') {
    parts.push(`Real location: \`${sanitize(finding.file, 300)}:${finding.line}\``, '');
  }
  parts.push(sanitize(finding.rationale));
  const evidence = evidenceLines(finding);
  if (evidence.length > 0) parts.push('', 'Evidence:', ...evidence);
  if (suggestionApplies(finding, anchor)) parts.push(...suggestionBlock(finding.suggestion));
  parts.push('', `<sub>${finding.category}, confidence ${finding.confidence.toFixed(2)}</sub>`);
  return parts.join('\n');
}

export function encodeMarker(payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `${MARKER_PREFIX}${data}${MARKER_SUFFIX}`;
}

export function decodeMarker(body) {
  const start = String(body ?? '').lastIndexOf(MARKER_PREFIX);
  if (start < 0) return null;
  const rest = body.slice(start + MARKER_PREFIX.length);
  const end = rest.indexOf(MARKER_SUFFIX);
  if (end < 0) return null;
  try {
    return JSON.parse(Buffer.from(rest.slice(0, end), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Previous-round findings that no current finding matches. A finding is considered still present
 * when a current finding is in the same file and either within 10 lines or has a title similarity
 * of at least 0.5.
 */
export function resolvedSince(previous, current) {
  return previous.filter(
    (p) =>
      !current.some(
        (c) =>
          c.file === p.file &&
          (Math.abs(c.line - p.line) <= 10 || similarity(c.title, p.title) >= 0.5),
      ),
  );
}

function findingRow(f) {
  const where = `\`${sanitize(f.file, 300)}:${f.line}\``;
  const placement = f.anchor.kind === 'summary' ? ' (outside the diff)' : '';
  return `- **${label(f)}** ${where}${placement}: ${sanitize(f.title, 300)}`;
}

function outsideDiffDetails(findings) {
  const outside = findings.filter((f) => f.anchor.kind === 'summary');
  if (outside.length === 0) return [];
  const blocks = outside.map(
    (f) => `#### ${findingRow(f).slice(2)}\n\n${renderComment(f, f.anchor)}`,
  );
  return ['', '### Findings outside the diff', '', ...blocks];
}

/** Review body: verdict, counts, lists, scope, resolved items and run metrics. */
export function renderSummary({ review, findings, blocking, meta, metrics, resolved = [] }) {
  const nonBlocking = findings.length - findings.filter((f) => f.severity === 'blocking').length;
  const scopeBlocking = review.scope_findings.filter((s) => s.severity === 'blocking').length;
  const lines = [
    `## Review: ${blocking > 0 ? 'changes required' : 'no blocking findings'}`,
    '',
    `Head \`${meta.head_sha.slice(0, 7)}\`, diff against merge base \`${meta.merge_base.slice(0, 7)}\`.`,
    `Blocking: **${blocking}** (incl. ${scopeBlocking} scope), non-blocking: ${nonBlocking}, scope notes: ${review.scope_findings.length}.`,
    '',
    sanitize(review.summary, 3000),
  ];
  const blockingList = findings.filter((f) => f.severity === 'blocking');
  if (blockingList.length > 0) lines.push('', '### Blocking', '', ...blockingList.map(findingRow));
  const other = findings.filter((f) => f.severity !== 'blocking');
  if (other.length > 0) lines.push('', '### Non-blocking', '', ...other.map(findingRow));
  if (review.scope_findings.length > 0) {
    lines.push('', '### Scope', '');
    for (const s of review.scope_findings) {
      const file = s.file ? ` \`${sanitize(s.file, 300)}\`` : '';
      lines.push(
        `- **${s.severity}** ${s.kind.replace('_', ' ')}${file}: ${sanitize(s.description, 1000)}`,
      );
    }
  }
  if (resolved.length > 0) {
    lines.push('', '### Resolved since the previous review', '');
    for (const r of resolved)
      lines.push(`- ~~\`${sanitize(r.file, 300)}:${r.line}\` ${sanitize(r.title, 300)}~~`);
  }
  lines.push(...outsideDiffDetails(findings));
  if (metrics) lines.push('', `<sub>${metricsLine(metrics)}</sub>`);
  const body = lines.join('\n');
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n[truncated]` : body;
}

export function metricsLine(m) {
  const cost = typeof m.total_cost_usd === 'number' ? `$${m.total_cost_usd.toFixed(2)}` : 'n/a';
  const minutes = typeof m.duration_ms === 'number' ? (m.duration_ms / 60000).toFixed(1) : 'n/a';
  return `Model ${m.model ?? 'n/a'}, ${minutes} min, ${m.num_turns ?? 'n/a'} turns, cost ${cost}, tokens in ${m.input_tokens ?? 0} / cache read ${m.cache_read_input_tokens ?? 0} / cache write ${m.cache_creation_input_tokens ?? 0} / out ${m.output_tokens ?? 0}.`;
}
