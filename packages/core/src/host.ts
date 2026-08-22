import type { ManagerPool } from './manager.js';
import type { PermissionService } from './permission-service.js';
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
   * 台帳にある実行許可を、走行中のセッションへ流し込み直す（**投影そのもの**）。
   *
   * **台帳を書き換える経路がここを直接呼ばないこと。** 書き換えは
   * {@link permissions} を通す — あちらは「台帳へ書く → 日誌へ残す → ここを呼ぶ」を
   * 直列の1区間として行う。ここだけを呼ぶ形にすると、人間の口とクローンの道具が
   * 別々に読んで別々に流し込み、**取り消したはずの規則が生き返る**
   * （`permission-service.ts` の冒頭の図）。
   *
   * ここが呼ばれないと、許可を足しても次にセッションが開くまで（＝数時間後か数日後）
   * 効かない。取り消しも同じで、呼ばなければ**消したのに効き続ける**。
   */
  applyPermissions(): Promise<void>;

  /**
   * 実行許可の台帳を読み書きする1本道（{@link PermissionService}）。
   *
   * **人間の口（`POST` / `DELETE /permissions`）とクローンの道具
   * （`permission_grant` / `permission_revoke`）は、同じこの1本を通る。**
   * 別々に書くと、片方だけが日誌へ残す・片方だけが流し込む、という食い違いが
   * 静かに生まれる（`profile-service.ts` と同じ理由）。
   */
  readonly permissions: PermissionService;

  /**
   * 委譲先の一覧と生ログ。HTTP 層はここから可観測性の下2層へ降りる。
   * 起こすのはクローンだけである（人間が直接マネージャーを起こす口は作らない）。
   */
  readonly managers: ManagerPool;

  /** 走行中のターンを止めて片付ける。 */
  stop(): Promise<void>;
}
