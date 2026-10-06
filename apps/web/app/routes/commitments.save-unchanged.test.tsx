// @vitest-environment jsdom
/**
 * #3749。本文の編集で、変更が無いとき（元と同じ本文のとき）は ⌘/Ctrl+S でも保存を送らない。
 * ボタンと ⌘/Ctrl+Enter は `dirty` で止まるが、⌘/Ctrl+S は `save()` を直接呼ぶ。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Commitments from './commitments';

let originalFetch: typeof fetch;
let patches: string[];
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  patches = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === 'PATCH' && request.url.includes('/commitments/cmt-1')) {
      patches.push(await request.text());
      return json({ ok: true });
    }
    if (request.url.includes('/commitments')) {
      const at = new Date(Date.now() - 60_000).toISOString();
      return json({
        entries: [{ id: 'cmt-1', origin: 'human', body: 'もとの依頼', at, updatedAt: at }],
      });
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${request.url}`));
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function openEditorTextarea() {
  const router = createMemoryRouter([{ path: '/', Component: Commitments }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  await screen.findByText('もとの依頼');
  fireEvent.click(screen.getByRole('button', { name: /の本文を編集$/ }));
  const tabsRoot = screen.getByRole('tablist').parentElement!;
  fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
  return await within(tabsRoot).findByRole('textbox');
}

describe('本文の編集: 変更が無いときの ⌘/Ctrl+S（#3749）', () => {
  it('元に戻した状態で Ctrl+S を押しても PATCH は送られない', async () => {
    const textarea = await openEditorTextarea();
    fireEvent.change(textarea, { target: { value: '直した依頼' } });
    fireEvent.change(textarea, { target: { value: 'もとの依頼' } });

    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });
    fireEvent.keyDown(textarea, { key: 's', metaKey: true });
    // 送られるなら、このあいだに fetch へ届く（実時間は待たず、約束を何周か流す）。
    for (let i = 0; i < 10; i += 1) await act(async () => {});
    expect(patches).toEqual([]);
    expect(screen.getByRole('tablist')).toBeTruthy();
  });

  it('変えた状態では Ctrl+S で PATCH が送られる', async () => {
    const textarea = await openEditorTextarea();
    fireEvent.change(textarea, { target: { value: '直した依頼' } });

    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(JSON.parse(patches[0]!)).toEqual({ body: '直した依頼' });
  });
});
