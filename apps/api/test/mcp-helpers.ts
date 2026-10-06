import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ObjectId } from 'mongodb';
import type { RunDoc } from '../src/db.js';
import type { TestContext } from './helpers.js';
import type { Fixture } from './scheduler-helpers.js';

type ToolResponse = { isError?: boolean; content: { type: string; text: string }[] };

export interface ToolCall {
  isError: boolean;
  data: Record<string, unknown> & { error?: string };
}

/** Connect an MCP client to the agent API with a run token. */
export async function connectAgent(baseUrl: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as Parameters<Client['connect']>[0]);
  return client;
}

/** Call a tool and parse its JSON text result. */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCall> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResponse;
  const text = result.content[0]?.text ?? 'null';
  let data: ToolCall['data'];
  try {
    data = JSON.parse(text) as ToolCall['data'];
  } catch {
    data = { error: text };
  }
  return { isError: result.isError === true, data };
}

/** Process pending wakes and start the queued run for the issue, returning its token. */
export async function startRunFor(
  ctx: TestContext,
  fx: Fixture,
  issueId: string,
): Promise<{ run: RunDoc; token: string }> {
  await fx.scheduler.processPendingWakes();
  const run = await ctx.database.collections.runs.findOne({
    issueId: new ObjectId(issueId),
    status: 'queued',
  });
  if (!run) {
    throw new Error('expected a queued run');
  }
  const { token } = await fx.scheduler.startRun(run._id, 60_000);
  return { run, token };
}
