// @vitest-environment jsdom
/**
 * 自分のチャット送信を会話一覧へ即時反映する（B-1、唯一の楽観更新）。
 *
 * API は叩かず SWR キャッシュだけを書き換える。届いた通りの正しい値は、この
 * 直後に SSE 経由の再取得が置き換える前提なので、ここで固定するのは
 * 「送った直後に一覧がどう動くか」という暫定の見た目だけである。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { unstable_serialize, useSWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useRecordOwnMessage } from '~/hooks/mutations';
import { KEY, useConversations } from '~/hooks/queries';
import type { ConversationSummary } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

const EXISTING: ConversationSummary = {
  conversationId: 'conv-1',
  startedAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
  messages: 2,
  preview: '前回の続き',
};

const OTHER: ConversationSummary = {
  conversationId: 'conv-2',
  startedAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
  messages: 1,
  preview: '別の会話',
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
    // 既存の項目は消えていない
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

    // 先頭へ移った（元は2番目だった）
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

    // まだ何も届いていない状態で送信する
    fireEvent.click(screen.getByRole('button', { name: '新規へ送る' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByTestId('list').textContent).toBe('');

    // 後から実際の応答が来ても、さっきの送信で書いた値が混ざっていない
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
