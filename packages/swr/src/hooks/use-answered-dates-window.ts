import { useCallback, useEffect, useRef, useState } from 'react';

import { useAnsweredApprovalDates } from './queries';
import { unwrap, useApi } from '../api';
import type { AnsweredApprovalDate } from '@alteroid/logic';

export interface AnsweredDatesWindow {
  first: ReturnType<typeof useAnsweredApprovalDates>;
  dates: AnsweredApprovalDate[];
  hasMore: boolean;
  isLoadingOlder: boolean;
  olderError: unknown;
  loadOlder: () => void;
}

// `useSWRInfinite` を使わない: `mutate((key) => …)` の述語版が `$inf$` の集約キーを除外し、`approvals` の束を落とす無効化から漏れるため。
// 隙間（読み足し後に先頭の頁が取り直されて1日ずれ、境目の日がどちらにも入らない）は、
// 読み足した分を捨てて読み直さず先頭の頁の最後の日を起点に埋める: 読み直すと、いくつも読み足した後の一覧が縮むため
export function useAnsweredDatesWindow(limit: number): AnsweredDatesWindow {
  const api = useApi();
  const first = useAnsweredApprovalDates(limit);
  const [older, setOlder] = useState<AnsweredApprovalDate[]>([]);
  const [lastOlderCount, setLastOlderCount] = useState<number | undefined>(undefined);
  const [isLoadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(undefined);
  const [joint, setJoint] = useState<AnsweredApprovalDate | undefined>(undefined);
  const inFlight = useRef(false);

  const page = Array.isArray(first.data?.dates) ? first.data.dates : [];
  const seen = new Set<string>();
  const dates = [...page, ...older].filter((entry) => {
    if (seen.has(entry.date)) return false;
    seen.add(entry.date);
    return true;
  });

  const hasMore = (lastOlderCount ?? page.length) === limit;
  const pageEnd = page.at(-1);
  // `date` が固定幅なので、文字列の比較が日付の比較になる
  const gap = joint !== undefined && pageEnd !== undefined && pageEnd.date > joint.date;
  const anchor = gap ? pageEnd.date : dates.at(-1)?.date;

  const loadOlder = useCallback(() => {
    if (anchor === undefined || inFlight.current) return;
    inFlight.current = true;
    setLoadingOlder(true);
    setOlderError(undefined);
    api.api
      .GET('/approvals/answered-dates', { params: { query: { limit, beforeDate: anchor } } })
      .then(unwrap)
      .then((body) => {
        if (!Array.isArray(body.dates)) throw new Error('日付の一覧が読めない形で届いた');
        const filled = gap && body.dates.some((entry) => entry.date === older[0]?.date);
        setOlder((previous) =>
          gap ? (filled ? [...body.dates, ...previous] : body.dates) : [...previous, ...body.dates],
        );
        if (!filled) setLastOlderCount(body.dates.length);
        setJoint((previous) => (gap ? undefined : previous) ?? pageEnd);
      })
      .catch((error: unknown) => {
        setOlderError(error);
      })
      .finally(() => {
        inFlight.current = false;
        setLoadingOlder(false);
      });
  }, [api, anchor, limit, gap, older, pageEnd]);

  // 失敗したら自動では撃ち直さない: 押し直しで続きより先に隙間を埋め直す
  useEffect(() => {
    if (gap && olderError === undefined) loadOlder();
  }, [gap, olderError, loadOlder]);

  return { first, dates, hasMore, isLoadingOlder, olderError, loadOlder };
}
