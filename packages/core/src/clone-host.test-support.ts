import { fakeManagerPool } from './manager-pool.test-support.js';
import type { CloneHost } from './host.js';

/**
 * 試験の偽の `CloneHost` の工場。口の既定は「何もしない・空・`undefined`」で、試験が見る口だけ `overrides` で上書きする。
 * 口を足すとき、偽を1つずつ直さずここへ既定を足す。
 *
 * 既定は「何も起きていない」答えにする: `attach` は進行中のターンも待ちの発言も無い、`interruptTurn` は止めるものが無い（`idle`）、
 * `reopenSession` はセッションが無かった（`now`）、`sessionRefusal`・`activeTurn` は `null`、
 * `forgetConversation` は何もしない、`anthropicRoute` は空、`pluginLoad` は観測なし（`undefined`）。
 * `managers` の既定は {@link fakeManagerPool} の既定のまま。
 */
export function fakeCloneHost(overrides: Partial<CloneHost> = {}): CloneHost {
  return {
    post: () => undefined,
    postPersisted: () => Promise.resolve('persisted'),
    dropQueuedInboxEvents: () => Promise.resolve(0),
    subscribe: () => () => undefined,
    attach: () => ({ inProgress: null, pending: [], unsubscribe: () => undefined }),
    interruptTurn: () => Promise.resolve('idle'),
    reopenSession: () => Promise.resolve({ outcome: 'now', previousSessionId: null }),
    sessionRefusal: () => null,
    activeTurn: () => null,
    endConversation: () => Promise.resolve(),
    forgetConversation: () => undefined,
    answerApproval: () => Promise.resolve(),
    managers: fakeManagerPool(),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => 'now' as const,
    anthropicRoute: () => [],
    pluginLoad: () => undefined,
    stop: () => Promise.resolve(),
    ...overrides,
  };
}
