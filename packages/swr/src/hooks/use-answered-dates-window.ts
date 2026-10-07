import { useCallback, useRef, useState } from 'react';

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

// `useSWRInfinite` を使わない: `mutate((key) => …)` の述語版が `$inf$` の集約キーを除外し、`approvals` の束を落とす無効化から漏れるため
export function useAnsweredDatesWindow(limit: number): AnsweredDatesWindow {
  const api = useApi();
  const first = useAnsweredApprovalDates(limit);
  const [older, setOlder] = useState<AnsweredApprovalDate[]>([]);
  const [lastOlderCount, setLastOlderCount] = useState<number | undefined>(undefined);
  const [isLoadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(undefined);
  const inFlight = useRef(false);

  const page = Array.isArray(first.data?.dates) ? first.data.dates : [];
  const seen = new Set<string>();
  const dates = [...page, ...older].filter((entry) => {
    if (seen.has(entry.date)) return false;
    seen.add(entry.date);
    return true;
  });

  const hasMore = (lastOlderCount ?? page.length) === limit;
  const anchor = dates.at(-1)?.date;

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
        setOlder((previous) => [...previous, ...body.dates]);
        setLastOlderCount(body.dates.length);
      })
      .catch((error: unknown) => {
        setOlderError(error);
      })
      .finally(() => {
        inFlight.current = false;
        setLoadingOlder(false);
      });
  }, [api, anchor, limit]);

  return { first, dates, hasMore, isLoadingOlder, olderError, loadOlder };
}
