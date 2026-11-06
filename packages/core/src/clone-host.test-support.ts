import { fakeManagerPool } from './manager-pool.test-support.js';
import type { CloneHost } from './host.js';

/**
 * 試験の偽の `CloneHost` の工場。口の既定は「何もしない・空・`undefined`」で、試験が見る口だけ `overrides` で上書きする。
 * 口を足すとき、偽を1つずつ直さずここへ既定を足す。
 *
 * 既定を置くのは、いま必須の口だけ: 省略可能な口（`attach`・`interruptTurn`・`reopenSession`・`sessionRefusal`・`activeTurn`・
 * `forgetConversation`・`anthropicRoute`・`toolSearchRoute`・`pluginLoad`）は既定を置かない。
 * 置くと「口が無いとき」の道（HTTP の 503・`unsupported` など）を通っていた試験の道が変わるため（持たない偽は、呼ぶ側がその口が無い場合の道へ倒す）。
 * `managers` の既定は {@link fakeManagerPool} の既定のまま。
 */
export function fakeCloneHost(overrides: Partial<CloneHost> = {}): CloneHost {
  return {
    post: () => undefined,
    postPersisted: () => Promise.resolve('persisted'),
    dropQueuedInboxEvents: () => Promise.resolve(0),
    subscribe: () => () => undefined,
    endConversation: () => Promise.resolve(),
    answerApproval: () => Promise.resolve(),
    managers: fakeManagerPool(),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: () => Promise.resolve(),
    ...overrides,
  };
}
