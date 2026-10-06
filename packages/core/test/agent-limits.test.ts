import { describe, expect, it } from 'vitest';
import { agentLimitsSchema, createAgentSchema } from '../src/domain/agent.js';

describe('agent limits', () => {
  it('defaults the idle-run limit to 2', () => {
    const created = createAgentSchema.parse({
      name: 'A',
      role: 'x',
      adapter: { type: 'codex_cli' },
    });
    expect(created.limits).toEqual({
      maxIdleRunsPerIssue: 2,
      maxCostPerRunUsd: 2,
      maxCostPerDayUsd: 20,
    });
  });

  it('converts the former maxRunsPerIssuePerHour, capped at the default', () => {
    expect(agentLimitsSchema.parse({ maxRunsPerIssuePerHour: 5 })).toMatchObject({
      maxIdleRunsPerIssue: 2,
    });
    expect(agentLimitsSchema.parse({ maxRunsPerIssuePerHour: 1 })).toMatchObject({
      maxIdleRunsPerIssue: 1,
    });
    expect(
      agentLimitsSchema.parse({ maxRunsPerIssuePerHour: 5, maxIdleRunsPerIssue: 3 }),
    ).toMatchObject({ maxIdleRunsPerIssue: 3 });
    expect(() => agentLimitsSchema.parse({ maxRunsPerIssuePerHour: 0 })).toThrow();
    expect(() => agentLimitsSchema.parse({ maxRunsPerHour: 3 })).toThrow();
  });
});
