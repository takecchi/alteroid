import { AttachmentStager } from './attachment-stager.js';
import { AutoFold } from './auto-fold.js';
import { DenialRenotifier } from './denial-renotify.js';
import { HeldMessages } from './held-messages.js';
import { ManagerRescueStash } from './manager-rescue-stash.js';
import { RescueSweeper } from './rescue-sweeper.js';

type AutoFoldPorts = ConstructorParameters<typeof AutoFold>[0];
type DenialPorts = ConstructorParameters<typeof DenialRenotifier>[0];
type SweeperPorts = ConstructorParameters<typeof RescueSweeper>[0];
type StagerPorts = ConstructorParameters<typeof AttachmentStager>[0];
type StashPorts = ConstructorParameters<typeof ManagerRescueStash>[0];
type HeldPorts = ConstructorParameters<typeof HeldMessages>[0];

/**
 * `Pool` の constructor の 6 協力者（`AutoFold`・`DenialRenotifier`・`RescueSweeper`・`AttachmentStager`・`ManagerRescueStash`・`HeldMessages`）へ渡す口の束。
 * 口（関数）は `Pool` 側で作った物をそのまま渡す（このファイルは `Pool` を知らない）。
 * `records`・`usageStopped` は `Pool` の持つ同じ参照。`runners`・`stores`・`attachmentLimits` は引数の値そのまま。
 * `retainedIds` は `Pool` 側の式（`#held` への lazy 参照を含む）で、呼ぶまで評価されない: `HeldMessages` はこの関数の最後に作るので、構築の瞬間に呼ぶと `#held` はまだ無い。
 * `emit`・`send` は引数を取りこぼさない形で受け、協力者ごとに必要な引数（`'report'` 固定・届け方の固定・`{}` 固定）へ絞って渡す。
 */
export interface FoldHeldDeps {
  runners: AutoFoldPorts['runners'];
  stores: SweeperPorts['stores'];
  attachmentLimits: StashPorts['attachmentLimits'];
  records: DenialPorts['records'];
  usageStopped: HeldPorts['usageStopped'];
  resuming: HeldPorts['resuming'];
  now: AutoFoldPorts['now'];
  nowIso: SweeperPorts['nowIso'];
  stopped: AutoFoldPorts['stopped'];
  retainedIds: AutoFoldPorts['retainedIds'];
  journal: AutoFoldPorts['journal'];
  persist: SweeperPorts['persist'];
  load: StashPorts['load'];
  send: (
    managerId: string,
    message: string,
    options: Parameters<StashPorts['send']>[2],
    delivery: Parameters<HeldPorts['send']>[2] | { mode: 'caller' },
  ) => ReturnType<HeldPorts['send']>;
  emit: (managerId: string, kind: 'report', text: string) => void;
  queueNotice: HeldPorts['queueNotice'];
  runnerHasCapability: AutoFoldPorts['runnerHasCapability'];
  findJob: AutoFoldPorts['findJob'];
  runnerIdOf: AutoFoldPorts['runnerIdOf'];
  list: AutoFoldPorts['list'];
  observeUnpushedWork: AutoFoldPorts['observeUnpushedWork'];
  abort: AutoFoldPorts['abort'];
  runnerOf: SweeperPorts['runnerOf'];
  runnersOrEmpty: SweeperPorts['runnersOrEmpty'];
  runnerOrNull: StashPorts['runnerOrNull'];
  awaitHello: StagerPorts['awaitHello'];
  openAttachment: StagerPorts['openAttachment'];
  sighting: (runnerId: string) => { instanceId?: ReturnType<StashPorts['instanceIdOf']> };
  swapNote: StashPorts['swapNote'];
}

export interface FoldHeld {
  autoFold: AutoFold;
  denialRenotifier: DenialRenotifier;
  rescueSweeper: RescueSweeper;
  attachmentStager: AttachmentStager;
  rescueStash: ManagerRescueStash;
  held: HeldMessages;
}

/** 6 協力者を `autoFold → denialRenotifier → rescueSweeper → attachmentStager → rescueStash → held` の順に 1 回ずつ作る（同期）。 */
export function createFoldHeld(deps: FoldHeldDeps): FoldHeld {
  const autoFold = new AutoFold({
    runners: deps.runners,
    now: deps.now,
    stopped: deps.stopped,
    retainedIds: deps.retainedIds,
    runnerHasCapability: deps.runnerHasCapability,
    findJob: deps.findJob,
    runnerIdOf: deps.runnerIdOf,
    list: deps.list,
    observeUnpushedWork: deps.observeUnpushedWork,
    abort: deps.abort,
    journal: deps.journal,
  });
  const denialRenotifier = new DenialRenotifier({
    records: deps.records,
    now: deps.now,
    stopped: deps.stopped,
    emitReport: (managerId, text) => {
      deps.emit(managerId, 'report', text);
    },
  });
  const rescueSweeper = new RescueSweeper({
    records: deps.records,
    stores: deps.stores,
    now: deps.now,
    nowIso: deps.nowIso,
    stopped: deps.stopped,
    journal: deps.journal,
    persist: deps.persist,
    runnerOf: deps.runnerOf,
    runnersOrEmpty: deps.runnersOrEmpty,
  });
  const attachmentStager = new AttachmentStager({
    awaitHello: deps.awaitHello,
    hasCapability: (runnerId, capability) => deps.runnerHasCapability(runnerId, capability),
    openAttachment: deps.openAttachment,
  });
  const rescueStash = new ManagerRescueStash({
    stores: deps.stores,
    attachmentLimits: deps.attachmentLimits,
    runnerOrNull: deps.runnerOrNull,
    runnerHasCapability: deps.runnerHasCapability,
    instanceIdOf: (runnerId) => deps.sighting(runnerId).instanceId,
    swapNote: deps.swapNote,
    nowIso: deps.nowIso,
    persist: deps.persist,
    journal: deps.journal,
    records: deps.records,
    load: deps.load,
    send: (managerId, text, options) => deps.send(managerId, text, options, { mode: 'caller' }),
  });
  const held = new HeldMessages({
    records: deps.records,
    load: deps.load,
    persist: deps.persist,
    journal: deps.journal,
    queueNotice: deps.queueNotice,
    send: (managerId, message, delivery) => deps.send(managerId, message, {}, delivery),
    now: deps.now,
    nowIso: deps.nowIso,
    stopped: deps.stopped,
    usageStopped: deps.usageStopped,
    resuming: deps.resuming,
  });
  return { autoFold, denialRenotifier, rescueSweeper, attachmentStager, rescueStash, held };
}
