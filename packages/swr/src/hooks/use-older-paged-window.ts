import { useCallback, useEffect, useRef, useState } from 'react';

export interface OlderPagedWindowState<T> {
  items: T[];
  hasMore: boolean;
  isLoadingOlder: boolean;
  olderError: unknown;
  loadOlder: () => void;
}

export interface OlderPagedWindowInput<T> {
  /** 先頭の頁（SWR が取り直す）。並べ直さない: 並びはデーモンが決める */
  readonly page: readonly T[];
  readonly limit: number;
  /** 重複を除く鍵。描画のたびに作らない（モジュールに置く）: `loadOlder` の依存に入るため */
  readonly keyOf: (item: T) => string;
  /** 新しいほど大きい文字列。隙間の判定に使う。描画のたびに作らない */
  readonly orderOf: (item: T) => string;
  /** `anchor` より古い頁を取る。読めない形なら投げる。`useCallback` で包む: `loadOlder` の依存に入るため */
  readonly fetchOlder: (anchor: T) => Promise<T[]>;
}

// `useSWRInfinite` を使わない: `mutate((key) => …)` の述語版が `$inf$` の集約キーを除外し、束で落とす無効化から漏れるため。
// 隙間（読み足し後に先頭の頁が取り直されてずれ、境目の行がどちらにも入らない）は、
// 読み足した分を捨てて読み直さず先頭の頁の最後の行を起点に埋める: 読み直すと、いくつも読み足した後の一覧が縮むため
export function useOlderPagedWindow<T>({
  page,
  limit,
  keyOf,
  orderOf,
  fetchOlder,
}: OlderPagedWindowInput<T>): OlderPagedWindowState<T> {
  const [older, setOlder] = useState<T[]>([]);
  const [lastOlderCount, setLastOlderCount] = useState<number | undefined>(undefined);
  const [isLoadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(undefined);
  const [joint, setJoint] = useState<T | undefined>(undefined);
  const inFlight = useRef(false);

  const seen = new Set<string>();
  const items = [...page, ...older].filter((entry) => {
    const key = keyOf(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const hasMore = (lastOlderCount ?? page.length) === limit;
  const pageEnd = page.at(-1);
  const gap = joint !== undefined && pageEnd !== undefined && orderOf(pageEnd) > orderOf(joint);
  const anchor = gap ? pageEnd : items.at(-1);

  const loadOlder = useCallback(() => {
    if (anchor === undefined || inFlight.current) return;
    inFlight.current = true;
    setLoadingOlder(true);
    setOlderError(undefined);
    fetchOlder(anchor)
      .then((rows) => {
        const head = older[0];
        const filled = gap && head !== undefined && rows.some((row) => keyOf(row) === keyOf(head));
        setOlder((previous) =>
          gap ? (filled ? [...rows, ...previous] : rows) : [...previous, ...rows],
        );
        if (!filled) setLastOlderCount(rows.length);
        setJoint((previous) => (gap ? undefined : previous) ?? pageEnd);
      })
      .catch((error: unknown) => {
        setOlderError(error);
      })
      .finally(() => {
        inFlight.current = false;
        setLoadingOlder(false);
      });
  }, [anchor, fetchOlder, gap, keyOf, older, pageEnd]);

  // 失敗したら自動では撃ち直さない: 押し直しで続きより先に隙間を埋め直す
  useEffect(() => {
    if (gap && olderError === undefined) loadOlder();
  }, [gap, olderError, loadOlder]);

  return { items, hasMore, isLoadingOlder, olderError, loadOlder };
}
