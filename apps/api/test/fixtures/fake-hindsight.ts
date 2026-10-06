import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

interface Doc {
  id: string;
  original_text: string;
  tags: string[];
  document_metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

type Docs = Map<string, Doc>;
type Send = (status: number, value: unknown) => void;
interface Request {
  method: string;
  path: string;
  url: URL;
  body: Record<string, unknown>;
}

const matches = (doc: Doc, tags: string[], mode: string): boolean =>
  tags.length === 0 ||
  (mode === 'all_strict'
    ? tags.every((t) => doc.tags.includes(t))
    : tags.some((t) => doc.tags.includes(t)));

function retain(docs: Docs, req: Request, send: Send): void {
  for (const item of req.body['items'] as Record<string, unknown>[]) {
    const id = item['document_id'] as string;
    const now = new Date().toISOString();
    docs.set(id, {
      id,
      original_text: item['content'] as string,
      tags: item['tags'] as string[],
      document_metadata: item['metadata'] as Record<string, string>,
      created_at: docs.get(id)?.created_at ?? now,
      updated_at: now,
    });
  }
  send(200, { success: true });
}

const factTypes = ['world', 'experience', 'observation'] as const;
const recallTypesSchema = z.array(z.enum(factTypes)).nullish();

function recall(docs: Docs, req: Request, send: Send): void {
  const requestedTypes = recallTypesSchema.safeParse(req.body['types']);
  if (!requestedTypes.success) {
    send(422, { detail: requestedTypes.error.issues });
    return;
  }
  const words = String(req.body['query'])
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  const tags = (req.body['tags'] as string[] | undefined) ?? [];
  const mode = String(req.body['tags_match'] ?? 'any_strict');
  const score = (doc: Doc): number => {
    const title = (doc.document_metadata['title'] ?? '').toLowerCase();
    const text = doc.original_text.toLowerCase();
    return words.reduce(
      (sum, w) => sum + (title.includes(w) ? 5 : 0) + (text.includes(w) ? 1 : 0),
      0,
    );
  };
  // Like the real API: every fact also has a consolidated observation, which belongs to no
  // document. prefer_observations drops the raw facts behind returned observations.
  const types: readonly string[] = requestedTypes.data ?? factTypes;
  const preferObservations =
    req.body['prefer_observations'] === true && types.includes('observation');
  const results = [...docs.values()]
    .filter((doc) => matches(doc, tags, mode) && score(doc) > 0)
    .sort((a, b) => score(b) - score(a))
    .flatMap((doc) => {
      const text = doc.original_text.split('\n\n').slice(1).join('\n\n') || doc.original_text;
      const fact = {
        id: `fact-${doc.id}`,
        type: 'world',
        text,
        document_id: doc.id,
        metadata: doc.document_metadata,
        tags: doc.tags,
      };
      const observation = {
        id: `obs-${doc.id}`,
        type: 'observation',
        text,
        document_id: null,
        metadata: {},
        tags: doc.tags,
      };
      return [fact, observation];
    })
    .filter((result) => types.includes(result.type))
    .filter((result) => !preferObservations || result.type === 'observation');
  send(200, { results });
}

function listDocuments(docs: Docs, req: Request, send: Send): void {
  const tags = req.url.searchParams.getAll('tags');
  const items = [...docs.values()]
    .filter((doc) => matches(doc, tags, req.url.searchParams.get('tags_match') ?? 'any_strict'))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, Number(req.url.searchParams.get('limit') ?? '100'));
  // Like the real API: the list carries the text length, never the text itself.
  const listed = items.map(({ original_text: text, ...rest }) => ({
    ...rest,
    text_length: text.length,
  }));
  send(200, { items: listed, total: items.length, limit: items.length, offset: 0 });
}

function documentById(docs: Docs, req: Request, send: Send, id: string): void {
  const doc = docs.get(id);
  if (req.method === 'GET') {
    send(doc ? 200 : 404, doc ?? { detail: 'not found' });
  } else if (req.method === 'DELETE') {
    send(docs.delete(id) ? 200 : 404, {});
  } else {
    send(405, {});
  }
}

function route(docs: Docs, req: Request, send: Send, retainDelayMs: number): void {
  const byId = /^\/documents\/(.+)$/.exec(req.path);
  if (req.method === 'PUT' && req.path === '') return send(200, {});
  if (req.method === 'POST' && req.path === '/memories') {
    setTimeout(() => retain(docs, req, send), retainDelayMs);
    return;
  }
  if (req.method === 'POST' && req.path === '/memories/recall') return recall(docs, req, send);
  if (req.method === 'GET' && req.path === '/documents') return listDocuments(docs, req, send);
  if (byId) return documentById(docs, req, send, decodeURIComponent(byId[1] ?? ''));
  send(404, { detail: `fake hindsight: no route ${req.method} ${req.path}` });
}

/** An in-memory stand-in for the Hindsight endpoints Conclavix calls. Recall is word matching. */
export async function startFakeHindsight(options: { retainDelayMs?: number } = {}): Promise<{
  url: string;
  docs: Docs;
  close(): Promise<void>;
}> {
  const docs: Docs = new Map();
  const server = createServer((incoming: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    incoming.on('data', (chunk) => (raw += chunk));
    incoming.on('end', () => {
      const url = new URL(incoming.url ?? '/', 'http://fake');
      const send: Send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      route(
        docs,
        {
          method: incoming.method ?? 'GET',
          path: url.pathname.replace(/^\/v1\/default\/banks\/[^/]+/, ''),
          url,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        },
        send,
        options.retainDelayMs ?? 0,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    docs,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
