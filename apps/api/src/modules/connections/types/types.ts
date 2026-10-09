import type { z } from 'zod';

/** What a connection test reports; `summary` is shown on the board, never a credential. */
export interface TestOutcome {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

/** One connection as a type sees it: its validated config and its decrypted credentials. */
export interface ConnectionContext<C> {
  name: string;
  config: C;
  credentials: Record<string, string>;
  allowPrivateNetwork: boolean;
  timeoutMs: number;
}

/** An MCP server a connection adds to a run; header values are the plaintext credentials. */
export interface McpServerSpec {
  url: string;
  headers: Record<string, string>;
}

/**
 * A connection type: one module with the config schema, the credentials it needs, a test and,
 * optionally, what it gives the agents allowed to use it (today: an MCP server). Register it in
 * types/index.ts; docs/connections.md describes how to add one.
 */
export interface ConnectionType<C = Record<string, unknown>> {
  id: string;
  label: string;
  description: string;
  /** Non-secret settings; parsed on every save and before every use. */
  configSchema: z.ZodType<C>;
  /** The config field (string array) whose entries name the credentials, or null. */
  credentialsField: string | null;
  /** The credential keys a config needs (all are required to use the connection). */
  credentialKeys(config: C): string[];
  credentialLabel: string;
  /** Every URL the connection calls, for the SSRF guard. */
  urls(config: C): string[];
  test(context: ConnectionContext<C>): Promise<TestOutcome>;
  /** The MCP server for the runs of allowed agents; absent for types without agent tools. */
  mcpServer?(context: ConnectionContext<C>): McpServerSpec;
}
