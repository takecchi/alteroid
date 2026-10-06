// @vitest-environment jsdom
/**
 * 承認カードを `@alteroid/ui` の `ApprovalCard`（Twin Plate）へ移したときに、
 * **今の画面の表示・操作を変えていない**ことを押さえる。
 *
 * `approvals.test.tsx` が見ていない差だけをここに置く（そちらは変えていない）:
 *
 * 1. 時刻は `formatDateTime` と `formatRelative` の2つの span（部品の `Timestamp` = `<time>` ではない）
 * 2. 送るキーは `(metaKey || ctrlKey) && key === 'Enter'` で、IME の確定の Enter は送信に
 *    数えない（部品の既定 `isSubmitShortcut`。issue #2259 で会話と約束の入力欄に揃えた）
 * 3. エラーは「個別の失敗」→「まとめ送信の失敗」の順に別々に出し、どちらも無ければ出さない。
 *    その後ろに会話のパネルが来る
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatDateTime, formatRelative } from '@alteroid/logic';
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

interface Stub {
  /** 1件だけ答える経路（`POST /approvals/:id/answer`）に届いた id。 */
  singles: string[];
}

function stub(
  approvals: PendingApproval[],
  options: { singleStatus?: number; bulkError?: string } = {},
): Stub {
  const singles: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    if (path === '/approvals') return json({ approvals });
    if (path === '/approvals/answer') {
      const body =
        input instanceof Request
          ? ((await input.clone().json()) as { answers: { id: string }[] })
          : { answers: [] };
      return json({
        results: body.answers.map((entry) => ({
          id: entry.id,
          ok: options.bulkError === undefined,
          ...(options.bulkError !== undefined ? { error: options.bulkError } : {}),
        })),
      });
    }
    const single = /^\/approvals\/([^/]+)\/answer$/.exec(path);
    if (single !== null) {
      singles.push(single[1]!);
      return options.singleStatus === undefined
        ? json({ ok: true })
        : json({ error: 'single-failed' }, options.singleStatus);
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
  return { singles };
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

/**
 * カードの一覧の各 `<li>`。**上のタブの帯も `list` / `listitem` なので、素の
 * `getAllByRole('listitem')[0]` はタブ（#3237 以降）を掴む**——そこで「alert が無い」を測ると、
 * カードを見ていないのに通る。かならずカードの一覧（`aria-label`）へ絞る。
 */
async function cardItems(): Promise<HTMLElement[]> {
  return within(await screen.findByRole('list', { name: '承認待ちの一覧' })).getAllByRole(
    'listitem',
  );
}

describe('時刻の表示（Timestamp を使わない）', () => {
  it('formatDateTime と formatRelative の2つの span を、この順で出す。<time> は出さない', async () => {
    const createdAt = '2026-08-19T10:00:00.000Z';
    stub([approval({ createdAt })]);
    renderPage();

    const absolute = await screen.findByText(formatDateTime(createdAt));
    expect(absolute.tagName).toBe('SPAN');
    const relative = screen.getByText(`(${formatRelative(createdAt)})`);
    expect(relative.tagName).toBe('SPAN');
    expect(absolute.nextElementSibling).toBe(relative);
    expect(document.querySelector('time')).toBeNull();
  });
});

describe('送るキー', () => {
  async function press(init: KeyboardEventInit) {
    const { singles } = stub([approval({ id: 'a-1' })]);
    renderPage();
    const textarea = await screen.findByPlaceholderText(/答える/);
    fireEvent.change(textarea, { target: { value: '許可する' } });
    fireEvent.keyDown(textarea, init);
    return singles;
  }

  it('Ctrl + Enter と Cmd + Enter で送る', async () => {
    const viaCtrl = await press({ key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(viaCtrl).toEqual(['a-1']));
    cleanup();
    const viaMeta = await press({ key: 'Enter', metaKey: true });
    await waitFor(() => expect(viaMeta).toEqual(['a-1']));
  });

  it('修飾キーの無い Enter では送らない（改行のまま）', async () => {
    const singles = await press({ key: 'Enter' });
    // 送るなら fetch はこの同期の直後に積まれる。積まれていないことを、
    // 同じ経路で「送れる」ことが上で示されている前提で読む。
    await Promise.resolve();
    expect(singles).toEqual([]);
  });

  // **IME の確定の Enter は送信に数えない（issue #2259）。** 会話（`chat.tsx`）・約束
  // （`commitments.tsx`）の入力欄と、部品 `ApprovalCard` の既定（`isSubmitShortcut`）に揃えた。
  // 変換を確定するつもりの ⌘/Ctrl + Enter で、書きかけの回答が送られてしまわないようにする。
  // 以前はここで「IME の変換中の Ctrl + Enter も送る」を今の振る舞いとして固定していた。
  it('IME の変換中の Ctrl + Enter / Cmd + Enter では送らない（isComposing）', async () => {
    const viaCtrl = await press({ key: 'Enter', ctrlKey: true, isComposing: true });
    await Promise.resolve();
    expect(viaCtrl).toEqual([]);
    cleanup();
    const viaMeta = await press({ key: 'Enter', metaKey: true, isComposing: true });
    await Promise.resolve();
    expect(viaMeta).toEqual([]);
  });

  it('isComposing を立てない実装（keyCode 229）でも、IME の確定の Ctrl + Enter では送らない', async () => {
    const singles = await press({ key: 'Enter', ctrlKey: true, keyCode: 229 });
    await Promise.resolve();
    expect(singles).toEqual([]);
  });

  it('変換を確定した後の Ctrl + Enter では送る（IME を除く判定が送信そのものを止めていない）', async () => {
    const singles = await press({ key: 'Enter', ctrlKey: true, isComposing: false });
    await waitFor(() => expect(singles).toEqual(['a-1']));
  });
});

describe('エラーの位置と数', () => {
  it('どちらの失敗も無ければ、エラーの箱を出さない', async () => {
    stub([approval({ id: 'a-1' })]);
    renderPage();
    const item = (await cardItems())[0]!;
    expect(within(item).queryAllByRole('alert')).toHaveLength(0);
  });

  it('個別の失敗とまとめ送信の失敗を、この順で別々の ErrorNote に出し、会話のパネルがその後ろに来る', async () => {
    stub([approval({ id: 'a-1' })], { singleStatus: 409, bulkError: 'already answered' });
    renderPage();

    const textarea = await screen.findByPlaceholderText(/答える/);
    fireEvent.change(textarea, { target: { value: '許可する' } });
    fireEvent.click(screen.getByRole('button', { name: 'まとめて送る' }));
    await screen.findByText('まとめて送った回答は通らなかった: already answered');

    // まとめ送信の失敗だけが出ている間は1つ。
    const item = (await cardItems())[0]!;
    expect(within(item).getAllByRole('alert')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    await waitFor(() => expect(within(item).getAllByRole('alert')).toHaveLength(2));

    const [first, second] = within(item).getAllByRole('alert');
    expect(first!.textContent).not.toContain('まとめて送った回答は通らなかった');
    expect(second!.textContent).toBe('まとめて送った回答は通らなかった: already answered');
    const conversation = screen.getByText(/この確認は会話に紐づいていない/);
    expect(
      second!.compareDocumentPosition(conversation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('回答経路', () => {
  it('answeredVia が無い回答済みの行には「回答経路」を出さない', async () => {
    stub([approval({ id: 'a-1', answeredAt: '2026-08-19T11:00:00.000Z', answer: '許可する' })]);
    renderPage();
    await screen.findByText('許可する');
    expect(screen.queryByText(/回答経路/)).toBeNull();
  });
});
