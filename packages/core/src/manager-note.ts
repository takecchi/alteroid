import { EXCHANGE_KIND_REPLY_PREFIX } from './exchange-kind.js';
import type { ManagerRecord } from './manager.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { JournalEntryInput } from './schema.js';
import type { SynthesizedNoticeWindows } from './synthesized-notice-windows.js';

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;

/**
 * `Pool` が口として渡すもの。
 * `workerLimitStopped`・`tokenIdentities` は `Pool` が持つ Map の参照そのもの（`UsageWake` などと共有する。コピーしない。`tokenIdentities` はここでは読むだけ）。
 * 関数の口は async の皮で包まずに渡す（`await` の数と順を変えないため）。`emit` は同期のまま渡す。
 */
interface ManagerNoteReceiverPorts {
  /** `Pool#persist`（台帳へ書く）。 */
  persist: (record: ManagerRecord) => Promise<void>;
  /** `Pool#journal`（日誌へ書く）。 */
  journal: (entry: JournalEntryInput) => Promise<void>;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  /** `Pool#emit`（合成した知らせの窓を経由して受信箱へ積む。同期。`notifyClone` の知らせは 9 引数の形で呼ぶ）。 */
  emit: (...args: Parameters<SynthesizedNoticeWindows['emit']>) => void;
  /** 作業者の落ちの印（`Pool#workerLimitStopped`）の参照。 */
  workerLimitStopped: Map<
    string,
    { readonly preRotationKey: boolean; readonly turnStartedAt: string | undefined }
  >;
  /** 担当ごとの鍵の世代の記憶（`Pool#tokenIdentities`）の参照。読むだけ。 */
  tokenIdentities: ReadonlyMap<string, { tokenId: string; generation: number }>;
}

/**
 * 担当の出来事 `note` の 3 つの段（印を立てる・日誌へ残す・クローンへの知らせを積む）を受け持つ側（`Pool#handleEvent` の `case 'note'` が、
 * 元と同じ `await` の並びのまま呼ぶ。`Pool` の `#markWorkerLimitStopped`・`#journalNote`・`#emitNoteNotices` から切り出した。振る舞いは変えていない）。
 * 自前の欄は持たない: 書くのは引数の `record.job` と、口で受けた印の Map だけ。
 * `case 'note'` の本文（`describeWorkerLimitKey` の呼び位置・`#rememberTokenIdentity`・`await` の並び）は `Pool` に残す。`return` へまとめると完了の周回が増える。
 */
export class ManagerNoteReceiver {
  readonly #persist: ManagerNoteReceiverPorts['persist'];
  readonly #journal: ManagerNoteReceiverPorts['journal'];
  readonly #journalExchange: ManagerNoteReceiverPorts['journalExchange'];
  readonly #emit: ManagerNoteReceiverPorts['emit'];
  readonly #workerLimitStopped: ManagerNoteReceiverPorts['workerLimitStopped'];
  readonly #tokenIdentities: ManagerNoteReceiverPorts['tokenIdentities'];

  constructor(ports: ManagerNoteReceiverPorts) {
    this.#persist = ports.persist;
    this.#journal = ports.journal;
    this.#journalExchange = ports.journalExchange;
    this.#emit = ports.emit;
    this.#workerLimitStopped = ports.workerLimitStopped;
    this.#tokenIdentities = ports.tokenIdentities;
  }

  /** `note` の段1: 作業者の落ちの印を立てて台帳へ写す（呼び元が `event.workerLimit` の有無で呼ぶ）。 */
  async markWorkerLimitStopped(
    record: ManagerRecord,
    managerId: string,
    workerLimit: NonNullable<NoteEvent['workerLimit']>,
  ): Promise<void> {
    const mark = {
      preRotationKey: workerLimit.preRotationKey,
      turnStartedAt: record.job.turnStartedAt,
    };
    this.#workerLimitStopped.set(managerId, mark);
    // 台帳にも写す: デーモンが再起動しても印が残るように
    record.job.workerLimitStopped = { ...mark };
    await this.#persist(record);
  }

  /** `note` の段2: note を日誌へ残す（stall の有無で行の種類を分ける）。 */
  async journalNote(event: NoteEvent, noteText: string): Promise<void> {
    // 受信箱へは出さず日誌にだけ残す（マネージャーの発言ではない）。`escalate` の有無で変えない（下で足すだけ）。
    // `event.stall` の欄で判定し、本文の文字列で嗅がない。旧 runner の note は `stall` を知らず `exchange` に落ちる。
    if (event.stall === undefined) {
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_REPLY_PREFIX}[${event.managerId}] ${noteText}`,
      );
    } else {
      await this.#journal({
        type: 'subagent_stall',
        agentId: event.stall.agentId,
        ...(event.stall.agentType === undefined ? {} : { agentType: event.stall.agentType }),
        ownedTaskCount: event.stall.ownedTaskCount,
        sessionTaskCount: event.stall.sessionTaskCount,
        wakeupCount: event.stall.wakeupCount,
        outcome: event.stall.outcome,
        text: `[${event.managerId}] ${event.text}`,
      });
    }
  }

  /** `note` の段3（同期）: `escalate` / `notifyClone` の欄に応じてクローンへの知らせを積む。 */
  emitNoteNotices(event: NoteEvent, noteText: string): void {
    // 欄（`event.escalate`）で判定し、本文を嗅がない。
    if (event.escalate === true) {
      this.#emit(
        event.managerId,
        'report',
        `[${event.managerId}] 作業者が自分で起こした背景処理を残したまま畳もうとする回が、` +
          '背景処理の完了を待つ上限（30分）に達して打ち切った。**この作業者は自動では再開しない**（委譲がここで止まっている）。\n' +
          `詳細（何が残っているか・何回目だったか）: ${event.text}\n` +
          '全件は日誌に残っている（`journal_read` で辿れる）。',
      );
    }

    // 欄（`event.notifyClone`）で判定し、本文を嗅がない（#4685）: 成果が失われうる知らせは、日誌だけだとクローンが引かない限り見えないため
    if (event.notifyClone === true) {
      // 作業者の落ちには、積んだ時点の担当の鍵の世代を添えて「別の世代へ移って戻ったら畳んでよい」と印を付ける（#5048）。世代が分からなければ付けない
      const heldGeneration = this.#tokenIdentities.get(event.managerId)?.generation;
      this.#emit(
        event.managerId,
        'report',
        `[${event.managerId}] ${noteText}`,
        undefined,
        undefined,
        'full',
        false,
        undefined,
        event.workerLimit === undefined || heldGeneration === undefined
          ? undefined
          : { movedFromGeneration: heldGeneration },
      );
    }
  }
}
