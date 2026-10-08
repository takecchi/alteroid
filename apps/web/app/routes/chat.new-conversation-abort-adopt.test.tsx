// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const A = 'conv-3258-a';

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

const MINE = {
  id: 'att-3258',
  name: 'mine.png',
  mediaType: 'image/png',
  size: 4,
  sha256: 'a'.repeat(64),
};

interface PostedBody {
  text: string;
  conversationId?: string;
  attachments?: string[];
  clientMessageId?: string;
}

let originalFetch: typeof fetch;
let stub: ReturnType<typeof stubFetch>;
let posted: PostedBody[] = [];
let received = true;
let lookup: () => Response = () => json({ conversationId: A });

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  posted = [];
  received = true;
  lookup = () => json({ conversationId: A });
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:fake-${(n += 1)}`);
  URL.revokeObjectURL = vi.fn();
  stub = stubFetch((url, init) => {
    if (url.includes('/attachments?')) return json(MINE);
    if (url.includes('/client-messages/')) return lookup();
    if (url.includes(`/conversations/${A}`)) return json({ conversationId: A, messages: [] });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    if (url.endsWith('/chat')) {
      const request = stub.entries.at(-1)?.request;
      return (async () => {
        const body = (await request?.clone().json()) as PostedBody;
        posted.push(body);
        if (posted.length === 1) {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
            request?.signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          });
        }
        if (received && body.conversationId === undefined && (body.attachments?.length ?? 0) > 0) {
          return json(
            { error: '添付は別の発言に結び付いている', code: 'attachment_conflict' },
            400,
          );
        }
        return sse([{ event: 'open', data: { conversationId: A } }], { signal: request?.signal });
      })();
    }
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const nodeFile = () =>
  new NodeFile([new Uint8Array([1, 2, 3, 4])], 'mine.png', {
    type: 'image/png',
  }) as unknown as File;

async function box() {
  return (await screen.findByPlaceholderText(/クローンに話しかける/)) as HTMLTextAreaElement;
}

async function sendWithAttachmentAndAbort() {
  // 中断の直後の先回りの確認（#3303。chat.interrupted-send-probe.test.tsx）は失敗させる。
  // ここで見るのは、次の送信の冒頭の確認（#3258）。
  const real = lookup;
  lookup = () => {
    lookup = real;
    return json({ error: '一時的に失敗' }, 503);
  };
  const view = renderChat('/chat');
  fireEvent.change(await box(), { target: { value: '元の本文' } });
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [nodeFile()], configurable: true });
  fireEvent.change(input);
  await screen.findByRole('button', { name: 'mine.png を外す' });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
  await waitFor(() => expect(posted).toHaveLength(1));
  const stop = await screen.findByRole('button', {
    name: '受信をやめる（クローンのターンは止まらない）',
  });
  await act(async () => {
    fireEvent.click(stop);
  });
  await screen.findByRole('button', { name: '再送' });
  return view;
}

const lookups = () => stub.entries.filter((e) => e.url.includes('/client-messages/'));

describe('#3258: 新しい会話で open の前に中断した送信の後は、会話を取り直してから送る', () => {
  it('受け取り済みなら、直した本文を同じ会話へ送る（attachment_conflict にならない）', async () => {
    await sendWithAttachmentAndAbort();
    const firstId = posted[0]?.clientMessageId as string;
    fireEvent.change(await box(), { target: { value: '直した本文' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(lookups()[0]?.url).toContain(`/client-messages/${firstId}`);
    expect(posted[1]).toMatchObject({
      text: '直した本文',
      conversationId: A,
      attachments: [MINE.id],
    });
    expect(posted[1]?.clientMessageId).not.toBe(firstId);
    expect(screen.queryByText(/attachment_conflict|結び付いている/)).toBeNull();
  });

  it('「再送」（中身が同じ）は、最初の clientMessageId を取り直した会話へ送る（重複の 200 になる形）', async () => {
    await sendWithAttachmentAndAbort();
    const firstId = posted[0]?.clientMessageId as string;
    fireEvent.click(await screen.findByRole('button', { name: '再送' }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ conversationId: A, clientMessageId: firstId });
  });

  it('受け取っていなければ（404）、今までどおり新しい会話として送る', async () => {
    received = false;
    lookup = () => json({ error: '受け取っていない' }, 404);
    await sendWithAttachmentAndAbort();
    fireEvent.change(await box(), { target: { value: '直した本文' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(lookups()).toHaveLength(2);
    expect(posted[1]?.conversationId).toBeUndefined();
    expect(posted[1]?.attachments).toEqual([MINE.id]);
  });

  it('引けなかった（一時的な失敗）ときは、黙って新しい会話として送らない。案内を出し、入力は残る', async () => {
    lookup = () => json({ error: '一時的に失敗' }, 503);
    await sendWithAttachmentAndAbort();
    fireEvent.change(await box(), { target: { value: '直した本文' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(lookups()).toHaveLength(2));
    await act(async () => {});
    expect(posted).toHaveLength(1);
    expect(await screen.findByText(/受け取られたか確かめられなかった/)).toBeTruthy();
    expect((await box()).value).toBe('直した本文');
    lookup = () => json({ conversationId: A });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ conversationId: A });
  });
});
