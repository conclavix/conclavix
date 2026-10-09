import { z } from 'zod';
import type { AgentStatus } from './agent.js';
import { idSchema } from './ids.js';

export const setLeadSchema = z.strictObject({
  agentId: idSchema,
});

export const agentLinkTypeSchema = z.enum(['delegates', 'reports']);

export const createAgentLinkSchema = z.strictObject({
  from: idSchema,
  to: idSchema,
  type: agentLinkTypeSchema,
  /** Reports links only: wake the target when the reporting agent's delegated work closes. */
  wakeOnReport: z.boolean().optional(),
});

export const updateAgentLinkSchema = z.strictObject({
  wakeOnReport: z.boolean(),
});

export const MAX_CANVAS_COORDINATE = 1_000_000;
export const MAX_LAYOUT_POSITIONS = 500;

const coordinateSchema = z.number().min(-MAX_CANVAS_COORDINATE).max(MAX_CANVAS_COORDINATE);

export const setLayoutSchema = z.strictObject({
  positions: z
    .array(z.strictObject({ agentId: idSchema, x: coordinateSchema, y: coordinateSchema }))
    .min(1)
    .max(MAX_LAYOUT_POSITIONS),
});

export type SetLeadInput = z.infer<typeof setLeadSchema>;
export type AgentLinkType = z.infer<typeof agentLinkTypeSchema>;
export type CreateAgentLinkInput = z.infer<typeof createAgentLinkSchema>;
export type UpdateAgentLinkInput = z.infer<typeof updateAgentLinkSchema>;
export type SetLayoutInput = z.infer<typeof setLayoutSchema>;

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  title: string;
}

/**
 * Org-wide configuration. `leadAgentId` is null until a lead is set; while it is null,
 * `leadCandidates` lists the agents nobody delegates to, which the board can pick from.
 */
export interface Org {
  leadAgentId: string | null;
  lead: AgentSummary | null;
  leadCandidates: AgentSummary[];
  updatedAt: Date | null;
}

export interface AgentLink {
  id: string;
  from: string;
  to: string;
  type: AgentLinkType;
  /**
   * Reports links: true wakes the target on its own issue above the closed one, in addition to the
   * notification. Always false on delegates links.
   */
  wakeOnReport: boolean;
  createdAt: Date;
}

export interface CanvasPosition {
  x: number;
  y: number;
}

export interface OrgGraphAgent extends AgentSummary {
  status: AgentStatus;
  adapterType: string;
  model: string | null;
  position: CanvasPosition | null;
}

export interface OrgGraph {
  leadAgentId: string | null;
  agents: OrgGraphAgent[];
  links: AgentLink[];
}

export type PlanningResult =
  | { status: 'created'; issueId: string; issueKey: string; assigneeAgentId: string }
  | { status: 'skipped'; reason: 'disabled' | 'no_lead' };

export type NotificationKind = 'delegation_closed' | 'silent_run';

export interface AgentNotification {
  id: string;
  issueId: string;
  kind: NotificationKind;
  text: string;
  createdAt: Date;
  readAt: Date | null;
}
