import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DAEMON_RUNNER_REGISTRY_SOURCE,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
} from './daemon-self-notice.js';
import {
  INBOX_BACKLOG_LOUD_THRESHOLD,
  INBOX_BACKLOG_LOUD_TYPE_FOLD_AT,
  describeHumanOriginatedInboxAlert,
  describeInboxBacklogBreakdown,
  describeInboxBacklogQueuedInMemory,
  describeNoReadableInboxEvents,
  foldInboxBacklogByType,
  inboxBacklogCrossManagerDedupeKey,
  inboxBacklogDedupeKey,
  inboxCollapseKey,
  matchesInboxRemoveManyFilter,
  removeInboxEventsAndStopDelivery,
  summarizeInboxBacklog,
  type InboxBacklogBreakdown,
  type InboxRemoveManyFilter,
} from './inbox-backlog.js';
import type { InboxEvent } from './schema.js';
import { describeUnreadableInboxEvents } from './store.js';
import type { PendingInboxEvent } from './store.js';

const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const HOUR_MS_FOR_TEST = 60 * 60 * 1000;

function row(event: InboxEvent, at: string, deliveries = 0): PendingInboxEvent {
  return { event, at, deliveries };
}

// `Record<InboxEvent['type'], InboxEvent>` にしない: 各値が union 全体へ広がり、narrow なフィールドの上書きが弾かれるため
type SampleEvents = { readonly [K in InboxEvent['type']]: Extract<InboxEvent, { type: K }> };

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

  it('未知の type は（型では防げない実行時の値として）例外を投げる', () => {
    const unknown = { type: 'not_a_real_type', id: 'x', at: '2026-09-11T00:00:00.000Z' };
    expect(() => inboxBacklogDedupeKey(unknown as unknown as InboxEvent)).toThrow();
  });

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

  it('⭐ external: JSON.stringify は payload に生の NUL を出力しない（第3フィールドは NUL を含まない）', () => {
    const NUL = '\u0000';
    const withNul = { text: `x${NUL}y` };
    const json = JSON.stringify(withNul);
    expect(json).not.toContain(NUL);
    expect(json).toContain('\\u0000');
  });

  it('⭐ external: source に生の NUL を混ぜて境界をずらそうとしても、鍵は衝突しない（NUL区切りの裏取り）', () => {
    const NUL = '\u0000';
    const a: InboxEvent = {
      type: 'external',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      source: 'foo',
      payload: { x: 1 },
    };
    const b: InboxEvent = {
      type: 'external',
      id: 'id-b',
      at: '2026-09-11T00:00:00.000Z',
      source: `foo${NUL}${JSON.stringify({ x: 1 })}`,
      payload: null,
    };

    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });
});

describe('inboxCollapseKey（Issue #954 続き。`Clone#post()` が受信箱で畳んでよいかを決める鍵）', () => {
  it('manager_message: managerId・kind・text が同じなら同じ鍵（id・at は無視する）', () => {
    const a: InboxEvent = {
      ...SAMPLE_EVENTS.manager_message,
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
    };
    const b: InboxEvent = {
      ...SAMPLE_EVENTS.manager_message,
      id: 'id-b',
      at: '2026-09-11T05:00:00.000Z',
    };
    expect(inboxCollapseKey(a)).toBe(inboxCollapseKey(b));
    expect(inboxCollapseKey(a)).toBeDefined();
  });

  it('manager_message: managerId が違えば別の鍵（陰性対照）', () => {
    const a = SAMPLE_EVENTS.manager_message;
    const b: InboxEvent = { ...a, id: 'id-b', managerId: 'mgr-2' };
    expect(inboxCollapseKey(a)).not.toBe(inboxCollapseKey(b));
  });

  it('manager_message: kind が違えば別の鍵（陰性対照）', () => {
    const a = SAMPLE_EVENTS.manager_message;
    const b: InboxEvent = { ...a, id: 'id-b', kind: 'question' };
    expect(inboxCollapseKey(a)).not.toBe(inboxCollapseKey(b));
  });

  it('manager_message: text が違えば別の鍵（陰性対照）', () => {
    const a = SAMPLE_EVENTS.manager_message;
    const b: InboxEvent = { ...a, id: 'id-b', text: '別の報告' };
    expect(inboxCollapseKey(a)).not.toBe(inboxCollapseKey(b));
  });

  it('external + source: token-pool（DAEMON_TOKEN_POOL_REOPENED_SOURCE）: 同一 payload なら同じ鍵', () => {
    const a: InboxEvent = {
      type: 'external',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: { text: '認証トークンが通る状態に戻った' },
    };
    const b: InboxEvent = {
      ...a,
      id: 'id-b',
      at: '2026-09-11T00:00:00.100Z',
      payload: { text: '認証トークンが通る状態に戻った' },
    };
    expect(inboxCollapseKey(a)).toBe(inboxCollapseKey(b));
    expect(inboxCollapseKey(a)).toBeDefined();
  });

  it('external + source: token-pool: payload が違えば別の鍵（陰性対照。identity 省略時の後方互換）', () => {
    const a: InboxEvent = {
      type: 'external',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: { text: '（この間に同じ合図が3件届き、1件にまとめた）' },
    };
    const b: InboxEvent = {
      ...a,
      id: 'id-b',
      payload: { text: '（この間に同じ合図が5件届き、1件にまとめた）' },
    };
    expect(inboxCollapseKey(a)).not.toBe(inboxCollapseKey(b));
  });

  it('#1298 が直った後: identity が同じなら、folded だけが違う payload でも同じ鍵（畳まれる）', () => {
    const a: InboxEvent = {
      type: 'external',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: { text: '（この間に同じ合図が3件届き、1件にまとめた）' },
      identity: 'tok-a:また通るようになった',
    };
    const b: InboxEvent = {
      ...a,
      id: 'id-b',
      payload: { text: '（この間に同じ合図が5件届き、1件にまとめた）' },
      identity: 'tok-a:また通るようになった',
    };
    expect(inboxCollapseKey(a)).toBe(inboxCollapseKey(b));
    expect(inboxCollapseKey(a)).toBeDefined();
    expect(inboxBacklogDedupeKey(a)).toBe(inboxBacklogDedupeKey(b));
  });

  it('#1298 陰性対照: identity が違えば（tokenId が違う）別の鍵のまま', () => {
    const a: InboxEvent = {
      type: 'external',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: { text: '認証トークンが通る状態に戻った（また通るようになった）: 「A」' },
      identity: 'tok-a:また通るようになった',
    };
    const b: InboxEvent = {
      ...a,
      id: 'id-b',
      payload: { text: '認証トークンが通る状態に戻った（また通るようになった）: 「B」' },
      identity: 'tok-b:また通るようになった',
    };
    expect(inboxCollapseKey(a)).not.toBe(inboxCollapseKey(b));
  });

  it('#1298 陰性対照: identity が違えば（how が違う）別の鍵のまま', () => {
    const a: InboxEvent = {
      type: 'external',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: { text: '認証トークンが通る状態に戻った（回した）' },
      identity: 'tok-a:回した',
    };
    const b: InboxEvent = {
      ...a,
      id: 'id-b',
      payload: { text: '認証トークンが通る状態に戻った（また通るようになった）' },
      identity: 'tok-a:また通るようになった',
    };
    expect(inboxCollapseKey(a)).not.toBe(inboxCollapseKey(b));
  });

  it('external + source: runner-registry（DAEMON_RUNNER_REGISTRY_SOURCE）も畳む対象で、同一 payload なら同じ鍵', () => {
    const a: InboxEvent = {
      type: 'external',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      source: DAEMON_RUNNER_REGISTRY_SOURCE,
      payload: { detail: 'runner が登録に失敗した' },
    };
    const b: InboxEvent = { ...a, id: 'id-b', payload: { detail: 'runner が登録に失敗した' } };
    expect(inboxCollapseKey(a)).toBe(inboxCollapseKey(b));
    expect(inboxCollapseKey(a)).toBeDefined();
  });

  it('陰性対照: external + source: webhook（デーモン自身の合図ではない）は undefined', () => {
    const event: InboxEvent = SAMPLE_EVENTS.external;
    expect(event.type === 'external' && event.source).toBe('webhook-a');
    expect(inboxCollapseKey(event)).toBeUndefined();
  });

  it.each(
    ALL_TYPES.filter((type) => type !== 'manager_message' && type !== 'external') as Exclude<
      InboxEvent['type'],
      'manager_message' | 'external'
    >[],
  )('陰性対照: %s は畳む対象ではないので常に undefined', (type) => {
    expect(inboxCollapseKey(SAMPLE_EVENTS[type])).toBeUndefined();
  });

  it('external: payload が直列化できない（循環参照）なら畳まない側へフェイルオープンし undefined を返す', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const circular: any = { text: 'x' };
    circular.self = circular;
    const event: InboxEvent = {
      type: 'external',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: circular,
    };
    expect(inboxCollapseKey(event)).toBeUndefined();
  });
});

describe('inboxBacklogCrossManagerDedupeKey（#783 段0 追補 / issue #954）', () => {
  it('manager_message: managerId が違っても同じ鍵になる（managerId を落とす）', () => {
    const a = SAMPLE_EVENTS.manager_message;
    const b: InboxEvent = { ...a, id: 'id-b', managerId: 'mgr-2' };
    expect(inboxBacklogCrossManagerDedupeKey(a)).toBe(inboxBacklogCrossManagerDedupeKey(b));
  });

  it('manager_message: kind / text が違えば別の鍵（managerId 以外は inboxBacklogDedupeKey と同じ感度）', () => {
    const a = SAMPLE_EVENTS.manager_message;
    const byKind: InboxEvent = { ...a, id: 'id-b', kind: 'question' };
    const byText: InboxEvent = { ...a, id: 'id-c', text: '別の報告' };
    const key = inboxBacklogCrossManagerDedupeKey(a);
    expect(inboxBacklogCrossManagerDedupeKey(byKind)).not.toBe(key);
    expect(inboxBacklogCrossManagerDedupeKey(byText)).not.toBe(key);
  });

  it.each(ALL_TYPES.filter((type) => type !== 'manager_message'))(
    '%s: manager_message 以外は inboxBacklogDedupeKey と完全に同じ値を返す',
    (type) => {
      const event = SAMPLE_EVENTS[type];
      expect(inboxBacklogCrossManagerDedupeKey(event)).toBe(inboxBacklogDedupeKey(event));
    },
  );

  it('未知の type は（inboxBacklogDedupeKey への委譲を通じて）例外を投げる', () => {
    const unknown = { type: 'not_a_real_type', id: 'x', at: '2026-09-11T00:00:00.000Z' };
    expect(() => inboxBacklogCrossManagerDedupeKey(unknown as unknown as InboxEvent)).toThrow();
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
    expect(b.distinctAcrossManagers).toBe(0);
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
    expect(b.bySourceOverflowKinds).toBe(0);
    expect(b.bySourceOverflowCount).toBe(0);
    expect(b.bySourceUnknownCount).toBe(1);
  });

  it('bySource: 送信元がちょうど5種のとき、溢れは0（境界の内側）', () => {
    const rows = ['e', 'd', 'c', 'b', 'a'].map((name, i) =>
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
    expect(b.bySourceOverflowKinds).toBe(0);
    expect(b.bySourceOverflowCount).toBe(0);
    expect(b.bySource.reduce((sum, e) => sum + e.count, 0)).toBe(b.total);
  });

  it('bySource: 上位5件まで、同数は名前順で安定する（6種目は打ち切られ、溢れとして数えられる）', () => {
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
    expect(b.bySourceOverflowKinds).toBe(1);
    expect(b.bySourceOverflowCount).toBe(1);
    expect(b.bySourceUnknownCount).toBe(0);
    const bySourceSum = b.bySource.reduce((sum, e) => sum + e.count, 0);
    expect(bySourceSum + b.bySourceOverflowCount + b.bySourceUnknownCount).toBe(b.total);
  });

  it('⭐ 不変条件: bySource の総和 + bySourceOverflowCount + bySourceUnknownCount === total', () => {
    const externalRows = [
      ['a', 3],
      ['b', 3],
      ['c', 2],
      ['d', 2],
      ['e', 1],
      ['f', 1],
      ['g', 1],
    ].flatMap(([name, count]) =>
      Array.from({ length: count as number }, (_, i) =>
        row(
          { ...SAMPLE_EVENTS.external, id: `${name as string}-${i}`, source: name as string },
          '2026-09-11T00:00:00.000Z',
        ),
      ),
    );
    const unknownRows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.human_message, id: 'h2' }, '2026-09-11T00:00:00.000Z'),
    ];
    const rows = [...externalRows, ...unknownRows];
    const b = summarizeInboxBacklog(rows, NOW);

    expect(b.total).toBe(15);
    expect(b.bySource).toEqual([
      { source: 'external:a', count: 3 },
      { source: 'external:b', count: 3 },
      { source: 'external:c', count: 2 },
      { source: 'external:d', count: 2 },
      { source: 'external:e', count: 1 },
    ]);
    expect(b.bySourceOverflowKinds).toBe(2);
    expect(b.bySourceOverflowCount).toBe(2);
    expect(b.bySourceUnknownCount).toBe(2);

    const bySourceSum = b.bySource.reduce((sum, e) => sum + e.count, 0);
    expect(bySourceSum).toBe(11);
    expect(bySourceSum + b.bySourceOverflowCount + b.bySourceUnknownCount).toBe(b.total);
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

  it('distinctAcrossManagers: 同文・別managerId の manager_message が3件 → distinct は3、distinctAcrossManagers は1', () => {
    const rows = [
      row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z'),
      row(
        { ...SAMPLE_EVENTS.manager_message, id: 'e2', managerId: 'mgr-2' },
        '2026-09-11T00:00:00.000Z',
      ),
      row(
        { ...SAMPLE_EVENTS.manager_message, id: 'e3', managerId: 'mgr-3' },
        '2026-09-11T00:00:00.000Z',
      ),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.total).toBe(3);
    expect(b.distinct).toBe(3);
    expect(b.distinctAcrossManagers).toBe(1);
  });

  it('distinctAcrossManagers: 同文・同managerId の manager_message は distinct・distinctAcrossManagers ともに1', () => {
    const rows = [
      row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.manager_message, id: 'e2' }, '2026-09-11T05:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.total).toBe(2);
    expect(b.distinct).toBe(1);
    expect(b.distinctAcrossManagers).toBe(1);
  });

  it('distinctAcrossManagers: manager_message を含まない内訳では distinct と完全に一致する（残り6型は鍵が同じであるため）', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
      row(
        { ...SAMPLE_EVENTS.human_message, id: 'e2', text: '別の発言' },
        '2026-09-11T00:00:00.000Z',
      ),
      row(SAMPLE_EVENTS.external, '2026-09-11T00:00:00.000Z'),
      row(SAMPLE_EVENTS.timer, '2026-09-11T00:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.distinctAcrossManagers).toBe(b.distinct);
  });

  it('⭐ 不変条件: distinctAcrossManagers <= distinct <= total', () => {
    const rows = [
      row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z'),
      row(
        { ...SAMPLE_EVENTS.manager_message, id: 'e2', managerId: 'mgr-2' },
        '2026-09-11T00:00:00.000Z',
      ),
      row(
        { ...SAMPLE_EVENTS.manager_message, id: 'e3', managerId: 'mgr-3' },
        '2026-09-11T00:00:00.000Z',
      ),
      row(
        { ...SAMPLE_EVENTS.manager_message, id: 'e4', text: '別の報告' },
        '2026-09-11T00:00:00.000Z',
      ),
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
      row(
        { ...SAMPLE_EVENTS.human_message, id: 'e6', text: '別の発言' },
        '2026-09-11T00:00:00.000Z',
      ),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.total).toBe(6);
    expect(b.distinct).toBe(6);
    expect(b.distinctAcrossManagers).toBe(4);
    expect(b.distinctAcrossManagers).toBeLessThanOrEqual(b.distinct);
    expect(b.distinct).toBeLessThanOrEqual(b.total);
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

  it('undeliveredByType: deliveries===0 の行だけを種類別に数える（0/1/2の境界）', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T00:00:00.000Z', 1),
      row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z', 0),
      row({ ...SAMPLE_EVENTS.manager_message, id: 'e4' }, '2026-09-11T00:00:00.000Z', 2),
      row(SAMPLE_EVENTS.timer, '2026-09-11T00:00:00.000Z', 0),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.undeliveredByType).toEqual([
      { type: 'human_message', count: 1 },
      { type: 'timer', count: 1 },
      { type: 'manager_message', count: 1 },
    ]);
    expect(b.undelivered).toBe(3);
    expect(b.undeliveredByType.reduce((sum, e) => sum + e.count, 0)).toBe(b.undelivered);
  });

  it('undeliveredByType: 未配達が0件のとき、空配列になる（0件の型は載せない）', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 1),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T00:00:00.000Z', 2),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.undeliveredByType).toEqual([]);
    expect(b.undelivered).toBe(0);
  });

  it('齢: 0件のバケツは省かれ、残りを足すと total に一致する', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, new Date(NOW - 30 * 60 * 1000).toISOString()),
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
    expect(b.ageBuckets.some((e) => e.label === '1〜6時間')).toBe(false);
    expect(b.ageBuckets.reduce((sum, e) => sum + e.count, 0)).toBe(b.total);
  });

  it('齢: 4つのバケツそれぞれに1件ずつ落ちる（各バケツの真ん中を通す）', () => {
    const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR_MS_FOR_TEST).toISOString();
    const rows = [
      row(SAMPLE_EVENTS.human_message, at(0.5)),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, at(3)),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e3' }, at(12)),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e4' }, at(48)),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.ageBuckets).toEqual([
      { label: '1時間未満', count: 1 },
      { label: '1〜6時間', count: 1 },
      { label: '6〜24時間', count: 1 },
      { label: '24時間以上', count: 1 },
    ]);
  });

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

  it('humanOriginated: 人間起点が無ければ total/undelivered が0、byType は空、oldestAt を持たない', () => {
    const rows = [
      row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z'),
      row(SAMPLE_EVENTS.external, '2026-09-11T00:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.humanOriginated.total).toBe(0);
    expect(b.humanOriginated.byType).toEqual([]);
    expect(b.humanOriginated.undelivered).toBe(0);
    expect(b.humanOriginated).not.toHaveProperty('oldestAt');
  });

  it('humanOriginated: human_message だけのとき、件数・種類・最古時刻が出る', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T05:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-10T00:00:00.000Z'),
      row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.humanOriginated.total).toBe(2);
    expect(b.humanOriginated.byType).toEqual([{ type: 'human_message', count: 2 }]);
    expect(b.humanOriginated.oldestAt).toBe('2026-09-10T00:00:00.000Z');
  });

  it('humanOriginated: human_answer だけのとき、件数・種類・最古時刻が出る', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_answer, '2026-09-11T05:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.human_answer, id: 'e2' }, '2026-09-10T00:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.humanOriginated.total).toBe(2);
    expect(b.humanOriginated.byType).toEqual([{ type: 'human_answer', count: 2 }]);
    expect(b.humanOriginated.oldestAt).toBe('2026-09-10T00:00:00.000Z');
  });

  it('humanOriginated: human_message / human_answer が混在すると、両方の内訳が出て足すと total に一致する', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T00:00:00.000Z'),
      row(SAMPLE_EVENTS.human_answer, '2026-09-11T00:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.humanOriginated.total).toBe(3);
    expect(b.humanOriginated.byType).toEqual([
      { type: 'human_message', count: 2 },
      { type: 'human_answer', count: 1 },
    ]);
    expect(b.humanOriginated.byType.reduce((sum, e) => sum + e.count, 0)).toBe(
      b.humanOriginated.total,
    );
  });

  it('humanOriginated: deliveries が0のものと1以上のものが混ざると、total と undelivered が別々に正しい', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T00:00:00.000Z', 2),
      row(SAMPLE_EVENTS.human_answer, '2026-09-11T00:00:00.000Z', 1),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.humanOriginated.total).toBe(3);
    expect(b.humanOriginated.undelivered).toBe(1);
  });
});

function lineStartingWith(text: string, prefix: string): string {
  const matches = text.split('\n').filter((line) => line.startsWith(prefix));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe('describeHumanOriginatedInboxAlert（Issue #917 (B)）', () => {
  it('人間起点が0件なら空文字を返す（1文字も足さない）', () => {
    const b = summarizeInboxBacklog(
      [
        row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z'),
        row(SAMPLE_EVENTS.external, '2026-09-11T00:00:00.000Z'),
      ],
      NOW,
    );
    expect(describeHumanOriginatedInboxAlert(b)).toBe('');
  });

  it('human_message だけのとき、件数・種類・最古の受理時刻・0回の件数を出す', () => {
    const b = summarizeInboxBacklog(
      [
        row(SAMPLE_EVENTS.human_message, '2026-09-11T05:00:00.000Z', 0),
        row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-10T00:00:00.000Z', 0),
      ],
      NOW,
    );
    const text = describeHumanOriginatedInboxAlert(b);
    expect(text).toContain('人間起点');
    expect(text).toContain('2 件ある');
    expect(text).toContain('human_message 2');
    expect(text).toContain('2026-09-10T00:00:00.000Z');
    expect(text).toContain('片付いていない分が 2 件');
  });

  it('human_answer だけのとき、件数・種類が出る', () => {
    const b = summarizeInboxBacklog(
      [row(SAMPLE_EVENTS.human_answer, '2026-09-11T00:00:00.000Z', 0)],
      NOW,
    );
    const text = describeHumanOriginatedInboxAlert(b);
    expect(text).toContain('1 件ある');
    expect(text).toContain('human_answer 1');
  });

  it('human_message / human_answer が混在すると、両方の内訳が出る', () => {
    const b = summarizeInboxBacklog(
      [
        row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0),
        row(SAMPLE_EVENTS.human_answer, '2026-09-11T00:00:00.000Z', 0),
      ],
      NOW,
    );
    const text = describeHumanOriginatedInboxAlert(b);
    expect(text).toContain('2 件ある');
    expect(text).toContain('human_message 1');
    expect(text).toContain('human_answer 1');
  });

  it('deliveries が混在するとき、total と「片付いていない」件数が別々に出る', () => {
    const b = summarizeInboxBacklog(
      [
        row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0),
        row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T00:00:00.000Z', 3),
      ],
      NOW,
    );
    const text = describeHumanOriginatedInboxAlert(b);
    expect(text).toContain('2 件ある');
    expect(text).toContain('片付いていない分が 1 件');
  });

  it('「未配達」と名乗らず、「配達されていない」を断定でなく打ち消しの形でしか使わない', () => {
    const b = summarizeInboxBacklog(
      [row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0)],
      NOW,
    );
    const text = describeHumanOriginatedInboxAlert(b);
    expect(text).not.toContain('未配達');
    expect(text).toContain('配達されていないとは言えない');
    expect(text).not.toMatch(/\d+\s*分/);
  });

  it('本文（text の中身）を1文字も含まない', () => {
    const b = summarizeInboxBacklog(
      [
        row(
          { ...SAMPLE_EVENTS.human_message, text: '絶対に外へ出てはいけない本文XYZ' },
          '2026-09-11T00:00:00.000Z',
          0,
        ),
      ],
      NOW,
    );
    expect(describeHumanOriginatedInboxAlert(b)).not.toContain('絶対に外へ出てはいけない本文XYZ');
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
    expect(text).not.toContain('bar');
  });

  it('送信元の行: 溢れ・unknownが0でも数字として必ず出る（0件でも省略しない）', () => {
    const b = summarizeInboxBacklog([row(SAMPLE_EVENTS.external, '2026-09-11T00:00:00.000Z')], NOW);
    const line = lineStartingWith(describeInboxBacklogBreakdown(b), '送信元');
    expect(line).toBe(
      '送信元（上位5件。source/managerIdを持つ型のみ。溢れ 0 種 0 件 / source を言えない型 0 件）: external:webhook-a 1',
    );
  });

  it('送信元の行: 溢れ・unknownが実際に非0のとき、その数がそのまま出る', () => {
    const rows = [
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, i) =>
        row({ ...SAMPLE_EVENTS.external, id: `e-${i}`, source: name }, '2026-09-11T00:00:00.000Z'),
      ),
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    const line = lineStartingWith(describeInboxBacklogBreakdown(b), '送信元');
    expect(line).toBe(
      '送信元（上位5件。source/managerIdを持つ型のみ。溢れ 2 種 2 件 / source を言えない型 1 件）: ' +
        'external:a 1 / external:b 1 / external:c 1 / external:d 1 / external:e 1',
    );
  });

  it('0回の内訳の行: 0回が無ければ「（無し）」、在れば種類別に出る', () => {
    const zero = summarizeInboxBacklog(
      [row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 1)],
      NOW,
    );
    expect(lineStartingWith(describeInboxBacklogBreakdown(zero), 'いまの器')).toBe(
      'いまの器になってから積まれた分（0回）の内訳（種類別）: （無し）',
    );

    const some = summarizeInboxBacklog(
      [
        row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0),
        row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z', 0),
      ],
      NOW,
    );
    expect(lineStartingWith(describeInboxBacklogBreakdown(some), 'いまの器')).toBe(
      'いまの器になってから積まれた分（0回）の内訳（種類別）: human_message 1 / manager_message 1',
    );
  });

  it('同一本文の行: 数字だけでなく、両方向にぶれることと doc の在り処が刷られる', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T05:00:00.000Z'),
      row(
        { ...SAMPLE_EVENTS.human_message, id: 'e3', text: '別の発言' },
        '2026-09-11T00:00:00.000Z',
      ),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(lineStartingWith(describeInboxBacklogBreakdown(b), '同一本文')).toBe(
      '同一本文（id/at を除いた中身）を畳むと 2 件 ⚠ 本文が同じでも別々に起きた出来事である。' +
        'この数は上下どちらへもぶれる（向きと理由は inboxBacklogDedupeKey の doc）',
    );
  });

  it('同一本文の行: distinctAcrossManagers が distinct と違うときだけ、参考値が添えられる', () => {
    const rows = [
      row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z'),
      row(
        { ...SAMPLE_EVENTS.manager_message, id: 'e2', managerId: 'mgr-2' },
        '2026-09-11T00:00:00.000Z',
      ),
      row(
        { ...SAMPLE_EVENTS.manager_message, id: 'e3', managerId: 'mgr-3' },
        '2026-09-11T00:00:00.000Z',
      ),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.distinct).toBe(3);
    expect(b.distinctAcrossManagers).toBe(1);
    const line = lineStartingWith(describeInboxBacklogBreakdown(b), '同一本文');
    expect(line).toBe(
      '同一本文（id/at を除いた中身）を畳むと 3 件 ⚠ 本文が同じでも別々に起きた出来事である。' +
        'この数は上下どちらへもぶれる（向きと理由は inboxBacklogDedupeKey の doc） ／ ' +
        '同じ本文がマネージャーを跨いで 1 件（managerId を無視して数え直した参考値。' +
        'inboxBacklogCrossManagerDedupeKey の doc）',
    );
    expect(line).not.toContain('畳める');
    expect(line).not.toContain('捨てられる');
  });

  it('器の入れ替え回数の行: 軸名が「配達回数」ではなく、0回が何を意味するかを名乗る', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T00:00:00.000Z', 1),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e3' }, '2026-09-11T00:00:00.000Z', 2),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e4' }, '2026-09-11T00:00:00.000Z', 4),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(lineStartingWith(describeInboxBacklogBreakdown(b), '器の入れ替え回数')).toBe(
      '器の入れ替え回数: 0回＝いまの器になってから積まれた 1 / 1回 1 / 2回以上 2（最大 4）' +
        '⚠ 配られた回数ではない — 門が畳んだ行はターンが1度も起きないまま数だけ増える',
    );
  });

  it('出力のどこにも「配達回数」という軸名が現れない（#910 で塞いだ名前）', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0),
      row({ ...SAMPLE_EVENTS.external, id: 'e2' }, '2026-09-11T00:00:00.000Z', 3),
    ];
    const text = describeInboxBacklogBreakdown(summarizeInboxBacklog(rows, NOW));

    expect(text).not.toContain('配達回数');
    expect(text).toContain('0回＝いまの器になってから積まれた');
    expect(text).not.toContain('未配達');
    expect(lineStartingWith(text, 'いまの器になってから積まれた分')).toBe(
      'いまの器になってから積まれた分（0回）の内訳（種類別）: human_message 1',
    );
  });
});

describe('observedAt（#910 追補2 — 齢の基準点）', () => {
  it('齢の行に、渡された now が基準点として刷られる', () => {
    const b = summarizeInboxBacklog(
      [row(SAMPLE_EVENTS.human_message, '2026-09-11T11:30:00.000Z')],
      NOW,
    );
    expect(b.observedAt).toBe('2026-09-11T12:00:00.000Z');
    expect(lineStartingWith(describeInboxBacklogBreakdown(b), '齢')).toBe(
      '齢（観測 2026-09-11T12:00:00.000Z 時点。齢は相対値なので、この行を写すときは基準点も一緒に写すこと）: 1時間未満 1',
    );
  });

  it('Date.now() を呼ばない — 渡された now がそのまま基準点になる（NOW とは別の値で測る）', () => {
    const other = Date.parse('2026-01-02T03:04:05.678Z');
    const b = summarizeInboxBacklog(
      [row(SAMPLE_EVENTS.human_message, '2026-01-02T03:00:00.000Z')],
      other,
    );
    expect(b.observedAt).toBe('2026-01-02T03:04:05.678Z');
    expect(describeInboxBacklogBreakdown(b)).toContain('観測 2026-01-02T03:04:05.678Z 時点');
  });

  it('0件の内訳でも基準点は落ちない（値を作らない軸とは違い、これは必ず取れる）', () => {
    const b = summarizeInboxBacklog([], NOW);
    expect(b.observedAt).toBe('2026-09-11T12:00:00.000Z');
    expect(lineStartingWith(describeInboxBacklogBreakdown(b), '齢')).toBe(
      '齢（観測 2026-09-11T12:00:00.000Z 時点。齢は相対値なので、この行を写すときは基準点も一緒に写すこと）: （無し）',
    );
  });
});

describe('foldInboxBacklogByType（issue #1140）', () => {
  it('空なら「（無し）」を返す', () => {
    expect(foldInboxBacklogByType([])).toBe('（無し）');
  });

  it('foldAt 件以下なら、畳まずに件数の降順で並べる（同数は型名の昇順）', () => {
    const byType = [
      { type: 'timer' as const, count: 2 },
      { type: 'human_message' as const, count: 5 },
      { type: 'distill' as const, count: 2 },
    ];
    expect(foldInboxBacklogByType(byType, 3)).toBe('human_message 5 / distill 2 / timer 2');
  });

  it('foldAt を超えたら、上位 foldAt 件 + 「他 N 種 M 件」に畳む', () => {
    const byType = [
      { type: 'external' as const, count: 40 },
      { type: 'manager_message' as const, count: 30 },
      { type: 'timer' as const, count: 20 },
      { type: 'self_initiative' as const, count: 6 },
      { type: 'distill' as const, count: 4 },
    ];
    const line = foldInboxBacklogByType(byType, 3);
    expect(line).toBe('external 40 / manager_message 30 / timer 20 / 他 2 種 10 件');
  });

  it('既定の foldAt は INBOX_BACKLOG_LOUD_TYPE_FOLD_AT（3）である', () => {
    const byType = [
      { type: 'external' as const, count: 4 },
      { type: 'manager_message' as const, count: 3 },
      { type: 'timer' as const, count: 2 },
      { type: 'distill' as const, count: 1 },
    ];
    expect(foldInboxBacklogByType(byType)).toBe(
      foldInboxBacklogByType(byType, INBOX_BACKLOG_LOUD_TYPE_FOLD_AT),
    );
    expect(foldInboxBacklogByType(byType)).toContain('他 1 種 1 件');
  });

  it('上位N件 + 畳んだ残りの合計は、渡した byType の合計に一致する（算術）', () => {
    const b = summarizeInboxBacklog(
      [
        row(SAMPLE_EVENTS.human_message, '2026-09-11T11:00:00.000Z'),
        row(SAMPLE_EVENTS.timer, '2026-09-11T11:00:00.000Z'),
        row(SAMPLE_EVENTS.distill, '2026-09-11T11:00:00.000Z'),
        row(SAMPLE_EVENTS.self_initiative, '2026-09-11T11:00:00.000Z'),
      ],
      NOW,
    );
    const totalInByType = b.byType.reduce((sum, e) => sum + e.count, 0);
    expect(totalInByType).toBe(b.total);
    const line = foldInboxBacklogByType(b.byType, 2);
    expect(line).toContain('他 2 種 2 件');
  });
});

describe('describeInboxBacklogQueuedInMemory（issue #1084 / #1133）', () => {
  it('undefined なら行を出さない（省略——読めなかったこととは違う）', () => {
    expect(describeInboxBacklogQueuedInMemory(undefined)).toBeNull();
  });

  it('0 件でも行を出さない（この軸に「読めなかった」は無いので、0 は本物の0）', () => {
    expect(describeInboxBacklogQueuedInMemory(0)).toBeNull();
  });

  it('1件以上なら、件数と「足しても引いても意味が無い」の断り書きを持つ行を出す', () => {
    const line = describeInboxBacklogQueuedInMemory(3326);
    expect(line).toContain('メモリの配達待ち行列 3326 件');
    expect(line).toContain('足しても引いても意味が無い');
  });
});

describe('読めない合図（issue #2344）', () => {
  const NOW = Date.parse('2026-09-28T12:00:00.000Z');
  const UNREADABLE = [
    { id: 'evt-bad', at: '2026-09-27T00:00:00.000Z', reason: '不正な欄: event.type' },
    { reason: '不正な行' },
  ];

  it('summarizeInboxBacklog: unreadable は total に入れず、そのまま載せる', () => {
    const b = summarizeInboxBacklog([], NOW, UNREADABLE);
    expect(b.total).toBe(0);
    expect(b.unreadable).toEqual(UNREADABLE);
  });

  it('summarizeInboxBacklog: 0件なら鍵ごと無い（「読めない合図は 0 件」の値を作らない）', () => {
    expect('unreadable' in summarizeInboxBacklog([], NOW)).toBe(false);
    expect('unreadable' in summarizeInboxBacklog([], NOW, [])).toBe(false);
  });

  it('describeUnreadableInboxEvents: id が取れた行は並べ、取れない行は件数で言う。0件は null', () => {
    expect(describeUnreadableInboxEvents([])).toBeNull();
    expect(describeUnreadableInboxEvents(UNREADABLE)).toContain(
      '読めない合図が 2 件ある（id: evt-bad。id が取れない行が 1 件）',
    );
    expect(describeUnreadableInboxEvents([{ reason: 'x' }])).toContain('（id も取れない）');
  });

  it('describeUnreadableInboxEvents: id の列挙は上限で切り、切ったことを言う', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, reason: 'x' }));
    const text = describeUnreadableInboxEvents(many) ?? '';
    expect(text).toContain('e9');
    expect(text).not.toContain('e10');
    expect(text).toContain('ほか 2 件');
  });

  it('describeNoReadableInboxEvents: 読めない行が在るときだけ文を返す（「無い」とは言わない）', () => {
    expect(describeNoReadableInboxEvents([])).toBeNull();
    const text = describeNoReadableInboxEvents(UNREADABLE) ?? '';
    expect(text).not.toContain('未処理の合図は無い。');
    expect(text).toContain('読めた未処理の合図は無い（ただし、読めない行が在る');
  });

  it('describeInboxBacklogBreakdown: 読めない行が在れば末尾に足し、無ければ1文字も足さない', () => {
    const withRows = summarizeInboxBacklog([], NOW, UNREADABLE);
    expect(describeInboxBacklogBreakdown(withRows)).toContain('上の計には入っていない');
    expect(describeInboxBacklogBreakdown(summarizeInboxBacklog([], NOW))).not.toContain('読めない');
  });
});

describe('INBOX_BACKLOG_LOUD_THRESHOLD', () => {
  it('50 である（#562 の28件の倍を超えたら「詰まり」では説明が付かない、という線）', () => {
    expect(INBOX_BACKLOG_LOUD_THRESHOLD).toBe(50);
  });
});

describe('matchesInboxRemoveManyFilter（issue #972）', () => {
  it('types に無い種類は当たらない', () => {
    const filter: InboxRemoveManyFilter = { types: ['manager_message'] };
    expect(
      matchesInboxRemoveManyFilter(
        row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z'),
        filter,
      ),
    ).toBe(true);
    expect(
      matchesInboxRemoveManyFilter(
        row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
        filter,
      ),
    ).toBe(false);
  });

  it.each(ALL_TYPES)(
    '%s: types に自分の型が入っていれば当たる（source/before を渡さないとき）',
    (type) => {
      const filter: InboxRemoveManyFilter = { types: [type] };
      expect(
        matchesInboxRemoveManyFilter(row(SAMPLE_EVENTS[type], '2026-09-11T00:00:00.000Z'), filter),
      ).toBe(true);
    },
  );

  it('sources: inboxBacklogSourceFor と同じ表記（external:<source>）の完全一致だけ当たる', () => {
    const filter: InboxRemoveManyFilter = { types: ['external'], sources: ['external:webhook-a'] };
    expect(
      matchesInboxRemoveManyFilter(row(SAMPLE_EVENTS.external, '2026-09-11T00:00:00.000Z'), filter),
    ).toBe(true);
    const other: InboxEvent = { ...SAMPLE_EVENTS.external, id: 'e-2', source: 'webhook-b' };
    expect(matchesInboxRemoveManyFilter(row(other, '2026-09-11T00:00:00.000Z'), filter)).toBe(
      false,
    );
  });

  it('sources: manager_message は manager:<managerId> の表記で当てる', () => {
    const filter: InboxRemoveManyFilter = {
      types: ['manager_message'],
      sources: ['manager:mgr-1'],
    };
    expect(
      matchesInboxRemoveManyFilter(
        row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z'),
        filter,
      ),
    ).toBe(true);
    const other: InboxEvent = { ...SAMPLE_EVENTS.manager_message, id: 'e-2', managerId: 'mgr-2' };
    expect(matchesInboxRemoveManyFilter(row(other, '2026-09-11T00:00:00.000Z'), filter)).toBe(
      false,
    );
  });

  it('sources: 送信元を言えない型（human_message 等）は sources を渡すと必ず対象から外れる', () => {
    const filter: InboxRemoveManyFilter = {
      types: ['human_message'],
      sources: ['external:webhook-a'],
    };
    expect(
      matchesInboxRemoveManyFilter(
        row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
        filter,
      ),
    ).toBe(false);
  });

  it('before: at <= before の行だけ当たる（その瞬間ちょうども含む）', () => {
    const filter: InboxRemoveManyFilter = {
      types: ['human_message'],
      before: '2026-09-11T00:00:00.000Z',
    };
    expect(
      matchesInboxRemoveManyFilter(
        row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
        filter,
      ),
    ).toBe(true);
    expect(
      matchesInboxRemoveManyFilter(
        row(SAMPLE_EVENTS.human_message, '2026-09-10T23:59:59.999Z'),
        filter,
      ),
    ).toBe(true);
    expect(
      matchesInboxRemoveManyFilter(
        row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.001Z'),
        filter,
      ),
    ).toBe(false);
  });

  it('3軸は AND で効く（すべて満たしたときだけ当たる）', () => {
    const filter: InboxRemoveManyFilter = {
      types: ['manager_message'],
      sources: ['manager:mgr-1'],
      before: '2026-09-11T00:00:00.000Z',
    };
    expect(
      matchesInboxRemoveManyFilter(
        row(SAMPLE_EVENTS.manager_message, '2026-09-12T00:00:00.000Z'),
        filter,
      ),
    ).toBe(false);
    expect(
      matchesInboxRemoveManyFilter(
        row(SAMPLE_EVENTS.manager_message, '2026-09-10T00:00:00.000Z'),
        filter,
      ),
    ).toBe(true);
  });
});

describe('removeInboxEventsAndStopDelivery（消して、配達も止める。issue #1049）', () => {
  function recorder(removed: string[]) {
    const order: string[] = [];
    return {
      order,
      inbox: {
        async removeMany(ids: readonly string[]): Promise<string[]> {
          order.push(`removeMany(${ids.join(',')})`);
          return removed;
        },
      },
      delivery: {
        async dropQueuedInboxEvents(ids: readonly string[]): Promise<number> {
          order.push(`drop(${ids.join(',')})`);
          return ids.length;
        },
      },
    };
  }

  it('器から消してから配達を止める（順序が逆だと、削除に失敗した回に静かな喪失が出る）', async () => {
    const r = recorder(['a', 'b']);

    const out = await removeInboxEventsAndStopDelivery(r.inbox, r.delivery, ['a', 'b']);

    expect(out).toEqual({ removedIds: ['a', 'b'], droppedFromDelivery: 2 });
    expect(r.order).toEqual(['removeMany(a,b)', 'drop(a,b)']);
  });

  it('配達を止めるのは「実際に消えた id」だけ（器に残っている行の配達を止めない）', async () => {
    const r = recorder(['a']);

    const out = await removeInboxEventsAndStopDelivery(r.inbox, r.delivery, ['a', 'b']);

    expect(out.removedIds).toEqual(['a']);
    expect(r.order).toEqual(['removeMany(a,b)', 'drop(a)']);
  });

  it('1件も消えなければ配達停止を呼ばない', async () => {
    const r = recorder([]);

    const out = await removeInboxEventsAndStopDelivery(r.inbox, r.delivery, ['a']);

    expect(out).toEqual({ removedIds: [], droppedFromDelivery: 0 });
    expect(r.order).toEqual(['removeMany(a)']);
  });

  it('removeMany を直に呼ぶ本番コードは、この共有ヘルパの中だけである', () => {
    const targets = [
      '../../../packages/core/src/tools.ts',
      '../../../packages/core/src/clone.ts',
      '../../../apps/daemon/src/app.ts',
    ];

    const offenders = targets.filter((rel) => {
      const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
      return source
        .split('\n')
        .some((line) => !line.trimStart().startsWith('//') && line.includes('inbox.removeMany('));
    });

    expect(
      offenders,
      'removeInboxEventsAndStopDelivery を通さずに inbox.removeMany を呼んでいる。' +
        '器の行だけが消えて配達は続く（issue #1049）。',
    ).toEqual([]);
  });
});
