import { api } from '../api/client';
import type { Agent, AgentDetail, Page } from '../api/types';

export const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const loadAgents = async (): Promise<Agent[]> => (await api<Page<Agent>>('/agents')).items;

export const loadModels = async (): Promise<string[]> =>
  (await api<{ items: string[] }>('/models')).items;

export const patchAgent = (id: string, body: Record<string, unknown>): Promise<AgentDetail> =>
  api<AgentDetail>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
