export const USAGE_FROM_PARAM = 'from';
export const USAGE_TO_PARAM = 'to';
export const USAGE_MANAGER_ID_PARAM = 'managerId';

export interface UsageHrefFilter {
  from?: string;
  to?: string;
  managerId?: string;
}

export function usageHref(filter: UsageHrefFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.from !== undefined && filter.from !== '') {
    params.set(USAGE_FROM_PARAM, filter.from);
  }
  if (filter.to !== undefined && filter.to !== '') {
    params.set(USAGE_TO_PARAM, filter.to);
  }
  if (filter.managerId !== undefined && filter.managerId !== '') {
    params.set(USAGE_MANAGER_ID_PARAM, filter.managerId);
  }
  const query = params.toString();
  return query === '' ? '/usage' : `/usage?${query}`;
}
