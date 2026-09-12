import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  ALWAYS_REDELIVER,
  DAEMON_RUNNER_REGISTRY_SOURCE,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  createClone,
} from './clone.js';
import type { RedeliveryGate } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores, failingInboxPut, humanMessage } from './testing.js';

/**
 * 未読の受信箱が、プロセスの死を跨いで残るか（欠陥: 受信箱が完全にインメモリで、
 * デーモンが死ぬと未読が消える）。
 *
 * **`inbox.test.ts` は `Inbox` そのものの単体テストで、「プロセスが死んだとき
 * どうなるか」を1本も持っていない。ここがその主題である。** 器の死は
 * 「`Clone` を止めずに捨てて、同じ `Stores` から作り直す」で再現する — 実際に
 * 起きるのはそれ（記憶ストアは生き残り、デーモンだけが入れ替わる）だからで、
 * ここを `stop()` で代用すると**片付けの経路しか通らず、肝心の「終える前に
 * 消える」が再現できない**。
 */

interface Fake {
  fn: typeof sdkQuery;
  /** SDK へ渡った本文（＝クローンが実際に読んだプロンプト）。 */
  inputs: string[];
}

/**
 * SDK の代わり。`hang` を渡すと**入力を受け取ったきり結果を返さない** —
 * 「ターンの途中で器ごと落ちた」を、待っている状態のまま作るためのもの。
 */
function fakeSdk(behavior: 'reply' | 'hang' = 'reply'): Fake {
  const inputs: string[] = [];
  // 解かない約束。タイマーを持たないので、これでテストの終了が遅れることはない。
  const forever = new Promise<void>(() => undefined);

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        if (behavior === 'hang') await forever;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, inputs };
}

function bootClone(
  stores: Stores,
  behavior: 'reply' | 'hang' = 'reply',
  // **省略した呼び出し元（この下の既存の歯すべて）は、この引数を足す前と
  // 1文字も変わらない。** `CloneOptions.redeliveryGate` 自体は必須になった
  // （2026-09-12）ので、省略時はここで名前付きの既定 `ALWAYS_REDELIVER` を
  // 渡す——「渡さなければ全件配られる」という既存の挙動は、`bootClone` の
  // この既定を通じて保たれる（`redeliveryGate` 歯、後述の describe）。
  redeliveryGate: RedeliveryGate = ALWAYS_REDELIVER,
): Fake & { clone: CloneHost } {
  const fake = fakeSdk(behavior);
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    // 委譲先も偽物にしておく（誤って本物の SDK を起こさない）。
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    redeliveryGate,
  });
  return { ...fake, clone };
}

/**
 * 汎用の `external` 合図（`apps/daemon/src/index.ts` が実際に post する形と
 * 同じ——`type: 'external'`）。`redeliveryGate` は型と文脈だけで判定するので、
 * `source` の具体の値は何でもよい。
 *
 * **⚠️ Issue #852 より前は `source: 'token-pool'` を使っていた。** 当時の
 * doc は「`source` の具体の値は `packages/core` には無い概念なので、ここでは
 * 自分の文字列を使う」と書いていたが、#852 で `commitmentFor`
 * （`clone.ts`）がまさにこの文字列を特別扱いするようになった
 * （`isDaemonSelfNotice`）——このヘルパはただの汎用フィクスチャのつもりで
 * 予約語を使っていたため、`redeliveryGate` の歯（本ファイル）のうち台帳が
 * 開くことを前提にしていたものが赤くなった。**予約語と衝突しない値へ
 * 変えてある。**
 */
function externalNotice(
  payload: string,
  id = 'evt-ext',
  at = '2026-08-01T00:00:00.000Z',
): InboxEvent {
  return { type: 'external', id, at, source: 'redelivery-gate-probe', payload };
}

/** マネージャーの報告 = 実測で消えていたもの。 */
function report(text: string, id = 'evt-report'): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: new Date(0).toISOString(),
    managerId: 'mgr-1',
    kind: 'report',
    text,
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > 3000) throw new Error(`${label} が起きない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 受信箱のループが動き出し、次の合図を待っている状態にする。 */
async function idle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('未読の永続化', () => {
  it('クローンが暇なときに届いた合図も器に残る（queue を通らない経路）', async () => {
    const stores = createMemoryStores();
    const { clone, inputs } = bootClone(stores, 'hang');
    // ここが要点。**受信箱が空でループが待っている**とき、`Inbox#push` は
    // `#waiters` へ直接渡すので合図は `#queue` を一度も通らない。「落ちる前に
    // queue を吐き出す」形の永続化は、この経路を1件も救わない。
    await idle();

    clone.post(report('PR #99 をマージした'));
    await waitFor(() => inputs.length > 0, '合図が処理に入る');

    const pending = await stores.inbox.claimPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.event.id).toBe('evt-report');
    // 本文まで残っていること。抜粋では拾い直せない。
    expect((pending[0]?.event as { text: string }).text).toBe('PR #99 をマージした');
  });

  it('処理を終えたら器から消える（再起動のたびに処理済みを配り直さない）', async () => {
    const stores = createMemoryStores();
    const { clone, inputs } = bootClone(stores);

    clone.post(report('終わった'));
    await waitFor(() => inputs.length > 0, '合図が処理に入る');
    // `stop()` は片付けの蒸留を受信箱へ積んでその完了を待つので、先に積んだ報告の
    // 処理（＝消し込みまで）が終わっていることの保証になる。
    await clone.stop();

    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  it('終える前に器が落ちたら、次の起動で配り直される（本文ごと）', async () => {
    const stores = createMemoryStores();

    // 1つ目の器。報告を受け取ったところで死ぬ（stop を呼ばない＝片付けを通らない）。
    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('作業者が3本走っている。判断を仰ぎたい'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');

    // 2つ目の器。記憶ストアだけが生き残っている。
    const reborn = bootClone(stores);
    await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

    const prompt = reborn.inputs[0] ?? '';
    expect(prompt).toContain('作業者が3本走っている。判断を仰ぎたい');
    // 起点ごとのプロンプト（ここではマネージャーからの報告）はそのまま生きている。
    expect(prompt).toContain('マネージャー mgr-1 から届いた');

    await reborn.clone.stop();
  });

  it('配り直しだと分かる形で届く（二度目だと分からないのは受け入れない）', async () => {
    const stores = createMemoryStores();

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('同じ報告'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');

    const reborn = bootClone(stores);
    await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

    const prompt = reborn.inputs[0] ?? '';
    // 本文より先に断り書きが来ること。読む側が本文へ入る前に「前に見たかもしれない」
    // と分かる位置に無いと、二度応答してからでは遅い。
    expect(prompt).toContain('配り直し');
    expect(prompt).toContain('1 回目の配達');
    expect(prompt.indexOf('配り直し')).toBeLessThan(prompt.indexOf('同じ報告'));

    // 人間が後から「なぜ二度来たのか」を追えること。
    const journal = await stores.journal.list({ types: ['exchange'] });
    expect(
      journal.some(
        (entry) =>
          entry.type === 'exchange' && entry.text.includes('未読のまま残っていた合図を配り直した'),
      ),
    ).toBe(true);

    await reborn.clone.stop();
  });

  it('配り直すたびに回数が上がる（毎回落ちているなら、それが見える）', async () => {
    const stores = createMemoryStores();

    const first = bootClone(stores, 'hang');
    await idle();
    first.clone.post(report('処理するたびに器が落ちる合図'));
    await waitFor(() => first.inputs.length > 0, '合図が処理に入る');

    const second = bootClone(stores, 'hang');
    await waitFor(() => second.inputs.length > 0, '1 回目の配り直し');
    expect(second.inputs[0] ?? '').toContain('1 回目の配達');

    const third = bootClone(stores);
    await waitFor(() => third.inputs.length > 0, '2 回目の配り直し');
    const prompt = third.inputs[0] ?? '';
    expect(prompt).toContain('2 回目の配達');
    // 回数が2以上なら、同じやり方をなぞる前に理由を見るよう促す。
    expect(prompt).toContain('2 回以上配り直している');

    await third.clone.stop();
  });

  /**
   * **(α)「積み直された回数」と (β)「処理を始めて終わらなかった回数」を、
   * 断り書きが取り違えないこと。**
   *
   * `claimPending()` は残っている未読の**全行**の回数を1つ進めるので、**待ち行列に
   * 居ただけで一度も処理されていない合図も、回数が同じだけ上がる。** 直上の歯
   * （`配り直すたびに回数が上がる`）は**未読が1件だけ**のフィクスチャなので、この2つを
   * 区別できない —— 1件しか無ければ「居合わせた合図」が存在しないためである。
   *
   * **ここは同じ回数（2 回目）を、未読が複数在る状態で作る。** 回数は直上の歯と
   * 1つも変わらないのに、**言えることだけが変わる**。
   *
   * 実測（2026-09-08）: 未読 104 件が溜まった器で「4 回目の配達」と名乗る合図が届き、
   * クローンは断り書きに従って「なぜ落ちたか」をターンを使って調べた。**答えは
   * 「この合図は一度も処理されていなかった」だった。**
   *
   * **⚠️ issue #783 で期待値を反転した。** 以前は `#mergeable` が配り直し
   * （`#redelivered`）を無条件で外していたので、2回目の配り直しでも evt-a は
   * 必ず単独のターンで処理され、この歯は「1件の断り書き」の文言（「2 回目の
   * 配達」）を直接見ていた。**いまは配り直しも束ねる対象になった**（同じ
   * `managerId` の連続する `report`。`#mergeable` の doc）ので、2回目の配り直し
   * では evt-a が隣接する evt-b と1つの束に入る（`#drainMergeableWithinLimit`
   * の実測: 束 2 件・evt-c は束に入らず次の反復に残る）。**言いたかったこと
   * （回数を「この合図で落ちた」根拠にしない）は変わっていない** —— 束の行
   * （`#redeliveryNoticeFor`）も同じ文言（「この回数は『器が入れ替わった回数』
   * であって、この合図の処理が落ちた回数ではない」）を持つので、下のアサーション
   * はその文言を束の行から見ている。
   */
  it('未読が複数あるときは、回数を「この合図で落ちた」の根拠にしない（(α) と (β) を分ける）', async () => {
    const stores = createMemoryStores();

    // **3件積む。** 先頭だけが処理に入り（`hang`）、残り2件は待ち行列に居るだけで
    // 一度も処理されない —— それでも回数は3件とも同じだけ上がる。
    const first = bootClone(stores, 'hang');
    await idle();
    first.clone.post(report('先頭の合図', 'evt-a'));
    first.clone.post(report('居合わせただけの合図 1', 'evt-b'));
    first.clone.post(report('居合わせただけの合図 2', 'evt-c'));
    await waitFor(() => first.inputs.length > 0, '先頭が処理に入る');

    const second = bootClone(stores, 'hang');
    await waitFor(() => second.inputs.length > 0, '1 回目の配り直し');

    const third = bootClone(stores);
    await waitFor(() => third.inputs.length > 0, '2 回目の配り直し');
    const prompt = third.inputs[0] ?? '';

    // **かつての期待値（issue #783 の前）はここ**（1件ごとの断り書きを見ていた）:
    //   expect(prompt).toContain('2 回目の配達');
    //   expect(prompt).not.toContain('2 回以上配り直している');
    // **いまは evt-a が evt-b と束になって届くので、束の行の文言を見る。**
    // 配達回数の最大値（束の中の最大。evt-a・evt-b ともに2回目なので2）。
    expect(prompt).toContain('最大 2 回の配達');
    // **一緒に拾い直した件数を名乗る。** これが「回数が何を測っているか」の材料。
    expect(prompt).toContain('3 件');
    // **⭐ ここが直上の歯との違い。** 同じ「2 回目」でも、未読が複数あるときは
    // この合図について語れない —— 毒の証拠として名乗ってはいけない。
    expect(prompt).not.toContain('2 回以上配り直している');
    expect(prompt).toContain('この合図の処理が落ちた回数ではない');

    await third.clone.stop();
  });

  it('未読が1件だけなら、日誌の1行は回数をそのまま名乗る（journal_read で読み返す側に余計な修飾を足さない）', async () => {
    const stores = createMemoryStores();

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('たった1件の合図'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');

    const reborn = bootClone(stores);
    await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

    // **先頭の1件で足りる。** `#restoreUnread` は `record` ごとに日誌を書いてから
    // `#inbox.push` するので、`inputs.length > 0` が通った時点で先頭の日誌行は
    // 必ず書かれている——全件を待つ必要はない。
    const journal = await stores.journal.list({ types: ['exchange'] });
    const matches = journal.filter(
      (entry) =>
        entry.type === 'exchange' && entry.text.includes('未読のまま残っていた合図を配り直した'),
    );
    const head = matches[0];
    const line = head && head.type === 'exchange' ? head.text : '';

    // 回数の直後が読点である＝修飾が無い。1件のときは嘘ではないので、直す対象では
    // ない（#700 が渡す側でやったのと同じ判定を、読み返す側にも1件のときは足さない）。
    expect(line).toContain('回目の配達、');
    expect(line).not.toContain('器が入れ替わった回数');

    await reborn.clone.stop();
  });

  /**
   * **#700（c4713c0）はモデルへ渡す側（`#redeliveryNoticeFor`）だけを直した。**
   * クローンが `journal_read` で1日に何十回も逐語に読み返す日誌の側は、修飾なしの
   * まま残っていた——⟹ **渡す側で塞いだ嘘が、読み返す側から入ってくる。**
   *
   * ここは #700 の歯（`未読が複数あるときは、回数を「この合図で落ちた」の根拠に
   * しない`）と同じ状況（未読3件、うち1件だけが処理に入り2件は居合わせただけ）を
   * 作り、**モデルへ渡す本文ではなく日誌の1行**に対して同じ判定を要求する。
   */
  it('未読が複数あるときは、日誌の1行も「器が入れ替わった回数」だと名乗る（#700 が渡す側でやったことを、読み返す側にも及ぼす）', async () => {
    const stores = createMemoryStores();

    const first = bootClone(stores, 'hang');
    await idle();
    first.clone.post(report('先頭の合図', 'evt-a'));
    first.clone.post(report('居合わせただけの合図 1', 'evt-b'));
    first.clone.post(report('居合わせただけの合図 2', 'evt-c'));
    await waitFor(() => first.inputs.length > 0, '先頭が処理に入る');

    const reborn = bootClone(stores);
    await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

    // **先頭の1件で足りる**（理由は直上の歯と同じ）。
    const journal = await stores.journal.list({ types: ['exchange'] });
    const matches = journal.filter(
      (entry) =>
        entry.type === 'exchange' && entry.text.includes('未読のまま残っていた合図を配り直した'),
    );
    const head = matches[0];
    const line = head && head.type === 'exchange' ? head.text : '';

    expect(line).toContain('回目の配達＝器が入れ替わった回数');
    expect(line).toContain('3 件');
    expect(line).toContain('この合図の処理が落ちた回数ではない');

    await reborn.clone.stop();
  });

  it('例外で終わった合図も消える（記録は残っているので、永久に配り直さない）', async () => {
    // `#handle` を確実に落とす。承認の読み出しが失敗すると `human_answer` の
    // 処理は例外で終わり、失敗は `#reportFailure` 経由で日誌に残る。
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      jobs: { ...base.jobs, getApproval: () => Promise.reject(new Error('台帳が壊れている')) },
    };
    const { clone } = bootClone(stores);

    clone.post({
      type: 'human_answer',
      id: 'evt-answer',
      at: new Date(0).toISOString(),
      approvalId: 'apv-1',
      answer: 'よい',
    });

    // 失敗は握り潰されず日誌に残る。**消してよい根拠はここにある。**
    await waitForJournal(stores, '内部ターンが失敗した');

    // 残すと、決定的に失敗する合図が起動のたびに配り直され、そのたびに同じ失敗を
    // 繰り返してクローンのターンを1本ずつ焼く。**残るのはプロセスが死んだときだけ。**
    await waitForNoUnread(stores);
    await clone.stop();
  });

  it('未読を書けなくても post は落ちない。跡は stderr に1行で、本文は出ない', async () => {
    const stores = failingInboxPut(createMemoryStores(), '器が閉じている');
    const secret = 'GH_TOKEN=ghp_000000000000000000000000000000000000';

    const lines = await captureStderr(async () => {
      const { clone, inputs } = bootClone(stores);
      // 未読を書けないことでその合図の処理まで止めない（塞ぐべき穴より広くなる）。
      clone.post(humanMessage(secret));
      await waitFor(() => inputs.length > 0, '合図が処理に入る');
      await clone.stop();
    });

    const trace = lines.filter((line) => line.includes('未読の合図を記録できませんでした'));
    expect(trace).toHaveLength(1);
    expect(trace[0]).toContain('器が閉じている');
    // 本文は出さない（テスト出力に GH_TOKEN が全文で出た前例がある。
    // railway/setup.test.ts の差分アサーション、#52）。
    expect(lines.join('')).not.toContain(secret);
    expect(lines.join('')).not.toContain('ghp_');
    // 長さだけは出す（「空だった」と「書けなかった」の区別が付く）。
    expect(trace[0]).toContain(`chars=${secret.length}`);
  });

  it('消し込みが書き込みを追い越さない（追い越すと永久に配り直される）', async () => {
    const base = createMemoryStores();
    const written: string[] = [];
    // 書き込みが遅い器。`post` は同期で返るので、短いターンなら「終えた」が
    // 「書けた」より先に来る。
    const stores: Stores = {
      ...base,
      inbox: {
        ...base.inbox,
        put: async (event, at) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          await base.inbox.put(event, at);
          written.push(event.id);
        },
      },
    };

    const { clone, inputs } = bootClone(stores);
    clone.post(report('速く終わる報告'));
    await waitFor(() => inputs.length > 0, '合図が処理に入る');
    await clone.stop();

    // **書き込みが器へ落ちるまで待ってから見ること。** ここを待たずに見ると、
    // 追い越しの跡（後から書かれる行）がまだ現れておらず、壊れていても通る。
    await waitFor(() => written.length > 0, '未読の書き込みが終わる');
    // 消し込みが書き込みを待たずに走っていたら、後から書かれた行がここに残る。
    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  it('蒸留は器に置かない（拾い直しても対象のセッションはもう無い）', async () => {
    const stores = createMemoryStores();
    const { clone, inputs } = bootClone(stores);

    clone.post(humanMessage('やあ'));
    await waitFor(() => inputs.length > 0, '発言が処理に入る');
    await clone.endConversation('conv-1');
    await clone.stop();

    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  /**
   * 配り直しで本文が二度載ること自体を固定する。
   *
   * **これは受け入れた側の帰結である。** 消し込みが「終えた時点」なのと同じ取引で、
   * 「消えるより配り直す」を選んだ結果として重複しうる。**回数はこの直しの前と
   * 同じ**（以前も `#handle` が配達のたびに書いていた）。ここを「二度載らないよう
   * 直す」方向へ動かすと、受理の瞬間の追記が器へ届く前に落ちた発言が消える側へ
   * 倒れる。**どちらの向きを選んだかが読めるように、期待値として残す。**
   */
  it('配り直しでは本文が二度載る（消えるより配り直す。回数は直す前と同じ）', async () => {
    const stores = createMemoryStores();

    // 1つ目の器。追記は成功したが、ターンの途中で死ぬ。
    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(humanMessage('MSG-TWICE', 'conv-1'));
    await waitForJournal(stores, 'MSG-TWICE');
    expect(await inboundCount(stores, 'MSG-TWICE')).toBe(1);

    // 2つ目の器。拾い直した配達で、もう一度書かれる。
    const reborn = bootClone(stores);
    await expect.poll(() => inboundCount(stores, 'MSG-TWICE'), { timeout: 3000 }).toBe(2);

    await reborn.clone.stop();
  });

  /**
   * 受理の瞬間に書いた発言の本文が、その追記だけ器へ届かないまま落ちても失われないか。
   *
   * **`post` は同期なので、追記が届いたかどうかは `post` からは分からない。**
   * だから配り直しの側でもう一度書く。書かない側を選ぶと、未読の器には在るのに
   * 日誌にも `GET /conversations` にも無い発言ができる。重複しうる代わりに消えない、
   * という向きを記録でも揃えている（消し込みが「終えた時点」なのと同じ取引）。
   */
  it('配り直しでも発言の本文が日誌に残る（受理の瞬間の追記が落ちていても）', async () => {
    const stores = createMemoryStores();

    await captureStderr(async () => {
      // 1つ目の器。受理の瞬間の追記（＝最初の1本）だけを落として、そのまま死ぬ。
      const dying = bootClone(droppingFirstJournalAppend(stores), 'hang');
      await idle();
      dying.clone.post(humanMessage('MSG-BODY', 'conv-1'));
      await waitFor(() => dying.inputs.length > 0, '発言が処理に入る');
      // 落ちた側は日誌に何も残していない。
      expect(await stores.journal.list({ types: ['exchange'] })).toEqual([]);

      // 2つ目の器。記憶ストアだけが生き残っている。
      const reborn = bootClone(stores);
      await waitForJournal(stores, 'MSG-BODY');
      await reborn.clone.stop();
    });
  });
});

/** 同じ本文の inbound が日誌に何本あるか。 */
async function inboundCount(stores: Stores, text: string): Promise<number> {
  const entries = await stores.journal.list({ types: ['exchange'] });
  return entries.filter(
    (entry) => entry.type === 'exchange' && entry.role === 'inbound' && entry.text === text,
  ).length;
}

/**
 * 追記の1本目だけを落とす（受理の瞬間の追記が器へ届く前に落ちた形）。
 *
 * 全部を落とすと配り直しの側の追記も落ちるので、直したことが見えない。
 */
function droppingFirstJournalAppend(stores: Stores): Stores {
  let first = true;
  return {
    ...stores,
    journal: {
      ...stores.journal,
      append(entry) {
        if (first) {
          first = false;
          return Promise.reject(new Error('器が閉じている'));
        }
        return stores.journal.append(entry);
      },
    },
  };
}

async function waitForJournal(stores: Stores, needle: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const entries = await stores.journal.list({ types: ['exchange'] });
    if (entries.some((entry) => entry.type === 'exchange' && entry.text.includes(needle))) return;
    if (Date.now() - started > 3000) throw new Error(`日誌に「${needle}」が出ない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 未読が空になるまで待つ（消し込みは `#handle` の後に走るので同期では見られない）。 */
async function waitForNoUnread(stores: Stores): Promise<void> {
  const started = Date.now();
  for (;;) {
    if ((await stores.inbox.claimPending()).length === 0) return;
    if (Date.now() - started > 3000) throw new Error('未読が消えない');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 台帳にその id が現れるまで待つ（`#commit` は `post` から見て非同期）。 */
async function waitForCommitment(stores: Stores, id: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if ((await stores.commitments.get(id)) !== null) return;
    if (Date.now() - started > 3000) throw new Error(`台帳に ${id} が現れない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 「クローンが既に片付けたと宣言済みの合図が、再起動後にまた全文で配り直される」
 * という実測の直し（`#restoreUnread` が `stores.commitments` を引く）。
 *
 * ## この歯が固定しているものは、issue #217 の時点から片方だけ変わっている
 *
 * **#217 は「合図は落とさない。ターンも焼く。短くするのは本文だけ」を選び、この
 * describe はその3つをそのままテストにしていた。** いま固定しているのは
 * 「**合図は落とさない**」と「**記録も落とさない**」の2つで、**「ターンも焼く」は
 * 意図的に外してある** —— 台帳が片付け済みだと言っている合図にターン1本を払うのを
 * やめたからである（`clone.ts` の `#foldClosedRedelivery`）。
 *
 * **これは歯を弱めたのではない。** #217 が本文の代わりに配っていた断り書きは、
 * それ自身が「あらためて手を動かす必要は無い」と書いている（`clone.ts` の
 * `closedRedeliveryNotice`）—— その1文を伝えるために、セッションの起動
 * （`#ensureQuery`）とモデルの呼び出しを毎回1回ずつ払っていた。**畳む側の歯は
 * むしろ増えている**: 「ターンを起こさないこと」「型ごとの本文追記が落ちないこと」
 * 「畳んだ跡が対で残ること」「未了なら1文字も変えずに全文でターンを回すこと」
 * 「台帳が読めなければ全文で配ること」を別々に測る。
 *
 * **変えてよいと決めたのは人間である**（2026-09-08 の決裁。逐語「とにかく永続的に
 * トークンが肥大化していくのは避けたい」「それを防ぐために行なう改修(トークンの
 * 内訳を記録するも含め)を許可します」）。
 *
 * `fakeSdk` はツール呼び出しを再現しないので、「クローンが `commitment_close` を
 * 呼んだ」状態は台帳を直接閉じて代用する。
 */
describe('片付け済みの配り直し（ターンを起こさずに畳む）', () => {
  it('既に commitment_close で片付けていたら、ターンを1本も起こさない（本文も断り書きもモデルへ渡らない）', async () => {
    // **最初の1回分の日誌書き込みだけを落とす。** 落とさないと、この検証は
    // 「dying（クローズ前）が書いた全文」で満たせてしまい、「配り直しでも日誌の
    // 書き込みは変えていない」を測ったことにならない（`droppingFirstJournalAppend`
    // と同じ形。修復＝別の書き込みが同じ結論を出してしまう問題）。
    const base = createMemoryStores();
    let droppedFirstManagerExchange = false;
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append(entry) {
          if (
            !droppedFirstManagerExchange &&
            entry.type === 'exchange' &&
            entry.with === 'manager' &&
            entry.role === 'inbound'
          ) {
            droppedFirstManagerExchange = true;
            return Promise.reject(new Error('最初の1回だけ落とす（検証のため）'));
          }
          return base.journal.append(entry);
        },
      },
    };

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('CLOSED-REPORT 本文はこれだけ長くしておく', 'evt-closed'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, 'evt-closed');

    expect(
      await stores.commitments.close(
        'evt-closed',
        '2026-08-02T00:00:00.000Z',
        'もう対応済み',
        'clone',
      ),
    ).toBe(true);

    const reborn = bootClone(stores);
    // **ターンの入力を待つ形にはできない**（起こさないことを測っている）。そして
    // 「畳んだ跡」を待つ形にもしない —— **畳まない側の壊れ方が、待ちの時間切れ
    // （ヘルパの生の throw）として出てしまう**ので、赤の出どころが自分の
    // アサーションでなくなる。**両方の世界で必ず起きること**＝消し込みを待って、
    // `stop()` で受信箱のループを読み切らせる（`stop()` は `#pumpLoop` を await
    // してから返るので、その後は「もう1本も起きない」と言える地点である）。
    await waitForNoUnread(stores);
    await reborn.clone.stop();

    // **ターンは1本も起きていない。** 本文も断り書きもモデルへ渡っていない。
    expect(reborn.inputs).toEqual([]);

    // **記録は1つも減っていない。** dying の1回目は上で落としてあるので、ここに
    // 全文があるのは配り直し（reborn）自身の書き込みでしかありえない —— つまり型
    // ごとの本文追記が、ターンを起こさない経路でも走っている
    // （`#journalIncomingBody`）。
    expect(droppedFirstManagerExchange).toBe(true);
    const journal = await stores.journal.list({ types: ['exchange'] });
    const exchanges = journal.flatMap((entry) => (entry.type === 'exchange' ? [entry] : []));
    expect(
      exchanges.some(
        (entry) =>
          entry.role === 'inbound' &&
          entry.with === 'manager' &&
          entry.text.includes('CLOSED-REPORT 本文はこれだけ長くしておく'),
      ),
    ).toBe(true);

    // **「畳んだ」と「そもそも配られなかった」を区別できる形で残っている。** 配り
    // 直しの1行（`#restoreUnread`）と畳んだ1行（`#foldClosedRedelivery`）が対で
    // 在り、畳んだ側には何を根拠に畳んだのかが全部載っている。
    const folded = exchanges.find((entry) => entry.text.includes('ターンを起こさずに畳んだ'));
    const foldedText = folded?.text ?? '';
    expect(foldedText).toContain('再起動後の配り直しである');
    expect(foldedText).toContain('片付けた時刻');
    expect(foldedText).toContain('2026-08-02T00:00:00.000Z');
    expect(foldedText).toContain('もう対応済み');
    // 全文の取り方（journal_read）が具体的に書いてある（「省略した」だけで終わらない）。
    expect(foldedText).toContain('journal_read');
    // どの合図かも分かる（マネージャー id。`inboxEventShape` を流用）。
    expect(foldedText).toContain('mgr-1');
    expect(
      exchanges.some((entry) => entry.text.includes('未読のまま残っていた合図を配り直した')),
    ).toBe(true);

    // **合図は落とさない。** 消し込みは通常どおり進む（残すと、この1件だけが起動の
    // たびに配り直される）。
    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  it('human_message でも同じくターンを起こさない（配線は起点ごとに分かれているので `manager_message` だけでは足りない）', async () => {
    const stores = createMemoryStores();
    const text = 'CLOSED-HUMAN-MSG 本文はこれだけ長くしておく';
    const event = humanMessage(text);

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(event);
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, event.id);

    expect(
      await stores.commitments.close(event.id, '2026-08-02T00:00:00.000Z', 'もう対応済み', 'clone'),
    ).toBe(true);

    const reborn = bootClone(stores);
    // 待ちの形とその理由は1本目の歯と同じ（消し込みを待つ）。
    await waitForNoUnread(stores);
    await reborn.clone.stop();

    expect(reborn.inputs).toEqual([]);
    // **発言そのものは消えない。** 受理の瞬間の追記（`#record`）が日誌に在り、
    // 配り直しの回でも `#restoreUnread` がもう1度書く。畳むのはターンだけである。
    const journal = await stores.journal.list({ types: ['exchange'] });
    const exchanges = journal.flatMap((entry) => (entry.type === 'exchange' ? [entry] : []));
    expect(exchanges.some((entry) => entry.with === 'human' && entry.text === text)).toBe(true);
    expect(exchanges.some((entry) => entry.text.includes('journal_read'))).toBe(true);
    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  /**
   * **`'human'` で閉じた場合も同じく畳む（ターンを1本も起こさない）。** これが
   * 「畳む挙動は1文字も変えていない」の証拠になる —— `closedBy` の4状態を区別
   * するようにした変更（`closedRedeliveryNotice`）は、畳むかどうかの判定
   * （`#restoreUnread` / `#pump`）には触れていない。先頭の歯（`既に
   * commitment_close で片付けていたら…`）を写し、第4引数だけ `'human'` に
   * 変えてある。
   *
   * 加えて、畳んだ跡の日誌に「人間が既にこの合図を片付けている」が載ること
   * まで見る —— 日誌が「クローンが閉じた」と決め打っていた欠陥（この PR の
   * 主題）の修正が、実際に配り直しの経路まで通っている証拠である。
   */
  it('human で閉じていても同じくターンを1本も起こさず畳み、日誌には「人間が既にこの合図を片付けている」と載る', async () => {
    const stores = createMemoryStores();

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(
      report('CLOSED-BY-HUMAN-REPORT 本文はこれだけ長くしておく', 'evt-closed-human'),
    );
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, 'evt-closed-human');

    expect(
      await stores.commitments.close(
        'evt-closed-human',
        '2026-08-02T00:00:00.000Z',
        '人間が対応済みと判断した',
        'human',
      ),
    ).toBe(true);

    const reborn = bootClone(stores);
    // 待ちの形とその理由は1本目の歯と同じ（消し込みを待つ）。
    await waitForNoUnread(stores);
    await reborn.clone.stop();

    // **ターンは1本も起きていない。** closedBy が 'human' でも畳む挙動は変わらない。
    expect(reborn.inputs).toEqual([]);

    const journal = await stores.journal.list({ types: ['exchange'] });
    const exchanges = journal.flatMap((entry) => (entry.type === 'exchange' ? [entry] : []));
    const folded = exchanges.find((entry) => entry.text.includes('ターンを起こさずに畳んだ'));
    const foldedText = folded?.text ?? '';
    // **「クローンが閉じた」ではなく「人間が閉じた」と正しく書かれている。**
    expect(foldedText).toContain('人間が既にこの合図を片付けている');
    expect(foldedText).toContain('片付けた時刻（POST /commitments/:id/close）');
    expect(foldedText).not.toContain('クローンは既にこの合図を片付けている');
    expect(foldedText).toContain('2026-08-02T00:00:00.000Z');
    expect(foldedText).toContain('人間が対応済みと判断した');

    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  /**
   * **落としやすいのは本文追記の側である。** 畳む枝は `#pump` に在るが、
   * `manager_message` / `external` の本文追記は `#handle` の型ごとの分岐に在った
   * ——素朴に `continue` すると、その追記だけが静かに消える。消えると
   * `retrievalHintFor` が案内している「この型で全文が日誌へ書かれる」が嘘になり、
   * **取り方が分かる体裁のまま実際には取れない**という、依頼者が明示的に禁じた形に
   * なる。
   *
   * **`external` を別に測るのは、この型の追記だけ日誌の型が違うからである**
   * （`exchange` ではなく `external_event`）—— `manager_message` の歯では通らない。
   * そして `manager_message` の歯と同じく、**最初の1回だけ追記を落とす** ——
   * 落とさないと、死ぬ前のクローンが書いた1行でこの検証を満たせてしまう。
   */
  it('external も畳むが、`external_event` の本文追記は落とさない（`journal_read` の案内が空を指さない）', async () => {
    const base = createMemoryStores();
    let droppedFirstExternal = false;
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append(entry) {
          if (!droppedFirstExternal && entry.type === 'external_event') {
            droppedFirstExternal = true;
            return Promise.reject(new Error('最初の1回だけ落とす（検証のため）'));
          }
          return base.journal.append(entry);
        },
      },
    };
    const event: InboxEvent = {
      type: 'external',
      id: 'evt-ext',
      at: '2026-08-01T00:00:00.000Z',
      source: 'github',
      payload: 'CLOSED-EXTERNAL 本文はこれだけ長くしておく',
    };

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(event);
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, event.id);
    expect(
      await stores.commitments.close(event.id, '2026-08-02T00:00:00.000Z', '対応済み', 'clone'),
    ).toBe(true);

    const reborn = bootClone(stores);
    // 待ちの形とその理由は1本目の歯と同じ（消し込みを待つ）。
    await waitForNoUnread(stores);
    await reborn.clone.stop();

    expect(reborn.inputs).toEqual([]);
    expect(droppedFirstExternal).toBe(true);
    const events = await stores.journal.list({ types: ['external_event'] });
    expect(
      events.some(
        (entry) =>
          entry.type === 'external_event' &&
          entry.source === 'github' &&
          entry.summary.includes('CLOSED-EXTERNAL 本文はこれだけ長くしておく'),
      ),
    ).toBe(true);
    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  it('未了（クローンがまだ片付けていない）合図の配り直しは、1文字も変えず全文のままターンへ届く（畳まない）', async () => {
    const stores = createMemoryStores();

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('OPEN-REPORT 本文はこれだけ長くしておく', 'evt-open'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, 'evt-open');
    // 閉じない（未了のまま次の器を起こす）。

    const reborn = bootClone(stores);
    // **待ちの形は畳む側の歯と同じにする**（両方の世界で必ず起きる消し込みを待つ）
    // —— 「入力が来ること」を待つ形にすると、誤って畳んだ壊れ方が**待ちの時間切れ**
    // （ヘルパの生の throw）として出て、赤の出どころが自分のアサーションでなくなる。
    await waitForNoUnread(stores);

    // **数えるのは `stop()` の前である。** `stop()` はセッションが在れば shutdown の
    // 蒸留を投げる（`stop()` の doc）ので、後で数えると2本目が混じる。畳む側の歯が
    // `stop()` の後で数えられるのは、ターンを1本も起こしていない＝セッションが無く、
    // その蒸留自体が起きないからである。
    //
    // **未了はターンへ届く。1本きっかり起きている。**
    expect(reborn.inputs).toHaveLength(1);
    const prompt = reborn.inputs[0] ?? '';
    expect(prompt).toContain('OPEN-REPORT 本文はこれだけ長くしておく');
    // 片付け済み側の断り書きは出ない。
    expect(prompt).not.toContain('クローンは既にこの合図を片付けている');
    // **畳んだ跡は1行も無い。** 「片付け済みなら起こさない」と「未了なら起こす」は
    // 向きが逆の対で、片方だけを落とす変異はこの行でだけ赤くなる。
    const journal = await stores.journal.list({ types: ['exchange'] });
    expect(
      journal.some(
        (entry) => entry.type === 'exchange' && entry.text.includes('ターンを起こさずに畳んだ'),
      ),
    ).toBe(false);

    await reborn.clone.stop();
  });

  it('片付き確認（commitments.get）が失敗しても全文で配る。ターンは落ちない（雑音であって喪失ではない側へ倒す）', async () => {
    const base = createMemoryStores();
    let failNextGet = false;
    const stores: Stores = {
      ...base,
      commitments: {
        ...base.commitments,
        get: (id: string) => {
          if (failNextGet) return Promise.reject(new Error('台帳が読めない'));
          return base.commitments.get(id);
        },
      },
    };

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('THROW-REPORT 本文はこれだけ長くしておく', 'evt-throw'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, 'evt-throw');
    expect(
      await stores.commitments.close('evt-throw', new Date().toISOString(), '片付けた', 'clone'),
    ).toBe(true);

    // 拾い直しの側でだけ読み出しを落とす。
    failNextGet = true;
    const lines = await captureStderr(async () => {
      const reborn = bootClone(stores);
      await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

      const prompt = reborn.inputs[0] ?? '';
      // **閉じているのに、読めなかったので全文のまま届く。** ターンは落ちていない
      // （待てたこと自体が、ターンが最後まで走った証拠である）。
      expect(prompt).toContain('THROW-REPORT 本文はこれだけ長くしておく');

      await reborn.clone.stop();
    });
    expect(lines.some((line) => line.includes('配り直しの片付き確認'))).toBe(true);
  });
});

/**
 * **`redeliveryGate`（Issue #783 続き）: `#restoreUnread` が1件ごとに「いま配る
 * 意味が在るか」を訊く門の歯。** `CloneOptions.redeliveryGate` の doc（`clone.ts`）
 * と `#foldGatedRedelivery` の doc に書いてある約束を、直上の「片付け済みの
 * 配り直し」describe と同じ作法（`stores.inbox.put` で前の器の死を直接作り、
 * 拾い直しを待つ）で固定する。
 *
 * **`#foldClosedRedelivery`（直上の describe）との違い**: あちらは「もう片付いて
 * いる」という永続的な判定なので `#forget` で消してよいが、こちらは「いまは
 * 配る意味が無い」という一時的な判定なので、**受信箱の行も台帳の行も消さない**
 * ——次の起動でまた同じ行を拾い直し、そのときの状態で判定し直す。この違いを
 * 歯1本目（下）で固定する。
 */
describe('redeliveryGate（Issue #783 続き）: `#restoreUnread` の門', () => {
  it('述語が偽を返しても、受信箱の行も台帳の行も消えない（次の起動でまた配り直しの対象になる）', async () => {
    const stores = createMemoryStores();
    const event = externalNotice('GATED-NOTICE 本文はこれだけ長くしておく', 'evt-gated');
    // 前のプロセスが死んで未読のまま残っていた状況を直接作る（#restoreUnread が拾う）。
    await stores.inbox.put(event, event.at);

    const alwaysFold: RedeliveryGate = () => false;
    const { clone, inputs } = bootClone(stores, 'reply', alwaysFold);
    await waitForJournal(stores, 'ターンを起こさずに畳んだ');

    // ターンは1本も起きていない（モデルへ1文字も渡っていない）。
    expect(inputs).toEqual([]);

    // **受信箱の行がまだ残っている。** `peekPending` は配達回数を進めない安全な
    // 覗き見（`claimPending` と違い、数え直しても状態を動かさない——後述の
    // describe「InboxStore.pending」と同じ道具）。
    const remaining = await stores.inbox.peekPending();
    expect(remaining.some((r) => r.event.id === event.id)).toBe(true);

    // **台帳の行も残っている。** `#commit` が開いたまま、閉じてもいない
    // （`#forget` を呼ばない側の畳み込みだからである）。
    await waitForCommitment(stores, event.id);
    const commitment = await stores.commitments.get(event.id);
    expect(commitment).not.toBeNull();
    expect(commitment?.closedAt).toBeUndefined();

    await clone.stop();
  });

  it('畳んだ跡が日誌に残る（型ごとの本文追記と「畳んだ」の1行の両方）', async () => {
    const stores = createMemoryStores();
    const event = externalNotice('GATED-NOTICE-2 本文はこれだけ長くしておく', 'evt-gated-2');
    await stores.inbox.put(event, event.at);

    const alwaysFold: RedeliveryGate = () => false;
    const { clone } = bootClone(stores, 'reply', alwaysFold);
    await waitForJournal(stores, 'ターンを起こさずに畳んだ');

    // 1. **型ごとの本文追記**（`#journalIncomingBody`。external なので
    //    `external_event` へ書かれる——`exchange` ではない）。
    const externalEvents = await stores.journal.list({ types: ['external_event'] });
    expect(
      externalEvents.some(
        (entry) =>
          entry.type === 'external_event' &&
          entry.source === 'redelivery-gate-probe' &&
          entry.summary.includes('GATED-NOTICE-2 本文はこれだけ長くしておく'),
      ),
    ).toBe(true);

    // 2. **畳んだこと自体の1行。**
    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const folded = exchanges.find(
      (entry) => entry.type === 'exchange' && entry.text.includes('ターンを起こさずに畳んだ'),
    );
    const foldedText = folded && folded.type === 'exchange' ? folded.text : '';
    expect(foldedText).toContain('配り直しの門がいま配る意味は無いと答えた');
    expect(foldedText).toContain('モデルへは1文字も渡していない');
    expect(foldedText).toContain('合図も台帳の行も消していない');

    await clone.stop();
  });

  it('述語を渡さなければ、フォールドされそうな形の合図も含めて全件配られる（既定の挙動を1文字も変えない）', async () => {
    const stores = createMemoryStores();
    const a = externalNotice(
      'WOULD-BE-GATED-IF-CONFIGURED',
      'evt-nogate-a',
      '2026-08-01T00:00:00.000Z',
    );
    const b = externalNotice('SECOND-EVENT-BODY', 'evt-nogate-b', '2026-08-01T00:00:01.000Z');
    await stores.inbox.put(a, a.at);
    await stores.inbox.put(b, b.at);

    // redeliveryGate を渡さない（省略）。
    const { clone, inputs } = bootClone(stores, 'reply');

    await waitFor(() => inputs.some((i) => i.includes('SECOND-EVENT-BODY')), '2件目まで処理に入る');
    expect(inputs.some((i) => i.includes('WOULD-BE-GATED-IF-CONFIGURED'))).toBe(true);

    // 両方とも配り終えて器から消えている（畳まれた行が残っていない）。
    await waitForNoUnread(stores);
    await clone.stop();
  });

  it('述語が投げても、配る側へ倒れて全文でターンが起きる（判定できないのは雑音であって喪失ではない）', async () => {
    const stores = createMemoryStores();
    const event = externalNotice('THROW-GATE-NOTICE 本文はこれだけ長くしておく', 'evt-throw-gate');
    await stores.inbox.put(event, event.at);

    const throwingGate: RedeliveryGate = () => {
      throw new Error('判定できない（テスト用）');
    };

    const lines = await captureStderr(async () => {
      const { clone, inputs } = bootClone(stores, 'reply', throwingGate);
      await waitFor(
        () => inputs.some((i) => i.includes('THROW-GATE-NOTICE')),
        '配る側へ倒れて処理に入る',
      );
      await clone.stop();
    });

    // 判定できなかったこと自体は stderr に跡を残す（`noteDroppedRecord`）。
    expect(lines.some((line) => line.includes('配り直しの門の判定'))).toBe(true);
  });

  it('畳まれた合図はモデルへ1文字も渡らない（配られる合図と混在させて確かめる）', async () => {
    const stores = createMemoryStores();
    const folded = externalNotice(
      'FOLDED-UNIQUE-PAYLOAD',
      'evt-mix-fold',
      '2026-08-01T00:00:00.000Z',
    );
    const delivered = externalNotice(
      'DELIVERED-UNIQUE-PAYLOAD',
      'evt-mix-deliver',
      '2026-08-01T00:00:01.000Z',
    );
    await stores.inbox.put(folded, folded.at);
    await stores.inbox.put(delivered, delivered.at);

    // **id で1件だけを畳む。** 「何も起きなかった」と「畳んだものだけが届かない」
    // を区別するため、必ず何か別のものが配られる形にする
    // （AGENTS.md「この歯が緑になる経路は、測りたい経路だけか」）。
    const gate: RedeliveryGate = (event) => event.id !== folded.id;
    const { clone, inputs } = bootClone(stores, 'reply', gate);

    await waitFor(
      () => inputs.some((i) => i.includes('DELIVERED-UNIQUE-PAYLOAD')),
      '配られる側が処理に入る',
    );
    await waitForJournal(stores, 'ターンを起こさずに畳んだ');

    expect(inputs.some((i) => i.includes('DELIVERED-UNIQUE-PAYLOAD'))).toBe(true);
    expect(inputs.join('')).not.toContain('FOLDED-UNIQUE-PAYLOAD');

    await clone.stop();
  });
});

/**
 * **`redeliveryGate` は「配り直すその瞬間」の `usageBlocked` で評価される。**
 * ループの外で1回だけ読んで使い回す実装（変異）だと、この歯は赤くなる——
 * `#restoreUnread` は1件ごとに `await` する（doc「呼び手はループの外で1回だけ
 * 読んで使い回してはいけない」）ので、並行して動く `#pump` が途中で
 * `usageBlocked` を動かしうる。
 *
 * `fakeSdkWithResultFor`（下）は `packages/core/src/clone.test.ts` の
 * `fakeSdk` の `resultFor` と同じ発想の縮小版——ターンごとに `result` を
 * 差し替えられる最小限の形だけをこのファイルに閉じて持つ（他の歯の挙動を
 * 変えない）。
 */
describe('redeliveryGate（Issue #783 続き）: 配り直すその瞬間の usageBlocked で評価する', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  function fakeSdkWithResultFor(
    resultFor: (turnIndex: number) => { subtype: string; text: string } | undefined,
  ): Fake {
    const inputs: string[] = [];
    let turnIndex = 0;
    const fn = ((params: { prompt: unknown; options?: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;

        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          inputs.push(String(message.message.content));
          const override = resultFor(turnIndex);
          turnIndex += 1;
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ok' }] },
            parent_tool_use_id: null,
            session_id: 'sess-fake',
            uuid: 'uuid-assistant',
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: override?.subtype ?? 'success',
            result: override?.text ?? 'ok',
            session_id: 'sess-fake',
            uuid: 'uuid-result',
          } as unknown as SDKMessage;
        }
      }

      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    return { fn, inputs };
  }

  it('ループの途中で usageBlocked が変わると、同じ起動の中で前半と後半で扱いが変わる（ループの外で1回だけ評価する実装だと赤くなる）', async () => {
    const base = createMemoryStores();
    const first = externalNotice(
      'FIRST-GATE-TIMING',
      'evt-timing-first',
      '2026-08-01T00:00:00.000Z',
    );
    const second = externalNotice(
      'SECOND-GATE-TIMING',
      'evt-timing-second',
      '2026-08-01T00:00:01.000Z',
    );
    await base.inbox.put(first, first.at);
    await base.inbox.put(second, second.at);

    // **2件目の「配り直した」日誌の書き込みだけを遅らせる。** その間に1件目の
    // ターンが枠に落ちて `usageBlocked` を真にする時間を作る。`#restoreUnread`
    // は1件ごとに「日誌書き込み→台帳確認→gate 評価」の順に進むので、ここを
    // 遅らせれば2件目の gate 評価がそのぶん後ろへずれる。
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        async append(entry) {
          if (entry.type === 'exchange' && entry.text.includes(second.at)) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return base.journal.append(entry);
        },
      },
    };

    const { fn, inputs } = fakeSdkWithResultFor((turnIndex) =>
      turnIndex === 0 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    );

    // その瞬間の usageBlocked を見て、真なら畳む（偽なら配る）。
    const gate: RedeliveryGate = (_event, { usageBlocked }) => !usageBlocked;

    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      redeliveryGate: gate,
    });

    // 1件目は usageBlocked=false のときに評価されて配られ、ターンが枠に落ちる。
    await waitFor(() => inputs.some((i) => i.includes('FIRST-GATE-TIMING')), '1件目が処理に入る');

    // 2件目は usageBlocked=true になった後に評価されて畳まれる。
    await waitForJournal(stores, 'ターンを起こさずに畳んだ');

    expect(inputs.some((i) => i.includes('FIRST-GATE-TIMING'))).toBe(true);
    expect(inputs.join('')).not.toContain('SECOND-GATE-TIMING');

    // 畳まれたのは2件目だけである（1件目は配られてターンが起きている）。
    const journal = await stores.journal.list({ types: ['exchange'] });
    const foldedCount = journal.filter(
      (entry) => entry.type === 'exchange' && entry.text.includes('ターンを起こさずに畳んだ'),
    ).length;
    expect(foldedCount).toBe(1);

    await clone.stop();
  });
});

/**
 * 拾い直した token-pool の合図の消し込み（Issue #783 段1）。
 *
 * **上の2つの describe（門）とは別の経路である。** 門（`redeliveryGate`）は
 * 「いま配る意味が在るか」を `usageBlocked` で問い、偽でも行を残す
 * （畳む）。ここで測るのは `restoredInboxEventVerdict`
 * （`inbox-staleness.ts`）による消し込みで、**門より先に**評価され、
 * `usageBlocked` を一切見ない。`external` の `source` が
 * `DAEMON_TOKEN_POOL_REOPENED_SOURCE`（`token-pool`）のときだけ、受信箱の
 * 行そのものを消す。
 */
async function waitForAbsentFromPending(stores: Stores, id: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const remaining = await stores.inbox.peekPending();
    if (!remaining.some((r) => r.event.id === id)) return;
    if (Date.now() - started > 3000) throw new Error(`${id} が受信箱から消えない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 型ごとの本文追記（`ターンを起こさずに畳んだ`）が指定の件数そろうまで待つ。 */
async function waitForFoldedCount(stores: Stores, count: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const folded = exchanges.filter(
      (entry) => entry.type === 'exchange' && entry.text.includes('ターンを起こさずに畳んだ'),
    ).length;
    if (folded >= count) return;
    if (Date.now() - started > 3000) throw new Error('畳んだ件数が揃わない');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('拾い直した token-pool の合図の消し込み（Issue #783 段1）', () => {
  it('token-pool の合図は起動時に受信箱から消え、日誌には本文追記と「消した」の1行が両方残り、モデルへは1文字も渡らない', async () => {
    const stores = createMemoryStores();
    const event: InboxEvent = {
      type: 'external',
      id: 'evt-token-pool-stale',
      at: '2026-08-01T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: 'TOKEN-POOL-STALE-PAYLOAD',
    };
    // 前のプロセスが死んで未読のまま残っていた状況を直接作る（#restoreUnread が拾う）。
    await stores.inbox.put(event, event.at);

    const { clone, inputs } = bootClone(stores, 'reply');
    await waitForJournal(stores, 'ターンを起こさずに消した');
    await waitForAbsentFromPending(stores, event.id);

    // 1. 型ごとの本文追記（external なので `external_event` へ書かれる）。
    const externalEvents = await stores.journal.list({ types: ['external_event'] });
    expect(
      externalEvents.some(
        (entry) =>
          entry.type === 'external_event' &&
          entry.source === DAEMON_TOKEN_POOL_REOPENED_SOURCE &&
          entry.summary.includes('TOKEN-POOL-STALE-PAYLOAD'),
      ),
    ).toBe(true);

    // 2. 消したこと自体の1行。
    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const dropped = exchanges.find(
      (entry) => entry.type === 'exchange' && entry.text.includes('ターンを起こさずに消した'),
    );
    const droppedText = dropped && dropped.type === 'exchange' ? dropped.text : '';
    expect(droppedText).toContain('モデルへは1文字も渡していない');

    // モデルへは1文字も渡っていない（ターンそのものが起きていない）。
    expect(inputs).toEqual([]);
    expect(inputs.join('')).not.toContain('TOKEN-POOL-STALE-PAYLOAD');

    await clone.stop();
  });

  it('同じ起動の中で token-pool だけが消え、runner-registry と自由文字列の external は受信箱に残る（門は常に畳む設定に固定——門の気分ではなく合図の性質で決めていることの確認）', async () => {
    const stores = createMemoryStores();
    const tokenPool: InboxEvent = {
      type: 'external',
      id: 'evt-mix-token-pool',
      at: '2026-08-01T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: 'MIX-TOKEN-POOL-PAYLOAD',
    };
    const runnerRegistry: InboxEvent = {
      type: 'external',
      id: 'evt-mix-runner-registry',
      at: '2026-08-01T00:00:01.000Z',
      source: DAEMON_RUNNER_REGISTRY_SOURCE,
      payload: 'MIX-RUNNER-REGISTRY-PAYLOAD',
    };
    const freeform: InboxEvent = {
      type: 'external',
      id: 'evt-mix-freeform',
      at: '2026-08-01T00:00:02.000Z',
      source: 'webhook-from-somewhere-outside',
      payload: 'MIX-FREEFORM-PAYLOAD',
    };
    await stores.inbox.put(tokenPool, tokenPool.at);
    await stores.inbox.put(runnerRegistry, runnerRegistry.at);
    await stores.inbox.put(freeform, freeform.at);

    // 門は常に「いま配る意味は無い」（畳む）に固定する——token-pool だけが
    // 消えるなら、それは門の答えとは無関係だという証拠になる。
    const alwaysFold: RedeliveryGate = () => false;
    const { clone, inputs } = bootClone(stores, 'reply', alwaysFold);

    await waitForAbsentFromPending(stores, tokenPool.id);
    // runner-registry と自由文字列の2件は `live` なので門まで進み、門が畳む。
    await waitForFoldedCount(stores, 2);

    const remaining = await stores.inbox.peekPending();
    const remainingIds = remaining.map((r) => r.event.id);
    expect(remainingIds).not.toContain(tokenPool.id);
    expect(remainingIds).toContain(runnerRegistry.id);
    expect(remainingIds).toContain(freeform.id);

    // 3件とも配られていない（ターンが起きていない）。
    expect(inputs).toEqual([]);

    await clone.stop();
  });

  it('redeliveryGate を省略した既定のクローンでも token-pool の合図は消える（消し込みは門の設定と独立である）', async () => {
    const stores = createMemoryStores();
    const event: InboxEvent = {
      type: 'external',
      id: 'evt-token-pool-no-gate',
      at: '2026-08-01T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: 'NO-GATE-TOKEN-POOL-PAYLOAD',
    };
    await stores.inbox.put(event, event.at);

    // redeliveryGate を渡さない（省略）→ bootClone の既定 ALWAYS_REDELIVER が使われる
    // （既定は全件配る側だが、それでもこの合図は門へ辿り着く前に消える）。
    const { clone, inputs } = bootClone(stores, 'reply');
    await waitForJournal(stores, 'ターンを起こさずに消した');
    await waitForAbsentFromPending(stores, event.id);

    expect(inputs).toEqual([]);

    await clone.stop();
  });
});

describe('InboxStore.pending（#358。読むだけで配達回数を進めない）', () => {
  it('件数といちばん古い時刻を返す（0件のときは oldestAt を作らない）', async () => {
    const stores = createMemoryStores();
    expect(await stores.inbox.pending()).toEqual({ count: 0 });

    await stores.inbox.put(report('2件目', 'evt-2'), '2026-08-11T00:00:00.000Z');
    await stores.inbox.put(report('1件目', 'evt-1'), '2026-08-10T00:00:00.000Z');

    expect(await stores.inbox.pending()).toEqual({
      count: 2,
      oldestAt: '2026-08-10T00:00:00.000Z',
    });
  });

  /**
   * **この歯が単独で守るもの**: `pending()` を何度呼んでも `claimPending()` が
   * 返す `deliveries` が変わらないこと。fs / pg と同じ性質をインメモリ実装
   * （`packages/core/src/testing.ts` の `createMemoryInboxStore`）に対しても
   * 確かめる——3実装すべてに同じ歯を立てる（`store.ts`「省略可能にしない
   * こと」と同じ理由: 1つだけ確かめても、能力差が別の器で静かに生まれうる）。
   */
  it('pending() を何度呼んでも claimPending() の deliveries は動かない', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(report('本文', 'evt-1'), '2026-08-10T00:00:00.000Z');

    await stores.inbox.pending();
    await stores.inbox.pending();
    await stores.inbox.pending();

    const claimed = await stores.inbox.claimPending();
    expect(claimed[0]?.deliveries).toBe(1);
  });
});
