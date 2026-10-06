// @vitest-environment jsdom
/**
 * 行き先の「いま居る画面」の印（`aria-current`）。
 *
 * サイドバーの1行はまとまり（仕事なら未了の仕事・作業の進捗）を代表する。
 * 「いま居る画面」は `NavLink` の前方一致ではなく `~/lib/nav` の `isNavItemActive` で決め、
 * `shell.tsx` の `NavItemLink` が `aria-current` を付ける。**まとまりのどのページに居ても、
 * 詳細の経路（`/managers/:id` など）に居ても、代表の1行がちょうど1つ選ばれる**ことを、
 * 結果（`aria-current`）の側で測る。
 *
 * 保証すること:
 * 1. `/chat` に居るとき、ホームのリンクに `aria-current` が付かない。会話のリンクには付く（印そのものが出ている）
 * 2. `/` に居るときは、ホームに `aria-current="page"` が付く
 *    （1 が「何も付けない」ことで緑になっていないこと）
 * 3. 下の表の全経路で、**選ばれる行がちょうど1つで、期待の行である**（まとまりの中の全ページと、
 *    詳細の経路を含む）。タブの定義から作った全経路も同じ行に落ちる（タブだけ増えてサイドバーで
 *    選ばれないページを作らない）
 * 4. 前方一致が単語の途中で当たらない（`/memoryfoo` は記憶とやり方ではない）
 */
import { cleanup, render, screen, within } from '@testing-library/react';
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

import { JOURNAL_TABS, MEMORY_TABS, SCHEDULE_TABS, SETTINGS_TABS, WORK_TABS } from '~/lib/nav';

import Shell from './shell';

const HEALTH = {
  ok: true,
  pid: 1,
  operator: true,
  storage: '/tmp/alteroid',
  auth: { enabled: false, providers: [] },
};

function renderShellAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Shell,
        children: [
          { index: true, Component: () => <div>ダッシュボードの中身</div> },
          { path: 'chat', Component: () => <div>会話の中身</div> },
          { path: '*', Component: () => <div>どこかの中身</div> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
  stubFetch((url, init) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.includes('/conversations/unread-count')) return json({ count: 0, capped: false });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.endsWith('/journal/stream')) return sse([], { keepOpen: true, signal: init?.signal });
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('行き先の選択中の印', () => {
  it('/chat に居るとき、ホームは選択中にならず、会話がなる', async () => {
    renderShellAt('/chat');

    expect(await screen.findByText('会話の中身')).toBeTruthy();
    const home = screen.getByRole('link', { name: 'ホーム' });
    const chat = screen.getByRole('link', { name: '会話' });
    expect(home.getAttribute('aria-current')).toBeNull();
    expect(chat.getAttribute('aria-current')).toBe('page');
  });

  it('/ に居るとき、ホームが選択中になる', async () => {
    renderShellAt('/');

    expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'ホーム' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: '会話' }).getAttribute('aria-current')).toBeNull();
  });
});

/** 選ばれている行（サイドバーの `aria-current="page"`）。 */
function currentItems(): string[] {
  return screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page')
    .map((link) => link.textContent ?? '');
}

const CASES: [string, string][] = [
  ['/', 'ホーム'],
  ['/chat', '会話'],
  ['/chat/conv-1', '会話'],
  ['/approvals', '承認待ち'],
  ['/commitments', '仕事'],
  ['/progress', '仕事'],
  ['/managers', 'マネージャー'],
  ['/managers/mgr-1', 'マネージャー'],
  ['/reports', '日報'],
  ['/reports/2026-08-14/r1', '日報'],
  ['/journal', '日誌'],
  ['/dropped', '日誌'],
  ['/archive', '日誌'],
  ['/archive/entry-1', '日誌'],
  ['/memory', '記憶とやり方'],
  ['/memory/some-slug', '記憶とやり方'],
  ['/practices', '記憶とやり方'],
  ['/practices/some-slug', '記憶とやり方'],
  ['/schedule', '予定と受信箱'],
  ['/inbox', '予定と受信箱'],
  ['/settings', '設定'],
  ['/usage', '設定'],
  ['/tokens', '設定'],
  ['/access', '設定'],
  ['/permissions', '設定'],
  ['/env-vars', '設定'],
  ['/profile', '設定'],
  ['/mcp-servers', '設定'],
];

describe('まとまりのどのページに居ても、代表の1行が選ばれる', () => {
  it.each(CASES)('%s では「%s」だけが選ばれる', async (path, label) => {
    renderShellAt(path);

    expect(await screen.findByText(/^(ダッシュボード|会話|どこか)の中身$/)).toBeTruthy();
    expect(currentItems()).toEqual([label]);
  });

  it('タブの定義から作った全経路も、それぞれ1行だけ選ばれる（サイドバーで選ばれないページを作らない）', async () => {
    const groups: [string, readonly { to: string }[]][] = [
      ['仕事', WORK_TABS],
      ['日誌', JOURNAL_TABS],
      ['記憶とやり方', MEMORY_TABS],
      ['予定と受信箱', SCHEDULE_TABS],
      ['設定', SETTINGS_TABS],
    ];
    for (const [label, tabs] of groups) {
      for (const tab of tabs) {
        cleanup();
        renderShellAt(tab.to);
        await screen.findByText(/^(ダッシュボード|会話|どこか)の中身$/);
        expect(currentItems(), tab.to).toEqual([label]);
      }
    }
  });

  it('前方一致は単語の途中で当たらない（/memoryfoo はどの行も選ばない）', async () => {
    renderShellAt('/memoryfoo');

    expect(await screen.findByText('どこかの中身')).toBeTruthy();
    expect(currentItems()).toEqual([]);
  });
});

describe('サイドバーのまとまり', () => {
  it('見出し（仕事・記録・クローンの中身）と、整理後の行き先が並ぶ。URL を消した行は無い', async () => {
    renderShellAt('/');

    await screen.findByText('ダッシュボードの中身');
    const nav = screen.getByRole('navigation');
    // 見出しは「そのまとまりの最初の行の直前」に1つずつ。「仕事」は行の名前と同じなので2つ。
    expect(within(nav).getAllByText('記録')).toHaveLength(1);
    expect(within(nav).getAllByText('クローンの中身')).toHaveLength(1);
    expect(within(nav).getAllByText('仕事')).toHaveLength(2);
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([
      '/',
      '/chat',
      '/approvals',
      '/commitments',
      '/managers',
      '/reports',
      '/journal',
      '/memory',
      '/schedule',
      '/settings',
    ]);
  });
});

describe('外枠が viewport ちょうどに収まる（body がスクロールしない）', () => {
  it.each([
    ['デスクトップ幅', DEFAULT_VIEWPORT_WIDTH],
    ['モバイル幅', 500],
  ])(
    '%s: 外枠は h-dvh と overflow-hidden を持ち、min-h では伸びない（クラス名の存在のみ）',
    async (_n, width) => {
      setViewportWidth(width);
      renderShellAt('/');

      const content = await screen.findByText('ダッシュボードの中身');
      const frame = content.closest('main')!.parentElement!;
      const classes = frame.className.split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(['h-dvh', 'overflow-hidden']));
      expect(classes.some((c) => c.startsWith('min-h-'))).toBe(false);
    },
  );
});
