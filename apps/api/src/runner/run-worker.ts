import pino from 'pino';
import { CHAT_LIMITS } from '@conclavix/core';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ObjectId } from 'mongodb';
import {
  isChatRun,
  type AgentDoc,
  type ChatRunDoc,
  type Database,
  type IssueDoc,
  type RunDoc,
} from '../db.js';
import { AppError } from '../errors.js';
import type { Scheduler } from '../modules/scheduler/scheduler.js';
import type { Adapter, AdapterResult } from './adapters/types.js';
import { RunEventRecorder } from './events.js';
import { loadPosition } from '../modules/org/position.js';
import { buildPrompt } from './prompt.js';
import { buildChatPrompt } from './chat-prompt.js';
import { recordChatReply } from '../modules/chats/turns.js';
import { Redactor, errorKind, redactOrWithhold, type KnownSecret } from './redact.js';
import { loadAgentSkills, materializeSkills } from './skills.js';
import type { CodeRunContext, CodeRuns } from './code-run.js';

const log = pino({ name: 'runner' });

// Shared by worker instances in this runner process: different issues can use one workspace, and
// agents with code access in one issue share its clone.
const workspaceLocks = new Map<string, Promise<void>>();

/** Run `work` once every earlier holder of any of `keys` is done; keys are taken in order. */
async function withLocks<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
  const [key, ...rest] = keys;
  if (key === undefined) return work();
  const previous = workspaceLocks.get(key);
  const { promise, resolve: release } = Promise.withResolvers<undefined>();
  workspaceLocks.set(key, promise);
  await previous;
  try {
    return await withLocks(rest, work);
  } finally {
    release(undefined);
    if (workspaceLocks.get(key) === promise) workspaceLocks.delete(key);
  }
}

/** The workspace directory of an agent's chat runs, apart from its project workspaces. */
export const CHAT_WORKSPACE = '_chat';

export interface RunWorkerOptions {
  /** Coding agents (code access 'write'); without it their runs fail with an explanation. */
  codeRuns?: CodeRuns;
  workspacesRoot: string;
  mcpUrl: string;
  timeoutMs: number;
  adapters: Partial<Record<string, Adapter>>;
  /** Secret values the runner holds; they are scrubbed from the run log and the run error. */
  knownSecrets?: readonly KnownSecret[];
}

const CODE_UNAVAILABLE: AdapterResult = {
  status: 'failed',
  costUsd: 0,
  error:
    'agents with code access need the claude_cli adapter and the coding-agent sandbox on the runner',
};

/** The materialised skills of a run, mounted for coding agents; null without skills. */
const skillsDirOf = (workspace: string, count: number): string | null =>
  count > 0 ? join(workspace, '.claude', 'skills') : null;

const CODE_ACCESS_CHANGED: AdapterResult = {
  status: 'failed',
  costUsd: 0,
  error: 'code access was granted while the run was queued; the next run uses it',
};

/** Executes one queued run end to end: start, adapter, log, finish. */
export class RunWorker {
  constructor(
    private readonly database: Database,
    private readonly scheduler: Scheduler,
    private readonly options: RunWorkerOptions,
  ) {}

  async process(runId: ObjectId): Promise<AdapterResult | null> {
    const { collections } = this.database;
    const run = await collections.runs.findOne({ _id: runId, status: 'queued' });
    if (!run) {
      return null;
    }
    if (isChatRun(run)) {
      // Chat runs never touch code; their workspace only holds the materialised skills.
      const workspace = join(
        this.options.workspacesRoot,
        run.agentId.toHexString(),
        CHAT_WORKSPACE,
      );
      return withLocks([resolve(workspace)], () => this.processLocked(runId, workspace, false));
    }
    const issue = run.issueId ? await collections.issues.findOne({ _id: run.issueId }) : null;
    const workspace = join(
      this.options.workspacesRoot,
      run.agentId.toHexString(),
      issue?.key.split('-')[0] ?? 'default',
    );
    const agent = await collections.agents.findOne({ _id: run.agentId });
    const keys = [resolve(workspace)];
    // The clone lock and the code path in execute() both follow this value.
    const writes = agent?.codeAccess === 'write';
    if (writes && issue) keys.push(`clone:${issue.projectId.toHexString()}:${issue.key}`);
    // Start the token lifetime only once this run owns its workspace (and the issue clone).
    return withLocks(keys, () => this.processLocked(runId, workspace, writes));
  }

  private async processLocked(
    runId: ObjectId,
    workspace: string,
    writes: boolean,
  ): Promise<AdapterResult | null> {
    const { collections } = this.database;
    let token: string;
    try {
      ({ token } = await this.scheduler.startRun(runId, this.options.timeoutMs + 60_000));
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 409) {
        return null;
      }
      throw error;
    }
    const redactor = new Redactor([
      ...(this.options.knownSecrets ?? []),
      { name: 'RUN_TOKEN', value: token },
    ]);
    const events = new RunEventRecorder(collections, runId, redactor);
    const redact = (text: string) =>
      redactOrWithhold(redactor, text, (error) =>
        log.error({ runId: runId.toHexString(), errorKind: errorKind(error) }, 'redaction failed'),
      );
    const result = await this.execute(runId, token, events, workspace, redact, writes).catch(
      (error: unknown): AdapterResult => {
        events.recordFinal(`runner error: ${String(error)}`);
        return { status: 'failed', costUsd: 0, error: String(error) };
      },
    );
    events.recordFinal(`finished: ${result.status}, cost ${result.costUsd.toFixed(4)} USD`);
    try {
      await events.finish();
    } catch (error) {
      log.error({ err: error, runId: runId.toHexString() }, 'failed to flush run events');
    }
    await this.scheduler.finishRun(runId, {
      status: result.status,
      costUsd: result.costUsd,
      ...(result.error === undefined
        ? {}
        : {
            error: redactOrWithhold(redactor, result.error, (error) =>
              log.error(
                { runId: runId.toHexString(), errorKind: errorKind(error) },
                'run error redaction failed',
              ),
            ),
          }),
    });
    return result;
  }

  /**
   * The code-run service for an agent with code access now, null for an agent without it. `writes`
   * is the code access the run's locks were taken for: access revoked while the run waited makes
   * it a read-only run, access granted meanwhile fails it (it holds no clone lock).
   */
  private codeRunsFor(agent: AgentDoc, writes: boolean): CodeRuns | null | AdapterResult {
    if (agent.codeAccess !== 'write') return null;
    if (!writes) return CODE_ACCESS_CHANGED;
    if (agent.adapter.type !== 'claude_cli' || !this.options.codeRuns) return CODE_UNAVAILABLE;
    return this.options.codeRuns;
  }

  /**
   * Store the run's cost right away (the spend has happened, and committing and syncing can take
   * minutes during which a restart or the scheduler's recovery would otherwise record 0 USD), then
   * commit and sync. Neither failure may drop the cost.
   */
  private async finishCode(
    codeRuns: CodeRuns,
    context: CodeRunContext,
    agent: AgentDoc,
    issue: IssueDoc,
    run: RunDoc,
    result: AdapterResult,
    events: RunEventRecorder,
    redact: (text: string) => string,
  ): Promise<void> {
    await this.database.collections.runs
      .updateOne({ _id: run._id, status: 'running' }, { $set: { costUsd: result.costUsd } })
      .catch((error: unknown) =>
        events.record('runner', `storing the cost early failed: ${redact(String(error))}`),
      );
    await codeRuns
      .finish(context, agent, issue, run, result, events, redact)
      .catch((error: unknown) =>
        events.record('runner', `code: recording the outcome failed: ${redact(String(error))}`),
      );
  }

  private async execute(
    runId: ObjectId,
    token: string,
    events: RunEventRecorder,
    workspace: string,
    redact: (text: string) => string,
    writes: boolean,
  ): Promise<AdapterResult> {
    const run = await this.database.collections.runs.findOne({ _id: runId });
    if (!run) {
      return { status: 'failed', costUsd: 0, error: 'run, agent or issue disappeared' };
    }
    if (isChatRun(run)) {
      return this.executeChat(run, token, events, workspace, redact);
    }
    return this.executeIssue(run, token, events, workspace, redact, writes);
  }

  private async executeIssue(
    run: RunDoc,
    token: string,
    events: RunEventRecorder,
    workspace: string,
    redact: (text: string) => string,
    writes: boolean,
  ): Promise<AdapterResult> {
    const { collections } = this.database;
    const agent = await collections.agents.findOne({ _id: run.agentId });
    const issue = run.issueId ? await collections.issues.findOne({ _id: run.issueId }) : null;
    if (!agent || !issue) {
      return { status: 'failed', costUsd: 0, error: 'run, agent or issue disappeared' };
    }
    const adapter = this.options.adapters[agent.adapter.type];
    if (!adapter) {
      return {
        status: 'failed',
        costUsd: 0,
        error: `adapter ${agent.adapter.type} is not available`,
      };
    }
    await mkdir(workspace, { recursive: true });
    const skills = await loadAgentSkills(collections, agent.skillIds);
    await materializeSkills(workspace, skills);
    if (skills.length > 0) {
      events.record('runner', `skills: ${skills.map((skill) => skill.name).join(', ')}`);
    }
    const codeRuns = this.codeRunsFor(agent, writes);
    if (codeRuns && 'status' in codeRuns) return codeRuns;
    const context = codeRuns
      ? await codeRuns.prepare(issue, skillsDirOf(workspace, skills.length), events)
      : null;
    const where = context ? `the sandbox on ${context.branch}` : workspace;
    events.record('runner', `starting ${agent.adapter.type} for ${issue.key} in ${where}`);
    const result = await adapter.run({
      run,
      agent,
      issue,
      prompt: buildPrompt(
        agent,
        issue,
        run.reason,
        await loadPosition(this.database, agent, issue.projectId),
        { code: context !== null },
      ),
      workspace,
      mcpUrl: this.options.mcpUrl,
      token,
      timeoutMs: this.options.timeoutMs,
      ...(context ? { code: context } : {}),
      onEvent: (type, text, data) => events.record(type, text, data),
    });
    if (context && codeRuns) {
      await this.finishCode(codeRuns, context, agent, issue, run, result, events, redact);
    }
    return result;
  }

  /**
   * A chat run of the lead: the prompt carries the chat-mode rules, the plan and the conversation;
   * the run's final text becomes the reply in the chat (redacted like the run log).
   */
  private async executeChat(
    run: ChatRunDoc,
    token: string,
    events: RunEventRecorder,
    workspace: string,
    redact: (text: string) => string,
  ): Promise<AdapterResult> {
    const { collections } = this.database;
    const [agent, chat] = await Promise.all([
      collections.agents.findOne({ _id: run.agentId }),
      collections.chats.findOne({ _id: run.chatId }),
    ]);
    if (!agent || !chat) {
      return { status: 'failed', costUsd: 0, error: 'run, agent or chat disappeared' };
    }
    const adapter = this.options.adapters[agent.adapter.type];
    if (!adapter) {
      return {
        status: 'failed',
        costUsd: 0,
        error: `adapter ${agent.adapter.type} is not available`,
      };
    }
    // Only the newest messages reach the prompt; the count tells the lead how many it does not see.
    const [newest, total, project] = await Promise.all([
      collections.chatMessages
        .find({ chatId: chat._id })
        .sort({ createdAt: -1, _id: -1 })
        .limit(CHAT_LIMITS.historyMessages)
        .toArray(),
      collections.chatMessages.countDocuments({ chatId: chat._id }),
      chat.projectId ? collections.projects.findOne({ _id: chat.projectId }) : null,
    ]);
    const messages = newest.reverse();
    await mkdir(workspace, { recursive: true });
    const skills = await loadAgentSkills(collections, agent.skillIds);
    await materializeSkills(workspace, skills);
    if (skills.length > 0) {
      events.record('runner', `skills: ${skills.map((skill) => skill.name).join(', ')}`);
    }
    events.record(
      'runner',
      `starting ${agent.adapter.type} for chat "${chat.title}" (${run.reason})`,
    );
    const result = await adapter.run({
      run,
      agent,
      issue: null,
      prompt: buildChatPrompt({
        agent,
        chat,
        messages,
        totalMessages: total,
        project,
        code: project !== null,
      }),
      workspace,
      mcpUrl: this.options.mcpUrl,
      token,
      timeoutMs: this.options.timeoutMs,
      onEvent: (type, text, data) => events.record(type, text, data),
    });
    const reply = result.summary ? redact(result.summary) : '';
    const error = result.status === 'succeeded' ? null : redact(result.error ?? result.status);
    await recordChatReply(collections, run, reply, error).catch((cause: unknown) =>
      events.record('runner', `storing the chat reply failed: ${redact(String(cause))}`),
    );
    return result;
  }
}
