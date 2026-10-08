import { describe, expect, it } from 'vitest';

import { describeValidity, inboxEventValidity, statusValidity } from './inbox-validity.js';
import type { InboxEvent } from './schema.js';

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
    statusAtDelivery: 'running',
  },
};

const MANAGER = 'mgr-1';

// destructuring の rest 省略は使わない: 捨てる束縛が `@typescript-eslint/no-unused-vars` に引っかかるため
const MANAGER_MESSAGE_WITHOUT_CLAIM: InboxEvent = {
  type: 'manager_message',
  id: 'e-manager_message-no-claim',
  at: '2026-09-11T00:00:00.000Z',
  managerId: MANAGER,
  kind: 'report',
  text: '終わった',
};

describe('inboxEventValidity: 7つの型の網羅', () => {
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
    const event = SAMPLE_EVENTS.manager_message;
    expect(inboxEventValidity(event, { status: 'running' })).toEqual({
      kind: 'unchanged',
      status: 'running',
    });
  });

  it('changed: statusAtDelivery といまの状態が違う', () => {
    const event = SAMPLE_EVENTS.manager_message;
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
    const event = SAMPLE_EVENTS.manager_message;
    expect(inboxEventValidity(event, { detail: `${MANAGER} が一覧に居ない` })).toEqual({
      kind: 'unknowable',
      claimed: 'running',
      detail: `${MANAGER} が一覧に居ない`,
    });
  });

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

  it('⭐ subject を省略すると、従来どおり「受信箱へ積まれた」を使う（Issue #1036・出力が1バイトも変わっていないことの固定）', () => {
    const changed = describeValidity({ kind: 'changed', claimed: 'running', now: 'done' }, MANAGER);
    expect(changed).toBe(
      '⚠️ この報告が受信箱へ積まれた時点で mgr-1 は `running` でしたが、' +
        'この断り書きを組んだ時点では `done` です（報告が名乗った前提は動いています。' +
        '中身が要らなくなったとは限りません）。',
    );

    const unknowable = describeValidity(
      { kind: 'unknowable', claimed: 'running', detail: 'mgr-1 が一覧に居ない' },
      MANAGER,
    );
    expect(unknowable).toBe(
      '⚠️ この報告が受信箱へ積まれた時点で mgr-1 は `running` でしたが、' +
        'この断り書きを組む時点の状態を引けませんでした（mgr-1 が一覧に居ない）。' +
        '**「変わっていない」ではなく「確かめられなかった」です。**',
    );
  });

  it('subject を渡すと主語だけが差し替わり、それ以外の言い回しは共有する（Issue #1036）', () => {
    const text = describeValidity(
      { kind: 'changed', claimed: 'running', now: 'stopped' },
      MANAGER,
      '台帳へ書かれた',
    );
    expect(text).toContain('この報告が台帳へ書かれた時点で');
    expect(text).not.toContain('受信箱へ積まれた');
    expect(text).toContain('この断り書きを組んだ時点では');
    expect(text).toContain('報告が名乗った前提は動いています');
  });
});

describe('statusValidity: InboxEvent を経由しない核', () => {
  it('unchanged: claimed といまの状態が同じ', () => {
    expect(statusValidity('running', { status: 'running' })).toEqual({
      kind: 'unchanged',
      status: 'running',
    });
  });

  it('changed: claimed といまの状態が違う', () => {
    expect(statusValidity('running', { status: 'done' })).toEqual({
      kind: 'changed',
      claimed: 'running',
      now: 'done',
    });
  });

  it('unclaimed: claimed が undefined（名乗っていない）', () => {
    expect(statusValidity(undefined, { status: 'running' })).toEqual({ kind: 'unclaimed' });
  });

  it('unknowable: claimed は在るが、いまの状態が引けなかった', () => {
    expect(statusValidity('running', { detail: '引けなかった' })).toEqual({
      kind: 'unknowable',
      claimed: 'running',
      detail: '引けなかった',
    });
  });

  it('⭐ inboxEventValidity(manager_message) と同じ入力を通すと、statusValidity と同じ結果になる', () => {
    const event: InboxEvent = {
      type: 'manager_message',
      id: 'e-1',
      at: '2026-09-16T00:00:00.000Z',
      managerId: MANAGER,
      kind: 'report',
      text: '終わった',
      statusAtDelivery: 'running',
    };
    expect(inboxEventValidity(event, { status: 'done' })).toEqual(
      statusValidity('running', { status: 'done' }),
    );
  });
});
