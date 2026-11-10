import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPoolOptions } from './manager.js';
import type { PushLedger } from './push-ledger.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import { createRunnerRegistry, type RunnerClient } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

// `Pool` の `constructor` のうち、ブロック F（`PushLedger` の構築と、直接 push の購読 6 本）の「配線」を、外から縛る。
// 切り出し（F の `PushLedger` の構築を協力者を作る関数へ減らす）の前の pin。`PushLedger` の振る舞いは push-ledger の pin が縛っている。
// ここが縛るのは次の 7 つ:
//   - `PushLedger` が何個・どの順で作られるか（E の `HeldMessages` の直後、窓の前。購読 6 本の `onPushed` は構築の直後・窓の前に起きる）。restore・取り直しで作り直されない
//   - 渡る引数の全欄: `services` の 7 欄は引数の値そのまま（`toBe`）、`runners` も `toBe`。関数 4 本は名前・引数の数・呼んだ時点の読み直し
//   - `pendingPush` が `#reattachPushes`（先）→ `#connections`（後）の順に lazy に読む（構築の後に Pool が書いた値が見える）
//   - 購読 6 本: `permissionRules`・`profile`・`mcpServers`・`credentials`・`plugins`・`agentToken` の順に 1 回ずつ。undefined の source は呼ばず積まない。
//     返った unsubscribe を積む順（undefined を返す source は積まない）、`stop()` が積んだ順に 1 回ずつ呼ぶこと
//   - コールバックの中身: 結果をそのまま `recordDirectPushResults(kind, results)` へ。`scope?.unnamed === true` なら `knownRunnerIds()` の各 runner の失敗へ置き換える
//   - `#pushLedger` はコールバックが呼ばれた時点で引く（構築の最中に呼ばれても、構築の後に差し替えても効く）
//   - 同期の口が Promise を返さないこと、非同期の口（`journal`）の microtask の周回数
// 期待の文字列・数は、いまの作りの出力から `-u` で生成して目で読んで写したもの（仕様を先に書いたものではない）。
// 実時間では待たない: 時計は注入し、タイマーは fake にする。

const spy = vi.hoisted(() => {
  /** 構築の記録（名前だけ。構築の順と数を見る）。購読（`onPushed:<名前>`）も同じ並びへ積む。 */
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

const T0 = Date.parse('2026-11-01T00:00:00.000Z');

/** 購読の順（`manager.ts` の配列の順）。 */
const KINDS = [
  'permissionRules',
  'profile',
  'mcpServers',
  'credentials',
  'plugins',
  'agentToken',
] as const;
type Kind = (typeof KINDS)[number];

const SERVICE_KEYS = [
  'profile',
  'credentials',
  'mcpServers',
  'plugins',
  'permissionRules',
  'codexAuth',
  'syncRunnerToken',
] as const;

type Result = { runnerId: string; ok: boolean; error?: string };
type Listener = (results: readonly Result[], scope?: unknown) => unknown;
type Fn = (...args: unknown[]) => unknown;

/** 解除の記録（呼んだ順）。解除が呼ばれた時点で `PushLedger` が見た止まった印も控える。 */
const unsubscribed: { name: string; ledgerStopped: boolean }[] = [];
/** 押し込みを止める関門（`profile.syncRunner` が待つ）。 */
const gate: { current: Promise<void> | undefined } = { current: undefined };

interface SourceOptions {
  /** `false` なら `onPushed` は解除の関数を返さない（undefined）。 */
  unsubscribe?: boolean;
  /** 購読の瞬間（`onPushed` の中）にコールバックを同期で呼ぶ結果。 */
  fireOnSubscribe?: readonly Result[];
}

/** 直接 push の source（かつ `PushLedger` の services の欄）の偽物。 */
function makeSource(name: Kind, options: SourceOptions = {}) {
  const listeners: Listener[] = [];
  return {
    name,
    listeners,
    onPushed: vi.fn((listener: Listener) => {
      spy.order.push(`onPushed:${name}`);
      listeners.push(listener);
      if (options.fireOnSubscribe !== undefined) listener(options.fireOnSubscribe);
      if (options.unsubscribe === false) return undefined;
      return () => {
        unsubscribed.push({ name, ledgerStopped: (ledgerPorts().stopped as () => boolean)() });
      };
    }),
    // 取り直しで `PushLedger#pushEnvironmentTo` が呼ぶ。呼ぶ時点で関門が立っていれば待つ
    syncRunner: async () => {
      await gate.current;
      return null;
    },
  };
}
type Source = ReturnType<typeof makeSource>;

function callOf(name: string) {
  const hit = spy.calls.filter((call) => call.name === name).at(-1);
  if (hit === undefined) throw new Error(`${name} は作られていない`);
  return hit;
}

function ledgerPorts(): Record<string, unknown> {
  return callOf('PushLedger').ports;
}

function ledgerPort(key: string): Fn {
  const value = ledgerPorts()[key];
  if (typeof value !== 'function') throw new Error(`PushLedger.${key} は関数でない`);
  return value as Fn;
}

function ledgerInstance(): PushLedger {
  return callOf('PushLedger').instance as PushLedger;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
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

interface OpenOptions {
  /** 種類ごとの source。`null` で渡さない。省略した種類は既定の偽物を渡す。 */
  sources?: Partial<Record<Kind, Source | null>>;
  /** `false` なら `restore()` を呼ばない（runner へは繋がない）。 */
  restore?: boolean;
  /** `codexAuth`・`syncRunnerToken` を渡す（services の欄の確認用）。 */
  withServices?: boolean;
}

/** Pool を 1 つ作る。時計は `clock.now` を読む。 */
async function open(extra: OpenOptions = {}) {
  spy.reset();
  unsubscribed.length = 0;
  gate.current = undefined;
  const clock = { now: T0 };
  const stores = createMemoryStores();
  const sources = Object.fromEntries(
    KINDS.map((kind) => {
      const given = extra.sources?.[kind];
      return [kind, given === undefined ? makeSource(kind) : given];
    }),
  ) as Record<Kind, Source | null>;
  const codexAuth = { syncRunner: async () => undefined };
  const syncRunnerToken = async () => undefined;
  const connectHandlers: ((event: never) => void)[] = [];
  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async connect(onEvent) {
      connectHandlers.push(onEvent as unknown as (event: never) => void);
    },
    async list() {
      return [];
    },
  });
  const registry = createRunnerRegistry([runner]);
  const pool = createManagerPool({
    stores,
    now: () => clock.now,
    post: () => undefined,
    runners: registry,
    ...(extra.withServices === true ? { codexAuth: codexAuth as never, syncRunnerToken } : {}),
    ...(sources.permissionRules === null
      ? {}
      : { permissionRules: sources.permissionRules as never }),
    ...(sources.profile === null ? {} : { profile: sources.profile as never }),
    ...(sources.mcpServers === null ? {} : { mcpServers: sources.mcpServers as never }),
    ...(sources.credentials === null ? {} : { credentials: sources.credentials as never }),
    ...(sources.plugins === null ? {} : { plugins: sources.plugins as never }),
    ...(sources.agentToken === null ? {} : { agentTokenPushes: sources.agentToken as never }),
  } satisfies ManagerPoolOptions);
  // 構築の記録は restore の前に取り出す（restore が作り直さないことも確かめるため、数は後でもう一度見る）
  const constructed = [...spy.order];
  if (extra.restore !== false) {
    await pool.restore();
    await settle();
  }
  return {
    pool,
    stores,
    clock,
    runner,
    registry,
    sources,
    codexAuth,
    syncRunnerToken,
    constructed,
    emit: () => connectHandlers.at(-1),
  };
}

/** 種類ごとのコールバック（購読の順で 6 本）。 */
function listenerOf(sources: Record<Kind, Source | null>, kind: Kind): Listener {
  const listener = sources[kind]?.listeners[0];
  if (listener === undefined) throw new Error(`${kind} は購読されていない`);
  return listener;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Pool の constructor の配線: PushLedger の構築と直接 push の購読（F）', () => {
  it('作られる協力者と購読の順（前後との相対順を含む）と数', async () => {
    const { constructed } = await open();
    expect(constructed).toMatchInlineSnapshot(`
      [
        "WithheldReportsStore",
        "TurnEndWatch",
        "AutoFold",
        "DenialRenotifier",
        "HeldMessages",
        "PushLedger",
        "onPushed:permissionRules",
        "onPushed:profile",
        "onPushed:mcpServers",
        "onPushed:credentials",
        "onPushed:plugins",
        "onPushed:agentToken",
        "QuotaStopWindows",
        "SynthesizedNoticeWindows",
      ]
    `);
    expect(spy.order.filter((entry) => !entry.startsWith('onPushed:'))).toEqual(
      constructed.filter((entry) => !entry.startsWith('onPushed:')),
    );
    // E の最後（HeldMessages）の直後に PushLedger、その直後から購読 6 本、その後に窓
    expect(constructed.indexOf('PushLedger') - constructed.indexOf('HeldMessages')).toBe(1);
    expect(
      constructed.indexOf('onPushed:permissionRules') - constructed.indexOf('PushLedger'),
    ).toBe(1);
    expect(
      constructed.indexOf('QuotaStopWindows') - constructed.indexOf('onPushed:agentToken'),
    ).toBe(1);
    expect(constructed.filter((entry) => entry === 'PushLedger')).toHaveLength(1);
  });

  it('構築のあとの restore() と取り直し（hello）は PushLedger を作り直さず、購読もやり直さない', async () => {
    const { sources, emit } = await open();
    emit()?.({ type: 'hello', runnerId: 'runner-primary', capabilities: [] } as never);
    await settle();
    expect(spy.calls.filter((call) => call.name === 'PushLedger')).toHaveLength(1);
    expect(spy.order.filter((entry) => entry.startsWith('onPushed:'))).toHaveLength(6);
    expect(
      KINDS.map((kind) => [
        kind,
        sources[kind]?.onPushed.mock.calls.length,
        sources[kind]?.listeners.length,
      ]),
    ).toMatchInlineSnapshot(`
      [
        [
          "permissionRules",
          1,
          1,
        ],
        [
          "profile",
          1,
          1,
        ],
        [
          "mcpServers",
          1,
          1,
        ],
        [
          "credentials",
          1,
          1,
        ],
        [
          "plugins",
          1,
          1,
        ],
        [
          "agentToken",
          1,
          1,
        ],
      ]
    `);
  });

  it('services の 7 欄は渡した値そのまま（toBe）で、runners も同じ。欄の名前は 7 つだけ', async () => {
    const { sources, registry, codexAuth, syncRunnerToken } = await open({
      withServices: true,
      restore: false,
    });
    const ports = ledgerPorts();
    const services = ports.services as Record<string, unknown>;
    expect(Object.keys(ports).sort()).toMatchInlineSnapshot(`
      [
        "journal",
        "now",
        "pendingPush",
        "runners",
        "services",
        "stopped",
      ]
    `);
    expect(Object.keys(services).sort()).toMatchInlineSnapshot(`
      [
        "codexAuth",
        "credentials",
        "mcpServers",
        "permissionRules",
        "plugins",
        "profile",
        "syncRunnerToken",
      ]
    `);
    expect({
      profile: services.profile === sources.profile,
      credentials: services.credentials === sources.credentials,
      mcpServers: services.mcpServers === sources.mcpServers,
      plugins: services.plugins === sources.plugins,
      permissionRules: services.permissionRules === sources.permissionRules,
      codexAuth: services.codexAuth === codexAuth,
      syncRunnerToken: services.syncRunnerToken === syncRunnerToken,
      runners: ports.runners === registry,
    }).toMatchInlineSnapshot(`
      {
        "codexAuth": true,
        "credentials": true,
        "mcpServers": true,
        "permissionRules": true,
        "plugins": true,
        "profile": true,
        "runners": true,
        "syncRunnerToken": true,
      }
    `);
    // 引数で渡さなかった欄は undefined のまま（欄は欠けない）
    await open({
      sources: Object.fromEntries(KINDS.map((kind) => [kind, null])),
      restore: false,
    });
    const none = ledgerPorts().services as Record<string, unknown>;
    expect(SERVICE_KEYS.map((key) => [key, key in none, none[key]])).toMatchInlineSnapshot(`
      [
        [
          "profile",
          true,
          undefined,
        ],
        [
          "credentials",
          true,
          undefined,
        ],
        [
          "mcpServers",
          true,
          undefined,
        ],
        [
          "plugins",
          true,
          undefined,
        ],
        [
          "permissionRules",
          true,
          undefined,
        ],
        [
          "codexAuth",
          true,
          undefined,
        ],
        [
          "syncRunnerToken",
          true,
          undefined,
        ],
      ]
    `);
  });

  it('関数の口の名前と引数の数、同期の口は Promise を返さない', async () => {
    const { pool } = await open({ restore: false });
    const ports = ledgerPorts();
    const out: Record<string, unknown> = {};
    for (const key of ['journal', 'now', 'stopped', 'pendingPush']) {
      const fn = ports[key] as Fn;
      out[key] = `${fn.name}/${String(fn.length)}`;
    }
    const sync = {
      now: ledgerPort('now')() instanceof Promise,
      stopped: ledgerPort('stopped')() instanceof Promise,
      pendingPush: ledgerPort('pendingPush')('runner-none', {}) instanceof Promise,
    };
    expect({ out, sync }).toMatchInlineSnapshot(`
      {
        "out": {
          "journal": "journal/1",
          "now": "now/0",
          "pendingPush": "pendingPush/2",
          "stopped": "stopped/0",
        },
        "sync": {
          "now": false,
          "pendingPush": false,
          "stopped": false,
        },
      }
    `);
    expect(pool).toBeDefined();
  });

  it('now・stopped は呼ぶたびに Pool の時計・止まった印を引き直す（構築時の値のコピーでない）', async () => {
    const { clock, pool } = await open({ restore: false });
    clock.now = T0;
    const first = ledgerPort('now')();
    clock.now = T0 + 12_345;
    const second = ledgerPort('now')();
    const before = ledgerPort('stopped')();
    await pool.stop();
    const after = ledgerPort('stopped')();
    expect({ first, second, before, after }).toMatchInlineSnapshot(`
      {
        "after": true,
        "before": false,
        "first": 1793491200000,
        "second": 1793491212345,
      }
    `);
  });

  it('journal は台帳の日誌へ書き、Promise を返し、解けるまでの microtask の周回数は async の皮を足すと増える', async () => {
    const { stores } = await open({ restore: false });
    const returned = ledgerPort('journal')({
      type: 'decision',
      decision: 'PushLedger の配線の確認',
      grounds: '口から直に呼んだ',
    });
    expect(returned).toBeInstanceOf(Promise);
    const hops = await hopsOf(returned as Promise<unknown>);
    const hits = (await stores.journal.list({ types: ['decision'] })).filter((entry) =>
      String((entry as unknown as Record<string, unknown>).decision).includes('の配線の確認'),
    ) as unknown as Record<string, unknown>[];
    expect({
      hops,
      written: hits.map((entry) => ({ decision: entry.decision, grounds: entry.grounds })),
    }).toMatchInlineSnapshot(`
      {
        "hops": 2,
        "written": [
          {
            "decision": "PushLedger の配線の確認",
            "grounds": "口から直に呼んだ",
          },
        ],
      }
    `);
  });

  it('pendingPush: #reattachPushes が先に勝ち、無ければ #connections、どちらにも無ければ undefined（構築の後に Pool が書いた値が見える）', async () => {
    const { runner, emit } = await open();
    const pending = ledgerPort('pendingPush');
    const other = fakeRunnerClient({ runnerId: 'runner-other' }) as RunnerClient;
    // 繋ぎ終えた runner: #connections に（解けた）接続の Promise が残っている
    const viaConnections = pending('runner-primary', runner);
    // runner の object で引く: runnerId が違っても同じ接続の Promise
    const viaConnectionsOtherId = pending('runner-elsewhere', runner);
    const neither = pending('runner-primary', other);
    // 取り直しの降ろしを関門で止める: #reattachPushes に runnerId をキーにした Promise が載る
    let release: () => void = () => undefined;
    gate.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    emit()?.({ type: 'hello', runnerId: 'runner-primary', capabilities: [] } as never);
    await settle();
    const viaReattach = pending('runner-primary', runner);
    // runnerId をキーに引く: 別の runner の object でも、runnerId が合えば取り直しの Promise
    const viaReattachOtherRunner = pending('runner-primary', other);
    // runnerId が違えば取り直しの Promise は見えない（runner の object で #connections へ落ちる）
    const otherId = pending('runner-elsewhere', runner);
    release();
    await settle();
    gate.current = undefined;
    // 取り直しが終われば #reattachPushes は消え、#connections へ戻る
    const after = pending('runner-primary', runner);
    expect({
      viaConnectionsIsPromise: viaConnections instanceof Promise,
      viaConnectionsSameForOtherId: viaConnectionsOtherId === viaConnections,
      neither,
      reattachIsPromise: viaReattach instanceof Promise,
      reattachDiffersFromConnections: viaReattach !== viaConnections,
      reattachSameForOtherRunner: viaReattachOtherRunner === viaReattach,
      otherIdFallsBackToConnections: otherId === viaConnections,
      afterIsConnections: after === viaConnections,
    }).toMatchInlineSnapshot(`
      {
        "afterIsConnections": true,
        "neither": undefined,
        "otherIdFallsBackToConnections": true,
        "reattachDiffersFromConnections": true,
        "reattachIsPromise": true,
        "reattachSameForOtherRunner": true,
        "viaConnectionsIsPromise": true,
        "viaConnectionsSameForOtherId": true,
      }
    `);
  });
});

describe('Pool の constructor の配線: 直接 push の購読 6 本（F）', () => {
  it('source が undefined の種類は onPushed を呼ばず、有る種類だけが購読の順に 1 回ずつ呼ばれ、コールバックは 1 引数の関数', async () => {
    const out: Record<string, unknown> = {};
    for (const missing of KINDS) {
      const { constructed } = await open({ sources: { [missing]: null }, restore: false });
      out[`without ${missing}`] = constructed.filter((entry) => entry.startsWith('onPushed:'));
    }
    const { sources } = await open({ restore: false });
    out.all = KINDS.map((kind) => {
      const calls = sources[kind]?.onPushed.mock.calls ?? [];
      return `${kind}: ${String(calls.length)} 回, 引数 ${String(calls[0]?.length)} 個, ${typeof calls[0]?.[0]}/${String((calls[0]?.[0] as Fn | undefined)?.length)}`;
    });
    await open({ sources: Object.fromEntries(KINDS.map((kind) => [kind, null])), restore: false });
    out.none = spy.order.filter((entry) => entry.startsWith('onPushed:'));
    expect(out).toMatchInlineSnapshot(`
      {
        "all": [
          "permissionRules: 1 回, 引数 1 個, function/2",
          "profile: 1 回, 引数 1 個, function/2",
          "mcpServers: 1 回, 引数 1 個, function/2",
          "credentials: 1 回, 引数 1 個, function/2",
          "plugins: 1 回, 引数 1 個, function/2",
          "agentToken: 1 回, 引数 1 個, function/2",
        ],
        "none": [],
        "without agentToken": [
          "onPushed:permissionRules",
          "onPushed:profile",
          "onPushed:mcpServers",
          "onPushed:credentials",
          "onPushed:plugins",
        ],
        "without credentials": [
          "onPushed:permissionRules",
          "onPushed:profile",
          "onPushed:mcpServers",
          "onPushed:plugins",
          "onPushed:agentToken",
        ],
        "without mcpServers": [
          "onPushed:permissionRules",
          "onPushed:profile",
          "onPushed:credentials",
          "onPushed:plugins",
          "onPushed:agentToken",
        ],
        "without permissionRules": [
          "onPushed:profile",
          "onPushed:mcpServers",
          "onPushed:credentials",
          "onPushed:plugins",
          "onPushed:agentToken",
        ],
        "without plugins": [
          "onPushed:permissionRules",
          "onPushed:profile",
          "onPushed:mcpServers",
          "onPushed:credentials",
          "onPushed:agentToken",
        ],
        "without profile": [
          "onPushed:permissionRules",
          "onPushed:mcpServers",
          "onPushed:credentials",
          "onPushed:plugins",
          "onPushed:agentToken",
        ],
      }
    `);
  });

  it('stop() は積んだ解除を購読の順に 1 回ずつ呼び（止まった印を立てた後）、2 回目の stop() では呼ばない', async () => {
    const { pool, sources } = await open({ restore: false });
    const beforeStop = [...unsubscribed];
    await pool.stop();
    const afterStop = unsubscribed.map((entry) => `${entry.name}:${String(entry.ledgerStopped)}`);
    await pool.stop();
    expect({
      beforeStop,
      afterStop,
      afterSecondStop: unsubscribed.length,
      source: KINDS.map((kind) => sources[kind]?.onPushed.mock.calls.length),
    }).toMatchInlineSnapshot(`
      {
        "afterSecondStop": 6,
        "afterStop": [
          "permissionRules:true",
          "profile:true",
          "mcpServers:true",
          "credentials:true",
          "plugins:true",
          "agentToken:true",
        ],
        "beforeStop": [],
        "source": [
          1,
          1,
          1,
          1,
          1,
          1,
        ],
      }
    `);
  });

  it('解除を返さない（undefined）source は積まない。ほかの解除は順を保って呼ばれ、落ちない', async () => {
    const { pool } = await open({
      sources: {
        mcpServers: makeSource('mcpServers', { unsubscribe: false }),
        plugins: makeSource('plugins', { unsubscribe: false }),
        permissionRules: null,
      },
      restore: false,
    });
    await pool.stop();
    expect(unsubscribed.map((entry) => entry.name)).toMatchInlineSnapshot(`
      [
        "profile",
        "credentials",
        "agentToken",
      ]
    `);
  });

  it('コールバック: 結果をそのまま recordDirectPushResults(kind, results) へ渡し、kind は source ごとに固定', async () => {
    const { sources } = await open({ restore: false });
    const record = vi.spyOn(ledgerInstance(), 'recordDirectPushResults');
    const results: Result[][] = [];
    const returns: unknown[] = [];
    for (const kind of KINDS) {
      const mine = [{ runnerId: `r-${kind}`, ok: false, error: `${kind} が落ちた` }];
      results.push(mine);
      returns.push(listenerOf(sources, kind)(mine));
    }
    expect({
      calls: record.mock.calls.map(([kind, passed], index) => ({
        kind,
        same: passed === results[index],
        argc: record.mock.calls[index]?.length,
      })),
      returns,
      health: KINDS.map((kind) => [kind, ledgerInstance().healthOf(`r-${kind}`)]),
    }).toMatchInlineSnapshot(`
      {
        "calls": [
          {
            "argc": 2,
            "kind": "permissionRules",
            "same": true,
          },
          {
            "argc": 2,
            "kind": "profile",
            "same": true,
          },
          {
            "argc": 2,
            "kind": "mcpServers",
            "same": true,
          },
          {
            "argc": 2,
            "kind": "credentials",
            "same": true,
          },
          {
            "argc": 2,
            "kind": "plugins",
            "same": true,
          },
          {
            "argc": 2,
            "kind": "agentToken",
            "same": true,
          },
        ],
        "health": [
          [
            "permissionRules",
            {
              "permissionRules": {
                "at": "2026-11-01T00:00:00.000Z",
                "error": "permissionRules が落ちた",
                "status": "failed",
              },
            },
          ],
          [
            "profile",
            {
              "profile": {
                "at": "2026-11-01T00:00:00.000Z",
                "error": "profile が落ちた",
                "status": "failed",
              },
            },
          ],
          [
            "mcpServers",
            {
              "mcpServers": {
                "at": "2026-11-01T00:00:00.000Z",
                "error": "mcpServers が落ちた",
                "status": "failed",
              },
            },
          ],
          [
            "credentials",
            {
              "credentials": {
                "at": "2026-11-01T00:00:00.000Z",
                "error": "credentials が落ちた",
                "status": "failed",
              },
            },
          ],
          [
            "plugins",
            {
              "plugins": {
                "at": "2026-11-01T00:00:00.000Z",
                "error": "plugins が落ちた",
                "status": "failed",
              },
            },
          ],
          [
            "agentToken",
            {
              "agentToken": {
                "at": "2026-11-01T00:00:00.000Z",
                "error": "agentToken が落ちた",
                "status": "failed",
              },
            },
          ],
        ],
        "returns": [
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
        ],
      }
    `);
  });

  it('コールバック: scope.unnamed === true のときだけ、帳面の runner 全部の失敗（error は results[0]?.error）へ置き換える', async () => {
    const { sources } = await open({ restore: false });
    const ledger = ledgerInstance();
    ledger.recordDirectPushResults('profile', [
      { runnerId: 'r1', ok: true },
      { runnerId: 'r2', ok: true },
    ]);
    const record = vi.spyOn(ledger, 'recordDirectPushResults');
    const out: Record<string, unknown> = {};
    const fire = (label: string, kind: Kind, results: readonly Result[], scope?: unknown) => {
      record.mockClear();
      listenerOf(sources, kind)(results, scope);
      out[label] = record.mock.calls.map(([passedKind, passed]) => ({
        kind: passedKind,
        results: passed,
      }));
    };
    const named = [{ runnerId: 'rX', ok: true }];
    fire('unnamed', 'credentials', [{ runnerId: 'ignored', ok: false, error: '名指せなかった' }], {
      unnamed: true,
    });
    fire(
      'unnamed, results が複数（先頭の error だけを使う）',
      'credentials',
      [
        { runnerId: 'first', ok: false, error: '先頭の理由' },
        { runnerId: 'second', ok: false, error: '2 番目の理由' },
        { runnerId: 'third', ok: true },
      ],
      { unnamed: true },
    );
    fire('unnamed, results に error 無し', 'plugins', [{ runnerId: 'ignored', ok: true }], {
      unnamed: true,
    });
    fire('unnamed, results が空（落ちない）', 'agentToken', [], { unnamed: true });
    fire('unnamed: false は素通し', 'mcpServers', named, { unnamed: false });
    fire('unnamed: 真だが true でない値は素通し', 'mcpServers', named, { unnamed: 1 });
    fire('scope 無しは素通し', 'permissionRules', named);
    fire('scope が空の object は素通し', 'profile', named, {});
    out.passThroughSame = record.mock.calls.at(-1)?.[1] === named;
    out.health = ['r1', 'r2'].map((id) => [id, ledger.healthOf(id)]);
    expect(out).toMatchInlineSnapshot(`
      {
        "health": [
          [
            "r1",
            {
              "agentToken": {
                "at": "2026-11-01T00:00:00.000Z",
                "error": "理由不明",
                "status": "failed",
              },
              "credentials": {
                "at": "2026-11-01T00:00:00.000Z",
                "error": "先頭の理由",
                "status": "failed",
              },
              "plugins": {
                "at": "2026-11-01T00:00:00.000Z",
                "error": "理由不明",
                "status": "failed",
              },
              "profile": {
                "at": "2026-11-01T00:00:00.000Z",
                "status": "ok",
              },
            },
          ],
          [
            "r2",
            {
              "agentToken": {
                "at": "2026-11-01T00:00:00.000Z",
                "error": "理由不明",
                "status": "failed",
              },
              "credentials": {
                "at": "2026-11-01T00:00:00.000Z",
                "error": "先頭の理由",
                "status": "failed",
              },
              "plugins": {
                "at": "2026-11-01T00:00:00.000Z",
                "error": "理由不明",
                "status": "failed",
              },
              "profile": {
                "at": "2026-11-01T00:00:00.000Z",
                "status": "ok",
              },
            },
          ],
        ],
        "passThroughSame": true,
        "scope が空の object は素通し": [
          {
            "kind": "profile",
            "results": [
              {
                "ok": true,
                "runnerId": "rX",
              },
            ],
          },
        ],
        "scope 無しは素通し": [
          {
            "kind": "permissionRules",
            "results": [
              {
                "ok": true,
                "runnerId": "rX",
              },
            ],
          },
        ],
        "unnamed": [
          {
            "kind": "credentials",
            "results": [
              {
                "error": "名指せなかった",
                "ok": false,
                "runnerId": "r1",
              },
              {
                "error": "名指せなかった",
                "ok": false,
                "runnerId": "r2",
              },
            ],
          },
        ],
        "unnamed, results が空（落ちない）": [
          {
            "kind": "agentToken",
            "results": [
              {
                "error": undefined,
                "ok": false,
                "runnerId": "r1",
              },
              {
                "error": undefined,
                "ok": false,
                "runnerId": "r2",
              },
            ],
          },
        ],
        "unnamed, results が複数（先頭の error だけを使う）": [
          {
            "kind": "credentials",
            "results": [
              {
                "error": "先頭の理由",
                "ok": false,
                "runnerId": "r1",
              },
              {
                "error": "先頭の理由",
                "ok": false,
                "runnerId": "r2",
              },
            ],
          },
        ],
        "unnamed, results に error 無し": [
          {
            "kind": "plugins",
            "results": [
              {
                "error": undefined,
                "ok": false,
                "runnerId": "r1",
              },
              {
                "error": undefined,
                "ok": false,
                "runnerId": "r2",
              },
            ],
          },
        ],
        "unnamed: false は素通し": [
          {
            "kind": "mcpServers",
            "results": [
              {
                "ok": true,
                "runnerId": "rX",
              },
            ],
          },
        ],
        "unnamed: 真だが true でない値は素通し": [
          {
            "kind": "mcpServers",
            "results": [
              {
                "ok": true,
                "runnerId": "rX",
              },
            ],
          },
        ],
      }
    `);
  });

  it('コールバック: 帳面が空のとき unnamed は空の配列を渡し、帳面の runner の並びは載った順', async () => {
    const { sources } = await open({ restore: false });
    const ledger = ledgerInstance();
    const empty = ledger.knownRunnerIds();
    const record = vi.spyOn(ledger, 'recordDirectPushResults');
    listenerOf(sources, 'profile')([{ runnerId: 'x', ok: false, error: 'e' }], { unnamed: true });
    const emptyCall = record.mock.calls.at(-1);
    record.mockRestore();
    ledger.recordDirectPushResults('profile', [
      { runnerId: 'zz', ok: true },
      { runnerId: 'aa', ok: true },
    ]);
    listenerOf(sources, 'profile')([{ runnerId: 'x', ok: false, error: 'e' }], { unnamed: true });
    expect({ empty, emptyCall, known: ledger.knownRunnerIds() }).toMatchInlineSnapshot(`
      {
        "empty": [],
        "emptyCall": [
          "profile",
          [],
        ],
        "known": [
          "zz",
          "aa",
        ],
      }
    `);
  });

  it('#pushLedger はコールバックが呼ばれた時点で引く: 構築の最中に呼んでも落ちず、構築の後に差し替えても効く', async () => {
    const fireOnSubscribe = [{ runnerId: 'during-construction', ok: false, error: '構築の最中' }];
    const { sources } = await open({
      sources: {
        profile: makeSource('profile', { fireOnSubscribe }),
        agentToken: makeSource('agentToken', { fireOnSubscribe }),
      },
      restore: false,
    });
    const ledger = ledgerInstance();
    // 構築の最中に呼ばれた分も帳面に載っている（購読の時点で PushLedger は出来ている）
    const during = ledger.healthOf('during-construction');
    // 構築の後に呼んだメソッドの差し替えが効く（呼ぶ時点で引く。控えた参照を呼ばない）
    const record = vi.spyOn(ledger, 'recordDirectPushResults').mockImplementation(() => {
      throw new Error('差し替えた先が呼ばれた');
    });
    let thrown: unknown;
    try {
      listenerOf(sources, 'plugins')([{ runnerId: 'late', ok: true }]);
    } catch (error) {
      thrown = (error as Error).message;
    }
    expect({
      during,
      thrown,
      calls: record.mock.calls.length,
      late: ledger.healthOf('late'),
    }).toMatchInlineSnapshot(`
      {
        "calls": 1,
        "during": {
          "agentToken": {
            "at": "2026-11-01T00:00:00.000Z",
            "error": "構築の最中",
            "status": "failed",
          },
          "profile": {
            "at": "2026-11-01T00:00:00.000Z",
            "error": "構築の最中",
            "status": "failed",
          },
        },
        "late": undefined,
        "thrown": "差し替えた先が呼ばれた",
      }
    `);
  });

  it('コールバックは同期（Promise を返さない）で、記録の失敗は握らずそのまま投げる', async () => {
    const { sources } = await open({ restore: false });
    const returned = listenerOf(sources, 'profile')([{ runnerId: 'r', ok: true }]);
    const record = vi.spyOn(ledgerInstance(), 'recordDirectPushResults').mockImplementation(() => {
      throw new Error('帳面が落ちた');
    });
    let thrown: unknown;
    try {
      listenerOf(sources, 'profile')([{ runnerId: 'r', ok: true }]);
    } catch (error) {
      thrown = (error as Error).message;
    }
    record.mockRestore();
    expect({
      returned,
      isPromise: returned instanceof Promise,
      thrown,
    }).toMatchInlineSnapshot(`
      {
        "isPromise": false,
        "returned": undefined,
        "thrown": "帳面が落ちた",
      }
    `);
  });

  it('時計と止まった印は呼ぶ時点で読む: 帳面の at は注入した時計の今、stop() の後のコールバックは何も書かない', async () => {
    const { sources, clock, pool } = await open({ restore: false });
    const ledger = ledgerInstance();
    clock.now = T0;
    listenerOf(sources, 'profile')([{ runnerId: 'r-clock', ok: true }]);
    const first = ledger.healthOf('r-clock')?.profile?.at;
    clock.now = T0 + 5_000;
    listenerOf(sources, 'profile')([{ runnerId: 'r-clock', ok: true }]);
    const second = ledger.healthOf('r-clock')?.profile?.at;
    await pool.stop();
    listenerOf(sources, 'plugins')([{ runnerId: 'r-stopped', ok: false, error: 'x' }]);
    expect({ first, second, afterStop: ledger.healthOf('r-stopped') }).toMatchInlineSnapshot(`
      {
        "afterStop": undefined,
        "first": "2026-11-01T00:00:00.000Z",
        "second": "2026-11-01T00:00:05.000Z",
      }
    `);
  });
});
