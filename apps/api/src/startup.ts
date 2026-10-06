import { setTimeout as delay } from 'node:timers/promises';

export interface StartupLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

export interface WaitOptions {
  /** Retrying stops once this much time has passed; a running attempt is not cut short. */
  maxWaitMs: number;
  log: StartupLogger;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

/** A startup dependency stayed unreachable for the whole wait budget. */
export class DependencyUnavailableError extends Error {
  constructor(dependency: string, attempts: number, waitedMs: number, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `${dependency} not reachable after ${attempts} attempt(s) in ${Math.round(waitedMs / 1000)}s: ${reason}`,
      { cause },
    );
    this.name = 'DependencyUnavailableError';
  }
}

/**
 * Retry `attempt` with exponential backoff until it succeeds or `maxWaitMs` has passed.
 * Used at process start, where services such as MongoDB may still be booting.
 */
export async function waitForDependency<T>(
  dependency: string,
  attempt: () => Promise<T>,
  options: WaitOptions,
): Promise<T> {
  const { maxWaitMs, log, initialDelayMs = 500, maxDelayMs = 10_000 } = options;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let backoffMs = initialDelayMs;
  for (let attempts = 1; ; attempts += 1) {
    try {
      const result = await attempt();
      if (attempts > 1) {
        log.info({ dependency, attempts, waitedMs: now() - startedAt }, 'dependency reachable');
      }
      return result;
    } catch (error) {
      const waitedMs = now() - startedAt;
      const remainingMs = maxWaitMs - waitedMs;
      if (remainingMs <= 0) {
        throw new DependencyUnavailableError(dependency, attempts, waitedMs, error);
      }
      const retryInMs = Math.min(backoffMs, remainingMs);
      log.warn(
        { dependency, attempt: attempts, retryInMs, remainingMs, err: error },
        'dependency not reachable yet, retrying',
      );
      await sleep(retryInMs);
      backoffMs = Math.min(backoffMs * 2, maxDelayMs);
    }
  }
}
