import { useCallback, useRef, useState } from 'react';

import { useAnsweredApprovalDates } from './queries';
import { unwrap, useApi } from '../api';
import type { AnsweredApprovalDate } from '@alteroid/logic';

/**
 * 回答済みの承認の「決着した日」の窓（いま画面に持っている分）。
 *
 * 先頭の頁は SWR（`useAnsweredApprovalDates`）、「もっと古い日を読む」で足した頁は `useState`。
 * **`useSWRInfinite` を使わない理由は `use-managers-window.ts` 冒頭と同じ**（`mutate((key) => …)` の
 * 述語版が `$inf$` の集約キーを除外するので、`approvals` の束を落とす既存の無効化から漏れる）。
 *
 * - 続きは `GET /approvals/answered-dates` の `beforeDate`（持っている最後の日）で読む。TUI の
 *   `loadMoreDates`（`apps/cli/src/tui/approvals-controller.ts`）と同じ考え方
 * - **封筒は無い**ので、続きが在るかは「直前の頁が `limit` 件ちょうどだったか」でしか判らない。
 *   足りなければ続きは無いとみなす（`hasMore` が `false`）
 * - **読み足しの失敗は `olderError` に載せ、持っている日は消さない**（一時的な失敗で画面を奪わない）。
 *   押し直すと前の失敗は消える
 * - 読み足した頁は取り直さない（先頭の頁だけが SWR で更新される）。日が重なったら先頭側を残す
 */
export interface AnsweredDatesWindow {
  /** 先頭の頁（SWR）の応答。`data` / `error` / `isLoading` / `mutate` はこれを見る。 */
  first: ReturnType<typeof useAnsweredApprovalDates>;
  /** 先頭の頁 + 読み足した分（新しい日が上・日付の重複なし）。先頭の頁が読めていなければ空。 */
  dates: AnsweredApprovalDate[];
  /** 「もっと古い日を読む」を出してよいか（直前の頁が `limit` 件ちょうど）。 */
  hasMore: boolean;
  isLoadingOlder: boolean;
  /** 読み足しの失敗（立っていても `dates` はそのまま）。 */
  olderError: unknown;
  loadOlder: () => void;
}

export function useAnsweredDatesWindow(limit: number): AnsweredDatesWindow {
  const api = useApi();
  const first = useAnsweredApprovalDates(limit);
  const [older, setOlder] = useState<AnsweredApprovalDate[]>([]);
  const [lastOlderCount, setLastOlderCount] = useState<number | undefined>(undefined);
  const [isLoadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(undefined);
  const inFlight = useRef(false);

  // 形の違う応答は「0件」ではなく空として扱う（呼び出し側が `first.data` の形で「読めていない」を言う）。
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
