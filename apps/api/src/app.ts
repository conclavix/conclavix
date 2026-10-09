import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { registerAgentApi } from './modules/agent-api/route.js';
import { MongoMemoryStore } from './modules/memory/mongo-store.js';
import { registerMemoryRoutes } from './modules/memory/routes.js';
import { MemoryService } from './modules/memory/service.js';
import { registerOverviewRoutes } from './modules/overview/routes.js';
import { OverviewService } from './modules/overview/service.js';
import type { MemoryStore } from './modules/memory/store.js';
import type { Database } from './db.js';
import { registerErrorHandler } from './errors.js';
import { AgentRepository } from './modules/agents/repository.js';
import { agentAvatarOwner, userAvatarOwner } from './modules/avatars/owners.js';
import { AvatarRepository } from './modules/avatars/repository.js';
import { registerAvatarRoutes } from './modules/avatars/routes.js';
import { CommentRepository } from './modules/comments/repository.js';
import { registerCommentRoutes } from './modules/comments/routes.js';
import { registerDecisionRoutes } from './modules/decisions/routes.js';
import { DecisionService } from './modules/decisions/service.js';
import { DocumentRepository } from './modules/documents/repository.js';
import { registerDocumentRoutes } from './modules/documents/routes.js';
import { IssueRepository } from './modules/issues/repository.js';
import { registerIssueRoutes } from './modules/issues/routes.js';
import { registerAgentRoutes } from './modules/agents/routes.js';
import { BoardRepository } from './modules/projects/board.js';
import { registerBoardRoutes } from './modules/projects/board-routes.js';
import { ProjectRepository } from './modules/projects/repository.js';
import { registerProjectRoutes } from './modules/projects/routes.js';
import { registerProjectAgentRoutes } from './modules/projects/agent-routes.js';
import { ProjectAgentsService } from './modules/projects/project-agents.js';
import { OrgRepository } from './modules/org/repository.js';
import { registerOrgRoutes } from './modules/org/routes.js';
import { ProjectPlanner } from './modules/org/planning.js';
import { OrgGraphRepository } from './modules/org/graph.js';
import { migrateReportsToLinks } from './modules/org/migration.js';
import { migrateIdleRunLimit } from './modules/scheduler/limits-migration.js';
import { RunRepository } from './modules/runs/repository.js';
import { SkillRepository } from './modules/skills/repository.js';
import { registerSkillRoutes } from './modules/skills/routes.js';
import { AuditLog } from './modules/audit/audit.js';
import { SecretBox, vaultBox } from './modules/settings/secret-box.js';
import { SecretRepository } from './modules/secrets/repository.js';
import { passwordCheck, registerSecretRoutes } from './modules/secrets/routes.js';
import { registerConnectionRoutes } from './modules/connections/routes.js';
import { ConnectionService } from './modules/connections/service.js';
import { clientVersion } from './modules/connections/types/mcp-http.js';
import { MemoryDirectoryCache, type DirectoryCache } from './modules/skill-sources/cache.js';
import { createGuardedTransport, type HttpTransport } from './modules/skill-sources/http.js';
import { SkillSourceRepository } from './modules/skill-sources/repository.js';
import { registerSkillSourceRoutes } from './modules/skill-sources/routes.js';
import { SkillDirectoryService } from './modules/skill-sources/service.js';
import { registerRunRoutes } from './modules/runs/routes.js';
import { StreamConnections } from './modules/stream/connections.js';
import { StreamHub } from './modules/stream/hub.js';
import { registerStreamRoute } from './modules/stream/route.js';
import { registerWebApp } from './modules/web/route.js';
import { registerWorkspaceRoutes } from './modules/workspace/routes.js';
import type { Workspace } from './modules/workspace/service.js';
import { registerAuditRoutes } from './modules/audit/routes.js';
import {
  registerAccessControl,
  registerPermissionCheck,
  type Reauthorizer,
} from './modules/auth/guard.js';
import { registerOriginCheck } from './modules/auth/origin.js';
import { PrincipalResolver } from './modules/auth/principal.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { createAuthSystem } from './modules/auth/system.js';
import { registerTokenRoutes } from './modules/tokens/routes.js';
import { registerSettingsRoutes } from './modules/settings/routes.js';
import type { SettingsDefaults } from './modules/settings/service.js';
import { migrateThemePreferences, registerMeRoutes } from './modules/users/me-routes.js';
import { registerRoleRoutes } from './modules/users/roles-routes.js';
import { registerUserRoutes } from './modules/users/routes.js';

const DEFAULT_SETTINGS: SettingsDefaults = {
  instanceName: 'Conclavix',
  mfaPolicy: 'required_for_admins',
  models: ['opus', 'sonnet', 'haiku'],
  smtp: { host: null, port: 587, secure: false, user: null, pass: null, from: null },
};

export interface AppOptions {
  version: string;
  database: Database;
  authSecret: string;
  boardToken?: string | undefined;
  boardUrl?: string;
  sessionTtlHours?: number;
  authRateLimit?: boolean;
  settingsDefaults?: Partial<SettingsDefaults>;
  logger?: FastifyServerOptions['logger'];
  webRoot?: string;
  memoryStore?: MemoryStore;
  /** Project repositories and issue clones; without it the code routes answer 503. */
  workspace?: Workspace;
  /** How often an open event stream checks its access again (default one minute). */
  streamRecheckMs?: number;
  /** Builds the cache for skill directory answers (default: in-process). Closed with the app. */
  createDirectoryCache?: (log: FastifyBaseLogger) => DirectoryCache;
  /** Lift the https and private-network rules for skill directories (tests only). */
  skillSourcesAllowPrivate?: boolean;
  /** Replace the HTTP client for skill directories, e.g. with a mock in tests. */
  directoryTransport?: HttpTransport;
  /** Runs when the app closes; registered here because Fastify rejects hooks once the app is ready. */
  onClose?: () => Promise<void> | void;
}

/** Wire better-auth, the principal resolver, access control and the user/admin routes. */
async function registerAuth(
  app: FastifyInstance,
  options: AppOptions,
  streams: StreamConnections,
): Promise<Reauthorizer> {
  const { collections } = options.database;
  const boardUrl = options.boardUrl ?? 'http://127.0.0.1:3300';
  const sessionTtlHours = options.sessionTtlHours ?? 168;

  const system = await createAuthSystem({
    database: options.database,
    secret: options.authSecret,
    boardUrl,
    sessionTtlHours,
    rateLimit: options.authRateLimit ?? true,
    defaults: { ...DEFAULT_SETTINGS, ...options.settingsDefaults },
    log: app.log,
  });
  if (options.boardToken) {
    app.log.warn(
      'BOARD_TOKEN is set: it is deprecated and acts as a break-glass owner; migrate scripts to personal API tokens',
    );
  }
  const resolver = new PrincipalResolver(
    system.auth,
    collections,
    system.tokens,
    options.boardToken,
    app.log,
  );
  const migratedThemes = await migrateThemePreferences(collections);
  if (migratedThemes > 0) {
    app.log.info({ users: migratedThemes }, 'converted theme preferences to { mode }');
  }
  registerOriginCheck(app, boardUrl);
  const reauthorize = registerAccessControl(app, resolver, system.settings);
  registerAuthRoutes(app, system.auth, boardUrl, system.audit, streams);
  registerUserRoutes(app, system.users, streams);
  registerRoleRoutes(app, collections);
  registerMeRoutes(app, collections, system.settings);
  registerTokenRoutes(app, options.database, system.tokens, system.audit, streams);
  registerSettingsRoutes(app, options.database, system.settings, system.audit, {
    sessionTtlHours,
    boardUrl,
  });
  registerAuditRoutes(app, system.audit);
  registerSecretRoutes(
    app,
    options.database,
    new SecretRepository(collections, vaultBox(options.authSecret)),
    system.audit,
    passwordCheck(system.auth, options.database),
  );
  clientVersion.value = options.version;
  registerConnectionRoutes(
    app,
    options.database,
    new ConnectionService(options.database, vaultBox(options.authSecret)),
    system.audit,
  );
  return reauthorize;
}

/** Skill directory sources, browsing and import; API keys share the settings SecretBox. */
function registerSkillDirectories(app: FastifyInstance, options: AppOptions): void {
  const allowPrivate = options.skillSourcesAllowPrivate ?? false;
  const audit = new AuditLog(options.database.collections, app.log);
  const sources = new SkillSourceRepository(
    options.database.collections,
    new SecretBox(options.authSecret),
    allowPrivate,
    app.log,
  );
  const cache = options.createDirectoryCache?.(app.log) ?? new MemoryDirectoryCache();
  app.addHook('onClose', () => cache.close());
  const directory = new SkillDirectoryService({
    database: options.database,
    sources,
    cache,
    transport: options.directoryTransport ?? createGuardedTransport({ allowPrivate }),
    audit,
    userAgent: `Conclavix/${options.version} (+https://github.com/conclavix/conclavix)`,
  });
  registerSkillSourceRoutes(app, options.database, sources, directory, audit);
}

/** Build and ready the API with authentication, error handling, and resource routes. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  const { collections } = options.database;
  const migrated = await migrateReportsToLinks(options.database);
  if (migrated !== null) {
    app.log.info({ agents: migrated }, 'converted reportsTo into agent links');
  }
  const idleLimit = await migrateIdleRunLimit(collections);
  if (idleLimit.agents + idleLimit.wakes > 0) {
    app.log.info(idleLimit, 'converted the hourly run limit into the idle-run limit');
  }

  registerErrorHandler(app);
  registerPermissionCheck(app);
  const streams = new StreamConnections();
  const reauthorize = await registerAuth(app, options, streams);

  app.get('/api/health', async () => ({ status: 'ok', version: options.version }));
  registerProjectRoutes(
    app,
    new ProjectRepository(collections),
    new ProjectPlanner(options.database, new IssueRepository(options.database)),
    options.database,
    options.workspace ?? null,
  );
  registerWorkspaceRoutes(
    app,
    options.workspace ?? null,
    options.database,
    new AuditLog(collections, app.log),
  );
  registerOrgRoutes(
    app,
    new OrgRepository(options.database),
    new OrgGraphRepository(options.database),
  );
  const audit = new AuditLog(collections, app.log);
  registerProjectAgentRoutes(app, new ProjectAgentsService(options.database, audit));
  registerBoardRoutes(app, new BoardRepository(options.database));
  registerAgentRoutes(app, new AgentRepository(options.database), audit);
  registerAvatarRoutes(app, new AvatarRepository(options.database), {
    agent: agentAvatarOwner(collections),
    user: userAvatarOwner(collections),
  });
  registerIssueRoutes(app, new IssueRepository(options.database));
  registerCommentRoutes(app, new CommentRepository(options.database));
  registerDecisionRoutes(app, new DecisionService(options.database));
  registerDocumentRoutes(app, new DocumentRepository(options.database));
  registerRunRoutes(app, new RunRepository(collections));
  registerOverviewRoutes(app, new OverviewService(collections));
  registerSkillRoutes(app, new SkillRepository(options.database));
  registerSkillDirectories(app, options);
  const memories = new MemoryService(
    options.memoryStore ?? new MongoMemoryStore(collections),
    collections,
  );
  registerMemoryRoutes(app, memories);
  registerAgentApi(app, options.database, options.version, memories, options.workspace ?? null);
  const hub = new StreamHub(options.database.db, app.log);
  app.addHook('onClose', () => hub.close());
  const { onClose } = options;
  if (onClose) {
    app.addHook('onClose', async () => {
      await onClose();
    });
  }
  registerStreamRoute(app, hub, {
    connections: streams,
    reauthorize,
    ...(options.streamRecheckMs ? { recheckMs: options.streamRecheckMs } : {}),
  });

  await registerWebApp(app, options.webRoot);

  await app.ready();
  return app;
}
