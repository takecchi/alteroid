import { useCallback, useRef, useState } from 'react';

import { useReports } from './queries';
import { unwrap, useApi } from '../api';
import type { DailyReport } from '@alteroid/logic';

/**
 * 日報の一覧の窓（いま画面に持っている分）。Issue #3464。
 *
 * 先頭の頁は SWR（`useReports`）、「もっと古い日報を読む」で足した頁は `useState`
 * （`use-answered-dates-window.ts` と同じ形。`useSWRInfinite` を使わない理由もそちらと同じ）。
 *
 * - 続きは `GET /reports` の `beforeDate` ＋ `beforeAt`（持っている最後の行の `date` と `at`）で読む。
 *   **デーモンは `(date, at)` の複合キーで、境界より厳密に古い行だけを返す**
 *   （`apps/daemon/src/reports.ts` の `isOlderThanBoundary`。`date` が違えば `date` の比較、
 *   同じ日なら `at` の比較。境界の行自身は返さない）。2つは**両方なければ400**なので必ず一緒に渡す
 * - **封筒は無い**ので、続きが在るかは「直前の頁が `limit` 件ちょうどだったか」でしか判らない
 * - **読み足しの失敗は `olderError` に載せ、持っている一覧は消さない**。押し直すと前の失敗は消える
 * - 読み足した頁は取り直さない（先頭の頁だけが SWR で更新される）。`id` が重なったら先頭側を残す
 * - **並べ直さない**（並びはデーモンが決める）
 */
export interface ReportsWindow {
  /** 先頭の頁（SWR）の応答。`data` / `error` / `isLoading` / `mutate` はこれを見る。 */
  first: ReturnType<typeof useReports>;
  /** 先頭の頁 + 読み足した分（新しい順・`id` の重複なし）。先頭の頁が読めていなければ空。 */
  reports: DailyReport[];
  /** 「もっと古い日報を読む」を出してよいか（直前の頁が `limit` 件ちょうど）。 */
  hasMore: boolean;
  isLoadingOlder: boolean;
  /** 読み足しの失敗（立っていても `reports` はそのまま）。 */
  olderError: unknown;
  loadOlder: () => void;
}

export function useReportsWindow(limit: number): ReportsWindow {
  const api = useApi();
  const first = useReports(limit);
  const [older, setOlder] = useState<DailyReport[]>([]);
  const [lastOlderCount, setLastOlderCount] = useState<number | undefined>(undefined);
  const [isLoadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(undefined);
  const inFlight = useRef(false);

  const page = Array.isArray(first.data?.reports) ? first.data.reports : [];
  const seen = new Set<string>();
  const reports = [...page, ...older].filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });

  const hasMore = (lastOlderCount ?? page.length) === limit;
  const anchor = reports.at(-1);
  const beforeDate = anchor?.date;
  const beforeAt = anchor?.at;

  const loadOlder = useCallback(() => {
    if (beforeDate === undefined || beforeAt === undefined || inFlight.current) return;
    inFlight.current = true;
    setLoadingOlder(true);
    setOlderError(undefined);
    api.api
      .GET('/reports', { params: { query: { limit, beforeDate, beforeAt } } })
      .then(unwrap)
      .then((body) => {
        if (!Array.isArray(body.reports)) throw new Error('日報の一覧が読めない形で届いた');
        setOlder((previous) => [...previous, ...body.reports]);
        setLastOlderCount(body.reports.length);
      })
      .catch((error: unknown) => {
        setOlderError(error);
      })
      .finally(() => {
        inFlight.current = false;
        setLoadingOlder(false);
      });
  }, [api, beforeDate, beforeAt, limit]);

  return { first, reports, hasMore, isLoadingOlder, olderError, loadOlder };
}
