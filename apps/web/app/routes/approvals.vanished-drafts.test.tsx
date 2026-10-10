// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadApprovalDrafts,
  loadApprovalLeftoverSources,
  saveApprovalDrafts,
  type PendingApproval,
} from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Approvals from './approvals';

/**
 * 一覧から消えた承認の書きかけを黙って失わない。409 で断られた回答、送って
 * いない書きかけが裏の取り下げで一覧から外れたもの、再読み込み後の一覧に無い id の下書き。
 */

function approval(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'a-1',
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
    question: '本番に出してよいか',
    ...over,
  };
}

const LEFT = '送らなかった下書きが残っている承認';
const FLOAT = /答える/;

let list: PendingApproval[] = [];
let answerStatus = 200;
function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (/^\/approvals\/[^/]+\/answer$/.test(url.pathname)) {
      if (answerStatus === 409) {
        // 取り直した一覧からは消えている（先に決着していた）。
        list = [];
        return json({ error: 'already answered' }, 409);
      }
      list = [];
      return json({ ok: true });
    }
    if (url.pathname === '/approvals') return json({ approvals: list });
    return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
  }) as typeof fetch;
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/approvals', Component: Approvals }], {
    initialEntries: ['/approvals'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

async function refetch() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  answerStatus = 200;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('承認の画面: 一覧から消えた承認の書きかけ', () => {
  it('409 で断られた回答は、一覧から消えても409だと分かる形で残り、閉じれば画面と保存先から消える', async () => {
    list = [approval({ id: 'a-1', question: '自由記述の件' })];
    answerStatus = 409;
    stubFetch();
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText(FLOAT), {
      target: { value: '大事な長い答え' },
    });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));

    const note = await screen.findByRole('list', { name: LEFT });
    expect(note.textContent).toContain('大事な長い答え');
    expect(note.textContent).toContain('409');
    expect(note.textContent).toContain('自由記述の件');
    expect(loadApprovalDrafts().texts).toEqual({ 'a-1': '大事な長い答え' });

    fireEvent.click(screen.getByRole('button', { name: '閉じる（捨てる）' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: LEFT })).toBeNull());
    expect(document.body.textContent).not.toContain('大事な長い答え');
    expect(loadApprovalDrafts()).toEqual({ texts: {}, questions: {} });
    expect(loadApprovalLeftoverSources()).toEqual({});
  });

  it('送っていない書きかけは、承認が取り下げられて一覧から外れても残る', async () => {
    list = [approval({ id: 'a-gone', question: '消える件' })];
    stubFetch();
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText(FLOAT), {
      target: { value: '長く書いた答え' },
    });
    await waitFor(() => expect(loadApprovalDrafts().texts).toEqual({ 'a-gone': '長く書いた答え' }));

    list = [];
    await refetch();
    await waitFor(() => expect(screen.queryByPlaceholderText(FLOAT)).toBeNull());

    const note = await screen.findByRole('list', { name: LEFT });
    expect(note.textContent).toContain('長く書いた答え');
    expect(note.textContent).toContain('消える件');
    expect(note.textContent).toContain('先に決着した');
    expect(note.textContent).not.toContain('答えは通った');
    await waitFor(() => expect(loadApprovalDrafts().texts).toEqual({ 'a-gone': '長く書いた答え' }));
    expect(loadApprovalLeftoverSources()['a-gone']?.question).toBe('消える件');
  });

  it('再読み込みのあとも残り、question の写しがあれば出す', async () => {
    list = [approval({ id: 'a-gone', question: '消える件' })];
    stubFetch();
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText(FLOAT), {
      target: { value: '長く書いた答え' },
    });
    list = [];
    await refetch();
    await screen.findByRole('list', { name: LEFT });
    cleanup();

    list = [approval({ id: 'a-other' })];
    renderPage();
    await screen.findByPlaceholderText(FLOAT);
    const note = await screen.findByRole('list', { name: LEFT });
    expect(note.textContent).toContain('長く書いた答え');
    expect(note.textContent).toContain('消える件');
  });

  it('再読み込み後、一覧に無い id の保存済みの下書きは、本文の写しが無いと分かる形で残る', async () => {
    saveApprovalDrafts({ texts: { 'a-old': '前に書いた答え' }, questions: {} });
    list = [approval({ id: 'a-other' })];
    stubFetch();
    renderPage();
    await screen.findByPlaceholderText(FLOAT);

    const note = await screen.findByRole('list', { name: LEFT });
    expect(note.textContent).toContain('前に書いた答え');
    expect(note.textContent).toContain('本文の写しが無い');
    expect(loadApprovalDrafts().texts).toEqual({ 'a-old': '前に書いた答え' });

    fireEvent.click(screen.getByRole('button', { name: '閉じる（捨てる）' }));
    await waitFor(() => expect(loadApprovalDrafts()).toEqual({ texts: {}, questions: {} }));
  });

  it('古い一覧が先に返っても、チャットで書いた新しい承認の下書きは保存先から落ちず、一覧に載ればカードに出る', async () => {
    saveApprovalDrafts({ texts: { 'a-new': 'チャットで書いた答え' }, questions: {} });
    list = [];
    stubFetch();
    renderPage();
    await screen.findByText('答えを待っているものはない。クローンは進んでいる。');
    expect(loadApprovalDrafts().texts).toEqual({ 'a-new': 'チャットで書いた答え' });

    list = [approval({ id: 'a-new', question: '新しい件' })];
    await refetch();
    const box = await screen.findByPlaceholderText(FLOAT);
    expect((box as HTMLTextAreaElement).value).toBe('チャットで書いた答え');
    expect(screen.queryByRole('list', { name: LEFT })).toBeNull();
  });

  it('取り直しの最中は、一覧に無いだけのものを「先に決着した」と言わず、取り直しで載ればカードに戻る', async () => {
    // 古い一覧（B なし）が読めている状態。取り直しが済んだあとなので、写しの無い下書きは出る。
    saveApprovalDrafts({ texts: { 'a-new': 'チャットで書いた答え' }, questions: {} });
    list = [];
    stubFetch();
    renderPage();
    await screen.findByRole('list', { name: LEFT });

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname !== '/approvals') return Promise.reject(new TypeError('x'));
      fetches += 1;
      await held;
      return json({ approvals: [approval({ id: 'a-new', question: '新しい件' })] });
    }) as typeof fetch;
    await refetch();
    await waitFor(() => expect(fetches).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole('list', { name: LEFT })).toBeNull());
    expect(document.body.textContent).not.toContain('先に決着した');
    expect(loadApprovalDrafts().texts).toEqual({ 'a-new': 'チャットで書いた答え' });

    release();
    const box = await screen.findByPlaceholderText(FLOAT);
    expect((box as HTMLTextAreaElement).value).toBe('チャットで書いた答え');
    expect(screen.queryByRole('list', { name: LEFT })).toBeNull();
  });
});
