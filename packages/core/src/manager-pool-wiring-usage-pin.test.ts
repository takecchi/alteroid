import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPoolOptions, type ManagerRecord } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import { createRunnerRegistry, type RunnerManagerState } from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { TokenRotatorObservation } from './token-rotator.js';

// `Pool` の `constructor` のうち、ブロック J（`UsageWake`・`StaleTokenFold`・`UsageReceiver`）を作って口（ports）を渡す部分の「配線」を、外から縛る。
// 切り出し（J を協力者を作る関数へ減らす）の前の pin。振る舞いそのものは各クラスの pin が縛っている。ここが縛るのは次の 8 つ:
//   - 3 つが何個・どの順で作られるか（前後の協力者 `ResumeEventWindows`・`ArchiveReceiver` との相対順、構築後に作り直されないことを含む）
//   - 構築の瞬間の読み: `UsageWake` の `rateLimits` は後で作る `UsageReceiver` を lazy に読む（構築の瞬間に呼ぶと TypeError）。
//     `StaleTokenFold` の `lastStaleDecline` は先に作った `HeldMessages` を読む（構築の瞬間でも落ちない）
//   - 渡る ports の欄の全部（欄名・関数か値か・関数の名前と引数の数）、`tokenAvailability` の undefined 分岐
//   - 共有参照（Map/Set の 12 本・`stores`）が `Pool` の持つ同じ物（`toBe`）で、コピーでないこと。`Pool` 側の書き込みが口の側から見えること
//   - 口の関数が `Pool` の側で引き直した結果になること（時計・`#stopped`・`#autoFold`／`#held`／`#usageWake`／`#usageReceiver` の読み直し）
//   - 口へ渡る引数の数（`observeForTokenRotation` は UsageWake が 3・UsageReceiver が 2、`queueSynthesizedNotice` は 3 と 4 など）
//   - 同期の口が Promise を返さないこと（async の皮で包まない）、非同期の口の microtask の周回数
//   - `Pool#send` へ渡す届け方（`{}` と `delivery` の位置）
// 期待の文字列・数は、いまの作りの出力から `-u` で生成して目で読んで写したもの（仕様を先に書いたものではない）。
// 実時間では待たない: 時計は注入し、タイマーは使わない。

const spy = vi.hoisted(() => {
  /** 構築の記録（名前だけ。構築の順と数を見る）。 */
  const order: string[] = [];
  const calls: { name: string; ports: Record<string, unknown>; instance: object }[] = [];
  /** 構築の瞬間に ports へ仕掛けた探りの結果（名前ごと）。 */
  const probed: Record<string, unknown> = {};
  function wrap<C>(name: string, Base: C, probe?: (ports: Record<string, unknown>) => unknown): C {
    const Original = Base as unknown as new (ports: Record<string, unknown>) => object;
    class Recorder extends Original {
      constructor(ports: Record<string, unknown>) {
        super(ports);
        if (probe !== undefined) probed[name] = probe(ports);
        order.push(name);
        calls.push({ name, ports, instance: this });
      }
    }
    return Recorder as unknown as C;
  }
  /** `fn()` の結果（落ちたらその型名）。 */
  function tryCall(fn: () => unknown): unknown {
    try {
      return { returned: fn() };
    } catch (error) {
      return { threw: (error as Error).constructor.name };
    }
  }
  return {
    order,
    calls,
    probed,
    wrap,
    tryCall,
    reset(): void {
      order.length = 0;
      calls.length = 0;
      for (const key of Object.keys(probed)) Reflect.deleteProperty(probed, key);
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
    WithheldReportsStore: spy.wrap('WithheldReportsStore', mod.WithheldReportsStore),
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
vi.mock('./denial-renotify.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./denial-renotify.js')>();
  return { ...mod, DenialRenotifier: spy.wrap('DenialRenotifier', mod.DenialRenotifier) };
});
vi.mock('./held-messages.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./held-messages.js')>();
  return { ...mod, HeldMessages: spy.wrap('HeldMessages', mod.HeldMessages) };
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
  return {
    ...mod,
    // 構築の瞬間に `rateLimits` を呼んでみる: `#usageReceiver` はまだ無いので、lazy に読む口はここで落ちる
    UsageWake: spy.wrap('UsageWake', mod.UsageWake, (ports) =>
      spy.tryCall(() => (ports.rateLimits as () => unknown)()),
    ),
  };
});
vi.mock('./stale-token-fold.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./stale-token-fold.js')>();
  return {
    ...mod,
    // 構築の瞬間に `lastStaleDecline` を呼んでみる: `#held`（E）は先に出来ているので落ちない
    StaleTokenFold: spy.wrap('StaleTokenFold', mod.StaleTokenFold, (ports) =>
      spy.tryCall(() => (ports.lastStaleDecline as (id: string) => unknown)('probe')),
    ),
  };
});
vi.mock('./usage-receiver.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./usage-receiver.js')>();
  return { ...mod, UsageReceiver: spy.wrap('UsageReceiver', mod.UsageReceiver) };
});
vi.mock('./archive-receiver.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./archive-receiver.js')>();
  return { ...mod, ArchiveReceiver: spy.wrap('ArchiveReceiver', mod.ArchiveReceiver) };
});
vi.mock('./manager-report-apply.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-report-apply.js')>();
  return { ...mod, ManagerReportApply: spy.wrap('ManagerReportApply', mod.ManagerReportApply) };
});
vi.mock('./manager-note.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-note.js')>();
  return { ...mod, ManagerNoteReceiver: spy.wrap('ManagerNoteReceiver', mod.ManagerNoteReceiver) };
});

const JOB_ID = 'mgr-wiring-usage-pin';
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const OLD_FP = 'aaaaaaaaaaaa';
const NEW_FP = 'bbbbbbbbbbbb';

/** 対象の 3 つ（`manager.ts` の構築順）。 */
const TARGETS = ['UsageWake', 'StaleTokenFold', 'UsageReceiver'] as const;

type Fn = (...args: unknown[]) => unknown;

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

/** 控えた構築のうち、名前が `name` の最後の 1 件。 */
function callOf(name: string) {
  const hit = spy.calls.filter((call) => call.name === name).at(-1);
  if (hit === undefined) throw new Error(`${name} は作られていない`);
  return hit;
}

function portsOf(name: string): Record<string, unknown> {
  return callOf(name).ports;
}

function instanceOf(name: string): object {
  return callOf(name).instance;
}

function fnOf(name: string, key: string): Fn {
  const value = portsOf(name)[key];
  if (typeof value !== 'function') throw new Error(`${name}.${key} は関数でない`);
  return value as Fn;
}

interface OpenOptions extends Pick<
  ManagerPoolOptions,
  'tokenIdentity' | 'tokenAssignment' | 'tokenAvailability' | 'onUsageObservation'
> {
  /** 台帳の委譲へ足す欄。 */
  job?: Partial<Job>;
  /** runner が生きたセッションとして名乗る鍵の指紋（あれば restore が引き取る）。 */
  sessionFingerprint?: string;
}

/** Pool を 1 つ作り、委譲 1 件を台帳から像へ戻して返す。時計は `clock.now` を読む。 */
async function open(extra: OpenOptions = {}) {
  spy.reset();
  const clock = { now: T0 };
  const stores = createMemoryStores();
  const { job: jobExtra, sessionFingerprint, ...poolExtra } = extra;
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
    ...jobExtra,
  });
  const inbox: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  let emit = null as ((event: never) => void) | null;
  const alive: RunnerManagerState[] =
    sessionFingerprint === undefined
      ? []
      : [
          {
            managerId: JOB_ID,
            status: 'running',
            cwd: '/work/project',
            request: '調べて',
            waiting: [],
            sessionId: 'sess-1',
            tokenFingerprint: sessionFingerprint,
            liveBackgroundTasks: 0,
          },
        ];
  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async connect(onEvent) {
      emit = onEvent as unknown as (event: never) => void;
    },
    async list() {
      return alive.map((state) => ({ ...state, waiting: [] }));
    },
    async send(...args: unknown[]) {
      sent.push({ via: 'send', args: args.map((arg) => (typeof arg === 'string' ? arg : 'obj')) });
      return true;
    },
    async resume(command) {
      sent.push({ via: 'resume', message: command.message });
      return { cwd: command.cwd };
    },
    async setProfile() {
      return { ok: true as const };
    },
  });
  const registry = createRunnerRegistry([runner]);
  const pool = createManagerPool({
    stores,
    now: () => clock.now,
    post: (event) => {
      inbox.push(event as unknown as Record<string, unknown>);
    },
    runners: registry,
    ...poolExtra,
  });
  // 構築の記録は restore の前に取り出す（restore が協力者を作り直さないことも確かめるため、数は後でもう一度見る）
  const constructed = [...spy.order];
  const constructedProbes = structuredClone(spy.probed);
  await pool.restore();
  await settle();
  const records = portsOf('UsageWake').records as Map<string, ManagerRecord>;
  const record = records.get(JOB_ID);
  if (record === undefined) throw new Error('像が作られていない');
  return {
    pool,
    stores,
    clock,
    inbox,
    sent,
    runner,
    registry,
    records,
    record,
    constructed,
    constructedProbes,
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

/** ports の欄ごとに `pick` した結果の表（3 つぶん）。 */
function tableOf(pick: (value: unknown) => string | undefined) {
  return Object.fromEntries(
    TARGETS.map((name) => [
      name,
      Object.fromEntries(
        Object.entries(portsOf(name)).flatMap(([key, value]) => {
          const picked = pick(value);
          return picked === undefined ? [] : [[key, picked]];
        }),
      ),
    ]),
  );
}

const decision = { type: 'decision', decision: 'd', grounds: 'g' };

describe('Pool の constructor の配線: UsageWake・StaleTokenFold・UsageReceiver（J）', () => {
  it('作られる協力者と順（前後の協力者との相対順を含む）と数', async () => {
    const { constructed } = await open();
    expect(constructed).toMatchInlineSnapshot(`
      [
        "SessionLoaders",
        "WithheldReportsStore",
        "TurnEndWatch",
        "AutoFold",
        "DenialRenotifier",
        "HeldMessages",
        "PushLedger",
        "QuotaStopWindows",
        "SynthesizedNoticeWindows",
        "RestoredWindows",
        "ResumeEventWindows",
        "UsageWake",
        "StaleTokenFold",
        "UsageReceiver",
        "ArchiveReceiver",
        "ManagerReportApply",
        "ManagerNoteReceiver",
      ]
    `);
    expect(spy.order).toEqual(constructed);
    const positions = TARGETS.map((name) => constructed.indexOf(name));
    // 3 つは 1 回ずつ、この順で、間に他の協力者を挟まず続けて作られる
    expect(positions.map((at, i) => at - positions[0]! - i)).toEqual([0, 0, 0]);
    expect(TARGETS.map((name) => constructed.filter((entry) => entry === name).length)).toEqual([
      1, 1, 1,
    ]);
    // 前後: 窓 4 種（H）の最後の直後に始まり、ArchiveReceiver の直前に終わる。E（AutoFold・HeldMessages）と PushLedger は J より前
    expect(constructed.indexOf('UsageWake') - constructed.indexOf('ResumeEventWindows')).toBe(1);
    expect(constructed.indexOf('ArchiveReceiver') - constructed.indexOf('UsageReceiver')).toBe(1);
    expect(constructed.indexOf('HeldMessages')).toBeLessThan(constructed.indexOf('UsageWake'));
    expect(constructed.indexOf('AutoFold')).toBeLessThan(constructed.indexOf('UsageWake'));
  });

  it('構築のあとの restore() は協力者を作り直さない', async () => {
    const { constructed } = await open();
    expect(spy.order).toEqual(constructed);
    expect(spy.calls.filter((call) => TARGETS.includes(call.name as never))).toHaveLength(3);
  });

  it('構築の瞬間の読み: UsageWake の rateLimits は未定義の UsageReceiver を読んで落ち、StaleTokenFold の lastStaleDecline は落ちない', async () => {
    const { constructedProbes } = await open();
    expect(constructedProbes).toMatchInlineSnapshot(`
      {
        "StaleTokenFold": {
          "returned": undefined,
        },
        "UsageWake": {
          "threw": "TypeError",
        },
      }
    `);
  });

  it('渡る ports の欄と、欄の種類（tokenAvailability が無いとき）', async () => {
    await open();
    expect(tableOf((value) => kindOf(value))).toMatchInlineSnapshot(`
      {
        "StaleTokenFold": {
          "journal": "function",
          "lastStaleDecline": "function",
          "observedTokenFingerprint": "function",
          "rememberStaleDecline": "function",
          "resumedCount": "Map",
          "rotationFoldDueAt": "Map",
          "sessionTokenFingerprintOf": "function",
          "tokenAvailability": "undefined",
          "tokenIdentities": "Map",
          "tokenIdentity": "function",
          "unpushedWork": "function",
        },
        "UsageReceiver": {
          "journal": "function",
          "journalExchange": "function",
          "movedAwayFrom": "function",
          "now": "function",
          "nowIso": "function",
          "observeForTokenRotation": "function",
          "persist": "function",
          "queueSynthesizedNotice": "function",
          "rememberResetTimeSkew": "function",
          "stores": "object:Object",
          "tokenIdentities": "Map",
          "usageStopped": "Set",
        },
        "UsageWake": {
          "beforeWakes": "function",
          "findJob": "function",
          "journal": "function",
          "journalExchange": "function",
          "load": "function",
          "now": "function",
          "observeForTokenRotation": "function",
          "persist": "function",
          "queueSynthesizedNotice": "function",
          "rateLimits": "function",
          "records": "Map",
          "resetTimeSkewMatches": "Map",
          "rotationFoldDueAt": "Map",
          "send": "function",
          "sessionTokenFingerprintOf": "function",
          "stopped": "function",
          "stores": "object:Object",
          "supersedePending": "Map",
          "tokenAvailability": "undefined",
          "tokenIdentities": "Map",
          "tokenIdentity": "function",
          "usageNudgeInFlight": "Map",
          "usageStopped": "Set",
          "usageWakeOwed": "Set",
          "usageWakeRetry": "Map",
          "workerLimitStopped": "Map",
          "workerLimitWakeRetry": "Map",
        },
      }
    `);
  });

  it('tokenAvailability の分岐: 有れば UsageWake と StaleTokenFold へ 1 引数だけ通す関数を渡し、無ければ undefined', async () => {
    await open();
    const without = {
      wake: portsOf('UsageWake').tokenAvailability,
      fold: portsOf('StaleTokenFold').tokenAvailability,
    };
    const seen: unknown[][] = [];
    const answer = Promise.resolve('ready' as const);
    await open({
      tokenAvailability: (...args: unknown[]) => {
        seen.push(args);
        return answer;
      },
    });
    const viaWake = fnOf('UsageWake', 'tokenAvailability')('tok-1', 'extra');
    const viaFold = fnOf('StaleTokenFold', 'tokenAvailability')('tok-2', 'extra');
    expect({
      withoutWake: without.wake,
      withoutFold: without.fold,
      withKinds: {
        wake: kindOf(portsOf('UsageWake').tokenAvailability),
        fold: kindOf(portsOf('StaleTokenFold').tokenAvailability),
        receiver: 'tokenAvailability' in portsOf('UsageReceiver'),
      },
      calls: seen,
      wakeSame: viaWake === answer,
      foldSame: viaFold === answer,
      wakeFnIsDistinct:
        portsOf('UsageWake').tokenAvailability !== portsOf('StaleTokenFold').tokenAvailability,
    }).toMatchInlineSnapshot(`
      {
        "calls": [
          [
            "tok-1",
          ],
          [
            "tok-2",
          ],
        ],
        "foldSame": true,
        "wakeFnIsDistinct": true,
        "wakeSame": true,
        "withKinds": {
          "fold": "function",
          "receiver": false,
          "wake": "function",
        },
        "withoutFold": undefined,
        "withoutWake": undefined,
      }
    `);
  });

  it('口の関数の名前と引数の数（束ねた無名の関数・bind・素通しの区別）', async () => {
    await open();
    expect(
      tableOf((value) =>
        typeof value === 'function'
          ? `${(value as Fn).name}/${String((value as Fn).length)}`
          : undefined,
      ),
    ).toMatchInlineSnapshot(`
      {
        "StaleTokenFold": {
          "journal": "journal/1",
          "lastStaleDecline": "lastStaleDecline/1",
          "observedTokenFingerprint": "observedTokenFingerprint/2",
          "rememberStaleDecline": "rememberStaleDecline/2",
          "sessionTokenFingerprintOf": "sessionTokenFingerprintOf/1",
          "tokenIdentity": "tokenIdentity/1",
          "unpushedWork": "unpushedWork/2",
        },
        "UsageReceiver": {
          "journal": "journal/1",
          "journalExchange": "bound #journalExchange/2",
          "movedAwayFrom": "movedAwayFrom/2",
          "now": "now/0",
          "nowIso": "nowIso/0",
          "observeForTokenRotation": "observeForTokenRotation/2",
          "persist": "persist/1",
          "queueSynthesizedNotice": "queueSynthesizedNotice/4",
          "rememberResetTimeSkew": "rememberResetTimeSkew/1",
        },
        "UsageWake": {
          "beforeWakes": "beforeWakes/1",
          "findJob": "findJob/1",
          "journal": "journal/1",
          "journalExchange": "bound #journalExchange/2",
          "load": "load/1",
          "now": "now/0",
          "observeForTokenRotation": "observeForTokenRotation/3",
          "persist": "persist/1",
          "queueSynthesizedNotice": "queueSynthesizedNotice/3",
          "rateLimits": "rateLimits/0",
          "send": "send/3",
          "sessionTokenFingerprintOf": "sessionTokenFingerprintOf/1",
          "stopped": "stopped/0",
          "tokenIdentity": "tokenIdentity/1",
        },
      }
    `);
  });

  it('共有参照は Pool の持つ同じ物（コピーでない）', async () => {
    const { stores, records, record } = await open();
    const wake = portsOf('UsageWake');
    const fold = portsOf('StaleTokenFold');
    const receiver = portsOf('UsageReceiver');
    const denial = portsOf('DenialRenotifier');
    const held = portsOf('HeldMessages');
    const synthesized = portsOf('SynthesizedNoticeWindows');
    const reportApply = portsOf('ManagerReportApply');
    const note = portsOf('ManagerNoteReceiver');
    // 像（`#records`）: E の DenialRenotifier と同じ Map で、restore が書いた像がそこに在る
    expect(wake.records).toBe(denial.records);
    expect(wake.records).toBe(records);
    expect(records.get(JOB_ID)).toBe(record);
    // 枠で止まった印: UsageWake / UsageReceiver / E の HeldMessages / M の ReportApply で同じ Set
    expect(wake.usageStopped).toBe(receiver.usageStopped);
    expect(wake.usageStopped).toBe(held.usageStopped);
    expect(wake.usageStopped).toBe(reportApply.usageStopped);
    // 作業者の落ちの印・合図のずれの控え: M の受け手と同じ Map
    expect(wake.workerLimitStopped).toBe(note.workerLimitStopped);
    expect(wake.resetTimeSkewMatches).toBe(reportApply.resetTimeSkewMatches);
    // 鍵の身元: 3 つと M の Note と H の SynthesizedNoticeWindows が同じ Map
    expect(wake.tokenIdentities).toBe(fold.tokenIdentities);
    expect(wake.tokenIdentities).toBe(receiver.tokenIdentities);
    expect(wake.tokenIdentities).toBe(note.tokenIdentities);
    expect(wake.tokenIdentities).toBe(synthesized.tokenIdentities);
    // 差し替えの待ち: H の SynthesizedNoticeWindows と同じ Map
    expect(wake.supersedePending).toBe(synthesized.supersedePending);
    // 鍵の回転の待ちの上限の時刻: UsageWake と StaleTokenFold が同じ Map
    expect(wake.rotationFoldDueAt).toBe(fold.rotationFoldDueAt);
    // 引数で渡した物はそのまま（UsageWake は引数の stores、UsageReceiver は欄の stores。同じ物）
    expect(wake.stores).toBe(stores);
    expect(receiver.stores).toBe(stores);
    // 種類
    expect(wake.usageStopped).toBeInstanceOf(Set);
    expect(wake.usageWakeOwed).toBeInstanceOf(Set);
    for (const key of [
      'usageWakeRetry',
      'usageNudgeInFlight',
      'workerLimitStopped',
      'workerLimitWakeRetry',
      'rotationFoldDueAt',
      'resetTimeSkewMatches',
      'supersedePending',
      'tokenIdentities',
    ]) {
      expect(wake[key], key).toBeInstanceOf(Map);
    }
    expect(fold.resumedCount).toBeInstanceOf(Map);
    // 別々の欄は別の物（取り違え・まとめ替えを検出する）
    const containers = [
      wake.records,
      wake.usageStopped,
      wake.usageWakeOwed,
      wake.usageWakeRetry,
      wake.usageNudgeInFlight,
      wake.workerLimitStopped,
      wake.workerLimitWakeRetry,
      wake.rotationFoldDueAt,
      wake.resetTimeSkewMatches,
      wake.supersedePending,
      wake.tokenIdentities,
      fold.resumedCount,
      held.resuming,
    ];
    expect(new Set(containers).size).toBe(containers.length);
    // 共有の確かめ: 片方へ書くともう片方から見える
    (wake.usageStopped as Set<string>).add('probe');
    expect((receiver.usageStopped as Set<string>).has('probe')).toBe(true);
    expect((held.usageStopped as Set<string>).has('probe')).toBe(true);
    (wake.usageStopped as Set<string>).delete('probe');
    (fold.rotationFoldDueAt as Map<string, number>).set('probe', 1);
    expect((wake.rotationFoldDueAt as Map<string, number>).get('probe')).toBe(1);
    (wake.rotationFoldDueAt as Map<string, number>).delete('probe');
    (receiver.tokenIdentities as Map<string, unknown>).set('probe', 1);
    expect((fold.tokenIdentities as Map<string, unknown>).get('probe')).toBe(1);
    expect((wake.tokenIdentities as Map<string, unknown>).get('probe')).toBe(1);
    (wake.tokenIdentities as Map<string, unknown>).delete('probe');
  });

  it('Pool 側が書く欄は口の側から見える（台帳の印の組み直し）: usageStopped・usageWakeRetry・workerLimitStopped', async () => {
    const { pool } = await open({
      job: {
        usageStoppedAt: new Date(T0 - 60_000).toISOString(),
        workerLimitStopped: {
          preRotationKey: true,
          turnStartedAt: new Date(T0 - 90_000).toISOString(),
        },
      },
    });
    const wake = portsOf('UsageWake');
    const retry = (wake.usageWakeRetry as Map<string, { failures: number; nextAt: number }>).get(
      JOB_ID,
    );
    expect({
      usageStopped: [...(wake.usageStopped as Set<string>)],
      usageStoppedOfReceiver: [...(portsOf('UsageReceiver').usageStopped as Set<string>)],
      workerLimitStopped: [...(wake.workerLimitStopped as Map<string, unknown>)],
      retry:
        retry === undefined
          ? undefined
          : { failures: retry.failures, nextAtMinusT0: retry.nextAt - T0 },
      workerLimitWakeRetry: [...(wake.workerLimitWakeRetry as Map<string, unknown>).keys()],
      usageNudgeInFlight: [...(wake.usageNudgeInFlight as Map<string, unknown>).keys()],
      usageWakeOwed: [...(wake.usageWakeOwed as Set<string>)],
    }).toMatchInlineSnapshot(`
      {
        "retry": {
          "failures": 0,
          "nextAtMinusT0": 0,
        },
        "usageNudgeInFlight": [],
        "usageStopped": [
          "mgr-wiring-usage-pin",
        ],
        "usageStoppedOfReceiver": [
          "mgr-wiring-usage-pin",
        ],
        "usageWakeOwed": [],
        "workerLimitStopped": [
          [
            "mgr-wiring-usage-pin",
            {
              "preRotationKey": true,
              "turnStartedAt": "2026-10-31T23:58:30.000Z",
            },
          ],
        ],
        "workerLimitWakeRetry": [],
      }
    `);
    expect(pool).toBeDefined();
  });

  it('Pool 側が書く欄は口の側から見える（引き取り）: 現役と違う鍵の指紋で引き取ると usageWakeOwed に載る', async () => {
    await open({
      sessionFingerprint: OLD_FP,
      tokenIdentity: () => ({ tokenId: 'tok-new', generation: 3, fingerprint: NEW_FP }),
    });
    const wake = portsOf('UsageWake');
    expect({
      usageWakeOwed: [...(wake.usageWakeOwed as Set<string>)],
      tokenIdentities: [...(wake.tokenIdentities as Map<string, unknown>).keys()],
    }).toMatchInlineSnapshot(`
      {
        "tokenIdentities": [],
        "usageWakeOwed": [
          "mgr-wiring-usage-pin",
        ],
      }
    `);
    // 同じ指紋で引き取れば載らない
    await open({
      sessionFingerprint: NEW_FP,
      tokenIdentity: () => ({ tokenId: 'tok-new', generation: 3, fingerprint: NEW_FP }),
    });
    expect([...(portsOf('UsageWake').usageWakeOwed as Set<string>)]).toEqual([]);
  });

  it('Pool 側が書く欄は口の側から見える（resume）: resumedCount と tokenIdentities', async () => {
    const { pool, sent } = await open({
      tokenIdentity: () => ({ tokenId: 'tok-active', generation: 9, fingerprint: NEW_FP }),
    });
    const fold = portsOf('StaleTokenFold');
    const before = {
      resumed: (fold.resumedCount as Map<string, number>).get(JOB_ID),
      identity: (fold.tokenIdentities as Map<string, unknown>).get(JOB_ID),
    };
    const result = await pool.send(JOB_ID, '起こして');
    await settle();
    expect({
      before,
      outcome: result.outcome,
      sent,
      resumedViaFold: (fold.resumedCount as Map<string, number>).get(JOB_ID),
      identityViaFold: (fold.tokenIdentities as Map<string, unknown>).get(JOB_ID),
      identityViaWake: (portsOf('UsageWake').tokenIdentities as Map<string, unknown>).get(JOB_ID),
      identityViaReceiver: (portsOf('UsageReceiver').tokenIdentities as Map<string, unknown>).get(
        JOB_ID,
      ),
    }).toMatchInlineSnapshot(`
      {
        "before": {
          "identity": {
            "generation": 9,
            "tokenId": "tok-active",
          },
          "resumed": 1,
        },
        "identityViaFold": {
          "generation": 9,
          "tokenId": "tok-active",
        },
        "identityViaReceiver": {
          "generation": 9,
          "tokenId": "tok-active",
        },
        "identityViaWake": {
          "generation": 9,
          "tokenId": "tok-active",
        },
        "outcome": "delivered",
        "resumedViaFold": 1,
        "sent": [
          {
            "message": "[system] runner の器が作り直された。作業ディレクトリが残っているとは限らないので、続きに入る前に手元の状態を確かめよ。中断していた作業の続きを進めよ。",
            "via": "resume",
          },
          {
            "args": [
              "mgr-wiring-usage-pin",
              "起こして",
            ],
            "via": "send",
          },
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
        "UsageReceiver.now": [
          1793491200000,
          1793491212345,
        ],
        "UsageReceiver.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
        "UsageWake.now": [
          1793491200000,
          1793491212345,
        ],
      }
    `);
  });

  it('stopped の口は Pool の止まった印を呼ぶ時に読む（stop() の後に変わる）', async () => {
    const { pool } = await open();
    const before = fnOf('UsageWake', 'stopped')();
    await pool.stop();
    const after = fnOf('UsageWake', 'stopped')();
    expect({ before, after }).toMatchInlineSnapshot(`
      {
        "after": true,
        "before": false,
      }
    `);
  });

  it('lazy な参照: beforeWakes は呼ぶ時点の #autoFold のメソッドを、rateLimits は UsageReceiver の rateLimits を読む', async () => {
    await open();
    const autoFold = instanceOf('AutoFold') as {
      beforeWakes: (ids: readonly string[]) => Promise<void>;
    };
    const receiver = instanceOf('UsageReceiver') as { rateLimits: ReadonlyMap<string, unknown> };
    // 構築の後に差し替えても、口は差し替えた方を呼ぶ（構築の時点のメソッドを控えていない）
    const returned = Promise.resolve();
    const spyBefore = vi.spyOn(autoFold, 'beforeWakes').mockReturnValue(returned);
    const via = fnOf('UsageWake', 'beforeWakes')(['a', 'b'], 'extra');
    const calls = spyBefore.mock.calls;
    spyBefore.mockRestore();
    const rates1 = fnOf('UsageWake', 'rateLimits')();
    const rates2 = fnOf('UsageWake', 'rateLimits')();
    expect({
      beforeWakesCalls: calls,
      beforeWakesSame: via === returned,
      rateLimitsIsReceiversMap: rates1 === receiver.rateLimits,
      rateLimitsStable: rates1 === rates2,
      rateLimitsKind: kindOf(rates1),
    }).toMatchInlineSnapshot(`
      {
        "beforeWakesCalls": [
          [
            [
              "a",
              "b",
            ],
          ],
        ],
        "beforeWakesSame": true,
        "rateLimitsIsReceiversMap": true,
        "rateLimitsKind": "Map",
        "rateLimitsStable": true,
      }
    `);
  });

  it('lazy な参照: lastStaleDecline・rememberStaleDecline は呼ぶ時点の #held を読み、引数をそのまま渡す', async () => {
    await open();
    const held = instanceOf('HeldMessages') as {
      lastStaleDecline: (id: string) => string | undefined;
      rememberStaleDecline: (id: string, record: string) => void;
    };
    const spyLast = vi.spyOn(held, 'lastStaleDecline').mockReturnValue('前の断り');
    const spyRemember = vi.spyOn(held, 'rememberStaleDecline').mockReturnValue(undefined);
    const last = fnOf('StaleTokenFold', 'lastStaleDecline')(JOB_ID, 'extra');
    const remembered = fnOf('StaleTokenFold', 'rememberStaleDecline')(
      JOB_ID,
      '断りの記録',
      'extra',
    );
    const lastCalls = spyLast.mock.calls;
    const rememberCalls = spyRemember.mock.calls;
    spyLast.mockRestore();
    spyRemember.mockRestore();
    // 戻すと、本物の預かりの控えを読み書きする（口が控えた参照でなく Pool の `#held` を引く）
    fnOf('StaleTokenFold', 'rememberStaleDecline')(JOB_ID, '本物の記録');
    expect({
      last,
      remembered,
      lastCalls,
      rememberCalls,
      real: fnOf('StaleTokenFold', 'lastStaleDecline')(JOB_ID),
      other: fnOf('StaleTokenFold', 'lastStaleDecline')('nobody'),
    }).toMatchInlineSnapshot(`
      {
        "last": "前の断り",
        "lastCalls": [
          [
            "mgr-wiring-usage-pin",
          ],
        ],
        "other": undefined,
        "real": "本物の記録",
        "rememberCalls": [
          [
            "mgr-wiring-usage-pin",
            "断りの記録",
          ],
        ],
        "remembered": undefined,
      }
    `);
  });

  it('lazy な参照: rememberResetTimeSkew は呼ぶ時点の #usageWake のメソッドを読み、event だけを渡す', async () => {
    await open();
    const wake = instanceOf('UsageWake') as {
      rememberResetTimeSkew: (event: unknown) => Promise<void>;
    };
    const returned = Promise.resolve();
    const spySkew = vi.spyOn(wake, 'rememberResetTimeSkew').mockReturnValue(returned);
    const event = { managerId: JOB_ID, notice: { kind: 'reached' } };
    const via = fnOf('UsageReceiver', 'rememberResetTimeSkew')(event, 'extra');
    const calls = spySkew.mock.calls;
    spySkew.mockRestore();
    expect({ calls, same: via === returned, firstIsEvent: calls[0]?.[0] === event })
      .toMatchInlineSnapshot(`
      {
        "calls": [
          [
            {
              "managerId": "mgr-wiring-usage-pin",
              "notice": {
                "kind": "reached",
              },
            },
          ],
        ],
        "firstIsEvent": true,
        "same": true,
      }
    `);
  });

  it('StaleTokenFold の口: unpushedWork は Pool の公開メソッドへ引数をそのまま渡し、同じ Promise を返す', async () => {
    const { pool } = await open();
    const sentinel = Promise.resolve({ sentinel: true });
    const spyUnpushed = vi.spyOn(pool, 'unpushedWork').mockReturnValue(sentinel as never);
    const signal = AbortSignal.abort();
    const via = fnOf('StaleTokenFold', 'unpushedWork')(JOB_ID, { signal, source: 'stop' }, 'extra');
    const calls = spyUnpushed.mock.calls;
    spyUnpushed.mockRestore();
    expect({
      same: via === sentinel,
      count: calls.length,
      id: calls[0]?.[0],
      optionsKeys: Object.keys((calls[0]?.[1] as object | undefined) ?? {}).sort(),
      signalSame: (calls[0]?.[1] as { signal?: unknown } | undefined)?.signal === signal,
      argc: calls[0]?.length,
    }).toMatchInlineSnapshot(`
      {
        "argc": 2,
        "count": 1,
        "id": "mgr-wiring-usage-pin",
        "optionsKeys": [
          "signal",
          "source",
        ],
        "same": true,
        "signalSame": true,
      }
    `);
  });

  it('StaleTokenFold の口: observedTokenFingerprint は runner の観測の sessionTokenFingerprints を欄名固定で引く', async () => {
    const { registry } = await open();
    const spyEntries = vi.spyOn(registry, 'entries').mockReturnValue([
      {
        runnerId: 'runner-primary',
        sessionTokenFingerprints: { [JOB_ID]: 'fp-observed' },
        sessionBackgroundTasks: { [JOB_ID]: 3 },
      },
    ] as never);
    const port = fnOf('StaleTokenFold', 'observedTokenFingerprint');
    const out = {
      hit: port('runner-primary', JOB_ID),
      otherManager: port('runner-primary', 'nobody'),
      otherRunner: port('runner-other', JOB_ID),
      noRunner: port(undefined, JOB_ID),
    };
    spyEntries.mockRestore();
    expect(out).toMatchInlineSnapshot(`
      {
        "hit": "fp-observed",
        "noRunner": undefined,
        "otherManager": undefined,
        "otherRunner": undefined,
      }
    `);
  });

  it('tokenIdentity の口（UsageWake・StaleTokenFold）は割り当てが在ればそれ、無ければ現役の鍵を呼ぶたびに引く', async () => {
    let active: { tokenId: string; generation: number; fingerprint?: string } | undefined = {
      tokenId: 'tok-active',
      generation: 1,
      fingerprint: 'fp-active',
    };
    await open({
      tokenIdentity: () => active,
      tokenAssignment: {
        assign: async () => undefined,
        target: (managerId) =>
          managerId === JOB_ID
            ? { tokenId: 'tok-assigned', generation: 7, fingerprint: 'fp-assigned' }
            : undefined,
      },
    });
    const out: Record<string, unknown> = {};
    for (const name of ['UsageWake', 'StaleTokenFold']) {
      const port = fnOf(name, 'tokenIdentity');
      active = { tokenId: 'tok-active', generation: 1, fingerprint: 'fp-active' };
      const first = port('nobody');
      active = { tokenId: 'tok-active', generation: 2 };
      out[name] = { assigned: port(JOB_ID, 'extra'), first, second: port('nobody') };
      active = undefined;
      (out[name] as Record<string, unknown>).none = port('nobody');
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "StaleTokenFold": {
          "assigned": {
            "fingerprint": "fp-assigned",
            "generation": 7,
            "tokenId": "tok-assigned",
          },
          "first": {
            "fingerprint": "fp-active",
            "generation": 1,
            "tokenId": "tok-active",
          },
          "none": undefined,
          "second": {
            "generation": 2,
            "tokenId": "tok-active",
          },
        },
        "UsageWake": {
          "assigned": {
            "fingerprint": "fp-assigned",
            "generation": 7,
            "tokenId": "tok-assigned",
          },
          "first": {
            "fingerprint": "fp-active",
            "generation": 1,
            "tokenId": "tok-active",
          },
          "none": undefined,
          "second": {
            "generation": 2,
            "tokenId": "tok-active",
          },
        },
      }
    `);
  });

  it('journal・persist・load・findJob の口は渡した物をそのまま台帳・日誌へ扱う', async () => {
    const { stores, clock, record } = await open();
    const out: Record<string, unknown> = {};
    for (const name of TARGETS) {
      const journal = fnOf(name, 'journal');
      await journal({
        type: 'decision',
        decision: `${name} の配線の確認`,
        grounds: '口から直に呼んだ',
      });
    }
    const hits = (await stores.journal.list({ types: ['decision'] })).filter((entry) =>
      String((entry as unknown as Record<string, unknown>).decision).includes('の配線の確認'),
    ) as unknown as Record<string, unknown>[];
    out.journal = hits.map((entry) => ({ decision: entry.decision, grounds: entry.grounds }));
    for (const [i, name] of ['UsageWake', 'UsageReceiver'].entries()) {
      clock.now = T0 + (i + 1) * 90_000;
      await fnOf(name, 'persist')(record, { sessionClosed: true });
      const row = await stores.jobs.getJob(JOB_ID);
      out[`${name}.persist`] = { updatedAt: record.job.updatedAt, stored: row?.updatedAt };
    }
    const loaded = (await fnOf('UsageWake', 'load')(JOB_ID)) as ManagerRecord | null;
    const found = (await fnOf('UsageWake', 'findJob')(JOB_ID)) as { id: string } | undefined;
    out.load = {
      same: loaded === record,
      missing: await fnOf('UsageWake', 'load')('nobody'),
      foundId: found?.id,
      missingJob: await fnOf('UsageWake', 'findJob')('nobody'),
    };
    expect(out).toMatchInlineSnapshot(`
      {
        "UsageReceiver.persist": {
          "stored": "2026-11-01T00:03:00.000Z",
          "updatedAt": "2026-11-01T00:03:00.000Z",
        },
        "UsageWake.persist": {
          "stored": "2026-11-01T00:01:30.000Z",
          "updatedAt": "2026-11-01T00:01:30.000Z",
        },
        "journal": [
          {
            "decision": "UsageReceiver の配線の確認",
            "grounds": "口から直に呼んだ",
          },
          {
            "decision": "StaleTokenFold の配線の確認",
            "grounds": "口から直に呼んだ",
          },
          {
            "decision": "UsageWake の配線の確認",
            "grounds": "口から直に呼んだ",
          },
        ],
        "load": {
          "foundId": "mgr-wiring-usage-pin",
          "missing": null,
          "missingJob": undefined,
          "same": true,
        },
      }
    `);
  });

  it('journalExchange の口（3 つ）は exchange（with=manager）を日誌へ書き、Promise を返す', async () => {
    const { stores } = await open();
    const wrote: Record<string, unknown> = {};
    for (const name of TARGETS) {
      const ports = portsOf(name);
      if (typeof ports.journalExchange !== 'function') continue;
      const text = `${name} の呼び出し`;
      const returned = (ports.journalExchange as Fn)('outbound', text);
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
        "UsageReceiver": {
          "added": 1,
          "role": "outbound",
          "text": "UsageReceiver の呼び出し",
          "with": "manager",
        },
        "UsageWake": {
          "added": 1,
          "role": "outbound",
          "text": "UsageWake の呼び出し",
          "with": "manager",
        },
      }
    `);
  });

  it('send の口（UsageWake）は (id, 本文, delivery) を Pool#send の (id, 本文, {}, delivery) へ渡す', async () => {
    const { sent } = await open();
    const delivery = { mode: 'usage-rotation' as const, onFoldNoticeDelivered: () => undefined };
    const viaWake = (await fnOf('UsageWake', 'send')(JOB_ID, '起こし直し', delivery, 'extra')) as {
      outcome: string;
    };
    const missing = (await fnOf('UsageWake', 'send')('nobody', 'x', delivery)) as {
      outcome: string;
    };
    expect({ outcome: viaWake.outcome, sent, missing: missing.outcome }).toMatchInlineSnapshot(`
      {
        "missing": "unknown",
        "outcome": "delivered",
        "sent": [
          {
            "message": "[system] runner の器が作り直された。作業ディレクトリが残っているとは限らないので、続きに入る前に手元の状態を確かめよ。中断していた作業の続きを進めよ。",
            "via": "resume",
          },
          {
            "args": [
              "mgr-wiring-usage-pin",
              "起こし直し",
            ],
            "via": "send",
          },
        ],
      }
    `);
  });

  it('send の口（UsageWake）: delivery の mode は届け方として Pool#send の 4 番目の引数に届く（usage-rotation は fold の options に出る）', async () => {
    const out: Record<string, unknown> = {};
    // 1 回送ると委譲が running へ動いて fold を通らなくなるので、届け方ごとに Pool を作り直す
    for (const mode of ['usage-rotation', 'caller'] as const) {
      await open({ job: { status: 'done' } });
      const fold = instanceOf('StaleTokenFold') as {
        fold: (...args: unknown[]) => Promise<unknown>;
      };
      const spyFold = vi.spyOn(fold, 'fold').mockResolvedValue({});
      const delivery = { mode, onFoldNoticeDelivered: () => undefined };
      const via = (await fnOf('UsageWake', 'send')(JOB_ID, '起こし', delivery)) as {
        outcome: string;
      };
      out[mode] = {
        outcome: via.outcome,
        foldCalls: spyFold.mock.calls.length,
        options: spyFold.mock.calls.at(-1)?.[3],
      };
      spyFold.mockRestore();
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "caller": {
          "foldCalls": 1,
          "options": {
            "foldBackgroundAfterWait": false,
            "foldBackgroundIfHeldTokenNotReady": false,
            "skipUnchangedDeclineRecord": false,
          },
          "outcome": "delivered",
        },
        "usage-rotation": {
          "foldCalls": 1,
          "options": {
            "foldBackgroundAfterWait": false,
            "foldBackgroundIfHeldTokenNotReady": true,
            "skipUnchangedDeclineRecord": false,
          },
          "outcome": "delivered",
        },
      }
    `);
  });

  it('queueSynthesizedNotice の口: UsageWake は 3 引数だけ、UsageReceiver は quotaMark まで 4 引数を合流窓の queue へ渡す', async () => {
    await open();
    const synthesized = instanceOf('SynthesizedNoticeWindows') as {
      queue: (...args: unknown[]) => void;
    };
    const calls: unknown[][] = [];
    const spyQueue = vi.spyOn(synthesized, 'queue').mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    const mark = { kind: 'reached', at: 'x' };
    const viaWake = fnOf('UsageWake', 'queueSynthesizedNotice')(
      JOB_ID,
      'usage_rotation',
      '起こし直しの知らせ',
      mark,
    );
    const viaReceiver = fnOf('UsageReceiver', 'queueSynthesizedNotice')(
      JOB_ID,
      'usage_limit',
      '枠の知らせ',
      mark,
    );
    spyQueue.mockRestore();
    expect({
      viaWake,
      viaReceiver,
      calls: calls.map((args) => ({
        count: args.length,
        head: args.slice(0, 3),
        fourthIsMark: args[3] === mark,
      })),
    }).toMatchInlineSnapshot(`
      {
        "calls": [
          {
            "count": 3,
            "fourthIsMark": false,
            "head": [
              "mgr-wiring-usage-pin",
              "usage_rotation",
              "起こし直しの知らせ",
            ],
          },
          {
            "count": 4,
            "fourthIsMark": true,
            "head": [
              "mgr-wiring-usage-pin",
              "usage_limit",
              "枠の知らせ",
            ],
          },
        ],
        "viaReceiver": undefined,
        "viaWake": undefined,
      }
    `);
  });

  it('observeForTokenRotation の口: UsageWake は第 3 引数（指紋）を渡し、UsageReceiver は渡さず Pool の既定（引き取りの指紋）が効く', async () => {
    const observations: TokenRotatorObservation[] = [];
    await open({
      sessionFingerprint: OLD_FP,
      tokenIdentity: () => ({ tokenId: 'tok-new', generation: 3, fingerprint: NEW_FP }),
      onUsageObservation: async (observation) => {
        observations.push(observation);
      },
    });
    const observation = { transition: 'rejected' as const };
    const wake = fnOf('UsageWake', 'observeForTokenRotation');
    const receiver = fnOf('UsageReceiver', 'observeForTokenRotation');
    const returned = {
      wakeExplicit: wake('nobody-1', observation, 'fp-explicit'),
      wakeDefault: wake(JOB_ID, observation, undefined),
      wakeOmitted: wake(JOB_ID, observation),
      receiverIgnoresThird: receiver(JOB_ID, observation, 'fp-explicit'),
    };
    await Promise.all(Object.values(returned) as Promise<unknown>[]);
    expect({
      kinds: Object.fromEntries(
        Object.entries(returned).map(([key, value]) => [key, value instanceof Promise]),
      ),
      observations,
    }).toMatchInlineSnapshot(`
      {
        "kinds": {
          "receiverIgnoresThird": true,
          "wakeDefault": true,
          "wakeExplicit": true,
          "wakeOmitted": true,
        },
        "observations": [
          {
            "observedBy": {
              "fingerprint": "fp-explicit",
            },
            "transition": "rejected",
          },
          {
            "observedBy": {
              "fingerprint": "aaaaaaaaaaaa",
            },
            "transition": "rejected",
          },
          {
            "observedBy": {
              "fingerprint": "aaaaaaaaaaaa",
            },
            "transition": "rejected",
          },
          {
            "observedBy": {
              "fingerprint": "aaaaaaaaaaaa",
            },
            "transition": "rejected",
          },
        ],
      }
    `);
  });

  it('sessionTokenFingerprintOf・movedAwayFrom の口は Pool の見たままを返す（同期）', async () => {
    const { record } = await open({
      sessionFingerprint: OLD_FP,
      tokenIdentity: () => ({ tokenId: 'tok-new', generation: 3, fingerprint: NEW_FP }),
    });
    const out = {
      wakeFingerprint: fnOf('UsageWake', 'sessionTokenFingerprintOf')(JOB_ID),
      foldFingerprint: fnOf('StaleTokenFold', 'sessionTokenFingerprintOf')(JOB_ID),
      unknownManager: fnOf('UsageWake', 'sessionTokenFingerprintOf')('nobody'),
      movedAwayFromOwn: fnOf('UsageReceiver', 'movedAwayFrom')(record, 'runner-primary', 'extra'),
      movedAwayFromOther: fnOf('UsageReceiver', 'movedAwayFrom')(record, 'runner-other'),
    };
    expect(out).toMatchInlineSnapshot(`
      {
        "foldFingerprint": "aaaaaaaaaaaa",
        "movedAwayFromOther": true,
        "movedAwayFromOwn": false,
        "unknownManager": undefined,
        "wakeFingerprint": "aaaaaaaaaaaa",
      }
    `);
  });

  it('同期の口は Promise を返さない（async の皮で包まない）', async () => {
    const { record } = await open();
    const calls: Record<string, [string, unknown[]][]> = {
      UsageWake: [
        ['now', []],
        ['stopped', []],
        ['tokenIdentity', [JOB_ID]],
        ['queueSynthesizedNotice', [JOB_ID, 'usage_rotation', 'x']],
        ['sessionTokenFingerprintOf', [JOB_ID]],
        ['rateLimits', []],
      ],
      StaleTokenFold: [
        ['tokenIdentity', [JOB_ID]],
        ['sessionTokenFingerprintOf', [JOB_ID]],
        ['observedTokenFingerprint', ['runner-primary', JOB_ID]],
        ['lastStaleDecline', [JOB_ID]],
        ['rememberStaleDecline', [JOB_ID, 'x']],
      ],
      UsageReceiver: [
        ['now', []],
        ['nowIso', []],
        ['movedAwayFrom', [record, 'runner-primary']],
        ['queueSynthesizedNotice', [JOB_ID, 'usage_limit', 'x']],
      ],
    };
    const returned: Record<string, Record<string, boolean>> = {};
    for (const [name, entries] of Object.entries(calls)) {
      const out: Record<string, boolean> = {};
      for (const [key, args] of entries) {
        out[key] = fnOf(name, key)(...args) instanceof Promise;
      }
      returned[name] = out;
    }
    await settle();
    expect(returned).toMatchInlineSnapshot(`
      {
        "StaleTokenFold": {
          "lastStaleDecline": false,
          "observedTokenFingerprint": false,
          "rememberStaleDecline": false,
          "sessionTokenFingerprintOf": false,
          "tokenIdentity": false,
        },
        "UsageReceiver": {
          "movedAwayFrom": false,
          "now": false,
          "nowIso": false,
          "queueSynthesizedNotice": false,
        },
        "UsageWake": {
          "now": false,
          "queueSynthesizedNotice": false,
          "rateLimits": false,
          "sessionTokenFingerprintOf": false,
          "stopped": false,
          "tokenIdentity": false,
        },
      }
    `);
  });

  it('非同期の口が解けるまでの microtask の周回数（皮を足すと増える）', async () => {
    const { record, pool } = await open({
      tokenAvailability: async () => 'ready',
      onUsageObservation: async () => undefined,
    });
    const hops: Record<string, Record<string, number>> = {};
    const mark = async (name: string, key: string, promise: Promise<unknown>) => {
      (hops[name] ??= {})[key] = await hopsOf(promise);
    };
    const delivery = { mode: 'usage-rotation' as const, onFoldNoticeDelivered: () => undefined };
    await mark('UsageWake', 'load', fnOf('UsageWake', 'load')(JOB_ID) as Promise<unknown>);
    await mark('UsageWake', 'findJob', fnOf('UsageWake', 'findJob')(JOB_ID) as Promise<unknown>);
    await mark('UsageWake', 'persist', fnOf('UsageWake', 'persist')(record) as Promise<unknown>);
    await mark('UsageWake', 'journal', fnOf('UsageWake', 'journal')(decision) as Promise<unknown>);
    await mark(
      'UsageWake',
      'journalExchange',
      fnOf('UsageWake', 'journalExchange')('inbound', 'x') as Promise<unknown>,
    );
    await mark(
      'UsageWake',
      'tokenAvailability',
      fnOf('UsageWake', 'tokenAvailability')('tok') as Promise<unknown>,
    );
    await mark(
      'UsageWake',
      'send',
      fnOf('UsageWake', 'send')('nobody', 'x', delivery) as Promise<unknown>,
    );
    await mark(
      'UsageWake',
      'observeForTokenRotation',
      fnOf('UsageWake', 'observeForTokenRotation')('nobody', {}, undefined) as Promise<unknown>,
    );
    await mark(
      'UsageWake',
      'beforeWakes',
      fnOf('UsageWake', 'beforeWakes')([]) as Promise<unknown>,
    );
    await mark(
      'StaleTokenFold',
      'tokenAvailability',
      fnOf('StaleTokenFold', 'tokenAvailability')('tok') as Promise<unknown>,
    );
    await mark(
      'StaleTokenFold',
      'journal',
      fnOf('StaleTokenFold', 'journal')(decision) as Promise<unknown>,
    );
    const sentinel = Promise.resolve(undefined);
    const spyUnpushed = vi.spyOn(pool, 'unpushedWork').mockReturnValue(sentinel as never);
    await mark(
      'StaleTokenFold',
      'unpushedWork',
      fnOf('StaleTokenFold', 'unpushedWork')(JOB_ID, {
        signal: AbortSignal.abort(),
        source: 'stop',
      }) as Promise<unknown>,
    );
    spyUnpushed.mockRestore();
    await mark(
      'UsageReceiver',
      'persist',
      fnOf('UsageReceiver', 'persist')(record) as Promise<unknown>,
    );
    await mark(
      'UsageReceiver',
      'journal',
      fnOf('UsageReceiver', 'journal')(decision) as Promise<unknown>,
    );
    await mark(
      'UsageReceiver',
      'journalExchange',
      fnOf('UsageReceiver', 'journalExchange')('inbound', 'x') as Promise<unknown>,
    );
    await mark(
      'UsageReceiver',
      'observeForTokenRotation',
      fnOf('UsageReceiver', 'observeForTokenRotation')('nobody', {}) as Promise<unknown>,
    );
    const wake = instanceOf('UsageWake') as {
      rememberResetTimeSkew: (event: unknown) => Promise<void>;
    };
    const spySkew = vi.spyOn(wake, 'rememberResetTimeSkew').mockResolvedValue(undefined);
    await mark(
      'UsageReceiver',
      'rememberResetTimeSkew',
      fnOf('UsageReceiver', 'rememberResetTimeSkew')({}) as Promise<unknown>,
    );
    spySkew.mockRestore();
    expect(hops).toMatchInlineSnapshot(`
      {
        "StaleTokenFold": {
          "journal": 2,
          "tokenAvailability": 1,
          "unpushedWork": 1,
        },
        "UsageReceiver": {
          "journal": 2,
          "journalExchange": 2,
          "observeForTokenRotation": 2,
          "persist": 3,
          "rememberResetTimeSkew": 1,
        },
        "UsageWake": {
          "beforeWakes": 1,
          "findJob": 2,
          "journal": 2,
          "journalExchange": 2,
          "load": 3,
          "observeForTokenRotation": 2,
          "persist": 3,
          "send": 13,
          "tokenAvailability": 1,
        },
      }
    `);
  });
});
