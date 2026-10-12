// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemoryDocument } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/memory-detail';
import MemoryDetail, { clientLoader } from './memory-detail';

const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

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

function Harness({ slug }: { slug: string }) {
  const loaderData = clientLoader({ params: { slug } } as Route.ClientLoaderArgs);
  return (
    <>
      <Link to="/memory">記憶</Link>
      <MemoryDetail {...({ loaderData } as Route.ComponentProps)} />
    </>
  );
}

const V1 = 'a'.repeat(64);
const V2 = 'b'.repeat(64);

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

const CLONE_DOC: MemoryDocument = {
  ...DOC,
  content: `クローンが書いた本文 GH_TOKEN=${KEY} 以上`,
  updatedAt: '2026-08-22T02:00:00.000Z',
};

function stubWith(respond: (request: Request) => Response | undefined) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/memory/notes')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${request.url}`));
    }
    return respond(request) ?? json({ document: DOC, version: V1 });
  }) as typeof fetch;
  const router = createMemoryRouter(
    [
      { path: '/memory/:slug', Component: () => <Harness slug="notes" /> },
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

describe('/memory/:slug — 衝突表示の本文は鍵を伏せる', () => {
  it('保存の 409 で見せる「いまの内容」に鍵が出ず、地の文は残る。編集欄の下書きは生のまま', async () => {
    stubWith((request) =>
      request.method === 'PUT'
        ? json(
            {
              error: '記憶が読んだ後に変わっています（書き換えていません）',
              current: { document: CLONE_DOC, version: V2 },
            },
            409,
          )
        : undefined,
    );

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '人間の書きかけ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('クローンが書いた本文');
    expect(alert.textContent).toContain('以上');
    expect(alert.textContent).not.toContain(KEY);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('人間の書きかけ');
  });

  it('削除の 409 で見せる「いまの内容」に鍵が出ず、地の文は残る', async () => {
    stubWith((request) =>
      request.method === 'DELETE'
        ? json(
            {
              error: '記憶が読んだ後に変わっています（消していません）',
              current: { document: CLONE_DOC, version: V2 },
            },
            409,
          )
        : undefined,
    );

    await screen.findByRole('heading', { name: '見出し' });
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('クローンが書いた本文');
    expect(alert.textContent).toContain('以上');
    expect(alert.textContent).not.toContain(KEY);
  });
});
