import type { FinishedRunStatus, RunEventData } from '@conclavix/core';
import type { AgentDoc, IssueDoc, RunDoc, RunEventType } from '../../db.js';
import type { CodeRunTarget, SandboxStatus } from './sandbox.js';

export interface AdapterRunInput {
  run: RunDoc;
  agent: AgentDoc;
  issue: IssueDoc;
  prompt: string;
  workspace: string;
  mcpUrl: string;
  token: string;
  timeoutMs: number;
  /** Set for coding agents: the run works in this issue clone inside the sandbox. */
  code?: CodeRunTarget;
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
