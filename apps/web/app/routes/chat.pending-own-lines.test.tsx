// @vitest-environment jsdom
// 「履歴が引き取ったか」で刈る形は見送った: 再取得が空を返す窓で届いたばかりの行を消すため
// （`grep -Fn -- '手元の写しは刈らない。**その刈り込みはこの関数の役目ではなく' apps/web/app/routes/chat.tsx`）
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '@alteroid/swr';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat, { pendingOwnLines } from './chat';

describe('pendingOwnLines（issue #446 の筋書き2）', () => {
  const 行 = (text: string, role: 'human' | 'clone' = 'human', of = 'conv-a') => ({
    key: `k-${role}-${text}`,
    role,
    text,
    of,
  });

  it('historyLines に同じ role・本文の行があれば、手元の行は落ちる（引き取られた）', () => {
    const lines = [行('やあ')];
    const historyLines = [行('やあ')];

    expect(pendingOwnLines(lines, 'conv-a', historyLines)).toHaveLength(0);
  });

  it('一致が無ければ、理由を問わず残る（履歴が空でも、本文が違っても）', () => {
    const lines = [行('やあ'), 行('元気？')];
    expect(pendingOwnLines(lines, 'conv-a', [])).toHaveLength(2);
    expect(pendingOwnLines(lines, 'conv-a', [行('別の話')])).toHaveLength(2);
  });

  it('role が違えば一致しない（同じ本文でも human と clone は別物）', () => {
    const lines = [行('了解', 'human')];
    const historyLines = [行('了解', 'clone')];

    expect(pendingOwnLines(lines, 'conv-a', historyLines)).toHaveLength(1);
  });

  it('同じ本文が複数あっても1件ずつしか消さない（多重集合の照合）', () => {
    const lines = [行('ok'), 行('ok'), 行('ok')];
    const historyLines = [行('ok')];

    const pending = pendingOwnLines(lines, 'conv-a', historyLines);
    expect(pending).toHaveLength(2);
  });

  it('いま見ている会話（shownId）以外の行は、一致のいかんによらず結果に出さない（ownedBy と同じ絞り）', () => {
    const lines = [行('やあ', 'human', 'conv-a'), 行('別の話', 'human', 'conv-b')];

    const pending = pendingOwnLines(lines, 'conv-a', []);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.text).toBe('やあ');
  });
});

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

async function send(text: string) {
  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

describe('ストリーミング中の返信を、内容の偶然の一致で刈らない', () => {
  const CONVERSATION_ID = 'conv-1';

  it('最初のチャンクが過去の返信と一致しても、後続のチャンクは失われない', async () => {
    const route: Route = (url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: 'OK' } },
            { event: 'text', data: { type: 'text', text: '、以上です' } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            { id: 'm0', at: '2026-08-01T00:00:00Z', role: 'inbound', text: '前の質問' },
            { id: 'm0b', at: '2026-08-01T00:00:01Z', role: 'outbound', text: 'OK' },
          ],
        });
      }
      // 未ハンドルにしない: ErrorNote の alert が増える
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    };
    stubFetch(route);

    renderChat(`/chat/${CONVERSATION_ID}`);
    await screen.findByText('前の質問');

    await send('もう一度聞きたい');

    expect(await within(transcript()).findByText('OK、以上です')).toBeTruthy();
    expect(within(transcript()).getByText('OK', { selector: 'p' })).toBeTruthy();
  });
});

describe('同じ会話へ繰り返し戻っても、届いたばかりの行は消えない（issue #446 の筋書き2）', () => {
  const CONVERSATION_ID = 'conv-1';

  it('1往復目が履歴へ引き取られたあと、2往復目の発言は消えずに残る', async () => {
    let afterFirstRoundSettled = false;
    let releaseInvalidation: () => void = () => {};
    const invalidationReleased = new Promise<void>((resolve) => {
      releaseInvalidation = resolve;
    });

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
                text: '1回目の発言',
                conversationId: CONVERSATION_ID,
              },
              after: invalidationReleased,
            },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: 'はい' } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json(
          afterFirstRoundSettled
            ? {
                conversationId: CONVERSATION_ID,
                messages: [
                  {
                    id: 'm1',
                    at: '2026-08-20T00:00:05.000Z',
                    role: 'inbound',
                    text: '1回目の発言',
                  },
                  { id: 'm2', at: '2026-08-20T00:00:06.000Z', role: 'outbound', text: 'はい' },
                ],
              }
            : { conversationId: CONVERSATION_ID, messages: [] },
        );
      }
      // 未ハンドルにしない: ErrorNote の alert が増える
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    };
    const stub = stubFetch(route);
    const detailFetchCount = () =>
      stub.calls.filter((url) => url.includes(`/conversations/${CONVERSATION_ID}`)).length;

    renderChat(`/chat/${CONVERSATION_ID}`);

    await send('1回目の発言');
    expect(within(transcript()).getAllByText('1回目の発言')).toHaveLength(1);
    await screen.findByText('はい');

    // サーバが1往復目を日誌へ載せてから無効化を届かせる
    afterFirstRoundSettled = true;
    const detailFetchesBefore = detailFetchCount();
    releaseInvalidation();
    await waitFor(() => {
      expect(detailFetchCount()).toBeGreaterThan(detailFetchesBefore);
    });
    expect(within(transcript()).getAllByText('1回目の発言')).toHaveLength(1);
    expect(within(transcript()).getAllByText('はい')).toHaveLength(1);

    await send('2回目の発言（まだ履歴に無い）');
    expect(within(transcript()).getAllByText('2回目の発言（まだ履歴に無い）')).toHaveLength(1);
    await screen.findByText('はい', {}, { timeout: 3000 });

    expect(within(transcript()).getAllByText('1回目の発言')).toHaveLength(1);
    expect(within(transcript()).getAllByText('2回目の発言（まだ履歴に無い）')).toHaveLength(1);
  });
});

describe('過去と同じ本文を送っても、送った発言は消えない（#3826）', () => {
  const 行 = (
    text: string,
    role: 'human' | 'clone',
    extra: { clientMessageId?: string; key?: string } = {},
  ) => ({
    key: extra.key ?? `k-${role}-${text}-${extra.clientMessageId ?? ''}`,
    role,
    text,
    of: 'conv-a',
    ...(extra.clientMessageId === undefined ? {} : { clientMessageId: extra.clientMessageId }),
  });

  it('別の id を持つ履歴の同じ本文は、id を持つ手元の行を引き取らない。同じ id なら引き取る', () => {
    const own = 行('はい', 'human', { clientMessageId: 'new' });
    expect(
      pendingOwnLines([own], 'conv-a', [行('はい', 'human', { clientMessageId: 'old' })]),
    ).toHaveLength(1);
    expect(
      pendingOwnLines([own], 'conv-a', [
        行('はい', 'human', { clientMessageId: 'old' }),
        行('はい', 'human', { clientMessageId: 'new' }),
      ]),
    ).toHaveLength(0);
    expect(pendingOwnLines([own], 'conv-a', [行('はい', 'human')])).toHaveLength(0);
  });

  it('画面: 履歴に同じ本文の過去の発言があっても、送った直後に自分の吹き出しが出る', async () => {
    const route: Route = (url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: 'conv-1' } },
            { event: 'text', data: { type: 'text', text: '承知しました' } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes('/conversations/conv-1')) {
        return json({
          conversationId: 'conv-1',
          messages: [
            {
              id: 'm0',
              at: '2026-08-01T00:00:00Z',
              role: 'inbound',
              text: 'はい',
              clientMessageId: 'old-id',
            },
            { id: 'm1', at: '2026-08-01T00:00:01Z', role: 'outbound', text: '了解です' },
          ],
        });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    };
    stubFetch(route);

    renderChat('/chat/conv-1');
    await screen.findByText('了解です');
    expect(within(transcript()).getAllByText('はい')).toHaveLength(1);

    await send('はい');

    await screen.findByText('承知しました');
    expect(within(transcript()).getAllByText('はい')).toHaveLength(2);
  });
});
