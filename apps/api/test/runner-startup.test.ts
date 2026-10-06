import { userInfo } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { STARTUP_WAIT_SECONDS: 30 } as Record<string, unknown>,
  connectDatabase: vi.fn(),
  pingRedis: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@conclavix/core', () => ({
  credentialWarnings: () => [],
  loadConfig: () => ({
    WORKSPACES_ROOT: '/tmp/runner-test',
    PUBLIC_API_URL: 'http://localhost:4000',
    RUN_TIMEOUT_MINUTES: 1,
    RUNNER_CONCURRENCY: 2,
    LOG_LEVEL: 'silent',
    ...mocks.config,
  }),
}));
vi.mock('pino', () => ({
  default: () => ({ info: mocks.info, warn: mocks.warn, error: vi.fn() }),
}));
vi.mock('../src/db.js', () => ({ connectDatabase: mocks.connectDatabase }));
vi.mock('../src/runner/queue.js', () => ({
  redisConnection: vi.fn(),
  pingRedis: mocks.pingRedis,
  QueueDispatcher: vi.fn(),
  startQueueWorker: () => ({ on: vi.fn() }),
}));

/** The error MongoDB reports on a host when the runner started before mongod accepted connections. */
const coldBootError = () =>
  Object.assign(new Error('connection <monitor> to 127.0.0.1:27017 closed'), {
    name: 'MongoServerSelectionError',
  });

describe('runner startup', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    vi.spyOn(process, 'once').mockImplementation(() => process);
    exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mocks.connectDatabase.mockReset();
    mocks.pingRedis.mockReset();
    mocks.info.mockReset();
    mocks.warn.mockReset();
    mocks.config = { STARTUP_WAIT_SECONDS: 30 };
  });

  it('warns when agents would run as the runner user', async () => {
    mocks.pingRedis.mockResolvedValue(undefined);
    mocks.connectDatabase.mockResolvedValue({});
    await import('../src/runner-main.js');
    await vi.waitFor(() =>
      expect(mocks.info).toHaveBeenCalledWith(expect.anything(), 'runner started'),
    );
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('AGENT_USER is not set'));
  });

  it('starts with a separate agent user', async () => {
    mocks.config = { STARTUP_WAIT_SECONDS: 30, AGENT_USER: 'cvx-agent', SUDO_BIN: '/usr/bin/sudo' };
    mocks.pingRedis.mockResolvedValue(undefined);
    mocks.connectDatabase.mockResolvedValue({});
    await import('../src/runner-main.js');
    await vi.waitFor(() =>
      expect(mocks.info).toHaveBeenCalledWith(
        { concurrency: 2, agentUser: 'cvx-agent' },
        'runner started',
      ),
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('refuses to run agents as its own user', async () => {
    mocks.config = { STARTUP_WAIT_SECONDS: 30, AGENT_USER: userInfo().username };
    await import('../src/runner-main.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('AGENT_USER must differ'));
    expect(mocks.pingRedis).not.toHaveBeenCalled();
  });

  it('waits for Redis and MongoDB on a cold boot instead of exiting', async () => {
    mocks.pingRedis
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValue(undefined);
    mocks.connectDatabase.mockRejectedValueOnce(coldBootError()).mockResolvedValue({});
    await import('../src/runner-main.js');
    await vi.waitFor(
      () =>
        expect(mocks.info).toHaveBeenCalledWith(
          { concurrency: 2, agentUser: null },
          'runner started',
        ),
      { timeout: 5000 },
    );
    expect(exit).not.toHaveBeenCalled();
    expect(mocks.pingRedis).toHaveBeenCalledTimes(2);
    expect(mocks.connectDatabase).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dependency: 'mongodb', attempt: 1 }),
      'dependency not reachable yet, retrying',
    );
  });

  it('exits with a clear error when MongoDB stays unreachable past the wait budget', async () => {
    mocks.config.STARTUP_WAIT_SECONDS = 0;
    mocks.pingRedis.mockResolvedValue(undefined);
    mocks.connectDatabase.mockRejectedValue(coldBootError());
    await import('../src/runner-main.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'mongodb not reachable after 1 attempt(s) in 0s: connection <monitor> to 127.0.0.1:27017 closed',
      ),
    );
    expect(mocks.info).not.toHaveBeenCalledWith(expect.anything(), 'runner started');
  });
});
