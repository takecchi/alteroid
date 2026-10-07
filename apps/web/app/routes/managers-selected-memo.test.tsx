// @vitest-environment jsdom
// いまと同じ URL への再訪問（replace: true）を撃つ: この画面にはチップと無関係な再描画を起こす自然な操作がまだ無く、history の key が変わって再描画されるが生の値は変わらないため
import { act, cleanup, render } from '@testing-library/react';
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
    olderRefreshError: undefined,
    loadOlder: () => {},
    reload: () => {},
    isReloading: false,
  };
  return stub;
});

import Managers from './managers';

beforeEach(() => {
  localStorage.clear();
  storeTestBaseUrl();
  capturedSelected.length = 0;
});

afterEach(() => {
  // 自動 cleanup に任せず片付ける: globals 無しでは効かず、片付けないとテスト後も SWR が購読・再検証を続け、jsdom が畳まれた後に document を読んで未処理の拒否になるため
  cleanup();
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

    await act(async () => {
      await router.navigate(router.state.location.pathname + router.state.location.search, {
        replace: true,
      });
    });

    expect(capturedSelected.length).toBeGreaterThanOrEqual(2);
    const after = capturedSelected.at(-1);

    expect(after).toBe(before);
  });
});
