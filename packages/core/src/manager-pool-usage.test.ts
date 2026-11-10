import { describe, expect, it, vi } from 'vitest';

import { createUsageCollaborators, type UsageCollaboratorsDeps } from './manager-pool-usage.js';

// `createUsageCollaborators`（`Pool` の constructor で `UsageWake`・`StaleTokenFold`・`UsageReceiver` の 3 つを作る関数）を、偽の deps で直に縛る。
// 期待の順・欄名・同一参照は、切り出した時点の出力を目で読んで写したもの（仕様を先に書いたものではない）。
// `Pool` を通した配線は manager-pool-wiring-usage-pin.test.ts が縛る。ここは次の 9 つ:
//   - 3 つが `UsageWake → StaleTokenFold → UsageReceiver` の順に 1 回ずつ作られる
//   - 各協力者へ渡る ports の欄の全部（欄名の集合・順）
//   - deps の口と共有参照が同じ参照のまま渡る（`toBe`）。コピーしない
//   - `tokenAvailability` は undefined なら undefined のまま、有れば 1 引数だけ通す束ね直し
//   - `observeForTokenRotation`・`queueSynthesizedNotice` は UsageWake へそのまま、UsageReceiver へは別欄を束ね直して渡す（引数の数が違う）
//   - 口の関数の名前と引数の数（素通しと束ねた無名の関数の区別）
//   - lazy の口（`beforeWakes`・`rateLimits`・`lastStaleDecline`・`rememberStaleDecline`・`rememberResetTimeSkew`）は構築では評価されない
//   - 戻り値は同期で（Promise でなく）返る
//   - deps の口は構築では 1 つも呼ばれない

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
  return { order, calls, wrap };
});

vi.mock('./usage-wake.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./usage-wake.js')>();
  return { ...mod, UsageWake: spy.wrap('UsageWake', mod.UsageWake) };
});
vi.mock('./stale-token-fold.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./stale-token-fold.js')>();
  return { ...mod, StaleTokenFold: spy.wrap('StaleTokenFold', mod.StaleTokenFold) };
});
vi.mock('./usage-receiver.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./usage-receiver.js')>();
  return { ...mod, UsageReceiver: spy.wrap('UsageReceiver', mod.UsageReceiver) };
});

const TARGETS = ['UsageWake', 'StaleTokenFold', 'UsageReceiver'] as const;

type Fn = (...args: unknown[]) => unknown;

const CALLBACKS = [
  'now',
  'nowIso',
  'stopped',
  'load',
  'findJob',
  'persist',
  'journal',
  'journalExchange',
  'tokenIdentity',
  'send',
  'queueSynthesizedNotice',
  'receiverQueueSynthesizedNotice',
  'observeForTokenRotation',
  'receiverObserveForTokenRotation',
  'sessionTokenFingerprintOf',
  'observedTokenFingerprint',
  'movedAwayFrom',
  'unpushedWork',
  'beforeWakes',
  'rateLimits',
  'lastStaleDecline',
  'rememberStaleDecline',
  'rememberResetTimeSkew',
] as const;

const SHARED = [
  'records',
  'usageStopped',
  'usageWakeOwed',
  'usageWakeRetry',
  'usageNudgeInFlight',
  'workerLimitStopped',
  'workerLimitWakeRetry',
  'rotationFoldDueAt',
  'resetTimeSkewMatches',
  'supersedePending',
  'tokenIdentities',
  'resumedCount',
] as const;

function fakeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const deps = {
    stores: { kind: 'stores' },
    tokenAvailability: vi.fn(async () => 'ready' as const),
    records: new Map(),
    usageStopped: new Set<string>(),
    usageWakeOwed: new Set<string>(),
    usageWakeRetry: new Map(),
    usageNudgeInFlight: new Map(),
    workerLimitStopped: new Map(),
    workerLimitWakeRetry: new Map(),
    rotationFoldDueAt: new Map(),
    resetTimeSkewMatches: new Map(),
    supersedePending: new Map(),
    tokenIdentities: new Map(),
    resumedCount: new Map(),
    now: vi.fn(() => 1),
    nowIso: vi.fn(() => '2026-11-01T00:00:00.000Z'),
    stopped: vi.fn(() => false),
    load: vi.fn(async () => null),
    findJob: vi.fn(async () => undefined),
    persist: vi.fn(async () => undefined),
    journal: vi.fn(async () => undefined),
    journalExchange: vi.fn(async () => undefined),
    tokenIdentity: vi.fn(),
    send: vi.fn(async () => ({})),
    queueSynthesizedNotice: vi.fn(),
    receiverQueueSynthesizedNotice: vi.fn(),
    observeForTokenRotation: vi.fn(async () => undefined),
    receiverObserveForTokenRotation: vi.fn(async () => undefined),
    sessionTokenFingerprintOf: vi.fn(),
    observedTokenFingerprint: vi.fn(),
    movedAwayFrom: vi.fn(() => false),
    unpushedWork: vi.fn(async () => undefined),
    beforeWakes: vi.fn(async () => undefined),
    rateLimits: vi.fn(() => new Map()),
    lastStaleDecline: vi.fn(),
    rememberStaleDecline: vi.fn(),
    rememberResetTimeSkew: vi.fn(async () => undefined),
    ...overrides,
  };
  return { deps: deps as unknown as UsageCollaboratorsDeps & typeof deps };
}

function build(overrides: Partial<Record<string, unknown>> = {}) {
  spy.order.length = 0;
  spy.calls.length = 0;
  const fake = fakeDeps(overrides);
  const out = createUsageCollaborators(fake.deps);
  return { ...fake, out };
}

function portsOf(name: string): Record<string, unknown> {
  const hits = spy.calls.filter((call) => call.name === name);
  expect(hits).toHaveLength(1);
  return hits[0]!.ports;
}

describe('createUsageCollaborators', () => {
  it('3 つをこの順で 1 回ずつ作り、戻り値の欄はその実体', () => {
    const { out } = build();
    expect(spy.order).toEqual([...TARGETS]);
    expect(Object.keys(out)).toEqual(['usageWake', 'staleTokenFold', 'usageReceiver']);
    const instance = (name: string): object => spy.calls.find((c) => c.name === name)!.instance;
    expect(out.usageWake).toBe(instance('UsageWake'));
    expect(out.staleTokenFold).toBe(instance('StaleTokenFold'));
    expect(out.usageReceiver).toBe(instance('UsageReceiver'));
  });

  it('渡る ports の欄の全部（欄名と順）', () => {
    build();
    const keys = Object.fromEntries(TARGETS.map((name) => [name, Object.keys(portsOf(name))]));
    expect(keys).toEqual({
      UsageWake: [
        'records',
        'usageStopped',
        'usageWakeOwed',
        'usageWakeRetry',
        'usageNudgeInFlight',
        'workerLimitStopped',
        'workerLimitWakeRetry',
        'rotationFoldDueAt',
        'resetTimeSkewMatches',
        'supersedePending',
        'tokenIdentities',
        'stores',
        'now',
        'stopped',
        'load',
        'findJob',
        'persist',
        'journal',
        'journalExchange',
        'tokenIdentity',
        'tokenAvailability',
        'send',
        'queueSynthesizedNotice',
        'observeForTokenRotation',
        'sessionTokenFingerprintOf',
        'beforeWakes',
        'rateLimits',
      ],
      StaleTokenFold: [
        'resumedCount',
        'rotationFoldDueAt',
        'tokenIdentities',
        'tokenIdentity',
        'tokenAvailability',
        'sessionTokenFingerprintOf',
        'observedTokenFingerprint',
        'journal',
        'lastStaleDecline',
        'rememberStaleDecline',
        'unpushedWork',
      ],
      UsageReceiver: [
        'stores',
        'now',
        'nowIso',
        'tokenIdentities',
        'usageStopped',
        'journal',
        'journalExchange',
        'persist',
        'movedAwayFrom',
        'observeForTokenRotation',
        'rememberResetTimeSkew',
        'queueSynthesizedNotice',
      ],
    });
  });

  it('deps の口は同じ参照のまま渡る（束ね直さない）', () => {
    const { deps } = build();
    const same: [string, string, keyof typeof deps][] = [
      ['UsageWake', 'now', 'now'],
      ['UsageWake', 'stopped', 'stopped'],
      ['UsageWake', 'load', 'load'],
      ['UsageWake', 'findJob', 'findJob'],
      ['UsageWake', 'persist', 'persist'],
      ['UsageWake', 'journal', 'journal'],
      ['UsageWake', 'journalExchange', 'journalExchange'],
      ['UsageWake', 'tokenIdentity', 'tokenIdentity'],
      ['UsageWake', 'send', 'send'],
      ['UsageWake', 'queueSynthesizedNotice', 'queueSynthesizedNotice'],
      ['UsageWake', 'observeForTokenRotation', 'observeForTokenRotation'],
      ['UsageWake', 'sessionTokenFingerprintOf', 'sessionTokenFingerprintOf'],
      ['UsageWake', 'beforeWakes', 'beforeWakes'],
      ['UsageWake', 'rateLimits', 'rateLimits'],
      ['StaleTokenFold', 'tokenIdentity', 'tokenIdentity'],
      ['StaleTokenFold', 'sessionTokenFingerprintOf', 'sessionTokenFingerprintOf'],
      ['StaleTokenFold', 'observedTokenFingerprint', 'observedTokenFingerprint'],
      ['StaleTokenFold', 'journal', 'journal'],
      ['StaleTokenFold', 'lastStaleDecline', 'lastStaleDecline'],
      ['StaleTokenFold', 'rememberStaleDecline', 'rememberStaleDecline'],
      ['StaleTokenFold', 'unpushedWork', 'unpushedWork'],
      ['UsageReceiver', 'now', 'now'],
      ['UsageReceiver', 'nowIso', 'nowIso'],
      ['UsageReceiver', 'journal', 'journal'],
      ['UsageReceiver', 'journalExchange', 'journalExchange'],
      ['UsageReceiver', 'persist', 'persist'],
      ['UsageReceiver', 'movedAwayFrom', 'movedAwayFrom'],
      ['UsageReceiver', 'rememberResetTimeSkew', 'rememberResetTimeSkew'],
    ];
    for (const [name, key, depKey] of same) {
      expect(portsOf(name)[key], `${name}.${key}`).toBe(deps[depKey]);
    }
  });

  it('共有参照・引数の値はコピーされず同じ物が渡る', () => {
    const { deps } = build();
    const receivers: Record<string, readonly string[]> = {
      UsageWake: [
        'records',
        'usageStopped',
        'usageWakeOwed',
        'usageWakeRetry',
        'usageNudgeInFlight',
        'workerLimitStopped',
        'workerLimitWakeRetry',
        'rotationFoldDueAt',
        'resetTimeSkewMatches',
        'supersedePending',
        'tokenIdentities',
        'stores',
      ],
      StaleTokenFold: ['resumedCount', 'rotationFoldDueAt', 'tokenIdentities'],
      UsageReceiver: ['stores', 'tokenIdentities', 'usageStopped'],
    };
    for (const [name, keys] of Object.entries(receivers)) {
      for (const key of keys) {
        expect(portsOf(name)[key], `${name}.${key}`).toBe(
          (deps as unknown as Record<string, unknown>)[key],
        );
      }
    }
    // 片方へ書くともう片方から見える（3 つの協力者が同じ Map/Set を見る）
    (portsOf('UsageWake').tokenIdentities as Map<string, unknown>).set('probe', 1);
    expect(deps.tokenIdentities.get('probe')).toBe(1);
    expect((portsOf('StaleTokenFold').tokenIdentities as Map<string, unknown>).get('probe')).toBe(
      1,
    );
    expect((portsOf('UsageReceiver').tokenIdentities as Map<string, unknown>).get('probe')).toBe(1);
    (portsOf('UsageWake').rotationFoldDueAt as Map<string, number>).set('probe', 2);
    expect((portsOf('StaleTokenFold').rotationFoldDueAt as Map<string, number>).get('probe')).toBe(
      2,
    );
    (portsOf('UsageReceiver').usageStopped as Set<string>).add('probe');
    expect((portsOf('UsageWake').usageStopped as Set<string>).has('probe')).toBe(true);
    // 共有コンテナ 12 本は互いに別の物（取り違えを区別できる形で渡している）
    const seen = new Set<unknown>(SHARED.map((key) => deps[key]));
    expect(seen.size).toBe(SHARED.length);
  });

  it('tokenAvailability: 未指定なら 2 つとも undefined、有れば 1 引数だけ通す束ね直し', async () => {
    build({ tokenAvailability: undefined });
    expect(portsOf('UsageWake').tokenAvailability).toBeUndefined();
    expect(portsOf('StaleTokenFold').tokenAvailability).toBeUndefined();

    const { deps } = build();
    for (const name of ['UsageWake', 'StaleTokenFold']) {
      const port = portsOf(name).tokenAvailability as Fn;
      expect(port).not.toBe(deps.tokenAvailability);
      // 三項演算子の枝の無名の矢印なので名前は付かない（切り出す前も同じ）
      expect(`${port.name}/${String(port.length)}`).toBe('/1');
      await expect(port('tok-1', 'extra')).resolves.toBe('ready');
    }
    expect(deps.tokenAvailability.mock.calls).toEqual([['tok-1'], ['tok-1']]);
  });

  it('observeForTokenRotation・queueSynthesizedNotice: UsageWake へはそのまま、UsageReceiver へは別欄を束ね直す', async () => {
    const { deps } = build();
    const observation = { kind: 'probe' };
    await (portsOf('UsageReceiver').observeForTokenRotation as Fn)('m1', observation, 'ignored');
    expect(deps.receiverObserveForTokenRotation.mock.calls).toEqual([['m1', observation]]);
    expect(deps.receiverObserveForTokenRotation.mock.calls[0]).toHaveLength(2);
    expect(deps.observeForTokenRotation).not.toHaveBeenCalled();

    const mark = { at: 1 };
    (portsOf('UsageReceiver').queueSynthesizedNotice as Fn)('m1', 'usage_limit', 'x', mark);
    expect(deps.receiverQueueSynthesizedNotice.mock.calls).toEqual([
      ['m1', 'usage_limit', 'x', mark],
    ]);
    expect(deps.receiverQueueSynthesizedNotice.mock.calls[0]![3]).toBe(mark);
    expect(deps.queueSynthesizedNotice).not.toHaveBeenCalled();

    await (portsOf('UsageWake').observeForTokenRotation as Fn)('m2', observation, 'held-fp');
    expect(deps.observeForTokenRotation.mock.calls).toEqual([['m2', observation, 'held-fp']]);
    (portsOf('UsageWake').queueSynthesizedNotice as Fn)('m2', 'usage_rotation', 'y');
    expect(deps.queueSynthesizedNotice.mock.calls).toEqual([['m2', 'usage_rotation', 'y']]);
    expect(deps.receiverObserveForTokenRotation).toHaveBeenCalledTimes(1);
    expect(deps.receiverQueueSynthesizedNotice).toHaveBeenCalledTimes(1);
  });

  it('口の関数の名前と引数の数（素通しと束ねた無名の関数の区別）', () => {
    const { deps } = build();
    const passed = new Set<unknown>(Object.values(deps));
    const bundled = Object.fromEntries(
      TARGETS.map((name) => [
        name,
        Object.fromEntries(
          Object.entries(portsOf(name))
            .filter(([, value]) => typeof value === 'function' && !passed.has(value))
            .map(([key, value]) => [key, `${(value as Fn).name}/${String((value as Fn).length)}`]),
        ),
      ]),
    );
    // deps の口そのものでない（このファクトリが束ねた）関数だけ。ほかの口は上の「同じ参照」で縛っている
    expect(bundled).toEqual({
      UsageWake: { tokenAvailability: '/1' },
      StaleTokenFold: { tokenAvailability: '/1' },
      UsageReceiver: {
        observeForTokenRotation: 'observeForTokenRotation/2',
        queueSynthesizedNotice: 'queueSynthesizedNotice/4',
      },
    });
  });

  it('lazy の口は構築では評価されない。構築の瞬間に呼ぶと失敗する口の先でも作れる', () => {
    let ready = false;
    const guard = <T>(value: T) =>
      vi.fn(() => {
        if (!ready) throw new TypeError('not built yet');
        return value;
      });
    const rateLimits = guard(new Map());
    const beforeWakes = guard(Promise.resolve());
    const lastStaleDecline = guard('declined');
    const rememberStaleDecline = guard(undefined);
    const rememberResetTimeSkew = guard(Promise.resolve());
    const { out } = build({
      rateLimits,
      beforeWakes,
      lastStaleDecline,
      rememberStaleDecline,
      rememberResetTimeSkew,
    });
    for (const fn of [
      rateLimits,
      beforeWakes,
      lastStaleDecline,
      rememberStaleDecline,
      rememberResetTimeSkew,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
    ready = true;
    expect(out.usageWake).toBeDefined();
    expect((portsOf('UsageWake').rateLimits as Fn)()).toBeInstanceOf(Map);
    expect((portsOf('StaleTokenFold').lastStaleDecline as Fn)('m')).toBe('declined');
    expect(rateLimits).toHaveBeenCalledTimes(1);
    expect(lastStaleDecline).toHaveBeenCalledTimes(1);
  });

  it('同期で値を返す（Promise でない）。deps の口は構築では 1 つも呼ばれない', () => {
    const { out, deps } = build();
    expect(out).not.toBeInstanceOf(Promise);
    expect(typeof (out as unknown as { then?: unknown }).then).toBe('undefined');
    for (const key of CALLBACKS) {
      expect(deps[key], key).not.toHaveBeenCalled();
    }
    expect(deps.tokenAvailability).not.toHaveBeenCalled();
  });
});
