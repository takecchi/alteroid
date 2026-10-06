// @vitest-environment jsdom
/**
 * 会話のログの承認カードを、生配信の `ask_human` とターンの終わりで取り直す（#3299）。
 *
 * ターン中に出たカードは質問文だけの最小の形（`approvalFromAskEvent`）で、台帳から読み直さない限り
 * context や設問が無いまま、別の場所（CLI・承認の画面・別タブ）で答えられても未回答のまま押せた。
 *
 * 1. `ask_human` を受けたら会話の承認を取り直し、カードが台帳の中身（設問）になる
 * 2. 取り直しで書きかけの回答が消えない（カードの key が承認 id のまま変わらない）
 * 3. ターンが終わったとき、別の場所で答えられた承認は回答済みになり、押せなくなる
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

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

const ID = 'conv-refetch';
const QUESTION = '本番に出してよいか';

interface Approval {
  id: string;
  createdAt: string;
  updatedAt: string;
  question: string;
  context?: string;
  answeredAt?: string;
  answer?: string;
  questions?: unknown[];
}

const PENDING: Approval = {
  id: 'ap-1',
  createdAt: '2026-08-20T00:00:05.000Z',
  updatedAt: '2026-08-20T00:00:05.000Z',
  question: QUESTION,
};

function setup() {
  let approvals: Approval[] = [];
  let releaseDone: () => void = () => {};
  const doneReleased = new Promise<void>((resolve) => {
    releaseDone = resolve;
  });
  const route: Route = (url, init) => {
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: ID } },
          {
            event: 'ask_human',
            data: { type: 'ask_human', approvalId: 'ap-1', question: QUESTION },
          },
          { event: 'done', data: { type: 'done' }, after: doneReleased },
        ],
        { signal: init?.signal },
      );
    }
    if (url.includes(`/conversations/${ID}`)) {
      return json({ conversationId: ID, messages: [], scanned: 0, reachedStart: true });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    if (url.includes('/approvals')) return json({ approvals });
    return undefined;
  };
  const stub = stubFetch(route);
  return {
    setApprovals: (next: Approval[]) => {
      approvals = next;
    },
    releaseDone,
    approvalsFetchCount: () => stub.calls.filter((url) => url.includes('/approvals')).length,
  };
}

async function renderAndSend() {
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
  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: '確認して' } });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
}

describe('会話の承認カードの取り直し（#3299）', () => {
  it('ask_human を受けたら承認を取り直し、最小の形だったカードが設問を持つ', async () => {
    const { setApprovals } = setup();
    await renderAndSend();
    setApprovals([
      {
        ...PENDING,
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
    ]);

    await screen.findByText(QUESTION);
    await screen.findByRole('button', { name: '選択肢を開いて答える' });
  });

  it('取り直しで書きかけの回答が消えない', async () => {
    const { setApprovals, releaseDone, approvalsFetchCount } = setup();
    await renderAndSend();
    setApprovals([PENDING]);

    await screen.findByText(QUESTION);
    const box = await screen.findByPlaceholderText(/答える（書いておくと/);
    fireEvent.change(box, { target: { value: '書きかけ' } });

    // ターンの終わりの取り直し（context が増えた台帳）を挟んでも、同じカードの下書きが残る。
    const before = approvalsFetchCount();
    setApprovals([{ ...PENDING, context: '補足の文脈' }]);
    releaseDone();
    await screen.findByText('補足の文脈');
    expect(approvalsFetchCount()).toBeGreaterThan(before);
    expect((screen.getByPlaceholderText(/答える（書いておくと/) as HTMLTextAreaElement).value).toBe(
      '書きかけ',
    );
  });

  it('別の場所で答えられた承認は、ターンの終わりの取り直しで回答済みになり押せなくなる', async () => {
    const { setApprovals, releaseDone } = setup();
    await renderAndSend();
    setApprovals([PENDING]);

    await screen.findByText(QUESTION);
    await screen.findByRole('button', { name: '許可' });

    setApprovals([
      {
        ...PENDING,
        answeredAt: '2026-08-20T00:01:00.000Z',
        updatedAt: '2026-08-20T00:01:00.000Z',
        answer: 'CLI から答えた',
      },
    ]);
    releaseDone();

    await screen.findByText('CLI から答えた');
    await waitFor(() => expect(screen.queryByRole('button', { name: '許可' })).toBeNull());
  });
});
