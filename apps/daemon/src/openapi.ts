import {
  accountUsageStateSchema,
  attachmentRefSchema,
  clientMessageIdSchema,
  agentTokenInputSchema,
  agentTokenViewSchema,
  APPROVAL_TRACE_STATES,
  commitmentSchema,
  createMemoryStores,
  INBOX_EVENT_TYPE_ORDER,
  integrationSourceSchema,
  jobSchema,
  jobStatusSchema,
  nonBlankString,
  stripNul,
  turnFailureKindSchema,
  githubObservationInputSchema,
  journalEntrySchema,
  memoryDocumentMetaSchema,
  mcpServersSchema,
  memoryDocumentSchema,
  pendingApprovalSchema,
  permissionGrantSchema,
  pluginNameSchema,
  pluginRelativePathSchema,
  pluginRepoUrlSchema,
  pluginScopeSchema,
  pluginSourceShaSchema,
  practiceMetaSchema,
  practiceSchema,
  practiceVersionMetaSchema,
  practiceVersionSchema,
  PROGRESS_FORECAST_METHOD,
  runnerCredentialFingerprintSchema,
  runnerCredentialSchema,
  runnerLivenessSchema,
  runnerMcpServersFingerprintSchema,
  runnerProfileFingerprintSchema,
  scheduledRequestSchema,
  scheduleSpecSchema,
  tokenRotationPolicySchema,
  tokenRotationSettingsSchema,
  unreadableApprovalSchema,
  unreadableCommitmentSchema,
  unreadableInboxEventSchema,
  unreadableJobSchema,
  unreadablePracticeSchema,
  unreadableScheduleSchema,
  unreadableTokenSchema,
  usageAggregateSchema,
  usageBreakdownSchema,
  usageDateSchema,
  waitingKindSchema,
  workspaceLocatorSchema,
  type CloneHost,
  type JournalEntry,
  type ManagerPool,
} from '@alteroid/core';
import type { GenerateSpecOptions } from 'hono-openapi';
import { z } from 'zod';

import { createApp } from './app.js';

// core が zod スキーマを持つものはここで再定義しない: 実装とドキュメントのスキーマが2つに分かれ、いつかずれて spec が嘘になるため。
// 例外は成功応答を `.parse()` へ通す面（規則は `app.ts`）の外向き view（`accountViewSchema`）: ずれても宣言していないものが載らないだけになる。parse を外すなら view も捨てて core のスキーマへ戻す。
// 宣言していない欄は `.parse()` で黙って落ちる: 足し忘れると CLI と Web が同時に盲目になる。

export const errorResponseSchema = z.object({ error: z.string() });

export const attachmentMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  conversationId: z.string().optional(),
  externalEventId: z.string().optional(),
  managerReportId: z.string().optional(),
  uploadedBy: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  keptAt: z.string().optional(),
  releasedAt: z.string().optional(),
});

export const attachmentFromSchema = z.enum(['human', 'clone', 'manager', 'integration', 'unknown']);

const attachmentUsageBucketSchema = z.object({
  count: z.number().int(),
  totalBytes: z.number().int(),
});

export const attachmentUsageSchema = attachmentUsageBucketSchema.extend({
  byFrom: z.object({
    human: attachmentUsageBucketSchema,
    clone: attachmentUsageBucketSchema,
    manager: attachmentUsageBucketSchema,
    integration: attachmentUsageBucketSchema,
    unknown: attachmentUsageBucketSchema,
  }),
});

export const attachmentListQuery = z.object({
  kept: z
    .enum(['1', 'true', '0', 'false'])
    .transform((value) => value === '1' || value === 'true')
    .optional(),
  from: attachmentFromSchema.optional(),
  conversationId: z.string().min(1).optional(),
  q: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const attachmentListResponseSchema = z.object({
  items: z.array(attachmentMetaSchema),
  nextCursor: z.string().optional(),
  usage: attachmentUsageSchema,
});

export const attachmentKeptBodySchema = z.object({ kept: z.boolean() });

export const attachmentLimitsSchema = z.object({
  maxImageBytes: z.number().int(),
  maxFileBytes: z.number().int(),
  maxLargeFileBytes: z.number().int(),
  maxPerMessage: z.number().int(),
  maxTotalBytes: z.number().int(),
  retentionDays: z.number().int(),
});

export const attachmentErrorResponseSchema = z.object({
  error: z.string(),
  code: z
    .enum([
      'too_large',
      'image_dimension_too_large',
      'magic_mismatch',
      'too_many',
      'total_too_large',
      'media_type_missing',
      'empty',
      'attachment_missing',
      'attachment_conflict',
      'attachment_forbidden',
      'reserved_source',
      'invalid_source',
    ])
    .optional(),
});

export const integrationKeyCreateErrorResponseSchema = z.object({
  error: z.string(),
  code: z.literal('reserved_source').optional(),
});

// 例外の本文は載せない: トークンの値が載りうるため。
export const JOURNAL_WRITE_FAILED_CODE = 'journal_write_failed';
export const JOURNAL_WRITE_FAILED_MESSAGE = '記録（日誌）が書けなかったので、変更していません';
export const journalWriteFailedResponseSchema = z.object({
  error: z.string(),
  code: z.literal(JOURNAL_WRITE_FAILED_CODE),
});

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  pid: z.number().int(),
  // トークンそのものは返さない: `access grant` を実行できる資格になるため、無認証で読める応答に置けない。
  operator: z.boolean(),
  auth: z.object({
    enabled: z.boolean(),
    providers: z.array(z.object({ id: z.string(), label: z.string(), kind: z.string() })),
  }),
});

export const statusResponseSchema = z.object({
  // 接続情報（パスワード等）は含めない。
  storage: z.string(),
  cloneSessionRefusal: z
    .object({
      streak: z.number().int().nonnegative(),
      category: z.string().nullable(),
      since: z.string().nullable(),
      sessionId: z.string().nullable(),
      autoReopen: z.enum(['enabled', 'disabled', 'halted']),
    })
    .optional(),
});

const isoDateTimeSchema = z.string().datetime({ offset: true });

// core の永続化スキーマ（`authAccountSchema`）をそのまま使わない: あちらは保存の形で、外へ出す形とは別物のため。保存側にフィールドが1つ増えた日に宣言ごと広がる。
const accountViewSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  lastLoginAt: isoDateTimeSchema.nullable(),
  grantedAt: isoDateTimeSchema.nullable(),
  grantedBy: z.string().nullable(),
  ownerDeclaredAt: isoDateTimeSchema.nullable(),
});

export const authProvidersResponseSchema = z.object({
  enabled: z.boolean(),
  providers: z.array(z.object({ id: z.string(), label: z.string(), kind: z.string() })),
});

export const loginStartResponseSchema = z.object({
  requestId: z.string(),
  authorizationUrl: z.string(),
  claimSecret: z.string(),
  expiresAt: z.string(),
});

export const loginClaimResponseSchema = z.union([
  z.object({ status: z.literal('pending') }),
  z.object({
    status: z.literal('ready'),
    token: z.string(),
    account: accountViewSchema,
    granted: z.boolean(),
  }),
]);

export const meResponseSchema = z.union([
  z.object({ kind: z.literal('operator') }),
  z.object({ kind: z.literal('account'), account: accountViewSchema, granted: z.boolean() }),
]);

export const accountWithIdentitiesSchema = accountViewSchema.extend({
  granted: z.boolean(),
  identities: z.array(
    z.object({
      provider: z.string(),
      subject: z.string(),
      email: z.string().nullable(),
      emailVerified: z.boolean(),
      lastLoginAt: z.string(),
    }),
  ),
});

// 1件でも在るときだけ鍵ごと載せる: `{ count: 0 }` や空配列を作ると「読めない行は無い」と読めてしまうため。行の中身は載せない（id と不正な欄名だけ）。
export const rowsUnreadableSchema = z.object({
  count: z.number().int().positive(),
  rows: z.array(z.object({ id: z.string(), reason: z.string() })),
});

export const accessListResponseSchema = z.object({
  accounts: z.array(accountWithIdentitiesSchema),
  rowsUnreadable: rowsUnreadableSchema.optional(),
});

export const accessAccountResponseSchema = z.object({ account: accountWithIdentitiesSchema });

// 値（`altk_...`）も sha256 の全体も返さない: 見分けるための先頭12桁だけ。
export const integrationKeyViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  fingerprint: z.string(),
  createdAt: isoDateTimeSchema,
  createdBy: z.string(),
  expiresAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  lastUsedAt: isoDateTimeSchema.nullable(),
  limits: z.object({
    maxBodyBytes: z.number().int().positive(),
    ratePerMinute: z.number().int().positive(),
  }),
});

export const integrationKeysListResponseSchema = z.object({
  keys: z.array(integrationKeyViewSchema),
  rowsUnreadable: rowsUnreadableSchema.optional(),
});

// `scopes` のような選べる許可の一覧は無い: 鍵の種類そのものが「固定の1 source で外部イベントを送る」という1つの能力だけを表すため。
export const integrationKeyCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  source: integrationSourceSchema,
  expiresAt: isoDateTimeSchema.optional(),
  maxBodyBytes: z.number().int().positive().max(2_147_483_647).optional(),
  ratePerMinute: z.number().int().positive().max(2_147_483_647).optional(),
});

export const integrationKeyCreateResponseSchema = z.object({
  key: integrationKeyViewSchema,
  // 鍵の値はこの応答でだけ返す: 保存は sha256 だけで、後からは取り出せない。
  value: z.string(),
});

export const integrationKeyResponseSchema = z.object({ key: integrationKeyViewSchema });

const conversationSchema = z.object({
  conversationId: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
  messages: z.number().int(),
  preview: z.string(),
  unreadCount: z.number().int(),
  readThrough: isoDateTimeSchema.nullable(),
});

// 既読の記録が読めないときは全件を未読として数える: 知らせ損ねるほうが取り返しがつかないため。
const readStateUnreadableSchema = z.string().optional();

export const conversationDeleteResponseSchema = z.object({
  conversationId: z.string(),
  tombstoneId: z.string(),
  deletedAt: z.string(),
  hiddenCount: z.number().int(),
  attachmentsRemoved: z.number().int(),
  commitmentsRemoved: z.number().int(),
  queuedDropped: z.number().int(),
  approvalsLinked: z.number().int(),
  incomplete: z.array(z.string()),
  remainsIn: z.array(z.string()),
});

export const conversationsResponseSchema = z.object({
  conversations: z.array(conversationSchema),
  scanned: z.number().int(),
  // `GET /conversations/:id` と同じ意味・同じ名前で揃える（`@alteroid/core` の `reachedStart`）。
  reachedStart: z.boolean(),
  hiddenByLimit: z.number().int(),
  // `/approvals` / `/commitments` の `nextCursor` と同じ名前・同じ形（無ければ鍵ごと無い）。
  nextCursor: z.string().optional(),
  readStateUnreadable: readStateUnreadableSchema,
});

const conversationMessageSchema = z.object({
  id: z.string(),
  at: z.string(),
  role: z.enum(['inbound', 'outbound']),
  text: z.string(),
  // 走っている・順番待ちの状態は `GET /chat/:id/stream` の `open.pending` が持つので、ここには足さない: 二重の正本を作らない。
  delivery: z.enum(['withdrawn']).optional(),
  supersedes: z.string().optional(),
  supersededBy: z.string().optional(),
  turnFailure: z.enum(['failed', 'held']).optional(),
  turnFailureKind: turnFailureKindSchema.optional(),
  attachments: z.array(attachmentRefSchema).optional(),
  clientMessageId: z.string().optional(),
});

export const conversationDetailResponseSchema = z.object({
  conversationId: z.string(),
  messages: z.array(conversationMessageSchema),
  scanned: z.number().int(),
  // 「無い」と「判定できない」を2値へ潰さない: 潰すと、判定できない場合が黙ってどちらかへ倒れるため。
  reachedStart: z.boolean(),
  supersededCount: z.number().int(),
  readThrough: isoDateTimeSchema.nullable(),
  unreadCount: z.number().int(),
  readStateUnreadable: readStateUnreadableSchema,
});

// `through` は時刻ではなく発言の id: クライアントが時刻を渡せると、まだ見ていない分まで既読にできてしまうため。
export const conversationReadRequestSchema = z.object({
  through: z.string().min(1),
});

export const unreadConversationCountResponseSchema = z.object({
  count: z.number().int(),
  capped: z.boolean(),
  readStateUnreadable: readStateUnreadableSchema,
});

export const conversationReadResponseSchema = z.object({
  conversationId: z.string(),
  readThrough: isoDateTimeSchema.nullable(),
  unreadCount: z.number().int(),
  readStateUnreadable: readStateUnreadableSchema,
});

export const memoryListResponseSchema = z.object({ documents: z.array(memoryDocumentMetaSchema) });
export const memoryReadResponseSchema = z.object({
  document: memoryDocumentSchema,
  version: z.string(),
});
export const memoryConflictResponseSchema = z.object({
  error: z.string(),
  current: memoryReadResponseSchema.nullable(),
});
export const memoryDeleteResponseSchema = z.object({
  ok: z.literal(true),
  slug: z.string(),
});

// `apply` / `enforce` に当たる口を作らない: PracticeStore が持つのは「こう書いてある」までで、「こう実行せよ」ではないため。
export const practiceListResponseSchema = z.object({
  practices: z.array(practiceMetaSchema),
  // 1件でも在るときだけ載せる: 空配列を作ると「読めない行は無い」と読めてしまうため。
  unreadable: z.array(unreadablePracticeSchema).optional(),
});
export const practiceReadResponseSchema = z.object({
  practice: practiceSchema,
  version: z.string(),
});
export const practiceConflictResponseSchema = z.object({
  error: z.string(),
  current: practiceReadResponseSchema.nullable(),
});
export const practiceDeleteResponseSchema = z.object({
  ok: z.literal(true),
  slug: z.string(),
});

export const practiceVersionListResponseSchema = z.object({
  versions: z.array(practiceVersionMetaSchema),
});
export const practiceVersionReadResponseSchema = z.object({ version: practiceVersionSchema });

export const journalNextSchema = z.object({ id: z.string(), at: isoDateTimeSchema }).nullable();

export const journalListResponseSchema = z.object({
  entries: z.array(journalEntrySchema),
  next: journalNextSchema.optional(),
  // `oldestAt` / `crossesHorizon` は `since` / `until` / `horizon=true` のいずれかを渡した呼びにだけ載る: どれも渡さない既存の呼びの応答を変えないため。
  oldestAt: isoDateTimeSchema.nullable().optional(),
  crossesHorizon: z.boolean().optional(),
});

// 再定義せず union から取り出す: 手で書き直すと、schema.ts に日報の項目が増えたときここだけ古いままになるため。
function journalVariant(type: JournalEntry['type']) {
  const found = journalEntrySchema.options.find((option) => option.shape.type.value === type);
  if (found === undefined) {
    throw new Error(`journal エントリ種別 "${type}" が見つからない（schema.ts の変更を確認）`);
  }
  return found;
}

const dailyReportEntrySchema = journalVariant('daily_report');

export const reportsResponseSchema = z.object({ reports: z.array(dailyReportEntrySchema) });

// `updatedAt` は core の `approvalUpdatedAt` で導く: 受け手に `answeredAt ?? createdAt` を書き直させないため。
export const approvalsResponseSchema = z.object({
  approvals: z.array(pendingApprovalSchema.extend({ updatedAt: isoDateTimeSchema })),
  // 1件でも在るときだけ載せる: 空配列を作ると「読めない行は無い」と読めてしまうため。
  unreadable: z.array(unreadableApprovalSchema).optional(),
  // `total` / `nextCursor` は `order` / `limit` / `cursor` のいずれかを渡したときだけ載る（既定の呼びでは鍵ごと無い）: 既存の呼び手（画面・CLI）の応答を変えないため。
  total: z.number().int().optional(),
  nextCursor: z.string().optional(),
});

export const approvalsAnsweredDatesResponseSchema = z.object({
  dates: z.array(z.object({ date: z.string(), count: z.number().int().positive() })),
});

export const approvalByIdResponseSchema = z.object({
  approval: pendingApprovalSchema.extend({ updatedAt: isoDateTimeSchema }),
  settledOn: z.string().nullable(),
});

export const approvalsAnswerResponseSchema = z.object({
  results: z.array(z.object({ id: z.string(), ok: z.boolean(), error: z.string().optional() })),
});

export const approvalTraceResponseSchema = z.object({
  approval: pendingApprovalSchema,
  state: z.enum(APPROVAL_TRACE_STATES),
  questionEntry: journalEntrySchema.nullable(),
  answerEntry: journalEntrySchema.nullable(),
  turnStarts: z.array(journalEntrySchema),
  actions: z.array(journalEntrySchema),
  actionsOmitted: z.number().int().nonnegative(),
  unstampedInTurn: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const okResponseSchema = z.object({ ok: z.literal(true) });

export const clientMessageLookupResponseSchema = z.object({ conversationId: z.string() });

// `conversationId` と `clientMessageId` は2つとも省くか、2つとも渡す（片方だけは 400）。
export const cloneInterruptRequestSchema = z.object({
  conversationId: z.string().min(1).optional(),
  clientMessageId: clientMessageIdSchema.optional(),
});

export const cloneInterruptResponseSchema = z.object({
  outcome: z.enum(['interrupted', 'withdrawn', 'not_target', 'starting', 'idle', 'unsupported']),
});

export const cloneSessionReopenRequestSchema = z.object({
  confirm: z.literal(true),
  distill: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export const cloneSessionReopenResponseSchema = z.object({
  outcome: z.enum(['now', 'deferred', 'unsupported']),
  previousSessionId: z.string().nullable().optional(),
  runningManagers: z.number().int().nonnegative().optional(),
});

export const permissionGrantsResponseSchema = z.object({
  grants: z.array(permissionGrantSchema),
  rowsUnreadable: rowsUnreadableSchema.optional(),
});

export const unreadableRowsRemoveRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const unreadableRowsRemoveResponseSchema = z.object({
  removedIds: z.array(z.string()),
  count: z.number().int().positive(),
});

export const eventAcceptedResponseSchema = z.object({ ok: z.literal(true), id: z.string() });

// `POST /events` の応答。`duplicate` は重複キーで積まなかったときだけ付く（付かなければ今までの応答と同じ）。
export const eventPostAcceptedResponseSchema = eventAcceptedResponseSchema.extend({
  duplicate: z.literal(true).optional(),
});

export const scheduleStatusSchema = z.object({
  kind: z.string(),
  description: z.string(),
  nextAt: z.string(),
  // `request` / `spec` / `createdAt` は仕込まれたものだけが持つ: 既定の日報・発意はコードに書かれた既定で、「分からない」ではなく「無い」のため（`unknown` を入れない）。
  request: z.string().optional(),
  spec: scheduleSpecSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  lastRunAt: z.string().optional(),
});

// 既定の定期ジョブの名前での 409（`{ error }` だけ）とは、`current` の鍵の有無で見分ける。
export const scheduleConflictResponseSchema = z.object({
  error: z.string(),
  current: scheduledRequestSchema.nullable(),
});

export const scheduleListResponseSchema = z.object({
  entries: z.array(scheduleStatusSchema),
  // 1件でも在るときだけ載せる: 空配列を作ると「読めない行は無い」と読めてしまうため。
  unreadable: z.array(unreadableScheduleSchema).optional(),
});

// 片付き済み・読めない行の 409（`{ error }` だけ）とは、`current` の鍵の有無で見分ける。
export const commitmentConflictResponseSchema = z.object({
  error: z.string(),
  current: commitmentSchema.nullable(),
});

// 外向きの view を別に書かない: 伏せるものが無く、別 view にすると人間が API で見る台帳とクローンが `commitment_list` で見る台帳がずれるため。
// `updatedAt` は `commitmentUpdatedAt` で導く: 受け手に `closedAt ?? at` を書き直させないため。
export const commitmentListResponseSchema = z.object({
  entries: z.array(
    commitmentSchema.extend({
      updatedAt: isoDateTimeSchema,
      respondedAt: isoDateTimeSchema.optional(),
      activeManagerIds: z.array(z.string()).optional(),
    }),
  ),
  // 窓（`limit`/`cursor`）では切らず、常に全件を返す。
  unreadable: z.array(unreadableCommitmentSchema),
  trimmedClosed: z.number().int().nonnegative(),
  // 読めない委譲がどの台帳の行に紐づくかは、行が壊れているので言えない: だから行へは紐づけない。1件でも在るときだけ載る。
  unreadableJobs: z.array(unreadableJobSchema).optional(),
  // `total` / `nextCursor` は `limit` / `cursor` のいずれかを渡したときだけ載る（既定の呼びでは鍵ごと無い）: 既存の呼び手（画面・CLI・クローンの `commitment_list`）の応答を変えないため。
  total: z.number().int().optional(),
  nextCursor: z.string().optional(),
});

// 返さないと閉じられない: 閉じる口は id を取るので、返さないと人間は積めるが自分で閉じられない片道の口になる。
export const commitmentOpenedResponseSchema = z.object({ ok: z.literal(true), id: z.string() });

const managerWaitingSchema = z.object({
  requestId: z.string(),
  summary: z.string(),
  // `kind` / `askedAt` は `.optional()`: 版のずれで旧 runner の応答に乗らない窓があり、ここで既定値を作ると経路によって値の意味が変わるため。
  kind: waitingKindSchema.optional(),
  askedAt: isoDateTimeSchema.optional(),
});

const managerDenialSchema = z.object({
  tool: z.string(),
  // `.int()` だけでは `minimum: -9007199254740991` を吐き、負でもありうると宣言してしまう。
  count: z.number().int().nonnegative(),
  // `.optional()` は「層が取れなかった」という第3の状態のために使う: 既定値（'manager' 等）を持たせない。
  actor: z.enum(['manager', 'worker']).optional(),
  lastAt: z.string().optional(),
  // `reasonType` / `reason` / `message` / `inputHead` は意図して宣言しない: `.parse()` が落とし、人間向けの HTTP・CLI・Web へ露出を広げないため（クローン向けの `manager_list` / `manager_report` にだけ出す）。
});

export const managerSummarySchema = z.object({
  managerId: z.string(),
  status: jobStatusSchema,
  // `live: false` を「送っても届かない」と読み替えない: 器が黙った側でも `ManagerPool.send()` が届いた実測がある。逆に「送れば届く」でもない。
  live: z.boolean(),
  runnerLostSince: z.string().optional(),
  sessionMissingSince: z.string().optional(),
  // `resume-failed` と `unlisted` は1つに畳まない: 読み手の次の一手が違うため。
  sessionMissingKind: z.enum(['resume-failed', 'unlisted']).optional(),
  shutdownObservationArrivedAfterSwap: z.boolean().optional(),
  turnEndedAt: z.string().optional(),
  turnEndReason: z.string().optional(),
  turnEndTail: z.string().optional(),
  toolUseStallAt: z.string().optional(),
  toolUseStallPending: z
    .array(z.object({ id: z.string(), name: z.string().optional() }))
    .optional(),
  cwd: z.string(),
  cwdConfirmed: z.literal(true).optional(),
  requestedCwd: z.string().optional(),
  request: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
  sessionId: z.string().optional(),
  lastReport: z.string().optional(),
  lastReportAt: z.string().optional(),
  // `jobSchema` の枝は書き直さず借りる（以下の `jobSchema.shape.*` も同じ）: 欄が片方だけ増えた日に spec が黙って古びるため。
  lastReportStatus: jobSchema.shape.lastReportStatus,
  // 失敗した回だけ載る（`optional`）: 空の値を載せると「失敗していない」と「この器では見ていない」が同じ形になる。`status` は置き換えない（支出上限に当たった回もセッションは生きており `done` のまま）。
  lastFailure: jobSchema.shape.lastFailure,
  lastUnreported: jobSchema.shape.lastUnreported,
  lastFoldedTurn: jobSchema.shape.lastFoldedTurn,
  lastSystemError: jobSchema.shape.lastSystemError,
  lastCgroupEvents: jobSchema.shape.lastCgroupEvents,
  usageStoppedAt: jobSchema.shape.usageStoppedAt,
  runnerVanished: z.literal(true).optional(),
  runnerListedAt: isoDateTimeSchema.optional(),
  runnerId: z.string().optional(),
  workspace: workspaceLocatorSchema.optional(),
  // 引き取ってよいかの判定は載せない: 答えは時刻で変わり、応答に焼くと読んだ瞬間から古びるため。
  lease: jobSchema.shape.lease,
  // 握り潰しが在るときだけ載る（`optional`）: 常に載せると「待っていない」と「この器では観測していない」が同じ形になる。`status` は `done` のままで置き換えない。
  awaitingBackground: z
    .object({
      tasks: z.number(),
      withheldReports: z.number(),
      breakdown: z.string(),
      since: z.string(),
    })
    .optional(),
  tokenGeneration: z.number().int().nonnegative().optional(),
  activeTokenGeneration: z.number().int().nonnegative().optional(),
  // `tokenGeneration` が定義されているときは欄ごと消える（CLI がこの不変条件に依存する）。
  tokenGenerationUnknownReason: z
    .enum(['pool-not-wired', 'not-yet-observed', 'reattached-across-restart'])
    .optional(),
  liveBackgroundTasks: z.number().int().nonnegative().optional(),
  // `jobSchema` の枝を借りない: 台帳（`Job`）には無い、プロセス内の `#resetTimeSkewMatches` を材料にした計算値のため。
  resetTimeSkewMatch: z.enum(['active', 'stale']).optional(),
  lastUnpushedWorkObservation: jobSchema.shape.lastUnpushedWorkObservation,
  lastRescue: jobSchema.shape.lastRescue,
  waiting: z.array(managerWaitingSchema),
  // 拒否を観測したときだけ載せる: 常に `[]` を載せると「数えていない」と「0件だった」が同じ形になる。
  denials: z.array(managerDenialSchema).optional(),
  // 既定の帯（`opus`）で埋めない: 欄が無いことは「不明」のため。
  managerModel: z.string().optional(),
  workerModel: z.string().optional(),
});

export const managersListResponseSchema = z.object({
  managers: z.array(managerSummarySchema),
  // 1件でも在るときだけ載せる: 空配列を作ると「読めない行は無い」と読めてしまうため。行の状態が取れないので、`status` の絞り・`limit`・錨の窓では切らず常に全件を返す。
  unreadable: z.array(unreadableJobSchema).optional(),
});

export const managerDetailResponseSchema = z.object({ manager: managerSummarySchema });

// `managerSummarySchema` を再利用しない: あちらは `ManagerSummary` を丸ごと写す形で、ここに要るのは判定に使った3フィールドだけのため。
export const unrecordedManagerSchema = z.object({
  managerId: z.string(),
  status: jobStatusSchema,
  startedAt: z.string(),
});

// `app.ts` では組まない: `app.ts` とこのファイルは循環 import で、`app.ts` の最上位で `unrecordedManagerSchema` を使って `.extend()` すると評価順次第で未定義のまま `z.array()` へ渡り、zod が例外を投げることがあるため。
export const usageResponseSchema = usageAggregateSchema.extend({
  breakdown: usageBreakdownSchema,
  // 台帳と足さない: こちらは claude.ai 側が言っている値で、台帳は自分で数えた推定値のため。
  account: accountUsageStateSchema,
  // `from` / `to` などの絞り込みに影響されない（全期間を突き合わせる）: 変わると、照会範囲の外の委譲が「記録が無い」に化けるため。
  unrecordedManagers: z.array(unrecordedManagerSchema),
  today: usageDateSchema,
});

export const managerActionResponseSchema = z.object({
  // `session_missing` を 404 にしない: 委譲は台帳に在り、`sessionId` が残っていれば resume で入り直せるため。404 は「そんなものは無い」としてしか読まれない。
  outcome: z.enum([
    'answered',
    'delivered',
    'stopped',
    'not_stopped',
    'session_missing',
    'declined',
    'unknown',
  ]),
  detail: z.string(),
});

// `unknown` と `unheard` を1つに畳まない: 前者は runner の設定、後者はネットワーク・登録を疑う材料で、対処が違う。`state` からも導出できない（`lost` でも直前に聞いた版が残りうる）。
const runnerRevisionKnownSchema = z.object({
  status: z.literal('known'),
  commit: z.string(),
  short: z.string(),
  source: z.enum(['build', 'workspace', 'env', 'platform']),
});
const runnerRevisionUnknownSchema = z.object({ status: z.literal('unknown') });
const runnerRevisionStatusSchema = z.discriminatedUnion('status', [
  runnerRevisionKnownSchema,
  runnerRevisionUnknownSchema,
  z.object({ status: z.literal('unheard') }),
]);

const daemonRevisionSchema = z.discriminatedUnion('status', [
  runnerRevisionKnownSchema,
  runnerRevisionUnknownSchema,
]);

// 「空」と「聞けなかった」を分ける。`state` から導出しない: `RunnerRegistry#list()` が並べる状態という実装の都合に依存するため。`RunnerRevisionStatus` の語は借りない（`unknown` の主語が違う）。
const runnerProbeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('asked') }),
  z.object({ status: z.literal('unheard') }),
  // 理由は1行に畳む: 例外は失敗した呼び出しのパラメータを添えてくることがあるため。
  z.object({ status: z.literal('failed'), error: z.string() }),
]);

const runnerPushOutcomeSchema = z.object({
  status: z.enum(['ok', 'failed']),
  at: z.string(),
  error: z.string().optional(),
});

const runnerPushHealthSchema = z.object({
  profile: runnerPushOutcomeSchema.optional(),
  credentials: runnerPushOutcomeSchema.optional(),
  agentToken: runnerPushOutcomeSchema.optional(),
  mcpServers: runnerPushOutcomeSchema.optional(),
  plugins: runnerPushOutcomeSchema.optional(),
});

// `errors: null` は「init がこの欄を省いた」であって、読み込みの成功の断定ではない。
const agentPluginLoadSchema = z.object({
  plugins: z.array(z.object({ name: z.string(), version: z.string().optional() })),
  errors: z
    .array(
      z.object({
        plugin: z.string(),
        type: z.string(),
        message: z.string(),
        path: z.string().optional(),
      }),
    )
    .nullable(),
  errorsOmitted: z.number().int().positive().optional(),
});

const clonePluginLoadObservationSchema = z.object({
  at: z.string(),
  pluginLoad: agentPluginLoadSchema,
});

const runnerPluginLoadObservationSchema = clonePluginLoadObservationSchema.extend({
  managerId: z.string(),
});

// `unknown` を「頼めない」と読まない: 名乗らない旧い runner・名乗りをまだ受けていない器のため。
const runnerManagerPeersSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('named'),
    peers: z.array(
      z.object({
        provider: z.string(),
        models: z.array(z.string()).optional(),
      }),
    ),
    closed: z.array(z.object({ provider: z.string(), reason: z.string() })).optional(),
  }),
  z.object({ status: z.literal('unknown') }),
]);

const runnerSummarySchema = z.object({
  // `runnerId` ではなく label が名簿の鍵: `runnerId` は繋がるまで分からず、まだ開けていない1台は label でしか指せないため。
  label: z.string(),
  // `lost` と `unreachable` は別物: 前者は開けていた宛先が黙った（走っていた仕事ごと黙った可能性がある）、後者はまだ開けていない宛先。
  state: runnerLivenessSchema,
  since: z.string(),
  // 原因を見るための窓であって、値は載せない。
  error: z.string().optional(),
  runnerId: z.string().optional(),
  workspacePath: z.string().optional(),
  // `onSwap` の知らせとは別の口: あちらは遷移で、ここは状態。知らせを見落とした後・デーモンの再起動後に、引き取りの判定が正しいかを検算する口が他に無い。名乗らない runner では返らず、無いことを「入れ替わっていない」と読まないこと。
  instanceId: z.string().optional(),
  instanceSince: z.string().optional(),
  // 空であることだけを見ない: 叩けなかったときも空になるので、「鍵が配られていない」と読んでよいのは `credentialsProbe.status === 'asked'` のときだけ。
  credentials: z.array(runnerCredentialFingerprintSchema),
  credentialsProbe: runnerProbeSchema,
  profile: runnerProfileFingerprintSchema.optional(),
  profileProbe: runnerProbeSchema,
  revision: runnerRevisionStatusSchema,
  pushHealth: runnerPushHealthSchema.optional(),
  managerPeers: runnerManagerPeersSchema.optional(),
  pluginLoad: runnerPluginLoadObservationSchema.optional(),
});

export const runnersListResponseSchema = z.object({
  runners: z.array(runnerSummarySchema),
  clonePluginLoad: clonePluginLoadObservationSchema.optional(),
  // runner の版と1回の読みで比較できるよう同じ応答の外側へ並べる: 別々の場所に出すと突き合わせ忘れがそのまま見逃しになるため。
  daemonRevision: daemonRevisionSchema,
});

// 「分からない」を表す値（`unknown`）を持つ: 配線されていない・聞きに行けない軸に `ok` / `idle` を作ると「確かめた」と読めるため。
export const topologyCloneSchema = z.object({
  state: z.enum(['idle', 'busy', 'usage_blocked', 'unknown']),
  turn: z
    .object({ conversationId: z.string().optional(), kind: z.enum(['normal', 'distill']) })
    .optional(),
  model: z.string().optional(),
});

export const topologyStorageSchema = z.object({
  // 接続情報は載せない。
  label: z.string().optional(),
  state: z.enum(['ok', 'unreachable', 'unknown']),
  checkedAt: isoDateTimeSchema.optional(),
  // エラーの種別だけ載せる: 接続先・認証情報を含めないため。
  error: z.string().optional(),
});

const topologyWorkerSchema = z.object({
  agentType: z.string(),
  peer: z.object({ provider: z.string() }).optional(),
  model: z.string().optional(),
  lastTool: z.string().optional(),
  lastToolAt: isoDateTimeSchema.optional(),
  // 欄が無いことは「観測していない」であって「実行中でない」ではない。
  runningTool: z.object({ tool: z.string(), startedAt: isoDateTimeSchema }).optional(),
});

const topologyWaitingSchema = z.object({
  requestId: z.string(),
  kind: waitingKindSchema.optional(),
  summary: z.string(),
  askedAt: isoDateTimeSchema.optional(),
});

const topologyManagerSchema = z.object({
  managerId: z.string(),
  status: jobStatusSchema,
  live: z.boolean(),
  runnerId: z.string().optional(),
  runnerListedAt: isoDateTimeSchema.optional(),
  usageStoppedAt: jobSchema.shape.usageStoppedAt,
  managerModel: z.string().optional(),
  workerModel: z.string().optional(),
  request: z.string(),
  startedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  lastReportAt: isoDateTimeSchema.optional(),
  waiting: z.array(topologyWaitingSchema),
  waitingOmitted: z.number().int().nonnegative().optional(),
  // `status` は `done` のままなので、これが無いと地図は「仕事なし」と「完了待ち」を言い分けられない。
  awaitingBackground: z
    .object({
      tasks: z.number(),
      withheldReports: z.number(),
      breakdown: z.string(),
      since: z.string(),
    })
    .optional(),
  workers: z.array(topologyWorkerSchema),
});

const topologyExternalSchema = z.object({
  // 連携の鍵の id（鍵の値ではない）。
  keyId: z.string(),
  name: z.string(),
  source: z.string(),
  // クローンが処理した時刻ではなく、デーモンが受信箱へ積んだ時刻。
  lastAt: isoDateTimeSchema,
});

const topologyLinkSchema = z.object({
  // 知らない key は読み手が無視する（版ずれ）。
  key: z.string(),
  lastDownAt: isoDateTimeSchema.optional(),
  lastUpAt: isoDateTimeSchema.optional(),
  lastActivityAt: isoDateTimeSchema.optional(),
});

export const topologyResponseSchema = z.object({
  observedAt: isoDateTimeSchema,
  clone: topologyCloneSchema,
  storage: topologyStorageSchema,
  runners: z.array(
    z.object({
      label: z.string(),
      runnerId: z.string().optional(),
      state: runnerLivenessSchema,
      since: isoDateTimeSchema,
    }),
  ),
  managers: z.array(topologyManagerSchema),
  managersOmitted: z.number().int().nonnegative().optional(),
  // `managers` が空でも「走っているマネージャーは居ない」とは限らない: 壊れた行は `managers` に数えられないため、第3の状態として別に言う。
  unreadable: z.array(unreadableJobSchema).optional(),
  // 1件でも在るときだけ載せる: 欄が無いことは「呼ばれていない」ではなく「観測していない」でありうる（古いデーモンも載せない）。
  externals: z.array(topologyExternalSchema).optional(),
  externalsOmitted: z.number().int().positive().optional(),
  links: z.array(topologyLinkSchema),
});

export const runnersCredentialsResponseSchema = z.object({
  results: z.array(
    z.object({
      runnerId: z.string(),
      ok: z.boolean(),
      credentials: z.array(runnerCredentialFingerprintSchema).optional(),
      error: z.string().optional(),
    }),
  ),
});

export const runnersVacateCommandSchema = z.object({
  runnerId: z.string(),
});

// HTTP の状態は握手を飛ばした回も 200 のまま: 「空けると立てた」こと自体は成功しているため。飛ばしたのは載っている委譲への確かめた停止の握手だけで、貸し出しは返していない。
export const runnersVacateResponseSchema = z.object({
  ok: z.literal(true),
  handshakeSkipped: z
    .object({
      reason: z.enum(['runner_unreadable', 'jobs_unreadable']),
      message: z.string(),
      retry: z.literal(true),
    })
    .optional(),
});

// `credentialScopeSchema` と同じ3値。宣言の順の都合で別に持つ（あちらはこの下で定義される）。
const profileScopeSchema = z.enum(['all', 'app', 'runner']);

const profileComposedFingerprintSchema = z.object({
  sha256: z.string().optional(),
  bytes: z.number().optional(),
});

// 本文を返す: 人間が自分で書いたものを読み直せないと typo ひとつ直せないため。
export const profileEntrySchema = z.object({
  name: z.string(),
  script: z.string(),
  scope: profileScopeSchema,
  updatedAt: z.string(),
  sha256: z.string(),
  bytes: z.number(),
});

// 本文は載せない: 値は送った本人が持っており、応答に載せる理由が無い口で鍵を往復させないため。
export const profileEntrySummarySchema = profileEntrySchema.omit({ script: true });

// 本文を返す口は実行環境の持ち主だけが通る（`/access` とは資格が違う）: 鍵をまるごと運ぶ口のため。
// `script` / `updatedAt` / `sha256` / `bytes` は消さない: 別々に配られる古い CLI と Web が1本の時代の応答をまだ読むため（deprecated）。
export const profileResponseSchema = z.object({
  entries: z.array(profileEntrySchema),
  clone: profileComposedFingerprintSchema,
  runner: profileComposedFingerprintSchema,
  script: z.string(),
  updatedAt: z.string().optional(),
  sha256: z.string().optional(),
  bytes: z.number().optional(),
});

// 理由を本文で返す: シェルの構文エラーは行番号込みでしか直せないため。
export const profileErrorResponseSchema = z.object({
  error: z.string(),
  detail: z.string(),
});

export const profileEntryUpdateRequestSchema = z.object({
  script: z.string().refine((value) => value.trim().length > 0),
  scope: profileScopeSchema.optional(),
});

export const profileUpdateRequestSchema = z.object({
  script: z.string(),
});

export const profileUpdateResponseSchema = z.object({
  updatedAt: z.string(),
  entries: z.array(profileEntrySummarySchema),
  composed: z.object({
    clone: profileComposedFingerprintSchema,
    runner: profileComposedFingerprintSchema,
  }),
  sha256: z.string().optional(),
  bytes: z.number().optional(),
  clone: z.object({
    ok: z.boolean(),
    error: z.string().optional(),
    output: z.string().optional(),
    names: z.array(z.string()).optional(),
  }),
  runners: z.array(
    z.object({
      runnerId: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      output: z.string().optional(),
      names: z.array(z.string()).optional(),
      profile: runnerProfileFingerprintSchema.optional(),
    }),
  ),
});

// 値を返す: 人間が自分で書いたものを読み直せないと typo ひとつ直せないため。`env` / `headers` に鍵が入りうるので、口は持ち主だけに絞ってある。
export const mcpServersResponseSchema = z.object({
  mcpServers: mcpServersSchema,
  updatedAt: z.string().optional(),
  version: z.string(),
});

// 未知の欄は拒む: 捨てると綴りを間違えた欄が「保存できたのに効かない」になるため。
export const mcpServersUpdateRequestSchema = z.strictObject({
  mcpServers: mcpServersSchema,
  ifMatch: z.string().optional(),
});

// `current` は `GET /mcp-servers` と同じ形（鍵の有無で他の 409 と見分ける）。
export const mcpServersConflictResponseSchema = z.object({
  error: z.string(),
  current: mcpServersResponseSchema,
});

// 名前だけを返す: 値は送った本人が持っており、応答に載せる理由が無い口で鍵を往復させないため。
export const mcpServersUpdateResponseSchema = z.object({
  names: z.array(z.string()),
  updatedAt: z.string(),
  version: z.string(),
  sha256: z.string().optional(),
  appliesFrom: z.string(),
  runners: z.array(
    z.object({
      runnerId: z.string(),
      ok: z.boolean(),
      mcpServers: runnerMcpServersFingerprintSchema.optional(),
      // 一時障害と区別する: 疑う先が「待てば直る」ではなく「runner の版」のため。
      unsupported: z.literal(true).optional(),
      error: z.string().optional(),
    }),
  ),
});

// 未知の欄は拒む: 綴り違いが「効かない指定」にならないようにするため。
export const pluginPreviewRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('url'),
    url: pluginRepoUrlSchema,
    path: pluginRelativePathSchema.optional(),
    ref: z
      .string()
      .min(1)
      .max(256)
      // eslint-disable-next-line no-control-regex -- 制御文字・空白を弾くための検査
      .refine((v) => !/[\u0000- \u007f]/.test(v) && !v.startsWith('-'), {
        message: '使えない文字を含む',
      })
      .optional(),
    sha: pluginSourceShaSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('marketplace'), plugin: pluginNameSchema }),
]);

const pluginSourceViewSchema = z.object({
  kind: z.enum(['url', 'marketplace']),
  url: z.string(),
  path: z.string().optional(),
  sha: z.string(),
  version: z.string().optional(),
  marketplace: z.string().optional(),
  plugin: z.string().optional(),
});

const pluginPathReasonSchema = z.object({ path: z.string(), reason: z.string() });
const pluginPresenceSchema = z.object({ present: z.boolean(), paths: z.array(z.string()) });

export const pluginPreviewSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: pluginSourceViewSchema,
  sha: z.string(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
  files: z.array(z.object({ path: z.string(), size: z.number().int(), executable: z.boolean() })),
  counts: z.object({
    skills: z.number().int(),
    agents: z.number().int(),
    commands: z.number().int(),
  }),
  hooks: pluginPresenceSchema,
  modules: pluginPresenceSchema,
  lspServers: pluginPresenceSchema,
  mcp: pluginPresenceSchema,
  executables: z.object({
    extracted: z.array(z.string()),
    notExtracted: z.array(z.string()),
  }),
  shellExecution: pluginPresenceSchema,
  skipped: z.array(pluginPathReasonSchema),
  extractorDrops: z.array(pluginPathReasonSchema),
  skillExcerpts: z.array(
    z.object({ path: z.string(), excerpt: z.string(), truncated: z.boolean() }),
  ),
});

export const pluginPreviewResponseSchema = z.object({
  previewId: z.string(),
  expiresAt: z.string(),
  summary: pluginPreviewSummarySchema,
});

export const pluginInstallRequestSchema = z.strictObject({
  previewId: z.string().min(1).max(256),
  scope: pluginScopeSchema.default('all'),
  enableHooks: z.boolean().default(false),
  enableMcp: z.boolean().default(false),
});

export const pluginSummaryViewSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: pluginSourceViewSchema,
  scope: pluginScopeSchema,
  enableHooks: z.boolean(),
  enableMcp: z.boolean(),
  contentSha256: z.string(),
  installedAt: z.string(),
  installedBy: z.string(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
});

export const pluginsListResponseSchema = z.object({ plugins: z.array(pluginSummaryViewSchema) });

const pluginRunnerResultSchema = z.object({
  runnerId: z.string(),
  ok: z.boolean(),
  plugins: z
    .object({
      sha256: z.string(),
      plugins: z.array(z.object({ name: z.string(), sha: z.string(), contentSha256: z.string() })),
      updatedAt: z.string(),
    })
    .optional(),
  unsupported: z.literal(true).optional(),
  error: z.string().optional(),
});

export const pluginInstallResponseSchema = z.object({
  plugin: pluginSummaryViewSchema,
  appliesFrom: z.string(),
  runners: z.array(pluginRunnerResultSchema),
});

export const pluginRemoveResponseSchema = z.object({
  name: z.string(),
  appliesFrom: z.string(),
  runners: z.array(pluginRunnerResultSchema),
});

const credentialScopeSchema = z.enum(['all', 'app', 'runner']);

// `runnerCredentialFingerprintSchema` を直接拡張せずここで `.extend()` する: あちらは runner 側の指紋（`GET /runners` の `credentials`）と共有する土台で、runner には scope の概念が無いため。
const credentialFingerprintWithMetaSchema = runnerCredentialFingerprintSchema.extend({
  scope: credentialScopeSchema,
  secret: z.boolean(),
  value: z.string().optional(),
});

// 値（`auth.json` の中身）は返さない。
export const codexAuthStatusResponseSchema = z.object({
  loggedIn: z.boolean(),
  email: z.string().nullable(),
  planType: z.string().nullable(),
  updatedAt: z.string().nullable(),
  fingerprint: z.string().nullable(),
  failure: z.object({ at: z.string(), reason: z.string() }).nullable(),
});

export const codexLoginResponseSchema = z.object({
  id: z.string(),
  state: z.enum(['pending', 'succeeded', 'failed', 'canceled', 'expired']),
  verificationUrl: z.string(),
  userCode: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
});

export const codexLogoutResponseSchema = z.object({ removed: z.boolean() });

export const credentialsResponseSchema = z.object({
  credentials: z.array(credentialFingerprintWithMetaSchema),
});

// 名前の形は `runnerCredentialSchema` をそのまま使う: 名前は器の中のファイル名になり、パスとして解釈されうる形を最初から認めないため。2つ書くと必ずずれる。
const credentialInputSchema = runnerCredentialSchema.extend({
  scope: credentialScopeSchema.optional(),
  secret: z.boolean().optional(),
});

export const credentialsUpdateRequestSchema = z.object({
  credentials: z.array(credentialInputSchema).min(1),
});

export const credentialsUpdateResponseSchema = z.object({
  credentials: z.array(credentialFingerprintWithMetaSchema),
  // 台ごとに返す: 畳んで1つの成否にしない。
  runners: z.array(
    z.object({
      runnerId: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      credentials: z.array(runnerCredentialFingerprintSchema).optional(),
    }),
  ),
});

// `settings` が読めないときは既定値で埋めず `settingsUnreadable` を返す: 既定へすり替えると `off` にしてあった回転を黙って戻すため。
// `rowsUnreadable.rows` はトークンの値を含まない。`tokens` が空で `rowsUnreadable` が在るときは「登録されていない」ではなく「読めた行が無い」。
export const tokensResponseSchema = z.object({
  tokens: z.array(agentTokenViewSchema),
  settings: tokenRotationSettingsSchema.optional(),
  settingsUnreadable: z.object({ reason: z.string() }).optional(),
  rowsUnreadable: z
    .object({
      count: z.number().int().positive(),
      rows: z.array(unreadableTokenSchema),
      carriedOver: z.literal(true).optional(),
    })
    .optional(),
});

// 表示の読み直しに失敗したときは `tokens` を載せない: 空の `tokens` は「プールが空」と読めてしまうため。
export const tokensReplaceResponseSchema = tokensResponseSchema.extend({
  tokens: z.array(agentTokenViewSchema).optional(),
  viewUnavailable: z.object({ reason: z.string() }).optional(),
});

export const tokensUnreadableRemoveRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

// 表示の読み直しに失敗したときは `tokens` を載せない: 空の `tokens` は「プールが空」と読めてしまうため。行の中身（トークンの値）は含めない。
export const tokensUnreadableRemoveResponseSchema = tokensResponseSchema.extend({
  tokens: z.array(agentTokenViewSchema).optional(),
  removedIds: z.array(z.string()),
  viewUnavailable: z.object({ reason: z.string() }).optional(),
});

export const tokensUpdateRequestSchema = z.object({
  tokens: z.array(agentTokenInputSchema),
});

export const tokensPolicyUpdateRequestSchema = z.object({
  rotateOn: tokenRotationPolicySchema.optional(),
  cooldownMs: z.number().int().positive().optional(),
});

// ここで zod の形にする: core の `dropped-record.ts` は stderr へ出す文字列とプレーンな TS の型しか持たず、zod スキーマが無いため。
export const droppedTraceOriginSchema = z.literal('daemon');

export const droppedResponseSchema = z.object({
  origin: droppedTraceOriginSchema,
  since: z.string(),
  limit: z.number().int(),
  total: z.number().int(),
  traces: z.array(z.string()),
});

const progressCount = z.number().int().min(0);
const progressIso = z.string();

const githubObservationBaseShape = {
  observedAt: progressIso,
  observedBy: z.string(),
  query: z.string(),
  limit: z.number().int().positive().optional(),
};
const githubObservationOkSchema = z.object({
  ...githubObservationBaseShape,
  openIssues: progressCount,
  openPulls: progressCount,
  truncated: z.boolean(),
  ci: z
    .object({
      pulls: progressCount,
      success: progressCount,
      failure: progressCount,
      pending: progressCount,
      checks: z.string(),
      truncated: z.boolean().optional(),
    })
    .optional(),
  ciUnavailable: z.string().optional(),
});
const githubObservationFailedSchema = z.object({
  ...githubObservationBaseShape,
  reason: z.string(),
});

export const githubObservationRequestSchema = githubObservationInputSchema;

const progressForecastBasisSchema = z.object({
  open: progressCount,
  closedInWindow: progressCount,
  openedInWindow: progressCount,
  windowHours: z.number(),
  method: z.literal(PROGRESS_FORECAST_METHOD),
  unreadable: progressCount,
  minClosedInWindow: progressCount,
});

// 率（%）は出さない: 分母が定まらないため。`github` はデーモンが GitHub を見に行った結果ではなく、観測した側の申告（`observedBy` を必ず付ける）で、記録が無ければ 0 件ではなく `not_observed`。
export const progressResponseSchema = z.object({
  observedAt: progressIso,
  window: z.object({ hours: z.number(), from: progressIso, to: progressIso }),
  backlog: z.object({
    total: progressCount,
    byOrigin: z.object({
      human: progressCount,
      manager: progressCount,
      external: progressCount,
      self: progressCount,
    }),
    age: z.object({
      oldestAt: progressIso.nullable(),
      medianHours: z.number().nullable(),
      buckets: z.object({
        under1h: progressCount,
        under24h: progressCount,
        under7d: progressCount,
        over7d: progressCount,
      }),
    }),
    byState: z.object({
      untouched: progressCount,
      responded: progressCount,
      delegated: progressCount,
      notApplicable: progressCount,
    }),
    completeness: z.object({
      unreadable: progressCount,
      trimmedClosed: progressCount,
      unreadableJobs: progressCount,
    }),
  }),
  inProgress: z.object({
    running: progressCount,
    awaitingHuman: progressCount,
    lost: progressCount,
    lastReport: z.object({
      oldestAt: progressIso.nullable(),
      newestAt: progressIso.nullable(),
      withoutReport: progressCount,
    }),
  }),
  throughput: z.object({
    commitmentsOpened: progressCount,
    commitmentsClosed: progressCount,
    mayBeUndercounted: z.boolean(),
    delegationsEnded: z.object({ count: progressCount, basis: z.literal('updatedAt') }),
  }),
  forecast: z.discriminatedUnion('state', [
    z.object({
      state: z.literal('estimated'),
      hoursToDrain: z.number().min(0),
      basis: progressForecastBasisSchema,
      notice: z.string(),
    }),
    z.object({ state: z.literal('not_converging'), basis: progressForecastBasisSchema }),
    z.object({
      state: z.literal('unavailable'),
      reason: z.enum(['closed_too_few', 'ledger_younger_than_window', 'history_incomplete']),
      basis: progressForecastBasisSchema,
    }),
  ]),
  github: z.discriminatedUnion('state', [
    z.object({ state: z.literal('not_observed'), reason: z.string() }),
    z.object({
      state: z.literal('observed'),
      repos: z.array(
        z.object({
          repo: z.string(),
          latestOk: githubObservationOkSchema.nullable(),
          latestFailed: githubObservationFailedSchema.nullable(),
        }),
      ),
      scan: z.object({ limit: z.number().int().positive(), reachedLimit: z.boolean() }),
    }),
  ]),
});

// `storedBytes` はデーモンの永続化層をまたいで比較してはならない: 置き場（pg / fs）がこの行に実際に使っている量で、生ログの文字数ではないため。
export const archiveEntrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  at: z.string(),
  storedBytes: z.number().int(),
  removedAt: z.string().optional(),
  removedBytes: z
    .number()
    .int()
    .optional()
    .describe(
      '消したときの本文の素の UTF-8 バイト数。`storedBytes` とは単位が違い、置き場で' +
        '解放した量ではない——pg は TOAST 圧縮の分だけ `storedBytes` より大きく見えうる（#2074）。',
    ),
  continuity: z.enum(['first', 'continues', 'diverged', 'unknown']).optional(),
});

export const archiveListResponseSchema = z.object({ entries: z.array(archiveEntrySchema) });

// `absent` と `unknown` は別物: `unknown` は判定はできたが直前の行に指紋が無かった、`absent` はその行自体が判定の門より前に積まれた。
export const archiveSessionSummarySchema = z.object({
  sessionId: z.string(),
  rows: z.number().int(),
  storedBytes: z.number().int(),
  maxStoredBytes: z.number().int(),
  firstAt: z.string(),
  lastAt: z.string(),
  continuity: z.object({
    first: z.number().int(),
    continues: z.number().int(),
    diverged: z.number().int(),
    unknown: z.number().int(),
    absent: z.number().int(),
  }),
});

export const archiveSessionsResponseSchema = z.object({
  sessions: z.array(archiveSessionSummarySchema),
});

// `alreadyRemoved` を隠さない: 「いま消した」と「前から消えていた」を畳むと、呼び出し側は自分の呼び出しが何をしたのか見失うため。
export const archiveRemoveResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  bytes: z
    .number()
    .int()
    .describe(
      '消した本文の素の UTF-8 バイト数。`storedBytes` とは単位が違い、置き場で解放した' +
        '量ではない（#2074）。',
    ),
  alreadyRemoved: z.boolean(),
  override: z.object({ managerId: z.string(), reason: z.string() }).optional(),
});

export const archiveRemovedResponseSchema = z.object({
  error: z.literal('removed'),
  removedAt: z.string(),
  bytes: z
    .number()
    .int()
    .describe(
      '消したときの本文の素の UTF-8 バイト数。`storedBytes` とは単位が違い、置き場で' +
        '解放した量ではない（#2074）。',
    ),
  archiveId: z.string().optional(),
});

// NUL を落とした後の長さでも見る: `.min(1)` だけだと NUL だけの要素が空として断られず先へ流れ、どの値にも一致しない「0件」になるため。値そのものは書き換えない。
const nulOnlyRejectedString = z
  .string()
  .min(1)
  .refine((value) => stripNul(value).length > 0, {
    message: 'NUL だけの値は空として断る',
  });

// 絞り込みを1つも渡さない呼びはハンドラ側（`app.ts`）が 400 で断る: このスキーマ自身は「絞り込みが無い」を特別扱いしない。
export const archiveRemoveManyRequestSchema = z.object({
  sessionIds: z.array(nulOnlyRejectedString).min(1).optional(),
  before: z.string().min(1).optional(),
  minStoredBytes: z.number().int().min(0).optional(),
  requireContainment: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  limit: z.number().int().min(1).optional(),
  reason: nonBlankString,
});

// `targeted` は guard を通った後の件数: guard で飛ばした行を `targeted` と `skipped.inUse` の両方に数えると1行を2回数え、`matched` との等式が壊れるため。
export const archiveRemoveManyResponseSchema = z.object({
  ok: z.literal(true),
  dryRun: z.boolean(),
  totalRows: z.number().int(),
  matched: z.number().int(),
  targeted: z.number().int(),
  removedIds: z.array(z.string()),
  removedBytes: z
    .number()
    .int()
    .describe(
      '消した本文の素の UTF-8 バイト数の合計。`storedBytes`/`minStoredBytes` とは単位が' +
        '違い、置き場で解放した量ではない（#2074）。',
    ),
  remaining: z.number().int(),
  skipped: z.object({
    newest: z.number().int(),
    alreadyRemoved: z.number().int(),
    notContained: z.number().int(),
    protected: z.number().int(),
    inUse: z.number().int(),
  }),
  raced: z.number().int(),
});

// ここでは集計しない: 複製するとクローンの道具（`manager_list`）とこの口が違う数を見るため。
export const inboxBacklogResponseSchema = z.object({
  total: z.number().int(),
  oldestAt: z.string().optional(),
  byType: z.array(z.object({ type: z.enum(INBOX_EVENT_TYPE_ORDER), count: z.number().int() })),
  bySource: z.array(z.object({ source: z.string(), count: z.number().int() })),
  bySourceOverflowKinds: z.number().int(),
  bySourceOverflowCount: z.number().int(),
  bySourceUnknownCount: z.number().int(),
  distinct: z.number().int(),
  distinctAcrossManagers: z.number().int(),
  undelivered: z.number().int(),
  deliveredOnce: z.number().int(),
  redelivered: z.number().int(),
  maxDeliveries: z.number().int(),
  undeliveredByType: z.array(
    z.object({ type: z.enum(INBOX_EVENT_TYPE_ORDER), count: z.number().int() }),
  ),
  ageBuckets: z.array(z.object({ label: z.string(), count: z.number().int() })),
  observedAt: z.string(),
  humanOriginated: z.object({
    total: z.number().int(),
    byType: z.array(
      z.object({ type: z.enum(['human_message', 'human_answer']), count: z.number().int() }),
    ),
    oldestAt: z.string().optional(),
    undelivered: z.number().int(),
  }),
  // 1件でも在るときだけ載せる: 空配列を作ると「読めない行は無い」と読めてしまうため。`total` には入らない（`total` は読めた行の数）。
  unreadable: z.array(unreadableInboxEventSchema).optional(),
});

// 「在る種類を全部並べた呼びは断る」判定はハンドラ側（`app.ts`）に置く: `z.array` に特定の組み合わせを禁じる制約は素直に書けないため。
export const inboxRemoveManyRequestSchema = z.object({
  types: z.array(z.enum(INBOX_EVENT_TYPE_ORDER)).min(1),
  sources: z.array(nulOnlyRejectedString).min(1).optional(),
  before: z.string().min(1).optional(),
  reason: nonBlankString,
  dryRun: z.boolean().optional(),
  limit: z.number().int().min(1).optional(),
});

// `droppedFromDelivery` は `dryRun: true` でも欄を省かず 0 を返す: 省くと「配達を止める機構が無い版」と「試算だったから 0」が区別できないため。
export const inboxRemoveManyResponseSchema = z.object({
  ok: z.literal(true),
  dryRun: z.boolean(),
  totalPending: z.number().int(),
  matched: z.number().int(),
  targeted: z.number().int(),
  // `removedIds` は打ち切らない: JSON の応答は人間・スクリプトが読むもので、クローンの道具の文脈窓のような制約が無いため。
  removedIds: z.array(z.string()),
  droppedFromDelivery: z.number().int(),
  remaining: z.number().int(),
});

// `confirm: true` を必須にする: UI の確認を経ずにこの口を直接叩く呼び出しを 400 で止めるため。
export const resetRequestSchema = z.object({
  confirm: z.literal(true),
});

export const resetResponseSchema = z.object({
  // 件数を返す: `{ ok: true }` だけでは、対象が既に空だったのか何百件と消したのかが呼び出し側から見えず、本当に消えたか確かめられないため。
  cleared: z.object({
    memory: z.number().int(),
    journal: z.number().int(),
    jobs: z.number().int(),
    approvals: z.number().int(),
    schedules: z.number().int(),
    schedulePhases: z.number().int(),
    inbox: z.number().int(),
    commitments: z.number().int(),
    // ここへ足し忘れると静かに落ちる: zod は未知のキーを黙って捨て、器は消したのに申告には出ない形になるため。
    practices: z.number().int(),
    archive: z.number().int(),
    sessions: z.number().int(),
    profile: z.number().int(),
    usageDaily: z.number().int(),
    usageBaseline: z.number().int(),
    usageLedger: z.number().int(),
    usageTurns: z.number().int(),
    attachments: z.number().int(),
    sessionLog: z.number().int().optional(),
  }),
});

// `describeRoute` を付けていない経路は元々 spec に載らないので二重の安全策だが、`/openapi.json` `/docs` 自身を外すことを明示しておく。
export const openApiExcludePaths = ['/openapi.json', '/docs'];

export const openApiDocumentation: GenerateSpecOptions['documentation'] = {
  openapi: '3.1.0',
  info: {
    title: 'alteroid daemon API',
    version: '0.1.0',
    description:
      'alteroidd（常駐デーモン）の HTTP API。クローンとの対話・記憶・日誌・日報・' +
      '承認待ち・委譲先マネージャーの操作までを持つ。**runner の制御面（SDK の ' +
      'start/send/stop など）は含まない** — そこはマネージャーが自分宛の許可確認に ' +
      '自分で答えられてしまう境界であり、外へ出す面ではない（docs/architecture.md ' +
      '「制御面の保護」）。',
  },
  servers: [
    {
      url: 'http://127.0.0.1:4517',
      description:
        '既定の待ち受け。ポートは ALTEROID_PORT で変わる（既定 4517）。既定では ' +
        '127.0.0.1 以外には開いていない（ALTEROID_BIND で変更可）。',
    },
  ],
  tags: [
    { name: 'system', description: '死活監視・停止など、デーモン自体の管理' },
    { name: 'chat', description: '人間とクローンの対話（SSE）と会話終了（蒸留の契機）' },
    {
      name: 'conversations',
      description: '会話の履歴。日誌から組み立てる（新しい状態は持たない）',
    },
    {
      name: 'memory',
      description: '記憶（PersonaStore）。人間が読んでいつでも直せる Markdown 文書群',
    },
    { name: 'journal', description: '日誌（追記専用の記録）。可観測性の中段' },
    { name: 'reports', description: '日報。可観測性の最上段（人間の普段の接点はほぼこれだけ）' },
    { name: 'approvals', description: '承認待ちキュー（`ask_human` の応答口）' },
    {
      name: 'permission-grants',
      description:
        '人間が承認した Bash 許可の記録（Issue #863）。`request_permission` の要求に' +
        '許可されたアカウントが定型文で答えたときだけ記録され、以降 Bash 呼び出しを' +
        '自動で通す（クローン本セッションだけ）。取り消しは即座に（次の呼び出しから）効く',
    },
    { name: 'events', description: '外部イベントの入口（仕事の起点③）' },
    { name: 'schedule', description: '時間起点のジョブ（起点②④）の一覧と手動起動' },
    {
      name: 'commitments',
      description:
        '引き受けたまま終わっていない仕事の台帳。クローンの commitment_* と同じものを' +
        '人間の側からも読み・積み・閉じられる',
    },
    { name: 'managers', description: '委譲先マネージャーの一覧・状態・生ログ・直接の指示/停止' },
    { name: 'runners', description: '委譲先 runner の名簿と、そこへ配る鍵の指紋' },
    { name: 'topology', description: '稼働の地図（各層の状態と、線の最後の活動。SSE あり）' },
    { name: 'archive', description: 'セッション生ログ（可観測性の最下段）' },
    {
      name: 'mcp-servers',
      description:
        '人間の MCP 連携の登録（.mcp.json 相当。#325）。記憶ストアに置き、クローンの' +
        'セッションへ SDK の mcpServers として渡す。env / headers に鍵が入りうる',
    },
    {
      name: 'auth',
      description:
        'ログイン（誰がこの API を叩いているか）。PRD「権限境界」（クローンが記憶を' +
        '根拠に何を人間へ確認するか）とは別の層で、持つのは許可の2値だけである',
    },
    {
      name: 'access',
      description:
        'アクセス許可の付与・剥奪。alteroid を使う許可（access grant 済み）があれば' +
        '実行環境の持ち主と同格に叩ける（2026-09-06 のオーナー決定）',
    },
    {
      name: 'tokens',
      description:
        '認証トークンのプール（Issue #393）。**回さない**——枠に当たったときに回す' +
        '候補を置くだけの器。値は決して出さない（label と指紋だけ）',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          '2種類のトークンが同じ形で通る。①**アクセストークン**（`alt_` で始まる。' +
          '`alteroid login` で発行し、許可されたアカウントのものだけが通る）。' +
          '②**実行環境の持ち主のトークン**（`~/.alteroid/state/daemon.json` の ' +
          '`token`。CLI がこれを使う。ここを読めること自体が境界である）。\n\n' +
          '**`/access/*` `/tokens*` は①②どちらでも通る**（2026-09-06 のオーナー決定' +
          '——alteroid を使う許可があれば実行環境の持ち主と同格）。**②でしか通らない' +
          'のは `/profile`（実行環境そのものを差し替える口）だけである。**\n\n' +
          '`ALTEROID_AUTH=off`（既定はログイン手段が未設定のとき）では認証を要求しない。',
      },
    },
  },
  // 既定で全経路に認証を要求する: 逆にすると、経路を足した人が security を書き忘れたときに黙って穴が開く。
  security: [{ bearerAuth: [] }],
};

// 呼ばれたら throw する: spec 生成でハンドラが実行されたらそれ自体がバグで、黙って何もしないダミーでは隠れるため。
export async function buildOpenApiDocument(): Promise<unknown> {
  const stubManagers: ManagerPool = {
    start() {
      throw new Error('spec 生成専用のスタブ: マネージャーは起こさない');
    },
    send() {
      throw new Error('spec 生成専用のスタブ: マネージャーには送らない');
    },
    abort() {
      throw new Error('spec 生成専用のスタブ: マネージャーは止めない');
    },
    list() {
      throw new Error('spec 生成専用のスタブ: マネージャー一覧は持たない');
    },
    denials() {
      throw new Error('spec 生成専用のスタブ: 拒否は数えていない');
    },
    runners() {
      throw new Error('spec 生成専用のスタブ: 器の一覧は持たない');
    },
    pushHealthOf() {
      throw new Error('spec 生成専用のスタブ: 押し込み結果は持たない');
    },
    managerPeersOf() {
      throw new Error('spec 生成専用のスタブ: peer の名乗りは持たない');
    },
    runnerBacklog() {
      throw new Error('spec 生成専用のスタブ: 器の滞留は観測していない');
    },
    runnerIdOf() {
      throw new Error('spec 生成専用のスタブ: 委譲の像は持たない');
    },
    transcript() {
      throw new Error('spec 生成専用のスタブ: 生ログは持たない');
    },
    unpushedWork() {
      throw new Error('spec 生成専用のスタブ: 未 push の実装は数えない');
    },
    runningManagerOwning() {
      throw new Error('spec 生成専用のスタブ: 走行中の像は持たない');
    },
    restore() {
      throw new Error('spec 生成専用のスタブ: 引き継ぎはしない');
    },
    resumeStoppedByUsage() {
      throw new Error('spec 生成専用のスタブ: 枠で止まった委譲は起こさない');
    },
    reattachRunner() {
      throw new Error('spec 生成専用のスタブ: 取り直しはしない');
    },
    relocateFrom() {
      throw new Error('spec 生成専用のスタブ: 移送はしない');
    },
    vacate() {
      throw new Error('spec 生成専用のスタブ: 空けない');
    },
    probeTurnEnds() {
      throw new Error('spec 生成専用のスタブ: ターン終了の探りはしない');
    },
    flushWithheldReports() {
      throw new Error('spec 生成専用のスタブ: 握り潰した報告は無い');
    },
    settleStalledUsageWakes() {
      throw new Error('spec 生成専用のスタブ: 枠で止まった借りは清算しない');
    },
    renotifyStalledDenials() {
      throw new Error('spec 生成専用のスタブ: 止まった拒否は知らせ直さない');
    },
    stop() {
      throw new Error('spec 生成専用のスタブ');
    },
  };

  const stubClone: CloneHost = {
    managers: stubManagers,
    // 読み取り専用のプロパティは throw できない: 関数と違い、参照した瞬間に値が要るため。
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken() {
      throw new Error('spec 生成専用のスタブ: セッションは作らない');
    },
    post() {
      throw new Error('spec 生成専用のスタブ: 受信箱には積まない');
    },
    postPersisted() {
      throw new Error('spec 生成専用のスタブ: 受信箱には積まない');
    },
    dropQueuedInboxEvents() {
      throw new Error('spec 生成専用のスタブ: 配達の待ち行列は無い');
    },
    subscribe() {
      throw new Error('spec 生成専用のスタブ: 購読は無い');
    },
    endConversation() {
      throw new Error('spec 生成専用のスタブ');
    },
    answerApproval() {
      throw new Error('spec 生成専用のスタブ');
    },
    stop() {
      throw new Error('spec 生成専用のスタブ');
    },
  };

  const app = createApp({
    clone: stubClone,
    stores: createMemoryStores(),
    token: 'spec-generation',
    shutdown: () => undefined,
  });

  const response = await app.request('/openapi.json');
  return response.json();
}
