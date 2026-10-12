// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PendingApproval } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Approvals from './approvals';
import ApprovalsAnswered from './approvals-answered';

const one: PendingApproval = {
  id: 'a-one',
  createdAt: '2026-08-19T10:00:00.000Z',
  updatedAt: '2026-08-19T10:00:00.000Z',
  question: '本番に出してよいか',
};

const AnsweredPage = ApprovalsAnswered as unknown as (props: {
  loaderData: { date: string | undefined; approvalId: string | undefined };
}) => React.ReactElement;

function Answered() {
  const { date, approvalId } = useParams();
  return <AnsweredPage loaderData={{ date, approvalId }} />;
}

/** 個別の回答の POST を保留する。`release()` で通す。 */
function stub() {
  let answered = false;
  const result = { single: [] as string[], release: () => {}, settled: false };
  const held = new Promise<void>((resolve) => (result.release = resolve));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    // openapi-fetch は Request を渡すので、method は input の側を見る
    const method = input instanceof Request ? input.method : 'GET';
    if (url.pathname === '/approvals' && method === 'GET') {
      return json({ approvals: answered ? [] : [one] });
    }
    const single = /^\/approvals\/([^/]+)\/answer$/.exec(url.pathname);
    if (single) {
      result.single.push(decodeURIComponent(single[1]!));
      await held;
      answered = true;
      result.settled = true;
      return json({ ok: true });
    }
    return json({ approvals: [], dates: [] });
  }) as typeof fetch;
  return result;
}

function renderApp() {
  // routes.ts と同じ path
  const router = createMemoryRouter(
    [
      { path: '/approvals', Component: Approvals },
      { path: '/approvals/answered/:date?/:approvalId?', Component: Answered },
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

async function sendAndLeave(s: ReturnType<typeof stub>, router: ReturnType<typeof renderApp>) {
  const box = (await screen.findByPlaceholderText(/答える/)) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: '答え' } });
  fireEvent.click(screen.getByRole('button', { name: '回答する' }));
  await waitFor(() => expect(s.single).toEqual(['a-one']));
  await act(async () => {
    await router.navigate('/approvals/answered');
  });
  await waitFor(() => expect(screen.queryByPlaceholderText(/答える/)).toBeNull());
}

let originalFetch: typeof fetch;
let pending: ReturnType<typeof stub> | undefined;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  pending = undefined;
});
afterEach(async () => {
  // 保留した POST を通して、送信中の印（モジュールの寿命で持つ）を次の試験へ持ち越さない
  if (pending !== undefined && !pending.settled) {
    pending.release();
    await waitFor(() => expect(pending?.settled).toBe(true));
  }
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('承認の回答を送っている途中に別ページへ移って戻る（#4549）', () => {
  it('戻ったカードは送信中のまま押せず、もう一度押しても POST は1回だけ', async () => {
    const s = (pending = stub());
    const router = renderApp();
    await sendAndLeave(s, router);

    await act(async () => {
      await router.navigate('/approvals');
    });
    const again = (await screen.findByPlaceholderText(/答える/)) as HTMLTextAreaElement;
    expect(again.value).toBe('答え');
    const button = screen.getByRole('button', { name: '回答する' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await act(async () => {});

    expect(s.single).toEqual(['a-one']);
  });

  it('離れている間に応答が返ったら、戻っても通った答えを「送らなかった下書き」に出さない', async () => {
    const s = (pending = stub());
    const router = renderApp();
    await sendAndLeave(s, router);

    s.release();
    await waitFor(() => expect(s.settled).toBe(true));
    // 保存側の下書きが畳まれるのを待つ（画面はアンマウント済みなので、畳むのはカードの側）
    await waitFor(() =>
      expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain('答え'),
    );
    await act(async () => {
      await router.navigate('/approvals');
    });
    await waitFor(() => expect(screen.queryByPlaceholderText(/答える/)).toBeNull());
    expect(screen.queryByRole('list', { name: '送らなかった下書きが残っている承認' })).toBeNull();
  });
});
