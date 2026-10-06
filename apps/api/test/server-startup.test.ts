import { setImmediate } from 'node:timers/promises';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';

const { closeDatabase } = vi.hoisted(() => ({ closeDatabase: vi.fn() }));

vi.mock('@conclavix/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@conclavix/core')>()),
  credentialWarnings: () => [],
  loadConfig: () => ({
    MONGO_URI: 'mongodb://unused',
    HOST: '127.0.0.1',
    PORT: 0,
    WORKSPACE_ROOT: '/nonexistent/cvx-workspace',
  }),
  requireAuthSecret: () => 's'.repeat(32),
}));
vi.mock('../src/app.js', () => ({ buildApp: vi.fn() }));
vi.mock('../src/db.js', () => ({
  connectDatabase: async () => ({ close: closeDatabase }),
}));

it('starts after Fastify has finished booting and closes the database after the app', async () => {
  const app = Fastify();
  const events: string[] = [];
  app.addHook('onClose', async () => {
    events.push('app closed');
  });
  closeDatabase.mockImplementation(async () => {
    events.push('database closed');
  });
  vi.mocked(buildApp).mockImplementation(async () => {
    await app.ready();
    // Avvio emits its start event after ready resolves; reproduce the CI timing.
    await setImmediate();
    return app;
  });
  const listen = vi.spyOn(app, 'listen').mockResolvedValue(undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const once = process.once.bind(process);
  const handlers = new Map<string, () => void>();
  vi.spyOn(process, 'once').mockImplementation((event, handler) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      handlers.set(event, handler);
      return process;
    }
    return once(event, handler);
  });
  try {
    await import('../src/server.js');
    await vi.waitFor(() =>
      expect(listen.mock.calls.length + exit.mock.calls.length).toBeGreaterThan(0),
    );
    expect(stderr).not.toHaveBeenCalled();
    expect(listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 0 });
    expect(exit).not.toHaveBeenCalled();
    expect(handlers.has('SIGTERM')).toBe(true);
    handlers.get('SIGTERM')?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(events).toEqual(['app closed', 'database closed']);
  } finally {
    await app.close();
    vi.restoreAllMocks();
  }
});
