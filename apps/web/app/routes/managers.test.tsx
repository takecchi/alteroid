// @vitest-environment jsdom
/**
 * マネージャー一覧の**札の文言**。
 *
 * ここで固定するのは見た目ではなく、**画面が観測していないことまで語らない**
 * ことである。同じ状態をクローンは `manager_list` で読み、人間はこの画面で読む
 * ので、片方だけ直すと人間とクローンで見えている経緯が食い違う
 * （`packages/core/src/tools.test.ts` の「一覧の文言は、観測した分しか言わない」
 * と対になっている）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ManagerSummary } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Managers from './managers';

const BASE: ManagerSummary = {
  managerId: 'mgr-1',
  status: 'running',
  live: true,
  cwd: '/work/project',
  request: 'PR を出して',
  startedAt: '2026-08-16T03:00:00.000Z',
  updatedAt: '2026-08-16T03:15:00.000Z',
  waiting: [],
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderManagers(managers: ManagerSummary[]) {
  stubFetch((url) => (url.includes('/managers') ? json({ managers }) : undefined));
  const router = createMemoryRouter([{ path: '/', Component: Managers }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('一覧の札は、観測した分しか言わない', () => {
  /**
   * **`done` は「マネージャー自身のターンが終わって待機中」でしかない。**
   *
   * 画面だけが「完了」と言っていた（`schema.ts` の定義も `manager_list` も
   * 「待機中」である）。話しかければ続くものを「完了」と読ませると、人間は
   * 終わっていない仕事をそこで閉じる。
   */
  it('done を「完了」と書かない（待機中である）', async () => {
    renderManagers([{ ...BASE, status: 'done' }]);

    expect(await screen.findByText('待機中')).toBeTruthy();
    expect(screen.queryByText('完了')).toBeNull();
  });

  /**
   * **`lost` は「前のセッションへ戻れなかった」という一つの観測でしかない。**
   *
   * 2026-08-16T03:15 に、落ちる直前に PR を出して CI を通しマージまで届いて
   * いた仕事がこの札を貼られた。デーモンは PR もブランチも見ていないのだから、
   * 「復旧不能」は観測ではなく推測である。
   */
  it('lost を「復旧不能」と書かず、確かめる先を渡す', async () => {
    renderManagers([{ ...BASE, status: 'lost', live: false }]);

    expect(await screen.findByText('セッションへ戻れず')).toBeTruthy();
    expect(screen.queryByText('復旧不能')).toBeNull();
    // 札だけでは次の一手が分からない。クローンが `manager_list` で受け取るのと
    // 同じ案内を、人間の画面にも出す。
    expect(screen.getByText(/リモート（PR・ブランチ）を確かめる/)).toBeTruthy();
  });

  it('lost 以外にリモート確認の案内を出さない（雑音にしない）', async () => {
    renderManagers([{ ...BASE, status: 'running' }]);

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/リモート（PR・ブランチ）/)).toBeNull();
  });
});
