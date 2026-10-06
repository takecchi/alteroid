import { useCallback, useEffect, useRef, useState } from 'react';

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
 * - **隙間（Issue #3737）**: 読み足した後に先頭の頁が取り直されて新しい日報が入ると、先頭の頁は
 *   1件ずれて最後の行を落とす。読み足した側はその行より前から始まっているので、境目の行がどちらにも
 *   入らない。**採った形は「先頭の頁の最後の行を起点に読み足して埋める」**（読み足した分を捨てて
 *   読み直すと、いくつも読み足した後の一覧が縮むので採らない）。読んだ分が持っている読み足しの先頭に
 *   届けば、持っている分は後ろにそのまま残す。届かなければ（`limit` 件より多く新着が入った）読んだ分で
 *   置き換える。埋める読み足しの失敗も `olderError` に載せ、自動では撃ち直さない（押し直すと、続きより先に
 *   隙間を埋め直す）
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
  // 読み足した分が始まる境（読み足した時点の先頭の頁の最後の行）。
  const [joint, setJoint] = useState<DailyReport | undefined>(undefined);
  const inFlight = useRef(false);

  const page = Array.isArray(first.data?.reports) ? first.data.reports : [];
  const seen = new Set<string>();
  const reports = [...page, ...older].filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });

  const hasMore = (lastOlderCount ?? page.length) === limit;
  const pageEnd = page.at(-1);
  // `date` は `YYYY-MM-DD` の固定幅なので、つなげた文字列の比較が (date, at) の比較になる。
  const gap =
    joint !== undefined &&
    pageEnd !== undefined &&
    pageEnd.date + pageEnd.at > joint.date + joint.at;
  const anchor = gap ? pageEnd : reports.at(-1);
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
        const filled = gap && body.reports.some((r) => r.id === older[0]?.id);
        setOlder((previous) =>
          gap
            ? filled
              ? [...body.reports, ...previous]
              : body.reports
            : [...previous, ...body.reports],
        );
        if (!filled) setLastOlderCount(body.reports.length);
        setJoint((previous) => (gap ? undefined : previous) ?? pageEnd);
      })
      .catch((error: unknown) => {
        setOlderError(error);
      })
      .finally(() => {
        inFlight.current = false;
        setLoadingOlder(false);
      });
  }, [api, beforeDate, beforeAt, limit, gap, older, pageEnd]);

  // 隙間ができたら自動で埋める。失敗したら（`olderError`）自動では撃ち直さない。
  useEffect(() => {
    if (gap && olderError === undefined) loadOlder();
  }, [gap, olderError, loadOlder]);

  return { first, reports, hasMore, isLoadingOlder, olderError, loadOlder };
}
