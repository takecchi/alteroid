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
 */
import { useCallback, useState } from 'react';

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

export function useManagersWindow(status: readonly ManagerStatus[]): ManagersWindow {
  const api = useApi();
  const first = useManagers({ status, limit: MANAGERS_PAGE });

  const [older, setOlder] = useState<ManagerSummary[]>([]);
  const [isLoadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(undefined);
  /**
   * 最後に読んだ「もっと見る」の頁の件数。`undefined` は「まだ1回も押して
   * いない」＝判定は先頭の頁の件数で行う、である。**0 と `undefined` を
   * 混ぜない**（0 は「押したが1件も無かった」＝終端）。
   */
  const [lastOlderCount, setLastOlderCount] = useState<number | undefined>(undefined);

  const page = first.data?.managers ?? [];

  /**
   * 先頭の頁と読み足した分を繋ぐ。**`managerId` で重複を落とす。**
   *
   * 先頭の頁は SWR が取り直す（`use-journal-live.ts` が `managers` の束を
   * 落とす）ので、取り直しで伸びた分が読み足した分と重なりうる。**重なった
   * ときに残すのは先頭の頁の側である**——そちらが新しい観測だからで、
   * 古い像で上書きすると札や注記が巻き戻る。
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
    const query = managersToQuery({
      status,
      limit: MANAGERS_PAGE,
      after: { managerId: anchorId, startedAt: anchorStartedAt },
    });
    api.api
      .GET('/managers', { params: { query } })
      .then(unwrap)
      .then((body) => {
        setOlder((previous) => [...previous, ...body.managers]);
        setLastOlderCount(body.managers.length);
      })
      .catch((error: unknown) => {
        setOlderError(error);
      })
      .finally(() => {
        setLoadingOlder(false);
      });
  }, [api, anchorId, anchorStartedAt, status]);

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
