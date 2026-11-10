import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerRecord } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

// `Pool` の `constructor` のうち、受け手 6 種（`ManagerSelfFencedReceiver`・`ManagerClosedFrontReceiver`・`ManagerReportApply`・
// `ManagerClosedApply`・`ManagerClosedNotice`・`ManagerNoteReceiver`）を作って口（ports）を渡す部分の「配線」を、外から縛る。
// 切り出し（協力者を作る関数へ減らす）の前の pin。振る舞いそのものは各クラスの pin（manager-self-fenced-pin ほか）が縛っている。
// ここが縛るのは次の 4 つ:
//   - 6 つが何個・どの順で作られるか（前後の協力者との相対順も含む）
//   - 渡る ports の欄の全部（欄名・関数か値か）
//   - 共有参照（`usageStopped` などの Set/Map、`withheld`・`synthesized`）が `Pool` の持つ同じ物（`toBe`）で、コピーでないこと
//   - 関数の口を呼ぶと `Pool` の側で引き直した結果になること（時計の差し替えに追随する・引数を取りこぼさない・async の皮で包まない）
// 期待の文字列・数は、いまの作りの出力から `-u` で生成して目で読んで写したもの（仕様を先に書いたものではない）。
// 実時間では待たない: 時計は注入し、タイマーは fake にする。

const spy = vi.hoisted(() => {
  const order: string[] = [];
  const calls: { name: string; ports: Record<string, unknown>; instance: object }[] = [];
  function wrap<C>(name: string, Base: C): C {
    const Original = Base as unknown as new (ports: Record<string, unknown>) => object;
    class Recorder extends Original {
      constructor(ports: Record<string, unknown>) {
        super(ports);
        order.push(name);
        calls.push({ name, ports, instance: this });
      }
    }
    return Recorder as unknown as C;
  }
  return {
    order,
    calls,
    wrap,
    reset(): void {
      order.length = 0;
      calls.length = 0;
    },
  };
});

vi.mock('./withheld-reports-store.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./withheld-reports-store.js')>();
  return {
    ...mod,
    WithheldReportsStore: spy.wrap('WithheldReportsStore', mod.WithheldReportsStore),
  };
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
vi.mock('./usage-receiver.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./usage-receiver.js')>();
  return { ...mod, UsageReceiver: spy.wrap('UsageReceiver', mod.UsageReceiver) };
});
vi.mock('./manager-denial.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-denial.js')>();
  return {
    ...mod,
    ManagerDenialReceiver: spy.wrap('ManagerDenialReceiver', mod.ManagerDenialReceiver),
  };
});
vi.mock('./manager-waiting.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-waiting.js')>();
  return {
    ...mod,
    ManagerWaitingReceiver: spy.wrap('ManagerWaitingReceiver', mod.ManagerWaitingReceiver),
  };
});
vi.mock('./manager-self-fenced.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-self-fenced.js')>();
  return {
    ...mod,
    ManagerSelfFencedReceiver: spy.wrap('ManagerSelfFencedReceiver', mod.ManagerSelfFencedReceiver),
  };
});
vi.mock('./manager-closed-front.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-closed-front.js')>();
  return {
    ...mod,
    ManagerClosedFrontReceiver: spy.wrap(
      'ManagerClosedFrontReceiver',
      mod.ManagerClosedFrontReceiver,
    ),
  };
});
vi.mock('./manager-report-apply.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-report-apply.js')>();
  return { ...mod, ManagerReportApply: spy.wrap('ManagerReportApply', mod.ManagerReportApply) };
});
vi.mock('./manager-closed-apply.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-closed-apply.js')>();
  return { ...mod, ManagerClosedApply: spy.wrap('ManagerClosedApply', mod.ManagerClosedApply) };
});
vi.mock('./manager-closed-notice.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-closed-notice.js')>();
  return { ...mod, ManagerClosedNotice: spy.wrap('ManagerClosedNotice', mod.ManagerClosedNotice) };
});
vi.mock('./manager-note.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-note.js')>();
  return { ...mod, ManagerNoteReceiver: spy.wrap('ManagerNoteReceiver', mod.ManagerNoteReceiver) };
});

const JOB_ID = 'mgr-wiring-tail-pin';
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

/** 対象の 6 つ（`manager.ts` の構築順）。 */
const TAIL = [
  'ManagerSelfFencedReceiver',
  'ManagerClosedFrontReceiver',
  'ManagerReportApply',
  'ManagerClosedApply',
  'ManagerClosedNotice',
  'ManagerNoteReceiver',
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

/** Pool を 1 つ作り、委譲 1 件を台帳から像へ戻して返す。時計は `clock.now` を読む。 */
async function open() {
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
  const inbox: unknown[] = [];
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
      inbox.push(event);
    },
    runners: createRunnerRegistry([runner]),
  });
  // 構築の記録は restore の前に取り出す（restore が協力者を作り直さないことも確かめるため、数は後でもう一度見る）
  const constructed = [...spy.order];
  await pool.restore();
  await settle();
  const records = portsOf('WithheldReportsStore').records as Map<string, ManagerRecord>;
  const record = records.get(JOB_ID);
  if (record === undefined) throw new Error('像が作られていない');
  return { pool, stores, clock, inbox, records, record, constructed, emit: () => emit };
}

/** `promise` が解けるまでの microtask の周回数（上限 200 で -1）。 */
async function hopsOf(promise: Promise<unknown>): Promise<number> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  for (let i = 0; i <= 200; i += 1) {
    if (done) return i;
    await Promise.resolve();
  }
  return -1;
}

describe('Pool の constructor の配線: 受け手 6 種', () => {
  it('作られる協力者と順（前後の協力者との相対順を含む）と数', async () => {
    const { constructed } = await open();
    expect(constructed).toMatchInlineSnapshot(`
      [
        "WithheldReportsStore",
        "SynthesizedNoticeWindows",
        "UsageWake",
        "UsageReceiver",
        "ManagerDenialReceiver",
        "ManagerWaitingReceiver",
        "ManagerSelfFencedReceiver",
        "ManagerClosedFrontReceiver",
        "ManagerReportApply",
        "ManagerClosedApply",
        "ManagerClosedNotice",
        "ManagerNoteReceiver",
      ]
    `);
    expect(spy.order).toEqual(constructed);
    // 6 つは連続して、この順に 1 回ずつ
    const start = constructed.indexOf(TAIL[0]);
    expect(constructed.slice(start, start + TAIL.length)).toEqual([...TAIL]);
    expect(TAIL.map((name) => constructed.filter((entry) => entry === name).length)).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
  });

  it('渡る ports の欄と、欄が関数か値か', async () => {
    await open();
    const shape = Object.fromEntries(
      TAIL.map((name) => [
        name,
        Object.fromEntries(
          Object.entries(portsOf(name)).map(([key, value]) => [
            key,
            typeof value === 'function'
              ? 'function'
              : value instanceof Map
                ? 'Map'
                : value instanceof Set
                  ? 'Set'
                  : value === null
                    ? 'null'
                    : 'object',
          ]),
        ),
      ]),
    );
    expect(shape).toMatchInlineSnapshot(`
      {
        "ManagerClosedApply": {
          "now": "function",
          "nowIso": "function",
          "withdrawWaiting": "function",
        },
        "ManagerClosedFrontReceiver": {
          "emit": "function",
          "journalExchange": "function",
          "nowIso": "function",
          "persist": "function",
          "retire": "function",
        },
        "ManagerClosedNotice": {
          "emit": "function",
          "journalExchange": "function",
          "persist": "function",
          "queueSynthesizedNotice": "function",
          "synthesized": "object",
          "withheld": "object",
        },
        "ManagerNoteReceiver": {
          "emit": "function",
          "journal": "function",
          "journalExchange": "function",
          "persist": "function",
          "tokenIdentities": "Map",
          "workerLimitStopped": "Map",
        },
        "ManagerReportApply": {
          "nowIso": "function",
          "resetTimeSkewMatches": "Map",
          "usageStopped": "Set",
        },
        "ManagerSelfFencedReceiver": {
          "emit": "function",
          "journalExchange": "function",
          "now": "function",
          "persist": "function",
          "scheduleReattach": "function",
          "withdrawWaiting": "function",
        },
      }
    `);
  });

  it('共有参照は Pool の持つ同じ物（コピーでない）', async () => {
    await open();
    const wake = portsOf('UsageWake');
    const receiver = portsOf('UsageReceiver');
    const reportApply = portsOf('ManagerReportApply');
    const note = portsOf('ManagerNoteReceiver');
    const notice = portsOf('ManagerClosedNotice');
    // 参照の出どころは、同じ `Pool` が別の協力者へも渡している物（`UsageWake` / `UsageReceiver`）と、作られた協力者の実体
    expect(reportApply.usageStopped).toBe(wake.usageStopped);
    expect(reportApply.usageStopped).toBe(receiver.usageStopped);
    expect(reportApply.resetTimeSkewMatches).toBe(wake.resetTimeSkewMatches);
    expect(note.workerLimitStopped).toBe(wake.workerLimitStopped);
    expect(note.tokenIdentities).toBe(wake.tokenIdentities);
    expect(note.tokenIdentities).toBe(receiver.tokenIdentities);
    expect(notice.withheld).toBe(instanceOf('WithheldReportsStore'));
    expect(notice.synthesized).toBe(instanceOf('SynthesizedNoticeWindows'));
    // 種類
    expect(reportApply.usageStopped).toBeInstanceOf(Set);
    expect(reportApply.resetTimeSkewMatches).toBeInstanceOf(Map);
    expect(note.workerLimitStopped).toBeInstanceOf(Map);
    expect(note.tokenIdentities).toBeInstanceOf(Map);
    // 共有の確かめ: 片方へ書くともう片方から見える
    (reportApply.usageStopped as Set<string>).add('probe');
    expect((wake.usageStopped as Set<string>).has('probe')).toBe(true);
    (note.workerLimitStopped as Map<string, unknown>).set('probe', 1);
    expect((wake.workerLimitStopped as Map<string, unknown>).get('probe')).toBe(1);
    // 別々の欄は別の物（取り違えを検出する）
    expect(reportApply.usageStopped).not.toBe(wake.workerLimitStopped);
    expect(note.workerLimitStopped).not.toBe(wake.usageStopped);
    expect(note.tokenIdentities).not.toBe(reportApply.resetTimeSkewMatches);
  });

  it('時計の口は呼ぶたびに注入した時計を引き直す（構築時の値のコピーでない）', async () => {
    const { clock } = await open();
    const seen: Record<string, unknown[]> = {};
    for (const name of TAIL) {
      const ports = portsOf(name);
      if (typeof ports.now === 'function') {
        clock.now = T0;
        const first = (ports.now as Fn)();
        clock.now = T0 + 12_345;
        seen[`${name}.now`] = [first, (ports.now as Fn)()];
      }
      if (typeof ports.nowIso === 'function') {
        clock.now = T0;
        const first = (ports.nowIso as Fn)();
        clock.now = T0 + 12_345;
        seen[`${name}.nowIso`] = [first, (ports.nowIso as Fn)()];
      }
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "ManagerClosedApply.now": [
          1793491200000,
          1793491212345,
        ],
        "ManagerClosedApply.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
        "ManagerClosedFrontReceiver.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
        "ManagerReportApply.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
        "ManagerSelfFencedReceiver.now": [
          1793491200000,
          1793491212345,
        ],
      }
    `);
  });

  it('journalExchange の口は exchange（with=manager）を日誌へ書き、Promise を返す', async () => {
    const { stores } = await open();
    const wrote: Record<string, unknown> = {};
    for (const name of TAIL) {
      const ports = portsOf(name);
      if (typeof ports.journalExchange !== 'function') continue;
      const text = `${name} の呼び出し`;
      const returned = (ports.journalExchange as Fn)('outbound', text);
      expect(returned).toBeInstanceOf(Promise);
      await returned;
      // 日誌の並びに頼らず、本文で引く
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
        "ManagerClosedFrontReceiver": {
          "added": 1,
          "role": "outbound",
          "text": "ManagerClosedFrontReceiver の呼び出し",
          "with": "manager",
        },
        "ManagerClosedNotice": {
          "added": 1,
          "role": "outbound",
          "text": "ManagerClosedNotice の呼び出し",
          "with": "manager",
        },
        "ManagerNoteReceiver": {
          "added": 1,
          "role": "outbound",
          "text": "ManagerNoteReceiver の呼び出し",
          "with": "manager",
        },
        "ManagerSelfFencedReceiver": {
          "added": 1,
          "role": "outbound",
          "text": "ManagerSelfFencedReceiver の呼び出し",
          "with": "manager",
        },
      }
    `);
  });

  it('journal の口（Note）は渡した記載をそのまま日誌へ書く', async () => {
    const { stores } = await open();
    await fnOf(
      'ManagerNoteReceiver',
      'journal',
    )({
      type: 'decision',
      decision: '配線の確認',
      grounds: '口から直に呼んだ',
    });
    const hits = (await stores.journal.list({ types: ['decision'] })).filter(
      (entry) => (entry as unknown as Record<string, unknown>).decision === '配線の確認',
    ) as unknown as Record<string, unknown>[];
    expect(hits.map((entry) => ({ decision: entry.decision, grounds: entry.grounds })))
      .toMatchInlineSnapshot(`
      [
        {
          "decision": "配線の確認",
          "grounds": "口から直に呼んだ",
        },
      ]
    `);
  });

  it('persist の口は像の updatedAt を時計で書き直して台帳へ書く', async () => {
    const { stores, clock, record } = await open();
    const out: Record<string, unknown> = {};
    for (const [index, name] of TAIL.entries()) {
      const ports = portsOf(name);
      if (typeof ports.persist !== 'function') continue;
      clock.now = T0 + (index + 1) * 60_000;
      const returned = (ports.persist as Fn)(record);
      expect(returned).toBeInstanceOf(Promise);
      await returned;
      const row = await stores.jobs.getJob(JOB_ID);
      out[name] = { updatedAt: record.job.updatedAt, stored: row?.updatedAt };
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "ManagerClosedFrontReceiver": {
          "stored": "2026-11-01T00:02:00.000Z",
          "updatedAt": "2026-11-01T00:02:00.000Z",
        },
        "ManagerClosedNotice": {
          "stored": "2026-11-01T00:05:00.000Z",
          "updatedAt": "2026-11-01T00:05:00.000Z",
        },
        "ManagerNoteReceiver": {
          "stored": "2026-11-01T00:06:00.000Z",
          "updatedAt": "2026-11-01T00:06:00.000Z",
        },
        "ManagerSelfFencedReceiver": {
          "stored": "2026-11-01T00:01:00.000Z",
          "updatedAt": "2026-11-01T00:01:00.000Z",
        },
      }
    `);
  });

  it('emit の口は合流窓の emit へ、渡した引数をそのまま（9 引数まで）渡す', async () => {
    await open();
    const synthesized = instanceOf('SynthesizedNoticeWindows') as {
      emit: (...args: unknown[]) => void;
    };
    const calls: unknown[][] = [];
    const spyEmit = vi.spyOn(synthesized, 'emit').mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    const files = { attachments: [], rejected: [] };
    const fold = { sinceMs: 1 };
    const returns: Record<string, unknown> = {};
    for (const name of TAIL) {
      const ports = portsOf(name);
      if (typeof ports.emit !== 'function') continue;
      returns[name] = (ports.emit as Fn)(
        JOB_ID,
        'report',
        `${name} の本文`,
        'req-1',
        'markup',
        'flush',
        true,
        files,
        fold,
      );
    }
    spyEmit.mockRestore();
    expect(returns).toMatchInlineSnapshot(`
      {
        "ManagerClosedFrontReceiver": undefined,
        "ManagerClosedNotice": undefined,
        "ManagerNoteReceiver": undefined,
        "ManagerSelfFencedReceiver": undefined,
      }
    `);
    // 呼んだ順は SelfFenced・ClosedFront（3 引数だけ渡す）・ClosedNotice・Note（9 引数を全部渡す）
    expect(calls.map((args) => args.length)).toMatchInlineSnapshot(`
      [
        3,
        3,
        9,
        9,
      ]
    `);
    // 参照で渡るものは同一参照のまま（複製しない）
    expect(calls.slice(2).map((args) => [args[7] === files, args[8] === fold])).toEqual([
      [true, true],
      [true, true],
    ]);
    expect(calls).toMatchInlineSnapshot(`
      [
        [
          "mgr-wiring-tail-pin",
          "report",
          "ManagerSelfFencedReceiver の本文",
        ],
        [
          "mgr-wiring-tail-pin",
          "report",
          "ManagerClosedFrontReceiver の本文",
        ],
        [
          "mgr-wiring-tail-pin",
          "report",
          "ManagerClosedNotice の本文",
          "req-1",
          "markup",
          "flush",
          true,
          {
            "attachments": [],
            "rejected": [],
          },
          {
            "sinceMs": 1,
          },
        ],
        [
          "mgr-wiring-tail-pin",
          "report",
          "ManagerNoteReceiver の本文",
          "req-1",
          "markup",
          "flush",
          true,
          {
            "attachments": [],
            "rejected": [],
          },
          {
            "sinceMs": 1,
          },
        ],
      ]
    `);
  });

  it('queueSynthesizedNotice の口は合流窓の queue へ、渡した引数をそのまま渡す', async () => {
    await open();
    const synthesized = instanceOf('SynthesizedNoticeWindows') as {
      queue: (...args: unknown[]) => void;
    };
    const calls: unknown[][] = [];
    const spyQueue = vi.spyOn(synthesized, 'queue').mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    const quota = { tokenKey: 'tok' };
    const returns: Record<string, unknown> = {};
    const ports = portsOf('ManagerClosedNotice');
    returns.ManagerClosedNotice = (ports.queueSynthesizedNotice as Fn)(
      JOB_ID,
      'resume_failed',
      '本文',
      quota,
    );
    spyQueue.mockRestore();
    expect(returns).toMatchInlineSnapshot(`
      {
        "ManagerClosedNotice": undefined,
      }
    `);
    expect(calls[0]?.[3]).toBe(quota);
    expect(calls).toMatchInlineSnapshot(`
      [
        [
          "mgr-wiring-tail-pin",
          "resume_failed",
          "本文",
          {
            "tokenKey": "tok",
          },
        ],
      ]
    `);
  });

  it('withdrawWaiting の口は待ちを空にして日誌へ取り下げを書く（同期で undefined を返す）', async () => {
    const { stores, record } = await open();
    const out: Record<string, unknown> = {};
    for (const name of TAIL) {
      const ports = portsOf(name);
      if (typeof ports.withdrawWaiting !== 'function') continue;
      record.waiting = [
        {
          requestId: `req-${name}`,
          summary: `${name} の確認`,
          kind: 'question',
          askedAt: '2026-11-01T00:00:00.000Z',
        },
      ];
      const returned = (ports.withdrawWaiting as Fn)(record, `${name} の理由`);
      await settle();
      const hits = (await stores.journal.list({ types: ['escalation'] })).filter(
        (entry) => (entry as unknown as Record<string, unknown>).approvalId === `req-${name}`,
      ) as unknown as Record<string, unknown>[];
      out[name] = {
        returned,
        waitingAfter: record.waiting.length,
        written: hits.map((entry) => entry.withdrawnReason),
      };
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "ManagerClosedApply": {
          "returned": undefined,
          "waitingAfter": 0,
          "written": [
            "この確認への答えは届かない（ManagerClosedApply の理由）",
          ],
        },
        "ManagerSelfFencedReceiver": {
          "returned": undefined,
          "waitingAfter": 0,
          "written": [
            "この確認への答えは届かない（ManagerSelfFencedReceiver の理由）",
          ],
        },
      }
    `);
  });

  it('scheduleReattach の口は再挑戦の予約を 1 本だけ立てる（同期で undefined を返す）', async () => {
    await open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const schedule = fnOf('ManagerSelfFencedReceiver', 'scheduleReattach');
      const before = vi.getTimerCount();
      const first = schedule('runner-primary');
      const afterFirst = vi.getTimerCount();
      const second = schedule('runner-primary');
      const afterSecond = vi.getTimerCount();
      schedule('runner-other');
      const afterOther = vi.getTimerCount();
      expect({ before, first, afterFirst, second, afterSecond, afterOther }).toMatchInlineSnapshot(`
        {
          "afterFirst": 1,
          "afterOther": 2,
          "afterSecond": 1,
          "before": 0,
          "first": undefined,
          "second": undefined,
        }
      `);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('retire の口は像を外し、その担当の拒否の数えも消える', async () => {
    const { pool, records, emit } = await open();
    emit()?.({
      type: 'permission_denied',
      managerId: JOB_ID,
      toolUseId: 'tu-1',
      tool: 'Bash',
      via: 'result',
    } as never);
    await settle();
    const before = { hasRecord: records.has(JOB_ID), denials: pool.denials(JOB_ID).length };
    const returned = fnOf('ManagerClosedFrontReceiver', 'retire')(JOB_ID);
    const after = { hasRecord: records.has(JOB_ID), denials: pool.denials(JOB_ID).length };
    expect({ before, returned, after }).toMatchInlineSnapshot(`
      {
        "after": {
          "denials": 0,
          "hasRecord": false,
        },
        "before": {
          "denials": 1,
          "hasRecord": true,
        },
        "returned": undefined,
      }
    `);
  });

  it('同期の口は Promise を返さない（async の皮で包まない）', async () => {
    const { record, clock } = await open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const returned: Record<string, unknown> = {};
    try {
      for (const name of TAIL) {
        const ports = portsOf(name);
        const entries: Record<string, boolean> = {};
        const sync: [string, unknown[]][] = [
          ['now', []],
          ['nowIso', []],
          ['emit', [JOB_ID, 'report', 'x']],
          ['retire', ['no-such-manager']],
          ['scheduleReattach', ['runner-sync']],
          ['withdrawWaiting', [record, 'x']],
          ['queueSynthesizedNotice', [JOB_ID, 'resume_failed', 'x']],
        ];
        for (const [key, args] of sync) {
          const fn = ports[key];
          if (typeof fn === 'function') entries[key] = (fn as Fn)(...args) instanceof Promise;
        }
        returned[name] = entries;
      }
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
    clock.now = T0;
    expect(returned).toMatchInlineSnapshot(`
      {
        "ManagerClosedApply": {
          "now": false,
          "nowIso": false,
          "withdrawWaiting": false,
        },
        "ManagerClosedFrontReceiver": {
          "emit": false,
          "nowIso": false,
          "retire": false,
        },
        "ManagerClosedNotice": {
          "emit": false,
          "queueSynthesizedNotice": false,
        },
        "ManagerNoteReceiver": {
          "emit": false,
        },
        "ManagerReportApply": {
          "nowIso": false,
        },
        "ManagerSelfFencedReceiver": {
          "emit": false,
          "now": false,
          "scheduleReattach": false,
          "withdrawWaiting": false,
        },
      }
    `);
  });

  it('非同期の口が解けるまでの microtask の周回数（皮を足すと増える）', async () => {
    const { record } = await open();
    const hops: Record<string, Record<string, number>> = {};
    for (const name of TAIL) {
      const ports = portsOf(name);
      const entry: Record<string, number> = {};
      if (typeof ports.persist === 'function')
        entry.persist = await hopsOf((ports.persist as Fn)(record) as Promise<unknown>);
      if (typeof ports.journalExchange === 'function') {
        entry.journalExchange = await hopsOf(
          (ports.journalExchange as Fn)('inbound', 'x') as Promise<unknown>,
        );
      }
      if (typeof ports.journal === 'function') {
        entry.journal = await hopsOf(
          (ports.journal as Fn)({
            type: 'decision',
            decision: 'd',
            grounds: 'g',
          }) as Promise<unknown>,
        );
      }
      hops[name] = entry;
    }
    expect(hops).toMatchInlineSnapshot(`
      {
        "ManagerClosedApply": {},
        "ManagerClosedFrontReceiver": {
          "journalExchange": 2,
          "persist": 3,
        },
        "ManagerClosedNotice": {
          "journalExchange": 2,
          "persist": 3,
        },
        "ManagerNoteReceiver": {
          "journal": 2,
          "journalExchange": 2,
          "persist": 3,
        },
        "ManagerReportApply": {},
        "ManagerSelfFencedReceiver": {
          "journalExchange": 2,
          "persist": 3,
        },
      }
    `);
  });

  it('口の関数の名前（journalExchange は bind、ほかは束ねた無名の関数）', async () => {
    await open();
    const names = Object.fromEntries(
      TAIL.map((name) => [
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
        "ManagerClosedApply": {
          "now": "now/0",
          "nowIso": "nowIso/0",
          "withdrawWaiting": "withdrawWaiting/2",
        },
        "ManagerClosedFrontReceiver": {
          "emit": "emit/3",
          "journalExchange": "bound #journalExchange/2",
          "nowIso": "nowIso/0",
          "persist": "persist/1",
          "retire": "retire/1",
        },
        "ManagerClosedNotice": {
          "emit": "emit/0",
          "journalExchange": "bound #journalExchange/2",
          "persist": "persist/1",
          "queueSynthesizedNotice": "queueSynthesizedNotice/0",
        },
        "ManagerNoteReceiver": {
          "emit": "emit/0",
          "journal": "journal/1",
          "journalExchange": "bound #journalExchange/2",
          "persist": "persist/1",
        },
        "ManagerReportApply": {
          "nowIso": "nowIso/0",
        },
        "ManagerSelfFencedReceiver": {
          "emit": "emit/3",
          "journalExchange": "bound #journalExchange/2",
          "now": "now/0",
          "persist": "persist/1",
          "scheduleReattach": "scheduleReattach/1",
          "withdrawWaiting": "withdrawWaiting/2",
        },
      }
    `);
  });

  it('構築のあとの restore() は協力者を作り直さない', async () => {
    const { constructed } = await open();
    expect(spy.order).toEqual(constructed);
  });
});
