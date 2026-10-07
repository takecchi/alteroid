// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
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

const WAITING: ManagerSummary = {
  ...BASE,
  status: 'waiting_human',
  waiting: [
    {
      requestId: 'req-q',
      summary: 'DB はどちらにする？',
      kind: 'question',
      askedAt: '2026-08-16T03:10:00.000Z',
    },
  ],
};

const ANSWER_PLACEHOLDER = 'この質問への答えを、自分の言葉で書く';

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
  const router = createMemoryRouter(
    [
      {
        path: '/managers',
        Component: Outlet,
        children: [{ path: ':id', Component: Harness }],
      },
      { path: '/elsewhere', Component: () => <p>別の画面</p> },
    ],
    { initialEntries: ['/managers/mgr-1'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return {
    router,
    sent,
    releaseNext: () => {
      const release = pending.shift();
      if (release === undefined) throw new Error('待っている POST が無い');
      release();
    },
  };
}

function leave(router: ReturnType<typeof mount>['router']) {
  return act(async () => {
    void router.navigate('/elsewhere');
  });
}

function beforeUnloadPrevented(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('話しかける欄の書きかけ', () => {
  it('空のあいだは確認なしで移動でき、beforeunload も止めない', async () => {
    const { router } = mount(BASE, { outcome: 'delivered', detail: '追加指示として届けた。' });
    await screen.findByPlaceholderText('追加の指示');
    expect(beforeUnloadPrevented()).toBe(false);

    await leave(router);
    await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('書きかけのまま移動しようとすると確認が出て、beforeunload も止める。やめれば残る・破棄すれば移る', async () => {
    const { router } = mount(BASE, { outcome: 'delivered', detail: '追加指示として届けた。' });
    const box = (await screen.findByPlaceholderText('追加の指示')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '書きかけ' } });
    expect(beforeUnloadPrevented()).toBe(true);

    await leave(router);
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/managers/mgr-1');

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/managers/mgr-1');
    expect(box.value).toBe('書きかけ');

    await leave(router);
    fireEvent.click(await screen.findByRole('button', { name: '破棄して離れる' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
  });

  it('空白だけでは書きかけと数えない', async () => {
    const { router } = mount(BASE, { outcome: 'delivered', detail: '追加指示として届けた。' });
    fireEvent.change(await screen.findByPlaceholderText('追加の指示'), {
      target: { value: '  \n ' },
    });
    expect(beforeUnloadPrevented()).toBe(false);
    await leave(router);
    await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
  });

  it('送っている最中は書きかけのまま。届いて欄が空になれば、確認しない', async () => {
    const server = mount(BASE, { outcome: 'delivered', detail: '追加指示として届けた。' });
    const box = (await screen.findByPlaceholderText('追加の指示')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '続けて' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(beforeUnloadPrevented()).toBe(true);

    server.releaseNext();
    await screen.findByText(/追加指示を届けた/);
    expect(box.value).toBe('');
    await waitFor(() => expect(beforeUnloadPrevented()).toBe(false));

    await leave(server.router);
    await waitFor(() => expect(server.router.state.location.pathname).toBe('/elsewhere'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('届かなかったときは欄が残るので、確認も残る', async () => {
    const server = mount(BASE, { outcome: 'declined', detail: '畳めなかった。' });
    const box = (await screen.findByPlaceholderText('追加の指示')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '続けて' } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    await waitFor(() => expect(server.sent).toHaveLength(1));
    server.releaseNext();
    await screen.findByText(/届けていない/);
    expect(box.value).toBe('続けて');

    await leave(server.router);
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(server.router.state.location.pathname).toBe('/managers/mgr-1');
  });
});

describe('質問への答えの書きかけ', () => {
  it('書きかけの答えがあれば確認が出る。話しかける欄が空でも効く', async () => {
    const { router } = mount(WAITING, { outcome: 'answered', detail: '回答として届けた。' });
    await screen.findByText('DB はどちらにする？');
    expect(beforeUnloadPrevented()).toBe(false);

    fireEvent.change(screen.getByPlaceholderText(ANSWER_PLACEHOLDER), {
      target: { value: 'PostgreSQL' },
    });
    expect(beforeUnloadPrevented()).toBe(true);

    await leave(router);
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/managers/mgr-1');
  });

  it('答えが届いて欄が空になれば確認しない', async () => {
    const server = mount(WAITING, { outcome: 'answered', detail: '回答として届けた。' });
    const box = (await screen.findByPlaceholderText(ANSWER_PLACEHOLDER)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'PostgreSQL' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(server.sent).toHaveLength(1));
    server.releaseNext();
    await waitFor(() => expect(box.value).toBe(''));
    await waitFor(() => expect(beforeUnloadPrevented()).toBe(false));

    await leave(server.router);
    await waitFor(() => expect(server.router.state.location.pathname).toBe('/elsewhere'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('2つの欄の片方を空にしても、もう片方が書きかけなら確認は残る', async () => {
    const { router } = mount(WAITING, { outcome: 'answered', detail: '回答として届けた。' });
    const answer = (await screen.findByPlaceholderText(ANSWER_PLACEHOLDER)) as HTMLTextAreaElement;
    const message = screen.getByPlaceholderText('追加の指示');
    fireEvent.change(answer, { target: { value: 'PostgreSQL' } });
    fireEvent.change(message, { target: { value: '続けて' } });
    fireEvent.change(answer, { target: { value: '' } });
    expect(beforeUnloadPrevented()).toBe(true);

    await leave(router);
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
  });
});
