// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Commitment } from '@alteroid/core';
import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Commitments from './commitments';

const DAY_MS = 24 * 60 * 60 * 1000;

function commitment(over: Partial<Commitment> = {}): Commitment {
  return {
    id: 'cmt-1',
    at: new Date(Date.now() - 3 * DAY_MS).toISOString(),
    origin: 'human',
    body: 'ドキュメントの誤りを直す',
    ...over,
  };
}

function stubCommitments(open: Commitment[], closed: Commitment[] = []) {
  return stubFetch((url) => {
    if (!url.includes('/commitments')) return undefined;
    if (url.includes('/close')) return json({ ok: true });
    return json({ entries: url.includes('includeClosed=true') ? [...open, ...closed] : open });
  });
}

function recordRequests(): Request[] {
  const requests: Request[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) requests.push(input.clone());
    return inner(input, init);
  }) as typeof fetch;
  return requests;
}

function renderPage() {
  render(
    <Providers>
      <RouterProvider router={createMemoryRouter([{ path: '/', Component: Commitments }])} />
    </Providers>,
  );
}

// 押下の直後に 0 本を測らず待ちを挟む: 送信は非同期で、まだ立っていないだけの状態と区別が付かないため
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
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

// 送るのは ⌘/Ctrl + Enter だけ（チャットと同じ）。以前は Enter 単体で送っていたので、IME の確定の Enter を拾わない門が要った。
// いまは IME の門を ⌘/Ctrl + Enter の側で測る
describe('片付ける（OpenRow）の理由欄 — IME 変換中の ⌘/Ctrl + Enter', () => {
  it('isComposing: true では送らない', async () => {
    stubCommitments([commitment({ id: 'cmt-42' })]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    const input = screen.getByLabelText(/を片付けた理由$/);
    fireEvent.change(input, { target: { value: 'PR #99 をマージした' } });

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: true });
    await settle();
    expect(requests.some((request) => request.url.includes('/close'))).toBe(false);
  });

  it('isComposing: false / keyCode: 229 でも送らない（isComposing が false のまま変換確定を配る実装への備え）', async () => {
    stubCommitments([commitment({ id: 'cmt-42' })]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    const input = screen.getByLabelText(/を片付けた理由$/);
    fireEvent.change(input, { target: { value: 'PR #99 をマージした' } });

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: false, keyCode: 229 });
    await settle();
    expect(requests.some((request) => request.url.includes('/close'))).toBe(false);
  });

  it('Enter 単体・Shift + Enter では送らない', async () => {
    stubCommitments([commitment({ id: 'cmt-42' })]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    const input = screen.getByLabelText(/を片付けた理由$/);
    fireEvent.change(input, { target: { value: 'PR #99 をマージした' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true, isComposing: false });
    await settle();
    expect(requests.some((request) => request.url.includes('/close'))).toBe(false);
  });

  it('isComposing: false（229 でもない）の ⌘/Ctrl + Enter では送る', async () => {
    stubCommitments([commitment({ id: 'cmt-42' })]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    const input = screen.getByLabelText(/を片付けた理由$/);
    fireEvent.change(input, { target: { value: 'PR #99 をマージした' } });

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: false });

    const closed = await waitFor(() => {
      const found = requests.find((request) => request.url.includes('/commitments/cmt-42/close'));
      expect(found).toBeDefined();
      return found!;
    });
    expect(closed.method).toBe('POST');
    expect(JSON.parse(await closed.text())).toEqual({ reason: 'PR #99 をマージした' });
  });
});

describe('積む（PushForm）の本文欄 — IME 変換中の Enter', () => {
  const isPost = (request: Request) =>
    request.method === 'POST' && request.url.endsWith('/commitments');

  it('Enter 単体は、変換中でも確定後でも送らない（改行）', async () => {
    stubCommitments([]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('未了の仕事はない。');
    const input = screen.getByLabelText('何を引き受けたか');
    fireEvent.change(input, { target: { value: '週明けに設計を見直す' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });
    await settle();
    expect(requests.some(isPost)).toBe(false);
  });

  it('Ctrl+Enter でも isComposing: true では送らない', async () => {
    stubCommitments([]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('未了の仕事はない。');
    const input = screen.getByLabelText('何を引き受けたか');
    fireEvent.change(input, { target: { value: '週明けに設計を見直す' } });

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
    await settle();
    expect(requests.some(isPost)).toBe(false);
  });

  it('Ctrl+Enter でも isComposing: false / keyCode: 229 では送らない（isComposing が false のまま変換確定を配る実装への備え）', async () => {
    stubCommitments([]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('未了の仕事はない。');
    const input = screen.getByLabelText('何を引き受けたか');
    fireEvent.change(input, { target: { value: '週明けに設計を見直す' } });

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: false, keyCode: 229 });
    await settle();
    expect(requests.some(isPost)).toBe(false);
  });

  it('Ctrl+Enter（変換中でも 229 でもない）では送る', async () => {
    stubCommitments([]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('未了の仕事はない。');
    const input = screen.getByLabelText('何を引き受けたか');
    fireEvent.change(input, { target: { value: '週明けに設計を見直す' } });

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: false });

    const posted = await waitFor(() => {
      const found = requests.find(isPost);
      expect(found).toBeDefined();
      return found!;
    });
    expect(JSON.parse(await posted.text())).toEqual({ body: '週明けに設計を見直す' });
  });
});
