import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDoc, Database, IssueDoc, RunDoc } from '../src/db.js';
import type { AuditLog } from '../src/modules/audit/audit.js';
import { CodeWorkspace } from '../src/modules/workspace/commit.js';
import { CodeRuns } from '../src/runner/code-run.js';
import type { OrgPosition } from '../src/modules/org/position.js';
import type { RunEventRecorder } from '../src/runner/events.js';
import { CLONE_GIT_HINT, GIT_INTEGRATION_HINT, buildPrompt } from '../src/runner/prompt.js';
import { commitAll, git, tempRoot } from './workspace-helpers.js';

const PROJECT = 'dddddddddddddddddddddddd';
const ISSUE = 'APP-31';
const BRANCH = `cvx/${ISSUE}`;
const sandbox = { result: 'success', exitCode: 0, diskBytes: 0 };

describe('rewound branches and the HEAD guard', () => {
  let root: { dir: string; cleanup: () => void };
  let ws: CodeWorkspace;
  let clone: string;
  let counter = 0;

  function pushTo(from: string, target: string, files: Record<string, string>): string {
    counter += 1;
    const dir = join(root.dir, `helper-${counter}`);
    git(root.dir, 'clone', '--quiet', '--branch', from, ws.repoDir(PROJECT), dir);
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
    commitAll(dir, `change ${target}`);
    git(dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${target}`);
    return git(dir, 'rev-parse', 'HEAD');
  }

  const server = () => git(root.dir, `--git-dir=${ws.repoDir(PROJECT)}`, 'rev-parse', BRANCH);
  const head = () => git(clone, 'rev-parse', 'HEAD');
  const read = (path: string) => readFileSync(join(clone, path), 'utf8');
  const staleDirs = () => readdirSync(dirname(clone)).filter((name) => name.startsWith('.stale-'));

  /** CodeRuns on the real workspace with a stand-in database that records system comments. */
  function runner() {
    const comments: { body: string }[] = [];
    const database = {
      inTransaction: vi.fn(async () => false),
      collections: {
        runs: { updateOne: vi.fn().mockResolvedValue(undefined) },
        comments: { insertOne: vi.fn(async (doc: { body: string }) => comments.push(doc)) },
      },
    } as unknown as Database;
    const runs = new CodeRuns(database, {} as AuditLog, ws);
    const events = { record: vi.fn() } as unknown as RunEventRecorder;
    const agent = { _id: new ObjectId(), name: 'Builder' } as AgentDoc;
    const issue = {
      _id: new ObjectId(),
      projectId: new ObjectId(PROJECT),
      key: ISSUE,
      title: 'Build',
    } as IssueDoc;
    const finish = (context: Awaited<ReturnType<CodeRuns['prepare']>>) =>
      runs.finish(
        context,
        agent,
        issue,
        { _id: new ObjectId() } as RunDoc,
        { status: 'succeeded', costUsd: 0, summary: 'Work', sandbox },
        events,
        (text) => text,
      );
    const prepare = () => runs.prepare(issue, null, events, agent);
    return { prepare, finish, comments, events };
  }

  let first: string;
  let second: string;

  beforeEach(async () => {
    root = tempRoot('cvx-head-guard-');
    ws = new CodeWorkspace(join(root.dir, 'ws'));
    await ws.ensureRepo(PROJECT);
    pushTo('main', 'main', { 'shared.txt': 'one\n' });
    first = pushTo('main', BRANCH, { 'a.txt': 'a1\n' });
    second = pushTo(BRANCH, BRANCH, { 'a.txt': 'a2\n', 'b.txt': 'b\n' });
    await ws.createIssueWorkspace(PROJECT, ISSUE);
    clone = ws.issueWorkspaceDir(PROJECT, ISSUE);
  });

  afterEach(() => root.cleanup());

  it('sets a clone that still holds a rewound head aside instead of merging it back', async () => {
    expect(head()).toBe(second);
    const rewind = await ws.setIssueBranch(PROJECT, ISSUE, { commit: first, allowRewind: true });
    expect(rewind).toMatchObject({ status: 'rewound', before: second, after: first });
    const result = await ws.reconcileClone(PROJECT, ISSUE, {
      name: 'Conclavix',
      email: 'c@example.com',
    });
    expect(result).toMatchObject({ action: 'set_aside', rewound: second });
    expect(result.preservedBranch).toBeUndefined();
    expect(server()).toBe(first);
    expect(staleDirs()).toHaveLength(1);
  });

  it('starts the next run in a fresh clone of the rewound branch', async () => {
    const { prepare, finish } = runner();
    await ws.setIssueBranch(PROJECT, ISSUE, { commit: first, allowRewind: true });
    const context = await prepare();
    expect(context.base).toBe(first);
    expect(head()).toBe(first);
    expect(read('a.txt')).toBe('a1\n');
    expect(existsSync(join(clone, 'b.txt'))).toBe(false);
    writeFileSync(join(clone, 'c.txt'), 'c\n');
    const code = await finish(context);
    expect(code).toMatchObject({ synced: true, error: null });
    expect(git(clone, 'rev-parse', 'HEAD~1')).toBe(first);
    expect(server()).toBe(head());
  });

  it('keeps work of a run whose branch was rewound meanwhile off the branch', async () => {
    const { prepare, finish } = runner();
    const context = await prepare();
    writeFileSync(join(clone, 'c.txt'), 'c\n');
    await ws.setIssueBranch(PROJECT, ISSUE, { commit: first, allowRewind: true });
    const code = await finish(context);
    expect(code.synced).toBe(false);
    expect(code.error).toMatch(/moved to/);
    expect(server()).toBe(first);
    const kept = git(
      root.dir,
      `--git-dir=${ws.repoDir(PROJECT)}`,
      'for-each-ref',
      'refs/heads/conflict',
    );
    expect(kept).toContain(`conflict/${ISSUE}/`);
  });

  it('refuses a sync that would bring a rewound head back, also after a run commit', async () => {
    writeFileSync(join(clone, 'c.txt'), 'c\n');
    commitAll(clone, 'run commit on the old head');
    await ws.setIssueBranch(PROJECT, ISSUE, { commit: first, allowRewind: true });
    await expect(ws.syncIssueBranch(PROJECT, ISSUE, false)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/rewound away from/),
    });
    expect(server()).toBe(first);
    const bareRefs = git(root.dir, `--git-dir=${ws.repoDir(PROJECT)}`, 'for-each-ref');
    expect(bareRefs).not.toContain('refs/conclavix/');
    const forced = await ws.syncIssueBranch(PROJECT, ISSUE, true);
    expect(forced).toMatchObject({ updated: true, forced: true, after: head() });
  });

  it('commits nothing after the agent ran git reset --mixed, and sets the clone aside', async () => {
    const { prepare, finish, comments } = runner();
    const context = await prepare();
    // A failed hard reset left half of the old tree behind, then a mixed reset moved HEAD.
    writeFileSync(join(clone, 'a.txt'), 'a1\n');
    git(clone, 'reset', '--quiet', '--mixed', first);
    const code = await finish(context);
    expect(code.commit).toBeNull();
    expect(code.synced).toBe(false);
    expect(code.error).toMatch(/moved HEAD/);
    expect(code.error).toMatch(/reset: moving to/);
    expect(server()).toBe(second);
    expect(staleDirs()).toHaveLength(1);
    expect(existsSync(clone)).toBe(false);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toMatch(/Nothing from the last run was committed/);
    expect(comments[0]?.body).toMatch(/set_branch/);
  });

  it('notices a HEAD moved away and back, a detached HEAD and another branch', async () => {
    const moves: ((dir: string) => void)[] = [
      (dir) => {
        git(dir, 'reset', '--quiet', '--mixed', first);
        git(dir, 'reset', '--quiet', '--soft', second);
      },
      (dir) => git(dir, 'checkout', '--quiet', '--detach'),
      (dir) => git(dir, 'checkout', '--quiet', '-b', 'scratch'),
    ];
    for (const move of moves) {
      const { prepare, finish } = runner();
      const context = await prepare();
      move(clone);
      writeFileSync(join(clone, 'd.txt'), 'd\n');
      const code = await finish(context);
      expect(code.commit, String(move)).toBeNull();
      expect(code.error, String(move)).toMatch(/moved HEAD/);
      expect(server()).toBe(second);
    }
    expect(staleDirs()).toHaveLength(3);
  });

  it('leaves normal runs and commits the agent made itself alone', async () => {
    const { prepare, finish, comments } = runner();
    const context = await prepare();
    writeFileSync(join(clone, 'own.txt'), 'own commit\n');
    commitAll(clone, 'agent commit');
    writeFileSync(join(clone, 'work.txt'), 'work\n');
    const code = await finish(context);
    expect(code).toMatchObject({ synced: true, error: null, agentCommits: 1 });
    expect(code.commit).not.toBeNull();
    expect(server()).toBe(head());
    expect(comments).toHaveLength(0);
    expect(staleDirs()).toHaveLength(0);

    const next = await prepare();
    expect(next.start.tip).toBe(head());
    expect(await finish(next)).toMatchObject({ synced: true, error: null, commit: null });
  });
});

describe('run prompt for git in the working copy', () => {
  const position: OrgPosition = {
    isLead: false,
    delegators: [],
    delegates: [],
    delegatesNotInProject: [],
    reportsTo: [],
    notifications: [],
  };
  const agent = { _id: new ObjectId(), name: 'Builder', role: 'engineer' } as AgentDoc;
  const issue = { key: 'APP-31', title: 'Build' } as IssueDoc;

  it('tells coding runs to leave git to the runner and integrators about set_branch', () => {
    const coding = buildPrompt(agent, issue, 'assigned', position, { code: true });
    expect(coding).toContain(CLONE_GIT_HINT.join('\n'));
    expect(coding).toContain('$TMPDIR');
    expect(buildPrompt(agent, issue, 'assigned', position)).not.toContain('git reset');
    const integrating = buildPrompt(agent, issue, 'assigned', position, { git: true });
    expect(integrating).toContain('set_branch');
    expect(integrating).toContain(GIT_INTEGRATION_HINT.join('\n'));
  });
});
