// @vitest-environment jsdom
/**
 * **IME で変換している最中の Enter を、送信として拾わないこと。**
 *
 * `/commitments` 画面には、Enter 単体で送る口が2つある — 「片付ける」の理由欄
 * （`OpenRow`）と「積む」の本文欄（`PushForm`）。**`chat.tsx` と違い、こちらは
 * 修飾キーを要らない形（Enter 単体）なので、日本語入力の変換確定 Enter が
 * 毎回そのまま送信になっていた。** `chat.ime-enter.test.tsx` が置いた歯（門の
 * 形・測り方）に倣い、この2箇所についても同じ形の歯を置く。
 *
 * **測り方**: 同じ入力・同じキーで `isComposing` / `keyCode` だけを変えて、
 * それぞれの送信経路（片付ける → `POST /commitments/:id/close`、積む →
 * `POST /commitments`）が立つか立たないかを見る。片側だけでは「そもそも
 * 送れていない」と区別が付かないので、**必ず両側（変換中→送らない、
 * 確定後→送る）を1本の中で通す**。
 *
 * `isComposing` / `keyCode` が jsdom の `KeyboardEvent` から React の
 * `nativeEvent` まで実際に運ばれることは `chat.ime-enter.test.tsx` が別立てで
 * 実測済み（`fireEvent.keyDown` の init に載せた値が、そのまま
 * `event.nativeEvent.isComposing` / `event.nativeEvent.keyCode` に出る）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/** `includeClosed=true` を付けたときだけ、片付けたものも返す（`commitments.test.tsx` と同じ形）。 */
function stubCommitments(open: Commitment[], closed: Commitment[] = []) {
  return stubFetch((url) => {
    if (!url.includes('/commitments')) return undefined;
    if (url.includes('/close')) return json({ ok: true });
    return json({ entries: url.includes('includeClosed=true') ? [...open, ...closed] : open });
  });
}

/**
 * 実際に飛んだ要求を控える（`commitments.test.tsx` の `recordRequests` と同じ形。
 * このファイルは `chat.ime-enter.test.tsx` に倣って別ファイルへ切り出したので、
 * ヘルパーは import せずここでも素通しの記録として持つ）。
 */
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
      <Commitments />
    </Providers>,
  );
}

/**
 * 「送られていない」を測るための待ち（`chat.ime-enter.test.tsx` の `settle` と同じ形）。
 *
 * ⚠️ **押下の直後に `expect(...).toBe(0)` を置くだけでは足りない** — 送信は
 * 非同期なので、まだ立っていないだけの状態と区別が付かない。React の更新と
 * マイクロタスクを一巡させてから測る。
 */
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

describe('片付ける（OpenRow）の理由欄 — IME 変換中の Enter', () => {
  it('isComposing: true では送らない', async () => {
    stubCommitments([commitment({ id: 'cmt-42' })]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    const input = screen.getByPlaceholderText(/何をもって片付いたか/);
    fireEvent.change(input, { target: { value: 'PR #99 をマージした' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    await settle();
    expect(requests.some((request) => request.url.includes('/close'))).toBe(false);
  });

  it('isComposing: false / keyCode: 229 でも送らない（isComposing が false のまま変換確定を配る実装への備え）', async () => {
    stubCommitments([commitment({ id: 'cmt-42' })]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    const input = screen.getByPlaceholderText(/何をもって片付いたか/);
    fireEvent.change(input, { target: { value: 'PR #99 をマージした' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false, keyCode: 229 });
    await settle();
    expect(requests.some((request) => request.url.includes('/close'))).toBe(false);
  });

  it('isComposing: false（229 でもない）では、既存どおり送る', async () => {
    stubCommitments([commitment({ id: 'cmt-42' })]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    const input = screen.getByPlaceholderText(/何をもって片付いたか/);
    fireEvent.change(input, { target: { value: 'PR #99 をマージした' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });

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
  it('isComposing: true では送らない', async () => {
    stubCommitments([]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('引き受けたまま終わっていない仕事はない。');
    const input = screen.getByPlaceholderText(/何を引き受けたか/);
    fireEvent.change(input, { target: { value: '週明けに設計を見直す' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    await settle();
    expect(
      requests.some((request) => request.method === 'POST' && request.url.endsWith('/commitments')),
    ).toBe(false);
  });

  it('isComposing: false / keyCode: 229 でも送らない（isComposing が false のまま変換確定を配る実装への備え）', async () => {
    stubCommitments([]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('引き受けたまま終わっていない仕事はない。');
    const input = screen.getByPlaceholderText(/何を引き受けたか/);
    fireEvent.change(input, { target: { value: '週明けに設計を見直す' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false, keyCode: 229 });
    await settle();
    expect(
      requests.some((request) => request.method === 'POST' && request.url.endsWith('/commitments')),
    ).toBe(false);
  });

  it('isComposing: false（229 でもない）では、既存どおり送る', async () => {
    stubCommitments([]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('引き受けたまま終わっていない仕事はない。');
    const input = screen.getByPlaceholderText(/何を引き受けたか/);
    fireEvent.change(input, { target: { value: '週明けに設計を見直す' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });

    const posted = await waitFor(() => {
      const found = requests.find(
        (request) => request.method === 'POST' && request.url.endsWith('/commitments'),
      );
      expect(found).toBeDefined();
      return found!;
    });
    expect(JSON.parse(await posted.text())).toEqual({ body: '週明けに設計を見直す' });
  });
});
