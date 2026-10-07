// @vitest-environment jsdom
/**
 * 会話の中の承認カードも、承認の画面と同じ規則で書きかけを畳む。送った分だけ消し、
 * 応答を待つ間に打ち足した分と、送らなかった本文は残す。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const A = 'conv-3861-a';
const PLACEHOLDER = /答える（書いておくと/;

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
  sessionStorage.clear();
  storeTestBaseUrl();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const APPROVAL = {
  id: 'ap-1',
  createdAt: '2026-08-20T00:00:05.000Z',
  updatedAt: '2026-08-20T00:00:05.000Z',
  question: '本番に出してよいか',
};

function setup() {
  let answers = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  stubFetch(async (url) => {
    if (url.includes('/approvals/ap-1/answer')) {
      await gate;
      answers += 1;
      return json({ ok: true });
    }
    if (url.includes('/approvals')) {
      return json({
        approvals: [APPROVAL],
      });
    }
    if (url.includes(`/conversations/${A}`)) {
      return json({ conversationId: A, messages: [], scanned: 0, reachedStart: true });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    throw new TypeError(`Failed to fetch: ${url}`);
  });
  const router = createMemoryRouter([{ path: '/chat/:conversationId', Component: Harness }], {
    initialEntries: [`/chat/${A}`],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  // 取り直しは未回答のまま返す。カードが回答済みへ変わると欄ごと消えるので、残った中身を見られない。
  return { release, answers: () => answers };
}

/** 送信中はボタンが止まる。 */
function sending(): boolean {
  return (screen.getByRole('button', { name: '許可' }) as HTMLButtonElement).disabled;
}

describe('承認カードの書きかけは、答えが通ったとき送った分だけ畳む', () => {
  it('回答の送信中に打ち足した分は、成功のあとも欄に残る', async () => {
    const { release, answers } = setup();
    const field = (await screen.findByPlaceholderText(PLACEHOLDER)) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '送る回答' } });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    await waitFor(() => expect(sending()).toBe(true));
    fireEvent.change(field, { target: { value: '送る回答 と打ち足し' } });
    release();
    await waitFor(() => expect(answers()).toBe(1));
    await waitFor(() => expect(sending()).toBe(false));
    expect(field.value).toBe('送る回答 と打ち足し');
  });

  it('送ったままの回答は、成功のあとに畳まれる', async () => {
    const { release, answers } = setup();
    const field = (await screen.findByPlaceholderText(PLACEHOLDER)) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '送る回答' } });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    await waitFor(() => expect(sending()).toBe(true));
    release();
    await waitFor(() => expect(answers()).toBe(1));
    await waitFor(() => expect(field.value).toBe(''));
  });

  it('許可を押したとき、欄の書きかけは送っていないので残る', async () => {
    const { release, answers } = setup();
    const field = (await screen.findByPlaceholderText(PLACEHOLDER)) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '書きかけの本文' } });
    fireEvent.click(screen.getByRole('button', { name: '許可' }));
    release();
    await waitFor(() => expect(answers()).toBe(1));
    await waitFor(() => expect(sending()).toBe(false));
    expect(field.value).toBe('書きかけの本文');
  });
});
