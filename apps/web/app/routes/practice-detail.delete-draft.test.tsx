// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  const loaderData = clientLoader({ params: { slug: 'notes' } } as Route.ClientLoaderArgs);
  return <PracticeDetail {...({ loaderData } as Route.ComponentProps)} />;
}

const V1: Practice = {
  slug: 'notes',
  kind: '実装',
  title: '読んだ題',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
  chars: 6,
  content: '読んだ本文',
};

describe('書きかけの最中に、クローンがやり方を書き換えた後の削除（#4573）', () => {
  it('人間が読んだ版（v1）を前提に消す。見ていない版（v2）を前提にして黙って消さない', async () => {
    let practice = V1;
    let version = 'v1';
    let v2Served = 0;
    const deletes: (string | null)[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // openapi-fetch は Request を渡すので、method は Request の側を見る
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/practices/notes/versions') return json({ versions: [] });
      if (url.pathname !== '/practices/notes') throw new TypeError(`Failed to fetch: ${url.href}`);
      if (request.method === 'DELETE') {
        const ifMatch = url.searchParams.get('ifMatch');
        deletes.push(ifMatch);
        // 本物のデーモンと同じく、版が今と違えば 409 と current を返す
        if (ifMatch !== version) {
          return json(
            {
              error: 'やり方が読んだ後に変わっています（消していません）',
              current: { practice, version },
            },
            409,
          );
        }
        return json({ ok: true, slug: 'notes' });
      }
      if (version === 'v2') v2Served += 1;
      return json({ practice, version });
    }) as typeof fetch;

    const router = createMemoryRouter(
      [
        { path: '/practices/:slug', Component: Harness },
        { path: '/practices', Component: () => <p>一覧</p> },
      ],
      { initialEntries: ['/practices/notes'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const body = (await screen.findByLabelText('本文')) as HTMLTextAreaElement;
    // 人間は v1 を読んで書き始める
    fireEvent.change(body, { target: { value: '人間の書きかけ' } });

    // クローンが書き換え（v2）、取り直しが走る。v2 を返し終えるまで待つ
    practice = {
      ...V1,
      content: 'クローンが書いた新しい本文',
      updatedAt: '2026-08-22T02:00:00.000Z',
    };
    version = 'v2';
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(v2Served).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });
    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe('人間の書きかけ');

    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));

    // 読んだ版 v1 を前提に消そうとするので 409 になり、消さずに「書き換えられた」と出す
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toBe('v1');
    expect(await screen.findByText(/このやり方がほかで書き換えられた。消していない/)).toBeTruthy();
    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe('人間の書きかけ');

    // 知らせを見たうえで、もう一度消すと決めたら、知らせた版（v2）を前提に消して一覧へ戻る
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));
    await waitFor(() => expect(deletes).toHaveLength(2));
    expect(deletes[1]).toBe('v2');
    expect(await screen.findByText('一覧')).toBeTruthy();
  });

  it('対照: 書きかけが無ければ、取り直した最新の版（v2）を前提に消す', async () => {
    let version = 'v1';
    let v2Served = 0;
    const deletes: (string | null)[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/practices/notes/versions') return json({ versions: [] });
      if (url.pathname !== '/practices/notes') throw new TypeError(`Failed to fetch: ${url.href}`);
      if (request.method === 'DELETE') {
        const ifMatch = url.searchParams.get('ifMatch');
        deletes.push(ifMatch);
        if (ifMatch !== version) {
          return json({ error: '変わっています', current: { practice: V1, version } }, 409);
        }
        return json({ ok: true, slug: 'notes' });
      }
      if (version === 'v2') v2Served += 1;
      return json({ practice: V1, version });
    }) as typeof fetch;

    const router = createMemoryRouter(
      [
        { path: '/practices/:slug', Component: Harness },
        { path: '/practices', Component: () => <p>一覧</p> },
      ],
      { initialEntries: ['/practices/notes'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    await screen.findByRole('button', { name: '削除' });
    version = 'v2';
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(v2Served).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));
    await waitFor(() => expect(deletes).toEqual(['v2']));
    expect(await screen.findByText('一覧')).toBeTruthy();
  });

  it('⭐ 無いやり方に書きかけを打つ間にクローンが作ったら、削除は送らず、いまの内容を見せる（#4802）', async () => {
    let practice: Practice | null = null;
    let served = 0;
    const deletes: (string | null)[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/practices/notes/versions') return json({ versions: [] });
      if (url.pathname !== '/practices/notes') throw new TypeError(`Failed to fetch: ${url.href}`);
      if (request.method === 'DELETE') {
        const ifMatch = url.searchParams.get('ifMatch');
        deletes.push(ifMatch);
        if (ifMatch !== 'v1') {
          return json({ error: '変わっています', current: { practice, version: 'v1' } }, 409);
        }
        return json({ ok: true, slug: 'notes' });
      }
      if (practice === null) return json({ error: 'not found' }, 404);
      served += 1;
      return json({ practice, version: 'v1' });
    }) as typeof fetch;

    const router = createMemoryRouter(
      [
        { path: '/practices/:slug', Component: Harness },
        { path: '/practices', Component: () => <p>一覧</p> },
      ],
      { initialEntries: ['/practices/notes'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    const textarea = (await screen.findByLabelText('本文')) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '人間の書きかけ' } });

    practice = { ...V1, content: 'クローンが作った本文' };
    fireEvent.focus(window);
    await waitFor(() => expect(served).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));

    expect(await screen.findByText('クローンが作った本文')).toBeTruthy();
    expect(deletes).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));
    await waitFor(() => expect(deletes).toEqual(['v1']));
    expect(await screen.findByText('一覧')).toBeTruthy();
  });
});
