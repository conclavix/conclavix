import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  DEFAULT_BRANCH,
  refSchema,
  repoPathSchema,
  type CommitSummary,
  type FileDiff,
} from '@conclavix/core';
import type { ObjectId } from 'mongodb';
import type { AgentDoc, Database } from '../../db.js';
import { AppError, notFound } from '../../errors.js';
import { agentDisabledInProject, projectAccessChecker } from '../projects/agent-access.js';
import { GitError } from '../workspace/git.js';
import { cutText } from '../workspace/parse.js';
import type { RepoReader } from '../workspace/reader.js';
import { guarded } from './results.js';
import type { RunScope } from './scope.js';

/**
 * Output bounds of the code tools, so one call cannot flood a run's context. The workspace limits
 * (1 MiB per file, 2 MiB per diff, 15 s per git call) apply underneath; these are tighter.
 */
export const CODE_TOOL_LIMITS = {
  /** Branches per list_branches page (the workspace lists the 200 newest at most). */
  maxBranches: 100,
  defaultBranches: 30,
  /** Files per get_branch_diff page with patches, and without (`withPatch: false`). */
  maxDiffFiles: 50,
  maxDiffFilesWithoutPatch: 300,
  defaultDiffFiles: 20,
  /** Patch text of one file, and of all files of one page. */
  maxFilePatchBytes: 20_000,
  maxPagePatchBytes: 60_000,
  /** Path filters of one get_branch_diff call. */
  maxDiffPaths: 20,
  /** Commits of the branch named in a get_branch_diff answer. */
  maxDiffCommits: 20,
  /** Lines and bytes of one read_file answer. */
  maxFileLines: 2000,
  defaultFileLines: 400,
  maxFileBytes: 60_000,
  /** Entries per list_files page. */
  maxTreeEntries: 500,
  defaultTreeEntries: 200,
  /** Commits per get_commit_log page. */
  maxCommits: 50,
  defaultCommits: 20,
  /** Characters of a commit subject. */
  maxSubjectChars: 200,
} as const;

const L = CODE_TOOL_LIMITS;

/** The names of the code tools, for the run prompt and tests. */
export const CODE_TOOL_NAMES = [
  'list_branches',
  'get_branch_diff',
  'read_file',
  'list_files',
  'get_commit_log',
] as const;

const offsetSchema = z.int().min(0).max(100_000).default(0);
const pathFilterSchema = repoPathSchema.refine((value) => value !== '', 'must not be empty');

const subject = (text: string): string =>
  text.length > L.maxSubjectChars ? `${text.slice(0, L.maxSubjectChars - 3)}...` : text;

const commitLine = (commit: CommitSummary) => ({
  sha: commit.sha,
  shortSha: commit.shortSha,
  subject: subject(commit.subject),
  authorName: commit.authorName,
  committedAt: commit.committedAt,
});

/** One page of `items` from `offset`, with the offset of the next page or null at the end. */
function page<T>(items: T[], offset: number, limit: number) {
  const end = offset + limit;
  return {
    total: items.length,
    items: items.slice(offset, end),
    nextOffset: end < items.length ? end : null,
  };
}

/** A git failure becomes a tool error without git's own message or stderr. */
export async function gitGuarded(work: () => Promise<unknown>, what = 'reading the repository') {
  return guarded(async () => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GitError) {
        const message =
          error.reason === 'timeout' || error.reason === 'output_limit'
            ? `${what} hit a time or size limit; narrow the request`
            : `${what} failed`;
        throw new AppError(502, 'repository_unavailable', message, { reason: error.reason });
      }
      throw error;
    }
  });
}

interface PatchedFile {
  path: string;
  oldPath: string | null;
  status: FileDiff['status'];
  binary: boolean;
  additions: number;
  deletions: number;
  patch?: string | null;
  patchTruncated?: boolean;
}

const fileSummary = (file: FileDiff): PatchedFile => ({
  path: file.path,
  oldPath: file.oldPath,
  status: file.status,
  binary: file.binary,
  additions: file.additions,
  deletions: file.deletions,
});

/**
 * A page of diff files with their patches, cut to the per-file limit. The page ends early once
 * the patch text of the page would pass its limit; the first file always fits.
 */
function patchPage(files: FileDiff[], offset: number, limit: number) {
  const items: PatchedFile[] = [];
  let bytes = 0;
  let index = offset;
  for (; index < files.length && items.length < limit; index += 1) {
    const file = files[index] as FileDiff;
    let patch = file.patch;
    let cut = file.truncated;
    if (patch !== null) {
      const trimmed = cutText(patch, L.maxFilePatchBytes);
      if (trimmed.cut) {
        patch = `${trimmed.text}\n[conclavix: patch cut at ${L.maxFilePatchBytes} bytes; use read_file for the rest]`;
        cut = true;
      }
    } else if (file.truncated) {
      patch = '[conclavix: patch past the diff size limit; use read_file or a paths filter]';
    }
    const size = Buffer.byteLength(patch ?? '', 'utf8');
    if (items.length > 0 && bytes + size > L.maxPagePatchBytes) break;
    bytes += size;
    items.push({ ...fileSummary(file), patch, patchTruncated: cut });
  }
  return { items, nextOffset: index < files.length ? index : null };
}

/** A page of diff files without patch text. */
function summaryPage(files: FileDiff[], offset: number, limit: number) {
  const plain = page(files, offset, limit);
  return { items: plain.items.map(fileSummary), nextOffset: plain.nextOffset };
}

interface LineWindow {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  nextStartLine: number | null;
}

/** Lines `startLine` to `startLine + maxLines - 1` of `text`, cut at the byte limit. */
function lineWindow(text: string, startLine: number, maxLines: number): LineWindow {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const totalLines = lines.length;
  if (startLine > Math.max(totalLines, 1)) {
    throw new AppError(
      400,
      'invalid_range',
      `startLine ${startLine} is past the end of the file (${totalLines} lines)`,
    );
  }
  const picked: string[] = [];
  let bytes = 0;
  let line = startLine;
  for (; line <= totalLines && picked.length < maxLines; line += 1) {
    const value = lines[line - 1] ?? '';
    const size = Buffer.byteLength(value, 'utf8') + 1;
    if (picked.length > 0 && bytes + size > L.maxFileBytes) break;
    if (picked.length === 0) {
      const cut = cutText(value, L.maxFileBytes);
      picked.push(cut.cut ? `${cut.text} [conclavix: line cut at ${L.maxFileBytes} bytes]` : value);
    } else {
      picked.push(value);
    }
    bytes += size;
  }
  return {
    content: picked.join('\n'),
    startLine,
    endLine: startLine + picked.length - 1,
    totalLines,
    nextStartLine: line <= totalLines ? line : null,
  };
}

interface DiffInput {
  branch: string;
  base: string;
  paths: string[];
  withPatch: boolean;
  offset: number;
  limit: number;
}

/** One page of the diff of `branch` against its merge base with `base`. */
async function branchDiff(reader: RepoReader, id: string, input: DiffInput) {
  const { branch, base, paths, withPatch, offset, limit } = input;
  if (withPatch && limit > L.maxDiffFiles) {
    throw new AppError(
      400,
      'invalid_limit',
      `limit is at most ${L.maxDiffFiles} with patches; use withPatch=false for longer lists`,
    );
  }
  const [baseRef, headRef] = await Promise.all([
    reader.resolveRef(id, base),
    reader.resolveRef(id, branch),
  ]);
  const comparison = await reader.compareCommits(id, baseRef, headRef, { paths });
  const { files } = comparison.diff;
  const filesPage = withPatch ? patchPage(files, offset, limit) : summaryPage(files, offset, limit);
  return {
    base: comparison.base,
    branch: comparison.head,
    baseSha: comparison.baseSha,
    headSha: comparison.headSha,
    mergeBase: comparison.mergeBase,
    ahead: comparison.ahead,
    behind: comparison.behind,
    commits: comparison.commits.slice(0, L.maxDiffCommits).map(commitLine),
    moreCommits: Math.max(0, comparison.ahead - L.maxDiffCommits),
    totalFiles: files.length,
    diffIncomplete: comparison.diff.truncated,
    offset,
    nextOffset: filesPage.nextOffset,
    files: filesPage.items,
  };
}

interface CodeToolContext {
  server: McpServer;
  reader: RepoReader;
  /** The run's project id, once the agent is checked against the project's agent access. */
  projectId: () => Promise<string>;
}

/** Branches with ahead/behind against main, and the history of a ref. */
function registerBranchTools({ server, reader, projectId }: CodeToolContext): void {
  server.registerTool(
    'list_branches',
    {
      description:
        "List the branches of your project's repository (read-only): main first, then the most " +
        'recently committed, each with commits ahead of and behind main and its last commit. ' +
        'Issue branches are cvx/<ISSUE-KEY>. Paginated with offset/nextOffset.',
      inputSchema: {
        offset: offsetSchema,
        limit: z.int().min(1).max(L.maxBranches).default(L.defaultBranches),
      },
    },
    async ({ offset, limit }) =>
      gitGuarded(async () => {
        const branches = await reader.listBranches(await projectId());
        const result = page(branches, offset, limit);
        return {
          ...result,
          items: result.items.map((branch) => ({
            name: branch.name,
            isDefault: branch.isDefault,
            issueKey: branch.issueKey,
            ahead: branch.ahead,
            behind: branch.behind,
            lastCommit: {
              sha: branch.lastCommit.sha,
              subject: subject(branch.lastCommit.subject),
              authorName: branch.lastCommit.authorName,
              committedAt: branch.lastCommit.committedAt,
            },
          })),
        };
      }),
  );

  server.registerTool(
    'get_commit_log',
    {
      description:
        "The history of a branch or commit in your project's repository (read-only), newest " +
        'first. Paginated with skip/nextSkip.',
      inputSchema: {
        ref: refSchema.default(DEFAULT_BRANCH).describe('Branch or commit'),
        skip: z.int().min(0).max(100_000).default(0),
        limit: z.int().min(1).max(L.maxCommits).default(L.defaultCommits),
      },
    },
    async ({ ref, skip, limit }) =>
      gitGuarded(async () => {
        const history = await reader.log(await projectId(), { ref, skip, limit });
        return { ref, items: history.items.map(commitLine), nextSkip: history.nextSkip };
      }),
  );
}

/** The diff of a branch against main or another base, like a pull request. */
function registerDiffTool({ server, reader, projectId }: CodeToolContext): void {
  server.registerTool(
    'get_branch_diff',
    {
      description:
        'Show what a branch changes, like a pull request (read-only): the diff from its merge base ' +
        `with base (default ${DEFAULT_BRANCH}) to the branch, as unified diff hunks per file. ` +
        'branch and base are branch names or commit ids. Paginated by file with offset/nextOffset; ' +
        `a page holds at most ${L.maxPagePatchBytes} bytes of patch text and one file at most ` +
        `${L.maxFilePatchBytes} (patchTruncated marks a cut). Binary files have no patch. Use ` +
        'withPatch=false for a cheap list of all changed files, and paths to restrict it to files ' +
        'or directories.',
      inputSchema: {
        branch: refSchema.describe('Branch or commit to review, e.g. cvx/CVX-12'),
        base: refSchema.default(DEFAULT_BRANCH).describe('Branch or commit to compare against'),
        paths: z
          .array(pathFilterSchema)
          .max(L.maxDiffPaths)
          .default([])
          .describe('Only these files or directories, repository-relative'),
        withPatch: z.boolean().default(true),
        offset: offsetSchema,
        limit: z
          .int()
          .min(1)
          .max(L.maxDiffFilesWithoutPatch)
          .default(L.defaultDiffFiles)
          .describe(
            `Files per page: up to ${L.maxDiffFiles} with patches, ${L.maxDiffFilesWithoutPatch} without`,
          ),
      },
    },
    async ({ branch, base, paths, withPatch, offset, limit }) =>
      gitGuarded(async () =>
        branchDiff(reader, await projectId(), { branch, base, paths, withPatch, offset, limit }),
      ),
  );
}

/** Files and directories at a ref. */
function registerFileTools({ server, reader, projectId }: CodeToolContext): void {
  server.registerTool(
    'read_file',
    {
      description:
        "Read a file of your project's repository at a branch or commit (read-only). Returns at " +
        `most ${L.maxFileLines} lines and ${L.maxFileBytes} bytes from startLine; continue with ` +
        'nextStartLine. Binary files and files over 1 MiB have no content.',
      inputSchema: {
        path: pathFilterSchema.describe('Repository-relative file path'),
        ref: refSchema.default(DEFAULT_BRANCH).describe('Branch or commit'),
        startLine: z.int().min(1).default(1),
        maxLines: z.int().min(1).max(L.maxFileLines).default(L.defaultFileLines),
      },
    },
    async ({ path, ref, startLine, maxLines }) =>
      gitGuarded(async () => {
        const file = await reader.file(await projectId(), ref, path);
        const head = {
          ref: file.ref,
          sha: file.sha,
          path: file.path,
          size: file.size,
          binary: file.binary,
          tooLarge: file.tooLarge,
        };
        if (file.content === null) return { ...head, content: null };
        return { ...head, ...lineWindow(file.content, startLine, maxLines) };
      }),
  );

  server.registerTool(
    'list_files',
    {
      description:
        "List one directory of your project's repository at a branch or commit (read-only): " +
        'files (blob, with size), directories (tree) and submodules (commit). Omit path for the ' +
        'repository root. Paginated with offset/nextOffset.',
      inputSchema: {
        path: repoPathSchema
          .default('')
          .describe('Repository-relative directory; empty is the root'),
        ref: refSchema.default(DEFAULT_BRANCH).describe('Branch or commit'),
        offset: offsetSchema,
        limit: z.int().min(1).max(L.maxTreeEntries).default(L.defaultTreeEntries),
      },
    },
    async ({ path, ref, offset, limit }) =>
      gitGuarded(async () => {
        const tree = await reader.tree(await projectId(), ref, path);
        const result = page(tree.entries, offset, limit);
        return {
          ref: tree.ref,
          sha: tree.sha,
          path: tree.path,
          ...result,
          items: result.items.map((entry) => ({
            path: entry.path,
            type: entry.type,
            size: entry.size,
          })),
        };
      }),
  );
}

/**
 * Read-only access to the code of the run's project: branches, branch diffs, files, directories
 * and history from the project's bare repository. Every call is limited to the project of the
 * run's issue and to agents enabled in it; refs and paths go through the workspace reader's
 * validation. Available to every agent, with or without code access.
 */
export function registerCodeTools(
  server: McpServer,
  database: Database,
  scope: RunScope,
  reader: RepoReader,
): void {
  registerProjectCodeTools(
    server,
    database,
    { agent: scope.agent, projectId: scope.issue.projectId },
    reader,
  );
}

/** The code tools bound to one project and agent; chat runs use them for a referenced project. */
export function registerProjectCodeTools(
  server: McpServer,
  database: Database,
  target: { agent: AgentDoc; projectId: ObjectId },
  reader: RepoReader,
): void {
  const { collections } = database;
  const projectId = async (): Promise<string> => {
    const { project, isEnabled } = await projectAccessChecker(collections, target.projectId);
    if (!project) throw notFound('Project');
    if (!isEnabled(target.agent)) throw agentDisabledInProject(target.agent, project);
    return project._id.toHexString();
  };
  const context: CodeToolContext = { server, reader, projectId };
  registerBranchTools(context);
  registerDiffTool(context);
  registerFileTools(context);
}
