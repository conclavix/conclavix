import { readFile } from 'node:fs/promises';
import { ObjectId, type Collection, type Document } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunDoc, RunEventDoc } from '../src/db.js';
import {
  RUN_LOG_REDACTION_MARKER,
  RUN_LOG_REDACTION_VERSION,
  redactStoredRunLogs,
  MAX_SNAPSHOT_RETRIES,
  StoredRedactionError,
  startStoredRunLogRedaction,
} from '../src/modules/runs/redact-stored.js';
import { REDACTION_FAILED, Redactor } from '../src/runner/redact.js';
import { createTestContext, type TestContext } from './helpers.js';

const KNOWN = 'FAKE-known-board-token-0123456789';
const PAT = ['ghp', '_', 'FAKEfakeFAKEfake0123456789'].join('');

describe('redacting stored run logs', () => {
  let ctx: TestContext;
  const runId = new ObjectId();
  const redactor = new Redactor([{ name: 'BOARD_TOKEN', value: KNOWN }]);

  const event = (seq: number, text: string, extra: Partial<RunEventDoc> = {}): RunEventDoc => ({
    _id: new ObjectId(),
    runId,
    seq,
    type: 'assistant',
    text,
    at: new Date(),
    ...extra,
  });

  beforeAll(async () => {
    ctx = await createTestContext();
    const { runEvents, runs } = ctx.database.collections;
    await runEvents.insertMany([
      event(1, `token ${PAT}`),
      event(2, 'nothing secret here 9e69bc5d04f186cc28a5067982fff35a0cd8a45d'),
      event(3, `board ${KNOWN}`),
      event(4, 'plain', { data: { content: `DB_PASSWORD=FAKEpass0123` } } as Partial<RunEventDoc>),
      ...Array.from({ length: 7 }, (_, index) => event(10 + index, `filler ${index}`)),
    ]);
    await runs.insertOne({
      _id: runId,
      error: 'failed with Authorization: Bearer FAKEbearer0123',
    } as unknown as RunDoc);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('redacts old events and run errors in batches and records the version', async () => {
    const result = await redactStoredRunLogs(ctx.database.collections, redactor, { batchSize: 3 });
    expect(result).toEqual({
      skipped: false,
      eventsScanned: 11,
      eventsChanged: 3,
      runsScanned: 1,
      runsChanged: 1,
      withheld: 0,
    });
    const stored = await ctx.database.collections.runEvents
      .find({ runId })
      .sort({ seq: 1 })
      .toArray();
    expect(stored.slice(0, 4).map((doc) => doc.text)).toEqual([
      'token [redacted:github-token]',
      'nothing secret here 9e69bc5d04f186cc28a5067982fff35a0cd8a45d',
      'board [redacted:BOARD_TOKEN]',
      'plain',
    ]);
    expect((stored[3] as unknown as { data: unknown }).data).toEqual({
      content: 'DB_PASSWORD=[redacted:secret]',
    });
    expect((await ctx.database.collections.runs.findOne({ _id: runId }))?.error).toBe(
      'failed with Authorization: Bearer [redacted:authorization]',
    );
    expect(
      await ctx.database.collections.counters.findOne({ _id: RUN_LOG_REDACTION_MARKER }),
    ).toMatchObject({ value: RUN_LOG_REDACTION_VERSION });
  });

  it('skips once applied and changes nothing when forced again', async () => {
    const before = await ctx.database.collections.runEvents.find({ runId }).toArray();
    expect((await redactStoredRunLogs(ctx.database.collections, redactor)).skipped).toBe(true);
    const forced = await redactStoredRunLogs(ctx.database.collections, redactor, { force: true });
    expect(forced).toMatchObject({ skipped: false, eventsChanged: 0, runsChanged: 0 });
    expect(await ctx.database.collections.runEvents.find({ runId }).toArray()).toEqual(before);
  });

  it.each(['runEvents', 'runs'] as const)(
    'preserves both scans’ redactions when %s updates overlap',
    async (name) => {
      const isolated = await createTestContext();
      const collections = isolated.database.collections;
      const otherSecret = 'FAKE-second-known-value-9876543210';
      const id = new ObjectId();
      const raw = `first ${KNOWN} second ${otherSecret}`;
      if (name === 'runEvents') {
        await collections.runEvents.insertOne(
          event(1, raw, {
            _id: id,
            data: { nested: [raw, '$literal'] },
          } as unknown as Partial<RunEventDoc>),
        );
      } else {
        await collections.runs.insertOne({ _id: id, error: raw } as RunDoc);
      }
      const collection = collections[name] as unknown as Collection<Document>;
      const bulkWrite = collection.bulkWrite.bind(collection);
      // Pause the first scan after its read, then let a scan with different known values finish.
      const write = vi.spyOn(collection, 'bulkWrite').mockImplementationOnce(async (...args) => {
        await redactStoredRunLogs(
          collections,
          new Redactor([{ name: 'OTHER_TOKEN', value: otherSecret }]),
          { force: true, batchSize: 1 },
        );
        return bulkWrite(...args);
      });
      try {
        const result = await redactStoredRunLogs(collections, redactor, { batchSize: 1 });
        const stored = await collection.findOne({ _id: id });
        const clean = 'first [redacted:BOARD_TOKEN] second [redacted:OTHER_TOKEN]';
        expect(stored).toMatchObject(
          name === 'runEvents'
            ? { text: clean, data: { nested: [clean, '$literal'] } }
            : { error: clean },
        );
        expect(result).toMatchObject(
          name === 'runEvents'
            ? { eventsScanned: 1, eventsChanged: 1 }
            : { runsScanned: 1, runsChanged: 1 },
        );
      } finally {
        write.mockRestore();
        await isolated.close();
      }
    },
  );

  it('gives up on a document that keeps changing and withholds it instead', async () => {
    const id = new ObjectId();
    const { runEvents } = ctx.database.collections;
    await runEvents.insertOne(event(98, `churn ${KNOWN}`, { _id: id }));
    const collection = runEvents as unknown as Collection<Document>;
    const updateOne = collection.updateOne.bind(collection);
    const changed = { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    const bulk = vi
      .spyOn(collection, 'bulkWrite')
      .mockResolvedValue(changed as unknown as Awaited<ReturnType<typeof collection.bulkWrite>>);
    const single = vi
      .spyOn(collection, 'updateOne')
      .mockImplementation(async (filter, update, options) =>
        '$expr' in filter
          ? (changed as unknown as Awaited<ReturnType<typeof collection.updateOne>>)
          : updateOne(filter, update, options),
      );
    const errors: Record<string, unknown>[] = [];
    try {
      const result = await redactStoredRunLogs(ctx.database.collections, redactor, {
        force: true,
        onError: (details) => errors.push(details),
      });
      expect(bulk).toHaveBeenCalledTimes(MAX_SNAPSHOT_RETRIES);
      expect(result.withheld).toBe(1);
    } finally {
      bulk.mockRestore();
      single.mockRestore();
    }
    expect((await runEvents.findOne({ _id: id }))?.text).toBe(REDACTION_FAILED);
    expect(errors).toEqual([
      { id: id.toHexString(), reason: 'document kept changing during redaction' },
    ]);
    expect(JSON.stringify(errors)).not.toContain(KNOWN);
  });

  it('never lets a MongoDB error carry document content into the logs', async () => {
    const id = new ObjectId();
    const raw = `leaky ${KNOWN}`;
    const { runEvents } = ctx.database.collections;
    await runEvents.insertOne(event(97, raw, { _id: id }));
    const collection = runEvents as unknown as Collection<Document>;
    const failure = Object.assign(new Error(`E11000 duplicate key { text: "${raw}" }`), {
      name: 'MongoBulkWriteError',
      code: 11000,
      writeErrors: [{ errmsg: `dup ${raw}`, op: { q: { _id: id, text: raw } } }],
      result: { insertedIds: { 0: raw } },
    });
    const bulk = vi.spyOn(collection, 'bulkWrite').mockRejectedValue(failure);
    const entries: unknown[] = [];
    const log = {
      info: (details: Record<string, unknown>, message: string) => entries.push([details, message]),
      error: (details: Record<string, unknown>, message: string) =>
        entries.push([details, message]),
    };
    try {
      const thrown = await redactStoredRunLogs(ctx.database.collections, redactor, {
        force: true,
      }).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(StoredRedactionError);
      for (const view of [String(thrown), JSON.stringify(thrown), (thrown as Error).stack]) {
        expect(view).not.toContain(KNOWN);
      }
      await ctx.database.collections.counters.deleteOne({ _id: RUN_LOG_REDACTION_MARKER });
      await startStoredRunLogRedaction(ctx.database.collections, redactor, log);
    } finally {
      bulk.mockRestore();
    }
    expect(entries).toEqual([
      [{ errorKind: 'MongoBulkWriteError', code: 11000 }, 'stored run log redaction aborted'],
    ]);
    expect(JSON.stringify(entries)).not.toContain(KNOWN);
    await redactStoredRunLogs(ctx.database.collections, redactor, { force: true });
    expect((await runEvents.findOne({ _id: id }))?.text).toBe('leaky [redacted:BOARD_TOKEN]');
  });

  it('fails closed on documents it cannot redact', async () => {
    const id = new ObjectId();
    await ctx.database.collections.runEvents.insertOne(event(99, `raw ${KNOWN}`, { _id: id }));
    const broken = new Redactor();
    vi.spyOn(broken, 'deep').mockImplementation(() => {
      throw new Error('boom');
    });
    const errors: Record<string, unknown>[] = [];
    await redactStoredRunLogs(ctx.database.collections, broken, {
      force: true,
      onError: (details) => errors.push(details),
    });
    expect((await ctx.database.collections.runEvents.findOne({ _id: id }))?.text).toBe(
      REDACTION_FAILED,
    );
    expect(JSON.stringify(errors)).not.toContain(KNOWN);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('documented runner rescan', () => {
  it('runs as the runner user, never as the agent user that could read its environment', async () => {
    const root = new URL('../../../', import.meta.url);
    const doc = await readFile(new URL('docs/deploy.md', root), 'utf8');
    const unit = await readFile(new URL('deploy/systemd/conclavix-runner.service', root), 'utf8');
    const runnerUser = /^User=(\S+)$/m.exec(unit)?.[1];
    const command = /systemd-run[^`]*redact-main\.js/.exec(doc)?.[0];
    expect(runnerUser).toBeTruthy();
    expect(command).toContain(`--uid=${runnerUser} `);
  });
});
