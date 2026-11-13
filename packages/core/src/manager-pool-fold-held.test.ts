import { describe, expect, it, vi } from 'vitest';

import { createFoldHeld, type FoldHeldDeps } from './manager-pool-fold-held.js';

// `createFoldHeld`（`Pool` の constructor で `AutoFold`・`DenialRenotifier`・`RescueSweeper`・`AttachmentStager`・`ManagerRescueStash`・`HeldMessages` の 6 つを作る関数）を、偽の deps で直に縛る。
// 期待の順・欄名・同一参照は、切り出した時点の出力を目で読んで写したもの（仕様を先に書いたものではない）。
// `Pool` を通した配線は manager-pool-wiring-fold-held-pin.test.ts が縛る。ここは次の 8 つ:
//   - 6 つが `AutoFold → DenialRenotifier → RescueSweeper → AttachmentStager → ManagerRescueStash → HeldMessages` の順に 1 回ずつ作られる
//   - 各協力者へ渡る ports の欄の全部（欄名の集合・順）
//   - deps の口と共有参照が同じ参照のまま渡る（`toBe`）。コピーしない
//   - `retainedIds` は呼ぶまで評価されない（構築の瞬間に呼ばれない）。`HeldMessages` は最後に作るので、構築の瞬間に呼ぶ口の先はまだ無い
//   - 束ね直す口（`emitReport`・`hasCapability`・`instanceIdOf`・2 つの `send`）の渡す引数
//   - 口の関数の名前と引数の数（素通しと束ねた無名の関数の区別）
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

vi.mock('./auto-fold.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./auto-fold.js')>();
  return { ...mod, AutoFold: spy.wrap('AutoFold', mod.AutoFold) };
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

const TARGETS = [
  'AutoFold',
  'DenialRenotifier',
  'RescueSweeper',
  'AttachmentStager',
  'ManagerRescueStash',
  'HeldMessages',
] as const;

type Fn = (...args: unknown[]) => unknown;

const CALLBACKS = [
  'now',
  'nowIso',
  'stopped',
  'retainedIds',
  'journal',
  'persist',
  'load',
  'send',
  'emit',
  'queueNotice',
  'runnerHasCapability',
  'findJob',
  'runnerIdOf',
  'list',
  'observeUnpushedWork',
  'abort',
  'runnerOf',
  'runnersOrEmpty',
  'runnerOrNull',
  'awaitHello',
  'openAttachment',
  'sighting',
  'swapNote',
] as const;

function fakeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const deps = {
    runners: { kind: 'registry' },
    stores: { kind: 'stores' },
    attachmentLimits: { maxImageBytes: 1 },
    records: new Map(),
    usageStopped: new Set<string>(),
    resuming: new Set<string>(),
    now: vi.fn(() => 1),
    nowIso: vi.fn(() => '2026-11-01T00:00:00.000Z'),
    stopped: vi.fn(() => false),
    retainedIds: vi.fn(() => ['retained']),
    journal: vi.fn(),
    persist: vi.fn(),
    load: vi.fn(async () => null),
    send: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'sent'),
    emit: vi.fn(),
    queueNotice: vi.fn(),
    runnerHasCapability: vi.fn(() => true),
    findJob: vi.fn(),
    runnerIdOf: vi.fn(),
    list: vi.fn(),
    observeUnpushedWork: vi.fn(),
    abort: vi.fn(),
    runnerOf: vi.fn(),
    runnersOrEmpty: vi.fn(),
    runnerOrNull: vi.fn(),
    awaitHello: vi.fn(),
    openAttachment: vi.fn(),
    sighting: vi.fn(() => ({ instanceId: 'inst-1' })),
    swapNote: vi.fn(),
    ...overrides,
  };
  return { deps: deps as unknown as FoldHeldDeps & typeof deps };
}

function build(overrides: Partial<Record<string, unknown>> = {}) {
  spy.order.length = 0;
  spy.calls.length = 0;
  const fake = fakeDeps(overrides);
  const out = createFoldHeld(fake.deps);
  return { ...fake, out };
}

function portsOf(name: string): Record<string, unknown> {
  const hits = spy.calls.filter((call) => call.name === name);
  expect(hits).toHaveLength(1);
  return hits[0]!.ports;
}

describe('createFoldHeld', () => {
  it('6 つをこの順で 1 回ずつ作り、戻り値の欄はその実体', () => {
    const { out } = build();
    expect(spy.order).toEqual([...TARGETS]);
    expect(Object.keys(out)).toEqual([
      'autoFold',
      'denialRenotifier',
      'rescueSweeper',
      'attachmentStager',
      'rescueStash',
      'held',
    ]);
    const instance = (name: string): object => spy.calls.find((c) => c.name === name)!.instance;
    expect(out.autoFold).toBe(instance('AutoFold'));
    expect(out.denialRenotifier).toBe(instance('DenialRenotifier'));
    expect(out.rescueSweeper).toBe(instance('RescueSweeper'));
    expect(out.attachmentStager).toBe(instance('AttachmentStager'));
    expect(out.rescueStash).toBe(instance('ManagerRescueStash'));
    expect(out.held).toBe(instance('HeldMessages'));
  });

  it('渡る ports の欄の全部（欄名と順）', () => {
    build();
    const keys = Object.fromEntries(TARGETS.map((name) => [name, Object.keys(portsOf(name))]));
    expect(keys).toEqual({
      AutoFold: [
        'runners',
        'now',
        'stopped',
        'retainedIds',
        'runnerHasCapability',
        'findJob',
        'runnerIdOf',
        'list',
        'observeUnpushedWork',
        'abort',
        'journal',
      ],
      DenialRenotifier: ['records', 'now', 'stopped', 'emitReport'],
      RescueSweeper: [
        'records',
        'stores',
        'now',
        'nowIso',
        'stopped',
        'journal',
        'persist',
        'runnerOf',
        'runnersOrEmpty',
      ],
      AttachmentStager: ['awaitHello', 'hasCapability', 'openAttachment'],
      ManagerRescueStash: [
        'stores',
        'attachmentLimits',
        'runnerOrNull',
        'runnerHasCapability',
        'instanceIdOf',
        'swapNote',
        'nowIso',
        'persist',
        'journal',
        'records',
        'load',
        'send',
      ],
      HeldMessages: [
        'records',
        'load',
        'persist',
        'journal',
        'queueNotice',
        'send',
        'now',
        'nowIso',
        'stopped',
        'usageStopped',
        'resuming',
      ],
    });
  });

  it('deps の口は同じ参照のまま渡る（束ね直さない）', () => {
    const { deps } = build();
    const same: [string, string, keyof typeof deps][] = [
      ['AutoFold', 'now', 'now'],
      ['AutoFold', 'stopped', 'stopped'],
      ['AutoFold', 'retainedIds', 'retainedIds'],
      ['AutoFold', 'runnerHasCapability', 'runnerHasCapability'],
      ['AutoFold', 'findJob', 'findJob'],
      ['AutoFold', 'runnerIdOf', 'runnerIdOf'],
      ['AutoFold', 'list', 'list'],
      ['AutoFold', 'observeUnpushedWork', 'observeUnpushedWork'],
      ['AutoFold', 'abort', 'abort'],
      ['AutoFold', 'journal', 'journal'],
      ['DenialRenotifier', 'now', 'now'],
      ['DenialRenotifier', 'stopped', 'stopped'],
      ['RescueSweeper', 'now', 'now'],
      ['RescueSweeper', 'nowIso', 'nowIso'],
      ['RescueSweeper', 'stopped', 'stopped'],
      ['RescueSweeper', 'journal', 'journal'],
      ['RescueSweeper', 'persist', 'persist'],
      ['RescueSweeper', 'runnerOf', 'runnerOf'],
      ['RescueSweeper', 'runnersOrEmpty', 'runnersOrEmpty'],
      ['AttachmentStager', 'awaitHello', 'awaitHello'],
      ['AttachmentStager', 'openAttachment', 'openAttachment'],
      ['ManagerRescueStash', 'runnerOrNull', 'runnerOrNull'],
      ['ManagerRescueStash', 'runnerHasCapability', 'runnerHasCapability'],
      ['ManagerRescueStash', 'swapNote', 'swapNote'],
      ['ManagerRescueStash', 'nowIso', 'nowIso'],
      ['ManagerRescueStash', 'persist', 'persist'],
      ['ManagerRescueStash', 'journal', 'journal'],
      ['ManagerRescueStash', 'load', 'load'],
      ['HeldMessages', 'load', 'load'],
      ['HeldMessages', 'persist', 'persist'],
      ['HeldMessages', 'journal', 'journal'],
      ['HeldMessages', 'queueNotice', 'queueNotice'],
      ['HeldMessages', 'now', 'now'],
      ['HeldMessages', 'nowIso', 'nowIso'],
      ['HeldMessages', 'stopped', 'stopped'],
    ];
    for (const [name, key, depKey] of same) {
      expect(portsOf(name)[key], `${name}.${key}`).toBe(deps[depKey]);
    }
  });

  it('共有参照・引数の値はコピーされず同じ物が渡る', () => {
    const { deps } = build();
    for (const name of [
      'DenialRenotifier',
      'RescueSweeper',
      'ManagerRescueStash',
      'HeldMessages',
    ]) {
      expect(portsOf(name).records, `${name}.records`).toBe(deps.records);
    }
    expect(portsOf('HeldMessages').usageStopped).toBe(deps.usageStopped);
    expect(portsOf('HeldMessages').resuming).toBe(deps.resuming);
    expect(portsOf('AutoFold').runners).toBe(deps.runners);
    expect(portsOf('RescueSweeper').stores).toBe(deps.stores);
    expect(portsOf('ManagerRescueStash').stores).toBe(deps.stores);
    expect(portsOf('ManagerRescueStash').attachmentLimits).toBe(deps.attachmentLimits);
    // 片方へ書くともう片方から見える
    (portsOf('HeldMessages').records as Map<string, unknown>).set('probe', 1);
    expect(deps.records.get('probe')).toBe(1);
    (portsOf('HeldMessages').usageStopped as Set<string>).add('probe');
    expect(deps.usageStopped.has('probe')).toBe(true);
  });

  it('attachmentLimits が未指定なら未指定のまま渡る', () => {
    build({ attachmentLimits: undefined });
    expect(portsOf('ManagerRescueStash').attachmentLimits).toBeUndefined();
  });

  it('retainedIds は呼ぶまで評価されない。構築の瞬間に呼ぶと失敗する口の先でも作れる', () => {
    let held = false;
    const retainedIds = vi.fn(() => {
      if (!held) throw new TypeError('held is not built yet');
      return ['x'];
    });
    const { out } = build({ retainedIds });
    expect(retainedIds).not.toHaveBeenCalled();
    held = true;
    expect(out.held).toBeDefined();
    expect((portsOf('AutoFold').retainedIds as Fn)()).toEqual(['x']);
    expect(retainedIds).toHaveBeenCalledTimes(1);
  });

  it('束ね直す口: emitReport は 3 引数（kind は report 固定）、hasCapability・instanceIdOf は引数をそのまま渡す', () => {
    const { deps } = build();
    const emitReport = portsOf('DenialRenotifier').emitReport as Fn;
    expect(emitReport('m1', 'text', 'extra')).toBeUndefined();
    expect(deps.emit.mock.calls).toEqual([['m1', 'report', 'text']]);
    const hasCapability = portsOf('AttachmentStager').hasCapability as Fn;
    expect(hasCapability('r1', 'cap')).toBe(true);
    expect(deps.runnerHasCapability.mock.calls).toEqual([['r1', 'cap']]);
    const instanceIdOf = portsOf('ManagerRescueStash').instanceIdOf as Fn;
    expect(instanceIdOf('r2')).toBe('inst-1');
    expect(deps.sighting.mock.calls).toEqual([['r2']]);
  });

  it('send: RescueStash は届け方を caller 固定、HeldMessages は options を {} 固定で届け方を素通し', async () => {
    const { deps } = build();
    const stashSend = portsOf('ManagerRescueStash').send as Fn;
    const options = { source: 'stash' };
    await expect(stashSend('m1', 'text', options)).resolves.toBe('sent');
    expect(deps.send.mock.calls).toHaveLength(1);
    expect(deps.send.mock.calls[0]).toEqual(['m1', 'text', options, { mode: 'caller' }]);
    expect(deps.send.mock.calls[0]![2]).toBe(options);
    deps.send.mockClear();
    const heldSend = portsOf('HeldMessages').send as Fn;
    const delivery = { mode: 'held-delivery' };
    await expect(heldSend('m2', 'body', delivery)).resolves.toBe('sent');
    expect(deps.send.mock.calls).toHaveLength(1);
    expect(deps.send.mock.calls[0]).toEqual(['m2', 'body', {}, delivery]);
    expect(deps.send.mock.calls[0]![3]).toBe(delivery);
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
      AutoFold: {},
      DenialRenotifier: { emitReport: 'emitReport/2' },
      RescueSweeper: {},
      AttachmentStager: { hasCapability: 'hasCapability/2' },
      ManagerRescueStash: { instanceIdOf: 'instanceIdOf/1', send: 'send/3' },
      HeldMessages: { send: 'send/3' },
    });
  });

  it('同期で値を返す（Promise でない）。deps の口は構築では 1 つも呼ばれない', () => {
    const { out, deps } = build();
    expect(out).not.toBeInstanceOf(Promise);
    expect(typeof (out as unknown as { then?: unknown }).then).toBe('undefined');
    for (const key of CALLBACKS) {
      expect(deps[key], key).not.toHaveBeenCalled();
    }
  });
});
