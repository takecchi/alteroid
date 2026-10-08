// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PendingApproval } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Approvals from './approvals';

function approval(id: string, over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id,
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
    question: `質問 ${id}`,
    ...over,
  };
}

const questions: NonNullable<PendingApproval['questions']> = [
  { id: 'deploy', prompt: 'デプロイ先', options: [{ id: 'railway', label: 'Railway' }] },
];

function stub(approvals: PendingApproval[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname === '/approvals') return json({ approvals });
    if (url.pathname === '/approvals/answered-dates') return json({ dates: [] });
    return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
  }) as typeof fetch;
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

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Approvals }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('/approvals のまとめ送信の案内 — 設問のある承認', () => {
  it('設問のある承認の件数を挙げ、まとめて送れない（各カードの「回答」で送る）と言う', async () => {
    stub([
      approval('a-1', { questions }),
      approval('a-2', { questions }),
      approval('a-3'),
      approval('a-4', { questions: [] }),
    ]);
    renderPage();

    expect(
      await screen.findByText(
        '設問のある承認 2 件は、まとめて送れない（各カードの「回答」で送る）',
      ),
    ).toBeTruthy();
  });

  it('設問のある承認が無ければ、その一行は出さない', async () => {
    stub([approval('a-3')]);
    renderPage();

    await screen.findByText(/まとめて送る答えはまだ書かれていない/);
    expect(screen.queryByText(/設問のある承認/)).toBeNull();
  });
});
