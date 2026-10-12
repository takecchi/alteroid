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

const DOC: MemoryDocument = {
  slug: 'notes',
  title: 'notes',
  updatedAt: '2026-08-22T00:00:00.000Z',
  createdAt: { kind: 'unknown' },
  bytes: 42,
  frontmatter: { kind: 'none' },
  kind: 'fact',
  descriptionFreshness: { kind: 'absent' },
  content: '元の本文',
};

function Harness() {
  const loaderData = clientLoader({ params: { slug: 'notes' } } as Route.ClientLoaderArgs);
  return <MemoryDetail {...({ loaderData } as Route.ComponentProps)} />;
}

describe('書きかけの最中に、クローンが記憶を書き換えた後の削除（#4573）', () => {
  it('人間が読んだ版（v1）を前提に消す。見ていない版（v2）を前提にして黙って消さない', async () => {
    let doc = DOC;
    let version = 'v1';
    let v2Served = 0;
    const deletes: (string | null)[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // openapi-fetch は Request を渡すので、method は Request の側を見る
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.includes('/memory/notes'))
        throw new TypeError(`Failed to fetch: ${request.url}`);
      if (request.method === 'DELETE') {
        const ifMatch = new URL(request.url).searchParams.get('ifMatch');
        deletes.push(ifMatch);
        if (ifMatch !== version) {
          return json(
            {
              error: '記憶が読んだ後に変わっています（消していません）',
              current: { document: doc, version },
            },
            409,
          );
        }
        return json({ ok: true, slug: 'notes' });
      }
      if (version === 'v2') v2Served += 1;
      return json({ document: doc, version });
    }) as typeof fetch;

    const router = createMemoryRouter(
      [
        { path: '/memory/:slug', Component: Harness },
        { path: '/memory', Component: () => <p>一覧</p> },
      ],
      { initialEntries: ['/memory/notes'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    // 人間は v1 を読んで書き始める
    fireEvent.change(textarea, { target: { value: '人間の書きかけ' } });

    // クローンが書き換え（v2）、再取得が走る。v2 を返し終えるまで待つ（取り直しが済んでから押す）
    doc = { ...DOC, content: 'クローンが書いた新しい本文', updatedAt: '2026-08-22T02:00:00.000Z' };
    version = 'v2';
    fireEvent.focus(window);
    await waitFor(() => expect(v2Served).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });
    expect(textarea.value).toBe('人間の書きかけ');

    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));

    // 読んだ版 v1 を前提に消そうとするので 409 になり、消さずに「書き換えられた」と、いまの内容を出す
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toBe('v1');
    expect(await screen.findByText(/この記憶がほかで書き換えられた。消していない/)).toBeTruthy();
    expect(screen.getByText('クローンが書いた新しい本文')).toBeTruthy();
    // 書きかけは残る
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('人間の書きかけ');
  });
});
