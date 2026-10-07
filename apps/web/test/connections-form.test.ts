import { describe, expect, it } from 'vitest';
import type { Connection, ConnectionTypeInfo } from '../src/api/connections';
import {
  configFields,
  connectionPayload,
  draftOf,
  emptyDraft,
  syncCredentialRows,
} from '../src/connections/form';

const mcp: ConnectionTypeInfo = {
  id: 'mcp_http',
  label: 'MCP server (HTTP)',
  description: 'An external MCP server',
  configSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri', title: 'Server URL', description: 'Endpoint' },
      headers: { type: 'array', items: { type: 'string' }, title: 'Headers' },
    },
    required: ['url'],
  },
  credentialsField: 'headers',
  credentialKeys: [],
  credentialLabel: 'Header value',
  providesMcpServer: true,
};

const stored: Connection = {
  id: 'a'.repeat(24),
  name: 'docs',
  type: 'mcp_http',
  scope: 'instance',
  projectId: null,
  config: { url: 'https://mcp.example.com/mcp', headers: ['Authorization'] },
  credentials: [{ key: 'Authorization', set: true }],
  agentIds: [],
  allowPrivateNetwork: false,
  lastTest: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('connection form', () => {
  it('derives the fields from the type schema', () => {
    expect(configFields(mcp)).toEqual([
      expect.objectContaining({ key: 'url', kind: 'url', required: true, title: 'Server URL' }),
      expect.objectContaining({ key: 'headers', kind: 'list', required: false }),
    ]);
  });

  it('asks for one value per header and creates a project connection on a project page', () => {
    const draft = emptyDraft(mcp, 'b'.repeat(24));
    draft.name = 'docs';
    draft.config['url'] = 'https://mcp.example.com/mcp';
    draft.config['headers'] = ['Authorization'];
    syncCredentialRows(draft, mcp);
    expect(draft.credentials).toEqual([{ key: 'Authorization', value: '', stored: false }]);
    const [row] = draft.credentials;
    if (row) row.value = 'Bearer x';
    expect(connectionPayload(draft, mcp, null)).toEqual({
      name: 'docs',
      type: 'mcp_http',
      scope: 'project',
      projectId: 'b'.repeat(24),
      config: { url: 'https://mcp.example.com/mcp', headers: ['Authorization'] },
      credentials: { Authorization: 'Bearer x' },
      agentIds: [],
      allowPrivateNetwork: false,
    });
  });

  it('sends only changes when editing and keeps stored values unless typed', () => {
    const draft = draftOf(stored);
    expect(connectionPayload(draft, mcp, stored)).toEqual({});
    draft.agentIds = ['c'.repeat(24)];
    expect(connectionPayload(draft, mcp, stored)).toEqual({ agentIds: ['c'.repeat(24)] });
    const [stored0] = draft.credentials;
    if (stored0) stored0.value = 'Bearer new';
    expect(connectionPayload(draft, mcp, stored).credentials).toEqual({
      Authorization: 'Bearer new',
    });
  });
});
