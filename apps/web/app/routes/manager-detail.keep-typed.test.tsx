// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ManagerSummary } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/manager-detail';
import ManagerDetail, { clientLoader } from './manager-detail';

const BASE: ManagerSummary = {
  managerId: 'mgr-1',
  status: 'running',
  live: true,
  cwd: '/work/project',
  request: 'PR を出して',
  startedAt: '2026-08-16T03:00:00.000Z',
  updatedAt: '2026-08-16T03:15:00.000Z',
  waiting: [],
};

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

function mount(manager: ManagerSummary, result: { outcome: string; detail: string }) {
  const sent: unknown[] = [];
  const pending: (() => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.endsWith('/managers/mgr-1/messages')) {
      sent.push(await request.json());
      return new Promise<Response>((resolve) => {
        pending.push(() => resolve(json(result)));
      });
    }
    if (request.url.includes('/managers/mgr-1')) return json({ manager });
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
    sent,
    releaseNext: () => {
      const release = pending.shift();
      if (release === undefined) throw new Error('待っている POST が無い');
      release();
    },
  };
}

describe('話しかける欄', () => {
  it('応答を待つ間に打ち足した分は、届いたあとも残る（送り済みの分は残さない）', async () => {
    const server = mount(BASE, { outcome: 'delivered', detail: '追加指示として届けた。' });
    const box = (await screen.findByPlaceholderText('追加の指示')) as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: '続けて' } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]).toEqual({ text: '続けて' });

    fireEvent.change(box, { target: { value: '続けて\nあと、テストも' } });
    server.releaseNext();

    expect(await screen.findByText(/追加指示を届けた/)).toBeTruthy();
    expect((screen.getByPlaceholderText('追加の指示') as HTMLTextAreaElement).value).toBe(
      'あと、テストも',
    );
  });

  it('打ち足さなかったときは、これまでどおり欄を空にする', async () => {
    const server = mount(BASE, { outcome: 'delivered', detail: '追加指示として届けた。' });
    fireEvent.change(await screen.findByPlaceholderText('追加の指示'), {
      target: { value: '続けて' },
    });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    await waitFor(() => expect(server.sent).toHaveLength(1));
    server.releaseNext();

    expect(await screen.findByText(/追加指示を届けた/)).toBeTruthy();
    expect((screen.getByPlaceholderText('追加の指示') as HTMLTextAreaElement).value).toBe('');
  });
});

describe('質問への答えの欄', () => {
  it('応答を待つ間に打ち足した分は、届いたあとも残る', async () => {
    const server = mount(
      {
        ...BASE,
        status: 'waiting_human',
        waiting: [
          {
            requestId: 'req-q',
            summary: 'DB はどちらにする？',
            kind: 'question',
            askedAt: '2026-08-23T01:00:00.000Z',
          },
        ],
      },
      { outcome: 'answered', detail: '回答として届けた。' },
    );
    const box = (await screen.findByPlaceholderText(
      'この質問への答えを、自分の言葉で書く',
    )) as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: 'PostgreSQL で' } });
    fireEvent.click(screen.getByRole('button', { name: '「DB はどちらにする？」へ答えを送信' }));
    await waitFor(() => expect(server.sent).toHaveLength(1));

    fireEvent.change(box, { target: { value: 'PostgreSQL で いや、やっぱり' } });
    server.releaseNext();

    await waitFor(() => {
      expect(
        (screen.getByPlaceholderText('この質問への答えを、自分の言葉で書く') as HTMLTextAreaElement)
          .value,
      ).toBe('いや、やっぱり');
    });
  });
});
