import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { StreamConnections } from './connections.js';
import type { StreamHub } from './hub.js';

const KEEPALIVE_MS = 15_000;
const MAX_UNFLUSHED = 1000;
export const STREAM_RECHECK_MS = 60_000;

export interface StreamAccess {
  connections: StreamConnections;
  reauthorize: (request: FastifyRequest) => Promise<boolean>;
  recheckMs?: number;
}

/**
 * Server-sent events for the board: runs, run log lines, issues, comments and agents as they
 * change. Access is checked again periodically and whenever the user's access may have changed;
 * a stream that lost access is ended, and the client's reconnect then gets a 401.
 */
export function registerStreamRoute(
  app: FastifyInstance,
  hub: StreamHub,
  access: StreamAccess,
): void {
  app.get('/api/stream', (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    let unflushed = 0;
    const send = (chunk: string): void => {
      if (!res.write(chunk)) {
        unflushed += 1;
        if (unflushed > MAX_UNFLUSHED) {
          request.log.warn('stream client too slow, disconnecting');
          res.end();
        }
      }
    };
    res.on('drain', () => {
      unflushed = 0;
    });

    const unsubscribe = hub.subscribe((event) => {
      send(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    });
    const keepalive = setInterval(() => send(': keepalive\n\n'), KEEPALIVE_MS);
    const principal = request.principal;
    const connection = {
      userId: principal?.kind === 'user' ? principal.userId : null,
      reauthorize: () => access.reauthorize(request),
      close: () => {
        cleanup();
        res.end();
      },
    };
    const forget = access.connections.add(connection);
    const recheck = setInterval(
      () => void access.connections.check(connection),
      access.recheckMs ?? STREAM_RECHECK_MS,
    );
    let ended = false;
    function cleanup(): void {
      if (ended) return;
      ended = true;
      clearInterval(keepalive);
      clearInterval(recheck);
      forget();
      unsubscribe();
    }
    request.raw.on('close', cleanup);
    res.on('close', cleanup);
  });
}
