import { describe, expect, it, vi } from 'vitest';

import { createWindows, type WindowsDeps } from './manager-pool-windows.js';
import { QUOTA_STOP_WINDOW_MS } from './quota-stop-notice.js';
import { RESUME_CONFIRM_TIMEOUT_MS } from './resume-confirmation.js';
import { resolveSynthesizedNoticeWindowMs } from './synthesized-notice.js';

// `createWindows`（`Pool` の constructor で窓 4 種を作る関数）を、偽の deps で直に縛る。
// 期待の順・欄名・同一参照は、切り出した時点の出力を目で読んで写したもの（仕様を先に書いたものではない）。
// `Pool` を通した配線は manager-pool-wiring-windows-pin.test.ts が縛る。ここは次の 7 つ:
//   - 4 つが `quotaWindows → synthesized → restored → resumeWindows` の順に 1 回ずつ作られる
//   - 各協力者へ渡る ports の欄の全部（欄名の集合・順）
//   - deps の口と共有参照が同じ参照のまま渡る（`toBe`）。コピーしない
//   - `withheld.carriedToWindow` の取り出しはファクトリの呼び出しの中で 1 回（eager）。`takeForDelivery` は呼ばれた時に引く
//   - Synthesized へ渡る quota は Quota の実体。Restored の `trackFlush` はその quota を呼ぶ
//   - 窓の長さ・確認の待ち時間は、指定があればそのまま、未指定なら既定値へ解決する
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

const WINDOWS = [
  'QuotaStopWindows',
  'SynthesizedNoticeWindows',
  'RestoredWindows',
  'ResumeEventWindows',
] as const;

type Fn = (...args: unknown[]) => unknown;

function fakeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const carried = new Map();
  const counts = { carriedToWindow: 0 };
  const takeForDelivery = vi.fn(() => 'taken');
  const withheld = {
    get carriedToWindow() {
      counts.carriedToWindow += 1;
      return carried;
    },
    takeForDelivery,
  };
  const deps = {
    records: new Map(),
    tokenIdentities: new Map(),
    supersedePending: new Map(),
    withheld,
    quotaStopWindowMs: 111,
    synthesizedNoticeWindowMs: 222,
    resumeConfirmTimeoutMs: 333,
    notifyExcerptLines: 5,
    trackedGenerationSilent: vi.fn(() => false),
    now: vi.fn(() => 1),
    nowIso: vi.fn(() => '2026-11-01T00:00:00.000Z'),
    post: vi.fn(),
    journalExchange: vi.fn(async () => undefined),
    listJobsOrNote: vi.fn(async () => null),
    postReport: vi.fn(),
    queueNotice: vi.fn(),
    statusAtDelivery: vi.fn(),
    stopped: vi.fn(() => false),
    judgeSessionGeneration: vi.fn(),
    onEvent: vi.fn(),
    droppedReportFiles: vi.fn(),
    journal: vi.fn(),
    ...overrides,
  };
  return { deps: deps as unknown as WindowsDeps & typeof deps, carried, counts, takeForDelivery };
}

function build(overrides: Partial<Record<string, unknown>> = {}) {
  spy.order.length = 0;
  spy.calls.length = 0;
  const fake = fakeDeps(overrides);
  const windows = createWindows(fake.deps);
  return { ...fake, windows };
}

function portsOf(name: string): Record<string, unknown> {
  const hits = spy.calls.filter((call) => call.name === name);
  expect(hits).toHaveLength(1);
  return hits[0]!.ports;
}

describe('createWindows', () => {
  it('4 つをこの順で 1 回ずつ作り、戻り値の欄はその実体', () => {
    const { windows } = build();
    expect(spy.order).toEqual([...WINDOWS]);
    expect(Object.keys(windows)).toEqual([
      'quotaWindows',
      'synthesized',
      'restored',
      'resumeWindows',
    ]);
    const instance = (name: string): object => spy.calls.find((c) => c.name === name)!.instance;
    expect(windows.quotaWindows).toBe(instance('QuotaStopWindows'));
    expect(windows.synthesized).toBe(instance('SynthesizedNoticeWindows'));
    expect(windows.restored).toBe(instance('RestoredWindows'));
    expect(windows.resumeWindows).toBe(instance('ResumeEventWindows'));
  });

  it('渡る ports の欄の全部（欄名と順）', () => {
    build();
    const keys = Object.fromEntries(WINDOWS.map((name) => [name, Object.keys(portsOf(name))]));
    expect(keys).toEqual({
      QuotaStopWindows: [
        'records',
        'journalExchange',
        'post',
        'listJobsOrNote',
        'withheldCarriedToWindow',
        'now',
        'nowIso',
        'windowMs',
      ],
      SynthesizedNoticeWindows: [
        'records',
        'tokenIdentities',
        'supersedePending',
        'quotaWindows',
        'takeWithheldForDelivery',
        'post',
        'statusAtDelivery',
        'journalExchange',
        'now',
        'nowIso',
        'windowMs',
      ],
      RestoredWindows: [
        'records',
        'journalExchange',
        'post',
        'postReport',
        'queueNotice',
        'notifyExcerptLines',
        'listJobsOrNote',
        'trackFlush',
        'now',
        'nowIso',
        'stopped',
        'windowMs',
        'confirmTimeoutMs',
      ],
      ResumeEventWindows: [
        'records',
        'judgeSessionGeneration',
        'trackedGenerationSilent',
        'onEvent',
        'droppedReportFiles',
        'journal',
      ],
    });
  });

  it('deps の口は同じ参照のまま渡る（束ね直さない）', () => {
    const { deps } = build();
    const same: [string, string, keyof typeof deps][] = [
      ['QuotaStopWindows', 'journalExchange', 'journalExchange'],
      ['QuotaStopWindows', 'post', 'post'],
      ['QuotaStopWindows', 'listJobsOrNote', 'listJobsOrNote'],
      ['QuotaStopWindows', 'now', 'now'],
      ['QuotaStopWindows', 'nowIso', 'nowIso'],
      ['SynthesizedNoticeWindows', 'post', 'post'],
      ['SynthesizedNoticeWindows', 'statusAtDelivery', 'statusAtDelivery'],
      ['SynthesizedNoticeWindows', 'journalExchange', 'journalExchange'],
      ['SynthesizedNoticeWindows', 'now', 'now'],
      ['SynthesizedNoticeWindows', 'nowIso', 'nowIso'],
      ['RestoredWindows', 'journalExchange', 'journalExchange'],
      ['RestoredWindows', 'post', 'post'],
      ['RestoredWindows', 'postReport', 'postReport'],
      ['RestoredWindows', 'queueNotice', 'queueNotice'],
      ['RestoredWindows', 'notifyExcerptLines', 'notifyExcerptLines'],
      ['RestoredWindows', 'listJobsOrNote', 'listJobsOrNote'],
      ['RestoredWindows', 'now', 'now'],
      ['RestoredWindows', 'nowIso', 'nowIso'],
      ['RestoredWindows', 'stopped', 'stopped'],
      ['ResumeEventWindows', 'judgeSessionGeneration', 'judgeSessionGeneration'],
      ['ResumeEventWindows', 'trackedGenerationSilent', 'trackedGenerationSilent'],
      ['ResumeEventWindows', 'onEvent', 'onEvent'],
      ['ResumeEventWindows', 'droppedReportFiles', 'droppedReportFiles'],
      ['ResumeEventWindows', 'journal', 'journal'],
    ];
    for (const [name, key, depKey] of same) {
      expect(portsOf(name)[key], `${name}.${key}`).toBe(deps[depKey]);
    }
  });

  it('共有参照（records/tokenIdentities/supersedePending）はコピーされず同じ物が渡る', () => {
    const { deps } = build();
    for (const name of WINDOWS) {
      expect(portsOf(name).records, `${name}.records`).toBe(deps.records);
    }
    expect(portsOf('SynthesizedNoticeWindows').tokenIdentities).toBe(deps.tokenIdentities);
    expect(portsOf('SynthesizedNoticeWindows').supersedePending).toBe(deps.supersedePending);
  });

  it('carriedToWindow はファクトリの中で 1 回だけ（eager）取り出す。takeForDelivery は呼ばれた時に引く', () => {
    const { windows, counts, carried, takeForDelivery } = build();
    expect(counts.carriedToWindow).toBe(1);
    expect(portsOf('QuotaStopWindows').withheldCarriedToWindow).toBe(carried);
    expect(takeForDelivery).not.toHaveBeenCalled();
    const take = portsOf('SynthesizedNoticeWindows').takeWithheldForDelivery as Fn;
    expect(take.length).toBe(3);
    expect(take('m1', 'text', 'detail')).toBe('taken');
    expect(takeForDelivery.mock.calls).toEqual([['m1', 'text', 'detail']]);
    expect(counts.carriedToWindow).toBe(1);
    expect(windows).toBeDefined();
  });

  it('Synthesized へ渡る quota は Quota の実体。Restored の trackFlush はその quota を呼ぶ', () => {
    const { windows } = build();
    expect(portsOf('SynthesizedNoticeWindows').quotaWindows).toBe(windows.quotaWindows);
    const trackFlush = vi
      .spyOn(windows.quotaWindows, 'trackFlush')
      .mockImplementation((flush) => flush);
    const track = portsOf('RestoredWindows').trackFlush as Fn;
    expect(track.length).toBe(1);
    const flush = Promise.resolve();
    track(flush);
    expect(trackFlush).toHaveBeenCalledTimes(1);
    expect(trackFlush.mock.calls[0]).toEqual([flush]);
    expect(trackFlush.mock.calls[0]![0]).toBe(flush);
  });

  it('窓の長さ: 指定はそのまま（Quota と Restored は同じ値）、未指定は既定値へ解決する', () => {
    build();
    expect(portsOf('QuotaStopWindows').windowMs).toBe(111);
    expect(portsOf('RestoredWindows').windowMs).toBe(111);
    expect(portsOf('SynthesizedNoticeWindows').windowMs).toBe(222);
    expect(portsOf('RestoredWindows').confirmTimeoutMs).toBe(333);
    build({
      quotaStopWindowMs: undefined,
      synthesizedNoticeWindowMs: undefined,
      resumeConfirmTimeoutMs: undefined,
    });
    expect(portsOf('QuotaStopWindows').windowMs).toBe(QUOTA_STOP_WINDOW_MS);
    expect(portsOf('RestoredWindows').windowMs).toBe(QUOTA_STOP_WINDOW_MS);
    expect(portsOf('SynthesizedNoticeWindows').windowMs).toBe(resolveSynthesizedNoticeWindowMs());
    expect(portsOf('RestoredWindows').confirmTimeoutMs).toBe(RESUME_CONFIRM_TIMEOUT_MS);
  });

  it('同期で値を返す（Promise でない）。deps の口は構築では呼ばれない', () => {
    const { windows, deps } = build();
    expect(windows).not.toBeInstanceOf(Promise);
    expect(typeof (windows as unknown as { then?: unknown }).then).toBe('undefined');
    for (const key of [
      'now',
      'nowIso',
      'post',
      'journalExchange',
      'listJobsOrNote',
      'postReport',
      'queueNotice',
      'statusAtDelivery',
      'stopped',
      'judgeSessionGeneration',
      'trackedGenerationSilent',
      'onEvent',
      'droppedReportFiles',
      'journal',
    ] as const) {
      expect(deps[key], key).not.toHaveBeenCalled();
    }
  });
});
