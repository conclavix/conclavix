import { z } from 'zod';
import { idSchema } from './ids.js';

export const CONNECTION_LIMITS = {
  nameLength: 40,
  credentialValueLength: 8 * 1024,
  credentialsPerConnection: 8,
  agentsPerConnection: 100,
} as const;

export const CONNECTION_SCOPES = ['instance', 'project'] as const;
export type ConnectionScope = (typeof CONNECTION_SCOPES)[number];

/**
 * A connection's name is also the MCP server name and the tool prefix (`mcp__<name>`), so it is
 * short, lower-case and unique on the instance. `conclavix` is the board's own server.
 */
export const connectionNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'lower-case letters, digits and -, starting with a letter')
  .max(CONNECTION_LIMITS.nameLength)
  .refine((name) => name !== 'conclavix', 'conclavix is the board itself');

/** A write-only credential value; null removes it (on update). */
const credentialValueSchema = z
  .string()
  .min(1)
  .max(CONNECTION_LIMITS.credentialValueLength)
  .regex(/^[\t\x20-\x7e]*$/, 'printable ASCII on a single line (an HTTP header value)');

const credentialsSchema = z
  .record(z.string().min(1).max(64), credentialValueSchema)
  .refine(
    (value) => Object.keys(value).length <= CONNECTION_LIMITS.credentialsPerConnection,
    'too many credentials',
  );

const agentIdsSchema = z
  .array(idSchema)
  .max(CONNECTION_LIMITS.agentsPerConnection)
  .transform((ids) => [...new Set(ids)]);

export const createConnectionSchema = z
  .strictObject({
    name: connectionNameSchema,
    type: z.string().min(1).max(40),
    scope: z.enum(CONNECTION_SCOPES),
    /** Required for scope project, absent for scope instance. */
    projectId: idSchema.optional(),
    /** Non-secret settings; validated against the type's schema. */
    config: z.record(z.string(), z.unknown()).default({}),
    /** Secret values by key (for MCP: by header name). */
    credentials: credentialsSchema.default({}),
    agentIds: agentIdsSchema.default([]),
    /** Owners only: allow private, loopback and link-local addresses. */
    allowPrivateNetwork: z.boolean().default(false),
  })
  .refine((value) => (value.scope === 'project') === (value.projectId !== undefined), {
    message: 'projectId is required for project connections and not allowed otherwise',
    path: ['projectId'],
  });

export const updateConnectionSchema = z
  .strictObject({
    name: connectionNameSchema,
    config: z.record(z.string(), z.unknown()),
    /** Keys with a value replace the stored one, null removes it, absent keys stay. */
    credentials: z
      .record(z.string().min(1).max(64), credentialValueSchema.nullable())
      .refine(
        (value) => Object.keys(value).length <= CONNECTION_LIMITS.credentialsPerConnection,
        'too many credentials',
      ),
    agentIds: agentIdsSchema,
    allowPrivateNetwork: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>;

/** The outcome of the last connection test. */
export interface ConnectionTestResult {
  ok: boolean;
  at: Date;
  /** What the test found, e.g. "12 tools", or why it failed; never a credential. */
  summary: string;
  details?: Record<string, unknown>;
}

/** A connection as the API shows it: config and which credentials are set, never their values. */
export interface Connection {
  id: string;
  name: string;
  type: string;
  scope: ConnectionScope;
  projectId: string | null;
  config: Record<string, unknown>;
  credentials: { key: string; set: boolean }[];
  agentIds: string[];
  allowPrivateNetwork: boolean;
  lastTest: ConnectionTestResult | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A connection type as the board sees it, enough to render its form. */
export interface ConnectionTypeInfo {
  id: string;
  label: string;
  description: string;
  /** JSON Schema of the non-secret config, generated from the type's Zod schema. */
  configSchema: Record<string, unknown>;
  /**
   * The config field (an array of strings) whose entries name the credentials, e.g. the header
   * names of an MCP server; the form asks for one write-only value per entry. Null when the type
   * has fixed credentials (`credentialKeys`) or none.
   */
  credentialsField: string | null;
  /** Fixed credential keys, for types whose credentials do not depend on the config. */
  credentialKeys: string[];
  credentialLabel: string;
  /** Whether the type adds an MCP server to the runs of allowed agents. */
  providesMcpServer: boolean;
}
