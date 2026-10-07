// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadApprovalDrafts, saveApprovalDrafts } from '@alteroid/logic';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONV = 'conv-3481';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

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

const BASE = {
  id: 'ap-1',
  createdAt: '2026-10-06T00:00:05.000Z',
  updatedAt: '2026-10-06T00:00:05.000Z',
  question: '本番に出してよいか',
};

function mount(options: { approvalsFail?: boolean; extra?: Record<string, unknown> } = {}) {
  let answered = false;
  stubFetch((url, init) => {
    if (init?.method === 'POST' && url.includes('/approvals/ap-1/answer')) {
      answered = true;
      return json({ ok: true });
    }
    if (url.includes('/approvals')) {
      if (options.approvalsFail === true) return new Response('boom', { status: 500 });
      return json({
        approvals: [
          answered
            ? { ...BASE, answeredAt: '2026-10-06T00:01:00.000Z', answer: 'はい' }
            : { ...BASE, ...options.extra },
        ],
      });
    }
    if (url.includes(`/conversations/${CONV}`)) {
      return json({ conversationId: CONV, messages: [], scanned: 0, reachedStart: true });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  const router = createMemoryRouter(
    [
      {
        path: '/chat/:conversationId',
        Component: () => <ChatRoute loaderData={{ conversationId: CONV }} />,
      },
    ],
    { initialEntries: [`/chat/${CONV}`] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const answerBox = () => screen.findByPlaceholderText(/答える（書いておくと/);

describe('会話の中の承認カードの書きかけは、画面を離れても再読み込みしても残る（#3481）', () => {
  it('回答欄の文: 承認の画面と同じ保存先に書かれ、unmount → 再描画で戻る', async () => {
    const first = mount();
    fireEvent.change(await answerBox(), { target: { value: '書きかけの回答' } });
    await waitFor(() => expect(loadApprovalDrafts().texts).toEqual({ 'ap-1': '書きかけの回答' }));

    first.unmount();
    cleanup();
    mount();
    expect(((await answerBox()) as HTMLTextAreaElement).value).toBe('書きかけの回答');
  });

  it('承認の画面で書いた続きが、会話のカードに出る', async () => {
    saveApprovalDrafts({ texts: { 'ap-1': '承認の画面で書いた' }, questions: {} });
    mount();
    expect(((await answerBox()) as HTMLTextAreaElement).value).toBe('承認の画面で書いた');
  });

  it('設問の選択・補足も残り、書きかけのあるカードは開いた状態で戻る', async () => {
    saveApprovalDrafts({
      texts: {},
      questions: {
        'ap-1': {
          drafts: { q1: { chosen: ['o2'], other: '', otherOn: false } },
          supplement: '補足の書きかけ',
        },
      },
    });
    mount({
      extra: {
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
      },
    });
    await screen.findByRole('button', { name: '閉じる' });
    expect((screen.getByLabelText(/補足/) as HTMLTextAreaElement).value).toBe('補足の書きかけ');
    fireEvent.change(screen.getByLabelText(/補足/), { target: { value: '補足を直した' } });
    await waitFor(() =>
      expect(loadApprovalDrafts().questions['ap-1']?.supplement).toBe('補足を直した'),
    );
  });

  it('回答が通ったら、保存した書きかけを消す', async () => {
    mount();
    fireEvent.change(await answerBox(), { target: { value: '答え' } });
    await waitFor(() => expect(loadApprovalDrafts().texts['ap-1']).toBe('答え'));
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    await waitFor(() => expect(loadApprovalDrafts()).toEqual({ texts: {}, questions: {} }));
    expect(sessionStorage.getItem('alteroid.approvalDrafts')).toBeNull();
  });

  it('承認の一覧を取れなかったときは、保存した書きかけを消さない。ほかの会話の書きかけにも触らない', async () => {
    saveApprovalDrafts({ texts: { 'ap-1': '残す', 'ap-other': '別の会話の分' }, questions: {} });
    mount({ approvalsFail: true });
    await screen.findByPlaceholderText(/クローンに話しかける/);
    await waitFor(() =>
      expect(loadApprovalDrafts().texts).toEqual({ 'ap-1': '残す', 'ap-other': '別の会話の分' }),
    );
  });

  it('別経路で回答済みになった承認の書きかけは、一覧が読めたときだけ消える（ほかの会話の分は残る）', async () => {
    saveApprovalDrafts({ texts: { 'ap-1': '古い', 'ap-other': '別の会話の分' }, questions: {} });
    stubFetch((url) => {
      if (url.includes('/approvals')) {
        return json({
          approvals: [{ ...BASE, answeredAt: '2026-10-06T00:01:00.000Z', answer: 'はい' }],
        });
      }
      if (url.includes(`/conversations/${CONV}`)) {
        return json({ conversationId: CONV, messages: [], scanned: 0, reachedStart: true });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });
    const router = createMemoryRouter(
      [
        {
          path: '/chat/:conversationId',
          Component: () => <ChatRoute loaderData={{ conversationId: CONV }} />,
        },
      ],
      { initialEntries: [`/chat/${CONV}`] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    await waitFor(() => expect(loadApprovalDrafts().texts).toEqual({ 'ap-other': '別の会話の分' }));
  });
});
