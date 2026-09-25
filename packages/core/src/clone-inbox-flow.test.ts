import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloneInboxFlow, buildInboxFlowCount } from './clone-inbox-flow.js';
import { INBOX_EVENT_TYPE_ORDER } from './inbox-backlog.js';

/**
 * `clone-inbox-flow.ts` の歯。**純粋なクラスなので I/O のモック無しで全分岐に
 * 通せる**（`clone-notices.test.ts` / `runner-subagent-stop-state.test.ts` と
 * 同じ作法。前例は PR #1359 / #1433）。
 *
 * ここが固定するのは、切り出した4フィールドの**状態の器としての性質**——
 * 種類別の加算・`{ total, byType }` への整形・reset の中身——である。
 * `#writeInboxFlow` が「いつ `snapshot()` / `reset()` を呼ぶか」「`pending()`
 * が失敗したら何もしないこと」の判断は `clone.test.ts` の `inbox_flow`
 * 系（ブラックボックス、`journal.list` を読む）が引き続き持つ——ここでは
 * 扱わない。
 */

const ALL_TYPES_IN_ORDER = INBOX_EVENT_TYPE_ORDER;

describe('CloneInboxFlow — 種類ごとの加算（arrived / delivered / settled）', () => {
  it('呼ぶ前は3本とも空（total=0, byType=[]）', () => {
    const flow = new CloneInboxFlow();
    const snap = flow.snapshot();
    expect(snap.arrived).toEqual({ total: 0, byType: [] });
    expect(snap.delivered).toEqual({ total: 0, byType: [] });
    expect(snap.settled).toEqual({ total: 0, byType: [] });
  });

  it('arrived は同じ種類を呼ぶたびに1ずつ増える。他の種類・他の本（delivered/settled）は動かない', () => {
    const flow = new CloneInboxFlow();
    flow.arrived('human_message');
    flow.arrived('human_message');
    flow.arrived('timer');

    const snap = flow.snapshot();
    expect(snap.arrived).toEqual({
      total: 3,
      byType: [
        { type: 'human_message', count: 2 },
        { type: 'timer', count: 1 },
      ],
    });
    expect(snap.delivered).toEqual({ total: 0, byType: [] });
    expect(snap.settled).toEqual({ total: 0, byType: [] });
  });

  it('delivered / settled も同じ形で独立に数える', () => {
    const flow = new CloneInboxFlow();
    flow.delivered('external');
    flow.delivered('external');
    flow.settled('manager_message');

    const snap = flow.snapshot();
    expect(snap.arrived).toEqual({ total: 0, byType: [] });
    expect(snap.delivered).toEqual({ total: 2, byType: [{ type: 'external', count: 2 }] });
    expect(snap.settled).toEqual({ total: 1, byType: [{ type: 'manager_message', count: 1 }] });
  });

  it('7種類すべてを1回ずつ arrived した snapshot は、INBOX_EVENT_TYPE_ORDER の並びで7件・total=7を返す', () => {
    const flow = new CloneInboxFlow();
    for (const type of ALL_TYPES_IN_ORDER) flow.arrived(type);

    const snap = flow.snapshot();
    expect(snap.arrived.total).toBe(7);
    expect(snap.arrived.byType.map((entry) => entry.type)).toEqual([...ALL_TYPES_IN_ORDER]);
    expect(snap.arrived.byType.every((entry) => entry.count === 1)).toBe(true);
  });

  it('種類を逆順・飛び飛びに積んでも、snapshot の byType は常に INBOX_EVENT_TYPE_ORDER の並びで返る（積んだ順ではない）', () => {
    const flow = new CloneInboxFlow();
    flow.arrived('manager_message');
    flow.arrived('human_message');
    flow.arrived('external');

    const snap = flow.snapshot();
    expect(snap.arrived.byType.map((entry) => entry.type)).toEqual([
      'human_message',
      'external',
      'manager_message',
    ]);
  });
});

describe('CloneInboxFlow — snapshot() は読むだけで何も変えない', () => {
  it('snapshot() を複数回呼んでもカウンタは減らない・変わらない', () => {
    const flow = new CloneInboxFlow();
    flow.arrived('human_message');

    const first = flow.snapshot();
    const second = flow.snapshot();
    expect(first).toEqual(second);
    expect(second.arrived).toEqual({ total: 1, byType: [{ type: 'human_message', count: 1 }] });
  });

  it('snapshot() の後に reset() を呼ばなければ windowStartedAt は変わらない', () => {
    const flow = new CloneInboxFlow();
    const before = flow.snapshot().windowStartedAt;
    flow.arrived('human_message');
    const after = flow.snapshot().windowStartedAt;
    expect(after).toBe(before);
  });
});

describe('CloneInboxFlow — windowStartedAt の初期値と reset()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('windowStartedAt の初期値は、インスタンスを作った時刻（new Date().toISOString()）である', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const flow = new CloneInboxFlow();
    expect(flow.snapshot().windowStartedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('reset() は3本を空にし、windowStartedAt を「いま」へ進める', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const flow = new CloneInboxFlow();
    flow.arrived('human_message');
    flow.delivered('human_message');
    flow.settled('human_message');

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    flow.reset();

    const snap = flow.snapshot();
    expect(snap.windowStartedAt).toBe('2026-01-01T00:05:00.000Z');
    expect(snap.arrived).toEqual({ total: 0, byType: [] });
    expect(snap.delivered).toEqual({ total: 0, byType: [] });
    expect(snap.settled).toEqual({ total: 0, byType: [] });
  });

  it('reset() の後にまた arrived / delivered / settled を呼べば、新しい窓として数え直せる', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const flow = new CloneInboxFlow();
    flow.arrived('human_message');
    flow.reset();

    flow.arrived('timer');
    flow.arrived('timer');
    const snap = flow.snapshot();
    expect(snap.arrived).toEqual({ total: 2, byType: [{ type: 'timer', count: 2 }] });
  });
});

describe('buildInboxFlowCount — 生カウンタを {total, byType} へ整形する純関数', () => {
  it('空の Map からは total=0, byType=[] を返す', () => {
    expect(buildInboxFlowCount(new Map(), INBOX_EVENT_TYPE_ORDER)).toEqual({
      total: 0,
      byType: [],
    });
  });

  it('0件の型は byType に載らない。載っている件数の合計は必ず total に一致する', () => {
    const counts = new Map<(typeof INBOX_EVENT_TYPE_ORDER)[number], number>([
      ['human_message', 2],
      ['timer', 0],
      ['external', 5],
    ]);
    const result = buildInboxFlowCount(counts, INBOX_EVENT_TYPE_ORDER);
    expect(result.byType.some((entry) => entry.type === 'timer')).toBe(false);
    expect(result.total).toBe(result.byType.reduce((sum, entry) => sum + entry.count, 0));
    expect(result).toEqual({
      total: 7,
      byType: [
        { type: 'human_message', count: 2 },
        { type: 'external', count: 5 },
      ],
    });
  });

  it('byType の並びは渡した order の並びであって、Map への挿入順ではない', () => {
    const counts = new Map<(typeof INBOX_EVENT_TYPE_ORDER)[number], number>([
      ['manager_message', 1],
      ['human_message', 1],
    ]);
    const result = buildInboxFlowCount(counts, INBOX_EVENT_TYPE_ORDER);
    expect(result.byType.map((entry) => entry.type)).toEqual(['human_message', 'manager_message']);
  });
});
