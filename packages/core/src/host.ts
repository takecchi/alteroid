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

  /** 走行中のターンを止めて片付ける。 */
  stop(): Promise<void>;
}
