import { describe, expect, it } from 'vitest';
import { resolveProjectAgentAccess } from '../src/domain/project.js';
import { createAgentSchema, updateAgentSchema } from '../src/domain/agent.js';

describe('project agent access', () => {
  it('uses the override first, then the agent default, missing default meaning enabled', () => {
    expect(resolveProjectAgentAccess(undefined, undefined, false)).toEqual({
      enabled: true,
      source: 'default',
    });
    expect(resolveProjectAgentAccess('disabled', null, false)).toEqual({
      enabled: false,
      source: 'default',
    });
    expect(resolveProjectAgentAccess('disabled', true, false)).toEqual({
      enabled: true,
      source: 'project',
    });
    expect(resolveProjectAgentAccess('enabled', false, false)).toEqual({
      enabled: false,
      source: 'project',
    });
  });

  it('always enables the lead, whatever is stored', () => {
    expect(resolveProjectAgentAccess('disabled', false, true)).toEqual({
      enabled: true,
      source: 'default',
    });
  });

  it('defaults new agents to enabled and accepts the field on update', () => {
    const created = createAgentSchema.parse({
      name: 'Rev',
      role: 'reviewer',
      adapter: { type: 'claude_cli' },
    });
    expect(created.projectDefault).toBe('enabled');
    expect(updateAgentSchema.parse({ projectDefault: 'disabled' })).toEqual({
      projectDefault: 'disabled',
    });
    expect(() => updateAgentSchema.parse({ projectDefault: 'maybe' })).toThrow();
  });
});
