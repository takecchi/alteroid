// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_VIEWPORT_WIDTH,
  json,
  Providers,
  setViewportWidth,
  sse,
  stubFetch,
  storeTestBaseUrl,
} from '~/test-support';

import Shell from './shell';

const HEALTH = {
  ok: true,
  pid: 1,
  operator: true,
  storage: '/tmp/alteroid',
  auth: { enabled: false, providers: [] },
};

const NARROW_WIDTH = 375;

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Shell,
        children: [{ index: true, Component: () => <div>ダッシュボードの中身</div> }],
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

function stubAuthedShell(pendingApprovals: unknown[] = [], approvalsFail = false) {
  return stubFetch((url, init) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.includes('/conversations/unread-count')) return json({ count: 0, capped: false });
    if (url.includes('/approvals')) {
      return approvalsFail
        ? json({ error: 'internal' }, 500)
        : json({ approvals: pendingApprovals });
    }
    // /journal/stream も stubFetch に置く: 置かないと「繋がらない」→再接続を繰り返して試験が不安定になるため
    if (url.endsWith('/journal/stream')) return sse([], { keepOpen: true, signal: init?.signal });
    return undefined;
  });
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
  setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
});

describe('狭い画面（375px）', () => {
  it('行き先の一覧が最初から出ていない（本文の脇に挟まれない）', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell();

    renderShell();

    expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
    expect(screen.queryByText('ホーム')).toBeNull();
    expect(screen.queryByText('会話')).toBeNull();
    expect(screen.getByRole('button', { name: 'メニューを開く' })).toBeTruthy();
  });

  it('「メニューを開く」で出て、行き先を押すと閉じる（覆ったまま残らない）', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell();

    renderShell();
    await screen.findByText('ダッシュボードの中身');

    fireEvent.click(screen.getByRole('button', { name: 'メニューを開く' }));

    const dashboardLink = await screen.findByRole('link', { name: /ホーム/ });
    expect(screen.getByRole('dialog', { name: 'メニュー' })).toBeTruthy();

    fireEvent.click(dashboardLink);

    expect(screen.queryByRole('dialog', { name: 'メニュー' })).toBeNull();
    expect(screen.queryByRole('link', { name: /ホーム/ })).toBeNull();
  });
});

describe('狭い画面のドロワー', () => {
  it('広い画面と同じまとまり（見出し）と行き先が、ドロワーの中にも出る。現在地も同じ規則で示す', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell();

    renderShell();
    await screen.findByText('ダッシュボードの中身');
    fireEvent.click(screen.getByRole('button', { name: 'メニューを開く' }));

    const dialog = await screen.findByRole('dialog', { name: 'メニュー' });
    expect(within(dialog).getAllByText('記録')).toHaveLength(1);
    expect(within(dialog).getAllByText('クローンの中身')).toHaveLength(1);
    expect(
      within(dialog)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'ホーム',
      '会話',
      '承認待ち',
      '仕事',
      'マネージャー',
      '日報',
      '日誌',
      'ファイル',
      '記憶とやり方',
      '予定と受信箱',
      '設定',
    ]);
    expect(within(dialog).getByRole('link', { name: 'ホーム' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });
});

describe('広い画面（1280px）', () => {
  it('ハンバーガーが無く、行き先の一覧が最初から出ている（見た目を変えていない）', async () => {
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubAuthedShell();

    renderShell();

    expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
    expect(screen.getByRole('link', { name: /ホーム/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: '会話' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'メニューを開く' })).toBeNull();
  });
});

// フッターにサーバの記憶ディレクトリのパスとプロセス番号を出さない: 画面共有・スクリーンショットでサーバのファイル配置が漏れるため
describe('サイドバーのフッター', () => {
  it('記憶ディレクトリのパスとプロセス番号を出さず、接続状態だけを出す', async () => {
    const storage = '/tmp/mgr-secret/home';
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubFetch((url, init) => {
      if (url.includes('/conversations/unread-count')) return json({ count: 0, capped: false });
      if (url.endsWith('/health')) return json({ ...HEALTH, pid: 927, storage });
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.endsWith('/journal/stream')) return sse([], { keepOpen: true, signal: init?.signal });
      return undefined;
    });

    const { container } = renderShell();

    expect(await screen.findByText('接続中')).toBeTruthy();
    expect(container.textContent).not.toContain(storage);
    expect(container.textContent).not.toContain('pid');
    expect(container.textContent).not.toContain('927');
    expect(screen.queryByTitle(storage)).toBeNull();
  });
});

describe('承認待ちの見え方', () => {
  it('狭い画面でも、脇を畳んだまま件数が見える（人間を待っている仕事が消えない）', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell([{ id: 'a1', question: '本番に出してよいか' }]);

    renderShell();

    expect(await screen.findByRole('link', { name: '承認待ち 1 件' })).toBeTruthy();
  });

  it('0件のときは、狭い画面の上端に何も出ない（バッジ無し）', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell([]);

    renderShell();

    await screen.findByText('ダッシュボードの中身');
    expect(screen.queryByRole('link', { name: /承認待ち/ })).toBeNull();
  });
});

describe('/approvals が読めないとき（issue #2105）', () => {
  it('狭い画面の上端（MobileTopBar）に「読めていない」印が出る。リンク先は /approvals のまま', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell([], true);

    renderShell();

    const link = await screen.findByRole('link', { name: '承認待ちを読めていない' });
    expect(link.getAttribute('href')).toBe('/approvals');
    expect(screen.queryByRole('link', { name: /承認待ち \d+ 件/ })).toBeNull();
  });

  it('広い画面のナビにも「読めていない」印が出る（0件のバッジは出ない）', async () => {
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubAuthedShell([], true);

    renderShell();

    expect(await screen.findByTitle('承認待ちを読めていない')).toBeTruthy();
    expect(screen.getByLabelText('承認待ちを読めていない')).toBeTruthy();
  });

  it('広い画面で0件のときは、ナビに何も出ない（「読めていない」印と混ざらないことの対照）', async () => {
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubAuthedShell([]);

    renderShell();

    await screen.findByText('ダッシュボードの中身');
    expect(screen.queryByTitle('承認待ちを読めていない')).toBeNull();
    expect(screen.queryByLabelText('承認待ちを読めていない')).toBeNull();
  });

  it('広い画面で承認待ちが2件のときは、ナビに2のバッジが出て、「読めていない」印は出ない', async () => {
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubAuthedShell([
      { id: 'a1', question: '本番に出してよいか' },
      { id: 'a2', question: 'ロールバックしてよいか' },
    ]);

    renderShell();

    const link = await screen.findByRole('link', { name: /承認待ち/ });
    expect(link.textContent).toContain('2');
    expect(screen.queryByTitle('承認待ちを読めていない')).toBeNull();
    expect(screen.queryByLabelText('承認待ちを読めていない')).toBeNull();
  });
});

describe('上端の帯の横向き safe-area inset（本4）', () => {
  it('狭い画面の上端の帯（header）が pl / pr の safe-area クラスを持つ（クラス名の存在のみ）', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell();

    renderShell();
    await screen.findByText('ダッシュボードの中身');

    const header = screen.getByRole('banner');
    const classes = header.className.split(/\s+/);
    expect(classes).toContain('pl-[var(--safe-left)]');
    expect(classes).toContain('pr-[var(--safe-right)]');
    expect(classes).toContain('pt-[var(--safe-top)]');
  });
});

// 狭い画面の nav に pl-[var(--safe-left)] を足さない: Drawer の SheetContent が既に持っており、足すと二重に効くため
describe('nav の横向き safe-area inset（本4、差し戻し分）', () => {
  it('広い画面では nav（画面の左端）が pl-[var(--safe-left)] を持つ（クラス名の存在のみ）', async () => {
    setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
    stubAuthedShell();

    renderShell();
    await screen.findByText('ダッシュボードの中身');

    const nav = screen.getByRole('navigation');
    const classes = nav.className.split(/\s+/);
    expect(classes).toContain('pl-[var(--safe-left)]');
  });

  it('狭い画面（Drawer の中）では nav に pl-[var(--safe-left)] が付いていない（Drawer 側と二重にならないこと）', async () => {
    setViewportWidth(NARROW_WIDTH);
    stubAuthedShell();

    renderShell();
    await screen.findByText('ダッシュボードの中身');
    fireEvent.click(screen.getByRole('button', { name: 'メニューを開く' }));
    await screen.findByRole('dialog', { name: 'メニュー' });

    const nav = screen.getByRole('navigation');
    const classes = nav.className.split(/\s+/);
    expect(classes).not.toContain('pl-[var(--safe-left)]');
  });
});
