import { releaseLease } from './lease.js';
import type { ManagerRecord } from './manager.js';
import type { RunnerEvent, RunnerRegistry } from './runner-protocol.js';
import {
  carryKnownBranches,
  isUnpushedWorkObservationAtLeastAsNewAs,
  unpushedWorkObservationOf,
} from './unpushed-work-observation.js';

type ClosedEvent = Extract<RunnerEvent, { type: 'closed' }>;

/** 器の名簿へ知らせる pids 飽和の印（`RunnerRegistry#notePidsSaturationSign` の第 2 引数）。 */
type PidsSaturationSign = Parameters<RunnerRegistry['notePidsSaturationSign']>[1];

/**
 * `Pool` が口として渡すもの（読むだけの 3 本）。いずれも呼ぶたびに `Pool` の側で引く（時計は構築の後でも差し替わりうる）。
 * 関数の口は async の皮で包まずに渡す（同期のまま保つため）。
 */
interface ManagerClosedApplyPorts {
  /** `Pool#now` を束ねたもの（`releaseLease` へ渡す時刻。器の時計を直に読まない）。 */
  now: () => number;
  /** `Pool#nowIso` を束ねたもの（器の時計を直に読まない）。 */
  nowIso: () => string;
  /** `Pool#withdrawWaiting`（待っている確認を取り下げて日誌へ残す。広く共有する。同期）。 */
  withdrawWaiting: (record: ManagerRecord, reason: string) => void;
}

/**
 * `closed` の本体（`Pool#closeJob`）の頭の、台帳へ写す同期の段（`Pool#handleEvent` から切り出した。振る舞いは変えていない）。
 * 自前の欄は持たない: 書くのは引数の `record`（`job`・`attached`・`waiting`）だけ。`await` を持たず、`Pool#closeJob` の
 * `this.#closedApply.applyClosedToJob(record, event); await this.#persist(...)` の同期の位置を変えない。
 */
export class ManagerClosedApply {
  readonly #ports: ManagerClosedApplyPorts;

  constructor(ports: ManagerClosedApplyPorts) {
    this.#ports = ports;
  }

  // `closed` の段3-1: 状態・貸し出し・直近の失敗の事実・未 push の観測を台帳（`record.job`）へ写す。同期のまま保つ。
  applyClosedToJob(record: ManagerRecord, event: ClosedEvent): void {
    record.job.status = event.status;
    // 閉じたのだから背景待ちの保留も下ろす（`closed(done)` は `status` が `done` のままなので `#persist` の掃除では落ちない）
    delete record.job.awaitingBackgroundSince;
    this.#ports.withdrawWaiting(record, `セッションが閉じた（status=${event.status}）`);
    record.attached = false;
    // 貸し出しは期限を待たず返す（`closed` は持ち主自身が「もう走っていない」と言っている）: 返さないと引き取りが猶予のぶん遅れる。消さずに印を立てる: 消すと世代（`fence`）まで消え、遅れて届いた返却で runner の世代より小さい世代を渡し命令が拒まれ続ける。
    if (record.job.lease !== undefined) {
      record.job.lease = releaseLease(record.job.lease, this.#ports.now());
    }
    // 台帳へも残す: 受信箱は流れるので、本文だけでは振り返る面（`manager_list` / `manager_report`）から復元できない。無い回に既定値を作らない。
    // 先に前の回の値を下ろす: 欄が無い回に下ろさないと、続けて `failed` で閉じたとき1回目の値が今回の落ち方として残る。`status` では絞らない。
    delete record.job.lastSystemError;
    if (event.status === 'failed' && event.systemError !== undefined) {
      record.job.lastSystemError = {
        ...event.systemError,
        at: this.#ports.nowIso(),
      };
    }
    // `lastSystemError` と同じ理由・同じ条件（`failed` の回だけ）で、先に前の回の値を下ろす。
    delete record.job.lastCgroupEvents;
    if (event.status === 'failed' && event.cgroupEvents !== undefined) {
      record.job.lastCgroupEvents = {
        ...event.cgroupEvents,
        at: this.#ports.nowIso(),
      };
    }
    // `unpushedWork` は `status` で絞らない: 「どの枝を見ればよいか」は失敗特有の事実ではない。同じ上書きガードを通す: `report` / `tool_use` の fire-and-forget が非同期に競走し、`closed` の処理より後に解決しうる。
    // `#recordUnpushedWorkObservation` を直接呼ばない: 自分で `#persist` するので、直後の `#persist` と二重に書き込む。
    if (event.unpushedWork !== undefined) {
      const at = this.#ports.nowIso();
      const observation = unpushedWorkObservationOf(event.unpushedWork, at, 'closed');
      if (
        isUnpushedWorkObservationAtLeastAsNewAs(observation, record.job.lastUnpushedWorkObservation)
      ) {
        record.job.lastUnpushedWorkObservation = carryKnownBranches(
          observation,
          record.job.lastUnpushedWorkObservation,
        );
      }
    }
  }
}

/**
 * `closed` の段3-2: `failed` / `lost` の落ち方から、器の pids 飽和の印を判定する（純関数。名簿へ知らせるのは呼び元）。
 * 並びは知らせる順そのもの（eagain → fork-denied）: 呼び元は並びのとおりに `notePidsSaturationSign` を呼ぶ。
 */
export function pidsSaturationSignsOf(event: ClosedEvent): PidsSaturationSign[] {
  // `failed` だけでなく `lost` も見る: SIGABRT の `failed` の後の resume が `spawn … EAGAIN` で `lost` になる形で、後者は `failed` 専用の `noteManagerFailed` に届かない。判定は構造化された値だけ。
  if (event.status !== 'failed' && event.status !== 'lost') return [];
  const signs: PidsSaturationSign[] = [];
  if (event.systemError?.code === 'EAGAIN') signs.push('eagain');
  if ((event.cgroupEvents?.pidsMaxDelta ?? 0) > 0) signs.push('fork-denied');
  return signs;
}
