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
   * 委譲先の一覧と生ログ。HTTP 層はここから可観測性の下2層へ降りる。
   * 起こすのはクローンだけである（人間が直接マネージャーを起こす口は作らない）。
   */
  readonly managers: ManagerPool;

  /**
   * 認証トークンを回したので、**次のターンの境界で** SDK セッションを畳んで
   * 作り直す（Issue #393 PR4）。
   *
   * **`stop()` とは別物である。** あちらはクローン全体の停止で、こちらは
   * 子プロセスだけの入れ替えである（会話は `resume` で続く）。**混ぜると
   * 「トークンを回したらクローンが止まる」になる。**
   *
   * 呼ぶのは回し手（デーモンの1本）だけで、**回ったときにだけ**呼ぶ。
   */
  recycleSessionForToken(): void;

  /** 走行中のターンを止めて片付ける。 */
  stop(): Promise<void>;
}
