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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
   * **保持上限を超えて物理削除された片付き行の断り（issue #416）。**
   *
   * fs 実装は `CLOSED_HISTORY_LIMIT` を超えた古い片付き行を物理削除する
   * （`packages/storage-fs/src/commitments.ts`）。「器は行を消さない」は契約で
   * あって全実装が守れているわけではないので、破られた事実が人間から見えないと
   * 上のテスト（「片付けたものは…」）が固定している前提そのものが嘘になる。
   */
  it('保持上限を超えて物理削除された片付き行があれば、一覧の上に断りが出る', async () => {
    stubFetch((url) => {
      if (!url.includes('/commitments')) return undefined;
      return json({ entries: [commitment()], unreadable: [], trimmedClosed: 3 });
    });
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.getByText(/保持上限を超えて物理削除された片付き行が累計 3 件ある/)).toBeTruthy();
  });

  /**
   * **読めない行の id 列挙にも上限が要る（#409）。** 台帳の破損の度合いに
   * 比例して伸びる列挙で、`packages/core/src/tools.ts` の `commitment_list`
   * に在った同じ形の穴の画面側。大量の読めない行があっても、id の列挙が
   * 上限で締まり省略の合図が出ることを固定する。
   */
  it('読めない行が大量でも、id の列挙は上限で締まり省略の合図を出す', async () => {
    const count = 60;
    stubFetch((url) => {
      if (!url.includes('/commitments')) return undefined;
      return json({
        entries: [commitment()],
        unreadable: Array.from({ length: count }, (_, index) => ({
          id: `c-broken-${index}`,
          at: new Date().toISOString(),
          reason: '型が合わない',
        })),
        trimmedClosed: 0,
      });
    });
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.getByText(new RegExp(`読めない行が ${count} 件ある`))).toBeTruthy();
    expect(screen.getByText(/c-broken-0/)).toBeTruthy();
    expect(screen.queryByText(/c-broken-59/)).toBeNull();
    expect(screen.getByText(/…ほか \d+ 件は省略/)).toBeTruthy();
  });

  it('物理削除が0件なら断りを出さない', async () => {
    stubCommitments([commitment()]);
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.queryByText(/物理削除された/)).toBeNull();
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
   * **⭐ issue #287 で名指しされた歯。** 人間が `manager_stop` /
   * `DELETE /managers/:id` の停止理由へ自由記述で `*` や `#` を打った回
   * （`packages/core/src/manager.ts:1333`）が化けないことを固定する。
   * `bodyMarkup === 'none'` は `commitmentFor`（`packages/core/src/clone.ts`）
   * が `manager_message.markup` をそのまま持ち越した印である。
   */
  it("manager の本文は bodyMarkup === 'none' のとき、* を含んでいても強調に化けない（人間の停止理由が化ける回帰）", async () => {
    stubCommitments([
      commitment({
        origin: 'manager',
        body: '[report] *思いつきで* 止めた',
        bodyMarkup: 'none',
      }),
    ]);
    renderPage();

    const body = await screen.findByText('*思いつきで* 止めた');
    // Markdown を通っていれば `*…*` は <em> になる。通っていないことを確かめる。
    expect(body.textContent).toBe('*思いつきで* 止めた');
    const row = body.closest('li');
    expect(row).not.toBeNull();
    expect(row!.querySelector('strong, em')).toBeNull();
    // `PlainBody` と同じ形（改行を潰さない）を保っている。
    const tokens = body.className.split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
  });

  /**
   * `bodyMarkup === undefined`（印を立てていない回）は今日と同じく
   * Markdown の描画経路を通る。**「印が無い＝安全」の推論ではなく、いまの
   * 既定を変えないという方針の結果である**（`textMarkupSchema` の doc）。
   */
  it('manager の本文は bodyMarkup が無いとき、今日どおり Markdown の描画経路を通る', async () => {
    stubCommitments([commitment({ origin: 'manager', body: '[report] *強調される* はず' })]);
    renderPage();

    const em = await screen.findByText('強調される');
    expect(em.tagName).toBe('EM');
  });

  /**
   * **実行時の網羅性の倒れ先（`bodyMarkup` 版）を固定する歯。**
   * `textMarkupSchema`（`packages/core/src/schema.ts`）に無い値が来ても、
   * 空白にせず安全側（素のテキスト）へ倒し、本文を1文字も消さない
   * （`ManagerRestBody` の doc）。
   */
  it('manager の本文は schema に無い bodyMarkup が来ても、消さず素のテキストとして出す', async () => {
    stubCommitments([
      commitment({
        origin: 'manager',
        body: '[report] ## 未知の記法の本文',
        bodyMarkup: 'html',
      }),
    ]);
    renderPage();

    const body = await screen.findByText('## 未知の記法の本文');
    expect(screen.queryByRole('heading', { name: '未知の記法の本文' })).toBeNull();
    const tokens = body.className.split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
  });

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

/**
 * 本文の編集（`origin: 'human'` かつ未了の行だけ）。
 *
 * サーバ側（`PATCH /commitments/:id`）は前段のコミットで既に入っている——
 * ここで固定するのは画面側の線引きとタブの形である（`memory-detail.tsx`
 * に揃えた形。`commitments.tsx` の `CommitmentBodyEditor` の doc）。
 *
 * 1. 編集の入口が出るのは `origin: 'human'` かつ未了の行だけ
 *    （それ以外は 403 で断られるだけの死んだボタンになるため）
 * 2. 既定タブはプレビューで、中身は Markdown へ倒さない（`CommitmentBody` の
 *    描き分けをそのまま守る——編集できることが描き分けを変える理由にはならない）
 * 3. 下書きはタブの外に置くので、往復しても消えない
 * 4. 保存は正しい id と本文で PATCH を叩き、失敗（409 等）は握り潰さず見せる
 * 5. `editedAt` が在る行には「編集済み」の印が出る
 */
describe('本文の編集（origin: human かつ未了）', () => {
  it('origin が human の未了行には「本文を編集」の入口が出る', async () => {
    stubCommitments([commitment({ origin: 'human' })]);
    renderPage();

    await screen.findByText('ドキュメントの誤りを直す');
    expect(screen.getByRole('button', { name: '本文を編集' })).toBeTruthy();
  });

  it.each(['self', 'manager', 'external'] as const)(
    'origin が %s の行には編集の入口が出ない（403 で断られるだけの死んだボタンにしない）',
    async (origin) => {
      stubCommitments([commitment({ origin, body: `${origin} の本文` })]);
      renderPage();

      await screen.findByText(`${origin} の本文`);
      expect(screen.queryByRole('button', { name: '本文を編集' })).toBeNull();
    },
  );

  it('片付いた行には origin が human でも編集の入口が出ない', async () => {
    stubCommitments(
      [commitment({ id: 'open-1', body: 'まだ終わっていない' })],
      [
        commitment({
          id: 'closed-1',
          origin: 'human',
          body: '片付いた本文',
          closedAt: new Date().toISOString(),
          closedReason: '直した',
        }),
      ],
    );
    renderPage();

    await screen.findByText('まだ終わっていない');
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    await screen.findByText('片付いた本文');
    // 未了の human 行の分（open-1）だけ在り、片付いた human 行（closed-1）には無い。
    expect(screen.getAllByRole('button', { name: '本文を編集' })).toHaveLength(1);
  });

  it('編集を開くと既定タブはプレビューで、中身が素テキストのまま出る（Markdown へ倒さない）', async () => {
    stubCommitments([commitment({ origin: 'human', body: '## 見出しではない' })]);
    renderPage();

    await screen.findByText('## 見出しではない');
    fireEvent.click(screen.getByRole('button', { name: '本文を編集' }));

    const previewTab = await screen.findByRole('tab', { name: 'プレビュー' });
    expect(previewTab.getAttribute('aria-selected')).toBe('true');
    // `##` が見出しとして解釈されず、リテラルのまま素テキストで出ている。
    expect(screen.getByText('## 見出しではない')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '見出しではない' })).toBeNull();
    /**
     * **編集タブの textarea はまだ選んでいないので出ていない。**
     *
     * `screen.queryByRole('textbox')` を素で呼ぶと、この行の `Input`
     * （片付ける理由）や `PushForm` の `Input`（積む本文）まで拾って
     * 「複数一致」で例外になる——`<input>`（type 未指定）も `<textarea>` も
     * 暗黙の role は同じ `textbox` である。**Tabs.Root の中だけを見る**
     * ことで、無関係な `Input` を数えない。
     */
    const tabsRoot = screen.getByRole('tablist').parentElement!;
    expect(within(tabsRoot).queryByRole('textbox')).toBeNull();
  });

  it('⭐ タブを往復しても下書きが消えない', async () => {
    stubCommitments([commitment({ origin: 'human', body: 'もとの本文' })]);
    renderPage();

    await screen.findByText('もとの本文');
    fireEvent.click(screen.getByRole('button', { name: '本文を編集' }));
    // 無関係な `Input`（片付ける理由・積む本文）と役割が同じ（`textbox`）
    // なので、textarea は Tabs.Root の中だけを見て取る（上のテストと同じ理由）。
    const tabsRoot = screen.getByRole('tablist').parentElement!;

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = (await within(tabsRoot).findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '書きかけの本文' } });

    // プレビューへ切り替える → 書きかけがそのまま（素のテキストで）映る。
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'プレビュー' }));
    expect(await screen.findByText('書きかけの本文')).toBeTruthy();

    // 編集へ戻る → 入力した文字列がそのまま残っている（消えていない）。
    fireEvent.mouseDown(screen.getByRole('tab', { name: '編集' }));
    const textareaAgain = (await within(tabsRoot).findByRole('textbox')) as HTMLTextAreaElement;
    expect(textareaAgain.value).toBe('書きかけの本文');
  });

  it('保存すると、正しい id と本文で PATCH /commitments/{id} が呼ばれる', async () => {
    /**
     * 共有の `stubFetch` は URL しか見ないので、method で GET（一覧）と
     * PATCH（編集）を区別できない（`memory-detail.test.tsx` の保存試験と
     * 同じ注記）。ここでは Request 本体から method と本文を読み直す。
     */
    let patchCalled = false;
    let patchBody: unknown;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { url, method } = request;
      if (method === 'PATCH' && url.includes('/commitments/cmt-42')) {
        patchCalled = true;
        patchBody = await request.json();
        return json({ ok: true });
      }
      if (url.includes('/commitments')) {
        return json({
          entries: [commitment({ id: 'cmt-42', origin: 'human', body: 'もとの依頼' })],
        });
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;
    renderPage();

    await screen.findByText('もとの依頼');
    fireEvent.click(screen.getByRole('button', { name: '本文を編集' }));
    // Tabs.Root の中だけを見て取る（無関係な `Input` と role が衝突するため。
    // 上の「編集を開くと既定タブは…」テストの注記と同じ理由）。
    const tabsRoot = screen.getByRole('tablist').parentElement!;
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await within(tabsRoot).findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '直した依頼' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(patchCalled).toBe(true));
    expect(patchBody).toEqual({ body: '直した依頼' });
  });

  /**
   * **保存の失敗を握り潰さない。** 409（その間に片付けられた）・403・404 は
   * `useEditCommitment` が `expectOk` で必ず投げるので、`ErrorNote` が
   * 出ることを固定する（`OpenRow` の閉じる操作の失敗表示と同じ形）。
   */
  it('保存が 409（その間に片付けられた）で返ると、人間に見える形でエラーが出る', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { url, method } = request;
      if (method === 'PATCH' && url.includes('/commitments/cmt-42')) {
        return json(
          { error: 'cmt-42 は既に 2026-08-26T00:00:00.000Z に片付いている（直した）' },
          409,
        );
      }
      if (url.includes('/commitments')) {
        return json({
          entries: [commitment({ id: 'cmt-42', origin: 'human', body: 'もとの依頼' })],
        });
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;
    renderPage();

    await screen.findByText('もとの依頼');
    fireEvent.click(screen.getByRole('button', { name: '本文を編集' }));
    // Tabs.Root の中だけを見て取る（無関係な `Input` と role が衝突するため。
    // 上の「編集を開くと既定タブは…」テストの注記と同じ理由）。
    const tabsRoot = screen.getByRole('tablist').parentElement!;
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    const textarea = await within(tabsRoot).findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '直した依頼' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(await screen.findByText(/既に.*に片付いている/)).toBeTruthy();
  });

  it('editedAt が在る行に「編集済み」の印が出る', async () => {
    stubCommitments([
      commitment({
        origin: 'human',
        body: '直した後の本文',
        editedAt: '2026-08-26T00:00:00.000Z',
      }),
    ]);
    renderPage();

    await screen.findByText('直した後の本文');
    expect(screen.getByText(/編集済み/)).toBeTruthy();
  });

  it('editedAt が無い行には「編集済み」の印が出ない（一度も編集していない）', async () => {
    stubCommitments([commitment({ origin: 'human', body: '編集していない本文' })]);
    renderPage();

    await screen.findByText('編集していない本文');
    expect(screen.queryByText(/編集済み/)).toBeNull();
  });
});
