import { z } from 'zod';
import { McpProbeError, probeMcpServer } from '../mcp-client.js';
import type { ConnectionType } from './types.js';

/** Headers the client sets itself or that would confuse the transport. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-type',
  'content-length',
  'accept',
  'connection',
  'transfer-encoding',
  'mcp-session-id',
  'mcp-protocol-version',
]);

const headerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, 'letters, digits and -')
  .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), 'set by the client itself');

export const mcpHttpConfigSchema = z.strictObject({
  url: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .refine((url) => !url.includes('$'), 'must not contain $ (claude expands ${...} in it)')
    .meta({
      title: 'Server URL',
      description: 'Streamable HTTP endpoint of the MCP server, e.g. https://mcp.example.com/mcp',
    }),
  headers: z
    .array(headerNameSchema)
    .max(8)
    .default([])
    .refine(
      (names) => new Set(names.map((name) => name.toLowerCase())).size === names.length,
      'each header once',
    )
    .meta({
      title: 'Headers',
      description: 'Sent with every request; their values are stored encrypted, e.g. Authorization',
    }),
});

export type McpHttpConfig = z.infer<typeof mcpHttpConfigSchema>;

/** The client version the test reports to the server. */
export const clientVersion = { value: '0.0.0' };

/**
 * An external MCP server over streamable HTTP. Allowed agents get it in their run's MCP config
 * as `<connection name>` and its tools as `mcp__<connection name>__*`.
 */
export const mcpHttpType: ConnectionType<McpHttpConfig> = {
  id: 'mcp_http',
  label: 'MCP server (HTTP)',
  description:
    'An external MCP server reached over streamable HTTP. Allowed agents can call its tools in their runs.',
  configSchema: mcpHttpConfigSchema as z.ZodType<McpHttpConfig>,
  credentialsField: 'headers',
  credentialKeys: (config) => config.headers,
  credentialLabel: 'Header value',
  urls: (config) => [config.url],
  async test(context) {
    try {
      const probe = await probeMcpServer({
        url: context.config.url,
        headers: context.credentials,
        allowPrivate: context.allowPrivateNetwork,
        timeoutMs: context.timeoutMs,
        clientVersion: clientVersion.value,
      });
      const count = probe.toolCount;
      return {
        ok: true,
        summary: `Connected${probe.serverName ? ` to ${probe.serverName}` : ''}: ${count} ${count === 1 ? 'tool' : 'tools'}`,
        details: { ...probe },
      };
    } catch (error) {
      if (error instanceof McpProbeError) return { ok: false, summary: error.message };
      throw error;
    }
  },
  mcpServer: (context) => ({ url: context.config.url, headers: context.credentials }),
};
