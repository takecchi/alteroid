import { describe, expect, it, vi } from 'vitest';

import {
  createArchiveAndEventReceivers,
  type ArchiveAndEventReceiversDeps,
} from './manager-pool-archive-receivers.js';

// `createArchiveAndEventReceivers`（`Pool` の constructor で生ログの受け手と出来事の受け手 6 種を作る関数）を、偽の deps で直に縛る。
// 期待の順・欄名・同一参照は、切り出した時点の出力を目で読んで写したもの（仕様を先に書いたものではない）。
// `Pool` を通した配線は manager-pool-wiring-archive-receivers-pin.test.ts が縛る。ここは次の 6 つ:
//   - 6 つが `archiveReceiver → denial → session → toolUse → parkedPeers → waiting` の順に 1 回ずつ作られる
//   - 各協力者へ渡る ports の欄の全部（欄名の集合・順）
//   - deps の口と値が同じ参照のまま渡る（`toBe`）。コピーしない
//   - `sessionLoaders` は呼ぶたびにメソッドを読む（構築時に取り出さない）。引数はそのまま渡る
//   - `emit` は Denial/ParkedPeers へは 3 引数、Waiting へは 5 引数に絞って渡す
//   - 戻り値は同期で（Promise でなく）返り、構築では deps の口は 1 つも呼ばれない

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

const TARGETS = [
  'ArchiveReceiver',
  'ManagerDenialReceiver',
  'ManagerSessionReceiver',
  'ManagerToolUseReceiver',
  'ManagerParkedPeersReceiver',
  'ManagerWaitingReceiver',
] as const;

type Fn = (...args: unknown[]) => unknown;

function fakeDeps() {
  const sessionLoaders = {
    fetchArchiveRetrying: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'fetched'),
    appendMirrorRetrying: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'appended'),
  };
  const deps = {
    stores: { archive: {}, sessionStore: {} },
    sessionLoaders,
    nowIso: vi.fn(() => '2026-11-01T00:00:00.000Z'),
    emit: vi.fn(),
    persist: vi.fn(),
    journal: vi.fn(),
    journalExchange: vi.fn(async () => undefined),
    noteRunnerSessionSince: vi.fn(),
    observeUnpushedWorkOnce: vi.fn(),
    rememberPluginLoad: vi.fn(),
  };
  return deps;
}

function build() {
  spy.order.length = 0;
  spy.calls.length = 0;
  const deps = fakeDeps();
  const result = createArchiveAndEventReceivers(deps as unknown as ArchiveAndEventReceiversDeps);
  return { deps, result };
}

function portsOf(name: string): Record<string, unknown> {
  const hits = spy.calls.filter((call) => call.name === name);
  expect(hits).toHaveLength(1);
  return hits[0]!.ports;
}

describe('createArchiveAndEventReceivers', () => {
  it('6 つをこの順で 1 回ずつ作り、戻り値の欄はその実体', () => {
    const { result } = build();
    expect(spy.order).toEqual([...TARGETS]);
    expect(Object.keys(result)).toEqual([
      'archiveReceiver',
      'denial',
      'session',
      'toolUse',
      'parkedPeers',
      'waiting',
    ]);
    const instance = (name: string): object => spy.calls.find((c) => c.name === name)!.instance;
    expect(result.archiveReceiver).toBe(instance('ArchiveReceiver'));
    expect(result.denial).toBe(instance('ManagerDenialReceiver'));
    expect(result.session).toBe(instance('ManagerSessionReceiver'));
    expect(result.toolUse).toBe(instance('ManagerToolUseReceiver'));
    expect(result.parkedPeers).toBe(instance('ManagerParkedPeersReceiver'));
    expect(result.waiting).toBe(instance('ManagerWaitingReceiver'));
  });

  it('渡る ports の欄の全部（欄名と順）', () => {
    build();
    const keys = Object.fromEntries(TARGETS.map((name) => [name, Object.keys(portsOf(name))]));
    expect(keys).toEqual({
      ArchiveReceiver: [
        'stores',
        'fetchArchiveRetrying',
        'appendMirrorRetrying',
        'persist',
        'journalExchange',
      ],
      ManagerDenialReceiver: ['nowIso', 'journalExchange', 'emit'],
      ManagerSessionReceiver: [
        'nowIso',
        'journalExchange',
        'persist',
        'noteRunnerSessionSince',
        'rememberPluginLoad',
      ],
      ManagerToolUseReceiver: ['nowIso', 'journal', 'observeUnpushedWorkOnce'],
      ManagerParkedPeersReceiver: ['nowIso', 'emit', 'persist'],
      ManagerWaitingReceiver: ['persist', 'journal', 'journalExchange', 'emit', 'nowIso'],
    });
  });

  it('deps の口と値は同じ参照のまま渡る（束ね直さない）', () => {
    const { deps } = build();
    const same: [string, string, keyof typeof deps][] = [
      ['ArchiveReceiver', 'stores', 'stores'],
      ['ArchiveReceiver', 'persist', 'persist'],
      ['ArchiveReceiver', 'journalExchange', 'journalExchange'],
      ['ManagerDenialReceiver', 'nowIso', 'nowIso'],
      ['ManagerDenialReceiver', 'journalExchange', 'journalExchange'],
      ['ManagerSessionReceiver', 'nowIso', 'nowIso'],
      ['ManagerSessionReceiver', 'journalExchange', 'journalExchange'],
      ['ManagerSessionReceiver', 'persist', 'persist'],
      ['ManagerSessionReceiver', 'noteRunnerSessionSince', 'noteRunnerSessionSince'],
      ['ManagerSessionReceiver', 'rememberPluginLoad', 'rememberPluginLoad'],
      ['ManagerToolUseReceiver', 'nowIso', 'nowIso'],
      ['ManagerToolUseReceiver', 'journal', 'journal'],
      ['ManagerToolUseReceiver', 'observeUnpushedWorkOnce', 'observeUnpushedWorkOnce'],
      ['ManagerParkedPeersReceiver', 'nowIso', 'nowIso'],
      ['ManagerParkedPeersReceiver', 'persist', 'persist'],
      ['ManagerWaitingReceiver', 'persist', 'persist'],
      ['ManagerWaitingReceiver', 'journal', 'journal'],
      ['ManagerWaitingReceiver', 'journalExchange', 'journalExchange'],
      ['ManagerWaitingReceiver', 'nowIso', 'nowIso'],
    ];
    for (const [name, key, depKey] of same) {
      expect(portsOf(name)[key], `${name}.${key}`).toBe(deps[depKey]);
    }
  });

  it('sessionLoaders は呼ぶたびにメソッドを読み、引数はそのまま渡る（構築後の差し替えにも届く）', async () => {
    const { deps } = build();
    const archive = portsOf('ArchiveReceiver');
    const store = {};
    const event = {};
    await (archive.fetchArchiveRetrying as Fn)('m1', 'a1', 'r1');
    await (archive.appendMirrorRetrying as Fn)(store, event);
    expect(deps.sessionLoaders.fetchArchiveRetrying.mock.calls).toEqual([['m1', 'a1', 'r1']]);
    expect(deps.sessionLoaders.appendMirrorRetrying.mock.calls).toEqual([[store, event]]);
    expect(deps.sessionLoaders.appendMirrorRetrying.mock.calls[0]![0]).toBe(store);
    expect(deps.sessionLoaders.appendMirrorRetrying.mock.calls[0]![1]).toBe(event);
    const replacedFetch = vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'second');
    const replacedAppend = vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'second');
    deps.sessionLoaders.fetchArchiveRetrying = replacedFetch;
    deps.sessionLoaders.appendMirrorRetrying = replacedAppend;
    expect(await (archive.fetchArchiveRetrying as Fn)('m2', 'a2', 'r2')).toBe('second');
    expect(await (archive.appendMirrorRetrying as Fn)(store, event)).toBe('second');
    expect(replacedFetch.mock.calls).toEqual([['m2', 'a2', 'r2']]);
    expect(replacedAppend.mock.calls).toEqual([[store, event]]);
  });

  it('emit: Denial/ParkedPeers へは 3 引数、Waiting へは 5 引数に絞って渡す', () => {
    const { deps } = build();
    const args = ['m1', 'report', 'text', 'req', 'markup', 'flush', 7];
    (portsOf('ManagerDenialReceiver').emit as Fn)(...args);
    (portsOf('ManagerParkedPeersReceiver').emit as Fn)(...args);
    expect(deps.emit.mock.calls).toEqual([
      ['m1', 'report', 'text'],
      ['m1', 'report', 'text'],
    ]);
    deps.emit.mockClear();
    (portsOf('ManagerWaitingReceiver').emit as Fn)(...args);
    expect(deps.emit.mock.calls).toEqual([['m1', 'report', 'text', 'req', 'markup']]);
    expect((portsOf('ManagerDenialReceiver').emit as Fn).length).toBe(3);
    expect((portsOf('ManagerParkedPeersReceiver').emit as Fn).length).toBe(3);
    expect((portsOf('ManagerWaitingReceiver').emit as Fn).length).toBe(5);
  });

  it('同期で値を返す（Promise でない）。deps の口は構築では呼ばれない', () => {
    const { deps, result } = build();
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as unknown as { then?: unknown }).then).toBe('undefined');
    for (const key of [
      'nowIso',
      'emit',
      'persist',
      'journal',
      'journalExchange',
      'noteRunnerSessionSince',
      'observeUnpushedWorkOnce',
      'rememberPluginLoad',
    ] as const) {
      expect(deps[key], key).not.toHaveBeenCalled();
    }
    expect(deps.sessionLoaders.fetchArchiveRetrying).not.toHaveBeenCalled();
    expect(deps.sessionLoaders.appendMirrorRetrying).not.toHaveBeenCalled();
  });
});
