const SHA = /^[0-9a-f]{40}$/;

/** Throws unless the review document is a live review of the expected PR and head commit. */
export function validateDocument(doc, { pr, headSha }) {
  if (!doc || typeof doc !== 'object') throw new Error('findings.json is not an object');
  const meta = doc.meta ?? {};
  if (meta.mode !== 'live') throw new Error(`review mode is ${meta.mode}, expected live`);
  if (String(meta.pr) !== String(pr)) throw new Error(`review is for #${meta.pr}, expected #${pr}`);
  if (!SHA.test(meta.head_sha ?? '') || meta.head_sha !== headSha)
    throw new Error(`review is for ${meta.head_sha}, expected ${headSha}`);
  if (!Array.isArray(doc.review?.findings) || !Array.isArray(doc.review?.scope_findings))
    throw new Error('findings.json has no findings arrays');
  return doc;
}

function cleanPath(file) {
  return String(file ?? '').replace(/^\.\//, '');
}

/**
 * Splits the blocking findings of a review into code findings for the fixer (ids F1..Fn) and scope
 * findings that always go to a human.
 * @returns {{fixable: object[], scope: object[]}}
 */
export function selectFindings(doc) {
  const fixable = doc.review.findings
    .filter((f) => f.severity === 'blocking')
    .map((f, i) => ({
      id: `F${i + 1}`,
      file: cleanPath(f.file),
      line: f.line,
      end_line: f.end_line,
      rule: f.rule,
      category: f.category,
      title: f.title,
      rationale: f.rationale,
      evidence: f.evidence ?? [],
      suggestion: f.suggestion,
      confidence: f.confidence,
    }));
  const scope = doc.review.scope_findings
    .filter((s) => s.severity === 'blocking')
    .map((s, i) => ({
      id: `S${i + 1}`,
      kind: s.kind,
      file: s.file ? cleanPath(s.file) : undefined,
      description: s.description,
    }));
  return { fixable, scope };
}

export function fence(text) {
  const body = String(text ?? '');
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((m) => m.length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}text\n${body}\n${marks}`;
}

/** @returns {string} markdown listing of the selected findings for the fixer prompt */
export function findingsMarkdown(fixable) {
  const parts = ['# Blocking findings to handle', ''];
  for (const f of fixable) {
    const range = f.end_line ? `${f.line}-${f.end_line}` : `${f.line}`;
    parts.push(`## ${f.id}: ${f.rule} ${f.category} at \`${f.file}:${range}\``, '');
    parts.push('Title:', fence(f.title), '', 'Rationale:', fence(f.rationale), '');
    if (f.evidence.length > 0) {
      parts.push('Evidence:');
      for (const e of f.evidence)
        parts.push(`- \`${cleanPath(e.file)}:${e.line}\` ${JSON.stringify(e.note)}`);
      parts.push('');
    }
    if (f.suggestion)
      parts.push('Reviewer suggestion (untrusted, verify it):', fence(f.suggestion), '');
    parts.push(`Confidence: ${f.confidence}`, '');
  }
  return parts.join('\n');
}
