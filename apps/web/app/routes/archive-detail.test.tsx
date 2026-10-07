// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import ArchiveDetail from './archive-detail';

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

function stub(
  respond: () => Response | Promise<Response>,
  entries: Record<string, unknown>[] = [],
) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    if (path === '/archive') return json({ entries });
    if (path === '/archive/entry-1') {
      calls.push(path);
      return respond();
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
  return calls;
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/archive/:id', Component: ArchiveDetail },
      { path: '/archive', Component: () => <p>一覧</p> },
    ],
    { initialEntries: ['/archive/entry-1'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...headers } });

describe('/archive/:id', () => {
  it('本文を出し、一覧へ戻るリンクがある', async () => {
    stub(() => text('{"type":"user","text":"こんにちは"}\n{"type":"assistant"}\n'));
    renderPage();

    const pre = await screen.findByTestId('archive-body');
    expect(pre.textContent).toBe('{"type":"user","text":"こんにちは"}\n{"type":"assistant"}\n');
    expect(screen.getByText(/全体を表示しています/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'アーカイブの一覧へ戻る' }).getAttribute('href')).toBe(
      '/archive',
    );
    expect(screen.queryByRole('button', { name: '続きを表示' })).toBeNull();
  });

  it('大きな本文は先頭の窓だけを載せ、続きを表示で足していく（最後まで欠けずに読める）', async () => {
    const line = `${'あ'.repeat(998)}\n`;
    const lines = 350;
    const full = line.repeat(lines);
    stub(() => text(full));
    renderPage();

    const pre = await screen.findByTestId('archive-body');
    const first = pre.textContent!.length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(100_000);
    expect(first).toBeLessThan(full.length);
    expect(pre.textContent!.endsWith('\n')).toBe(true);
    expect(screen.getByText(/長いので少しずつ出します/)).toBeTruthy();

    const more = screen.getByRole('button', { name: '続きを表示' });
    fireEvent.click(more);
    await waitFor(() =>
      expect(screen.getByTestId('archive-body').textContent!.length).toBeGreaterThan(first),
    );
    while (screen.queryByRole('button', { name: '続きを表示' }) !== null) {
      fireEvent.click(screen.getByRole('button', { name: '続きを表示' }));
    }
    expect(screen.getByTestId('archive-body').textContent).toBe(full);
    expect(screen.getByText(/全体を表示しています/)).toBeTruthy();
  });

  it('改行の無い1行が窓より長くても、硬く切って最後まで読める', async () => {
    const full = 'x'.repeat(250_000);
    stub(() => text(full));
    renderPage();

    await screen.findByTestId('archive-body');
    expect(screen.getByTestId('archive-body').textContent!.length).toBe(100_000);
    while (screen.queryByRole('button', { name: '続きを表示' }) !== null) {
      fireEvent.click(screen.getByRole('button', { name: '続きを表示' }));
    }
    expect(screen.getByTestId('archive-body').textContent).toBe(full);
  });

  it('一覧に在る行なら、使用量を読める単位で見出しに出す（生のバイト数にしない）', async () => {
    stub(
      () => text('x'),
      [{ id: 'entry-1', sessionId: 's', at: '2026-09-01T00:00:00.000Z', storedBytes: 11452 }],
    );
    renderPage();

    expect(await screen.findByText('使用量 11.2 KB')).toBeTruthy();
    expect(screen.queryByText(/11452/)).toBeNull();
  });

  it('消された行（410）は失敗ではなく「本文は削除済み」と言う', async () => {
    stub(() => json({ error: 'removed', removedAt: '2026-08-01T00:00:00.000Z', bytes: 1234 }, 410));
    renderPage();

    expect(await screen.findByText('本文は削除済み')).toBeTruthy();
    expect(screen.getByText(/消した本文は 1.2 KB）/)).toBeTruthy();
    expect(screen.queryByText(/1234/)).toBeNull();
    expect(screen.queryByText(/読み込めませんでした/)).toBeNull();
    expect(screen.queryByTestId('archive-body')).toBeNull();
  });

  it('410 の応答の形が読めないときは「消された」と言わず、読めなかったと言う', async () => {
    stub(() => json({ error: 'removed' }, 410));
    renderPage();

    expect(await screen.findByText(/生ログの本文を読み込めませんでした/)).toBeTruthy();
    expect(screen.queryByText('本文は削除済み')).toBeNull();
  });

  it('404 は「その生ログはありません」', async () => {
    stub(() => json({ error: 'not found' }, 404));
    renderPage();

    expect(await screen.findByText('その生ログはありません')).toBeTruthy();
    expect(screen.queryByText(/読み込めませんでした/)).toBeNull();
  });

  it('5xx は「ありません」と言わず、読めなかったと言い、取り直せる', async () => {
    let healthy = false;
    stub(() => (healthy ? text('復旧した本文\n') : json({ error: 'boom' }, 500)));
    renderPage();

    expect(await screen.findByText(/生ログの本文を読み込めませんでした/)).toBeTruthy();
    expect(screen.queryByText('その生ログはありません')).toBeNull();
    expect(screen.queryByTestId('archive-body')).toBeNull();

    healthy = true;
    fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' }));
    const pre = await screen.findByTestId('archive-body');
    expect(pre.textContent).toBe('復旧した本文\n');
    expect(screen.queryByText(/読み込めませんでした/)).toBeNull();
  });

  it('本文が空の200（Content-Length: 0）は失敗ではなく「本文は空です」', async () => {
    stub(() => text('', 200, { 'Content-Length': '0' }));
    renderPage();

    expect(await screen.findByText('本文は空です')).toBeTruthy();
    expect(screen.queryByText(/読み込めませんでした/)).toBeNull();
  });

  it('本文の秘密は伏せ字を通して出す（CLI と同じ）', async () => {
    stub(() => text('token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG\n'));
    renderPage();

    const pre = await screen.findByTestId('archive-body');
    expect(pre.textContent).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });
});
