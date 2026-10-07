export interface Agent {
  id: string;
  name: string;
  role: string;
  title: string;
  status: 'active' | 'paused';
  avatarUrl: string | null;
  reportsTo: string | null;
  adapter: { type: string; model?: string };
  limits: { maxIdleRunsPerIssue: number; maxCostPerRunUsd: number; maxCostPerDayUsd: number };
  skillIds?: string[];
  /** Whether the agent may work in projects without an override; missing means enabled. */
  projectDefault?: 'enabled' | 'disabled';
  /** 'write': a coding agent working in the issue clone inside the sandbox; missing means none. */
  codeAccess?: 'none' | 'write';
}

export interface OrgNode {
  id: string;
  name: string;
  role: string;
  title: string;
  status: 'active' | 'paused';
  avatarUrl: string | null;
  reports: OrgNode[];
}

export interface Issue {
  id: string;
  key: string;
  projectId: string;
  title: string;
  description: string;
  status: string;
  columnId?: string | null;
  priority: string;
  parentId: string | null;
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
  /** The issue's branch in the project repository, once its workspace exists. */
  branch?: string | null;
  updatedAt: string;
}

export interface BoardColumn {
  id: string;
  title: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
}

export interface Board {
  projectId: string;
  revision: number;
  columns: BoardColumn[];
}

export interface Run {
  id: string;
  agentId: string;
  /** 'chat' for runs answering a CEO chat; missing on runs from older API responses. */
  kind?: 'issue' | 'chat';
  /** Null for chat runs. */
  issueId: string | null;
  chatId?: string | null;
  reason: string;
  status: string;
  costUsd: number;
  error: string | null;
  /** What a coding agent's run committed; null for other agents. */
  code?: RunCode | null;
  createdAt?: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunCode {
  branch: string;
  base: string | null;
  head: string | null;
  commit: string | null;
  agentCommits: number;
  files: number;
  insertions: number;
  deletions: number;
  synced: boolean;
  error: string | null;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface RunInitData {
  kind: 'init';
  model: string | null;
  cwd: string | null;
  permissionMode: string | null;
  claudeCodeVersion: string | null;
  tools: string[];
  toolsOmitted: number;
  mcpServers: { name: string; status: string }[];
}

export interface RunResultData {
  kind: 'result';
  subtype: string;
  isError: boolean;
  numTurns: number | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  usage: RunUsage | null;
  result: string | null;
}

export type RunEventData =
  | RunInitData
  | RunResultData
  | { kind: 'api_retry'; attempt: number | null; maxRetries: number | null; error: string | null }
  | { kind: 'text'; markdown: string }
  | { kind: 'thinking'; thinking: string }
  | { kind: 'tool_use'; toolUseId: string | null; name: string; input: string }
  | { kind: 'tool_result'; toolUseId: string | null; content: string; isError: boolean };

export interface RunLogLine {
  runId?: string;
  seq: number;
  type: string;
  text: string;
  data?: RunEventData;
  at: string;
}

export interface Comment {
  id: string;
  issueId: string;
  author: { type: string; agentId?: string; userId?: string };
  body: string;
  createdAt?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string | null;
}

export type AgentAdapter =
  | { type: 'claude_cli'; model?: string; gatewayKeySecret?: string }
  | { type: 'codex_cli'; model?: string }
  | { type: 'openai_http'; baseUrl: string; model: string; apiKeySecret?: string };

export interface AgentDetail extends Omit<Agent, 'adapter'> {
  adapter: AgentAdapter;
  instructions: string;
  createdAt: string;
  updatedAt: string;
}
export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  createdAt?: string;
  updatedAt?: string;
}

export interface IssueDetail extends Issue {
  blockedBy: string[];
  labels: string[];
  closedAt: string | null;
}

export interface DocumentSummary {
  key: string;
  issueId: string;
  title: string;
  revision: number;
  updatedAt: string;
}

export interface DocumentRevision extends DocumentSummary {
  body: string;
  author: { type: string; agentId?: string; userId?: string };
  createdAt: string;
}

export interface SkillFile {
  path: string;
  content: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  fileCount: number;
  /** The directory provider an imported skill came from. */
  sourceProvider?: string | null | undefined;
  updatedAt: string;
}

/** Where an imported skill came from. */
export interface SkillProvenance {
  sourceId: string;
  provider: string;
  externalId: string;
  slug: string;
  url: string;
  importedAt: string;
  contentHash: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  files: SkillFile[];
  source?: SkillProvenance | null | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

/** An agent as seen from one project (GET /projects/:id/agents). */
export interface ProjectAgent {
  id: string;
  name: string;
  role: string;
  title: string;
  status: 'active' | 'paused';
  avatarUrl: string | null;
  projectDefault: 'enabled' | 'disabled';
  enabled: boolean;
  source: 'default' | 'project';
  override: boolean | null;
  isLead: boolean;
  openIssues: number;
}
