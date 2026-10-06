// @vitest-environment jsdom
/**
 * #3750。未了の行の「片付けた理由」の書きかけも、離れる前の確認（`useReportDirty`）に知らせる。
 * 流儀は `commitments.test.tsx` の「本文の編集: 未保存のまま離れる前に確認する（#2764）」に揃える。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

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

/** 片付けたあとの一覧は空（行が消える）。 */
function stubRow() {
  let closed = false;
  stubFetch((url) => {
    if (!url.includes('/commitments')) return undefined;
    if (url.includes('/close')) {
      closed = true;
      return json({ ok: true });
    }
    const at = new Date(Date.now() - 60_000).toISOString();
    return json({
      entries: closed
        ? []
        : [{ id: 'cmt-1', origin: 'human', body: 'もとの依頼', at, updatedAt: at }],
    });
  });
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/', Component: Commitments },
      { path: '/elsewhere', Component: () => <p>別の画面</p> },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

async function leave(router: ReturnType<typeof renderPage>) {
  await act(async () => {
    void router.navigate('/elsewhere');
  });
}

describe('片付けた理由の書きかけ: 離れる前に確認する（#3750）', () => {
  it('理由を打って別の画面へ移ろうとすると確認が出る。やめれば留まり、書きかけが残る', async () => {
    stubRow();
    const router = renderPage();
    await screen.findByText('もとの依頼');
    fireEvent.change(screen.getByLabelText(/を片付けた理由$/), { target: { value: '書きかけ' } });

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await leave(router);
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/');
    expect((screen.getByLabelText(/を片付けた理由$/) as HTMLTextAreaElement).value).toBe(
      '書きかけ',
    );
  });

  it('空に戻す（空白だけも含む）と確認なしで移動できる', async () => {
    stubRow();
    const router = renderPage();
    await screen.findByText('もとの依頼');
    const reason = screen.getByLabelText(/を片付けた理由$/);
    fireEvent.change(reason, { target: { value: '書きかけ' } });
    fireEvent.change(reason, { target: { value: '   ' } });

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);

    await leave(router);
    await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('片付けて行が消えたあとは、書きかけの印が残らず確認なしで移動できる', async () => {
    stubRow();
    const router = renderPage();
    await screen.findByText('もとの依頼');
    fireEvent.change(screen.getByLabelText(/を片付けた理由$/), { target: { value: '済んだ' } });
    fireEvent.click(screen.getByRole('button', { name: /が片付いた$/ }));
    await waitFor(() => expect(screen.queryByText('もとの依頼')).toBeNull());
    // 行のアンマウントで外れる（報告の取り下げは次の描画で効くので、効くまで待つ）。
    await waitFor(() => {
      const unload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(false);
    });

    await leave(router);
    await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
