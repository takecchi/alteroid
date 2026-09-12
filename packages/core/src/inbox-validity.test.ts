import { describe, expect, it } from 'vitest';

import { describeValidity, inboxEventValidity } from './inbox-validity.js';
import type { InboxEvent } from './schema.js';

/**
 * `inbox-staleness.test.ts` の `SampleEvents` と同じ作法。**サンプルの鍵から
 * `InboxEvent['type']` を導く**ので、新しい型が足されればここが typecheck で
 * 落ちる（このファイルが「7つの型の網羅」を確かめる根拠）。
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
    statusAtDelivery: 'running',
  },
};

const MANAGER = 'mgr-1';

/**
 * `SAMPLE_EVENTS.manager_message` から `statusAtDelivery` だけを欠いた形。
 * **destructuring での rest 省略（`{ statusAtDelivery: _drop, ...rest }`）は
 * 使わない** —— 捨てる束縛が `@typescript-eslint/no-unused-vars` に引っかかる
 * ので、素の literal を別に持つ。
 */
const MANAGER_MESSAGE_WITHOUT_CLAIM: InboxEvent = {
  type: 'manager_message',
  id: 'e-manager_message-no-claim',
  at: '2026-09-11T00:00:00.000Z',
  managerId: MANAGER,
  kind: 'report',
  text: '終わった',
};

describe('inboxEventValidity: 7つの型の網羅', () => {
  // `manager_message` 以外の6つの型は、`statusAtDelivery` という欄自体を
  // 持たない（`schema.ts` の `inboxEventSchema`）ので、`now` の中身に関わらず
  // 常に `unclaimed`（`inbox-validity.ts` 冒頭の doc「他の6型は状態を名乗らない」）。
  const UNCLAIMED_ALWAYS_TYPES = (Object.keys(SAMPLE_EVENTS) as InboxEvent['type'][]).filter(
    (type) => type !== 'manager_message',
  );

  it.each(UNCLAIMED_ALWAYS_TYPES)(
    '%s: 常に unclaimed（statusAtDelivery を持てない型だから）',
    (type) => {
      expect(inboxEventValidity(SAMPLE_EVENTS[type], { status: 'running' })).toEqual({
        kind: 'unclaimed',
      });
    },
  );

  it('未知の type は typecheck 済みの列挙で拾われ、実行時に届いても throw する（網羅性を型と実行時の両方で縛る）', () => {
    const unknown = { type: 'not-a-real-type' } as unknown as InboxEvent;
    expect(() => inboxEventValidity(unknown, { status: 'running' })).toThrow();
  });
});

describe('inboxEventValidity: manager_message の4つの倒れ先', () => {
  it('unchanged: statusAtDelivery といまの状態が同じ', () => {
    const event = SAMPLE_EVENTS.manager_message; // statusAtDelivery: 'running'
    expect(inboxEventValidity(event, { status: 'running' })).toEqual({
      kind: 'unchanged',
      status: 'running',
    });
  });

  it('changed: statusAtDelivery といまの状態が違う', () => {
    const event = SAMPLE_EVENTS.manager_message; // statusAtDelivery: 'running'
    expect(inboxEventValidity(event, { status: 'done' })).toEqual({
      kind: 'changed',
      claimed: 'running',
      now: 'done',
    });
  });

  it('unclaimed: statusAtDelivery を持たない manager_message（任意欄が省かれた回）', () => {
    expect(inboxEventValidity(MANAGER_MESSAGE_WITHOUT_CLAIM, { status: 'running' })).toEqual({
      kind: 'unclaimed',
    });
  });

  it('unknowable: statusAtDelivery は在るが、いまの状態が引けなかった', () => {
    const event = SAMPLE_EVENTS.manager_message; // statusAtDelivery: 'running'
    expect(inboxEventValidity(event, { detail: `${MANAGER} が一覧に居ない` })).toEqual({
      kind: 'unknowable',
      claimed: 'running',
      detail: `${MANAGER} が一覧に居ない`,
    });
  });

  // ⭐ `unclaimed` と `unknowable` を `unchanged` に畳んでいないことを、
  // それぞれ別の歯で固定する（`inbox-validity.ts` 冒頭「『言えなかった』を
  // 『同じだった』に畳まない」）。上の2本（unclaimed 単体・unknowable 単体）
  // だけだと「たまたま `unchanged` にならなかった」可能性が残るので、ここで
  // 明示的に「`unchanged` の形とは違う」ことを比較する。
  it('⭐ unclaimed は unchanged の形（kind + status）に潰れていない', () => {
    const validity = inboxEventValidity(MANAGER_MESSAGE_WITHOUT_CLAIM, { status: 'running' });
    expect(validity.kind).not.toBe('unchanged');
    expect(validity).not.toHaveProperty('status');
  });

  it('⭐ unknowable は unchanged の形（kind + status）に潰れていない', () => {
    const event = SAMPLE_EVENTS.manager_message;
    const validity = inboxEventValidity(event, { detail: '読めなかった' });
    expect(validity.kind).not.toBe('unchanged');
    expect(validity).not.toHaveProperty('status');
  });
});

describe('describeValidity', () => {
  it('unchanged: 空文字（言うことが無い）', () => {
    expect(describeValidity({ kind: 'unchanged', status: 'running' }, MANAGER)).toBe('');
  });

  it('unclaimed: 空文字（言うことが無い）', () => {
    expect(describeValidity({ kind: 'unclaimed' }, MANAGER)).toBe('');
  });

  it('changed: 断り書きを組む（claimed / now 両方を名乗る）', () => {
    const text = describeValidity({ kind: 'changed', claimed: 'running', now: 'done' }, MANAGER);
    expect(text).toContain(MANAGER);
    expect(text).toContain('running');
    expect(text).toContain('done');
  });

  it('unknowable: 断り書きを組む（claimed / detail 両方を名乗り、「確かめられなかった」と言う）', () => {
    const text = describeValidity(
      { kind: 'unknowable', claimed: 'running', detail: 'mgr-1 が一覧に居ない' },
      MANAGER,
    );
    expect(text).toContain(MANAGER);
    expect(text).toContain('running');
    expect(text).toContain('mgr-1 が一覧に居ない');
    expect(text).toContain('確かめられなかった');
  });

  // ⭐ 設計の芯: 「いまは」ではなく「この断り書きを組んだ時点では」と言っている
  // ことを固定する。`#validityNoticeFor`（`clone.ts`）の doc が書いているとおり、
  // 同じターンで別に読む `#situationNotice` と食い違いうる —— どちらも「読んだ
  // 瞬間の値」としてしか名乗らなければ、食い違っても嘘にはならない。「いまは」
  // だと、後から読んだ別の断り書きと矛盾したときに文字どおり嘘になる。
  it('⭐ changed の文言は「いまは」ではなく「この断り書きを組んだ時点では」と言う', () => {
    const text = describeValidity({ kind: 'changed', claimed: 'running', now: 'done' }, MANAGER);
    expect(text).toContain('この断り書きを組んだ時点では');
    expect(text).not.toContain('いまは');
  });

  it('⭐ unknowable の文言も「組む時点」を名乗り、「いま」を単独の言い切りとして使わない', () => {
    const text = describeValidity(
      { kind: 'unknowable', claimed: 'running', detail: 'mgr-1 が一覧に居ない' },
      MANAGER,
    );
    expect(text).toContain('組む時点');
    expect(text).not.toContain('いまは');
  });

  it('未知の kind は typecheck 済みの列挙で拾われ、実行時に届いても throw する（網羅性を型と実行時の両方で縛る）', () => {
    const unknown = { kind: 'not-a-real-kind' } as unknown as Parameters<
      typeof describeValidity
    >[0];
    expect(() => describeValidity(unknown, MANAGER)).toThrow();
  });
});
