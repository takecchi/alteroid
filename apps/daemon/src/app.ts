import { randomUUID } from 'node:crypto';

import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type {
  AccountUsageState,
  PluginDistributionService,
  PluginFetcher,
  CloneHost,
  CredentialService,
  CodexChatgptAuthService,
  McpServerService,
  DelegatedPermissionRuleService,
  Exchange,
  InboxEvent,
  JournalEntry,
  JournalEntryInput,
  JournalEntryType,
  Practice,
  ProfileService,
  RunnerRegistry,
  Scheduler,
  Stores,
  TokenPoolService,
} from '@alteroid/core';
import {
  conversationBindingKey,
  PracticeConflictError,
  practiceVersion,
  practiceVersionMatches,
  JOURNAL_SEARCH_UNCOVERED_LIST_MD,
  createPluginPreviewStore,
  describeAttachmentAlreadyGoneRetraction,
  describeAttachmentForJournal,
  DAEMON_ATTACHMENT_USAGE_SOURCE,
  JournalAnchorNotFoundError,
  UnreadablePracticeError,
  chatStreamEventSchema,
  countUnread,
  countUnreadConversations,
  effectiveReadThrough,
  loadConversationReadView,
  computeSupersededIds,
  conversationMessages,
  findUnrecordedManagers,
  describeUnreadableJournalTimeBoundary,
  isAccountGranted,
  isDailyReport,
  JOURNAL_ENTRY_TYPES,
  journalEntrySchema,
  journalWindowCrossesHorizon,
  localDayRange,
  normalizeJournalTimeBoundary,
  practiceKindSchema,
  practiceSlugSchema,
  noteDroppedRecord,
  reasonOf,
  redactErrorText,
  readConversationPage,
  readConversationWindow,
  readConversationWindowPage,
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
  startSseHeartbeat,
  summarizeUsage,
  usageDate,
  usageDateSchema,
  usageLayerSchema,
  usageSiteSchema,
  integrationKeyLimits,
  looksLikeIntegrationKey,
  resolveIntegrationKey,
  type IntegrationKeyRecord,
  type AuthService,
} from '@alteroid/core';
import {
  AttachmentContentRemoveError,
  AttachmentCursorError,
  AttachmentRejectedError,
  hasNul,
  ATTACHMENT_INTEGRATION_NOTICE_BYTES_DEFAULT,
  removeAttachmentCopy,
  stripNul,
  type AttachmentLimits,
  writeStderrLine,
} from '@alteroid/core';
import { bearerOf, isOperator, type AuthPlan, type AuthVariables } from './auth.js';
import { clientMessageFingerprint } from './client-message-fingerprint.js';
import { checkAndBindAttachments, type AttachmentBatchResult } from './attachment-batch.js';
import { createFixedWindowRateLimiter, judgeIntegrationRoute } from './integration-gate.js';
import { survivesDeletion, type JournalBus } from './journal-bus.js';
import {
  SSE_SEND_QUEUE_MAX_CHARS,
  SSE_SEND_QUEUE_MAX_ITEMS,
  SseSendQueue,
} from './sse-send-queue.js';
import { httpTimingMiddleware, type HttpTimingRecorder } from './http-timing.js';
import { Scalar } from '@scalar/hono-api-reference';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi';
import { z } from 'zod';
import {
  cloneInterruptRequestSchema,
  cloneInterruptResponseSchema,
  cloneSessionReopenRequestSchema,
  cloneSessionReopenResponseSchema,
  attachmentErrorResponseSchema,
  attachmentKeptBodySchema,
  attachmentLimitsSchema,
  attachmentListQuery,
  attachmentListResponseSchema,
  attachmentMetaSchema,
  conversationDetailResponseSchema,
  conversationReadRequestSchema,
  conversationReadResponseSchema,
  conversationsResponseSchema,
  conversationDeleteResponseSchema,
  unreadConversationCountResponseSchema,
  healthResponseSchema,
  statusResponseSchema,
  journalListResponseSchema,
  clientMessageLookupResponseSchema,
  okResponseSchema,
  openApiDocumentation,
  openApiExcludePaths,
  practiceDeleteResponseSchema,
  practiceListResponseSchema,
  practiceConflictResponseSchema,
  practiceReadResponseSchema,
  practiceWriteResponseSchema,
  practiceVersionListResponseSchema,
  practiceVersionReadResponseSchema,
  reportsResponseSchema,
  topologyResponseSchema,
  usageResponseSchema,
} from './openapi.js';
import { InvalidCursorError } from './cursor.js';
import { type WorkerToolBus } from './topology-activity.js';
import { describeProbeError, topologySignature } from './topology.js';
import {
  compareDailyReportsNewestFirst,
  listDailyReports,
  listDailyReportsBefore,
} from './reports.js';
import { createAppContext, principalRefOf } from './app-context.js';
import {
  ifMatchDeleteQuery,
  ifMatchField,
  deliberateClient,
  mimeEssence,
  emptyJsonPostRequestBody,
  noBodyPostResponses,
  NO_ACCESS_GRANT_DESCRIPTION,
  INVALID_QUERY_DESCRIPTION,
  jsonResponse,
  errorResponse,
  journalWriteFailedResponse,
  whereValidationFailed,
  invalidWith,
  jsonBody,
  queryParams,
  describeActor,
  appendJournalOrDrop,
  journalWriteFailedBody,
  humanRetractor,
  readJournalEntry,
  kindOfError,
  humanActionOf,
  isWellFormedString,
} from './app-shared.js';
import { adminRoutes } from './app-routes-admin.js';
import { memoryRoutes } from './app-routes-memory.js';
import { authRoutes } from './app-routes-auth.js';
import { workspaceRoutes } from './app-routes-workspace.js';
import { tokensRoutes } from './app-routes-tokens.js';
import { profileRoutes } from './app-routes-profile.js';
import { pluginsRoutes } from './app-routes-plugins.js';
import { credentialsRoutes } from './app-routes-credentials.js';
import { managersRoutes } from './app-routes-managers.js';
import { tasksRoutes } from './app-routes-tasks.js';
import { scheduleRoutes } from './app-routes-schedule.js';
import { approvalsRoutes } from './app-routes-approvals.js';
import { integrationRoutes } from './app-routes-integration.js';

export { humanActionOf } from './app-shared.js';
// 外から叩かせるなら境界は手前（リバースプロキシ・トンネル・認証）に置く: 能力側で絞らず実行環境の境界で守る（north_star 禁止2）。
export interface AppDeps {
  clone: CloneHost;
  stores: Stores;
  token: string;
  shutdown: () => void;
  now?: () => Date;
  attachmentLimits?: AttachmentLimits;
  /** 要求ごとの時間の受け手（#5089）。無くても `Server-Timing` は付ける */
  httpTiming?: HttpTimingRecorder;
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
  // 委譲先の許可規則（#4952）。マネージャーのプールと同じインスタンスを渡す（`profile` と同じ理由）。渡さなければ取り消しを runner へ配らない（次の名乗りで降りる）。
  permissionRules?: DelegatedPermissionRuleService;
  pluginFetcher?: PluginFetcher;
  // マネージャーのプールと同じインスタンスを渡す（`profile` と同じ理由）。
  pluginDistribution?: PluginDistributionService;
  // マネージャーのプールと同じインスタンスを渡す（`profile` と同じ理由）。
  codexAuth?: CodexChatgptAuthService;
  // 回さない: ここが生やすのは器の読み書きの口だけで、検知・切替は無い。
  tokens?: TokenPoolService;
  // 無ければ `storage.state` は `unknown`: 確かめる手段が無いことを `ok` に化けさせない。毎リクエストでは叩かない。
  storageProbe?: () => Promise<void>;
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

// `application/octet-stream` だけを受ける（`deliberateClient` と同じ考え方）: CORS の単純リクエストの content-type に入らず preflight が必ず要るので、任意のページから `no-cors` の fetch や form で添付を預けられない。`multipart` を受けないのも同じ理由。
const octetStreamClient = createMiddleware(async (c, next) => {
  if (mimeEssence(c.req.header('content-type')) !== 'application/octet-stream') {
    return c.json({ error: 'content-type: application/octet-stream が要る' as const }, 415);
  }
  await next();
});

// 記憶・やり方の 409 の本文の組み立て（検査の順序は route ごとに違うので寄せない）。`error` は `as const` のリテラルのまま返す: 文が `string` に広がると `hc` の応答の型が変わる。
const PRACTICE_CONFLICT_ERROR = {
  write: 'やり方が読んだ後に変わっています（書き換えていません）',
  remove: 'やり方が読んだ後に変わっています（消していません）',
} as const;
const practiceCurrent = (practice: Practice) => ({
  practice,
  version: practiceVersion(practice),
});
const practiceConflictBody = <Op extends keyof typeof PRACTICE_CONFLICT_ERROR>(
  current: Practice | null,
  op: Op,
) => ({
  error: PRACTICE_CONFLICT_ERROR[op],
  current: current === null ? null : practiceCurrent(current),
});
// `kind` に列挙を課さない: 道具（`practice_write`）と HTTP とで書ける種類が食い違う（`practiceKindSchema` の doc）。`title` も core 側に制約が無いので足さない。
const practiceBody = z.object({
  kind: practiceKindSchema,
  title: z.string(),
  content: z.string(),
  ifMatch: ifMatchField,
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
  // カンマ区切りで複数。知らない値は 400 で断る（ハンドラで検査）: 黙って無視すると、綴りを間違えた呼びが「0件」として返り、「起きていない」と読み違える。スキーマを `z.enum` にしないのは、未知のキーを拒まない方針と同じく検査をハンドラに寄せて、有効値の案内を error に載せるため。
  type: z.string().optional(),
  // `q=`（空文字列）は絞らない: 検索欄を空にした呼びが 0 件を返すと「消えた」と読まれるので `.min(1)` を掛けない。画面のために別の口を足さない。
  q: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  afterId: z.string().optional(),
  afterAt: z.string().optional(),
  // `z.coerce.boolean()` を使わない: `?horizon=false` が true になってしまう。既定は付けない（`.optional()`）: 渡さない呼びの応答を1バイトも変えない。
  horizon: z.enum(['true', 'false']).optional(),
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

const GONE_OR_EXPIRED_DESCRIPTION = '無い（消えた・期限切れ）。';

const CHAT_POST_UNAVAILABLE_MESSAGE =
  '発言を受信箱へ書けなかったので受け取っていない（記憶の器の不調）。送り直してよい。';

// `/auth/me` と `/auth/logout` だけは認証が要る: logout は提示している資格そのものを失効させる設計なので、提示なしに叩ける素通しの口にしない。
function isPublicPath(path: string): boolean {
  if (path === '/health' || path === '/openapi.json' || path === '/docs') return true;
  if (path === '/auth/me' || path === '/auth/logout') return false;
  return path === '/auth' || path.startsWith('/auth/');
}

/**
 * 連携の鍵1本あたりの、期限内の添付の預かりがこれを越えたら知らせる（#4005。オーナーの判断で 1GiB から始める）。
 * 既定値。実際の値は `ALTEROID_ATTACHMENT_INTEGRATION_NOTICE_BYTES` で変えられる（`readIntegrationAttachmentNoticeBytes`）
 */
export const INTEGRATION_ATTACHMENT_NOTICE_BYTES = ATTACHMENT_INTEGRATION_NOTICE_BYTES_DEFAULT;

/**
 * 連携の鍵が上げた添付で、その鍵の預かり（期限内）が閾値を越えたら、日誌とクローンへ1回知らせる（#4005）。
 * 断らない: 枠を置かないのがオーナーの決定で、これは決め直すための材料と契機である。
 * 状態を持たず「この1件で越えたか」だけを見る（上げる前は閾値未満・上げた後は閾値以上）: 越えるのは一度きりで、デーモンの再起動をまたいでも二度鳴らないため。
 * 掃除で下がってからもう一度越えれば、もう一度鳴る。
 */
export async function noteIntegrationAttachmentUsage(
  stores: Pick<Stores, 'attachments' | 'journal'>,
  post: (event: InboxEvent) => void,
  keyId: string,
  addedBytes: number,
  threshold: number = INTEGRATION_ATTACHMENT_NOTICE_BYTES,
): Promise<void> {
  let total: number;
  try {
    total = (await stores.attachments.usage()).byIntegrationKey[keyId]?.totalBytes ?? 0;
  } catch (error) {
    noteDroppedRecord('連携の鍵の添付の使用量', `keyId=${keyId}`, error);
    return;
  }
  const before = total - addedBytes;
  if (!(before < threshold && total >= threshold)) return;
  const text =
    `連携の鍵 ${keyId} が上げた添付の預かり（期限内）が ${String(total)} バイトになり、` +
    `閾値 ${String(threshold)} バイトを越えた。上げることは断っていない。` +
    '鍵ごとの内訳は GET /attachments の usage.byIntegrationKey で見られる。止めるなら、その鍵を失効させる。';
  await appendJournalOrDrop(
    stores,
    {
      type: 'decision',
      decision: text,
      grounds: `keyId=${keyId} totalBytes=${String(total)} threshold=${String(threshold)}`,
    },
    '連携の鍵の添付の閾値の知らせ',
    `keyId=${keyId}`,
  );
  post({
    type: 'external',
    id: randomUUID(),
    at: new Date().toISOString(),
    source: DAEMON_ATTACHMENT_USAGE_SOURCE,
    payload: { text, keyId, totalBytes: total },
  });
}

export function createApp(deps: AppDeps) {
  const ctx = createAppContext(deps);
  const {
    clone,
    stores,
    sseHeartbeatMs,
    streamSSE,
    attachmentLimits,
    integrationAttachmentNoticeBytes,
    attachmentUploadSizeGate,
    receivedClientMessages,
    rejectDuplicateClientMessage,
    startedConversations,
    rememberStartedConversation,
    findReceivedClientMessage,
    claimClientMessage,
    replayReceivedMessage,
    topologyActivity,
    topology,
    topologyTickMs,
    topologyDebounceMs,
    authPlan,
    clock,
    authService,
    watchSseCredential,
    chatEventPump,
    providerList,
  } = ctx;

  const integrationRateLimiter = createFixedWindowRateLimiter(() => clock().getTime());
  // 鍵の値は出さない（id だけ）。
  function noteIntegrationRefusal(
    c: Context,
    status: 401 | 403 | 413 | 429,
    why: string,
    keyId?: string,
  ): void {
    writeStderrLine(
      `alteroid: 連携の鍵の要求を断った（${String(status)}、${why}）: ` +
        `${c.req.method} ${c.req.path}${keyId === undefined ? '' : ` keyId=${keyId}`}\n`,
    );
  }

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
      now: clock(),
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

  // 経路の本数をここで数え直さない: 数え上げの持ち主は `scripts/require-operator-routes.test.ts` の `EXPECTED_OPERATOR_ROUTES`。いまこの門を付けた経路は無い（#2948 で持ち主の宣言の口を畳んだ）。門そのものは、応答本文に鍵が丸ごと載るか実行環境そのものを差し替える口を作るときのために残してある。
  // 配線した経路がいまは無いので未使用になる（#2948）。門そのものは残す。外すと、実行環境そのものを差し替える口を作り直すときに門から書き直すことになる。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const requireOperator = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (c.get('principal').kind !== 'operator') {
      return c.json({ error: '実行環境の持ち主だけが操作できる' as const }, 403);
    }
    await next();
  });

  // 確定は取り直さず預かったものをそのまま保存する: 確認から確定までに取り元が動いても、見せたものと入れるものがずれない。
  const pluginPreviews = createPluginPreviewStore();

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
    writeStderrLine(
      `alteroidd: HTTP 経路で例外を捕まえました（本文は出しません）: ${reasonOf(err)}\n`,
    );
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  base.notFound((c) => c.json({ error: 'not found' }, 404));

  // 時間の計測は CORS・認証より前に置く: 認証の DB 引きも、preflight も、その要求の時間として数えるため（#5089）
  base.use('*', httpTimingMiddleware(deps.httpTiming));

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
          200: jsonResponse('応答している。', healthResponseSchema),
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
          200: jsonResponse('認証を通った相手への説明。', statusResponseSchema),
          401: errorResponse('資格が無い。'),
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
          200: jsonResponse('預かった。控え（中身を含まない）を返す。', attachmentMetaSchema),
          400: jsonResponse(
            'クエリが不正、または受け付けない中身（`code`: `magic_mismatch` / `image_dimension_too_large` / `media_type_missing` / `empty`＝0バイト）。',
            attachmentErrorResponseSchema,
          ),
          413: jsonResponse('大きすぎる（`code`: `too_large`）。', attachmentErrorResponseSchema),
          403: errorResponse('連携の鍵が `keep` を付けた（鍵は保存の印を付けられない）。'),
          415: errorResponse('content-type が application/octet-stream ではない。'),
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
            uploadedBy: principalRefOf(c.get('principal')),
          });
          if (principal.kind === 'integration') {
            // 応答を待たせない: 知らせは上げた結果を変えず、使用量の集計の時間を鍵の呼び手へ負わせないため
            void noteIntegrationAttachmentUsage(
              stores,
              (event) => clone.post(event),
              principal.keyId,
              meta.size,
              integrationAttachmentNoticeBytes,
            );
          }
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
          200: jsonResponse('控えの一覧と使用量。', attachmentListResponseSchema),
          400: errorResponse('クエリが不正（`cursor` が読めない、`limit` が範囲外など）。'),
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
          200: jsonResponse('上限。', attachmentLimitsSchema),
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
          200: jsonResponse('控え。', attachmentMetaSchema),
          404: errorResponse(GONE_OR_EXPIRED_DESCRIPTION),
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
          404: errorResponse(GONE_OR_EXPIRED_DESCRIPTION),
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
          200: jsonResponse('更新後の控え。', attachmentMetaSchema),
          400: errorResponse('本文が不正（`kept` は真偽値）。'),
          404: errorResponse(GONE_OR_EXPIRED_DESCRIPTION),
        },
      }),
      jsonBody(attachmentKeptBodySchema),
      async (c) => {
        const { kept } = c.req.valid('json');
        const meta = await stores.attachments.setKept(c.req.param('id'), kept, clock());
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
          '取り消せない。連携の鍵は 403。' +
          '消す前に、控え（id・名前・種類・大きさ・sha256・出所・保存中だったか。中身は書かない）と誰が消したかを日誌（`decision`）へ残す' +
          '（クローンの `file_delete` と同じ）。日誌に書けなければ消さずに 500 を返す。' +
          '外部の置き場に預けた中身は先に消す: 消せなかったとき（置き場の障害・設定が無い）は、消さずに 503 で断り（控えも残す）、理由を返す。もう一度消すと再試行する。',
        responses: {
          204: { description: '消した（中身が消えたときだけ）。' },
          404: errorResponse(GONE_OR_EXPIRED_DESCRIPTION),
          500: journalWriteFailedResponse(
            '日誌が書けなかった（**消していない**。中身も控えも残っている）。',
          ),
          503: errorResponse(
            '中身を置き場から消せなかったので、消していない（控えも残した）。本文の `error` に理由。もう一度消すと再試行する。',
          ),
        },
      }),
      async (c) => {
        const id = c.req.param('id');
        const actor = `${describeActor(c.get('principal'))}（DELETE /attachments/:id）`;
        // 消す前に控えを日誌へ書き、書けなければ消さずに 500（#5280）: 消した後では名前も大きさも sha256 も辿れない（`file_delete` と同じ順序）。
        // 控えが無い（404 になる）回は書かない: 消すものが無い
        const meta = await stores.attachments.getMeta(id);
        if (meta !== undefined) {
          try {
            await stores.journal.append({
              type: 'decision',
              decision: `添付の中身と控えを消す: ${meta.name}（id=${meta.id}）`,
              grounds: `${actor}。消す前の控え: ${describeAttachmentForJournal(meta)}`,
            });
          } catch (error) {
            noteDroppedRecord('添付の削除の日誌（消していない）', `id=${id}`, kindOfError(error));
            return c.json(journalWriteFailedBody(), 500);
          }
        }
        let removed: boolean;
        try {
          removed = await stores.attachments.remove(id);
        } catch (error) {
          if (!(error instanceof AttachmentContentRemoveError)) throw error;
          // 断ったことを日誌に残す（先に書いた「消す」の行だけでは、消したように読まれるため）。書けなくても断りは変えない。
          await appendJournalOrDrop(
            stores,
            {
              type: 'decision',
              decision: `添付を消せなかった（中身を置き場から消せないので、消していない。控えも残した）: ${meta === undefined ? '' : `${meta.name}、`}id=${id}`,
              grounds:
                `${actor}。理由: ${error.reason}。` +
                (meta === undefined ? '' : '直前の「消す」の行は実行されていない。') +
                'もう一度消すと再試行する。',
            },
            '添付の削除の断りの日誌',
            `id=${id}`,
          );
          return c.json(
            {
              error: `中身を置き場から消せなかったので消していない（控えも残した）。理由: ${error.reason}。もう一度消すと再試行する`,
            },
            503,
          );
        }
        // 写しは本体が無かったときも消す: 本体だけ先に消えて取り残された写しを片付ける。
        if (deps.attachmentCopiesDir !== undefined) {
          await removeAttachmentCopy(deps.attachmentCopiesDir, id);
        }
        if (!removed) {
          // 控えを読んだ後に別の手で消えていた回: 先に書いた「消す」の行はこの呼びでは実行されていない
          if (meta !== undefined) {
            await appendJournalOrDrop(
              stores,
              { type: 'decision', ...describeAttachmentAlreadyGoneRetraction(meta, actor) },
              '添付の削除の打ち消しの日誌',
              `id=${id}`,
            );
          }
          return c.json({ error: 'not found' as const }, 404);
        }
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
          '（編集前のターンで起きた副作用——承認待ち・記憶・マネージャー・起票した Task——は' +
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
          400: errorResponse(
            '`text` が空で添付も無い、または本文が JSON として不正。または `supersedes` の検証に' +
              '落ちた——`conversationId` が無いのに `supersedes` がある、指した id が' +
              '見つからない・この会話のものではない、クローンの応答（outbound）を指して' +
              'いる、既に別の編集に置き換えられている、のいずれか。' +
              '`clientMessageId` の形が不正（英数字・`_` `-` の1〜128字）のときも 400。',
          ),
          404: errorResponse(
            '`conversationId` を渡したが、その会話が無い（`code: conversation_not_found`。日誌の人間との往復を' +
              '最後まで読んで見つからなかった）。**その文字列で新しい会話は始めない**——新しい会話を始めるなら' +
              '`conversationId` を省く。略記・前方一致では受けない（一意に当たる会話が在れば、`error` に完全な id を出す）。' +
              '何も積まず、添付も結び付けない。',
          ),
          409: errorResponse(
            '`clientMessageId` が、**別の会話**の発言として既に受け取られている（`code: client_message_id_conflict`）。' +
              'または、**同じ会話**で受け取り済みだが**中身が違う**（`code: client_message_id_mismatch`。' +
              '本文・添付の id の集合・`supersedes` のどれかが1回目と違う。2回目の中身は積まず、添付も結び付けない）。' +
              '中身が同じ再送は 409 ではなく、二重に受けずに 200（下の説明）。' +
              'または、`supersedes` が指す発言が日誌に**在るが読めない**（`code` は無い。400 の「見つからない」とは別。' +
              '何も積まない）。',
          ),
        },
      }),
      jsonBody(chatBody, invalidWith('text が空（添付も無い）、または本文の形が不正')),
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
            const targetRead = await readJournalEntry(stores, supersedes);
            // 在るが読めない行を「見つからない」（400）と言わない: 他の `Unreadable*Error` と同じ 409。
            if (targetRead.kind === 'unreadable')
              return failEdit({ error: targetRead.message }, 409);
            const target = targetRead.value;
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
            // 置き換え済みかは畳み込み規則（`computeSupersededIds`）でしか判定できない: 表示用の窓ではなくこの会話の全履歴が要るので `scan` に事実上の無制限を渡す。他の会話の往復は読まない（ストア側で絞る）。
            const fullHistory = await readConversationWindow(stores.journal, {
              scan: Number.MAX_SAFE_INTEGER,
              conversationId: given,
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
            serializeKey: conversationBindingKey(conversationId),
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
        // 新しく引いた会話 id で受信箱へ書けなかったら、結んだ添付を戻す（#4759）: 送り直しは別の新しい会話 id になり、死んだ id に結ばれたままだと `attachment_conflict` で断られ続けるため。
        // 既存の会話では戻さない: 送り直しも同じ id に結び直すだけで困らず、戻すと同じ会話の他の発言の添付を外しうるため。
        // 受け取りの印を取り下げる前に呼ぶ: 同じ clientMessageId で待っている要求が、取り下げで起きて同じ添付を自分の会話 id へ結ぼうとするため。
        // 投げない: 戻せなかった添付は保持の期限まで残るだけで、元の失敗（503・例外）を置き換えないため（`postExternalPersisted` と同じ）
        const releaseNewConversationAttachments = async (): Promise<void> => {
          if (given !== undefined || attachmentRefs.length === 0) return;
          try {
            await stores.attachments.unbind(
              attachmentRefs.map((ref) => ref.id),
              { conversationId },
            );
          } catch (releaseError) {
            writeStderrLine(
              `alteroidd: 新しい会話 ${conversationId} の添付 ${String(attachmentRefs.length)} 件の結び付けを戻せなかった` +
                `（期限まで残る）: ${reasonOf(releaseError)}\n`,
            );
          }
        };
        // 受け取りの印（`claim`）は、受信箱へ書けた後で確定させる（#4679）: 書けなかった発言の id を「受け取り済み」と覚えると、再送が重複として畳まれるため

        return streamSSE(c, async (stream) => {
          const pump = chatEventPump();
          const unsubscribe = clone.subscribe(conversationId, (event) => pump.push(event));

          await pump.serve(
            stream,
            { principal: c.get('principal'), authorization: c.req.header('authorization') },
            unsubscribe,
            async () => {
              // `open` を書く前に積む（順序に意味がある）: `open` は「投函はもう済んだ」の合図で、追送だけしたい呼び（Web UI）は `open` を見た時点で接続を捨てる。逆順だと `stream.onAbort` が走った後にここへ来て、積む前に抜ける経路が生まれ発言が黙って消える。購読は手前で張ってあるので `queued` も取りこぼさない。
              // 受信箱へ書けたのを待ってから `open` を返す（#4679）: 待たずに返すと、書けなかった発言は「送れた」と見えたまま再起動で消えるため。
              // 書けなかったら `open` を出さずに閉じる: 画面と CLI は「送れたか確かめられなかった」として入力を戻す。日誌の発言の行は書けたときにしか書かれない
              let outcome: Awaited<ReturnType<CloneHost['postPersisted']>>;
              try {
                outcome = await clone.postPersisted({
                  type: 'human_message',
                  id: randomUUID(),
                  at: new Date().toISOString(),
                  text,
                  conversationId,
                  ...(supersedes === undefined ? {} : { supersedes }),
                  ...(attachmentRefs.length === 0 ? {} : { attachments: attachmentRefs }),
                  ...(clientMessageId === undefined ? {} : { clientMessageId }),
                });
              } catch (error) {
                await releaseNewConversationAttachments();
                claim?.settle(false);
                throw error;
              }
              if (outcome === 'unavailable') {
                await releaseNewConversationAttachments();
                claim?.settle(false);
                await stream.write(`: ${CHAT_POST_UNAVAILABLE_MESSAGE}\n\n`).catch(() => undefined);
                pump.finish();
                return;
              }
              claim?.settle(true);

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
          200: jsonResponse('受け取り済み。その会話の id。', clientMessageLookupResponseSchema),
          400: errorResponse('`clientMessageId` の形が不正（英数字・`_` `-` の1〜128字）。'),
          404: errorResponse('受け取っていない。'),
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
          404: errorResponse(
            'この会話は削除されている（`code: conversation_deleted`。#4218）。走り続けているターンの途中経過も見せない。',
          ),
          503: errorResponse('この器は途中経過を持たない（能力を落とさず、黙って隠さない）。'),
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
        requestBody: emptyJsonPostRequestBody('蒸留ターンを起こされないため'),
        responses: {
          200: jsonResponse('蒸留を促した。', okResponseSchema),
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
          200: jsonResponse(
            '止めた・取り下げた・別のターンなので止めなかった・止めるものが無かった・この器では止められない、のどれか。',
            cloneInterruptResponseSchema,
          ),
          400: errorResponse('本文が JSON として不正。または対象が片方しか無い・形が不正。'),
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
          200: jsonResponse(
            '開き直す印を立てた（now / deferred）。この器では開き直せないなら unsupported。',
            cloneSessionReopenResponseSchema,
          ),
          400: errorResponse('`confirm: true` を伴っていない、または形が不正。'),
          403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
        },
      }),
      jsonBody(
        cloneSessionReopenRequestSchema,
        invalidWith(
          '`confirm: true` を伴っていないか、形が不正（セッションの開き直しは確認を必須にしてある。' +
            'reason は 1〜500 字）',
        ),
      ),
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
          '`/approvals` と同じ形で、続きが無ければ `nextCursor` は無い。' +
          '壊れた `cursor`・指す発言が見当たらない `cursor` は 400。',
        responses: {
          200: jsonResponse('会話の一覧（新しい順）。', conversationsResponseSchema),
          400: errorResponse(
            'クエリが不正、または `cursor` が壊れている・指す発言が見当たらない。',
          ),
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
          clock().toISOString(),
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
          200: jsonResponse('未読のある会話の数。', unreadConversationCountResponseSchema),
        },
      }),
      async (c) => {
        const result = await countUnreadConversations({
          journal: stores.journal,
          reads: stores.conversationReads,
          now: clock().toISOString(),
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
          '**黙って打ち切らない** — `scanned`（この会話の人間との往復を何件遡ったか。他の会話・マネージャー' +
          'との往復・内部ターンは数えない。issue #418）でどこまで遡ったか、' +
          '`reachedStart` で窓がこの会話の先頭に届いたかを返す。`404` は `reachedStart` が' +
          '真のときだけ返る（「無い」と「遡り切れていない」を同じ応答にしないため）。' +
          '**既定（`includeSuperseded` を渡さない）では、チャットで編集され既定ビューから' +
          '畳まれた旧発言・その応答を除く。** 応答の `supersededCount` に畳まれた件数を' +
          '常に含める（0件でも含める）。`includeSuperseded=true` を渡すと畳まれた分も' +
          '含めて返し、各発言に編集の関係（`supersedes` / `supersededBy`）が付く。',
        responses: {
          200: jsonResponse(
            '会話の中身。`reachedStart` が偽なら、窓の外に続きが残っている可能性がある。' +
              '`messages` が空でこれが偽の場合は「無い」ではなく**判定できない**。',
            conversationDetailResponseSchema,
          ),
          400: errorResponse(INVALID_QUERY_DESCRIPTION),
          404: errorResponse(
            '該当する会話が無い（内部ターン `self` は含まれない）。**遡り切れた場合だけ** — ' +
              '窓の外かもしれないときは 200 で `reachedStart: false` を返す。',
          ),
        },
      }),
      queryParams(conversationQuery),
      async (c) => {
        const id = c.req.param('id');
        const { scan, includeSuperseded: includeSupersededRaw } = c.req.valid('query');
        const includeSuperseded = includeSupersededRaw === 'true';
        // この会話の行だけをストア側で絞る: 全会話の窓を読んでから絞ると、他の会話の往復が `scan` を食い尽くして古い会話が空に見えるため。
        const window = await readConversationWindowPage(stores.journal, {
          scan,
          conversationId: id,
        });
        const entries = window.entries;
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

        // 終端は件数から推さない: 読めない行を捨てて短くなった窓を「先頭に届いた」と誤り、窓の外の会話を 404 にしてしまうため
        const reached = window.reachedStart;

        // 一律 404 にしない: 消えた会話とまだ見ていない会話が区別できなくなる。遡り切れているときだけ「無い」と言い、切れていなければ空の結果に `reachedStart: false` を添えて判定を呼ぶ側へ渡す。
        if (messages.length === 0 && reached) {
          return c.json({ error: 'not found' as const }, 404);
        }
        const readView = await loadConversationReadView(
          stores.conversationReads,
          clock().toISOString(),
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
          200: jsonResponse('進めた後の実効の既読の位置と未読数。', conversationReadResponseSchema),
          400: errorResponse('本文が不正、または `through` の発言がこの会話のものでない。'),
          404: errorResponse('`through` の発言が日誌に無い（人間との往復でない場合を含む）。'),
          409: errorResponse(
            '`through` の発言は日誌に**在るが読めない**（形が合わない壊れた行。404 の「無い」とは別。' +
              '既読の位置は動かしていない）。',
          ),
        },
      }),
      jsonBody(conversationReadRequestSchema),
      async (c) => {
        const id = c.req.param('id');
        const { through } = c.req.valid('json');
        const targetRead = await readJournalEntry(stores, through);
        // 在るが読めない行を「見つからない」（404）と言わない。
        if (targetRead.kind === 'unreadable') return c.json({ error: targetRead.message }, 409);
        const target = targetRead.value;
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
        const now = clock().toISOString();
        // 基準時刻が無ければ先に決める: 位置より後に基準時刻が決まる順を作らない。
        await stores.conversationReads.ensureBaseline(now);
        await stores.conversationReads.advance(id, target.at);
        const readView = await loadConversationReadView(stores.conversationReads, now);
        const entries = await readConversationWindow(stores.journal, {
          scan: conversationsQuery.shape.scan.parse(undefined),
          conversationId: id,
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
          'その会話の発言に付いた添付と、Task（`task_list`）のその会話を起点とする行（未了・閉じた行とも。件数は `tasksRemoved`）は物理的に消す。その Task の本文を写した日誌の行（Task の id を含む `decision`）は、墓標の `hiddenEntryIds` で読む口から外す（行は書き換えない）。Task へ移さなかった旧台帳（廃止済み。テーブルも落とした）の行の本文を写した日誌の行は、会話との結び付きが分からないので、この削除では外せない。' +
          '受信箱の未処理の発言を外し、開いている `GET /chat/:id/stream` を閉じる（以後は 404）。' +
          '消した会話へは書けない（`POST /chat` は 404）。' +
          '**消せないもの**（クローンの SDK セッションの生ログ・archive・いまの文脈・蒸留済みの記憶・日報）は `remainsIn` に文で返す。' +
          '墓標の後の手当てが落ちたら、会話は外れたまま `incomplete` にそれを返す（200）。',
        responses: {
          200: jsonResponse('削除した。', conversationDeleteResponseSchema),
          403: errorResponse('許可（`access grant`）の無いアカウント、または連携の鍵。'),
          404: errorResponse(
            'その会話は無い（既に削除済みを含む。`code: conversation_not_found`）。前方一致では消さない。',
          ),
        },
      }),
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
          { conversationId: id, deletedBy: principalRefOf(c.get('principal')) },
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
          400: errorResponse(INVALID_QUERY_DESCRIPTION),
          503: errorResponse('出来事の流れが配線されていない（能力を落とさず、黙って隠さない）。'),
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
          const queue = new SseSendQueue<JournalEntry>();
          let wake: (() => void) | null = null;
          let closed = false;

          const unsubscribe = bus.subscribe((entry) => {
            // 種別の絞りより先に見る: `type=` で墓標を流さない購読でも、溜めた行は捨てる必要があるため
            if (entry.type === 'conversation_deleted') queue.retain(survivesDeletion(entry));
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
                const overflow = queue.overflow;
                if (overflow !== undefined) {
                  // 新しい種類の出来事にしない: 受け手は流れの出来事を日誌の1件として読むため。コメント行で理由を残して閉じ、受け手の張り直しと取り直しに任せる（#4617）
                  const summary =
                    `日誌の流れ（/journal/stream）の購読者が読むのに追いつかず、待ち行列が上限を超えた` +
                    `（${String(overflow.items)} 件・${String(overflow.chars)} 字。上限 ` +
                    `${String(SSE_SEND_QUEUE_MAX_ITEMS)} 件・` +
                    `${String(SSE_SEND_QUEUE_MAX_CHARS)} 字）。` +
                    '溜めた分を捨ててこの購読を切った。受け手は張り直して表示中のデータを取り直す。';
                  await stream.write(`: ${summary}\n\n`).catch(() => undefined);
                  void stores.journal
                    .append({ type: 'external_event', source: 'journal-stream', summary })
                    .catch((error: unknown) => {
                      writeStderrLine(
                        `alteroidd: 日誌の流れの購読を切ったことを日誌へ残せませんでした: ${reasonOf(error)}\n  ${summary}\n`,
                      );
                    });
                  break;
                }
                const item = queue.shift();
                if (item === undefined) {
                  await new Promise<void>((resolve) => {
                    wake = resolve;
                  });
                  wake = null;
                  continue;
                }
                await stream.writeSSE({ event: item.value.type, data: item.data });
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
          200: jsonResponse('稼働の地図。', topologyResponseSchema),
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

    .route('/', memoryRoutes(ctx))

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
          200: jsonResponse('やり方のメタ情報一覧（slug の昇順）。', practiceListResponseSchema),
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
          200: jsonResponse('やり方（本文まで）。', practiceReadResponseSchema),
          400: errorResponse('やり方のスラッグが不正。'),
          404: errorResponse('該当するやり方が無い。'),
          409: errorResponse(
            '該当する行は在るが、型に合わない形で入っていて読めない（消されたのとは区別する。' +
              'issue #2011）。' +
              'PUT /practices/:slug で書き直すか、DELETE /practices/:slug で外せる。',
          ),
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
          200: jsonResponse('書き換え後のやり方。', practiceWriteResponseSchema),
          400: errorResponse('やり方のスラッグが不正、または本文が JSON として不正。'),
          409: jsonResponse(
            '`ifMatch`（読んだ時の版）が、いまの版と違う（読んでから書くまでの間に別の書き手が' +
              '書いた、または消した）。**何も書いていない**（版の履歴にも足していない）。' +
              '`current` にいまの版を返す。',
            practiceConflictResponseSchema,
          ),
          500: journalWriteFailedResponse(
            '既に在るやり方を書き直す前の日誌が書けなかった（**書き直していない**）。' +
              '新しく置く回は日誌を後に書くので、これを返さない。',
          ),
        },
      }),
      jsonBody(practiceBody, invalidWith('やり方の本文の形が不正')),
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
        // 既に在る行（読めない形の行を含む）の書き直しだけが、日誌を先に書く対象（#5243）。新しく置く回は取り消しでも書き換えでもないので、今までどおり書いた後に残す。
        const rewriting = before !== null || beforeWasUnreadable;
        // 読んだ版が既に食い違っていれば、日誌を書く前に 409 で返す（書かないので書く跡が無い）。読めない行は版が比べられないので、store の排他の中の判定に任せる。
        if (!beforeWasUnreadable && !practiceVersionMatches(before, ifMatch)) {
          return c.json(practiceConflictBody(before, 'write'), 409);
        }
        const entryAfter: JournalEntryInput = {
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
                'GET /practices/:slug/versions の版の履歴に残る）',
          target: { kind: 'practice', slug },
          // 新しく置いた回には付けない: 取り消しでも書き換えでもなく、直しの合図として薄いため
          ...(rewriting ? humanActionOf(c.get('principal'), 'practice_write', slug) : {}),
        };
        if (rewriting) {
          // 日誌を先に書き、書けなければ書き直さずに 500（#5243）。先の行に humanAction を付けない: 印は効いた後の行（下）だけが持つ。書き直せなかった操作を、クローンに「人間がした」と学ばせないため。
          // 行を作るのは try の外: 作る側の例外を「日誌に書けなかった」と取り違えない。
          const entryBefore: JournalEntryInput = {
            type: 'decision',
            decision: beforeWasUnreadable
              ? `人間が読めない形で入っていたやり方 ${slug}（${kind}）を書き直す: ${title}`
              : `人間がやり方 ${slug}（${kind}）を書き直す: ${title}`,
            grounds: '人間が直接 API から書き直そうとしている',
          };
          try {
            await stores.journal.append(entryBefore);
          } catch (error) {
            noteDroppedRecord(
              'やり方書き直しの日誌（書き直していない）',
              `slug=${slug}`,
              kindOfError(error),
            );
            return c.json(journalWriteFailedBody(), 500);
          }
        }
        let practice: Practice;
        try {
          practice = await stores.practices.write({ slug, kind, title, content }, { ifMatch });
        } catch (error) {
          if (rewriting) {
            await humanRetractor(stores, {
              operation: 'やり方を書き直す',
              subject: `やり方 ${slug} の書き直し`,
              what: 'やり方書き直しの打ち消しの日誌',
              detail: `slug=${slug}`,
            })(
              error instanceof PracticeConflictError
                ? '書き直す直前にやり方が変わっていた（見た版と違う）'
                : 'やり方の書き込みが失敗した',
            );
          }
          // 黙って上書きしない: 書いていない。
          if (error instanceof PracticeConflictError) {
            return c.json(practiceConflictBody(error.current, 'write'), 409);
          }
          throw error;
        }
        // 書き換え自体は効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`）。
        await appendJournalOrDrop(stores, entryAfter, 'やり方書き換えの日誌', `slug=${slug}`);
        // 読めない形の行の書き直しは置換（`rewriting`）: 新規ではない。
        return c.json({ practice, version: practiceVersion(practice), created: !rewriting });
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
          200: jsonResponse('消した。', practiceDeleteResponseSchema),
          409: jsonResponse(
            '`ifMatch`（読んだ時の版）が、いまの版と違う（読んでから消すまでの間に別の書き手が' +
              '書いた）。**何も消していない。** `current` にいまの版を返す。',
            practiceConflictResponseSchema,
          ),
          428: jsonResponse(
            '`ifMatch`（読んだ時の版）が無い。**何も消していない。** `current` にいまの版を返す' +
              '（409 と同じ形）。読めない形で入っている行は、版なしで消せるのでこれを返さない。',
            practiceConflictResponseSchema,
          ),
          400: errorResponse('やり方のスラッグが名前として成立しない（「無い」とは区別する）。'),
          404: errorResponse('該当するやり方が無い。'),
          500: journalWriteFailedResponse('消す前の日誌が書けなかった（**消していない**）。'),
        },
      }),
      queryParams(ifMatchDeleteQuery),
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
              current: practiceCurrent(existing),
            },
            428,
          );
        }
        // 読んだ版が既に食い違っていれば、日誌を書く前に 409 で返す（消さないので書く跡が無い）。
        if (existing !== null && !practiceVersionMatches(existing, ifMatch)) {
          return c.json(practiceConflictBody(existing, 'remove'), 409);
        }
        // 行を作るのは try の外: 作る側の例外を「日誌に書けなかった」と取り違えない。
        const entryBefore: JournalEntryInput = {
          type: 'decision',
          decision:
            existing !== null
              ? `人間がやり方 ${slug}（${existing.kind}）を消す: ${existing.title}`
              : `人間が読めない形で入っていたやり方 ${slug} を消す`,
          grounds: '人間が直接 API から消そうとしている',
        };
        const entryAfter: JournalEntryInput =
          existing !== null
            ? {
                type: 'decision',
                decision: `やり方 ${slug}（${existing.kind}）を消した: ${existing.title}`,
                grounds: '人間が直接 API からやり方を消した',
                target: { kind: 'practice', slug },
                ...humanActionOf(c.get('principal'), 'practice_remove', slug),
              }
            : {
                type: 'decision',
                decision: `読めない形で入っていたやり方 ${slug} を消した`,
                grounds: '人間が直接 API から、読めない形で入っていたやり方を消した',
                target: { kind: 'practice', slug },
                ...humanActionOf(c.get('principal'), 'practice_remove', slug),
              };
        // 日誌を先に書き、書けなければ消さずに 500（#5243）: 消すと題と本文が行から消えるので、後に書いて握ると何を消したかが残らない。先の行に humanAction を付けない（印は効いた後の行だけが持つ）。
        try {
          await stores.journal.append(entryBefore);
        } catch (error) {
          noteDroppedRecord('やり方削除の日誌（消していない）', `slug=${slug}`, kindOfError(error));
          return c.json(journalWriteFailedBody(), 500);
        }
        try {
          await stores.practices.remove(slug, ifMatch === undefined ? undefined : { ifMatch });
        } catch (error) {
          await humanRetractor(stores, {
            operation: 'やり方を消す',
            subject: `やり方 ${slug} の削除`,
            what: 'やり方削除の打ち消しの日誌',
            detail: `slug=${slug}`,
          })(
            error instanceof PracticeConflictError
              ? '消す直前にやり方が変わっていた（見た版と違う）'
              : 'やり方の削除が失敗した',
          );
          // 黙って消さない。
          if (error instanceof PracticeConflictError) {
            return c.json(practiceConflictBody(error.current, 'remove'), 409);
          }
          throw error;
        }
        // 削除自体は効いているので、日誌への追記だけが落ちても 500 を返さない（`appendJournalOrDrop`）。
        await appendJournalOrDrop(stores, entryAfter, 'やり方削除の日誌', `slug=${slug}`);
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
          200: jsonResponse(
            '版のメタ情報一覧（版番号の昇順）。無い slug には空配列を返す。',
            practiceVersionListResponseSchema,
          ),
          400: errorResponse('やり方のスラッグが不正。'),
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
          200: jsonResponse('版（本文まで）。', practiceVersionReadResponseSchema),
          400: errorResponse('やり方のスラッグが不正、または版番号が正の整数として成立しない。'),
          404: errorResponse('該当する版が無い。'),
          409: errorResponse(
            '該当する版は在るが、型に合わない形で入っていて読めない（消されたのとは区別する。' +
              'issue #2177）。この版を書き直す口は無い——本文はここでは取れない。',
          ),
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
          '`type` はカンマ区切りで複数を渡せ、**知らない値は 400**（綴り違いを黙って0件にしない。' +
          '使える値は 400 の `error` に載る）。' +
          '**`with`（exchange の相手での絞り込み）はこの口に無い** —— 渡しても無視されて絞られない' +
          '（未知のキーは拒まない）。相手で絞るには `journal_read` の `with` を使う。' +
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
          200: jsonResponse(
            '日誌エントリの一覧。`since`/`until` のどちらかを指定した呼び、' +
              'または `horizon=true` を渡した呼びには `oldestAt`/`crossesHorizon` ' +
              'が付く（どちらも渡さない呼びには付かない）。' +
              '`next` は次の頁の継続点（`afterId` / `afterAt` へそのまま渡せる）で、' +
              '`null` のときだけ本当の終端。`entries` が `limit` 未満でも空でも、' +
              '`null` でなければ先に行が在る（読めない行は `limit` の後で捨てられる）。',
            journalListResponseSchema,
          ),
          400: errorResponse(
            'クエリが不正、`type` に知らない値が入っている、または `since` / `until` が日時として読めない・' +
              '`afterId` / `afterAt` の片方だけが渡された・' +
              '`afterAt` の形式が不正、または `afterId`/`afterAt` が指す行が見当たらない。',
          ),
        },
      }),
      queryParams(journalQuery),
      async (c) => {
        const { limit, since, until, type, q, order, afterId, afterAt, horizon } =
          c.req.valid('query');
        const requestedTypes = type?.split(',').filter((value) => value.length > 0);
        const unknownTypes = (requestedTypes ?? []).filter(
          (value) => !(JOURNAL_ENTRY_TYPES as readonly string[]).includes(value),
        );
        if (unknownTypes.length > 0) {
          return c.json(
            {
              error:
                `type に知らない値が入っている: ${unknownTypes.join(', ')}` +
                `（使えるのは ${JOURNAL_ENTRY_TYPES.join(' / ')}。カンマ区切りで複数）`,
            },
            400,
          );
        }
        const types = requestedTypes as JournalEntryType[] | undefined;

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
          200: jsonResponse('日誌エントリ1件。', journalEntrySchema),
          404: errorResponse('該当する日誌が無い。'),
          409: errorResponse(
            '日誌の行は在るが読めない形で入っている（版ずれ・手編集）。消されたのではない。',
          ),
        },
      }),
      async (c) => {
        const read = await readJournalEntry(stores, c.req.param('id'));
        if (read.kind === 'unreadable') return c.json({ error: read.message }, 409);
        const entry = read.value;
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
          '`from` / `to` などの絞り込みには影響されない（全期間で判定する）。' +
          '`resets` は累積の数え直し（resume / `/clear` などで SDK 側の累積が 0 から始まったとみなした回数）を、' +
          '層 × マネージャーの基準ごとに返す（`resets` は回数、`lastResetAt` は最後の時刻で、0 回なら無い）。' +
          '基準が1件も無いときは欄ごと無い。**日付に依らない現在値**で、`from` / `to` / `site` / `tokenId` では絞らず、' +
          '`layer` / `managerId` だけで絞る。判定は推定で、誤って数え直しとみなす・拾えない、のどちらもありうる' +
          '（回数が増え続けていないかを見張る口）。',
        responses: {
          200: jsonResponse('台帳の集計。', usageResponseSchema),
          400: errorResponse(INVALID_QUERY_DESCRIPTION),
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
          today: usageDate(clock()),
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
          200: jsonResponse('日報の一覧（日付の新しい順）。', reportsResponseSchema),
          400: errorResponse(
            'クエリが不正、または `beforeDate` / `beforeAt` の片方だけが渡された・形式が不正。',
          ),
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
          200: jsonResponse('その日の日報。', reportsResponseSchema),
          400: errorResponse('日付が `YYYY-MM-DD` 形式ではない（黙って別の日にずらさない）。'),
          404: errorResponse('その日の日報が無い。'),
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

    .route('/', approvalsRoutes(ctx, deps))

    .route('/', integrationRoutes(ctx, humanOnly, noteIntegrationRefusal))

    .route('/', scheduleRoutes(ctx, deps))

    .route('/', tasksRoutes(ctx))

    .route('/', managersRoutes(ctx, deps))

    .route('/', profileRoutes(deps))

    .route('/', pluginsRoutes(deps, pluginPreviews))

    .route('/', credentialsRoutes(deps))

    .route('/', tokensRoutes(deps))

    .route('/', workspaceRoutes(ctx))

    .route('/', authRoutes(ctx))

    .route('/', adminRoutes(ctx, deps));

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
