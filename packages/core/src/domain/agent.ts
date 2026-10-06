import { z } from 'zod';
import { idSchema } from './ids.js';

const modelSchema = z.string().trim().min(1).max(120);

/** The name of a secret held by the runner, never the secret itself. */
export const secretNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'must be the name of a secret, not the key itself');

export const adapterSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('claude_cli'),
    model: modelSchema.optional(),
    gatewayKeySecret: secretNameSchema.optional(),
  }),
  z.strictObject({ type: z.literal('codex_cli'), model: modelSchema.optional() }),
  z.strictObject({
    type: z.literal('openai_http'),
    baseUrl: z.url(),
    model: modelSchema,
    apiKeySecret: secretNameSchema.optional(),
  }),
]);

export const agentLimitsSchema = z.strictObject({
  maxRunsPerIssuePerHour: z.int().min(1).max(60).default(4),
  maxCostPerRunUsd: z.number().positive().max(100).default(2),
  maxCostPerDayUsd: z.number().positive().max(1000).default(20),
});

/** Skills assigned to an agent; the runner mounts exactly these into each run workspace. */
export const skillIdsSchema = z
  .array(idSchema)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, 'must not contain duplicates');

export const agentStatusSchema = z.enum(['active', 'paused']);

/**
 * Whether the agent may work in a project that has no override for it. Agents stored before this
 * field existed have none and count as 'enabled'.
 */
export const projectDefaultSchema = z.enum(['enabled', 'disabled']);

/**
 * What an agent may do with project code. 'none': the read-only tool set in a per-agent run
 * directory. 'write': the agent works in the issue's clone with Edit, Write and Bash, inside the
 * coding-agent sandbox (docs/coding-agents.md). Agents stored before this field count as 'none'.
 */
export const codeAccessSchema = z.enum(['none', 'write']);

export const createAgentSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(80),
  title: z.string().trim().max(120).default(''),
  reportsTo: idSchema.nullable().default(null),
  adapter: adapterSchema,
  limits: agentLimitsSchema.default(agentLimitsSchema.parse({})),
  instructions: z.string().max(20000).default(''),
  skillIds: skillIdsSchema.default([]),
  projectDefault: projectDefaultSchema.default('enabled'),
  codeAccess: codeAccessSchema.default('none'),
});

export const updateAgentSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    role: z.string().trim().min(1).max(80),
    title: z.string().trim().max(120),
    reportsTo: idSchema.nullable(),
    adapter: adapterSchema,
    limits: agentLimitsSchema,
    instructions: z.string().max(20000),
    status: agentStatusSchema,
    skillIds: skillIdsSchema,
    projectDefault: projectDefaultSchema,
    codeAccess: codeAccessSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export type Adapter = z.infer<typeof adapterSchema>;
export type AgentLimits = z.infer<typeof agentLimitsSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type ProjectDefault = z.infer<typeof projectDefaultSchema>;
export type CodeAccess = z.infer<typeof codeAccessSchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

export interface Agent {
  id: string;
  name: string;
  role: string;
  title: string;
  reportsTo: string | null;
  adapter: Adapter;
  limits: AgentLimits;
  instructions: string;
  status: AgentStatus;
  skillIds: string[];
  projectDefault: ProjectDefault;
  codeAccess: CodeAccess;
  avatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrgChartNode {
  id: string;
  name: string;
  role: string;
  title: string;
  status: AgentStatus;
  avatarUrl: string | null;
  reports: OrgChartNode[];
}
