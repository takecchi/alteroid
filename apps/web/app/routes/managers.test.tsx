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

/**
 * **5つ目の形**——「runner に生きたセッションはもう無いが、まだ話しかけられる」
 * （`ManagerSummary.sessionMissingSince`）。
 *
 * 直す前、`/usr/bin/grep -rn 'sessionMissingSince' apps/web/` は **0件**だった。
 * デーモンは `GET /managers` でこの欄を返していて、クローンは `manager_list`
 * （`packages/core/src/tools.ts`）で、人間は CLI の `/manager`
 * （`apps/cli/src/chat.ts`）で読めていた —— **Web UI だけが値を受け取ったまま
 * 描いていなかった。** 同じ仕事を見て人間とクローンが違う判断をする形である
 * （北極星 禁止1 を逆向きに踏む）。
 *
 * ここで固定するのは3つ。
 *
 * 1. **`live: true`（＝「接続あり」の緑）と同時に出る。** `sessionId` が残って
 *    いれば resume から入り直せるので `live` は落ちない —— 片方が他方を消す形に
 *    したら、それがこの欄の主眼を壊している（`live && <札>` を禁じたのと同じ形）
 * 2. **欄が無いときは何も描かない**（`ManagerFailureNote` と同じ。雑音にしない）
 * 3. **「失われた」と言い切っていない。** 由来が2つあり（途中で失われた／完遂した
 *    後にセッションが畳まれて終端の合図だけが届かなかった）、デーモンは台帳から
 *    区別できない（`packages/core/src/manager.ts` の `sendFailureDetail` の doc）。
 *    決めつけると**完遂済みの仕事を委譲し直す**
 */
describe('セッションが無いことは、`live` も状態も置き換えずに添える', () => {
  const MISSING = '2026-08-16T03:10:00.000Z';

  it('「実行中」も「接続あり」も残したまま、セッションが無いことを言う', async () => {
    renderManagers([{ ...BASE, status: 'running', live: true, sessionMissingSince: MISSING }]);

    // 札は差し替えない。観測しているのは `running` のままである。
    expect(await screen.findByText('実行中')).toBeTruthy();
    // **ここが本体。** 注記が出たことで「接続あり」が消えていない。
    expect(screen.getByText('接続あり')).toBeTruthy();
    expect(screen.queryByText('セッション切断')).toBeNull();
    // runner は答えている（聞けなかったのではない）。
    expect(screen.getByText(/runner がそう答えた。聞けなかったのではない/)).toBeTruthy();
  });

  /**
   * **文言の核が消えたら赤くなる歯。** ここが落ちたら、画面が観測していないこと
   * （この委譲が失われた）を断定し始めている。
   */
  it('「失われた」と言い切らず、完遂後に畳まれた回も同じ形に見えることを言う', async () => {
    renderManagers([{ ...BASE, status: 'running', live: true, sessionMissingSince: MISSING }]);

    expect(await screen.findByText(/この委譲が失われたという意味ではない/)).toBeTruthy();
    expect(
      screen.getByText(
        /完遂した後にセッションが畳まれ、終端の合図だけが届かなかった回も同じ形に見える/,
      ),
    ).toBeTruthy();
    // 先に起こし直すと同じ仕事が2本になる（人間が実際に踏める地雷）。
    expect(screen.getByText(/同じ仕事が2本になる/)).toBeTruthy();
  });

  it('欄が無いマネージャーには何も足さない（雑音にしない）', async () => {
    renderManagers([{ ...BASE, status: 'running', live: true }]);

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/この委譲のセッションを持っていなかった/)).toBeNull();
  });

  /**
   * **時刻はこの画面の作法（`~/lib/format` の `formatRelative`）で出す。**
   * CLI と `manager_list` は ISO をそのまま出しており、**書式が違うのは意図で
   * ある。** ISO が素で出ていたら、この画面だけ作法が割れている。
   */
  it('時刻は相対表示で、ISO をそのまま出さない', async () => {
    renderManagers([{ ...BASE, status: 'running', live: true, sessionMissingSince: MISSING }]);

    expect(await screen.findByText(/この委譲のセッションを持っていなかった/)).toBeTruthy();
    expect(screen.queryByText(new RegExp(MISSING))).toBeNull();
  });
});

/**
 * **宛先の器そのものが名乗らなくなった**こと（`ManagerSummary.runnerLostSince`）。
 *
 * これも直す前は `/usr/bin/grep -rn 'runnerLostSince' apps/web/` が **0件**だった。
 * CLI（`chat.ts`）と `manager_list`（`tools.ts`）は両方描いていて、Web UI だけが
 * 両方とも描いていなかった —— 札が「セッション切断」としか言わないと、セッションが
 * 終わったのか宛先の器が消えたのかが読めず、打つ手（起こし直すのか、器の側を見るのか）
 * が決まらない。
 *
 * **`status: lost` の言葉には寄せない。** `lost` は resume を試して戻れなかったと
 * いう**確かめた事実**に付く名前だが、ここはまだ何も確かめていない —— 黙っているのが
 * 器なのか経路なのかは片側からは決められず、**器の中でまだ走っている可能性が残る**
 * （`packages/core/src/manager.ts` の `runnerLostSince` の doc）。
 */
describe('器が黙ったことは、`status` を動かさずに添える', () => {
  const LOST_SINCE = '2026-08-16T03:05:00.000Z';

  it('「実行中」の札を残したまま、器が名乗っていないことを言う', async () => {
    renderManagers([{ ...BASE, status: 'running', live: false, runnerLostSince: LOST_SINCE }]);

    // `status` は動かない。`live` だけが倒れる。
    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('セッション切断')).toBeTruthy();
    expect(screen.getByText(/宛先の器は.*から名乗っていない/)).toBeTruthy();
    expect(screen.getByText(/新しい委譲の宛先からは外れている/)).toBeTruthy();
  });

  /**
   * **`ba4053d`（#67「「いま送っても届かず」の真下に、届く送信ボタンが並んでいた」）の
   * 再発を止める歯。**
   *
   * CLI（`chat.ts`）と `manager_list`（`tools.ts`）はこの節を「いま話しかけられない」と
   * 書いているが、**Web へ逐語で持ってくると嘘になる。** 実測（`packages/core` の足場で
   * 走らせた書き捨ての試験）: 名簿が `state: 'lost'` と判定した runner でも
   * `RunnerRegistry#get()` は client を返し（`#markSilent` は `entry.client` を落とさず、
   * `get()` は `entry.state` を見ない）、`ManagerPool#send()` は `#runnerOf` → `get()` を
   * 通って **`outcome: 'delivered'`** を返した（runner の `resume` が実際に叩かれた）。
   *
   * ⟹ デーモンは拒まない。**送信可否をこの注記が推論してはいけない。**
   */
  it('送信可否を推論しない（「いま話しかけられない」と書かない）', async () => {
    renderManagers([{ ...BASE, status: 'running', live: false, runnerLostSince: LOST_SINCE }]);

    expect(await screen.findByText(/宛先の器は.*から名乗っていない/)).toBeTruthy();
    // #67 が閉じた欠陥。ここが落ちたら、届く送信の上に「届かない」が戻っている。
    expect(screen.queryByText(/いま話しかけられない/)).toBeNull();
    expect(screen.queryByText(/届かない/)).toBeNull();
    expect(screen.queryByText(/届かず/)).toBeNull();
    // 塞いでいないことと、成否を断定しないことの両方を言う。
    expect(screen.getByText(/話しかけることは塞いでいない/)).toBeTruthy();
    expect(screen.getByText(/送ると resume\s*を試みる/)).toBeTruthy();
  });

  /**
   * **`sessionMissingSince` とは「失われたと書かない理由」が違う。** あちらは
   * 「完遂した後に畳まれた回と区別できない」、こちらは「器の中でまだ走っている
   * 可能性が残る」。核を取り違えたら赤くなる。
   */
  it('「失われた」と言い切らず、器の中でまだ走っている可能性を潰さない', async () => {
    renderManagers([{ ...BASE, status: 'running', live: false, runnerLostSince: LOST_SINCE }]);

    expect(await screen.findByText(/この委譲が失われたという意味ではない/)).toBeTruthy();
    expect(screen.getByText(/黙っているのが器なのか経路なのかは、ここからは言えない/)).toBeTruthy();
    // `status: lost` の札の言葉へ寄せていない。
    expect(screen.queryByText('セッションへ戻れず')).toBeNull();
  });

  it('欄が無いマネージャーには何も足さない（雑音にしない）', async () => {
    renderManagers([{ ...BASE, status: 'running', live: false }]);

    expect(await screen.findByText('セッション切断')).toBeTruthy();
    expect(screen.queryByText(/名乗っていない/)).toBeNull();
  });

  /**
   * **2つは排他ではない。同時に立つ。**
   *
   * `packages/core/src/manager.ts`（`ff24ded9`）を引いて確かめた: `summaryOf()` は
   * 2つを独立した spread で組み立てており、排他を課している行は1行も無い。
   * `record.sessionMissingSince` を消すのは「resume で戻れた」＝ runner が実際に
   * 答えた回の2箇所だけなので、**runner が黙っても消えない。** ⟹ 到達順序は
   * 「runner がこの委譲について答えない → `sessionMissingSince` が立つ（`live` は
   * true のまま）→ その後 同じ runner が名乗らなくなる → `runnerLostSince` が立ち、
   * 同時に `isLive()` が `live: false` を返す」。
   *
   * **この組を測っている歯は repo のどこにも無かった。** CLI も `manager_list` も
   * `else` 無しで2つ積んでいる（＝2行並ぶ）ので、Web も並ぶのが「合わせる」である。
   * 片方を `else` にする変異は、この歯でしか死なない。
   */
  it('2つの欄が同時に立ったら、注記は2本とも出る（片方が他方を消さない）', async () => {
    renderManagers([
      {
        ...BASE,
        status: 'running',
        live: false,
        runnerLostSince: LOST_SINCE,
        sessionMissingSince: '2026-08-16T03:10:00.000Z',
      },
    ]);

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('セッション切断')).toBeTruthy();
    expect(screen.getByText(/宛先の器は.*から名乗っていない/)).toBeTruthy();
    expect(screen.getByText(/この委譲のセッションを持っていなかった/)).toBeTruthy();
  });
});
