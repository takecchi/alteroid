import { EXCHANGE_KIND_DECISION_PREFIX, EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import type { ManagerRecord, RunnerPluginLoadObservation } from './manager.js';
import { describeMcpStatusForJournal } from './mcp-status-journal.js';
import { describePluginLoadForJournal } from './plugin-load-journal.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * `Pool` が口として渡すもの。いずれも呼ぶたびに `Pool` の側で引く（時計は構築の後でも差し替わりうる）。
 * 関数の口は async の皮で包まずに渡す（`await` の数と順を変えないため）。
 */
interface ManagerSessionReceiverPorts {
  /** `Pool#nowIso` を束ねたもの（器の時計を直に読まない）。 */
  nowIso: () => string;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  /** `Pool#persist`。 */
  persist: (record: ManagerRecord) => Promise<void>;
  /** `Pool#noteRunnerSessionSince`（session・resume 系で共有。同期）。 */
  noteRunnerSessionSince: (record: ManagerRecord) => void;
  /** `Pool` の `#pluginLoad` へ書く（`Pool#pluginLoadOf` も読むので、欄は `Pool` に残す。同期）。 */
  rememberPluginLoad: (runnerId: string, observation: RunnerPluginLoadObservation) => void;
}

/**
 * 担当の出来事 `session` を受け取る側（`Pool#handleEvent` から切り出した。振る舞いは変えていない）。
 * 自前の欄は、日誌へ書いた plugin の読み込みの署名と、接続できていない MCP サーバの署名だけ。
 */
export class ManagerSessionReceiver {
  readonly #ports: ManagerSessionReceiverPorts;
  readonly #journalExchange: ManagerSessionReceiverPorts['journalExchange'];
  /**
   * 委譲ごとの、最後に日誌へ書いたプラグイン読み込みの要約の署名。同じ署名の `session` では書き直さない。
   * `Pool#retire()` で消さない: 畳んだ委譲を起こし直した `session` が同じ署名でも、日誌へ同じ行を重ねない。1件は署名の文字列1つ。
   */
  readonly #pluginLoadDigests = new Map<string, string>();
  /** `#pluginLoadDigests` と同じ形・同じ理由で、接続できていない MCP サーバの組の署名を持つ。全部つながったら消す（次の失敗は書き直す）。 */
  readonly #mcpStatusDigests = new Map<string, string>();

  constructor(ports: ManagerSessionReceiverPorts) {
    this.#ports = ports;
    this.#journalExchange = ports.journalExchange;
  }

  /** 担当の出来事 `session` の1件を処理する（`Pool#handleEvent` が振り分ける）。 */
  async handle(
    event: Extract<RunnerEvent, { type: 'session' }>,
    record: ManagerRecord,
    fromRunnerId: string,
  ): Promise<void> {
    // 欄が無い session（古い runner・init に `plugins` が無かったセッション）では上書きしない: 「見ていない」で前の観測を消さないため
    if (event.pluginLoad !== undefined) {
      this.#ports.rememberPluginLoad(fromRunnerId, {
        at: this.#ports.nowIso(),
        managerId: event.managerId,
        pluginLoad: event.pluginLoad,
      });
      const described = describePluginLoadForJournal(event.pluginLoad);
      if (this.#initFindingChanged(this.#pluginLoadDigests, event.managerId, described.digest)) {
        await this.#journalExchange(
          'inbound',
          `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] ${described.text}`,
        );
      }
    }
    // 外部 MCP サーバの接続の失敗は担当の道具が欠けることなので、plugin の読み込み結果と同じ経路（日誌→クローン）で知らせる。欄が無い session は上書きしない
    if (event.mcpServers !== undefined) {
      const described = describeMcpStatusForJournal(event.mcpServers);
      if (described === null) {
        this.#mcpStatusDigests.delete(event.managerId);
      } else if (
        this.#initFindingChanged(this.#mcpStatusDigests, event.managerId, described.digest)
      ) {
        await this.#journalExchange(
          'inbound',
          `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] ${described.text}`,
        );
      }
    }
    record.job.sessionId = event.sessionId;
    record.attached = true;
    this.#ports.noteRunnerSessionSince(record);
    await this.#ports.persist(record);
    return;
  }

  // 署名が前回と同じなら false（日誌に重ねない）。違えば覚えて true。接頭辞は呼び出し箇所に字面で置くため、書くのは呼び手（`Pool#journalExchange` の注を参照）。
  #initFindingChanged(digests: Map<string, string>, managerId: string, digest: string): boolean {
    if (digests.get(managerId) === digest) return false;
    digests.set(managerId, digest);
    return true;
  }
}
