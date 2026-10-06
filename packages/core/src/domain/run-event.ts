import { z } from 'zod';

export const runEventTypeSchema = z.enum([
  'runner',
  'system',
  'assistant',
  'tool_use',
  'tool_result',
  'result',
  'stderr',
]);

export const RUN_EVENT_LIMITS = {
  markdown: 16_000,
  thinking: 16_000,
  toolInput: 8_000,
  toolResult: 8_000,
  resultText: 16_000,
  shortText: 500,
  listItems: 300,
} as const;

// Allow space for capText’s newline and truncation marker, including its character count.
const cappedString = (max: number) => z.string().max(max + 40);
const shortText = cappedString(RUN_EVENT_LIMITS.shortText);

const count = z.number().int().nonnegative();

export const runInitDataSchema = z.strictObject({
  kind: z.literal('init'),
  model: shortText.nullable(),
  cwd: shortText.nullable(),
  permissionMode: shortText.nullable(),
  claudeCodeVersion: shortText.nullable(),
  tools: z.array(shortText).max(RUN_EVENT_LIMITS.listItems),
  toolsOmitted: count,
  mcpServers: z
    .array(z.strictObject({ name: shortText, status: shortText }))
    .max(RUN_EVENT_LIMITS.listItems),
});

export const runRetryDataSchema = z.strictObject({
  kind: z.literal('api_retry'),
  attempt: count.nullable(),
  maxRetries: count.nullable(),
  error: shortText.nullable(),
});

export const runTextDataSchema = z.strictObject({
  kind: z.literal('text'),
  markdown: cappedString(RUN_EVENT_LIMITS.markdown),
});

export const runThinkingDataSchema = z.strictObject({
  kind: z.literal('thinking'),
  thinking: cappedString(RUN_EVENT_LIMITS.thinking),
});

export const runToolUseDataSchema = z.strictObject({
  kind: z.literal('tool_use'),
  toolUseId: shortText.nullable(),
  name: shortText,
  input: cappedString(RUN_EVENT_LIMITS.toolInput),
});

export const runToolResultDataSchema = z.strictObject({
  kind: z.literal('tool_result'),
  toolUseId: shortText.nullable(),
  content: cappedString(RUN_EVENT_LIMITS.toolResult),
  isError: z.boolean(),
});

export const runUsageSchema = z.strictObject({
  inputTokens: count,
  outputTokens: count,
  cacheReadInputTokens: count,
  cacheCreationInputTokens: count,
});

export const runResultDataSchema = z.strictObject({
  kind: z.literal('result'),
  subtype: shortText,
  isError: z.boolean(),
  numTurns: count.nullable(),
  durationMs: count.nullable(),
  totalCostUsd: z.number().nonnegative().nullable(),
  usage: runUsageSchema.nullable(),
  result: cappedString(RUN_EVENT_LIMITS.resultText).nullable(),
});

export const runEventDataSchema = z.discriminatedUnion('kind', [
  runInitDataSchema,
  runRetryDataSchema,
  runTextDataSchema,
  runThinkingDataSchema,
  runToolUseDataSchema,
  runToolResultDataSchema,
  runResultDataSchema,
]);

export const RUN_EVENT_DATA_KINDS: Record<RunEventData['kind'], RunEventType> = {
  init: 'system',
  api_retry: 'system',
  text: 'assistant',
  thinking: 'assistant',
  tool_use: 'tool_use',
  tool_result: 'tool_result',
  result: 'result',
};

export type RunEventType = z.infer<typeof runEventTypeSchema>;
export type RunEventData = z.infer<typeof runEventDataSchema>;
export type RunUsage = z.infer<typeof runUsageSchema>;

/** Cut a string to at most `max` characters and append a marker saying how much was dropped. */
export function capText(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const cut = value.length - max;
  return `${value.slice(0, max)}\n[truncated ${cut} chars]`;
}
