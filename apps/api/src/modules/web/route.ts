import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Serve the built board UI from `root`, with index.html for client-side routes. */
export async function registerWebApp(
  app: FastifyInstance,
  root: string | undefined,
): Promise<void> {
  if (!root || !existsSync(join(root, 'index.html'))) {
    return;
  }
  await app.register(fastifyStatic, { root, wildcard: false, index: false });
  const sendIndex = async (_request: unknown, reply: { sendFile(name: string): unknown }) =>
    reply.sendFile('index.html');
  app.get('/', sendIndex);
  app.get('/*', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const lastSegment = path.split('/').pop() ?? '';
    if (path.startsWith('/api') || path.startsWith('/mcp') || lastSegment.includes('.')) {
      return reply.status(404).send({ error: 'not_found', message: 'Route not found' });
    }
    return reply.sendFile('index.html');
  });
}
