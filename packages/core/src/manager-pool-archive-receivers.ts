import { ArchiveReceiver } from './archive-receiver.js';
import { ManagerDenialReceiver } from './manager-denial.js';
import { ManagerParkedPeersReceiver } from './manager-parked-peers.js';
import { ManagerSessionReceiver } from './manager-session.js';
import { ManagerToolUseReceiver } from './manager-tool-use.js';
import { ManagerWaitingReceiver } from './manager-waiting.js';
import type { SessionLoaders } from './session-loaders.js';

type ArchivePorts = ConstructorParameters<typeof ArchiveReceiver>[0];
type DenialPorts = ConstructorParameters<typeof ManagerDenialReceiver>[0];
type SessionPorts = ConstructorParameters<typeof ManagerSessionReceiver>[0];
type ToolUsePorts = ConstructorParameters<typeof ManagerToolUseReceiver>[0];
type WaitingPorts = ConstructorParameters<typeof ManagerWaitingReceiver>[0];

/**
 * `Pool` の constructor で作る、生ログの受け手と出来事の受け手 6 種へ渡す口の束。口（関数）は `Pool` 側で作った物をそのまま渡す
 * （このファイルは `Pool` を知らない）。`sessionLoaders` はインスタンスで受け、口は呼ぶたびにメソッドを読む（構築時に取り出さない）。
 * `emit` は引数を取りこぼさない形で受け、`Denial`・`ParkedPeers` へは 3 引数、`Waiting` へは 5 引数に絞って渡す。
 */
export interface ArchiveAndEventReceiversDeps {
  stores: ArchivePorts['stores'];
  sessionLoaders: SessionLoaders;
  nowIso: DenialPorts['nowIso'];
  emit: (
    managerId: string,
    kind: Parameters<DenialPorts['emit']>[1] | Parameters<WaitingPorts['emit']>[1],
    text: string,
    requestId?: string,
    markup?: Parameters<WaitingPorts['emit']>[4],
  ) => void;
  persist: ArchivePorts['persist'];
  journal: ToolUsePorts['journal'];
  journalExchange: ArchivePorts['journalExchange'];
  noteRunnerSessionSince: SessionPorts['noteRunnerSessionSince'];
  observeUnpushedWorkOnce: ToolUsePorts['observeUnpushedWorkOnce'];
  rememberPluginLoad: SessionPorts['rememberPluginLoad'];
}

export interface ArchiveAndEventReceivers {
  archiveReceiver: ArchiveReceiver;
  denial: ManagerDenialReceiver;
  session: ManagerSessionReceiver;
  toolUse: ManagerToolUseReceiver;
  parkedPeers: ManagerParkedPeersReceiver;
  waiting: ManagerWaitingReceiver;
}

/** 受け手 6 種を `archiveReceiver → denial → session → toolUse → parkedPeers → waiting` の順に 1 回ずつ作る（同期）。 */
export function createArchiveAndEventReceivers(
  deps: ArchiveAndEventReceiversDeps,
): ArchiveAndEventReceivers {
  const archiveReceiver = new ArchiveReceiver({
    stores: deps.stores,
    fetchArchiveRetrying: (managerId, archiveId, fromRunnerId) =>
      deps.sessionLoaders.fetchArchiveRetrying(managerId, archiveId, fromRunnerId),
    appendMirrorRetrying: (store, event) => deps.sessionLoaders.appendMirrorRetrying(store, event),
    persist: deps.persist,
    journalExchange: deps.journalExchange,
  });
  const denial = new ManagerDenialReceiver({
    nowIso: deps.nowIso,
    journalExchange: deps.journalExchange,
    emit: (managerId, kind, text) => deps.emit(managerId, kind, text),
  });
  const session = new ManagerSessionReceiver({
    nowIso: deps.nowIso,
    journalExchange: deps.journalExchange,
    persist: deps.persist,
    noteRunnerSessionSince: deps.noteRunnerSessionSince,
    rememberPluginLoad: deps.rememberPluginLoad,
  });
  const toolUse = new ManagerToolUseReceiver({
    nowIso: deps.nowIso,
    journal: deps.journal,
    observeUnpushedWorkOnce: deps.observeUnpushedWorkOnce,
  });
  const parkedPeers = new ManagerParkedPeersReceiver({
    nowIso: deps.nowIso,
    emit: (managerId, kind, text) => deps.emit(managerId, kind, text),
    persist: deps.persist,
  });
  const waiting = new ManagerWaitingReceiver({
    persist: deps.persist,
    journal: deps.journal,
    journalExchange: deps.journalExchange,
    emit: (managerId, kind, text, requestId, markup) =>
      deps.emit(managerId, kind, text, requestId, markup),
    nowIso: deps.nowIso,
  });
  return { archiveReceiver, denial, session, toolUse, parkedPeers, waiting };
}
