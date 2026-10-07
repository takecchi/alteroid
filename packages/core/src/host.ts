import type { ManagerPool } from './manager.js';
import type { ApprovalSelection, ChatStreamEvent, InboxEvent } from './schema.js';

// プレーンな TS の型で持つ: packages/core は apps/daemon の `Principal` を知らない（層が逆）ため
// ここ（host.ts）に置く: clone.ts が host.ts を import しており、逆向きだと循環になるため
export type AnswerApprovalVia =
  | { kind: 'operator'; auth: 'disabled' | 'operator-token' }
  | { kind: 'account'; accountId: string };

export type PostPersistOutcome = 'persisted' | 'unavailable';

export interface CloneHost {
  post(event: InboxEvent): void;

  // 受信箱のメモリにも積まない: 積むと、失敗を受けた呼び手の送り直しと二重に届くため
  postPersisted(event: InboxEvent): Promise<PostPersistOutcome>;

  // 直に呼ばず `removeInboxEventsAndStopDelivery` に寄せる: 器から消す操作とこの呼びが離れると、片方だけ直っている形が戻るため
  dropQueuedInboxEvents(ids: readonly string[]): Promise<number>;

  subscribe(conversationId: string, listener: (event: ChatStreamEvent) => void): () => void;

  attach?(
    conversationId: string,
    listener: (event: ChatStreamEvent) => void,
  ): { inProgress: ChatStreamEvent[] | null; unsubscribe: () => void };

  interruptTurn?(): Promise<'interrupted' | 'idle'>;

  // 実装していない器は「分からない」であって「止まっている」ではない: 呼び手は `idle` を作らない
  activeTurn?(): { conversationId?: string; kind: 'normal' | 'distill' } | null;

  endConversation(conversationId: string): Promise<void>;

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
