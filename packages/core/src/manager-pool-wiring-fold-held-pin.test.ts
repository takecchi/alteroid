import { describe, expect, it, vi } from 'vitest';

import type { AttachmentLimits } from './attachment.js';
import { createManagerPool, type ManagerPoolOptions, type ManagerRecord } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import { UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS } from './unpushed-work-observation.js';

// `Pool` の `constructor` のうち、ブロック E（`AutoFold`・`DenialRenotifier`・`RescueSweeper`・`AttachmentStager`・`ManagerRescueStash`・`HeldMessages`）を
// 作って口（ports）を渡す部分の「配線」を、外から縛る。切り出し（E を協力者を作る関数へ減らす）の前の pin。
// 振る舞いそのものは各クラスの pin が縛っている。ここが縛るのは次の 7 つ:
//   - 6 つが何個・どの順で作られるか（前後の協力者 `TurnEndWatch`・`PushLedger` との相対順、構築後に作り直されないことを含む）
//   - `HeldMessages` が `AutoFold` の口の lazy な参照先であること（`AutoFold` の構築の時点では `#held` が未定義で、呼ぶ時点で読み直す）
//   - 渡る ports の欄の全部（欄名・関数か値か・関数の名前と引数の数）
//   - 共有参照（`#records`・`#usageStopped`・`#resuming`・`stores`・`runners`・`attachmentLimits`）が `Pool` の持つ同じ物（`toBe`）で、コピーでないこと
//   - 関数の口を呼ぶと `Pool` の側で引き直した結果になること（時計・`#stopped`・hello の名乗り・`Pool` の公開メソッドへの引数の順）
//   - 同期の口が Promise を返さないこと（async の皮で包まない）、非同期の口の microtask の周回数
//   - `Pool#send` へ渡す届け方（`{ mode: 'caller' }` と `{}`）の取り違えがないこと
// 期待の文字列・数は、いまの作りの出力から `-u` で生成して目で読んで写したもの（仕様を先に書いたものではない）。
// 実時間では待たない: 時計は注入し、タイマーは使わない（`AbortSignal.timeout` は引数だけを見て実際には待たない）。

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
  return {
    order,
    calls,
    probed,
    wrap,
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
  return {
    ...mod,
    // 構築の瞬間に `retainedIds` を呼んでみる: `#held` がまだ無ければ、lazy に読む口はここで落ちる
    AutoFold: spy.wrap('AutoFold', mod.AutoFold, (ports) => {
      try {
        return { returned: [...(ports.retainedIds as () => Iterable<string>)()] };
      } catch (error) {
        return { threw: (error as Error).constructor.name };
      }
    }),
  };
});
vi.mock('./denial-renotify.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./denial-renotify.js')>();
  return { ...mod, DenialRenotifier: spy.wrap('DenialRenotifier', mod.DenialRenotifier) };
});
vi.mock('./rescue-sweeper.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./rescue-sweeper.js')>();
  return { ...mod, RescueSweeper: spy.wrap('RescueSweeper', mod.RescueSweeper) };
});
vi.mock('./attachment-stager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./attachment-stager.js')>();
  return { ...mod, AttachmentStager: spy.wrap('AttachmentStager', mod.AttachmentStager) };
});
vi.mock('./manager-rescue-stash.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-rescue-stash.js')>();
  return { ...mod, ManagerRescueStash: spy.wrap('ManagerRescueStash', mod.ManagerRescueStash) };
});
vi.mock('./held-messages.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./held-messages.js')>();
  return { ...mod, HeldMessages: spy.wrap('HeldMessages', mod.HeldMessages) };
});
vi.mock('./push-ledger.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./push-ledger.js')>();
  return { ...mod, PushLedger: spy.wrap('PushLedger', mod.PushLedger) };
});
vi.mock('./synthesized-notice-windows.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./synthesized-notice-windows.js')>();
  return {
    ...mod,
    SynthesizedNoticeWindows: spy.wrap('SynthesizedNoticeWindows', mod.SynthesizedNoticeWindows),
  };
});
vi.mock('./usage-wake.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./usage-wake.js')>();
  return { ...mod, UsageWake: spy.wrap('UsageWake', mod.UsageWake) };
});

const JOB_ID = 'mgr-wiring-fold-held-pin';
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

/** 対象の 6 つ（`manager.ts` の構築順）。 */
const TARGETS = [
  'AutoFold',
  'DenialRenotifier',
  'RescueSweeper',
  'AttachmentStager',
  'ManagerRescueStash',
  'HeldMessages',
] as const;

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

type PoolExtra = Pick<ManagerPoolOptions, 'attachmentLimits'>;

interface OpenOptions extends PoolExtra {
  heldMessages?: { text: string; heldAt: string; reason: string }[];
}

/** Pool を 1 つ作り、委譲 1 件を台帳から像へ戻して返す。時計は `clock.now` を読む。 */
async function open(extra: OpenOptions = {}) {
  spy.reset();
  const clock = { now: T0 };
  const stores = createMemoryStores();
  const { heldMessages, ...poolExtra } = extra;
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
    ...(heldMessages === undefined ? {} : { heldMessages }),
  });
  const inbox: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  /** `runner.resume` が呼ばれた瞬間の `HeldMessages` の `resuming` に、この委譲が居るか（Pool の `#resuming` との共有の確かめ） */
  const resumingOf = (): boolean | null => {
    const hit = spy.calls.filter((call) => call.name === 'HeldMessages').at(-1);
    return hit === undefined ? null : (hit.ports.resuming as Set<string>).has(JOB_ID);
  };
  let emit = null as ((event: never) => void) | null;
  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async connect(onEvent) {
      emit = onEvent as unknown as (event: never) => void;
    },
    async list() {
      return [];
    },
    async send(...args: unknown[]) {
      sent.push({
        via: 'send',
        args: args.map((arg) => (typeof arg === 'string' ? arg : kindOf(arg))),
      });
      return true;
    },
    async resume(command) {
      sent.push({
        via: 'resume',
        message: command.message,
        resumingHeld: resumingOf?.() ?? null,
      });
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
  const records = portsOf('DenialRenotifier').records as Map<string, ManagerRecord>;
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

describe('Pool の constructor の配線: AutoFold・DenialRenotifier・RescueSweeper・AttachmentStager・ManagerRescueStash・HeldMessages（E）', () => {
  it('作られる協力者と順（前後の協力者との相対順を含む）と数', async () => {
    const { constructed } = await open();
    expect(constructed).toMatchInlineSnapshot(`
      [
        "SessionLoaders",
        "WithheldReportsStore",
        "TurnEndWatch",
        "AutoFold",
        "DenialRenotifier",
        "RescueSweeper",
        "AttachmentStager",
        "ManagerRescueStash",
        "HeldMessages",
        "PushLedger",
        "SynthesizedNoticeWindows",
        "UsageWake",
      ]
    `);
    expect(spy.order).toEqual(constructed);
    // 6 つは 1 回ずつ、この順で、間に他の協力者を挟まず続けて作られる
    const positions = TARGETS.map((name) => constructed.indexOf(name));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.map((at, i) => at - positions[0]! - i)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(TARGETS.map((name) => constructed.filter((entry) => entry === name).length)).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
    // 前後: 見回り（D）の直後に始まり、PushLedger（F）の直前に終わる
    expect(constructed.indexOf('AutoFold') - constructed.indexOf('TurnEndWatch')).toBe(1);
    expect(constructed.indexOf('PushLedger') - constructed.indexOf('HeldMessages')).toBe(1);
  });

  it('構築のあとの restore() は協力者を作り直さない', async () => {
    const { constructed } = await open();
    expect(spy.order).toEqual(constructed);
  });

  it('AutoFold の口は HeldMessages を lazy に読む（構築の瞬間は未定義、呼ぶ時点で引く）', async () => {
    const { constructedProbes } = await open();
    // AutoFold を作る時点では `#held` がまだ無いので、`retainedIds` を呼ぶと落ちる（eager に読むと構築が落ちる）
    expect(constructedProbes.AutoFold).toMatchInlineSnapshot(`
      {
        "threw": "TypeError",
      }
    `);
    // 構築の後は、使い止め・作業者上限の止め・預かりの索引の 3 つを、この順で呼ぶたびに読み直す
    const retained = fnOf('AutoFold', 'retainedIds');
    const held = instanceOf('HeldMessages') as {
      indexRestored: (job: unknown) => void;
      jobIds: () => Set<string>;
    };
    const wake = portsOf('UsageWake');
    const usageStopped = wake.usageStopped as Set<string>;
    const workerLimitStopped = wake.workerLimitStopped as Map<string, unknown>;
    const empty = [...(retained() as Iterable<string>)];
    usageStopped.add('u1');
    workerLimitStopped.set('w1', { probe: true });
    held.indexRestored({ id: 'h1', heldMessages: [{ text: 'x' }] });
    const full = [...(retained() as Iterable<string>)];
    usageStopped.delete('u1');
    workerLimitStopped.delete('w1');
    const afterDelete = [...(retained() as Iterable<string>)];
    held.jobIds().delete('h1');
    expect({ empty, full, afterDelete, cleared: [...(retained() as Iterable<string>)] })
      .toMatchInlineSnapshot(`
        {
          "afterDelete": [
            "h1",
          ],
          "cleared": [],
          "empty": [],
          "full": [
            "u1",
            "w1",
            "h1",
          ],
        }
      `);
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
        "AttachmentStager": {
          "awaitHello": "function",
          "hasCapability": "function",
          "openAttachment": "function",
        },
        "AutoFold": {
          "abort": "function",
          "findJob": "function",
          "journal": "function",
          "list": "function",
          "now": "function",
          "observeUnpushedWork": "function",
          "retainedIds": "function",
          "runnerHasCapability": "function",
          "runnerIdOf": "function",
          "runners": "object:Registry",
          "stopped": "function",
        },
        "DenialRenotifier": {
          "emitReport": "function",
          "journalExchange": "function",
          "now": "function",
          "records": "Map",
          "stopped": "function",
        },
        "HeldMessages": {
          "journal": "function",
          "load": "function",
          "now": "function",
          "nowIso": "function",
          "persist": "function",
          "queueNotice": "function",
          "records": "Map",
          "resuming": "Set",
          "send": "function",
          "stopped": "function",
          "usageStopped": "Set",
        },
        "ManagerRescueStash": {
          "attachmentLimits": "undefined",
          "instanceIdOf": "function",
          "journal": "function",
          "load": "function",
          "nowIso": "function",
          "persist": "function",
          "records": "Map",
          "runnerHasCapability": "function",
          "runnerOrNull": "function",
          "send": "function",
          "stores": "object:Object",
          "swapNote": "function",
        },
        "RescueSweeper": {
          "journal": "function",
          "now": "function",
          "nowIso": "function",
          "persist": "function",
          "records": "Map",
          "runnerOf": "function",
          "runnersOrEmpty": "function",
          "stopped": "function",
          "stores": "object:Object",
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
        "AttachmentStager": {
          "awaitHello": "awaitHello/1",
          "hasCapability": "hasCapability/2",
          "openAttachment": "openAttachment/1",
        },
        "AutoFold": {
          "abort": "abort/3",
          "findJob": "findJob/1",
          "journal": "journal/1",
          "list": "list/0",
          "now": "now/0",
          "observeUnpushedWork": "observeUnpushedWork/1",
          "retainedIds": "retainedIds/0",
          "runnerHasCapability": "runnerHasCapability/2",
          "runnerIdOf": "runnerIdOf/1",
          "stopped": "stopped/0",
        },
        "DenialRenotifier": {
          "emitReport": "emitReport/2",
          "journalExchange": "bound #journalExchange/2",
          "now": "now/0",
          "stopped": "stopped/0",
        },
        "HeldMessages": {
          "journal": "journal/1",
          "load": "load/1",
          "now": "now/0",
          "nowIso": "nowIso/0",
          "persist": "persist/1",
          "queueNotice": "queueNotice/3",
          "send": "send/3",
          "stopped": "stopped/0",
        },
        "ManagerRescueStash": {
          "instanceIdOf": "instanceIdOf/1",
          "journal": "journal/1",
          "load": "load/1",
          "nowIso": "nowIso/0",
          "persist": "persist/1",
          "runnerHasCapability": "runnerHasCapability/2",
          "runnerOrNull": "runnerOrNull/1",
          "send": "send/3",
          "swapNote": "swapNote/2",
        },
        "RescueSweeper": {
          "journal": "journal/1",
          "now": "now/0",
          "nowIso": "nowIso/0",
          "persist": "persist/1",
          "runnerOf": "runnerOf/1",
          "runnersOrEmpty": "runnersOrEmpty/0",
          "stopped": "stopped/0",
        },
      }
    `);
  });

  it('共有参照は Pool の持つ同じ物（コピーでない）', async () => {
    const { stores, registry, records, record } = await open();
    const wake = portsOf('UsageWake');
    const held = portsOf('HeldMessages');
    // 像（`#records`）: 4 つが同じ Map を持ち、restore が書いた像がそこに在る
    for (const name of [
      'DenialRenotifier',
      'RescueSweeper',
      'ManagerRescueStash',
      'HeldMessages',
    ]) {
      expect(portsOf(name).records).toBe(records);
    }
    expect(wake.records).toBe(records);
    expect(records.get(JOB_ID)).toBe(record);
    // 枠で止まった印・取り直し中の印: Set 2 つは別の物で、前者は `UsageWake` へ渡る同じ Set
    expect(held.usageStopped).toBe(wake.usageStopped);
    expect(held.usageStopped).toBeInstanceOf(Set);
    expect(held.resuming).toBeInstanceOf(Set);
    expect(held.resuming).not.toBe(held.usageStopped);
    expect(held.resuming).not.toBe(wake.workerLimitStopped);
    // 引数で渡した物はそのまま
    expect(portsOf('AutoFold').runners).toBe(registry);
    expect(portsOf('RescueSweeper').stores).toBe(stores);
    expect(portsOf('ManagerRescueStash').stores).toBe(stores);
    // 共有の確かめ: 片方へ書くともう片方から見える
    (portsOf('HeldMessages').records as Map<string, unknown>).set('probe', 1);
    expect(records.has('probe')).toBe(true);
    expect((portsOf('RescueSweeper').records as Map<string, unknown>).get('probe')).toBe(1);
    expect((portsOf('ManagerRescueStash').records as Map<string, unknown>).has('probe')).toBe(true);
    expect((portsOf('DenialRenotifier').records as Map<string, unknown>).has('probe')).toBe(true);
    records.delete('probe');
    (wake.usageStopped as Set<string>).add('probe');
    expect((held.usageStopped as Set<string>).has('probe')).toBe(true);
    (wake.usageStopped as Set<string>).delete('probe');
  });

  it('attachmentLimits は欄の値をそのまま渡す（既定は未指定、注入すれば同じ物）', async () => {
    await open();
    expect(portsOf('ManagerRescueStash').attachmentLimits).toBeUndefined();
    const limits: AttachmentLimits = {
      maxImageBytes: 1,
      maxFileBytes: 2,
      maxLargeFileBytes: 3,
      maxPerMessage: 4,
      maxTotalBytes: 5,
      retentionDays: 6,
    };
    await open({ attachmentLimits: limits });
    expect(portsOf('ManagerRescueStash').attachmentLimits).toBe(limits);
  });

  it('取り直し中の印（resuming）は Pool が resume の間に立てる同じ Set（HeldMessages の口から見える）', async () => {
    const { pool, sent } = await open();
    const resuming = portsOf('HeldMessages').resuming as Set<string>;
    const before = resuming.has(JOB_ID);
    const result = await pool.send(JOB_ID, '起こして');
    await settle();
    // runner.resume が呼ばれた瞬間（Pool が印を立てている間）に、HeldMessages の口の Set にも印が見える
    expect({
      before,
      outcome: result.outcome,
      sent,
      after: resuming.has(JOB_ID),
    }).toMatchInlineSnapshot(`
      {
        "after": false,
        "before": false,
        "outcome": "delivered",
        "sent": [
          {
            "message": "[system] runner の器が作り直された。作業ディレクトリが残っているとは限らないので、続きに入る前に手元の状態を確かめよ。中断していた作業の続きを進めよ。",
            "resumingHeld": true,
            "via": "resume",
          },
          {
            "args": [
              "mgr-wiring-fold-held-pin",
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
        "AutoFold.now": [
          1793491200000,
          1793491212345,
        ],
        "DenialRenotifier.now": [
          1793491200000,
          1793491212345,
        ],
        "HeldMessages.now": [
          1793491200000,
          1793491212345,
        ],
        "HeldMessages.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
        "ManagerRescueStash.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
        "RescueSweeper.now": [
          1793491200000,
          1793491212345,
        ],
        "RescueSweeper.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
      }
    `);
  });

  it('stopped の口は Pool の止まった印を呼ぶ時に読む（stop() の後に変わる）', async () => {
    const { pool } = await open();
    const before = ['AutoFold', 'DenialRenotifier', 'RescueSweeper', 'HeldMessages'].map((name) =>
      fnOf(name, 'stopped')(),
    );
    await pool.stop();
    const after = ['AutoFold', 'DenialRenotifier', 'RescueSweeper', 'HeldMessages'].map((name) =>
      fnOf(name, 'stopped')(),
    );
    expect({ before, after }).toMatchInlineSnapshot(`
      {
        "after": [
          true,
          true,
          true,
          true,
        ],
        "before": [
          false,
          false,
          false,
          false,
        ],
      }
    `);
  });

  it('hello の名乗りを読む口（hasCapability / runnerHasCapability）は呼ぶたびに読み直す', async () => {
    const { pool, emit } = await open();
    const ports = [
      ['AutoFold', 'runnerHasCapability'],
      ['AttachmentStager', 'hasCapability'],
      ['ManagerRescueStash', 'runnerHasCapability'],
    ] as const;
    const before = ports.map(([name, key]) => fnOf(name, key)('runner-primary', 'probe-cap'));
    emit()?.({
      type: 'hello',
      runnerId: 'runner-primary',
      capabilities: ['probe-cap'],
    } as never);
    await settle();
    const after = ports.map(([name, key]) => fnOf(name, key)('runner-primary', 'probe-cap'));
    const other = ports.map(([name, key]) => fnOf(name, key)('runner-primary', 'other-cap'));
    expect({
      before,
      after,
      other,
      viaPool: pool.runnerHasCapability?.('runner-primary', 'probe-cap'),
    }).toMatchInlineSnapshot(`
      {
        "after": [
          true,
          true,
          true,
        ],
        "before": [
          false,
          false,
          false,
        ],
        "other": [
          false,
          false,
          false,
        ],
        "viaPool": true,
      }
    `);
  });

  it('AutoFold の口: Pool の公開メソッドへ引数をそのまま渡す（list / runnerIdOf / abort / observeUnpushedWork）', async () => {
    const { pool } = await open();
    const listed = Promise.resolve([]);
    const spyList = vi.spyOn(pool, 'list').mockReturnValue(listed as never);
    const spyRunnerIdOf = vi.spyOn(pool, 'runnerIdOf').mockResolvedValue('runner-x');
    const aborted = Promise.resolve({ outcome: 'stopped' });
    const spyAbort = vi.spyOn(pool, 'abort').mockReturnValue(aborted as never);
    const unpushed = Promise.resolve({ sentinel: true });
    const spyUnpushed = vi.spyOn(pool, 'unpushedWork').mockReturnValue(unpushed as never);
    const spyTimeout = vi.spyOn(AbortSignal, 'timeout');
    const via = {
      list: fnOf('AutoFold', 'list')(),
      runnerIdOf: await fnOf('AutoFold', 'runnerIdOf')(JOB_ID),
      abort: fnOf('AutoFold', 'abort')(JOB_ID, '畳む', { kind: 'auto-fold' }),
      unpushed: fnOf('AutoFold', 'observeUnpushedWork')(JOB_ID),
    };
    const timeoutArgs = spyTimeout.mock.calls.map((args) => args);
    const unpushedCall = spyUnpushed.mock.calls[0];
    spyTimeout.mockRestore();
    const calls = {
      list: spyList.mock.calls,
      runnerIdOf: spyRunnerIdOf.mock.calls,
      abort: spyAbort.mock.calls,
      unpushedId: unpushedCall?.[0],
      unpushedSource: (unpushedCall?.[1] as { source?: string } | undefined)?.source,
      unpushedSignalIsAbortSignal:
        (unpushedCall?.[1] as { signal?: unknown } | undefined)?.signal instanceof AbortSignal,
      unpushedKeys: Object.keys((unpushedCall?.[1] as object | undefined) ?? {}).sort(),
      timeoutArgs,
    };
    spyList.mockRestore();
    spyRunnerIdOf.mockRestore();
    spyAbort.mockRestore();
    spyUnpushed.mockRestore();
    // 同じ Promise をそのまま返す（async の皮で包まない）
    expect({
      listSame: via.list === listed,
      abortSame: via.abort === aborted,
      unpushedSame: via.unpushed === unpushed,
      runnerIdOf: via.runnerIdOf,
    }).toMatchInlineSnapshot(`
      {
        "abortSame": true,
        "listSame": true,
        "runnerIdOf": "runner-x",
        "unpushedSame": true,
      }
    `);
    expect(calls).toMatchInlineSnapshot(`
      {
        "abort": [
          [
            "mgr-wiring-fold-held-pin",
            "畳む",
            {
              "kind": "auto-fold",
            },
          ],
        ],
        "list": [
          [],
        ],
        "runnerIdOf": [
          [
            "mgr-wiring-fold-held-pin",
          ],
        ],
        "timeoutArgs": [
          [
            5000,
          ],
        ],
        "unpushedId": "mgr-wiring-fold-held-pin",
        "unpushedKeys": [
          "signal",
          "source",
        ],
        "unpushedSignalIsAbortSignal": true,
        "unpushedSource": "auto-fold",
      }
    `);
    expect(calls.timeoutArgs).toEqual([[UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS]]);
    expect(pool).toBeDefined();
  });

  it('AutoFold の口: findJob は台帳の委譲を引き、無ければ undefined', async () => {
    await open();
    const findJob = fnOf('AutoFold', 'findJob');
    const found = (await findJob(JOB_ID)) as { id: string } | undefined;
    expect({ id: found?.id, missing: await findJob('nobody') }).toMatchInlineSnapshot(`
      {
        "id": "mgr-wiring-fold-held-pin",
        "missing": undefined,
      }
    `);
  });

  it('journal の口（4 つ）は渡した記載をそのまま日誌へ書く', async () => {
    const { stores } = await open();
    const names = ['AutoFold', 'RescueSweeper', 'ManagerRescueStash', 'HeldMessages'];
    for (const name of names) {
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
          "decision": "HeldMessages の配線の確認",
          "grounds": "口から直に呼んだ",
        },
        {
          "decision": "ManagerRescueStash の配線の確認",
          "grounds": "口から直に呼んだ",
        },
        {
          "decision": "RescueSweeper の配線の確認",
          "grounds": "口から直に呼んだ",
        },
        {
          "decision": "AutoFold の配線の確認",
          "grounds": "口から直に呼んだ",
        },
      ]
    `);
  });

  it('journalExchange の口（DenialRenotifier）は exchange（with=manager）を日誌へ書き、Promise を返す', async () => {
    const { stores } = await open();
    const returned = fnOf('DenialRenotifier', 'journalExchange')('outbound', '拒否の知らせ直し');
    expect(returned).toBeInstanceOf(Promise);
    await returned;
    const hits = (await stores.journal.list({ types: ['exchange'] })).filter(
      (entry) => (entry as unknown as Record<string, unknown>).text === '拒否の知らせ直し',
    ) as unknown as Record<string, unknown>[];
    expect(hits.map((entry) => ({ with: entry.with, role: entry.role, text: entry.text })))
      .toMatchInlineSnapshot(`
        [
          {
            "role": "outbound",
            "text": "拒否の知らせ直し",
            "with": "manager",
          },
        ]
      `);
  });

  it('persist の口（3 つ）は像の updatedAt を時計で書き直して台帳へ書く', async () => {
    const { stores, clock, record } = await open();
    const out: Record<string, unknown> = {};
    for (const [i, name] of ['RescueSweeper', 'ManagerRescueStash', 'HeldMessages'].entries()) {
      clock.now = T0 + (i + 1) * 90_000;
      const returned = fnOf(name, 'persist')(record);
      expect(returned).toBeInstanceOf(Promise);
      await returned;
      const row = await stores.jobs.getJob(JOB_ID);
      out[name] = { updatedAt: record.job.updatedAt, stored: row?.updatedAt };
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "HeldMessages": {
          "stored": "2026-11-01T00:04:30.000Z",
          "updatedAt": "2026-11-01T00:04:30.000Z",
        },
        "ManagerRescueStash": {
          "stored": "2026-11-01T00:03:00.000Z",
          "updatedAt": "2026-11-01T00:03:00.000Z",
        },
        "RescueSweeper": {
          "stored": "2026-11-01T00:01:30.000Z",
          "updatedAt": "2026-11-01T00:01:30.000Z",
        },
      }
    `);
  });

  it('emitReport の口は合流窓の emit へ、(managerId, "report", 本文) の 3 引数だけを渡す', async () => {
    await open();
    const synthesized = instanceOf('SynthesizedNoticeWindows') as {
      emit: (...args: unknown[]) => void;
    };
    const calls: unknown[][] = [];
    const spyEmit = vi.spyOn(synthesized, 'emit').mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    const returned = fnOf('DenialRenotifier', 'emitReport')(JOB_ID, '知らせ直しの本文', 'extra');
    spyEmit.mockRestore();
    expect({ returned, calls }).toMatchInlineSnapshot(`
      {
        "calls": [
          [
            "mgr-wiring-fold-held-pin",
            "report",
            "知らせ直しの本文",
          ],
        ],
        "returned": undefined,
      }
    `);
  });

  it('queueNotice の口（HeldMessages）は合流窓の queue へ、渡した 3 引数をそのまま渡す', async () => {
    await open();
    const synthesized = instanceOf('SynthesizedNoticeWindows') as {
      queue: (...args: unknown[]) => void;
    };
    const calls: unknown[][] = [];
    const spyQueue = vi.spyOn(synthesized, 'queue').mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    const returned = fnOf('HeldMessages', 'queueNotice')(JOB_ID, 'resume_unconfirmed', '本文', 'x');
    spyQueue.mockRestore();
    expect({ returned, calls }).toMatchInlineSnapshot(`
      {
        "calls": [
          [
            "mgr-wiring-fold-held-pin",
            "resume_unconfirmed",
            "本文",
          ],
        ],
        "returned": undefined,
      }
    `);
  });

  it('load の口（HeldMessages・ManagerRescueStash）は像を返し、無ければ null', async () => {
    const { record } = await open();
    const out: Record<string, unknown> = {};
    for (const name of ['HeldMessages', 'ManagerRescueStash']) {
      const returned = fnOf(name, 'load')(JOB_ID);
      expect(returned).toBeInstanceOf(Promise);
      out[name] = {
        same: (await returned) === record,
        missing: await fnOf(name, 'load')('nobody'),
      };
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "HeldMessages": {
          "missing": null,
          "same": true,
        },
        "ManagerRescueStash": {
          "missing": null,
          "same": true,
        },
      }
    `);
  });

  it('見回りの口: runnerOf は台帳の runnerId の器を返し、runnersOrEmpty は名簿を返して読めなければ空', async () => {
    const { runner, record, registry } = await open();
    const viaRunnerOf = await fnOf('RescueSweeper', 'runnerOf')(record);
    const listed = (await fnOf('RescueSweeper', 'runnersOrEmpty')()) as unknown[];
    const failing = vi.spyOn(registry, 'list').mockRejectedValueOnce(new Error('読めない'));
    const empty = await fnOf('RescueSweeper', 'runnersOrEmpty')();
    failing.mockRestore();
    expect({
      runnerOfSame: viaRunnerOf === runner,
      listedSame: listed.length === 1 && listed[0] === runner,
      empty,
    }).toMatchInlineSnapshot(`
      {
        "empty": [],
        "listedSame": true,
        "runnerOfSame": true,
      }
    `);
  });

  it('預かりの口: runnerOrNull は器を返し、引けなければ null（皮で包まない）', async () => {
    const { runner, registry } = await open();
    const runnerOrNull = fnOf('ManagerRescueStash', 'runnerOrNull');
    const found = runnerOrNull('runner-primary');
    expect(found).toBeInstanceOf(Promise);
    const viaPort = await found;
    const missing = await runnerOrNull('runner-unknown');
    const failing = vi.spyOn(registry, 'get').mockRejectedValueOnce(new Error('読めない'));
    const failed = await runnerOrNull('runner-primary');
    failing.mockRestore();
    expect({ same: viaPort === runner, missing, failed }).toMatchInlineSnapshot(`
      {
        "failed": null,
        "missing": null,
        "same": true,
      }
    `);
  });

  it('預かりの口: instanceIdOf・swapNote は Pool の見たままを返す（同期）', async () => {
    await open();
    const instanceId = fnOf('ManagerRescueStash', 'instanceIdOf')('runner-primary');
    const unknownInstanceId = fnOf('ManagerRescueStash', 'instanceIdOf')('runner-unknown');
    const note = fnOf('ManagerRescueStash', 'swapNote')('runner-primary', undefined);
    const noteWithBefore = fnOf('ManagerRescueStash', 'swapNote')('runner-primary', 'inst-before');
    expect({ instanceId, unknownInstanceId, note, noteWithBefore }).toMatchInlineSnapshot(`
      {
        "instanceId": undefined,
        "note": "runner の器の入れ替えの前後かは判定できない（instanceId を名乗っていない）",
        "noteWithBefore": "runner の器の入れ替えの前後かは判定できない（instanceId を名乗っていない）",
        "unknownInstanceId": undefined,
      }
    `);
  });

  it('添付の口: awaitHello は hello を待つ Promise、openAttachment は呼ぶ時点の置き場へ id だけを渡す', async () => {
    const { stores, emit } = await open();
    // 名乗りを受けた器なら待たずに返る（受けていない器は実時間の待ちに入るので、ここでは使わない）
    emit()?.({ type: 'hello', runnerId: 'runner-primary', capabilities: [] } as never);
    await settle();
    const awaited = fnOf('AttachmentStager', 'awaitHello')('runner-primary');
    expect(awaited).toBeInstanceOf(Promise);
    const hello = await awaited;
    const sentinel = Promise.resolve(undefined);
    const spyOpen = vi.spyOn(stores.attachments, 'open').mockReturnValue(sentinel as never);
    const opened = fnOf('AttachmentStager', 'openAttachment')('att-1', 'extra');
    const calls = spyOpen.mock.calls;
    spyOpen.mockRestore();
    expect({ hello, openedSame: opened === sentinel, calls }).toMatchInlineSnapshot(`
      {
        "calls": [
          [
            "att-1",
          ],
        ],
        "hello": true,
        "openedSame": true,
      }
    `);
  });

  it('send の口: HeldMessages は届け方（delivery）を、ManagerRescueStash は { mode: "caller" } を Pool#send へ渡す', async () => {
    const { sent } = await open({
      heldMessages: [{ text: '預かりの先頭', heldAt: new Date(T0).toISOString(), reason: '試験' }],
    });
    // 預かりが在る委譲への送信は、`mode === 'caller'` なら列の後ろへ積まれ、`held-delivery` なら積まれずに届けへ進む。
    // 口の呼び出しの引数の順（managerId, 本文, 届け方 / オプション）も、引数が正しい位置に居ることで見分ける
    const delivery = {
      mode: 'held-delivery' as const,
      onFoldNoticeDelivered: () => undefined,
      pollRetry: false,
      onStuck: () => undefined,
    };
    const viaStash = (await fnOf('ManagerRescueStash', 'send')(JOB_ID, '預かりに積まれる', {})) as {
      outcome: string;
    };
    const afterStash = sent.splice(0);
    const viaHeld = (await fnOf('HeldMessages', 'send')(JOB_ID, '積まれずに進む', delivery)) as {
      outcome: string;
    };
    const afterHeld = sent.splice(0);
    const missingStash = (await fnOf('ManagerRescueStash', 'send')('nobody', 'x', {})) as {
      outcome: string;
    };
    const missingHeld = (await fnOf('HeldMessages', 'send')('nobody', 'x', delivery)) as {
      outcome: string;
    };
    expect({
      stash: { outcome: viaStash.outcome, runner: afterStash },
      held: { outcome: viaHeld.outcome, runner: afterHeld },
      missingStash: missingStash.outcome,
      missingHeld: missingHeld.outcome,
    }).toMatchInlineSnapshot(`
      {
        "held": {
          "outcome": "delivered",
          "runner": [
            {
              "args": [
                "mgr-wiring-fold-held-pin",
                "積まれずに進む",
              ],
              "via": "send",
            },
          ],
        },
        "missingHeld": "unknown",
        "missingStash": "unknown",
        "stash": {
          "outcome": "delivered",
          "runner": [
            {
              "message": "[system] runner の器が作り直された。作業ディレクトリが残っているとは限らないので、続きに入る前に手元の状態を確かめよ。中断していた作業の続きを進めよ。",
              "resumingHeld": true,
              "via": "resume",
            },
            {
              "args": [
                "mgr-wiring-fold-held-pin",
                "（alteroid が預かっていた伝言 2 通。そのときは届けられなかったので、送られた順にまとめていま届ける）

      --- 1通目（2026-11-01T00:00:00.000Z に送られた）---
      預かりの先頭

      --- 2通目（2026-11-01T00:00:00.000Z に送られた）---
      預かりに積まれる",
              ],
              "via": "send",
            },
          ],
        },
      }
    `);
  });

  it('send の口: 渡した options と delivery は Pool#send の正しい位置へ届く', async () => {
    const delivery = {
      mode: 'caller' as const,
      onFoldNoticeDelivered: () => undefined,
      pollRetry: false,
      onStuck: () => undefined,
    };
    // HeldMessages の口へ mode: 'caller' を渡すと、預かりの在る委譲では列に積まれる（4 番目の引数が delivery のまま届いている）
    const withHeld = await open({
      heldMessages: [{ text: '預かりの先頭', heldAt: new Date(T0).toISOString(), reason: '試験' }],
    });
    const viaHeld = (await fnOf('HeldMessages', 'send')(
      JOB_ID,
      '呼び手の mode で積まれる',
      delivery,
    )) as {
      outcome: string;
    };
    // ManagerRescueStash の口へ渡した options は、そのまま 3 番目の引数へ届く（未決の確認が無いのに requestId を付けると断られる）
    const plain = await open();
    const viaStash = (await fnOf('ManagerRescueStash', 'send')(JOB_ID, '確認への回答', {
      requestId: 'req-none',
      decision: 'allow',
    })) as { outcome: string; detail?: string };
    const withoutOptions = (await fnOf('ManagerRescueStash', 'send')(JOB_ID, '素の送信', {})) as {
      outcome: string;
    };
    expect({
      held: { outcome: viaHeld.outcome, runner: withHeld.sent },
      stashWithRequestId: { outcome: viaStash.outcome, detail: viaStash.detail },
      stashWithoutOptions: withoutOptions.outcome,
      plainRunner: plain.sent.length,
    }).toMatchInlineSnapshot(`
      {
        "held": {
          "outcome": "delivered",
          "runner": [
            {
              "message": "[system] runner の器が作り直された。作業ディレクトリが残っているとは限らないので、続きに入る前に手元の状態を確かめよ。中断していた作業の続きを進めよ。",
              "resumingHeld": true,
              "via": "resume",
            },
            {
              "args": [
                "mgr-wiring-fold-held-pin",
                "（alteroid が預かっていた伝言 2 通。そのときは届けられなかったので、送られた順にまとめていま届ける）

      --- 1通目（2026-11-01T00:00:00.000Z に送られた）---
      預かりの先頭

      --- 2通目（2026-11-01T00:00:00.000Z に送られた）---
      呼び手の mode で積まれる",
              ],
              "via": "send",
            },
          ],
        },
        "plainRunner": 2,
        "stashWithRequestId": {
          "detail": "req-none という確認は mgr-wiring-fold-held-pin で待っていない（既に解けたか、別のマネージャーのもの）。",
          "outcome": "unknown",
        },
        "stashWithoutOptions": "delivered",
      }
    `);
  });

  it('同期の口は Promise を返さない（async の皮で包まない）', async () => {
    const { record } = await open();
    const calls: Record<string, [string, unknown[]][]> = {
      AutoFold: [
        ['now', []],
        ['stopped', []],
        ['retainedIds', []],
        ['runnerHasCapability', ['runner-primary', 'c']],
      ],
      DenialRenotifier: [
        ['now', []],
        ['stopped', []],
        ['emitReport', [JOB_ID, 'x']],
      ],
      RescueSweeper: [
        ['now', []],
        ['nowIso', []],
        ['stopped', []],
      ],
      AttachmentStager: [['hasCapability', ['runner-primary', 'c']]],
      ManagerRescueStash: [
        ['nowIso', []],
        ['runnerHasCapability', ['runner-primary', 'c']],
        ['instanceIdOf', ['runner-primary']],
        ['swapNote', ['runner-primary', undefined]],
      ],
      HeldMessages: [
        ['now', []],
        ['nowIso', []],
        ['stopped', []],
        ['queueNotice', [JOB_ID, 'resume_unconfirmed', 'x']],
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
    expect(record.job.id).toBe(JOB_ID);
    expect(returned).toMatchInlineSnapshot(`
      {
        "AttachmentStager": {
          "hasCapability": false,
        },
        "AutoFold": {
          "now": false,
          "retainedIds": false,
          "runnerHasCapability": false,
          "stopped": false,
        },
        "DenialRenotifier": {
          "emitReport": false,
          "now": false,
          "stopped": false,
        },
        "HeldMessages": {
          "now": false,
          "nowIso": false,
          "queueNotice": false,
          "stopped": false,
        },
        "ManagerRescueStash": {
          "instanceIdOf": false,
          "nowIso": false,
          "runnerHasCapability": false,
          "swapNote": false,
        },
        "RescueSweeper": {
          "now": false,
          "nowIso": false,
          "stopped": false,
        },
      }
    `);
  });

  it('非同期の口が解けるまでの microtask の周回数（皮を足すと増える）', async () => {
    const { record, emit } = await open();
    emit()?.({ type: 'hello', runnerId: 'runner-primary', capabilities: [] } as never);
    await settle();
    const hops: Record<string, Record<string, number>> = {};
    const mark = async (name: string, key: string, promise: Promise<unknown>) => {
      (hops[name] ??= {})[key] = await hopsOf(promise);
    };
    const decision = { type: 'decision', decision: 'd', grounds: 'g' };
    await mark('AutoFold', 'findJob', fnOf('AutoFold', 'findJob')(JOB_ID) as Promise<unknown>);
    await mark(
      'AutoFold',
      'runnerIdOf',
      fnOf('AutoFold', 'runnerIdOf')(JOB_ID) as Promise<unknown>,
    );
    await mark('AutoFold', 'list', fnOf('AutoFold', 'list')() as Promise<unknown>);
    await mark('AutoFold', 'journal', fnOf('AutoFold', 'journal')(decision) as Promise<unknown>);
    await mark(
      'DenialRenotifier',
      'journalExchange',
      fnOf('DenialRenotifier', 'journalExchange')('inbound', 'x') as Promise<unknown>,
    );
    await mark(
      'RescueSweeper',
      'journal',
      fnOf('RescueSweeper', 'journal')(decision) as Promise<unknown>,
    );
    await mark(
      'RescueSweeper',
      'persist',
      fnOf('RescueSweeper', 'persist')(record) as Promise<unknown>,
    );
    await mark(
      'RescueSweeper',
      'runnerOf',
      fnOf('RescueSweeper', 'runnerOf')(record) as Promise<unknown>,
    );
    await mark(
      'RescueSweeper',
      'runnersOrEmpty',
      fnOf('RescueSweeper', 'runnersOrEmpty')() as Promise<unknown>,
    );
    await mark(
      'AttachmentStager',
      'awaitHello',
      fnOf('AttachmentStager', 'awaitHello')('runner-primary') as Promise<unknown>,
    );
    await mark(
      'AttachmentStager',
      'openAttachment',
      fnOf('AttachmentStager', 'openAttachment')('att-none') as Promise<unknown>,
    );
    await mark(
      'ManagerRescueStash',
      'runnerOrNull',
      fnOf('ManagerRescueStash', 'runnerOrNull')('runner-primary') as Promise<unknown>,
    );
    await mark(
      'ManagerRescueStash',
      'persist',
      fnOf('ManagerRescueStash', 'persist')(record) as Promise<unknown>,
    );
    await mark(
      'ManagerRescueStash',
      'journal',
      fnOf('ManagerRescueStash', 'journal')(decision) as Promise<unknown>,
    );
    await mark(
      'ManagerRescueStash',
      'load',
      fnOf('ManagerRescueStash', 'load')(JOB_ID) as Promise<unknown>,
    );
    await mark(
      'ManagerRescueStash',
      'send',
      fnOf('ManagerRescueStash', 'send')('nobody', 'x', {}) as Promise<unknown>,
    );
    await mark('HeldMessages', 'load', fnOf('HeldMessages', 'load')(JOB_ID) as Promise<unknown>);
    await mark(
      'HeldMessages',
      'persist',
      fnOf('HeldMessages', 'persist')(record) as Promise<unknown>,
    );
    await mark(
      'HeldMessages',
      'journal',
      fnOf('HeldMessages', 'journal')(decision) as Promise<unknown>,
    );
    await mark(
      'HeldMessages',
      'send',
      fnOf('HeldMessages', 'send')('nobody', 'x', {
        mode: 'held-delivery',
        onFoldNoticeDelivered: () => undefined,
        pollRetry: false,
        onStuck: () => undefined,
      }) as Promise<unknown>,
    );
    expect(hops).toMatchInlineSnapshot(`
      {
        "AttachmentStager": {
          "awaitHello": 1,
          "openAttachment": 2,
        },
        "AutoFold": {
          "findJob": 2,
          "journal": 2,
          "list": 9,
          "runnerIdOf": 1,
        },
        "DenialRenotifier": {
          "journalExchange": 2,
        },
        "HeldMessages": {
          "journal": 2,
          "load": 3,
          "persist": 3,
          "send": 13,
        },
        "ManagerRescueStash": {
          "journal": 2,
          "load": 3,
          "persist": 3,
          "runnerOrNull": 2,
          "send": 13,
        },
        "RescueSweeper": {
          "journal": 2,
          "persist": 3,
          "runnerOf": 3,
          "runnersOrEmpty": 2,
        },
      }
    `);
  });
});
