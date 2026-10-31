// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useDeleteConversation } from './mutations';
import { useConversation, useConversations } from './queries';
import { useJournalLive } from './use-journal-live';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type FetchStub } from '../test-support';

// 自分が消した id は module の集まりに残るので、試験ごとに別の id を使う
function tombstoneOf(conversationId: string) {
  return {
    type: 'conversation_deleted',
    id: `t-${conversationId}`,
    at: '2026-10-31T00:00:00.000Z',
    deletedConversationId: conversationId,
    deletedBy: 'operator',
    hiddenCount: 2,
  };
}

function Probe({ conversationId }: { conversationId: string }) {
  useJournalLive();
  useConversations(30);
  const body = useConversation(conversationId, { includeSuperseded: true });
  const remove = useDeleteConversation();
  return (
    <div>
      <button onClick={() => void remove(conversationId)}>消す</button>
      <div data-testid="body">{body.data === undefined ? 'none' : 'loaded'}</div>
    </div>
  );
}

function bodyGets(stub: FetchStub, conversationId: string): number {
  return stub.entries.filter(
    (entry) =>
      entry.request?.method !== 'DELETE' &&
      new RegExp(`/conversations/${conversationId}(\\?|$)`).test(entry.url),
  ).length;
}

function listGets(stub: FetchStub): number {
  return stub.calls.filter((url) => /\/conversations\?/.test(url)).length;
}

function renderProbe(conversationId: string, tombstoneAfter: PromiseLike<unknown>) {
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/journal/stream')) {
      return sse(
        [
          { event: 'open', data: { ok: true } },
          {
            event: 'conversation_deleted',
            data: tombstoneOf(conversationId),
            after: tombstoneAfter,
          },
        ],
        { keepOpen: true, signal: init?.signal },
      );
    }
    // DELETE と GET の両方がここへ来る（openapi-fetch は Request を渡すので `init` から見分けられない）。どちらの型にも足りる形で返す
    if (new RegExp(`/conversations/${conversationId}(\\?|$)`).test(url)) {
      return json({
        conversationId,
        tombstoneId: 't1',
        deletedAt: '2026-10-31T00:00:00.000Z',
        hiddenCount: 2,
        attachmentsRemoved: 0,
        commitmentsRemoved: 0,
        queuedDropped: 0,
        approvalsLinked: 0,
        incomplete: [],
        remainsIn: [],
        messages: [],
      });
    }
    if (/\/conversations\?/.test(url)) return json({ conversations: [], scanned: 0 });
    if (url.includes('/commitments') || url.includes('/unread')) return json({});
    return undefined;
  });
  render(
    <Providers>
      <Probe conversationId={conversationId} />
    </Providers>,
  );
  return stub;
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

describe('会話の削除の墓標（#5935）', () => {
  it('自分が消した会話は、墓標が届いても本文を読み直さない', async () => {
    let tombstone!: () => void;
    const stub = renderProbe('conv-own', new Promise<void>((resolve) => (tombstone = resolve)));
    await waitFor(() => expect(screen.getByTestId('body').textContent).toBe('loaded'));
    const before = bodyGets(stub, 'conv-own');
    const listBefore = listGets(stub);

    fireEvent.click(screen.getByRole('button', { name: '消す' }));
    await waitFor(() =>
      expect(stub.entries.some((entry) => entry.request?.method === 'DELETE')).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId('body').textContent).toBe('none'));
    tombstone();

    // 一覧は墓標でも読み直す（削除の自分の読み直しと合わせて 2 回）。本文の分岐は同じ呼び出しの中で先に済んでいる
    await waitFor(() => expect(listGets(stub)).toBeGreaterThan(listBefore + 1));
    expect(bodyGets(stub, 'conv-own')).toBe(before);
  });

  it('自分で消していない会話は、墓標が届いたら本文を読み直す（別の画面に「消された」を知らせる）', async () => {
    let tombstone!: () => void;
    const stub = renderProbe('conv-other', new Promise<void>((resolve) => (tombstone = resolve)));
    await waitFor(() => expect(screen.getByTestId('body').textContent).toBe('loaded'));
    const before = bodyGets(stub, 'conv-other');
    tombstone();

    await waitFor(() => expect(bodyGets(stub, 'conv-other')).toBeGreaterThan(before));
  });
});
