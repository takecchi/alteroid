import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

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
  attachmentBodyMaxBytes,
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

// 外から叩かせるなら境界は手前（リバースプロキシ・トンネル・認証）に置く: 能力側で絞らず実行環境の境界で守る（north_star 禁止2）。
export interface AppDeps {
  clone: CloneHost;
  stores: Stores;
  token: string;
  shutdown: () => void;
  now?: () => Date;
  attachmentLimits?: AttachmentLimits;
  scheduler?: Scheduler;
  storage?: string;
  // デーモンが鍵を保管しない（降ろすだけ）: 保管すると記憶の器に GitHub の書き込み権が並ぶため（railway/README.md「daemon 側には置かない」）。
  runners?: RunnerRegistry;
  cloneModel?: string;
  // 無ければその経路だけ 503: 配線されていないことを黙って隠さないため。
  journalEvents?: Pick<JournalBus, 'subscribe'>;
  // 日誌は通らない（プールが `WorkerToolBus` へ流す）。
  workerToolEvents?: Pick<WorkerToolBus, 'subscribe'>;
  // 無ければ `account` は `{ state: 'unknown' }`: 0 を返すと「枠を使っていない」と読めるため。
  accountUsage?: () => AccountUsageState;
  // ワイルドカードを受け付けない: `*` を許すと `deliberateClient` の前提（preflight が通らない）が消え、任意のページからクローンのターンを起こせる。
  // `credentials` を付けない: Cookie を運ばせない設計（資格情報はヘッダで運ぶ）。
  // `allowHeaders` は最小: `content-type` は `deliberateClient` が要求するので通すだけで、増やすなら理由が要る。
  allowedOrigins?: readonly string[];
  // 省略すると認証を要求しない: 設定していない人の `alteroid chat` が突然通らなくなる方が北極星に反するため。
  auth?: { plan: AuthPlan; service?: AuthService };
  // クローンの道具（`profile_write`）と同じインスタンスを渡す: 別々だと直列化が効かず、同時更新で層ごとに違う本文が残る。
  profile?: ProfileService;
  // マネージャーのプールと同じインスタンスを渡す（`profile` と同じ理由）。
  credentials?: CredentialService;
  // マネージャーのプールと同じインスタンスを渡す（`profile` と同じ理由）。渡さなければ保存だけして配らない（`runners: []`）。
  mcpServers?: McpServerService;
  pluginFetcher?: PluginFetcher;
  // マネージャーのプールと同じインスタンスを渡す（`profile` と同じ理由）。
  pluginDistribution?: PluginDistributionService;
  pluginPreviewNow?: () => number;
  // マネージャーのプールと同じインスタンスを渡す（`profile` と同じ理由）。
  codexAuth?: CodexChatgptAuthService;
  // 回さない: ここが生やすのは器の読み書きの口だけで、検知・切替は無い。
  tokens?: TokenPoolService;
  // 環境変数は増やさない: テストで短くする以外に差し替える理由が無い。
  sseHeartbeatMs?: number;
  // 無ければ `storage.state` は `unknown`: 確かめる手段が無いことを `ok` に化けさせない。毎リクエストでは叩かない。
  storageProbe?: () => Promise<void>;
  // 環境変数は増やさない（`sseHeartbeatMs` と同じ）。
  topologyTickMs?: number;
  topologyDebounceMs?: number;
  clearSessionLog?: () => Promise<number>;
  // 省略すれば写しは消さない: 写しは本体から取り出し直せる。
  attachmentCopiesDir?: string;
}

// `*` と、経路を含む値と、解釈できない値は捨てる: 緩めると「許可したつもりの範囲」と「実際に通る範囲」がずれ、境界が境界でなくなる。
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

    // `.origin` は経路を落とす: 元の文字列がオリジンそのものだったときだけ通し、打ち間違いを飲み込まない。
    const normalized = url.origin;
    if (normalized === 'null' || candidate.replace(/\/+$/, '') !== normalized) {
      rejected.push(candidate);
      continue;
    }
    if (!origins.includes(normalized)) origins.push(normalized);
  }

  return { origins, rejected };
}

// tsconfig の `lib` が ES2023 で `isWellFormed`（ES2024）が無いので最小の型だけ足す。
function isWellFormedString(value: string): boolean {
  return (value as string & { isWellFormed(): boolean }).isWellFormed();
}

// `supersedes` は形（`min(1)`）だけ見る: 編集できる対象かの判定は、空文字を許すと `conversationId` と同じ穴になるのでハンドラの手書き検証が持つ。
const chatBody = z
  .object({
    text: z.string(),
    // 孤立サロゲート・NUL を含む id は入口で 400 にする: pg が書き換え・脱落させて別々の id が同じ値に潰れ、添付の再 bind が conflict になる。黙って正規化しない。
    conversationId: z
      .string()
      .min(1)
      .refine(isWellFormedString, { message: '孤立サロゲートを含む' })
      .refine((id) => !hasNul(id), { message: 'NUL を含む' })
      .optional(),
    supersedes: z.string().min(1).optional(),
    // 固定の `maxItems` を書かない: 上限は環境変数で変わるので、個数・合計の検査はハンドラが持つ。
    attachments: z.array(z.string().min(1)).optional(),
    clientMessageId: clientMessageIdSchema.optional(),
  })
  // 「空」は NUL を落とした後で見る: ストアは NUL を落として残すので、落とす前の長さで見ると NUL だけの `text` が空の発言として日誌へ入る。
  .refine((body) => stripNul(body.text).length > 0 || (body.attachments?.length ?? 0) > 0, {
    message: 'text が空のときは attachments が要る',
    path: ['text'],
  });

const attachmentUploadQuery = z.object({
  keep: z
    .enum(['1', 'true', '0', 'false'])
    .transform((value) => value === '1' || value === 'true')
    .optional(),
  name: z.string().optional(),
  type: z.string().regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(\s*;.*)?$/, 'MIME の形ではない'),
});

// 宣言された MIME は人間が決めた文字列なので、ヘッダに入れて壊れない形でなければ `application/octet-stream` に倒す。
const SAFE_MEDIA_TYPE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;

function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// トークンや資格そのものは入れない（識別子だけ）。
function uploaderOf(principal: Principal): string {
  if (principal.kind === 'operator') return 'operator';
  if (principal.kind === 'integration') return `integration:${principal.keyId}`;
  return `account:${principal.account.id}`;
}

// `application/octet-stream` だけを受ける（`deliberateClient` と同じ考え方）: CORS の単純リクエストの content-type に入らず preflight が必ず要るので、任意のページから `no-cors` の fetch や form で添付を預けられない。`multipart` を受けないのも同じ理由。
const octetStreamClient = createMiddleware(async (c, next) => {
  if (mimeEssence(c.req.header('content-type')) !== 'application/octet-stream') {
    return c.json({ error: 'content-type: application/octet-stream が要る' as const }, 415);
  }
  await next();
});

const memoryBody = z.object({ content: z.string(), ifMatch: z.string().nullable().optional() });
// `ifMatch` の省略は 428 で断るが形の検査では必須にしない: スラッグ不正 400・無い 404 を先に返すためハンドラで 404 の後に断る。`null` は受けない（無いものを消す意味が無い）。
const memoryDeleteQuery = z.object({ ifMatch: z.string().min(1).optional() });
// 読めない形で入っている行だけは版なしで消せる。
const practiceDeleteQuery = z.object({ ifMatch: z.string().min(1).optional() });
// `kind` に列挙を課さない: 道具（`practice_write`）と HTTP とで書ける種類が食い違う（`practiceKindSchema` の doc）。`title` も core 側に制約が無いので足さない。
const practiceBody = z.object({
  kind: practiceKindSchema,
  title: z.string(),
  content: z.string(),
  ifMatch: z.string().nullable().optional(),
});
const answerFields = {
  answer: z.string().min(1).optional(),
  selections: z.array(approvalSelectionSchema).min(1).optional(),
};
// 形の検査で弾く: `text/plain` で JSON を送る CSRF は本文が空として読まれるので、両方が任意でも空の本文を 404 / 409 の判定まで進ませない。
const hasAnswerOrSelections = (body: { answer?: unknown; selections?: unknown }) =>
  body.answer !== undefined || body.selections !== undefined;
// `selections` と併用する `answer` は補足なので、空白だけでもここでは見ない（`describeSelectionsViolation` が扱う）。値は書き換えない。
const answerIsNotBlank = (body: { answer?: string; selections?: unknown }) =>
  body.selections !== undefined ||
  body.answer === undefined ||
  stripNul(body.answer).trim().length > 0;
const answerBody = z
  .object(answerFields)
  .refine(hasAnswerOrSelections, { message: 'answer も selections も無い' })
  .refine(answerIsNotBlank, { message: 'answer が空白だけ', path: ['answer'] });
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
  source: z.string().min(1),
  payload: z.unknown().optional(),
  attachments: z.array(z.string().min(1)).optional(),
});
// 本文まるごとが payload なので、添付の id はクエリで運ぶ。空の値は無いものとして扱う: `?attachments=` を付けていた呼び手を壊さない。
const eventSourceQuery = z.object({
  attachments: z.union([z.string(), z.array(z.string())]).optional(),
});
// 可視の複合キー（`beforeDate` / `beforeAt`）でページングし、不透明な `cursor` を使わない: 応答に新しい欄を足さずに済む。封筒（`total` / `nextCursor`）を持たない: 続きが在るかは `limit` 件ちょうど返ったかで判る。`order` は足さない（常に日付の新しい順）。
const reportsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(365).default(7),
  beforeDate: z.string().optional(),
  beforeAt: z.string().optional(),
});
// 可視の複合キーでページングし、不透明な `cursor` を使わない。`/reports` の `before*` と違い `after*` なのは揃え忘れではない: `order=asc` のとき `before` は嘘になるので、方向に縛られない語（返る順序における次）を使う。
// `afterId` と `afterAt` は必ず組で渡す: `afterAt` 単独では同じミリ秒の同着を割れず、`afterId` 単独では fs 実装が `at` からファイルを決める都合で実装によって答えが変わりうる。
const journalQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  // ISO 8601。ここより古いエントリまで遡って読むための足がかり。形は縛らない: `Date.parse` が読める形（秒の省略・オフセット付きなど）をそのまま受けたいので、検査と正規化はハンドラの中で行う。
  since: z.string().optional(),
  // `since` だけでは過去の一区間を取れない: 新しい順に返すので、最新のものが `limit` を食い尽くす。
  until: z.string().optional(),
  type: z.string().optional(),
  // `q=`（空文字列）は絞らない: 検索欄を空にした呼びが 0 件を返すと「消えた」と読まれるので `.min(1)` を掛けない。画面のために別の口を足さない。
  q: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  afterId: z.string().optional(),
  afterAt: z.string().optional(),
  // `z.coerce.boolean()` を使わない: `?horizon=false` が true になってしまう。既定は付けない（`.optional()`）: 渡さない呼びの応答を1バイトも変えない。
  horizon: z.enum(['true', 'false']).optional(),
});
// `limit` に上限（`max`）を付けない: この口は既定で全件を返すので上限を置いても何も守れない。`conversationId` は絞り込みで、頁の封筒（`total` / `nextCursor`）は増えない。
const approvalsQuery = z.object({
  pending: z.enum(['true', 'false']).default('true'),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().optional(),
  conversationId: z.string().optional(),
  // `pending=true`（明示）・`order` / `limit` / `cursor` とは併用できない（400）: 並びは決着の新しい順で固定なので意味を持たず、黙って片方を無視しない。
  answeredOn: z.string().optional(),
});

// 封筒は持たない——続きが在るかは `limit` 件ちょうど返ったかで判る。
const approvalsAnsweredDatesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(365).default(7),
  beforeDate: z.string().optional(),
});

// 位置（index）ではなく `(createdAt, id)` の比較で辿る: fs の `putApproval` は既存 id への書き込みで配列の末尾へ移動するので、頁の間に誰かが答えると位置がずれて1件飛ばす（インメモリの `Map` では再現しない。歯は `packages/storage-fs/src/index.test.ts` に置く）。`id` は同時刻の同着を割る補助キー。
// `createdAt` を文字列のまま比較する: `new Date().toISOString()` の固定形式（UTC・ミリ秒3桁・`Z` 終端）に乗っている。
const approvalsCursorSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  order: z.enum(['asc', 'desc']),
});

// `scan` が数えるのは人間との往復だけ: マネージャーとの往復・内部ターン（`self`）はこの予算を食わない。黙って打ち切らない: `scanned` と `hiddenByLimit` を返して、遡り切れていないことを呼ぶ側に見せる。
const conversationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  scan: z.coerce.number().int().min(1).max(10000).default(2000),
  // 中身は日誌の継続点（`{ id, at }`）: 同じミリ秒の同着も飛ばさず重複しない。`scan` の窓の外も継続点を辿れば読める。
  cursor: z.string().optional(),
});
// `z.coerce.boolean()` を使わない: `?includeSuperseded=false` が true になり、既定は編集後の版だけという約束が黙って壊れる。
const conversationQuery = z.object({
  scan: z.coerce.number().int().min(1).max(10000).default(2000),
  includeSuperseded: z.enum(['true', 'false']).default('false'),
});
// 既定で期間を絞らない: 絞ると「今日いくら使ったか」を聞いたつもりの人へ全期間の合計を返す取り違えが起きる。
const usageQuery = z.object({
  from: usageDateSchema.optional(),
  to: usageDateSchema.optional(),
  managerId: z.string().min(1).optional(),
  // 4つの口（API / CLI / Web / クローンの道具）へ同時に置く: 片方にだけ足すと、そこにしかできない分析が生まれる。
  layer: usageLayerSchema.optional(),
  site: usageSiteSchema.optional(),
  // 「帰属が無い分だけ」を絞る口は作らない（`usage.ts` の `usageQuerySchema`）: 取れていない分は絞らずに引いて `breakdown.byToken` の `null` を見る。
  tokenId: z.string().min(1).optional(),
});
const journalStreamQuery = z.object({
  type: z.string().optional(),
});
// 空文字を弾かない: `guardArchiveRemoval` が `reason?.trim()` の非空を override の意思表示として扱うので、ここで `min(1)` を掛けると同じ入力が契約より手前で別の応答（400）になる。
const archiveRemoveQuery = z.object({
  overrideReason: z.string().optional(),
});
const managerMessageBody = z.object({
  // 「空」は NUL を落とした後で見る: ストアは NUL を落とすので、落とす前の長さで見ると NUL だけの text が空の追加指示として届く。
  text: z
    .string()
    .min(1)
    .refine((value) => stripNul(value).length > 0),
  requestId: z.string().min(1).optional(),
  decision: z.enum(['allow', 'deny']).optional(),
});
const abortBody = z.object({
  // NUL だけの reason は、止めた後の文言と日誌の理由が空欄になるので入口で断る。
  reason: z
    .string()
    .min(1)
    .refine((value) => stripNul(value).length > 0)
    .optional(),
});
const scheduleBody = z.object({
  kind: scheduleKindSchema,
  // 「空」は NUL を落とした後で見る: 落とす前の長さで見ると NUL だけの `request` が検査を抜け、ハンドラが日誌へ書いた後で 500 になる。
  request: z
    .string()
    .min(1)
    .refine((value) => stripNul(value).length > 0),
  spec: scheduleSpecSchema,
  ifMatch: z.string().nullable().optional(),
});

const commitmentBody = z.object({
  body: z
    .string()
    .min(1)
    .refine((value) => stripNul(value).length > 0),
  // NUL だけの source は、ストアが NUL を落として空の source で残すので断る。
  source: z
    .string()
    .min(1)
    .refine((value) => stripNul(value).length > 0)
    .optional(),
});

// 理由は空を許さない: 否定する材料の無い閉じ方を受け付けると、人間が後から否定できるという最終承認の実体が崩れる（north_star）。
const commitmentCloseBody = z.object({ reason: nonBlankString });

const commitmentEditBody = z.object({
  body: z
    .string()
    .min(1)
    .refine((value) => stripNul(value).length > 0),
  ifMatch: z.string().optional(),
});

// `z.coerce.boolean()` を使わない: `?includeClosed=false` が true になり、一覧が片付いたもので埋まる。
// `GET /commitments` は既定では上限を持たない: `limit` / `cursor` を明示したときだけ窓が掛かる opt-in で、明示しない既定の呼びは応答が1バイトも変わらない。並べ替え・絞り込みは足さない（判断がクローンから器へ移る）。`limit` に `max` も付けない: この HTTP の口は人間がブラウザで扱う前提で既定は全件。
const commitmentsQuery = z.object({
  includeClosed: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().optional(),
});

// 文字列のまま受ける: `z.coerce.number()` だと空文字が 0 になり、「渡していない」「空を渡した」「0 を渡した」が区別できない。
const progressQuery = z.object({
  windowHours: z.string().optional(),
});

// 2段を跨ぐ錨は作らない: 境界を跨ぐ錨の意味を新しく決めることになりストアの契約（`CommitmentStore`）に手が入るので、錨が自分の段（`segment`）を名乗る。`id` は同時刻の同着を割る補助キー。`includeClosed` が食い違えば 400（錨は刷られた一覧の中でしか意味を持たない）。
const commitmentsCursorSchema = z.object({
  segment: z.enum(['open', 'closed']),
  key: z.string().min(1),
  id: z.string().min(1),
  includeClosed: z.enum(['true', 'false']),
});

// 何も渡さない呼びは応答が1バイトも変わらない（opt-in）: 判定は生のクエリで行う（`c.req.valid('query')` は既定値を埋めるので「渡されたか」を答えない）。
// カーソルは `/journal` 形（可視の複合キー）で、`/commitments` 形の不透明カーソルは使わない。`order` は足さない（並びは `ManagerPool.list()` が固定している）。`limit` の既定を作らない: 渡していない呼びの応答が変わり、到達できない行が生まれる（north_star 禁止2）。
// `max` を 1000 にしたのは窓の形を `/journal` と揃えるためで、資源を守る数値ではない。
const managersQuery = z.object({
  // 知らない値は 400 で断る（ハンドラで検査）: 黙って無視すると、綴りを間違えた呼びが「0件」として返り、絞り込みが効いていないことに気づけない。
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  // 「次」は返る順序の意味（`startedAt` の降順なので、錨より古い側が返る）。
  afterId: z.string().optional(),
  afterStartedAt: z.string().optional(),
});

// `managerId` は同時刻の同着を割る補助キー: `ManagerPool.list()` の並びは `startedAt` だけで決まり同着の相対順は決まっていないので、補助キーを足して初めて頁を辿っても飛ばさず重複しない。
interface ManagerPagingKey {
  startedAt: string;
  managerId: string;
}

// `localeCompare` を使う: `ManagerPool.list()` の並べ替えと同じ比較にしないと、並べ直した結果があちらの並びと食い違う。
function compareManagerPagingKey(a: ManagerPagingKey, b: ManagerPagingKey): number {
  const byStartedAt = b.startedAt.localeCompare(a.startedAt);
  if (byStartedAt !== 0) return byStartedAt;
  return b.managerId.localeCompare(a.managerId);
}

// 知らない値は捨てずに返す（呼び出し側が 400 にする）。空の要素は落とす（`/journal` の `type` と同じ形）。
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

// 値も sha256 の全体も載せない（指紋＝先頭12桁だけ）。
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

// 名前・source・id・指紋だけ（値は書かない）。
function describeIntegrationKey(key: IntegrationKeyRecord): string {
  return `「${key.name}」（id=${key.id}、source=${key.source}、指紋=${integrationKeyFingerprint(key.sha256)}）`;
}

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

// 127.0.0.1 で待つことはブラウザからの保護にならない: 任意のページから `no-cors` の fetch や HTML form（CORS の単純リクエスト）で POST でき、応答が読めなくても送信は成立する。`application/json` を要求すると preflight が必須になり、CORS ヘッダを返さないこのデーモンでは通らない（能力を削らず実行環境の境界で塞ぐ。north_star 禁止2）。本文検査の無い POST を足すときは必ず付ける（`validator('json', ...)` を持つ経路は hono が同じ検査をする）。
const deliberateClient = createMiddleware(async (c, next) => {
  if (mimeEssence(c.req.header('content-type')) !== 'application/json') {
    return c.json({ error: 'content-type: application/json が要る' as const }, 415);
  }
  await next();
});

// 部分一致で判定しない: ブラウザが単純リクエストか否かを決めるのは essence だけなので、`text/plain; note=application/json` は preflight 無しで飛ぶ。`includes('application/json')` はこれを通して穴が空く。
function mimeEssence(contentType: string | undefined): string {
  return (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

// `isDailyReport` は `@alteroid/core` の1本を使う（写しを持たない）: 出す側は「書けなかった」の印（`unavailable`）の行も出し、数える側は数えないという違いが、判定が散ると静かに逆になる。

// `required: true` でなければ契約にならない: 省略した呼び出しに `content-type` を送る義務が無く、生成クライアントが本文もヘッダも省略して 415 に当たる。サーバの方が緩い（空でも `{}` でも通る）のは意図的。関数にしてあるのは `noBodyPostResponses` と同じ（モジュールの初期化順）。
function noBodyPostRequestBody(description: string) {
  return {
    required: true,
    description,
    content: { 'application/json': { schema: {} } },
  };
}

// ステータスの数値は各経路の `describeRoute` に直に書く: 「実際に返すステータスが宣言されているか」を測る歯が、リテラルのキーを経路ごとに読む。
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

// 403（source の不一致）はここに置かず各経路の `describeRoute` に直に書く: 「実際に返すステータスが宣言されているか」を測る歯が、リテラルの `403` を経路ごとに読む。
// エラーには値を混ぜない（固定の文だけ）。判定は正規化の後（`isReservedEventSource`）: `isDaemonSelfNotice` は `source` だけで daemon 自身の知らせとみなし台帳に載せないので、外から名乗らせない。
const RESERVED_SOURCE_BODY = {
  error: 'この source は daemon 自身が使う予約語なので、外からは使えない（何も積んでいない）',
  code: 'reserved_source',
} as const;
// pg は NUL を落とし孤立サロゲートを U+FFFD へ置き換えて残すので別々の source が1つに潰れる: 黙って正規化せず入口で断る。予約語とは code を分ける（呼び手が「名前の問題」と「形の問題」を見分けられる）。
const INVALID_SOURCE_BODY = {
  error: 'source に NUL や孤立サロゲートは含められない（何も積んでいない）',
  code: 'invalid_source',
} as const;

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

// `Retry-After` は付けない: 器の瞬断で、待ち時間の目安を持たない。
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

// 定数ではなく関数にする: `app.ts` と `openapi.ts` は互いを import するので、モジュールの初期化順によってはトップレベルで即座に評価する定数がまだ空の相手の export を読んでしまう。
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

const SSE_CREDENTIAL_LOST_MESSAGE =
  'この接続の資格が使えなくなった（ログアウト・許可の取り消し・期限切れのどれか）ので、流れを閉じる。';

// `/auth/me` と `/auth/logout` だけは認証が要る: logout は提示している資格そのものを失効させる設計なので、提示なしに叩ける素通しの口にしない。
function isPublicPath(path: string): boolean {
  if (path === '/health' || path === '/openapi.json' || path === '/docs') return true;
  if (path === '/auth/me' || path === '/auth/logout') return false;
  return path === '/auth' || path.startsWith('/auth/');
}

// 値は1文字も含めず `path` だけを見る: issue の `message` は zod の文言に入力値を埋め込むことがあり、`hook` を渡さないと `@hono/standard-validator` の既定の 400 がリクエスト本文をまるごと返すという対処が無意味になる。
function whereValidationFailed(issues: readonly { readonly path?: readonly unknown[] }[]): string {
  return issues
    .map((issue) => issue.path?.map((part) => String(part)).join('.') ?? '')
    .filter((path) => path.length > 0)
    .join(', ');
}

// `app.ts` の中で `validator('json', ...)` を直接書かない: `hook` を渡し忘れた経路だけ `@hono/standard-validator` の既定の 400（本文そのものを返す）に落ちるので、ここへ集約して付け忘れを作れなくする。`onInvalid` を上書きしてよいのも、混ぜてよいのは `where` だけで送られてきた値は混ぜない。
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

// `app.ts` の中で `validator('query', ...)` を直接書かない（`jsonBody` と同じ理由）: `hook` を渡さないと既定の 400 がクエリそのものと zod の issue 配列を返す。
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

// 拒否はデーモンのプロセス内にしか無い像なので外向きの面でだけ合流させ、core の interface へ混ぜない（台帳へ持ち越さない）。拒否が無いときはキーごと載せない: `[]` は「0 件だった」と読めるが、実際は「この器では数えていない」でもありうる。
function managerView(managers: ManagerPool, summary: ManagerSummary) {
  const denials = managers.denials(summary.managerId);
  return {
    ...summary,
    ...(denials.length === 0 ? {} : { denials }),
    // 取れなければ欄ごと載せない（クローンの道具と同じ読み方。既定の帯で埋めない）。
    ...managerModelsOf(managers, summary),
  };
}

// 固定の `'operator'` を書かない: `grantedBy` は「誰が許可したか」を持つ欄で、常に同じ値なら情報を運ばず、事後に追えるという最終承認の実体が記録の側から崩れる。`grantedBy`（正本）は突き合わせ用に id だけ、`grounds` は人間が読む文（`describeActor`）。
function actorOf(principal: Principal): string {
  if (principal.kind === 'operator') return 'operator';
  if (principal.kind === 'integration') return `integration:${principal.keyId}`;
  return principal.account.id;
}

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

function describeActor(principal: Principal): string {
  if (principal.kind === 'operator') return '実行環境の持ち主による操作';
  // 鍵の値は書かない（id と名前だけ）。`Principal` を網羅するために持つ。
  if (principal.kind === 'integration') {
    return `連携の鍵「${principal.name}」（${principal.keyId}）による操作`;
  }
  return `許可されたアカウント（${principal.account.id}）による操作`;
}

// 鍵の値は含めない（識別子だけ）。
function installerOf(principal: Principal): string {
  if (principal.kind === 'operator') return 'operator';
  if (principal.kind === 'integration') return `integration:${principal.keyId}`;
  return `account:${principal.account.id}`;
}

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

// 配布が投げても失敗にしない: 保存は済んでいる（応答に失敗として載せ、失敗した runner へは名乗り直しで降ろし直す）。
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

function describePluginDelivery(runners: ApplyPluginsResult['runners']): string {
  const text = runners
    .map(
      (r) =>
        `${r.runnerId}=${r.ok ? 'ok' : r.unsupported === true ? '口なし（古い runner）' : '失敗'}`,
    )
    .join(', ');
  return text.length === 0 ? '配る先なし' : text;
}

// id・ラベル・操作の種類だけで、トークンの値も指紋も書かない。
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

function describeTokenPolicyChanges(changes: readonly TokenPolicyChange[]): string {
  return changes
    .map((change) => `${change.field}: ${change.from ?? '読めなかった'} → ${change.to}`)
    .join('、');
}

// 落ちたら跡だけ残して握る: ここへ来る時点で状態変更は既に効いているので、`.onError` へ抜けて 500 にすると操作そのものが失敗したと誤読される（欠けるのは監査の行だけ）。pg のトランザクションで束ねる案は採らない: fs ストアでは状態変更と日誌の追記を1操作にできない。
// `detail` に本文を入れない（`noteDroppedRecord` の「本文は出さない」と同じ理由）: id や件数だけ。
// 能力を広げる口は、状態変更の後にこの関数を当てない: 日誌が落ちると記録の無い変更が生まれるので、日誌を先に書き、書けなければ状態を変えずに 500 にする。状態変更が投げたら打ち消しの行をこの関数で足す（記録が多すぎる側に倒す）。状態変更の後でないと分からない情報は2行目として best-effort で足す。
// 戻り値は書けた行（書けなければ `undefined`）: `PUT /memory/:slug` だけが `markHumanTouched` へ渡すために見る（日誌に行が無いのに派生値だけ立てると対応が崩れる）。
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

function journalWriteFailedBody(): { error: string; code: typeof JOURNAL_WRITE_FAILED_CODE } {
  return { error: JOURNAL_WRITE_FAILED_MESSAGE, code: JOURNAL_WRITE_FAILED_CODE };
}

// 日誌を先に書き、書けなければ状態を変えずに投げ直す。日誌に残すのは消す id と件数だけで行の中身は書かない。指した id が読めない行に1つでも無ければ何も消さず日誌も書かずに `unknown`（指された文字列は返さない）。例外の本文は日誌にも応答にも載せない（種類 `name` だけ）。
async function removeUnreadableRowsWithJournal(params: {
  stores: Stores;
  subject: string;
  actor: string;
  route: string;
  requested: readonly string[];
  remove: (
    ids: readonly string[],
    options: RemoveUnreadableRowsOptions,
  ) => Promise<RemoveUnreadableRowsResult>;
}): Promise<RemoveUnreadableRowsResult | { kind: 'failed' }> {
  const { stores, subject, actor, route } = params;
  // `let` ではなく入れ物にする: 閉じ込めで代入するので型の絞り込みが `never` に倒れる。
  const written: { detail?: string } = {};
  let result: RemoveUnreadableRowsResult;
  try {
    result = await params.remove(params.requested, {
      beforeRemove: async (ids) => {
        await stores.journal.append({
          type: 'decision',
          decision: `読めない${subject}の行を ${String(ids.length)} 件消そうとしている（id: ${ids.join(', ')}）`,
          grounds: `${actor}（${route}）。消すのは id で指した読めない行だけ。行の中身は書かない。`,
        });
        written.detail = `ids=${ids.join(',')}`;
      },
    });
  } catch (error) {
    const journaled = written.detail;
    if (journaled === undefined) throw error;
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
  // pg は日誌をトランザクションの外で書くので、日誌と再確認のあいだに行が変わりうる: 何も消していないので「消そうとしている」の行を打ち消す。
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

// `message` を含めない: ストアのエラー文には行の中身（トークンの値）が載りうる。
function kindOfError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// `message` も `reasonOf` も使わない: 鍵を運ぶ呼び出しなので、例外の文面（`RunnerHttpError` は応答本文をそのまま `message` に入れる）に送った値が載ると1行目の断片でも鍵が出る。出すのは識別子の形の `error.name`（でなければ `Error`）と `RunnerHttpError` の `status` だけ。
function credentialDeliveryFailureOf(error: unknown): string {
  const name =
    error instanceof Error && /^[A-Za-z0-9_.]{1,64}$/u.test(error.name) ? error.name : 'Error';
  const status =
    error instanceof RunnerHttpError && Number.isInteger(error.status)
      ? `、HTTP ${String(error.status)}`
      : '';
  return `${name}${status}`;
}

// 変換を core に置かない: `packages/core` は `apps/daemon` の `Principal` を知らない（層が逆）。`operator` の `auth` はそのまま運ぶ: `authenticate` で枝が確定しているので判定し直さない。
function answerApprovalViaOf(principal: Principal): AnswerApprovalVia {
  if (principal.kind === 'integration') {
    // 連携の鍵は人間が答えた証拠にならない（`authenticate` が既定で拒否する）。
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

// ここで alteroid を操作させない（Web UI は非ゴール）。`autoClose` の成否を判定しない: 同じタブごと遷移していた場合 `window.close()` は黙って何もしないが、メッセージ「閉じて端末に戻る」がフォールバックになる。
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

// 書き換える3本の口（`PUT /profile` / `PUT /profile/:name` / `DELETE /profile/:name`）はここ1か所に寄せる: 別々だと片方だけに検査や日誌が入って「人間が置くと弾かれるのにクローンが置くと通る」が生まれる。日誌を先に書く（書けなければ差し替えずに 500）。シェルの stderr は入力の行を引用し `set -x` は値ごと吐くので `redactProfileFailure` で伏せてから返す。値は日誌に1文字も書かない。
async function mutateProfile(
  deps: AppDeps,
  spec: {
    actor: string;
    route: string;
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
    await appendJournalOrDrop(
      deps.stores,
      {
        type: 'decision',
        // 文言では見分けない（`ProfileRollbackFailedError` で見る）: 反映も書き戻しも落ちたときは状態どおりの行にする。
        decision:
          error instanceof ProfileRollbackFailedError
            ? `実行環境プロファイルの差し替えが途中で止まった（正本は新しい版のまま・クローンは前の版）${label}`
            : `実行環境プロファイルを差し替えられなかった${label}`,
        grounds: `${spec.actor}（${spec.route}、状態の変更が失敗）: ${kindOfError(error)}`,
      },
      '実行環境プロファイルの打ち消しの日誌',
      spec.route,
    );
    // `detail` に載せるのはこちらが組んだ文だけで、送られてきた本文は載せない。
    if (error instanceof ProfileInputError) {
      return {
        ok: false,
        body: { error: 'プロファイルの入力が不正（保存していない）', detail: error.message },
      };
    }
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
    // 保存も配布もしていなくても打ち消しの行を足す: 記録が多すぎる側の穴は、記録の無い差し替えより安全側。
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

  // 差し替え自体はもう効いているので、配布の成否は後から2行目として足す（落ちても 500 にしない。値は1文字も書かない）。
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
          ? // 旧来の全部差し替えは1本の時代と同じ文言: 日誌を読む側と歯がこの文言で見ている。
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
      // 成功でも `set -x` の出力（値入り）は `output` に載るので伏せる。
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

// 戻り値を1つの値に畳まない: 「空」と「聞けなかった」が同じ形になるので `*Probe` を必ず一緒に組み立てる。理由は `reasonOf` を通す: 例外は失敗した呼び出しのパラメータを添えることがあるので、素の `String(error)` を応答へ載せない。
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
  const attachmentBodyMax = attachmentBodyMaxBytes(attachmentLimits);
  // `hono/body-limit` を使わない: chunked の本文を上限まで溜めるので 2 GiB の枠では使えない。content-length があって超えるときだけ断り、それ以外は溜めずに流しながら数える（置き場の上限と食い違ってもここの上限は必ず効く）。
  const attachmentUploadSizeGate = createMiddleware(async (c, next) => {
    const tooLarge = () =>
      new AttachmentRejectedError('too_large', `添付は 1 つ ${attachmentBodyMax} バイトまで`);
    const raw = c.req.raw;
    if (raw.body === null) {
      await next();
      return;
    }
    const declared = raw.headers.get('content-length');
    if (declared !== null && !raw.headers.has('transfer-encoding')) {
      if (Number(declared) > attachmentBodyMax) {
        return c.json({ error: tooLarge().message, code: 'too_large' as const }, 413);
      }
      await next();
      return;
    }
    const reader = raw.body.getReader();
    let size = 0;
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        size += value.length;
        if (size > attachmentBodyMax) {
          const refusal = tooLarge();
          controller.error(refusal);
          await reader.cancel(refusal).catch(() => undefined);
          return;
        }
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    c.req.raw = new Request(raw, { body: counted, duplex: 'half' } as RequestInit);
    await next();
  });

  // 日誌を引く側（`findReceivedClientMessage`）が耐久の本体で、こちらは受信箱へ積んでから日誌へ載るまでの窓と同時の2本の再送を塞ぐだけ（プロセスが落ちれば消える）。古いものから捨てる上限つき。
  const receivedClientMessages = new Map<string, ReceivedClientMessage>();
  const RECEIVED_CLIENT_MESSAGES_MAX = 2048;
  interface ReceivedClientMessage {
    readonly conversationId: string;
    readonly fingerprint: string;
    readonly settled?: Promise<boolean>;
  }

  // 別の会話の判定が先: 会話が違えば中身を比べても意味がない。
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
  const CLIENT_MESSAGE_LOOKUP_SCAN = 200;

  // 日誌だけで判定しない: 新しい会話の1通目は `open` で id を返した後に日誌へ載る（`clone.post` は器への書き込みを待たない）ので、直後の追送が「無い会話」として断られる。
  const startedConversations = new Set<string>();
  const STARTED_CONVERSATIONS_MAX = 2048;
  function rememberStartedConversation(conversationId: string): void {
    startedConversations.add(conversationId);
    if (startedConversations.size > STARTED_CONVERSATIONS_MAX) {
      const oldest = startedConversations.values().next();
      if (oldest.done !== true) startedConversations.delete(oldest.value);
    }
  }

  async function findReceivedClientMessage(
    clientMessageId: string,
  ): Promise<ReceivedClientMessage | undefined> {
    const remembered = receivedClientMessages.get(clientMessageId);
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
          // 日誌の本文は NUL を落として残してある: 指紋の側が同じ規則を通すので比べ方はずれない。
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

  // 同期で呼ぶ（`await` を挟まずに「無ければ入れる」を1歩にして、同時の2本のうち片方だけが入る）。添付の検査・結び付けより前に呼ぶ: 後だと同時の2本が両方結び付けへ進み、片方が `attachment_conflict` になる。落ちた送信の id は覚えない（直した再送を重複と読まない）。`settle(false)` は先に Map から外してから待っている側を起こす。
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

  // `clone.post` の前に呼び、`ok: false` ならイベントを投函しない: 添付を黙って落として本文だけ送らない。連携の鍵のときだけ「同じ鍵が上げたもの」に絞る。
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

  // 受信箱へ書けなかったときも投げたときも結んだ添付を戻す: 戻さないと送り直し（新しい id）が `attachment_conflict` で断られ、死んだ id に結ばれた添付は掃除の対象からも外れて期限まで残る（503 は「送り直してよい」の約束）。戻すのはこの id に結んだ分だけ。
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

  // 購読はデーモンが起きている間ずっと続くので解除しない。
  const topologyActivity = createTopologyActivityTracker();
  if (deps.journalEvents !== undefined) topologyActivity.attach(deps.journalEvents.subscribe);
  if (deps.workerToolEvents !== undefined) {
    topologyActivity.attachWorkerTools(deps.workerToolEvents.subscribe);
  }
  const topologyStorage = createStorageHealthTracker({
    label:
      deps.storage === undefined
        ? undefined
        : deps.storage.startsWith('PostgreSQL')
          ? 'postgres'
          : 'fs',
    probe: deps.storageProbe,
    now: Date.now,
  });
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
  const integrationClock = deps.now ?? (() => new Date());
  const integrationRateLimiter = createFixedWindowRateLimiter(() => integrationClock().getTime());
  // 鍵の値は出さない（id だけ）。
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

  // operator の資格で張った流れは確かめ直さない: 失効させる口が無い資格。判定できない（ストアが投げた）ときは閉じる側へ倒す: 閉じてもクライアントは張り直せる。前の確かめ直しが終わっていなければ重ねない。
  function watchSseCredential(principal: Principal, authorization: string | undefined) {
    const bearer = principal.kind === 'account' ? bearerOf(authorization) : null;
    let lost = false;
    let checking = false;
    return {
      lost: () => lost,
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
  // ループを2本の口で別々に持たない: 資格が尽きたときの閉じ方や心拍の扱いが片方だけ変わる。購読は呼び出し側で済ませてからここへ来る（`try` を購読の直後から始めるため）。
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
        // `try` は購読の直後から始める: `clone.post` や `open` の書き込みが投げたときに購読が漏れる。
        try {
          // 人間が chat を閉じても、クローンのターンは走り続ける: ここで手放すのは購読だけ。
          stream.onAbort(() => {
            finished = true;
            wake?.();
          });

          // heartbeat は死んだ接続の掃除の契機でもあり、1拍ごとに資格も確かめ直す。
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
                // 閉じる前に理由を1つ送る: 画面が「接続が切れた」と区別できるように、既存の `error` イベントの形で言う。
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
  // 1プロバイダにつき1本だけ: 用途ごとに URL を増やすと token 交換時の `redirect_uri` 不一致が起きやすい。
  const callbackUrl = (provider: string) => `${authPlan.publicBaseUrl}/auth/${provider}/callback`;

  // 通す条件は2つだけ（実行環境の持ち主の token・許可されたアカウントのアクセストークン）: 行為ごとの許可表を持たない。持つと「確認が要る行為の一覧」と同じ形になり、クローンの判断を設定で置き換えることになる。
  const authenticate = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (isOperator(c, deps.token)) {
      c.set('principal', { kind: 'operator', auth: 'operator-token' });
      await next();
      return;
    }
    // 認証が無効の構成でも `altk_` の bearer が付いていれば照合と制限を掛ける（bearer が無ければ素通し）。
    if (!isPublicPath(c.req.path)) {
      const presented = bearerOf(c.req.header('authorization'));
      if (presented !== null && looksLikeIntegrationKey(presented)) {
        return authenticateIntegrationKey(c, next, presented);
      }
    }
    if (!authPlan.enabled) {
      // 守りは待ち受け先（既定 127.0.0.1）と手前に置く境界の側にある。
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
    // `POST /auth/logout` だけは許可の無いアカウントも通す: 403 にすると許可待ちのトークンが失効させられず、後から `access grant` した瞬間に捨てたつもりのトークンが生き返る（CLI の `logout` も 403 を失敗と読む）。logout は提示したトークン自身を失効させるだけなので何も許さない。
    if (!isAccountGranted(account) && c.req.path !== '/auth/logout') {
      // 401 ではなく 403: やり直しても解決しない（人間が `access grant` を実行する）。
      return c.json({ error: 'このアカウントには alteroid を使う許可が無い' }, 403);
    }
    c.set('principal', { kind: 'account', account });
    await next();
  });

  // 既定で拒否し、この資格にだけ制限を掛ける（人間・operator の経路に新しい制限は足さない）。通すのは `POST /events`（source の一致はハンドラが判定）・`POST /events/:source` と、添付のアップロード `POST /attachments`（読み出しは通さない）だけ。`maxBodyBytes` は `/events*` にだけ掛ける: 添付のアップロードにも掛けると 1 MiB 超の画像を上げられず添付の意味が無い。断った試みは日誌に書かずデーモンのログへ。
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
    // 添付のアップロードの本文上限は、その口自身の `attachmentUploadSizeGate`（と置き場の流しながらの数え）が持つ。
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

  // 経路の本数をここで数え直さない: 数え上げの持ち主は `scripts/require-operator-routes.test.ts` の `EXPECTED_OPERATOR_ROUTES`。ここに残るのは `/profile` の読み書き2本と owner 宣言の口2本で、応答本文に鍵が丸ごと載るか実行環境そのものを差し替える口だから。
  const requireOperator = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (c.get('principal').kind !== 'operator') {
      return c.json({ error: '実行環境の持ち主だけが操作できる' as const }, 403);
    }
    await next();
  });

  // 何も弾かない（許可済みのアカウントは持ち主として通す。弾く仕事は `authenticate`）。配線から外さず中身だけ素通しにする: 戻すのが1箇所で済み、配線を外すと戻すときに経路ごとに付け直す羽目になって付け忘れが静かに「許可済みなら誰でも」へ落ちる（`EXPECTED_OWNER_ROUTES` の歯も配線を保てば変えずに済む）。正典は `docs/architecture.md`「デーモンの API に入る資格」。
  const requireOwner = createMiddleware<{ Variables: AuthVariables }>(async (_c, next) => {
    await next();
  });

  // 確定は取り直さず預かったものをそのまま保存する: 確認から確定までに取り元が動いても、見せたものと入れるものがずれない。
  const pluginPreviews = createPluginPreviewStore(
    deps.pluginPreviewNow === undefined ? {} : { now: deps.pluginPreviewNow },
  );

  // 二重の門: `authenticate` が既定で拒否するが、配線のずれ・将来の変更で鍵が管理の口へ入れないよう口の側でも断る（鍵が仲間の鍵を発行・失効できたら配布範囲の境界が崩れる）。
  const humanOnly = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (c.get('principal').kind === 'integration') {
      return c.json({ error: '連携の鍵では、鍵の管理はできない' as const }, 403);
    }
    await next();
  });

  const base = new Hono<{ Variables: AuthVariables }>();

  // hono の既定のハンドラの `console.error(err)` を使わない: 例外を丸ごと stderr へ出すので、リクエストの値を抱えた例外（`fetch` / DB ドライバ / `execFile`）がそのまま器の外へ出る。`reasonOf` は既存の口をそのまま使う: 同じ判断（1行目だけ・200字）を2箇所に持つとずれる。
  base.onError(async (err, c) => {
    if ('getResponse' in err) {
      const res = err.getResponse();
      // hono の validator が壊れた JSON に投げる `HTTPException` は `text/plain` で `jsonBody` の `hook` には届かないので、`text/plain` のときだけ `{ error }` の JSON に畳む。
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

  base.notFound((c) => c.json({ error: 'not found' }, 404));

  // CORS は認証より先に登録する: preflight（OPTIONS）は `Authorization` を積んで来ないので、門番が先に立つと 401 になり本リクエストが飛ばない。`cors()` は OPTIONS に答えて `next()` を呼ばないので門番も素通りしない。列挙が空なら何も登録しない（CORS ヘッダを返さない姿勢のまま）。
  const allowedOrigins = deps.allowedOrigins ?? [];
  if (allowedOrigins.length > 0) {
    base.use(
      '*',
      cors({
        // `*` は返さない（`AppDeps` の注記）。
        origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
        // 新しいメソッドの経路を足したらここも一緒に見る: 更新し忘れると、別オリジンの画面からの操作だけが preflight に静かに落とされる（`app.test.ts` の「アプリが出しているメソッドは全部 CORS が許している」が拾う）。
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        // `content-type` は `deliberateClient` が、`authorization` は門番が要求する: 後者を落とすと別オリジンの画面はログイン済みでも何も呼べない。
        allowHeaders: ['content-type', 'authorization'],
        // Cookie は運ばせない。資格情報はヘッダで運ぶ。
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

    // `isPublicPath` に入れない: 内部のホスト名・DB 名・ホームのパスは、ログインしていない相手に読ませない。
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
        const refusal = clone.sessionRefusal?.() ?? null;
        return c.json(
          statusResponseSchema.parse({
            storage: deps.storage ?? '',
            ...(refusal === null ? {} : { cloneSessionRefusal: refusal }),
          }),
        );
      },
    )

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
      attachmentUploadSizeGate,
      queryParams(attachmentUploadQuery),
      async (c) => {
        const { name, type, keep } = c.req.valid('query');
        const principal = c.get('principal');
        // 連携の鍵は保存の印を付けられない: 期限なしで預けられると、鍵ごとの預け量の枠が無い前提が崩れるため
        if (keep === true && principal.kind === 'integration') {
          return c.json(
            {
              error: '連携の鍵は保存の印（keep）を付けられない（期限なしで預けられない）' as const,
            },
            403,
          );
        }
        // 本文は流したまま置き場へ渡す（上限は置き場が流しながら数える）。
        const raw = c.req.raw.body;
        const body: AsyncIterable<Uint8Array> =
          raw === null ? Readable.from([]) : Readable.fromWeb(raw as NodeWebReadableStream);
        try {
          const meta = await stores.attachments.putStream({
            name: name ?? '',
            mediaType: type,
            body,
            ...(keep === true ? { kept: true } : {}),
            uploadedBy: uploaderOf(c.get('principal')),
          });
          return c.json(meta, 200);
        } catch (error) {
          if (error instanceof AttachmentRejectedError) {
            // `reasonOf` ではなく `redactErrorText`: `reasonOf` は型名と code で包むので、Web・CLI・TUI がそのまま出す理由に混ざる。伏せ字は外さない。
            return c.json(
              { error: redactErrorText(error.message, process.env), code: error.code },
              error.code === 'too_large' ? 413 : 400,
            );
          }
          throw error;
        }
      },
    )

    // `/attachments/limits` と `/attachments/:id` より前に置く: あとから足す経路で取り違えない並びを固定する（Hono は定義順に当てる）。
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

    // `/attachments/:id` より前に置く: `limits` を id と取り違えない。
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
        const found = await stores.attachments.open(c.req.param('id'));
        if (found === undefined) return c.json({ error: 'not found' as const }, 404);
        const { meta, stream } = found;
        return c.body(Readable.toWeb(stream) as ReadableStream, 200, {
          'content-type': SAFE_MEDIA_TYPE.test(meta.mediaType)
            ? meta.mediaType
            : 'application/octet-stream',
          'content-length': String(meta.size),
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
        // 写しは本体が無かったときも消す: 本体だけ先に消えて取り残された写しを片付ける。
        if (deps.attachmentCopiesDir !== undefined) {
          await removeAttachmentCopy(deps.attachmentCopiesDir, id);
        }
        if (!removed) return c.json({ error: 'not found' as const }, 404);
        return c.body(null, 204);
      },
    )

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

        // 検査（`supersedes`・添付）より前に見る: 1回目で受けた編集は再送のときには既に「置き換え済み」で、検査へ進むと自分自身に 400 を返す。
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

        // 確かめずに積まない: 会話は日誌から暗黙に在るので、URL の打ち間違いや略記がそのまま新しい会話になる。重複の再送（上）より後に置く: 1回目の再送は日誌に載る前でも重複として応える。
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

        // `supersedes` の検証と添付の検査・結び付けより前に先取りする: 後だと同時の編集の2本目が早い確認を抜けたあと1本目が日誌へ載り「置き換え済み」の 400 になる。取れなかった側は1本目の検査が終わるのを待つ: 重複の 200 は「受け取った」と言う応えなので、1本目が検査に落ちて取り下げたなら言えず、取り直して自分で検査する。取れなかった側は添付に触れない。新しい会話の重複は、こちらが引いた `conversationId` ではなく先に取った側の会話を指す。
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

        // 検証に落ちた送信の id は覚えない: 先取りを取り下げてから 400 を返す。
        const failEdit = (body: { error: string }, status: 400 | 409) => {
          claim?.settle(false);
          return c.json(body, status);
        };

        // `clone.post` を呼ぶ前に弾く: 弾いたときは日誌に何も積まない。
        if (supersedes !== undefined) {
          try {
            if (given === undefined) {
              return failEdit(
                { error: 'supersedes を指定するには conversationId が要る' as const },
                400,
              );
            }
            // 対象は `journal.get` で直接引く: `scan`/窓には縛られない。
            let target: JournalEntry | null;
            try {
              target = await stores.journal.get(supersedes);
            } catch (error) {
              // 在るが読めない行を「見つからない」（400）と言わない: 他の `Unreadable*Error` と同じ 409。
              if (error instanceof UnreadableJournalEntryError) {
                return failEdit({ error: error.message }, 409);
              }
              throw error;
            }
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
            if (target.role === 'outbound') {
              return failEdit(
                { error: 'supersedes はクローンの応答ではなく人間の発言だけを指せる' as const },
                400,
              );
            }
            // 置き換え済みかは畳み込み規則（`computeSupersededIds`）でしか判定できない: 表示用の窓ではなく全履歴が要るので `scan` に事実上の無制限を渡す。
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

        // 弾いたら（例外も）先取りを取り下げる: 検査で落ちた送信の id は覚えない。
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
              // `open` を書く前に積む（順序に意味がある）: `open` は「投函はもう済んだ」の合図で、追送だけしたい呼び（Web UI）は `open` を見た時点で接続を捨てる。逆順だと `stream.onAbort` が走った後にここへ来て、積む前に抜ける経路が生まれ発言が黙って消える。購読は手前で張ってあるので `queued` も取りこぼさない。
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
          // `await` を挟む前に呼ぶ: 写しを取ることと購読を張ることは `attach` の中で同じ同期区間に入り、挟むと継ぎ目に出来事が割り込む。
          const { inProgress, pending, unsubscribe } = attach(conversationId, (event) =>
            pump.push(event),
          );
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
              // いままでの分を先、続き（`pump` の列）を後に流す: `pump` の列には `attach` より後の出来事だけが入るので、順序も重複も崩れない。
              for (const event of inProgress ?? []) {
                await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
              }
            },
          );
        });
      },
    )

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
        // 壊れた JSON を対象なしとは読まない: 別の仕事を止めてしまう。
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
        let cursorPayload: ConversationCursor | undefined;
        if (cursor !== undefined) {
          const decoded = decodeConversationCursor(cursor);
          if (decoded === null) return c.json({ error: new InvalidCursorError().message }, 400);
          cursorPayload = decoded;
        }
        // 数え方は `collectConversations` が持つ: ここで数え直さない。
        const readView = await loadConversationReadView(
          stores.conversationReads,
          (deps.now ?? (() => new Date()))().toISOString(),
        );
        // 窓の組み立てを手組みし直さない: `with` を絞り忘れる余地が生まれる。クローンの道具（`conversation_read`）と同じ規則を通すので、人間には見えるがクローンには見えない、が増えない。
        let page: Awaited<ReturnType<typeof readConversationPage>>;
        try {
          page = await readConversationPage(stores.journal, {
            limit,
            scan,
            readView,
            ...(cursorPayload === undefined ? {} : { cursor: cursorPayload }),
          });
        } catch (error) {
          // 継続点が指す発言が見当たらないのは判定できないという第3の状態: 黙って先頭から返さず 400 にする。
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
          scanned: page.scanned,
          reachedStart: page.reachedStart,
          // 窓の中の数であって窓の外は数えていない: `reachedStart` が偽ならさらに古い会話が在りうる（その場合も `nextCursor` が載る）。
          hiddenByLimit: page.hiddenByLimit,
          // `hiddenByLimit > 0` か `reachedStart === false` なら載る: 窓の外が残るのに黙って途切れない。`reachedStart: false` は窓が `scan` 件ちょうどだっただけのこともあるので、辿った先が空で終わることはある（安全側）。
          ...(page.next === null ? {} : { nextCursor: encodeConversationCursor(page.next) }),
        });
      },
    )

    // `/conversations/:id` より前に置く: `:id` に `unread-count` が食われる。
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
        const entries = await readConversationWindow(stores.journal, { scan });
        // 常に `includeSuperseded: true` で1回だけ呼ぶ: 既定の応答でも `supersededCount` を数える必要があるので、まず畳まれた分も含めて取り、既定ビューに戻すかはここでふるう。応答に載せる項目は明示して写す（共有の型の項目が増えても応答が増えない）。
        const allMessages = conversationMessages(entries, id, { includeSuperseded: true });
        const supersededCount = allMessages.filter(
          (message) => message.supersededBy !== undefined,
        ).length;
        const visible = includeSuperseded
          ? allMessages
          : allMessages.filter((message) => message.supersededBy === undefined);
        // 進行中の状態（走っている・順番待ち）は `GET /chat/:id/stream` の `open.pending` が持つので、ここでは持たない。
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
          ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
          ...(message.clientMessageId === undefined
            ? {}
            : { clientMessageId: message.clientMessageId }),
        }));

        // ちょうど同数のときはまだあるかもしれないので届いていない側へ倒す（安全側）。
        const reached = reachedStart(entries.length, scan);

        // 一律 404 にしない: 消えた会話とまだ見ていない会話が区別できなくなる。遡り切れているときだけ「無い」と言い、切れていなければ空の結果に `reachedStart: false` を添えて判定を呼ぶ側へ渡す。
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
          scanned: entries.length,
          reachedStart: reached,
          // `includeSuperseded` によらず常に含める: 出ないと人間の側の器も畳まれた版の存在に気づけない。
          supersededCount,
        });
      },
    )

    // `through` は発言の id で時刻は日誌から引く: クライアントから時刻を受け取ると「いま」で既読にして見ていない分まで既読にする誤りが起きる。
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
          // 在るが読めない行を「見つからない」（404）と言わない。
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
        // 基準時刻が無ければ先に決める: 位置より後に基準時刻が決まる順を作らない。
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

    // クローンの道具には同じ口を作らない: 消すのは持ち主の判断（オーナーの指定）。
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
        // メモリに残る会話 id の控えも落とす: 消した会話を「振った id」として受け直さない。
        startedConversations.delete(id);
        for (const [clientMessageId, received] of receivedClientMessages) {
          if (received.conversationId === id) receivedClientMessages.delete(clientMessageId);
        }
        return c.json(conversationDeleteResponseSchema.parse(result));
      },
    )

    // 種別を選り分ける表を持たない（絞り込みは呼ぶ側が指定する）: 見えない層を作らないための口で選別を始めたら意味が消える。
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

          // `try` は `subscribe()` の直後から始める（`/chat` と同じ理由）。
          try {
            stream.onAbort(() => {
              closed = true;
              wake?.();
            });

            // 資格が使えなくなったら閉じるだけで理由のイベントは流さない: この流れのデータは日誌の1件の形で読まれるので日誌でないものを混ぜない（読み手は切断として扱い、張り直しで 401 を受ける）。
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

    // 取れないものは `unknown` と言い、取れたふりをしない。線は最後の活動の時刻だけを返す（「いま流れている」の閾値は読み手が決める）。
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
                  // どちらも共有の結果を使う: 購読者が何人でも台帳を読む回数が窓ごとに高々1回。
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
                  // 理由は種別だけ: 本文は接続先などを含みうる。立ち直ったら内容が同じでも必ず送り直す（`last` を捨てる）。ストリームごとは落とさず次の周期でやり直す。
                  last = null;
                  if (!failing) {
                    failing = true;
                    await stream.writeSSE({
                      event: 'unavailable',
                      data: JSON.stringify({ error: describeProbeError(error) }),
                    });
                  }
                }
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
        // `PUT`/`DELETE` と同じ門: ここが無いと `FsPersonaStore#path` が投げる例外が `onError` まで抜けて 500 になり、同じ入力なのに応答が違う。
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
          // 黙って上書きしない: 書いていないので日誌にも積まない。
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
        // 書き換え自体は効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`）。
        const entry = await appendJournalOrDrop(
          stores,
          {
            type: 'memory_update',
            slug,
            cause: 'human',
            action: 'write',
            // クローンの道具（memory_write）と同じ機械可読な面: 片方だけ足すと「人間の書き込みだけ数えられない」が生まれる。
            bytesBefore: before === null ? 0 : Buffer.byteLength(before.content, 'utf8'),
            bytesAfter: Buffer.byteLength(doc.content, 'utf8'),
            summary: 'HTTP API 経由で人間が記憶を書き換えた',
          },
          '記憶書き換えの日誌',
          `slug=${slug}`,
        );
        // 日誌への追記が落ちたとき（`entry === undefined`）は呼ばない: 裏付けとなる `cause:'human'` の行が無いのに派生値だけ立てると対応が崩れる。
        if (entry !== undefined) {
          await stores.persona.markHumanTouched(slug, entry.at);
        }
        return c.json({ document: doc, version: memoryVersion(doc.content) });
      },
    )

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
        // `markHumanTouched` はここでは呼ばない: `PersonaStore.remove` が保護状態の派生値も一緒に消す（実体の無い印は監査上の嘘になる）ので、印を立てても同じ操作の中で消える。delete は「人間の意思で消した」であって、将来ここに書かれる新しい内容を無条件に保護する理由にならない。
        try {
          await stores.persona.remove(slug, { ifMatch });
        } catch (error) {
          // 黙って消さない: 消していないので日誌にも積まない。
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
        // 削除自体は効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`）。
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

    // `apply` / `enforce` に当たる経路を足さない: 「このやり方に従え」という操作はどの入口にも存在しない（`docs/north_star.md`）。やり方は読む素材で、従うかはそのときのクローンが決める。
    // 日誌は `practice_write` / `practice_remove`（クローンの道具）と同じ `type: 'decision'` に揃える: 揃えないと同じ操作が人間経由かクローン経由かで日誌の型が変わる。
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
        // 0 件なら鍵ごと無い: 既存の呼び手の応答を1バイトも変えない。
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
        // `PUT`/`DELETE` と同じ門: ここが無いと不正なスラッグが store の `read()` へ渡って 404 になり、応答形が `PUT`/`DELETE` と違う。
        const slug = c.req.param('slug');
        if (!practiceSlugSchema.safeParse(slug).success) {
          return c.json({ error: 'やり方のスラッグが不正' as const }, 400);
        }
        // 読めない行は素の 500（`onError` 任せ）にせず、何が起きたかが分かる 409 にする。
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
        // `UnreadablePracticeError` を捕まえて先へ進む: 投げっぱなしにすると PUT がここで落ち、壊れた行を書き直す唯一の回復手段が塞がる。
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
          // 黙って上書きしない: 書いていないので日誌にも積まない。
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
        // 書き換え自体は効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`）。
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
            target: { kind: 'practice', slug },
          },
          'やり方書き換えの日誌',
          `slug=${slug}`,
        );
        return c.json({ practice, version: practiceVersion(practice) });
      },
    )

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
        // `UnreadablePracticeError` を捕まえて先へ進む: 投げっぱなしにすると DELETE がここで落ち、壊れた行を消す唯一の HTTP 経由の手段が塞がる。本当に無い場合だけ 404。
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
        // 読めない形の行（`wasUnreadable`）は版なしで消せる: 読めない行には版が無く（`GET` も 409）、ここで断ると壊れた行を外す回復手段が塞がる。
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
          await stores.practices.remove(slug, ifMatch === undefined ? undefined : { ifMatch });
        } catch (error) {
          // 黙って消さない: 消していないので日誌にも積まない。
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
        // 削除自体は効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`）。
        if (existing !== null) {
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `やり方 ${slug}（${existing.kind}）を消した: ${existing.title}`,
              grounds: '人間が直接 API からやり方を消した',
              target: { kind: 'practice', slug },
            },
            'やり方削除の日誌',
            `slug=${slug}`,
          );
        } else {
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `読めない形で入っていたやり方 ${slug} を消した`,
              grounds: '人間が直接 API から、読めない形で入っていたやり方を消した',
              target: { kind: 'practice', slug },
            },
            'やり方削除の日誌',
            `slug=${slug}`,
          );
        }
        return c.json({ ok: true as const, slug });
      },
    )

    // メタだけで本文は含まない: 一覧に本文を全文で載せない（地雷表の禁止）。
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
        // `/practices/:slug` と同じ門: ここが無いと fs/in-memory では空配列が 200 で返り、pg 実装では例外が `onError` で 500 になる非対称が出る。
        const slug = c.req.param('slug');
        if (!practiceSlugSchema.safeParse(slug).success) {
          return c.json({ error: 'やり方のスラッグが不正' as const }, 400);
        }
        return c.json({ versions: await stores.practices.listVersions(slug) });
      },
    )

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
        // 版番号の検査より前に同じ門を先に通す（`GET /practices/:slug/versions` と順序を揃える）。
        const slug = c.req.param('slug');
        if (!practiceSlugSchema.safeParse(slug).success) {
          return c.json({ error: 'やり方のスラッグが不正' as const }, 400);
        }
        const raw = c.req.param('version');
        const version = Number(raw);
        if (!Number.isInteger(version) || version <= 0) {
          return c.json({ error: '版番号が不正' as const }, 400);
        }
        // `GET /practices/:slug` と同じ判断: 読めない行は素の 500 にせず 409 にする。
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

        // 片方だけでは境界が決まらない。この2つの if で TypeScript が `afterId`/`afterAt` を以降 `string` に絞る。
        if (afterId === undefined && afterAt !== undefined) {
          return c.json({ error: 'afterId と afterAt は両方一緒に渡す' as const }, 400);
        }
        if (afterId !== undefined && afterAt === undefined) {
          return c.json({ error: 'afterId と afterAt は両方一緒に渡す' as const }, 400);
        }
        if (afterId !== undefined && afterAt !== undefined && Number.isNaN(Date.parse(afterAt))) {
          return c.json({ error: 'afterAt は ISO 8601 で指定する' as const }, 400);
        }

        // `toISOString()` へ正規化してからストアへ渡す: pg は時刻で比べるが fs・インメモリは文字列比較なので、秒の省略やオフセットで3実装の答えが割れる。
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

          // 0件かどうかでは決めない: 窓がまるごと地平より後ろなら、0件でも「本当に無かった」と言い切れる。
          const oldestAt =
            normalizedSince !== undefined || normalizedUntil !== undefined || horizon === 'true'
              ? await stores.journal.oldestAt()
              : undefined;
          // `journal_read` と同じ関数（`journalWindowCrossesHorizon`）を呼ぶ: 2箇所に書き写さない。
          const crossesHorizon =
            oldestAt === undefined
              ? undefined
              : journalWindowCrossesHorizon(oldestAt, normalizedSince);

          return c.json({
            entries,
            // `entries` が `limit` 未満・空でも、`null` でない限り先に行が在る: ストアは読めない行を `limit` の後で捨てる。
            next,
            ...(oldestAt === undefined ? {} : { oldestAt }),
            ...(crossesHorizon === undefined ? {} : { crossesHorizon }),
          });
        } catch (error) {
          // 指す行が見当たらないのは判定できないという第3の状態: 黙って先頭から返さず 400 にする。
          if (error instanceof JournalAnchorNotFoundError) {
            return c.json({ error: error.message }, 400);
          }
          throw error;
        }
      },
    )

    // `GET /journal/stream` より後ろに登録する: 先だと `stream` が id として読まれる。在るが読めない行は 409（「無い」と言わない）。
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

    // 経路は1本だけにする: 画面のために別の口を足すと、その瞬間に「CLI ではできないこと」が生まれる。
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
        // 全期間・絞り込み無しの2つを突き合わせる: クエリで狭めた `aggregate.rows` から作ると、照会範囲の外で記録された委譲が「記録が無い」に化ける。
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
          // 配線されていなければ「まだ分からない」を返す: 0 や null にすると「枠を使っていない」と読める。
          account: deps.accountUsage?.() ?? { state: 'unknown' as const },
          unrecordedManagers,
          // 台帳の `date` を書くのと同じ関数・同じ TZ で評価する: ブラウザの TZ で「今日」を決めると台帳の日とずれる。
          today: usageDate((deps.now ?? (() => new Date()))()),
        });
      },
    )

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

        // 並べ直しはここが持つ: 画面や CLI の側で並べ直すと「最新の日報」が口ごとに食い違う。
        if (beforeDate === undefined && beforeAt === undefined) {
          const reports = await listDailyReports(stores.journal, limit);
          return c.json({ reports });
        }

        // 片方だけでは境界が決まらない: `beforeAt` 単独では日付順の主キーが埋まらず、`beforeDate` 単独では同じ日の複数（締めと遡り生成）を切れない。この if で TypeScript が以降 `string` に絞る。
        if (beforeDate === undefined || beforeAt === undefined) {
          return c.json(
            { error: 'beforeDate と beforeAt は両方一緒に渡す（片方だけでは境界が決まらない）' },
            400,
          );
        }

        // 現物のカレンダー妥当性まで見る: 2月30日のような日を通さない。
        if (localDayRange(beforeDate) === null) {
          return c.json({ error: 'beforeDate は YYYY-MM-DD で指定する' }, 400);
        }
        if (Number.isNaN(Date.parse(beforeAt))) {
          return c.json({ error: 'beforeAt は ISO 8601 で指定する' }, 400);
        }

        // 日報が実在することは要求しない: 境界は比較で決まるので、指していた日報が見当たらなくても続きは正しく定まる。
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

        const entries = await stores.journal.list({
          types: ['daily_report'],
          since: range.since.toISOString(),
        });
        // 一覧（`/reports`）と同じ比較で並べる: 画面は「その日の先頭」を既定で開くので、口ごとに違うと開くものが変わる。
        const reports = entries
          .filter(isDailyReport)
          .filter((entry) => entry.date === date)
          .sort(compareDailyReportsNewestFirst);
        if (reports.length === 0) return c.json({ error: 'not found' as const }, 404);
        return c.json({ reports });
      },
    )

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
        // opt-in の判定は生のクエリで行う: `order` は既定値を持つので `c.req.valid('query')` だけでは「渡されたか」が分からない。
        const optedIn =
          c.req.query('order') !== undefined ||
          c.req.query('limit') !== undefined ||
          c.req.query('cursor') !== undefined;

        // `pending` は既定値を持つので、明示されたかは生のクエリで見る（`optedIn` と同じ理由）。
        if (answeredOn !== undefined) {
          if (c.req.query('pending') === 'true') {
            return c.json({ error: 'answeredOn は pending=true と併用できない' }, 400);
          }
          if (optedIn) {
            return c.json({ error: 'answeredOn は order / limit / cursor と併用できない' }, 400);
          }
          if (localDayRange(answeredOn) === null) {
            return c.json({ error: 'answeredOn は YYYY-MM-DD で指定する' as const }, 400);
          }
          const settled = await stores.jobs.listApprovals({
            pendingOnly: false,
            ...(conversationId === undefined ? {} : { conversationId }),
          });
          const onDay = approvalsSettledOn(settled.entries, answeredOn);
          // `unreadable` は載せない: 読めない行は決着の日時も分からず、どの日にも置けない。
          return c.json(
            approvalsResponseSchema.parse({
              approvals: onDay.map((approval) => ({
                ...approval,
                updatedAt: approvalUpdatedAt(approval),
              })),
            }),
          );
        }

        // `conversationId` の絞りはストアに渡す: 全件を取ってメモリで絞ると、会話を開くたびの費用が承認の総数に比例する。`total` は絞り込みを当てた後の件数。
        const approvalList = await stores.jobs.listApprovals({
          pendingOnly: pending !== 'false',
          ...(conversationId === undefined ? {} : { conversationId }),
        });
        const approvals = approvalList.entries;
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
          // 黙って別の向きの頁を返さない: カーソルは決めた向きの中でしか意味を持たない。
          if (cursorPayload.order !== order) {
            return c.json({ error: 'カーソルの order がリクエストの order と食い違う' }, 400);
          }
          // id の実在は検査しない: 指していた行が `pending` の絞りから消えていても、比較さえできれば続きは正しく決まる。
        }

        // 既定の呼びも並べる: ストアの生の並びは実装ごとに違い（fs は回答で書き直した行が末尾へ動く）、説明の「(createdAt, id) の比較で決める」と食い違うため。
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
        // 0 件なら鍵ごと無い: 空配列は「読めない行は 0 件」と読め、既存の呼び手の応答も変わる。窓（`limit`/`cursor`）では切らない。
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

    // `GET /approvals/:id` はこの経路より後ろに登録する: 先だと `answered-dates` が id として読まれる（`approvals-answered.test.ts` が固定する）。
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

    // `settledOn` は `GET /approvals?answeredOn=` の日と同じ関数（`approvalSettledDate`）で決める。在るが読めない行は 409（「無い」と言わない）。
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
        // 形の不正は1件も答える前に全体を 400 にする: `selections` が `questions` と突き合わないのは要求の誤りで、件ごとの成否とは違い、残りだけ進めると書いたつもりの件が黙って落ちる。まだ回答待ちの件にだけ突き合わせる（他は下で件ごとの理由として返す）。
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
          // 取り下げ済みは回答できない: `putApproval` が上書きして `withdrawnAt` と `answeredAt` が同時に立った行を作り、クローンが止めたつもりの仕事を人間の回答が再開しうる（`clone.ts` の `human_answer` は `answeredAt` の有無しか見ない）。
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
            // 先の判定を通った後に別の回答・取り下げが先に届いていた: 先の判定と同じ語で返す。
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
          // 在るが読めない行を「無い」（404）と言わない。
          if (error instanceof UnreadableApprovalError)
            return c.json({ error: error.message }, 409);
          throw error;
        }
        if (!approval) return c.json({ error: 'not found' as const }, 404);
        // 二度答えると既に再開した仕事へ同じ回答がもう一度流れ、記録上の回答も上書きされる。
        if (approval.answeredAt !== undefined) {
          return c.json({ error: 'already answered' as const }, 409);
        }
        // 取り下げ済みも答えられない（上のバルク版と同じ理由）。
        if (approval.withdrawnAt !== undefined) {
          return c.json({ error: 'withdrawn' as const }, 409);
        }
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
          // 先の判定を通った後に別の回答・取り下げが先に届いていた: 先の判定と同じ 409 で返す。
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
        // 0件なら鍵ごと無い: 読めない行しか無いと `grants` は空で「許可が無い」に見える。本文は載せない（id と不正な欄名だけ）。
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
        // `get()` → `put({ ...grant, revokedAt })` にしない: lost update になる。`revoke` が排他区間の中で現在値を読み直すので、`#onPreToolUse` の `markUsed` 割り込みでも取り消しが消えない。読めない行は「無い」（404）ではなく 409 と言い分ける。
        let grant: Awaited<ReturnType<typeof stores.permissionGrants.revoke>>;
        // 日誌の書き分けのためだけに取り消す前の状態を読む: 取り消し自体はこの読みに依らない。読めない行は `get()` に現れず `null` になるが、下の `revoke` が 409 で止める。
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
        // 操作は毎回残し、出来事は重ねない: 既に取り消し済みへの取り消しは「取り消した」と書かず書き分ける（`revoke` は元の `revokedAt` を保つ）。並行した2つの取り消しで読み取りが両方「まだ」でも、`revokedAt` が今回の時刻でないことで後に着いた側が拾える。
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

    // `:id` の下に置かない: 読めた行の id と名前空間が重なりうるので、別の語（`unreadable`）の下に置く。
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

    // 値（`altk_...`）も sha256 の全体も返さない（見分けるための先頭12桁だけ）。連携の鍵そのものは資格に入れない（`humanOnly` は二重の門）。
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

    // `:id` と取り違えないよう別の語（`unreadable`）の下に置く。
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

    // 日誌を先に書き、書けなければ状態を変えずに 500: 能力を広げる口は記録の無い変更を作らない。日誌に鍵の値は書かない。
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
        // daemon 自身が使う予約語の source の鍵は作らない: 外から名乗れる鍵になる。
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
          // 日誌には「発行した」が残っているので打ち消す（記録が多すぎる側に倒す）。
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

    // 冪等: 失効済みはそのまま 200で、先の時刻を動かさず日誌も足さない。
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
          // 読めない形で入っている行は「無い」ではなく 409 で言い分ける。
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

    // 何をするかはここで決めない: 対応表を持った瞬間に自動化ジョブに戻る。
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
        // 連携の鍵は本文の source が鍵の source と一致するときだけ通す（不一致は 403。日誌には書かない）。
        if (principal.kind === 'integration' && source !== principal.source) {
          noteIntegrationRefusal(c, 403, '本文の source が鍵の source と違う', principal.keyId);
          return c.json({ error: '本文の source が、この連携の鍵の source と違う' as const }, 403);
        }
        // 予約語は正規化の後で断る。添付の検査より前: 何も結ばず何も積まない。
        if (isMalformedEventSource(source)) return c.json(INVALID_SOURCE_BODY, 400);
        if (isReservedEventSource(source)) return c.json(RESERVED_SOURCE_BODY, 400);
        const id = randomUUID();
        const attached = await bindEventAttachments(attachmentIds, id, principal);
        if (!attached.ok) return c.json(attached.body, attached.status);
        const at = new Date().toISOString();
        // 受信箱へ永続化できたときだけ 200 を返す: 書けなかったら 503 で、受信箱のメモリにも積まない。
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
        // 日誌の external_event は使わない: クローンが取り出した時刻なので、受け付けた時刻で光らせる。
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
        // 予約語は正規化の後で断る。本文も添付も読む前: 何も結ばず何も積まない。
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
        // 0 件なら鍵ごと無い: 既存の呼び手の応答を1バイトも変えない。
        const unreadable = deps.scheduler?.unreadable() ?? [];
        return c.json(
          scheduleListResponseSchema.parse({
            entries: deps.scheduler?.list() ?? [],
            ...(unreadable.length > 0 ? { unreadable } : {}),
          }),
        );
      },
    )

    // スケジューラへ直接足さない: 真実はストア側にあり、直接足すとデーモンを再起動した瞬間に消える仕込みができる。
    .post(
      '/schedule',
      describeRoute({
        tags: ['schedule'],
        summary: '継続中の依頼を仕込む・直す',
        description:
          '「定期的に〜しておいて」をクローンの記憶任せにせず、時刻が来れば必ず届く形で置く。' +
          '同じ kind なら置き換わる（前回動いた時刻は保つ）。' +
          '任意の `ifMatch`（`GET /schedule` で読んだ時の `updatedAt`。無かったなら null）を付けると、' +
          '版が違うときは書かずに 409。省略は従来どおり後勝ち。' +
          '真実はストア側にあり、' +
          'スケジューラはそれを読み直すだけなので、デーモンを作り直しても残る。' +
          // 一覧を数え直さず `RESERVED_SCHEDULE_KINDS` から導出する: この description は `openapi.json` へ焼かれるので、数え直すと生成物も同じ嘘を持つ。
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
          // every の分数の断りは上限と代わりの書き方を伝える。値は混ぜない（固定の文だけ）。
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
        // 能力を広げる口は日誌を先に書く: 書けなければ仕込まずに 500。「仕込んだ」か「直した」かは `editRequest` の戻り値でしか分からないので、先の行はそれを含まず、後で分かる分は2行目として best-effort で足す。
        await stores.journal.append({
          type: 'decision',
          decision: `人間が定期の依頼を設定しようとしている: ${kind}: ${request}`,
          grounds: '人間が直接 API から仕込んだ',
        });

        // 編集は `editRequest`、新規作成だけ `put`: `get()` して `put()` すると、その間に定期発火の `claimRun` が割り込んだ印を丸ごと消す lost update になる。`editRequest` は現在値を排他区間の中で読み直して引き継ぐ。
        let edited: Awaited<ReturnType<Stores['schedules']['editRequest']>>;
        try {
          edited = await stores.schedules.editRequest(kind, { request, spec }, now, { ifMatch });
          if (edited === null) {
            // 版つき（`ifMatch: null`）なら「無いときだけ作る」をストアの排他の中で行う。
            await stores.schedules.put(
              { kind, spec, request, createdAt: now, updatedAt: now },
              ifMatch === undefined ? undefined : { ifMatch: null },
            );
          }
        } catch (error) {
          // 黙って上書きしない: 書いていないので、先に積んだ「設定しようとしている」を打ち消す。
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
        // 仕込み・直しは効いているので、後で分かった区別は2行目として足す（落ちても 500 にしない。`appendJournalOrDrop`）。
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
        // 次の刻みを待たずに効かせる: 人間が仕込んだのに1分間存在しないのは嘘になる。
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
        // `get(kind)` を先に呼ばない: `get` は読めない行で throw するので、壊れた行を外す目的まで届かない。`removeIfPresent` は3値を1回の往復で返すので、読んでから書くまでの隙間も無い。
        const removed = await stores.schedules.removeIfPresent(kind);
        if (removed === null) return c.json({ error: 'not found' as const }, 404);
        // 外すこと自体は効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`）。
        await appendJournalOrDrop(
          stores,
          {
            type: 'decision',
            decision:
              removed === 'unreadable'
                ? // 本文を持たない: 読めなかった行を壊れた形のまま日誌へ書くと、読めない値を持ち回ることになる。
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

    // 観測ではなく実行: ブラウザから叩けてはいけない。
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

    // 資格は `authenticate` だけで `requireOperator` にしない: あちらは実行環境そのものを差し替える資格（`/profile`）で、台帳の読み書きはそこまでの資格ではない。持ち主だけにすると、許可を通ったアカウントから台帳だけが見えなくなる。
    // 「やることの一覧」ではない: 器が持つのは「何を頼まれたか」と「まだ片付いていない」の2値だけで、順序も優先度も締切も持たない。並べ替えや絞り込みの引数をここへ足さない（判断がクローンから器へ移る）。窓（`limit`/`cursor`）は固定された並びの上に頁を切るだけなので、この禁止と衝突しない。
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
        // opt-in の判定は生のクエリで行う: `includeClosed` は既定値を持つので `c.req.valid('query')` だけでは「渡されたか」が分からない。`includeClosed` は窓とは別の既存の絞り込みなので opt-in に含めない。
        const optedIn = c.req.query('limit') !== undefined || c.req.query('cursor') !== undefined;

        const { entries, unreadable, trimmedClosed } = await stores.commitments.list(
          includeClosed === 'true' ? { includeClosed: true } : undefined,
        );
        const total = entries.length;

        const { repliesByConversation, activeManagersByConversation } =
          await buildCommitmentDerivations(stores, entries);
        // 読めない委譲に紐づく行は「委譲なし」に見えるが、どの行に紐づくかは行が壊れているので言えない: 行へは紐づけず、1件でも在るときだけ `unreadableJobs` として別に載せる。
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
          // 黙って別の一覧の続きを返さない: 錨は刷られた一覧（`includeClosed`）の中でしか意味を持たない。
          if (cursorPayload.includeClosed !== includeClosed) {
            return c.json(
              { error: 'カーソルの includeClosed がリクエストの includeClosed と食い違う' },
              400,
            );
          }
          // id（行）の実在は検査しない: `(segment, key, id)` の比較で辿るので、指していた行が閉じられて段を移っていても続きは正しく決まる。
        }

        // 窓は `entries` にだけ当て、`unreadable` は絶対に窓で切らない: 「無い」でも「片付いた」でもない第3の状態なので、切ると2頁目以降から読めない行が消える。opt-in しなければ `compareCommitmentPosition` を通さない: 既定の呼びの応答が opt-in の前後でバイト単位で一致する。
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
        // 窓では切らない（`unreadable` と同じ）。0件なら鍵ごと無い: 既存の応答は1バイトも変わらない。
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

    // 積むだけでクローンのターンは起こさない: 起点を増やすと同じことを2つの経路で起こせる状態になる。
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
        // `origin` は本文から取らない: 人間に選ばせると `self` を名乗れてしまい、「人間との約束か自分で思い立ったことか」をクローンが区別する手立てが消える。
        const entry = {
          id: randomUUID(),
          at: new Date().toISOString(),
          origin: 'human' as const,
          ...(source === undefined ? {} : { source }),
          body,
        };
        await stores.commitments.open(entry);
        // chat の外から積んだものは日誌に残さなければどこにも跡が無い（この口には対応する発言が無い）。
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

    // 先に読んで判断しない: 「読む → 未了と分かる → 閉じる」に割ると、同じ id への同時の2つの close が両方書きにいき、後から来た理由で上書きされる。判定は台帳の1操作（`close`）に任せ、読むのは 404 と 409 を書き分けるためだけにする。読めない約束も閉じられるよう、読めない行に対しても直接 `close()` を試す。
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
          // 読めない行が既に閉じられているときは `get` が投げる: `close()` が中身を読めるようにしたわけではなく、`get()` の契約は変えていない。
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
        // 片付けること自体は効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`）。
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

    // 編集できるのは `origin` が `human` かつ未了の行の `body` だけ: 台帳は「クローンが何を引き受けたか」の記録で、それが静かに書き換わるとクローンが過去の自分を追えなくなる。`origin` / `source` / `at` / `closed*` は直さない。クローンは `commitment_edit` で自分の行を直せ、`manager` の行は誰も直せない。
    // 先に `get` で `origin` を確かめてから `editBody` を呼ぶ: `origin` は不変なので競合せず、競合しうる「まだ閉じていない」だけを `editBody` の1操作へ畳む。原文は日誌へ逐語で残す（前後の本文を両方書くことで「静かに」を消している）。読めない行は書き直さず 409 で止める: 本文が読める形へ戻る保証が無い。
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
          // 断る理由だけでなく代わりの出口も同じ文字列へ入れる: 画面はこの本文をそのまま出し断りの文面を持たないので、出口を画面側に書くとここの線が動いた日に画面が静かに嘘になる。出口が在るのは `self` の行だけ（無い出口を案内しない）。
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
          // 日誌は編集が効いた後にしか積まないので、打ち消すものも無い。
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
        // 編集自体は効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`）。
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

    // 応答は返す前に宣言したスキーマを通す（`.parse()`）: `resolver()` は `openapi.json` を作るだけで実際の応答を見ないので、`ManagerSummary` にフィールドが増えた日に spec に書いていないものを黙って外へ出す。`.parse()` なら宣言に無いキーを落とす。
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
        // opt-in の判定は生のクエリで行う。`status` は含めない: 窓とは別の絞り込みなので、`status` だけの呼びは並べ直しを通らず `list()` の生の並びのまま絞られる。
        const optedIn =
          c.req.query('limit') !== undefined ||
          c.req.query('afterId') !== undefined ||
          c.req.query('afterStartedAt') !== undefined;

        // 片方だけでは境界が決まらない。この2つの if で TypeScript が以降 `string` に絞る。
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

        // 当てる順序は `status` 絞り → 錨 → `limit`: 先に `limit` で切ると切った窓の中から絞ることになり（先頭の1件が `done` だっただけで `status=running&limit=1` が 0 件を返す）、錨を `limit` より後に当てると次の頁の起点がずれる。`status=`（空）は絞らない: 0件へ倒すと絞りを解除した画面が「マネージャーが消えた」ように見える。
        const active = statuses;
        let view =
          active === undefined || active.length === 0
            ? managers
            : managers.filter((m) => active.includes(m.status));

        // 並べ直すのは opt-in のときだけ: `list()` の並びは同着の相対順を決めていないので、錨で辿るには補助キー（`managerId`）まで含めた順序が要る。opt-in しなければ通さない（既定の呼びの応答がバイト単位で一致する）。
        if (optedIn) {
          view = [...view].sort(compareManagerPagingKey);
          if (afterId !== undefined && afterStartedAt !== undefined) {
            const pivot = { managerId: afterId, startedAt: afterStartedAt };
            // 実在を確かめる（`/approvals` / `/commitments` と違う）: 台帳の行は消えないので、見当たらないのは「消えた」ではなく「そんな錨は刷っていない」で、黙って先頭から返すと呼ぶ側は同じ頁を無限に読む。
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

        // 0 件なら鍵ごと無い: 空配列は「読めない行は 0 件」と読め、既存の呼び手の応答も変わる。窓（`status` / `limit` / 錨）では切らない: 行が読めないのでどの状態のものかも分からない。
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
          // `list()` は読めない委譲の行を飛ばすので、壊れた行の id はここで見つからない: 見つからなかったときだけ台帳を読み直し、行が在るなら 404 ではなく 409 と言い分ける。本文は載せず、理由は不正な欄名だけ。
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
        // 読めない行は 404 にしない: 居ないのではなく壊れている。
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
        // `session_missing` を 404 に混ぜない: 「そのものは居る」側で、待てば直る状態を 404 という機械可読な終端で返すことになる。200 + `outcome` で返し、読み手に解釈の余地を残す。
        if (result.outcome === 'unknown') return c.json({ error: result.detail }, 404);
        // 行は在るが読めないものは「居ない」の 404 にしない（409）。
        if (result.outcome === 'unreadable') return c.json({ error: result.detail }, 409);
        return c.json({ outcome: result.outcome, detail: result.detail });
      },
    )

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
        // `'absent'` だけが 404: `'not_stopped'` / `'unknown'` は「そのものは居る」という観測結果で、リクエスト自体は正しく処理できている（200 で `outcome` を返す）。
        if (result.outcome === 'absent') return c.json({ error: result.detail }, 404);
        // 行は在るが読めないものは「居ない」の 404 にしない（409）。
        if (result.outcome === 'unreadable') return c.json({ error: result.detail }, 409);
        return c.json({ outcome: result.outcome, detail: result.detail });
      },
    )

    // 指紋を出す: 人間が置いた鍵とマネージャーが握っている鍵が同じかを確かめる手段が他に無く、無いと「権限が足りない」のか「届いていない」のかを切り分けられない。値は返らない。
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
        // runner の一覧が空でもこの値だけは常に出す: 自分がどの版で走っているかは runner の登録有無と無関係な事実。
        const daemonRevision = reportRunnerRevision(resolveBuildRevision());
        // runner が0台・名簿が無いときも出す（クローン自身の init の事実）。読み口を持たないホストでは欄ごと省く: 「0件」と埋めない。
        const clonePluginLoad = clone.pluginLoad?.();
        const clonePluginLoadField = clonePluginLoad === undefined ? {} : { clonePluginLoad };
        const registry = deps.runners;
        if (registry === undefined) {
          return c.json(
            runnersListResponseSchema.parse({
              runners: [],
              daemonRevision,
              ...clonePluginLoadField,
            }),
          );
        }
        // 名簿に載っている全部を返す: 上がってこない runner が消えるだけだと「設定し忘れた」のか「上がってこない」のかが区別できない。
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
                  // 繋がっていない相手のぶんも出す: 黙った器の「最後に応えていたプロセス」は、戻ってきたときに同じ器かを突き合わせる材料で、消すと黙っている間だけ材料が消える。
                  ...(entry.instanceId === undefined ? {} : { instanceId: entry.instanceId }),
                  ...(entry.instanceSince === undefined
                    ? {}
                    : { instanceSince: entry.instanceSince }),
                  // 繋がっていない相手には聞きに行かない。聞かなかったこと・聞いて失敗したこと・聞いて0件だったことを同じ表現へ潰さない: 読む側が「鍵が配られていない」のか「確かめられなかった」のかを区別できなくなる。
                  ...(await probe(runner, 'credentials')),
                  ...(await probe(runner, 'profile')),
                  // 名簿に既にある値をそのまま出し、ここで新たに runner を叩かない: 「未接続／頼んで失敗／頼んでいない」が潰れる穴を増やさない。
                  revision: entry.revision,
                  // 押し込みの直近結果は `probe` の指紋とは別物（記憶から返すだけで新たな往復は無い）: `ManagerPool` の内部状態なので `clone.managers` 経由の専用アクセサ（`pushHealthOf`）が要る。
                  ...(entry.runnerId === undefined
                    ? {}
                    : (() => {
                        const pushHealth = clone.managers.pushHealthOf(entry.runnerId);
                        return pushHealth === undefined ? {} : { pushHealth };
                      })()),
                  // 読み口を持たないプールでは「不明」に倒す: 「頼めない」と埋めない。
                  managerPeers: clone.managers.managerPeersOf?.(entry.runnerId) ?? {
                    status: 'unknown',
                  },
                  // 読み口を持たないプール・まだ session を受けていない runner では欄ごと省く: 「0件」と埋めない。
                  ...(entry.runnerId === undefined
                    ? {}
                    : (() => {
                        const pluginLoad = clone.managers.pluginLoadOf?.(entry.runnerId);
                        return pluginLoad === undefined ? {} : { pluginLoad };
                      })()),
                };
              }),
            ),
            daemonRevision,
            ...clonePluginLoadField,
          }),
        );
      },
    )

    // 鍵はここに保管しない（受け取って runner へ降ろすだけ）: 器に記憶の鍵と GitHub の書き込み権を並べない。器を作り直さない: 鍵の更新に再デプロイが要ると、走行中の仕事を鍵の都合で失う。
    // 能力を広げる口なので日誌を先に書き、書けなければ1本も配らずに 500（`PUT /credentials` と同じ）。指紋は入力の値から直接計算できるので先の行にも含める。値（鍵そのもの）はどの行にも書かない。資格（`authenticate` だけ）を締めるかは方針の判断で、勝手に揃えると今通っている運用が黙って止まる。
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
      // 既定の 400 を使わない: `hook` を渡さないと `@hono/standard-validator` が本文そのものを `data` に載せて返し（`RESTRICTED_DATA_FIELDS` は cookie だけで `json` は素通し）、`name` の形式ミス1つでその回に送った全部の鍵の値が応答へ載る。返すのは `path` だけ。
      jsonBody(runnerSetCredentialsCommandSchema, (where) => ({
        error: '鍵の入力の形が不正（配布していない）' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        const registry = deps.runners;
        if (registry === undefined) {
          return c.json({ error: 'runner が登録されていない' as const }, 503);
        }
        const { credentials } = c.req.valid('json');
        const wanted = credentials
          .map((entry) => `${entry.name}=${fingerprintOf(entry.value)}`)
          .join(', ');

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
                // 素の `String(error)` を載せない（`probe` と同じ理由）。
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
          // `registry.list()` 自体が投げた場合（個々の配布は上で捕まえている）: 打ち消しの行を足してから投げ直す。`base.onError` が返す 500 は変えない。
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

    // `RunnerRegistry` ではなく `ManagerPool.vacate()` を呼ぶ: `RunnerRegistry#vacate` は同期・往復無しの名簿操作だけで、「確かめた停止」の握手と `relocateFrom` まで含めた HTTP から見える唯一の受け口がこちら。どの器を空けるかはクローンの判断で、スクリプトが黙って選ばない。
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
        // 握手を飛ばした回だけ欄を載せる。状態は 200 のまま: 立てたこと自体は成功している。
        return c.json(
          runnersVacateResponseSchema.parse({
            ok: true,
            ...(handshakeSkipped === undefined ? {} : { handshakeSkipped }),
          }),
        );
      },
    )

    // 読み側も書き側と同じ門にする: 本文には `GH_TOKEN` のような鍵が丸ごと入りうるので、`GET` が緩いと `PUT` を締めても意味が無い。本文を返す: 読み直せないと typo ひとつ直せない（指紋しか返さないのは runner の制御面で、守る相手が違う）。
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

    // deprecated だが意味を保って残す: 古い CLI と Web（Vercel で別に配られる）が叩き続ける。
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
      // 既定の 400 を使わない: `script` の綴りを1つ間違えただけで、鍵の値まで含みうるスクリプト全文が応答へ載る。宣言済みの `profileErrorResponseSchema`（`{ error, detail }`）の形で返し、`detail` に載せてよいのは `path` だけ（CLI がこの `detail` をそのまま人へ表示する）。
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

    // 名前の形が不正なら 400: 名前は fs 版の器の中でファイル名になる。
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
        // 無い名前は日誌も書かず 404: 「外そうとしている」を残さない。
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

    // `GET` も `PUT` と同じ門にする: 登録の `env` / `headers` には鍵が丸ごと入りうるので、読み側が緩いと書き側を締めても意味が無い。stdio の登録はクローンの SDK 子プロセスが起こすコマンドで、クローンの env（記憶ストアの鍵を含む）を継承する＝「次のセッションで任意のコマンドを走らせる」口でもある。門を `requireOperator` へ締めるかは人間の判断（締めるなら `scripts/require-operator-routes.test.ts` の一覧を付け替える）。
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

    // 保存と配布は同じ列を通す（`mcp-server-service.ts`）: 名乗り直しの降ろし直しと混ざって古い登録で上書きしない。日誌には名前だけを書く（値には鍵が入りうる）。能力を広げる口なので日誌を先に書き、書けなければ差し替えずに 500。空の `mcpServers`（狭める使い方）も口ごとに1つの扱いとして同じ（閉じる側に倒す）。
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
      // 既定の 400 を使わない（`PUT /profile` と同じ理由）: 本文をそのまま `data` に載せて返すので、欄の綴りを1つ間違えただけで `env` / `headers` の鍵が応答へ載る。
      jsonBody(mcpServersUpdateRequestSchema, (where) => ({
        error: 'MCP サーバの登録の形が不正（保存していない）' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        // 前の登録は日誌のためにしか使わない（全文置換なので差分の計算も配布も前を見ない）: 保存済みの登録が壊れていても置き直す口を塞がず、「読めなかった」と書いて進む。「なし」とは書き分ける（前は空だったと取り違えない）。理由は `reasonOf` を通す。
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

        // 渡されていない構成（テストや配布先を持たない器）では保存だけして配らない: 配らなかったことは `runners: []` で見える。
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
          // NUL は入力の誤りで 400: 文は欄名と固定の説明だけで、値を載せない。
          if (error instanceof NulNotAllowedError) {
            return c.json(
              { error: `MCP サーバの登録が不正（保存していない）: ${error.message}` },
              400,
            );
          }
          // `current` の鍵の有無で他の 409 と見分けられる。
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
        // 差し替え自体はもう効いているので、後で分かった配布結果は2行目として足す（落ちても 500 にしない。値は書かない）。
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

    // 門は `requireOwner`（MCP 連携の登録と同じ範囲）: plugin は skills・agents・commands をクローンとマネージャーの実行に持ち込む。クローンの道具からは入れられない（道具を足さない）。
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

    // 確定（`POST /plugins`）は預かりを取り直さず保存する: 確認の後に取り元が動いても、見せたものと入れるものがずれない。enableHooks でも展開器はいまは hooks を出さない。
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

    // 日誌を先に書き、書けなければ入れずに 500（能力を広げる口。`PUT /mcp-servers` と同じ）。中身は日誌に書かない。
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
        // 外から来た説明は弾かずに整える: 飾りのせいで入れられなくしない。
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
        // 日誌より前に保存できる形かを確かめる: 保存できないものの「入れようとしている」を残さない。
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
        // `list()` は壊れた行が1つあると全体が投げるので使わない: `get` の失敗は「取り元不明」として外せるようにする（外せない壊れた行が残り続けない）。在るかは `remove()` の戻り値で決める。
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

        // 日誌を先に書き、書けなければ消さずに 500: 記録の無い変更を作らない。
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

    // 資格は `authenticate` だけで `requireOperator` は付けない: 返すのは指紋で、同じ指紋は `GET /runners` が同じ資格で出している。揃えないと、「届いているか」を確かめたいだけの人が持ち主の資格を要求される。値を返す口は作らない。
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

    // `POST /runners/credentials` との違いは保管するかどうか: あちらは受け取って走っている runner へ降ろすだけ、ここは正本へ置くので器が入れ替わっても `hello` のときに降り直す。「置けるが読み出せない」は意図した非対称: ここの資格が漏れて起きるのは「今後の鍵が書き換わる」で、「いま在る鍵が流出する」ではない（`/profile` は応答本文に鍵が丸ごと載るので緩めていない）。
    // 能力を広げる口なので日誌を先に書き、書けなければ差し替えずに 500: 差し替えの後に書くと、追記だけが落ちて 500 を返す一方で差し替えは効いたまま残る。差し替えが投げたら打ち消しの行を足す。検証と保存が同じ1呼び（`apply`）の中にあるので、検証で断られた回も同じ扱い（記録が多すぎる側に倒す）。
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
      // 既定の 400 を使わない（`POST /runners/credentials` と同じ理由）: 形式ミス1つでその回に送った全部の鍵の値が応答へ載る。返すのは `path` だけ。
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

        await deps.stores.journal.append({
          type: 'decision',
          decision: `環境変数（鍵）を差し替えようとしている（${wanted}）`,
          grounds: `${describeActor(c.get('principal'))}（PUT /credentials）。値は書かない（鍵そのものである）。`,
        });

        let result: ApplyCredentialsResult;
        try {
          result = await deps.credentials.apply(entries);
        } catch (error) {
          // 理由を返す: 「置けなかった」だけでは、人間は名前を疑うのか権限を疑うのか分からない。返してよいのは検証で断った例外（名前と理由だけで値を載せない文）の型だけ: `apply` は保存も担うので、それ以外の `message` には値が載りうる（drizzle は `Failed query: … params: <値>` を添える）。見分けは文言でなく型で行い、それ以外は `name` だけを応答にも日誌にも載せる。
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

        // `result.fingerprints` を丸ごと流さない: `secret === false` の行は `value`（平文）を伴って返ってくるので、`name` / `sha256` だけを個別に読む。
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
          // サービスの返す形をそのまま流さない: 宣言（`credentials`）とサービスの語彙（`fingerprints`）が違うので `parse` で落ちる形にしておく。
          credentialsUpdateResponseSchema.parse({
            credentials: result.fingerprints,
            runners: result.runners,
          }),
        );
      },
    )

    // 値（auth.json の中身）を返す口は作らない: 状態とログインの進み具合だけを返す。
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

    // 狭める側なので、日誌は状態を変えた後に持ち主（`CodexChatgptAuthService`）が書く。資格は `PUT /credentials` と揃える（資格を書く口であるため）。
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

    // 能力を広げる口（peer の Codex が使う資格を置く）なので、`PUT /credentials` と同じく `requireOwner` を通し、日誌を先に書く（書けなければ始めずに 500）。
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

    // 資格は `authenticate` だけ: ここが持つのは課金の設定であって鍵の値ではない（`/profile` とは違う）。値は決して出さない: `AgentToken`（`value` 付き）はサービスの外へ一度も出ない。
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

    // 理由の本文にトークンの値は含めない（投げるメッセージは id / label だけを含む）。
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
      // 既定の 400 を使わない: `hook` を渡さないと `@hono/standard-validator` が本文そのものを `data` に載せて返し（`RESTRICTED_DATA_FIELDS` は cookie だけで `json` は素通し。`@hono/standard-validator@0.4.0` で観測）、`label` を1つ書き忘れただけでその回に送った全部の値が応答へ載る。返すのは `path` だけ。
      jsonBody(tokensUpdateRequestSchema, (where) => ({
        error:
          'トークンのプールの入力の形が不正（保存していない）' + (where === '' ? '' : `: ${where}`),
      })),
      async (c) => {
        if (deps.tokens === undefined) {
          return c.json({ error: 'トークンのプールの器が無い' as const }, 400);
        }
        // 能力の向きで日誌の順序を分ける: 広げる側（追加・有効化・切替）が差分に1つでも在れば日誌が先で、書けなければ保存せずに 500（使える鍵が増える・変わる操作を記録の無いまま通さない）。狭める側だけ（削除・無効化・改名）なら保存が先で、日誌が書けなくても止めない。全文置換なので前後の差分から分類する。
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
          // 素の 500 にせず「記録が書けなかったので変更していない」と言う本文を返す。例外の本文は返さない（値が載りうる）。
          if (state.journalError !== undefined) {
            noteDroppedRecord(
              '認証トークンのプールの変更の日誌（保存していない）',
              `count=${String(requestedCount)}`,
              kindOfError(state.journalError.cause),
            );
            return c.json(journalWriteFailedBody(), 500);
          }
          // 返してよい例外だけを型で分けて返す: `TokenPoolInputError` は `message` をそのまま返してよいという約束が型に付いている。それ以外（保存の失敗）は本文を1文字も返さない: ドライバの例外は失敗したクエリの束縛パラメータを添えるので（`drizzle-orm@0.45.2` の `PgPreparedQuery` は `Failed query: …` の次の行に `params: …` を置く）、素の `String(error)` を返すとトークンの値が載る。`reasonOf` を通すだけにしない: 1行目だけを採って値が落ちるのは、ドライバの改行位置に依存した偶然。投げ直さない: 既定のハンドラへ回るだけで、本文を出さない保証が消える。
          if (error instanceof TokenPoolInputError) {
            return c.json({ error: error.message }, 400);
          }
          // 日誌は先に書いたが保存できなかったので、打ち消しの行を足す（`PUT /credentials` と同じ形）。
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
          // error は種類（`name`）だけ渡す: `noteDroppedRecord` は `message` の1行目と `cause` の連鎖を stderr へ出すので、生の error を渡すとエラー文に載ったトークンの値が出うる。
          noteDroppedRecord(
            '認証トークンのプール',
            `count=${String(requestedCount)}`,
            kindOfError(error),
          );
          return c.json({ error: 'トークンのプールを保存できなかった' as const }, 500);
        }
        // 狭める側だけの変更は保存した後に日誌を書き、書けなければ跡だけ残して握る（広げる側を含む回は保存の前に書いてある）。
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
        // ここから先は保存した後: 失敗しても「保存できなかった」ではないので、上の `catch`（500）へ落とさず保存したと言って返す。原因は種類（`error.name`）だけを日誌に使う: メッセージには行の中身（トークンの値）が載りうる。
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
        // 変更そのものの日誌は上で書いてある: この1行は保存の後の読み直しの失敗の跡で best-effort。
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

    // `PUT /tokens` と回し手の書き戻しは読めない行を持ち越すので、消す口はここだけ。読めない行は `:id`（読めた行の id）と名前空間が重なりうるので別の語（`unreadable`）の下に置く。日誌を先に書き、書けなければ状態を変えずに 500。日誌に残すのは消す id と件数だけ（とくにトークンの値は書かない）。
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
        // `let` ではなく入れ物にする: 閉じ込めで代入するので型の絞り込みが `never` に倒れる。
        const written: { detail?: string } = {};
        try {
          const result = await deps.tokens.removeUnreadable(requested, {
            // 日誌を先に書く: 書けなければここで投げ、状態を変えずに `base.onError` へ抜ける。トークンの値は書かない。
            beforeRemove: async (ids) => {
              await deps.stores.journal.append({
                type: 'decision',
                decision: `読めない認証トークンの行を ${String(ids.length)} 件消そうとしている（id: ${ids.join(', ')}）`,
                grounds:
                  `${describeActor(c.get('principal'))}（POST /tokens/unreadable/remove）。` +
                  '消すのは id で指した読めない行だけ。行の中身（トークンの値）は書かない。',
              });
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
          // ここから先は行を消した後: 失敗しても「消せなかった」ではないので、下の `catch`（打ち消しと 500）へ落とさず消したと言って返す。原因は種類だけを日誌に使う（メッセージにはトークンの値が載りうる）。
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
          // 日誌が書けなかった回は状態を変えていないので、投げ直して `base.onError` の 500 に任せる。
          const journaled = written.detail;
          if (journaled === undefined) throw error;
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
          // error は種類（`name`）だけ渡す: 生の error を渡すと `noteDroppedRecord` が `message` の1行目を stderr へ出し、エラー文に載ったトークンの値が出うる。
          noteDroppedRecord('読めない認証トークンの行の削除', journaled, kindOfError(error));
          return c.json({ error: 'トークンのプールを保存できなかった' as const }, 500);
        }
      },
    )

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
        // 能力の向きで日誌の順序を分ける: 回さない方向へ狭めるだけ（変更後の `rotateOn` が `off`）なら保存が先で、「止める」を日誌の失敗で止めない。それ以外（契機を有効にする・変える、冷却を変える）は日誌が先で、書けなければ保存せずに 500（冷却の長短は判断が割れるので安全側＝広げる側に倒す）。差分が無ければ日誌は書かない。
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

    // `:id` より前に置く: 後ろだと `sessions` が `:id` に食われてこの経路へ一生届かない（hono は登録順で最初に一致した経路を使う）。
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

    // 走行中のマネージャーの退避の判定は `guardArchiveRemoval`（`ManagerPool.runningManagerOwning()`）1箇所だけを通す: クローンの道具 `archive_remove` と同じ関数で、2箇所に書くと片方だけ直る形になる。
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
        // 本文の削除は効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`）。
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

    // 墓標（`TranscriptGrave`）を守る: `#pickUpTranscriptGrave` が次の起動時にこの id から蒸留を拾い直すので、本文を一括で落とすとまだ記憶へ移せていない区間が永久に失われる。`isNewest` は「セッションの最新行」を守るだけで意味が違うので、`protectedIds` という別経路で独立に渡す。
    // 走行中の委譲の行は一括では開けない（`overrideReason` はこの入力に無い）: 一括で複数件を無条件に開ける形は事故の芽が大きい。実行は `stores.archive.remove(id)` を1件ずつ（一括 UPDATE にしない: 1行1トランザクション・`WHERE removed_at IS NULL` で冪等・再開可能）。
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

        // 絞り込みの無い呼びを断る: 1回でアーカイブを空にできてしまう。
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
          // 存在しない日付・日付でない文字列を別の時刻として読んで消さず、時差の無い時刻をデーモンの地方時刻として読んで消さない: 元に戻せない一括削除なので時差を必須にする（道具 `inbox_remove_many` と同じ門・同じ文言）。
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

        const grave = await stores.sessions.getTranscriptGrave();
        const protectedIds = grave === null ? [] : [grave.archiveId];

        const filter: ArchiveRemoveManyFilter = {
          ...(sessionIds === undefined ? {} : { sessionIds }),
          ...(before === undefined ? {} : { before }),
          ...(minStoredBytes === undefined ? {} : { minStoredBytes }),
        };
        // 絞りと選定は `selectArchiveRemovalTargets` に閉じる: SQL 側に同じ判定を複製しない。
        const allRows = await stores.archive.list();
        const selection = selectArchiveRemovalTargets(allRows, filter, {
          requireContainment,
          limit: limit ?? ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
          protectedIds,
        });

        // `denied` / `unknown` はどちらも安全側に倒して飛ばす。この guard ループは dryRun 分岐より前で回す: `guardArchiveRemoval` はプロセス内の像を読むだけで安く、後ろに置くと下見が「guard で減る前」の数を返して実行と `targeted` / `skipped.inUse` が食い違い、下見が実行の予告にならない（この口は「下見を既定にして、見てから押す」のが設計の中心）。
        // 第4引数には `selectArchiveRemovalTargets` へ渡したのと同じ実効値を渡す: `false`（`sessionIds` を名指ししたときだけ開ける道）は含有の証明が無いので、ここでも狭めてはいけない。値をそのまま転送して選定側と guard 側の条件を揃える。
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

        // `targeted` は guard を通った後の件数にする: guard 前の件数だと、飛ばした行が `targeted` と `skipped.inUse` の両方に数えられて `matched === targeted + remaining + skipped の総和` が破れる。`removedIds` も guard 通過後だけ。`limit` は guard より前に効くので、`targeted` が `limit` に届かないのに `remaining` が残ることはバグではない。
        const targeted = removableTargets.length;

        if (dryRun !== false) {
          return c.json(
            archiveRemoveManyResponseSchema.parse({
              ok: true,
              dryRun: true,
              totalRows: selection.totalRows,
              matched: selection.matched,
              targeted,
              removedIds: removableTargets.map((row) => row.id),
              removedBytes: 0,
              remaining: selection.remaining,
              skipped: { ...selection.skipped, inUse: skippedInUse },
              // dryRun は `remove()` を呼ばないので raced は測れない: 欄を省くと「測っていない」と区別がつかなくなるので常に0で出す。
              raced: 0,
            }),
          );
        }

        // 塊ごとに「消す → その塊の id を日誌へ書く」を交互に回す: まとめて消してから日誌を書くと、その間にデーモンが落ちたとき「消えたのに記録が無い行」ができる。
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
              // `already` も同じ競合: `remove()` は本文だけを墓標にするので、他経路が先に消していた回は `missing` ではなく `already` が普通。この呼びが消したことにしない（触っていない id を応答・日誌に載せない）。`targeted` には数えているので、黙って `continue` すると `removedIds` にも `skipped` にも現れない行ができ `targeted === removedIds.length + raced` が破れる。隠さず `raced` へ数える。
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
          // この塊の日誌が落ちても残りの塊は消すのを続ける: 途中で 500 を返して抜けると、残りの塊が消されないまま応答も返らず、何件消したかが分からなくなる。
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

    // クローン自身の道具（`inbox_remove_many`）はまだ無い: 自分の受信箱を自分で捨てられることの是非があるため保留中で、ここへ道具を足す実装者は別 PR（draft・`[保留]`）の判断（takecchi）を待つこと。絞り込みの判定（`matchesInboxRemoveManyFilter`）は SQL 側に複製しない。「全部消すを1回で撃てる形は作らない」: 事故で受信箱を1回で空にできる形を作らない。
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

        // 絞り込みの無い呼びを断る。
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
          // 存在しない日付・日付でない文字列を別の時刻として読んで消さず、時差の無い時刻をデーモンの地方時刻として読んで消さない: 元に戻せない一括削除なので時差を必須にする（道具 `inbox_remove_many` と同じ門・同じ文言）。
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
        // 絞りはここで当てる: SQL 側に同じ判定を複製しない（`matchesInboxRemoveManyFilter`）。
        const allPending = (await stores.inbox.peekPending()).entries;
        const matched = allPending.filter((row) => matchesInboxRemoveManyFilter(row, filter));

        const effectiveLimit = limit ?? REMOVE_MANY_LIMIT_DEFAULT;
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
              droppedFromDelivery: 0,
              remaining,
            }),
          );
        }

        // 塊ごとに「消す → その塊の id を日誌へ書く」を交互に回す: まとめて消してから日誌を書くと、その間にデーモンが落ちたとき「消えたのに記録が無い行」ができる。
        const chunks = chunkIdsByChars(
          targets.map((row) => row.event.id),
          REMOVE_MANY_JOURNAL_ID_CHARS,
        );
        const removedIds: string[] = [];
        let droppedFromDelivery = 0;
        for (const [index, chunk] of chunks.entries()) {
          // `stores.inbox.removeMany` を直に呼ばない: 器から消すのと配達を止めるのを1つの呼びで行うクローンの道具と同じ関数を通す。2箇所に割れたまま残すと片方だけ直っている形が再生産される。
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
          // 日誌が落ちても他の塊の処理は止めない: この塊が消えた事実は変わらない。
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

    // `claimPending()` ではなく `peekPending()` を使う: `claimPending()` は呼ぶだけで未読の全行の `deliveries`（器の入れ替え回数）を進めるので、ただ読むだけの口が「器が入れ替わった」という嘘の回数を増やしてはならない。集計は `summarizeInboxBacklog` をそのまま呼び複製しない: クローンの `manager_list` とこの口が別々の集計を持つと数が食い違う。上限（bySource の上位5件）も同じ関数から継承する。
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

    // `limit` のクエリ引数は無い: 帳面自体が `RECENT_TRACE_LIMIT` で上限を持つので、HTTP の口はいつも全件を返す（人間はブラウザで扱えるので締めると能力が落ちる。予算を持つのはエージェント向けの `self_dropped` だけ）。跡が0件でも 200 を返し、404 やエラーにしない: 「握り潰しが1件も無かった」わけではなく、プロセスの生存中だけの記憶で再起動で消える。
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

    // 取れない行を 0 に丸めない: `unreadable` / `trimmedClosed` はストアが返したまま core へ渡す。`github` は観測の記録を返すだけ（デーモンは GitHub を見に行かない）。
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
        // 「渡されなかった」と「空文字が渡された」を分ける: `Number('')` は 0 で、core の窓の検査に任せると意図の読めない 400 になる。
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
          // `windowHours` の検査だけを 400 にする: ストアの `RangeError` は握らない。
          if (error instanceof InvalidProgressWindowError) {
            return c.json({ error: PROGRESS_WINDOW_HOURS_INVALID_MESSAGE }, 400);
          }
          throw error;
        }

        return c.json(progressResponseSchema.parse(view));
      },
    )

    // 申告を受けて残すだけで値は確かめない（`observedBy` を必須にし、`github` が「誰の観測か」を必ず返す）。いつ・誰が観測するかは決めない: 対応表を持った瞬間に自動化ジョブに戻る。日誌が状態そのものなので `appendJournalOrDrop` は使わない（あれは状態変更が済んだ後の型）: 追記できなければ記録は1行も残らずそのまま 500。
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

    // 宣言された成功応答（200/202）はすべて宣言スキーマの `.parse()` を通す（エラー応答はその場のリテラルなので通さない）: `resolver()` は spec を作るだけでハンドラの戻り値を検査しないので、通していない経路では宣言に無いフィールドが黙って外へ出る。応答スキーマ（`accountViewSchema` 系）は core の永続化スキーマから独立させてあり、account の行が増えても外へは載らない。
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
        // 連携の鍵は `authenticate` が既定で拒否するのでここへ来ない: 来たら二重の門で断る。
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

    // 提示している1本だけを失効させ、同じアカウントの他のトークンは触らない（アカウントごと締め出すのは `POST /access/:accountId/revoke`）。operator の資格では失効させられない: `AccessTokenRecord` を持たず、失効させる対象が無い別の種類の資格なので 4xx で断り `alteroid access revoke` へ誘導する。応答にトークンの値も sha256 も載せない。
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
        // bearer が無いことは無いはずだが、型では narrow できないため防御的に扱う。
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

    // 持つのは許可されているか否かの2値だけ: 「chat は可・記憶の編集は不可」のような行為別のスコープを足すと、PRD「権限境界」が禁じている「確認が要る行為の一覧」と同じ形になり、クローンの判断を設定で置き換えることになる。
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
        // 0件なら鍵ごと無い。email などの中身は載せない（id と不正な欄名だけ）。
        const rowsUnreadable = toRowsUnreadable(await stores.auth.listUnreadableAccounts());
        return c.json(
          accessListResponseSchema.parse({
            accounts: await Promise.all(accounts.map((account) => accountView(stores, account))),
            ...(rowsUnreadable === undefined ? {} : { rowsUnreadable }),
          }),
        );
      },
    )

    // 許可は伝播する（A が B を、B が C を通せる）: 代わりに下の日誌が「誰が誰を通したか」を毎回残し、それが伝播を事後に追える唯一の場所になる。
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
        // 対象を先に引く（門前払い。無ければ 404 で日誌は書かない）: 早期の検査でしかなく、実際に許可される保証は `authService.grant` の結果でしか取れない。
        const before = await stores.auth.getAccount(accountId);
        if (before === null) return c.json({ error: 'not found' as const }, 404);

        // `describeActor` を省いて `operator` 固定にしない: 許可は人間の手を経ずに伝播しうるので、ここが唯一の歯止め。日誌を先に書き、書けなければ状態を変えずに 500: 状態変更の後に書いて `appendJournalOrDrop` で握ると「記録の無い許可」を作ってしまう。
        await stores.journal.append({
          type: 'decision',
          decision: `アクセス許可を付与: ${describeAccount(before)}`,
          grounds: `${describeActor(c.get('principal'))}（alteroid access grant）`,
        });

        let result: GrantResult;
        try {
          result = await authService.grant(accountId, actorOf(c.get('principal')));
        } catch (error) {
          // 日誌には「付与した」が残っているので打ち消す: 記録が多すぎる側の穴は「記録の無い許可」より安全側。
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
          // 対象を引いてから状態を変えるまでの間に消えた: 同じ理由で打ち消す。
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
        // 読めない行は「無い」（404）ではなく「読めない形で在る」（409）と言い分ける。
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
        // 取り消しは効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`。狭める側の扱い）。
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

    // `:accountId` と取り違えないよう別の語（`unreadable`）の下に置く。
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

    // `requireOperator`: 許可されたアカウントからは叩けない。旗を立てられる者を常にホストへ到達できる者へ限ることが「伝播しない」という性質そのもので、`authenticate` だけを許す設計は取らない。宣言は資格の判断には使っていない（ログインできる人＝持ち主）が仕組みは当面残してある。
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
        // 対象を先に引く（門前払い）のは早期の検査でしかない: 判定と `authService.setOwner` の間で許可が落ちる窓は下の `not_granted` 分岐が拾う。
        const before = await stores.auth.getAccount(accountId);
        if (before === null) return c.json({ error: 'not found' as const }, 404);
        if (!isAccountGranted(before)) {
          return c.json(
            { error: 'このアカウントはまだ許可されていない（先に access grant が要る）' as const },
            409,
          );
        }

        // 日誌を先に書く（`/access/grant` と同じ理由）: 記録の無い宣言を作らない。書けなければ状態を変えずに 500。
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
        // `not_granted` は取り消しでは起こらない（取り消しは行が在れば常に通る）。
        if (result.status === 'not_granted') return c.json({ error: 'not found' as const }, 404);
        // 取り消しは効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`。狭める側の扱い）。
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

    // 資格は `authenticate` だけで `requireOperator` は付けない: 基準は「壊すかどうか」ではなく、鍵そのものを扱う口だけが一段上の強さを持つ。ここは鍵を扱わず記憶も台帳も消さず、止めた後に起動し直せば元に戻る（`POST /reset` とは取り返しのつき方が違う）。`deliberateClient` は資格の門ではない（ブラウザの単純リクエストを止めるもの）ので、資格の門が見当たらないのを「付け忘れ」と読まないこと。
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

    // `confirm: true` を必須にする: 確認ダイアログは呼ぶ前の話で、この口自体にも確認の印を要求して確認を経ない直接の呼び出し（スクリプト等）を 400 で止める。`access grant` だけのアカウントに記憶そのものを消せる資格までは渡さない。
    .post(
      '/reset',
      describeRoute({
        tags: ['system'],
        summary: 'トークン情報以外のワークスペースを全部消す',
        // `describeResetTargets()` から組み立てる（CLI の確認の文と同じ出所）: 手で書き写すとここだけ古くなる。
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
        // 写しは置き場の外のファイルなのでここで消す。消せなくても 500 にしない: 本体はもう消えており、申告の `cleared` を失わない。
        if (deps.attachmentCopiesDir !== undefined) {
          await rm(deps.attachmentCopiesDir, { recursive: true, force: true }).catch(
            (error: unknown) => {
              process.stderr.write(
                `alteroidd: リセットで添付の写しを消せなかった: ${reasonOf(error)}\n`,
              );
            },
          );
        }
        // 日誌が落ちても 500 を返さない（特に重要）: `cleared` は取り消せない操作の唯一の申告で、500 にすると実際には消えている件数が応答から失われる。
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

  // チェーンに載せない: `.get(...)` を差し込むと以降の型引数が積み重なり `AppType`（CLI の `hc<AppType>` が依存する型）の推論が壊れかねない。`exclude` は describeRoute の無い経路が spec に載らない動作を明示する二重の安全策。
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

// `instanceof` ではなく `name` と `settled` で見分ける: `CloneHost` の向こうの実装を差し替えるテストの偽物でも、同じ形で投げれば同じ扱いになる。
function approvalSettledKindOf(error: unknown): 'answered' | 'withdrawn' | undefined {
  if (!(error instanceof Error) || error.name !== 'ApprovalAlreadySettledError') return undefined;
  const settled = (error as Error & { settled?: unknown }).settled;
  return settled === 'answered' || settled === 'withdrawn' ? settled : undefined;
}
