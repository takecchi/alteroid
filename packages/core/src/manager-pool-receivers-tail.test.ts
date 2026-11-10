import { describe, expect, it, vi } from 'vitest';

import { createReceiversTail, type ReceiversTailDeps } from './manager-pool-receivers-tail.js';

// `createReceiversTail`（`Pool` の constructor の末尾で受け手 6 種を作る関数）を、偽の deps で直に縛る。
// 期待の順・欄名・同一参照は、切り出した時点の出力を目で読んで写したもの（仕様を先に書いたものではない）。
// `Pool` を通した配線は manager-pool-wiring-receivers-tail-pin.test.ts が縛る。ここは次の 5 つ:
//   - 6 つが `selfFenced → closedFront → reportApply → closedApply → closedNotice → note` の順に 1 回ずつ作られる
//   - 各協力者へ渡る ports の欄の全部（欄名の集合・順）
//   - deps の口と共有参照が同じ参照のまま渡る（`toBe`）。コピーしない
//   - `emit` は ClosedNotice/Note へはそのまま、SelfFenced/ClosedFront へは 3 引数に絞って渡る
//   - 戻り値は同期で（Promise でなく）返る

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

const TAIL = [
  'ManagerSelfFencedReceiver',
  'ManagerClosedFrontReceiver',
  'ManagerReportApply',
  'ManagerClosedApply',
  'ManagerClosedNotice',
  'ManagerNoteReceiver',
] as const;

type Fn = (...args: unknown[]) => unknown;

function fakeDeps() {
  const emit = vi.fn();
  const deps = {
    now: vi.fn(() => 1),
    nowIso: vi.fn(() => '2026-11-01T00:00:00.000Z'),
    emit,
    persist: vi.fn(),
    journal: vi.fn(),
    journalExchange: vi.fn(async () => undefined),
    withdrawWaiting: vi.fn(),
    scheduleReattach: vi.fn(),
    retire: vi.fn(),
    queueSynthesizedNotice: vi.fn(),
    withheld: {},
    synthesized: {},
    usageStopped: new Set<string>(),
    resetTimeSkewMatches: new Map(),
    workerLimitStopped: new Map(),
    tokenIdentities: new Map(),
  };
  return deps as unknown as ReceiversTailDeps & typeof deps;
}

function build() {
  spy.order.length = 0;
  spy.calls.length = 0;
  const deps = fakeDeps();
  const tail = createReceiversTail(deps);
  return { deps, tail };
}

function portsOf(name: string): Record<string, unknown> {
  const hits = spy.calls.filter((call) => call.name === name);
  expect(hits).toHaveLength(1);
  return hits[0]!.ports;
}

describe('createReceiversTail', () => {
  it('6 つをこの順で 1 回ずつ作り、戻り値の欄はその実体', () => {
    const { tail } = build();
    expect(spy.order).toEqual([...TAIL]);
    expect(Object.keys(tail)).toEqual([
      'selfFenced',
      'closedFront',
      'reportApply',
      'closedApply',
      'closedNotice',
      'note',
    ]);
    const instance = (name: string): object => spy.calls.find((c) => c.name === name)!.instance;
    expect(tail.selfFenced).toBe(instance('ManagerSelfFencedReceiver'));
    expect(tail.closedFront).toBe(instance('ManagerClosedFrontReceiver'));
    expect(tail.reportApply).toBe(instance('ManagerReportApply'));
    expect(tail.closedApply).toBe(instance('ManagerClosedApply'));
    expect(tail.closedNotice).toBe(instance('ManagerClosedNotice'));
    expect(tail.note).toBe(instance('ManagerNoteReceiver'));
  });

  it('渡る ports の欄の全部（欄名と順）', () => {
    build();
    const keys = Object.fromEntries(TAIL.map((name) => [name, Object.keys(portsOf(name))]));
    expect(keys).toEqual({
      ManagerSelfFencedReceiver: [
        'now',
        'journalExchange',
        'persist',
        'emit',
        'withdrawWaiting',
        'scheduleReattach',
      ],
      ManagerClosedFrontReceiver: ['nowIso', 'journalExchange', 'persist', 'emit', 'retire'],
      ManagerReportApply: ['nowIso', 'usageStopped', 'resetTimeSkewMatches'],
      ManagerClosedApply: ['now', 'nowIso', 'withdrawWaiting'],
      ManagerClosedNotice: [
        'persist',
        'journalExchange',
        'emit',
        'queueSynthesizedNotice',
        'withheld',
        'synthesized',
      ],
      ManagerNoteReceiver: [
        'persist',
        'journal',
        'journalExchange',
        'emit',
        'workerLimitStopped',
        'tokenIdentities',
      ],
    });
  });

  it('deps の口は同じ参照のまま渡る（束ね直さない）', () => {
    const { deps } = build();
    const same: [string, string, keyof typeof deps][] = [
      ['ManagerSelfFencedReceiver', 'now', 'now'],
      ['ManagerSelfFencedReceiver', 'journalExchange', 'journalExchange'],
      ['ManagerSelfFencedReceiver', 'persist', 'persist'],
      ['ManagerSelfFencedReceiver', 'withdrawWaiting', 'withdrawWaiting'],
      ['ManagerSelfFencedReceiver', 'scheduleReattach', 'scheduleReattach'],
      ['ManagerClosedFrontReceiver', 'nowIso', 'nowIso'],
      ['ManagerClosedFrontReceiver', 'journalExchange', 'journalExchange'],
      ['ManagerClosedFrontReceiver', 'persist', 'persist'],
      ['ManagerClosedFrontReceiver', 'retire', 'retire'],
      ['ManagerReportApply', 'nowIso', 'nowIso'],
      ['ManagerClosedApply', 'now', 'now'],
      ['ManagerClosedApply', 'nowIso', 'nowIso'],
      ['ManagerClosedApply', 'withdrawWaiting', 'withdrawWaiting'],
      ['ManagerClosedNotice', 'persist', 'persist'],
      ['ManagerClosedNotice', 'journalExchange', 'journalExchange'],
      ['ManagerClosedNotice', 'emit', 'emit'],
      ['ManagerClosedNotice', 'queueSynthesizedNotice', 'queueSynthesizedNotice'],
      ['ManagerNoteReceiver', 'persist', 'persist'],
      ['ManagerNoteReceiver', 'journal', 'journal'],
      ['ManagerNoteReceiver', 'journalExchange', 'journalExchange'],
      ['ManagerNoteReceiver', 'emit', 'emit'],
    ];
    for (const [name, key, depKey] of same) {
      expect(portsOf(name)[key], `${name}.${key}`).toBe(deps[depKey]);
    }
  });

  it('共有参照（Map/Set/withheld/synthesized）はコピーされず同じ物が渡る', () => {
    const { deps } = build();
    expect(portsOf('ManagerReportApply').usageStopped).toBe(deps.usageStopped);
    expect(portsOf('ManagerReportApply').resetTimeSkewMatches).toBe(deps.resetTimeSkewMatches);
    expect(portsOf('ManagerClosedNotice').withheld).toBe(deps.withheld);
    expect(portsOf('ManagerClosedNotice').synthesized).toBe(deps.synthesized);
    expect(portsOf('ManagerNoteReceiver').workerLimitStopped).toBe(deps.workerLimitStopped);
    expect(portsOf('ManagerNoteReceiver').tokenIdentities).toBe(deps.tokenIdentities);
  });

  it('emit: ClosedNotice/Note へは引数をそのまま、SelfFenced/ClosedFront へは 3 引数に絞って渡す', () => {
    const { deps } = build();
    const args = ['m1', 'report', 'text', 'req', 'markup', 'flush', 7, 8, 9];
    (portsOf('ManagerClosedNotice').emit as Fn)(...args);
    (portsOf('ManagerNoteReceiver').emit as Fn)(...args);
    expect(deps.emit.mock.calls).toEqual([args, args]);
    deps.emit.mockClear();
    (portsOf('ManagerSelfFencedReceiver').emit as Fn)(...args);
    (portsOf('ManagerClosedFrontReceiver').emit as Fn)(...args);
    expect(deps.emit.mock.calls).toEqual([
      ['m1', 'report', 'text'],
      ['m1', 'report', 'text'],
    ]);
    expect((portsOf('ManagerSelfFencedReceiver').emit as Fn).name).toBe('emit');
    expect((portsOf('ManagerSelfFencedReceiver').emit as Fn).length).toBe(3);
    expect((portsOf('ManagerClosedFrontReceiver').emit as Fn).length).toBe(3);
  });

  it('同期で値を返す（Promise でない）。deps の口は構築では呼ばれない', () => {
    spy.order.length = 0;
    spy.calls.length = 0;
    const deps = fakeDeps();
    const tail = createReceiversTail(deps);
    expect(tail).not.toBeInstanceOf(Promise);
    expect(typeof (tail as unknown as { then?: unknown }).then).toBe('undefined');
    for (const key of [
      'now',
      'nowIso',
      'emit',
      'persist',
      'journal',
      'journalExchange',
      'withdrawWaiting',
      'scheduleReattach',
      'retire',
      'queueSynthesizedNotice',
    ] as const) {
      expect(deps[key], key).not.toHaveBeenCalled();
    }
  });
});
