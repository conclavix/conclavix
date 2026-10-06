export const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight UTC of the day containing `now`. */
export const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** The UTC calendar date as YYYY-MM-DD. */
export const utcDate = (date: Date): string => date.toISOString().slice(0, 10);
