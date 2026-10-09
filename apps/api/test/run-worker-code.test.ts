import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.js';
import type { Scheduler } from '../src/modules/scheduler/scheduler.js';
import type { Adapter, AdapterRunInput } from '../src/runner/adapters/types.js';
import type { CodeRuns } from '../src/runner/code-run.js';
import { RunWorker } from '../src/runner/run-worker.js';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/runner/skills.js', () => ({
  loadAgentSkills: vi.fn().mockResolvedValue([{ name: 'tdd' }]),
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

function fixture(codeAccess: 'none' | 'write', adapterType = 'claude_cli') {
  const agentId = new ObjectId();
  const issue = { _id: new ObjectId(), projectId: new ObjectId(), key: 'COD-1', title: 't' };
  const run = { _id: new ObjectId(), agentId, issueId: issue._id, reason: 'assigned' };
  const database = {
    collections: {
      runs: {
        findOne: vi.fn().mockResolvedValue(run),
        updateOne: vi.fn().mockResolvedValue(undefined),
      },
      agents: {
        findOne: vi.fn().mockResolvedValue({
          _id: agentId,
          name: 'Coder',
          role: 'engineer',
          adapter: { type: adapterType },
          codeAccess,
        }),
      },
      issues: { findOne: vi.fn().mockResolvedValue(issue) },
      runEvents: { insertMany: vi.fn().mockResolvedValue(undefined) },
      secrets: { find: () => ({ sort: () => ({ toArray: async () => [] }) }) },
    },
  } as unknown as Database;
  const scheduler = {
    startRun: vi.fn().mockResolvedValue({ token: 'tok' }),
    finishRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as Scheduler;
  const seen: AdapterRunInput[] = [];
  const adapter: Adapter = {
    run: vi.fn(async (input: AdapterRunInput) => {
      seen.push(input);
      return { status: 'succeeded' as const, costUsd: 0 };
    }),
  };
  const context = {
    projectId: issue.projectId.toHexString(),
    issueKey: 'COD-1',
    skillsDir: '/w/skills',
    branch: 'cvx/COD-1',
    base: null,
  };
  const codeRuns = {
    prepare: vi.fn().mockResolvedValue(context),
    finish: vi
      .fn()
      .mockResolvedValue({ commit: null, files: 0, insertions: 0, deletions: 0, synced: true }),
  } as unknown as CodeRuns;
  const worker = (withCode: boolean) =>
    new RunWorker(database, scheduler, {
      workspacesRoot: '/tmp/worker-code-tests',
      mcpUrl: 'http://127.0.0.1:9/mcp',
      timeoutMs: 10_000,
      adapters: { [adapterType]: adapter },
      ...(withCode ? { codeRuns } : {}),
    });
  return { run, worker, scheduler, seen, codeRuns, context, adapter, database };
}

describe('RunWorker with coding agents', () => {
  it('prepares the clone, runs in the sandbox and commits afterwards', async () => {
    const fx = fixture('write');
    const result = await fx.worker(true).process(fx.run._id);
    expect(result?.status).toBe('succeeded');
    expect(fx.codeRuns.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'COD-1' }),
      expect.stringMatching(/\.claude\/skills$/),
      expect.anything(),
      expect.objectContaining({ name: expect.any(String) }),
    );
    expect(fx.seen[0]?.code).toBe(fx.context);
    expect(fx.codeRuns.finish).toHaveBeenCalledTimes(1);
    const runs = fx.database.collections.runs as unknown as { updateOne: ReturnType<typeof vi.fn> };
    expect(runs.updateOne).toHaveBeenCalledWith(
      { _id: fx.run._id, status: 'running' },
      { $set: { costUsd: 0 } },
    );
  });

  it('keeps the real cost when recording the code outcome fails', async () => {
    const fx = fixture('write');
    vi.mocked(fx.adapter.run).mockResolvedValueOnce({ status: 'succeeded', costUsd: 1.8 });
    vi.mocked(fx.codeRuns.finish).mockRejectedValueOnce(new Error('not primary'));
    const result = await fx.worker(true).process(fx.run._id);
    expect(result).toMatchObject({ status: 'succeeded', costUsd: 1.8 });
    expect(fx.scheduler.finishRun).toHaveBeenCalledWith(
      fx.run._id,
      expect.objectContaining({ costUsd: 1.8 }),
    );
  });

  it('fails a writing agent when the runner has no sandbox', async () => {
    const fx = fixture('write');
    const result = await fx.worker(false).process(fx.run._id);
    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/sandbox/) });
    expect(fx.seen).toHaveLength(0);
  });

  it('fails a writing agent on another adapter', async () => {
    const fx = fixture('write', 'codex_cli');
    const result = await fx.worker(true).process(fx.run._id);
    expect(result?.status).toBe('failed');
    expect(fx.codeRuns.prepare).not.toHaveBeenCalled();
  });

  it('keeps read-only agents on the old path', async () => {
    const fx = fixture('none');
    await fx.worker(true).process(fx.run._id);
    expect(fx.seen[0]?.code).toBeUndefined();
    expect(fx.codeRuns.prepare).not.toHaveBeenCalled();
  });

  const changeWhileQueued = (fx: ReturnType<typeof fixture>, codeAccess: 'none' | 'write') => {
    const agents = fx.database.collections.agents as unknown as {
      findOne: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
    };
    return agents.findOne().then((stored) => {
      agents.findOne.mockReset();
      agents.findOne
        .mockResolvedValueOnce(stored)
        .mockResolvedValue({ ...(stored as Record<string, unknown>), codeAccess });
    });
  };

  it('runs read-only when code access was revoked while the run waited', async () => {
    const fx = fixture('write');
    await changeWhileQueued(fx, 'none');
    const result = await fx.worker(true).process(fx.run._id);
    expect(result?.status).toBe('succeeded');
    expect(fx.codeRuns.prepare).not.toHaveBeenCalled();
    expect(fx.seen[0]?.code).toBeUndefined();
  });

  it('fails a run whose code access was granted while it waited without the clone lock', async () => {
    const fx = fixture('none');
    await changeWhileQueued(fx, 'write');
    const result = await fx.worker(true).process(fx.run._id);
    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/granted/) });
    expect(fx.codeRuns.prepare).not.toHaveBeenCalled();
  });
});
