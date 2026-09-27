import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { ALWAYS_REDELIVER, CLONE_MODEL_ENV_KEY, createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent } from './schema.js';
import { CLONE_ACTOR_ID } from './usage.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';
import {
  fakeSdk,
  setup,
  wireEvents,
  waitFor,
  waitForDone,
  isTerminal,
  waitForTerminal,
} from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('クローンの消費が台帳に載る（誰が・どこで）', () => {
  /** モデル id を1つだけ持つ `modelUsage`。費用だけを動かす。 */
  function usage(model: string, costUsd: number) {
    return {
      [model]: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        // SDK 側の綴りは大文字（`costUSD`）。ここを小文字で書くと 0 が積まれる。
        costUSD: costUsd,
      },
    };
  }

  /** `PreCompact` フックを実際に叩いて蒸留のサイドクエリを走らせる。 */
  async function firePreCompact(main: FakeCall): Promise<void> {
    const dir = await makeTempDir('alteroid-clone-usage-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
  }

  it('本セッションの分が layer=clone / site=session として載る', async () => {
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: () => usage('claude-fable-5', 0.5),
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const { rows } = await s.stores.usage.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.layer).toBe('clone');
    expect(rows[0]?.site).toBe('session');
    // actor は予約 id。マネージャーの id（`mgr-…`）とは衝突しない。
    expect(rows[0]?.managerId).toBe(CLONE_ACTOR_ID);
    expect(CLONE_ACTOR_ID.startsWith('mgr-')).toBe(false);
    expect(rows[0]?.totals.costUsd).toBe(0.5);

    await s.clone.stop();
  });

  it('モデル id が opus でも層は clone のままである（モデル名で層を代用していない）', async () => {
    // **これが依頼の中心にある問題である。** `ALTEROID_CLONE_MODEL=opus` を置くと
    // クローンとマネージャーは台帳で同じ `model` に並ぶ。モデル名を層の代わりに
    // 使っていれば、ここでクローンの分が「マネージャーの分」として読める。
    const s = setup(
      undefined,
      createMemoryStores(),
      { modelUsage: () => usage('claude-opus-5', 3) },
      { [CLONE_MODEL_ENV_KEY]: 'opus' },
    );

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const { rows } = await s.stores.usage.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe('claude-opus-5');
    expect(rows[0]?.layer).toBe('clone');

    await s.clone.stop();
  });

  it('要約の蒸留の分が site=distill として別に載る（本体の分と混ざらない）', async () => {
    // 呼び出し 0 が本セッション、呼び出し 1 が蒸留のサイドクエリ。**別の値を
    // 返す**ことで、どちらの分がどこへ積まれたかを問える。
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: (index) =>
        index === 0 ? usage('claude-fable-5', 1) : usage('claude-fable-5', 0.25),
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await firePreCompact(s.calls[0] as FakeCall);

    const { rows } = await s.stores.usage.aggregate({});
    expect(rows.map((r) => [r.site, r.totals.costUsd]).sort()).toEqual([
      ['distill', 0.25],
      ['session', 1],
    ]);
    // どちらもクローンの分である（「誰が」は同じで「どこで」が違う）。
    expect(rows.every((r) => r.layer === 'clone')).toBe(true);
    expect(rows.every((r) => r.managerId === CLONE_ACTOR_ID)).toBe(true);

    await s.clone.stop();
  });

  it('蒸留を2回走らせても、高くついた回が目減りしない（基準を持たない）', async () => {
    // 蒸留は毎回新しい `query()` で、`result` はその1回の総量そのものである。
    // 基準を持たせると 2回目は差の $0.03 しか積まれない（$0.08 の回が黙って縮む）。
    const distillCosts = [0.05, 0.08];
    let distillIndex = 0;
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: (index) => {
        if (index === 0) return undefined; // 本セッションの分は数えない（この項の対象外）
        const cost = distillCosts[distillIndex] ?? 0;
        distillIndex += 1;
        return usage('claude-fable-5', cost);
      },
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    const main = s.calls[0] as FakeCall;
    await firePreCompact(main);
    await firePreCompact(main);

    const { rows } = await s.stores.usage.aggregate({ site: 'distill' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBeCloseTo(0.13, 10);

    await s.clone.stop();
  });

  it('失敗した result は台帳へ入らない（ゼロで基準を下げない）', async () => {
    // `modelUsage` 自身の doc がそう言っている。
    // [sdk-verbatim SDKResultError.modelUsage]
    // crash/startup-error results may carry zeroed usage
    // ゼロを「累積が 0 になった」として通すと基準が下がり、次に届いた本物の累積が
    // 丸ごと増分になる ＝ 記録済みの分がもう一度積まれる。
    //
    // **`waitForDone` から `waitForTerminal` へ変えた経緯。** ここは元々
    // `waitForDone` で待っていたが、それは「失敗した result でも done が出る」
    // という当時の欠陥をそのまま仕様として固定していた（`case 'result':` が
    // 成否を見ずに無条件で `done` を出していたため）。その欠陥を直した結果、
    // このターンは `done` ではなく `error` で終わるので `waitForDone` は
    // 3秒でタイムアウトして落ちる。台帳のアサーション（`rows` が空 / `since` が
    // null）はこのテストが本来保証しているものなので変えていない。
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      modelUsage: () => usage('claude-fable-5', 0),
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    const aggregate = await s.stores.usage.aggregate({});
    expect(aggregate.rows).toEqual([]);
    // 台帳そのものが始まっていない（1件も record していない）。
    expect(aggregate.since).toBeNull();

    await s.clone.stop();
  });

  it('失敗した result はターンの失敗として日誌に残る（無記録で消えない）', async () => {
    // 直す前は、失敗した result でも成否を見ずに `done` を出して `#finishTurn()`
    // を呼んでいた。`#turn` は既に `null` になった後なので `#reportFailure` が
    // 一度も呼ばれず、例外も起きないので `#handle` は正常終了し、受信箱の合図は
    // `#forget` されて消える — 支出上限や実行時エラーでターンが死んでも、日誌に
    // 何も残らなかった。ここではその「無記録で消える」が直っていることを見る。
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      text: string;
    }[];
    expect(exchanges.some((entry) => entry.text.includes('人間との対話ターンが失敗した'))).toBe(
      true,
    );

    await s.clone.stop();
  });

  it('失敗した result で done を出さない（成功したことにしない）', async () => {
    // `#emit` は `done` と `error` のどちらか一方だけを出す設計である。ここは
    // 「`error` が来た」だけでなく「`done` は一度も来ていない」までを見る —
    // 直す前の欠陥はまさに「失敗しても done が出る」ことだったので、`error` の
    // 有無だけでは同じ欠陥を見落としうる。
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);
    expect(s.events.some((event) => event.type === 'done')).toBe(false);

    await s.clone.stop();
  });

  it('失敗した result でもターンは畳まれ、受信箱が止まらない', async () => {
    // `#finishTurn()` を失敗側で呼び忘れると、その `Turn.resolve` を待っている
    // `#runTurn`（延いては `#handle` と `#pump` の `for await`）が永久に返らず、
    // 受信箱のループそのものが次の合図へ進めなくなる。1本目が失敗で終わった後、
    // 2本目の発言が独立に処理される（＝2本目の error が来る）ことでそれを見る。
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
    });

    s.clone.post(humanMessage('1回目'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    s.clone.post(humanMessage('2回目'));
    await waitFor(() => s.events.filter(isTerminal).length === 2, '終端が2つ揃う');
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error', 'error']);

    await s.clone.stop();
  });

  it('支出上限で終わったとき、その理由が記録に残る', async () => {
    // 実機で支出上限に当たったとき、SDK は `subtype: 'error_during_execution'` と
    // 共に `result` へ `You've hit your individual spend limit` を載せて終わる
    // （`runner.ts` の同じ場面のコメントと同じ実例）。`subtype` だけを見て
    // 「結果なしで終了: error_during_execution」とだけ記録すると、上限で
    // 止まったのか単に失敗したのかをクローンが区別できなくなる。
    const spendLimitMessage = "You've hit your individual spend limit for this account.";
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);

    const errorEvent = s.events.find(
      (event): event is Extract<ChatStreamEvent, { type: 'error' }> => event.type === 'error',
    );
    expect(errorEvent?.message).toContain(spendLimitMessage);

    await s.clone.stop();
  });

  it('台帳へ積めなくてもターンは止まらない（黙って消さないが、殺しもしない）', async () => {
    const stores = createMemoryStores();
    stores.usage.record = () => Promise.reject(new Error('台帳が書けない'));

    const s = setup(undefined, stores, { modelUsage: () => usage('claude-fable-5', 1) });

    const stderr = await captureStderr(async () => {
      s.clone.post(humanMessage('やあ'));
      // done が来る＝ターンが完走している
      await waitForDone(s.events);
      // **`stop()` も捕獲の内側で呼ぶ。** 外に置くと、`stop()` が積む片付けの蒸留
      // （`reason: 'shutdown'`）が**本セッションの2本目のターン**を起こし、その
      // `result` の台帳書き込みが同じ理由で失敗して、**生の stderr へ1行漏れる**
      // （`captureStderr` は `finally` で `process.stderr.write` を戻すので、その
      // 1ms 後の排出は素の stderr へ出る）。実測: 単体・`-t` 単発・フルスイートの
      // どれでも毎回1行。**フルスイートでだけ出るのではない。**
      //
      // 漏れが実害になるのは、その行が製品コードが本番で出すのと同じ前半
      // （`利用状況の台帳を記録できませんでした（layer=clone site=...）`）を持ち、
      // しかも `process.stderr.write` を直に呼ぶので vitest の「どのテストの出力か」
      // の前置きが付かないためである。緑の実行で毎回1行出続ければ、読み手はその
      // 文言を既知のノイズとして飛ばす訓練を受ける。
      //
      // 同じ `captureStderr` を使う兄弟の2本（`日誌にも書けなければ stderr に1行`
      // ／`storage is closed` を見る本）は、はじめから `stop()` を内側に置いて
      // いて漏れていない。**ここだけが外に出ていた。**
      await s.clone.stop();
    });

    // 跡は残る（「日誌に無い」が「起きなかった」と読めないように）
    expect(stderr.join('')).toContain('利用状況の台帳');

    // **件数まで見る。** `toContain` だけだと、人間のターンの分1件で満たされて
    // しまうので、**片付けの蒸留ターンで台帳の失敗が報告されなくなっても落ちない**
    // （そこは「たまたま出ていた」だけだった）。2件の出どころは、人間の発言の
    // ターンと、`stop()` が積む片付けの蒸留ターンである。`modelUsage` は
    // `callIndex` を見ないのでどちらの `result` にも usage が載り、どちらの
    // 書き込みもこのテストのスタブが reject する。
    const ledgerLines = stderr.filter((line) => line.includes('利用状況の台帳'));
    expect(ledgerLines).toHaveLength(2);
  });

  /**
   * **どの認証トークンで使ったか**（Issue #393 受け入れ基準6）。
   *
   * ここが固定するのは「クローンが何を渡すか」だけである。列の意味・鍵・軸の始点は
   * storage の2つの器（`@alteroid/storage-fs` / `@alteroid/storage-pg` の
   * `usage.test.ts`）が持つ。
   */
  describe('認証トークンの帰属', () => {
    /** 帰属を渡すクローン。`setup` は `tokenIdentity` を受けないので直に組む。 */
    function cloneWithIdentity(
      identity: () => { tokenId: string; generation: number } | undefined,
    ) {
      const stores = createMemoryStores();
      // **固定値にしない。** 呼ぶ回ごとに増える累積を返すので、同じセッションの
      // 2ターン目にも増分が立つ（固定値だと差が 0 になり、2ターン目が台帳に
      // 現れないので「読み直していないこと」を測れない）。
      let nth = 0;
      const { fn } = fakeSdk(undefined, {
        modelUsage: () => usage('claude-fable-5', ++nth * 0.5),
      });
      const clone = createClone({
        redeliveryGate: ALWAYS_REDELIVER,
        stores,
        queryFn: fn,
        env: {},
        tokenIdentity: identity,
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
        ]),
      });
      const { events } = wireEvents(clone, 'conv-1');
      return { clone, stores, events };
    }

    it('現役の指名が在れば、その tokenId が行に載る', async () => {
      const s = cloneWithIdentity(() => ({ tokenId: 'tok-a', generation: 3 }));

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const { rows, tokensSince } = await s.stores.usage.aggregate({});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenId).toBe('tok-a');
      // 帰属が1件入ったので、トークンの軸が始まっている。
      //
      // **`beforeTokens` は見ない。** 下限の無い照会（`from` 省略）は常に始点より
      // 前を含みうるので真である（`beforeLedger` / `beforeLayers` と同じ契約）。
      // ここで偽を期待すると、契約と逆のものを固定してしまう。
      expect(tokensSince).not.toBeNull();

      await s.clone.stop();
    });

    it('現役の指名が無ければ帰属を渡さない（プールが空の器で軸が始まらない）', async () => {
      // **受け入れ基準7 の側である。** ここで何かを埋めると、プールを1本も
      // 持っていない器が「そのトークンで使った」と名乗る。
      const s = cloneWithIdentity(() => undefined);

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const { rows, since, tokensSince, beforeTokens } = await s.stores.usage.aggregate({});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenId).toBeUndefined();
      // 台帳は始まっているのに、トークンの軸だけ始まっていない。
      expect(since).not.toBeNull();
      expect(tokensSince).toBeNull();
      expect(beforeTokens).toBe(true);

      await s.clone.stop();
    });

    it('帰属は「セッションが起きた瞬間の身元」である（record のたびに読み直さない）', async () => {
      // **読み直すと、回した直後に届いた前のセッションぶんの消費が新しいトークンに
      // 付く。** `#tokenIdentities`（マネージャー側）が在るのと同じ理由である。
      let current = { tokenId: 'tok-a', generation: 1 };
      const s = cloneWithIdentity(() => current);

      s.clone.post(humanMessage('1回目'));
      await waitForDone(s.events);

      // セッションは開いたまま、現役だけが入れ替わる。
      current = { tokenId: 'tok-b', generation: 2 };
      s.clone.post(humanMessage('2回目'));
      await waitFor(
        async () => (await s.stores.usage.aggregate({})).rows[0]?.totals.costUsd === 1,
        '2ターン目が台帳へ載ること',
      );

      const { rows } = await s.stores.usage.aggregate({});
      // **行は1つのまま。** 読み直していれば `tok-b` の行が別に立つ。
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenId).toBe('tok-a');
      expect(rows[0]?.totals.costUsd).toBe(1);

      await s.clone.stop();
    });
  });
});

/**
 * PreCompact のサイドセッション（`#distillFromTranscript`）が起こすターンの
 * 入力を日誌に残す（Issue #243 の7本目。既存6経路は `clone-turn-input.test.ts`
 * が持つ）。
 *
 * この経路は `#runInternal` / `#runTurn` を経由せず `this.#queryFn` を直接
 * 呼ぶので、あちらのテストが使う `bootClone`（ストリーミング入力専用の
 * 簡約フェイク）では起こせない——ここは1つ上の「クローンの消費が台帳に載る」と
 * 同じ `fakeSdk`（文字列プロンプトも扱える。`typeof prompt === 'string'` 分岐）
 * と `firePreCompact` の骨格を使う。
 */
