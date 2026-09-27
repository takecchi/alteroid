import { describe, it, expect } from 'vitest';
import type {
  query as sdkQuery,
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { ManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import {
  fakeSdk,
  setup,
  wireEvents,
  waitFor,
  waitForExpect,
  waitForDone,
  flushPendingMicrotasks,
} from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('クローン — マネージャーの確認がいまも待たれているかを確かめてから文言を出す', () => {
  /**
   * `escalation.test.ts` の `fakeManagerSdk()` と同じ形。委譲先（マネージャー）の
   * SDK を模し、`canUseTool` 経由で許可確認を1件降ろせるようにする。
   *
   * ここで模すのはモデルの手（どの道具をどう呼ぶか）だけで、道具の実体・
   * ジョブ台帳・受信箱・マネージャー側の待ち（`ManagerPool`）はすべて本物を通す
   * ——だから `waiting` へ実際に積まれ、実際に消える。
   */
  function fakeManagerSdk() {
    const sessions: {
      options: Options;
      ask: (tool: string, id: string) => Promise<PermissionResult>;
    }[] = [];

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const options = params.options ?? {};

      sessions.push({
        options,
        ask(tool, id) {
          const canUseTool = options.canUseTool as CanUseTool;
          return canUseTool(tool, { command: `${tool}:${id}` }, {
            signal: new AbortController().signal,
            requestId: id,
            toolUseID: id,
          } as never) as Promise<PermissionResult>;
        },
      });

      let finish: (() => void) | null = null;

      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-mgr',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }

      return Object.assign(generate(), {
        close: () => finish?.(),
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    return { fn, sessions };
  }

  /**
   * クローン本体（`s.clone`）とマネージャーのプール（`s.clone.managers`）を、
   * 委譲先の SDK を差し込んだ状態で1つに束ねる。`setup()` を使わないのは、
   * `setup()` の runner が `ask()`（`canUseTool` を叩く口）を持たない別種の
   * 偽 SDK に固定されているため。
   */
  function setupWithManager(reply?: (input: string) => string) {
    const manager = fakeManagerSdk();
    const { fn, calls } = fakeSdk(reply);
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: manager.fn, env: {} }),
      ]),
    });
    return { clone, manager, calls };
  }

  it('待っている確認は、いまの文言（返事をするまで…止まっている）で届く', async () => {
    const { clone, manager, calls } = setupWithManager();

    const { managerId } = await clone.managers.start({ request: '1件確認する仕事' });
    const session = manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // 生きている確認（`waiting` に積まれたまま）を作る。
    void session.ask('Bash', 'req-live');

    // ⚠️ 待ちの最初の1回は、1件目の呼び出しが積まれる前にも評価される。
    // **例外を投げる形にしないこと** —— `waitFor` は `check` の例外を再試行
    // しないので、`expect.poll` の頃は再試行で吸われていた `undefined` の
    // 読み取りが、そのままテストの失敗になる（#1220 の置き換えで実際に踏んだ）。
    const inputs = (): string[] => calls[0]?.inputs ?? [];
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('req-live'))).toBeTruthy(),
      '『req-live』を含む入力が届く',
    );
    const text = inputs().find((input) => input.includes('req-live')) ?? '';

    expect(text).toContain(`返事をするまで ${managerId} のこの1件だけが止まっている`);
    expect(text).toContain('manager_send');
    expect(text).toContain('ask_human');
    expect(text).not.toContain('もう待たれていない');

    await clone.stop();
  });

  it('waiting から消えた確認は、その文言では届かない（答え直せと言わない）', async () => {
    const { clone, manager, calls } = setupWithManager();

    const { managerId } = await clone.managers.start({ request: '1件確認する仕事' });
    const session = manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // 一度は生きている確認として届く。
    const pending = session.ask('Bash', 'req-settled');
    // ⚠️ 待ちの最初の1回は、1件目の呼び出しが積まれる前にも評価される。
    // **例外を投げる形にしないこと** —— `waitFor` は `check` の例外を再試行
    // しないので、`expect.poll` の頃は再試行で吸われていた `undefined` の
    // 読み取りが、そのままテストの失敗になる（#1220 の置き換えで実際に踏んだ）。
    const inputs = (): string[] => calls[0]?.inputs ?? [];
    await waitFor(
      () => inputs().some((input) => input.includes('req-settled')),
      '『req-settled』を含む入力が届く',
    );

    // 本物の応答経路（`manager.ts` の `send()`）で解く。runner 側の
    // `canUseTool` が解決し、`'settled'` RunnerEvent を経て `waiting` から
    // 消えるところまで、本物の機構をそのまま通す。
    const sendResult = await clone.managers.send(managerId, 'それでよい', {
      requestId: 'req-settled',
      decision: 'allow',
    });
    expect(sendResult.outcome).toBe('answered');
    expect(await pending).toEqual({ behavior: 'allow' });

    // `waiting` から実際に消えたことを確認する（この直しが効く前提）。
    await waitForExpect(
      async () =>
        expect(
          (await clone.managers.list())
            .find((m) => m.managerId === managerId)
            ?.waiting.map((w) => w.requestId),
        ).toEqual([]),
      'managerId のマネージャーの waiting からリクエストが消える',
    );

    // ここからが本題 — **解決済みの確認が、再送のように同じ requestId で
    // もう一度届く**（実測されたバグの形。`ManagerPool#emit` が毎回新しい
    // event.id を発行する経路なので、`id` だけ変えて模す）。
    clone.post({
      type: 'manager_message',
      id: 'evt-redelivered',
      at: new Date().toISOString(),
      managerId,
      kind: 'permission',
      text: 'Bash の実行許可: req-settled（再送）',
      requestId: 'req-settled',
    });

    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('再送'))).toBeTruthy(),
      '『再送』を含む入力が届く',
    );
    const redelivered = inputs().find((input) => input.includes('再送')) ?? '';

    // 「答え直せ」という指示が1文字も無いこと。
    expect(redelivered).not.toContain('返事をするまで');
    expect(redelivered).not.toContain('manager_send');
    expect(redelivered).not.toContain('ask_human');
    expect(redelivered).toContain('もう待たれていない');

    await clone.stop();
  });

  /**
   * 変異試験で見つかった穴の埋め合わせ（このテストが無いと、`confirmationLiveness`
   * の `summaries.find((entry) => entry.managerId === managerId)` を
   * `find((entry) => true)` へ変異させても151本が全通過し、生存した）。
   *
   * 上の2本（生きている確認／消えた確認）はどちらもマネージャーが1体しか
   * 走っていない。`managerId` で絞らずに `list()` の先頭要素を拾っても、
   * 候補が1件しか無ければ偶然当たってしまい、絞り込みそのものは測れない。
   *
   * ここでは2体のマネージャーを走らせ、**同じ requestId 文字列**を使って
   * 「mgr-A の確認は解決済み・mgr-B の確認は生きている」という組を作る。
   * `list()` は `startedAt` の降順で返す（`manager.ts` の `list()`）ので、
   * 後から始めた mgr-B が並びの先頭に来る——`managerId` を見ずに先頭を拾う
   * 実装なら、mgr-A への再送を mgr-B の「生きている」で答えてしまう。
   */
  it('別のマネージャーの生きている確認と混ざらない（managerId で絞り込む）', async () => {
    const { clone, manager, calls } = setupWithManager();

    // mgr-A — 先に始め、確認を1件解いておく（waiting から消える）。
    const { managerId: managerA } = await clone.managers.start({ request: 'A の仕事' });
    const sessionA = manager.sessions[0];
    if (!sessionA) throw new Error('mgr-A のセッションが無い');
    const pendingA = sessionA.ask('Bash', 'req-shared');
    // ⚠️ 待ちの最初の1回は、1件目の呼び出しが積まれる前にも評価される。
    // **例外を投げる形にしないこと** —— `waitFor` は `check` の例外を再試行
    // しないので、`expect.poll` の頃は再試行で吸われていた `undefined` の
    // 読み取りが、そのままテストの失敗になる（#1220 の置き換えで実際に踏んだ）。
    const inputs = (): string[] => calls[0]?.inputs ?? [];
    await waitFor(
      () => inputs().some((input) => input.includes('req-shared')),
      '『req-shared』を含む入力が届く',
    );
    const sendResult = await clone.managers.send(managerA, 'それでよい', {
      requestId: 'req-shared',
      decision: 'allow',
    });
    expect(sendResult.outcome).toBe('answered');
    expect(await pendingA).toEqual({ behavior: 'allow' });
    await waitForExpect(
      async () =>
        expect(
          (await clone.managers.list())
            .find((m) => m.managerId === managerA)
            ?.waiting.map((w) => w.requestId),
        ).toEqual([]),
      'managerA の waiting からリクエストが消える',
    );

    // mgr-B — 後から始め、**同じ requestId 文字列**で確認を出したまま
    // （waiting に残る＝生きている）。
    const { managerId: managerB } = await clone.managers.start({ request: 'B の仕事' });
    const sessionB = manager.sessions[1];
    if (!sessionB) throw new Error('mgr-B のセッションが無い');
    void sessionB.ask('Bash', 'req-shared');
    await waitForExpect(
      async () =>
        expect(
          (await clone.managers.list())
            .find((m) => m.managerId === managerB)
            ?.waiting.map((w) => w.requestId),
        ).toEqual(['req-shared']),
      'managerB の waiting に req-shared が残る',
    );
    // 並び順の前提（後から始めた mgr-B が先頭）を自分で確かめる。
    const order = (await clone.managers.list()).map((m) => m.managerId);
    expect(order[0]).toBe(managerB);

    // ここからが本題 — **解決済みの mgr-A の確認**が、同じ requestId で
    // もう一度届く。生きているのは mgr-B の同名確認だけである。
    clone.post({
      type: 'manager_message',
      id: 'evt-cross-manager',
      at: new Date().toISOString(),
      managerId: managerA,
      kind: 'permission',
      text: 'Bash の実行許可: req-shared（mgr-A への再送）',
      requestId: 'req-shared',
    });

    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('mgr-A への再送'))).toBeTruthy(),
      '『mgr-A への再送』を含む入力が届く',
    );
    const redelivered = inputs().find((input) => input.includes('mgr-A への再送')) ?? '';

    // mgr-B の生存に引きずられず、mgr-A の確認として「もう待たれていない」。
    expect(redelivered).toContain('もう待たれていない');
    expect(redelivered).not.toContain('返事をするまで');

    await clone.stop();
  });

  it('managers.list() が投げても、ターンは落ちず、いまの文言のまま届く', async () => {
    const { fn, calls } = fakeSdk();
    // `list()` だけ必ず投げる、それ以外は呼ばれない前提のスタブ。
    // ManagerPool の全メソッドを実装するが、このテストで使うのは `list` だけ。
    const throwingPool: ManagerPool = {
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
      list: () => {
        throw new Error('list() が壊れている（実測を模す）');
      },
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
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      managers: throwingPool,
    });

    clone.post({
      type: 'manager_message',
      id: 'evt-permission-unknown',
      at: new Date().toISOString(),
      managerId: 'mgr-unknown',
      kind: 'permission',
      text: 'Bash の実行許可: 確かめられない',
      requestId: 'req-unknown',
    });

    // ⚠️ 待ちの最初の1回は、1件目の呼び出しが積まれる前にも評価される。
    // **例外を投げる形にしないこと** —— `waitFor` は `check` の例外を再試行
    // しないので、`expect.poll` の頃は再試行で吸われていた `undefined` の
    // 読み取りが、そのままテストの失敗になる（#1220 の置き換えで実際に踏んだ）。
    const inputs = (): string[] => calls[0]?.inputs ?? [];
    // **ターンが落ちずに進むこと自体が主張である。** list() が投げたまま
    // ターンが止まれば、この poll はタイムアウトで落ちる。
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('確かめられない'))).toBeTruthy(),
      '『確かめられない』を含む入力が届く',
    );
    const text = inputs().find((input) => input.includes('確かめられない')) ?? '';

    // 確かめられなかった側は安全側（いまの文言のまま）へ倒す。
    expect(text).toContain('返事をするまで mgr-unknown のこの1件だけが止まっている');
    expect(text).toContain('manager_send');
    expect(text).not.toContain('もう待たれていない');

    await clone.stop();
  });

  it('report の文言は変わらない（kind !== question/permission は判定しない）', async () => {
    const { clone, calls } = setupWithManager();

    clone.post({
      type: 'manager_message',
      id: 'evt-report-unchanged',
      at: new Date().toISOString(),
      managerId: 'mgr-report',
      kind: 'report',
      text: '直しました（報告のみ）',
    });

    // ⚠️ 待ちの最初の1回は、1件目の呼び出しが積まれる前にも評価される。
    // **例外を投げる形にしないこと** —— `waitFor` は `check` の例外を再試行
    // しないので、`expect.poll` の頃は再試行で吸われていた `undefined` の
    // 読み取りが、そのままテストの失敗になる（#1220 の置き換えで実際に踏んだ）。
    const inputs = (): string[] => calls[0]?.inputs ?? [];
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('直しました（報告のみ）'))).toBeTruthy(),
      '『直しました（報告のみ）』を含む入力が届く',
    );
    const text = inputs().find((input) => input.includes('直しました（報告のみ）')) ?? '';

    expect(text).toContain('（報告）');
    expect(text).toContain('続きが要るなら `manager_send` で指示を出し');
    expect(text).not.toContain('止まっている');
    expect(text).not.toContain('もう待たれていない');

    await clone.stop();
  });
});

/**
 * shutdown 蒸留が conversation_end 蒸留と重複して走るのを防ぐ直し（`d247074`）の歯。
 *
 * PR #119 の残作業 — 実装（`#hasUndistilledActivity` と、`#handle` の `'distill'`
 * 分岐が前回の蒸留成功以降にターンが1本も無ければ見送る判定）に、これまで
 * テストが1本も無かった。
 *
 * **「起きなかったこと」は見送り自身が能動的に書く合図（日誌の `exchange`。
 * `with: 'self'` / `role: 'outbound'` / 本文に「蒸留（<reason>）は見送った」を
 * 含む）で見る。** `await` が返った時点でこの行は確定済みであり、タイムアウトで
 * 「来なかったから見送ったはず」と読むのは `waitForTerminal` の doc が明記して
 * いるとおり歯があった証拠にならない（別の負荷で `done` そのものが遅れても
 * 同じ見え方になる）。
 */
describe('クローン — shutdown 蒸留の重複防止', () => {
  /** `buildDistillPrompt` が書く固定の呼びかけ。蒸留ターンかどうかの見分け方。 */
  const DISTILL_MARKER = '記憶へ移すべきものがあるか確認せよ';

  /** 見送りの日誌（`type: 'exchange'` / `with: 'self'` / `role: 'outbound'`）だけを拾う。 */
  async function skippedDistillEntries(
    stores: Stores,
  ): Promise<{ text: string; with: string; role: string }[]> {
    const entries = (await stores.journal.list({ types: ['exchange'] })) as {
      text: string;
      with: string;
      role: string;
    }[];
    return entries.filter(
      (entry) =>
        entry.with === 'self' && entry.role === 'outbound' && entry.text.includes('は見送った'),
    );
  }

  it('A: endConversation の直後に stop() が来ても、蒸留は1回しか走らない', async () => {
    const s = setup();

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');
    await s.clone.stop();

    const inputs = (s.calls[0] as FakeCall).inputs;
    const distillPrompts = inputs.filter((input) => input.includes(DISTILL_MARKER));
    expect(distillPrompts.length).toBe(1);

    const skipped = await skippedDistillEntries(s.stores);
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.text).toContain('蒸留（shutdown）は見送った');
  });

  it('B: 蒸留の後に新しいターンが1本でも走れば、続く stop() の蒸留は見送らない（取りこぼさない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    // 別の会話で通常ターンをもう1本。`s.events` は conv-1 専用の購読なので、
    // conv-2 用の購読をここで別に張って「その通常ターンが終わったこと」を
    // 直接待つ（既存の `wireEvents` をそのまま使い回す — 新しい足場は作らない）。
    const other = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('別件です', 'conv-2'));
    await waitForDone(other.events);

    await s.clone.stop();

    const inputs = (s.calls[0] as FakeCall).inputs;
    const distillPrompts = inputs.filter((input) => input.includes(DISTILL_MARKER));
    expect(distillPrompts.length).toBe(2);
    expect(await skippedDistillEntries(s.stores)).toEqual([]);
  });

  it('C: 蒸留が失敗して終わったら印を下ろさない（次の機会にもう一度試す）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      // ターン0＝人間の発言、ターン1＝endConversation の蒸留。**蒸留のターンだけ**
      // を失敗させる。`error_during_execution` は枠の保持にはならない分類
      // （`classifyUsageNotice` は SDK が失敗として出した文言だけを見るので、
      // 既定の応答文言のままなら `#usageBlocked` は立たない）。
      resultFor: (turnIndex) =>
        turnIndex === 1 ? { subtype: 'error_during_execution', isError: true } : undefined,
    });

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');
    await s.clone.stop();

    const inputs = (s.calls[0] as FakeCall).inputs;
    const distillPrompts = inputs.filter((input) => input.includes(DISTILL_MARKER));
    // 失敗した蒸留は印を下ろさないので、stop() の蒸留は見送られず、もう一度走る。
    expect(distillPrompts.length).toBe(2);
    expect(await skippedDistillEntries(s.stores)).toEqual([]);
  });

  it('D: 最初の会話終了では、蒸留が見送られずにちゃんと走る（重複防止が正常な経路を殺していない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    // **ここでアサーションを済ませる。** この時点で `endConversation` の蒸留は
    // 成功しており印は下りているので、この後 `stop()` を呼ぶと、その shutdown
    // 蒸留は「正しく」見送られる（歯Aの管轄）。`stop()` の後で「見送りが無い」を
    // 検査すると、この歯が自分の生んだ見送りエントリで落ちる。
    const inputs = (s.calls[0] as FakeCall).inputs;
    const distillPrompts = inputs.filter((input) => input.includes(DISTILL_MARKER));
    expect(distillPrompts.length).toBe(1);
    expect(await skippedDistillEntries(s.stores)).toEqual([]);

    await s.clone.stop();
  });

  /**
   * **Issue #1650**: `#handle` の `case 'distill'` は `if (!this.#sdkSession.query)
   * return;` で、セッションが無ければ**蒸留を試みずに戻る**。ここまでは意図どおり
   * （記憶へ移す先の会話そのものが器の中に無い）——直したのは、**活動が在るのに
   * 見送るときは、その事実を兄弟の分岐（`!hasUndistilledActivity`）と同じ形で
   * 日誌へ残す**ことである。直す前はここが完全に沈黙しており、見送ったという
   * 事実そのものがどこにも残らなかった（PR #1650 の元になった調査）。
   *
   * `#read` の `finally` は `this.#sdkSession.clearQuery()` を呼ぶが、
   * `#salvageTranscript()`（＝蒸留）へ進むのは**文脈窓で畳んだ回**
   * （`takeContextWindowRecycle()` が真）にだけである。**畳みが絡まない理由で
   * セッションの読み取りループがただ終わる回**（`endSessionAfterTurn` が模す。
   * 実機なら SDK 子プロセスの静かな終了・ネットワークの瞬断など）は、その
   * `finally` が退避も蒸留も試みない——`this.#stores.sessions
   * .setCloneSessionId(null)` も呼ばれないので、記憶ストアの `cloneSessionId`
   * は死んだセッションの id を指したまま残る（＝次の `#ensureQuery` は
   * `resume` でそこへ戻れる）。
   *
   * この歯が固定するのは3点—— (1) 見送るときは蒸留のターンを1本も走らせない
   * (2) 見送ったことが `skippedDistillEntries` と同じ形で日誌に1件残る、
   * 文面に `event.reason` と「セッションが無い」ことが入る (3) **未蒸留の
   * 活動の印は倒さない**——セッションが戻らないまま同じ理由の蒸留契機が
   * もう一度来ても、まだ「活動が在る」側の見送り（journal に残るほう）のまま
   * であり続ける。
   *
   * ## ⚠️ (3) を「別会話の人間の発言でセッションを戻してから確かめる」形に
   * しなかった理由
   *
   * `#runTurn` の `markActivity()`（`kind !== 'distill'` のターンなら無条件に
   * 呼ぶ）は、セッションを戻すために要る通常のターンそのものが**印を無条件に
   * 立て直してしまう**——立て直った印は「倒していなかったから真」なのか
   * 「間違って倒したのを、この回復ターンが上書きして真に戻したから真」なのか
   * 外から区別できない（実際、`markDistilled()` を見送りの枝へ誤って足す変異を
   * 当てても、この形の歯は緑のまま通ってしまうことを確かめた上でここへ書いて
   * いる）。**⟹ 通常のターンを1本も挟まずに、同じ見送りがもう一度起きるかで
   * 確かめる。**
   */
  it('E: セッションが（畳みとは無関係に）自然に終わった直後は、蒸留は走らないが見送りが日誌に残り、活動の印は倒れない（Issue #1650）', async () => {
    const s = setup(() => 'わかった', createMemoryStores(), { endSessionAfterTurn: 0 });

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    // `#read` の `finally` が `this.#sdkSession.clearQuery()` を打ち終える
    // （＝ `#sdkSession.query === null` に戻る）のを待つ。同じ手当てはこの
    // ファイルの「受信箱が閉じた後に…」歯・`flushPendingMicrotasks` の doc。
    await flushPendingMicrotasks();

    const journalCountBefore = (await s.stores.journal.list({})).length;
    await s.clone.endConversation('conv-1');
    const journalCountAfter = (await s.stores.journal.list({})).length;

    // (1) 蒸留のターンは1本も走っていない —— 本流セッションの呼び出しは1本のまま。
    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs.filter((input) => input.includes(DISTILL_MARKER)).length).toBe(0);

    // (2) 見送ったことが日誌に1件だけ増え、文面に reason と「セッションが無い」が入る。
    expect(journalCountAfter).toBe(journalCountBefore + 1);
    const skipped = await skippedDistillEntries(s.stores);
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.text).toContain('蒸留（conversation_end）は見送った');
    expect(skipped[0]?.text).toContain('セッションが無い');

    // (3) 活動の印は倒れていない ⟹ セッションが戻らないまま、通常のターンを
    // 1本も挟まずにもう一度同じ理由の蒸留契機が来ても、「活動が在る」側の
    // 見送り(journal に残る)がもう一度起きる。
    const journalCountBeforeSecond = journalCountAfter;
    await s.clone.endConversation('conv-1');
    const journalCountAfterSecond = (await s.stores.journal.list({})).length;
    expect(journalCountAfterSecond).toBe(journalCountBeforeSecond + 1);
    expect((await skippedDistillEntries(s.stores)).length).toBe(2);

    await s.clone.stop();
  });

  /**
   * **Issue #1650 の裏面**: セッションが無く、かつ**移すものも無い**
   * （＝直前の蒸留で `hasUndistilledActivity` が既に倒れている）ときは、
   * これまでどおり黙って見送る——起動直後の停止などで、毎回日誌を増やさない
   * ための意図的な沈黙である。歯Eの「活動が在るときは残す」と対にして固定する。
   */
  it('F: セッションが無く、未蒸留の活動も無ければ、これまでどおり日誌を増やさず黙って見送る（Issue #1650）', async () => {
    // ターン0＝人間の発言、ターン1＝1回目の endConversation が起こす蒸留。
    // その蒸留が成功で終わった直後にセッションを終わらせる。
    const s = setup(() => 'わかった', createMemoryStores(), { endSessionAfterTurn: 1 });

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');
    // 蒸留が成功したので `hasUndistilledActivity` は倒れている
    // （`skippedDistillEntries` は歯Aと同じ確認方法）。
    expect(await skippedDistillEntries(s.stores)).toEqual([]);
    const distillPrompts = (s.calls[0] as FakeCall).inputs.filter((input) =>
      input.includes(DISTILL_MARKER),
    );
    expect(distillPrompts.length).toBe(1);

    // `#read` の `finally` が `this.#sdkSession.clearQuery()` を打ち終えるのを待つ。
    await flushPendingMicrotasks();

    const journalCountBefore = (await s.stores.journal.list({})).length;
    // セッションも活動も無い状態で、もう一度 `case 'distill'` へ届かせる。
    await s.clone.endConversation('conv-1');
    const journalCountAfter = (await s.stores.journal.list({})).length;

    expect(journalCountAfter).toBe(journalCountBefore);
    expect(await skippedDistillEntries(s.stores)).toEqual([]);

    await s.clone.stop();
  });

  /**
   * **横断レビューの指摘（後始末、まだ再現していない段階の赤取り）**: 歯Fが
   * 「活動も無ければ黙る」を確かめるとき使っているのは、**蒸留を1回成功させて
   * `hasUndistilledActivity` を倒した後**の「活動が無い」状態である。**一度も
   * ターンを走らせていないクローン**（起動直後、まだ何も無い）は別の状態
   * ——`CloneDistillMemoryState#hasUndistilledActivity` の初期値は `true`
   * （doc:「知れないなら蒸留する側を既定にする」）——であり、歯Fはこちらを
   * 検査していない。
   *
   * 定期の棚卸し（`reason: 'scheduled'`）を、一度もターンを走らせていない
   * クローンへ2日ぶん送ると、`#sdkSession.query === null` かつ
   * `hasUndistilledActivity === true` の組み合わせが**起動直後から**成立して
   * いるため、PR #1653 が足した「活動が在る」枝へ毎回入り、日誌が1行ずつ
   * 増え続ける（はず）。
   */
  it('G: 一度もターンを走らせていないクローンに定期の棚卸しを2日ぶん送っても、日誌は増えないはず（横断レビューの指摘、Issue 未起票）', async () => {
    const s = setup();

    const journalCountBefore = (await s.stores.journal.list({})).length;

    s.clone.post({
      type: 'distill',
      id: 'evt-tidy-day1',
      at: new Date().toISOString(),
      reason: 'scheduled',
    });
    await flushPendingMicrotasks();
    const journalCountAfterDay1 = (await s.stores.journal.list({})).length;

    s.clone.post({
      type: 'distill',
      id: 'evt-tidy-day2',
      at: new Date().toISOString(),
      reason: 'scheduled',
    });
    await flushPendingMicrotasks();
    const journalCountAfterDay2 = (await s.stores.journal.list({})).length;

    // 一度も活動していないクローンなら、定期の棚卸しが何日回っても
    // 日誌は増えないはず ——「見送った」の1行が積み上がるのはバグである。
    expect(journalCountAfterDay1).toBe(journalCountBefore);
    expect(journalCountAfterDay2).toBe(journalCountAfterDay1);

    await s.clone.stop();
  });
});

/**
 * `self_status`（`self.ts` の `CloneRuntimeFacts`）の配線。
 *
 * **`createSdkMcpServer` は道具を MCP の transport の裏へ隠すので、テストから
 * ハンドラを直接呼べない。** `mcpServerFactory`（クローンの `CloneOptions`。
 * 主にテスト用、既定は `createCloneMcpServer`）でその境界を覗く — 差し替えた
 * 関数は渡ってきた `context`（クローンが実際に組み立てたもの。`runtime` を含む）
 * を控えたうえで、本物の `createCloneMcpServer(context)` をそのまま呼ぶ。
 * 道具の実装もクローンが渡す `context` も本物のまま、呼び出しの境界だけを覗ける。
 *
 * `self_status` 自身のハンドラは、控えた `context` から独立に
 * `createCloneTools(context)` を呼んで取り出す（`tools.test.ts` と同じ形）。
 */
