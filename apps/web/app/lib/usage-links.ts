/**
 * `/usage` への導線を組み立てる（issue #2077 / #2078）。
 *
 * 委譲の詳細（`manager-detail.tsx`）とダッシュボード（`dashboard.tsx`）の両方が、
 * 「見ていたものと同じ母集合」で `/usage` へ飛ぶリンクを持つ——前者は
 * `managerId`、後者は今日1日の `from`/`to`。**URL の欄名（`from` / `to` /
 * `managerId`）を両側と `usage.tsx` の3箇所で書き写すと、直すときに1箇所だけ
 * 変わる**（#2077 の本文がこの理由を名指ししている）ので、欄名と href の
 * 組み立てをここへ1本化し、`usage.tsx` もここを参照する形にする。
 */

/** 絞り込みを載せる URL のクエリパラメタ名の正本。`usage.tsx` はここを読む（書き写さない）。 */
export const USAGE_FROM_PARAM = 'from';
export const USAGE_TO_PARAM = 'to';
export const USAGE_MANAGER_ID_PARAM = 'managerId';

/** `usageHref` が受け取る絞り込み。空文字・`undefined` は「その欄は載せない」。 */
export interface UsageHrefFilter {
  from?: string;
  to?: string;
  managerId?: string;
}

/**
 * `/usage` への href を組み立てる。指定した欄だけを URL に載せ、
 * 空文字・`undefined` の欄は載せない（`usage.tsx` が無い欄を「絞り込みなし」
 * として読むのと同じ規約）。
 */
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
