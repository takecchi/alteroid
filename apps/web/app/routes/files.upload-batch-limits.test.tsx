// @vitest-environment jsdom
// ファイルの置き場への複数アップロードが、チャットの「1発言の上限」（10個・合計50MiB）で断られる
import { File as NodeFile } from 'node:buffer';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Files from './files';

let originalFetch: typeof fetch;
let posts: string[];
let stored: { id: string; name: string }[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  posts = [];
  stored = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? (typeof input === 'string' ? input : String(input)));
    const method = request?.method ?? init?.method ?? 'GET';
    if (url.pathname === '/attachments/limits') return json({ error: 'none' }, 404);
    if (url.pathname === '/attachments' && method === 'GET') {
      return json({
        items: stored.map((s) => ({
          ...s,
          mediaType: 'text/plain',
          size: 1,
          sha256: 'x',
          createdAt: '2026-10-01T00:00:00.000Z',
          keptAt: '2026-10-01T00:00:00.000Z',
          uploadedBy: 'operator',
        })),
        usage: {
          count: stored.length,
          totalBytes: stored.length,
          byFrom: {
            human: { count: stored.length, totalBytes: stored.length },
            clone: { count: 0, totalBytes: 0 },
            manager: { count: 0, totalBytes: 0 },
            integration: { count: 0, totalBytes: 0 },
            unknown: { count: 0, totalBytes: 0 },
          },
        },
      });
    }
    if (url.pathname === '/attachments' && method === 'POST') {
      await request!.arrayBuffer();
      const name = url.searchParams.get('name') ?? 'x';
      posts.push(name);
      const id = `up-${posts.length}`;
      stored.push({ id, name });
      return json({
        id,
        name,
        mediaType: 'text/plain',
        size: 1,
        sha256: 'x',
        createdAt: '2026-10-01T00:00:00.000Z',
        keptAt: '2026-10-01T00:00:00.000Z',
        uploadedBy: 'operator',
      });
    }
    return json({ error: 'unexpected' }, 500);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('ファイル画面: 複数アップロード（#4559）', () => {
  function renderFiles() {
    render(
      <Providers>
        <MemoryRouter initialEntries={['/files']}>
          <Routes>
            <Route path="/files" element={<Files />} />
          </Routes>
        </MemoryRouter>
      </Providers>,
    );
  }

  it('11 個選んだら 11 個とも上げる（置き場のアップロードは「1発言」ではない）', async () => {
    renderFiles();
    await screen.findByText('ファイルはまだありません');
    const files = Array.from(
      { length: 11 },
      (_, i) => new NodeFile(['x'], `f${i}.txt`, { type: 'text/plain' }) as unknown as File,
    );
    fireEvent.change(screen.getByLabelText('アップロードするファイル'), {
      target: { files },
    });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/上げました/));
    expect(posts).toHaveLength(11);
    // 「1 発言に … 個まで」の断りは出さない
    expect(screen.queryByText(/1 発言に添えられるのは/)).toBeNull();
  });

  it('対照: 1件ごとの検査（0 バイト）は今までどおり断り、ほかは上げる', async () => {
    renderFiles();
    await screen.findByText('ファイルはまだありません');
    const files = [
      new NodeFile(['x'], 'ok.txt', { type: 'text/plain' }) as unknown as File,
      new NodeFile([], 'empty.txt', { type: 'text/plain' }) as unknown as File,
    ];
    fireEvent.change(screen.getByLabelText('アップロードするファイル'), {
      target: { files },
    });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/上げました/));
    expect(posts).toEqual(['ok.txt']);
    expect(screen.getByText(/empty\.txt/)).toBeTruthy();
  });
});
