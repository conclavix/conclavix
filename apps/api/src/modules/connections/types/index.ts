import { z } from 'zod';
import type { ConnectionTypeInfo } from '@conclavix/core';
import { mcpHttpType } from './mcp-http.js';
import type { ConnectionType } from './types.js';

/** Every connection type; adding one is a module plus one entry here (docs/connections.md). */
export const CONNECTION_TYPES: ReadonlyMap<string, ConnectionType> = new Map(
  [mcpHttpType as unknown as ConnectionType].map((type) => [type.id, type]),
);

export function connectionType(id: string): ConnectionType | null {
  return CONNECTION_TYPES.get(id) ?? null;
}

/** What the board needs to render a type's form. */
export function typeInfo(type: ConnectionType): ConnectionTypeInfo {
  return {
    id: type.id,
    label: type.label,
    description: type.description,
    configSchema: z.toJSONSchema(type.configSchema, { io: 'input' }) as Record<string, unknown>,
    credentialsField: type.credentialsField,
    credentialKeys: type.credentialsField ? [] : type.credentialKeys({}),
    credentialLabel: type.credentialLabel,
    providesMcpServer: type.mcpServer !== undefined,
  };
}
