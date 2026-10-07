// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, setTouchOnly, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-ime-enter';

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
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

function background(url: string): Response | undefined {
  if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
    return json({ conversationId: CONVERSATION_ID, messages: [] });
  }
  if (url.includes('/approvals')) return json({ approvals: [] });
  if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
  return undefined;
}

function setUpChat(): { bodies: string[] } {
  const bodies: string[] = [];
  stubFetch((url, init) => {
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: CONVERSATION_ID } },
          { event: 'done', data: { type: 'done' } },
        ],
        { signal: init?.signal },
      );
    }
    return background(url);
  });
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request && input.url.endsWith('/chat')) {
      bodies.push(await input.clone().text());
    }
    return inner(input, init);
  }) as typeof fetch;
  return { bodies };
}

// キー押下の直後に 0 本を測らず待ちを挟む: 送信は非同期で、まだ立っていないだけの状態と区別が付かないため
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

async function typeInto(text: string): Promise<HTMLTextAreaElement> {
  const box = (await screen.findByPlaceholderText(/クローンに話しかける/)) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  return box;
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

function pretendPlatform(platform: string) {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
}

const BODY = (text: string) => ({
  text,
  conversationId: CONVERSATION_ID,
  clientMessageId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
});

describe('IME 変換中の送信ショートカット', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setTouchOnly(false);
  });

  it('案内は OS に合わせて出し、指だけの端末では隠す。送信ボタンの名前は残る', async () => {
    setUpChat();
    renderChat(`/chat/${CONVERSATION_ID}`);
    await typeInto('x');
    expect(screen.getByText('Ctrl + Enter で送信')).toBeTruthy();
    act(() => setTouchOnly(true));
    expect(screen.queryByText(/Enter で送信/)).toBeNull();
    expect(screen.getByRole('button', { name: 'メッセージを送信' })).toBeTruthy();
  });

  it('Ctrl + Enter（Mac 以外）は、変換中（isComposing: true）は送らず、確定後（false）は送る', async () => {
    const { bodies } = setUpChat();
    renderChat(`/chat/${CONVERSATION_ID}`);
    const box = await typeInto('こんにちは');

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: true });
    await settle();
    expect(bodies).toEqual([]);

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: false });
    await waitFor(() => {
      expect(bodies.length).toBe(1);
    });
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual(BODY('こんにちは'));
  });

  it('⌘ + Enter も同じ（Mac でも Mac 以外でも、⌘ と Ctrl のどちらでも送る）', async () => {
    pretendPlatform('MacIntel');
    const { bodies } = setUpChat();
    renderChat(`/chat/${CONVERSATION_ID}`);
    const box = await typeInto('へんかんちゅう');

    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, isComposing: true });
    await settle();
    expect(bodies).toEqual([]);

    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, isComposing: false });
    await waitFor(() => {
      expect(bodies.length).toBe(1);
    });
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual(BODY('へんかんちゅう'));
  });

  it('keyCode 229（isComposing は false）の Ctrl + Enter でも送らない', async () => {
    const { bodies } = setUpChat();
    renderChat(`/chat/${CONVERSATION_ID}`);
    const box = await typeInto('へんかん');

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: false, keyCode: 229 });
    await settle();
    expect(bodies).toEqual([]);

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: false, keyCode: 13 });
    await waitFor(() => {
      expect(bodies.length).toBe(1);
    });
  });

  it('Enter 単体・Shift + Enter では送らない（既定の改行のまま）。送信ボタンは生きている', async () => {
    const { bodies } = setUpChat();
    renderChat(`/chat/${CONVERSATION_ID}`);
    const box = await typeInto('修飾キー無し');

    expect(fireEvent.keyDown(box, { key: 'Enter', isComposing: false })).toBe(true);
    expect(fireEvent.keyDown(box, { key: 'Enter', shiftKey: true, isComposing: false })).toBe(true);
    await settle();
    expect(bodies).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => {
      expect(bodies.length).toBe(1);
    });
  });
});
