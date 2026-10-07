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

export const DEFAULT_MAX_IDLE_RUNS_PER_ISSUE = 2;

/** The name the idle-run limit had while it counted every run in a sliding hour. */
const LEGACY_RUN_LIMIT_FIELD = 'maxRunsPerIssuePerHour';

/**
 * The idle-run limit for a value of the former hourly run limit. Loop detection used to pause
 * after 3 idle runs whatever the hourly value was, and the pause now comes one idle run after the
 * limit, so the value is capped at the default: the loop guard of an existing agent never gets
 * weaker by the conversion. A lower value is kept.
 */
export const idleLimitFromLegacy = <T>(legacy: T): T | number =>
  typeof legacy === 'number' ? Math.min(legacy, DEFAULT_MAX_IDLE_RUNS_PER_ISSUE) : legacy;

/**
 * Accept the old field name for the idle-run limit: its value is converted when the new name is
 * absent and dropped otherwise, so older clients keep working.
 */
const renameLegacyRunLimit = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || !(LEGACY_RUN_LIMIT_FIELD in value)) {
    return value;
  }
  const { [LEGACY_RUN_LIMIT_FIELD]: legacy, ...rest } = value as Record<string, unknown>;
  return 'maxIdleRunsPerIssue' in rest
    ? rest
    : { ...rest, maxIdleRunsPerIssue: idleLimitFromLegacy(legacy) };
};

/**
 * Per-agent limits. `maxIdleRunsPerIssue` counts consecutive runs on one issue without progress
 * (see docs/agent-collaboration.md); runs that make progress never count against it. The cost
 * limits are hard brakes independent of progress.
 */
export const agentLimitsSchema = z.preprocess(
  renameLegacyRunLimit,
  z.strictObject({
    maxIdleRunsPerIssue: z.int().min(1).max(60).default(DEFAULT_MAX_IDLE_RUNS_PER_ISSUE),
    maxCostPerRunUsd: z.number().positive().max(100).default(2),
    maxCostPerDayUsd: z.number().positive().max(1000).default(20),
  }),
);

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

/**
 * Whether the agent may integrate branches of its project's repository through the agent API:
 * merge branches into an issue branch (`merge_branches`) and fast-forward main
 * (`promote_branch`). Off by default; agents stored before this field count as false.
 */
export const gitIntegrationSchema = z.boolean();

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
  gitIntegration: gitIntegrationSchema.default(false),
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
    gitIntegration: gitIntegrationSchema,
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
  gitIntegration: boolean;
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
