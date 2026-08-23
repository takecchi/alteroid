// @vitest-environment jsdom
/**
 * 引き受けたまま終わっていない仕事の台帳（`/commitments` 画面）。
 *
 * ここで固定するのは見た目ではなく、**器が持っている意味を画面が落とさない**ことである。
 *
 * 1. 起点と齢（`origin` / `at`）を出す — 器は優先度も締切も持たないので、人間が
 *    急ぎ方を決める材料はこの2つしかない（`packages/core/src/schema.ts`）
 * 2. 片付けるときに理由を必ず取る — 「閉じた」だけが残ると人間が後から否定できない
 * 3. 片付いたものを読む手立てがある — 器は行を消さない（日報の材料になる）
 * 4. CLI（`/commitments` `/commit` `/done`）と同じ経路を叩く — 片方でしかできない
 *    ことを作らない
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Commitment, CommitmentOrigin } from '@alteroid/core';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Commitments from './commitments';

const DAY_MS = 24 * 60 * 60 * 1000;

function commitment(over: Partial<Commitment> = {}): Commitment {
  return {
    id: 'cmt-1',
    at: new Date(Date.now() - 3 * DAY_MS).toISOString(),
    origin: 'human',
    body: 'ドキュメントの誤りを直す',
    ...over,
  };
}

/**
 * 実際に飛んだ要求を控える。
 *
 * **差し替えではなく素通しの記録である**（`stubFetch` が置いた本物の応答をそのまま
 * 返す）。`test-support` の `FetchStub` は URL と認証ヘッダしか控えないので、
 * 「どの本文を送ったか」を見るぶんだけここで足す。**判断は一切していない** ので、
 * 通ってしまう嘘を挟む余地が無い。
 */
function recordRequests(): Request[] {
  const requests: Request[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) requests.push(input.clone());
    return inner(input, init);
  }) as typeof fetch;
  return requests;
}

/** `includeClosed=true` を付けたときだけ、片付けたものも返す。 */
function stubCommitments(open: Commitment[], closed: Commitment[] = []) {
  return stubFetch((url) => {
    if (!url.includes('/commitments')) return undefined;
    // 閉じる経路は本文を読まない（画面も応答の中身を使わない）。
    if (url.includes('/close')) return json({ ok: true });
    return json({ entries: url.includes('includeClosed=true') ? [...open, ...closed] : open });
  });
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
      <Commitments />
    </Providers>,
  );
}

describe('/commitments 画面', () => {
  /**
   * 器は優先度も締切も持たない（`commitmentSchema`）。だから「どこから来たか」と
   * 「どれだけ放置されているか」が落ちると、人間が急ぎ方を決める材料が消える。
   */
  it('未了に起点と齢を出す（急ぎ方を決める材料はこの2つしかない）', async () => {
    stubCommitments([commitment({ origin: 'human', source: 'conv-1' })]);
    renderPage();

    expect(await screen.findByText('ドキュメントの誤りを直す')).toBeTruthy();
    expect(screen.getByText(/人間/)).toBeTruthy();
    expect(screen.getByText(/conv-1/)).toBeTruthy();
    // 受け取ってから3日。絶対時刻だけだと、読むたびに引き算をさせることになる。
    expect(screen.getByText('(3日前)')).toBeTruthy();
  });

  /**
   * **バッジの実行時の倒れ先を固定する歯（issue #288）。**
   *
   * `ORIGIN_LABEL`（`commitments.tsx`）は `Record<CommitmentOrigin, string>`
   * のまま網羅性を保っているので、`commitmentOriginSchema`
   * （`packages/core/src/schema.ts:892`）に無い値がビルド時に来ることは無い
   * （変異試験で確認済み、PR 本文）。
   *
   * **ただし実行時はビルド時の型を追い越しうる。** デーモンが先に新しい
   * `origin` を返し、この画面（この型定義）がまだ古い、という順序が実在する
   * （#285 の `CommitmentBody` と同じ理由）。`originLabel()`
   * はその倒れ先を固定する — **空文字ではなく、起点の生の値そのものを出す。**
   */
  it('未知の origin でもバッジのラベルが空文字にならず、起点の生の値が出る（実行時の倒れ先）', async () => {
    stubCommitments([
      commitment({ origin: 'probe' as CommitmentOrigin, body: '未知の起点のコミットメント' }),
    ]);
    renderPage();

    await screen.findByText('未知の起点のコミットメント');
    // ORIGIN_LABEL に無いキーなので、undefined ではなく 'probe'（生の値）が
    // そのままバッジに出る。空文字（≒バッジの中身が見えない）にはならない。
    expect(screen.getByText('probe')).toBeTruthy();
  });

  /**
   * 器は行を消さない（「何を片付けたか」は日報の材料である）。読む手立てが画面に
   * 無いと、その事実へ人間が到達できない。既定で出さないのは未了が埋もれるため。
   */
  it('片付けたものは、押されたときだけ includeClosed=true で取りに行く', async () => {
    const stub = stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-1',
          body: 'もう終わった',
          closedAt: new Date().toISOString(),
          closedReason: 'PR #99 をマージした',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    expect(screen.queryByText('もう終わった')).toBeNull();
    expect(stub.calls.some((url) => url.includes('includeClosed=true'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    expect(await screen.findByText('もう終わった')).toBeTruthy();
    // 何をもって終わりとしたのか。ここが無いと人間は否定のしようがない。
    expect(screen.getByText(/PR #99 をマージした/)).toBeTruthy();
    expect(stub.calls.some((url) => url.includes('includeClosed=true'))).toBe(true);
    // 未了が消えるわけではない（切り替えは「足して見る」であって「入れ替え」ではない）。
    expect(screen.getByText('まだ終わっていない')).toBeTruthy();
  });

  /**
   * **「閉じた」だけを残さない。** 人間が後から否定できることが最終承認の実体で
   * あり、何をもって終わりとしたのかが無いと否定のしようがない（north_star）。
   */
  it('理由を書かないと片付けられない', async () => {
    stubCommitments([commitment()]);
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    const close = screen.getByRole('button', { name: '片付いた' });
    expect((close as HTMLButtonElement).disabled).toBe(true);

    // 空白だけでも通さない（見た目上は書いたように見えるので、ここが抜けやすい）。
    fireEvent.change(screen.getByPlaceholderText(/何をもって片付いたか/), {
      target: { value: '   ' },
    });
    expect((screen.getByRole('button', { name: '片付いた' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('理由を書いて片付けると、その id と理由が閉じる経路へ乗る', async () => {
    stubCommitments([commitment({ id: 'cmt-42' })]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    fireEvent.change(screen.getByPlaceholderText(/何をもって片付いたか/), {
      target: { value: 'PR #99 をマージした' },
    });
    fireEvent.click(screen.getByRole('button', { name: '片付いた' }));

    const closed = await waitFor(() => {
      const found = requests.find((request) => request.url.includes('/commitments/cmt-42/close'));
      expect(found).toBeDefined();
      return found!;
    });
    expect(closed.method).toBe('POST');
    expect(JSON.parse(await closed.text())).toEqual({ reason: 'PR #99 をマージした' });
  });

  /**
   * **読めるだけにしない。** CLI には `/commit` があるので、ここに積む口が無いと
   * 「Web ではできないこと」が生まれる（PRD「インターフェース」）。
   */
  it('積む口が、本文をそのまま POST /commitments へ送る', async () => {
    stubCommitments([]);
    const requests = recordRequests();
    renderPage();

    await screen.findByText('引き受けたまま終わっていない仕事はない。');
    fireEvent.change(screen.getByPlaceholderText(/何を引き受けたか/), {
      target: { value: '週明けに設計を見直す' },
    });
    fireEvent.click(screen.getByRole('button', { name: '積む' }));

    const posted = await waitFor(() => {
      const found = requests.find(
        (request) => request.method === 'POST' && request.url.endsWith('/commitments'),
      );
      expect(found).toBeDefined();
      return found!;
    });
    expect(JSON.parse(await posted.text())).toEqual({ body: '週明けに設計を見直す' });
  });

  it('本文が空のあいだは積めない', async () => {
    stubCommitments([]);
    renderPage();

    await screen.findByText('引き受けたまま終わっていない仕事はない。');
    expect((screen.getByRole('button', { name: '積む' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * 折り返しの付け忘れ（本2）。
 *
 * `body` / `closedReason` は自由文（`z.string()`、長さ・空白の制約なし）で、
 * 空白を持たない長い一続きの文字列が来ても吹き出さないよう `break-words` を
 * 持つ必要がある。`body` は既に `whitespace-pre-wrap` を持っていたが
 * `break-words` が無く、`closedReason` はクラス自体が無かった。
 *
 * **⚠️ これは「はみ出しが直った」ことの試験ではない。** jsdom はレイアウトを
 * 持たないので、固定できるのは「そのクラス名が書かれていること」までである。
 * それでも置くのは、戻す変更（`break-words` を消す）を黙って通さないため。
 */
describe('折り返しの付け忘れ（本2）', () => {
  it('未了の本文（body）に break-words が付いている', async () => {
    stubCommitments([commitment({ body: '未了の本文' })]);
    renderPage();

    const body = await screen.findByText('未了の本文');
    const tokens = body.className.split(/\s+/);
    expect(tokens).toContain('break-words');
    expect(tokens).toContain('whitespace-pre-wrap');
  });

  it('片付いた行の本文（body）にも break-words が付いている', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-1',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '理由の本文',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    const body = await screen.findByText('片付いた本文');
    expect(body.className.split(/\s+/)).toContain('break-words');
  });

  it('closedReason に break-words が付いている', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-1',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '理由の本文',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    // `closedReason` は「どう片付いたか」という見出しラベルの隣に素のテキストで
    // 置かれているので、ラベル側から `<p>` 本体（クラスの持ち主）を辿る。
    const label = await screen.findByText('どう片付いたか');
    const wrapper = label.closest('p');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className.split(/\s+/)).toContain('break-words');
  });
});

/**
 * 本文を `origin`（誰が書いたか）で Markdown / 素のテキストへ切り分ける
 * （`commitments.tsx` の `CommitmentBody`）。
 *
 * **Markdown の中身の正しさはここの仕事ではない** — それは
 * `apps/web/app/components/markdown.test.tsx` が持つ。ここが押さえるのは
 * 「その欄が Markdown の描画経路を通るか／通らないか」だけである。だから
 * `## 見出し` を混ぜて `findByRole('heading')` / `queryByRole('heading')` で
 * 拾う形にしている（`approvals.test.tsx` の「クローンが書いた文だけを
 * Markdown で描く」と同じ流儀）。
 */
describe('本文を origin で Markdown / 素のテキストへ切り分ける', () => {
  it('起点が自分（self）の本文は Markdown の描画経路を通る', async () => {
    stubCommitments([commitment({ origin: 'self', body: '## 引き受けた見出し\n\nこれは本文' })]);
    renderPage();

    expect(await screen.findByRole('heading', { name: '引き受けた見出し' })).toBeTruthy();
    expect(screen.getByText('これは本文')).toBeTruthy();
  });

  it('起点がマネージャー（manager）の本文は Markdown の描画経路を通る', async () => {
    stubCommitments([
      commitment({ origin: 'manager', body: '[report] ## 報告の見出し\n\n報告の本文' }),
    ]);
    renderPage();

    expect(await screen.findByRole('heading', { name: '報告の見出し' })).toBeTruthy();
    expect(screen.getByText('報告の本文')).toBeTruthy();
  });

  /**
   * `[report] ` / `[question] ` / `[permission] ` の3つを総当たりで撃つ
   * （`packages/core/src/schema.ts` の `kind` が閉じた3値のため）。
   *
   * 接頭辞は `splitManagerPrefix` が切り出し、専用の `<span>` として素の
   * テキストで描く。Markdown を通っていれば `markdown.tsx` の `<p>`
   * （`mt-2 leading-relaxed first:mt-0`）の中に入るはずなので、そうなって
   * いないことも合わせて確かめる。
   */
  it.each(['report', 'question', 'permission'] as const)(
    'manager の [%s] 接頭辞は素のテキストとして出る（Markdown の描画経路を通らない）',
    async (kind) => {
      stubCommitments([commitment({ origin: 'manager', body: `[${kind}] 完了した` })]);
      renderPage();

      const prefix = await screen.findByText(new RegExp(`\\[${kind}\\]`));
      expect(prefix.tagName).toBe('SPAN');
      expect(prefix.closest('p.mt-2')).toBeNull();
      // report / question / permission という語自体が見出しや強調として
      // 解釈されていない。**この画面には常設の見出し（Card の h2）があるので
      // `queryByRole('heading')` を名前指定なしで使うと誤検出する** — 名前で
      // 絞って確かめる。
      expect(screen.queryByRole('heading', { name: new RegExp(kind) })).toBeNull();
      // **`document` 全体ではなくこの行（`<li>`）の中だけを見る。** 画面の
      // どこか無関係な場所に将来 `strong` / `em` が増えても、この行が
      // 無関係な理由で落ちないようにする。
      const row = prefix.closest('li');
      expect(row).not.toBeNull();
      expect(row!.querySelector('strong, em')).toBeNull();
    },
  );

  /**
   * **⭐ 人間の指示で名指しされた歯。** 「AIが書いたものはマークダウンで
   * 表示する」の裏返しとして、人間が書いた本文は化けさせない
   * （`apps/web/app/routes/chat.tsx:710` と同じ線）。
   */
  it('起点が人間（human）の本文は Markdown の描画経路を通らない', async () => {
    stubCommitments([commitment({ origin: 'human', body: '## これは見出しではない' })]);
    renderPage();

    const body = await screen.findByText('## これは見出しではない');
    expect(screen.queryByRole('heading', { name: 'これは見出しではない' })).toBeNull();
    expect(body.textContent).toContain('## これは見出しではない');
  });

  it('起点が外部（external）の本文も Markdown の描画経路を通らない', async () => {
    stubCommitments([commitment({ origin: 'external', body: '## これも見出しではない' })]);
    renderPage();

    const body = await screen.findByText('## これも見出しではない');
    // この画面には常設の見出し（Card の h2）があるので、名前で絞って確かめる。
    expect(screen.queryByRole('heading', { name: 'これも見出しではない' })).toBeNull();
    expect(body.textContent).toContain('## これも見出しではない');
  });

  it('起点が人間（human）の本文は whitespace-pre-wrap と break-words を持つ', async () => {
    stubCommitments([commitment({ origin: 'human', body: '素のままの本文' })]);
    renderPage();

    const body = await screen.findByText('素のままの本文');
    const tokens = body.className.split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
    expect(tokens).toContain('break-words');
  });

  it('起点が自分（self）の本文も break-words を持つ要素の内側にある', async () => {
    stubCommitments([commitment({ origin: 'self', body: 'クローンが書いた本文' })]);
    renderPage();

    // `<Markdown>` は自前で `break-words` をルート（`<div>`）に持つので、
    // テキストを持つ要素そのものではなく祖先を辿る
    // （`approvals.test.tsx` の `question.closest('.break-words')` と同じ流儀）。
    const body = await screen.findByText('クローンが書いた本文');
    expect(body.closest('.break-words')).not.toBeNull();
  });

  it('片付いた行（ClosedRow）でも origin による分岐が同じように効く', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-self',
          origin: 'self',
          body: '## 片付けた見出し',
          closedAt: new Date().toISOString(),
        }),
        commitment({
          id: 'closed-human',
          origin: 'human',
          body: '## 見出しではない',
          closedAt: new Date().toISOString(),
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    // self: Markdown の描画経路を通る。
    expect(await screen.findByRole('heading', { name: '片付けた見出し' })).toBeTruthy();
    // human: 通らない（`##` が素のテキストのまま見える）。
    expect(screen.getByText('## 見出しではない')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '見出しではない' })).toBeNull();
  });

  /**
   * `closedReason` の据え置き（書き手が型に記録されていないための防御）を
   * 固定する。issue #286。
   *
   * **issue #286 で `closedBy` が型に入ったため、期待値を反転した。** 元々は
   * 「書き手を判別する材料が無いので、`closedReason` は origin を問わず
   * 常に素のテキストのまま」だった。いまは `commitment.closedBy` に応じて
   * 分かれる（`ClosedReasonBody`、`apps/web/app/routes/commitments.tsx`）。
   * このテストのシナリオ（`closedBy: 'clone'`）は Markdown の描画経路を
   * 通るようになったので、期待値をそちらへ反転した — `closedBy` が
   * 無い（`undefined`）ケースは下の別テストが据え置きのまま固定している。
   */
  it('closedReason は closedBy が clone のとき Markdown の描画経路を通る', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-1',
          origin: 'self',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '## 理由の見出し',
          closedBy: 'clone',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    await screen.findByText('片付いた本文');
    expect(await screen.findByRole('heading', { name: '理由の見出し' })).toBeTruthy();
    expect(screen.queryByText('## 理由の見出し')).toBeNull();
  });

  /**
   * `closedBy` が無い行（この欄が導入される前の行、issue #286）は、
   * 「そもそも無い」を「既定」へ倒さず素のテキストのままである。
   */
  it('closedReason は closedBy が無いとき（導入前の行）素のテキストのまま', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-legacy',
          origin: 'self',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '## 理由の見出しではない',
          // closedBy は書かない（導入前の行を模す）
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    await screen.findByText('片付いた本文');
    expect(screen.getByText('## 理由の見出しではない')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '理由の見出しではない' })).toBeNull();
  });

  /**
   * `closedBy: 'human'` は素のテキストのまま（`chat.tsx:710` と同じ線 —
   * 人間が打った文字を化けさせない）。`whitespace-pre-wrap` も保つ。
   */
  it('closedReason は closedBy が human のとき素のテキストのまま（whitespace-pre-wrap を保つ）', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-human',
          origin: 'self',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '## 理由の見出しではない',
          closedBy: 'human',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    await screen.findByText('片付いた本文');
    const reason = screen.getByText('## 理由の見出しではない');
    expect(screen.queryByRole('heading', { name: '理由の見出しではない' })).toBeNull();
    const p = reason.closest('p');
    expect(p).not.toBeNull();
    const tokens = (p?.className ?? '').split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
  });

  /**
   * **実行時の網羅性の倒れ先（`closedBy` 版）を固定する歯。** `undefined`
   * とは別扱いにする — `undefined` は warn しないが、未知の値は warn する
   * （`ClosedReasonBody` の doc）。ここでは「消えずに素のテキストとして
   * 出ること」だけを固定する（`console.warn` 自体は vitest の既定
   * reporter が通ったテストの出力を横取りするため、ここでは検証しない
   * — `AGENTS.md`「静かに失敗する道具」）。
   */
  it('closedReason は schema に無い closedBy が来ても、消さず素のテキストとして出す', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-unknown',
          origin: 'self',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '## 理由の見出しではない',
          closedBy: 'manager',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    await screen.findByText('片付いた本文');
    expect(screen.getByText('## 理由の見出しではない')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '理由の見出しではない' })).toBeNull();
  });

  /**
   * **実行時の網羅性の倒れ先を固定する歯。**
   *
   * `commitmentOriginSchema`（`packages/core/src/schema.ts:892`）に無い値が
   * 来ることは、ビルド時には起こらない（`pnpm typecheck` が塞ぐ。
   * `CommitmentBody` の `switch` の `default` に置いた
   * `const unhandled: never = commitment.origin;` が、その塞ぎ方の実体である
   * — 変異試験で確認済み: `schema.ts` の enum に `'probe'` を一時的に足すと、
   * この行が `Type '"probe"' is not assignable to type 'never'.` で
   * `pnpm typecheck` を落とした）。
   *
   * **ただし実行時はビルド時の型を追い越しうる。** デーモンが先に新しい
   * `origin` を返し、この画面（この型定義）がまだ古い、という順序は
   * ありうる。型はビルド時にしか効かないので、その順序で来た値を
   * `switch` が「どの `case` にも一致しない」まま実行時まで運んでしまう
   * ことがある——ここで固定するのはその倒れ先である。**空白にせず、
   * 素のテキストとして本文をそのまま出す。**
   */
  it('schema に無い origin が来ても、本文を消さず素のテキストとして出す（実行時の倒れ先）', async () => {
    stubCommitments([
      commitment({ origin: 'probe' as CommitmentOrigin, body: '未知の起点からの本文' }),
    ]);
    renderPage();

    const body = await screen.findByText('未知の起点からの本文');
    // Markdown の描画経路は通っていない（素のテキストの `<p>` のまま）。
    expect(body.tagName).toBe('P');
    const tokens = body.className.split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
    expect(tokens).toContain('break-words');
  });
});
