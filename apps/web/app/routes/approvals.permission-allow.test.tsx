// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PendingApproval } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Approvals from './approvals';

// 許可の承認の「許可」が定型文を送らないと、core は許可を記録しない（#5901）。期待値を定数から作らず逐語で持つ: 定数ごと書き換わっても歯が落ちるため
const permissionApproval: PendingApproval = {
  id: 'a-perm',
  createdAt: '2026-08-19T10:00:00.000Z',
  updatedAt: '2026-08-19T10:00:00.000Z',
  question: '`git status` を許可してよいか',
  permissionRequest: { rule: 'Bash(git status)', allows: ['git status'], denies: [] },
};
const plainApproval: PendingApproval = {
  id: 'a-plain',
  createdAt: '2026-08-19T10:00:00.000Z',
  updatedAt: '2026-08-19T10:00:00.000Z',
  question: '本番に出してよいか',
};

function stub(approvals: PendingApproval[]) {
  const sent: { id: string; answer: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = input instanceof Request ? input.method : 'GET';
    if (url.pathname === '/approvals' && method === 'GET') return json({ approvals });
    const single = /^\/approvals\/([^/]+)\/answer$/.exec(url.pathname);
    if (single && input instanceof Request) {
      const body = (await input.clone().json()) as { answer?: unknown };
      sent.push({ id: decodeURIComponent(single[1]!), answer: body.answer });
      return json({ ok: true });
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
  }) as typeof fetch;
  return sent;
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/approvals', Component: Approvals }], {
    initialEntries: ['/approvals'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

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

describe('許可の承認の「許可」が送る文（#5901）', () => {
  it('permissionRequest を持つ承認: 「許可」は「許可します」を送り、補助の文に許可（Bash）の一覧へ載ることが出る', async () => {
    const sent = stub([permissionApproval]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '許可' }));
    await waitFor(() => expect(sent).toEqual([{ id: 'a-perm', answer: '許可します' }]));
  });

  it('permissionRequest を持つ承認: 補助の文が「許可します」と許可（Bash）の一覧を言う', async () => {
    stub([permissionApproval]);
    renderPage();
    await screen.findByRole('button', { name: '許可' });
    expect(
      screen.getByText(
        '「許可」は「許可します」と送り、許可（Bash）の一覧に載る。「却下」は「いいえ、やらないで」と送る。',
      ),
    ).toBeTruthy();
  });

  it('permissionRequest を持つ承認: 「却下」は「いいえ、やらないで」のまま', async () => {
    const sent = stub([permissionApproval]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '却下' }));
    await waitFor(() => expect(sent).toEqual([{ id: 'a-perm', answer: 'いいえ、やらないで' }]));
  });

  it('permissionRequest を持たない承認: 「許可」は「はい、進めてよい」を送る', async () => {
    const sent = stub([plainApproval]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '許可' }));
    await waitFor(() => expect(sent).toEqual([{ id: 'a-plain', answer: 'はい、進めてよい' }]));
  });

  it('permissionRequest を持たない承認: 補助の文は許可（Bash）に触れない', async () => {
    stub([plainApproval]);
    renderPage();
    await screen.findByRole('button', { name: '許可' });
    expect(
      screen.getByText(
        '「許可」は「はい、進めてよい」と送る。「却下」は「いいえ、やらないで」と送る。',
      ),
    ).toBeTruthy();
  });
});
