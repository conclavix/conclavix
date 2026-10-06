import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workerClose: vi.fn(),
  dispatcherClose: vi.fn(),
  databaseClose: vi.fn(),
  error: vi.fn(),
  handlers: new Map<string, () => void>(),
}));
vi.mock('@conclavix/core', () => ({
  credentialWarnings: () => [],
  loadConfig: () => ({
    WORKSPACES_ROOT: '/tmp/runner-test',
    PUBLIC_API_URL: 'http://localhost:4000',
    RUN_TIMEOUT_MINUTES: 1,
    LOG_LEVEL: 'silent',
    STARTUP_WAIT_SECONDS: 0,
  }),
}));
vi.mock('pino', () => ({
  default: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.error }),
}));
vi.mock('../src/db.js', () => ({ connectDatabase: async () => ({ close: mocks.databaseClose }) }));
vi.mock('../src/runner/queue.js', () => ({
  redisConnection: vi.fn(),
  pingRedis: async () => undefined,
  QueueDispatcher: class {
    close = mocks.dispatcherClose;
  },
  startQueueWorker: () => ({ on: vi.fn(), close: mocks.workerClose }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('runner shutdown', () => {
  it.each([
    ['SIGINT', 'worker'],
    ['SIGTERM', 'dispatcher'],
    ['SIGTERM', 'database'],
    ['SIGINT', null],
    ['SIGTERM', null],
  ])('handles %s with failure at %s', async (signal, failingStep) => {
    const order: string[] = [];
    for (const [step, close] of [
      ['worker', mocks.workerClose],
      ['dispatcher', mocks.dispatcherClose],
      ['database', mocks.databaseClose],
    ] as const) {
      close.mockReset().mockImplementation(async () => {
        order.push(step);
        if (step === failingStep) throw new Error(`${step} close failed`);
      });
    }
    mocks.error.mockClear();
    mocks.handlers.clear();
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    vi.spyOn(process, 'once').mockImplementation((event, listener) => {
      mocks.handlers.set(String(event), listener);
      return process;
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await import('../src/runner-main.js');
    await vi.waitFor(() => expect(mocks.handlers.has(String(signal))).toBe(true));
    const handler = mocks.handlers.get(String(signal));
    if (!handler) throw new Error('expected signal handler');
    handler();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(failingStep ? 1 : 0));
    const steps = ['worker', 'dispatcher', 'database'];
    expect(order).toEqual(failingStep ? steps.slice(0, steps.indexOf(failingStep) + 1) : steps);
    if (failingStep) {
      expect(exit).not.toHaveBeenCalledWith(0);
      expect(mocks.error).toHaveBeenCalledWith(
        { err: expect.objectContaining({ message: `${failingStep} close failed` }) },
        'runner shutdown failed',
      );
    } else {
      expect(mocks.error).not.toHaveBeenCalled();
    }
  });
});
