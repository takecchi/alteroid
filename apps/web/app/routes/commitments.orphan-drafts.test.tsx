// @vitest-environment jsdom
/**
 * #3751。書きかけ（本文の編集の下書き・片付けた理由）か出したままの失敗がある行が、裏で片付いて
 * 未了の一覧から外れても、黙って消さない。「既に片付いた」と断って残し、写せて、閉じられる。
 * 承認の画面の #3527 / #3515（`approvals.draft-kept-typed.test.tsx`）と同じ形。
 *
 * 一覧の取り直しは、画面の「積む」（自分の別の書き込み）で起こす。実時間の待ちは書かない。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Commitment } from '@alteroid/core';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Commitments from './commitments';

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

const ENTRY: Commitment = {
  id: 'cmt-1',
  at: '2026-09-01T00:00:00.000Z',
  origin: 'human',
  body: 'もとの本文',
};

/**
 * 台帳の代役。`entries` を書き換えると、次の一覧の取得からその状態が返る（裏で片付いた・消えた）。
 * `conflict` を立てると、片付ける・保存が 409 で断られる。
 */
function stubServer() {
  const server = {
    entries: [ENTRY] as Commitment[],
    conflict: false,
    writes: [] as string[],
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/commitments'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'GET') return json({ entries: server.entries });
    server.writes.push(`${request.method} ${new URL(request.url).pathname}`);
    if (server.conflict && request.url.match(/\/commitments\/cmt-1/)) {
      return json({ error: 'cmt-1 は既に片付いている（別のタブで）' }, 409);
    }
    if (request.method === 'POST' && request.url.endsWith('/commitments')) {
      return json({ entry: { ...ENTRY, id: 'cmt-9', body: 'ほかの件' } });
    }
    if (request.url.includes('/close')) {
      server.entries = [];
      return json({ ok: true });
    }
    return json({ entry: ENTRY });
  }) as typeof fetch;
  return server;
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Commitments }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

/** 本文の編集欄を開いて、編集タブへ下書きを打つ。 */
async function typeDraft(text: string) {
  fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));
  const tabsRoot = screen.getByRole('tablist').parentElement!;
  fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
  const textarea = await within(tabsRoot).findByRole('textbox');
  fireEvent.change(textarea, { target: { value: text } });
}

/** 自分の別の書き込み（積む）で一覧を取り直させる。 */
async function refetchViaPush(server: ReturnType<typeof stubServer>) {
  fireEvent.change(screen.getByLabelText('何を引き受けたか'), { target: { value: 'ほかの件' } });
  fireEvent.click(screen.getByRole('button', { name: '積む' }));
  await waitFor(() => expect(server.writes).toContain('POST /commitments'));
}

describe('書きかけのある行が、裏で片付いて一覧から外れたとき（#3751）', () => {
  it('編集の下書きがある行は、取り直しで未了から外れても下書きを残し、既に片付いたと断る', async () => {
    const server = stubServer();
    renderPage();
    await screen.findByText('もとの本文');
    await typeDraft('書きかけの本文を直した');

    server.entries = [];
    await refetchViaPush(server);

    expect(await screen.findByText(/この仕事は既に片付いた/)).toBeTruthy();
    expect(screen.getByText('書きかけの本文を直した')).toBeTruthy();
    // 行そのものは未了から外れている（編集欄も、片付ける欄も残らない）。
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    expect(screen.queryByLabelText(/を片付けた理由$/)).toBeNull();
  });

  it('片付けた理由の書きかけがある行も、同じように残す', async () => {
    const server = stubServer();
    renderPage();
    await screen.findByText('もとの本文');
    fireEvent.change(screen.getByLabelText(/を片付けた理由$/), {
      target: { value: '直して確かめた' },
    });

    server.entries = [];
    await refetchViaPush(server);

    expect(await screen.findByText(/この仕事は既に片付いた/)).toBeTruthy();
    expect(screen.getByText('直して確かめた')).toBeTruthy();
    expect(screen.queryByLabelText(/を片付けた理由$/)).toBeNull();
  });

  it('書きかけも失敗も無い行は、今までどおり静かに消える（断りを出さない）', async () => {
    const server = stubServer();
    renderPage();
    await screen.findByText('もとの本文');

    server.entries = [];
    await refetchViaPush(server);

    await waitFor(() => expect(screen.queryByText('もとの本文')).toBeNull());
    expect(screen.queryByText(/この仕事は既に片付いた/)).toBeNull();
    expect(screen.queryByRole('list', { name: '一覧から外れた仕事' })).toBeNull();
  });

  it('空白だけの理由・元と同じ本文は書きかけに数えない（残しすぎない）', async () => {
    const server = stubServer();
    renderPage();
    await screen.findByText('もとの本文');
    fireEvent.change(screen.getByLabelText(/を片付けた理由$/), { target: { value: '   ' } });
    await typeDraft('もとの本文');

    server.entries = [];
    await refetchViaPush(server);

    await waitFor(() => expect(screen.queryByText('もとの本文')).toBeNull());
    expect(screen.queryByText(/この仕事は既に片付いた/)).toBeNull();
  });

  it('「閉じる（見送る）」で消える', async () => {
    const server = stubServer();
    renderPage();
    await screen.findByText('もとの本文');
    fireEvent.change(screen.getByLabelText(/を片付けた理由$/), { target: { value: '書きかけ' } });
    server.entries = [];
    await refetchViaPush(server);
    await screen.findByText(/この仕事は既に片付いた/);

    fireEvent.click(screen.getByRole('button', { name: '閉じる（見送る）' }));

    expect(screen.queryByText(/この仕事は既に片付いた/)).toBeNull();
    expect(screen.queryByText('書きかけ')).toBeNull();
  });

  it('残した書きかけは離れる前の確認に載り、閉じると載らなくなる', async () => {
    const server = stubServer();
    renderPage();
    await screen.findByText('もとの本文');
    fireEvent.change(screen.getByLabelText(/を片付けた理由$/), { target: { value: '書きかけ' } });
    server.entries = [];
    await refetchViaPush(server);
    await screen.findByText(/この仕事は既に片付いた/);

    const kept = new Event('beforeunload', { cancelable: true });
    act(() => {
      window.dispatchEvent(kept);
    });
    expect(kept.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '閉じる（見送る）' }));
    await waitFor(() => {
      const closed = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(closed);
      expect(closed.defaultPrevented).toBe(false);
    });
  });
});

describe('保存・片付けが 409 で断られたとき（#3751）', () => {
  it('片付けるが 409 で返り、行が一覧から外れても、失敗の本文と理由の書きかけを見せる', async () => {
    const server = stubServer();
    renderPage();
    await screen.findByText('もとの本文');
    fireEvent.change(screen.getByLabelText(/を片付けた理由$/), { target: { value: '直した' } });
    // 別経路で先に片付いた: 書き込みは 409、取り直した一覧には行が無い。
    server.conflict = true;
    server.entries = [];
    fireEvent.click(screen.getByRole('button', { name: /が片付いた$/ }));

    expect(await screen.findByText(/既に片付いている（別のタブで）/)).toBeTruthy();
    expect(screen.getByText(/この仕事は既に片付いた/)).toBeTruthy();
    expect(screen.getByText('直した')).toBeTruthy();
  });

  it('本文の保存が 409 で返り、行が一覧から外れても、失敗の本文と下書きを見せる', async () => {
    const server = stubServer();
    renderPage();
    await screen.findByText('もとの本文');
    await typeDraft('直した本文');
    server.conflict = true;
    server.entries = [];
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/既に片付いている（別のタブで）/)).toBeTruthy();
    expect(screen.getByText('直した本文')).toBeTruthy();
    expect(screen.getByText(/この仕事は既に片付いた/)).toBeTruthy();
  });

  it('自分の片付けが通ったときは、断りを出さない（応答を待つ間に行が消えても）', async () => {
    const server = stubServer();
    renderPage();
    await screen.findByText('もとの本文');
    fireEvent.change(screen.getByLabelText(/を片付けた理由$/), { target: { value: '直した' } });
    fireEvent.click(screen.getByRole('button', { name: /が片付いた$/ }));

    await waitFor(() => expect(screen.queryByText('もとの本文')).toBeNull());
    await waitFor(() => expect(server.writes.some((w) => w.includes('/close'))).toBe(true));
    await act(async () => {});
    expect(screen.queryByText(/この仕事は既に片付いた/)).toBeNull();
    expect(screen.queryByText('直した')).toBeNull();
  });
});
