import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { EXCHANGE_KIND_REPLY_PREFIX } from './exchange-kind.js';
import type { ManagerPool, ManagerSummary } from './manager.js';
import { measureMemoryFloor } from './memory.js';
import { createScheduler } from './schedule.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, setup, waitFor, waitForExpect, waitForTerminal } from './clone-test-harness.js';
import type { Setup } from './clone-test-harness.js';

/**
 * 起点4つ（PRD「自律」）。人間の発言以外の3つは、**人間が一切入力していない状態**で
 * 起きることが本質なので、どのテストも human_message を送らずに始める。
 */
describe('クローン — 自律（人間以外の起点）', () => {
  const inputsOf = (s: Setup) => () => (s.calls[0]?.inputs ?? []).join('\n');

  /**
   * 日誌に残った `ターンの入力: self_initiative …` 行から `cause=…` の断片だけを
   * 取り出す。`timer` の既存テスト（下の「取りこぼしを拾った発火は…」）と同じ形
   * — ストア（`claimRun`/`completeRun`）ではなく日誌の側で見る。
   */
  async function selfInitiativeCauseLines(s: Setup): Promise<string[]> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    return exchanges
      .filter((e) => e.with === 'self' && e.text.startsWith('ターンの入力: self_initiative'))
      .map((e) => e.text.match(/cause=\S+/)?.[0] ?? 'cause=(無し)');
  }

  /** 同じ形の抽出を `daily_report` の行に対して行う（`selfInitiativeCauseLines` と対）。 */
  async function dailyReportCauseLines(s: Setup): Promise<string[]> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    return exchanges
      .filter((e) => e.with === 'self' && e.text.startsWith('ターンの入力: daily_report'))
      .map((e) => e.text.match(/cause=\S+/)?.[0] ?? 'cause=(無し)');
  }

  it('発意 tick で、人間が黙っていても自分の判断が動く（起点④）', async () => {
    const s = setup(() => '今回は動かない');

    s.clone.post({
      type: 'self_initiative',
      id: 'evt-self',
      at: new Date().toISOString(),
      reason: '定期 tick',
    });

    await waitFor(
      () => inputsOf(s)().includes('次にやることがあるか'),
      '『次にやることがあるか』という問いかけが入力に届く',
    );
    // 人間には見せない内部ターンなので chat には出ない
    expect(s.events).toEqual([]);
    // 陰性対照: cause を省略した発火（＝定刻どおり）は日誌に cause=schedule と残る
    // （省略時の既定。付いた印が増えるわけではない）
    expect(await selfInitiativeCauseLines(s)).toEqual(['cause=schedule']);

    await s.clone.stop();
  });

  /**
   * `self_initiative` の `cause`（#635 が `timer` に足した3値と同じ軸・同じ意味）が、
   * `daily_report` を除く「日誌にも記録されない」の穴を塞ぐ #5 の続き。
   *
   * `TimerScheduler#seedBase()` は `dueFromSeed` の `.catchUp` を読むようになった
   * （直す前は `.at` だけを使い、拾い直しか定刻どおりかを日誌の上で区別できなかった）。
   * ここでは `clone.ts` の `case 'self_initiative'` が `event.cause` をそのまま
   * `turnInputEntry` へ運ぶことだけを確かめる（`#seedBase` / `tick()` 側の判定
   * そのものは `schedule.test.ts` が持つ）。
   */
  it('取りこぼしを拾った発意 tick は、日誌に cause=schedule_catchup として残る', async () => {
    const s = setup(() => '取りこぼしを拾って動いた');

    s.clone.post({
      type: 'self_initiative',
      id: 'evt-self-catchup',
      at: new Date().toISOString(),
      reason: '定期 tick',
      cause: 'schedule_catchup',
    });

    await waitFor(
      () => inputsOf(s)().includes('次にやることがあるか'),
      '『次にやることがあるか』という問いかけが入力に届く',
    );
    expect(await selfInitiativeCauseLines(s)).toEqual(['cause=schedule_catchup']);

    await s.clone.stop();
  });

  it('手で起こした（/run self_initiative）発意 tick は、日誌に cause=manual として残る', async () => {
    const s = setup(() => '手で起こされて動いた');

    s.clone.post({
      type: 'self_initiative',
      id: 'evt-self-manual',
      at: new Date().toISOString(),
      reason: '定期 tick',
      cause: 'manual',
    });

    await waitFor(
      () => inputsOf(s)().includes('次にやることがあるか'),
      '『次にやることがあるか』という問いかけが入力に届く',
    );
    expect(await selfInitiativeCauseLines(s)).toEqual(['cause=manual']);

    await s.clone.stop();
  });

  /**
   * 発意 tick の要約（digest）に `ManagerPool` の liveness が渡っていること
   * （#5243d633）。
   *
   * `#recentDigest` は `digest.ts` の `buildActivityDigest` を呼ぶだけで、
   * `live`（＝いま話しかけられるか）はジョブ台帳の軸ではなく
   * `ManagerPool#list()` が実行時に返すものである。ここへ配線し忘れると、
   * digest の「マネージャー」節は常に「セッション不明」（`liveness` 省略時の
   * 既定）になり、`manager_list` の実際の状態（`live: false` ＝セッション
   * 切断）とは違う文言のまま tick がクローンへ届く——今回直した実害
   * （終わった仕事へ3本目の委譲を出した）と同じ形の穴が、配線側にも開き
   * うる。
   *
   * `#dailyReport` 側の配線は `digest.test.ts` の `describeManagerState` の
   * 歯と合わせてここでは測らない——`buildActivityDigest` へ `liveness` が
   * 届けば `describeManagerState` は同じ字面を出すので、**tick 側の配線が
   * 生きていること**をここでは見る。
   */
  it('発意 tick の要約に ManagerPool の liveness が渡る（#5243d633）', async () => {
    const { fn, calls } = fakeSdk(() => '今回は動かない');
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-alive',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: '生きている仕事',
      request: '生きている仕事',
    });
    await stores.jobs.putJob({
      id: 'mgr-dead',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: 'セッションが切れた仕事',
      request: 'セッションが切れた仕事',
    });

    const summaryOf = (managerId: string, live: boolean): ManagerSummary => ({
      managerId,
      status: 'running',
      live,
      cwd: '/work',
      request: '仕事',
      startedAt: now,
      updatedAt: now,
      waiting: [],
    });
    // `throwingPool`（上の「managers.list() が投げても…」の歯）と同じ形の
    // スタブ。このテストで使うのは `list()` だけなので、それ以外は
    // 呼ばれない前提で投げる。
    const pool: ManagerPool = {
      start: () => {
        throw new Error('not implemented');
      },
      send: () => {
        throw new Error('not implemented');
      },
      abort: () => {
        throw new Error('not implemented');
      },
      appraise: () => {
        throw new Error('not implemented');
      },
      list: () => Promise.resolve([summaryOf('mgr-alive', true), summaryOf('mgr-dead', false)]),
      denials: () => [],
      pushHealthOf: () => undefined,
      runnerBacklog: () => [],
      runnerIdOf: () => Promise.resolve(undefined),
      runners: () => {
        throw new Error('not implemented');
      },
      transcript: () => {
        throw new Error('not implemented');
      },
      unpushedWork: () => {
        throw new Error('not implemented');
      },
      runningManagerOwning: () => undefined,
      restore: () => Promise.resolve([]),
      resumeStoppedByUsage: () => Promise.resolve([]),
      reattachRunner: () => Promise.resolve(),
      relocateFrom: () => {
        throw new Error('not implemented');
      },
      vacate: () => {
        throw new Error('not implemented');
      },
      probeTurnEnds: () => Promise.resolve(),
      flushWithheldReports: () => Promise.resolve(),
      settleStalledUsageWakes: () => Promise.resolve([]),
      renotifyStalledDenials: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };

    const clone = createClone({
      stores,
      queryFn: fn,
      managers: pool,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post({
      type: 'self_initiative',
      id: 'evt-self-liveness',
      at: new Date().toISOString(),
      reason: '定期 tick',
    });

    const inputs = () => (calls[0]?.inputs ?? []).join('\n');
    await waitFor(
      () => inputs().includes('mgr-alive') && inputs().includes('mgr-dead'),
      '『mgr-alive』と『mgr-dead』の両方が入力に届く',
    );

    const text = inputs();
    // `describeManagerState` と同じ字面（`digest.test.ts` で直接測っている）。
    // ここで見るのは、配線を通ってその字面が tick のプロンプトまで実際に
    // 届くことである。
    expect(text).toContain('mgr-alive [running]');
    expect(text).toContain('mgr-dead [running/セッション切断]');

    await clone.stop();
  });

  /**
   * 「記憶の床」の1行（#553 F2）。挿入点は `#recentDigest()`（`clone.ts`）で、
   * `self_initiative` / `timer` の両 tick に載り、日報には載らない
   * （`#recentDigestBare` を切り出した理由）。ここから下の一連の歯が、
   * その分岐を1つずつ確かめる。
   */
  describe('記憶の床（tick の digest 先頭、#553 F2）', () => {
    /**
     * 床を**指定した文字数ぶん**動かすための文書。
     *
     * ## なぜ本文を伸ばす形をやめたか（人間の決定 2026-09-08）
     *
     * ここから下の2本は、かつて本文（`'a'.repeat(N)`）を伸ばして床を動かして
     * いた。`premise` が全文で焼かれていた頃は、本文を N 文字伸ばせば床も
     * ちょうど N 文字増えたからである。
     *
     * **いまは本文が1文字も焼かれない**（`memory.ts` の `renderPremiseCard`）
     * ので、本文をどれだけ伸ばしても床はほとんど動かない（カードに載る
     * `全 N 文字` の**桁**が増えたぶんだけ動く）。実際、この変更の直後は
     * 「+0 文字」のまま線を超えず、歯が落ちていた。
     *
     * **代わりに要旨（frontmatter の `description`）を伸ばす。** 要旨は予算
     * （`memory.ts` の `MEMORY_PROMPT_DESCRIPTION_BUDGET` = 3,000 文字）までは
     * そのままカードへ載るので、**1文字単位で床を動かせる唯一の口**である
     * （節を足す形は、節の行と親の文字数が同時に動くので刻みを選べない）。
     *
     * **測っている対象は変えていない** —— どちらも「毎ターン焼かれる量が
     * 増えたことを、床の行が差分と線の印で名乗るか」である。
     */
    const noteWithSummary = (summaryChars: number) =>
      `---\ndescription: ${'a'.repeat(summaryChars)}\n---\n\n# Note\n\n本文\n`;

    it('発意 tick の digest の先頭に床の行が在り、基準未確立・前回tick無しを言う', async () => {
      const s = setup(() => '今回は動かない');

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-floor-first',
        at: new Date().toISOString(),
        reason: '定期 tick',
      });

      await waitFor(
        () => inputsOf(s)().includes('以下は直近の状況である。'),
        '日報の『以下は直近の状況である。』が入力に届く',
      );

      const text = inputsOf(s)();
      // digest の**先頭**が床の行である（見出しの直後に直接続く）。
      expect(text).toContain('以下は直近の状況である。\n\n記憶の床:');
      // tick は `#runInternal`（＝セッション構築）より前に digest を作るので、
      // プロセス最初のセッションがまだ組まれていない tick が実在する
      // （`#promptMemoryChars === 0`）。0 を基準として「n 文字増えた」とは
      // 名乗らない。
      expect(text).toContain('基準がまだ無いので線の判定は出せない。');
      // このプロセスで最初の tick なので、前回との差分は出せない。
      expect(text).toContain(
        '前回の tick が無いので差分は出せない（このプロセスでの最初の tick）。',
      );

      await s.clone.stop();
    });

    it('定期ジョブ（timer）にも床の行が載るが、日報（daily_report）には載らない', async () => {
      const stores = createMemoryStores();
      await stores.schedules.put({
        kind: 'issue-round',
        spec: { type: 'daily' as const, at: '09:00' },
        request: '何かする',
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
      });
      const s = setup(() => '見た', stores);
      const call = () => s.calls[0];

      s.clone.post({
        type: 'timer',
        id: 'evt-timer-floor',
        at: '2026-08-12T00:00:00.000Z',
        kind: 'issue-round',
      });
      await waitFor(
        () => call()?.inputs.some((input) => input.includes('何かする')) ?? false,
        '『何かする』を含む入力が届く',
      );
      expect(call()?.inputs.at(-1)).toContain('以下は直近の状況である。\n\n記憶の床:');

      s.clone.post({
        type: 'timer',
        id: 'evt-timer-daily',
        at: new Date().toISOString(),
        kind: 'daily_report',
        target: '2026-08-11',
      });
      await waitForExpect(
        async () =>
          expect(await s.stores.journal.list({ types: ['daily_report'] })).toHaveLength(1),
        'daily_report が日誌に1件積まれる',
      );

      const dailyPrompt = call()?.inputs.at(-1) ?? '';
      expect(dailyPrompt).toContain('以下はこの日の記録の要約である。');
      // ⛔ 日報には床の行を出さない（依頼者の明示指定）。
      expect(dailyPrompt).not.toContain('記憶の床:');

      await s.clone.stop();
    });

    it('2回目の tick で「前回の tick から ±N 文字」が出る（1回目では出ない）。線を超えたら印が出る', async () => {
      const stores = createMemoryStores();
      // 床を動かす口は要旨である（`noteWithSummary` の doc）。
      const summaryChars = 1_000;
      await stores.persona.write('note', noteWithSummary(summaryChars));
      const s = setup(() => 'わかった', stores);
      const call = () => s.calls[0];

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-diff-1',
        at: new Date().toISOString(),
        reason: '1本目',
      });
      await waitFor(() => (call()?.inputs.length ?? 0) === 1, '1本目の入力');
      const firstText = call()?.inputs[0] ?? '';
      expect(firstText).toContain(
        '前回の tick が無いので差分は出せない（このプロセスでの最初の tick）。',
      );
      expect(firstText).not.toMatch(/前回の tick から/);
      // 1本目の tick 自身がセッションを組むので、以後は基準が確立している
      // （閾値 10% を超えないぶんの増分では、線の印はまだ出ない）。
      expect(firstText).not.toContain('⚠️ 線（');

      // 1本目の tick が組んだセッションの基準（= このときの床の絶対値）。
      const baseline = measureMemoryFloor(await stores.persona.documents()).totalChars;

      // 基準から +20% 超の増分を作る（線 = +10% を確実に超える）。
      const extra = Math.ceil(baseline * 0.2) + 50;
      await stores.persona.write('note', noteWithSummary(summaryChars + extra));
      const grownFloor = measureMemoryFloor(await stores.persona.documents()).totalChars;
      const expectedDiff = grownFloor - baseline;
      // **床が本当に増えたことを先に確かめる。** 増えていなければ、この後の
      // 「線に達している」は測れない（本文を伸ばしていた頃の形はここで 0 になり、
      // それでも `+0 文字` の行だけは一致して緑に見えていた）。
      expect(expectedDiff).toBeGreaterThan(baseline * 0.1);

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-diff-2',
        at: new Date().toISOString(),
        reason: '2本目',
      });
      await waitFor(() => (call()?.inputs.length ?? 0) === 2, '2本目の入力');
      const secondText = call()?.inputs[1] ?? '';
      expect(secondText).toContain(
        `前回の tick から +${expectedDiff.toLocaleString('en-US')} 文字。`,
      );
      expect(secondText).toContain('⚠️ 線（セッション構築時点から +10%）に達している。');

      await s.clone.stop();
    });

    /**
     * **この歯は落ちていなかったが、測る対象を失っていた（範囲外の発見を同じ
     * 穴として直した）。** 本文を伸ばす形では床が 1 文字も動かず、それでも
     * 「差分そのものは出る」の側は `+0 文字` が `/前回の tick から \+\d/` に
     * 一致するので緑のままだった —— **増やしていないから印が出ない**状態を、
     * 「増やしたが線に届かないから印が出ない」として読んでいたことになる。
     * ⟹ 要旨で床を動かす形に揃え、**実際に増えたこと**を歯自身が先に確かめる。
     */
    it('線（+10%）を超えないときは印が出ない', async () => {
      const stores = createMemoryStores();
      const summaryChars = 1_000;
      await stores.persona.write('note', noteWithSummary(summaryChars));
      const s = setup(() => 'わかった', stores);
      const call = () => s.calls[0];

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-under-1',
        at: new Date().toISOString(),
        reason: '1本目',
      });
      await waitFor(() => (call()?.inputs.length ?? 0) === 1, '1本目の入力');

      const baseline = measureMemoryFloor(await stores.persona.documents()).totalChars;
      // 基準から +5% ぶんだけ増やす（線 = +10% の半分。確実に超えない）。
      const smallExtra = Math.max(1, Math.floor(baseline * 0.05));
      await stores.persona.write('note', noteWithSummary(summaryChars + smallExtra));
      // 増えたこと（0 ではない）と、線に届いていないことの両方を先に固定する。
      const grownFloor = measureMemoryFloor(await stores.persona.documents()).totalChars;
      expect(grownFloor - baseline).toBeGreaterThan(0);
      expect(grownFloor - baseline).toBeLessThan(baseline * 0.1);

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-under-2',
        at: new Date().toISOString(),
        reason: '2本目',
      });
      await waitFor(() => (call()?.inputs.length ?? 0) === 2, '2本目の入力');
      const secondText = call()?.inputs[1] ?? '';
      // 差分そのものは出るが、線の印は出ない。
      expect(secondText).toMatch(/前回の tick から \+\d/);
      expect(secondText).not.toContain('⚠️ 線（');

      await s.clone.stop();
    });

    /**
     * **線ちょうど（+10.0%）でも印が出る**（`>` ではなく `>=` である、の側）。
     *
     * 依頼者（クローン）が自分の記憶へ書いている語が「+10% に**達した**ので
     * 畳んだ」であること、そして「+10.0% と表示しながら印が出ない」という
     * 表示と判定の食い違いを作らないことの2つが理由（`#memoryFloorDigestLine`
     * の doc）。**境界そのものを測る歯なので、境界に居ることを歯自身が
     * 確かめる**——丸めた百分率がちょうど 10.0 でなければ、この歯は境界を
     * 測っていないことになるので落ちる。
     *
     * **境界へ寄せる口も本文から要旨へ移した**（`noteWithSummary` の doc）。
     * 要旨は 1 文字がそのまま床の 1 文字になるので、`round(基準 × 0.1)` を
     * 足せば床もちょうどその分だけ増える —— **ただし、それが成り立つのは
     * カードの `全 N 文字` の桁が増えないあいだだけである。** 桁が増えると
     * 区切りのコンマぶん床が余計に動くので、境界を跨がない大きさ（4 桁の
     * 内側）に採ってある。**この見立てが外れたら、直後の丸めの確認が落ちる。**
     */
    it('線ちょうど（+10.0%）でも印が出る（線に達したら印、の側）', async () => {
      const stores = createMemoryStores();
      // 基準を 2,000 文字台にする（丸めの窓 ±0.05% が ±1 文字より広くなる
      // 大きさ。小さすぎると `round` の誤差だけで 10.0 から外れる）。
      const summaryChars = 2_000;
      await stores.persona.write('note', noteWithSummary(summaryChars));
      const s = setup(() => 'わかった', stores);
      const call = () => s.calls[0];

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-exact-1',
        at: new Date().toISOString(),
        reason: '1本目',
      });
      await waitFor(() => (call()?.inputs.length ?? 0) === 1, '1本目の入力');

      // 1本目の tick が組んだセッションの基準。
      const baseline = measureMemoryFloor(await stores.persona.documents()).totalChars;
      await stores.persona.write(
        'note',
        noteWithSummary(summaryChars + Math.round(baseline * 0.1)),
      );

      // **歯自身が境界に居ることを確かめる。** 実装と同じ丸め方
      // （小数第1位）で、ちょうど 10.0 になっていること。
      const grown = measureMemoryFloor(await stores.persona.documents()).totalChars;
      expect(Math.round(((grown - baseline) / baseline) * 100 * 10) / 10).toBe(10);

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-exact-2',
        at: new Date().toISOString(),
        reason: '2本目',
      });
      await waitFor(() => (call()?.inputs.length ?? 0) === 2, '2本目の入力');
      expect(call()?.inputs[1] ?? '').toContain(
        '⚠️ 線（セッション構築時点から +10%）に達している。',
      );

      await s.clone.stop();
    });

    it('記憶の床が測れないとき、0 を名乗らず「測れなかった」と言う（digest 本体は壊れない）', async () => {
      const base = createMemoryStores();
      // **床の測定（`#memoryFloorDigestLine`）だけを壊す。** `persona.documents()`
      // は `#buildOptions`（システムプロンプトの組み立て）や `#withFreshMemory`
      // からも呼ばれるので、無条件に投げるとセッションの構築そのものが壊れて
      // ターンが1本も走らなくなる（実測: 無条件に投げると入力がSDKへ一切
      // 届かずタイムアウトした）。tick の digest は `#runInternal`（＝
      // `#ensureQuery`）より前に作られるので、**このターンで最初に呼ばれる
      // 1回**が床の測定である。それだけを壊す。
      let personaDocumentsCalls = 0;
      const stores: Stores = {
        ...base,
        persona: {
          ...base.persona,
          documents: () => {
            personaDocumentsCalls += 1;
            return personaDocumentsCalls === 1
              ? Promise.reject(new Error('persona 読み込み失敗（実測を模す）'))
              : base.persona.documents();
          },
        },
      };
      const s = setup(() => '今回は動かない', stores);

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-unreadable',
        at: new Date().toISOString(),
        reason: '定期 tick',
      });
      await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '1本目の入力');

      const text = s.calls[0]?.inputs[0] ?? '';
      expect(text).toContain(
        '記憶の床: 測れなかった（理由: Error: persona 読み込み失敗（実測を模す））。',
      );
      // 床の行の中に数字を1つも作っていない（0 を名乗っていない）。
      expect(text).not.toMatch(/記憶の床:[^\n]*\d/);
      // digest 本体（`buildActivityDigest`）は persona を見ないので壊れない。
      expect(text).toContain('聞かずに動いたなら');

      await s.clone.stop();
    });

    /**
     * 「基準が取り直された」（resume 等でセッションが組み直され、% が
     * 説明なく下がって見える）警告。
     *
     * **本当に別の値へ組み直させる**（スタブでの偽装ではない）ために、
     * 人間の発言で組んだセッション1を `endSessionAfterTurn: 0` で終わらせ
     * （`#query === null` に戻ることは、既存の歯——このファイルの
     * 「受信箱が閉じた後に…」歯——が同じ形で頼っている観測点である）、
     * その間に記憶の中身を書き換えてから発意 tick を2本続ける。
     *
     * 1本目の tick 自身は「組み直す前」の基準しか知らない（このtickが
     * 新しいセッションを組む張本人であり、digest はそのセッション構築より
     * 前に作られるため）。**基準の食い違いが digest に現れるのは次の
     * tick である** — これは実装（`#lastTickMemoryBaselineChars` を
     * 前回tick時点の値として比べる設計）そのものの帰結であって、この歯が
     * 都合よく2本目まで待っているのではない。
     */
    it('セッションが組み直されて基準が取り直されたら ⚠️ の一言が出る', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('note', `# Note\n\n${'a'.repeat(80)}\n`);
      const s = setup(() => 'わかった', stores, { endSessionAfterTurn: 0 });

      s.clone.post(humanMessage('やあ'));
      await waitForTerminal(s.events);

      const baseline1 = measureMemoryFloor(await stores.persona.documents()).totalChars;
      await stores.persona.write('note', `# Note\n\n${'a'.repeat(500)}\n`);
      const baseline2 = measureMemoryFloor(await stores.persona.documents()).totalChars;
      expect(baseline2).not.toBe(baseline1);

      const flatInputs = () => s.calls.flatMap((call) => call.inputs);

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-rebase-1',
        at: new Date().toISOString(),
        reason: '1本目のtick',
      });
      await waitFor(() => flatInputs().length === 2, '1本目のtickが届く');
      // このtick自身はまだ組み直す前の基準（baseline1）しか知らない。
      expect(flatInputs().at(-1)).not.toContain('セッションが組み直されて基準が');

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-rebase-2',
        at: new Date().toISOString(),
        reason: '2本目のtick',
      });
      await waitFor(() => flatInputs().length === 3, '2本目のtickが届く');
      expect(flatInputs().at(-1)).toContain(
        `⚠️ セッションが組み直されて基準が ${baseline1.toLocaleString('en-US')} → ` +
          `${baseline2.toLocaleString('en-US')} 文字へ取り直された（% が下がったのは畳んだからではない）。`,
      );

      await s.clone.stop();
    });
  });

  it('外部イベントは日誌に残り、中身がクローンに渡る（起点③）', async () => {
    const s = setup(() => '見た');

    s.clone.post({
      type: 'external',
      id: 'evt-ext',
      at: new Date().toISOString(),
      source: 'ci',
      payload: { repo: 'alteroid', status: 'failure' },
    });

    await waitFor(() => inputsOf(s)().includes('"failure"'), 'failure の入力が届く');
    expect(inputsOf(s)()).toContain('source: ci');

    const externals = (await s.stores.journal.list({ types: ['external_event'] })) as {
      source: string;
    }[];
    expect(externals[0]?.source).toBe('ci');

    await s.clone.stop();
  });

  /**
   * issue #1535: 外部イベントの本文が 8,000 文字を超えたとき、プロンプトは
   * 省いた量と全文の取り方を名乗り、日誌には切らずに残る——その取り方で
   * 実際に全文が引けることまで確かめる（取り方を言うだけで取れない形を作らない）。
   */
  it('8,000 文字を超える外部イベントは、プロンプトで量と取り方を名乗り、日誌には全文が残る（issue #1535）', async () => {
    const s = setup(() => '見た');
    const at = new Date().toISOString();
    const big = '外部先頭' + 'w'.repeat(20_000) + '外部末尾';
    s.clone.post({ type: 'external', id: 'evt-big', at, source: 'webhook', payload: big });

    await waitFor(() => inputsOf(s)().includes('外部先頭'), '外部イベントの入力が届く');
    const input = inputsOf(s)();
    expect(input).not.toContain('外部末尾');
    expect(input).toContain('文字省略。全 20,008 文字');
    expect(input).toContain('journal_read');
    expect(input).toContain(`since: "${at}"`);
    expect(input).toContain('日誌には切らずに書いてある');

    const externals = (await s.stores.journal.list({
      types: ['external_event'],
      since: at,
    })) as { summary: string }[];
    expect(externals.some((entry) => entry.summary === big)).toBe(true);

    await s.clone.stop();
  });

  it('8,000 文字以内の外部イベントは、プロンプトの本文を1文字も変えず取り方も足さない（issue #1535）', async () => {
    const s = setup(() => '見た');
    s.clone.post({
      type: 'external',
      id: 'evt-small',
      at: new Date().toISOString(),
      source: 'webhook',
      payload: '小さな外部イベント',
    });
    await waitFor(() => inputsOf(s)().includes('小さな外部イベント'), '外部イベントの入力が届く');
    expect(inputsOf(s)()).not.toContain('文字省略');
    expect(inputsOf(s)()).not.toContain('全文の取り方');
    await s.clone.stop();
  });

  it('日誌の上限（20万字）を超える外部イベントは、日誌でも量を名乗り、プロンプトはそれを言う（issue #1535）', async () => {
    const s = setup(() => '見た');
    const at = new Date().toISOString();
    const huge = '巨大先頭' + 'v'.repeat(250_000);
    s.clone.post({ type: 'external', id: 'evt-huge', at, source: 'webhook', payload: huge });
    await waitFor(() => inputsOf(s)().includes('巨大先頭'), '外部イベントの入力が届く');
    expect(inputsOf(s)()).toContain('日誌にも先頭 200,000 文字までしか残っていない');
    const externals = (await s.stores.journal.list({
      types: ['external_event'],
      since: at,
    })) as { summary: string }[];
    const summary = externals[0]?.summary ?? '';
    expect(summary.startsWith('巨大先頭')).toBe(true);
    expect(summary).toContain('文字省略。全 250,004 文字');
    await s.clone.stop();
  });

  it('締めの時刻で日報が作られ、対象日は発火が運んだ日である（起点② / 可観測性の最上段）', async () => {
    const s = setup(() => '今日はログイン周りを直した。保留は無い。');

    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: new Date().toISOString(),
      kind: 'daily_report',
      // デーモンが止まっていた日を後から締めることがあるので、対象日は運ばれてくる
      target: '2026-08-11',
    });

    await waitForExpect(
      async () => expect(await s.stores.journal.list({ types: ['daily_report'] })).toHaveLength(1),
      'daily_report が日誌に1件積まれる',
    );
    const reports = await s.stores.journal.list({ types: ['daily_report'] });

    expect(reports[0]).toMatchObject({
      date: '2026-08-11',
      body: expect.stringContaining('ログイン周り'),
    });
    expect(inputsOf(s)()).toContain('2026-08-11 を締める');
    // 陰性対照: cause を省略した発火（＝定刻どおり）は日誌に cause=schedule と残る
    expect(await dailyReportCauseLines(s)).toEqual(['cause=schedule']);

    await s.clone.stop();
  });

  /**
   * `daily_report` の後追い（`missingDailyReportDates` →
   * `apps/daemon/src/index.ts` の起動時のループ）が、定刻どおりの発火と日誌の上で
   * 区別できることを確かめる（#635 の「範囲外で気づいたが直さなかったこと」の
   * 続き）。**`clone.ts` の `case 'timer'` は `DAILY_REPORT_KIND` を
   * `journalCause` を組み立てる手前で `#dailyReport` へ逃がしていたので、#635 の
   * 直しは daily_report 経路に一切届いていなかった。**
   */
  it('後追いで作られた日報は、日誌に cause=schedule_catchup として残る', async () => {
    const s = setup(() => '後追いで締めた');

    s.clone.post({
      type: 'timer',
      id: 'evt-timer-catchup',
      at: new Date().toISOString(),
      kind: 'daily_report',
      target: '2026-08-12',
      cause: 'schedule_catchup',
    });

    await waitForExpect(
      async () => expect(await s.stores.journal.list({ types: ['daily_report'] })).toHaveLength(1),
      'daily_report が日誌に1件積まれる',
    );
    expect(await dailyReportCauseLines(s)).toEqual(['cause=schedule_catchup']);

    await s.clone.stop();
  });

  it('手で起こした（/run daily_report）日報は、日誌に cause=manual として残る', async () => {
    const s = setup(() => '手で起こされて締めた');

    s.clone.post({
      type: 'timer',
      id: 'evt-timer-manual',
      at: new Date().toISOString(),
      kind: 'daily_report',
      target: '2026-08-12',
      cause: 'manual',
    });

    await waitForExpect(
      async () => expect(await s.stores.journal.list({ types: ['daily_report'] })).toHaveLength(1),
      'daily_report が日誌に1件積まれる',
    );
    expect(await dailyReportCauseLines(s)).toEqual(['cause=manual']);

    await s.clone.stop();
  });

  it('クローンが自分で日報を書いていれば二重に作らない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'daily_report',
      date: '2026-08-11',
      body: 'クローンが道具で書いた日報',
    });

    const s = setup(() => '書いておいた', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: new Date().toISOString(),
      kind: 'daily_report',
      target: '2026-08-11',
    });

    // ターンが終わったことを内部ターンの日誌で確かめる
    await waitFor(
      async () =>
        ((await stores.journal.list({ types: ['exchange'] })) as { with: string }[]).some(
          (entry) => entry.with === 'self',
        ),
      "with: 'self' の exchange が日誌に積まれる",
    );

    const reports = await stores.journal.list({ types: ['daily_report'] });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ body: 'クローンが道具で書いた日報' });

    await s.clone.stop();
  });

  it('継続中の依頼は、時刻が来たとき本文ごとクローンに渡る（記憶に思い出せるかの賭けにしない）', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'daily', at: '09:00' },
      request: 'このリポジトリの open issue を見て、着手できるものから実装を進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
      lastRunAt: '2026-08-11T00:00:00.000Z',
    });

    const s = setup(() => 'issue を1件拾って委譲した', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    await waitFor(
      () => inputsOf(s)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く',
    );
    // 前回いつ動いたかも渡す（同じ仕事をまっさらから起こさないため）
    expect(inputsOf(s)()).toContain('2026-08-11T00:00:00.000Z');
    expect(inputsOf(s)()).toContain('二重に起こさない');

    // 起きたこと自体が記録され、次の発火では「前回」が更新されている
    await waitForExpect(
      async () =>
        expect((await stores.schedules.get('issue-round'))?.lastRunAt).toBe(
          '2026-08-12T00:00:00.000Z',
        ),
      'issue-round の lastRunAt が更新される',
    );

    await s.clone.stop();
  });

  it('依頼が読めない発火では、本文なしの曖昧なターンを走らせない（読み直して届く）', async () => {
    const stores = createMemoryStores();
    const plan = {
      kind: 'issue-round',
      spec: { type: 'daily' as const, at: '09:00' },
      request: 'このリポジトリの open issue を見て、着手できるものから実装を進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    };
    await stores.schedules.put(plan);

    // 器が一瞬だけ揺れる（pg の瞬断・fs の一時エラー）
    const real = stores.schedules.get.bind(stores.schedules);
    let failures = 1;
    stores.schedules.get = async (kind) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('DB が揺れた');
      }
      return real(kind);
    };

    const s = setup(() => 'issue を1件拾って委譲した', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    // 復旧したら本来の依頼が届く（1周期ぶん落とさない）
    await waitFor(
      () => inputsOf(s)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く',
    );
    // 本文なしの曖昧なターンは走っていない
    expect(inputsOf(s)()).not.toContain('この定期ジョブが何のために仕込まれている');

    await s.clone.stop();
  });

  it('依頼を読めないままなら、その発火では動かず、前回時刻も進めない', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'daily' as const, at: '09:00' },
      request: 'open issue を見て実装を進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    });
    stores.schedules.get = () => Promise.reject(new Error('DB が落ちている'));

    const s = setup(() => '動いてしまった', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    // 読めなかったことは日誌に残る（黙って落とさない）
    await waitFor(
      async () =>
        ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).some((entry) =>
          entry.text.includes('読めなかった'),
        ),
      '『読めなかった』を含む exchange が日誌に積まれる',
    );

    // ターンは1本も走っていない（Fable を曖昧な仕事で消費しない）
    expect(s.calls).toEqual([]);
    // 「動いた」ことにもしない。次の発火で同じ依頼がそのまま来る
    expect((await stores.schedules.list())[0]?.lastRunAt).toBeUndefined();

    await s.clone.stop();
  });

  it('「起きた」を記録できない発火では動かない（動いてから記録できないと二重に走る）', async () => {
    const stores = createMemoryStores();
    const plan = {
      kind: 'issue-round',
      spec: { type: 'daily' as const, at: '09:00' },
      request: 'open issue を見て、着手できるものから実装を進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    };
    await stores.schedules.put(plan);

    // 読めるが書けない（DB の一時障害で UPDATE だけ落ちる）を模す
    const real = stores.schedules.claimRun.bind(stores.schedules);
    let failing = true;
    stores.schedules.claimRun = async (kind, expectedUpdatedAt, at, cause) => {
      if (failing) throw new Error('UPDATE が落ちた');
      return real(kind, expectedUpdatedAt, at, cause);
    };

    const s = setup(() => 'issue を1件拾って委譲した', stores);
    const fire = () => ({
      type: 'timer' as const,
      id: `evt-${Math.random()}`,
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    s.clone.post(fire());

    // ① 記録できないあいだは本体ターンを起こさない（PR や外部操作までやらせない）
    await waitFor(
      async () =>
        ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).some((entry) =>
          entry.text.includes('記録できなかった'),
        ),
      '『記録できなかった』を含む exchange が日誌に積まれる',
    );
    expect(s.calls).toEqual([]);
    expect((await stores.schedules.list())[0]?.lastRunAt).toBeUndefined();

    // ② 復旧すれば、次の発火で依頼の本文つきで動く
    failing = false;
    s.clone.post(fire());

    await waitFor(
      () => inputsOf(s)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く',
    );
    expect((await stores.schedules.list())[0]?.lastRunAt).toBe('2026-08-12T00:00:00.000Z');

    // ③ 走ったのは1回だけ（再起動相当の拾い直しでも二重に実行しない）
    const runs = (await stores.journal.list({ types: ['exchange'] })).filter((entry) =>
      (entry as { text: string }).text.includes('委譲した'),
    );
    expect(runs).toHaveLength(1);

    await s.clone.stop();
  });

  it('記録できなかった発火は、再起動相当の拾い直しでちょうど1回だけ実行される', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'watch',
      spec: { type: 'every' as const, minutes: 60 },
      request: '見張って進める',
      // 「落ちている間に過ぎた予定」として拾われる位置に置く
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });

    const real = stores.schedules.claimRun.bind(stores.schedules);
    let failing = true;
    stores.schedules.claimRun = async (kind, expectedUpdatedAt, at, cause) => {
      if (failing) throw new Error('UPDATE が落ちた');
      return real(kind, expectedUpdatedAt, at, cause);
    };

    const s = setup(() => '進めた', stores);
    const posted: string[] = [];
    const scheduler = createScheduler({
      entries: [],
      post: (event) => {
        posted.push(event.type);
        s.clone.post(event);
      },
      schedules: stores.schedules,
    });

    // 1回目の起動: 過ぎた予定を拾って発火するが、記録できないので動かない
    await scheduler.refresh();
    scheduler.start();
    await waitFor(() => posted.length >= 1, '1件目の投稿');
    scheduler.stop();
    await waitFor(
      async () =>
        ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).some((entry) =>
          entry.text.includes('記録できなかった'),
        ),
      '『記録できなかった』を含む exchange が日誌に積まれる',
    );
    expect(s.calls).toEqual([]);

    // 2回目の起動（器が直っている）: 同じ予定を拾い直して、今度は動く
    failing = false;
    const second = createScheduler({
      entries: [],
      post: (event) => s.clone.post(event),
      schedules: stores.schedules,
    });
    await second.refresh();
    second.start();

    await waitFor(() => inputsOf(s)().includes('見張って進める'), '見張りの入力が届く');
    second.stop();

    // 実際に走ったのは1回だけ
    const runs = (await stores.journal.list({ types: ['exchange'] })).filter(
      (entry) => (entry as { text: string }).text === `${EXCHANGE_KIND_REPLY_PREFIX}進めた`,
    );
    expect(runs).toHaveLength(1);

    await s.clone.stop();
  });

  it('引き受けた直後に落ちた発火は、器を作り直したときに本文つきで配り直される', async () => {
    const stores = createMemoryStores();
    const plan = {
      kind: 'issue-round',
      spec: { type: 'daily' as const, at: '09:00' },
      request: 'open issue を見て、着手できるものから実装を進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    };
    await stores.schedules.put(plan);

    // --- 1回目の器: claim できた直後に中断される -------------------------------
    const crashing = setup(() => '届いていないのに動いた', stores);
    // 「claim は成功したが、モデルへ渡す前に器が落ちた」を作る
    const claim = stores.schedules.claimRun.bind(stores.schedules);
    stores.schedules.claimRun = async (kind, expectedUpdatedAt, at, cause) => {
      await claim(kind, expectedUpdatedAt, at, cause);
      throw new Error('器が落ちた');
    };

    crashing.clone.post({
      type: 'timer',
      id: 'evt-crash',
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    await waitForExpect(
      async () =>
        expect((await stores.schedules.list())[0]?.pendingRun?.at).toBe('2026-08-12T00:00:00.000Z'),
      'pendingRun.at が更新される',
    );
    // モデルには何も届いていない
    expect(crashing.calls).toEqual([]);
    // 定期の基準は進んでいない（「もう動いた」ことにしない）
    expect((await stores.schedules.list())[0]?.lastScheduledRunAt).toBeUndefined();

    // --- 2回目の器: 同じ Stores から作り直す -----------------------------------
    await crashing.clone.stop();
    stores.schedules.claimRun = claim;
    const restarted = setup(() => 'issue を1件拾って委譲した', stores);
    const scheduler = createScheduler({
      entries: [],
      post: (event) => restarted.clone.post(event),
      schedules: stores.schedules,
    });
    await scheduler.refresh();
    scheduler.start();

    // 引き受けたまま終わっていない回が、依頼の本文つきで届く
    await waitFor(
      () => inputsOf(restarted)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く（再起動後）',
    );
    // 走りかけていた可能性は隠さない（二重に手を出す前に確かめさせる）
    expect(inputsOf(restarted)()).toContain('引き受けたまま終わっていない');
    // 添えるのは**元の発火時刻**（復旧時刻に置き換えない）
    expect(inputsOf(restarted)()).toContain('2026-08-12T00:00:00.000Z');

    // 終わったので印は消え、定期の基準が進む
    await waitForExpect(
      async () => expect((await stores.schedules.list())[0]?.pendingRun).toBeUndefined(),
      'pendingRun が消える（undefined になる）',
    );
    expect((await stores.schedules.list())[0]?.lastScheduledRunAt).toBeDefined();

    scheduler.stop();
    await restarted.clone.stop();
  });

  it('配り直された発火は、元の時刻・元の理由で確定する', async () => {
    const stores = createMemoryStores();
    // 09:10 の手動発火を引き受けたまま落ちた状態
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'every' as const, minutes: 60 },
      request: 'open issue を見て実装を進める',
      createdAt: '2026-08-12T08:00:00.000Z',
      updatedAt: '2026-08-12T08:00:00.000Z',
      lastRunAt: '2026-08-12T09:10:00.000Z',
      pendingRun: { at: '2026-08-12T09:10:00.000Z', cause: 'manual' as const },
    });

    const s = setup(() => '配り直された分を見た', stores);
    // スケジューラが配り直す形（元の時刻・元の理由をそのまま運ぶ）
    s.clone.post({
      type: 'timer',
      id: 'evt-resume',
      at: '2026-08-12T09:10:00.000Z',
      kind: 'issue-round',
      cause: 'manual',
    });

    await waitForExpect(
      async () => expect((await stores.schedules.list())[0]?.pendingRun).toBeUndefined(),
      'pendingRun が消える（undefined になる）',
    );

    const after = (await stores.schedules.list())[0];
    // 手で起こした1回だったので、配り直しても定期の基準は動かない
    expect(after?.lastScheduledRunAt).toBeUndefined();
    expect(after?.lastRunAt).toBe('2026-08-12T09:10:00.000Z');
    // 走りかけていたことは元の時刻で伝わる
    expect(inputsOf(s)()).toContain('2026-08-12T09:10:00.000Z');

    await s.clone.stop();
  });

  it('手で起こした発火は、観測用の前回時刻だけを進める（定期の基準は動かさない）', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'every' as const, minutes: 60 },
      request: 'open issue を見て実装を進める',
      createdAt: '2026-08-12T08:00:00.000Z',
      updatedAt: '2026-08-12T08:00:00.000Z',
    });

    const s = setup(() => '手で起こされたので見た', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-manual',
      at: '2026-08-12T09:10:00.000Z',
      kind: 'issue-round',
      cause: 'manual',
    });

    await waitFor(
      () => inputsOf(s)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く',
    );

    const after = (await stores.schedules.list())[0];
    expect(after?.lastRunAt).toBe('2026-08-12T09:10:00.000Z');
    // 定期の予定の基準は動かない（次の起動で位相がずれない）
    expect(after?.lastScheduledRunAt).toBeUndefined();

    await s.clone.stop();
  });

  it('定期の発火は、観測用と定期の基準の両方を進める', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'every' as const, minutes: 60 },
      request: 'open issue を見て実装を進める',
      createdAt: '2026-08-12T08:00:00.000Z',
      updatedAt: '2026-08-12T08:00:00.000Z',
    });

    const s = setup(() => '定期で見た', stores);
    // cause を省略した発火は定期の予定として扱う（schema の既定）
    s.clone.post({
      type: 'timer',
      id: 'evt-schedule',
      at: '2026-08-12T09:00:00.000Z',
      kind: 'issue-round',
    });

    await waitFor(
      () => inputsOf(s)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く',
    );

    const after = (await stores.schedules.list())[0];
    expect(after?.lastRunAt).toBe('2026-08-12T09:00:00.000Z');
    expect(after?.lastScheduledRunAt).toBe('2026-08-12T09:00:00.000Z');

    await s.clone.stop();
  });

  /**
   * 依頼者の観測「その発火が日誌にも記録されない」は、現物と食い違っていた
   * （`main` で再現・確認済み — `turnInputEntry` は定期の発火を毎回1行記録する）。
   * ただし `cause` はもともと `schedule` / `manual` の2値しか無く、「定刻どおり」と
   * 「取りこぼしを拾った」が同じ字面に潰れていた。ここではその3値目
   * （`schedule_catchup`）が、ストア側の呼び出し（`claimRun` / `completeRun` は
   * 引き続き2値のまま）とは独立に、日誌の側だけで区別できることを確かめる。
   */
  it('取りこぼしを拾った発火は、日誌に cause=schedule_catchup として残り、定期の基準も進む', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'every' as const, minutes: 60 },
      request: 'open issue を見て実装を進める',
      createdAt: '2026-08-12T08:00:00.000Z',
      updatedAt: '2026-08-12T08:00:00.000Z',
    });

    const s = setup(() => '取りこぼしを拾って見た', stores);
    // スケジューラが「本当の取りこぼし」を拾ったときに付ける印
    // （`schedule.ts` の `tick()` — `#catchUp` が立っているときだけ）
    s.clone.post({
      type: 'timer',
      id: 'evt-catchup',
      at: '2026-08-13T00:00:00.000Z',
      kind: 'issue-round',
      cause: 'schedule_catchup',
    });

    await waitFor(
      () => inputsOf(s)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く',
    );

    // ストアの呼び出し（claimRun/completeRun）は引き続き2値のまま —
    // 「取りこぼし」でも定期の基準（lastScheduledRunAt）は普通に進む
    const after = (await stores.schedules.list())[0];
    expect(after?.lastRunAt).toBe('2026-08-13T00:00:00.000Z');
    expect(after?.lastScheduledRunAt).toBe('2026-08-13T00:00:00.000Z');

    // 日誌の側は3値目のまま残る（「なぜこの時刻に起きたか」が後から追える）
    const exchanges = (await stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    const turnInputLines = exchanges
      .filter((e) => e.with === 'self' && e.text.startsWith('ターンの入力: timer'))
      .map((e) => e.text);
    expect(turnInputLines).toHaveLength(1);
    expect(turnInputLines[0]).toContain('cause=schedule_catchup');

    await s.clone.stop();
  });

  it('読んでから確定するまでに人間が消したら、取り消された依頼は動かさない', async () => {
    const stores = createMemoryStores();
    const plan = {
      kind: 'issue-round',
      spec: { type: 'daily' as const, at: '09:00' },
      request: 'open issue を見て、着手できるものから実装を進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    };
    await stores.schedules.put(plan);

    // 「読んだ直後に人間の DELETE が着地した」を作る
    const read = stores.schedules.get.bind(stores.schedules);
    let removeOnce = true;
    stores.schedules.get = async (kind) => {
      const found = await read(kind);
      if (removeOnce && found !== null) {
        removeOnce = false;
        await stores.schedules.remove(kind);
      }
      return found;
    };

    const s = setup(() => '消えた依頼で動いてしまった', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    await waitFor(
      async () =>
        ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).some((entry) =>
          entry.text.includes('人間がこの依頼を消した'),
        ),
      '『人間がこの依頼を消した』を含む exchange が日誌に積まれる',
    );

    // 古い本文でも、本文なしの曖昧なターンでも走らせない
    expect(s.calls).toEqual([]);

    await s.clone.stop();
  });

  it('読んでから確定するまでに人間が直したら、新しい本文で動く（古い本文では動かない）', async () => {
    const stores = createMemoryStores();
    const plan = {
      kind: 'issue-round',
      spec: { type: 'daily' as const, at: '09:00' },
      request: '古い依頼: すべての issue を実装する',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    };
    await stores.schedules.put(plan);

    // 「読んだ直後に人間の POST が着地した」を作る
    const read = stores.schedules.get.bind(stores.schedules);
    let editOnce = true;
    stores.schedules.get = async (kind) => {
      const found = await read(kind);
      if (editOnce && found !== null) {
        editOnce = false;
        await stores.schedules.put({
          ...found,
          request: '新しい依頼: bug ラベルの issue だけ直す',
          updatedAt: '2026-08-11T12:00:00.000Z',
        });
      }
      return found;
    };

    const s = setup(() => 'bug の issue を1件拾った', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    await waitFor(
      () => inputsOf(s)().includes('bug ラベルの issue だけ'),
      '『bug ラベルの issue だけ』という入力が届く',
    );
    // 取り消された本文は渡っていない
    expect(inputsOf(s)()).not.toContain('すべての issue を実装する');
    // 発火の跡は新しい版に付く
    expect((await stores.schedules.list())[0]).toMatchObject({
      updatedAt: '2026-08-11T12:00:00.000Z',
      lastRunAt: '2026-08-12T00:00:00.000Z',
    });

    await s.clone.stop();
  });

  it('仕込んだ覚えのない定期ジョブなら、記憶に照らして判断させる（従来の振る舞い）', async () => {
    const s = setup(() => '何もしない');

    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: new Date().toISOString(),
      kind: 'しらない仕込み',
    });

    await waitFor(() => inputsOf(s)().includes('記憶にある'), '記憶の入力が届く');

    await s.clone.stop();
  });

  it('人間の回答待ちが溜まっていても、他の仕事は進む（受け入れ基準2）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: '本番に出してよいか',
    });

    const s = setup(() => '保留は保留のまま、別の件を進める', stores);
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-self',
      at: new Date().toISOString(),
      reason: '定期 tick',
    });

    await waitFor(() => (s.calls[0]?.inputs ?? []).length > 0, '最初の入力');
    // 保留は保留のまま（回答待ちを勝手に片付けない）
    expect(await stores.jobs.listApprovals({ pendingOnly: true })).toHaveLength(1);
    // それでも発意 tick は状況を見て動いている
    expect((s.calls[0]?.inputs ?? []).join('\n')).toContain('本番に出してよいか');

    await s.clone.stop();
  });

  it('読まれる前に積み重なった同じ tick は畳む（発火は減らさない）', async () => {
    // ターンが長引いているあいだに tick が溜まると、同じ材料の同じ判断を
    // 連続で走らせることになる（重複した委譲が起きうる）。読む前の重複には
    // 情報が無いので畳む。回数の上限を置くのとは別物。
    const s = setup(() => '見た', createMemoryStores(), { delayMs: 120 });

    for (let i = 0; i < 4; i += 1) {
      s.clone.post({
        type: 'self_initiative',
        id: `evt-self-${i}`,
        at: new Date().toISOString(),
        reason: '定期 tick',
      });
    }

    // 処理中の1件 + 待ち行列の1件 だけが走る
    await waitForExpect(
      () => expect((s.calls[0]?.inputs ?? []).length).toBeGreaterThanOrEqual(2),
      'クローンへの入力が2件以上に増える',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(s.calls[0]?.inputs).toHaveLength(2);

    await s.clone.stop();
  }, 10_000);

  it('対象日が違う日報は畳まない（別の日の締めは別の仕事）', async () => {
    const stores = createMemoryStores();
    const s = setup(() => '締めた', stores, { delayMs: 60 });

    for (const target of ['2026-08-10', '2026-08-11', '2026-08-11']) {
      s.clone.post({
        type: 'timer',
        id: `evt-${target}-${Math.random()}`,
        at: new Date().toISOString(),
        kind: 'daily_report',
        target,
      });
    }

    await waitForExpect(
      async () => expect(await stores.journal.list({ types: ['daily_report'] })).toHaveLength(2),
      'daily_report が日誌に2件積まれる',
    );

    const dates = ((await stores.journal.list({ types: ['daily_report'] })) as { date: string }[])
      .map((entry) => entry.date)
      .sort();
    expect(dates).toEqual(['2026-08-10', '2026-08-11']);

    await s.clone.stop();
  }, 10_000);

  it('中身のない通知でも「undefined」を読ませない', async () => {
    const s = setup(() => '見た');

    s.clone.post({
      type: 'external',
      id: 'evt-empty',
      at: new Date().toISOString(),
      source: 'cron',
    });

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).join('\n').includes('中身のない通知'),
      '『中身のない通知』を含む入力が届く',
    );
    expect((s.calls[0]?.inputs ?? []).join('\n')).not.toContain('undefined');

    await s.clone.stop();
  });

  it('日報以外の定期ジョブも受け取れる（人間が後から仕込んだもの）', async () => {
    const s = setup(() => '見直した');

    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: new Date().toISOString(),
      kind: 'weekly_review',
    });

    await waitFor(
      () => inputsOf(s)().includes('定期ジョブ weekly_review'),
      '『定期ジョブ weekly_review』という入力が届く',
    );

    await s.clone.stop();
  });
});
