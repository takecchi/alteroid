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

/**
 * **一覧で `lost` を見た人間が、次に開くのがこの画面である。**
 *
 * 起こし直すかどうかを決めるのはここなのに、詳細だけが札しか出していなかった
 * （一覧 `managers.test.tsx`・CLI `chat.test.ts`・クローンの `tools.test.ts` には
 * 但し書きの網が張ってある）。
 *
 * 削ってはいけないのは2つ — **観測しているのは「戻れたか」だけだという限界**と、
 * **成果がリモートに残っていることがあるという次の一手**である（PR #42 で `lost` を
 * 分け、PR #60 で断定を外した経緯そのもの）。
 */
describe('詳細でも、lost には次の一手を添える', () => {
  it('「復旧不能」と書かず、観測の限界と確かめる先を出す', async () => {
    renderDetail({ ...BASE, status: 'lost', live: false });

    expect(await screen.findByText('セッションへ戻れず')).toBeTruthy();
    // 成果の有無は見ていないのだから、失われたと断定しない。
    expect(screen.queryByText('復旧不能')).toBeNull();
    // 観測の限界（これが無いと「終わった」とも「失われた」とも読まれる）。
    expect(screen.getByText(/戻れたかどうかしか見ていない/)).toBeTruthy();
    // 次の一手。起こし直す前に見に行く先を名指しする。
    expect(screen.getByText(/リモート（PR・ブランチ・コミット）を確かめる/)).toBeTruthy();
  });

  it('lost 以外にはリモート確認の案内を出さない（雑音にしない）', async () => {
    renderDetail({ ...BASE, status: 'running' });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/戻れたかどうかしか見ていない/)).toBeNull();
    expect(screen.queryByText(/リモート（PR・ブランチ・コミット）/)).toBeNull();
  });
});

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

/**
 * **`live` は status と別の軸である。** `live && <札>` の形は `live === false` を
 * 「札が無い」でしか表さず、読む側は「切断されている」と「この画面が接続状態を
 * 報告していない」を区別できない。だから両側を描く。
 *
 * クローンの道具（`packages/core/src/tools.ts`）と CLI（`apps/cli/src/chat.ts`）は
 * どちらも `[running/セッション切断]` と明示している — Web だけが肯定側しか
 * 描いていなかった（北極星 禁止1 を逆向きに踏む）。詳細はさらに、札だけでは
 * 「で、どうなるのか」が伝わらないので、送っても届かないことと繋ぎ直しが効けば
 * 戻ることまで文で言う。
 */
describe('詳細でも、`live` は繋がっていないことを文で言う', () => {
  it('「走っている扱いだが繋がっていない」でも、実行中の札を残したまま切断と注記を出す', async () => {
    renderDetail({ ...BASE, status: 'running', live: false });

    // 状態は差し替えない。観測しているのは `running` のままである。
    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('セッション切断')).toBeTruthy();
    // 札だけでは「で、どうなるのか」が伝わらない。
    expect(screen.getByText(/いま送っても届かず/)).toBeTruthy();
  });

  it('繋がっているときは切断の札も注記も出さず、接続ありだけを出す', async () => {
    renderDetail({ ...BASE, status: 'running', live: true });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('接続あり')).toBeTruthy();
    expect(screen.queryByText('セッション切断')).toBeNull();
    expect(screen.queryByText(/いま送っても届かず/)).toBeNull();
  });
});
