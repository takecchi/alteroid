// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

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

const ID = 'conv-card';
const transcript = () => screen.getByRole('list', { name: 'やりとり' });
const texts = () =>
  within(transcript())
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '');

interface Approval {
  id: string;
  createdAt: string;
  updatedAt: string;
  question: string;
  answeredAt?: string;
  answer?: string;
  questions?: unknown[];
}

function stubTimeline(options: { approval: Approval }) {
  let approval = options.approval;
  let answered = false;
  const route: Route = (url) => {
    if (url.includes('/approvals/ap-1/answer')) {
      answered = true;
      approval = {
        ...approval,
        answeredAt: '2026-08-20T00:01:00.000Z',
        updatedAt: '2026-08-20T00:01:00.000Z',
        answer: 'はい、進めてよい',
      };
      return json({ ok: true });
    }
    if (url.includes('/approvals')) return json({ approvals: [approval] });
    if (url.includes(`/conversations/${ID}`)) {
      return json({
        conversationId: ID,
        messages: [
          {
            id: 'm1',
            at: '2026-08-20T00:00:00.000Z',
            role: 'inbound',
            text: '進めてよいか確認して',
          },
          { id: 'm2', at: '2026-08-20T00:00:03.000Z', role: 'outbound', text: '確認を積んだ' },
          ...(answered
            ? [
                {
                  id: 'm3',
                  at: '2026-08-20T00:01:05.000Z',
                  role: 'outbound',
                  text: '承知した。進める',
                },
              ]
            : []),
        ],
        scanned: 3,
        reachedStart: true,
      });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  };
  const stub = stubFetch(route);
  const answerBodies = async () =>
    Promise.all(
      stub.entries
        .filter((entry) => entry.url.includes('/approvals/ap-1/answer'))
        .map((entry) => entry.request?.clone().json() as Promise<unknown>),
    );
  return { answerBodies };
}

const UNANSWERED: Approval = {
  id: 'ap-1',
  createdAt: '2026-08-20T00:00:05.000Z',
  updatedAt: '2026-08-20T00:00:05.000Z',
  question: '本番に出してよいか',
};

describe('会話の中の承認のカード（#3259）', () => {
  it('未回答のカードから答えると、同じカードが回答済みになり、クローンの返答がその後ろに並ぶ', async () => {
    const { answerBodies } = stubTimeline({ approval: UNANSWERED });
    renderChat(`/chat/${ID}`);

    await screen.findByText('本番に出してよいか');
    expect(texts()).toEqual([
      expect.stringContaining('進めてよいか確認して'),
      expect.stringContaining('確認を積んだ'),
      expect.stringContaining('未回答'),
    ]);

    fireEvent.click(screen.getByRole('button', { name: '許可' }));

    await screen.findByText('はい、進めてよい');
    window.dispatchEvent(new Event('focus'));
    await screen.findByText('承知した。進める');
    expect(await answerBodies()).toEqual([{ answer: 'はい、進めてよい' }]);
    expect(texts()).toEqual([
      expect.stringContaining('進めてよいか確認して'),
      expect.stringContaining('確認を積んだ'),
      expect.stringMatching(/回答済.*本番に出してよいか.*はい、進めてよい/),
      expect.stringContaining('承知した。進める'),
    ]);
  });

  it('設問つきの承認は、カードに設問を開く口が出る', async () => {
    stubTimeline({
      approval: {
        ...UNANSWERED,
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
    renderChat(`/chat/${ID}`);

    await screen.findByText('本番に出してよいか');
    expect(screen.getByRole('button', { name: '選択肢を開いて答える' })).toBeTruthy();
  });

  it('承認の詳細への導線がある（日付なしの入口。そこで正しい日へ移る）', async () => {
    stubTimeline({ approval: UNANSWERED });
    renderChat(`/chat/${ID}`);

    await screen.findByText('本番に出してよいか');
    const link = screen.getByRole('link', { name: /承認の画面で開く/ });
    expect(link.getAttribute('href')).toBe(`/approvals/item/${UNANSWERED.id}`);
  });

  it('回答済みで読み込まれたカードは、回答の時刻もカードの中に出る', async () => {
    stubTimeline({
      approval: {
        ...UNANSWERED,
        answeredAt: '2026-08-20T00:01:00.000Z',
        answer: '検証へ',
      },
    });
    renderChat(`/chat/${ID}`);

    await screen.findByText('検証へ');
    await waitFor(() => expect(texts().join('\n')).toContain('回答:'));
  });
});
