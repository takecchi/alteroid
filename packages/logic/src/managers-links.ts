import type { ManagerStatus } from './types.js';

export const STATUS_SEARCH_PARAM = 'status';

export interface ManagersHrefFilter {
  status?: readonly ManagerStatus[];
}

export function managersHref(filter: ManagersHrefFilter = {}): string {
  const statuses = [...new Set(filter.status ?? [])];
  if (statuses.length === 0) return '/managers';
  const params = new URLSearchParams();
  params.set(STATUS_SEARCH_PARAM, statuses.join(','));
  return `/managers?${params.toString()}`;
}
