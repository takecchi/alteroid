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
   * **器から消した合図の配達を止める**（issue #1049）。戻り値は実際に配達待ち
   * から落とせた件数。⛔ **器（`stores.inbox`）から行を消すのはこの口ではない**
   * —— 消した呼び手が、同じ id でこれを呼ぶ。
   *
   * ## なぜこの面が太るのか
   *
   * ここに並んでいる他の口は**積む・読む・止める**であって、**待ち行列から
   * 特定の合図を抜く**口は無かった。`inbox_remove_many`（`POST /inbox/remove`）
   * が消すのは `InboxStore` の行だけで、**配達はクローンのメモリ上の待ち行列
   * から出る** ⟹ 消した後も配られ続けた。この面に口が無いことが、そのまま
   * #1049 の穴だった（`tools.ts` からは型の上で到達する経路が1つも無く、
   * `app.ts` は `clone` に届くのに呼べる操作が無かった）。
   *
   * **⚠️ 直に呼ばないこと。** 呼び手は `removeInboxEventsAndStopDelivery`
   * （`inbox-backlog.ts`）1本に寄せてある —— 器から消す操作とこの呼びが離れると、
   * **片方だけ直っている形**が戻る。詳細は `Clone#dropQueuedInboxEvents` の doc。
   */
  dropQueuedInboxEvents(ids: readonly string[]): Promise<number>;

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
   * クローンがいま枠（利用上限）で止まっているか（Issue #783）。
   *
   * **デーモンの回し手が「合図を配るか畳むか」を決めるための読み取り専用の窓。**
   * 「認証トークンが通る状態に戻った」という合図は、クローンが枠で止まっていない
   * 限りターンを1本焼くだけで何もしない（`clone.ts` の `post()` の中の
   * `if (this.#usageBlocked !== null) this.#releaseRequested = true;` が
   * 唯一の効果であり、止まっていなければそこは1文字も動かない）。⟹
   * `apps/daemon/src/index.ts` の `wake()` はここを見て、止まっていないときは
   * 配らずに畳む。
   *
   * **真偽だけを返す。** 保持している通知の中身（文言など）はデーモンの判断に
   * 要らない——渡すと、渡した先が文言を読んで判定を重ねる経路を作りかねない。
   */
  readonly usageBlocked: boolean;

  /**
   * 枠（利用上限）の解除を試す印が、**まだ使われずに立っているか**
   * （Issue #1051）。
   *
   * **{@link CloneHost.usageBlocked} と組で読む窓である。** あちらが答えるのは
   * 「止まっているか」で、ここが答えるのは「**もう起こしてある**か」。
   *
   * ## なぜ要るか —— 「止まっている」だけでは、同じ合図を何度でも配ってしまう
   *
   * 直上の doc のとおり、「認証トークンが通る状態に戻った」の合図の効果は
   * `clone.ts` の `post()` の中の
   * `if (this.#usageBlocked !== null) this.#releaseRequested = true;` の1文
   * **だけ**である。⟹ **その印が既に立っているなら、2件目の合図はもう立って
   * いる印をもう一度立てるだけで、状態を1文字も動かさない。**
   *
   * 実運用（Issue #1051）で起きたのはその形である —— 枠に当たっている間、
   * ある層が 429 を踏むと現役の記録にまた冷却が書かれ、別の層のターンが
   * 成功した瞬間にそれが消えて「戻った」が1件立つ。この往復はミリ秒間隔で
   * 回りうるので、**同一本文が 35 ミリ秒に3件・24時間で 3297 件**積まれた。
   * `usageBlocked` だけを見る門はその全部を通す（往復のあいだ、クローンは
   * ずっと止まっているからである）。
   *
   * ## 起こし損ねは作らない
   *
   * `#releaseRequested` は `#pump` の先頭で**必ず**消費される（`clone.ts` の
   * 解除ブロックの「どちらの道でも待ち行列は空でない」——印だけ立って誰も
   * 見ない、が起きない理由）。⟹ ここが真である窓は「次の再試行が始まるまで」
   * に限られ、**畳んだぶんは遅れではなく重複である。**
   *
   * **真偽だけを返す**（{@link CloneHost.usageBlocked} と同じ理由）。
   */
  readonly usageReleasePending: boolean;

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
