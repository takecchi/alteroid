import { describe, expect, it } from 'vitest';

import type { AgentTurnEnded } from './agent-events.js';
import { RunnerReportEmitter } from './runner-report-emit.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { SdkFailure } from './sdk-failure.js';
import type { JobStatus } from './schema.js';

// `RunnerReportEmitter#emit`（`RunnerSession#applyTurnEnded` の後半を切り出したもの）を、口を偽物にして直に縛る。
// 外から（runner を通して）は見えない差を縛るのが目的: 口を呼ぶ順と回数（`deliverPeerNotices` が `report` の後で 1 回呼ばれること）・
// `emit` が同期で、戻り値が `Promise` でないこと・各口が同期で投げたときの伝わり方・
// `outwardActions`／`pending`／`sdkSession` が参照のまま使われること・`awaitingBackground` の 3 条件。
// 背景処理の一覧の読む位置と出し箱の取り込み（唯一の `await`）は呼び元 `#applyTurnEnded` に残るので、ここでは縛れない
// （`runner-report-emit-wiring.test.ts` が縛る）。欄ごとの値・本文の全文は `runner-report-emit-pin.test.ts` が縛っている。実時間では待たない。

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
  liveBackground: [] as readonly Task[],
  outbox: {} as { files?: never[]; rejectedFiles?: never[] },
};

interface Options {
  calls?: string[];
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
  const calls = options.calls ?? [];
  const events: RunnerEvent[] = [];
  const pending = options.pending ?? [];
  const outwardActions = options.outwardActions ?? [];
  let status: JobStatus = options.initialStatus ?? 'running';
  const sdkSession = {
    get status(): JobStatus {
      return status;
    },
    setStatus(next: JobStatus): void {
      calls.push('setStatus');
      options.setStatus?.(next);
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

describe('口を呼ぶ順と回数', () => {
  it('setStatus → report → wake → deliver。それぞれ 1 回', () => {
    const h = harness();
    h.emitter.emit(TURN, ARGS);
    expect(h.calls).toEqual(['setStatus', 'report', 'wake', 'deliver']);
  });

  it('wantsTokenRecycle: setStatus の後・report の前に wakeInput を 1 回。立っていなければ呼ばない', () => {
    const on = harness({ wantsTokenRecycle: true });
    on.emitter.emit(TURN, ARGS);
    const off = harness();
    off.emitter.emit(TURN, ARGS);
    expect({ on: on.calls, off: off.calls }).toEqual({
      on: ['setStatus', 'wakeInput', 'report', 'wake', 'deliver'],
      off: ['setStatus', 'report', 'wake', 'deliver'],
    });
  });

  it('deliverPeerNotices は report の後（wake の後）に 1 回。2 回目の emit では 2 回目', () => {
    const h = harness();
    h.emitter.emit(TURN, ARGS);
    h.emitter.emit(TURN, ARGS);
    expect(h.calls).toEqual([
      'setStatus',
      'report',
      'wake',
      'deliver',
      'setStatus',
      'report',
      'wake',
      'deliver',
    ]);
  });

  it('report を出す時点で wake と deliver は未呼び出し（report.status は setStatus の結果）', () => {
    const seen: string[] = [];
    const h = harness({
      emit: (event) => seen.push(`${event.type}:${event.type === 'report' ? event.status : ''}`),
      wake: () => seen.push('wake'),
      deliver: () => seen.push('deliver'),
    });
    h.emitter.emit(TURN, ARGS);
    expect(seen).toEqual(['report:done', 'wake', 'deliver']);
  });
});

describe('emit は同期で、Promise を返さない', () => {
  it('戻り値は undefined（Promise でない）', () => {
    const h = harness();
    const returned: unknown = h.emitter.emit(TURN, ARGS);
    expect(returned).toBeUndefined();
  });

  it('呼んだ直後（マイクロタスクを回さずに）report・wake・deliver まで済んでいる', () => {
    const h = harness();
    h.emitter.emit(TURN, ARGS);
    expect(h.calls).toEqual(['setStatus', 'report', 'wake', 'deliver']);
  });
});

describe('引数（呼び元が算出した値）の使われ方', () => {
  it('outbox の欄は report の末尾に展開される。空なら欄ごと無い', () => {
    const withFiles = harness();
    withFiles.emitter.emit(TURN, { ...ARGS, outbox: { rejectedFiles: [] } });
    const empty = harness();
    empty.emitter.emit(TURN, ARGS);
    expect({
      withFiles: 'rejectedFiles' in reportOf(withFiles.events),
      empty: 'rejectedFiles' in reportOf(empty.events) || 'files' in reportOf(empty.events),
    }).toEqual({ withFiles: true, empty: false });
  });

  it('liveBackground の一覧は渡されたものから件数と内訳を出す', () => {
    const h = harness();
    h.emitter.emit(TURN, {
      ...ARGS,
      liveBackground: [
        { id: 'a', taskType: 'local_agent' },
        { id: 'b', taskType: 'local_agent' },
      ],
    });
    expect(reportOf(h.events).awaitingBackground).toEqual({
      count: 2,
      breakdown: 'local_agent×2',
    });
  });
});

describe('各口が同期で投げたときの伝わり方（emit は同期なので、呼んだ側へそのまま投げる。以降の口は呼ばれない）', () => {
  const boom = new Error('口が落ちた');
  const cases: ReadonlyArray<{
    name: string;
    options: (calls: string[]) => Options;
    expectCalls: readonly string[];
  }> = [
    {
      name: 'setStatus',
      options: (calls) => ({
        setStatus: () => {
          throw boom;
        },
        calls,
      }),
      expectCalls: ['setStatus'],
    },
    {
      name: 'wakeInput',
      options: (calls) => ({
        wantsTokenRecycle: true,
        wakeInput: () => {
          throw boom;
        },
        calls,
      }),
      expectCalls: ['setStatus', 'wakeInput'],
    },
    {
      name: 'emit（report）',
      options: (calls) => ({
        emit: (event) => {
          calls.push(event.type);
          throw boom;
        },
        calls,
      }),
      expectCalls: ['setStatus', 'report'],
    },
    {
      name: 'wakeForFinishedBackgroundTaskOutputs',
      options: (calls) => ({
        wake: () => {
          calls.push('wake');
          throw boom;
        },
        calls,
      }),
      expectCalls: ['setStatus', 'report', 'wake'],
    },
    {
      name: 'deliverPeerNotices',
      options: (calls) => ({
        deliver: () => {
          calls.push('deliver');
          throw boom;
        },
        calls,
      }),
      expectCalls: ['setStatus', 'report', 'wake', 'deliver'],
    },
  ];

  for (const { name, options, expectCalls } of cases) {
    it(`${name} が投げる: 同期で投げ直し、それより後の口は呼ばれない`, () => {
      const calls: string[] = [];
      const h = harness(options(calls));
      expect(() => h.emitter.emit(TURN, ARGS)).toThrow(boom);
      expect(calls).toEqual(expectCalls);
    });
  }
});

describe('outwardActions・pending・sdkSession は参照のまま使う', () => {
  it('outwardActions: 渡した配列を splice(0) で空に戻し、中身は report へ（別の配列として）載る', () => {
    const outwardActions = ['送った', '消した'];
    const h = harness({ outwardActions });
    h.emitter.emit(TURN, ARGS);
    const report = reportOf(h.events);
    expect({
      left: outwardActions,
      carried: report.outwardActions,
      same: report.outwardActions === outwardActions,
    }).toEqual({ left: [], carried: ['送った', '消した'], same: false });
  });

  it('outwardActions: 作った後に足された分も、次の emit で載る（写していない）', () => {
    const h = harness();
    h.outwardActions.push('あとから足した');
    h.emitter.emit(TURN, ARGS);
    expect(reportOf(h.events).outwardActions).toEqual(['あとから足した']);
  });

  it('outwardActions が空ならキーごと無い', () => {
    const h = harness();
    h.emitter.emit(TURN, ARGS);
    expect('outwardActions' in reportOf(h.events)).toBe(false);
  });

  it('pending: 作った後に積まれた確認待ちを読む（waiting_human）。空に戻れば done', () => {
    const h = harness();
    h.pending.push({ id: 'req-1' });
    h.emitter.emit(TURN, ARGS);
    h.pending.length = 0;
    h.emitter.emit(TURN, ARGS);
    expect(
      h.events.filter((event): event is Report => event.type === 'report').map((r) => r.status),
    ).toEqual(['waiting_human', 'done']);
  });

  it('sdkSession: 渡したオブジェクトの setStatus を呼び、status は setStatus の後の値を report へ載せる', () => {
    const h = harness({ initialStatus: 'running' });
    h.emitter.emit(TURN, ARGS);
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
    it(row.name, () => {
      const h = harness({ pending: row.pending });
      h.emitter.emit(TURN, { ...ARGS, failure: row.failure, liveBackground: row.tasks });
      expect(reportOf(h.events).awaitingBackground).toEqual(row.expected);
    });
  }
});
