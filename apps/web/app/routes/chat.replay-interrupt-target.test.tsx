// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, stubFetch, storeTestBaseUrl } from '~/test-support';

import Chat, { describeCloneInterruptOutcome } from './chat';

const ID = 'conv-3990';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderApp(initial: string) {
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

type Pending = { clientMessageId: string; state: string }[];
const NO_TARGET = '止める対象が分からないので、何も止めていません';

/** 再読み込み後の再生。`pending` を省くと、運ばない古いデーモン。 */
function setup(pending: Pending | undefined, outcome = 'interrupted') {
  return stubFetch((url, init) => {
    if (/\/chat\/[^/]+\/stream$/.test(url)) {
      return sse(
        [
          {
            event: 'open',
            data: {
              conversationId: ID,
              inProgress: true,
              ...(pending === undefined ? {} : { pending }),
            },
          },
          { event: 'text', data: { type: 'text', text: '走っているターンの途中' } },
        ],
        { signal: init?.signal, delayMs: 0, keepOpen: true },
      );
    }
    if (url.endsWith('/clone/interrupt')) return json({ outcome });
    if (url.includes(`/conversations/${ID}`)) return json({ conversationId: ID, messages: [] });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
}

async function press() {
  renderApp(`/chat/${ID}`);
  expect(await screen.findByText('走っているターンの途中')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'クローンのターンを止める' }));
}

const interrupts = (stub: { entries: { url: string }[] }) =>
  stub.entries.filter((entry) => entry.url.endsWith('/clone/interrupt'));

async function bodyOf(stub: ReturnType<typeof setup>): Promise<unknown> {
  await waitFor(() => expect(interrupts(stub)).toHaveLength(1));
  return interrupts(stub)[0] !== undefined
    ? stub.entries
        .filter((e) => e.url.endsWith('/clone/interrupt'))[0]
        ?.request?.clone()
        .json()
    : undefined;
}

describe('再読み込み後・戻ってきた会話の再生中に「ターンを止める」を押す（#3990）', () => {
  it('running があれば、その発言を対象に付けて止める', async () => {
    const stub = setup([
      { clientMessageId: 'queued-1', state: 'queued' },
      { clientMessageId: 'run-1', state: 'running' },
      { clientMessageId: 'run-2', state: 'running' },
    ]);
    await press();
    expect(await bodyOf(stub)).toEqual({ conversationId: ID, clientMessageId: 'run-1' });
    expect(await screen.findByText(describeCloneInterruptOutcome('interrupted'))).toBeTruthy();
  });

  it('running が無ければ、starting の先頭を対象にする', async () => {
    const stub = setup([
      { clientMessageId: 'held-1', state: 'held' },
      { clientMessageId: 'msg-starting', state: 'starting' },
    ]);
    await press();
    expect(await bodyOf(stub)).toEqual({ conversationId: ID, clientMessageId: 'msg-starting' });
  });

  it('held・queued だけなら対象にせず、呼ばずに「止める対象が分からない」と言う', async () => {
    const stub = setup([
      { clientMessageId: 'held-1', state: 'held' },
      { clientMessageId: 'queued-1', state: 'queued' },
    ]);
    await press();
    expect(await screen.findByText(new RegExp(NO_TARGET))).toBeTruthy();
    expect(interrupts(stub)).toHaveLength(0);
  });

  it('pending を運ばない古いデーモンも、呼ばずに「止める対象が分からない」と言う', async () => {
    const stub = setup(undefined);
    await press();
    expect(await screen.findByText(new RegExp(NO_TARGET))).toBeTruthy();
    expect(interrupts(stub)).toHaveLength(0);
  });

  it('withdrawn: 再生の流れを閉じ、本文は手元に無いので入力欄へ戻していないと言う', async () => {
    const stub = setup([{ clientMessageId: 'run-1', state: 'running' }], 'withdrawn');
    await press();
    await bodyOf(stub);
    expect(await screen.findByText(/入力欄へは戻していません/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /受信をやめる/ })).toBeNull();
    });
    expect((screen.getByPlaceholderText(/クローンに話しかける/) as HTMLTextAreaElement).value).toBe(
      '',
    );
  });
});
