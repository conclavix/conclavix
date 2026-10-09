import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  DEFAULT_BRANCH,
  ISSUE_BRANCH_PREFIX,
  commitIdSchema,
  issueKeySchema,
  refSchema,
} from '@conclavix/core';
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
import { MAX_SQUASH_PATHS } from '../workspace/squash.js';
import { gitGuarded } from './code-tools.js';
import { forbidden, type RunScope } from './scope.js';

/** The names of the git integration tools, for the run prompt and tests. */
export const GIT_TOOL_NAMES = [
  'merge_branches',
  'fast_forward_main',
  'get_merge_status',
  'set_branch',
] as const;

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

/** A branch name or a full or abbreviated commit id (7 to 64 lowercase hex digits). */
const commitishSchema = refSchema;

/** Issue branches main may be fast-forwarded to a commit of (a commit id given as source). */
const RELEASABLE_FROM = [`refs/heads/${ISSUE_BRANCH_PREFIX}`];

/** Levels walked up the parentId chain for the branch scope; the issue tree's limit. */
const MAX_SCOPE_DEPTH = 20;

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
 * The branch scope of the writing tools (merge_branches target, set_branch). Walking up the
 * parentId chain from `issue` (the issue itself first, at most MAX_SCOPE_DEPTH levels), some issue
 * on the chain must be the run's own issue or assigned to the calling agent, or be a direct
 * sub-issue of the issue the run's own issue was delegated from (`delegatedFromIssueId`). So the
 * agent writes the branches of its own issue, of issues assigned to it, of their sub-issues at
 * any depth, and of the issues its delegator handed out from the same issue (its siblings in the
 * delegation) with their sub-issues; never the delegator's own branch or other trees.
 */
async function inBranchScope(
  { database, scope }: GitToolContext,
  issue: IssueDoc,
): Promise<boolean> {
  const delegatedFrom = scope.issue.delegatedFromIssueId ?? null;
  let current: Pick<IssueDoc, '_id' | 'parentId' | 'assigneeAgentId'> | null = issue;
  for (let depth = 0; current && depth <= MAX_SCOPE_DEPTH; depth += 1) {
    if (current._id.equals(scope.issue._id)) return true;
    if (current.assigneeAgentId?.equals(scope.agent._id)) return true;
    if (delegatedFrom && current.parentId?.equals(delegatedFrom)) return true;
    current = current.parentId
      ? await database.collections.issues.findOne(
          { _id: current.parentId },
          { projection: { parentId: 1, assigneeAgentId: 1 } },
        )
      : null;
  }
  return false;
}

/**
 * The issue behind an issue branch, in the run's project. With `scoped`, the branch must also be
 * in the branch scope of the run (see inBranchScope).
 */
async function issueOfBranch(
  context: GitToolContext,
  branch: string,
  scoped: boolean,
): Promise<IssueDoc> {
  const { database, scope } = context;
  const issue = await database.collections.issues.findOne({ key: keyOf(branch) });
  if (!issue || !issue.projectId.equals(scope.issue.projectId)) {
    throw forbidden(`${branch} is not the branch of an issue in the project of this run`);
  }
  if (scoped && !(await inBranchScope(context, issue))) {
    throw forbidden(
      `${branch} belongs to an issue that is not assigned to you and not below your issue, an issue assigned to you or the issue yours was delegated from`,
    );
  }
  return issue;
}

const actorOf = (scope: RunScope) => ({
  type: 'agent' as const,
  agentId: scope.agent._id.toHexString(),
  name: scope.agent.name,
});

interface MergeInput {
  target: string;
  sources: string[];
  base?: string | undefined;
  message?: string | undefined;
  squash: boolean;
  paths?: string[] | undefined;
}

/** Run merge_branches: no-ff merges, or one squash commit; audits a moved branch. */
async function runMerge(context: GitToolContext, input: MergeInput) {
  const { scope, workspace, audit } = context;
  if (input.paths && !input.squash) {
    throw new AppError(400, 'invalid_paths', 'paths limits a squash; set squash: true');
  }
  const projectId = await checkedProject(context);
  const issue = await issueOfBranch(context, input.target, true);
  const common = {
    sources: input.sources,
    ...(input.base ? { base: input.base } : {}),
    author: agentIdentity(scope.agent, workspace.agentEmailDomain),
    trailers: [
      `Conclavix-Issue: ${issue.key}`,
      `Conclavix-Run: ${scope.run._id.toHexString()}`,
      `Conclavix-Agent: ${oneLine(scope.agent.name)}`,
    ],
  };
  const merge = input.squash
    ? await workspace.squashIntoIssueBranch(projectId, issue.key, {
        ...common,
        message: input.message ?? '',
        ...(input.paths ? { paths: input.paths } : {}),
      })
    : await workspace.mergeIntoIssueBranch(projectId, issue.key, {
        ...common,
        ...(input.message ? { message: input.message } : {}),
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
        ...(input.squash ? { squash: true, paths: input.paths ?? null } : {}),
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
}

function registerMergeTool(context: GitToolContext): void {
  context.server.registerTool(
    'merge_branches',
    {
      description:
        'Merge branches of your project into an issue branch on the server (git integration ' +
        `permission). target: ${ISSUE_BRANCH_PREFIX}<KEY> of your own issue, of an issue assigned ` +
        'to you, of a sub-issue below either, or of an issue delegated from the same issue as ' +
        'yours. sources: existing branches, merged in order, each with its own ' +
        'merge commit by you (no fast-forward); sources the target already contains are skipped. ' +
        'squash: true instead adds ONE commit on the target tip with the merged tree of all ' +
        'sources (sources do not become parents) and your message as the whole commit message ' +
        '(subject line up to 100 characters; Conclavix-* trailers are added for you); paths ' +
        '(squash only) refuses with out_of_scope if anything outside those directories changes. ' +
        `A missing target is created from base (default ${DEFAULT_BRANCH}; a branch or a commit ` +
        'id on a branch); base is ignored when the target exists. On the first conflict nothing changes and the answer lists the ' +
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
        base: commitishSchema
          .optional()
          .describe(
            `Branch or commit id (e.g. 9f8f98c) a missing target is created from; default ${DEFAULT_BRANCH}`,
          ),
        message: z
          .string()
          .max(MAX_MERGE_MESSAGE)
          .optional()
          .describe(
            'Without squash: body of each merge commit, below the generated subject. With squash ' +
              '(required): the commit message, e.g. "feat(feedback): add the Feedback module"',
          ),
        squash: z
          .boolean()
          .default(false)
          .describe('One commit with the merged tree on the target tip instead of merge commits'),
        paths: z
          .array(z.string().min(1).max(200))
          .min(1)
          .max(MAX_SQUASH_PATHS)
          .optional()
          .describe('Squash only: directories the change must stay in, e.g. ["modules/feedback"]'),
      },
    },
    async (input) => gitGuarded(() => runMerge(context, input), 'merging'),
  );
}

function registerFastForwardTool(context: GitToolContext): void {
  const { server, scope, workspace, audit } = context;
  server.registerTool(
    'fast_forward_main',
    {
      description:
        `Move ${DEFAULT_BRANCH} of your project's repository forward to an issue branch that has ` +
        'passed review, or to an exact released commit of one (a commit id, full or at least 7 ' +
        `hex digits, contained in some ${ISSUE_BRANCH_PREFIX}<KEY> branch; later commits on that ` +
        'branch are not promoted). Git integration permission. Only a fast-forward: the source must contain ' +
        `every commit of ${DEFAULT_BRANCH}, otherwise nothing changes and you get not_fast_forward ` +
        `(merge ${DEFAULT_BRANCH} into the branch with merge_branches, have it reviewed again, ` +
        'then retry). This is the server repository only; nothing is pushed to external remotes.',
      inputSchema: {
        source: z
          .union([issueBranchSchema, commitIdSchema])
          .describe(`Reviewed issue branch (e.g. ${ISSUE_BRANCH_PREFIX}CVX-17) or commit id`),
      },
    },
    async ({ source }) =>
      gitGuarded(async () => {
        const projectId = await checkedProject(context);
        const isCommit = commitIdSchema.safeParse(source).success;
        if (!isCommit) await issueOfBranch(context, source, false);
        const result = await workspace.fastForwardBranch(
          projectId,
          DEFAULT_BRANCH,
          source,
          RELEASABLE_FROM,
        );
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
        'which files a merge would conflict in. A missing target is previewed from base. With ' +
        'squash: true also whether all sources merge one after the other and which files (count ' +
        'and top-level directories) a squash would change.',
      inputSchema: {
        target: branchSchema.describe(`Branch to inspect, e.g. ${ISSUE_BRANCH_PREFIX}CVX-17`),
        sources: z.array(branchSchema).max(MAX_MERGE_SOURCES).default([]),
        base: commitishSchema.default(DEFAULT_BRANCH),
        squash: z.boolean().default(false).describe('Also preview a squash of all sources'),
      },
    },
    async ({ target, sources, base, squash }) =>
      gitGuarded(async () => {
        const projectId = await checkedProject(context);
        return workspace.mergeStatus(projectId, target, sources, base, { squash });
      }),
  );
}

function registerSetBranchTool(context: GitToolContext): void {
  const { server, scope, workspace, audit } = context;
  server.registerTool(
    'set_branch',
    {
      description:
        `Point an issue branch ${ISSUE_BRANCH_PREFIX}<KEY> at a commit on the server (git ` +
        'integration permission): the replacement for git reset in a working copy, which agents ' +
        'must not use. Same branches as merge_branches targets; never main. commit: a branch or a ' +
        'commit id (full or at least 7 hex digits) reachable from a branch or backup ref of this ' +
        'project. A missing branch is created; an existing one only moves forward unless ' +
        'allowRewind is true: then a move that drops commits is made too and the old head is kept ' +
        'as backupRef (refs/backup/...), which set_branch can restore. The next run on that issue ' +
        'starts from the new tip; a working copy that still holds dropped commits is set aside ' +
        'and cloned again, never merged back. Rewinding your own issue branch keeps the work of ' +
        'this run on a conflict branch instead of committing it onto the branch.',
      inputSchema: {
        branch: issueBranchSchema.describe(
          `Issue branch to set, e.g. ${ISSUE_BRANCH_PREFIX}CVX-17`,
        ),
        commit: commitishSchema.describe('Commit id (e.g. c42fcd0) or branch to point it at'),
        allowRewind: z
          .boolean()
          .default(false)
          .describe('Allow a move that drops commits from the branch (they are backed up)'),
      },
    },
    async ({ branch, commit, allowRewind }) =>
      gitGuarded(async () => {
        const projectId = await checkedProject(context);
        const issue = await issueOfBranch(context, branch, true);
        const result = await workspace.setIssueBranch(projectId, issue.key, {
          commit,
          allowRewind,
        });
        if (result.status !== 'up_to_date') {
          await audit.record({
            action: 'branch.set',
            actor: actorOf(scope),
            details: {
              projectId,
              runId: scope.run._id.toHexString(),
              issueKey: scope.issue.key,
              branch: result.branch,
              requested: result.requested,
              status: result.status,
              before: result.before,
              after: result.after,
              dropped: result.dropped,
              backupRef: result.backupRef,
            },
          });
        }
        return result;
      }, 'setting the branch'),
  );
}

/**
 * Git integration for agents with the `gitIntegration` permission: merging branches into an issue
 * branch, setting an issue branch to a commit, fast-forwarding main and a read-only preview. Everything runs on the project's bare
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
  registerSetBranchTool(context);
}
