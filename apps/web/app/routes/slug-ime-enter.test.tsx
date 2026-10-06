// @vitest-environment jsdom
/**
 * **記憶・やり方の一覧の「名前」欄で、IME の変換を確定する Enter を遷移として拾わないこと**（#3212）。
 *
 * この2つの欄は Enter 単体で新規作成の画面へ遷移する。#3058 で他の欄に入れた
 * `isImeConfirmEnter` の門が無いと、日本語入力の変換確定の Enter で、途中の文字列のまま
 * 意図せず遷移する。測り方は `commitments.ime-enter.test.tsx` と同じく、同じ入力・同じキーで
 * `isComposing` / `keyCode` だけを変え、**変換中は動かず、確定後は動く**を1本の中で両側通す
 * （片側だけでは「そもそも遷移できていない」と区別が付かない）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Memory from './memory';
import Practices from './practices';

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

/** React の更新とマイクロタスクを一巡させる（「遷移していない」を測る前の待ち）。 */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

const CASES = [
  {
    name: '記憶（/memory）',
    Component: Memory,
    listPath: '/memory',
    detailPath: '/memory/:slug',
    listKey: 'documents',
  },
  {
    name: 'やり方（/practices）',
    Component: Practices,
    listPath: '/practices',
    detailPath: '/practices/:slug',
    listKey: 'practices',
  },
] as const;

describe.each(CASES)('$name の名前欄 — IME 変換中の Enter', (c) => {
  function renderPage() {
    stubFetch((url) => (url.includes(c.listPath) ? json({ [c.listKey]: [] }) : undefined));
    const router = createMemoryRouter(
      [
        { path: '/', Component: c.Component },
        { path: c.detailPath, Component: () => null },
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

  async function typeSlug(): Promise<HTMLElement> {
    const input = await screen.findByLabelText(/^名前（/);
    fireEvent.change(input, { target: { value: 'work-style' } });
    return input;
  }

  it('isComposing: true では遷移しない', async () => {
    const router = renderPage();
    const input = await typeSlug();

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    await flush();
    expect(router.state.location.pathname).toBe('/');
  });

  it('isComposing: false / keyCode: 229 でも遷移しない', async () => {
    const router = renderPage();
    const input = await typeSlug();

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false, keyCode: 229 });
    await flush();
    expect(router.state.location.pathname).toBe('/');
  });

  it('isComposing: false（229 でもない）では、既存どおり遷移する', async () => {
    const router = renderPage();
    const input = await typeSlug();

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });
    await waitFor(() => expect(router.state.location.pathname).toBe(`${c.listPath}/work-style`));
  });
});
