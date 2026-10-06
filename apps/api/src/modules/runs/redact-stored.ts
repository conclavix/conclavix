import { isDeepStrictEqual } from 'node:util';
import type { Collection, Document, ObjectId } from 'mongodb';
import type { Collections } from '../../db.js';
import { REDACTION_FAILED, errorKind, type Redactor } from '../../runner/redact.js';

const SAFE_CODE = /^[A-Za-z0-9_]{1,40}$/;

/** A driver error code, kept only when it cannot carry document content. */
function errorCode(error: unknown): string | number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : undefined;
}

/**
 * The rescan failed. Carries only the error kind and code: MongoDB errors can quote documents,
 * filters and write operations in their message and properties, so the original is dropped.
 */
export class StoredRedactionError extends Error {
  readonly kind: string;
  readonly code: string | number | undefined;

  constructor(cause: unknown) {
    const kind = errorKind(cause);
    const code = errorCode(cause);
    super(`stored run log rescan failed: ${kind}${code === undefined ? '' : ` (code ${code})`}`);
    this.name = 'StoredRedactionError';
    this.kind = kind;
    this.code = code;
  }
}

/** Bump when redaction changes so stored logs are scanned again on the next API start. */
export const RUN_LOG_REDACTION_VERSION = 5;

export const RUN_LOG_REDACTION_MARKER = 'migration:run-log-redaction';

const UNTOUCHED = new Set(['_id', 'runId', 'agentId', 'issueId', 'seq', 'type', 'status', 'at']);

export interface RedactStoredOptions {
  batchSize?: number;
  /** Scan even when the current version was already applied, for example with more known values. */
  force?: boolean;
  onError?: (details: Record<string, unknown>) => void;
}

export interface RedactStoredResult {
  skipped: boolean;
  eventsScanned: number;
  eventsChanged: number;
  runsScanned: number;
  runsChanged: number;
  withheld: number;
}

interface CollectionResult {
  scanned: number;
  changed: number;
  /** Documents replaced by a placeholder because they could not be redacted safely. */
  withheld: number;
}

/** The $set/$unset needed to redact one stored document, or null when it is already clean. */
function redactionUpdate(
  doc: Document,
  fields: readonly string[] | null,
  redactor: Redactor,
  onError: RedactStoredOptions['onError'],
): Document | null {
  const keys = (fields ?? Object.keys(doc)).filter((key) => !UNTOUCHED.has(key) && key in doc);
  const set: Document = {};
  const unset: Document = {};
  for (const key of keys) {
    let clean: unknown;
    try {
      clean = redactor.deep(doc[key]);
    } catch (error) {
      onError?.({ id: String(doc['_id']), field: key, errorKind: errorKind(error) });
      if (typeof doc[key] === 'string') {
        set[key] = REDACTION_FAILED;
      } else {
        unset[key] = '';
      }
      continue;
    }
    if (!isDeepStrictEqual(clean, doc[key])) {
      set[key] = clean;
    }
  }
  const update: Document = {};
  if (Object.keys(set).length > 0) update['$set'] = set;
  if (Object.keys(unset).length > 0) update['$unset'] = unset;
  return Object.keys(update).length > 0 ? update : null;
}

/** How often a page is re-read when concurrent writers change its documents during a scan. */
export const MAX_SNAPSHOT_RETRIES = 3;

type ScanOptions = Required<Pick<RedactStoredOptions, 'batchSize'>> & RedactStoredOptions;

/** Matches the document only while it is unchanged since it was read. */
const snapshotFilter = (doc: Document): Document => ({
  _id: doc['_id'],
  // $literal keeps stored data from being interpreted as query expressions.
  $expr: { $eq: ['$$ROOT', { $literal: doc }] },
});

/** Replace every redactable field of a document that could not be redacted safely. */
function withholdUpdate(doc: Document, fields: readonly string[] | null): Document {
  const keys = (fields ?? Object.keys(doc)).filter((key) => !UNTOUCHED.has(key) && key in doc);
  const set: Document = {};
  const unset: Document = {};
  for (const key of keys) {
    if (typeof doc[key] === 'string') set[key] = REDACTION_FAILED;
    else unset[key] = '';
  }
  return {
    ...(Object.keys(set).length > 0 ? { $set: set } : {}),
    ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
  };
}

/**
 * Last attempt for a page whose snapshots kept changing: each document gets one more snapshot
 * write, and a document that still changed underneath is withheld instead of left unredacted.
 */
async function settlePage(
  collection: Collection<Document>,
  updates: { doc: Document; update: Document }[],
  fields: readonly string[] | null,
  result: CollectionResult,
  options: ScanOptions,
): Promise<void> {
  for (const { doc, update } of updates) {
    const written = await collection.updateOne(snapshotFilter(doc), update);
    if (written.matchedCount > 0) {
      result.changed += written.modifiedCount;
      continue;
    }
    await collection.updateOne({ _id: doc['_id'] }, withholdUpdate(doc, fields));
    result.withheld += 1;
    options.onError?.({
      id: String(doc['_id']),
      reason: 'document kept changing during redaction',
    });
  }
}

async function redactCollection(
  collection: Collection<Document>,
  filter: Document,
  fields: readonly string[] | null,
  redactor: Redactor,
  options: ScanOptions,
): Promise<CollectionResult> {
  const result: CollectionResult = { scanned: 0, changed: 0, withheld: 0 };
  let after: ObjectId | null = null;
  let retries = 0;
  for (;;) {
    const page = await collection
      .find(after ? { $and: [filter, { _id: { $gt: after } }] } : filter)
      .sort({ _id: 1 })
      .limit(options.batchSize)
      .toArray();
    if (page.length === 0) {
      return result;
    }
    const updates = page.flatMap((doc) => {
      const update = redactionUpdate(doc, fields, redactor, options.onError);
      return update ? [{ doc, update }] : [];
    });
    if (updates.length > 0 && retries >= MAX_SNAPSHOT_RETRIES) {
      await settlePage(collection, updates, fields, result, options);
    } else if (updates.length > 0) {
      const written = await collection.bulkWrite(
        updates.map(({ doc, update }) => ({ updateOne: { filter: snapshotFilter(doc), update } })),
        { ordered: false },
      );
      result.changed += written.modifiedCount;
      if (written.matchedCount < updates.length) {
        retries += 1;
        continue;
      }
    }
    retries = 0;
    result.scanned += page.length;
    after = page.at(-1)?.['_id'] as ObjectId;
  }
}

/**
 * Redact run logs and run errors stored before redaction existed. Idempotent: redaction never
 * changes clean content, only changed documents are written, and a marker skips repeat scans.
 */
export async function redactStoredRunLogs(
  collections: Collections,
  redactor: Redactor,
  options: RedactStoredOptions = {},
): Promise<RedactStoredResult> {
  try {
    const marker = await collections.counters.findOne({ _id: RUN_LOG_REDACTION_MARKER });
    if (!options.force && (marker?.value ?? 0) >= RUN_LOG_REDACTION_VERSION) {
      return {
        skipped: true,
        eventsScanned: 0,
        eventsChanged: 0,
        runsScanned: 0,
        runsChanged: 0,
        withheld: 0,
      };
    }
    const settings = { ...options, batchSize: options.batchSize ?? 500 };
    const events = await redactCollection(
      collections.runEvents as unknown as Collection<Document>,
      {},
      null,
      redactor,
      settings,
    );
    const runs = await redactCollection(
      collections.runs as unknown as Collection<Document>,
      { error: { $type: 'string' } },
      ['error'],
      redactor,
      settings,
    );
    await collections.counters.updateOne(
      { _id: RUN_LOG_REDACTION_MARKER },
      { $max: { value: RUN_LOG_REDACTION_VERSION } },
      { upsert: true },
    );
    return {
      skipped: false,
      eventsScanned: events.scanned,
      eventsChanged: events.changed,
      runsScanned: runs.scanned,
      runsChanged: runs.changed,
      withheld: events.withheld + runs.withheld,
    };
  } catch (error) {
    throw error instanceof StoredRedactionError ? error : new StoredRedactionError(error);
  }
}

export interface RescanLogger {
  info(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

/** Run the startup rescan in the background; failures are logged without any error object. */
export function startStoredRunLogRedaction(
  collections: Collections,
  redactor: Redactor,
  log: RescanLogger,
): Promise<void> {
  return redactStoredRunLogs(collections, redactor, {
    onError: (details) => log.error(details, 'stored run log redaction failed'),
  }).then(
    (result) => log.info({ ...result }, 'stored run log redaction finished'),
    (error: unknown) => {
      const safe = error instanceof StoredRedactionError ? error : new StoredRedactionError(error);
      log.error({ errorKind: safe.kind, code: safe.code }, 'stored run log redaction aborted');
    },
  );
}
