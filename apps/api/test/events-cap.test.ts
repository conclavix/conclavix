import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FLUSH_INTERVAL_MS, RunEventRecorder } from '../src/runner/events.js';
import { Redactor } from '../src/runner/redact.js';
import { createTestContext, type TestContext } from './helpers.js';

const SECRET = 'FAKE-cap-secret-value-0123456789';

describe('run event cap', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  const stored = (runId: ObjectId) =>
    ctx.database.collections.runEvents.find({ runId }).sort({ seq: 1 }).toArray();

  it('always stores the result and the closing lines and reports what it dropped', async () => {
    const runId = new ObjectId();
    const recorder = new RunEventRecorder(
      ctx.database.collections,
      runId,
      new Redactor([{ name: 'CVX_SECRET_CAP', value: SECRET }]),
      { maxEvents: 5, maxTerminal: 3 },
    );
    for (let index = 0; index < 12; index += 1) recorder.record('assistant', `line ${index}`);
    recorder.record('result', `success: done with ${SECRET}`, {
      kind: 'result',
      subtype: 'success',
      isError: false,
      numTurns: 3,
      durationMs: 1000,
      totalCostUsd: 0.5,
      usage: null,
      result: `done with ${SECRET}`,
    });
    recorder.record('assistant', 'after the result');
    recorder.recordFinal('finished: succeeded, cost 0.5000 USD');
    await recorder.finish();

    const events = await stored(runId);
    expect(events.map((event) => [event.seq, event.type, event.text])).toEqual([
      [1, 'assistant', 'line 0'],
      [2, 'assistant', 'line 1'],
      [3, 'assistant', 'line 2'],
      [4, 'assistant', 'line 3'],
      [5, 'assistant', 'line 4'],
      [6, 'runner', '[log truncated: 7 events dropped after the limit of 5]'],
      [7, 'result', 'success: done with [redacted:CVX_SECRET_CAP]'],
      [8, 'runner', '[log truncated: 1 event dropped after the limit of 5]'],
      [9, 'runner', 'finished: succeeded, cost 0.5000 USD'],
    ]);
    expect(events[6]?.data).toMatchObject({
      kind: 'result',
      totalCostUsd: 0.5,
      result: 'done with [redacted:CVX_SECRET_CAP]',
    });
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('reports drops when the run ends without a terminal event and bounds terminal events', async () => {
    const runId = new ObjectId();
    const recorder = new RunEventRecorder(ctx.database.collections, runId, undefined, {
      maxEvents: 2,
      maxTerminal: 1,
    });
    for (let index = 0; index < 4; index += 1) recorder.record('stderr', `noise ${index}`);
    await recorder.finish();
    expect((await stored(runId)).map((event) => event.text)).toEqual([
      'noise 0',
      'noise 1',
      '[log truncated: 2 events dropped after the limit of 2]',
    ]);

    const second = new ObjectId();
    const bounded = new RunEventRecorder(ctx.database.collections, second, undefined, {
      maxEvents: 2,
      maxTerminal: 1,
    });
    bounded.recordFinal('finished: one');
    bounded.recordFinal('finished: two');
    await bounded.finish();
    expect((await stored(second)).map((event) => event.text)).toEqual([
      'finished: one',
      '[log truncated: 1 event dropped after the limit of 2]',
    ]);
  });

  it('writes buffered events after the flush interval, so a run can be followed live', async () => {
    const runId = new ObjectId();
    const recorder = new RunEventRecorder(ctx.database.collections, runId);
    recorder.record('assistant', 'thinking out loud');
    expect(await stored(runId)).toHaveLength(0);
    // No flush() call: the recorder's own timer writes the event.
    await vi.waitFor(
      async () =>
        expect((await stored(runId)).map((event) => event.text)).toEqual(['thinking out loud']),
      { timeout: FLUSH_INTERVAL_MS + 2000, interval: 100 },
    );
  });
});
