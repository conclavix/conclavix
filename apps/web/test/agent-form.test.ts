import { describe, expect, it } from 'vitest';
import {
  adapterFromForm,
  createPayload,
  duration,
  emptyForm,
  formFromAgent,
  managerCandidates,
  rules,
  settingsPayload,
} from '../src/agents/form';
import type { Agent, AgentDetail } from '../src/api/types';

const agent = (id: string, reportsTo: string | null): Agent => ({
  id,
  name: id,
  role: 'r',
  title: '',
  status: 'active',
  reportsTo,
  adapter: { type: 'claude_cli' },
  limits: { maxIdleRunsPerIssue: 4, maxCostPerRunUsd: 2, maxCostPerDayUsd: 20 },
});

describe('agent form', () => {
  it('leaves empty optional adapter fields out because the API schemas are strict', () => {
    expect(adapterFromForm(emptyForm())).toEqual({ type: 'claude_cli' });
    expect(
      adapterFromForm({ ...emptyForm(), adapterType: 'codex_cli', model: ' o4 ', secret: 'X_KEY' }),
    ).toEqual({ type: 'codex_cli', model: 'o4' });
  });

  it('maps the secret name to the field of the chosen adapter', () => {
    const form = { ...emptyForm(), model: 'claude-opus-5-5', secret: 'GW_CTO' };
    expect(adapterFromForm(form)).toEqual({
      type: 'claude_cli',
      model: 'claude-opus-5-5',
      gatewayKeySecret: 'GW_CTO',
    });
    expect(
      adapterFromForm({ ...form, adapterType: 'openai_http', baseUrl: 'https://llm.example/v1' }),
    ).toEqual({
      type: 'openai_http',
      baseUrl: 'https://llm.example/v1',
      model: 'claude-opus-5-5',
      apiKeySecret: 'GW_CTO',
    });
  });

  it('round-trips an agent through the form', () => {
    const detail: AgentDetail = {
      ...agent('a1', 'boss'),
      name: 'CTO',
      title: 'Chief',
      adapter: {
        type: 'openai_http',
        baseUrl: 'https://x.example',
        model: 'm',
        apiKeySecret: 'K1',
      },
      instructions: '# Rules',
      createdAt: '',
      updatedAt: '',
    };
    const form = formFromAgent(detail);
    expect(form).toMatchObject({
      adapterType: 'openai_http',
      secret: 'K1',
      baseUrl: 'https://x.example',
    });
    expect(settingsPayload(form)).toEqual({
      name: 'CTO',
      role: 'r',
      title: 'Chief',
      reportsTo: 'boss',
      adapter: detail.adapter,
      limits: detail.limits,
      projectDefault: 'enabled',
      codeAccess: 'none',
      gitIntegration: false,
    });
    expect(createPayload(form).instructions).toBe('# Rules');
    expect(formFromAgent({ ...detail, gitIntegration: true }).gitIntegration).toBe(true);
    expect(emptyForm().gitIntegration).toBe(false);
    expect(formFromAgent({ ...detail, codeAccess: 'write' }).codeAccess).toBe('write');
    expect(emptyForm().codeAccess).toBe('none');
    expect(formFromAgent({ ...detail, projectDefault: 'disabled' }).projectDefault).toBe(
      'disabled',
    );
    expect(emptyForm().projectDefault).toBe('enabled');
  });

  it('coerces limits typed into number fields', () => {
    const form = emptyForm();
    form.limits = {
      maxIdleRunsPerIssue: '6' as unknown as number,
      maxCostPerRunUsd: 1.5,
      maxCostPerDayUsd: 10,
    };
    expect(settingsPayload(form).limits).toEqual({
      maxIdleRunsPerIssue: 6,
      maxCostPerRunUsd: 1.5,
      maxCostPerDayUsd: 10,
    });
  });

  it('offers neither the agent itself nor anyone below it as manager', () => {
    const all = [agent('ceo', null), agent('cto', 'ceo'), agent('dev', 'cto'), agent('cfo', 'ceo')];
    expect(managerCandidates(all, 'cto').map((a) => a.id)).toEqual(['ceo', 'cfo']);
    expect(managerCandidates(all, null)).toHaveLength(4);
  });
});

describe('agent form rules', () => {
  it('accepts secret names and rejects anything that looks like a key', () => {
    expect(rules.secretName('')).toBe(true);
    expect(rules.secretName('GATEWAY_KEY_CTO')).toBe(true);
    expect(rules.secretName('sk-abc123')).toMatch(/NAME of a runner secret/);
  });

  it('validates URLs and numeric ranges', () => {
    expect(rules.url('https://llm.example/v1')).toBe(true);
    expect(rules.url('ftp://x')).not.toBe(true);
    expect(rules.url('nope')).not.toBe(true);
    expect(rules.range(1, 60, true)(4)).toBe(true);
    expect(rules.range(1, 60, true)(2.5)).toBe('Must be a whole number');
    expect(rules.range(0.01, 100)('')).toBe('Required');
    expect(rules.range(0.01, 100)(200)).toBe('Between 0.01 and 100');
  });
});

describe('duration', () => {
  it('formats finished and running runs', () => {
    const start = '2026-01-01T00:00:00Z';
    expect(duration(start, '2026-01-01T00:00:45Z')).toBe('45s');
    expect(duration(start, '2026-01-01T00:03:12Z')).toBe('3m 12s');
    expect(duration(start, null, Date.parse('2026-01-01T01:04:00Z'))).toBe('1h 4m');
    expect(duration(null, null)).toBe('');
  });
});
