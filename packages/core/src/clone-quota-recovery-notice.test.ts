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
import { createMemoryStores, humanMessage } from './testing.js';

// 枠だけが理由の知らせを配る直前に、名指された担当がもう回復しているかを1節で添える（#4497）。
const AT = '2026-09-05T00:00:00.000Z';
const MANAGER_ID = 'mgr-quota';
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

function boot(managers: ManagerPool, sdkOptions: Parameters<typeof fakeSdk>[1] = {}) {
  const { fn, calls } = fakeSdk(undefined, sdkOptions);
  const clone: CloneHost = createClone({
    reportSettleMs: 2500,
    stores: createMemoryStores(),
    queryFn: fn,
    env: {},
    managers,
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { clone, calls };
}

function quotaStopMessage(id: string, text: string): InboxEvent {
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

function inputContaining(calls: FakeCall[], needle: string): string {
  return (
    calls
      .flatMap((call) => call.inputs)
      .filter((input) => input.includes(needle))
      .at(-1) ?? ''
  );
}

describe('枠で止まった知らせを配る直前に、担当の回復を添える（#4497）', () => {
  it('quotaStop の知らせを受けたとき、担当が live・止まった印なし・世代一致なら「すべて回復している」の1節と担当の id が入力に載る', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(quotaStopMessage('evt-q', '枠に当たって止まった QUOTA-BODY'));
    await waitFor(() => s.calls.some((c) => c.inputs.length > 0), 'ターン');

    const input = inputContaining(s.calls, 'QUOTA-BODY');
    expect(input).toContain(RECOVERED);
    expect(input).toContain(MANAGER_ID);
    expect(input).toContain('鍵の世代 3');

    await s.clone.stop();
  });

  it('プール全体の1通（runner-registry の external・quotaStopManagerIds）でも、名指された担当が回復していれば1節が載る', async () => {
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
      },
    });
    await waitFor(() => s.calls.some((c) => c.inputs.length > 0), 'ターン');

    const input = inputContaining(s.calls, 'POOL-BODY');
    expect(input).toContain(RECOVERED);
    expect(input).toContain(MANAGER_ID);

    await s.clone.stop();
  });

  it('担当が usageStoppedAt を持つ（まだ止まっている）なら、回復の1節は載らない', async () => {
    const s = boot(
      stubPool(() => Promise.resolve([summary({ usageStoppedAt: '2026-09-05T00:00:00.000Z' })])),
    );

    s.clone.post(quotaStopMessage('evt-q', '枠に当たって止まった QUOTA-BODY'));
    await waitFor(() => s.calls.some((c) => c.inputs.length > 0), 'ターン');

    const input = inputContaining(s.calls, 'QUOTA-BODY');
    expect(input).toContain('QUOTA-BODY');
    expect(input).not.toContain(RECOVERED);
    expect(input).not.toContain('回復している');

    await s.clone.stop();
  });

  it('quotaStop の無いふつうの報告には、一覧が回復の条件を満たしていても1節は載らない', async () => {
    const s = boot(stubPool(() => Promise.resolve([summary()])));

    s.clone.post(plainReport('evt-plain', 'ふつうの報告 PLAIN-BODY'));
    await waitFor(() => s.calls.some((c) => c.inputs.length > 0), 'ターン');

    const input = inputContaining(s.calls, 'PLAIN-BODY');
    expect(input).toContain('PLAIN-BODY');
    expect(input).not.toContain(RECOVERED);
    expect(input).not.toContain('回復している');

    await s.clone.stop();
  });

  it('クローン自身が枠で止まっている間に保持された quotaStop の知らせは、解除後に配り直されたターンで1節付きになる', async () => {
    const { fn, calls } = fakeSdk(undefined, {
      resultFor: (turnIndex) =>
        turnIndex < 2 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });
    const clone = createClone({
      reportSettleMs: 2500,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      managers: stubPool(() => Promise.resolve([summary()])),
      redeliveryGate: ALWAYS_REDELIVER,
    });
    const { events } = wireEvents(clone, 'conv-1');

    // 1本目で枠が閉じ、2本目（quotaStop の知らせ）はターンが回らずに保持される。
    clone.post(humanMessage('一件目'));
    await waitForTerminal(events);
    clone.post(quotaStopMessage('evt-held', '保持された知らせ HELD-BODY'));
    // quotaStop の知らせは会話の合図ではないので error の終端は出ない。保持された印は、入力が1件増える（ターンは回らない）ことで見る。
    await waitFor(() => (calls[0]?.inputs.length ?? 0) >= 2, '知らせが保持される');
    expect(calls.flatMap((c) => c.inputs).some((text) => text.includes('HELD-BODY'))).toBe(false);

    // 3本目が解除の合図になり、保持していた知らせが配り直される。
    clone.post(humanMessage('三件目'));
    // 配り直しの束の割れ方（知らせと3本目が1ターンか別ターンか）には依存せず、知らせが入力に届くまで待つ。
    await waitFor(
      () => calls.flatMap((c) => c.inputs).some((text) => text.includes('HELD-BODY')),
      '保持された知らせが配り直される',
    );

    const input = inputContaining(calls, 'HELD-BODY');
    expect(input).toContain(RECOVERED);
    expect(input).toContain(MANAGER_ID);

    await clone.stop();
  });
});
