// @vitest-environment jsdom
/**
 * 承認待ちの一括処理（`/approvals` 画面）。
 *
 * デーモンには「1件が駄目でも残りは進む」`POST /approvals/answer` が既にあった
 * のに、画面は `POST /approvals/{id}/answer` を1件ずつ呼ぶだけだった
 * （**廃止済みの実装計画**〈#479〉の M3 —— 当時の文言は
 * `git show 7046e2c:docs/roadmap.md` —— と `docs/PRD.md`「入口の等価性」に
 * 対するバグ）。
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
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PendingApproval } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Approvals from './approvals';

function approval(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'a-1',
    createdAt: '2026-08-19T10:00:00.000Z',
    // 応答が返す派生欄（`packages/core/src/schema.ts` の `approvalUpdatedAt`）。
    // まだ回答が無いので既定は `createdAt` と同じ値にしておく。
    updatedAt: '2026-08-19T10:00:00.000Z',
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
  options: {
    bulkResults?: (answers: { id: string; answer: string }[]) => BulkResult[];
    /**
     * `GET /conversations/:id` の応答（issue #782 の3。`ConversationPanel` の
     * 4状態を測るために足した）。**渡さなければ以前と同じ挙動**——`/conversations/`
     * を叩く経路が無ければこの分岐には一度も入らない。
     */
    conversation?: (id: string) => Response | Promise<Response>;
    /** `GET /approvals/:id/trace` の応答（issue #847 の案B）。渡さなければ繋がらない。 */
    trace?: (id: string) => Response | Promise<Response>;
    /** `GET /approvals` の `unreadable`（#2298）。渡さなければ鍵ごと無い（0件と同じ）。 */
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

    // 知らない URL は「繋がらない」（`test-support` の `stubFetch` と同じ方針）。
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

/**
 * メタ行の `job <id>` が `<Link>`（react-router）を描画するようになったので
 * （issue #2041）、router context が要る。`commitments.test.tsx` の
 * `renderPageWithRouter` と同じ形（`createMemoryRouter` + `RouterProvider`）。
 * `jobId` を持たないカードでは何も変わらない。
 */
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

    // 上のタブの帯も list なので、カードの一覧に絞る。
    const items = within(await screen.findByRole('list', { name: '承認待ちの一覧' })).getAllByRole(
      'listitem',
    );
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

/**
 * 個別の回答が 409 で断られたとき（issue #1619）。
 *
 * `POST /approvals/{id}/answer` は、裏で先に片付いている——クローンが
 * `approval_withdraw` で取り下げた（#963）・別のタブや CLI が先に答えた——と
 * 409 を返す（`error: 'withdrawn'` / `error: 'already answered'`）。
 *
 * **このとき画面が一覧を取り直さないと**、カードは「未回答」の見た目
 * （入力欄・答えるボタン）のまま残り、生の英単語だけが赤字で出る——もう一度
 * 押しても同じ 409 が繰り返される。正しい状態に変わるのは手で再読み込みした
 * ときだけだった。
 *
 * 「まとめて送る」（`POST /approvals/answer`）は 1件が駄目でも 200 で
 * `results[]` を返すので、呼び出し側は必ず取り直しまで進む。**個別に答える
 * 経路だけ、この手当てが無かった**（`useAnswerApproval` は `unwrap` の例外で
 * 早期に抜け、`mutate(KEY.approvals(...))` へ届かない）。
 */
describe('個別の回答が 409 で断られたとき（issue #1619）', () => {
  /**
   * `GET /approvals` は、まだ答えていない（`initial`）／答えの後に裏で先に
   * 片付いていたと分かった（`resolved`）の2状態を、答える POST が届いた
   * かどうかで切り替えて返す。**この切り替えが「取り直した」ことの証拠に
   * なる** —— 取り直していなければ `resolved` は一度も画面に届かない。
   */
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

    // 失敗を握り潰さない——既存の表示の流儀どおり、サーバの文言をそのまま出す
    // （バルク版の「1件が失敗しても…」と同じ生の英単語のまま。下の doc 参照）。
    await screen.findByText(/withdrawn/);
    // 取り直した結果、答える口（textarea・「回答する」ボタン）は消える。
    await waitFor(() => expect(screen.queryByRole('button', { name: '回答する' })).toBeNull());
    await screen.findByText('取り下げ済');
    await screen.findByText('もう要らない');

    // GET /approvals は初回＋失敗後の取り直しで、最低2回叩かれている。
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

/**
 * 折り返しの付け忘れ（本2）。
 *
 * `question` / `answer` は自由文（`z.string()`、長さ・空白の制約なし）で、
 * URL のような空白を持たない長い一続きの文字列が来ても吹き出さないよう
 * `break-words` を持つ必要がある。`question` は既に `whitespace-pre-wrap`
 * を持っていたが `break-words` が無く、`answer` はクラス自体が無かった。
 *
 * **⚠️ これは「はみ出しが直った」ことの試験ではない。** jsdom はレイアウトを
 * 持たない（`offsetWidth` / `scrollWidth` / `getBoundingClientRect()` は
 * すべて 0）ので、固定できるのは「そのクラス名が書かれていること」までである。
 * それでも置くのは、戻す変更（`break-words` を消す）を黙って通さないため。
 *
 * **追記（`question` を Markdown 化したとき）**: `question` は
 * `<Markdown>` で描くようになったので、テキストを持つ要素はもう
 * `approvals.tsx` の `<p>` ではなく `markdown.tsx` の
 * `<p className="mt-2 leading-relaxed first:mt-0">` である。`break-words` は
 * その1つ外側（`markdown.tsx` のルート `<div className="min-w-0 text-sm
 * break-words">`）へ移った。**保証は消さずに辿り直してある** — 「テキストを
 * 持つ要素そのものが `break-words` を持つ」から「テキストを持つ要素の側から
 * `break-words` を持つ要素へ辿り着ける」へ変えただけで、`break-words` を消す
 * 変更は今も落ちる。
 *
 * **`whitespace-pre-wrap` のクラス名の検査は、`question` については別の保証へ
 * 置き換えた。** あの行が守っていたのはクラス名そのものではなく「単独の改行が
 * 保たれること」で、Markdown 化後はそれを `mdast-util-newline-to-break`
 * （`remark-breaks` の中身。`<Markdown>` が直接掛けている）が `<br>` として
 * 担う。だからクラス名ではなく `<br>` が出ることを直接押さえる — クラス名より
 * 強い保証である（実装の手段が変わっても、見えるものが変わったときだけ落ちる）。
 * `answer` は Markdown にしていないので、あちらはクラス名のままで押さえる。
 */
describe('折り返しの付け忘れ（本2）', () => {
  it('設問（question）は break-words を持つ要素の内側にあり、単独の改行が保たれる', async () => {
    stubApprovals([approval({ id: 'a-1', question: '質問1\n続きの行' })]);
    renderPage();

    // Markdown 化でテキストを持つ要素は `markdown.tsx` の `<p>` になった。
    // `break-words` はその祖先（`Markdown` のルート）に在る（doc 参照）。
    const question = await screen.findByText(/質問1/);
    expect(question.closest('.break-words')).not.toBeNull();
    // 単独の改行は `<Markdown>` が（`mdast-util-newline-to-break` で）`<br>` にして保つ。
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

    // `answer` は「回答」という見出しラベルの隣に素のテキストで置かれているので、
    // ラベル側から `<p>` 本体（クラスの持ち主）を辿る。
    const label = await screen.findByText('回答');
    const wrapper = label.closest('p');
    expect(wrapper).not.toBeNull();
    const tokens = wrapper!.className.split(/\s+/);
    expect(tokens).toContain('break-words');
    // **改行が潰れる不具合の修正**（Markdown 化とは別件）。`@alteroid/ui` の `styles.css` の
    // `white-space` 指定は `pre` に対する1件だけで `p` を狙う規則が無いため、
    // ここは CSS 既定の `white-space: normal` で描かれていた — 人間が改行を
    // 入れて答えても1行に潰れていた。
    expect(tokens).toContain('whitespace-pre-wrap');
  });

  /**
   * 回答経路の表示（Issue #1479）。**記録が無い行では出さない**——
   * 「わからない」を「operator ではない」に化けさせない
   * （`packages/core/src/schema.ts` の `answeredViaSchema` の doc）。
   */
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
        // answeredVia を持たない（記録の無い古い経路）。
      }),
    ]);
    renderPage();

    await screen.findByText(/質問1/);
    expect(screen.getByText('回答経路: account（acc-1）')).not.toBeNull();
    expect(screen.getByText('回答経路: operator（認証無効）')).not.toBeNull();
    expect(screen.getAllByText(/回答経路:/)).toHaveLength(2);
  });
});

/**
 * 答えの後の行動（issue #847 の案B）。**開いたときだけ読む**ことと、対が無いときに
 * 理由を黙って落とさないことを測る。
 */
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

  it('対が無ければ理由を出す（記録を始める前の答え）', async () => {
    stubApprovals([answered], {
      trace: () => json(traceBody({ state: 'turn_before_recording' })),
    });
    renderPage();
    fireEvent.click(await screen.findByText('答えの後の行動を見る'));
    expect(await screen.findByText(/行動が無いのではなく、記録していない/)).not.toBeNull();
  });

  /** issue #3061: 頭は日本語の種別名。本文を持たない種別は識別子を繰り返さない。 */
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

  /**
   * 行動一覧の文言が core（`describeTraceAction`。`packages/core/src/trace-action.ts`）
   * と揃うことを固定する（issue #1528）。**この画面はかつて `describeAction` という
   * 名前の複製を持ち、`tool_use` の `outcome` と `exchange` の「人間への返答/発言:」
   * の接頭辞が抜けていた**——ここで固定するのはその2点そのものである。
   */
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

  /** issue #3077: outcome は日本語。未知の値は素の値のまま出す。入力の後続は保つ。 */
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

  /** #3870: 行動の本文も、ほかの本文と同じく伏せ字を通して出す。 */
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

/**
 * クローンが `approval_withdraw` で取り下げた件の表示（issue #963）。
 *
 * 受け入れ基準「Web UI で取り下げられた件と理由が読める」を直接固定する。
 */
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
    // 回答済みのバッジは出ない（混同しない）。
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

/**
 * クローン（AI）が書いた文字列だけを Markdown で描く（`approvals.tsx`）。
 *
 * **Markdown の中身の正しさはここの仕事ではない** — それは
 * `packages/ui/src/components/markdown.test.tsx` が持つ。ここが押さえるのは
 * 「その欄が Markdown の描画経路を通るか／通らないか」だけである。だから
 * `## 見出し` を混ぜて `findByRole('heading', …)` で拾う形にしている
 * （`dashboard.test.tsx` / `reports.test.tsx` / `memory-detail.test.tsx` と
 * 同じ流儀）。
 */
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

  /**
   * **⭐ 設計判断を守る歯。**
   *
   * `answer` は人間が打った文なので Markdown にしない。repo の既存方針が
   * `packages/ui/src/components/features/chat/chat-message.tsx`
   * （`grep -Fn -- 'クローンの行だけを Markdown にする' packages/ui/src/components/features/chat/chat-message.tsx`）
   * に逐語で在る — 「**クローンの行だけを
   * Markdown にする。** 人間が打った本文（`role === 'human'`）は素のテキストの
   * ままにする — 自分が書いた文字が勝手に化けないため」。
   *
   * このテストは逆向きの変更（`answer` も `<Markdown>` で描く）が黙って通らない
   * ようにするために在る。落ちたら、まず `chat-message.tsx`（上記の grep が指す箇所）を
   * 読むこと。
   */
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

    // 見出しとしては解釈されない。
    const answer = await screen.findByText('## これは見出しではない');
    expect(screen.queryByRole('heading', { name: 'これは見出しではない' })).toBeNull();
    // そして `##` を含む文字列がそのまま素のテキストとして見えている。
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

/**
 * 横並びの積み替え（本4-B）: flex-wrap の付け忘れ。
 *
 * メタ行（バッジ・時刻・`job {id}`）とボタン行（回答する/許可/却下/
 * ショートカット表示）は、同じ画面の別の行（`:98`）には既に付いていた
 * `flex-wrap` がここには無かった。本3 で `Badge` に `shrink-0` が入って
 * 縮まなくなり、`Button` が狭い画面で `h-11`（44px）になった分、どちらの
 * 行も以前より横幅を食う側へ振れている。
 *
 * **⚠️ これは「折り返した」ことの試験ではない。** jsdom はレイアウトを
 * 持たない（`offsetWidth` / `scrollWidth` / `getBoundingClientRect()` は
 * すべて 0）ので、`flex-wrap` が実際に効いて折り返しているかはここでは
 * 1つも観測できない。固定できるのは「そのクラス名が書かれていること」
 * までである。
 */
describe('横並びの積み替え（本4-B）: flex-wrap の付け忘れ', () => {
  it('メタ行（バッジ・時刻・job id）に flex-wrap が付いている', async () => {
    stubApprovals([approval({ id: 'a-1', jobId: 'job-abc' })]);
    renderPage();

    // `job-abc` の部分は `<Link>` になったので（issue #2041）、行はリンクから辿る。
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

/**
 * **メタ行の `job <id>` を委譲の詳細へつなぐ（issue #2041）。** `jobId` は
 * マネージャー id（`packages/core/src/schema.ts` の `pendingApprovalSchema`）
 * なので、`/managers/<id>` へ飛べる。`commitments.tsx`（issue #2028）と同じ
 * 作法で、文言は変えない——行の文字列は引き続き `job <id>` と読める。
 */
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
    // 上のタブの帯のリンクは数えない（カードの一覧の中にリンクが無いこと）。
    expect(
      within(screen.getByRole('list', { name: '承認待ちの一覧' })).queryByRole('link'),
    ).toBeNull();
  });
});

/**
 * 承認カードに、その確認が上がった会話を出す（issue #782 の3）。
 *
 * **不変条件A（「無い」の種類を潰さない）を4状態それぞれで別々に測る。**
 * どれか2つが同じ表示に潰れていないか——特に「読み込み中」「失敗」が
 * 「まだ返答が無い」の文言に化けていないことを、各テストが**他の状態の
 * 文言が出ていないこと**まで含めて押さえる。
 */
describe('承認カードに、確認が上がった会話を出す（issue #782 の3）', () => {
  it('① 機構が無い: conversationId が無ければ「会話に紐づいていない」と出し、/conversations は叩かない', async () => {
    const { calls } = stubApprovals([approval({ id: 'a-1', question: '質問1' })]);
    renderPage();

    expect(await screen.findByText(/この確認は会話に紐づいていない/)).toBeTruthy();
    expect(calls.some((url) => url.includes('/conversations/'))).toBe(false);
  });

  it('② 読み出せなかった（読み込み中）: 会話を読み込むあいだはスピナーを出し、「まだ返答が無い」に潰さない', async () => {
    // わざと解決しない Promise を返し、「読み込み中」のまま留める。
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
    // ④ の見出しは出ない。
    expect(screen.queryByText('この確認が上がった会話')).toBeNull();
    // 会話は読めたので、チャットで開く導線は出す（issue #2069）。
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

  /**
   * ⚠️ **見出しは「この確認が上がった会話」であって「この確認への返答」では
   * ない**（不変条件D。ここは変えていない）。outbound の `exchange` には
   * `approvalId` が積まれるようになった（issue #782 の1。PR #1319）が、
   * `conversation.ts` の `toMessage()` がそれを写していないため、この画面
   * までは届いていない。だから今もどの発言が回答なのかを名指ししない。
   */
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
    // 「への返答」という言い回しは画面のどこにも無い。
    expect(screen.queryByText(/への返答/)).toBeNull();
    // 「まだクローンの発言が無い」（③）とは出ない。
    expect(screen.queryByText('この会話にはまだクローンの発言が無い')).toBeNull();
    // チャットで開く導線（issue #2069）。
    expect(
      screen.getByRole('link', { name: /この会話をチャットで開く/ }).getAttribute('href'),
    ).toBe('/chat/conv-x');
  });

  /**
   * **読めなかった会話には「チャットで開く」を出さない（issue #2069）。**
   * 読み込み中・失敗のどちらでも出さない。①（会話が無い）にも出さない。
   */
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

/**
 * 読めない承認待ちの行（#2298）。一覧が読めない行を黙って飛ばすと、人間には
 * 「答えを待っているものはない」と見える。件数と id を、読めた行の上で断る。
 */
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
  /*
    以前は「回答済み・取り下げ済みも見る」のトグルを本文の先頭に置いていた（見出し帯の右に居座ると、
    390px で見出しの列が約148px、説明文が4行になった。実寸はブラウザで測った）。#3237 でトグルは
    なくなり、回答済みへはタブ（「未回答 / 回答済み」）で行く。jsdom はレイアウトを持たず折り返しを
    測れないので、同じ原因（見出し帯の中に操作が居座る）が戻らないことを、DOM の位置で固定する。
  */
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
    // 見出しと説明文は header の中に残っている。
    const heading = screen.getByRole('heading', { name: '承認待ち' });
    expect(heading.closest('header')).not.toBeNull();
  });
});
