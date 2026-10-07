import type { ObjectId } from 'mongodb';
import type { Collections } from '../db.js';
import type { ConnectionDoc } from '../db/connections.js';
import type { AuditLog } from '../modules/audit/audit.js';
import { assertSafeConnectionUrl, privateAddressesFor } from '../modules/connections/net.js';
import { connectionType } from '../modules/connections/types/index.js';
import { secretContext } from '../modules/secrets/repository.js';
import type { SecretBox } from '../modules/settings/secret-box.js';
import type { KnownSecret } from './redact.js';

/**
 * Header values of external MCP servers reach claude in these variables, which claude expands in
 * the MCP config. The names contain none of the words Claude Code's subprocess scrub treats as
 * credentials (TOKEN, KEY, AUTH, SECRET, ...), see docs/connections.md; the sandbox hides them
 * from Bash with the managed credentials deny list.
 */
export const MCP_HEADER_ENV_PREFIX = 'CONCLAVIX_MCP_HEADER_';
export const MAX_MCP_HEADER_ENV = 32;

/** An external MCP server in a run's config; header values are `${VARIABLE}` references. */
export interface RunMcpServer {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface RunConnections {
  servers: RunMcpServer[];
  /** The variables the header references point to. */
  env: Record<string, string>;
  /** Private addresses the coding sandbox has to allow for these servers. */
  privateAddresses: string[];
  /** Credential values, for the run log redactor. */
  known: KnownSecret[];
  /** Connections left out of the run, each with a short text for the run log. */
  skipped: { name: string; cause: string }[];
  used: Pick<ConnectionDoc, '_id' | 'name' | 'type'>[];
}

export const noConnections = (): RunConnections => ({
  servers: [],
  env: {},
  privateAddresses: [],
  known: [],
  skipped: [],
  used: [],
});

/** Credential values and, for `Bearer x` style values, the token alone. */
function knownValues(name: string, key: string, value: string): KnownSecret[] {
  const label = `${name}:${key}`;
  const token = /^(?:Bearer|Basic|Token)\s+(\S.*)$/i.exec(value)?.[1];
  return [{ name: label, value }, ...(token ? [{ name: label, value: token }] : [])];
}

interface Loaded {
  url: URL;
  headers: Record<string, string>;
  privateAddresses: string[];
}

async function loadOne(
  collections: Collections,
  box: SecretBox,
  doc: ConnectionDoc,
): Promise<Loaded> {
  const type = connectionType(doc.type);
  if (!type?.mcpServer) throw new Error(`type ${doc.type} adds no MCP server`);
  const config = type.configSchema.parse(doc.config);
  const entries = await collections.secrets.find({ connectionId: doc._id }).toArray();
  const credentials: Record<string, string> = {};
  for (const entry of entries) {
    try {
      credentials[entry.credentialKey ?? ''] = box.open(
        entry.valueEncrypted,
        secretContext(entry._id),
      );
    } catch {
      throw new Error(`credential ${entry.credentialKey ?? ''} cannot be decrypted`);
    }
  }
  const missing = type.credentialKeys(config).filter((key) => !(key in credentials));
  if (missing.length > 0) throw new Error(`no value stored for ${missing.join(', ')}`);
  const spec = type.mcpServer({
    name: doc.name,
    config,
    credentials,
    allowPrivateNetwork: doc.allowPrivateNetwork,
    timeoutMs: 0,
  });
  const url = assertSafeConnectionUrl(spec.url, doc.allowPrivateNetwork);
  const privateAddresses = await privateAddressesFor(url, doc.allowPrivateNetwork);
  return { url, headers: spec.headers, privateAddresses };
}

/**
 * The MCP servers of the connections the run's agent may use: instance connections and those of
 * the issue's project. A connection that cannot be used (credentials, URL, DNS) is left out and
 * listed in `skipped`; the run goes on without it.
 */
export async function loadRunConnections(
  collections: Collections,
  box: SecretBox | null,
  agentId: ObjectId,
  projectId: ObjectId,
): Promise<RunConnections> {
  const docs = await collections.connections
    .find({
      agentIds: agentId,
      $or: [{ scope: 'instance' }, { scope: 'project', projectId }],
    })
    .sort({ name: 1 })
    .toArray();
  const result = noConnections();
  for (const doc of docs) {
    if (!connectionType(doc.type)?.mcpServer) continue;
    if (!box) {
      result.skipped.push({ name: doc.name, cause: 'the runner has no AUTH_SECRET' });
      continue;
    }
    let loaded: Loaded;
    try {
      loaded = await loadOne(collections, box, doc);
    } catch (error) {
      result.skipped.push({
        name: doc.name,
        cause: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const names = Object.keys(loaded.headers);
    const taken = Object.keys(result.env).length;
    if (taken + names.length > MAX_MCP_HEADER_ENV) {
      result.skipped.push({ name: doc.name, cause: 'too many header values in one run' });
      continue;
    }
    const headers: Record<string, string> = {};
    names.forEach((header, index) => {
      const variable = `${MCP_HEADER_ENV_PREFIX}${taken + index + 1}`;
      const value = loaded.headers[header] ?? '';
      result.env[variable] = value;
      headers[header] = `\${${variable}}`;
      result.known.push(...knownValues(doc.name, header, value));
    });
    result.servers.push({ name: doc.name, url: loaded.url.toString(), headers });
    result.privateAddresses.push(...loaded.privateAddresses);
    result.used.push({ _id: doc._id, name: doc.name, type: doc.type });
  }
  result.privateAddresses = [...new Set(result.privateAddresses)];
  return result;
}

/** One audit entry per connection a run received; never a credential. */
export async function recordConnectionUse(
  audit: AuditLog | undefined,
  connections: RunConnections,
  run: { runId: ObjectId; agentId: ObjectId; projectId: ObjectId },
): Promise<void> {
  for (const connection of connections.used) {
    await audit?.record({
      action: 'connection.used',
      actor: { type: 'system' },
      details: {
        connectionId: connection._id.toHexString(),
        name: connection.name,
        type: connection.type,
        runId: run.runId.toHexString(),
        agentId: run.agentId.toHexString(),
        projectId: run.projectId.toHexString(),
      },
    });
  }
}
