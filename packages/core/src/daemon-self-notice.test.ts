import { describe, expect, it } from 'vitest';

import {
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  staleObservedRecoveryForBlockedKey,
  staleObservedRecoveryNoticeEvent,
  tokenPoolReopenedPayload,
} from './daemon-self-notice.js';
import type { InboxEvent } from './schema.js';

/**
 * **`staleObservedRecoveryForBlockedKey`**（Issue #1223 再発）。
 *
 * この関数が畳んでよいと言うのは「観測に基づく回復が、いま止まっている同じ鍵の
 * 同じ resetsAt を指しているだけ」のときだけ。1つでも条件が欠ければ、判定できない
 * ときは能力を削らない側へ倒す（AGENTS.md 地雷2）——偽（＝配ってよい）を返す。
 */
describe('staleObservedRecoveryForBlockedKey', () => {
  const NOW = 1_700_000_000_000;
  const FUTURE = NOW + 60 * 60 * 1000;
  const PAST = NOW - 1;

  function base() {
    return {
      observedRecovery: true,
      reopenedTokenId: 'tok-a',
      blockedResetsAt: FUTURE,
      blockedTokenId: 'tok-a',
      now: NOW,
    };
  }

  it('4条件がすべて揃えば真（畳んでよい）', () => {
    expect(staleObservedRecoveryForBlockedKey(base())).toBe(true);
  });

  it('観測に基づく回復でなければ偽（「回した」「冷却が明けた」は対象外）', () => {
    expect(staleObservedRecoveryForBlockedKey({ ...base(), observedRecovery: false })).toBe(false);
  });

  it('resetsAt が分からなければ偽（判定できないので配る）', () => {
    expect(staleObservedRecoveryForBlockedKey({ ...base(), blockedResetsAt: undefined })).toBe(
      false,
    );
  });

  it('いまの鍵の id が分からなければ偽（判定できないので配る）', () => {
    expect(staleObservedRecoveryForBlockedKey({ ...base(), blockedTokenId: undefined })).toBe(
      false,
    );
  });

  it('resetsAt をもう過ぎていれば偽（本物の新しい事実として配る）', () => {
    expect(staleObservedRecoveryForBlockedKey({ ...base(), blockedResetsAt: PAST })).toBe(false);
  });

  it('resetsAt ちょうど（境界）は「過ぎた」側 —— 偽', () => {
    expect(staleObservedRecoveryForBlockedKey({ ...base(), blockedResetsAt: NOW })).toBe(false);
  });

  it('違う鍵を指していれば偽（いま止まっている鍵については何も言っていない）', () => {
    expect(staleObservedRecoveryForBlockedKey({ ...base(), reopenedTokenId: 'tok-b' })).toBe(false);
  });

  it('now を省略すると Date.now() を使う', () => {
    // resetsAt を実行時から十分先に置けば、now を渡さなくても真になる。
    const farFuture = Date.now() + 60 * 60 * 1000;
    expect(
      staleObservedRecoveryForBlockedKey({
        observedRecovery: true,
        reopenedTokenId: 'tok-a',
        blockedResetsAt: farFuture,
        blockedTokenId: 'tok-a',
      }),
    ).toBe(true);
  });
});

/** `tokenPoolReopenedPayload`（Issue #1223 再発）。 */
describe('tokenPoolReopenedPayload', () => {
  function tokenPoolEvent(payload: unknown): InboxEvent {
    return {
      type: 'external',
      id: 'evt-1',
      at: '2026-09-23T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload,
    };
  }

  it('構造化した形（text/tokenId/observedRecovery）を読める', () => {
    const event = tokenPoolEvent({ text: '本文', tokenId: 'tok-a', observedRecovery: true });
    expect(tokenPoolReopenedPayload(event)).toEqual({
      text: '本文',
      tokenId: 'tok-a',
      observedRecovery: true,
    });
  });

  it('external でなければ undefined（型で弾かれる）', () => {
    const event: InboxEvent = {
      type: 'human_message',
      id: 'evt-2',
      at: '2026-09-23T00:00:00.000Z',
      text: 'こんにちは',
      conversationId: 'conv-1',
    };
    expect(tokenPoolReopenedPayload(event)).toBeUndefined();
  });

  it('source が token-pool でなければ undefined', () => {
    const event: InboxEvent = {
      type: 'external',
      id: 'evt-3',
      at: '2026-09-23T00:00:00.000Z',
      source: 'runner-registry',
      payload: { text: '本文', tokenId: 'tok-a', observedRecovery: true },
    };
    expect(tokenPoolReopenedPayload(event)).toBeUndefined();
  });

  it('payload が無ければ undefined（この直しより前に積まれた通知）', () => {
    const event: InboxEvent = {
      type: 'external',
      id: 'evt-4',
      at: '2026-09-23T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
    };
    expect(tokenPoolReopenedPayload(event)).toBeUndefined();
  });

  it('payload が文言だけ（旧形式）なら undefined（判定できないので能力を削らない側へ倒す）', () => {
    const event = tokenPoolEvent({ text: '本文だけ' });
    expect(tokenPoolReopenedPayload(event)).toBeUndefined();
  });

  it('observedRecovery が boolean でなければ undefined', () => {
    const event = tokenPoolEvent({ text: '本文', tokenId: 'tok-a', observedRecovery: 'yes' });
    expect(tokenPoolReopenedPayload(event)).toBeUndefined();
  });

  it('payload が null / 配列でも undefined（typeof object の罠を踏まない）', () => {
    expect(tokenPoolReopenedPayload(tokenPoolEvent(null))).toBeUndefined();
    expect(tokenPoolReopenedPayload(tokenPoolEvent(['not', 'an', 'object']))).toBeUndefined();
  });
});

/**
 * `staleObservedRecoveryNoticeEvent`（Issue #1223 再発）。
 *
 * `staleObservedRecoveryForBlockedKey` の event 版——`clone.ts` の `post()` と
 * `apps/daemon/src/index.ts` の `redeliveryGate` の両方がここを呼ぶ。
 */
describe('staleObservedRecoveryNoticeEvent', () => {
  const FUTURE = Date.now() + 60 * 60 * 1000;

  function tokenPoolEvent(tokenId: string, observedRecovery: boolean): InboxEvent {
    return {
      type: 'external',
      id: 'evt-1',
      at: '2026-09-23T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: { text: '本文', tokenId, observedRecovery },
    };
  }

  it('同じ鍵・観測ベース・resetsAt 未来なら真', () => {
    expect(staleObservedRecoveryNoticeEvent(tokenPoolEvent('tok-a', true), FUTURE, 'tok-a')).toBe(
      true,
    );
  });

  it('payload を持たない通知（構造化されていない）は偽——文言では判定しない', () => {
    const event: InboxEvent = {
      type: 'external',
      id: 'evt-2',
      at: '2026-09-23T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: {
        text: '認証トークンが通る状態に戻った（また通るようになった）: 「本命」（id tok-a）',
      },
    };
    expect(staleObservedRecoveryNoticeEvent(event, FUTURE, 'tok-a')).toBe(false);
  });

  it('token-pool 以外の external は偽', () => {
    const event: InboxEvent = {
      type: 'external',
      id: 'evt-3',
      at: '2026-09-23T00:00:00.000Z',
      source: 'runner-registry',
      payload: { text: '本文', tokenId: 'tok-a', observedRecovery: true },
    };
    expect(staleObservedRecoveryNoticeEvent(event, FUTURE, 'tok-a')).toBe(false);
  });
});
