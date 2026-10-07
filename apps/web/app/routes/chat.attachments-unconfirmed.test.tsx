// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findShownConversation,
  json,
  Providers,
  sse,
  storeTestBaseUrl,
  stubFetch,
} from '~/test-support';

import Chat from './chat';

const A = 'conv-att-a';
const B = 'conv-att-b';

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

const meta = (id: string) => ({
  id,
  name: `${id}.png`,
  mediaType: 'image/png',
  size: 4,
  sha256: 'a'.repeat(64),
});
const MINE = meta('att-mine');
const OTHER = meta('att-other');

let history: unknown[] = [];
let originalFetch: typeof fetch;
let posts = 0;
let stub: ReturnType<typeof stubFetch>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  history = [];
  posts = 0;
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:fake-${(n += 1)}`);
  URL.revokeObjectURL = vi.fn();
  stub = stubFetch((url, init) => {
    if (url.includes('/attachments?')) return json(MINE);
    if (url.includes('/attachments/')) return new Response(new Uint8Array([1, 2, 3, 4]));
    if (url.includes(`/conversations/${A}`)) return json({ conversationId: A, messages: history });
    if (url.includes(`/conversations/${B}`)) return json({ conversationId: B, messages: [] });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    if (url.endsWith('/chat')) {
      posts += 1;
      if (posts === 1) {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }
      return sse([{ event: 'open', data: { conversationId: A } }], { signal: init?.signal });
    }
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function firstPostedClientMessageId(stub: ReturnType<typeof stubFetch>): Promise<string> {
  const entry = stub.entries.find((e) => e.url.endsWith('/chat') && e.request !== undefined);
  const body = (await entry?.request?.clone().json()) as { clientMessageId?: string } | undefined;
  expect(body?.clientMessageId).toBeTruthy();
  return body?.clientMessageId as string;
}

const nodeFile = () =>
  new NodeFile([new Uint8Array([1, 2, 3, 4])], 'mine.png', {
    type: 'image/png',
  }) as unknown as File;

async function sendAttachmentOnlyAndAbort() {
  const view = renderChat(`/chat/${A}`);
  await screen.findByPlaceholderText(/クローンに話しかける/);
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [nodeFile()], configurable: true });
  fireEvent.change(input);
  await screen.findByRole('button', { name: 'mine.png を外す' });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
  await waitFor(() => expect(posts).toBe(1));
  await view.router.navigate(`/chat/${B}`);
  expect(await findShownConversation(B)).toBeTruthy();
  await act(async () => {});
  return view;
}

async function reopenA(router: { navigate: (to: string) => Promise<void> }) {
  await router.navigate(`/chat/${A}`);
  expect(await findShownConversation(A)).toBeTruthy();
  await act(async () => {});
}

describe('添付つきの中断も、clientMessageId で受け取りを判定する（添付 id では見ない。#3203）', () => {
  it('別の発言（本文も空・添付も別・別の clientMessageId）が履歴に現れても下ろさない（再送の案内が残る）', async () => {
    const { router } = await sendAttachmentOnlyAndAbort();
    history = [
      { id: 'm1', at: '2026-08-20T00:00:00Z', role: 'inbound', text: '', attachments: [OTHER] },
    ];
    await reopenA(router);
    expect(await screen.findByAltText('att-other.png')).toBeTruthy();
    expect(await screen.findByRole('button', { name: '再送' })).toBeTruthy();
    expect(posts).toBe(1);
  });

  it('自分の clientMessageId を持つ発言が現れたら下ろす', async () => {
    const { router } = await sendAttachmentOnlyAndAbort();
    history = [
      {
        id: 'm1',
        at: '2026-08-20T00:00:00Z',
        role: 'inbound',
        text: '',
        attachments: [MINE],
        clientMessageId: await firstPostedClientMessageId(stub),
      },
    ];
    await reopenA(router);
    expect(await screen.findByAltText('att-mine.png')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: '再送' })).toBeNull());
    expect(posts).toBe(1);
  });
});
