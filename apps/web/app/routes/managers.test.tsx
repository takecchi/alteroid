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

  /**
   * **`stopped` は `done`（待機中）に潰れない。**
   *
   * `done` は自分から手を離しただけで話しかければ続くが、`stopped` は外から
   * 止められ、runner のセッション一覧から実際に消えたことを確かめた終端である
   * （`schema.ts` の `jobStatusSchema` の doc）。同じ札を貼ると、止めたはずの
   * マネージャーが「待機中」に見えて、話しかけられる相手が残っているように
   * 読める。
   */
  it('stopped を done（待機中）と混ぜない', async () => {
    renderManagers([{ ...BASE, status: 'stopped', live: false }]);

    expect(await screen.findByText('停止済み')).toBeTruthy();
    expect(screen.queryByText('待機中')).toBeNull();
    expect(screen.queryByText('完了')).toBeNull();
  });
});

/**
 * **「クローンに見えて人間に見えない」を作らない。**
 *
 * PR #60 でクローンは `manager_list` から拒否件数を読めるようになったが、この画面は
 * 「実行中」としか言わないままだった。これまで潰してきたのは「人間にできてクローン
 * にできない」（`manager_stop` が無い等）だったが、同じ線を逆から踏んでいる
 * — 北極星 禁止1（デグレード禁止）である。
 *
 * 対になっているのは `packages/core/src/tools.test.ts`「拒否で手が止まっている
 * ことが、状態に添えて一覧に出る」。
 */
describe('拒否は、状態を置き換えずに状態へ添える', () => {
  it('「実行中」の札を残したまま、拒否件数を並べて出す', async () => {
    renderManagers([
      {
        ...BASE,
        status: 'running',
        denials: [
          { tool: 'Bash', count: 4 },
          { tool: 'Write', count: 1 },
        ],
      },
    ]);

    // **札は差し替えない。** 拒否があっても観測しているのは `running` である。
    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText(/Bash 4件/)).toBeTruthy();
    expect(screen.getByText(/Write 1件/)).toBeTruthy();
    // **なぜ気にする必要があるのか**まで書く（クローンにも回っていない）。
    expect(screen.getByText(/クローンには回ってきていない/)).toBeTruthy();
    // 観測していないことを断定しない。
    expect(screen.queryByText(/手が止まっている。/)).toBeNull();
  });

  it('拒否の種類が多くても畳んで、切ったことを言う', async () => {
    renderManagers([
      {
        ...BASE,
        denials: Array.from({ length: 7 }, (_, index) => ({
          tool: `tool-${index}`,
          count: index + 1,
        })),
      },
    ]);

    // デーモンは古い順で返す。新しい側（末尾）から3種。
    expect(await screen.findByText(/tool-6 7件/)).toBeTruthy();
    expect(screen.getByText(/tool-4 5件/)).toBeTruthy();
    expect(screen.queryByText(/tool-3/)).toBeNull();
    // 黙って落とさない。
    expect(screen.getByText(/ほか 4 種、全 28 件/)).toBeTruthy();
  });

  it('拒否が無いマネージャーには何も足さない（雑音にしない）', async () => {
    renderManagers([{ ...BASE, status: 'running' }]);

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/確認へ上がらず止められた/)).toBeNull();
  });

  /**
   * Issue #373 — PR #549 で `ManagerDenial.actor` が API まで届いたのに、この
   * 画面（`managers.tsx`）だけが `tool`/`count` の2値のまま描いていた。
   * `packages/core/src/tools.ts` / `apps/cli/src/chat.ts` の `denialActorTag`
   * と同じ書式で3値のまま出す——マネージャー自身の拒否と作業者の拒否を
   * 畳んで見せると、クローンが誤った相手へ指示を出しうる。
   */
  it('拒否の層（マネージャー／作業者／層不明）が3値のまま出る', async () => {
    renderManagers([
      {
        ...BASE,
        denials: [
          { tool: 'Bash', count: 2, actor: 'manager' },
          { tool: 'Edit', count: 1, actor: 'worker' },
          // `via: 'result'` は SDK 側に判定材料が無いので `actor` キーが無い。
          { tool: 'Write', count: 3 },
        ],
      },
    ]);

    expect(await screen.findByText(/Bash 2件 \[マネージャー\]/)).toBeTruthy();
    expect(screen.getByText(/Edit 1件 \[作業者\]/)).toBeTruthy();
    expect(screen.getByText(/Write 3件 \[層不明\]/)).toBeTruthy();
  });

  /**
   * **`actor` が無い回（層が取れなかった）を、`[マネージャー]` へ化けさせない。**
   * `undefined` を「マネージャーだった」と決めつけると、Issue #373 が守ろうと
   * している「層が取れていないことが分かる」が壊れる
   * （`apps/daemon/src/app.test.ts`「拒否の層（actor）が…」と対になる）。
   */
  it('actor が無い回は [層不明] になり、[マネージャー] へは化けない', async () => {
    renderManagers([
      {
        ...BASE,
        denials: [{ tool: 'Bash', count: 1 }],
      },
    ]);

    expect(await screen.findByText(/Bash 1件 \[層不明\]/)).toBeTruthy();
    expect(screen.queryByText(/\[マネージャー\]/)).toBeNull();
  });
});

/**
 * **直近の1ターンが「報告」ではなく失敗で終わったことも、状態に映らない。**
 *
 * 上限に当たった回もセッションは生きているので `status` は `done`（画面では
 * 「待機中」）のままである。だから札は札のまま残し、その隣に添える — 拒否
 * （`denials`）とまったく同じ形の問題である。
 *
 * 直す前は `You've hit your org's monthly spend limit …` が `lastReport` に入り、
 * この画面には「報告が来た」としか出ていなかった（`sdk-failure.ts` の doc）。
 */
describe('失敗も、状態を置き換えずに状態へ添える', () => {
  const FAILURE = { code: 'billing_error', via: 'assistant_error', at: '2026-08-20T10:00:00.000Z' };

  it('「待機中」の札を残したまま、SDK の語で失敗を言う', async () => {
    renderManagers([{ ...BASE, status: 'done', lastFailure: FAILURE }]);

    // **札は差し替えない。** 観測しているのは `done`（終えて待機中）である。
    expect(await screen.findByText('待機中')).toBeTruthy();
    expect(screen.queryByText('失敗')).toBeNull();
    // SDK の語をそのまま（`billing_error` と `rate_limit` は次の一手が違う）。
    expect(screen.getByText(/billing_error/)).toBeTruthy();
    expect(screen.getByText(/assistant_error/)).toBeTruthy();
    // `status` を倒さなかった理由そのもの。書かないと人間が仕事を閉じる。
    expect(screen.getByText(/話しかければ続く/)).toBeTruthy();
  });

  it('失敗していないマネージャーには何も足さない（雑音にしない）', async () => {
    renderManagers([{ ...BASE, status: 'running' }]);

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/報告ではなく失敗/)).toBeNull();
  });
});

/**
 * **`live` は status と別の軸である。** `live && <札>` の形は `live === false` を
 * 「札が無い」でしか表さず、読む側は「切断されている」と「この画面が接続状態を
 * 報告していない」を区別できない。だから両側を描く。
 *
 * クローンの道具（`packages/core/src/tools.ts`）と CLI（`apps/cli/src/chat.ts`）は
 * どちらも `[running/セッション切断]` と明示している — Web だけが肯定側しか
 * 描いていなかった（北極星 禁止1 を逆向きに踏む）。
 */
describe('`live` は、繋がっていないことも札で言う', () => {
  it('「走っている扱いだが繋がっていない」でも、実行中の札は残したまま切断を言う', async () => {
    renderManagers([{ ...BASE, status: 'running', live: false }]);

    // 状態は差し替えない。観測しているのは `running` のままである。
    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('セッション切断')).toBeTruthy();
    expect(screen.queryByText('接続あり')).toBeNull();
  });

  it('繋がっているときは切断の札を出さず、接続ありだけを出す', async () => {
    renderManagers([{ ...BASE, status: 'running', live: true }]);

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('接続あり')).toBeTruthy();
    expect(screen.queryByText('セッション切断')).toBeNull();
  });
});
