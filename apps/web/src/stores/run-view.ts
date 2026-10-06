import type { RunInitData, RunLogLine, RunResultData } from '../api/types';

export type RunTab = 'chat' | 'assistant' | 'tools' | 'result' | 'system' | 'runner';

export const FILTER_TABS: { value: Exclude<RunTab, 'chat'>; title: string }[] = [
  { value: 'assistant', title: 'Assistant' },
  { value: 'tools', title: 'Tool use' },
  { value: 'result', title: 'Result' },
  { value: 'system', title: 'System' },
  { value: 'runner', title: 'Runner' },
];

interface Base {
  key: string;
  seq: number;
  at: string;
}

export interface ToolResult {
  seq: number;
  content: string;
  isError: boolean;
}

export type MessageItem = Base & { kind: 'message'; markdown: string };
export type ThinkingItem = Base & { kind: 'thinking'; text: string };
export type ToolItem = Base & {
  kind: 'tool';
  toolUseId: string | null;
  name: string;
  input: string;
  result: ToolResult | null;
};
export type ResultItem = Base & Omit<RunResultData, 'kind'> & { kind: 'result' };
export type InitItem = Base & Omit<RunInitData, 'kind'> & { kind: 'init'; legacy: boolean };
export type LineItem = Base & { kind: 'line'; type: string; text: string };

export type RunItem = MessageItem | ThinkingItem | ToolItem | ResultItem | InitItem | LineItem;

export interface RunView {
  items: RunItem[];
  counts: Record<Exclude<RunTab, 'chat'>, number>;
}

const base = (line: RunLogLine): Base => ({ key: String(line.seq), seq: line.seq, at: line.at });

/** Pretty-print a JSON string when it parses; otherwise return it unchanged. */
export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function legacyTool(line: RunLogLine): ToolItem {
  const space = line.text.indexOf(' ');
  const name = space === -1 ? line.text : line.text.slice(0, space);
  const input = space === -1 ? '' : prettyJson(line.text.slice(space + 1));
  return { ...base(line), kind: 'tool', toolUseId: null, name, input, result: null };
}

function legacyResult(line: RunLogLine): ResultItem {
  const match = /^([a-z_]+):\s?([\s\S]*)$/.exec(line.text);
  const subtype = match?.[1] ?? 'result';
  return {
    ...base(line),
    kind: 'result',
    subtype,
    isError: subtype !== 'success',
    numTurns: null,
    durationMs: null,
    totalCostUsd: null,
    usage: null,
    result: match ? (match[2] ?? '') : line.text,
  };
}

function legacyInit(line: RunLogLine): InitItem | LineItem {
  const match = /^session started; mcp: (.*)$/.exec(line.text);
  if (!match) {
    return { ...base(line), kind: 'line', type: line.type, text: line.text };
  }
  const servers = match[1] === 'none' ? [] : (match[1] ?? '').split(', ');
  return {
    ...base(line),
    kind: 'init',
    legacy: true,
    model: null,
    cwd: null,
    permissionMode: null,
    claudeCodeVersion: null,
    tools: [],
    toolsOmitted: 0,
    mcpServers: servers.map((entry) => {
      const [name = entry, status = 'unknown'] = entry.split('=');
      return { name, status };
    }),
  };
}

/** Map one recorded line to a view item; lines without structured data use their text. */
function toItem(line: RunLogLine): RunItem | null {
  const data = line.data;
  switch (data?.kind) {
    case 'text':
      return { ...base(line), kind: 'message', markdown: data.markdown };
    case 'thinking':
      return { ...base(line), kind: 'thinking', text: data.thinking };
    case 'tool_use':
      return {
        ...base(line),
        kind: 'tool',
        toolUseId: data.toolUseId,
        name: data.name,
        input: data.input,
        result: null,
      };
    case 'tool_result':
      return null;
    case 'result':
      return { ...base(line), ...data, kind: 'result' };
    case 'init':
      return { ...base(line), ...data, kind: 'init', legacy: false };
    case 'api_retry':
      return { ...base(line), kind: 'line', type: 'system', text: line.text };
  }
  switch (line.type) {
    case 'assistant':
      return { ...base(line), kind: 'message', markdown: line.text };
    case 'tool_use':
      return legacyTool(line);
    case 'result':
      return legacyResult(line);
    case 'system':
      return legacyInit(line);
    default:
      return { ...base(line), kind: 'line', type: line.type, text: line.text };
  }
}

/** Find the tool call a result belongs to: by id, else the latest open call without an id. */
function ownerOf(tools: ToolItem[], byId: Map<string, ToolItem>, id: string | null) {
  if (id !== null) {
    return byId.get(id);
  }
  return tools.findLast((tool) => tool.toolUseId === null && tool.result === null);
}

/** Fold a run's log lines into chat items, linking each tool result to its call. */
export function buildRunView(lines: RunLogLine[]): RunView {
  const items: RunItem[] = [];
  const tools: ToolItem[] = [];
  const byId = new Map<string, ToolItem>();
  for (const line of lines) {
    const data = line.data;
    if (data?.kind === 'tool_result') {
      const owner = ownerOf(tools, byId, data.toolUseId);
      if (owner) {
        owner.result = { seq: line.seq, content: data.content, isError: data.isError };
      } else {
        items.push({ ...base(line), kind: 'line', type: 'tool_result', text: line.text });
      }
      continue;
    }
    const item = toItem(line);
    if (item) {
      items.push(item);
      if (item.kind === 'tool') {
        tools.push(item);
        if (item.toolUseId) byId.set(item.toolUseId, item);
      }
    }
  }
  const counts = { assistant: 0, tools: 0, result: 0, system: 0, runner: 0 };
  for (const item of items) {
    const tab = tabOf(item);
    if (tab) counts[tab] += 1;
  }
  return { items, counts };
}

/** The filter tab an item belongs to, if any. */
export function tabOf(item: RunItem): Exclude<RunTab, 'chat'> | null {
  switch (item.kind) {
    case 'message':
    case 'thinking':
      return 'assistant';
    case 'tool':
      return 'tools';
    case 'result':
      return 'result';
    case 'init':
      return 'system';
    case 'line':
      if (item.type === 'system') return 'system';
      if (item.type === 'runner' || item.type === 'stderr') return 'runner';
      return item.type === 'tool_result' ? 'tools' : null;
  }
}

/** Items visible in a tab; the chat tab hides stderr noise but keeps runner notes. */
export function itemsForTab(items: RunItem[], tab: RunTab): RunItem[] {
  if (tab === 'chat') {
    return items.filter((item) => !(item.kind === 'line' && item.type === 'stderr'));
  }
  return items.filter((item) => tabOf(item) === tab);
}

/** A one-line summary of a tool input for the collapsed card header. */
export function inputSummary(input: string, max = 90): string {
  let summary = input;
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      summary = Object.entries(parsed as Record<string, unknown>)
        .map(
          ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
        )
        .join(', ');
    }
  } catch {
    summary = input;
  }
  summary = summary.replace(/\s+/g, ' ').trim();
  return summary.length > max ? `${summary.slice(0, max - 3)}...` : summary;
}

/** Strip the mcp__server__ prefix for display, keeping the server as a hint. */
export function toolLabel(name: string): { tool: string; server: string | null } {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match
    ? { tool: match[2] ?? name, server: match[1] ?? null }
    : { tool: name, server: null };
}
