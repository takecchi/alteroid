// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

type BulkResult = { id: string; ok: boolean; error?: string };

interface ApprovalsStub {
  calls: string[];
  /** `POST /approvals/answer` に送った `answers`（呼びごとに1件）。 */
  bulkRequests: { id: string; answer: string }[][];
}

// `test-support` の `stubFetch` は使えない: openapi-fetch は `fetch(request)` を `Request` で呼ぶので、本文が `init.body` に乗らない。
// `/approvals/answer` と `/approvals/{id}/answer` はどちらも `/answer` で終わるので、先に完全一致（まとめて）を見る。
function stubApprovals(
  approvals: PendingApproval[],
  options: {
    bulkResults?: (answers: { id: string; answer: string }[]) => BulkResult[];
    conversation?: (id: string) => Response | Promise<Response>;
    trace?: (id: string) => Response | Promise<Response>;
    unreadable?: { id?: string; reason: string }[];
  } = {},
): ApprovalsStub {
  const calls: string[] = [];
  const bulkRequests: { id: string; answer: string }[][] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const path = new URL(url).pathname;

    if (path === '/approvals') {
      return json({
        approvals,
        ...(options.unreadable === undefined ? {} : { unreadable: options.unreadable }),
      });
    }

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

    const traced = /^\/approvals\/([^/]+)\/trace$/.exec(path);
    if (traced !== null && options.trace !== undefined) {
      return options.trace(decodeURIComponent(traced[1]!));
    }

    if (path.startsWith('/conversations/') && options.conversation !== undefined) {
      return options.conversation(decodeURIComponent(path.slice('/conversations/'.length)));
    }

    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;

  return { calls, bulkRequests };
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
    expect(bulkRequests[0]).toEqual([
      { id: 'a-1', answer: '許可する' },
      { id: 'a-3', answer: '却下する' },
    ]);
  });

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

    const items = within(await screen.findByRole('list', { name: '承認待ちの一覧' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(2);

    await waitFor(() => expect(within(items[0]!).queryByText(/already answered/)).toBeNull());
    await waitFor(() =>
      expect((within(items[0]!).getByPlaceholderText(/答える/) as HTMLTextAreaElement).value).toBe(
        '',
      ),
    );

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
    expect(bulkRequests).toHaveLength(0);
  });

  it('未回答が無ければ「まとめて送る」の帯を出さない', async () => {
    stubApprovals([]);
    renderPage();

    await screen.findByText('答えを待っているものはない。クローンは進んでいる。');
    expect(screen.queryByRole('button', { name: 'まとめて送る' })).toBeNull();
  });
});

describe('個別の回答が 409 で断られたとき（issue #1619）', () => {
  // `GET /approvals` は、答える POST が届いたかどうかで initial / resolved を切り替える。resolved が画面に届けば取り直した証拠になる。
  function stubStaleAnswer(
    initial: PendingApproval,
    resolved: PendingApproval,
    answerError: { error: string },
  ): { calls: string[] } {
    const calls: string[] = [];
    let settled = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const path = new URL(url).pathname;
      if (path === '/approvals') return json({ approvals: [settled ? resolved : initial] });
      if (/^\/approvals\/[^/]+\/answer$/.test(path)) {
        settled = true;
        return json(answerError, 409);
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;
    return { calls };
  }

  it('withdrawn（クローンが取り下げ済み）: 取り直して答える口を引っ込め、失敗は出したまま', async () => {
    const base = approval({ id: 'a-1', question: '本番に出してよいか' });
    const { calls } = stubStaleAnswer(
      base,
      { ...base, withdrawnAt: '2026-08-19T10:01:00.000Z', withdrawnReason: 'もう要らない' },
      { error: 'withdrawn' },
    );
    renderPage();

    const textarea = await screen.findByPlaceholderText(/答える/);
    fireEvent.change(textarea, { target: { value: '許可する' } });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));

    await screen.findByText(/withdrawn/);
    await waitFor(() => expect(screen.queryByRole('button', { name: '回答する' })).toBeNull());
    await screen.findByText('取り下げ済');
    await screen.findByText('もう要らない');

    expect(
      calls.filter((url) => new URL(url).pathname === '/approvals').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('already answered（別経路で先に回答済み）: 取り直して答える口を引っ込め、失敗は出したまま', async () => {
    const base = approval({ id: 'a-1', question: '本番に出してよいか' });
    const { calls } = stubStaleAnswer(
      base,
      { ...base, answeredAt: '2026-08-19T10:01:00.000Z', answer: '（別経路からの回答）' },
      { error: 'already answered' },
    );
    renderPage();

    const textarea = await screen.findByPlaceholderText(/答える/);
    fireEvent.change(textarea, { target: { value: '許可する' } });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));

    await screen.findByText(/already answered/);
    await waitFor(() => expect(screen.queryByRole('button', { name: '回答する' })).toBeNull());
    await screen.findByText('回答済');
    await screen.findByText('（別経路からの回答）');

    expect(
      calls.filter((url) => new URL(url).pathname === '/approvals').length,
    ).toBeGreaterThanOrEqual(2);
  });
});

// はみ出しが直ったことの試験ではない（jsdom にレイアウトが無い）。クラス名が書かれていること、`break-words` を消す変更を通さないことまでを見る。
// `question` は Markdown で描くので、`break-words` は `Markdown` のルート（祖先）に在り、単独の改行は `<br>` として保たれる。`answer` はクラス名で押さえる。
describe('折り返しの付け忘れ（本2）', () => {
  it('設問（question）は break-words を持つ要素の内側にあり、単独の改行が保たれる', async () => {
    stubApprovals([approval({ id: 'a-1', question: '質問1\n続きの行' })]);
    renderPage();

    const question = await screen.findByText(/質問1/);
    expect(question.closest('.break-words')).not.toBeNull();
    expect(question.querySelector('br')).not.toBeNull();
  });

  it('回答済みの回答（answer）に break-words が付いている', async () => {
    stubApprovals([
      approval({
        id: 'a-1',
        question: '質問1',
        answeredAt: '2026-08-19T11:00:00.000Z',
        answer: '許可する',
      }),
    ]);
    renderPage();

    const label = await screen.findByText('回答');
    const wrapper = label.closest('p');
    expect(wrapper).not.toBeNull();
    const tokens = wrapper!.className.split(/\s+/);
    expect(tokens).toContain('break-words');
    // `p` を狙う `white-space` の規則が無いので、これが無いと人間が入れた改行が1行に潰れる。
    expect(tokens).toContain('whitespace-pre-wrap');
  });

  it('回答経路（answeredVia）が在れば出す。無ければ出さない', async () => {
    stubApprovals([
      approval({
        id: 'a-1',
        question: '質問1',
        answeredAt: '2026-08-19T11:00:00.000Z',
        answer: '許可する',
        answeredVia: { kind: 'account', accountId: 'acc-1' },
      }),
      approval({
        id: 'a-2',
        question: '質問2',
        answeredAt: '2026-08-19T11:05:00.000Z',
        answer: '許可する',
        answeredVia: { kind: 'operator', auth: 'disabled' },
      }),
      approval({
        id: 'a-3',
        question: '質問3',
        answeredAt: '2026-08-19T11:10:00.000Z',
        answer: '許可する',
      }),
    ]);
    renderPage();

    await screen.findByText(/質問1/);
    expect(screen.getByText('回答経路: account（acc-1）')).not.toBeNull();
    expect(screen.getByText('回答経路: operator（認証無効）')).not.toBeNull();
    expect(screen.getAllByText(/回答経路:/)).toHaveLength(2);
  });
});

describe('答えの後の行動（issue #847）', () => {
  const answered = approval({
    id: 'a-1',
    question: '質問1',
    answeredAt: '2026-08-19T11:00:00.000Z',
    answer: '(b) で',
  });
  const traceBody = (over: Record<string, unknown>) => ({
    approval: answered,
    questionEntry: null,
    answerEntry: null,
    turnStarts: [],
    actions: [],
    actionsOmitted: 0,
    unstampedInTurn: 0,
    scanned: 1,
    truncated: false,
    ...over,
  });

  it('ボタンを押すまで読まず、押すと印を持つ行動を出す', async () => {
    const stub = stubApprovals([answered], {
      trace: () =>
        json(
          traceBody({
            state: 'paired',
            actions: [
              {
                type: 'decision',
                id: 'j-1',
                at: '2026-08-19T11:00:01.000Z',
                decision: 'b に沿って進めた',
                grounds: '人間の答え',
                answeredApprovalId: 'a-1',
              },
            ],
          }),
        ),
    });
    renderPage();

    const button = await screen.findByText('答えの後の行動を見る');
    expect(stub.calls.some((url) => url.includes('/trace'))).toBe(false);
    fireEvent.click(button);
    expect(await screen.findByText(/判断: b に沿って進めた/)).not.toBeNull();
  });

  it.each([
    { truncated: true, note: true },
    { truncated: false, note: false },
  ])(
    '対が見つかった分岐でも、窓が途中なら断る（truncated: $truncated, #3979）',
    async ({ truncated, note }) => {
      stubApprovals([answered], {
        trace: () =>
          json(
            traceBody({
              state: 'paired',
              truncated,
              scanned: 5000,
              actions: [
                {
                  type: 'decision',
                  id: 'j-1',
                  at: '2026-08-19T11:00:01.000Z',
                  decision: 'b に沿って進めた',
                  grounds: '人間の答え',
                  answeredApprovalId: 'a-1',
                },
              ],
            }),
          ),
      });
      renderPage();
      fireEvent.click(await screen.findByText('答えの後の行動を見る'));
      expect(await screen.findByText(/判断: b に沿って進めた/)).not.toBeNull();
      expect(screen.queryByText('（答えの後 5000 行までしか見ていない）') !== null).toBe(note);
    },
  );

  it('対が無ければ理由を出す（記録を始める前の答え）', async () => {
    stubApprovals([answered], {
      trace: () => json(traceBody({ state: 'turn_before_recording' })),
    });
    renderPage();
    fireEvent.click(await screen.findByText('答えの後の行動を見る'));
    expect(await screen.findByText(/行動が無いのではなく、記録していない/)).not.toBeNull();
  });

  it('種別は日本語の名前で出し、英語の識別子を出さない（本文を持たない種別も）', async () => {
    stubApprovals([answered], {
      trace: () =>
        json(
          traceBody({
            state: 'paired',
            actions: [
              {
                type: 'decision',
                id: 'j-1',
                at: '2026-08-19T11:00:01.000Z',
                decision: 'b に沿って進めた',
                grounds: '人間の答え',
                answeredApprovalId: 'a-1',
              },
              {
                type: 'token_rotation',
                id: 'j-5',
                at: '2026-08-19T11:00:02.000Z',
                answeredApprovalId: 'a-1',
              },
            ],
          }),
        ),
    });
    renderPage();
    fireEvent.click(await screen.findByText('答えの後の行動を見る'));
    expect(await screen.findByText(/トークンの交代/)).not.toBeNull();
    expect(screen.getByText(/ 判断$/)).not.toBeNull();
    const items = Array.from(document.querySelectorAll('li')).map((li) => li.textContent ?? '');
    const text = items.join('\n');
    expect(text).not.toMatch(/token_rotation/);
    expect(text).not.toMatch(/(^|\s)decision(\s|$)/);
  });

  it('tool_use は outcome を括弧で足す（core と同じ文言）', async () => {
    stubApprovals([answered], {
      trace: () =>
        json(
          traceBody({
            state: 'paired',
            actions: [
              {
                type: 'tool_use',
                id: 'j-2',
                at: '2026-08-19T11:00:01.000Z',
                actor: 'clone',
                tool: 'Bash',
                outcome: 'failed',
                answeredApprovalId: 'a-1',
              },
            ],
          }),
        ),
    });
    renderPage();
    fireEvent.click(await screen.findByText('答えの後の行動を見る'));
    expect(await screen.findByText(/道具 Bash（失敗）/)).not.toBeNull();
  });

  it('tool_use の outcome は日本語で出し、未知の値は素のまま出す', async () => {
    const tool = (id: string, outcome: string) => ({
      type: 'tool_use',
      id,
      at: '2026-08-19T11:00:01.000Z',
      actor: 'clone',
      tool: 'Bash',
      outcome,
      input: { command: 'ls' },
      answeredApprovalId: 'a-1',
    });
    stubApprovals([answered], {
      trace: () =>
        json(
          traceBody({
            state: 'paired',
            actions: [tool('j-2', 'interrupted'), tool('j-3', 'zzz_unknown')],
          } as never),
        ),
    });
    renderPage();
    fireEvent.click(await screen.findByText('答えの後の行動を見る'));
    expect(await screen.findByText(/道具 Bash（中断）: \{"command":"ls"\}/)).not.toBeNull();
    expect(screen.getByText(/道具 Bash（zzz_unknown）: /)).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/interrupted|failed/);
  });

  it('行動の本文に混じった秘密は伏せる', async () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    stubApprovals([answered], {
      trace: () =>
        json(
          traceBody({
            state: 'paired',
            actions: [
              {
                type: 'decision',
                id: 'j-1',
                at: '2026-08-19T11:00:01.000Z',
                decision: `鍵 ${secret} で進めた`,
                grounds: '人間の答え',
                answeredApprovalId: 'a-1',
              },
            ],
          }),
        ),
    });
    renderPage();
    fireEvent.click(await screen.findByText('答えの後の行動を見る'));
    expect(await screen.findByText(/判断: 鍵 /)).not.toBeNull();
    expect(document.body.textContent).not.toContain(secret);
  });

  it('exchange with=human は「人間への返答: 」を、それ以外は「発言: 」を前に置く（core と同じ文言）', async () => {
    stubApprovals([answered], {
      trace: () =>
        json(
          traceBody({
            state: 'paired',
            actions: [
              {
                type: 'exchange',
                id: 'j-3',
                at: '2026-08-19T11:00:01.000Z',
                with: 'human',
                role: 'outbound',
                text: '進めました',
                answeredApprovalId: 'a-1',
              },
              {
                type: 'exchange',
                id: 'j-4',
                at: '2026-08-19T11:00:02.000Z',
                with: 'self',
                role: 'outbound',
                text: '内部の発言',
                answeredApprovalId: 'a-1',
              },
            ],
          }),
        ),
    });
    renderPage();
    fireEvent.click(await screen.findByText('答えの後の行動を見る'));
    expect(await screen.findByText(/人間への返答: 進めました/)).not.toBeNull();
    expect(await screen.findByText(/発言: 内部の発言/)).not.toBeNull();
  });
});

describe('取り下げ済みの表示（issue #963）', () => {
  it('取り下げ済みのバッジと、理由の本文を出す（回答済みとは別のバッジ）', async () => {
    stubApprovals([
      approval({
        id: 'a-1',
        question: '質問1',
        withdrawnAt: '2026-08-19T12:00:00.000Z',
        withdrawnReason: '自分で答えを見つけた',
      }),
    ]);
    renderPage();

    expect(await screen.findByText('取り下げ済')).not.toBeNull();
    expect(screen.queryByText('回答済')).toBeNull();

    const label = await screen.findByText('取り下げた理由');
    const wrapper = label.closest('p');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.textContent).toContain('自分で答えを見つけた');
  });

  it('取り下げ済みには回答フォームを出さない（もう入力を受け付けない終端）', async () => {
    stubApprovals([
      approval({
        id: 'a-1',
        question: '質問1',
        withdrawnAt: '2026-08-19T12:00:00.000Z',
        withdrawnReason: '前提が消えた',
      }),
    ]);
    renderPage();

    await screen.findByText('取り下げ済');
    expect(screen.queryByPlaceholderText(/答える/)).toBeNull();
    expect(screen.queryByRole('button', { name: '許可' })).toBeNull();
  });

  it('理由の記録が無い取り下げでも空で終わらない', async () => {
    stubApprovals([
      approval({
        id: 'a-1',
        question: '質問1',
        withdrawnAt: '2026-08-19T12:00:00.000Z',
      }),
    ]);
    renderPage();

    const label = await screen.findByText('取り下げた理由');
    expect(label.closest('p')!.textContent).toContain('理由の記録なし');
  });
});

describe('クローンが書いた文だけを Markdown で描く', () => {
  it('設問（question）は Markdown の描画経路を通る', async () => {
    stubApprovals([approval({ id: 'a-1', question: '## 設問の見出し\n\n本番に出してよいか' })]);
    renderPage();

    expect(await screen.findByRole('heading', { name: '設問の見出し' })).toBeTruthy();
    expect(screen.getByText('本番に出してよいか')).toBeTruthy();
  });

  it('背景（context）は Markdown の描画経路を通る', async () => {
    stubApprovals([
      approval({ id: 'a-1', question: '質問1', context: '## 背景の見出し\n\n背景の本文' }),
    ]);
    renderPage();

    expect(await screen.findByRole('heading', { name: '背景の見出し' })).toBeTruthy();
    expect(screen.getByText('背景の本文')).toBeTruthy();
  });

  // `answer` は人間が打った文なので Markdown にしない。既存方針は
  // `grep -Fn -- 'クローンの行だけを Markdown にする' packages/ui/src/components/features/chat/chat-message.tsx`
  // が指す箇所。落ちたらまずそこを読むこと。
  it('回答（answer）は Markdown の描画経路を通らない（人間が書いた文字を化けさせない）', async () => {
    stubApprovals([
      approval({
        id: 'a-1',
        question: '質問1',
        answeredAt: '2026-08-19T11:00:00.000Z',
        answer: '## これは見出しではない',
      }),
    ]);
    renderPage();

    const answer = await screen.findByText('## これは見出しではない');
    expect(screen.queryByRole('heading', { name: 'これは見出しではない' })).toBeNull();
    expect(answer.textContent).toContain('## これは見出しではない');
  });

  it('回答（answer）の改行は whitespace-pre-wrap で保たれる', async () => {
    stubApprovals([
      approval({
        id: 'a-1',
        question: '質問1',
        answeredAt: '2026-08-19T11:00:00.000Z',
        answer: '許可する\n条件は無い',
      }),
    ]);
    renderPage();

    const answer = await screen.findByText(/許可する/);
    expect(answer.className.split(/\s+/)).toContain('whitespace-pre-wrap');
    expect(answer.textContent).toContain('許可する\n条件は無い');
  });
});

// 折り返したことの試験ではない（jsdom にレイアウトが無い）。クラス名が書かれていることまでを見る。
describe('横並びの積み替え（本4-B）: flex-wrap の付け忘れ', () => {
  it('メタ行（バッジ・時刻・job id）に flex-wrap が付いている', async () => {
    stubApprovals([approval({ id: 'a-1', jobId: 'job-abc' })]);
    renderPage();

    const jobLink = await screen.findByRole('link', { name: '詳細を見る' });
    const row = jobLink.closest('div');
    expect(row).not.toBeNull();
    const tokens = row!.className.split(/\s+/);
    expect(tokens).toContain('flex-wrap');
  });

  it('未回答カードのボタン行に flex-wrap が付いている', async () => {
    stubApprovals([approval({ id: 'a-1' })]);
    renderPage();

    const button = await screen.findByRole('button', { name: '回答する' });
    const row = button.closest('div');
    expect(row).not.toBeNull();
    const tokens = row!.className.split(/\s+/);
    expect(tokens).toContain('flex-wrap');
  });
});

describe('メタ行の job id が委譲の詳細へのリンクになる（issue #2041）', () => {
  it('jobId を持つカードは id が /managers/<id> への Link になり、id は文字として出ない（#2782）', async () => {
    stubApprovals([approval({ id: 'a-1', jobId: 'mgr-42' })]);
    renderPage();

    const link = await screen.findByRole('link', { name: '詳細を見る' });
    expect(link.getAttribute('href')).toBe('/managers/mgr-42');
    expect(link.parentElement?.textContent).toBe('委譲: 詳細を見る');
    expect(document.body.textContent).not.toContain('mgr-42');
  });

  it('jobId を持たないカードにはリンクを出さない', async () => {
    stubApprovals([approval({ id: 'a-1' })]);
    renderPage();

    expect(await screen.findByText('本番に出してよいか')).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: '承認待ちの一覧' })).queryByRole('link'),
    ).toBeNull();
  });
});

describe('承認カードに、確認が上がった会話を出す（issue #782 の3）', () => {
  it('① 機構が無い: conversationId が無ければ「会話に紐づいていない」と出し、/conversations は叩かない', async () => {
    const { calls } = stubApprovals([approval({ id: 'a-1', question: '質問1' })]);
    renderPage();

    expect(await screen.findByText(/この確認は会話に紐づいていない/)).toBeTruthy();
    expect(calls.some((url) => url.includes('/conversations/'))).toBe(false);
  });

  it('② 読み出せなかった（読み込み中）: 会話を読み込むあいだはスピナーを出し、「まだ返答が無い」に潰さない', async () => {
    stubApprovals([approval({ id: 'a-1', question: '質問1', conversationId: 'conv-x' })], {
      conversation: () => new Promise<Response>(() => {}),
    });
    renderPage();

    expect(await screen.findByText('この確認が上がった会話を読み込み中')).toBeTruthy();
    expect(screen.queryByText('この会話にはまだクローンの発言が無い')).toBeNull();
    expect(screen.queryByText('この確認が上がった会話')).toBeNull();
  });

  it('② 読み出せなかった（失敗）: 会話の取得が失敗したら理由をそのまま出し、「まだ返答が無い」に潰さない', async () => {
    stubApprovals([approval({ id: 'a-1', question: '質問1', conversationId: 'conv-x' })], {
      conversation: () => json({ error: '会話 conv-x は存在しない' }, 404),
    });
    renderPage();

    expect(await screen.findByText(/会話 conv-x は存在しない/)).toBeTruthy();
    expect(screen.queryByText('この会話にはまだクローンの発言が無い')).toBeNull();
    expect(screen.queryByText('この確認が上がった会話')).toBeNull();
  });

  it('③ まだ返答が無い: 会話は取れたが、クローンの発言が0件なら「まだクローンの発言が無い」と出す', async () => {
    stubApprovals([approval({ id: 'a-1', question: '質問1', conversationId: 'conv-x' })], {
      conversation: () =>
        json({
          conversationId: 'conv-x',
          messages: [
            { id: 'm1', at: '2026-08-19T09:00:00.000Z', role: 'inbound', text: '人間の発言だけ' },
          ],
          scanned: 1,
          reachedStart: true,
        }),
    });
    renderPage();

    expect(await screen.findByText('この会話にはまだクローンの発言が無い')).toBeTruthy();
    expect(screen.queryByText('この確認が上がった会話')).toBeNull();
    expect(
      screen.getByRole('link', { name: /この会話をチャットで開く/ }).getAttribute('href'),
    ).toBe('/chat/conv-x');
  });

  it('③ 窓が先頭に届いていない（reachedStart: false）: クローンの発言が0件でも「まだ無い」と言い切らず、確かめられなかったと出す（#3871）', async () => {
    stubApprovals([approval({ id: 'a-1', question: '質問1', conversationId: 'conv-x' })], {
      conversation: () =>
        json({
          conversationId: 'conv-x',
          messages: [
            { id: 'm1', at: '2026-08-19T09:00:00.000Z', role: 'inbound', text: '人間の発言だけ' },
          ],
          scanned: 1,
          reachedStart: false,
        }),
    });
    renderPage();

    expect(
      await screen.findByText(/取れた窓にはクローンの発言が無かった.*確かめられなかった/),
    ).toBeTruthy();
    expect(screen.queryByText('この会話にはまだクローンの発言が無い')).toBeNull();
    expect(
      screen.getByRole('link', { name: /この会話をチャットで開く/ }).getAttribute('href'),
    ).toBe('/chat/conv-x');
  });

  it.each([
    { reachedStart: false, note: true },
    { reachedStart: true, note: false },
  ])(
    '④ クローンの発言が在っても、窓が先頭に届いていなければ断る（reachedStart: $reachedStart, #3979）',
    async ({ reachedStart, note }) => {
      stubApprovals([approval({ id: 'a-1', question: '質問1', conversationId: 'conv-x' })], {
        conversation: () =>
          json({
            conversationId: 'conv-x',
            messages: [
              {
                id: 'm2',
                at: '2026-08-19T09:05:00.000Z',
                role: 'outbound',
                text: 'はい、進めます',
              },
            ],
            scanned: 1,
            reachedStart,
          }),
      });
      renderPage();

      expect(await screen.findByText('はい、進めます')).toBeTruthy();
      expect(
        screen.queryByText('窓が会話の先頭に届いていないので、取れた発言だけを出している') !== null,
      ).toBe(note);
    },
  );

  // 見出しは「この確認への返答」にしない: `toMessage()` が `approvalId` を写していないので、どの発言が回答かを名指しできない。
  it('④ 在る: 会話の発言を出す。見出しは「この確認が上がった会話」であって「この確認への返答」ではない', async () => {
    stubApprovals([approval({ id: 'a-1', question: '質問1', conversationId: 'conv-x' })], {
      conversation: () =>
        json({
          conversationId: 'conv-x',
          messages: [
            {
              id: 'm1',
              at: '2026-08-19T09:00:00.000Z',
              role: 'inbound',
              text: '本番に出してよいか?',
            },
            { id: 'm2', at: '2026-08-19T09:05:00.000Z', role: 'outbound', text: 'はい、進めます' },
          ],
          scanned: 2,
          reachedStart: true,
        }),
    });
    renderPage();

    expect(await screen.findByText('この確認が上がった会話')).toBeTruthy();
    expect(screen.getByText('本番に出してよいか?')).toBeTruthy();
    expect(screen.getByText('はい、進めます')).toBeTruthy();
    expect(screen.queryByText(/への返答/)).toBeNull();
    expect(screen.queryByText('この会話にはまだクローンの発言が無い')).toBeNull();
    expect(
      screen.getByRole('link', { name: /この会話をチャットで開く/ }).getAttribute('href'),
    ).toBe('/chat/conv-x');
  });

  it('④ 発言の添付は名前だけを添える。名前の無い添付は「名前の無い添付」と出し、添付の無い発言には何も足さない（#4030）', async () => {
    const ref = (id: string, name: string) => ({
      id,
      name,
      mediaType: 'text/plain',
      size: 3,
      sha256: 'x',
    });
    stubApprovals([approval({ id: 'a-1', question: '質問1', conversationId: 'conv-x' })], {
      conversation: () =>
        json({
          conversationId: 'conv-x',
          messages: [
            {
              id: 'm1',
              at: '2026-08-19T09:00:00.000Z',
              role: 'inbound',
              text: '',
              attachments: [ref('f1', 'a.png'), ref('f2', 'b.log')],
            },
            {
              id: 'm2',
              at: '2026-08-19T09:01:00.000Z',
              role: 'inbound',
              text: '本文もある',
              attachments: [ref('f3', '')],
            },
            { id: 'm3', at: '2026-08-19T09:05:00.000Z', role: 'outbound', text: '添付なし' },
            {
              id: 'm4',
              at: '2026-08-19T09:06:00.000Z',
              role: 'inbound',
              text: '',
              attachments: ['a', 'b', 'c', 'd', 'e'].map((n) => ref(`g-${n}`, `${n}.txt`)),
            },
          ],
          scanned: 4,
          reachedStart: true,
        }),
    });
    renderPage();

    expect(await screen.findByText('［添付 2件: a.png、b.log］')).toBeTruthy();
    expect(screen.getByText('本文もある')).toBeTruthy();
    expect(screen.getByText('［添付 1件: 名前の無い添付］')).toBeTruthy();
    expect(screen.getByText('［添付 5件: a.txt、b.txt、c.txt、ほか 2 件］')).toBeTruthy();
    expect(screen.getAllByText(/［添付/)).toHaveLength(3);
  });

  it('チャットで開く導線は ① と ②（読み込み中・失敗）には出ない', async () => {
    stubApprovals(
      [
        approval({ id: 'a-1', question: '会話なし' }),
        approval({ id: 'a-2', question: '読み込み中', conversationId: 'conv-wait' }),
        approval({ id: 'a-3', question: '失敗', conversationId: 'conv-gone' }),
      ],
      {
        conversation: (id) =>
          id === 'conv-wait'
            ? new Promise<Response>(() => {})
            : json({ error: `会話 ${id} は存在しない` }, 404),
      },
    );
    renderPage();

    expect(await screen.findByText(/この確認は会話に紐づいていない/)).toBeTruthy();
    expect(await screen.findByText('この確認が上がった会話を読み込み中')).toBeTruthy();
    expect(await screen.findByText(/会話 conv-gone は存在しない/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /この会話をチャットで開く/ })).toBeNull();
  });
});

describe('/approvals 画面: 読めない承認待ちの断り', () => {
  it('読めない行が在るとき、件数・id・「回答済みでも取り下げ済みでもない」を出す。読めた行はそのまま出る', async () => {
    stubApprovals([approval({ id: 'a-1', question: '読める質問' })], {
      unreadable: [{ id: 'ap-bad', reason: '不正な欄: createdAt' }, { reason: '不正な行' }],
    });
    renderPage();

    expect(await screen.findByText('読める質問')).toBeTruthy();
    const note = screen.getByRole('status');
    expect(note.textContent).toContain('読めない承認待ちが 2 件ある');
    expect(note.textContent).toContain('id: ap-bad');
    expect(note.textContent).toContain('壊れた行であって、回答済みでも取り下げ済みでもない');
  });

  it('読めた行が0件でも「答えを待っているものはない。クローンは進んでいる」と言い切らない', async () => {
    stubApprovals([], { unreadable: [{ id: 'ap-bad', reason: '不正な欄: createdAt' }] });
    renderPage();

    expect(await screen.findByText(/読めない承認待ちが 1 件ある/)).toBeTruthy();
    expect(screen.queryByText(/クローンは進んでいる/)).toBeNull();
    expect(screen.getByText(/読めた範囲では、答えを待っているものはない/)).toBeTruthy();
  });

  it('0件のとき（鍵が無い）は何も出さない', async () => {
    stubApprovals([approval({ id: 'a-1', question: '読める質問' })]);
    renderPage();

    expect(await screen.findByText('読める質問')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/読めない/)).toBeNull();
  });
});

describe('見出し帯に幅を取る操作を置かない（#2765）', () => {
  // jsdom は折り返しを測れないので、見出し帯の中に操作が居座ること（390px で見出しの列が潰れた）が戻らないことを DOM の位置で固定する。
  it('トグルのボタンは無く、「未回答 / 回答済み」のタブは見出し帯（header）の外にある', async () => {
    stubApprovals([]);
    renderPage();

    await screen.findByText(/答えを待っているものはない/);
    expect(screen.queryByRole('button', { name: /回答済み・取り下げ済みも見る/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '未回答だけ' })).toBeNull();

    const tabs = screen.getByRole('navigation', { name: '承認のページ' });
    expect(tabs.closest('header')).toBeNull();
    expect(within(tabs).getByRole('link', { name: '未回答' }).getAttribute('href')).toBe(
      '/approvals',
    );
    expect(within(tabs).getByRole('link', { name: '回答済み' }).getAttribute('href')).toBe(
      '/approvals/answered',
    );
    const heading = screen.getByRole('heading', { name: '承認待ち' });
    expect(heading.closest('header')).not.toBeNull();
  });
});
