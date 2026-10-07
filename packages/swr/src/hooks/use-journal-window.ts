/**
 * 日誌の窓（いま画面に持っている一覧）を管理する。
 *
 * **カーソル送りの規則そのものは `packages/logic/src/journal-window.ts` が持つ**（DOM にも
 * virtua にも触れない、純粋な関数）。ここはそれを SSE（`useJournalFeed`）と
 * `GET /journal` の実際の呼び出しに配線するだけの層である。
 *
 * `journal.tsx` はこのフックが返す `entries` をそのまま `Virtualizer` の
 * 子として並べる。`prepended` は「直近の `entries` の更新が先頭への足しだったか」を
 * 示す（次の更新まで残る）— virtua の `shift` prop に何を渡すかは、これと「いま上端に居るか」
 * （scroll 位置。ここでは持たない）を `packages/logic/src/journal-window.ts` の
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

/** 初期表示・1回の「もっと遡る」で読む件数。定義は `@alteroid/logic`（import 元を変えないための再 export）。 */
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
  /** 新しい順、重複なし。virtua の子としてそのまま並べる。 */
  entries: JournalEntry[];
  isLoadingInitial: boolean;
  /** **初回の読み込みの失敗だけ**。読み足し（過去方向・新着方向）の失敗は `loadMoreError`。 */
  error: unknown;
  /**
   * 読み足し（過去方向 / 新着方向の取りこぼし確認）の失敗。一覧は残す。**成功したら下りる**
   * （過去方向と新着方向は別々に持ち、両方失敗しているときは過去方向を返す）。
   */
  loadMoreError: unknown;
  /** 失敗している読み足しを撃ち直す。読み込み中・失敗が無いときは何もしない。 */
  retryLoadMore: () => void;

  /**
   * 過去方向のいまの状態。`'progress'` と `'retryLarger'` は画面には同じ
   * 「まだ続く」として見せてよい（`retryLarger` はフック内部で自動的に
   * `limit` を上げて撃ち直し、利用者からは1回の `loadOlder` に見える）。
   */
  olderStatus: PageOutcome;
  isLoadingOlder: boolean;
  loadOlder: () => void;

  /**
   * `olderStatus === 'end'` のとき、その終端が日誌の地平（`GET /journal` の
   * `oldestAt`/`crossesHorizon`）より前にかかって
   * いたら、その趣旨の注記。かかっていなければ（本当に終端だと言い切れる
   * なら）`undefined`。**`packages/logic/src/journal-window.ts` の `journalHorizonNote` が
   * 決定を持つ**（このフックは直近の応答を渡すだけ）。
   */
  horizonNote: string | undefined;

  /** 新着方向の取りこぼし確認（SSE の補完）。 */
  isLoadingNewer: boolean;
  /** 直近の取りこぼし確認が `blocked` で終わったか（同一 at の詰まり）。 */
  newerBlocked: boolean;
  refreshNewer: () => void;

  /**
   * 直近の `entries` の更新が、先頭に何か足された（新着）ものだったとき `true`。次の更新まで残る。
   *
   * 更新と同じ state に載せてある（`setEntries`）。レンダー中に前回と比べて `setState` で調整する形は、
   * その描画の結果を捨てて描き直すので、コミットされる描画では常に `false` になる。
   * 「先頭の1件目の id が変わり、かつ件数が増えた」で判定する — 末尾へ足す（`mergeBack`）操作は
   * 先頭の id を絶対に変えない。
   *
   * **`shift` そのものではない。** `shift` に何を渡すかは
   * `packages/logic/src/journal-window.ts` の `shiftForPrepend(prepended, atTop)` が
   * 決める（上端に居るときは `shift` を立てない
   * ＝新着がそのまま見える。遡って読んでいるときだけ立てる）。「いま
   * 上端に居るか」は scroll 位置の話でこのフックの関心の外なので、
   * 呼び出し側（`journal.tsx`）が持つ。
   */
  prepended: boolean;
}

/**
 * @param q 本文を語で探す。**空文字列は「絞らない」**
 *   （`matchesJournalSearch` の doc）。**サーバへ投げる** —— 画面側で捨てると
 *   「出していないだけ」の層ができる（このファイルの `buildQuery`、および
 *   `journal.tsx` の「絞り込みはサーバに投げる」の逐語）。**呼び出し側で
 *   debounce してから渡すこと**（打鍵ごとに撃たない。`journal.tsx` が持つ）。
 *
 *   **`q` が変わったら呼び出し側で `key` を変えて丸ごと作り直すこと**
 *   （`selected` と同じ理由。このファイル冒頭の doc）。
 */
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
  // 日誌の地平の注記。直近の過去方向の応答が持っていた
  // `oldestAt`/`crossesHorizon` から `journalHorizonNote` が決める。
  // `olderStatus` が `'end'` でなければ中身は使われない（`journalHorizonNote` の doc）が、
  // 値そのものは常に最新の応答で上書きしておく（次に `'end'` になったとき古い応答の値を見せない）。
  const [horizonNote, setHorizonNote] = useState<string | undefined>(undefined);

  // --- prepended（直近の `entries` の更新が「先頭に足された」ものだったか）---
  // **更新と同じ state に載せる**（`setEntries` の中で決める）。レンダー中に前回の描画と
  // 比べて `setState` で調整する形にしない。その形は `setState` を呼んだ描画の結果を
  // **捨てて**描き直すので、先頭に足された描画で立った `true` は捨てられた描画の側にしか
  // 無く、コミットされる描画では常に `false` になる。すると virtua の `shift` が1度も効かず、
  // 読んでいる行が新着のたびに押し流される（実機で新着1件ごとに約39px 下がった）。
  // **次の更新が来るまで `true` のまま残る**（更新が末尾への足し・初回読み込みなら `false`
  // に戻る）。`shift` は virtua が「件数が変わった描画」でだけ見るので、残っていても
  // 再描画（scroll・状態の更新）では何も起きない。
  const [state, setState] = useState<{ entries: JournalEntry[]; prepended: boolean }>({
    entries: [],
    prepended: false,
  });
  const { entries, prepended } = state;
  function setEntries(next: JournalEntry[]): void {
    setState((previous) => ({
      entries: next,
      // 先頭の id が変わり、かつ件数が増えた＝先頭に足された。末尾へ足す
      // （`mergeBack`）操作は先頭の id を絶対に変えない。
      prepended:
        previous.entries.length > 0 &&
        next.length > previous.entries.length &&
        next[0]?.id !== previous.entries[0]?.id,
    }));
  }

  // **過去方向の継続点**（`GET /journal` の `next`）。
  // `undefined` = まだ持っていない／応答に欄が無い（古いデーモン。`until` で遡る）、
  // `null` = 終端。ストアが読めない行を捨てても、ここが先の行へ運ぶ。
  const olderCursorRef = useRef<PageCursor | null | undefined>(undefined);
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
      // **空のときは渡さない。** デーモン側は `q=`（空）も「絞らない」に
      // 倒すので結果は同じだが（`app.ts` の `journalQuery` の `q`）、
      // 渡さないほうが「絞っていない」という意図がクエリ文字列に出る。
      ...(q === '' ? {} : { q }),
      ...extra,
    }),
    [joined, q],
  );

  // --- 初期読み込み（マウント時に1回）--------------------------------------
  // フィルタが変わったときの作り直しは呼び出し側の `key` に任せている
  // （このファイル冒頭のコメント）ので、ここは同期的な reset を持たない。
  useEffect(() => {
    let cancelled = false;
    api.api
      .GET('/journal', { params: { query: buildQuery(JOURNAL_PAGE, { horizon: 'true' }) } })
      .then(unwrap)
      // 頁が全部読めない行で、空なのに終端ではないとき、継続点から読み継ぐ。
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
        // **`applyOlderPage` ではなく `applyInitialPage` を使う。**
        // 初期読み込みは窓（`since`/`until`）を持たないので
        // `applyOlderPage`/`pageOutcome` の境界の曖昧さ（同じ行の再送）が
        // 最初から起こらない——`limit` 未満で返った時点で `'end'` と
        // 言い切れる（`applyInitialPage` の doc）。これが無いと、日誌が
        // 短くても初期読み込みは常に `'progress'` になり、「もっと遡る」を
        // 1回押すまで `'end'`（と地平の注記）が出ない。
        const applied = applyInitialPage(data.entries, JOURNAL_PAGE, data.next);
        olderCursorRef.current = data.next;
        setEntries(applied.entries);
        entriesRef.current = applied.entries;
        setOlderStatus(applied.outcome);
        // **初期読み込みは since/until を送らないが、`horizon: 'true'` を
        // 渡すので `data.oldestAt`/`data.crossesHorizon` は付く**
        // （`apps/daemon/src/app.ts` の `GET /journal` の `horizon`
        // クエリの doc）。日誌が `JOURNAL_PAGE` に収まるほど短いと、
        // 「もっと遡る」を一度も撃たないまま最初の1回で終端に達する——
        // その場合でも地平の注記の材料が届くのは、この `horizon: 'true'`
        // のおかげである。常に上書きしておく——`journalHorizonNote` は
        // `undefined` を「地平にかかっていない」と同じ扱いで注記を出さない。
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

  // --- 過去方向（末尾へ）---------------------------------------------------
  // `limit` を上げて撃ち直す再帰を持つので、`useCallback` の自己参照
  // （メモ化された束縛を自分の中で読む）を避けるため、素の関数にしてある
  // （メモ化しない代わりに、再帰は毎回そのレンダーの `entriesRef`/`buildQuery`
  // をそのまま閉じ込めるので、古い束縛を掴む心配が無い）。
  function loadOlderAt(limit: number): void {
    const query = olderPageQuery(entriesRef.current, olderCursorRef.current);
    if (query === undefined) return;
    setLoadingOlder(true);
    api.api
      .GET('/journal', {
        params: {
          // 継続点で読むと `until` が付かず地平の材料が付かない——`horizon` で求める。
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
          // **黙って終端に見せない。** limit を上げて同じ境界を撃ち直す
          // （`packages/logic/src/journal-window.ts` の `pageOutcome` の doc）。
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
    // loadOlderAt は素の関数（上のコメント参照）。呼び出し時点の
    // entriesRef/buildQuery をそのまま使うので依存に含めない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoadingOlder, isLoadingInitial, olderStatus]);

  // --- 新着方向（先頭へ）。SSE の recent を主経路として重ね、
  //     取りこぼし確認（since の撃ち直し）を補う ------------------------
  useEffect(() => {
    // **SSE で届く新着にも、いま画面に掛かっている絞りを同じだけ掛ける。**
    // 掛けないと、検索中の画面へ当たらない行が割り込む（＝画面が「その語で
    // 探した結果」でなくなる）。**照合は `@alteroid/core/journal-search` の
    // 1つの実装を通す** —— 欄の一覧をここへ書き写すと、サーバ側と画面側で
    // 「当たる」の意味が静かにずれる（`journal-search.ts` の doc）。
    //
    // **`@alteroid/core` 本体からではなく `/journal-search` から取ること。**
    // 本体から**値**を import すると、サーバ専用のドメイン層ごとブラウザ
    // バンドルへ入る（`/commitments` が 1.2MB になり本番で開けなくなった。
    // `routes/commitments.tsx` の doc）。この口は実行時の
    // 依存を1つも持たない（`packages/core/tsup.config.ts`）。
    const filtered = filterRecent(recent, selected, q);
    if (filtered.length === 0) return;
    const applied = applyNewerPage(entriesRef.current, filtered, filtered.length);
    if (applied.freshCount === 0) return;
    setEntries(applied.entries);
    entriesRef.current = applied.entries;
    // SSE が生きて届いている証拠なので、`since` の取りこぼし確認が
    // 直前に `blocked` を出していても、ここで下ろす。
    setNewerBlocked(false);
    // `selected` は依存に入れてよい（`joined` と二重には持たない）。
    // **前提**: `selected` は呼び出し側（`journal.tsx`）が URL の生の文字列を
    // `useMemo` で包んで作る配列で、その生の文字列が変わらない限り同じ参照を返す。
    // 毎描画で参照が変わると、チップを押していなくても（例: 検索欄の打鍵で
    // `Journal` が再描画されるたびに）この effect が無関係に走り直す。
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
    // loadOlderAt / refreshNewerAt は素の関数（上のコメント参照）。
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
