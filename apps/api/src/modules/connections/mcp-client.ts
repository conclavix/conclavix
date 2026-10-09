import http from 'node:http';
import { z } from 'zod';
import https from 'node:https';
import { AppError } from '../../errors.js';
import { guardedLookup } from '../skill-sources/net-guard.js';
import { assertSafeConnectionUrl, connectionAddressBlocked } from './net.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_PAGES = 10;
/** Tool names kept for the board; the count covers all of them. */
const MAX_TOOLS = 200;
export const MCP_PROTOCOL_VERSION = '2025-06-18';

interface PostResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface McpProbeOptions {
  url: string;
  headers: Record<string, string>;
  allowPrivate: boolean;
  timeoutMs: number;
  clientVersion: string;
}

export interface McpProbe {
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  /** The first tool names, at most 200. */
  tools: string[];
  toolCount: number;
}

export class McpProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpProbeError';
  }
}

/**
 * One POST over node:http(s): the SSRF guard on the DNS lookup unless private networks are
 * allowed, a time limit, a size cap and no redirects. Errors never carry the request headers.
 */
function post(
  url: URL,
  options: McpProbeOptions & { deadline: number },
  headers: Record<string, string>,
  body: string,
) {
  return new Promise<PostResult>((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const controller = new AbortController();
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.abort();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new McpProbeError('the server did not answer in time')),
      Math.max(1, options.deadline - Date.now()),
    );
    const request = client.request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(body) },
        agent: false,
        signal: controller.signal,
        ...(options.allowPrivate ? {} : { lookup: guardedLookup }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) fail(new McpProbeError('the answer is too large'));
          else chunks.push(chunk);
        });
        response.on('error', () => fail(new McpProbeError('the connection broke')));
        response.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', (error) => {
      if (error instanceof AppError) fail(connectionAddressBlocked());
      else fail(new McpProbeError(`the server could not be reached (${errorCode(error)})`));
    });
    request.end(body);
  });
}

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : 'network error';
};

const responseSchema = z.object({
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ message: z.unknown().optional() }).loose().optional(),
});

const initializeSchema = z
  .object({
    protocolVersion: z.string().optional().catch(undefined),
    serverInfo: z
      .object({
        name: z.string().optional().catch(undefined),
        version: z.string().optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
  })
  .loose();

const toolsSchema = z
  .object({
    tools: z.array(z.object({ name: z.string() }).loose()).catch([]),
    nextCursor: z.string().optional().catch(undefined),
  })
  .loose();

/** The JSON-RPC message with `id` from a JSON or an SSE answer. */
function messageFor(result: PostResult, id: number): Record<string, unknown> {
  const type = String(result.headers['content-type'] ?? '');
  const candidates: unknown[] = [];
  try {
    if (type.includes('text/event-stream')) {
      for (const event of result.body.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) candidates.push(JSON.parse(data));
      }
    } else {
      candidates.push(JSON.parse(result.body));
    }
  } catch {
    throw new McpProbeError('the server did not answer with JSON-RPC');
  }
  const flat = candidates.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
  const message = flat
    .map((entry) => responseSchema.safeParse(entry))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .find((entry) => entry.id === id);
  if (!message) throw new McpProbeError('the server did not answer the request');
  if (message.error) {
    const text = typeof message.error.message === 'string' ? message.error.message : 'error';
    throw new McpProbeError(`the server answered with an error: ${text}`);
  }
  return message.result ?? {};
}

function checkStatus(result: PostResult, step: string): void {
  if (result.status === 401 || result.status === 403) {
    throw new McpProbeError(`the server refused the credentials (HTTP ${result.status})`);
  }
  if (result.status >= 300 && result.status < 400) {
    throw new McpProbeError(`the server redirects (HTTP ${result.status}); use the final URL`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new McpProbeError(`${step} failed with HTTP ${result.status}`);
  }
}

/**
 * Speak just enough MCP (streamable HTTP) to prove a server works with these credentials:
 * initialize, the initialized notification and tools/list (all pages, up to a limit).
 */
export async function probeMcpServer(options: McpProbeOptions): Promise<McpProbe> {
  const url = assertSafeConnectionUrl(options.url, options.allowPrivate);
  // One time limit for the whole test, not per request.
  const timed = { ...options, deadline: Date.now() + options.timeoutMs };
  const base: Record<string, string> = {
    ...options.headers,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const rpc = (method: string, id: number | null, params: object = {}) =>
    JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params });

  const init = await post(
    url,
    timed,
    base,
    rpc('initialize', 1, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'conclavix', version: options.clientVersion },
    }),
  );
  checkStatus(init, 'initialize');
  const info = initializeSchema.parse(messageFor(init, 1));
  const session = init.headers['mcp-session-id'];
  const protocolVersion = info.protocolVersion ?? null;
  const headers = {
    ...base,
    ...(typeof session === 'string' ? { 'mcp-session-id': session } : {}),
    ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
  };
  const initialized = await post(url, timed, headers, rpc('notifications/initialized', null));
  if (initialized.status >= 400) checkStatus(initialized, 'initialized');

  const tools: string[] = [];
  let toolCount = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const listed = await post(
      url,
      timed,
      headers,
      rpc('tools/list', 2 + page, cursor ? { cursor } : {}),
    );
    checkStatus(listed, 'tools/list');
    const result = toolsSchema.parse(messageFor(listed, 2 + page));
    tools.push(
      ...result.tools.slice(0, MAX_TOOLS - tools.length).map((tool) => tool.name.slice(0, 128)),
    );
    toolCount += result.tools.length;
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return {
    serverName: info.serverInfo?.name?.slice(0, 120) ?? null,
    serverVersion: info.serverInfo?.version?.slice(0, 40) ?? null,
    protocolVersion,
    tools,
    toolCount,
  };
}
