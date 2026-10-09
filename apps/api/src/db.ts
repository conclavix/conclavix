import { ensureIndexes } from './db/indexes.js';
import {
  MongoClient,
  type Binary,
  type ClientSession,
  type Collection,
  type Db,
  type ObjectId,
} from 'mongodb';
import type {
  Adapter,
  Author,
  AgentLimits,
  AgentLinkType,
  AgentStatus,
  BoardColumn,
  IssuePriority,
  IssueStatus,
  MemoryAuthor,
  MfaPolicy,
  NotificationKind,
  Preferences,
  ProjectDefault,
  CodeAccess,
  Role,
  ProjectStatus,
  RunEventData,
  RunCode,
  RunEventType,
  RunStatus,
  SkillFile,
  WakeReason,
  WakeDeferReason,
  WakeSkipReason,
} from '@conclavix/core';
import type { SkillProvenanceDoc, SkillSourceDoc } from './db/skill-sources.js';

export type { SkillProvenanceDoc, SkillSourceDoc } from './db/skill-sources.js';

export interface ProjectDoc {
  _id: ObjectId;
  key: string;
  name: string;
  description: string;
  status: ProjectStatus;
  board?: ProjectBoardDoc;
  /** Per-agent overrides of the agents' project default; at most one entry per agent. */
  agentOverrides?: ProjectAgentOverrideDoc[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectAgentOverrideDoc {
  agentId: ObjectId;
  enabled: boolean;
  updatedAt: Date;
}

export interface ProjectBoardDoc {
  revision: number;
  columns: BoardColumn[];
}

export interface AgentDoc {
  _id: ObjectId;
  name: string;
  role: string;
  title: string;
  reportsTo: ObjectId | null;
  adapter: Adapter;
  limits: AgentLimits;
  instructions: string;
  status: AgentStatus;
  skillIds?: ObjectId[];
  /** Missing on agents stored before per-project access existed; they count as 'enabled'. */
  projectDefault?: ProjectDefault;
  /** Missing on agents stored before coding agents existed; they count as 'none'. */
  codeAccess?: CodeAccess;
  /** Missing on agents stored before git integration existed; they count as false. */
  gitIntegration?: boolean;
  createdAt: Date;
  updatedAt: Date;
  avatarEtag?: string | null;
}

export interface IssueDoc {
  _id: ObjectId;
  projectId: ObjectId;
  key: string;
  number: number;
  title: string;
  description: string;
  status: IssueStatus;
  columnId?: string | null;
  priority: IssuePriority;
  parentId: ObjectId | null;
  assigneeAgentId: ObjectId | null;
  blockedBy: ObjectId[];
  labels: string[];
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  checkoutRunId: ObjectId | null;
  progress: number;
  lastRunAt: Date | null;
  delegatedBy?: ObjectId | null;
  delegatedFromIssueId?: ObjectId | null;
  branch?: string | null;
  /** The clone the workspace audit entry was written for (see recordIssueWorkspace). */
  workspaceCloneId?: string | null;
  /** How often agents reopened the issue with reopen_issue; capped, the board is not counted. */
  agentReopens?: number;
}

export interface WakeDoc {
  _id: ObjectId;
  agentId: ObjectId;
  issueId: ObjectId;
  reason: WakeReason;
  createdAt: Date;
  processedAt: Date | null;
  runId: ObjectId | null;
  skipReason: WakeSkipReason | null;
  /** Set while the wake waits for a rate or budget window; absent on older wakes. */
  notBefore?: Date | null;
  deferReason?: WakeDeferReason | null;
  /** True once the board woke the agent manually; such a wake skips the idle backoff. */
  boardWake?: boolean;
}

export interface RunDoc {
  _id: ObjectId;
  agentId: ObjectId;
  issueId: ObjectId;
  reason: WakeReason;
  status: RunStatus;
  costUsd: number;
  maxCostPerRunUsd: number;
  overBudget: boolean;
  progressAtStart: number;
  madeProgress: boolean | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  tokenHash: string | null;
  tokenExpiresAt: Date | null;
  /** Set by the runner for agents with code access 'write'. */
  code?: RunCode | null;
}

export type { RunEventType } from '@conclavix/core';

export interface RunEventDoc {
  _id: ObjectId;
  runId: ObjectId;
  seq: number;
  type: RunEventType;
  text: string;
  data?: RunEventData;
  at: Date;
}

export interface CommentDoc {
  _id: ObjectId;
  issueId: ObjectId;
  author: Author;
  body: string;
  createdAt: Date;
}

export interface DocumentDoc {
  _id: ObjectId;
  issueId: ObjectId;
  key: string;
  title: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RevisionDoc {
  _id: ObjectId;
  documentId: ObjectId;
  revision: number;
  title: string;
  body: string;
  author: Author;
  createdAt: Date;
}

export interface MemoryDoc {
  _id: ObjectId;
  scope: 'global' | 'project' | 'agent';
  projectId: string | null;
  agentId: string | null;
  titleKey: string;
  title: string;
  body: string;
  tags: string[];
  author: MemoryAuthor;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillDoc {
  _id: ObjectId;
  name: string;
  description: string;
  body: string;
  files: SkillFile[];
  source?: SkillProvenanceDoc;
  createdAt: Date;
  updatedAt: Date;
}

export type AvatarOwnerType = 'agent' | 'user';

export interface AvatarDoc {
  _id: ObjectId;
  owner: { type: AvatarOwnerType; id: string };
  contentType: string;
  data: Binary;
  size: number;
  width: number;
  height: number;
  etag: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CounterDoc {
  _id: string;
  value: number;
}

export const ORG_DOC_ID = 'org';

export interface OrgDoc {
  _id: typeof ORG_DOC_ID;
  leadAgentId: ObjectId | null;
  linksMigratedAt?: Date;
  updatedAt: Date;
}

export interface AgentLinkDoc {
  _id: ObjectId;
  from: ObjectId;
  to: ObjectId;
  type: AgentLinkType;
  /** Reports links only; missing on links stored before the option existed (= false). */
  wakeOnReport?: boolean;
  createdAt: Date;
}

export interface LayoutDoc {
  _id: ObjectId;
  x: number;
  y: number;
  updatedAt: Date;
}

export interface NotificationDoc {
  _id: ObjectId;
  agentId: ObjectId;
  issueId: ObjectId;
  kind: NotificationKind;
  text: string;
  createdAt: Date;
  readAt: Date | null;
}

export interface LockDoc {
  _id: string;
  version: number;
  wakeCursor?: ObjectId | null;
}

/** The better-auth user document, read and updated natively for roles and bans. */
export interface UserDoc {
  _id: ObjectId;
  email: string;
  name: string;
  emailVerified: boolean;
  role: Role;
  banned: boolean;
  twoFactorEnabled?: boolean;
  preferences?: Partial<Preferences>;
  avatarEtag?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionDoc {
  _id: ObjectId;
  userId: ObjectId;
  token: string;
  expiresAt: Date;
}

export interface ApiTokenDoc {
  _id: ObjectId;
  userId: ObjectId;
  name: string;
  prefix: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

export interface SmtpSettingsDoc {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  passEncrypted?: string;
  from?: string;
}

export interface SettingsDoc {
  _id: string;
  instanceName?: string;
  mfaPolicy?: MfaPolicy;
  models?: string[];
  smtp?: SmtpSettingsDoc;
  updatedAt: Date;
}

/** Board-side authors of an audit entry; agents acting through the agent API are added below. */
type BoardActor = { type: 'user'; userId: string } | { type: 'board' } | { type: 'system' };

export interface AuditDoc {
  _id: ObjectId;
  at: Date;
  action: string;
  actor: BoardActor | { type: 'agent'; agentId: string; name: string } | null;
  targetUserId: string | null;
  ip: string | null;
  details: Record<string, unknown>;
}

export interface Collections {
  projects: Collection<ProjectDoc>;
  agents: Collection<AgentDoc>;
  issues: Collection<IssueDoc>;
  wakes: Collection<WakeDoc>;
  runs: Collection<RunDoc>;
  runEvents: Collection<RunEventDoc>;
  comments: Collection<CommentDoc>;
  documents: Collection<DocumentDoc>;
  revisions: Collection<RevisionDoc>;
  memories: Collection<MemoryDoc>;
  skills: Collection<SkillDoc>;
  avatars: Collection<AvatarDoc>;
  counters: Collection<CounterDoc>;
  locks: Collection<LockDoc>;
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  apiTokens: Collection<ApiTokenDoc>;
  settings: Collection<SettingsDoc>;
  audit: Collection<AuditDoc>;
  org: Collection<OrgDoc>;
  agentLinks: Collection<AgentLinkDoc>;
  orgLayout: Collection<LayoutDoc>;
  notifications: Collection<NotificationDoc>;
  skillSources: Collection<SkillSourceDoc>;
  secrets: Collection<import('./db/secrets.js').SecretDoc>;
}

export interface Database {
  db: Db;
  client: MongoClient;
  collections: Collections;
  inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Names of the lock documents that serialize changes to shared invariants. */
export const LOCKS = {
  orgChart: 'org-chart',
  issueGraph: 'issue-graph',
  pendingWakes: 'pending-wakes',
  owners: 'owners',
  skillAssignments: 'skill-assignments',
} as const;

/** Lock serializing a project's board layout against issue column moves. */
export const boardLock = (projectId: ObjectId): string =>
  `project-board:${projectId.toHexString()}`;

/** Write a named lock document within a transaction to serialize competing changes. */
export async function lock(
  collections: Collections,
  name: string,
  session: ClientSession,
): Promise<void> {
  await collections.locks.updateOne(
    { _id: name },
    { $inc: { version: 1 } },
    { upsert: true, session },
  );
}

/** True on a replica set member or mongos, where multi-document transactions work. */
export async function supportsTransactions(db: Db): Promise<boolean> {
  const hello = await db.admin().command({ hello: 1 });
  return typeof hello['setName'] === 'string' || hello['msg'] === 'isdbgrid';
}

/**
 * Connect to MongoDB and initialize indexes, closing the client if initialization fails.
 * Transactions require a replica set; the caller must close the returned database.
 */
export async function connectDatabase(uri: string): Promise<Database> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const db = client.db();
    const collections: Collections = {
      projects: db.collection<ProjectDoc>('projects'),
      agents: db.collection<AgentDoc>('agents'),
      issues: db.collection<IssueDoc>('issues'),
      wakes: db.collection<WakeDoc>('wakes'),
      runs: db.collection<RunDoc>('runs'),
      runEvents: db.collection<RunEventDoc>('run_events'),
      comments: db.collection<CommentDoc>('comments'),
      documents: db.collection<DocumentDoc>('documents'),
      revisions: db.collection<RevisionDoc>('revisions'),
      memories: db.collection<MemoryDoc>('memories'),
      skills: db.collection<SkillDoc>('skills'),
      avatars: db.collection<AvatarDoc>('avatars'),
      counters: db.collection<CounterDoc>('counters'),
      locks: db.collection<LockDoc>('locks'),
      users: db.collection<UserDoc>('user'),
      sessions: db.collection<SessionDoc>('session'),
      apiTokens: db.collection<ApiTokenDoc>('api_tokens'),
      settings: db.collection<SettingsDoc>('settings'),
      audit: db.collection<AuditDoc>('audit_log'),
      org: db.collection<OrgDoc>('org'),
      agentLinks: db.collection<AgentLinkDoc>('agent_links'),
      orgLayout: db.collection<LayoutDoc>('org_layout'),
      notifications: db.collection<NotificationDoc>('notifications'),
      skillSources: db.collection<SkillSourceDoc>('skill_sources'),
      secrets: db.collection('secrets'),
    };
    await ensureIndexes(collections);
    return {
      db,
      client,
      collections,
      /** Run work in a managed session and transaction with MongoDB retry handling. */
      inTransaction: (work) => client.withSession((session) => session.withTransaction(work)),
      /** Close the MongoDB client and its connection pool. */
      close: () => client.close(),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}
