// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Commitment } from '@alteroid/core';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Commitments from './commitments';

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

const BODY = '金曜までに週次レビューを出す';

// `reply` が最初の POST の応答。`stores` が偽なら、サーバには届かなかったことにする。
function stubServer(options: { stores: boolean; reply: () => Response }) {
  const stored: Commitment[] = [];
  const stub = { posts: 0, stored };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/commitments'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'GET') return json({ entries: [...stored] });
    const sent = (await request.json()) as { body: string };
    stub.posts += 1;
    if (stub.posts === 1) {
      if (options.stores) {
        stored.push({
          id: 'c-1',
          at: '2026-09-01T00:00:00.000Z',
          origin: 'human',
          body: sent.body,
        });
      }
      return options.reply();
    }
    const entry: Commitment = {
      id: `c-${stub.posts}`,
      at: '2026-09-01T00:00:00.000Z',
      origin: 'human',
      body: sent.body,
    };
    stored.push(entry);
    return json({ entry });
  }) as typeof fetch;
  return stub;
}

async function pushOnce() {
  const router = createMemoryRouter([{ path: '/', Component: Commitments }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  const field = (await screen.findByLabelText('何を引き受けたか')) as HTMLTextAreaElement;
  // 積む前の一覧が読めてから押す（「積む前に無かった行」を決める元になる）
  await waitFor(() => expect(screen.getByText('未了の仕事はない。')).toBeTruthy());
  fireEvent.change(field, { target: { value: BODY } });
  fireEvent.click(screen.getByRole('button', { name: '積む' }));
  return field;
}

describe('積む: 届いたか分からない失敗', () => {
  it('届いて応答を失った（502）: 「載っている」と言って欄を空にし、二重に積まない', async () => {
    const stub = stubServer({
      stores: true,
      reply: () => new Response('bad gateway', { status: 502 }),
    });
    const field = await pushOnce();

    await waitFor(() => expect(field.value).toBe(''));
    expect(await screen.findByText(/台帳には載っている/)).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(stub.posts).toBe(1);
    expect(stub.stored).toHaveLength(1);
  });

  it('届いて応答を失った（接続断）: 同じく欄を空にする', async () => {
    const stub = stubServer({
      stores: true,
      reply: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const field = await pushOnce();

    await waitFor(() => expect(field.value).toBe(''));
    expect(stub.stored).toHaveLength(1);
  });

  it('届いていない 5xx: 欄は残り、届いたか分からないと断る', async () => {
    const stub = stubServer({
      stores: false,
      reply: () => new Response('bad gateway', { status: 502 }),
    });
    const field = await pushOnce();

    expect(await screen.findByText(/届いたか分からない/)).toBeTruthy();
    expect(field.value).toBe(BODY);
    expect(stub.stored).toHaveLength(0);
  });

  it('届いていない 4xx: 欄は残り、届いたか分からないとは言わない', async () => {
    const stub = stubServer({
      stores: false,
      reply: () => json({ error: '本文が空' }, 400),
    });
    const field = await pushOnce();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(field.value).toBe(BODY);
    expect(screen.queryByText(/届いたか分からない/)).toBeNull();
    expect(stub.stored).toHaveLength(0);
  });
});
