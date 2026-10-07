// `selected` / `q` が変わったときの state のリセットを effect に持たない: 呼び出し側が `key` を変えて作り直す（`react-hooks/set-state-in-effect` に当たるため）
import { useCallback, useEffect, useRef, useState } from 'react';

import { useJournalFeed } from './journal-feed';
import { unwrap, useApi } from '../api';
import {
  applyInitialPage,
  applyNewerPage,
  applyOlderPage,
  filterRecent,
  formatDateTime,
  JOURNAL_MAX_LIMIT,
  JOURNAL_PAGE,
  journalHorizonNoteForHuman,
  newerPageQuery,
  olderPageQuery,
  readThroughUnreadable,
  type PageCursor,
  type PageOutcome,
} from '@alteroid/logic';
import type { JournalEntry, JournalEntryType } from '@alteroid/logic';

export { JOURNAL_PAGE };

interface JournalQueryParams {
  limit: number;
  type?: string;
  q?: string;
  since?: string;
  until?: string;
  afterId?: string;
  afterAt?: string;
  horizon?: 'true';
}

export interface JournalWindow {
  entries: JournalEntry[];
  isLoadingInitial: boolean;
  error: unknown;
  loadMoreError: unknown;
  retryLoadMore: () => void;

  olderStatus: PageOutcome;
  isLoadingOlder: boolean;
  loadOlder: () => void;

  horizonNote: string | undefined;

  isLoadingNewer: boolean;
  newerBlocked: boolean;
  refreshNewer: () => void;

  prepended: boolean;
}

export function useJournalWindow(selected: readonly JournalEntryType[], q = ''): JournalWindow {
  const api = useApi();
  const { recent } = useJournalFeed();
  const joined = selected.join(',');

  const [isLoadingInitial, setLoadingInitial] = useState(true);
  const [error, setError] = useState<unknown>(undefined);
  const [olderError, setOlderError] = useState<unknown>(undefined);
  const [newerError, setNewerError] = useState<unknown>(undefined);
  const [olderStatus, setOlderStatus] = useState<PageOutcome>('progress');
  const [isLoadingOlder, setLoadingOlder] = useState(false);
  const [isLoadingNewer, setLoadingNewer] = useState(false);
  const [newerBlocked, setNewerBlocked] = useState(false);
  // `olderStatus` が `'end'` でなくても常に最新の応答で上書きする: 次に `'end'` になったとき古い応答の値を見せないため
  const [horizonNote, setHorizonNote] = useState<string | undefined>(undefined);

  // `prepended` は更新と同じ state に載せる: レンダー中に前回と比べて `setState` で調整すると、その描画の結果が捨てられ、
  // コミットされる描画では常に `false` になり、virtua の `shift` が効かず読んでいる行が新着のたびに押し流される
  const [state, setState] = useState<{ entries: JournalEntry[]; prepended: boolean }>({
    entries: [],
    prepended: false,
  });
  const { entries, prepended } = state;
  function setEntries(next: JournalEntry[]): void {
    setState((previous) => ({
      entries: next,
      prepended:
        previous.entries.length > 0 &&
        next.length > previous.entries.length &&
        next[0]?.id !== previous.entries[0]?.id,
    }));
  }

  const olderCursorRef = useRef<PageCursor | null | undefined>(undefined);
  // 更新式 `setEntries(prev => ...)` の中で判定を取り出さない: 更新式に副作用を詰め込むことになるため、ref から読む
  const entriesRef = useRef<JournalEntry[]>(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const buildQuery = useCallback(
    (
      limit: number,
      extra?: {
        since?: string;
        until?: string;
        afterId?: string;
        afterAt?: string;
        horizon?: 'true';
      },
    ): JournalQueryParams => ({
      limit,
      ...(joined === '' ? {} : { type: joined }),
      ...(q === '' ? {} : { q }),
      ...extra,
    }),
    [joined, q],
  );

  useEffect(() => {
    let cancelled = false;
    api.api
      .GET('/journal', { params: { query: buildQuery(JOURNAL_PAGE, { horizon: 'true' }) } })
      .then(unwrap)
      .then((first) =>
        readThroughUnreadable(first, (cursor) =>
          api.api
            .GET('/journal', {
              params: {
                query: buildQuery(JOURNAL_PAGE, {
                  afterId: cursor.id,
                  afterAt: cursor.at,
                  horizon: 'true',
                }),
              },
            })
            .then(unwrap),
        ),
      )
      .then((data) => {
        if (cancelled) return;
        // `applyOlderPage` ではなく `applyInitialPage` を使う: 初期読み込みは窓を持たず、`limit` 未満で返った時点で `'end'` と言い切れる
        // （`applyOlderPage` だと日誌が短くても `'progress'` になり、「もっと遡る」を1回押すまで終端と地平の注記が出ない）
        const applied = applyInitialPage(data.entries, JOURNAL_PAGE, data.next);
        olderCursorRef.current = data.next;
        setEntries(applied.entries);
        entriesRef.current = applied.entries;
        setOlderStatus(applied.outcome);
        setHorizonNote(
          journalHorizonNoteForHuman(applied.outcome, data.oldestAt, data.crossesHorizon, (iso) =>
            formatDateTime(iso),
          ),
        );
        setLoadingInitial(false);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught);
        setLoadingInitial(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, buildQuery]);

  // `useCallback` にしない: `limit` を上げて撃ち直す再帰があり、メモ化した束縛の自己参照を避けるため
  function loadOlderAt(limit: number): void {
    const query = olderPageQuery(entriesRef.current, olderCursorRef.current);
    if (query === undefined) return;
    setLoadingOlder(true);
    api.api
      .GET('/journal', {
        params: {
          query: buildQuery(limit, 'afterId' in query ? { ...query, horizon: 'true' } : query),
        },
      })
      .then(unwrap)
      .then((first) =>
        readThroughUnreadable(first, (cursor) =>
          api.api
            .GET('/journal', {
              params: {
                query: buildQuery(limit, {
                  afterId: cursor.id,
                  afterAt: cursor.at,
                  horizon: 'true',
                }),
              },
            })
            .then(unwrap),
        ),
      )
      .then((data) => {
        setOlderError(undefined);
        const applied = applyOlderPage(
          entriesRef.current,
          data.entries,
          limit,
          JOURNAL_MAX_LIMIT,
          data.next,
        );
        olderCursorRef.current = data.next;
        setEntries(applied.entries);
        entriesRef.current = applied.entries;
        if (applied.outcome === 'retryLarger') {
          // 黙って終端に見せない: limit を上げて同じ境界を撃ち直す
          loadOlderAt(JOURNAL_MAX_LIMIT);
          return;
        }
        setOlderStatus(applied.outcome);
        setHorizonNote(
          journalHorizonNoteForHuman(applied.outcome, data.oldestAt, data.crossesHorizon, (iso) =>
            formatDateTime(iso),
          ),
        );
        setLoadingOlder(false);
      })
      .catch((caught: unknown) => {
        setOlderError(caught);
        setLoadingOlder(false);
      });
  }

  const loadOlder = useCallback(() => {
    if (isLoadingOlder || isLoadingInitial) return;
    if (olderStatus !== 'progress' && olderStatus !== 'retryLarger') return;
    loadOlderAt(JOURNAL_PAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoadingOlder, isLoadingInitial, olderStatus]);

  useEffect(() => {
    // SSE で届く新着にも画面の絞りを掛ける: 掛けないと、検索中の画面へ当たらない行が割り込む
    const filtered = filterRecent(recent, selected, q);
    if (filtered.length === 0) return;
    const applied = applyNewerPage(entriesRef.current, filtered, filtered.length);
    if (applied.freshCount === 0) return;
    setEntries(applied.entries);
    entriesRef.current = applied.entries;
    setNewerBlocked(false);
  }, [recent, selected, q]);

  function refreshNewerAt(limit: number): void {
    const query = newerPageQuery(entriesRef.current);
    if (query === undefined) return;
    setLoadingNewer(true);
    api.api
      .GET('/journal', { params: { query: buildQuery(limit, query) } })
      .then(unwrap)
      .then((data) => {
        setNewerError(undefined);
        const applied = applyNewerPage(entriesRef.current, data.entries, limit, JOURNAL_MAX_LIMIT);
        if (applied.outcome === 'retryLarger') {
          refreshNewerAt(JOURNAL_MAX_LIMIT);
          return;
        }
        setEntries(applied.entries);
        entriesRef.current = applied.entries;
        setNewerBlocked(applied.outcome === 'blocked');
        setLoadingNewer(false);
      })
      .catch((caught: unknown) => {
        setNewerError(caught);
        setLoadingNewer(false);
      });
  }

  const refreshNewer = useCallback(() => {
    if (isLoadingNewer) return;
    refreshNewerAt(JOURNAL_PAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoadingNewer]);

  const loadMoreError = olderError ?? newerError;
  const retryLoadMore = useCallback(() => {
    if (olderError !== undefined) {
      if (!isLoadingOlder) loadOlderAt(JOURNAL_PAGE);
    } else if (newerError !== undefined) {
      if (!isLoadingNewer) refreshNewerAt(JOURNAL_PAGE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [olderError, newerError, isLoadingOlder, isLoadingNewer]);

  return {
    entries,
    isLoadingInitial,
    error,
    loadMoreError,
    retryLoadMore,
    olderStatus,
    isLoadingOlder,
    loadOlder,
    isLoadingNewer,
    newerBlocked,
    refreshNewer,
    prepended,
    horizonNote,
  };
}
