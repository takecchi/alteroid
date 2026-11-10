import { StaleTokenFold } from './stale-token-fold.js';
import { UsageReceiver } from './usage-receiver.js';
import { UsageWake } from './usage-wake.js';

type WakePorts = ConstructorParameters<typeof UsageWake>[0];
type FoldPorts = ConstructorParameters<typeof StaleTokenFold>[0];
type ReceiverPorts = ConstructorParameters<typeof UsageReceiver>[0];

/**
 * `Pool` の constructor の 3 協力者（`UsageWake`・`StaleTokenFold`・`UsageReceiver`）へ渡す口の束。
 * 口（関数）は `Pool` 側で作った物をそのまま渡す（このファイルは `Pool` を知らない）。
 * 共有の Map/Set（`records` から `resumedCount` まで）は `Pool` の持つ同じ参照で、ここでコピーしない。`stores`・`tokenAvailability` は引数の値そのまま。
 * `beforeWakes`・`rateLimits`・`lastStaleDecline`・`rememberStaleDecline`・`rememberResetTimeSkew` は `Pool` 側の矢印（`this.#autoFold`・`this.#usageReceiver`・`this.#held`・`this.#usageWake` を呼ぶ時に読む）で、呼ぶまで評価されない:
 * `UsageWake` を作る時点で `#usageReceiver` はまだ無く、構築の瞬間に `rateLimits` を呼ぶと落ちる。
 * `observeForTokenRotation`・`queueSynthesizedNotice` は `UsageWake` へそのまま渡す形（3 引数・3 引数）。`UsageReceiver` へは別欄（`receiverObserveForTokenRotation` は 2 引数・`receiverQueueSynthesizedNotice` は 4 引数）を束ね直して渡す:
 * `Pool` の内側の呼びの引数の数（`heldFingerprint` を渡すか・`quotaMark` を渡すか）を、元の配線のまま変えないため。
 */
export interface UsageCollaboratorsDeps {
  stores: WakePorts['stores'] & ReceiverPorts['stores'];
  tokenAvailability: FoldPorts['tokenAvailability'];
  records: WakePorts['records'];
  usageStopped: WakePorts['usageStopped'] & ReceiverPorts['usageStopped'];
  usageWakeOwed: WakePorts['usageWakeOwed'];
  usageWakeRetry: WakePorts['usageWakeRetry'];
  usageNudgeInFlight: WakePorts['usageNudgeInFlight'];
  workerLimitStopped: WakePorts['workerLimitStopped'];
  workerLimitWakeRetry: WakePorts['workerLimitWakeRetry'];
  rotationFoldDueAt: WakePorts['rotationFoldDueAt'] & FoldPorts['rotationFoldDueAt'];
  resetTimeSkewMatches: WakePorts['resetTimeSkewMatches'];
  supersedePending: WakePorts['supersedePending'];
  tokenIdentities: WakePorts['tokenIdentities'] &
    FoldPorts['tokenIdentities'] &
    ReceiverPorts['tokenIdentities'];
  resumedCount: FoldPorts['resumedCount'];
  now: WakePorts['now'] & ReceiverPorts['now'];
  nowIso: ReceiverPorts['nowIso'];
  stopped: WakePorts['stopped'];
  load: WakePorts['load'];
  findJob: WakePorts['findJob'];
  persist: WakePorts['persist'] & ReceiverPorts['persist'];
  journal: WakePorts['journal'] & FoldPorts['journal'] & ReceiverPorts['journal'];
  journalExchange: WakePorts['journalExchange'] & ReceiverPorts['journalExchange'];
  tokenIdentity: WakePorts['tokenIdentity'] & FoldPorts['tokenIdentity'];
  send: WakePorts['send'];
  queueSynthesizedNotice: WakePorts['queueSynthesizedNotice'];
  receiverQueueSynthesizedNotice: ReceiverPorts['queueSynthesizedNotice'];
  observeForTokenRotation: WakePorts['observeForTokenRotation'];
  receiverObserveForTokenRotation: ReceiverPorts['observeForTokenRotation'];
  sessionTokenFingerprintOf: WakePorts['sessionTokenFingerprintOf'] &
    FoldPorts['sessionTokenFingerprintOf'];
  observedTokenFingerprint: FoldPorts['observedTokenFingerprint'];
  movedAwayFrom: ReceiverPorts['movedAwayFrom'];
  unpushedWork: FoldPorts['unpushedWork'];
  beforeWakes: WakePorts['beforeWakes'];
  rateLimits: WakePorts['rateLimits'];
  lastStaleDecline: FoldPorts['lastStaleDecline'];
  rememberStaleDecline: FoldPorts['rememberStaleDecline'];
  rememberResetTimeSkew: ReceiverPorts['rememberResetTimeSkew'];
}

export interface UsageCollaborators {
  usageWake: UsageWake;
  staleTokenFold: StaleTokenFold;
  usageReceiver: UsageReceiver;
}

/** 3 協力者を `usageWake → staleTokenFold → usageReceiver` の順に 1 回ずつ作る（同期）。 */
export function createUsageCollaborators(deps: UsageCollaboratorsDeps): UsageCollaborators {
  const tokenAvailability = deps.tokenAvailability;
  const usageWake = new UsageWake({
    records: deps.records,
    usageStopped: deps.usageStopped,
    usageWakeOwed: deps.usageWakeOwed,
    usageWakeRetry: deps.usageWakeRetry,
    usageNudgeInFlight: deps.usageNudgeInFlight,
    workerLimitStopped: deps.workerLimitStopped,
    workerLimitWakeRetry: deps.workerLimitWakeRetry,
    rotationFoldDueAt: deps.rotationFoldDueAt,
    resetTimeSkewMatches: deps.resetTimeSkewMatches,
    supersedePending: deps.supersedePending,
    tokenIdentities: deps.tokenIdentities,
    stores: deps.stores,
    now: deps.now,
    stopped: deps.stopped,
    load: deps.load,
    findJob: deps.findJob,
    persist: deps.persist,
    journal: deps.journal,
    // 呼び出しの形にしない: exchange-kind-coverage.test.ts が書き込み箇所として数えるため（ここは束ねるだけ）
    journalExchange: deps.journalExchange,
    tokenIdentity: deps.tokenIdentity,
    tokenAvailability:
      tokenAvailability === undefined ? undefined : (tokenId) => tokenAvailability(tokenId),
    send: deps.send,
    queueSynthesizedNotice: deps.queueSynthesizedNotice,
    observeForTokenRotation: deps.observeForTokenRotation,
    sessionTokenFingerprintOf: deps.sessionTokenFingerprintOf,
    beforeWakes: deps.beforeWakes,
    rateLimits: deps.rateLimits,
  });
  const staleTokenFold = new StaleTokenFold({
    resumedCount: deps.resumedCount,
    rotationFoldDueAt: deps.rotationFoldDueAt,
    tokenIdentities: deps.tokenIdentities,
    tokenIdentity: deps.tokenIdentity,
    tokenAvailability:
      tokenAvailability === undefined ? undefined : (tokenId) => tokenAvailability(tokenId),
    sessionTokenFingerprintOf: deps.sessionTokenFingerprintOf,
    observedTokenFingerprint: deps.observedTokenFingerprint,
    journal: deps.journal,
    lastStaleDecline: deps.lastStaleDecline,
    rememberStaleDecline: deps.rememberStaleDecline,
    unpushedWork: deps.unpushedWork,
  });
  const usageReceiver = new UsageReceiver({
    stores: deps.stores,
    now: deps.now,
    nowIso: deps.nowIso,
    tokenIdentities: deps.tokenIdentities,
    usageStopped: deps.usageStopped,
    journal: deps.journal,
    journalExchange: deps.journalExchange,
    persist: deps.persist,
    movedAwayFrom: deps.movedAwayFrom,
    observeForTokenRotation: (managerId, observation) =>
      deps.receiverObserveForTokenRotation(managerId, observation),
    rememberResetTimeSkew: deps.rememberResetTimeSkew,
    queueSynthesizedNotice: (managerId, label, text, quotaMark) =>
      deps.receiverQueueSynthesizedNotice(managerId, label, text, quotaMark),
  });
  return { usageWake, staleTokenFold, usageReceiver };
}
