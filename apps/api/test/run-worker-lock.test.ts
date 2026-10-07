import { setImmediate } from 'node:timers/promises';
import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conflict } from '../src/errors.js';
import type { Database } from '../src/db.js';
import type { Scheduler } from '../src/modules/scheduler/scheduler.js';
import type { Adapter, AdapterResult } from '../src/runner/adapters/types.js';
import { RunWorker } from '../src/runner/run-worker.js';
import { materializeSkills } from '../src/runner/skills.js';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/runner/skills.js', () => ({
  loadAgentSkills: vi.fn().mockResolvedValue([]),
  materializeSkills: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/modules/org/position.js', () => ({
  loadPosition: vi.fn().mockResolvedValue({
    isLead: false,
    delegators: [],
    delegates: [],
    delegatesNotInProject: [],
    reportsTo: [],
    notifications: [],
  }),
}));

afterEach(() => vi.clearAllMocks());

// Immediate database/filesystem doubles make the lock boundary deterministic without timers.
function fixture(adapter: Adapter) {
  const agentId = new ObjectId();
  const runFor = (key: string) => ({
    _id: new ObjectId(),
    agentId,
    issueId: new ObjectId(),
    reason: 'assigned',
    key,
  });
  const runs = [runFor('PROJ-1'), runFor('PROJ-2'), runFor('PROJ-3'), runFor('OTHER-1')] as const;
  const database = {
    collections: {
      runs: {
        findOne: vi.fn(async ({ _id }: { _id: ObjectId }) => runs.find((r) => r._id.equals(_id))),
      },
      agents: {
        findOne: vi.fn(async () => ({
          _id: agentId,
          name: 'agent',
          role: 'engineer',
          adapter: { type: 'claude_cli' },
        })),
      },
      issues: {
        findOne: vi.fn(async ({ _id }: { _id: ObjectId }) => {
          const run = runs.find((r) => r.issueId.equals(_id));
          return { _id, key: run?.key, title: 'test' };
        }),
      },
      runEvents: { insertMany: vi.fn().mockResolvedValue(undefined) },
    },
  } as unknown as Database;
  const scheduler = {
    startRun: vi.fn().mockResolvedValue({ token: 'test' }),
    finishRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as Scheduler;
  const worker = () =>
    new RunWorker(database, scheduler, {
      workspacesRoot: '/tmp/worker-lock-tests',
      mcpUrl: 'http://127.0.0.1:9/mcp',
      timeoutMs: 10_000,
      adapters: { claude_cli: adapter },
    });
  return { runs, worker, scheduler };
}

const success: AdapterResult = { status: 'succeeded', costUsd: 0 };

describe('workspace run locking', () => {
  it.each(['resolve', 'reject'] as const)(
    'serializes different issues until the adapter %ss, while other workspaces proceed',
    async (outcome) => {
      const first = Promise.withResolvers<AdapterResult>();
      const entered = Promise.withResolvers<undefined>();
      const adapter: Adapter = {
        run: vi.fn(async (input) => {
          if (input.issue.key === 'PROJ-1') {
            entered.resolve(undefined);
            return first.promise;
          }
          return success;
        }),
      };
      const { runs, worker, scheduler } = fixture(adapter);
      const active = worker().process(runs[0]._id);
      await entered.promise;
      const queued = [worker().process(runs[1]._id), worker().process(runs[2]._id)];
      try {
        await expect(worker().process(runs[3]._id)).resolves.toEqual(success);
        await setImmediate();
        expect(vi.mocked(scheduler.startRun).mock.calls).toEqual([
          [runs[0]._id, 70_000],
          [runs[3]._id, 70_000],
        ]);
        expect(materializeSkills).toHaveBeenCalledTimes(2);
        expect(vi.mocked(adapter.run).mock.calls.map(([input]) => input.issue?.key)).toEqual([
          'PROJ-1',
          'OTHER-1',
        ]);
      } finally {
        if (outcome === 'resolve') first.resolve(success);
        else first.reject(new Error('adapter failed'));
        await Promise.all([active, ...queued]);
      }
      expect(vi.mocked(adapter.run).mock.calls.map(([input]) => input.issue?.key)).toEqual([
        'PROJ-1',
        'OTHER-1',
        'PROJ-2',
        'PROJ-3',
      ]);
      expect(materializeSkills).toHaveBeenCalledTimes(4);
    },
  );

  it('issues a fresh token after a wait longer than its lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = Promise.withResolvers<AdapterResult>();
    const entered = Promise.withResolvers<undefined>();
    const issued = new Map<string, { token: string; expiresAt: number }>();
    const adapter: Adapter = {
      run: vi.fn(async (input) => {
        if (input.issue.key === 'PROJ-1') {
          entered.resolve(undefined);
          return first.promise;
        }
        const token = issued.get(input.run._id.toHexString());
        expect(input.token).toBe(token?.token);
        expect(token?.expiresAt).toBe(Date.now() + input.timeoutMs + 60_000);
        return success;
      }),
    };
    const { runs, worker, scheduler } = fixture(adapter);
    vi.mocked(scheduler.startRun).mockImplementation(async (id, ttlMs) => {
      const token = `token-${id.toHexString()}`;
      issued.set(id.toHexString(), { token, expiresAt: Date.now() + ttlMs });
      return { token };
    });
    const active = worker().process(runs[0]._id);
    await entered.promise;
    const queued = worker().process(runs[1]._id);
    try {
      await setImmediate();
      vi.setSystemTime(Date.now() + 120_000);
      first.resolve(success);
      await expect(queued).resolves.toEqual(success);
    } finally {
      first.resolve(success);
      await Promise.all([active, queued]);
      vi.useRealTimers();
    }
  });

  it.each(['conflict', 'error'] as const)(
    'releases the workspace after startup %s',
    async (kind) => {
      const adapter: Adapter = { run: vi.fn().mockResolvedValue(success) };
      const { runs, worker, scheduler } = fixture(adapter);
      const error = kind === 'conflict' ? conflict('run is not queued') : new Error('offline');
      vi.mocked(scheduler.startRun).mockRejectedValueOnce(error);
      const failed = worker().process(runs[0]._id);
      const checked =
        kind === 'conflict'
          ? expect(failed).resolves.toBeNull()
          : expect(failed).rejects.toThrow(error);
      const next = worker().process(runs[1]._id);
      await checked;
      await expect(next).resolves.toEqual(success);
      expect(adapter.run).toHaveBeenCalledTimes(1);
      expect(scheduler.finishRun).toHaveBeenCalledTimes(1);
      expect(scheduler.finishRun).toHaveBeenCalledWith(runs[1]._id, success);
    },
  );

  it('releases the workspace after materialization fails', async () => {
    vi.mocked(materializeSkills).mockRejectedValueOnce(new Error('mount failed'));
    const adapter: Adapter = { run: vi.fn().mockResolvedValue(success) };
    const { runs, worker } = fixture(adapter);
    const results = await Promise.all([
      worker().process(runs[0]._id),
      worker().process(runs[1]._id),
    ]);
    expect(results[0]).toMatchObject({ status: 'failed', error: 'Error: mount failed' });
    expect(results[1]).toEqual(success);
    expect(adapter.run).toHaveBeenCalledTimes(1);
  });
});
