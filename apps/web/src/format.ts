/** Short relative time like "12s", "4m", "3h", "2d". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) {
    return '';
  }
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export const usd = (value: number | undefined): string =>
  value === undefined ? '' : `$${value.toFixed(value < 1 ? 3 : 2)}`;

export const STATUS_COLORS: Record<string, string> = {
  running: 'primary',
  succeeded: 'success',
  failed: 'error',
  timed_out: 'warning',
  todo: 'info',
  in_progress: 'primary',
  in_review: 'warning',
  done: 'success',
  active: 'success',
  paused: 'warning',
};

/** Compact duration like "850ms", "12s", "3m 05s" or "1h 02m". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return '';
  }
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`;
}

/** Wall-clock duration of a run, measured up to now while it is still going. */
export function runDuration(
  run: { startedAt?: string | null; finishedAt?: string | null },
  now = Date.now(),
): string {
  if (!run.startedAt) return '';
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : now;
  return duration(end - new Date(run.startedAt).getTime());
}

/** Token counts like "950", "12.3k" or "1.2M". */
export function tokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
