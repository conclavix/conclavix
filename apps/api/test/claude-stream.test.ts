import { readFileSync } from 'node:fs';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUN_EVENT_LIMITS, runEventDataSchema, type RunEventData } from '@conclavix/core';
import type { RunEventType } from '../src/db.js';
import { parseStreamLine, type StreamSummary } from '../src/runner/adapters/claude-stream.js';
import { RunEventRecorder } from '../src/runner/events.js';
import { createTestContext, type TestContext } from './helpers.js';

interface Recorded {
  type: RunEventType;
  text: string;
  data?: RunEventData | undefined;
}

const FIXTURE = readFileSync(new URL('./fixtures/claude-stream.jsonl', import.meta.url), 'utf8');

function parseAll(lines: string[]): { events: Recorded[]; summary: StreamSummary } {
  const summary: StreamSummary = {
    costUsd: 0,
    resultSeen: false,
    isError: false,
    errorReason: null,
  };
  const events: Recorded[] = [];
  for (const line of lines) {
    parseStreamLine(line, summary, (type, text, data) => events.push({ type, text, data }));
  }
  return { events, summary };
}

const dataOf = <K extends RunEventData['kind']>(events: Recorded[], kind: K) =>
  events
    .map((event) => event.data)
    .filter((data): data is Extract<RunEventData, { kind: K }> => data?.kind === kind);

describe('claude stream-json parser', () => {
  const { events, summary } = parseAll(FIXTURE.split('\n'));

  it('keeps the cost of a result line whose other fields have an odd shape', () => {
    const { events: recorded, summary: folded } = parseAll([
      JSON.stringify({ type: 'result', subtype: 7, usage: 'lots', total_cost_usd: 0.42 }),
    ]);
    expect(folded).toMatchObject({ resultSeen: true, costUsd: 0.42, isError: true });
    expect(dataOf(recorded, 'result')).toEqual([
      expect.objectContaining({ subtype: 'result', totalCostUsd: 0.42, usage: null }),
    ]);
  });

  it.each([
    { type: 'assistant', message: { content: 42 } },
    { type: 'assistant', message: { content: [null, { type: 'text', text: 'hi' }] } },
    { type: 'assistant', message: 'secret-ish payload' },
    { type: 'user', message: { content: [7] } },
    { type: 'system', subtype: 'init', mcp_servers: [null], tools: 'all' },
  ])('notes a line with an unexpected shape without its content: %j', (shape) => {
    const line = JSON.stringify(shape);
    const next = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'after' }] },
    });
    let result: ReturnType<typeof parseAll> | undefined;
    expect(() => (result = parseAll([line, next]))).not.toThrow();
    expect(result?.events).toEqual([
      { type: 'runner', text: `unparsable stream line (${line.length} chars)`, data: undefined },
      {
        type: 'assistant',
        text: 'after',
        data: { kind: 'text', markdown: 'after' },
      },
    ]);
    expect(result?.summary.resultSeen).toBe(false);
  });

  it('emits schema-valid structured data for every structured event', () => {
    for (const event of events) {
      expect(event.data, event.text).toBeDefined();
      expect(runEventDataSchema.safeParse(event.data).success).toBe(true);
    }
    expect(events.map((event) => event.type)).toEqual([
      'system',
      'system',
      'assistant',
      'tool_use',
      'tool_result',
      'assistant',
      'tool_use',
      'tool_result',
      'assistant',
      'result',
    ]);
  });

  it('keeps the legacy text format', () => {
    expect(events[0]?.text).toBe('session started; mcp: conclavix=connected');
    expect(events[3]?.text).toBe('mcp__conclavix__memory_search {"query":"next release name"}');
    expect(events.at(-1)?.text).toBe('success: The next release is called **Leerdammer**.');
  });

  it('describes the session from system/init without leaking unrelated fields', () => {
    const [init] = dataOf(events, 'init');
    expect(init).toEqual({
      kind: 'init',
      model: 'claude-sonnet-4-6',
      cwd: '/srv/conclavix/workspaces/6abecf651befad9e5dfb4a55/CVX',
      permissionMode: 'bypassPermissions',
      claudeCodeVersion: '2.1.138',
      tools: expect.arrayContaining(['Bash', 'mcp__conclavix__get_issue']),
      toolsOmitted: 0,
      mcpServers: [{ name: 'conclavix', status: 'connected' }],
    });
    expect(JSON.stringify(init)).not.toContain('memory_paths');
    expect(dataOf(events, 'api_retry')).toEqual([
      { kind: 'api_retry', attempt: 1, maxRetries: 10, error: 'overloaded' },
    ]);
  });

  it('separates assistant text from thinking', () => {
    expect(dataOf(events, 'thinking')[0]?.thinking).toContain('Check memory first');
    expect(dataOf(events, 'text').map((data) => data.markdown)).toEqual([
      'Found it in memory. Posting the answer.',
      'The next release is called **Leerdammer**.',
    ]);
  });

  it('links tool results to their tool calls by tool_use_id', () => {
    const uses = dataOf(events, 'tool_use');
    const results = dataOf(events, 'tool_result');
    expect(uses.map((use) => use.toolUseId)).toEqual(results.map((result) => result.toolUseId));
    expect(JSON.parse(uses[0]?.input ?? '')).toEqual({ query: 'next release name' });
    expect(results[0]).toMatchObject({ isError: false, content: expect.stringContaining('Dutch') });
    expect(results[1]).toMatchObject({ isError: true, content: expect.stringContaining('-32602') });
  });

  it('summarises the result with cost, turns, duration and token usage', () => {
    expect(dataOf(events, 'result')[0]).toEqual({
      kind: 'result',
      subtype: 'success',
      isError: false,
      numTurns: 4,
      durationMs: 11963,
      totalCostUsd: 0.2965,
      usage: {
        inputTokens: 10,
        outputTokens: 142,
        cacheReadInputTokens: 45900,
        cacheCreationInputTokens: 5540,
      },
      result: 'The next release is called **Leerdammer**.',
    });
    expect(summary).toEqual({
      costUsd: 0.2965,
      resultSeen: true,
      isError: false,
      resultText: 'The next release is called **Leerdammer**.',
      errorReason: null,
    });
  });

  it('flattens non-text tool result blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_x',
            content: [
              { type: 'text', text: 'see image' },
              { type: 'image', source: { type: 'base64', data: 'AAAA' } },
              { type: 'tool_reference', tool_name: 'WebFetch' },
            ],
          },
        ],
      },
    });
    const [result] = dataOf(parseAll([line]).events, 'tool_result');
    expect(result?.content).toBe('see image\n[image]\n[tool_reference WebFetch]');
  });

  it('caps huge fields and says how much was cut', () => {
    const huge = 'x'.repeat(RUN_EVENT_LIMITS.toolResult + 1234);
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Write', input: { content: huge } },
            { type: 'text', text: huge.repeat(3) },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }] },
      }),
    ];
    const parsed = parseAll(lines).events;
    for (const event of parsed) {
      expect(runEventDataSchema.safeParse(event.data).success).toBe(true);
    }
    const [use] = dataOf(parsed, 'tool_use');
    const [result] = dataOf(parsed, 'tool_result');
    const [text] = dataOf(parsed, 'text');
    expect(result?.content.length).toBeLessThan(RUN_EVENT_LIMITS.toolResult + 40);
    expect(result?.content).toMatch(/\[truncated 1234 chars\]$/);
    expect(use?.input.length).toBeLessThan(RUN_EVENT_LIMITS.toolInput + 40);
    expect(use?.input).toMatch(/\[truncated \d+ chars\]$/);
    expect(text?.markdown).toMatch(/\[truncated \d+ chars\]$/);
  });

  it('tolerates tool calls without an id and garbage lines', () => {
    const parsed = parseAll([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'get_issue', input: {} }] },
      }),
      'not json',
      'null',
    ]).events;
    expect(dataOf(parsed, 'tool_use')[0]?.toolUseId).toBeNull();
    expect(parsed.slice(1).map((event) => event.type)).toEqual(['stderr', 'stderr']);
  });
});

describe('run event recorder', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('stores valid data, drops invalid data, and serves both through the events API', async () => {
    const runId = new ObjectId();
    await ctx.database.collections.runs.insertOne({
      _id: runId,
      agentId: new ObjectId(),
      issueId: new ObjectId(),
      reason: 'manual',
      status: 'running',
      costUsd: 0,
      maxCostPerRunUsd: 1,
      overBudget: false,
      progressAtStart: 0,
      madeProgress: null,
      error: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: null,
      tokenHash: null,
      tokenExpiresAt: null,
    });
    const recorder = new RunEventRecorder(ctx.database.collections, runId);
    recorder.record('assistant', 'hello', { kind: 'text', markdown: 'hello' });
    recorder.record('tool_use', 'bad', { kind: 'tool_use', name: 'x' } as unknown as RunEventData);
    recorder.record('runner', 'plain');
    recorder.record('system', 'mismatched', { kind: 'text', markdown: 'hello' });
    recorder.record('assistant', 'oversized', {
      kind: 'text',
      markdown: 'x'.repeat(RUN_EVENT_LIMITS.markdown + 41),
    });
    await recorder.flush();

    const response = await ctx.request({
      method: 'GET',
      url: `/api/runs/${runId.toHexString()}/events`,
    });
    const items = response.json().items as Recorded[];
    expect(items.map((item) => item.data ?? null)).toEqual([
      { kind: 'text', markdown: 'hello' },
      null,
      null,
      null,
      null,
    ]);
    expect(items.map((item) => item.text)).toEqual([
      'hello',
      'bad',
      'plain',
      'mismatched',
      'oversized',
    ]);
  });
});
