import { ObjectId } from 'mongodb';
import type { RunDoc } from '../src/db.js';
import {
  Scheduler,
  type RunDispatcher,
  type SchedulerOptions,
} from '../src/modules/scheduler/scheduler.js';
import type { TestContext } from './helpers.js';

export class RecordingDispatcher implements RunDispatcher {
  readonly runs: RunDoc[] = [];

  async dispatch(run: RunDoc): Promise<void> {
    this.runs.push(run);
  }
}

export interface Fixture {
  scheduler: Scheduler;
  dispatcher: RecordingDispatcher;
  projectId: string;
  agent(payload?: Record<string, unknown>): Promise<{ id: string }>;
  issue(payload: Record<string, unknown>): Promise<{ id: string; key: string }>;
  patch(ref: string, payload: Record<string, unknown>): Promise<unknown>;
  pendingWakes(): Promise<number>;
}

let counter = 0;

export async function createFixture(
  ctx: TestContext,
  options: Partial<SchedulerOptions> = {},
): Promise<Fixture> {
  counter += 1;
  const dispatcher = new RecordingDispatcher();
  const scheduler = new Scheduler(ctx.database, dispatcher, {
    heartbeatMinutes: 60,
    stallWatchdogMinutes: 5,
    idleBackoffMs: 10 * 60_000,
    idleRunsAfterBackoff: 1,
    maxRunsPerIssuePerDay: 50,
    batchSize: 100,
    ...options,
  });
  const project = await ctx.request({
    method: 'POST',
    url: '/api/projects',
    payload: { key: `S${counter}`, name: `Scheduler ${counter}`, autoPlan: false },
  });
  const projectId = project.json().id as string;
  return {
    scheduler,
    dispatcher,
    projectId,
    agent: async (payload = {}) =>
      (
        await ctx.request({
          method: 'POST',
          url: '/api/agents',
          payload: {
            name: `agent-${new ObjectId().toHexString()}`,
            role: 'engineer',
            adapter: { type: 'claude_cli' },
            ...payload,
          },
        })
      ).json(),
    issue: async (payload) =>
      (
        await ctx.request({
          method: 'POST',
          url: '/api/issues',
          payload: { projectId, ...payload },
        })
      ).json(),
    patch: async (ref, payload) =>
      (await ctx.request({ method: 'PATCH', url: `/api/issues/${ref}`, payload })).json(),
    pendingWakes: () => ctx.database.collections.wakes.countDocuments({ processedAt: null }),
  };
}
