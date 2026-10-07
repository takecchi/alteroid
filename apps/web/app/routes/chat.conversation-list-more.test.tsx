// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat() {
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: ['/chat'] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

function page(
  from: number,
  count: number,
  extra: { nextCursor?: string; reachedStart?: boolean; hiddenByLimit?: number } = {},
) {
  return {
    conversations: Array.from({ length: count }, (_, index) => ({
      conversationId: `c${from + index}`,
      preview: `会話 ${from + index}`,
      updatedAt: '2026-10-06T00:00:00.000Z',
      messages: 2,
      unreadCount: 0,
    })),
    scanned: 2000,
    reachedStart: extra.reachedStart ?? true,
    hiddenByLimit: extra.hiddenByLimit ?? 0,
    ...(extra.nextCursor === undefined ? {} : { nextCursor: extra.nextCursor }),
  };
}

const MORE = { name: 'もっと見る' } as const;

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

function cursorOf(url: string): string | null {
  return new URL(url).searchParams.get('cursor');
}

function rows() {
  return within(screen.getByRole('list', { name: '会話' })).getAllByRole('listitem');
}

function serve(pagesByCursor: Record<string, () => Response>) {
  return stubFetch((url) => {
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return pagesByCursor[cursorOf(url) ?? '']?.();
    return undefined;
  });
}

describe('会話の一覧の「もっと見る」（issue #3404 / #3550）', () => {
  it('押すと nextCursor を渡して続きを足す。続きが無くなればボタンは消える', async () => {
    const stub = serve({
      '': () => json(page(0, 30, { nextCursor: 'k1', hiddenByLimit: 15 })),
      k1: () => json(page(30, 15)),
    });

    renderChat();
    await screen.findByRole('list', { name: '会話' });
    expect(rows()).toHaveLength(30);

    fireEvent.click(screen.getByRole('button', MORE));

    await waitFor(() => {
      expect(rows()).toHaveLength(45);
    });
    expect(stub.calls.some((url) => url.includes('/conversations') && cursorOf(url) === 'k1')).toBe(
      true,
    );
    expect(
      stub.calls
        .filter((url) => url.includes('/conversations'))
        .every((url) => new URL(url).searchParams.get('limit') === '30'),
    ).toBe(true);
    expect(screen.queryByRole('button', MORE)).toBeNull();
  });

  it('200 件を超えても、窓（scan）の外でも、継続点を辿って続けられる', async () => {
    serve({
      '': () => json(page(0, 30, { nextCursor: 'k1', hiddenByLimit: 400 })),
      k1: () => json(page(30, 30, { nextCursor: 'k2', hiddenByLimit: 340 })),
      k2: () => json(page(60, 2, { nextCursor: 'k3', reachedStart: false })),
      k3: () => json(page(62, 1)),
    });

    renderChat();
    await screen.findByRole('list', { name: '会話' });
    for (const expected of [60, 62, 63]) {
      fireEvent.click(await screen.findByRole('button', MORE));
      await waitFor(() => {
        expect(rows()).toHaveLength(expected);
      });
    }
    await waitFor(() => {
      expect(screen.queryByRole('button', MORE)).toBeNull();
    });
  });

  it('窓が先頭に届いていないとき、続きがあればボタンを出し、届いていない旨も言う', async () => {
    serve({
      '': () => json(page(0, 3, { nextCursor: 'k1', reachedStart: false })),
      k1: () => json(page(3, 1)),
    });

    renderChat();
    await screen.findByRole('list', { name: '会話' });
    expect(screen.getByRole('button', MORE)).toBeTruthy();
    expect(screen.getByText(/先頭には届いていない/)).toBeTruthy();
  });

  it('頁をまたいで同じ会話が現れても、1 行だけ出す', async () => {
    serve({
      '': () => json(page(0, 3, { nextCursor: 'k1' })),
      k1: () => json(page(2, 3)),
    });

    renderChat();
    await screen.findByRole('list', { name: '会話' });
    fireEvent.click(screen.getByRole('button', MORE));
    await waitFor(() => {
      expect(rows()).toHaveLength(5);
    });
  });

  it('最初から続きが無ければ、ボタンを出さない', async () => {
    serve({ '': () => json(page(0, 3)) });

    renderChat();
    await screen.findByRole('list', { name: '会話' });
    expect(screen.queryByRole('button', MORE)).toBeNull();
  });

  it('読み込み中は押せない', async () => {
    let release: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) {
        return cursorOf(url) === 'k1'
          ? (pending as unknown as Response)
          : json(page(0, 30, { nextCursor: 'k1' }));
      }
      return undefined;
    });

    renderChat();
    await screen.findByRole('list', { name: '会話' });
    fireEvent.click(screen.getByRole('button', MORE));

    const busy = await screen.findByRole('button', { name: '読み込み中…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(rows()).toHaveLength(30);

    release(json(page(30, 2)));
    await waitFor(() => {
      expect(rows()).toHaveLength(32);
    });
  });

  it('続きの取得に失敗したら、一覧は残し、一覧の下に小さく言う。もう一度押せば取り直せる', async () => {
    let failMore = true;
    serve({
      '': () => json(page(0, 30, { nextCursor: 'k1' })),
      k1: () => (failMore ? json({ error: 'internal' }, 500) : json(page(30, 10))),
    });

    renderChat();
    await screen.findByRole('list', { name: '会話' });
    fireEvent.click(screen.getByRole('button', MORE));

    const note = await screen.findByRole('alert');
    expect(note.textContent).toContain('続きを読めなかった');
    expect(rows()).toHaveLength(30);
    expect(screen.queryByText('まだ会話がない。')).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    failMore = false;
    fireEvent.click(screen.getByRole('button', MORE));
    await waitFor(() => {
      expect(rows()).toHaveLength(40);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('続きを返さない（nextCursor が無い）のに省略があるときは、ボタンではなく但し書きで言う', async () => {
    serve({ '': () => json(page(0, 3, { hiddenByLimit: 4 })) });

    renderChat();
    await screen.findByRole('list', { name: '会話' });
    expect(screen.queryByRole('button', MORE)).toBeNull();
    expect(screen.getByText(/ほか 4 件は省略/)).toBeTruthy();
  });
});
