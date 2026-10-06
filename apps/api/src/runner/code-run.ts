import type { RunCode } from '@conclavix/core';
import type { AgentDoc, Database, IssueDoc, RunDoc } from '../db.js';
import type { AuditLog } from '../modules/audit/audit.js';
import type { CodeWorkspace } from '../modules/workspace/commit.js';
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

const SUBJECT_LENGTH = 72;
const BODY_LENGTH = 4000;

const short = (sha: string | null): string => (sha ? sha.slice(0, 12) : 'none');

/** One line of plain text: control characters become spaces. */
const oneLine = (text: string): string =>
  text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
export function commitAuthor(agent: Pick<AgentDoc, '_id' | 'name'>) {
  return {
    name: `Conclavix ${oneLine(agent.name)}`,
    email: `agent-${agent._id.toHexString()}@conclavix.invalid`,
  };
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

  /** Make sure the issue has its clone and branch, and note the branch tip the run starts from. */
  async prepare(
    issue: IssueDoc,
    skillsDir: string | null,
    events: RunEventRecorder,
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
    const base = await this.workspace.branchTip(projectId, issue.key);
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
        author: commitAuthor(agent),
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
    try {
      await this.workspace.syncIssueBranch(context.projectId, context.issueKey, false);
      code.synced = true;
    } catch (error) {
      code.error = redact(`sync failed: ${errorText(error)}`);
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
