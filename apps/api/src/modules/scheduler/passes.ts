import type { Scheduler } from './scheduler.js';

interface PassLog {
  info(details: object, message: string): void;
  error(details: object, message: string): void;
}

/**
 * One scheduler tick's queue passes: issue wakes, then chat turns. They fail independently, so a
 * broken wake does not hold back the chats (or the other way round) for the tick.
 */
export async function processQueues(
  scheduler: Pick<Scheduler, 'processPendingWakes' | 'processChatTurns'>,
  log: PassLog,
): Promise<void> {
  try {
    const wakes = await scheduler.processPendingWakes();
    if (wakes.run + wakes.skip > 0) log.info(wakes, 'wakes processed');
  } catch (error) {
    log.error({ err: error }, 'processing wakes failed');
  }
  try {
    const chats = await scheduler.processChatTurns();
    if (chats.run + chats.drop > 0) log.info(chats, 'chat turns processed');
  } catch (error) {
    log.error({ err: error }, 'processing chat turns failed');
  }
}
