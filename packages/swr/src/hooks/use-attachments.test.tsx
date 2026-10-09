// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer';
import { useEffect } from 'react';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useAttachments } from './queries';
import { useDeleteAttachment, useSetAttachmentKept, useUploadKeptAttachment } from './mutations';
import { json, Providers, stubFetch, storeTestBaseUrl } from '../test-support';

const USAGE = {
  count: 3,
  totalBytes: 30,
  byFrom: {
    human: { count: 1, totalBytes: 10 },
    clone: { count: 1, totalBytes: 10 },
    manager: { count: 1, totalBytes: 10 },
    integration: { count: 0, totalBytes: 0 },
    unknown: { count: 0, totalBytes: 0 },
  },
};

function meta(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `${id}.txt`,
    mediaType: 'text/plain',
    size: 10,
    sha256: 'x',
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-10-31T00:00:00.000Z',
    ...extra,
  };
}

type Api = {
  kept: ReturnType<typeof useSetAttachmentKept>;
  del: ReturnType<typeof useDeleteAttachment>;
  upload: ReturnType<typeof useUploadKeptAttachment>;
};
let api: Api | undefined;

function Probe({ pages, q }: { pages: number; q?: string }) {
  const { data, error } = useAttachments(
    { kept: true, from: 'clone', conversationId: 'c1', ...(q === undefined ? {} : { q }) },
    { pages, limit: 2 },
  );
  const kept = useSetAttachmentKept();
  const del = useDeleteAttachment();
  const upload = useUploadKeptAttachment();
  useEffect(() => {
    api = { kept, del, upload };
  }, [kept, del, upload]);
  return (
    <div>
      <p data-testid="ids">
        {(data?.items ?? []).map((i) => `${i.id}${i.keptAt === undefined ? '' : '*'}`).join(',')}
      </p>
      <p data-testid="next">{data?.nextCursor ?? '(無し)'}</p>
      <p data-testid="count">{data?.usage.count ?? ''}</p>
      <p data-testid="error">{error === undefined ? '' : 'error'}</p>
    </div>
  );
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  api = undefined;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
const text = (id: string) => screen.getByTestId(id).textContent;

describe('useAttachments', () => {
  it('絞り込みと limit をクエリに載せ、pages 頁ぶんを nextCursor で辿る（usage は最後の頁のもの）', async () => {
    const stub = stubFetch((url) => {
      const u = new URL(url);
      if (u.pathname !== '/attachments') return undefined;
      if (u.searchParams.get('cursor') === null) {
        return json({ items: [meta('a'), meta('b')], nextCursor: 'k1', usage: USAGE });
      }
      return json({ items: [meta('b'), meta('c')], usage: { ...USAGE, count: 4 } });
    });
    render(
      <Providers>
        <Probe pages={2} q="報告" />
      </Providers>,
    );
    await waitFor(() => {
      expect(text('ids')).toBe('a,b,c');
    });
    expect(text('next')).toBe('(無し)');
    expect(text('count')).toBe('4');
    const first = new URL(stub.calls[0]!);
    expect(first.searchParams.get('kept')).toBe('1');
    expect(first.searchParams.get('from')).toBe('clone');
    expect(first.searchParams.get('conversationId')).toBe('c1');
    expect(first.searchParams.get('q')).toBe('報告');
    expect(first.searchParams.get('limit')).toBe('2');
    expect(new URL(stub.calls[1]!).searchParams.get('cursor')).toBe('k1');
  });

  it('保存の付け外しは応答で行を差し替え、一覧は取り直さない', async () => {
    const stub = stubFetch((url) => {
      const u = new URL(url);
      if (u.pathname === '/attachments/a') {
        return json(meta('a', { keptAt: '2026-10-02T00:00:00.000Z', expiresAt: undefined }));
      }
      if (u.pathname === '/attachments') return json({ items: [meta('a')], usage: USAGE });
      return undefined;
    });
    render(
      <Providers>
        <Probe pages={1} />
      </Providers>,
    );
    await waitFor(() => {
      expect(text('ids')).toBe('a');
    });
    await act(async () => {
      await api!.kept('a', true);
    });
    expect(text('ids')).toBe('a*');
    expect(stub.calls.filter((u) => new URL(u).pathname === '/attachments')).toHaveLength(1);
  });

  it('削除は取り直す。404 でも取り直してから失敗として投げる', async () => {
    let items = [meta('a'), meta('b')];
    const stub = stubFetch((url) => {
      const u = new URL(url);
      if (u.pathname === '/attachments/a') {
        items = [meta('b')];
        return new Response(null, { status: 204 });
      }
      if (u.pathname === '/attachments/b') {
        items = [];
        return json({ error: 'not found' }, 404);
      }
      if (u.pathname === '/attachments') return json({ items, usage: USAGE });
      return undefined;
    });
    render(
      <Providers>
        <Probe pages={1} />
      </Providers>,
    );
    await waitFor(() => {
      expect(text('ids')).toBe('a,b');
    });
    await act(async () => {
      await api!.del('a');
    });
    await waitFor(() => {
      expect(text('ids')).toBe('b');
    });
    await act(async () => {
      await expect(api!.del('b')).rejects.toMatchObject({ status: 404 });
    });
    await waitFor(() => {
      expect(text('ids')).toBe('');
    });
    expect(stub.calls.length).toBeGreaterThan(4);
  });

  it('上げるときは keep=1 を付け、上げたあと一覧を取り直す', async () => {
    let items = [meta('a')];
    const stub = stubFetch((url) => {
      const u = new URL(url);
      if (u.pathname === '/attachments' && u.searchParams.has('name')) {
        items = [meta('n', { keptAt: '2026-10-02T00:00:00.000Z' }), ...items];
        return json(items[0]);
      }
      if (u.pathname === '/attachments') return json({ items, usage: USAGE });
      return undefined;
    });
    render(
      <Providers>
        <Probe pages={1} />
      </Providers>,
    );
    await waitFor(() => {
      expect(text('ids')).toBe('a');
    });
    await act(async () => {
      // Node の File で作る: jsdom の File は Node の Request の本文として読めない
      await api!.upload(new NodeFile(['abc'], 'n.txt') as unknown as File, 'text/plain');
    });
    await waitFor(() => {
      expect(text('ids')).toBe('n*,a');
    });
    const post = stub.entries.find((e) => e.request?.method === 'POST');
    expect(new URL(post!.url).searchParams.get('keep')).toBe('1');
  });
});
