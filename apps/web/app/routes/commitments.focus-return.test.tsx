// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Commitments from './commitments';

let originalFetch: typeof fetch;
let closedIds: Set<string>;
let ids: string[];
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  closedIds = new Set();
  ids = ['cmt-1', 'cmt-2'];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname.endsWith('/close')) {
      closedIds.add(url.pathname.split('/')[2]!);
      return json({ ok: true });
    }
    if (request.method === 'PATCH') return json({ ok: true });
    if (url.pathname === '/commitments') {
      const at = new Date(Date.now() - 60_000).toISOString();
      return json({
        entries: ids
          .filter((id) => !closedIds.has(id))
          .map((id) => ({ id, origin: 'human', body: `依頼 ${id}`, at, updatedAt: at })),
      });
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${request.url}`));
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Commitments }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  await screen.findByText(`依頼 ${ids[0]}`);
}

async function openEditor(id: string) {
  fireEvent.click(screen.getByRole('button', { name: `「依頼 ${id}」の本文を編集` }));
  const tabsRoot = screen.getByRole('tablist').parentElement!;
  fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
  return await within(tabsRoot).findByRole('textbox');
}

describe('操作のあと、押したボタンが消えてもフォーカスが文書の先頭へ落ちない（#4001）', () => {
  it('本文を保存して編集欄が閉じたら、その行の「本文を編集」へ戻る', async () => {
    await renderPage();
    const textarea = await openEditor('cmt-1');
    fireEvent.change(textarea, { target: { value: '直した依頼' } });
    const save = screen.getByRole('button', { name: '保存' });
    save.focus();
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '「依頼 cmt-1」の本文を編集' }),
    );
  });

  it('「編集をやめる」（書きかけなし）で閉じても、その行の「本文を編集」へ戻る', async () => {
    await renderPage();
    await openEditor('cmt-1');
    const cancel = screen.getByRole('button', { name: /の編集をやめる$/ });
    cancel.focus();
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '「依頼 cmt-1」の本文を編集' }),
    );
  });

  it('書きかけを「破棄して閉じる」で閉じても、その行の「本文を編集」へ戻る', async () => {
    await renderPage();
    const textarea = await openEditor('cmt-1');
    fireEvent.change(textarea, { target: { value: '書きかけ' } });
    fireEvent.click(screen.getByRole('button', { name: /の編集をやめる$/ }));
    const discard = await screen.findByRole('button', { name: '破棄して閉じる' });
    discard.focus();
    fireEvent.click(discard);
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '「依頼 cmt-1」の本文を編集' }),
    );
  });

  it('「片付いた」で行が外れたら、次の行の「本文を編集」へ送る', async () => {
    await renderPage();
    fireEvent.change(screen.getByRole('textbox', { name: '「依頼 cmt-1」を片付けた理由' }), {
      target: { value: '済んだ' },
    });
    const done = screen.getByRole('button', { name: '「依頼 cmt-1」が片付いた' });
    done.focus();
    fireEvent.click(done);
    await waitFor(() => expect(screen.queryByText('依頼 cmt-1')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: '「依頼 cmt-2」の本文を編集' }),
      ),
    );
  });

  it('最後の行が外れたら、前の行へ。1件だけなら「未了」の見出しへ送る', async () => {
    await renderPage();
    fireEvent.change(screen.getByRole('textbox', { name: '「依頼 cmt-2」を片付けた理由' }), {
      target: { value: '済んだ' },
    });
    const second = screen.getByRole('button', { name: '「依頼 cmt-2」が片付いた' });
    second.focus();
    fireEvent.click(second);
    await waitFor(() => expect(screen.queryByText('依頼 cmt-2')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: '「依頼 cmt-1」の本文を編集' }),
      ),
    );

    fireEvent.change(screen.getByRole('textbox', { name: '「依頼 cmt-1」を片付けた理由' }), {
      target: { value: '済んだ' },
    });
    const first = screen.getByRole('button', { name: '「依頼 cmt-1」が片付いた' });
    first.focus();
    fireEvent.click(first);
    await waitFor(() => expect(screen.queryByText('依頼 cmt-1')).toBeNull());
    await waitFor(() => {
      const active = document.activeElement;
      expect(active).not.toBe(document.body);
      expect(active?.textContent).toContain('未了');
    });
  });
});
