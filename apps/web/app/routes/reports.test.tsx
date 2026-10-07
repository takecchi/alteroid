// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_VIEWPORT_WIDTH,
  json,
  Providers,
  setViewportWidth,
  stubFetch,
  storeTestBaseUrl,
} from '~/test-support';

import Reports from './reports';

// 時間帯をテストの側で Asia/Tokyo に固定する: 器の時間帯に任せると CI（UTC）と手元（JST）で期待値が食い違うため
// vi.hoisted にする: process.env.TZ の変更は後から作られた Intl.DateTimeFormat にしか効かず、素の代入だと import が先に評価されて静かに効かなくなるため
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

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

const ReportsRoute = Reports as unknown as (props: {
  loaderData: { date: string | undefined; reportId: string | undefined };
}) => React.ReactElement;

function renderReports(loaderData: { date?: string; reportId?: string } = {}) {
  const router = createMemoryRouter(
    [
      {
        path: '/reports',
        Component: () => (
          <ReportsRoute loaderData={{ date: loaderData.date, reportId: loaderData.reportId }} />
        ),
      },
      { path: '/journal', Component: () => null },
      { path: '/schedule', Component: () => null },
    ],
    { initialEntries: ['/reports'] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

function renderReportsAtUrl(url: string) {
  function Routed() {
    const { date, reportId } = useParams();
    return <ReportsRoute loaderData={{ date, reportId }} />;
  }
  const router = createMemoryRouter(
    [
      { path: '/reports/:date?/:reportId?', Component: Routed },
      { path: '/journal', Component: () => null },
      { path: '/schedule', Component: () => null },
    ],
    { initialEntries: [url] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('日報', () => {
  it('最新の日報の本文が Markdown の描画経路を通って出る', async () => {
    stubFetch((url) => {
      if (url.endsWith('/reports') || url.includes('/reports?')) {
        return json({
          reports: [
            {
              type: 'daily_report',
              id: 'r1',
              at: '2026-08-14T22:00:00.000Z',
              date: '2026-08-14',
              body: '',
            },
          ],
        });
      }
      if (url.includes('/reports/2026-08-14')) {
        return json({
          reports: [
            {
              type: 'daily_report',
              id: 'r1',
              at: '2026-08-14T22:00:00.000Z',
              date: '2026-08-14',
              body: '## 今日やったこと\n\n進捗があった。',
            },
          ],
        });
      }
      return undefined;
    });

    renderReports();

    expect(await screen.findByRole('heading', { name: '今日やったこと' })).toBeTruthy();
    expect(screen.getByText('進捗があった。')).toBeTruthy();
  });

  it('日報が作れなかった日は、印として出す（本文を日報として描かない）', async () => {
    const reason = "You've hit your org's monthly spend limit · ask your admin to raise it";
    const entry = {
      type: 'daily_report',
      id: 'r2',
      at: '2026-08-20T22:00:00.000Z',
      date: '2026-08-20',
      // 見出し記法を混ぜる: Markdown の経路へ流れたら見出しになり、日報として描いていないことを区別できるため
      body: `## ${reason}`,
      unavailable: reason,
    };
    stubFetch((url) => {
      if (url.endsWith('/reports') || url.includes('/reports?')) return json({ reports: [entry] });
      if (url.includes('/reports/2026-08-20')) return json({ reports: [entry] });
      return undefined;
    });

    renderReports();

    expect(await screen.findByText('この日の日報は作れなかった')).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: reason })).toBeNull();
    expect(screen.getByRole('link', { name: '日誌' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'スケジュール' })).toBeTruthy();
  });

  it('日付の一覧でも、作れなかった日には印が付く', async () => {
    const reason = "You've hit your org's monthly spend limit";
    stubFetch((url) => {
      const reports = [
        {
          type: 'daily_report',
          id: 'r2',
          at: '2026-08-20T22:00:00.000Z',
          date: '2026-08-20',
          body: '（この日の日報は作れなかった）',
          unavailable: reason,
        },
        {
          type: 'daily_report',
          id: 'r1',
          at: '2026-08-19T22:00:00.000Z',
          date: '2026-08-19',
          body: '進捗があった。',
        },
      ];
      if (url.includes('/reports')) return json({ reports });
      return undefined;
    });

    renderReports();

    const marked = await screen.findByRole('link', { name: /2026-08-20/ });
    expect(marked.textContent).toContain('⚠');
    expect(screen.getByRole('link', { name: /2026-08-19/ }).textContent).not.toContain('⚠');
  });

  it('印が無い日には「作れなかった」と言わない（雑音にしない）', async () => {
    stubFetch((url) => {
      const reports = [
        {
          type: 'daily_report',
          id: 'r1',
          at: '2026-08-14T22:00:00.000Z',
          date: '2026-08-14',
          body: '進捗があった。',
        },
      ];
      if (url.includes('/reports')) return json({ reports });
      return undefined;
    });

    renderReports();

    expect(await screen.findByText('進捗があった。')).toBeTruthy();
    expect(screen.queryByText(/作れなかった/)).toBeNull();
  });

  // 期待値は古い順（date も at も昇順）のままにする: 日付でも書いた時刻でも並べ直した瞬間に落ち、片方だけの昇順だともう片方で並べ直す実装を取り逃すため
  it('一覧はデーモンが返した順のまま描く（画面で並べ直さない）', async () => {
    stubFetch((url) => {
      const reports = [
        {
          type: 'daily_report',
          id: 'r-old',
          at: '2026-08-19T22:00:00.000Z',
          date: '2026-08-19',
          body: '古い日付',
        },
        {
          type: 'daily_report',
          id: 'r-new',
          at: '2026-08-21T22:00:00.000Z',
          date: '2026-08-21',
          body: '新しい日付',
        },
      ];
      if (url.includes('/reports')) return json({ reports });
      return undefined;
    });

    renderReports();

    await screen.findAllByText('2026-08-19 の日報');
    const order = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href): href is string => href !== null && href.startsWith('/reports/'));
    expect(order).toEqual(['/reports/2026-08-19/r-old', '/reports/2026-08-21/r-new']);
  });

  const closeEntry = {
    type: 'daily_report',
    id: 'r-close',
    at: '2026-08-20T22:00:00.000Z',
    date: '2026-08-20',
    body: '## 締めの見出し\n\n締め本文だけの目印。',
  };
  const catchupEntry = {
    type: 'daily_report',
    id: 'r-catchup',
    at: '2026-08-21T00:30:00.000Z',
    date: '2026-08-20',
    body: '## 遡り生成の見出し\n\n遡り生成本文だけの目印。',
  };

  function stubSameDayReports() {
    const reports = [catchupEntry, closeEntry];
    return stubFetch((url) => {
      if (url.endsWith('/reports') || url.includes('/reports?')) return json({ reports });
      if (url.includes('/reports/2026-08-20')) return json({ reports });
      return undefined;
    });
  }

  // 見出しの文字列で引かない: 見出しは表示の結果で、href は id そのものを持ち、表示の整形が変わっても動かないため
  function rowFor(id: string): HTMLElement {
    const row = screen
      .getAllByRole('link')
      .find((link) => link.getAttribute('href') === `/reports/2026-08-20/${id}`);
    if (row === undefined) throw new Error(`一覧に ${id} の行が無い`);
    return row;
  }

  it('同じ日に2件あっても、一覧では時刻違いの別々の行として並ぶ', async () => {
    stubSameDayReports();

    renderReports();

    await screen.findAllByText('2026-08-20 の日報');

    const catchup = rowFor('r-catchup').textContent ?? '';
    const close = rowFor('r-close').textContent ?? '';
    expect(catchup).toContain('2026-08-20 の日報');
    expect(catchup).toContain('08/21 09:30 に書かれた');
    expect(close).toContain('2026-08-20 の日報');
    expect(close).toContain('08/21 07:00 に書かれた');
    expect(catchup).toContain('最新');
    expect(close).not.toContain('最新');
  });

  it('reportId で1件を指定すると、選択の見た目が付くリンクはちょうど1つになる', async () => {
    stubSameDayReports();

    renderReports({ date: '2026-08-20', reportId: 'r-close' });

    await screen.findAllByText('2026-08-20 の日報');

    // クラス名は token で見る: 部分一致だと全リンクが持つ hover:bg-muted などにも当たるため
    const selected = screen.getAllByRole('link').filter((link) => {
      const tokens = link.className.split(/\s+/);
      return tokens.includes('bg-accent');
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(rowFor('r-close'));
    const current = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current).toEqual([rowFor('r-close')]);
  });

  it('本文の見出しは画面の h1 と並ばず、h3 以下に下がる（#2780）', async () => {
    stubSameDayReports();

    renderReports({ date: '2026-08-20', reportId: 'r-close' });

    const heading = await screen.findByRole('heading', { name: '締めの見出し' });
    expect(heading.tagName).toBe('H4');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('本文の `#` も h1 にならない', async () => {
    stubFetch((url) => {
      const reports = [
        {
          type: 'daily_report',
          id: 'r1',
          at: '2026-08-14T22:00:00.000Z',
          date: '2026-08-14',
          body: '# 日報の題\n\n中身。',
        },
      ];
      if (url.includes('/reports')) return json({ reports });
      return undefined;
    });
    renderReports();
    const heading = await screen.findByRole('heading', { name: '日報の題' });
    expect(heading.tagName).toBe('H3');
  });

  it('本文にも選んだ1件だけが描かれ、同じ日のもう片方の本文は出ない', async () => {
    stubSameDayReports();

    renderReports({ date: '2026-08-20', reportId: 'r-close' });

    expect(await screen.findByText('締め本文だけの目印。')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '締めの見出し' })).toBeTruthy();
    expect(screen.queryByText('遡り生成本文だけの目印。')).toBeNull();
    expect(screen.queryByRole('heading', { name: '遡り生成の見出し' })).toBeNull();
  });

  it('広い画面では一覧（nav）と詳細が両方出て、一覧だけが独立にスクロールできる形になる', async () => {
    stubSameDayReports();

    renderReports({ date: '2026-08-20', reportId: 'r-close' });

    const nav = await screen.findByRole('navigation', { name: '日報の一覧' });
    expect(nav.className.split(/\s+/)).toContain('overflow-y-auto');
    expect(screen.getByRole('region', { name: '日報の一覧の詳細' })).toBeTruthy();
    expect(await screen.findByText('締め本文だけの目印。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '日報の一覧を開く' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: '2026-08-20 の日報' })).toBeTruthy();
  });

  describe('スマホ幅', () => {
    afterEach(() => {
      setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    });

    it('詳細が全幅で出て、「日報の一覧を開く」ボタンからドロワーに一覧が出る。選ぶと詳細が変わる', async () => {
      setViewportWidth(390);
      stubSameDayReports();

      renderReports({ date: '2026-08-20', reportId: 'r-close' });

      expect(await screen.findByText('締め本文だけの目印。')).toBeTruthy();
      expect(screen.queryByRole('navigation', { name: '日報の一覧' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: '日報の一覧を開く' }));
      const nav = await screen.findByRole('navigation', { name: '日報の一覧' });
      expect(within(nav).getAllByRole('link')).toHaveLength(2);
      const current = within(nav)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page');
      expect(current).toHaveLength(1);
      expect(current[0]?.getAttribute('href')).toBe('/reports/2026-08-20/r-close');
    });

    it('一覧が読み込めていない間や0件のときは、一覧を全幅で出す', async () => {
      setViewportWidth(390);
      stubFetch((url) => {
        if (url.includes('/reports')) return json({ reports: [] });
        return undefined;
      });

      renderReports();

      expect(await screen.findByText('まだ無い。')).toBeTruthy();
      expect(screen.queryByRole('button', { name: '日報の一覧を開く' })).toBeNull();
    });
  });

  it('URL で指定した日報を直接開ける（日付と id）', async () => {
    stubSameDayReports();

    renderReportsAtUrl('/reports/2026-08-20/r-catchup');

    expect(await screen.findByText('遡り生成本文だけの目印。')).toBeTruthy();
    expect(screen.queryByText('締め本文だけの目印。')).toBeNull();
    const current = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toEqual([rowFor('r-catchup')]);
  });

  it('指定が無ければ最新の日報が選ばれ、一覧でも選択中になる', async () => {
    stubSameDayReports();

    renderReports();

    expect(await screen.findByText('遡り生成本文だけの目印。')).toBeTruthy();
    expect(rowFor('r-catchup').getAttribute('aria-current')).toBe('page');
    expect(rowFor('r-close').getAttribute('aria-current')).toBeNull();
  });

  it('読み込み中は右側に「1件も無い」を出さない（#2803）', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    const reports = [
      {
        type: 'daily_report',
        id: 'r1',
        at: '2026-08-14T22:00:00.000Z',
        date: '2026-08-14',
        body: '進捗があった。',
      },
    ];
    stubFetch((url) => {
      if (url.includes('/reports')) {
        requested = true;
        return gate.then(() => json({ reports }));
      }
      return undefined;
    });

    renderReports();

    await waitFor(() => expect(requested).toBe(true));
    expect(screen.queryByText(/日報が1件も無い/)).toBeNull();
    expect(screen.queryByText('まだ無い。')).toBeNull();

    release();
    expect(await screen.findByText('進捗があった。')).toBeTruthy();
    expect(screen.queryByText(/日報が1件も無い/)).toBeNull();
  });

  it('日報が1件も無いときは、詳細側にその案内が出る', async () => {
    stubFetch((url) => {
      if (url.includes('/reports')) return json({ reports: [] });
      return undefined;
    });

    renderReports();

    const detail = await screen.findByRole('region', { name: '日報の一覧の詳細' });
    expect(within(detail).getByText(/日報が1件も無い/)).toBeTruthy();
  });

  function makeReports(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      type: 'daily_report' as const,
      id: `r-${index}`,
      at: `2026-06-${String(index + 1).padStart(2, '0')}T22:00:00.000Z`,
      date: `2026-06-${String(index + 1).padStart(2, '0')}`,
      body: `${index} 日目の進捗`,
    }));
  }

  it('返った件数が上限（60）ちょうどなら、これより古いかもしれないと言い、読み足すボタンを出す', async () => {
    const reports = makeReports(60);
    stubFetch((url) => {
      if (url.endsWith('/reports') || url.includes('/reports?')) return json({ reports });
      return undefined;
    });

    renderReports();

    expect(await screen.findByText(/これより古い日報があるかもしれない。/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'もっと古い日報を読む' })).toBeTruthy();
  });

  it('上限に達していなければ、その但し書きは出さない（雑音にしない）', async () => {
    const reports = makeReports(3);
    stubFetch((url) => {
      if (url.endsWith('/reports') || url.includes('/reports?')) return json({ reports });
      return undefined;
    });

    renderReports();

    await screen.findByText(/2026-06-03/);
    expect(screen.queryByText(/これより古い日報があるかもしれない/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'もっと古い日報を読む' })).toBeNull();
  });
});

describe('もっと古い日報を読む（#3464）', () => {
  function newestFirst(from: string, count: number, prefix: string) {
    const start = Date.parse(`${from}T00:00:00Z`);
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(start - index * 86_400_000).toISOString().slice(0, 10);
      return {
        type: 'daily_report' as const,
        id: `${prefix}-${index}`,
        at: `${date}T22:00:00.000Z`,
        date,
        body: `${prefix} ${index} の本文`,
      };
    });
  }
  const FULL = newestFirst('2026-09-30', 60, 'new');
  const last = FULL[59]!;

  function reportRows(): HTMLElement[] {
    return within(screen.getByRole('list', { name: '日報' })).getAllByRole('listitem');
  }

  function stubReports(older: (query: URLSearchParams) => Response) {
    const calls: string[] = [];
    stubFetch((url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/reports') {
        calls.push(url);
        return parsed.searchParams.has('beforeDate')
          ? older(parsed.searchParams)
          : json({ reports: FULL });
      }
      if (parsed.pathname.startsWith('/reports/')) return json({ reports: [FULL[0]] });
      return undefined;
    });
    return calls;
  }

  it('押すと最後の行の date と at を beforeDate / beforeAt に渡して続きを読み、後ろへ足す', async () => {
    const older = newestFirst('2026-08-01', 2, 'old');
    const calls = stubReports(() => json({ reports: older }));
    renderReports();

    fireEvent.click(await screen.findByRole('button', { name: 'もっと古い日報を読む' }));

    await screen.findByText('2026-07-31 の日報');
    const rows = reportRows();
    expect(rows).toHaveLength(62);
    expect(rows.slice(-2).map((row) => row.textContent)).toEqual([
      expect.stringContaining('2026-08-01 の日報'),
      expect.stringContaining('2026-07-31 の日報'),
    ]);
    const call = new URL(calls.find((href) => href.includes('beforeDate'))!);
    expect(call.searchParams.get('beforeDate')).toBe(last.date);
    expect(call.searchParams.get('beforeAt')).toBe(last.at);
    expect(call.searchParams.get('limit')).toBe('60');
    expect(screen.queryByRole('button', { name: 'もっと古い日報を読む' })).toBeNull();
  });

  it('limit ちょうど返れば、さらに続きを読める', async () => {
    stubReports(() => json({ reports: newestFirst('2026-08-01', 60, 'old') }));
    renderReports();

    fireEvent.click(await screen.findByRole('button', { name: 'もっと古い日報を読む' }));
    await waitFor(() => expect(reportRows()).toHaveLength(120));
    expect(screen.getByRole('button', { name: 'もっと古い日報を読む' })).toBeTruthy();
  });

  it('読み足しに失敗しても、それまでの一覧は残り、失敗だけを出す（押し直せる）', async () => {
    let attempt = 0;
    stubReports(() => {
      attempt += 1;
      return attempt === 1
        ? json({ error: 'internal' }, 500)
        : json({ reports: newestFirst('2026-08-01', 1, 'old') });
    });
    renderReports();

    fireEvent.click(await screen.findByRole('button', { name: 'もっと古い日報を読む' }));

    expect(await screen.findByText(/もっと古い日報を読み込めませんでした/)).toBeTruthy();
    expect(reportRows()).toHaveLength(60);
    expect(await screen.findByText('new 0 の本文')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'もっと古い日報を読む' }));
    await screen.findByText('2026-08-01 の日報');
    expect(reportRows()).toHaveLength(61);
    expect(screen.queryByText(/もっと古い日報を読み込めませんでした/)).toBeNull();
  });

  it('読み足した行も、押すとその日報の詳細へ行く', async () => {
    const older = newestFirst('2026-08-01', 1, 'old');
    stubReports(() => json({ reports: older }));
    renderReports();

    fireEvent.click(await screen.findByRole('button', { name: 'もっと古い日報を読む' }));
    await screen.findByText('2026-08-01 の日報');
    const link = within(reportRows().at(-1)!).getByRole('link');
    expect(link.getAttribute('href')).toBe('/reports/2026-08-01/old-0');
  });
});
