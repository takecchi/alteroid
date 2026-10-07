// @vitest-environment jsdom
import {
  describeDenialFollowUp as coreDescribeDenialFollowUp,
  describeSessionMissingKind,
} from '@alteroid/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MANAGERS_PAGE } from '@alteroid/swr';
import type { ManagerSummary } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Managers, {
  ManagerRunnerVanishedNote,
  describeDenialFollowUp,
  describeSessionMissingKindNote,
} from './managers';

// 画面全体で見ない: 札と同じ言葉がチップのボタンとしても画面に現れ、「この札は出ていない」を画面全体で見るとチップに当たってしまうため
function row() {
  return within(screen.getByRole('list'));
}

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

function renderManagers(
  managers: ManagerSummary[],
  unreadable?: { id?: string; reason: string }[],
) {
  stubFetch((url) =>
    url.includes('/managers')
      ? json({ managers, ...(unreadable === undefined ? {} : { unreadable }) })
      : undefined,
  );
  const router = createMemoryRouter([{ path: '/', Component: Managers }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('読めない委譲（#2345）', () => {
  it('読めた行が0件でも「まだマネージャーはいません」と言わず、件数と id を断る', async () => {
    renderManagers([], [{ id: 'mgr-bad', reason: '不正な欄: status' }]);

    const note = await screen.findByText(/読めない委譲が 1 件ある/);
    expect(note.textContent).toContain('id: mgr-bad');
    expect(note.textContent).toContain('居ないのでも、畳まれたのでもない');
    expect(screen.queryByText(/まだマネージャーはいません/)).toBeNull();
    expect(screen.getByText(/読めたマネージャーは無い/)).toBeTruthy();
  });

  it('読めた行が在るときは、一覧の上に断りを出し、読めた行もそのまま出る', async () => {
    renderManagers([{ ...BASE }], [{ reason: '不正な行' }]);

    const note = await screen.findByText(/読めない委譲が 1 件ある/);
    expect(note.textContent).not.toContain('id:');
    expect(screen.getByText('PR を出して')).toBeTruthy();
  });

  it('対照: 鍵が無ければ（0件）、断りは出ず、従来の空の文言のまま', async () => {
    renderManagers([]);

    expect(await screen.findByText(/まだマネージャーはいません/)).toBeTruthy();
    expect(screen.queryByText(/読めない委譲/)).toBeNull();
  });
});

describe('全体が0件のときの空表示（#2789）', () => {
  it('内部の語（発意 tick）を言わず、会話へのリンクを出し、絞り込みのチップは出さない', async () => {
    renderManagers([]);

    expect(await screen.findByText(/まだマネージャーはいません/)).toBeTruthy();
    expect(screen.queryByText(/tick/)).toBeNull();
    const link = screen.getByRole('link', { name: '会話' });
    expect(link.getAttribute('href')).toBe('/chat');
    expect(screen.queryByRole('button', { name: '実行中' })).toBeNull();
  });

  it('対照: 1体でも居れば、チップは出る', async () => {
    renderManagers([{ ...BASE }]);

    expect(await screen.findByText('PR を出して')).toBeTruthy();
    expect(screen.getByRole('button', { name: '実行中' })).toBeTruthy();
  });

  it('読めない行が在るときは「居ない」と言えないので、チップを隠さない', async () => {
    renderManagers([], [{ reason: '不正な行' }]);

    expect(await screen.findByText(/読めない委譲が 1 件ある/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '実行中' })).toBeTruthy();
  });
});

describe('一覧の札は、観測した分しか言わない', () => {
  it('done を「完了」と書かない（待機中である）', async () => {
    renderManagers([{ ...BASE, status: 'done' }]);

    expect(await screen.findByText('待機中')).toBeTruthy();
    expect(screen.queryByText('完了')).toBeNull();
  });

  it('lost を「復旧不能」と書かず、確かめる先を渡す', async () => {
    renderManagers([{ ...BASE, status: 'lost', live: false }]);

    expect(await screen.findByText('セッションへ戻れず')).toBeTruthy();
    expect(screen.queryByText('復旧不能')).toBeNull();
    expect(
      screen.getByText(
        /外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめる/,
      ),
    ).toBeTruthy();
  });

  it('lost 以外にリモート確認の案内を出さない（雑音にしない）', async () => {
    renderManagers([{ ...BASE, status: 'running' }]);

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/外へ出た成果（PR・コミット/)).toBeNull();
  });

  it('stopped を done（待機中）と混ぜない', async () => {
    renderManagers([{ ...BASE, status: 'stopped', live: false }]);

    expect(await screen.findByText('停止済み')).toBeTruthy();
    expect(row().queryByText('待機中')).toBeNull();
    expect(row().queryByText('完了')).toBeNull();
  });
});

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

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText(/Bash 4件/)).toBeTruthy();
    expect(screen.getByText(/Write 1件/)).toBeTruthy();
    expect(screen.getByText(/クローンには回ってきていない/)).toBeTruthy();
    expect(screen.queryByText(/手が止まっている。/)).toBeNull();
  });

  it('describeDenialFollowUp の写しは core と3値すべてで同じ字面を返す（#1455）', () => {
    const cases: [{ lastAt?: string }[], string | undefined][] = [
      [[], undefined],
      [[{ lastAt: '2026-09-24T07:00:00.000Z' }], '2026-09-24T07:10:00.000Z'],
      [[{ lastAt: '2026-09-24T07:20:00.000Z' }], '2026-09-24T07:10:00.000Z'],
      [[{ lastAt: '2026-09-24T07:00:00.000Z' }, {}], '2026-09-24T07:10:00.000Z'],
    ];
    for (const [denials, lastReportAt] of cases) {
      expect(describeDenialFollowUp(denials, lastReportAt)).toBe(
        coreDescribeDenialFollowUp(denials, lastReportAt),
      );
    }
  });

  it('一覧の拒否の注記に「止められた後に報告が届いたか」が載る（#1455）', async () => {
    renderManagers([
      {
        ...BASE,
        status: 'running',
        lastReportAt: '2026-09-24T07:10:00.000Z',
        denials: [{ tool: 'Bash', count: 1, lastAt: '2026-09-24T07:20:00.000Z' }],
      },
    ]);
    await screen.findByText('実行中');
    const note = screen.getByText(/確認へ上がらず止められた道具/).closest('p');
    expect(note?.textContent).toContain(
      '最後に止められた（2026-09-24T07:20:00.000Z）後の報告はまだ届いていない',
    );
  });

  it('拒否の出所を断定せず、2つの場合分けと「まず担い手の拒否文を読ませる」案内が載る（#1289）', async () => {
    renderManagers([{ ...BASE, status: 'running', denials: [{ tool: 'Bash', count: 1 }] }]);

    await screen.findByText('実行中');
    const note = screen.getByText(/確認へ上がらず止められた道具/).closest('p');
    if (note === null) throw new Error('ManagerDenialNote の段落が見つからない');
    const text = note.textContent ?? '';

    expect(text).not.toContain(
      'この確認はクローンには回ってきていないので、手が止まっている可能性がある。',
    );

    expect(text).toContain(
      '器の分類器か deny 規則なら、この確認はクローンには回ってきていないので手が止まる。',
    );
    expect(text).toContain('PreToolUse');
    expect(text).toContain('bash-wait-guard.ts');
    expect(text).toContain('自力で抜けられることがある');

    const guidanceAt = text.indexOf('まず担い手自身に返っている拒否文を読ませること');
    const branchAAt = text.indexOf('器の分類器か deny 規則なら');
    expect(guidanceAt).toBeGreaterThan(-1);
    expect(guidanceAt).toBeLessThan(branchAAt);
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

    expect(await screen.findByText(/tool-6 7件/)).toBeTruthy();
    expect(screen.getByText(/tool-4 5件/)).toBeTruthy();
    expect(screen.queryByText(/tool-3/)).toBeNull();
    expect(screen.getByText(/ほか 4 種、全 28 件/)).toBeTruthy();
  });

  it('拒否が無いマネージャーには何も足さない（雑音にしない）', async () => {
    renderManagers([{ ...BASE, status: 'running' }]);

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/確認へ上がらず止められた/)).toBeNull();
  });

  it('拒否の層（マネージャー／作業者／層不明）が3値のまま出る', async () => {
    renderManagers([
      {
        ...BASE,
        denials: [
          { tool: 'Bash', count: 2, actor: 'manager' },
          { tool: 'Edit', count: 1, actor: 'worker' },
          { tool: 'Write', count: 3 },
        ],
      },
    ]);

    expect(await screen.findByText(/Bash 2件 \[マネージャー\]/)).toBeTruthy();
    expect(screen.getByText(/Edit 1件 \[作業者\]/)).toBeTruthy();
    expect(screen.getByText(/Write 3件 \[層不明\]/)).toBeTruthy();
  });

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

describe('失敗も、状態を置き換えずに状態へ添える', () => {
  const FAILURE = { code: 'billing_error', via: 'assistant_error', at: '2026-08-20T10:00:00.000Z' };

  it('「待機中」の札を残したまま、SDK の語で失敗を言う', async () => {
    renderManagers([{ ...BASE, status: 'done', lastFailure: FAILURE }]);

    expect(await screen.findByText('待機中')).toBeTruthy();
    expect(row().queryByText('失敗')).toBeNull();
    expect(screen.getByText(/billing_error/)).toBeTruthy();
    expect(screen.getByText(/assistant_error/)).toBeTruthy();
    expect(screen.getByText(/話しかければ続く/)).toBeTruthy();
  });

  it('失敗していないマネージャーには何も足さない（雑音にしない）', async () => {
    renderManagers([{ ...BASE, status: 'running' }]);

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/報告ではなく失敗/)).toBeNull();
  });
});

describe('Issue #1882: 一覧でも、終端した委譲では「生きている」を言わない', () => {
  const FAILURE = { code: 'rate_limit', via: 'assistant_error', at: '2026-08-20T10:00:00.000Z' };

  it('status: failed は終端の言葉に置き換わる', async () => {
    renderManagers([{ ...BASE, status: 'failed', lastFailure: FAILURE }]);

    expect(await screen.findByText(/rate_limit/)).toBeTruthy();
    expect(screen.queryByText(/話しかければ続く/)).toBeNull();
    expect(screen.getByText(/依頼者が望まない終わり方で既に終端している/)).toBeTruthy();
    expect(
      screen.getByText(/続けたいなら話しかけて resume を試みるしかなく、届く保証は無い/),
    ).toBeTruthy();
    expect(screen.queryByText(/自動では続かない/)).toBeNull();
  });

  it('status: lost は終端の言葉に置き換わる', async () => {
    renderManagers([{ ...BASE, status: 'lost', lastFailure: FAILURE }]);

    expect(await screen.findByText(/rate_limit/)).toBeTruthy();
    expect(screen.queryByText(/話しかければ続く/)).toBeNull();
    expect(screen.getByText(/依頼者が望まない終わり方で既に終端している/)).toBeTruthy();
    expect(
      screen.getByText(/続けたいなら話しかけて resume を試みるしかなく、届く保証は無い/),
    ).toBeTruthy();
    expect(screen.queryByText(/自動では続かない/)).toBeNull();
  });

  it('status: stopped は明示的に停止させた終端の言葉になる', async () => {
    renderManagers([{ ...BASE, status: 'stopped', lastFailure: FAILURE }]);

    expect(await screen.findByText(/rate_limit/)).toBeTruthy();
    expect(screen.queryByText(/話しかければ続く/)).toBeNull();
    expect(
      screen.getByText(/人間・クローンが明示的に停止させ、確かめたうえで既に終端している/),
    ).toBeTruthy();
    expect(
      screen.getByText(/続けたいなら話しかけて resume を試みるしかなく、届く保証は無い/),
    ).toBeTruthy();
    expect(screen.queryByText(/原因の有無にかかわらず/)).toBeNull();
  });

  it('lastFoldedTurn が在る回は、古い lastFailure を「直近のターン」として出さない', async () => {
    renderManagers([
      {
        ...BASE,
        status: 'stopped',
        lastFailure: FAILURE,
        lastFoldedTurn: { text: '畳まれた本文', at: '2026-08-21T00:00:00.000Z' },
      },
    ]);

    expect(await screen.findByText('停止済み')).toBeTruthy();
    expect(screen.queryByText(/報告ではなく失敗で終わっている/)).toBeNull();
  });

  it('生きている status（done）は今までどおり「生きている」を言う（既定は変えていない）', async () => {
    renderManagers([{ ...BASE, status: 'done', lastFailure: FAILURE }]);

    expect(await screen.findByText('待機中')).toBeTruthy();
    expect(screen.getByText(/話しかければ続く/)).toBeTruthy();
    expect(
      screen.getByText(/セッションは生きているので、原因が解ければ話しかければ続く。/),
    ).toBeTruthy();
  });
});

describe('背景処理の完了待ちは、`status` も `live` も置き換えずに添える', () => {
  const AWAITING = {
    tasks: 3,
    withheldReports: 2,
    breakdown: 'local_agent×3',
    since: '2026-08-16T03:10:00.000Z',
  };

  it('札は「待機中」のまま、在り高・内訳・配っていない本数を隣に添える', async () => {
    renderManagers([{ ...BASE, status: 'done', live: true, awaitingBackground: AWAITING }]);

    expect(await screen.findByText('待機中')).toBeTruthy();
    expect(screen.getByText('接続あり')).toBeTruthy();
    expect(screen.getByText(/手が空いたのではない/)).toBeTruthy();
    expect(screen.getByText(/local_agent×3/)).toBeTruthy();
    expect(screen.getByText(/捨てたのではない/)).toBeTruthy();
  });

  it('握り潰しが無いマネージャーには何も足さない', async () => {
    renderManagers([{ ...BASE, status: 'done', live: true }]);

    expect(await screen.findByText('待機中')).toBeTruthy();
    expect(screen.queryByText(/手が空いたのではない/)).toBeNull();
    expect(screen.queryByText(/背景処理/)).toBeNull();
  });
});

describe('`live` は、繋がっていないことも札で言う', () => {
  it('「走っている扱いだが繋がっていない」でも、実行中の札は残したまま切断を言う', async () => {
    renderManagers([{ ...BASE, status: 'running', live: false }]);

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

describe('セッションが無いことは、`live` も状態も置き換えずに添える', () => {
  const MISSING = '2026-08-16T03:10:00.000Z';

  it('「実行中」も「接続あり」も残したまま、セッションが無いことを言う', async () => {
    renderManagers([{ ...BASE, status: 'running', live: true, sessionMissingSince: MISSING }]);

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('接続あり')).toBeTruthy();
    expect(screen.queryByText('セッション切断')).toBeNull();
    expect(screen.getByText(/runner がそう答えた。聞けなかったのではない/)).toBeTruthy();
  });

  it('「失われた」と言い切らず、完遂後に畳まれた回も同じ形に見えることを言う', async () => {
    renderManagers([{ ...BASE, status: 'running', live: true, sessionMissingSince: MISSING }]);

    expect(await screen.findByText(/この委譲が失われたという意味ではない/)).toBeTruthy();
    expect(
      screen.getByText(
        /完遂した後にセッションが畳まれ、終端の合図だけが届かなかった回も同じ形に見える/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/同じ仕事が2本になる/)).toBeTruthy();
  });

  it('欄が無いマネージャーには何も足さない（雑音にしない）', async () => {
    renderManagers([{ ...BASE, status: 'running', live: true }]);

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/この委譲のセッションを持っていなかった/)).toBeNull();
  });

  it('時刻は相対表示で、ISO をそのまま出さない', async () => {
    renderManagers([{ ...BASE, status: 'running', live: true, sessionMissingSince: MISSING }]);

    expect(await screen.findByText(/この委譲のセッションを持っていなかった/)).toBeTruthy();
    expect(screen.queryByText(new RegExp(MISSING))).toBeNull();
  });

  it('sessionMissingKind: resume-failed は「resume でも入り直せなかった」を言う', async () => {
    renderManagers([
      {
        ...BASE,
        status: 'running',
        live: true,
        sessionMissingSince: MISSING,
        sessionMissingKind: 'resume-failed',
      },
    ]);

    expect(await screen.findByText(/resume でも入り直せなかった/)).toBeTruthy();
    expect(screen.queryByText(/名簿に載っていなかった/)).toBeNull();
  });

  it('sessionMissingKind: unlisted は「名簿に載っていなかった。resume はまだ試していない」を言う', async () => {
    renderManagers([
      {
        ...BASE,
        status: 'running',
        live: true,
        sessionMissingSince: MISSING,
        sessionMissingKind: 'unlisted',
      },
    ]);

    expect(
      await screen.findByText(/名簿に載っていなかった。resume はまだ試していない/),
    ).toBeTruthy();
    expect(screen.queryByText(/resume でも入り直せなかった/)).toBeNull();
  });

  it('sessionMissingKind が無いときは、由来の字面も「不明」も出さない', async () => {
    // モデルの札の「不明」と混ざらないよう、名乗り済みの行にする。
    renderManagers([
      {
        ...BASE,
        status: 'running',
        live: true,
        sessionMissingSince: MISSING,
        managerModel: 'opus',
      },
    ]);

    expect(await screen.findByText(/この委譲のセッションを持っていなかった/)).toBeTruthy();
    expect(screen.queryByText(/resume でも入り直せなかった/)).toBeNull();
    expect(screen.queryByText(/名簿に載っていなかった/)).toBeNull();
    expect(screen.queryByText(/不明/)).toBeNull();
  });

  it('sessionMissingKind に未知の値が来ても、例外を投げず生の値も描かない（版のずれに備える）', async () => {
    renderManagers([
      {
        ...BASE,
        status: 'running',
        live: true,
        sessionMissingSince: MISSING,
        sessionMissingKind: 'future-kind' as ManagerSummary['sessionMissingKind'],
      },
    ]);

    expect(await screen.findByText(/この委譲のセッションを持っていなかった/)).toBeTruthy();
    expect(screen.queryByText(/future-kind/)).toBeNull();
  });
});

describe('器が黙ったことは、`status` を動かさずに添える', () => {
  const LOST_SINCE = '2026-08-16T03:05:00.000Z';

  it('「実行中」の札を残したまま、器が名乗っていないことを言う', async () => {
    renderManagers([{ ...BASE, status: 'running', live: false, runnerLostSince: LOST_SINCE }]);

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('セッション切断')).toBeTruthy();
    expect(screen.getByText(/宛先の器は.*から名乗っていない/)).toBeTruthy();
    expect(screen.getByText(/新しい委譲の宛先からは外れている/)).toBeTruthy();
  });

  it('送信可否を推論しない（「いま話しかけられない」と書かない）', async () => {
    renderManagers([{ ...BASE, status: 'running', live: false, runnerLostSince: LOST_SINCE }]);

    expect(await screen.findByText(/宛先の器は.*から名乗っていない/)).toBeTruthy();
    expect(screen.queryByText(/いま話しかけられない/)).toBeNull();
    expect(screen.queryByText(/届かない/)).toBeNull();
    expect(screen.queryByText(/届かず/)).toBeNull();
    expect(screen.getByText(/話しかけることは塞いでいない/)).toBeTruthy();
    expect(screen.getByText(/送ると resume\s*を試みる/)).toBeTruthy();
  });

  it('「塞いでいない」を無条件に言わず、戻る先（session_id）を条件として言う', async () => {
    renderManagers([{ ...BASE, status: 'running', live: false, runnerLostSince: LOST_SINCE }]);

    expect(await screen.findByText(/宛先の器は.*から名乗っていない/)).toBeTruthy();
    expect(screen.getByText(/戻る先（session_id）が在れば/)).toBeTruthy();
    expect(screen.getByText(/届くとは限らない/)).toBeTruthy();
  });

  it('「失われた」と言い切らず、器の中でまだ走っている可能性を潰さない', async () => {
    renderManagers([{ ...BASE, status: 'running', live: false, runnerLostSince: LOST_SINCE }]);

    expect(await screen.findByText(/この委譲が失われたという意味ではない/)).toBeTruthy();
    expect(screen.getByText(/黙っているのが器なのか経路なのかは、ここからは言えない/)).toBeTruthy();
    expect(row().queryByText('セッションへ戻れず')).toBeNull();
  });

  it('欄が無いマネージャーには何も足さない（雑音にしない）', async () => {
    renderManagers([{ ...BASE, status: 'running', live: false }]);

    expect(await screen.findByText('セッション切断')).toBeTruthy();
    expect(screen.queryByText(/名乗っていない/)).toBeNull();
  });

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

// ALL_KINDS を Record で持つ: 値が増えたときに型で落とすため（配列だと3つ目が足されても素通りする）
describe('sessionMissingKind の字面が core と一致する（#579）', () => {
  const ALL_KINDS: Record<NonNullable<ManagerSummary['sessionMissingKind']>, true> = {
    'resume-failed': true,
    unlisted: true,
  };

  it('全ての由来で、core の describeSessionMissingKind と文字列として等しい', () => {
    const kinds = Object.keys(ALL_KINDS) as NonNullable<ManagerSummary['sessionMissingKind']>[];
    // 空でないことを先に確かめる: Object.keys が空だと forEach が1回も回らず、何も測らずに緑になるため
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(describeSessionMissingKindNote(kind)).toBe(describeSessionMissingKind(kind));
    }
  });

  it('由来が無いときも一致する（どちらも空文字。「不明」と書かない）', () => {
    expect(describeSessionMissingKindNote(undefined)).toBe(describeSessionMissingKind(undefined));
    expect(describeSessionMissingKindNote(undefined)).toBe('');
  });
});

describe('status の絞り込みと「もっと見る」（issue #670）', () => {
  function page(count: number, offset = 0, status: ManagerSummary['status'] = 'running') {
    return Array.from({ length: count }, (_, index) => ({
      ...BASE,
      managerId: `mgr-${offset + index}`,
      // 行を見分けられる本文にする: BASE.request のままだと全行が同じ文字列になり、前の頁が消えていないことを測れないため
      request: `req-mgr-${offset + index}`,
      status,
      startedAt: new Date(Date.UTC(2026, 7, 16, 3, 0, 0) - (offset + index) * 60_000).toISOString(),
    }));
  }

  function renderWithRoutes(respond: (url: string) => object | undefined) {
    const stub = stubFetch((url) => {
      if (!url.includes('/managers')) return undefined;
      const body = respond(url);
      return body === undefined ? json({ managers: [] }) : json(body);
    });
    const router = createMemoryRouter([{ path: '/', Component: Managers }], {
      initialEntries: ['/'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    return stub;
  }

  // 引数なしの呼びに ? を付けない: デーモンは生のクエリで opt-in を判定し、空の値を1つ送った時点で窓の掛かった呼びに化けるため
  it('dashboard 相当の引数なしの呼びは、クエリ文字列を付けない', async () => {
    const { useManagers } = await import('@alteroid/swr');
    const stub = stubFetch((url) =>
      url.includes('/managers') ? json({ managers: [] }) : undefined,
    );
    function Probe() {
      useManagers();
      return null;
    }
    render(
      <Providers>
        <Probe />
      </Providers>,
    );

    await waitFor(() => {
      expect(stub.calls.some((url) => url.includes('/managers'))).toBe(true);
    });
    const call = stub.calls.find((url) => url.includes('/managers')) as string;
    expect(call).not.toContain('?');
  });

  it('チップを押すと status= がサーバへ渡る（画面側で filter して捨てない）', async () => {
    const stub = renderWithRoutes(() => ({ managers: page(1) }));

    await waitFor(() => {
      expect(screen.getByRole('list')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '人間待ち' }));

    await waitFor(() => {
      expect(stub.calls.some((url) => url.includes('status=waiting_human'))).toBe(true);
    });
  });

  it('チップを複数押すとカンマ区切りで渡る', async () => {
    const stub = renderWithRoutes(() => ({ managers: page(1) }));

    await waitFor(() => {
      expect(screen.getByRole('list')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '実行中' }));
    fireEvent.click(screen.getByRole('button', { name: 'セッションへ戻れず' }));

    await waitFor(() => {
      expect(stub.calls.some((url) => url.includes('status=running%2Clost'))).toBe(true);
    });
  });

  it('絞りを解除すると status= を渡さなくなる', async () => {
    const stub = renderWithRoutes(() => ({ managers: page(1) }));

    await waitFor(() => {
      expect(screen.getByRole('list')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '実行中' }));
    await waitFor(() => {
      expect(stub.calls.some((url) => url.includes('status=running'))).toBe(true);
    });

    const before = stub.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '解除' }));
    await waitFor(() => {
      expect(stub.calls.length).toBeGreaterThan(before);
    });
    const after = stub.calls.slice(before);
    expect(after.some((url) => url.includes('/managers'))).toBe(true);
    expect(after.filter((url) => url.includes('/managers')).at(-1)).not.toContain('status=');
  });

  it('絞りに当たるものだけが表示される', async () => {
    renderWithRoutes((url) =>
      url.includes('status=lost')
        ? { managers: [{ ...BASE, managerId: 'mgr-lost', status: 'lost' as const, live: false }] }
        : { managers: page(1) },
    );

    await waitFor(() => {
      expect(row().getByText('req-mgr-0')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'セッションへ戻れず' }));

    await waitFor(() => {
      expect(row().getByText('PR を出して')).toBeTruthy();
    });
    expect(row().queryByText('req-mgr-0')).toBeNull();
  });

  it('絞りで0件になったとき「まだマネージャーはいません」とは言わない', async () => {
    renderWithRoutes((url) => (url.includes('status=') ? { managers: [] } : { managers: page(1) }));

    await waitFor(() => {
      expect(screen.getByRole('list')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '失敗' }));

    expect(await screen.findByText(/この状態のマネージャーは無い/)).toBeTruthy();
    expect(screen.queryByText(/まだマネージャーはいません/)).toBeNull();
  });

  it('「もっと見る」で継ぎ足される（前の頁が消えない・錨を渡している）', async () => {
    const stub = renderWithRoutes((url) =>
      url.includes('afterId=')
        ? { managers: page(1, MANAGERS_PAGE) }
        : { managers: page(MANAGERS_PAGE) },
    );

    await waitFor(() => {
      expect(row().getByText('req-mgr-0')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /もっと見る/ }));

    await waitFor(() => {
      expect(row().getByText(`req-mgr-${MANAGERS_PAGE}`)).toBeTruthy();
    });
    expect(row().getByText('req-mgr-0')).toBeTruthy();
    const load = stub.calls.find((url) => url.includes('afterId=')) as string;
    expect(load).toContain(`afterId=mgr-${MANAGERS_PAGE - 1}`);
    expect(load).toContain('afterStartedAt=');
  });

  it('限度に届かない頁が返ったら「もっと見る」を出さず、終端だと言う', async () => {
    renderWithRoutes(() => ({ managers: page(2) }));

    await waitFor(() => {
      expect(row().getByText('req-mgr-0')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /もっと見る/ })).toBeNull();
    expect(screen.getByText(/これより古い委譲は無い（全 2 件）/)).toBeTruthy();
  });

  it('「もっと見る」が失敗したら、終端と混ぜずに理由と押し直しを出す', async () => {
    const stub = stubFetch((url) => {
      if (!url.includes('/managers')) return undefined;
      if (url.includes('afterId=')) {
        return {
          ok: false,
          status: 400,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ error: 'afterId/afterStartedAt が指す行が見当たらない' }),
          text: () => Promise.resolve('{"error":"afterId/afterStartedAt が指す行が見当たらない"}'),
        } as unknown as Response;
      }
      return json({ managers: page(MANAGERS_PAGE) });
    });
    const router = createMemoryRouter([{ path: '/', Component: Managers }], {
      initialEntries: ['/'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    await waitFor(() => {
      expect(row().getByText('req-mgr-0')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /もっと見る/ }));

    expect(await screen.findByText(/自動では進めない/)).toBeTruthy();
    expect(screen.queryByText(/これより古い委譲は無い/)).toBeNull();
    expect(screen.getByText(/全部読み終えたのではない/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'もう一度試す' })).toBeTruthy();
    expect(row().getByText('req-mgr-0')).toBeTruthy();
    expect(stub.calls.some((url) => url.includes('afterId='))).toBe(true);
  });

  it('絞りと窓を通しても、札・注記・接続表示が全部出る', async () => {
    renderWithRoutes(() => ({
      managers: [
        {
          ...BASE,
          managerId: 'mgr-loud',
          status: 'running' as const,
          live: false,
          runnerLostSince: '2026-08-16T03:05:00.000Z',
          sessionMissingSince: '2026-08-16T03:10:00.000Z',
          sessionMissingKind: 'unlisted' as const,
          denials: [{ tool: 'Bash', count: 2, actor: 'manager' as const }],
          lastFailure: {
            code: 'billing_error',
            via: 'assistant_error',
            at: '2026-08-20T10:00:00.000Z',
          },
          awaitingBackground: {
            tasks: 3,
            withheldReports: 2,
            breakdown: 'local_agent×3',
            since: '2026-08-16T03:10:00.000Z',
          },
        },
      ],
    }));

    await waitFor(() => {
      expect(screen.getByRole('list')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '実行中' }));

    expect(await waitFor(() => row().getByText('実行中'))).toBeTruthy();
    expect(row().getByText('セッション切断')).toBeTruthy();
    expect(row().getByText(/Bash 2件 \[マネージャー\]/)).toBeTruthy();
    expect(row().getByText(/billing_error/)).toBeTruthy();
    expect(row().getByText(/手が空いたのではない/)).toBeTruthy();
    expect(row().getByText(/宛先の器は.*から名乗っていない/)).toBeTruthy();
    expect(row().getByText(/この委譲のセッションを持っていなかった/)).toBeTruthy();
    expect(row().getByText(/名簿に載っていなかった/)).toBeTruthy();
  });

  it('6値すべてがチップとして出る（札の正本から起こしている）', async () => {
    const LABELS: Record<ManagerSummary['status'], string> = {
      running: '実行中',
      waiting_human: '人間待ち',
      done: '待機中',
      failed: '失敗',
      lost: 'セッションへ戻れず',
      stopped: '停止済み',
    };
    renderWithRoutes(() => ({ managers: page(1) }));

    await waitFor(() => {
      expect(screen.getByRole('list')).toBeTruthy();
    });
    const labels = Object.values(LABELS);
    expect(labels.length).toBe(6);
    for (const label of labels) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });
});

describe('状態チップの選択が URL に載る（issue #2030）', () => {
  function renderWithRouter(
    respond: (url: string) => object | undefined,
    initialEntries: string[] = ['/'],
  ) {
    const stub = stubFetch((url) => {
      if (!url.includes('/managers')) return undefined;
      const body = respond(url);
      return body === undefined ? json({ managers: [] }) : json(body);
    });
    const router = createMemoryRouter([{ path: '/', Component: Managers }], {
      initialEntries,
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    return { stub, router };
  }

  it('チップを押すと URL の status に状態が載る', async () => {
    const { router } = renderWithRouter(() => ({ managers: [{ ...BASE }] }));
    await screen.findByRole('button', { name: '実行中' });

    fireEvent.click(screen.getByRole('button', { name: '実行中' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('status')).toBe('running');
    });

    fireEvent.click(screen.getByRole('button', { name: 'セッションへ戻れず' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('status')).toBe('running,lost');
    });

    fireEvent.click(screen.getByRole('button', { name: '実行中' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('status')).toBe('lost');
    });
  });

  it('URL の status から初期状態が復元される（チップが押された状態で開く）', async () => {
    const { stub } = renderWithRouter(() => ({ managers: [] }), ['/?status=running,lost']);
    await screen.findByRole('button', { name: '実行中' });

    expect(screen.getByRole('button', { name: '実行中' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(
      screen.getByRole('button', { name: 'セッションへ戻れず' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: '人間待ち' }).getAttribute('aria-pressed')).toBe(
      'false',
    );

    await waitFor(() => {
      expect(stub.calls.some((url) => url.includes('status=running%2Clost'))).toBe(true);
    });
  });

  it('URL に知らない状態が書かれていても落ちない（無視する。#2010 の線）', async () => {
    renderWithRouter(() => ({ managers: [] }), ['/?status=running,no-such-status']);

    await screen.findByRole('button', { name: '実行中' });
    expect(screen.getByRole('button', { name: '実行中' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.queryByRole('button', { name: 'no-such-status' })).toBeNull();
  });

  it('絞りの解除は URL からも status を消す', async () => {
    const { router } = renderWithRouter(() => ({ managers: [] }), ['/?status=running']);
    await screen.findByRole('button', { name: '実行中' });

    fireEvent.click(screen.getByRole('button', { name: '解除' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).has('status')).toBe(false);
    });
  });

  it('チップの切り替えは履歴を汚さない（replace: true。journal.tsx の判断に揃える）', async () => {
    const { router } = renderWithRouter(() => ({ managers: [{ ...BASE }] }));
    await screen.findByRole('button', { name: '実行中' });

    fireEvent.click(screen.getByRole('button', { name: '実行中' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('status')).toBe('running');
    });
    expect(router.state.historyAction).toBe('REPLACE');
  });
});

describe('ManagerRunnerVanishedNote（Issue #1212 running 側。段1）', () => {
  it('印が立っていれば、消えていることと「lost ではない」を出す。時刻は出さない', () => {
    render(<ManagerRunnerVanishedNote runnerVanished={true} />);
    expect(screen.getByText(/宛先の器が名簿から消えている/)).toBeTruthy();
    expect(screen.getByText(/消えた時刻は名簿に残っていないので分からない/)).toBeTruthy();
    expect(screen.getByText(/「セッションへ戻れず」で絞っても出てこない/)).toBeTruthy();
  });

  it('印が無ければ1文字も描かない', () => {
    const { container } = render(<ManagerRunnerVanishedNote runnerVanished={undefined} />);
    expect(container.textContent).toBe('');
  });
});

describe('知らない status に倒れ先がある（#1623）', () => {
  it('知らない status が混ざっても、他の行は見え、その行は生の値を出す', async () => {
    renderManagers([
      { ...BASE, managerId: 'mgr-good', request: 'known good row' },
      {
        ...BASE,
        managerId: 'mgr-bad',
        request: 'unknown status row',
        status: 'archived' as ManagerSummary['status'],
      },
    ]);

    expect(await screen.findByText('known good row')).toBeTruthy();
    expect(screen.getByText('unknown status row')).toBeTruthy();
    expect(screen.getByText('知らない状態（archived）')).toBeTruthy();
  });

  it('Object の継承したキーと同じ名前の status でも落ちない', async () => {
    renderManagers([
      {
        ...BASE,
        managerId: 'mgr-proto',
        request: 'prototype key row',
        status: 'constructor' as ManagerSummary['status'],
      },
    ]);

    expect(await screen.findByText('prototype key row')).toBeTruthy();
    expect(screen.getByText('知らない状態（constructor）')).toBeTruthy();
  });
});

describe('マネージャー層の provider（撤去済み。2026-10-07 の決定）', () => {
  it('行に provider を出さない（層は常に Claude）', async () => {
    renderManagers([{ ...BASE, managerId: 'mgr-plain', request: '普通の委譲' }]);

    expect(await screen.findByText(/普通の委譲/)).toBeTruthy();
    expect(screen.queryByText(/provider:/)).toBeNull();
    expect(screen.queryByLabelText(/provider/)).toBeNull();
  });

  it('名乗られたモデルを札に出し、名乗られていなければ「不明」と出す（既定の帯で埋めない。#3921）', async () => {
    renderManagers([
      { ...BASE, managerId: 'mgr-model', managerModel: 'opus' },
      { ...BASE, managerId: 'mgr-nomodel', request: 'モデル名乗り無し' },
    ]);

    expect(await screen.findByLabelText('モデル: opus（層は Claude で動く）')).toBeTruthy();
    expect(screen.getByLabelText('モデル: 不明（名乗りを受けていない）')).toBeTruthy();
    expect(screen.queryByLabelText(/sonnet/)).toBeNull();
  });
});
