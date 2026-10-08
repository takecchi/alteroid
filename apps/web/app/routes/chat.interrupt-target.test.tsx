// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import Chat, { describeCloneInterruptOutcome } from './chat';

// #3956: 止めるボタンは、いま送った発言（会話 id と clientMessageId）だけを対象に渡す。
const A = 'conv-3956-a';
const TEXT = '順番待ちのはずの発言';

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

async function box() {
  return (await screen.findByPlaceholderText(/クローンに話しかける/)) as HTMLTextAreaElement;
}

async function typeAndSend(text: string) {
  fireEvent.change(await box(), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
}

function stubQueuedChat(outcomes: string[]) {
  const posted: { clientMessageId: string | undefined }[] = [];
  const interrupts: unknown[] = [];
  const stub = stubFetch((url, init) => {
    if (url.includes(`/conversations/${A}`)) return json({ conversationId: A, messages: [] });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: A } },
          { event: 'queued', data: { type: 'queued' } },
        ],
        { signal: init?.signal, keepOpen: true },
      );
    }
    if (url.endsWith('/clone/interrupt')) {
      return json({ outcome: outcomes.shift() ?? 'idle' });
    }
    return undefined;
  });
  return { stub, posted, interrupts };
}

async function bodiesOf(stub: ReturnType<typeof stubFetch>, suffix: string) {
  const out: Record<string, unknown>[] = [];
  for (const entry of stub.entries) {
    if (entry.url.endsWith(suffix) && entry.request !== undefined) {
      out.push((await entry.request.clone().json()) as Record<string, unknown>);
    }
  }
  return out;
}

async function pressInterrupt() {
  fireEvent.click(await screen.findByRole('button', { name: 'クローンのターンを止める' }));
}

describe('describeCloneInterruptOutcome（#3956 の3値）', () => {
  it('withdrawn / not_target / starting は取り下げ・止めていないこと・もう一度を言う', () => {
    expect(describeCloneInterruptOutcome('withdrawn')).toContain('取り下げ');
    expect(describeCloneInterruptOutcome('withdrawn')).toContain('送っていません');
    expect(describeCloneInterruptOutcome('not_target')).toContain('先客のターンは止めていません');
    expect(describeCloneInterruptOutcome('starting')).toContain('もう一度');
  });
});

describe('#3956: 止めるボタンは送った発言を対象にする', () => {
  it('送った発言の会話 id と clientMessageId を渡す', async () => {
    const { stub } = stubQueuedChat(['interrupted']);
    renderChat(`/chat/${A}`);
    await findShownConversation(A);
    await typeAndSend(TEXT);
    await screen.findByText('順番を待っている…');
    await pressInterrupt();

    await waitFor(() =>
      expect(stub.entries.some((e) => e.url.endsWith('/clone/interrupt'))).toBe(true),
    );
    const [chatBody] = await bodiesOf(stub, '/chat');
    const [interruptBody] = await bodiesOf(stub, '/clone/interrupt');
    expect(typeof chatBody?.clientMessageId).toBe('string');
    expect(interruptBody).toEqual({
      conversationId: A,
      clientMessageId: chatBody?.clientMessageId,
    });
  });

  it('withdrawn: 取り下げたと言い、受信を閉じ、本文を入力欄へ戻し、送り直しは新しい id', async () => {
    const { stub } = stubQueuedChat(['withdrawn']);
    renderChat(`/chat/${A}`);
    await findShownConversation(A);
    await typeAndSend(TEXT);
    await screen.findByText('順番を待っている…');
    await pressInterrupt();

    expect(await screen.findByText(describeCloneInterruptOutcome('withdrawn'))).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('順番を待っている…')).toBeNull());
    expect(screen.queryByRole('button', { name: /受信をやめる/ })).toBeNull();
    await waitFor(async () => expect((await box()).value).toBe(TEXT));

    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() =>
      expect(stub.entries.filter((e) => e.url.endsWith('/chat'))).toHaveLength(2),
    );
    const [first, second] = await bodiesOf(stub, '/chat');
    expect(second?.clientMessageId).not.toBe(first?.clientMessageId);
  });

  it('not_target は先客を止めていないと言い、入力欄には何も戻さない', async () => {
    stubQueuedChat(['not_target']);
    renderChat(`/chat/${A}`);
    await findShownConversation(A);
    await typeAndSend(TEXT);
    await pressInterrupt();

    expect(await screen.findByText(describeCloneInterruptOutcome('not_target'))).toBeTruthy();
    expect((await box()).value).toBe('');
  });

  it('starting はもう一度押すよう言い、自動では呼び直さない', async () => {
    const { stub } = stubQueuedChat(['starting', 'interrupted']);
    renderChat(`/chat/${A}`);
    await findShownConversation(A);
    await typeAndSend(TEXT);
    await pressInterrupt();

    expect(await screen.findByText(describeCloneInterruptOutcome('starting'))).toBeTruthy();
    expect(stub.entries.filter((e) => e.url.endsWith('/clone/interrupt'))).toHaveLength(1);
  });
});
