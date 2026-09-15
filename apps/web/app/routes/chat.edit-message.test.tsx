// @vitest-environment jsdom
/**
 * チャットの送信済みメッセージを編集する（#1010）。
 *
 * サーバ側（`packages/core/src/conversation.ts` の `computeSupersededIds` /
 * `apps/daemon/src/app.ts` の `POST /chat` `supersedes` 検証・
 * `GET /conversations/:id` `includeSuperseded`）は既に入っている。ここは
 * Web UI 側——Claude / ChatGPT と同じ操作感（人間の発言にホバーで鉛筆・
 * クリックで textarea・確定で `supersedes` 付きの `POST /chat`・
 * ChatGPT 風の版切り替え）を固定する。
 *
 * **`chat.tsx` の既存のマージロジック（`retainedBy` / `pendingOwnLines` /
 * `historyLines`）は触っていない。** 変えたのは (1) `historyLines` が
 * `history.data.messages` を `supersededBy === undefined` で絞ってから使う
 * ようになった点（`useConversation` を `includeSuperseded: true` で読むよう
 * 変えたぶんの埋め合わせで、結果として既定ビューに出る集合は以前と同じ）
 * (2) `Line` に `journalId`（本物の日誌エントリ id）が増えた点だけである。
 * 既存のテスト（`chat.test.tsx` ほか）がそのまま緑であることが、この2点が
 * 既存の挙動を変えていないことの裏付けになる。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-edit-1';

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
  return {
    router,
    ...render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    ),
  };
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

/** `/approvals` はこの試験の対象ではない。未ハンドルのまま（`chat.test.tsx` と同じ）。 */
function conversationsListRoute(url: string) {
  return url.includes('/conversations') && !url.includes(`/conversations/${CONVERSATION_ID}`)
    ? json({ conversations: [], scanned: 0 })
    : undefined;
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

describe('編集の入口（鉛筆）— 制約C', () => {
  it('人間の発言には出て、クローンの発言には出ない', async () => {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            { id: 'm-human-1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: 'やあ' },
            {
              id: 'm-clone-1',
              at: '2026-08-20T00:00:01.000Z',
              role: 'outbound',
              text: 'こんにちは',
            },
          ],
          scanned: 2,
          reachedStart: true,
          supersededCount: 0,
        });
      }
      return conversationsListRoute(url);
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    await screen.findByText('やあ');
    await screen.findByText('こんにちは');

    const humanRow = within(transcript()).getByText('やあ').closest('li');
    expect(humanRow).not.toBeNull();
    expect(
      within(humanRow as HTMLElement).getByRole('button', { name: '発言を編集' }),
    ).toBeTruthy();

    const cloneRow = within(transcript()).getByText('こんにちは').closest('li');
    expect(cloneRow).not.toBeNull();
    expect(
      within(cloneRow as HTMLElement).queryByRole('button', { name: '発言を編集' }),
    ).toBeNull();
  });

  /**
   * **対象にできるのは `historyLines` 由来の、本物の日誌エントリ id を持つ行
   * だけ。** 送信直後の楽観行（`pendingOwnLines`）にはまだ本物の id が無い
   * （`Line.journalId` の doc）ので、鉛筆を出してはいけない。
   */
  it('サーバ未確定の楽観行（送信直後）には出ない', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse([{ event: 'open', data: { conversationId: CONVERSATION_ID } }], {
          signal: init?.signal,
          keepOpen: true,
        });
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [],
          scanned: 0,
          reachedStart: true,
          supersededCount: 0,
        });
      }
      return conversationsListRoute(url);
    });

    renderChat('/chat');
    const box = await screen.findByPlaceholderText(/クローンに話しかける/);
    fireEvent.change(box, { target: { value: 'たったいま送った' } });
    fireEvent.click(screen.getByRole('button', { name: /送る/ }));

    const line = await screen.findByText('たったいま送った');
    const row = line.closest('li');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).queryByRole('button', { name: '発言を編集' })).toBeNull();
  });
});

describe('編集して送信する', () => {
  it('確定すると supersedes 付きで POST /chat が呼ばれる', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: '了解しました' } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            { id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: '元の文' },
            { id: 'm1r', at: '2026-08-20T00:00:01.000Z', role: 'outbound', text: '了解' },
          ],
          scanned: 2,
          reachedStart: true,
          supersededCount: 0,
        });
      }
      return conversationsListRoute(url);
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    await screen.findByText('元の文');

    const row = within(transcript()).getByText('元の文').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '発言を編集' }));

    const textarea = await screen.findByRole('textbox', { name: '発言を編集する下書き' });
    // 送信済みの本文が下書きへ引き継がれている（空から始まらない）。
    expect((textarea as HTMLTextAreaElement).value).toBe('元の文');

    fireEvent.change(textarea, { target: { value: '直した文' } });
    // 既存の送信欄と同じキー操作（⌘/Ctrl + Enter）で確定する。
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(stub.entries.some((entry) => entry.url.endsWith('/chat'))).toBe(true);
    });
    const call = stub.entries.find((entry) => entry.url.endsWith('/chat'));
    const body = (await call?.request?.clone().json()) as unknown;
    expect(body).toEqual({ text: '直した文', conversationId: CONVERSATION_ID, supersedes: 'm1' });

    // 編集後の本文が、いつもどおり新しい発言として画面にも現れる。
    // **やりとりの中に限って見る** — 送信は会話一覧の抜粋にも即座に映るので
    // （`useRecordOwnMessage`）、画面全体で探すと同じ本文に二度当たる
    // （`chat.test.tsx` の `transcript()` の doc と同じ理由）。
    expect(await within(transcript()).findByText('直した文')).toBeTruthy();
  });

  it('キャンセル（Escape）で元の表示に戻り、POST /chat は呼ばれない', async () => {
    const stub = stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [{ id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: '元の文' }],
          scanned: 1,
          reachedStart: true,
          supersededCount: 0,
        });
      }
      return conversationsListRoute(url);
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    await screen.findByText('元の文');

    const row = within(transcript()).getByText('元の文').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '発言を編集' }));

    const textarea = await screen.findByRole('textbox', { name: '発言を編集する下書き' });
    fireEvent.change(textarea, { target: { value: '書きかけの文' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(screen.queryByRole('textbox', { name: '発言を編集する下書き' })).toBeNull();
    expect(await screen.findByText('元の文')).toBeTruthy();
    expect(stub.entries.some((entry) => entry.url.endsWith('/chat'))).toBe(false);

    // ボタンの「キャンセル」でも同じく戻る。
    fireEvent.click(within(row).getByRole('button', { name: '発言を編集' }));
    const secondTextarea = await screen.findByRole('textbox', { name: '発言を編集する下書き' });
    fireEvent.change(secondTextarea, { target: { value: 'また書きかけ' } });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(screen.queryByRole('textbox', { name: '発言を編集する下書き' })).toBeNull();
    expect(await screen.findByText('元の文')).toBeTruthy();
    expect(stub.entries.some((entry) => entry.url.endsWith('/chat'))).toBe(false);
  });
});

describe('版の切り替え（ChatGPT 風の < N/N >）', () => {
  /**
   * サーバの畳み込み規則（`computeSupersededIds`）を Web 側で再現しない —
   * ここで組み立てるのは「編集済み・畳まれ済み」を装った応答であって、
   * `chat.tsx` 側は `supersedes` / `supersededBy` を束ねるだけである
   * （`buildEditVersions` の doc）。
   */
  it('前の版へ戻ると、畳まれた発言（旧本文とその応答）が読める', async () => {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            {
              id: 'm1',
              at: '2026-08-20T00:00:00.000Z',
              role: 'inbound',
              text: '元の質問',
              supersededBy: 'm2',
            },
            {
              id: 'm1r',
              at: '2026-08-20T00:00:01.000Z',
              role: 'outbound',
              text: '元の答え',
              supersededBy: 'm2',
            },
            {
              id: 'm2',
              at: '2026-08-20T00:00:02.000Z',
              role: 'inbound',
              text: '直した質問',
              supersedes: 'm1',
            },
            {
              id: 'm2r',
              at: '2026-08-20T00:00:03.000Z',
              role: 'outbound',
              text: '直した答え',
            },
          ],
          scanned: 4,
          reachedStart: true,
          supersededCount: 2,
        });
      }
      return conversationsListRoute(url);
    });

    renderChat(`/chat/${CONVERSATION_ID}`);

    // 既定ビューには編集後の版だけが出る（畳まれた側は見えない）。
    await screen.findByText('直した質問');
    await screen.findByText('直した答え');
    expect(screen.queryByText('元の質問')).toBeNull();
    expect(screen.queryByText('元の答え')).toBeNull();

    // 版切り替えが「2/2」（最新）から始まる。
    await screen.findByText('2/2');

    fireEvent.click(screen.getByRole('button', { name: '前の版へ' }));

    // 前の版（1/2）へ戻ると、旧本文と、それに畳まれていた応答の両方が読める。
    expect(await screen.findByText('1/2')).toBeTruthy();
    expect(await screen.findByText('元の質問')).toBeTruthy();
    expect(await screen.findByText(/元の答え/)).toBeTruthy();
    // 最新の版の本文はもう出ていない（版を切り替えたので同じ枠に収まる）。
    expect(screen.queryByText('直した質問')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '次の版へ' }));

    expect(await screen.findByText('2/2')).toBeTruthy();
    expect(await screen.findByText('直した質問')).toBeTruthy();
    expect(screen.queryByText('元の質問')).toBeNull();
  });
});
