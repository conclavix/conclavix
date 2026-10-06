import pino from 'pino';
import { ObjectId, type ClientSession } from 'mongodb';
import type { FinishedRunStatus } from '@conclavix/core';
import { LOCKS, lock, type Database, type RunDoc, type WakeDoc } from '../../db.js';
import { conflict, notFound, unprocessable } from '../../errors.js';
import { Redactor, errorKind, redactOrWithhold } from '../../runner/redact.js';
import { generateRunToken } from '../runs/tokens.js';
import { evaluateWake, type GateResult } from './gates.js';
import { pauseOnLoop } from './loop-detection.js';
import { ACTIONABLE_STATUSES, requestWake } from './wakes.js';
import { disabledAssignments } from '../projects/agent-access.js';

/**
 * Receives runs the scheduler created; the runner queue implements it.
 * Runners must enforce run.maxCostPerRunUsd before spending and report actual cost.
 */
export interface RunDispatcher {
  dispatch(run: RunDoc): Promise<void>;
}

export interface SchedulerOptions {
  heartbeatMinutes: number;
  loopThreshold: number;
  batchSize: number;
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  heartbeatMinutes: 60,
  loopThreshold: 3,
  batchSize: 100,
};

export interface RunOutcome {
  status: FinishedRunStatus;
  costUsd: number;
  error?: string;
}

const log = pino({ name: 'scheduler' });

const patternRedactor = new Redactor();

/** Run errors are free text shown on the board, so credential formats are scrubbed here too. */
const storedError = (runId: ObjectId, error: string | undefined): string | null =>
  error === undefined
    ? null
    : redactOrWithhold(patternRedactor, error, (failure) =>
        log.error(
          { runId: runId.toHexString(), errorKind: errorKind(failure) },
          'run error redaction failed',
        ),
      );

type WakeResult = 'run' | 'skip' | 'defer';

/** Turns wakes into runs behind the gates, and closes runs with loop detection. */
export class Scheduler {
  constructor(
    private readonly database: Database,
    private readonly dispatcher: RunDispatcher,
    private readonly options: SchedulerOptions = DEFAULT_SCHEDULER_OPTIONS,
  ) {}

  private get collections() {
    return this.database.collections;
  }

  async processPendingWakes(now = new Date()): Promise<Record<WakeResult, number>> {
    const counts: Record<WakeResult, number> = { run: 0, skip: 0, defer: 0 };
    const wakes = await this.selectPendingWakes(now);
    for (const wake of wakes) {
      counts[await this.processWake(wake, now)] += 1;
    }
    return counts;
  }

  private async selectPendingWakes(now: Date): Promise<WakeDoc[]> {
    return this.database.inTransaction(async (session) => {
      await lock(this.collections, LOCKS.pendingWakes, session);
      const state = await this.collections.locks.findOne({ _id: LOCKS.pendingWakes }, { session });
      const select = (after?: ObjectId | null) =>
        this.collections.wakes
          .find(
            {
              processedAt: null,
              // Deferred wakes wait for their window; older wakes have no notBefore at all.
              notBefore: { $not: { $gt: now } },
              ...(after ? { _id: { $gt: after } } : {}),
            },
            { session },
          )
          .sort({ _id: 1 })
          .limit(this.options.batchSize)
          .toArray();
      let wakes = await select(state?.wakeCursor);
      if (wakes.length === 0 && state?.wakeCursor) {
        wakes = await select();
      }
      await this.collections.locks.updateOne(
        { _id: LOCKS.pendingWakes },
        { $set: { wakeCursor: wakes.at(-1)?._id ?? null } },
        { session },
      );
      return wakes;
    });
  }

  private async processWake(wake: WakeDoc, now: Date): Promise<WakeResult> {
    const outcome = await this.database.inTransaction(async (session) => {
      const gate = await evaluateWake(this.collections, wake, now, session);
      if (gate.kind === 'defer') {
        return { result: 'defer' as const, run: null };
      }
      if (gate.kind === 'defer_until') {
        await this.deferWake(wake, gate, session);
        return { result: 'defer' as const, run: null };
      }
      if (gate.kind === 'skip') {
        await this.collections.wakes.updateOne(
          { _id: wake._id },
          { $set: { processedAt: now, skipReason: gate.reason } },
          { session },
        );
        if (gate.reason === 'agent_disabled_in_project') {
          log.info(
            {
              wakeId: wake._id.toHexString(),
              agentId: wake.agentId.toHexString(),
              issueId: wake.issueId.toHexString(),
            },
            'wake skipped: agent is not enabled in the project of the issue',
          );
        }
        return { result: 'skip' as const, run: null };
      }
      const run: RunDoc = {
        _id: new ObjectId(),
        agentId: gate.agent._id,
        issueId: gate.issue._id,
        reason: wake.reason,
        status: 'queued',
        costUsd: 0,
        maxCostPerRunUsd: gate.agent.limits.maxCostPerRunUsd,
        overBudget: false,
        progressAtStart: gate.issue.progress ?? 0,
        madeProgress: null,
        error: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        tokenHash: null,
        tokenExpiresAt: null,
      };
      const checkout = await this.collections.issues.updateOne(
        { _id: gate.issue._id, checkoutRunId: null },
        { $set: { checkoutRunId: run._id, lastRunAt: now } },
        { session },
      );
      if (checkout.modifiedCount !== 1) {
        return { result: 'defer' as const, run: null };
      }
      await this.collections.runs.insertOne(run, { session });
      await this.collections.wakes.updateOne(
        { _id: wake._id },
        { $set: { processedAt: now, runId: run._id } },
        { session },
      );
      return { result: 'run' as const, run };
    });
    if (outcome.run) {
      try {
        await this.dispatcher.dispatch(outcome.run);
      } catch (error) {
        await this.failDispatch(outcome.run, error, now);
      }
    }
    return outcome.result;
  }

  /** Keep the wake pending until its limit window frees; it is not selected before then. */
  private async deferWake(
    wake: WakeDoc,
    gate: Extract<GateResult, { kind: 'defer_until' }>,
    session: ClientSession,
  ): Promise<void> {
    await this.collections.wakes.updateOne(
      { _id: wake._id },
      { $set: { notBefore: gate.until, deferReason: gate.reason } },
      { session },
    );
    log.info(
      {
        wakeId: wake._id.toHexString(),
        agentId: wake.agentId.toHexString(),
        issueId: wake.issueId.toHexString(),
        reason: gate.reason,
        notBefore: gate.until.toISOString(),
      },
      'wake deferred until the limit window frees',
    );
  }

  private async failDispatch(run: RunDoc, error: unknown, now: Date): Promise<void> {
    await this.database.inTransaction(async (session) => {
      const failed = await this.collections.runs.updateOne(
        { _id: run._id, status: 'queued' },
        {
          $set: {
            status: 'failed',
            error: storedError(
              run._id,
              `Dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
            finishedAt: now,
          },
        },
        { session },
      );
      if (failed.modifiedCount === 1) {
        await this.collections.issues.updateOne(
          { _id: run.issueId, checkoutRunId: run._id },
          { $set: { checkoutRunId: null } },
          { session },
        );
      }
    });
  }

  /** Move a queued run to running and hand out its agent token, valid for `ttlMs`. */
  async startRun(runId: ObjectId, ttlMs: number, now = new Date()): Promise<{ token: string }> {
    const { token, tokenHash, tokenExpiresAt } = generateRunToken(ttlMs, now);
    const result = await this.collections.runs.updateOne(
      { _id: runId, status: 'queued' },
      { $set: { status: 'running', startedAt: now, tokenHash, tokenExpiresAt } },
    );
    if (result.matchedCount !== 1) {
      throw conflict('run is not queued');
    }
    return { token };
  }

  async finishRun(runId: ObjectId, outcome: RunOutcome, now = new Date()): Promise<RunDoc> {
    if (!Number.isFinite(outcome.costUsd) || outcome.costUsd < 0) {
      throw unprocessable('costUsd must be finite and non-negative');
    }
    const run = await this.database.inTransaction(async (session) => {
      const current = await this.collections.runs.findOne({ _id: runId }, { session });
      if (!current) {
        throw notFound('Run');
      }
      if (current.status !== 'queued' && current.status !== 'running') {
        throw conflict(`run already finished with status ${current.status}`);
      }
      const issue = await this.collections.issues.findOne({ _id: current.issueId }, { session });
      const madeProgress = (issue?.progress ?? current.progressAtStart) > current.progressAtStart;
      const finished = await this.collections.runs.findOneAndUpdate(
        { _id: runId },
        {
          $set: {
            status: outcome.status,
            costUsd: outcome.costUsd,
            overBudget: outcome.costUsd > current.maxCostPerRunUsd,
            error: storedError(runId, outcome.error),
            madeProgress,
            finishedAt: now,
            tokenHash: null,
            tokenExpiresAt: null,
          },
        },
        { returnDocument: 'after', session },
      );
      await this.collections.issues.updateOne(
        { _id: current.issueId, checkoutRunId: runId },
        { $set: { checkoutRunId: null } },
        { session },
      );
      return finished;
    });
    if (!run) {
      throw notFound('Run');
    }
    await pauseOnLoop(this.database, run, this.options.loopThreshold, now);
    return run;
  }

  /** Fail runs whose runner vanished, and re-dispatch queued runs that never reached a worker. */
  async recoverRuns(
    maxRunningMs: number,
    now = new Date(),
  ): Promise<{ failed: number; redispatched: number }> {
    let failed = 0;
    let redispatched = 0;
    const stale = await this.collections.runs
      .find({ status: 'running', startedAt: { $lt: new Date(now.getTime() - maxRunningMs) } })
      .toArray();
    for (const run of stale) {
      try {
        await this.finishRun(
          run._id,
          { status: 'timed_out', costUsd: run.costUsd, error: 'runner lost the run' },
          now,
        );
        failed += 1;
      } catch (error) {
        log.error({ err: error, runId: run._id.toHexString() }, 'failed to recover running run');
      }
    }
    const waiting = await this.collections.runs
      .find({ status: 'queued', createdAt: { $lt: new Date(now.getTime() - 60_000) } })
      .toArray();
    for (const run of waiting) {
      try {
        await this.dispatcher.dispatch(run);
        redispatched += 1;
      } catch (error) {
        log.error({ err: error, runId: run._id.toHexString() }, 'failed to redispatch queued run');
      }
    }
    return { failed, redispatched };
  }

  async sweepHeartbeats(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.options.heartbeatMinutes * 60 * 1000);
    const disabled = await disabledAssignments(this.collections);
    const due = await this.collections.issues
      .find({
        status: { $in: [...ACTIONABLE_STATUSES] },
        assigneeAgentId: { $ne: null },
        checkoutRunId: null,
        // Agents disabled in a project keep their issues there but get no heartbeats for them.
        ...(disabled.length > 0 ? { $nor: disabled } : {}),
        $or: [{ lastRunAt: null }, { lastRunAt: { $lt: cutoff } }],
      })
      .limit(this.options.batchSize * 5)
      .toArray();
    let created = 0;
    for (const issue of due) {
      if (
        issue.assigneeAgentId &&
        (await requestWake(this.collections, issue.assigneeAgentId, issue._id, 'heartbeat'))
      ) {
        created += 1;
      }
    }
    return created;
  }
}
