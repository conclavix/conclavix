import { z } from 'zod';
import type { OrgNode } from './types';

const summarySchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  title: z.string(),
});

export const graphAgentSchema = summarySchema.extend({
  status: z.enum(['active', 'paused']),
  avatarUrl: z.string().nullable().exactOptional(),
  adapterType: z.string().exactOptional(),
  model: z.string().nullable(),
  position: z.object({ x: z.number(), y: z.number() }).nullable(),
});

export const agentLinkSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  type: z.enum(['delegates', 'reports']),
  wakeOnReport: z.boolean().exactOptional(),
  createdAt: z.string().exactOptional(),
});

export const orgGraphSchema = z.object({
  leadAgentId: z.string().nullable(),
  agents: z.array(graphAgentSchema),
  links: z.array(agentLinkSchema),
});

const orgNodeSchema: z.ZodType<OrgNode> = summarySchema.extend({
  status: z.enum(['active', 'paused']),
  avatarUrl: z.string().nullable(),
  reports: z.array(z.lazy(() => orgNodeSchema)),
});

export const orgChartSchema = z.object({ roots: z.array(orgNodeSchema) });

export const orgInfoSchema = z.looseObject({
  leadAgentId: z.string().nullable(),
  lead: summarySchema.nullable(),
  leadCandidates: z.array(summarySchema),
});

/** Validate server data without exposing response values in error messages. */
export function parseOrgResponse<T>(schema: z.ZodType<T>, data: unknown, path: string): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`Invalid response from ${path}`);
  return result.data;
}
