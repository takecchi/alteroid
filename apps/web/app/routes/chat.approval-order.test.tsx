// @vitest-environment jsdom
/**
 * #3396。生配信の承認カードは、台帳から取り直したあとも、**起きた順**（自分の発言 → 本文 → 質問）
 * のまま出る。手元の行（送った発言・受信中の本文）は履歴の後ろに置くので、カードを履歴の側へ
 * 渡すと、それらより上に出てしまっていた。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-3396';
const QUESTION = '本番に出してよいか';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
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

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** 送って、`ask_human` を受け、台帳が承認を返すところまで進める。 */
async function sendAndAsk(frames: { event: string; data: unknown }[]) {
  const done = gate();
  // `ask_human` は、台帳に承認が載ってから流す（流れた時点の取り直しが、承認を取れるように）。
  const ask = gate();
  let approvals: unknown[] = [];
  stubFetch((url, init) => {
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: ID } },
          ...frames.map((frame) =>
            frame.event === 'ask_human' ? { ...frame, after: ask.promise } : frame,
          ),
          { event: 'done', data: { type: 'done' }, after: done.promise },
        ],
        { signal: init?.signal },
      );
    }
    if (url.includes('/approvals')) return json({ approvals });
    if (url.includes(`/conversations/${ID}`)) {
      return json({ conversationId: ID, messages: [], scanned: 0, reachedStart: true });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: [`/chat/${ID}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  fireEvent.change(await screen.findByPlaceholderText(/クローンに話しかける/), {
    target: { value: '出して' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
  await screen.findByText('考えている…');
  const now = new Date().toISOString();
  approvals = [
    { id: 'ap-1', createdAt: now, updatedAt: now, question: QUESTION, context: '台帳の文脈' },
  ];
  ask.open();
  await screen.findByText('台帳の文脈');
  return { done };
}

const order = () =>
  within(screen.getByRole('list', { name: 'やりとり' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');

const indexOf = (items: string[], text: string) => items.findIndex((item) => item.includes(text));

describe('生配信の承認カードは、取り直しのあとも起きた順に並ぶ（#3396）', () => {
  it('発言 → 本文 → 質問（取り直したカードが、手元の発言・本文より上へ回らない）', async () => {
    await sendAndAsk([
      { event: 'text', data: { type: 'text', text: '確認させてください' } },
      {
        event: 'ask_human',
        data: { type: 'ask_human', approvalId: 'ap-1', question: QUESTION },
      },
    ]);
    const items = order();
    expect(indexOf(items, '出して')).toBeGreaterThanOrEqual(0);
    expect(indexOf(items, '出して')).toBeLessThan(indexOf(items, '確認させてください'));
    expect(indexOf(items, '確認させてください')).toBeLessThan(indexOf(items, QUESTION));
    // 履歴の側と手元の側で二重に出ない。
    expect(items.filter((item) => item.includes(QUESTION))).toHaveLength(1);
  });

  it('発言だけのあとの質問も、発言の後ろに出る', async () => {
    await sendAndAsk([
      {
        event: 'ask_human',
        data: { type: 'ask_human', approvalId: 'ap-1', question: QUESTION },
      },
    ]);
    const items = order();
    expect(indexOf(items, '出して')).toBeLessThan(indexOf(items, QUESTION));
    expect(items.filter((item) => item.includes(QUESTION))).toHaveLength(1);
  });

  it('ターンが終わって履歴が引き取っても、カードは二重にも消えもしない', async () => {
    const { done } = await sendAndAsk([
      { event: 'text', data: { type: 'text', text: '確認させてください' } },
      {
        event: 'ask_human',
        data: { type: 'ask_human', approvalId: 'ap-1', question: QUESTION },
      },
    ]);
    // ターンが終われば、履歴の側が引き取る。カードが二重にならず、消えもしない。
    done.open();
    await waitFor(() => expect(screen.queryByText('考えている…')).toBeNull());
    await waitFor(() => {
      expect(order().filter((item) => item.includes(QUESTION))).toHaveLength(1);
    });
  });
});
