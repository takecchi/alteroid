import { pruneStaleAttachmentDirs } from './runner-attachments.js';
import { pruneStaleOutboxRoots, type OutboxRemovalOptions } from './runner-outbox.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { ScratchSweeper } from './scratch-sweep.js';

/**
 * `Host` が口として渡すもの。11 本。
 * 値で渡すのは作った後に変わらない欄（`Host` では `readonly` の 4 つの root と `runnerId`）だけ。
 * `scratchAbort` は参照のまま渡す（`kickMcpConfigSweep` と `shutdown` が同じ `AbortController` を使うため。写すと `shutdown` の `abort()` がここへ届かない）。
 * `sweeper` も参照のまま渡す（使うのは `sweep` だけ）。
 * 関数の口は async の皮で包まずに渡す（すべて同期。`await` を足すと、同じ tick の中で ①添付 → ②出し箱 → ③`kickMcpConfigSweep` → ④scratch の掃き を呼ぶ順が動くため）。
 */
interface RunnerScratchTickPorts {
  /** `Host#attachmentsRoot`（`readonly`）。 */
  attachmentsRoot: string;
  /** `Host#outboxRoot`（`readonly`）。 */
  outboxRoot: string;
  /** `Host#outboxStagedRoot`（`readonly`）。 */
  outboxStagedRoot: string;
  /** `Host#rescueStagedRoot`（`readonly`）。 */
  rescueStagedRoot: string;
  /** 生きた委譲の id の一覧を、呼ぶたびに読み直す（`Host#sessions` のキー）。同期。 */
  sessionKeys: () => string[];
  /** `Host#outboxRemoval`（出し箱の root を子の権限で消す設定）。同期。 */
  outboxRemoval: () => OutboxRemovalOptions;
  /** `Host#kickMcpConfigSweep`（MCP 設定の残骸の掃きを始める）。同期。 */
  kickMcpConfigSweep: () => void;
  /** `ScratchSweeper` のインスタンス（使うのは `sweep` だけ）。参照。 */
  sweeper: Pick<ScratchSweeper, 'sweep'>;
  /** `Host#scratchAbort`（`kickMcpConfigSweep` と `shutdown` も使う）。参照。 */
  scratchAbort: AbortController;
  /** `Host#runnerId`（`readonly`）。 */
  runnerId: string;
  /** `Host#emit`。同期。 */
  emit: (event: RunnerEvent) => void;
}

/**
 * `Host` の scratch タイマーの 1 周期（添付の掃き → 出し箱の掃き → MCP 設定の掃き → scratch の掃き）を受け持つ側。
 * 切り出し前の `Host.constructor` のタイマーのコールバック本体から切り出した。振る舞いは変えていない。
 * 自前の欄は、重ならないためのガード 3 本（`#attachmentPruning`・`#outboxPruning`・`#scratchRunning`。このコールバックだけが使う）。
 * `tick` は同期・戻り値 void のまま保つ（`async` にしない。各掃きは `await` を待たずに同じ tick の中で呼ぶ）。
 */
export class RunnerScratchTick {
  #scratchRunning: Promise<void> | null = null;
  #attachmentPruning: Promise<void> | null = null;
  #outboxPruning: Promise<void> | null = null;
  readonly #attachmentsRoot: RunnerScratchTickPorts['attachmentsRoot'];
  readonly #outboxRoot: RunnerScratchTickPorts['outboxRoot'];
  readonly #outboxStagedRoot: RunnerScratchTickPorts['outboxStagedRoot'];
  readonly #rescueStagedRoot: RunnerScratchTickPorts['rescueStagedRoot'];
  readonly #sessionKeys: RunnerScratchTickPorts['sessionKeys'];
  readonly #outboxRemoval: RunnerScratchTickPorts['outboxRemoval'];
  readonly #kickMcpConfigSweep: RunnerScratchTickPorts['kickMcpConfigSweep'];
  readonly #sweeper: RunnerScratchTickPorts['sweeper'];
  readonly #scratchAbort: RunnerScratchTickPorts['scratchAbort'];
  readonly #runnerId: RunnerScratchTickPorts['runnerId'];
  readonly #emit: RunnerScratchTickPorts['emit'];

  constructor(ports: RunnerScratchTickPorts) {
    this.#attachmentsRoot = ports.attachmentsRoot;
    this.#outboxRoot = ports.outboxRoot;
    this.#outboxStagedRoot = ports.outboxStagedRoot;
    this.#rescueStagedRoot = ports.rescueStagedRoot;
    this.#sessionKeys = ports.sessionKeys;
    this.#outboxRemoval = ports.outboxRemoval;
    this.#kickMcpConfigSweep = ports.kickMcpConfigSweep;
    this.#sweeper = ports.sweeper;
    this.#scratchAbort = ports.scratchAbort;
    this.#runnerId = ports.runnerId;
    this.#emit = ports.emit;
  }

  tick(): void {
    if (this.#attachmentPruning === null) {
      const prune = pruneStaleAttachmentDirs(this.#attachmentsRoot, this.#sessionKeys(), Date.now())
        .catch(() => 0)
        .then(() => undefined)
        .finally(() => {
          this.#attachmentPruning = null;
        });
      this.#attachmentPruning = prune;
    }
    // 出し箱と退避先の取りこぼしも、添付と同じ周期・同じ基準（生きた委譲に当たらず24時間触れていない）で消す
    // `#attachmentPruning` の鎖に乗せない: 添付の掃除が長引いても出し箱の掃除を止めないため（失敗は握る）
    // 出し箱の root は子の権限で消す（担い手が書ける木を runner の権限で再帰削除しない）
    // 非同期（#4906）: 同一プロセスの runner では、走査と削除の同期 I/O がデーモンのメインのループを止める。重ならないよう1本ずつ走らせる
    if (this.#outboxPruning === null) {
      this.#outboxPruning = pruneStaleOutboxRoots(
        {
          outboxRoot: this.#outboxRoot,
          stagedRoot: this.#outboxStagedRoot,
          rescueStagedRoot: this.#rescueStagedRoot,
        },
        this.#sessionKeys,
        Date.now(),
        this.#outboxRemoval(),
      )
        .catch(() => undefined)
        .finally(() => {
          this.#outboxPruning = null;
        });
    }
    // scratch の掃きの鎖に乗せない: あちらは git の判定で長引きうるが、資格入りのファイルを長く残さないため
    this.#kickMcpConfigSweep();
    if (this.#scratchRunning !== null || this.#scratchAbort.signal.aborted) return;
    const run = this.#sweeper
      .sweep(this.#scratchAbort.signal, this.#runnerId)
      .then((event) => {
        if (event !== null && !this.#scratchAbort.signal.aborted) this.#emit(event);
      })
      .catch(() => {})
      .finally(() => {
        this.#scratchRunning = null;
      });
    this.#scratchRunning = run;
  }
}
