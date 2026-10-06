import { describe, expect, it } from 'vitest';
import {
  createSkillSchema,
  isSafeSkillFilePath,
  renderSkillMarkdown,
  skillNameSchema,
  updateSkillSchema,
} from '../src/domain/skill.js';

const valid = { name: 'code-review', description: 'Review a diff' };

describe('skill schema', () => {
  it('accepts slugs and rejects names that are not safe directory names', () => {
    for (const name of ['a', 'code-review', 'v2-api', 'x'.repeat(64)]) {
      expect(skillNameSchema.safeParse(name).success).toBe(true);
    }
    for (const name of [
      '',
      '..',
      '.hidden',
      'a/b',
      'a\\b',
      '/abs',
      'Upper',
      'a--b',
      '-a',
      'a-',
      'a b',
      'a.b',
      'x'.repeat(65),
    ]) {
      expect(skillNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it('accepts nested relative file paths', () => {
    for (const path of ['reference.md', 'scripts/run.sh', 'a/b/c/d.txt', 'docs/v1.2_notes-x.md']) {
      expect(isSafeSkillFilePath(path), path).toBe(true);
    }
  });

  it('rejects traversal, absolute, hidden, odd and reserved file paths', () => {
    for (const path of [
      '',
      '..',
      '../x',
      'a/../../x',
      'a/..',
      'a..b/c',
      '/etc/passwd',
      './x',
      'a//b',
      'a/',
      '.env',
      'a/.git/config',
      'a\\b',
      'C:/x',
      'a b',
      'a/b/c/d/e',
      'SKILL.md',
      'skill.MD',
      'x'.repeat(201),
      'na\u0000me',
    ]) {
      expect(isSafeSkillFilePath(path), JSON.stringify(path)).toBe(false);
    }
  });

  it('rejects duplicate and nested file paths case-insensitively', () => {
    const files = (...paths: string[]) => ({
      ...valid,
      files: paths.map((path) => ({ path, content: '' })),
    });
    expect(createSkillSchema.safeParse(files('a.md', 'b/a.md')).success).toBe(true);
    expect(createSkillSchema.safeParse(files('a.md', 'A.md')).success).toBe(false);
    expect(createSkillSchema.safeParse(files('docs', 'docs/a.md')).success).toBe(false);
    expect(createSkillSchema.safeParse(files('docs/a.md', 'Docs')).success).toBe(false);
  });

  it('bounds file count and sizes', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.md`, content: '' }));
    expect(createSkillSchema.safeParse({ ...valid, files: many }).success).toBe(false);
    const big = Array.from({ length: 6 }, (_, i) => ({
      path: `f${i}.md`,
      content: 'x'.repeat(99_000),
    }));
    expect(createSkillSchema.safeParse({ ...valid, files: big }).success).toBe(false);
    const huge = [{ path: 'a.md', content: 'x'.repeat(100_001) }];
    expect(createSkillSchema.safeParse({ ...valid, files: huge }).success).toBe(false);
  });

  it('requires a single-line description and a body without frontmatter', () => {
    expect(createSkillSchema.parse(valid)).toEqual({ ...valid, body: '', files: [] });
    expect(createSkillSchema.safeParse({ ...valid, description: 'a\nname: x' }).success).toBe(
      false,
    );
    expect(createSkillSchema.safeParse({ ...valid, description: ' ' }).success).toBe(false);
    expect(createSkillSchema.safeParse({ ...valid, body: '---\nname: x\n---\n' }).success).toBe(
      false,
    );
    expect(createSkillSchema.safeParse({ ...valid, body: '# Title\n\n---\n' }).success).toBe(true);
    expect(createSkillSchema.safeParse({ ...valid, owner: 'x' }).success).toBe(false);
    expect(updateSkillSchema.safeParse({}).success).toBe(false);
  });

  it('renders frontmatter that cannot be broken out of by the description', () => {
    const markdown = renderSkillMarkdown({
      name: 'x',
      description: 'Use when "quoted": yes # not a comment',
      body: '# Steps\n\n1. do it\n\n\n',
    });
    expect(markdown).toBe(
      '---\nname: x\ndescription: "Use when \\"quoted\\": yes # not a comment"\n---\n\n# Steps\n\n1. do it\n',
    );
    expect(renderSkillMarkdown({ name: 'y', description: 'd', body: '' })).toBe(
      '---\nname: y\ndescription: "d"\n---\n',
    );
  });
});
