import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Adapter, AdapterRunInput } from '../src/runner/adapters/types.js';
import { RunWorker } from '../src/runner/run-worker.js';
import { containedPath, materializeSkills, type MaterialSkill } from '../src/runner/skills.js';
import { createTestContext, type TestContext } from './helpers.js';
import { createFixture, type Fixture } from './scheduler-helpers.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

afterEach(() => vi.mocked(rename).mockReset());

const skill = (name: string, files: MaterialSkill['files'] = []): MaterialSkill => ({
  name,
  description: `Use ${name}`,
  body: `# ${name}\n`,
  files,
});

/** List every file below a directory as sorted relative paths. */
async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

describe('skill materialisation', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cvx-skills-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const workspace = async () => {
    const dir = join(root, new ObjectId().toHexString());
    await mkdir(dir);
    return dir;
  };

  it('writes SKILL.md with frontmatter and supporting files', async () => {
    const ws = await workspace();
    await materializeSkills(ws, [
      skill('review', [
        { path: 'checklist.md', content: '- [ ] tests' },
        { path: 'scripts/lint.sh', content: 'echo ok' },
      ]),
    ]);
    const skills = join(ws, '.claude', 'skills');
    expect(await tree(skills)).toEqual([
      'review/SKILL.md',
      'review/checklist.md',
      'review/scripts/lint.sh',
    ]);
    expect(await readFile(join(skills, 'review', 'SKILL.md'), 'utf8')).toBe(
      '---\nname: review\ndescription: "Use review"\n---\n\n# review\n',
    );
    expect(await readFile(join(skills, 'review', 'scripts', 'lint.sh'), 'utf8')).toBe('echo ok');
  });

  it('replaces stale skills and leaves the rest of .claude alone', async () => {
    const ws = await workspace();
    await materializeSkills(ws, [
      skill('old', [{ path: 'notes.md', content: 'x' }]),
      skill('kept'),
    ]);
    await writeFile(join(ws, '.claude', 'skills', 'agent-made.md'), 'stray');
    await writeFile(join(ws, '.claude', 'settings.local.json'), '{}');
    await materializeSkills(ws, [skill('kept'), skill('new')]);
    expect(await tree(join(ws, '.claude'))).toEqual([
      'settings.local.json',
      'skills/kept/SKILL.md',
      'skills/new/SKILL.md',
    ]);
    await materializeSkills(ws, []);
    expect(await readdir(join(ws, '.claude', 'skills'))).toEqual([]);
    expect((await readdir(join(ws, '.claude'))).sort()).toEqual(['settings.local.json', 'skills']);
  });

  it('re-validates names and paths at write time and keeps the previous set on failure', async () => {
    const ws = await workspace();
    await materializeSkills(ws, [skill('good')]);
    const bad: MaterialSkill[] = [
      skill('../escape'),
      skill('/abs'),
      skill('ok', [{ path: '../../outside.txt', content: 'x' }]),
      skill('ok', [{ path: '/tmp/outside.txt', content: 'x' }]),
      skill('ok', [{ path: 'SKILL.md', content: 'x' }]),
    ];
    for (const entry of bad) {
      await expect(materializeSkills(ws, [skill('fresh'), entry])).rejects.toThrow(/invalid/);
    }
    expect(await tree(ws)).toEqual(['.claude/skills/good/SKILL.md']);
    expect(await readdir(root)).not.toContain('outside.txt');
  });

  it('restores the previous skills when the staging rename fails', async () => {
    const ws = await workspace();
    await materializeSkills(ws, [skill('old')]);
    const originalRename = (
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    ).rename;
    const failure = new Error('staging rename failed');
    vi.mocked(rename).mockImplementationOnce(originalRename).mockRejectedValueOnce(failure);

    await expect(materializeSkills(ws, [skill('new')])).rejects.toBe(failure);
    expect(await tree(join(ws, '.claude'))).toEqual(['skills/old/SKILL.md']);
    expect(await readdir(join(ws, '.claude'))).toEqual(['skills']);
  });

  it('retains retired skills if restoration also fails and reports the swap failure', async () => {
    const ws = await workspace();
    await materializeSkills(ws, [skill('old')]);
    const originalRename = (
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    ).rename;
    const failure = new Error('staging rename failed');
    vi.mocked(rename)
      .mockImplementationOnce(originalRename)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(new Error('restore failed'));

    await expect(materializeSkills(ws, [skill('new')])).rejects.toBe(failure);
    const entries = await readdir(join(ws, '.claude'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^\.skills-retired-/);
    const retired = entries[0];
    if (!retired) throw new Error('expected retired skills');
    expect(await tree(join(ws, '.claude', retired))).toEqual(['old/SKILL.md']);
  });

  it('refuses to mount skills through a symlinked .claude directory', async () => {
    const ws = await workspace();
    const elsewhere = await workspace();
    await symlink(elsewhere, join(ws, '.claude'));
    await expect(materializeSkills(ws, [skill('x')])).rejects.toThrow(/not a directory/);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('replaces a symlinked skills directory instead of writing through it', async () => {
    const ws = await workspace();
    const elsewhere = await workspace();
    await mkdir(join(ws, '.claude'));
    await symlink(elsewhere, join(ws, '.claude', 'skills'));
    await materializeSkills(ws, [skill('x')]);
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await tree(join(ws, '.claude'))).toEqual(['skills/x/SKILL.md']);
  });

  it('confines resolved paths to their base directory', () => {
    expect(containedPath('/w/s', 'a/b.md')).toBe('/w/s/a/b.md');
    for (const path of ['..', '../x', 'a/../../x', '/etc/passwd', '', '.']) {
      expect(() => containedPath('/w/s', path), path).toThrow(/outside/);
    }
  });
});

describe('run worker skills', () => {
  let ctx: TestContext;
  let fx: Fixture;
  let workspaces: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    fx = await createFixture(ctx);
    workspaces = await mkdtemp(join(tmpdir(), 'cvx-ws-'));
  });

  afterAll(async () => {
    await rm(workspaces, { recursive: true, force: true });
    await ctx.close();
  });

  it('mounts exactly the agent skills into the workspace before the adapter runs', async () => {
    const created = await ctx.request({
      method: 'POST',
      url: '/api/skills',
      payload: {
        name: 'deploy-check',
        description: 'Check a deploy',
        body: 'Run the checks.',
        files: [{ path: 'ref/hosts.md', content: 'host-a' }],
      },
    });
    const agent = await fx.agent({ skillIds: [created.json().id] });
    const issue = await fx.issue({ title: 'ship it', assigneeAgentId: agent.id });
    await fx.scheduler.processPendingWakes();
    const run = await ctx.database.collections.runs.findOne({ issueId: new ObjectId(issue.id) });
    if (!run) throw new Error('expected a run');

    let seen: string[] = [];
    let skillMd = '';
    const adapter: Adapter = {
      run: async (input: AdapterRunInput) => {
        seen = await tree(join(input.workspace, '.claude', 'skills'));
        skillMd = await readFile(
          join(input.workspace, '.claude', 'skills', 'deploy-check', 'SKILL.md'),
          'utf8',
        );
        return { status: 'succeeded', costUsd: 0 };
      },
    };
    const worker = new RunWorker(ctx.database, fx.scheduler, {
      workspacesRoot: workspaces,
      mcpUrl: 'http://127.0.0.1:9/mcp',
      timeoutMs: 10_000,
      adapters: { claude_cli: adapter },
    });
    const result = await worker.process(run._id);
    expect(result?.status).toBe('succeeded');
    expect(seen).toEqual(['deploy-check/SKILL.md', 'deploy-check/ref/hosts.md']);
    expect(skillMd).toContain('name: deploy-check\ndescription: "Check a deploy"');
    const events = await ctx.database.collections.runEvents.find({ runId: run._id }).toArray();
    expect(events.map((event) => event.text)).toContain('skills: deploy-check');
  });
});
