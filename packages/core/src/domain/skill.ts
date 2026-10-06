import { z } from 'zod';
import type { SkillProvenance } from './skill-source.js';

export const SKILL_LIMITS = {
  nameLength: 64,
  descriptionLength: 1024,
  bodyLength: 100_000,
  files: 20,
  fileLength: 100_000,
  totalLength: 500_000,
  pathLength: 200,
  pathDepth: 4,
} as const;

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when the text contains a C0 control character other than tab, or DEL. */
const hasControlChars = (value: string): boolean =>
  [...value].some((char) => {
    const code = char.charCodeAt(0);
    return (code < 0x20 && code !== 0x09) || code === 0x7f;
  });

/** A skill name doubles as its directory name in a run workspace, so it is a strict slug. */
export const skillNameSchema = z
  .string()
  .max(SKILL_LIMITS.nameLength)
  .regex(SKILL_NAME, 'must be lowercase letters, digits and single hyphens');

/** True when a relative file path stays inside its skill directory and is safe on every platform. */
export function isSafeSkillFilePath(path: string): boolean {
  if (path.length === 0 || path.length > SKILL_LIMITS.pathLength) {
    return false;
  }
  const segments = path.split('/');
  return (
    segments.length <= SKILL_LIMITS.pathDepth &&
    segments.every((segment) => PATH_SEGMENT.test(segment) && !segment.includes('..')) &&
    path.toLowerCase() !== 'skill.md'
  );
}

export const skillFilePathSchema = z
  .string()
  .refine(
    isSafeSkillFilePath,
    'must be a relative path of up to 4 segments of letters, digits, dot, dash or underscore, not SKILL.md',
  );

export const skillFileSchema = z.strictObject({
  path: skillFilePathSchema,
  content: z.string().max(SKILL_LIMITS.fileLength),
});

const descriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(SKILL_LIMITS.descriptionLength)
  .refine((value) => !hasControlChars(value), 'must be a single line');

const bodySchema = z
  .string()
  .max(SKILL_LIMITS.bodyLength)
  .refine(
    (value) => !/^\s*---\s*(\r?\n|$)/.test(value),
    'must not start with YAML frontmatter; name and description are separate fields',
  );

const filesSchema = z
  .array(skillFileSchema)
  .max(SKILL_LIMITS.files)
  .superRefine((files, ctx) => {
    const seen = new Set<string>();
    for (const [index, file] of files.entries()) {
      const key = file.path.toLowerCase();
      const clashes = [...seen].some(
        (other) => other === key || other.startsWith(`${key}/`) || key.startsWith(`${other}/`),
      );
      if (clashes) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicates or nests inside another file path',
          path: [index, 'path'],
        });
      }
      seen.add(key);
    }
    const total = files.reduce((sum, file) => sum + file.content.length, 0);
    if (total > SKILL_LIMITS.totalLength) {
      ctx.addIssue({ code: 'custom', message: `files exceed ${SKILL_LIMITS.totalLength} chars` });
    }
  });

export const createSkillSchema = z.strictObject({
  name: skillNameSchema,
  description: descriptionSchema,
  body: bodySchema.default(''),
  files: filesSchema.default([]),
});

export const updateSkillSchema = z
  .strictObject({
    name: skillNameSchema,
    description: descriptionSchema,
    body: bodySchema,
    files: filesSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export type SkillFile = z.infer<typeof skillFileSchema>;
export type CreateSkillInput = z.infer<typeof createSkillSchema>;
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>;

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  files: SkillFile[];
  /** Set when the skill was imported from an external directory. */
  source: SkillProvenance | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  fileCount: number;
  /** The directory provider the skill was imported from, if any. */
  sourceProvider?: string | null;
  updatedAt: Date;
}

/** Render the SKILL.md that Claude Code discovers: generated frontmatter followed by the body. */
export function renderSkillMarkdown(skill: Pick<Skill, 'name' | 'description' | 'body'>): string {
  const frontmatter = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n`;
  return skill.body.length > 0
    ? `${frontmatter}\n${skill.body.replace(/\n*$/, '\n')}`
    : frontmatter;
}
