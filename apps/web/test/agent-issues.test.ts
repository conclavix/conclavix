import { describe, expect, it } from 'vitest';
import { isWakeable, sortTasks } from '../src/agents/issues';
import type { Issue } from '../src/api/types';

const issue = (key: string, status: string, updatedAt: string): Issue => ({
  id: key,
  key,
  projectId: 'p',
  title: key,
  description: '',
  status,
  priority: 'medium',
  parentId: null,
  assigneeAgentId: 'a',
  checkoutRunId: null,
  updatedAt,
});

describe('agent tasks', () => {
  it('only offers a wake for issues the API accepts', () => {
    expect(isWakeable({ status: 'todo' })).toBe(true);
    expect(isWakeable({ status: 'in_progress' })).toBe(true);
    expect(isWakeable({ status: 'in_review' })).toBe(false);
    expect(isWakeable({ status: 'backlog' })).toBe(false);
  });

  it('lists work in progress first and newest first within a status', () => {
    const sorted = sortTasks([
      issue('A-1', 'done', '2026-01-03'),
      issue('A-2', 'todo', '2026-01-01'),
      issue('A-3', 'todo', '2026-01-02'),
      issue('A-4', 'in_progress', '2026-01-01'),
      issue('A-5', 'backlog', '2026-01-05'),
    ]);
    expect(sorted.map((item) => item.key)).toEqual(['A-4', 'A-3', 'A-2', 'A-5', 'A-1']);
  });
});
