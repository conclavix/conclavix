import { parseArgs } from 'node:util';
import { loadConfig, requireAuthSecret } from '@conclavix/core';
import pino from 'pino';
import { connectDatabase } from './db.js';
import { createAuthSystem } from './modules/auth/system.js';
import { settingsDefaults } from './modules/settings/defaults.js';
import { createFirstOwner } from './modules/users/bootstrap.js';

const USAGE = `Usage:
  node dist/cli.js create-owner --email <email> --name <name> [--password-stdin]
  node dist/cli.js reset-2fa --email <email>

create-owner works only while no active owner exists. Without --password-stdin a password is
generated and printed once. reset-2fa removes a user's TOTP secret and recovery codes.`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      'password-stdin': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command || !values.email) {
    process.stdout.write(`${USAGE}\n`);
    return values.help ? 0 : 2;
  }

  const config = loadConfig();
  const log = pino({ level: 'warn' }, pino.destination(2));
  const database = await connectDatabase(config.MONGO_URI);
  try {
    const system = await createAuthSystem({
      database,
      secret: requireAuthSecret(config),
      boardUrl: config.BOARD_URL ?? config.PUBLIC_API_URL,
      sessionTtlHours: config.SESSION_TTL_HOURS,
      rateLimit: false,
      defaults: settingsDefaults(config),
      log,
    });
    const email = values.email.toLowerCase();
    if (command === 'create-owner') {
      const password = values['password-stdin'] ? await readStdin() : undefined;
      const { user, generatedPassword } = await createFirstOwner(system.users, {
        email,
        name: values.name ?? email.split('@')[0] ?? email,
        password,
      });
      process.stdout.write(`created owner ${user.email} (${user.id})\n`);
      if (generatedPassword) {
        process.stdout.write(`password (shown once): ${generatedPassword}\n`);
      }
      return 0;
    }
    if (command === 'reset-2fa') {
      const user = await database.collections.users.findOne({ email });
      if (!user) throw new Error(`no user with e-mail ${email}`);
      await system.users.resetMfa(user._id.toHexString(), 'system');
      process.stdout.write(`two-factor authentication reset for ${email}\n`);
      return 0;
    }
    process.stdout.write(`${USAGE}\n`);
    return 2;
  } finally {
    await database.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `conclavix cli failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
