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
 * 保たれること」で、Markdown 化後はそれを `remark-breaks` が `<br>` として
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
    // 単独の改行は `remark-breaks` が `<br>` にして保つ。
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
    // **改行が潰れる不具合の修正**（Markdown 化とは別件）。`app.css` の
    // `white-space` 指定は `pre` に対する1件だけで `p` を狙う規則が無いため、
    // ここは CSS 既定の `white-space: normal` で描かれていた — 人間が改行を
    // 入れて答えても1行に潰れていた。
    expect(tokens).toContain('whitespace-pre-wrap');
  });
});

/**
 * クローン（AI）が書いた文字列だけを Markdown で描く（`approvals.tsx`）。
 *
 * **Markdown の中身の正しさはここの仕事ではない** — それは
 * `apps/web/app/components/markdown.test.tsx` が持つ。ここが押さえるのは
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
   * `apps/web/app/routes/chat.tsx:710` に逐語で在る — 「**クローンの行だけを
   * Markdown にする。** 人間が打った本文（`role === 'human'`）は素のテキストの
   * ままにする — 自分が書いた文字が勝手に化けないため」。
   *
   * このテストは逆向きの変更（`answer` も `<Markdown>` で描く）が黙って通らない
   * ようにするために在る。落ちたら、まず `chat.tsx:710` を読むこと。
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

    const jobText = await screen.findByText('job job-abc');
    const row = jobText.closest('div');
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
