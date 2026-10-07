// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { JournalFeedProvider } from '@alteroid/swr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Archive from './archive';
import Commitments from './commitments';
import Dropped from './dropped';
import EnvVars from './env-vars';
import Journal from './journal';
import Managers from './managers';
import Memory from './memory';
import Practices from './practices';
import Schedule from './schedule';

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

type Mode = 'ok' | 'server' | 'network';

interface Case {
  name: string;
  Page: ComponentType;
  ok: Record<string, unknown>;
  title: string;
}

const CASES: Case[] = [
  {
    name: '/memory',
    Page: Memory,
    ok: { '/memory': { documents: [] } },
    title: '記憶の一覧を読み込めませんでした',
  },
  {
    name: '/practices',
    Page: Practices,
    ok: { '/practices': { practices: [] } },
    title: 'やり方の一覧を読み込めませんでした',
  },
  {
    name: '/schedule',
    Page: Schedule,
    ok: { '/schedule': { entries: [] } },
    title: 'スケジュールを読み込めませんでした',
  },
  {
    name: '/env-vars',
    Page: EnvVars,
    ok: { '/credentials': { credentials: [] } },
    title: '環境変数の一覧を読み込めませんでした',
  },
  {
    name: '/commitments',
    Page: Commitments,
    ok: { '/commitments': { entries: [] } },
    title: '未了の仕事の一覧を読み込めませんでした',
  },
  {
    name: '/managers',
    Page: Managers,
    ok: { '/managers': { managers: [] } },
    title: 'マネージャー一覧を読み込めませんでした',
  },
  {
    name: '/journal',
    Page: Journal,
    ok: { '/journal': { entries: [], next: null } },
    title: '日誌を読み込めませんでした',
  },
  {
    name: '/dropped',
    Page: Dropped,
    ok: {
      '/dropped': {
        origin: 'daemon',
        since: '2026-09-01T00:00:00.000Z',
        limit: 200,
        total: 0,
        traces: [],
      },
    },
    title: '失敗の一覧を読み込めませんでした',
  },
];

function stub(ok: Case['ok'], mode: () => Mode): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(url).pathname;
    if (!(pathname in ok)) return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    const current = mode();
    if (current === 'network') return Promise.reject(new TypeError('Failed to fetch'));
    if (current === 'server') return json({ error: 'boom' }, 500);
    return json(ok[pathname]);
  }) as typeof fetch;
}

function renderPage(Page: ComponentType) {
  const router = createMemoryRouter([{ path: '/', Component: Page }], { initialEntries: ['/'] });
  render(
    <Providers>
      <JournalFeedProvider value={{ status: 'live', recent: [] }}>
        <RouterProvider router={router} />
      </JournalFeedProvider>
    </Providers>,
  );
}

function visibleText(alert: HTMLElement): string {
  const copy = alert.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('details').forEach((node) => node.remove());
  return copy.textContent ?? '';
}

describe.each(CASES)('$name の読み込みの失敗', ({ Page, ok, title }) => {
  it.each([
    ['サーバーの失敗（500 boom）', 'server', 'boom', 'サーバの側で処理に失敗しました'],
    ['ネットワーク断', 'network', 'Failed to fetch', '接続先のサーバにつながっていません'],
  ] as const)('%s: 主文は日本語、生の文は「詳細」の中', async (_, mode, raw, summary) => {
    stub(ok, () => mode);
    renderPage(Page);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(title);
    expect(visibleText(alert)).toContain(summary);
    expect(visibleText(alert)).not.toContain(raw);
    const details = alert.querySelector('details');
    expect(details?.textContent).toContain(raw);
    expect(within(alert).getByRole('button', { name: 'もう一度試す' })).toBeTruthy();
  });

  it('「もう一度試す」で取り直し、正常に戻っていれば帯が消えて内容が出る', async () => {
    let mode: Mode = 'server';
    let reads = 0;
    stub(ok, () => {
      reads += 1;
      return mode;
    });
    renderPage(Page);
    const alert = await screen.findByRole('alert');
    const before = reads;

    mode = 'ok';
    fireEvent.click(within(alert).getByRole('button', { name: 'もう一度試す' }));

    await waitFor(() => expect(screen.queryByText(title)).toBeNull());
    expect(reads).toBeGreaterThan(before);
    expect(screen.queryByText(title)).toBeNull();
  });

  it('失敗したまま取り直しても、帯は出続ける', async () => {
    stub(ok, () => 'server');
    renderPage(Page);
    const alert = await screen.findByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: 'もう一度試す' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('alert')).getByRole('button', { name: 'もう一度試す' }),
      ).toBeTruthy(),
    );
    expect(screen.getByRole('alert').textContent).toContain(title);
  });
});

describe('/archive の読み込みの失敗', () => {
  it('一覧と集計のそれぞれが「何を」読めなかったかを言い、取り直せる', async () => {
    let mode: Mode = 'server';
    stub({ '/archive': { entries: [] }, '/archive/sessions': { sessions: [] } }, () => mode);
    renderPage(Archive);

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent).join('|')).toContain(
      '生ログの一覧を読み込めませんでした',
    );
    expect(alerts.map((alert) => alert.textContent).join('|')).toContain(
      '集計を読み込めませんでした',
    );

    mode = 'ok';
    for (const alert of alerts) {
      fireEvent.click(within(alert).getByRole('button', { name: 'もう一度試す' }));
    }
    await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0));
  });
});
