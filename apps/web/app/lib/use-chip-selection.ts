import { useMemo } from 'react';

import { useReplaceSearchParams } from './use-replace-search-params';

// 札（チップ）の複数選択を URL の `?<param>=a,b` と同期する（正本は URL）。
// 絞りを画面の state に閉じ込めない: 開き直すと消え、戻るで戻れず、リンクで共有できないため
// replace: true にする: チップの操作ごとに履歴が積まれると「戻る」が使えなくなるため
// debounce しない: チップのクリックは1回で完結した操作で、検索語のような「入力の途中」が無いため

// 知らない値を残さない: 対応するチップが無く、選択されているのにどのチップも押されて見えない状態になるため
function parseChipSelection<T extends string>(
  raw: string | null,
  known: readonly T[],
): readonly T[] {
  if (raw === null || raw === '') return [];
  const result: T[] = [];
  for (const part of raw.split(',')) {
    if (part === '') continue;
    if (!(known as readonly string[]).includes(part)) continue;
    const value = part as T;
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

export function useChipSelection<T extends string>(
  param: string,
  known: readonly T[],
): { selected: readonly T[]; toggle: (value: T) => void; clear: () => void } {
  const [searchParams, replaceParams] = useReplaceSearchParams();
  // useMemo で包み、生の文字列が変わらない限り同じ参照を返す: 描画のたびに selected が新しい配列になり、それに依存する effect・memo が毎回走り直すため
  const raw = searchParams.get(param);
  const selected = useMemo(() => parseChipSelection(raw, known), [raw, known]);

  function toggle(value: T) {
    replaceParams((next) => {
      const current = parseChipSelection(next.get(param), known);
      const updated = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      if (updated.length === 0) next.delete(param);
      else next.set(param, updated.join(','));
    });
  }

  function clear() {
    replaceParams((next) => {
      next.delete(param);
    });
  }

  return { selected, toggle, clear };
}
