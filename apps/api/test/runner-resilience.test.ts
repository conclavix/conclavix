import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Collections, Database, RunDoc } from '../src/db.js';
import { Scheduler } from '../src/modules/scheduler/scheduler.js';
import { parseStreamLine, type StreamSummary } from '../src/runner/adapters/claude-stream.js';
import { RunEventRecorder } from '../src/runner/events.js';

afterEach(() => vi.restoreAllMocks());

describe('runner resilience', () => {
  it.each(['-1', '1e400', '"0.5"', 'null', '{}'])('ignores invalid cost %s', (cost) => {
    const summary: StreamSummary = {
      costUsd: 0.12,
      resultSeen: false,
      isError: false,
      errorReason: null,
    };
    parseStreamLine(
      `{"type":"result","subtype":"success","total_cost_usd":${cost}}`,
      summary,
      vi.fn(),
    );
    expect(summary.costUsd).toBe(0.12);
    expect(summary.resultSeen).toBe(true);
  });

  it.each([0, 0.5])('accepts valid cost %s', (cost) => {
    const summary: StreamSummary = {
      costUsd: 0.12,
      resultSeen: false,
      isError: false,
      errorReason: null,
    };
    parseStreamLine(
      JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: cost }),
      summary,
      vi.fn(),
    );
    expect(summary.costUsd).toBe(cost);
  });

  it('continues flushing after an automatic batch insert fails', async () => {
    const insertMany = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({});
    const collections = { runEvents: { insertMany } } as unknown as Collections;
    const runId = new ObjectId();
    const events = new RunEventRecorder(collections, runId);
    for (let i = 0; i < 50; i += 1) events.record('runner', 'first batch');
    events.record('runner', 'later batch');
    await expect(events.flush()).resolves.toBeUndefined();
    await expect(events.flush()).resolves.toBeUndefined();
    expect(insertMany).toHaveBeenCalledTimes(2);
    expect(insertMany.mock.calls[0]?.[0]).toHaveLength(50);
    expect(insertMany.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ runId, seq: 51, text: 'later batch' }),
    ]);
  });

  it('persists the token with the queued-to-running transition in one write', async () => {
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    const database = { collections: { runs: { updateOne } } } as unknown as Database;
    const scheduler = new Scheduler(database, { dispatch: vi.fn() });
    const runId = new ObjectId();
    const now = new Date();
    const { token } = await scheduler.startRun(runId, 60_000, now);
    expect(updateOne).toHaveBeenCalledExactlyOnceWith(
      { _id: runId, status: 'queued' },
      {
        $set: {
          status: 'running',
          startedAt: now,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          tokenExpiresAt: new Date(now.getTime() + 60_000),
        },
      },
    );
    updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    await expect(scheduler.startRun(runId, 60_000, now)).rejects.toThrow('run is not queued');
  });

  it('continues recovery after individual finish and dispatch failures', async () => {
    const runs = Array.from({ length: 4 }, () => ({
      _id: new ObjectId(),
      costUsd: 0.4,
    })) as RunDoc[];
    const find = vi
      .fn()
      .mockReturnValueOnce({ toArray: async () => runs.slice(0, 2) })
      .mockReturnValueOnce({ toArray: async () => runs.slice(2) });
    const database = { collections: { runs: { find } } } as unknown as Database;
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValue(undefined);
    const scheduler = new Scheduler(database, { dispatch });
    const laterRun = runs[1];
    if (!laterRun) throw new Error('expected a run');
    const finish = vi
      .spyOn(scheduler, 'finishRun')
      .mockRejectedValueOnce(new Error('already finished'))
      .mockResolvedValue(laterRun);
    expect(await scheduler.recoverRuns(1000)).toEqual({ failed: 1, redispatched: 1 });
    expect(finish).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenLastCalledWith(
      laterRun._id,
      { status: 'timed_out', costUsd: 0.4, error: 'runner lost the run' },
      expect.any(Date),
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenLastCalledWith(runs[3]);
  });
});
