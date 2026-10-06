export interface RunFilters {
  statuses: string[];
  agentId: string | null;
  issueId: string | null;
  from: string;
  to: string;
}

const startOfLocalDay = (day: string, offsetDays = 0): string | null => {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString();
};

/** Build the /api/runs query string; `to` is inclusive of the whole local day. */
export function runsQuery(filters: RunFilters, limit: number, before: string | null): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters.statuses.length) params.set('status', filters.statuses.join(','));
  if (filters.agentId) params.set('agentId', filters.agentId);
  if (filters.issueId) params.set('issueId', filters.issueId);
  const from = filters.from ? startOfLocalDay(filters.from) : null;
  const to = filters.to ? startOfLocalDay(filters.to, 1) : null;
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (before) params.set('before', before);
  return params.toString();
}
