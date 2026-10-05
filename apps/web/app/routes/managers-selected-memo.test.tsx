// @vitest-environment jsdom
/**
 * issue #2055: 状態チップの選択（`selected`）が、チップと無関係な再描画でも
 * 参照だけ変わっていないかを測る（`journal-selected-memo.test.tsx` と同じ
 * 判断・同じ形。理由はそちらの冒頭 doc）。
 *
 * `managers.tsx` は `const rawStatus = searchParams.get(STATUS_SEARCH_PARAM);
 * const selected = useMemo(() => parseSelectedStatuses(rawStatus), [rawStatus]);`
 * の形で、URL の生の値が変わらない限り同じ配列の参照を返す。
 *
 * **`journal.tsx` と違い、この画面には「打っている途中」の state
 * （検索欄の `draft` に相当するもの）がいまは無い。** チップと無関係な
 * 再描画を起こす自然な操作がまだ無いので、ここでは `router.navigate` で
 * **いまと同じ URL への再訪問**（`replace: true`）を撃つ——history の
 * 一意な `key` が変わるので、`Managers` は再描画されるが、`STATUS_SEARCH_PARAM`
 * の生の値は変わらない。**将来この画面に検索欄のような state が増えたときの
 * 実際の再描画（issue #2055 が挙げる「検索欄に1文字打つ」と同じ形）を
 * 先取りして測っている、という位置づけである。**
 *
 * `@alteroid/swr` の `useManagersWindow` だけをスタブに差し替え、`ManagersBody` が
 * 呼ぶたびに渡ってくる `selected` の引数を捕まえて比べる（黒箱で測れない
 * 理由は `journal-selected-memo.test.tsx` と同じ）。
 */
import { act, render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagersWindow } from '@alteroid/swr';
import type { ManagerStatus } from '@alteroid/logic';
import { Providers, storeTestBaseUrl } from '~/test-support';

const { useManagersWindowMock, capturedSelected } = vi.hoisted(() => {
  return {
    useManagersWindowMock: vi.fn(),
    capturedSelected: [] as (readonly ManagerStatus[])[],
  };
});

vi.mock('@alteroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@alteroid/swr')>()),
  useManagersWindow: useManagersWindowMock,
}));

useManagersWindowMock.mockImplementation((status: readonly ManagerStatus[]) => {
  capturedSelected.push(status);
  const stub: ManagersWindow = {
    managers: [],
    isLoadingInitial: false,
    error: undefined,
    unreadable: [],
    olderStatus: 'end',
    isLoadingOlder: false,
    olderError: undefined,
    loadOlder: () => {},
    reload: () => {},
    isReloading: false,
  };
  return stub;
});

// `vi.mock` はホイストされるので、`Managers` の import は下でよい。
import Managers from './managers';

beforeEach(() => {
  localStorage.clear();
  storeTestBaseUrl();
  capturedSelected.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
  capturedSelected.length = 0;
});

function renderManagers(initialEntries: string[] = ['/']) {
  const router = createMemoryRouter([{ path: '/', Component: Managers }], {
    initialEntries,
  });
  const result = render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...result, router };
}

describe('チップを押さない再描画で selected の参照が変わらない（issue #2055）', () => {
  it('同じ URL への再訪問（チップは押していない）では、ManagersBody へ渡る selected の参照は変わらない', async () => {
    const { router } = renderManagers();

    expect(capturedSelected.length).toBeGreaterThanOrEqual(1);
    const before = capturedSelected.at(-1);

    // チップは1つも押していない。いまと同じ場所への再訪問だけを撃つ
    // （history の `key` は変わるので `Managers` は再描画される）。
    await act(async () => {
      await router.navigate(router.state.location.pathname + router.state.location.search, {
        replace: true,
      });
    });

    expect(capturedSelected.length).toBeGreaterThanOrEqual(2);
    const after = capturedSelected.at(-1);

    // **ここが本題。** 中身ではなく参照で比べる——`useMemo` を外すと、
    // 中身は同じ `[]` でも別の配列になり、ここが落ちる。
    expect(after).toBe(before);
  });
});
