import type { RunCode } from '@conclavix/core';
import { AppError } from '../errors.js';
import type { AgentDoc, Database, IssueDoc, RunDoc } from '../db.js';
import type { AuditLog } from '../modules/audit/audit.js';
import type { CloneReconcile, CodeWorkspace } from '../modules/workspace/commit.js';
import {
  DEFAULT_AGENT_EMAIL_DOMAIN,
  agentIdentity,
  oneLine,
  type CommitIdentity,
} from '../modules/workspace/identity.js';
import { recordIssueWorkspace } from '../modules/workspace/record.js';
import type { AdapterResult } from './adapters/types.js';
import type { CodeRunTarget } from './adapters/sandbox.js';
import type { RunEventRecorder } from './events.js';

/** A coding agent's run between preparing the clone and committing in it. */
export interface CodeRunContext extends CodeRunTarget {
  branch: string;
  /** Tip of the issue branch in the project repository before the run. */
  base: string | null;
}

/** Sandbox results after which the clone is not committed (it may be over the disk limit). */
const NOT_COMMITTED = new Set(['disk-limit', 'disk-check-failed']);

/** Rounds of reconcile and sync after a run, while integration merges keep moving the branch. */
const SYNC_ATTEMPTS = 3;

const SUBJECT_LENGTH = 72;
const BODY_LENGTH = 4000;

const short = (sha: string | null): string => (sha ? sha.slice(0, 12) : 'none');

/**
 * The runner's commit message: a subject from the first line of the agent's result (or a fixed
 * one), the result as body, and trailers naming the issue, run and agent. The caller redacts it.
 */
export function commitMessage(
  agent: Pick<AgentDoc, '_id' | 'name'>,
  issue: Pick<IssueDoc, 'key' | 'title'>,
  run: Pick<RunDoc, '_id'>,
  result: Pick<AdapterResult, 'status' | 'summary'>,
): string {
  const summary = (result.summary ?? '').replace(/\r\n?/g, '\n').trim();
  const firstLine = oneLine(summary.split('\n').find((line) => line.trim() !== '') ?? '');
  const fallback = `${issue.key}: ${oneLine(issue.title)}`;
  let subject = firstLine === '' ? fallback : firstLine;
  if (subject.length > SUBJECT_LENGTH) subject = `${subject.slice(0, SUBJECT_LENGTH - 3)}...`;
  const body = summary
    .replace(/[^\P{Cc}\n\t]/gu, ' ')
    .slice(0, BODY_LENGTH)
    .trim();
  const trailers = [
    `Conclavix-Issue: ${issue.key}`,
    `Conclavix-Run: ${run._id.toHexString()}`,
    `Conclavix-Agent: ${oneLine(agent.name)}`,
    ...(result.status === 'succeeded' ? [] : [`Conclavix-Run-Status: ${result.status}`]),
  ];
  return `${subject}\n\n${body === '' || body === subject ? '' : `${body}\n\n`}${trailers.join('\n')}\n`;
}

/** Author of a coding agent's commits: `Conclavix <agent name>` with a per-agent address. */
export function commitAuthor(
  agent: Pick<AgentDoc, '_id' | 'name'>,
  domain: string = DEFAULT_AGENT_EMAIL_DOMAIN,
) {
  return agentIdentity(agent, domain);
}

/**
 * The runner's side of a coding agent's run: the issue clone before the run, and after it the
 * commit, the sync into the project repository and the run's `code` record.
 */
export class CodeRuns {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditLog,
    private readonly workspace: CodeWorkspace,
    /** Hands a clone left with the agent user back to the runner; `ok` is false if refused. */
    private readonly reclaim: (
      projectId: string,
      issueKey: string,
    ) => Promise<{ ok: boolean; detail: string }> = () =>
      Promise.resolve({ ok: false, detail: 'no sandbox helper' }),
  ) {}

  /** The identity reconciling merges are written with: the run's agent, else the system. */
  private author(agent: Pick<AgentDoc, '_id' | 'name'> | null): CommitIdentity {
    return agent
      ? commitAuthor(agent, this.workspace.agentEmailDomain)
      : { name: 'Conclavix', email: `conclavix@${this.workspace.agentEmailDomain}` };
  }

  /** Make sure the issue has its clone and branch, and note the branch tip the run starts from. */
  async prepare(
    issue: IssueDoc,
    skillsDir: string | null,
    events: RunEventRecorder,
    agent: Pick<AgentDoc, '_id' | 'name'> | null = null,
  ): Promise<CodeRunContext> {
    const projectId = issue.projectId.toHexString();
    let info;
    try {
      info = await this.workspace.createIssueWorkspace(projectId, issue.key);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM') throw error;
      events.record('runner', 'the workspace is still owned by the agent user; reclaiming it');
      const reclaimed = await this.reclaim(projectId, issue.key);
      if (!reclaimed.ok) {
        events.record('runner', `reclaiming the workspace failed: ${reclaimed.detail}`);
        throw error;
      }
      info = await this.workspace.createIssueWorkspace(projectId, issue.key);
    }
    await recordIssueWorkspace(this.database, this.audit, issue, info, { type: 'system' });
    // The base is the server tip the clone holds, never one read later: a merge may land meanwhile.
    let base: string | null = info.head || null;
    if (!info.created) {
      // The server branch may have moved since the last run (an integration merge into it).
      const reconciled = await this.reconcileBeforeRun(projectId, issue.key, agent, events);
      describeReconcile(reconciled, info.branch, events);
      base = (reconciled.action === 'none' ? reconciled.server : reconciled.head) ?? null;
      if (reconciled.action === 'set_aside') {
        info = await this.workspace.createIssueWorkspace(projectId, issue.key);
        await recordIssueWorkspace(this.database, this.audit, issue, info, { type: 'system' });
        base = info.head || null;
      }
    }
    events.record(
      'runner',
      `workspace ${info.branch} ${info.created ? 'created' : 'reused'}, server tip ${short(base)}`,
    );
    return { projectId, issueKey: issue.key, skillsDir, branch: info.branch, base };
  }

  /**
   * Commit what the agent left in the clone, fetch the branch into the project repository and
   * store the outcome on the run. Runs only after the sandbox unit has ended; a missing helper
   * report means the clone may still belong to the agent, so nothing is touched then.
   */
  async finish(
    context: CodeRunContext,
    agent: AgentDoc,
    issue: IssueDoc,
    run: RunDoc,
    result: AdapterResult,
    events: RunEventRecorder,
    redact: (text: string) => string,
  ): Promise<RunCode> {
    const code: RunCode = {
      branch: context.branch,
      base: context.base,
      head: null,
      commit: null,
      agentCommits: 0,
      files: 0,
      insertions: 0,
      deletions: 0,
      synced: false,
      error: null,
    };
    if (!result.sandbox) {
      code.error = 'the sandbox did not report its end; the workspace was left as it is';
    } else if (NOT_COMMITTED.has(result.sandbox.result)) {
      code.error = `the sandbox stopped the run (${result.sandbox.result}); nothing was committed`;
    } else {
      await this.commitAndSync(context, agent, issue, run, result, code, events, redact);
    }
    if (code.error) events.record('runner', `code: ${code.error}`);
    const commit = code.commit ? `commit ${code.commit.slice(0, 12)}` : 'no new commit';
    events.record(
      'runner',
      `code: ${commit}, ${code.files} files, +${code.insertions} -${code.deletions}, ${code.synced ? 'synced' : 'not synced'}`,
    );
    await this.database.collections.runs.updateOne({ _id: run._id }, { $set: { code } });
    return code;
  }

  private async commitAndSync(
    context: CodeRunContext,
    agent: AgentDoc,
    issue: IssueDoc,
    run: RunDoc,
    result: AdapterResult,
    code: RunCode,
    events: RunEventRecorder,
    redact: (text: string) => string,
  ): Promise<void> {
    try {
      const commit = await this.workspace.commitIssueWork(context.projectId, context.issueKey, {
        author: commitAuthor(agent, this.workspace.agentEmailDomain),
        message: redact(commitMessage(agent, issue, run, result)),
        base: context.base,
      });
      if (commit.rewritten) {
        events.record(
          'runner',
          `${context.branch} in the clone no longer contained the server tip ${short(context.base)}; the work tree was committed on top of it instead`,
        );
      }
      Object.assign(code, {
        head: commit.head,
        commit: commit.commit,
        agentCommits: commit.agentCommits,
        ...commit.stats,
      });
    } catch (error) {
      code.error = redact(`commit failed: ${errorText(error)}`);
      return;
    }
    await this.reconcileAndSync(context, agent, code, events, redact);
  }

  /**
   * Reconcile an existing clone before a run. A merge that lands while the reconciling merge is
   * written makes its compare-and-swap fail with 409; that is retried like after a run.
   */
  private async reconcileBeforeRun(
    projectId: string,
    issueKey: string,
    agent: Pick<AgentDoc, '_id' | 'name'> | null,
    events: RunEventRecorder,
  ): Promise<CloneReconcile> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.workspace.reconcileClone(projectId, issueKey, this.author(agent));
      } catch (error) {
        if (!isRefusal(error) || attempt >= SYNC_ATTEMPTS) throw error;
        events.record('runner', `cvx/${issueKey} moved while reconciling; trying again`);
      }
    }
  }

  /**
   * Bring the run's commit onto the server branch. An integration merge may move the branch from
   * the API process at any time, also between the check and the sync, so a refused fast-forward
   * or compare-and-swap (409) is retried after reconciling again, up to SYNC_ATTEMPTS times.
   */
  private async reconcileAndSync(
    context: CodeRunContext,
    agent: AgentDoc,
    code: RunCode,
    events: RunEventRecorder,
    redact: (text: string) => string,
  ): Promise<void> {
    let kept: string | null = null;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const server = await this.workspace.branchTip(context.projectId, context.issueKey);
        if (server !== context.base || attempt > 1) {
          const reconciled = await this.workspace.reconcileClone(
            context.projectId,
            context.issueKey,
            this.author(agent),
          );
          describeReconcile(reconciled, context.branch, events);
          if (reconciled.head) code.head = reconciled.head;
          if (reconciled.action === 'preserved') {
            kept = `the run's work conflicts with changes merged into ${context.branch} during the run; it was kept on branch ${reconciled.preservedBranch ?? ''} and ${context.branch} continues from the server tip`;
          } else if (reconciled.action === 'set_aside') {
            const branch = reconciled.preservedBranch
              ? `its commits were kept on branch ${reconciled.preservedBranch}, `
              : '';
            code.error = `the workspace could not be brought up to date with ${context.branch}, which was merged into during the run; ${branch}it was moved to ${reconciled.setAside ?? ''} and the next run clones the server branch`;
            return;
          }
        }
        await this.workspace.syncIssueBranch(context.projectId, context.issueKey, false);
        // A preserved run's commit is on its conflict branch, not on the issue branch.
        code.synced = kept === null;
        code.error = kept;
        return;
      } catch (error) {
        if (isRefusal(error) && attempt < SYNC_ATTEMPTS) {
          events.record('runner', `${context.branch} moved while syncing; reconciling again`);
          continue;
        }
        code.error = redact([kept, `sync failed: ${errorText(error)}`].filter(Boolean).join('; '));
        return;
      }
    }
  }
}

/** One run event for what reconciling a clone with its server branch did. */
function describeReconcile(result: CloneReconcile, branch: string, events: RunEventRecorder): void {
  for (const warning of result.warnings) events.record('runner', `workspace ${branch}: ${warning}`);
  if (result.action === 'none') return;
  const from = `${short(result.clone)} -> ${short(result.head)}`;
  if (result.action === 'fast_forward') {
    events.record('runner', `workspace ${branch} fast-forwarded to the server tip (${from})`);
  } else if (result.action === 'merged') {
    events.record(
      'runner',
      `workspace ${branch} merged with the server tip ${short(result.server)} (${from})`,
    );
  } else if (result.action === 'set_aside') {
    events.record(
      'runner',
      `workspace ${branch} held uncommitted work or files the server tip ${short(result.server)} would overwrite; it was moved to ${result.setAside ?? ''} (nothing deleted) and is cloned again from the server branch`,
    );
  } else {
    const files = (result.conflicts ?? []).map((file) => file.path).slice(0, 20);
    events.record(
      'runner',
      `workspace ${branch} conflicts with the server tip ${short(result.server)} in ${files.join(', ')}; its work was kept on ${result.preservedBranch ?? ''} and the workspace was reset to the server tip`,
    );
  }
}

/** A 409: the issue branch moved under a fast-forward or compare-and-swap. */
const isRefusal = (error: unknown): boolean =>
  error instanceof AppError && error.statusCode === 409;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
