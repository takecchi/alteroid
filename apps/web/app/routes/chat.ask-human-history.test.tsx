// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '@alteroid/swr';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  useJournalLive();
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

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

async function send(text: string) {
  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
}

const CONVERSATION_ID = 'conv-ask-human';
const QUESTION_LINE = '本番に出してよいか';

describe('リロード後（＝手元の lines を経由しない状態）でも ask_human の質問・回答が消えない', () => {
  it('質問だけの確認は、SSE の文言と1文字も違えない形で historyLines から出る', async () => {
    const route: Route = (url) => {
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            {
              id: 'm1',
              at: '2026-08-20T00:00:00.000Z',
              role: 'inbound',
              text: '進めてよいか確認して',
            },
          ],
          scanned: 1,
          reachedStart: true,
        });
      }
      if (url.includes('/approvals')) {
        expect(url).toContain(`conversationId=${CONVERSATION_ID}`);
        return json({
          approvals: [
            {
              id: 'ap-1',
              createdAt: '2026-08-20T00:00:05.000Z',
              question: '本番に出してよいか',
            },
          ],
        });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    };
    stubFetch(route);

    renderChat(`/chat/${CONVERSATION_ID}`);

    await screen.findByText(QUESTION_LINE);
    const items = within(transcript()).getAllByRole('listitem');
    const texts = items.map((item) => item.textContent);
    const humanIndex = texts.findIndex((text) => text?.includes('進めてよいか確認して'));
    const questionIndex = texts.findIndex((text) => text?.includes(QUESTION_LINE));
    expect(humanIndex).toBeGreaterThanOrEqual(0);
    expect(questionIndex).toBeGreaterThan(humanIndex);
  });

  it('回答済みの確認は、1枚のカードに問い・回答済みの状態・回答が出る', async () => {
    const route: Route = (url) => {
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [],
          scanned: 0,
          reachedStart: true,
        });
      }
      if (url.includes('/approvals')) {
        return json({
          approvals: [
            {
              id: 'ap-1',
              createdAt: '2026-08-20T00:00:05.000Z',
              question: '本番に出してよいか',
              answeredAt: '2026-08-20T00:01:00.000Z',
              answer: 'はい、進めてよい',
            },
          ],
        });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    };
    stubFetch(route);

    renderChat(`/chat/${CONVERSATION_ID}`);

    await screen.findByText(QUESTION_LINE);
    expect(await screen.findByText('はい、進めてよい')).toBeTruthy();

    const items = within(transcript()).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain(QUESTION_LINE);
    expect(items[0]?.textContent).toContain('回答済');
    expect(items[0]?.textContent).toContain('回答:');
    expect(screen.queryByText(/確認への回答/)).toBeNull();
  });
});

describe('二重表示を防ぐ（生配信 → 承認の台帳、の順で同じ確認が2回現れても1つのまま）', () => {
  it('SSE の ask_human で出た質問行は、台帳から読んだ分と合流しても1つのまま残る', async () => {
    let approvalRecorded = false;
    let releaseEscalation: () => void = () => {};
    const escalationReleased = new Promise<void>((resolve) => {
      releaseEscalation = resolve;
    });

    const route: Route = (url, init) => {
      if (url.endsWith('/journal/stream')) {
        return sse(
          [
            { event: 'open', data: { ok: true } },
            {
              event: 'escalation',
              data: {
                type: 'escalation',
                id: 'esc-1',
                at: '2026-08-20T00:00:05.000Z',
                question: '本番に出してよいか',
                approvalId: 'ap-1',
              },
              after: escalationReleased,
            },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            {
              event: 'ask_human',
              data: { type: 'ask_human', approvalId: 'ap-1', question: '本番に出してよいか' },
            },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [],
          scanned: 0,
          reachedStart: true,
        });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      if (url.includes('/approvals')) {
        return json({
          approvals: approvalRecorded
            ? [
                {
                  id: 'ap-1',
                  createdAt: '2026-08-20T00:00:05.000Z',
                  question: '本番に出してよいか',
                },
              ]
            : [],
        });
      }
      return undefined;
    };
    const stub = stubFetch(route);
    const approvalsFetchCount = () => stub.calls.filter((url) => url.includes('/approvals')).length;

    renderChat(`/chat/${CONVERSATION_ID}`);

    await send('進めてよいか確認して');

    await screen.findByText(QUESTION_LINE);
    expect(within(transcript()).getAllByText(QUESTION_LINE)).toHaveLength(1);
    expect(within(transcript()).getAllByRole('listitem')).toHaveLength(2);

    approvalRecorded = true;
    const approvalsFetchesBefore = approvalsFetchCount();
    releaseEscalation();
    await waitFor(() => {
      expect(approvalsFetchCount()).toBeGreaterThan(approvalsFetchesBefore);
    });

    await waitFor(() => {
      expect(within(transcript()).getAllByText(QUESTION_LINE)).toHaveLength(1);
      expect(within(transcript()).getAllByRole('listitem')).toHaveLength(2);
    });
  });
});
