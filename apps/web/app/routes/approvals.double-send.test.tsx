// @vitest-environment jsdom
/**
 * カードごとの送信と「まとめて送る」は、互いの送信中を見る（issue #3626）。
 * 同じ承認を二重に送らない。送った回数は、fetch の呼び出しを数えて確かめる。
 *
 * あわせて、答えが通った直後に保存先の下書きが一瞬落ちない（issue #3666）ことを、
 * `saveApprovalDrafts` の呼び出しを見て確かめる。
 * 応答の時期は、回答の Promise を手で解決して操る（実時間の待ちは書かない）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingApproval } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Approvals from './approvals';

const saved = vi.hoisted(() => ({ calls: [] as { texts: Record<string, string> }[] }));
vi.mock('@alteroid/logic', async (importOriginal) => {
  const original = await importOriginal<typeof import('@alteroid/logic')>();
  return {
    ...original,
    saveApprovalDrafts: (drafts: Parameters<typeof original.saveApprovalDrafts>[0]) => {
      saved.calls.push({ texts: { ...drafts.texts } });
      return original.saveApprovalDrafts(drafts);
    },
  };
});

function approval(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'a-1',
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
    question: '本番に出してよいか',
    ...over,
  };
}

const one = approval({ id: 'a-one', question: '一件目' });
const two = approval({ id: 'a-two', question: '二件目' });

interface Stub {
  /** 個別の回答（`POST /approvals/:id/answer`）に届いた id。 */
  single: string[];
  /** まとめ送信（`POST /approvals/answer`）に届いた id の組。 */
  bulk: string[][];
  releaseSingle: () => void;
  releaseBulk: () => void;
}

/** 個別とまとめ送信は、別々の Promise を解決するまで返さない。返ったあとの一覧は `afterAnswer`。 */
function stub(listBefore: PendingApproval[], afterAnswer: PendingApproval[]): Stub {
  let answered = false;
  const result: Stub = { single: [], bulk: [], releaseSingle: () => {}, releaseBulk: () => {} };
  const heldSingle = new Promise<void>((resolve) => (result.releaseSingle = resolve));
  const heldBulk = new Promise<void>((resolve) => (result.releaseBulk = resolve));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = input instanceof Request ? input.method : 'GET';
    if (url.pathname === '/approvals' && method === 'GET') {
      return json({ approvals: answered ? afterAnswer : listBefore });
    }
    const single = /^\/approvals\/([^/]+)\/answer$/.exec(url.pathname);
    if (single) {
      result.single.push(decodeURIComponent(single[1]!));
      await heldSingle;
      answered = true;
      return json({ ok: true });
    }
    if (url.pathname === '/approvals/answer') {
      const body =
        input instanceof Request
          ? ((await input.clone().json()) as { answers: { id: string }[] })
          : { answers: [] };
      result.bulk.push(body.answers.map((a) => a.id));
      await heldBulk;
      answered = true;
      return json({ results: body.answers.map((a) => ({ id: a.id, ok: true })) });
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
  }) as typeof fetch;
  return result;
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

/** 2件に下書きを書き、ボックスを返す。 */
async function typeTwo(): Promise<HTMLTextAreaElement[]> {
  const boxes = (await screen.findAllByPlaceholderText(/答える/)) as HTMLTextAreaElement[];
  fireEvent.change(boxes[0]!, { target: { value: '一件目の答え' } });
  fireEvent.change(boxes[1]!, { target: { value: '二件目の答え' } });
  return boxes;
}

const ctrlEnter = { key: 'Enter', code: 'Enter', ctrlKey: true };

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  saved.calls.length = 0;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('カードの送信とまとめ送信の二重送信（issue #3626）', () => {
  it('まとめ送信の最中は、カードの「回答する」・許可・⌘/Ctrl+Enter を押しても送られない', async () => {
    const s = stub([one, two], []);
    renderPage();
    const boxes = await typeTwo();
    fireEvent.click(await screen.findByRole('button', { name: 'まとめて送る' }));
    await waitFor(() => expect(s.bulk).toEqual([['a-one', 'a-two']]));

    for (const button of screen.getAllByRole('button', { name: '回答する' }))
      fireEvent.click(button);
    for (const button of screen.getAllByRole('button', { name: '許可' })) fireEvent.click(button);
    fireEvent.keyDown(boxes[0]!, ctrlEnter);
    fireEvent.keyDown(boxes[1]!, ctrlEnter);

    s.releaseBulk();
    await waitFor(() => expect(screen.queryAllByPlaceholderText(/答える/)).toHaveLength(0));
    expect(s.single).toEqual([]);
    expect(s.bulk).toEqual([['a-one', 'a-two']]);
  });

  it('まとめ送信の最中に「まとめて送る」をもう一度押しても、送られない', async () => {
    const s = stub([one, two], []);
    renderPage();
    await typeTwo();
    const button = await screen.findByRole('button', { name: 'まとめて送る' });
    fireEvent.click(button);
    fireEvent.click(button);

    s.releaseBulk();
    await waitFor(() => expect(screen.queryAllByPlaceholderText(/答える/)).toHaveLength(0));
    expect(s.bulk).toEqual([['a-one', 'a-two']]);
  });

  it('カードの送信中に「まとめて送る」を押しても、その id は送られない', async () => {
    const s = stub([one, two], []);
    renderPage();
    await typeTwo();
    fireEvent.click(screen.getAllByRole('button', { name: '回答する' })[0]!);
    await waitFor(() => expect(s.single).toEqual(['a-one']));

    fireEvent.click(await screen.findByRole('button', { name: 'まとめて送る' }));
    await waitFor(() => expect(s.bulk).toEqual([['a-two']]));

    s.releaseSingle();
    s.releaseBulk();
    await waitFor(() => expect(screen.queryAllByPlaceholderText(/答える/)).toHaveLength(0));
    expect(s.single).toEqual(['a-one']);
    expect(s.bulk).toEqual([['a-two']]);
  });

  it('カードの送信中は、まとめ送信の対象が無ければ何も送らない', async () => {
    const s = stub([one], []);
    renderPage();
    const box = (await screen.findByPlaceholderText(/答える/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '答え' } });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    await waitFor(() => expect(s.single).toEqual(['a-one']));

    fireEvent.click(screen.getByRole('button', { name: 'まとめて送る' }));

    s.releaseSingle();
    await waitFor(() => expect(screen.queryAllByPlaceholderText(/答える/)).toHaveLength(0));
    expect(s.bulk).toEqual([]);
  });

  it('カードの送信中にもう一度押しても（ボタン・許可・⌘/Ctrl+Enter）、二重に送られない', async () => {
    const s = stub([one], []);
    renderPage();
    const box = (await screen.findByPlaceholderText(/答える/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '答え' } });
    const button = screen.getByRole('button', { name: '回答する' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: '許可' }));
    fireEvent.keyDown(box, ctrlEnter);

    s.releaseSingle();
    await waitFor(() => expect(screen.queryAllByPlaceholderText(/答える/)).toHaveLength(0));
    expect(s.single).toEqual(['a-one']);
  });
});

describe('答えが通った直後に、保存先の下書きが一瞬落ちない（issue #3666）', () => {
  it('個別送信: 一覧から消える描画のあいだも、保存先へ「その承認の下書きの無い」状態を書かない', async () => {
    const s = stub([one], []);
    renderPage();
    const box = (await screen.findByPlaceholderText(/答える/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '答え' } });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    fireEvent.change(box, { target: { value: '答え。追記です' } });
    await waitFor(() => expect(s.single).toEqual(['a-one']));
    // ここから先の保存だけを見る。
    saved.calls.length = 0;

    s.releaseSingle();
    await screen.findByRole('list', { name: '送らなかった下書きが残っている承認' });
    await waitFor(() => expect(screen.queryByPlaceholderText(/答える/)).toBeNull());

    expect(saved.calls.length).toBeGreaterThan(0);
    for (const call of saved.calls) {
      expect(call.texts).toEqual({ 'a-one': '答え。追記です' });
    }
  });

  it('まとめ送信: 一覧から消える描画のあいだも、保存先へ「その承認の下書きの無い」状態を書かない', async () => {
    const s = stub([one, two], []);
    renderPage();
    const boxes = await typeTwo();
    fireEvent.click(await screen.findByRole('button', { name: 'まとめて送る' }));
    await waitFor(() => expect(s.bulk).toEqual([['a-one', 'a-two']]));
    // 応答を待つ間に、一件目へ打ち足す。
    fireEvent.change(boxes[0]!, { target: { value: '一件目の答え。追記' } });
    saved.calls.length = 0;

    s.releaseBulk();
    await screen.findByRole('list', { name: '送らなかった下書きが残っている承認' });
    await waitFor(() => expect(screen.queryAllByPlaceholderText(/答える/)).toHaveLength(0));

    expect(saved.calls.length).toBeGreaterThan(0);
    for (const call of saved.calls) {
      expect(call.texts).toHaveProperty('a-one', '一件目の答え。追記');
    }
  });
});
