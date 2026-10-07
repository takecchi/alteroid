// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PendingApproval } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Approvals from './approvals';

const card = (id: string, question: string): PendingApproval => ({
  id,
  createdAt: '2026-08-19T10:00:00.000Z',
  updatedAt: '2026-08-19T10:00:00.000Z',
  question,
});

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

// 届いたあと、応答だけを失わせる（接続断）。`landed` になった以降の一覧は、そのカードを含まない。
function stubServer(lose: () => Response) {
  const stub = { landed: false, listGets: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/approvals' && request.method === 'GET') {
      stub.listGets += 1;
      return json({ approvals: stub.landed ? [] : [card('a-one', '一件目の質問')] });
    }
    if (url.pathname === '/approvals/answer') {
      stub.landed = true;
      return lose();
    }
    throw new TypeError(`Failed to fetch: ${url.href}`);
  }) as typeof fetch;
  return stub;
}

async function sendBulk() {
  const router = createMemoryRouter([{ path: '/approvals', Component: Approvals }], {
    initialEntries: ['/approvals'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  const box = (await screen.findAllByPlaceholderText(/答える/))[0]!;
  fireEvent.change(box, { target: { value: '答え' } });
  fireEvent.click(await screen.findByRole('button', { name: 'まとめて送る' }));
}

describe('まとめ送信が届いたのに応答を失った（届いたか分からない失敗）', () => {
  for (const [label, lose] of [
    [
      '接続断',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
    ['502', () => new Response('bad gateway', { status: 502 })],
  ] as const) {
    it(`${label}: 一覧を取り直し、答え済みのカードが消える`, async () => {
      const stub = stubServer(lose);
      await sendBulk();

      await waitFor(() => expect(screen.queryByText('一件目の質問')).toBeNull());
      expect(stub.listGets).toBeGreaterThan(1);
    });
  }
});
