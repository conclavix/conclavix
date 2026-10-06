import { z } from 'zod';

export const projectKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,5}$/, 'must be 2-6 uppercase letters or digits, starting with a letter');

export const projectStatusSchema = z.enum(['active', 'archived']);

export const createProjectSchema = z.strictObject({
  key: projectKeySchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  autoPlan: z.boolean().default(true),
});

export const updateProjectSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    status: projectStatusSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** `enabled: null` removes the project's override, so the agent's project default applies again. */
export const setProjectAgentSchema = z.strictObject({
  enabled: z.boolean().nullable(),
});

export type SetProjectAgentInput = z.infer<typeof setProjectAgentSchema>;

/** Where an agent's effective state in a project comes from. */
export type ProjectAgentSource = 'default' | 'project';

export interface ProjectAgentAccess {
  enabled: boolean;
  source: ProjectAgentSource;
}

/**
 * Effective access of an agent to a project: the project's override if there is one, else the
 * agent's project default (missing means 'enabled'). The org lead is always enabled; its source
 * is reported as 'default' because no override can change it.
 */
export function resolveProjectAgentAccess(
  projectDefault: 'enabled' | 'disabled' | undefined,
  override: boolean | null | undefined,
  isLead: boolean,
): ProjectAgentAccess {
  if (isLead) {
    return { enabled: true, source: 'default' };
  }
  if (override !== null && override !== undefined) {
    return { enabled: override, source: 'project' };
  }
  return { enabled: (projectDefault ?? 'enabled') === 'enabled', source: 'default' };
}

/** One agent as seen from a project: its effective state there and its open issues there. */
export interface ProjectAgent extends ProjectAgentAccess {
  id: string;
  name: string;
  role: string;
  title: string;
  status: 'active' | 'paused';
  avatarUrl: string | null;
  projectDefault: 'enabled' | 'disabled';
  /** The project's override, or null when the agent default applies. */
  override: boolean | null;
  isLead: boolean;
  openIssues: number;
}
