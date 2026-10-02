import type { ManagerStatus } from './types.js';

/**
 * `/managers` への導線を組み立てる（issue #2090）。
 *
 * ダッシュボード（`dashboard.tsx`）の「稼働中のマネージャー」カードの「一覧」は、
 * カード自身の絞り込み（`isRunningJobStatus`）と同じ母集合で `/managers` へ
 * 飛ぶ必要がある——`status=running` を文字列で書き写すと、`isRunningJobStatus`
 * が真にする状態が増えた日にリンクだけ古びる（#2090 の本文。値の側は
 * `@alteroid/core/job-status-running` の `JOB_STATUS_LIKE_VALUES.filter(isRunningJobStatus)`
 * から作る——そちらの doc を見よ）。
 *
 * **URL の欄名（`status`）を `managers.tsx` とここの2箇所で書き写すと、直すときに
 * 片方だけ変わる**ので、欄名と href の組み立てをここへ1本化し、`managers.tsx` も
 * ここを参照する形にする（`usage-links.ts`（#2077 / #2078）と同じ判断・同じ理由）。
 */

/**
 * 状態チップの選択を載せる URL のクエリパラメタ名の正本（issue #2030）。
 * `managers.tsx` はここを読む（書き写さない）。
 *
 * **`journal.tsx` の `TYPES_SEARCH_PARAM`（#2029）と同じ形に揃える**——
 * 同じ判断を2つの画面で割らない。`GET /managers?status=` とは違う名前に
 * してあるのも同じ理由（URL 側はカンマ区切りで1つのパラメタにまとめる
 * 語彙、API 側は問い合わせのクエリの語彙で、意図的に分けてある）。
 */
export const STATUS_SEARCH_PARAM = 'status';

/** `managersHref` が受け取る絞り込み。空配列・`undefined` は「その欄は載せない」。 */
export interface ManagersHrefFilter {
  status?: readonly ManagerStatus[];
}

/**
 * `/managers` への href を組み立てる。`status` は重複を除いてカンマ区切りで
 * 1つのクエリパラメタへ載せる——`managers.tsx` の `parseSelectedStatuses` が
 * 読む形（カンマ区切り・`STATUS_SEARCH_PARAM`）と揃える。空配列・`undefined`
 * なら欄を載せない（絞り込みなし＝素の `/managers`）。
 */
export function managersHref(filter: ManagersHrefFilter = {}): string {
  const statuses = [...new Set(filter.status ?? [])];
  if (statuses.length === 0) return '/managers';
  const params = new URLSearchParams();
  params.set(STATUS_SEARCH_PARAM, statuses.join(','));
  return `/managers?${params.toString()}`;
}
