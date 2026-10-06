import { redactPatterns } from './redact-patterns.js';

/** A secret value the runner knows, with the name shown in its placeholder. */
export interface KnownSecret {
  name: string;
  value: string;
}

/** Values shorter than this are not matched literally, so short strings do not mangle the log. */
export const MIN_SECRET_LENGTH = 8;

export const REDACTION_FAILED = '[redacted: event withheld because redaction failed]';

/** The recorder caps event text at this length and appends '...'. */
export const RECORDER_TEXT_CAP = 4000;

const CAP_TEXT_MARKER = /\n\[truncated \d+ chars\]$/;

/**
 * The truncation marker a string ends with, if it was cut: capText's explicit marker, or the
 * recorder's '...' on a string of exactly the capped length. Plain '...' in prose is not a cut.
 */
function cutMarker(value: string): string {
  const explicit = CAP_TEXT_MARKER.exec(value)?.[0];
  if (explicit) {
    return explicit;
  }
  return value.length === RECORDER_TEXT_CAP + 3 && value.endsWith('...') ? '...' : '';
}

/** Mark edges that a caller knows were cut; truncation markers are also detected on their own. */
export interface TextBoundaries {
  start?: boolean;
  end?: boolean;
}

interface Needle {
  value: string;
  label: string;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Base64 fragments that appear whatever the byte offset of the value inside a larger blob. */
function base64Variants(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const variants: string[] = [];
  for (let shift = 0; shift < 3; shift += 1) {
    const padded = Buffer.concat([Buffer.alloc(shift), bytes]);
    const start = Math.ceil((8 * shift) / 6);
    const end = Math.floor((8 * padded.length) / 6);
    for (const encoding of ['base64', 'base64url'] as const) {
      variants.push(padded.toString(encoding).slice(start, end));
    }
  }
  return variants;
}

/** The value as it appears inside a JSON string, e.g. tool input stored via JSON.stringify. */
const jsonEscaped = (value: string): string => JSON.stringify(value).slice(1, -1);

/** Forms in which a cut value can show up at a truncation edge: raw and JSON-escaped. */
const edgeForms = (value: string): string[] => [...new Set([value, jsonEscaped(value)])];

function encodedVariants(value: string): string[] {
  const variants = [value, jsonEscaped(value), encodeURIComponent(value), ...base64Variants(value)];
  return variants.filter((variant) => variant.length >= MIN_SECRET_LENGTH);
}

/** Length of the longest piece of `secret` that `body` ends with (prefix) or starts with (suffix). */
function edgeOverlap(body: string, secret: string, atEnd: boolean): number {
  const max = Math.min(secret.length - 1, body.length);
  for (let length = max; length >= MIN_SECRET_LENGTH; length -= 1) {
    const hit = atEnd
      ? body.endsWith(secret.slice(0, length))
      : body.startsWith(secret.slice(secret.length - length));
    if (hit) {
      return length;
    }
  }
  return 0;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * Removes secrets from run log content: known values (also URL- and base64-encoded, also when a
 * truncation cut them in half) and common credential formats. Pure and safe to apply repeatedly.
 */
export class Redactor {
  private readonly needles: Needle[];
  private readonly raw: Needle[];
  private readonly edges: Needle[];
  private readonly matcher: RegExp | null;
  private readonly labels: Map<string, string>;

  constructor(secrets: readonly KnownSecret[] = []) {
    const usable = secrets.filter((secret) => secret.value.length >= MIN_SECRET_LENGTH);
    this.raw = usable.map((secret) => ({ value: secret.value, label: secret.name }));
    this.edges = this.raw.flatMap((needle) =>
      edgeForms(needle.value).map((value) => ({ value, label: needle.label })),
    );
    const seen = new Map<string, string>();
    for (const secret of usable) {
      for (const variant of encodedVariants(secret.value)) {
        if (!seen.has(variant)) {
          seen.set(variant, secret.name);
        }
      }
    }
    this.labels = seen;
    this.needles = [...seen].map(([value, label]) => ({ value, label }));
    this.needles.sort((a, b) => b.value.length - a.value.length);
    this.matcher =
      this.needles.length > 0
        ? new RegExp(this.needles.map((needle) => escapeRegExp(needle.value)).join('|'), 'g')
        : null;
  }

  /** A redactor that also knows `secrets`. */
  with(secrets: readonly KnownSecret[]): Redactor {
    return new Redactor([
      ...this.raw.map((needle) => ({ name: needle.label, value: needle.value })),
      ...secrets,
    ]);
  }

  /** Redact one string. Throws only on internal failure; callers must fail closed. */
  text(value: string, boundaries: TextBoundaries = {}): string {
    let result = value;
    if (this.matcher) {
      const marker = cutMarker(value);
      result = result.replace(
        this.matcher,
        (match) => `[redacted:${this.labels.get(match) ?? 'secret'}]`,
      );
      const body = result.slice(0, result.length - marker.length);
      const edges = { ...boundaries, end: boundaries.end === true || marker !== '' };
      result = `${this.redactEdges(body, edges)}${marker}`;
    }
    return redactPatterns(result);
  }

  /** Redact every string inside arrays and plain objects; other values are returned unchanged. */
  deep<T>(value: T): T {
    return this.walk(value, 0) as T;
  }

  private walk(value: unknown, depth: number): unknown {
    if (depth > 64) {
      throw new Error('value nested too deeply to redact');
    }
    if (typeof value === 'string') {
      return this.text(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.walk(item, depth + 1));
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.walk(item, depth + 1)]),
      );
    }
    return value;
  }

  private redactEdges(value: string, boundaries: TextBoundaries): string {
    let body = value;
    for (const needle of this.edges) {
      const tail = boundaries.end ? edgeOverlap(body, needle.value, true) : 0;
      if (tail > 0) {
        body = `${body.slice(0, body.length - tail)}[redacted:${needle.label}]`;
      }
      const head = boundaries.start ? edgeOverlap(body, needle.value, false) : 0;
      if (head > 0) {
        body = `[redacted:${needle.label}]${body.slice(head)}`;
      }
    }
    return body;
  }
}

/** Redact `value`, or return a placeholder if redaction fails, so raw content is never kept. */
export function redactOrWithhold(
  redactor: Redactor,
  value: string,
  onError: (error: unknown) => void,
): string {
  try {
    return redactor.text(value);
  } catch (error) {
    onError(error);
    return REDACTION_FAILED;
  }
}

/** Error details safe to log: never the message, which may quote the content. */
export const errorKind = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error;
