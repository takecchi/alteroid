import { ManagerClosedApply } from './manager-closed-apply.js';
import { ManagerClosedFrontReceiver } from './manager-closed-front.js';
import { ManagerClosedNotice } from './manager-closed-notice.js';
import { ManagerNoteReceiver } from './manager-note.js';
import { ManagerReportApply } from './manager-report-apply.js';
import { ManagerSelfFencedReceiver } from './manager-self-fenced.js';

type SelfFencedPorts = ConstructorParameters<typeof ManagerSelfFencedReceiver>[0];
type ClosedFrontPorts = ConstructorParameters<typeof ManagerClosedFrontReceiver>[0];
type ReportApplyPorts = ConstructorParameters<typeof ManagerReportApply>[0];
type ClosedNoticePorts = ConstructorParameters<typeof ManagerClosedNotice>[0];
type NotePorts = ConstructorParameters<typeof ManagerNoteReceiver>[0];

/**
 * `Pool` の constructor の末尾で作る受け手 6 種へ渡す口の束。口（関数）は `Pool` 側で作った物をそのまま渡す
 * （このファイルは `Pool` を知らない）。`withheld`・`synthesized`・`usageStopped` などの Map/Set は `Pool` の持つ同じ参照。
 * `emit` は引数を取りこぼさない形（`(...args)`）で渡し、`SelfFenced` と `ClosedFront` へは 3 引数に絞って渡す。
 */
export interface ReceiversTailDeps {
  now: SelfFencedPorts['now'];
  nowIso: ClosedFrontPorts['nowIso'];
  emit: ClosedNoticePorts['emit'];
  persist: SelfFencedPorts['persist'];
  journal: NotePorts['journal'];
  journalExchange: SelfFencedPorts['journalExchange'];
  withdrawWaiting: SelfFencedPorts['withdrawWaiting'];
  scheduleReattach: SelfFencedPorts['scheduleReattach'];
  retire: ClosedFrontPorts['retire'];
  queueSynthesizedNotice: ClosedNoticePorts['queueSynthesizedNotice'];
  withheld: ClosedNoticePorts['withheld'];
  synthesized: ClosedNoticePorts['synthesized'];
  usageStopped: ReportApplyPorts['usageStopped'];
  resetTimeSkewMatches: ReportApplyPorts['resetTimeSkewMatches'];
  workerLimitStopped: NotePorts['workerLimitStopped'];
  tokenIdentities: NotePorts['tokenIdentities'];
}

export interface ReceiversTail {
  selfFenced: ManagerSelfFencedReceiver;
  closedFront: ManagerClosedFrontReceiver;
  reportApply: ManagerReportApply;
  closedApply: ManagerClosedApply;
  closedNotice: ManagerClosedNotice;
  note: ManagerNoteReceiver;
}

/** 受け手 6 種を `selfFenced → closedFront → reportApply → closedApply → closedNotice → note` の順に 1 回ずつ作る（同期）。 */
export function createReceiversTail(deps: ReceiversTailDeps): ReceiversTail {
  const selfFenced = new ManagerSelfFencedReceiver({
    now: deps.now,
    journalExchange: deps.journalExchange,
    persist: deps.persist,
    emit: (managerId, kind, text) => deps.emit(managerId, kind, text),
    withdrawWaiting: deps.withdrawWaiting,
    scheduleReattach: deps.scheduleReattach,
  });
  const closedFront = new ManagerClosedFrontReceiver({
    nowIso: deps.nowIso,
    journalExchange: deps.journalExchange,
    persist: deps.persist,
    emit: (managerId, kind, text) => deps.emit(managerId, kind, text),
    retire: deps.retire,
  });
  const reportApply = new ManagerReportApply({
    nowIso: deps.nowIso,
    usageStopped: deps.usageStopped,
    resetTimeSkewMatches: deps.resetTimeSkewMatches,
  });
  const closedApply = new ManagerClosedApply({
    now: deps.now,
    nowIso: deps.nowIso,
    withdrawWaiting: deps.withdrawWaiting,
  });
  const closedNotice = new ManagerClosedNotice({
    persist: deps.persist,
    journalExchange: deps.journalExchange,
    emit: deps.emit,
    queueSynthesizedNotice: deps.queueSynthesizedNotice,
    withheld: deps.withheld,
    synthesized: deps.synthesized,
  });
  const note = new ManagerNoteReceiver({
    persist: deps.persist,
    journal: deps.journal,
    journalExchange: deps.journalExchange,
    emit: deps.emit,
    workerLimitStopped: deps.workerLimitStopped,
    tokenIdentities: deps.tokenIdentities,
  });
  return { selfFenced, closedFront, reportApply, closedApply, closedNotice, note };
}
