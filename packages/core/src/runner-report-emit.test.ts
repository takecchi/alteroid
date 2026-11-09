import { describe, expect, it } from 'vitest';

import type { AgentTurnEnded } from './agent-events.js';
import { RunnerReportEmitter } from './runner-report-emit.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { SdkFailure } from './sdk-failure.js';
import type { JobStatus } from './schema.js';

// `RunnerReportEmitter#emit`（`RunnerSession#applyTurnEnded` の後半を切り出したもの）を、口を偽物にして直に縛る。
// 外から（runner を通して）は見えない差を縛るのが目的: 口を呼ぶ順と回数（`liveBackgroundTasks` を取り込みの前に 1 回だけ読むこと・
// `deliverPeerNotices` が `report` の後で 1 回呼ばれること）・出し箱が空なら `collectOutbox` を呼ばず `await` を挟まないこと・
// `emit` が `Promise` を返すこと・各口が投げたときの伝わり方・`outwardActions`／`pending`／`sdkSession` が参照のまま使われること。
// 欄ごとの値・本文の全文は `runner-report-emit-pin.test.ts`（切り出し前の作りの出力）が縛っている。実時間では待たない。

type Report = Extract<RunnerEvent, { type: 'report' }>;
type Task = { id: string; taskType: string };

const TURN: AgentTurnEnded = {
  type: 'turn_ended',
  succeeded: true,
  body: '済んだ',
  errorLines: [],
  denials: [],
  id: 'r1',
};

const FAILURE: SdkFailure = { code: 'rate_limit', via: 'result_is_error', text: '上限' };

const ARGS = {
  said: [] as readonly string[],
  failure: undefined as SdkFailure | undefined,
  noCredentialDirHint: false,
  openedWorkersThisTurn: 0,
  workerRejectionsThisTurn: [] as readonly string[],
  failedWorkerNotificationsThisTurn: 0,
  failedWorkerNotificationsNamingLimitThisTurn: 0,
};

interface Options {
  liveBackgroundTasks?: () => readonly Task[];
  outboxHasEntries?: () => boolean;
  collectOutbox?: () => Promise<{ files?: never[]; rejectedFiles?: never[] }>;
  setStatus?: (status: JobStatus) => void;
  wantsTokenRecycle?: boolean;
  wakeInput?: () => void;
  emit?: (event: RunnerEvent) => void;
  wake?: () => void;
  deliver?: () => void;
  pending?: unknown[];
  outwardActions?: string[];
  initialStatus?: JobStatus;
}

function harness(options: Options = {}) {
  const calls: string[] = [];
  const events: RunnerEvent[] = [];
  const pending = options.pending ?? [];
  const outwardActions = options.outwardActions ?? [];
  let status: JobStatus = options.initialStatus ?? 'running';
  const sdkSession = {
    get status(): JobStatus {
      calls.push('status');
      return status;
    },
    setStatus(next: JobStatus): void {
      calls.push('setStatus');
      if (options.setStatus !== undefined) options.setStatus(next);
      status = next;
    },
    get wantsTokenRecycle(): boolean {
      return options.wantsTokenRecycle ?? false;
    },
    wakeInput(): void {
      calls.push('wakeInput');
      options.wakeInput?.();
    },
  };
  const emitter = new RunnerReportEmitter({
    liveBackgroundTasks:
      options.liveBackgroundTasks ??
      (() => {
        calls.push('liveBackgroundTasks');
        return [];
      }),
    outboxHasEntries:
      options.outboxHasEntries ??
      (() => {
        calls.push('outboxHasEntries');
        return false;
      }),
    collectOutbox:
      options.collectOutbox ??
      (async () => {
        calls.push('collectOutbox');
        return {};
      }),
    sdkSession,
    pending,
    outwardActions,
    emit:
      options.emit ??
      ((event) => {
        calls.push(event.type);
        events.push(event);
      }),
    managerId: 'm1',
    wakeForFinishedBackgroundTaskOutputs:
      options.wake ??
      (() => {
        calls.push('wake');
      }),
    deliverPeerNotices:
      options.deliver ??
      (() => {
        calls.push('deliver');
      }),
  });
  return { emitter, calls, events, pending, outwardActions, sdkSession };
}

const reportOf = (events: readonly RunnerEvent[]): Report => {
  const found = events.find((event): event is Report => event.type === 'report');
  if (found === undefined) throw new Error('report が無い');
  return found;
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('口を呼ぶ順と回数', () => {
  it('出し箱が空: liveBackgroundTasks → outboxHasEntries → setStatus → report → wake → deliver。collectOutbox は呼ばない。それぞれ 1 回', async () => {
    const h = harness();
    await h.emitter.emit(TURN, ARGS);
    expect(h.calls.filter((call) => call !== 'status')).toEqual([
      'liveBackgroundTasks',
      'outboxHasEntries',
      'setStatus',
      'report',
      'wake',
      'deliver',
    ]);
  });

  it('出し箱に在る: collectOutbox は outboxHasEntries の後・setStatus の前に 1 回。liveBackgroundTasks は取り込みの前に読む', async () => {
    const calls: string[] = [];
    const h = harness({
      liveBackgroundTasks: () => {
        calls.push('liveBackgroundTasks');
        return [];
      },
      outboxHasEntries: () => {
        calls.push('outboxHasEntries');
        return true;
      },
      collectOutbox: async () => {
        calls.push('collectOutbox');
        return {};
      },
      setStatus: () => calls.push('setStatus'),
      emit: (event) => calls.push(event.type),
      wake: () => calls.push('wake'),
      deliver: () => calls.push('deliver'),
    });
    await h.emitter.emit(TURN, ARGS);
    expect(calls).toEqual([
      'liveBackgroundTasks',
      'outboxHasEntries',
      'collectOutbox',
      'setStatus',
      'report',
      'wake',
      'deliver',
    ]);
  });

  it('wantsTokenRecycle: setStatus の後・report の前に wakeInput を 1 回。立っていなければ呼ばない', async () => {
    const on = harness({ wantsTokenRecycle: true });
    await on.emitter.emit(TURN, ARGS);
    const off = harness();
    await off.emitter.emit(TURN, ARGS);
    expect({
      on: on.calls.filter((call) => call !== 'status'),
      off: off.calls.filter((call) => call !== 'status'),
    }).toEqual({
      on: [
        'liveBackgroundTasks',
        'outboxHasEntries',
        'setStatus',
        'wakeInput',
        'report',
        'wake',
        'deliver',
      ],
      off: ['liveBackgroundTasks', 'outboxHasEntries', 'setStatus', 'report', 'wake', 'deliver'],
    });
  });

  it('liveBackgroundTasks は取り込みの前に 1 回だけ読み、取り込みの間に一覧が変わっても前の一覧で awaitingBackground を出す', async () => {
    let list: readonly Task[] = [{ id: 't1', taskType: 'local_agent' }];
    let reads = 0;
    const h = harness({
      liveBackgroundTasks: () => {
        reads += 1;
        return list;
      },
      outboxHasEntries: () => true,
      collectOutbox: async () => {
        list = [];
        return {};
      },
    });
    await h.emitter.emit(TURN, ARGS);
    expect({ reads, awaitingBackground: reportOf(h.events).awaitingBackground }).toEqual({
      reads: 1,
      awaitingBackground: { count: 1, breakdown: 'local_agent×1' },
    });
  });

  it('deliverPeerNotices は report の後に 1 回（report を出さない前に呼ばない）', async () => {
    const h = harness();
    const pending = h.emitter.emit(TURN, ARGS);
    // 出し箱が空なので、呼んだ直後（`await` 前）に最後まで走っている
    expect(h.calls.filter((call) => call === 'deliver')).toEqual(['deliver']);
    await pending;
    const order = h.calls.filter((call) => ['report', 'wake', 'deliver'].includes(call));
    expect(order).toEqual(['report', 'wake', 'deliver']);
  });
});

describe('emit は Promise を返し、出し箱が空なら await を挟まない', () => {
  it('Promise を返す（出し箱が空でも）', async () => {
    const h = harness();
    const returned = h.emitter.emit(TURN, ARGS);
    expect(returned).toBeInstanceOf(Promise);
    await returned;
  });

  it('出し箱が空: 呼んだ直後に（マイクロタスクを回さずに）report・wake・deliver まで済んでいる', async () => {
    const h = harness();
    const returned = h.emitter.emit(TURN, ARGS);
    expect(h.calls.filter((call) => call !== 'status')).toEqual([
      'liveBackgroundTasks',
      'outboxHasEntries',
      'setStatus',
      'report',
      'wake',
      'deliver',
    ]);
    await returned;
  });

  it('出し箱に在る: collectOutbox の Promise が決着するまで setStatus も report も出ない。決着したら出る', async () => {
    let release: (value: { files?: never[] }) => void = () => undefined;
    const gate = new Promise<{ files?: never[] }>((resolve) => {
      release = resolve;
    });
    const h = harness({ outboxHasEntries: () => true, collectOutbox: () => gate });
    const returned = h.emitter.emit(TURN, ARGS);
    await flush();
    const before = h.calls.filter((call) => call === 'setStatus' || call === 'report');
    release({});
    await returned;
    const after = h.calls.filter((call) => call === 'setStatus' || call === 'report');
    expect({ before, after }).toEqual({ before: [], after: ['setStatus', 'report'] });
  });

  it('collectOutbox の結果（files・rejectedFiles）は report の末尾に載る', async () => {
    const h = harness({
      outboxHasEntries: () => true,
      collectOutbox: async () => ({ rejectedFiles: [] }),
    });
    await h.emitter.emit(TURN, ARGS);
    expect(reportOf(h.events)).toHaveProperty('rejectedFiles', []);
  });
});

describe('各口が投げたときの伝わり方（emit は async なので、投げは拒否された Promise として出る。以降の口は呼ばれない）', () => {
  const boom = new Error('口が落ちた');
  const SETTLED = ['liveBackgroundTasks', 'outboxHasEntries', 'setStatus'];
  const cases: ReadonlyArray<{
    name: string;
    options: (calls: string[]) => Options;
    expectCalls: readonly string[];
  }> = [
    {
      name: 'liveBackgroundTasks',
      options: (calls) => ({
        liveBackgroundTasks: () => {
          calls.push('liveBackgroundTasks');
          throw boom;
        },
      }),
      expectCalls: ['liveBackgroundTasks'],
    },
    {
      name: 'outboxHasEntries',
      options: (calls) => ({
        outboxHasEntries: () => {
          calls.push('outboxHasEntries');
          throw boom;
        },
      }),
      expectCalls: ['liveBackgroundTasks', 'outboxHasEntries'],
    },
    {
      name: 'collectOutbox（拒否）',
      options: (calls) => ({
        outboxHasEntries: () => {
          calls.push('outboxHasEntries');
          return true;
        },
        collectOutbox: () => {
          calls.push('collectOutbox');
          return Promise.reject(boom);
        },
      }),
      expectCalls: ['liveBackgroundTasks', 'outboxHasEntries', 'collectOutbox'],
    },
    {
      name: 'setStatus',
      options: (calls) => ({
        setStatus: () => {
          calls.push('setStatus');
          throw boom;
        },
      }),
      expectCalls: SETTLED,
    },
    {
      name: 'wakeInput',
      options: (calls) => ({
        wantsTokenRecycle: true,
        wakeInput: () => {
          calls.push('wakeInput');
          throw boom;
        },
      }),
      expectCalls: [...SETTLED, 'wakeInput'],
    },
    {
      name: 'emit（report）',
      options: (calls) => ({
        emit: (event) => {
          calls.push(event.type);
          throw boom;
        },
      }),
      expectCalls: [...SETTLED, 'report'],
    },
    {
      name: 'wakeForFinishedBackgroundTaskOutputs',
      options: (calls) => ({
        wake: () => {
          calls.push('wake');
          throw boom;
        },
      }),
      expectCalls: [...SETTLED, 'report', 'wake'],
    },
    {
      name: 'deliverPeerNotices',
      options: (calls) => ({
        deliver: () => {
          calls.push('deliver');
          throw boom;
        },
      }),
      expectCalls: [...SETTLED, 'report', 'wake', 'deliver'],
    },
  ];

  for (const { name, options, expectCalls } of cases) {
    it(`${name} が投げる: 呼んだ側へは同期で投げず、拒否になる。それより後の口は呼ばれない`, async () => {
      const calls: string[] = [];
      const h = harness({
        liveBackgroundTasks: () => {
          calls.push('liveBackgroundTasks');
          return [];
        },
        outboxHasEntries: () => {
          calls.push('outboxHasEntries');
          return false;
        },
        setStatus: () => calls.push('setStatus'),
        emit: (event) => calls.push(event.type),
        wake: () => calls.push('wake'),
        deliver: () => calls.push('deliver'),
        wakeInput: () => calls.push('wakeInput'),
        ...options(calls),
      });
      let returned: Promise<void> | undefined;
      expect(() => {
        returned = h.emitter.emit(TURN, ARGS);
      }).not.toThrow();
      await expect(returned).rejects.toBe(boom);
      expect(calls).toEqual(expectCalls);
    });
  }
});

describe('outwardActions・pending・sdkSession は参照のまま使う', () => {
  it('outwardActions: 渡した配列を splice(0) で空に戻し、中身は report へ（別の配列として）載る', async () => {
    const outwardActions = ['送った', '消した'];
    const h = harness({ outwardActions });
    await h.emitter.emit(TURN, ARGS);
    const report = reportOf(h.events);
    expect({
      left: outwardActions,
      carried: report.outwardActions,
      same: report.outwardActions === outwardActions,
    }).toEqual({ left: [], carried: ['送った', '消した'], same: false });
  });

  it('outwardActions: 作った後に足された分も、次の emit で載る（写していない）', async () => {
    const h = harness();
    h.outwardActions.push('あとから足した');
    await h.emitter.emit(TURN, ARGS);
    expect(reportOf(h.events).outwardActions).toEqual(['あとから足した']);
  });

  it('outwardActions が空ならキーごと無い', async () => {
    const h = harness();
    await h.emitter.emit(TURN, ARGS);
    expect('outwardActions' in reportOf(h.events)).toBe(false);
  });

  it('pending: 作った後に積まれた確認待ちを読む（waiting_human）。空に戻れば done', async () => {
    const h = harness();
    h.pending.push({ id: 'req-1' });
    await h.emitter.emit(TURN, ARGS);
    h.pending.length = 0;
    await h.emitter.emit(TURN, ARGS);
    expect(
      h.events.filter((event): event is Report => event.type === 'report').map((r) => r.status),
    ).toEqual(['waiting_human', 'done']);
  });

  it('sdkSession: 渡したオブジェクトの setStatus を（その this で）呼び、status は setStatus の後の値を report へ載せる', async () => {
    const h = harness({ initialStatus: 'running' });
    await h.emitter.emit(TURN, ARGS);
    expect(reportOf(h.events).status).toBe('done');
    expect(h.sdkSession.status).toBe('done');
  });
});

describe('awaitingBackground は 3 条件（失敗でない・done・背景処理が在る）が揃うときだけ載る', () => {
  const tasks: readonly Task[] = [
    { id: 'a', taskType: 'local_agent' },
    { id: 'b', taskType: 'local_agent' },
    { id: 'c', taskType: 'bash' },
  ];

  const table: ReadonlyArray<{
    name: string;
    failure: SdkFailure | undefined;
    pending: unknown[];
    tasks: readonly Task[];
    expected: { count: number; breakdown: string } | undefined;
  }> = [
    {
      name: '3 条件が揃う',
      failure: undefined,
      pending: [],
      tasks,
      expected: { count: 3, breakdown: 'local_agent×2, bash×1' },
    },
    { name: '失敗している', failure: FAILURE, pending: [], tasks, expected: undefined },
    {
      name: '確認待ち（waiting_human）',
      failure: undefined,
      pending: [{}],
      tasks,
      expected: undefined,
    },
    { name: '背景処理が無い', failure: undefined, pending: [], tasks: [], expected: undefined },
  ];

  for (const row of table) {
    it(row.name, async () => {
      const h = harness({ pending: row.pending, liveBackgroundTasks: () => row.tasks });
      await h.emitter.emit(TURN, { ...ARGS, failure: row.failure });
      expect(reportOf(h.events).awaitingBackground).toEqual(row.expected);
    });
  }
});
