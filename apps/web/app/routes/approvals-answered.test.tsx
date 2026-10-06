// @vitest-environment jsdom
/**
 * 回答済みの承認のページ（`/approvals/answered/:date?/:approvalId?`。#3237）。
 *
 * ここで固定するのは:
 *
 * 1. 左の目次は「決着した日と件数」を、デーモンが返した順（新しい日が上）のまま出す
 * 2. 日付を開くと、その日の件を、デーモンが返した順（決着の新しい順）のまま出す（画面で並べ直さない）
 * 3. 行は行全体が1つのリンクで、どこを押しても詳細へ行ける。詳細から、その日の一覧へ戻れる
 * 4. 取り下げ済みも見える（札・時刻は withdrawnAt・理由）
 * 5. 取れなかったのを0件と描かない（目次・その日の件の両方）
 * 6. 日付の指定が無ければ最新の日を開く（日報と同じ）
 *
 * 時刻は閲覧者の端末の時間帯（`formatDateTime`）で出す。日付の区切りだけがデーモンの `localDate`。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDateTime } from '@alteroid/logic';
import type { PendingApproval } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import ApprovalsAnswered from './approvals-answered';

// 時刻の表示は端末の時間帯なので、期待値が器に依らないようにここで固定する（`reports.test.tsx` の
// 同じ節を見ること。`vi.hoisted` でなければ import の評価より後になって効かない）。
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
  /** 叩かれた URL（順番どおり）。 */
  calls: string[];
}

type Respond = () => Response | Promise<Response>;

/**
 * 目次（`/approvals/answered-dates`）とその日の件（`/approvals?answeredOn=`）を返す。
 * **日ごとの件は、渡した順のまま返す**（並べるのはデーモンの仕事。画面が並べ直さないことを測る）。
 */
function stubApi(options: {
  dates?: { date: string; count: number }[] | Respond;
  days?: Record<string, PendingApproval[] | Respond>;
  conversation?: (id: string) => Response | Promise<Response>;
}): Stub {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(href);
    const url = new URL(href);

    if (url.pathname === '/approvals/answered-dates') {
      const { dates = [] } = options;
      return typeof dates === 'function' ? dates() : json({ dates });
    }
    if (url.pathname === '/approvals') {
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

// framework mode の `loaderData` を URL から作る（`reports.test.tsx` の `renderReportsAtUrl` と同じやり方）。
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
      // 会話・委譲へのリンクの行き先。描くだけで踏まない。
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

/** 左の目次の行（日付と件数）。 */
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
    // 日付と件数が、返ってきた順（新しい日が上）に並ぶ。
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
    const dayCalls = stub.calls.filter((href) => new URL(href).pathname === '/approvals');
    expect(dayCalls.map((href) => new URL(href).searchParams.get('answeredOn'))).toEqual([
      '2026-09-30',
    ]);
  });

  it('その日の一覧を取るとき answeredOn だけを送る（pending=true・order・limit・cursor は付けない）', async () => {
    const stub = stubApi({ dates: DATES, days: { '2026-09-30': [NEWER] } });
    renderAt('/approvals/answered/2026-09-30');
    await screen.findByText('夜のリリースを待つか');

    const href = stub.calls.find((call) => new URL(call).pathname === '/approvals')!;
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

  it('日数が窓の大きさ（60）ちょうどなら、これより古い日があるかもしれないと言う', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 0, 60 - index)).toISOString().slice(0, 10),
      count: 1,
    }));
    stubApi({ dates: many });
    renderAt('/approvals/answered');
    expect(await screen.findByText(/直近 60 日のみ表示している/)).toBeTruthy();
  });
});

describe('その日の件', () => {
  it('デーモンが返した順のまま並べる（画面で並べ直さない）', async () => {
    // 古い方を先に返す。画面が決着日時で並べ直せば、順が入れ替わってここが落ちる。
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
    // 行の中に、さらに別のリンク・ボタンを入れない（入れ子の操作を作らない）。
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
    // 回答経路（`describeAnsweredVia`）
    expect(screen.getByText(/回答経路/)).toBeTruthy();
    // 別の件は出さない（その日の全部を縦に並べない）
    expect(screen.queryByText('朝の migrate を当てるか')).toBeNull();
    // 入力欄は出ない（回答済みは終端）
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
      // 目次は読めているので出ている
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
