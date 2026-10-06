/** Looks up a secret by name; undefined when the runner does not hold it. */
export type SecretResolver = (name: string) => string | undefined;

/** Only variables with this prefix can be referenced by agents, so they cannot point at BOARD_TOKEN. */
export const SECRET_ENV_PREFIX = 'CVX_SECRET_';

export class MissingSecretError extends Error {
  constructor(name: string) {
    super(`secret ${name} is not configured on the runner (set ${SECRET_ENV_PREFIX}${name})`);
    this.name = 'MissingSecretError';
  }
}

/** Resolve agent secrets from the runner's environment. */
export function secretsFromEnv(env: NodeJS.ProcessEnv): SecretResolver {
  return (name) => {
    const value = env[`${SECRET_ENV_PREFIX}${name}`];
    return value === undefined || value === '' ? undefined : value;
  };
}

const SECRET_ENV_NAME =
  /(^CVX_SECRET_|TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|KEY_ID|_KEY$|(^|_)AUTH(_|$)|(^|_)PASS(_|$)|CUSTOM_HEADERS|CREDENTIALS?)/i;

function headerValues(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.slice(line.indexOf(':') + 1).trim())
    .map((header) => header.replace(/^(Bearer|Basic|Token)\s+/i, ''));
}

function urlPassword(value: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return null;
  }
  try {
    const password = new URL(value).password;
    return password ? decodeURIComponent(password) : null;
  } catch {
    return null;
  }
}

/** Every secret value in the runner's environment, so the run log can be scrubbed of them. */
export function knownSecretsFromEnv(env: NodeJS.ProcessEnv): { name: string; value: string }[] {
  const found: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value) {
      continue;
    }
    if (SECRET_ENV_NAME.test(name)) {
      found.push({ name, value });
      if (/HEADERS/i.test(name)) {
        found.push(...headerValues(value).map((header) => ({ name, value: header })));
      }
    }
    const password = urlPassword(value);
    if (password) {
      found.push({ name: `${name}_PASSWORD`, value: password });
    }
  }
  return found;
}
