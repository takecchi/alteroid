// @vitest-environment jsdom
import { useJournalLive } from '@alteroid/swr';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-tail';
const BEFORE_HEAD = '待ち時間を 35 秒ほどにすれば、必ず Gotenberg が先に切れて';
const BEFORE_TAIL = '、その理由を受け取れます。';
const AFTER = '④ accessToken は必須にした方がいいか。';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  useJournalLive();
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

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// 塊ごとに1回だけ enqueue する: test-support の sse は1枠ごとに時計を挟むので、同じ塊で届く形を作れない
function chunkedSse(
  chunks: { body: string; after?: Promise<void> }[],
  signal?: AbortSignal | null,
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const stop = () => {
        try {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        } catch {
          // 既に閉じている
        }
      };
      signal?.addEventListener('abort', stop, { once: true });
      for (const chunk of chunks) {
        if (chunk.after !== undefined) await chunk.after;
        if (signal?.aborted === true) return;
        controller.enqueue(encoder.encode(chunk.body));
      }
      if (signal?.aborted !== true) controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });
const items = () =>
  within(transcript())
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');

describe.each([
  { label: '区切りあり（空行。#4339 以降のデーモン）', joiner: '\n\n' },
  { label: '区切りなし（古いデーモン）', joiner: '' },
])('日誌の本文が $label', ({ joiner }) => {
  const JOURNAL_TEXT = BEFORE_HEAD + BEFORE_TAIL + joiner + AFTER;
  it('確定した履歴と突き合わさって、写しが会話の末尾に残らない', async () => {
    const afterTool = gate();
    const finished = gate();
    const invalidate = gate();
    let replied = false;

    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return chunkedSse(
          [
            {
              body:
                frame('open', { conversationId: ID }) +
                frame('text', { type: 'text', text: BEFORE_HEAD }),
            },
            // 前半の末尾と道具の合図が同じ塊で届く（代理や圧縮で溜められた形）
            {
              body:
                frame('text', { type: 'text', text: BEFORE_TAIL }) +
                frame('tool', { type: 'tool', tool: 'commitment_close' }),
              after: Promise.resolve(),
            },
            { body: frame('text', { type: 'text', text: AFTER }), after: afterTool.promise },
            { body: frame('done', { type: 'done' }), after: finished.promise },
          ],
          init?.signal,
        );
      }
      if (url.endsWith('/journal/stream')) {
        return sse(
          [
            { event: 'open', data: { ok: true } },
            {
              event: 'exchange',
              data: {
                type: 'exchange',
                id: 'evt-reply',
                at: '2026-10-09T08:27:32.000Z',
                with: 'human',
                role: 'outbound',
                text: JOURNAL_TEXT,
                conversationId: ID,
              },
              after: invalidate.promise,
            },
          ],
          { keepOpen: true, signal: init?.signal, delayMs: 0 },
        );
      }
      if (url.includes(`/conversations/${ID}`)) {
        return json({
          conversationId: ID,
          messages: replied
            ? [
                {
                  id: 'm1',
                  at: '2026-10-09T08:26:52.000Z',
                  role: 'inbound',
                  text: '聞きたい',
                },
                {
                  id: 'm2',
                  at: '2026-10-09T08:27:32.000Z',
                  role: 'outbound',
                  text: JOURNAL_TEXT,
                },
              ]
            : [],
          scanned: 0,
          reachedStart: true,
        });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

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

    fireEvent.change(await screen.findByPlaceholderText(/クローンに話しかける/), {
      target: { value: '聞きたい' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));

    await screen.findByText(/commitment_close を実行中/);
    afterTool.open();
    await screen.findByText(AFTER);

    expect(items().some((text) => text.includes(BEFORE_HEAD + BEFORE_TAIL))).toBe(true);

    replied = true;
    finished.open();
    invalidate.open();

    await waitFor(() => {
      const shown = items();
      expect(shown.filter((text) => text.includes(AFTER))).toHaveLength(1);
      expect(shown.filter((text) => text.includes(BEFORE_HEAD))).toHaveLength(1);
      expect(shown.at(-1)).toContain(BEFORE_HEAD + BEFORE_TAIL);
      expect(shown.at(-1)).toContain(AFTER);
    });
  });
});
