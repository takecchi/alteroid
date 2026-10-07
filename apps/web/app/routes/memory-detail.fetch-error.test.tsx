// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemoryDocument } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/memory-detail';
import MemoryDetail, { clientLoader } from './memory-detail';

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

function stubMemory(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/memory/notes') return respond();
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function Harness() {
  const loaderData = clientLoader({ params: { slug: 'notes' } } as Route.ClientLoaderArgs);
  return <MemoryDetail {...({ loaderData } as Route.ComponentProps)} />;
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/memory/:slug', Component: Harness },
      { path: '/memory', Component: () => null },
    ],
    { initialEntries: ['/memory/notes'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const DOC: MemoryDocument = {
  slug: 'notes',
  title: 'notes',
  updatedAt: '2026-08-22T00:00:00.000Z',
  createdAt: { kind: 'unknown' },
  bytes: 42,
  frontmatter: { kind: 'none' },
  kind: 'fact',
  descriptionFreshness: { kind: 'absent' },
  content: '# 見出し\n\n本文だよ',
};

describe('記憶の取得に失敗したとき（issue #2319）', () => {
  it('サーバの失敗（500）: エラーだけを出し、編集欄と保存ボタンは出さない', async () => {
    stubMemory(() => json({ error: 'internal' }, 500));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /保存する|変更なし/ })).toBeNull();
  });

  it('通信の失敗: エラーだけを出し、編集欄と保存ボタンは出さない', async () => {
    stubMemory(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /保存する|変更なし/ })).toBeNull();
  });

  it('404（これから書く）なら、失敗とせず空の編集欄を出す', async () => {
    stubMemory(() => json({ error: 'not found' }, 404));
    renderPage();

    expect(await screen.findByRole('textbox')).toBeTruthy();
    expect(screen.getByRole('button', { name: /保存する|変更なし/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('再検証の失敗で本文が読めたまま残っているときは、編集欄を隠さない（失敗は注記で知らせる）', async () => {
    let calls = 0;
    stubMemory(() => {
      calls += 1;
      if (calls === 1) return json({ document: DOC });
      return json({ error: 'internal' }, 500);
    });
    renderPage();

    expect(await screen.findByText('本文だよ')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('本文だよ')).toBeTruthy();
    expect(screen.getByRole('button', { name: /保存する|変更なし/ })).toBeTruthy();
  });
});

describe('読めた後の取り直しが 404 になったとき（issue #3092）', () => {
  const V1 = 'a'.repeat(64);

  function stubGoneAfterRead() {
    const puts: unknown[] = [];
    let gone = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname !== '/memory/notes') {
        return Promise.reject(new TypeError(`Failed to fetch: ${request.url}`));
      }
      if (request.method === 'PUT') {
        puts.push(await request.json());
        return json({ error: '消えている', current: null }, 409);
      }
      return gone ? json({ error: 'not found' }, 404) : json({ document: DOC, version: V1 });
    }) as typeof fetch;
    return {
      puts,
      vanish: () => {
        gone = true;
      },
    };
  }

  it('本文と書きかけは残したまま、消された旨を言い、削除は出さない。保存は消された確認に当たる', async () => {
    const stub = stubGoneAfterRead();
    renderPage();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: '人間の書きかけ' } });
    expect(screen.getByRole('button', { name: '削除' })).toBeTruthy();

    stub.vanish();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(await screen.findByText(/別の手段で消された/)).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('人間の書きかけ');
    expect(screen.queryByRole('button', { name: '削除' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(stub.puts).toEqual([{ content: '人間の書きかけ', ifMatch: V1 }]));
    expect((await screen.findAllByText(/ほかで消された/)).length).toBeGreaterThan(0);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('人間の書きかけ');
  });
});
