import { ApiError } from '../api/client';
import type { Connection, ConnectionInput, ConnectionTypeInfo } from '../api/connections';

/** One input of a type's config form, derived from its JSON schema. */
export interface ConfigField {
  key: string;
  title: string;
  description: string;
  kind: 'text' | 'url' | 'number' | 'boolean' | 'list' | 'choice';
  required: boolean;
  options: string[];
}

interface JsonSchema {
  type?: string;
  format?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

function kindOf(schema: JsonSchema): ConfigField['kind'] {
  if (schema.enum) return 'choice';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'array') return 'list';
  return schema.format === 'uri' ? 'url' : 'text';
}

/** The form fields of a type, in schema order; the credentials field is edited with its values. */
export function configFields(type: ConnectionTypeInfo): ConfigField[] {
  const schema = type.configSchema as JsonSchema;
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([key, property]) => ({
    key,
    title: property.title ?? key,
    description: property.description ?? '',
    kind: kindOf(property),
    required: required.has(key),
    options: (property.enum ?? []).map(String),
  }));
}

export interface CredentialRow {
  key: string;
  /** Write-only: empty keeps a stored value. */
  value: string;
  stored: boolean;
}

export interface ConnectionDraft {
  name: string;
  type: string;
  scope: 'instance' | 'project';
  projectId: string | null;
  config: Record<string, unknown>;
  credentials: CredentialRow[];
  agentIds: string[];
  allowPrivateNetwork: boolean;
}

export function emptyDraft(type: ConnectionTypeInfo, projectId: string | null): ConnectionDraft {
  const config: Record<string, unknown> = {};
  for (const field of configFields(type)) {
    config[field.key] = field.kind === 'list' ? [] : field.kind === 'boolean' ? false : '';
  }
  return {
    name: '',
    type: type.id,
    scope: projectId ? 'project' : 'instance',
    projectId,
    config,
    credentials: type.credentialKeys.map((key) => ({ key, value: '', stored: false })),
    agentIds: [],
    allowPrivateNetwork: false,
  };
}

export function draftOf(connection: Connection): ConnectionDraft {
  return {
    name: connection.name,
    type: connection.type,
    scope: connection.scope,
    projectId: connection.projectId,
    config: JSON.parse(JSON.stringify(connection.config)) as Record<string, unknown>,
    credentials: connection.credentials.map((entry) => ({
      key: entry.key,
      value: '',
      stored: entry.set,
    })),
    agentIds: [...connection.agentIds],
    allowPrivateNetwork: connection.allowPrivateNetwork,
  };
}

/** Keep the credential rows in step with the config field that names them (e.g. headers). */
export function syncCredentialRows(draft: ConnectionDraft, type: ConnectionTypeInfo): void {
  if (!type.credentialsField) return;
  const names = (draft.config[type.credentialsField] as string[] | undefined) ?? [];
  draft.credentials = names.map(
    (key) => draft.credentials.find((row) => row.key === key) ?? { key, value: '', stored: false },
  );
}

/** Empty optional strings are left out, so the server's defaults apply. */
function cleanConfig(type: ConnectionTypeInfo, config: Record<string, unknown>) {
  const fields = configFields(type);
  return Object.fromEntries(
    Object.entries(config).filter(([key, value]) => {
      const field = fields.find((entry) => entry.key === key);
      return field !== undefined && !(value === '' && !field.required);
    }),
  );
}

/** The request body: everything on create, only changes on edit; credentials only when typed. */
export function connectionPayload(
  draft: ConnectionDraft,
  type: ConnectionTypeInfo,
  editing: Connection | null,
): ConnectionInput {
  const credentials = Object.fromEntries(
    draft.credentials.filter((row) => row.value !== '').map((row) => [row.key, row.value]),
  );
  const config = cleanConfig(type, draft.config);
  if (!editing) {
    return {
      name: draft.name,
      type: draft.type,
      scope: draft.scope,
      ...(draft.scope === 'project' && draft.projectId ? { projectId: draft.projectId } : {}),
      config,
      credentials,
      agentIds: draft.agentIds,
      allowPrivateNetwork: draft.allowPrivateNetwork,
    };
  }
  const body: ConnectionInput = {};
  if (draft.name !== editing.name) body.name = draft.name;
  if (JSON.stringify(config) !== JSON.stringify(editing.config)) body.config = config;
  if (Object.keys(credentials).length > 0) body.credentials = credentials;
  const sameAgents =
    draft.agentIds.length === editing.agentIds.length &&
    draft.agentIds.every((id) => editing.agentIds.includes(id));
  if (!sameAgents) body.agentIds = draft.agentIds;
  if (draft.allowPrivateNetwork !== editing.allowPrivateNetwork) {
    body.allowPrivateNetwork = draft.allowPrivateNetwork;
  }
  return body;
}

export const nameRules = [
  (value: string) =>
    /^[a-z][a-z0-9-]*$/.test(value) || 'lower-case letters, digits and -, starting with a letter',
  (value: string) => value.length <= 40 || 'at most 40 characters',
  (value: string) => value !== 'conclavix' || 'conclavix is the board itself',
];

const ERRORS: Record<string, string> = {
  owner_required: 'Only an owner can allow private networks or change such a connection.',
  connection_address_blocked:
    'The URL points to a private or local network. An owner can allow private networks for this connection.',
  conflict: 'A connection with this name already exists.',
};

export function connectionErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const known = error.code ? ERRORS[error.code] : undefined;
    if (known) return known;
    if (error.code === 'invalid_request' && Array.isArray(error.details)) {
      return (error.details as { path: string; message: string }[])
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ');
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
