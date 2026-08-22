import type { ManagerPool } from './manager.js';
import type { ChatStreamEvent, InboxEvent } from './schema.js';

/**
 * デーモンから見たクローン。
 *
 * HTTP 層はこのインターフェースしか知らない。クローンの生きたインスタンスは
 * デーモン内に常に1本だけ存在する（architecture.md「脳は1インスタンス」）。
 */
export interface CloneHost {
  /** 受信箱へイベントを積む。起点が人間でもタイマーでも入口はここ1つ。 */
  post(event: InboxEvent): void;

  /**
   * ある会話に対するクローンの出力を購読する。
   * 戻り値を呼ぶと購読を解除する。
   */
  subscribe(conversationId: string, listener: (event: ChatStreamEvent) => void): () => void;

  /** 会話の終了。蒸留の契機（寿命モデル: 蒸留は生存条件）。 */
  endConversation(conversationId: string): Promise<void>;

  /** 承認待ちへの回答。止まっていたその仕事だけが再開する。 */
  answerApproval(approvalId: string, answer: string): Promise<void>;

  /**
   * 人間が開けた実行許可を、走行中のセッションへ流し込み直す。
   *
   * **台帳を書き換えた側が必ず呼ぶこと。** 呼ばないと、人間が許可を足しても
   * 次にセッションが開くまで（＝数時間後か数日後）効かない。取り消しも同じで、
   * 呼ばなければ**消したのに効き続ける**。
   */
  applyPermissions(): Promise<void>;

  /**
   * 委譲先の一覧と生ログ。HTTP 層はここから可観測性の下2層へ降りる。
   * 起こすのはクローンだけである（人間が直接マネージャーを起こす口は作らない）。
   */
  readonly managers: ManagerPool;

  /** 走行中のターンを止めて片付ける。 */
  stop(): Promise<void>;
}
