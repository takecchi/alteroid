import { describe, expect, it } from 'vitest';

import { fakeSdk, waitFor, type FakeCall } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, commitmentFor, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// #5015: 手を打つ必要のない知らせを台帳に積まない（起こし直しの知らせ）／担当が戻った枠の知らせの行を器が閉じる。
const AT = '2026-10-17T06:00:00.000Z';
const MANAGER_ID = 'mgr-noise';

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
    inboxSettleMs: 0,
    managers,
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { clone, calls, stores };
}

function rewokenNotice(id: string, exempt = true): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: AT,
    managerId: MANAGER_ID,
    kind: 'report',
    text: `[${MANAGER_ID}] を新しい鍵で起こし直した（枠で落ちていた。status=failed）。REWOKEN-${id}`,
    synthesized: true,
    ...(exempt ? { commitmentExempt: true as const } : {}),
  };
}

// 週の上限の知らせ（quotaSessionWindow なし）はターンとして届き、台帳に行が開く
function weeklyNotice(id: string): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: AT,
    managerId: MANAGER_ID,
    kind: 'report',
    text: `枠に当たって止まった QUOTA-${id}`,
    synthesized: true,
    quotaStop: true,
  };
}

function sessionNotice(id: string): InboxEvent {
  return { ...weeklyNotice(id), quotaSessionWindow: true } as InboxEvent;
}

function plainReport(id: string): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: AT,
    managerId: MANAGER_ID,
    kind: 'report',
    text: `ふつうの報告 PLAIN-${id}`,
  };
}

function allInputs(calls: FakeCall[]): string[] {
  return calls.flatMap((call) => call.inputs);
}

async function exchangeTexts(stores: Stores): Promise<string[]> {
  const rows = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
  return rows.map((row) => row.text);
}

async function decisionTexts(stores: Stores): Promise<string[]> {
  const rows = (await stores.journal.list({ types: ['decision'] })) as {
    decision: string;
    grounds: string;
  }[];
  return rows.map((row) => `${row.decision}\n${row.grounds}`);
}

async function waitForTurnWith(s: ReturnType<typeof boot>, needle: string): Promise<void> {
  await waitFor(
    () => allInputs(s.calls).some((text) => text.includes(needle)),
    `${needle} のターン`,
  );
}

async function waitForOpened(stores: Stores, id: string): Promise<void> {
  await waitFor(async () => (await stores.commitments.get(id)) !== null, `${id} が台帳に開く`);
}

describe('commitmentFor: 台帳に開かない印（commitmentExempt）', () => {
  it('印のある manager_message は null、無ければ今までどおり行になる', () => {
    expect(commitmentFor(rewokenNotice('e-exempt'))).toBeNull();
    const plain = commitmentFor(plainReport('e-plain'));
    expect(plain?.origin).toBe('manager');
    expect(plain?.id).toBe('e-plain');
    // 印だけを外した同じ知らせは開く
    expect(commitmentFor(rewokenNotice('e-rewoken', false))?.id).toBe('e-rewoken');
  });
});

describe('後継の居ない起こし直しの知らせは台帳に開かない（#5015）', () => {
  it('受信箱には届くが、台帳の未了は増えず、日誌に「台帳に開かなかった」の1行が残る', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(rewokenNotice('evt-r1'));
    await waitForTurnWith(s, 'REWOKEN-evt-r1');
    await waitFor(
      async () =>
        (await exchangeTexts(s.stores)).some(
          (text) => text.includes('台帳に開かなかった') && text.includes('evt-r1'),
        ),
      '日誌に開かなかった理由が残る',
    );

    expect((await s.stores.commitments.get('evt-r1')) === null).toBe(true);
    expect((await s.stores.commitments.list({ includeClosed: true })).entries).toHaveLength(0);
    expect(
      (await exchangeTexts(s.stores)).some((text) => text.includes('台帳に開いた（id: evt-r1')),
    ).toBe(false);

    await s.clone.stop();
  });

  it('印の無い同じ知らせ（後継がつながった回・withheld を運んだ回）は、今までどおり台帳に開く', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(rewokenNotice('evt-r2', false));
    await waitForOpened(s.stores, 'evt-r2');
    await waitForTurnWith(s, 'REWOKEN-evt-r2');

    expect(
      (await exchangeTexts(s.stores)).some((text) => text.includes('台帳に開かなかった')),
    ).toBe(false);

    await s.clone.stop();
  });
});

describe('担当が戻った枠の知らせの行を、器が閉じる（#5015）', () => {
  it('担当が戻ったあとの次の合図の処理で、前の枠の知らせの行が closedBy daemon で閉じ、理由が台帳と日誌に残る', async () => {
    let managers: ManagerSummary[] = [summary({ usageStoppedAt: AT })];
    const s = boot(stubPool(() => Promise.resolve(managers)));

    s.clone.post(weeklyNotice('evt-q1'));
    await waitForTurnWith(s, 'QUOTA-evt-q1');
    await waitForOpened(s.stores, 'evt-q1');
    // まだ戻っていない間は閉じない
    expect((await s.stores.commitments.get('evt-q1'))?.closedAt).toBeUndefined();

    managers = [summary()];
    s.clone.post(plainReport('evt-p1'));
    await waitFor(
      async () => (await s.stores.commitments.get('evt-q1'))?.closedAt !== undefined,
      '戻った担当の行が閉じる',
    );

    const closed = await s.stores.commitments.get('evt-q1');
    expect(closed?.closedBy).toBe('daemon');
    expect(closed?.closedReason).toContain('器が自動で閉じた');
    expect(closed?.closedReason).toContain(MANAGER_ID);
    // ふつうの報告の行は閉じない
    await waitForOpened(s.stores, 'evt-p1');
    expect((await s.stores.commitments.get('evt-p1'))?.closedAt).toBeUndefined();

    const decisions = await decisionTexts(s.stores);
    expect(
      decisions.filter((text) => text.includes('evt-q1') && text.includes(MANAGER_ID)),
    ).toHaveLength(1);

    await s.clone.stop();
  });

  it('ターンを起こさず畳む session の知らせは、自分の行も閉じる', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(sessionNotice('evt-fold'));
    await waitFor(
      async () => (await s.stores.commitments.get('evt-fold'))?.closedBy === 'daemon',
      '畳んだ知らせの行が閉じる',
    );

    expect(allInputs(s.calls).some((text) => text.includes('QUOTA-evt-fold'))).toBe(false);
    expect((await s.stores.commitments.get('evt-fold'))?.closedReason).toContain(
      '器が自動で閉じた',
    );
    expect((await decisionTexts(s.stores)).some((text) => text.includes('evt-fold'))).toBe(true);

    await s.clone.stop();
  });

  it('担当一覧を引けない間は閉じず、引けるようになった次の合図で閉じる', async () => {
    let mode: 'throw' | 'sync-throw' | 'ok' = 'ok';
    let managers: ManagerSummary[] = [summary({ usageStoppedAt: AT })];
    const s = boot(
      stubPool(() => {
        if (mode === 'sync-throw') throw new Error('list が同期で落ちた');
        if (mode === 'throw') return Promise.reject(new Error('list が落ちた'));
        return Promise.resolve(managers);
      }),
    );

    s.clone.post(weeklyNotice('evt-q2'));
    await waitForTurnWith(s, 'QUOTA-evt-q2');
    await waitForOpened(s.stores, 'evt-q2');

    managers = [summary()];
    mode = 'throw';
    s.clone.post(plainReport('evt-p2'));
    await waitForTurnWith(s, 'PLAIN-evt-p2');
    mode = 'sync-throw';
    s.clone.post(plainReport('evt-p3'));
    await waitForTurnWith(s, 'PLAIN-evt-p3');
    expect((await s.stores.commitments.get('evt-q2'))?.closedAt).toBeUndefined();
    expect((await decisionTexts(s.stores)).some((text) => text.includes('evt-q2'))).toBe(false);

    mode = 'ok';
    s.clone.post(plainReport('evt-p4'));
    await waitFor(
      async () => (await s.stores.commitments.get('evt-q2'))?.closedBy === 'daemon',
      '一覧が引けたので閉じる',
    );

    await s.clone.stop();
  });

  it('担当がまだ戻っていない（古い世代の鍵・done で知らせより後の成功なし）間は閉じない', async () => {
    let managers: ManagerSummary[] = [summary({ usageStoppedAt: AT })];
    const s = boot(stubPool(() => Promise.resolve(managers)));

    s.clone.post(weeklyNotice('evt-q3'));
    await waitForTurnWith(s, 'QUOTA-evt-q3');
    await waitForOpened(s.stores, 'evt-q3');

    managers = [summary({ activeTokenGeneration: 4 })];
    s.clone.post(plainReport('evt-p5'));
    await waitForTurnWith(s, 'PLAIN-evt-p5');
    managers = [summary({ status: 'done' })];
    s.clone.post(plainReport('evt-p6'));
    await waitForTurnWith(s, 'PLAIN-evt-p6');

    expect((await s.stores.commitments.get('evt-q3'))?.closedAt).toBeUndefined();

    await s.clone.stop();
  });
});
