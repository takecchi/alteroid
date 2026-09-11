import { describe, expect, it } from 'vitest';

import {
  INBOX_BACKLOG_LOUD_THRESHOLD,
  describeInboxBacklogBreakdown,
  inboxBacklogDedupeKey,
  summarizeInboxBacklog,
  type InboxBacklogBreakdown,
} from './inbox-backlog.js';
import type { InboxEvent } from './schema.js';
import type { PendingInboxEvent } from './store.js';

const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const HOUR_MS_FOR_TEST = 60 * 60 * 1000;

function row(event: InboxEvent, at: string, deliveries = 0): PendingInboxEvent {
  return { event, at, deliveries };
}

/**
 * `Record<InboxEvent['type'], InboxEvent>` にすると、各値が union 全体へ
 * 広がり、`{ ...a, text: '...' }` のような narrow なフィールドの上書きが
 * 「そんな欄は無い」で弾かれる（このテストは元々これを踏んだ）。
 * 型ごとに narrow な型を保つマップにする。
 */
type SampleEvents = { readonly [K in InboxEvent['type']]: Extract<InboxEvent, { type: K }> };

/** 7つの型それぞれの、素な1件（`id` / `at` は呼び出し側が上書きする前提）。 */
const SAMPLE_EVENTS: SampleEvents = {
  human_message: {
    type: 'human_message',
    id: 'e-human_message',
    at: '2026-09-11T00:00:00.000Z',
    text: 'こんにちは',
    conversationId: 'conv-1',
  },
  human_answer: {
    type: 'human_answer',
    id: 'e-human_answer',
    at: '2026-09-11T00:00:00.000Z',
    approvalId: 'appr-1',
    answer: 'yes',
  },
  distill: {
    type: 'distill',
    id: 'e-distill',
    at: '2026-09-11T00:00:00.000Z',
    reason: 'conversation_end',
  },
  timer: {
    type: 'timer',
    id: 'e-timer',
    at: '2026-09-11T00:00:00.000Z',
    kind: 'daily_report',
    target: '2026-09-10',
    cause: 'schedule',
  },
  external: {
    type: 'external',
    id: 'e-external',
    at: '2026-09-11T00:00:00.000Z',
    source: 'webhook-a',
    payload: { foo: 'bar' },
  },
  self_initiative: {
    type: 'self_initiative',
    id: 'e-self_initiative',
    at: '2026-09-11T00:00:00.000Z',
    reason: '暇なので',
    cause: 'schedule',
  },
  manager_message: {
    type: 'manager_message',
    id: 'e-manager_message',
    at: '2026-09-11T00:00:00.000Z',
    managerId: 'mgr-1',
    kind: 'report',
    text: '終わった',
  },
};

const ALL_TYPES = Object.keys(SAMPLE_EVENTS) as InboxEvent['type'][];

describe('inboxBacklogDedupeKey', () => {
  it.each(ALL_TYPES)('%s: id と at だけが違う2件は同じ鍵になる', (type) => {
    const base = SAMPLE_EVENTS[type];
    const a: InboxEvent = { ...base, id: 'id-a', at: '2026-09-11T00:00:00.000Z' } as InboxEvent;
    const b: InboxEvent = { ...base, id: 'id-b', at: '2026-09-11T05:00:00.000Z' } as InboxEvent;

    expect(inboxBacklogDedupeKey(a)).toBe(inboxBacklogDedupeKey(b));
  });

  it('human_message: text が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.human_message;
    const b: InboxEvent = { ...a, id: 'id-b', text: '別の発言' };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('human_message: conversationId が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.human_message;
    const b: InboxEvent = { ...a, id: 'id-b', conversationId: 'conv-2' };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('human_answer: answer が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.human_answer;
    const b: InboxEvent = { ...a, id: 'id-b', answer: 'no' };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('human_answer: approvalId が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.human_answer;
    const b: InboxEvent = { ...a, id: 'id-b', approvalId: 'appr-2' };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('manager_message: managerId / kind / text のいずれが違っても別の鍵', () => {
    const a = SAMPLE_EVENTS.manager_message;
    const byManager: InboxEvent = { ...a, id: 'id-b', managerId: 'mgr-2' };
    const byKind: InboxEvent = { ...a, id: 'id-c', kind: 'question' };
    const byText: InboxEvent = { ...a, id: 'id-d', text: '別の報告' };
    const key = inboxBacklogDedupeKey(a);
    expect(inboxBacklogDedupeKey(byManager)).not.toBe(key);
    expect(inboxBacklogDedupeKey(byKind)).not.toBe(key);
    expect(inboxBacklogDedupeKey(byText)).not.toBe(key);
  });

  it('manager_message: requestId / markup（id・at 以外だが鍵に含めない欄）が違っても同じ鍵', () => {
    const a: InboxEvent = { ...SAMPLE_EVENTS.manager_message, requestId: 'req-1' };
    const b: InboxEvent = { ...SAMPLE_EVENTS.manager_message, id: 'id-b', requestId: 'req-2' };
    expect(inboxBacklogDedupeKey(a)).toBe(inboxBacklogDedupeKey(b));
  });

  it('external: source が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.external;
    const b: InboxEvent = { ...a, id: 'id-b', source: 'webhook-b' };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('external: payload の中身が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.external;
    const b: InboxEvent = { ...a, id: 'id-b', payload: { foo: 'baz' } };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('external: payload が省略（undefined）と null は同じ鍵になる（`payload ?? null`）', () => {
    const a: InboxEvent = { ...SAMPLE_EVENTS.external, payload: undefined };
    const b: InboxEvent = { ...SAMPLE_EVENTS.external, id: 'id-b', payload: null };
    expect(inboxBacklogDedupeKey(a)).toBe(inboxBacklogDedupeKey(b));
  });

  it('timer: kind / target / cause のいずれが違っても別の鍵', () => {
    const a = SAMPLE_EVENTS.timer;
    const byKind: InboxEvent = { ...a, id: 'id-b', kind: 'weekly_report' };
    const byTarget: InboxEvent = { ...a, id: 'id-c', target: '2026-09-09' };
    const byCause: InboxEvent = { ...a, id: 'id-d', cause: 'manual' };
    const key = inboxBacklogDedupeKey(a);
    expect(inboxBacklogDedupeKey(byKind)).not.toBe(key);
    expect(inboxBacklogDedupeKey(byTarget)).not.toBe(key);
    expect(inboxBacklogDedupeKey(byCause)).not.toBe(key);
  });

  it('timer: cause 省略は "schedule" と同じ鍵（省略時の既定と揃う）', () => {
    const withCause: InboxEvent = {
      type: 'timer',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      kind: 'daily_report',
      target: '2026-09-10',
      cause: 'schedule',
    };
    const withoutCause: InboxEvent = {
      type: 'timer',
      id: 'id-b',
      at: '2026-09-11T05:00:00.000Z',
      kind: 'daily_report',
      target: '2026-09-10',
    };
    expect(inboxBacklogDedupeKey(withCause)).toBe(inboxBacklogDedupeKey(withoutCause));
  });

  it('self_initiative: reason / cause のいずれが違っても別の鍵', () => {
    const a = SAMPLE_EVENTS.self_initiative;
    const byReason: InboxEvent = { ...a, id: 'id-b', reason: '別の理由' };
    const byCause: InboxEvent = { ...a, id: 'id-c', cause: 'manual' };
    const key = inboxBacklogDedupeKey(a);
    expect(inboxBacklogDedupeKey(byReason)).not.toBe(key);
    expect(inboxBacklogDedupeKey(byCause)).not.toBe(key);
  });

  it('distill: reason が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.distill;
    const b: InboxEvent = { ...a, id: 'id-b', reason: 'shutdown' };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('型が違えば、他の欄が同じでも別の鍵になる（type 自体が鍵に含まれる）', () => {
    // self_initiative と distill はどちらも reason 相当の1文字列を持つが、
    // human_message.type/manager_message.type を混ぜても畳まれないことを、
    // self_initiative と timer（どちらも cause を持つ）で確かめる。
    const timerLike: InboxEvent = {
      type: 'timer',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      kind: 'x',
      cause: 'schedule',
    };
    const selfLike: InboxEvent = {
      type: 'self_initiative',
      id: 'id-b',
      at: '2026-09-11T00:00:00.000Z',
      reason: 'x',
      cause: 'schedule',
    };
    expect(inboxBacklogDedupeKey(timerLike)).not.toBe(inboxBacklogDedupeKey(selfLike));
  });

  /**
   * ⚠️ 実行時の倒れ先（AGENTS.md「型で塞いだ分岐にも、実行時の倒れ先の歯を
   * 足す」#285 の作法）。型では防げない未知の `type` が実行時に来ても、
   * 黙って別の型として畳んだり本文を握り潰したりせず、必ず投げる
   * （この repo の同じ union に対する既存の倒れ先——`clone.ts` の
   * `#dispatch` の `default` ——と同じ形）。
   */
  it('未知の type は（型では防げない実行時の値として）例外を投げる', () => {
    const unknown = { type: 'not_a_real_type', id: 'x', at: '2026-09-11T00:00:00.000Z' };
    expect(() => inboxBacklogDedupeKey(unknown as unknown as InboxEvent)).toThrow();
  });

  /**
   * ⭐ 区切りが NUL であることが実際に効いていることを測る歯（レビューで
   * 半角スペースから NUL へ変えた変更そのものの裏取り）。
   *
   * `conversationId` と `text` の境界に半角スペースが挟まると、**区切りが
   * 半角スペースのままなら2つの別のフィールド分けが同じ文字列に潰れる**
   * ——`conversationId='conv'` / `text='1 x'` と
   * `conversationId='conv 1'` / `text='x'` は、どちらも
   * `'human_message' + SEP + conversationId + SEP + text` を素直に
   * 半角スペースで結ぶと同じ `'human_message conv 1 x'` になる。
   *
   * **区切りが NUL なら、本文に半角スペースが含まれても境界がずれない**
   * ——NUL は本文中の半角スペースとは別の文字なので、2つは別の鍵になる。
   * ⚠️ この歯は、区切りを半角スペースへ戻すと落ちる形になっている
   * （`DEDUPE_SEPARATOR` を `' '` に戻して自分で確かめた。報告に生出力を
   * 添える）。
   */
  it('⭐ 本文に半角スペースを含む2件は、境界がずれても別の鍵になる（NUL区切りの裏取り）', () => {
    const a: InboxEvent = {
      type: 'human_message',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      conversationId: 'conv',
      text: '1 x',
    };
    const b: InboxEvent = {
      type: 'human_message',
      id: 'id-b',
      at: '2026-09-11T00:00:00.000Z',
      conversationId: 'conv 1',
      text: 'x',
    };

    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });
});

describe('summarizeInboxBacklog', () => {
  it('0件のとき、total は0で oldestAt は持たない（値を作らない）', () => {
    const b = summarizeInboxBacklog([], NOW);
    expect(b.total).toBe(0);
    expect(b).not.toHaveProperty('oldestAt');
    expect(b.byType).toEqual([]);
    expect(b.bySource).toEqual([]);
    expect(b.ageBuckets).toEqual([]);
    expect(b.distinct).toBe(0);
  });

  it('最古の at を oldestAt にする', () => {
    const b = summarizeInboxBacklog(
      [
        row(SAMPLE_EVENTS.human_message, '2026-09-11T05:00:00.000Z'),
        row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-10T00:00:00.000Z'),
      ],
      NOW,
    );
    expect(b.oldestAt).toBe('2026-09-10T00:00:00.000Z');
  });

  it('byType: 0件の型は載らず、載っている行を足すと total に一致する', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T00:00:00.000Z'),
      row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.byType).toEqual([
      { type: 'human_message', count: 2 },
      { type: 'manager_message', count: 1 },
    ]);
    expect(b.byType.reduce((sum, e) => sum + e.count, 0)).toBe(b.total);
    // 0件の型（human_answer など）は配列に無い。
    expect(b.byType.some((e) => e.type === 'human_answer')).toBe(false);
  });

  it('bySource: external の source / manager_message の managerId を数え、他の型は数えない', () => {
    const rows = [
      row(SAMPLE_EVENTS.external, '2026-09-11T00:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.external, id: 'e2' }, '2026-09-11T00:00:00.000Z'),
      row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z'),
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.bySource).toEqual([
      { source: 'external:webhook-a', count: 2 },
      { source: 'manager:mgr-1', count: 1 },
    ]);
  });

  it('bySource: 上位5件まで、同数は名前順で安定する', () => {
    const rows = ['e', 'd', 'c', 'b', 'a', 'f'].map((name, i) =>
      row({ ...SAMPLE_EVENTS.external, id: `e-${i}`, source: name }, '2026-09-11T00:00:00.000Z'),
    );
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.bySource).toHaveLength(5);
    expect(b.bySource.map((e) => e.source)).toEqual([
      'external:a',
      'external:b',
      'external:c',
      'external:d',
      'external:e',
    ]);
  });

  it('distinct: 同一本文（id/at 以外が同じ）を畳んだ件数', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T05:00:00.000Z'),
      row(
        { ...SAMPLE_EVENTS.human_message, id: 'e3', text: '別の発言' },
        '2026-09-11T00:00:00.000Z',
      ),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.total).toBe(3);
    expect(b.distinct).toBe(2);
  });

  it('配達回数: 0 / 1 / 2以上の3分割と最大値', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T00:00:00.000Z', 1),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e3' }, '2026-09-11T00:00:00.000Z', 2),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e4' }, '2026-09-11T00:00:00.000Z', 4),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.undelivered).toBe(1);
    expect(b.deliveredOnce).toBe(1);
    expect(b.redelivered).toBe(2);
    expect(b.maxDeliveries).toBe(4);
  });

  it('齢: 0件のバケツは省かれ、残りを足すと total に一致する', () => {
    const rows = [
      // 30分前 -> 1時間未満
      row(SAMPLE_EVENTS.human_message, new Date(NOW - 30 * 60 * 1000).toISOString()),
      // 30時間前 -> 24時間以上
      row(
        { ...SAMPLE_EVENTS.human_message, id: 'e2' },
        new Date(NOW - 30 * 60 * 60 * 1000).toISOString(),
      ),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.ageBuckets).toEqual([
      { label: '1時間未満', count: 1 },
      { label: '24時間以上', count: 1 },
    ]);
    // 1〜6時間・6〜24時間は0件なので載らない。
    expect(b.ageBuckets.some((e) => e.label === '1〜6時間')).toBe(false);
    expect(b.ageBuckets.reduce((sum, e) => sum + e.count, 0)).toBe(b.total);
  });

  it('齢: 4つのバケツそれぞれに1件ずつ落ちる（各バケツの真ん中を通す）', () => {
    const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR_MS_FOR_TEST).toISOString();
    const rows = [
      row(SAMPLE_EVENTS.human_message, at(0.5)), // 1時間未満
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, at(3)), // 1〜6時間
      row({ ...SAMPLE_EVENTS.human_message, id: 'e3' }, at(12)), // 6〜24時間
      row({ ...SAMPLE_EVENTS.human_message, id: 'e4' }, at(48)), // 24時間以上
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.ageBuckets).toEqual([
      { label: '1時間未満', count: 1 },
      { label: '1〜6時間', count: 1 },
      { label: '6〜24時間', count: 1 },
      { label: '24時間以上', count: 1 },
    ]);
  });

  /**
   * ⚠ **上の歯は境界を1つも踏んでいない。** 0.5h / 3h / 12h / 48h は各バケツの
   * *真ん中*なので、境界が1時間ずれても（`hours < 6` を `hours < 7` に取り違え
   * ても）4件とも同じバケツに落ちたままで、歯は緑のままになる——実際に変異を
   * 当てて生存することを確かめた（#783 の引き継ぎ時の変異試験 M3）。
   *
   * だから**境界のちょうど上と、その 1ms 手前**を対で撃つ。境界が動けば、
   * どちらか（たいていは両方）が別のバケツへ落ちて赤くなる。
   *
   * ⭐ 実装の分岐は `hours < 1` / `hours < 6` / `hours < 24` なので、
   * **「ちょうど」は必ず上のバケツ側**（1時間ちょうどは「1時間未満」ではない）。
   */
  it('齢: 境界ちょうどは上のバケツ側、その 1ms 手前は下のバケツ側', () => {
    const atMs = (ms: number) => new Date(NOW - ms).toISOString();
    const bucketOf = (ms: number) => {
      const b = summarizeInboxBacklog([row(SAMPLE_EVENTS.human_message, atMs(ms))], NOW);
      expect(b.ageBuckets).toHaveLength(1);
      return b.ageBuckets[0]?.label;
    };

    expect(bucketOf(1 * HOUR_MS_FOR_TEST)).toBe('1〜6時間');
    expect(bucketOf(1 * HOUR_MS_FOR_TEST - 1)).toBe('1時間未満');

    expect(bucketOf(6 * HOUR_MS_FOR_TEST)).toBe('6〜24時間');
    expect(bucketOf(6 * HOUR_MS_FOR_TEST - 1)).toBe('1〜6時間');

    expect(bucketOf(24 * HOUR_MS_FOR_TEST)).toBe('24時間以上');
    expect(bucketOf(24 * HOUR_MS_FOR_TEST - 1)).toBe('6〜24時間');
  });
});

describe('describeInboxBacklogBreakdown', () => {
  it('必ず total を出す', () => {
    const b: InboxBacklogBreakdown = summarizeInboxBacklog(
      [row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z')],
      NOW,
    );
    expect(describeInboxBacklogBreakdown(b)).toContain('計 1 件');
  });

  it('0件でも呼べる（全部の軸が「無し」で埋まる）', () => {
    const b = summarizeInboxBacklog([], NOW);
    const text = describeInboxBacklogBreakdown(b);
    expect(text).toContain('計 0 件');
  });

  it('本文（text / payload の中身）を1文字も含まない', () => {
    const rows = [
      row(
        { ...SAMPLE_EVENTS.human_message, text: '絶対に外へ出てはいけない本文XYZ' },
        '2026-09-11T00:00:00.000Z',
      ),
      row(SAMPLE_EVENTS.external, '2026-09-11T00:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    const text = describeInboxBacklogBreakdown(b);
    expect(text).not.toContain('絶対に外へ出てはいけない本文XYZ');
    expect(text).not.toContain('bar'); // external.payload.foo の値
  });
});

describe('INBOX_BACKLOG_LOUD_THRESHOLD', () => {
  it('50 である（#562 の28件の倍を超えたら「詰まり」では説明が付かない、という線）', () => {
    expect(INBOX_BACKLOG_LOUD_THRESHOLD).toBe(50);
  });
});
