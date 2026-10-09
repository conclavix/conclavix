import { z } from 'zod';
import { idSchema } from './ids.js';

export const SECRET_LIMITS = {
  nameLength: 80,
  envNameLength: 64,
  /** Shorter values could not be redacted from run logs without mangling ordinary text. */
  valueMinLength: 8,
  valueMaxLength: 16 * 1024,
  agentsPerSecret: 100,
  perProject: 50,
} as const;

/** Upper-case shell names only; the sandbox wrapper refuses anything else. */
export const SECRET_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Names a secret may not use: the variables the sandbox sets or forwards itself, and names that
 * change how the shell, the dynamic loader, Node, git or Claude Code behave. The sandbox wrapper
 * (deploy/agent-sandbox/agent-exec.sh) refuses the same names; keep both lists in step. Bash's
 * own special variables are reserved too: the wrapper could not export them.
 */
export const RESERVED_SECRET_ENV_NAMES: readonly string[] = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
  'OLDPWD',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TERM',
  'IFS',
  'ENV',
  'CDPATH',
  'GLOBIGNORE',
  'PROMPT_COMMAND',
  'SHELLOPTS',
  'BASHOPTS',
  'HOSTNAME',
  'MAIL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'FTP_PROXY',
  'COREPACK_HOME',
  'UV_CACHE_DIR',
  'PIP_CACHE_DIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'LOCPATH',
  'NLSPATH',
  'HOSTALIASES',
  'RES_OPTIONS',
  'LOCALDOMAIN',
  'TMOUT',
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  'UID',
  'EUID',
  'PPID',
  'SHLVL',
  'RANDOM',
  'SRANDOM',
  'SECONDS',
  'LINENO',
  'GROUPS',
  'PIPESTATUS',
  'FUNCNAME',
  'DIRSTACK',
  'EPOCHSECONDS',
  'EPOCHREALTIME',
  'OPTIND',
  'OPTARG',
  'OPTERR',
  'HOSTTYPE',
  'OSTYPE',
  'MACHTYPE',
  'MAILPATH',
  'MAILCHECK',
  'POSIXLY_CORRECT',
  'IGNOREEOF',
  'INPUTRC',
  'TIMEFORMAT',
  'FCEDIT',
  'PS0',
];

/** Prefixes reserved for the runner, Claude Code and the programs the sandbox starts. */
export const RESERVED_SECRET_ENV_PREFIXES: readonly string[] = [
  'CLAUDE',
  'ANTHROPIC',
  'CONCLAVIX',
  'CVX_',
  'ENABLE_',
  'DISABLE_',
  'LD_',
  'DYLD_',
  'BASH',
  'NODE_',
  'NPM_CONFIG_',
  'XDG_',
  'LC_',
  'SUDO_',
  'SYSTEMD_',
  'DBUS_',
  'GIT_',
  'SSH_',
  'OTEL_',
  'BUN_',
  'PYTHON',
  'PERL',
  'RUBY',
  'GCONV_',
  'GLIBC_',
  'MALLOC_',
  'HIST',
  'COMP_',
  'READLINE_',
];

/** Why `name` cannot be a secret's variable name, or null when it can. */
export function secretEnvNameProblem(name: string): string | null {
  if (!SECRET_ENV_NAME.test(name) || name.length > SECRET_LIMITS.envNameLength) {
    return `must be upper-case letters, digits and _ (at most ${SECRET_LIMITS.envNameLength}), starting with a letter`;
  }
  if (RESERVED_SECRET_ENV_NAMES.includes(name)) return `${name} is reserved`;
  const prefix = RESERVED_SECRET_ENV_PREFIXES.find((reserved) => name.startsWith(reserved));
  return prefix ? `names starting with ${prefix} are reserved` : null;
}

const nameSchema = z.string().trim().min(1).max(SECRET_LIMITS.nameLength);

export const secretEnvNameSchema = z.string().superRefine((value, context) => {
  const problem = secretEnvNameProblem(value);
  if (problem) context.addIssue({ code: 'custom', message: problem });
});

/** Any text; the run gets it byte for byte. NUL cannot be part of an environment variable. */
export const secretValueSchema = z
  .string()
  .min(SECRET_LIMITS.valueMinLength, `must be at least ${SECRET_LIMITS.valueMinLength} characters`)
  .max(SECRET_LIMITS.valueMaxLength)
  .refine((value) => !value.includes('\0'), 'must not contain NUL characters')
  .refine((value) => value.trim() === value, 'must not start or end with whitespace');

const agentIdsSchema = z
  .array(idSchema)
  .max(SECRET_LIMITS.agentsPerSecret)
  .transform((ids) => [...new Set(ids)]);

export const createSecretSchema = z.strictObject({
  name: nameSchema,
  envName: secretEnvNameSchema,
  value: secretValueSchema,
  agentIds: agentIdsSchema.default([]),
});

export const updateSecretSchema = z
  .strictObject({
    name: nameSchema,
    envName: secretEnvNameSchema,
    /** Write-only: replaces the stored value. */
    value: secretValueSchema,
    agentIds: agentIdsSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export const revealSecretSchema = z.strictObject({
  /** The owner's own password, checked again before the value is shown. */
  password: z.string().min(1).max(1024),
});

export type CreateSecretInput = z.infer<typeof createSecretSchema>;
export type UpdateSecretInput = z.infer<typeof updateSecretSchema>;

/** A secret as the API lists it: metadata only, never the value. */
export interface Secret {
  id: string;
  projectId: string;
  name: string;
  envName: string;
  agentIds: string[];
  createdAt: Date;
  updatedAt: Date;
  /** When a run last received it, and which run. */
  lastUsedAt: Date | null;
  lastUsedRunId: string | null;
}

/** An agent the board can assign secrets to; only agents with code access receive them. */
export interface SecretAgentOption {
  id: string;
  name: string;
  codeAccess: 'none' | 'write';
}
