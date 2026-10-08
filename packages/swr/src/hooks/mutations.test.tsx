// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { unstable_serialize, useSWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useState } from 'react';

import { useDeleteConversation, useRecordOwnMessage } from './mutations';
import { KEY, useConversations } from './queries';
import { loadChatDraft, saveChatDraft } from '@alteroid/logic';
import type { ConversationSummary } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '../test-support';

const EXISTING: ConversationSummary = {
  conversationId: 'conv-1',
  startedAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
  messages: 2,
  preview: '前回の続き',
  unreadCount: 0,
  readThrough: null,
};

const OTHER: ConversationSummary = {
  conversationId: 'conv-2',
  startedAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
  messages: 1,
  preview: '別の会話',
  unreadCount: 0,
  readThrough: null,
};

function row(conversation: ConversationSummary): string {
  return `${conversation.conversationId}:${conversation.messages}:${conversation.preview}`;
}

function ListProbe() {
  const { data } = useConversations(30);
  const record = useRecordOwnMessage();
  return (
    <div>
      <button onClick={() => record('conv-new', 'はじめまして。よろしくお願いします')}>
        新規へ送る
      </button>
      <button onClick={() => record('conv-1', 'つづき')}>既存へ送る</button>
      <ol data-testid="list">
        {(data?.conversations ?? []).map((conversation) => (
          <li key={conversation.conversationId}>{row(conversation)}</li>
        ))}
      </ol>
    </div>
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

describe('会話を削除する（#4218）', () => {
  const RESULT = {
    conversationId: 'conv-1',
    tombstoneId: 't1',
    deletedAt: '2026-10-08T00:00:00.000Z',
    hiddenCount: 2,
    attachmentsRemoved: 0,
    commitmentsRemoved: 0,
    queuedDropped: 0,
    approvalsLinked: 0,
    incomplete: [],
    remainsIn: ['生ログ'],
  };

  function DeleteProbe() {
    const { data } = useConversations(30);
    const remove = useDeleteConversation();
    const [shown, setShown] = useState('');
    return (
      <div>
        <button
          onClick={() =>
            remove('conv-1').then(
              (result) => setShown(`ok:${result.remainsIn.join(',')}`),
              (caught: unknown) => setShown(`ng:${(caught as Error).message}`),
            )
          }
        >
          消す
        </button>
        <p data-testid="shown">{shown}</p>
        <ol data-testid="list">
          {(data?.conversations ?? []).map((conversation) => (
            <li key={conversation.conversationId}>{row(conversation)}</li>
          ))}
        </ol>
      </div>
    );
  }

  function install(reply: () => Response) {
    let listed = [EXISTING, OTHER];
    const seen = { deletes: 0 };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? String(input);
      if (request?.method === 'DELETE' && url.endsWith('/conversations/conv-1')) {
        seen.deletes += 1;
        const response = reply();
        if (response.ok) listed = [OTHER];
        return response;
      }
      if (url.includes('/conversations')) {
        return json({ conversations: listed, scanned: 10 });
      }
      throw new TypeError(`Failed to fetch: ${url}`);
    }) as typeof fetch;
    return seen;
  }

  it('成功すると結果を返し、下書きを消し、会話一覧を引き直す', async () => {
    saveChatDraft('conv-1', '書きかけ');
    const seen = install(() => json(RESULT));
    render(
      <Providers>
        <DeleteProbe />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('list').textContent).toContain('conv-1'));

    fireEvent.click(screen.getByRole('button', { name: '消す' }));
    await waitFor(() => expect(screen.getByTestId('shown').textContent).toBe('ok:生ログ'));

    expect(seen.deletes).toBe(1);
    expect(loadChatDraft('conv-1')).toBe('');
    await waitFor(() => expect(screen.getByTestId('list').textContent).not.toContain('conv-1:'));
  });

  it('404 は error の文言のまま投げ、下書きは消さない', async () => {
    saveChatDraft('conv-1', '書きかけ');
    install(() => json({ error: '会話が無い', code: 'conversation_not_found' }, 404));
    render(
      <Providers>
        <DeleteProbe />
      </Providers>,
    );
    fireEvent.click(screen.getByRole('button', { name: '消す' }));
    await waitFor(() => expect(screen.getByTestId('shown').textContent).toBe('ng:会話が無い'));
    expect(loadChatDraft('conv-1')).toBe('書きかけ');
  });
});

describe('自分の送信を会話一覧へ即時反映する', () => {
  it('新しい会話の送信で一覧の先頭に入る', async () => {
    stubFetch((url) => {
      if (url.includes('/conversations'))
        return json({ conversations: [EXISTING, OTHER], scanned: 10 });
      return undefined;
    });

    render(
      <Providers>
        <ListProbe />
      </Providers>,
    );

    await screen.findByText(row(EXISTING));

    fireEvent.click(screen.getByRole('button', { name: '新規へ送る' }));

    await waitFor(() => {
      const list = screen.getByTestId('list');
      expect(list.textContent?.startsWith('conv-new:1:はじめまして。よろしくお願いします')).toBe(
        true,
      );
    });
    expect(screen.getByText(row(EXISTING))).toBeTruthy();
    expect(screen.getByText(row(OTHER))).toBeTruthy();
  });

  it('長い本文は 80 文字で切って `…` を足す（サーバの `preview()` に合わせる）', async () => {
    stubFetch((url) => {
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    function Probe() {
      const { data } = useConversations(30);
      const record = useRecordOwnMessage();
      const long = 'あ'.repeat(90);
      return (
        <div>
          <button onClick={() => record('conv-long', long)}>送る</button>
          <div data-testid="preview">{data?.conversations[0]?.preview ?? ''}</div>
        </div>
      );
    }

    render(
      <Providers>
        <Probe />
      </Providers>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('preview')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));

    await waitFor(() => {
      const text = screen.getByTestId('preview').textContent ?? '';
      expect(text).toBe(`${'あ'.repeat(80)}…`);
    });
  });

  it('既存の会話への送信で、往復数・抜粋・順序がまとめて動く', async () => {
    stubFetch((url) => {
      if (url.includes('/conversations'))
        return json({ conversations: [OTHER, EXISTING], scanned: 10 });
      return undefined;
    });

    render(
      <Providers>
        <ListProbe />
      </Providers>,
    );

    await screen.findByText(row(OTHER));

    fireEvent.click(screen.getByRole('button', { name: '既存へ送る' }));

    const updated: ConversationSummary = { ...EXISTING, messages: 3, preview: 'つづき' };
    await waitFor(() => {
      expect(screen.getByText(row(updated))).toBeTruthy();
    });

    const text = screen.getByTestId('list').textContent ?? '';
    expect(text.indexOf(row(updated))).toBeLessThan(text.indexOf(row(OTHER)));
  });

  it('会話一覧のキャッシュがまだ無い（取得中）なら何もしない', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    stubFetch((url) => {
      if (url.includes('/conversations')) return pending;
      return undefined;
    });

    render(
      <Providers>
        <ListProbe />
      </Providers>,
    );

    fireEvent.click(screen.getByRole('button', { name: '新規へ送る' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByTestId('list').textContent).toBe('');

    resolveFetch?.(json({ conversations: [], scanned: 0 }));
    await waitFor(() => {
      expect(screen.getByTestId('list').textContent).toBe('');
    });
  });

  it('（前提の確認）未取得のときキャッシュには本当に値が無い', async () => {
    stubFetch(() => undefined);

    function Probe() {
      const { cache } = useSWRConfig();
      const has = cache.get(unstable_serialize(KEY.conversations(30)))?.data !== undefined;
      return <div data-testid="has-cache">{String(has)}</div>;
    }

    render(
      <Providers>
        <Probe />
      </Providers>,
    );

    expect(screen.getByTestId('has-cache').textContent).toBe('false');
  });
});
