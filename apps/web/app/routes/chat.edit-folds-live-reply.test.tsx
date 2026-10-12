// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '@alteroid/swr';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat, { pendingOwnLines } from './chat';

const CONVERSATION_ID = 'conv-fold-live';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  useJournalLive();
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

// 実アプリと同じく1本の route（`chat/:conversationId?`）
function renderChat(initial: string) {
  const router = createMemoryRouter([{ path: '/chat/:conversationId?', Component: Harness }], {
    initialEntries: [initial],
  });
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
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

describe('返答の流れている最中に、過去の発言を編集して確定する（#4546）', () => {
  it('編集で畳まれた発言と、その途中の返答は、履歴の読み直しの後に表へ出続けない', async () => {
    const afterSend = gate();
    const afterEdit = gate();
    const finish = gate();
    let phase: 0 | 1 | 2 = 0;
    let chatCalls = 0;
    let sentClientMessageId = '';

    const route: Route = (url, init) => {
      if (url.endsWith('/journal/stream')) {
        return sse(
          [
            { event: 'open', data: { ok: true } },
            {
              event: 'exchange',
              data: {
                type: 'exchange',
                id: 'evt-1',
                at: '2026-08-20T00:00:10.000Z',
                with: 'human',
                role: 'inbound',
                text: '合図1',
                conversationId: CONVERSATION_ID,
              },
              after: afterSend.promise,
            },
            {
              event: 'exchange',
              data: {
                type: 'exchange',
                id: 'evt-2',
                at: '2026-08-20T00:00:11.000Z',
                with: 'human',
                role: 'inbound',
                text: '合図2',
                conversationId: CONVERSATION_ID,
              },
              after: afterEdit.promise,
            },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return sse(
            [
              { event: 'open', data: { conversationId: CONVERSATION_ID } },
              { event: 'text', data: { type: 'text', text: '途中の返答' } },
              { event: 'done', data: { type: 'done' }, after: finish.promise },
            ],
            { signal: init?.signal },
          );
        }
        return sse([{ event: 'open', data: { conversationId: CONVERSATION_ID } }], {
          keepOpen: true,
          signal: init?.signal,
        });
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        const base = [
          { id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: '元の文' },
          { id: 'm1r', at: '2026-08-20T00:00:01.000Z', role: 'outbound', text: '元の返事' },
        ];
        if (phase === 0) return json({ conversationId: CONVERSATION_ID, messages: base });
        const second = {
          id: 'm2',
          at: '2026-08-20T00:00:05.000Z',
          role: 'inbound',
          text: '続きの発言',
          clientMessageId: sentClientMessageId,
        };
        if (phase === 1) {
          return json({ conversationId: CONVERSATION_ID, messages: [...base, second] });
        }
        // 編集 m4 が m1 の位置から手前までを畳む。途中の返答 m3 は m4 より前に日誌へ書かれる
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            { ...base[0], supersededBy: 'm4' },
            { ...base[1], supersededBy: 'm4' },
            { ...second, supersededBy: 'm4' },
            {
              id: 'm3',
              at: '2026-08-20T00:00:06.000Z',
              role: 'outbound',
              text: '途中の返答',
              supersededBy: 'm4',
            },
            {
              id: 'm4',
              at: '2026-08-20T00:00:07.000Z',
              role: 'inbound',
              text: '直した文',
              supersedes: 'm1',
            },
          ],
        });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    };
    stubFetch(route);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request && input.url.endsWith('/chat') && chatCalls === 0) {
        const body = JSON.parse(await input.clone().text()) as { clientMessageId: string };
        sentClientMessageId = body.clientMessageId;
      }
      return inner(input, init);
    }) as typeof fetch;

    renderChat(`/chat/${CONVERSATION_ID}`);
    await screen.findByText('元の文');

    const box = await screen.findByPlaceholderText(/クローンに話しかける/);
    fireEvent.change(box, { target: { value: '続きの発言' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    expect(await screen.findByText('途中の返答')).toBeTruthy();

    // 履歴にも続きの発言が載り、手元の行は引き取られる
    phase = 1;
    afterSend.open();
    await waitFor(() => {
      expect(within(transcript()).getAllByText('続きの発言')).toHaveLength(1);
    });

    const row = within(transcript()).getByText('元の文').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '発言を編集' }));
    const textarea = await screen.findByRole('textbox', { name: '発言を編集する下書き' });
    fireEvent.change(textarea, { target: { value: '直した文' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(chatCalls).toBe(2);
    });

    phase = 2;
    afterEdit.open();
    await within(transcript()).findByText('直した文');
    await waitFor(() => {
      expect(within(transcript()).queryByText('元の文')).toBeNull();
    });

    // 受信が終わった後でも（受信中だから残っているのではないことを確かめる）
    finish.open();
    await screen.findByText('返信が終わった');
    expect(within(transcript()).queryByText('続きの発言')).toBeNull();
    expect(within(transcript()).queryByText('途中の返答')).toBeNull();
  });
});

describe('pendingOwnLines は、編集で畳まれた返答と同じ本文の手元の返答も引き取る（#4546）', () => {
  const C = 'conv-4546';
  const clone = (key: string, text: string, group = 'g1') => ({
    key,
    role: 'clone' as const,
    text,
    of: C,
    replyGroup: group,
  });
  const human = (key: string, text: string) => ({ key, role: 'human' as const, text, of: C });

  it('畳まれた返答に当たる手元の返答は落とし、当たらない返答は残す', () => {
    const lines = [clone('c1', '途中の返答'), clone('c2', '新しい返答', 'g2')];
    const pending = pendingOwnLines(lines, C, [], undefined, [clone('m3', '途中の返答')]);
    expect(pending.map((line) => line.key)).toEqual(['c2']);
  });

  it('畳まれた返答の数だけ引き取る（同じ本文の2本目は残す）', () => {
    const lines = [clone('c1', '了解', 'g1'), clone('c2', '了解', 'g2')];
    const pending = pendingOwnLines(lines, C, [], undefined, [clone('m3', '了解')]);
    expect(pending.map((line) => line.key)).toEqual(['c2']);
  });

  it('人間の行は畳まれた返答で引き取らない', () => {
    const lines = [human('h1', '途中の返答')];
    const pending = pendingOwnLines(lines, C, [], undefined, [clone('m3', '途中の返答')]);
    expect(pending.map((line) => line.key)).toEqual(['h1']);
  });

  it('対照: 畳まれた返答を渡さなければ、今までどおり残す', () => {
    const lines = [clone('c1', '途中の返答')];
    expect(pendingOwnLines(lines, C, []).map((line) => line.key)).toEqual(['c1']);
  });
});
