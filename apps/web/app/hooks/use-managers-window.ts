/**
 * マネージャー一覧の窓（いま画面に持っている分）。issue #670。
 *
 * **なぜ要るか。** 台帳（`jobs`）に行を消す口が無く、終端した委譲もそのまま
 * 残る（`ManagerPool#retire` の doc が、上限で刈る形を north_star 禁止2 として
 * 逐語で禁じている）。⟹ **一覧の件数は、その環境で今までに起こした委譲の総数
 * と等しい。** 直し方は「消す」ではなく絞り込みと窓である。
 *
 * **`useJournalWindow` ほどのことはしない。** あちらは SSE で先頭に割り込む
 * ぶんの取り合い（`prepended` / `shift`）と、同一 `at` の詰まり（`blocked`）を
 * 抱えている。こちらは片方向（古い側へ伸ばすだけ）で、錨は
 * `(startedAt, managerId)` の組なので同着で詰まらない（デーモン側が補助キー
 * まで含めて比較する。`apps/daemon/src/app.ts` の `compareManagerPagingKey`）。
 *
 * **`status` が変わったら呼び出し側で `key` を変えて丸ごと作り直すこと**
 * （`managers.tsx` の `ManagersBody` がそうしている）。ここでは「絞りが
 * 変わったら state をリセットする」ための effect を持たない —— `apps/web` の
 * eslint（`react-hooks/set-state-in-effect`）がその形を落とすので、
 * `useJournalWindow` と同じく「`key` で作り直す」側を採る。
 *
 * ## 読み足した頁（`older`）も生きた更新に追随する（issue #1624）
 *
 * **直す前の形。** 頁1（`first`、SWR）は `use-journal-live.ts` の
 * `invalidate()` が `mutate((key) => isKeyOfType(key, 'managers'))` で束ねて
 * 取り直すが、「もっと見る」で読み足した頁（`older`）は SWR の外に置いた
 * ただの `useState` で、`loadOlder()` を手で呼んだとき以外に書き換わる経路が
 * 無かった。⟹ 読み足した行の札・注記は「もっと見る」を押した瞬間の値に
 * 凍りつき、SSE がどれだけ届いても動かなかった。
 *
 * **選ばなかった案 —— `older` を `useSWRInfinite` へ移す。** SWR
 * (`swr@2.5.1`、`node_modules/swr/dist/config-context-*.mjs` の
 * `internalMutate`) の述語版 `mutate((key) => …)` は、`useSWRInfinite` が
 * 内部で使う集約キー（`$inf$` 接頭）を**常に除外する**
 * （`!/^\$(inf|sub)\$/.test(key) && keyFilter(...)` —— 除外は決め打ちで、
 * 呼び出し側からは外せない）。`useSWRInfinite` の各頁は個別の `useSWR` として
 * 登録されるわけではなく、集約キー1本の `fetcher` の中で頁ごとの取得を束ねて
 * いるので、`invalidate()` が指すのは束ねる側の `$inf$` キーであり、そこは
 * 上の除外に当たる。⟹ 頁を `useSWRInfinite` に移しても、いまの
 * `mutate((key) => isKeyOfType(key, 'managers'))` という指し方のままでは
 * 束から漏れる —— 動かすには `invalidate()` 側にこの窓の集約キーを個別に
 * 教える必要があり、「日誌の種別ごとに落とす束を1箇所で決める」という
 * `use-journal-live.ts` の設計を崩す。
 *
 * **採った案 —— 頁1の再検証に便乗する。** 頁1（`first`）は
 * `isValidating: true → false` の遷移で「1回の再検証が終わった」ことを言う。
 * これは `invalidate()` の `mutate()` だけでなく、SWR 既定の
 * revalidateOnFocus / revalidateOnReconnect でも同じ形で起こる —— **`older`
 * を「頁1が再検証されたら、読み足した頁も同じ錨で取り直す」だけの効果に
 * 閉じることで、頁1にすでに掛かっている SWR の間引き
 * （`dedupingInterval`。既定 2000ms）にそのまま乗る。** SSE が短時間に何本
 * 届いても、頁1の再検証は1回に間引かれ、`older` の取り直しはその1回にだけ
 * 便乗する —— 間引きを自分で作る必要が無い。
 *
 * **`first.data` の参照ではなく `first.isValidating` を見る理由。** SWR の
 * 既定 `compare` は `dequal`（深い等価）—— 頁1の中身が字面として変わって
 * いなければ、取り直しが実際に走っても `data` の参照は据え置かれる
 * （`node_modules/swr/dist/config-context-*.mjs` の `const compare = dequal`）。
 * 読み足した頁だけが変わって頁1が無傷、という筋書き（`invalidate()` が
 * `exchange(with:'manager')` で束を落とす一方、その委譲自体は頁1にもう
 * 載っていない場合）はまさにこれに当たるので、`data` を見ていると取り直し
 * そのものを見落とす。`isValidating` は実際に fetch が走ったかどうかを
 * 直接言うので、この見落としが無い。
 *
 * **錨は取り直さない。** 読み足した頁それぞれが最初に読んだときの
 * `(managerId, startedAt)` をそのまま使って撃ち直す —— 頁1の新しい末尾から
 * 錨を組み直すと、頁1の並びが動いたときに抜け・重複の形が変わりうる
 * （このファイルの `dedupeByManagerId` の doc、および `managers.test.tsx`
 * の「もっと見るが錨で継ぎ足す」の歯が固定している契約と同じ理由）。同じ
 * 錨で撃ち直す限り、返る行の並び（頁の順序）はいつでも今までどおりで、
 * `dedupeByManagerId` が頁1との重なりだけを吸収する —— 一覧が先頭へ飛ぶ
 * ことも、行が抜けることも無い。
 *
 * **取り直しが失敗した頁は、古い行をそのまま残す。** `Promise.allSettled`
 * で頁ごとに結果を見て、失敗した頁は前回の値のまま `setOlderPages` に渡す
 * （画面を空にしない）。
 *
 * **`lastOlderCount` / `olderStatus`（進捗・終端の判定）は動かさない。**
 * 動かしているのは常に `loadOlder()` が明示的に読んだときだけで、この
 * 背景の取り直しは「もう表示している頁の中身を新しくする」ことに閉じる
 * ——「もっと見る」を押せるかどうかの判定に、背景の取り直しの結果を
 * 混ぜない（`loadOlder` が同時に走っているときの競合を増やさないため）。
 * ⚠️ **確かめていないこと**: 背景の取り直しで最後の頁の件数が
 * `MANAGERS_PAGE` を割り込んでも、`olderStatus` はそのままなので
 * 「もっと見る」ボタンの有無はズレたままになりうる。実機でどれだけ
 * 起こりうるかは見ていない。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { managersToQuery, useManagers } from '~/hooks/queries';
import { unwrap, useApi } from '~/lib/api';
import type { ManagerStatus, ManagerSummary } from '~/lib/types';

/**
 * 初期表示・1回の「もっと見る」で読む件数。
 *
 * **続きが在るかは「この件数ちょうど返ったか」でしか判らない**（`GET /managers`
 * は封筒（`total` / `nextCursor`）を持たない。`apps/daemon/src/app.ts` の
 * `managersQuery` の doc）。だから読む件数と判定は必ず同じ値を見ること——
 * 生の数を2箇所に書くと片方だけ直して食い違う（`reports.tsx` の
 * `REPORTS_LIMIT` / `isReportsWindowFull` と同じ理由で名前を付けてある）。
 *
 * ⚠️ **この数字は実機で調整すべきもので、テストが通っても正しさの根拠には
 * ならない**（`journal.tsx` の各しきい値と同じ断り）。**50 は当てずっぽうで、
 * 実機での検証はしていない。**
 */
export const MANAGERS_PAGE = 50;

/**
 * 古い側のいまの状態。
 *
 * - `progress` — まだ続きが在りうる（`MANAGERS_PAGE` 件ちょうど返っている）
 * - `end` — 直前の頁が `MANAGERS_PAGE` 件に届かなかった（＝これで終い）
 * - `blocked` — 続きへ**自動では**進めない（下の `olderError` を見よ）
 *
 * **`end` と `blocked` を1つに畳まない。** 畳むと、進めなくなった状態が
 * 「全部読み終えた」と同じ顔で出る——**黙って終端に見せない**ことがこの
 * 3値の目的である（`journal.tsx` の `PageOutcome` が同じ線を引いている）。
 */
export type ManagersOlderStatus = 'progress' | 'end' | 'blocked';

export interface ManagersWindow {
  /** `startedAt` の降順、重複なし。 */
  managers: ManagerSummary[];
  isLoadingInitial: boolean;
  /** 先頭の頁（SWR）の失敗。 */
  error: unknown;

  olderStatus: ManagersOlderStatus;
  isLoadingOlder: boolean;
  /**
   * 「もっと見る」が失敗した理由。**`olderStatus === 'blocked'` のときに
   * 読む。**
   *
   * **いちばん起きる形は錨の 400 である。** 頁を読む間にその委譲の `status` が
   * 動くと（`running` → `done` を `status=running` で絞っている場合）、錨に
   * した行が絞りの外へ出て、デーモンは「そんな錨は刷っていない」として 400 を
   * 返す（黙って先頭から返さない側に倒してある。`apps/daemon/src/app.ts` の
   * 錨の実在検査）。**これは異常ではなく、絞り込みと窓を併せた口では正常に
   * 起きる**ので、画面はこれを終端と混ぜずに、次の一手（開き直す・絞りを
   * 変える）まで出す。
   */
  olderError: unknown;
  loadOlder: () => void;
}

/** 「もっと見る」で読み足した1頁。錨とその頁の中身を組で持つ。 */
interface OlderPage {
  after: { managerId: string; startedAt: string };
  managers: ManagerSummary[];
}

/** `OlderPage.after` を突き合わせるための文字列鍵。 */
function anchorKey(after: OlderPage['after']): string {
  return `${after.managerId}\u0000${after.startedAt}`;
}

export function useManagersWindow(status: readonly ManagerStatus[]): ManagersWindow {
  const api = useApi();
  const first = useManagers({ status, limit: MANAGERS_PAGE });

  const [olderPages, setOlderPages] = useState<OlderPage[]>([]);
  const [isLoadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(undefined);
  /**
   * 最後に読んだ「もっと見る」の頁の件数。`undefined` は「まだ1回も押して
   * いない」＝判定は先頭の頁の件数で行う、である。**0 と `undefined` を
   * 混ぜない**（0 は「押したが1件も無かった」＝終端）。
   */
  const [lastOlderCount, setLastOlderCount] = useState<number | undefined>(undefined);

  const page = first.data?.managers ?? [];
  const older = olderPages.flatMap((p) => p.managers);

  /**
   * 先頭の頁と読み足した分を繋ぐ。**`managerId` で重複を落とす。**
   *
   * 先頭の頁は SWR が取り直す（`use-journal-live.ts` が `managers` の束を
   * 落とす）し、読み足した頁も頁1の再検証に便乗して同じ錨で取り直される
   * （このファイル冒頭の doc）ので、どちらの取り直しで伸びた分も重なりうる。
   * **重なったときに残すのは先頭の頁の側である**——そちらが新しい観測だから
   * で、古い像で上書きすると札や注記が巻き戻る。
   */
  const managers = dedupeByManagerId([...page, ...older]);

  const lastCount = lastOlderCount ?? page.length;
  const olderStatus: ManagersOlderStatus =
    olderError !== undefined ? 'blocked' : lastCount < MANAGERS_PAGE ? 'end' : 'progress';

  const last = managers.at(-1);
  const anchorId = last?.managerId;
  const anchorStartedAt = last?.startedAt;

  const loadOlder = useCallback(() => {
    if (anchorId === undefined || anchorStartedAt === undefined) return;
    setLoadingOlder(true);
    // **押し直しは前の失敗を消す。** 消さないと `blocked` のまま固まり、
    // 押せるのに押しても状態が変わらない（読み手には壊れて見える）。
    setOlderError(undefined);
    // **クエリの組み立ては `managersToQuery` の1箇所に閉じる**（`useManagers`
    // と同じ関数を通す）。ここで手で組むと、`status` の空配列を送らない規則が
    // 先頭の頁と読み足す頁で割れる。
    const after = { managerId: anchorId, startedAt: anchorStartedAt };
    const query = managersToQuery({ status, limit: MANAGERS_PAGE, after });
    api.api
      .GET('/managers', { params: { query } })
      .then(unwrap)
      .then((body) => {
        setOlderPages((previous) => [...previous, { after, managers: body.managers }]);
        setLastOlderCount(body.managers.length);
      })
      .catch((error: unknown) => {
        setOlderError(error);
      })
      .finally(() => {
        setLoadingOlder(false);
      });
  }, [api, anchorId, anchorStartedAt, status]);

  // --- 読み足した頁を、頁1の再検証に便乗して取り直す（issue #1624）---------
  // 理由と選ばなかった案は、このファイル冒頭の doc「読み足した頁
  // （`older`）も生きた更新に追随する」を参照。
  const olderPagesRef = useRef(olderPages);
  useEffect(() => {
    olderPagesRef.current = olderPages;
  }, [olderPages]);

  // すでに背景の取り直しが走っている間は重ねて撃たない——次の頁1の
  // 再検証（次の SSE の束、または次の focus/reconnect）が来ればそこで
  // 追いつく。撃ちっぱなしにすると、SSE が頁1の間引きより短い間隔で
  // 何度も再検証を終える形（間引きの窓をまたいで2回終わる等）のときに
  // 同じ錨へ重ねて撃つことになる。
  const isRefreshingOlderRef = useRef(false);

  const refreshOlderPages = useCallback(() => {
    if (isRefreshingOlderRef.current) return;
    const pages = olderPagesRef.current;
    if (pages.length === 0) return;
    isRefreshingOlderRef.current = true;
    Promise.allSettled(
      pages.map((p) => {
        const query = managersToQuery({ status, limit: MANAGERS_PAGE, after: p.after });
        return api.api
          .GET('/managers', { params: { query } })
          .then(unwrap)
          .then((body): OlderPage => ({ after: p.after, managers: body.managers }));
      }),
    )
      .then((results) => {
        // **失敗した頁は前回の値のまま残す**（画面を空にしない）。成功した
        // 頁だけを錨で突き合わせて置き換える。
        const refreshed = new Map<string, ManagerSummary[]>();
        for (const result of results) {
          if (result.status === 'fulfilled') {
            refreshed.set(anchorKey(result.value.after), result.value.managers);
          }
        }
        if (refreshed.size === 0) return;
        setOlderPages((previous) =>
          previous.map((existing) => {
            const next = refreshed.get(anchorKey(existing.after));
            return next === undefined ? existing : { ...existing, managers: next };
          }),
        );
      })
      .finally(() => {
        isRefreshingOlderRef.current = false;
      });
  }, [api, status]);

  // `first.isValidating` が `true → false` になった瞬間だけ発火する。
  // `first.data` の参照ではなく `isValidating` を見る理由は、このファイル
  // 冒頭の doc（SWR の既定 `compare` が `dequal` であること）を参照。
  const wasValidatingRef = useRef(first.isValidating);
  useEffect(() => {
    const wasValidating = wasValidatingRef.current;
    wasValidatingRef.current = first.isValidating;
    if (wasValidating && !first.isValidating) {
      refreshOlderPages();
    }
  }, [first.isValidating, refreshOlderPages]);

  return {
    managers,
    isLoadingInitial: first.isLoading,
    error: first.error,
    olderStatus,
    isLoadingOlder,
    olderError,
    loadOlder,
  };
}

/**
 * `managerId` で重複を落とす。**先に現れたほうを残す**（呼び出し側が新しい
 * 観測を先に置く）。
 *
 * **`Set` で数えるだけの形にしない。** 落とすのは行そのものなので、
 * 「何件あったか」ではなく「どの行を残したか」が要る。
 */
function dedupeByManagerId(entries: readonly ManagerSummary[]): ManagerSummary[] {
  const seen = new Set<string>();
  const out: ManagerSummary[] = [];
  for (const entry of entries) {
    if (seen.has(entry.managerId)) continue;
    seen.add(entry.managerId);
    out.push(entry);
  }
  return out;
}
