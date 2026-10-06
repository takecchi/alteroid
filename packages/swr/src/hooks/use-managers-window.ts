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
 * **失敗は state に残して画面へ渡す（issue #3092）。** 失敗した頁が古い行のまま残るだけだと、
 * 先頭の頁は新しいので一覧全体が最新に見え、止まった行が今の値に見える（`error` は先頭の頁、
 * `olderError` は「もっと見る」の失敗だけ）。そこで取り直しの失敗を `olderRefreshError` に載せる
 * （古い行は残したまま。`olderError` / `blocked` とは別物で、押し直す口を塞がない）。次の取り直しが
 * 全頁通れば消える。
 *
 * **走っている間に来た分は取りこぼさない —— 最大1回の追い撃ち。** 背景の
 * 取り直しが1本（`R1`）走っている間にもう一度 `first.isValidating` が
 * `true → false` になったら（＝別の SSE がもう1本、頁1の再検証を終わらせた
 * ら）、その場で重ねて2本目を撃つ代わりに「積み残しが在る」という印
 * （`olderRefreshDirtyRef`）だけを立てて `return` する。`R1` が終わった時点で
 * この印を見て、立っていれば消してからもう1回だけ撃ち直す
 * （`runOlderRefresh` の再帰）。**何本 SSE が重なっても、印は1つしか持たない
 * ので追い撃ちは最大1回に収まる** —— `R1` が終わった時点でのいちばん新しい
 * 錨（`olderPagesRef.current`）で撃ち直すので、間に「もっと見る」で頁が
 * 増えていてもそれも一緒に取り直される。
 *
 * **これが無いと何が起きるか。** `R1` の応答がサーバ側では②の変化より
 * *前*に確定していた場合（＝在庫としては古い値のまま応答が組み立てられて
 * いた場合）、`R1` が返ってきても中身は古いままで、かつ「次の頁1の再検証が
 * 来ればそこで追いつく」が成り立つのは*次の SSE が実際に来たとき*だけ
 * ——それ以降 SSE が来なければ、読み足した行はその古い値のまま残り続ける
 * （issue #1624 のレビューで指摘された取りこぼし。`managers-older-refresh
 * -in-flight.test.tsx` がこの筋書きを歯にしている）。
 *
 * **重ねて2本を並行に撃たない理由。** 同じ錨へ2本の要求を並行に飛ばすと、
 * 応答が届く順序がネットワークの都合で入れ替わりうる——先に撃った方が
 * 後から届くと、`setOlderPages` が新しい値を古い値で上書きしてしまう
 * （SWR がこの並び替えを気にしなくてよいのは、`dedupingInterval` の間は
 * 同じキーへの要求を1本に併合しているからで、ここでも同じ理由で「常に
 * 1本ずつ、順に撃つ」側を採っている）。
 *
 * ## `lastOlderCount` / `olderStatus`（進捗・終端の判定）—— #1629 は動かさなかった。#1998 で最後の頁に限り動かす
 *
 * **#1629 の時点の判断（経緯として残す）。** `lastOlderCount` を動かすのは
 * 常に `loadOlder()` が明示的に読んだときだけとし、この背景の取り直しは
 * 「もう表示している頁の中身を新しくする」ことに閉じていた——「もっと
 * 見る」を押せるかどうかの判定に、背景の取り直しの結果を混ぜない
 * （`loadOlder` が同時に走っているときの競合を増やさないため）。
 *
 * **その判断が残した穴（issue #1998）。** `olderStatus` の材料は
 * `lastOlderCount` だけで、`lastOlderCount` を書くのは `loadOlder()` だけ
 * だったので、背景の取り直しで最後の頁の件数が変わっても「もっと見る」の
 * 有無は前回の判定のまま残った。特に「最後の頁が `MANAGERS_PAGE` 未満
 * （end）→ 取り直しで `MANAGERS_PAGE` 件」の向きでは、続きがあるのに
 * ボタンが消えたままになる（重い向き——逆向き「`progress` のまま留まる」
 * は、押せば0件が返って1回で `end` に直るので実害が小さい）。
 *
 * **#1998 での直し方。** `runOlderRefresh` が**最後の頁**（`pages` 配列の
 * 末尾）を取り直せたときだけ、その頁の件数で `lastOlderCount` を更新する。
 * ただし次のどちらかに当たる回は更新しない——#1629 が避けたかった
 * `loadOlder()` との競合をここで持ち込まないため:
 *
 * - **`loadOlder()` が走っている間**（`isLoadingOlderRef` で見る。
 *   `isLoadingOlder` state を直接使わない理由は、`runOlderRefresh` が
 *   素の関数で `useCallback` の自己参照を避けて作ってあり、`refreshOlderPages`
 *   が古いレンダーの `runOlderRefresh` を握ったまま呼び続けうるため——
 *   ref なら常に最新の値を読む）。
 * - **取り直しの応答が届くまでに頁が足された**——最後の頁の錨
 *   （`anchorKey`）が取り直しを始めた時点から変わっていたら、それは
 *   `loadOlder()` が割り込んで新しい頁を足したということなので、古い
 *   最後の頁の結果でいまの最後の頁の判定を上書きしない。
 *
 * 取り直しが失敗した頁（最後の頁を含む）は今までどおり前回の値のまま
 * 残る——`lastOlderCount` もそのときは動かさない（`Promise.allSettled` の
 * 対応する結果が `rejected` なら何もしない）。`olderError`（`blocked`）の
 * 扱いは変えていない——`loadOlder()` が明示に失敗したときだけ立つ。
 *
 * ⚠️ **確かめていないこと**: 実機（本物のデーモン・本物の SSE）での動作は
 * 確かめていない。根拠はスタブ（`test-support.tsx` の `stubFetch`/`sse`）を
 * 使ったテスト（`managers-older-status.test.tsx` /
 * `managers-older-status-inflight.test.tsx`）のみ。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { managersToQuery, useManagers } from './queries';
import { unwrap, useApi } from '../api';
import type { ManagerStatus, ManagerSummary, UnreadableJob } from '@alteroid/logic';

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
  /**
   * 読めなかった委譲の行（issue #2345）。**「居ない」でも「畳まれた」でもない第3の状態。**
   * 先頭の頁の応答から取る——`GET /managers` は窓（`status` / `limit` / 錨）では切らず、
   * どの頁にも全件を載せる（0件なら鍵が無いので、ここは空配列）。
   */
  unreadable: UnreadableJob[];

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
  /**
   * 読み足した頁（2頁目以降）の**背景の取り直し**が失敗した理由（issue #3092）。`undefined` は
   * 直近の取り直しが全頁通った（または、まだ1回も走っていない）。立っているとき、`managers` の
   * うち先頭の頁より後ろの行は**前に読めたときのもの**である（行は消さずに残してある）。
   */
  olderRefreshError: unknown;
  loadOlder: () => void;
  /** 先頭の頁を取り直す（読み込みの失敗からの「もう一度試す」。issue #2799）。 */
  reload: () => void;
  /** 取り直しの最中。 */
  isReloading: boolean;
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
  /** 背景の取り直しの失敗（issue #3092）。`olderError`（「もっと見る」の失敗）とは別に持つ。 */
  const [olderRefreshError, setOlderRefreshError] = useState<unknown>(undefined);
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

  // `loadOlder()` が「いま走っているか」を素の関数（`runOlderRefresh`）から
  // 読むための ref（issue #1998）。理由はこのファイル冒頭の doc
  // 「`lastOlderCount` / `olderStatus`」を参照。
  const isLoadingOlderRef = useRef(isLoadingOlder);
  useEffect(() => {
    isLoadingOlderRef.current = isLoadingOlder;
  }, [isLoadingOlder]);

  // すでに背景の取り直しが走っている間は重ねて撃たない——代わりに
  // 「走っている間にもう1回来た」ことだけを覚えておき（下の
  // `olderRefreshDirtyRef`）、いま走っている分が終わった時点で消費して
  // もう1回だけ撃ち直す（`runOlderRefresh` の再帰）。理由はこのファイル
  // 冒頭の doc「走っている間に来た分は取りこぼさない」を参照。
  const isRefreshingOlderRef = useRef(false);
  const olderRefreshDirtyRef = useRef(false);

  // `useCallback` の自己参照を避けるため素の関数にしてある
  // （`use-journal-window.ts` の `loadOlderAt` と同じ理由・同じ形）。
  function runOlderRefresh(): void {
    const pages = olderPagesRef.current;
    // `.at(-1)` で読む——`noUncheckedIndexedAccess` のもとでは添字アクセスは
    // 常に `| undefined` になるので、`pages.length === 0` の分岐と別に、
    // 「末尾が実在する」ことを型の上でも確かめる。
    const lastPageAtStart = pages.at(-1);
    if (lastPageAtStart === undefined) {
      isRefreshingOlderRef.current = false;
      return;
    }
    // **開始時点の「最後の頁」の錨を覚えておく**（issue #1998）。取り直しの
    // 応答が届くまでに `loadOlder()` が新しい頁を足すと、いまの「最後の頁」
    // はこれとは別物になる——そのときは古い最後の頁の結果で判定を
    // 上書きしない（このファイル冒頭の doc を参照）。
    const lastAnchorAtStart = anchorKey(lastPageAtStart.after);
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
        // **失敗は言う**（issue #3092）。1頁でも落ちたら理由を立て、全頁通れば消す。
        const rejected = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        setOlderRefreshError(rejected === undefined ? undefined : rejected.reason);
        if (refreshed.size > 0) {
          setOlderPages((previous) =>
            previous.map((existing) => {
              const next = refreshed.get(anchorKey(existing.after));
              return next === undefined ? existing : { ...existing, managers: next };
            }),
          );
        }

        // **最後の頁を取り直せたら `lastOlderCount` も更新する**
        // （issue #1998）。`results` は `pages` と同じ並びなので、末尾が
        // 「最後の頁」の結果である。
        const lastResult = results.at(-1);
        const currentLastPage = olderPagesRef.current.at(-1);
        const currentLastAnchor =
          currentLastPage === undefined ? undefined : anchorKey(currentLastPage.after);
        const anchorUnchangedSinceStart = currentLastAnchor === lastAnchorAtStart;
        if (
          lastResult !== undefined &&
          lastResult.status === 'fulfilled' &&
          anchorUnchangedSinceStart &&
          !isLoadingOlderRef.current
        ) {
          setLastOlderCount(lastResult.value.managers.length);
        }
      })
      .finally(() => {
        // **積み残しが在れば、消費してもう1回だけ撃ち直す。** `isRefreshing`
        // を立てたまま再帰するので、この1本が終わるまでは次の積み残しも
        // 重ねて撃たれない（最大1回の追い撃ちに収まる）。
        if (olderRefreshDirtyRef.current) {
          olderRefreshDirtyRef.current = false;
          runOlderRefresh();
        } else {
          isRefreshingOlderRef.current = false;
        }
      });
  }

  const refreshOlderPages = useCallback(() => {
    if (isRefreshingOlderRef.current) {
      olderRefreshDirtyRef.current = true;
      return;
    }
    if (olderPagesRef.current.length === 0) return;
    isRefreshingOlderRef.current = true;
    runOlderRefresh();
    // `runOlderRefresh` は素の関数で、呼ぶたびに最新の
    // `olderPagesRef`/`status`/`api` をそのまま読む（依存に含めない）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    unreadable: first.data?.unreadable ?? [],
    olderStatus,
    isLoadingOlder,
    olderError,
    olderRefreshError,
    loadOlder,
    reload: () => void first.mutate(),
    isReloading: first.isValidating,
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
