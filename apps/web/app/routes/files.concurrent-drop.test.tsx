// @vitest-environment jsdom
// ファイルの画面で、上げている間にもう一度ドロップしても、先の結果と断られた理由が消えず、上げ中の表示も早く消えない（#4808）
// 待ちは Promise を手で解決する: 壁時計の待ち（setTimeout）は使わない
import { File as NodeFile } from 'node:buffer';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Files from './files';

let originalFetch: typeof fetch;
/** POST /attachments の応答を待たせている分（名前 → 解放する関数） */
let gates: Map<string, () => void>;
let arrived: Map<string, () => void>;
let arrivals: Map<string, Promise<void>>;

function arrival(name: string): Promise<void> {
  let promise = arrivals.get(name);
  if (promise === undefined) {
    promise = new Promise<void>((resolve) => arrived.set(name, resolve));
    arrivals.set(name, promise);
  }
  return promise;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  gates = new Map();
  arrived = new Map();
  arrivals = new Map();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? (typeof input === 'string' ? input : String(input)));
    const method = request?.method ?? init?.method ?? 'GET';
    if (url.pathname === '/attachments/limits') return json({ error: 'none' }, 404);
    if (url.pathname === '/attachments' && method === 'GET') {
      return json({
        items: [],
        usage: {
          count: 0,
          totalBytes: 0,
          byFrom: {
            human: { count: 0, totalBytes: 0 },
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
      const gate = new Promise<void>((resolve) => gates.set(name, resolve));
      void arrival(name);
      arrived.get(name)?.();
      await gate;
      return json({
        id: `up-${name}`,
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

function file(name: string, content: string[]): File {
  return new NodeFile(content, name, { type: 'text/plain' }) as unknown as File;
}

function drop(files: File[]) {
  fireEvent.drop(screen.getByTestId('file-drop'), {
    dataTransfer: { types: ['Files'], files },
  });
}

function uploadButton(): HTMLElement {
  return screen.getByRole('button', { name: /ファイルを選ぶ/ });
}

describe('ファイル画面: 上げ中の再ドロップ（#4808）', () => {
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

  it('(a) 1本目の上げ中に断られるファイルを落としても、終わった後に両方の結果が見える', async () => {
    renderFiles();
    await screen.findByText('ファイルはまだありません');
    drop([file('a.txt', ['x'])]);
    await arrival('a.txt');
    // 2本目: 0 バイトは手前の検査で断られ、上げには進まない
    drop([file('empty.txt', [])]);
    gates.get('a.txt')!();
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/1 件を上げました/));
    expect(screen.getByRole('status').textContent).toMatch(/empty\.txt/);
    await waitFor(() => expect(uploadButton().hasAttribute('disabled')).toBe(false));
    // 終わった後も両方残る
    expect(screen.getByRole('status').textContent).toMatch(/1 件を上げました/);
    expect(screen.getByRole('status').textContent).toMatch(/empty\.txt/);
  });

  it('(b) 1本目が終わっても2本目が上げ中なら、上げ中の表示は消えない', async () => {
    renderFiles();
    await screen.findByText('ファイルはまだありません');
    drop([file('a.txt', ['x'])]);
    await arrival('a.txt');
    drop([file('b.txt', ['x'])]);
    await arrival('b.txt');
    expect(uploadButton().hasAttribute('disabled')).toBe(true);
    gates.get('a.txt')!();
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/1 件を上げました/));
    // 2本目はまだ上げている
    expect(uploadButton().hasAttribute('disabled')).toBe(true);
    gates.get('b.txt')!();
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/2 件を上げました/));
    await waitFor(() => expect(uploadButton().hasAttribute('disabled')).toBe(false));
  });
});
