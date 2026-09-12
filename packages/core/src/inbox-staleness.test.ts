import { describe, expect, it } from 'vitest';

import { DAEMON_RUNNER_REGISTRY_SOURCE, DAEMON_TOKEN_POOL_REOPENED_SOURCE } from './clone.js';
import { restoredInboxEventVerdict } from './inbox-staleness.js';
import type { InboxEvent } from './schema.js';

/**
 * `inboxBacklogDedupeKey`（`inbox-backlog.ts` / `inbox-backlog.test.ts`）と
 * 同じ作法。`Record<InboxEvent['type'], InboxEvent>` にすると各値が union
 * 全体へ広がり、narrow なフィールドの上書きが「そんな欄は無い」で弾かれるので、
 * 型ごとに narrow な型を保つマップにする。
 */
type SampleEvents = { readonly [K in InboxEvent['type']]: Extract<InboxEvent, { type: K }> };

/** 7つの型それぞれの、素な1件（`external` の `source` はここでは無関係な値）。 */
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
  // `external` 以外の6つの型は、拾い直しでもすべて `live`
  // （このファイルの doc「⟹ どちらも `live` に倒す」と対になる ——
  // `external` 以外は性質で割る余地が無く、一律で残す）。
  const LIVE_ALWAYS_TYPES = (Object.keys(SAMPLE_EVENTS) as InboxEvent['type'][]).filter(
    (type) => type !== 'external',
  );

  it.each(LIVE_ALWAYS_TYPES)('%s: 常に live（token-pool の合図以外を消し込む理由が無い）', (type) => {
    expect(restoredInboxEventVerdict(SAMPLE_EVENTS[type])).toBe('live');
  });

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
    // `restoredInboxEventVerdict.length` は、デフォルト値も rest も無い
    // パラメータの個数（ここでは `event` の1個）。関数の doc
    // 「この関数は usageBlocked を受け取らない」「引数に無いことが、その形に
    // ならないことの保証である」を、実行時にも固定する。
    expect(restoredInboxEventVerdict.length).toBe(1);
  });

  it('2引数目（usageBlocked のつもりの値）を渡すと型エラーになる（tsc が検査する）', () => {
    // @ts-expect-error 2引数目は無い。`usageBlocked` を受け取る形へ広げようと
    // すると、この行の型エラーが消えて `@ts-expect-error` 自体が「不要な抑制」
    // として `pnpm typecheck` を落とす —— つまりこの歯は、実装が
    // `usageBlocked` を受け取る形へ戻る変更を、typecheck の失敗として検出する。
    restoredInboxEventVerdict(SAMPLE_EVENTS.human_message, true);
    expect(true).toBe(true);
  });
});
