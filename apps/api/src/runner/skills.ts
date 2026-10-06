import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ObjectId } from 'mongodb';
import {
  isSafeSkillFilePath,
  renderSkillMarkdown,
  skillNameSchema,
  type SkillFile,
} from '@conclavix/core';
import type { Collections } from '../db.js';

export interface MaterialSkill {
  name: string;
  description: string;
  body: string;
  files: SkillFile[];
}

/** Resolve a relative path under a base directory, refusing anything that would escape it. */
export function containedPath(base: string, path: string): string {
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing to write outside ${base}: ${path}`);
  }
  return target;
}

/** Stat a path without following links, returning null only when it does not exist. */
const lstatOrNull = (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

/** Raise unless the path is absent or a real directory, so a planted symlink cannot redirect writes. */
async function assertRealDirectoryOrAbsent(path: string): Promise<void> {
  const stat = await lstatOrNull(path);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new Error(`${path} is not a directory; refusing to mount skills through it`);
  }
}

/** Write one skill directory, re-validating its name and every file path at write time. */
async function writeSkill(root: string, skill: MaterialSkill): Promise<void> {
  if (!skillNameSchema.safeParse(skill.name).success) {
    throw new Error(`invalid skill name ${JSON.stringify(skill.name)}`);
  }
  const dir = containedPath(root, skill.name);
  await mkdir(dir);
  await writeFile(join(dir, 'SKILL.md'), renderSkillMarkdown(skill), { flag: 'wx' });
  for (const file of skill.files) {
    if (!isSafeSkillFilePath(file.path)) {
      throw new Error(`invalid file path ${JSON.stringify(file.path)} in skill ${skill.name}`);
    }
    const target = containedPath(dir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, { flag: 'wx' });
  }
}

/**
 * Replace `<workspace>/.claude/skills` with exactly the given skills.
 * The new tree is staged next to the old one and swapped in, so a failure leaves no partial set.
 */
export async function materializeSkills(workspace: string, skills: MaterialSkill[]): Promise<void> {
  const claudeDir = join(workspace, '.claude');
  const skillsDir = join(claudeDir, 'skills');
  await assertRealDirectoryOrAbsent(claudeDir);
  await mkdir(claudeDir, { recursive: true });
  const suffix = randomBytes(6).toString('hex');
  const staging = join(claudeDir, `.skills-staging-${suffix}`);
  const retired = join(claudeDir, `.skills-retired-${suffix}`);
  await mkdir(staging);
  try {
    for (const skill of skills) {
      await writeSkill(staging, skill);
    }
    const existing = await lstatOrNull(skillsDir);
    if (existing) {
      await rename(skillsDir, retired);
    }
    try {
      await rename(staging, skillsDir);
    } catch (error) {
      if (existing) {
        // If restoration also fails, retain the retired tree for recovery.
        await rename(retired, skillsDir).catch(() => {});
      }
      throw error;
    }
  } catch (error) {
    // Cleanup must not hide the original failure or delete the previous skills.
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await rm(staging, { recursive: true, force: true });
  await rm(retired, { recursive: true, force: true });
}

/** Load the agent's assigned skills in name order; IDs of since-deleted skills are ignored. */
export async function loadAgentSkills(
  collections: Collections,
  skillIds: ObjectId[] | undefined,
): Promise<MaterialSkill[]> {
  if (!skillIds || skillIds.length === 0) {
    return [];
  }
  return collections.skills
    .find(
      { _id: { $in: skillIds } },
      { projection: { _id: 0, name: 1, description: 1, body: 1, files: 1 } },
    )
    .sort({ name: 1 })
    .toArray();
}
