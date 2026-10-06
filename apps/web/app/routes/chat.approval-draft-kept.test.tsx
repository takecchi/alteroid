// @vitest-environment jsdom
/**
 * #3398。会話の中の承認カードの書きかけ（回答欄の文・設問フォームの選択と補足）は、
 * 別の会話へ移って戻っても消えない。答えが通ったら、書きかけは捨てる。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findShownConversation,
  json,
  Providers,
  storeTestBaseUrl,
  stubFetch,
} from '~/test-support';

import Chat from './chat';

const A = 'conv-3398-a';
const B = 'conv-3398-b';

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
  sessionStorage.clear(); // 書きかけの本文は sessionStorage にも残る（#3400）。テストどうしへ持ち越さない
  storeTestBaseUrl();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const BASE = {
  id: 'ap-1',
  createdAt: '2026-08-20T00:00:05.000Z',
  updatedAt: '2026-08-20T00:00:05.000Z',
  question: '本番に出してよいか',
};

function setup(approval: Record<string, unknown>) {
  let answered = false;
  const stub = stubFetch((url, init) => {
    if (url.includes('/approvals/ap-1/answer') || init?.method === 'POST') {
      answered = true;
      return json({ ok: true });
    }
    if (url.includes('/approvals')) {
      return json({
        approvals: url.includes(A)
          ? [
              answered
                ? { ...approval, answeredAt: '2026-08-20T00:01:00.000Z', answer: 'はい' }
                : approval,
            ]
          : [],
      });
    }
    if (url.includes(`/conversations/${A}`)) {
      return json({ conversationId: A, messages: [], scanned: 0, reachedStart: true });
    }
    if (url.includes(`/conversations/${B}`)) {
      return json({ conversationId: B, messages: [], scanned: 0, reachedStart: true });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: [`/chat/${A}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  const there = async (id: string) => {
    await router.navigate(`/chat/${id}`);
    expect(await findShownConversation(id)).toBeTruthy();
  };
  return { stub, there };
}

describe('承認カードの書きかけは、会話を移って戻っても残る（#3398）', () => {
  it('回答欄に書いた文が残る', async () => {
    const { there } = setup(BASE);
    fireEvent.change(await screen.findByPlaceholderText(/答える（書いておくと/), {
      target: { value: '書きかけの回答' },
    });
    await there(B);
    await waitFor(() => expect(screen.queryByPlaceholderText(/答える（書いておくと/)).toBeNull());
    await there(A);
    const again = (await screen.findByPlaceholderText(
      /答える（書いておくと/,
    )) as HTMLTextAreaElement;
    expect(again.value).toBe('書きかけの回答');
  });

  it('設問フォームの選択と補足が残り、書きかけのあるカードは開いた状態で戻る', async () => {
    const { there } = setup({
      ...BASE,
      questions: [
        {
          id: 'q1',
          prompt: 'どこへ出すか',
          options: [
            { id: 'o1', label: '本番' },
            { id: 'o2', label: '検証' },
          ],
        },
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: '選択肢を開いて答える' }));
    fireEvent.click(screen.getByRole('radio', { name: /検証/ }));
    fireEvent.change(screen.getByLabelText(/補足/), { target: { value: '補足の書きかけ' } });

    await there(B);
    await there(A);

    // 閉じて戻らない（書いたものが隠れて見えなくならない）。
    await screen.findByRole('button', { name: '閉じる' });
    expect((screen.getByLabelText(/補足/) as HTMLTextAreaElement).value).toBe('補足の書きかけ');
    expect(
      (screen.getByRole('radio', { name: /検証/ }) as HTMLInputElement).getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
  });

  it('対照: 書いていないカードは、戻っても閉じたまま', async () => {
    const { there } = setup({
      ...BASE,
      questions: [{ id: 'q1', prompt: 'どこへ出すか', options: [{ id: 'o1', label: '本番' }] }],
    });
    await screen.findByRole('button', { name: '選択肢を開いて答える' });
    await there(B);
    await there(A);
    await screen.findByRole('button', { name: '選択肢を開いて答える' });
  });
});
