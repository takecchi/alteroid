import { describe, expect, it } from 'vitest';

import { fakeSdk, waitFor, type FakeCall } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 枠の知らせ以外で、担当がいまの鍵で戻っていれば畳んでよい印（`foldWhenBack`）の付いた知らせを、ターンを起こさず畳む（#5048）。
// 2026-10-18、鍵が全部冷却中で止まった1時間のあと、担当が既に戻っている知らせ（作業者の落ち・起こし直し・セッションの落ち）を、クローンが1件ずつ受けていた。
const AT = '2026-10-18T05:10:00.000Z';
const MANAGER_ID = 'mgr-back';
const FOLD_LINE = 'ターンを起こさずに畳んだ';

function summary(overrides: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: MANAGER_ID,
    status: 'running',
    live: true,
    cwd: '/work',
    request: '依頼',
    startedAt: AT,
    updatedAt: AT,
    waiting: [],
    tokenGeneration: 3,
    activeTokenGeneration: 3,
    ...overrides,
  };
}

function stubPool(list: () => Promise<ManagerSummary[]>): ManagerPool {
  const notImplemented = () => {
    throw new Error('not implemented');
  };
  return {
    start: notImplemented,
    send: notImplemented,
    abort: notImplemented,
    list,
    denials: () => [],
    pushHealthOf: () => undefined,
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    runners: (): Promise<RunnerFleetOverview> =>
      Promise.resolve({
        runners: [
          {
            label: 'runner-0',
            state: 'connected' as RunnerLiveness,
            since: AT,
            managers: [],
            revision: { status: 'unheard' as const },
          },
        ],
        unassigned: [],
        daemonRevision: { status: 'unknown' as const, reason: 'テスト' },
      }),
    transcript: notImplemented,
    unpushedWork: notImplemented,
    runningManagerOwning: () => undefined,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: notImplemented,
    vacate: notImplemented,
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    settleStalledUsageWakes: () => Promise.resolve([]),
    renotifyStalledDenials: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

function boot(managers: ManagerPool) {
  const { fn, calls } = fakeSdk();
  const stores = createMemoryStores();
  const clone: CloneHost = createClone({
    stores,
    queryFn: fn,
    env: {},
    managers,
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { clone, calls, stores };
}

function notice(
  id: string,
  text: string,
  foldWhenBack: { movedFromGeneration?: number; attached?: true } | undefined,
  managerId: string = MANAGER_ID,
): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: AT,
    managerId,
    kind: 'report',
    text,
    ...(foldWhenBack === undefined ? {} : { foldWhenBack }),
  };
}

function allInputs(calls: FakeCall[]): string[] {
  return calls.flatMap((call) => call.inputs);
}

async function exchangeTexts(stores: Stores): Promise<string[]> {
  const rows = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
  return rows.map((row) => row.text);
}

async function expectFolded(s: ReturnType<typeof boot>, id: string, body: string): Promise<void> {
  await waitFor(
    async () => (await exchangeTexts(s.stores)).some((text) => text.includes(FOLD_LINE)),
    '畳んだ行が日誌に書かれる',
  );
  // 本文は日誌に残り、モデルへは渡らない
  expect((await exchangeTexts(s.stores)).some((text) => text.includes(body))).toBe(true);
  expect(allInputs(s.calls).some((text) => text.includes(body))).toBe(false);
  const pending = (await s.stores.inbox.peekPending()).entries;
  expect(pending.some((p) => p.event.id === id)).toBe(false);
}

async function expectDelivered(s: ReturnType<typeof boot>, body: string): Promise<void> {
  await waitFor(() => allInputs(s.calls).some((text) => text.includes(body)), 'ターンが起きる');
  expect((await exchangeTexts(s.stores)).some((text) => text.includes(FOLD_LINE))).toBe(false);
}

describe('担当が戻っていれば畳んでよい印の付いた知らせを、ターンを起こさず畳む（#5048）', () => {
  it('⭐ 起こし直し・セッションの落ちの束（世代の条件なし）: 担当が running・世代一致なら畳み、台帳の行も daemon が閉じる', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(notice('evt-rewoken', '新しい鍵で起こし直した REWOKEN-BODY', {}));
    await expectFolded(s, 'evt-rewoken', 'REWOKEN-BODY');
    await waitFor(
      async () => (await s.stores.commitments.get('evt-rewoken'))?.closedBy === 'daemon',
      '台帳の行が daemon で閉じる',
    );

    await s.clone.stop();
  });

  it('⭐ 台帳の行を閉じる瞬間には、器が閉じる日誌の行が既に在る（#5235。日誌が先）', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));
    const decisionsAtClose: string[] = [];
    const realClose = s.stores.commitments.close.bind(s.stores.commitments);
    s.stores.commitments.close = async (id, at, reason, by) => {
      decisionsAtClose.push(JSON.stringify(await s.stores.journal.list({ types: ['decision'] })));
      return realClose(id, at, reason, by);
    };

    s.clone.post(notice('evt-order', '新しい鍵で起こし直した ORDER-BODY', {}));
    await waitFor(
      async () => (await s.stores.commitments.get('evt-order'))?.closedBy === 'daemon',
      '台帳の行が daemon で閉じる',
    );
    expect(decisionsAtClose).toHaveLength(1);
    expect(decisionsAtClose[0]).toContain('evt-order');

    await s.clone.stop();
  });

  it('⭐ 日誌に器が閉じる行を書けないときは、台帳の行を閉じない（#5235。未了のまま残る）', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));
    const realAppend = s.stores.journal.append.bind(s.stores.journal);
    let refused = 0;
    s.stores.journal.append = (entry) => {
      if (entry.type === 'decision' && entry.decision.includes('自動で閉じる')) {
        refused += 1;
        return Promise.reject(new Error('journal down'));
      }
      return realAppend(entry);
    };
    let closeCalls = 0;
    const realClose = s.stores.commitments.close.bind(s.stores.commitments);
    s.stores.commitments.close = (...args) => {
      closeCalls += 1;
      return realClose(...args);
    };

    s.clone.post(notice('evt-nojournal', '新しい鍵で起こし直した NOJOURNAL-BODY', {}));
    await expectFolded(s, 'evt-nojournal', 'NOJOURNAL-BODY');
    // 日誌の行を書こうとして断られた後でも、閉じる処理は呼ばれず、行は開いたまま
    await waitFor(() => refused > 0, '日誌の行が断られる');
    expect(closeCalls).toBe(0);
    expect((await s.stores.commitments.get('evt-nojournal'))?.closedAt).toBeUndefined();

    await s.clone.stop();
  });

  it('⭐ セッションが落ちたまま（status: failed）なら届ける', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary({ status: 'failed' })])));

    s.clone.post(notice('evt-crash', 'マネージャーのセッションが落ちた CRASH-BODY', {}));
    await expectDelivered(s, 'CRASH-BODY');

    await s.clone.stop();
  });

  it('⭐ 作業者の落ち: 担当が積んだ時点の世代（2）から現役の世代（3）へ移って戻っていれば畳む', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(
      notice('evt-worker', '作業者だけが利用上限で落ちた WORKER-BODY', { movedFromGeneration: 2 }),
    );
    await expectFolded(s, 'evt-worker', 'WORKER-BODY');

    await s.clone.stop();
  });

  it('⭐ 作業者の落ち: 担当が積んだ時点と同じ世代のまま（同じ鍵で作業者だけが落ちた）なら届ける', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(
      notice('evt-same', '作業者だけが利用上限で落ちた SAME-BODY', { movedFromGeneration: 3 }),
    );
    await expectDelivered(s, 'SAME-BODY');

    await s.clone.stop();
  });

  it('担当の世代が現役と違う（まだ古い鍵）なら届ける', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary({ tokenGeneration: 2 })])));

    s.clone.post(notice('evt-old', '新しい鍵で起こし直した OLD-BODY', {}));
    await expectDelivered(s, 'OLD-BODY');

    await s.clone.stop();
  });

  it('⭐ 鍵の入れ替えで背景処理を畳んだ起こし直しの知らせ（usage_rewoken_folded）: 戻っていれば畳み、本文（結果は届かない旨）は日誌に残り、台帳の行も daemon が閉じる', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));
    const body = `[${MANAGER_ID}] 鍵の入れ替えのため、背景処理 2 本を畳んで新しい鍵で起こし直し、結果は届かないので自分で確かめて続きを進めるよう促した`;

    s.clone.post(notice('evt-folded', body, {}));
    await expectFolded(s, 'evt-folded', body);
    await waitFor(
      async () => (await s.stores.commitments.get('evt-folded'))?.closedBy === 'daemon',
      '台帳の行が daemon で閉じる',
    );
    // ターンは1回も回らない
    expect(s.calls).toHaveLength(0);

    await s.clone.stop();
  });

  it('⭐ usage_rewoken_folded: 担当が戻っていない（done で知らせより後の成功が無い）なら届ける', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary({ status: 'done' })])));

    s.clone.post(notice('evt-folded-notback', '背景処理 1 本を畳んで FOLDED-NOTBACK-BODY', {}));
    await expectDelivered(s, 'FOLDED-NOTBACK-BODY');

    await s.clone.stop();
  });

  it('usage_rewoken_folded: list() が投げたときは畳まず届ける', async () => {
    const s = boot(stubPool(() => Promise.reject(new Error('list が落ちた'))));

    s.clone.post(notice('evt-folded-throw', '背景処理 1 本を畳んで FOLDED-THROW-BODY', {}));
    await expectDelivered(s, 'FOLDED-THROW-BODY');

    await s.clone.stop();
  });

  it('印の無い報告は、担当が戻っていても届ける', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(notice('evt-plain', 'ふつうの報告 PLAIN-BODY', undefined));
    await expectDelivered(s, 'PLAIN-BODY');

    await s.clone.stop();
  });

  describe('デーモン再起動の引き取り直し（attached）の知らせは、live かつ running のときだけ畳む', () => {
    // 引き取り直しは鍵の世代を記録しない: 世代が欠けていても、世代が食い違っていても畳む（基準は live・枠停止の印なし・running）
    const attached = { attached: true as const };

    it('⭐ running かつ live の N 本はターン0で畳み、本文は日誌・台帳の行は daemon で閉じる', async () => {
      const ids = ['mgr-1', 'mgr-2', 'mgr-3'];
      const s = boot(
        stubPool(() =>
          Promise.resolve(
            ids.map((managerId) =>
              summary({ managerId, tokenGeneration: undefined, activeTokenGeneration: 5 }),
            ),
          ),
        ),
      );

      for (const id of ids) {
        s.clone.post(notice(`evt-${id}`, `デーモンが再起動した ATTACHED-${id}`, attached, id));
      }
      await waitFor(
        async () =>
          (await exchangeTexts(s.stores)).filter((text) => text.includes(FOLD_LINE)).length === 3,
        '3本とも畳んだ行が日誌に書かれる',
      );
      for (const id of ids) {
        expect(
          (await exchangeTexts(s.stores)).some((text) => text.includes(`ATTACHED-${id}`)),
        ).toBe(true);
        await waitFor(
          async () => (await s.stores.commitments.get(`evt-${id}`))?.closedBy === 'daemon',
          '台帳の行が daemon で閉じる',
        );
      }
      // ターン0: モデルへは1文字も渡らない
      expect(allInputs(s.calls)).toEqual([]);

      await s.clone.stop();
    });

    it('非 attached の restored（印なし）は、担当が running・live でも届ける', async () => {
      const s = boot(stubPool(() => Promise.resolve([summary()])));

      s.clone.post(notice('evt-resumed', '器が作り直された RESUMED-BODY', undefined));
      await expectDelivered(s, 'RESUMED-BODY');

      await s.clone.stop();
    });

    it.each([
      ['live でない', () => Promise.resolve([summary({ live: false })])],
      ['running でない（done）', () => Promise.resolve([summary({ status: 'done' })])],
      ['running でない（failed）', () => Promise.resolve([summary({ status: 'failed' })])],
      [
        '枠停止の印が立っている',
        () => Promise.resolve([summary({ usageStoppedAt: '2026-10-18T05:00:00.000Z' })]),
      ],
      ['一覧が引けない', () => Promise.reject(new Error('list が落ちた'))],
      ['担当が一覧に居ない', () => Promise.resolve([summary({ managerId: 'someone-else' })])],
    ])('%s ときは畳まずターンを起こす', async (_name, list) => {
      const s = boot(stubPool(list));

      s.clone.post(notice('evt-att-wake', '再起動した ATT-WAKE-BODY', attached));
      await expectDelivered(s, 'ATT-WAKE-BODY');

      await s.clone.stop();
    });
  });

  it('list() が投げたときは畳まず届ける', async () => {
    const s = boot(stubPool(() => Promise.reject(new Error('list が落ちた'))));

    s.clone.post(notice('evt-throw', '新しい鍵で起こし直した THROW-BODY', {}));
    await expectDelivered(s, 'THROW-BODY');

    await s.clone.stop();
  });
});
