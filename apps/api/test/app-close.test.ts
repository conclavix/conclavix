import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from './helpers.js';

describe('app close hook', () => {
  it('runs the onClose callback passed to buildApp when the app closes', async () => {
    let closed = 0;
    const ctx = await createTestContext({ onClose: () => void (closed += 1) });
    expect(closed).toBe(0);
    await ctx.close();
    expect(closed).toBe(1);
  });

  it('waits for the asynchronous onClose callback before finishing close', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callbackCompleted = false;
    let closeFinished = false;
    const ctx = await createTestContext({
      onClose: async () => {
        markStarted();
        await blocked;
        callbackCompleted = true;
      },
    });
    const dropDatabase = vi.spyOn(ctx.database.db, 'dropDatabase');
    const closing = ctx.close().then(() => {
      closeFinished = true;
    });
    try {
      await started;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeFinished).toBe(false);
      expect(callbackCompleted).toBe(false);
      expect(dropDatabase).not.toHaveBeenCalled();
    } finally {
      release();
      await closing;
    }
    expect(closeFinished).toBe(true);
    expect(callbackCompleted).toBe(true);
  });
});
