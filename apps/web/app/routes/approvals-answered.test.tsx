// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDateTime } from '@alteroid/logic';
import type { PendingApproval } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import ApprovalsAnswered from './approvals-answered';

// vi.hoisted にする: import の評価より後だと TZ の固定が効かないため
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

function approval(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'a-1',
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    question: '本番に出してよいか',
    ...over,
  };
}

const NEWER = approval({
  id: 'a-new',
  question: '夜のリリースを待つか',
  answeredAt: '2026-09-30T10:00:00.000Z',
  answer: '待たない',
  answeredVia: { kind: 'operator', auth: 'operator-token' },
});
const OLDER = approval({
  id: 'a-old',
  question: '朝の migrate を当てるか',
  answeredAt: '2026-09-30T01:00:00.000Z',
  answer: '当てる',
});
const WITHDRAWN = approval({
  id: 'a-wd',
  question: '取り下げた確認',
  withdrawnAt: '2026-09-30T05:00:00.000Z',
  withdrawnReason: '自分で答えを見つけた',
});

interface Stub {
  calls: string[];
}

type Respond = () => Response | Promise<Response>;

function stubApi(options: {
  dates?: { date: string; count: number }[] | Respond;
  days?: Record<string, PendingApproval[] | Respond>;
  olderDates?: (beforeDate: string) => Response | Promise<Response>;
  pending?: object | Respond;
  conversation?: (id: string) => Response | Promise<Response>;
}): Stub {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(href);
    const url = new URL(href);

    if (url.pathname === '/approvals/answered-dates') {
      const before = url.searchParams.get('beforeDate');
      if (before !== null && options.olderDates !== undefined) return options.olderDates(before);
      const { dates = [] } = options;
      return typeof dates === 'function' ? dates() : json({ dates });
    }
    if (url.pathname === '/approvals') {
      if (url.searchParams.get('pending') === 'true') {
        const { pending = { approvals: [] } } = options;
        return typeof pending === 'function' ? (pending as Respond)() : json(pending);
      }
      const day = options.days?.[url.searchParams.get('answeredOn') ?? ''];
      if (typeof day === 'function') return day();
      return json({ approvals: day ?? [] });
    }
    if (url.pathname.startsWith('/conversations/') && options.conversation !== undefined) {
      return options.conversation(decodeURIComponent(url.pathname.slice('/conversations/'.length)));
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${href}`));
  }) as typeof fetch;
  return { calls };
}

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

const Page = ApprovalsAnswered as unknown as (props: {
  loaderData: { date: string | undefined; approvalId: string | undefined };
}) => React.ReactElement;

function renderAt(url: string) {
  function Routed() {
    const { date, approvalId } = useParams();
    return <Page loaderData={{ date, approvalId }} />;
  }
  const router = createMemoryRouter(
    [
      { path: '/approvals/answered/:date?/:approvalId?', Component: Routed },
      { path: '/chat/:id', Component: () => null },
      { path: '/managers/:id', Component: () => null },
    ],
    { initialEntries: [url] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

function dateRows(): HTMLElement[] {
  const list = screen.getByRole('list', { name: '決着した日' });
  return within(list).getAllByRole('listitem');
}

const DATES = [
  { date: '2026-09-30', count: 3 },
  { date: '2026-09-29', count: 1 },
];

describe('左の目次（決着した日と件数）', () => {
  it('デーモンが返した順（新しい日が上）に、日付と件数を出す', async () => {
    stubApi({ dates: DATES, days: { '2026-09-30': [NEWER, WITHDRAWN, OLDER] } });
    renderAt('/approvals/answered');

    await screen.findByText('2026-09-29');
    const rows = dateRows();
    expect(rows.map((row) => row.querySelector('span')?.textContent)).toEqual([
      '2026-09-30',
      '2026-09-29',
    ]);
    expect(rows.map((row) => within(row).getByText(/ 件$/).textContent)).toEqual(['3 件', '1 件']);
  });

  it('今開いている日が選択中（aria-current）になり、押すとその日の一覧へ行く', async () => {
    stubApi({ dates: DATES, days: { '2026-09-30': [NEWER], '2026-09-29': [OLDER] } });
    renderAt('/approvals/answered/2026-09-29');

    const current = await screen.findByRole('link', { name: /2026-09-29/ });
    expect(current.getAttribute('aria-current')).toBe('page');
    const other = screen.getByRole('link', { name: /2026-09-30/ });
    expect(other.getAttribute('aria-current')).toBeNull();
    expect(other.getAttribute('href')).toBe('/approvals/answered/2026-09-30');

    fireEvent.click(other);
    expect(await screen.findByText('夜のリリースを待つか')).toBeTruthy();
    expect(screen.getByRole('link', { name: /2026-09-30/ }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('日付の指定が無ければ最新の日（先頭）を開く', async () => {
    const stub = stubApi({ dates: DATES, days: { '2026-09-30': [NEWER], '2026-09-29': [OLDER] } });
    renderAt('/approvals/answered');

    expect(await screen.findByText('夜のリリースを待つか')).toBeTruthy();
    expect(
      (await screen.findByRole('link', { name: /2026-09-30/ })).getAttribute('aria-current'),
    ).toBe('page');
    const dayCalls = stub.calls.filter(
      (href) =>
        new URL(href).pathname === '/approvals' && new URL(href).searchParams.has('answeredOn'),
    );
    expect(dayCalls.map((href) => new URL(href).searchParams.get('answeredOn'))).toEqual([
      '2026-09-30',
    ]);
  });

  it('その日の一覧を取るとき answeredOn だけを送る（pending=true・order・limit・cursor は付けない）', async () => {
    const stub = stubApi({ dates: DATES, days: { '2026-09-30': [NEWER] } });
    renderAt('/approvals/answered/2026-09-30');
    await screen.findByText('夜のリリースを待つか');

    const href = stub.calls.find(
      (call) =>
        new URL(call).pathname === '/approvals' && new URL(call).searchParams.has('answeredOn'),
    )!;
    const params = new URL(href).searchParams;
    expect(params.get('answeredOn')).toBe('2026-09-30');
    for (const forbidden of ['pending', 'order', 'limit', 'cursor']) {
      expect(params.has(forbidden), forbidden).toBe(false);
    }
  });

  it('1件も決着していなければ「まだ無い」と、右に案内を出す', async () => {
    stubApi({ dates: [] });
    renderAt('/approvals/answered');

    expect(await screen.findByText('まだ無い。')).toBeTruthy();
    expect(screen.getByText('回答済みの承認はまだ無い。')).toBeTruthy();
  });
});

function daysBack(from: string, count: number): { date: string; count: number }[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(start - index * 86_400_000).toISOString().slice(0, 10),
    count: 1,
  }));
}

describe('もっと古い日を読む（#3297）', () => {
  const FULL = daysBack('2026-09-30', 60);
  const lastOfFull = FULL[59]!.date;

  it('窓ちょうどなら「もっと古い日を読む」を出し、押すと beforeDate で続きを読んで後ろへ足す', async () => {
    const older = [
      { date: '2026-06-01', count: 2 },
      { date: '2026-05-31', count: 1 },
    ];
    const stub = stubApi({
      dates: FULL,
      olderDates: (before) => {
        expect(before).toBe(lastOfFull);
        return json({ dates: older });
      },
    });
    renderAt('/approvals/answered');

    const more = await screen.findByRole('button', { name: 'もっと古い日を読む' });
    expect(dateRows()).toHaveLength(60);
    fireEvent.click(more);

    await screen.findByText('2026-05-31');
    const rows = dateRows();
    expect(rows).toHaveLength(62);
    expect(rows.slice(-2).map((row) => row.querySelector('span')?.textContent)).toEqual([
      '2026-06-01',
      '2026-05-31',
    ]);
    const call = stub.calls.find((href) => href.includes('beforeDate'))!;
    expect(new URL(call).searchParams.get('beforeDate')).toBe(lastOfFull);
    expect(new URL(call).searchParams.get('limit')).toBe('60');
    expect(screen.queryByRole('button', { name: 'もっと古い日を読む' })).toBeNull();
  });

  it('limit ちょうど返れば、さらに続きを読める', async () => {
    const second = daysBack('2026-06-01', 60);
    stubApi({
      dates: FULL,
      olderDates: (before) =>
        before === lastOfFull ? json({ dates: second }) : json({ dates: [] }),
    });
    renderAt('/approvals/answered');

    fireEvent.click(await screen.findByRole('button', { name: 'もっと古い日を読む' }));
    await waitFor(() => expect(dateRows()).toHaveLength(120));
    expect(screen.getByRole('button', { name: 'もっと古い日を読む' })).toBeTruthy();
  });

  it('limit 未満なら「もっと古い日を読む」を出さない', async () => {
    stubApi({ dates: daysBack('2026-09-30', 59) });
    renderAt('/approvals/answered');

    await screen.findByText('2026-09-30');
    expect(screen.queryByRole('button', { name: 'もっと古い日を読む' })).toBeNull();
  });

  it('読み足しに失敗しても、それまでの一覧は残り、失敗だけを出す（押し直せる）', async () => {
    let attempt = 0;
    stubApi({
      dates: FULL,
      olderDates: () => {
        attempt += 1;
        return attempt === 1
          ? json({ error: 'internal' }, 500)
          : json({ dates: [{ date: '2026-05-31', count: 1 }] });
      },
    });
    renderAt('/approvals/answered');

    fireEvent.click(await screen.findByRole('button', { name: 'もっと古い日を読む' }));

    expect(await screen.findByText(/もっと古い日を読み込めませんでした/)).toBeTruthy();
    expect(dateRows()).toHaveLength(60);
    expect(screen.getByRole('heading', { name: '2026-09-30 に決着した承認' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'もっと古い日を読む' }));
    await screen.findByText('2026-05-31');
    expect(dateRows()).toHaveLength(61);
    expect(screen.queryByText(/もっと古い日を読み込めませんでした/)).toBeNull();
  });

  it('読み込んだ範囲の外の日を URL で開くと、その日の件は出て、目次には載っていないと言う', async () => {
    stubApi({
      dates: DATES,
      days: { '2026-01-05': [OLDER] },
    });
    renderAt('/approvals/answered/2026-01-05');

    expect(await screen.findByText('朝の migrate を当てるか')).toBeTruthy();
    expect(
      screen.getByText(/開いている 2026-01-05 は、この目次に読み込んだ日の中に無い/),
    ).toBeTruthy();
    for (const row of dateRows()) {
      expect(within(row).getByRole('link').getAttribute('aria-current')).toBeNull();
    }
  });

  it('目次に載っている日を開いたときは、その注記を出さない', async () => {
    stubApi({ dates: DATES, days: { '2026-09-30': [NEWER] } });
    renderAt('/approvals/answered/2026-09-30');

    await screen.findByText('夜のリリースを待つか');
    expect(screen.queryByText(/この目次に読み込んだ日の中に無い/)).toBeNull();
  });
});

describe('読めない承認待ちの案内（#3297）', () => {
  const UNREADABLE = { approvals: [], unreadable: [{ id: 'bad-1' }, { id: null }] };

  it('読めない行があるときだけ、件数と未回答のページへのリンクを出す', async () => {
    stubApi({ dates: DATES, pending: UNREADABLE });
    renderAt('/approvals/answered');

    const note = await screen.findByText(/読めない承認待ちが 2 件ある/);
    const link = within(note.closest('[role="status"]') as HTMLElement).getByRole('link', {
      name: '未回答のページで見る',
    });
    expect(link.getAttribute('href')).toBe('/approvals');
  });

  it('読めない行が無ければ出さない（0 件とも言わない）', async () => {
    stubApi({ dates: DATES, pending: { approvals: [] } });
    renderAt('/approvals/answered');

    await screen.findByText('2026-09-29');
    await waitFor(() => expect(screen.queryByText(/読めない承認待ち/)).toBeNull());
    expect(screen.queryByText(/0 件ある/)).toBeNull();
  });

  it('unreadable が空配列でも出さない', async () => {
    stubApi({ dates: DATES, pending: { approvals: [], unreadable: [] } });
    renderAt('/approvals/answered');

    await screen.findByText('2026-09-29');
    expect(screen.queryByText(/読めない承認待ち/)).toBeNull();
  });

  it.each([
    ['サーバの失敗（500）', (() => json({ error: 'internal' }, 500)) as Respond],
    ['通信の失敗', (() => Promise.reject(new TypeError('Failed to fetch'))) as Respond],
  ])('未回答の側の取得が%s: 案内を出さない（0 件とも言わない）', async (_, fail) => {
    const stub = stubApi({ dates: DATES, pending: fail });
    renderAt('/approvals/answered');

    await screen.findByText('2026-09-29');
    await waitFor(() =>
      expect(stub.calls.some((href) => href.includes('pending=true'))).toBe(true),
    );
    expect(screen.queryByText(/読めない承認待ち/)).toBeNull();
  });

  it('unreadable が配列でない形違いの応答でも出さず、落ちない', async () => {
    stubApi({ dates: DATES, pending: { approvals: [], unreadable: 'oops' } });
    renderAt('/approvals/answered');

    await screen.findByText('2026-09-29');
    expect(screen.queryByText(/読めない承認待ち/)).toBeNull();
  });
});

describe('その日の件', () => {
  it('デーモンが返した順のまま並べる（画面で並べ直さない）', async () => {
    stubApi({ dates: DATES, days: { '2026-09-30': [OLDER, NEWER, WITHDRAWN] } });
    renderAt('/approvals/answered/2026-09-30');

    const list = await screen.findByRole('list', { name: '2026-09-30 に決着した承認' });
    const rows = within(list).getAllByRole('link');
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      '/approvals/answered/2026-09-30/a-old',
      '/approvals/answered/2026-09-30/a-new',
      '/approvals/answered/2026-09-30/a-wd',
    ]);
    expect(screen.getByText('3 件（決着の新しい順）')).toBeTruthy();
  });

  it('行は行全体が1つのリンクで、札・時刻・問い・答えがその中に入っている', async () => {
    stubApi({ dates: DATES, days: { '2026-09-30': [NEWER] } });
    renderAt('/approvals/answered/2026-09-30');

    const row = (await screen.findByText('夜のリリースを待つか')).closest('a')!;
    expect(row).not.toBeNull();
    expect(row.getAttribute('href')).toBe('/approvals/answered/2026-09-30/a-new');
    expect(row.textContent).toContain('回答済');
    expect(row.textContent).toContain(formatDateTime('2026-09-30T10:00:00.000Z'));
    expect(row.textContent).toContain('待たない');
    expect(within(row).queryAllByRole('link')).toHaveLength(0);
    expect(within(row).queryAllByRole('button')).toHaveLength(0);
  });

  it('行のどこを押しても詳細へ行く（時刻・札・問い・答えのどれを押しても）', async () => {
    for (const target of [
      () => screen.getByText('回答済'),
      () => screen.getByText(formatDateTime('2026-09-30T10:00:00.000Z')),
      () => screen.getByText('夜のリリースを待つか'),
      () => screen.getByText('待たない'),
    ]) {
      cleanup();
      stubApi({ dates: DATES, days: { '2026-09-30': [NEWER] } });
      const router = renderAt('/approvals/answered/2026-09-30');
      await screen.findByText('夜のリリースを待つか');

      fireEvent.click(target());

      await waitFor(() =>
        expect(router.state.location.pathname).toBe('/approvals/answered/2026-09-30/a-new'),
      );
    }
  });

  it('この日に決着した件が無ければ、その旨を出す（一覧が取れているときだけ）', async () => {
    stubApi({ dates: DATES, days: { '2026-09-30': [] } });
    renderAt('/approvals/answered/2026-09-30');
    expect(await screen.findByText('この日に決着した承認は無い。')).toBeTruthy();
  });
});

describe('詳細', () => {
  it('回答済みのカード（答え・回答経路）を出し、その日の一覧へ戻れる', async () => {
    stubApi({ dates: DATES, days: { '2026-09-30': [NEWER, OLDER] } });
    const router = renderAt('/approvals/answered/2026-09-30/a-new');

    expect(await screen.findByText('待たない')).toBeTruthy();
    expect(screen.getByText(/回答経路/)).toBeTruthy();
    expect(screen.queryByText('朝の migrate を当てるか')).toBeNull();
    expect(screen.queryByPlaceholderText(/答える/)).toBeNull();
    expect(screen.getByText(/決着したのは/)).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: /2026-09-30 の一覧へ/ }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/approvals/answered/2026-09-30'),
    );
    expect(await screen.findByText('朝の migrate を当てるか')).toBeTruthy();
  });

  it('答えの後の行動（trace）のボタンと、会話をチャットで開くリンクがある', async () => {
    stubApi({
      dates: DATES,
      days: {
        '2026-09-30': [{ ...NEWER, conversationId: 'conv-9', jobId: 'mgr-7' }],
      },
      conversation: () =>
        json({
          id: 'conv-9',
          messages: [
            { id: 'm1', role: 'outbound', text: 'クローンの発言', at: '2026-09-30T09:00:00Z' },
          ],
        }),
    });
    renderAt('/approvals/answered/2026-09-30/a-new');

    expect(await screen.findByRole('button', { name: '答えの後の行動を見る' })).toBeTruthy();
    const chat = await screen.findByRole('link', { name: /この会話をチャットで開く/ });
    expect(chat.getAttribute('href')).toBe('/chat/conv-9');
    expect(screen.getByRole('link', { name: '詳細を見る' }).getAttribute('href')).toBe(
      '/managers/mgr-7',
    );
  });

  it('指した件がその日に無ければ、日を名指しして一覧へ戻す導線を出す（別の件を黙って出さない）', async () => {
    stubApi({ dates: DATES, days: { '2026-09-30': [NEWER] } });
    renderAt('/approvals/answered/2026-09-30/a-nowhere');

    expect(
      await screen.findByText(/2026-09-30 に決着した承認の中に、この件は見つからない/),
    ).toBeTruthy();
    expect(screen.queryByText('夜のリリースを待つか')).toBeNull();
    expect(screen.getByRole('link', { name: /2026-09-30 の一覧へ/ })).toBeTruthy();
  });
});

describe('取り下げ済み', () => {
  it('一覧で取り下げ済の札・取り下げの時刻・理由が見え、回答済の札は付かない', async () => {
    stubApi({ dates: DATES, days: { '2026-09-30': [WITHDRAWN] } });
    renderAt('/approvals/answered/2026-09-30');

    const row = (await screen.findByText('取り下げた確認')).closest('a')!;
    expect(row.textContent).toContain('取り下げ済');
    expect(row.textContent).not.toContain('回答済');
    expect(row.textContent).toContain(formatDateTime('2026-09-30T05:00:00.000Z'));
    expect(row.textContent).toContain('自分で答えを見つけた');
  });

  it('詳細は取り下げ済みのカード（理由つき・入力欄なし）', async () => {
    stubApi({ dates: DATES, days: { '2026-09-30': [WITHDRAWN] } });
    renderAt('/approvals/answered/2026-09-30/a-wd');

    expect(await screen.findByText('自分で答えを見つけた')).toBeTruthy();
    expect(screen.getByText('取り下げた理由')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/答える/)).toBeNull();
    expect(screen.queryByRole('button', { name: '答えの後の行動を見る' })).toBeNull();
  });
});

describe('取れなかったのを0件と描かない', () => {
  const fail500: Respond = () => json({ error: 'internal' }, 500);
  const failNetwork: Respond = () => Promise.reject(new TypeError('Failed to fetch'));

  it.each([
    ['サーバの失敗（500）', fail500],
    ['通信の失敗', failNetwork],
  ])('目次の取得が%s: エラーは出し、「まだ無い」「承認はまだ無い」は出さない', async (_, fail) => {
    stubApi({ dates: fail });
    renderAt('/approvals/answered');

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('まだ無い。')).toBeNull();
    expect(screen.queryByText(/回答済みの承認はまだ無い/)).toBeNull();
  });

  it.each([
    ['サーバの失敗（500）', fail500],
    ['通信の失敗', failNetwork],
  ])(
    'その日の件の取得が%s: エラーは出し、「この日に決着した承認は無い」は出さない',
    async (_, fail) => {
      stubApi({ dates: DATES, days: { '2026-09-30': fail } });
      renderAt('/approvals/answered/2026-09-30');

      expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
      expect(screen.queryByText('この日に決着した承認は無い。')).toBeNull();
      expect(screen.queryByText(/0 件/)).toBeNull();
      expect(screen.getByRole('link', { name: /2026-09-30/ })).toBeTruthy();
    },
  );

  it('形の違う応答（dates / approvals が配列でない）も0件と描かず、読めていないと言う', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname === '/approvals/answered-dates') return json({ dates: 'oops' });
      return json({ approvals: 'oops' });
    }) as typeof fetch;
    renderAt('/approvals/answered/2026-09-30');

    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(screen.queryByText('まだ無い。')).toBeNull();
    expect(screen.queryByText('この日に決着した承認は無い。')).toBeNull();
  });
});

describe('枠', () => {
  it('「未回答 / 回答済み」のタブが見出し帯の外にあり、回答済みが選ばれている', async () => {
    stubApi({ dates: [] });
    renderAt('/approvals/answered');
    await screen.findByText('まだ無い。');

    const tabs = screen.getByRole('navigation', { name: '承認のページ' });
    expect(tabs.closest('header')).toBeNull();
    expect(within(tabs).getByRole('link', { name: '回答済み' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      within(tabs).getByRole('link', { name: '未回答' }).getAttribute('aria-current'),
    ).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).closest('header')).not.toBeNull();
  });
});

describe('「決着したのは …（N分前）」は分の時計で更新される（#3700）', () => {
  it('分が進むと「たった今」が「N分前」に変わる', async () => {
    const start = new Date('2026-10-07T12:00:00.000Z').getTime();
    vi.useFakeTimers({ now: start, toFake: ['setInterval', 'clearInterval', 'Date'] });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    try {
      const settled = approval({
        id: 'a-now',
        answeredAt: new Date(start).toISOString(),
        answer: 'はい',
        answeredVia: { kind: 'operator', auth: 'operator-token' },
      });
      stubApi({ dates: [{ date: '2026-10-07', count: 1 }], days: { '2026-10-07': [settled] } });
      renderAt('/approvals/answered/2026-10-07/a-now');
      for (let i = 0; i < 20; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
      }
      const line = () => screen.getByText(/決着したのは/).textContent;
      expect(line()).toContain('（たった今）');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3 * 60_000);
      });
      expect(line()).toContain('（3分前）');
    } finally {
      vi.useRealTimers();
    }
  });
});
