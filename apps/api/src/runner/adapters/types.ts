import type { FinishedRunStatus, RunEventData } from '@conclavix/core';
import type { AgentDoc, IssueDoc, RunDoc, RunEventType } from '../../db.js';
import type { CodeRunTarget, SandboxStatus } from './sandbox.js';
import type { RunMcpServer } from '../run-connections.js';

export interface AdapterRunInput {
  run: RunDoc;
  agent: AgentDoc;
  /** Null for chat runs. */
  issue: IssueDoc | null;
  prompt: string;
  workspace: string;
  mcpUrl: string;
  token: string;
  timeoutMs: number;
  /** Set for coding agents: the run works in this issue clone inside the sandbox. */
  code?: CodeRunTarget;
  /** Project secrets for a coding run, by variable name; never passed to read-only runs. */
  secretEnv?: Record<string, string>;
  /** External MCP servers of the agent's connections (docs/connections.md). */
  mcpServers?: RunMcpServer[];
  /** The variables their header references point to. */
  mcpEnv?: Record<string, string>;
  /** Private addresses the coding sandbox lets claude reach for those servers. */
  allowAddresses?: string[];
  onEvent(type: RunEventType, text: string, data?: RunEventData): void;
}

export interface AdapterResult {
  status: Exclude<FinishedRunStatus, 'cancelled'>;
  costUsd: number;
  error?: string;
  /** The final result text of the agent, if it reported one. */
  summary?: string;
  /** What the sandbox helper reported for a coding agent's run. */
  sandbox?: SandboxStatus | null;
}

/** Runs one agent turn for a run and reports what it cost. */
export interface Adapter {
  run(input: AdapterRunInput): Promise<AdapterResult>;
}
