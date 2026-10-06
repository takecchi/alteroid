// @vitest-environment jsdom
/**
 * Issue #3203。`open` の前に中断された送信（#3121）について、サーバが受け取っていたかの判定は、
 * 本文の一致ではなく、**自分が送った `clientMessageId` を持つ人間の発言が履歴に現れたか**で行う。
 * 同じ本文の別の発言（別の経路から届いたもの）を、自分の発言と取り違えない。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findShownConversation,
  json,
  Providers,
  sse,
  storeTestBaseUrl,
  stubFetch,
} from '~/test-support';

import Chat from './chat';

const A = 'conv-3203-a';
const B = 'conv-3203-b';
const TEXT = '同じ本文の発言';

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

let history: unknown[] = [];
let posts = 0;
let stub: ReturnType<typeof stubFetch>;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  history = [];
  posts = 0;
  stub = stubFetch((url, init) => {
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

/** これまでの `POST /chat` の本文（openapi-fetch は `Request` で呼ぶ）。 */
async function postedBodies(): Promise<Record<string, unknown>[]> {
  return Promise.all(
    stub.entries
      .filter((entry) => entry.url.endsWith('/chat') && entry.request !== undefined)
      .map(async (entry) => (await entry.request!.clone().json()) as Record<string, unknown>),
  );
}

async function box() {
  return (await screen.findByPlaceholderText(/クローンに話しかける/)) as HTMLTextAreaElement;
}

/** 本文だけを送り、`open` の前に会話を切り替えて中断させる。 */
async function sendTextAndAbort() {
  const view = renderChat(`/chat/${A}`);
  fireEvent.change(await box(), { target: { value: TEXT } });
  fireEvent.click(screen.getByRole('button', { name: '送る' }));
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

describe('#3203: 受け取りの判定は clientMessageId で行う', () => {
  it('送るたびに clientMessageId を作って送る（形は制約の中）', async () => {
    await sendTextAndAbort();
    const bodies = await postedBodies();
    const id = bodies[0]?.clientMessageId;
    expect(typeof id).toBe('string');
    expect(id as string).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it('同じ本文の別の発言（別の id）が履歴に現れても、再送の案内が残る', async () => {
    const { router } = await sendTextAndAbort();
    history = [
      {
        id: 'm1',
        at: '2026-08-20T00:00:00Z',
        role: 'inbound',
        text: TEXT,
        clientMessageId: 'someone-elses-id',
      },
    ];
    await reopenA(router);
    await waitFor(() =>
      expect(screen.queryAllByText(TEXT).filter((el) => el.tagName !== 'TEXTAREA').length).toBe(1),
    );
    expect(await screen.findByRole('button', { name: '再送' })).toBeTruthy();
    expect(posts).toBe(1);
  });

  it('id を持たない同じ本文の発言（別の経路・古い行）でも、案内は残る', async () => {
    const { router } = await sendTextAndAbort();
    history = [{ id: 'm1', at: '2026-08-20T00:00:00Z', role: 'inbound', text: TEXT }];
    await reopenA(router);
    await waitFor(() =>
      expect(screen.queryAllByText(TEXT).filter((el) => el.tagName !== 'TEXTAREA').length).toBe(1),
    );
    expect(await screen.findByRole('button', { name: '再送' })).toBeTruthy();
  });

  it('自分の clientMessageId を持つ発言が現れたら、案内が下りる', async () => {
    const { router } = await sendTextAndAbort();
    const bodies = await postedBodies();
    history = [
      {
        id: 'm1',
        at: '2026-08-20T00:00:00Z',
        role: 'inbound',
        text: TEXT,
        clientMessageId: bodies[0]?.clientMessageId,
      },
    ];
    expect(bodies[0]?.clientMessageId).toBeTruthy();
    await reopenA(router);
    await waitFor(() => expect(screen.queryByRole('button', { name: '再送' })).toBeNull());
    expect((await box()).value).toBe('');
    expect(posts).toBe(1);
  });

  it('再送は同じ clientMessageId で送る（サーバが二重に受けないための印）', async () => {
    const { router } = await sendTextAndAbort();
    await reopenA(router);
    fireEvent.click(await screen.findByRole('button', { name: '再送' }));
    await waitFor(() => expect(posts).toBe(2));
    const bodies = await postedBodies();
    expect(bodies[1]?.clientMessageId).toBe(bodies[0]?.clientMessageId);
    expect(bodies[0]?.clientMessageId).toBeTruthy();
  });

  it('新しく送る発言には、別の clientMessageId を作る', async () => {
    const { router } = await sendTextAndAbort();
    await reopenA(router);
    fireEvent.click(await screen.findByRole('button', { name: '破棄' }));
    fireEvent.change(await box(), { target: { value: TEXT } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    await waitFor(() => expect(posts).toBe(2));
    const bodies = await postedBodies();
    expect(bodies[1]?.clientMessageId).toBeTruthy();
    expect(bodies[1]?.clientMessageId).not.toBe(bodies[0]?.clientMessageId);
  });
});
