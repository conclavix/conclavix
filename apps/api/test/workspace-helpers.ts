import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const IDENTITY = [
  '-c',
  'user.name=Test Agent',
  '-c',
  'user.email=agent@example.com',
  '-c',
  'commit.gpgsign=false',
];

/** A fresh temporary directory; `cleanup` removes it with fs.rm. */
export function tempRoot(prefix = 'cvx-workspace-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Plain git in `cwd`, standing in for an agent working in its clone. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

/** Stage everything in `cwd` and commit it. */
export function commitAll(cwd: string, message: string): string {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '--quiet', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** File names and contents of a ZIP buffer, read from its central directory. */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const offset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (offset < 0) throw new Error('no end of central directory');
  const count = zip.readUInt16LE(offset + 10);
  let cursor = zip.readUInt32LE(offset + 16);
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central directory');
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
