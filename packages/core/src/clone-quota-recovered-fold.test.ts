import { describe, expect, it } from 'vitest';

import {
  fakeSdk,
  waitFor,
  waitForTerminal,
  wireEvents,
  type FakeCall,
} from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// 5時間枠の知らせで、名指す担当が全員もう戻っていれば、ターンを起こさず日誌にだけ残して畳む（#4499）。
const AT = '2026-09-05T00:00:00.000Z';
const AFTER_AT = '2026-09-05T01:00:00.000Z';
const MANAGER_ID = 'mgr-quota';
const FOLD_LINE = 'ターンを起こさずに畳んだ';
const RECOVERED = 'すべて回復している';
const spendLimitMessage = "You've hit your individual spend limit for this account.";

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
    reportSettleMs: 2500,
    stores,
    queryFn: fn,
    env: {},
    managers,
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { clone, calls, stores };
}

function sessionNotice(id: string, text: string, managerId = MANAGER_ID): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: AT,
    managerId,
    kind: 'report',
    text,
    synthesized: true,
    quotaStop: true,
    quotaSessionWindow: true,
  };
}

function weeklyNotice(id: string, text: string): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: AT,
    managerId: MANAGER_ID,
    kind: 'report',
    text,
    synthesized: true,
    quotaStop: true,
  };
}

function plainReport(id: string, text: string): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: AT,
    managerId: MANAGER_ID,
    kind: 'report',
    text,
  };
}

function allInputs(calls: FakeCall[]): string[] {
  return calls.flatMap((call) => call.inputs);
}

function inputContaining(calls: FakeCall[], needle: string): string {
  return (
    allInputs(calls)
      .filter((input) => input.includes(needle))
      .at(-1) ?? ''
  );
}

async function exchangeTexts(stores: Stores): Promise<string[]> {
  const rows = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
  return rows.map((row) => row.text);
}

async function waitForFoldLine(stores: Stores): Promise<void> {
  await waitFor(
    async () => (await exchangeTexts(stores)).some((text) => text.includes(FOLD_LINE)),
    '畳んだ行が日誌に書かれる',
  );
}

async function expectFolded(s: ReturnType<typeof boot>, id: string, body: string): Promise<void> {
  await waitForFoldLine(s.stores);
  // external の本文は `external_event` の行（summary）に、manager_message の本文は `exchange` の行に書かれる
  const rows = await s.stores.journal.list({ types: ['exchange', 'external_event'] });
  expect(rows.some((row) => JSON.stringify(row).includes(body))).toBe(true);
  expect(allInputs(s.calls).some((text) => text.includes(body))).toBe(false);
  const pending = (await s.stores.inbox.peekPending()).entries;
  expect(pending.some((p) => p.event.id === id)).toBe(false);
}

async function expectDelivered(s: ReturnType<typeof boot>, body: string): Promise<string> {
  await waitFor(() => allInputs(s.calls).some((text) => text.includes(body)), 'ターンが起きる');
  expect((await exchangeTexts(s.stores)).some((text) => text.includes(FOLD_LINE))).toBe(false);
  return inputContaining(s.calls, body);
}

describe('戻った担当の5時間枠の知らせを、ターンを起こさず畳む（#4499）', () => {
  it('running・世代一致・止まった印なし・live なら、SDK のターンを起こさず日誌に本文と畳んだ行を残し、受信箱から外す', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(sessionNotice('evt-fold', '枠に当たって止まった FOLD-BODY'));
    await expectFolded(s, 'evt-fold', 'FOLD-BODY');

    await s.clone.stop();
  });

  it('同じ印のプール全体の1通（runner-registry の external）でも畳まれる', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post({
      type: 'external',
      id: 'evt-pool',
      at: AT,
      source: 'runner-registry',
      identity: 'quota-stop:test',
      payload: {
        text: '枠に当たって 1 本の担当が止まった POOL-BODY',
        quotaStopManagerIds: [MANAGER_ID],
        quotaSessionWindow: true,
      },
    });
    await expectFolded(s, 'evt-pool', 'POOL-BODY');

    await s.clone.stop();
  });

  it('done で lastReportAt が知らせの at より後・lastFailure 無しなら畳まれる', async () => {
    const s = boot(
      stubPool(() => Promise.resolve([summary({ status: 'done', lastReportAt: AFTER_AT })])),
    );

    s.clone.post(sessionNotice('evt-done', '枠に当たって止まった DONE-BODY'));
    await expectFolded(s, 'evt-done', 'DONE-BODY');

    await s.clone.stop();
  });

  it('done でも lastFailure が在れば畳まず届ける', async () => {
    const s = boot(
      stubPool(() =>
        Promise.resolve([
          summary({
            status: 'done',
            lastReportAt: AFTER_AT,
            lastFailure: { code: 'success/429', via: 'result_is_error', at: AFTER_AT },
          }),
        ]),
      ),
    );

    s.clone.post(sessionNotice('evt-fail', '枠に当たって止まった FAIL-BODY'));
    expect(await expectDelivered(s, 'FAIL-BODY')).toContain('FAIL-BODY');

    await s.clone.stop();
  });

  it('担当が usageStoppedAt を持つなら届ける', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary({ usageStoppedAt: AT })])));

    s.clone.post(sessionNotice('evt-stopped', '枠に当たって止まった STOPPED-BODY'));
    await expectDelivered(s, 'STOPPED-BODY');

    await s.clone.stop();
  });

  it('担当が status: failed なら届ける', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary({ status: 'failed' })])));

    s.clone.post(sessionNotice('evt-failed', '枠に当たって止まった FAILED-BODY'));
    await expectDelivered(s, 'FAILED-BODY');

    await s.clone.stop();
  });

  it('担当が live: false なら届ける', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary({ live: false })])));

    s.clone.post(sessionNotice('evt-dead', '枠に当たって止まった DEAD-BODY'));
    await expectDelivered(s, 'DEAD-BODY');

    await s.clone.stop();
  });

  it('名指す担当が複数で1本でも戻っていなければ、戻った担当の分も含めて届ける', async () => {
    const s = boot(
      stubPool(() =>
        Promise.resolve([summary(), summary({ managerId: 'mgr-other', usageStoppedAt: AT })]),
      ),
    );

    s.clone.post({
      type: 'external',
      id: 'evt-multi',
      at: AT,
      source: 'runner-registry',
      identity: 'quota-stop:multi',
      payload: {
        text: '枠に当たって 2 本の担当が止まった MULTI-BODY',
        quotaStopManagerIds: [MANAGER_ID, 'mgr-other'],
        quotaSessionWindow: true,
      },
    });
    await expectDelivered(s, 'MULTI-BODY');

    await s.clone.stop();
  });

  it('quotaSessionWindow が無い（週の上限）知らせは、担当が戻っていても届け、「すべて回復している」の1節が付く', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(weeklyNotice('evt-weekly', '週の上限で止まった WEEKLY-BODY'));
    const input = await expectDelivered(s, 'WEEKLY-BODY');
    expect(input).toContain(RECOVERED);

    await s.clone.stop();
  });

  it('list() が投げたときは畳まず届ける', async () => {
    const s = boot(stubPool(() => Promise.reject(new Error('list が落ちた'))));

    s.clone.post(sessionNotice('evt-throw', '枠に当たって止まった THROW-BODY'));
    await expectDelivered(s, 'THROW-BODY');

    await s.clone.stop();
  });

  it('クローン自身が枠で止まっている間に保持された session の枠の知らせは、解除後の時点で担当が戻っていれば畳まれる', async () => {
    const { fn, calls } = fakeSdk(undefined, {
      resultFor: (turnIndex) =>
        turnIndex < 2 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });
    const stores = createMemoryStores();
    const clone = createClone({
      reportSettleMs: 2500,
      stores,
      queryFn: fn,
      env: {},
      managers: stubPool(() => Promise.resolve([summary()])),
      redeliveryGate: ALWAYS_REDELIVER,
    });
    const { events } = wireEvents(clone, 'conv-1');

    clone.post(humanMessage('一件目'));
    await waitForTerminal(events);
    clone.post(sessionNotice('evt-held', '保持された知らせ HELD-BODY'));
    await waitFor(() => (calls[0]?.inputs.length ?? 0) >= 2, '知らせが保持される');
    expect(allInputs(calls).some((text) => text.includes('HELD-BODY'))).toBe(false);
    // 保持の間は畳まれない（日誌にも畳んだ行は無い）
    expect((await exchangeTexts(stores)).some((text) => text.includes(FOLD_LINE))).toBe(false);

    clone.post(humanMessage('三件目'));
    await waitFor(
      async () => (await exchangeTexts(stores)).some((text) => text.includes(FOLD_LINE)),
      '解除後に畳まれる',
    );

    expect((await exchangeTexts(stores)).some((text) => text.includes('HELD-BODY'))).toBe(true);
    expect(allInputs(calls).some((text) => text.includes('HELD-BODY'))).toBe(false);
    const pending = (await stores.inbox.peekPending()).entries;
    expect(pending.some((p) => p.event.id === 'evt-held')).toBe(false);

    await clone.stop();
  });

  it('畳んだ後に来たふつうの報告は今までどおりターンになる', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(sessionNotice('evt-fold', '枠に当たって止まった FOLD-BODY'));
    await expectFolded(s, 'evt-fold', 'FOLD-BODY');

    s.clone.post(plainReport('evt-plain', 'ふつうの報告 PLAIN-BODY'));
    await waitFor(
      () => allInputs(s.calls).some((text) => text.includes('PLAIN-BODY')),
      '畳んだ後の報告でターンが起きる',
    );
    expect(allInputs(s.calls).some((text) => text.includes('FOLD-BODY'))).toBe(false);

    await s.clone.stop();
  });
});
