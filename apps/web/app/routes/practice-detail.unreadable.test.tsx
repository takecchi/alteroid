// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Practice } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/practice-detail';
import PracticeDetail, { clientLoader } from './practice-detail';

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

function Harness() {
  const loaderData = clientLoader({ params: { slug: 'broken' } } as Route.ClientLoaderArgs);
  return <PracticeDetail {...({ loaderData } as Route.ComponentProps)} />;
}

const READABLE: Practice = {
  slug: 'broken',
  kind: '実装',
  title: '書き直した題',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
  chars: 6,
  content: '書き直した本文',
};

type Sent = { method: string; url: URL; body: unknown };

// 本物のデーモンと同じ形: 読めない行の GET は 409、PUT で書き直すと以後の GET は読める行を返す。DELETE は版なしで通る。
function stubDaemon(options: { get: 'unreadable' | 'server-error' }) {
  const sent: Sent[] = [];
  let rewritten = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method;
    if (url.pathname === '/practices/broken/versions') return json({ versions: [] });
    if (url.pathname === '/practices/broken') {
      if (method === 'GET') {
        if (rewritten) return json({ practice: READABLE, version: 'v1' });
        if (options.get === 'server-error') return json({ error: 'internal' }, 500);
        return json(
          {
            error:
              'やり方 broken は読めない形で入っている（消されたのではない）。本文はここでは取れない。',
          },
          409,
        );
      }
      if (method === 'PUT') {
        const body: unknown = await request.json();
        sent.push({ method, url, body });
        rewritten = true;
        return json({ practice: READABLE, version: 'v1' });
      }
      if (method === 'DELETE') {
        sent.push({ method, url, body: undefined });
        return json({ ok: true });
      }
    }
    if (url.pathname === '/practices') return json({ practices: [], unreadable: [] });
    return Promise.reject(new TypeError(`Failed to fetch: ${request.url}`));
  }) as typeof fetch;
  return sent;
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/practices/:slug', Component: Harness },
      { path: '/practices', Component: () => <p>やり方の一覧</p> },
    ],
    { initialEntries: ['/practices/broken'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('読めない形で入っているやり方（GET が 409。#4557）', () => {
  it('注記が出て、編集欄・保存・削除が残る', async () => {
    stubDaemon({ get: 'unreadable' });
    renderPage();

    expect(
      await screen.findByText(/読めない形で入っている.*書き直すと前の内容は残らない/),
    ).toBeTruthy();
    expect(((await screen.findByLabelText('種類')) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('題') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByRole('button', { name: /保存する|変更なし/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '削除' })).toBeTruthy();
  });

  it('書き直して保存すると、PUT は ifMatch のキーを持たず、通常の表示に戻る', async () => {
    const sent = stubDaemon({ get: 'unreadable' });
    renderPage();

    fireEvent.change(await screen.findByLabelText('種類'), { target: { value: '実装' } });
    fireEvent.change(screen.getByLabelText('題'), { target: { value: '書き直した題' } });
    fireEvent.change(screen.getByLabelText('本文'), { target: { value: '書き直した本文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]!.method).toBe('PUT');
    expect(sent[0]!.body).toEqual({
      kind: '実装',
      title: '書き直した題',
      content: '書き直した本文',
    });
    expect(Object.keys(sent[0]!.body as object)).not.toContain('ifMatch');

    // 取り直しで読めるようになり、注記は消える
    await waitFor(() => expect(screen.queryByText(/書き直すと前の内容は残らない/)).toBeNull());
    expect(await screen.findByText('書き直した本文')).toBeTruthy();
  });

  it('外すと、DELETE は版なし（クエリに ifMatch が無い）で出て、一覧へ戻る。確認の文面は中身が読めないまま消えると言う', async () => {
    const sent = stubDaemon({ get: 'unreadable' });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    expect(await screen.findByText(/中身は読めないまま消え/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));

    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]!.method).toBe('DELETE');
    expect(sent[0]!.url.searchParams.has('ifMatch')).toBe(false);
    expect(await screen.findByText('やり方の一覧')).toBeTruthy();
  });

  it('対照: 500 の取得失敗では、今までどおり編集欄も保存も削除も出ない', async () => {
    stubDaemon({ get: 'server-error' });
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryByRole('button', { name: /保存する|変更なし/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '削除' })).toBeNull();
    expect(screen.queryByText(/書き直すと前の内容は残らない/)).toBeNull();
  });
});
