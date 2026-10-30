import { describe, expect, it } from 'vitest';

import {
  MIN_CLOSED_IN_WINDOW,
  PROGRESS_FORECAST_METHOD,
  summarizeProgress,
  type ProgressTaskRow,
  type ProgressTasks,
} from './progress.js';
import { commitmentOriginSchema, jobStatusSchema, type Job } from './schema.js';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const HOURS = 168;
const FROM = '2026-09-23T12:00:00.000Z';
const TO = '2026-09-30T12:00:00.000Z';
const OLD = '2026-08-01T00:00:00.000Z';

// 進捗は Task（`TaskStore.list({ includeClosed: true })`）から数える（#5910）。開いた時刻は `createdAt`、
// 返事を結ぶ会話は `originConversationId`。
function row(id: string, createdAt: string, overrides: Partial<ProgressTaskRow> = {}) {
  const r: ProgressTaskRow = {
    id,
    createdAt,
    updatedAt: createdAt,
    status: overrides.closedAt === undefined ? 'queued' : 'done',
    origin: 'human',
    title: `title ${id}`,
    body: `body ${id}`,
    ...overrides,
  };
  return r;
}

function tasks(entries: ProgressTaskRow[], extra: { unreadable?: number } = {}): ProgressTasks {
  return {
    entries,
    unreadable: Array.from({ length: extra.unreadable ?? 0 }, (_, i) => ({
      id: `u${i}`,
      reason: '読めない',
    })),
  };
}

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    createdAt: OLD,
    updatedAt: OLD,
    status: 'done',
    summary: '要旨',
    ...overrides,
  };
}

function summarize(
  entries: ProgressTaskRow[],
  jobs: Job[] = [],
  extra: { unreadable?: number; unreadableJobs?: number; windowHours?: number } = {},
) {
  return summarizeProgress({
    tasks: tasks(entries, extra),
    jobs,
    unreadableJobs: extra.unreadableJobs ?? 0,
    now: NOW,
    windowHours: extra.windowHours ?? HOURS,
  });
}

function closedInWindow(n: number, prefix = 'k'): ProgressTaskRow[] {
  return Array.from({ length: n }, (_, i) =>
    row(`${prefix}${i}`, OLD, { closedAt: '2026-09-25T00:00:00.000Z' }),
  );
}

describe('summarizeProgress — 窓', () => {
  it('window は hours / from / to を ISO で返す（to は now、from は now - hours）', () => {
    expect(summarize([]).window).toEqual({ hours: HOURS, from: FROM, to: TO });
  });

  it('windowHours が有限の正数でない・now が不正なら、0 の集計へ化けずに投げる', () => {
    for (const windowHours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        summarizeProgress({
          tasks: tasks([]),
          jobs: [],
          unreadableJobs: 0,
          now: NOW,
          windowHours,
        }),
      ).toThrow(RangeError);
    }
    expect(() =>
      summarizeProgress({
        tasks: tasks([]),
        jobs: [],
        unreadableJobs: 0,
        now: new Date('invalid'),
        windowHours: HOURS,
      }),
    ).toThrow(RangeError);
  });
});

describe('summarizeProgress — backlog', () => {
  it('未了が0件のとき、最古と中央値は null（0 にしない）で、件数と区分は 0', () => {
    const b = summarize([row('a', OLD, { closedAt: '2026-08-02T00:00:00.000Z' })]).backlog;
    expect(b.total).toBe(0);
    expect(b.age.oldestAt).toBeNull();
    expect(b.age.medianHours).toBeNull();
    expect(b.age.buckets).toEqual({ under1h: 0, under24h: 0, under7d: 0, over7d: 0 });
    expect(b.byState).toEqual({
      untouched: 0,
      responded: 0,
      delegated: 0,
      notApplicable: 0,
      unjudgeable: 0,
    });
  });

  it('task が空でも最古と中央値は null', () => {
    const b = summarize([]).backlog;
    expect(b.total).toBe(0);
    expect(b.age.oldestAt).toBeNull();
    expect(b.age.medianHours).toBeNull();
  });

  it('開いている＝queued / waiting / needs_decision（closedAt が無い）。閉じた task は数えない', () => {
    const b = summarize([
      row('q', OLD, { status: 'queued' }),
      row('w', OLD, { status: 'waiting' }),
      row('n', OLD, { status: 'needs_decision' }),
      row('d', OLD, { status: 'done', closedAt: '2026-08-02T00:00:00.000Z' }),
      row('c', OLD, { status: 'cancelled', closedAt: '2026-08-02T00:00:00.000Z' }),
    ]).backlog;
    expect(b.total).toBe(3);
  });

  it('byOrigin は commitmentOriginSchema の全値をキーに持ち、片付いた task は数えない', () => {
    const b = summarize([
      row('h1', OLD, { origin: 'human' }),
      row('h2', OLD, { origin: 'human' }),
      row('m1', OLD, { origin: 'manager' }),
      row('x', OLD, { origin: 'external', closedAt: '2026-08-02T00:00:00.000Z' }),
    ]).backlog;
    expect(Object.keys(b.byOrigin).sort()).toEqual([...commitmentOriginSchema.options].sort());
    expect(b.byOrigin).toEqual({ human: 2, manager: 1, external: 0, self: 0 });
    expect(b.total).toBe(3);
  });

  it('齢は createdAt から数える: 1h ちょうどは <24h、24h ちょうどは <7d、7d ちょうどは ≥7d、59分は <1h', () => {
    const b = summarize([
      row('a', '2026-09-30T11:01:00.000Z'),
      row('b', '2026-09-30T11:00:00.000Z'),
      row('c', '2026-09-29T12:00:00.000Z'),
      row('d', '2026-09-23T12:00:00.000Z'),
    ]).backlog;
    expect(b.age.buckets).toEqual({ under1h: 1, under24h: 1, under7d: 1, over7d: 1 });
    expect(b.age.oldestAt).toBe('2026-09-23T12:00:00.000Z');
  });

  it('齢は updatedAt ではなく createdAt で決まる（状態を動かしても齢は若返らない）', () => {
    const b = summarize([
      row('a', '2026-09-01T00:00:00.000Z', { updatedAt: '2026-09-30T11:59:00.000Z' }),
    ]).backlog;
    expect(b.age.buckets.over7d).toBe(1);
    expect(b.age.oldestAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('中央値: 奇数件は真ん中、偶数件は中央2つの平均（時間）。入力順に依らない', () => {
    const odd = summarize([
      row('c', '2026-09-29T06:00:00.000Z'),
      row('a', '2026-09-30T10:00:00.000Z'),
      row('b', '2026-09-30T02:00:00.000Z'),
    ]).backlog;
    expect(odd.age.medianHours).toBe(10);
    const even = summarize([
      row('d', '2026-09-28T10:00:00.000Z'),
      row('c', '2026-09-29T06:00:00.000Z'),
      row('a', '2026-09-30T10:00:00.000Z'),
      row('b', '2026-09-30T02:00:00.000Z'),
    ]).backlog;
    expect(even.age.medianHours).toBe(20);
  });

  it('now より未来の createdAt は齢 0（<1h）として数え、負の齢を作らない', () => {
    const b = summarize([row('f', '2026-09-30T13:00:00.000Z')]).backlog;
    expect(b.age.buckets.under1h).toBe(1);
    expect(b.age.medianHours).toBe(0);
  });

  it('区分: human は 未着手/返答済み、human 以外は notApplicable。委譲あり（Job.taskId が走行中）は排他でない', () => {
    const b = summarize(
      [
        row('u', OLD, { originConversationId: 'c1' }),
        row('r', OLD, { originConversationId: 'c2', respondedAt: '2026-08-02T00:00:00.000Z' }),
        row('ud', OLD, { originConversationId: 'c3' }),
        row('rd', OLD, {
          originConversationId: 'c4',
          respondedAt: '2026-08-02T00:00:00.000Z',
        }),
        row('mg', OLD, { origin: 'manager' }),
        row('cl', OLD, {
          originConversationId: 'c6',
          respondedAt: '2026-08-02T00:00:00.000Z',
          closedAt: '2026-08-03T00:00:00.000Z',
        }),
      ],
      [
        job('j-ud', { status: 'running', taskId: 'ud' }),
        job('j-rd-1', { status: 'running', taskId: 'rd' }),
        job('j-rd-2', { status: 'running', taskId: 'rd' }),
        job('j-mg', { status: 'running', taskId: 'mg' }),
        job('j-cl', { status: 'running', taskId: 'cl' }),
        job('j-u-wait', { status: 'waiting_human', taskId: 'u' }),
      ],
    ).backlog;
    expect(b.byState).toEqual({
      untouched: 2,
      responded: 2,
      delegated: 4,
      notApplicable: 1,
      unjudgeable: 0,
    });
    expect(b.byState.untouched + b.byState.responded + b.byState.notApplicable).toBe(b.total);
  });

  it('委譲あり: Job.taskId がその task を指し、終わっていない（running・waiting_human）ものだけ。終わった（done・failed・lost・stopped）・別の task・会話 id だけの結び付きは数えない', () => {
    const b = summarize(
      [
        row('t1', OLD, { originConversationId: 'c1' }),
        row('t2', OLD, { originConversationId: 'c2' }),
        row('t3', OLD, { originConversationId: 'c3' }),
        row('t4', OLD, { originConversationId: 'c4' }),
      ],
      [
        job('a', { status: 'running', taskId: 't1' }),
        job('b', { status: 'done', taskId: 't2' }),
        job('c', { status: 'waiting_human', taskId: 't3' }),
        job('d', { status: 'running', taskId: 'other' }),
        job('e', { status: 'running', conversationId: 'c4' }),
        job('f', { status: 'lost', taskId: 't4' }),
      ],
    ).backlog;
    expect(b.byState.delegated).toBe(2);
  });

  it('originConversationId の無い human の task は untouched でなく unjudgeable に数える（返事を結べない）', () => {
    const b = summarize([
      row('nosrc', OLD),
      row('nosrc-d', OLD),
      row('src', OLD, { originConversationId: 'c1' }),
      row('src-r', OLD, { originConversationId: 'c2', respondedAt: '2026-08-02T00:00:00.000Z' }),
      row('mg', OLD, { origin: 'manager' }),
    ]).backlog;
    expect(b.byState.unjudgeable).toBe(2);
    expect(b.byState.untouched).toBe(1);
    expect(b.byState.responded).toBe(1);
    expect(b.byState.notApplicable).toBe(1);
    expect(
      b.byState.untouched + b.byState.responded + b.byState.notApplicable + b.byState.unjudgeable,
    ).toBe(b.total);
  });

  it('completeness は unreadable をそのまま運ぶ（unreadable は total に入らない）。刈りの件数の欄は無い', () => {
    const b = summarize([row('a', OLD)], [], { unreadable: 2 }).backlog;
    expect(b.completeness).toEqual({ unreadable: 2, unreadableJobs: 0 });
    expect(b.total).toBe(1);
  });

  it('completeness.unreadableJobs は読めない委譲の行の数をそのまま運ぶ（task の欠けとは別の欄）（#2345）', () => {
    const b = summarize([row('a', OLD)], [], { unreadableJobs: 3 }).backlog;
    expect(b.completeness).toEqual({ unreadable: 0, unreadableJobs: 3 });
  });
});

describe('summarizeProgress — inProgress', () => {
  it('走行中・人間待ち・lost を別々に数え、終端（done/failed/stopped）はどれにも数えない', () => {
    const jobs = [
      job('r1', { status: 'running' }),
      job('r2', { status: 'running' }),
      job('w', { status: 'waiting_human' }),
      job('l', { status: 'lost' }),
      job('d', { status: 'done' }),
      job('f', { status: 'failed' }),
      job('s', { status: 'stopped' }),
    ];
    const p = summarize([], jobs).inProgress;
    expect([p.running, p.awaitingHuman, p.lost]).toEqual([2, 1, 1]);
  });

  it('jobStatusSchema の全値がどれか1つの扱いに落ちる（未知の値の取りこぼしを型と実行の両方で確かめる）', () => {
    for (const status of jobStatusSchema.options) {
      const p = summarize([], [job('j', { status })]).inProgress;
      const counted = p.running + p.awaitingHuman + p.lost;
      expect(counted).toBe(['running', 'waiting_human', 'lost'].includes(status) ? 1 : 0);
    }
  });

  it('最終報告: 報告のある走行だけが最古・最新になり、無い走行は withoutReport に数える', () => {
    const p = summarize(
      [],
      [
        job('a', { status: 'running', lastReportAt: '2026-09-30T10:00:00.000Z' }),
        job('b', { status: 'running', lastReportAt: '2026-09-29T00:00:00.000Z' }),
        job('c', { status: 'running' }),
        job('d', { status: 'done', lastReportAt: '2026-01-01T00:00:00.000Z' }),
        job('e', { status: 'waiting_human', lastReportAt: '2026-09-30T11:59:00.000Z' }),
      ],
    ).inProgress.lastReport;
    expect(p).toEqual({
      oldestAt: '2026-09-29T00:00:00.000Z',
      newestAt: '2026-09-30T10:00:00.000Z',
      withoutReport: 1,
    });
  });

  it('報告が1件も無い走行だけのとき、最古・最新は null（0 や now にしない）', () => {
    const p = summarize([], [job('a', { status: 'running' }), job('b', { status: 'running' })])
      .inProgress.lastReport;
    expect(p).toEqual({ oldestAt: null, newestAt: null, withoutReport: 2 });
  });

  it('走行中が0件のとき withoutReport も 0、最古・最新は null', () => {
    expect(summarize([], [job('d')]).inProgress.lastReport).toEqual({
      oldestAt: null,
      newestAt: null,
      withoutReport: 0,
    });
  });
});

describe('summarizeProgress — throughput（窓は両端を含む）', () => {
  it('tasksOpened / tasksClosed は createdAt / closedAt が [from, to] の中の task を数える', () => {
    const t = summarize([
      row('at-from', FROM),
      row('before-from', '2026-09-23T11:59:59.999Z'),
      row('at-to', TO),
      row('after-to', '2026-09-30T12:00:00.001Z'),
      row('cl-from', OLD, { closedAt: FROM }),
      row('cl-before', OLD, { closedAt: '2026-09-23T11:59:59.999Z' }),
      row('cl-to', OLD, { closedAt: TO }),
      row('cl-after', OLD, { closedAt: '2026-09-30T12:00:00.001Z' }),
    ]).throughput;
    expect(t.tasksOpened).toBe(2);
    expect(t.tasksClosed).toBe(2);
  });

  it('throughput は新しい欄名だけを持つ（commitmentsOpened / commitmentsClosed / mayBeUndercounted は無い）', () => {
    expect(Object.keys(summarize([]).throughput).sort()).toEqual([
      'delegationsEnded',
      'tasksClosed',
      'tasksOpened',
    ]);
  });

  it('終わった委譲は、終端状態かつ updatedAt が窓の中のものだけ。近似であることを basis に残す', () => {
    const t = summarize(
      [],
      [
        job('done-in', { status: 'done', updatedAt: '2026-09-25T00:00:00.000Z' }),
        job('failed-from', { status: 'failed', updatedAt: FROM }),
        job('lost-in', { status: 'lost', updatedAt: TO }),
        job('stopped-in', { status: 'stopped', updatedAt: '2026-09-26T00:00:00.000Z' }),
        job('done-before', { status: 'done', updatedAt: '2026-09-23T11:59:59.999Z' }),
        job('running-in', { status: 'running', updatedAt: '2026-09-29T00:00:00.000Z' }),
        job('waiting-in', { status: 'waiting_human', updatedAt: '2026-09-29T00:00:00.000Z' }),
      ],
    ).throughput;
    expect(t.delegationsEnded).toEqual({ count: 4, basis: 'updatedAt' });
  });
});

describe('summarizeProgress — forecast', () => {
  const anchored = (rows: ProgressTaskRow[]) => [row('anchor', OLD), ...rows];

  it('estimated: open / (closedInWindow / windowHours)。basis と notice を伴う', () => {
    const f = summarize(
      anchored([
        ...closedInWindow(4),
        row('o1', '2026-09-01T00:00:00.000Z'),
        row('o2', '2026-09-01T00:00:00.000Z'),
        row('o3', '2026-09-01T00:00:00.000Z'),
      ]),
      [],
      { unreadable: 1 },
    ).forecast;
    expect(f.state).toBe('estimated');
    if (f.state !== 'estimated') return;
    expect(f.hoursToDrain).toBeCloseTo(168, 9);
    expect(f.basis).toEqual({
      open: 4,
      closedInWindow: 4,
      openedInWindow: 0,
      windowHours: HOURS,
      method: PROGRESS_FORECAST_METHOD,
      unreadable: 1,
      minClosedInWindow: MIN_CLOSED_IN_WINDOW,
    });
    expect(f.notice).toContain('約束ではない');
    expect(f.notice).toContain('流入');
  });

  it('式は windowHours を使う（24 時間窓と 168 時間窓で同じ件数でも hoursToDrain が変わる）', () => {
    const rows = anchored([...closedInWindow(3), row('o1', '2026-09-01T00:00:00.000Z')]);
    const f168 = summarize(rows).forecast;
    expect(f168.state === 'estimated' && f168.hoursToDrain).toBeCloseTo((2 * 168) / 3, 9);
    expect(summarize(rows, [], { windowHours: 24 }).forecast).toMatchObject({
      state: 'unavailable',
      reason: 'closed_too_few',
    });
  });

  it('closed_too_few: 閉じた件数が閾値未満（2 件）なら数を作らない。閾値ちょうど（3 件）なら計算する', () => {
    const two = summarize(anchored(closedInWindow(MIN_CLOSED_IN_WINDOW - 1))).forecast;
    expect(two).toMatchObject({ state: 'unavailable', reason: 'closed_too_few' });
    const three = summarize(
      anchored([...closedInWindow(MIN_CLOSED_IN_WINDOW), row('o', '2026-09-01T00:00:00.000Z')]),
    ).forecast;
    expect(three.state).toBe('estimated');
  });

  it('閾値は 3（定数の値そのもの）', () => {
    expect(MIN_CLOSED_IN_WINDOW).toBe(3);
  });

  it('unavailable の basis も件数を運ぶ（0 と「取れない」を basis から区別できる）', () => {
    const f = summarize(anchored(closedInWindow(1))).forecast;
    expect(f.state).toBe('unavailable');
    expect(f.basis).toMatchObject({ open: 1, closedInWindow: 1, openedInWindow: 0 });
  });

  it('not_converging: 窓の中で openedInWindow >= closedInWindow（等しいときも）', () => {
    const equal = summarize(
      anchored([
        ...closedInWindow(3),
        row('n1', '2026-09-26T00:00:00.000Z'),
        row('n2', '2026-09-27T00:00:00.000Z'),
        row('n3', '2026-09-28T00:00:00.000Z'),
      ]),
    ).forecast;
    expect(equal.state).toBe('not_converging');
    expect(equal.basis).toMatchObject({ closedInWindow: 3, openedInWindow: 3 });
    const more = summarize(
      anchored([
        ...closedInWindow(3),
        ...['1', '2', '3', '4'].map((i) => row(`n${i}`, '2026-09-26T00:00:00.000Z')),
      ]),
    ).forecast;
    expect(more.state).toBe('not_converging');
    const less = summarize(
      anchored([
        ...closedInWindow(3),
        row('n1', '2026-09-26T00:00:00.000Z'),
        row('n2', '2026-09-27T00:00:00.000Z'),
      ]),
    ).forecast;
    expect(less.state).toBe('estimated');
  });

  it('not_converging は閉じた件数が足りないときには出ない（closed_too_few が先）', () => {
    const f = summarize(
      anchored([
        ...closedInWindow(2),
        ...['1', '2', '3'].map((i) => row(`n${i}`, '2026-09-26T00:00:00.000Z')),
      ]),
    ).forecast;
    expect(f).toMatchObject({ state: 'unavailable', reason: 'closed_too_few' });
  });

  describe('tasks_younger_than_window', () => {
    it('task の最古の createdAt が from より新しい', () => {
      const f = summarize([
        ...closedInWindow(3).map((r) => ({ ...r, createdAt: '2026-09-24T00:00:00.000Z' })),
        row('o', '2026-09-25T00:00:00.000Z'),
      ]).forecast;
      expect(f).toMatchObject({ state: 'unavailable', reason: 'tasks_younger_than_window' });
    });

    it('最古の createdAt がちょうど from なら窓を覆っている（若くない）', () => {
      const f = summarize([
        row('edge', FROM),
        ...closedInWindow(3).map((r) => ({ ...r, createdAt: FROM })),
      ]).forecast;
      expect(f.state).not.toBe('unavailable');
    });

    it('最古が from の 1ms 後なら若い', () => {
      const f = summarize([row('edge', '2026-09-23T12:00:00.001Z')]).forecast;
      expect(f).toMatchObject({ state: 'unavailable', reason: 'tasks_younger_than_window' });
    });

    it('task が1つも無い（unreadable だけでも）場合は若い扱い', () => {
      expect(summarize([]).forecast).toMatchObject({
        state: 'unavailable',
        reason: 'tasks_younger_than_window',
      });
      expect(summarize([], [], { unreadable: 2 }).forecast).toMatchObject({
        state: 'unavailable',
        reason: 'tasks_younger_than_window',
      });
    });
  });

  it('見込みの理由は closed_too_few / tasks_younger_than_window の2つだけ（刈りの理由 history_incomplete・旧名 ledger_younger_than_window は返さない）', () => {
    const reasons = new Set<string>();
    for (const forecast of [
      summarize([]).forecast,
      summarize(anchored(closedInWindow(1))).forecast,
      summarize(anchored(closedInWindow(3))).forecast,
    ]) {
      if (forecast.state === 'unavailable') reasons.add(forecast.reason);
    }
    expect([...reasons].sort()).toEqual(['closed_too_few', 'tasks_younger_than_window']);
  });

  describe('複数の reason が当たるときの優先順位', () => {
    it('tasks_younger_than_window は closed_too_few に先立つ', () => {
      const f = summarize([row('young', '2026-09-25T00:00:00.000Z')]).forecast;
      expect(f).toMatchObject({ reason: 'tasks_younger_than_window' });
    });
  });

  describe('未了が0件', () => {
    it('閉じた件数が足りなくても、task が窓より若くても estimated で hoursToDrain は 0', () => {
      const f = summarize([
        row('only', '2026-09-25T00:00:00.000Z', { closedAt: '2026-09-26T00:00:00.000Z' }),
      ]).forecast;
      expect(f.state).toBe('estimated');
      if (f.state !== 'estimated') return;
      expect(f.hoursToDrain).toBe(0);
      expect(f.basis.open).toBe(0);
    });

    it('unreadable があっても estimated 0 のまま、basis に件数を載せる', () => {
      const f = summarize([row('c', OLD, { closedAt: '2026-08-02T00:00:00.000Z' })], [], {
        unreadable: 2,
      }).forecast;
      expect(f).toMatchObject({ state: 'estimated', hoursToDrain: 0 });
      expect(f.basis).toMatchObject({ open: 0, unreadable: 2 });
    });

    it('task が1つも無いときは「0」ではなく unavailable（tasks_younger_than_window）', () => {
      expect(summarize([]).forecast.state).toBe('unavailable');
    });
  });

  it('unreadable > 0 は見込みを止めず、basis に件数を載せる', () => {
    const f = summarize(
      anchored([...closedInWindow(4), row('o', '2026-09-01T00:00:00.000Z')]),
      [],
      { unreadable: 3 },
    ).forecast;
    expect(f.state).toBe('estimated');
    expect(f.basis.unreadable).toBe(3);
  });
});
