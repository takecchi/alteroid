import { EXCHANGE_KIND_DECISION_PREFIX } from './exchange-kind.js';
import type { ManagerRecord } from './manager.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * `Pool` が口として渡すもの。いずれも呼ぶたびに `Pool` の側で引く（時計は構築の後でも差し替わりうる）。
 * 関数の口は async の皮で包まずに渡す（`await` の数と順を変えないため）。
 */
interface ManagerClosedFrontReceiverPorts {
  /** `Pool#nowIso` を束ねたもの（器の時計を直に読まない）。 */
  nowIso: () => string;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  /** `Pool#persist`（台帳へ書く）。 */
  persist: (record: ManagerRecord) => Promise<void>;
  /** `Pool#emit`（合成した知らせの窓を経由して受信箱へ積む。同期）。ここが渡すのは `report` だけ。 */
  emit: (managerId: string, kind: 'report', text: string) => void;
  /** `Pool#retire`（広く共有する像の片付け。中身は `Pool` に残し、ここは呼ぶだけ。同期）。 */
  retire: (managerId: string) => void;
}

/**
 * `closed` の前段のうち、状態を動かさずに像を畳む 2 本を受け取る側（`Pool#closeWithoutTransition` が振り分ける。
 * `Pool#handleEvent` から切り出した。振る舞いは変えていない）。
 * 自前の欄は持たない: 書くのは引数の `record`（`lateDoneNotifiedAt`）だけ。
 * 枝の選択（`lost` → 重複 `failed` → `selfFenced` の順）は `Pool#closeWithoutTransition` が持ち、ここへは移していない。
 */
export class ManagerClosedFrontReceiver {
  readonly #ports: ManagerClosedFrontReceiverPorts;
  readonly #journalExchange: ManagerClosedFrontReceiverPorts['journalExchange'];

  constructor(ports: ManagerClosedFrontReceiverPorts) {
    this.#ports = ports;
    this.#journalExchange = ports.journalExchange;
  }

  // `closed` の段2-1: `lost` 確定後に届いた `closed`。status は動かさず、`done` のときだけクローンへ1回知らせる。
  async closeAfterLost(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'closed' }>,
  ): Promise<void> {
    // `lost` 確定後に届いた `closed` で status を動かさない（`stopped` の後と同じ）: `#load()` が像を作り直し、下の代入が `lost` を `done` へ書き換えてしまう。
    // `done` のときだけクローンへ1回知らせる: `lost` は成果を誰も確かめていない状態で、成果が出ている可能性を人間に見せる必要がある。`failed` / `lost` は新しい材料が無いので日誌だけ。
    // 「1回だけ」は `Job.lateDoneNotifiedAt`（`closed` に冪等キーが無く、台帳なので再起動をまたぐ）で持ち、印を先に永続してから出す: 二重に出るより、落ちたとき日誌から辿れるほうを採る。
    // `selfFenced` の枝より前に置く（`lost` の委譲は引き取り直しの梯子に載せない）。
    const notifyDone = event.status === 'done' && record.job.lateDoneNotifiedAt === undefined;
    const notice = notifyDone
      ? [
          `この委譲 ${event.managerId} は \`lost\` と確定していたが、後から runner が \`closed\`（status=done）を届けた。`,
          '台帳の状態は `lost` のまま変えていない。',
          '**成果が出ている可能性がある** — `lost` は成果を誰も確かめていない状態なので、' +
            '成果が実際に出ているか（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。' +
            '確かめるまで「終わった」とも「終わっていない」とも言わない。',
          `closed の reason: ${event.reason}`,
        ].join('\n')
      : undefined;
    await this.#journalExchange(
      'inbound',
      `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] （lost 確定済みのため status は動かさない）` +
        `runner 側の終了イベント（status=${event.status}）を受け取った: ${event.reason}` +
        (notice !== undefined
          ? `。done なのでクローンへ知らせる: ${notice}`
          : event.status === 'done'
            ? '。done は既に知らせてあるので重ねて知らせない'
            : '。受信箱へは出さない'),
    );
    if (notice !== undefined) {
      record.job.lateDoneNotifiedAt = this.#ports.nowIso();
      await this.#ports.persist(record);
      this.#ports.emit(event.managerId, 'report', notice);
    }
    this.#ports.retire(event.managerId);
  }

  // `closed` の段2-2: `failed` 確定済みへ再度届いた `closed(failed)`（SSE の再送）。日誌にだけ残して像を外す。
  async closeDuplicateFailed(event: Extract<RunnerEvent, { type: 'closed' }>): Promise<void> {
    // `failed` 確定済みへ同じ `closed(failed)` が再度届いても日誌にだけ残す: SSE の再接続の配り直しで、日誌の失敗行・`closed_failed` の知らせ（合流窓で「×2」）・`noteManagerFailed`（器の失敗が二重に加算され器が余計に沈む）が重なる。`closed` に冪等キーは足さない（runner とのやり取りの形が変わる）ので、デーモンの中だけで直す。
    // resume が飛んでいる最中は重複と読まない: `send()` は resume の後で `running` を書くので台帳はまだ `failed` で、その窓の `closed(failed)` は開き直した新しいセッションがすぐ落ちた知らせでありうる。`done` / `lost` はここで扱わない。
    await this.#journalExchange(
      'inbound',
      `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] （failed 確定済みのため status は動かさず、` +
        `知らせも器の失敗の計上も重ねない）runner 側の終了イベント（status=failed）を受け取った: ` +
        event.reason,
    );
    this.#ports.retire(event.managerId);
  }
}
