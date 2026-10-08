import type { ManagerPool } from './manager.js';
import type { ApprovalSelection, ChatStreamEvent, InboxEvent } from './schema.js';

// プレーンな TS の型で持つ: packages/core は apps/daemon の `Principal` を知らない（層が逆）ため
// ここ（host.ts）に置く: clone.ts が host.ts を import しており、逆向きだと循環になるため
export type AnswerApprovalVia =
  | { kind: 'operator'; auth: 'disabled' | 'operator-token' }
  | { kind: 'account'; accountId: string };

/** `interruptTurn` が止める対象の発言（`POST /chat` の `clientMessageId` で指す）。 */
export interface InterruptTarget {
  readonly conversationId: string;
  readonly clientMessageId: string;
}

/** `reopenSession` へ渡すもの。 */
export interface ReopenSessionOptions {
  /** 開き直す理由（人間が書いた1文。日誌とクローンへの断りに載る）。 */
  readonly reason: string;
  /** 開き直す前の生ログの末尾を記憶へ蒸留するか。既定は呼び手が決める（HTTP では `false`）。 */
  readonly distill: boolean;
  /** 操作した主体の人間向けの名乗り（`describeActor`）。 */
  readonly actor: string;
}

/**
 * `reopenSession` の結果。
 *
 * - `outcome: 'now'`: セッションが無かった。次に開くセッションから resume しない
 * - `outcome: 'deferred'`: 印を立てた。走っているターンは最後まで走り、その境界で開き直す
 * - `previousSessionId`: 呼ぶ前のセッション id（分からなければ `null`）
 * - `runningManagers`: いま走っているマネージャーの数（取れなかったときは欄ごと無い。0 とは別）
 */
export interface ReopenSessionResult {
  readonly outcome: 'now' | 'deferred';
  readonly previousSessionId: string | null;
  readonly runningManagers?: number;
}

/**
 * `sessionRefusal` の窓（#4173 PR-3）。
 *
 * - `streak`: 答えを返せないまま拒否で終わったターンの連続数
 * - `category`: 付いていた分類（'cyber' 等。無ければ `null`）
 * - `since`: 連続の最初に弾かれた時刻（ISO 8601）。連続が 0（止めだけ立っている）なら `null`
 * - `sessionId`: 最後に弾かれたセッションの id（分からなければ `null`）
 * - `autoReopen`: 自動の開き直しの状態。`enabled`（有効）/ `disabled`（設定で外してある）/ `halted`（自動で開き直したセッションが答えないまま弾かれて止めた）
 */
export interface SessionRefusalWindow {
  readonly streak: number;
  readonly category: string | null;
  readonly since: string | null;
  readonly sessionId: string | null;
  readonly autoReopen: 'enabled' | 'disabled' | 'halted';
}

/** `reopenSession` へ渡すもの。 */
export interface ReopenSessionOptions {
  /** 開き直す理由（人間が書いた1文。日誌とクローンへの断りに載る）。 */
  readonly reason: string;
  /** 開き直す前の生ログの末尾を記憶へ蒸留するか。既定は呼び手が決める（HTTP では `false`）。 */
  readonly distill: boolean;
  /** 操作した主体の人間向けの名乗り（`describeActor`）。 */
  readonly actor: string;
}

/**
 * `reopenSession` の結果。
 *
 * - `outcome: 'now'`: セッションが無かった。次に開くセッションから resume しない
 * - `outcome: 'deferred'`: 印を立てた。走っているターンは最後まで走り、その境界で開き直す
 * - `previousSessionId`: 呼ぶ前のセッション id（分からなければ `null`）
 * - `runningManagers`: いま走っているマネージャーの数（取れなかったときは欄ごと無い。0 とは別）
 */
export interface ReopenSessionResult {
  readonly outcome: 'now' | 'deferred';
  readonly previousSessionId: string | null;
  readonly runningManagers?: number;
}

/**
 * `interruptTurn` の結果。
 *
 * - `interrupted`: その発言のターン（対象を省いたときは走っているターン）を止めた
 * - `withdrawn`: 発言がまだ順番待ちだったので取り下げた（器からも外し、配らない）
 * - `not_target`: 走っているのは別の起点のターンなので、止めていない
 * - `starting`: 発言は取り出し済みだがターンはまだ始まっておらず、止めるものが無かった（もう一度呼べば止まる）
 * - `idle`: 止めるものが無かった（既に答え終わっている）
 */
export type InterruptOutcome = 'interrupted' | 'withdrawn' | 'not_target' | 'starting' | 'idle';

/**
 * 会話の中で、いま答えを待っている発言の状態（{@link PendingMessage}）。
 *
 * - `running`: ターンが走っている
 * - `starting`: 受信箱から取り出し済みで、ターンはまだ始まっていない
 * - `queued`: 受信箱で順番待ち
 * - `held`: 利用上限の枠で保持している
 */
export type PendingMessageState = 'running' | 'queued' | 'held' | 'starting';

/** `attach` が返す、いま答えを待っている発言（`POST /chat` の `clientMessageId` で指す）。 */
export interface PendingMessage {
  readonly clientMessageId: string;
  readonly state: PendingMessageState;
}

/** {@link CloneHost.postPersisted} の結果。 */
export type PostPersistOutcome = 'persisted' | 'unavailable';

export interface CloneHost {
  post(event: InboxEvent): void;

  // 受信箱のメモリにも積まない: 積むと、失敗を受けた呼び手の送り直しと二重に届くため
  postPersisted(event: InboxEvent): Promise<PostPersistOutcome>;

  // 直に呼ばず `removeInboxEventsAndStopDelivery` に寄せる: 器から消す操作とこの呼びが離れると、片方だけ直っている形が戻るため
  dropQueuedInboxEvents(ids: readonly string[]): Promise<number>;

  subscribe(conversationId: string, listener: (event: ChatStreamEvent) => void): () => void;

  /**
   * **いままでの分を受け取り、続きを購読する**（Issue #2652。`Clone#attach` の doc）。
   * `inProgress` は進行中のターンの途中経過（隣り合う `text` は1つ）。進行中でなければ
   * `null`。`pending` はその会話でいま答えを待っている発言（`clientMessageId` を持つものだけ。
   * 取り出し済み→保持→順番待ちの順）。写しを取ることと購読を張ることは同じ同期区間で行われ、
   * 継ぎ目で取りこぼしも二重渡しも起きない。
   *
   * **省略可能にしてある** —— この面を実装する偽物（テスト）が多く、足していない
   * 実装では HTTP の口が 503 で「この器では途中経過を持たない」と答える。
   */
  attach?(
    conversationId: string,
    listener: (event: ChatStreamEvent) => void,
  ): {
    inProgress: ChatStreamEvent[] | null;
    pending: PendingMessage[];
    unsubscribe: () => void;
  };

  /**
   * **いま走っているクローンのターンを止める**（#1398 c23-1）。止めるものが
   * 無ければ `'idle'`。`target` を渡したときは、その発言のターンだけを止め、順番待ちなら
   * 取り下げる（`Clone#interruptTurn` の doc）。
   *
   * **省略可能にしてある** —— この面を実装する偽物（テスト）が多く、足していない
   * 実装では HTTP の口が「この器では止められない」と答える。
   */
  interruptTurn?(target?: InterruptTarget): Promise<InterruptOutcome>;

  /**
   * **人間の操作で、クローンのセッションを resume せずに開き直す**（#4173）。
   * `Clone#reopenSession` の doc を見よ（生ログは消さない・走っているターンは最後まで走る・
   * マネージャーは止めない）。
   *
   * **省略可能にしてある**（`interruptTurn?` と同じ形）——持たない実装では HTTP の口が
   * `unsupported` と答える。
   */
  reopenSession?(options: ReopenSessionOptions): Promise<ReopenSessionResult>;

  /**
   * **クローンのセッションが安全分類器（safeguards）に弾かれ続けている状況**（#4173 PR-3。
   * `GET /status` の `cloneSessionRefusal`）。連続数が 0 で、自動の開き直しの止めも立っていなければ
   * `null`（欄を出さない）。
   *
   * **省略可能にしてある**（`activeTurn?` と同じ形）——実装していない器は「分からない」で、「弾かれていない」ではない。
   */
  sessionRefusal?(): SessionRefusalWindow | null;

  // 実装していない器は「分からない」であって「止まっている」ではない: 呼び手は `idle` を作らない
  activeTurn?(): { conversationId?: string; kind: 'normal' | 'distill' } | null;

  endConversation(conversationId: string): Promise<void>;

  // 削除した会話（#4218）をメモリから落とす。省略可能にする: 実装していない器では、削除の結果が「進行中の購読と途中経過を落とせなかった」と言う（黙って落としたことにしない）
  forgetConversation?(conversationId: string): void;

  answerApproval(
    approvalId: string,
    answer: string,
    via?: AnswerApprovalVia,
    selections?: readonly ApprovalSelection[],
  ): Promise<void>;

  readonly managers: ManagerPool;

  // 真偽だけを返す: 通知の中身を渡すと、渡した先が文言を読んで判定を重ねる経路を作りかねないため
  readonly usageBlocked: boolean;

  readonly usageReleasePending: boolean;

  readonly usageBlockedResetsAt: number | undefined;

  // 推測で埋めない: 「同じ鍵ではない」と「鍵が分からない」を混同しないため
  readonly usageBlockedTokenId: string | undefined;

  // `stop()` と混ぜない: 混ぜると「トークンを回したらクローンが止まる」になるため
  recycleSessionForToken(): void;

  stop(options?: { farewellDeadlineAt?: number }): Promise<void>;
}
