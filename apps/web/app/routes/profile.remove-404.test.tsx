// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Profile from './profile';

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

function rowOf(name: string) {
  return {
    name,
    script: `export ${name.toUpperCase()}=1\n`,
    scope: 'all',
    updatedAt: '2026-09-20T00:00:00.000Z',
    sha256: name.padEnd(12, 'x'),
    bytes: 20,
  };
}

const UPDATED = {
  updatedAt: '2026-09-24T00:00:00.000Z',
  entries: [],
  composed: { clone: { sha256: 'e'.repeat(12) }, runner: { sha256: 'f'.repeat(12) } },
  clone: { ok: true, names: ['PATH'] },
  runners: [{ runnerId: 'runner-1', ok: true, names: ['PATH'] }],
};

// 共有の stubFetch を使わない: openapi-fetch は fetch(new Request(...)) の形で呼ぶので method も本文も落ちるため
// DELETE は、行を外した上で 404 を返す: CLI で先に外された状態（画面の一覧は古い）を作るため
function stubProfile(deleteStatus: 200 | 404) {
  let rows = [rowOf('alpha'), rowOf('beta')];
  const stale = [...rows];
  const gets = { count: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/profile')) throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'DELETE') {
      const name = decodeURIComponent(path.slice('/profile/'.length));
      rows = rows.filter((row) => row.name !== name);
      if (deleteStatus === 404) return json({ error: `プロファイルに行 ${name} は無い` }, 404);
      return json(UPDATED);
    }
    gets.count += 1;
    // 最初の1回だけ古い一覧を返す: 外された後の取り直しで初めて行が消えることを確かめるため
    const seen = gets.count === 1 ? stale : rows;
    return json({
      entries: seen,
      clone: { sha256: 'c'.repeat(12), bytes: 41 },
      runner: { sha256: 'd'.repeat(12), bytes: 77 },
      script: '',
    });
  }) as typeof fetch;
  return gets;
}

function mount() {
  const router = createMemoryRouter([{ path: '/', Component: Profile }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

async function removeRow(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `${name} の行を外す` }));
  fireEvent.click(screen.getByRole('button', { name: `${name} の行を本当に外す` }));
}

describe('プロファイルの行を外す: 既に外されていた（404）（#4067）', () => {
  it('「既に外されていた」と言い、一覧を取り直して行を消す（失敗の注記では終わらない）', async () => {
    const gets = stubProfile(404);
    mount();
    await removeRow('alpha');

    expect(await screen.findByText(/行 alpha は既に外されていた/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'alpha の行を外す' })).toBeNull(),
    );
    expect(gets.count).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'beta の行を外す' })).toBeTruthy();
  });

  it('外した行を開いている編集欄は閉じる（保存で蘇らせない）', async () => {
    stubProfile(404);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'alpha を編集する' }));
    expect(screen.getByLabelText('プロファイルの行の名前')).toBeTruthy();

    await removeRow('alpha');

    await waitFor(() => expect(screen.queryByLabelText('プロファイルの行の名前')).toBeNull());
  });

  it('別の行を開いている編集欄は閉じない', async () => {
    stubProfile(404);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'beta を編集する' }));

    await removeRow('alpha');

    expect(await screen.findByText(/行 alpha は既に外されていた/)).toBeTruthy();
    expect((screen.getByLabelText('プロファイルの行の名前') as HTMLInputElement).value).toBe(
      'beta',
    );
  });

  it('外せた（成功）ときも、その行を開いている編集欄は閉じる', async () => {
    stubProfile(200);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'alpha を編集する' }));

    await removeRow('alpha');

    expect(await screen.findByText(/プロファイルの行 alpha を外した。/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText('プロファイルの行の名前')).toBeNull());
  });
});
