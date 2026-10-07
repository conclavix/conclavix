import { describe, expect, it, vi } from 'vitest';
import { processQueues } from '../src/modules/scheduler/passes.js';

const log = () => ({ info: vi.fn(), error: vi.fn() });

describe('scheduler queue passes', () => {
  it('still starts chat turns when the wake pass fails', async () => {
    const scheduler = {
      processPendingWakes: vi.fn().mockRejectedValue(new Error('wake broke')),
      processChatTurns: vi.fn().mockResolvedValue({ run: 1, drop: 0, defer: 0 }),
    };
    const logger = log();
    await processQueues(scheduler, logger);
    expect(scheduler.processChatTurns).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'processing wakes failed');
    expect(logger.info).toHaveBeenCalledWith({ run: 1, drop: 0, defer: 0 }, 'chat turns processed');
  });

  it('reports a failing chat pass without throwing', async () => {
    const scheduler = {
      processPendingWakes: vi.fn().mockResolvedValue({ run: 0, skip: 0, defer: 0 }),
      processChatTurns: vi.fn().mockRejectedValue(new Error('chat broke')),
    };
    const logger = log();
    await expect(processQueues(scheduler, logger)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'processing chat turns failed');
    expect(logger.info).not.toHaveBeenCalled();
  });
});
