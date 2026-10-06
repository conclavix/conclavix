import { describe, expect, it } from 'vitest';
import { capText, RUN_EVENT_LIMITS, runEventDataSchema } from '../src/domain/run-event.js';

const init = {
  kind: 'init',
  model: null,
  cwd: null,
  permissionMode: null,
  claudeCodeVersion: null,
  tools: [],
  toolsOmitted: 0,
  mcpServers: [],
};
const toolUse = { kind: 'tool_use', toolUseId: null, name: 'Read', input: '{}' };
const toolResult = { kind: 'tool_result', toolUseId: null, content: '', isError: false };
const result = {
  kind: 'result',
  subtype: 'success',
  isError: false,
  numTurns: null,
  durationMs: null,
  totalCostUsd: null,
  usage: null,
  result: null,
};
const cases = [
  ...['model', 'cwd', 'permissionMode', 'claudeCodeVersion'].map((field) => ({
    name: `init.${field}`,
    limit: RUN_EVENT_LIMITS.shortText,
    data: (value: string) => ({ ...init, [field]: value }),
  })),
  {
    name: 'init.tools',
    limit: RUN_EVENT_LIMITS.shortText,
    data: (value: string) => ({ ...init, tools: [value] }),
  },
  ...['name', 'status'].map((field) => ({
    name: `init.mcpServers.${field}`,
    limit: RUN_EVENT_LIMITS.shortText,
    data: (value: string) => ({
      ...init,
      mcpServers: [{ name: 'server', status: 'connected', [field]: value }],
    }),
  })),
  {
    name: 'retry.error',
    limit: RUN_EVENT_LIMITS.shortText,
    data: (value: string) => ({ kind: 'api_retry', attempt: null, maxRetries: null, error: value }),
  },
  {
    name: 'text.markdown',
    limit: RUN_EVENT_LIMITS.markdown,
    data: (value: string) => ({ kind: 'text', markdown: value }),
  },
  {
    name: 'thinking.thinking',
    limit: RUN_EVENT_LIMITS.thinking,
    data: (value: string) => ({ kind: 'thinking', thinking: value }),
  },
  ...['name', 'toolUseId'].map((field) => ({
    name: `tool_use.${field}`,
    limit: RUN_EVENT_LIMITS.shortText,
    data: (value: string) => ({ ...toolUse, [field]: value }),
  })),
  {
    name: 'tool_use.input',
    limit: RUN_EVENT_LIMITS.toolInput,
    data: (value: string) => ({ ...toolUse, input: value }),
  },
  {
    name: 'tool_result.toolUseId',
    limit: RUN_EVENT_LIMITS.shortText,
    data: (value: string) => ({ ...toolResult, toolUseId: value }),
  },
  {
    name: 'tool_result.content',
    limit: RUN_EVENT_LIMITS.toolResult,
    data: (value: string) => ({ ...toolResult, content: value }),
  },
  {
    name: 'result.subtype',
    limit: RUN_EVENT_LIMITS.shortText,
    data: (value: string) => ({ ...result, subtype: value }),
  },
  {
    name: 'result.result',
    limit: RUN_EVENT_LIMITS.resultText,
    data: (value: string) => ({ ...result, result: value }),
  },
];

describe('run event string limits', () => {
  it.each(cases)('bounds $name while accepting capped text', ({ limit, data }) => {
    expect(runEventDataSchema.safeParse(data('x'.repeat(limit))).success).toBe(true);
    expect(
      runEventDataSchema.safeParse(data(capText('x'.repeat(limit + 1234), limit))).success,
    ).toBe(true);
    expect(runEventDataSchema.safeParse(data('x'.repeat(limit + 40))).success).toBe(true);
    expect(runEventDataSchema.safeParse(data('x'.repeat(limit + 41))).success).toBe(false);
  });

  it('preserves nullable fields', () => {
    for (const data of [
      init,
      toolUse,
      toolResult,
      result,
      { kind: 'api_retry', attempt: null, maxRetries: null, error: null },
    ]) {
      expect(runEventDataSchema.safeParse(data).success).toBe(true);
    }
  });
});
