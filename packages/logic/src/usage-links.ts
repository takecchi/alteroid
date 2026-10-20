export const USAGE_FROM_PARAM = 'from';
export const USAGE_TO_PARAM = 'to';
export const USAGE_MANAGER_ID_PARAM = 'managerId';

/** 画面の既定の期間（日。今日を含む）。`from` が URL に無いときに使う。API の既定（全期間）とは別 */
export const USAGE_DEFAULT_DAYS = 30;

export interface UsageHrefFilter {
  from?: string;
  to?: string;
  managerId?: string;
  /**
   * 全期間で開く（`from=` を空で立てる）。`from` が無い URL は画面の既定（直近 {@link USAGE_DEFAULT_DAYS} 日）で開くので、
   * 古い記録まで見せたいリンクはこれを立てる。`from` を渡したときは `from` を使う
   */
  allTime?: boolean;
}

export function usageHref(filter: UsageHrefFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.from !== undefined && filter.from !== '') {
    params.set(USAGE_FROM_PARAM, filter.from);
  } else if (filter.allTime === true) {
    params.set(USAGE_FROM_PARAM, '');
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
