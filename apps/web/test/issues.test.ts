import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import type { IssueDetail } from '../src/api/types';
import {
  BOARD_COLUMNS,
  columnFor,
  conflictRevision,
  describeError,
  groupByColumn,
  issuePatch,
  statusTitle,
  toIssueForm,
  wakesAgent,
} from '../src/issues';

const issue: IssueDetail = {
  id: 'i1',
  key: 'CVX-1',
  projectId: 'p1',
  title: 'Title',
  description: 'Body',
  status: 'todo',
  priority: 'medium',
  parentId: null,
  assigneeAgentId: null,
  checkoutRunId: null,
  updatedAt: '',
  blockedBy: ['b1', 'b2'],
  labels: ['ui'],
  closedAt: null,
};

describe('board columns', () => {
  it('has a display title for every status, cancelled included', () => {
    expect(BOARD_COLUMNS.map((column) => column.title)).toEqual([
      'Backlog',
      'To do',
      'In progress',
      'In review',
      'Done',
      'Cancelled',
    ]);
    expect(statusTitle('in_progress')).toBe('In progress');
    expect(statusTitle('something_new')).toBe('something_new');
  });

  it('places an issue in its explicit column, else the first column of its status', () => {
    const columns = [
      { id: 'triage', title: 'Triage', status: 'todo' },
      { id: 'ready', title: 'Ready', status: 'todo' },
      { id: 'doing', title: 'Doing', status: 'in_progress' },
    ];
    expect(columnFor({ status: 'todo', columnId: 'ready' }, columns)?.id).toBe('ready');
    expect(columnFor({ status: 'todo' }, columns)?.id).toBe('triage');
    expect(columnFor({ status: 'todo', columnId: 'gone' }, columns)?.id).toBe('triage');
    expect(columnFor({ status: 'done' }, columns)).toBeUndefined();
  });

  it('groups issues per column, newest first, with empty columns present', () => {
    const groups = groupByColumn(
      [
        { id: 'a', status: 'done' },
        { id: 'c', status: 'done' },
        { id: 'b', status: 'cancelled' },
      ],
      BOARD_COLUMNS,
    );
    expect(groups['done']?.map((i) => i.id)).toEqual(['c', 'a']);
    expect(groups['cancelled']?.map((i) => i.id)).toEqual(['b']);
    expect(groups['todo']).toEqual([]);
  });
});

describe('issue patch', () => {
  it('is empty when nothing changed, ignoring blocker order', () => {
    const form = toIssueForm(issue);
    form.blockedBy = ['b2', 'b1'];
    expect(issuePatch(issue, form)).toEqual({});
  });

  it('contains only changed fields with trimmed title and cleaned labels', () => {
    const form = toIssueForm(issue);
    form.title = '  New title ';
    form.assigneeAgentId = 'a1';
    form.blockedBy = ['b1'];
    form.labels = ['ui', ' api ', '', 'api'];
    expect(issuePatch(issue, form)).toEqual({
      title: 'New title',
      assigneeAgentId: 'a1',
      blockedBy: ['b1'],
      labels: ['ui', 'api'],
    });
  });

  it('detects which assignment changes wake an agent', () => {
    expect(wakesAgent(null, 'a1')).toBe(true);
    expect(wakesAgent('a1', 'a2')).toBe(true);
    expect(wakesAgent('a1', 'a1')).toBe(false);
    expect(wakesAgent('a1', null)).toBe(false);
    expect(wakesAgent('a1', undefined)).toBe(false);
  });
});

describe('api errors', () => {
  it('includes validation details in the message', () => {
    const error = new ApiError('Invalid request', 400, 'invalid_request', [
      { path: 'title', message: 'Too small' },
    ]);
    expect(describeError(error)).toBe('Invalid request (title: Too small)');
    expect(describeError(new ApiError('blockedBy would create a dependency cycle', 422))).toBe(
      'blockedBy would create a dependency cycle',
    );
  });

  it('recognises document write conflicts and their current revision', () => {
    expect(conflictRevision(new ApiError('stale', 409, 'conflict', { currentRevision: 3 }))).toBe(
      3,
    );
    expect(conflictRevision(new ApiError('x', 409, 'conflict', { currentRevision: null }))).toBe(
      null,
    );
    expect(conflictRevision(new ApiError('x', 422))).toBeUndefined();
    expect(conflictRevision(new Error('x'))).toBeUndefined();
  });
});
