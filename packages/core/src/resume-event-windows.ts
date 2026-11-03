import { noteBackgroundFailure, runnerEventShape } from './dropped-record.js';
import { EXCHANGE_KIND_DECISION_PREFIX } from './exchange-kind.js';
import type { ManagerRecord } from './manager.js';
import type { DroppedReportFiles } from './manager-notices.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { JournalEntryInput } from './schema.js';

/** 窓の間に預けうる出来事の種類（どの種類を預けるかは窓ごとに `deferIfWindow` / `deferClosedIfWindow` が選ぶ）。 */
type DeferrableEvent = Extract<
  RunnerEvent,
  { type: 'closed' | 'session' | 'report' | 'ask' | 'settled' }
>;

interface ResumeEventWindowsDeps {
  records: ReadonlyMap<string, ManagerRecord>;
  /** `Pool#judgeSessionGeneration` を束ねたもの。 */
  judgeSessionGeneration: (
    record: ManagerRecord,
    event: RunnerEvent,
  ) => 'stale' | 'current' | 'unknown';
  /** `manager.ts` の `trackedGenerationSilent` を束ねたもの（manager.ts の他の所からも呼ばれるので、そちらに置いたまま）。 */
  trackedGenerationSilent: (record: ManagerRecord) => boolean;
  /** `Pool#onEvent` を束ねたもの。窓を閉じた後に呼ぶので、窓の再入は預け直しにならない。Promise はそのまま返す。 */
  onEvent: (event: RunnerEvent, fromRunnerId: string) => Promise<void>;
  /** `Pool#droppedReportFiles` を束ねたもの。 */
  droppedReportFiles: (event: RunnerEvent, fromRunnerId: string) => Promise<DroppedReportFiles>;
  /** `Pool#journal` を束ねたもの。 */
  journal: (entry: JournalEntryInput) => Promise<void>;
}

/**
 * resume が飛んでいる最中に届く、元の runner（や移送先）の出来事を預ける窓: 移送の窓（`openRelocation`）と、
 * 同じ runner への復帰の窓（`openSameRunner`）。預ける列（`#deferredEvents`）と閉じ方（`close`）は2つの窓で共有する。
 */
export class ResumeEventWindows {
  /**
   * `case 'closed'` の「移った後の古い出来事を捨てる」判定は `job.runnerId` が移送先へ書き換わるまで効かず、
   * その窓に元の runner の遅れた `closed(lost)` が届くと台帳が `lost` になり、移送先が persist されない。
   * `#resuming` を流用しない: 移送先を知る材料が無い。
   */
  readonly #relocatingTo = new Map<string, string>();
  /**
   * `#relocatingTo` に同じ runnerId を立てない: あちらは受理されたら処理し直し・受理されなければ捨てるが、
   * 同じ runner への復帰ではその向きが逆（受理されたら古いセッションの `closed` を捨て、失敗したら `lost` にする）で、
   * 同じ値を立てると失敗した回の `closed(lost)` を捨てる。預かる列と閉じ方だけを共有する。
   *
   * 預かるのは `closed` と `report` だけ（`session` / `ask` / `settled` は預けない）: それらは預けて遅らせても得るものが無く、
   * 受理の後まで遅らせると新しいセッションの `ask` を待たせる。`closed` には世代の識別子が無いので、窓の間に届いたものは古い世代と読む。
   * `report` を預ける理由: その場で処理すると `lastReportAt` が resume の応答の前の時刻になり、
   * あとの `closed(done)` で「このセッションで report を受け取っていない」と誤る。
   */
  readonly #sameRunnerResumeWindow = new Map<string, string>();
  /**
   * 捨てずに預かる: 移送が受理されれば古い世代として日誌にだけ残し、失敗したなら（元の runner の出来事は事実のまま）
   * 届いた順に `#onEvent` で処理し直す。
   */
  readonly #deferredEvents = new Map<string, { event: DeferrableEvent; fromRunnerId: string }[]>();
  readonly #records: ResumeEventWindowsDeps['records'];
  readonly #judgeSessionGeneration: ResumeEventWindowsDeps['judgeSessionGeneration'];
  readonly #trackedGenerationSilent: ResumeEventWindowsDeps['trackedGenerationSilent'];
  readonly #onEvent: ResumeEventWindowsDeps['onEvent'];
  readonly #droppedReportFiles: ResumeEventWindowsDeps['droppedReportFiles'];
  readonly #journal: ResumeEventWindowsDeps['journal'];

  constructor(deps: ResumeEventWindowsDeps) {
    this.#records = deps.records;
    this.#judgeSessionGeneration = deps.judgeSessionGeneration;
    this.#trackedGenerationSilent = deps.trackedGenerationSilent;
    this.#onEvent = deps.onEvent;
    this.#droppedReportFiles = deps.droppedReportFiles;
    this.#journal = deps.journal;
  }

  openRelocation(managerId: string, targetRunnerId: string): void {
    this.#relocatingTo.set(managerId, targetRunnerId);
  }

  openSameRunner(managerId: string, runnerId: string): void {
    this.#sameRunnerResumeWindow.set(managerId, runnerId);
  }

  /** 受理されなかった移送では元の runner の出来事を処理し直す: 捨てると lost や report を取りこぼす。受理されたなら古い世代の出来事なので日誌にだけ残して捨てる。 */
  async close(managerId: string, moved: boolean): Promise<void> {
    const target = this.#relocatingTo.get(managerId);
    this.#relocatingTo.delete(managerId);
    const sameRunner = this.#sameRunnerResumeWindow.get(managerId);
    this.#sameRunnerResumeWindow.delete(managerId);
    const held = this.#deferredEvents.get(managerId) ?? [];
    this.#deferredEvents.delete(managerId);
    for (const { event, fromRunnerId } of held) {
      // 1件が投げても残りを捨てない（預かった順に続ける）: 投げた1件は跡だけ残す。処理し直す道（預け直し・梯子）は無い（窓は閉じ済みで、`#onEvent` が窓の外から直接処理する）。
      try {
        // 同じ runner への復帰の窓: 受理されたなら、窓の間に届いた `closed` は resume の前のセッションの畳みなので日誌にだけ残して捨てる。
        if (sameRunner !== undefined) {
          // 新しいセッション自身の出来事だと分かるなら古い世代として捨てない。`report` は追っている世代が無い（`unknown`）ときも処理し直し、`closed` は世代が一致するときだけ。
          const record = this.#records.get(managerId);
          const generation =
            record === undefined ? 'unknown' : this.#judgeSessionGeneration(record, event);
          // 古い世代の `report` でも、新しい世代がまだ何も出していなければ処理し直す（#5195 / #5203）: 捨てるか知らせるかは `#handleEvent` の同じ判定に任せる
          const trackedSilent = record !== undefined && this.#trackedGenerationSilent(record);
          if (
            !moved ||
            generation === 'current' ||
            (event.type === 'report' && (generation === 'unknown' || trackedSilent))
          ) {
            await this.#onEvent(event, fromRunnerId);
            continue;
          }
          const dropped = await this.#droppedReportFiles(event, fromRunnerId);
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `${EXCHANGE_KIND_DECISION_PREFIX}[${managerId}] （同じ runner ${sameRunner} への復帰の resume の最中に届いた、` +
              `古いセッションの出来事のため無視。resume は受理された）` +
              (event.type === 'closed'
                ? `runner 側の終了イベント（status=${event.status}）を受け取った: ${event.reason}`
                : `古いセッションの ${event.type} を無視した`) +
              dropped.text,
            ...dropped.attachments,
          });
          continue;
        }
        const fromTarget = fromRunnerId === target;
        // 移送先自身の出来事: 受理されたなら通常の経路で処理し直し、受理されなかったなら移送先は引き取っていないので日誌にだけ残して捨てる。
        if (fromTarget && moved) {
          await this.#onEvent(event, fromRunnerId);
          continue;
        }
        if (moved || fromTarget) {
          const dropped = await this.#droppedReportFiles(event, fromRunnerId);
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            ...dropped.attachments,
            text:
              `${EXCHANGE_KIND_DECISION_PREFIX}[${managerId}] （移送の最中に届いた古い runner の出来事のため無視。` +
              `移送先は ${target}、この出来事は ${fromRunnerId} から${
                fromTarget ? '。移送は受理されなかった' : ''
              }）` +
              (event.type === 'closed'
                ? `runner 側の終了イベント（status=${event.status}）を受け取った: ${event.reason}`
                : `移送の最中に届いた古い runner の ${event.type} を無視した`) +
              dropped.text,
          });
        } else {
          await this.#onEvent(event, fromRunnerId);
        }
      } catch (error) {
        noteBackgroundFailure(
          '移送の窓で預かった出来事の処理し直し',
          runnerEventShape(event),
          error,
        );
      }
    }
  }

  /** `#handleEvent` の入口の段: 移送中・同じ runner への復帰窓の出来事を預ける（同期。預けたら true）。 */
  deferIfWindow(event: RunnerEvent, fromRunnerId: string): boolean {
    // 窓の間は `job.runnerId` がまだ元の runner で `#ignoreIfMovedAway` が素通りし、移送の前に古い報告が台帳と受信箱へ流れるので、結論が出るまで預かる。
    if (
      event.type === 'session' ||
      event.type === 'report' ||
      event.type === 'ask' ||
      event.type === 'settled'
    ) {
      // 移送先自身の出来事も預かる: 素通りさせると `#ignoreIfMovedAway` が「移った後の古い runner」と読んで捨てる。
      if (this.#relocatingTo.has(event.managerId)) {
        this.#deferEvent(event, fromRunnerId);
        return true;
      }
      // 世代で選り分けない: 世代の判定は窓が閉じるとき（応答で追う世代が決まった後）に行う。
      if (
        event.type === 'report' &&
        this.#sameRunnerResumeWindow.get(event.managerId) === fromRunnerId
      ) {
        this.#deferEvent(event, fromRunnerId);
        return true;
      }
    }
    return false;
  }

  /** `#ignoreOrDeferClosed` の窓の部分（同期。預けたら true）。 */
  deferClosedIfWindow(
    event: Extract<RunnerEvent, { type: 'closed' }>,
    fromRunnerId: string,
    generation: 'stale' | 'current' | 'unknown',
  ): boolean {
    // 移送の resume が飛んでいる最中の closed は結論が出るまで預かる（`#relocatingTo`）: 捨てると移送が失敗した回に元の runner の lost を取りこぼし、処理すると受理された回に台帳が lost のまま残る。移送先自身の closed も預かる（素通りさせると下の runner-id 不一致で捨てる）。
    if (this.#relocatingTo.has(event.managerId)) {
      this.#deferEvent(event, fromRunnerId);
      return true;
    }
    // 同じ runner への復帰の resume の最中の closed も預かるが、いま追っているセッション自身の出来事（世代が一致）は預けない: 窓は「窓の間に届いたものは古い世代」と読む近似で、世代が分かる出来事には使わない。
    // 預けた列が空でない間は、一致する `closed` も列の後ろへ並べる: その場で処理すると、先に預けた `report` より先に `closed(done)` が処理され、`lastReportAt` が古いまま「report 無しの done」と誤って知らせる。
    if (
      this.#sameRunnerResumeWindow.get(event.managerId) === fromRunnerId &&
      (generation !== 'current' || (this.#deferredEvents.get(event.managerId)?.length ?? 0) > 0)
    ) {
      this.#deferEvent(event, fromRunnerId);
      return true;
    }
    return false;
  }

  /** 移送の窓の間に届いた出来事を、届いた順に預ける（`#deferredEvents`）。同期で呼ぶこと。 */
  #deferEvent(event: DeferrableEvent, fromRunnerId: string): void {
    const held = this.#deferredEvents.get(event.managerId) ?? [];
    held.push({ event, fromRunnerId });
    this.#deferredEvents.set(event.managerId, held);
  }
}
