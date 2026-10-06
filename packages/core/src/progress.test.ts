import { describe, expect, it } from 'vitest';

import {
  MIN_CLOSED_IN_WINDOW,
  PROGRESS_FORECAST_METHOD,
  summarizeProgress,
  type ProgressCommitmentRow,
  type ProgressCommitments,
} from './progress.js';
import { commitmentOriginSchema, jobStatusSchema, type Job } from './schema.js';

// 時刻は固定の ISO 文字列（TZ に依存させない）。窓は 168 時間 = 7 日。
const NOW = new Date('2026-09-30T12:00:00.000Z');
const HOURS = 168;
const FROM = '2026-09-23T12:00:00.000Z';
const TO = '2026-09-30T12:00:00.000Z';
/** 窓より十分前（台帳が窓を覆っていることを示す錨に使う）。 */
const OLD = '2026-08-01T00:00:00.000Z';

function row(id: string, at: string, overrides: Partial<ProgressCommitmentRow> = {}) {
  const r: ProgressCommitmentRow = { id, at, origin: 'human', body: `body ${id}`, ...overrides };
  return r;
}

function ledger(
  entries: ProgressCommitmentRow[],
  extra: { unreadable?: number; trimmedClosed?: number } = {},
): ProgressCommitments {
  return {
    entries,
    unreadable: Array.from({ length: extra.unreadable ?? 0 }, (_, i) => ({
      id: `u${i}`,
      reason: '読めない',
    })) as unknown as ProgressCommitments['unreadable'],
    trimmedClosed: extra.trimmedClosed ?? 0,
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
  entries: ProgressCommitmentRow[],
  jobs: Job[] = [],
  extra: {
    unreadable?: number;
    trimmedClosed?: number;
    unreadableJobs?: number;
    windowHours?: number;
  } = {},
) {
  return summarizeProgress({
    commitments: ledger(entries, extra),
    jobs,
    unreadableJobs: extra.unreadableJobs ?? 0,
    now: NOW,
    windowHours: extra.windowHours ?? HOURS,
  });
}

/** 窓の中で閉じた行を n 件作る（開いたのは窓の前）。 */
function closedInWindow(n: number, prefix = 'k'): ProgressCommitmentRow[] {
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
          commitments: ledger([]),
          jobs: [],
          unreadableJobs: 0,
          now: NOW,
          windowHours,
        }),
      ).toThrow(RangeError);
    }
    expect(() =>
      summarizeProgress({
        commitments: ledger([]),
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
    expect(b.byState).toEqual({ untouched: 0, responded: 0, delegated: 0, notApplicable: 0 });
  });

  it('台帳が空でも最古と中央値は null', () => {
    const b = summarize([]).backlog;
    expect(b.total).toBe(0);
    expect(b.age.oldestAt).toBeNull();
    expect(b.age.medianHours).toBeNull();
  });

  it('byOrigin は commitmentOriginSchema の全値をキーに持ち、片付いた行は数えない', () => {
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

  it('齢の境界: 1h ちょうどは <24h、24h ちょうどは <7d、7d ちょうどは ≥7d、59分は <1h', () => {
    const b = summarize([
      row('a', '2026-09-30T11:01:00.000Z'), // 59 分
      row('b', '2026-09-30T11:00:00.000Z'), // 1h ちょうど
      row('c', '2026-09-29T12:00:00.000Z'), // 24h ちょうど
      row('d', '2026-09-23T12:00:00.000Z'), // 7d ちょうど
    ]).backlog;
    expect(b.age.buckets).toEqual({ under1h: 1, under24h: 1, under7d: 1, over7d: 1 });
    expect(b.age.oldestAt).toBe('2026-09-23T12:00:00.000Z');
  });

  it('中央値: 奇数件は真ん中、偶数件は中央2つの平均（時間）。入力順に依らない', () => {
    // 齢 2h / 10h / 30h
    const odd = summarize([
      row('c', '2026-09-29T06:00:00.000Z'),
      row('a', '2026-09-30T10:00:00.000Z'),
      row('b', '2026-09-30T02:00:00.000Z'),
    ]).backlog;
    expect(odd.age.medianHours).toBe(10);
    // 齢 2h / 10h / 30h / 50h → (10 + 30) / 2
    const even = summarize([
      row('d', '2026-09-28T10:00:00.000Z'),
      row('c', '2026-09-29T06:00:00.000Z'),
      row('a', '2026-09-30T10:00:00.000Z'),
      row('b', '2026-09-30T02:00:00.000Z'),
    ]).backlog;
    expect(even.age.medianHours).toBe(20);
  });

  it('now より未来の at は齢 0（<1h）として数え、負の齢を作らない', () => {
    const b = summarize([row('f', '2026-09-30T13:00:00.000Z')]).backlog;
    expect(b.age.buckets.under1h).toBe(1);
    expect(b.age.medianHours).toBe(0);
  });

  it('区分は Web の見せ方に揃う: human は 未着手/返答済み、human 以外は notApplicable、delegated は排他でない', () => {
    const b = summarize([
      row('u', OLD), // 未着手
      row('r', OLD, { respondedAt: '2026-08-02T00:00:00.000Z' }), // 返答済み
      row('ud', OLD, { activeManagerIds: ['m1'] }), // 未着手かつ委譲あり
      row('rd', OLD, { respondedAt: '2026-08-02T00:00:00.000Z', activeManagerIds: ['m2', 'm3'] }),
      row('e', OLD, { activeManagerIds: [] }), // 空配列は委譲ありに数えない（未着手）
      row('mg', OLD, { origin: 'manager', activeManagerIds: ['m4'] }), // human 以外は対象外
      row('cl', OLD, {
        respondedAt: '2026-08-02T00:00:00.000Z',
        closedAt: '2026-08-03T00:00:00.000Z',
      }),
    ]).backlog;
    expect(b.byState).toEqual({ untouched: 3, responded: 2, delegated: 2, notApplicable: 1 });
    expect(b.byState.untouched + b.byState.responded + b.byState.notApplicable).toBe(b.total);
  });

  it('completeness は unreadable と trimmedClosed をそのまま運ぶ（unreadable は total に入らない）', () => {
    const b = summarize([row('a', OLD)], [], { unreadable: 2, trimmedClosed: 5 }).backlog;
    // 委譲の欠け（`unreadableJobs`）は、渡さなければ 0（この行では委譲の欠けを足していない）。
    expect(b.completeness).toEqual({ unreadable: 2, trimmedClosed: 5, unreadableJobs: 0 });
    expect(b.total).toBe(1);
  });

  it('completeness.unreadableJobs は読めない委譲の行の数をそのまま運ぶ（台帳の欠けとは別の欄）（#2345）', () => {
    const b = summarize([row('a', OLD)], [], { unreadableJobs: 3 }).backlog;
    expect(b.completeness).toEqual({ unreadable: 0, trimmedClosed: 0, unreadableJobs: 3 });
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
        job('c', { status: 'running' }), // 報告なし
        // 走行中でない委譲の報告は、走行中の最古・最新に混ぜない
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
  it('opened / closed は at / closedAt が [from, to] の中の行を数える', () => {
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
    expect(t.commitmentsOpened).toBe(2);
    expect(t.commitmentsClosed).toBe(2);
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
  /** 窓を覆う錨（窓より前の未了）を足した台帳。 */
  const anchored = (rows: ProgressCommitmentRow[]) => [row('anchor', OLD), ...rows];

  it('estimated: open / (closedInWindow / windowHours)。basis と notice を伴う', () => {
    // open = 錨 1 件 + 窓の外で開いた未了 3 件 = 4、closed = 4（窓の前に開いた行）、opened = 0
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
    // 4 / (4 / 168) = 168
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
    const rows = anchored([...closedInWindow(3), row('o1', '2026-09-01T00:00:00.000Z')]); // open 2, closed 3（closedAt 2026-09-25 は 24h 窓の外）
    const f168 = summarize(rows).forecast;
    expect(f168.state === 'estimated' && f168.hoursToDrain).toBeCloseTo((2 * 168) / 3, 9);
    // 24h 窓では窓の中で閉じた行が 0 になり closed_too_few
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
    // 流入が消化より1件少なければ estimated
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

  describe('ledger_younger_than_window', () => {
    it('台帳の最古の at が from より新しい', () => {
      const f = summarize([
        ...closedInWindow(3).map((r) => ({ ...r, at: '2026-09-24T00:00:00.000Z' })),
        row('o', '2026-09-25T00:00:00.000Z'),
      ]).forecast;
      expect(f).toMatchObject({ state: 'unavailable', reason: 'ledger_younger_than_window' });
    });

    it('最古の at がちょうど from なら窓を覆っている（若くない）', () => {
      const f = summarize([
        row('edge', FROM),
        ...closedInWindow(3).map((r) => ({ ...r, at: FROM })),
      ]).forecast;
      expect(f.state).not.toBe('unavailable');
    });

    it('最古が from の 1ms 後なら若い', () => {
      const f = summarize([row('edge', '2026-09-23T12:00:00.001Z')]).forecast;
      expect(f).toMatchObject({ state: 'unavailable', reason: 'ledger_younger_than_window' });
    });

    it('行が1つも無い台帳（unreadable だけでも）は若い扱い', () => {
      expect(summarize([]).forecast).toMatchObject({
        state: 'unavailable',
        reason: 'ledger_younger_than_window',
      });
      expect(summarize([], [], { unreadable: 2 }).forecast).toMatchObject({
        state: 'unavailable',
        reason: 'ledger_younger_than_window',
      });
    });
  });

  describe('history_incomplete（trimmedClosed の境界）', () => {
    it('trimmedClosed = 0 なら、片付き行が窓の中にしか無くても history_incomplete にしない', () => {
      const f = summarize(anchored(closedInWindow(3))).forecast;
      expect(f.state).toBe('estimated');
    });

    it('trimmedClosed > 0 で、残っている片付き行の最古が窓より前なら estimated（窓の中は欠けていない）', () => {
      const f = summarize(
        anchored([
          row('old-closed', OLD, { closedAt: '2026-09-23T11:59:59.999Z' }),
          ...closedInWindow(3),
          row('o', '2026-09-01T00:00:00.000Z'),
        ]),
        [],
        { trimmedClosed: 7 },
      ).forecast;
      expect(f.state).toBe('estimated');
    });

    it('trimmedClosed > 0 で、残っている最古の closedAt が窓の中なら history_incomplete', () => {
      const f = summarize(anchored(closedInWindow(3)), [], { trimmedClosed: 1 }).forecast;
      expect(f).toMatchObject({ state: 'unavailable', reason: 'history_incomplete' });
    });

    it('残っている最古の closedAt がちょうど from なら history_incomplete（窓は from を含む）', () => {
      const f = summarize(
        anchored([...closedInWindow(3), row('edge', OLD, { closedAt: FROM })]),
        [],
        { trimmedClosed: 1 },
      ).forecast;
      expect(f).toMatchObject({ state: 'unavailable', reason: 'history_incomplete' });
    });

    it('trimmedClosed > 0 で片付き行が1件も残っていなければ history_incomplete（判定できないので数を作らない）', () => {
      const f = summarize(anchored([]), [], { trimmedClosed: 1 }).forecast;
      expect(f).toMatchObject({ state: 'unavailable', reason: 'history_incomplete' });
    });
  });

  describe('throughput.mayBeUndercounted（#3698。history_incomplete と同じ条件を、見込みの順序と独立に計算する）', () => {
    const under = (
      entries: ProgressCommitmentRow[],
      extra: { trimmedClosed?: number } = {},
    ): boolean => summarize(entries, [], extra).throughput.mayBeUndercounted;

    it('trimmedClosed = 0 なら偽（片付き行が窓の中にしか無くても）', () => {
      expect(under(anchored(closedInWindow(3)))).toBe(false);
    });

    it('trimmedClosed > 0 で、残っている最古の closedAt が窓より前なら偽', () => {
      expect(
        under(anchored([row('old-closed', OLD, { closedAt: '2026-09-23T11:59:59.999Z' })]), {
          trimmedClosed: 7,
        }),
      ).toBe(false);
    });

    it('trimmedClosed > 0 で、残っている最古の closedAt が窓の中なら真', () => {
      expect(under(anchored(closedInWindow(3)), { trimmedClosed: 1 })).toBe(true);
    });

    it('残っている最古の closedAt がちょうど from なら真（窓は from を含む）', () => {
      expect(under(anchored([row('edge', OLD, { closedAt: FROM })]), { trimmedClosed: 1 })).toBe(
        true,
      );
    });

    it('trimmedClosed > 0 で片付き行が1件も残っていなければ真', () => {
      expect(under(anchored([]), { trimmedClosed: 1 })).toBe(true);
    });

    it('ledger_younger_than_window が見込みで先に勝つ台帳でも、刈りがあれば真（独立に計算する）', () => {
      const s = summarize([row('young', '2026-09-25T00:00:00.000Z')], [], { trimmedClosed: 3 });
      expect(s.forecast).toMatchObject({ reason: 'ledger_younger_than_window' });
      expect(s.throughput.mayBeUndercounted).toBe(true);
    });

    it('未了が0件で見込みが estimated(0) でも、刈りがあれば真', () => {
      // 未了の行を作らない（`anchored` は未了の錨を足すので使わない。at は窓の前なので台帳は窓を覆う）
      const s = summarize(closedInWindow(3), [], { trimmedClosed: 2 });
      expect(s.forecast).toMatchObject({ state: 'estimated', hoursToDrain: 0 });
      expect(s.throughput.mayBeUndercounted).toBe(true);
    });

    it('台帳が窓より若くても、刈りが無ければ偽', () => {
      expect(under([row('young', '2026-09-25T00:00:00.000Z')])).toBe(false);
    });
  });

  describe('複数の reason が当たるときの優先順位', () => {
    it('ledger_younger_than_window は history_incomplete と closed_too_few に先立つ', () => {
      const f = summarize([row('young', '2026-09-25T00:00:00.000Z')], [], {
        trimmedClosed: 3,
      }).forecast;
      expect(f).toMatchObject({ reason: 'ledger_younger_than_window' });
    });

    it('history_incomplete は closed_too_few に先立つ', () => {
      // 閉じた件数は 1（<3）でもあり、履歴も欠けている
      const f = summarize(anchored(closedInWindow(1)), [], { trimmedClosed: 3 }).forecast;
      expect(f).toMatchObject({ reason: 'history_incomplete' });
    });
  });

  describe('未了が0件', () => {
    it('閉じた件数が足りなくても、台帳が窓より若くても、履歴が欠けていても estimated で hoursToDrain は 0', () => {
      // 閉じた 1 件だけ（<3）、しかも台帳が窓より若く、trimmedClosed も > 0
      const f = summarize(
        [row('only', '2026-09-25T00:00:00.000Z', { closedAt: '2026-09-26T00:00:00.000Z' })],
        [],
        { trimmedClosed: 2 },
      ).forecast;
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

    it('行が1つも無い台帳は「0」ではなく unavailable（ledger_younger_than_window）', () => {
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
