import { z } from 'zod';
import { mfaPolicySchema } from './domain/user.js';
import { hasControlCharacter } from './domain/workspace.js';

/**
 * Comma-separated model names offered as suggestions in the board UI; blanks are dropped. This is
 * the ENV fallback of the `models` instance setting, which admins can override in the board.
 */
const modelListSchema = z
  .string()
  .default('opus,sonnet,haiku')
  .transform((value) =>
    value
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .max(120)
          .regex(/^[\w.:/@-]+$/, 'must be a model name'),
      )
      .max(50),
  );

const baseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3300),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MONGO_URI: z.url().default('mongodb://127.0.0.1:27017/conclavix'),
  REDIS_URL: z.url().default('redis://127.0.0.1:6379'),
  BOARD_TOKEN: z.string().min(32, 'must be at least 32 characters').optional(),
  AUTH_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  PUBLIC_API_URL: z.url().default('http://127.0.0.1:3300'),
  BOARD_URL: z.url().optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(2160).default(168),
  MFA_POLICY: mfaPolicySchema.default('required_for_admins'),
  INSTANCE_NAME: z.string().trim().min(1).max(80).default('Conclavix'),
  SMTP_HOST: z.string().trim().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.stringbool().default(false),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  SMTP_FROM: z.string().trim().min(3).optional(),
  WORKSPACES_ROOT: z.string().min(1).default('./workspaces'),
  WORKSPACE_ROOT: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine((value) => !hasControlCharacter(value), 'must not contain control characters')
    .default('./data/workspace'),
  GIT_BIN: z.string().min(1).default('git'),
  /** Domain of the no-reply addresses agents commit and merge with: `agent-<id>@<domain>`. */
  AGENT_EMAIL_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(
      /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      'must be a domain name such as users.noreply.example.com',
    )
    .default('conclavix.invalid'),
  /** Root helper that runs coding agents in their sandbox (deploy/agent-sandbox). Unset: off. */
  AGENT_SANDBOX_HELPER: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .regex(/^\/[\w./-]+$/, 'must be an absolute path')
      .optional(),
  ),
  CODE_RUN_MEMORY_MAX: z
    .string()
    .regex(/^[1-9][0-9]{0,5}[MG]$/, 'must look like 4G or 512M')
    .default('4G'),
  CODE_RUN_CPU_QUOTA: z.coerce.number().int().min(10).max(6400).default(200),
  CODE_RUN_TASKS_MAX: z.coerce.number().int().min(16).max(65536).default(512),
  CODE_RUN_DISK_LIMIT_MB: z.coerce.number().int().min(16).max(1048576).default(4096),
  /** Hosts sandboxed commands may reach on top of the package registries, comma-separated. */
  CODE_SANDBOX_DOMAINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host.length > 0),
    )
    .pipe(
      z
        .array(
          z
            .string()
            .max(253)
            .regex(
              /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
              'must be a host name such as registry.yarnpkg.com',
            ),
        )
        .max(50),
    ),
  WEB_ROOT: z.string().min(1).optional(),
  MEMORY_BACKEND: z.enum(['builtin', 'hindsight']).default('builtin'),
  HINDSIGHT_URL: z.url().optional(),
  HINDSIGHT_BANK: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .default('conclavix'),
  HINDSIGHT_API_KEY: z.string().min(1).optional(),
  CLAUDE_BIN: z.string().min(1).default('claude'),
  AGENT_USER: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'must be a plain user name')
      .optional(),
  ),
  SUDO_BIN: z.string().min(1).default('/usr/bin/sudo'),
  RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  RUN_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(30),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(250).max(60000).default(2000),
  STARTUP_WAIT_SECONDS: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().int().min(0).max(3600).default(120),
  ),
  HEARTBEAT_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /**
   * Stall watchdog interval: issues an agent could work on but where nothing happened for this
   * long get one `stall_watchdog` wake. 0 turns the watchdog off.
   */
  STALL_WATCHDOG_MINUTES: z.coerce.number().int().min(0).max(1440).default(5),
  /** How long an agent waits on an issue after `maxIdleRunsPerIssue` runs without progress. */
  IDLE_BACKOFF_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  /**
   * Hard cap on runs of one agent on one issue in 24 hours, progress or not: a backstop for loops
   * whose runs look like progress. High enough that productive work does not reach it.
   */
  MAX_RUNS_PER_ISSUE_PER_DAY: z.coerce.number().int().min(1).max(1000).default(50),
  CONCLAVIX_MODELS: modelListSchema,
  /** Lets skill directory sources use plain http and private addresses; for local tests only. */
  SKILL_SOURCES_ALLOW_PRIVATE: z.stringbool().default(false),
});

const configSchema = baseConfigSchema.refine(
  (config) => config.MEMORY_BACKEND !== 'hindsight' || config.HINDSIGHT_URL !== undefined,
  { message: 'HINDSIGHT_URL is required when MEMORY_BACKEND=hindsight', path: ['HINDSIGHT_URL'] },
);

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** The API signs sessions with AUTH_SECRET; the scheduler and runner do not need it. */
export function requireAuthSecret(config: Config): string {
  if (!config.AUTH_SECRET) {
    throw new ConfigError(['AUTH_SECRET: required by the API (openssl rand -hex 32)']);
  }
  return config.AUTH_SECRET;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}

/** Warnings for database URLs without credentials; the deployment runs both with authentication. */
export function credentialWarnings(
  config: Partial<Pick<Config, 'MONGO_URI' | 'REDIS_URL'>>,
): string[] {
  const warnings: string[] = [];
  const mongo = config.MONGO_URI === undefined ? undefined : new URL(config.MONGO_URI);
  if (mongo && (!mongo.username || !mongo.password)) {
    warnings.push('MONGO_URI has no credentials; MongoDB should require authentication');
  }
  if (config.REDIS_URL !== undefined && !new URL(config.REDIS_URL).password) {
    warnings.push('REDIS_URL has no password; Redis should require authentication');
  }
  return warnings;
}
