// @vitest-environment jsdom
/**
 * `/approvals` の設問つき承認待ち（issue #2525）。
 *
 * 選択肢を押して「回答」で、`POST /approvals/{id}/answer` へ `selections`（と補足の `answer`）が
 * 1回で届く。設問を持たない承認待ちは、これまでの回答欄のまま。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PendingApproval } from '@alteroid/logic';
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
      { id: 'railway', label: 'Railway', recommended: true },
      { id: 'fly', label: 'Fly.io' },
    ],
  },
  { id: 'notify', prompt: '通知先', multiple: true, options: [{ id: 'slack', label: 'Slack' }] },
];

/** 1件ぶんの回答の本文を控える（本文は `Request` が持つので `clone()` で読む）。 */
function stub(approvals: PendingApproval[], failAnswer = false) {
  const answers: { path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname === '/approvals') return json({ approvals });
    if (/^\/approvals\/[^/]+\/answer$/.test(url.pathname) && input instanceof Request) {
      answers.push({ path: url.pathname, body: await input.clone().json() });
      return failAnswer
        ? json({ error: '設問 "x" が selections に2回出ている。' }, 400)
        : json({ ok: true });
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
  }) as typeof fetch;
  return answers;
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

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Approvals }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('/approvals の設問つき承認待ち', () => {
  it('開いて選び、「回答」で selections を1回で送る（補足は answer）', async () => {
    const answers = stub([approval({ questions })]);
    renderPage();

    expect(await screen.findByText('設問 2 件（うち複数選択 1）（選択肢つき）')).toBeTruthy();
    // 一覧の段階では選択肢を並べない。
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '選択肢を開いて答える' }));

    fireEvent.click(screen.getByRole('radio', { name: /Railway/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Slack' }));
    fireEvent.change(screen.getByLabelText('設問 2 のその他'), { target: { value: 'LINE' } });
    fireEvent.change(screen.getByRole('textbox', { name: /補足/ }), {
      target: { value: '金曜は避けたい' },
    });
    fireEvent.click(screen.getByRole('button', { name: '回答' }));

    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toEqual({
      path: '/approvals/a-1/answer',
      body: {
        answer: '金曜は避けたい',
        selections: [
          { questionId: 'deploy', optionIds: ['railway'] },
          { questionId: 'notify', optionIds: ['slack'], other: 'LINE' },
        ],
      },
    });
  });

  it('補足なしなら本文に answer の鍵を付けない', async () => {
    const answers = stub([approval({ questions })]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '選択肢を開いて答える' }));
    fireEvent.click(screen.getByRole('radio', { name: /Fly\.io/ }));
    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]!.body).toEqual({
      selections: [{ questionId: 'deploy', optionIds: ['fly'] }],
    });
  });

  it('サーバが断ったら理由を出し、送った入力は残る', async () => {
    stub([approval({ questions })], true);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '選択肢を開いて答える' }));
    fireEvent.click(screen.getByRole('radio', { name: /Fly\.io/ }));
    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    expect(await screen.findByText(/selections に2回出ている/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Fly\.io/ }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('questions を持たない承認待ちは、これまでの回答欄（許可・却下つき）のまま', async () => {
    const answers = stub([approval({ id: 'a-2' })]);
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText(/答える/), { target: { value: 'はい' } });
    expect(screen.queryByRole('button', { name: '選択肢を開いて答える' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]!.body).toEqual({ answer: 'はい' });
  });

  it('回答済みで selections があっても、畳んだ文（answer）がそのまま読める', async () => {
    stub([
      approval({
        questions,
        selections: [{ questionId: 'deploy', optionIds: ['railway'] }],
        answer: 'Q1 デプロイ先: (a) Railway［推奨］\nQ2 通知先: 未回答',
        answeredAt: '2026-08-19T11:00:00.000Z',
      }),
    ]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '回答済み・取り下げ済みも見る' }));
    expect(await screen.findByText(/Q1 デプロイ先: \(a\) Railway/)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});
