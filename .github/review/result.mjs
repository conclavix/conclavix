import { anchorFinding } from './diff.mjs';

const SEVERITIES = new Set(['blocking', 'non-blocking']);

function metricsOf(result, init) {
  const usage = result.usage ?? {};
  const pick = (value) => value ?? null;
  return {
    model: init?.model ?? Object.keys(result.modelUsage ?? {})[0] ?? null,
    subtype: pick(result.subtype),
    is_error: pick(result.is_error),
    duration_ms: pick(result.duration_ms),
    duration_api_ms: pick(result.duration_api_ms),
    num_turns: pick(result.num_turns),
    total_cost_usd: pick(result.total_cost_usd),
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    permission_denials: Array.isArray(result.permission_denials)
      ? result.permission_denials.length
      : 0,
  };
}

/** Picks the final result message out of claude-code-action's execution file. */
export function extractResult(messages) {
  if (!Array.isArray(messages)) return { structured: null, metrics: null };
  const result = [...messages].reverse().find((m) => m && m.type === 'result');
  if (!result) return { structured: null, metrics: null };
  const init = messages.find((m) => m && m.type === 'system' && m.subtype === 'init');
  return { structured: result.structured_output ?? null, metrics: metricsOf(result, init) };
}

function validFinding(f) {
  return (
    f &&
    typeof f.file === 'string' &&
    f.file.length > 0 &&
    Number.isInteger(f.line) &&
    f.line > 0 &&
    SEVERITIES.has(f.severity) &&
    typeof f.title === 'string' &&
    typeof f.rationale === 'string' &&
    typeof f.confidence === 'number'
  );
}

/** Throws when the structured output does not have the shape the schema promises. */
export function validateReview(review) {
  if (!review || typeof review !== 'object') throw new Error('structured output is missing');
  if (!Array.isArray(review.findings)) throw new Error('structured output has no findings array');
  if (!Array.isArray(review.scope_findings))
    throw new Error('structured output has no scope_findings');
  if (typeof review.summary !== 'string') throw new Error('structured output has no summary');
  const bad = review.findings.filter((f) => !validFinding(f));
  if (bad.length > 0) throw new Error(`${bad.length} finding(s) do not match the schema`);
  return review;
}

/**
 * Normalises findings: strips a leading "./", downgrades blocking findings below the confidence
 * threshold, and attaches the anchor in the diff.
 */
export function prepareFindings(review, diffIndex, minBlockingConfidence) {
  return review.findings.map((raw) => {
    const f = { ...raw, file: raw.file.replace(/^\.\//, ''), evidence: raw.evidence ?? [] };
    if (f.severity === 'blocking' && f.confidence < minBlockingConfidence) {
      f.severity = 'non-blocking';
      f.downgraded = true;
      f.rationale = `${f.rationale}\n\n(Reported as blocking with confidence ${f.confidence.toFixed(2)}, below the threshold ${minBlockingConfidence}; shown as non-blocking.)`;
    }
    return { ...f, anchor: anchorFinding(f, diffIndex) };
  });
}

export function countBlocking(findings, review) {
  return (
    findings.filter((f) => f.severity === 'blocking').length +
    review.scope_findings.filter((s) => s.severity === 'blocking').length
  );
}
