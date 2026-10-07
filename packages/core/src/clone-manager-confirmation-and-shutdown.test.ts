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

    void session.ask('Bash', 'req-live');

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

    const pending = session.ask('Bash', 'req-settled');
    const inputs = (): string[] => calls[0]?.inputs ?? [];
    await waitFor(
      () => inputs().some((input) => input.includes('req-settled')),
      '『req-settled』を含む入力が届く',
    );

    const sendResult = await clone.managers.send(managerId, 'それでよい', {
      requestId: 'req-settled',
      decision: 'allow',
    });
    expect(sendResult.outcome).toBe('answered');
    expect(await pending).toEqual({ behavior: 'allow' });

    await waitForExpect(
      async () =>
        expect(
          (await clone.managers.list())
            .find((m) => m.managerId === managerId)
            ?.waiting.map((w) => w.requestId),
        ).toEqual([]),
      'managerId のマネージャーの waiting からリクエストが消える',
    );

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

    expect(redelivered).not.toContain('返事をするまで');
    expect(redelivered).not.toContain('manager_send');
    expect(redelivered).not.toContain('ask_human');
    expect(redelivered).toContain('もう待たれていない');

    await clone.stop();
  });

  it('別のマネージャーの生きている確認と混ざらない（managerId で絞り込む）', async () => {
    const { clone, manager, calls } = setupWithManager();

    const { managerId: managerA } = await clone.managers.start({ request: 'A の仕事' });
    const sessionA = manager.sessions[0];
    if (!sessionA) throw new Error('mgr-A のセッションが無い');
    const pendingA = sessionA.ask('Bash', 'req-shared');
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
    const order = (await clone.managers.list()).map((m) => m.managerId);
    expect(order[0]).toBe(managerB);

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

    expect(redelivered).toContain('もう待たれていない');
    expect(redelivered).not.toContain('返事をするまで');

    await clone.stop();
  });

  it('managers.list() が投げても、ターンは落ちず、いまの文言のまま届く', async () => {
    const { fn, calls } = fakeSdk();
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

    const inputs = (): string[] => calls[0]?.inputs ?? [];
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('確かめられない'))).toBeTruthy(),
      '『確かめられない』を含む入力が届く',
    );
    const text = inputs().find((input) => input.includes('確かめられない')) ?? '';

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

describe('クローン — shutdown 蒸留の重複防止', () => {
  const DISTILL_MARKER = '記憶へ移すべきものがあるか確認せよ';

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
      resultFor: (turnIndex) =>
        turnIndex === 1 ? { subtype: 'error_during_execution', isError: true } : undefined,
    });

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');
    await s.clone.stop();

    const inputs = (s.calls[0] as FakeCall).inputs;
    const distillPrompts = inputs.filter((input) => input.includes(DISTILL_MARKER));
    expect(distillPrompts.length).toBe(2);
    expect(await skippedDistillEntries(s.stores)).toEqual([]);
  });

  it('D: 最初の会話終了では、蒸留が見送られずにちゃんと走る（重複防止が正常な経路を殺していない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    // stop() の前にアサーションを済ませる: stop() の shutdown 蒸留が見送りエントリを生み、「見送りが無い」の検査がそれで落ちるため
    const inputs = (s.calls[0] as FakeCall).inputs;
    const distillPrompts = inputs.filter((input) => input.includes(DISTILL_MARKER));
    expect(distillPrompts.length).toBe(1);
    expect(await skippedDistillEntries(s.stores)).toEqual([]);

    await s.clone.stop();
  });

  // (3) を別会話の人間の発言でセッションを戻してから確かめない: 通常のターンの markActivity() が印を無条件に立て直し、誤って倒した変異と区別できなくなるため
  it('E: セッションが（畳みとは無関係に）自然に終わった直後は、蒸留は走らないが見送りが日誌に残り、活動の印は倒れない（Issue #1650）', async () => {
    const s = setup(() => 'わかった', createMemoryStores(), { endSessionAfterTurn: 0 });

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await flushPendingMicrotasks();

    const journalCountBefore = (await s.stores.journal.list({})).length;
    await s.clone.endConversation('conv-1');
    const journalCountAfter = (await s.stores.journal.list({})).length;

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs.filter((input) => input.includes(DISTILL_MARKER)).length).toBe(0);

    expect(journalCountAfter).toBe(journalCountBefore + 1);
    const skipped = await skippedDistillEntries(s.stores);
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.text).toContain('蒸留（conversation_end）は見送った');
    expect(skipped[0]?.text).toContain('セッションが無い');

    const journalCountBeforeSecond = journalCountAfter;
    await s.clone.endConversation('conv-1');
    const journalCountAfterSecond = (await s.stores.journal.list({})).length;
    expect(journalCountAfterSecond).toBe(journalCountBeforeSecond + 1);
    expect((await skippedDistillEntries(s.stores)).length).toBe(2);

    await s.clone.stop();
  });

  it('F: セッションが無く、未蒸留の活動も無ければ、これまでどおり日誌を増やさず黙って見送る（Issue #1650）', async () => {
    const s = setup(() => 'わかった', createMemoryStores(), { endSessionAfterTurn: 1 });

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');
    expect(await skippedDistillEntries(s.stores)).toEqual([]);
    const distillPrompts = (s.calls[0] as FakeCall).inputs.filter((input) =>
      input.includes(DISTILL_MARKER),
    );
    expect(distillPrompts.length).toBe(1);

    await flushPendingMicrotasks();

    const journalCountBefore = (await s.stores.journal.list({})).length;
    await s.clone.endConversation('conv-1');
    const journalCountAfter = (await s.stores.journal.list({})).length;

    expect(journalCountAfter).toBe(journalCountBefore);
    expect(await skippedDistillEntries(s.stores)).toEqual([]);

    await s.clone.stop();
  });

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

    expect(journalCountAfterDay1).toBe(journalCountBefore);
    expect(journalCountAfterDay2).toBe(journalCountAfterDay1);

    await s.clone.stop();
  });
});
