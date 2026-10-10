// @vitest-environment jsdom
/**
 * 本文の編集は、開いた時点の版（`editedAt ?? at`）を `ifMatch` で送る。
 * 開いたあとに裏で本文が変わっていたら 409 で断られ、下書きを残したまま選ばせる。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const AT = '2026-09-01T00:00:00.000Z';
const BEHIND_AT = '2026-09-02T00:00:00.000Z';
const SELF_AT = '2026-09-03T00:00:00.000Z';
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

type Patch = { body: string; ifMatch?: string };

function stubServer(
  options: {
    conflictBody?: unknown;
    listAfterConflict?: Commitment[];
    /** 自分の書き込みの直後に、別の書き手が本文を書き換える。 */
    behindRightAfterWrite?: string;
  } = {},
) {
  let row: Commitment = { id: 'cmt-1', at: AT, origin: 'human', body: 'もとの本文' };
  let conflicted = false;
  const patches: Patch[] = [];
  let getsAfterPatch = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/commitments'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'GET') {
      if (patches.length > 0) getsAfterPatch += 1;
      return json({ entries: conflicted ? (options.listAfterConflict ?? [row]) : [row] });
    }
    const sent = (await request.json()) as Patch;
    patches.push(sent);
    if (options.conflictBody !== undefined && !conflicted) {
      conflicted = true;
      return json(options.conflictBody, 409);
    }
    if (sent.ifMatch !== undefined && sent.ifMatch !== (row.editedAt ?? row.at)) {
      conflicted = true;
      return json({ error: '本文が読んだ後に変わっている', current: row }, 409);
    }
    row = { ...row, body: sent.body, editedAt: SELF_AT, editedBy: 'human' };
    if (options.behindRightAfterWrite !== undefined) {
      row = { ...row, body: options.behindRightAfterWrite, editedAt: BEHIND_AT };
    }
    return json({ ok: true });
  }) as typeof fetch;
  return {
    patches,
    getsAfterPatch: () => getsAfterPatch,
    /** 編集欄を開いたあとの、別のタブ・CLI の書き込み。 */
    changeBehind: (body: string) => {
      row = { ...row, body, editedAt: BEHIND_AT, editedBy: 'human' };
    },
    current: () => row,
  };
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

async function openEditorAndType(draft: string) {
  await screen.findByText('もとの本文');
  fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));
  const tabsRoot = screen.getByRole('tablist').parentElement!;
  fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
  const textarea = (await within(tabsRoot).findByRole('textbox')) as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: draft } });
  return { textarea };
}

describe('本文の編集と版の照合（#3786）', () => {
  it('編集を開いた時点の版（editedAt が無ければ at）を ifMatch で送る', async () => {
    const server = stubServer();
    renderPage();
    await openEditorAndType('直した本文');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(server.patches).toHaveLength(1));
    expect(server.patches[0]).toEqual({ body: '直した本文', ifMatch: AT });
  });

  it('開いたあとに裏で変わっていたら、書かずに断り、下書きと裏の本文を並べて見せる', async () => {
    const server = stubServer();
    renderPage();
    const { textarea } = await openEditorAndType('自分の下書き');
    server.changeBehind(`裏の本文 ${SECRET}`);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/開いたあとに、裏でこの本文が変わった/)).toBeTruthy();
    expect(server.current().body).toBe(`裏の本文 ${SECRET}`);
    expect(textarea.value).toBe('自分の下書き');
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/裏の本文/)).toBeTruthy();
    expect(alert.textContent).not.toContain(SECRET);
    expect(server.patches).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'いまの本文の上で、下書きを保存し直す' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '下書きを捨てて、いまの本文にする' })).toBeTruthy();
  });

  it('自分の保存のあとに裏で書き換わっていたら、その版を拾わず、次の保存は 409 で衝突の枠に落ちる', async () => {
    const server = stubServer({ behindRightAfterWrite: '裏の本文' });
    renderPage();
    const { textarea } = await openEditorAndType('一回目');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.change(textarea, { target: { value: '一回目に打ち足す' } });
    await waitFor(() => expect(server.patches).toHaveLength(1));
    await waitFor(() => expect(server.getsAfterPatch()).toBeGreaterThanOrEqual(1));
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(false),
    );

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(server.patches).toHaveLength(2));
    expect(server.patches[1]).toEqual({ body: '一回目に打ち足す', ifMatch: AT });
    expect(await screen.findByText(/開いたあとに、裏でこの本文が変わった/)).toBeTruthy();
    expect(server.current().body).toBe('裏の本文');
  });

  it('応答を待つ間に打ち足して下書きが残ったときは、自分の書き込みで進んだ版で次を送る（自分と衝突しない）', async () => {
    const server = stubServer();
    renderPage();
    const { textarea } = await openEditorAndType('一回目');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.change(textarea, { target: { value: '一回目に打ち足す' } });
    await waitFor(() => expect(server.patches).toHaveLength(1));
    await waitFor(() => expect(server.current().editedAt).toBeDefined());
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(false),
    );

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(server.patches).toHaveLength(2));
    expect(server.patches[1]).toEqual({ body: '一回目に打ち足す', ifMatch: SELF_AT });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('「保存し直す」は、裏の版を前提にして下書きを送る', async () => {
    const server = stubServer();
    renderPage();
    await openEditorAndType('自分の下書き');
    server.changeBehind('裏の本文');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'いまの本文の上で、下書きを保存し直す' }),
    );

    await waitFor(() => expect(server.patches).toHaveLength(2));
    expect(server.patches[1]).toEqual({ body: '自分の下書き', ifMatch: BEHIND_AT });
    expect(server.current().body).toBe('自分の下書き');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('「下書きを捨てる」は、何も書かず今の本文に戻し、次の保存は裏の版で送る', async () => {
    const server = stubServer();
    renderPage();
    const { textarea } = await openEditorAndType('自分の下書き');
    server.changeBehind('裏の本文');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.click(
      await screen.findByRole('button', { name: '下書きを捨てて、いまの本文にする' }),
    );

    await waitFor(() => expect(textarea.value).toBe('裏の本文'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(server.patches).toHaveLength(1);
    expect(server.current().body).toBe('裏の本文');

    fireEvent.change(textarea, { target: { value: '裏の本文を直す' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(server.patches).toHaveLength(2));
    expect(server.patches[1]).toEqual({ body: '裏の本文を直す', ifMatch: BEHIND_AT });
  });

  it('片付き済みの 409（current の鍵が無い）は版の衝突と見なさず、これまでどおり失敗として出す', async () => {
    const server = stubServer({ conflictBody: { error: 'cmt-1 は既に片付いている' } });
    renderPage();
    const { textarea } = await openEditorAndType('自分の下書き');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(server.patches).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/開いたあとに、裏で/)).toBeNull());
    expect(screen.queryByRole('button', { name: /保存し直す/ })).toBeNull();
    expect(textarea.value).toBe('自分の下書き');
  });

  it('行が消えていた（current: null）ときは、既に片付いたと断る書きかけの扱いになる', async () => {
    stubServer({
      conflictBody: { error: '本文が読んだ後に変わっている', current: null },
      listAfterConflict: [],
    });
    renderPage();
    await openEditorAndType('自分の下書き');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/この仕事は既に片付いた/)).toBeTruthy();
    expect(screen.getByText('自分の下書き')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /保存し直す/ })).toBeNull();
  });
});
