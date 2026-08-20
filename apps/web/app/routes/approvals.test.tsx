// @vitest-environment jsdom
/**
 * 承認待ちの一括処理（`/approvals` 画面）。
 *
 * デーモンには「1件が駄目でも残りは進む」`POST /approvals/answer` が既にあった
 * のに、画面は `POST /approvals/{id}/answer` を1件ずつ呼ぶだけだった
 * （`docs/roadmap.md` M3・`docs/PRD.md`「入口の等価性」に対するバグ）。
 *
 * ここで固定するのは:
 *
 * 1. 各カードの下書きは独立している（1件ずつ内容を見て別々に書ける自由を失わない）
 * 2. 「まとめて送る」は、書かれた分だけを1回の `POST /approvals/answer` にまとめる
 * 3. 何件が対象かが送る前に見える
 * 4. 1件が駄目でも残りは進み、失敗した id にだけエラーが出る（成功件数へ畳まない）
 * 5. 個別の「回答する」ボタンは、まとめ送りとは無関係にその場で即送信できる
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PendingApproval } from '~/lib/types';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Approvals from './approvals';

function approval(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'a-1',
    createdAt: '2026-08-19T10:00:00.000Z',
    question: '本番に出してよいか',
    ...over,
  };
}

type BulkResult = { id: string; ok: boolean; error?: string };

interface ApprovalsStub {
  /** 実際に叩かれた URL（順番どおり）。 */
  calls: string[];
  /** `POST /approvals/answer` に送った `answers`（呼びごとに1件）。 */
  bulkRequests: { id: string; answer: string }[][];
}

/**
 * `/approvals` 一覧と両方の答える経路（1件だけ・まとめて）を控える。
 *
 * **`test-support` の `stubFetch` は使えない。** あちらの `Route` は
 * `(url, init)` しか受け取らないが、openapi-fetch は `fetch(request, ...)` を
 * `Request` インスタンスで呼ぶので、本文は `init.body` にはもう乗っていない
 * （`Request` 自身が本文を持つ）。ここでは `commitments.test.tsx` の
 * `recordRequests()` と同じ形（`input instanceof Request` を見て `clone()` で
 * 読む）で自前に `fetch` を差し替える。
 *
 * **`/approvals/answer` と `/approvals/{id}/answer` はどちらも `/answer` で
 * 終わる。** 先に完全一致（まとめて）を見て、そうでなければ `id` を挟んだ形
 * （1件だけ）とみなす — 順番を変えると両方が同じ枝に落ちる。
 */
function stubApprovals(
  approvals: PendingApproval[],
  options: { bulkResults?: (answers: { id: string; answer: string }[]) => BulkResult[] } = {},
): ApprovalsStub {
  const calls: string[] = [];
  const bulkRequests: { id: string; answer: string }[][] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const path = new URL(url).pathname;

    if (path === '/approvals') return json({ approvals });

    if (path === '/approvals/answer') {
      const body =
        input instanceof Request
          ? ((await input.clone().json()) as { answers: { id: string; answer: string }[] })
          : { answers: [] };
      bulkRequests.push(body.answers);
      const resolve =
        options.bulkResults ?? ((answers) => answers.map((entry) => ({ id: entry.id, ok: true })));
      return json({ results: resolve(body.answers) });
    }

    if (/^\/approvals\/[^/]+\/answer$/.test(path)) return json({ ok: true });

    // 知らない URL は「繋がらない」（`test-support` の `stubFetch` と同じ方針）。
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;

  return { calls, bulkRequests };
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
  render(
    <Providers>
      <Approvals />
    </Providers>,
  );
}

describe('/approvals 画面のまとめ送信', () => {
  it('各カードの下書きは独立している（1件ずつ別々に書ける自由を失わない）', async () => {
    stubApprovals([
      approval({ id: 'a-1', question: '質問1' }),
      approval({ id: 'a-2', question: '質問2' }),
    ]);
    renderPage();

    const textareas = await screen.findAllByPlaceholderText(/答える/);
    expect(textareas).toHaveLength(2);

    fireEvent.change(textareas[0]!, { target: { value: '許可する' } });

    expect((textareas[0] as HTMLTextAreaElement).value).toBe('許可する');
    expect((textareas[1] as HTMLTextAreaElement).value).toBe('');
  });

  it('書いた分だけが対象になり、件数が送る前に見える', async () => {
    stubApprovals([approval({ id: 'a-1' }), approval({ id: 'a-2' }), approval({ id: 'a-3' })]);
    renderPage();

    const textareas = await screen.findAllByPlaceholderText(/答える/);
    expect(await screen.findByText(/まとめて送る答えはまだ書かれていない/)).toBeTruthy();

    fireEvent.change(textareas[0]!, { target: { value: '許可する' } });
    expect(await screen.findByText('1 件に答えを書いた（送るとまとめて1回で届く）')).toBeTruthy();

    fireEvent.change(textareas[1]!, { target: { value: '却下する' } });
    expect(await screen.findByText('2 件に答えを書いた（送るとまとめて1回で届く）')).toBeTruthy();
  });

  it('「まとめて送る」は、書かれた分だけを1回の POST /approvals/answer にまとめる', async () => {
    const { bulkRequests } = stubApprovals([
      approval({ id: 'a-1' }),
      approval({ id: 'a-2' }),
      approval({ id: 'a-3' }),
    ]);
    renderPage();

    const textareas = await screen.findAllByPlaceholderText(/答える/);
    fireEvent.change(textareas[0]!, { target: { value: '許可する' } });
    fireEvent.change(textareas[2]!, { target: { value: '却下する' } });

    fireEvent.click(screen.getByRole('button', { name: 'まとめて送る' }));

    await waitFor(() => expect(bulkRequests).toHaveLength(1));
    // 2件目（何も書いていない）は対象に混ざらない。
    expect(bulkRequests[0]).toEqual([
      { id: 'a-1', answer: '許可する' },
      { id: 'a-3', answer: '却下する' },
    ]);
  });

  /**
   * **成功件数だけを言わない。** 1件が駄目でも残りは進む設計なので、
   * どの id が通らなかったかが画面から見えなければ、まとめて処理した瞬間に
   * 取りこぼしが静かに起きる。
   */
  it('1件が失敗しても残りは進み、失敗した id にだけエラーが出る', async () => {
    const { bulkRequests } = stubApprovals(
      [approval({ id: 'a-1', question: '質問1' }), approval({ id: 'a-2', question: '質問2' })],
      {
        bulkResults: (answers) =>
          answers.map((entry) =>
            entry.id === 'a-2'
              ? { id: entry.id, ok: false, error: 'already answered' }
              : { id: entry.id, ok: true },
          ),
      },
    );
    renderPage();

    const textareas = await screen.findAllByPlaceholderText(/答える/);
    fireEvent.change(textareas[0]!, { target: { value: '許可する' } });
    fireEvent.change(textareas[1]!, { target: { value: '却下する' } });

    fireEvent.click(screen.getByRole('button', { name: 'まとめて送る' }));
    await waitFor(() => expect(bulkRequests).toHaveLength(1));

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);

    // 通った側（質問1）: エラーは出ず、下書きは消える。
    await waitFor(() => expect(within(items[0]!).queryByText(/already answered/)).toBeNull());
    await waitFor(() =>
      expect((within(items[0]!).getByPlaceholderText(/答える/) as HTMLTextAreaElement).value).toBe(
        '',
      ),
    );

    // 通らなかった側（質問2）: エラーが出て、書いた答えは消えずに残る（書き直せる）。
    expect(within(items[1]!).getByText(/already answered/)).toBeTruthy();
    expect((within(items[1]!).getByPlaceholderText(/答える/) as HTMLTextAreaElement).value).toBe(
      '却下する',
    );
  });

  it('個別の「回答する」ボタンは、まとめ送りとは無関係にその場で即送信できる', async () => {
    const { calls, bulkRequests } = stubApprovals([
      approval({ id: 'a-1', question: '質問1' }),
      approval({ id: 'a-2', question: '質問2' }),
    ]);
    renderPage();

    const textareas = await screen.findAllByPlaceholderText(/答える/);
    fireEvent.change(textareas[0]!, { target: { value: '許可する' } });

    const submitButtons = screen.getAllByRole('button', { name: '回答する' });
    fireEvent.click(submitButtons[0]!);

    await waitFor(() =>
      expect(calls.some((url) => url.includes('/approvals/a-1/answer'))).toBe(true),
    );
    // まとめて送る経路は一度も呼ばれていない。
    expect(bulkRequests).toHaveLength(0);
  });

  it('未回答が無ければ「まとめて送る」の帯を出さない', async () => {
    stubApprovals([]);
    renderPage();

    await screen.findByText('答えを待っているものはない。クローンは進んでいる。');
    expect(screen.queryByRole('button', { name: 'まとめて送る' })).toBeNull();
  });
});
