import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import type {
  AccountUsageState,
  ApplyCredentialsResult,
  ApplyMcpServersResult,
  ApplyPluginsResult,
  ApplyProfileResult,
  PluginDistributionService,
  PluginFetcher,
  EnvProfileEntry,
  ArchiveEntry,
  ChatStreamEvent,
  CloneHost,
  CredentialService,
  CodexChatgptAuthService,
  McpServerService,
  McpServers,
  StoredMcpServers,
  Exchange,
  GrantResult,
  JobStatus,
  JournalEntry,
  JournalEntryInput,
  JournalEntryType,
  ManagerPool,
  ManagerSummary,
  OwnerOutcome,
  Practice,
  ProfileService,
  RunnerClient,
  RunnerRegistry,
  Scheduler,
  Stores,
  TokenPoolService,
} from '@alteroid/core';
import {
  CommitmentConflictError,
  MemoryConflictError,
  memoryVersion,
  PracticeConflictError,
  practiceVersion,
  ScheduleConflictError,
  ARCHIVE_REMOVED_BYTES_UNIT_NOTE,
  JOURNAL_SEARCH_UNCOVERED_LIST_MD,
  MCP_SERVER_NAME,
  composedFingerprints,
  composeProfileScript,
  createPluginPreviewStore,
  isValidPluginName,
  mcpServerNames,
  normalizePluginDescription,
  parsePluginInput,
  PluginFetchError,
  PluginNameConflictError,
  summarizeFetchedPlugin,
  PROFILE_ENTRY_NAME,
  mcpServersFingerprintOf,
  McpServersConflictError,
  mcpServersVersionOf,
  RESERVED_SCHEDULE_KINDS,
  isReservedEventSource,
  ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
  ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
  ARCHIVE_REMOVE_MANY_LIMIT_MAX,
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  classifyTokenPolicyChange,
  classifyTokenPoolChange,
  CredentialEntryRejectedError,
  JournalAnchorNotFoundError,
  ProfileInputError,
  ProfileRollbackFailedError,
  redactProfileFailure,
  TokenPoolInputError,
  UnreadableAccountError,
  UnreadableCommitmentError,
  UnreadableJournalEntryError,
  UnreadablePermissionGrantError,
  UnreadablePracticeError,
  UnreadableScheduleError,
  approvalUpdatedAt,
  chatStreamEventSchema,
  countUnread,
  countUnreadConversations,
  effectiveReadThrough,
  loadConversationReadView,
  commitmentActiveDelegationIds,
  commitmentPosition,
  commitmentRespondedAt,
  commitmentUpdatedAt,
  describeUnreadableCommitment,
  describeUnreadableScheduleEdit,
  compareApprovalPagingKey,
  compareCommitmentPosition,
  computeSupersededIds,
  conversationMessages,
  createAuthProviderRegistry,
  createAuthService,
  reachedStart,
  droppedTraceLedgerSince,
  findUnrecordedManagers,
  isOffsetQualifiedTimeBoundary,
  describeUnreadableJournalTimeBoundary,
  describeOffsetRequiredTimeBoundary,
  guardArchiveRemoval,
  INBOX_EVENT_TYPE_ORDER,
  isAccountGranted,
  isDailyReport,
  jobStatusSchema,
  journalEntrySchema,
  journalWindowCrossesHorizon,
  localDayRange,
  matchesInboxRemoveManyFilter,
  normalizeJournalTimeBoundary,
  removeInboxEventsAndStopDelivery,
  summarizeInboxBacklog,
  memorySlugSchema,
  practiceKindSchema,
  practiceSlugSchema,
  fingerprintOf,
  noteDroppedRecord,
  reasonOf,
  redactErrorText,
  managerModelsOf,
  readConversationPage,
  readConversationWindow,
  readWithdrawnClientMessageIds,
  lookupConversation,
  describeMissingConversation,
  deleteConversation,
  isConversationDeleted,
  decodeConversationCursor,
  encodeConversationCursor,
  InvalidConversationCursorError,
  type ConversationCursor,
  clientMessageIdSchema,
  RECENT_TRACE_LIMIT,
  recentDroppedTraces,
  chunkIdsByChars,
  REMOVE_MANY_JOURNAL_ID_CHARS,
  REMOVE_MANY_LIMIT_DEFAULT,
  REMOVE_MANY_LIMIT_MAX,
  reportRunnerRevision,
  describeResetTargets,
  describeUnreadableManagerRow,
  resetWorkspaceState,
  resolveBuildRevision,
  RunnerHttpError,
  runnerSetCredentialsCommandSchema,
  scheduleKindSchema,
  SCHEDULE_EVERY_MINUTES_MAX_MESSAGE,
  scheduleSpecSchema,
  selectArchiveRemovalTargets,
  startSseHeartbeat,
  readProgress,
  buildCommitmentDerivations,
  readUnreadableJobsForCommitments,
  DEFAULT_PROGRESS_WINDOW_HOURS,
  approvalSelectionSchema,
  describeSelectionsViolation,
  InvalidProgressWindowError,
  PROGRESS_WINDOW_HOURS_INVALID_MESSAGE,
  summarizeUsage,
  tokenRotationSettingsSchema,
  toRowsUnreadable,
  traceApproval,
  UnreadableApprovalError,
  usageDate,
  usageDateSchema,
  usageLayerSchema,
  usageSiteSchema,
  integrationKeyFingerprint,
  integrationKeyLimits,
  issueIntegrationKeyValue,
  looksLikeIntegrationKey,
  resolveIntegrationKey,
  sha256Hex,
  type AnswerApprovalVia,
  type ApprovalPagingKey,
  type IntegrationKeyRecord,
  type ArchiveRemoveManyFilter,
  type AuthAccount,
  type AuthService,
  NulNotAllowedError,
  InvalidCredentialNameError,
  type TokenPolicyChange,
  type TokenPoolChange,
  type InboxRemoveManyFilter,
  type RemoveUnreadableRowsOptions,
  type RemoveUnreadableRowsResult,
} from '@alteroid/core';
import {
  AttachmentCursorError,
  AttachmentRejectedError,
  hasNul,
  isAttachmentBound,
  nonBlankString,
  readAttachmentLimits,
  removeAttachmentCopy,
  stripNul,
  type AttachmentLimits,
} from '@alteroid/core';

import { bearerOf, isOperator, type AuthPlan, type AuthVariables, type Principal } from './auth.js';
import { clientMessageFingerprint } from './client-message-fingerprint.js';
import { checkAndBindAttachments, type AttachmentBatchResult } from './attachment-batch.js';
import { createFixedWindowRateLimiter, judgeIntegrationRoute } from './integration-gate.js';
import type { JournalBus } from './journal-bus.js';
import { Scalar } from '@scalar/hono-api-reference';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { streamSSE } from 'hono/streaming';
import { describeRoute, openAPIRouteHandler, resolver, validator } from 'hono-openapi';
import { z } from 'zod';

import {
  cloneInterruptRequestSchema,
  cloneInterruptResponseSchema,
  cloneSessionReopenRequestSchema,
  cloneSessionReopenResponseSchema,
  accessAccountResponseSchema,
  accessListResponseSchema,
  approvalsAnswerResponseSchema,
  approvalByIdResponseSchema,
  approvalsAnsweredDatesResponseSchema,
  approvalsResponseSchema,
  approvalTraceResponseSchema,
  archiveListResponseSchema,
  archiveRemoveManyRequestSchema,
  archiveRemoveManyResponseSchema,
  archiveRemovedResponseSchema,
  archiveRemoveResponseSchema,
  archiveSessionsResponseSchema,
  attachmentErrorResponseSchema,
  attachmentKeptBodySchema,
  attachmentLimitsSchema,
  attachmentListQuery,
  attachmentListResponseSchema,
  attachmentMetaSchema,
  authProvidersResponseSchema,
  commitmentConflictResponseSchema,
  commitmentListResponseSchema,
  progressResponseSchema,
  commitmentOpenedResponseSchema,
  conversationDetailResponseSchema,
  conversationReadRequestSchema,
  conversationReadResponseSchema,
  conversationsResponseSchema,
  conversationDeleteResponseSchema,
  unreadConversationCountResponseSchema,
  credentialsResponseSchema,
  codexAuthStatusResponseSchema,
  codexLoginResponseSchema,
  codexLogoutResponseSchema,
  credentialsUpdateRequestSchema,
  credentialsUpdateResponseSchema,
  droppedResponseSchema,
  errorResponseSchema,
  integrationKeyCreateErrorResponseSchema,
  integrationKeyCreateRequestSchema,
  integrationKeyCreateResponseSchema,
  integrationKeyResponseSchema,
  integrationKeysListResponseSchema,
  JOURNAL_WRITE_FAILED_CODE,
  JOURNAL_WRITE_FAILED_MESSAGE,
  journalWriteFailedResponseSchema,
  eventAcceptedResponseSchema,
  githubObservationRequestSchema,
  healthResponseSchema,
  statusResponseSchema,
  inboxBacklogResponseSchema,
  inboxRemoveManyRequestSchema,
  inboxRemoveManyResponseSchema,
  journalListResponseSchema,
  loginClaimResponseSchema,
  loginStartResponseSchema,
  clientMessageLookupResponseSchema,
  managerActionResponseSchema,
  managerDetailResponseSchema,
  managersListResponseSchema,
  memoryDeleteResponseSchema,
  memoryListResponseSchema,
  memoryConflictResponseSchema,
  memoryReadResponseSchema,
  meResponseSchema,
  okResponseSchema,
  openApiDocumentation,
  openApiExcludePaths,
  permissionGrantsResponseSchema,
  practiceDeleteResponseSchema,
  practiceListResponseSchema,
  practiceConflictResponseSchema,
  practiceReadResponseSchema,
  practiceVersionListResponseSchema,
  practiceVersionReadResponseSchema,
  mcpServersConflictResponseSchema,
  mcpServersResponseSchema,
  mcpServersUpdateRequestSchema,
  mcpServersUpdateResponseSchema,
  pluginInstallRequestSchema,
  pluginInstallResponseSchema,
  pluginPreviewRequestSchema,
  pluginPreviewResponseSchema,
  pluginRemoveResponseSchema,
  pluginsListResponseSchema,
  profileEntryUpdateRequestSchema,
  profileErrorResponseSchema,
  profileResponseSchema,
  profileUpdateRequestSchema,
  profileUpdateResponseSchema,
  reportsResponseSchema,
  resetRequestSchema,
  resetResponseSchema,
  runnersCredentialsResponseSchema,
  runnersListResponseSchema,
  runnersVacateCommandSchema,
  runnersVacateResponseSchema,
  scheduleConflictResponseSchema,
  scheduleListResponseSchema,
  tokensPolicyUpdateRequestSchema,
  tokensReplaceResponseSchema,
  tokensResponseSchema,
  tokensUnreadableRemoveRequestSchema,
  tokensUnreadableRemoveResponseSchema,
  tokensUpdateRequestSchema,
  topologyResponseSchema,
  unreadableRowsRemoveRequestSchema,
  unreadableRowsRemoveResponseSchema,
  usageResponseSchema,
} from './openapi.js';
import { InvalidCursorError, decodeCursor, encodeCursor } from './cursor.js';
import { answeredDates, approvalSettledDate, approvalsSettledOn } from './approvals-answered.js';
import { createTopologyActivityTracker, type WorkerToolBus } from './topology-activity.js';
import {
  createStorageHealthTracker,
  createTopologyService,
  describeProbeError,
  topologySignature,
} from './topology.js';
import {
  compareDailyReportsNewestFirst,
  listDailyReports,
  listDailyReportsBefore,
} from './reports.js';

/**
 * HTTP API（hono）。CLI も外部アプリもここを叩く。
 *
 * 入口は CLI・HTTP API・Web UI（apps/web）の3つで、**どれも等しくこの API の
 * 上に乗る**。CLI は core を埋め込まずこの API の薄いクライアントに徹する —
 * でないと chat のたびに脳が分岐する（docs/architecture.md「脳は1インスタンス」）。
 * Web UI も同じ理由で、独自の経路をここへ足さない（足したら入口ごとに
 * できることが変わる）。
 *
 * 可観測性の3層（日報・日誌・セッションログ）はすべてここから読める必要がある
 * （PRD「可観測性」）。M3 で最上段の日報が揃い、3層が全部この API から読める。
 *
 * ここには**外部イベントの入口**もある（`POST /events`）。仕事の起点を人間に
 * 限らないための口であり、開いている先は 127.0.0.1 だけである。外から叩かせるなら、
 * 手前に境界（リバースプロキシ・トンネル・認証）を置くのが正しい — 能力側で
 * 絞るのではなく実行環境の境界で守る（north_star 禁止2）。
 *
 * **仕様は `GET /openapi.json`（OpenAPI 3.1）で外から読める。** 人間向けの画面は
 * `GET /docs`（Scalar）。経路の入出力は zod スキーマ（`hono-openapi` の
 * `describeRoute` / `validator`）から機械生成する — 手書きの spec を別に持つと、
 * 経路を直したのに spec だけ古いままという事故が起きる（Issue #20 の設計上の注意）。
 * 応答スキーマは `./openapi.ts` にまとめてある（ここに全部書くと配線が読めなくなる）。
 */
export interface AppDeps {
  clone: CloneHost;
  stores: Stores;
  /**
   * 起動ごとの本人確認用トークン。CLI は PID ではなくこれで
   * 「いま応答しているのが自分が起こしたデーモンか」を確かめる。
   */
  token: string;
  /** `daemon stop` の受け口。 */
  shutdown: () => void;
  /**
   * 「いま」を返す時計。`GET /usage` の `today`（デーモンの暦の今日）を作る。
   * 省略すれば実時間（`new Date()`）。テストが時計を注入するための口で、
   * 本番は渡さない（Issue #2268）。
   */
  now?: () => Date;
  /**
   * 添付の上限（Issue #3111）。省略すれば `readAttachmentLimits()`（環境変数。ストアが読むものと同じ）。
   * `POST /attachments` の本文の上限（1つぶんの最大値）と、`POST /chat` の個数・合計の検査に使う。
   */
  attachmentLimits?: AttachmentLimits;
  /** 時間起点のジョブ。テストの HTTP 層検証では省略できる。 */
  scheduler?: Scheduler;
  /**
   * 記憶がどこにあるか（ローカルのパス / PostgreSQL）。
   * CLI がこれを見せるので、人間が器を取り違えない。接続情報は含めない。
   */
  storage?: string;
  /**
   * 委譲先の名簿。**マネージャーの道具の鍵を、器を作り直さずに回すための口**が
   * ここから生える（`GET /runners` / `POST /runners/credentials`）。
   *
   * デーモンが鍵を保管するのではない。降ろすだけである — 保管すると、記憶の器に
   * GitHub の書き込み権が並ぶ（railway/README.md「daemon 側には置かない」）。
   */
  runners?: RunnerRegistry;
  /**
   * クローン層のモデルの表記（`self.models.clone`）。無ければ地図に欄を載せない（＝不明）。
   */
  cloneModel?: string;
  /**
   * 日誌の追記を購読する口（`GET /journal/stream`）。
   *
   * 無ければその経路だけが 503 を返す。**能力を落とすのではなく、配線されて
   * いないことを黙って隠さない**ため（テストの HTTP 層検証では省略できる）。
   */
  journalEvents?: Pick<JournalBus, 'subscribe'>;
  /**
   * 作業者の道具の実行中の合図（`tool_running` / `tool_end`。Issue #2725）の購読口。
   * 稼働の地図の tracker へつなぐ。**日誌は通らない**（プールが `WorkerToolBus` へ流す）。
   * 無ければ地図に実行中の道具は載らない（今までどおり）。
   */
  workerToolEvents?: Pick<WorkerToolBus, 'subscribe'>;
  /**
   * アカウント全体の利用状況（claude.ai 側の値）を読む口。
   *
   * 無ければ `GET /usage` の `account` が `{ state: 'unknown' }` を返す。
   * **能力を落とすのではなく、配線されていないことを黙って隠さない**ため
   * （0 を返すと「枠を使っていない」と読める）。
   */
  accountUsage?: () => AccountUsageState;
  /**
   * ブラウザから叩いてよいオリジンの**明示列挙**（`ALTEROID_ALLOWED_ORIGINS`）。
   *
   * 空（既定）なら CORS ヘッダを一切返さない。**そこが今までの姿勢であり、
   * 既定では1バイトも変わらない。**
   *
   * 画面（apps/web）とデーモンを別オリジンに置く配置があるので必要になった。
   * ここで守っているものは3つある。
   *
   * 1. **ワイルドカードを受け付けない。** 列挙されたオリジンだけを、そのまま
   *    エコーする。`*` を許すと `deliberateClient` の前提（preflight が通らない）
   *    が消え、人間が開いた任意のページからクローンのターンを起こせる
   * 2. **`credentials` を付けない。** Cookie を運ばせない設計なので、
   *    `Access-Control-Allow-Credentials` は返さない（資格情報はヘッダで運ぶ）
   * 3. **`allowHeaders` は最小。** `content-type` を通すのは `deliberateClient` が
   *    それを要求するためで、増やすなら理由が要る
   *
   * これは能力の削除ではなく**実行環境の境界の設定**である（north_star 禁止2）。
   * 開けるかどうかは人間が決め、開けた先は列挙した相手だけに限られる。
   */
  allowedOrigins?: readonly string[];
  /**
   * ログインとアクセス許可（`./auth.ts`）。
   *
   * 省略すると認証を要求しない（＝この機能が入る前と同じ振る舞い）。**能力を
   * 削らないための既定**であって、設定していない人の `alteroid chat` が突然
   * 通らなくなる方が北極星に反する（境界の導入が実質のデグレードになっていないか、
   * という問い）。
   */
  auth?: { plan: AuthPlan; service?: AuthService };
  /**
   * 実行環境プロファイルを置いて配るまでの1本道。
   *
   * **クローンの道具（`profile_write`）と同じインスタンスを渡すこと。** 別々だと
   * 直列化の意味が消え、同時更新で層ごとに違う本文が残る。
   */
  profile?: ProfileService;
  /**
   * マネージャーへ降ろす環境変数（名前→値）を置いて配るまでの1本道。
   *
   * **マネージャーのプール（再接続時の降ろし直し）と同じインスタンスを渡すこと。**
   * `profile` と同じ理由——別々だと直列化の意味が消え、同時更新で層ごとに違う値が
   * 残る。
   */
  credentials?: CredentialService;
  /**
   * 人間の MCP 連携の登録を置いて runner へ配る1本道（#325 段3）。
   *
   * **マネージャーのプール（名乗りのたびの降ろし直し）と同じインスタンスを渡すこと**
   * （`profile` と同じ理由）。渡さなければ `PUT /mcp-servers` は保存だけして
   * runner へは配らない（`runners: []`）—— 配らなかったことは応答から分かる。
   */
  mcpServers?: McpServerService;
  /**
   * plugin を取り元から取る口（`POST /plugins/preview`）。渡さなければ preview は 503。
   * 取得はネットワークと git に触れるので、テストは差し替える。
   */
  pluginFetcher?: PluginFetcher;
  /**
   * 保存した plugin を runner へ配る1本道。**マネージャーのプールと同じインスタンスを渡すこと**
   * （`mcpServers` と同じ理由）。渡さなければ保存だけして配らない（`runners: []`）。
   */
  pluginDistribution?: PluginDistributionService;
  /** プレビューの預かりの期限を測る時計（テスト用）。 */
  pluginPreviewNow?: () => number;
  /**
   * Codex の ChatGPT ログインの正本の持ち主（#3939）。**マネージャーのプールと同じインスタンスを
   * 渡すこと**（`mcpServers` と同じ理由）。無ければ `/codex/*` は 503。
   */
  codexAuth?: CodexChatgptAuthService;
  /**
   * 認証トークンのプール（Issue #393「PR1 プールの器」）。**回さない**——ここが
   * 生やすのは器の読み書きの口だけで、検知・切替は無い。
   *
   * **人間の口（`PUT /tokens`）とクローンの道具（まだ無い。Issue #456）は同じインスタンスを
   * 渡すこと。** `profile` と同じ理由——別々だと直列化の意味が消える。
   */
  tokens?: TokenPoolService;
  /**
   * SSE のコメント行 heartbeat の間隔（ms）。省略時は `DEFAULT_SSE_HEARTBEAT_MS`
   * （`@alteroid/core` の `sse-heartbeat.ts`）。**環境変数は増やさない** —— テストで短くする以外に
   * 差し替える理由が無い設定なので、実行環境プロファイルの対象にもしない。
   */
  sseHeartbeatMs?: number;
  /**
   * 記憶の器が応えるかを確かめる口（稼働の地図 `GET /topology` の `storage.state`）。
   * 拒否・失敗で reject する。**応答は結果の保持（`createStorageHealthTracker`）が
   * 約15秒に1回・3秒の打ち切りで呼ぶだけで、毎リクエストでは叩かない。**
   *
   * **無ければ `storage.state` は `unknown`**（確かめる手段が無いことを、`ok` に
   * 化けさせない）。接続情報は応答へ載せない（失敗の理由も種別だけ）。
   */
  storageProbe?: () => Promise<void>;
  /**
   * `GET /topology/stream` の周期の再計算の間隔（ms。既定 2000）。**環境変数は増やさない**
   * （`sseHeartbeatMs` と同じ。テストで短くする以外に差し替える理由が無い）。
   */
  topologyTickMs?: number;
  /** 日誌の追記を受けてからの再計算の待ち（ms。既定 200。続けて来た追記をまとめる）。 */
  topologyDebounceMs?: number;
  /**
   * SDK のセッション生ログを消す口（`apps/daemon/src/storage.ts` の
   * `Storage.clearSessionLog` の doc）。**pg 構成でだけ付く。**
   *
   * `POST /reset` がこれを `resetWorkspaceState`（`@alteroid/core`）へ橋渡し
   * する。省略すればその分の申告（`WorkspaceResetSummary.sessionLog`）が
   * 単に出ないだけで、fs 構成・テストの HTTP 層検証のどちらでも安全に省略できる。
   */
  clearSessionLog?: () => Promise<number>;
  /**
   * `attachment_fetch` の写しの置き場（`state/attachment-copies`。core の `attachmentCopiesDir(ALTEROID_HOME)`）。
   * `DELETE /attachments/:id` がその id の写しを、`POST /reset` が置き場ごと消す（#4006）。**省略すれば写しは消さない**
   * （写しは写しで、無くなっても本体から取り出し直せる。テストの HTTP 層検証では省略できる）。
   */
  attachmentCopiesDir?: string;
}

/**
 * `ALTEROID_ALLOWED_ORIGINS` を読む。
 *
 * 受け付けるのは `scheme://host[:port]` だけである。**`*` と、経路を含む値と、
 * 解釈できない値は捨てる**（捨てたことは呼び出し側が警告に出す）。ここを緩めると
 * 「許可したつもりの範囲」と「実際に通る範囲」がずれ、境界が境界でなくなる。
 */
export function parseAllowedOrigins(raw: string | undefined): {
  origins: string[];
  rejected: string[];
} {
  const origins: string[] = [];
  const rejected: string[] = [];

  for (const entry of (raw ?? '').split(',')) {
    const candidate = entry.trim();
    if (candidate === '') continue;

    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      rejected.push(candidate);
      continue;
    }

    // `new URL('https://a.example.com/path').origin` は経路を落とすので、
    // 元の文字列がオリジンそのものだったときだけ通す（打ち間違いを飲み込まない）。
    const normalized = url.origin;
    if (normalized === 'null' || candidate.replace(/\/+$/, '') !== normalized) {
      rejected.push(candidate);
      continue;
    }
    if (!origins.includes(normalized)) origins.push(normalized);
  }

  return { origins, rejected };
}

/** 孤立サロゲートを含まないか（`String.prototype.isWellFormed`、ES2024）。tsconfig の `lib` が ES2023 なので最小の型だけ足す。 */
function isWellFormedString(value: string): boolean {
  return (value as string & { isWellFormed(): boolean }).isWellFormed();
}

/**
 * `supersedes`: 送信済みの人間の発言を編集するチャットの口
 * （issue「チャットの送信済みメッセージを編集する」）。
 *
 * **形だけをここで固定する。** 「その id が本当に編集できる対象か」（窓の中に
 * 在るか・この会話のものか・人間の発言か・既に別の編集に置き換えられていないか）
 * の判定は、このスキーマの外——ハンドラの手書き検証（`GET /journal` の
 * `afterId`/`afterAt` と同じ作法）が持つ。`min(1)` だけを課すのは、空文字列を
 * 「編集」として受け付けると `conversationId` に空文字を許すのと同じ穴になるため。
 */
const chatBody = z
  .object({
    text: z.string(),
    /**
     * 会話の id。**孤立サロゲート（JSON の `"\ud83d"` など）を含むものは 400 で断る（#3560）。** 添付の
     * 結び付け先になる id で、pg の添付の `conversation_id`（text 列）は孤立サロゲートを U+FFFD へ書き換えて
     * 残す——同じ添付の再 bind が conflict になり、別々の id が同じ値に潰れて取り違えうる。黙って正規化すると
     * 呼び手が渡した id と違うものを扱うことになるので、入口で断る。エラーには値を混ぜない（`path` だけ）。
     * **NUL を含むものも 400 で断る（#3631）。** 添付つきは `bind` の `assertNoNul` が 400 に変換されず 500 に
     * なり、添付なしは pg の日誌が NUL を落として残し、別々の id が 1 つに潰れうる（`nul-guard.ts`:
     * 鍵は入口で断る）。
     */
    conversationId: z
      .string()
      .min(1)
      .refine(isWellFormedString, { message: '孤立サロゲートを含む' })
      .refine((id) => !hasNul(id), { message: 'NUL を含む' })
      .optional(),
    supersedes: z.string().min(1).optional(),
    /**
     * 発言に結び付ける添付の id（`POST /attachments` が返した id。Issue #3111）。形だけをここで見る。
     * 個数・合計・存在・別の会話への結び付きの検査は、ハンドラが持つ（上限は環境変数で変わるので、
     * spec に固定の `maxItems` を書かない）。
     */
    attachments: z.array(z.string().min(1)).optional(),
    /**
     * クライアントが発言ごとに作る一意な id（Issue #3203）。形は `clientMessageIdSchema`（英数字・`_` `-` の
     * 1〜128字。UUID も通る）。受信箱の `human_message` と日誌の inbound `exchange` へ残り、`open` と
     * `GET /conversations/:id` の `messages` で返る。**同じ値が再び届いたら二重に受けない**（ハンドラが持つ）。
     */
    clientMessageId: clientMessageIdSchema.optional(),
  })
  /**
   * **本文は空でもよいが、添付が1件以上あるときだけ**（添付だけの発言。Issue #3111）。
   * 添付の無い空本文は従来どおり 400。`min(1)` を外した代わりの条件をここに置く。
   *
   * **「空」は NUL を落とした後で見る**（#3437）。ストアは本文の NUL を落として残すので、落とす前の長さで
   * 見ると NUL だけの `text` が空の発言として日誌へ入る。
   */
  .refine((body) => stripNul(body.text).length > 0 || (body.attachments?.length ?? 0) > 0, {
    message: 'text が空のときは attachments が要る',
    path: ['text'],
  });

/**
 * 添付のアップロードのクエリ（`POST /attachments`）。本文は生のバイト列なので、名前と MIME はここで運ぶ。
 * `type` は MIME の形（`type/subtype`）だけを見る。マジックバイトの照合は `AttachmentStore.put` が持つ。
 */
const attachmentUploadQuery = z.object({
  /** `keep=1` で、預けた時点で保存の印を付ける（期限なし。連携の鍵は付けられない。#4126 P4）。 */
  keep: z
    .enum(['1', 'true', '0', 'false'])
    .transform((value) => value === '1' || value === 'true')
    .optional(),
  name: z.string().optional(),
  type: z.string().regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(\s*;.*)?$/, 'MIME の形ではない'),
});

/**
 * 添付の中身を返すときの `content-type` に使ってよい形。宣言された MIME は人間が決めた文字列なので、
 * ヘッダに入れて壊れない形でなければ `application/octet-stream` に倒す。
 */
const SAFE_MEDIA_TYPE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;

/**
 * `content-disposition: attachment` の値。ファイル名は RFC 5987（`filename*=UTF-8''…`）で符号化し、
 * 古いクライアント向けに ASCII だけの `filename` を並べる。
 */
function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * 添付を上げた主体の識別子（`AttachmentMeta.uploadedBy`）。持ち主（operator）は `operator`、
 * アカウントは `account:<id>`、連携の鍵は `integration:<keyId>`。トークンや資格そのものは入れない。
 * クローンが `file_put` で入れたものは `clone`（HTTP の口からは付かない。`ATTACHMENT_UPLOADED_BY_CLONE`）。
 */
function uploaderOf(principal: Principal): string {
  if (principal.kind === 'operator') return 'operator';
  if (principal.kind === 'integration') return `integration:${principal.keyId}`;
  return `account:${principal.account.id}`;
}

/**
 * `POST /attachments` の門番。**本文の content-type は `application/octet-stream` だけを受ける。**
 *
 * `deliberateClient` と同じ考え方である：`application/octet-stream` は CORS の単純リクエストの
 * content-type（`text/plain` / `multipart/form-data` / `application/x-www-form-urlencoded`）に入らないので、
 * ブラウザは必ず preflight を通す。CORS ヘッダを返さない（または列挙したオリジンだけに返す）この
 * デーモンでは、人間が開いた任意のページが `no-cors` の fetch や HTML form で添付を預けられない。
 * 本文に `multipart` を受けない理由も同じ（form から飛ばせてしまう）。
 */
const octetStreamClient = createMiddleware(async (c, next) => {
  if (mimeEssence(c.req.header('content-type')) !== 'application/octet-stream') {
    return c.json({ error: 'content-type: application/octet-stream が要る' as const }, 415);
  }
  await next();
});

/**
 * `ifMatch`（任意、Issue #2743）は、書き換える側が**読んだ時の版**（GET の `version`）。
 * 書く瞬間の版と違えば書かずに 409。`null` は「読んだ時には無かった」。
 * **省略は従来どおり後勝ち**——既存の呼び出し（`memory set`、スクリプト）を壊さない。
 */
const memoryBody = z.object({ content: z.string(), ifMatch: z.string().nullable().optional() });
/**
 * `DELETE /memory/:slug` のクエリ（Issue #2881）。`ifMatch` は消す側が**読んだ時の版**
 * （GET の `version`）。いまの版と違えば消さずに 409。**省略は 428 で断る**（段階3。
 * 形の検査では必須にせず、ハンドラで 404 の後に断る——スラッグ不正 400・無い 404 を先に返すため）。
 * 削除は「無い」ものを消す意味が無いので、PUT と違って `null` は受けない。
 */
const memoryDeleteQuery = z.object({ ifMatch: z.string().min(1).optional() });
/**
 * `DELETE /practices/:slug` のクエリ（Issue #2959。`memoryDeleteQuery` と同じ形）。`ifMatch` は
 * 消す側が**読んだ時の版**（GET の `version`）。いまの版と違えば消さずに 409。**省略は 428 で断る**
 * （段階2。形の検査では必須にせず、ハンドラで 404 の後に断る——スラッグ不正 400・無い 404 を先に返すため。
 * **読めない形で入っている行だけは版なしで消せる**）。
 */
const practiceDeleteQuery = z.object({ ifMatch: z.string().min(1).optional() });
/**
 * `PracticeStore.write` の入力そのまま（`slug` だけは経路から取る）。
 *
 * **`kind` に列挙を課さない。** `practiceKindSchema` は `z.string().min(1).max(128)`
 * であって enum ではない——ここで別の制約を足すと、道具（`tools.ts` の
 * `practice_write`）と HTTP とで書ける種類が食い違う（`practiceKindSchema` の doc
 * 「⛔ ここを z.enum にしないこと」）。`title` も core 側に制約が無いので足さない。
 */
const practiceBody = z.object({
  kind: practiceKindSchema,
  title: z.string(),
  content: z.string(),
  /**
   * 任意（Issue #2853）。書き換える側が**読んだ時の版**（GET の `version`）。書く瞬間の版と
   * 違えば書かずに 409。`null` は「読んだ時には無かった」。**省略は従来どおり後勝ち**
   * （クローンの道具・CLI を壊さない）。`memoryBody.ifMatch` と同じ形。
   */
  ifMatch: z.string().nullable().optional(),
});
/**
 * 承認待ちへの回答の本体（`answer` と `selections` の少なくとも一方）。
 *
 * **`selections`（issue #2525）は `questions` を持つ承認待ちへの構造化した回答。** `answer` は
 * 自由文の回答、`selections` と併用するときは補足。どちらも無いのは 400
 * （`hasAnswerOrSelections`）。`selections` の中身を `questions` と突き合わせる検査は
 * 承認待ちの行が要るので、ここ（形の検査）ではなくハンドラで行う（`describeSelectionsViolation`）。
 */
const answerFields = {
  answer: z.string().min(1).optional(),
  selections: z.array(approvalSelectionSchema).min(1).optional(),
};
/**
 * **形の検査で弾く（ハンドラまで通さない）。** ブラウザの単純リクエスト（`text/plain` で JSON を
 * 送る CSRF）は本文が空として読まれ、以前は `answer` が必須だったためここで 400 になっていた。
 * 両方が任意になっても、空の本文が形の検査を通り抜けて 404 / 409 の判定まで進まないようにする。
 */
const hasAnswerOrSelections = (body: { answer?: unknown; selections?: unknown }) =>
  body.answer !== undefined || body.selections !== undefined;
/**
 * **`selections` を伴わない `answer` は、NUL を落として trim した後に1文字以上**（Issue #3384）。
 * 空白・全角空白・改行とタブ・NUL だけの回答は空の回答として記録されてしまう（NUL は承認の入口で
 * 落ちて空になる）。値は書き換えない（検査だけ。`nonBlankString` と同じ作法）。
 * `selections` と併用する `answer` は補足で、空白だけの補足は「補足なし」として
 * `describeSelectionsViolation` が扱う（issue #2582。「何も答えていない」の文で断る）ので、ここでは見ない。
 */
const answerIsNotBlank = (body: { answer?: string; selections?: unknown }) =>
  body.selections !== undefined ||
  body.answer === undefined ||
  stripNul(body.answer).trim().length > 0;
const answerBody = z
  .object(answerFields)
  .refine(hasAnswerOrSelections, { message: 'answer も selections も無い' })
  .refine(answerIsNotBlank, { message: 'answer が空白だけ', path: ['answer'] });
/** まとめて答える（溜まった保留を人間が一度に片付けるための口）。 */
const answersBody = z.object({
  answers: z
    .array(
      z
        .object({ id: z.string().min(1), ...answerFields })
        .refine(hasAnswerOrSelections, { message: 'answer も selections も無い' })
        .refine(answerIsNotBlank, { message: 'answer が空白だけ', path: ['answer'] }),
    )
    .min(1)
    .max(200),
});
const eventBody = z.object({
  /** 何から届いたか。クローンが判断の手がかりにする。 */
  source: z.string().min(1),
  payload: z.unknown().optional(),
  /**
   * この出来事に添える添付の id（`POST /attachments` が返した id。#3113 段3）。形だけをここで見る。
   * 個数・合計・存在・結び付き・上げた主体の検査はハンドラが持つ（`chatBody.attachments` と同じ作法）。
   */
  attachments: z.array(z.string().min(1)).optional(),
});
/**
 * `POST /events/:source` の添付（#3113 段3）。本文まるごとが payload なので、添付の id はクエリで運ぶ
 * （`?attachments=<id>&attachments=<id>`。1つなら文字列、複数なら配列で届く）。空の値は無いものとして扱う
 * （この欄が入る前から `?attachments=` を付けていた呼び手を壊さない）。
 */
const eventSourceQuery = z.object({
  attachments: z.union([z.string(), z.array(z.string())]).optional(),
});
/**
 * `beforeDate` / `beforeAt`（issue #432）。**可視の複合キーでページングする
 * ——不透明な `cursor` は使わない。**
 *
 * 応答（`reportsResponseSchema`）には既に `date` と `at` が載っている
 * （`journalVariant('daily_report')` そのままの枝。`apps/daemon/src/openapi.ts`）
 * ので、呼ぶ側は前の頁の最後の日報の `date`/`at` を読んで次の要求を自分で
 * 組み立てられる——**応答に新しい欄を1つも足さなくてよい。**
 *
 * **封筒（`total` / `nextCursor`）を持たない。** 続きが在るかは
 * 「`limit` 件ちょうど返ったか」で呼ぶ側が判る。この形の先例は同じファイルの
 * `journalQuery` の `since`（`grep -Fn -- 'ここより古いエントリまで遡って読むための足がかり' apps/daemon/src/app.ts`）
 * ——あちらも応答に打ち切りの印を持たず、窓の境界を呼ぶ側が渡す形である。
 *
 * **`order` は足さない。** `/reports` は常に日付の新しい順
 * （`compareDailyReportsNewestFirst`）。
 */
const reportsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(365).default(7),
  beforeDate: z.string().optional(),
  beforeAt: z.string().optional(),
});
/**
 * `order` / `afterId` / `afterAt`（issue #432 の2本目）。**可視の複合キーで
 * ページングする——不透明な `cursor` は使わない。**
 *
 * 応答（`journalListResponseSchema`）には既に `id` と `at` が載っている
 * ——日誌エントリそのものである（`journalEntrySchema` の共通枝）——ので、
 * 呼ぶ側は前の頁の最後の行の `id`/`at` を読んで次の要求を自分で組み立てられる
 * ——**応答に新しい欄を1つも足さなくてよい。** `total` / `nextCursor` も
 * 持たない——続きが在るかは `limit` 件ちょうど返ったかで呼ぶ側が判る。
 *
 * **`GET /reports` は `beforeDate` / `beforeAt` なのに、ここは `afterId` /
 * `afterAt`——揃え忘れではない。**
 *
 * `GET /reports` には `order` が無く、常に日付の新しい順である ⟹ 「次の頁」
 * は必ず古い側なので、`before` はどんな呼びでも literally 正しい。
 *
 * `GET /journal` には `order` が在って両向きに動く ⟹ `before` は
 * `order=asc` のとき嘘になる。だから方向に縛られない語を使う——**`after` は
 * 「返る順序における次」の意味で使っている（時間の意味ではない）。
 * `order=desc`（既定）では、`after` が指す先は *より古い* 行である。**
 *
 * `afterId` と `afterAt` は必ず組で渡す（片方だけは 400。理由は `/reports`
 * の `beforeDate`/`beforeAt` と同じ形——`afterAt` 単独では同じミリ秒の
 * 同着を割れず、`afterId` 単独では fs 実装が `at` からファイルを決める
 * 都合上、同じ `id` でも実装によって答えが変わりうる。
 * `JournalStore.list` の `after` の doc、`journal-order-with-contract.ts`
 * を見よ）。
 */
const journalQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  /**
   * ISO 8601。ここより古いエントリまで遡って読むための足がかり。
   *
   * **形はここでは縛らない（`z.string()` のまま）。** 読めるかどうかの検査と
   * `toISOString()` への正規化はハンドラの中で行う（`afterAt` の検査と同じ
   * 形——`normalizeJournalTimeBoundary` の doc、issue #1515）。ここで
   * `z.string().datetime()` 等を課さないのは、`Date.parse` が読める形
   * （秒の省略・オフセット付きなど）をそのまま受けたいからである。
   */
  since: z.string().optional(),
  /**
   * ISO 8601。窓の終端。
   *
   * **`since` だけでは過去の一区間を取れない。** 新しい順に返すので、手前に
   * 積まれた最新のものが `limit` を食い尽くし、狙った時刻には届かない。
   *
   * 形の検査・正規化は `since` と同じ（すぐ上の doc）。
   */
  until: z.string().optional(),
  /** カンマ区切りの日誌エントリ種別。 */
  type: z.string().optional(),
  /**
   * 本文を語で探す（issue #250）。**大文字小文字を区別しない部分一致**
   * ——意味論は `JournalQuery.q` が持つ（クローンの `journal_read` の `q` と
   * 同じ1つの実装を通る。**画面のために別の口を足さない**）。
   *
   * **`q=`（空文字列）は絞らない。** 検索欄を空にした呼びが 0 件を返すと、
   * 呼ぶ側は「消えた」と読む（`matchesJournalSearch` の doc）。だから
   * `.min(1)` を掛けない——空文字列はそのままストアへ渡して「絞らない」に
   * 倒す。**渡さないのと同じ結果になる**ので、呼ぶ側は空のときに
   * パラメタを外す判断をしなくてよい。
   */
  q: z.string().optional(),
  /**
   * 返す順序。既定 `'desc'`（新しい順＝従来の挙動）。**この既定値がある
   * ことで、クエリを1つも渡さない既定の呼びも `order:'desc'` をストアへ
   * 渡すことになるが、それは従来の挙動そのものであり応答は1バイトも
   * 変わらない。**
   */
  order: z.enum(['asc', 'desc']).default('desc'),
  /**
   * ページングの足がかり（`afterAt` と組で渡す）。**「次」は返る順序の
   * 意味——`order=desc`（既定）なら錨より古い側、`order=asc` なら錨より
   * 新しい側が返る。時間の意味ではない。**
   */
  afterId: z.string().optional(),
  /** ISO 8601。`afterId` と組で渡す（上の注意を見よ）。 */
  afterAt: z.string().optional(),
  /**
   * 「絞らずに地平だけ欲しい」（issue #1530）。**`z.coerce.boolean()` を
   * 使わない**——`conversationQuery.includeSuperseded` と同じ理由
   * （`?horizon=false` が true になってしまう）。`.enum(['true', 'false'])`
   * に揃える。
   *
   * `since`/`until` を指定した呼びは、指定しているという事実だけで
   * `oldestAt`/`crossesHorizon` が付く（この欄が無くても付く）。この欄が
   * 要るのは**その両方を省略した呼び**——Web の初期読み込みがそれで、
   * 日誌が1ページに収まるほど短いと「もっと遡る」を一度も撃たないまま
   * 終端に達し、地平の注記の材料がいつまでも届かない（issue #1530）。
   * `horizon=true` を渡せば、`since`/`until` が無くても
   * `oldestAt`/`crossesHorizon` を返す——判定は `journalWindowCrossesHorizon`
   * をそのまま使う（`since` が無ければ始点は `-∞`。関数の doc）。
   *
   * **既定は付けない（`.optional()`）。** 渡さない呼びの応答は1バイトも
   * 変えない——この欄の追加そのものが、その約束の上に成り立っている。
   */
  horizon: z.enum(['true', 'false']).optional(),
});
/**
 * `order` / `limit` / `cursor`（issue #432）。
 *
 * **`limit` に上限（`max`）を付けない。** この口は既定で全件を返すので、頁の
 * 大きさに上限を置いても何も守れない（`.claude/skills/listing-and-detail/SKILL.md`
 * が言う予算は「一覧をエージェントへ返す」口の話で、この HTTP の口は人間が
 * ブラウザで扱う前提——同スキルの「いま揃っていないもの」の `/commitments` /
 * `/usage` と同じ扱い）。
 *
 * **`cursor` の中身と検査は `apps/daemon/src/cursor.ts` を見ること。** ここでは
 * 「decode できる文字列か」までしか見ない。
 *
 * **`conversationId` は `pending` と同じ側（絞り込み）である。** opt-in の
 * 対象（`order`/`limit`/`cursor`）ではない——渡しても頁の封筒（`total`/
 * `nextCursor`）は増えない。渡した場合、`total` はこの絞り込みを当てた
 * *後*の件数になる（`pending` の絞り込みと同じ順序。issue #782 の2・3 —
 * チャット画面が「表示中の会話に上がった確認」だけを読むための口）。
 */
const approvalsQuery = z.object({
  pending: z.enum(['true', 'false']).default('true'),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().optional(),
  conversationId: z.string().optional(),
  /**
   * 「その日に決着した承認だけ」（`YYYY-MM-DD`。**opt-in**——渡さない呼びの応答は1バイトも
   * 変わらない）。**日は日報と同じ `localDate()`（デーモンの TZ）で決める**。決着の日時は
   * `answeredAt`、無ければ `withdrawnAt`（取り下げ済みも「決着した」件。外すと、従来 Web で
   * 見えていた取り下げ済みが見えなくなる）で、**決着の新しい順**（同時刻は id の降順）に返す。
   * 中身の判定は `approvals-answered.ts`。
   *
   * **`pending=true`（明示）・`order` / `limit` / `cursor` とは併用できない**（400）。未回答だけを
   * 求めながら決着した日を指す呼びは矛盾しているし、並びは決着の新しい順で固定なので
   * `order` / `cursor`（`(createdAt, id)` の位置）は意味を持たない。黙って片方を無視しない。
   * `conversationId` は併用できる（その会話の件に絞る）。
   * 形の検査はハンドラが `localDayRange` で行う（`/reports/:date` と同じ。2月30日を通さない）。
   */
  answeredOn: z.string().optional(),
});

/**
 * `GET /approvals/answered-dates` の `limit` / `beforeDate`（`reportsQuery` と同じ既定・上限・
 * 向き）。`beforeDate` は前の頁の最後の日で、**それより古い日**を返す。封筒は持たない
 * ——続きが在るかは `limit` 件ちょうど返ったかで判る。
 */
const approvalsAnsweredDatesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(365).default(7),
  beforeDate: z.string().optional(),
});

/**
 * `/approvals` のカーソルの中身。**位置（index）ではなく `(createdAt, id)` の
 * 比較で辿る（本物の keyset）。**
 *
 * **なぜ位置で辿らないか。** `packages/storage-fs` の `putApproval` は既存の id
 * への書き込みで配列の末尾へ移動する（`grep -Fn -- 'putApproval' packages/storage-fs/src/jobs.ts`
 * — filter して除いてから push するので、答えた行が末尾へ動く）。承認への回答は
 * まさに `putApproval` を呼ぶので、頁の間に誰かが答えると位置がずれる——前半の
 * 行が答えられて末尾へ動けば、後続の行の位置が1つ前へずれて1件飛ばす。動いた
 * 行自身は末尾に現れるので二重に見えることもある。**この壊れ方はインメモリの
 * 実装（`Map` は既存キーの位置を保つ）では絶対に再現しない**——歯は
 * `packages/storage-fs/src/index.test.ts` に直接置く（`app.test.ts` は
 * `createMemoryStores` を使うため、そちらだけでは fs の壊れ方を検出できない）。
 *
 * `(createdAt, id)` の比較で辿れば、行が動いても・消えても・増えても、指す
 * 位置は値そのものなので飛ばさず重複しない。`id` は同時刻の同着を割るための
 * 補助キー（`createdAt` はミリ秒精度の `new Date().toISOString()` で、ぴったり
 * 同じ値が2件ある可能性がゼロではない）。
 *
 * `createdAt` を文字列のまま比較する（`<` / `>`）。**この比較は
 * `new Date().toISOString()` が返す固定形式（UTC・ミリ秒3桁・`Z` 終端）である
 * ことに乗っている** — `pendingApprovalSchema.createdAt` の型（`isoDateTime`。
 * `packages/core/src/schema.ts`）はより広い ISO 8601（オフセット付きも許す）を
 * 許容するが、この repo の生成経路（`tools.ts` の `ask_human`）は常に
 * `new Date().toISOString()` を使うので、実際に現れる値はこの形式に揃っている。
 */
const approvalsCursorSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  order: z.enum(['asc', 'desc']),
});

// **位置の型（`ApprovalPagingKey`）と keyset の比較（`compareApprovalPagingKeyAsc`
// / `compareApprovalPagingKey`）は `@alteroid/core` から import する。** かつて
// ここに置いてあったものを、`approvals_list`（クローンの道具、
// `packages/core/src/tools.ts`）が同じ `(createdAt, id)` の比較で継続点を足した
// ときに `@alteroid/core`（`approval-cursor.ts`）へ移設した。**挙動は1バイトも
// 変えていない**——呼び出し側（下）の引数の順序・比較の向きはそのままで、呼ぶ
// 関数の場所だけが変わっている。台帳の側（`commitmentPosition` /
// `compareCommitmentPosition`。下のコメント）が「2箇所に同じ実装を置いて歯で
// 見張る」形から寄せる形へ移ったのと同じ理由で、こちらは初めから寄せてある。
/**
 * 会話は日誌から組み立てる。`scan` はどこまで遡るかで、`limit` は返す本数。
 * **黙って打ち切らない** — 応答に `scanned` を返して、遡り切れていないことが
 * 呼ぶ側に見えるようにしてある。
 *
 * **`scan` が数えるのは人間との往復だけである**（`readConversationWindow` が
 * `with: ['human']` を `limit` より前で効かせるため。issue #418）。マネージャー
 * との往復・内部ターン（`self`）は同じ `exchange` として日誌に混ざっているが、
 * この予算を食わない。
 *
 * **`GET /conversations` はもう1つ、別の窓で黙って切っていた（#418 の裏返し）。**
 * `scan` は日誌側の窓（何件遡るか）だが、`limit`
 * は組み立てた**会話**の窓（何件返すか）で、こちらは黙って `slice(0, limit)`
 * していた。人間との会話は増え続ける一方なので、この窓は時間が経てば必ず
 * 埋まる（#418 の駆動因だった並走の量とは違い、こちらは単調増加である）。
 * `conversation_read`（クローンの道具。`tools.ts`）は同じ理由で `hiddenByLimit`
 * を返しているのに、この人間向けの口だけが黙っていた。**応答に
 * `reachedStart` と `hiddenByLimit` を足し、この口も言うようにした。**
 *
 * **（#3550 で `cursor` / `nextCursor` を足した。以下は足す前の判断の記録。）**
 *
 * **いつページングを足すか — 数ではなく断り書きの有無で判断する。**
 * `hiddenByLimit > 0` の断り書きが実際に画面や CLI に出るようになったら、
 * ページング（あるいは `limit` を画面から動かせる形）を検討する時期である。
 * 出ていないなら要らない。⟹ 判断の材料は「断り書きが出ているか」であって、
 * 会話の本数ではない（数は腐るが、断り書きの有無は腐らない）。
 * **依頼者の観測（2026-08-24 時点、自分では測っていない）**: `scan=10000` で
 * 会話15件、先頭に到達。`limit` の上限 200 にも画面の既定 30 にも遠い —
 * だから、いまはページングを足さない。
 *
 * **依頼者の再測（2026-08-24T20:5xZ、`conversation_read` 経由。issue #432）**:
 * `limit=20` `scan=10000` で会話18件、「人間との往復を58件遡った。先頭に
 * 届いている」。`limit=20` でも `limit=30` でも `hiddenByLimit = 0`。⟹ doc が
 * 定めた基準（`hiddenByLimit > 0` の断り書きが実際に出ること）は依然として
 * 満たしていない——#432 の PR ではこの口に何も足していない。数は 15 → 18 と
 * 動いたが、答えは変わっていない（数は腐るが、断り書きの有無は腐らないという
 * 上の判断がそのまま効いている）。
 */
const conversationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  scan: z.coerce.number().int().min(1).max(10000).default(2000),
  /**
   * 続きの頁（応答の `nextCursor` をそのまま渡す）。**`/approvals` / `/commitments` と同じ形**
   * （不透明な `cursor` ＋ 応答の `nextCursor`。続きが無ければ `nextCursor` は鍵ごと無い。
   * 壊れた・使えない `cursor` は 400）。**`limit` を増やして取り直す必要はもう無い。**
   *
   * 中身は日誌の継続点（`{ id, at }`。頁の最後の会話の最新の人間との発言、または窓の最後に読んだ
   * 発言）。並びは会話の最新の発言の日誌の順序なので、同じミリ秒の同着も飛ばさず重複しない。
   * **`scan` の窓の外も、継続点を辿れば読める**（`readConversationPage` の doc）。
   */
  cursor: z.string().optional(),
});
/**
 * `includeSuperseded`: 編集で畳まれた旧発言・その応答も含めて返すか
 * （issue「チャットの送信済みメッセージを編集する」）。
 *
 * **`z.coerce.boolean()` を使わない。** 上の `commitmentsQuery.includeClosed` と
 * 同じ理由——`?includeSuperseded=false` が true になる（＝既定は編集後の版だけ、
 * という約束が黙って壊れる）。`.enum(['true', 'false'])` に揃える。
 */
const conversationQuery = z.object({
  scan: z.coerce.number().int().min(1).max(10000).default(2000),
  includeSuperseded: z.enum(['true', 'false']).default('false'),
});
/**
 * 利用状況の照会。
 *
 * **既定で期間を絞らない。** 絞ると「今日いくら使ったか」を聞いたつもりの人へ
 * 全期間の合計を返す、という取り違えが起きやすい。呼ぶ側が `from` / `to` を
 * 明示する形にして、返り値の `byDate` で日別が読めるようにしてある。
 */
const usageQuery = z.object({
  from: usageDateSchema.optional(),
  to: usageDateSchema.optional(),
  managerId: z.string().min(1).optional(),
  /**
   * **誰が**（層）・**どこで**（場所）で絞る。
   *
   * **4つの口（API / CLI / Web / クローンの道具）へ同時に置くこと。** 片方にだけ
   * 足すと、そこにしかできない分析が生まれる（PRD「インターフェース」）。
   */
  layer: usageLayerSchema.optional(),
  site: usageSiteSchema.optional(),
  /**
   * **どの認証トークンで**使った分だけ（`GET /tokens` の `id`）。
   *
   * **「帰属が無い分だけ」を絞る口は作らない**（`usage.ts` の `usageQuerySchema`）。
   * 取れていない分を数えたいなら絞らずに引いて `breakdown.byToken` の `null` を見る。
   */
  tokenId: z.string().min(1).optional(),
});
const journalStreamQuery = z.object({
  /** カンマ区切りの種別。指定しなければ全部流れる。 */
  type: z.string().optional(),
});
/**
 * `DELETE /archive/:id` の override 理由（#698 / #776）。
 *
 * **空文字を弾かない。** `guardArchiveRemoval`（`packages/core/src/manager.ts`）
 * 自身が `reason?.trim()` の非空をもって「override する」という意思表示として
 * 扱う契約になっている——ここでさらに `min(1)` を掛けて 400 にすると、
 * 「クエリ引数を付けたが空だった」という同じ入力が、契約より手前の層で
 * 別の応答（400 ではなく 409 denied）になる形に食い違う。判定は1箇所
 * （`guardArchiveRemoval`）に置いたままにするため、ここでは型（文字列/省略）
 * だけを固定する。
 */
const archiveRemoveQuery = z.object({
  overrideReason: z.string().optional(),
});
const managerMessageBody = z.object({
  // **「空」は NUL を落とした後で見る**（#3461）。マネージャーのストアは NUL を落とすので、
  // 落とす前の長さで見ると NUL だけの text が空の追加指示として届く。
  text: z
    .string()
    .min(1)
    .refine((value) => stripNul(value).length > 0),
  /** 許可確認への回答なら付ける。複数を待っているときは省略できない。 */
  requestId: z.string().min(1).optional(),
  decision: z.enum(['allow', 'deny']).optional(),
});
const abortBody = z.object({
  // NUL だけの reason は、止めた後の文言と日誌の理由が空欄になるので入口で断る（#3461）。
  reason: z
    .string()
    .min(1)
    .refine((value) => stripNul(value).length > 0)
    .optional(),
});
/**
 * 継続中の依頼の仕込み（人間の手からも同じことができる口）。
 *
 * クローンの `schedule_create` と同じものを人間も置ける。自分が出した「これから
 * ずっと」の依頼を人間が見て直せないと、可観測性の穴になる（PRD「権限境界」の
 * 人間の制御手段④）。
 */
const scheduleBody = z.object({
  kind: scheduleKindSchema,
  // **「空」は NUL を落とした後で見る**（#3438）。ストアは NUL を落として残すので、落とす前の長さで見ると
  // NUL だけの `request` が検査を抜け、ハンドラが日誌へ「設定しようとしている」を書いた後で 500 になる。
  request: z
    .string()
    .min(1)
    .refine((value) => stripNul(value).length > 0),
  spec: scheduleSpecSchema,
  /**
   * 任意（Issue #3821）。書き換える側が**読んだ時の版**（`GET /schedule` の `updatedAt`）。
   * 書く瞬間の版と違えば書かずに 409。`null` は「読んだ時には無かった」（いまも無いときだけ
   * 作れる）。**省略は従来どおり後勝ち**（クローンの道具・CLI を壊さない）。
   * `memoryBody.ifMatch` / `practiceBody.ifMatch` と同じ形。
   */
  ifMatch: z.string().nullable().optional(),
});

/**
 * 台帳へ1件積む（クローンの `commitment_open` と同じことを人間の手からも）。
 *
 * **人間が頼んだことは chat から自動で載るが、それだけでは片道になる。** 人間が
 * 後から思い出した宿題や、chat 以外の場（issue・口頭）で決まったことを台帳へ置く手が
 * 無いと、「クローンは自分で積めるのに人間は積めない」という差が残る。
 */
const commitmentBody = z.object({
  /** NUL を落とした後に1文字以上（Issue #3388。台帳の入口は NUL を落として残すので、NUL だけは空の本文になる）。 */
  body: z
    .string()
    .min(1)
    .refine((value) => stripNul(value).length > 0),
  /** どこから来たか（会話 id・issue 番号など。分かるときだけ）。 */
  // NUL だけの source は、ストアが NUL を落として空の source で残すので断る（Issue #3436）。
  source: z
    .string()
    .min(1)
    .refine((value) => stripNul(value).length > 0)
    .optional(),
});

/**
 * 閉じるときの理由。**空を許さない。**
 *
 * 「閉じた」だけを残すと、何をもって終わりとしたのかが残らない。人間が後から否定
 * できることが最終承認の実体である以上（north_star）、否定する材料の無い閉じ方を
 * 受け付けてはいけない（`commitmentSchema` の `closedReason` の注記）。
 */
const commitmentCloseBody = z.object({ reason: nonBlankString });

/**
 * 編集後の本文。**空を許さない**（`commitmentBody.body` と同じ制約——空文字を
 * 許すと「本文の無い依頼」を人間が自分で作れてしまう）。
 */
const commitmentEditBody = z.object({
  body: z
    .string()
    .min(1)
    .refine((value) => stripNul(value).length > 0),
  /**
   * 任意（Issue #3786）。読んだ時の版（`GET /commitments` の行の `editedAt ?? at`）。
   * 書く瞬間の版と違えば書かずに 409。省略は従来どおり後勝ち。
   */
  ifMatch: z.string().optional(),
});

/**
 * 片付けたものも返すか。
 *
 * **`z.coerce.boolean()` を使わない。** あれは空でない文字列をすべて true にするので、
 * `?includeClosed=false` が true になる（＝既定は未了だけ、という約束が黙って壊れ、
 * 一覧が片付いたもので埋まる）。`/approvals` の `pending` と同じ形に揃えてある。
 *
 * **`limit` / `cursor`（窓。issue #432 の考え方を踏襲）。** 並べ替え・絞り込みは
 * 依然として足さない（理由: 判断がクローンから器へ移る）。窓（`limit`/`cursor`）は
 * 2026-08-25 に人間の明示の「はい」を受けて足した——`limit`/`cursor` は順序・
 * 絞り込みを何も決めない。並びは `CommitmentStore.list` の契約
 * （`packages/core/src/store.ts` の doc）が既に固定していて（未了は古い順、片付いた
 * ものは新しい順で未了の後ろ）、窓はその固定された順序の上に載るだけである。
 *
 * **`limit` に上限（`max`）を付けない。** 理由は `approvalsQuery` の doc と同じ
 * （この HTTP の口は人間がブラウザで扱う前提で、既定は全件——
 * `.claude/skills/listing-and-detail/SKILL.md`「いま揃っていないもの」の
 * `/commitments` の扱い）。
 *
 * **`order` は足さない。** すぐ上の route のコメント（「並べ替えや絞り込みの引数を
 * ここへ足さないこと」）がそのまま生きている——順序は器の持ち物ではない。
 */
const commitmentsQuery = z.object({
  includeClosed: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().optional(),
});

/**
 * `windowHours`（`GET /progress`、#2241）。**文字列のまま受ける**——`z.coerce.number()`
 * だと空文字が 0 になり、「渡していない」「空を渡した」「0 を渡した」が区別できない
 * （ハンドラで数値化する）。既定は `DEFAULT_PROGRESS_WINDOW_HOURS`。
 */
const progressQuery = z.object({
  windowHours: z.string().optional(),
});

/**
 * `/commitments` のカーソルの中身。**段（segment）を持つ keyset。**
 *
 * 一覧は2段でできている（`CommitmentStore.list` の契約。3実装 —
 * `packages/core/src/testing.ts` のインメモリ / `packages/storage-fs/src/commitments.ts`
 * / `packages/storage-pg/src/commitments.ts` — とも同じ）: 未了（`closedAt === undefined`）
 * を `at` の**昇順**、片付き（`closedAt !== undefined`）を `closedAt` の**降順**で、
 * その順に連結したもの。
 *
 * **2段を跨ぐ錨は作らない。** 境界を跨ぐ錨の意味を新しく決めることになり、ストアの
 * 契約（`CommitmentStore`）に手が入ることになる——これは却下されている（この PR の
 * 設計）。代わりに**錨が自分の段を名乗る**（`segment`）。`key` は段の中の並びの
 * キー（`open` は `at`、`closed` は `closedAt`）で、`id` は同時刻の同着を割るための
 * 補助キー（`at` / `closedAt` はミリ秒精度の `toISOString()` で、同値がありえない
 * わけではない——`approvalsCursorSchema` の doc と同じ理由）。
 *
 * `includeClosed` は、この錨を刷った一覧がどちらだったかを持つ。錨は刷られた一覧の
 * 中でしか意味を持たないので、リクエストの `includeClosed` と食い違えば 400 にする
 * （下のハンドラ。`/approvals` が `order` の食い違いを 400 にしているのと同じ理由）。
 */
const commitmentsCursorSchema = z.object({
  segment: z.enum(['open', 'closed']),
  /** 段の中の並びのキー。`open` は `at`、`closed` は `closedAt`。 */
  key: z.string().min(1),
  id: z.string().min(1),
  /** 錨を刷った一覧が `includeClosed` のどちらだったか。 */
  includeClosed: z.enum(['true', 'false']),
});

// **位置の取り出し（`commitmentPosition`）と keyset の比較
// （`compareCommitmentPosition`）は `@alteroid/core` から import する。** かつて
// ここに `commitmentPos` / `compareCommitmentPos` という1バイト違わない実装が
// 別々に置いてあった——`commitment_list`（クローンの道具、`packages/core/src/
// tools.ts`）が同じ並び順（`CommitmentStore.list` の契約）に対して継続点を
// 足したときに見つかった重複で、`@alteroid/core`（`commitment-cursor.ts`）へ
// 寄せた。**挙動は1バイトも変えていない**——呼び出し側（下）の引数の順序・
// 比較の向きはそのままで、呼ぶ関数の場所だけが変わっている。

/**
 * `status` / `limit` / `afterId` / `afterStartedAt`（issue #670）。
 *
 * **既定は現状維持。何も渡さない呼びは応答が1バイトも変わらない（opt-in）。**
 * 判定は生のクエリで行う（下のハンドラ）——`c.req.valid('query')` は既定値を
 * 埋めるので「渡されたか」を答えない。
 *
 * ## カーソルは `/journal` 形（可視の複合キー）
 *
 * 応答（`managerSummarySchema`。`apps/daemon/src/openapi.ts`）には既に
 * `managerId` と `startedAt` が載っているので、呼ぶ側は前の頁の最後の行の
 * `managerId`/`startedAt` を読んで次の要求を自分で組み立てられる——**応答に
 * 新しい欄を1つも足さなくてよい**（`journalQuery` の doc が言う条件そのもの）。
 * **`/commitments` 形の不透明カーソル（`cursor.ts`）は使わない。** 封筒
 * （`total` / `nextCursor`）も足さない——続きが在るかは「`limit` 件ちょうど
 * 返ったか」で呼ぶ側が判る（CLI の `noteIfAtLimit`、`reports.tsx` の
 * `isReportsWindowFull` と同じ流儀）。
 *
 * ## `order` は足さない
 *
 * 並びは `ManagerPool.list()` が固定している（`startedAt` の降順）。ここで
 * 選べるようにすると、#432 が `/commitments` で守った「既定は現状のまま」を
 * こちらで崩すことになる。窓はその固定された順序の上に頁を切るだけである。
 *
 * ## `limit` の既定を作らない（未指定＝全件）
 *
 * 既定で切ると、**渡していない呼びの応答が変わる**うえに、到達できない行が
 * 生まれる（north_star 禁止2、`ManagerPool#retire` の doc「上限を持たせると、
 * 走行中のマネージャーが増えただけで無関係な1本が押し出される」）。
 *
 * ## `max` を 1000 にした理由
 *
 * **この数値は資源を守らない。** 既定が全件なのだから、頁の大きさに上限を
 * 置いても守れるものは何も無い（`approvalsQuery` の doc が逐語でそう言って
 * いて、あちらとこちらの `/commitments` はどちらも `max` を持たない）。
 * ここに置く理由は1つだけ——**窓の形を `/journal` と揃えたことである。**
 * `/managers` の窓は `/journal` と同じ「可視の複合キー＋封筒なし」で、
 * `limit` の受け取り方まで同じにしておけば、片方を読んだ人がもう片方で
 * 違う挙動に当たらない。**数値を `/journal` と別に決めると「なぜ違うのか」を
 * 説明できない**ので、説明できる側（揃える）に倒した。
 */
const managersQuery = z.object({
  /**
   * カンマ区切りの状態（`jobStatusSchema` の6値）。**知らない値は 400 で
   * 断る**（ハンドラで検査する。黙って無視すると、綴りを間違えた呼びが
   * 「その状態のものは0件」として返り、絞り込みが効いていないことに
   * 気づけない）。
   */
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  /**
   * ページングの足がかり（`afterStartedAt` と組で渡す）。**「次」は返る順序
   * の意味——`startedAt` の降順なので、錨より*古い*側が返る。**
   */
  afterId: z.string().optional(),
  /** ISO 8601。`afterId` と組で渡す（上の注意を見よ）。 */
  afterStartedAt: z.string().optional(),
});

/**
 * `/managers` の窓の位置。**`(startedAt, managerId)` の比較で辿る（keyset）。**
 *
 * `managerId` は同時刻の同着を割るための補助キーである（`startedAt` は
 * `toISOString()` のミリ秒精度なので、ぴったり同じ値が2件ありえないわけでは
 * ない——`approvalsCursorSchema` の doc と同じ理由）。**`ManagerPool.list()` の
 * 並びは `startedAt` だけで決まるので、同着の相対順はそこでは決まっていない**
 * （プロセス内の像と台帳を `Map` で合流させた順に落ちる）。⟹ 補助キーを足して
 * 初めて、頁を辿っても飛ばさず重複しないことが言える。
 */
interface ManagerPagingKey {
  startedAt: string;
  managerId: string;
}

/**
 * 返る順序（`startedAt` の降順、同着は `managerId` の降順）での前後。
 *
 * 負なら `a` が先（＝より新しい側）。**`localeCompare` を使う**——
 * `ManagerPool.list()` の並べ替えと同じ比較にしておかないと、ここで並べ直した
 * 結果があちらの並びと食い違う（`grep -Fn -- "b.startedAt.localeCompare(a.startedAt)" packages/core/src/manager.ts`）。
 */
function compareManagerPagingKey(a: ManagerPagingKey, b: ManagerPagingKey): number {
  const byStartedAt = b.startedAt.localeCompare(a.startedAt);
  if (byStartedAt !== 0) return byStartedAt;
  return b.managerId.localeCompare(a.managerId);
}

/**
 * `status` のカンマ区切りを 6 値へ照合する。
 *
 * **知らない値は捨てずに返す**（呼び出し側が 400 にする）。空の要素
 * （`status=,,`）は落とす——`/journal` の `type` と同じ形である
 * （`grep -Fn -- "type?.split(',').filter((value) => value.length > 0)" apps/daemon/src/app.ts`）。
 */
function parseManagerStatuses(raw: string): { statuses: JobStatus[]; unknown: string[] } {
  const statuses: JobStatus[] = [];
  const unknown: string[] = [];
  for (const value of raw.split(',')) {
    if (value.length === 0) continue;
    const parsed = jobStatusSchema.safeParse(value);
    if (parsed.success) statuses.push(parsed.data);
    else unknown.push(value);
  }
  return { statuses, unknown };
}

const loginBody = z.object({
  provider: z.string().min(1),
  /** どの端末から始めたか、人間が後から見分けるための覚書。 */
  label: z.string().max(200).optional(),
});
const claimBody = z.object({ claimSecret: z.string().min(1) });

function loginErrorDetail(reason: string): string {
  switch (reason) {
    case 'invalid_state':
      return 'ログイン要求が見つかりません（やり直してください）。';
    case 'expired':
      return 'ログイン要求の期限が切れています（やり直してください）。';
    case 'already_used':
      return 'このログイン要求は既に使われています。';
    case 'unknown_provider':
      return '設定されていないログイン手段です。';
    default:
      return 'プロバイダとのトークン交換に失敗しました。';
  }
}

/** 連携の鍵を、人間が読む・応答に載せる形にする。**値も sha256 の全体も載せない**（指紋＝先頭12桁だけ）。 */
function integrationKeyView(key: IntegrationKeyRecord) {
  return {
    id: key.id,
    name: key.name,
    source: key.source,
    fingerprint: integrationKeyFingerprint(key.sha256),
    createdAt: key.createdAt,
    createdBy: key.createdBy,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    lastUsedAt: key.lastUsedAt,
    limits: integrationKeyLimits(key),
  };
}

/** 日誌に残す連携の鍵の呼び名。**名前・source・id・指紋だけ**（値は書かない）。 */
function describeIntegrationKey(key: IntegrationKeyRecord): string {
  return `「${key.name}」（id=${key.id}、source=${key.source}、指紋=${integrationKeyFingerprint(key.sha256)}）`;
}

/** 日誌に残す人間向けの名前。 */
function describeAccount(account: AuthAccount): string {
  const name = account.email ?? account.displayName;
  return name === null || name === undefined ? account.id : `${name} (${account.id})`;
}

function claimErrorDetail(reason: string): string {
  switch (reason) {
    case 'invalid_secret':
      return 'claimSecret が違う';
    case 'expired':
      return 'ログイン要求の期限が切れている';
    case 'failed':
      return 'ログインに失敗している';
    default:
      return 'ログイン要求が見つからない（既に引き取り済みの可能性）';
  }
}

/**
 * 本文検査を持たない POST の門番。
 *
 * 待ち受けているのは 127.0.0.1 だけだが、**それはブラウザからの保護にならない。**
 * 人間が開いた任意のページから `fetch(..., { mode: 'no-cors' })` や HTML form で
 * ここへ POST できてしまい（CORS の単純リクエスト）、応答が読めなくても送信は成立する。
 * 見ていないクローンのターンを他人が起こせる状態は、観測の口ではなく実行の口である。
 *
 * `application/json` を要求すると preflight が必須になり、CORS ヘッダを返さない
 * このデーモンでは preflight が通らない。**ツールや能力を削るのではなく、
 * 実行環境の境界で塞ぐ**（north_star 禁止2）。
 *
 * `validator('json', ...)` を持つ経路は hono が同じ検査をするので、こちらは要らない。
 * **本文検査の無い POST を足すときは、必ずこれを付けること。**
 */
const deliberateClient = createMiddleware(async (c, next) => {
  if (mimeEssence(c.req.header('content-type')) !== 'application/json') {
    return c.json({ error: 'content-type: application/json が要る' as const }, 415);
  }
  await next();
});

/**
 * `Content-Type` の MIME essence（`;` より前）だけを取り出す。
 *
 * **部分一致で判定してはいけない。** ブラウザが単純リクエストか否かを決めるのは
 * essence だけなので、`text/plain; note=application/json` は safelist のまま
 * preflight 無しで飛ぶ。`includes('application/json')` はこれを通してしまい、
 * 門番があるつもりで穴が空く。
 */
function mimeEssence(contentType: string | undefined): string {
  return (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

// **`isDailyReport` は `@alteroid/core` の1本を使う**（ここに写しを持たない）。
// 日報の行には「書けなかった」の印（`unavailable`）が付くことがあり、**数える側と
// 出す側で扱いが違う** — 出す側（この経路）は印の行も出し、数える側
// （`clone.ts` / `schedule.ts`）は数えない。判定が3か所に散ると、その違いが
// どこか1か所で静かに逆になる。

/**
 * 本文検査が無い POST / DELETE（`deliberateClient` のみ）に共通の requestBody。
 *
 * **門番を足したら必ずこれも付けること。** 片方だけの経路があると「門番つきなら本文必須」が
 * 例外つきの規則になり、生成クライアントはその経路でだけ 415 に当たる。
 * `packages/api-client/src/client.test.ts` が7経路すべてを型の側で数え上げている。
 *
 * **サーバは本文を読まないが、`content-type: application/json` は要る。** それを
 * 415 の description（散文）だけで伝えると、spec から起こした他言語のクライアントは
 * ヘッダを付けずに叩いて 415 に当たる。機械可読な形で「application/json で来い」と
 * 言うためにここを置いてある。
 *
 * **`required: true` でなければ契約にならない。** OpenAPI では requestBody を省略
 * した呼び出しに、その media type の `content-type` を送る義務が無い。つまり
 * `required: false` だと生成クライアントは本文もヘッダも省略でき、直したはずの
 * 415 がそのまま残る（実際 `openapi-fetch` は「body が無ければ `Content-Type` を
 * 付けない」実装である）。だから**中身は縛らないまま `required: true`** にして、
 * 「送るものが無くても `{}` は置く」を型の側から強制する。
 *
 * **サーバの方が緩いのは意図的。** 本文は読まないので空でも `{}` でも通る。spec が
 * サーバより厳しい向きなら、spec から起こしたクライアントは必ず門番を素通りできる
 * （逆向きにすると、spec が許した呼び方がサーバに弾かれる）。
 *
 * **門番を緩める変更ではない。** `deliberateClient` は無改変で、これは spec 側が
 * 門番の存在を表現していなかったことへの追随である。
 *
 * 関数にしてある理由は `noBodyPostResponses` と同じ（モジュールの初期化順）。
 */
function noBodyPostRequestBody(description: string) {
  return {
    required: true,
    description,
    // 中身は縛らない（free-form）。ここで伝えたいのは形ではなく content-type である。
    content: { 'application/json': { schema: {} } },
  };
}

/**
 * 外部イベントの入口（`POST /events` と `POST /events/:source`）の 400。
 * **ステータスの数値は各経路の `describeRoute` に直に書く**（「実際に返すステータスが宣言されているか」を測る歯が、
 * リテラルのキーを経路ごとに読むため）。中身（文言・スキーマ）だけをここで共有する。
 */
function eventBadRequestResponse() {
  return {
    description:
      '本文が JSON として不正。または source が daemon 自身の予約語（`code`: `reserved_source`＝' +
      '`token-pool`・`runner-registry`。前後の空白・大文字小文字・全角を正規化した後で比べる）。' +
      'または source が NUL・孤立サロゲートを含む（`code`: `invalid_source`）。' +
      'または添付を付けられない（`code`: `attachment_missing`＝無い・期限切れ、' +
      '`attachment_conflict`＝すでに別の会話・外部イベントに結び付いている、' +
      '`attachment_forbidden`＝連携の鍵が、その鍵自身が上げていない添付を付けようとした、' +
      '`too_many`＝個数の上限超え）。いずれもイベントは投函されない。',
    content: { 'application/json': { schema: resolver(attachmentErrorResponseSchema) } },
  };
}

/**
 * 外部イベントに添付を付けたときの断り（`POST /events` と `POST /events/:source`。#3113 段3）。
 * **断ったらイベントは投函しない**（添付を黙って落として本文だけ送らない）。
 */
function eventAttachmentResponses() {
  return {
    413: {
      description:
        '連携の鍵の本文の上限（既定 1 MiB。連携の鍵でだけ。`POST /attachments` には掛からない）を超えた。' +
        'または添付の合計の上限超え（`code`: `total_too_large`）。',
      content: { 'application/json': { schema: resolver(attachmentErrorResponseSchema) } },
    },
  };
}

/**
 * 連携の鍵（`altk_`）でこの口を叩いたときだけ起きる応答（`POST /events` と `POST /events/:source`）。
 * 人間・operator の経路には、これらの制限（401・413・429 と source の突き合わせ）は無い。
 *
 * **403（source の不一致）はここに置かず、各経路の `describeRoute` に直に書く**——「実際に返すステータスが
 * 宣言されているか」を測る歯が、リテラルの `403` を経路ごとに読むため。
 */
/**
 * daemon が自分の名として使う `source`（予約語）を外から名乗ったときの断り（400。`code: 'reserved_source'`）。
 * **エラーには値を混ぜない**（固定の文だけ。`conversationId` の入口の検査と同じ作法）。
 * 判定は正規化の後（`isReservedEventSource`）。`isDaemonSelfNotice` は `source` だけで「daemon 自身の
 * 知らせ」とみなし、台帳に載せず受信箱で畳むので、外から名乗らせない（`daemon-self-notice.ts`）。
 */
const RESERVED_SOURCE_BODY = {
  error: 'この source は daemon 自身が使う予約語なので、外からは使えない（何も積んでいない）',
  code: 'reserved_source',
} as const;
/**
 * NUL や孤立サロゲートを含む `source` を外から名乗ったときの断り（400。`code: 'invalid_source'`。#3695）。
 * 会話 id（#3573・#3640）と同じ形の穴: pg は NUL を落とし、孤立サロゲートを U+FFFD へ置き換えて残すので、
 * 別々の source が1つに潰れる。黙って正規化せず、入口で断る。**エラーには値を混ぜない**（固定の文だけ）。
 * 予約語（`reserved_source`）とは理由が違うので code を分ける（呼び手が「名前の問題」と「形の問題」を見分けられる）。
 * 連携の鍵の source は `^[a-z0-9._-]{1,64}$` で、この2つは元から通らない（鍵の発行では変えていない）。
 */
const INVALID_SOURCE_BODY = {
  error: 'source に NUL や孤立サロゲートは含められない（何も積んでいない）',
  code: 'invalid_source',
} as const;

/** `source` が NUL か孤立サロゲートを含むか（会話 id の入口の検査と同じ判定）。 */
function isMalformedEventSource(source: string): boolean {
  return hasNul(source) || !isWellFormedString(source);
}

const RESERVED_SOURCE_KEY_BODY = {
  error:
    'この source は daemon 自身が使う予約語なので、連携の鍵の source にできない（何も作っていない）',
  code: 'reserved_source',
} as const;

function integrationKeyEventResponses() {
  return {
    401: {
      description: '連携の鍵が無効か期限切れ（未知・失効・期限切れ）。',
      content: { 'application/json': { schema: resolver(errorResponseSchema) } },
    },
    413: {
      description: '連携の鍵の本文の上限（既定 1 MiB）を超えた。',
      content: { 'application/json': { schema: resolver(errorResponseSchema) } },
    },
    429: {
      description:
        '連携の鍵の回数の上限（既定 60 回/分）を超えた。`Retry-After`（秒）の後でやり直す。',
      content: { 'application/json': { schema: resolver(errorResponseSchema) } },
    },
  };
}

/**
 * 受信箱へ永続化できなかったときの断り（`POST /events` と `POST /events/:source`。#3679）。
 * **受信箱のメモリにも積んでいない**ので、同じイベントを送り直してよい（二重には届かない）。
 * 他の 503 と同じく `Retry-After` は付けない（器の瞬断で、待ち時間の目安を持たない）。
 */
function eventNotPersistedResponse() {
  return {
    description:
      '受信箱へ永続化できなかった（器への書き込みが、拾い直しの後も失敗した）。**イベントは受け付けていない** — ' +
      '受信箱のメモリにも積んでいないので、送り直してよい（二重には届かない）。',
    content: { 'application/json': { schema: resolver(errorResponseSchema) } },
  } as const;
}

function eventNotPersistedBody() {
  return {
    error: '受信箱へ書けなかったので、イベントを受け付けていない（送り直してよい）' as const,
  };
}

/**
 * 本文検査が無い POST（`deliberateClient` のみ）に共通の 415 応答。
 *
 * **関数にしてあるのは意図的。** `app.ts` と `openapi.ts` は互いを import する
 * （app.ts は応答スキーマを、openapi.ts は spec 生成のため `createApp` を読む）。
 * モジュールの初期化順によっては、片方のトップレベルで即座に評価する定数が
 * まだ空の相手の export を読んでしまう。`describeRoute(...)` は
 * `createApp` の呼び出し時（＝両モジュールの初期化が終わった後）まで実行を
 * 遅らせるので、ここも定数ではなく関数にして遅延させる。
 */
function noBodyPostResponses() {
  return {
    415: {
      description:
        'content-type が application/json ではない（ブラウザの単純リクエスト対策 — ' +
        '状態を変える POST は必ずここを通す）。',
      content: { 'application/json': { schema: resolver(errorResponseSchema) } },
    },
  } as const;
}

/**
 * 認証を要求しない経路。
 *
 * `/health` は CLI が「自分の起こしたデーモンか」を確かめる口で、ログインの前に
 * 必ず通る（応答に秘密は載っていない）。`/auth/*` はログインそのものの経路なので、
 * ここを閉じるとログインできない。`/openapi.json` と `/docs` は仕様の公開である。
 *
 * **`/auth/me` と `/auth/logout` だけは例外で認証が要る。** 「いま自分が誰か」は
 * 認証済みでなければ答えようが無い。**`/auth/logout`（issue #1757）も同じ理由**
 * ——失効させる先はいま提示している資格そのものなので、資格の提示なしに叩ける
 * 素通しの口にしてはいけない（素通しにすると、誰でも他人のトークンの id さえ
 * 知れば失効させられる口になる——ここは「提示したものを失効させる」設計なので、
 * 提示が無ければそもそも何も失効させられない）。
 */
/** 資格が使えなくなって chat の流れを閉じるときに送る `error` の文（issue #1820）。 */
const SSE_CREDENTIAL_LOST_MESSAGE =
  'この接続の資格が使えなくなった（ログアウト・許可の取り消し・期限切れのどれか）ので、流れを閉じる。';

function isPublicPath(path: string): boolean {
  if (path === '/health' || path === '/openapi.json' || path === '/docs') return true;
  if (path === '/auth/me' || path === '/auth/logout') return false;
  return path === '/auth' || path.startsWith('/auth/');
}

/**
 * `validator('json', ...)` の `hook` が受け取る issue 配列から、どこが壊れて
 * いたかを人が読める形（`"credentials.1.name"` のような `path` の連結）に畳む。
 *
 * **不変: 値は1文字も含めない。含めてよいのは `path` だけである。** issue は
 * `message` を持つが、そちらは zod が生成する文言に本文の値を埋め込むことが
 * ある（正規表現の失敗理由など、実装によっては入力値そのものを引用する形が
 * ありうる）ので、ここでは`path` だけを見る。呼び出し側（`/tokens` の
 * `hook` の doc）にある実測がこの関数を要る理由——`hook` を渡さないと
 * `@hono/standard-validator` の既定の 400 がリクエスト本文をまるごと返す
 * ——そのものへの対処であり、この関数が万一 `message` や値を混ぜて返すと、
 * 対処そのものが無意味になる。
 */
function whereValidationFailed(issues: readonly { readonly path?: readonly unknown[] }[]): string {
  return issues
    .map((issue) => issue.path?.map((part) => String(part)).join('.') ?? '')
    .filter((path) => path.length > 0)
    .join(', ');
}

/**
 * `validator('json', schema)` を常にこの形で呼ぶための薄いラッパー（issue #424
 * ⭐3案目）。**`app.ts` の中で `validator('json', ...)` を直接書かないこと。**
 * `hook` を渡し忘れた経路が1つでも残っていると、その経路だけ
 * `@hono/standard-validator` の既定の 400（`{ data: <本文そのもの>, error, success: false }`）
 * に落ちる——`whereValidationFailed` の doc に書いた実測そのものである。
 * ここへ集約すれば、「付け忘れ」という状態そのものを作れない。
 *
 * 既定の `onInvalid` は `{ error: '入力の形が不正: <path>' }` を返す。**個別の
 * 文言や `detail` のような追加のフィールドが要る経路（`PUT /profile` など）だけ
 * `onInvalid` を上書きする。** どちらの形でも、混ぜてよいのは `where`
 * （issue の `path` を畳んだもの）だけで、送られてきた値は1文字も混ぜない
 * （`whereValidationFailed` の不変条件をそのまま受け継ぐ）。
 */
function jsonBody<Schema extends z.ZodTypeAny>(
  schema: Schema,
  onInvalid: (where: string) => Record<string, unknown> = (where) => ({
    error: '入力の形が不正' + (where === '' ? '' : `: ${where}`),
  }),
) {
  return validator('json', schema, (result, c) => {
    if (result.success) return;
    return c.json(onInvalid(whereValidationFailed(result.error)), 400);
  });
}

/**
 * `validator('query', schema)` を常にこの形で呼ぶための薄いラッパー（`jsonBody`
 * と対になる。HTTP 側の数値クエリ引数の検査を揃える PR）。**`app.ts` の中で
 * `validator('query', ...)` を直接書かないこと。**
 *
 * `jsonBody` は issue #424 で全 `json` 経路に `hook` を配ったが、**クエリの
 * 10経路（`GET /conversations` 等）は当時 `hook` を渡していないまま残っていた。**
 * `hook` を渡さない `validator('query', ...)` は `@hono/standard-validator` の
 * 既定の 400（`{ data: <クエリそのもの>, error: <zod の issue 配列（英語）>,
 * success: false }`）に落ちる——`whereValidationFailed` の doc に書いた実測と
 * 同じ形。`GET /journal?limit=0` のような数値の範囲外の値を渡すと、この既定の
 * 400 がそのまま返っていた。
 *
 * 既定の `onInvalid` は `jsonBody` と同じ形 `{ error: '入力の形が不正: <path>' }`
 * を返す。**個別の文言が要る経路はいまのところ無い**（10経路とも既定でよい）。
 * どちらの形でも、混ぜてよいのは `where`（issue の `path` を畳んだもの）だけで、
 * 送られてきた値は1文字も混ぜない（`whereValidationFailed` の不変条件をそのまま
 * 受け継ぐ）。
 */
function queryParams<Schema extends z.ZodTypeAny>(
  schema: Schema,
  onInvalid: (where: string) => Record<string, unknown> = (where) => ({
    error: '入力の形が不正' + (where === '' ? '' : `: ${where}`),
  }),
) {
  return validator('query', schema, (result, c) => {
    if (result.success) return;
    return c.json(onInvalid(whereValidationFailed(result.error)), 400);
  });
}

/**
 * 一覧・詳細で返すマネージャー（状態に、確認へ上がらず止められた件数を**添える**）。
 *
 * **2つの出どころを外向きの面でだけ合流させる。** 状態は台帳から作った
 * `ManagerSummary`、拒否はデーモンのプロセス内にしか無い像で、`denials()` という
 * 別の口から読む（`ManagerPool`）。core の interface へ混ぜないのは、台帳へ持ち
 * 越さない設計をそのまま保つためである（器を作り直せば数え直しになる）。
 *
 * **拒否が無いときはキーごと載せない。** 常に `[]` を載せると「0 件だった」と
 * 読めるが、デーモンから見えているのは「この器では数えていない」でもありうる。
 * `manager_list` が拒否ゼロの行に何も足さないのと同じ扱いにする。
 */
function managerView(managers: ManagerPool, summary: ManagerSummary) {
  const denials = managers.denials(summary.managerId);
  return {
    ...summary,
    ...(denials.length === 0 ? {} : { denials }),
    // 取れなければ欄ごと載せない（クローンの道具と同じ読み方。既定の帯で埋めない）。
    ...managerModelsOf(managers, summary),
  };
}

/** 一覧・詳細で返すアカウント（identity を畳んで、秘密は載せない）。 */
/**
 * **誰がこの操作をしたか。** `grantedBy`（正本）と日誌の `grounds`（読み物）の
 * 両方を、ここ1箇所から導く。
 *
 * **2026-09-06 の同格化まで、`/access/*` は `requireOperator` を通っていた**ので
 * 「叩いた者＝実行環境の持ち主」が保証されており、固定の `'operator'` を書いても
 * 事実として正しかった。**同格化でその保証が消えたのに固定値が残っていた**ので、
 * 許可されたアカウントが叩いても「実行環境の持ち主による操作」と記録されていた。
 *
 * **`grantedBy` は「誰が許可したか」を持つ欄である。** そこが常に同じ値なら、
 * この欄は情報を1ビットも運ばない——「事後に追えることが『最終承認』の実体で
 * ある」（PRD「可観測性」）が、記録の側から崩れる。
 *
 * **2つに分けてあるのは、正本と読み物で要るものが違うからである。**
 * `grantedBy` は後から突き合わせる値なので id だけを入れる。`grounds` は人間が
 * 読む文なので、どちらの資格で叩いたかが文として分かる形にする。
 */
function actorOf(principal: Principal): string {
  if (principal.kind === 'operator') return 'operator';
  if (principal.kind === 'integration') return `integration:${principal.keyId}`;
  return principal.account.id;
}

/** `GET /mcp-servers` の本文（409 の `current` も同じ形）。置かれていなくても版は付く。 */
function mcpServersReadBody(stored: StoredMcpServers | null): {
  mcpServers: McpServers;
  updatedAt?: string;
  version: string;
} {
  return {
    mcpServers: stored?.mcpServers ?? {},
    ...(stored === null ? {} : { updatedAt: stored.updatedAt }),
    version: mcpServersVersionOf(stored),
  };
}

/** 日誌の `grounds` に載せる、人間が読む形の「誰が」。 */
function describeActor(principal: Principal): string {
  if (principal.kind === 'operator') return '実行環境の持ち主による操作';
  // 連携の鍵（鍵の値は書かない。id と名前だけ）。管理の口へは入れない（既定で拒否）ので日誌の行為者には
  // 通常ならないが、`Principal` を網羅するために持つ。
  if (principal.kind === 'integration') {
    return `連携の鍵「${principal.name}」（${principal.keyId}）による操作`;
  }
  return `許可されたアカウント（${principal.account.id}）による操作`;
}

/** `StoredPlugin.installedBy` に入れる識別子（鍵の値は含めない）。 */
function installerOf(principal: Principal): string {
  if (principal.kind === 'operator') return 'operator';
  if (principal.kind === 'integration') return `integration:${principal.keyId}`;
  return `account:${principal.account.id}`;
}

/** plugin の取り元の1行（URL・path・marketplace 名・SHA。資格は入らない）。 */
function describePluginSource(source: {
  kind: string;
  url: string;
  path?: string | undefined;
  sha: string;
  marketplace?: string | undefined;
  plugin?: string | undefined;
}): string {
  const where = `${source.url}${source.path === undefined ? '' : `（path: ${source.path}）`}`;
  return source.kind === 'marketplace'
    ? `marketplace ${source.marketplace ?? '?'} の ${source.plugin ?? '?'}（${where}）、SHA ${source.sha}`
    : `${where}、SHA ${source.sha}`;
}

/**
 * 保存・削除の後に runner へ配る。**配布が投げても、保存は済んでいるので失敗にしない**
 * （応答に失敗として載せる。失敗した runner へは名乗り直しで降ろし直す）。
 */
async function applyPlugins(deps: {
  pluginDistribution?: PluginDistributionService | undefined;
}): Promise<ApplyPluginsResult> {
  if (deps.pluginDistribution === undefined) return { names: [], runners: [] };
  try {
    return await deps.pluginDistribution.apply();
  } catch (error) {
    return { names: [], runners: [{ runnerId: 'daemon', ok: false, error: reasonOf(error) }] };
  }
}

/** runner への配布結果を日誌の1文にする（名前と成否だけ）。 */
function describePluginDelivery(runners: ApplyPluginsResult['runners']): string {
  const text = runners
    .map(
      (r) =>
        `${r.runnerId}=${r.ok ? 'ok' : r.unsupported === true ? '口なし（古い runner）' : '失敗'}`,
    )
    .join(', ');
  return text.length === 0 ? '配る先なし' : text;
}

/**
 * `PUT /tokens` の差分を日誌の1文にする（issue #2742）。**id・ラベル・操作の種類だけで、
 * トークンの値も指紋も書かない**（`TokenPoolChange` が値を持たない作り）。
 */
function describeTokenPoolChanges(changes: readonly TokenPoolChange[]): string {
  const names = {
    add: '追加',
    remove: '削除',
    disable: '無効化',
    enable: '有効化',
    rename: '改名',
  };
  return changes
    .map((change) => {
      const kind =
        change.operation === 'switch'
          ? change.reason === 'value'
            ? '切替（値の差し替え）'
            : '切替（試す順の入れ替え）'
          : names[change.operation];
      return `${kind}: ${change.label}（id: ${change.id}）`;
    })
    .join('、');
}

/** `PUT /tokens/policy` の差分を日誌の1文にする（issue #2742）。値は契機の名前と冷却のミリ秒だけ。 */
function describeTokenPolicyChanges(changes: readonly TokenPolicyChange[]): string {
  return changes
    .map((change) => `${change.field}: ${change.from ?? '読めなかった'} → ${change.to}`)
    .join('、');
}

/**
 * 状態を変える操作の後に日誌へ書き、落ちたら跡だけ残して握る（Issue #2037）。
 *
 * **なぜ握るか。** ここへ来る時点で、対応する状態変更（許可の取り消し・
 * アーカイブ本文の削除など）は既に成功して効いている。日誌への追記だけが
 * 失敗したとして `.onError` へ抜け 500 を返すと、呼び出し側は「操作そのものが
 * 失敗した」と誤読する——実際には操作は効いていて、欠けるのは「誰が・いつ
 * 行ったか」の監査の行だけである。跡は `noteDroppedRecord` で stderr へ残す。
 *
 * **`detail` に本文（`decision` の理由文・rule 文字列など）を入れないこと**
 * （`dropped-record.ts` の `noteDroppedRecord` の doc「本文は出さない」と
 * 同じ理由）。id や件数など、本文を含まない見分けだけにする。
 *
 * **pg のトランザクションで束ねる案は採らない。** fs ストアでは状態変更と
 * 日誌への追記を1操作にできず、束ねても常にどちらか片側だけが効く形が
 * 残る（Issue #2037 の「直し方の案」）。
 *
 * **戻り値は「実際に書けた行」（書けなければ `undefined`）。** ほとんどの
 * 呼び出し元は戻り値を見ない（書けたかどうかに関わらず、以後の処理は無い）。
 * 例外は `PUT /memory/:slug`——書けた行の `at` を `markHumanTouched` へ渡す
 * 必要があり、そこだけ `undefined` を見て後続処理を分岐する
 * （`PersonaStore.markHumanTouched` の doc「新しい真実ではない。実体は
 * 日誌にある」——日誌に行が無いのに派生値だけ立てると、その doc が
 * 保証する対応が崩れる）。
 *
 * **どの口に当てているか（2026-09-29 時点）。** `/permission-grants/:id/revoke` ・
 * `DELETE /archive/:id` ・ `POST /archive/remove` の一括 tombstone（最初の3経路。
 * Issue #2037 本体）に加え、`/memory/:slug`（PUT・DELETE）・`/practices/:slug`
 * （PUT・DELETE の両分岐）・`/schedule/:kind`（DELETE）・
 * `/commitments`（POST）・`/commitments/:id/close`・
 * `/commitments/:id`（PATCH）・`/inbox/remove`（POST、
 * 塊ごと）・`/reset`（POST）・`/access/:accountId/revoke`・
 * `/access/:accountId/owner/revoke`（issue #2043。狭める側はここまでと同じ
 * 「状態変更はもう効いている」型）。
 *
 * **能力を広げる口は、状態変更の後にこの関数を当てない（issue #2043・
 * #2123）。** 広げる側で状態変更の後に日誌が落ちると、記録の無い変更が
 * 生まれる——`grant` の注記が言う「上限を外した 2026-09-09 以降、ここが
 * 唯一の歯止めである」がそのまま効く場所である。だから**日誌を先に書き、
 * 書けなければ状態を変えずに 500** にする（`stores.journal.append` を直に
 * 呼び、投げたら `base.onError` へ抜けるに任せる）。状態変更が投げたら、
 * 打ち消しの行（「〜できなかった: …」の形）をこの関数で足してから同じ
 * エラー応答を返す——打ち消しが落ちても、実際の変更はどのみち変わって
 * いない（記録が多すぎる側の穴で、記録の無い変更より安全側と判断した）。
 * **状態変更の後でないと分からない情報**（`editRequest` の戻り値・runner
 * への配布結果・差し替えた鍵の指紋など）**は、先に書く行に含めず、
 * 後で分かる分を2行目としてこの関数で（best-effort に）足す。**
 * 対象: `/access/:accountId/grant`・`/access/:accountId/owner`（issue #2043）・
 * `POST /schedule`・`PUT /mcp-servers`・`PUT /credentials`・`PUT /profile`
 * （issue #2123。teto の判断——#2067 がこの4口を「状態変更はもう効いている」
 * 型のまま `appendJournalOrDrop` を当てていたが、能力を広げる口はそちら
 * ではなく閉じる側に倒す）・`POST /runners/credentials`（issue #2198。登録
 * されている全 runner へ鍵を配る口で、以前は日誌を1行も書いていなかった）。
 * `PUT /tokens`・`PUT /tokens/policy`（issue #2742。決定 2026-10-05、teto＝takecchi の代理。
 * 以前は日誌を書いていなかった。**能力の向きで分ける**——広げる側は日誌先、狭める側
 * （削除・無効化・改名・`rotateOn: off`）は保存先で、日誌は後にこの関数で書く）。
 * **`PUT /credentials`・`PUT /profile` は検証と実際の状態変更が同じ1呼び
 * （`apply`）の中にあり分けられないので、検証で断られた回も同じ「打ち消し」
 * の扱いにする**（同じ理由——記録が多すぎる側を選ぶ）。
 */
async function appendJournalOrDrop(
  stores: Stores,
  entry: JournalEntryInput,
  what: string,
  detail: string,
): Promise<JournalEntry | undefined> {
  try {
    return await stores.journal.append(entry);
  } catch (error) {
    noteDroppedRecord(what, detail, error);
    return undefined;
  }
}

/** 日誌が書けず、状態を変えずに断った 500 の本文（`journalWriteFailedResponseSchema`）。 */
function journalWriteFailedBody(): { error: string; code: typeof JOURNAL_WRITE_FAILED_CODE } {
  return { error: JOURNAL_WRITE_FAILED_MESSAGE, code: JOURNAL_WRITE_FAILED_CODE };
}

/**
 * 読めない行を id で指して消す口（`POST /permission-grants/unreadable/remove`・
 * `POST /access/unreadable/remove`。issue #2440）の共通の運び。トークンの口
 * （`POST /tokens/unreadable/remove`。#2354）と同じ作法。
 *
 * - **日誌を先に書き、書けなければ状態を変えずに投げ直す**（`base.onError` の 500）。
 *   日誌に残すのは消す id と件数だけで、行の中身（許可の本文・アカウントの email など）は書かない。
 * - 指した id が読めない行に1つでも無ければ、何も消さず日誌も書かずに `unknown`（件数だけ。
 *   指された文字列は返さない）。
 * - 日誌は書いたが消せなかったときは、打ち消しの行を足して `failed`（呼び手が理由の無い 500 を返す）。
 *   **例外の本文は日誌にも応答にも載せない**（種類 `name` だけ。`kindOfError`）。
 */
async function removeUnreadableRowsWithJournal(params: {
  stores: Stores;
  /** 日誌の文言に入れる対象の名前（「許可の記録」「アカウント」）。 */
  subject: string;
  /** 日誌の `grounds` に載せる「誰が」（`describeActor`）。 */
  actor: string;
  /** 日誌の `grounds` に載せる口の名前（`POST /…/unreadable/remove`）。 */
  route: string;
  requested: readonly string[];
  remove: (
    ids: readonly string[],
    options: RemoveUnreadableRowsOptions,
  ) => Promise<RemoveUnreadableRowsResult>;
}): Promise<RemoveUnreadableRowsResult | { kind: 'failed' }> {
  const { stores, subject, actor, route } = params;
  // 閉じ込めで代入するので、`let` ではなく入れ物にする（型の絞り込みが `never` に倒れない）。
  const written: { detail?: string } = {};
  let result: RemoveUnreadableRowsResult;
  try {
    result = await params.remove(params.requested, {
      // **日誌を先に書く。書けなければここで投げ、状態を変えずに `base.onError` へ抜ける。**
      beforeRemove: async (ids) => {
        await stores.journal.append({
          type: 'decision',
          decision: `読めない${subject}の行を ${String(ids.length)} 件消そうとしている（id: ${ids.join(', ')}）`,
          grounds: `${actor}（${route}）。消すのは id で指した読めない行だけ。行の中身は書かない。`,
        });
        // 書けた後にだけ印を立てる（書けなかった回は「日誌が無い」＝打ち消す行も要らない）。
        written.detail = `ids=${ids.join(',')}`;
      },
    });
  } catch (error) {
    // 日誌が書けなかった（`beforeRemove` の中で投げた）回は、状態を変えていない。
    const journaled = written.detail;
    if (journaled === undefined) throw error;
    // 日誌は書いたが消せなかった。打ち消しの行を足す（`PUT /credentials` と同じ形）。
    await appendJournalOrDrop(
      stores,
      {
        type: 'decision',
        decision: `読めない${subject}の行を消せなかった`,
        grounds: `${actor}（${route}、状態の変更が失敗: ${kindOfError(error)}）。${journaled}`,
      },
      `読めない${subject}の行の打ち消しの日誌`,
      journaled,
    );
    noteDroppedRecord(`読めない${subject}の行の削除`, journaled, error);
    return { kind: 'failed' };
  }
  // 日誌を書いた後で、ストアが「読めない行に無い」に倒れた（pg は日誌をトランザクションの外で
  // 書くので、日誌と `for update` の再確認のあいだに行が変わりうる）。何も消していないので、
  // 「消そうとしている」の行を打ち消しておく。日誌を書く前の `unknown` は日誌が無いので要らない。
  if (result.kind === 'unknown' && written.detail !== undefined) {
    await appendJournalOrDrop(
      stores,
      {
        type: 'decision',
        decision: `読めない${subject}の行を消さなかった`,
        grounds: `${actor}（${route}、日誌の後の再確認で ${String(result.count)} 件が読めない行に無かった。何も消していない）。${written.detail}`,
      },
      `読めない${subject}の行の打ち消しの日誌`,
      written.detail,
    );
  }
  return result;
}

/**
 * error の**種類（`name`）だけ**を文字列にする（issue #2396）。トークンの口が
 * `noteDroppedRecord` や日誌へ渡す原因に使う。`message` は含めない——ストアのエラー文には
 * 行の中身（トークンの値）が載りうる。
 */
function kindOfError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * 鍵を runner へ配る呼び出し（`POST /runners/credentials`）の失敗を、**値の出ない
 * 短い文**にする（issue #2407）。応答と日誌へ載せるのはこれだけである。
 *
 * **`message` は使わない。`reasonOf`（1行目を出す）も使わない。** 鍵を運ぶ呼び出し
 * なので、例外の文面に送った値が載る形（`RunnerHttpError` は runner や間の中継の
 * 応答本文をそのまま `message` に入れる。RPC / 検証系の例外が入力を添える形も同じ）
 * があれば、1行目の断片でも鍵が出る。出すのは次の2つだけ:
 *
 * - `error.name`（クラス名）。識別子の形（英数字と `_`・`.`）でなければ `Error` に
 *   落とす——名前を後から書き換えられる例外でも、任意の文字列は通さない
 * - `RunnerHttpError` の `status`（数値。本文ではない）
 *
 * `PUT /tokens` の `kindOfError`（#2396）と同じ考えで、こちらは HTTP の状態を足して
 * 「runner が拒んだ（4xx）か、落ちていた（5xx）か」を人が追えるようにしてある。
 */
function credentialDeliveryFailureOf(error: unknown): string {
  const name =
    error instanceof Error && /^[A-Za-z0-9_.]{1,64}$/u.test(error.name) ? error.name : 'Error';
  const status =
    error instanceof RunnerHttpError && Number.isInteger(error.status)
      ? `、HTTP ${String(error.status)}`
      : '';
  return `${name}${status}`;
}

/**
 * `Principal`（`auth.ts`）を `Clone#answerApproval` の `via`
 * （`AnswerApprovalVia`、`@alteroid/core`）へ変換する（Issue #863、#1479）。
 *
 * **`packages/core` は `apps/daemon` の `Principal` を知らない**（層が逆）ので、
 * この変換をここに置く——`/approvals/answer` と `/approvals/:id/answer` の
 * 両方から呼ぶ。渡し忘れると `answerApproval` は `via: undefined` を受け取り、
 * 既定（記録しない）へ倒れる。
 *
 * **`operator` の `auth`（`'disabled' | 'operator-token'`）はそのまま運ぶ。**
 * `authenticate` の中でどちらの枝を通ったかが確定しているので、ここで判定し
 * 直さない。
 */
function answerApprovalViaOf(principal: Principal): AnswerApprovalVia {
  if (principal.kind === 'integration') {
    // 連携の鍵は承認の口へ入れない（`authenticate` が既定で拒否する）。人間が答えた証拠にはならない。
    throw new Error('連携の鍵は承認に答えられない');
  }
  return principal.kind === 'operator'
    ? { kind: 'operator', auth: principal.auth }
    : { kind: 'account', accountId: principal.account.id };
}

async function accountView(
  stores: Stores,
  account: AuthAccount,
): Promise<
  AuthAccount & {
    granted: boolean;
    identities: {
      provider: string;
      subject: string;
      email: string | null;
      emailVerified: boolean;
      lastLoginAt: string;
    }[];
  }
> {
  const identities = await stores.auth.listIdentities(account.id);
  return {
    ...account,
    granted: isAccountGranted(account),
    identities: identities.map(({ provider, subject, email, emailVerified, lastLoginAt }) => ({
      provider,
      subject,
      email,
      emailVerified,
      lastLoginAt,
    })),
  };
}

/**
 * ブラウザに返す終了画面。**ここで alteroid を操作させない**（Web UI は非ゴール）。
 *
 * `autoClose` は成功時のみ立てる。`window.open()` で `noopener=no`（Web UI の
 * `openAuthorization`）で開いたポップアップなら `opener` が残るので閉じられるが、
 * ポップアップが塞がれて**同じタブごと**遷移していた場合は `opener` が無く、
 * `window.close()` は黙って何もしない（例外にならない）——その場合は下の
 * メッセージ「閉じて端末に戻る」がそのままフォールバックとして機能する。
 * だから成否をここで判定する必要はない。
 */
function callbackPage(title: string, detail: string, autoClose = false): string {
  const escape = (value: string) =>
    value.replace(/[&<>"]/g, (ch) =>
      ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;',
    );
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>alteroid</title>
<style>
 body{font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;
      display:grid;place-items:center;min-height:100vh;margin:0;color:#1a1a1a;background:#fafafa}
 main{max-width:32rem;padding:2rem;text-align:center}
 h1{font-size:1.25rem;margin:0 0 .75rem}
 p{margin:0;color:#555;line-height:1.7}
</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(detail)}</p></main></body>${
    autoClose ? '<script>window.close()</script>' : ''
  }</html>`;
}

/**
 * `GET /profile` の応答の組み立て。**行（本文つき）・クローン用と runner 用の合成後の
 * 指紋**と、互換の旧欄（deprecated。古い CLI と Web が読む）。
 */
function describeProfileEntries(entries: readonly EnvProfileEntry[]) {
  const all = composeProfileScript(entries, 'all');
  const newest = entries.reduce<string | undefined>(
    (latest, entry) =>
      latest === undefined || entry.updatedAt > latest ? entry.updatedAt : latest,
    undefined,
  );
  return {
    entries: entries.map((entry) => ({
      ...entry,
      sha256: fingerprintOf(entry.script),
      bytes: Buffer.byteLength(entry.script),
    })),
    ...composedFingerprints(entries),
    script: all,
    ...(newest === undefined ? {} : { updatedAt: newest }),
    ...(all.length === 0 ? {} : { sha256: fingerprintOf(all), bytes: Buffer.byteLength(all) }),
  };
}

/**
 * **プロファイルを書き換える口（`PUT /profile` / `PUT /profile/:name` /
 * `DELETE /profile/:name`）が通る1本道。** 経路が3本あること自体が穴になる
 * （片方だけに検査や日誌が入って、人間が置くと弾かれるのにクローンが置くと通る、が
 * 生まれる）ので、日誌・失敗の打ち消し・伏せ・応答の形はここ1か所に置く。
 *
 * - **日誌を先に書く（issue #2123）。書けなければ差し替えずに 500。**
 *   配布結果は差し替えた後でないと分からないので、先に書く行はそれを含まない。
 *   後で分かる分は2行目として `appendJournalOrDrop`（best-effort）で足す
 * - 評価で断られた（`!result.stored`）・投げた、どちらも打ち消しの行を足してから
 *   今と同じエラー応答にする。**シェルの stderr は構文エラーで入力の行を引用し、
 *   `set -x` は値ごと吐く（issue #2429）ので、伏せてから返す**（`redactProfileFailure`）
 * - 値は日誌に1文字も書かない（鍵が入りうる）
 */
async function mutateProfile(
  deps: AppDeps,
  spec: {
    actor: string;
    route: string;
    /** 行の名前など。**省略（旧来の全部差し替え）は1本の時代と同じ文言**で日誌に書く。 */
    subject?: string;
    run: (profile: ProfileService) => Promise<ApplyProfileResult>;
  },
): Promise<
  | { ok: true; body: ReturnType<typeof profileUpdateResponseSchema.parse> }
  | {
      ok: false;
      body: {
        error: string;
        detail: string;
      };
    }
> {
  if (deps.profile === undefined) {
    return { ok: false, body: { error: 'プロファイルの器が無い', detail: '' } };
  }
  const label = spec.subject === undefined ? '' : `（${spec.subject}）`;
  await deps.stores.journal.append({
    type: 'decision',
    decision: `実行環境プロファイルを差し替えようとしている${label}`,
    grounds: `${spec.actor}（${spec.route}）。値は書かない（鍵が入りうる）。`,
  });

  let result: ApplyProfileResult;
  try {
    result = await spec.run(deps.profile);
  } catch (error) {
    // 日誌には「差し替えようとしている」が残っているので、打ち消す
    // （grant の「アクセス許可付与の打ち消しの日誌」と同じ形）。
    await appendJournalOrDrop(
      deps.stores,
      {
        type: 'decision',
        // issue #2163: 反映も書き戻しも落ちたときは「差し替えられなかった」
        // ではなく状態どおりの行にする（正本は新版のまま・クローンは前の
        // 版）。**文言では見分けない**——`ProfileRollbackFailedError` で見る。
        decision:
          error instanceof ProfileRollbackFailedError
            ? `実行環境プロファイルの差し替えが途中で止まった（正本は新しい版のまま・クローンは前の版）${label}`
            : `実行環境プロファイルを差し替えられなかった${label}`,
        grounds: `${spec.actor}（${spec.route}、状態の変更が失敗）: ${kindOfError(error)}`,
      },
      '実行環境プロファイルの打ち消しの日誌',
      spec.route,
    );
    // **置けない入力（名前の形・大文字小文字の衝突など）は 400。** 何も変えていない。
    // `detail` に載せるのは**こちらが組んだ文**だけで、送られてきた本文は載せない。
    if (error instanceof ProfileInputError) {
      return {
        ok: false,
        body: { error: 'プロファイルの入力が不正（保存していない）', detail: error.message },
      };
    }
    // **鍵（行の名前）・環境変数になる値（script）の NUL も 400**（issue #2927。teto の判断、2026-10-05）。
    // 文は欄名と固定の説明だけで、値を載せない。
    if (error instanceof NulNotAllowedError) {
      return {
        ok: false,
        body: { error: 'プロファイルの入力が不正（保存していない）', detail: error.message },
      };
    }
    throw error;
  }

  if (!result.stored) {
    /**
     * **読めなかったのはシステムの結果であって判断ではない。** 保存も配布もしていない
     * ——構造的に `ProfileService` が評価で断ったときはここへ来て、正本には一度も
     * 進んでいない。**それでも打ち消しの行を足す**（記録が多すぎる側の穴で、記録の
     * 無い差し替えより安全側と判断した。teto の判断）。
     */
    await appendJournalOrDrop(
      deps.stores,
      {
        type: 'decision',
        decision: `実行環境プロファイルを差し替えられなかった（読めなかった）${label}`,
        grounds: `${spec.actor}（${spec.route}、評価で断られた）`,
      },
      '実行環境プロファイルの打ち消しの日誌',
      spec.route,
    );
    const failure = redactProfileFailure(result.clone, process.env);
    return {
      ok: false,
      body: {
        error: 'プロファイルが読めなかったので保存していない',
        detail: [failure.error, failure.output].join('\n').trim(),
      },
    };
  }

  /**
   * **差し替えた事実と配布の成否を日誌へ残す（値は1文字も書かない。Issue #1733）。**
   * `PUT /mcp-servers` と同じ形（名前と成否だけの配布結果）で残す。「誰が・どの口から」を
   * `describeActor` で補う。差し替え自体はもう効いている——後で分かった結果を2行目として
   * 足す（落ちても 500 にしない。`appendJournalOrDrop` の doc）。
   */
  const entries = result.entries ?? [];
  const composed = result.composed ?? composedFingerprints(entries);
  const allScript = composeProfileScript(entries, 'all');
  const allFingerprint =
    allScript.length === 0
      ? {}
      : { sha256: fingerprintOf(allScript), bytes: Buffer.byteLength(allScript) };
  const delivered = result.runners.map((r) => `${r.runnerId}=${r.ok ? 'ok' : '失敗'}`).join(', ');
  await appendJournalOrDrop(
    deps.stores,
    {
      type: 'decision',
      decision:
        spec.subject === undefined
          ? // 旧来の全部差し替え: 1本の時代と同じ文言（日誌を読む側と歯がこの文言で見ている）。
            allFingerprint.sha256 === undefined
            ? '実行環境プロファイルを外した'
            : `実行環境プロファイルを更新した（sha256 ${allFingerprint.sha256}・${String(allFingerprint.bytes)} bytes）`
          : `実行環境プロファイル（${spec.subject}）を更新した（クローン用 sha256 ${composed.clone.sha256 ?? 'なし'}・runner 用 sha256 ${composed.runner.sha256 ?? 'なし'}）`,
      grounds:
        `${spec.actor}（${spec.route}）。` +
        '値は書かない（鍵が入りうる）。クローンの次のセッションから効く。' +
        `runner への配布: ${delivered.length === 0 ? '配る先なし' : delivered}` +
        '（マネージャー・作業者には次に開くセッションから効く）。',
    },
    '実行環境プロファイルの日誌',
    spec.route,
  );

  const described = describeProfileEntries(entries);
  return {
    ok: true,
    body: profileUpdateResponseSchema.parse({
      updatedAt: result.updatedAt ?? new Date().toISOString(),
      entries: described.entries.map((entry) => ({
        name: entry.name,
        scope: entry.scope,
        updatedAt: entry.updatedAt,
        sha256: entry.sha256,
        bytes: entry.bytes,
      })),
      composed,
      ...(described.sha256 === undefined
        ? {}
        : { sha256: described.sha256, bytes: described.bytes as number }),
      // 成功でも `set -x` の出力（値入り）は `output` に載る（issue #2429）。
      clone:
        result.clone.output === undefined
          ? result.clone
          : {
              ...result.clone,
              output: redactProfileFailure({ output: result.clone.output }, process.env).output,
            },
      runners: result.runners,
    }),
  };
}

/**
 * runner を1回叩いて、**叩けたかどうかごと**返す。
 *
 * **戻り値を1つの値に畳まない。** `credentials` / `profile` は「空」と
 * 「聞けなかった」が同じ形になりやすく、実際に `GET /runners` はそこを潰していた。
 * ここで `*Probe` を必ず一緒に組み立てるので、**片方だけ足して片方を忘れる**形に
 * ならない（呼ぶ側は展開するだけで、判断を省略できない）。
 *
 * **理由は `reasonOf` を通す。** 例外は失敗した呼び出しのパラメータを添えて
 * くることがあるので、素の `String(error)` を応答へ載せない
 * （`dropped-record.ts` の `reasonOf` の doc）。
 */
async function probe(
  runner: RunnerClient | undefined,
  kind: 'credentials' | 'profile',
): Promise<Record<string, unknown>> {
  const key = kind === 'credentials' ? 'credentialsProbe' : 'profileProbe';
  const empty = kind === 'credentials' ? { credentials: [] } : {};
  if (runner === undefined) return { ...empty, [key]: { status: 'unheard' } };
  try {
    if (kind === 'credentials') {
      return { credentials: await runner.credentials(), credentialsProbe: { status: 'asked' } };
    }
    const value = await runner.profile();
    return {
      ...(value === undefined ? {} : { profile: value }),
      profileProbe: { status: 'asked' },
    };
  } catch (error) {
    return { ...empty, [key]: { status: 'failed', error: reasonOf(error) } };
  }
}

export function createApp(deps: AppDeps) {
  const { clone, stores } = deps;
  const sseHeartbeatMs = deps.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  const attachmentLimits = deps.attachmentLimits ?? readAttachmentLimits().limits;
  /** `POST /attachments` の本文の上限。1つぶんの最大値（画像と、それ以外のファイルの大きいほう）。 */
  const attachmentBodyMax = Math.max(attachmentLimits.maxImageBytes, attachmentLimits.maxFileBytes);

  /**
   * **`POST /chat` の冪等（Issue #3203）。** 受け取った `clientMessageId` と、その会話の id。
   * 受信箱へ積んでから日誌へ載るまでの短い窓と、同時に届いた2本の再送を、日誌を引かずに止める。
   * **日誌を引く側（`findReceivedClientMessage`）が耐久の本体**で、こちらは取りこぼしの窓を塞ぐだけ。
   * プロセスが落ちれば消える（日誌に載った分は日誌が覚えている）。古いものから捨てる上限つき。
   */
  const receivedClientMessages = new Map<string, ReceivedClientMessage>();
  const RECEIVED_CLIENT_MESSAGES_MAX = 2048;
  /** 受け取り済みの `clientMessageId` の、会話の id と発言の中身の指紋（`clientMessageFingerprint`）。 */
  interface ReceivedClientMessage {
    readonly conversationId: string;
    readonly fingerprint: string;
    /**
     * 添付の検査が終わるまで入っている（Issue #3244）。`true` で受け取り済みが確定、`false` で検査に落ちて
     * 取り下げられた（覚えていないのと同じ）。日誌から引いた分は付かない（日誌にあれば確定している）。
     */
    readonly settled?: Promise<boolean>;
  }

  /**
   * 重複と判定した再送への応え（Issue #3243）。別の会話なら 409 `client_message_id_conflict`、同じ会話で
   * 中身が違えば 409 `client_message_id_mismatch`、同じなら `undefined`（= 呼び手が `replayReceivedMessage`）。
   * **別の会話の判定が先**——会話が違えば、中身を比べても意味がない。
   */
  function rejectDuplicateClientMessage(
    c: Context<{ Variables: AuthVariables }>,
    received: ReceivedClientMessage,
    clientMessageId: string,
    request: { conversationId: string | undefined; fingerprint: string },
  ) {
    if (
      request.conversationId !== undefined &&
      request.conversationId !== received.conversationId
    ) {
      return c.json(
        {
          error: `clientMessageId ${clientMessageId} は別の会話の発言として受け取り済み` as const,
          code: 'client_message_id_conflict' as const,
        },
        409,
      );
    }
    if (request.fingerprint !== received.fingerprint) {
      return c.json(
        {
          error:
            `clientMessageId ${clientMessageId} は中身（本文・添付・supersedes）の違う発言として受け取り済み` as const,
          code: 'client_message_id_mismatch' as const,
        },
        409,
      );
    }
    return undefined;
  }
  /** 日誌から探すときに遡る、人間との往復の件数。再送は直後に来るので、直近だけでよい。 */
  const CLIENT_MESSAGE_LOOKUP_SCAN = 200;

  /**
   * `POST /chat` がこのプロセスで振った会話 id（Issue #4149）。
   *
   * 渡された `conversationId` は日誌（人間との往復）に在る会話でなければ断るが、新しい会話の1通目は
   * `open` で id を返した後に日誌へ載る（`clone.post` は器への書き込みを待たない）。日誌だけで判定すると、
   * `open` 直後の追送が「無い会話」として断られる。振った id を覚えておき、日誌に載る前でも受ける。
   * 上限を超えたら古いものから忘れる（忘れる頃には1通目は日誌に在る）。
   */
  const startedConversations = new Set<string>();
  const STARTED_CONVERSATIONS_MAX = 2048;
  function rememberStartedConversation(conversationId: string): void {
    startedConversations.add(conversationId);
    if (startedConversations.size > STARTED_CONVERSATIONS_MAX) {
      const oldest = startedConversations.values().next();
      if (oldest.done !== true) startedConversations.delete(oldest.value);
    }
  }

  /**
   * この `clientMessageId` を、もう受け取っているか。受け取っていれば、その会話の id を返す。
   * 先にメモリ（受け取った直後の窓）、無ければ日誌の直近（再起動をまたぐ）を引く。
   */
  async function findReceivedClientMessage(
    clientMessageId: string,
  ): Promise<ReceivedClientMessage | undefined> {
    const remembered = receivedClientMessages.get(clientMessageId);
    // 検査の途中の1本目は、終わるのを待つ。落ちたなら（取り下げられたなら）受け取っていないのと同じなので、
    // 日誌を引く（日誌にも無い）。
    if (remembered !== undefined && (await (remembered.settled ?? true))) return remembered;
    const recent = await readConversationWindow(stores.journal, {
      scan: CLIENT_MESSAGE_LOOKUP_SCAN,
    });
    for (const entry of recent) {
      if (
        entry.type === 'exchange' &&
        entry.role === 'inbound' &&
        entry.clientMessageId === clientMessageId &&
        entry.conversationId !== undefined
      ) {
        return {
          conversationId: entry.conversationId,
          // 日誌の本文は NUL を落として残してある。指紋の側が同じ規則を通すので、比べ方はずれない。
          fingerprint: clientMessageFingerprint({
            text: entry.text,
            attachmentIds: entry.attachments?.map((ref) => ref.id),
            supersedes: entry.supersedes,
          }),
        };
      }
    }
    return undefined;
  }

  /**
   * この `clientMessageId` を先取りする（Issue #3244）。**同期で呼ぶ**（`await` を挟まずに「無ければ入れる」を
   * 1歩にして、同時に届いた2本のうち片方だけが先に入れるようにする）。**添付の検査・結び付けより前に呼ぶ**——
   * 後に置くと、同時の2本が両方とも結び付けへ進み、片方が `attachment_conflict` の 400 になり、別の会話で
   * 受け取り済みの id（409）に添付だけが結び付くこともあった。
   *
   * - 取れたら `{ won: true, settle }`。呼び手は検査のあとに必ず `settle` を呼ぶ: 通れば `settle(true)`、
   *   落ちた（検査が 400・例外）なら `settle(false)`——**落ちた送信の id は覚えない**（#3208。直した再送を
   *   重複と読まない）。`settle(false)` は先に Map から外してから待っている側を起こす。
   * - 先に取られていれば `{ won: false, existing }`。
   */
  function claimClientMessage(
    clientMessageId: string,
    received: Omit<ReceivedClientMessage, 'settled'>,
  ):
    | { won: true; settle: (accepted: boolean) => void }
    | { won: false; existing: ReceivedClientMessage } {
    const existing = receivedClientMessages.get(clientMessageId);
    if (existing !== undefined) return { won: false, existing };
    let resolve: (accepted: boolean) => void = () => {};
    const settled = new Promise<boolean>((done) => {
      resolve = done;
    });
    const entry: ReceivedClientMessage = { ...received, settled };
    receivedClientMessages.set(clientMessageId, entry);
    if (receivedClientMessages.size > RECEIVED_CLIENT_MESSAGES_MAX) {
      const oldest = receivedClientMessages.keys().next();
      if (oldest.done !== true) receivedClientMessages.delete(oldest.value);
    }
    return {
      won: true,
      settle: (accepted) => {
        if (!accepted && receivedClientMessages.get(clientMessageId) === entry) {
          receivedClientMessages.delete(clientMessageId);
        }
        resolve(accepted);
      },
    };
  }

  /**
   * 受け取り済みの `clientMessageId` が再び届いたときの応え（Issue #3203）。**何も積まない。**
   * `GET /chat/:conversationId/stream` と同じ形で、`open`（`{conversationId, clientMessageId, duplicate: true}`）の後、
   * 進行中のターンがあれば途中経過から続きを流して `done` / `error` で閉じる。無ければ `open` だけで閉じる
   * （返事は `GET /conversations/:id` が持つ）。途中経過を持たない器（`clone.attach` が無い）は `open` だけ。
   */
  function replayReceivedMessage(
    c: Context<{ Variables: AuthVariables }>,
    conversationId: string,
    clientMessageId: string,
  ) {
    return streamSSE(c, async (stream) => {
      const pump = chatEventPump();
      const attached = clone.attach?.(conversationId, (event) => pump.push(event));
      if (attached === undefined || attached.inProgress === null) pump.finish();
      await pump.serve(
        stream,
        { principal: c.get('principal'), authorization: c.req.header('authorization') },
        attached?.unsubscribe ?? (() => {}),
        async () => {
          await stream.writeSSE({
            event: 'open',
            data: JSON.stringify({ conversationId, clientMessageId, duplicate: true }),
          });
          for (const event of attached?.inProgress ?? []) {
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          }
        },
      );
    });
  }

  /**
   * **外部イベントに添える添付を検証して結び付ける**（#3113 段3）。`clone.post` の**前**に呼び、`ok: false` なら
   * イベントを投函しない（添付を黙って落として本文だけ送る、をしない）。検査の本体は `POST /chat` と共通
   * （`checkAndBindAttachments`）。**連携の鍵のときだけ「同じ鍵が上げたもの」に絞る**
   * （`uploadedBy` が `integration:<keyId>` でなければ `attachment_forbidden`）。人間・operator は
   * `/chat` と同じで上げた主体を問わない。
   */
  function bindEventAttachments(
    attachmentIds: readonly string[] | undefined,
    eventId: string,
    principal: Principal,
  ): Promise<AttachmentBatchResult> {
    return checkAndBindAttachments(attachmentIds, {
      store: stores.attachments,
      limits: attachmentLimits,
      bind: (ids) => stores.attachments.bindToExternalEvent(ids, eventId),
      unbind: (ids) => stores.attachments.unbind(ids, { externalEventId: eventId }),
      isBoundElsewhere: (meta) => isAttachmentBound(meta),
      conflictMessage: 'すでに別の宛先に結び付いた添付は使えない',
      onlyUploadedBy: principal.kind === 'integration' ? uploaderOf(principal) : undefined,
      serializeKey: `externalEvent:${eventId}`,
    });
  }

  /**
   * `bindEventAttachments` で結んだ後の `clone.postPersisted`。**受信箱へ書けなかった（`'unavailable'`）ときも、
   * 投げたときも、結んだ添付を戻す。** 戻さないと、送り直し（新しい id）が `attachment_conflict` で断られ、
   * 死んだ id に結ばれた添付は未結び付けの掃除の対象からも外れて期限まで残る（503 は「送り直してよい」の約束）。
   * 戻すのはこの id に結んだ分だけ（`externalEventId` 指定）なので、ほかの宛先の結び付きには触れない。
   */
  async function postExternalPersisted(
    event: Parameters<CloneHost['postPersisted']>[0],
    refs: readonly { id: string }[],
  ): Promise<Awaited<ReturnType<CloneHost['postPersisted']>>> {
    const release = () =>
      refs.length === 0
        ? Promise.resolve()
        : stores.attachments.unbind(
            refs.map((ref) => ref.id),
            { externalEventId: event.id },
          );
    // 戻す処理の失敗を外へ投げない: 投げると 503 が 500 に化け、`postPersisted` の元の例外も unbind の例外に置き換わる。
    // 受信箱へ書けない原因と unbind が失敗する原因は同じ（ストレージの不調）ことが多く、約束が要るのはまさにその場面。
    const releaseQuietly = async () => {
      try {
        await release();
      } catch (releaseError) {
        process.stderr.write(
          `alteroidd: 外部イベント ${event.id} の添付 ${String(refs.length)} 件の結び付けを戻せなかった` +
            `（期限まで残る）: ${reasonOf(releaseError)}\n`,
        );
      }
    };
    let outcome;
    try {
      outcome = await clone.postPersisted(event);
    } catch (error) {
      await releaseQuietly();
      throw error;
    }
    if (outcome === 'unavailable') await releaseQuietly();
    return outcome;
  }

  // --- 稼働の地図 ---------------------------------------------------------
  // 線の活動は日誌の追記から数える。**日誌の流れが配線されていなければ線は空のまま**
  // （流れていないのではなく、観測していない）。購読はデーモンが起きている間ずっと
  // 続くので解除しない。
  const topologyActivity = createTopologyActivityTracker();
  if (deps.journalEvents !== undefined) topologyActivity.attach(deps.journalEvents.subscribe);
  if (deps.workerToolEvents !== undefined) {
    topologyActivity.attachWorkerTools(deps.workerToolEvents.subscribe);
  }
  const topologyStorage = createStorageHealthTracker({
    // 接続先・パスは載せない。器の種類だけ。
    label:
      deps.storage === undefined
        ? undefined
        : deps.storage.startsWith('PostgreSQL')
          ? 'postgres'
          : 'fs',
    probe: deps.storageProbe,
    now: Date.now,
  });
  // 起動時に1回聞き始める（待たない）。最初のスナップショットが `unknown` になりにくくする。
  topologyStorage.current();
  const topology = createTopologyService({
    clone,
    ...(deps.runners === undefined ? {} : { runners: deps.runners }),
    unreadableJobs: () => stores.jobs.listUnreadableJobs(),
    activity: topologyActivity,
    storage: topologyStorage,
    modelsOf: (summary) => managerModelsOf(clone.managers, summary),
    ...(deps.cloneModel === undefined ? {} : { cloneModel: deps.cloneModel }),
  });
  const topologyTickMs = deps.topologyTickMs ?? 2000;
  const topologyDebounceMs = deps.topologyDebounceMs ?? 200;

  const authPlan: AuthPlan = deps.auth?.plan ?? {
    enabled: false,
    providers: [],
    publicBaseUrl: '',
    tokenTtlDays: 30,
    description: '認証は無効（未設定）',
  };
  /** 連携の鍵の回数の窓（メモリ上。時計は `deps.now` と同じ）。 */
  const integrationClock = deps.now ?? (() => new Date());
  const integrationRateLimiter = createFixedWindowRateLimiter(() => integrationClock().getTime());
  /** 断った試みをデーモンのログへ（日誌には書かない）。**鍵の値は出さない**（id だけ）。 */
  function noteIntegrationRefusal(
    c: Context,
    status: 401 | 403 | 413 | 429,
    why: string,
    keyId?: string,
  ): void {
    process.stderr.write(
      `alteroid: 連携の鍵の要求を断った（${String(status)}、${why}）: ` +
        `${c.req.method} ${c.req.path}${keyId === undefined ? '' : ` keyId=${keyId}`}\n`,
    );
  }
  const authService: AuthService =
    deps.auth?.service ??
    createAuthService({
      store: stores.auth,
      providers: createAuthProviderRegistry(authPlan.providers),
      tokenTtlDays: authPlan.tokenTtlDays,
    });

  /**
   * **開いている SSE の資格を、心拍ごとに確かめ直す口（issue #1820）。**
   *
   * SSE（chat / journal）は、接続を張るときに1回だけ `authenticate` の中間層を通る。
   * 以前はその後トークンを見直さなかったので、ログアウト（`POST /auth/logout`）・
   * アカウントの許可の取り消し（`access revoke`）・期限切れの後も、すでに開いている
   * 流れはそのまま流れ続けた。ここは、心拍（`startSseHeartbeat`）の1拍ごとに、
   * 接続を張ったときの bearer を `authenticate` と同じ判定（使えるか・許可があるか）に
   * かけ直し、駄目なら `lost` を立てる。流れの側は、次にループが回ったときに閉じる。
   *
   * - **operator の資格（状態ファイルの token・認証を切った構成）で張った流れは、
   *   確かめ直さない**（いままでどおり）。失効させる口がそもそも無い資格である
   * - **判定できない（ストアが投げた）ときは、閉じる側へ倒す**（資格の判定は、
   *   判定できないときに閉じる。#1789 と同じ向き）。閉じてもクライアントは張り直せる
   * - 1回の確かめ直しで行うのは、ストアの読み出し2回（トークンの行とアカウント）と、
   *   使った時刻の書き込み（`markAccessTokenUsed`。既存の間引きで 60 秒に1回まで）。
   *   前の確かめ直しが終わっていなければ、重ねない
   */
  function watchSseCredential(principal: Principal, authorization: string | undefined) {
    const bearer = principal.kind === 'account' ? bearerOf(authorization) : null;
    let lost = false;
    let checking = false;
    return {
      /** 資格が使えなくなったと分かったか。 */
      lost: () => lost,
      /** 心拍の1拍ごとに呼ぶ。使えなくなったと分かったら `wake` で流れを起こす。 */
      tick(wake: () => void): void {
        if (bearer === null || lost || checking) return;
        checking = true;
        void authService
          .authenticate(bearer)
          .then(
            (account) => {
              if (account === null || !isAccountGranted(account)) {
                lost = true;
                wake();
              }
            },
            () => {
              lost = true;
              wake();
            },
          )
          .finally(() => {
            checking = false;
          });
      },
    };
  }
  /**
   * **chat の SSE の骨（`POST /chat` と `GET /chat/:conversationId/stream` の共通部分）。**
   *
   * 出来事を溜める列・心拍と資格の確かめ直し・列を吐き切るループ・購読の解除を1か所に
   * 持つ。2本の口でループを別々に持つと、資格が尽きたときの閉じ方や心拍の扱いが片方だけ
   * 変わる（issue #1820 が `/journal/stream` との間で一度踏んだ形）。
   *
   * - `pump.push` を購読者として渡す。`done` / `error` が来たら吐き切って閉じる
   * - `beforeLoop` は心拍を起こした後、ループに入る前に呼ばれる（`POST /chat` は投函と
   *   `open`、`GET .../stream` は `open` と途中経過の再送）。投げても購読は漏れない
   * - `unsubscribe` は購読を張った側が渡す。**`try` は購読の直後から始める**ために、
   *   購読は呼び出し側で済ませてからここへ来る
   */
  function chatEventPump() {
    const queue: ChatStreamEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    return {
      push(event: ChatStreamEvent): void {
        queue.push(event);
        if (event.type === 'done' || event.type === 'error') finished = true;
        wake?.();
      },
      /** これ以上は流さない（接続が切れた・流すものが無い）。 */
      finish(): void {
        finished = true;
        wake?.();
      },
      async serve(
        stream: Parameters<typeof startSseHeartbeat>[0] & {
          writeSSE(message: { event: string; data: string }): Promise<void>;
          onAbort(listener: () => void | Promise<void>): void;
        },
        request: { principal: Principal; authorization: string | undefined },
        unsubscribe: () => void,
        beforeLoop: () => Promise<void>,
      ): Promise<void> {
        // **`try` は購読の直後から始める。** 以前はここより後ろにあり、`clone.post` や
        // `open` の書き込みが投げたら購読が漏れていた（現行の実装では投げないので今は
        // 踏まれないが、将来ここに検査や変換が増えたときに静かにリークへ転化する）。
        try {
          // 人間が chat を閉じても、クローンのターンは走り続ける（人間の不在で
          // 止まるのは承認待ちの仕事だけ）。ここで手放すのは購読だけである。
          stream.onAbort(() => {
            finished = true;
            wake?.();
          });

          // heartbeat は SSE のコメント行を流す（クライアントは読み捨てる）。
          // 死んだ接続の掃除の契機でもある（詳細は `@alteroid/core` の `sse-heartbeat.ts`）。
          // **1拍ごとに資格も確かめ直す**（issue #1820。`watchSseCredential` の doc）。
          const credential = watchSseCredential(request.principal, request.authorization);
          const stopHeartbeat = startSseHeartbeat(
            stream,
            sseHeartbeatMs,
            () => wake?.(),
            () => credential.tick(() => wake?.()),
          );

          try {
            await beforeLoop();

            for (;;) {
              if (stream.aborted || stream.closed) break;
              if (credential.lost()) {
                // **閉じる前に理由を1つ送る**（issue #1820）。画面が「接続が切れた」と
                // 区別できるように、既存の `error` イベントの形で言う。
                await stream.writeSSE({
                  event: 'error',
                  // クライアント自身の資格が尽きた通知で、クローンの認証・利用上限ではない ⟹ `other`。
                  data: JSON.stringify({
                    type: 'error',
                    message: SSE_CREDENTIAL_LOST_MESSAGE,
                    kind: 'other',
                  }),
                });
                break;
              }
              const event = queue.shift();
              if (event === undefined) {
                if (finished) break;
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
                wake = null;
                continue;
              }
              await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
              if (event.type === 'done' || event.type === 'error') break;
            }
          } finally {
            stopHeartbeat();
          }
        } finally {
          unsubscribe();
        }
      },
    };
  }
  const providerList = authPlan.providers.map(({ id, label, kind }) => ({ id, label, kind }));
  /**
   * プロバイダへ登録する戻り先。**1プロバイダにつき1本だけ**にしてある。
   * 用途ごとに URL を増やすと、token 交換時の `redirect_uri` 不一致が起きやすい。
   */
  const callbackUrl = (provider: string) => `${authPlan.publicBaseUrl}/auth/${provider}/callback`;

  /**
   * 入口の門番。
   *
   * **通す条件は2つだけである。** ①実行環境の持ち主（状態ファイルの token を
   * 提示できる）②許可されたアカウントのアクセストークン。行為ごとの許可表は
   * 持たない — 持った瞬間に PRD「権限境界」が言う「確認が要る行為の一覧」と
   * 同じ形になり、クローンの判断を設定で置き換えることになる。
   */
  const authenticate = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (isOperator(c, deps.token)) {
      // **`auth: 'operator-token'`（Issue #1479）。** 状態ファイルの token を
      // 提示できたことをもって通した——`Principal` の doc を見よ。
      c.set('principal', { kind: 'operator', auth: 'operator-token' });
      await next();
      return;
    }
    // **第3の資格: 連携の鍵（`altk_`）。認証が無効の構成でも、`altk_` の bearer が付いていれば照合と
    // 制限を掛ける**（bearer が無ければ今までどおり素通し）。公開パス（`isPublicPath`）の扱いは変えない。
    if (!isPublicPath(c.req.path)) {
      const presented = bearerOf(c.req.header('authorization'));
      if (presented !== null && looksLikeIntegrationKey(presented)) {
        return authenticateIntegrationKey(c, next, presented);
      }
    }
    if (!authPlan.enabled) {
      // 認証を設定していない構成では、この機能が入る前とまったく同じに振る舞う。
      // 守りは待ち受け先（既定 127.0.0.1）と手前に置く境界の側にある。
      // **`auth: 'disabled'`（Issue #1479）。** token の提示なしに通った——
      // `Principal` の doc を見よ。
      c.set('principal', { kind: 'operator', auth: 'disabled' });
      await next();
      return;
    }
    if (isPublicPath(c.req.path)) {
      await next();
      return;
    }

    const bearer = bearerOf(c.req.header('authorization'));
    if (bearer === null) {
      return c.json({ error: 'ログインが要る（alteroid login）' as const }, 401);
    }
    const account = await authService.authenticate(bearer);
    if (account === null) {
      return c.json({ error: 'トークンが無効か期限切れ（alteroid login をやり直す）' }, 401);
    }
    // **`POST /auth/logout` だけは、許可の無いアカウントも通す（issue #1757）。**
    // 自分のトークンを失効させるのに、使う許可は要らない。ここで 403 にすると、
    // 許可待ちのトークンは失効させられないまま残り、**後から `access grant` した
    // 瞬間に、捨てたつもりのトークンが使える鍵として生き返る**（CLI の
    // `alteroid logout` も 403 を「失敗」と読んで手元を消せなくなる）。
    // ログアウトの口がする操作は「提示したトークン自身を失効させる」だけなので、
    // 通しても許可の無いアカウントに何かを許すことにはならない。
    if (!isAccountGranted(account) && c.req.path !== '/auth/logout') {
      // ログインは通っているが使う許可が無い。**401 ではなく 403** で返す
      // （やり直しても解決しない。人間が alteroid access grant を実行する）。
      return c.json({ error: 'このアカウントには alteroid を使う許可が無い' }, 403);
    }
    c.set('principal', { kind: 'account', account });
    await next();
  });

  /**
   * **連携の鍵（`altk_`）の門。** 照合し、**既定で拒否**し、上限を掛ける。**この資格にだけ**掛かる
   * （人間・operator の経路に新しい制限は足さない）。
   *
   * 1. 未知・失効・期限切れは **401**。
   * 2. 通すのは `POST /events`（本文の source が鍵の source と一致するときだけ。本文を読むハンドラが判定し、
   *    不一致は 403）と `POST /events/:source`（パスが一致するときだけ）。**不一致も、それ以外のすべての口
   *    （鍵の管理の口を含む）も 403。** 例外が1つ: **自分の送信に付ける添付のアップロード `POST /attachments`**
   *    （#3113 段3。添付の読み出しは通さない）。
   * 3. 鍵ごとの回数（メモリ上の固定窓）を超えたら **429** と `Retry-After`（アップロードも1回に数える）。
   * 4. 本文が鍵の `maxBodyBytes` を超えたら **413**。**`/events*` にだけ掛ける**（添付のアップロードには
   *    掛けず、添付の上限 `attachmentBodyMax` とストアの検証に任せる。1 MiB 超の画像を上げられないと
   *    添付の意味が無いため）。
   *
   * **断った試み（401/403/413/429）は日誌に書かず、デーモンのログへ**（鍵の値は出さない）。
   */
  async function authenticateIntegrationKey(
    c: Context<{ Variables: AuthVariables }>,
    next: Next,
    presented: string,
  ): Promise<Response | void> {
    const refuse = (status: 401 | 403 | 413 | 429, why: string, key?: IntegrationKeyRecord) => {
      noteIntegrationRefusal(c, status, why, key?.id);
    };
    const key = await resolveIntegrationKey({
      store: stores.integrationKeys,
      bearer: presented,
      now: integrationClock(),
    });
    if (key === null) {
      refuse(401, '未知・失効・期限切れ');
      return c.json({ error: '連携の鍵が無効か期限切れ' as const }, 401);
    }
    const limits = integrationKeyLimits(key);
    c.set('principal', {
      kind: 'integration',
      keyId: key.id,
      name: key.name,
      source: key.source,
      limits,
    });
    const routeVerdict = judgeIntegrationRoute(c.req.method, c.req.path, key.source);
    if (!routeVerdict.allowed) {
      refuse(403, 'この鍵が通れない口');
      return c.json(
        {
          error:
            'この連携の鍵では、この操作はできない（固定の source への外部イベントと、それに付ける添付のアップロードだけ）' as const,
        },
        403,
      );
    }
    const verdict = integrationRateLimiter.consume(key.id, limits.ratePerMinute);
    if (!verdict.ok) {
      refuse(429, '回数の上限', key);
      c.header('Retry-After', String(verdict.retryAfterSeconds));
      return c.json(
        { error: '連携の鍵の回数の上限を超えた（Retry-After の後でやり直す）' as const },
        429,
      );
    }
    // 添付のアップロードの本文上限は、その口自身の `bodyLimit(attachmentBodyMax)` が持つ。
    if (routeVerdict.via === 'attachment-upload') {
      await next();
      return;
    }
    return bodyLimit({
      maxSize: limits.maxBodyBytes,
      onError: (ctx) => {
        refuse(413, '本文の上限', key);
        return ctx.json({ error: '本文が連携の鍵の上限を超えた' as const }, 413);
      },
    })(c, next);
  }

  /**
   * 実行環境の持ち主だけに絞る門。**⚠️ 2026-09-06 のオーナー決定で、`/tokens`
   * `/access/*` はここを外れ `authenticate` だけになった**（alteroid を使う許可
   * ＝ `access grant` 済みのアカウントを、実行環境の持ち主と同格に扱う）。
   * いまこの門を通る経路の一覧を持つのは歯である。**本数をここで数え直さないこと**
   * —— 数え上げの持ち主は `scripts/require-operator-routes.test.ts` の
   * `EXPECTED_OPERATOR_ROUTES` で、そこは配線と一覧の一致を測っている。定義
   * そのものはこの決定でも変えていない——変えたのは経路ごとの配線（どこへ
   * 引数として渡すか）である。
   *
   * **⚠️ 2026-09-17、この門から `PUT /credentials` と `POST /reset` が外れた**
   * （issue #1195）。外れた先は「無し」ではなく、下の `requireOwner`
   * ——（2026-10-05 以降は `authenticate` と同じ強さの素通しの門になった。下の `requireOwner`）。⟹ **ここに残っているのは
   * `/profile` の読み書き2本と、下の owner 宣言の口2本で、いずれも応答本文に鍵が
   * 丸ごと載るか実行環境そのものを差し替える口だからである**（2026-09-06 の
   * 同格化でも名指しで外された。逐語は `git show f285737 --format=%B -s`）。
   */
  const requireOperator = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (c.get('principal').kind !== 'operator') {
      return c.json({ error: '実行環境の持ち主だけが操作できる' as const }, 403);
    }
    await next();
  });

  /**
   * **「持ち主」の門。ログインできる（許可済みの）アカウントは全員、持ち主として通す。**
   *
   * **⚠️ 2026-10-05、オーナー決定（#2862 のオーナー回答）で、宣言済み owner だけに
   * 絞っていた門（issue #1198）を緩めた。** 回答の要点は「alteroid にログイン出来る
   * のが持ち主という認識。環境変数や実行環境プロファイルなども全部許可してほしい」。
   * ⟹ 許可済み（`access grant` 済み）のアカウントなら、`PUT /credentials`
   * `POST /reset` `/profile` `/mcp-servers` を含め、この門を通る経路をすべて通す。
   *
   * **この門は何も弾かない。** 弾く仕事は上の `authenticate` がする（未ログインは
   * 401、許可の無いアカウントは 403。ここまで来た時点で principal は operator か
   * 許可済みのアカウントである）。**`authenticate` は緩めていない。**
   *
   * **なぜ配線から外さず、中身だけ素通しにしたのか。** 戻すのが1箇所で済む
   * （下の本体を、`principal.kind === 'operator' || isDeclaredOwner(principal.account)`
   * なら `next()`、でなければ 403 `'実行環境の持ち主として宣言されたアカウントだけが
   * 操作できる'` に戻すだけ）。配線を外すと、戻すときに経路ごとに付け直す羽目になり、
   * 付け忘れが静かに「許可済みなら誰でも」へ落ちる。経路の一覧を測る歯
   * （`scripts/require-operator-routes.test.ts` の `EXPECTED_OWNER_ROUTES`）も、
   * 配線を保つので変えずに済む。
   *
   * **変えていないもの。** `requireOperator`（状態ファイルの token。持ち主の宣言の口
   * `/access/:accountId/owner*`）は別の概念で、そのまま。宣言（`ownerDeclaredAt`）の
   * 保存・`isDeclaredOwner` もそのまま残してある（いまは通す・通さないに効かない）。
   * 正典は `docs/architecture.md`「デーモンの API に入る資格」。
   */
  const requireOwner = createMiddleware<{ Variables: AuthVariables }>(async (_c, next) => {
    await next();
  });

  /**
   * plugin の確認（preview）で取った中身の預かり。**確定は取り直さず、ここにあるものをそのまま保存する**
   * （確認から確定までに取り元が動いても、見せたものと入れるものがずれない）。メモリだけで、期限つき。
   */
  const pluginPreviews = createPluginPreviewStore(
    deps.pluginPreviewNow === undefined ? {} : { now: deps.pluginPreviewNow },
  );

  /**
   * 連携の鍵の管理の口（`/integration-keys`）に付ける、**二重の門**。連携の鍵（`altk_`）は `authenticate` が
   * 既定で拒否するのでここへは来ないが、配線のずれ・将来の変更で鍵が管理の口へ入れないよう、口の側でも断る
   * （鍵が自分の仲間の鍵を発行・失効できたら、配布範囲の境界が崩れる）。
   */
  const humanOnly = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (c.get('principal').kind === 'integration') {
      return c.json({ error: '連携の鍵では、鍵の管理はできない' as const }, 403);
    }
    await next();
  });

  const base = new Hono<{ Variables: AuthVariables }>();

  /**
   * Hono の既定のエラーハンドラを、本文を出さない規律に合わせて置き換える
   * （Issue #249）。
   *
   * **変えるのは `console.error(err)` の枝と、失敗本文の形である**（issue #2849:
   * 既定の `text/plain` の本文は `{ error }` の JSON へ揃えた。状態コードは既定と同じ）。
   * `HTTPException` が `res` を明示していて JSON などのときは既定どおり通す。実物（`hono@4.13.1`、
   * `node_modules/.pnpm/hono@4.13.1/node_modules/hono/dist/hono-base.js` の
   * `errorHandler`）は逐語で:
   *
   * ```
   * var errorHandler = (err, c) => {
   *   if ("getResponse" in err) {
   *     const res = err.getResponse();
   *     return c.newResponse(res.body, res);
   *   }
   *   console.error(err);
   *   return c.text("Internal Server Error", 500);
   * };
   * ```
   *
   * `console.error(err)` はエラーオブジェクトを丸ごと stderr へ出す。ルート
   * ハンドラが投げた例外がリクエストの値を抱えていれば（`fetch` / DB ドライバ
   * / `execFile` の例外はそういう形を持ちうる）、それがそのまま器の外へ出る
   * （`dropped-record.ts` の doc が言う「本文は出さない」の線）。
   *
   * **`reasonOf` は `dropped-record.ts` の既存の口をそのまま使う。** 同じ
   * 判断（1行目だけ・200字で切る）を2箇所に持つと必ずずれる。
   */
  base.onError(async (err, c) => {
    if ('getResponse' in err) {
      const res = err.getResponse();
      // **失敗の本文は `{ error }` の JSON に揃える（issue #2849）。** hono の
      // validator が壊れた JSON に投げる `HTTPException`（`Malformed JSON in request
      // body`）は `text/plain` で、`jsonBody` の `hook` には届かない。`text/plain`
      // のときだけ畳み、`res` を明示した例外（JSON など）はそのまま通す。
      if ((res.headers.get('content-type') ?? '').startsWith('text/plain')) {
        const message = await res.text();
        return c.json({ error: message === '' ? res.statusText : message }, res.status as 400);
      }
      return c.newResponse(res.body, res);
    }
    process.stderr.write(
      `alteroidd: HTTP 経路で例外を捕まえました（本文は出しません）: ${reasonOf(err)}\n`,
    );
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  // **存在しない経路・メソッドも `{ error }` の JSON で返す（issue #2849）。**
  base.notFound((c) => c.json({ error: 'not found' }, 404));

  // **CORS は認証より先に登録する。** ブラウザの preflight（OPTIONS）は
  // `Authorization` を積んで来ないので、門番が先に立つと preflight が 401 になり、
  // 本リクエストが一度も飛ばない。hono の `cors()` は OPTIONS にその場で答えて
  // `next()` を呼ばないので、ここに置けば門番も素通りしない。
  //
  // 列挙が空なら**何も登録しない** — CORS ヘッダを返さない今までの姿勢のまま。
  const allowedOrigins = deps.allowedOrigins ?? [];
  if (allowedOrigins.length > 0) {
    base.use(
      '*',
      cors({
        // 列挙にあるものだけをそのまま返す。`*` は返さない（`AppDeps` の注記）。
        origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
        // **この配列は経路を追加した人が自動では見に来ない。** #27 でこの並びを
        // 固定した時点では `PATCH` を使う経路が1つも無かったため、そのときの
        // 実在するメソッドだけを並べた。`PATCH /commitments/:id`（#512、台帳の
        // 本文を後から直す唯一の口）が後から増えたときにここは更新されず、
        // 別オリジンの画面からの編集だけがブラウザの preflight に静かに
        // 落とされていた（Issue #580）。**新しいメソッドの経路を足したら、
        // ここも一緒に見ること。** `apps/daemon/src/app.test.ts` の
        // 「アプリが出しているメソッドは全部 CORS が許している」の歯が、
        // 名指しに頼らず取りこぼしを拾う。
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        // `content-type` は `deliberateClient` が、`authorization` は門番が要求する。
        // 後者を落とすと、別オリジンの画面はログイン済みでも何も呼べない。
        allowHeaders: ['content-type', 'authorization'],
        // Cookie は運ばせない。資格情報はヘッダで運ぶ（packages/logic/src/config.ts）。
        credentials: false,
        maxAge: 600,
      }),
    );
  }

  const app = base
    .use('*', authenticate)

    .get(
      '/health',
      describeRoute({
        tags: ['system'],
        summary: '死活監視と本人確認',
        description:
          'デーモンが応答しているかと、その pid・認証の状態を返す。' +
          '**記憶の置き場は返さない**（無認証で読める応答に、内部のホスト名・DB 名・ホームのパスを' +
          '置かない。#2869）。認証の要る `GET /status` が返す。' +
          '`Authorization: Bearer <state/daemon.json の token>` を添えると `operator` が ' +
          'true になり、CLI はこれで「自分が起こしたデーモンか」を確かめる（PID は信用しない）。' +
          '**トークンそのものは返さない** — この値は許可を付与できる資格そのものなので、' +
          '無認証で読める応答には置けない。',
        security: [],
        responses: {
          200: {
            description: '応答している。',
            content: { 'application/json': { schema: resolver(healthResponseSchema) } },
          },
        },
      }),
      (c) =>
        c.json({
          ok: true,
          pid: process.pid,
          operator: isOperator(c, deps.token),
          auth: { enabled: authPlan.enabled, providers: providerList },
        }),
    )

    /**
     * デーモン自身の説明（いまは記憶の置き場だけ）。**資格が要る**（`isPublicPath` に
     * 入れない）。`/health` から外した `storage` の移し先（#2869）——内部のホスト名・
     * DB 名・ホームのパスは、ログインしていない相手に読ませない。
     */
    .get(
      '/status',
      describeRoute({
        tags: ['system'],
        summary: 'デーモン自身の説明（記憶の置き場。資格が要る）',
        description:
          '記憶の置き場（PostgreSQL なら `host:port/db`、ファイルなら記憶ディレクトリのパス）を返す。' +
          '接続情報（パスワード等）は含めない。無認証の `GET /health` は置き場を返さないので、' +
          '置き場を知りたい呼び出し元はログインの後ろのここから取る。',
        responses: {
          200: {
            description: '認証を通った相手への説明。',
            content: { 'application/json': { schema: resolver(statusResponseSchema) } },
          },
          401: {
            description: '資格が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      (c) => {
        // 弾かれていないときは欄を出さない（`null` は欄ごと落とす）
        const refusal = clone.sessionRefusal?.() ?? null;
        return c.json(
          statusResponseSchema.parse({
            storage: deps.storage ?? '',
            ...(refusal === null ? {} : { cloneSessionRefusal: refusal }),
          }),
        );
      },
    )

    // --- 添付（Issue #3111 段1b） -------------------------------------------
    .post(
      '/attachments',
      describeRoute({
        tags: ['attachments'],
        summary: '添付を預かる（生のバイト列）',
        description:
          '本文は**生のバイト列**で、名前と MIME はクエリ（`name` / `type`）で運ぶ。' +
          '**`content-type` は `application/octet-stream` だけを受ける**（それ以外は 415）——' +
          'CORS の単純リクエストにさせず、ブラウザが必ず preflight を通すため（`deliberateClient` と同じ考え）。' +
          '認証は他の経路と同じ。本文の上限は添付1つぶんの最大値（超えたら 413）。画像（png / jpeg / webp / gif）は' +
          '宣言と中身の先頭が一致しなければ 400。宣言が画像で、幅か高さが 8000 px を超えるものも 400（`code`: `image_dimension_too_large`。' +
          '寸法が読めないものは通す。宣言が画像以外ならこの検査は掛からず、ターンでファイルとして渡る）。0バイトの本文も 400（`code`: `empty`。Web・CLI・TUI と揃えて断る）。返った `id` を `POST /chat` の `attachments` に渡すと発言へ結び付く。' +
          '結び付けないまま 1 時間たったものは掃除される。' +
          'クエリ `keep=1` を付けると、預けた時点で保存の印が付く（期限なし。未結び付けの掃除にも掛からない。' +
          '外すのは `PATCH /attachments/:id`、消すのは `DELETE /attachments/:id`）。**連携の鍵は `keep` を付けられない**（403）。' +
          '**連携の鍵（`altk_`）もこの口だけは通れる**（自分の外部イベントに付ける添付を上げるため。#3113 段3）：' +
          '`uploadedBy` は `integration:<keyId>` になり、その鍵が `POST /events` で付けられるのは自分が上げた添付だけ。' +
          '本文の上限は鍵の `maxBodyBytes` ではなく添付の上限（上記）に従い、1 回として鍵の回数（429）に数える。' +
          '鍵は添付を読み出せない（`GET /attachments/:id` は 403）。',
        requestBody: {
          required: true,
          description: '添付の中身（生のバイト列）。',
          content: {
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
          },
        },
        responses: {
          200: {
            description: '預かった。控え（中身を含まない）を返す。',
            content: { 'application/json': { schema: resolver(attachmentMetaSchema) } },
          },
          400: {
            description:
              'クエリが不正、または受け付けない中身（`code`: `magic_mismatch` / `image_dimension_too_large` / `media_type_missing` / `empty`＝0バイト）。',
            content: { 'application/json': { schema: resolver(attachmentErrorResponseSchema) } },
          },
          413: {
            description: '大きすぎる（`code`: `too_large`）。',
            content: { 'application/json': { schema: resolver(attachmentErrorResponseSchema) } },
          },
          403: {
            description: '連携の鍵が `keep` を付けた（鍵は保存の印を付けられない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          415: {
            description: 'content-type が application/octet-stream ではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      octetStreamClient,
      bodyLimit({
        maxSize: attachmentBodyMax,
        onError: (c) =>
          c.json(
            {
              error: `添付は 1 つ ${attachmentBodyMax} バイトまで`,
              code: 'too_large' as const,
            },
            413,
          ),
      }),
      queryParams(attachmentUploadQuery),
      async (c) => {
        const { name, type, keep } = c.req.valid('query');
        const principal = c.get('principal');
        // 連携の鍵は保存の印を付けられない: 期限なしで預けられると、鍵ごとの預け量の枠が無い前提（#4005）が崩れるため
        if (keep === true && principal.kind === 'integration') {
          return c.json(
            {
              error: '連携の鍵は保存の印（keep）を付けられない（期限なしで預けられない）' as const,
            },
            403,
          );
        }
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        try {
          const meta = await stores.attachments.put({
            name: name ?? '',
            mediaType: type,
            bytes,
            ...(keep === true ? { kept: true } : {}),
            // 誰が上げたか（識別子だけ）。門番（`authenticate`）が `c` に載せた principal から作る。
            uploadedBy: uploaderOf(c.get('principal')),
          });
          return c.json(meta, 200);
        } catch (error) {
          if (error instanceof AttachmentRejectedError) {
            // `reasonOf` ではなく `redactErrorText`: `reasonOf` は「AttachmentRejectedError: … code=…」と包むので、
            // Web・CLI・TUI がそのまま出す理由に型名と code が混ざる（#3697）。伏せ字は外さない。
            return c.json(
              { error: redactErrorText(error.message, process.env), code: error.code },
              error.code === 'too_large' ? 413 : 400,
            );
          }
          throw error;
        }
      },
    )

    // 置き場の一覧（#4126 P4）。`/attachments/limits` と `/attachments/:id` より前に置く（定義順に当たる。
    // `/attachments` 自体は `:id` に当たらないが、あとから足す経路で取り違えない並びをここで固定する）。
    .get(
      '/attachments',
      describeRoute({
        tags: ['attachments'],
        summary: '添付の一覧と使用量',
        description:
          '預かっている添付の控え（中身を含まない）を新しい順に返す。期限切れは含まない。' +
          '会話（`conversationId`）・出所（`from`: `human` / `clone` / `manager` / `integration` / `unknown`）・' +
          '保存の有無（`kept`）・名前の部分一致（`q`。大文字小文字を問わない）で絞れる。' +
          '`limit` は既定 50・上限 200。続きがあるときだけ `nextCursor` が付く（次の呼び出しの `cursor` に渡す）。' +
          '`usage` は絞り込みに関わらず、期限内の全体の使用量（合計と出所ごと）。' +
          '**保存した添付に期限は無く、全体の容量の上限も置かない**——使用量を見て、不要なものを消すのは人間とクローンの判断である。' +
          '連携の鍵は 403（鍵は上げるだけで、預かったものを見られない）。',
        responses: {
          200: {
            description: '控えの一覧と使用量。',
            content: { 'application/json': { schema: resolver(attachmentListResponseSchema) } },
          },
          400: {
            description: 'クエリが不正（`cursor` が読めない、`limit` が範囲外など）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      queryParams(attachmentListQuery),
      async (c) => {
        const query = c.req.valid('query');
        let page;
        try {
          page = await stores.attachments.list({
            limit: query.limit,
            ...(query.kept === undefined ? {} : { kept: query.kept }),
            ...(query.from === undefined ? {} : { from: query.from }),
            ...(query.conversationId === undefined ? {} : { conversationId: query.conversationId }),
            ...(query.q === undefined ? {} : { q: query.q }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          });
        } catch (error) {
          if (error instanceof AttachmentCursorError) {
            return c.json({ error: '入力の形が不正: cursor' as const }, 400);
          }
          throw error;
        }
        const usage = await stores.attachments.usage();
        return c.json(attachmentListResponseSchema.parse({ ...page, usage }));
      },
    )

    // `/attachments/:id` より前に置く（`limits` を id と取り違えない。Hono は定義順に当てる）。
    .get(
      '/attachments/limits',
      describeRoute({
        tags: ['attachments'],
        summary: '添付の上限（このデーモンが実際に使っている値）',
        description:
          '環境変数（`ALTEROID_ATTACHMENT_MAX_*`）で変えた値を含む、`POST /attachments` と `POST /chat` が' +
          '実際に使っている上限を返す。CLI・TUI・Web が送る前の検査に使う（最終判定はこのデーモン）。' +
          '認証は他の経路と同じ（連携の鍵は 403）。',
        responses: {
          200: {
            description: '上限。',
            content: { 'application/json': { schema: resolver(attachmentLimitsSchema) } },
          },
        },
      }),
      (c) => c.json(attachmentLimitsSchema.parse(attachmentLimits)),
    )

    .get(
      '/attachments/:id/meta',
      describeRoute({
        tags: ['attachments'],
        summary: '添付の控え（メタデータだけ）',
        description: '中身を読まずに、名前・MIME・大きさ・sha256・結び付き・期限を返す。',
        responses: {
          200: {
            description: '控え。',
            content: { 'application/json': { schema: resolver(attachmentMetaSchema) } },
          },
          404: {
            description: '無い（消えた・期限切れ）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const meta = await stores.attachments.getMeta(c.req.param('id'));
        if (meta === undefined) return c.json({ error: 'not found' as const }, 404);
        return c.json(meta);
      },
    )

    .get(
      '/attachments/:id',
      describeRoute({
        tags: ['attachments'],
        summary: '添付の中身を返す',
        description:
          '預かった中身をそのまま返す。`content-type` は控えの MIME。**`content-disposition: attachment`**' +
          '（ファイル名は RFC 5987）と **`x-content-type-options: nosniff`** を付ける——人間が上げた中身を' +
          'ブラウザがこのオリジンの文書として開かないため。',
        responses: {
          200: {
            description: '中身。',
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          404: {
            description: '無い（消えた・期限切れ）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const found = await stores.attachments.get(c.req.param('id'));
        if (found === undefined) return c.json({ error: 'not found' as const }, 404);
        const { meta, bytes } = found;
        return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
          'content-type': SAFE_MEDIA_TYPE.test(meta.mediaType)
            ? meta.mediaType
            : 'application/octet-stream',
          'content-length': String(bytes.length),
          'content-disposition': attachmentDisposition(meta.name),
          'x-content-type-options': 'nosniff',
        });
      },
    )

    .patch(
      '/attachments/:id',
      describeRoute({
        tags: ['attachments'],
        summary: '添付の保存の印を付ける・外す',
        description:
          '`kept: true` で保存の印を付ける（期限を持たなくなり、期限でも未結び付け 1 時間の掃除でも消えない）。' +
          '`kept: false` で外す（外した時刻から保持日数後が期限になる）。すでにその状態なら何も変えない。' +
          '更新後の控えを返す。連携の鍵は 403。',
        responses: {
          200: {
            description: '更新後の控え。',
            content: { 'application/json': { schema: resolver(attachmentMetaSchema) } },
          },
          400: {
            description: '本文が不正（`kept` は真偽値）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '無い（消えた・期限切れ）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(attachmentKeptBodySchema),
      async (c) => {
        const { kept } = c.req.valid('json');
        const meta = await stores.attachments.setKept(
          c.req.param('id'),
          kept,
          (deps.now ?? (() => new Date()))(),
        );
        if (meta === undefined) return c.json({ error: 'not found' as const }, 404);
        return c.json(meta);
      },
    )

    .delete(
      '/attachments/:id',
      describeRoute({
        tags: ['attachments'],
        summary: '添付を消す（保存したものも）',
        description:
          '預かっている中身と控えを消す。保存の印が付いていても消す。`attachment_fetch` で取り出した写しも消す。' +
          '取り消せない。連携の鍵は 403。',
        responses: {
          204: { description: '消した。' },
          404: {
            description: '無い（消えた・期限切れ）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const id = c.req.param('id');
        const removed = await stores.attachments.remove(id);
        // 写しは、本体が無かったときも消す（本体だけ先に消えて取り残された写しを、ここで片付ける）
        // ディレクトリ名にできない id（`..`・パス区切り）は `removeAttachmentCopy` が何もしない（`file_delete` と同じ規則）
        if (deps.attachmentCopiesDir !== undefined) {
          await removeAttachmentCopy(deps.attachmentCopiesDir, id);
        }
        if (!removed) return c.json({ error: 'not found' as const }, 404);
        return c.body(null, 204);
      },
    )

    // --- chat（SSE） -------------------------------------------------------
    .post(
      '/chat',
      describeRoute({
        tags: ['chat'],
        summary: 'クローンと話す（SSE）',
        description:
          '人間の発言をクローンの受信箱へ積み、クローンの応答を SSE で流す。' +
          '**`conversationId` を省くと新しい会話を始め、渡すとその既存の会話へ続ける**（無い会話の id なら 404。その文字列で会話は作らない）。' +
          '**⚠️ `open`（200）は「受け付けた」であって、受信箱（器）への永続化の完了ではない。** ' +
          '発言は `open` を書く前にクローンへ渡すが、器への書き込みは待たない（失敗しても応答は成功のままで、' +
          '失敗は stderr にだけ残る。書けなかった発言はこのプロセスが生きているあいだは配達されるが、' +
          '再起動・デプロイを挟むと失われる）。永続化できたときだけ成功を返す口は `POST /events`・`POST /events/:source`。' +
          '**SSE。** `event:` にイベント名（`open` / `queued` / `text` / `thinking` / `tool` / ' +
          '`ask_human` / `done` / `error`）、`data:` に対応する JSON が入る。`data:` の ' +
          '形は下記スキーマ（`open` は `{conversationId, clientMessageId?}`（重複の再送のときは `duplicate: true` も）で別枠、他は ' +
          '`chatStreamEventSchema` の各枝）。人間が chat を閉じてもクローンのターンは' +
          '走り続ける（人間の不在で止まるのは承認待ちの仕事だけ）。' +
          '**`queued` と `thinking` は別の状態である。** `queued` は受信箱に積んだ' +
          '（受理したが順番待ち。先客のターンが走っていれば、ここで数分待つことがある）、' +
          '`thinking` は入力がモデルへ渡って最初の出力を待っている。前者の後に後者が来る。' +
          '**発言が日誌に載るのも `queued` の時点である**ので、`GET /conversations` には' +
          'ターンの順番を待たずに現れる。**コメント行（`:` で始まる行）の heartbeat が' +
          '周期的に流れる。SSE の仕様上クライアントは読み捨ててよい**（無音のまま死んだ' +
          '接続を掃除するための送信でもある）。' +
          '**`supersedes` — 送信済みの人間の発言を編集する。** この会話の中の、自分の' +
          '過去の発言（`role: inbound`）の id を渡すと、その発言は既定ビュー・' +
          '`conversation_read` から畳まれ、この発言が編集後の版として応答を受ける' +
          '（編集前のターンで起きた副作用——承認待ち・記憶・マネージャー・台帳の行——は' +
          '一切取り消さない）。`conversationId` と併せて渡すこと。編集できるのは' +
          '**人間の発言だけ**（クローンの応答は指せない）。' +
          '**`clientMessageId` — 送った側が発言ごとに作る一意な id（任意。英数字・`_` `-` の1〜128字）。** ' +
          '受信箱の発言と日誌の発言に残り、`open` と `GET /conversations/:id` の `messages` で返る' +
          '（送った側が、自分の発言が履歴に現れたかを本文でなく id で確かめられる）。' +
          '**同じ値が再び届いたら二重に受けない**——何も積まず、`open`（`duplicate: true`）の後、' +
          '進行中のターンがあれば途中経過から続きを流して閉じる（`GET /chat/:conversationId/stream` と同じ）。' +
          'ただし**中身（本文・添付の id の集合・`supersedes`）が1回目と違う**なら、黙って捨てずに 409（`client_message_id_mismatch`）。' +
          '別の会話で受け取り済みの値も 409（`client_message_id_conflict`）。重複の判定は、直近の日誌（人間との往復200件）と受け取り直後の記憶で行う。',
        responses: {
          200: {
            description: 'SSE ストリーム。',
            content: {
              'text/event-stream': { schema: resolver(chatStreamEventSchema) },
            },
          },
          400: {
            description:
              '`text` が空で添付も無い、または本文が JSON として不正。または `supersedes` の検証に' +
              '落ちた——`conversationId` が無いのに `supersedes` がある、指した id が' +
              '見つからない・この会話のものではない、クローンの応答（outbound）を指して' +
              'いる、既に別の編集に置き換えられている、のいずれか。' +
              '`clientMessageId` の形が不正（英数字・`_` `-` の1〜128字）のときも 400。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description:
              '`conversationId` を渡したが、その会話が無い（`code: conversation_not_found`。日誌の人間との往復を' +
              '最後まで読んで見つからなかった）。**その文字列で新しい会話は始めない**——新しい会話を始めるなら' +
              '`conversationId` を省く。略記・前方一致では受けない（一意に当たる会話が在れば、`error` に完全な id を出す）。' +
              '何も積まず、添付も結び付けない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '`clientMessageId` が、**別の会話**の発言として既に受け取られている（`code: client_message_id_conflict`）。' +
              'または、**同じ会話**で受け取り済みだが**中身が違う**（`code: client_message_id_mismatch`。' +
              '本文・添付の id の集合・`supersedes` のどれかが1回目と違う。2回目の中身は積まず、添付も結び付けない）。' +
              '中身が同じ再送は 409 ではなく、二重に受けずに 200（下の説明）。' +
              'または、`supersedes` が指す発言が日誌に**在るが読めない**（`code` は無い。400 の「見つからない」とは別。' +
              '何も積まない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(chatBody, (where) => ({
        error: 'text が空（添付も無い）、または本文の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const {
          text,
          conversationId: given,
          supersedes,
          attachments: attachmentIds,
          clientMessageId,
        } = c.req.valid('json');

        /*
         * **同じ `clientMessageId` の再送は、二重に受けない（Issue #3203）。** 検査（`supersedes`・添付）より前に
         * 見る——1回目で受けた編集は、再送のときには既に「置き換え済み」で、検査へ進むと自分自身に 400 を返す。
         * 受けていれば何も積まず、`GET /chat/:conversationId/stream` と同じ形（`open` の後、進行中のターンが
         * あれば途中経過から続きを流して `done` / `error` で閉じる）で応える。`open` には
         * `duplicate: true` を付ける。**別の会話で受けていたら 409**（同じ id を別の発言に使うのは呼び手の取り違え）。
         */
        const fingerprint = clientMessageFingerprint({
          text,
          attachmentIds: attachmentIds,
          supersedes,
        });
        if (clientMessageId !== undefined) {
          const received = await findReceivedClientMessage(clientMessageId);
          if (received !== undefined) {
            return (
              rejectDuplicateClientMessage(c, received, clientMessageId, {
                conversationId: given,
                fingerprint,
              }) ?? replayReceivedMessage(c, received.conversationId, clientMessageId)
            );
          }
        }

        /*
         * **渡された会話 id は、在る会話を指していなければ断る（Issue #4149）。** 会話は日誌の人間との往復の
         * 集まりとして暗黙に在るので、確かめずに積むと、URL の打ち間違いや略記がそのまま新しい会話になる。
         * 新しい会話を始めるのは `conversationId` を省いたときだけである。重複の再送（上）より後に置く——
         * 1回目で受けた発言の再送は、日誌に載る前でも重複として応える。
         */
        if (given !== undefined && !startedConversations.has(given)) {
          const lookup = await lookupConversation(stores.journal, given);
          if (!lookup.found) {
            return c.json(
              {
                error: describeMissingConversation(given, lookup),
                code: 'conversation_not_found' as const,
              },
              404,
            );
          }
        }

        const conversationId = given ?? randomUUID();
        if (given === undefined) rememberStartedConversation(conversationId);

        /*
         * **`clientMessageId` を、`supersedes` の検証と添付の検査・結び付けより前に先取りする（Issue #3244・#3254）。**
         * 検証より後だと、同時の編集の2本目が早い確認を抜けたあと1本目が日誌へ載り、「置き換え済み」の 400 になった。
         * 同期の1歩なので、
         * 同時に届いた2本のうち片方だけが取れる。取れなかった側は、先に取った1本の検査が終わるのを待つ
         * （`await (existing.settled)`）——**重複の 200 は「受け取った」と言う応えなので、1本目が検査に落ちて
         * 取り下げたなら言えない。** そのときは取り直して、自分で検査する（同じ中身なら同じ 400、直した中身なら
         * 受かる）。待つのは添付の検査・結び付けの間だけで、1本目が日誌へ載るまでではない。
         * 取れなかった側は、別の会話なら 409（`client_message_id_conflict`）、中身が違えば 409
         * （`client_message_id_mismatch`）、同じなら重複の応え。**どれも添付には触れない。**
         * 新しい会話（`given` 無し）の重複は、こちらが引いた `conversationId` ではなく先に取った側の会話を指す。
         */
        let claim: { settle: (accepted: boolean) => void } | undefined;
        if (clientMessageId !== undefined) {
          for (;;) {
            const attempt = claimClientMessage(clientMessageId, { conversationId, fingerprint });
            if (attempt.won) {
              claim = attempt;
              break;
            }
            if (!(await (attempt.existing.settled ?? true))) continue;
            return (
              rejectDuplicateClientMessage(c, attempt.existing, clientMessageId, {
                conversationId: given,
                fingerprint,
              }) ?? replayReceivedMessage(c, attempt.existing.conversationId, clientMessageId)
            );
          }
        }

        /** 検証に落ちた送信の id は覚えない（#3208）。先取りを取り下げてから 400 を返す。 */
        const failEdit = (body: { error: string }, status: 400 | 409) => {
          claim?.settle(false);
          return c.json(body, status);
        };

        /*
         * **送信済みの人間の発言を編集する口の検証。** `clone.post` を呼ぶ前に
         * ここで弾く——弾いたときは日誌に何も積まない（`GET /journal` の
         * `afterId`/`afterAt` の手書き検証と同じ作法。手前で `if` を並べて
         * 400 を返す）。
         */
        if (supersedes !== undefined) {
          try {
            // (1) conversationId が無いのに supersedes がある。
            if (given === undefined) {
              return failEdit(
                { error: 'supersedes を指定するには conversationId が要る' as const },
                400,
              );
            }
            // 対象は `journal.get` で直接引く——`scan`/窓には縛られない、日誌
            // そのものへの厳密な問い合わせである（`conversation_read id=<id>` の
            // 全文モードと同じ考え方）。
            let target: JournalEntry | null;
            try {
              target = await stores.journal.get(supersedes);
            } catch (error) {
              // 在るが読めない行を「見つからない」（400）と言わない（issue #3288）。
              // 他の `Unreadable*Error`（承認・やり方・許可）と同じ 409 + `error.message`。
              if (error instanceof UnreadableJournalEntryError) {
                return failEdit({ error: error.message }, 409);
              }
              throw error;
            }
            // (2) 指した id が窓の中に無い / その会話のものでない。
            if (
              target === null ||
              target.type !== 'exchange' ||
              target.with !== 'human' ||
              target.conversationId !== given
            ) {
              return failEdit(
                {
                  error:
                    `supersedes が指す発言 ${supersedes} は見つからないか、この会話のものではない` as const,
                },
                400,
              );
            }
            // (3) 指した id が `role: 'outbound'`（クローンの応答）——制約(C)。
            // 編集できるのは人間の発言だけである。
            if (target.role === 'outbound') {
              return failEdit(
                { error: 'supersedes はクローンの応答ではなく人間の発言だけを指せる' as const },
                400,
              );
            }
            // (4) 指した id が既に別の編集に置き換えられている。
            //
            // **畳み込み規則（`computeSupersededIds`）でしか判定できない**ので、
            // この会話の全履歴を読む。`commitmentRespondedAt` の判定
            // （この下の `/commitments` ハンドラ）と同じ理由で、ここは「会話を
            // 1本表示する窓」ではなく「置き換え済みかどうかを判定するための
            // 全履歴」が要るため、`scan` に事実上の無制限を渡す。
            const fullHistory = await readConversationWindow(stores.journal, {
              scan: Number.MAX_SAFE_INTEGER,
            });
            const chronological = fullHistory
              .filter(
                (entry): entry is Exchange =>
                  entry.type === 'exchange' &&
                  entry.with === 'human' &&
                  entry.conversationId === given,
              )
              .reverse();
            const supersededIds = computeSupersededIds(chronological);
            if (supersededIds.has(supersedes)) {
              return failEdit(
                {
                  error:
                    `supersedes が指す発言 ${supersedes} は既に別の編集に置き換えられている` as const,
                },
                400,
              );
            }
          } catch (error) {
            claim?.settle(false);
            throw error;
          }
        }

        /*
         * **添付を発言へ結び付ける（Issue #3111 段1b）。** 会話 id が決まった後で、`clone.post` の前に
         * 行う。弾くときは受信箱に何も積まない。個数 → 存在 → 合計 → 別の会話への結び付き → `bind` の順。
         * **弾いたら（例外も）先取りを取り下げる**——検査で落ちた送信の id は覚えない（#3208）。
         */
        let attached: AttachmentBatchResult;
        try {
          attached = await checkAndBindAttachments(attachmentIds, {
            store: stores.attachments,
            limits: attachmentLimits,
            bind: (ids) => stores.attachments.bind(ids, conversationId),
            unbind: (ids) => stores.attachments.unbind(ids, { conversationId }),
            isBoundElsewhere: (meta) =>
              meta.managerReportId !== undefined ||
              (meta.conversationId !== undefined && meta.conversationId !== conversationId),
            conflictMessage: '別の会話に結び付いた添付は使えない',
            serializeKey: `conversation:${conversationId}`,
          });
        } catch (error) {
          claim?.settle(false);
          throw error;
        }
        if (!attached.ok) {
          claim?.settle(false);
          return c.json(attached.body, attached.status);
        }
        const attachmentRefs = attached.refs;
        claim?.settle(true);

        return streamSSE(c, async (stream) => {
          const pump = chatEventPump();
          const unsubscribe = clone.subscribe(conversationId, (event) => pump.push(event));

          await pump.serve(
            stream,
            { principal: c.get('principal'), authorization: c.req.header('authorization') },
            unsubscribe,
            async () => {
              /*
               * **`open` を書く前に積む。順序に意味がある。**
               *
               * `open` は「この呼びの投函はもう済んだ」の合図として読まれる。受信中に
               * 続けて打った発言を投函だけしたい呼び（Web UI の追送。2本目の購読を
               * 張ると同じ応答が二度流れるので張らない）は、`open` を見た時点で接続を
               * 捨てる。**逆順だと、捨てるのが `clone.post` より先になりうる** —
               * `stream.onAbort` が走った後にここへ来ると、積む前にこの関数から抜ける
               * 経路が生まれ、発言が黙って消える。
               *
               * 積むのを先にしておけば、以後どこで切られても発言は受信箱に在る。
               * 購読（上の `clone.subscribe`）はさらに手前で張ってあるので、`#record`
               * が出す `queued` も取りこぼさない。
               *
               * **heartbeat をこれより手前で起こしているのは順序に影響しない** —
               * heartbeat が書くのはコメント行だけで、`open` の代わりにはならない。
               */
              clone.post({
                type: 'human_message',
                id: randomUUID(),
                at: new Date().toISOString(),
                text,
                conversationId,
                ...(supersedes === undefined ? {} : { supersedes }),
                ...(attachmentRefs.length === 0 ? {} : { attachments: attachmentRefs }),
                ...(clientMessageId === undefined ? {} : { clientMessageId }),
              });

              await stream.writeSSE({
                event: 'open',
                data: JSON.stringify({
                  conversationId,
                  ...(clientMessageId === undefined ? {} : { clientMessageId }),
                }),
              });
            },
          );
        });
      },
    )
    /**
     * **`clientMessageId` から、受け取った会話を引く口**（Issue #3258）。
     *
     * 新しい会話（`conversationId` 無し）の送信が `open` の前に中断されると、送った側は会話 id を知らず、
     * 受け取られたかを履歴で確かめられない。次の送信を新しい会話として送ると、受け取り済みの添付が
     * `attachment_conflict`（400）で弾かれる。**送った側が id から会話を取り直す**ための読み取り口。
     * 引き方は `POST /chat` の重複の確認と同じ `findReceivedClientMessage`（受け取り直後の記憶と、直近の日誌）。
     * 添付の検査の途中の1本目は、その結果を待つ（落ちて取り下げられたなら 404。すぐ終わる）。
     * 副作用は無い。連携の鍵は通さない（許可表に無い GET は既定で 403）。
     */
    .get(
      '/client-messages/:clientMessageId',
      describeRoute({
        tags: ['chat'],
        summary: '`clientMessageId` から受け取った会話を引く',
        description:
          '`POST /chat` で受け取った発言の `clientMessageId` から、その会話の id を返す。' +
          '新しい会話の送信が `open` の前に中断され、会話 id を知らないときに、受け取られたかを確かめて会話を取り直すための口。' +
          '引き方は `POST /chat` の重複の確認と同じ（直近の日誌の人間との往復200件と、受け取り直後の記憶）。' +
          '受け取っていない（検査に落ちて取り下げられた分を含む）・遡れる範囲に無いときは 404。',
        responses: {
          200: {
            description: '受け取り済み。その会話の id。',
            content: {
              'application/json': { schema: resolver(clientMessageLookupResponseSchema) },
            },
          },
          400: {
            description: '`clientMessageId` の形が不正（英数字・`_` `-` の1〜128字）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '受け取っていない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const parsed = clientMessageIdSchema.safeParse(c.req.param('clientMessageId'));
        if (!parsed.success) {
          return c.json({ error: 'clientMessageId は英数字・_ - の1〜128字' as const }, 400);
        }
        const received = await findReceivedClientMessage(parsed.data);
        if (received === undefined) {
          return c.json({ error: '受け取っていない clientMessageId' as const }, 404);
        }
        return c.json({ conversationId: received.conversationId });
      },
    )

    /**
     * **進行中のターンの途中経過に戻る口**（Issue #2652）。
     *
     * `POST /chat` は投函と購読が一体で、画面を離れた・読み込み直した人間は、進行中の
     * ターンの「考えている」と途中の文章を失い、続きにも戻れなかった。これは**投函せずに
     * 購読だけを張る**。いままでの分（`Clone#attach` の `inProgress`）を先に流し、続きを
     * 流して、`done` / `error` で閉じる。進行中でなければ `open` だけ流して閉じる。
     * 認証・心拍・資格の確かめ直しは `POST /chat` と同じ骨（`chatEventPump`）を通る。
     */
    .get(
      '/chat/:conversationId/stream',
      describeRoute({
        tags: ['chat'],
        summary: '進行中のターンの途中経過に戻る（SSE）',
        description:
          '発言を投函せずに、会話の購読だけを張る。**SSE。** 最初に `open`（' +
          '`{conversationId, inProgress, pending}`）を流す。`pending` は、その会話でいま答えを待っている' +
          '発言（`POST /chat` の `clientMessageId` を持つものだけ）の `[{clientMessageId, state}]`。' +
          '`state` は `running`（ターンが走っている）・`starting`（取り出し済みでターンはまだ）・' +
          '`held`（利用上限の枠で保持）・`queued`（受信箱で順番待ち）。並びは `running` / `starting`、' +
          '`held`、`queued`（古い順）。まとめ読みされた発言は、そのターンの分がすべて同じ state で載る。' +
          '誰が打った発言かは区別しない。無ければ `[]`。`inProgress` が true なら、そのターンで' +
          'いままでに出た分（`queued` / `thinking` / `tool` / `text` / `ask_human` / ' +
          '`usage_limited` / `attachments`（クローンが返信に添えた添付の控え。中身は ' +
          '`GET /attachments/:id`）。隣り合う `text` は1つにまとめてある）を先に流し、続きを流して、' +
          '`done` / `error` で閉じる。false なら `open` だけで閉じる（進行中のターンが' +
          '無い。会話の中身は `GET /conversations/:id` が持つ）。' +
          '**いままでの分と続きの継ぎ目で、取りこぼしも二重渡しも起きない。** ' +
          '`POST /chat` と同じく、**コメント行（`:` で始まる行）の heartbeat が周期的に' +
          '流れる**ほか、開いている間も資格を確かめ直す（失効したら `error` を1つ流して' +
          '閉じる）。人間がこの口を閉じてもターンは走り続ける。',
        responses: {
          200: {
            description: 'SSE ストリーム。',
            content: {
              'text/event-stream': { schema: resolver(chatStreamEventSchema) },
            },
          },
          404: {
            description:
              'この会話は削除されている（`code: conversation_deleted`。#4218）。走り続けているターンの途中経過も見せない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          503: {
            description: 'この器は途中経過を持たない（能力を落とさず、黙って隠さない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        if (clone.attach === undefined) {
          return c.json({ error: 'この器は進行中のターンの途中経過を持たない' as const }, 503);
        }
        const attach = clone.attach.bind(clone);
        const conversationId = c.req.param('conversationId');
        if (await isConversationDeleted(stores.journal, conversationId)) {
          return c.json(
            { error: 'この会話は削除されている' as const, code: 'conversation_deleted' as const },
            404,
          );
        }

        return streamSSE(c, async (stream) => {
          const pump = chatEventPump();
          // **写しを取ることと購読を張ることは `attach` の中で同じ同期区間に入る。**
          // ここから `await` を挟む前に呼ぶこと（挟むと継ぎ目に出来事が割り込む）。
          const { inProgress, pending, unsubscribe } = attach(conversationId, (event) =>
            pump.push(event),
          );
          // 進行中でなければ流すものは無い。`open` を書く間に届く分を溜めない。
          if (inProgress === null) pump.finish();

          await pump.serve(
            stream,
            { principal: c.get('principal'), authorization: c.req.header('authorization') },
            unsubscribe,
            async () => {
              await stream.writeSSE({
                event: 'open',
                data: JSON.stringify({ conversationId, inProgress: inProgress !== null, pending }),
              });
              // いままでの分が先、続き（`pump` の列）が後。`pump` の列に入っているのは
              // `attach` より後の出来事だけなので、順序も重複も崩れない。
              for (const event of inProgress ?? []) {
                await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
              }
            },
          );
        });
      },
    )

    /** 会話の終了 = 蒸留の契機。CLI が chat を抜けるときに叩く。 */
    .post(
      '/chat/:conversationId/end',
      describeRoute({
        tags: ['chat'],
        summary: '会話の終了（蒸留の契機）',
        description:
          '会話の終了 = 蒸留の契機。CLI が chat を抜けるときに叩く。運ぶ情報は無い（`{}` を送る）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストで蒸留ターンを' +
            '起こされないため）。',
        ),
        responses: {
          200: {
            description: '蒸留を促した。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      async (c) => {
        await clone.endConversation(c.req.param('conversationId'));
        return c.json({ ok: true });
      },
    )

    /**
     * **いま走っているクローンのターンを止める**（#1398 c23-1）。
     *
     * それまで人間が走行中のクローンのターンを止める口は、どの入口にも無かった。
     * 止めるのはいまのターンだけで、セッション（会話の続き）と受信箱には触らない
     * （`Clone#interruptTurn` の doc）。資格は `/chat/:conversationId/end` と同じ
     * （会話を持てる人は、自分が起こしたターンを止められる）。
     */
    .post(
      '/clone/interrupt',
      describeRoute({
        tags: ['chat'],
        summary: 'いま走っているクローンのターンを止める',
        description:
          'セッションと受信箱はそのまま残る（次の合図で次のターンが始まる）。' +
          '走っているターンが無ければ outcome: idle。止めたことは日誌に [判断] の1行で残る。' +
          '**対象（`conversationId` と `clientMessageId`）を渡すと、その発言のターンしか止めない（#3956）。** ' +
          'その発言のターンが走っていれば `interrupted`。まだ順番待ちなら受信箱の行ごと取り下げて配らず ' +
          '`withdrawn`（発言の日誌の行は残り、取り下げたことが [判断] の1行で足される）。' +
          '走っているのが別の起点のターンなら止めず `not_target`。発言は取り出し済みでターンがまだ始まって' +
          'いなければ `starting`（もう一度呼べば止まる）。答え終わっていれば `idle`。' +
          '対象を省く（`{}`）と、種類を問わず走っているターンを止める（従来どおり）。',
        requestBody: {
          required: true,
          description:
            '`{}` または `{ conversationId, clientMessageId }`（片方だけは 400）。' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストでターンを止められないため）。',
          content: { 'application/json': { schema: resolver(cloneInterruptRequestSchema) } },
        },
        responses: {
          200: {
            description:
              '止めた・取り下げた・別のターンなので止めなかった・止めるものが無かった・この器では止められない、のどれか。',
            content: { 'application/json': { schema: resolver(cloneInterruptResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正。または対象が片方しか無い・形が不正。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      async (c) => {
        // 本文なし・`{}` は従来どおり「対象なし」。壊れた JSON を対象なしとは読まない（別の仕事を止めるため）。
        const rawText = await c.req.text();
        let raw: unknown = {};
        if (rawText.trim() !== '') {
          try {
            raw = JSON.parse(rawText);
          } catch {
            return c.json({ error: '本文が JSON として不正' as const }, 400);
          }
        }
        const parsed = cloneInterruptRequestSchema.safeParse(raw);
        if (!parsed.success) {
          return c.json(
            { error: `入力の形が不正: ${whereValidationFailed(parsed.error.issues)}` },
            400,
          );
        }
        const { conversationId, clientMessageId } = parsed.data;
        if ((conversationId === undefined) !== (clientMessageId === undefined)) {
          return c.json(
            { error: 'conversationId と clientMessageId は2つとも渡すか、2つとも省く' as const },
            400,
          );
        }
        if (clone.interruptTurn === undefined) {
          return c.json(cloneInterruptResponseSchema.parse({ outcome: 'unsupported' }));
        }
        const outcome =
          conversationId === undefined || clientMessageId === undefined
            ? await clone.interruptTurn()
            : await clone.interruptTurn({ conversationId, clientMessageId });
        return c.json(cloneInterruptResponseSchema.parse({ outcome }));
      },
    )

    /**
     * **クローンのセッションを resume せずに新しく開き直す**（#4173）。
     *
     * 安全分類器（safeguards）に弾かれる内容が長寿命のセッションへ入ると、以後のターンが
     * 全部弾かれ、デーモンを再起動しても resume で同じ生ログが戻るので抜けられない。
     * 人間だけがここから抜けられる。資格は `/reset` と同じ（`requireOwner`）。
     * `confirm: true` を必須にする（`resetRequestSchema` と同じ理由）。
     */
    .post(
      '/clone/session/reopen',
      describeRoute({
        tags: ['chat'],
        summary: 'クローンのセッションを resume せずに開き直す',
        description:
          'クローンの SDK セッションを、resume せず新しく開き直す。**生ログは消さない**' +
          '（古いセッションの生ログはアーカイブへ退避され、会話の記録も残る）。' +
          '**走っているターンは最後まで走り**（outcome: deferred。ターンの境界で開き直す）、' +
          'セッションが無ければ outcome: now（次に開くセッションから resume しない）。' +
          '**`distill` の既定は false**——安全分類器に弾かれているセッションの末尾を記憶の蒸留へ送ると、' +
          '送った先でまた弾かれて墓標が立ち、起動のたびに同じ末尾を送り直す。通れば汚れた内容を記憶へ' +
          '書き込む。蒸留したいときだけ `distill: true` を渡す。' +
          '**マネージャーは止めない**（その報告は新しいセッションへ届く。`runningManagers` は走っている数で、' +
          '取れなかったときは欄が無い）。新しいセッションの最初のターンに、開き直したこと・理由・古い' +
          'session id・退避した archive id（`GET /archive/:id` で読める）がクローンへ1度だけ伝わる。' +
          '受けたことと開き直したことは日誌に [判断] の行で残る。',
        requestBody: {
          required: true,
          description:
            '`{ confirm: true, distill?, reason? }`。`confirm: true` が無ければ 400。' +
            '`reason` は 1〜500 字（省略時は「人間の操作」）。',
          content: { 'application/json': { schema: resolver(cloneSessionReopenRequestSchema) } },
        },
        responses: {
          200: {
            description:
              '開き直す印を立てた（now / deferred）。この器では開き直せないなら unsupported。',
            content: {
              'application/json': { schema: resolver(cloneSessionReopenResponseSchema) },
            },
          },
          400: {
            description: '`confirm: true` を伴っていない、または形が不正。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      jsonBody(cloneSessionReopenRequestSchema, (where) => ({
        error:
          '`confirm: true` を伴っていないか、形が不正（セッションの開き直しは確認を必須にしてある。' +
          `reason は 1〜500 字）${where === '' ? '' : `: ${where}`}`,
      })),
      async (c) => {
        if (clone.reopenSession === undefined) {
          return c.json(cloneSessionReopenResponseSchema.parse({ outcome: 'unsupported' }));
        }
        const body = c.req.valid('json');
        const result = await clone.reopenSession({
          reason: body.reason ?? '人間の操作',
          distill: body.distill ?? false,
          actor: describeActor(c.get('principal')),
        });
        return c.json(cloneSessionReopenResponseSchema.parse(result));
      },
    )

    // --- 会話（続きから話せること自体が要件） -------------------------------
    /**
     * 会話の一覧。
     *
     * **`POST /chat` の SSE は流すだけで、後から読み直す口が無かった。** その口が
     * 無いと、器（端末・タブ・アプリ）を替えた瞬間に会話が消える。人間が同じ
     * クローンと話し続けられないなら、それは器の都合が能力を削っている
     * （north_star 禁止1）。
     *
     * 日誌から組み立てているので、新しく持つ状態は無い。追記専用の記録が
     * そのまま会話の履歴になる。
     */
    .get(
      '/conversations',
      describeRoute({
        tags: ['conversations'],
        summary: '会話の一覧',
        description:
          '`POST /chat` の SSE は流すだけで読み直す口が無かった。器（端末・タブ・アプリ）' +
          'を替えても続きから話せるための一覧。日誌から組み立てるので新しい状態は持たない。' +
          '新しい順。`scanned` は人間との往復を何件遡ったか（マネージャーとの往復・内部' +
          'ターンは数えない。issue #418）、`reachedStart` はその窓が日誌の先頭に届いたかで、' +
          '遡り切れていないことが分かる（黙って打ち切らない）。`hiddenByLimit` は、その窓の' +
          '**中で** `limit` に収まらず落とした会話の数（窓の外は数えていない）。' +
          '続きが在る（`hiddenByLimit > 0` か `reachedStart` が偽）ときは `nextCursor` が載り、' +
          '次の呼びの `cursor` へそのまま渡すと、その続き（窓の外も含む）から読める。' +
          '`/approvals` / `/commitments` と同じ形で、続きが無ければ `nextCursor` は無い。' +
          '壊れた `cursor`・指す発言が見当たらない `cursor` は 400。',
        responses: {
          200: {
            description: '会話の一覧（新しい順）。',
            content: { 'application/json': { schema: resolver(conversationsResponseSchema) } },
          },
          400: {
            description: 'クエリが不正、または `cursor` が壊れている・指す発言が見当たらない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      queryParams(conversationsQuery),
      async (c) => {
        const { limit, scan, cursor } = c.req.valid('query');
        // 符号化はクローンの道具（`conversation_read`）と同じ関数（core）を通す。
        let cursorPayload: ConversationCursor | undefined;
        if (cursor !== undefined) {
          const decoded = decodeConversationCursor(cursor);
          if (decoded === null) return c.json({ error: new InvalidCursorError().message }, 400);
          cursorPayload = decoded;
        }
        /**
         * 既読の記録は全員で1組（`ConversationReadStore`）。基準時刻が無ければここで決める
         * （どの経路でも決まる）。数え方は `collectConversations` が持つ——ここで数え直さない。
         */
        const readView = await loadConversationReadView(
          stores.conversationReads,
          (deps.now ?? (() => new Date()))().toISOString(),
        );
        /**
         * 窓の組み立て（`types: ['exchange']` と `with: ['human']`）も、畳み直しの規則も、継続点で
         * 頁を送る規則も `@alteroid/core`（`conversation.ts` の `readConversationPage`）が持つ。
         * ここで手組みし直さない — 手組みし直した場所ができるたびに `with` を絞り忘れる余地が
         * 生まれる（issue #418 の症状そのもの）。**クローンの道具（`conversation_read`）と同じ
         * 規則を通す**ので、人間には見えるがクローンには見えない、が増えない。
         */
        let page: Awaited<ReturnType<typeof readConversationPage>>;
        try {
          page = await readConversationPage(stores.journal, {
            limit,
            scan,
            readView,
            ...(cursorPayload === undefined ? {} : { cursor: cursorPayload }),
          });
        } catch (error) {
          // **継続点が指す発言が見当たらないのは、判定できないという第3の状態である。** 黙って先頭から
          // 返さず 400 にする（`GET /journal` の `JournalAnchorNotFoundError` と同じ）。
          if (error instanceof InvalidConversationCursorError) {
            return c.json({ error: error.message }, 400);
          }
          throw error;
        }
        const conversations = page.conversations.map(({ unread, ...summary }) => ({
          ...summary,
          unreadCount: unread,
        }));
        return c.json({
          conversations,
          ...(readView.unreadable === undefined
            ? {}
            : { readStateUnreadable: readView.unreadable }),
          /**
           * 遡った範囲。**人間との往復を何件見たか**（`readConversationWindow` が `with: ['human']` を
           * `limit` より前で効かせるため。issue #418）。`cursor` を渡した呼びでは、その継続点より
           * 古い側から数える。窓の外の会話は、`nextCursor` を辿れば出てくる。
           */
          scanned: page.scanned,
          /**
           * 窓（`scan`）が日誌の先頭に届いたか。**`GET /conversations/:id` と同じ関数・同じ意味で
           * 揃えてある**（`reachedStart`。`@alteroid/core`）— 窓が出し切れているかを言うだけで、
           * `limit` とは無関係（`limit` の側は `hiddenByLimit` が持つ）。
           */
          reachedStart: page.reachedStart,
          /**
           * **この窓の中で** `limit` に収まらず落とした会話の数。`nextCursor` を辿れば出てくる。
           *
           * ⚠️ **窓の中の数であって、窓の外は数えていない。** `reachedStart` が偽なら、この窓より
           * さらに古い会話が在りうる（この数には現れない）。そのときも `nextCursor` が載る。
           *
           * `conversation_read`（`packages/core/src/tools.ts` の `hiddenByLimit`）と名前を揃えてある。
           */
          hiddenByLimit: page.hiddenByLimit,
          /**
           * 続きが在るときだけ載る継続点（`cursor` へそのまま渡す。`/approvals` / `/commitments` と
           * 同じ名前・同じ形）。**`hiddenByLimit > 0` か `reachedStart === false` のどちらかなら載る**
           * ——窓の外が残るのに黙って途切れない。無ければ鍵ごと無い（既存の応答は1バイトも変わらない）。
           * `reachedStart: false` のときは「窓が `scan` 件ちょうどだった」だけのこともあるので、
           * 辿った先が空で終わることはある（安全側）。
           */
          ...(page.next === null ? {} : { nextCursor: encodeConversationCursor(page.next) }),
        });
      },
    )

    /**
     * 未読のある会話の数だけを返す軽い口（左ナビの札用。全ページから呼ばれる）。
     * **`/conversations/:id` より前に置くこと**（`:id` に `unread-count` が食われる）。
     */
    .get(
      '/conversations/unread-count',
      describeRoute({
        tags: ['conversations'],
        summary: '未読のある会話の数',
        description:
          '未読のある会話の数（全会話で数える。直近の一覧には限らない）。**日誌を広く遡らない** — ' +
          '会話ごとの最後のクローン側発言の時刻の索引（日誌の写し）を、前回の続きから' +
          '新しく積まれた分だけ足して数える。未読の会話が上限（99）を超えるとき、または長い' +
          '不在のあとの取り込みが1回に収まらないときは `capped: true`（`count` は下限。UI は「N+」）。' +
          '一覧の `unreadCount` との差が出うるのは、編集で畳まれた返答が会話の最後のクローン側発言のとき' +
          '（その会話を開いて既読にすれば揃う）。既読の記録が読めないときは `readStateUnreadable` が載る。',
        responses: {
          200: {
            description: '未読のある会話の数。',
            content: {
              'application/json': { schema: resolver(unreadConversationCountResponseSchema) },
            },
          },
        },
      }),
      async (c) => {
        const result = await countUnreadConversations({
          journal: stores.journal,
          reads: stores.conversationReads,
          now: (deps.now ?? (() => new Date()))().toISOString(),
        });
        return c.json(result);
      },
    )

    /** 1つの会話の中身（古い順）。器を替えても続きから話せるための口。 */
    .get(
      '/conversations/:id',
      describeRoute({
        tags: ['conversations'],
        summary: '1つの会話の中身（古い順）',
        description:
          '1つの会話の中身（古い順）。器を替えても続きから話せるための口。' +
          '**黙って打ち切らない** — `scanned`（人間との往復を何件遡ったか。マネージャー' +
          'との往復・内部ターンは数えない。issue #418）でどこまで遡ったか、' +
          '`reachedStart` で窓が日誌の先頭に届いたかを返す。`404` は `reachedStart` が' +
          '真のときだけ返る（「無い」と「遡り切れていない」を同じ応答にしないため）。' +
          '**既定（`includeSuperseded` を渡さない）では、チャットで編集され既定ビューから' +
          '畳まれた旧発言・その応答を除く。** 応答の `supersededCount` に畳まれた件数を' +
          '常に含める（0件でも含める）。`includeSuperseded=true` を渡すと畳まれた分も' +
          '含めて返し、各発言に編集の関係（`supersedes` / `supersededBy`）が付く。',
        responses: {
          200: {
            description:
              '会話の中身。`reachedStart` が偽なら、窓の外に続きが残っている可能性がある。' +
              '`messages` が空でこれが偽の場合は「無い」ではなく**判定できない**。',
            content: {
              'application/json': { schema: resolver(conversationDetailResponseSchema) },
            },
          },
          400: {
            description: 'クエリが不正。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description:
              '該当する会話が無い（内部ターン `self` は含まれない）。**遡り切れた場合だけ** — ' +
              '窓の外かもしれないときは 200 で `reachedStart: false` を返す。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      queryParams(conversationQuery),
      async (c) => {
        const id = c.req.param('id');
        const { scan, includeSuperseded: includeSupersededRaw } = c.req.valid('query');
        const includeSuperseded = includeSupersededRaw === 'true';
        // 窓の組み立ては `readConversationWindow` 1か所に閉じる（上の
        // `GET /conversations` と同じ理由。issue #418）。
        const entries = await readConversationWindow(stores.journal, { scan });
        /**
         * 絞り込みと並べ直しは `@alteroid/core` の `conversationMessages` が持つ
         * （クローンの `conversation_read` と同じ関数である。上の一覧と同じ理由）。
         *
         * **常に `includeSuperseded: true` で1回だけ呼ぶ。** 既定の応答でも
         * `supersededCount`（畳まれた件数）を数える必要があるため、まず畳まれた分も
         * 含めて取り、既定ビューに戻すかどうかはここで自分でふるう
         * （`conversation_read` と同じ考え方。`packages/core/src/tools.ts`）。
         *
         * **応答に載せる項目はここで選び直す。** 共有の型は `conversationId` も
         * 持っているが、この口の応答スキーマ（`conversationMessageSchema`）は
         * 明示した項目だけなので、**移設で応答が1項目増えることのないよう**明示して写す。
         */
        const allMessages = conversationMessages(entries, id, { includeSuperseded: true });
        const supersededCount = allMessages.filter(
          (message) => message.supersededBy !== undefined,
        ).length;
        const visible = includeSuperseded
          ? allMessages
          : allMessages.filter((message) => message.supersededBy === undefined);
        /*
         * **取り下げた発言に `delivery: 'withdrawn'` を付ける**（#3990）。根拠は取り下げのときに日誌へ足す
         * 印の行（`withdrawnClientMessageId`）で、発言の `clientMessageId` と結ぶ。進行中の状態
         * （走っている・順番待ち）は `GET /chat/:id/stream` の `open.pending` が持つので、ここでは持たない。
         */
        const idsToCheck = visible.filter(
          (message) => message.role === 'inbound' && message.clientMessageId !== undefined,
        );
        const withdrawnIds =
          idsToCheck.length === 0
            ? new Set<string>()
            : await readWithdrawnClientMessageIds(
                stores.journal,
                id,
                idsToCheck.reduce(
                  (oldest, message) => (message.at < oldest ? message.at : oldest),
                  idsToCheck[0]!.at,
                ),
              );
        const messages = visible.map((message) => ({
          id: message.id,
          at: message.at,
          /** `inbound` = 人間の発言 / `outbound` = クローンの返答。 */
          role: message.role,
          text: message.text,
          ...(message.role === 'inbound' &&
          message.clientMessageId !== undefined &&
          withdrawnIds.has(message.clientMessageId)
            ? { delivery: 'withdrawn' as const }
            : {}),
          ...(message.supersedes === undefined ? {} : { supersedes: message.supersedes }),
          ...(message.supersededBy === undefined ? {} : { supersededBy: message.supersededBy }),
          ...(message.turnFailure === undefined ? {} : { turnFailure: message.turnFailure }),
          ...(message.turnFailureKind === undefined
            ? {}
            : { turnFailureKind: message.turnFailureKind }),
          // 添付のメタデータ（中身は `GET /attachments/:id`）。無い発言には載せない。
          ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
          ...(message.clientMessageId === undefined
            ? {}
            : { clientMessageId: message.clientMessageId }),
        }));

        /*
         * **窓が日誌の先頭に届いたかを、返す件数から言う。**
         *
         * ストアは新しい順に最大 `limit` 件返すので、返ってきた数が頼んだ数に
         * 届かなければ、それ以上は無い＝先頭まで見た、と言える。ちょうど同数の
         * ときは**まだあるかもしれない**ので届いていない側へ倒す（安全側）。
         * 全件がぴったり `scan` 件だった場合に「判定できない」と答えるのは、
         * 実際には見切っているのに保守的に言いすぎるだけで、逆はやらない。
         *
         * **#418 より前は `entries.length` が「日誌の `exchange` を何件見たか」
         * だった。** この判定式（`reachedStart`）自体は昔から安全側 — `false`
         * へ倒すだけで、実際には見切れていないのに `true` を返すことは無い。
         * 変わったのは**中身**である。`readConversationWindow` が
         * `with: ['human']` を `limit` より前で効かせるいまは、`entries` が
         * 最初から人間との往復だけなので `entries.length` は「人間との往復を
         * 何件見たか」になる。以前は `with: 'manager'` / `with: 'self'` の行が
         * 同じ `scan` の予算を分け合っていたため、`scan` 件に達する（＝
         * `reached: false` になる）のが実際の人間の会話をわずかしか遡らない
         * うちに起きていた——`false` という答え自体は正しくても、その `scan`
         * を「人間との会話をどこまで遡ったか」の目安には使えなかった。
         *
         * 判定そのものは `reachedStart`（`@alteroid/core`）が持つ。
         */
        const reached = reachedStart(entries.length, scan);

        /*
         * **「無い」と「遡り切れていない」を同じ応答にしない。**
         *
         * ここを一律 404 にしていたので、`scan` の窓より古い会話が「そんな会話は
         * 無い」として返っていた。呼ぶ側から見ると、消えた会話と、まだ見ていない
         * 会話が区別できない（判定できないことが出力から消えていた）。
         *
         * 遡り切れているなら「無い」と言ってよい。切れていないなら、空の結果に
         * `reachedStart: false` を添えて返し、判定は呼ぶ側へ渡す。
         */
        if (messages.length === 0 && reached) {
          return c.json({ error: 'not found' as const }, 404);
        }
        const readView = await loadConversationReadView(
          stores.conversationReads,
          (deps.now ?? (() => new Date()))().toISOString(),
        );
        const readThrough = effectiveReadThrough(readView, id);
        return c.json({
          conversationId: id,
          messages,
          readThrough,
          // 既定ビューで見えている発言で数える（`includeSuperseded` に左右されない）。
          unreadCount: countUnread(
            allMessages.filter((message) => message.supersededBy === undefined),
            readThrough,
          ),
          ...(readView.unreadable === undefined
            ? {}
            : { readStateUnreadable: readView.unreadable }),
          /** 人間との往復を何件遡ったか（`scanned` の意味は上のコメントに書いた）。 */
          scanned: entries.length,
          reachedStart: reached,
          /**
           * この会話で、編集によって既定ビューから畳まれた発言の件数
           * （`includeSuperseded` の値によらず常に含める。⚠️ 制約(A)——出ないと
           * クローンだけでなく人間の側の器も畳まれた版の存在に気づけない）。
           */
          supersededCount,
        });
      },
    )

    /**
     * 会話を既読にする。**`through` は発言の id で、時刻は日誌から引く**（クライアントから
     * 時刻を受け取らない——「いま」で既読にして、見ていない分まで既読にする誤りを構造で防ぐ）。
     */
    .post(
      '/conversations/:id/read',
      describeRoute({
        tags: ['conversations'],
        summary: '会話を既読にする（位置を進める）',
        description:
          '既読の位置（全員で1組）を、`through` で指した発言の時刻まで進める。**`through` は' +
          '発言の id**（`GET /conversations/:id` の `messages[].id`）で、時刻はサーバが日誌から' +
          '引く。**戻らない**——いまの位置より古い発言を指しても何も変わらず、200 でいまの' +
          '位置を返す。発言が無い・人間との往復でないときは 404、別の会話の発言のときは 400。' +
          '応答は進めた後の実効の位置と未読数（一覧・詳細と同じ数え方。窓は既定の `scan`）。',
        responses: {
          200: {
            description: '進めた後の実効の既読の位置と未読数。',
            content: { 'application/json': { schema: resolver(conversationReadResponseSchema) } },
          },
          400: {
            description: '本文が不正、または `through` の発言がこの会話のものでない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '`through` の発言が日誌に無い（人間との往復でない場合を含む）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '`through` の発言は日誌に**在るが読めない**（形が合わない壊れた行。404 の「無い」とは別。' +
              '既読の位置は動かしていない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(conversationReadRequestSchema),
      async (c) => {
        const id = c.req.param('id');
        const { through } = c.req.valid('json');
        let target: JournalEntry | null;
        try {
          target = await stores.journal.get(through);
        } catch (error) {
          // 在るが読めない行を「見つからない」（404）と言わない（issue #3288）。
          // **既読の位置は動かしていない。**
          if (error instanceof UnreadableJournalEntryError) {
            return c.json({ error: error.message }, 409);
          }
          throw error;
        }
        if (target === null || target.type !== 'exchange' || target.with !== 'human') {
          return c.json({ error: `発言 ${through} は見つからない` as const }, 404);
        }
        if (target.conversationId !== id) {
          return c.json(
            {
              error: `発言 ${through} はこの会話のものではない。**既読の位置は動かしていない。**`,
            },
            400,
          );
        }
        const now = (deps.now ?? (() => new Date()))().toISOString();
        // 基準時刻が無ければ先に決める（位置より後に基準時刻が決まる順を作らない）。
        await stores.conversationReads.ensureBaseline(now);
        await stores.conversationReads.advance(id, target.at);
        const readView = await loadConversationReadView(stores.conversationReads, now);
        const entries = await readConversationWindow(stores.journal, {
          scan: conversationsQuery.shape.scan.parse(undefined),
        });
        const readThrough = effectiveReadThrough(readView, id);
        const visible = conversationMessages(entries, id);
        return c.json({
          conversationId: id,
          readThrough,
          unreadCount: countUnread(visible, readThrough),
          ...(readView.unreadable === undefined
            ? {}
            : { readStateUnreadable: readView.unreadable }),
        });
      },
    )

    /**
     * **会話を論理削除する（Issue #4218）。** 間違えて秘密を書いた、などのため。
     *
     * 日誌に墓標を1行積み、その会話の発言を日誌のどの読む口からも外す（行は書き換えない）。
     * 添付と台帳の行は物理的に消し、受信箱の未処理の発言を外し、進行中の購読を閉じる。
     * 本体は `@alteroid/core` の `deleteConversation`。**クローンの道具には同じ口を作らない**
     * （オーナーの指定。消すのは持ち主の判断である）。
     */
    .delete(
      '/conversations/:id',
      describeRoute({
        tags: ['conversations'],
        summary: '会話を削除する（論理削除。どの読む口からも出なくなる）',
        description:
          '日誌に監査の墓標（`conversation_deleted`。誰が・いつ・どの会話を・何件）を1行積み、その会話の発言を' +
          '`GET /conversations`・`/conversations/:id`・未読数・`GET /journal`・`/journal/stream`・' +
          'クローンの `conversation_read` / `journal_read` を含む、日誌を読むすべての口から外す。' +
          '**本文はどこにも写さない。** 日誌の行は書き換えない（DB には残る。論理削除）。' +
          'その会話の発言に付いた添付と、台帳（`/commitments`）のその会話の行は物理的に消す。' +
          '受信箱の未処理の発言を外し、開いている `GET /chat/:id/stream` を閉じる（以後は 404）。' +
          '消した会話へは書けない（`POST /chat` は 404）。' +
          '**消せないもの**（クローンの SDK セッションの生ログ・archive・いまの文脈・蒸留済みの記憶・日報）は `remainsIn` に文で返す。' +
          '墓標の後の手当てが落ちたら、会話は外れたまま `incomplete` にそれを返す（200）。',
        responses: {
          200: {
            description: '削除した。',
            content: {
              'application/json': { schema: resolver(conversationDeleteResponseSchema) },
            },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント、または連携の鍵。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description:
              'その会話は無い（既に削除済みを含む。`code: conversation_not_found`）。前方一致では消さない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      async (c) => {
        const id = c.req.param('id');
        const result = await deleteConversation(
          {
            stores,
            dropQueuedInboxEvents: (ids) => clone.dropQueuedInboxEvents(ids),
            ...(clone.forgetConversation === undefined
              ? {}
              : {
                  forgetConversation: (conversationId) =>
                    clone.forgetConversation?.(conversationId),
                }),
          },
          { conversationId: id, deletedBy: uploaderOf(c.get('principal')) },
        );
        if (!result.deleted) {
          return c.json(
            {
              error: describeMissingConversation(id, result.lookup),
              code: 'conversation_not_found' as const,
            },
            404,
          );
        }
        // このプロセスのメモリに残る会話 id の控えも落とす（消した会話を「振った id」として受け直さない）
        startedConversations.delete(id);
        for (const [clientMessageId, received] of receivedClientMessages) {
          if (received.conversationId === id) receivedClientMessages.delete(clientMessageId);
        }
        // スキーマを通して、応答に載せる欄を明示したものだけにする（`deleted` の判別子は落ちる）
        return c.json(conversationDeleteResponseSchema.parse(result));
      },
    )

    /**
     * 出来事の流れ（SSE）。**日誌に載ったものがそのまま流れる。**
     *
     * 聞きに行かないと分からない状態だと、承認待ちが出たことに人間は気づけない。
     * 画面が数秒ごとに聞き直すのは、その穴を器の側で埋めているだけである。
     *
     * ここで種別を選り分ける表を持たない（`type` の絞り込みは**呼ぶ側**が指定する）。
     * 見えない層を作らないための口で選別を始めたら、意味が消える。
     */
    .get(
      '/journal/stream',
      describeRoute({
        tags: ['journal'],
        summary: '日誌の追記をそのまま流す（SSE）',
        description:
          '日誌に載ったものがそのまま流れる（聞きに行かなくても承認待ちの発生に気づける）。' +
          '**SSE。** `event:` に日誌エントリ種別（`open` に加え、`exchange` / `decision` / ' +
          '`escalation` / `tool_use` / `memory_update` / `daily_report` / ' +
          '`external_event`）、`data:` に日誌エントリ本体（`open` は `{ok:true}` のみ別枠）。' +
          '`type` クエリで絞り込めるが、選り分ける表は持たない（絞り込みは呼ぶ側が決める）。' +
          '**コメント行（`:` で始まる行）の heartbeat が周期的に流れる。SSE の仕様上' +
          'クライアントは読み捨ててよい**（無音のまま死んだ接続を掃除するための送信でもある）。',
        responses: {
          200: {
            description: 'SSE ストリーム。',
            content: { 'text/event-stream': { schema: resolver(journalEntrySchema) } },
          },
          400: {
            description: 'クエリが不正。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          503: {
            description: '出来事の流れが配線されていない（能力を落とさず、黙って隠さない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      queryParams(journalStreamQuery),
      (c) => {
        const bus = deps.journalEvents;
        if (bus === undefined) {
          return c.json({ error: '出来事の流れが配線されていない' as const }, 503);
        }
        const types = c.req
          .valid('query')
          .type?.split(',')
          .filter((value) => value.length > 0);

        return streamSSE(c, async (stream) => {
          const queue: JournalEntry[] = [];
          let wake: (() => void) | null = null;
          let closed = false;

          const unsubscribe = bus.subscribe((entry) => {
            if (types !== undefined && !types.includes(entry.type)) return;
            queue.push(entry);
            wake?.();
          });

          // **`try` は `subscribe()` の直後から始める。**（`/chat` と同じ理由。
          // `open` の書き込みが将来投げても、購読が漏れないようにする。）
          try {
            stream.onAbort(() => {
              closed = true;
              wake?.();
            });

            // heartbeat は SSE のコメント行を流す（クライアントは読み捨てる）。
            // 死んだ接続の掃除の契機でもある（詳細は `@alteroid/core` の `sse-heartbeat.ts`）。
            // **1拍ごとに資格も確かめ直す**（issue #1820）。使えなくなったら閉じるだけで、
            // 理由のイベントは流さない——この流れのデータは日誌の1件の形で読まれるので、
            // 日誌でないものを混ぜない（読み手は切断として扱い、張り直しで 401 を受ける）。
            const credential = watchSseCredential(
              c.get('principal'),
              c.req.header('authorization'),
            );
            const stopHeartbeat = startSseHeartbeat(
              stream,
              sseHeartbeatMs,
              () => wake?.(),
              () => credential.tick(() => wake?.()),
            );

            try {
              await stream.writeSSE({ event: 'open', data: JSON.stringify({ ok: true }) });

              for (;;) {
                if (closed || credential.lost() || stream.aborted || stream.closed) break;
                const entry = queue.shift();
                if (entry === undefined) {
                  await new Promise<void>((resolve) => {
                    wake = resolve;
                  });
                  wake = null;
                  continue;
                }
                await stream.writeSSE({ event: entry.type, data: JSON.stringify(entry) });
              }
            } finally {
              stopHeartbeat();
            }
          } finally {
            unsubscribe();
          }
        });
      },
    )

    // --- 稼働の地図 -----------------------------------------------------------
    /**
     * 稼働の地図（人間 ↔ クローン ↔ 記憶、クローン ↔ マネージャー ↔ 作業者）。
     *
     * **デーモンが既に持っているものだけで組む。** 取れないものは `unknown` と言い、取れた
     * ふりをしない。線は最後の活動の時刻だけを返す（「いま流れている」の閾値は読み手が決める）。
     * 経路は1本で、Web UI の地図も `alteroid topology` も同じものを見る。
     */
    .get(
      '/topology',
      describeRoute({
        tags: ['topology'],
        summary: '稼働の地図（クローン・記憶・runner・マネージャー・作業者と、線の最後の活動）',
        description:
          '走行中・返事待ち・直近10分以内に終わった委譲を、抜粋と文字数の予算で締めて返す' +
          '（全文は `GET /managers/{id}`）。`unknown` は「分からない」であって `ok`/`idle` ではない。' +
          '線は `lastDownAt`（指示・書き込み）/ `lastUpAt`（報告・確認・読み出し）/ ' +
          '`lastActivityAt`（作業者の道具実行）の時刻だけ。作業者は `managerId` × `agentType` で束ねる。' +
          '台帳の行が読めない（版ずれ・手編集）委譲が在るときだけ、`unreadable`（`GET /managers` の ' +
          '`unreadable` と同じ形。issue #2705）を載せる——`managers` が空でも「居ない」とは限らない。' +
          '0件なら鍵ごと無い。',
        responses: {
          200: {
            description: '稼働の地図。',
            content: { 'application/json': { schema: resolver(topologyResponseSchema) } },
          },
        },
      }),
      async (c) => c.json(topologyResponseSchema.parse(await topology.snapshot())),
    )

    /**
     * 稼働の地図の流れ（SSE）。`event: snapshot` に `GET /topology` と同じ形。
     *
     * 開いたとき1回、以後は日誌の追記（短い待ちでまとめる）と周期（約2秒）で組み直し、
     * **内容（`observedAt` を除く）が変わったときだけ**送る。日誌の流れが配線されていなくても
     * 周期で動く（線が空なだけ）。
     */
    .get(
      '/topology/stream',
      describeRoute({
        tags: ['topology'],
        summary: '稼働の地図の流れ（SSE）',
        description:
          '`event: snapshot` に `GET /topology` と同じ形。開いたとき1回、以後は内容が変わった' +
          'ときだけ送る。**組めなかったときは、失敗が続く間の最初の1回だけ `event: unavailable`' +
          '（`data: {"error": "<種別だけ>"}`。本文は載せない）を送り、立ち直った最初の組み直しは' +
          '内容が同じでも必ず `snapshot` で送る**（黙って止まったように見えない）。**コメント行（`:` で始まる行）の heartbeat が周期的に流れる。**',
        responses: {
          200: {
            description: 'SSE ストリーム。',
            content: { 'text/event-stream': { schema: resolver(topologyResponseSchema) } },
          },
        },
      }),
      (c) =>
        streamSSE(c, async (stream) => {
          let wake: (() => void) | null = null;
          let closed = false;
          let dirty = false;

          const unsubscribeJournal =
            deps.journalEvents?.subscribe(() => {
              dirty = true;
              wake?.();
            }) ?? (() => undefined);
          // 作業者の実行中の道具が変わったときも、日誌の追記と同じ口で再計算を起こす（#2725）。
          const unsubscribeWorkerTools = topologyActivity.onChange(() => {
            dirty = true;
            wake?.();
          });
          const unsubscribe = (): void => {
            unsubscribeJournal();
            unsubscribeWorkerTools();
          };

          try {
            stream.onAbort(() => {
              closed = true;
              wake?.();
            });
            const credential = watchSseCredential(
              c.get('principal'),
              c.req.header('authorization'),
            );
            const stopHeartbeat = startSseHeartbeat(
              stream,
              sseHeartbeatMs,
              () => wake?.(),
              () => credential.tick(() => wake?.()),
            );

            try {
              let last: string | null = null;
              let failing = false;
              for (;;) {
                if (closed || credential.lost() || stream.aborted || stream.closed) break;
                const fromEvent = dirty;
                dirty = false;
                try {
                  // 追記を受けた再計算は新しく組む。周期の再計算は直近の結果を使い回して
                  // よい（購読者が増えても台帳を読む回数を増やさない）。
                  // **どちらも共有の結果を使う**（購読者が何人でも台帳を読む回数が窓ごとに
                  // 高々1回）。追記を受けた再計算は待ちの長さ、周期は1秒。
                  const snapshot = topologyResponseSchema.parse(
                    await topology.snapshot({
                      maxAgeMs: fromEvent ? topologyDebounceMs : 1000,
                    }),
                  );
                  failing = false;
                  const signature = topologySignature(snapshot);
                  if (signature !== last) {
                    last = signature;
                    await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot) });
                  }
                } catch (error) {
                  // 失敗が続く間の最初の1回だけ知らせる（毎周期は送らない）。**理由は種別だけ**
                  // （本文は接続先などを含みうる）。立ち直ったら内容が同じでも必ず送り直す
                  // （`last` を捨てる）。ストリームごとは落とさず、次の周期でやり直す。
                  last = null;
                  if (!failing) {
                    failing = true;
                    await stream.writeSSE({
                      event: 'unavailable',
                      data: JSON.stringify({ error: describeProbeError(error) }),
                    });
                  }
                }
                // 組んでいる間に追記が来ていたら（`dirty`）待たずに回る。
                if (!dirty) {
                  await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, topologyTickMs);
                    wake = () => {
                      clearTimeout(timer);
                      resolve();
                    };
                  });
                  wake = null;
                }
                // 追記で起きたなら、続けて来る分をまとめてから組み直す。
                if (dirty && !closed) {
                  await new Promise<void>((resolve) => setTimeout(resolve, topologyDebounceMs));
                }
              }
            } finally {
              stopHeartbeat();
            }
          } finally {
            unsubscribe();
          }
        }),
    )

    // --- 記憶（人間が読んで直せること自体が要件） ---------------------------
    .get(
      '/memory',
      describeRoute({
        tags: ['memory'],
        summary: '記憶文書の一覧',
        description: '記憶（PersonaStore）の文書一覧。本文は含まない（メタ情報だけ）。',
        responses: {
          200: {
            description: '記憶文書のメタ情報一覧。',
            content: { 'application/json': { schema: resolver(memoryListResponseSchema) } },
          },
        },
      }),
      async (c) => c.json({ documents: await stores.persona.list() }),
    )

    .get(
      '/memory/:slug',
      describeRoute({
        tags: ['memory'],
        summary: '記憶文書を1つ読む',
        responses: {
          200: {
            description: '記憶文書。',
            content: { 'application/json': { schema: resolver(memoryReadResponseSchema) } },
          },
          400: {
            description: '記憶のスラッグが不正。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当する記憶が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        // **issue #1634。** `PUT`/`DELETE /memory/:slug` と同じ門——
        // `memorySlugSchema` に落ちるスラッグはここで 400 で断る。ここが
        // 無いと `FsPersonaStore#path` が投げる例外（`packages/storage-fs/src/persona.ts`）が
        // そのまま `onError` まで抜けて 500 になり、同じ入力なのに
        // `PUT`/`DELETE` とは違う応答になっていた。
        const slug = c.req.param('slug');
        if (!memorySlugSchema.safeParse(slug).success) {
          return c.json({ error: '記憶のスラッグが不正' as const }, 400);
        }
        const doc = await stores.persona.read(slug);
        if (!doc) return c.json({ error: 'not found' as const }, 404);
        return c.json({ document: doc, version: memoryVersion(doc.content) });
      },
    )

    .put(
      '/memory/:slug',
      describeRoute({
        tags: ['memory'],
        summary: '記憶文書を全文置換で書く',
        description: '人間が API から記憶を書き換える口。書き換えは日誌に残る（`cause: human`）。',
        responses: {
          200: {
            description: '書き換え後の記憶文書。',
            content: { 'application/json': { schema: resolver(memoryReadResponseSchema) } },
          },
          400: {
            description: '記憶のスラッグが不正、または本文が JSON として不正。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '`ifMatch`（読んだ時の版）が、いまの版と違う（読んでから書くまでの間に別の書き手が' +
              '書いた、または消した）。**何も書いていない。** `current` にいまの版を返す。',
            content: { 'application/json': { schema: resolver(memoryConflictResponseSchema) } },
          },
        },
      }),
      jsonBody(memoryBody, (where) => ({
        error: '記憶の本文の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const slug = c.req.param('slug');
        if (!memorySlugSchema.safeParse(slug).success) {
          return c.json({ error: '記憶のスラッグが不正' as const }, 400);
        }
        const before = await stores.persona.read(slug);
        const { content, ifMatch } = c.req.valid('json');
        let doc;
        try {
          doc = await stores.persona.write(slug, content, { ifMatch });
        } catch (error) {
          // **黙って上書きしない（Issue #2743）。** 書いていないので日誌にも積まない。
          if (error instanceof MemoryConflictError) {
            return c.json(
              {
                error: '記憶が読んだ後に変わっています（書き換えていません）' as const,
                current:
                  error.current === null
                    ? null
                    : { document: error.current, version: memoryVersion(error.current.content) },
              },
              409,
            );
          }
          throw error;
        }
        // **書き換え自体はもう効いている**（Issue #2037）。日誌への追記だけが
        // 落ちても 500 を返さない——`appendJournalOrDrop` の doc。
        const entry = await appendJournalOrDrop(
          stores,
          {
            type: 'memory_update',
            slug,
            cause: 'human',
            action: 'write',
            // クローンの道具（tools.ts の memory_write）と同じ機械可読な面。
            // 片方だけ足すと「人間の書き込みだけ数えられない」が生まれる。
            bytesBefore: before === null ? 0 : Buffer.byteLength(before.content, 'utf8'),
            bytesAfter: Buffer.byteLength(doc.content, 'utf8'),
            summary: 'HTTP API 経由で人間が記憶を書き換えた',
          },
          '記憶書き換えの日誌',
          `slug=${slug}`,
        );
        // **保護状態の派生値を追いつかせる。** 新しい真実を作るのではなく、
        // いま journal.append が書いた cause:'human' の記録そのものを読み出し
        // やすい形にキャッシュしている（一度立てたら降ろさない。`store.ts` の
        // `PersonaStore.markHumanTouched` の doc）。
        // **日誌への追記が落ちたとき（`entry === undefined`）は呼ばない。**
        // `markHumanTouched` の doc「新しい真実ではない。実体は日誌にある」——
        // 裏付けとなる `cause:'human'` の行が無いのに派生値だけ立てると、その
        // doc が保証する対応が崩れる（Issue #2037）。
        if (entry !== undefined) {
          await stores.persona.markHumanTouched(slug, entry.at);
        }
        return c.json({ document: doc, version: memoryVersion(doc.content) });
      },
    )

    /**
     * 記憶を1つ消す。
     *
     * 書けるのに消せないと、間違って作った記憶が**永久に判断の材料に残る**。
     * 人間が読んで直せることが要件なのだから、直すことには消すことも含まれる。
     * 消した事実は日誌に残るので、記憶から消えても記録からは消えない。
     */
    .delete(
      '/memory/:slug',
      describeRoute({
        tags: ['memory'],
        summary: '記憶文書を消す',
        description:
          '書けるのに消せないと、間違って作った記憶が永久に判断の材料に残る。消した事実は' +
          '日誌に残る（`cause: human`）ので、記憶から消えても記録からは消えない。\n\n' +
          '**読んだ版を前提にできる（Issue #2881）。** クエリ `ifMatch` に、読んだ時の版' +
          '（`GET /memory/{slug}` の `version`）を付けると、いまの版と違うとき**何も消さず 409** で' +
          'いまの版を返す（読んだ後にクローンが書いた内容を黙って消さない）。\n\n' +
          '**版は必須。** `ifMatch` を付けない削除は **428** で断り、何も消さず・日誌にも積まず、' +
          'いまの版を `current` に返す（読み直して、その `version` を付けて打ち直す）。' +
          'スラッグが不正なら 400、記憶が無ければ 404 を先に返す。',
        responses: {
          200: {
            description: '消した。',
            content: { 'application/json': { schema: resolver(memoryDeleteResponseSchema) } },
          },
          409: {
            description:
              '`ifMatch`（読んだ時の版）が、いまの版と違う（読んでから消すまでの間に別の書き手が' +
              '書いた）。**何も消していない。** `current` にいまの版を返す。',
            content: { 'application/json': { schema: resolver(memoryConflictResponseSchema) } },
          },
          428: {
            description:
              '`ifMatch`（読んだ時の版）が無い。**何も消していない。** `current` にいまの版を返す' +
              '（409 と同じ形）。',
            content: { 'application/json': { schema: resolver(memoryConflictResponseSchema) } },
          },
          400: {
            description: '記憶のスラッグが名前として成立しない（「無い」とは区別する）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当する記憶が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      queryParams(memoryDeleteQuery),
      async (c) => {
        const slug = c.req.param('slug');
        if (!memorySlugSchema.safeParse(slug).success) {
          return c.json({ error: '記憶のスラッグが不正' as const }, 400);
        }
        const { ifMatch } = c.req.valid('query');
        const existing = await stores.persona.read(slug);
        if (existing === null) return c.json({ error: 'not found' as const }, 404);
        // **版が無ければ断る（Issue #2881 段階3）。** 何も消さず、日誌にも積まない。
        // 読み直せるよう、いまの版を 409 と同じ形で返す。
        if (ifMatch === undefined) {
          return c.json(
            {
              error: '消す記憶の版（ifMatch）が無いので、消していません' as const,
              current: { document: existing, version: memoryVersion(existing.content) },
            },
            428,
          );
        }
        // **`markHumanTouched` はここでは呼ばない。** `PersonaStore.remove` は
        // 保護状態の派生値も一緒に消す（実体の無い印は監査上の嘘になるため）ので、
        // ここで印を立てても同じ操作の中で消える。人間がこの slug を書いた事実
        // そのものは日誌（下の `memory_update`）に残り続けるので、
        // デーモン再起動時の backfill がこの slug の履歴を再び舐めても
        // `action:'remove'` のこのエントリからは印を立て直さない（`storage.ts` の
        // backfill の doc）——delete は「人間の意思で消した」であって、
        // 将来ここに書かれる新しい内容を無条件に保護する理由にはならない。
        try {
          // 版の比較は消すのと同じ排他の中で行う（`PersonaStore.remove`）。
          await stores.persona.remove(slug, { ifMatch });
        } catch (error) {
          // **黙って消さない（Issue #2881）。** 消していないので日誌にも積まない。
          if (error instanceof MemoryConflictError) {
            return c.json(
              {
                error: '記憶が読んだ後に変わっています（消していません）' as const,
                current:
                  error.current === null
                    ? null
                    : { document: error.current, version: memoryVersion(error.current.content) },
              },
              409,
            );
          }
          throw error;
        }
        // **削除自体はもう効いている**（Issue #2037）。日誌への追記だけが
        // 落ちても 500 を返さない——`appendJournalOrDrop` の doc。
        await appendJournalOrDrop(
          stores,
          {
            type: 'memory_update',
            slug,
            cause: 'human',
            action: 'remove',
            bytesBefore: Buffer.byteLength(existing.content, 'utf8'),
            bytesAfter: 0,
            summary: 'HTTP API 経由で人間が記憶を削除した',
          },
          '記憶削除の日誌',
          `slug=${slug}`,
        );
        return c.json({ ok: true as const, slug });
      },
    )

    // --- 仕事のやり方（PracticeStore、#1055 段3③） -------------------------
    //
    // クローンの道具（`practice_list` / `practice_read` / `practice_write` /
    // `practice_remove`、#1055 段3②）と対をなす、人間の口。
    //
    // **ここに `apply` / `enforce` に当たる経路を足さないこと。** 読み書き一覧の
    // 4本しか無い——「このやり方に従え」という操作はどの入口にも存在しない
    // （`PracticeStore` / `practiceSchema` の doc、`docs/north_star.md`）。やり方は
    // 読む素材であって実行される定義ではなく、従うかどうかはそのときのクローンが
    // 決める。人間の入口だからといって、ここだけ特別に強制の口を持たせない。
    //
    // journal は memory の `memory_update`（専用 type・`markHumanTouched` に
    // よる保護状態）とは違い、`practice_write` / `practice_remove`（クローンの
    // 道具、`tools.ts`）と同じ `type: 'decision'` に揃える——`PracticeStore` は
    // 保護状態を持たないので、揃えないと同じ操作が人間経由かクローン経由かで
    // 日誌の型が変わる（読み手が2つの型を覚える理由が無い）。
    .get(
      '/practices',
      describeRoute({
        tags: ['practices'],
        summary: '仕事のやり方の一覧',
        description:
          '仕事のやり方（PracticeStore）の一覧。本文は含まない（メタ情報だけ）。' +
          '**読めない行が無いのにやり方が1件も無いのは正常な状態である**——やり方が書かれていない' +
          '仕事も普通に進む。行が読めない（版ずれ・手編集）やり方が在るときだけ、`unreadable`' +
          '（slug が取れれば slug と不正な欄名）が載る。**壊れた行であって、消されたやり方ではない。**' +
          '0件なら鍵ごと無い（issue #2346）。',
        responses: {
          200: {
            description: 'やり方のメタ情報一覧（slug の昇順）。',
            content: { 'application/json': { schema: resolver(practiceListResponseSchema) } },
          },
        },
      }),
      async (c) => {
        // **読めない行は 1 件でも在るときだけ `unreadable` を載せる**（issue #2346）。
        // 0 件なら鍵ごと無い（既存の呼び手の応答を1バイトも変えない）。
        const { entries, unreadable } = await stores.practices.list();
        return c.json({
          practices: entries,
          ...(unreadable.length > 0 ? { unreadable } : {}),
        });
      },
    )

    .get(
      '/practices/:slug',
      describeRoute({
        tags: ['practices'],
        summary: 'やり方を1つ読む',
        responses: {
          200: {
            description: 'やり方（本文まで）。',
            content: { 'application/json': { schema: resolver(practiceReadResponseSchema) } },
          },
          400: {
            description: 'やり方のスラッグが不正。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当するやり方が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '該当する行は在るが、型に合わない形で入っていて読めない（消されたのとは区別する。' +
              'issue #2011）。' +
              'PUT /practices/:slug で書き直すか、DELETE /practices/:slug で外せる。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        // **issue #1634 の範囲外の気づき。** `PUT`/`DELETE /practices/:slug` と
        // 同じ門——`practiceSlugSchema` に落ちるスラッグはここで 400 で断る。
        // ここが無いと、不正なスラッグは例外を投げずにそのまま store の
        // `read()` へ渡り、見つからない扱いで 404 になる（`GET /memory/:slug`
        // の #1634/#1636 と違い、この実装は fs/in-memory どちらもクラッシュ
        // しない——それでも `PUT`/`DELETE` とは異なる応答形になっていたので、
        // オーナーの判断でここも揃えた）。
        const slug = c.req.param('slug');
        if (!practiceSlugSchema.safeParse(slug).success) {
          return c.json({ error: 'やり方のスラッグが不正' as const }, 400);
        }
        // **issue #2011。** `read()` は読めない行で `UnreadablePracticeError` を
        // 投げる（`PracticeStore.read` の doc）。ここは書き直し・削除の口では
        // ないので、`PUT`/`DELETE` のように捕まえて先へ進む理由が無い——
        // それでも素の 500（`onError` 任せ）より、何が起きたかが分かる応答に
        // したほうが読み手に親切なので、409 として返す（マネージャー判断。
        // `PUT`/`DELETE` はこれまでどおり投げっぱなしにはしない——4つの口は
        // 下の実装を見よ）。
        let practice: Practice | null;
        try {
          practice = await stores.practices.read(slug);
        } catch (error) {
          if (!(error instanceof UnreadablePracticeError)) throw error;
          return c.json(
            {
              error: `やり方 ${slug} は読めない形で入っている（消されたのではない）。本文はここでは取れない。`,
            },
            409,
          );
        }
        if (!practice) return c.json({ error: 'not found' as const }, 404);
        return c.json({ practice, version: practiceVersion(practice) });
      },
    )

    .put(
      '/practices/:slug',
      describeRoute({
        tags: ['practices'],
        summary: 'やり方を全文置換で書く（無ければ作る）',
        description:
          '人間が API からやり方を書き換える口。`kind` は仕事の種類の自由文字列（列挙ではない——' +
          '`practiceKindSchema` の doc）。書き換えは日誌に残る（`type: decision`）。',
        responses: {
          200: {
            description: '書き換え後のやり方。',
            content: { 'application/json': { schema: resolver(practiceReadResponseSchema) } },
          },
          400: {
            description: 'やり方のスラッグが不正、または本文が JSON として不正。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '`ifMatch`（読んだ時の版）が、いまの版と違う（読んでから書くまでの間に別の書き手が' +
              '書いた、または消した）。**何も書いていない**（版の履歴にも足していない）。' +
              '`current` にいまの版を返す。',
            content: { 'application/json': { schema: resolver(practiceConflictResponseSchema) } },
          },
        },
      }),
      jsonBody(practiceBody, (where) => ({
        error: 'やり方の本文の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const slug = c.req.param('slug');
        if (!practiceSlugSchema.safeParse(slug).success) {
          return c.json({ error: 'やり方のスラッグが不正' as const }, 400);
        }
        const { kind, title, content, ifMatch } = c.req.valid('json');
        // **issue #2011。** `before` は「作ったか書き直したか」の分岐にしか
        // 使わない（`write()` 自体は `before` の値に依存しない）。以前は
        // `read()` が壊れた行をそのまま返していたので、壊れた slug への PUT
        // も無事に書き直せていた——`read()` が `UnreadablePracticeError` を
        // 投げるようになったことで（この PR）、捕まえずに投げっぱなしにすると
        // PUT がここで落ち、`write()` まで届かなくなる（＝壊れた行を書き直す
        // 唯一の回復手段が塞がる）。`UnreadablePracticeError` だけを捕まえて
        // 「在ったが読めない」として先へ進み、それ以外の例外は投げっぱなしに
        // する。
        let before: Practice | null;
        let beforeWasUnreadable = false;
        try {
          before = await stores.practices.read(slug);
        } catch (error) {
          if (!(error instanceof UnreadablePracticeError)) throw error;
          before = null;
          beforeWasUnreadable = true;
        }
        let practice: Practice;
        try {
          practice = await stores.practices.write({ slug, kind, title, content }, { ifMatch });
        } catch (error) {
          // **黙って上書きしない（Issue #2853）。** 書いていないので日誌にも積まない。
          if (error instanceof PracticeConflictError) {
            return c.json(
              {
                error: 'やり方が読んだ後に変わっています（書き換えていません）' as const,
                current:
                  error.current === null
                    ? null
                    : { practice: error.current, version: practiceVersion(error.current) },
              },
              409,
            );
          }
          throw error;
        }
        // **書き換え自体はもう効いている**（Issue #2037）。日誌への追記だけが
        // 落ちても 500 を返さない——`appendJournalOrDrop` の doc。
        await appendJournalOrDrop(
          stores,
          {
            type: 'decision',
            decision: beforeWasUnreadable
              ? `読めない形で入っていたやり方 ${slug}（${kind}）を書き直した: ${title}`
              : `やり方 ${slug}（${kind}）を${before === null ? '作った' : '書き直した'}: ${title}`,
            grounds: beforeWasUnreadable
              ? '人間が直接 API から、読めない形で入っていたやり方を書き直した（全文置換。' +
                '前の本文は読めなかったため分からない）'
              : before === null
                ? '人間が直接 API から新しいやり方を器に置いた'
                : '人間が直接 API からやり方を書き直した（全文置換。前の本文は' +
                  'GET /practices/:slug/versions の版の履歴に残る——#1309）',
          },
          'やり方書き換えの日誌',
          `slug=${slug}`,
        );
        return c.json({ practice, version: practiceVersion(practice) });
      },
    )

    /**
     * やり方を1つ消す。
     *
     * 書けるのに消せないと、間違って作ったやり方が永久に候補として残る。消した
     * 事実は日誌に残るので、器から消えても記録からは消えない（`memory` の
     * DELETE と同じ理由）。
     */
    .delete(
      '/practices/:slug',
      describeRoute({
        tags: ['practices'],
        summary: 'やり方を1つ消す',
        description:
          '**読んだ版を前提にできる（Issue #2959）。** クエリ `ifMatch` に、読んだ時の版' +
          '（`GET /practices/{slug}` の `version`）を付けると、いまの版と違うとき**何も消さず 409** で' +
          'いまの版を返す（読んだ後にクローンが書いた内容を黙って消さない）。\n\n' +
          '**版は必須。** `ifMatch` を付けない削除は **428** で断り、何も消さず・日誌にも積まず、' +
          'いまの版を `current` に返す（読み直して、その `version` を付けて打ち直す）。' +
          'スラッグが不正なら 400、やり方が無ければ 404 を先に返す。' +
          '**読めない形で入っている行には版が無い**ので、版なしで消せる（回復手段を塞がない）。',
        responses: {
          200: {
            description: '消した。',
            content: { 'application/json': { schema: resolver(practiceDeleteResponseSchema) } },
          },
          409: {
            description:
              '`ifMatch`（読んだ時の版）が、いまの版と違う（読んでから消すまでの間に別の書き手が' +
              '書いた）。**何も消していない。** `current` にいまの版を返す。',
            content: { 'application/json': { schema: resolver(practiceConflictResponseSchema) } },
          },
          428: {
            description:
              '`ifMatch`（読んだ時の版）が無い。**何も消していない。** `current` にいまの版を返す' +
              '（409 と同じ形）。読めない形で入っている行は、版なしで消せるのでこれを返さない。',
            content: { 'application/json': { schema: resolver(practiceConflictResponseSchema) } },
          },
          400: {
            description: 'やり方のスラッグが名前として成立しない（「無い」とは区別する）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当するやり方が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      queryParams(practiceDeleteQuery),
      async (c) => {
        const slug = c.req.param('slug');
        if (!practiceSlugSchema.safeParse(slug).success) {
          return c.json({ error: 'やり方のスラッグが不正' as const }, 400);
        }
        const { ifMatch } = c.req.valid('query');
        // **issue #2011。** `existing` は「無いか（404）／読めたか」の分岐に
        // 使う。以前は `read()` が壊れた行をそのまま返していたので、壊れた
        // slug への DELETE も無事に消せていた——`read()` が
        // `UnreadablePracticeError` を投げるようになったことで（この PR）、
        // 捕まえずに投げっぱなしにすると DELETE がここで落ち、`remove()` まで
        // 届かなくなる（＝壊れた行を消す唯一の HTTP 経由の手段が塞がる。
        // store 自体の `remove()` は slug 指定の直接 `DELETE` なので、壊れて
        // いても消せることに変わりは無い）。`UnreadablePracticeError` だけを
        // 捕まえて「在ったが読めない」として先へ進み、本当に無い場合だけ
        // 404 のままにする。
        let existing: Practice | null;
        let wasUnreadable = false;
        try {
          existing = await stores.practices.read(slug);
        } catch (error) {
          if (!(error instanceof UnreadablePracticeError)) throw error;
          existing = null;
          wasUnreadable = true;
        }
        if (existing === null && !wasUnreadable) {
          return c.json({ error: 'not found' as const }, 404);
        }
        // **版が無ければ断る（Issue #2959 段階2）。** 何も消さず、日誌にも積まない。読み直せるよう、
        // いまの版を 409 と同じ形で返す。**読めない形の行（`wasUnreadable`）は例外**——読めない行には
        // 版が無く、呼び出し側は `ifMatch` を付けようが無い（`GET` も 409）。ここで断ると壊れた行を
        // 外す回復手段が塞がるので、版なしで消せる（警告も付けない）。
        if (ifMatch === undefined && existing !== null) {
          return c.json(
            {
              error: '消すやり方の版（ifMatch）が無いので、消していません' as const,
              current: { practice: existing, version: practiceVersion(existing) },
            },
            428,
          );
        }
        try {
          // 版の比較は消すのと同じ排他の中で行う（`PracticeStore.remove`）。
          await stores.practices.remove(slug, ifMatch === undefined ? undefined : { ifMatch });
        } catch (error) {
          // **黙って消さない（Issue #2959）。** 消していないので日誌にも積まない。
          if (error instanceof PracticeConflictError) {
            return c.json(
              {
                error: 'やり方が読んだ後に変わっています（消していません）' as const,
                current:
                  error.current === null
                    ? null
                    : { practice: error.current, version: practiceVersion(error.current) },
              },
              409,
            );
          }
          throw error;
        }
        // **削除自体はもう効いている**（Issue #2037）。日誌への追記だけが
        // 落ちても 500 を返さない——`appendJournalOrDrop` の doc。
        if (existing !== null) {
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `やり方 ${slug}（${existing.kind}）を消した: ${existing.title}`,
              grounds: '人間が直接 API からやり方を消した',
            },
            'やり方削除の日誌',
            `slug=${slug}`,
          );
        } else {
          // ここに来るのは `wasUnreadable === true` のときだけ（直上のガードで
          // 「無かった」場合は既に 404 で抜けている）。
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `読めない形で入っていたやり方 ${slug} を消した`,
              grounds: '人間が直接 API から、読めない形で入っていたやり方を消した',
            },
            'やり方削除の日誌',
            `slug=${slug}`,
          );
        }
        return c.json({ ok: true as const, slug });
      },
    )

    /**
     * やり方の追記専用の版の履歴（#1309）。**メタだけ、本文は含まない**——
     * `GET /practices` と同じ理由（一覧に本文を全文で載せない。地雷表の禁止）。
     *
     * `write()` のたびに版が増え、`remove()` しても版は消えない（`PracticeStore`
     * の doc）。だから消した slug に対しても、このエンドポイントは版を返せる。
     */
    .get(
      '/practices/:slug/versions',
      describeRoute({
        tags: ['practices'],
        summary: 'やり方の版の履歴（メタだけ）',
        description:
          '追記専用の版の履歴——write のたびに増え、remove しても消えない（#1309）。' +
          '版番号の昇順。本文は含まない（個別に読むには GET /practices/:slug/versions/:version）。',
        responses: {
          200: {
            description: '版のメタ情報一覧（版番号の昇順）。無い slug には空配列を返す。',
            content: {
              'application/json': { schema: resolver(practiceVersionListResponseSchema) },
            },
          },
          400: {
            description: 'やり方のスラッグが不正。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        // **issue #1670。** `GET`/`PUT`/`DELETE /practices/:slug`（#1647/#1634）と
        // 同じ門——`practiceSlugSchema` に落ちるスラッグはここで 400 で断る。
        // ここが無いと、fs/in-memory では空配列がそのまま 200 で返り、pg 実装
        // （`PgPracticeStore#slug()`、`packages/storage-pg/src/practices.ts`）
        // では例外が投げられて `onError` が 500 にする——入口によって結果が
        // 変わる非対称になっていた。
        const slug = c.req.param('slug');
        if (!practiceSlugSchema.safeParse(slug).success) {
          return c.json({ error: 'やり方のスラッグが不正' as const }, 400);
        }
        return c.json({ versions: await stores.practices.listVersions(slug) });
      },
    )

    /** やり方の版を1つ、本文まで読む（#1309）。 */
    .get(
      '/practices/:slug/versions/:version',
      describeRoute({
        tags: ['practices'],
        summary: 'やり方の版を1つ読む（本文まで）',
        responses: {
          200: {
            description: '版（本文まで）。',
            content: {
              'application/json': { schema: resolver(practiceVersionReadResponseSchema) },
            },
          },
          400: {
            description: 'やり方のスラッグが不正、または版番号が正の整数として成立しない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当する版が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '該当する版は在るが、型に合わない形で入っていて読めない（消されたのとは区別する。' +
              'issue #2177）。この版を書き直す口は無い——本文はここでは取れない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        // **issue #1670。** 版番号の検査（既存）より前に、同じ門を先に通す。
        // 順序は `GET /practices/:slug/versions` と揃え、スラッグが不正なら
        // 版番号の妥当性を見るまでもなく断る。
        const slug = c.req.param('slug');
        if (!practiceSlugSchema.safeParse(slug).success) {
          return c.json({ error: 'やり方のスラッグが不正' as const }, 400);
        }
        const raw = c.req.param('version');
        const version = Number(raw);
        if (!Number.isInteger(version) || version <= 0) {
          return c.json({ error: '版番号が不正' as const }, 400);
        }
        // **issue #2177。** `GET /practices/:slug` と同じ門——`readVersion` も
        // 読めない行で `UnreadablePracticeError` を投げる（`PracticeStore
        // .readVersion` の doc）。ここも書き直し・削除の口ではないので、
        // `PUT`/`DELETE` のように捕まえて先へ進む理由は無い——素の 500
        // （`onError` 任せ）より何が起きたかが分かる応答にする（兄弟の口
        // `GET /practices/:slug` と同じ判断・同じ形）。
        let found: Awaited<ReturnType<typeof stores.practices.readVersion>>;
        try {
          found = await stores.practices.readVersion(slug, version);
        } catch (error) {
          if (!(error instanceof UnreadablePracticeError)) throw error;
          return c.json(
            {
              error:
                `やり方 ${slug} の版 ${String(version)} は読めない形で入っている` +
                '（消されたのではない）。本文はここでは取れない。',
            },
            409,
          );
        }
        if (!found) return c.json({ error: 'not found' as const }, 404);
        return c.json({ version: found });
      },
    )

    // --- 日誌 --------------------------------------------------------------
    .get(
      '/journal',
      describeRoute({
        tags: ['journal'],
        summary: '日誌を読む',
        description:
          '日誌（追記専用の記録）を読む。`type` `since` `until` で掘れる。' +
          '`q` で本文を語で探せる（大文字小文字を区別しない部分一致。他の絞りと併用できる）。' +
          '**`q` が当たらないことは「日誌にその語が無い」を意味しない** —— ' +
          `${JOURNAL_SEARCH_UNCOVERED_LIST_MD} は探す対象に入っていない。` +
          '`q=`（空）は絞らない。' +
          '既定は新しい順（`order:desc`）——`order:asc` で古い順にもできる。' +
          '`afterId` と `afterAt` を両方渡すと、前の頁の最後の行より後ろ' +
          '（＝返る順序における次）を返す（可視の複合キー。応答に `id`/`at` が' +
          '既に載っているのでそこから組み立てる）。**`after` は返る順序の意味で' +
          'あって時間の意味ではない** —— `order:desc`（既定）では、指した行より' +
          '**古い**行が返る。`order:asc` ではその逆（**新しい**行が返る）。' +
          '**封筒は持たない** —— 続きが在るかは `limit` 件ちょうど返ったかで判る。' +
          '`since`/`until` のどちらかを指定すると、応答に `oldestAt`（日誌の地平。' +
          '日誌が空なら `null`）と `crossesHorizon`（窓の始点が地平より前に' +
          'かかるか）を足す——真なら「その窓には無かった」のか「日誌がそこまで' +
          '遡れないだけ」なのかを、この応答だけからは区別できない。' +
          '`since`/`until` を省略した呼びでも、`horizon=true` を渡せば同じ2欄が' +
          '付く（issue #1530）——窓は絞らないまま、地平の情報だけを明示に求める口。' +
          '`horizon` を渡さない呼びの応答は1バイトも変わらない。',
        responses: {
          200: {
            description:
              '日誌エントリの一覧。`since`/`until` のどちらかを指定した呼び、' +
              'または `horizon=true` を渡した呼びには `oldestAt`/`crossesHorizon` ' +
              'が付く（どちらも渡さない呼びには付かない）。' +
              '`next` は次の頁の継続点（`afterId` / `afterAt` へそのまま渡せる）で、' +
              '`null` のときだけ本当の終端。`entries` が `limit` 未満でも空でも、' +
              '`null` でなければ先に行が在る（読めない行は `limit` の後で捨てられる）。',
            content: { 'application/json': { schema: resolver(journalListResponseSchema) } },
          },
          400: {
            description:
              'クエリが不正、または `since` / `until` が日時として読めない・' +
              '`afterId` / `afterAt` の片方だけが渡された・' +
              '`afterAt` の形式が不正、または `afterId`/`afterAt` が指す行が見当たらない。',
            content: {
              'application/json': {
                schema: resolver(errorResponseSchema),
              },
            },
          },
        },
      }),
      queryParams(journalQuery),
      async (c) => {
        const { limit, since, until, type, q, order, afterId, afterAt, horizon } =
          c.req.valid('query');
        const types = type?.split(',').filter((value) => value.length > 0) as
          JournalEntryType[] | undefined;

        // **片方だけでは境界が決まらない**（`/reports` の `beforeDate`/`beforeAt`
        // と同じ形。`journalQuery` の doc）。この2つの if で TypeScript が
        // `afterId`/`afterAt` を以降 `string` に絞る。
        if (afterId === undefined && afterAt !== undefined) {
          return c.json({ error: 'afterId と afterAt は両方一緒に渡す' as const }, 400);
        }
        if (afterId !== undefined && afterAt === undefined) {
          return c.json({ error: 'afterId と afterAt は両方一緒に渡す' as const }, 400);
        }
        if (afterId !== undefined && afterAt !== undefined && Number.isNaN(Date.parse(afterAt))) {
          return c.json({ error: 'afterAt は ISO 8601 で指定する' as const }, 400);
        }

        // **`since`/`until` を正規化する（issue #1515）。** `Date.parse` で
        // 読めなければ 400（`afterAt` の検査と同じ形）。読めれば `toISOString()`
        // へ正規化してからストアへ渡す——pg は時刻で比べるが fs・インメモリは
        // 文字列比較なので、正規化しないと秒の省略（`…T20:21Z`）やオフセット
        // （`+09:00`）で3実装の答えが割れる（`journal-time.ts` の doc）。
        if (since !== undefined && normalizeJournalTimeBoundary(since) === null) {
          return c.json({ error: describeUnreadableJournalTimeBoundary('since', since) }, 400);
        }
        if (until !== undefined && normalizeJournalTimeBoundary(until) === null) {
          return c.json({ error: describeUnreadableJournalTimeBoundary('until', until) }, 400);
        }
        const normalizedSince =
          since === undefined ? undefined : normalizeJournalTimeBoundary(since)!;
        const normalizedUntil =
          until === undefined ? undefined : normalizeJournalTimeBoundary(until)!;

        try {
          const { entries, next } = await stores.journal.listPage({
            limit,
            order,
            ...(normalizedSince === undefined ? {} : { since: normalizedSince }),
            ...(normalizedUntil === undefined ? {} : { until: normalizedUntil }),
            ...(types === undefined || types.length === 0 ? {} : { types }),
            ...(q === undefined ? {} : { q }),
            ...(afterId === undefined || afterAt === undefined
              ? {}
              : { after: { id: afterId, at: afterAt } }),
          });

          // **日誌の地平（issue #1510 の積み残し、#1530 で `horizon` を足した）。**
          // `journal_read`（`tools.ts`）と同じ条件——`since`/`until` の
          // どちらかを指定したとき、または `horizon=true` で明示に求められた
          // ときだけ引く（索引1行なので安く引ける）。0件かどうかでは決めない
          // （窓がまるごと地平より後ろなら、0件でも「本当に無かった」と
          // 言い切れるため）。**既存の応答の形は壊さない**——`horizon` を
          // 渡さない呼びでは `since`/`until` を指定したときだけ現れる、
          // 足すだけの欄のままである。
          const oldestAt =
            normalizedSince !== undefined || normalizedUntil !== undefined || horizon === 'true'
              ? await stores.journal.oldestAt()
              : undefined;
          // **判定条件は `journal_read` の `describeJournalHorizonNote` と
          // 同じ関数（`journalWindowCrossesHorizon`）を呼ぶ**——2箇所に
          // 書き写さない（`journal-horizon.ts` の doc）。ここでは Web が
          // 自分で `since`/`oldestAt` を比べ直さずに済むよう、判定結果その
          // ものを構造化された欄として返す。
          const crossesHorizon =
            oldestAt === undefined
              ? undefined
              : journalWindowCrossesHorizon(oldestAt, normalizedSince);

          return c.json({
            entries,
            // **続きの有無と次の頁の継続点**（Issue #2604 / #2605）。`null` = 本当の終端。
            // `entries` が `limit` 未満・空でも、`null` でない限り先に行が在る
            // （ストアは読めない行を `limit` の後で捨てる）。次は `afterId`/`afterAt` へ渡す。
            next,
            ...(oldestAt === undefined ? {} : { oldestAt }),
            ...(crossesHorizon === undefined ? {} : { crossesHorizon }),
          });
        } catch (error) {
          // **`afterId`/`afterAt` が指す行が見当たらないのは、判定できないという
          // 第3の状態である。** 黙って先頭から返さず 400 にする
          // （`JournalAnchorNotFoundError` の doc、AGENTS.md「静かに失敗する道具」）。
          if (error instanceof JournalAnchorNotFoundError) {
            return c.json({ error: error.message }, 400);
          }
          throw error;
        }
      },
    )

    /**
     * 日誌を id で1件、全文で返す。一覧（`GET /journal`）は窓で切れるので、窓の外の行はここで引く。
     *
     * **`GET /journal/stream` より後ろに登録している**（先だと `stream` が id として読まれる）。
     * 在るが読めない行は 409（「無い」と言わない。`GET /approvals/:id` と同じ線）。
     */
    .get(
      '/journal/:id',
      describeRoute({
        tags: ['journal'],
        summary: '日誌を id で1件読む',
        description:
          '日誌の1件を全文で返す（`GET /journal` の `entries` の1行と同じ形。封筒は持たない）。' +
          '一覧の窓の外の記録もここで引ける。',
        responses: {
          200: {
            description: '日誌エントリ1件。',
            content: { 'application/json': { schema: resolver(journalEntrySchema) } },
          },
          404: {
            description: '該当する日誌が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '日誌の行は在るが読めない形で入っている（版ずれ・手編集）。消されたのではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        let entry: Awaited<ReturnType<typeof stores.journal.get>>;
        try {
          entry = await stores.journal.get(c.req.param('id'));
        } catch (error) {
          if (error instanceof UnreadableJournalEntryError)
            return c.json({ error: error.message }, 409);
          throw error;
        }
        if (entry === null) return c.json({ error: 'not found' as const }, 404);
        return c.json(journalEntrySchema.parse(entry));
      },
    )

    // --- 利用状況（いくら使ったか） --------------------------------------------
    /**
     * **経路は1本だけにする。** 画面のために別の口を足すと、その瞬間に
     * 「CLI ではできないこと」が生まれる（PRD「インターフェース」）。CLI・Web UI・
     * クローンの道具（`usage_read`）はすべてここを通る。
     *
     * **クローンからも同じものが見えること自体が要件である。** 人間が
     * `claude.ai/settings/usage` を見て、その写像であるクローンが見られないのは
     * 能力の削除（north_star 禁止1）。
     */
    .get(
      '/usage',
      describeRoute({
        tags: ['usage'],
        summary: '利用状況（alteroid が使った分）',
        description:
          'SDK の `result.modelUsage` を積んだ台帳を、日 × マネージャー × モデルで返す。' +
          '**推定値であり請求明細ではない**（`notice` に同じ但し書きが載る）。' +
          '台帳の始点は `since`、照会範囲が始点より前にかかっていれば `beforeLedger` が真になる — ' +
          'そのときは 0 ではなく「記録が無い」と読むこと（過去分の掘り起こしはしていない）。' +
          '層と場所の軸は台帳より後から入ったので、始点は `layersSince`、' +
          '照会範囲がそれより前にかかっていれば `beforeLayers` が真になる — ' +
          'そのときの `layer` / `site` は既定値であって観測ではない。' +
          '認証トークンの軸も同じ形で `tokensSince` / `beforeTokens` を返すが、' +
          '**null の意味が1つ多い** — 記録が1件も無いときだけでなく、' +
          '**プールを使っていない構成では最後まで null である**（`since` が非 null でも起きる）。' +
          'そのときの `breakdown.byToken` は `tokenId: null` の1件だけを返す。' +
          'それは「1本のトークンで全部使った」ではなく「帰属が取れていない」である。' +
          '`unrecordedManagers` は消費の記録が1件も無い委譲（Issue #98）——' +
          '`from` / `to` などの絞り込みには影響されない（全期間で判定する）。',
        responses: {
          200: {
            description: '台帳の集計。',
            content: { 'application/json': { schema: resolver(usageResponseSchema) } },
          },
          400: {
            description: 'クエリが不正。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      queryParams(usageQuery),
      async (c) => {
        const { from, to, managerId, layer, site, tokenId } = c.req.valid('query');
        const aggregate = await stores.usage.aggregate({
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(managerId === undefined ? {} : { managerId }),
          ...(layer === undefined ? {} : { layer }),
          ...(site === undefined ? {} : { site }),
          ...(tokenId === undefined ? {} : { tokenId }),
        });
        /*
         * **台帳に1行も無い委譲（Issue #98）。** `clone.managers.list()` は追加の
         * 配線なしで呼べる（`clone` は上で既に destructure 済み。既存の
         * `GET /managers` が同じものを呼んでいるのと同じ形）。
         *
         * **全期間・絞り込み無しの2つを突き合わせる。** `managers.list()` に
         * `from` / `to` を渡す口は無く、`recordedManagerIds()` も引数を持たない
         * （どちらも `store.ts` / `manager.ts` の doc のとおり）——この応答の
         * クエリの絞り込みで狭めた `aggregate.rows` から作ってはならない
         * （照会範囲の外で記録された委譲が「記録が無い」に化ける）。
         */
        const allManagers = await clone.managers.list();
        const recordedManagerIds = await stores.usage.recordedManagerIds();
        const unrecordedManagers = findUnrecordedManagers(
          allManagers,
          recordedManagerIds,
          aggregate.since,
        );
        return c.json({
          ...aggregate,
          // 内訳は core の1つの実装で作る（口ごとに足し直すと食い違う）。
          breakdown: summarizeUsage(aggregate.rows, aggregate.turnRows),
          // **配線されていなければ「まだ分からない」を返す。** 0 や null にすると
          // 「枠を使っていない」と読める（テストの HTTP 層検証では省略できる）。
          account: deps.accountUsage?.() ?? { state: 'unknown' as const },
          unrecordedManagers,
          // **台帳の `date` を書くのと同じ関数（`usageDate`）・同じ TZ で評価する**
          // （Issue #2268）。ブラウザの TZ で「今日」を決めると、台帳の日とずれる。
          today: usageDate((deps.now ?? (() => new Date()))()),
        });
      },
    )

    // --- 日報（可観測性の最上段。人間の普段の接点はほぼこれだけ） --------------
    .get(
      '/reports',
      describeRoute({
        tags: ['reports'],
        summary: '日報の一覧',
        description:
          '日報（可観測性の最上段）を**日付の新しい順**に読む（同じ日に複数あれば書いた時刻の新しい方が先）。' +
          '日誌の並び（書いた順）とは一致しない — 遡り生成では前の日ぶんの日報が今日書かれる（`reports.ts`）。' +
          '`beforeDate` と `beforeAt` を両方渡すと、前の頁の最後の日報より後ろ' +
          '（＝より古い側）を返す（可視の複合キー。応答に `date`/`at` が既に載っている' +
          'のでそこから組み立てる）。**封筒は持たない** — 続きが在るかは `limit` 件' +
          'ちょうど返ったかで判る。',
        responses: {
          200: {
            description: '日報の一覧（日付の新しい順）。',
            content: { 'application/json': { schema: resolver(reportsResponseSchema) } },
          },
          400: {
            description:
              'クエリが不正、または `beforeDate` / `beforeAt` の片方だけが渡された・形式が不正。',
            content: {
              'application/json': {
                schema: resolver(errorResponseSchema),
              },
            },
          },
        },
      }),
      queryParams(reportsQuery),
      async (c) => {
        const { limit, beforeDate, beforeAt } = c.req.valid('query');

        // **並べ直しはここが持つ**（`reports.ts`）。日誌の並びは書いた順なので、
        // そのまま返すと遡り生成の日報が新しい日の上に来る。画面や CLI の側で
        // 並べ直すと「最新の日報」が口ごとに食い違う。
        if (beforeDate === undefined && beforeAt === undefined) {
          const reports = await listDailyReports(stores.journal, limit);
          return c.json({ reports });
        }

        // **片方だけでは境界が決まらない。** `beforeAt` 単独では日付順の主キーが
        // 埋まらず、`beforeDate` 単独では同じ日の複数（締めと遡り生成）を切れない。
        // 直上の分岐で「両方無い」は片付けたので、ここに来るのは「片方だけ」か
        // 「両方在る」のどちらか——前者を 400 にする。この2つの if で
        // TypeScript が `beforeDate` / `beforeAt` を以降 `string` に絞る。
        if (beforeDate === undefined || beforeAt === undefined) {
          return c.json(
            { error: 'beforeDate と beforeAt は両方一緒に渡す（片方だけでは境界が決まらない）' },
            400,
          );
        }

        // `beforeDate` の形式検査は `/reports/:date` と同じ `localDayRange` に
        // 揃える（現物のカレンダー妥当性まで見る——2月30日のような日を通さない）。
        if (localDayRange(beforeDate) === null) {
          return c.json({ error: 'beforeDate は YYYY-MM-DD で指定する' }, 400);
        }
        if (Number.isNaN(Date.parse(beforeAt))) {
          return c.json({ error: 'beforeAt は ISO 8601 で指定する' }, 400);
        }

        // **`(beforeDate, beforeAt)` の日報が実在することは要求しない。** 境界は
        // 比較で決まるので、指していた日報が万が一見当たらなくても続きは正しく
        // 定まる（`/approvals` のカーソルと同じ理由。`reports.ts` の
        // `listDailyReportsBefore` の doc）。
        const reports = await listDailyReportsBefore(stores.journal, limit, {
          date: beforeDate,
          at: beforeAt,
        });
        return c.json({ reports });
      },
    )

    .get(
      '/reports/:date',
      describeRoute({
        tags: ['reports'],
        summary: '1日分の日報',
        responses: {
          200: {
            description: 'その日の日報。',
            content: { 'application/json': { schema: resolver(reportsResponseSchema) } },
          },
          400: {
            description: '日付が `YYYY-MM-DD` 形式ではない（黙って別の日にずらさない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: 'その日の日報が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const date = c.req.param('date');
        const range = localDayRange(date);
        if (range === null) return c.json({ error: '日付は YYYY-MM-DD で指定する' as const }, 400);

        // その日以降だけを読む（日報は1日1件なので、遡る量は日数で収まる）
        const entries = await stores.journal.list({
          types: ['daily_report'],
          since: range.since.toISOString(),
        });
        // 同じ日に複数あるとき（締めと遡り生成）は書いた時刻の新しい方を先に出す。
        // 日誌の並びが既にそうなっているが、**一覧（`/reports`）と同じ比較で並べる** —
        // 画面は「その日の先頭」を既定で開くので、口ごとに違うと開くものが変わる。
        const reports = entries
          .filter(isDailyReport)
          .filter((entry) => entry.date === date)
          .sort(compareDailyReportsNewestFirst);
        if (reports.length === 0) return c.json({ error: 'not found' as const }, 404);
        return c.json({ reports });
      },
    )

    // --- 承認待ちキュー ----------------------------------------------------
    .get(
      '/approvals',
      describeRoute({
        tags: ['approvals'],
        summary: '承認待ちの一覧',
        description:
          '`ask_human` が積んだ承認待ち。既定では未回答のみ（`pending=false` で全部）。' +
          '行が読めない（版ずれ・手編集）承認待ちが在るときだけ、`unreadable`（id が取れれば id と' +
          '不正な欄名）が載る。**壊れた行であって、回答済みでも取り下げ済みでもない。**' +
          '0件なら鍵ごと無い。窓（`limit`/`cursor`）では切らない（issue #2298）。`conversationId` を渡すと、' +
          '`unreadable` は生の行の `conversationId` がその会話と一致する行だけになる（会話の id すら読めない行と' +
          'ほかの会話の壊れた行は載らない。全件は `conversationId` を渡さない呼びで見る。issue #3319）。' +
          '`order` / `limit` / `cursor` のいずれかを明示すると頁の封筒（`total` /' +
          '`nextCursor`）が応答へ載る。**明示しない既定の呼びは、この変更の前と応答が' +
          '1バイトも変わらない**（opt-in。`.claude/skills/listing-and-detail/SKILL.md`' +
          'の考え方と同じ——足すのは能力であって、既存の呼び手に新しい欄を押し付け' +
          'ない）。並びは `order`（既定 `asc`）で、`(createdAt, id)` の比較で決める' +
          '（ストアの生の並びには乗らない。理由は `apps/daemon/src/app.ts` の' +
          '`approvalsCursorSchema` の doc）。`conversationId` を渡すと、その会話で' +
          '上がった確認だけに絞る（`pending`/`order`/`limit`/`cursor` と併用できる）。' +
          '`answeredOn=YYYY-MM-DD`（opt-in）を渡すと、**その日（デーモンの `localDate()` で決まる日。' +
          '日報と同じ区切り）に決着した承認だけ**を、決着の新しい順（同時刻は id の降順）に返す。' +
          '**決着の日時は `answeredAt`、無ければ `withdrawnAt`**（取り下げ済みも決着した件。外すと' +
          '取り下げ済みが画面から見えなくなる）。日付の形が不正（2月30日など）、`pending=true` の' +
          '明示、`order`/`limit`/`cursor` との併用は 400。この指定では `unreadable` は載せない。',
        responses: {
          200: {
            description: '承認待ちの一覧。',
            content: { 'application/json': { schema: resolver(approvalsResponseSchema) } },
          },
          400: {
            description: 'クエリが不正、または `cursor` が壊れている・`order` と食い違う。',
            content: {
              'application/json': {
                schema: resolver(errorResponseSchema),
              },
            },
          },
        },
      }),
      queryParams(approvalsQuery),
      async (c) => {
        const { pending, order, limit, cursor, conversationId, answeredOn } = c.req.valid('query');
        // **opt-in の判定は生のクエリで行う。** `order` は既定値を持つので
        // `c.req.valid('query')` だけでは「渡されたか」が分からない
        // （`grep -Fn -- '取れない軸に 0 の行を作る' AGENTS.md` の地雷と同じ形——
        // 「渡されなかった」を「既定値と同じ値が渡された」と混同しないこと）。
        // **`conversationId` は opt-in の対象ではない**（`pending` と同じ側。
        // `approvalsQuery` の doc）——渡しても頁の封筒は増えない。
        const optedIn =
          c.req.query('order') !== undefined ||
          c.req.query('limit') !== undefined ||
          c.req.query('cursor') !== undefined;

        // **決着した日の指定（`answeredOn`）は、別の絞りと食い違う指定を先に断る。**
        // `pending` は既定値を持つので、明示されたかは生のクエリで見る（`optedIn` と同じ理由）。
        if (answeredOn !== undefined) {
          if (c.req.query('pending') === 'true') {
            return c.json({ error: 'answeredOn は pending=true と併用できない' }, 400);
          }
          if (optedIn) {
            return c.json({ error: 'answeredOn は order / limit / cursor と併用できない' }, 400);
          }
          // `/reports/:date` と同じ検査（現物のカレンダー妥当性まで見る）。
          if (localDayRange(answeredOn) === null) {
            return c.json({ error: 'answeredOn は YYYY-MM-DD で指定する' as const }, 400);
          }
          // 会話の絞りはここでもストアに渡す（#3290）。
          const settled = await stores.jobs.listApprovals({
            pendingOnly: false,
            ...(conversationId === undefined ? {} : { conversationId }),
          });
          const onDay = approvalsSettledOn(settled.entries, answeredOn);
          // `unreadable` は載せない: 読めない行は決着の日時も分からず、どの日にも置けない
          // （未回答の画面が言う）。
          return c.json(
            approvalsResponseSchema.parse({
              approvals: onDay.map((approval) => ({
                ...approval,
                updatedAt: approvalUpdatedAt(approval),
              })),
            }),
          );
        }

        // **`conversationId` の絞りはストアに渡す**（issue #3290。全件を取ってメモリで
        // 絞ると、会話を開くたびの費用が承認の総数に比例する）。`pending` の直後、
        // `total` を数える前に当たる——`total` は「この呼びが対象にしている集合」の件数で
        // あって、絞り込みを当てる前の全件ではない（`pending` が既にそうしている）。
        // `unreadable` も会話で絞られる（生の `conversationId` が一致する行だけ。#3319。
        // `JobStore.listApprovals` の doc）。絞らない呼びは全件。
        const approvalList = await stores.jobs.listApprovals({
          pendingOnly: pending !== 'false',
          ...(conversationId === undefined ? {} : { conversationId }),
        });
        const approvals = approvalList.entries;
        // **`total` は `limit` / `cursor` を当てる前の件数。** opt-in していない
        // ときは応答に載せない。
        const total = approvals.length;

        let cursorPayload: (ApprovalPagingKey & { order: 'asc' | 'desc' }) | undefined;
        if (cursor !== undefined) {
          try {
            cursorPayload = decodeCursor(cursor, approvalsCursorSchema);
          } catch (error) {
            if (error instanceof InvalidCursorError) {
              return c.json({ error: error.message }, 400);
            }
            throw error;
          }
          // **黙って別の向きの頁を返さない。** カーソルは決めた向きの中でしか
          // 意味を持たない値（`(createdAt, id)`）なので、向きが違えば作り直す
          // 以外に正しい続きが無い。
          if (cursorPayload.order !== order) {
            return c.json({ error: 'カーソルの order がリクエストの order と食い違う' }, 400);
          }
          // **id の実在は検査しない。** 指していた行が答えられて `pending` の
          // 絞りから消えていても、`(createdAt, id)` の比較さえできれば続きは
          // 正しく決まる（`apps/daemon/src/cursor.ts` の decodeCursor の doc）。
        }

        // 既定の呼びも並べる: ストアの生の並びは実装ごとに違い（fs は回答で書き直した行が末尾へ動く）、説明の「(createdAt, id) の比較で決める」と食い違うため（#4090）。
        const compare = compareApprovalPagingKey(order);
        let view = [...approvals].sort(compare);
        if (optedIn && cursorPayload !== undefined) {
          const pivot = cursorPayload;
          view = view.filter((approval) => compare(approval, pivot) > 0);
        }

        const page = optedIn && limit !== undefined ? view.slice(0, limit) : view;
        const hasMore = optedIn && page.length < view.length;
        const lastOfPage = page[page.length - 1];

        const responseBody: {
          approvals: unknown[];
          unreadable?: unknown[];
          total?: number;
          nextCursor?: string;
        } = {
          approvals: page.map((approval) => ({
            ...approval,
            updatedAt: approvalUpdatedAt(approval),
          })),
        };
        // **読めない行は 1 件でも在るときだけ `unreadable` を載せる**（issue #2298）。
        // 0 件なら鍵ごと無い（「読めない行は 0 件」と読める空配列を作らず、既存の呼び手の
        // 応答を1バイトも変えない）。窓（`limit`/`cursor`）では切らない。
        // `conversationId` の絞りでは、生の行の `conversationId` が一致する行だけが来る（#3319）。
        if (approvalList.unreadable.length > 0) responseBody.unreadable = approvalList.unreadable;
        if (optedIn) {
          responseBody.total = total;
          if (hasMore && lastOfPage !== undefined) {
            responseBody.nextCursor = encodeCursor({
              id: lastOfPage.id,
              createdAt: lastOfPage.createdAt,
              order,
            });
          }
        }
        return c.json(approvalsResponseSchema.parse(responseBody));
      },
    )

    /**
     * 決着のあった日と件数（`GET /approvals?answeredOn=` で日ごとに開くための目次）。
     *
     * **`GET /approvals/:id`（下）に食われない**: `/approvals/:id` は2区間で、この経路と
     * 同じ形をしている。**`GET /approvals/:id` はこの経路より後ろに登録すること**
     * （先に登録すると `answered-dates` が id として読まれる。`approvals-answered.test.ts` が固定する）。
     */
    .get(
      '/approvals/answered-dates',
      describeRoute({
        tags: ['approvals'],
        summary: '承認が決着した日と件数',
        description:
          '回答済み・取り下げ済みの承認について、**決着した日**（デーモンの `localDate()`。日報と同じ区切り）' +
          'ごとの件数を**新しい日が上**の順に返す。決着の日時は `answeredAt`、無ければ `withdrawnAt`' +
          '（`GET /approvals?answeredOn=` と同じ意味）。`limit`（既定 7・上限 365。`GET /reports` と同じ）と' +
          '`beforeDate`（前の頁の最後の日。**それより古い日**を返す）で続きを取る。**封筒は持たない**' +
          ' — 続きが在るかは `limit` 件ちょうど返ったかで判る。',
        responses: {
          200: {
            description: '決着のあった日と件数（日付の新しい順）。',
            content: {
              'application/json': { schema: resolver(approvalsAnsweredDatesResponseSchema) },
            },
          },
          400: {
            description: 'クエリが不正、または `beforeDate` が `YYYY-MM-DD` 形式ではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      queryParams(approvalsAnsweredDatesQuery),
      async (c) => {
        const { limit, beforeDate } = c.req.valid('query');
        if (beforeDate !== undefined && localDayRange(beforeDate) === null) {
          return c.json({ error: 'beforeDate は YYYY-MM-DD で指定する' as const }, 400);
        }
        const settled = await stores.jobs.listApprovals({ pendingOnly: false });
        return c.json({
          dates: answeredDates(settled.entries, {
            limit,
            ...(beforeDate === undefined ? {} : { beforeDate }),
          }),
        });
      },
    )

    /**
     * 承認を id で1件返し、決着した日を載せる。
     *
     * **`GET /approvals/answered-dates` より後ろに登録している**（上の注意書き）。`POST` の
     * `/approvals/answer` / `/approvals/:id/answer` とは、メソッドが違うので当たらない。
     *
     * `settledOn` は `GET /approvals?answeredOn=` の日と**同じ関数**（`approvalSettledDate`）で
     * 決める。未決着は `null`。在るが読めない行は、`/approvals/:id/trace` と同じく 409
     * （「無い」と言わない）。
     */
    .get(
      '/approvals/:id',
      describeRoute({
        tags: ['approvals'],
        summary: '承認を id で1件読み、決着した日を返す',
        description:
          '承認1件と、決着した日（`settledOn`。デーモンの `localDate()`・日報と同じ区切り。決着の日時は ' +
          '`answeredAt`、無ければ `withdrawnAt`。`GET /approvals?answeredOn=` と同じ意味）を返す。' +
          '未回答・未取り下げなら `settledOn` は `null`。回答済みの詳細（`/approvals/answered/<日>/<id>`）へ' +
          '移るために、一覧を引かずに日を知る口。',
        responses: {
          200: {
            description: '承認と決着した日。',
            content: { 'application/json': { schema: resolver(approvalByIdResponseSchema) } },
          },
          404: {
            description: '該当する承認待ちが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '承認待ちの行は在るが読めない形で入っている（版ずれ・手編集）。消されたのではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        let approval: Awaited<ReturnType<typeof stores.jobs.getApproval>>;
        try {
          approval = await stores.jobs.getApproval(c.req.param('id'));
        } catch (error) {
          if (error instanceof UnreadableApprovalError)
            return c.json({ error: error.message }, 409);
          throw error;
        }
        if (approval === null) return c.json({ error: 'not found' as const }, 404);
        return c.json(
          approvalByIdResponseSchema.parse({
            approval: { ...approval, updatedAt: approvalUpdatedAt(approval) },
            settledOn: approvalSettledDate(approval) ?? null,
          }),
        );
      },
    )

    /**
     * 承認の答えと、その後にクローンが取った行動を対で読む（issue #847 の案B）。
     *
     * **資格は他の承認の読み口（`GET /approvals`）と同じく `authenticate` だけ。**
     * 中身は `/approvals` と `/journal` で既に読めるものの串刺しで、新しく
     * 外へ出すものは無い。クローンの `approval_trace` と CLI の
     * `/approval-trace` が同じ `traceApproval` を通る（PRD「インターフェース」）。
     */
    .get(
      '/approvals/:id/trace',
      describeRoute({
        tags: ['approvals'],
        summary: '承認の答えとその後の行動を対で読む',
        description:
          '問い・答え（日誌の行と承認待ちの器）と、答えを受けたターンでクローンが書いた行' +
          '（`answeredApprovalId` がこの承認を指すもの）を古い順に返す。対が無いときは `state` が' +
          '理由を分ける（`unanswered` / `withdrawn` / `no_turn_start` / ' +
          '`turn_before_recording`＝この記録を始める前の答えなので記録していない / ' +
          '`unstamped_actions`＝記録が動いていない疑い / `no_actions`）。' +
          '一般化した基準は返さない（issue #847）。',
        responses: {
          200: {
            description: '対（無ければ理由つき）。',
            content: { 'application/json': { schema: resolver(approvalTraceResponseSchema) } },
          },
          404: {
            description: '該当する承認待ちが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '承認待ちの行は在るが読めない形で入っている（版ずれ・手編集）。消されたのではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        let trace: Awaited<ReturnType<typeof traceApproval>>;
        try {
          trace = await traceApproval(stores, c.req.param('id'));
        } catch (error) {
          // 在るが読めない行を「無い」（404）と言わない。
          if (error instanceof UnreadableApprovalError)
            return c.json({ error: error.message }, 409);
          throw error;
        }
        if (trace === null) return c.json({ error: 'not found' as const }, 404);
        return c.json(approvalTraceResponseSchema.parse(trace));
      },
    )

    /**
     * 溜まった保留をまとめて片付ける。1件が駄目でも残りは進める（人間の不在で
     * 止まっていたそれぞれの仕事が、答えた順に独立に再開する）。
     */
    .post(
      '/approvals/answer',
      describeRoute({
        tags: ['approvals'],
        summary: '溜まった承認待ちにまとめて答える',
        description:
          '1件が駄目でも残りは進める（人間の不在で止まっていたそれぞれの仕事が、答えた順に' +
          '独立に再開する）。結果は `answers` と同じ順で返る。行が在るが読めない件は、その件だけ' +
          '`ok: false` と読めない旨の `error` で返る（`not found` とは言わない）。' +
          '各件は `answer`（自由文）か `selections`（`questions` を持つ承認待ちへの選択肢の回答。' +
          '`answer` は補足として併用できる）の少なくとも一方を持つ。**`selections` が `questions` と' +
          '突き合わない件が1つでもあれば、1件も答えずに全体を 400 にする**（知らない設問・選択肢の id、' +
          '単一選択で2つ以上、`allowOther: false` なのに `other`、同じ設問が2回、`questions` を持たない' +
          '承認待ちへの `selections`）。',
        responses: {
          200: {
            description: '各件の結果（1件ごとの成否）。',
            content: {
              'application/json': { schema: resolver(approvalsAnswerResponseSchema) },
            },
          },
          400: {
            description:
              '本文が JSON として不正。または `answer` も `selections` も無い件・`selections` が' +
              '`questions` と突き合わない件がある（この場合、どの件も答えていない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(answersBody, (where) => ({
        error: 'answers の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const results: { id: string; ok: boolean; error?: string }[] = [];
        const { answers } = c.req.valid('json');
        // **形の不正は、1件も答える前に全体を 400 にする**（issue #2525）。`selections` が
        // `questions` と突き合わないのは要求の書き方の誤りで、人間の不在や先着の回答のような
        // 件ごとの成否（下の `ok: false`）とは違う。直さずに残りだけ進めると、書いたつもりの件が
        // 黙って落ちる。**まだ回答待ちの件にだけ**突き合わせる（既に答え済み・取り下げ済み・
        // 読めない・無い件は、下で件ごとの理由として返す）。
        for (const item of answers) {
          if (item.selections === undefined) continue;
          let pending: Awaited<ReturnType<typeof stores.jobs.getApproval>> = null;
          try {
            pending = await stores.jobs.getApproval(item.id);
          } catch (error) {
            if (!(error instanceof UnreadableApprovalError)) throw error;
          }
          if (
            pending === null ||
            pending.answeredAt !== undefined ||
            pending.withdrawnAt !== undefined
          ) {
            continue;
          }
          const violation = describeSelectionsViolation(
            pending.questions,
            item.selections,
            item.answer,
          );
          if (violation !== null) {
            return c.json({ error: `selections が不正: ${item.id}: ${violation}` }, 400);
          }
        }
        for (const { id, answer, selections } of answers) {
          let approval: Awaited<ReturnType<typeof stores.jobs.getApproval>>;
          try {
            approval = await stores.jobs.getApproval(id);
          } catch (error) {
            // この1件だけ「在るが読めない」と返し、残りは進める（`not found` と言わない）。
            if (!(error instanceof UnreadableApprovalError)) throw error;
            results.push({ id, ok: false, error: error.message });
            continue;
          }
          if (!approval) {
            results.push({ id, ok: false, error: 'not found' });
            continue;
          }
          if (approval.answeredAt !== undefined) {
            results.push({ id, ok: false, error: 'already answered' });
            continue;
          }
          // **取り下げ済みは回答できない（#963）。** 「答えたのに取り下げられた」
          // の逆向き——クローンが `approval_withdraw` で「もう要らない」と
          // 決めた件へ人間が答えると、`putApproval` が上書きして
          // `withdrawnAt` と `answeredAt` が同時に立った行を作ってしまう
          // うえ、クローンが止めたつもりの仕事を人間の回答が再開しうる
          // （`clone.ts` の `case 'human_answer'` は `answeredAt` の有無しか
          // 見ない）。
          if (approval.withdrawnAt !== undefined) {
            results.push({ id, ok: false, error: 'withdrawn' });
            continue;
          }
          try {
            await clone.answerApproval(
              id,
              answer ?? '',
              answerApprovalViaOf(c.get('principal')),
              selections,
            );
            results.push({ id, ok: true });
          } catch (error) {
            // 先の判定を通った後に、別の回答・取り下げが先に届いていた（issue #2007）。
            // 先の判定と同じ語で返す。
            const settled = approvalSettledKindOf(error);
            results.push({
              id,
              ok: false,
              error:
                settled === 'answered'
                  ? 'already answered'
                  : settled === 'withdrawn'
                    ? 'withdrawn'
                    : error instanceof UnreadableApprovalError
                      ? error.message
                      : error instanceof Error && error.name === 'InvalidApprovalSelectionsError'
                        ? error.message
                        : reasonOf(error),
            });
          }
        }
        return c.json({ results });
      },
    )

    .post(
      '/approvals/:id/answer',
      describeRoute({
        tags: ['approvals'],
        summary: '承認待ちに1件答える',
        description:
          '二度答えると、既に再開した仕事へ同じ回答がもう一度流れ、記録上の回答も上書きされる。' +
          '答え直したいなら新しい確認として来るのが正しい（→ 409）。' +
          'クローンが approval_withdraw で取り下げた件も答えられない（→ 409 error="withdrawn"。#963）。' +
          '`answer`（自由文）か `selections`（`questions` を持つ承認待ちへの選択肢の回答）の少なくとも' +
          '一方が要る。`selections` があれば `answer` は省略でき、併用すると補足になる。デーモンが' +
          '設問・選択肢・その他・補足を人間が読める文に畳んで回答として残す（構造は `selections` に残る。' +
          '未回答の設問があってもよい）。',
        responses: {
          200: {
            description: '答えた。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          400: {
            description:
              '本文が JSON として不正。または `answer` も `selections` も無い・`selections` が' +
              '`questions` と突き合わない（知らない設問・選択肢の id、単一選択で2つ以上、' +
              '`allowOther: false` なのに `other`、同じ設問が2回、`questions` を持たない承認待ちへの' +
              '`selections`）。回答は書いていない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当する承認待ちが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '既に回答済み・取り下げ済み。または承認待ちの行は在るが読めない形で入っている' +
              '（版ずれ・手編集。消されたのではない。回答は書いていない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(answerBody, (where) => ({
        error: 'answer の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const id = c.req.param('id');
        let approval: Awaited<ReturnType<typeof stores.jobs.getApproval>>;
        try {
          approval = await stores.jobs.getApproval(id);
        } catch (error) {
          // 在るが読めない行を「無い」（404）と言わない。行は書き換えていない。
          if (error instanceof UnreadableApprovalError)
            return c.json({ error: error.message }, 409);
          throw error;
        }
        if (!approval) return c.json({ error: 'not found' as const }, 404);
        // 二度答えると、既に再開した仕事へ同じ回答がもう一度流れ、記録上の回答も
        // 上書きされる。答え直したいなら新しい確認として来るのが正しい。
        if (approval.answeredAt !== undefined) {
          return c.json({ error: 'already answered' as const }, 409);
        }
        // 取り下げ済みも答えられない（#963。上のバルク版と同じ理由）。
        if (approval.withdrawnAt !== undefined) {
          return c.json({ error: 'withdrawn' as const }, 409);
        }
        // **`selections`（issue #2525）の検査。** `questions` を持たない承認待ちへの
        // `selections`・知らない id・単一選択で2つ以上・`allowOther: false` なのに `other`・
        // 同じ設問が2回、はどれも 400（何も書かない）。
        const body = c.req.valid('json');
        if (body.selections !== undefined) {
          const violation = describeSelectionsViolation(
            approval.questions,
            body.selections,
            body.answer,
          );
          if (violation !== null) return c.json({ error: `selections が不正: ${violation}` }, 400);
        }
        try {
          await clone.answerApproval(
            id,
            body.answer ?? '',
            answerApprovalViaOf(c.get('principal')),
            body.selections,
          );
        } catch (error) {
          // クローンの側の検査が先の検査を通り抜けた窓（別の実装・テストの偽物）。
          if (error instanceof Error && error.name === 'InvalidApprovalSelectionsError') {
            return c.json({ error: error.message }, 400);
          }
          // 先の判定を通った後に、別の回答・取り下げが先に届いていた（issue #2007）。
          // 先の判定と同じ 409 で返す。
          const settled = approvalSettledKindOf(error);
          if (settled === 'answered') return c.json({ error: 'already answered' as const }, 409);
          if (settled === 'withdrawn') return c.json({ error: 'withdrawn' as const }, 409);
          // 先の `getApproval` の後に行が読めなくなった窓。
          if (error instanceof UnreadableApprovalError)
            return c.json({ error: error.message }, 409);
          throw error;
        }
        return c.json({ ok: true });
      },
    )

    // --- 許可の記録（Issue #863「許可をコードではなくデータにする」）--------
    .get(
      '/permission-grants',
      describeRoute({
        tags: ['permission-grants'],
        summary: '人間が承認した Bash 許可の一覧',
        description:
          '`request_permission` の要求に人間が「許可します」と定型文でちょうど答え、かつ' +
          '許可されたアカウント経由の回答だったときだけ記録される（`answerApproval` の' +
          '`#recordPermissionGrantIfConsented`。operator 経由の回答は記録されない——' +
          'operator の資格はクローンの器から読めるため、人間の証拠にならない）。' +
          '`revokedAt` が付いていない行だけが、クローン本セッションの Bash 呼び出しで自動的に' +
          '通る（`clone.ts` の `#onPreToolUse`）。並びは `grantedAt` 昇順。',
        responses: {
          200: {
            description:
              '許可の一覧。読めない行（型に合わない形で入っている許可）が1件でも在るときだけ ' +
              '`rowsUnreadable`（件数と id・不正な欄名。本文は載せない）が付く。読めない行しか無いと ' +
              '`grants` は空だが「許可が無い」とは限らない。id を `POST /permission-grants/unreadable/remove` に渡して消せる。',
            content: { 'application/json': { schema: resolver(permissionGrantsResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const grants = await stores.permissionGrants.list();
        // **読めない行は、1件でも在るときだけ `rowsUnreadable` に載せる**（issue #2536。
        // 0件なら鍵ごと無い）。読めない行しか無いと `grants` は空で「許可が無い」に見える。
        // 本文は載らない（id と不正な欄名だけ）。
        const rowsUnreadable = toRowsUnreadable(await stores.permissionGrants.listUnreadable());
        return c.json(
          permissionGrantsResponseSchema.parse({
            grants,
            ...(rowsUnreadable === undefined ? {} : { rowsUnreadable }),
          }),
        );
      },
    )

    .post(
      '/permission-grants/:id/revoke',
      describeRoute({
        tags: ['permission-grants'],
        summary: '許可を取り消す',
        description:
          '行は消さず `revokedAt` を立てる（`approval_withdraw` / `commitment_close` と同じ' +
          '「終端は別の状態であって削除ではない」思想）。**取り消しは次の Bash 呼び出しから' +
          '効く**——`#onPreToolUse` は呼び出しのたびにストアを引き直し、キャッシュしない。' +
          '既に取り消し済みでも 200（`revokedAt` は上書きしない）。運ぶ情報は無い（`{}` を送る）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストで許可を' +
            '落とされないため）。',
        ),
        responses: {
          200: {
            description: '取り消した（既に取り消し済みでも 200）。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          404: {
            description: '該当する許可が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '該当する許可の行は在るが、型に合わない形で入っていて読めない（居ないのとは' +
              '区別する。issue #2425）。取り消しはこの口ではできず、行は変わっていない。' +
              '読めない許可は「許可が無い」ものとして扱われる（通らない）。消すには ' +
              '`POST /permission-grants/unreadable/remove`（issue #2440）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      async (c) => {
        const id = c.req.param('id');
        // `get()` → `put({ ...grant, revokedAt })` にしないこと——lost update
        // （`PermissionGrantStore.revoke` の doc。#1654 と同型）。`revoke` が
        // 排他区間の中で現在値を読み直すので、`#onPreToolUse` の `markUsed`
        // 割り込みでも取り消しが消えない。
        // **issue #2425。** 読めない行（`invalidGrantsRaw`）は「無い」（404）ではなく
        // 「読めない形で在る。取り消しはこの口ではできない」（409）と言い分ける
        // （`GET /managers/:id` の #2359 と同じ線）。行は変わっていない。
        let grant: Awaited<ReturnType<typeof stores.permissionGrants.revoke>>;
        // **日誌の書き分けのためだけに、取り消す前の状態を読む**（#3362）。取り消し自体は
        // この読みに依らない（`revoke` が排他区間の中で読み直す）。読めない行は `get()` に
        // 現れず `null` になるが、そのときは下の `revoke` が 409 で止める。
        const revokedBefore = (await stores.permissionGrants.get(id))?.revokedAt !== undefined;
        const revokeAt = new Date().toISOString();
        try {
          grant = await stores.permissionGrants.revoke(id, revokeAt);
        } catch (error) {
          if (!(error instanceof UnreadablePermissionGrantError)) throw error;
          return c.json(
            {
              error:
                `許可 ${error.id} は読めない形で入っている（消されたのでも、取り消されたのでもない）。` +
                '取り消しはこの口ではできない。本文はここでは取れない。' +
                '消すには `POST /permission-grants/unreadable/remove`（alteroid permission remove-unreadable <id>）を使う。',
            },
            409,
          );
        }
        if (grant === null) return c.json({ error: 'not found' as const }, 404);
        // 誰が取り消したかは必ず残す（`/access/*` の grant/revoke と同じ理由——
        // 「事後に追えることが最終承認の実体」PRD「可観測性」）。
        // **ただし取り消し自体はもう効いている**（Issue #2037）。日誌への
        // 追記だけが落ちても 500 を返さない——`appendJournalOrDrop` の doc。
        // **操作は毎回残し、出来事は重ねない**（#3362）。2回目以降（既に取り消し済みの
        // 許可への取り消し）は「取り消した」と書かず、「既に取り消し済みだった。revokedAt は
        // 変えていない」と書き分ける（`revoke` は元の `revokedAt` を保つ）。既に取り消し済みかは
        // 読み取り前の状態、または `revoke` が返した `revokedAt` が今回の時刻でないことで判る
        // （並行した2つの取り消しで、読み取りが両方とも「まだ」でも後に着いた側が拾える）。
        const alreadyRevoked = revokedBefore || grant.revokedAt !== revokeAt;
        await appendJournalOrDrop(
          stores,
          {
            type: 'decision',
            decision: alreadyRevoked
              ? `許可の取り消しを求められたが、既に取り消し済みだった（revokedAt は変えていない）: ${grant.rule}`
              : `許可を取り消した: ${grant.rule}`,
            grounds: `${describeActor(c.get('principal'))}（POST /permission-grants/${id}/revoke）`,
          },
          '許可の取り消しの日誌',
          `id=${id}`,
        );
        return c.json({ ok: true });
      },
    )

    /**
     * **読めない許可の行を、id で指して消す**（issue #2440。`POST /tokens/unreadable/remove`
     * 〈#2354〉と同じ形）。読めない行（版ずれ・手編集）は `/permission-grants/:id/revoke` が
     * 409 で触らないので、片付ける口はここだけである。
     *
     * **形は `POST /inbox/remove` に合わせた（id の配列を取る POST）。** `:id` の下に置かない
     * ——読めた行の id と名前空間が重なりうるので、別の語（`unreadable`）の下に置く。
     * **日誌を先に書き、書けなければ状態を変えずに 500。** 日誌に残すのは消す id と件数だけ
     * （許可の本文は書かない）。読めない行に無い id が1つでもあれば何も消さず 404（指された
     * 文字列は返さない）。**資格は `authenticate` だけ（`revoke` と同じ強さ）。**
     */
    .post(
      '/permission-grants/unreadable/remove',
      describeRoute({
        tags: ['permission-grants'],
        summary: '読めない許可の行を、id を指して消す',
        description:
          '読めない（型に合わない形で入っている）許可の行だけを、id を指して消す。読める許可には' +
          '触れない。id が取れない行はこの口では消せない（`permission-grants.json` を手で直す）。' +
          '1つでも読めない行に無い id があれば何も消さない。消した id と件数を日誌に残す' +
          '（行の中身は残さない）。',
        responses: {
          200: {
            description: '消した id と件数。',
            content: {
              'application/json': { schema: resolver(unreadableRowsRemoveResponseSchema) },
            },
          },
          400: {
            description: '入力の形が不正（何も消していない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description:
              '指した id のうち、読めない行に無いものがあった（何も消していない。日誌も書いていない。pg で日誌の後の再確認で倒れた回だけは、日誌に打ち消しの行を足す）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          500: {
            description:
              '日誌が書けなかった（**状態を変えていない**）か、消すのに失敗した。理由の本文は返さない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(unreadableRowsRemoveRequestSchema, (where) => ({
        error:
          '読めない行の id の入力の形が不正（何も消していない）' +
          (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const result = await removeUnreadableRowsWithJournal({
          stores,
          subject: '許可の記録',
          actor: describeActor(c.get('principal')),
          route: 'POST /permission-grants/unreadable/remove',
          requested: c.req.valid('json').ids,
          remove: (ids, options) => stores.permissionGrants.removeUnreadable(ids, options),
        });
        if (result.kind === 'unknown') {
          return c.json(
            {
              error:
                `指した id のうち ${String(result.count)} 件が、読めない許可の行に無い` +
                '（何も消していない。id は `GET /permission-grants` の `rowsUnreadable.rows[].id`（alteroid permission list）で確かめる）',
            },
            404,
          );
        }
        if (result.kind === 'failed') {
          return c.json({ error: '許可の記録を保存できなかった' as const }, 500);
        }
        return c.json(
          unreadableRowsRemoveResponseSchema.parse({
            removedIds: result.ids,
            count: result.ids.length,
          }),
        );
      },
    )

    // --- 連携の鍵（外のサービスへ渡す、固定の 1 source で外部イベントだけを送れる鍵） ---------
    /**
     * 連携の鍵の一覧。**値（`altk_...`）も sha256 の全体も返さない**（見分けるための先頭12桁だけ）。
     *
     * **資格は `authenticate` だけ**（許可済みのアカウント・operator）。**連携の鍵そのものは入れない**
     * （`authenticate` が既定で拒否する。`humanOnly` はその二重の門）。
     */
    .get(
      '/integration-keys',
      describeRoute({
        tags: ['integration-keys'],
        summary: '連携の鍵の一覧',
        description:
          '外のサービスへ渡した連携の鍵の一覧（失効・期限切れを含む）。**値も sha256 の全体も返さない**' +
          '（`fingerprint` は sha256 の先頭12桁で、見分けるためだけの値）。行が読めない（版ずれ・手編集）' +
          '鍵が在るときだけ、`rowsUnreadable`（件数と id・不正な欄名。名前などの中身は載せない）が付く。' +
          '読めない行しか無いと `keys` は空だが「鍵が無い」とは限らない（読めない行の鍵は使えない）。' +
          'id を `POST /integration-keys/unreadable/remove` に渡して消せる。',
        responses: {
          200: {
            description: '連携の鍵の一覧。',
            content: {
              'application/json': { schema: resolver(integrationKeysListResponseSchema) },
            },
          },
        },
      }),
      humanOnly,
      async (c) => {
        const keys = await stores.integrationKeys.listIntegrationKeys();
        // **読めない行は、1件でも在るときだけ `rowsUnreadable` に載せる**（issue #3216。`GET /access` と同じ形）。
        const rowsUnreadable = toRowsUnreadable(
          await stores.integrationKeys.listUnreadableIntegrationKeys(),
        );
        return c.json(
          integrationKeysListResponseSchema.parse({
            keys: keys.map(integrationKeyView),
            ...(rowsUnreadable === undefined ? {} : { rowsUnreadable }),
          }),
        );
      },
    )

    /**
     * **読めない連携の鍵の行を、id で指して消す**（issue #3216。`POST /access/unreadable/remove`・
     * `POST /permission-grants/unreadable/remove` と同じ形・同じ確認・同じ日誌の残し方）。読めない行は
     * `/integration-keys/:id/revoke` が 404 で触らないので、片付ける口はここだけである。`:id` と取り違えない
     * よう、別の語（`unreadable`）の下に置く。
     *
     * **日誌を先に書き、書けなければ状態を変えずに 500。** 日誌に残すのは消す id と件数だけ（名前・source・
     * sha256 などの中身は書かない）。読めない行に無い id が1つでもあれば何も消さず 404（指された文字列は
     * 返さない）。読めた鍵には触れない。資格は `humanOnly`（連携の鍵では管理できない）。
     */
    .post(
      '/integration-keys/unreadable/remove',
      describeRoute({
        tags: ['integration-keys'],
        summary: '読めない連携の鍵の行を、id を指して消す',
        description:
          '読めない（型に合わない形で入っている）連携の鍵の行だけを、id を指して消す。読める鍵には触れない。' +
          'id が取れない行はこの口では消せない（`auth/integration-keys.json` を手で直す）。1つでも読めない行に' +
          '無い id があれば何も消さない。消した id と件数を日誌に残す（行の中身は残さない）。',
        responses: {
          200: {
            description: '消した id と件数。',
            content: {
              'application/json': { schema: resolver(unreadableRowsRemoveResponseSchema) },
            },
          },
          400: {
            description: '入力の形が不正（何も消していない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description:
              '指した id のうち、読めない行に無いものがあった（何も消していない。日誌も書いていない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          500: {
            description:
              '日誌が書けなかった（**状態を変えていない**）か、消すのに失敗した。理由の本文は返さない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      humanOnly,
      jsonBody(unreadableRowsRemoveRequestSchema, (where) => ({
        error:
          '読めない行の id の入力の形が不正（何も消していない）' +
          (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const result = await removeUnreadableRowsWithJournal({
          stores,
          subject: '連携の鍵',
          actor: describeActor(c.get('principal')),
          route: 'POST /integration-keys/unreadable/remove',
          requested: c.req.valid('json').ids,
          remove: (ids, options) =>
            stores.integrationKeys.removeUnreadableIntegrationKeys(ids, options),
        });
        if (result.kind === 'unknown') {
          return c.json(
            {
              error:
                `指した id のうち ${String(result.count)} 件が、読めない連携の鍵の行に無い` +
                '（何も消していない。id は `GET /integration-keys` の `rowsUnreadable.rows[].id`（alteroid integration list）で確かめる）',
            },
            404,
          );
        }
        if (result.kind === 'failed') {
          return c.json({ error: '連携の鍵を保存できなかった' as const }, 500);
        }
        return c.json(
          unreadableRowsRemoveResponseSchema.parse({
            removedIds: result.ids,
            count: result.ids.length,
          }),
        );
      },
    )

    /**
     * 連携の鍵を発行する。**値はこの応答で1度だけ返す**（保存は sha256 だけ）。
     *
     * **日誌を先に書き、書けなければ状態を変えずに 500**（`access grant` と同じ作法。#2043）。
     * 日誌には名前・source・id・指紋（sha256 の先頭12桁）だけを書き、**鍵の値は書かない**。
     */
    .post(
      '/integration-keys',
      describeRoute({
        tags: ['integration-keys'],
        summary: '連携の鍵を発行する',
        description:
          '外のサービスへ渡す鍵を発行する。**鍵の種類そのものが「固定の 1 source で外部イベントを送る」' +
          'という 1 つの能力だけを表す**（選べる許可の一覧は無い）。通れるのは `POST /events`（本文の ' +
          'source が鍵の source と一致するとき）と `POST /events/:source`（パスが一致するとき）だけで、' +
          'それ以外の口は **すべて 403**（鍵の管理の口を含む）。本文は既定で 1 MiB、回数は既定で 60 回/分' +
          'まで（鍵ごとに上書きできる。この上限は連携の鍵にだけ掛かる）。**値（`altk_...`）はこの応答で' +
          '1度だけ返し、後からは取り出せない**（保存は sha256 だけ）。',
        responses: {
          200: {
            description: '発行した。`value` はこの応答でだけ見える。',
            content: {
              'application/json': { schema: resolver(integrationKeyCreateResponseSchema) },
            },
          },
          400: {
            description:
              '入力の形が不正、または source が daemon 自身の予約語（`code`: `reserved_source`＝' +
              '`token-pool`・`runner-registry`）（何も作っていない）。',
            content: {
              'application/json': { schema: resolver(integrationKeyCreateErrorResponseSchema) },
            },
          },
          500: {
            description: '日誌が書けなかった（**状態を変えていない**）。',
            content: { 'application/json': { schema: resolver(journalWriteFailedResponseSchema) } },
          },
        },
      }),
      humanOnly,
      jsonBody(integrationKeyCreateRequestSchema, (where) => ({
        error: '連携の鍵の入力の形が不正（何も作っていない）' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const input = c.req.valid('json');
        // **daemon 自身が使う予約語の source の鍵は作らない**（外から名乗れる鍵になる）。
        if (isReservedEventSource(input.source)) return c.json(RESERVED_SOURCE_KEY_BODY, 400);
        const at = integrationClock();
        if (input.expiresAt !== undefined && !(Date.parse(input.expiresAt) > at.getTime())) {
          return c.json({ error: 'expiresAt が過去（何も作っていない）' as const }, 400);
        }
        const value = issueIntegrationKeyValue();
        const record: IntegrationKeyRecord = {
          id: randomUUID(),
          name: input.name,
          source: input.source,
          sha256: sha256Hex(value),
          createdAt: at.toISOString(),
          createdBy: describeActor(c.get('principal')),
          expiresAt: input.expiresAt ?? null,
          revokedAt: null,
          lastUsedAt: null,
          maxBodyBytes: input.maxBodyBytes ?? null,
          ratePerMinute: input.ratePerMinute ?? null,
        };
        try {
          await stores.journal.append({
            type: 'decision',
            decision: `連携の鍵を発行: ${describeIntegrationKey(record)}`,
            grounds:
              `${describeActor(c.get('principal'))}（POST /integration-keys）。` +
              '鍵の値は書かない（名前・source・id・指紋だけ）。',
          });
        } catch (error) {
          noteDroppedRecord(
            '連携の鍵の発行の日誌（発行していない）',
            `id=${record.id}`,
            kindOfError(error),
          );
          return c.json(journalWriteFailedBody(), 500);
        }
        try {
          await stores.integrationKeys.putIntegrationKey(record);
        } catch (error) {
          // 日誌には「発行した」が残っているので、打ち消す（記録が多すぎる側に倒す）。
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `連携の鍵を発行できなかった: ${describeIntegrationKey(record)}`,
              grounds: `${describeActor(c.get('principal'))}（POST /integration-keys、保存が失敗）`,
            },
            '連携の鍵の発行の打ち消しの日誌',
            `id=${record.id}`,
          );
          throw error;
        }
        const stored = (await stores.integrationKeys.getIntegrationKey(record.id)) ?? record;
        return c.json(
          integrationKeyCreateResponseSchema.parse({ key: integrationKeyView(stored), value }),
        );
      },
    )

    /**
     * 連携の鍵を失効させる。**冪等**（失効済みはそのまま 200。先の時刻を動かさず、日誌も足さない）。
     * 日誌を先に書き、書けなければ状態を変えずに 500。
     */
    .post(
      '/integration-keys/:id/revoke',
      describeRoute({
        tags: ['integration-keys'],
        summary: '連携の鍵を失効させる',
        description:
          '連携の鍵を失効させる。以後その鍵は 401 になる（発行済みの値を消さなくても即座に効く）。' +
          '失効済みの鍵への再実行は 200（先の失効の時刻を動かさない）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストで失効させられないため）。',
        ),
        responses: {
          200: {
            description: '失効した（既に失効済みでも 200）。',
            content: { 'application/json': { schema: resolver(integrationKeyResponseSchema) } },
          },
          404: {
            description: '該当する鍵が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '鍵の行が読めない形で入っている（失効できない）。`POST /integration-keys/unreadable/remove` で消す。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          500: {
            description: '日誌が書けなかった（**状態を変えていない**）。',
            content: { 'application/json': { schema: resolver(journalWriteFailedResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      humanOnly,
      deliberateClient,
      async (c) => {
        const id = c.req.param('id');
        const before = await stores.integrationKeys.getIntegrationKey(id);
        if (before === null) {
          // 読めない形で入っている行は「無い」ではなく 409 で言い分ける（`/permission-grants/:id/revoke` と同じ。#3216）。
          const unreadable = await stores.integrationKeys.listUnreadableIntegrationKeys();
          if (unreadable.some((row) => row.id === id)) {
            return c.json(
              {
                error:
                  `連携の鍵 ${id} は読めない形で入っている（消されたのでも、失効したのでもない）。` +
                  '失効はこの口ではできない。' +
                  '消すには `POST /integration-keys/unreadable/remove`（alteroid integration remove-unreadable <id>）を使う。',
              },
              409,
            );
          }
          return c.json({ error: 'not found' as const }, 404);
        }
        if (before.revokedAt !== null) {
          return c.json(integrationKeyResponseSchema.parse({ key: integrationKeyView(before) }));
        }
        try {
          await stores.journal.append({
            type: 'decision',
            decision: `連携の鍵を失効: ${describeIntegrationKey(before)}`,
            grounds: `${describeActor(c.get('principal'))}（POST /integration-keys/:id/revoke）`,
          });
        } catch (error) {
          noteDroppedRecord(
            '連携の鍵の失効の日誌（失効していない）',
            `id=${id}`,
            kindOfError(error),
          );
          return c.json(journalWriteFailedBody(), 500);
        }
        let result;
        try {
          result = await stores.integrationKeys.revokeIntegrationKey(
            id,
            integrationClock().toISOString(),
          );
        } catch (error) {
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `連携の鍵を失効できなかった: ${describeIntegrationKey(before)}`,
              grounds: `${describeActor(c.get('principal'))}（POST /integration-keys/:id/revoke、状態の変更が失敗）`,
            },
            '連携の鍵の失効の打ち消しの日誌',
            `id=${id}`,
          );
          throw error;
        }
        if (result.status === 'not_found') {
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `連携の鍵を失効できなかった: ${describeIntegrationKey(before)}`,
              grounds: `${describeActor(c.get('principal'))}（POST /integration-keys/:id/revoke、対象が消えていた）`,
            },
            '連携の鍵の失効の打ち消しの日誌',
            `id=${id}`,
          );
          return c.json({ error: 'not found' as const }, 404);
        }
        return c.json(integrationKeyResponseSchema.parse({ key: integrationKeyView(result.key) }));
      },
    )

    // --- 外部イベントの入口（起点③） ----------------------------------------
    /**
     * 自作ツール・ショートカット・CI からクローンへ出来事を届ける。
     * 何をするかはここで決めない（対応表を持った瞬間に自動化ジョブに戻る）。
     */
    .post(
      '/events',
      describeRoute({
        tags: ['events'],
        summary: '外部イベントをクローンへ届ける',
        description:
          '自作ツール・ショートカット・CI からクローンへ出来事を届ける。何をするかはここで' +
          '決めない（対応表を持った瞬間に自動化ジョブに戻る）。' +
          '**`attachments`（任意）— `POST /attachments` が返した id を渡すと、その添付がクローンのターンへ届く' +
          '（画像はモデルへの入力として、すべての添付は通知行として）。** 検証と結び付けは投函の前に行い、' +
          '断るときはイベントを投函しない。**連携の鍵（`altk_`）で送るときは、その鍵自身が' +
          '`POST /attachments` で上げた添付だけ**付けられる（別の鍵・アカウント・operator が上げたものは 400）。' +
          '人間・operator は `POST /chat` と同じ規則（上げた主体は問わない）。結び付いた添付は別のイベント・会話へ使い回せない。',
        responses: {
          200: {
            description:
              '受信箱へ**永続化できた**（器へ書けてから返す。以後は配達される）。**この応答を受けたら送り直さない**（二重に届く）。',
            content: { 'application/json': { schema: resolver(eventAcceptedResponseSchema) } },
          },
          503: eventNotPersistedResponse(),
          403: {
            description:
              '連携の鍵の source と、本文の source が違う（連携の鍵でだけ起きる。人間・operator は任意の source を名乗れる）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          400: eventBadRequestResponse(),
          ...integrationKeyEventResponses(),
          ...eventAttachmentResponses(),
        },
      }),
      jsonBody(eventBody, (where) => ({
        error: 'source/payload の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const { source, payload, attachments: attachmentIds } = c.req.valid('json');
        const principal = c.get('principal');
        // **連携の鍵は、本文の source が鍵の source と一致するときだけ通す**（不一致は 403。日誌には書かない）。
        if (principal.kind === 'integration' && source !== principal.source) {
          noteIntegrationRefusal(c, 403, '本文の source が鍵の source と違う', principal.keyId);
          return c.json({ error: '本文の source が、この連携の鍵の source と違う' as const }, 403);
        }
        // **NUL・孤立サロゲートと予約語は入口で断る（予約語は正規化の後。添付の検査より前なので、何も結ばず何も積まない）。**
        if (isMalformedEventSource(source)) return c.json(INVALID_SOURCE_BODY, 400);
        if (isReservedEventSource(source)) return c.json(RESERVED_SOURCE_BODY, 400);
        const id = randomUUID();
        // **投函の前に検証し、結び付ける**（弾くなら受信箱に何も積まない）。
        const attached = await bindEventAttachments(attachmentIds, id, principal);
        if (!attached.ok) return c.json(attached.body, attached.status);
        const at = new Date().toISOString();
        // **受信箱へ永続化できたときだけ 200 を返す**（#3679）。書けなかったら 503 で、受信箱のメモリにも積まない。
        const outcome = await postExternalPersisted(
          {
            type: 'external',
            id,
            at,
            source,
            payload,
            ...(principal.kind === 'integration'
              ? { via: { keyId: principal.keyId, name: principal.name } }
              : {}),
            ...(attached.refs.length === 0 ? {} : { attachments: attached.refs }),
          },
          attached.refs,
        );
        if (outcome === 'unavailable') return c.json(eventNotPersistedBody(), 503);
        // 稼働の地図の「外部サービス → クローン」を、受け付けた時刻で光らせる（#3676。
        // 日誌の external_event はクローンが取り出した時刻なので使わない。`topology-activity.ts` の冒頭）。
        if (principal.kind === 'integration') {
          topologyActivity.recordExternal({
            keyId: principal.keyId,
            name: principal.name,
            source,
            at,
          });
        }
        return c.json({ ok: true, id });
      },
    )

    /**
     * 他人が形を決めている webhook 用。本文をそのまま payload として運ぶので、
     * 送り元を改造できなくても届く（GitHub や CI からそのまま叩ける）。
     */
    .post(
      '/events/:source',
      describeRoute({
        tags: ['events'],
        summary: '本文の形を選べない webhook 用の入口',
        description:
          '他人が形を決めている webhook 用。本文をそのまま payload として運ぶので、送り元を' +
          '改造できなくても届く（GitHub や CI からそのまま叩ける）。JSON として読めない本文は' +
          '文字列のまま渡す。' +
          '**添付はクエリ `?attachments=<id>&attachments=<id>` で渡す**（本文は payload まるごとなので、' +
          '`POST /events` の本文の `attachments` とは渡し方だけが違い、検証・結び付け・連携の鍵の扱いは同じ）。' +
          'クエリを付けない既存の呼び手は何も変わらない。',
        requestBody: noBodyPostRequestBody(
          '**本文まるごとが payload になる。** 送り元が形を決めているので中身は縛らない。' +
            'JSON として読めない本文は文字列のまま渡す。`content-type: application/json` は' +
            '必要（ブラウザの単純リクエストで判断材料を書き込まれないため）。サーバは空の' +
            '本文も受けて空文字列にするが、**spec としては本文を必須にしてある** — 生成' +
            'クライアントに content-type を必ず付けさせるため（運ぶものが無いなら `{}`）。',
        ),
        responses: {
          200: {
            description:
              '受信箱へ**永続化できた**（器へ書けてから返す。以後は配達される）。**この応答を受けたら送り直さない**（二重に届く）。',
            content: { 'application/json': { schema: resolver(eventAcceptedResponseSchema) } },
          },
          503: eventNotPersistedResponse(),
          403: {
            description:
              '連携の鍵の source と、パスの source が違う（連携の鍵でだけ起きる。人間・operator は任意の source を名乗れる）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          400: eventBadRequestResponse(),
          ...noBodyPostResponses(),
          ...integrationKeyEventResponses(),
          ...eventAttachmentResponses(),
        },
      }),
      deliberateClient,
      queryParams(eventSourceQuery),
      async (c) => {
        const source = c.req.param('source');
        const rawAttachments = c.req.valid('query').attachments;
        const attachmentIds = (
          rawAttachments === undefined
            ? []
            : Array.isArray(rawAttachments)
              ? rawAttachments
              : [rawAttachments]
        ).filter((id) => id !== '');
        const principal = c.get('principal');
        // 門番がパスで判定済みだが、ルートの解釈とずれても通さないよう、ここでも突き合わせる（二重の門）。
        if (principal.kind === 'integration' && source !== principal.source) {
          noteIntegrationRefusal(c, 403, 'パスの source が鍵の source と違う', principal.keyId);
          return c.json({ error: 'パスの source が、この連携の鍵の source と違う' as const }, 403);
        }
        // **NUL・孤立サロゲートと予約語は入口で断る（予約語は正規化の後。本文も添付も読む前なので、何も結ばず何も積まない）。**
        if (isMalformedEventSource(source)) return c.json(INVALID_SOURCE_BODY, 400);
        if (isReservedEventSource(source)) return c.json(RESERVED_SOURCE_BODY, 400);
        const raw = await c.req.text();
        let payload: unknown = raw;
        try {
          payload = raw.length > 0 ? JSON.parse(raw) : '';
        } catch {
          // JSON でなければ本文のまま渡す
        }
        const id = randomUUID();
        const attached = await bindEventAttachments(attachmentIds, id, principal);
        if (!attached.ok) return c.json(attached.body, attached.status);
        const at = new Date().toISOString();
        // **受信箱へ永続化できたときだけ 200 を返す**（#3679）。書けなかったら 503 で、受信箱のメモリにも積まない。
        const outcome = await postExternalPersisted(
          {
            type: 'external',
            id,
            at,
            source,
            payload,
            ...(principal.kind === 'integration'
              ? { via: { keyId: principal.keyId, name: principal.name } }
              : {}),
            ...(attached.refs.length === 0 ? {} : { attachments: attached.refs }),
          },
          attached.refs,
        );
        if (outcome === 'unavailable') return c.json(eventNotPersistedBody(), 503);
        // `POST /events` と同じ（#3676）。
        if (principal.kind === 'integration') {
          topologyActivity.recordExternal({
            keyId: principal.keyId,
            name: principal.name,
            source,
            at,
          });
        }
        return c.json({ ok: true, id });
      },
    )

    // --- 時間起点のジョブ ---------------------------------------------------
    .get(
      '/schedule',
      describeRoute({
        tags: ['schedule'],
        summary: '定期ジョブの一覧と次の発火時刻',
        description:
          '行が読めない（版ずれ・手編集）継続中の依頼が在るときだけ、`unreadable`（kind が取れれば' +
          'kind と不正な欄名）が載る。**壊れた行であって、消された依頼ではない。**' +
          '0件なら鍵ごと無い（issue #2343）。',
        responses: {
          200: {
            description: '定期ジョブの一覧。',
            content: { 'application/json': { schema: resolver(scheduleListResponseSchema) } },
          },
        },
      }),
      (c) => {
        // **読めない行は 1 件でも在るときだけ `unreadable` を載せる**（issue #2343）。
        // 0 件なら鍵ごと無い（既存の呼び手の応答を1バイトも変えない）。
        const unreadable = deps.scheduler?.unreadable() ?? [];
        return c.json(
          scheduleListResponseSchema.parse({
            entries: deps.scheduler?.list() ?? [],
            ...(unreadable.length > 0 ? { unreadable } : {}),
          }),
        );
      },
    )

    /**
     * 継続中の依頼を仕込む・直す（同じ kind なら置き換わる）。
     *
     * 真実はストア側にあり、スケジューラはそれを読み直すだけである。ここで
     * スケジューラへ直接足すと、デーモンを再起動した瞬間に消える仕込みができる。
     */
    .post(
      '/schedule',
      describeRoute({
        tags: ['schedule'],
        summary: '継続中の依頼を仕込む・直す',
        description:
          '「定期的に〜しておいて」をクローンの記憶任せにせず、時刻が来れば必ず届く形で置く。' +
          '同じ kind なら置き換わる（前回動いた時刻は保つ）。' +
          // **版（Issue #3821）。** 発火（claimRun）では `updatedAt` は動かない。
          '任意の `ifMatch`（`GET /schedule` で読んだ時の `updatedAt`。無かったなら null）を付けると、' +
          '版が違うときは書かずに 409。省略は従来どおり後勝ち。' +
          '真実はストア側にあり、' +
          'スケジューラはそれを読み直すだけなので、デーモンを作り直しても残る。' +
          // **一覧を数え直さない（#701 / #756）。** ここは `RESERVED_SCHEDULE_KINDS` から
          // 導出する —— `memory_tidy` が足された後も2つのまま取り残されていた
          // （この description は `apps/daemon/openapi.json` へ焼かれるので、生成物の
          // ほうも同じ嘘を持っていた）。
          `既定の定期ジョブ（${RESERVED_SCHEDULE_KINDS.join(' / ')}）の名前は奪えない（→ 409）。`,
        responses: {
          200: {
            description: '仕込んだ。次の発火は `GET /schedule` で見える。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正（kind の形・時刻の範囲もここで弾く）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '次の3つ。(1) 既定の定期ジョブの名前（`{ error }` だけ）。(2) `ifMatch`（読んだ時の版 =' +
              ' `updatedAt`）が、いまの版と違う（読んでから書くまでの間に別の書き手が書いた、または' +
              '消した。`null` を送ったのに既に在る場合も）。**何も書いていない。** `current` にいまの' +
              '依頼を返す（消えていれば null）。見分けは `current` の鍵の有無。' +
              '(3) その kind の行が読めない形で入っている（版ずれ・手編集。`{ error }` だけ。`ifMatch` の' +
              '有無を問わない）。**何も書いていない。** `DELETE /schedule/{kind}` で外してから作り直す。',
            content: {
              'application/json': {
                schema: resolver(z.union([scheduleConflictResponseSchema, errorResponseSchema])),
              },
            },
          },
        },
      }),
      jsonBody(scheduleBody, (where) => ({
        error:
          'kind/request/spec の形が不正' +
          (where === '' ? '' : `: ${where}`) +
          // every の分数の断りは、上限と代わりの書き方を伝える（#3533）。値は混ぜない（固定の文だけ）。
          (where.split(', ').includes('spec.minutes')
            ? `（${SCHEDULE_EVERY_MINUTES_MAX_MESSAGE}）`
            : ''),
      })),
      async (c) => {
        const { kind, request, spec, ifMatch } = c.req.valid('json');
        if (RESERVED_SCHEDULE_KINDS.includes(kind)) {
          return c.json({ error: 'reserved kind' as const }, 409);
        }
        const now = new Date().toISOString();
        // **能力を広げる口（issue #2123。teto の判断、#2043 (a) と同じ設計）。**
        // 日誌を先に書く。書けなければ仕込まずに 500（下の `base.onError` へ
        // 抜けるに任せる）。「仕込んだ」か「直した」かは `editRequest` の戻り値
        // でしか分からないので、先に書く行はそれを含まない形にし、後で分かる
        // 分は2行目として `appendJournalOrDrop`（best-effort）で足す。
        await stores.journal.append({
          type: 'decision',
          decision: `人間が定期の依頼を設定しようとしている: ${kind}: ${request}`,
          grounds: '人間が直接 API から仕込んだ',
        });

        // **編集は `editRequest`、新規作成だけ `put`（Issue #1654）。**
        // かつてはここで `get()` した `existing` から `lastRunAt` /
        // `lastScheduledRunAt` / `pendingRun` を写して `put()` していたが、
        // その「読んでから書く」の間に定期発火の `claimRun` が割り込むと、
        // 割り込んだ側が付けた印を丸ごと消していた（#1041 の
        // `CommitmentStore.open()` と同じ形の lost update。実測は
        // `packages/storage-fs/src/schedule-edit-keeps-claim.test.ts`）。
        // `editRequest` は現在値をストアの排他区間の中で読み直して引き継ぐので、
        // この隙間が無い。無ければ `null` — その場合だけ新規に作る。
        let edited: Awaited<ReturnType<Stores['schedules']['editRequest']>>;
        try {
          edited = await stores.schedules.editRequest(kind, { request, spec }, now, { ifMatch });
          if (edited === null) {
            // 版つき（`ifMatch: null`）なら「無いときだけ作る」を、ストアの排他の中で行う。
            // （文字列の版で無い kind は、`editRequest` が衝突で投げているのでここへ来ない。）
            await stores.schedules.put(
              { kind, spec, request, createdAt: now, updatedAt: now },
              ifMatch === undefined ? undefined : { ifMatch: null },
            );
          }
        } catch (error) {
          // **黙って上書きしない（Issue #3821）。** 書いていないので、先に積んだ
          // 「設定しようとしている」を打ち消す（下の失敗と同じ形）。
          if (error instanceof ScheduleConflictError) {
            await appendJournalOrDrop(
              stores,
              {
                type: 'decision',
                decision: `人間が定期の依頼を設定できなかった（読んだ後に変わっていた）: ${kind}: ${request}`,
                grounds: '人間が直接 API から仕込もうとしたが、読んだ版と違うので書いていない',
              },
              '定期の依頼の打ち消しの日誌',
              `kind=${kind}`,
            );
            return c.json(
              {
                error: '継続中の依頼が読んだ後に変わっています（書き換えていません）' as const,
                current: error.current,
              },
              409,
            );
          }
          if (error instanceof UnreadableScheduleError) {
            await appendJournalOrDrop(
              stores,
              {
                type: 'decision',
                decision: `人間が定期の依頼を設定できなかった（読めない形で入っている）: ${kind}: ${request}`,
                grounds:
                  '人間が直接 API から仕込もうとしたが、その kind の行が読めないので書いていない',
              },
              '定期の依頼の打ち消しの日誌',
              `kind=${kind}`,
            );
            return c.json({ error: describeUnreadableScheduleEdit(error) }, 409);
          }
          // 日誌には「設定しようとしている」が残っているので、打ち消す
          // （grant の「アクセス許可付与の打ち消しの日誌」と同じ形）。
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `人間が定期の依頼を設定できなかった: ${kind}: ${request}`,
              grounds: '人間が直接 API から仕込もうとしたが、状態の変更が失敗した',
            },
            '定期の依頼の打ち消しの日誌',
            `kind=${kind}`,
          );
          throw error;
        }
        // 仕込み・直しはもう効いている。後で分かった区別を2行目として足す
        // （落ちても 500 にしない——`appendJournalOrDrop` の doc）。
        await appendJournalOrDrop(
          stores,
          {
            type: 'decision',
            decision: `人間が定期の依頼を${edited !== null ? '直した' : '仕込んだ'}: ${kind}: ${request}`,
            grounds: '人間が直接 API から仕込んだ',
          },
          '定期の依頼の日誌',
          `kind=${kind}`,
        );
        // 次の刻みを待たずに効かせる（人間が仕込んだのに1分間存在しないのは嘘になる）
        await deps.scheduler?.refresh().catch(() => undefined);
        return c.json(okResponseSchema.parse({ ok: true }));
      },
    )

    .delete(
      '/schedule/:kind',
      describeRoute({
        tags: ['schedule'],
        summary: '継続中の依頼を外す',
        description:
          '済んだ依頼・もう要らない依頼をここで外す。既定の定期ジョブは仕込みではないので' +
          'ここでは外せない（間隔と締め時刻はデーモンの設定である）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** `DELETE` だが本文が必須なのは、' +
            '門番（`deliberateClient`）が `content-type: application/json` を要求することを' +
            'spec の機械可読部で表す手段がこれしか無いからである（`DELETE /managers/{id}` も' +
            '本文を要求する）。',
        ),
        responses: {
          200: {
            description: '外した。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          404: {
            description: 'その kind の継続中の依頼が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      async (c) => {
        const kind = c.req.param('kind');
        // **`get(kind)` を先に呼ばない（issue #1982）。** `get` は「消された」
        // （`null`）と「読めない」（throw）を区別する契約のまま変えていない
        // ので、壊れた行を先に `get` で読もうとするとここで例外が上がり、
        // 本来の目的（外す）まで届かなかった。`removeIfPresent` が
        // 「無かった／読めた／読めなかった」の3値を1回の往復で返すので、
        // 読んでから書くまでの隙間も無い（`ScheduleStore.removeIfPresent` の doc）。
        const removed = await stores.schedules.removeIfPresent(kind);
        if (removed === null) return c.json({ error: 'not found' as const }, 404);
        // **外すこと自体はもう効いている**（Issue #2037）。日誌への追記だけが
        // 落ちても 500 を返さない——`appendJournalOrDrop` の doc。
        await appendJournalOrDrop(
          stores,
          {
            type: 'decision',
            decision:
              removed === 'unreadable'
                ? // **本文を持たない。** 読めなかった行なので `request` を
                  // 取り出せない——取り出せたとしても、壊れた形のまま日誌へ
                  // 書くと読めない値をそのまま持ち回ることになる。
                  `人間が読めない形で入っていた依頼を外した: ${kind}`
                : `人間が定期の依頼を外した: ${kind}: ${removed.request}`,
            grounds: '人間が直接 API から外した',
          },
          '定期の依頼を外した日誌',
          `kind=${kind}`,
        );
        await deps.scheduler?.refresh().catch(() => undefined);
        return c.json(okResponseSchema.parse({ ok: true }));
      },
    )

    /**
     * 定期ジョブを今すぐ起こす（人間が待たずに確かめるための口）。
     *
     * これは観測ではなく**実行**である。起こせばクローンのターンが走り、記憶に
     * 基づく委譲や外部への操作の判断まで動く。ブラウザから叩けてはいけない。
     */
    .post(
      '/schedule/:kind/run',
      describeRoute({
        tags: ['schedule'],
        summary: '定期ジョブを今すぐ起こす',
        description:
          'これは観測ではなく実行である。起こせばクローンのターンが走り、記憶に基づく委譲や' +
          '外部への操作の判断まで動く。予定はずらさない（余分に1回起こす）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストで自律ターンを' +
            '起こされないため）。',
        ),
        responses: {
          200: {
            description: '起こした。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          404: {
            description: '知らない kind。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      (c) => {
        const kind = c.req.param('kind');
        if (deps.scheduler?.run(kind) !== true) return c.json({ error: 'not found' as const }, 404);
        return c.json(okResponseSchema.parse({ ok: true }));
      },
    )

    // --- 引き受けたまま終わっていない仕事の台帳 ------------------------------
    //
    // **クローンが持っている手（`commitment_list` / `commitment_open` /
    // `commitment_close`）を、人間の側にもそのまま置く。** 片方にしか無いと、
    // 頼んだことがまだ残っているのか片付いたのかを人間が確かめられず、
    // 台帳がクローンの内側だけの器になる（PRD「可観測性」）。
    //
    // **資格は `/schedule` と同じ（`authenticate` だけ）。`requireOperator` にしない。**
    // あちらは実行環境そのものを差し替える資格（`/profile`）であって、
    // 台帳の読み書きはそこまでの資格ではない。**`/access` はかつてここに並んでいたが、
    // 2026-09-06 のオーナー決定（alteroid を使う許可を実行環境の持ち主と同格にする）で
    // `authenticate` だけへ変わり、いまは `/tokens` ともどもこちら側である。** ここを
    // 持ち主だけにすると、「使ってよい」の2値を通ったアカウントから台帳だけが
    // 見えなくなる。
    //
    // **これは「やることの一覧」ではない。** 器が持つのは「何を頼まれたか」と
    // 「まだ片付いていない」の2値だけで、順序も優先度も締切も持たない。だから
    // 並べ替えや絞り込みの引数をここへ足さないこと（判断がクローンから器へ移る）。
    // **並べ替え・絞り込みは依然として足さない（理由: 判断がクローンから器へ移る）。
    // 窓（`limit`/`cursor`）は 2026-08-25 に人間の明示の「はい」を受けて足した。**
    // `limit`/`cursor` は固定された並び（`CommitmentStore.list` の契約）の上に
    // 頁を切るだけで、何が先か・何が重要かを何も決めない——だから上の禁止と
    // 衝突しない（`commitmentsQuery` の doc、`commitmentsCursorSchema` の doc）。
    .get(
      '/commitments',
      describeRoute({
        tags: ['commitments'],
        summary: '引き受けたまま終わっていない仕事の一覧',
        description:
          'クローンの `commitment_list` と同じものを人間の側から読む。既定は**未了だけ**で、' +
          '古い順に返る（齢が判断の材料なので、古いものから見せる）。`includeClosed=true` を' +
          '付けると片付けたものが未了の後ろに新しい順で続く。順序や優先度は器が持たない。' +
          '**並べ替え・絞り込みは依然として足さない（理由: 判断がクローンから器へ移る）。' +
          '窓（`limit`/`cursor`）は 2026-08-25 に人間の明示の「はい」を受けて足した。**' +
          '`unreadable` は台帳の行が読めなかったもの（issue #296）。**「無い」でも' +
          '「片付いた」でもない第3の状態**で、0件でも欄自体は必ず返る。**窓では絶対に' +
          '切らない**（issue #296 が塞いだ穴——読めない行が2頁目以降から消える——が' +
          '再び開くため）。' +
          '`trimmedClosed` は保持上限を超えて物理削除された片付き行の累計件数' +
          '（issue #416）。`unreadable` と同じく窓では切らない。契約を守れている' +
          '実装は常に `0`（`CommitmentList` の doc、`packages/core/src/store.ts`）。' +
          '`limit` / `cursor` のいずれかを明示すると頁の封筒（`total` / `nextCursor`）が' +
          '応答へ載る。**明示しない既定の呼びは、この変更の前と応答が1バイトも変わらない**' +
          '（opt-in。`.claude/skills/listing-and-detail/SKILL.md` の考え方と同じ——足すのは' +
          '能力であって、既存の呼び手に新しい欄を押し付けない）。並びは固定（未了は `at` ' +
          '昇順・片付きは `closedAt` 降順で、その順に連結）で、ここでは選べない——' +
          '窓はその上に頁を切るだけである（`commitmentsCursorSchema` の doc）。' +
          '各行の `respondedAt` は「放置」と「進行中」を見分けるための導出値（issue ' +
          '#1003）——クローンから人間への返答が日誌に見つかった最初の時刻で、無ければ' +
          '欄自体が無い（＝並べ替え・絞り込みの新しい軸ではなく、既存の記録から読める' +
          'ことを1つ増やしただけ）。`packages/core/src/schema.ts` の ' +
          '`commitmentRespondedAt` を参照。' +
          '各行の `activeManagerIds` も同じ目的の導出値（issue #1003 段2）——同じ会話の' +
          '中で、この行より後に始まって、いまも走っている委譲の `managerId` を並べた' +
          'もので、無ければ欄自体が無い。正確な1対1の紐付けではない（`packages/core' +
          '/src/schema.ts` の `commitmentActiveDelegationIds` を参照）。' +
          '`unreadableJobs` は読めなかった委譲の行（issue #2359）。`activeManagerIds` は' +
          '読めた委譲だけから組むので、読めない委譲に紐づく行は「委譲なし」に見える。' +
          '**どの行に紐づくかは、行が壊れているので言えない**（推測で紐づけない）。' +
          '1件でも在るときだけ載り（0件なら鍵が無い）、窓では切らない。`activeManagerIds` の' +
          '導出の対象になる行（`origin` が `human` で `source` を持つ）が1件も無いときは載らない。',
        responses: {
          200: {
            description: '台帳の中身。',
            content: { 'application/json': { schema: resolver(commitmentListResponseSchema) } },
          },
          400: {
            description:
              'クエリが不正（`includeClosed` は `true` / `false` だけ、`limit` は1以上の整数）、' +
              'または `cursor` が壊れている・`includeClosed` と食い違う。',
            content: {
              'application/json': {
                schema: resolver(errorResponseSchema),
              },
            },
          },
        },
      }),
      queryParams(commitmentsQuery),
      async (c) => {
        const { includeClosed, limit, cursor } = c.req.valid('query');
        // **opt-in の判定は生のクエリで行う。** `includeClosed` は既定値を持つので
        // `c.req.valid('query')` だけでは「渡されたか」が分からない
        // （`approvalsQuery` のハンドラの同じコメントと同じ理由——「渡されなかった」を
        // 「既定値と同じ値が渡された」と混同しないこと。`includeClosed` は窓の
        // opt-in には含めない——窓とは別の、既存の絞り込みだからである）。
        const optedIn = c.req.query('limit') !== undefined || c.req.query('cursor') !== undefined;

        // **`list()` は `{ entries, unreadable, trimmedClosed }` を返す
        // （issue #296 / #416）。** `unreadable` と `trimmedClosed` もそのまま
        // 応答へ含める — 人間の側（Web UI・API を直接叩く側）にもクローンと
        // 同じ「読めない行が在る」「物理削除された片付き行が在る」という事実が
        // 見えるようにする（`commitmentListResponseSchema` の doc）。
        const { entries, unreadable, trimmedClosed } = await stores.commitments.list(
          includeClosed === 'true' ? { includeClosed: true } : undefined,
        );
        // **`total` は窓を当てる前の件数。** opt-in していないときは応答に載せない
        // ので、ここで数えておくだけで並べ替えは行わない。
        const total = entries.length;

        // **「返答済み・未クローズ」（issue #1003）と「進行中（委譲あり）」（段2）の
        // 導出の材料。** 組み立ては `GET /progress` と共有する
        // （`buildCommitmentDerivations` の doc）。
        const { repliesByConversation, activeManagersByConversation } =
          await buildCommitmentDerivations(stores, entries);
        // **読めない委譲の行（issue #2359）。** `activeManagerIds` は `listJobs()` から組むので、
        // 読めない委譲に紐づく行は「委譲なし」に見える。どの行に紐づくかは言えない（行が壊れて
        // いる）ので、行へは紐づけず、1件でも在るときだけ `unreadableJobs` として別に載せる。
        const unreadableJobs = await readUnreadableJobsForCommitments(stores, entries);

        let cursorPayload: z.infer<typeof commitmentsCursorSchema> | undefined;
        if (cursor !== undefined) {
          try {
            cursorPayload = decodeCursor(cursor, commitmentsCursorSchema);
          } catch (error) {
            if (error instanceof InvalidCursorError) {
              return c.json({ error: error.message }, 400);
            }
            throw error;
          }
          // **黙って別の一覧の続きを返さない。** 錨は刷られた一覧（`includeClosed`）
          // の中でしか意味を持たない値なので、食い違えば作り直す以外に正しい続きが
          // 無い（`/approvals` が `order` の食い違いを 400 にしているのと同じ理由）。
          if (cursorPayload.includeClosed !== includeClosed) {
            return c.json(
              { error: 'カーソルの includeClosed がリクエストの includeClosed と食い違う' },
              400,
            );
          }
          // **id（行）の実在は検査しない。** `(segment, key, id)` の比較で辿るので、
          // 指していた行が閉じられて段（segment）を移っていても比較は成立し、続きは
          // 正しく決まる（`apps/daemon/src/cursor.ts` の `decodeCursor` の doc —
          // 「位置ではなく比較（keyset）で辿る口では実在検査は要らない」）。
        }

        // **窓は `entries` にだけ当てる。`unreadable` は絶対に窓で切らない。**
        // これは「無い」でも「片付いた」でもない第3の状態（issue #296）で、
        // 窓で切ると2頁目以降から読めない行が消え、まさに #296 が塞いだ穴が
        // 再び開く。
        // **opt-in しなければ `compareCommitmentPosition` は1回も通らない**
        // （`optedIn` のときにしか呼ばれない）——ストアの生の並びに乗るだけなら、
        // この関数を通す理由が無い。既定の呼びの応答が opt-in の前後でバイト
        // 単位で一致するのは、この形が支えている。
        let view = entries;
        if (optedIn) {
          view = [...entries].sort((a, b) =>
            compareCommitmentPosition(commitmentPosition(a), commitmentPosition(b)),
          );
          if (cursorPayload !== undefined) {
            const pivot = cursorPayload;
            view = view.filter(
              (entry) => compareCommitmentPosition(commitmentPosition(entry), pivot) > 0,
            );
          }
        }

        const page = optedIn && limit !== undefined ? view.slice(0, limit) : view;
        const hasMore = optedIn && page.length < view.length;
        const lastOfPage = page[page.length - 1];

        const responseBody: {
          entries: unknown[];
          unreadable: unknown[];
          trimmedClosed: number;
          unreadableJobs?: unknown[];
          total?: number;
          nextCursor?: string;
        } = {
          entries: page.map((entry) => ({
            ...entry,
            updatedAt: commitmentUpdatedAt(entry),
            respondedAt: commitmentRespondedAt(entry, repliesByConversation),
            activeManagerIds: commitmentActiveDelegationIds(entry, activeManagersByConversation),
          })),
          unreadable,
          trimmedClosed,
        };
        // 窓では切らない（`unreadable` と同じ）。0件なら鍵ごと無い（既存の応答は1バイトも変わらない）。
        if (unreadableJobs.length > 0) responseBody.unreadableJobs = unreadableJobs;
        if (optedIn) {
          responseBody.total = total;
          if (hasMore && lastOfPage !== undefined) {
            const pos = commitmentPosition(lastOfPage);
            responseBody.nextCursor = encodeCursor({
              segment: pos.segment,
              key: pos.key,
              id: pos.id,
              includeClosed,
            });
          }
        }
        return c.json(commitmentListResponseSchema.parse(responseBody));
      },
    )

    /**
     * 人間が台帳へ1件積む。
     *
     * **積むだけで、クローンのターンは起こさない。** ここは器であって仕事の起点では
     * ないので、いま考えさせたいなら `POST /chat` か `POST /events` を使う（起点を
     * 増やすと、同じことを2つの経路で起こせる状態になる）。積んだものは次のターンの
     * 冒頭に件数と齢として載り、`commitment_list` で全文が読める。
     */
    .post(
      '/commitments',
      describeRoute({
        tags: ['commitments'],
        summary: '引き受けた仕事として台帳へ積む',
        description:
          'クローンの `commitment_open` と同じものを人間の手から。**積むだけで、' +
          'クローンのターンは起こさない**（いま考えさせたいなら `POST /chat` か ' +
          '`POST /events`）。`origin` は `human` で固定され、id はここで振る。',
        responses: {
          200: {
            description: '積んだ。返る id が閉じるときの宛先になる。',
            content: { 'application/json': { schema: resolver(commitmentOpenedResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正（`body` は空にできない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(commitmentBody, (where) => ({
        error: 'body の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const { body, source } = c.req.valid('json');
        // **`origin` は本文から取らない。** ここを人間に選ばせると、人間が積んだものが
        // `self` を名乗れてしまい、「これは人間との約束か、自分で思い立ったことか」を
        // クローンが区別する手立てが消える（`commitmentOriginSchema` の注記）。
        const entry = {
          id: randomUUID(),
          at: new Date().toISOString(),
          origin: 'human' as const,
          ...(source === undefined ? {} : { source }),
          body,
        };
        await stores.commitments.open(entry);
        // 人間が chat の外から積んだものは、日誌に残さなければどこにも跡が無い
        // （chat 経由の依頼には `exchange` が残るが、この口には対応する発言が無い）。
        // **積むこと自体はもう効いている**（Issue #2037）。日誌への追記だけが
        // 落ちても 500 を返さない——`appendJournalOrDrop` の doc。
        await appendJournalOrDrop(
          stores,
          {
            type: 'decision',
            decision: `人間が引き受けた仕事を台帳へ積んだ（${entry.id}）: ${body}`,
            grounds: '人間が直接 API から積んだ',
          },
          '引き受けた仕事を積んだ日誌',
          `id=${entry.id}`,
        );
        return c.json(commitmentOpenedResponseSchema.parse({ ok: true, id: entry.id }));
      },
    )

    /**
     * 人間が1件を片付ける。
     *
     * **先に読んで判断しない。** 「読む → 未了だと分かる → 閉じる」に割ると、同じ id へ
     * 同時に届いた2つの close が両方とも「まだ未了だ」と読んでから両方書きにいき、
     * 後から来たほうの理由で上書きされる（＝人間が読む「何をもって終わりとしたか」が
     * 静かに入れ替わる）。**判定は台帳の1操作（`close`）に任せ**、読むのは 404 と 409 を
     * 書き分けるためだけにする。
     *
     * **⭐ 読めない約束も閉じられる（issue #2148）。** `close()` は先頭で
     * `get()` を呼ばないので、読めない行に対しても直接 `close()` を試す——
     * fs / pg のどちらも読めない行を閉じられるようになった（`CommitmentStore
     * .close` の doc、`storage-fs/src/commitments.ts` / `storage-pg/src/
     * commitments.ts` の `close` の doc）ので、この口はコードを変えずに
     * その恩恵を受ける。**変わるのは、`close()` が `false` を返した後の
     * フォールバック（下）だけ**——読めない行が「既に閉じている」ときは、
     * その後の `get(id)` が `UnreadableCommitmentError` を投げるので、
     * そこを捕まえて 409 にする（以前はここが未捕捉のまま伝播し 500 に
     * なっていた）。
     */
    .post(
      '/commitments/:id/close',
      describeRoute({
        tags: ['commitments'],
        summary: '引き受けた仕事を片付いたことにする',
        description:
          'クローンの `commitment_close` と同じものを人間の手から。**契約は「行は消さない」** — ' +
          '消すと「何を片付けたか」が日報の材料から落ちる。`reason` は必須で、' +
          '人間はこれを読んで後から否定する。**⚠️ fs 実装は保持上限を超えた古い片付き行を' +
          '物理削除するので、この契約を完全には守れていない（issue #416）。** 削除された' +
          '累計件数は `GET /commitments` の `trimmedClosed` で見える。**台帳の行が読めない' +
          '形で入っていても閉じられる**（issue #2148。中身は読めないままなので、閉じた後も' +
          '本文の書き直しはできない）。',
        responses: {
          200: {
            description: '閉じた。以後は `includeClosed=true` でだけ見える。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正（`reason` は空にできない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: 'その id は台帳に無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '既に片付いている（いつ・どう片付けたかを本文に入れて返す。読めない形で入って' +
              'いる行は、いつ・どう片付けたかが分からないことがある）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(commitmentCloseBody, (where) => ({
        error: 'reason の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const id = c.req.param('id');
        const { reason } = c.req.valid('json');
        if (!(await stores.commitments.close(id, new Date().toISOString(), reason, 'human'))) {
          // 閉じられなかった理由は台帳に聞く（無いのか、既に閉じているのか）。
          // **読めない行が既に閉じられているときは `get` が投げる**（issue
          // #2148。`close()` が中身を読めるようにしたわけではない——閉じた
          // かどうかだけが増えた欄なので、`get()` の契約はここでは変えない）。
          let existing;
          try {
            existing = await stores.commitments.get(id);
          } catch (error) {
            if (!(error instanceof UnreadableCommitmentError)) throw error;
            return c.json(
              {
                error: `${id} は既に片付けてある（読めない形で入っているため、いつ・どう片付けたかは分からない）`,
              },
              409,
            );
          }
          if (existing === null) return c.json({ error: 'not found' as const }, 404);
          return c.json(
            {
              error:
                `${id} は既に ${existing.closedAt ?? '不明な時刻'} に片付いている` +
                `（${existing.closedReason ?? '理由の記録なし'}）`,
            },
            409,
          );
        }
        // **片付けること自体はもう効いている**（Issue #2037）。日誌への追記だけが
        // 落ちても 500 を返さない——`appendJournalOrDrop` の doc。
        await appendJournalOrDrop(
          stores,
          {
            type: 'decision',
            decision: `人間が引き受けた仕事を片付けた（${id}）: ${reason}`,
            grounds: '人間が直接 API から閉じた',
          },
          '引き受けた仕事を片付けた日誌',
          `id=${id}`,
        );
        return c.json(okResponseSchema.parse({ ok: true }));
      },
    )

    /**
     * 人間が1件の本文を後から直す。
     *
     * **この口から編集できるのは `origin` が `human` かつまだ片付いていない
     * 行の `body` だけ。** `POST /commitments`（上）は `origin` を `human` に
     * 固定しているので、Web UI / API から積まれたものは必ず `human` である——
     * 人間の困りごとを過不足なく覆う。この線で切ると、人間が書き換えられるのは
     * 常に人間自身の言葉だけになる。**台帳は「クローンが何を引き受けたか」の
     * 記録であり、そこが _静かに_ 書き換わるとクローンが過去の自分を追えなく
     * なる**（`bodyMarkup` は `manager` のときだけ立つので、この線ならそちらへは
     * 触れずに済む）。`origin` / `source` / `at` / `closedAt` /
     * `closedReason` / `closedBy` は直さない。
     *
     * **⚠️ 「`self` の行は誰にも書き換えられない」ではない（issue #580 の
     * (B)）。** クローン自身は `commitment_edit`（`packages/core/src/tools.ts`）
     * で `origin: 'self'` の行を直せる。**ここの 403 は緩めていない** — 人間が
     * `self` の行を直せないことは変わらず、線は「書き換えられるのは常に
     * 自分自身の言葉だけ」を人間側とクローン側で対称にしただけである。
     * `origin: 'manager'` の行はいまも誰も直せない。
     *
     * **先に `get` で読んで `origin` を確かめてから `editBody` を呼ぶ。**
     * `origin` は開いたときから決して変わらない値なので、ここを先に読んでも
     * 競合しない——競合しうる「まだ閉じていない」という不変条件だけを
     * `editBody` の1操作へ畳む（`CommitmentStore.editBody` の doc）。
     * `close` と同じく、判定そのものは台帳（`editBody` の戻り値）に任せ、
     * 読むのは 404 と 409 を書き分けるためだけにする。
     *
     * **原文は日誌へ逐語で残す。これが上の「静かに」を消している条件である。**
     * 日誌は追記専用なので、編集の前後の本文を両方書いておけば、台帳の行が
     * 上書きされても過去の自分をそこから読み戻せる。**`commitment_edit` も
     * 同じ義務を負う**（`CommitmentStore.editBody` の doc）。
     *
     * **⚠️ 読めない行は書き直せない（issue #2148 の決定 (2)(3)）。** 先に読む
     * `get()` が `UnreadableCommitmentError` を投げたら、素の 500 ではなく
     * 409 で「読めない・close なら閉じられる」と名乗って止める——本文が
     * 読める形へ戻る保証の無い書き直しは、この issue の範囲では入れない
     * （`describeUnreadableCommitment` の doc）。
     */
    .patch(
      '/commitments/:id',
      describeRoute({
        tags: ['commitments'],
        summary: '引き受けた仕事の本文を後から直す',
        description:
          '編集できるのは `origin` が `human` かつまだ片付いていない行の `body` だけ。' +
          'クローン（`self`）やマネージャー（`manager`）が立てた行は人間からは直せない。' +
          '`origin` / `source` / `at` / `closedAt` / `closedReason` / `closedBy` は変わらない。' +
          '編集の前後の本文は日誌（`decision`）へ逐語で残る。' +
          '任意の `ifMatch`（`GET /commitments` で読んだ行の `editedAt ?? at`）を付けると、' +
          '版が違うときは書かずに 409。省略は従来どおり後勝ち。',
        responses: {
          200: {
            description: '直した。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正（`body` は空にできない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          403: {
            description:
              'origin が human ではない——クローンやマネージャーが立てた行は人間からは直せない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: 'その id は台帳に無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '次の3つ。(1) 既に片付いている（いつ・どう片付いたかを本文に入れて返す）。(2) 台帳に在るが' +
              '読めない形で入っている（close で閉じることはできるが、書き直せない）。(3) `ifMatch` が' +
              'いまの版（`editedAt ?? at`）と違う（読んでから書くまでの間に別の書き手が直した、または' +
              '消えた）。**何も書いていない。** `current` にいまの行を返す（消えていれば null）。' +
              '(3) だけが `current` の鍵を持つ。',
            content: {
              'application/json': {
                schema: resolver(z.union([commitmentConflictResponseSchema, errorResponseSchema])),
              },
            },
          },
        },
      }),
      jsonBody(commitmentEditBody, (where) => ({
        error: 'body の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const id = c.req.param('id');
        const { body, ifMatch } = c.req.valid('json');

        let existing;
        try {
          existing = await stores.commitments.get(id);
        } catch (error) {
          if (!(error instanceof UnreadableCommitmentError)) throw error;
          return c.json({ error: describeUnreadableCommitment(error) }, 409);
        }
        if (existing === null) return c.json({ error: 'not found' as const }, 404);
        if (existing.origin !== 'human') {
          // **断る理由だけでなく、代わりの出口も同じ文字列へ入れる**（issue #580
          // の (C)）。画面はこの本文をそのまま出す（`apps/web/app/routes/
          // commitments.tsx` は断りの文面を1文字も持たない）ので、**ここが
          // 「なぜ押せないか」の唯一の持ち主である。** 出口を画面側に書くと、
          // ここの線が動いた日に画面のほうが静かに嘘になる。
          //
          // **出口が在るのは `self` の行だけ。** クローン自身は
          // `commitment_edit`（`packages/core/src/tools.ts`）で直せるので、人間は
          // チャットで頼める。`manager` / `external` にはその出口が無いので、
          // 断りだけを返す（**無い出口を案内しない**）。
          const wayOut =
            existing.origin === 'self'
              ? '（この行はクローンが自分で載せたもの。' +
                'チャットでクローンに頼めば直せる——クローンには commitment_edit が在る）'
              : '';
          return c.json(
            {
              error:
                `${id} は origin:'${existing.origin}' で、クローンやマネージャーが立てた行は` +
                '人間からは直せない' +
                wayOut,
            },
            403,
          );
        }

        const before = existing.body;
        let edited: boolean;
        try {
          edited = await stores.commitments.editBody(
            id,
            body,
            new Date().toISOString(),
            'human',
            ifMatch === undefined ? undefined : { ifMatch },
          );
        } catch (error) {
          // 書いていない。日誌は編集が効いた後にしか積まないので、打ち消すものも無い。
          if (error instanceof CommitmentConflictError) {
            return c.json(
              {
                error: '引き受けた仕事が読んだ後に変わっています（書き換えていません）' as const,
                current: error.current,
              },
              409,
            );
          }
          throw error;
        }
        if (!edited) {
          // 直せなかった理由は台帳に聞く（読んだ直後に閉じられた場合しかここへは来ない）
          const after = await stores.commitments.get(id);
          return c.json(
            {
              error:
                `${id} は既に ${after?.closedAt ?? '不明な時刻'} に片付いている` +
                `（${after?.closedReason ?? '理由の記録なし'}）`,
            },
            409,
          );
        }
        // **編集自体はもう効いている**（Issue #2037）。日誌への追記だけが
        // 落ちても 500 を返さない——`appendJournalOrDrop` の doc。
        await appendJournalOrDrop(
          stores,
          {
            type: 'decision',
            decision:
              `人間が引き受けた仕事の本文を直した（${id}）: ` +
              `編集前「${before}」→ 編集後「${body}」`,
            grounds: '人間が直接 API から編集した',
          },
          '引き受けた仕事の本文編集の日誌',
          `id=${id}`,
        );
        return c.json(okResponseSchema.parse({ ok: true }));
      },
    )

    // --- マネージャー（可観測性の中段から下段へ降りる経路） ------------------
    //
    // **応答は返す前に宣言したスキーマを通す（`.parse()`）。**
    //
    // `describeRoute` の `resolver()` は `openapi.json` を作るだけで、ハンドラが
    // 実際に何を返したかは見ていない。だから `c.json(await ...list())` は、
    // `ManagerSummary`（core の TS interface）にフィールドが1つ増えた日に、
    // spec に書いていないものを黙って外へ出す。「宣言」と「実物」を繋いでいるのが
    // 人間の注意力しかない状態で、ずれても誰も気づかない。
    //
    // `.parse()` を通せば、`z.object` が宣言に無いキーを落とす。以降このスキーマは
    // 「外へ出るものの定義」であって「外へ出るものの説明」ではない。
    //
    // ここで通しているのは `/managers` と `/managers/:id` の2本だけである
    // （ほかの経路は同じ穴を持ったまま。Issue に上げる）。
    .get(
      '/managers',
      describeRoute({
        tags: ['managers'],
        summary: '委譲先マネージャーの一覧',
        description:
          '委譲先マネージャーの一覧と状態。**行は1つも消えない**——台帳（`jobs`）に削除の口は無く、' +
          '終端した委譲もそのまま残る（issue #670。`ManagerPool#retire` の doc）。' +
          '⟹ 件数はその環境で今までに起こした委譲の総数と等しくなるので、`status` で絞り、' +
          '`limit` と錨（`afterId` ＋ `afterStartedAt`）で窓を掛けられる。' +
          '`status` はカンマ区切りで複数指定できる（`running` / `waiting_human` / `done` / ' +
          '`failed` / `lost` / `stopped`。**知らない値は 400**——黙って無視すると、綴りを' +
          '間違えた呼びが「0件」として返り、絞り込みが効いていないことに気づけない）。' +
          '`afterId` と `afterStartedAt` は必ず組で渡す（片方だけは 400）。' +
          '**指す行が見当たらないときも 400**——黙って先頭から返さない' +
          '（`apps/daemon/src/cursor.ts` の「判定できないを黙って先頭へ倒さない」と同じ理由。' +
          'この口は照合できる——台帳の行が消えないので、「無い」は「消えた」ではなく' +
          '「そんな錨は刷っていない」である）。' +
          '**並びは `startedAt` の降順で固定**（`ManagerPool.list()` の契約）で、ここでは選べない' +
          '——`order` は足さない。⟹ 錨の「次」は*より古い*側である。' +
          '**封筒（`total` / `nextCursor`）は持たない**——続きが在るかは `limit` 件ちょうど' +
          '返ったかで判る（応答に新しい欄を1つも足さない）。' +
          '当てる順序は **`status` 絞り → 錨 → `limit`** である（先に窓で切ると、次の頁の' +
          '起点がずれる。issue #418 が `/commitments` で塞いだ穴と同じ形）。' +
          '**クエリを1つも渡さない呼びは、この変更の前と応答が1バイトも変わらない**（opt-in）。' +
          '**CLI とクローンの `manager_list` はこの窓を使っていない**（別 issue）。' +
          '行が読めない（版ずれ・手編集）委譲が在るときだけ、`unreadable`（id が取れれば id と' +
          '不正な欄名。本文は載せない）を載せる（issue #2345）。**「居ない」でも「畳まれた」でもない**。' +
          '`status` の絞り・`limit`・錨では切らず、常に全件を返す。0件なら鍵ごと無い。',
        responses: {
          200: {
            description: 'マネージャーの一覧と状態。',
            content: { 'application/json': { schema: resolver(managersListResponseSchema) } },
          },
          400: {
            description:
              'クエリが不正（`limit` は1以上1000以下の整数）、`status` に知らない値が入っている、' +
              '`afterId` / `afterStartedAt` の片方だけが渡された、`afterStartedAt` の形式が不正、' +
              'または錨が指す行が見当たらない。',
            content: {
              'application/json': {
                schema: resolver(errorResponseSchema),
              },
            },
          },
        },
      }),
      queryParams(managersQuery),
      async (c) => {
        const { status, limit, afterId, afterStartedAt } = c.req.valid('query');
        // **opt-in の判定は生のクエリで行う**（`commitmentsQuery` のハンドラと同じ理由
        // ——「渡されなかった」を「既定値と同じ値が渡された」と混同しない）。
        // **`status` は含めない。** あちらの `includeClosed` と同じで、窓とは別の
        // 絞り込みだからである——`status` だけを渡した呼びは並べ直しを通らず、
        // `list()` の生の並びに乗ったまま絞られる。
        const optedIn =
          c.req.query('limit') !== undefined ||
          c.req.query('afterId') !== undefined ||
          c.req.query('afterStartedAt') !== undefined;

        // **片方だけでは境界が決まらない**（`/journal` の `afterId`/`afterAt` と
        // 同じ形。`managersQuery` の doc）。この2つの if で TypeScript が
        // `afterId`/`afterStartedAt` を以降 `string` に絞る。
        if (afterId === undefined && afterStartedAt !== undefined) {
          return c.json({ error: 'afterId と afterStartedAt は両方一緒に渡す' as const }, 400);
        }
        if (afterId !== undefined && afterStartedAt === undefined) {
          return c.json({ error: 'afterId と afterStartedAt は両方一緒に渡す' as const }, 400);
        }
        if (
          afterId !== undefined &&
          afterStartedAt !== undefined &&
          Number.isNaN(Date.parse(afterStartedAt))
        ) {
          return c.json({ error: 'afterStartedAt は ISO 8601 で指定する' as const }, 400);
        }

        let statuses: JobStatus[] | undefined;
        if (status !== undefined) {
          const parsed = parseManagerStatuses(status);
          if (parsed.unknown.length > 0) {
            return c.json(
              {
                error:
                  `status に知らない値が入っている: ${parsed.unknown.join(', ')}` +
                  `（使えるのは ${jobStatusSchema.options.join(' / ')}）`,
              },
              400,
            );
          }
          statuses = parsed.statuses;
        }

        const managers = await clone.managers.list();

        // **当てる順序は `status` 絞り → 錨 → `limit`。**
        //
        // 先に `limit` で切ると、切った窓の中から絞ることになって「その状態の
        // ものが全部で何件あるか」に一切届かない（`status=running&limit=1` が、
        // 先頭の1件が `done` だっただけで 0 件を返す）。錨を `limit` より後に
        // 当てても同じ形で壊れる——継続点を切った後に解決すると次の頁の起点が
        // ずれる（issue #418 が `/commitments` で塞いだ穴）。
        //
        // **`status=`（空）は絞らない。** 0件へ倒すと、絞りを解除した画面が
        // 「マネージャーが消えた」ように見える（`journalQuery` の `q` / `type`
        // と同じ倒し方——`/journal` のハンドラも `types.length === 0` を
        // 「渡さなかった」と同じに扱う）。**渡さないのと同じ結果になる**ので、
        // 呼ぶ側は空のときにパラメタを外す判断をしなくてよい。
        const active = statuses;
        let view =
          active === undefined || active.length === 0
            ? managers
            : managers.filter((m) => active.includes(m.status));

        // **並べ直すのは opt-in のときだけ。** `list()` の並び（`startedAt` 降順）は
        // 同着の相対順を決めていないので、錨で辿るには補助キー（`managerId`）まで
        // 含めた順序が要る（`compareManagerPagingKey` の doc）。opt-in しなければ
        // この関数は1回も通らない——既定の呼びの応答がバイト単位で一致するのは、
        // この形が支えている（`/commitments` の `optedIn` と同じ）。
        if (optedIn) {
          view = [...view].sort(compareManagerPagingKey);
          if (afterId !== undefined && afterStartedAt !== undefined) {
            const pivot = { managerId: afterId, startedAt: afterStartedAt };
            // **実在を確かめる（`/approvals` / `/commitments` とはここが違う）。**
            // あちらは「答えた行が絞り込みから消えると続きが取れなくなる」ので
            // 実在検査を要求しない（`cursor.ts` の `decodeCursor` の doc）。
            // **この口にその事情は無い**——台帳の行は消えないし、`status` を跨いで
            // 動くこともない（`status` が変われば錨も同じ一覧の中で動くだけ）。
            // ⟹ 見当たらないのは「消えた」ではなく「そんな錨は刷っていない」で
            // あって、黙って先頭から返すと呼ぶ側は同じ頁を無限に読む。
            const exists = view.some(
              (m) => m.managerId === afterId && m.startedAt === afterStartedAt,
            );
            if (!exists) {
              return c.json(
                {
                  error:
                    `afterId/afterStartedAt が指す行が見当たらない（${afterId} / ${afterStartedAt}）。` +
                    '応答に載っていた managerId と startedAt をそのまま渡すこと',
                },
                400,
              );
            }
            view = view.filter((m) => compareManagerPagingKey(m, pivot) > 0);
          }
        }

        const page = optedIn && limit !== undefined ? view.slice(0, limit) : view;

        // **読めない行は 1 件でも在るときだけ `unreadable` を載せる**（issue #2345）。
        // 0 件なら鍵ごと無い（「読めない行は 0 件」と読める空配列を作らず、既存の呼び手の
        // 応答を1バイトも変えない）。窓（`status` / `limit` / 錨）では切らない——行が
        // 読めないので、どの状態のものかも分からない。
        const unreadable = await stores.jobs.listUnreadableJobs();

        return c.json(
          managersListResponseSchema.parse({
            managers: page.map((summary) => managerView(clone.managers, summary)),
            ...(unreadable.length > 0 ? { unreadable } : {}),
          }),
        );
      },
    )

    .get(
      '/managers/:id',
      describeRoute({
        tags: ['managers'],
        summary: '1本のマネージャーの状態',
        responses: {
          200: {
            description: 'マネージャーの状態。',
            content: { 'application/json': { schema: resolver(managerDetailResponseSchema) } },
          },
          404: {
            description: '該当するマネージャーが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '該当する委譲の行は在るが、型に合わない形で入っていて読めない（居ないのとは区別する。' +
              'issue #2359）。本文は載せず、理由は不正な欄名だけ。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const id = c.req.param('id');
        const manager = (await clone.managers.list()).find((entry) => entry.managerId === id);
        if (!manager) {
          // **issue #2359 の1。** `list()` は読めない委譲の行を飛ばすので、壊れた行の id は
          // ここで見つからない。見つからなかったときだけ台帳を読み直し、行が在るなら
          // 「居ない」（404）ではなく「読めない形で在る」（409）と言い分ける
          // （`GET /practices/:slug` の #2011 と同じ線）。本文は載せず、理由は不正な欄名だけ。
          const unreadableRow = (await stores.jobs.listUnreadableJobs()).find(
            (row) => row.id === id,
          );
          if (unreadableRow !== undefined) {
            return c.json({ error: describeUnreadableManagerRow(id, unreadableRow.reason) }, 409);
          }
          return c.json({ error: 'not found' as const }, 404);
        }
        return c.json(
          managerDetailResponseSchema.parse({ manager: managerView(clone.managers, manager) }),
        );
      },
    )

    /**
     * manager_id からそのセッションの生ログへ。走行中ならファイルの上、
     * 退避済みならアーカイブから返る（可観測性3層の最下段）。
     */
    .get(
      '/managers/:id/transcript',
      describeRoute({
        tags: ['managers'],
        summary: 'マネージャーの生ログ',
        description:
          'manager_id からそのセッションの生ログへ。走行中ならファイルの上、退避済みなら' +
          'アーカイブから返る（可観測性3層の最下段）。',
        responses: {
          200: {
            description: '生ログ（JSONL の生テキスト）。',
            content: { 'text/plain': { schema: resolver(z.string()) } },
          },
          404: {
            description: '該当するマネージャーの生ログが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '該当する委譲の行は在るが、型に合わない形で入っていて読めない（居ないのとは区別する。' +
              'issue #2359）。本文は載せず、理由は不正な欄名だけ。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          410: {
            description:
              '退避はあったが、本文は `DELETE /archive/:id` で消されている（#698）。' +
              'いつ・何バイト落としたか、どの archive id だったかを返す。',
            content: { 'application/json': { schema: resolver(archiveRemovedResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const result = await clone.managers.transcript(c.req.param('id'));
        if (result.kind === 'missing') return c.json({ error: 'not found' as const }, 404);
        // **読めない行は 404 にしない（issue #2359）。** 居ないのではなく壊れている。
        if (result.kind === 'unreadable') return c.json({ error: result.detail }, 409);
        if (result.kind === 'removed') {
          return c.json(
            archiveRemovedResponseSchema.parse({
              error: 'removed',
              removedAt: result.removedAt,
              bytes: result.bytes,
              archiveId: result.archiveId,
            }),
            410,
          );
        }
        return c.text(result.body);
      },
    )

    /**
     * 人間からマネージャーへ直接話しかける。
     *
     * **これが無いと、人間の言葉はクローンを経由してしか届かない。** クローンが
     * 取り込み中のときも、クローンの伝え方が間違っているときも、人間は手を出せない。
     * 実際に「マネージャーが正しく 403 を報告しているのに、伝言が間違っていて
     * 一晩噛み合わなかった」ということが起きている。
     *
     * クローンの代わりに判断するための口ではない（判断はクローンの仕事のまま）。
     * 人間が自分の言葉を自分で届けるための口である。
     */
    .post(
      '/managers/:id/messages',
      describeRoute({
        tags: ['managers'],
        summary: '人間からマネージャーへ直接話しかける',
        description:
          'これが無いと、人間の言葉はクローンを経由してしか届かない。クローンの代わりに判断' +
          'するための口ではない（判断はクローンの仕事のまま）。人間が自分の言葉を自分で届ける' +
          'ための口である。許可確認への回答なら `requestId` を付ける。',
        responses: {
          200: {
            description:
              '`outcome` を読むこと。`answered` = 止まっていた確認を解いた。' +
              '`delivered` = 追加指示として届けた（runner にセッションが無く resume から' +
              '入り直した回も含む。`detail` がそう言う）。' +
              '`session_missing` = **runner がこの委譲のセッションを持っておらず、resume でも' +
              '入り直せなかった**（#563。**届いていない**）。' +
              '`unknown` はここには出ない（404 になる）。' +
              '`declined` = **認証トークンの世代が食い違う done の委譲を畳んで新しい鍵で起こし直したいが、' +
              '背景処理・確認待ちが残っている（または分からない）ため、畳まず、送らなかった**' +
              '（#2851。そのものは居る。`detail` が残っているものと取れる手を言う）。' +
              '⚠️ `session_missing` を 404 にしないのは、**そのものは居る**からである — ' +
              '委譲は台帳に在り、時間で解ける理由（引き取り中・貸し出し期限）なら送り直しで通る。',
            content: { 'application/json': { schema: resolver(managerActionResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当するマネージャーが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '該当する委譲の行は在るが、型に合わない形で入っていて読めない（居ないのとは区別する。' +
              'issue #2359）。送っていない。本文は載せず、理由は不正な欄名だけ。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(managerMessageBody, (where) => ({
        error: 'text の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const { text, requestId, decision } = c.req.valid('json');
        const result = await clone.managers.send(c.req.param('id'), text, {
          ...(requestId === undefined ? {} : { requestId }),
          ...(decision === undefined ? {} : { decision }),
        });
        // **`unknown` だけが 404 である。そのままにする。**
        //
        // **`session_missing` をここへ混ぜない**（#563）。あれは「そのものは居る」側
        // で、`ManagerAbortResult` の doc が逐語で否定した形（待てば直る状態を 404 と
        // いう機械可読な終端で返す）になる。200 + `outcome` で返し、読み手に解釈の
        // 余地を残す。
        //
        // **ここは同時に 500 も塞いでいる。** かつて `send()` は runner の 404 を例外の
        // まま貫通させており、この行まで到達せずに `base.onError` が
        // `500 Internal Server Error`（text/plain）を作っていた——**404 という情報も
        // 文言も応答本文に1文字も出ず、跡は stderr にしか残らなかった。** ⟹ クローンには
        // 文言が届き、人間には 500 しか届かないという非対称ができていた。
        if (result.outcome === 'unknown') return c.json({ error: result.detail }, 404);
        // **`'unreadable'`（行は在るが読めない。issue #2359）は 409。** 「居ない」の 404 に
        // しない。送っていない。
        if (result.outcome === 'unreadable') return c.json({ error: result.detail }, 409);
        return c.json({ outcome: result.outcome, detail: result.detail });
      },
    )

    /**
     * この仕事をやめさせる。
     *
     * runner には `DELETE /managers/:id` があるのに、人間が届く側には無かった。
     * 暴走を止める手段が「器ごと落とす」しか無いと、**関係の無い仕事まで道連れ**
     * になる（それで M5 の作業が3回消えている）。止めた事実は日誌に残る。
     */
    .delete(
      '/managers/:id',
      describeRoute({
        tags: ['managers'],
        summary: 'この仕事をやめさせる',
        description:
          '暴走を止める手段が「器ごと落とす」しか無いと、関係の無い仕事まで道連れになる。' +
          'この口は1本だけを止める。止めた事実は日誌に残る。',
        responses: {
          200: {
            description:
              '止める指示は処理できた。`outcome` を読むこと — `stopped`（止まったと確かめた）/ ' +
              '`not_stopped`（止まっていないと確かめた）/ `unknown`（確かめられなかった）のどれかで、' +
              '止まったと機械可読に言えるのは `stopped` のときだけである。',
            content: { 'application/json': { schema: resolver(managerActionResponseSchema) } },
          },
          400: {
            description: '本文が JSON として不正。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当するマネージャー（`absent`）が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '該当する委譲の行は在るが、型に合わない形で入っていて読めない（`unreadable`。居ないのとは' +
              '区別する。issue #2359）。止めておらず、行も書き換えていない。本文は載せず、理由は不正な欄名だけ。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(abortBody, (where) => ({
        error: 'reason の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const { reason } = c.req.valid('json');
        const result = await clone.managers.abort(
          c.req.param('id'),
          ...(reason === undefined ? [] : ([reason] as const)),
        );
        // **`'absent'` だけが 404。** `'not_stopped'` / `'unknown'` は「そのものは
        // 居るが、止まった/止まっていない/確かめられなかった」という観測結果で
        // あって、リクエスト自体は正しく処理できている（200 で `outcome` を返す）。
        if (result.outcome === 'absent') return c.json({ error: result.detail }, 404);
        // **`'unreadable'`（行は在るが読めない。issue #2359）は 409。** 「居ない」の 404 に
        // しない。止めていない。
        if (result.outcome === 'unreadable') return c.json({ error: result.detail }, 409);
        return c.json({ outcome: result.outcome, detail: result.detail });
      },
    )

    // --- 委譲先の器と、そこへ配る鍵 ----------------------------------------
    /**
     * runner の一覧と、**そこで配られている鍵の指紋**。
     *
     * 指紋を出すのは、人間が置いた鍵とマネージャーが握っている鍵が同じかどうかを
     * 確かめる手段が他に無いからである。無いと「鍵の権限が足りない」のか「鍵が
     * 届いていない」のかを誰も切り分けられず、人間とマネージャーが両方正しいまま
     * 何時間もすれ違う（実際に起きた）。**値は返らない。**
     */
    .get(
      '/runners',
      describeRoute({
        tags: ['runners'],
        summary: '委譲先 runner の一覧と、配られている鍵の指紋',
        description:
          '指紋を出すのは、人間が置いた鍵とマネージャーが握っている鍵が同じかどうかを確かめる' +
          '手段が他に無いからである。**値は返らない。**',
        responses: {
          200: {
            description: 'runner の一覧。',
            content: { 'application/json': { schema: resolver(runnersListResponseSchema) } },
          },
        },
      }),
      async (c) => {
        // デーモン自身の版。**自分のことなので取りに行く必要が無い**
        // （`resolveBuildRevision()` を直に呼ぶ。`known` / `unknown` の2状態）。
        // runner の一覧が空でも、この値だけは常に出す——「自分がどの版で
        // 走っているか」は runner の登録有無と無関係な事実である。
        const daemonRevision = reportRunnerRevision(resolveBuildRevision());
        const registry = deps.runners;
        if (registry === undefined) {
          return c.json(runnersListResponseSchema.parse({ runners: [], daemonRevision }));
        }
        // **名簿に載っている全部を返す**（開けている分だけではない）。上がって
        // こない runner が一覧から消えるだけだと、人間には「設定し忘れた」のか
        // 「上がってこない」のかが区別できない。
        const open = new Map((await registry.list()).map((runner) => [runner.runnerId, runner]));
        return c.json(
          runnersListResponseSchema.parse({
            runners: await Promise.all(
              registry.entries().map(async (entry) => {
                const runner = entry.runnerId === undefined ? undefined : open.get(entry.runnerId);
                return {
                  label: entry.label,
                  state: entry.state,
                  since: entry.since,
                  ...(entry.error === undefined ? {} : { error: entry.error }),
                  ...(entry.runnerId === undefined ? {} : { runnerId: entry.runnerId }),
                  ...(entry.workspacePath === undefined
                    ? {}
                    : { workspacePath: entry.workspacePath }),
                  // **繋がっていない相手のぶんも出す。** 黙った器について「最後に
                  // どのプロセスが応えていたか」は、戻ってきたときに同じ器かを
                  // 突き合わせる材料である（消すと、黙っている間だけ材料が消える）。
                  ...(entry.instanceId === undefined ? {} : { instanceId: entry.instanceId }),
                  ...(entry.instanceSince === undefined
                    ? {}
                    : { instanceSince: entry.instanceSince }),
                  // **繋がっていない相手には聞きに行かない**（指紋は runner が
                  // 持つ）。**そして聞かなかったことと、聞いて失敗したことと、
                  // 聞いて0件だったことを、同じ表現へ潰さない** — 潰すと読む側は
                  // 「鍵が配られていない」のか「確かめられなかった」のかを
                  // 区別できない（`runnerProbeSchema` の doc）。
                  ...(await probe(runner, 'credentials')),
                  ...(await probe(runner, 'profile')),
                  // **名簿に既にある値をそのまま出す**（heartbeat が拾った分）。
                  // ここで新たに runner を叩かない——`fingerprints` と同じ「未接続
                  // ／頼んで失敗／頼んでいない」が潰れる穴を増やさないため。
                  revision: entry.revision,
                  // **押し込み（push）の直近結果。** `probe` の指紋とは別物——
                  // 指紋は「いま runner に何が乗っているか」を毎回聞き直すのに
                  // 対し、こちらは「デーモンが最後に送ろうとして何が起きたか」を
                  // 記憶から返すだけで、新たな往復は発生しない。`ManagerPool` の
                  // 内部状態なので `entry`/`registry` からは取れず、`clone.managers`
                  // 経由の専用アクセサ（`pushHealthOf`）が要る。
                  ...(entry.runnerId === undefined
                    ? {}
                    : (() => {
                        const pushHealth = clone.managers.pushHealthOf(entry.runnerId);
                        return pushHealth === undefined ? {} : { pushHealth };
                      })()),
                  // **peer の名乗り（#3940）。** `pushHealth` と同じく記憶を読むだけ。読み口を持たない
                  // プールでは「不明」に倒す（「頼めない」と埋めない）。
                  managerPeers: clone.managers.managerPeersOf?.(entry.runnerId) ?? {
                    status: 'unknown',
                  },
                };
              }),
            ),
            daemonRevision,
          }),
        );
      },
    )

    /**
     * マネージャーの道具の鍵を差し替える。**器を作り直さない。**
     *
     * これが無いと、鍵の更新に再デプロイが要る＝「鍵を直す」と「走行中の仕事を
     * 失う」が同じ操作になる。走っている人の仕事をデーモンの都合で殺さないのと
     * 同じ理由で、鍵の都合でも殺さない。
     *
     * 鍵はここに保管しない。受け取って runner へ降ろすだけである（デーモンの器に
     * 記憶の鍵と GitHub の書き込み権を並べない）。
     *
     * **能力を広げる口（issue #2198）。** 登録されている全 runner へ鍵を配る
     * 口なので、`PUT /credentials` と同じ扱い——**日誌を先に書き、書けなければ
     * 1本も配らずに 500**。以前は日誌を1行も書いていなかった。配布（`registry.list()`
     * を含む）が投げたら、打ち消しの行を `appendJournalOrDrop` で足してから同じ
     * エラー応答（ここは元から捕まえていないので `base.onError` 任せの 500）を
     * 返す。**ここは `PUT /credentials` と違い、指紋を配る前の入力の値から直接
     * 計算できる**（正本への保存を待つ必要が無い）ので、先に書く行にも含める。
     * runner ごとの配布結果（成否）は配った後でないと分からないので、2行目として
     * `appendJournalOrDrop`（best-effort）で足す。**値（鍵そのもの）はどちらの
     * 行にも書かない。**
     *
     * **⚠️ この口の資格（`authenticate` だけ）はこの PR では変えていない。**
     * `PUT /credentials` の doc と同じ注記——締めるかどうかは方針の判断（人間の
     * 決定）であって、ここで勝手に揃えると今通っている運用が黙って止まる。
     */
    .post(
      '/runners/credentials',
      describeRoute({
        tags: ['runners'],
        summary: 'マネージャーの道具の鍵を差し替える',
        description:
          '器を作り直さない。鍵はここに保管せず、受け取って全 runner へ降ろすだけである' +
          '（デーモンの器に記憶の鍵と GitHub の書き込み権を並べない）。',
        responses: {
          200: {
            description: '各 runner への配布結果。',
            content: {
              'application/json': { schema: resolver(runnersCredentialsResponseSchema) },
            },
          },
          400: {
            description:
              '本文の形が不正（配布していない）。**送られてきた本文は返さない**——' +
              'ここは鍵の値そのものを運ぶ口なので、既定の 400 の形は使えない（下の' +
              '`hook` の doc）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          503: {
            description: 'runner が登録されていない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      /**
       * **既定の 400 を使わない。** `hook` を渡さないと `@hono/standard-validator`
       * は `c.json({ data: <リクエスト本文そのもの>, error, success: false }, 400)`
       * を返す（`PUT /tokens` の同名の hook の doc に実測を書いてある。
       * `sanitizeIssues` が見る `RESTRICTED_DATA_FIELDS` は `header: ['cookie']`
       * だけで、`json` は素通しになる）。
       *
       * **⟹ 鍵を1本 `name` の形式ミスで書き間違えただけで、その回に送った
       * *全部* の鍵の値が応答へ載る。** ここは runner へ配る鍵そのものを運ぶ
       * 唯一の口なので、既定の形をそのまま使えない。**どこが不正だったかは
       * 返す（`path` だけ）が、送られてきた本文は1文字も返さない。**
       */
      jsonBody(runnerSetCredentialsCommandSchema, (where) => ({
        error: '鍵の入力の形が不正（配布していない）' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const registry = deps.runners;
        if (registry === undefined) {
          return c.json({ error: 'runner が登録されていない' as const }, 503);
        }
        const { credentials } = c.req.valid('json');
        // **指紋は配る前に入力の値から直接計算できる**（`PUT /credentials` と
        // 違い、正本への保存を待つ必要が無い）。値そのものはここにも以後にも
        // 一切書かない。
        const wanted = credentials
          .map((entry) => `${entry.name}=${fingerprintOf(entry.value)}`)
          .join(', ');

        // **日誌を先に書く（issue #2198）。書けなければ1本も配らずに 500。**
        await deps.stores.journal.append({
          type: 'decision',
          decision: `runner へ環境変数（鍵）を配ろうとしている（${wanted}）`,
          grounds:
            `${describeActor(c.get('principal'))}（POST /runners/credentials）。` +
            '値は書かない（鍵そのものである）。',
        });

        const distribute = async () => {
          const runners = await registry.list();
          return Promise.all(
            runners.map(async (runner) => {
              try {
                return {
                  runnerId: runner.runnerId,
                  ok: true as const,
                  credentials: await runner.setCredentials(credentials),
                };
              } catch (error) {
                // **素の `String(error)` を載せない**（issue #2407。`probe` の doc と同じ）。
                const kind = credentialDeliveryFailureOf(error);
                return {
                  runnerId: runner.runnerId,
                  ok: false as const,
                  kind,
                  error: `鍵の配布に失敗した（${kind}）`,
                };
              }
            }),
          );
        };

        let results: Awaited<ReturnType<typeof distribute>>;
        try {
          results = await distribute();
        } catch (error) {
          /**
           * **`registry.list()` 自体が投げた場合**（個々の runner への配布は
           * 上の `try/catch` で既に捕まえており、ここまで抜けてこない）。
           * 打ち消しの行を足してから投げ直す——ここは元から捕まえていない
           * ので、`base.onError` が返す応答（500）は変えない。
           */
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision: `runner へ環境変数（鍵）を配れなかった（${wanted}）`,
              grounds:
                `${describeActor(c.get('principal'))}（POST /runners/credentials、配布が失敗）: ` +
                `runner の一覧を取れなかった（${credentialDeliveryFailureOf(error)}）。` +
                '値は書かない（鍵そのものである）。',
            },
            '環境変数（鍵）配布の打ち消しの日誌',
            `names=${credentials.map((entry) => entry.name).join(',')}`,
          );
          throw error;
        }

        // **配布の結果（runner ごとの成否）は配った後でないと分からないので、
        // 2行目として `appendJournalOrDrop`（best-effort）で足す。値は書かない。**
        const delivered = results
          .map((result) => `${result.runnerId}=${result.ok ? 'ok' : `失敗（${result.kind}）`}`)
          .join(', ');
        await appendJournalOrDrop(
          deps.stores,
          {
            type: 'decision',
            decision: `runner へ環境変数（鍵）を配った（${wanted}）`,
            grounds:
              `${describeActor(c.get('principal'))}（POST /runners/credentials）。` +
              '値は書かない（鍵そのものである）。' +
              `配布先: ${delivered.length === 0 ? '配る先なし' : delivered}` +
              '。',
          },
          '環境変数（鍵）配布の日誌',
          `names=${credentials.map((entry) => entry.name).join(',')}`,
        );

        return c.json(runnersCredentialsResponseSchema.parse({ results }));
      },
    )

    /**
     * その runner を意図して空ける（drain。#485 PR-2）。
     *
     * **走行中のマネージャーを畳む操作ではない。** 空けると立てるだけで、その場
     * では終わらない。載っている委譲は「確かめた停止」の握手を経て、貸し出し
     * 期限を待たずに他の `connected` な runner へ移る（`ManagerPool.vacate`
     * の doc）。`railway/scale-runners.sh` が減らす側の運用で既に名指ししている
     * 口——ただしそのスクリプト自身はまだ呼ばない。どの器を空けるかはクローンの
     * 判断であって、スクリプトが黙って選ぶものではない。
     *
     * 中身は `RunnerRegistry` に置かない（`RunnerRegistry#vacate` は同期・
     * 往復無しの名簿操作だけを持つ）。ここが呼ぶのは `ManagerPool.vacate()`
     * ——「確かめた停止」の握手と `relocateFrom` まで含めた、HTTP から見える
     * 唯一の受け口である。
     */
    .post(
      '/runners/vacate',
      describeRoute({
        tags: ['runners'],
        summary: 'その runner を意図して空ける（drain）',
        description:
          '空けると立てるだけで、その場では終わらない。載っている委譲は' +
          '「確かめた停止」の握手を経て、貸し出し期限を待たずに他の runner へ移る。' +
          '**応答は「立てた」ことの確認であって「終わった」ことの確認ではない**' +
          '——進捗は GET /runners（state: vacating）と GET /managers（runnerId が' +
          '動いたか）で追う。',
        responses: {
          200: {
            description:
              '空けると立てた。名簿に無い runnerId でも同じ 200 を返す' +
              '（`RunnerRegistry#unregister` と同じ作法——名乗ってすらいない' +
              '宛先を「無かった」と取り立てて言うほどの情報ではない）。' +
              '**握手を飛ばした回は `handshakeSkipped` が載る**（状態は 200 のまま）。' +
              'runner の名簿を読めなかった（`runner_unreadable`）か、台帳の委譲の一覧を' +
              '読めなかった（`jobs_unreadable`）回で、載っている委譲への確かめた停止の' +
              '握手をしておらず、貸し出しも返していない。**呼び直せば握手をやり直す。**' +
              '飛ばさなかった回は欄が無い（`{ ok: true }` のまま）。',
            content: { 'application/json': { schema: resolver(runnersVacateResponseSchema) } },
          },
          400: {
            description:
              '`runnerId` が無い、または文字列として不正（`jsonBody` の hook が断る。' +
              'PR #1747 が揃えた形——送られた値は1文字も含めない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(runnersVacateCommandSchema, (where) => ({
        error: 'runnerId の形が不正（空けていない）' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const { runnerId } = c.req.valid('json');
        const { handshakeSkipped } = await clone.managers.vacate(runnerId);
        // 握手を飛ばした回だけ欄を載せる（#2376）。状態は 200 のまま——立てたこと
        // 自体は成功している。欄が無い応答は今までと同じ `{ ok: true }`。
        return c.json(
          runnersVacateResponseSchema.parse({
            ok: true,
            ...(handshakeSkipped === undefined ? {} : { handshakeSkipped }),
          }),
        );
      },
    )

    // --- 実行環境プロファイル（/profile） ----------------------------------

    /**
     * 人間が置いた実行環境プロファイル（`.zprofile` 相当）。
     *
     * **⚠️ 2026-09-24 のオーナー決定（#1122）で `requireOperator` から `requireOwner`
     * （持ち主として宣言されたアカウント）へ移した。** ブラウザは `requireOperator` を
     * 構造的に通れないので、Web UI にプロファイルの画面を置いても誰も開けなかった
     * （入口の等価性の穴）。`PUT /credentials` / `POST /reset` が #1198 で同じ門へ
     * 移ったのと同じ強さである —— 宣言は operator トークンだけが立てられる旗なので、
     * 通れるのは常にホストへ到達できる者が名指ししたアカウントに限られる。
     * 「alteroid を使ってよい」（許可されただけ）のアカウントは今も通らない。
     * 以下の段落はその決定より前の理由として残す。
     *
     * **実行環境の持ち主だけ**（`requireOperator`）。**⚠️ 2026-09-06 のオーナー決定
     * （alteroid を使う許可＝ `access grant` 済みのアカウントを実行環境の持ち主と
     * 同格にする）の対象外——`/tokens` `/access/*` はその決定で `authenticate` だけに
     * 変わったが、ここは変えていない。** 理由: ①は端末・画面・外部アプリへ配られる
     * bearer token で、②はサーバ上のファイルである。`GET /profile` は本文をそのまま
     * 返し、そこには鍵が入りうる。同格にすることは「鍵に届く資格」を*外へ配られる側*
     * へ持たせることであり、①のトークンが1つ漏れれば鍵が読める。
     *
     * 単一の持ち主しか許可できない以上、`access grant` 済みのアカウントも同じ人間の
     * はずだが、**この口だけは「使ってよい」より一段強い**。理由は下の `PUT` にある
     * とおりで、読み側も同じ扱いにする — 本文には `GH_TOKEN` のような鍵が丸ごと
     * 入りうるので、`GET` が緩いと `PUT` を締めても意味が無い。
     *
     * **本文を返す。** 自分が書いたものを読み直せないと typo ひとつ直せない。
     * 指紋しか返さないのは runner の制御面のほうで、あちらは「マネージャーが
     * 読めてはいけない」からそうしている（守っている相手が違う）。
     *
     * **デグレードではない。** 人間が `.zshenv` を直すのは、その人が持っている
     * 箱の上である。ここも同じで、遠隔から直したいなら `access grant` と同じく
     * `docker compose exec app alteroid profile edit` を通る。
     */
    .get(
      '/profile',
      describeRoute({
        tags: ['profile'],
        summary: '実行環境プロファイル（.zprofile 相当。名前付きの行の集まり）を読む',
        description:
          '器の環境変数を増やす代わりに、名前付きのシェルスクリプトの行を記憶ストアへ置く。' +
          '行ごとに撒く先（all=クローンと runner の両方 / app=クローンだけ / runner=runner だけ）を持ち、' +
          '名前のコード単位順（/etc/profile.d と同じ）につなげて効かせる。' +
          '`script` / `updatedAt` / `sha256` / `bytes` は1本の時代の欄で、互換のために残している（deprecated）。',
        responses: {
          200: {
            description: 'プロファイルの行（本文つき）と、合成後の指紋。置かれていなければ行は空。',
            content: { 'application/json': { schema: resolver(profileResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      async (c) => {
        const entries = await deps.stores.profile.list();
        return c.json(profileResponseSchema.parse(describeProfileEntries(entries)));
      },
    )

    /**
     * プロファイルを**全部**差し替える（**deprecated**。1本の時代の全文置換）。
     *
     * 古い CLI と Web（Web は Vercel で別に配られる）が叩き続けるので、意味を保って
     * 残す: 全行を `default` 1行（撒く先 `all`）に置き換える。空白だけなら全部外す。
     * 新しい読み手は `PUT /profile/:name` / `DELETE /profile/:name` を使うこと。
     *
     * **器を作り直さない。**（以下は1本の時代の doc。経路は `mutateProfile` に寄せた）
     *
     * これが無いと、道具の鍵や `PATH` を1つ足すたびに `compose.yaml` を直して
     * 器を焼き直すことになる＝「環境を直す」と「走行中の仕事を失う」が同じ操作に
     * なる。鍵の差し替え（`POST /runners/credentials`）と同じ理由で口を開けてある。
     *
     * **⚠️ 2026-09-24 のオーナー決定（#1122）で `requireOperator` から `requireOwner`
     * （持ち主として宣言されたアカウント）へ移した。** ブラウザは `requireOperator` を
     * 構造的に通れないので、Web UI にプロファイルの画面を置いても誰も開けなかった。
     */
    .put(
      '/profile',
      describeRoute({
        tags: ['profile'],
        deprecated: true,
        summary: '実行環境プロファイルを全部差し替える（deprecated）',
        description:
          '全行を `default` 1行（撒く先 all）に置き換える。空白だけなら全部外す。' +
          '置く前に評価する。読めなければ保存も配布もせず、理由を返す（前のものが残る）。' +
          '新しい読み手は `PUT /profile/{name}` / `DELETE /profile/{name}` を使うこと。',
        responses: {
          200: {
            description: 'クローンと各 runner への反映結果。',
            content: { 'application/json': { schema: resolver(profileUpdateResponseSchema) } },
          },
          400: {
            description:
              'プロファイルが読めなかった（保存していない）。**本文の形がそもそも' +
              '不正だった場合も同じ 400 に乗る**（`script` を欠いた本文など）——' +
              'どちらの場合も送られてきた本文は返さない（下の `hook` の doc）。',
            content: { 'application/json': { schema: resolver(profileErrorResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      /**
       * **既定の 400 を使わない。** `hook` を渡さないと `@hono/standard-validator`
       * は `c.json({ data: <リクエスト本文そのもの>, error, success: false }, 400)`
       * を返す（`PUT /tokens` の同名の hook の doc に実測を書いてある）。
       *
       * **⟹ ここは `GH_TOKEN` のような鍵をまるごと含みうるシェルスクリプトを
       * 運ぶ口なので、`script` の綴りを1つ間違えただけで、その回に送った
       * スクリプト全文（＝中の鍵の値まで）が応答へ載る。** 下の 400 は
       * `profileErrorResponseSchema`（`{ error, detail }`。両方必須）で宣言済み
       * なので、宣言を変えずに済むよう **hook もその形で返す**。`detail` に
       * 載せてよいのは `path` だけで、送られてきた値は1文字も載せない
       * （`apps/cli/src/profile.ts` がこの `detail` をそのまま人へ表示する）。
       */
      jsonBody(profileUpdateRequestSchema, (where) => ({
        error: 'プロファイルの入力の形が不正（保存していない）',
        detail: where === '' ? '本文の形が不正である' : `形が不正な項目: ${where}`,
      })),
      async (c) => {
        const { script } = c.req.valid('json');
        const outcome = await mutateProfile(deps, {
          actor: describeActor(c.get('principal')),
          route: 'PUT /profile',
          run: (profile) => profile.apply(script),
        });
        return outcome.ok ? c.json(outcome.body, 200) : c.json(outcome.body, 400);
      },
    )

    /**
     * プロファイルの**1行**（名前付き）を置く。
     *
     * `PUT /profile`（全部差し替え）と**同じ1本道**（`mutateProfile` → `ProfileService`）
     * を通る。行ごとに撒く先を持ち、`scope` を省くと既存の行の撒く先を保つ（新しい行
     * なら `all`）。**名前の形が不正なら 400**（名前は fs 版の器の中でファイル名になる）。
     */
    .put(
      '/profile/:name',
      describeRoute({
        tags: ['profile'],
        summary: '実行環境プロファイルの1行を置く',
        description:
          '名前付きの行を置く（無ければ作る）。行は名前のコード単位順につなげて効かせる。' +
          '置く前に評価する（撒く先が runner だけの行は、デーモンでは評価できないので runner が評価する）。' +
          '読めなければ保存も配布もせず、理由を返す（前のものが残る）。',
        responses: {
          200: {
            description: '行を置いた後の全行と、クローンと各 runner への反映結果。',
            content: { 'application/json': { schema: resolver(profileUpdateResponseSchema) } },
          },
          400: {
            description:
              'プロファイルが読めなかった（保存していない）、または名前・本文・撒く先の形が不正。' +
              '送られてきた本文は返さない。',
            content: { 'application/json': { schema: resolver(profileErrorResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      jsonBody(profileEntryUpdateRequestSchema, (where) => ({
        error: 'プロファイルの入力の形が不正（保存していない）',
        detail: where === '' ? '本文の形が不正である' : `形が不正な項目: ${where}`,
      })),
      async (c) => {
        const name = c.req.param('name');
        if (!PROFILE_ENTRY_NAME.test(name)) {
          return c.json(
            {
              error: 'プロファイルの行の名前の形が不正（保存していない）',
              detail: `名前は ${PROFILE_ENTRY_NAME.source} の形にすること`,
            },
            400,
          );
        }
        const { script, scope } = c.req.valid('json');
        const outcome = await mutateProfile(deps, {
          actor: describeActor(c.get('principal')),
          route: 'PUT /profile/:name',
          subject: `行 ${name}`,
          run: (profile) => profile.set(name, script, scope),
        });
        return outcome.ok ? c.json(outcome.body, 200) : c.json(outcome.body, 400);
      },
    )

    /**
     * プロファイルの**1行**を外す。他の行は変えない。無い名前は 404（何も変えない）。
     * 外した行がクローンか runner の最後の1行だったなら、その側へは空が降りる。
     */
    .delete(
      '/profile/:name',
      describeRoute({
        tags: ['profile'],
        summary: '実行環境プロファイルの1行を外す',
        description:
          '名前付きの行を外す。他の行は変えない。無い名前は 404（何も変えない）。' +
          '外した行が、クローンか runner のどちらかに掛かる最後の1行だったなら、その側から環境が外れる。',
        responses: {
          200: {
            description: '行を外した後の全行と、クローンと各 runner への反映結果。',
            content: { 'application/json': { schema: resolver(profileUpdateResponseSchema) } },
          },
          400: {
            description: '名前の形が不正、または反映に失敗した。',
            content: { 'application/json': { schema: resolver(profileErrorResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: 'その名前の行は無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      async (c) => {
        const name = c.req.param('name');
        if (!PROFILE_ENTRY_NAME.test(name)) {
          return c.json(
            {
              error: 'プロファイルの行の名前の形が不正（何も変えていない）',
              detail: `名前は ${PROFILE_ENTRY_NAME.source} の形にすること`,
            },
            400,
          );
        }
        if (deps.profile === undefined) {
          return c.json({ error: 'プロファイルの器が無い', detail: '' }, 400);
        }
        // 無い名前は日誌も書かず 404（「外そうとしている」を残さない）。
        if (!(await deps.profile.read()).some((entry) => entry.name === name)) {
          return c.json({ error: `プロファイルに行 ${name} は無い` }, 404);
        }
        const outcome = await mutateProfile(deps, {
          actor: describeActor(c.get('principal')),
          route: 'DELETE /profile/:name',
          subject: `行 ${name}（外す）`,
          run: (profile) => profile.remove(name),
        });
        return outcome.ok ? c.json(outcome.body, 200) : c.json(outcome.body, 400);
      },
    )

    // --- 人間の MCP 連携の登録（/mcp-servers。#325 段1） ----------------------

    /**
     * 人間の MCP 連携の登録（`.mcp.json` の `mcpServers` と同じ形）を読む。
     *
     * **なぜ口が要るか。** Railway には volume が無く、`.mcp.json` をファイルで
     * 置いても器と一緒に消える（#325 本文）。⟹ 記憶ストアへ置き、SDK の
     * `Options.mcpServers` で渡す（`packages/core/src/mcp-servers.ts` の doc）。
     * 置き場が器の外にある以上、人間が置く口がここに要る。
     *
     * **許可済みのアカウントなら通る**（`requireOwner`。2026-10-05 の #2862 の
     * オーナー決定で、宣言済み owner だけから緩めた）。登録の `env` / `headers` には鍵が丸ごと入りうるので、`GET` も `PUT` と同じ
     * 門にする（読み側が緩ければ書き側を締めても意味が無い —— `/profile` と同じ
     * 理由）。
     *
     * **⚠️ `/profile`（`requireOperator`）より一段緩い門を選んでいる。** #325 の
     * 2026-09-24 のコメント（段の計画）が `requireOwner` を指定しているのに従った。
     * 違いは「Web UI にログインした、持ち主として宣言されたアカウント」を通すか
     * どうかで、`/profile` はそこも通さない（`auth.test.ts` の ④）。**stdio の登録は
     * クローンの SDK 子プロセスが起こすコマンドであり、クローンの env（記憶ストアの
     * 鍵を含む）を継承する** —— つまりここは「次のセッションで任意のコマンドを
     * 走らせる」口でもある。`PUT /credentials`（同じく owner）も `NODE_OPTIONS` の
     * ような名前でクローンの env へ届くので、強さとしては同じ段に置いた。**門を
     * `requireOperator` へ締めるかどうかは人間の判断である**（締めるなら
     * `scripts/require-operator-routes.test.ts` の一覧を付け替える）。
     */
    .get(
      '/mcp-servers',
      describeRoute({
        tags: ['mcp-servers'],
        summary: 'MCP サーバの登録（.mcp.json 相当）を読む',
        description:
          '人間の MCP 連携の登録を記憶ストアから返す。クローンの本セッションと蒸留に' +
          '（次のセッションから）、マネージャー・作業者に（runner へ降ろしたうえで、次に開く' +
          'セッションから）効く。',
        responses: {
          200: {
            description:
              '登録そのもの（値を含む）と、その版（`version`。`PUT` の `ifMatch` へ渡す）。' +
              '置かれていなければ空の `mcpServers`。',
            content: { 'application/json': { schema: resolver(mcpServersResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      async (c) => {
        const stored = await deps.stores.mcpServers.read();
        return c.json(mcpServersResponseSchema.parse(mcpServersReadBody(stored)));
      },
    )

    /**
     * 登録を差し替える（全文置換。空の `mcpServers` は「登録を外す」）。
     *
     * **runner へも降ろす（#325 段3）。** 保存したあと、いま繋がっている runner の
     * すべてへ配り、結果を runner ごとに返す（`PUT /profile` と同じ形。**名前と指紋
     * だけで、値は返さない**）。繋がっていない runner・配り損ねた runner へは、次の
     * 名乗り（`hello`）でマネージャーのプールが降ろし直す（`#pushMcpServers`）。
     * **保存と配布は同じ列を通す**（`mcp-server-service.ts`）—— 名乗り直しの降ろし直しと
     * 混ざって古い登録で上書きしないため。
     *
     * **マネージャーには、次に開くセッションから効く**（新しい委譲と、resume・開き直し）。
     * 走っているマネージャーのセッションには届かない（`buildManagerSessionOptions` の
     * `mcpServers` の doc）。
     *
     * **いつ効くか: クローンの次のセッションから。** SDK の `mcpServers` は
     * セッションを組むとき（`clone.ts` の `#buildOptions`）に1度だけ渡るので、
     * 走行中のセッションには届かない —— 実行環境プロファイルがクローンへ効く
     * 時機と同じである（`#childEnv()` もセッションを組むときに1度だけ読む）。
     * 蒸留のサイドクエリは起こすたびに読み直すので、次の蒸留から効く。
     *
     * **日誌には名前だけを書く**（値には鍵が入りうる）。人間が明示的に置いた
     * 操作でも、何がいつ変わったかを可観測性の外に置かない（`POST /reset` と同じ）。
     *
     * **能力を広げる口（issue #2123。teto の判断）。** クローンの道具（MCP
     * サーバの登録）を増やす口なので、`/access/:accountId/grant` と同じ扱い
     * ——**日誌を先に書き、書けなければ差し替えずに 500**。差し替え（保存・
     * runner への配布）が投げたら、打ち消しの行を `appendJournalOrDrop` で
     * 足してから同じエラー応答。**空の `mcpServers`（登録を全部外す、狭める
     * 使い方）も同じ扱いにする**——口ごとに1つの扱いとして閉じる側に倒す
     * （teto の判断。#2067 が当てていた `appendJournalOrDrop`〈落ちても 200〉は
     * ここではもう使わない）。runner への配布結果は差し替えた後でないと
     * 分からないので、先に書く行はそれを含まない形にし、後で分かる分は2行目
     * として `appendJournalOrDrop`（best-effort）で足す。
     *
     * 門の選び方は `GET /mcp-servers` の doc。
     */
    .put(
      '/mcp-servers',
      describeRoute({
        tags: ['mcp-servers'],
        summary: 'MCP サーバの登録を差し替える',
        description:
          '`.mcp.json` をそのまま貼れる形（`{ "mcpServers": { … } }`）。置く前に形を' +
          '検査し、通らなければ保存しない（前のものが残る）。保存したら繋がっている runner へ' +
          '降ろし、runner ごとの結果（名前と指紋だけ）を返す。本文の `ifMatch`（`GET` の ' +
          '`version`）が省略でなく、いまの版と違えば何も書かず 409（`current` がいまの登録）。' +
          `「${MCP_SERVER_NAME}」は alteroid 自身の MCP サーバの名前なので使えない。`,
        responses: {
          200: {
            description: '差し替えた後の登録の名前と指紋、runner ごとの配布結果（値は返さない）。',
            content: {
              'application/json': { schema: resolver(mcpServersUpdateResponseSchema) },
            },
          },
          400: {
            description:
              '形が不正（保存していない）。**送られてきた値は応答に載せない**' +
              '（どの欄が不正かだけを返す）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '`ifMatch` が読んだ後に変わっていた（書いていない）。`current` がいまの登録' +
              '（`GET` と同じ形。値を含むので `GET` と同じ門の内側にだけ返す）。',
            content: {
              'application/json': { schema: resolver(mcpServersConflictResponseSchema) },
            },
          },
        },
      }),
      requireOwner,
      /**
       * **既定の 400 を使わない**（`PUT /profile` の同名の hook と同じ理由）。
       * 既定は本文をそのまま `data` に載せて返すので、欄の綴りを1つ間違えただけで
       * `env` / `headers` の鍵が応答へ載る。返すのは不正な欄の位置だけである。
       */
      jsonBody(mcpServersUpdateRequestSchema, (where) => ({
        error: 'MCP サーバの登録の形が不正（保存していない）' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        // **前の登録は日誌の「前の登録」のためにしか使わない**（差分の計算も配布も
        // 前の登録を見ない全文置換）。保存済みの登録が壊れていて読めなくても、置き
        // 直す口を塞がない（#2489）——「読めなかった」と日誌に書いて進む。**「なし」
        // とは書き分ける**（前は空だったと取り違えない）。理由は `reasonOf` を通す
        // （器の例外は値を載せない作りだが、ここでも伏せ字を通す）。登録の中身は
        // 日誌にも応答にも出さない。
        let previousText: string;
        try {
          const previous = await deps.stores.mcpServers.read();
          const before = previous === null ? [] : mcpServerNames(previous.mcpServers);
          previousText = before.length === 0 ? 'なし' : before.join(', ');
        } catch (error) {
          previousText = `読めなかった（${reasonOf(error)}）`;
        }
        const { mcpServers: servers, ifMatch } = c.req.valid('json');
        const writeOptions = ifMatch === undefined ? undefined : { ifMatch };
        const names = mcpServerNames(servers);

        // **日誌を先に書く（issue #2123）。書けなければ差し替えずに 500。**
        // runner への配布結果は差し替えた後でないと分からないので、ここでは
        // 含めない（後で分かる分は2行目として下で足す）。
        await deps.stores.journal.append({
          type: 'decision',
          decision:
            names.length === 0
              ? 'MCP サーバの登録を外そうとしている'
              : `MCP サーバの登録を差し替えようとしている（${names.join(', ')}）`,
          grounds:
            `${describeActor(c.get('principal'))}（PUT /mcp-servers）。` +
            `前の登録: ${previousText}。` +
            '値は書かない（鍵が入りうる）。',
        });

        // **1本道を通す**（渡されていない構成＝テストや配布先を持たない器では、
        // 保存だけして配らない。配らなかったことは `runners: []` で見える）。
        let applied: ApplyMcpServersResult;
        try {
          applied =
            deps.mcpServers === undefined
              ? await (async () => {
                  const stored = await deps.stores.mcpServers.write(servers, writeOptions);
                  const storedNames = mcpServerNames(stored.mcpServers);
                  return {
                    updatedAt: stored.updatedAt,
                    version: mcpServersVersionOf(stored),
                    names: storedNames,
                    ...(storedNames.length === 0
                      ? {}
                      : { sha256: mcpServersFingerprintOf(stored.mcpServers) }),
                    runners: [],
                  };
                })()
              : await deps.mcpServers.apply(servers, writeOptions);
        } catch (error) {
          // 日誌には「差し替えようとしている」が残っているので、打ち消す
          // （grant の「アクセス許可付与の打ち消しの日誌」と同じ形）。
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision:
                names.length === 0
                  ? 'MCP サーバの登録を外せなかった'
                  : `MCP サーバの登録を差し替えられなかった（${names.join(', ')}）`,
              grounds: `${describeActor(c.get('principal'))}（PUT /mcp-servers、状態の変更が失敗）`,
            },
            'MCP サーバ登録の打ち消しの日誌',
            `count=${String(names.length)}`,
          );
          // **鍵（サーバー名・env の名前）と環境変数になる値（env の値）の NUL は入力の誤り**
          // ——400（issue #2927。teto の判断、2026-10-05）。文は欄名と固定の説明だけで、値を載せない。
          if (error instanceof NulNotAllowedError) {
            return c.json(
              { error: `MCP サーバの登録が不正（保存していない）: ${error.message}` },
              400,
            );
          }
          // 版が合わず書いていない（`current` の鍵の有無で他の 409 と見分けられる）。
          if (error instanceof McpServersConflictError) {
            return c.json(
              {
                error: 'MCP サーバの登録が読んだ後に変わっています（書き換えていません）',
                current: mcpServersReadBody(error.current),
              },
              409,
            );
          }
          throw error;
        }
        // 配布の結果も日誌へ（名前と成否だけ。値は書かない）。差し替え自体は
        // もう効いている——後で分かった配布結果は2行目として足す（落ちても
        // 500 にしない。`appendJournalOrDrop` の doc）。
        const delivered = applied.runners
          .map(
            (r) =>
              `${r.runnerId}=${r.ok ? 'ok' : r.unsupported === true ? '口なし（古い runner）' : '失敗'}`,
          )
          .join(', ');
        await appendJournalOrDrop(
          deps.stores,
          {
            type: 'decision',
            decision:
              names.length === 0
                ? 'MCP サーバの登録を外した'
                : `MCP サーバの登録を差し替えた（${names.join(', ')}）`,
            grounds:
              `${describeActor(c.get('principal'))}（PUT /mcp-servers）。` +
              `前の登録: ${previousText}。` +
              '値は書かない（鍵が入りうる）。クローンの次のセッションから効く。' +
              `runner への配布: ${delivered.length === 0 ? '配る先なし' : delivered}` +
              '（マネージャーには次に開くセッションから効く）。',
          },
          'MCP サーバ登録の日誌',
          `count=${String(names.length)}`,
        );
        return c.json(
          mcpServersUpdateResponseSchema.parse({
            names,
            updatedAt: applied.updatedAt,
            version: applied.version,
            ...(applied.sha256 === undefined ? {} : { sha256: applied.sha256 }),
            appliesFrom:
              'クローンの次のセッションから。マネージャー・作業者は、配布できた runner で次に開くセッションから',
            runners: applied.runners,
          }),
        );
      },
    )

    // --- plugin を入れる・外す口（/plugins） -----------------------------------

    /**
     * 入れてある plugin の一覧。**files は返さない**（名前・取り元・SHA・scope・フラグ・大きさだけ）。
     *
     * **門は `requireOwner`**（MCP 連携の登録と同じ範囲。plugin は skills・agents・commands を
     * クローンとマネージャーの実行に持ち込む）。**クローンの道具からは入れられない**（道具を足さない）。
     */
    .get(
      '/plugins',
      describeRoute({
        tags: ['plugins'],
        summary: '入れてある plugin の一覧（files は含まない）',
        responses: {
          200: {
            description: '入れてある plugin の要約。',
            content: { 'application/json': { schema: resolver(pluginsListResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      async (c) =>
        c.json(pluginsListResponseSchema.parse({ plugins: await deps.stores.plugins.list() })),
    )

    /**
     * 取り元から plugin を取り、**中身の要約を返す**（まだ入れない）。取った中身は短い期限つきで
     * サーバ側に預かり、`previewId` を返す。**確定（`POST /plugins`）はこの預かりをそのまま保存し、
     * 取り直さない**ので、確認の後に取り元が動いても、見せたものと入れるものがずれない。
     *
     * 取り元は2つ: 任意の https の Git URL（`path` / `ref` / `sha` を添えられる。SHA が無ければ取得時に
     * 一度だけ解決して固定する）と、公式 marketplace の plugin 名（索引が実体の座標を持つ）。
     * hooks を含むかどうかを `summary.hooks` に出す（**enableHooks でも展開器はいまは hooks を出さない**）。
     */
    .post(
      '/plugins/preview',
      describeRoute({
        tags: ['plugins'],
        summary: 'plugin を取って中身の要約を返す（まだ入れない）',
        responses: {
          200: {
            description: '要約と、確定に使う previewId（期限つき）。',
            content: { 'application/json': { schema: resolver(pluginPreviewResponseSchema) } },
          },
          400: {
            description: '入力・取り元の中身が不正（上限超過・path が無い・名前が使えない など）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          502: {
            description: '取り元から取れなかった（接続・時間・サイズの上限）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          503: {
            description: '取得の口が無い、または公式 marketplace の URL が未設定。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      jsonBody(pluginPreviewRequestSchema, (where) => ({
        error: 'plugin の取り元の指定が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const fetcher = deps.pluginFetcher;
        if (fetcher === undefined) {
          return c.json({ error: 'plugin を取る口が無い構成' }, 503);
        }
        const body = c.req.valid('json');
        let fetched;
        try {
          fetched = await fetcher.fetch(
            body.kind === 'url'
              ? {
                  kind: 'url',
                  url: body.url,
                  ...(body.path === undefined ? {} : { path: body.path }),
                  ...(body.ref === undefined ? {} : { ref: body.ref }),
                  ...(body.sha === undefined ? {} : { sha: body.sha }),
                }
              : { kind: 'marketplace', plugin: body.plugin },
          );
        } catch (error) {
          if (!(error instanceof PluginFetchError)) throw error;
          const status = error.kind === 'invalid' ? 400 : error.kind === 'unavailable' ? 502 : 503;
          return c.json({ error: reasonOf(error) }, status);
        }
        const { previewId, expiresAt } = pluginPreviews.put(fetched);
        return c.json(
          pluginPreviewResponseSchema.parse({
            previewId,
            expiresAt,
            summary: summarizeFetchedPlugin(fetched),
          }),
        );
      },
    )

    /**
     * 確定する。**プレビューの預かりをそのまま保存する**（取り直さない）。
     *
     * **日誌を先に書き、書けなければ入れずに 500**（能力を広げる口。`PUT /mcp-servers` と同じ）。
     * 書くのは名前・取り元・SHA・scope・フラグだけで、**中身は書かない**。保存が投げたら打ち消しの行を
     * 足す。名前が既存の名前と大文字小文字だけ違うときは 409。保存した後に runner へ配る
     * （`PluginDistributionService.apply`。配れなかった runner へは名乗り直しで降ろし直す）。
     *
     * 同名は置き換える（版を上げる使い方）。**scope・enableHooks・enableMcp は確定のときに決める。**
     * hooks と `.mcp.json` は既定で無効で、enableHooks を true にしても展開器はいまは hooks を出さない。
     */
    .post(
      '/plugins',
      describeRoute({
        tags: ['plugins'],
        summary: 'プレビューした plugin を入れる（確定）',
        responses: {
          200: {
            description: '入れた plugin と、runner ごとの配布結果。',
            content: { 'application/json': { schema: resolver(pluginInstallResponseSchema) } },
          },
          400: {
            description: '入力が不正、または保存できない形（何も保存していない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: 'previewId が無い（期限切れ・確定済み・別のデーモン）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description: '名前が既存の名前と大文字小文字だけ違う。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          500: {
            description: '日誌が書けなかったので入れていない。',
            content: {
              'application/json': { schema: resolver(journalWriteFailedResponseSchema) },
            },
          },
        },
      }),
      requireOwner,
      jsonBody(pluginInstallRequestSchema, (where) => ({
        error: 'plugin の確定の指定が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const { previewId, scope, enableHooks, enableMcp } = c.req.valid('json');
        const fetched = pluginPreviews.get(previewId);
        if (fetched === undefined) {
          return c.json(
            {
              error:
                'プレビューが見つからない（期限切れ、確定済み、または別のデーモン）。もう一度プレビューから',
            },
            404,
          );
        }
        // 外から来た説明は弾かずに整える（飾りのせいで入れられなくしない）。
        const description = normalizePluginDescription(fetched.description);
        const input = {
          name: fetched.name,
          ...(description === undefined ? {} : { description }),
          source: fetched.source,
          scope,
          enableHooks,
          enableMcp,
          files: fetched.files,
          installedAt: new Date().toISOString(),
          installedBy: installerOf(c.get('principal')),
        };
        // 日誌より前に、保存できる形かを確かめる（保存できないものの「入れようとしている」を残さない）。
        try {
          parsePluginInput(input);
        } catch (error) {
          return c.json(
            { error: `plugin を保存できない形（入れていない）: ${reasonOf(error)}` },
            400,
          );
        }

        let previousText = '新規';
        try {
          const previous = (await deps.stores.plugins.list()).find((p) => p.name === fetched.name);
          if (previous !== undefined) {
            previousText = `置き換え（前の SHA: ${previous.source.sha}）`;
          }
        } catch (error) {
          previousText = `前の状態は読めなかった（${reasonOf(error)}）`;
        }
        const flags = `scope: ${scope}、hooks: ${enableHooks ? '有効' : '無効'}、.mcp.json: ${enableMcp ? '有効' : '無効'}`;
        const actor = describeActor(c.get('principal'));

        // **日誌を先に書く。書けなければ入れずに 500。** 中身は書かない。
        try {
          await deps.stores.journal.append({
            type: 'decision',
            decision: `plugin を入れようとしている（${fetched.name}）`,
            grounds:
              `${actor}（POST /plugins）。取り元: ${describePluginSource(fetched.source)}。` +
              `${flags}。${previousText}。中身は書かない。`,
          });
        } catch (error) {
          noteDroppedRecord(
            'plugin を入れる日誌（入れていない）',
            `name=${fetched.name}`,
            kindOfError(error),
          );
          return c.json(journalWriteFailedBody(), 500);
        }

        let stored;
        try {
          stored = await deps.stores.plugins.put(input);
        } catch (error) {
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision: `plugin を入れられなかった（${fetched.name}）`,
              grounds: `${actor}（POST /plugins、状態の変更が失敗）`,
            },
            'plugin を入れる打ち消しの日誌',
            `name=${fetched.name}`,
          );
          if (error instanceof PluginNameConflictError) {
            return c.json({ error: reasonOf(error) }, 409);
          }
          throw error;
        }
        pluginPreviews.discard(previewId);

        const applied = await applyPlugins(deps);
        await appendJournalOrDrop(
          deps.stores,
          {
            type: 'decision',
            decision: `plugin を入れた（${fetched.name}）`,
            grounds:
              `${actor}（POST /plugins）。取り元: ${describePluginSource(fetched.source)}。` +
              `${flags}。runner への配布: ${describePluginDelivery(applied.runners)}。`,
          },
          'plugin を入れた日誌',
          `name=${fetched.name}`,
        );
        return c.json(
          pluginInstallResponseSchema.parse({
            plugin: stored,
            appliesFrom:
              'クローンの次のセッションから。マネージャー・作業者は、配布できた runner で次に開くセッションから',
            runners: applied.runners,
          }),
        );
      },
    )

    /**
     * plugin を外す。**日誌を先に書き、書けなければ消さずに 500**。消した後に runner へ配る。
     * 無い名前は 404（日誌も書かない）。
     */
    .delete(
      '/plugins/:name',
      describeRoute({
        tags: ['plugins'],
        summary: 'plugin を外す',
        responses: {
          200: {
            description: '外した plugin の名前と、runner ごとの配布結果。',
            content: { 'application/json': { schema: resolver(pluginRemoveResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: 'その名前の plugin は入っていない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          500: {
            description: '日誌が書けなかったので外していない。',
            content: {
              'application/json': { schema: resolver(journalWriteFailedResponseSchema) },
            },
          },
        },
      }),
      requireOwner,
      async (c) => {
        const name = c.req.param('name');
        if (!isValidPluginName(name))
          return c.json({ error: `plugin ${name} は入っていない` }, 404);
        // list() は壊れた行が1つあると全体が投げるので、外す口には使わない。get の失敗は
        // 「取り元不明」として外せるようにする（外せない壊れた行が残り続けないため）。
        // 在るかどうかは remove() の戻り値で決める。
        let found: Awaited<ReturnType<typeof deps.stores.plugins.get>> | 'unreadable';
        try {
          found = await deps.stores.plugins.get(name);
        } catch {
          found = 'unreadable';
        }
        if (found === null) return c.json({ error: `plugin ${name} は入っていない` }, 404);
        const actor = describeActor(c.get('principal'));
        const flags =
          found === 'unreadable'
            ? '取り元不明（行を読めなかった）'
            : `scope: ${found.scope}、取り元: ${describePluginSource(found.source)}`;

        try {
          await deps.stores.journal.append({
            type: 'decision',
            decision: `plugin を外そうとしている（${name}）`,
            grounds: `${actor}（DELETE /plugins/:name）。${flags}。`,
          });
        } catch (error) {
          noteDroppedRecord(
            'plugin を外す日誌（外していない）',
            `name=${name}`,
            kindOfError(error),
          );
          return c.json(journalWriteFailedBody(), 500);
        }

        let removed: boolean;
        try {
          removed = await deps.stores.plugins.remove(name);
        } catch (error) {
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision: `plugin を外せなかった（${name}）`,
              grounds: `${actor}（DELETE /plugins/:name、状態の変更が失敗）`,
            },
            'plugin を外す打ち消しの日誌',
            `name=${name}`,
          );
          throw error;
        }
        if (!removed) return c.json({ error: `plugin ${name} は入っていない` }, 404);

        const applied = await applyPlugins(deps);
        await appendJournalOrDrop(
          deps.stores,
          {
            type: 'decision',
            decision: `plugin を外した（${name}）`,
            grounds:
              `${actor}（DELETE /plugins/:name）。${flags}。` +
              `runner への配布: ${describePluginDelivery(applied.runners)}。`,
          },
          'plugin を外した日誌',
          `name=${name}`,
        );
        return c.json(
          pluginRemoveResponseSchema.parse({
            name,
            appliesFrom:
              'クローンの次のセッションから。マネージャー・作業者は、配布できた runner で次に開くセッションから',
            runners: applied.runners,
          }),
        );
      },
    )

    // --- マネージャーへ降ろす環境変数（/credentials） ------------------------
    // 正本はデーモンが持ち、runner へは制御面で降ろす（runner に記憶ストアの鍵を
    // 渡さないため）。**器（`compose.yaml` の環境変数）を焼き直す代わりの口である。**

    /**
     * 正本に在る鍵の一覧。**値は出さない（指紋だけ）。**
     *
     * **資格は `authenticate` だけ（`requireOperator` は付けない）。** ここが返すのは
     * 指紋であって値ではなく、同じ指紋は `GET /runners` が runner 側の分をすでに
     * 同じ資格で出している——読める強さを揃えないと、「届いているか」を確かめたい
     * だけの人が実行環境の持ち主の資格を要求されることになる。
     *
     * **値を返す口は作らない**（`credentialsResponseSchema` の doc）。
     */
    .get(
      '/credentials',
      describeRoute({
        tags: ['credentials'],
        summary: 'マネージャーへ降ろす環境変数の指紋を読む',
        description:
          '正本に在る名前と指紋を返す。**値は返さない。** 届いているかは ' +
          'GET /runners の credentials（runner 側の指紋）と突き合わせる。',
        responses: {
          200: {
            description: '正本に在る鍵の指紋。',
            content: { 'application/json': { schema: resolver(credentialsResponseSchema) } },
          },
          503: {
            description: '正本の器が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        if (deps.credentials === undefined) {
          return c.json({ error: '鍵の正本の器が無い' as const }, 503);
        }
        return c.json(
          credentialsResponseSchema.parse({ credentials: await deps.credentials.fingerprints() }),
        );
      },
    )

    /**
     * 置いて配る。**器を作り直さない。**
     *
     * これが無いと、用途が増えるたびに `compose.yaml`（Railway なら Shared
     * Variables）へ環境変数を足して器を焼き直すことになる＝「環境を直す」と
     * 「走行中の仕事を失う」が同じ操作になる（AGENTS.md 地雷表）。
     *
     * **`POST /runners/credentials` との違いは、保管するかどうかである。**
     * あちらは受け取って走っている runner へ降ろすだけ（器を作り直すと消える）。
     * ここは正本へ置くので、**器が入れ替わっても `hello` のときに降り直す。**
     *
     * **許可済みのアカウントなら通る**（`requireOwner`。2026-10-05 の #2862 の
     * オーナー決定で、宣言済み owner だけから緩めた）。以下の「宣言済み」は緩める前の
     * 記述である。任意の名前で任意の値を、これから
     * 起こすマネージャーの環境へ永続的に置ける口であり、**`PATH` のような名前も
     * 置ける**——`access grant` を通っただけのアカウントに渡す強さではない。
     *
     * **⚠️ 2026-09-17、ここは `requireOperator` から一段緩めた**（issue #1195）。
     * 当初は「持ち主が端末から直に許可したアカウント」（`grantedBy === 'operator'`）
     * の近似で通していたが、**2026-09-18 に `ownerDeclaredAt` の宣言へ置き換えた**
     * （issue #1198）——**ブラウザは `requireOperator` を構造的に通れないので、
     * そのままでは箱の持ち主本人が Web UI から自分の環境変数を置けなかった。**
     * 伝播した許可（A が B を通した）は通らない。理由は `requireOwner` の doc にある。
     *
     * **⚠️ `GET /profile` `PUT /profile` は緩めていない。** あちらは応答本文に鍵が
     * 丸ごと載る口で、こちらは**置けるが読み出せない**（一覧が返すのは指紋である）。
     * ⟹ **意図した非対称である** —— ここの資格が漏れて起きるのは「今後の鍵が
     * 書き換わる」で、「いま在る鍵が流出する」ではない。
     *
     * **`POST /runners/credentials` の資格（`authenticate` だけ）とは、2026-10-05 の
     * オーナー決定（#2862。許可済みのアカウントは全員持ち主）で食い違いが消えた。**
     * どちらも許可済みなら通る。
     *
     * **能力を広げる口（issue #2123。teto の判断）。** マネージャーに鍵を降ろす
     * 口なので、`/access/:accountId/grant` と同じ扱い——**日誌を先に書き、
     * 書けなければ差し替えずに 500**。以前は差し替え（`deps.credentials.apply`。
     * 正本への保存と runner への配布を含む）の**後**に日誌へ書いていて、追記
     * だけが落ちても 500 を返す一方で差し替えは効いたまま残っていた（閉じる側に
     * 倒れていなかった）。差し替えが投げたら、打ち消しの行を `appendJournalOrDrop`
     * で足してから同じエラー応答（`{ error: String(error) }` の 400）を返す——
     * `deps.credentials.apply` は名前の形・伏せる鍵などの検証もこの1呼びの中で
     * 行うので、検証で断られた回もここに含まれる（「記録が多すぎる側」の穴で、
     * 記録の無い差し替えより安全側と判断した。teto の判断）。指紋・runner への
     * 配布結果は差し替えた後でないと分からないので、先に書く行はそれを含まない
     * 形にし、後で分かる分は2行目として `appendJournalOrDrop`（best-effort）で
     * 足す。
     */
    .put(
      '/credentials',
      describeRoute({
        tags: ['credentials'],
        summary: 'マネージャーへ降ろす環境変数を置いて配る',
        description:
          '**部分更新**（入力に無い名前は触らない）。空文字は「その名前を外す」。' +
          '正本へ置いてから全 runner へ降ろす。器を作り直しても hello のときに降り直す。',
        responses: {
          200: {
            description: '正本の指紋と、各 runner への配布結果。',
            content: {
              'application/json': { schema: resolver(credentialsUpdateResponseSchema) },
            },
          },
          400: {
            description:
              '本文の形が不正、または置かせない名前だった（**1文字も置いていない**）。' +
              '**送られてきた本文は返さない**——ここは鍵の値そのものを運ぶ口なので、' +
              '既定の 400 の形は使えない（`POST /runners/credentials` の hook の doc）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          503: {
            description: '正本の器が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      /**
       * **既定の 400 を使わない**（`POST /runners/credentials` と同じ理由）。
       * 鍵を1本 `name` の形式ミスで書き間違えただけで、その回に送った*全部*の鍵の
       * 値が応答へ載る。どこが不正だったかは返す（`path` だけ）が、送られてきた
       * 本文は1文字も返さない。
       */
      jsonBody(credentialsUpdateRequestSchema, (where) => ({
        error: '鍵の入力の形が不正（置いていない）' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        if (deps.credentials === undefined) {
          return c.json({ error: '鍵の正本の器が無い' as const }, 503);
        }
        const entries = c.req.valid('json').credentials;
        const setNames = entries.filter((e) => e.value.length > 0).map((e) => e.name);
        const removedNames = entries.filter((e) => e.value.length === 0).map((e) => e.name);
        const wanted = [
          setNames.length === 0 ? null : `置く: ${setNames.join(', ')}`,
          removedNames.length === 0 ? null : `外す: ${removedNames.join(', ')}`,
        ]
          .filter((part) => part !== null)
          .join('。');

        // **日誌を先に書く（issue #2123）。書けなければ差し替えずに 500。**
        // 指紋は差し替えた後でないと分からないので、ここでは名前だけを書く
        // （後で分かる分は2行目として下で足す）。
        await deps.stores.journal.append({
          type: 'decision',
          decision: `環境変数（鍵）を差し替えようとしている（${wanted}）`,
          grounds: `${describeActor(c.get('principal'))}（PUT /credentials）。値は書かない（鍵そのものである）。`,
        });

        let result: ApplyCredentialsResult;
        try {
          result = await deps.credentials.apply(entries);
        } catch (error) {
          /**
           * **置かせない名前（伏せる鍵・プールが正本を持つ名前）もここへ来る**
           * （`credential-service.ts` の `assertEntries`。検証と実際の保存が
           * 同じ1呼び〈`apply`〉の中にあり、ここからは分けられない）。
           *
           * 理由を返す——「置けなかった」だけでは、人間は名前を疑うのか権限を
           * 疑うのか分からない。
           *
           * **理由を返してよいのは、検証で断った例外（`CredentialEntryRejectedError`。
           * 名前と理由だけで値を載せない文）だけ**（issue #2415）。`apply` は保存も
           * 担うので、それ以外の例外（ストアの書き込みの失敗など）の `message` には
           * 値が載りうる（drizzle は `Failed query: … params: <値>` を複数行で添える）。
           * こちらは `name` だけを、応答にも日誌にも載せる。見分けは文言でなく型で行う。
           *
           * **ストアの入口の断り（`NulNotAllowedError`・`InvalidCredentialNameError`。#2927）も
           * 理由を返す**——文は欄名と固定の説明だけで、名前・値を載せない（型で見分ける）。
           *
           * 日誌には「差し替えようとしている」が残っているので、打ち消す（grant の
           * 「アクセス許可付与の打ち消しの日誌」と同じ形。**検証で断られた回も同じ
           * 扱いにする**——記録が多すぎる側の穴で、記録の無い差し替えより安全側と
           * 判断した。teto の判断）。
           */
          const reason =
            error instanceof CredentialEntryRejectedError
              ? error.message
              : error instanceof NulNotAllowedError
                ? error.message
                : error instanceof InvalidCredentialNameError
                  ? error.message
                  : `鍵の差し替えに失敗した（${kindOfError(error)}）。詳細は値が載りうるので返さない`;
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision: `環境変数（鍵）を差し替えられなかった（${wanted}）`,
              grounds:
                `${describeActor(c.get('principal'))}（PUT /credentials、状態の変更が失敗）: ` +
                reason,
            },
            '環境変数（鍵）の打ち消しの日誌',
            `names=${entries.map((e) => e.name).join(',')}`,
          );
          return c.json({ error: reason }, 400);
        }

        /**
         * **差し替えた事実と配布の成否を日誌へ残す（名前と指紋だけ。値は1文字も
         * 書かない。Issue #1733）。**
         *
         * ⚠️ **`result.fingerprints` を丸ごと流さないこと。** `secret === false`
         * の行は `value`（平文）を伴って返ってくる（`credential-service.ts` の
         * `fingerprintOfRow`）——ここでは `name` / `sha256` だけを個別に読む。
         *
         * **差し替え自体はもう効いている**（正本への保存・runner への配布とも
         * 済んでいる）。後で分かった指紋・配布結果を2行目として足す（落ちても
         * 500 にしない。`appendJournalOrDrop` の doc）。
         */
        const sha256ByName = new Map(result.fingerprints.map((f) => [f.name, f.sha256]));
        const changed = [
          setNames.length === 0
            ? null
            : `置いた: ${setNames.map((name) => `${name}=${sha256ByName.get(name) ?? '不明'}`).join(', ')}`,
          removedNames.length === 0 ? null : `外した: ${removedNames.join(', ')}`,
        ]
          .filter((part) => part !== null)
          .join('。');
        const delivered = result.runners
          .map((r) => `${r.runnerId}=${r.ok ? 'ok' : '失敗'}`)
          .join(', ');
        await appendJournalOrDrop(
          deps.stores,
          {
            type: 'decision',
            decision: `環境変数（鍵）を差し替えた（${changed}）`,
            grounds:
              `${describeActor(c.get('principal'))}（PUT /credentials）。` +
              '値は書かない（鍵そのものである）。' +
              `runner への配布: ${delivered.length === 0 ? '配る先なし' : delivered}` +
              '。',
          },
          '環境変数（鍵）の日誌',
          `names=${entries.map((e) => e.name).join(',')}`,
        );

        return c.json(
          // **サービスの返す形をそのまま流さない。** 宣言（`credentials`）と
          // サービスの語彙（`fingerprints`）が違うので、`parse` で落ちる形に
          // しておく（外向きの名前は「指紋」より「鍵」のほうが読みやすい）。
          credentialsUpdateResponseSchema.parse({
            credentials: result.fingerprints,
            runners: result.runners,
          }),
        );
      },
    )

    // --- Codex の ChatGPT ログイン（/codex。#3939） ---------------------------
    // 口は CLI（`alteroid codex`）・Web・この HTTP の3つで、どれもここを通る。
    // **値（auth.json の中身）を返す口は作らない。** 状態とログインの進み具合だけを返す。

    .get(
      '/codex/auth',
      describeRoute({
        tags: ['codex'],
        summary: 'Codex の ChatGPT ログインの状態を読む',
        description:
          'ログイン済みか・アカウント・プラン・最終更新・指紋・最後の失敗を返す。**値は返さない。**',
        responses: {
          200: {
            description: 'いまの状態。',
            content: { 'application/json': { schema: resolver(codexAuthStatusResponseSchema) } },
          },
          503: {
            description: '正本の器が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        if (deps.codexAuth === undefined) {
          return c.json({ error: 'Codex のログインの正本の器が無い' as const }, 503);
        }
        return c.json(codexAuthStatusResponseSchema.parse(await deps.codexAuth.status()));
      },
    )

    /**
     * ログアウト（正本から消し、全 runner から外す）。**狭める側**なので、日誌は状態を変えた後に
     * 持ち主（`CodexChatgptAuthService`）が書く。資格は `requireOwner`（`PUT /credentials` と揃える。資格を書く口であるため。2026-10-07 オーナー確認済み）。
     */
    .delete(
      '/codex/auth',
      describeRoute({
        tags: ['codex'],
        summary: 'Codex の ChatGPT ログインを消す（ログアウト）',
        description: '正本から消し、全 runner の CODEX_HOME から外す。',
        responses: {
          200: {
            description: '消したか（無かったなら false）。',
            content: { 'application/json': { schema: resolver(codexLogoutResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          503: {
            description: '正本の器が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      async (c) => {
        if (deps.codexAuth === undefined) {
          return c.json({ error: 'Codex のログインの正本の器が無い' as const }, 503);
        }
        return c.json(codexLogoutResponseSchema.parse(await deps.codexAuth.logout()));
      },
    )

    /**
     * デバイスコードのログインを始める。確認用 URL とコードを返す。人間がブラウザで承認すると、
     * 持ち主が正本へ置いて runner へ降ろす（`GET /codex/login/:id` で進み具合を見る）。
     * 進行中のものがあればそれを返す（同時に1本）。
     *
     * **能力を広げる口**（peer の Codex が使う資格を置く）なので、`PUT /credentials` と同じく `requireOwner` を通し（2026-10-07 オーナー確認済み）、
     * **日誌を先に書き、書けなければ始めずに 500。**
     */
    .post(
      '/codex/login',
      describeRoute({
        tags: ['codex'],
        summary: 'Codex の ChatGPT ログインをデバイスコードで始める',
        description:
          'デーモンの器で codex app-server を一時的な CODEX_HOME で起こし、デバイスコードを回す。' +
          '返った verificationUrl を開いて userCode を入力すると完了する。',
        responses: {
          200: {
            description: '始めたログイン（または進行中のログイン）。',
            content: { 'application/json': { schema: resolver(codexLoginResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          502: {
            description: 'codex app-server を起こせなかった・デバイスコードを取れなかった。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          503: {
            description: '正本の器が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      async (c) => {
        if (deps.codexAuth === undefined) {
          return c.json({ error: 'Codex のログインの正本の器が無い' as const }, 503);
        }
        await deps.stores.journal.append({
          type: 'decision',
          decision: 'Codex の ChatGPT ログインを始めようとしている（デバイスコード）',
          grounds: `${describeActor(c.get('principal'))}（POST /codex/login）。値は書かない。`,
        });
        try {
          return c.json(codexLoginResponseSchema.parse(await deps.codexAuth.startLogin()));
        } catch (error) {
          return c.json({ error: reasonOf(error) }, 502);
        }
      },
    )

    .get(
      '/codex/login/:id',
      describeRoute({
        tags: ['codex'],
        summary: 'Codex の ChatGPT ログインの進み具合を読む',
        responses: {
          200: {
            description: 'ログイン1本の状態。',
            content: { 'application/json': { schema: resolver(codexLoginResponseSchema) } },
          },
          404: {
            description: '知らない id（デーモンが入れ替わった・古くて忘れた）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          503: {
            description: '正本の器が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      (c) => {
        if (deps.codexAuth === undefined) {
          return c.json({ error: 'Codex のログインの正本の器が無い' as const }, 503);
        }
        const view = deps.codexAuth.login(c.req.param('id'));
        if (view === undefined) return c.json({ error: 'そのログインは無い' as const }, 404);
        return c.json(codexLoginResponseSchema.parse(view));
      },
    )

    .delete(
      '/codex/login/:id',
      describeRoute({
        tags: ['codex'],
        summary: 'Codex の ChatGPT ログインを取り消す',
        responses: {
          200: {
            description: '取り消した後の状態（既に決着していればその状態）。',
            content: { 'application/json': { schema: resolver(codexLoginResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '知らない id。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          503: {
            description: '正本の器が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      async (c) => {
        if (deps.codexAuth === undefined) {
          return c.json({ error: 'Codex のログインの正本の器が無い' as const }, 503);
        }
        const view = await deps.codexAuth.cancelLogin(c.req.param('id'));
        if (view === undefined) return c.json({ error: 'そのログインは無い' as const }, 404);
        return c.json(codexLoginResponseSchema.parse(view));
      },
    )

    // --- 認証トークンのプール（/tokens） ------------------------------------
    // Issue #393「PR1 プールの器」。**回さない。** 検知も切替もここには無い。

    /**
     * プールの一覧と、回す契機・冷却の設定。
     *
     * **資格は `authenticate` だけ（`requireOperator` は付けない）。** ⚠️ 2026-09-06
     * のオーナー決定——alteroid を使う許可（`access grant` 済み）があれば、実行環境の
     * 持ち主と同格に扱う——により、以前ここに在った `requireOperator` を外した。
     * `/profile`（鍵そのものを運ぶ）とは違い、ここが持つのは課金の設定であって
     * 鍵の値ではないため、この決定の対象に含まれる。
     *
     * **値は決して出さない。** `TokenPoolService.list()` が返すのは
     * `AgentTokenView`（label と指紋だけ）で、`AgentToken`（`value` 付き）は
     * サービスの外へ一度も出ない。
     */
    .get(
      '/tokens',
      describeRoute({
        tags: ['tokens'],
        summary: '認証トークンのプールと設定を読む',
        description:
          'プールが空でも 200 を返し、既定の設定（`free_exhausted`）を返す' +
          '（受け入れ基準7: プールが空の既定構成の挙動を変えない）。' +
          '回す契機・冷却の設定が壊れていて読めないときも 200 を返す——' +
          '`settings` を省いて `settingsUnreadable.reason` を返す（issue #2095）。' +
          'プールの行が読めない（版ずれ・手編集）ものが在るときだけ、`rowsUnreadable`' +
          '（件数と、id・ラベル・不正な欄名。**値は含まない**）が載る。**壊れた行であって、' +
          '消されたトークンではない。** `tokens` が空でも `rowsUnreadable` が在れば' +
          '「登録されていない」ではない。0件なら鍵ごと無い（issue #2346）。',
        responses: {
          200: {
            description:
              'プール（値は出さない）と設定。設定が読めないときは `settings` の代わりに' +
              '`settingsUnreadable: { reason }` を返す（プールの一覧は道連れにしない）。' +
              '行が読めないものが在るときは `rowsUnreadable` も載る。',
            content: { 'application/json': { schema: resolver(tokensResponseSchema) } },
          },
          403: {
            description:
              'alteroid を使う許可が無い（ログインしているが `access grant` されて' +
              'いない）。資格そのものが無い場合は 401。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        if (deps.tokens === undefined) {
          return c.json(
            tokensResponseSchema.parse({ tokens: [], settings: DEFAULT_TOKEN_ROTATION_SETTINGS }),
          );
        }
        return c.json(tokensResponseSchema.parse(await deps.tokens.list()));
      },
    )

    /**
     * プールを全文置換する。**`value` を省略できる**——並べ替え・改名・
     * `disabled` の切り替えのたびに、他の行の秘密を貼り直さずに済む
     * （`agentTokenInputSchema` の doc）。
     *
     * `normalizeTokenPool` が投げたら 400 で理由を返す——**理由の本文にトークン
     * の値は含めない**（投げるメッセージは id / label だけを含む）。
     *
     * **資格は `authenticate` だけ（`requireOperator` は付けない）。** `GET /tokens`
     * と同じ理由（2026-09-06 のオーナー決定）。
     */
    .put(
      '/tokens',
      describeRoute({
        tags: ['tokens'],
        summary: '認証トークンのプールを全文置換する',
        description:
          '入力に無い（読めた）行は消える。**読めない行は消さずに持ち越す**（issue #2354。' +
          '消すには `POST /tokens/unreadable/remove`）。壊れた入力（新規行に value が無い・消えた id を' +
          '指す・id 重複）は 400 で理由を返し、保存しない。',
        responses: {
          200: {
            description:
              '置き換え後のプール（値は出さない）と設定。設定が読めないときは `settings` の' +
              '代わりに `settingsUnreadable: { reason }` を返す（プールの置換は道連れにしない。' +
              'issue #2095）。読めない行が在れば `rowsUnreadable`（`carriedOver: true`）が載る——' +
              '**読めない行は捨てずに持ち越した**（issue #2354）。消すには ' +
              '`POST /tokens/unreadable/remove`。**保存した後の表示の読み直しに失敗したときも ' +
              '200**（保存したので「保存できなかった」とは言わない）: `viewUnavailable` だけを' +
              '返し、プールの欄（`tokens` など）は載せない。',
            content: { 'application/json': { schema: resolver(tokensReplaceResponseSchema) } },
          },
          400: {
            description: '入力が壊れている（保存していない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          500: {
            description:
              '保存に失敗した、または**広げる側の変更（追加・有効化・値の差し替え・試す順の入れ替え）で' +
              '日誌が書けなかった（保存していない）**。狭める側（削除・無効化・改名）だけの変更は、' +
              '日誌が書けなくても保存して 200 を返す（issue #2742）。' +
              '**理由の本文は返さない**（ドライバの例外は失敗した' +
              'クエリの束縛パラメータを添えてくることがあるため）。跡は stderr に残る。' +
              '日誌が書けなかった回の本文は `{ error: "記録（日誌）が書けなかったので、変更していません", code: "journal_write_failed" }`' +
              '（`code` で見分ける。保存の失敗は `code` の無い `{ error }`）。',
            content: {
              'application/json': {
                schema: resolver(z.union([journalWriteFailedResponseSchema, errorResponseSchema])),
              },
            },
          },
          403: {
            description:
              'alteroid を使う許可が無い（ログインしているが `access grant` されて' +
              'いない）。資格そのものが無い場合は 401。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      /**
       * **既定の 400 を使わない。** `hook` を渡さないと
       * `@hono/standard-validator` は
       * `c.json({ data: <リクエスト本文そのもの>, error, success: false }, 400)`
       * を返す（実測 2026-08-24 観測、`@hono/standard-validator@0.4.0` の
       * `dist/index.mjs`。`sanitizeIssues` が見る `RESTRICTED_DATA_FIELDS` は
       * `header: ['cookie']` だけで、`json` は素通しになる）。
       *
       * **⟹ `label` を1つ書き忘れただけで、その回に送った *全部* の値が
       * 応答へ載る。** ここはトークンの本体を運ぶ唯一の口なので、既定の
       * 形をそのまま使えない。**どこが不正だったかは返す（`path` だけ）が、
       * 送られてきた本文は1文字も返さない。**
       */
      jsonBody(tokensUpdateRequestSchema, (where) => ({
        error:
          'トークンのプールの入力の形が不正（保存していない）' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        if (deps.tokens === undefined) {
          return c.json({ error: 'トークンのプールの器が無い' as const }, 400);
        }
        // **能力の向きで日誌の順序を分ける**（issue #2742。決定 2026-10-05、teto＝takecchi の代理）。
        // - **広げる側**（追加・有効化・切替＝値の差し替え/試す順の入れ替え）が差分に1つでも在れば、
        //   **日誌を先に書き、書けなければ保存せずに 500**（`PUT /credentials` と同じ。使える鍵が
        //   増える・変わる操作を、記録の無いまま通さない）。
        // - **狭める側だけ**（削除・無効化・改名）なら、**保存を先**にして日誌を後に書く
        //   （`appendJournalOrDrop`。日誌が書けなくても狭める操作は止めない）。
        // 全文置換なので、前後の差分（`classifyTokenPoolChange`）から分類する。
        const state: {
          changes: TokenPoolChange[];
          written: boolean;
          journalError?: { cause: unknown };
        } = { changes: [], written: false };
        const requestedCount = c.req.valid('json').tokens.length;
        let saved: Awaited<ReturnType<TokenPoolService['replace']>>;
        try {
          saved = await deps.tokens.replace(c.req.valid('json').tokens, {
            beforeSave: async ({ before, after }) => {
              state.changes = classifyTokenPoolChange(before, after);
              if (!state.changes.some((change) => change.widens)) return;
              try {
                await deps.stores.journal.append({
                  type: 'decision',
                  decision: `認証トークンのプールを変えようとしている（${describeTokenPoolChanges(state.changes)}）`,
                  grounds:
                    `${describeActor(c.get('principal'))}（PUT /tokens）。` +
                    '使える鍵が増える・変わる操作を含むので、日誌を先に書いた。' +
                    'id・ラベル・操作の種類だけを書く（トークンの値は書かない）。',
                });
              } catch (cause) {
                state.journalError = { cause };
                throw cause;
              }
              state.written = true;
            },
          });
        } catch (error) {
          // 日誌が書けなかった回は、状態を変えていない。素の 500（`Internal Server Error`）には
          // せず、「記録が書けなかったので変更していない」と言う本文を返す。**例外の本文は
          // 返さない**（値が載りうる。種類だけ跡に残す）。
          if (state.journalError !== undefined) {
            noteDroppedRecord(
              '認証トークンのプールの変更の日誌（保存していない）',
              `count=${String(requestedCount)}`,
              kindOfError(state.journalError.cause),
            );
            return c.json(journalWriteFailedBody(), 500);
          }
          // **返してよい例外だけを返す。型で分ける。**
          //
          // `TokenPoolInputError` は「`message` をそのまま応答へ返してよい」と
          // いう約束が型に付いている（`token-pool.ts` のその型の doc）。それ以外
          // ——保存の失敗——は**本文を1文字も返さない**。ドライバの例外は失敗した
          // クエリの束縛パラメータを添えてくるので（実測 2026-08-24 観測、
          // `drizzle-orm@0.45.2` の `PgPreparedQuery` が `Failed query: …` の
          // 次の行に `params: …` を置く）、素の `String(error)` を返すと
          // トークンの値がそのまま 400 の本文に載る。
          //
          // **`reasonOf` を通すだけにしないのは、それが偶然で効いているからである。**
          // `reasonOf` は1行目だけを採るので上の形では値が落ちるが、それは
          // ドライバがメッセージのどこで改行するかに依存していて、こちらが
          // 制御していない。**投げ直すのも駄目である**——`.onError` が無いので
          // 既定のハンドラへ回るだけで、本文を出さない保証がここから消える。
          if (error instanceof TokenPoolInputError) {
            return c.json({ error: error.message }, 400);
          }
          // 日誌は先に書いたが保存できなかった。打ち消しの行を足す（`PUT /credentials` と同じ形）。
          if (state.written) {
            await appendJournalOrDrop(
              deps.stores,
              {
                type: 'decision',
                decision: '認証トークンのプールを変えられなかった',
                grounds:
                  `${describeActor(c.get('principal'))}（PUT /tokens、状態の変更が失敗）。` +
                  `先に書いた行の変更（${describeTokenPoolChanges(state.changes)}）は保存されていない。`,
              },
              '認証トークンのプールの打ち消しの日誌',
              `count=${String(requestedCount)}`,
            );
          }
          // **跡は残す。ただし本文は出さない**（`dropped-record.ts` の作法）。
          // detail は**本文を含まない見分け**だけ（`dropped-record.ts` の doc）。
          // **error は種類（`name`）だけ渡す**（issue #2396）。`noteDroppedRecord` は
          // `message` の1行目と `cause` の連鎖を stderr へ出すので、生の error を渡すと
          // エラー文に載ったトークンの値が出うる。
          noteDroppedRecord(
            '認証トークンのプール',
            `count=${String(requestedCount)}`,
            kindOfError(error),
          );
          return c.json({ error: 'トークンのプールを保存できなかった' as const }, 500);
        }
        // **狭める側だけの変更は、保存した後に日誌を書く**（書けなければ跡だけ残して握る）。
        // 広げる側を含む回は、保存の前に書いてある。
        if (!state.written && state.changes.length > 0) {
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision: `認証トークンのプールを変えた（${describeTokenPoolChanges(state.changes)}）`,
              grounds:
                `${describeActor(c.get('principal'))}（PUT /tokens）。` +
                '狭める側（削除・無効化・改名）だけの変更なので、保存の後に書いた。' +
                'id・ラベル・操作の種類だけを書く（トークンの値は書かない）。',
            },
            '認証トークンのプールの変更の日誌',
            `count=${String(requestedCount)}`,
          );
        }
        // **ここから先は、保存した後である**（issue #2396）。失敗しても「保存できなかった」
        // ではない。上の `catch`（500）へ落とさず、保存したと言って返す。
        // 原因は種類（`error.name`）だけを日誌に使う——メッセージには行の中身
        // （トークンの値）が載りうる。
        let cause: unknown;
        if (saved.kind === 'replaced') {
          try {
            return c.json(tokensReplaceResponseSchema.parse(saved.view));
          } catch (parseError) {
            cause = parseError;
          }
        } else {
          cause = saved.cause;
        }
        // ここは保存した後の、読み直しの失敗の跡である。**変更そのものの日誌は上で書いてある**
        // （広げる側は保存の前、狭める側は保存の後。issue #2742。決定 2026-10-05、teto＝takecchi
        // の代理——かつてここは「日誌を先に書く作法は、この口には入れない」と書いていたが、
        // それを覆した）。この1行は保存の後の best-effort で、書けなければ stderr へ跡を残す。
        await appendJournalOrDrop(
          deps.stores,
          {
            type: 'decision',
            decision: '認証トークンのプールを保存したが、表示の読み直しに失敗した',
            grounds:
              `${describeActor(c.get('principal'))}（PUT /tokens）。` +
              `保存は済んでいる。読み直しの失敗の種類: ${kindOfError(cause)}。` +
              '行の中身（トークンの値）は書かない。',
          },
          '認証トークンのプールの保存後の読み直しの失敗の日誌',
          `count=${String(c.req.valid('json').tokens.length)}`,
        );
        return c.json(
          tokensReplaceResponseSchema.parse({
            viewUnavailable: {
              reason:
                '保存した。保存後のプールを読み直せなかった' +
                '（撃ち直さず、alteroid token list で今の姿を確かめる）',
            },
          }),
        );
      },
    )

    /**
     * **読めないプールの行を、id で指して消す**（issue #2354 の決定）。`PUT /tokens`
     * （全文置換）と回し手の書き戻しは読めない行を**持ち越す**ので、読めない行を
     * 消す口はここだけである。`rowsUnreadable.rows[].id`（`GET /tokens`）を指す。
     *
     * **形は `POST /inbox/remove` / `POST /archive/remove`（id の配列を取る POST）に合わせた。**
     * 読めない行は `DELETE /tokens/:id` の `:id`（読めた行の id）と名前空間が重なりうるので、
     * 別の語（`unreadable`）の下に置いて取り違えを避ける。
     *
     * **日誌を先に書き、書けなければ状態を変えずに 500**（`appendJournalOrDrop` の doc。
     * `PUT /credentials` と同じ作法）。**日誌に残すのは消す id と件数だけで、行の中身
     * （とくにトークンの値）は書かない。** 読めない行に無い id が1つでもあれば、何も消さず
     * 日誌も書かずに 404（件数だけ返し、指された文字列は返さない）。
     *
     * **資格は `authenticate` だけ（`/tokens` と同じ強さ）。**
     */
    .post(
      '/tokens/unreadable/remove',
      describeRoute({
        tags: ['tokens'],
        summary: '読めない認証トークンの行を、id を指して消す',
        description:
          '`GET /tokens` の `rowsUnreadable.rows[].id` を指した読めない行だけを消す。読めた行・' +
          '設定には触れない。id が取れない行はこの口では消せない。1つでも読めない行に無い id が' +
          'あれば何も消さない。消した id と件数を日誌に残す（行の中身は残さない）。',
        responses: {
          200: {
            description:
              '消した後のプール（値は出さない）と、消した id。**消した後の表示の読み直しに' +
              '失敗したときも 200**（消したので「消せなかった」とは言わない）: `removedIds` と ' +
              '`viewUnavailable` だけを返し、プールの欄は載せない。',
            content: {
              'application/json': { schema: resolver(tokensUnreadableRemoveResponseSchema) },
            },
          },
          400: {
            description: 'トークンのプールの器が無い、または入力の形が不正（何も消していない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description:
              '指した id のうち、読めない行に無いものがあった（何も消していない。日誌も書いていない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          500: {
            description:
              '日誌が書けなかった（**状態を変えていない**）か、消すのに失敗した。' +
              '理由の本文は返さない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          403: {
            description:
              'alteroid を使う許可が無い（ログインしているが `access grant` されて' +
              'いない）。資格そのものが無い場合は 401。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(tokensUnreadableRemoveRequestSchema, (where) => ({
        error:
          '読めない行の id の入力の形が不正（何も消していない）' +
          (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        if (deps.tokens === undefined) {
          return c.json({ error: 'トークンのプールの器が無い' as const }, 400);
        }
        const requested = c.req.valid('json').ids;
        // 閉じ込めで代入するので、`let` ではなく入れ物にする（型の絞り込みが `never` に倒れない）。
        const written: { detail?: string } = {};
        try {
          const result = await deps.tokens.removeUnreadable(requested, {
            // **日誌を先に書く。書けなければここで投げ、状態を変えずに `base.onError` へ抜ける。**
            // id と件数だけ（トークンの値は書かない）。
            beforeRemove: async (ids) => {
              await deps.stores.journal.append({
                type: 'decision',
                decision: `読めない認証トークンの行を ${String(ids.length)} 件消そうとしている（id: ${ids.join(', ')}）`,
                grounds:
                  `${describeActor(c.get('principal'))}（POST /tokens/unreadable/remove）。` +
                  '消すのは id で指した読めない行だけ。行の中身（トークンの値）は書かない。',
              });
              // 書けた後にだけ印を立てる（書けなかった回は「日誌が無い」＝打ち消す行も要らない）。
              written.detail = `ids=${ids.join(',')}`;
            },
          });
          if (result.kind === 'unknown') {
            return c.json(
              {
                error:
                  `指した id のうち ${String(result.count)} 件が、読めない行に無い` +
                  '（何も消していない。alteroid token list で読めない行の id を確かめる）',
              },
              404,
            );
          }
          // **ここから先は行を消した後である**（issue #2390）。失敗しても「消せなかった」
          // ではない。下の `catch`（打ち消しの日誌と 500）へ落とさず、消したと言って返す。
          // 原因は種類（`error.name`）だけを日誌に使う——メッセージには行の中身
          // （トークンの値）が載りうる。
          let cause: unknown;
          if (result.kind === 'removedViewFailed') {
            cause = result.cause;
          } else {
            try {
              return c.json(
                tokensUnreadableRemoveResponseSchema.parse({
                  ...result.view,
                  removedIds: result.ids,
                }),
              );
            } catch (parseError) {
              cause = parseError;
            }
          }
          const kindOfCause = cause instanceof Error ? cause.name : typeof cause;
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision: `読めない認証トークンの行を消した（id: ${result.ids.join(', ')}）が、表示の読み直しに失敗した`,
              grounds:
                `${describeActor(c.get('principal'))}（POST /tokens/unreadable/remove）。` +
                `行は消えている。読み直しの失敗の種類: ${kindOfCause}。` +
                '行の中身（トークンの値）は書かない。',
            },
            '読めない認証トークンの行の削除後の読み直しの失敗の日誌',
            `ids=${result.ids.join(',')}`,
          );
          return c.json(
            tokensUnreadableRemoveResponseSchema.parse({
              removedIds: result.ids,
              viewUnavailable: {
                reason:
                  '読めない行は消した。消した後のプールを読み直せなかった' +
                  '（alteroid token list で今の姿を確かめる）',
              },
            }),
          );
        } catch (error) {
          // 日誌が書けなかった（`beforeRemove` の中で投げた）回は、状態を変えていない。
          // そのまま投げ直して `base.onError` の 500 に任せる。
          const journaled = written.detail;
          if (journaled === undefined) throw error;
          // 日誌は書いたが消せなかった。打ち消しの行を足す（`PUT /credentials` と同じ形）。
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision: '読めない認証トークンの行を消せなかった',
              grounds:
                `${describeActor(c.get('principal'))}（POST /tokens/unreadable/remove、` +
                `状態の変更が失敗）。${journaled}`,
            },
            '読めない認証トークンの行の打ち消しの日誌',
            journaled,
          );
          // **error は種類（`name`）だけ渡す**（issue #2396）。生の error を渡すと、
          // `noteDroppedRecord` が `message` の1行目を stderr へ出し、エラー文に載った
          // トークンの値が出うる。
          noteDroppedRecord('読めない認証トークンの行の削除', journaled, kindOfError(error));
          return c.json({ error: 'トークンのプールを保存できなかった' as const }, 500);
        }
      },
    )

    /**
     * 回す契機・冷却の既定を変える。3つとも部分更新（省略した項目は現状維持）。
     *
     * **資格は `authenticate` だけ（`/tokens` と同じ強さ）。** `requireOperator` は
     * 付けない（2026-09-06 のオーナー決定）。
     */
    .put(
      '/tokens/policy',
      describeRoute({
        tags: ['tokens'],
        summary: '回す契機・冷却の既定を変える',
        description:
          '省略した項目は現状のまま変えない。変更は日誌に残る（issue #2742）。回す契機を有効にする・' +
          '変える・冷却を変える変更は**日誌を先に書き、書けなければ保存せず 500**。' +
          '`rotateOn: off` へ狭める変更は保存が先で、日誌が書けなくても保存する。',
        responses: {
          200: {
            description: '更新後の設定。',
            content: { 'application/json': { schema: resolver(tokenRotationSettingsSchema) } },
          },
          500: {
            description:
              '日誌が書けなかった（**保存していない**。広げる側の変更のとき）。本文は ' +
              '`{ error: "記録（日誌）が書けなかったので、変更していません", code: "journal_write_failed" }`。',
            content: { 'application/json': { schema: resolver(journalWriteFailedResponseSchema) } },
          },
          400: {
            description: 'トークンのプールの器が配線されていない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          403: {
            description:
              'alteroid を使う許可が無い（ログインしているが `access grant` されて' +
              'いない）。資格そのものが無い場合は 401。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(tokensPolicyUpdateRequestSchema, (where) => ({
        error: '設定の入力の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        if (deps.tokens === undefined) {
          return c.json({ error: 'トークンのプールの器が無い' as const }, 400);
        }
        // **能力の向きで日誌の順序を分ける**（issue #2742。決定 2026-10-05、teto＝takecchi の代理）。
        // - **回さない方向へ狭めるだけ**（変更後の `rotateOn` が `off`）→ 保存が先、日誌は後。
        //   「止める」を日誌の失敗で止めない。
        // - **それ以外の変更**（回す契機を有効にする・変える、冷却を変える）→ 日誌が先。書けなければ
        //   保存せずに 500。冷却の長短は判断が割れるので、安全側（広げる側）に倒した。
        // - 差分が無ければ日誌は書かない。
        const policyState: {
          changes: TokenPolicyChange[];
          widens: boolean;
          written: boolean;
          journalError?: { cause: unknown };
        } = { changes: [], widens: false, written: false };
        let settings: Awaited<ReturnType<TokenPoolService['setSettings']>>;
        try {
          settings = await deps.tokens.setSettings(c.req.valid('json'), {
            beforeWrite: async ({ before, after }) => {
              const classified = classifyTokenPolicyChange(before, after);
              policyState.changes = classified.changes;
              policyState.widens = classified.widens;
              if (!classified.widens) return;
              try {
                await deps.stores.journal.append({
                  type: 'decision',
                  decision: `トークンを回す設定を変えようとしている（${describeTokenPolicyChanges(classified.changes)}）`,
                  grounds:
                    `${describeActor(c.get('principal'))}（PUT /tokens/policy）。` +
                    '回す契機を有効にする・変える（または冷却を変える）操作なので、日誌を先に書いた。',
                });
              } catch (cause) {
                policyState.journalError = { cause };
                throw cause;
              }
              policyState.written = true;
            },
          });
        } catch (error) {
          if (policyState.journalError !== undefined) {
            noteDroppedRecord(
              'トークンを回す設定の変更の日誌（保存していない）',
              policyState.changes.map((change) => change.field).join(','),
              kindOfError(policyState.journalError.cause),
            );
            return c.json(journalWriteFailedBody(), 500);
          }
          if (policyState.written) {
            await appendJournalOrDrop(
              deps.stores,
              {
                type: 'decision',
                decision: 'トークンを回す設定を変えられなかった',
                grounds:
                  `${describeActor(c.get('principal'))}（PUT /tokens/policy、状態の変更が失敗）。` +
                  `先に書いた行の変更（${describeTokenPolicyChanges(policyState.changes)}）は保存されていない。`,
              },
              'トークンを回す設定の打ち消しの日誌',
              policyState.changes.map((change) => change.field).join(','),
            );
          }
          throw error;
        }
        if (!policyState.written && policyState.changes.length > 0) {
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision: `トークンを回す設定を変えた（${describeTokenPolicyChanges(policyState.changes)}）`,
              grounds:
                `${describeActor(c.get('principal'))}（PUT /tokens/policy）。` +
                '回さない方向（rotateOn: off）へ狭める変更なので、保存の後に書いた。',
            },
            'トークンを回す設定の変更の日誌',
            policyState.changes.map((change) => change.field).join(','),
          );
        }
        return c.json(tokenRotationSettingsSchema.parse(settings));
      },
    )

    // --- セッションログ（アーカイブ） --------------------------------------
    .get(
      '/archive',
      describeRoute({
        tags: ['archive'],
        summary: 'アーカイブ済みセッション生ログの一覧',
        description:
          'セッション生ログ（可観測性の最下段）の一覧（#698）。id だけでなく ' +
          'sessionId・時刻・実使用バイト数（storedBytes）を返す——大きさや時刻を ' +
          '知るために本文（GET /archive/:id）を全文落とす必要が無い。',
        responses: {
          200: {
            description: 'アーカイブの一覧。新しい順。',
            content: { 'application/json': { schema: resolver(archiveListResponseSchema) } },
          },
        },
      }),
      async (c) =>
        c.json(archiveListResponseSchema.parse({ entries: await stores.archive.list() })),
    )

    /**
     * `sessionId` ごとの集計（#698）。**`:id` より前に置くこと**——後ろだと
     * `GET /archive/:id` の `:id` に `sessions` という文字列が食われて、この
     * 経路へ一生届かない（hono のルーティングは登録順で最初に一致した経路
     * を使う）。
     */
    .get(
      '/archive/sessions',
      describeRoute({
        tags: ['archive'],
        summary: 'アーカイブ済みセッション生ログの sessionId ごとの集計',
        description:
          'sessionId ごとの行数（rows）・実使用バイト数の合計/最大・最初/最後の ' +
          '時刻（#698）。rows は tombstone 済みの行も数える——「同じセッションの ' +
          '生ログが何度も積まれている」という重複を見つけるための経路。',
        responses: {
          200: {
            description: 'sessionId ごとの集計の一覧。',
            content: { 'application/json': { schema: resolver(archiveSessionsResponseSchema) } },
          },
        },
      }),
      async (c) =>
        c.json(archiveSessionsResponseSchema.parse({ sessions: await stores.archive.sessions() })),
    )

    .get(
      '/archive/:id',
      describeRoute({
        tags: ['archive'],
        summary: 'アーカイブ済み生ログを1件読む',
        responses: {
          200: {
            description: '生ログ（JSONL の生テキスト）。',
            content: { 'text/plain': { schema: resolver(z.string()) } },
          },
          404: {
            description: '該当するアーカイブが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          410: {
            description:
              '本文は `DELETE /archive/:id` で消されている（#698）。行そのものは残る——' +
              'この id は `/archive` の一覧には引き続き出る。いつ・何バイト落としたかを返す。',
            content: { 'application/json': { schema: resolver(archiveRemovedResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const result = await stores.archive.read(c.req.param('id'));
        if (result.kind === 'missing') return c.json({ error: 'not found' as const }, 404);
        if (result.kind === 'removed') {
          return c.json(
            archiveRemovedResponseSchema.parse({
              error: 'removed',
              removedAt: result.removedAt,
              bytes: result.bytes,
            }),
            410,
          );
        }
        return c.text(result.body);
      },
    )

    /**
     * アーカイブ済み生ログの本文を1件消す（#698）。**`DELETE` という名前だが
     * 行は消えない**——本文だけを落とす tombstone である（`TranscriptArchive.remove`
     * の doc）。存在しない id を渡しても成功にはならない。
     *
     * **走行中のマネージャーの退避は消せない。** 判定は
     * `ManagerPool.runningManagerOwning()` 1箇所だけを通す——クローンの道具
     * `archive_remove`（`tools.ts`）と同じ関数である。2箇所に書くと片方だけ
     * 直る形になる（AGENTS.md「リポジトリの約束」の数え上げの持ち主を1か所に
     * する、と同じ理由）。
     */
    .delete(
      '/archive/:id',
      describeRoute({
        tags: ['archive'],
        summary: 'アーカイブ済み生ログの本文を消す（行は残る）',
        description:
          '本文だけを落とす（tombstone）。行そのものは消えない——`/archive` の一覧には' +
          '引き続き出る。存在しない id を渡しても成功にはならない。走行中のマネージャーの' +
          '退避は既定では消せない（拒む。どのマネージャーが走行中かを言う）。' +
          'クエリ引数 `overrideReason` にその理由を書けば通せる' +
          '（north_star 禁止2「方針は設定で開けられなければならない」の実装——' +
          '既定拒否は能力の一律な削除ではなく方針である）。override したときは' +
          '理由と対象のマネージャー id を日誌に残す。',
        responses: {
          200: {
            description: '消した（または前から消されていた）。',
            content: { 'application/json': { schema: resolver(archiveRemoveResponseSchema) } },
          },
          400: {
            description:
              'クエリ引数 `overrideReason` の形が不正（`queryParams` の hook が断る。' +
              'PR #1747 が揃えた形——送られた値は1文字も含めない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当するアーカイブが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '走行中のマネージャーの退避なので消せない。`overrideReason` クエリ引数で開ける。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      queryParams(archiveRemoveQuery),
      async (c) => {
        const id = c.req.param('id');
        const { overrideReason } = c.req.valid('query');
        const guard = guardArchiveRemoval(clone.managers, id, overrideReason);
        if (guard.kind === 'denied') {
          return c.json(
            {
              error:
                `走行中のマネージャー ${guard.managerId} の退避なので消せない` +
                '（overrideReason クエリ引数に理由を書けば通せる）',
            },
            409,
          );
        }
        const result = await stores.archive.remove(id);
        if (result.kind === 'missing') return c.json({ error: 'not found' as const }, 404);
        const overrideNote =
          guard.kind === 'allowed-with-override'
            ? `（⚠️ override — 走行中のマネージャー ${guard.managerId} の退避だったが、` +
              `理由「${guard.reason}」により消した）`
            : '';
        // **本文の削除はもう効いている**（Issue #2037）。日誌への追記だけが
        // 落ちても 500 を返さない——`appendJournalOrDrop` の doc。
        await appendJournalOrDrop(
          stores,
          {
            type: 'decision',
            decision:
              `退避済み生ログの本文を消した: ${id}（${result.bytes} バイト。${ARCHIVE_REMOVED_BYTES_UNIT_NOTE}。` +
              `${result.kind === 'already' ? '前から消されていた' : 'いま消した'}）` +
              overrideNote,
            grounds:
              guard.kind === 'allowed-with-override'
                ? `人間が API から直接操作した（override理由: ${guard.reason}）`
                : '人間が API から直接操作した',
          },
          'アーカイブ本文削除の日誌',
          `id=${id}`,
        );
        return c.json(
          archiveRemoveResponseSchema.parse({
            ok: true,
            id,
            bytes: result.bytes,
            alreadyRemoved: result.kind === 'already',
            ...(guard.kind === 'allowed-with-override'
              ? { override: { managerId: guard.managerId, reason: guard.reason } }
              : {}),
          }),
        );
      },
    )

    /**
     * 人間が、アーカイブ済み生ログを絞り込んでまとめて tombstone する
     * （issue #698）。**`POST /inbox/remove`（#972）と同じ設計を踏襲する。**
     * 既定（`dryRun` を省略すると true）・「絞り込みの無い呼びを断る」・
     * 塊ごとに「消す → 日誌へ書く」を交互に回す形、はすべて同じ。
     *
     * **対象の選定は `selectArchiveRemovalTargets`（純関数、`archive-prune.ts`）
     * に閉じる。** ここは絞り込みの拒否判定・墓標の保護・走行中の委譲の
     * スキップ・実際の `stores.archive.remove()` 呼び出しと日誌だけを持つ。
     *
     * **墓標（`TranscriptGrave`）を守る**（issue #698 追補3）。
     * `#pickUpTranscriptGrave`（`clone.ts`）が次の起動時にこの id から蒸留を
     * 拾い直す——本文を一括で落とすと、まだ記憶へ移せていない区間が永久に
     * 失われる。冗長に見える理由: `isNewest`（`selectArchiveRemovalTargets`
     * の安全弁）は「セッションの最新行」を守るだけで、「まだ蒸留していない
     * 区間」とは意味が違う——セッションが終わって最新行でなくなった後でも
     * 墓標だけは守り続ける必要があるので、`protectedIds` という別経路で
     * 独立に渡す。
     *
     * **走行中の委譲が抱えている行は、一括では開けない。** `guardArchiveRemoval`
     * を対象1件ずつに通し、`denied`（走行中）と `unknown`（`managers` が
     * 配線されていない場面）はどちらも安全側に倒して飛ばす
     * （`skipped.inUse`）。⛔ **`overrideReason` はこの一括の入力に無い**
     * ——一括で複数件を無条件に開ける形は事故の芽が大きい。開放が要るなら
     * 対象を1件ずつ名指しして既存の単発 `DELETE /archive/:id` の
     * `overrideReason` を使うこと。
     *
     * **この guard は `dryRun` の分岐より前で回す。** `guardArchiveRemoval`
     * はプロセス内の像を読むだけでネットワークを叩かないので下見でも安い
     * ——下見でも回さないと、下見が返す `targeted` / `skipped.inUse` が
     * 実行時と食い違う（下見が実行の予告にならない）。
     *
     * **guard の第4引数には `requireContainment ?? true`（`selectArchiveRemovalTargets`
     * へ渡すのと同じ実効値）を渡す（#698）。** 実効値が `true`（既定、または
     * 明示）のときだけ、走行中の委譲の保護を `archiveIds` の末尾1本へ狭める
     * ——対象はすでに「含有が証明済み」の行に絞られているので、古い写しまで
     * 保護し続ける必要が無い（`guardArchiveRemoval` の doc「なぜ安全か」）。
     * `requireContainment: false`（`sessionIds` を名指ししたときだけ開ける道）
     * のときは証明が無いので、狭めない——`runningManagerOwning` のまま全件
     * 保護する。
     *
     * **実行は `stores.archive.remove(id)` を1件ずつ。** 一括 UPDATE には
     * しない——`packages/storage-pg` / `packages/storage-fs` を1文字も
     * 変えていない理由と同じ（設計文書が「1行1トランザクション、
     * `WHERE removed_at IS NULL` で冪等、再開可能」と明記している）。
     *
     * **不変条件（歯で撃つこと。5欄で1行は必ず1回だけ数える）:**
     * ```
     * matched === targeted + remaining + (skipped.protected + skipped.alreadyRemoved
     *            + skipped.newest + skipped.notContained + skipped.inUse)
     * targeted === removedIds.length + raced        // dryRun:false のときのみ
     * ```
     * `targeted` は **guard を通った後の件数**（＝実際に消しにいく件数）で
     * あって `selectArchiveRemovalTargets` が選んだ件数ではない——guard で
     * 飛ばした行を `targeted` にも `skipped.inUse` にも数えると2回数える
     * ことになり、上の等式が壊れる。`removedIds` も guard を通った後の
     * ものだけ。`raced` は「guard までは通ったが、実際に `remove()` する
     * までの間に他経路が先に消していた」行（`result.kind` が `'missing'` か `'already'`）
     * ——0件でも欄を省かない。
     *
     * **`limit` は guard より前に効く。** `selectArchiveRemovalTargets` が
     * `limit` を適用した後の集合に対して guard を回すので、guard で
     * 飛ばした行も `limit` の枠を1つ使い切っている。⟹ `targeted` が
     * `limit` に届いていないのに `remaining` が残っていることがあるが、
     * それはバグではない（guard で減った分がそのまま `targeted` から
     * 抜けただけ）。
     */
    .post(
      '/archive/remove',
      describeRoute({
        tags: ['archive'],
        summary: 'アーカイブ済み生ログを絞り込んでまとめて tombstone する',
        description:
          'クローン専用の口（クローンの道具 `archive_remove_many` と同じ関数。' +
          'CLI・Web UI には出さない）。アーカイブ済み生ログの本文を絞り込んで' +
          'まとめて消す（issue #698）。**既定は試算（`dryRun` を省略すると true）で、1件も' +
          '消さない。** `sessionIds` / `before` / `minStoredBytes` のどれも' +
          '渡さない呼びは断る——絞り込みが無いのと同じで、1回でアーカイブを' +
          '空にできてしまう。走行中のマネージャーの退避（`skipped.inUse`）と' +
          'セッションの最新行（`skipped.newest`）は一括では開けない——開放が' +
          '要るなら対象を1件ずつ名指しして `DELETE /archive/:id` の' +
          '`overrideReason` を使うこと。含有が証明できない行' +
          '（`skipped.notContained`）は `requireContainment: false` を明示' +
          'しない限り既定で守る。まだ記憶へ蒸留していない区間の墓標は' +
          '`requireContainment` に関わらず常に守る（`skipped.protected`）。' +
          '本文だけを落とす（tombstone）——行そのものは消えない。' +
          '**下見（既定）でも走行中の委譲の判定は評価する**——`targeted` /' +
          '`skipped.inUse` は下見と実行で同じ値になる。下見が返さない実行だけの' +
          '事実は `removedBytes`（下見は常に0）と `raced`（下見は常に0。' +
          '`remove()` 自体を呼ばないので測れない）だけである。' +
          '**実行時の `raced` は、選定と走行中チェックを通った行が、実際に' +
          'tombstone する瞬間には他経路（別の一括呼び出し・自動の畳み・' +
          '単発の `DELETE /archive/:id` など）にすでに tombstone されて' +
          'いた件数である。** この行はこの呼びが消したことにしない——' +
          '`removedIds` にも `removedBytes` にも日誌にも載らず、`raced` だけで' +
          '数える。',
        responses: {
          200: {
            description: '試算、または実際に消した結果。',
            content: {
              'application/json': { schema: resolver(archiveRemoveManyResponseSchema) },
            },
          },
          400: {
            description:
              '絞り込みが1つも無い、`before` が ISO8601 として読めない、`limit` が' +
              `${ARCHIVE_REMOVE_MANY_LIMIT_MAX} を超える、または requireContainment: ` +
              'false なのに sessionIds が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(archiveRemoveManyRequestSchema),
      async (c) => {
        const { sessionIds, before, minStoredBytes, requireContainment, dryRun, limit, reason } =
          c.req.valid('json');

        // 🔴 絞り込みの無い呼びを断る（`POST /inbox/remove` と同じ判定・同じ理由）。
        if (sessionIds === undefined && before === undefined && minStoredBytes === undefined) {
          return c.json(
            {
              error:
                'sessionIds / before / minStoredBytes のどれも渡さない呼びは断る' +
                '——それは絞り込みが無いのと同じで、1回でアーカイブを空にできて' +
                'しまう。**1件も消していない。**',
            },
            400,
          );
        }
        if (before !== undefined && !isOffsetQualifiedTimeBoundary(before)) {
          // 存在しない日付・日付でない文字列を別の時刻として読んで消さない（#3358。#3287 と同じ3段）。
          // さらに、時差の無い時刻をデーモンの地方時刻として読んで消さない（#3390。道具 `inbox_remove_many` と
          // 同じ門・同じ文言。元に戻せない一括削除なので時差を必須にする——#2462）。
          return c.json(
            {
              error:
                describeOffsetRequiredTimeBoundary('before', before, '2026-10-06T09:00:00+09:00') +
                '**1件も消していない。**',
            },
            400,
          );
        }
        if (limit !== undefined && limit > ARCHIVE_REMOVE_MANY_LIMIT_MAX) {
          return c.json(
            {
              error: `limit は ${ARCHIVE_REMOVE_MANY_LIMIT_MAX} 件までである。**1件も消していない。**`,
            },
            400,
          );
        }
        if (requireContainment === false && sessionIds === undefined) {
          return c.json(
            {
              error:
                'requireContainment: false は sessionIds を名指ししたときだけ渡せる' +
                '——含有の証明を外した状態で全セッションを対象にすると、事故で' +
                '内容が失われる範囲が際限なく広がる。**1件も消していない。**',
            },
            400,
          );
        }

        // **墓標を守る**（issue #698 追補3。上の doc「なぜ冗長に見えるか」）。
        const grave = await stores.sessions.getTranscriptGrave();
        const protectedIds = grave === null ? [] : [grave.archiveId];

        const filter: ArchiveRemoveManyFilter = {
          ...(sessionIds === undefined ? {} : { sessionIds }),
          ...(before === undefined ? {} : { before }),
          ...(minStoredBytes === undefined ? {} : { minStoredBytes }),
        };
        // **絞りと選定は `selectArchiveRemovalTargets` に閉じる**——SQL 側に
        // 同じ判定を複製しない（`matchesArchiveRemoveManyFilter` の doc）。
        const allRows = await stores.archive.list();
        const selection = selectArchiveRemovalTargets(allRows, filter, {
          requireContainment,
          limit: limit ?? ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
          protectedIds,
        });

        // **走行中の委譲が抱えている行は一括では開けない**（上の doc）。
        // `denied` / `unknown` はどちらも安全側に倒して飛ばす。
        //
        // ⚠️ **この guard ループは dryRun 分岐より前で回す**（#698 欠陥2の
        // 修正）。`guardArchiveRemoval` は `ManagerPool` のプロセス内の像
        // （`this.#records`）を読むだけでネットワークを叩かない
        // （`grep -Fn -- 'プロセス内の像' packages/core/src/manager.ts`）ので、
        // dry run で回しても安い。ここを dryRun 分岐より後ろに置くと、
        // 下見が「guard で減る前」の数（`selection.targets.length`）を、
        // 実行が「guard で減った後」の数を返すことになり、同じ条件で
        // 下見→実行と打っても `targeted` / `skipped.inUse` が食い違う
        // ——下見が「実行の予告」にならなくなる。この口は「下見を既定にして、
        // 見てから押す」ことが設計の中心なので、これは致命的である。
        //
        // **第4引数には `selectArchiveRemovalTargets` へ渡したのと同じ実効値
        // （`requireContainment ?? true`）を渡す（#698）。** `selection.targets`
        // が「含有が証明済み」の行だけになっているのは、まさにこの実効値が
        // `true` のときだけである——`false`（`sessionIds` を名指ししたときだけ
        // 開ける道。上の入力検証）なら証明が無いので、ここでも狭めてはいけない
        // （`guardArchiveRemoval` の doc「なぜ安全か」）。値をそのまま転送する
        // ことで、選定側の実効値と guard 側の狭め判定が常に同じ条件で揃う。
        const effectiveRequireContainment = requireContainment ?? true;
        const removableTargets: ArchiveEntry[] = [];
        let skippedInUse = 0;
        for (const target of selection.targets) {
          const guard = guardArchiveRemoval(
            clone.managers,
            target.id,
            undefined,
            effectiveRequireContainment,
          );
          if (guard.kind === 'denied' || guard.kind === 'unknown') {
            skippedInUse += 1;
            continue;
          }
          removableTargets.push(target);
        }

        // **`targeted` は guard を通った後の件数**（＝実際に消しにいく件数）
        // にする（#698 欠陥1の修正）。`selection.targets.length`（guard 前）
        // のままだと、guard で飛ばした行が `targeted` と `skipped.inUse` の
        // 両方に数えられ、`matched === targeted + remaining + skipped5欄の
        // 総和` が破れる（1行を2回数える）。`removedIds` も guard を
        // 通った後のものだけを載せる——この2つの帳尻は下で
        // `targeted === removedIds.length + raced` としても撃つ。
        //
        // **`limit` は guard より前に効く**——`selection`（`limit` を適用
        // 済み）に対して guard を回しているので、guard で飛ばした行も
        // `limit` の枠を1つ使ったことになる。⟹ 「`targeted` が `limit` に
        // 届いていないのに `remaining` が残っている」は起こりうる——それは
        // バグではなく、guard で減った分がそのまま `targeted` から抜けた
        // だけである。
        const targeted = removableTargets.length;

        if (dryRun !== false) {
          return c.json(
            archiveRemoveManyResponseSchema.parse({
              ok: true,
              dryRun: true,
              totalRows: selection.totalRows,
              matched: selection.matched,
              targeted,
              // 下見の `removedIds` は「これから消す id」（guard 通過後）。
              removedIds: removableTargets.map((row) => row.id),
              removedBytes: 0,
              remaining: selection.remaining,
              skipped: { ...selection.skipped, inUse: skippedInUse },
              // **dryRun は `remove()` を呼ばないので raced は測れない**
              // ——値そのものは作るが（欄を省くと「測っていない」と区別が
              // つかなくなる）、常に0であることの理由はここに書く。
              raced: 0,
            }),
          );
        }

        // 塊ごとに「消す → その塊の id を日誌へ書く」を交互に回す
        // （`POST /inbox/remove` と同じ理由——まとめて消してから日誌を書くと、
        // その間にデーモンが落ちたとき「消えたのに記録が無い行」ができる）。
        // 実行は `stores.archive.remove(id)` を1件ずつ（上の doc「一括
        // UPDATE にしない」）。
        const chunks = chunkIdsByChars(
          removableTargets.map((row) => row.id),
          ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
        );
        const removedIds: string[] = [];
        let removedBytes = 0;
        let raced = 0;
        for (const [index, chunk] of chunks.entries()) {
          const chunkIds = new Set(chunk);
          const chunkTargets = removableTargets.filter((row) => chunkIds.has(row.id));
          const removedThisChunk: string[] = [];
          for (const target of chunkTargets) {
            const result = await stores.archive.remove(target.id);
            if (result.kind === 'missing' || result.kind === 'already') {
              // **`already` も同じ競合である。** `remove()` は行を消さずに本文だけを墓標にするので、
              // 他経路が先に消していた回は `missing` ではなく `already` を返すのが普通である。
              // 選定の時点で既に消えていた行は選定から外してある（`skipped.alreadyRemoved`）ので、
              // ここで `already` が返るのは、選んだ後に他経路が消した回だけ——この呼びが消した
              // ことにしない（応答・日誌に、触っていない id を載せない）。
              // list() で見つかり guard も通ったのに、実際に remove() する
              // までの間に他経路が先に消していた（#698 欠陥3）。`targeted`
              // には数えているのでここで黙って `continue` すると
              // `removedIds` にも `skipped` にも現れない行ができ、
              // `targeted === removedIds.length + raced` が破れる——
              // 隠さず `raced` へ数える（受信箱側の「raced を隠さない」
              // 作法と同じ）。
              raced += 1;
              continue;
            }
            removedThisChunk.push(target.id);
            removedBytes += result.bytes;
          }
          removedIds.push(...removedThisChunk);
          if (removedThisChunk.length === 0) continue;
          const filterText = [
            ...(sessionIds === undefined ? [] : [`sessionIds=[${sessionIds.join(', ')}]`]),
            ...(before === undefined ? [] : [`before=${before}`]),
            ...(minStoredBytes === undefined ? [] : [`minStoredBytes=${minStoredBytes}`]),
          ].join(' / ');
          // **この塊の本文はもう消えている**（Issue #2037）。この塊の日誌が
          // 落ちても、残りの塊は消すのを続ける——途中で 500 を返して抜けると、
          // 残りの塊が消されないまま応答も返らず、この呼びが何件消したかが
          // 分からなくなる。跡は `appendJournalOrDrop` が stderr へ残す。
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision:
                '人間がアーカイブ済み生ログの本文を絞り込みで一括して tombstone した' +
                `（${index + 1}/${chunks.length} 塊目、この塊は ${removedThisChunk.length} 件）: ${reason}\n` +
                `絞り込み: ${filterText}\n` +
                `消した id: ${removedThisChunk.join(' ')}`,
              grounds: '人間が直接 API から操作した',
            },
            'アーカイブ一括 tombstone の日誌',
            `chunk=${index + 1}/${chunks.length} count=${removedThisChunk.length}`,
          );
        }

        return c.json(
          archiveRemoveManyResponseSchema.parse({
            ok: true,
            dryRun: false,
            totalRows: selection.totalRows,
            matched: selection.matched,
            targeted,
            removedIds,
            removedBytes,
            remaining: selection.remaining,
            skipped: { ...selection.skipped, inUse: skippedInUse },
            raced,
          }),
        );
      },
    )

    // --- 受信箱（/inbox） ---------------------------------------------------
    // issue #972: 同じ失敗の写しが数千件積もると、クローン側は `remove()` の
    // 1ターン1件のペースでしか排出できず、排出そのものが文脈窓を食い潰す。
    // 唯一の既存手段は `POST /reset`（記憶ごと全部消す）で、それでは使えない
    // （#972 本文）。ここは人間の入口として、絞り込みでまとめて消す口を持つ
    // （#972 提案4）。絞り込みの判定（`matchesInboxRemoveManyFilter`）は
    // SQL 側に複製しない——`inboxBacklogDedupeKey` の doc「なぜ1箇所に閉じる
    // か」と同じ理由。
    //
    // ⚠️ **クローン自身の道具（`inbox_remove_many`）はまだ無い。** #972 本文が
    // 「クローン自身の道具にするかは別途の判断（自分の受信箱を自分で捨てられ
    // ることの是非があるため、まずは人間の手で足りる）」と保留していたところへ
    // 依頼のブリーフが誤って必須スコープに書いてしまい、いったん取り下げた。
    // 人間起点の合図（`human_message` / `human_answer`）を選べない形にする案を
    // 別 PR（draft・`[保留]`）で提案中——ここへ道具を足す実装者は、その PR の
    // 判断（takecchi）を待つこと。

    /**
     * 人間が、受信箱の未読を絞り込んでまとめて消す。
     *
     * **`commitment_close_many`（#844）と同じ設計を踏襲する。** 既定・絞り
     * 込みの軸・「全部消すを1回で撃てる形は作らない」制約——事故で受信箱を
     * 1回で空にできる形を作らない。
     *
     * **資格は `authenticate` だけ（`requireOperator` は付けない）。**
     * `POST /commitments/:id/close` `DELETE /archive/:id` と同じ強さ——
     * これらも台帳・退避の中身を操作するが `requireOperator` を要求していない。
     * `/profile` は鍵そのものを扱うが、2026-10-05 の #2862 のオーナー決定で
     * 許可済みなら通る。`requireOperator` を持つのはいま owner 宣言の口だけである。
     */
    .post(
      '/inbox/remove',
      describeRoute({
        tags: ['inbox'],
        summary: '受信箱の未読を、絞り込みを渡してまとめて畳む（消す）',
        description:
          '人間の入口から、受信箱の未読を絞り込んでまとめて消す（issue #972）。' +
          '同じ失敗の写しが数千件積もると、クローン側は1ターン1件のペースでしか' +
          '排出できず、排出それ自体が文脈窓を食い潰す——人間はこの口から直接' +
          'まとめて消せる。**既定は試算（`dryRun` を省略すると true）で、1件も' +
          '消さない。** ' +
          `\`types\` は必須で、在る7種類（${INBOX_EVENT_TYPE_ORDER.join(' / ')}）を` +
          '全部並べた呼びは断る（「全部消す」を1回で撃てる形は作らない——それは' +
          '`POST /reset`（記憶ごと全部消す）の役目である）。行は台帳の close とは' +
          '違い**物理的に消える**——`InboxStore` は「まだ処理し終えていない」という' +
          '事実だけを持つ器で、片付いた後の記録を残す場所ではない。' +
          '**消した id は全部日誌に残る。**',
        responses: {
          200: {
            description: '試算、または実際に消した結果。',
            content: { 'application/json': { schema: resolver(inboxRemoveManyResponseSchema) } },
          },
          400: {
            description:
              '本文が不正、または `types` が在る7種類を全部並べている（絞り込みが無いのと同じ）、' +
              'または `before` が ISO8601 として読めない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(inboxRemoveManyRequestSchema),
      async (c) => {
        const { types, sources, before, reason, dryRun, limit } = c.req.valid('json');

        // 🔴 絞り込みの無い呼びを断る（`commitment_close_many` と同じ判定・同じ理由）。
        if (INBOX_EVENT_TYPE_ORDER.every((known) => types.includes(known))) {
          return c.json(
            {
              error:
                `types に在る7種類（${INBOX_EVENT_TYPE_ORDER.join(', ')}）を全部並べた呼びは` +
                '断る——それは絞り込みが無いのと同じで、1回で受信箱を空にできてしまう。' +
                '消したい種類だけを名指しすること（例 types: ["manager_message"]）。' +
                '**1件も消していない。**',
            },
            400,
          );
        }
        if (before !== undefined && !isOffsetQualifiedTimeBoundary(before)) {
          // 存在しない日付・日付でない文字列を別の時刻として読んで消さない（#3358。#3287 と同じ3段）。
          // さらに、時差の無い時刻をデーモンの地方時刻として読んで消さない（#3390。道具 `inbox_remove_many` と
          // 同じ門・同じ文言。元に戻せない一括削除なので時差を必須にする——#2462）。
          return c.json(
            {
              error:
                describeOffsetRequiredTimeBoundary('before', before, '2026-10-06T09:00:00+09:00') +
                '**1件も消していない。**',
            },
            400,
          );
        }
        if (limit !== undefined && limit > REMOVE_MANY_LIMIT_MAX) {
          return c.json(
            { error: `limit は ${REMOVE_MANY_LIMIT_MAX} 件までである。**1件も消していない。**` },
            400,
          );
        }

        const filter: InboxRemoveManyFilter = {
          types,
          ...(sources === undefined ? {} : { sources }),
          ...(before === undefined ? {} : { before }),
        };
        // **絞りはここで当てる**（`matchesInboxRemoveManyFilter` の doc——
        // SQL 側に同じ判定を複製しない）。`peekPending()` は古い順で返すので、
        // filter は順序を変えず、matched もそのまま古い順になる。
        const allPending = (await stores.inbox.peekPending()).entries;
        const matched = allPending.filter((row) => matchesInboxRemoveManyFilter(row, filter));

        const effectiveLimit = limit ?? REMOVE_MANY_LIMIT_DEFAULT;
        // 古い側から消す（`peekPending()` の契約「古い順」をそのまま使う）。
        const targets = matched.slice(0, effectiveLimit);
        const remaining = matched.length - targets.length;

        if (dryRun !== false) {
          return c.json(
            inboxRemoveManyResponseSchema.parse({
              ok: true,
              dryRun: true,
              totalPending: allPending.length,
              matched: matched.length,
              targeted: targets.length,
              removedIds: targets.map((row) => row.event.id),
              // **試算では常に 0**（1件も消していない。schema の doc）。
              droppedFromDelivery: 0,
              remaining,
            }),
          );
        }

        // 塊ごとに「消す → その塊の id を日誌へ書く」を交互に回す
        // （`commitment_close_many` と同じ理由——
        // まとめて消してから日誌を書くと、その間にデーモンが落ちたとき
        // 「消えたのに記録が無い行」が最大 `REMOVE_MANY_LIMIT_DEFAULT` 件できる）。
        const chunks = chunkIdsByChars(
          targets.map((row) => row.event.id),
          REMOVE_MANY_JOURNAL_ID_CHARS,
        );
        const removedIds: string[] = [];
        let droppedFromDelivery = 0;
        for (const [index, chunk] of chunks.entries()) {
          // **器から消すのと配達を止めるのを、1つの呼びで行う**（issue #1049）。
          // `stores.inbox.removeMany` を直に呼ばないこと——クローンの道具
          // （`inbox_remove_many`）と同じ関数を通す。**2箇所に割れたまま残すと、
          // 片方だけ直っている形が再生産される**（それがまさに #1049 だった。
          // `removeInboxEventsAndStopDelivery` の doc）。
          const outcome = await removeInboxEventsAndStopDelivery(stores.inbox, clone, chunk);
          const removed = outcome.removedIds;
          droppedFromDelivery += outcome.droppedFromDelivery;
          removedIds.push(...removed);
          if (removed.length === 0) continue;
          const filterText = [
            `types=[${types.join(', ')}]`,
            ...(sources === undefined ? [] : [`sources=[${sources.join(', ')}]（完全一致）`]),
            ...(before === undefined ? [] : [`before=${before}`]),
          ].join(' / ');
          // **この塊を消すことはもう効いている**（配達も止めた。Issue #2037）。
          // 日誌への追記だけが落ちても 500 を返さない——`appendJournalOrDrop`
          // の doc。他の塊の処理も止めない（この塊が消えた事実は変わらない）。
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision:
                `人間が受信箱の未読を絞り込みで一括して畳んだ（消した）` +
                `（${index + 1}/${chunks.length} 塊目、この塊は ${removed.length} 件）: ${reason}\n` +
                `絞り込み: ${filterText}\n` +
                `消した id: ${removed.join(' ')}`,
              grounds: '人間が直接 API から操作した',
            },
            '受信箱一括削除の日誌',
            `chunk=${index + 1}/${chunks.length} removed=${removed.length}`,
          );
        }

        return c.json(
          inboxRemoveManyResponseSchema.parse({
            ok: true,
            dryRun: false,
            totalPending: allPending.length,
            matched: matched.length,
            targeted: targets.length,
            removedIds,
            droppedFromDelivery,
            remaining,
          }),
        );
      },
    )

    /**
     * 受信箱の滞留の**内訳**を、器の外（HTTP）から読む（issue #783 段0の
     * 最後の欠落）。
     *
     * ## #783 が名指しした欠落そのもの
     *
     * `summarizeInboxBacklog` の内訳は、これまでクローンの道具
     * `manager_list` の中にしか出ていなかった（`tools.ts` の
     * `describeInboxBacklog`）。人間の入口はここまで `POST /inbox/remove`
     * （絞り込んで**畳む**＝消す）しか持たず、内訳を*読む*口が1本も無かった
     * ——人間が内訳を知りたければ、クローンのターンを1本使わせて
     * `manager_list` を呼ばせるほかなかった（#783 本文 1-1 の表「HTTP 0本 /
     * openapi 0本 / CLI 0本」）。
     *
     * ## `claimPending()` ではなく `peekPending()` を使う
     *
     * `claimPending()` は呼ぶだけで残っている未読の**全行**の `deliveries`
     * （器の入れ替え回数）を1つ進める（`InboxStore.claimPending` の doc）。
     * **ただ読むだけのこの口がその副作用を持ってはならない**——読むたびに
     * 「器が入れ替わった」という嘘の回数が増える。`peekPending()` は同じ行を
     * 配達回数を進めずに返す、そのためだけに在る読み取り専用の口
     * （`InboxStore.peekPending` の doc）。
     *
     * ## 集計はここでは複製しない
     *
     * `summarizeInboxBacklog`（`@alteroid/core`）をそのまま呼ぶ。クローンの
     * `manager_list` と人間のこの口が別々の集計を持つと、いつか2つの数が
     * 食い違う——`inboxBacklogDedupeKey` の doc「なぜ1箇所に閉じるか」が
     * 名指しした #783 の症状の形そのものを、この口自身が再現することになる。
     *
     * ## 上限（bySource の上位5件）は新しく足していない
     *
     * `bySource`（送信元別の内訳）は任意の文字列をキーに持つので、無制限に
     * 育ちうる——`summarizeInboxBacklog` が既に上位5件で打ち切り、溢れた分は
     * `bySourceOverflowKinds` / `bySourceOverflowCount` として0件でも必ず返す
     * （`InboxBacklogBreakdown` の doc）。**ここで新しい上限は足していない**
     * ——`manager_list` と同じ関数を通す以上、同じ上限を自動的に継承する。
     *
     * ## 資格は `authenticate` だけ（`requireOperator` は付けない）
     *
     * `POST /inbox/remove` と同じ強さ——返すのは集計値だけで、本文の全文は
     * 1文字も載らない（`describeInboxBacklogBreakdown` は集計値しか描かない、
     * その doc）。
     *
     * ## 0件のときに値を作らない
     *
     * `summarizeInboxBacklog` 自身が「0件のときに値を作らない」作法
     * （`InboxStore.pending` と同じ）を既に守っている——`oldestAt` は1件も
     * 無ければ持たない、`byType` / `bySource` / `ageBuckets` は件数0の行を
     * 載せない。ここでは何も足していない。
     */
    .get(
      '/inbox',
      describeRoute({
        tags: ['inbox'],
        summary: '受信箱の滞留の内訳を読む',
        description:
          'クローンの道具 `manager_list` の中にしか出ていなかった内訳' +
          '（`summarizeInboxBacklog` の結果）を、人間の入口（HTTP）から読む' +
          '（issue #783 段0）。`claimPending()` ではなく `peekPending()` を使うので、' +
          '呼んでも `deliveries`（器の入れ替え回数）は1つも進まない。集計は' +
          '`@alteroid/core` の同じ関数を通すので、クローンの道具と違う数を返すことは無い。',
        responses: {
          200: {
            description:
              '受信箱の内訳。0件のときは `oldestAt` 等、実際には取れていない欄を省く' +
              '（値を作らない。`InboxStore.pending` と同じ作法）。読めない行が1件でも在るときだけ' +
              '`unreadable`（id・受信時刻・不正な欄名。本文は載せない）が載る。`total` は読めた行の数で、' +
              '読めない行は入っていない。**`total: 0` で `unreadable` が無いときだけ「未処理の合図は無い」。**',
            content: { 'application/json': { schema: resolver(inboxBacklogResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const peek = await stores.inbox.peekPending();
        return c.json(
          inboxBacklogResponseSchema.parse(
            summarizeInboxBacklog(peek.entries, Date.now(), peek.unreadable),
          ),
        );
      },
    )

    // --- 握り潰しの跡（/dropped） ------------------------------------------
    // #242 の HTTP 面。PRD「入口の等価性」（docs/PRD.md）——この跡を読む口が
    // MCP の `self_dropped`（`tools.ts`）にしか無かった。

    /**
     * クローンが記録・読み出しをしそこねた跡（`noteDroppedRecord` 等が
     * stderr へ残す行）を、器の外（Web/CLI/HTTP）から読み戻す。
     *
     * **資格は `authenticate` だけ（`requireOperator` は付けない）。** 理由は
     * `/journal` `/managers` `/conversations` `/tokens` `/access/*` と同じ強さに
     * してあることで、**`/profile`（`requireOwner`。2026-10-05 以降は許可済みなら通る）**
     * とは違う扱いにしている。（`/tokens` `/access/*` は 2026-09-06 のオーナー
     * 決定——alteroid を使う許可を実行環境の持ち主と同格にする——より前は
     * `requireOperator` 側にいたが、いまはここと同じ側である。）この跡は本文を
     * 1文字も含まない設計（`dropped-record.ts` 冒頭 doc「本文は出さない」/
     * #52）で、持ち主の系そのものの診断であって、`/profile` のように鍵を
     * まるごと扱う操作ではない——`access grant` を通しただけのアカウントに
     * も開いてよい強さである。
     *
     * **`limit` のクエリ引数は無い。帳面自体が `RECENT_TRACE_LIMIT`
     * （200件）で上限を持つので、HTTP の口はいつも全件を返す。** これは
     * 意図である——`.claude/skills/listing-and-detail/SKILL.md` の逐語:
     * 「HTTP の口（`GET /commitments` / `GET /usage` / `GET /reports/:date` /
     * `GET /archive`）は上限を持たない。これは意図である — 人間はブラウザで
     * 扱えるので、ここを締めると人間側の能力が落ちる。エージェントへ返す口
     * と混ぜて数えないこと」。**「予算が無い」のではない** ——
     * エージェント向けの `self_dropped`（MCP）だけが `limit` と文字数予算を
     * 持ち、この口は持たない、という設計上の非対称である。
     *
     * **供給元は1本。** デーモンとクローンは同一プロセスで動く
     * （`apps/daemon/src/index.ts` の `createClone(...)` と
     * `createApp({ clone, ... })`、`serve({ fetch: app.fetch, ... })` が
     * 同じ関数スコープ）ので、`recentDroppedTraces()` はクローンの
     * `self_dropped` が読むのと同じ帳面である。runner はここには出ない
     * （別プロセス。`dropped-record.ts` の `DroppedTraceOrigin` の doc）。
     *
     * **跡が0件でも 200 を返す。** 「握り潰しが1件も無かった」わけではない
     * ——プロセスの生存中だけの記憶で、再起動・デプロイの入れ替えで消える
     * （`describeDroppedTraceEmpty` の doc）。404 やエラーにしない。
     */
    .get(
      '/dropped',
      describeRoute({
        tags: ['dropped'],
        summary: '握り潰しの跡を読む',
        description:
          'デーモンのプロセス（クローンを含む）が残した跡だけを返す。別プロセスの ' +
          'runner が残した跡はここには出ない。跡が0件でも 200 を返す — 0件は ' +
          '「握り潰しが1件も無かった」ことを意味しない（プロセスの生存中だけの ' +
          '記憶で、再起動・デプロイの入れ替えで消える）。`limit` のクエリ引数は ' +
          '無い（帳面自体が `limit` 件で上限を持つので、常に全件を返す）。',
        responses: {
          200: {
            description: '帳面の全件（古い順、末尾が最新）。',
            content: { 'application/json': { schema: resolver(droppedResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const traces = recentDroppedTraces();
        return c.json(
          droppedResponseSchema.parse({
            origin: 'daemon',
            since: droppedTraceLedgerSince(),
            limit: RECENT_TRACE_LIMIT,
            total: traces.length,
            traces,
          }),
        );
      },
    )

    // --- 作業の進捗（/progress） ---------------------------------------------
    // #2241 の 2。台帳と委譲の行を数え直した集計（core の `summarizeProgress`）を
    // 人間の手から読む口。**読むだけで日誌は書かない。**

    /**
     * 積み上がり・実施中・片付いた速度・見込みを、台帳と委譲の行から数え直して返す。
     *
     * **資格は `authenticate` だけ。** 返すのは
     * 集計値だけで、行の本文も鍵も含まない。
     *
     * **入力は `GET /commitments` と揃える。** 台帳は `list({ includeClosed: true })`
     * の各行に `respondedAt` / `activeManagerIds` を足したもの（足し方は
     * `buildCommitmentDerivations` を `/commitments` と共有）、委譲は
     * `stores.jobs.listJobs()`。`unreadable` / `trimmedClosed` はストアが返したまま
     * core へ渡す（取れない行を 0 に丸めない）。
     *
     * **`windowHours` の不正は 400。** 数値化はここでしか起きない罠（`Number('')` は
     * 0）を持つので、空文字は core へ渡す前に弾く。それ以外の非数・0以下・
     * 非有限は core の `RangeError` を 400 にする。エラー文言に送られてきた値は
     * 混ぜない（`whereValidationFailed` の不変条件と同じ）。
     *
     * **`github` は観測の記録を返すだけ。** デーモンは GitHub を見に行かない
     * （`packages/core/src/schema.ts` の「デーモンは PR もブランチも見に行かない」）。`POST
     * /github-observations` が日誌へ置いた記録を repo ごとに組む。記録が無ければ `not_observed`。
     */
    .get(
      '/progress',
      describeRoute({
        tags: ['progress'],
        summary: '作業の進捗（積み上がり・実施中・片付いた速度・見込み）',
        description:
          '台帳（引き受けた仕事）と委譲の行を数え直した集計。`windowHours`（既定 ' +
          `${DEFAULT_PROGRESS_WINDOW_HOURS}）は速度と見込みを数える窓の長さ（時間、有限の正数）。` +
          '**率（%）は出さない**（台帳に総量が無く、分母が定まらない）。' +
          '`backlog.completeness` が 0 でなければ数は欠けうる。取れないものは 0 にせず ' +
          '`null` か `state` で言う（`forecast.state` が `unavailable` のとき数は作らない）。' +
          '`github` は観測の記録（`POST /github-observations`）を返すだけで、デーモンは GitHub を見に行かない。' +
          '記録が無ければ `not_observed`（0 件ではない）。' +
          '中身の定義は `packages/core/src/progress.ts` の冒頭 doc を参照。',
        responses: {
          200: {
            description: '進捗の集計。',
            content: { 'application/json': { schema: resolver(progressResponseSchema) } },
          },
          400: {
            description: '`windowHours` が有限の正数でない（空文字・非数・0以下・非有限）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      queryParams(progressQuery),
      async (c) => {
        const { windowHours: rawWindowHours } = c.req.valid('query');
        // 「渡されなかった」と「空文字が渡された」を分ける。`Number('')` は 0 だが、
        // 空文字を 0 と読んで core の窓の検査に任せると、意図の読めない 400 になる。
        let windowHours = DEFAULT_PROGRESS_WINDOW_HOURS;
        if (rawWindowHours !== undefined) {
          if (rawWindowHours.trim() === '') {
            return c.json({ error: PROGRESS_WINDOW_HOURS_INVALID_MESSAGE }, 400);
          }
          windowHours = Number(rawWindowHours);
        }

        let view: Awaited<ReturnType<typeof readProgress>>;
        try {
          view = await readProgress(stores, { now: new Date(), windowHours });
        } catch (error) {
          // `windowHours` の検査だけを 400 にする（ストアの `RangeError` は握らない）。
          if (error instanceof InvalidProgressWindowError) {
            return c.json({ error: PROGRESS_WINDOW_HOURS_INVALID_MESSAGE }, 400);
          }
          throw error;
        }

        return c.json(progressResponseSchema.parse(view));
      },
    )

    /**
     * 観測した側（クローン・マネージャー・人間）が数えた GitHub の数を、日誌へ置く（#2245 段1）。
     *
     * **デーモンは GitHub を見に行かない**（`packages/core/src/schema.ts` の「デーモンは PR も
     * ブランチも見に行かない」）。この口は申告を受けて残すだけで、値は確かめない——`observedBy`
     * を必須にし、`GET /progress` の `github` が「誰の観測か」を必ず返す。いつ・誰が観測するかも
     * ここでは決めない（対応表を持った瞬間に自動化ジョブに戻る）。
     *
     * **状態を変える口なので、日誌が状態そのものである。** 日誌（`github_observation`）へ追記
     * できなければ記録は1行も残らず、そのまま 500（下の `base.onError` へ抜けるに任せる。
     * `appendJournalOrDrop` は使わない——あれは「状態変更が済んだ後」の型）。
     *
     * **資格は `/commitments` と同じ（`authenticate` だけ）。** 本文は `jsonBody` が検査する
     * （`content-type: application/json` の要求を兼ねる）。不正な本文は 400（送られてきた値は
     * エラー文へ混ぜない）。
     */
    .post(
      '/github-observations',
      describeRoute({
        tags: ['progress'],
        summary: '観測した GitHub の数を記録する（申告。デーモンは確かめない）',
        description:
          '観測した側が数えた open Issue / open PR の件数を、観測者・repo・母集合の切り方付きで' +
          '日誌へ置く。`GET /progress` の `github` がこれを repo ごとに返す。**デーモンは GitHub を' +
          '見に行かない**（値は申告で、確かめていない）。`result.status` が `failed` の回は数を' +
          '持てない（取れなかったことを理由付きで残す）。日誌へ書けなければ何も残さず 500。',
        responses: {
          200: {
            description: '記録した。',
            content: { 'application/json': { schema: resolver(eventAcceptedResponseSchema) } },
          },
          400: {
            description: '本文の形が不正。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(githubObservationRequestSchema, (where) => ({
        error: 'github 観測の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const body = c.req.valid('json');
        const entry = await stores.journal.append({ type: 'github_observation', ...body });
        return c.json(eventAcceptedResponseSchema.parse({ ok: true, id: entry.id }));
      },
    )

    // --- ログイン（/auth） --------------------------------------------------
    //
    // 経路はデーモンが持つ。ブラウザは**この口へ戻ってくるだけ**で、alteroid を
    // 操作する画面は無い（Web UI は非ゴール。`gh auth login` と同じ形である）。
    //
    // **規則: 宣言された成功応答（200/202）はすべて宣言スキーマの `.parse()` を
    // 通す。エラー応答（400/403/404/409）はその場のリテラルなので通さない。**
    // `/managers` `/managers/:id`（#61）と同じ理由 — `describeRoute` の
    // `resolver()` は spec を作るだけでハンドラの戻り値を検査しないので、通して
    // いない経路では宣言に無いフィールドが黙って外へ出る。ここで使う応答スキーマ
    // （`openapi.ts` の `accountViewSchema` 系）は core の永続化スキーマから
    // 独立させてあるので、account の行が増えても外へは載らない。

    .get(
      '/auth/providers',
      describeRoute({
        tags: ['auth'],
        summary: '使えるログイン手段の一覧',
        description:
          '設定されているログイン手段を返す。`enabled` が false なら認証を要求していない。',
        security: [],
        responses: {
          200: {
            description: 'ログイン手段の一覧。',
            content: { 'application/json': { schema: resolver(authProvidersResponseSchema) } },
          },
        },
      }),
      (c) =>
        c.json(
          authProvidersResponseSchema.parse({ enabled: authPlan.enabled, providers: providerList }),
        ),
    )

    .post(
      '/auth/login',
      describeRoute({
        tags: ['auth'],
        summary: 'ログインを始める',
        description:
          'ブラウザで開く認可 URL と、結果を引き取るための秘密（`claimSecret`）を返す。' +
          '**この経路は認証を要求しない** — ログインの前に持っている資格が無いのは当たり前で、' +
          'ここを閉じると誰も入れない。得られるのはアカウントの作成までで、' +
          '使う許可は別に人間が与える（`alteroid access grant`）。',
        security: [],
        responses: {
          200: {
            description: 'ログインを開始した。',
            content: { 'application/json': { schema: resolver(loginStartResponseSchema) } },
          },
          400: {
            description: '未知のログイン手段、または手段が1つも設定されていない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(loginBody, (where) => ({
        error: 'provider/label の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const { provider, label } = c.req.valid('json');
        if (authPlan.providers.length === 0) {
          return c.json({ error: 'ログイン手段が設定されていない' as const }, 400);
        }
        const known = authPlan.providers.some((it) => it.id === provider);
        if (!known) return c.json({ error: `未知のログイン手段: ${provider}` }, 400);

        const started = await authService.startLogin({
          provider,
          label: label ?? '',
          redirectUri: callbackUrl(provider),
        });
        return c.json(loginStartResponseSchema.parse(started));
      },
    )

    .get(
      '/auth/:provider/callback',
      describeRoute({
        tags: ['auth'],
        summary: 'プロバイダからの戻り先',
        description:
          'ブラウザがここへ戻ってくる。応答は人間が読む HTML で、端末（CLI）側が ' +
          '`/auth/login/{requestId}/claim` で結果を引き取る。**トークンはここでは返さない** ' +
          '— ブラウザの履歴や Referer に鍵を載せないため。',
        security: [],
        responses: {
          200: {
            description: 'ログインの成否を人間に伝える画面。',
            content: { 'text/html': { schema: resolver(z.string()) } },
          },
          400: {
            description:
              'プロバイダ側が拒否した（`?error=`）／`code`・`state` が足りない／' +
              '`completeLogin` がエラーを返した、のいずれか。応答は人間が読む HTML。',
            content: { 'text/html': { schema: resolver(z.string()) } },
          },
        },
      }),
      async (c) => {
        const denied = c.req.query('error');
        if (denied !== undefined && denied.length > 0) {
          return c.html(
            callbackPage('ログインを中止しました', `プロバイダからの応答: ${denied}`),
            400,
          );
        }

        const code = c.req.query('code');
        const state = c.req.query('state');
        if (code === undefined || state === undefined) {
          return c.html(
            callbackPage('ログインに失敗しました', 'code と state が足りません。'),
            400,
          );
        }

        const result = await authService.completeLogin({ state, code });
        if (result.status === 'error') {
          return c.html(
            callbackPage('ログインに失敗しました', loginErrorDetail(result.reason)),
            400,
          );
        }
        return c.html(
          callbackPage(
            'ログインしました',
            result.granted
              ? 'この画面は自動で閉じます。閉じない場合は手動で閉じて端末に戻ってください。'
              : 'この画面は自動で閉じます。閉じない場合は手動で閉じて端末に戻ってください。なお、このアカウントにはまだ alteroid を使う許可がありません（alteroid access grant で付与します）。',
            true,
          ),
        );
      },
    )

    .post(
      '/auth/login/:requestId/claim',
      describeRoute({
        tags: ['auth'],
        summary: 'ログイン結果を引き取る',
        description:
          'ブラウザ側が終わっていればアクセストークンを返す。**返るのはこの1回だけ**で、' +
          'ストアには sha256 しか残らない。まだ終わっていなければ 202 と `pending`。',
        security: [],
        responses: {
          200: {
            description: 'トークンを発行した。',
            content: { 'application/json': { schema: resolver(loginClaimResponseSchema) } },
          },
          202: {
            description: 'まだブラウザ側が終わっていない。少し待って再試行する。',
            content: { 'application/json': { schema: resolver(loginClaimResponseSchema) } },
          },
          400: {
            description: '秘密が違う、期限切れ、または既に引き取り済み。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(claimBody, (where) => ({
        error: 'claimSecret の形が不正' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const result = await authService.claim({
          requestId: c.req.param('requestId'),
          claimSecret: c.req.valid('json').claimSecret,
        });
        if (result.status === 'pending') {
          return c.json(loginClaimResponseSchema.parse({ status: 'pending' as const }), 202);
        }
        if (result.status === 'error')
          return c.json({ error: claimErrorDetail(result.reason) }, 400);
        return c.json(
          loginClaimResponseSchema.parse({
            status: 'ready' as const,
            token: result.token,
            account: result.account,
            granted: isAccountGranted(result.account),
          }),
        );
      },
    )

    .get(
      '/auth/me',
      describeRoute({
        tags: ['auth'],
        summary: 'いま自分が誰として認識されているか',
        responses: {
          200: {
            description: '認証を通った相手。',
            content: { 'application/json': { schema: resolver(meResponseSchema) } },
          },
          401: {
            description: '資格が無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          403: {
            description:
              '連携の鍵（`altk_`）では呼べない（連携の鍵は外部イベントの口にしか入れない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      (c) => {
        const principal = c.get('principal');
        if (principal.kind === 'operator') {
          return c.json(meResponseSchema.parse({ kind: 'operator' as const }));
        }
        // 連携の鍵はここへ来ない（`authenticate` が既定で拒否する）。来たら二重の門で断る。
        if (principal.kind === 'integration') {
          return c.json({ error: '連携の鍵では、この操作はできない' as const }, 403);
        }
        return c.json(
          meResponseSchema.parse({
            kind: 'account' as const,
            account: principal.account,
            granted: isAccountGranted(principal.account),
          }),
        );
      },
    )

    /**
     * ログアウト（issue #1757）。**いま提示している、この1本のアクセストークン
     * だけを失効させる。** 同じアカウントの他のトークン（別端末・別ログイン）は
     * 触らない——アカウントごと締め出すのは `POST /access/:accountId/revoke` の
     * 役目で、ここはそれとは別の操作である。
     *
     * **資格は `authenticate` だけ**（`isPublicPath` の例外——上の doc）。
     * 提示が無ければそもそも何を失効させるかが決まらない。
     *
     * **operator の資格（状態ファイルの token）では失効させられない。** operator は
     * `AccessTokenRecord` を1本も持たない実行環境の持ち主そのもの（`Principal`
     * の doc）なので、「いま提示している資格を失効させる」という操作の対象が
     * 無い——これは「一段弱い」のではなく**別の種類の資格**である。4xx で
     * 断り、`alteroid access revoke` へ誘導する。
     *
     * **応答にトークンの値も sha256 も載せない。** 失効の成否（`ok: true`）
     * だけを返す——`okResponseSchema` は他の「本文を持たない成功」と同じ形。
     */
    .post(
      '/auth/logout',
      describeRoute({
        tags: ['auth'],
        summary: 'いま提示しているアクセストークンを失効させる',
        description:
          '同じアカウントの他のトークンは巻き込まない。**operator の資格（状態ファイルの ' +
          'token）では呼べない**——失効させる対象（アクセストークン）を持たないため。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストで' +
            'ログアウトさせられないため）。',
        ),
        responses: {
          200: {
            description: '失効させた（既に失効済みだった場合を含む）。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          400: {
            description: 'operator の資格では失効させられない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          401: {
            description: '資格が無い、またはトークンが既に無効。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      async (c) => {
        const principal = c.get('principal');
        if (principal.kind === 'operator') {
          return c.json(
            {
              error:
                '実行環境の持ち主の資格ではログアウトできない（アクセストークンを持たない）。' +
                '特定のアカウントを締め出すなら alteroid access revoke を使う',
            },
            400,
          );
        }
        // `authenticate` ミドルウェアが bearer からこの principal を解決した
        // ので、ここで bearer が無いことは無いはずだが、型では narrow できない
        // ため防御的に扱う（`AuthService.logout` の doc）。
        const bearer = bearerOf(c.req.header('authorization'));
        if (bearer === null) {
          return c.json({ error: 'ログインが要る（alteroid login）' as const }, 401);
        }
        const result = await authService.logout(bearer);
        if (result.status === 'not_found') {
          return c.json({ error: 'トークンが無効か期限切れ（alteroid login をやり直す）' }, 401);
        }
        return c.json(okResponseSchema.parse({ ok: true }));
      },
    )

    // --- アクセス許可（/access） --------------------------------------------
    //
    // **持つのは許可されているか否かの2値だけ。** 「chat は可・記憶の編集は不可」の
    // ような行為別のスコープを足したくなったら手を止める — それは PRD「権限境界」が
    // 禁じている「確認が要る行為の一覧」と同じ形であり、クローンの判断を設定で
    // 置き換えることになる。

    /**
     * **資格は `authenticate` だけ（`requireOperator` は付けない）。** ⚠️ 2026-09-06
     * のオーナー決定——alteroid を使う許可（`access grant` 済み）があれば実行環境の
     * 持ち主と同格に扱う——により、以前ここに在った `requireOperator` を外した。
     */
    .get(
      '/access',
      describeRoute({
        tags: ['access'],
        summary: 'ログインしたアカウントと許可の一覧',
        description:
          'alteroid を使う許可があれば読める（実行環境の持ち主と同格。2026-09-06 の' +
          'オーナー決定）。メールと identity が並ぶ一覧である点は変わらない。',
        responses: {
          200: {
            description:
              'アカウントの一覧。読めない行（型に合わない形で入っているアカウント）が1件でも在るときだけ ' +
              '`rowsUnreadable`（件数と id・不正な欄名。email などの中身は載せない）が付く。id を ' +
              '`POST /access/unreadable/remove` に渡して消せる。',
            content: { 'application/json': { schema: resolver(accessListResponseSchema) } },
          },
          403: {
            description:
              'alteroid を使う許可が無い（ログインしているが `access grant` されて' +
              'いない）。資格そのものが無い場合は 401。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const accounts = await stores.auth.listAccounts();
        // **読めない行は、1件でも在るときだけ `rowsUnreadable` に載せる**（issue #2536。
        // 0件なら鍵ごと無い）。email などの中身は載らない（id と不正な欄名だけ）。
        const rowsUnreadable = toRowsUnreadable(await stores.auth.listUnreadableAccounts());
        return c.json(
          accessListResponseSchema.parse({
            accounts: await Promise.all(accounts.map((account) => accountView(stores, account))),
            ...(rowsUnreadable === undefined ? {} : { rowsUnreadable }),
          }),
        );
      },
    )

    /**
     * **資格は `authenticate` だけ（`requireOperator` は付けない）。** ⚠️ 2026-09-06
     * のオーナー決定——alteroid を使う許可（`access grant` 済み）があれば実行環境の
     * 持ち主と同格に扱う——により、以前ここに在った `requireOperator` を外した。
     *
     * ⚠️ **2026-09-09 のオーナー決定で「何人まで許可できるか」の上限も外れた。**
     * ここに「持ち主は依然として高々1人（下の `grantExclusive` の 409）——同格に
     * したのは『誰が叩けるか』であって『何人まで許可できるか』ではない」と書いて
     * あったが、**その2つが同時に開いたので許可は伝播する**（A が B を、B が C を
     * 通せる）。**同格化は戻さない**（オーナー決定である）。代わりに下の日誌が
     * 「誰が誰を通したか」を毎回残す——それが伝播を事後に追える唯一の場所である。
     */
    .post(
      '/access/:accountId/grant',
      describeRoute({
        tags: ['access'],
        summary: 'alteroid を使う許可を与える',
        description:
          'ログインしただけでは使えない。ここで初めて使えるようになる。運ぶ情報は無い' +
          '（`{}` を送る）。\n\n' +
          '**許可できるアカウントの数に上限は無い**（2026-09-09 のオーナー決定。それ' +
          '以前は高々1つで、2人目は 409 だった）。同じ人間が複数のログイン手段から' +
          '入れる。**利用者ごとにデータは分けない** — 許可を持つ全員が同じ1組の記憶・' +
          '日誌・会話を見る（マルチユーザー / チーム利用は docs/PRD.md「スコープ外」の' +
          'ままである）。\n\n' +
          '**この口は許可を持つアカウントからも叩ける**（2026-09-06 のオーナー決定で' +
          '実行環境の持ち主と同格）。⟹ 許可は伝播する。誰が誰を通したかは日誌に残る。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストで持ち主を' +
            '足されないため）。',
        ),
        responses: {
          200: {
            description: '許可した（既に許可済みでも 200）。',
            content: { 'application/json': { schema: resolver(accessAccountResponseSchema) } },
          },
          403: {
            description:
              'alteroid を使う許可が無い（ログインしているが `access grant` されて' +
              'いない）。資格そのものが無い場合は 401。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当するアカウントが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      async (c) => {
        const accountId = c.req.param('accountId');
        // **対象を先に引く（門前払い）。** 無ければ 404、日誌は書かない——
        // いまと同じ応答。ここは早期の検査でしかない——実際に許可される保証は
        // 下の `authService.grant` の結果でしか取れない（#2043）。
        const before = await stores.auth.getAccount(accountId);
        if (before === null) return c.json({ error: 'not found' as const }, 404);

        // 誰を通したかは必ず残す。事後に追えることが「最終承認」の実体である
        // （PRD「可観測性」）。**上限を外した 2026-09-09 以降、ここが唯一の歯止め
        // である** — 許可を持つ側も grant を叩けるので、許可は人間の手を経ずに
        // 伝播しうる。`describeActor` を省いて `operator` 固定にしないこと。
        //
        // **日誌を先に書く（#2043。順序を変えた理由）。** 状態変更の後に書いて
        // いた形だと、変更が効いた直後に追記だけが落ちると、許可が伝播したのに
        // 記録が1件も残らない——`appendJournalOrDrop` で握って 200 を返す狭める
        // 側の直し方をここへ持ち込むと、この口では「記録の無い許可」を作って
        // しまう。だから先に書き、**書けなければ状態を変えずに 500**（下の
        // `base.onError` へ抜ける）。
        await stores.journal.append({
          type: 'decision',
          decision: `アクセス許可を付与: ${describeAccount(before)}`,
          grounds: `${describeActor(c.get('principal'))}（alteroid access grant）`,
        });

        let result: GrantResult;
        try {
          result = await authService.grant(accountId, actorOf(c.get('principal')));
        } catch (error) {
          // 日誌には「付与した」が残っているので、打ち消す（stderr にしか
          // 残らなくても構わない——ここは記録が多すぎる側の穴で、
          // 「記録の無い許可」よりは安全側と判断した。#2043）。
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `アクセス許可を付与できなかった: ${describeAccount(before)}`,
              grounds: `${describeActor(c.get('principal'))}（alteroid access grant、状態の変更が失敗）`,
            },
            'アクセス許可付与の打ち消しの日誌',
            `accountId=${accountId}`,
          );
          throw error;
        }
        if (result.status === 'not_found') {
          // 1（対象を引く）と 3（状態を変える）の間に消えた。同じ理由で打ち消す。
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `アクセス許可を付与できなかった: ${describeAccount(before)}`,
              grounds: `${describeActor(c.get('principal'))}（alteroid access grant、対象が消えていた）`,
            },
            'アクセス許可付与の打ち消しの日誌',
            `accountId=${accountId}`,
          );
          return c.json({ error: 'not found' as const }, 404);
        }
        return c.json(
          accessAccountResponseSchema.parse({ account: await accountView(stores, result.account) }),
        );
      },
    )

    /**
     * **資格は `authenticate` だけ（`requireOperator` は付けない）。** ⚠️ 2026-09-06
     * のオーナー決定——alteroid を使う許可（`access grant` 済み）があれば実行環境の
     * 持ち主と同格に扱う——により、以前ここに在った `requireOperator` を外した。
     * 同格である以上、いまは許可されたアカウントが自分自身を revoke することもできる
     * （自分の許可を自分で手放す）。
     */
    .post(
      '/access/:accountId/revoke',
      describeRoute({
        tags: ['access'],
        summary: 'alteroid を使う許可を取り消す',
        description:
          '発行済みトークンは消さない。**許可はリクエストごとに見ているので、' +
          'これだけで即座に通らなくなる**（消し忘れたトークンが生き残らない）。運ぶ情報は' +
          '無い（`{}` を送る）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストで持ち主の' +
            '許可を落とされないため）。',
        ),
        responses: {
          200: {
            description: '取り消した（既に未許可でも 200）。',
            content: { 'application/json': { schema: resolver(accessAccountResponseSchema) } },
          },
          403: {
            description:
              'alteroid を使う許可が無い（ログインしているが `access grant` されて' +
              'いない）。資格そのものが無い場合は 401。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当するアカウントが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description:
              '該当するアカウントの行は在るが、型に合わない形で入っていて読めない（居ないのとは' +
              '区別する。issue #2425）。取り消しはこの口ではできず、行は変わっていない。' +
              '読めないアカウントは認可を通らない。消すには ' +
              '`POST /access/unreadable/remove`（issue #2440）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      async (c) => {
        // **issue #2425。** 読めない行は「無い」（404）ではなく「読めない形で在る」（409）
        // と言い分ける。行は変わっていない（許可は落ちていない）。
        let account: Awaited<ReturnType<typeof authService.revoke>>;
        try {
          account = await authService.revoke(c.req.param('accountId'));
        } catch (error) {
          if (!(error instanceof UnreadableAccountError)) throw error;
          return c.json(
            {
              error:
                `アカウント ${error.id} は読めない形で入っている（消されたのでも、許可が落ちたのでもない）。` +
                '取り消しはこの口ではできない。本文はここでは取れない。' +
                '消すには `POST /access/unreadable/remove`（alteroid access remove-unreadable <id>）を使う。',
            },
            409,
          );
        }
        if (account === null) return c.json({ error: 'not found' as const }, 404);
        // 取り消しは効いているので、日誌への追記だけが落ちても 500 を返さない
        // ——`appendJournalOrDrop` の doc（#2043。狭める側は #2037 と同じ扱い）。
        await appendJournalOrDrop(
          stores,
          {
            type: 'decision',
            decision: `アクセス許可を取り消し: ${describeAccount(account)}`,
            grounds: `${describeActor(c.get('principal'))}（alteroid access revoke）`,
          },
          'アクセス許可取り消しの日誌',
          `accountId=${account.id}`,
        );
        return c.json(
          accessAccountResponseSchema.parse({ account: await accountView(stores, account) }),
        );
      },
    )

    /**
     * **読めないアカウントの行を、id で指して消す**（issue #2440。`POST /tokens/unreadable/remove`
     * 〈#2354〉と同じ形）。読めない行（版ずれ・手編集）は `/access/:accountId/revoke` が 409 で
     * 触らないので、片付ける口はここだけである。`/access/:accountId/…` の `:accountId` と
     * 取り違えないよう、別の語（`unreadable`）の下に置く。
     *
     * **日誌を先に書き、書けなければ状態を変えずに 500。** 日誌に残すのは消す id と件数だけ
     * （email などの中身は書かない）。読めない行に無い id が1つでもあれば何も消さず 404（指された
     * 文字列は返さない）。読めたアカウントと identity・アクセストークンには触れない。
     * **資格は `authenticate` だけ（`/access/:accountId/revoke` と同じ強さ）。**
     */
    .post(
      '/access/unreadable/remove',
      describeRoute({
        tags: ['access'],
        summary: '読めないアカウントの行を、id を指して消す',
        description:
          '読めない（型に合わない形で入っている）アカウントの行だけを、id を指して消す。読める' +
          'アカウントには触れない。id が取れない行はこの口では消せない（`auth.json` を手で直す）。' +
          '1つでも読めない行に無い id があれば何も消さない。消した id と件数を日誌に残す' +
          '（行の中身は残さない）。pg はアカウントを列で持つので読めない行が無く、常に 404。',
        responses: {
          200: {
            description: '消した id と件数。',
            content: {
              'application/json': { schema: resolver(unreadableRowsRemoveResponseSchema) },
            },
          },
          400: {
            description: '入力の形が不正（何も消していない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          403: {
            description:
              'alteroid を使う許可が無い（ログインしているが `access grant` されて' +
              'いない）。資格そのものが無い場合は 401。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description:
              '指した id のうち、読めない行に無いものがあった（何も消していない。日誌も書いていない）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          500: {
            description:
              '日誌が書けなかった（**状態を変えていない**）か、消すのに失敗した。理由の本文は返さない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      jsonBody(unreadableRowsRemoveRequestSchema, (where) => ({
        error:
          '読めない行の id の入力の形が不正（何も消していない）' +
          (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const result = await removeUnreadableRowsWithJournal({
          stores,
          subject: 'アカウント',
          actor: describeActor(c.get('principal')),
          route: 'POST /access/unreadable/remove',
          requested: c.req.valid('json').ids,
          remove: (ids, options) => authService.removeUnreadableAccounts(ids, options),
        });
        if (result.kind === 'unknown') {
          return c.json(
            {
              error:
                `指した id のうち ${String(result.count)} 件が、読めないアカウントの行に無い` +
                '（何も消していない。id は `GET /access` の `rowsUnreadable.rows[].id`（alteroid access list）で確かめる）',
            },
            404,
          );
        }
        if (result.kind === 'failed') {
          return c.json({ error: 'アカウントを保存できなかった' as const }, 500);
        }
        return c.json(
          unreadableRowsRemoveResponseSchema.parse({
            removedIds: result.ids,
            count: result.ids.length,
          }),
        );
      },
    )

    /**
     * **実行環境の持ち主として宣言する。**（issue #1198。本来の形）
     *
     * **注記: 宣言は資格の判断には使っていない（2026-10-05 オーナーの判断：ログインできる人＝持ち主。#2862）。仕組みは当面残してある（`requireOwner` は素通し）。**
     *
     * **`requireOperator`。** `/access/grant` `/access/revoke` とは違い、ここは
     * 許可されたアカウントからは叩けない——**旗を立てられる者を常にホストへ到達
     * できる者へ限る**ことが、この機能の「伝播しない」という性質そのものである
     * （`requireOwner` の doc）。ここへ `authenticate` だけを許す設計は取らない。
     *
     * **宣言できるのは許可済みのアカウントだけ。** `AuthStore.setAccountOwner` が
     * 未許可の行への宣言を1操作で拒む（`packages/core/src/auth.ts` の doc）。
     */
    .post(
      '/access/:accountId/owner',
      describeRoute({
        tags: ['access'],
        summary: '実行環境の持ち主として宣言する',
        description:
          '（宣言は資格の判断には使っていない。ログインできる人＝持ち主。#2862）' +
          '宣言できるのは実行環境の持ち主（operator トークン）だけ。対象は許可済み' +
          '（`access grant` 済み）のアカウントに限る——未許可なら 409。運ぶ情報は無い' +
          '（`{}` を送る）。許可済みのアカウントは宣言の有無にかかわらず ' +
          '`PUT /credentials` `POST /reset` を通る（2026-10-05、#2862 のオーナー決定）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る。',
        ),
        responses: {
          200: {
            description: '宣言した。',
            content: { 'application/json': { schema: resolver(accessAccountResponseSchema) } },
          },
          403: {
            description: '実行環境の持ち主ではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当するアカウントが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          409: {
            description: '対象のアカウントがまだ許可されていない（先に access grant が要る）。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      requireOperator,
      deliberateClient,
      async (c) => {
        const accountId = c.req.param('accountId');
        // **対象を先に引く（門前払い）。** 無ければ 404、未許可なら 409——
        // どちらも日誌を書かない、いまと同じ応答。ここも早期の検査でしかない
        // （`isAccountGranted` の判定と `authService.setOwner` の実際の判定の
        // 間で許可が落ちることがある——その窓は下の `not_granted` 分岐が拾う。
        // #2043）。
        const before = await stores.auth.getAccount(accountId);
        if (before === null) return c.json({ error: 'not found' as const }, 404);
        if (!isAccountGranted(before)) {
          return c.json(
            { error: 'このアカウントはまだ許可されていない（先に access grant が要る）' as const },
            409,
          );
        }

        // 誰を宣言したかは必ず残す（`/access/grant` と同じ理由。PRD「可観測性」）。
        // **日誌を先に書く（#2043。順序を変えた理由は `/access/grant` と同じ——
        // 記録の無い宣言を作らない）。書けなければ状態を変えずに 500。**
        await stores.journal.append({
          type: 'decision',
          decision: `実行環境の持ち主として宣言: ${describeAccount(before)}`,
          grounds: `${describeActor(c.get('principal'))}（alteroid access owner）`,
        });

        let result: OwnerOutcome;
        try {
          result = await authService.setOwner(accountId, true);
        } catch (error) {
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `実行環境の持ち主として宣言できなかった: ${describeAccount(before)}`,
              grounds: `${describeActor(c.get('principal'))}（alteroid access owner、状態の変更が失敗）`,
            },
            '持ち主宣言の打ち消しの日誌',
            `accountId=${accountId}`,
          );
          throw error;
        }
        if (result.status === 'not_found' || result.status === 'not_granted') {
          // 1（対象を引く）と 3（状態を変える）の間に消えた・許可が落ちた。
          const detail =
            result.status === 'not_found' ? '対象が消えていた' : '許可が取り消されていた';
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `実行環境の持ち主として宣言できなかった: ${describeAccount(before)}`,
              grounds: `${describeActor(c.get('principal'))}（alteroid access owner、${detail}）`,
            },
            '持ち主宣言の打ち消しの日誌',
            `accountId=${accountId}`,
          );
          if (result.status === 'not_found') return c.json({ error: 'not found' as const }, 404);
          return c.json(
            { error: 'このアカウントはまだ許可されていない（先に access grant が要る）' as const },
            409,
          );
        }
        return c.json(
          accessAccountResponseSchema.parse({ account: await accountView(stores, result.account) }),
        );
      },
    )

    /**
     * **実行環境の持ち主としての宣言を取り消す。**（issue #1198）
     *
     * **注記: 宣言は資格の判断には使っていない（2026-10-05 オーナーの判断：ログインできる人＝持ち主。#2862）。仕組みは当面残してある。**
     *
     * **`requireOperator`。** 取り消しは対象の許可状態を問わない
     * （`AuthStore.setAccountOwner` の doc）——行が在れば常に通る。
     */
    .post(
      '/access/:accountId/owner/revoke',
      describeRoute({
        tags: ['access'],
        summary: '実行環境の持ち主としての宣言を取り消す',
        description:
          '（宣言は資格の判断には使っていない（2026-10-05 オーナーの判断：ログインできる人＝持ち主。#2862））' +
          '宣言していなくても 200（既に取り消し済みと同じ扱い）。運ぶ情報は無い' +
          '（`{}` を送る）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る。',
        ),
        responses: {
          200: {
            description: '取り消した（既に未宣言でも 200）。',
            content: { 'application/json': { schema: resolver(accessAccountResponseSchema) } },
          },
          403: {
            description: '実行環境の持ち主ではない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          404: {
            description: '該当するアカウントが無い。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      requireOperator,
      deliberateClient,
      async (c) => {
        const result = await authService.setOwner(c.req.param('accountId'), false);
        if (result.status === 'not_found') return c.json({ error: 'not found' as const }, 404);
        // `not_granted` は取り消し（declared=false）では起こらない
        // （`AuthStore.setAccountOwner` の doc——取り消しは行が在れば常に通る）。
        if (result.status === 'not_granted') return c.json({ error: 'not found' as const }, 404);
        // 取り消しは効いているので、日誌への追記だけが落ちても 500 を返さない
        // ——`appendJournalOrDrop` の doc（#2043。狭める側は #2037 と同じ扱い）。
        await appendJournalOrDrop(
          stores,
          {
            type: 'decision',
            decision: `実行環境の持ち主としての宣言を取り消し: ${describeAccount(result.account)}`,
            grounds: `${describeActor(c.get('principal'))}（alteroid access owner --revoke）`,
          },
          '持ち主宣言取り消しの日誌',
          `accountId=${result.account.id}`,
        );
        return c.json(
          accessAccountResponseSchema.parse({ account: await accountView(stores, result.account) }),
        );
      },
    )

    /**
     * デーモンを止める（`alteroid daemon stop` の受け口）。
     *
     * **資格は `authenticate` だけ（`requireOperator` は付けない）。**
     * `POST /commitments/:id/close` `DELETE /archive/:id` `POST /inbox/remove`
     * と同じ強さである——**基準は「壊すかどうか」ではない。** 上の
     * `POST /inbox/remove` の doc が逐語で線を引いており、`/profile`
     * `/runners/credentials` のように**鍵そのものを扱う口だけ**がその一段上の
     * 強さを持つ。ここは鍵を扱わず、記憶も台帳も1行も消さない——**止めた後に
     * 起動し直せば元に戻る**ので、`POST /reset`（記憶そのものを消す）とは
     * 取り返しのつき方が違う。⟹ `access grant` を通しただけのアカウントにも
     * 開いてよい強さである。
     *
     * **⚠️ `deliberateClient` は「誰が叩いてよいか」の門ではない。** あれは
     * `content-type` を要求してブラウザの単純リクエストを止めるもの（下の
     * `requestBody` の doc）で、資格の話とは層が違う。**ここに資格の門が
     * 見当たらないのを「付け忘れ」と読まないこと。**
     *
     * **CLI が実行環境の持ち主として名乗るのは、ここが要求しているからでは
     * ない**（`apps/cli/src/daemon.ts` の `stop()` は状態ファイルの token を
     * 送る）。手元の常駐を止めるのに使える資格が、たまたま強いほうだという
     * だけである。
     */
    .post(
      '/shutdown',
      describeRoute({
        tags: ['system'],
        summary: 'デーモンを止める',
        description: '`daemon stop` の受け口。運ぶ情報は無い（`{}` を送る）。',
        requestBody: noBodyPostRequestBody(
          '**中身は読まないので `{}` を送ればよい。** 本文そのものではなく ' +
            '`content-type: application/json` が要る（ブラウザの単純リクエストでデーモンを' +
            '止められないため）。',
        ),
        responses: {
          200: {
            description: '停止を受け付けた（実際の停止は少し遅れる）。',
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          ...noBodyPostResponses(),
        },
      }),
      deliberateClient,
      (c) => {
        setTimeout(() => deps.shutdown(), 10);
        return c.json({ ok: true });
      },
    )

    /**
     * ワークスペースのリセット（「トークン情報以外を全部消す」）。
     * `resetWorkspaceState`（`@alteroid/core`）がそのまま実体で、何を残し何を
     * 消すかはそちらの doc が正本——ここでは選べない・書き写さない。
     *
     * **由来**: 本番（Railway）の Postgres に対して人間の依頼で1度、手作業の
     * `TRUNCATE` を行った（2026-09-14）。ここはその「同条件」を alteroid
     * 自身の機能として持たせたもの。
     *
     * **許可済みのアカウントなら通る**（`requireOwner`。2026-10-05 の #2862 の
     * オーナー決定で、宣言済み owner だけから緩めた。以下の「宣言済み」は緩める前の記述）
     * ——`access grant` だけのアカウントに、記憶そのものを消せる資格までは渡さない。
     *
     * **⚠️ 2026-09-17、ここは `requireOperator` から一段緩めた**（issue #1195）。
     * 当初は「持ち主が端末から直に許可したアカウント」の近似で通していたが、
     * **2026-09-18 に `ownerDeclaredAt` の宣言へ置き換えた**（issue #1198）
     * ——**下の「Web UI の確認ダイアログ」は、そのままでは押しても必ず 403 に
     * なっていた**（`apps/web/app/routes/settings.tsx` の `ResetWorkspace`）。
     * 伝播した許可（A が B を通した）は通らない。
     *
     * **`confirm: true` を必須にする**（`resetRequestSchema` の doc）。CLI・
     * Web UI の確認ダイアログは呼ぶ前の話で、この口自体にも確認の印を要求する
     * ことで、確認を経ない直接の呼び出し（スクリプト等）を 400 で止める。
     *
     * **取り消せない。** 消した件数の内訳を返すので、対象が空だったのか
     * 大量に消えたのかは呼び出し側から見える（`resetResponseSchema` の doc）。
     * 日誌にも残す——これは「聞かずに実行した判断」ではなく人間が明示的に
     * 確認した操作だが、何がいつ消えたかを可観測性の3層（日報・日誌・
     * セッションログ）の外に置かないため。
     */
    .post(
      '/reset',
      describeRoute({
        tags: ['system'],
        summary: 'トークン情報以外のワークスペースを全部消す',
        // **`describeResetTargets()`（`@alteroid/core`）から組み立てる——
        // CLI の確認の文（`apps/cli/src/reset.ts` の `buildConfirmMessage`）と
        // 同じ `RESET_CONFIRM_GROUPS` が出所（issue #2224）。手で書き写すと
        // ここだけ古くなる（#2196 で「仕事のやり方」を足し忘れたのが実例）。
        description:
          `${describeResetTargets()}を全部消す。` +
          '**認証トークンのプール・マネージャーへ降ろす環境変数・Web UI の' +
          'ログインアカウントは消さない。** 取り消せない。',
        responses: {
          200: {
            description: '消した件数の内訳。',
            content: { 'application/json': { schema: resolver(resetResponseSchema) } },
          },
          400: {
            description: '`confirm: true` を伴っていない。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
          403: {
            description: '許可（`access grant`）の無いアカウント。',
            content: { 'application/json': { schema: resolver(errorResponseSchema) } },
          },
        },
      }),
      requireOwner,
      jsonBody(resetRequestSchema, () => ({
        error: '`confirm: true` を伴っていない（取り消せない操作なので確認を必須にしてある）',
      })),
      async (c) => {
        const cleared = await resetWorkspaceState(stores, {
          ...(deps.clearSessionLog === undefined ? {} : { clearSessionLog: deps.clearSessionLog }),
        });
        // 添付の写し（本体は上の `resetWorkspaceState` が消した）。置き場の外のファイルなのでここで消す。
        // 本体はもう消えているので、写しが消せなくても 500 にはしない（申告の `cleared` を失わない。下の日誌と同じ）
        if (deps.attachmentCopiesDir !== undefined) {
          await rm(deps.attachmentCopiesDir, { recursive: true, force: true }).catch(
            (error: unknown) => {
              process.stderr.write(
                `alteroidd: リセットで添付の写しを消せなかった: ${reasonOf(error)}\n`,
              );
            },
          );
        }
        // **リセット自体はもう効いている**（Issue #2037）。日誌への追記だけが
        // 落ちても 500 を返さない——`appendJournalOrDrop` の doc。**ここは
        // 特に重要**: `cleared`（消した件数の内訳）は取り消せない操作の唯一の
        // 申告であり、やり直しても意味が無い（もう空である）。ここを 500 に
        // すると、実際には消えている件数が応答から失われる。
        await appendJournalOrDrop(
          stores,
          {
            type: 'decision',
            decision: 'ワークスペースをリセットした（トークン情報以外を全部消した）',
            grounds: `${describeActor(c.get('principal'))}（POST /reset。confirm 済み）`,
          },
          'ワークスペースリセットの日誌',
          `cleared=${JSON.stringify(cleared)}`,
        );
        return c.json(resetResponseSchema.parse({ cleared }));
      },
    );

  // --- OpenAPI 自体の配信 ---------------------------------------------------
  //
  // **チェーンに載せない。** `.get(...)` をチェーンへ差し込むと、以降の
  // メソッドの型引数が積み重なって `AppType`（CLI の `hc<AppType>` が依存する
  // 型）の推論が壊れかねない。別文で呼んで `app` を返す（Issue #20 の指示）。
  //
  // `describeRoute` を付けていないので、この2本は spec に自動では載らない
  // （hono-openapi は describeRoute の無い経路を素通りする）。`exclude` は
  // その動作を明示するための二重の安全策である。
  app.get(
    '/openapi.json',
    openAPIRouteHandler(app, {
      documentation: openApiDocumentation,
      exclude: openApiExcludePaths,
    }),
  );
  app.get('/docs', Scalar({ url: '/openapi.json' }));

  return app;
}

export type AppType = ReturnType<typeof createApp>;

/**
 * `Clone#answerApproval` が、既に終わった承認への回答を断ったときの種類（issue #2007）。
 * core の `ApprovalAlreadySettledError` を `instanceof` ではなく `name` と `settled` で
 * 見分ける——`CloneHost` の向こうの実装を差し替えるテストの偽物でも、同じ形で投げれば
 * 同じ扱いになるようにするため。
 */
function approvalSettledKindOf(error: unknown): 'answered' | 'withdrawn' | undefined {
  if (!(error instanceof Error) || error.name !== 'ApprovalAlreadySettledError') return undefined;
  const settled = (error as Error & { settled?: unknown }).settled;
  return settled === 'answered' || settled === 'withdrawn' ? settled : undefined;
}
