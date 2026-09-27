import { describe, it, expect } from 'vitest';
import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { TokenRotatorObservation } from './token-rotator.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent } from './schema.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, setup, wireEvents, waitFor, waitForTerminal } from './clone-test-harness.js';

describe('onUsageObservation（回し手へ渡す観測）', () => {
  let seq = 0;

  function cloneObserving(input: {
    sdkOptions?: Parameters<typeof fakeSdk>[1];
    identity?: { tokenId: string; generation: number };
    onObserve?: (o: TokenRotatorObservation) => Promise<void>;
  }) {
    const seen: TokenRotatorObservation[] = [];
    const { fn, calls } = fakeSdk(undefined, input.sdkOptions ?? {});
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      ...(input.identity === undefined ? {} : { tokenIdentity: () => input.identity }),
      onUsageObservation:
        input.onObserve ??
        (async (o) => {
          seen.push(o);
        }),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    // **届いた報告そのものを見られるようにする**（#935）。`calls`（SDK が何回
    // 呼ばれたか）だけでは「ターンが壊れなかった」までしか言えず、**どの報告が
    // 届いたか**——この節がいちばん測りたいこと——に一度も触れない。
    const { events } = wireEvents(clone, 'conv-1');
    return { clone, calls, seen, events };
  }

  /**
   * **枠の観測だけを取り出す**（#681 (1)）。この口には `succeeded: true`
   * ——ターンが実際に成功したという観測（`usable` の2本目の生産者）——も
   * 流れる。**位置で取ると種類の違うものを掴む**ので、数える前に絞る。
   */
  function limitsOf(seen: readonly TokenRotatorObservation[]): TokenRotatorObservation[] {
    return seen.filter((o) => o.succeeded !== true);
  }

  function say(clone: ReturnType<typeof createClone>): void {
    clone.post({
      type: 'human_message',
      id: `evt-obs-${String(++seq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
  }

  it('文言から分類した通知は、そのまま notice として渡る', async () => {
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        resultSubtype: 'error_during_execution',
        resultText: "You've hit your org's monthly spend limit",
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    expect(seen[0]?.notice?.kind).toBe('reached');
    // **文言をそのまま持つ**（言い換えると回復の見込みの分類が効かなくなる）。
    expect(seen[0]?.notice?.text).toContain("You've hit your");
  });

  /**
   * **この歯がこの配線でいちばん重い。**
   *
   * `#noteUsageNotice` は `rate_limit_event` 経路からも呼ばれ、そこで
   * `rejectedRateLimitNotice` が `reached` の形の通知を作る。**それを回し手へ
   * `notice` として渡すと、`overage_exhausted` の設定でも課金枠を1円も使わずに
   * 回る**（Issue #393 追記1 の訂正がまさにこの取り違えを直したものである）。
   */
  it('⚠️ rate_limit_event は notice ではなく、事実と遷移で渡る', async () => {
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    const observation = seen[0];
    // **notice を持たない。** 持っていたら、それは仕立て直した `reached` である。
    expect(observation).not.toHaveProperty('notice');
    expect(observation?.transition).toBe('rejected');
    expect(observation?.facts?.status).toBe('rejected');
  });

  it('同じ rejected が毎ターン来ても、遷移として渡るのは1回だけ', async () => {
    // `rate_limit_event` はターンの頭ごとに来る。状態をそのまま流すと、1回の
    // 当たりでプールを何本も食う。
    //
    // **⚠️ #668 で「渡すのは1回だけ」ではなくなった。この歯は反転していない**
    // —— もともと `transition === 'rejected'` で絞って数えていたので、測って
    // いるのは「遷移として渡るのは1回」であり、それはいまも真である。
    // **2回目以降は `statusNow` だけを運んで渡る**（下の「状態だけを運んで渡る」）。
    // プールを食い潰さない保証は世代が持つ（`token-rotation.ts` の `freshness`）。
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '1回目の観測');
    say(clone);
    say(clone);
    await waitFor(() => seen.length > 0, '追加のターン');
    clone.stop();

    expect(seen.filter((o) => o.transition === 'rejected')).toHaveLength(1);
  });

  it('#668: 2回目以降の rejected も、状態だけを運んで渡る', async () => {
    // **遷移だけを渡していたので、同じ `kind` の `rejected` が別のトークンで
    // 再発しても回し手へ1度も届かなかった**（`#rateLimits` はこのインスタンスの
    // 寿命ぶん残る）。⟹ 記録は `ready` のまま、実際は 429。
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '1回目の観測');
    say(clone);
    await waitFor(() => limitsOf(seen).length > 1, '2回目の観測');
    clone.stop();

    // **枠の観測だけを取り出してから数える**（#681 (1)）。この口には
    // `succeeded: true`（ターンが成功したという観測。2本目の `usable` の
    // 生産者）も流れるようになったので、**位置で取ると成功の観測を掴む。**
    // 番号をずらして直すのではなく、種類で絞る —— 位置で合っていたのは
    // たまたまであって、この歯が測りたいのは「2件目の枠の観測」である。
    const limits = limitsOf(seen);
    // **重ねる前の生の1件から取る。** 重ねた形の `status` はアカウントを跨いで
    // 残るので、契機の材料にすると回した直後の健全な鍵でもう一度回る。
    expect(limits[1]?.statusNow).toBe('rejected');
    expect(limits[1]?.transition).toBeUndefined();
  });

  it('セッションが起きたときの身元を、その観測すべてに添える', async () => {
    const { clone, seen } = cloneObserving({
      identity: { tokenId: 'tok-a', generation: 3 },
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    expect(seen[0]?.observedBy).toEqual({ tokenId: 'tok-a', generation: 3 });
  });

  it('身元が無ければ添えない（unknown へ倒すのは回し手の側）', async () => {
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    expect(seen[0]).not.toHaveProperty('observedBy');
  });

  /**
   * ⭐ **この歯は「空で緑」だった**（#935）。唯一の表明が
   * `expect(calls.length).toBeGreaterThan(0)` で、その値は**直前の
   * `await waitFor(() => calls.length > 0)` が既に真にしたもの**だった
   * （`waitFor` は打ち切りで throw するので、次の行に届いた時点で必ず 1 以上）。
   * ⟹ 名乗っている「**別の失敗で上限の報告を置き換えない**」を、どの行も
   * 測っていなかった。
   *
   * **測るべきものは3つある**（`#observeForTokenRotation` の doc が言っている
   * とおりの3つである）:
   *
   * 1. **上限の報告がそのまま人間へ届く** —— `usage_limited` の本文が上限の文言で
   *    あって、「回し手が落ちた」ではないこと。**ここが置き換わるのが、この節が
   *    名指ししている欠陥である。**
   * 2. **ターンは終端まで走る** —— 回し手の失敗で途中で切れない
   * 3. **回し手の失敗は黙って消えない** —— 跡（`noteDroppedRecord`）が残る。
   *    ⛔ ここを落とすと「握り潰してよい」に化ける
   */
  it('回し手が投げてもターンを壊さない（別の失敗で上限の報告を置き換えない）', async () => {
    const limitText = "You've hit your org's monthly spend limit";
    const { clone, calls, events } = cloneObserving({
      onObserve: () => Promise.reject(new Error('回し手が落ちた')),
      sdkOptions: { resultSubtype: 'error_during_execution', resultText: limitText },
    });

    const lines = await captureStderr(async () => {
      say(clone);
      // セッションは開き、**ターンは終端（error / done）まで走る。**
      await waitForTerminal(events);
    });
    await clone.stop();

    // 1. 上限の報告が、回し手の失敗に置き換えられずに届く。
    const limited = events.filter((event) => event.type === 'usage_limited');
    expect(limited).toHaveLength(1);
    const message = (limited[0] as Extract<ChatStreamEvent, { type: 'usage_limited' }>).message;
    expect(message).toContain(limitText);
    expect(message).not.toContain('回し手が落ちた');

    // 2. セッションは実際に開いている（回し手の失敗が起動そのものを潰していない）。
    expect(calls.filter((call) => call.kind === 'session')).not.toHaveLength(0);

    // 3. 回し手の失敗は黙って消えず、跡が残る。⛔ この行を落とすと「握り潰して
    //    よい」に化ける（`#observeForTokenRotation` の catch は跡を残すためだけに在る）。
    const dropped = lines.filter((line) => line.includes('認証トークンの切替')).join('\n');
    expect(dropped).toContain('回し手が落ちた');
  });

  /**
   * **`usable` の2本目の生産者（#681 (1)）。** ここは `markTokenUsable` の doc が
   * 「`clone.ts` が成功した result で `#usageBlocked` を降ろしているのと同じ
   * 根拠」と名指ししている場所そのもの——成功したターンは `#observeForTokenRotation`
   * にも1本渡す。
   */
  it('⚠️ ターンが成功したら、成功の観測（succeeded: true）も回し手へ渡る', async () => {
    // **既定（`resultSubtype` 省略）は成功である。** notice / rate_limit_event の
    // どちらも設定していないので、`seen` に積まれるのはこの1本だけになる。
    const { clone, seen } = cloneObserving({ identity: { tokenId: 'tok-a', generation: 3 } });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    // **成功だけを運ぶ。** 枠の観測（`notice` / `facts` / `transition`）は
    // 1つも持たない。
    expect(seen[0]).toEqual({
      succeeded: true,
      observedBy: { tokenId: 'tok-a', generation: 3 },
    });
  });
});

/**
 * **段1（測るだけ、Issue #1425）: 跨いで畳んだ rate_limit の報告本数を
 * 日誌へ残す（クローン側）。**
 *
 * `case 'rate_limit'` は `usageTransitionOf` が `undefined` を返した回
 * （＝別の会話のターンが直前に同じ壁を報告済み）を、日誌に一度も痕跡を
 * 残さずに畳んで捨てていた。`manager.ts` 側は managerId で「跨いだ」を
 * 数えるが、クローンは1体しかいないので、ここでは代わりに
 * `conversationId` で数える（`#rateLimitCrossFold` の doc。この代替は
 * この PR の判断であり、Issue の逐語が指定したものではない）。
 *
 * **畳み込みの鍵も配り方も変えていない。** 測っているのは日誌の行だけである。
 */
describe('rate_limit を跨いで畳んだ本数を日誌へ残す（Issue #1425、クローン側）', () => {
  function crossFoldLines(entries: unknown[]): string[] {
    return entries
      .map((entry) => (entry as { text?: string }).text ?? '')
      .filter((text) => text.includes('同じ壁を跨いで畳んだ回'));
  }

  function doneCountOf(events: readonly ChatStreamEvent[]): number {
    return events.filter((event) => event.type === 'done').length;
  }

  it('陽性: 別の会話が跨いで畳まれると、次の遷移で本数が1行に残る', async () => {
    // turn0: conv-1 が最初に当たる（この壁の遷移を記録した本人になる）。
    // turn1: conv-b が同じ壁を跨いで畳まれる。
    // turn2: conv-c も同じ壁を跨いで畳まれる（folded = {conv-b, conv-c}）。
    // turn3: conv-1 自身が allowed へ戻る——本人の連打なので跨いだ数には
    //        数えない（folded はそのまま）。
    // turn4: conv-b が再び当てて、次の遷移が定まる——ここで2本がまとめて出る。
    const facts: Array<Record<string, unknown>> = [
      { status: 'rejected', rateLimitType: 'five_hour' },
      { status: 'rejected', rateLimitType: 'five_hour' },
      { status: 'rejected', rateLimitType: 'five_hour' },
      { status: 'allowed', rateLimitType: 'five_hour' },
      { status: 'rejected', rateLimitType: 'five_hour' },
    ];
    const s = setup(() => 'ok', createMemoryStores(), {
      rateLimitEventAt: (turnIndex) => facts[turnIndex],
    });
    const convB = wireEvents(s.clone, 'conv-b');
    const convC = wireEvents(s.clone, 'conv-c');

    s.clone.post(humanMessage('t0', 'conv-1'));
    await s.waitForEvents((events) => doneCountOf(events) === 1);

    s.clone.post(humanMessage('t1', 'conv-b'));
    await convB.waitForEvents((events) => doneCountOf(events) === 1);

    s.clone.post(humanMessage('t2', 'conv-c'));
    await convC.waitForEvents((events) => doneCountOf(events) === 1);

    s.clone.post(humanMessage('t3', 'conv-1'));
    await s.waitForEvents((events) => doneCountOf(events) === 2);

    s.clone.post(humanMessage('t4', 'conv-b'));
    await convB.waitForEvents((events) => doneCountOf(events) === 2);

    const entries = await s.stores.journal.list({});
    const lines = crossFoldLines(entries);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2 本の異なる会話が当たっている');

    await s.clone.stop();
  });

  it('やりすぎの対照: 同じ会話だけが繰り返しても、本数の行は出ない', async () => {
    const facts: Array<Record<string, unknown>> = [
      { status: 'rejected', rateLimitType: 'five_hour' },
      { status: 'allowed', rateLimitType: 'five_hour' },
      { status: 'rejected', rateLimitType: 'five_hour' },
    ];
    const s = setup(() => 'ok', createMemoryStores(), {
      rateLimitEventAt: (turnIndex) => facts[turnIndex],
    });

    s.clone.post(humanMessage('t0', 'conv-1'));
    await s.waitForEvents((events) => doneCountOf(events) === 1);
    s.clone.post(humanMessage('t1', 'conv-1'));
    await s.waitForEvents((events) => doneCountOf(events) === 2);
    s.clone.post(humanMessage('t2', 'conv-1'));
    await s.waitForEvents((events) => doneCountOf(events) === 3);

    const entries = await s.stores.journal.list({});
    expect(crossFoldLines(entries)).toHaveLength(0);

    await s.clone.stop();
  });

  it('やりすぎの対照: 初回の遷移だけでは本数の行は出ない', async () => {
    const s = setup(() => 'ok', createMemoryStores(), {
      rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
    });

    s.clone.post(humanMessage('t0', 'conv-1'));
    await s.waitForEvents((events) => doneCountOf(events) === 1);

    const entries = await s.stores.journal.list({});
    expect(crossFoldLines(entries)).toHaveLength(0);

    await s.clone.stop();
  });
});

/**
 * 認証トークンを回した後のセッション作り直し（Issue #393 PR4）。
 *
 * **Issue が「実装者が決めると必ず壊れる」と名指しした箇所である。** 畳む位置を
 * ターンの境界に置かないと、既定の設定で必ず2つ踏む —— 通るはずだった仕事を殺すか、
 * 回したことが「セッションが終了した」という失敗として依頼者へ届くか。
 */
describe('recycleSessionForToken（回した後のセッション作り直し）', () => {
  let seq = 0;

  /**
   * **読み先行する偽 SDK。** 結果を出す前に、次の入力を取りに行く。
   *
   * ## なぜ専用の偽物が要るか
   *
   * 共有の `fakeSdk` は `for await (const message of prompt)` で1件ずつ処理する
   * ——**ターンが走っているあいだ、入力ストリームに次を要求しない。** ⟹ そこでは
   * `#inputStream` が `#turn !== null` の状態で判定へ到達しないので、
   * **「ターンの境界でだけ畳む」という条件が一度も発火しない。**
   *
   * **実測: 共有の偽物で書いた歯は、変異（`#turn === null` の条件を外す）を
   * 当てても3本とも緑のままだった。** 測っていなかったということである。
   *
   * ここが再現するのは「SDK が読み先行する」形で、**守っている条件が実際に効く
   * 唯一の場面**である。
   */
  function lookaheadSdk(turnDelayMs = 20) {
    // **`resume` も控える。** 畳み直しの後に**同じ会話へ戻っているか**は、
    // 「セッションが2本になったか」では測れない（新しい会話を始めても2本になる）。
    const sessions: { inputs: string[]; resume: string | undefined }[] = [];
    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const session = {
        inputs: [] as string[],
        resume: params.options?.resume,
      };
      sessions.push(session);
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: `sess-lookahead-${String(sessions.length)}`,
          uuid: `uuid-init-${String(sessions.length)}`,
          model: 'claude-fake',
          claude_code_version: '9.9.9-fake',
          apiKeySource: 'user',
          permissionMode: 'default',
          mcp_servers: [{ name: 'alteroid', status: 'connected' }],
        } as unknown as SDKMessage;

        const iterator = (params.prompt as AsyncIterable<{ message: { content: unknown } }>)[
          Symbol.asyncIterator
        ]();

        for (;;) {
          const current = await iterator.next();
          if (current.done === true) return;
          session.inputs.push(String(current.value.message.content));

          // **結果を出す前に次を要求する。** この時点で `#turn` はまだ立って
          // いるので、`#inputStream` は「ターンの境界ではない」と判定しなければ
          // ならない。
          const lookahead = iterator.next();

          await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: `sess-lookahead-${String(sessions.length)}`,
            uuid: `uuid-result-${String(session.inputs.length)}`,
          } as unknown as SDKMessage;

          const next = await lookahead;
          if (next.done === true) return;
          // 読み先行で取った分をこのまま処理する。
          session.inputs.push(String(next.value.message.content));
          await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: `sess-lookahead-${String(sessions.length)}`,
            uuid: `uuid-result-b-${String(session.inputs.length)}`,
          } as unknown as SDKMessage;
        }
      }
      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;
    return { fn, sessions };
  }

  function say(clone: ReturnType<typeof createClone>): void {
    clone.post({
      type: 'human_message',
      id: `evt-recycle-${String(++seq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
  }

  function setupRecycle(sdkOptions: Parameters<typeof fakeSdk>[1] = {}) {
    const { fn, calls } = fakeSdk(undefined, sdkOptions);
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, calls };
  }

  /**
   * **入力ストリームが閉じたら、走っているターンを捨てて終わる偽 SDK。**
   *
   * ## なぜこれが要るか
   *
   * 上の `lookaheadSdk` は、入力が尽きても**そのターンの結果は必ず出す。** ⟹
   * ターンの途中で畳んでも `#turn` は結果の到着で片付き、`#read` の `finally`
   * に届く頃には `null` になっている ——**危険が現れない。**
   *
   * **実測: `lookaheadSdk` だけで書いた歯は、「ターンの境界でだけ畳む」条件を
   * 外す変異を当てても緑のままだった。** 測っていなかったということである。
   *
   * ここが模すのは「**入力の口が閉じた＝畳めという合図**」と読む SDK である。
   * そのとき走っていたターンは結果を返さないので、`#read` の `finally` が
   * `#turn` を見つけて**「クローンのセッションが終了した」を依頼者へ報告する**
   * ——Issue #393 追記5 が名指ししている壊れ方そのものである。
   *
   * **⚠️ 本物の SDK がどちらの側かは測っていない。** この歯が守っているのは
   * 「どちらでも壊れない」ことであって、「本物がこう振る舞う」ではない。
   */
  function abortOnStreamEndSdk(turnDelayMs = 40) {
    const sessions: { inputs: string[] }[] = [];
    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const session = { inputs: [] as string[] };
      sessions.push(session);
      const label = `sess-abort-${String(sessions.length)}`;
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: label,
          uuid: `uuid-init-${label}`,
          model: 'claude-fake',
          claude_code_version: '9.9.9-fake',
          apiKeySource: 'user',
          permissionMode: 'default',
          mcp_servers: [{ name: 'alteroid', status: 'connected' }],
        } as unknown as SDKMessage;

        const iterator = (params.prompt as AsyncIterable<{ message: { content: unknown } }>)[
          Symbol.asyncIterator
        ]();

        for (;;) {
          const current = await iterator.next();
          if (current.done === true) return;
          session.inputs.push(String(current.value.message.content));

          // 読み先行。**入力の口が閉じたら、このターンを捨てて終わる。**
          const lookahead = iterator.next();
          const finished = await Promise.race([
            lookahead.then((next) =>
              next.done === true ? ('closed' as const) : ('next' as const),
            ),
            new Promise<'turn'>((resolve) => setTimeout(() => resolve('turn'), turnDelayMs)),
          ]);
          if (finished === 'closed') return;

          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: label,
            uuid: `uuid-result-${String(session.inputs.length)}`,
          } as unknown as SDKMessage;

          const next = await lookahead;
          if (next.done === true) return;
          session.inputs.push(String(next.value.message.content));
          await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: label,
            uuid: `uuid-result-b-${String(session.inputs.length)}`,
          } as unknown as SDKMessage;
        }
      }
      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;
    return { fn, sessions };
  }

  function cloneWith(fn: typeof sdkQuery, onTokenSessionRecycled?: () => void) {
    return createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      ...(onTokenSessionRecycled === undefined ? {} : { onTokenSessionRecycled }),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
  }

  /**
   * **受け入れ基準（Issue #393 追記5）**: 回すと決めた時点で走っていたターンが、
   * 最後まで走って結果を返す —— 依頼者に「セッションが終了した」が届かない。
   *
   * **読み先行する偽 SDK でしか測れない**（上の `lookaheadSdk` の doc）。共有の
   * 偽物では、ターン中に入力ストリームへ到達しないので条件が発火しない。
   */
  it('⚠️ ターンの途中では畳まない。走っているターンは最後まで走る', async () => {
    // **捨てる SDK で測る**（`lookaheadSdk` では危険が現れない。あちらの doc）。
    const { fn, sessions } = abortOnStreamEndSdk(40);
    const clone = cloneWith(fn);
    const events: string[] = [];
    clone.subscribe('conv-1', (event) => events.push(event.type));

    say(clone);
    await waitFor(() => sessions.length > 0, 'セッションが開くこと');
    // 読み先行で入力ストリームが判定へ到達している状態で、ターンの途中に回す。
    await new Promise((resolve) => setTimeout(resolve, 10));
    clone.recycleSessionForToken();

    await waitFor(() => events.includes('done'), 'ターンが最後まで走ること');
    await clone.stop();

    // **「クローンのセッションが終了した」が届いていない。**
    expect(events).toContain('done');
    expect(events).not.toContain('error');
  });

  /**
   * **境界で起こさないと、古いセッションのまま止まる。** 読み先行の SDK は、
   * ターンが終わっても自分から取りに来ない（既に要求済みで、その約束が解けるのを
   * 待っている）。
   */
  it('ターンが終わった境界で畳まれ、次は新しいセッションになる', async () => {
    const { fn, sessions } = lookaheadSdk(20);
    const clone = cloneWith(fn);

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    clone.recycleSessionForToken();
    // 境界で畳まれるので、次の入力は**新しいセッション**で走る。
    await new Promise((resolve) => setTimeout(resolve, 80));
    say(clone);

    await waitFor(() => sessions.length > 1, '2本目が開くこと');
    await clone.stop();
    expect(sessions.length).toBeGreaterThan(1);
  });

  /**
   * **⭐ 畳んだ後は、同じ会話へ `resume` で戻る（人間の要件 2026-09-07）。**
   *
   * 人間の逐語: 「app(clone)もrunner(manager)もトークンが変更されたときに自動的に
   * 同じセッションから再開される状態になってれば構いません」。
   *
   * ## なぜ「2本目が開いた」では足りないのか
   *
   * すぐ上の歯は `sessions.length > 1` を見ている ——**新しい会話を始めても同じ
   * 数になる。** ⟹ あれが落ちない状態のまま、`#ensureQuery` が `resume` を
   * 渡すのをやめる（＝毎回まっさらから始める）ことができる。**そのときに失う
   * のは会話そのもの**で、枠で止まった仕事は最初からやり直しになる。
   *
   * マネージャー層の同じ保証は `runner-token-rotation.test.ts` が持っている
   * （「開き直しは resume（同じ sessionId）で行われる」）。**層ごとに別の器で
   * 走るので、片方の緑はもう片方を何も言わない。**
   */
  it('⭐ 畳んだ後は同じ会話へ resume で戻る（会話を捨てない）', async () => {
    const { fn, sessions } = lookaheadSdk(20);
    const clone = cloneWith(fn);

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    // 1本目は resume しない（記憶に session_id がまだ無い）。
    expect(sessions[0]?.resume).toBeUndefined();

    clone.recycleSessionForToken();
    await new Promise((resolve) => setTimeout(resolve, 80));
    say(clone);

    await waitFor(() => sessions.length > 1, '2本目が開くこと');
    await clone.stop();
    // **1本目が名乗った session_id で戻っている**（`case 'session_started'` が
    // `setCloneSessionId` で控え、`#ensureQuery` がそれを `resume` へ渡す）。
    expect(sessions[1]?.resume).toBe('sess-lookahead-1');
  });

  /**
   * セッションがまだ無いときに印を立てると、**次に作られるセッション（もう新しい
   * 鍵で起きたもの）がいきなり畳まれる。**
   */
  it('セッションがまだ無ければ印を立てない', async () => {
    const { fn, sessions } = lookaheadSdk(5);
    const clone = cloneWith(fn);

    // セッションが1本も無い状態で呼ぶ。
    clone.recycleSessionForToken();

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    // **同じセッションが使い回される**（印が立っていれば、ここで2本目になる）。
    await new Promise((resolve) => setTimeout(resolve, 60));
    say(clone);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await clone.stop();

    expect(sessions).toHaveLength(1);
  });

  /**
   * **⭐ 失敗した直後に畳んでも、余計な失敗が1件も増えない。**
   *
   * ## なぜこれを先に固定するのか
   *
   * 文脈窓（プロンプトの長さ）で落ちた回にセッションを畳み直す設計（#553）が、
   * この性質に**丸ごと乗っている。** 乗っている先はここである:
   *
   * - `#apply` の `case 'turn_ended'` は、失敗した `result` に対して
   *   `#reportFailure`（`error` を1件 emit する）を打ち、そのあと `#finishTurn()` を
   *   呼ぶ
   * - `#finishTurn()` は `#turn` を `null` にしてから境界を起こす
   * - ⟹ `#inputStream` が境界で `return` し、`#read` の `finally` に届く頃には
   *   `#turn` は `null` ⟹ `if (turn) { … 'クローンのセッションが終了した' }` が
   *   偽になる
   *
   * **⟹ もしこの順序が崩れると、失敗を1件報告した直後に「セッションが終了した」が
   * 同じ会話へもう1件届く。** 人間から見ると、1回の失敗が2回に見える ——
   * しかも2件目は原因を1文字も持たない。
   *
   * ## ⚠️ 既存の兄弟の歯とは条件が違う
   *
   * 上の「ターンの途中では畳まない」は**成功して終わるターンの途中**で畳む。
   * こちらは**失敗して終わったターンの直後**に畳む。**`#turn` を片付ける経路が
   * 別である**（あちらは結果の到着、こちらは失敗側の `#finishTurn()`）ので、
   * あちらが緑でもこちらは保証されない。
   *
   * **⚠️ この歯は `recycleSessionForToken()`（＝トークンを回す側の引き金）で
   * 畳んでいる。** 文脈窓で畳む引き金はまだ無いので、**固定しているのは
   * 「畳む引き金が何であれ、失敗の直後に畳んでも余計な報告が出ない」という
   * 順序の性質だけである。**
   */
  it('⚠️ 失敗した直後に畳んでも、余計な失敗が増えない（次は新しいセッションで走る）', async () => {
    // **固定値のスタブにしない。** 1本目だけ失敗させ、2本目は通す —— 全ターンを
    // 失敗に固定すると「2本目の失敗」と「余計な報告」が区別できなくなる。
    let failNext = true;
    const { clone, calls } = setupRecycle({
      resultFor: () =>
        failNext ? { subtype: 'success', isError: true, text: 'Prompt is too long' } : undefined,
    });
    const events: string[] = [];
    clone.subscribe('conv-1', (event) => events.push(event.type));

    say(clone);
    await waitFor(() => events.includes('error'), '1本目が失敗すること');
    failNext = false;

    // 失敗の直後に畳む（ターンはもう終わっている ＝ 境界に居る）。
    clone.recycleSessionForToken();
    await new Promise((resolve) => setTimeout(resolve, 80));
    say(clone);

    await waitFor(() => calls.length > 1, '2本目のセッションが開くこと');
    await waitFor(() => events.includes('done'), '2本目が最後まで走ること');
    await clone.stop();

    // **失敗の報告は1件だけ。**2件目（`クローンのセッションが終了した`）が出ない。
    expect(events.filter((type) => type === 'error')).toHaveLength(1);
    // 畳めているので、2本目は別のセッションである。
    expect(calls.length).toBeGreaterThan(1);
  });

  it('クローン全体の停止（stop）とは別物である', async () => {
    // 混ぜると「トークンを回したらクローンが止まる」になる。
    const { clone, calls } = setupRecycle();
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');

    clone.recycleSessionForToken();
    say(clone);

    // 止まっていないので、次のターンが走る。
    await waitFor(() => calls.length > 1, '止まらずに次が走ること');
    clone.stop();
  });

  /**
   * **「いつ効くか」を返す**（人間の決定 2026-09-07）。
   *
   * ここを捨てると、呼ぶ側は「再開の合図」を入れる時機を決められない ——
   * そして手前で入れると**合図が古い鍵のターンに消費される**（実運用で26分の
   * 沈黙になった形。`recycleSessionForToken` の doc に実測の表が在る）。
   */
  it("セッションが無ければ 'now'、走っていれば 'deferred' を返す", async () => {
    const { fn, sessions } = lookaheadSdk(20);
    const clone = cloneWith(fn);

    // セッションが1本も無い ⟹ 次に起こす分がもう新しい鍵である。
    expect(clone.recycleSessionForToken()).toBe('now');

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    // セッションが在る ⟹ 畳まれるのはターンの境界。
    expect(clone.recycleSessionForToken()).toBe('deferred');
    await clone.stop();
  });

  /**
   * **⭐ 畳んだ後に1度だけ知らせる。**
   *
   * ## この歯が固定している事故
   *
   * 実運用（2026-09-07、Railway の本番）で観測した形:
   *
   * | 時刻 (UTC) | 何が起きたか |
   * | --- | --- |
   * | `07:33:12` | 回した（世代41 → 42）。**再開の合図もここで入れた** |
   * | `07:33:18`〜`50` | ターンの最中だったので畳まれない |
   * | `07:33:51` | そのターンが**古い鍵**で 429 ⟹ `#usageBlocked` が立ち直る |
   * | 以降26分 | **沈黙**（合図はもう使われている。再投函する者が居ない） |
   *
   * ⟹ 知らせるのは**畳んだ後**でなければならない。ここが鳴った後に入れた合図は、
   * 次の `#ensureQuery()` が起こす**新しい鍵のセッション**で受け取られる。
   */
  it('畳んだ後に onTokenSessionRecycled が1度だけ鳴る', async () => {
    const { fn, sessions } = lookaheadSdk(20);
    const recycled: number[] = [];
    const clone = cloneWith(fn, () => recycled.push(sessions.length));

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    clone.recycleSessionForToken();

    await waitFor(() => recycled.length > 0, '畳んだ知らせが鳴ること');
    // **鳴った時点で、次のセッションはまだ開いていない**（＝畳んだ直後である）。
    expect(recycled).toEqual([1]);

    // 知らせの後に入れた合図は、新しいセッションで受け取られる。
    say(clone);
    await waitFor(() => sessions.length > 1, '2本目が開くこと');
    await clone.stop();
    // **1度だけ。** 畳むのは1回なので、鳴るのも1回である。
    expect(recycled).toEqual([1]);
  });

  /**
   * **ターンの最中に回しても、鳴るのはターンが終わってからである。**
   *
   * これが逆（走行中に鳴る）だと、呼ぶ側が入れた合図はそのターンに消費される
   * ——上の実測の事故そのものになる。
   */
  it('ターンの最中に回しても、鳴るのは境界を越えてからである', async () => {
    const { fn, sessions } = lookaheadSdk(60);
    const recycled: string[] = [];
    const events: string[] = [];
    const clone = cloneWith(fn, () => recycled.push('rung'));
    clone.subscribe('conv-1', (event) => events.push(event.type));

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    // ターンが走っている最中に回す。
    await new Promise((resolve) => setTimeout(resolve, 10));
    clone.recycleSessionForToken();

    // **まだ鳴っていない**（ターンが走っているので）。
    expect(recycled).toEqual([]);

    await waitFor(() => events.includes('done'), 'ターンが最後まで走ること');
    await waitFor(() => recycled.length > 0, '境界を越えてから鳴ること');
    await clone.stop();
    expect(recycled).toEqual(['rung']);
  });

  /**
   * **文脈窓で畳んだ回には鳴らさない。** あちらは鍵と無関係なので、鳴らすと
   * 「トークンが戻った」という嘘の合図が入る（`#recycleForContextWindow` の doc）。
   *
   * **畳む印は2つ在って、同じ1箇所で消費される** —— そこで「どちらの印で畳んだ
   * のか」を見分けないと、文脈窓で畳んだ回にも鍵の知らせが鳴る。
   */
  it('文脈窓で畳んだ回には鳴らない', async () => {
    // 1本目を成功させてから2本目を長さで落とす（`setupFold` と同じ形。
    // `#sessionAnswered` が立たないと暴走の止めに掛かって畳まれない）。
    let failNext = false;
    const { fn } = fakeSdk(undefined, {
      resultFor: () =>
        failNext ? { subtype: 'success', isError: true, text: 'Prompt is too long' } : undefined,
    });
    const recycled: string[] = [];
    const stores = createMemoryStores();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      onTokenSessionRecycled: () => recycled.push('rung'),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');

    say(clone);
    await waitFor(() => events.some((e) => e.type === 'done'), '1本目が通ること');
    failNext = true;
    say(clone);
    await waitFor(() => events.some((e) => e.type === 'error'), '2本目が長さで落ちること');
    // **印と同時に resume 素材が捨てられている**（既存の歯と同じ待ち方）。
    // ここが通れば、文脈窓の側の畳みが確かに起きている。
    await waitFor(
      async () => (await stores.sessions.getCloneSessionId()) === null,
      'resume 素材が捨てられること',
    );
    await clone.stop();

    // **畳まれてはいるが、トークンの知らせは鳴っていない。**
    expect(recycled).toEqual([]);
  });

  /**
   * 知らせが投げても、セッションの作り直しを巻き添えにしない
   * （畳むことはもう決まっている）。
   */
  it('知らせが投げても畳むことは続く', async () => {
    const { fn, sessions } = lookaheadSdk(20);
    const clone = cloneWith(fn, () => {
      throw new Error('聞き手が落ちた');
    });

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    clone.recycleSessionForToken();
    await new Promise((resolve) => setTimeout(resolve, 80));
    say(clone);

    await waitFor(() => sessions.length > 1, '畳まれて2本目が開くこと');
    await clone.stop();
    expect(sessions.length).toBeGreaterThan(1);
  });
});

/**
 * 蒸留が間に合わなかった区間の検出（Issue #564 の (b)。`distill-gap.ts`）。
 *
 * **歯が固定しているのは「開始ではなく成功で数える」ことである。** 日誌には
 * 蒸留を**始めた**印（`ターンの入力: distill`）が前から在り、そちらを使うと
 * 「開始したが完了しなかった回」——まさに検出したい形——が「蒸留した」として
 * 数えられる。歯2がそこを直接押す（失敗した蒸留では開始の印だけが残り、成功の
 * 印は残らない）。
 */
