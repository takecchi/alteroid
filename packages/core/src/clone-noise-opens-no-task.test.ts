import { describe, expect, it } from 'vitest';

import { fakeSdk, waitFor, type FakeCall } from './clone-test-harness.js';
import { createClone } from './clone.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { opensHumanTask } from './task-auto-done.js';
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

async function waitForTurnWith(s: ReturnType<typeof boot>, needle: string): Promise<void> {
  await waitFor(
    () => allInputs(s.calls).some((text) => text.includes(needle)),
    `${needle} のターン`,
  );
}

describe('manager_message は印の有無によらず Task を開かない（#5469 P5。commitmentExempt の歯の置き換え）', () => {
  it('印のある知らせも、印の無い知らせも null（以前は印の無い知らせだけが行になった）', () => {
    expect(opensHumanTask(rewokenNotice('e-exempt'))).toBe(false);
    expect(opensHumanTask(plainReport('e-plain'))).toBe(false);
    expect(opensHumanTask(rewokenNotice('e-rewoken', false))).toBe(false);
    expect(opensHumanTask(weeklyNotice('e-weekly'))).toBe(false);
  });
});

describe('起こし直しの知らせは Task を開かない（#5015 → #5469 P5 で印の有無によらず開かない）', () => {
  it('受信箱には届くが、Task は1件も増えない', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(rewokenNotice('evt-r1'));
    await waitForTurnWith(s, 'REWOKEN-evt-r1');

    expect((await s.stores.tasks.get('evt-r1')) === null).toBe(true);
    expect((await s.stores.tasks.list({ includeClosed: true })).entries).toHaveLength(0);

    await s.clone.stop();
  });

  it('印の無い同じ知らせ（後継がつながった回・withheld を運んだ回）も Task を開かず、ターンには届く', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(rewokenNotice('evt-r2', false));
    await waitForTurnWith(s, 'REWOKEN-evt-r2');

    expect((await s.stores.tasks.list({ includeClosed: true })).entries).toHaveLength(0);
    expect(
      (await exchangeTexts(s.stores)).some((text) => text.includes('台帳に開かなかった')),
    ).toBe(false);

    await s.clone.stop();
  });
});
