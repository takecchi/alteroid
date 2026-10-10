// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useConversations } from './queries';
import { json, Providers, stubFetch, storeTestBaseUrl } from '../test-support';

function summary(id: string) {
  return {
    conversationId: id,
    startedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    messages: 1,
    preview: id,
    unreadCount: 0,
    readThrough: null,
  };
}

function Probe({ pages }: { pages: number }) {
  const { data, error } = useConversations(2, { pages });
  const { mutate } = useSWRConfig();
  return (
    <div>
      <button onClick={() => void mutate(() => true)}>再取得</button>
      <p data-testid="ids">{(data?.conversations ?? []).map((c) => c.conversationId).join(',')}</p>
      <p data-testid="next">{data?.nextCursor ?? '(無し)'}</p>
      <p data-testid="complete">{String(data?.windowsComplete)}</p>
      <p data-testid="pages-read">{String(data?.pagesRead)}</p>
      <p data-testid="error">{error === undefined ? '' : 'error'}</p>
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

const text = (id: string) => screen.getByTestId(id).textContent;

describe('useConversations の頁送り', () => {
  it('pages 頁ぶんを nextCursor で辿って1つの一覧にする（最後の頁の窓の様子を返す）', async () => {
    const stub = stubFetch((url) => {
      const cursor = new URL(url).searchParams.get('cursor');
      const base = { scanned: 2, hiddenByLimit: 0 };
      if (cursor === null) {
        return json({
          ...base,
          conversations: [summary('a'), summary('b')],
          reachedStart: false,
          nextCursor: 'k1',
        });
      }
      if (cursor === 'k1') {
        return json({ ...base, conversations: [summary('c')], reachedStart: true });
      }
      return undefined;
    });

    render(
      <Providers>
        <Probe pages={3} />
      </Providers>,
    );

    await waitFor(() => {
      expect(text('ids')).toBe('a,b,c');
    });
    expect(text('next')).toBe('(無し)');
    expect(text('complete')).toBe('false');
    // `scanned` / `reachedStart` は最後の頁の窓の値なので、何頁ぶんを読んだかを別に返す。
    expect(text('pages-read')).toBe('2');
    expect(stub.calls.filter((url) => url.includes('/conversations'))).toHaveLength(2);
  });

  it('取り直すと先頭から辿り直し、新しい継続点を使う（保存した継続点で頁の継ぎ目の会話を落とさない）', async () => {
    let head = 'k1';
    const stub = stubFetch((url) => {
      const cursor = new URL(url).searchParams.get('cursor');
      const base = { scanned: 2, hiddenByLimit: 1, reachedStart: true };
      if (cursor === null) {
        return json(
          head === 'k1'
            ? { ...base, conversations: [summary('a'), summary('b')], nextCursor: 'k1' }
            : { ...base, conversations: [summary('n'), summary('a')], nextCursor: 'k2' },
        );
      }
      if (cursor === 'k1')
        return json({ ...base, conversations: [summary('c')], hiddenByLimit: 0 });
      if (cursor === 'k2') {
        return json({ ...base, conversations: [summary('b'), summary('c')], hiddenByLimit: 0 });
      }
      return undefined;
    });

    render(
      <Providers>
        <Probe pages={2} />
      </Providers>,
    );
    await waitFor(() => {
      expect(text('ids')).toBe('a,b,c');
    });

    head = 'k2';
    fireEvent.click(screen.getByText('再取得'));

    await waitFor(() => {
      expect(text('ids')).toBe('n,a,b,c');
    });
    expect(stub.calls.some((url) => new URL(url).searchParams.get('cursor') === 'k2')).toBe(true);
  });

  it('途中の頁の取得に失敗したら、頁の欠けた一覧を成功のように返さず、失敗にする', async () => {
    stubFetch((url) => {
      const cursor = new URL(url).searchParams.get('cursor');
      if (cursor === null) {
        return json({
          conversations: [summary('a')],
          scanned: 1,
          hiddenByLimit: 5,
          reachedStart: true,
          nextCursor: 'k1',
        });
      }
      return json({ error: 'internal' }, 500);
    });

    render(
      <Providers>
        <Probe pages={2} />
      </Providers>,
    );

    await waitFor(() => {
      expect(text('error')).toBe('error');
    });
    expect(text('ids')).toBe('');
  });
});
