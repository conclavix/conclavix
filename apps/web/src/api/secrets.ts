import { z } from 'zod';
import { apiValidated } from './client';

export const secretSchema = z.object({
  id: z.string().min(1),
  projectId: z.string(),
  name: z.string(),
  envName: z.string(),
  agentIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
  lastUsedRunId: z.string().nullable(),
});
export type Secret = z.infer<typeof secretSchema>;

export const secretAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  codeAccess: z.enum(['none', 'write']),
});
export type SecretAgent = z.infer<typeof secretAgentSchema>;

const listSchema = z.object({ items: z.array(secretSchema), agents: z.array(secretAgentSchema) });

export interface SecretInput {
  name?: string;
  envName?: string;
  value?: string;
  agentIds?: string[];
}

const json = (method: string, body?: object): RequestInit => ({
  method,
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/secrets`;
const one = (projectId: string, id: string, rest = '') =>
  `${base(projectId)}/${encodeURIComponent(id)}${rest}`;

/** Project secrets: metadata for owners and admins, the value only through reveal (owners). */
export const secretsApi = {
  list: (projectId: string) => apiValidated(listSchema, base(projectId)),
  create: (projectId: string, input: SecretInput) =>
    apiValidated(secretSchema, base(projectId), json('POST', input)),
  update: (projectId: string, id: string, input: SecretInput) =>
    apiValidated(secretSchema, one(projectId, id), json('PATCH', input)),
  remove: (projectId: string, id: string) =>
    apiValidated(z.undefined(), one(projectId, id), { method: 'DELETE' }),
  reveal: (projectId: string, id: string, password: string) =>
    apiValidated(
      z.object({ value: z.string() }),
      one(projectId, id, '/reveal'),
      json('POST', { password }),
    ),
};
