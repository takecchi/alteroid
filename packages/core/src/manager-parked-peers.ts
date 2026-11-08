import type { ManagerRecord } from './manager.js';
import { composePeerCloseNotice, type PeerCloseNotice } from './manager-notices.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * `Pool` が口として渡すもの。いずれも呼ぶたびに `Pool` の側で引く（時計は構築の後でも差し替わりうる）。
 * 関数の口は async の皮で包まずに渡す（`await` の数と順を変えないため）。
 */
interface ManagerParkedPeersReceiverPorts {
  /** `Pool#nowIso` を束ねたもの（器の時計を直に読まない）。 */
  nowIso: () => string;
  /** `Pool#emit`（合成した知らせの窓を経由して受信箱へ積む。同期）。ここが渡すのは `report` だけ。 */
  emit: (managerId: string, kind: 'report', text: string) => void;
  /** `Pool#persist`。 */
  persist: (record: ManagerRecord) => Promise<void>;
}

/**
 * 担当の出来事 `parked_peers_closed` を受け取る側（`Pool#handleEvent` から切り出した。振る舞いは変えていない）。
 * 自前の欄は持たない: 預けるのは引数の `record` の `job.pendingPeerCloseNotice`（読み手・下ろす側は `Pool` の起こし直しの組み立て）。
 */
export class ManagerParkedPeersReceiver {
  readonly #ports: ManagerParkedPeersReceiverPorts;

  constructor(ports: ManagerParkedPeersReceiverPorts) {
    this.#ports = ports;
  }

  /** 担当の出来事 `parked_peers_closed` の1件を処理する（`Pool#handleEvent` が振り分ける）。 */
  async handle(
    event: Extract<RunnerEvent, { type: 'parked_peers_closed' }>,
    record: ManagerRecord,
  ): Promise<void> {
    const notice: PeerCloseNotice = { reason: event.reason, peers: event.peers };
    const status = record.job.status;
    // 担当が起こされない（人が止めた・もう終端している）なら、クローンへの知らせだけにする。起こされるなら次の起こし直しの先頭へ添える（二重にしない）
    if (
      event.reason === 'stopped' ||
      status === 'stopped' ||
      status === 'failed' ||
      status === 'lost'
    ) {
      this.#ports.emit(
        event.managerId,
        'report',
        `[${event.managerId}] ${composePeerCloseNotice(notice)}`,
      );
      return;
    }
    const reason = event.reason;
    record.job.pendingPeerCloseNotice = {
      reason,
      // peer ごとに理由を持たせる: 理由の違う知らせを1つに混ぜると、理由と peer の対応がずれる（#4899）
      peers: [
        // 理由の欄が無い古い形の peer は、上書きされる前の知らせの理由を写してから積む
        ...(record.job.pendingPeerCloseNotice?.peers ?? []).map((peer) => ({
          ...peer,
          reason: peer.reason ?? record.job.pendingPeerCloseNotice?.reason ?? reason,
        })),
        ...event.peers.map((peer) => ({ ...peer, reason })),
      ],
      at: this.#ports.nowIso(),
    };
    await this.#ports.persist(record).catch(() => undefined);
    return;
  }
}
