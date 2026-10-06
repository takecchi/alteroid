// @vitest-environment jsdom
/**
 * Issue #3564。`done` / `error` / `usage_limited` のどれも来ないまま SSE が正常に閉じたとき、
 * 黙らずに失敗として出す（途中までの返信が完成したように見える・送れていない発言が送れたように見える）。
 *
 * - `open` の後に閉じた: 受け取った分の返信は残し、「応答が途中で切れた」と言う
 * - `open` の前に閉じた: 文を入力欄へ戻し、「送れたか確かめられなかった」の道（#3121）で積む
 * - 画面に戻ったときの再生（`GET /chat/:id/stream`）も同じ
 * - 終端が来たとき・使い手が止めたときは、今までどおり黙る
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-3564';
const CLOSED_EARLY = /応答が途中で切れた（done も error も来ないまま接続が閉じた）/;

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

type Frame = { event: string; data: unknown };

function setUp({
  chat,
  replay,
  keepOpen,
}: {
  chat?: Frame[];
  replay?: Frame[];
  keepOpen?: boolean;
}) {
  return stubFetch((url, init) => {
    if (/\/chat\/[^/]+\/stream$/.test(url)) {
      return sse(replay ?? [{ event: 'open', data: { conversationId: ID, inProgress: false } }], {
        signal: init?.signal,
      });
    }
    if (url.endsWith('/chat')) return sse(chat ?? [], { signal: init?.signal, keepOpen });
    if (url.includes(`/conversations/${ID}`)) return json({ conversationId: ID, messages: [] });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    if (url.endsWith('/journal/stream')) {
      return sse([{ event: 'open', data: { ok: true } }], { keepOpen: true, signal: init?.signal });
    }
    return undefined;
  });
}

async function sendText(text: string) {
  const box = (await screen.findByPlaceholderText(/クローンに話しかける/)) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
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

describe('終端が無いまま閉じた送信（#3564）', () => {
  it('open の後、text の途中で閉じたら、受け取った分を残して「途中で切れた」と言う', async () => {
    setUp({
      chat: [
        { event: 'open', data: { conversationId: ID } },
        { event: 'text', data: { type: 'text', text: '途中までの返' } },
      ],
    });
    renderChat(`/chat/${ID}`);
    await sendText('こんにちは');

    expect(await screen.findByText(CLOSED_EARLY)).toBeTruthy();
    expect(screen.getByText(/途中までの返/)).toBeTruthy();
  });

  it('open の前に閉じたら、文を入力欄へ戻し、送れたか確かめられなかったと言う（自動では送らない）', async () => {
    const stub = setUp({ chat: [] });
    renderChat(`/chat/${ID}`);
    const box = await sendText('届いていない発言');

    expect(await screen.findByText(/送れたか確かめられなかった/)).toBeTruthy();
    await waitFor(() => expect(box.value).toBe('届いていない発言'));
    expect(screen.getByRole('button', { name: '再送' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '破棄' })).toBeTruthy();
    // 吹き出しは外れている（送れたように見せない）。
    const transcript = screen.queryByRole('list', { name: 'やりとり' });
    expect(transcript?.textContent ?? '').not.toContain('届いていない発言');
    expect(stub.entries.filter((e) => e.url.endsWith('/chat')).length).toBe(1);
  });

  it('done が来て閉じたなら黙る（陰性対照）', async () => {
    setUp({
      chat: [
        { event: 'open', data: { conversationId: ID } },
        { event: 'text', data: { type: 'text', text: '返事です' } },
        { event: 'done', data: { type: 'done' } },
      ],
    });
    renderChat(`/chat/${ID}`);
    await sendText('こんにちは');

    expect(await screen.findByText('返事です')).toBeTruthy();
    expect(screen.queryByText(CLOSED_EARLY)).toBeNull();
    expect(screen.queryByText(/送れたか確かめられなかった/)).toBeNull();
  });

  it('使い手が受信をやめたときは、途中で切れたとは言わない（aborted は今までどおり黙る）', async () => {
    setUp({
      chat: [
        { event: 'open', data: { conversationId: ID } },
        { event: 'text', data: { type: 'text', text: '考え中の返信' } },
      ],
      keepOpen: true,
    });
    renderChat(`/chat/${ID}`);
    await sendText('こんにちは');
    expect(await screen.findByText(/考え中の返信/)).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: /受信をやめる/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /受信をやめる/ })).toBeNull());
    expect(screen.queryByText(CLOSED_EARLY)).toBeNull();
  });
});

describe('終端が無いまま閉じた再生（#3564）', () => {
  it('再生が text の途中で閉じたら、「途中で切れた」と言う', async () => {
    setUp({
      replay: [
        { event: 'open', data: { conversationId: ID, inProgress: true } },
        { event: 'text', data: { type: 'text', text: '再生された途中の返' } },
      ],
    });
    renderChat(`/chat/${ID}`);

    expect(await screen.findByText(CLOSED_EARLY)).toBeTruthy();
    expect(screen.getByText(/再生された途中の返/)).toBeTruthy();
  });

  it('進行中でなければ（open だけで閉じる）何も言わない', async () => {
    const stub = setUp({});
    renderChat(`/chat/${ID}`);
    await waitFor(() => expect(stub.entries.some((e) => /\/stream$/.test(e.url))).toBe(true));
    await screen.findByPlaceholderText(/クローンに話しかける/);
    expect(screen.queryByText(CLOSED_EARLY)).toBeNull();
  });
});
