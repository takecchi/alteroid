import { useCallback } from 'react';

import { useReports } from './queries';
import { useOlderPagedWindow } from './use-older-paged-window';
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

const keyOfReport = (report: DailyReport): string => report.id;
// `date` が固定幅なので、つなげた文字列の比較が (date, at) の比較になる
const orderOfReport = (report: DailyReport): string => report.date + report.at;

// 仕組みは `use-older-paged-window.ts`（回答済みの日付の窓と同じ1本）
export function useReportsWindow(limit: number): ReportsWindow {
  const api = useApi();
  const first = useReports(limit);
  const page = Array.isArray(first.data?.reports) ? first.data.reports : [];
  const fetchOlder = useCallback(
    (anchor: DailyReport) =>
      api.api
        .GET('/reports', {
          params: { query: { limit, beforeDate: anchor.date, beforeAt: anchor.at } },
        })
        .then(unwrap)
        .then((body) => {
          if (!Array.isArray(body.reports)) throw new Error('日報の一覧が読めない形で届いた');
          return body.reports;
        }),
    [api, limit],
  );
  const paged = useOlderPagedWindow({
    page,
    limit,
    keyOf: keyOfReport,
    orderOf: orderOfReport,
    fetchOlder,
  });
  return {
    first,
    reports: paged.items,
    hasMore: paged.hasMore,
    isLoadingOlder: paged.isLoadingOlder,
    olderError: paged.olderError,
    loadOlder: paged.loadOlder,
  };
}
