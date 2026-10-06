import { describe, expect, it } from 'vitest';
import type { RunEventData, RunLogLine } from '../src/api/types';
import { buildRunView, inputSummary, itemsForTab, toolLabel } from '../src/stores/run-view';
import { runsQuery } from '../src/stores/runs-query';

let seq = 0;
const line = (type: string, text: string, data?: RunEventData): RunLogLine => {
  seq += 1;
  return { seq, type, text, at: '2026-10-03T07:45:00.000Z', ...(data ? { data } : {}) };
};

const structured: RunLogLine[] = [
  line('runner', 'starting claude_cli for CVX-5'),
  line('system', 'session started; mcp: conclavix=connected', {
    kind: 'init',
    model: 'claude-sonnet-4-6',
    cwd: '/srv/ws',
    permissionMode: 'bypassPermissions',
    claudeCodeVersion: '2.1.138',
    tools: ['Bash', 'mcp__conclavix__get_issue'],
    toolsOmitted: 0,
    mcpServers: [{ name: 'conclavix', status: 'connected' }],
  }),
  line('system', 'api retry 1/10: overloaded', {
    kind: 'api_retry',
    attempt: 1,
    maxRetries: 10,
    error: 'overloaded',
  }),
  line('assistant', '(thinking) check memory', { kind: 'thinking', thinking: 'check memory' }),
  line('tool_use', 'mcp__conclavix__memory_search {"query":"x"}', {
    kind: 'tool_use',
    toolUseId: 'toolu_1',
    name: 'mcp__conclavix__memory_search',
    input: '{\n  "query": "x"\n}',
  }),
  line('tool_use', 'mcp__conclavix__set_status {"status":"shipped"}', {
    kind: 'tool_use',
    toolUseId: 'toolu_2',
    name: 'mcp__conclavix__set_status',
    input: '{\n  "status": "shipped"\n}',
  }),
  line('tool_result', 'error toolu_2 bad status', {
    kind: 'tool_result',
    toolUseId: 'toolu_2',
    content: 'bad status',
    isError: true,
  }),
  line('tool_result', 'ok toolu_1 found', {
    kind: 'tool_result',
    toolUseId: 'toolu_1',
    content: 'found',
    isError: false,
  }),
  line('assistant', 'Done **here**', { kind: 'text', markdown: 'Done **here**' }),
  line('stderr', 'warning: something'),
  line('result', 'success: Done', {
    kind: 'result',
    subtype: 'success',
    isError: false,
    numTurns: 3,
    durationMs: 12000,
    totalCostUsd: 0.3,
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
    },
    result: 'Done',
  }),
  line('runner', 'finished: succeeded, cost 0.3000 USD'),
];

describe('run view', () => {
  const view = buildRunView(structured);

  it('links tool results to their calls by id, whatever the order', () => {
    const tools = view.items.filter((item) => item.kind === 'tool');
    expect(tools.map((tool) => [tool.name, tool.result?.content, tool.result?.isError])).toEqual([
      ['mcp__conclavix__memory_search', 'found', false],
      ['mcp__conclavix__set_status', 'bad status', true],
    ]);
    expect(view.items.some((item) => item.kind === 'line' && item.type === 'tool_result')).toBe(
      false,
    );
  });

  it('counts items per filter tab', () => {
    expect(view.counts).toEqual({ assistant: 2, tools: 2, result: 1, system: 2, runner: 3 });
  });

  it('keeps stderr out of the chat but in the runner tab', () => {
    const chat = itemsForTab(view.items, 'chat');
    expect(chat.some((item) => item.kind === 'line' && item.type === 'stderr')).toBe(false);
    expect(
      itemsForTab(view.items, 'runner').map((item) => item.kind === 'line' && item.type),
    ).toEqual(['runner', 'stderr', 'runner']);
    expect(itemsForTab(view.items, 'result')[0]).toMatchObject({ kind: 'result', numTurns: 3 });
  });

  it('renders runs recorded before structured data from their text', () => {
    const legacy = buildRunView([
      line('system', 'session started; mcp: conclavix=connected, other=failed'),
      line('tool_use', 'mcp__conclavix__get_issue {}'),
      line('tool_use', 'mcp__conclavix__add_comment {"body":"hi"}'),
      line('assistant', 'comment posted'),
      line('result', 'error_max_budget_usd: '),
    ]);
    expect(legacy.items.map((item) => item.kind)).toEqual([
      'init',
      'tool',
      'tool',
      'message',
      'result',
    ]);
    expect(legacy.items[0]).toMatchObject({
      legacy: true,
      mcpServers: [
        { name: 'conclavix', status: 'connected' },
        { name: 'other', status: 'failed' },
      ],
    });
    expect(legacy.items[2]).toMatchObject({
      name: 'mcp__conclavix__add_comment',
      input: '{\n  "body": "hi"\n}',
      result: null,
    });
    expect(legacy.items[4]).toMatchObject({ subtype: 'error_max_budget_usd', isError: true });
  });

  it('attaches results without an id to the latest open call without an id', () => {
    const view = buildRunView([
      line('tool_use', 'get_issue {}', {
        kind: 'tool_use',
        toolUseId: null,
        name: 'get_issue',
        input: '{}',
      }),
      line('tool_result', 'ok', {
        kind: 'tool_result',
        toolUseId: null,
        content: 'ok',
        isError: false,
      }),
      line('tool_result', 'orphan', {
        kind: 'tool_result',
        toolUseId: 'missing',
        content: 'orphan',
        isError: false,
      }),
    ]);
    expect(view.items[0]).toMatchObject({ kind: 'tool', result: { content: 'ok' } });
    expect(view.items[1]).toMatchObject({ kind: 'line', type: 'tool_result' });
    expect(view.counts.tools).toBe(2);
  });

  it('summarises tool inputs and labels MCP tools', () => {
    expect(inputSummary('{\n  "query": "next release",\n  "limit": 20\n}')).toBe(
      'query: next release, limit: 20',
    );
    expect(inputSummary(`{"body":"${'a'.repeat(200)}"}`, 20)).toHaveLength(20);
    expect(toolLabel('mcp__conclavix__get_issue')).toEqual({
      tool: 'get_issue',
      server: 'conclavix',
    });
    expect(toolLabel('Bash')).toEqual({ tool: 'Bash', server: null });
  });
});

describe('runs query', () => {
  it('maps filters to the API query with an inclusive end day', () => {
    const query = new URLSearchParams(
      runsQuery(
        {
          statuses: ['failed', 'timed_out'],
          agentId: 'a1',
          issueId: null,
          from: '2026-10-01',
          to: '2026-10-03',
        },
        25,
        'cursor',
      ),
    );
    expect(query.get('status')).toBe('failed,timed_out');
    expect(query.get('agentId')).toBe('a1');
    expect(query.has('issueId')).toBe(false);
    expect(query.get('before')).toBe('cursor');
    const span =
      new Date(query.get('to') ?? '').getTime() - new Date(query.get('from') ?? '').getTime();
    expect(Math.round(span / 3_600_000)).toBe(72);
  });
});
