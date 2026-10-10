import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent, InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import {
  fakeSdk,
  setup,
  wireEvents,
  waitFor,
  waitForDone,
  isTerminal,
  waitForTerminal,
  flushPendingMicrotasks,
} from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';

describe('クローン — 枠（利用上限）が閉じたら保持して次の合図で試す', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  // どれにも当たらない入力は '?' にして捨てない: 落とすと、余計な入力が1件混ざったことが並びから消えるため
  function labelOrder(call: FakeCall): string[] {
    return call.inputs.map((text) => {
      for (const label of ['一件目', '二件目', '三件目']) {
        if (text.includes(label)) return label;
      }
      return '?';
    });
  }

  it('枠に当たったとき、usage_limited が error より先に届く', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);

    const usageLimitedIndex = s.events.findIndex((event) => event.type === 'usage_limited');
    const errorIndex = s.events.findIndex((event) => event.type === 'error');
    expect(usageLimitedIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(usageLimitedIndex).toBeLessThan(errorIndex);

    const usageLimitedEvent = s.events[usageLimitedIndex] as Extract<
      ChatStreamEvent,
      { type: 'usage_limited' }
    >;
    expect(usageLimitedEvent.message).toContain(spendLimitMessage);

    await s.clone.stop();
  });

  it('枠に当たった合図は forget されない（stores.inbox に未読として残る）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    const event = humanMessage('やあ');
    s.clone.post(event);
    await waitForTerminal(s.events);

    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === event.id);
    }, '枠に当たった合図が未読として残る');

    await s.clone.stop();
  });

  it('枠が閉じている間に届いた2本目は、ターンが回らないのに error で終端する', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.length === 1;
    }, '1本目が未読のまま保持される');
    const inputsBeforeSecondPost = (s.calls[0] as FakeCall).inputs.length;

    s.clone.post(humanMessage('二件目'));
    await s.waitForEvents((events) => events.filter(isTerminal).length === 3);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual([
      'error',
      'error',
      'error',
    ]);

    expect(s.calls.length).toBe(1);
    const inputsAfterSecondPost = (s.calls[0] as FakeCall).inputs.length;
    expect(inputsAfterSecondPost).toBe(inputsBeforeSecondPost + 1);
    expect((s.calls[0] as FakeCall).inputs.some((text) => text.includes('二件目'))).toBe(false);

    await s.clone.stop();
  });

  it('3本目の合図が来たら、保持していた合図が FIFO の順で配り直され、実際に投げられる', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 2 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);

    s.clone.post(humanMessage('二件目'));
    await s.waitForEvents((events) => events.filter(isTerminal).length === 3);

    s.clone.post(humanMessage('三件目'));
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 3);

    expect(labelOrder(s.calls[0] as FakeCall)).toEqual([
      '一件目',
      '一件目',
      '一件目',
      '二件目',
      '三件目',
    ]);

    await s.clone.stop();
  });

  // post() は #emit の callback の中で呼ぶ: await を挟んだ待ちの後だと窓に入れるかがホストの速さで変わり、踏めた回だけ壊れるため
  it('終端を出した直後（後始末の前）に次の合図が届いても、枠で保持した合図は消えない', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    let injected = false;
    const unsubscribe = s.clone.subscribe('conv-1', (event) => {
      if (event.type !== 'error' || injected) return;
      injected = true;
      s.clone.post(humanMessage('二件目'));
    });

    s.clone.post(humanMessage('一件目'));

    // s.calls[0] は ?. で受ける: query() が呼ばれるまで undefined で、素で読むと待ちの中で TypeError になるため
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 2, '2件目の入力が投げられる');
    // 先頭2件だけを見る: 待ちが抜けた時点で3件目が既に投げられていることがあり、配列全体の一致だと直っているのに落ちるため
    expect(labelOrder(s.calls[0] as FakeCall).slice(0, 2)).toEqual(['一件目', '一件目']);

    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 2);
    expect(labelOrder(s.calls[0] as FakeCall)).toEqual(['一件目', '一件目', '二件目']);

    unsubscribe();
    await s.clone.stop();
  });

  it('短絡した合図の後始末の直前に3本目が届いても、2本目は迷子にならず FIFO を保つ', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 2 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);

    // 件数で名指しする: どの error に入ったかがホストの速さで変わらないようにするため
    let injected = false;
    const unsubscribe = s.clone.subscribe('conv-1', (event) => {
      if (event.type !== 'error' || injected) return;
      if (s.events.filter(isTerminal).length < 3) return;
      injected = true;
      s.clone.post(humanMessage('三件目'));
    });

    s.clone.post(humanMessage('二件目'));

    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 4, '4件目の入力が投げられる');
    expect(labelOrder(s.calls[0] as FakeCall).slice(0, 4)).toEqual([
      '一件目',
      '一件目',
      '一件目',
      '二件目',
    ]);

    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 3);
    expect(labelOrder(s.calls[0] as FakeCall)).toEqual([
      '一件目',
      '一件目',
      '一件目',
      '二件目',
      '三件目',
    ]);

    unsubscribe();
    await s.clone.stop();
  });

  it('枠が閉じている間に2件が続けて届いても、配り直しは到着順のまま（待ち行列を追い越さない）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);

    // 続けて2件 post する: 解除の時点で待ち行列に別の合図が居ないと、push（末尾）と unshift（先頭）で到着順が区別できないため
    s.clone.post(humanMessage('二件目'));
    s.clone.post(humanMessage('三件目'));

    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 2, '2件目の入力が投げられる');
    expect(labelOrder(s.calls[0] as FakeCall).slice(0, 2)).toEqual(['一件目', '一件目']);

    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 2);
    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(labelOrder(s.calls[0] as FakeCall)).toEqual(['一件目', '一件目', '二件目']);
    const merged = inputs[2] ?? '';
    expect(merged).toContain('二件目');
    expect(merged).toContain('三件目');
    expect(merged.indexOf('二件目')).toBeLessThan(merged.indexOf('三件目'));

    await s.clone.stop();
  });

  // #query === null でなければ作れない: stop() は #query が在れば蒸留を await し、その間に #pump が先頭へ到達して印を消費するため
  it('受信箱が閉じた後に解除の印が残っていても、受信箱のループを殺さない', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
      endSessionAfterTurn: 0,
    });

    const first = humanMessage('一件目');
    s.clone.post(first);
    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === first.id);
    }, '一件目が未読として保持される');
    // #read の finally が #query = null を打ち終えるまで待つ: 追いつく前に post; stop へ進むと stop() が #query を非 null と見て蒸留を待ち、閉じた後に解除の印が残る状況が作れなくなるため
    await flushPendingMicrotasks();
    const terminalsBefore = s.events.filter(isTerminal).length;

    const second = humanMessage('二件目');
    s.clone.post(second);
    await s.clone.stop();

    await s.waitForEvents((events) => events.filter(isTerminal).length === terminalsBefore + 1);
    const pending = await s.stores.inbox.claimPending();
    expect(pending.map((p) => p.event.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('org_policy では待たない（保持せず、従来どおり失敗として消える）', async () => {
    const orgPolicyMessage = 'This service is disabled for your org by admin decision.';
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: orgPolicyMessage,
    });

    const event = humanMessage('やあ');
    s.clone.post(event);
    await waitForTerminal(s.events);

    expect(s.events.filter(isTerminal).map((e) => e.type)).toEqual(['error']);
    expect(s.events.some((e) => e.type === 'usage_limited')).toBe(false);

    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return !pending.some((p) => p.event.id === event.id);
    }, 'org_policy の合図は保持されず forget される');

    await s.clone.stop();
  });

  it('rate_limit_event の status: rejected でも枠が閉じたと判定する', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: '（結果なし。rate_limit_event だけが上限の理由を運ぶ）',
      rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);
    expect(s.events.some((e) => e.type === 'usage_limited')).toBe(true);

    s.clone.post(humanMessage('二件目'));
    await s.waitForEvents((events) => events.filter(isTerminal).length === 3);

    expect((s.calls[0] as FakeCall).inputs.some((text) => text.includes('二件目'))).toBe(false);

    await s.clone.stop();
  });

  it('rate_limit_event で status: rejected が来ても、同じターンの result が成功したら保持されない', async () => {
    const s = setup(undefined, createMemoryStores(), {
      rateLimitEventAt: (turnIndex) =>
        turnIndex === 0
          ? { status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: true }
          : undefined,
    });

    const event = humanMessage('やあ');
    s.clone.post(event);
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((e) => e.type)).toEqual(['done']);

    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return !pending.some((p) => p.event.id === event.id);
    }, '成功したターンの合図は保持されず forget される');

    await s.clone.stop();
  });

  it('（追加確認）system/notification の上限文言でも枠が閉じたと判定する', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: '（結果なし。system 通知だけが上限の理由を運ぶ）',
      systemNoticeAt: () => ({ subtype: 'notification', text: spendLimitMessage }),
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);
    expect(s.events.some((e) => e.type === 'usage_limited')).toBe(true);

    s.clone.post(humanMessage('二件目'));
    await s.waitForEvents((events) => events.filter(isTerminal).length === 3);
    expect((s.calls[0] as FakeCall).inputs.some((text) => text.includes('二件目'))).toBe(false);

    await s.clone.stop();
  });

  it('同じ transition の通知が2回届いても、日誌のその行は1件しか増えない', async () => {
    const transitionMessage = "You're now using extra usage until your limit resets.";
    const s = setup(undefined, createMemoryStores(), {
      systemNoticeAt: () => ({ subtype: 'notification', text: transitionMessage }),
    });

    s.clone.post(humanMessage('一件目'));
    await waitForDone(s.events);

    s.clone.post(humanMessage('二件目'));
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 2);

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    const matching = exchanges.filter((entry) => entry.text.includes(transitionMessage));
    expect(matching).toHaveLength(1);

    await s.clone.stop();
  });

  // #redelivered の Map を直接覗かない: private field を覗く形は実装を変えた瞬間に意味を失うため、ターンへ渡る入力で固定する
  it('枠で保持された合図が解除で戻ってきても、配り直しの断り書きは付いたまま届く（#351 は逆を主張していたが、印を消すのは #forget だけである）', async () => {
    const stores = createMemoryStores();
    const held = humanMessage('一件目');
    await stores.inbox.put(held, new Date(0).toISOString());

    const s = setup(undefined, stores, {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === held.id);
    }, '拾い直した一件目が枠で保持される');

    s.clone.post(humanMessage('二件目'));
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 2);

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs[0] ?? '').toContain('一件目');
    expect(inputs[0] ?? '').toContain('これは配り直しである');
    expect(inputs[0] ?? '').toContain('回目の配達');

    expect(inputs[1] ?? '').toContain('一件目');
    expect(inputs[1] ?? '').toContain('これは配り直しである');
    expect(inputs[1] ?? '').toContain('回目の配達');

    expect(inputs[2] ?? '').toContain('二件目');
    expect(inputs[2] ?? '').not.toContain('これは配り直しである');

    await s.clone.stop();
  });
});

// 同期は失敗の記録の件数で取る: 畳んだ旨の日誌行を待つと直す前の世界で永久に出ず、タイムアウトで落ちて歯があった証拠にならないため
describe('クローン — 枠で保持している間、人間へ返す1行を積み上げない', () => {
  const spendLimit = "You've hit your individual spend limit for this account.";
  const heldNotice = 'いま利用上限に当たっているので';
  const foldedMark = '人間へ返す1行は畳んだ';
  const failureMark = '人間との対話ターンが失敗した';

  async function rows(stores: Stores): Promise<{ with: string; role: string; text: string }[]> {
    return (await stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      role: string;
      text: string;
    }[];
  }
  const count = (
    entries: { with: string; role: string; text: string }[],
    who: string,
    fragment: string,
  ): number =>
    entries.filter(
      (entry) => entry.with === who && entry.role === 'outbound' && entry.text.includes(fragment),
    ).length;

  async function setupHeld(): Promise<Setup> {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: () => ({ subtype: 'error_during_execution', text: spendLimit }),
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);
    await waitFor(
      async () => count(await rows(s.stores), 'self', failureMark) === 1,
      '1件目の失敗',
    );

    s.clone.post(humanMessage('二件目'));
    await waitFor(
      async () => count(await rows(s.stores), 'self', failureMark) === 3,
      '一件目の再試行と二件目の短絡',
    );
    return s;
  }

  async function tick(s: Setup, id: string, expectedFailures: number): Promise<void> {
    s.clone.post({
      type: 'self_initiative',
      id,
      at: new Date().toISOString(),
      reason: '定期 tick',
    });
    await waitFor(
      async () => count(await rows(s.stores), 'self', failureMark) === expectedFailures,
      `${id} で保持分が試し直される`,
    );
  }

  it('歯1: tick を2回受けても、人間へ返る1行は増えない（発言2本ぶんの2行のまま）', async () => {
    const s = await setupHeld();
    expect(count(await rows(s.stores), 'human', heldNotice)).toBe(2);

    await tick(s, 'evt-tick-1', 5);
    await tick(s, 'evt-tick-2', 7);

    const entries = await rows(s.stores);
    expect(count(entries, 'self', failureMark)).toBe(7);
    expect(count(entries, 'human', heldNotice)).toBe(2);

    await s.clone.stop();
  });

  it('歯2: 人間から新しい発言が来たら、保持中でも必ず1行返る（畳みすぎていない）', async () => {
    const s = await setupHeld();
    await tick(s, 'evt-tick-1', 5);
    expect(count(await rows(s.stores), 'human', heldNotice)).toBe(2);

    s.clone.post(humanMessage('三件目'));
    await waitFor(
      async () => count(await rows(s.stores), 'self', failureMark) === 8,
      '三件目の到着で保持分が試し直される',
    );

    expect(count(await rows(s.stores), 'human', heldNotice)).toBe(3);

    await s.clone.stop();
  });

  it('歯3: 畳んだ回は日誌（self）に1件ずつ、何件目か付きで残る', async () => {
    const s = await setupHeld();
    await tick(s, 'evt-tick-1', 5);

    const entries = await rows(s.stores);
    expect(count(entries, 'self', foldedMark)).toBe(3);
    const folded = entries
      .filter((entry) => entry.with === 'self' && entry.text.includes(foldedMark))
      .map((entry) => entry.text);
    expect(folded.some((text) => text.includes('最後に返した1行から数えて 1 件目'))).toBe(true);
    expect(folded.some((text) => text.includes('最後に返した1行から数えて 2 件目'))).toBe(true);
    expect(folded.every((text) => text.includes(heldNotice))).toBe(true);

    await s.clone.stop();
  });
});

// 歯1 は tick の跡を待たず pacer の終端で同期する: 畳み込みを殺す変異で日誌行が永久に出ず、タイムアウトで落ちて歯があった証拠にならないため
// 歯3 は postTickThenPacer を使わない: pacer 自身の post が解除を1回起こし、測定対象の代わりに数を稼いでしまうため
// humanPriority: false に固定する: 人間優先が有効だと pacer 自身が待ち行列の人間の最後尾へ割り込み、FIFO の歩調取りの前提が崩れるため
describe('クローン — 枠で保持している間、中身を持たない合図で在庫を作らない', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  function setupFixedFifo(
    reply?: (input: string) => string,
    stores: Stores = createMemoryStores(),
    sdkOptions: Parameters<typeof fakeSdk>[1] = {},
  ): Setup {
    const { fn, calls } = fakeSdk(reply, sdkOptions);
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      humanPriority: false,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events, waitForEvents } = wireEvents(clone, 'conv-1');
    return { clone, stores, calls, events, waitForEvents };
  }

  // '畳んだ' では絞らない: 人間へ返す1行の畳みの跡も「畳んだ」と書き、別の機構の行まで数えるため
  async function foldedNoteCount(s: Setup): Promise<number> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return exchanges.filter((entry) => entry.text.includes('枠で保持している同じ合図')).length;
  }

  // label を無内容にしない: 打ち切りが無く it() のタイムアウトで落ちるため、理由は afterEach が stderr へ出す待ちの label に載せてある
  async function waitForReleaseAttempts(s: Setup, expected: number, what: string): Promise<void> {
    await waitFor(
      async () => (await releaseAttemptCount(s)) === expected,
      `${what}: 解除の試行が ${expected} 回になるのを待っている`,
    );
  }

  async function waitForReleaseAttemptsAbove(
    s: Setup,
    baseline: number,
    what: string,
  ): Promise<void> {
    await waitFor(
      async () => (await releaseAttemptCount(s)) > baseline,
      `${what}: 解除の試行が ${baseline} 回より増えるのを待っている`,
    );
  }

  async function releaseAttemptCount(s: Setup): Promise<number> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return exchanges.filter((entry) => entry.text.includes('枠の解除を試す')).length;
  }

  function withInboxPutSpy(stores: Stores): {
    stores: Stores;
    putCallCountFor: (id: string) => number;
  } {
    const counts = new Map<string, number>();
    const original = stores.inbox;
    const spiedInbox: Stores['inbox'] = {
      ...original,
      async put(event, at) {
        counts.set(event.id, (counts.get(event.id) ?? 0) + 1);
        return original.put(event, at);
      },
    };
    return {
      stores: { ...stores, inbox: spiedInbox },
      putCallCountFor: (id) => counts.get(id) ?? 0,
    };
  }

  function waitForTerminalOn(clone: CloneHost, conversationId: string): Promise<void> {
    return new Promise((resolve) => {
      const unsubscribe = clone.subscribe(conversationId, (event) => {
        if (event.type === 'done' || event.type === 'error') {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  // pacer の conversation id は呼び出しごとに変える: conv-1 を共有すると「何件目の終端か」を数える形になり、脆くなるため
  async function postTickThenPacer(
    clone: CloneHost,
    tick: InboxEvent,
    pacerConversationId: string,
  ): Promise<void> {
    const terminal = waitForTerminalOn(clone, pacerConversationId);
    clone.post(tick);
    clone.post(humanMessage(`pacer(${pacerConversationId})`, pacerConversationId));
    await terminal;
  }

  it('歯1: 発意 tick を続けて送っても、保持する在庫は1件のまま増えない', async () => {
    const s = setupFixedFifo(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    const origin = humanMessage('起点');
    s.clone.post(origin);
    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === origin.id);
    }, '起点が未読として保持される');

    await postTickThenPacer(
      s.clone,
      { type: 'self_initiative', id: 'evt-si-1', at: new Date().toISOString(), reason: '1本目' },
      'conv-pacer-1',
    );

    await postTickThenPacer(
      s.clone,
      { type: 'self_initiative', id: 'evt-si-2', at: new Date().toISOString(), reason: '2本目' },
      'conv-pacer-2',
    );

    await postTickThenPacer(
      s.clone,
      { type: 'self_initiative', id: 'evt-si-3', at: new Date().toISOString(), reason: '3本目' },
      'conv-pacer-3',
    );

    const pending = await s.stores.inbox.claimPending();
    const selfInitiatives = pending.filter((p) => p.event.type === 'self_initiative');
    // 1件ずつ順番に送る: 詰めて送ると、受信箱から取り出されてから積まれるまでの間に届いた1件が畳む相手を見つけられず、2件になりうるため
    expect(selfInitiatives).toHaveLength(1);
    expect(selfInitiatives[0]?.event.id).toBe('evt-si-1');
    expect(await foldedNoteCount(s)).toBe(2);
    expect(pending.some((p) => p.event.id === origin.id)).toBe(true);

    await s.clone.stop();
  });

  it('歯2: 中身を持つ合図・別の日のタイマーは畳まれず、枠が開けば到着順に処理される', async () => {
    let releaseGateOpen = false;
    const s = setupFixedFifo(undefined, createMemoryStores(), {
      resultFor: () =>
        releaseGateOpen
          ? undefined
          : { subtype: 'error_during_execution', text: spendLimitMessage },
    });

    const origin = humanMessage('起点');
    s.clone.post(origin);
    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === origin.id);
    }, '起点が未読として保持される');

    const second = humanMessage('二件目');
    s.clone.post(second);
    await waitFor(async () => (s.calls[0]?.inputs.length ?? 0) >= 2, '二件目が誘発した再試行');

    const manager = {
      type: 'manager_message' as const,
      id: 'evt-manager',
      at: new Date().toISOString(),
      managerId: 'mgr-1',
      kind: 'report' as const,
      text: 'マネージャーからの一件（目印テキスト）',
    };
    s.clone.post(manager);
    await waitFor(
      async () => (s.calls[0]?.inputs.length ?? 0) >= 3,
      'manager_message が誘発した再試行',
    );

    const timerA = {
      type: 'timer' as const,
      id: 'evt-timer-a',
      at: new Date().toISOString(),
      kind: 'custom-check',
      target: '2026-08-20',
    };
    s.clone.post(timerA);
    await waitFor(
      async () => (s.calls[0]?.inputs.length ?? 0) >= 4,
      'timer(08-20) が誘発した再試行',
    );

    const timerB = {
      type: 'timer' as const,
      id: 'evt-timer-b',
      at: new Date().toISOString(),
      kind: 'custom-check',
      target: '2026-08-21',
    };
    s.clone.post(timerB);
    await waitFor(
      async () => (s.calls[0]?.inputs.length ?? 0) >= 5,
      'timer(08-21) が誘発した再試行',
    );

    const heldIds = [origin.id, second.id, manager.id, timerA.id, timerB.id];
    const pendingBeforeOpen = await s.stores.inbox.claimPending();
    for (const id of heldIds) {
      expect(pendingBeforeOpen.some((p) => p.event.id === id)).toBe(true);
    }
    expect(await foldedNoteCount(s)).toBe(0);

    releaseGateOpen = true;
    const trigger = humanMessage('トリガー');
    s.clone.post(trigger);
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 3);

    // 単なる部分一致で見ない: #recentDigest が台帳に載った全件を列挙し、まだ番が来ていない合図の本文も先に含むため。commitmentNoticeFor が本文の直前に挟む \n\n---\n の直後で狙う
    const inputs = (s.calls[0] as FakeCall).inputs;
    const firstIndexOf = (marker: string) => inputs.findIndex((text) => text.includes(marker));
    // 区切りと本文のあいだに会話の名乗りが入る。この歯の発言はどれも conv-1 なので、名乗りは id の1行だけである
    const order = {
      二件目: firstIndexOf('\n\n---\n[system] 会話 conv-1\n\n二件目'),
      manager: firstIndexOf('（報告）\n\nマネージャーからの一件（目印テキスト）'),
      timerA: firstIndexOf('対象: 2026-08-20'),
      timerB: firstIndexOf('対象: 2026-08-21'),
      トリガー: firstIndexOf('\n\n---\n[system] 会話 conv-1\n\nトリガー'),
    };
    for (const [label, index] of Object.entries(order)) {
      expect(index, `${label} が calls[0].inputs に見つからない`).toBeGreaterThanOrEqual(0);
    }
    expect(order.二件目).toBeLessThan(order.manager);
    expect(order.manager).toBeLessThan(order.timerA);
    expect(order.timerA).toBeLessThan(order.timerB);
    expect(order.timerB).toBeLessThan(order.トリガー);

    await s.clone.stop();
  });

  it('歯3: 発意 tick を畳んでも、枠が開いたかを試した回数は3回のまま減らない', async () => {
    const { stores, putCallCountFor } = withInboxPutSpy(createMemoryStores());
    const s = setupFixedFifo(undefined, stores, {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    const origin = humanMessage('起点');
    s.clone.post(origin);
    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === origin.id);
    }, '起点が未読として保持される');

    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-1',
      at: new Date().toISOString(),
      reason: '1本目',
    });
    await waitForReleaseAttempts(s, 1, '1件目の tick');

    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-2',
      at: new Date().toISOString(),
      reason: '2本目',
    });
    // この待ちのタイムアウトは測定である: 「tick が単独で解除を起こす」の否定は何も起きないことで、待つ以外に観測できないため
    await waitForReleaseAttempts(
      s,
      2,
      '2件目の tick（畳まれても回数は減らない — この待ちが歯の本体）',
    );

    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-3',
      at: new Date().toISOString(),
      reason: '3本目',
    });
    await waitForReleaseAttempts(s, 3, '3件目の tick（畳まれても回数は減らない）');

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs.every((text) => text.includes('起点'))).toBe(true);
    expect(inputs).toHaveLength(4);

    expect(await releaseAttemptCount(s)).toBe(3);

    expect(putCallCountFor('evt-si-1')).toBe(1);
    expect(putCallCountFor('evt-si-2')).toBe(1);
    expect(putCallCountFor('evt-si-3')).toBe(1);

    await s.clone.stop();
  }, 30_000);

  it('人間優先が有効なままでも、保持中の tick は畳まれて在庫が増えない', async () => {
    const s = setup(
      undefined,
      createMemoryStores(),
      { resultSubtype: 'error_during_execution', resultText: spendLimitMessage },
      { ALTEROID_CLONE_HUMAN_PRIORITY: 'true' },
    );

    const origin = humanMessage('起点');
    s.clone.post(origin);
    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === origin.id);
    }, '起点が未読として保持される');

    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-1',
      at: new Date().toISOString(),
      reason: '1本目',
    });
    await waitForReleaseAttempts(s, 1, '1件目の tick');
    const attemptsAfterTick1 = await releaseAttemptCount(s);

    const second = humanMessage('もう一件');
    s.clone.post(second);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === second.id);
    }, '2件目の人間の発言が未読として保持される');

    // 目標値は固定しない: 直前の人間の発言自体も枠の解除をもう1回誘発しうるため、2件目の tick を送る前の値より増えていることだけを待つ
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-2',
      at: new Date().toISOString(),
      reason: '2本目',
    });
    await waitForReleaseAttemptsAbove(
      s,
      attemptsAfterTick1,
      '2件目の tick が枠の解除をもう一度誘発する（人間優先が有効でも回数は減らない）',
    );

    const pending = await s.stores.inbox.claimPending();
    const selfInitiatives = pending.filter((p) => p.event.type === 'self_initiative');
    expect(selfInitiatives).toHaveLength(1);
    expect(selfInitiatives[0]?.event.id).toBe('evt-si-1');
    expect(await foldedNoteCount(s)).toBe(1);
    expect(pending.some((p) => p.event.id === origin.id)).toBe(true);
    expect(pending.some((p) => p.event.id === second.id)).toBe(true);

    await s.clone.stop();
  }, 30_000);
});
