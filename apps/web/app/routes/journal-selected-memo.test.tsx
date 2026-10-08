// @vitest-environment jsdom
// GET の回数・画面の文言で測らない: selected の参照が変わっても filterRecent の結果は変わらず GET も文言も変わらないため、測れるのは参照の同一性だけ
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JournalWindow } from '@alteroid/swr';
import type { JournalEntryType } from '@alteroid/logic';
import { Providers, storeTestBaseUrl } from '~/test-support';

const { useJournalWindowMock, capturedSelected } = vi.hoisted(() => {
  return {
    useJournalWindowMock: vi.fn(),
    capturedSelected: [] as (readonly JournalEntryType[])[],
  };
});

vi.mock('@alteroid/swr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@alteroid/swr')>()),
  useJournalWindow: useJournalWindowMock,
}));

useJournalWindowMock.mockImplementation((selected: readonly JournalEntryType[]) => {
  capturedSelected.push(selected);
  const stub: JournalWindow = {
    entries: [],
    isLoadingInitial: false,
    error: undefined,
    loadMoreError: undefined,
    retryLoadMore: () => {},
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

import Journal from './journal';

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

    expect(capturedSelected.length).toBeGreaterThanOrEqual(1);
    const before = capturedSelected.at(-1);

    fireEvent.change(screen.getByLabelText('日誌を語で探す'), {
      target: { value: 'ト' },
    });

    expect(capturedSelected.length).toBeGreaterThanOrEqual(2);
    const after = capturedSelected.at(-1);

    expect(after).toBe(before);
  });
});
