import { z } from 'zod';
import { apiValidated } from './client';
import { secretAgentSchema } from './secrets';

export const connectionSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string(),
  scope: z.enum(['instance', 'project']),
  projectId: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  credentials: z.array(z.object({ key: z.string(), set: z.boolean() })),
  agentIds: z.array(z.string()),
  allowPrivateNetwork: z.boolean(),
  lastTest: z
    .object({
      ok: z.boolean(),
      at: z.string(),
      summary: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const connectionTypeSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  configSchema: z.record(z.string(), z.unknown()),
  credentialsField: z.string().nullable(),
  credentialKeys: z.array(z.string()),
  credentialLabel: z.string(),
  providesMcpServer: z.boolean(),
});
export type ConnectionTypeInfo = z.infer<typeof connectionTypeSchema>;

const listSchema = z.object({
  items: z.array(connectionSchema),
  types: z.array(connectionTypeSchema),
  agents: z.array(secretAgentSchema),
});
export type ConnectionList = z.infer<typeof listSchema>;

export interface ConnectionInput {
  name?: string;
  type?: string;
  scope?: 'instance' | 'project';
  projectId?: string;
  config?: Record<string, unknown>;
  credentials?: Record<string, string | null>;
  agentIds?: string[];
  allowPrivateNetwork?: boolean;
}

const json = (method: string, body?: object): RequestInit => ({
  method,
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const one = (id: string, rest = '') => `/connections/${encodeURIComponent(id)}${rest}`;

/** Connections to external systems (owners and admins). Credential values are write-only. */
export const connectionsApi = {
  list: (projectId?: string) =>
    apiValidated(
      listSchema,
      projectId ? `/connections?projectId=${encodeURIComponent(projectId)}` : '/connections',
    ),
  create: (input: ConnectionInput) =>
    apiValidated(connectionSchema, '/connections', json('POST', input)),
  update: (id: string, input: ConnectionInput) =>
    apiValidated(connectionSchema, one(id), json('PATCH', input)),
  remove: (id: string) => apiValidated(z.undefined(), one(id), { method: 'DELETE' }),
  test: (id: string) => apiValidated(connectionSchema, one(id, '/test'), json('POST')),
};
