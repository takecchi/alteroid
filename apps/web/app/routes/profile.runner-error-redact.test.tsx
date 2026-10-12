// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Profile from './profile';

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

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

const UPDATED = {
  updatedAt: '2026-09-24T00:00:00.000Z',
  entries: [
    {
      name: 'rust',
      scope: 'all',
      updatedAt: '2026-09-24T00:00:00.000Z',
      sha256: 'b'.repeat(12),
      bytes: 20,
    },
  ],
  composed: { clone: { sha256: 'e'.repeat(12) }, runner: { sha256: 'f'.repeat(12) } },
  clone: { ok: true, names: ['PATH'] },
  runners: [{ runnerId: 'runner-1', ok: true, names: ['PATH'] }],
};

function renderAndSave(put: { status: number; body: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';
    if (!new URL(url).pathname.startsWith('/profile')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    if (method === 'PUT') return json(put.body, put.status);
    return json({ entries: [], clone: {}, runner: {}, script: '' });
  }) as typeof fetch;

  const router = createMemoryRouter([{ path: '/profile', Component: Profile }], {
    initialEntries: ['/profile'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

async function save() {
  fireEvent.click(await screen.findByRole('button', { name: '行を追加する' }));
  fireEvent.change(screen.getByLabelText('プロファイルの行の名前'), { target: { value: 'rust' } });
  fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
    target: { value: 'export A=1\n' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存する' }));
  fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));
}

// CLI（profile.ts の report()）は失敗文と出力を redactError に通して出す。画面は素のまま出していた。
describe('/profile 画面は、失敗の理由と出力の本文の秘密を伏せる', () => {
  it('反映の失敗（outcome.error）に入った鍵を出さない', async () => {
    renderAndSave({
      status: 200,
      body: {
        ...UPDATED,
        runners: [{ runnerId: 'runner-2', ok: false, error: `push failed: GH_TOKEN=${TOKEN}` }],
      },
    });
    await save();

    await screen.findByText(/反映できなかった — /);
    expect(document.body.textContent).toContain('push failed');
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('反映の出力（outcome.output）に入った鍵を出さない', async () => {
    renderAndSave({
      status: 200,
      body: {
        ...UPDATED,
        runners: [
          { runnerId: 'runner-1', ok: true, output: `evaluating profile: GH_TOKEN=${TOKEN}` },
        ],
      },
    });
    await save();

    await screen.findByText(/evaluating profile/);
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('評価の失敗の詳細（failure.detail）に入った鍵を出さない', async () => {
    renderAndSave({
      status: 400,
      body: {
        error: 'プロファイルが読めなかったので保存していない',
        detail: `profile.sh: line 1: GH_TOKEN=${TOKEN}: syntax error`,
      },
    });
    await save();

    const detail = await screen.findByLabelText('評価の失敗の詳細');
    expect(detail.textContent).toContain('syntax error');
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
