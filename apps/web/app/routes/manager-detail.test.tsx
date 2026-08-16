// @vitest-environment jsdom
/**
 * マネージャー詳細が、**確認へ上がらず止められた件数**を出すこと。
 *
 * 一覧（`managers.test.tsx`）と対になっている。あちらは新しい側から3種で畳むが、
 * ここは畳まない — 詳細まで降りてきた人間が見に来たのは「何で止まっているのか」
 * そのものだからである。
 *
 * クローンは同じ状態を `manager_list` で読み、そこには件数が出ている（PR #60）。
 * この画面が「実行中」としか言わないと、同じ仕事を見て人間とクローンで見えている
 * ものが食い違う（北極星 禁止1 を逆向きに踏む）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ManagerSummary } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/manager-detail';
import ManagerDetail, { clientLoader } from './manager-detail';

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

/**
 * ルートモジュールの props（`loaderData`）が渡るのは framework mode だけで、
 * `createMemoryRouter`（library mode）では渡らない。
 *
 * **形を手で書き写さない。** 本物の `clientLoader` を通した戻り値をそのまま
 * 渡す — 手書きの `{ id }` を置くと、`clientLoader` が返すものが変わった日に
 * この試験だけが古い形のまま通り続ける。
 */
function Harness({ id }: { id: string }) {
  const loaderData = clientLoader({ params: { id } } as Route.ClientLoaderArgs);
  return <ManagerDetail {...({ loaderData } as Route.ComponentProps)} />;
}

function renderDetail(manager: ManagerSummary) {
  stubFetch((url) =>
    url.includes(`/managers/${manager.managerId}`) ? json({ manager }) : undefined,
  );
  const router = createMemoryRouter(
    [
      { path: '/managers/:id', Component: () => <Harness id={manager.managerId} /> },
      // `Link to="/journal"` の行き先（描くだけで踏まない）。
      { path: '/journal', Component: () => null },
    ],
    { initialEntries: [`/managers/${manager.managerId}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('詳細でも、拒否は状態を置き換えずに状態へ添える', () => {
  it('「実行中」の札を残したまま、止められた道具を全件出す', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      denials: [
        { tool: 'Bash', count: 4 },
        { tool: 'Write', count: 1 },
        { tool: 'WebFetch', count: 2 },
      ],
    });

    // **札は差し替えない。** 観測しているのは `running` のままである。
    expect(await screen.findByText('実行中')).toBeTruthy();
    // 一覧の 3 種の上限に引っ張られない（詳細は畳まない）。
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('Write')).toBeTruthy();
    expect(screen.getByText('WebFetch')).toBeTruthy();
    // 状態の隣に総数を並べる。
    expect(screen.getByText(/確認へ上がらず止められた 7 件/)).toBeTruthy();
    // 観測していないことを断定しない。
    expect(screen.getByText(/この仕事が止まったかどうかは見ていない/)).toBeTruthy();
    // 「0 件」を「止められていない」と読ませない材料を渡す。
    expect(screen.getByText(/器を作り直すと数え直しになる/)).toBeTruthy();
  });

  it('拒否が無いマネージャーには何も足さない（雑音にしない）', async () => {
    renderDetail({ ...BASE, status: 'running' });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/確認へ上がらず止められた/)).toBeNull();
  });
});
