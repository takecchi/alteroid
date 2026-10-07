// `status` が変わったときの state のリセットを effect に持たない: 呼び出し側が `key` を変えて作り直す（`react-hooks/set-state-in-effect` に当たるため）
import { useCallback, useEffect, useRef, useState } from 'react';

import { managersToQuery, useManagers } from './queries';
import { unwrap, useApi } from '../api';
import type { ManagerStatus, ManagerSummary, UnreadableJob } from '@alteroid/logic';

// 続きが在るかは「この件数ちょうど返ったか」でしか判らない（`GET /managers` は封筒を持たない）: 読む件数と判定は同じ値を見る
export const MANAGERS_PAGE = 50;

// `end` と `blocked` を1つに畳まない: 畳むと、進めなくなった状態が「全部読み終えた」と同じ顔で出る
export type ManagersOlderStatus = 'progress' | 'end' | 'blocked';

export interface ManagersWindow {
  managers: ManagerSummary[];
  isLoadingInitial: boolean;
  error: unknown;
  unreadable: UnreadableJob[];

  olderStatus: ManagersOlderStatus;
  isLoadingOlder: boolean;
  olderError: unknown;
  olderRefreshError: unknown;
  loadOlder: () => void;
  reload: () => void;
  isReloading: boolean;
}

interface OlderPage {
  after: { managerId: string; startedAt: string };
  managers: ManagerSummary[];
}

function anchorKey(after: OlderPage['after']): string {
  return `${after.managerId}\u0000${after.startedAt}`;
}

export function useManagersWindow(status: readonly ManagerStatus[]): ManagersWindow {
  const api = useApi();
  const first = useManagers({ status, limit: MANAGERS_PAGE });

  const [olderPages, setOlderPages] = useState<OlderPage[]>([]);
  const [isLoadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(undefined);
  const [olderRefreshError, setOlderRefreshError] = useState<unknown>(undefined);
  // 0 と `undefined` を混ぜない: 0 は「押したが1件も無かった」＝終端で、`undefined` は「まだ押していない」
  const [lastOlderCount, setLastOlderCount] = useState<number | undefined>(undefined);

  const page = first.data?.managers ?? [];
  const older = olderPages.flatMap((p) => p.managers);

  // 重なったら先頭の頁の側を残す: 新しい観測で、古い像で上書きすると札や注記が巻き戻るため
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
    // 押し直しは前の失敗を消す: 消さないと `blocked` のまま固まり、押しても状態が変わらない
    setOlderError(undefined);
    // クエリは `managersToQuery` を通す: 手で組むと、`status` の空配列を送らない規則が先頭の頁と読み足す頁で割れるため
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

  // 読み足した頁は `useSWRInfinite` に移さず、頁1の再検証に便乗して取り直す: 述語版 `mutate((key) => …)` は
  // `$inf$` の集約キーを除外するので、`managers` の束を落とす無効化から漏れる。便乗すれば頁1の SWR の間引きにも乗れる
  const olderPagesRef = useRef(olderPages);
  useEffect(() => {
    olderPagesRef.current = olderPages;
  }, [olderPages]);

  // `isLoadingOlder` state ではなく ref で読む: `refreshOlderPages` が古いレンダーの `runOlderRefresh` を握ったまま呼びうるため
  const isLoadingOlderRef = useRef(isLoadingOlder);
  useEffect(() => {
    isLoadingOlderRef.current = isLoadingOlder;
  }, [isLoadingOlder]);

  // 走っている間は重ねて撃たず、来た分は印（`olderRefreshDirtyRef`）に残して終わってから1回だけ撃ち直す:
  // 並行に撃つと応答の順序が入れ替わり、新しい値を古い値で上書きするため。印を残さないと、次の SSE が来るまで古い値のままになる
  const isRefreshingOlderRef = useRef(false);
  const olderRefreshDirtyRef = useRef(false);

  // `useCallback` にしない: 再帰があり、自己参照を避けるため
  function runOlderRefresh(): void {
    const pages = olderPagesRef.current;
    const lastPageAtStart = pages.at(-1);
    if (lastPageAtStart === undefined) {
      isRefreshingOlderRef.current = false;
      return;
    }
    // 錨は取り直さず、各頁が最初に読んだときのものを使う: 頁1の末尾から組み直すと、並びが動いたとき抜け・重複の形が変わりうるため
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
        // 失敗した頁は前回の値のまま残す: 画面を空にしないため
        const refreshed = new Map<string, ManagerSummary[]>();
        for (const result of results) {
          if (result.status === 'fulfilled') {
            refreshed.set(anchorKey(result.value.after), result.value.managers);
          }
        }
        // 失敗は `olderRefreshError` で伝える: 先頭の頁が新しいと、止まった行まで今の値に見えるため
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

        // 最後の頁を取り直せたら `lastOlderCount` も更新する: `loadOlder()` だけが書くと、最後の頁が `MANAGERS_PAGE` 件に増えても「もっと見る」が消えたままになる。
        // `loadOlder()` の実行中や、取り直しの間に頁が足された回は更新しない: 古い最後の頁の結果で判定を上書きしないため
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, status]);

  // `first.data` の参照ではなく `isValidating` を見る: SWR の既定 `compare` は `dequal` で、頁1が無傷だと取り直しが走っても参照が変わらないため
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
