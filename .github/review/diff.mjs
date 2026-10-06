const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function unquotePath(raw) {
  const path = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return path.startsWith('b/') ? path.slice(2) : path;
}

function newFileEntry() {
  return { commentable: new Set(), added: new Set(), hunks: [] };
}

/**
 * Indexes a unified diff by head-side path: which head lines can carry a review comment
 * (added and context lines) and which hunk each line belongs to.
 */
export function parseDiff(text) {
  const files = new Map();
  let current = null;
  let hunk = null;
  let line = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = null;
      hunk = null;
      continue;
    }
    if (hunk === null && raw.startsWith('+++ ')) {
      const target = raw.slice(4);
      current = target === '/dev/null' ? null : newFileEntry();
      if (current) files.set(unquotePath(target), current);
      hunk = null;
      continue;
    }
    const header = HUNK_HEADER.exec(raw);
    if (header && current) {
      line = Number(header[1]);
      hunk = { start: line, end: line - 1 };
      current.hunks.push(hunk);
      continue;
    }
    if (!current || !hunk) continue;
    const marker = raw[0];
    if (marker === '+' || marker === ' ') {
      current.commentable.add(line);
      if (marker === '+') current.added.add(line);
      hunk.end = line;
      line += 1;
    }
  }
  return files;
}

function hunkOf(entry, line) {
  return entry.hunks.find((h) => line >= h.start && line <= h.end) ?? null;
}

function nearestCommentable(entry, line) {
  let best = null;
  for (const candidate of entry.commentable) {
    const distance = Math.abs(candidate - line);
    if (
      best === null ||
      distance < best.distance ||
      (distance === best.distance && candidate < best.line)
    ) {
      best = { line: candidate, distance };
    }
  }
  return best?.line ?? null;
}

/**
 * Decides where a finding can be shown: on its own lines ("exact"), on the nearest changed line of
 * the same file ("nearest"), or only in the review body ("summary").
 */
export function anchorFinding(finding, diffIndex) {
  const entry = diffIndex.get(finding.file);
  if (!entry || entry.commentable.size === 0) return { kind: 'summary' };
  if (entry.commentable.has(finding.line)) {
    const hunk = hunkOf(entry, finding.line);
    const end = finding.end_line;
    const rangeOk = Number.isInteger(end) && end > finding.line && hunk !== null && end <= hunk.end;
    return rangeOk
      ? { kind: 'exact', start_line: finding.line, line: end }
      : { kind: 'exact', line: finding.line };
  }
  const nearest = nearestCommentable(entry, finding.line);
  return nearest === null ? { kind: 'summary' } : { kind: 'nearest', line: nearest };
}
