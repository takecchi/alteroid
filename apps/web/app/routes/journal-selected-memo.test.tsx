// @vitest-environment jsdom
/**
 * issue #2055: 種別チップの選択（`selected`）が、検索欄の打鍵のような
 * **チップと無関係な再描画**でも参照だけ変わっていないかを測る。
 *
 * `journal.tsx` は `const raw = searchParams.get(TYPES_SEARCH_PARAM);
 * const selected = useMemo(() => parseSelectedTypes(raw), [raw]);` の形で、
 * URL の生の値（`raw`）が変わらない限り同じ配列の参照を返す。**この
 * `useMemo` を外すと**、`Journal` が再描画されるたびに `parseSelectedTypes`
 * を呼び直すだけになり、`selected` は中身が同じでも**新しい配列**になる。
 *
 * **なぜ黒箱（GET の回数・画面の文言）で測らないか。** `use-journal-window.ts`
 * の `useEffect(..., [recent, selected, q])` は `selected` の参照が変わって
 * 再実行されても、`filterRecent` の結果（中身）は変わらないので
 * `applyNewerPage(...).freshCount === 0` で `setEntries` まで届かず、GET も
 * 画面の文言も変わらない（issue #2055 の「なぜ今は壊れて見えないか」）。
 * **効いているかどうかを実際に測れるのは参照の同一性そのものだけ**なので、
 * `~/hooks/use-journal-window` を丸ごとスタブに差し替え、`JournalBody` が
 * 呼ぶたびに渡ってくる `selected` の引数を捕まえて比べる。
 *
 * **`useMemo` を外す変異への赤黒**: repo のハーネス（`.claude/skills/
 * mutation-testing/mutate.mjs` の `apply`/`restore`）で `useMemo` を外す
 * 変異を当てて確かめた（実測は PR #2081 の本文に貼ってある）。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JournalWindow } from '~/hooks/use-journal-window';
import type { JournalEntryType } from '~/lib/types';
import { Providers, storeTestBaseUrl } from '~/test-support';

const { useJournalWindowMock, capturedSelected } = vi.hoisted(() => {
  return {
    useJournalWindowMock: vi.fn(),
    capturedSelected: [] as (readonly JournalEntryType[])[],
  };
});

/**
 * **`~/hooks/use-journal-window` を丸ごと置き換える。** 実装の中身
 * （SSE の重ね合わせ・ページ送り・GET）は `journal.tsx` の再描画とは
 * 無関係なので、ここでは呼ばれた引数だけを記録する最小のスタブにする
 * （`apps/web` の「自前のスタブを書かない」は jsdom に無い口の話——
 * これはモジュール境界のテストダブルで別の話）。
 */
vi.mock('~/hooks/use-journal-window', () => ({
  useJournalWindow: useJournalWindowMock,
}));

useJournalWindowMock.mockImplementation((selected: readonly JournalEntryType[]) => {
  capturedSelected.push(selected);
  const stub: JournalWindow = {
    entries: [],
    isLoadingInitial: false,
    error: undefined,
    olderStatus: 'end',
    isLoadingOlder: false,
    loadOlder: () => {},
    horizonNote: undefined,
    isLoadingNewer: false,
    newerBlocked: false,
    refreshNewer: () => {},
    prepended: false,
  };
  return stub;
});

// `vi.mock` はホイストされるので、`Journal` の import は下でよい
// （`journal.tsx` が import する `useJournalWindow` は、この時点でもう
// 上のスタブに差し替わっている）。
import Journal from './journal';

beforeEach(() => {
  localStorage.clear();
  storeTestBaseUrl();
  capturedSelected.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
  capturedSelected.length = 0;
});

function renderJournal(initialEntries: string[] = ['/']) {
  const router = createMemoryRouter([{ path: '/', Component: Journal }], {
    initialEntries,
  });
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('チップを押さない再描画で selected の参照が変わらない（issue #2055）', () => {
  it('検索欄に1文字打つだけでは、JournalBody へ渡る selected の参照は変わらない', () => {
    renderJournal();

    // 初回描画で少なくとも1回は呼ばれている。
    expect(capturedSelected.length).toBeGreaterThanOrEqual(1);
    const before = capturedSelected.at(-1);

    // チップは1つも押していない——検索欄の打鍵だけで `Journal` の `draft`
    // state が変わり、再描画が起きる（debounce の手前なので URL はまだ
    // 変わらない。`journal.tsx` の `SEARCH_DEBOUNCE_MS`）。
    fireEvent.change(screen.getByLabelText('日誌を語で探す'), {
      target: { value: 'ト' },
    });

    expect(capturedSelected.length).toBeGreaterThanOrEqual(2);
    const after = capturedSelected.at(-1);

    // **ここが本題。** 中身（`toEqual`）ではなく参照（`toBe`）で比べる——
    // `useMemo` を外すと、中身は同じ `[]` でも別の配列になり、ここが落ちる。
    expect(after).toBe(before);
  });
});
