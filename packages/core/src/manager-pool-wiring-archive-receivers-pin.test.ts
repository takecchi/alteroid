import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerRecord } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

// `Pool` の `constructor` のうち、`ArchiveReceiver`（ブロック K）と受け手 5 種（`ManagerDenialReceiver`・`ManagerSessionReceiver`・
// `ManagerToolUseReceiver`・`ManagerParkedPeersReceiver`・`ManagerWaitingReceiver`。ブロック L）を作って口（ports）を渡す部分の
// 「配線」を、外から縛る。K と L は隣り合っている（UsageReceiver → K → L → SelfFencedReceiver）ので 1 本にまとめた。
// 切り出し（協力者を作る関数へ減らす）の前の pin。振る舞いそのものは各クラスの pin（archive-receiver ほか）が縛っている。
// ここが縛るのは次の 4 つ:
//   - 6 つが何個・どの順で作られるか（前後の協力者との相対順も含む）。`restore()` で作り直されないこと
//   - 渡る ports の欄の全部（欄名・関数か値か）と、共有参照（`stores`）が `Pool` の持つ同じ物（`toBe`）であること
//   - 関数の口を呼ぶと `Pool` の側で引き直した結果になること（時計の差し替えに追随する・引数を取りこぼさない・余計な引数を渡さない・
//     `SessionLoaders` の口は構築の後で差し替えた物へ届く・async の皮で包まない・`this` を失わない）
//   - 関数の名前と引数の数（`bound #journalExchange` か矢印か）、非同期の口が解けるまでの microtask の周回数
// 期待の文字列・数は、いまの作りの出力から `-u` で生成して目で読んで写したもの（仕様を先に書いたものではない）。
// 実時間では待たない: 時計は注入し、タイマーは fake にする。
// L の 5 種は共有参照を持たず、lazy な関数の口だけ（`manager.ts` の最新で確かめた）。K だけが `stores` を値で受ける。

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
vi.mock('./session-loaders.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./session-loaders.js')>();
  return { ...mod, SessionLoaders: spy.wrap('SessionLoaders', mod.SessionLoaders) };
});
vi.mock('./usage-wake.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./usage-wake.js')>();
  return { ...mod, UsageWake: spy.wrap('UsageWake', mod.UsageWake) };
});
vi.mock('./usage-receiver.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./usage-receiver.js')>();
  return { ...mod, UsageReceiver: spy.wrap('UsageReceiver', mod.UsageReceiver) };
});
vi.mock('./archive-receiver.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./archive-receiver.js')>();
  return { ...mod, ArchiveReceiver: spy.wrap('ArchiveReceiver', mod.ArchiveReceiver) };
});
vi.mock('./manager-denial.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-denial.js')>();
  return {
    ...mod,
    ManagerDenialReceiver: spy.wrap('ManagerDenialReceiver', mod.ManagerDenialReceiver),
  };
});
vi.mock('./manager-session.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-session.js')>();
  return {
    ...mod,
    ManagerSessionReceiver: spy.wrap('ManagerSessionReceiver', mod.ManagerSessionReceiver),
  };
});
vi.mock('./manager-tool-use.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-tool-use.js')>();
  return {
    ...mod,
    ManagerToolUseReceiver: spy.wrap('ManagerToolUseReceiver', mod.ManagerToolUseReceiver),
  };
});
vi.mock('./manager-parked-peers.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./manager-parked-peers.js')>();
  return {
    ...mod,
    ManagerParkedPeersReceiver: spy.wrap(
      'ManagerParkedPeersReceiver',
      mod.ManagerParkedPeersReceiver,
    ),
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

const JOB_ID = 'mgr-wiring-archive-pin';
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

/** 対象の 6 つ（`manager.ts` の構築順）。 */
const TARGETS = [
  'ArchiveReceiver',
  'ManagerDenialReceiver',
  'ManagerSessionReceiver',
  'ManagerToolUseReceiver',
  'ManagerParkedPeersReceiver',
  'ManagerWaitingReceiver',
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
  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async connect() {
      return undefined;
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
  return { pool, stores, clock, inbox, records, record, constructed };
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

describe('Pool の constructor の配線: ArchiveReceiver と受け手 5 種', () => {
  it('作られる協力者と順（前後の協力者との相対順を含む）と数', async () => {
    const { constructed } = await open();
    expect(constructed).toMatchInlineSnapshot(`
      [
        "SessionLoaders",
        "WithheldReportsStore",
        "SynthesizedNoticeWindows",
        "UsageWake",
        "UsageReceiver",
        "ArchiveReceiver",
        "ManagerDenialReceiver",
        "ManagerSessionReceiver",
        "ManagerToolUseReceiver",
        "ManagerParkedPeersReceiver",
        "ManagerWaitingReceiver",
        "ManagerSelfFencedReceiver",
      ]
    `);
    expect(spy.order).toEqual(constructed);
    // 6 つは連続して、この順に 1 回ずつ。直前は UsageReceiver、直後は SelfFencedReceiver
    const start = constructed.indexOf(TARGETS[0]);
    expect(constructed.slice(start, start + TARGETS.length)).toEqual([...TARGETS]);
    expect(constructed[start - 1]).toBe('UsageReceiver');
    expect(constructed[start + TARGETS.length]).toBe('ManagerSelfFencedReceiver');
    expect(TARGETS.map((name) => constructed.filter((entry) => entry === name).length)).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
  });

  it('渡る ports の欄と、欄が関数か値か', async () => {
    await open();
    const shape = Object.fromEntries(
      TARGETS.map((name) => [
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
        "ArchiveReceiver": {
          "appendMirrorRetrying": "function",
          "fetchArchiveRetrying": "function",
          "journalExchange": "function",
          "persist": "function",
          "stores": "object",
        },
        "ManagerDenialReceiver": {
          "emit": "function",
          "journalExchange": "function",
          "nowIso": "function",
        },
        "ManagerParkedPeersReceiver": {
          "emit": "function",
          "nowIso": "function",
          "persist": "function",
        },
        "ManagerSessionReceiver": {
          "journalExchange": "function",
          "noteRunnerSessionSince": "function",
          "nowIso": "function",
          "persist": "function",
          "rememberPluginLoad": "function",
        },
        "ManagerToolUseReceiver": {
          "journal": "function",
          "nowIso": "function",
          "observeUnpushedWorkOnce": "function",
        },
        "ManagerWaitingReceiver": {
          "emit": "function",
          "journal": "function",
          "journalExchange": "function",
          "nowIso": "function",
          "persist": "function",
        },
      }
    `);
  });

  it('stores は Pool が受けた入れ物そのもの（コピーでない）。L の 5 種は共有参照を持たない', async () => {
    const { stores } = await open();
    const archive = portsOf('ArchiveReceiver');
    expect(archive.stores).toBe(stores);
    expect(archive.stores).toBe(portsOf('UsageReceiver').stores);
    // 値の欄は K の `stores` だけ。L の 5 種は関数の口しか受けない
    const valueFields = TARGETS.flatMap((name) =>
      Object.entries(portsOf(name))
        .filter(([, value]) => typeof value !== 'function')
        .map(([key]) => `${name}.${key}`),
    );
    expect(valueFields).toEqual(['ArchiveReceiver.stores']);
    // 差し替わりうる入れ物: 欄を取り出さずに入れ物ごと受けているので、`Pool` へ渡した物の `archive` / `sessionStore` を同じ参照で引ける
    expect((archive.stores as typeof stores).archive).toBe(stores.archive);
    expect((archive.stores as typeof stores).sessionStore).toBe(stores.sessionStore);
  });

  it('時計の口は呼ぶたびに注入した時計を引き直す（構築時の値のコピーでない）', async () => {
    const { clock } = await open();
    const seen: Record<string, unknown[]> = {};
    for (const name of TARGETS) {
      const ports = portsOf(name);
      if (typeof ports.nowIso === 'function') {
        clock.now = T0;
        const first = (ports.nowIso as Fn)();
        clock.now = T0 + 12_345;
        seen[`${name}.nowIso`] = [first, (ports.nowIso as Fn)()];
      }
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "ManagerDenialReceiver.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
        "ManagerParkedPeersReceiver.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
        "ManagerSessionReceiver.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
        "ManagerToolUseReceiver.nowIso": [
          "2026-11-01T00:00:00.000Z",
          "2026-11-01T00:00:12.345Z",
        ],
        "ManagerWaitingReceiver.nowIso": [
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
        "ArchiveReceiver": {
          "added": 1,
          "role": "outbound",
          "text": "ArchiveReceiver の呼び出し",
          "with": "manager",
        },
        "ManagerDenialReceiver": {
          "added": 1,
          "role": "outbound",
          "text": "ManagerDenialReceiver の呼び出し",
          "with": "manager",
        },
        "ManagerSessionReceiver": {
          "added": 1,
          "role": "outbound",
          "text": "ManagerSessionReceiver の呼び出し",
          "with": "manager",
        },
        "ManagerWaitingReceiver": {
          "added": 1,
          "role": "outbound",
          "text": "ManagerWaitingReceiver の呼び出し",
          "with": "manager",
        },
      }
    `);
  });

  it('journal の口（ToolUse・Waiting）は渡した記載をそのまま日誌へ書き、Promise を返す', async () => {
    const { stores } = await open();
    const out: Record<string, unknown> = {};
    for (const name of ['ManagerToolUseReceiver', 'ManagerWaitingReceiver']) {
      const journal = fnOf(name, 'journal');
      // 種類の違う 2 件を渡し、種類を書き換えず・欄を落とさずに書かれることを見る
      const returned = [
        journal({
          type: 'decision',
          decision: `${name} の配線の確認`,
          grounds: '口から直に呼んだ',
        }),
        journal({
          type: 'escalation',
          question: `${name} の問い`,
          approvalId: `req-${name}`,
          managerId: JOB_ID,
        }),
      ];
      expect(returned.every((value) => value instanceof Promise)).toBe(true);
      await Promise.all(returned);
      const decisions = (await stores.journal.list({ types: ['decision'] })).filter(
        (entry) =>
          (entry as unknown as Record<string, unknown>).decision === `${name} の配線の確認`,
      ) as unknown as Record<string, unknown>[];
      const escalations = (await stores.journal.list({ types: ['escalation'] })).filter(
        (entry) => (entry as unknown as Record<string, unknown>).approvalId === `req-${name}`,
      ) as unknown as Record<string, unknown>[];
      out[name] = {
        decisions: decisions.map((entry) => ({ decision: entry.decision, grounds: entry.grounds })),
        escalations: escalations.map((entry) => ({
          question: entry.question,
          approvalId: entry.approvalId,
          managerId: entry.managerId,
        })),
      };
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "ManagerToolUseReceiver": {
          "decisions": [
            {
              "decision": "ManagerToolUseReceiver の配線の確認",
              "grounds": "口から直に呼んだ",
            },
          ],
          "escalations": [
            {
              "approvalId": "req-ManagerToolUseReceiver",
              "managerId": "mgr-wiring-archive-pin",
              "question": "ManagerToolUseReceiver の問い",
            },
          ],
        },
        "ManagerWaitingReceiver": {
          "decisions": [
            {
              "decision": "ManagerWaitingReceiver の配線の確認",
              "grounds": "口から直に呼んだ",
            },
          ],
          "escalations": [
            {
              "approvalId": "req-ManagerWaitingReceiver",
              "managerId": "mgr-wiring-archive-pin",
              "question": "ManagerWaitingReceiver の問い",
            },
          ],
        },
      }
    `);
  });

  it('persist の口は像の updatedAt を時計で書き直して台帳へ書く', async () => {
    const { stores, clock, record } = await open();
    const out: Record<string, unknown> = {};
    for (const [index, name] of TARGETS.entries()) {
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
        "ArchiveReceiver": {
          "stored": "2026-11-01T00:01:00.000Z",
          "updatedAt": "2026-11-01T00:01:00.000Z",
        },
        "ManagerParkedPeersReceiver": {
          "stored": "2026-11-01T00:05:00.000Z",
          "updatedAt": "2026-11-01T00:05:00.000Z",
        },
        "ManagerSessionReceiver": {
          "stored": "2026-11-01T00:03:00.000Z",
          "updatedAt": "2026-11-01T00:03:00.000Z",
        },
        "ManagerWaitingReceiver": {
          "stored": "2026-11-01T00:06:00.000Z",
          "updatedAt": "2026-11-01T00:06:00.000Z",
        },
      }
    `);
  });

  it('emit の口（Denial・ParkedPeers は 3 引数、Waiting は 5 引数）は渡した引数を、決まった数だけ合流窓の emit へ渡す', async () => {
    await open();
    const synthesized = instanceOf('SynthesizedNoticeWindows') as {
      emit: (...args: unknown[]) => void;
    };
    const calls: unknown[][] = [];
    const spyEmit = vi.spyOn(synthesized, 'emit').mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    const returns: Record<string, unknown> = {};
    for (const name of TARGETS) {
      const ports = portsOf(name);
      if (typeof ports.emit !== 'function') continue;
      // 9 引数まで渡して、口が何個を通すかを見る
      returns[name] = (ports.emit as Fn)(
        JOB_ID,
        'question',
        `${name} の本文`,
        'req-1',
        'none',
        'flush',
        true,
        { attachments: [] },
        { sinceMs: 1 },
      );
    }
    spyEmit.mockRestore();
    expect(returns).toMatchInlineSnapshot(`
      {
        "ManagerDenialReceiver": undefined,
        "ManagerParkedPeersReceiver": undefined,
        "ManagerWaitingReceiver": undefined,
      }
    `);
    expect(calls.map((args) => args.length)).toMatchInlineSnapshot(`
      [
        3,
        3,
        5,
      ]
    `);
    expect(calls).toMatchInlineSnapshot(`
      [
        [
          "mgr-wiring-archive-pin",
          "question",
          "ManagerDenialReceiver の本文",
        ],
        [
          "mgr-wiring-archive-pin",
          "question",
          "ManagerParkedPeersReceiver の本文",
        ],
        [
          "mgr-wiring-archive-pin",
          "question",
          "ManagerWaitingReceiver の本文",
          "req-1",
          "none",
        ],
      ]
    `);
  });

  it('fetchArchiveRetrying の口は SessionLoaders へ 3 引数を、その `this` のまま渡し、Promise をそのまま返す（構築の後の差し替えにも届く）', async () => {
    await open();
    const loaders = instanceOf('SessionLoaders') as {
      fetchArchiveRetrying: (...args: unknown[]) => Promise<unknown>;
    };
    const seen: { self: unknown; args: unknown[] }[] = [];
    const answer = Promise.resolve({ body: 'x', runner: {} });
    // 構築の後で差し替える: 構築時に取り出した関数を持っているなら、この差し替えへは届かない
    const spyFetch = vi.spyOn(loaders, 'fetchArchiveRetrying').mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      seen.push({ self: this, args });
      return answer;
    });
    const returned = fnOf('ArchiveReceiver', 'fetchArchiveRetrying')(
      'mgr-1',
      'arch-1',
      'runner-x',
      '余計な引数',
    );
    spyFetch.mockRestore();
    expect({
      returnedSamePromise: returned === answer,
      count: seen.length,
      thisIsLoaders: seen[0]?.self === loaders,
      args: seen[0]?.args,
    }).toMatchInlineSnapshot(`
      {
        "args": [
          "mgr-1",
          "arch-1",
          "runner-x",
        ],
        "count": 1,
        "returnedSamePromise": true,
        "thisIsLoaders": true,
      }
    `);
  });

  it('appendMirrorRetrying の口は SessionLoaders へ 2 引数を、その `this` のまま渡し、Promise をそのまま返す（構築の後の差し替えにも届く）', async () => {
    await open();
    const loaders = instanceOf('SessionLoaders') as {
      appendMirrorRetrying: (...args: unknown[]) => Promise<void>;
    };
    const seen: { self: unknown; args: unknown[] }[] = [];
    const answer = Promise.resolve();
    const spyAppend = vi.spyOn(loaders, 'appendMirrorRetrying').mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      seen.push({ self: this, args });
      return answer;
    });
    const store = { append: vi.fn() };
    const event = { type: 'mirror', managerId: 'mgr-1' };
    const returned = fnOf('ArchiveReceiver', 'appendMirrorRetrying')(store, event, '余計な引数');
    spyAppend.mockRestore();
    expect({
      returnedSamePromise: returned === answer,
      count: seen.length,
      thisIsLoaders: seen[0]?.self === loaders,
      storeSame: seen[0]?.args[0] === store,
      eventSame: seen[0]?.args[1] === event,
      argCount: seen[0]?.args.length,
    }).toMatchInlineSnapshot(`
      {
        "argCount": 2,
        "count": 1,
        "eventSame": true,
        "returnedSamePromise": true,
        "storeSame": true,
        "thisIsLoaders": true,
      }
    `);
  });

  it('noteRunnerSessionSince の口は像の runnerSessionSince と turnStartedAt を時計で書き、同期で undefined を返す', async () => {
    const { clock, record } = await open();
    clock.now = T0 + 5 * 60_000;
    const returned = fnOf('ManagerSessionReceiver', 'noteRunnerSessionSince')(record);
    expect({
      returned,
      runnerSessionSince: record.runnerSessionSince,
      jobRunnerSessionSince: record.job.runnerSessionSince,
      turnStartedAt: record.job.turnStartedAt,
    }).toMatchInlineSnapshot(`
      {
        "jobRunnerSessionSince": "2026-11-01T00:05:00.000Z",
        "returned": undefined,
        "runnerSessionSince": "2026-11-01T00:05:00.000Z",
        "turnStartedAt": "2026-11-01T00:05:00.000Z",
      }
    `);
  });

  it('rememberPluginLoad の口は Pool の #pluginLoad へ書き（pluginLoadOf で読める）、同期で undefined を返す', async () => {
    const { pool } = await open();
    const before = pool.pluginLoadOf('runner-primary');
    const observation = {
      at: '2026-11-01T00:00:00.000Z',
      managerId: JOB_ID,
      pluginLoad: { loaded: [], failed: [] },
    };
    const returned = fnOf('ManagerSessionReceiver', 'rememberPluginLoad')(
      'runner-primary',
      observation,
    );
    expect({
      before,
      returned,
      sameObject: (pool.pluginLoadOf('runner-primary') as unknown) === observation,
      other: pool.pluginLoadOf('runner-other'),
    }).toMatchInlineSnapshot(`
      {
        "before": undefined,
        "other": undefined,
        "returned": undefined,
        "sameObject": true,
      }
    `);
  });

  it('observeUnpushedWorkOnce の口は Pool の unpushedWork を（managerId・signal・source で）呼び、実行中の同じ担当は 1 回に畳む', async () => {
    const { pool } = await open();
    const seen: { managerId: unknown; source: unknown; signal: unknown }[] = [];
    let release: () => void = () => undefined;
    const pending = new Promise<never>((resolve) => {
      release = () => resolve(undefined as never);
    });
    const spyUnpushed = vi
      .spyOn(pool, 'unpushedWork')
      .mockImplementation((managerId: string, options?: unknown) => {
        const opts = options as { source?: unknown; signal?: unknown } | undefined;
        seen.push({ managerId, source: opts?.source, signal: opts?.signal });
        return pending;
      });
    try {
      const observe = fnOf('ManagerToolUseReceiver', 'observeUnpushedWorkOnce');
      const first = observe(JOB_ID, 'tool_use');
      const second = observe(JOB_ID, 'tool_use');
      const otherManager = observe('mgr-other', 'tool_use');
      release();
      await settle();
      const afterRelease = observe(JOB_ID, 'report');
      expect({
        returns: [first, second, otherManager, afterRelease],
        calls: seen.map((entry) => ({
          managerId: entry.managerId,
          source: entry.source,
          signalIsAbortSignal: entry.signal instanceof AbortSignal,
          aborted: (entry.signal as AbortSignal).aborted,
        })),
      }).toMatchInlineSnapshot(`
        {
          "calls": [
            {
              "aborted": false,
              "managerId": "mgr-wiring-archive-pin",
              "signalIsAbortSignal": true,
              "source": "tool_use",
            },
            {
              "aborted": false,
              "managerId": "mgr-other",
              "signalIsAbortSignal": true,
              "source": "tool_use",
            },
            {
              "aborted": false,
              "managerId": "mgr-wiring-archive-pin",
              "signalIsAbortSignal": true,
              "source": "report",
            },
          ],
          "returns": [
            undefined,
            undefined,
            undefined,
            undefined,
          ],
        }
      `);
    } finally {
      spyUnpushed.mockRestore();
    }
  });

  it('同期の口は Promise を返さない（async の皮で包まない）', async () => {
    const { pool, record } = await open();
    const spyUnpushed = vi.spyOn(pool, 'unpushedWork').mockResolvedValue(null as never);
    const returned: Record<string, unknown> = {};
    try {
      for (const name of TARGETS) {
        const ports = portsOf(name);
        const entries: Record<string, boolean> = {};
        const sync: [string, unknown[]][] = [
          ['nowIso', []],
          ['emit', [JOB_ID, 'report', 'x']],
          ['noteRunnerSessionSince', [record]],
          [
            'rememberPluginLoad',
            ['runner-sync', { at: 'x', managerId: JOB_ID, pluginLoad: { loaded: [], failed: [] } }],
          ],
          ['observeUnpushedWorkOnce', ['mgr-sync', 'tool_use']],
        ];
        for (const [key, args] of sync) {
          const fn = ports[key];
          if (typeof fn === 'function') entries[key] = (fn as Fn)(...args) instanceof Promise;
        }
        returned[name] = entries;
      }
    } finally {
      spyUnpushed.mockRestore();
    }
    expect(returned).toMatchInlineSnapshot(`
      {
        "ArchiveReceiver": {},
        "ManagerDenialReceiver": {
          "emit": false,
          "nowIso": false,
        },
        "ManagerParkedPeersReceiver": {
          "emit": false,
          "nowIso": false,
        },
        "ManagerSessionReceiver": {
          "noteRunnerSessionSince": false,
          "nowIso": false,
          "rememberPluginLoad": false,
        },
        "ManagerToolUseReceiver": {
          "nowIso": false,
          "observeUnpushedWorkOnce": false,
        },
        "ManagerWaitingReceiver": {
          "emit": false,
          "nowIso": false,
        },
      }
    `);
  });

  it('非同期の口が解けるまでの microtask の周回数（皮を足すと増える）', async () => {
    const { record } = await open();
    const hops: Record<string, Record<string, number>> = {};
    for (const name of TARGETS) {
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
        "ArchiveReceiver": {
          "journalExchange": 2,
          "persist": 3,
        },
        "ManagerDenialReceiver": {
          "journalExchange": 2,
        },
        "ManagerParkedPeersReceiver": {
          "persist": 3,
        },
        "ManagerSessionReceiver": {
          "journalExchange": 2,
          "persist": 3,
        },
        "ManagerToolUseReceiver": {
          "journal": 2,
        },
        "ManagerWaitingReceiver": {
          "journal": 2,
          "journalExchange": 2,
          "persist": 3,
        },
      }
    `);
  });

  it('口の関数の名前と引数の数（journalExchange は bind、ほかは束ねた無名の関数）', async () => {
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
        "ArchiveReceiver": {
          "appendMirrorRetrying": "appendMirrorRetrying/2",
          "fetchArchiveRetrying": "fetchArchiveRetrying/3",
          "journalExchange": "bound #journalExchange/2",
          "persist": "persist/1",
        },
        "ManagerDenialReceiver": {
          "emit": "emit/3",
          "journalExchange": "bound #journalExchange/2",
          "nowIso": "nowIso/0",
        },
        "ManagerParkedPeersReceiver": {
          "emit": "emit/3",
          "nowIso": "nowIso/0",
          "persist": "persist/1",
        },
        "ManagerSessionReceiver": {
          "journalExchange": "bound #journalExchange/2",
          "noteRunnerSessionSince": "noteRunnerSessionSince/1",
          "nowIso": "nowIso/0",
          "persist": "persist/1",
          "rememberPluginLoad": "rememberPluginLoad/2",
        },
        "ManagerToolUseReceiver": {
          "journal": "journal/1",
          "nowIso": "nowIso/0",
          "observeUnpushedWorkOnce": "observeUnpushedWorkOnce/2",
        },
        "ManagerWaitingReceiver": {
          "emit": "emit/5",
          "journal": "journal/1",
          "journalExchange": "bound #journalExchange/2",
          "nowIso": "nowIso/0",
          "persist": "persist/1",
        },
      }
    `);
  });

  it('構築のあとの restore() は協力者を作り直さない', async () => {
    const { constructed } = await open();
    expect(spy.order).toEqual(constructed);
  });
});
