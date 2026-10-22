import { describe, expect, it } from 'vitest';

import { fakeSdk, waitFor, type FakeCall } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, commitmentFor, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import { isBareQuotaStopReportText } from './quota-stop-notice.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { Commitment, InboxEvent } from './schema.js';
import { FAILED_REPORT_PARTIAL_MARKER } from './sdk-failure.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// #5164: 枠の知らせの行の自動クローズが、再起動で候補を失わない・後継に替わった担当を戻ったと見る。
const AT = '2026-10-17T06:00:00.000Z';
const MANAGER_ID = 'mgr-noise';
const SDK_TEXT = "You've hit your session limit · resets 12:20am (Asia/Tokyo)";
const BARE_TEXT = `（このターンは応答を返さずに終わった: rate_limit / assistant_error）\n${SDK_TEXT}`;

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
    managers,
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { clone, calls, stores };
}

function quotaNotice(id: string, text = BARE_TEXT, managerId = MANAGER_ID): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: AT,
    managerId,
    kind: 'report',
    text,
    synthesized: true,
    quotaStop: true,
  };
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

async function waitForTurnWith(s: ReturnType<typeof boot>, needle: string): Promise<void> {
  await waitFor(
    () => allInputs(s.calls).some((text) => text.includes(needle)),
    `${needle} のターン`,
  );
}

async function waitClosedByDaemon(stores: Stores, id: string): Promise<void> {
  await waitFor(
    async () => (await stores.commitments.get(id))?.closedBy === 'daemon',
    `${id} が器に閉じられる`,
  );
}

async function decisionTexts(stores: Stores): Promise<string[]> {
  const rows = (await stores.journal.list({ types: ['decision'] })) as {
    decision: string;
    grounds: string;
  }[];
  return rows.map((row) => `${row.decision}\n${row.grounds}`);
}

// 印の付く前に開いた行（今の台帳に溜まっている形）を直接置く
async function seedLegacy(stores: Stores, id: string, entry: Partial<Commitment> = {}) {
  await stores.commitments.open({
    id,
    at: AT,
    origin: 'manager',
    source: MANAGER_ID,
    body: `[report] ${BARE_TEXT}`,
    ...entry,
  });
}

async function seedMarked(
  stores: Stores,
  id: string,
  managerId: string,
  body = `[report] x ${id}`,
) {
  await stores.commitments.open({
    id,
    at: AT,
    origin: 'manager',
    source: managerId,
    body,
    autoCloseWhenBack: { managerId },
  });
}

describe('枠の知らせで開いた行に印が付く（#5164）', () => {
  it('枠の知らせの行には名指す担当を持つ印が付き、枠の知らせでない行には付かない', () => {
    expect(commitmentFor(quotaNotice('e1'))?.autoCloseWhenBack).toEqual({ managerId: MANAGER_ID });
    expect(commitmentFor(plainReport('e2'))?.autoCloseWhenBack).toBeUndefined();
  });

  it('失敗する前に出ていた本文が付いた知らせには、印を付けない', () => {
    const withPartial = quotaNotice(
      'e3',
      `${BARE_TEXT}\n\n${FAILED_REPORT_PARTIAL_MARKER}\nここまで進んだ`,
    );
    const entry = commitmentFor(withPartial);
    expect(entry?.id).toBe('e3');
    expect(entry?.autoCloseWhenBack).toBeUndefined();
  });
});

describe('失敗する前に出ていた本文付きの知らせは、担当が戻っても閉じない（#5164）', () => {
  it('同じプロセスで記帳した行も、再起動の後に読み直した行も、候補に入らない', async () => {
    const partialText = `${BARE_TEXT}\n\n${FAILED_REPORT_PARTIAL_MARKER}\nここまで進んだ`;
    const first = boot(stubPool(() => Promise.resolve([summary()])));
    first.clone.post(quotaNotice('evt-pt1', partialText));
    await waitFor(
      async () => (await first.stores.commitments.get('evt-pt1')) !== null,
      '台帳に開く',
    );
    first.clone.post(plainReport('evt-pt2'));
    await waitForTurnWith(first, 'PLAIN-evt-pt2');
    expect((await first.stores.commitments.get('evt-pt1'))?.closedAt).toBeUndefined();
    await first.clone.stop();

    const second = boot(
      stubPool(() => Promise.resolve([summary()])),
      first.stores,
    );
    second.clone.post(plainReport('evt-pt3'));
    await waitForTurnWith(second, 'PLAIN-evt-pt3');
    expect((await second.stores.commitments.get('evt-pt1'))?.closedAt).toBeUndefined();
    await second.clone.stop();
  });
});

describe('再起動で候補を台帳から組み直す（#5164）', () => {
  it('⭐ 新しい Clone を同じストアで起こすと、印のある開いた行が候補に戻り、担当が戻っていれば閉じる', async () => {
    let managers: ManagerSummary[] = [summary({ usageStoppedAt: AT })];
    const first = boot(stubPool(() => Promise.resolve(managers)));
    first.clone.post(quotaNotice('evt-r1', `枠に当たって止まった R1`));
    await waitFor(
      async () => (await first.stores.commitments.get('evt-r1')) !== null,
      '台帳に開く',
    );
    expect((await first.stores.commitments.get('evt-r1'))?.autoCloseWhenBack).toEqual({
      managerId: MANAGER_ID,
    });
    await first.clone.stop();

    managers = [summary()];
    const second = boot(
      stubPool(() => Promise.resolve(managers)),
      first.stores,
    );
    second.clone.post(plainReport('evt-p1'));
    await waitClosedByDaemon(second.stores, 'evt-r1');
    expect((await second.stores.commitments.get('evt-r1'))?.closedReason).toContain(MANAGER_ID);
    await second.clone.stop();
  });

  it('再起動の後も担当が戻っていなければ、閉じない', async () => {
    const stores = createMemoryStores();
    await seedMarked(stores, 'evt-r2', MANAGER_ID);
    await seedMarked(stores, 'evt-r2-ctl', 'mgr-ctl');
    const s = boot(
      stubPool(() =>
        Promise.resolve([summary({ usageStoppedAt: AT }), summary({ managerId: 'mgr-ctl' })]),
      ),
      stores,
    );
    s.clone.post(plainReport('evt-p2'));
    await waitClosedByDaemon(stores, 'evt-r2-ctl');
    expect((await stores.commitments.get('evt-r2'))?.closedAt).toBeUndefined();
    await s.clone.stop();
  });

  it('台帳が読めない間は何も戻さず閉じない。読めるようになった次の掃除で戻す', async () => {
    const stores = createMemoryStores();
    await seedMarked(stores, 'evt-u1', MANAGER_ID);
    let readable = false;
    const realList = stores.commitments.list.bind(stores.commitments);
    stores.commitments.list = (options) =>
      readable ? realList(options) : Promise.reject(new Error('台帳が読めない'));
    const s = boot(
      stubPool(() => Promise.resolve([summary()])),
      stores,
    );
    s.clone.post(plainReport('evt-p3'));
    await waitForTurnWith(s, 'PLAIN-evt-p3');
    expect((await stores.commitments.get('evt-u1'))?.closedAt).toBeUndefined();

    readable = true;
    s.clone.post(plainReport('evt-p4'));
    await waitClosedByDaemon(stores, 'evt-u1');
    await s.clone.stop();
  });
});

describe('後継に替わった担当の行を、後継が戻っていれば閉じる（#5164）', () => {
  const failedOld = (extra: Partial<ManagerSummary> = {}) =>
    summary({
      managerId: 'mgr-old',
      status: 'failed',
      live: false,
      supersededBy: 'mgr-new',
      ...extra,
    });

  it('⭐ 元の担当が failed で、後継が戻っていれば閉じる。理由と日誌に後継の id が出る', async () => {
    const stores = createMemoryStores();
    await seedMarked(stores, 'evt-s1', 'mgr-old');
    const s = boot(
      stubPool(() => Promise.resolve([failedOld(), summary({ managerId: 'mgr-new' })])),
      stores,
    );
    s.clone.post(plainReport('evt-p5'));
    await waitClosedByDaemon(stores, 'evt-s1');
    const closed = await stores.commitments.get('evt-s1');
    expect(closed?.closedReason).toContain('mgr-old');
    expect(closed?.closedReason).toContain('mgr-new');
    expect(
      (await decisionTexts(stores)).some(
        (text) => text.includes('evt-s1') && text.includes('mgr-new'),
      ),
    ).toBe(true);
    await s.clone.stop();
  });

  it('後継が戻っていなければ閉じない', async () => {
    const stores = createMemoryStores();
    await seedMarked(stores, 'evt-s2', 'mgr-old');
    await seedMarked(stores, 'evt-s2-ctl', 'mgr-ctl');
    const s = boot(
      stubPool(() =>
        Promise.resolve([
          failedOld(),
          summary({ managerId: 'mgr-new', usageStoppedAt: AT }),
          summary({ managerId: 'mgr-ctl' }),
        ]),
      ),
      stores,
    );
    s.clone.post(plainReport('evt-p6'));
    await waitClosedByDaemon(stores, 'evt-s2-ctl');
    expect((await stores.commitments.get('evt-s2'))?.closedAt).toBeUndefined();
    await s.clone.stop();
  });

  it('後継の後継が戻っていれば閉じ、輪になっていても止まる', async () => {
    const stores = createMemoryStores();
    await seedMarked(stores, 'evt-s3', 'mgr-old');
    await seedMarked(stores, 'evt-s3-loop', 'mgr-a');
    await seedMarked(stores, 'evt-s3-ctl', 'mgr-ctl');
    const s = boot(
      stubPool(() =>
        Promise.resolve([
          failedOld(),
          summary({ managerId: 'mgr-new', status: 'lost', live: false, supersededBy: 'mgr-newer' }),
          summary({ managerId: 'mgr-newer' }),
          summary({ managerId: 'mgr-a', status: 'failed', live: false, supersededBy: 'mgr-b' }),
          summary({ managerId: 'mgr-b', status: 'failed', live: false, supersededBy: 'mgr-a' }),
          summary({ managerId: 'mgr-ctl' }),
        ]),
      ),
      stores,
    );
    s.clone.post(plainReport('evt-p7'));
    await waitClosedByDaemon(stores, 'evt-s3');
    await waitClosedByDaemon(stores, 'evt-s3-ctl');
    expect((await stores.commitments.get('evt-s3-loop'))?.closedAt).toBeUndefined();
    await s.clone.stop();
  });

  it('後継の居ない failed・lost・止められた担当の行は閉じない', async () => {
    const stores = createMemoryStores();
    await seedMarked(stores, 'evt-n-failed', 'mgr-f');
    await seedMarked(stores, 'evt-n-lost', 'mgr-l');
    await seedMarked(stores, 'evt-n-stopped', 'mgr-s');
    await seedMarked(stores, 'evt-n-ctl', 'mgr-ctl');
    const s = boot(
      stubPool(() =>
        Promise.resolve([
          summary({ managerId: 'mgr-f', status: 'failed', live: false }),
          summary({ managerId: 'mgr-l', status: 'lost', live: false }),
          summary({ managerId: 'mgr-s', status: 'stopped', live: false }),
          summary({ managerId: 'mgr-ctl' }),
        ]),
      ),
      stores,
    );
    s.clone.post(plainReport('evt-p8'));
    await waitClosedByDaemon(stores, 'evt-n-ctl');
    for (const id of ['evt-n-failed', 'evt-n-lost', 'evt-n-stopped']) {
      expect((await stores.commitments.get(id))?.closedAt).toBeUndefined();
    }
    await s.clone.stop();
  });
});

describe('印の無い古い行を、定型だけのものに限って候補へ戻す（#5164）', () => {
  it('定型だけの行は候補に戻り、担当が戻っていれば閉じる', async () => {
    const stores = createMemoryStores();
    await seedLegacy(stores, 'evt-l1');
    const s = boot(
      stubPool(() => Promise.resolve([summary()])),
      stores,
    );
    s.clone.post(plainReport('evt-p9'));
    await waitClosedByDaemon(stores, 'evt-l1');
    await s.clone.stop();
  });

  it('担当の言葉が混ざった行・失敗する前に出ていた本文付きの行・作業者の注記付きの行・origin が違う行は、戻らない', async () => {
    const stores = createMemoryStores();
    await seedLegacy(stores, 'evt-l-ctl', {
      body: `[report] ${BARE_TEXT.replace('12:20am', '1:00am')}`,
    });
    await seedLegacy(stores, 'evt-l-said', {
      body: `[report] ${BARE_TEXT.replace('12:20am', '2:00am')}\n\n担当の言葉: ここまで進んだ`,
    });
    await seedLegacy(stores, 'evt-l-partial', {
      body: `[report] ${BARE_TEXT.replace('12:20am', '3:00am')}\n\n${FAILED_REPORT_PARTIAL_MARKER}\n進み具合`,
    });
    await seedLegacy(stores, 'evt-l-worker', {
      body: `[report] ${BARE_TEXT.replace('12:20am', '4:00am')}\n（このターンでは作業者が 1 体開いていた。どちらが当たったかは SDK からは分からない）`,
    });
    await seedLegacy(stores, 'evt-l-origin', {
      origin: 'external',
      body: `[report] ${BARE_TEXT.replace('12:20am', '5:00am')}`,
    });
    await seedLegacy(stores, 'evt-l-human', {
      origin: 'human',
      source: 'conv',
      body: `[report] ${BARE_TEXT.replace('12:20am', '6:00am')}`,
    });
    await seedLegacy(stores, 'evt-l-prose', {
      body: `[report] （このターンは応答を返さずに終わった: rate_limit / assistant_error）\n担当より: ${SDK_TEXT}`,
    });
    await seedLegacy(stores, 'evt-l-notquota', {
      body: `[report] （このターンは応答を返さずに終わった: server_error / assistant_error）\n${SDK_TEXT}`,
    });
    const s = boot(
      stubPool(() => Promise.resolve([summary()])),
      stores,
    );
    s.clone.post(plainReport('evt-p10'));
    // evt-l-ctl は定型だけなので閉じる。閉じた時点で掃除は走り終わっている
    await waitClosedByDaemon(stores, 'evt-l-ctl');
    for (const id of [
      'evt-l-said',
      'evt-l-partial',
      'evt-l-worker',
      'evt-l-origin',
      'evt-l-human',
      'evt-l-prose',
      'evt-l-notquota',
    ]) {
      expect((await stores.commitments.get(id))?.closedAt).toBeUndefined();
    }
    await s.clone.stop();
  });

  it('判定の形: runner の failedReportText が作る定型だけを受ける', () => {
    expect(isBareQuotaStopReportText(BARE_TEXT)).toBe(true);
    expect(
      isBareQuotaStopReportText(
        `（このターンは応答を返さずに終わった: success/429 / result_is_error）\n${SDK_TEXT}`,
      ),
    ).toBe(true);
    expect(isBareQuotaStopReportText(`${BARE_TEXT}\n`)).toBe(false);
    expect(isBareQuotaStopReportText(SDK_TEXT)).toBe(false);
    expect(
      isBareQuotaStopReportText(
        `（このターンは応答を返さずに終わった: success/500 / result_is_error）\n${SDK_TEXT}`,
      ),
    ).toBe(false);
  });
});
