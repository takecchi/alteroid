import { describe, expect, it } from 'vitest';

import {
  commitmentFor,
  DAEMON_RUNNER_REGISTRY_SOURCE,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
} from './clone.js';
import { completedTimerRoundVerdict, restoredInboxEventVerdict } from './inbox-staleness.js';
import type { InboxEvent } from './schema.js';

// Record<InboxEvent['type'], InboxEvent> にしない: 各値が union 全体へ広がり、narrow なフィールドの上書きが弾かれるため
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
    source: 'unrelated-source-for-non-external-tests',
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

describe('restoredInboxEventVerdict', () => {
  const LIVE_ALWAYS_TYPES = (Object.keys(SAMPLE_EVENTS) as InboxEvent['type'][]).filter(
    (type) => type !== 'external',
  );

  it.each(LIVE_ALWAYS_TYPES)(
    '%s: 常に live（token-pool の合図以外を消し込む理由が無い）',
    (type) => {
      expect(restoredInboxEventVerdict(SAMPLE_EVENTS[type])).toBe('live');
    },
  );

  it('external: source が DAEMON_TOKEN_POOL_REOPENED_SOURCE（token-pool）なら stale', () => {
    const event: InboxEvent = {
      ...SAMPLE_EVENTS.external,
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
    };
    expect(restoredInboxEventVerdict(event)).toBe('stale');
  });

  it('external: source が DAEMON_RUNNER_REGISTRY_SOURCE（runner-registry）なら live（過去の事実の記録であり、今の状態の再掲ではない）', () => {
    const event: InboxEvent = {
      ...SAMPLE_EVENTS.external,
      source: DAEMON_RUNNER_REGISTRY_SOURCE,
    };
    expect(restoredInboxEventVerdict(event)).toBe('live');
  });

  it('external: 自由文字列の source（POST /events 由来のつもり）なら live（中身を知らない以上、要らないとは言えない）', () => {
    const event: InboxEvent = {
      ...SAMPLE_EVENTS.external,
      source: 'webhook-from-somewhere-outside',
    };
    expect(restoredInboxEventVerdict(event)).toBe('live');
  });

  it('未知の type は typecheck 済みの列挙で拾われ、実行時に届いても throw する（網羅性を型と実行時の両方で縛る）', () => {
    const unknown = { type: 'not-a-real-type' } as unknown as InboxEvent;
    expect(() => restoredInboxEventVerdict(unknown)).toThrow();
  });
});

describe('restoredInboxEventVerdict は usageBlocked を受け取らない（門の気分ではなく合図の性質だけで答えることを型で縛る）', () => {
  it('引数は event 1つだけ（実行時のシグネチャ）。増えたら「揺れる値で判定する」形へ戻ったということ', () => {
    expect(restoredInboxEventVerdict.length).toBe(1);
  });

  it('2引数目（usageBlocked のつもりの値）を渡すと型エラーになる（tsc が検査する）', () => {
    // @ts-expect-error 2引数目は無い
    restoredInboxEventVerdict(SAMPLE_EVENTS.human_message, true);
    expect(true).toBe(true);
  });
});

describe('restoredInboxEventVerdict が stale と言う合図は、必ず commitmentFor が null（Issue #1534 案1）', () => {
  const CANDIDATES: ReadonlyArray<readonly [string, InboxEvent]> = [
    ...(Object.keys(SAMPLE_EVENTS) as InboxEvent['type'][]).map(
      (type) => [type, SAMPLE_EVENTS[type]] as const,
    ),
    [
      'external/DAEMON_TOKEN_POOL_REOPENED_SOURCE',
      { ...SAMPLE_EVENTS.external, source: DAEMON_TOKEN_POOL_REOPENED_SOURCE },
    ],
    [
      'external/DAEMON_RUNNER_REGISTRY_SOURCE',
      { ...SAMPLE_EVENTS.external, source: DAEMON_RUNNER_REGISTRY_SOURCE },
    ],
  ];

  it.each(CANDIDATES)('%s: stale なら commitmentFor は null', (_label, event) => {
    if (restoredInboxEventVerdict(event) !== 'stale') {
      return;
    }
    expect(commitmentFor(event)).toBeNull();
  });

  it('候補のうち少なくとも1件は stale である（この歯が空振りしていないことの対照）', () => {
    expect(CANDIDATES.some(([, event]) => restoredInboxEventVerdict(event) === 'stale')).toBe(true);
  });
});

describe('completedTimerRoundVerdict（#3291）', () => {
  const timer = (at: string, cause?: 'schedule' | 'schedule_catchup' | 'manual'): InboxEvent => ({
    type: 'timer',
    id: 't-1',
    at,
    kind: 'weekly-check',
    ...(cause === undefined ? {} : { cause }),
  });
  const LAST = '2026-08-18T00:00:00.000Z';

  it('回の時刻が lastScheduledRunAt と同じ・以前なら stale（完了済みの回）', () => {
    expect(completedTimerRoundVerdict(timer(LAST), LAST)).toBe('stale');
    expect(completedTimerRoundVerdict(timer('2026-08-11T00:00:00.000Z'), LAST)).toBe('stale');
    expect(completedTimerRoundVerdict(timer(LAST, 'schedule_catchup'), LAST)).toBe('stale');
  });

  it('まだ走っていない回（lastScheduledRunAt より後）は live — 畳まない', () => {
    expect(completedTimerRoundVerdict(timer('2026-08-18T00:00:00.001Z'), LAST)).toBe('live');
    expect(completedTimerRoundVerdict(timer('2026-08-25T00:00:00.000Z'), LAST)).toBe('live');
  });

  it('時刻は実時刻で比べる（オフセット表記が違っても文字列順に引きずられない）', () => {
    expect(completedTimerRoundVerdict(timer('2026-08-18T08:00:00+09:00'), LAST)).toBe('stale');
    expect(completedTimerRoundVerdict(timer('2026-08-17T20:00:00-05:00'), LAST)).toBe('live');
  });

  it('manual は定期の基準を進めないので判定しない（live）', () => {
    expect(completedTimerRoundVerdict(timer('2026-08-11T00:00:00.000Z', 'manual'), LAST)).toBe(
      'live',
    );
  });

  it('枠保持の印（heldForUsage）のある行は、完了済みの回でも live — 配り直す（#2814 / #3317）', () => {
    const held = { ...timer('2026-08-11T00:00:00.000Z'), heldForUsage: true } as InboxEvent;
    expect(completedTimerRoundVerdict(held, LAST)).toBe('live');
    expect(completedTimerRoundVerdict(timer('2026-08-11T00:00:00.000Z'), LAST)).toBe('stale');
  });

  it('基準が無い（未登録・一度も完了していない・読めなかった）なら live、timer 以外も live', () => {
    expect(completedTimerRoundVerdict(timer('2026-08-11T00:00:00.000Z'), undefined)).toBe('live');
    expect(completedTimerRoundVerdict(SAMPLE_EVENTS.human_message, LAST)).toBe('live');
  });
});
