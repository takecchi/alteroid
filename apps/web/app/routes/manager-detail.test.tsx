// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CGROUP_EVENTS_UNKNOWN_NOTE,
  formatCgroupEventsNote,
} from '@alteroid/core/cgroup-events-format';
import {
  formatSystemErrorFacts,
  formatSystemErrorUnknownNote,
} from '@alteroid/core/system-error-format';
import type { ManagerStatus, ManagerSummary } from '@alteroid/logic';
import {
  DEFAULT_VIEWPORT_WIDTH,
  json,
  Providers,
  setViewportWidth,
  stubFetch,
  storeTestBaseUrl,
} from '~/test-support';

import type { Route } from './+types/manager-detail';
import ManagerDetail, { clientLoader } from './manager-detail';

// vi.hoisted にする: import の評価より後だと TZ の固定が静かに効かないため
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

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

// loaderData の形を手で書き写さない: 手書きの { id } だと clientLoader の戻り値が変わった日にこの試験だけが古い形のまま通り続けるため
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

// 共通の stubFetch を使わない: openapi-fetch は fetch(request, requestInitExt) の形で呼び、stubFetch は第2引数だけを見るので init?.method が常に undefined になるため
// url.includes の1本勝負にしない: /managers/mgr-1 の部分一致が /managers/mgr-1/messages にも当たり、POST が GET 用の応答を受け取って壊れるため
function renderDetailWithMessages(
  manager: ManagerSummary,
  sendResult: { outcome: string; detail: string } = {
    outcome: 'delivered',
    detail: '追加指示として届けた。',
  },
  gate?: Promise<void>,
) {
  const sent: { url: string; method: string; body?: unknown }[] = [];
  const reply = { status: 200, body: sendResult as unknown };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const { url, method } = request;
    if (url.endsWith(`/managers/${manager.managerId}/messages`)) {
      // .clone() で読む: 後で本物の fetch 実装が同じ request を読む経路が万一あっても壊れないため
      const body: unknown = await request
        .clone()
        .json()
        .catch(() => undefined);
      sent.push({ url, method, body });
      if (gate !== undefined) await gate;
      return json(reply.body, reply.status);
    }
    if (url.includes(`/managers/${manager.managerId}`)) return json({ manager });
    throw new TypeError(`Failed to fetch: ${url}`);
  }) as typeof fetch;
  const router = createMemoryRouter(
    [
      { path: '/managers/:id', Component: () => <Harness id={manager.managerId} /> },
      { path: '/journal', Component: () => null },
    ],
    { initialEntries: [`/managers/${manager.managerId}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { sent, reply };
}

describe('依頼の全文は header ではなく本文に置く', () => {
  const LONG = [
    '依頼の1行目',
    ...Array.from({ length: 40 }, (_, index) => `手順 ${index + 1}: ${'あ'.repeat(60)}`),
  ].join('\n');

  it('本文に全文があり、header には依頼が入っていない', async () => {
    renderDetail({ ...BASE, request: LONG });

    // 既定の normalizer を通さない: 改行を潰すと「改行を捨てる変異」が見えなくなるため
    const body = await screen.findByText(LONG, { normalizer: (text) => text });
    expect(body.textContent).toBe(LONG);
    expect(body.closest('header')).toBeNull();
    expect(screen.getByText('依頼')).toBeTruthy();

    const header = document.querySelector('header');
    expect(header).not.toBeNull();
    expect(header?.textContent ?? '').not.toContain('手順 40:');
    expect(header?.textContent ?? '').toContain('依頼の全文は下');
  });
});

describe('詳細から、その委譲の使用量へ飛べる（issue #2077）', () => {
  it('「状態」カードに /usage?managerId=<id> へのリンクがある', async () => {
    renderDetail({ ...BASE, managerId: 'mgr-77' });

    const link = await screen.findByRole('link', { name: '使用量を見る' });
    expect(link.getAttribute('href')).toBe('/usage?managerId=mgr-77');
  });
});

describe('詳細でも、lost には次の一手を添える', () => {
  it('「復旧不能」と書かず、観測の限界と確かめる先を出す', async () => {
    renderDetail({ ...BASE, status: 'lost', live: false });

    expect(await screen.findByText('セッションへ戻れず')).toBeTruthy();
    expect(screen.queryByText('復旧不能')).toBeNull();
    expect(screen.getByText(/戻れたかどうかしか見ていない/)).toBeTruthy();
    expect(
      screen.getByText(
        /外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめる/,
      ),
    ).toBeTruthy();
  });

  it('lost 以外にはリモート確認の案内を出さない（雑音にしない）', async () => {
    renderDetail({ ...BASE, status: 'running' });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/戻れたかどうかしか見ていない/)).toBeNull();
    expect(screen.queryByText(/外へ出た成果（PR・コミット/)).toBeNull();
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

    expect(await screen.findByText('実行中')).toBeTruthy();
    // 完全一致でなく部分一致で見る: 層の印（denialActorTag）が同じ要素へ付くため
    expect(screen.getByText(/^Bash/)).toBeTruthy();
    expect(screen.getByText(/^Write/)).toBeTruthy();
    expect(screen.getByText(/^WebFetch/)).toBeTruthy();
    expect(screen.getByText(/確認へ上がらず止められた 7 件/)).toBeTruthy();
    expect(screen.getByText(/この仕事が止まったかどうかは見ていない/)).toBeTruthy();
    expect(screen.getByText(/実行環境を作り直すと数え直しになる/)).toBeTruthy();
  });

  it('subtitle が拒否の出所を断定せず、2つの場合分けと「まず担い手の拒否文を読ませる」案内が載る（#1289 / #1844）', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      denials: [{ tool: 'Bash', count: 1 }],
    });

    await screen.findByText('実行中');
    const subtitle = screen.getByText(/出所はこの数からは取れない/);
    const text = subtitle.textContent ?? '';

    expect(text).not.toBe(
      '分類器か deny 規則がその場で拒否した。この確認は人間にもクローンにも回ってきていない',
    );
    expect(text).not.toContain(
      '分類器か deny 規則がその場で拒否した。この確認は人間にもクローンにも回ってきていない',
    );

    expect(text).not.toContain('この確認は人間にもクローンにも回ってきていない');

    expect(text).toContain(
      '実行環境の分類器か deny 規則なら、この確認はクローンには回ってきていない',
    );
    expect(text).toContain('PreToolUse');
    expect(text).toContain('bash-wait-guard.ts');
    expect(text).toContain('自力で抜けられることがある');

    const guidanceAt = text.indexOf('まず担い手自身の拒否文を読ませること');
    const branchAAt = text.indexOf('実行環境の分類器か deny 規則なら');
    expect(guidanceAt).toBeGreaterThan(-1);
    expect(guidanceAt).toBeLessThan(branchAAt);

    expect(screen.getByText(/この仕事が止まったかどうかは見ていない/)).toBeTruthy();
  });

  it('拒否が無いマネージャーには何も足さない（雑音にしない）', async () => {
    renderDetail({ ...BASE, status: 'running' });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/確認へ上がらず止められた/)).toBeNull();
  });

  it('拒否の層（マネージャー／作業者／層不明）が3値のまま出る', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      denials: [
        { tool: 'Bash', count: 2, actor: 'manager' },
        { tool: 'Edit', count: 1, actor: 'worker' },
        { tool: 'Write', count: 3 },
      ],
    });

    expect(await screen.findByText(/Bash ?\[マネージャー\]/)).toBeTruthy();
    expect(screen.getByText(/Edit ?\[作業者\]/)).toBeTruthy();
    expect(screen.getByText(/Write ?\[層不明\]/)).toBeTruthy();
  });

  it('actor が無い回は [層不明] になり、[マネージャー] へは化けない', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      denials: [{ tool: 'Bash', count: 1 }],
    });

    expect(await screen.findByText(/Bash ?\[層不明\]/)).toBeTruthy();
    expect(screen.queryByText(/\[マネージャー\]/)).toBeNull();
  });

  it('同じ道具が層違いで2件返っても、両方とも表示される', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      denials: [
        { tool: 'Bash', count: 3, actor: 'worker' },
        { tool: 'Bash', count: 1, actor: 'manager' },
      ],
    });

    expect(await screen.findByText(/Bash ?\[作業者\]/)).toBeTruthy();
    expect(screen.getByText(/Bash ?\[マネージャー\]/)).toBeTruthy();
    expect(screen.getByText(/確認へ上がらず止められた 4 件/)).toBeTruthy();
  });
});

// 相対表記（「〜分前」）の文言を確かめない: formatRelative は壁時計に依存し、固定の期待値は実行時刻によって別の帯に化けるため（fake timers は real timers 前提の非同期待ちと混ぜるとハングの危険がある）
describe('待ちは kind で質問と実行許可を出し分ける（#334）', () => {
  const askedAt = '2026-08-23T01:00:00.000Z';

  it('kind: question には本文の入力欄が出て、送るのは人間が書いた文と requestId だけ（decision を送らない）', async () => {
    const { sent } = renderDetailWithMessages(
      {
        ...BASE,
        status: 'waiting_human',
        waiting: [
          { requestId: 'req-q', summary: 'DB はどちらにする？', kind: 'question', askedAt },
        ],
      },
      { outcome: 'answered', detail: '回答として届けた。' },
    );

    expect(await screen.findByText('DB はどちらにする？')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /を許可$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /を拒否$/ })).toBeNull();
    expect(screen.getByText(/08\/23 10:00/)).toBeTruthy();

    const textarea = screen.getByPlaceholderText('この質問への答えを、自分の言葉で書く');
    fireEvent.change(textarea, { target: { value: 'PostgreSQL で' } });
    const button = screen.getByRole('button', { name: '「DB はどちらにする？」へ答えを送信' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'POST' });
    expect(sent[0]?.body).toEqual({ text: 'PostgreSQL で', requestId: 'req-q' });
  });

  it('質問の行の「送信」と答えの欄には、どの質問か分かる名前が付く（#3371）', async () => {
    renderDetailWithMessages(
      {
        ...BASE,
        status: 'waiting_human',
        waiting: [
          { requestId: 'req-a', summary: 'DB はどちらにする？', kind: 'question', askedAt },
          { requestId: 'req-b', summary: '期限はいつにする？', kind: 'question', askedAt },
        ],
      },
      { outcome: 'answered', detail: '回答として届けた。' },
    );
    expect(await screen.findByText('DB はどちらにする？')).toBeTruthy();
    for (const q of ['「DB はどちらにする？」', '「期限はいつにする？」']) {
      expect(screen.getByRole('button', { name: `${q}へ答えを送信` })).toBeTruthy();
      expect(screen.getByRole('textbox', { name: `${q}への答え` })).toBeTruthy();
    }
  });

  it('question は空文字・空白のみでは送らない', async () => {
    const { sent } = renderDetailWithMessages({
      ...BASE,
      status: 'waiting_human',
      waiting: [{ requestId: 'req-q', summary: 'DB はどちらにする？', kind: 'question', askedAt }],
    });

    expect(await screen.findByText('DB はどちらにする？')).toBeTruthy();
    const textarea = screen.getByPlaceholderText('この質問への答えを、自分の言葉で書く');
    const button = screen.getByRole('button', { name: '「DB はどちらにする？」へ答えを送信' });

    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(sent).toHaveLength(0);

    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(sent).toHaveLength(0);
  });

  it('kind: permission は許可・拒否の2ボタンのまま', async () => {
    const { sent } = renderDetailWithMessages({
      ...BASE,
      status: 'waiting_human',
      waiting: [
        { requestId: 'req-p', summary: 'Bash の実行許可: ls', kind: 'permission', askedAt },
      ],
    });

    expect(await screen.findByText('Bash の実行許可: ls')).toBeTruthy();
    expect(screen.queryByPlaceholderText('この質問への答えを、自分の言葉で書く')).toBeNull();
    expect(screen.getByText(/08\/23 10:00/)).toBeTruthy();

    const allow = screen.getByRole('button', { name: '「Bash の実行許可: ls」を許可' });
    fireEvent.click(allow);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({ text: '許可する', requestId: 'req-p', decision: 'allow' });
  });

  it('「拒否」を押すと回るのは「拒否」で、「許可」は回らず塞がる。「許可」でも逆になる', async () => {
    for (const [pressed, other] of [
      ['拒否', '許可'],
      ['許可', '拒否'],
    ] as const) {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { sent } = renderDetailWithMessages(
        {
          ...BASE,
          status: 'waiting_human',
          waiting: [
            { requestId: 'req-p', summary: 'Bash の実行許可: ls', kind: 'permission', askedAt },
          ],
        },
        { outcome: 'answered', detail: '解いた。' },
        gate,
      );
      expect(await screen.findByText('Bash の実行許可: ls')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: `「Bash の実行許可: ls」を${pressed}` }));
      await waitFor(() => expect(sent).toHaveLength(1));

      const pressedButton = screen.getByRole('button', {
        name: `「Bash の実行許可: ls」を${pressed}`,
      });
      const otherButton = screen.getByRole('button', { name: `「Bash の実行許可: ls」を${other}` });
      expect(pressedButton.querySelector('.animate-spin')).not.toBeNull();
      expect(otherButton.querySelector('.animate-spin')).toBeNull();
      expect((pressedButton as HTMLButtonElement).disabled).toBe(true);
      expect((otherButton as HTMLButtonElement).disabled).toBe(true);

      release();
      await waitFor(() =>
        expect(
          screen
            .getByRole('button', { name: `「Bash の実行許可: ls」を${pressed}` })
            .querySelector('.animate-spin'),
        ).toBeNull(),
      );
      cleanup();
    }
  });

  it('kind が届かない（版のずれ）ときは許可確認と同じ2ボタンへ倒れる', async () => {
    renderDetail({
      ...BASE,
      status: 'waiting_human',
      waiting: [
        {
          requestId: 'req-unknown',
          summary: '種別が来なかった確認',
          // as で割り込む: 型は kind を必須で持つので、古いデーモンの版ずれを模すにはこうするしかないため
        } as ManagerSummary['waiting'][number],
      ],
    });

    expect(await screen.findByText('種別が来なかった確認')).toBeTruthy();
    expect(screen.getByRole('button', { name: '「種別が来なかった確認」を許可' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '「種別が来なかった確認」を拒否' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '「種別が来なかった確認」を拒否' }).className,
    ).not.toContain('border-destructive/40');
    expect(screen.queryByPlaceholderText('この質問への答えを、自分の言葉で書く')).toBeNull();
  });
});

describe('詳細でも、失敗は状態を置き換えずに状態へ添える', () => {
  const FAILURE = { code: 'billing_error', via: 'assistant_error', at: '2026-08-20T10:00:00.000Z' };

  it('「待機中」の札を残したまま、SDK の語・時刻・次の一手を出す', async () => {
    renderDetail({ ...BASE, status: 'done', lastFailure: FAILURE });

    expect(await screen.findByText('待機中')).toBeTruthy();
    expect(screen.getByText('⚠ 直近のターンは失敗で終わった')).toBeTruthy();
    expect(screen.getByText('billing_error')).toBeTruthy();
    expect(screen.getByText('assistant_error')).toBeTruthy();
    expect(screen.getByText('この仕事は死んでいない')).toBeTruthy();
    expect(screen.getByText('何が起きたかの解釈まではしていない')).toBeTruthy();
  });

  it('失敗で終わった回の本文を「最後の報告」と呼ばない', async () => {
    renderDetail({
      ...BASE,
      status: 'done',
      lastFailure: FAILURE,
      lastReport: '（このターンは応答を返さずに終わった: billing_error / assistant_error）',
    });

    expect(await screen.findByText('待機中')).toBeTruthy();
    expect(screen.queryByText('最後の報告')).toBeNull();
    expect(screen.getByText('最後のターンの中身（報告ではない）')).toBeTruthy();
  });

  it('失敗していない回は「最後の報告」のままで、但し書きも出さない（雑音にしない）', async () => {
    renderDetail({ ...BASE, status: 'done', lastReport: 'スキーマまで書いた' });

    expect(await screen.findByText('待機中')).toBeTruthy();
    expect(screen.getByText('最後の報告')).toBeTruthy();
    expect(screen.queryByText(/報告ではなく失敗で終わっている/)).toBeNull();
    expect(screen.queryByText('⚠ 直近のターンは失敗で終わった')).toBeNull();
  });
});

describe('Issue #1882: 終端した委譲・畳まれたターンの回で「生きている」を言わない', () => {
  it('status: stopped + 古い lastFailure + lastFoldedTurn の回は、古い材料で「生きている」を言わない', async () => {
    renderDetail({
      ...BASE,
      status: 'stopped',
      lastFailure: { code: 'rate_limit', via: 'assistant_error', at: '2026-08-01T00:00:00.000Z' },
      lastReportAt: '2026-08-01T00:00:00.000Z',
      lastReportStatus: 'running',
      lastFoldedTurn: { text: '畳まれた本文', at: '2026-08-16T03:25:00.000Z' },
    });

    expect(await screen.findByText('停止済み')).toBeTruthy();
    expect(screen.queryByText(/セッションは生きているので/)).toBeNull();
    expect(screen.queryByText('この仕事は死んでいない')).toBeNull();
    expect(screen.queryByText(/いま走っているターンの中身ではない/)).toBeNull();
  });

  it('status: failed + lastFailure（lastFoldedTurn 無し）は、終端の言葉に置き換わる', async () => {
    renderDetail({
      ...BASE,
      status: 'failed',
      lastFailure: { code: 'rate_limit', via: 'assistant_error', at: '2026-08-20T10:00:00.000Z' },
    });

    expect(await screen.findByText('rate_limit')).toBeTruthy();
    expect(screen.queryByText(/セッションは生きているので/)).toBeNull();
    expect(screen.queryByText('この仕事は死んでいない')).toBeNull();
    expect(screen.getByText(/依頼者が望まない終わり方で既に終端している/)).toBeTruthy();
    expect(
      screen.getByText(/続けたいなら話しかけて resume を試みるしかなく、届く保証は無い/),
    ).toBeTruthy();
    expect(screen.queryByText(/自動では続かない/)).toBeNull();
  });

  it('status: lost + lastFailure（lastFoldedTurn 無し）も、終端の言葉に置き換わる', async () => {
    renderDetail({
      ...BASE,
      status: 'lost',
      lastFailure: { code: 'rate_limit', via: 'assistant_error', at: '2026-08-20T10:00:00.000Z' },
    });

    expect(await screen.findByText('rate_limit')).toBeTruthy();
    expect(screen.queryByText(/セッションは生きているので/)).toBeNull();
    expect(screen.getByText(/依頼者が望まない終わり方で既に終端している/)).toBeTruthy();
    expect(
      screen.getByText(/続けたいなら話しかけて resume を試みるしかなく、届く保証は無い/),
    ).toBeTruthy();
    expect(screen.queryByText(/自動では続かない/)).toBeNull();
  });

  it('status: stopped + lastFailure（lastFoldedTurn 無し）は、明示的に停止させた終端の言葉になる', async () => {
    renderDetail({
      ...BASE,
      status: 'stopped',
      lastFailure: { code: 'rate_limit', via: 'assistant_error', at: '2026-08-20T10:00:00.000Z' },
    });

    expect(await screen.findByText('rate_limit')).toBeTruthy();
    expect(screen.queryByText(/セッションは生きているので/)).toBeNull();
    expect(
      screen.getByText(/人間・クローンが明示的に停止させ、確かめたうえで既に終端している/),
    ).toBeTruthy();
    expect(
      screen.getByText(/続けたいなら話しかけて resume を試みるしかなく、届く保証は無い/),
    ).toBeTruthy();
    expect(screen.queryByText(/原因の有無にかかわらず/)).toBeNull();
  });

  it('生きている status（done）は今までどおり「生きている」を言う（既定は変えていない）', async () => {
    renderDetail({
      ...BASE,
      status: 'done',
      lastFailure: {
        code: 'billing_error',
        via: 'assistant_error',
        at: '2026-08-20T10:00:00.000Z',
      },
    });

    expect(await screen.findByText('待機中')).toBeTruthy();
    expect(screen.getByText('この仕事は死んでいない')).toBeTruthy();
    expect(screen.getByText(/セッションは生きているので/)).toBeTruthy();
    expect(
      screen.getByText(
        /。セッションは生きているので、原因が解ければ下の「話しかける」から続けられる（だから状態は/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/のままである）。/)).toBeTruthy();
  });
});

describe('詳細でも、`lastReport` は `lastFailure` の有無で描き方を分ける', () => {
  const FAILURE = { code: 'billing_error', via: 'assistant_error', at: '2026-08-20T10:00:00.000Z' };

  it('失敗回の本文は Markdown を通さない（*/#/** が化けず、改行と生の文字がそのまま出る）', async () => {
    renderDetail({
      ...BASE,
      status: 'done',
      lastFailure: FAILURE,
      lastReport:
        '（このターンは応答を返さずに終わった: billing_error / assistant_error）\n' +
        '# 見出しではない\n' +
        '*強調ではない* 文字\n\n' +
        '（失敗する前に出ていた本文）\n' +
        '**途中まで進めた**',
    });

    expect(await screen.findByText('最後のターンの中身（報告ではない）')).toBeTruthy();
    // マッチャー関数で取る: <pre> は1本のテキストノードで、findByText の完全一致では見えないため
    const pre = await screen.findByText((_content, node) => node?.tagName === 'PRE');
    expect(pre.textContent).toContain('# 見出しではない');
    expect(pre.textContent).toContain('*強調ではない* 文字');
    expect(pre.textContent).toContain('**途中まで進めた**');
    expect(screen.queryByRole('heading', { name: '見出しではない' })).toBeNull();
    expect(pre.querySelector('em, strong, h1, h2, h3')).toBeNull();
    const tokens = pre.className.split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
    expect(tokens).toContain('overflow-x-auto');
    expect(tokens).toContain('break-words');
  });

  it('実際の事故の形（monthly spend limit の生文言）が化けずそのまま出る', async () => {
    renderDetail({
      ...BASE,
      status: 'done',
      lastFailure: FAILURE,
      lastReport:
        '（このターンは応答を返さずに終わった: billing_error / assistant_error）\n' +
        "You've hit your org's monthly spend limit for the API. To keep going, **increase your limit** in the console.",
    });

    const body = await screen.findByText(/You've hit your org's monthly spend limit for the API\./);
    expect(body.textContent).toContain('**increase your limit**');
    expect(body.closest('strong')).toBeNull();
  });

  it('成功回（lastFailure 無し）は今日どおり Markdown で描く（既定は変えていないことの固定）', async () => {
    renderDetail({
      ...BASE,
      status: 'done',
      lastReport: '*強調される* はず',
    });

    expect(await screen.findByText('最後の報告')).toBeTruthy();
    const em = await screen.findByText('強調される');
    expect(em.tagName).toBe('EM');
  });
});

// 送信ボタンを live だけを理由に塞がない: session_id を持つ相手には resume で届き、塞ぐと人間が自分の言葉で繋ぎ直す唯一の手が消えるため
describe('詳細でも、`live` は繋がっていないことを文で言うが、送信は塞がない', () => {
  it('A: live: true では注記も送信欄の一行も出ず、送信は普通に通る', async () => {
    const { sent } = renderDetailWithMessages({ ...BASE, status: 'running', live: true });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('接続あり')).toBeTruthy();
    expect(screen.queryByText('セッション切断')).toBeNull();
    expect(screen.queryByText('引き取り（resume）の契機')).toBeNull();
    expect(screen.queryByText('送信は止めていない')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('追加の指示'), {
      target: { value: '続けて' },
    });
    const button = screen.getByRole('button', { name: '送る' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);

    expect(await screen.findByText('追加指示を届けた: 追加指示として届けた。')).toBeTruthy();
    expect(
      sent.some(
        (entry) => entry.url.endsWith('/managers/mgr-1/messages') && entry.method === 'POST',
      ),
    ).toBe(true);
  });

  it('B: live: false でも session_id がある相手には「届かず」と言わず、実際に送れる', async () => {
    const { sent } = renderDetailWithMessages({
      ...BASE,
      status: 'running',
      live: false,
      sessionId: 'sess-1',
    });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('セッション切断')).toBeTruthy();
    expect(screen.queryByText(/届かず/)).toBeNull();
    expect(screen.getByText('繋がっていない')).toBeTruthy();
    expect(screen.getByText('引き取り（resume）の契機')).toBeTruthy();
    expect(screen.getByText('戻れるとは限らない')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('追加の指示'), {
      target: { value: '続けて' },
    });
    const button = screen.getByRole('button', { name: '送る' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);

    expect(await screen.findByText('追加指示を届けた: 追加指示として届けた。')).toBeTruthy();
    expect(
      sent.some(
        (entry) => entry.url.endsWith('/managers/mgr-1/messages') && entry.method === 'POST',
      ),
    ).toBe(true);
  });

  it('C: session_id がある相手には、送信欄の側にも「送ると何が起きるか」の理由が出ている', async () => {
    // 独立した it にする: 無効化はしていないので、押せることを試す B だけでは理由の一行を消す変異を検知できないため
    renderDetail({ ...BASE, status: 'running', live: false, sessionId: 'sess-1' });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('送信は止めていない')).toBeTruthy();
    expect(screen.getByText('戻れなければ理由がここに出る。')).toBeTruthy();
  });

  it('D: session_id が無い相手だけはボタンが無効になり、理由と結びつき、⌘/Ctrl+Enter でも飛ばない', async () => {
    const { sent } = renderDetailWithMessages({
      ...BASE,
      status: 'running',
      live: false,
      sessionId: undefined,
    });

    expect(await screen.findByText('実行中')).toBeTruthy();

    const input = screen.getByPlaceholderText('追加の指示');
    // 必ず先に文字を入れる: 空欄のままでも text.trim() === '' で disabled になり、入力せずに見ると noWayBack を消す変異を捕まえられないため
    fireEvent.change(input, { target: { value: '続けて' } });

    const button = screen.getByRole('button', { name: '送る' });
    expect(button.hasAttribute('disabled')).toBe(true);

    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const reason = document.getElementById(describedBy as string);
    expect(reason).not.toBeNull();
    expect(reason?.textContent).toContain('送れない');
    expect(reason?.textContent).toContain('新しく起こし直すこと');

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(sent.length).toBe(0);

    fireEvent.click(button);
    expect(sent.length).toBe(0);
  });
});

describe('「話しかける」は Enter では送らず、⌘/Ctrl+Enter で1本だけ送る', () => {
  it('Enter 単体（Shift 付きも）では送らず、欄は textarea のまま', async () => {
    const { sent } = renderDetailWithMessages({ ...BASE, status: 'running', live: true });
    expect(await screen.findByText('実行中')).toBeTruthy();

    const input = screen.getByPlaceholderText('追加の指示');
    expect(input.tagName).toBe('TEXTAREA');
    fireEvent.change(input, { target: { value: 'つづけて' } });

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(sent.length).toBe(0);
    expect((input as HTMLTextAreaElement).value).toBe('つづけて');
  });

  it('変換中の ⌘/Ctrl+Enter では送らず、確定後の ⌘/Ctrl+Enter では1本だけ送る', async () => {
    const { sent } = renderDetailWithMessages({ ...BASE, status: 'running', live: true });
    expect(await screen.findByText('実行中')).toBeTruthy();

    const input = screen.getByPlaceholderText('追加の指示');
    fireEvent.change(input, { target: { value: 'つづけて' } });

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, keyCode: 229 });
    expect(sent.length).toBe(0);

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(await screen.findByText('追加指示を届けた: 追加指示として届けた。')).toBeTruthy();
    expect(sent.length).toBe(1);
  });

  it('送っている最中に ⌘/Ctrl+Enter を重ねても、届くのは1本だけ', async () => {
    const { sent } = renderDetailWithMessages({ ...BASE, status: 'running', live: true });
    expect(await screen.findByText('実行中')).toBeTruthy();

    const input = screen.getByPlaceholderText('追加の指示');
    fireEvent.change(input, { target: { value: '続けて' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });

    expect(await screen.findByText('追加指示を届けた: 追加指示として届けた。')).toBeTruthy();
    expect(sent.length).toBe(1);
  });
});

// ボタンが出ることだけを測らず DELETE が実際に飛んだことを method 込みで見る: 描画だけではボタンを描いたまま onClick を殺す変異が生き残るため
describe('停止は status で出し分けない', () => {
  async function stopWithConfirm() {
    fireEvent.click(await screen.findByRole('button', { name: '停止する' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '停止する' }));
  }

  // as const の配列や string[] へ緩めない: ManagerStatus に値が増えたらコンパイルで落とすためで、緩めると増えた状態が気づかれずに試験の外へ出る
  const EVERY_STATUS: Record<ManagerStatus, true> = {
    running: true,
    waiting_human: true,
    done: true,
    failed: true,
    lost: true,
    stopped: true,
  };
  const ALL_STATUSES = Object.keys(EVERY_STATUS) as ManagerStatus[];

  // stubFetch を使わない: DELETE と GET が同じ URL で、第2引数が常に undefined になり method が読めないため
  function renderDetailWithAbort(manager: ManagerSummary) {
    const sent: { url: string; method: string; body: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { url, method } = request;
      if (method === 'DELETE' && url.endsWith(`/managers/${manager.managerId}`)) {
        sent.push({ url, method, body: await request.text() });
        return json({ outcome: 'stopped', detail: '止めた。' });
      }
      if (url.includes(`/managers/${manager.managerId}`)) return json({ manager });
      throw new TypeError(`Failed to fetch: ${url}`);
    }) as typeof fetch;
    const router = createMemoryRouter(
      [
        { path: '/managers/:id', Component: () => <Harness id={manager.managerId} /> },
        { path: '/managers', Component: () => <p>マネージャー一覧</p> },
        { path: '/journal', Component: () => null },
      ],
      { initialEntries: [`/managers/${manager.managerId}`] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    return { sent };
  }

  // done だけを別の it にする: 落ちるテストの名前がそのまま欠陥の名前になるようにするため
  it('done（待機中）のマネージャーへ、停止の行為が届く', async () => {
    const { sent } = renderDetailWithAbort({ ...BASE, status: 'done' });

    expect(await screen.findByText('待機中')).toBeTruthy();

    const button = screen.getByRole('button', { name: '停止する' });
    expect(button.hasAttribute('disabled')).toBe(false);
    await stopWithConfirm();

    expect(await screen.findByText('マネージャー一覧')).toBeTruthy();
    expect(sent.length).toBe(1);
    expect(sent[0]?.method).toBe('DELETE');
    expect(sent[0]?.url.endsWith('/managers/mgr-1')).toBe(true);
    expect(sent[0]?.body).toContain('人間が画面から停止した');
  });

  it.each(ALL_STATUSES)('%s のマネージャーへも、停止の行為が届く', async (status) => {
    const { sent } = renderDetailWithAbort({ ...BASE, status });

    const button = await screen.findByRole('button', { name: '停止する' });
    expect(button.hasAttribute('disabled')).toBe(false);
    await stopWithConfirm();

    expect(await screen.findByText('マネージャー一覧')).toBeTruthy();
    expect(sent.map((entry) => entry.method)).toEqual(['DELETE']);
  });

  it('押しただけでは止まらず、確認で「やめる」なら止めずに閉じ、「停止する」で初めて DELETE が飛ぶ', async () => {
    const { sent } = renderDetailWithAbort({ ...BASE, status: 'done' });
    fireEvent.click(await screen.findByRole('button', { name: '停止する' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('待機中のセッションも畳まれます');
    expect(dialog.textContent).toContain('進行中の作業は失われ');
    expect(sent).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(sent).toHaveLength(0);
    expect(screen.queryByText('マネージャー一覧')).toBeNull();

    await stopWithConfirm();
    expect(await screen.findByText('マネージャー一覧')).toBeTruthy();
    expect(sent.map((entry) => entry.method)).toEqual(['DELETE']);
  });

  // ボタンを消さず理由で出す: 押せないなら隠すと、できないことと「この画面が扱っていないこと」を人間が区別できないため
  it('停止が失敗しても、ボタンは残り、理由が出る', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { url, method } = request;
      if (method === 'DELETE' && url.endsWith('/managers/mgr-1')) {
        return json({ error: 'mgr-1 というマネージャーは居ない。' }, 404);
      }
      if (url.includes('/managers/mgr-1')) return json({ manager: { ...BASE, status: 'done' } });
      throw new TypeError(`Failed to fetch: ${url}`);
    }) as typeof fetch;
    const router = createMemoryRouter(
      [
        { path: '/managers/:id', Component: () => <Harness id="mgr-1" /> },
        { path: '/managers', Component: () => <p>マネージャー一覧</p> },
        { path: '/journal', Component: () => null },
      ],
      { initialEntries: ['/managers/mgr-1'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    await stopWithConfirm();

    expect(await screen.findByText(/マネージャーは居ない/)).toBeTruthy();
    expect(screen.queryByText('マネージャー一覧')).toBeNull();
    expect(screen.getByRole('button', { name: '停止する' })).toBeTruthy();
  });
});

describe('折り返しの付け忘れ（本2）', () => {
  it('runnerId に break-all が付いている（cwd/sessionId/lease と同じ扱い）', async () => {
    renderDetail({ ...BASE, runnerId: 'runner-abcdefghijklmnop' });

    const dd = await screen.findByText('runner-abcdefghijklmnop');
    expect(dd.className.split(/\s+/)).toContain('break-all');
  });
});

describe('横並びの積み替え（本4-A）: 状態カードの dl', () => {
  it('狭い画面では1列、sm: 以上で固定幅ラベル列になる', async () => {
    renderDetail(BASE);

    const anchor = await screen.findByText('作業ディレクトリ');
    const dl = anchor.closest('dl');
    expect(dl).not.toBeNull();
    const dlTokens = dl!.className.split(/\s+/);
    expect(dlTokens).toContain('grid-cols-1');
    expect(dl!.style.getPropertyValue('--kv-label')).toBe('8rem');
    const smCols = dlTokens.filter((token) => token.startsWith('sm:grid-cols-'));
    expect(smCols).toHaveLength(1);
    expect(smCols[0]).toContain('var(--kv-label)');
    expect(dlTokens.filter((token) => /^grid-cols-/.test(token))).toEqual(['grid-cols-1']);
  });

  it('先頭以外の dt に上の余白と sm:mt-0 が付いている（積んだときの組の境目）', async () => {
    renderDetail(BASE);

    const anchor = await screen.findByText('作業ディレクトリ');
    const dl = anchor.closest('dl');
    expect(dl).not.toBeNull();
    const dts = Array.from(dl!.querySelectorAll('dt'));
    expect(dts.length).toBeGreaterThan(1);
    const first = dts[0]!.className.split(/\s+/);
    expect(first).not.toContain('mt-3');
    expect(first).not.toContain('sm:mt-0');
    for (const dt of dts.slice(1)) {
      const tokens = dt.className.split(/\s+/);
      expect(tokens).toContain('mt-3');
      expect(tokens).toContain('sm:mt-0');
    }
  });
});

describe('詳細でも、セッション不在と器の沈黙は状態を置き換えずに添える', () => {
  const MISSING = '2026-08-16T03:10:00.000Z';
  const LOST_SINCE = '2026-08-16T03:05:00.000Z';

  it('「接続あり」の札を残したまま、セッションが無いことを言う', async () => {
    renderDetail({ ...BASE, status: 'running', live: true, sessionMissingSince: MISSING });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('接続あり')).toBeTruthy();
    expect(screen.queryByText('セッション切断')).toBeNull();
    expect(screen.getByText(/runner がそう答えた。聞けなかったのではない/)).toBeTruthy();
  });

  it('「失われた」と言い切らない（完遂後に畳まれた回も同じ形に見える）', async () => {
    renderDetail({ ...BASE, status: 'running', live: true, sessionMissingSince: MISSING });

    expect(await screen.findByText(/この委譲が失われたという意味ではない/)).toBeTruthy();
    expect(
      screen.getByText(
        /完遂した後にセッションが畳まれ、終端の合図だけが届かなかった回も同じ形に見える/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/同じ仕事が2本になる/)).toBeTruthy();
  });

  it('欄が無ければ何も描かない（雑音にしない）', async () => {
    renderDetail({ ...BASE, status: 'running', live: true });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/この委譲のセッションを持っていなかった/)).toBeNull();
    expect(screen.queryByText(/名乗っていない/)).toBeNull();
  });

  it('由来（sessionMissingKind）も詳細側に出る', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      live: true,
      sessionMissingSince: MISSING,
      sessionMissingKind: 'resume-failed',
    });

    expect(await screen.findByText(/resume でも入り直せなかった/)).toBeTruthy();
  });

  it('器が黙ったときは、切断の注記と並べてその理由を名指しする', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      live: false,
      sessionId: 'sess-1',
      runnerLostSince: LOST_SINCE,
    });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('セッション切断')).toBeTruthy();
    expect(screen.getByText('繋がっていない')).toBeTruthy();
    expect(screen.getByText(/宛先の器は.*から名乗っていない/)).toBeTruthy();
    expect(screen.getByText(/黙っているのが器なのか経路なのかは、ここからは言えない/)).toBeTruthy();
    expect(screen.queryByText('セッションへ戻れず')).toBeNull();
  });

  it('注記が送信を否定せず、その下の送信ボタンも実際に有効なまま', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      live: false,
      sessionId: 'sess-1',
      runnerLostSince: LOST_SINCE,
    });

    expect(await screen.findByText(/宛先の器は.*から名乗っていない/)).toBeTruthy();
    expect(screen.queryByText(/いま話しかけられない/)).toBeNull();
    expect(screen.queryByText(/届かず/)).toBeNull();
    expect(screen.getByText(/話しかけることは塞いでいない/)).toBeTruthy();
    // 先に入力を埋める: 空欄のときは noWayBack と無関係に disabled で、埋めずに測ると戻る先が無いから塞がれていると取り違えるため
    fireEvent.change(screen.getByPlaceholderText('追加の指示'), {
      target: { value: '続けて' },
    });
    expect(screen.getByRole('button', { name: '送る' }).hasAttribute('disabled')).toBe(false);
  });

  it('2つの欄が同時に立ったら、注記は2本とも出る（片方が他方を消さない）', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      live: false,
      sessionId: 'sess-1',
      runnerLostSince: LOST_SINCE,
      sessionMissingSince: MISSING,
    });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText(/宛先の器は.*から名乗っていない/)).toBeTruthy();
    expect(screen.getByText(/この委譲のセッションを持っていなかった/)).toBeTruthy();
  });

  it('時刻は相対表示で、ISO をそのまま出さない', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      live: false,
      sessionId: 'sess-1',
      runnerLostSince: LOST_SINCE,
      sessionMissingSince: MISSING,
    });

    expect(await screen.findByText(/名乗っていない/)).toBeTruthy();
    expect(screen.queryByText(new RegExp(LOST_SINCE))).toBeNull();
    expect(screen.queryByText(new RegExp(MISSING))).toBeNull();
  });
});

describe('詳細でも、知らない status に倒れ先がある（#1623）', () => {
  it('知らない status でも詳細を描き、生の値を出す', async () => {
    renderDetail({ ...BASE, status: 'archived' as ManagerSummary['status'] });

    expect(await screen.findByText('知らない状態（archived）')).toBeTruthy();
  });
});

describe('診断（クローンの manager_list / manager_report と同じ材料。#1628 / #713）', () => {
  afterEach(() => {
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
  });

  it('材料が1つも無ければ「診断」カードごと出ない（0や空の行を作らない）', async () => {
    renderDetail({ ...BASE, status: 'running' });

    expect(await screen.findByText('PR を出して')).toBeTruthy();
    expect(screen.queryByText('診断')).toBeNull();
  });

  describe('lastReportStatus の drift（Issue #1036。`describeReportDrift` をクローンと共有）', () => {
    it('報告を書いた時点の status といまの status が食い違っていれば注記を出す', async () => {
      renderDetail({
        ...BASE,
        status: 'done',
        lastReportAt: '2026-08-16T03:10:00.000Z',
        lastReportStatus: 'running',
      });

      expect(await screen.findByText('診断')).toBeTruthy();
      expect(await screen.findByText(/いま走っているターンの中身ではない/)).toBeTruthy();
    });

    it('食い違っていなければ、この行は出ない（他に材料が無ければカードごと出ない）', async () => {
      renderDetail({
        ...BASE,
        status: 'done',
        lastReportAt: '2026-08-16T03:10:00.000Z',
        lastReportStatus: 'done',
      });

      expect(await screen.findByText('PR を出して')).toBeTruthy();
      expect(screen.queryByText(/いま走っているターンの中身ではない/)).toBeNull();
      expect(screen.queryByText('診断')).toBeNull();
    });
  });

  describe('lastUnreported（Issue #917）', () => {
    it('在れば理由と時刻を出す', async () => {
      renderDetail({
        ...BASE,
        status: 'done',
        lastUnreported: { reason: '器の入れ替えで畳まれた', at: '2026-08-16T03:20:00.000Z' },
      });

      expect(await screen.findByText(/result を受け取らないまま畳まれた/)).toBeTruthy();
      expect(screen.getByText(/器の入れ替えで畳まれた/)).toBeTruthy();
    });
  });

  describe('lastFoldedTurn（Issue #1038）', () => {
    it('本文を切り詰めずに全文出す（クローン向けの240字より長くても）', async () => {
      const longText = 'あ'.repeat(400);
      renderDetail({
        ...BASE,
        status: 'stopped',
        lastFoldedTurn: { text: longText, at: '2026-08-16T03:25:00.000Z' },
      });

      expect(await screen.findByText(/manager_stop で畳まれたターンの本文/)).toBeTruthy();
      expect(screen.getByText(longText)).toBeTruthy();
    });
  });

  describe('lastCgroupEvents（Issue #1517「最小の形」2）', () => {
    it('status が failed 以外なら、値があっても出ない', async () => {
      renderDetail({
        ...BASE,
        status: 'done',
        lastCgroupEvents: { pidsMaxDelta: 3, oomKillDelta: 0, at: '2026-08-16T03:30:00.000Z' },
      });

      expect(await screen.findByText('PR を出して')).toBeTruthy();
      expect(screen.queryByText(/pids 上限/)).toBeNull();
    });

    it('failed かつ値が無ければ「判定できなかった」と書く（0の行にしない）', async () => {
      renderDetail({ ...BASE, status: 'failed' });

      expect(
        await screen.findByText(
          /pids 上限による fork の拒否・OOM kill が起きたかは、この欄では判定できなかった/,
        ),
      ).toBeTruthy();
    });

    it('failed かつ値があれば、読めた分の数を出す', async () => {
      renderDetail({
        ...BASE,
        status: 'failed',
        lastCgroupEvents: { pidsMaxDelta: 3, oomKillDelta: 1, at: '2026-08-16T03:30:00.000Z' },
      });

      expect(await screen.findByText(/fork が pids 上限により 3 回断られた/)).toBeTruthy();
      expect(screen.getByText(/OOM kill が 1 回あった/)).toBeTruthy();
    });
  });

  describe('lastSystemError（#713 段3）', () => {
    it('status が failed 以外なら、値があっても出ない', async () => {
      renderDetail({
        ...BASE,
        status: 'done',
        lastSystemError: { code: 'EAGAIN', at: '2026-08-16T03:35:00.000Z' },
      });

      expect(await screen.findByText('PR を出して')).toBeTruthy();
      expect(screen.queryByText(/code=EAGAIN/)).toBeNull();
    });

    it('failed かつ値が無ければ「判定できなかった」と書く', async () => {
      renderDetail({ ...BASE, status: 'failed' });

      expect(
        await screen.findByText(/器の資源による落ち方かどうかは、この欄では判定できなかった/),
      ).toBeTruthy();
    });

    it('failed かつ値があれば code / errno / syscall をそのまま出す（言い換えない）', async () => {
      renderDetail({
        ...BASE,
        status: 'failed',
        lastSystemError: {
          code: 'EAGAIN',
          errno: -11,
          syscall: 'spawn',
          at: '2026-08-16T03:35:00.000Z',
        },
      });

      expect(await screen.findByText(/code=EAGAIN errno=-11 syscall=spawn/)).toBeTruthy();
    });
  });

  // 文字列リテラルを手で書き写さない: インポートした関数・定数の戻り値と画面の表示を突き合わせないと、手元でハードコードした文字列と偶然一致しているだけかが分からないため
  describe('診断欄の文言は core の軽い口と単一の定義元を共有する（PR #1645 の複製を解消）', () => {
    it('lastCgroupEvents: 値なしの注記が @alteroid/core/cgroup-events-format の定数そのものを含む', async () => {
      renderDetail({ ...BASE, status: 'failed' });

      await screen.findByText(/pids 上限/);
      expect(document.body.textContent ?? '').toContain(CGROUP_EVENTS_UNKNOWN_NOTE);
    });

    it('lastCgroupEvents: 値ありの注記が @alteroid/core/cgroup-events-format の整形関数の戻り値そのものを含む', async () => {
      const delta = { pidsMaxDelta: 3, oomKillDelta: 1, at: '2026-08-16T03:30:00.000Z' };
      renderDetail({ ...BASE, status: 'failed', lastCgroupEvents: delta });

      await screen.findByText(/fork が pids 上限により/);
      expect(document.body.textContent ?? '').toContain(formatCgroupEventsNote(delta));
    });

    it('lastSystemError: 値ありの事実整形が @alteroid/core/system-error-format の整形関数の戻り値そのものを含む', async () => {
      const systemError = {
        code: 'EAGAIN',
        errno: -11,
        syscall: 'spawn',
        at: '2026-08-16T03:35:00.000Z',
      };
      renderDetail({ ...BASE, status: 'failed', lastSystemError: systemError });

      await screen.findByText(/code=EAGAIN/);
      expect(document.body.textContent ?? '').toContain(formatSystemErrorFacts(systemError));
    });

    it('lastSystemError: 値なしの注記の共通部分が formatSystemErrorUnknownNote の戻り値そのものを含む（末尾の指し先はこの画面固有のまま）', async () => {
      renderDetail({ ...BASE, status: 'failed' });

      await screen.findByText(/器の資源による落ち方かどうかは、この欄では判定できなかった/);
      const expected = formatSystemErrorUnknownNote(
        '、上の「直近のターンは報告ではなく失敗で終わっている」の注記を見ること',
      );
      expect(document.body.textContent ?? '').toContain(expected);
    });
  });

  describe('resetTimeSkewMatch（Issue #914 オーナー提案(2)）', () => {
    it('stale なら世代ずれの疑いを出す', async () => {
      renderDetail({ ...BASE, status: 'running', resetTimeSkewMatch: 'stale' });

      expect(await screen.findByText(/認証トークンの世代ずれの疑い/)).toBeTruthy();
      expect(screen.getByText(/この印は枠\(利用上限\)で止まっている間だけ意味を持つ/)).toBeTruthy();
      expect(document.body.textContent).not.toContain('**');
    });

    it('stale の「起こし直すこと」に、止める前に確かめる案内と「会話だけではない」を添える（#1845）', async () => {
      renderDetail({ ...BASE, status: 'running', resetTimeSkewMatch: 'stale' });

      expect(await screen.findByText(/認証トークンの世代ずれの疑い/)).toBeTruthy();
      expect(
        screen.getByText(
          /止める前に、まず外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること/,
        ),
      ).toBeTruthy();
      expect(screen.getByText(/失われるのは会話だけではない/)).toBeTruthy();
      expect(document.body.textContent ?? '').not.toContain('会話は失われる');
      expect(screen.queryByText(/下の「未push観測」/)).toBeNull();
    });

    it('stale かつ未push観測が在るときだけ、それを見る案内を補助として添える（#1845 のレビュー指摘）', async () => {
      renderDetail({
        ...BASE,
        status: 'running',
        resetTimeSkewMatch: 'stale',
        lastUnpushedWorkObservation: {
          kind: 'observed',
          at: '2026-08-16T03:50:00.000Z',
          cwd: '/work/project',
          worktrees: [{ relativePath: '.', branch: 'feat/x' }],
        },
      });

      expect(await screen.findByText(/認証トークンの世代ずれの疑い/)).toBeTruthy();
      expect(
        screen.getByText(
          /止める前に、まず外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること/,
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(/下の「未push観測」にも最後の観測が出ている（いまの状態ではない）/),
      ).toBeTruthy();
      expect(screen.getByText(/branch=feat\/x/)).toBeTruthy();
    });

    it('active なら「待てば戻る」を出す', async () => {
      renderDetail({ ...BASE, status: 'running', resetTimeSkewMatch: 'active' });

      expect(await screen.findByText(/世代ずれではなく、待てば戻る/)).toBeTruthy();
    });

    it('知らない値でも落ちずに、その値をそのまま出す（#1623 / #1630 の流儀）', async () => {
      renderDetail({
        ...BASE,
        status: 'running',
        resetTimeSkewMatch: 'unknown-future-value' as ManagerSummary['resetTimeSkewMatch'],
      });

      expect(await screen.findByText(/この画面が知らない値 "unknown-future-value"/)).toBeTruthy();
    });
  });

  describe('toolUseStallAt / toolUseStallPending（Issue #572 / #2173）', () => {
    it('未応答の道具（AskUserQuestion）があり、返事待ちが空なら注記を出す', async () => {
      renderDetail({
        ...BASE,
        status: 'running',
        toolUseStallAt: '2026-08-16T03:40:00.000Z',
        toolUseStallPending: [{ id: 'tu-1', name: 'AskUserQuestion' }],
        waiting: [],
      });

      expect(
        await screen.findByText(/道具の応答待ちのまま、誰もその応答を待っていない/),
      ).toBeTruthy();
      expect(screen.getByText(/未応答の道具: AskUserQuestion\(tu-1\)/)).toBeTruthy();
    });

    it('未応答の道具が Bash（ふつうの道具）だけなら、返事待ちが空でも注記を出さない（Issue #2173）', async () => {
      renderDetail({
        ...BASE,
        status: 'running',
        toolUseStallAt: '2026-08-16T03:40:00.000Z',
        toolUseStallPending: [{ id: 'tu-1', name: 'Bash' }],
        waiting: [],
      });

      expect(await screen.findByText('PR を出して')).toBeTruthy();
      expect(screen.queryByText(/道具の応答待ちのまま、誰もその応答を待っていない/)).toBeNull();
    });

    it('デーモン側の返事待ちが在れば、正常な待ちなので出さない（矛盾ではない）', async () => {
      renderDetail({
        ...BASE,
        status: 'running',
        toolUseStallAt: '2026-08-16T03:40:00.000Z',
        toolUseStallPending: [{ id: 'tu-1', name: 'Bash' }],
        waiting: [{ requestId: 'req-1', summary: '許可しますか', kind: 'permission' }],
      });

      expect(await screen.findByText('許可しますか')).toBeTruthy();
      expect(screen.queryByText(/道具の応答待ちのまま、誰もその応答を待っていない/)).toBeNull();
    });
  });

  describe('lastUnpushedWorkObservation（Issue #1266）', () => {
    it('作業ツリー0本で探索の失敗も無い観測は「未push観測」の行を出さない（Issue #2970）', async () => {
      renderDetail({
        ...BASE,
        status: 'done',
        lastUnpushedWorkObservation: {
          kind: 'observed',
          at: '2026-08-16T03:50:00.000Z',
          cwd: '/work/project',
          worktrees: [],
        },
      });

      expect(await screen.findByText('待機中')).toBeTruthy();
      expect(screen.queryByText(/未push観測/)).toBeNull();
    });

    it('作業ツリー0本でも読み残しが在れば「未push観測」を出す（Issue #2970）', async () => {
      renderDetail({
        ...BASE,
        status: 'done',
        lastUnpushedWorkObservation: {
          kind: 'observed',
          at: '2026-08-16T03:50:00.000Z',
          cwd: '/work/project',
          worktrees: [],
          unreadableDirCount: 2,
        },
      });

      expect(await screen.findByText(/未push観測/)).toBeTruthy();
      expect(screen.getByText(/見つかった作業ツリー0本/)).toBeTruthy();
    });

    it('unavailable なら理由と時刻を出す', async () => {
      renderDetail({
        ...BASE,
        status: 'done',
        lastUnpushedWorkObservation: {
          kind: 'unavailable',
          at: '2026-08-16T03:45:00.000Z',
          reason: 'git が見つからなかった',
        },
      });

      expect(await screen.findByText(/未push観測/)).toBeTruthy();
      expect(screen.getByText(/取れなかった/)).toBeTruthy();
      expect(screen.getByText(/git が見つからなかった/)).toBeTruthy();
    });

    it('observed なら枝名を出し、remoteOrigin は maskUrl を通す（#1627 の流儀）', async () => {
      renderDetail({
        ...BASE,
        status: 'done',
        lastUnpushedWorkObservation: {
          kind: 'observed',
          at: '2026-08-16T03:50:00.000Z',
          cwd: '/work/project',
          worktrees: [
            {
              relativePath: '.',
              branch: 'feat/x',
              remoteOrigin: { host: 'github.com', path: '/o/r.git?token=SECRET' },
            },
          ],
        },
      });

      expect(await screen.findByText(/branch=feat\/x/)).toBeTruthy();
      expect(screen.queryByText(/SECRET/)).toBeNull();
      expect(screen.getByText(/origin=https:\/\/github\.com\/o\/r\.git\?\*\*\*/)).toBeTruthy();
    });

    it('observed かつ確かめきれなかった申告があるとき「探しきっていない」を出す（Issue #1885）', async () => {
      renderDetail({
        ...BASE,
        status: 'done',
        lastUnpushedWorkObservation: {
          kind: 'observed',
          at: '2026-08-16T03:50:00.000Z',
          cwd: '/work/project',
          worktrees: [{ relativePath: '.', branch: 'feat/x' }],
          truncatedAtCount: 200,
          unreadableDirCount: 2,
        },
      });

      expect(await screen.findByText(/branch=feat\/x/)).toBeTruthy();
      expect(screen.getByText(/この観測は探しきっていない/)).toBeTruthy();
      expect(screen.getByText(/件数の上限（200）で打ち切った/)).toBeTruthy();
    });

    it('observed かつ確かめきれなかった申告が無いとき「探しきっていない」を出さない（Issue #1885 の対照）', async () => {
      renderDetail({
        ...BASE,
        status: 'done',
        lastUnpushedWorkObservation: {
          kind: 'observed',
          at: '2026-08-16T03:50:00.000Z',
          cwd: '/work/project',
          worktrees: [{ relativePath: '.', branch: 'feat/x' }],
        },
      });

      expect(await screen.findByText(/branch=feat\/x/)).toBeTruthy();
      expect(screen.queryByText(/探しきっていない/)).toBeNull();
    });

    describe('器の入れ替えで応答不能（Issue #2457）', () => {
      const SWAPPED = '2026-08-16T04:00:00.000Z';
      const STALE_OBSERVED: NonNullable<ManagerSummary['lastUnpushedWorkObservation']> = {
        kind: 'observed',
        at: '2026-08-16T03:50:00.000Z',
        cwd: '/work/project',
        worktrees: [],
        source: 'report',
      };

      it('止まる直前の観測が届いていないとき、⚠ と「届いていない」を出し、古い観測を最新のように見せない', async () => {
        renderDetail({
          ...BASE,
          status: 'running',
          sessionMissingSince: SWAPPED,
          shutdownObservationArrivedAfterSwap: false,
          lastUnpushedWorkObservation: STALE_OBSERVED,
        });

        expect(
          await screen.findByText(/⚠ 未push観測: 器が止まる直前の観測は届いていない/),
        ).toBeTruthy();
        expect(screen.getByText(/未pushが無かったことを意味しない/)).toBeTruthy();
        expect(
          screen.getByText(/表示中の観測は .* 時点・ターンが report で終わったとき のもの/),
        ).toBeTruthy();
        expect(screen.queryByText(/器が止まる直前（/)).toBeNull();
      });

      it('shutdownObservationArrivedAfterSwap が無い（旧デーモン）ときも、届いたとは見なさない', async () => {
        renderDetail({
          ...BASE,
          status: 'running',
          sessionMissingSince: SWAPPED,
          lastUnpushedWorkObservation: STALE_OBSERVED,
        });

        expect(await screen.findByText(/器が止まる直前の観測は届いていない/)).toBeTruthy();
      });

      it('観測が一度も無いときも黙らず、「表示中の観測は無い」と言う', async () => {
        renderDetail({
          ...BASE,
          status: 'running',
          sessionMissingSince: SWAPPED,
          shutdownObservationArrivedAfterSwap: false,
        });

        expect(await screen.findByText(/器が止まる直前の観測は届いていない/)).toBeTruthy();
        expect(screen.getByText(/表示中の観測は無い（一度も取れていない）/)).toBeTruthy();
      });

      it('届いていない観測が unavailable のときも、理由を「表示中の観測」として添える', async () => {
        renderDetail({
          ...BASE,
          status: 'running',
          sessionMissingSince: SWAPPED,
          shutdownObservationArrivedAfterSwap: false,
          lastUnpushedWorkObservation: {
            kind: 'unavailable',
            at: '2026-08-16T03:50:00.000Z',
            reason: 'git が見つからなかった',
            source: 'report',
          },
        });

        expect(await screen.findByText(/器が止まる直前の観測は届いていない/)).toBeTruthy();
        expect(screen.getByText(/取れなかった: git が見つからなかった/)).toBeTruthy();
      });

      it('（対照）止まる直前の観測が届いているときは、今までどおり ⚠ なしで「器が止まる直前」の観測として出す', async () => {
        renderDetail({
          ...BASE,
          status: 'running',
          sessionMissingSince: SWAPPED,
          shutdownObservationArrivedAfterSwap: true,
          lastUnpushedWorkObservation: {
            kind: 'observed',
            at: '2026-08-16T03:59:00.000Z',
            cwd: '/work/project',
            worktrees: [{ relativePath: '.', branch: 'feat/x' }],
            source: 'shutdown',
          },
        });

        expect(await screen.findByText(/未push観測: 器が止まる直前（.*）の観測:/)).toBeTruthy();
        expect(screen.getByText(/branch=feat\/x/)).toBeTruthy();
        await waitFor(() => {
          expect(screen.queryByText(/届いていない/)).toBeNull();
        });
        expect(screen.queryByText(/⚠ 未push観測/)).toBeNull();
      });

      it('（対照）届いた観測が unavailable のときは、取れなかった理由を言う', async () => {
        renderDetail({
          ...BASE,
          status: 'running',
          sessionMissingSince: SWAPPED,
          shutdownObservationArrivedAfterSwap: true,
          lastUnpushedWorkObservation: {
            kind: 'unavailable',
            at: '2026-08-16T03:59:00.000Z',
            reason: 'git が見つからなかった',
            source: 'shutdown',
          },
        });

        expect(
          await screen.findByText(/に取ろうとしたが取れなかった: git が見つからなかった/),
        ).toBeTruthy();
        expect(screen.queryByText(/届いていない/)).toBeNull();
      });

      it('（対照）sessionMissingSince が無ければ、今までの「最後の1回」の書き方のまま', async () => {
        renderDetail({
          ...BASE,
          status: 'done',
          lastUnpushedWorkObservation: {
            ...STALE_OBSERVED,
            worktrees: [{ relativePath: '.', branch: 'feat/x' }],
          },
        });

        expect(
          await screen.findByText(/未push観測（最後の1回の経路: ターンが report で終わったとき/),
        ).toBeTruthy();
        expect(screen.queryByText(/届いていない/)).toBeNull();
      });
    });

    it('知らない kind でも落ちない（#1623 / #1630 の流儀）', async () => {
      renderDetail({
        ...BASE,
        status: 'done',
        lastUnpushedWorkObservation: {
          kind: 'not-yet-invented',
          at: '2026-08-16T03:55:00.000Z',
        } as unknown as ManagerSummary['lastUnpushedWorkObservation'],
      });

      expect(await screen.findByText(/この画面が知らない種類 "not-yet-invented"/)).toBeTruthy();
    });
  });

  it('狭い画面でも診断カードが崩れない（クラッシュせず、本文がそのまま読める）', async () => {
    setViewportWidth(375);
    renderDetail({
      ...BASE,
      status: 'failed',
      lastSystemError: { code: 'EAGAIN', at: '2026-08-16T03:35:00.000Z' },
      lastUnreported: { reason: '器の入れ替えで畳まれた', at: '2026-08-16T03:20:00.000Z' },
    });

    expect(await screen.findByText('診断')).toBeTruthy();
    expect(screen.getByText(/code=EAGAIN/)).toBeTruthy();
    expect(screen.getByText(/器の入れ替えで畳まれた/)).toBeTruthy();
  });

  it('画面の本文に `**` がそのまま出ない（クローン向け Markdown の写し残し無し）', async () => {
    renderDetail({
      ...BASE,
      status: 'failed',
      lastReportAt: '2026-08-16T03:10:00.000Z',
      lastReportStatus: 'running',
      lastUnreported: { reason: '器の入れ替えで畳まれた', at: '2026-08-16T03:20:00.000Z' },
      lastFoldedTurn: { text: '畳まれた本文', at: '2026-08-16T03:25:00.000Z' },
      lastCgroupEvents: { pidsMaxDelta: 3, oomKillDelta: 1, at: '2026-08-16T03:30:00.000Z' },
      lastSystemError: {
        code: 'EAGAIN',
        errno: -11,
        syscall: 'spawn',
        at: '2026-08-16T03:35:00.000Z',
      },
      resetTimeSkewMatch: 'stale',
      toolUseStallAt: '2026-08-16T03:40:00.000Z',
      toolUseStallPending: [{ id: 'tu-1', name: 'AskUserQuestion' }],
      waiting: [],
      lastUnpushedWorkObservation: {
        kind: 'observed',
        at: '2026-08-16T03:50:00.000Z',
        cwd: '/work/project',
        worktrees: [{ relativePath: '.', branch: 'feat/x' }],
      },
    });

    expect(await screen.findByText('診断')).toBeTruthy();
    expect(screen.getByText(/いま走っているターンの中身ではない/)).toBeTruthy();
    expect(screen.getByText(/器の入れ替えで畳まれた/)).toBeTruthy();
    expect(screen.getByText(/畳まれた本文/)).toBeTruthy();
    expect(screen.getByText(/fork が pids 上限により 3 回断られた/)).toBeTruthy();
    expect(screen.getByText(/code=EAGAIN errno=-11 syscall=spawn/)).toBeTruthy();
    expect(screen.getByText(/認証トークンの世代ずれの疑い/)).toBeTruthy();
    expect(screen.getByText(/道具の応答待ちのまま、誰もその応答を待っていない/)).toBeTruthy();
    expect(screen.getByText(/branch=feat\/x/)).toBeTruthy();

    expect(document.body.textContent).not.toContain('**');
  });
});

describe('詳細のマネージャー層の provider（撤去済み。2026-10-07 の決定）', () => {
  it('provider の欄を出さない（層は常に Claude）', async () => {
    renderDetail({ ...BASE, runnerId: 'runner-a' });
    expect(await screen.findByText('runner')).toBeTruthy();
    expect(screen.queryByText('provider')).toBeNull();
  });
});

describe('「話しかける」と待ちの行は、send の戻り値を使い手向けの言葉で出す（#3066）', () => {
  const askedAt = '2026-08-23T01:00:00.000Z';
  const RAW = ['answered', 'delivered', 'session_missing', 'unknown', 'unreadable', 'declined'];

  it.each([
    ['answered', '確認に答えた', false],
    ['delivered', '追加指示を届けた', false],
    ['session_missing', '届いていない', true],
    ['declined', '届けていない（世代が食い違う', true],
    ['unknown', '届いたか確かめられなかった', true],
    ['unreadable', '届けていない（台帳の行が読めない', true],
  ])('%s は日本語で出て、識別子は出ない（未達は警告色）', async (outcome, label, unreached) => {
    renderDetailWithMessages(
      { ...BASE, status: 'running', live: true },
      { outcome, detail: '詳細の文。' },
    );
    expect(await screen.findByText('実行中')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('追加の指示'), { target: { value: '続けて' } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));

    const note = await screen.findByText(new RegExp(`^(⚠ )?${label.replace(/[（]/g, '\\（')}`));
    expect(note.textContent).toContain('詳細の文。');
    for (const raw of RAW) expect(note.textContent).not.toContain(raw);
    expect(note.className.includes('text-warn')).toBe(unreached);
    expect(note.className.includes('text-muted-foreground')).toBe(!unreached);
  });

  it('届いていないときは入力欄を空にしない。届いたときは空にする', async () => {
    const { reply } = renderDetailWithMessages(
      { ...BASE, status: 'running', live: true },
      { outcome: 'session_missing', detail: '入り直せなかった。' },
    );
    expect(await screen.findByText('実行中')).toBeTruthy();
    const input = screen.getByPlaceholderText('追加の指示') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '書いた指示' } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    expect(await screen.findByText(/入り直せなかった。/)).toBeTruthy();
    expect(input.value).toBe('書いた指示');

    reply.body = { outcome: 'delivered', detail: '届いた。' };
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    expect(await screen.findByText(/追加指示を届けた: 届いた。/)).toBeTruthy();
    expect(input.value).toBe('');
  });

  it('知らない outcome は識別子を出さず、detail だけを未達の色で出す', async () => {
    renderDetailWithMessages(
      { ...BASE, status: 'running', live: true },
      { outcome: 'brand_new_value', detail: '新しい種類の結果。' },
    );
    expect(await screen.findByText('実行中')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('追加の指示'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    const note = await screen.findByText(/新しい種類の結果。/);
    expect(note.textContent).not.toContain('brand_new_value');
    expect(note.className.includes('text-warn')).toBe(true);
  });

  it('次の送信が失敗したら、前回の結果は消えてエラーだけが残る', async () => {
    const { reply } = renderDetailWithMessages({ ...BASE, status: 'running', live: true });
    expect(await screen.findByText('実行中')).toBeTruthy();
    const input = screen.getByPlaceholderText('追加の指示');
    fireEvent.change(input, { target: { value: '1通目' } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    expect(await screen.findByText(/追加指示を届けた/)).toBeTruthy();

    reply.status = 404;
    reply.body = { error: 'not found' };
    fireEvent.change(input, { target: { value: '2通目' } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    await waitFor(() => expect(screen.queryByText(/追加指示を届けた/)).toBeNull());
  });

  it('許可待ちの行は、未達の戻り値を警告として出す（届いたときは足さない）', async () => {
    const { reply } = renderDetailWithMessages(
      {
        ...BASE,
        status: 'waiting_human',
        waiting: [
          { requestId: 'req-p', summary: 'Bash の実行許可: ls', kind: 'permission', askedAt },
        ],
      },
      { outcome: 'session_missing', detail: '入り直せなかった。' },
    );
    expect(await screen.findByText('Bash の実行許可: ls')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '「Bash の実行許可: ls」を拒否' }));
    const note = await screen.findByText(/届いていない.*入り直せなかった。/);
    expect(note.className.includes('text-warn')).toBe(true);
    expect(note.textContent).not.toContain('session_missing');

    reply.body = { outcome: 'answered', detail: '解いた。' };
    fireEvent.click(screen.getByRole('button', { name: '「Bash の実行許可: ls」を許可' }));
    await waitFor(() => expect(screen.queryByText(/入り直せなかった。/)).toBeNull());
    expect(screen.queryByText(/確認に答えた/)).toBeNull();
  });

  it('質問の行は、未達なら書いた答えを残して警告を出し、届けば空にする', async () => {
    const { reply } = renderDetailWithMessages(
      {
        ...BASE,
        status: 'waiting_human',
        waiting: [
          { requestId: 'req-q', summary: 'DB はどちらにする？', kind: 'question', askedAt },
        ],
      },
      { outcome: 'declined', detail: '畳めなかった。' },
    );
    expect(await screen.findByText('DB はどちらにする？')).toBeTruthy();
    const textarea = screen.getByPlaceholderText(
      'この質問への答えを、自分の言葉で書く',
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'PostgreSQL' } });
    fireEvent.click(screen.getByRole('button', { name: '「DB はどちらにする？」へ答えを送信' }));
    const note = await screen.findByText(/届けていない.*畳めなかった。/);
    expect(note.className.includes('text-warn')).toBe(true);
    expect(textarea.value).toBe('PostgreSQL');

    reply.body = { outcome: 'answered', detail: '解いた。' };
    fireEvent.click(screen.getByRole('button', { name: '「DB はどちらにする？」へ答えを送信' }));
    await waitFor(() => expect(textarea.value).toBe(''));
    expect(screen.queryByText(/畳めなかった。/)).toBeNull();
  });

  it('質問の行は、⌘/Ctrl+Enter で送って未達だったとき、欄へフォーカスを戻す（#3301）', async () => {
    renderDetailWithMessages(
      {
        ...BASE,
        status: 'waiting_human',
        waiting: [
          { requestId: 'req-q', summary: 'DB はどちらにする？', kind: 'question', askedAt },
        ],
      },
      { outcome: 'declined', detail: '畳めなかった。' },
    );
    expect(await screen.findByText('DB はどちらにする？')).toBeTruthy();
    const textarea = screen.getByPlaceholderText(
      'この質問への答えを、自分の言葉で書く',
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'PostgreSQL' } });
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(textarea.disabled).toBe(true);
    // フォーカスを自分で外す: jsdom は disabled にしてもフォーカスを外さないが、ブラウザは外すため
    act(() => {
      textarea.disabled = false;
      textarea.blur();
      textarea.disabled = true;
    });
    expect(document.activeElement).toBe(document.body);
    await screen.findByText(/届けていない.*畳めなかった。/);
    await waitFor(() => expect(textarea.disabled).toBe(false));
    expect(document.activeElement).toBe(textarea);
  });
});
