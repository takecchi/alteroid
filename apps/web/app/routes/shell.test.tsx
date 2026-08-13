// @vitest-environment jsdom
/**
 * 「繋がらない」から自力で復帰できること。
 *
 * 配る成果物の既定の接続先は同一オリジンの `/api` である。デーモンを別のホストに
 * 置いている人は**初回に必ずここで詰まる**ので、詰まった画面から接続先を直せないと
 * 設定画面へ永久に到達できない（設定画面は門の内側にいる）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch } from '~/test-support';

import Shell from './shell';

const HEALTH = {
  ok: true,
  pid: 1,
  operator: true,
  storage: '/tmp/alteroid',
  auth: { enabled: false, providers: [] },
};

const REMOTE = 'http://daemon.example';

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

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('接続できないとき', () => {
  it('その画面で接続先を直して復帰できる（設定画面へ行けないため）', async () => {
    // 既定の接続先（同一オリジンの `/api`）には誰も居ない。リモートだけが応答する。
    // ※ この実行環境では相対 URL の組み立て自体が失敗するが、人間から見えるものは
    //    同じ（繋がらない → 直す口が出る）なので、経路の分岐としてはこれで足りる。
    const stub = stubFetch((url) => (url.startsWith(REMOTE) ? json(HEALTH) : undefined));

    renderShell();

    // まず「繋がらない」と、直す口が同じ画面に出ている
    expect(await screen.findByText('デーモンに繋がらない')).toBeTruthy();
    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input).toBeTruthy();

    // 中身はまだ出ていない
    expect(screen.queryByText('ダッシュボードの中身')).toBeNull();

    // 別オリジンを保存する
    fireEvent.change(input, { target: { value: REMOTE } });
    fireEvent.click(screen.getByRole('button', { name: '適用' }));

    // 保存されたら自動で進む（人間が読み込み直さなくてよい）
    expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(REMOTE);
    expect(stub.calls.some((url) => url === `${REMOTE}/health`)).toBe(true);
  });

  it('誤った接続先を保存してしまっても、そこから直せる', async () => {
    // 画面から復旧できないと、localStorage を手で消すしかなくなる。
    localStorage.setItem('alteroid.apiBaseUrl', 'http://typo.example');
    stubFetch((url) => (url.startsWith(REMOTE) ? json(HEALTH) : undefined));

    renderShell();

    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input.value).toBe('http://typo.example');

    fireEvent.change(input, { target: { value: REMOTE } });
    fireEvent.click(screen.getByRole('button', { name: '適用' }));

    expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
  });

  it('「既定に戻す」で保存済みの値を消せる', async () => {
    localStorage.setItem('alteroid.apiBaseUrl', 'http://typo.example');
    stubFetch(() => undefined);

    renderShell();

    fireEvent.click(await screen.findByRole('button', { name: '既定に戻す' }));

    await waitFor(() => {
      expect(localStorage.getItem('alteroid.apiBaseUrl')).toBeNull();
    });
  });
});
