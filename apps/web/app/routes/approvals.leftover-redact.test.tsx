// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PendingApproval } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Approvals from './approvals';

const SECRET = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

function approval(): PendingApproval {
  return {
    id: 'a-1',
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
    question: `この鍵で本番に出してよいか ${SECRET}`,
  };
}

let list: PendingApproval[] = [];
let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  list = [approval()];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (/^\/approvals\/[^/]+\/answer$/.test(url.pathname)) {
      list = [];
      return json({ error: 'already answered' }, 409);
    }
    if (url.pathname === '/approvals') return json({ approvals: list });
    return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('承認の画面: 残った下書きの「対象」', () => {
  it('承認カードが伏せて出す本文の秘密は、残った下書きの「対象」でも伏せる', async () => {
    const router = createMemoryRouter([{ path: '/approvals', Component: Approvals }], {
      initialEntries: ['/approvals'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    // カード側は伏せている（前提）。
    await screen.findByPlaceholderText(/答える/);
    expect(document.body.textContent).not.toContain(SECRET);

    fireEvent.change(screen.getByPlaceholderText(/答える/), { target: { value: '書いた答え' } });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));

    const note = await screen.findByRole('list', { name: '送らなかった下書きが残っている承認' });
    expect(note.textContent).toContain('対象: この鍵で本番に出してよいか');
    expect(note.textContent).not.toContain(SECRET);
    // 書いた答えは伏せずに残す（写してから閉じるための欄なので）
    expect(note.textContent).toContain('書いた答え');
  });
});
