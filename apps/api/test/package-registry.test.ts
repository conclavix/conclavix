import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { AgentDoc, IssueDoc, RunDoc } from '../src/db.js';
import type { OrgPosition } from '../src/modules/org/position.js';
import { codeClaudeArgs } from '../src/runner/adapters/claude-cli.js';
import {
  packageRegistryOf,
  sandboxCommand,
  type SandboxOptions,
} from '../src/runner/adapters/sandbox.js';
import type { AdapterRunInput } from '../src/runner/adapters/types.js';
import { buildPrompt } from '../src/runner/prompt.js';

const HELPER_ARGS = fileURLToPath(
  new URL('../../../deploy/agent-sandbox/args.mjs', import.meta.url),
);
const REGISTRY = 'http://172.31.250.10:4873/';

const agent = {
  _id: new ObjectId(),
  name: 'Coder',
  role: 'engineer',
  adapter: { type: 'claude_cli' },
} as unknown as AgentDoc;
const issue = { _id: new ObjectId(), key: 'COD-1', title: 'Install it' } as unknown as IssueDoc;
const position: OrgPosition = {
  isLead: false,
  delegators: [],
  delegates: [],
  delegatesNotInProject: [],
  reportsTo: [],
  notifications: [],
};
const input = {
  run: { _id: new ObjectId(), maxCostPerRunUsd: 1 } as unknown as RunDoc,
  agent,
  issue,
  prompt: 'p',
  workspace: '/w',
  mcpUrl: 'http://127.0.0.1:3300/mcp',
  token: 't',
  timeoutMs: 600_000,
  onEvent: () => undefined,
} as AdapterRunInput;
const sandbox: SandboxOptions = {
  helper: '/usr/local/libexec/conclavix/agent-run.mjs',
  sudo: '/usr/bin/sudo',
  limits: { memoryMax: '4G', cpuQuotaPercent: 200, tasksMax: 512, diskLimitMb: 4096 },
  extraDomains: [],
};
const target = { projectId: 'b'.repeat(24), issueKey: 'COD-1', skillsDir: null };
const command = (options: SandboxOptions) =>
  sandboxCommand(options, input, target, codeClaudeArgs(input), 'a'.repeat(32));

interface HelperOptions {
  packageRegistry?: string;
  registryFallback: boolean;
}
const helperParse = async (args: string[]): Promise<HelperOptions> => {
  const helper = (await import(HELPER_ARGS)) as {
    parseRunArgs: (argv: string[]) => HelperOptions;
  };
  return helper.parseRunArgs(args.slice(2));
};

describe('package registry on the runner', () => {
  it('is null without CODE_PACKAGE_REGISTRY', () => {
    expect(
      packageRegistryOf({
        CODE_PACKAGE_REGISTRY: undefined,
        CODE_PACKAGE_REGISTRY_FALLBACK: false,
        CODE_PACKAGE_REGISTRY_SCOPES: [],
      }),
    ).toBeNull();
  });

  it('passes no registry arguments when unset', async () => {
    for (const options of [sandbox, { ...sandbox, packageRegistry: null }]) {
      const { args } = command(options);
      expect(args).not.toContain('--package-registry');
      expect(args).not.toContain('--registry-fallback');
      expect((await helperParse(args)).packageRegistry).toBeUndefined();
    }
  });

  it('passes the registry and the fallback switch, which the helper parses back', async () => {
    const registry = packageRegistryOf({
      CODE_PACKAGE_REGISTRY: REGISTRY,
      CODE_PACKAGE_REGISTRY_FALLBACK: false,
      CODE_PACKAGE_REGISTRY_SCOPES: ['@acme'],
    });
    const only = await helperParse(command({ ...sandbox, packageRegistry: registry }).args);
    expect(only).toMatchObject({ packageRegistry: REGISTRY, registryFallback: false });
    const fallback = await helperParse(
      command({ ...sandbox, packageRegistry: { url: REGISTRY, fallback: true, scopes: [] } }).args,
    );
    expect(fallback).toMatchObject({ packageRegistry: REGISTRY, registryFallback: true });
  });

  it('names the registry and the internal scopes in coding prompts only', () => {
    const registry = { url: REGISTRY, fallback: false, scopes: ['@acme'] };
    const coding = buildPrompt(agent, issue, 'assigned', position, { code: true, registry });
    expect(coding).toContain(`package registry ${REGISTRY}`);
    expect(coding).toContain('Internal packages (@acme/...)');
    expect(coding).toContain('not reachable directly');
    const fallback = buildPrompt(agent, issue, 'assigned', position, {
      code: true,
      registry: { ...registry, fallback: true, scopes: [] },
    });
    expect(fallback).toContain('stays reachable as a fallback');
    expect(fallback).toContain('Internal packages (@<scope>/...)');
    expect(buildPrompt(agent, issue, 'assigned', position, { registry })).not.toContain(REGISTRY);
    expect(buildPrompt(agent, issue, 'assigned', position, { code: true })).not.toContain(
      'package registry',
    );
  });
});
