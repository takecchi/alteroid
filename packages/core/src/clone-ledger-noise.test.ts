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

function boot(managers: ManagerPool, stores: Stores = createMemoryStores()) {
  const { fn, calls } = fakeSdk();
  const clone: CloneHost = createClone({
    stores,
    queryFn: fn,
    env: {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
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

// #5469 P5: 枠の知らせ（quotaStop）の行は新しく開かなくなった。アップグレード前の版が開いた行（印 autoCloseWhenBack つき）は台帳に残り、
// 担当が戻ったら器が閉じる側（#5015/#5164）は残してある。その行を直接置いて、閉じる側の保証を同じ歯で測り続ける（歯を外して保証を弱めない）
async function seedLegacyQuotaRow(stores: Stores, id: string): Promise<void> {
  await stores.commitments.open({
    id,
    at: AT,
    origin: 'manager',
    source: MANAGER_ID,
    body: `[report] 枠に当たって止まった QUOTA-${id}`,
    autoCloseWhenBack: { managerId: MANAGER_ID },
  });
}

describe('commitmentFor: manager_message は印の有無によらず台帳に開かない（#5469 P5。commitmentExempt の歯の置き換え）', () => {
  it('印のある知らせも、印の無い知らせも null（以前は印の無い知らせだけが行になった）', () => {
    expect(commitmentFor(rewokenNotice('e-exempt'))).toBeNull();
    expect(commitmentFor(plainReport('e-plain'))).toBeNull();
    expect(commitmentFor(rewokenNotice('e-rewoken', false))).toBeNull();
    expect(commitmentFor(weeklyNotice('e-weekly'))).toBeNull();
  });
});

describe('起こし直しの知らせは台帳に開かない（#5015 → #5469 P5 で印の有無によらず開かない）', () => {
  it('受信箱には届くが、台帳の行は1件も増えない', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(rewokenNotice('evt-r1'));
    await waitForTurnWith(s, 'REWOKEN-evt-r1');

    expect((await s.stores.commitments.get('evt-r1')) === null).toBe(true);
    expect((await s.stores.commitments.list({ includeClosed: true })).entries).toHaveLength(0);

    await s.clone.stop();
  });

  it('印の無い同じ知らせ（後継がつながった回・withheld を運んだ回）も台帳に開かず、ターンには届く', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(rewokenNotice('evt-r2', false));
    await waitForTurnWith(s, 'REWOKEN-evt-r2');

    expect((await s.stores.commitments.list({ includeClosed: true })).entries).toHaveLength(0);
    expect(
      (await exchangeTexts(s.stores)).some((text) => text.includes('台帳に開かなかった')),
    ).toBe(false);

    await s.clone.stop();
  });
});

describe('担当が戻った枠の知らせの行を、器が閉じる（#5015）', () => {
  it('担当が戻ったあとの次の合図の処理で、前の枠の知らせの行が closedBy daemon で閉じ、理由が台帳と日誌に残る', async () => {
    let managers: ManagerSummary[] = [summary({ usageStoppedAt: AT })];
    const stores = createMemoryStores();
    await seedLegacyQuotaRow(stores, 'evt-q1');
    const s = boot(
      stubPool(() => Promise.resolve(managers)),
      stores,
    );

    s.clone.post(weeklyNotice('evt-q1-next'));
    await waitForTurnWith(s, 'QUOTA-evt-q1-next');
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
    // ふつうの報告は、もう台帳に行にならない（#5469 P5。以前は行になって、閉じられずに残ることを測っていた）
    expect(await s.stores.commitments.get('evt-p1')).toBeNull();

    const decisions = await decisionTexts(s.stores);
    expect(
      decisions.filter((text) => text.includes('evt-q1') && text.includes(MANAGER_ID)),
    ).toHaveLength(1);

    await s.clone.stop();
  });

  it('ターンを起こさず畳む session の知らせは、自分の行も閉じる', async () => {
    const stores = createMemoryStores();
    await seedLegacyQuotaRow(stores, 'evt-fold');
    const s = boot(
      stubPool(() => Promise.resolve([summary()])),
      stores,
    );

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
    const stores = createMemoryStores();
    await seedLegacyQuotaRow(stores, 'evt-q2');
    const s = boot(
      stubPool(() => {
        if (mode === 'sync-throw') throw new Error('list が同期で落ちた');
        if (mode === 'throw') return Promise.reject(new Error('list が落ちた'));
        return Promise.resolve(managers);
      }),
      stores,
    );

    s.clone.post(weeklyNotice('evt-q2-next'));
    await waitForTurnWith(s, 'QUOTA-evt-q2-next');

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
    const stores = createMemoryStores();
    await seedLegacyQuotaRow(stores, 'evt-q3');
    const s = boot(
      stubPool(() => Promise.resolve(managers)),
      stores,
    );

    s.clone.post(weeklyNotice('evt-q3-next'));
    await waitForTurnWith(s, 'QUOTA-evt-q3-next');

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
