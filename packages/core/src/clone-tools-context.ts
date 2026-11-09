// `createCloneTools` の道具と、族のファイルが共通で受け取る `ToolContext`（型だけ。実行時の処理を持たない）。

import type { AttachmentLimits } from './attachment.js';
import type { RecentDenial } from './denial-shape.js';
import type { ManagerPool } from './manager.js';
import type { ProfileService } from './profile-service.js';
import type { ScheduleStatus } from './schedule.js';
import type { AttachmentRef, ChatStreamEvent } from './schema.js';
import type { CloneRuntimeFacts } from './self.js';
import type { Stores } from './store.js';
import type { AccountUsageState } from './usage-snapshot.js';
import type { JournalSlicedSearchOptions } from './journal-sliced-search.js';

/** いまのターンの返信に添える添付の口（`reply_attach`）。 */
export interface ReplyAttachments {
  /** このターンの返信にすでに添えた控え（個数・合計は新しい分と合わせて数える）。 */
  current(): readonly AttachmentRef[];
  /** 返信に添える。会話の SSE へ `attachments` を流し、返信の日誌の `exchange` に載せる。 */
  add(refs: readonly AttachmentRef[]): void;
}

export interface ToolContext {
  stores: Stores;
  /** `journal_read` の語の検索の窓・予算・時計（#5126）。試験が小さくするための口。省けば既定（1日・8秒）。 */
  journalSearch?: JournalSlicedSearchOptions;
  emit(event: ChatStreamEvent): void;
  flushReply?(): Promise<void>;
  // optional にしない: 渡し忘れが型検査を通り、承認が黙って会話に紐づかなくなるため
  conversationId: () => string | undefined;
  /**
   * いまのターンの仕事が属する会話。会話のあるターンでは `conversationId` と同じで、内部ターンでは
   * 委譲の起点（マネージャーからの一件なら、その委譲の `Job.conversationId`。clone.ts の実装は `Turn.conversationId ?? Turn.originConversationId`）。
   * `manager_start` の起点、`task_add` の起点、`ask_human` / `request_permission` が積む承認の会話に写す（`ask_human` だけは、人間のターンの会話の次に `managerId` の委譲の起点を挟む）。
   * 返信の宛先（`conversationId`）とは別である。
   */
  // optional にする: 無い器（テストの ToolContext）は従来どおり `conversationId` だけを見る。クローン本体は必ず渡す
  workConversationId?: () => string | undefined;
  recentDenials?: () => readonly RecentDenial[];
  /**
   * `manager_start` が委譲を起こした／`manager_send` が既存の委譲へ頼んだ（その委譲が結び付いた task の id = `Job.taskId`。結び付いていなければ `undefined`）。
   * いまのターンで頼んだ委譲の task を控え、その task をこのターンの返答で自動 done にしない判定に使う（#5469 P5。判定は `hasDelegationForTask`）。無い器（テスト・蒸留）は何もしない。
   */
  noteDelegationStarted?: (taskId: string | undefined) => void;
  /**
   * `manager_start` が `taskId` なしで呼ばれたときの既定の結び先の task の id（そのターンが読んだ人間の task が1件だけのとき。無ければ `undefined`）。
   * 決めるのは器（clone.ts）。結んだら `taskId` を明示したときと同じ扱いにする。無い器（テスト・蒸留）は結ばない。
   */
  defaultDelegationTaskId?: () => Promise<string | undefined>;
  /**
   * `ask_human` / `request_permission` が人間への問いを積んだ（その問いの会話 id。無ければ `undefined`）。
   * そのターンでは、その会話の task を自動 done にしない（人間の答え待ちになるため。#5469 P5）。無い器は何もしない。
   * 前のターンで出した未回答の問いは、器が閉じる直前に承認待ちの台帳（pendingOnly）から引くので、ここで控えるのは「このターンで出した問い」だけ（台帳に書けない回の保険を兼ねる）。
   */
  noteQuestionAsked?: (conversationId: string | undefined) => void;
  /**
   * いまのターンが答えている相手の task の id（読んだ人間の発言の id、回答のターンでは答えた承認が持つ task の id）。
   * `ask_human` / `request_permission` が承認待ちの行（`taskIds`）に写し、その承認への回答のターンの返答が閉じてよい task を絞るのに使う（#5469 P5）。無い器は何も写さない。
   */
  currentTaskIds?: () => readonly string[];
  /**
   * `task_say` が書いた先の task の id。そのターンの返答が宛てた task を、起点の会話全体でなく書いた先に絞るため控える（#5469 P5）。無い器は何もしない。
   */
  noteTaskSaid?: (taskId: string) => void;
  // 添付があるとき（`attachments`）だけ第3引数を渡す: 添付の無い従来の呼び出しの形を変えないため
  postToConversation?: (
    conversationId: string,
    text: string,
    attachments?: readonly AttachmentRef[],
  ) => void;
  // 無い器（テスト等）では `reply_attach` は断る: 返信に添える先が無いまま「添えた」と言わないため
  replyAttachments?: ReplyAttachments;
  managers?: ManagerPool;
  profile?: ProfileService;
  accountUsage?: () => AccountUsageState;
  /** 鍵ごとの枠の最後の観測（#6633。`GET /tokens` の `loads` と同じもの）。無い器では `token_list` は枠の行を出さない。 */
  tokenLoads?: () => readonly { tokenId: string; state: AccountUsageState }[];
  runtime?: () => CloneRuntimeFacts;
  runnerModels?: () => Promise<readonly string[]>;
  /** 接続中の runner が名乗った SDK の接続先とモデルの別名の行。 */
  runnerAnthropicRoutes?: () => Promise<readonly string[]>;
  // optional にも既定値にもしない: 省略時の既定は guardFullReplace を素通りさせるか、日誌の cause を偽るため
  // ターンごとに変わるので、ハンドラの中で呼ぶ
  memoryCause: () => 'distill' | 'clone';
  // 呼ぶたびに評価する: createCloneTools の呼び出し時に1回だけだと nextAt が固定されるため
  scheduler?: () => ScheduleStatus[];
  dropQueuedInboxEvents?: (ids: readonly string[]) => Promise<number>;
  queuedInMemory?: () => number | undefined;
  attachmentCopiesDir?: string;
  attachmentLimits?: AttachmentLimits;
}

/**
 * `createCloneTools` が構築時に検査・解決した値のうち、族のファイル（`clone-tools-<族>.ts`）へ渡すもの。
 * `memoryCause` / `conversationId` の `typeof` 検査と `workConversationId ?? conversationId` の解決は
 * `createCloneTools` に残る（族の関数は検査済みの値を受け取る）。いずれも関数のまま渡す（ハンドラの中で呼ぶ）。
 */
export interface CloneToolsShared {
  stores: Stores;
  memoryCause: ToolContext['memoryCause'];
  getConversationId: ToolContext['conversationId'];
  getWorkConversationId: () => string | undefined;
}
