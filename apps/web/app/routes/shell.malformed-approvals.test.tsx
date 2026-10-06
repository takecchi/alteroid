// @vitest-environment jsdom
/**
 * `GET /approvals` の応答が `approvals` の配列を持たない形のとき（版のずれ）の外枠。
 *
 * 測る保証は3つ — (1) 外枠が落ちない（ErrorBoundary に捕まらず、行き先の一覧が出る）
 * (2) 承認待ちは「読めていない」の札になる (3) 0件（札無し）として描かれない。
 * 型は `approvals` を配列と言っているので、ここが守るのは実行時の倒れ先だけである。
 */
import { cleanup, render, screen } from '@testing-library/react';
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

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Shell,
        // 外枠が落ちると、React Router 既定の ErrorBoundary がこれに代わって出る。
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

function stubApprovalsBody(body: unknown) {
  return stubFetch((url, init) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.includes('/conversations/unread-count')) return json({ count: 0, capped: false });
    if (url.includes('/approvals')) return json(body);
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

const MALFORMED: [string, unknown][] = [
  ['空のオブジェクト', {}],
  ['/health の形', HEALTH],
  ['approvals が配列でない', { approvals: 'x' }],
  ['approvals が null', { approvals: null }],
  ['本体が null', null],
];

describe('/approvals の応答が配列を持たない形のとき', () => {
  it.each(MALFORMED)(
    '広い画面: %s でも外枠が落ちず、「読めていない」札が出る',
    async (_n, body) => {
      setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
      stubApprovalsBody(body);

      renderShell();

      // (1) 外枠が落ちていない
      expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
      expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
      expect(screen.getByRole('link', { name: /ホーム/ })).toBeTruthy();
      // (2)(3) 0件（札無し）ではなく「読めていない」
      expect(await screen.findByLabelText('承認待ちを読めていない')).toBeTruthy();
      expect(screen.getByTitle('承認待ちを読めていない')).toBeTruthy();
    },
  );

  it('狭い画面: 上端の帯に「読めていない」印が出る（リンク先は /approvals）', async () => {
    setViewportWidth(375);
    stubApprovalsBody({});

    renderShell();

    expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
    const link = await screen.findByRole('link', { name: '承認待ちを読めていない' });
    expect(link.getAttribute('href')).toBe('/approvals');
  });
});

/**
 * 読めない行（`unreadable`）だけのとき、ナビは「承認待ちはない」に見えてはいけない（issue #3062）。
 * 読める行は0件でも、`/approvals` が言う「読めない承認待ちが N 件ある」を警告の札で言う。
 */
describe('読めない承認待ちだけのとき（#3062）', () => {
  const UNREADABLE = [{ id: 'ap-bad', reason: '不正な欄: createdAt' }, { reason: '不正な行' }];

  it('左ナビの「承認待ち」に警告の札が付く（読めない件数を言う）', async () => {
    stubApprovalsBody({ approvals: [], unreadable: UNREADABLE });

    renderShell();

    expect(await screen.findByLabelText('読めない承認待ちが 2 件ある')).toBeTruthy();
    // 「読めていない」（danger の ?）とは別。取れてはいる。
    expect(screen.queryByLabelText('承認待ちを読めていない')).toBeNull();
  });

  it('狭い画面: 上端の帯に出る（リンク先は /approvals）', async () => {
    setViewportWidth(375);
    stubApprovalsBody({ approvals: [], unreadable: UNREADABLE });

    renderShell();

    const link = await screen.findByRole('link', { name: /読めない承認待ちが 2 件ある/ });
    expect(link.getAttribute('href')).toBe('/approvals');
  });

  it('対照: 読めない行が無ければ札は付かない', async () => {
    stubApprovalsBody({ approvals: [] });

    renderShell();

    expect(await screen.findByRole('link', { name: /ホーム/ })).toBeTruthy();
    expect(screen.queryByLabelText(/読めない承認待ち/)).toBeNull();
  });
});
