import type { Agent, AgentAdapter, AgentDetail } from '../api/types';

export type AdapterType = AgentAdapter['type'];

export const ADAPTER_TYPES: { value: AdapterType; title: string }[] = [
  { value: 'claude_cli', title: 'Claude CLI' },
  { value: 'codex_cli', title: 'Codex CLI' },
  { value: 'openai_http', title: 'OpenAI-compatible HTTP' },
];

export interface AgentLimitsForm {
  maxRunsPerIssuePerHour: number;
  maxCostPerRunUsd: number;
  maxCostPerDayUsd: number;
}

export interface AgentForm {
  name: string;
  role: string;
  title: string;
  reportsTo: string | null;
  adapterType: AdapterType;
  model: string;
  baseUrl: string;
  /** Name of the runner secret: gatewayKeySecret (claude_cli) or apiKeySecret (openai_http). */
  secret: string;
  limits: AgentLimitsForm;
  instructions: string;
  /** Whether the agent may work in projects that do not override it. */
  projectDefault: 'enabled' | 'disabled';
  /** 'write': the agent edits and runs code in the issue clone, inside the sandbox. */
  codeAccess: 'none' | 'write';
}

export const DEFAULT_LIMITS: AgentLimitsForm = {
  maxRunsPerIssuePerHour: 4,
  maxCostPerRunUsd: 2,
  maxCostPerDayUsd: 20,
};

export const emptyForm = (): AgentForm => ({
  name: '',
  role: '',
  title: '',
  reportsTo: null,
  adapterType: 'claude_cli',
  model: '',
  baseUrl: '',
  secret: '',
  limits: { ...DEFAULT_LIMITS },
  instructions: '',
  projectDefault: 'enabled',
  codeAccess: 'none',
});

export function formFromAgent(agent: AgentDetail): AgentForm {
  const { adapter } = agent;
  return {
    name: agent.name,
    role: agent.role,
    title: agent.title,
    reportsTo: agent.reportsTo,
    adapterType: adapter.type,
    model: adapter.model ?? '',
    baseUrl: adapter.type === 'openai_http' ? adapter.baseUrl : '',
    secret:
      (adapter.type === 'claude_cli' && adapter.gatewayKeySecret) ||
      (adapter.type === 'openai_http' && adapter.apiKeySecret) ||
      '',
    limits: { ...agent.limits },
    instructions: agent.instructions,
    projectDefault: agent.projectDefault ?? 'enabled',
    codeAccess: agent.codeAccess ?? 'none',
  };
}

/** Build the adapter the API expects; its schemas are strict, so empty optionals are left out. */
export function adapterFromForm(form: AgentForm): AgentAdapter {
  const model = form.model.trim();
  const secret = form.secret.trim();
  switch (form.adapterType) {
    case 'claude_cli':
      return {
        type: 'claude_cli',
        ...(model ? { model } : {}),
        ...(secret ? { gatewayKeySecret: secret } : {}),
      };
    case 'codex_cli':
      return { type: 'codex_cli', ...(model ? { model } : {}) };
    case 'openai_http':
      return {
        type: 'openai_http',
        baseUrl: form.baseUrl.trim(),
        model,
        ...(secret ? { apiKeySecret: secret } : {}),
      };
  }
}

const limitsFromForm = (limits: AgentLimitsForm): AgentLimitsForm => ({
  maxRunsPerIssuePerHour: Number(limits.maxRunsPerIssuePerHour),
  maxCostPerRunUsd: Number(limits.maxCostPerRunUsd),
  maxCostPerDayUsd: Number(limits.maxCostPerDayUsd),
});

/** Fields the settings tab edits; instructions belong to the rules tab and status to its toggle. */
export function settingsPayload(form: AgentForm) {
  return {
    name: form.name.trim(),
    role: form.role.trim(),
    title: form.title.trim(),
    reportsTo: form.reportsTo,
    adapter: adapterFromForm(form),
    limits: limitsFromForm(form.limits),
    projectDefault: form.projectDefault,
    codeAccess: form.codeAccess,
  };
}

export const createPayload = (form: AgentForm) => ({
  ...settingsPayload(form),
  instructions: form.instructions,
});

/** Agents that may become the manager of `selfId`: not itself and none of its reports. */
export function managerCandidates(agents: Agent[], selfId: string | null): Agent[] {
  if (!selfId) {
    return agents;
  }
  const excluded = new Set([selfId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const agent of agents) {
      if (agent.reportsTo && excluded.has(agent.reportsTo) && !excluded.has(agent.id)) {
        excluded.add(agent.id);
        grew = true;
      }
    }
  }
  return agents.filter((agent) => !excluded.has(agent.id));
}

export const adapterLabel = (adapter: { type: string; model?: string }): string =>
  adapter.model ? `${adapter.type} · ${adapter.model}` : adapter.type;

type Rule = (value: unknown) => true | string;

const text = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

export const rules = {
  required: ((value) => text(value).trim().length > 0 || 'Required') as Rule,
  maxLength:
    (max: number): Rule =>
    (value) =>
      text(value).trim().length <= max || `At most ${max} characters`,
  secretName: ((value) =>
    text(value).trim() === '' ||
    /^[A-Z][A-Z0-9_]{1,63}$/.test(text(value).trim()) ||
    'The NAME of a runner secret (e.g. GATEWAY_KEY_CTO), never the key itself') as Rule,
  url: ((value) => {
    try {
      const url = new URL(text(value).trim());
      return url.protocol === 'http:' || url.protocol === 'https:' || 'Must be an http(s) URL';
    } catch {
      return 'Must be a URL';
    }
  }) as Rule,
  range:
    (min: number, max: number, integer = false): Rule =>
    (value) => {
      const number = Number(value);
      if (text(value).trim() === '' || Number.isNaN(number)) return 'Required';
      if (integer && !Number.isInteger(number)) return 'Must be a whole number';
      return (number >= min && number <= max) || `Between ${min} and ${max}`;
    },
};

/** Duration like "45s", "3m 12s" or "1h 4m" between two timestamps; empty while unknown. */
export function duration(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
  now = Date.now(),
): string {
  if (!startedAt) return '';
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  const seconds = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
