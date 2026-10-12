// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ManagerSummary } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/manager-detail';
import ManagerDetail, { clientLoader } from './manager-detail';

const WAITING: ManagerSummary = {
  managerId: 'mgr-1',
  status: 'waiting_human',
  live: true,
  cwd: '/work/project',
  request: 'PR を出して',
  startedAt: '2026-08-16T03:00:00.000Z',
  updatedAt: '2026-08-16T03:15:00.000Z',
  waiting: [
    {
      requestId: 'req-q',
      summary: 'DB はどちらにする？',
      kind: 'question',
      askedAt: '2026-08-23T01:00:00.000Z',
    },
  ],
};

// ほかで答えられて、待ちから外れた後
const SETTLED: ManagerSummary = { ...WAITING, status: 'running', waiting: [] };

const PLACEHOLDER = 'この質問への答えを、自分の言葉で書く';

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
  const loaderData = clientLoader({ params: { id: 'mgr-1' } } as Route.ClientLoaderArgs);
  return <ManagerDetail {...({ loaderData } as Route.ComponentProps)} />;
}

function mount() {
  let manager = WAITING;
  let settledServed = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.endsWith('/managers/mgr-1/messages')) {
      return json({ outcome: 'answered', detail: '回答として届けた。' });
    }
    if (request.url.includes('/managers/mgr-1')) {
      if (manager === SETTLED) settledServed += 1;
      return json({ manager });
    }
    throw new TypeError(`Failed to fetch: ${request.url}`);
  }) as typeof fetch;
  const router = createMemoryRouter([{ path: '/managers/:id', Component: Harness }], {
    initialEntries: ['/managers/mgr-1'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return {
    // ほかで答えられた。取り直しが走り、待ちの行が外れる
    async settleElsewhere() {
      manager = SETTLED;
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() => expect(settledServed).toBeGreaterThan(0));
      await waitFor(() => expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull());
    },
  };
}

describe('質問への答えを書いている間に、ほかで決着して待ちから外れたとき（#4582）', () => {
  it('書きかけを黙って消さず、「送らなかった答え」として残し、閉じれば捨てる', async () => {
    const server = mount();
    fireEvent.change(await screen.findByPlaceholderText(PLACEHOLDER), {
      target: { value: 'PostgreSQL で' },
    });

    await server.settleElsewhere();

    const list = await screen.findByRole('list', { name: '送らなかった答えが残っている質問' });
    expect(within(list).getByText('PostgreSQL で')).toBeTruthy();
    expect(within(list).getByText(/DB はどちらにする？/)).toBeTruthy();

    fireEvent.click(within(list).getByRole('button', { name: '閉じる（捨てる）' }));
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: '送らなかった答えが残っている質問' })).toBeNull(),
    );
  });

  it('対照: 答えを送り終えてから外れたなら、何も残さない', async () => {
    const server = mount();
    fireEvent.change(await screen.findByPlaceholderText(PLACEHOLDER), {
      target: { value: 'PostgreSQL で' },
    });
    fireEvent.click(screen.getByRole('button', { name: '「DB はどちらにする？」へ答えを送信' }));
    await waitFor(() =>
      expect((screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement).value).toBe(''),
    );

    await server.settleElsewhere();
    expect(screen.queryByRole('list', { name: '送らなかった答えが残っている質問' })).toBeNull();
  });
});
