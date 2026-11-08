import { EXCHANGE_KIND_RECOVERY_PREFIX } from './exchange-kind.js';
import { releaseLease } from './lease.js';
import type { ManagerRecord } from './manager.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * `Pool` が口として渡すもの。いずれも呼ぶたびに `Pool` の側で引く（時計は構築の後でも差し替わりうる）。
 * 関数の口は async の皮で包まずに渡す（`await` の数と順を変えないため）。
 */
interface ManagerSelfFencedReceiverPorts {
  /** `Pool#now` を束ねたもの（`releaseLease` へ渡す時刻。器の時計を直に読まない）。 */
  now: () => number;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  /** `Pool#persist`（台帳へ書く）。 */
  persist: (record: ManagerRecord) => Promise<void>;
  /** `Pool#emit`（合成した知らせの窓を経由して受信箱へ積む。同期）。ここが渡すのは `report` だけ。 */
  emit: (managerId: string, kind: 'report', text: string) => void;
  /** `Pool#withdrawWaiting`（待っている確認を取り下げて日誌へ残す。広く共有する。同期）。 */
  withdrawWaiting: (record: ManagerRecord, reason: string) => void;
  /** `Pool#scheduleReattach`（引き取りの挑み直しの予約。タイマーと間隔は `Pool` が持つ。同期）。 */
  scheduleReattach: (runnerId: string) => void;
}

/**
 * `closed` の前段のうち、自己失効（`selfFenced`）の 1 本を受け取る側（`Pool#closeWithoutTransition` が振り分ける。
 * `Pool#handleEvent` から切り出した。振る舞いは変えていない）。
 * 自前の欄は持たない: 書くのは引数の `record`（`waiting`・`attached`・`job.lease`）だけ。
 * 像は外さない（`Pool#retire` の口は持たない）。枝の選択（`lost` → 重複 `failed` → `selfFenced` の順）は `Pool#closeWithoutTransition` が持ち、ここへは移していない。
 */
export class ManagerSelfFencedReceiver {
  readonly #ports: ManagerSelfFencedReceiverPorts;
  readonly #journalExchange: ManagerSelfFencedReceiverPorts['journalExchange'];

  constructor(ports: ManagerSelfFencedReceiverPorts) {
    this.#ports = ports;
    this.#journalExchange = ports.journalExchange;
  }

  // `closed` の段2-3: 自己失効の `closed`。状態は動かさず貸し出しだけ返し、引き取りを挑み直す。
  async closeSelfFenced(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'closed' }>,
  ): Promise<void> {
    // 自己失効は「終わった」ではない: `lost` をそのまま書くと `#restoreJobs` も `#reattach` も引き取らず、二重実行を止めた代わりに誰も拾わない仕事ができる。状態は動かさず貸し出しだけ返して梯子へ載せる。
    // 判定は構造化された印だけで行う: `reason` の文字列一致だと、マネージャーが同じ文を書いた回まで巻き込む（`sdk-failure.ts` と同じ理由）。
    this.#ports.withdrawWaiting(record, '器が貸し出し期限で自分で畳んだ');
    record.attached = false;
    // 返すのは印を立てることで消すことではない: 世代（`fence`）を残す。
    if (record.job.lease !== undefined) {
      record.job.lease = releaseLease(record.job.lease, this.#ports.now());
    }
    await this.#ports.persist(record);
    await this.#journalExchange(
      'inbound',
      `${EXCHANGE_KIND_RECOVERY_PREFIX}[${event.managerId}] 器が貸し出し期限で自分で畳んだ（自己失効）。` +
        `台帳の状態（${record.job.status}）は動かさず、別の器で続きを起こし直す: ${event.reason}`,
    );
    // クローンへも知らせる: 黙って止まったように見えるのが一番まずい。末尾の `event.reason` は包まない: 既に完成した1つの prose 文（runner の定型文）で、この層に包む材料が無い。包むなら `runner.ts` 側。
    this.#ports.emit(
      event.managerId,
      'report',
      `器がデーモンと連絡を失い、貸し出し期限で自分で畳みました（自己失効）。` +
        `この委譲は終わっていません — 引き取りを自動で挑み直します: ${event.reason}`,
    );
    // 像から外さない（終わっていない）。
    if (record.job.runnerId !== undefined) this.#ports.scheduleReattach(record.job.runnerId);
  }
}
