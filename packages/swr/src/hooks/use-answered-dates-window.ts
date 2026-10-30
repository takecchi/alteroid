import { useCallback } from 'react';

import { useAnsweredApprovalDates } from './queries';
import { useOlderPagedWindow } from './use-older-paged-window';
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

const keyOfDate = (entry: AnsweredApprovalDate): string => entry.date;
// `date` が固定幅なので、文字列の比較が日付の比較になる
const orderOfDate = (entry: AnsweredApprovalDate): string => entry.date;

// 仕組みは `use-older-paged-window.ts`（日報の窓と同じ1本）
export function useAnsweredDatesWindow(limit: number): AnsweredDatesWindow {
  const api = useApi();
  const first = useAnsweredApprovalDates(limit);
  const page = Array.isArray(first.data?.dates) ? first.data.dates : [];
  const fetchOlder = useCallback(
    (anchor: AnsweredApprovalDate) =>
      api.api
        .GET('/approvals/answered-dates', {
          params: { query: { limit, beforeDate: anchor.date } },
        })
        .then(unwrap)
        .then((body) => {
          if (!Array.isArray(body.dates)) throw new Error('日付の一覧が読めない形で届いた');
          return body.dates;
        }),
    [api, limit],
  );
  const paged = useOlderPagedWindow({
    page,
    limit,
    keyOf: keyOfDate,
    orderOf: orderOfDate,
    fetchOlder,
  });
  return {
    first,
    dates: paged.items,
    hasMore: paged.hasMore,
    isLoadingOlder: paged.isLoadingOlder,
    olderError: paged.olderError,
    loadOlder: paged.loadOlder,
  };
}
