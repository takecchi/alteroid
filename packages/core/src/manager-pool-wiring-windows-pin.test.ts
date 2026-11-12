import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPoolOptions, type ManagerRecord } from './manager.js';
import { notifyExcerptLines } from './manager-notices.js';
import { QUOTA_STOP_WINDOW_MS } from './quota-stop-notice.js';
import { RESUME_CONFIRM_TIMEOUT_MS } from './resume-confirmation.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { SYNTHESIZED_NOTICE_WINDOW_MS } from './synthesized-notice.js';
import { createMemoryStores } from './testing.js';
import { resolveTokenSavingExcerpt } from './token-saving-switches.js';
import { resolveWithheldReportFlushMs } from './withheld-reports.js';

// `Pool` の `constructor` のうち、在庫＋見回り（ブロック D: `WithheldReportsStore`・`TurnEndWatch`）と、
// 窓 4 種（ブロック H: `QuotaStopWindows`・`SynthesizedNoticeWindows`・`RestoredWindows`・`ResumeEventWindows`）を作って口（ports）を渡す部分の
// 「配線」を、外から縛る。切り出し（H を協力者を作る関数へ減らす）の前の pin。振る舞いそのものは各クラスの pin が縛っている。
// ここが縛るのは次の 6 つ:
//   - 6 つが何個・どの順で作られるか（前後の協力者との相対順、構築後に作り直されないことを含む）
//   - `withheld.reports` と `withheld.carriedToWindow` を取り出す時点（構築の途中で 1 回ずつ。後から引き直さない）
//   - 渡る ports の欄の全部（欄名・関数か値か・関数の名前と引数の数）
//   - 共有参照（`#records`・`#tokenIdentities`・`#supersedePending`・`withheld.reports`・`withheld.carriedToWindow`・`#quotaWindows`）が
//     `Pool` の持つ同じ物（`toBe`）で、コピーでないこと
//   - 窓の ms 値（既定値と注入値）の素通しと、`trackedGenerationSilent` の素通し
//   - 関数の口を呼ぶと `Pool` の側で引き直した結果になること（時計・`#tokenSavingExcerpt`・`#withheldReportFlushMs`・`#stopped` の読み直し、
//     引数を取りこぼさない、async の皮で包まない、非同期の口の microtask の周回数）
// 期待の文字列・数は、いまの作りの出力から `-u` で生成して目で読んで写したもの（仕様を先に書いたものではない）。
// 実時間では待たない: 時計は注入し、タイマーは fake にする。

const spy = vi.hoisted(() => {
  /** 構築の記録（名前だけ。構築の順と数を見る）。 */
  const order: string[] = [];
  /** 構築と、`withheld` の 2 つの Map を取り出した時点の時系列（取り出しは `read X.key`）。 */
  const timeline: string[] = [];
  const calls: { name: string; ports: Record<string, unknown>; instance: object }[] = [];
  function wrap<C>(name: string, Base: C, watch: readonly string[] = []): C {
    const Original = Base as unknown as new (ports: Record<string, unknown>) => object;
    class Recorder extends Original {
      constructor(ports: Record<string, unknown>) {
        super(ports);
        for (const key of watch) {
          const target = this as unknown as Record<string, unknown>;
          const held = target[key];
          Object.defineProperty(this, key, {
            configurable: true,
            get() {
              timeline.push(`read ${name}.${key}`);
              return held;
            },
          });
        }
        order.push(name);
        timeline.push(`new ${name}`);
        calls.push({ name, ports, instance: this });
      }
    }
    return Recorder as unknown as C;
  }
  return {
    order,
    timeline,
    calls,
    wrap,
    reset(): void {
      order.length = 0;
      timeline.length = 0;
      calls.length = 0;
    },
  };
});

vi.mock('./session-loaders.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./session-loaders.js')>();
  return { ...mod, SessionLoaders: spy.wrap('SessionLoaders', mod.SessionLoaders) };
});
vi.mock('./withheld-reports-store.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./withheld-reports-store.js')>();
  return {
    ...mod,
    WithheldReportsStore: spy.wrap('WithheldReportsStore', mod.WithheldReportsStore, [
      'reports',
      'carriedToWindow',
    ]),
  };
});
vi.mock('./turn-end-watch.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./turn-end-watch.js')>();
  return { ...mod, TurnEndWatch: spy.wrap('TurnEndWatch', mod.TurnEndWatch) };
});
vi.mock('./auto-fold.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./auto-fold.js')>();
  return { ...mod, AutoFold: spy.wrap('AutoFold', mod.AutoFold) };
});
vi.mock('./push-ledger.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./push-ledger.js')>();
  return { ...mod, PushLedger: spy.wrap('PushLedger', mod.PushLedger) };
});
vi.mock('./quota-stop-windows.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./quota-stop-windows.js')>();
  return { ...mod, QuotaStopWindows: spy.wrap('QuotaStopWindows', mod.QuotaStopWindows) };
});
vi.mock('./synthesized-notice-windows.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./synthesized-notice-windows.js')>();
  return {
    ...mod,
    SynthesizedNoticeWindows: spy.wrap('SynthesizedNoticeWindows', mod.SynthesizedNoticeWindows),
  };
});
vi.mock('./restored-windows.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./restored-windows.js')>();
  return { ...mod, RestoredWindows: spy.wrap('RestoredWindows', mod.RestoredWindows) };
});
vi.mock('./resume-event-windows.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./resume-event-windows.js')>();
  return { ...mod, ResumeEventWindows: spy.wrap('ResumeEventWindows', mod.ResumeEventWindows) };
});
vi.mock('./usage-wake.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./usage-wake.js')>();
  return { ...mod, UsageWake: spy.wrap('UsageWake', mod.UsageWake) };
});
vi.mock('./usage-receiver.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./usage-receiver.js')>();
  return { ...mod, UsageReceiver: spy.wrap('UsageReceiver', mod.UsageReceiver) };
});

const JOB_ID = 'mgr-wiring-windows-pin';
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

/** 対象の 6 つ（`manager.ts` の構築順）。 */
const TARGETS = [
  'WithheldReportsStore',
  'TurnEndWatch',
  'QuotaStopWindows',
  'SynthesizedNoticeWindows',
  'RestoredWindows',
  'ResumeEventWindows',
] as const;

type Fn = (...args: unknown[]) => unknown;

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

/** 控えた構築のうち、名前が `name` の最後の 1 件の ports。 */
function portsOf(name: string): Record<string, unknown> {
  const hit = spy.calls.filter((call) => call.name === name).at(-1);
  if (hit === undefined) throw new Error(`${name} は作られていない`);
  return hit.ports;
}

function instanceOf(name: string): object {
  const hit = spy.calls.filter((call) => call.name === name).at(-1);
  if (hit === undefined) throw new Error(`${name} は作られていない`);
  return hit.instance;
}

function fnOf(name: string, key: string): Fn {
  const value = portsOf(name)[key];
  if (typeof value !== 'function') throw new Error(`${name}.${key} は関数でない`);
  return value as Fn;
}

type PoolExtra = Pick<
  ManagerPoolOptions,
  | 'withheldReportFlushMs'
  | 'tokenSavingExcerpt'
  | 'synthesizedNoticeWindowMs'
  | 'quotaStopWindowMs'
  | 'resumeConfirmTimeoutMs'
>;

/** Pool を 1 つ作り、委譲 1 件を台帳から像へ戻して返す。時計は `clock.now` を読む。 */
async function open(extra: PoolExtra = {}) {
  spy.reset();
  const clock = { now: T0 };
  const stores = createMemoryStores();
  await stores.jobs.putJob({
    id: JOB_ID,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
  });
  const inbox: Record<string, unknown>[] = [];
  let emit = null as ((event: never) => void) | null;
  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async connect(onEvent) {
      emit = onEvent as unknown as (event: never) => void;
    },
    async list() {
      return [];
    },
    async setProfile() {
      return { ok: true as const };
    },
  });
  const pool = createManagerPool({
    stores,
    now: () => clock.now,
    post: (event) => {
      inbox.push(event as unknown as Record<string, unknown>);
    },
    runners: createRunnerRegistry([runner]),
    ...extra,
  });
  // 構築の記録は restore の前に取り出す（restore が協力者を作り直さないことも確かめるため、数は後でもう一度見る）
  const constructed = [...spy.order];
  const constructedTimeline = [...spy.timeline];
  await pool.restore();
  await settle();
  const records = portsOf('WithheldReportsStore').records as Map<string, ManagerRecord>;
  const record = records.get(JOB_ID);
  if (record === undefined) throw new Error('像が作られていない');
  return {
    pool,
    stores,
    clock,
    inbox,
    runner,
    records,
    record,
    constructed,
    constructedTimeline,
    emit: () => emit,
  };
}

/** `promise` が解けるまでの microtask の周回数（上限 200 で -1）。 */
async function hopsOf(promise: Promise<unknown>): Promise<number> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i <= 200; i += 1) {
    if (done) return i;
    await Promise.resolve();
  }
  return -1;
}

function kindOf(value: unknown): string {
  if (typeof value === 'function') return 'function';
  if (value instanceof Map) return 'Map';
  if (value instanceof Set) return 'Set';
  if (value === null) return 'null';
  if (typeof value === 'object') return `object:${(value as object).constructor.name}`;
  return typeof value;
}

describe('Pool の constructor の配線: 在庫＋見回り（D）と窓 4 種（H）', () => {
  it('作られる協力者と順（前後の協力者との相対順を含む）と数', async () => {
    const { constructed } = await open();
    expect(constructed).toMatchInlineSnapshot(`
      [
        "SessionLoaders",
        "WithheldReportsStore",
        "TurnEndWatch",
        "AutoFold",
        "PushLedger",
        "QuotaStopWindows",
        "SynthesizedNoticeWindows",
        "RestoredWindows",
        "ResumeEventWindows",
        "UsageWake",
        "UsageReceiver",
      ]
    `);
    expect(spy.order).toEqual(constructed);
    // 6 つは D → H の順に、1 回ずつ（間に他の協力者が挟まってよい）
    const positions = TARGETS.map((name) => constructed.indexOf(name));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(TARGETS.map((name) => constructed.filter((entry) => entry === name).length)).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
    // D 内は在庫 → 見回り、H 内は枠 → 合成 → 取り戻し → 再開の窓
    expect(constructed.indexOf('TurnEndWatch') - constructed.indexOf('WithheldReportsStore')).toBe(
      1,
    );
    expect(constructed.indexOf('QuotaStopWindows')).toBeLessThan(
      constructed.indexOf('SynthesizedNoticeWindows'),
    );
    expect(constructed.indexOf('QuotaStopWindows')).toBeLessThan(
      constructed.indexOf('RestoredWindows'),
    );
  });

  it('withheld の 2 つの Map を取り出すのは構築の途中の 1 回ずつ（後から引き直さない）', async () => {
    const { constructedTimeline } = await open();
    expect(constructedTimeline).toMatchInlineSnapshot(`
      [
        "new SessionLoaders",
        "new WithheldReportsStore",
        "read WithheldReportsStore.reports",
        "new TurnEndWatch",
        "new AutoFold",
        "new PushLedger",
        "read WithheldReportsStore.carriedToWindow",
        "new QuotaStopWindows",
        "new SynthesizedNoticeWindows",
        "new RestoredWindows",
        "new ResumeEventWindows",
        "new UsageWake",
        "new UsageReceiver",
      ]
    `);
    const reads = constructedTimeline.filter((entry) => entry.startsWith('read '));
    expect(reads).toEqual([
      'read WithheldReportsStore.reports',
      'read WithheldReportsStore.carriedToWindow',
    ]);
    // 構築の後（restore を経ても）、取り出した Map は同じ物のまま
    const withheld = instanceOf('WithheldReportsStore') as {
      reports: unknown;
      carriedToWindow: unknown;
    };
    expect(portsOf('TurnEndWatch').withheldReports).toBe(withheld.reports);
    expect(portsOf('QuotaStopWindows').withheldCarriedToWindow).toBe(withheld.carriedToWindow);
  });

  it('構築のあとの restore() は協力者を作り直さない', async () => {
    const { constructed } = await open();
    expect(spy.order).toEqual(constructed);
  });

  it('渡る ports の欄と、欄の種類', async () => {
    await open();
    const shape = Object.fromEntries(
      TARGETS.map((name) => [
        name,
        Object.fromEntries(
          Object.entries(portsOf(name)).map(([key, value]) => [key, kindOf(value)]),
        ),
      ]),
    );
    expect(shape).toMatchInlineSnapshot(`
      {
        "QuotaStopWindows": {
          "journalExchange": "function",
          "listJobsOrNote": "function",
          "now": "function",
          "nowIso": "function",
          "post": "function",
          "records": "Map",
          "windowMs": "number",
          "withheldCarriedToWindow": "Map",
        },
        "RestoredWindows": {
          "confirmTimeoutMs": "number",
          "journalExchange": "function",
          "listJobsOrNote": "function",
          "notifyExcerptLines": "function",
          "now": "function",
          "nowIso": "function",
          "post": "function",
          "postReport": "function",
          "queueNotice": "function",
          "records": "Map",
          "stopped": "function",
          "trackFlush": "function",
          "windowMs": "number",
        },
        "ResumeEventWindows": {
          "droppedReportFiles": "function",
          "journal": "function",
          "judgeSessionGeneration": "function",
          "onEvent": "function",
          "records": "Map",
          "trackedGenerationSilent": "function",
        },
        "SynthesizedNoticeWindows": {
          "journalExchange": "function",
          "now": "function",
          "nowIso": "function",
          "post": "function",
          "quotaWindows": "object:Recorder",
          "records": "Map",
          "statusAtDelivery": "function",
          "supersedePending": "Map",
          "takeWithheldForDelivery": "function",
          "tokenIdentities": "Map",
          "windowMs": "number",
        },
        "TurnEndWatch": {
          "emitReport": "function",
          "journal": "function",
          "now": "function",
          "records": "Map",
          "runnerHasCapability": "function",
          "runnerOf": "function",
          "stores": "object:Object",
          "withheldReports": "Map",
        },
        "WithheldReportsStore": {
          "emitFlush": "function",
          "now": "function",
          "nowIso": "function",
          "persist": "function",
          "records": "Map",
          "tokenSavingExcerpt": "function",
          "withheldReportFlushMs": "function",
        },
      }
    `);
  });

  it('口の関数の名前と引数の数（束ねた無名の関数・bind・素通しの区別）', async () => {
    await open();
    const names = Object.fromEntries(
      TARGETS.map((name) => [
        name,
        Object.fromEntries(
          Object.entries(portsOf(name))
            .filter(([, value]) => typeof value === 'function')
            .map(([key, value]) => [key, `${(value as Fn).name}/${String((value as Fn).length)}`]),
        ),
      ]),
    );
    expect(names).toMatchInlineSnapshot(`
      {
        "QuotaStopWindows": {
          "journalExchange": "bound #journalExchange/2",
          "listJobsOrNote": "listJobsOrNote/1",
          "now": "now/0",
          "nowIso": "nowIso/0",
          "post": "post/1",
        },
        "RestoredWindows": {
          "journalExchange": "bound #journalExchange/2",
          "listJobsOrNote": "listJobsOrNote/1",
          "notifyExcerptLines": "notifyExcerptLines/1",
          "now": "now/0",
          "nowIso": "nowIso/0",
          "post": "post/1",
          "postReport": "postReport/3",
          "queueNotice": "queueNotice/3",
          "stopped": "stopped/0",
          "trackFlush": "trackFlush/1",
        },
        "ResumeEventWindows": {
          "droppedReportFiles": "droppedReportFiles/2",
          "journal": "journal/1",
          "judgeSessionGeneration": "judgeSessionGeneration/2",
          "onEvent": "onEvent/2",
          "trackedGenerationSilent": "trackedGenerationSilent/1",
        },
        "SynthesizedNoticeWindows": {
          "journalExchange": "bound #journalExchange/2",
          "now": "now/0",
          "nowIso": "nowIso/0",
          "post": "post/1",
          "statusAtDelivery": "statusAtDelivery/1",
          "takeWithheldForDelivery": "takeWithheldForDelivery/3",
        },
        "TurnEndWatch": {
          "emitReport": "emitReport/2",
          "journal": "journal/1",
          "now": "now/0",
          "runnerHasCapability": "runnerHasCapability/2",
          "runnerOf": "runnerOf/1",
        },
        "WithheldReportsStore": {
          "emitFlush": "emitFlush/2",
          "now": "now/0",
          "nowIso": "nowIso/0",
          "persist": "persist/1",
          "tokenSavingExcerpt": "tokenSavingExcerpt/0",
          "withheldReportFlushMs": "withheldReportFlushMs/0",
        },
      }
    `);
  });

  it('共有参照は Pool の持つ同じ物（コピーでない）', async () => {
    const { stores, records, record } = await open();
    const wake = portsOf('UsageWake');
    const receiver = portsOf('UsageReceiver');
    const withheld = instanceOf('WithheldReportsStore') as {
      reports: Map<string, unknown>;
      carriedToWindow: Map<string, unknown>;
    };
    // 像（`#records`）: 6 つが同じ Map を持ち、restore が書いた像がそこに在る
    for (const name of TARGETS) expect(portsOf(name).records).toBe(records);
    expect(wake.records).toBe(records);
    expect(records.get(JOB_ID)).toBe(record);
    // トークン・後継の予約: 合成した知らせの窓が持つのは、`UsageWake` / `UsageReceiver` へも渡る同じ Map
    const synthesized = portsOf('SynthesizedNoticeWindows');
    expect(synthesized.tokenIdentities).toBe(wake.tokenIdentities);
    expect(synthesized.tokenIdentities).toBe(receiver.tokenIdentities);
    expect(synthesized.supersedePending).toBe(wake.supersedePending);
    expect(synthesized.tokenIdentities).toBeInstanceOf(Map);
    expect(synthesized.supersedePending).toBeInstanceOf(Map);
    expect(synthesized.tokenIdentities).not.toBe(synthesized.supersedePending);
    expect(synthesized.tokenIdentities).not.toBe(records);
    // 在庫の 2 つの Map は在庫の実体の物。別の欄とも取り違えない
    expect(portsOf('TurnEndWatch').withheldReports).toBe(withheld.reports);
    expect(portsOf('QuotaStopWindows').withheldCarriedToWindow).toBe(withheld.carriedToWindow);
    expect(withheld.reports).not.toBe(withheld.carriedToWindow);
    expect(portsOf('TurnEndWatch').withheldReports).not.toBe(records);
    // 枠の窓は合成した知らせの窓へ実体のまま渡る
    expect(synthesized.quotaWindows).toBe(instanceOf('QuotaStopWindows'));
    // `stores` は引数で渡した物のまま
    expect(portsOf('TurnEndWatch').stores).toBe(stores);
    // 共有の確かめ: 片方へ書くともう片方から見える
    (portsOf('ResumeEventWindows').records as Map<string, unknown>).set('probe', 1);
    expect(records.has('probe')).toBe(true);
    expect((portsOf('RestoredWindows').records as Map<string, unknown>).get('probe')).toBe(1);
    records.delete('probe');
    (synthesized.tokenIdentities as Map<string, unknown>).set('probe', { tokenId: 't' });
    expect((wake.tokenIdentities as Map<string, unknown>).get('probe')).toEqual({ tokenId: 't' });
    (synthesized.tokenIdentities as Map<string, unknown>).delete('probe');
    (synthesized.supersedePending as Map<string, symbol>).set('probe', Symbol('p'));
    expect((wake.supersedePending as Map<string, symbol>).has('probe')).toBe(true);
    (synthesized.supersedePending as Map<string, symbol>).delete('probe');
    withheld.carriedToWindow.set('probe', { count: 1 });
    expect(
      (portsOf('QuotaStopWindows').withheldCarriedToWindow as Map<string, unknown>).has('probe'),
    ).toBe(true);
    withheld.carriedToWindow.delete('probe');
    withheld.reports.set('probe', { count: 1 });
    expect((portsOf('TurnEndWatch').withheldReports as Map<string, unknown>).has('probe')).toBe(
      true,
    );
    withheld.reports.delete('probe');
  });

  it('窓の ms 値と値の口: 既定値の素通し', async () => {
    await open();
    const values = {
      quotaWindowMs: portsOf('QuotaStopWindows').windowMs,
      synthesizedWindowMs: portsOf('SynthesizedNoticeWindows').windowMs,
      restoredWindowMs: portsOf('RestoredWindows').windowMs,
      restoredConfirmTimeoutMs: portsOf('RestoredWindows').confirmTimeoutMs,
      tokenSavingExcerpt: fnOf('WithheldReportsStore', 'tokenSavingExcerpt')(),
      withheldReportFlushMs: fnOf('WithheldReportsStore', 'withheldReportFlushMs')(),
    };
    expect(values).toMatchInlineSnapshot(`
      {
        "quotaWindowMs": 30000,
        "restoredConfirmTimeoutMs": 600000,
        "restoredWindowMs": 30000,
        "synthesizedWindowMs": 3000,
        "tokenSavingExcerpt": true,
        "withheldReportFlushMs": 1800000,
      }
    `);
    expect(values.quotaWindowMs).toBe(QUOTA_STOP_WINDOW_MS);
    expect(values.restoredWindowMs).toBe(QUOTA_STOP_WINDOW_MS);
    expect(values.synthesizedWindowMs).toBe(SYNTHESIZED_NOTICE_WINDOW_MS);
    expect(values.restoredConfirmTimeoutMs).toBe(RESUME_CONFIRM_TIMEOUT_MS);
    expect(values.tokenSavingExcerpt).toBe(resolveTokenSavingExcerpt());
    expect(values.withheldReportFlushMs).toBe(resolveWithheldReportFlushMs());
  });

  it('窓の ms 値と値の口: 注入値の素通し（欄ごとに別の値で取り違えを見分ける）', async () => {
    await open({
      quotaStopWindowMs: 11_111,
      synthesizedNoticeWindowMs: 22_222,
      resumeConfirmTimeoutMs: 33_333,
      withheldReportFlushMs: 44_444,
      tokenSavingExcerpt: false,
    });
    expect({
      quotaWindowMs: portsOf('QuotaStopWindows').windowMs,
      synthesizedWindowMs: portsOf('SynthesizedNoticeWindows').windowMs,
      restoredWindowMs: portsOf('RestoredWindows').windowMs,
      restoredConfirmTimeoutMs: portsOf('RestoredWindows').confirmTimeoutMs,
      tokenSavingExcerpt: fnOf('WithheldReportsStore', 'tokenSavingExcerpt')(),
      withheldReportFlushMs: fnOf('WithheldReportsStore', 'withheldReportFlushMs')(),
    }).toMatchInlineSnapshot(`
      {
        "quotaWindowMs": 11111,
        "restoredConfirmTimeoutMs": 33333,
        "restoredWindowMs": 11111,
        "synthesizedWindowMs": 22222,
        "tokenSavingExcerpt": false,
        "withheldReportFlushMs": 44444,
      }
    `);
  });

  it('読む口（tokenSavingExcerpt / withheldReportFlushMs）は構築の後に決まる値を返す', async () => {
    // 在庫を作る時点では `Pool` の欄がまだ空（欄の代入は在庫の構築より後）。口は呼ぶ時に読むので、注入値が返る
    const on = await open({ tokenSavingExcerpt: true, withheldReportFlushMs: 1_000 });
    const onValues = [
      fnOf('WithheldReportsStore', 'tokenSavingExcerpt')(),
      fnOf('WithheldReportsStore', 'withheldReportFlushMs')(),
    ];
    expect(on.pool).toBeDefined();
    const off = await open({ tokenSavingExcerpt: false, withheldReportFlushMs: 2_000 });
    const offValues = [
      fnOf('WithheldReportsStore', 'tokenSavingExcerpt')(),
      fnOf('WithheldReportsStore', 'withheldReportFlushMs')(),
    ];
    expect(off.pool).toBeDefined();
    expect({ onValues, offValues }).toMatchInlineSnapshot(`
      {
        "offValues": [
          false,
          2000,
        ],
        "onValues": [
          true,
          1000,
        ],
      }
    `);
  });

  it('時計の口は呼ぶたびに注入した時計を引き直す（構築時の値のコピーでない）', async () => {
    const { clock } = await open();
    const seen: Record<string, unknown[]> = {};
    for (const name of TARGETS) {
      const ports = portsOf(name);
      for (const key of ['now', 'nowIso'] as const) {
        const fn = ports[key];
        if (typeof fn !== 'function') continue;
        clock.now = T0;
        const first = (fn as Fn)();
        clock.now = T0 + 12_345;
        seen[`${name}.${key}`] = [first, (fn as Fn)()];
      }
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "QuotaStopWindows.now": [
          1793491200000,
          1793491212345,
        ],
        "QuotaStopWindows.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
        "RestoredWindows.now": [
          1793491200000,
          1793491212345,
        ],
        "RestoredWindows.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
        "SynthesizedNoticeWindows.now": [
          1793491200000,
          1793491212345,
        ],
        "SynthesizedNoticeWindows.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
        "TurnEndWatch.now": [
          1793491200000,
          1793491212345,
        ],
        "WithheldReportsStore.now": [
          1793491200000,
          1793491212345,
        ],
        "WithheldReportsStore.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
      }
    `);
  });

  it('journalExchange の口は exchange（with=manager）を日誌へ書き、Promise を返す', async () => {
    const { stores } = await open();
    const wrote: Record<string, unknown> = {};
    for (const name of TARGETS) {
      const fn = portsOf(name).journalExchange;
      if (typeof fn !== 'function') continue;
      const text = `${name} の呼び出し`;
      const returned = (fn as Fn)('outbound', text);
      expect(returned).toBeInstanceOf(Promise);
      await returned;
      const hits = (await stores.journal.list({ types: ['exchange'] })).filter(
        (entry) => (entry as unknown as Record<string, unknown>).text === text,
      ) as unknown as Record<string, unknown>[];
      wrote[name] = {
        added: hits.length,
        with: hits[0]?.with,
        role: hits[0]?.role,
        text: hits[0]?.text,
      };
    }
    expect(wrote).toMatchInlineSnapshot(`
      {
        "QuotaStopWindows": {
          "added": 1,
          "role": "outbound",
          "text": "QuotaStopWindows の呼び出し",
          "with": "manager",
        },
        "RestoredWindows": {
          "added": 1,
          "role": "outbound",
          "text": "RestoredWindows の呼び出し",
          "with": "manager",
        },
        "SynthesizedNoticeWindows": {
          "added": 1,
          "role": "outbound",
          "text": "SynthesizedNoticeWindows の呼び出し",
          "with": "manager",
        },
      }
    `);
  });

  it('journal の口（見回り・再開の窓）は渡した記載をそのまま日誌へ書く', async () => {
    const { stores } = await open();
    for (const name of ['TurnEndWatch', 'ResumeEventWindows']) {
      await fnOf(
        name,
        'journal',
      )({
        type: 'decision',
        decision: `${name} の配線の確認`,
        grounds: '口から直に呼んだ',
      });
    }
    const hits = (await stores.journal.list({ types: ['decision'] })).filter((entry) =>
      String((entry as unknown as Record<string, unknown>).decision).includes('の配線の確認'),
    ) as unknown as Record<string, unknown>[];
    expect(hits.map((entry) => ({ decision: entry.decision, grounds: entry.grounds })))
      .toMatchInlineSnapshot(`
        [
          {
            "decision": "ResumeEventWindows の配線の確認",
            "grounds": "口から直に呼んだ",
          },
          {
            "decision": "TurnEndWatch の配線の確認",
            "grounds": "口から直に呼んだ",
          },
        ]
      `);
  });

  it('persist の口（在庫）は像の updatedAt を時計で書き直して台帳へ書く', async () => {
    const { stores, clock, record } = await open();
    clock.now = T0 + 90_000;
    const returned = fnOf('WithheldReportsStore', 'persist')(record);
    expect(returned).toBeInstanceOf(Promise);
    await returned;
    const row = await stores.jobs.getJob(JOB_ID);
    expect({ updatedAt: record.job.updatedAt, stored: row?.updatedAt }).toMatchInlineSnapshot(`
      {
        "stored": "2026-11-01T00:01:30.000Z",
        "updatedAt": "2026-11-01T00:01:30.000Z",
      }
    `);
  });

  it('emit 系の口は合流窓の emit へ、渡した引数をそのまま渡す（在庫の emitFlush・見回りの emitReport）', async () => {
    await open();
    const synthesized = instanceOf('SynthesizedNoticeWindows') as {
      emit: (...args: unknown[]) => void;
    };
    const calls: unknown[][] = [];
    const spyEmit = vi.spyOn(synthesized, 'emit').mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    const returns = {
      emitFlush: fnOf('WithheldReportsStore', 'emitFlush')(JOB_ID, 'まとめ配りの本文', 'extra'),
      emitReport: fnOf('TurnEndWatch', 'emitReport')(JOB_ID, '見回りの本文', 'extra'),
    };
    spyEmit.mockRestore();
    expect(returns).toMatchInlineSnapshot(`
      {
        "emitFlush": undefined,
        "emitReport": undefined,
      }
    `);
    expect(calls).toMatchInlineSnapshot(`
      [
        [
          "mgr-wiring-windows-pin",
          "report",
          "まとめ配りの本文",
          undefined,
          undefined,
          "flush",
        ],
        [
          "mgr-wiring-windows-pin",
          "report",
          "見回りの本文",
        ],
      ]
    `);
  });

  it('見回りの口: runnerOf は台帳の runnerId の器を返し、runnerHasCapability は hello の名乗りを読み直す', async () => {
    const { pool, runner, record, emit } = await open();
    const runnerOf = fnOf('TurnEndWatch', 'runnerOf');
    const hasCapability = fnOf('TurnEndWatch', 'runnerHasCapability');
    const returned = runnerOf(record);
    expect(returned).toBeInstanceOf(Promise);
    const viaPort = await returned;
    expect(viaPort).toBe(runner);
    const before = hasCapability('runner-primary', 'probe-cap');
    emit()?.({
      type: 'hello',
      runnerId: 'runner-primary',
      capabilities: ['probe-cap'],
    } as never);
    await settle();
    const after = hasCapability('runner-primary', 'probe-cap');
    expect({
      before,
      after,
      other: hasCapability('runner-primary', 'other-cap'),
      otherRunner: hasCapability('runner-other', 'probe-cap'),
      viaPool: pool.runnerHasCapability?.('runner-primary', 'probe-cap'),
    }).toMatchInlineSnapshot(`
      {
        "after": true,
        "before": false,
        "other": false,
        "otherRunner": false,
        "viaPool": true,
      }
    `);
  });

  it('合成した知らせの窓の口: 在庫から窓へ運ぶ文（takeWithheldForDelivery）は在庫の takeForDelivery へ引数をそのまま渡す', async () => {
    await open();
    const withheld = instanceOf('WithheldReportsStore') as {
      takeForDelivery: (...args: unknown[]) => unknown;
    };
    const calls: unknown[][] = [];
    const sentinel = { text: '運んだ後の本文', appended: true };
    const spyTake = vi
      .spyOn(withheld, 'takeForDelivery')
      .mockImplementation((...args: unknown[]) => {
        calls.push(args);
        return sentinel;
      });
    const returned = fnOf('SynthesizedNoticeWindows', 'takeWithheldForDelivery')(
      JOB_ID,
      '本文',
      'flush',
    );
    spyTake.mockRestore();
    expect(returned).toBe(sentinel);
    expect(calls).toMatchInlineSnapshot(`
      [
        [
          "mgr-wiring-windows-pin",
          "本文",
          "flush",
        ],
      ]
    `);
    // 実体を通すと、在庫が無い担当は本文のまま
    expect(fnOf('SynthesizedNoticeWindows', 'takeWithheldForDelivery')('nobody', '本文', 'full'))
      .toMatchInlineSnapshot(`
        {
          "appended": false,
          "text": "本文",
        }
      `);
  });

  it('statusAtDelivery の口は像の状態を引き、像が無ければ空', async () => {
    const { record } = await open();
    const statusAtDelivery = fnOf('SynthesizedNoticeWindows', 'statusAtDelivery');
    const running = statusAtDelivery(JOB_ID);
    record.job.status = 'waiting_human';
    const waiting = statusAtDelivery(JOB_ID);
    expect({ running, waiting, missing: statusAtDelivery('nobody') }).toMatchInlineSnapshot(`
      {
        "missing": {},
        "running": {
          "statusAtDelivery": "running",
        },
        "waiting": {
          "statusAtDelivery": "waiting_human",
        },
      }
    `);
  });

  it('post の口は渡した出来事を同じ参照のまま受信箱へ渡す（枠・合成・取り戻し）', async () => {
    const { inbox } = await open();
    const out: Record<string, unknown> = {};
    for (const name of ['QuotaStopWindows', 'SynthesizedNoticeWindows', 'RestoredWindows']) {
      const event = { type: 'external', id: `evt-${name}` };
      const before = inbox.length;
      const returned = fnOf(name, 'post')(event);
      out[name] = {
        returned,
        added: inbox.length - before,
        same: inbox.at(-1) === (event as unknown),
      };
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "QuotaStopWindows": {
          "added": 1,
          "returned": undefined,
          "same": true,
        },
        "RestoredWindows": {
          "added": 1,
          "returned": undefined,
          "same": true,
        },
        "SynthesizedNoticeWindows": {
          "added": 1,
          "returned": undefined,
          "same": true,
        },
      }
    `);
  });

  it('listJobsOrNote の口は台帳の一覧を返し、読めなければ null と日誌（渡した理由つき）', async () => {
    const { stores } = await open();
    const out: Record<string, unknown> = {};
    for (const name of ['QuotaStopWindows', 'RestoredWindows']) {
      const fn = fnOf(name, 'listJobsOrNote');
      const returned = fn(`${name} の見送り`);
      expect(returned).toBeInstanceOf(Promise);
      const jobs = (await returned) as { id: string }[];
      const failing = vi
        .spyOn(stores.jobs, 'listJobs')
        .mockRejectedValueOnce(new Error('読めない'));
      const nothing = await fn(`${name} の見送り`);
      failing.mockRestore();
      const decisions = (await stores.journal.list({ types: ['decision'] })).filter((entry) =>
        String((entry as unknown as Record<string, unknown>).decision).includes(`${name} の見送り`),
      ) as unknown as Record<string, unknown>[];
      out[name] = {
        ids: jobs.map((job) => job.id),
        nothing,
        decisions: decisions.map((entry) => entry.decision),
      };
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "QuotaStopWindows": {
          "decisions": [
            "台帳の委譲の一覧を読めなかったので、QuotaStopWindows の見送り",
          ],
          "ids": [
            "mgr-wiring-windows-pin",
          ],
          "nothing": null,
        },
        "RestoredWindows": {
          "decisions": [
            "台帳の委譲の一覧を読めなかったので、RestoredWindows の見送り",
          ],
          "ids": [
            "mgr-wiring-windows-pin",
          ],
          "nothing": null,
        },
      }
    `);
  });

  it('postReport の口は像の状態を添えた manager_message(report) を 1 通出し、extra をそのまま載せる', async () => {
    const { inbox, clock } = await open();
    clock.now = T0 + 5_000;
    const before = inbox.length;
    const returned = fnOf('RestoredWindows', 'postReport')(JOB_ID, '取り戻した知らせ', {
      markup: 'markdown',
      foldWhenBack: { attached: true },
    });
    const plain = fnOf('RestoredWindows', 'postReport')(JOB_ID, '素の知らせ');
    const posted = inbox.slice(before).map((event) => ({ ...event, id: typeof event.id }));
    expect({ returned, plain, posted }).toMatchInlineSnapshot(`
      {
        "plain": undefined,
        "posted": [
          {
            "at": "2026-11-01T00:00:05.000Z",
            "foldWhenBack": {
              "attached": true,
            },
            "id": "string",
            "kind": "report",
            "managerId": "mgr-wiring-windows-pin",
            "markup": "markdown",
            "statusAtDelivery": "running",
            "text": "取り戻した知らせ",
            "type": "manager_message",
          },
          {
            "at": "2026-11-01T00:00:05.000Z",
            "id": "string",
            "kind": "report",
            "managerId": "mgr-wiring-windows-pin",
            "statusAtDelivery": "running",
            "text": "素の知らせ",
            "type": "manager_message",
          },
        ],
        "returned": undefined,
      }
    `);
  });

  it('queueNotice の口は合流窓の queue へ、渡した 3 引数をそのまま渡す', async () => {
    await open();
    const synthesized = instanceOf('SynthesizedNoticeWindows') as {
      queue: (...args: unknown[]) => void;
    };
    const calls: unknown[][] = [];
    const spyQueue = vi.spyOn(synthesized, 'queue').mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    const returned = fnOf('RestoredWindows', 'queueNotice')(JOB_ID, 'resume_unconfirmed', '本文');
    spyQueue.mockRestore();
    expect({ returned, calls }).toMatchInlineSnapshot(`
      {
        "calls": [
          [
            "mgr-wiring-windows-pin",
            "resume_unconfirmed",
            "本文",
          ],
        ],
        "returned": undefined,
      }
    `);
  });

  it('trackFlush の口は枠の窓の trackFlush へ渡し、同じ Promise を返す', async () => {
    await open();
    const quota = instanceOf('QuotaStopWindows') as {
      trackFlush: (flush: Promise<void>) => Promise<void>;
    };
    const seen: unknown[] = [];
    const spyTrack = vi.spyOn(quota, 'trackFlush').mockImplementation((flush) => {
      seen.push(flush);
      return flush;
    });
    const flush = Promise.resolve();
    const returned = fnOf('RestoredWindows', 'trackFlush')(flush);
    spyTrack.mockRestore();
    expect({
      calledWithSame: seen[0] === flush,
      count: seen.length,
      returnedSame: returned === flush,
    }).toMatchInlineSnapshot(`
        {
          "calledWithSame": true,
          "count": 1,
          "returnedSame": true,
        }
      `);
  });

  it('notifyExcerptLines は関数そのものを素通しする', async () => {
    await open();
    expect(portsOf('RestoredWindows').notifyExcerptLines).toBe(notifyExcerptLines);
  });

  it('stopped の口は Pool の止まった印を呼ぶ時に読む（stop() の後に変わる）', async () => {
    const { pool } = await open();
    const stopped = fnOf('RestoredWindows', 'stopped');
    const before = stopped();
    await pool.stop();
    expect({ before, after: stopped() }).toMatchInlineSnapshot(`
      {
        "after": true,
        "before": false,
      }
    `);
  });

  it('再開の窓の口: judgeSessionGeneration は像の世代と出来事の世代を比べる', async () => {
    const { record } = await open();
    const judge = fnOf('ResumeEventWindows', 'judgeSessionGeneration');
    const report = (generation: string) => ({
      type: 'report',
      managerId: JOB_ID,
      text: 'x',
      sessionGeneration: generation,
    });
    const untracked = judge(record, report('g1'));
    record.sessionGeneration = 'g1';
    const out = {
      untracked,
      current: judge(record, report('g1')),
      stale: judge(record, report('g2')),
      notSessionScoped: judge(record, { type: 'usage', managerId: JOB_ID }),
    };
    expect(out).toMatchInlineSnapshot(`
      {
        "current": "current",
        "notSessionScoped": "unknown",
        "stale": "stale",
        "untracked": "unknown",
      }
    `);
  });

  it('再開の窓の口: trackedGenerationSilent は manager.ts の関数そのもの（束ねない）', async () => {
    const { record } = await open();
    const silent = fnOf('ResumeEventWindows', 'trackedGenerationSilent');
    const untracked = silent(record);
    record.sessionGeneration = 'g1';
    const trackedNoEvent = silent(record);
    record.observedSessionGenerations = new Set(['g1']);
    const trackedObserved = silent(record);
    // 束ねた矢印関数でなく、関数宣言そのもの（name/length は矢印でも同じになるので、定義の書き出しで見分ける）
    expect(silent.toString().startsWith('function trackedGenerationSilent(')).toBe(true);
    expect({ name: silent.name, length: silent.length, untracked, trackedNoEvent, trackedObserved })
      .toMatchInlineSnapshot(`
        {
          "length": 1,
          "name": "trackedGenerationSilent",
          "trackedNoEvent": true,
          "trackedObserved": false,
          "untracked": false,
        }
      `);
  });

  it('再開の窓の口: onEvent は Pool の onEvent へ（出来事・どの runner から）の順で渡す', async () => {
    const { pool, inbox } = await open();
    const onEvent = fnOf('ResumeEventWindows', 'onEvent');
    const denied = {
      type: 'permission_denied',
      managerId: JOB_ID,
      toolUseId: 'tu-1',
      tool: 'Bash',
      via: 'result',
    };
    const returned = onEvent(denied, 'runner-primary');
    expect(returned).toBeInstanceOf(Promise);
    await returned;
    await settle();
    const report = {
      type: 'report',
      managerId: JOB_ID,
      text: '再開の窓の口から流した報告',
      sessionGeneration: 'g-new',
    };
    const before = inbox.length;
    await onEvent(report, 'runner-primary');
    await settle();
    const delivered = inbox.slice(before).map((event) => event.text);
    await onEvent({ ...report, text: '別の runner からの報告' }, 'runner-other');
    await settle();
    const afterOther = inbox.slice(before).map((event) => event.text);
    expect({ denials: pool.denials(JOB_ID).length, delivered, afterOther }).toMatchInlineSnapshot(`
      {
        "afterOther": [
          "再開の窓の口から流した報告",
        ],
        "delivered": [
          "再開の窓の口から流した報告",
        ],
        "denials": 1,
      }
    `);
  });

  it('再開の窓の口: droppedReportFiles は報告の本文を添え、報告でなければ空を返す', async () => {
    await open();
    const dropped = fnOf('ResumeEventWindows', 'droppedReportFiles');
    const returned = dropped(
      { type: 'report', managerId: JOB_ID, text: '捨てた本文' },
      'runner-primary',
    );
    expect(returned).toBeInstanceOf(Promise);
    const out = {
      report: await returned,
      notReport: await dropped({ type: 'usage', managerId: JOB_ID }, 'runner-primary'),
      // 添付つきの報告は「どの runner から」で取り寄せ先を引く（名簿に居ない runner なら受け取れなかった旨になる）
      filesFromUnknownRunner: await dropped(
        { type: 'report', managerId: JOB_ID, text: '添付つき', files: [{ name: 'a.txt' }] },
        'runner-other',
      ),
    };
    expect(out).toMatchInlineSnapshot(`
      {
        "filesFromUnknownRunner": {
          "attachments": {},
          "text": "

      捨てた報告の本文: 添付つき

      （受け取れなかった成果物: a.txt（受け取れなかった（報告を出した runner が名簿に居ない）））",
        },
        "notReport": {
          "attachments": {},
          "text": "",
        },
        "report": {
          "attachments": {},
          "text": "

      捨てた報告の本文: 捨てた本文",
        },
      }
    `);
  });

  it('同期の口は Promise を返さない（async の皮で包まない）', async () => {
    const { record } = await open();
    const returned: Record<string, unknown> = {};
    const withheld = instanceOf('WithheldReportsStore') as {
      reports: Map<string, unknown>;
    };
    expect(withheld.reports).toBeInstanceOf(Map);
    const calls: Record<string, [string, unknown[]][]> = {
      WithheldReportsStore: [
        ['now', []],
        ['nowIso', []],
        ['tokenSavingExcerpt', []],
        ['withheldReportFlushMs', []],
        ['emitFlush', [JOB_ID, 'x']],
      ],
      TurnEndWatch: [
        ['now', []],
        ['emitReport', [JOB_ID, 'x']],
        ['runnerHasCapability', ['runner-primary', 'c']],
      ],
      QuotaStopWindows: [
        ['now', []],
        ['nowIso', []],
        ['post', [{ type: 'external', id: 'e' }]],
      ],
      SynthesizedNoticeWindows: [
        ['now', []],
        ['nowIso', []],
        ['post', [{ type: 'external', id: 'e' }]],
        ['statusAtDelivery', [JOB_ID]],
        ['takeWithheldForDelivery', [JOB_ID, 'x', 'full']],
      ],
      RestoredWindows: [
        ['now', []],
        ['nowIso', []],
        ['stopped', []],
        ['post', [{ type: 'external', id: 'e' }]],
        ['postReport', [JOB_ID, 'x']],
        ['queueNotice', [JOB_ID, 'resume_unconfirmed', 'x']],
        ['notifyExcerptLines', [record.job]],
        ['trackFlush', [Promise.resolve()]],
      ],
      ResumeEventWindows: [
        ['judgeSessionGeneration', [record, { type: 'usage', managerId: JOB_ID }]],
        ['trackedGenerationSilent', [record]],
      ],
    };
    for (const [name, entries] of Object.entries(calls)) {
      const out: Record<string, boolean> = {};
      for (const [key, args] of entries) {
        const fn = portsOf(name)[key];
        if (typeof fn === 'function') out[key] = (fn as Fn)(...args) instanceof Promise;
      }
      returned[name] = out;
    }
    await settle();
    expect(returned).toMatchInlineSnapshot(`
      {
        "QuotaStopWindows": {
          "now": false,
          "nowIso": false,
          "post": false,
        },
        "RestoredWindows": {
          "notifyExcerptLines": false,
          "now": false,
          "nowIso": false,
          "post": false,
          "postReport": false,
          "queueNotice": false,
          "stopped": false,
          "trackFlush": true,
        },
        "ResumeEventWindows": {
          "judgeSessionGeneration": false,
          "trackedGenerationSilent": false,
        },
        "SynthesizedNoticeWindows": {
          "now": false,
          "nowIso": false,
          "post": false,
          "statusAtDelivery": false,
          "takeWithheldForDelivery": false,
        },
        "TurnEndWatch": {
          "emitReport": false,
          "now": false,
          "runnerHasCapability": false,
        },
        "WithheldReportsStore": {
          "emitFlush": false,
          "now": false,
          "nowIso": false,
          "tokenSavingExcerpt": false,
          "withheldReportFlushMs": false,
        },
      }
    `);
  });

  it('非同期の口が解けるまでの microtask の周回数（皮を足すと増える）', async () => {
    const { record } = await open();
    const hops: Record<string, Record<string, number>> = {};
    const mark = (name: string, key: string, value: number) => {
      (hops[name] ??= {})[key] = value;
    };
    mark(
      'WithheldReportsStore',
      'persist',
      await hopsOf(fnOf('WithheldReportsStore', 'persist')(record) as Promise<unknown>),
    );
    mark(
      'TurnEndWatch',
      'journal',
      await hopsOf(
        fnOf(
          'TurnEndWatch',
          'journal',
        )({ type: 'decision', decision: 'd', grounds: 'g' }) as Promise<unknown>,
      ),
    );
    mark(
      'TurnEndWatch',
      'runnerOf',
      await hopsOf(fnOf('TurnEndWatch', 'runnerOf')(record) as Promise<unknown>),
    );
    for (const name of ['QuotaStopWindows', 'SynthesizedNoticeWindows', 'RestoredWindows']) {
      mark(
        name,
        'journalExchange',
        await hopsOf(fnOf(name, 'journalExchange')('inbound', 'x') as Promise<unknown>),
      );
    }
    for (const name of ['QuotaStopWindows', 'RestoredWindows']) {
      mark(
        name,
        'listJobsOrNote',
        await hopsOf(fnOf(name, 'listJobsOrNote')('x') as Promise<unknown>),
      );
    }
    mark(
      'ResumeEventWindows',
      'journal',
      await hopsOf(
        fnOf(
          'ResumeEventWindows',
          'journal',
        )({ type: 'decision', decision: 'd', grounds: 'g' }) as Promise<unknown>,
      ),
    );
    mark(
      'ResumeEventWindows',
      'droppedReportFiles',
      await hopsOf(
        fnOf('ResumeEventWindows', 'droppedReportFiles')(
          { type: 'usage', managerId: JOB_ID },
          'runner-primary',
        ) as Promise<unknown>,
      ),
    );
    mark(
      'ResumeEventWindows',
      'droppedReportFilesReport',
      await hopsOf(
        fnOf('ResumeEventWindows', 'droppedReportFiles')(
          { type: 'report', managerId: JOB_ID, text: 't' },
          'runner-primary',
        ) as Promise<unknown>,
      ),
    );
    mark(
      'ResumeEventWindows',
      'onEvent',
      await hopsOf(
        fnOf('ResumeEventWindows', 'onEvent')(
          { type: 'usage', managerId: 'nobody' },
          'runner-primary',
        ) as Promise<unknown>,
      ),
    );
    expect(hops).toMatchInlineSnapshot(`
      {
        "QuotaStopWindows": {
          "journalExchange": 2,
          "listJobsOrNote": 2,
        },
        "RestoredWindows": {
          "journalExchange": 2,
          "listJobsOrNote": 2,
        },
        "ResumeEventWindows": {
          "droppedReportFiles": 1,
          "droppedReportFilesReport": 1,
          "journal": 2,
          "onEvent": 6,
        },
        "SynthesizedNoticeWindows": {
          "journalExchange": 2,
        },
        "TurnEndWatch": {
          "journal": 2,
          "runnerOf": 3,
        },
        "WithheldReportsStore": {
          "persist": 3,
        },
      }
    `);
  });
});
