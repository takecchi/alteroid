/**
 * 日誌の窓（いま画面に持っている一覧）を管理する。
 *
 * **カーソル送りの規則そのものは `~/lib/journal-window.ts` が持つ**（DOM にも
 * virtua にも触れない、純粋な関数）。ここはそれを SSE（`useJournalFeed`）と
 * `GET /journal` の実際の呼び出しに配線するだけの層である。
 *
 * `journal.tsx` はこのフックが返す `entries` をそのまま `Virtualizer` の
 * 子として並べる。`prepended` は「先頭に何か足された直後の1回の描画」を
 * 示す — virtua の `shift` prop に何を渡すかは、これと「いま上端に居るか」
 * （scroll 位置。ここでは持たない）を `~/lib/journal-window.ts` の
 * `shiftForPrepend` へ渡して決める（呼び出し側 = `journal.tsx` の仕事）。
 *
 * **種別フィルタ（`selected`）が変わったら呼び出し側で `key` を変えて
 * 丸ごと作り直すこと**（`journal.tsx` の `JournalBody` がそうしている）。
 * ここでは「フィルタが変わったら state をリセットする」ための effect を
 * 持たない — `apps/web` の eslint（`react-hooks/set-state-in-effect`。
 * `eslint.config.js` の「hooks の規則は apps/web だけに掛ける…バグ検出で
 * ある」の対象）は、effect の本文が同期的に `setState` を並べるだけの形
 * （＝レンダー中に計算できるはずのものを effect に追い出した形）を検出
 * して落とす。**`key` で作り直せば、初期値の `useState` がそのまま
 * リセットになる** — React 公式が推す「prop が変わったら state を
 * リセットする」の形そのもの
 * （https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useJournalFeed } from '~/hooks/journal-feed';
import { unwrap, useApi } from '~/lib/api';
import {
  applyNewerPage,
  applyOlderPage,
  JOURNAL_MAX_LIMIT,
  newerPageQuery,
  olderPageQuery,
  type PageOutcome,
} from '~/lib/journal-window';
import type { JournalEntry, JournalEntryType } from '~/lib/types';

/** 初期表示・1回の「もっと遡る」で読む件数。 */
export const JOURNAL_PAGE = 100;

interface JournalQueryParams {
  limit: number;
  type?: string;
  since?: string;
  until?: string;
}

export interface JournalWindow {
  /** 新しい順、重複なし。virtua の子としてそのまま並べる。 */
  entries: JournalEntry[];
  isLoadingInitial: boolean;
  error: unknown;

  /**
   * 過去方向のいまの状態。`'progress'` と `'retryLarger'` は画面には同じ
   * 「まだ続く」として見せてよい（`retryLarger` はフック内部で自動的に
   * `limit` を上げて撃ち直し、利用者からは1回の `loadOlder` に見える）。
   */
  olderStatus: PageOutcome;
  isLoadingOlder: boolean;
  loadOlder: () => void;

  /** 新着方向の取りこぼし確認（SSE の補完）。 */
  isLoadingNewer: boolean;
  /** 直近の取りこぼし確認が `blocked` で終わったか（同一 at の詰まり）。 */
  newerBlocked: boolean;
  refreshNewer: () => void;

  /**
   * 先頭に何か足された直後の1回の描画だけ `true`。
   *
   * ref ではなく「前回の描画と比べて調整する」React 公式パターン
   * （https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes）
   * で作る — `apps/web` の eslint（`react-hooks/refs`）は、レンダー中に
   * ref の `current` を読むこと自体を検出して落とす（先頭に足す/足さない
   * で値が変わるはずなのに、React が re-render を要求されていない ref の
   * 変化を追いかけられず、古い値のまま描画され得るため）。「先頭の1件目の
   * id が前回の描画と変わったか」で判定する — 末尾へ足す（`mergeBack`）
   * 操作は先頭の id を絶対に変えないので、この条件は「先頭に足された」
   * ことの誤検出の無い代理になる。
   *
   * **`shift` そのものではない。** `shift` に何を渡すかは
   * `~/lib/journal-window.ts` の `shiftForPrepend(prepended, atTop)` が
   * 決める（人間の判断、2026-08-23: 上端に居るときは `shift` を立てない
   * ＝新着がそのまま見える。遡って読んでいるときだけ立てる）。「いま
   * 上端に居るか」は scroll 位置の話でこのフックの関心の外なので、
   * 呼び出し側（`journal.tsx`）が持つ。
   */
  prepended: boolean;
}

export function useJournalWindow(selected: readonly JournalEntryType[]): JournalWindow {
  const api = useApi();
  const { recent } = useJournalFeed();
  const joined = selected.join(',');

  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [isLoadingInitial, setLoadingInitial] = useState(true);
  const [error, setError] = useState<unknown>(undefined);
  const [olderStatus, setOlderStatus] = useState<PageOutcome>('progress');
  const [isLoadingOlder, setLoadingOlder] = useState(false);
  const [isLoadingNewer, setLoadingNewer] = useState(false);
  const [newerBlocked, setNewerBlocked] = useState(false);

  // --- prepended（先頭に足された直後の1回の描画だけ true）------------------
  // 「前回の描画からの差分」を state として持ち、レンダー中に比べて
  // 調整する（effect ではない。上のクラス doc を参照）。
  const [prevFrontId, setPrevFrontId] = useState<string | undefined>(entries[0]?.id);
  const [prevLength, setPrevLength] = useState(entries.length);
  const frontId = entries[0]?.id;
  let prepended = false;
  if (frontId !== prevFrontId) {
    prepended = prevLength > 0 && entries.length > prevLength;
    setPrevFrontId(frontId);
    setPrevLength(entries.length);
  }

  // `entries` の最新値を非同期コールバックから読むための ref。
  // `applyOlderPage`/`applyNewerPage` はマージ結果と判定（outcome）を1回で
  // 返すので、`setEntries(prev => ...)` の更新式の中で判定を取り出す
  // （＝更新式に副作用を詰め込む）よりも、ref を素直に読むほうが単純になる。
  // **これは render 中には読まない** — 読むのは `.then()`/effect の中だけ
  // なので `react-hooks/refs` には当たらない。
  const entriesRef = useRef<JournalEntry[]>(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const buildQuery = useCallback(
    (limit: number, extra?: { since?: string; until?: string }): JournalQueryParams => ({
      limit,
      ...(joined === '' ? {} : { type: joined }),
      ...extra,
    }),
    [joined],
  );

  // --- 初期読み込み（マウント時に1回）--------------------------------------
  // フィルタが変わったときの作り直しは呼び出し側の `key` に任せている
  // （このファイル冒頭のコメント）ので、ここは同期的な reset を持たない。
  useEffect(() => {
    let cancelled = false;
    api.api
      .GET('/journal', { params: { query: buildQuery(JOURNAL_PAGE) } })
      .then(unwrap)
      .then((data) => {
        if (cancelled) return;
        const applied = applyOlderPage([], data.entries, JOURNAL_PAGE);
        setEntries(applied.entries);
        entriesRef.current = applied.entries;
        setOlderStatus(applied.outcome);
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

  // --- 過去方向（末尾へ）---------------------------------------------------
  // `limit` を上げて撃ち直す再帰を持つので、`useCallback` の自己参照
  // （メモ化された束縛を自分の中で読む）を避けるため、素の関数にしてある
  // （メモ化しない代わりに、再帰は毎回そのレンダーの `entriesRef`/`buildQuery`
  // をそのまま閉じ込めるので、古い束縛を掴む心配が無い）。
  function loadOlderAt(limit: number): void {
    const query = olderPageQuery(entriesRef.current);
    if (query === undefined) return;
    setLoadingOlder(true);
    api.api
      .GET('/journal', { params: { query: buildQuery(limit, query) } })
      .then(unwrap)
      .then((data) => {
        const applied = applyOlderPage(entriesRef.current, data.entries, limit, JOURNAL_MAX_LIMIT);
        setEntries(applied.entries);
        entriesRef.current = applied.entries;
        if (applied.outcome === 'retryLarger') {
          // **黙って終端に見せない。** limit を上げて同じ境界を撃ち直す
          // （`~/lib/journal-window.ts` の `pageOutcome` の doc）。
          loadOlderAt(JOURNAL_MAX_LIMIT);
          return;
        }
        setOlderStatus(applied.outcome);
        setLoadingOlder(false);
      })
      .catch((caught: unknown) => {
        setError(caught);
        setLoadingOlder(false);
      });
  }

  const loadOlder = useCallback(() => {
    if (isLoadingOlder || isLoadingInitial) return;
    if (olderStatus !== 'progress' && olderStatus !== 'retryLarger') return;
    loadOlderAt(JOURNAL_PAGE);
    // loadOlderAt は素の関数（上のコメント参照）。呼び出し時点の
    // entriesRef/buildQuery をそのまま使うので依存に含めない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoadingOlder, isLoadingInitial, olderStatus]);

  // --- 新着方向（先頭へ）。SSE の recent を主経路として重ね、
  //     取りこぼし確認（since の撃ち直し）を補う ------------------------
  useEffect(() => {
    const filtered =
      selected.length === 0 ? recent : recent.filter((e) => selected.includes(e.type));
    if (filtered.length === 0) return;
    const applied = applyNewerPage(entriesRef.current, filtered, filtered.length);
    if (applied.freshCount === 0) return;
    setEntries(applied.entries);
    entriesRef.current = applied.entries;
    // SSE が生きて届いている証拠なので、`since` の取りこぼし確認が
    // 直前に `blocked` を出していても、ここで下ろす。
    setNewerBlocked(false);
    // `selected` は呼び出し側の state 配列そのもの（toggle のたびに新しい
    // 参照になる）なので依存に入れてよい。`joined` と二重には持たない。
  }, [recent, selected]);

  function refreshNewerAt(limit: number): void {
    const query = newerPageQuery(entriesRef.current);
    if (query === undefined) return;
    setLoadingNewer(true);
    api.api
      .GET('/journal', { params: { query: buildQuery(limit, query) } })
      .then(unwrap)
      .then((data) => {
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
        setError(caught);
        setLoadingNewer(false);
      });
  }

  const refreshNewer = useCallback(() => {
    if (isLoadingNewer) return;
    refreshNewerAt(JOURNAL_PAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoadingNewer]);

  return {
    entries,
    isLoadingInitial,
    error,
    olderStatus,
    isLoadingOlder,
    loadOlder,
    isLoadingNewer,
    newerBlocked,
    refreshNewer,
    prepended,
  };
}
