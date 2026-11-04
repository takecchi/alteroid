import { describe, expect, it } from 'vitest';

import { fakeSdk, waitFor, type FakeCall } from './clone-test-harness.js';
import { createClone } from './clone.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 「戻っていた担当の知らせを畳む」のクローン側の2組（枠の知らせ `#quotaFoldNoticeFor` / `#foldRecoveredQuotaNotice`、
// 枠以外の知らせ `#recoveredNoticeFoldFor` / `#foldRecoveredNotice`）の、入力と出力のいまの違いを固定する。
// 共通: どちらも `backOnCurrentToken`（live・枠停止の印なし・鍵の世代が現役と一致・running か done で知らせより後に成功）で戻りを読み、
// 畳むなら日誌に本文と「ターンを起こさずに畳んだ」の行を残し、読めなければ・戻っていなければ届ける。
// 違い: ① 入口の印（`quotaSessionWindow` か `foldWhenBack`）② 日誌の行の文言 ③ `movedFromGeneration` と `attached` を見るのは後者だけ ④ 両方の印があれば枠の側が先。

const AT = '2026-11-04T00:00:00.000Z';
const AFTER_AT = '2026-11-04T01:00:00.000Z';
const MANAGER_ID = 'mgr-pin';
const FOLD_LINE = 'ターンを起こさずに畳んだ';
const QUOTA_FOLD_LINE = '名指す担当がもう戻っていた枠の知らせなので、ターンを起こさずに畳んだ';
const RECOVERED_FOLD_LINE = '名指す担当がもう戻っていた知らせなので、ターンを起こさずに畳んだ';

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

interface Boot {
  clone: CloneHost;
  calls: FakeCall[];
  stores: Stores;
}

function boot(list: () => Promise<ManagerSummary[]>): Boot {
  const { fn, calls } = fakeSdk();
  const stores = createMemoryStores();
  const clone = createClone({
    reportSettleMs: 0,
    inboxSettleMs: 0,
    stores,
    queryFn: fn,
    env: {},
    managers: stubPool(list),
  });
  return { clone, calls, stores };
}

type Flags = { quota?: true; fold?: { movedFromGeneration?: number; attached?: true } };

function notice(id: string, body: string, flags: Flags): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: AT,
    managerId: MANAGER_ID,
    kind: 'report',
    text: body,
    ...(flags.quota === true
      ? { synthesized: true, quotaStop: true, quotaSessionWindow: true }
      : {}),
    ...(flags.fold === undefined ? {} : { foldWhenBack: flags.fold }),
  };
}

const quotaOnly: Flags = { quota: true };
const recoveredOnly: Flags = { fold: {} };

async function exchangeTexts(stores: Stores): Promise<string[]> {
  const rows = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
  return rows.map((row) => row.text);
}

/** 畳まれたなら日誌の畳んだ行（全文）、届いたなら null を返す。 */
async function outcome(
  list: () => Promise<ManagerSummary[]>,
  flags: Flags,
  body: string,
): Promise<string | null> {
  const s = boot(list);
  s.clone.post(notice('evt-pin', body, flags));
  await waitFor(async () => {
    const delivered = s.calls.some((call) => call.inputs.some((input) => input.includes(body)));
    const folded = (await exchangeTexts(s.stores)).some((text) => text.includes(FOLD_LINE));
    return delivered || folded;
  }, '畳まれるか、届くか');
  const folded = (await exchangeTexts(s.stores)).find((text) => text.includes(FOLD_LINE));
  const delivered = s.calls.some((call) => call.inputs.some((input) => input.includes(body)));
  // 畳んだ回はモデルへ1文字も渡さない
  if (folded !== undefined) expect(delivered).toBe(false);
  await s.clone.stop();
  return folded ?? null;
}

describe('戻っていた担当の知らせの畳み — 枠の知らせ（#4499）と枠以外の知らせ（#5048）の違い', () => {
  it('⭐ 同じ担当の状態（running・live・世代一致）なら、どちらも畳む。日誌の行の文言と、添える節が違う', async () => {
    const list = () => Promise.resolve([summary()]);
    const quota = await outcome(list, quotaOnly, 'QUOTA-BODY');
    const recovered = await outcome(list, recoveredOnly, 'RECOVERED-BODY');

    expect(quota).toContain(QUOTA_FOLD_LINE);
    expect(quota).not.toContain(RECOVERED_FOLD_LINE);
    expect(quota).toContain(
      '5時間枠で止まった知らせだが、配る時点で名指す担当は全員いまの世代の鍵で戻っていた',
    );

    expect(recovered).toContain(RECOVERED_FOLD_LINE);
    expect(recovered).not.toContain(QUOTA_FOLD_LINE);
    expect(recovered).toContain('はいまの世代の鍵で戻っている');
  });

  const states: Array<[string, () => Promise<ManagerSummary[]>, boolean]> = [
    [
      'done で lastReportAt が知らせより後・lastFailure 無し',
      () => Promise.resolve([summary({ status: 'done', lastReportAt: AFTER_AT })]),
      true,
    ],
    [
      'done だが知らせより後の成功が無い',
      () => Promise.resolve([summary({ status: 'done' })]),
      false,
    ],
    ['status: failed', () => Promise.resolve([summary({ status: 'failed' })]), false],
    ['live: false', () => Promise.resolve([summary({ live: false })]), false],
    [
      '枠停止の印（usageStoppedAt）あり',
      () => Promise.resolve([summary({ usageStoppedAt: AT })]),
      false,
    ],
    ['鍵の世代が現役と違う', () => Promise.resolve([summary({ activeTokenGeneration: 4 })]), false],
    ['名簿に担当が居ない', () => Promise.resolve([]), false],
    ['list() が投げる', () => Promise.reject(new Error('名簿が読めない')), false],
  ];

  it.each(states)(
    '⭐ 同じ入力で同じ出力: %s → どちらも同じ側（畳む=%s）',
    async (_name, list, expectFold) => {
      const quota = await outcome(list, quotaOnly, 'SAME-BODY');
      const recovered = await outcome(list, recoveredOnly, 'SAME-BODY');
      expect(quota !== null).toBe(expectFold);
      expect(recovered !== null).toBe(expectFold);
    },
  );

  it('⭐ 違い③: movedFromGeneration が現役の世代と同じなら、枠以外の知らせは届けるが、枠の印があれば枠の側が先に畳む（movedFromGeneration を見ない）', async () => {
    const list = () => Promise.resolve([summary()]);
    const recovered = await outcome(list, { fold: { movedFromGeneration: 3 } }, 'MOVED-BODY');
    expect(recovered).toBeNull();

    const both = await outcome(
      list,
      { quota: true, fold: { movedFromGeneration: 3 } },
      'BOTH-BODY',
    );
    expect(both).not.toBeNull();
    // 違い④: 両方の印があれば枠の側の文言で畳む
    expect(both).toContain(QUOTA_FOLD_LINE);
  });

  it('⭐ 違い③: 鍵の世代を記録しない回（attached）は、枠以外の知らせだけ世代なしで畳める。枠の知らせは世代が無ければ届ける', async () => {
    const noGeneration = () =>
      Promise.resolve([summary({ tokenGeneration: undefined, activeTokenGeneration: undefined })]);

    const attached = await outcome(noGeneration, { fold: { attached: true } }, 'ATTACHED-BODY');
    expect(attached).not.toBeNull();
    expect(attached).toContain(RECOVERED_FOLD_LINE);

    expect(await outcome(noGeneration, quotaOnly, 'NOGEN-BODY')).toBeNull();
    expect(await outcome(noGeneration, recoveredOnly, 'NOGEN-RECOVERED-BODY')).toBeNull();
  });

  it('⭐ 違い①: 印の無い報告はどちらの側でも畳まず届ける', async () => {
    const list = () => Promise.resolve([summary()]);
    expect(await outcome(list, {}, 'PLAIN-BODY')).toBeNull();
  });

  // 違い④の順（枠の側を先に見て、畳めなければ枠以外の側を見る）を、どちらの側でも畳める場面と、枠の側だけ畳めない場面の両方で縛る。
  // 一覧（`list()`）を引く回数も見る: 枠の側で畳めば枠以外の側は見ない（1回）、枠の側で畳めなければ枠以外の側がもう一度引く（2回）
  it('⭐ 違い④: 両方の印があり、どちらの側でも畳めるなら、枠の側が先に畳み、一覧は1回だけ引く', async () => {
    let calls = 0;
    const list = () => {
      calls += 1;
      return Promise.resolve([summary()]);
    };
    const both = await outcome(list, { quota: true, fold: {} }, 'BOTH-FOLDABLE-BODY');
    expect(both).toContain(QUOTA_FOLD_LINE);
    expect(both).not.toContain(RECOVERED_FOLD_LINE);
    expect(calls).toBe(1);
  });

  it('⭐ 違い④: 両方の印があり、枠の側だけ畳めない（世代を記録しない回）なら、枠以外の側が畳み、一覧は2回引く', async () => {
    let calls = 0;
    const list = () => {
      calls += 1;
      return Promise.resolve([
        summary({ tokenGeneration: undefined, activeTokenGeneration: undefined }),
      ]);
    };
    const both = await outcome(list, { quota: true, fold: { attached: true } }, 'BOTH-SECOND-BODY');
    expect(both).toContain(RECOVERED_FOLD_LINE);
    expect(both).not.toContain(QUOTA_FOLD_LINE);
    expect(calls).toBe(2);
  });
});
