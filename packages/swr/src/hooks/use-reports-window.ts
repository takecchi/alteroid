import { useCallback, useEffect, useRef, useState } from 'react';

import { useReports } from './queries';
import { unwrap, useApi } from '../api';
import type { DailyReport } from '@alteroid/logic';

export interface ReportsWindow {
  first: ReturnType<typeof useReports>;
  reports: DailyReport[];
  hasMore: boolean;
  isLoadingOlder: boolean;
  olderError: unknown;
  loadOlder: () => void;
}

// `useSWRInfinite` を使わない理由は `use-answered-dates-window.ts` と同じ。
// 並べ直さない: 並びはデーモンが決める。
// 隙間（読み足し後に先頭の頁が取り直されて1件ずれ、境目の行がどちらにも入らない）は、
// 読み足した分を捨てて読み直さず先頭の頁の最後の行を起点に埋める: 読み直すと、いくつも読み足した後の一覧が縮むため
export function useReportsWindow(limit: number): ReportsWindow {
  const api = useApi();
  const first = useReports(limit);
  const [older, setOlder] = useState<DailyReport[]>([]);
  const [lastOlderCount, setLastOlderCount] = useState<number | undefined>(undefined);
  const [isLoadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(undefined);
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
  // `date` が固定幅なので、つなげた文字列の比較が (date, at) の比較になる
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

  // 失敗したら自動では撃ち直さない: 押し直しで続きより先に隙間を埋め直す
  useEffect(() => {
    if (gap && olderError === undefined) loadOlder();
  }, [gap, olderError, loadOlder]);

  return { first, reports, hasMore, isLoadingOlder, olderError, loadOlder };
}
