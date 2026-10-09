import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_BRANCH, ISSUE_BRANCH_PREFIX, issueKeySchema, refSchema } from '@conclavix/core';
import type { Database, IssueDoc } from '../../db.js';
import { AppError, notFound } from '../../errors.js';
import type { AuditLog } from '../audit/audit.js';
import { agentDisabledInProject, projectAccessChecker } from '../projects/agent-access.js';
import {
  MAX_MERGE_MESSAGE,
  MAX_MERGE_SOURCES,
  agentIdentity,
  oneLine,
} from '../workspace/merge.js';
import type { Workspace } from '../workspace/service.js';
import { gitGuarded } from './code-tools.js';
import { forbidden, type RunScope } from './scope.js';

/** The names of the git integration tools, for the run prompt and tests. */
export const GIT_TOOL_NAMES = ['merge_branches', 'fast_forward_main', 'get_merge_status'] as const;

const branchSchema = refSchema.refine((value) => !/^[0-9a-f]{7,64}$/.test(value), {
  message: 'must be a branch name, not a commit id',
});

const issueBranchSchema = z
  .string()
  .refine(
    (value) =>
      value.startsWith(ISSUE_BRANCH_PREFIX) &&
      issueKeySchema.safeParse(value.slice(ISSUE_BRANCH_PREFIX.length)).success,
    { message: `must be an issue branch ${ISSUE_BRANCH_PREFIX}<ISSUE-KEY>` },
  );

const keyOf = (branch: string): string => branch.slice(ISSUE_BRANCH_PREFIX.length);

interface GitToolContext {
  server: McpServer;
  database: Database;
  scope: RunScope;
  workspace: Workspace;
  audit: AuditLog;
}

/**
 * The project of the run, after checking on every call that the agent is still enabled in it and
 * still holds the git integration permission (it may be revoked while the run is going).
 */
async function checkedProject({ database, scope }: GitToolContext): Promise<string> {
  const { collections } = database;
  const agent = await collections.agents.findOne(
    { _id: scope.agent._id },
    { projection: { gitIntegration: 1 } },
  );
  if (agent?.gitIntegration !== true) {
    throw new AppError(403, 'git_integration_disabled', 'this agent may not integrate branches');
  }
  const { project, isEnabled } = await projectAccessChecker(collections, scope.issue.projectId);
  if (!project) throw notFound('Project');
  if (!isEnabled(scope.agent)) throw agentDisabledInProject(scope.agent, project);
  return project._id.toHexString();
}

/**
 * The issue behind an issue branch, in the run's project. With `assigned`, the issue must also be
 * the run's own issue or one assigned to the calling agent.
 */
async function issueOfBranch(
  { database, scope }: GitToolContext,
  branch: string,
  assigned: boolean,
): Promise<IssueDoc> {
  const issue = await database.collections.issues.findOne({ key: keyOf(branch) });
  if (!issue || !issue.projectId.equals(scope.issue.projectId)) {
    throw forbidden(`${branch} is not the branch of an issue in the project of this run`);
  }
  const own = issue._id.equals(scope.issue._id);
  if (assigned && !own && !issue.assigneeAgentId?.equals(scope.agent._id)) {
    throw forbidden(
      `${branch} belongs to an issue that is not assigned to you; merge only into ${ISSUE_BRANCH_PREFIX}${scope.issue.key} or the branch of an issue assigned to you`,
    );
  }
  return issue;
}

const actorOf = (scope: RunScope) => ({
  type: 'agent' as const,
  agentId: scope.agent._id.toHexString(),
  name: scope.agent.name,
});

function registerMergeTool(context: GitToolContext): void {
  const { server, scope, workspace, audit } = context;
  server.registerTool(
    'merge_branches',
    {
      description:
        'Merge branches of your project into an issue branch on the server (git integration ' +
        `permission). target: ${ISSUE_BRANCH_PREFIX}<KEY> of your own issue or of an issue in this ` +
        'project assigned to you. sources: existing branches, merged in order, each with its own ' +
        'merge commit by you (no fast-forward); sources the target already contains are skipped. ' +
        `A missing target is created from base (default ${DEFAULT_BRANCH}); base is ignored when ` +
        'the target exists. On the first conflict nothing changes and the answer lists the ' +
        'conflicting files: resolve them on one of the branches and merge again. Merging into ' +
        "your own issue's branch does not change your working copy in this run: the runner merges " +
        'it with your work after the run, and your next run starts from the result, so merge ' +
        'before you edit files that the sources also change.',
      inputSchema: {
        target: issueBranchSchema.describe(
          `Issue branch to merge into, e.g. ${ISSUE_BRANCH_PREFIX}CVX-17`,
        ),
        sources: z
          .array(branchSchema)
          .min(1)
          .max(MAX_MERGE_SOURCES)
          .describe('Branches to merge, in this order, e.g. ["cvx/CVX-10", "cvx/CVX-11"]'),
        base: branchSchema
          .optional()
          .describe(`Branch a missing target is created from; default ${DEFAULT_BRANCH}`),
        message: z
          .string()
          .max(MAX_MERGE_MESSAGE)
          .optional()
          .describe('Body of each merge commit, below the generated subject'),
      },
    },
    async ({ target, sources, base, message }) =>
      gitGuarded(async () => {
        const projectId = await checkedProject(context);
        const issue = await issueOfBranch(context, target, true);
        const merge = await workspace.mergeIntoIssueBranch(projectId, issue.key, {
          sources,
          ...(base ? { base } : {}),
          ...(message ? { message } : {}),
          author: agentIdentity(scope.agent, workspace.agentEmailDomain),
          trailers: [
            `Conclavix-Issue: ${issue.key}`,
            `Conclavix-Run: ${scope.run._id.toHexString()}`,
            `Conclavix-Agent: ${oneLine(scope.agent.name)}`,
          ],
        });
        if (merge.before !== merge.after) {
          await audit.record({
            action: 'branch.merged',
            actor: actorOf(scope),
            details: {
              projectId,
              runId: scope.run._id.toHexString(),
              issueKey: scope.issue.key,
              target: merge.target,
              created: merge.created,
              before: merge.before,
              after: merge.after,
              sources: merge.merges.map((step) => step.source),
            },
          });
        }
        const own = issue._id.equals(scope.issue._id);
        return {
          ...merge,
          workingCopy: own
            ? 'your working copy in this run does not contain the merge; the runner merges it with your work after the run, and your next run starts from it'
            : 'the next run on that issue starts from the merged branch',
        };
      }, 'merging'),
  );
}

function registerFastForwardTool(context: GitToolContext): void {
  const { server, scope, workspace, audit } = context;
  server.registerTool(
    'fast_forward_main',
    {
      description:
        `Move ${DEFAULT_BRANCH} of your project's repository forward to an issue branch that has ` +
        `passed review (git integration permission). Only a fast-forward: the source must contain ` +
        `every commit of ${DEFAULT_BRANCH}, otherwise nothing changes and you get not_fast_forward ` +
        `(merge ${DEFAULT_BRANCH} into the branch with merge_branches, have it reviewed again, ` +
        'then retry). This is the server repository only; nothing is pushed to external remotes.',
      inputSchema: {
        source: issueBranchSchema.describe(
          `Reviewed issue branch, e.g. ${ISSUE_BRANCH_PREFIX}CVX-17`,
        ),
      },
    },
    async ({ source }) =>
      gitGuarded(async () => {
        const projectId = await checkedProject(context);
        await issueOfBranch(context, source, false);
        const result = await workspace.fastForwardBranch(projectId, DEFAULT_BRANCH, source);
        if (result.status === 'fast_forwarded') {
          await audit.record({
            action: 'branch.main_fast_forwarded',
            actor: actorOf(scope),
            details: {
              projectId,
              runId: scope.run._id.toHexString(),
              issueKey: scope.issue.key,
              branch: result.branch,
              source: result.source,
              before: result.before,
              after: result.after,
              commits: result.commits,
            },
          });
        }
        return result;
      }, 'updating main'),
  );
}

function registerStatusTool(context: GitToolContext): void {
  const { server, workspace } = context;
  server.registerTool(
    'get_merge_status',
    {
      description:
        'Preview an integration without changing anything (git integration permission): the ' +
        `target branch against ${DEFAULT_BRANCH} (ahead/behind, whether ${DEFAULT_BRANCH} can be ` +
        'fast-forwarded to it) and, for each source, whether the target already contains it and ' +
        'which files a merge would conflict in. A missing target is previewed from base.',
      inputSchema: {
        target: branchSchema.describe(`Branch to inspect, e.g. ${ISSUE_BRANCH_PREFIX}CVX-17`),
        sources: z.array(branchSchema).max(MAX_MERGE_SOURCES).default([]),
        base: branchSchema.default(DEFAULT_BRANCH),
      },
    },
    async ({ target, sources, base }) =>
      gitGuarded(async () => {
        const projectId = await checkedProject(context);
        return workspace.mergeStatus(projectId, target, sources, base);
      }),
  );
}

/**
 * Git integration for agents with the `gitIntegration` permission: merging branches into an issue
 * branch, fast-forwarding main and a read-only preview. Everything runs on the project's bare
 * repository in the API process, never inside a sandbox or an issue clone. Changes are audited
 * with the agent as actor.
 */
export function registerGitTools(
  server: McpServer,
  database: Database,
  scope: RunScope,
  workspace: Workspace,
  audit: AuditLog,
): void {
  const context: GitToolContext = { server, database, scope, workspace, audit };
  registerMergeTool(context);
  registerFastForwardTool(context);
  registerStatusTool(context);
}
