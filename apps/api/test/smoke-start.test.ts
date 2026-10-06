import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const fixtures: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Run the real harness against disposable processes and a controllable MongoDB client. */
async function runSmoke(overrides: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'smoke-test-'));
  fixtures.push(root);
  const scratch = join(root, 'tmp');
  for (const path of ['scripts', 'bin', 'apps/api/dist', 'apps/api/node_modules/mongodb', 'tmp']) {
    await mkdir(join(root, path), { recursive: true });
  }
  await copyFile(
    new URL('../../../scripts/smoke-start.sh', import.meta.url),
    join(root, 'scripts/smoke-start.sh'),
  );
  await writeFile(
    join(root, 'bin/node'),
    `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$FIXTURE_ROOT/argv"
exec "$REAL_NODE" "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(root, 'bin/curl'),
    `#!/usr/bin/env bash
if [ -f "$FIXTURE_ROOT/ready" ]; then printf 200; else printf 503; fi
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(root, 'apps/api/node_modules/mongodb/package.json'),
    JSON.stringify({ type: 'module', exports: './index.js' }),
  );
  await writeFile(
    join(root, 'apps/api/node_modules/mongodb/index.js'),
    `
import { appendFileSync } from 'node:fs';
export class MongoClient {
  constructor(uri) { appendFileSync(process.env.FIXTURE_ROOT + '/cleanup', uri + '\\n'); }
  db() { return { dropDatabase: async () => {
    if (process.env.FAIL_DROP === '1') throw new Error('synthetic drop failure');
  } }; }
  async close() { appendFileSync(process.env.FIXTURE_ROOT + '/cleanup', 'closed\\n'); }
}
`,
  );
  for (const entry of ['server', 'scheduler-main', 'runner-main']) {
    await writeFile(
      join(root, `apps/api/dist/${entry}.js`),
      `
const fs = require('node:fs');
if (process.env.FAIL_START === '1') process.exit(7);
process.once('SIGTERM', () => process.exit(0));
fs.writeFileSync(process.env.FIXTURE_ROOT + '/ready', String(process.pid));
console.log(JSON.stringify({ msg: '${entry.replace('-main', '')} started' }));
setInterval(() => {}, 1000);
`,
    );
  }
  const child = spawn('bash', [join(root, 'scripts/smoke-start.sh')], {
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env['PATH']}`,
      REAL_NODE: process.execPath,
      FIXTURE_ROOT: root,
      TMPDIR: scratch,
      SMOKE_ALIVE_SECONDS: '0',
      SMOKE_START_TIMEOUT_SECONDS: '3',
      SMOKE_STOP_TIMEOUT_SECONDS: '3',
      ...overrides,
    },
  });
  children.push(child);
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    output += data.toString();
  });
  const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
  return { root, scratch, child, done };
}

it('keeps MongoDB credentials out of argv and removes temporary resources on success', async () => {
  const run = await runSmoke({
    SMOKE_MONGO_URI: 'mongodb://smoke-user:synthetic-password@127.0.0.1:27088/old?authSource=admin',
  });
  expect(await run.done).toMatchObject({ code: 0 });
  const argv = await readFile(join(run.root, 'argv'), 'utf8');
  expect(argv).not.toContain('synthetic-password');
  expect(argv).not.toContain('mongodb://');
  const cleanup = await readFile(join(run.root, 'cleanup'), 'utf8');
  expect(cleanup).toMatch(
    /^mongodb:\/\/smoke-user:synthetic-password@127\.0\.0\.1:27088\/conclavix_smoke_\d+_\d+\?authSource=admin\nclosed\n$/,
  );
  expect(await readdir(run.scratch)).toEqual([]);
}, 10_000);

it('fails when database cleanup fails after successful service checks', async () => {
  const run = await runSmoke({ FAIL_DROP: '1' });
  const result = await run.done;
  expect(result.code).toBe(1);
  expect(result.output).toContain('smoke: ok runner');
  expect(result.output).toContain('could not drop database');
  expect(await readdir(run.scratch)).toEqual([]);
}, 10_000);

it('retains a startup failure when database cleanup also fails', async () => {
  const run = await runSmoke({ FAIL_DROP: '1', FAIL_START: '1' });
  const result = await run.done;
  expect(result.code).toBe(1);
  expect(result.output).toContain('api exited during startup with code 7');
  expect(result.output).toContain('could not drop database');
  expect(await readdir(run.scratch)).toEqual([]);
});

it.each([
  ['SIGTERM', 143],
  ['SIGINT', 130],
] as const)(
  'cleans up on %s and preserves its status when database cleanup fails',
  async (signal, code) => {
    const run = await runSmoke({ FAIL_DROP: '1', SMOKE_ALIVE_SECONDS: '1' });
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number(await readFile(join(run.root, 'ready'), 'utf8'));
    });
    run.child.kill(signal);
    const result = await run.done;
    expect(result.code).toBe(code);
    expect(result.output).toContain('could not drop database');
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readdir(run.scratch)).toEqual([]);
  },
);
