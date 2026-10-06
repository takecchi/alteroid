// @vitest-environment jsdom
/**
 * まとまりのタブの帯（`GroupTabs`）と、それを各ページが描いていること。
 *
 * 保証すること:
 * 1. 帯は定義（`~/lib/nav`）の順にリンクを並べ、いま居るページだけに `aria-current` が付く。
 *    詳細の経路（`/memory/:slug`）でも、その親のタブが選ばれる
 * 2. まとまりの**全ページ**が自分の帯を `<Page tabs={…}>` で描いている（ページを足して帯に
 *    入れ忘れる・帯に足してページが描き忘れる、を落とす）。レンダリングではなくソースの
 *    走査なのは、各ページの描画に要る通信の足場をここで全部組まないため——**帯が実際に出る**ことは
 *    1 と、各ページ自身のテスト（`Page` を描く）が持つ
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import {
  APPROVALS_TABS,
  JOURNAL_TABS,
  MEMORY_TABS,
  SCHEDULE_TABS,
  SETTINGS_TABS,
  WORK_TABS,
  type NavTab,
} from '~/lib/nav';

import {
  ApprovalsTabs,
  GroupTabs,
  JournalTabs,
  MemoryTabs,
  ScheduleTabs,
  SettingsTabs,
  WorkTabs,
} from './group-tabs';

afterEach(cleanup);

function renderAt(path: string, tabs: readonly NavTab[]) {
  const router = createMemoryRouter(
    [{ path: '*', Component: () => <GroupTabs label="試験のページ" tabs={tabs} /> }],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

describe('GroupTabs', () => {
  it('定義の順にリンクを並べ、いま居るページだけが選ばれる', () => {
    renderAt('/progress', WORK_TABS);

    const links = within(screen.getByRole('navigation', { name: '試験のページ' })).getAllByRole(
      'link',
    );
    expect(links.map((link) => link.getAttribute('href'))).toEqual(WORK_TABS.map((t) => t.to));
    expect(
      links.filter((l) => l.getAttribute('aria-current') === 'page').map((l) => l.textContent),
    ).toEqual(['作業の進捗']);
  });

  it('詳細の経路でも、その親のタブが選ばれる', () => {
    renderAt('/memory/some-slug', MEMORY_TABS);

    expect(screen.getByRole('link', { name: '記憶' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'やり方' }).getAttribute('aria-current')).toBeNull();
  });

  it('承認のタブ: 回答済みの配下（日付・1件）では「回答済み」だけが選ばれ、「未回答」は選ばれない（#3237）', () => {
    const current = () =>
      screen
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page')
        .map((link) => link.textContent);

    renderAt('/approvals', APPROVALS_TABS);
    expect(current()).toEqual(['未回答']);
    cleanup();
    renderAt('/approvals/answered', APPROVALS_TABS);
    expect(current()).toEqual(['回答済み']);
    cleanup();
    renderAt('/approvals/answered/2026-09-30/ap-1', APPROVALS_TABS);
    expect(current()).toEqual(['回答済み']);
  });

  it('設定のタブは9つ（利用状況・認証トークン・アクセス許可・許可・環境変数・プロファイル・MCP・連携を含む）', () => {
    renderAt('/usage', SETTINGS_TABS);

    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/settings',
      '/usage',
      '/tokens',
      '/access',
      '/permissions',
      '/env-vars',
      '/profile',
      '/mcp-servers',
      '/integrations',
    ]);
  });
});

describe('まとまりの全ページが自分の帯を描いている', () => {
  const routesDir = join(import.meta.dirname, '..', 'routes');
  const GROUPS: [string, readonly NavTab[]][] = [
    ['WorkTabs', WORK_TABS],
    ['JournalTabs', JOURNAL_TABS],
    ['MemoryTabs', MEMORY_TABS],
    ['ScheduleTabs', SCHEDULE_TABS],
    ['SettingsTabs', SETTINGS_TABS],
  ];

  it.each(GROUPS)('%s は、そのまとまりの全ページの Page に渡っている', (component, tabs) => {
    for (const tab of tabs) {
      const file = join(routesDir, `${tab.to.slice(1)}.tsx`);
      const source = readFileSync(file, 'utf8');
      expect(source, `${tab.to} のページ`).toContain(`tabs={<${component} />}`);
    }
  });

  it('承認の2ページ（未回答・回答済み）は、どちらも ApprovalsTabs を描く', () => {
    // 回答済みの経路は `/approvals/answered` で、他のまとまりのように `routes/<経路>.tsx` の名前に
    // ならない（`routes/approvals-answered.tsx`）ので、上の走査には入れず別に見る。
    for (const file of ['approvals.tsx', 'approvals-answered.tsx']) {
      expect(readFileSync(join(routesDir, file), 'utf8'), file).toContain(
        'tabs={<ApprovalsTabs />}',
      );
    }
  });

  it('帯の部品が、定義の配列を使っている（まとまり名の取り違えを落とす）', () => {
    // 5つの部品はそれぞれ別の配列を描く。**描く中身そのものを確かめる。**
    const cases: [() => React.JSX.Element, readonly NavTab[]][] = [
      [ApprovalsTabs, APPROVALS_TABS],
      [WorkTabs, WORK_TABS],
      [JournalTabs, JOURNAL_TABS],
      [MemoryTabs, MEMORY_TABS],
      [ScheduleTabs, SCHEDULE_TABS],
      [SettingsTabs, SETTINGS_TABS],
    ];
    for (const [Component, tabs] of cases) {
      cleanup();
      const router = createMemoryRouter([{ path: '*', Component }], { initialEntries: ['/'] });
      render(<RouterProvider router={router} />);
      expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(
        tabs.map((tab) => tab.to),
      );
    }
  });
});
