// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadApprovalDrafts, saveApprovalDrafts, type PendingApproval } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Approvals from './approvals';

function approval(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'a-1',
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
    question: '本番に出してよいか',
    ...over,
  };
}

const questions: NonNullable<PendingApproval['questions']> = [
  {
    id: 'deploy',
    prompt: 'デプロイ先',
    options: [
      { id: 'railway', label: 'Railway' },
      { id: 'fly', label: 'Fly.io' },
    ],
  },
];

const free = approval({ id: 'a-free', question: '自由記述の件' });
const asked = approval({ id: 'a-ask', question: '設問の件', questions });

function stub(respond: () => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname === '/approvals') return respond();
    if (/^\/approvals\/[^/]+\/answer$/.test(url.pathname)) return json({ ok: true });
    return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
  }) as typeof fetch;
}

function renderPages() {
  const router = createMemoryRouter(
    [
      { path: '/approvals', Component: Approvals },
      { path: '/approvals/answered', Component: () => <p>回答済みのページ</p> },
    ],
    { initialEntries: ['/approvals'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('承認待ちの下書き（issue #3295）', () => {
  it('書く → 回答済みタブへ移る → 戻ると、書きかけと設問の選択が残る', async () => {
    stub(() => json({ approvals: [free, asked] }));
    const router = renderPages();

    fireEvent.change(await screen.findByPlaceholderText(/答える/), {
      target: { value: '書きかけの答え' },
    });
    fireEvent.click(screen.getByRole('button', { name: '選択肢を開いて答える' }));
    fireEvent.click(screen.getByRole('radio', { name: /Fly\.io/ }));
    expect(await screen.findByText('1 件に答えを書いた（送るとまとめて1回で届く）')).toBeTruthy();

    await act(() => router.navigate('/approvals/answered'));
    expect(await screen.findByText('回答済みのページ')).toBeTruthy();
    await act(() => router.navigate('/approvals'));

    expect(((await screen.findByPlaceholderText(/答える/)) as HTMLTextAreaElement).value).toBe(
      '書きかけの答え',
    );
    expect(screen.getByText('1 件に答えを書いた（送るとまとめて1回で届く）')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Fly\.io/ }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('radio', { name: /Railway/ }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('再読み込み（保存した下書きだけ在る状態）でも戻る', async () => {
    saveApprovalDrafts({ texts: { 'a-free': '前に書いた' }, questions: {} });
    stub(() => json({ approvals: [free] }));
    renderPages();
    expect(((await screen.findByPlaceholderText(/答える/)) as HTMLTextAreaElement).value).toBe(
      '前に書いた',
    );
  });

  it('回答が通ると、保存した下書きも消える', async () => {
    stub(() => json({ approvals: [free] }));
    renderPages();

    fireEvent.change(await screen.findByPlaceholderText(/答える/), { target: { value: '答え' } });
    await waitFor(() => expect(loadApprovalDrafts().texts).toEqual({ 'a-free': '答え' }));

    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    await waitFor(() => expect(loadApprovalDrafts()).toEqual({ texts: {}, questions: {} }));
    expect(sessionStorage.getItem('alteroid.approvalDrafts')).toBeNull();
  });

  it('一覧から消えた承認（回答済みになった）の下書きは捨てる', async () => {
    saveApprovalDrafts({ texts: { gone: '別経路で片付いた', 'a-free': '残す' }, questions: {} });
    stub(() => json({ approvals: [free] }));
    renderPages();
    await screen.findByPlaceholderText(/答える/);
    await waitFor(() => expect(loadApprovalDrafts().texts).toEqual({ 'a-free': '残す' }));
  });

  it('取得に失敗しても、保存した下書きは消さない', async () => {
    saveApprovalDrafts({
      texts: { 'a-free': '書きかけ' },
      questions: {
        'a-ask': {
          drafts: { deploy: { chosen: ['fly'], other: '', otherOn: false } },
          supplement: '',
        },
      },
    });
    stub(() => json({ error: 'internal' }, 500));
    renderPages();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(loadApprovalDrafts().texts).toEqual({ 'a-free': '書きかけ' });
    expect(Object.keys(loadApprovalDrafts().questions)).toEqual(['a-ask']);
  });

  it('sessionStorage が投げても画面は動く（state だけで持つ）', async () => {
    stub(() => json({ approvals: [free] }));
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, ...args: [string, string]) {
      if (this === sessionStorage) throw new DOMException('quota', 'QuotaExceededError');
      return original.apply(this, args);
    };
    try {
      renderPages();
      fireEvent.change(await screen.findByPlaceholderText(/答える/), { target: { value: '書く' } });
      expect(await screen.findByText('1 件に答えを書いた（送るとまとめて1回で届く）')).toBeTruthy();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
