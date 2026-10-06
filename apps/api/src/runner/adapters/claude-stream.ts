import { RUN_EVENT_LIMITS, capText, type RunEventData, type RunUsage } from '@conclavix/core';
import { z } from 'zod';
import type { RunEventType } from '../../db.js';

export interface StreamSummary {
  costUsd: number;
  resultSeen: boolean;
  isError: boolean;
  errorReason: string | null;
  /** The text of the final result event, uncapped; only the runner's commit message uses it. */
  resultText?: string | null;
}

export type StreamEventSink = (type: RunEventType, text: string, data?: RunEventData) => void;

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  tool_name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  total_cost_usd?: number;
  duration_ms?: unknown;
  num_turns?: unknown;
  usage?: Record<string, unknown>;
  model?: unknown;
  cwd?: unknown;
  permissionMode?: unknown;
  claude_code_version?: unknown;
  tools?: unknown;
  mcp_servers?: { name?: unknown; status?: unknown }[];
  attempt?: unknown;
  max_retries?: unknown;
  error?: unknown;
  message?: { content?: ContentBlock[] | string };
}

const short = (value: unknown): string | null =>
  typeof value === 'string' ? capText(value, RUN_EVENT_LIMITS.shortText) : null;

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Content blocks of a message; anything that is not an object is skipped. */
const blocksOf = (event: StreamEvent): ContentBlock[] => {
  const message: unknown = event.message;
  const content = isObject(message) ? message['content'] : undefined;
  return Array.isArray(content) ? content.filter(isObject) : [];
};

type InitData = Extract<RunEventData, { kind: 'init' }>;

function initData(event: StreamEvent): InitData {
  const tools = Array.isArray(event.tools)
    ? event.tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers.filter(isObject) : [];
  return {
    kind: 'init',
    model: short(event.model),
    cwd: short(event.cwd),
    permissionMode: short(event.permissionMode),
    claudeCodeVersion: short(event.claude_code_version),
    tools: tools
      .slice(0, RUN_EVENT_LIMITS.listItems)
      .map((tool) => capText(tool, RUN_EVENT_LIMITS.shortText)),
    toolsOmitted: Math.max(0, tools.length - RUN_EVENT_LIMITS.listItems),
    mcpServers: servers.slice(0, RUN_EVENT_LIMITS.listItems).map((server) => ({
      name: short(server.name) ?? 'unknown',
      status: short(server.status) ?? 'unknown',
    })),
  };
}

/** Format a session-start log entry with the reported MCP server names and statuses. */
function describeInit(data: InitData): string {
  const servers = data.mcpServers.map((server) => `${server.name}=${server.status}`);
  return `session started; mcp: ${servers.join(', ') || 'none'}`;
}

function recordRetry(event: StreamEvent, onEvent: StreamEventSink): void {
  const data: RunEventData = {
    kind: 'api_retry',
    attempt: count(event.attempt),
    maxRetries: count(event.max_retries),
    error: short(event.error),
  };
  const of = data.maxRetries === null ? '' : `/${data.maxRetries}`;
  onEvent(
    'system',
    `api retry ${data.attempt ?? '?'}${of}: ${data.error ?? 'unknown error'}`,
    data,
  );
}

/** Emit log events for assistant text, thinking, and named tool calls with their inputs. */
function recordAssistant(event: StreamEvent, onEvent: StreamEventSink): void {
  for (const block of blocksOf(event)) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      onEvent('assistant', block.text, {
        kind: 'text',
        markdown: capText(block.text, RUN_EVENT_LIMITS.markdown),
      });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      onEvent('assistant', `(thinking) ${block.thinking}`, {
        kind: 'thinking',
        thinking: capText(block.thinking, RUN_EVENT_LIMITS.thinking),
      });
    } else if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
      const input = block.input ?? {};
      onEvent('tool_use', `${block.name} ${JSON.stringify(input)}`, {
        kind: 'tool_use',
        toolUseId: typeof block.id === 'string' ? block.id : null,
        name: capText(block.name, RUN_EVENT_LIMITS.shortText),
        input: capText(JSON.stringify(input, null, 2), RUN_EVENT_LIMITS.toolInput),
      });
    }
  }
}

/** Flatten a tool_result content value (string or content blocks) into readable text. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return (content.filter(isObject) as ContentBlock[])
    .map((block) => {
      if (block.type === 'text') return block.text ?? '';
      if (block.type === 'tool_reference') return `[tool_reference ${block.tool_name ?? ''}]`;
      return `[${block.type ?? 'unknown'}]`;
    })
    .join('\n');
}

/** Emit one event per tool_result block that claude feeds back to the model. */
function recordToolResults(event: StreamEvent, onEvent: StreamEventSink): void {
  for (const block of blocksOf(event)) {
    if (block.type !== 'tool_result') {
      continue;
    }
    const isError = block.is_error === true;
    const content = toolResultText(block.content);
    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
    onEvent('tool_result', `${isError ? 'error' : 'ok'} ${toolUseId ?? ''} ${content}`, {
      kind: 'tool_result',
      toolUseId,
      content: capText(content, RUN_EVENT_LIMITS.toolResult),
      isError,
    });
  }
}

function usageOf(usage: unknown): RunUsage | null {
  if (!isObject(usage)) {
    return null;
  }
  return {
    inputTokens: count(usage['input_tokens']) ?? 0,
    outputTokens: count(usage['output_tokens']) ?? 0,
    cacheReadInputTokens: count(usage['cache_read_input_tokens']) ?? 0,
    cacheCreationInputTokens: count(usage['cache_creation_input_tokens']) ?? 0,
  };
}

function recordResult(event: StreamEvent, summary: StreamSummary, onEvent: StreamEventSink): void {
  summary.resultSeen = true;
  const cost =
    typeof event.total_cost_usd === 'number' &&
    Number.isFinite(event.total_cost_usd) &&
    event.total_cost_usd >= 0
      ? event.total_cost_usd
      : null;
  if (cost !== null) {
    summary.costUsd = cost;
  }
  summary.isError = event.is_error === true || event.subtype !== 'success';
  summary.errorReason = summary.isError ? (short(event.subtype) ?? 'error') : null;
  const result = typeof event.result === 'string' ? event.result : null;
  summary.resultText = result;
  onEvent('result', `${short(event.subtype) ?? 'result'}: ${result ?? ''}`.trim(), {
    kind: 'result',
    subtype: short(event.subtype) ?? 'result',
    isError: summary.isError,
    numTurns: count(event.num_turns),
    durationMs: count(event.duration_ms),
    totalCostUsd: cost,
    usage: usageOf(event.usage),
    result: result === null ? null : capText(result, RUN_EVENT_LIMITS.resultText),
  });
}

const blockList = z.union([z.string(), z.array(z.looseObject({ type: z.string().optional() }))]);
const messageEvent = z.looseObject({
  message: z.looseObject({ content: blockList.optional() }).optional(),
});

/**
 * The container shapes the parser walks for each event type it understands. Leaf values are
 * still read defensively; this only rejects lines whose structure cannot be folded at all.
 */
const STREAM_SHAPES: Record<string, z.ZodType> = {
  system: z.looseObject({
    subtype: z.string().optional(),
    tools: z.array(z.unknown()).optional(),
    mcp_servers: z.array(z.looseObject({})).optional(),
  }),
  assistant: messageEvent,
  user: messageEvent,
  // No guard for `result`: it carries the run's cost, and every field is read defensively, so an
  // odd `usage` or `subtype` must not cost us the result (the run would be booked at cost 0).
};

/** Fold one parsed stream-json event into the summary and the run log. */
function dispatch(event: StreamEvent, summary: StreamSummary, onEvent: StreamEventSink): void {
  if (event.type === 'system' && event.subtype === 'init') {
    const data = initData(event);
    onEvent('system', describeInit(data), data);
  } else if (event.type === 'system' && event.subtype === 'api_retry') {
    recordRetry(event, onEvent);
  } else if (event.type === 'assistant') {
    recordAssistant(event, onEvent);
  } else if (event.type === 'user') {
    recordToolResults(event, onEvent);
  } else if (event.type === 'result') {
    recordResult(event, summary, onEvent);
  }
}

/**
 * Fold one line of claude's stream-json output into the summary and the run log. Never throws:
 * a line is called from a readline handler, where an exception would end the run's parsing.
 * Non-JSON output is kept as stderr; JSON whose shape cannot be read is noted without its
 * content, which could hold anything.
 */
export function parseStreamLine(
  line: string,
  summary: StreamSummary,
  onEvent: StreamEventSink,
): void {
  if (!line.trim()) {
    return;
  }
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    onEvent('stderr', line);
    return;
  }
  if (!isObject(event)) {
    onEvent('stderr', line);
    return;
  }
  const unparsable = (): void => onEvent('runner', `unparsable stream line (${line.length} chars)`);
  const shape = typeof event['type'] === 'string' ? STREAM_SHAPES[event['type']] : undefined;
  if (shape && !shape.safeParse(event).success) {
    unparsable();
    return;
  }
  try {
    dispatch(event as StreamEvent, summary, onEvent);
  } catch {
    unparsable();
  }
}
