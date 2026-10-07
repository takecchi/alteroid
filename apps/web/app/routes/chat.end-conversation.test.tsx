// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch, type Route } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-end-1';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat(initial: string) {
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: [initial] },
  );
  return {
    router,
    ...render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    ),
  };
}

function conversationRoutes(url: string) {
  if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
    return json({ conversationId: CONVERSATION_ID, messages: [] });
  }
  if (url.includes('/approvals')) {
    return json({ approvals: [] });
  }
  if (url.includes('/conversations')) {
    return json({ conversations: [], scanned: 0 });
  }
  return undefined;
}

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

async function findEndButton() {
  return screen.findByRole('button', { name: '会話を終える' });
}

async function pressEnd() {
  fireEvent.click(await findEndButton());
  fireEvent.click(await screen.findByRole('button', { name: '終える' }));
}

function endButton() {
  return screen.getByRole('button', { name: '会話を終える' });
}

describe('「会話を終える」ボタン', () => {
  it('(a) 失敗すると ErrorNote に理由が出て、/chat へは遷移しない', async () => {
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/end')) return json({ error: '許可が無い' }, 403);
      return undefined;
    });

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    await pressEnd();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('許可が無い');
    expect(router.state.location.pathname).toBe(`/chat/${CONVERSATION_ID}`);
  });

  it('(d) 失敗した後、ボタンは disabled でなくなり、もう一度押せる', async () => {
    const stub = stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/end')) return json({ error: '許可が無い' }, 403);
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    await pressEnd();

    expect(await screen.findByRole('alert')).toBeTruthy();

    await waitFor(() => {
      expect((endButton() as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(endButton());
    fireEvent.click(await screen.findByRole('button', { name: '終える' }));
    await waitFor(() => {
      const calls = stub.entries.filter((entry) => entry.url.endsWith('/end'));
      expect(calls).toHaveLength(2);
    });
  });

  it('(b) 押している間はもう一度押せない（disabled）', async () => {
    let releaseEnd: () => void = () => {};
    const endReleased = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    const route: Route = (url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/end')) return endReleased.then(() => json({}));
      return undefined;
    };
    const stub = stubFetch(route);

    renderChat(`/chat/${CONVERSATION_ID}`);
    await pressEnd();

    await waitFor(() => {
      expect((endButton() as HTMLButtonElement).disabled).toBe(true);
    });

    fireEvent.click(endButton());
    await act(async () => {});
    const calls = stub.entries.filter((entry) => entry.url.endsWith('/end'));
    expect(calls).toHaveLength(1);

    releaseEnd();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '会話を終える' })).toBeNull();
    });
  });

  it('(c) 成功すると /chat へ遷移する', async () => {
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/end')) return json({});
      return undefined;
    });

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    await pressEnd();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/chat');
    });
    expect(
      (await screen.findByText(/会話を終えました。ここまでの学びを記憶にまとめます/)).textContent,
    ).toContain('一覧に残って');
  });

  it('(h) 応答待ちに別の会話へ移ると、成功しても移った先にとどまる', async () => {
    const OTHER_ID = 'conv-end-2';
    let releaseEnd: () => void = () => {};
    const endReleased = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    const stub = stubFetch((url) => {
      if (url.endsWith('/end')) return endReleased.then(() => json({}));
      if (url.includes(`/conversations/${OTHER_ID}`)) {
        return json({ conversationId: OTHER_ID, messages: [] });
      }
      return conversationRoutes(url);
    });

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    await pressEnd();
    await waitFor(() => {
      expect(stub.entries.filter((entry) => entry.url.endsWith('/end'))).toHaveLength(1);
    });

    await act(async () => {
      await router.navigate(`/chat/${OTHER_ID}`);
    });
    releaseEnd();
    await act(async () => {});
    await act(async () => {});

    expect(router.state.location.pathname).toBe(`/chat/${OTHER_ID}`);
    expect(screen.queryByText(/会話を終えました/)).toBeNull();
  });

  it('(e) 確認で「やめる」を押すと、終えない（/end は飛ばない）', async () => {
    const stub = stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/end')) return json({});
      return undefined;
    });

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findEndButton());
    expect(await screen.findByText(/クローンがここまでの学びを記憶にまとめます/)).toBeTruthy();
    expect(stub.entries.filter((entry) => entry.url.endsWith('/end'))).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await act(async () => {});
    expect(stub.entries.filter((entry) => entry.url.endsWith('/end'))).toHaveLength(0);
    expect(router.state.location.pathname).toBe(`/chat/${CONVERSATION_ID}`);
  });

  it('(f) 副題は会話 id ではなく開始日時と発言数を出す。新しい会話は「新しい会話」', async () => {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          reachedStart: true,
          scanned: 2,
          messages: [
            {
              id: 'm1',
              at: '2026-10-01T01:00:00.000Z',
              role: 'inbound',
              text: 'こんにちは',
              conversationId: CONVERSATION_ID,
            },
            {
              id: 'm2',
              at: '2026-10-01T01:00:05.000Z',
              role: 'outbound',
              text: 'はい',
              conversationId: CONVERSATION_ID,
            },
          ],
        });
      }
      return conversationRoutes(url);
    });

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    expect(await screen.findByText(/に開始 · 発言 2 件/)).toBeTruthy();
    expect(screen.queryByText(CONVERSATION_ID)).toBeNull();
    await act(async () => {
      await router.navigate('/chat');
    });
    expect(await screen.findByText('新しい会話')).toBeTruthy();
  });

  it('(g) 履歴が先頭に届いていない（reachedStart: false）ときは「以降」「発言 N 件以上」と言う', async () => {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          reachedStart: false,
          scanned: 1,
          messages: [
            {
              id: 'm1',
              at: '2026-10-01T01:00:00.000Z',
              role: 'inbound',
              text: 'こんにちは',
              conversationId: CONVERSATION_ID,
            },
          ],
        });
      }
      return conversationRoutes(url);
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    expect(await screen.findByText(/以降 · 発言 1 件以上/)).toBeTruthy();
  });
});
