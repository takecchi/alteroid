// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-3595';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat(initial: string) {
  const router = createMemoryRouter(
    // 経路を1本にする: 2本に分けると遷移で作り直されるため
    [{ path: '/chat/:conversationId?', Component: Harness }],
    { initialEntries: [initial] },
  );
  render(
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

const COMPOSER = () => screen.getByPlaceholderText(/クローンに話しかける/);
const pencil = () => screen.getByRole('button', { name: '発言を編集' });

const answeredAt = '2026-08-20T00:01:00.000Z';
interface Approval {
  id: string;
  createdAt: string;
  updatedAt: string;
  question: string;
  answeredAt?: string;
  answer?: string;
}

function stubConversation(options: {
  approvals?: Approval[];
  onChat?: (init: RequestInit | undefined) => Response | undefined;
  endResponse?: () => Response;
}) {
  const approvals = options.approvals ?? [];
  stubFetch((url, init) => {
    const answer = /\/approvals\/([^/]+)\/answer/.exec(url);
    if (answer !== null) {
      const target = approvals.find((approval) => approval.id === answer[1]);
      if (target !== undefined) {
        target.answeredAt = answeredAt;
        target.answer = '了解';
      }
      return json({ ok: true });
    }
    if (url.includes('/approvals')) return json({ approvals });
    if (url.endsWith('/end')) return options.endResponse?.() ?? json({ ok: true });
    if (url.endsWith('/chat')) {
      return (
        options.onChat?.(init) ??
        sse([{ event: 'open', data: { conversationId: ID } }], {
          signal: init?.signal,
          keepOpen: true,
        })
      );
    }
    if (url.includes(`/conversations/${ID}`)) {
      return json({
        conversationId: ID,
        messages: [
          { id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: 'やあ' },
          { id: 'm2', at: '2026-08-20T00:00:01.000Z', role: 'outbound', text: 'こんにちは' },
        ],
        scanned: 2,
        reachedStart: true,
      });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
}

async function startEditing() {
  renderChat(`/chat/${ID}`);
  await screen.findByText('やあ');
  fireEvent.click(pencil());
  return screen.findByRole('textbox', { name: '発言を編集する下書き' });
}

describe('発言の編集を閉じたら、その発言の鉛筆へ戻る', () => {
  it('Escape で閉じる', async () => {
    stubConversation({});
    const editor = await startEditing();
    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: '発言を編集する下書き' })).toBeNull(),
    );
    expect(document.activeElement).toBe(pencil());
  });

  it('キャンセルで閉じる', async () => {
    stubConversation({});
    await startEditing();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: '発言を編集する下書き' })).toBeNull(),
    );
    expect(document.activeElement).toBe(pencil());
  });

  it('確定で閉じる（置き換わって鉛筆が消えても、入力欄へ戻り、body へは落ちない）', async () => {
    stubConversation({});
    const editor = await startEditing();
    fireEvent.change(editor, { target: { value: 'やあ、直した' } });
    fireEvent.click(screen.getByRole('button', { name: '確定' }));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: '発言を編集する下書き' })).toBeNull(),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBeNull();
  });

  it('使い手が別の所へフォーカスを動かしたあとは、取り戻さない', async () => {
    stubConversation({});
    const editor = await startEditing();
    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(pencil()));
    fireEvent.keyDown(pencil(), { key: 'Tab' });
    COMPOSER().focus();
    fireEvent.change(COMPOSER(), { target: { value: 'あ' } });
    expect(document.activeElement).toBe(COMPOSER());
  });
});

describe('承認カードに答えたら、次の未回答のカードへ戻る', () => {
  const approvals = (): Approval[] => [
    {
      id: 'ap-1',
      createdAt: '2026-08-20T00:00:05.000Z',
      updatedAt: '2026-08-20T00:00:05.000Z',
      question: '一つ目の質問',
    },
    {
      id: 'ap-2',
      createdAt: '2026-08-20T00:00:06.000Z',
      updatedAt: '2026-08-20T00:00:06.000Z',
      question: '二つ目の質問',
    },
  ];
  const cardOf = (question: string) =>
    within(screen.getByRole('list', { name: 'やりとり' }))
      .getByText(question)
      .closest('[data-approval-card]') as HTMLElement;

  it('一つ目に答えると、二つ目のカードの中へ。二つ目に答えると、入力欄へ', async () => {
    stubConversation({ approvals: approvals() });
    renderChat(`/chat/${ID}`);
    await screen.findByText('一つ目の質問');

    const first = cardOf('一つ目の質問');
    const allow = within(first).getByRole('button', { name: '許可' });
    allow.focus();
    fireEvent.click(allow);
    await waitFor(() =>
      expect(cardOf('一つ目の質問').getAttribute('data-approval-state')).toBe('answered'),
    );
    await waitFor(() => expect(cardOf('二つ目の質問').contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(document.body);

    const second = cardOf('二つ目の質問');
    const allowSecond = within(second).getByRole('button', { name: '許可' });
    allowSecond.focus();
    fireEvent.click(allowSecond);
    await waitFor(() =>
      expect(cardOf('二つ目の質問').getAttribute('data-approval-state')).toBe('answered'),
    );
    await waitFor(() => expect(document.activeElement).toBe(COMPOSER()));
  });
});

describe('「会話を終える」の確認を閉じたあと', () => {
  it('「やめる」で閉じたら、押したボタンへ戻る', async () => {
    stubConversation({});
    renderChat(`/chat/${ID}`);
    await screen.findByText('やあ');
    const trigger = screen.getByRole('button', { name: '会話を終える' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('「終える」で閉じて成功したら、入力欄へ（body へ落ちない）', async () => {
    stubConversation({});
    renderChat(`/chat/${ID}`);
    await screen.findByText('やあ');
    const trigger = screen.getByRole('button', { name: '会話を終える' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: '終える' }));
    await waitFor(() => expect(document.activeElement).toBe(COMPOSER()));
  });

  it('「終える」で閉じて失敗したら、押したボタンへ戻る', async () => {
    stubConversation({ endResponse: () => json({ error: '許可が無い' }, 403) });
    renderChat(`/chat/${ID}`);
    await screen.findByText('やあ');
    const trigger = screen.getByRole('button', { name: '会話を終える' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: '終える' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '会話を終える' })),
    );
  });
});
