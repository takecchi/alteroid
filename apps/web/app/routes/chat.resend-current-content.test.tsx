// @vitest-environment jsdom
/**
 * Issue #3247。失敗表示の「再送」は、入力欄の今の中身を見る。
 *
 * - 戻った文を直してから押せば、直した文を送る（新しい `clientMessageId`）
 * - 戻った添付を外してから押せば、外した添付は付けない
 * - 中身が変わっていなければ、最初の `clientMessageId` で送る（サーバが受け取り済みなら重複で返す）
 * - 添付の期限切れ（400 `attachment_missing`）は、「再送」では抜けられないので外して付け直す案内を出す
 *   （#3778 で変更: 手元のファイルを持つ添付は控えを外し、再送で上げ直す。案内は引き継いだ添付のときだけ）
 * - 同じ id で中身が違うと 409 `client_message_id_mismatch`（#3243）。次の再送は新しい id で送る
 *
 * 実時間の待ちは使わない。
 */
import { File as NodeFile } from 'node:buffer';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const A = 'conv-3247';
const BOOM = '送信に失敗した（テスト用の文言、#3247）';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat() {
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: [`/chat/${A}`] },
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
  URL.createObjectURL = () => 'blob:fake';
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const META = {
  id: 'att-1',
  name: 'first.txt',
  mediaType: 'text/plain',
  size: 3,
  sha256: 'a'.repeat(64),
};

const nodeFile = (name: string) =>
  new NodeFile([new Uint8Array([1, 2, 3])], name, { type: 'text/plain' }) as unknown as File;

function choose(files: File[]) {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

interface ChatBody {
  text: string;
  attachments?: string[];
  clientMessageId: string;
}

/** `/chat` への POST を控える。`replies[i]` が i 回目の応答（足りなければ成功）。 */
function setUp(replies: (() => Response)[]) {
  const bodies: ChatBody[] = [];
  let uploads = 0;
  stubFetch((url, init) => {
    // 上げるたびに新しい id（att-1, att-2, ...）。上げ直しが走ったかを id で見分ける（#3778）。
    if (url.includes('/attachments?')) return json({ ...META, id: `att-${++uploads}` });
    if (url.endsWith('/chat')) {
      const reply = replies[bodies.length - 1];
      if (reply !== undefined) return reply();
      return sse(
        [
          { event: 'open', data: { conversationId: A } },
          { event: 'done', data: { type: 'done' } },
        ],
        {
          signal: init?.signal,
        },
      );
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${A}`)) return json({ conversationId: A, messages: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  // 本文は `Request` の中にある（`stubFetch` の route には `init` で届かない）。
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request && input.url.endsWith('/chat')) {
      bodies.push(JSON.parse(await input.clone().text()) as ChatBody);
    }
    return inner(input, init);
  }) as typeof fetch;
  return bodies;
}

const box = async () =>
  (await screen.findByPlaceholderText(/クローンに話しかける/)) as HTMLTextAreaElement;

async function typeAndSend(text: string) {
  fireEvent.change(await box(), { target: { value: text } });
  fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
}

const fail = () => json({ error: BOOM }, 500);

describe('#3247: 「再送」は入力欄の今の中身を送る', () => {
  it('戻った文を直してから再送すると、直した文を新しい id で送る', async () => {
    const bodies = setUp([fail]);
    renderChat();
    await typeAndSend('直す前の文');
    expect(await screen.findByText(BOOM)).toBeTruthy();
    const textbox = await box();
    await waitFor(() => expect(textbox.value).toBe('直す前の文'));

    fireEvent.change(textbox, { target: { value: '直した後の文' } });
    fireEvent.click(screen.getByRole('button', { name: '再送' }));
    await waitFor(() => expect(bodies.length).toBe(2));

    expect(bodies[1]?.text).toBe('直した後の文');
    expect(bodies[1]?.clientMessageId).not.toBe(bodies[0]?.clientMessageId);
    // 直した文が送られたので、入力欄には何も残らない（Enter で二重に届かない）。
    await waitFor(() => expect(textbox.value).toBe(''));
  });

  it('中身が変わっていなければ、最初の id で送る', async () => {
    const bodies = setUp([fail]);
    renderChat();
    await typeAndSend('そのまま');
    expect(await screen.findByText(BOOM)).toBeTruthy();
    await waitFor(async () => expect((await box()).value).toBe('そのまま'));

    fireEvent.click(screen.getByRole('button', { name: '再送' }));
    await waitFor(() => expect(bodies.length).toBe(2));
    expect(bodies[1]?.text).toBe('そのまま');
    expect(bodies[1]?.clientMessageId).toBe(bodies[0]?.clientMessageId);
  });

  it('戻った添付を外してから再送すると、外した添付は付かない', async () => {
    const bodies = setUp([fail]);
    renderChat();
    choose([nodeFile('first.txt')]);
    await typeAndSend('添付つき');
    expect(await screen.findByText(BOOM)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'first.txt を外す' }));

    fireEvent.click(screen.getByRole('button', { name: '再送' }));
    await waitFor(() => expect(bodies.length).toBe(2));
    expect(bodies[0]?.attachments).toEqual(['att-1']);
    expect(bodies[1]?.attachments ?? []).toEqual([]);
    expect(bodies[1]?.clientMessageId).not.toBe(bodies[0]?.clientMessageId);
  });

  // 元の期待は「外して付け直す案内が出る」だった。#3778 で反転した——手元のファイルを持つ添付は、
  // CLI の `expireUploads`（#3246）と同じく控えを外し、再送で上げ直す。外して付け直す案内が出るのは、
  // 上げ直せない引き継いだ添付（`file` が無い）のとき（`chat.carried-attachment-expired.test.tsx`）。
  it('添付の期限切れ（400 attachment_missing）では、手元のファイルは再送で上げ直して新しい id で送る', async () => {
    const bodies = setUp([
      () =>
        json(
          { error: '添付が見つからない（期限切れの可能性）: att-1', code: 'attachment_missing' },
          400,
        ),
    ]);
    renderChat();
    choose([nodeFile('first.txt')]);
    await typeAndSend('添付つき');
    expect(await screen.findByText(/手元のファイルを上げ直す/)).toBeTruthy();
    expect(screen.queryByText(/添付を外して付け直/)).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: '再送' }));
    await waitFor(() => expect(bodies.length).toBe(2));
    expect(bodies[0]?.attachments).toEqual(['att-1']);
    expect(bodies[1]?.attachments).toEqual(['att-2']);
    expect(bodies[1]?.clientMessageId).not.toBe(bodies[0]?.clientMessageId);
  });

  it('409 client_message_id_mismatch の後の再送は、新しい id で送る', async () => {
    const bodies = setUp([
      () => json({ error: '中身が違う', code: 'client_message_id_mismatch' }, 409),
    ]);
    renderChat();
    await typeAndSend('同じ文');
    expect(await screen.findByText('中身が違う')).toBeTruthy();
    await waitFor(async () => expect((await box()).value).toBe('同じ文'));

    fireEvent.click(screen.getByRole('button', { name: '再送' }));
    await waitFor(() => expect(bodies.length).toBe(2));
    expect(bodies[1]?.text).toBe('同じ文');
    expect(bodies[1]?.clientMessageId).not.toBe(bodies[0]?.clientMessageId);
  });
});
