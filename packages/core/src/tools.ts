import { randomUUID } from 'node:crypto';

import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { describeArchiveRemovedBytesUnit } from './archive-removed-bytes.js';
import { codexChatgptAuthStatusOf, describeCodexChatgptAuth } from './codex-chatgpt-auth.js';
import { fallbackAttachmentCopiesDir, fetchAttachmentCopy } from './attachment-fetch.js';
import {
  ATTACHMENT_FROM_CLASSES,
  readAttachmentLimits,
  type AttachmentLimits,
} from './attachment.js';
import { putLocalFile } from './file-put.js';
import { deleteFile, describeAttachmentForJournal, keepFile, listFiles } from './file-tools.js';
import {
  checkAndBindOutboundAttachments,
  releaseOutboundAttachments,
  type OutboundAttachmentResult,
} from './outbound-attachments.js';
import {
  attachmentRefsOf,
  loadManagerAttachments,
  ManagerAttachmentsRefusedError,
} from './manager-attachments.js';

import {
  bySpeaker,
  conversationMessages,
  decodeConversationCursor,
  encodeConversationCursor,
  humanExchanges,
  InvalidConversationCursorError,
  reachedStart,
  readConversationPage,
  readConversationWindow,
  searchExchanges,
  type ConversationCursor,
  type ConversationPage,
} from './conversation.js';
import { describeMissingConversation, lookupConversation } from './conversation-lookup.js';
import {
  commitmentPosition,
  encodeCommitmentCursor,
  resolveCommitmentCursor,
} from './commitment-cursor.js';
import { isCronExpression } from './cron.js';
import { isRunningJobStatus } from './job-status-running.js';
import { journalWindowCrossesHorizon } from './journal-horizon.js';
import { filterTranscriptLines } from './transcript-filter.js';
import {
  describeOffsetRequiredTimeBoundary,
  describeUnreadableJournalTimeBoundary,
  isOffsetQualifiedTimeBoundary,
  isReadableJournalTimeBoundary,
  normalizeJournalTimeBoundary,
} from './journal-time.js';
import {
  compareManagerPosition,
  encodeManagerCursor,
  normalizeManagerCursorStatus,
  resolveManagerCursor,
  type ManagerPosition,
} from './manager-cursor.js';
import { encodeScheduleCursor, resolveScheduleCursor } from './schedule-cursor.js';
import {
  assertNeverRunnerLegStatus,
  describePidsSaturation,
  RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL,
} from './runner-protocol.js';
import { CGROUP_EVENTS_UNKNOWN_NOTE, formatCgroupEventsNote } from './cgroup-events.js';
import { formatSystemErrorFacts, SYSTEM_ERROR_UNKNOWN_NOTE } from './system-error.js';
import {
  classifyUnobservedOutcome,
  describeManagerState,
  describeSessionMissingKind,
  describeUnobservedOutcome,
  isManagerAwaitingJudgement,
  isManagerInFlight,
  isManagerOutcomeUnobserved,
  JUDGEMENT_RANK_NOT_APPLICABLE,
} from './digest.js';
import {
  approvalShape,
  describeDroppedTraceEmpty,
  describeDroppedTraceOrigin,
  describeDroppedTraceRetention,
  droppedTraceLedgerSince,
  journalEntryShape,
  noteDroppedRecord,
  noteUnreadableRecord,
  reasonOf,
  RECENT_TRACE_LIMIT,
  recentDroppedTraces,
} from './dropped-record.js';
import { collapseErrorCause } from './error-cause.js';
import { renderApprovalTrace, traceApproval } from './approval-trace.js';
import { stripNulDeep } from './nul-guard.js';
import { validatePermissionRequest } from './permission-rule.js';
import { encodeRunnerCursor, resolveRunnerCursor } from './runner-cursor.js';
import { encodeTokenCursor, resolveTokenCursor } from './token-cursor.js';
import {
  toAgentTokenView,
  tokenAvailabilityAt,
  type ActiveAgentToken,
  type CooldownSource,
} from './token-pool.js';
import { encodeUsageCursor, findUsageCursorTies, resolveUsageCursor } from './usage-cursor.js';
import {
  describePage,
  excerpt,
  excerptLine,
  fillListingBudget,
  page,
  renderListing,
  renderListingEntry,
  renderListingFromEnd,
} from './excerpt.js';
import { commandHeadWord, type RecentDenial } from './denial-shape.js';
import { classifyManagerActivity, describeReportDrift } from './manager-activity.js';
import type { ManagerActivityInput } from './manager-activity.js';
import {
  DEFAULT_PROGRESS_WINDOW_HOURS,
  InvalidProgressWindowError,
  readProgress,
} from './progress-read.js';
import { describeProgress } from './progress-describe.js';
import { describeGithubCi } from './progress-github.js';
import {
  ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
  ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
  selectArchiveRemovalTargets,
} from './archive-prune.js';
import type { ArchiveRemoveManyFilter } from './archive-prune.js';
import {
  describeDenialFollowUp,
  guardArchiveRemoval,
  tokenGenerationMismatched,
} from './manager.js';
import { describeTokenDiff } from './token-diff.js';
import type {
  ManagerDenial,
  ManagerPool,
  ManagerSummary,
  ManagerTranscript,
  ManagerUnpushedWork,
  RunnerBacklogSnapshot,
  RunnerFleetOverview,
  RunnerManagerEntry,
  RunnerPushOutcome,
  TokenGenerationUnknownReason,
} from './manager.js';
import { resolveMemoryCursor } from './memory-cursor.js';
import {
  applyMemoryFrontmatterPatch,
  assertNeverMemoryDocKind,
  assertNeverMemoryProtectionStatus,
  cutMemorySections,
  describeMemoryFloor,
  describeMemoryPremiseRanking,
  describeMemoryReinjectionEstimate,
  describeMemorySectionMoveHierarchyJumpWarning,
  describeMemorySessionDelta,
  describeMemoryWriteDiff,
  findMemoryFrontmatterLineBreak,
  findOverlappingMemorySections,
  formatMemoryCreatedAt,
  isKnownMemoryDocKind,
  lookupMemorySection,
  measureMemoryFloor,
  MEMORY_OUTLINE_SIDES,
  MEMORY_SECTION_MOVE_LIST_BUDGET,
  parseMemoryFrontmatter,
  renderMemoryDocuments,
  renderMemoryListing,
  renderMemoryOutline,
  resolveMemoryDocKind,
  scanMemorySections,
} from './memory.js';
import { stripNul } from './nul-guard.js';
import type { MemoryPart, MemorySection, MemorySectionLookup } from './memory.js';
import { redactProfileFailure } from './profile.js';
import { renderAccountList } from './account-list.js';
import { renderPermissionGrantList } from './permission-grant-list.js';
import {
  ProfileInputError,
  ProfileRollbackFailedError,
  type ApplyProfileResult,
  type ProfileService,
} from './profile-service.js';
import {
  RESERVED_SCHEDULE_KINDS,
  describeReservedScheduleKindEnvKeys,
  describeScheduleSpec,
  localDate,
  localDayRange,
  parseTimeOfDay,
} from './schedule.js';
import type { ScheduleStatus } from './schedule.js';
import {
  JOURNAL_ENTRY_TYPES,
  PERMISSION_GRANT_CONSENT_PHRASE,
  approvalQuestionSchema,
  approvalUpdatedAt,
  commitmentOriginSchema,
  commitmentUpdatedAt,
  externalOutputLimits,
  githubObservationInputSchema,
  jobStatusSchema,
  memorySlugSchema,
  practiceKindSchema,
  practiceSlugSchema,
  scheduleKindSchema,
  SCHEDULE_EVERY_MINUTES_MAX,
  scheduleSpecSchema,
} from './schema.js';
import type {
  AttachmentRef,
  ChatStreamEvent,
  Commitment,
  CommitmentOrigin,
  ExternalOutput,
  Job,
  JobStatus,
  JournalEntry,
  JournalEntryInput,
  LastUnpushedWorkObservation,
  MemoryDocKind,
  MemoryDocumentMeta,
  MemoryProtectionStatus,
  RescueRemovalReason,
  PendingApproval,
  Practice,
  ScheduleSpec,
  ScheduledRequest,
} from './schema.js';
import {
  describeQuestionLines,
  describeQuestionsViolation,
  summarizeQuestions,
} from './approval-choices.js';
import { describeRevisionStatus } from './revision.js';
import { describeManagerPeers } from './manager-peers-format.js';
import {
  CANON_REVISION,
  CLONE_RUNTIME_ITEM_LABELS,
  canonDocument,
  canonNames,
  describeCloneRuntime,
} from './self.js';
import type { CloneRuntimeFacts } from './self.js';
import {
  EXCHANGE_WITH_VALUES,
  JournalAnchorNotFoundError,
  UnreadableActiveTokenError,
  UnreadableApprovalError,
  UnreadableCommitmentError,
  UnreadableJournalEntryError,
  UnreadablePracticeError,
  UnreadableScheduleError,
  UnreadableTokenSettingsError,
  describeUnreadableApprovals,
  describeUnreadableInboxEvents,
  describeUnreadableCommitment,
  describeUnreadableJobs,
  describeUnreadableManagerRow,
  describeUnreadablePractices,
  describeUnreadableScheduleEdit,
  describeUnreadableSchedules,
  describeUnreadableTokens,
} from './store.js';
import {
  MemoryConflictError,
  memoryVersion,
  PracticeConflictError,
  practiceVersion,
  PROFILE_ENTRY_NAME,
} from './store.js';
import type { ArchiveEntry, InboxPeek, JournalStore, Stores } from './store.js';
import {
  RESTART_BEFORE_CHECK_ADVICE,
  STALE_TOKEN_RESTART_ADVICE,
  limitRecoveryOf,
  limitRecoveryOfAssistantError,
  withRecoveryNote,
} from './usage-limits.js';
import {
  CLONE_REMOVABLE_INBOX_EVENT_TYPES,
  describeHumanOriginatedInboxAlert,
  describeInboxBacklogBreakdown,
  describeInboxBacklogQueuedInMemory,
  describeNoReadableInboxEvents,
  inboxRemoveManyTypesSchema,
  matchesInboxRemoveManyFilter,
  removeInboxEventsAndStopDelivery,
  summarizeInboxBacklog,
} from './inbox-backlog.js';
import type { InboxRemoveManyFilter } from './inbox-backlog.js';
import type { AccountUsageState } from './usage-snapshot.js';
import {
  ACCOUNT_USAGE_TITLE,
  describeAccountUsage,
  describeUnreadableUsage,
  describeUnreadableUsageRows,
  describeUnmeteredUsage,
  describeUnrecordedManagers,
  describeUsageDateOrder,
  describeWebSearchRequests,
  findUnrecordedManagers,
  formatUsd,
  isRealUsageDate,
  summarizeUsage,
  usageLayerSchema,
  usageSiteSchema,
  type UsageAggregate,
  type UsageBreakdown,
  type UsageRow,
  type UsageTotals,
} from './usage.js';
import { JOURNAL_SEARCH_UNCOVERED_LIST } from './journal-search.js';
import { describeManagerFoldCandidate } from './manager-fold-candidate.js';
import { describeManagerModels, managerModelsOf } from './manager-models.js';
import {
  describeUnpushedWorkObservationIncompleteness,
  describeUnpushedWorkObservationProvenance,
  describeUnpushedWorkObservationSource,
  isEmptyCompleteUnpushedWorkObservation,
  UNPUSHED_WORK_SHUTDOWN_OBSERVATION_NOT_ARRIVED_NOTE,
} from './unpushed-work-observation-format.js';
import { RESCUE_NOT_PUSHED_TEXT, rescueNotPushedDetail } from './workspace-swap-hints.js';

const MISSING_ARG_HINT =
  '引数が届いていない（received undefined ＝ 呼び出しの JSON にその鍵が最初から無かった。道具が受け取ってから落としたのではない）。書いたつもりなら、まず呼び出しの生の形を疑うこと —— タグの接頭辞の脱落など、呼び出しの組み立てが壊れていると引数は静かに落ちる。決定的な対照: 引数の並びも長さも1文字も変えず、タグだけ正しく書いて1回送り直す。それで通れば、原因は呼び出しの形であって、この道具でも引数の中身でもない';

// `.describe()` を貼り直す: `clone()` で説明が落ち、モデルが読む道具の意味が削れるため
function withMissingArgHint<Shape extends object>(shape: Shape): Shape {
  const hinted = Object.entries(shape).map(([key, value]) => {
    const schema = value as z.ZodTypeAny & { _zod?: { def?: object } };
    const def = schema?._zod?.def;
    if (!def || typeof schema.clone !== 'function') return [key, value];
    const cloned = schema.clone({
      ...def,
      error: (iss: { input?: unknown }) => (iss.input === undefined ? MISSING_ARG_HINT : undefined),
    } as never);
    return [key, schema.description === undefined ? cloned : cloned.describe(schema.description)];
  });
  return Object.fromEntries(hinted) as Shape;
}

const tool: typeof sdkTool = (name, description, inputSchema, handler, extras) =>
  sdkTool(name, description, withMissingArgHint(inputSchema), handler, extras);

export const MCP_INPUT_VALIDATION_ERROR_MARKER =
  'Input validation error: Invalid arguments for tool ';

export interface McpInputValidationFailure {
  readonly message: string;
  readonly fields: readonly string[];
}

// 形を決め打ちしない: `tool_response` は SDK の型で `unknown` であり、文字列化して印を探すだけにする
export function detectMcpInputValidationFailure(
  toolResponse: unknown,
): McpInputValidationFailure | undefined {
  const message = stringifyToolResponseForValidationCheck(toolResponse);
  if (!message.includes(MCP_INPUT_VALIDATION_ERROR_MARKER)) return undefined;
  const fields = [...new Set(extractValidationFields(message))];
  return { message, fields };
}

function extractValidationFields(message: string): string[] {
  // バックスラッシュを剥がしてから読む: オブジェクト経由だと本文が二重に JSON.stringify されて引用符がエスケープされるため
  const normalized = message.replace(/\\(.)/g, '$1');
  const fromDotPath = [...normalized.matchAll(/ at ([A-Za-z0-9_$.[\]]+)/g)].map(
    (match) => match[1]!,
  );
  const fromJsonPath: string[] = [];
  for (const pathMatch of normalized.matchAll(/"path"\s*:\s*\[([^\]]*)\]/g)) {
    const inner = pathMatch[1] ?? '';
    for (const stringMatch of inner.matchAll(/"([^"]*)"/g)) {
      fromJsonPath.push(stringMatch[1]!);
    }
  }
  return [...fromDotPath, ...fromJsonPath];
}

// 例外を投げない: `PostToolUse` フックで毎回呼ばれ、循環参照で道具の実行を巻き込まないため
function stringifyToolResponseForValidationCheck(toolResponse: unknown): string {
  if (typeof toolResponse === 'string') return toolResponse;
  try {
    return JSON.stringify(toolResponse) ?? '';
  } catch {
    return '';
  }
}

export const MCP_SERVER_NAME = 'alteroid';

/** いまのターンの返信に添える添付の口（`reply_attach`。Issue #4126）。 */
export interface ReplyAttachments {
  /** このターンの返信にすでに添えた控え（個数・合計は新しい分と合わせて数える）。 */
  current(): readonly AttachmentRef[];
  /** 返信に添える。会話の SSE へ `attachments` を流し、返信の日誌の `exchange` に載せる。 */
  add(refs: readonly AttachmentRef[]): void;
}

export interface ToolContext {
  stores: Stores;
  emit(event: ChatStreamEvent): void;
  flushReply?(): Promise<void>;
  // optional にしない: 渡し忘れが型検査を通り、承認が黙って会話に紐づかなくなるため
  conversationId: () => string | undefined;
  /**
   * いまのターンの仕事が属する会話（issue #4210）。会話のあるターンでは `conversationId` と同じで、内部ターンでは
   * 委譲の起点（マネージャーからの一件なら、その委譲の `Job.conversationId`）。`manager_start` の起点と、
   * `ask_human` / `request_permission` が積む承認の会話に写す。返信の宛先（`conversationId`）とは別である。
   */
  // optional にする: 無い器（テストの ToolContext）は従来どおり `conversationId` だけを見る。クローン本体は必ず渡す
  workConversationId?: () => string | undefined;
  recentDenials?: () => readonly RecentDenial[];
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
  runtime?: () => CloneRuntimeFacts;
  runnerModels?: () => Promise<readonly string[]>;
  /** 接続中の runner が名乗った SDK の接続先とモデルの別名の行（#4263・#4261）。 */
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

const MANAGER_ATTACHMENTS_DESCRIPTION =
  '人間の添付を担い手にも見せたいときに、その添付の id（通知行の id=… / conversation_read の添付行）を渡す。' +
  '渡したものは担い手の手元にファイルとして置かれ（通知行にパスが付くので Read で開ける）、画像は画像としても見える。' +
  '渡さない添付は担い手には見えない。**記憶には写らない**（日誌に残るのは渡した添付の参照だけで、中身は残らない）。' +
  '見つからない添付（保持期限切れ・id の誤り）があれば、何も送らずにエラーを返す。個数・合計には人間の発言と同じ上限がある。' +
  '確認への回答（requestId / decision）には載せられない。';

export function qualifiedToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

// モデルの引数からは受けない: 名乗りを引数に任せると「誰の観測か」が申告の申告になるため
export const GITHUB_OBSERVATION_CLONE_OBSERVER = 'clone';

export const CLONE_TOOL_NAMES = [
  'memory_list',
  'memory_read',
  'memory_write',
  'memory_append',
  'memory_delete',
  'memory_frontmatter_set',
  'memory_outline',
  'memory_section_read',
  'memory_section_move',
  'journal_write',
  'journal_read',
  'conversation_read',
  'attachment_fetch',
  'file_put',
  'file_list',
  'file_keep',
  'file_delete',
  'reply_attach',
  'conversation_post',
  'ask_human',
  'request_permission',
  'approvals_list',
  'approval_trace',
  'approval_withdraw',
  'daily_report_write',
  'usage_read',
  'schedule_list',
  'schedule_create',
  'schedule_remove',
  'commitment_list',
  'commitment_open',
  'commitment_close',
  'commitment_close_many',
  'commitment_edit',
  'progress_read',
  'github_observation_record',
  'inbox_remove_many',
  'profile_read',
  'profile_write',
  'profile_remove',
  'practice_list',
  'practice_read',
  'practice_history',
  'practice_write',
  'practice_remove',
  'token_list',
  'permission_grant_list',
  'account_list',
  'self_read',
  'self_status',
  'self_dropped',
  'manager_start',
  'manager_send',
  'manager_stop',
  'manager_list',
  'manager_report',
  'manager_transcript',
  'archive_remove',
  'archive_remove_many',
  'runner_list',
] as const;

export type CloneToolName = (typeof CLONE_TOOL_NAMES)[number];

export const SELF_JOURNALING_CLONE_TOOLS = [
  'github_observation_record',
  'memory_write',
  'memory_append',
  'memory_delete',
  'memory_frontmatter_set',
  'memory_section_move',
  'journal_write',
  'conversation_post',
  'ask_human',
  'request_permission',
  'approval_withdraw',
  'daily_report_write',
  'schedule_create',
  'schedule_remove',
  'commitment_open',
  'commitment_close',
  'commitment_close_many',
  'commitment_edit',
  'inbox_remove_many',
  'profile_write',
  'profile_remove',
  'practice_write',
  'practice_remove',
  'manager_start',
  'manager_send',
  'manager_stop',
  'archive_remove',
  'archive_remove_many',
  'file_delete',
] as const satisfies readonly CloneToolName[];

export const TRACELESS_CLONE_TOOLS = [
  'memory_list',
  'memory_read',
  'memory_outline',
  'memory_section_read',
  'journal_read',
  'conversation_read',
  'attachment_fetch',
  'file_put',
  'file_list',
  'file_keep',
  'reply_attach',
  'approvals_list',
  'approval_trace',
  'usage_read',
  'schedule_list',
  'commitment_list',
  'progress_read',
  'profile_read',
  'practice_list',
  'practice_read',
  'practice_history',
  'token_list',
  'permission_grant_list',
  'account_list',
  'self_read',
  'self_status',
  'self_dropped',
  'manager_list',
  'manager_report',
  'manager_transcript',
  'runner_list',
] as const satisfies readonly CloneToolName[];

type SelfJournalingCloneTool = (typeof SELF_JOURNALING_CLONE_TOOLS)[number];
type TracelessCloneTool = (typeof TRACELESS_CLONE_TOOLS)[number];

type AssertTrue<T extends true> = T;

export type _AssertCloneToolPartitionIsExhaustive = AssertTrue<
  [Exclude<CloneToolName, SelfJournalingCloneTool | TracelessCloneTool>] extends [never]
    ? true
    : false
>;

export type _AssertCloneToolPartitionIsExclusive = AssertTrue<
  [Extract<SelfJournalingCloneTool, TracelessCloneTool>] extends [never] ? true : false
>;

const SELF_JOURNALING_CLONE_TOOL_NAMES: ReadonlySet<string> = new Set(
  SELF_JOURNALING_CLONE_TOOLS.map((name) => qualifiedToolName(name)),
);

// 名簿に無い道具は false（日誌に残す側）へ倒す: 記録が重複するほうが静かに消えるより軽いため
export function cloneToolJournalsItself(tool: string): boolean {
  return SELF_JOURNALING_CLONE_TOOL_NAMES.has(tool);
}

// 迷ったら true（秘密を運ぶ側）へ倒す: false の誤りは鍵が日誌と要約に写って取り返しが付かないため
const SELF_JOURNALING_TOOL_CARRIES_SECRETS: Record<SelfJournalingCloneTool, boolean> = {
  memory_write: false,
  memory_append: false,
  memory_delete: false,
  memory_frontmatter_set: false,
  memory_section_move: false,
  journal_write: false,
  conversation_post: false,
  ask_human: false,
  request_permission: false,
  approval_withdraw: false,
  daily_report_write: false,
  schedule_create: false,
  schedule_remove: false,
  commitment_open: false,
  commitment_close: false,
  commitment_close_many: false,
  commitment_edit: false,
  inbox_remove_many: false,
  profile_write: true,
  profile_remove: false,
  practice_write: false,
  practice_remove: false,
  manager_start: false,
  manager_send: false,
  manager_stop: false,
  archive_remove: false,
  archive_remove_many: false,
  // 名前・種類・大きさ・sha256 だけを書く（中身は書かない。資格のファイルはそもそも置き場へ入れない）
  file_delete: false,
  github_observation_record: false,
};

const SECRET_BEARING_CLONE_TOOL_NAMES: ReadonlySet<string> = new Set(
  (Object.keys(SELF_JOURNALING_TOOL_CARRIES_SECRETS) as SelfJournalingCloneTool[])
    .filter((name) => SELF_JOURNALING_TOOL_CARRIES_SECRETS[name])
    .map((name) => qualifiedToolName(name)),
);

export function cloneToolCarriesSecrets(tool: string): boolean {
  return SECRET_BEARING_CLONE_TOOL_NAMES.has(tool);
}

const LIST_REQUEST_EXCERPT = 160;
const LIST_REPORT_EXCERPT = 240;
// `LIST_REPORT_EXCERPT` を使い回さない: 値が同じ桁でも、片方だけ直したくなったときに一緒に動くため
const LIST_TURN_END_TAIL_EXCERPT = 160;
// `LIST_REPORT_EXCERPT` を使い回さない: 用途ごとに別に置く
const MANAGER_STOP_FOLDED_TURN_EXCERPT = 240;
// runner 側のキャップを根拠にしない: `AskUserQuestion` は `brief` を通らないため、出す側で締める
const LIST_WAITING_EXCERPT = 200;
const LIST_BUDGET = 8_000;
const MANAGER_WAITING_LIST_LIMIT = 10;
const LIST_DENIED_TOOLS = 3;
const LIST_TOOL_USE_STALL_LIMIT = 3;

type ManagerWaitingItem = ManagerSummary['waiting'][number];

// 二択へ畳まない: 旧 runner の応答には `kind` が乗らず、「実行許可」と嘘をつくとクローンが質問に許可／拒否で答えるため
function describeWaitingKind(kind: ManagerWaitingItem['kind']): string {
  if (kind === 'question') return '質問';
  if (kind === 'permission') return '実行許可';
  return '種別不明';
}

function describeJournalContinuation(cursor: { id: string; at: string }): string {
  return (
    `続きは journal_read afterId=${cursor.id} afterAt=${cursor.at}` +
    ' （ほかの絞りは同じものを渡す）'
  );
}

// 無いときは `-` 等で埋めない: 取れない軸に意味の決まった値を作らないため
function describeAskedAt(askedAt: ManagerWaitingItem['askedAt']): string {
  return askedAt === undefined ? '' : `${askedAt} から`;
}

// 「未処理の合図は無い」は、器の行も読めない行もメモリの待ち行列も0件のときにしか言わない
function describeInboxBacklog(
  peek: InboxPeek,
  now: number,
  queuedInMemory: number | undefined,
): string {
  const rows = peek.entries;
  const queuedLine = describeInboxBacklogQueuedInMemory(queuedInMemory);
  const noReadable = describeNoReadableInboxEvents(peek.unreadable);
  if (rows.length === 0 && noReadable !== null) {
    return queuedLine === null ? noReadable : `${noReadable}\n${queuedLine}`;
  }
  if (rows.length === 0) {
    if (queuedLine === null) return 'クローンの受信箱に未処理の合図は無い。';
    return `器の行に未処理の合図は無い（メモリの配達待ち行列は別の軸——下）。\n${queuedLine}`;
  }
  const breakdown = summarizeInboxBacklog(rows, now, peek.unreadable);
  const oldest =
    breakdown.oldestAt === undefined ? '' : `（最も古いものは ${breakdown.oldestAt} から）`;
  const humanOriginatedAlert = describeHumanOriginatedInboxAlert(breakdown);
  const humanOriginatedLine = humanOriginatedAlert === '' ? '' : `${humanOriginatedAlert}\n`;
  const queuedSuffix = queuedLine === null ? '' : `\n${queuedLine}`;
  return (
    `${humanOriginatedLine}` +
    `⚠ クローンの受信箱に未処理の合図が ${breakdown.total} 件ある${oldest}\n` +
    describeInboxBacklogBreakdown(breakdown) +
    queuedSuffix
  );
}

// 「いつ観測できた値か」を必ず添える: キャッシュを現在値と取り違えさせないため
// 「未報告」と言わない: `pendingEvents` は Outbox へ積み済みでデーモンへ未達の件数のため
function describeRunnerBacklog(snapshots: readonly RunnerBacklogSnapshot[]): string | null {
  const lines = snapshots
    .filter((snapshot) => snapshot.pendingEvents > 0)
    .map((snapshot) => {
      const oldest =
        snapshot.oldestPendingAt === undefined
          ? ''
          : `（最も古いものは ${snapshot.oldestPendingAt} から）`;
      return (
        `⚠ runner ${snapshot.runnerId} に未送出の出来事が ${snapshot.pendingEvents} 件ある${oldest}。` +
        `これは ${snapshot.observedAt} 時点に取った値で、いまの値ではない` +
        '（identity() を持つ runner なら10秒ごとの生存確認でも自動で更新されるが、' +
        'それでも「いまの値」ではない。すぐ最新が要るなら runner_list を resources: true で呼び直す）。' +
        ` ${describeRunnerLegState(snapshot)}`
      );
    });
  return lines.length === 0 ? null : lines.join('\n');
}

// `instanceSwapped` を先に見る: 脚が 'connected' でも新しい器との接続で、滞留を持っていた古い器とは別物のため
function describeRunnerLegState(snapshot: RunnerBacklogSnapshot): string {
  if (snapshot.instanceSwapped === true) {
    return (
      'もう来ない（この滞留を観測した後に器が入れ替わった。runner の Outbox は' +
      'プロセスのメモリだけなので、溜まっていた分は配られずに消えている——' +
      '生ログから拾うしかない）'
    );
  }
  const leg = snapshot.legState;
  if (leg === undefined) {
    return '判定できない（この runner は脚の状態を報告しない、またはいま名簿に居ない）';
  }
  switch (leg.status) {
    case 'connected': {
      // 閾値で「死んでいる」を判定しない: 判定を足すと静かに間違える判定を作るため
      const lastByteAt =
        leg.lastByteAt === undefined
          ? '開いてから1バイトも受け取っていない'
          : `最後にバイトを受け取ったのは ${leg.lastByteAt}`;
      return (
        'まだ届いていない。届く見込みがある' +
        `（脚は繋がっている。待ってよい。${leg.since} から、${lastByteAt}）`
      );
    }
    case 'down': {
      const detail = [
        leg.since === undefined ? undefined : `${leg.since} から`,
        leg.lastFailureReason === undefined ? undefined : `直近の理由: ${leg.lastFailureReason}`,
        leg.nextRetryAt === undefined ? undefined : `次の再試行: ${leg.nextRetryAt}`,
      ].filter((part): part is string => part !== undefined);
      const detailSuffix = detail.length === 0 ? '' : `（${detail.join('、')}）`;
      return `⚠ 再接続するまで1件も届かない${detailSuffix}`;
    }
    case 'never-connected':
      return '⚠ 再接続するまで1件も届かない（このデーモンが起きてから一度も繋がっていない）';
    default:
      return assertNeverRunnerLegStatus(leg);
  }
}

// ネットワークを叩かない: `runnerBacklog()` のキャッシュとストアの読み出しだけで言い分ける
// `describeRunnerLegState` を再利用する: 同じ判定を2箇所へ書くと字面が割れるため
async function describeTranscriptMissingLeg(pool: ManagerPool, managerId: string): Promise<string> {
  const runnerId = await pool.runnerIdOf(managerId);
  if (runnerId === undefined) {
    return (
      '判定できない（この委譲に runner が割り当てられたことを、走行中の像・' +
      '台帳のどちらからも確認できない —— 一度も割り当てられなかったのか、' +
      'id 自体が存在しないのかは、この応答だけでは区別できない）。'
    );
  }

  const snapshot = pool.runnerBacklog().find((entry) => entry.runnerId === runnerId);
  if (snapshot === undefined || snapshot.pendingEvents === 0) {
    return (
      `判定できない（runner ${runnerId} について、生ログが無い理由と結び付けられる` +
      '未送出の滞留を観測できていない。滞留が実際に0件だったのか、まだ一度も' +
      '観測していないだけなのかは、この応答だけでは区別できない）。'
    );
  }

  const prefix =
    snapshot.instanceSwapped === true
      ? '引き渡せずに消えた可能性が高い。'
      : 'まだ引き渡していない可能性がある（この生ログもその中に含まれるかは' + '分からない）。';

  return (
    `${prefix} runner ${runnerId} について ${snapshot.observedAt} 時点で観測できた` +
    `未送出の出来事: ${snapshot.pendingEvents} 件（内訳は runner から届いていないので` +
    `不明——archive が含まれていたかもここからは言えない）。${describeRunnerLegState(snapshot)}`
  );
}

const REPORT_PAGE = 8_000;

// `REPORT_PAGE` と同じ値でも使い回さない: 意味が違い、片方だけ直したくなったときに一緒に動くため
const TRANSCRIPT_PAGE = 8_000;

// 全行を JSON.parse しない: 生ログは MB 級になりうるため末尾からこの文字数だけ見る
const REPORT_GENERATED_PROBE_CHARS = 200_000;

interface LastAssistantUtterance {
  timestamp: string | undefined;
  length: number;
  // 本文があっても終わったとは限らない: 道具を挟む前の語りも `type: 'text'` で、`stop_reason` は `tool_use` になる
  stopReason: string | undefined;
}

type AssistantUtteranceProbe =
  { kind: 'found'; utterance: LastAssistantUtterance } | { kind: 'empty' } | { kind: 'truncated' };

// 判定はしない: 見つけたことと、そのターンが終わっていることは別の軸のため `stopReason` を添えて返す
function probeLastAssistantUtterance(transcript: string): AssistantUtteranceProbe {
  const truncated = transcript.length > REPORT_GENERATED_PROBE_CHARS;
  const tail = truncated ? transcript.slice(-REPORT_GENERATED_PROBE_CHARS) : transcript;
  const rawLines = tail.split('\n');
  const lines = truncated ? rawLines.slice(1) : rawLines;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const record = entry as {
      type?: unknown;
      isSidechain?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown; stop_reason?: unknown };
    };
    if (record.type !== 'assistant') continue;
    if (record.isSidechain === true) continue;
    const body = rawAssistantText(record.message?.content);
    if (body.length === 0) continue;
    return {
      kind: 'found',
      utterance: {
        timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
        length: body.length,
        stopReason:
          typeof record.message?.stop_reason === 'string' ? record.message.stop_reason : undefined,
      },
    };
  }
  return truncated ? { kind: 'truncated' } : { kind: 'empty' };
}

function rawAssistantText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// 読めなかったことを「無い」に潰さない
async function describeMissingReport(
  managers: ManagerPool,
  managerId: string,
  status: ManagerSummary['status'],
): Promise<string> {
  const base = `マネージャー ${managerId} からの報告はまだ無い（状態: ${status}）。`;
  let result: ManagerTranscript;
  try {
    result = await managers.transcript(managerId);
  } catch (error) {
    return (
      `${base} 生ログは読めなかった（` +
      reasonOf(error) +
      '）。「まだ書いていない」か「書いたのに届いていない」かは、これだけでは判定できない。'
    );
  }
  if (result.kind === 'removed') {
    // `missing` に畳まない: 退避はあったが本文が落とされており、「まだ書いていない」とも「読めなかった」とも別の状態のため
    return (
      `${base} 生ログは退避されていたが本文が消されている` +
      `（${result.removedAt} に ${result.bytes.toLocaleString('ja-JP')} バイトを落とした${describeArchiveRemovedBytesUnit()}。` +
      `archive id: ${result.archiveId}）。現物は確かめられない。`
    );
  }
  if (result.kind === 'unreadable') {
    return `${base} 生ログは読みに行けなかった。${result.detail}`;
  }
  if (result.kind === 'missing' || result.body.length === 0) {
    return (
      `${base} 生ログにも本文は無い` +
      '（走行中の runner のディスク・退避済みアーカイブ・預かった生ログ、3段のどこにも見当たらなかった）。'
    );
  }
  const transcript = result.body;

  const outcome = probeLastAssistantUtterance(transcript);
  if (outcome.kind === 'empty') {
    return `${base} 生ログにも本文は無い（生ログ全体を見た）。`;
  }
  if (outcome.kind === 'truncated') {
    return (
      `${base} 生ログの末尾 ${REPORT_GENERATED_PROBE_CHARS.toLocaleString('ja-JP')} 文字を遡ったが、` +
      'マネージャー自身の発言（本文つき）は見つからなかった。' +
      'それより前は見ていないので「無い」とは言い切れない——' +
      `manager_transcript managerId=${managerId} で自分で遡って確かめられる。`
    );
  }

  const { timestamp, length, stopReason } = outcome.utterance;
  const when = timestamp ?? '時刻不明（生ログの行に timestamp が無かった）';
  const resumeOffset = Math.max(0, transcript.length - TRANSCRIPT_PAGE);
  const state = `（状態: ${status}）`;
  const found = `生ログには ${when} に本文が在る（約 ${length.toLocaleString('ja-JP')} 文字）`;
  const howToDigIn =
    `manager_transcript managerId=${managerId} offset=${resumeOffset} で読める` +
    '（作業者の発言は除いて探したが、混ざる余地が完全に無いとまでは確認していない）。';

  // 3つに割る: 「終わっていないと分かった」と「分からなかった」を1つに畳まない
  if (stopReason === 'end_turn') {
    return (
      `⚠ マネージャー ${managerId} からの報告としては届いていない${state}が、${found}。` +
      `＝ 生成されたが配られていない（#323）。${howToDigIn}`
    );
  }
  if (stopReason !== undefined) {
    return (
      `マネージャー ${managerId} からの報告はまだ無い${state}。${found}が、そのターンはまだ終わっていない` +
      `（stop_reason=${stopReason}）。＝ まだ書き終えていない側である。${howToDigIn}`
    );
  }
  return (
    `マネージャー ${managerId} からの報告はまだ無い${state}。${found}が、そのターンが終わっているかを判定できなかった` +
    `（行に stop_reason が無い）。${howToDigIn}`
  );
}

const COMMITMENT_LIST_BUDGET = 8_000;
const COMMITMENT_BODY_LIMIT = 240;
const UNREADABLE_COMMITMENT_IDS_SHOWN = 20;
const CLOSE_MANY_LIMIT_DEFAULT = 500;
// store 側に同じ上限を置いて二重にしない: どちらが効いたのか呼び出し側から読めなくなるため
export const CLOSE_MANY_LIMIT_MAX = 2_000;
// id 列は件数ではなく文字数の予算で塊に割り、塊ごとに1件の日誌を書く: 全件を1行へ詰めると予算が文字数という面の規約に反するため
export const CLOSE_MANY_JOURNAL_ID_CHARS = 3_600;
const CLOSE_MANY_IDS_SHOWN = 20;
const CLOSE_MANY_SOURCES_SHOWN = 8;
import { REMOVE_MANY_LIMIT_DEFAULT, REMOVE_MANY_LIMIT_MAX } from './remove-many-limit.js';

export { REMOVE_MANY_LIMIT_DEFAULT, REMOVE_MANY_LIMIT_MAX };
export const REMOVE_MANY_JOURNAL_ID_CHARS = 3_600;
const REMOVE_MANY_IDS_SHOWN = 20;
// HTTP 層と共有しない: `POST /archive/remove` は `removedIds` を全件返し、間引きはテキスト応答だけの関心事のため
const ARCHIVE_REMOVE_MANY_IDS_SHOWN = 20;
const PROFILE_DISTRIBUTION_EXCERPT = 400;
// `body` は切って捨てず `page()` で分けて渡す: 要約を禁じられた欄で構造的に長くなりうるため
const COMMITMENT_PAGE = 8_000;

const COMMITMENT_ORIGIN_LABEL: Record<CommitmentOrigin, string> = {
  human: '人間の依頼',
  manager: 'マネージャーの報告',
  external: '外部イベント',
  self: '自分で気づいた宿題',
};

// id は1つも落とさない: 1つの id だけで予算を超えても単独の塊として返す（予算のほうを譲る）
export function chunkIdsByChars(ids: readonly string[], budget: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let width = 0;
  for (const id of ids) {
    const added = current.length === 0 ? id.length : id.length + 1;
    if (current.length > 0 && width + added > budget) {
      chunks.push(current);
      current = [];
      width = 0;
    }
    current.push(id);
    width += current.length === 1 ? id.length : added;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function commitmentOriginBadge(entry: { origin: CommitmentOrigin; source?: string }): string {
  const label = COMMITMENT_ORIGIN_LABEL[entry.origin];
  return entry.source === undefined ? `[${label}]` : `[${label} / ${entry.source}]`;
}

// 本文を薄くして件数を残す: 日誌は特定の時刻の1行を探すために引き、全文は `id` で取りに行けるため
const JOURNAL_TEXT_EXCERPT = 120;
const JOURNAL_BUDGET = 8_000;
// 一覧の見出しに出す添付の数。超えた分は「ほか N 件」にする
const JOURNAL_LISTING_ATTACHMENTS = 5;
const JOURNAL_PAGE = 8_000;

// クローンが書いた「根拠なし」と同じ文字列にしない: 日誌を読む人間が「根拠を持たずに実行した」と「根拠が記録経路から落ちた」を区別できなくなるため
export const GROUNDS_NOT_DELIVERED =
  '（根拠は記録されていない —— 呼び出しに grounds が届かなかった。' +
  'クローンが「根拠なし」と書いたのではない。issue #1338）';

const APPROVAL_LIST_BUDGET = 8_000;
// `APPROVAL_LIST_BUDGET` を使い回さない: 由来が違い、「ふつう数本だから溢れない」を根拠にすると外れたときに一覧が丸ごと使えなくなるため
const TOKEN_LIST_BUDGET = 6_000;
const TOKEN_REASON_EXCERPT = 200;
// `unrecorded` を鍵に持つ: 「出所が無い」は取れなかったことで、`default`（推測）に潰すと嘘になるため
const TOKEN_COOLDOWN_SOURCE_LABEL: Record<CooldownSource | 'unrecorded', string> = {
  quota_reset: '枠の resetsAt（権威ある値）',
  overage_reset: '課金枠の overageResetsAt（権威ある値。枠そのものではない）',
  notice_text: '**上限の文言に書かれていた時刻（推測。ただし既定よりは良い）**',
  default: '**設定の既定（ただの推測）**',
  unrecorded: '記録が無い',
};
const APPROVAL_QUESTION_EXCERPT = 200;
function describeUnreadableApproval(id: string): string {
  return `承認待ち ${id} は在るが読めない（壊れた行。消されたのではない。id は合っている）。行は書き換えていない。`;
}
function describeUnreadableJournalEntry(label: string, id: string): string {
  return `${label} ${id} は在るが読めない（形が合わない壊れた行。無いのではなく、id は合っている）。行は書き換えていない。`;
}
const APPROVAL_PAGE = 8_000;
// `APPROVAL_LIST_BUDGET` と値が同じでも使い回さない: 片方だけ直したくなったとき一緒に動くため
const APPROVAL_TRACE_BUDGET = 8_000;
const APPROVAL_TRACE_SUMMARY_EXCERPT = 200;

const APPROVAL_TITLE_EXCERPT = 60;

function approvalTitle(question: string): string {
  const firstLine = (question.split('\n', 1)[0] ?? '').trim();
  // 空の札を出さない: 空欄は「名前が無い」のか「取り忘れ」なのか区別できないため、1行目が空なら全体を潰した抜粋へ落とす
  return excerpt(
    firstLine === '' ? question.replace(/\s+/g, ' ').trim() : firstLine,
    APPROVAL_TITLE_EXCERPT,
  );
}

const SCHEDULE_LIST_BUDGET = 8_000;
const SCHEDULE_REQUEST_EXCERPT = 200;
const SCHEDULE_PAGE = 8_000;

// 取れないときも黙って行を消さない: scheduler が渡っていない（配線の欠落）と未反映（一時的）を文言で分ける
function scheduleNextAtOf(context: ToolContext, kind: string): string {
  if (context.scheduler === undefined) return '（取れない — scheduler が渡っていない）';
  const status = context.scheduler().find((entry) => entry.kind === kind);
  return status === undefined ? '（まだ計算されていない。少し待って呼び直すこと）' : status.nextAt;
}

// `LIST_BUDGET` を使い回さない: 値が同じでも、片方だけ直したくなったときに一緒に動くため
const RUNNER_LIST_BUDGET = 8_000;
const RUNNER_MANAGER_LIST_LIMIT = 20;
// `LIST_BUDGET` / `RUNNER_LIST_BUDGET` を使い回さない: 同じ理由
const PRACTICE_LIST_BUDGET = 8_000;
const RUNNER_CREDENTIAL_FINGERPRINT_EXCERPT = 400;

// 名簿を読めなければ黙って省く: `self_status` の本題を、器の名簿の失敗で落とさないため
export async function renderPeerReach(managers: ManagerPool | undefined): Promise<string[]> {
  if (managers === undefined) return [];
  let overview: RunnerFleetOverview;
  try {
    overview = await managers.runners();
  } catch {
    return [];
  }
  const rows: { label: string; line: string }[] = [];
  for (const runner of overview.runners) {
    const line = describeManagerPeers(runner.managerPeers);
    if (line === undefined) continue;
    rows.push({ label: runner.runnerId ?? runner.label, line });
  }
  if (rows.length === 0) return [];
  return [
    '',
    // 開いている器と、閉じている器（理由つき）を並べる: ログイン済みなのに開いていない器を見せるため（#4118）
    'マネージャーが peer（Codex など）に作業を頼めるか（器ごと。頼める器は manager_start の runnerId で名指しできる。詳細は runner_list）:',
    renderListing(
      rows.map((row) => `- ${row.label}: ${excerptLine(row.line, RUNNER_MANAGER_PEERS_EXCERPT)}`),
      {
        budget: SELF_STATUS_PEER_REACH_BUDGET,
        omitted: ({ rest, shown, total }) =>
          `…ほか ${rest} 台は省略（全 ${total} 台のうち ${shown} 台だけ出した。runner_list で全部見える）。`,
      },
    ),
  ];
}

const SELF_STATUS_PEER_REACH_BUDGET = 1600;

const RUNNER_MANAGER_PEERS_EXCERPT = 400;

// `formatElapsed` と共通化しない: 分の位まで丸めると、ゾンビが何時間経っているかが見えなくなるため
function describeZombieAge(seconds: number): string {
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) return `${hours}時間${remainderMinutes}分前`;
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return `${days}日${remainderHours}時間前`;
}

function describeAgeBucketLabel(upToSec: number | undefined): string {
  switch (upToSec) {
    case 60:
      return '1分未満';
    case 600:
      return '10分未満';
    case 3600:
      return '1時間未満';
    case 21600:
      return '6時間未満';
    default:
      return upToSec === undefined ? 'それ以上' : `${upToSec}秒未満`;
  }
}

const MEMORY_PAGE = 8_000;
const CANON_PAGE = 8_000;
const PROFILE_PAGE = 8_000;
// 本文は一覧に載せない: 鍵が入っているので、名前を指して取りに来たときだけ出す
const PROFILE_LIST_BUDGET = 6_000;

// 他の一覧と定数を共有しない: 片方だけ直したくなったときに一緒に動かないため
const SELF_DROPPED_BUDGET = 8_000;
const SELF_DROPPED_DEFAULT_LIMIT = 50;

// `JOURNAL_*` を使い回さない: 値は同じでも探す対象（会話の1発言）が違うため
const CONVERSATION_EXCHANGE_EXCERPT = 200;
const CONVERSATION_LIST_BUDGET = 8_000;
const CONVERSATION_PAGE = 8_000;

/**
 * ここへ組み込みツールを書き足さない: `allowedTools` は確認を省く側の一覧で、使える道具の一覧ではないため
 *
 * [sdk-verbatim Options.allowedTools]
 * > To restrict which tools are available, use the `tools` option instead.
 */
export const CLONE_ALLOWED_TOOLS = CLONE_TOOL_NAMES.map(qualifiedToolName);

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

// `.describe()` と断り文の両方から同じ関数を呼ぶ: 数値を2箇所へ手で書き写すと片方だけ直して食い違うため
export function formatIntRangeJa(range: { min?: number; max?: number }): string {
  const { min, max } = range;
  if (min !== undefined && max !== undefined) return `${min}以上${max}以下の整数`;
  if (min !== undefined) return `${min}以上の整数`;
  if (max !== undefined) return `${max}以下の整数`;
  return '整数';
}

// 入力スキーマ側（`.int()` / `.min()` 等）へ置かない: SDK の `tool()` がハンドラより前に検証し、英語の zod の JSON が `isError` で返って兄弟の欄と応答の形が食い違うため
function describeIntRangeViolation(
  field: string,
  value: number | undefined,
  range: { min?: number; max?: number },
): string | null {
  if (value === undefined) return null;
  const { min, max } = range;
  const withinRange = (min === undefined || value >= min) && (max === undefined || value <= max);
  if (Number.isInteger(value) && withinRange) return null;
  return `${field} ${value} は使えない（${formatIntRangeJa(range)}のみ）。`;
}

export function formatStringLengthJa(range: { min?: number; max?: number }): string {
  const { min, max } = range;
  if (min !== undefined && max !== undefined) return `${min}文字以上${max}文字以下`;
  if (min !== undefined) return `${min}文字以上`;
  if (max !== undefined) return `${max}文字以下`;
  return '任意の長さ';
}

function describeStringLengthViolation(
  field: string,
  value: string | undefined,
  range: { min?: number; max?: number },
): string | null {
  if (value === undefined) return null;
  const { min, max } = range;
  // NUL を落としてから数える: ストアや日誌は NUL を落として残すため、NUL だけの値が「1文字以上」を通って空として残る
  const length = stripNul(value).length;
  const withinRange = (min === undefined || length >= min) && (max === undefined || length <= max);
  if (withinRange) return null;
  return `${field} は使えない（${formatStringLengthJa(range)}のみ）。`;
}

function describeBlankViolation(field: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  if (stripNul(value).trim().length > 0) return null;
  return `${field} は使えない（空白だけの値は空と同じ。${formatStringLengthJa({ min: 1 })}のみ）。`;
}

// 下限・上限の数値を書き写さない: 2箇所に手で書くと片方だけ直して食い違うため `practiceKindSchema` を検査・説明文の両方から参照する
export function formatPracticeKindRangeJa(): string {
  return formatStringLengthJa({
    min: practiceKindSchema.minLength ?? undefined,
    max: practiceKindSchema.maxLength ?? undefined,
  });
}

function describePracticeKindViolation(
  value: string | undefined,
  field: string = 'kind',
): string | null {
  if (value === undefined) return null;
  if (practiceKindSchema.safeParse(value).success) return null;
  if (value.length > 0 && stripNul(value).length === 0) {
    return `${field} は使えない（NUL（\\u0000）だけの値は空と同じ。${formatPracticeKindRangeJa()}のみ）。`;
  }
  return `${field} は使えない（${formatPracticeKindRangeJa()}のみ）。`;
}

// `.min(1)` を入力スキーマ側に置かない: SDK の `tool()` がハンドラより前に検証するため、件数の検査はハンドラの先頭の `safeParse` へ渡す
const inboxRemoveManyTypesToolInputSchema = z.array(z.enum(CLONE_REMOVABLE_INBOX_EVENT_TYPES));

export function formatArrayLengthJa(range: { min?: number; max?: number }): string {
  const { min, max } = range;
  if (min !== undefined && max !== undefined) return `${min}件以上${max}件以下`;
  if (min !== undefined) return `${min}件以上`;
  if (max !== undefined) return `${max}件以下`;
  return '任意の件数';
}

function describeArrayLengthViolation(
  field: string,
  value: readonly unknown[] | undefined,
  range: { min?: number; max?: number },
): string | null {
  if (value === undefined) return null;
  const { min, max } = range;
  const withinRange =
    (min === undefined || value.length >= min) && (max === undefined || value.length <= max);
  if (withinRange) return null;
  return `${field} は使えない（${formatArrayLengthJa(range)}）。`;
}

function describeStringArrayElementLengthViolation(
  field: string,
  value: readonly string[] | undefined,
): string | null {
  if (value === undefined) return null;
  const emptyIndex = value.findIndex((entry) => stripNul(entry).length === 0);
  if (emptyIndex === -1) return null;
  return (
    `${field} は使えない（${emptyIndex} 番目（0起点）が空文字。各要素とも` +
    `${formatStringLengthJa({ min: 1 })}）。`
  );
}

// 一律に「完了した」と書かない: 記録そのものが行為の道具では「やり直すな」が嘘になり、やり直すべきときに止めてしまうため
type JournalFailureOutcome = 'act-completed' | 'act-not-performed' | 'act-partially-completed';

// ガードで握り潰して成功として返さない: `isError: true` は依頼者がその場で気づける唯一の合図のため、跡を残してから投げ直す
class JournalNotRecordedError extends Error {
  constructor(
    tool: CloneToolName,
    entry: JournalEntryInput,
    outcome: JournalFailureOutcome,
    cause: unknown,
  ) {
    super(formatJournalNotRecordedMessage(tool, entry, outcome, cause));
    this.name = 'JournalNotRecordedError';
  }
}

function formatJournalNotRecordedMessage(
  tool: CloneToolName,
  entry: JournalEntryInput,
  outcome: JournalFailureOutcome,
  cause: unknown,
): string {
  // 道具の引数を `journalEntryShape` の外から転記しない: 鍵や本文が応答へ漏れるため
  // `cause.message` を使わない: `DrizzleQueryError` の message は2行目に行の値そのものを含むため `collapseErrorCause` を通す
  const shape = journalEntryShape(entry);
  const reason = collapseErrorCause(cause);
  switch (outcome) {
    case 'act-completed':
      return [
        '⚠⚠ 完了済み・未記録・やり直し禁止',
        `${tool} は完了した（副作用は済んでいる）が、日誌へ記録できなかった。`,
        `記録できなかったエントリ: ${shape}`,
        `理由: ${reason}`,
        'やり直さないこと（同じ副作用がもう一度起きる）。journal_write で記録を書き直すこと。',
      ].join('\n');
    case 'act-not-performed':
      return [
        '⚠⚠ 未記録・行為は起きていない・やり直してよい',
        `${tool} は、この記録に失敗した時点で副作用を1つも起こしていない` +
          '（日誌へ記録すること自体が道具の行為であるか、状態を変える前に日誌を' +
          '先に書く道具であるかのどちらかに当たる）。',
        `記録できなかったエントリ: ${shape}`,
        `理由: ${reason}`,
        'やり直してよい（同じ内容でもう一度呼べる。重複は起きない）。',
      ].join('\n');
    case 'act-partially-completed':
      return [
        '⚠⚠ 一部完了・未記録・やり直し禁止',
        `${tool} は移し先への追記まで済んだが、出どころからの切り取りは行っていない。`,
        'いま同じ節が移し先と出どころの両方に在る——重複しているが、失われてはいない。',
        'そのうえで日誌へ記録できなかった。',
        `記録できなかったエントリ: ${shape}`,
        `理由: ${reason}`,
        'やり直さないこと（重複がもう1つ増える）。memory_outline で現状を読み直してから決めること。',
      ].join('\n');
  }
}

class ApprovalNotRecordedError extends Error {
  constructor(approval: PendingApproval, cause: unknown) {
    super(formatApprovalNotRecordedMessage(approval, cause));
    this.name = 'ApprovalNotRecordedError';
  }
}

function formatApprovalNotRecordedMessage(approval: PendingApproval, cause: unknown): string {
  const shape = approvalShape(approval);
  const reason = collapseErrorCause(cause);
  return [
    '⚠⚠ 未記録・確認は人間へ届いていない・やり直してよい',
    'ask_human は承認待ちキューへの記録に失敗した。人間はまだこの質問を見ていない。',
    `記録できなかった確認: ${shape}`,
    `理由: ${reason}`,
    'やり直してよい（同じ内容でもう一度呼べる。id は呼ぶたびに新しく振られるので重複は起きない）。',
  ].join('\n');
}

// 「id が違う」と言い切らない: 古い片付き行は物理削除されうる。数えられなかった回を 0 と混ぜず、投げ直さない（単票の照会が道具の故障として落ちるため）
async function describeMissingCommitment(stores: Stores, id: string): Promise<string> {
  let trimmedClosed: number | null;
  try {
    trimmedClosed = (await stores.commitments.list()).trimmedClosed;
  } catch {
    trimmedClosed = null;
  }
  if (trimmedClosed === null) {
    return (
      `引き受けた仕事 ${id} は、いま台帳に無い。` +
      '**この記憶ストアが片付き行を物理削除しているかどうかは読めなかった。** ' +
      'id の打ち間違いなのか、一度は在った行が消えたのかは、ここでは決められない。'
    );
  }
  if (trimmedClosed === 0) return `引き受けた仕事 ${id} は無い（id が違う）。`;
  return (
    `引き受けた仕事 ${id} は、いま台帳に無い。**「id が違う」とは言い切れない。** ` +
    `この記憶ストアは保持上限を超えた片付き行を物理削除しており、累計 ${trimmedClosed} 件ある。` +
    'この id がその中に在ったかどうかは、どこにも残っていない（消えた件数は数えているが、id は控えていない）。' +
    '日誌側の記録が唯一の手掛かりになる。'
  );
}

// 「記録が無い」を「名乗っていない」と断定しない: 古い行には記録が無いため「取り違えた可能性がある」に留める
async function describeCommitmentNotOnLedger(stores: Stores, id: string): Promise<string> {
  const notOnLedger = `引き受けた仕事 ${id} は台帳に無い。`;
  let recorded: JournalEntry[];
  try {
    recorded = await stores.journal.list({ q: id, limit: 1 });
  } catch (error) {
    // 「在った」「無かった」のどちらへも倒さない: 判定できないという3つ目の状態を持つ
    noteUnreadableRecord('機械が名乗った id の記帳（commitment_close の read-through）', id, error);
    return `${notOnLedger}**どちらかは判定できない**（日誌を読めなかった: ${reasonOf(error)}）。`;
  }
  if (recorded.length > 0) {
    return (
      `${notOnLedger}**ただしこの id を機械が名乗った記録は日誌に在る**` +
      `（${recorded[0]?.at} の行）。⟹ 台帳に載った後に行が消えたということである（#856 本体）。` +
      'id の取り違えではない。'
    );
  }
  return (
    `${notOnLedger}**そしてこの id を機械が名乗った記録も日誌に無い** ⟹ id を取り違えた` +
    '可能性がある（`commitment_list` で実在する id を確かめること）。' +
    '⚠️ **ただし「記録が無い」は「名乗っていない」と同義ではない** —— 記録自体が落ちた場合と、' +
    '記録を残すようになる前に開いた行の場合がある。'
  );
}

async function appendJournalOrThrow(
  tool: CloneToolName,
  journal: JournalStore,
  entry: JournalEntryInput,
  outcome: JournalFailureOutcome,
): Promise<JournalEntry> {
  try {
    return await journal.append(entry);
  } catch (error) {
    noteDroppedRecord('日誌', journalEntryShape(entry), error);
    throw new JournalNotRecordedError(tool, entry, outcome, error);
  }
}

// `message` も `reasonOf` も使わない: `profile.apply` の例外は失敗したクエリの `params:` にスクリプト全文を添えうるため、クラス名だけを返す
function errorKindOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// `appendJournalOrThrow` を使わない: 1行目が書けた後の追記が投げると、道具の結果がもう決まっているのに応答が変わるため
async function appendJournalOrDrop(
  tool: CloneToolName,
  journal: JournalStore,
  entry: JournalEntryInput,
): Promise<JournalEntry | undefined> {
  try {
    return await journal.append(entry);
  } catch (error) {
    noteDroppedRecord(`日誌（${tool}）`, journalEntryShape(entry), error);
    return undefined;
  }
}

// 3値を3値のまま出す: 層が取れていない `undefined` をマネージャー側へ混ぜない
function denialActorTag(actor: ManagerDenial['actor']): string {
  return actor === 'manager' ? ' [マネージャー]' : actor === 'worker' ? ' [作業者]' : ' [層不明]';
}

// 長さの上限もエスケープも掛けない: journal 側に無い制約をここにだけ足す理由が無いため
function denialReasonTag(
  denial: Pick<ManagerDenial, 'reasonType' | 'reason' | 'message' | 'inputHead'>,
): string {
  const parts = [
    denial.reasonType === undefined ? undefined : `分類: ${denial.reasonType}`,
    denial.reason === undefined ? undefined : `理由: ${denial.reason}`,
    denial.message === undefined ? undefined : `モデルへの拒否文: ${denial.message}`,
    denial.inputHead === undefined ? undefined : `入力の先頭: ${denial.inputHead}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? ` [${parts.join(' / ')}]` : '';
}

// 拒否の出所を断定しない: 器の分類器と alteroid 自身のフックの拒否は同じイベントで通り、帰結が違うため
// 「0 件」を「止められていない」と読ませない: 数は器を作り直せば消えるため
function describeDenials(
  denials: ManagerDenial[],
  lastReportAt: string | undefined,
): string | null {
  if (denials.length === 0) return null;
  const followUp = describeDenialFollowUp(denials, lastReportAt);
  const recent = [...denials].reverse();
  const shown = recent.slice(0, LIST_DENIED_TOOLS);
  const rest = recent.length - shown.length;
  const total = denials.reduce((sum, entry) => sum + entry.count, 0);
  return (
    `⚠ 確認へ上がらず止められた道具: ${shown.map((e) => `${e.tool} ${e.count}件${denialActorTag(e.actor)}${denialReasonTag(e)}`).join(' / ')}` +
    (rest > 0 ? `（ほか ${rest} 種、全 ${total} 件）` : '') +
    '。まず担い手自身に返っている拒否文を読ませること。出所はこの数からは取れない —— ' +
    '(a) 器の分類器か deny 規則なら、この確認はクローンには回ってきていないので手が止まる。' +
    '(b) alteroid 自身の `PreToolUse` フック（`bash-wait-guard.ts` 等）なら、理由と代替案は' +
    '担い手へ直接返っており、自力で抜けられることがある' +
    '（全件は journal_read に残っている。件数はデーモンを作り直すと数え直しになる）。' +
    (followUp === null ? '' : `${followUp}。`)
  );
}

function denialLine(denials: ManagerDenial[], lastReportAt: string | undefined): string | null {
  const note = describeDenials(denials, lastReportAt);
  return note === null ? null : `  ${note}`;
}

// 頼んだ値を実際の値として名乗らない
function describeStartedCwd(
  manager: Pick<ManagerSummary, 'cwd' | 'cwdConfirmed' | 'requestedCwd'>,
): string {
  if (manager.cwdConfirmed !== true) {
    return `実際の cwd は未確認（頼んだ値: ${manager.cwd}）`;
  }
  if (manager.requestedCwd !== undefined) {
    return `頼んだ cwd（${manager.requestedCwd}）はこの器に無かったので、${manager.cwd} で開いた`;
  }
  return `cwd: ${manager.cwd}`;
}

// `status` を `failed` へ置き換えない: 支出上限に当たった回もセッションは生きており、「もう続けられない」と読ませると起こし直す判断を誤るため
// SDK の語（`code` / `via`）をそのまま出す: 言い換えると型定義や生ログで引ける手がかりが消えるため
// 終端した枝には RESTART_BEFORE_CHECK_ADVICE を付けない: 二重起動の危険は死んでいるか確認できていないときにしか成り立たないため
function describeManagerFailure(
  failure: ManagerSummary['lastFailure'],
  lastReport: string | undefined,
  status: ManagerSummary['status'],
  staleToken = false,
): string | null {
  if (failure === undefined) return null;
  const opening =
    `⚠ 直近のターンは報告ではなく失敗で終わっている: ${failure.code}（${failure.via}, ${failure.at}）。` +
    'この行の下に出る本文は runner が包んだエラー文（「このターンは応答を返さずに終わった: …」）で' +
    'あって報告ではない——**完遂して畳んだと読まないこと。** ';
  // 終端した枝のクォート内の言い換えを、生きている側の文言の部分文字列にしない: `.not.toContain(ALIVE_CLAIM)` の陰性対照がクォートの中身にも当たるため
  const base = isManagerOutcomeUnobserved(status)
    ? opening +
      `ただし status: ${status}——セッションそのものが、依頼者が望まない終わり方で` +
      '既に終端している。「セッションが生きていて原因が解ければ進められる」という前提は' +
      'ここでは成り立たない——起こし直すには manager_send で resume を試みるしかなく、' +
      '届く保証は無い（届いた事実の判定は `systemErrorLine` 等の別の行を見ること）。'
    : status === 'stopped'
      ? opening +
        'ただし status: stopped——このセッションは、その後 人間・クローンが明示的に' +
        '停止させ、確かめたうえで既に終端している（`abort()` が runner の一覧を探って' +
        'セッションが消えたことを確かめた事実。`manager.ts` の `isLive()` の doc）。' +
        '「セッションが生きていて原因が解ければ進められる」という前提はここでは成り立たない' +
        '——起こし直すには manager_send で resume を試みるしかなく、届く保証は無い' +
        '（届いた事実の判定は `systemErrorLine` 等の別の行を見ること）。'
      : opening +
        'セッションは生きているので、原因が解ければ manager_send で続きから進む' +
        '（status が done のままなのはそのためで、この委譲が死んだという意味ではない）。' +
        RESTART_BEFORE_CHECK_ADVICE;
  // `stopped` でも「resume を試みるしかなく、届く保証は無い」を言う: `manager_send` からの起こし直し自体は塞がれていないため
  if (lastReport === undefined) return base;
  const fromText = limitRecoveryOf(lastReport);
  const recovery =
    fromText !== 'unknown'
      ? fromText
      : failure.via === 'assistant_error'
        ? limitRecoveryOfAssistantError(failure.code)
        : 'unknown';
  return withRecoveryNote(base, recovery, { staleToken });
}

// `ManagerSummary` ごと受け取る: 2つの欄だけだと呼び出し側が判定を組み立て直し、`manager_report` 側と割れるため
// `lastFoldedTurn` が在る回は出さない: `lastFailure` は畳まれる前の古いターンを指し、「直近」が事実と違うため
function failureLine(manager: ManagerSummary): string | null {
  if (manager.lastFoldedTurn !== undefined) return null;
  const note = describeManagerFailure(
    manager.lastFailure,
    manager.lastReport,
    manager.status,
    tokenGenerationMismatched(manager),
  );
  return note === null ? null : `  ${note}`;
}

// `failureLine` と排他にしない: 走行中は `usage_notice` が先に届き、まだ `lastFailure` が立っていない回があるため
// `stopped` も「セッションは生きている」と言わない: `abort()` は死を確かめて終端させ、印が残ったまま `stopped` になりうるため
function describeUsageStopped(manager: ManagerSummary): string | null {
  if (manager.usageStoppedAt === undefined) return null;
  if (isManagerOutcomeUnobserved(manager.status)) {
    return (
      `⚠ 枠(利用上限)で止まっている（${manager.usageStoppedAt} から）。` +
      `ただし status: ${manager.status}——セッションそのものが、依頼者が望まない` +
      '終わり方で既に終端している。「セッションは生きているので鍵が回れば続く」' +
      'はここでは成り立たない——起こし直すには manager_send で resume を試みる' +
      'しかなく、届く保証は無い（届いた事実の判定は `systemErrorLine` 等の' +
      '別の行を見ること）。'
    );
  }
  if (manager.status === 'stopped') {
    return (
      `⚠ 枠(利用上限)で止まっている（${manager.usageStoppedAt} から）。` +
      'ただし status: stopped——このセッションは、その後 人間・クローンが明示的に' +
      '停止させ、確かめたうえで既に終端している（`abort()` が runner の一覧を探って' +
      'セッションが消えたことを確かめた事実。`manager.ts` の `isLive()` の doc）。' +
      '「セッションは生きているので鍵が回ればこの委譲は続く」はここでは成り立たない' +
      '——起こし直すには manager_send で resume を試みるしかなく、届く保証は無い' +
      '（届いた事実の判定は `systemErrorLine` 等の別の行を見ること）。'
    );
  }
  return (
    `⚠ 枠(利用上限)で止まっている（${manager.usageStoppedAt} から）。` +
    'セッションは生きているので、鍵が回ればこの委譲は続く' +
    '——status はそれまで動かさない（仕様である）。'
  );
}

function usageStoppedLine(manager: ManagerSummary): string | null {
  const note = describeUsageStopped(manager);
  return note === null ? null : `  ${note}`;
}

// `status` を置き換えない: entry が消えていても `sessionId` が残っていれば `manager_send` は resume から入り直せることがあるため
function describeRunnerVanished(manager: ManagerSummary): string | null {
  if (manager.runnerVanished === undefined) return null;
  return (
    `⚠ 宛先の runner が名簿から消えている（この委譲の走り始めは ${manager.startedAt}。` +
    '消えた時刻は名簿に残っていないので分からない）。resume を試したわけではないので lost ではない' +
    '——manager_list status: ["lost"] の絞りには掛からない。'
  );
}

function runnerVanishedLine(manager: ManagerSummary): string | null {
  const note = describeRunnerVanished(manager);
  return note === null ? null : `  ${note}`;
}

// `tasks`（背景タスクの在り高）と混ぜない: 別の軸のため
// `count` が 0 でも出す: 「取れない」ではなく「0 と測れた」ため
function describeWithheldReports(manager: ManagerSummary): string | null {
  if (manager.awaitingBackground === undefined) return null;
  return (
    `配っていない報告 ${manager.awaitingBackground.withheldReports} 本` +
    '（中身は日誌の decision に在る）。'
  );
}

// 本文の文言を見て判定しない: 判定は構造化された印だけで行う
export function isFoldedTurnReport(
  manager: Pick<ManagerSummary, 'lastFailure' | 'lastUnreported'>,
): boolean {
  return manager.lastFailure !== undefined || manager.lastUnreported !== undefined;
}

// D が A（枠 429）を飲み込まない: この欄には枠 429 も乗るため、D の文言自身が判定できなかったと名乗る
function describeManagerSystemError(manager: ManagerSummary): string | null {
  if (manager.status !== 'failed') return null;
  if (manager.lastSystemError === undefined) {
    return `⚠ セッションは失敗で畳まれた。${SYSTEM_ERROR_UNKNOWN_NOTE}。`;
  }
  return (
    `⚠ セッションは器の資源による落ち方で畳まれた可能性 ` +
    `（${manager.lastSystemError.at}）: ${formatSystemErrorFacts(manager.lastSystemError)}`
  );
}

function systemErrorLine(manager: ManagerSummary): string | null {
  const note = describeManagerSystemError(manager);
  return note === null ? null : `  ${note}`;
}

// 因果は名乗らない: 言えるのは「同じ時間帯に器でそれが起きた／起きなかった」までのため
function describeManagerCgroupEvents(manager: ManagerSummary): string | null {
  if (manager.status !== 'failed') return null;
  if (manager.lastCgroupEvents === undefined) {
    return `⚠ ${CGROUP_EVENTS_UNKNOWN_NOTE}。`;
  }
  return `${formatCgroupEventsNote(manager.lastCgroupEvents)}（${manager.lastCgroupEvents.at}）。`;
}

function cgroupEventsLine(manager: ManagerSummary): string | null {
  const note = describeManagerCgroupEvents(manager);
  return note === null ? null : `  ${note}`;
}

// 字面そのものはここで作らない: 作ると `manager_report` と割れるため
function unobservedOutcomeLine(manager: ManagerSummary): string | null {
  const note = describeUnobservedOutcome(manager);
  return note === null ? null : `  ${note}`;
}

export function describeReportDriftMark(
  manager: Pick<ManagerSummary, 'managerId' | 'lastReportAt' | 'lastReportStatus' | 'status'>,
  now: Date,
): string | null {
  const drift = describeReportDrift({
    managerId: manager.managerId,
    lastReportAt: manager.lastReportAt,
    lastReportStatus: manager.lastReportStatus,
    status: manager.status,
    now,
  });
  return drift === '' ? null : '⚠ status 食い違い（manager_report で詳細）';
}

type ManagerActivityFields = Pick<
  ManagerSummary,
  'turnEndReason' | 'turnEndedAt' | 'lastReportAt' | 'toolUseStallPending'
> & { waiting: readonly unknown[] };

function managerActivityInputOf(manager: ManagerActivityFields): ManagerActivityInput {
  return {
    turnEndReason: manager.turnEndReason,
    turnEndedAt: manager.turnEndedAt,
    lastReportAt: manager.lastReportAt,
    toolUseStallPending: manager.toolUseStallPending,
    waitingCount: manager.waiting.length,
  };
}

// 時刻を文字列比較しない: `turnEndedAt` は SDK が書いた形のままで、オフセット表記やミリ秒なしだと静かに間違えるため `Date.parse` の数値で比べる
// 比較できないときは「症状ではない」へ倒さず ⚠ 側へ落とす: 誤って黙る代償は止まった委譲が見つからないこと
export function describeTurnEnd(
  manager: ManagerActivityFields & Pick<ManagerSummary, 'turnEndTail'>,
): string | null {
  if (manager.turnEndReason === undefined) return null;

  if (classifyManagerActivity(managerActivityInputOf(manager)) !== 'stalled-turn-end') {
    return null;
  }

  if (manager.turnEndedAt === undefined) {
    return (
      '  ⚠ ターンは終わっているらしいが、いつ終わったかが分からない' +
      `（${manager.turnEndReason}。行に timestamp が無かった）。` +
      '**分からないだけで、症状ではないとは言えない** — 報告が届いたかどうかを' +
      'ここでは判定できない。まず manager_report を見ること（本文が空でも生ログから' +
      '拾える）、manager_transcript で生ログの全文が読める。' +
      RESTART_BEFORE_CHECK_ADVICE +
      'この委譲は止まっていない・切っていない — この助言はデーモンが計算しただけで、' +
      '委譲は動き続けてよい。'
    );
  }

  const stopSequenceNote =
    manager.turnEndReason === 'stop_sequence'
      ? '**枠の壁（利用上限）の可能性が高い** — Issue #567 の「報告が配られない」とは別の原因である。 '
      : '';
  const tailNote =
    manager.turnEndTail === undefined || manager.turnEndTail === ''
      ? ''
      : `末尾の抜粋: ${excerptLine(manager.turnEndTail, LIST_TURN_END_TAIL_EXCERPT)} `;
  return (
    `  ⚠ ターンは ${manager.turnEndedAt} に ${manager.turnEndReason} で終わっているが、` +
    '報告がまだ届いていない。' +
    stopSequenceNote +
    tailNote +
    'まず manager_report を見ること（本文が空でも生ログから拾える）、manager_transcript で' +
    '生ログの全文が読める。' +
    RESTART_BEFORE_CHECK_ADVICE +
    'この委譲は止まっていない・切っていない — この助言はデーモンが計算しただけで、' +
    '委譲は動き続けてよい。'
  );
}

// `waiting` が非空なら出さない: 確認は届いていてクローンがまだ答えていないだけの正常な状態で、⚠ を重ねると答えれば済むものが異常に見えるため
// 時刻の閾値を置かない: 置くとそれより短い窓の症状が出力から消えるため
// ⚠ 側の助言は「確かめること」で終えず、1つの手に着地させる: 確かめた後の分岐が読み手の記憶の中にしか無くなるため
export function describeToolUseStall(
  manager: ManagerActivityFields & Pick<ManagerSummary, 'toolUseStallAt'>,
): string | null {
  const pending = manager.toolUseStallPending;
  if (pending === undefined || pending.length === 0) return null;
  const activity = classifyManagerActivity(managerActivityInputOf(manager));
  if (activity !== 'stalled-tool-use' && activity !== 'tool-running') {
    return null;
  }

  const shown = pending.slice(0, LIST_TOOL_USE_STALL_LIMIT);
  const rest = pending.length - shown.length;
  const names = shown.map((item) => `${item.name ?? '（name 不明）'}(${item.id})`).join(' / ');
  // `toolUseStallAt` が無い形を潰さない: 行に `timestamp` が無かっただけで、矛盾（または実行中）は成立しているため
  const whenNote =
    manager.toolUseStallAt === undefined
      ? 'その行に timestamp が無かったので、いつからかは分からない'
      : `その行の timestamp は ${manager.toolUseStallAt}`;
  const countNote =
    `未応答の道具: ${names}` +
    (rest > 0 ? `（ほか ${rest} 件、全 ${pending.length} 件）` : '') +
    `。${whenNote}。`;

  if (activity === 'tool-running') {
    return (
      '  道具を実行中（矛盾ではない。Issue #2173）。' +
      '生ログの末尾の assistant 行が stop_reason: tool_use で、対応する tool_result が生ログに無く、' +
      'デーモン側の返事待ち（waiting）も空だが、未応答の道具はどれも応答をデーモンだけが返す種類' +
      '（AskUserQuestion 等）ではない — 既定の permissionMode: auto ではこれらの道具の確認は' +
      'デーモンへ届かない（SDK 自身が応答を待つ）ので、waiting が空なのは矛盾ではない。' +
      countNote +
      '**時刻の閾値は置いていない** — 何分経ったかはこの行では判定していない。' +
      'この行そのものは何も止めていない — 委譲は動き続けてよい。急かさず、次の一覧まで待つこと。'
    );
  }

  return (
    '  ⚠ 道具の応答待ちのまま、誰もその応答を待っていない（矛盾）。' +
    `生ログの末尾の assistant 行が stop_reason: tool_use で、対応する tool_result が生ログに無く、` +
    `かつデーモン側の返事待ち（waiting）が空である。` +
    countNote +
    '**時刻の閾値は置いていない** — 何分経ったかはこの行では判定していないので、' +
    'timestamp を読んで判断すること。' +
    'この行そのものは何も止めていない — デーモンが計算して添えただけで、委譲は動き続けてよい。' +
    '次の一手は上から順に見て、当たったところで止まる: ' +
    '(1) この委譲の状態が running 以外（done / failed / lost / stopped / waiting_human）なら、' +
    'この行は読み捨てる — この旗を書き換える探りは running のものしか訪ねないので、' +
    'running を離れた時点の値がそのまま凍っている。' +
    '(2) running なら manager_transcript で生ログの末尾を読む — 長いので、' +
    'まず大きすぎる offset を渡して「全 N 文字」だけを受け取り、' +
    '次に offset を N の1ページぶん手前にして末尾を取る（2手）。' +
    '(3) その末尾に isApiErrorMessage: true の行（この repo ではなく CLI が生ログへ書く欄。' +
    '枠の壁などで API が返した文言を合成した行）が在れば、この委譲は既に死んでいる — ' +
    'manager_stop して引き継ぐこと。' +
    '(4) それが無いなら #572 の症状そのもの — 確認はクローンの受信箱に一度も現れていない。' +
    '確認の本文を生ログから写して Issue へ置いてから manager_stop して引き継ぐこと' +
    '（写さずに止めると、質問は誰にも読まれないまま消える）。' +
    RESTART_BEFORE_CHECK_ADVICE
  );
}

function assertNeverTokenGenerationUnknownReason(reason: never): never {
  throw new Error(`未知の認証トークン世代の不明理由: ${JSON.stringify(reason)}`);
}

// `manager_stop` → `manager_start` の対処を他の2つに書かない: 効かない手順を勧めることになるため
function describeTokenGenerationUnknownReason(reason: TokenGenerationUnknownReason): string {
  switch (reason) {
    case 'pool-not-wired':
      return (
        '  認証トークンの世代: 分からない（このデプロイは認証トークンの世代そのものを' +
        '配線していない構成。全ての委譲について同じ理由で分からない——この委譲固有の' +
        '問題ではなく、manager_stop → manager_start で起こし直しても変わらない）。'
      );
    case 'not-yet-observed':
      return (
        '  認証トークンの世代: 分からない（この委譲のセッションが、いまのデーモンの' +
        'プロセスではまだ一度も起きていない。start・明示的な resume・認証トークンの' +
        '回転のどれかが起きれば次の一覧から埋まる——いま何もしなくてよい）。'
      );
    case 'reattached-across-restart':
      return (
        '  認証トークンの世代: 分からない（デーモンの再起動をまたいで、runner に生きた' +
        'ままのセッションを引き取った。引き取っただけではこのセッションの環境変数に' +
        '触れていないので、抱えている世代を確かめる材料が無い——一致でも不一致でもない、' +
        '正直な「分からない」である）。この委譲へ daemon が次に明示的に触れば' +
        '（送信・回転のどちらでも）自動で埋まるが、429 が続くなど気になるようなら' +
        `起こし直すこと。${STALE_TOKEN_RESTART_ADVICE}`
      );
    default:
      return assertNeverTokenGenerationUnknownReason(reason);
  }
}

// 健全（世代が一致）でも `null` を返さない: 説明文で「出す」と約束している値そのものなため
function describeTokenGeneration(manager: ManagerSummary): string | null {
  if (manager.tokenGeneration === undefined) {
    return manager.tokenGenerationUnknownReason === undefined
      ? null
      : describeTokenGenerationUnknownReason(manager.tokenGenerationUnknownReason);
  }
  if (manager.activeTokenGeneration === undefined) {
    // 0 や「一致」を捏造しない: 比べる相手がいま取れないため
    return `  認証トークンの世代: ${manager.tokenGeneration}（現役は不明——比べられない）`;
  }
  if (!tokenGenerationMismatched(manager)) {
    return `  認証トークンの世代: ${manager.tokenGeneration}（現役と一致）`;
  }
  return (
    `  ⚠ 認証トークンの世代が食い違っている（世代 ${manager.tokenGeneration} を抱えたまま、` +
    `現役は世代 ${manager.activeTokenGeneration}）。この委譲のセッションが、` +
    'ターンの境界（確認待ち・背景処理が無い状態）に一度も達しないまま古い鍵で走り続けている' +
    '可能性がある（認証トークンを回した直後は、次のターンの境界に達するまでの短い遅れとして' +
    '普通に起こる——それ自体は症状ではない）。' +
    describeBackgroundTasksForStaleToken(manager) +
    '委譲が done なら、manager_send の時点で畳んで新しい鍵で起こし直す' +
    '（背景処理・確認待ちが残っていれば断る。Issue #2851）。' +
    '背景処理・確認待ちが無いのにこの行が消えないまま 429 が続くようなら、' +
    `起こし直すこと。${STALE_TOKEN_RESTART_ADVICE}`
  );
}

// `undefined` は 0 本と言わず「分からない」と言う: 古い runner は欄を返さないため
function describeBackgroundTasksForStaleToken(manager: ManagerSummary): string {
  if (manager.liveBackgroundTasks === undefined) {
    return 'runner が見ている背景処理の本数は分からない（まだ聞けていない、または古い runner）。';
  }
  return manager.liveBackgroundTasks === 0
    ? 'runner が最後に見た背景処理は 0 本。'
    : `runner が最後に見た背景処理は ${manager.liveBackgroundTasks} 本（残っていると境界に達せず、自動では畳み直されない）。`;
}

// `describeTokenGeneration` と同じ行で ⚠ を二重に鳴らさない: 同じ結論を読み手が2回読むことになるため
// 「判定できない」を「世代ずれではない」へ倒さない: 材料が無いことは「健全」の証明ではないため
function describeResetTimeSkew(manager: ManagerSummary): string | null {
  if (
    manager.tokenGeneration !== undefined &&
    manager.activeTokenGeneration !== undefined &&
    manager.tokenGeneration !== manager.activeTokenGeneration
  ) {
    return null;
  }
  if (manager.resetTimeSkewMatch === 'stale') {
    return (
      '  ⚠ 認証トークンの世代ずれの疑い（429の文言に書かれていた resets 時刻が、' +
      '現役ではない鍵の冷却期限と一致した）。このセッションは古い鍵を掴んだまま' +
      '走っている可能性がある——鍵が通る状態へ戻っても、このセッション自身は' +
      'ターンの境界に達するまで戻らない。' +
      'この行が消えないまま 429 が続くようなら、' +
      `起こし直すこと。${STALE_TOKEN_RESTART_ADVICE}`
    );
  }
  if (manager.resetTimeSkewMatch === 'active') {
    return (
      '  認証トークン: 429の文言に書かれていた resets 時刻が、現役の鍵自身の' +
      '冷却期限と一致した——世代ずれではなく、待てば戻る。'
    );
  }
  return null;
}

function formatUnpushedWorkObservationWorktrees(
  worktrees: readonly { relativePath: string; branch: string | null }[],
): string {
  return worktrees.length === 0
    ? '見つかった作業ツリー0本'
    : worktrees
        .map(
          (wt) =>
            `${wt.relativePath}: branch=${wt.branch === null ? 'null（取れなかった）' : wt.branch}`,
        )
        .join(' / ');
}

function unpushedWorkObservationIncompleteSuffix(
  observation: Extract<LastUnpushedWorkObservation, { kind: 'observed' }>,
): string {
  const note = describeUnpushedWorkObservationIncompleteness(observation);
  return note === null ? '' : `\n  ${note}`;
}

// 一覧では件数と最後の1件だけにする: 一覧は予算で打ち切られ、1件の委譲が最大20行を取ると出る委譲の数が減るため。全件は `manager_report` が出す
function describeUnpushedWorkObservation(
  manager: ManagerSummary,
  outputs: 'brief' | 'full' = 'brief',
): string | null {
  const lines = [
    describeUnpushedWorkObservationOnly(manager),
    describeRescue(manager),
    describeExternalOutputs(manager, outputs),
  ].filter((line): line is string => line !== null);
  return lines.length === 0 ? null : lines.join('\n');
}

function formatExternalOutput(output: ExternalOutput): string {
  return (
    `${output.kind}: ${output.where}` +
    (output.summary === undefined ? '' : `（${output.summary}）`) +
    `、${output.at}`
  );
}

export function describeExternalOutputs(
  manager: ManagerSummary,
  mode: 'brief' | 'full',
): string | null {
  const outputs = manager.externalOutputs;
  if (outputs === undefined || outputs.length === 0) return null;
  const head = `  外へ出した成果（マネージャーの記録。直近 ${String(externalOutputLimits.keptPerJob)} 件まで）`;
  if (mode === 'brief') {
    const last = outputs[outputs.length - 1];
    return `${head}: ${String(outputs.length)} 件。最後: ${last === undefined ? '' : formatExternalOutput(last)}`;
  }
  return [`${head}:`, ...outputs.map((output) => `    ${formatExternalOutput(output)}`)].join('\n');
}

const RESCUE_REMOVAL_REASON_TEXT: Record<RescueRemovalReason, string> = {
  landed: '内容が origin の枝に入っていた',
  done: '委譲が done のまま猶予を過ぎた',
  failed: '委譲が failed のまま猶予を過ぎた',
  stopped: '委譲が stopped のまま猶予を過ぎた',
};

export function describeRescue(manager: ManagerSummary): string | null {
  const rescue = manager.lastRescue;
  if (rescue === undefined || rescue.worktrees.length === 0) return null;
  const lines = [`  退避 ref（走行中に自動で push。${rescue.at} に最後に更新）:`];
  for (const tree of rescue.worktrees) {
    const parts: string[] = [];
    if (tree.pushed !== undefined) {
      const removal = tree.pushed.removal;
      // 消した ref を「在る」と読ませない
      const state =
        removal === undefined
          ? ''
          : removal.failureKind === 'no-remote'
            ? '・送り先が台帳に無いので自動では消せない（手で消す）'
            : removal.failureKind === undefined
              ? `・${removal.at} に消した（${RESCUE_REMOVAL_REASON_TEXT[removal.reason]}）`
              : `・消せなかった（${removal.failureKind}。${removal.at} 時点で ${String(removal.attempts ?? 1)} 回目。次の機会に再試行する）`;
      parts.push(
        `${tree.pushed.ref}（${tree.pushed.commit.slice(0, 8)}, ${tree.pushed.at}${state}）`,
      );
    } else {
      parts.push('退避された ref は無い');
    }
    if (tree.notPushed !== undefined) {
      parts.push(
        `直近の回: ${RESCUE_NOT_PUSHED_TEXT[tree.notPushed.reason]}${rescueNotPushedDetail(tree.notPushed)}`,
      );
    }
    lines.push(`    ${tree.relativePath}: ${parts.join('。')}`);
    const unsaved: string[] = [];
    if (tree.untracked !== undefined) {
      const shown = tree.untracked.paths.slice(0, 5).join(', ');
      const rest = tree.untracked.count - Math.min(5, tree.untracked.paths.length);
      unsaved.push(
        `未追跡 ${tree.untracked.count} 件（${shown}${rest > 0 ? ` ほか ${rest} 件` : ''}）`,
      );
    }
    if (tree.submoduleCount !== undefined) {
      unsaved.push(`submodule ${tree.submoduleCount} 本（中の変更は退避されない）`);
    }
    if (unsaved.length > 0) lines.push(`      退避されなかったもの: ${unsaved.join('、')}`);
  }
  return lines.join('\n');
}

// `cwd`（探索の起点の絶対パス）は載せない: 絶対パスそのものは出さない線を、この欄の写しにも適用するため
// 時刻だけを出さず、観測自身の `source` から出どころを行の中に書く: 読み手が「いまの状態」と誤読するため
// 観測が `undefined` でも器の入れ替えで応答不能な分岐では `null` を返さない: 「0件」と「沈黙」が読み手から区別できなくなるため
function describeUnpushedWorkObservationOnly(manager: ManagerSummary): string | null {
  const observation = manager.lastUnpushedWorkObservation;

  if (manager.sessionMissingSince !== undefined) {
    if (manager.shutdownObservationArrivedAfterSwap === true && observation !== undefined) {
      if (observation.kind === 'unavailable') {
        return (
          `  未push観測: 器が止まる直前（${observation.at}）に取ろうとしたが取れなかった: ` +
          observation.reason
        );
      }
      if (isEmptyCompleteUnpushedWorkObservation(observation)) return null;
      return (
        `  未push観測: 器が止まる直前（${observation.at}）の観測: ` +
        formatUnpushedWorkObservationWorktrees(observation.worktrees) +
        unpushedWorkObservationIncompleteSuffix(observation)
      );
    }
    const shown =
      observation === undefined
        ? '表示中の観測は無い（一度も取れていない）'
        : observation.kind === 'unavailable'
          ? `表示中の観測は ${observation.at} 時点・${describeUnpushedWorkObservationSource(observation.source)} のもの（取れなかった: ${observation.reason}）`
          : `表示中の観測は ${observation.at} 時点・${describeUnpushedWorkObservationSource(observation.source)} のもの: ${formatUnpushedWorkObservationWorktrees(observation.worktrees)}` +
            unpushedWorkObservationIncompleteSuffix(observation);
    return `  ${UNPUSHED_WORK_SHUTDOWN_OBSERVATION_NOT_ARRIVED_NOTE}` + shown;
  }

  if (observation === undefined) return null;
  if (isEmptyCompleteUnpushedWorkObservation(observation)) return null;
  const provenance = describeUnpushedWorkObservationProvenance(observation.source, 'manager_list');
  if (observation.kind === 'unavailable') {
    return (
      `  未push観測（${provenance}）: 取れなかった（${observation.at}）: ` + observation.reason
    );
  }
  return (
    `  未push観測（${provenance}、${observation.at}）: ` +
    formatUnpushedWorkObservationWorktrees(observation.worktrees) +
    unpushedWorkObservationIncompleteSuffix(observation)
  );
}

function unpushedWorkReportNote(manager: ManagerSummary): string | null {
  const note = describeUnpushedWorkObservation(manager, 'full');
  return note === null ? null : note.trimStart();
}

function runnerManagerTokenTag(manager: RunnerManagerEntry): string {
  if (manager.tokenGeneration === undefined || manager.activeTokenGeneration === undefined) {
    return '';
  }
  if (manager.tokenGeneration === manager.activeTokenGeneration) return '';
  return ` ⚠世代${manager.tokenGeneration}≠現役${manager.activeTokenGeneration}`;
}

const NO_POOL = text(
  'いまは委譲できない場面である（記憶へ移すための内部ターン）。' +
    '実作業が必要なら、この場では記憶に残すだけにして、次の会話で委譲すること。',
);

export const MEMORY_GUARD_ENV = 'ALTEROID_MEMORY_GUARD';

export const MEMORY_GUARD_VALUES = ['on', 'off'] as const;
export type MemoryGuardValue = (typeof MEMORY_GUARD_VALUES)[number];

export const DEFAULT_MEMORY_GUARD: MemoryGuardValue = 'on';

export function resolveMemoryGuard(env: NodeJS.ProcessEnv = process.env): MemoryGuardValue {
  const given = env[MEMORY_GUARD_ENV]?.trim();
  if (given === undefined || given.length === 0) return DEFAULT_MEMORY_GUARD;
  if ((MEMORY_GUARD_VALUES as readonly string[]).includes(given)) {
    return given as MemoryGuardValue;
  }
  // 綴りを間違えた値は黙って既定へ倒さず落とす: 守っているつもりの持ち主が気づけなくなるため
  throw new Error(
    `${MEMORY_GUARD_ENV} の値が不正: ${given}（使えるのは on / off。既定は ${DEFAULT_MEMORY_GUARD}）`,
  );
}

type MemoryGuardAction = '全文置換' | '削除' | 'frontmatter の更新' | '節の移動';

function assertNeverMemoryGuardAction(action: never): never {
  throw new Error(`未知の歯の対象: ${JSON.stringify(action)}`);
}

// 量（文字数の減少率）では判定しない: 蒸留は正当な運用として大きく畳むことがあり、量では意図を分離できないため
// `canUseTool` で止めて待たない: クローンは受信箱を直列に処理する単一セッションで、待つと全部が止まるため断って返す
async function guardFullReplace(
  stores: Stores,
  slug: string,
  cause: 'distill' | 'clone',
  action: MemoryGuardAction,
): Promise<string | null> {
  if (cause !== 'distill') return null;
  if (resolveMemoryGuard() === 'off') return null;
  // 節の移動は統合の走行からも通す: 先に足してから元を切るので本文が失われず、断ると整理が追いつかず肥大する一方になるため
  if (action === '節の移動') return null;
  const status = await stores.persona.protectionStatus(slug);
  // 三項演算子ではなく switch で網羅する: 状態が増えたとき黙って別の文言へ倒れず `tsc` が落ちるようにするため
  switch (status.kind) {
    case 'clone-only':
      return null;
    case 'human':
    case 'unknown':
      return denialMessage(slug, status, action);
    default:
      return assertNeverMemoryProtectionStatus(status);
  }
}

function seenBefore(
  slug: string,
  before: { readonly content: string } | null,
): ReadonlyMap<string, string> {
  return before === null ? new Map() : new Map([[slug, before.content]]);
}

function versionLine(content: string): string {
  return `（版 base_version=${memoryVersion(content)} ——この文書を全文で書き直す memory_write には、これを base_version に渡すこと）`;
}

function describeMemoryConflict(
  slug: string,
  action: string,
  current: { readonly content: string } | null,
  kind: 'write' | 'remove' = 'write',
): string {
  const now =
    current === null
      ? 'いまその文書は無い（読んだ後に消された）。'
      : `いまの版は base_version=${memoryVersion(current.content)}（${current.content.length} 文字）。`;
  if (kind === 'remove') {
    return (
      `記憶 ${slug} は、読んだ後にその間に変わった（人間または別のターンが書いた）ので、${action}を**しなかった**。` +
      `${now}**何も消していない**（読んでいない内容を消さないため。いまの内容は1文字も変わっていない）。` +
      `memory_read slug=${slug} で読み直し、いまの内容でも消してよいか判断し直してから、` +
      '読み直した版の base_version を付けて memory_delete し直すこと。'
    );
  }
  return (
    `記憶 ${slug} は、読んだ後にその間に変わった（人間または別のターンが書いた）ので、${action}を**書かなかった**。` +
    `${now}**何も書いていない**（あなたの内容は書かれておらず、いまの内容は1文字も変わっていない）。` +
    `memory_read slug=${slug} で読み直し、いまの内容に対してやりたいことが変わらないか判断し直してから、` +
    '読み直した版の base_version を付けて書き直すこと。'
  );
}

function practiceVersionLine(practice: Pick<Practice, 'kind' | 'title' | 'content'>): string {
  return `（版 base_version=${practiceVersion(practice)} ——このやり方を全文で書き直す practice_write と、消す practice_remove には、これを base_version に渡すこと）`;
}

function describePracticeConflict(
  slug: string,
  action: string,
  current: Pick<Practice, 'kind' | 'title' | 'content'> | null,
  kind: 'write' | 'remove' = 'write',
): string {
  const now =
    current === null
      ? 'いまそのやり方は無い（読んだ後に消された）。'
      : `いまの版は base_version=${practiceVersion(current)}（${current.content.length} 文字）。`;
  if (kind === 'remove') {
    return (
      `やり方 ${slug} は、読んだ後にその間に変わった（人間または別のターンが書いた）ので、${action}を**しなかった**。` +
      `${now}**何も消していない**（読んでいない内容を消さないため。いまの内容は1文字も変わっていない）。` +
      `practice_read slug=${slug} で読み直し、いまの内容でも消してよいか判断し直してから、` +
      '読み直した版の base_version を付けて practice_remove し直すこと。'
    );
  }
  return (
    `やり方 ${slug} は、読んだ後にその間に変わった（人間または別のターンが書いた）ので、${action}を**書かなかった**。` +
    `${now}**何も書いていない**（あなたの内容は書かれておらず、いまの内容は1文字も変わっていない）。` +
    `practice_read slug=${slug} で読み直し、いまの内容に対してやりたいことが変わらないか判断し直してから、` +
    '読み直した版の base_version を付けて書き直すこと。'
  );
}

function memoryFloorNote(
  memoryBefore: readonly MemoryPart[],
  memoryAfter: readonly MemoryPart[],
  slug: string,
  writtenContent: string,
  created: boolean,
): string {
  return describeMemoryFloor({
    before: measureMemoryFloor(memoryBefore),
    after: measureMemoryFloor(memoryAfter),
    slug,
    kind: resolveMemoryDocKind(parseMemoryFrontmatter(writtenContent)),
    created,
  });
}

// `memoryFloorNote` と混ぜない: 引数の形が違い、既存の糊を条件分岐だらけにしないため
function memorySessionGrowthNote(
  memoryAfter: readonly MemoryPart[],
  runtime: CloneRuntimeFacts | undefined,
): string {
  const afterChars = measureMemoryFloor(memoryAfter).totalChars;
  const sessionDelta = describeMemorySessionDelta({
    afterChars,
    injectedMemoryChars: runtime?.injectedMemoryChars ?? null,
  });
  const ranking = describeMemoryPremiseRanking(memoryAfter);
  return [sessionDelta, ranking].join('\n\n');
}

// `human` と `unknown` を畳まない: 履歴が在る積極的な事実と、確認できず守る側へ倒した消極的な既定は理由が違うため
// 三項演算子に戻さない: `action` の union に値を足したとき、落ちるのは `switch` だけで三項は黙って `else` 側へ倒れるため
function denialMessage(
  slug: string,
  status: Extract<MemoryProtectionStatus, { kind: 'human' | 'unknown' }>,
  action: MemoryGuardAction,
): string {
  const reason =
    status.kind === 'human'
      ? `この文書には人間の書き込みの履歴が在る（保護状態: human）`
      : `この文書の書き込みの履歴が確認できない（保護状態: unknown。索引が無い・外から書き換えられた` +
        `可能性がある、などのときにここへ倒す——不明を「人間は書いていない」とは読まず、守る側へ倒す）`;

  const alternative = ((): string => {
    switch (action) {
      case '全文置換':
      case '削除':
        return 'memory_append（追記）はこの歯の対象ではなく、断られない。失いたくないだけならそちらを使うこと。';
      case 'frontmatter の更新':
        return (
          'memory_append（追記）はここでは代わりにならない——追記は本文の末尾に文字列を足すだけで、' +
          'frontmatter のキー（description / type / parent）は直せない。'
        );
      case '節の移動':
        return (
          'memory_append（追記）はこの歯の対象ではないので、移し先の文書へ本文を写すことだけは断られない' +
          '——ただし出どころの文書から節を消すことはできないので、写した後は同じ本文が2箇所に残る。' +
          '失いたくないだけならそれで足りる。'
        );
      default:
        return assertNeverMemoryGuardAction(action);
    }
  })();

  const askHumanHint = ((): string => {
    const tail =
      '」のように積むこと。人間の回答が届いた後の次のターンで、同じ操作をやり直せば実行できる' +
      '（この場・このターンではやり直せない）。';
    switch (action) {
      case '全文置換':
      case '削除':
        return `本当に${action}が必要だと判断したら、ask_human に「記憶 ${slug} を${action}したい。理由: 〈ここに理由〉${tail}`;
      case 'frontmatter の更新':
        return `本当に frontmatter の更新が必要だと判断したら、ask_human に「記憶 ${slug} の frontmatter を更新したい。理由: 〈ここに理由〉${tail}`;
      case '節の移動':
        return `本当に節の移動が必要だと判断したら、ask_human に「記憶 ${slug} から節を1つ別の文書へ移したい。理由: 〈ここに理由〉${tail}`;
      default:
        return assertNeverMemoryGuardAction(action);
    }
  })();

  return [
    `記憶 ${slug} への${action}を、統合の走行（distill）から断った。`,
    `理由: ${reason}。`,
    'いま何も変わっていない（記憶は断る前のまま残っている）。',
    alternative,
    askHumanHint,
  ].join(' ');
}

function assertNeverMemorySectionLookup(lookup: never): never {
  throw new Error(`未知の節の照合結果: ${JSON.stringify(lookup)}`);
}

// 3つを同じ「見つかりません」に畳まない: 疑う先が違い、畳むと「誰かが書き換えた」が「打ち間違い」に見えるため
// 曖昧なときに「どちらか」を選ばない: 片方を黙って選ぶと消える側が観測できないため
function describeMemorySectionLookupFailure(
  slug: string,
  id: string,
  lookup: Exclude<MemorySectionLookup, { kind: 'found' }>,
): string {
  switch (lookup.kind) {
    case 'absent':
      return (
        `記憶 ${slug} に節id ${id} の節は無い。打ち間違いか、別の文書の節id か、` +
        '見出しごと書き換えられたかのどれかである。memory_outline で目次を取り直すこと' +
        '（何も変わっていない）。'
      );
    case 'stale':
      return (
        `節id ${id} は古い。記憶 ${slug} に同じ見出しの節は在るが、中身のハッシュが違う——` +
        `**この目次を読んだ後で、誰かがこの節を書き換えている。** 節id は指し先であると同時に版の照合` +
        `なので、ここで断って上書きを防いでいる。memory_outline で ${slug} の目次を取り直し、` +
        '中身を確かめてから新しい節id でやり直すこと（何も変わっていない）。'
      );
    case 'ambiguous':
      return (
        `節id ${id} は記憶 ${slug} の中で ${lookup.sections.length} 箇所に当たる` +
        '（見出しも中身も完全に同一の節が複数ある）。**どちらかを選ばずに断る**——' +
        '黙って一方を選ぶと、消えた側を後から観測する手段が無い。' +
        'どちらか一方の中身を先に書き分けてから（memory_write で1行足すなど）やり直すこと' +
        '（何も変わっていない）。'
      );
    default:
      return assertNeverMemorySectionLookup(lookup);
  }
}

// 短めに切る: `manager_stop` 自体の応答が長々と待たされるほうが実害で、`pool.unpushedWork()` は失敗しても構わない設計のため
const MANAGER_STOP_UNPUSHED_WORK_TIMEOUT_MS = 5_000;

// ファイル名・差分の中身・コミットメッセージ・author を文言に含めない
function describeUnpushedWork(probe: ManagerUnpushedWork): string {
  if (probe.kind === 'unavailable') {
    return `未 push の実装・未コミットの変更: **確かめられなかった**（${probe.reason}）。`;
  }
  const { result } = probe;
  if (result.worktrees.length === 0) {
    // 「見つからなかった」と言い切らない: 探せなかっただけで未 push の実装が残っている可能性があるため
    const uncertain: string[] = [];
    if (result.scratchRootsUnknown !== undefined) {
      uncertain.push(
        '他マネージャー/作業者の /tmp スクラッチディレクトリの有無は確かめられなかった' +
          `（${result.scratchRootsUnknown}）`,
      );
    }
    if (result.unreadableDirCount !== undefined) {
      uncertain.push(
        `${result.cwd} の下の子ディレクトリの読み取りに${String(result.unreadableDirCount)}回失敗した` +
          '（/tmp スクラッチの起点そのものの読み失敗を含む）' +
          '——その下に未 push の実装が残っていた可能性がある',
      );
    }
    return uncertain.length === 0
      ? `未 push の実装・未コミットの変更: 作業ツリーが見つからなかった（${result.cwd} の下を探索した）。`
      : `未 push の実装・未コミットの変更: ${result.cwd} の下には作業ツリーが見つからなかったが、` +
          `${uncertain.join('、')}。**確認できていない。**`;
  }
  const lines = result.worktrees.map((worktree) => {
    const branch = worktree.branch ?? '(枝を指していない、または確かめられなかった)';
    const unpushed =
      worktree.unpushedCommitCount === undefined
        ? `未 push: 確かめられなかった（${worktree.unpushedCommitCountUnknown ?? '理由不明'}）`
        : `未 push ${String(worktree.unpushedCommitCount)}本`;
    const uncommitted =
      worktree.uncommittedChangeCount === undefined
        ? `未コミット: 確かめられなかった（${worktree.uncommittedChangeCountUnknown ?? '理由不明'}）`
        : `未コミット ${String(worktree.uncommittedChangeCount)}件`;
    return `  - ${worktree.relativePath}（枝: ${branch}）: ${unpushed} / ${uncommitted}`;
  });
  const truncatedNote =
    result.truncatedAtCount === undefined
      ? ''
      : `\n  ⚠️ 作業ツリーの探索は${String(result.truncatedAtCount)}件で打ち切った——さらに在る可能性がある。`;
  const stoppedEarlyNote =
    result.stoppedEarly === true
      ? '\n  ⚠️ 呼び出し元の期限切れで、一部の作業ツリーは調べる前に打ち切った（各行の理由を見よ）。'
      : '';
  const scratchRootsUnknownNote =
    result.scratchRootsUnknown === undefined
      ? ''
      : `\n  ⚠️ 他マネージャー/作業者の /tmp スクラッチディレクトリの有無を確かめられなかった` +
        `（${result.scratchRootsUnknown}）——そこに未 push の実装が残っている可能性があり、` +
        '上の一覧には含まれていない。';
  const unreadableDirNote =
    result.unreadableDirCount === undefined
      ? ''
      : `\n  ⚠️ ${result.cwd} の下で子ディレクトリの読み取りに${String(result.unreadableDirCount)}件` +
        '失敗した（/tmp スクラッチの起点そのものの読み失敗を含む）——そこに未 push の実装が残っている可能性があり、上の一覧には含まれていない。';
  return (
    `未 push の実装・未コミットの変更（${result.cwd} の下、${String(result.worktrees.length)}本の作業ツリー）:\n` +
    lines.join('\n') +
    truncatedNote +
    stoppedEarlyNote +
    scratchRootsUnknownNote +
    unreadableDirNote +
    '\n  ⚠️ 未 push の数は fetch していない remote-tracking ref を基準にしており、' +
    '実際には push 済みでも多めに出ることがある（安全側の誤り）。'
  );
}

const PERMISSION_EVIDENCE_EXCERPT = 400;

// クローンの要約を挟まない: 要約の誤りが承認画面へ載るのを防ぐため。見つからないときも1行で言う: 黙って省くと「証拠が無い」ことが読めないため
export function describePermissionEvidence(
  rule: string,
  recentDenials: (() => readonly RecentDenial[]) | undefined,
): string {
  if (recentDenials === undefined) {
    return '直前の拒否: この層は拒否の記録を読む口を持たない（照合していない）。';
  }
  const wrapped = /^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/s.exec(rule);
  const tool = wrapped?.[1];
  const content = wrapped?.[2]?.replace(/:\*$/, '');
  const headWord = content === undefined ? undefined : commandHeadWord(content);
  if (tool === undefined || headWord === undefined) {
    return '直前の拒否: 規則から道具と先頭の語が取れないので、照合していない。';
  }
  const found = [...recentDenials()]
    .reverse()
    .find((it) => it.tool === tool && it.headWord === headWord);
  if (found === undefined) {
    return `直前の拒否: この規則と照合できる直前の拒否（${tool} / 先頭の語 ${headWord}）は、このセッションの記録に無い。`;
  }
  const parts = [
    `時刻 ${found.at}`,
    `道具 ${found.tool}`,
    `先頭の語 ${headWord}`,
    found.reasonType === undefined
      ? undefined
      : `分類 ${excerptLine(found.reasonType, PERMISSION_EVIDENCE_EXCERPT)}`,
    found.reason === undefined
      ? undefined
      : `理由 ${excerptLine(found.reason, PERMISSION_EVIDENCE_EXCERPT)}`,
    found.message === undefined
      ? undefined
      : `拒否文 ${excerptLine(found.message, PERMISSION_EVIDENCE_EXCERPT)}`,
  ].filter((part): part is string => part !== undefined);
  return `直前の拒否（器が返した原文。クローンの要約ではない。長い欄は ${PERMISSION_EVIDENCE_EXCERPT} 字で切る）: ${parts.join(' / ')}`;
}

/** 委譲の起点の会話（`Job.conversationId`。issue #4210）。読めない・見つからないときも `undefined`。 */
// 読めないときに断らない: 起点は承認を会話へ結ぶための手がかりで、無くても従来どおり会話の無い承認として積めるため
async function jobConversationOf(
  stores: Stores,
  managerId: string | undefined,
): Promise<string | undefined> {
  if (managerId === undefined) return undefined;
  try {
    return (await stores.jobs.listJobs()).find((job) => job.id === managerId)?.conversationId;
  } catch {
    return undefined;
  }
}

/** `manager_list` の行に出す、委譲の起点の会話（issue #4210）。 */
type JobOrigins = { kind: 'read'; byId: ReadonlyMap<string, Job> } | { kind: 'unreadable' };

async function readJobOrigins(stores: Stores): Promise<JobOrigins> {
  try {
    return {
      kind: 'read',
      byId: new Map((await stores.jobs.listJobs()).map((job) => [job.id, job])),
    };
  } catch {
    return { kind: 'unreadable' };
  }
}

function describeJobOrigin(origins: JobOrigins, managerId: string): string {
  if (origins.kind === 'unreadable') {
    return '  起点の会話: 分からない（台帳を読めなかった。起点が無いという意味ではない）';
  }
  const job = origins.byId.get(managerId);
  if (job === undefined) {
    return '  起点の会話: 分からない（台帳にこの委譲が見つからない。起点が無いという意味ではない）';
  }
  return job.conversationId === undefined
    ? '  起点の会話: 無し（会話の外で起こした委譲）'
    : `  起点の会話: ${job.conversationId}（報告を人間へ知らせるなら、この会話へ書く）`;
}

export function createCloneTools(context: ToolContext) {
  const { stores } = context;
  // ここで1回だけ解決しない: `memoryCause` はターンごとに変わりうるため、道具ハンドラの中でその都度呼ぶ
  // 倒れ先を作らない: 既定へ倒すと日誌の `cause` が嘘になるため落とす。届かなかった値そのものは書かない: 記憶の本文が例外メッセージへ漏れるため
  if (typeof context.memoryCause !== 'function') {
    throw new Error(
      'memoryCause が届いていない。ToolContext を組む側で明示すること' +
        '（既定値へ倒すと、呼び手が名乗らなかったことを「蒸留の走行だった」として' +
        '日誌に記録することになる）。',
    );
  }
  const memoryCause = context.memoryCause;
  // `conversationId` も倒れ先を作らない: 関数が無いことと `undefined` を返すことは別で、落とすのは前者だけ
  if (typeof context.conversationId !== 'function') {
    throw new Error(
      'conversationId が届いていない。ToolContext を組む側で明示すること' +
        '（既定値へ倒すと、ask_human が積む承認が会話 id を持てなくなり、' +
        '#768 の穴が再発する）。',
    );
  }
  const getConversationId = context.conversationId;
  const getWorkConversationId = context.workConversationId ?? getConversationId;

  // `default` のときは足さない: 日誌を読む側と歯が、その文言で見ているため
  function profileRowLabel(name: string): string {
    return name === 'default' ? '' : `（行 ${name}）`;
  }

  // 文言では見分けない: `ProfileRollbackFailedError` で見る
  async function profileToolFailed(
    tool: 'profile_write' | 'profile_remove',
    name: string,
    summary: string,
    error: unknown,
  ) {
    await appendJournalOrDrop(tool, stores.journal, {
      type: 'decision',
      decision:
        tool === 'profile_remove'
          ? error instanceof ProfileRollbackFailedError
            ? `実行環境プロファイルの行 ${name} の削除が途中で止まった（正本は新しい版のまま・クローンは前の版）: ${summary}`
            : `実行環境プロファイルの行 ${name} を外せなかった: ${summary}`
          : error instanceof ProfileRollbackFailedError
            ? `実行環境プロファイルの差し替えが途中で止まった（正本は新しい版のまま・クローンは前の版）${profileRowLabel(name)}: ${summary}`
            : `実行環境プロファイルを差し替えられなかった${profileRowLabel(name)}: ${summary}`,
      grounds:
        tool === 'profile_remove'
          ? `外そうとしたが、状態の変更が失敗した: ${errorKindOf(error)}`
          : `差し替えようとしたが、状態の変更が失敗した: ${errorKindOf(error)}`,
    });
    // 道具のエラーにせず理由をそのまま返す: 置けない入力は利用者の誤りで、何も変えていないため
    if (error instanceof ProfileInputError) {
      return text(`プロファイルの行を置けなかった（何も変えていない）: ${reasonOf(error)}`);
    }
    throw error;
  }

  async function profileToolReport(
    tool: 'profile_write' | 'profile_remove',
    name: string,
    summary: string,
    result: ApplyProfileResult,
    done: { decision: string; text: string },
  ) {
    // 失敗を判断として記録しない: 置けなかったのはシステムの結果で、クローンの判断ではないため
    if (!result.stored) {
      await appendJournalOrDrop(tool, stores.journal, {
        type: 'decision',
        decision: `実行環境プロファイルを差し替えられなかった（読めなかった）${profileRowLabel(name)}: ${summary}`,
        grounds: '人間から実行環境そのものを渡されたが、評価で断られた（値は記録しない）',
      });
      // クローンの文脈に鍵の値を入れない: シェルの stderr は入力の行を引用し `set -x` は値ごと吐くため伏せる
      const failure = redactProfileFailure(result.clone, process.env);
      return text(
        `実行環境プロファイルを置けなかった（保存も配布もしていない）: ${failure.error}` +
          `${failure.output.length === 0 ? '' : `\n${failure.output}`}`,
      );
    }

    await appendJournalOrDrop(tool, stores.journal, {
      type: 'decision',
      decision: `${done.decision}: ${summary}`,
      grounds: '人間から実行環境そのものを渡された（値は記録しない）',
    });

    const failed = result.runners.filter((runner) => !runner.ok);
    const delivered = result.runners.filter((runner) => runner.ok).map((r) => r.runnerId);
    const row = result.entries?.find((entry) => entry.name === name);
    const composed = result.composed;
    return text(
      [
        `実行環境プロファイルを更新した（${done.text}${row === undefined ? '' : `。撒く先 ${row.scope}`}）。`,
        composed === undefined
          ? null
          : `合成後の指紋: クローン用 ${composed.clone.sha256 ?? '（掛かる行なし）'} / runner 用 ${composed.runner.sha256 ?? '（掛かる行なし）'}`,
        delivered.length === 0
          ? null
          : `配った先: ${excerptLine(delivered.join(', '), PROFILE_DISTRIBUTION_EXCERPT)}`,
        failed.length === 0
          ? null
          : `配れなかった先: ${excerptLine(
              failed.map((r) => `${r.runnerId}（${r.error ?? '理由不明'}）`).join(', '),
              PROFILE_DISTRIBUTION_EXCERPT,
            )}`,
        'これから起こす仕事には即座に効く。走行中の仕事は gh / git だけが次の呼び出しから拾う。',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    );
  }

  return [
    tool(
      'memory_list',
      [
        '記憶の文書一覧を返す。中身は返さない。',
        '各行は `[premise|fact|indexed] slug: title (作成: createdAt / 更新: updatedAt) — 要旨` の形。',
        '作成は書き込まれた瞬間にその場で分かる。「不明」と出るのは、この配線より前に作られ、',
        '日誌にも根拠（最初の書き込み）が無い古い記憶だけである（ファイルの mtime は使わない）。',
        'premise はプロンプトへ要旨と節の目次（節id・見出し・文字数）だけが焼かれ、本文は載らない',
        '（節id を memory_section_read に渡せば開ける）。indexed は要旨だけが焼かれ、節の目次は焼かれない',
        '（節id を確かめるにはまず memory_outline を呼ぶこと）。fact は目次の1行だけがプロンプトに載るので、',
        '中身が要るなら memory_read で開くこと。要旨の前には状態が必ず付く',
        '（要旨は本文より<期間>古い（本文は<変化量>変わった） / 要旨を書いた時刻が記録されていない /',
        '要旨の後に本文は動いていない）—— description が最後の本文変更より前に書かれた可能性の',
        '代理指標であって、本文と合っている保証ではない。「<期間>古い」だけでは、頻繁に手が入って',
        'いる文書ほど新しく見える（1時間前に古くなった文書と30日放置された文書が同じ「古い」に',
        '見える）ので、その間に本文が実際どれだけ変わったか（バイト数・割合）を変化量として併記する',
        '（変化量が記録されていない古い記憶は「記録されていない」とだけ言い、0とは扱わない）。',
        '階層は frontmatter の parent から組み立てた木で、インデントで表す。',
        '一覧が予算で切れたら、断り書きが次に打つ cursor を案内する。それを cursor へ渡すと続きから読める。',
      ].join(' '),
      {
        cursor: z
          .string()
          .optional()
          .describe(
            '続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す' +
              '（自分で組み立てない）。省略すると先頭から。',
          ),
      },
      async ({ cursor }) => {
        const documents = await stores.persona.list();
        const resolved = resolveMemoryCursor(documents, cursor);
        if (resolved.kind === 'malformed') {
          // 黙って先頭からへ倒さない: 倒すと呼び手は「続きを読んだつもり」で同じ行を読むため
          return text(
            'この cursor は読めない（壊れているか、この道具のものではない）。' +
              'cursor は前回の応答の断り書きに出たものをそのまま渡すこと（自分で組み立てない）。' +
              '先頭から読み直すなら cursor を省いて呼ぶこと。',
          );
        }
        // cursor を渡されたときだけ「最後の頁」と言う: cursor 無しの0件は記憶が空で終端ではなく、早期に返すと空のときの言い方を奪うため
        if (cursor !== undefined && resolved.view.length === 0) {
          return text('（cursor より後ろの記憶は無い。これが最後の頁）');
        }
        return text(
          renderMemoryListing(
            resolved.view.map((doc) => ({
              slug: doc.slug,
              title: doc.title,
              kind: doc.kind,
              description: doc.description,
              descriptionFreshness: doc.descriptionFreshness,
              parent: doc.parent,
              updatedAt: doc.updatedAt,
              createdAt: doc.createdAt,
            })),
            { total: documents.length, anchor: resolved.anchor },
          ),
        );
      },
    ),

    tool(
      'memory_read',
      ['記憶の文書を1つ読む。', '長ければ切れて出る（続きの取り方が出力に付く）。'].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（拡張子なし）'),
        offset: z
          .number()
          .optional()
          .describe(`何文字目から読むか（${formatIntRangeJa({ min: 0 })}。既定 0）`),
      },
      async ({ slug, offset = 0 }) => {
        // 不正なスラッグはここで断る: 無いと fs / pg の生の例外がそのまま抜けるため
        if (!memorySlugSchema.safeParse(slug).success) {
          return text(`記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        const doc = await stores.persona.read(slug);
        if (!doc) return text(`記憶 ${slug} は存在しない。`);
        const part = page(doc.content, offset, MEMORY_PAGE);
        const tail = part.more
          ? `\n\n…（ここで切れている。続きは memory_read slug=${slug} offset=${part.to}）`
          : '';
        // 切れていないときは注記を出さない: 毎回付けると、本当に切れているときの目印が効かなくなるため
        const version = `\n\n${versionLine(doc.content)}`;
        if (part.from === 0 && !part.more) return text(`${part.body}${version}`);
        return text(`（${describePage(part)}）\n\n${part.body}${tail}${version}`);
      },
    ),

    tool(
      'memory_write',
      [
        '記憶の文書を全文置換する（無ければ作る）。',
        '**既存の文書を書き換えるときは、先に memory_read（または memory_outline）で読んで、応答に出る base_version を渡すこと。焼き込みの索引（プロンプトに載った premise のカード等）だけでは書けない**（読んだ後に人間や別のターンが書いていたら、何も書かずに「その間に変わった」と返す。読み直して判断し直すこと）。**新しい文書の作成は版なしで通る。**',
        '人間がこのファイルを直接開いて読むことを前提に、Markdown として読みやすく書くこと。',
        '人間が手で書いた記述を、整形の都合で消さないこと。',
        '先頭に frontmatter を置ける（無くてもよい。無ければ premise として扱う——安全側の既定）。',
        '形は `---` で始まり `---` で閉じ、各行は `key: value`。使えるキーは description（要旨。目次の1行に載る）・',
        'type（premise・indexed・fact のいずれか。premise は「要旨＋節の目次」が焼かれ、' +
          'indexed は要旨だけが焼かれて節の目次は焼かれない（特定の作業でしか使わない記憶向け。' +
          '節を確かめるにはまず memory_outline を呼ぶこと）、fact は目次の1行だけになる。',
        'どれも本文は焼かれない——premise / indexed の節の本文は memory_section_read で開く。判断の前提なら premise、',
        '事実の蓄積で毎回全文を読む必要が無いものなら fact）・parent（親文書の slug。階層を作る）の3つだけ。',
        'ネスト・複数行・引用符の解釈は無い（値は文字列としてそのまま読む）。狭い形から外れると malformed として',
        '扱われ、文書は消えずに premise のまま残る（本文はプロンプトには載らず、memory_section_read で開く）。',
        '**統合の走行（distill）からは、人間が一度でも書いた文書・履歴の無い文書には使えない**',
        '（断られる。ask_human で人間に確認を通せば次のターンで実行できる）。会話の中の書き込みは通る。',
        '成功すると差分の要約が返る——前後の文字数（バイトではない）と、この書き込みで消えた見出しの名指し。',
        '**「消えた見出し: なし」を全幅で信じないこと**——同じ見出しが他所に1つでも残っていれば、その節を丸ごと消しても「なし」になる。',
        '見出しは行頭の `#`〜`######`（ATX）だけ（setext の下線は数えない）で、コードフェンスの中は除外しない（過剰に拾う側へ倒してある）。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（英小文字・数字・-・_）'),
        content: z.string().describe('Markdown 全文'),
        summary: z.string().describe('何を更新したかの一行要約（日誌に残る）'),
        base_version: z
          .string()
          .optional()
          .describe(
            '読んだ時点の版（memory_read / memory_outline / 直前の memory_write の応答に出る base_version）。' +
              '**既存の文書を書き換えるときは必須。** 読んだ後に人間や別のターンが書いていたら、書かずに「その間に変わった」と返す。' +
              '新規作成（その slug がまだ無い）では省略してよい（版なしで通る）。焼き込みの索引だけでは版は分からない——先に memory_read か memory_outline を呼ぶこと。',
          ),
      },
      async ({ slug, content, summary, base_version: baseVersion }) => {
        if (!memorySlugSchema.safeParse(slug).success) {
          return text(`記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const cause = memoryCause();
        const denial = await guardFullReplace(stores, slug, cause, '全文置換');
        if (denial !== null) return text(denial);
        const [before, memoryBefore] = await Promise.all([
          stores.persona.read(slug),
          stores.persona.documents(),
        ]);
        // 版なしで既存の文書は書けない: 全文置換は読んだ時点の版を前提にし、読んでから書くまでがターンをまたぐこともあるため
        if (before !== null && baseVersion === undefined) {
          return text(
            `記憶 ${slug} は既に在る。全文を書き直すには、先に memory_read slug=${slug} で読み、` +
              '応答に出る base_version をこの呼び出しの base_version に渡すこと' +
              '（読んだ後に人間や別のターンが書いた内容を、気づかずに消さないため。焼き込みの索引だけでは書けない）。**何も書いていない。**',
          );
        }
        let written;
        try {
          written = await stores.persona.write(slug, content, {
            ifMatch: before === null ? (baseVersion ?? null) : baseVersion!,
          });
        } catch (error) {
          if (error instanceof MemoryConflictError) {
            return text(describeMemoryConflict(slug, '全文置換', error.current));
          }
          throw error;
        }
        const memoryAfter = await stores.persona.documents();
        await appendJournalOrThrow(
          'memory_write',
          stores.journal,
          {
            type: 'memory_update',
            slug,
            cause,
            action: 'write',
            bytesBefore: before === null ? 0 : Buffer.byteLength(before.content, 'utf8'),
            bytesAfter: Buffer.byteLength(written.content, 'utf8'),
            summary,
          },
          'act-completed',
        );
        const diff = describeMemoryWriteDiff(
          before === null ? null : before.content,
          written.content,
        );
        const floor = memoryFloorNote(
          memoryBefore,
          memoryAfter,
          slug,
          written.content,
          before === null,
        );
        const reinjection = describeMemoryReinjectionEstimate(
          [written],
          memoryAfter,
          seenBefore(slug, before),
        );
        const growth = memorySessionGrowthNote(memoryAfter, context.runtime?.());
        const tokenDiff = describeTokenDiff(
          before === null ? null : before.content,
          written.content,
        );
        return text(
          `記憶 ${slug} を更新した。\n\n${diff}` +
            (tokenDiff === null ? '' : `\n${tokenDiff}`) +
            `\n\n${floor}\n\n${reinjection}\n\n${growth}\n\n${versionLine(written.content)}`,
        );
      },
    ),

    tool(
      'memory_append',
      [
        '記憶の文書の末尾に追記する（無ければ作る）。既存の記述を消したくないときはこちら。',
        '成功すると memory_write と同じ差分の要約が返る（前後の文字数と、消えた見出しの名指し。見出しの数え方も同じ）。',
        '追記は既存を消さないので、消えた見出しは常に 0 件のはずである——0 件でなければ異常を疑うこと。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ'),
        content: z.string().describe('追記する Markdown'),
        summary: z.string().describe('何を追記したかの一行要約（日誌に残る）'),
      },
      async ({ slug, content, summary }) => {
        if (!memorySlugSchema.safeParse(slug).success) {
          return text(`記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const [before, memoryBefore] = await Promise.all([
          stores.persona.read(slug),
          stores.persona.documents(),
        ]);
        const written = await stores.persona.append(slug, content);
        const memoryAfter = await stores.persona.documents();
        await appendJournalOrThrow(
          'memory_append',
          stores.journal,
          {
            type: 'memory_update',
            slug,
            cause: memoryCause(),
            action: 'append',
            bytesBefore: before === null ? 0 : Buffer.byteLength(before.content, 'utf8'),
            bytesAfter: Buffer.byteLength(written.content, 'utf8'),
            summary,
          },
          'act-completed',
        );
        const diff = describeMemoryWriteDiff(
          before === null ? null : before.content,
          written.content,
        );
        const floor = memoryFloorNote(
          memoryBefore,
          memoryAfter,
          slug,
          written.content,
          before === null,
        );
        const reinjection = describeMemoryReinjectionEstimate(
          [written],
          memoryAfter,
          seenBefore(slug, before),
        );
        const growth = memorySessionGrowthNote(memoryAfter, context.runtime?.());
        return text(
          `記憶 ${slug} に追記した。\n\n${diff}\n\n${floor}\n\n${reinjection}\n\n${growth}`,
        );
      },
    ),

    // 部分削除の引数は作らない: 文書の一部を消したいなら `memory_write` の全文置換で足りる
    // 存在しないスラッグを黙って成功にしない: ストア層の `remove` は冪等で、そのまま返すと「消したつもりで何も消えていない」を作るため
    // 本文は日誌へ写さない: 記憶の中身を別の場所へ増やさないため、残すのはスラッグと文字数だけ
    tool(
      'memory_delete',
      [
        '記憶の文書を1つ、文書ごと消す（部分削除ではない。一部を変えたいだけなら memory_write を使う）。',
        '無いスラッグを渡しても成功にはならず、そう返る。',
        '**先に memory_read（または memory_outline）で読んで、応答に出る base_version を渡すこと（必須）。焼き込みの索引だけでは消せない**——読んだ後に人間や別のターンが書いていたら、何も消さずに「その間に変わった」と返す（読んでいない内容まで消さないため）。',
        '消した事実は日誌に残る（スラッグと直前の文字数のみ。本文は残らない）。',
        '**統合の走行（distill）からは、人間が一度でも書いた文書・履歴の無い文書は消せない**',
        '（断られる。ask_human で人間に確認を通せば次のターンで実行できる）。会話の中の削除は通る。',
      ].join(' '),
      {
        slug: z.string().describe('記憶のスラッグ（拡張子なし）'),
        summary: z.string().describe('なぜ消したかの一行要約（日誌に残る。本文は残らない）'),
        base_version: z
          .string()
          .optional()
          .describe(
            '読んだ時点の版（memory_read / memory_outline / 直前の書き込みの応答に出る base_version）。**必須**——無ければ何も消さずに読み直しを促す。焼き込みの索引だけでは版は分からない。',
          ),
      },
      async ({ slug, summary, base_version: baseVersion }) => {
        if (!memorySlugSchema.safeParse(slug).success) {
          return text(`記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const existing = await stores.persona.read(slug);
        if (existing === null) {
          return text(`記憶 ${slug} は存在しない（消せない。何も変わっていない）。`);
        }
        const cause = memoryCause();
        const denial = await guardFullReplace(stores, slug, cause, '削除');
        if (denial !== null) return text(denial);
        // 版なしでは消さない: 消すのは「読んだ内容を見て」の判断で、読んでいない内容まで消さないため
        if (baseVersion === undefined) {
          return text(
            `記憶 ${slug} を消すには、先に memory_read slug=${slug} で読み、` +
              '応答に出る base_version をこの呼び出しの base_version に渡すこと' +
              '（読んだ後に人間や別のターンが書いた内容を、気づかずに消さないため。焼き込みの索引だけでは消せない）。**何も消していない。**',
          );
        }
        try {
          await stores.persona.remove(slug, { ifMatch: baseVersion });
        } catch (error) {
          if (error instanceof MemoryConflictError) {
            return text(describeMemoryConflict(slug, '削除', error.current, 'remove'));
          }
          throw error;
        }
        await appendJournalOrThrow(
          'memory_delete',
          stores.journal,
          {
            type: 'memory_update',
            slug,
            cause,
            action: 'remove',
            bytesBefore: Buffer.byteLength(existing.content, 'utf8'),
            bytesAfter: 0,
            summary: `${summary}（削除直前 ${existing.content.length} 文字）`,
          },
          'act-completed',
        );
        return text(`記憶 ${slug} を消した（削除直前 ${existing.content.length} 文字）。`);
      },
    ),

    // 既に在る文書にしか使えない: 「文書を直す口」であって「作る口」ではない
    // `malformed` な frontmatter には断る: 機械が推測して組み直すと本文を食う経路ができるため
    tool(
      'memory_frontmatter_set',
      [
        '記憶の frontmatter（description・type・parent）のうち、渡したキーだけを差し替える／追加する。',
        '本文には一切触れない——本文はストアから読んだ古い content からそのまま取るので、1バイトも失われない。',
        'この道具の呼び出しの中に本文が現れることは無いので、本文が途中で切れることも構造的に起こりえない。',
        'description・type・parent の値に改行（\\n / \\r）を含む値は渡せない（断る）——値から本文へ文字列が混ざる経路を構造的に無くすため。',
        '既に在る文書にしか使えない（存在しない slug には断る。新規作成は memory_write を使うこと）。',
        '**先に memory_read（または memory_outline）で読んで、応答に出る base_version を渡すこと（必須）。焼き込みの索引（プロンプトに載った premise のカード等）だけでは書けない**——読んだ後に人間が要旨などを直していたら、何も書かずに「その間に変わった」と返す（渡したキーで人間の直しを上書きしないため）。',
        'frontmatter が無い文書には、先頭に新しく frontmatter を作って足す（type を渡さなければ premise のまま——載り方は変わらない）。',
        'frontmatter が壊れている（malformed）文書には断る（機械が推測して組み直すと本文を食う経路ができるため）。',
        'memory_write で全文を書き直すか、人間に確認を通すこと。',
        'description・type・parent のうち少なくとも1つを渡すこと（1つも渡さない呼びは断る。何も変わらない）。',
        'type に渡せるのは premise・indexed・fact のいずれかだけ（それ以外の値は断る。綴りを間違えたまま黙って書かない）。',
        'premise は「要旨＋節の目次」がプロンプトへ焼かれ、indexed は要旨だけが焼かれて節の目次は焼かれない（節を確かめるにはまず memory_outline を呼ぶこと）、fact は目次の1行だけになる（どれも本文は焼かれない）。区分が変わったときは、その変化が応答に出る。',
        '**統合の走行（distill）からは、人間が一度でも書いた文書・履歴の無い文書には使えない**',
        '（断られる。ask_human で人間に確認を通せば次のターンで実行できる）。会話の中の書き込みは通る。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（拡張子なし）'),
        description: z
          .string()
          .optional()
          .describe('要旨（目次の1行に載る）。渡さなければ既存の値のまま'),
        type: z
          .string()
          .optional()
          .describe(
            'premise・indexed・fact のいずれかのみ（それ以外は断る）。渡さなければ既存の値のまま（既定は premise）',
          ),
        parent: z.string().optional().describe('親文書の slug（階層）。渡さなければ既存の値のまま'),
        summary: z.string().describe('何を直したかの一行要約（日誌に残る）'),
        base_version: z
          .string()
          .optional()
          .describe(
            '読んだ時点の版（memory_read / memory_outline / 直前の書き込みの応答に出る base_version）。**必須**——無ければ何も書かずに読み直しを促す。焼き込みの索引だけでは版は分からない。',
          ),
      },
      async ({ slug, description, type, parent, summary, base_version: baseVersion }) => {
        if (!memorySlugSchema.safeParse(slug).success) {
          return text(`記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        if (description === undefined && type === undefined && parent === undefined) {
          return text(
            `記憶 ${slug} の frontmatter を直すには description・type・parent のうち少なくとも1つを渡すこと` +
              '（何も変わっていない）。',
          );
        }

        // 改行を含む値は入口（ストアを読む前）で断る: 値の続きが別のキー・閉じの `---`・本文の1行目として紛れ込むため
        // 断りには文字数・改行の位置・抜粋を名乗らせる: 呼び手が改行を探し続けて直し方を誤らないため
        const lineBreakInputs: readonly ['description' | 'type' | 'parent', string | undefined][] =
          [
            ['description', description],
            ['type', type],
            ['parent', parent],
          ];
        for (const [lineBreakKey, value] of lineBreakInputs) {
          if (value === undefined) continue;
          const lineBreak = findMemoryFrontmatterLineBreak(value);
          if (lineBreak === null) continue;
          const charLabel = lineBreak.char === '\r' ? '\\r' : '\\n';
          return text(
            `記憶 ${slug} の frontmatter を更新できない——${lineBreakKey} に改行（\\n / \\r）を含む値は渡せない` +
              '（frontmatter は1キー1行で書く約束なので、改行が入ると値の続きが本文や他のキーと混ざる）。' +
              `渡された ${lineBreakKey} は全 ${value.length} 文字、${lineBreak.position} 文字目に ${charLabel} が在る` +
              `（前後の抜粋: "${lineBreak.excerpt}"）。何も変わっていない。`,
          );
        }

        // `type` は自由文字列で受けない: 綴り違いが書かれると区分は変わらないのに `kindChangeNote` が空になり、書き手に「変えた」つもりだけが残るため
        if (type !== undefined && !isKnownMemoryDocKind(type)) {
          return text(
            `記憶 ${slug} の frontmatter を更新できない——type に渡せるのは premise か fact か indexed のいずれかだけである` +
              `（渡された値: ${JSON.stringify(type)}）。何も変わっていない。`,
          );
        }

        const existing = await stores.persona.read(slug);
        if (existing === null) {
          return text(
            `記憶 ${slug} は存在しない（frontmatter を直せない。新規作成は memory_write を使うこと。` +
              '何も変わっていない）。',
          );
        }

        const cause = memoryCause();
        const denial = await guardFullReplace(stores, slug, cause, 'frontmatter の更新');
        if (denial !== null) return text(denial);

        if (baseVersion === undefined) {
          return text(
            `記憶 ${slug} の frontmatter を直すには、先に memory_read slug=${slug} で読み、` +
              '応答に出る base_version をこの呼び出しの base_version に渡すこと' +
              '（読んだ後に人間が要旨などを直していても、渡したキーで上書きしないため。焼き込みの索引だけでは書けない）。**何も書いていない。**',
          );
        }

        const priorFrontmatter = parseMemoryFrontmatter(existing.content);
        if (priorFrontmatter.kind === 'malformed') {
          return text(
            `記憶 ${slug} の frontmatter が壊れている（malformed）。ここでは直さない——` +
              '機械が推測して組み直すと本文を食う経路ができるため。memory_write で全文を書き直すか、' +
              '人間に確認を通すこと（何も変わっていない）。',
          );
        }

        const priorKind = resolveMemoryDocKind(priorFrontmatter);
        const nextContent = applyMemoryFrontmatterPatch(existing.content, {
          description,
          type,
          parent,
        });
        const memoryBefore = await stores.persona.documents();
        let written;
        try {
          written = await stores.persona.write(slug, nextContent, { ifMatch: baseVersion });
        } catch (error) {
          if (error instanceof MemoryConflictError) {
            return text(describeMemoryConflict(slug, 'frontmatter の更新', error.current));
          }
          throw error;
        }
        const memoryAfter = await stores.persona.documents();
        const nextKind = resolveMemoryDocKind(parseMemoryFrontmatter(written.content));

        await appendJournalOrThrow(
          'memory_frontmatter_set',
          stores.journal,
          {
            type: 'memory_update',
            slug,
            cause,
            action: 'describe',
            bytesBefore: Buffer.byteLength(existing.content, 'utf8'),
            bytesAfter: Buffer.byteLength(written.content, 'utf8'),
            summary,
          },
          'act-completed',
        );

        const diff = describeMemoryWriteDiff(existing.content, written.content);
        const kindLabel = (kind: MemoryDocKind): string => {
          switch (kind) {
            case 'premise':
              return 'premise（要旨＋節の目次が載る）';
            case 'indexed':
              return 'indexed（要旨だけが載る。節の目次は載らない）';
            case 'fact':
              return 'fact（目次の1行だけ載る）';
            default:
              return assertNeverMemoryDocKind(kind);
          }
        };
        const describeNextKindLoad = (kind: MemoryDocKind): string => {
          switch (kind) {
            case 'fact':
              return '次のターンから、この文書は目次の1行だけになる（節の目次も載らなくなる）。';
            case 'indexed':
              return (
                '次のターンから、この文書は要旨だけがプロンプトへ載る（節の目次は載らない。' +
                '節を確かめるには memory_outline を呼び、memory_section_read で開くこと）。'
              );
            case 'premise':
              return '次のターンから、この文書は要旨と節の目次がプロンプトへ載る（本文は載らない。memory_section_read で開く）。';
            default:
              return assertNeverMemoryDocKind(kind);
          }
        };
        const kindChangeNote =
          priorKind === nextKind
            ? ''
            : `\n\n区分が変わった: ${kindLabel(priorKind)} → ${kindLabel(nextKind)}。` +
              describeNextKindLoad(nextKind);
        const floor = memoryFloorNote(memoryBefore, memoryAfter, slug, written.content, false);
        const reinjection = describeMemoryReinjectionEstimate(
          [written],
          memoryAfter,
          seenBefore(slug, existing),
        );
        const growth = memorySessionGrowthNote(memoryAfter, context.runtime?.());

        return text(
          `記憶 ${slug} の frontmatter を更新した。\n\n${diff}${kindChangeNote}\n\n${floor}\n\n${reinjection}\n\n${growth}`,
        );
      },
    ),

    // 本文は1文字も返さない: 返すと「文脈へ入れずに構造を見る」という存在理由を潰すため
    // `malformed` な frontmatter でも目次は返す: 読むだけで断る理由が無いが、`memory_section_move` が断ることは応答に書く
    // `side` だけにしない: 中央の節へ届かないため、`q` と `offset` で届く道を足してある
    tool(
      'memory_outline',
      [
        '記憶の文書の目次を返す（読むだけ。1文字も書き換えない）。',
        '各行は `[節id] 見出し行 — N 文字` で、インデントが見出しの深さを表す。文字数は入れ子の子を含むので、その節を動かしたときに動く量がそのまま出る。',
        '本文は1文字も返さない（本文が要るなら memory_read）。frontmatter の行も出ない。',
        '節id は memory_section_move の指し先であると同時に、その節の版の照合でもある——中身が変われば id も変わるので、目次を読んでから移すまでの間に誰かがその節を書き換えていたら断られる。移す直前に取り直すこと。',
        '中身まで同一の節が2つあると id が衝突する。その行には印が付き、その id では動かせない。',
        '目次は文字数の予算で切る。既定（side を渡さない）では先頭から詰めるので、落ちるのは末尾側である——大きな文書では新しく積んだ節の節id が出てこない。side=tail を渡すと末尾から詰め、落ちるのは先頭側になる。⚠どちらの向きでも中央は出ない（side だけでは届かない）。',
        '中央へ届く道は2つある。q=<文字列> は見出しをその文字列で絞り込む（大文字小文字を区別しない部分一致。正規表現ではない）——一致した節がそのまま目次と同じ形で出るので memory_section_read / memory_section_move へ渡せる。offset=<N> は先頭から N 節飛ばしてから予算を埋める——応答が返す次の offset の値ぶんずつ進めれば、文書がどれだけ大きくても有限回で全節に届く。offset を渡すと side は見ない。q も offset も渡さなければ出力は今までと同じ。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（拡張子なし）'),
        side: z
          .enum(MEMORY_OUTLINE_SIDES)
          .optional()
          .describe(
            '予算に入りきらないとき、どちら側を出すか。head（既定。渡さなければ従来と同じ出力）は先頭から詰めて末尾側を落とす。tail は末尾から詰めて先頭側を落とす。⚠中央はどちらでも出ない。offset を渡すときは見ない。',
          ),
        q: z
          .string()
          .optional()
          .describe(
            `見出しをこの文字列で絞り込む（${formatStringLengthJa({ min: 1 })}。大文字小文字を区別しない部分一致。正規表現ではない——メタ文字を含んでいても文字どおりにしか一致しない）。side と併用できる（絞り込んだ結果をどちらから詰めるか）。一致0件と、一致はあるが予算で切れた場合は別の文言で返る。`,
          ),
        offset: z
          .number()
          .optional()
          .describe(
            `先頭から何節を飛ばしてから予算を埋めるか（${formatIntRangeJa({ min: 0 })}。0起点）。応答が返す次の offset ぶんずつ進めれば、有限回の呼び出しで全節に届く（中央へ届くことを保証する側）。渡すと side は見ない。q と併用でき、その場合は絞り込んだ結果に対して窓を開く。範囲外（節数以上）なら断る。`,
          ),
      },
      async ({ slug, side, q, offset }) => {
        if (!memorySlugSchema.safeParse(slug).success) {
          return text(`記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        const qError = describeStringLengthViolation('q', q, { min: 1 });
        if (qError !== null) return text(qError);
        const doc = await stores.persona.read(slug);
        if (doc === null) return text(`記憶 ${slug} は存在しない。`);
        const { sections } = scanMemorySections(doc.content);
        const malformedNote =
          parseMemoryFrontmatter(doc.content).kind === 'malformed'
            ? '\n\n⚠この文書の frontmatter は壊れている（malformed）。目次はこのまま読めるが、' +
              'memory_section_move はこの文書を断る（memory_write で全文を書き直すか、人間に確認を通すこと）。'
            : '';
        return text(
          `記憶 ${slug} の目次（${sections.length} 節）。本文は含まない。\n\n` +
            `${renderMemoryOutline(sections, { side, q, offset })}${malformedNote}\n\n${versionLine(doc.content)}`,
        );
      },
    ),

    // 断りを畳まない: 読み直せば済むのか指し先が間違っているのかが区別できなくなるため
    // 1つが読めなくても、読めた節は返す: 全部を断ると読めた分のターンが無駄になるため
    tool(
      'memory_section_read',
      [
        '記憶の文書の、節id で指した節の本文を開く（読むだけ。1文字も書き換えない）。',
        '節id は毎ターンの焼き込み（premise のカード）と memory_outline に出ている——目次を取り直さなくてもそのまま渡せる。',
        '複数の節id を1回で渡せる。返る順序は文書に現れる順である。',
        '読めなかった節id は理由ごとに分けて言う（古い＝誰かが書き換えた／同一の節が複数／そもそも無い）。読めた節は返る。',
        '入れ子の子は親に含まれる（親の節id を渡せば子も一緒に開く）。',
        '応答は文字数の予算で切る。切ったらそう言う。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（拡張子なし）'),
        sections: z
          .array(z.string())
          .describe(
            `開く節の節id（複数可。${formatArrayLengthJa({ min: 1 })}）。焼き込みのカードか memory_outline に出ているもの`,
          ),
      },
      async ({ slug, sections: requested }) => {
        if (!memorySlugSchema.safeParse(slug).success) {
          return text(`記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const sectionsError = describeArrayLengthViolation('sections', requested, { min: 1 });
        if (sectionsError !== null) return text(sectionsError);
        const doc = await stores.persona.read(slug);
        if (doc === null) return text(`記憶 ${slug} は存在しない。`);
        const { sections } = scanMemorySections(doc.content);

        const found: { id: string; section: MemorySection }[] = [];
        const refusals: string[] = [];
        for (const id of requested) {
          const lookup = lookupMemorySection(sections, id);
          switch (lookup.kind) {
            case 'found':
              found.push({ id, section: lookup.section });
              break;
            case 'stale':
              refusals.push(
                `- ${id}: **その id は古い**（見出しは一致するが中身が違う＝誰かが書き換えた）。` +
                  'memory_outline で取り直すこと。',
              );
              break;
            case 'ambiguous':
              refusals.push(
                `- ${id}: 中身まで同一の節が ${lookup.sections.length} 箇所に在り、1つに決まらない。` +
                  '見出しを変えて区別を付けること。',
              );
              break;
            case 'absent':
              refusals.push(
                `- ${id}: その節id はこの文書に無い（打ち間違いか、別の文書か、見出しごと書き換えられた）。`,
              );
              break;
            default: {
              const exhaustive: never = lookup;
              throw new Error(`未知の節id の引き当て結果: ${JSON.stringify(exhaustive)}`);
            }
          }
        }

        found.sort((a, b) => a.section.start - b.section.start);
        const bodies = found.map(
          ({ id, section }) =>
            `[${id}] ${section.heading}\n${doc.content.slice(section.start, section.end).trimEnd()}`,
        );

        const listing =
          bodies.length === 0
            ? '（1節も開けなかった）'
            : renderListing(bodies, {
                budget: MEMORY_PAGE,
                omitted: ({ rest, shown, total }) =>
                  `…ほか ${rest} 節は応答から省略（${total} 節のうち ${shown} 節だけ返した）。` +
                  '残りは節id を分けて呼び直すこと（この道具は何も書き換えていないので、呼び直しは安全である）。',
              });

        const refusalNote =
          refusals.length === 0 ? '' : `\n\n読めなかった節:\n${refusals.join('\n')}`;
        return text(
          `記憶 ${slug} の節を ${found.length} 件開いた（この文書は全 ${sections.length} 節）。\n\n` +
            `${listing}${refusalNote}`,
        );
      },
    ),

    // 全件を先に照合してから動かす: 部分成功だと呼び手がどこまで動いたかを応答から逆算することになるため
    // 先に足して、後で消す: 2文書をまたぐトランザクションが無く、途中で落ちたとき残るのを消失ではなく重複にするため
    // 3層目の frontmatter 検査は到達しないが残す: 継ぎ足しをやめて組み直す形に変えたとき「本文だったものが frontmatter に化ける」を守る唯一の検査のため
    tool(
      'memory_section_move',
      [
        'memory_outline が出した節id（複数可）で指した節を、別の文書の末尾へまとめて移す（切り取って足す）。移し先が無ければ作る。',
        '本文はこの呼び出しにも応答にも一度も現れない（0文字）——これがこの道具の存在理由である。大きな文書を割るのに本文を作り直さなくてよい。',
        '節の範囲は見出し行から「同じ深さ以下の次の見出しの直前」までで、入れ子の子は一緒に動く。frontmatter は節ではないので指せない。',
        '先に移し先へ足し、後から出どころを消す——途中で落ちれば同じ節が両方に残る（重複するが、失われない）。そのときはそう返る。',
        // 断りの数を書かない: 数で名乗ると抜けや到達しない断りの扱いで腐るため列挙だけにする
        '断るのは: from と to が同じ／出どころの文書がそもそも無い（slug の打ち間違い）／出どころの frontmatter が壊れている／その id の節が無い／その id は古い（中身が書き換えられた。memory_outline を取り直すこと）／中身まで同じ節が複数あって id が曖昧（どちらかを選ばずに断る）／指定した節どうしの範囲が重なっている（親子関係や同じ id の重複）。',
        '⭐1つでも断りに当たれば、1節も動かさない——一部だけ動いて残りが断られる、ということは起きない。',
        '**⭐この口だけは、統合の走行（distill）からでも、人間が一度でも書いた文書・履歴の無い文書に対して通る**',
        '（2026-09-08 に緩めた。全文置換・削除・frontmatter の更新はいまも断る。移動は先に移し先へ足してから出どころを消すので、どの瞬間にも本文がどこかに在る＝失われない。だから保護状態を見ずに通す）。移し先には歯が掛からない（追記なので）。',
      ].join(' '),
      {
        fromSlug: z.string().describe('節を切り取る側の文書のスラッグ'),
        sections: z
          .array(z.string())
          .describe(
            `memory_outline が出した節id（\`[...]\` の中身）。複数渡せる——1回で全部移る（${formatArrayLengthJa({ min: 1 })}）。渡す順ではなく文書に現れる順で移し先の末尾に並ぶ`,
          ),
        toSlug: z.string().describe('節を足す側の文書のスラッグ（無ければ作る）'),
        summary: z.string().describe('なぜ移したかの一行要約（日誌に残る。本文は残らない）'),
      },
      async ({ fromSlug, sections: ids, toSlug, summary }) => {
        if (!memorySlugSchema.safeParse(fromSlug).success) {
          return text(`記憶のスラッグが不正: ${fromSlug}（英小文字・数字・. _ - のみ）。`);
        }
        if (!memorySlugSchema.safeParse(toSlug).success) {
          return text(`記憶のスラッグが不正: ${toSlug}（英小文字・数字・. _ - のみ）。`);
        }
        const sectionsError = describeArrayLengthViolation('sections', ids, { min: 1 });
        if (sectionsError !== null) return text(sectionsError);
        if (fromSlug === toSlug) {
          return text(
            `from と to が同じ文書（${fromSlug}）である。節の移動先は別の文書でなければならない` +
              '（同じ文書の中で節を動かす口はここには無い）。何も変わっていない。',
          );
        }

        const existing = await stores.persona.read(fromSlug);
        if (existing === null) {
          return text(`記憶 ${fromSlug} は存在しない（節を移せない。何も変わっていない）。`);
        }

        const cause = memoryCause();
        const denial = await guardFullReplace(stores, fromSlug, cause, '節の移動');
        if (denial !== null) return text(denial);

        const priorFrontmatter = parseMemoryFrontmatter(existing.content);
        if (priorFrontmatter.kind === 'malformed') {
          return text(
            `記憶 ${fromSlug} の frontmatter が壊れている（malformed）。ここでは節を移さない——` +
              '本文の始まる位置が決まらないので、frontmatter を本文として運ぶ経路ができる。' +
              'memory_write で全文を書き直すか、人間に確認を通すこと（何も変わっていない）。',
          );
        }

        const scan = scanMemorySections(existing.content);
        const lookups = ids.map((id) => ({ id, lookup: lookupMemorySection(scan.sections, id) }));
        const failures = lookups.filter(
          (
            entry,
          ): entry is { id: string; lookup: Exclude<MemorySectionLookup, { kind: 'found' }> } =>
            entry.lookup.kind !== 'found',
        );
        if (failures.length > 0) {
          const first = failures[0] as {
            id: string;
            lookup: Exclude<MemorySectionLookup, { kind: 'found' }>;
          };
          const base = describeMemorySectionLookupFailure(fromSlug, first.id, first.lookup);
          if (ids.length === 1) return text(base);

          const rest = failures.slice(1);
          const restCounts = { absent: 0, stale: 0, ambiguous: 0 } as Record<
            Exclude<MemorySectionLookup, { kind: 'found' }>['kind'],
            number
          >;
          for (const entry of rest) restCounts[entry.lookup.kind] += 1;
          // id を全部並べない: 90個渡されたとき応答がその数だけ膨らむため
          const restLine =
            rest.length > 0
              ? `\nほかにも解決できなかった節id が ${rest.length} 件ある` +
                `（無い ${restCounts.absent} 件・古い ${restCounts.stale} 件・曖昧 ${restCounts.ambiguous} 件）。`
              : '';
          const allOrNothingLine =
            '\nこの口は全件が見つかったときしか動かさない——1つでも解決できなければ、' +
            `今回指定した他の ${ids.length - 1} 節も含めて1節も移していない。`;
          return text(`${base}${restLine}${allOrNothingLine}`);
        }

        const targets = lookups.flatMap((entry) =>
          entry.lookup.kind === 'found' ? [entry.lookup.section] : [],
        );

        const overlap = findOverlappingMemorySections(targets);
        if (overlap !== null) {
          return text(
            `節id ${overlap.first.id}（「${overlap.first.heading}」）と ${overlap.second.id}` +
              `（「${overlap.second.heading}」）の範囲が重なっている。片方がもう片方の中に` +
              '入れ子になっている節を親子まとめて指した（`end` は子込みなので、親を切ると' +
              '渡していないつもりの子も一緒に動く）か、同じ節id を2回渡したか（範囲が完全に' +
              '一致する）のどちらかである——**どちらの形でも断る**。memory_outline で目次を' +
              '取り直し、重ならない組で渡し直すこと。何も変わっていない' +
              '（出どころも移し先も、1文字も動いていない）。',
          );
        }

        // `ordered` を自分で並べ替え直さない: 並び順の規則は `cutMemorySections` が1箇所で持つため
        const { nextContent, cut, ordered } = cutMemorySections(existing.content, targets);

        const priorHeader = existing.content.slice(0, scan.bodyStart);
        const nextHeader = nextContent.slice(0, scan.bodyStart);
        const nextFrontmatter = parseMemoryFrontmatter(nextContent);
        if (nextHeader !== priorHeader || nextFrontmatter.kind !== priorFrontmatter.kind) {
          return text(
            `記憶 ${fromSlug} から指定した節を切り取ると、frontmatter の解釈が変わってしまう` +
              `（${priorFrontmatter.kind} → ${nextFrontmatter.kind}）。断った——この道具は` +
              'frontmatter を1バイトも動かさないと約束しているので、約束が破れる切り取りは行わない。' +
              '何も変わっていない（出どころも移し先も、1文字も動いていない）。',
          );
        }

        const [toBefore, memoryBefore] = await Promise.all([
          stores.persona.read(toSlug),
          stores.persona.documents(),
        ]);

        // 移し先に同じ節id が既に在るものは追記から外す: 半完了からの再実行で同じ節が増えると `ambiguous` になり、その id が二度と指せなくなるため
        const destIds = new Set(
          toBefore === null ? [] : scanMemorySections(toBefore.content).sections.map((s) => s.id),
        );
        const toAppend = ordered.filter((section) => !destIds.has(section.id));
        const alreadyAtDestination = ordered.filter((section) => destIds.has(section.id));

        let toWritten: Awaited<ReturnType<Stores['persona']['append']>>;
        let appendedChars = 0;
        if (toAppend.length > 0) {
          const appendText = toAppend
            .map((section) => existing.content.slice(section.start, section.end))
            .join('');
          appendedChars = appendText.length;
          toWritten = await stores.persona.append(toSlug, appendText);
          await appendJournalOrThrow(
            'memory_section_move',
            stores.journal,
            {
              type: 'memory_update',
              slug: toSlug,
              cause,
              action: 'move_in',
              bytesBefore: toBefore === null ? 0 : Buffer.byteLength(toBefore.content, 'utf8'),
              bytesAfter: Buffer.byteLength(toWritten.content, 'utf8'),
              summary:
                alreadyAtDestination.length > 0
                  ? `${summary}（${alreadyAtDestination.length} 節は ${toSlug} に既に在ったため追記しなかった）`
                  : summary,
            },
            'act-partially-completed',
          );
        } else {
          if (toBefore === null) {
            throw new Error(
              '到達しないはずの分岐: toBefore が無いのに toAppend が0件になった' +
                '（#1230 の冪等化ロジックの前提が崩れている）。',
            );
          }
          // 追記そのものを行わない: 空文字列を `persona.append` に渡すと fs/pg どちらも書き込みが起き、末尾に空行が増え `updatedAt` が進むため
          toWritten = toBefore;
        }

        let fromWritten;
        try {
          fromWritten = await stores.persona.write(fromSlug, nextContent, {
            ifMatch: memoryVersion(existing.content),
          });
        } catch (error) {
          const reason =
            error instanceof MemoryConflictError
              ? `${fromSlug} が読んだ後にその間に変わった（人間または別のターンが書いた）ので、書かなかった`
              : reasonOf(error);
          if (toAppend.length > 0) {
            // 「移した」と返さない: 呼び手が重複に気づけなくなるため
            const dedupNote =
              alreadyAtDestination.length > 0
                ? ` このうち ${alreadyAtDestination.length} 節は ${toSlug} に既に在ったため、今回は追記していない（重複は増えていない）。`
                : '';
            return text(
              `⚠ ${toAppend.length} 節（合計 ${appendedChars.toLocaleString('en-US')} 文字）を ${toSlug} の末尾へ足すところまでは済んだが、` +
                `${fromSlug} からの切り取りに失敗した（${reason}）。` +
                `いま同じ ${toAppend.length} 節が ${fromSlug} と ${toSlug} の両方に在る——**重複しているが、失われてはいない。**` +
                `${dedupNote}` +
                `${fromSlug} 側は1文字も変わっていない。memory_outline で ${fromSlug} を読み直し、` +
                '同じ操作をやり直すか、重複したままにするかを決めること。',
            );
          }
          return text(
            `${ordered.length} 節は ${toSlug} に既に同じ節id の節が在ったため、今回は何も追記していない。` +
              `そのうえで ${fromSlug} からの切り取りを試みたが失敗した（${reason}）。` +
              `${fromSlug} 側は1文字も変わっていない。重複は増えていない——前回までの重複があるなら、それがそのまま残っている状態である。` +
              `memory_outline で ${fromSlug} と ${toSlug} を読み直してから、同じ操作をやり直すこと。`,
          );
        }
        await appendJournalOrThrow(
          'memory_section_move',
          stores.journal,
          {
            type: 'memory_update',
            slug: fromSlug,
            cause,
            action: 'move_out',
            bytesBefore: Buffer.byteLength(existing.content, 'utf8'),
            bytesAfter: Buffer.byteLength(fromWritten.content, 'utf8'),
            summary:
              toAppend.length === 0 && alreadyAtDestination.length > 0
                ? `${summary}（${alreadyAtDestination.length} 節は ${toSlug} に既に在ったため追記しなかった。切り取りのみ行った）`
                : summary,
          },
          'act-completed',
        );

        const memoryAfter = await stores.persona.documents();
        const floor = memoryFloorNote(
          memoryBefore,
          memoryAfter,
          toSlug,
          toWritten.content,
          toBefore === null,
        );
        const reinjection = describeMemoryReinjectionEstimate(
          [toWritten, fromWritten],
          memoryAfter,
          new Map([...seenBefore(toSlug, toBefore), ...seenBefore(fromSlug, existing)]),
        );
        const growth = memorySessionGrowthNote(memoryAfter, context.runtime?.());

        // 古い本文を1文字も出さない: 出せば文脈に入り、この道具の存在理由が消えるため
        const listing = renderListing(
          ordered.map(
            (section) =>
              `- 「${section.heading}」（節id ${section.id}、${section.chars.toLocaleString('en-US')} 文字）`,
          ),
          {
            budget: MEMORY_SECTION_MOVE_LIST_BUDGET,
            omitted: ({ rest, shown, total }) =>
              `…ほか ${rest} 節は一覧から省略（移した ${total} 節のうち ${shown} 節だけ出した。` +
              `移動は済んでいる——省いた節も含めて、移った先の見出しは memory_outline slug=${toSlug} で見える）。`,
          },
        );

        // 追記しなかった分も応答の本文で名乗る: 冪等にした結果が何も起きなかったように見える応答になるため
        const idempotentNote =
          alreadyAtDestination.length > 0
            ? [
                '',
                `⭐ このうち ${alreadyAtDestination.length} 節は ${toSlug} に同じ節id の節が既に在ったため、追記していない` +
                  `（今回 ${toSlug} へ新しく足したのは ${toAppend.length} 節）。重複は増えていない——` +
                  '半完了から同じ呼び出しをやり直しても、移し先の節は増えない。' +
                  `どの節が既に在ったかは memory_outline slug=${toSlug} で確かめられる。`,
              ]
            : [];

        const hierarchyJumpNote = ((): readonly string[] => {
          const warning = describeMemorySectionMoveHierarchyJumpWarning(scan.sections, targets);
          return warning === null ? [] : ['', warning];
        })();

        return text(
          [
            `記憶 ${fromSlug} から ${ordered.length} 節（合計 ${cut.length.toLocaleString('en-US')} 文字）を ${toSlug} の末尾へ移した。`,
            '',
            listing,
            ...idempotentNote,
            ...hierarchyJumpNote,
            '',
            `移した先 ${toSlug}:`,
            describeMemoryWriteDiff(toBefore === null ? null : toBefore.content, toWritten.content),
            '',
            `出どころ ${fromSlug}:`,
            describeMemoryWriteDiff(existing.content, fromWritten.content),
            '',
            floor,
            '',
            reinjection,
            '',
            growth,
          ].join('\n'),
        );
      },
    ),

    // `grounds` を必須にしない: 長い本文の後ろに必須の引数が残る形を持つのはこの道具だけで、呼び出しの組み立て破損で選択的に落ちるため
    // 届かなかった `grounds` を「根拠なし」と同じ文字列にしない: 「無い」の種類が潰れるため
    tool(
      'journal_write',
      [
        '判断を日誌に残す（追記専用）。',
        '人間に聞かずに実行した判断は必ずここに残すこと。',
        '人間が後から読んで否定できることが、最終承認の実体である。',
        'grounds を省くと、根拠は「呼び出しに届かなかった」として記録される（「根拠なし」とは区別される）。根拠が記憶に無いと判断したなら、省かずに「根拠なし」と書いて渡す。',
      ].join(' '),
      {
        decision: z.string().describe('何を判断し、何をしたか'),
        grounds: z
          .string()
          .optional()
          .describe(
            '記憶のどこに根拠があったか。無いなら「根拠なし」と書く。省いた呼び出しも記録は通るが、根拠は「届かなかった」として残る',
          ),
      },
      async ({ decision, grounds }) => {
        // 省いた回は日誌の本文で名乗り `self_dropped` にも跡を残す: 道具は成功しているので、ここで残さないと「根拠が届かなかった」がどこにも出ないため
        if (grounds === undefined) {
          noteDroppedRecord(
            '判断の根拠（journal_write の grounds）',
            `decision.chars=${decision.length}`,
            new Error('呼び出しに grounds が届かなかった（issue #1338）'),
          );
        }
        const entry = await appendJournalOrThrow(
          'journal_write',
          stores.journal,
          { type: 'decision', decision, grounds: grounds ?? GROUNDS_NOT_DELIVERED },
          'act-not-performed',
        );
        return text(
          grounds === undefined
            ? `日誌に記録した（${entry.id}）。⚠ grounds が呼び出しに届かなかったので、` +
                '根拠は「届かなかった」として残してある（あなたが「根拠なし」と' +
                '書いた場合とは区別してある）。根拠が在るなら、もう一度 grounds 付きで' +
                '呼べば別の行として残る。'
            : `日誌に記録した（${entry.id}）。`,
        );
      },
    ),

    // 全文を素で並べない: 出力上限で丸ごと落ちてクローンに1文字も届かないため、予算で抜粋にする
    tool(
      'journal_read',
      [
        '日誌を新しい順に読む。過去の一点を掘るには since/until で窓を閉じること',
        '（新しい順に返るので、until を指定しないと最新分しか見えない）。',
        '一覧の本文は抜粋で、全文が要る1件は id を渡して取る。',
        'q で本文を語で探せる（他の絞りと併用できる）。',
        '**q が当たらないことは「日誌にその語が無い」を意味しない** —',
        `${JOURNAL_SEARCH_UNCOVERED_LIST} は探す対象に入っていない。`,
        'with で exchange の相手を絞れる（他の絞りと併用できる）。',
        '**with を指定すると exchange 以外の種別は1件も返らない** —',
        'types で別途除く必要はない。',
        '応答に「続きは journal_read afterId=… afterAt=…」と出たら、その2つをそのまま渡すと',
        'その行の次（新しい順なら、より古い側）から読み継げる（ほかの絞りは同じものを渡す）。',
        '頁の行が全部読めない形だったときも、これで読めない区間の向こうへ進める。',
      ].join(' '),
      {
        limit: z
          .number()
          .optional()
          .describe(`件数（${formatIntRangeJa({ min: 1, max: 200 })}。既定 20）`),
        since: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以降だけ返す（例 2026-08-15T09:00:00Z）'),
        until: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以前だけ返す。過去を掘るときはこれを指定する'),
        types: z
          .array(z.enum(JOURNAL_ENTRY_TYPES))
          .optional()
          .describe('種別で絞る。省略すると全種別'),
        // 説明文は `conversation_read` の `q` と変えない: 同じ語で探す口の言い方が違うと違う意味論を疑われるため
        q: z
          .string()
          .optional()
          .describe('語で探す（大文字小文字を区別しない部分一致）。他の絞りと併用できる'),
        // キー名は `JournalQuery.with` に合わせて `with` のまま: 新しい呼び方を作らないため
        with: z
          .array(z.enum(EXCHANGE_WITH_VALUES))
          .optional()
          .describe('exchange の相手（human/manager/self）で絞る。省略すると絞らない'),
        id: z
          .string()
          .optional()
          .describe('この1件を全文で読む（一覧に出ている id）。他の条件は無視される'),
        offset: z
          .number()
          .optional()
          .describe(`id で全文を読むとき、何文字目から読むか（${formatIntRangeJa({ min: 0 })}）`),
        afterId: z
          .string()
          .optional()
          .describe(
            '続きの位置の id。応答に出た「続きは journal_read afterId=… afterAt=…」の値をそのまま渡す。' +
              'afterAt と必ず対で渡す。この行の次から読む',
          ),
        afterAt: z
          .string()
          .optional()
          .describe(
            '続きの位置の時刻（ISO 8601）。afterId と必ず対で渡す。応答に出た値をそのまま渡すこと',
          ),
      },
      async ({
        limit,
        since,
        until,
        types,
        q,
        with: withFilter,
        id,
        offset = 0,
        afterId,
        afterAt,
      }) => {
        const limitError = describeIntRangeViolation('limit', limit, { min: 1, max: 200 });
        if (limitError !== null) return text(limitError);
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        if (id !== undefined) {
          let entry: JournalEntry | null;
          try {
            entry = await stores.journal.get(id);
          } catch (error) {
            // 在るが読めない行を「無い」と言わない
            if (error instanceof UnreadableJournalEntryError)
              return text(describeUnreadableJournalEntry('日誌', id));
            throw error;
          }
          if (!entry) return text(`日誌 ${id} は無い（id が違うか、まだ書かれていない）。`);
          const { head, body } = renderJournalEntry(entry);
          if (body === '') return text(`${entry.at} ${head}`);
          const part = page(body, offset, JOURNAL_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは journal_read id=${entry.id} offset=${part.to}）`
            : '';
          return text(`${entry.at} ${head}（${describePage(part)}）\n\n${part.body}${tail}`);
        }

        // since/until を `toISOString()` へ正規化してからストアへ渡す: pg は時刻で比べるが fs・インメモリは文字列比較で、秒の省略やオフセットで3実装の答えが割れるため
        if (since !== undefined && normalizeJournalTimeBoundary(since) === null) {
          return text(
            describeUnreadableJournalTimeBoundary('since', since) + '**日誌は読んでいない。**',
          );
        }
        if (until !== undefined && normalizeJournalTimeBoundary(until) === null) {
          return text(
            describeUnreadableJournalTimeBoundary('until', until) + '**日誌は読んでいない。**',
          );
        }
        // `afterAt` は正規化しない: 錨の `at` と文字列で一致させる値のため、応答の値をそのまま渡させる
        if ((afterId === undefined) !== (afterAt === undefined)) {
          return text(
            'afterId と afterAt は両方一緒に渡す（片方だけでは続きの位置が決まらない。' +
              '応答の「続きは …」の2つをそのまま渡すこと）。**日誌は読んでいない。**',
          );
        }
        if (afterAt !== undefined && Number.isNaN(Date.parse(afterAt))) {
          return text(
            `afterAt に渡された「${afterAt}」は日時として読めない（ISO 8601 で、` +
              '応答の「続きは …」の値をそのまま渡すこと）。**日誌は読んでいない。**',
          );
        }
        const normalizedSince =
          since === undefined ? undefined : (normalizeJournalTimeBoundary(since) ?? undefined);
        const normalizedUntil =
          until === undefined ? undefined : (normalizeJournalTimeBoundary(until) ?? undefined);

        const requested = limit ?? 20;
        let journalPage: Awaited<ReturnType<JournalStore['listPage']>>;
        try {
          journalPage = await stores.journal.listPage({
            limit: requested,
            ...(normalizedSince === undefined ? {} : { since: normalizedSince }),
            ...(normalizedUntil === undefined ? {} : { until: normalizedUntil }),
            // `[]`（空配列）もそのまま転送する: `{}` へ落とすと「0件」の契約が「絞らない」に化け、契約の歯からも見えないため
            ...(types === undefined ? {} : { types }),
            ...(q === undefined ? {} : { q }),
            ...(withFilter === undefined ? {} : { with: withFilter }),
            ...(afterId === undefined || afterAt === undefined
              ? {}
              : { after: { id: afterId, at: afterAt } }),
          });
        } catch (error) {
          // 錨が見つからないのは「判定できない」で「先頭から」ではない: 黙って先頭から読み直すと、続きを読んでいるつもりのクローンが同じ行を読み返すため
          if (error instanceof JournalAnchorNotFoundError) {
            return text(
              `afterId=${afterId ?? ''} afterAt=${afterAt ?? ''} が指す日誌の行が見つからない` +
                '（id と at の両方が一致する行が無い）。続きの位置は判定できない。' +
                '応答に出た「続きは …」の値を書き写し間違えていないか確かめること。' +
                '**日誌は読んでいない（先頭から読み直してもいない）。**',
            );
          }
          throw error;
        }
        const { entries, next: moreBeyond } = journalPage;
        // 0件かどうかで注記を決めない: 窓がまるごと地平より後ろなら、0件でも「本当に無かった」と言い切れるため
        const oldestAt =
          normalizedSince !== undefined || normalizedUntil !== undefined
            ? await stores.journal.oldestAt()
            : null;
        const horizonNote = describeJournalHorizonNote(
          oldestAt,
          normalizedSince,
          entries.length === 0,
        );
        const horizonNoteLines = horizonNote === undefined ? [] : [horizonNote];

        if (entries.length === 0 && moreBeyond !== null) {
          // 空を「無かった」と言わない: ストアは形の合わない行を `limit` の後で捨てるため、読めない行の向こうの行を無かったことにする
          return text(
            [
              `この頁の ${requested} 行は読めない形の行だけだった（日誌が無いのではない）。` +
                'さらに古い側に行が在る。下の続きの位置を afterId / afterAt に渡せば、' +
                '読めない行の向こうへ進める（窓をずらして読み直す必要は無い）。',
              describeJournalContinuation(moreBeyond),
              ...horizonNoteLines,
            ].join('\n'),
          );
        }

        if (entries.length === 0) {
          // `q` で0件でも、探す対象に入っていない欄が在ることまで言う: 黙ると「日誌にその語は無い」と読めるが tool_use の input に書かれているかもしれないため
          if (q !== undefined) {
            return text(
              [
                `"${q}" に当たる日誌は無い（この条件の中では）。` +
                  `ただし ${JOURNAL_SEARCH_UNCOVERED_LIST} は探す対象に入っていないので、` +
                  'そこにだけ書かれている語はここでは当たらない。',
                ...horizonNoteLines,
              ].join('\n'),
            );
          }
          // afterId があるときは「まだ空」と言わない: 続きの位置は実在の行を指しており、日誌は空ではないため
          const emptyNote =
            afterId !== undefined &&
            since === undefined &&
            until === undefined &&
            types === undefined &&
            withFilter === undefined
              ? '（この位置より先（古い側）に日誌の行は無い。日誌が空なのではない）'
              : since === undefined &&
                  until === undefined &&
                  types === undefined &&
                  withFilter === undefined
                ? '（日誌はまだ空）'
                : '（その条件に当たる日誌は無い）';
          return text([emptyNote, ...horizonNoteLines].join('\n'));
        }

        // 予算を先に決めて入るところまで積む: 件数から出力量を決めると何件で壊れるかが運任せになるため
        const items = entries.map((entry) => {
          const { head, body } = renderJournalEntry(entry, JOURNAL_LISTING_ATTACHMENTS);
          return (
            `${entry.at} ${head} id=${entry.id}` +
            (body === '' ? '' : `\n  ${excerptLine(body, JOURNAL_TEXT_EXCERPT)}`)
          );
        });

        // `tool_use` の混み具合は習慣（types で絞るのを忘れない）に預けず、この呼びで数えた件数だけを言う: `tool_use` が decision / exchange を押し出す速さが上がったため
        const toolUseCount = entries.filter((entry) => entry.type === 'tool_use').length;
        // 出す条件は取れた分が全部 tool_use だったか（`M === N`）ではなく呼びが渡した `types` で判定する: `types` を省略した呼びでは外せば判断の記録が出てくるため
        // 「だけを名指しした」は every で見る: `length === 1` だと重複指定が名指しでないことになり、外す先が無い呼びで断り書きが出るため
        const typesIsToolUseOnly =
          types !== undefined && types.length > 0 && types.every((type) => type === 'tool_use');
        const toolUseNotice =
          toolUseCount > 0 && !typesIsToolUseOnly
            ? [
                `（tool_use が今回の ${entries.length} 件中 ${toolUseCount} 件。` +
                  '判断の記録だけを見るなら types で外せる）',
              ]
            : [];

        // 予算で省略したときは `next` を案内しない: `next` は省略した行を飛び越えるため、表示した最後の行を続きの位置にする
        let shownCount = items.length;
        const listing = renderListing(items, {
          budget: JOURNAL_BUDGET,
          omitted: ({ rest, shown, total }) => {
            shownCount = shown;
            return (
              `…ほか ${rest} 件は省略（この条件で ${total} 件あり、新しい順に ${shown} 件だけ出した）。` +
              '省略した行から読み継ぐには、下の続きの位置を afterId / afterAt に渡すこと' +
              '（狭めるなら since / types / with / q を指定する）。'
            );
          },
        });
        const lastShown = entries[shownCount - 1];
        const cursor =
          shownCount < entries.length && lastShown !== undefined
            ? { id: lastShown.id, at: lastShown.at }
            : moreBeyond;
        return text(
          [
            listing,
            ...(cursor === null ? [] : [describeJournalContinuation(cursor)]),
            '（本文は抜粋。全文は journal_read id=<id> で取れる）',
            ...toolUseNotice,
            ...horizonNoteLines,
          ].join('\n'),
        );
      },
    ),

    // 取り下げても `deny` は自動で飛ばさない: 取り下げの場面で人間は何も言っておらず、機械が人間の承認を偽造することになるため
    tool(
      'ask_human',
      [
        '人間に確認する。記憶に根拠が無いことだけをここへ回す。',
        'これは承認待ちキューに積むだけで、人間の応答を待たない。',
        '止まるのはこの件だけであり、他の仕事は進めてよい。',
        '回答は後から受信箱に届く。',
        '不要になったら approval_withdraw で理由付きで取り下げられる（未回答のうちだけ）。',
        '複数の案から選んでもらうときは、question の本文に (a)(b)(c) を書くより questions を使うほうが人間が答えやすい（選択肢を押して答えられる）。',
        'questions は任意で、question（全体の前置き・背景）は必須のまま。',
        '各設問は { id, prompt, options: [{ id, label, description?, recommended? }], multiple?, allowOther? }。',
        'id は設問が承認待ちの中で、選択肢は設問の中で一意にする。multiple: true で複数選択、allowOther は既定 true（選択肢の最後に自由入力の「その他」が付く）。',
        'あなたの推しの選択肢には recommended: true を付ける。',
        '例: question: "デプロイ先を決めたい"、questions: [{ id: "target", prompt: "デプロイ先は？", options: [{ id: "railway", label: "Railway", recommended: true }, { id: "fly", label: "Fly.io" }] }, { id: "notify", prompt: "通知する先（複数可）", multiple: true, allowOther: false, options: [{ id: "slack", label: "Slack" }, { id: "mail", label: "メール" }] }]。',
        '人間の回答は「Q1 デプロイ先は？: (a) Railway［推奨］ / その他: …」のような文に畳まれて届き、構造（設問 id → 選んだ選択肢 id）も添えられる。未回答の設問は「未回答」と出る。',
      ].join(' '),
      {
        question: z.string().describe('人間への質問。何を判断してほしいかを具体的に'),
        context: z.string().optional().describe('判断に必要な背景'),
        questions: z
          .array(approvalQuestionSchema)
          .optional()
          .describe(
            '選んで答えてほしい設問（任意）。設問の id は一意、選択肢の id は設問の中で一意（重複は断られる）。' +
              '複数案の提示は question に (a)(b)(c) を書かずこちらへ',
          ),
        managerId: z
          .string()
          .optional()
          .describe('マネージャーからの確認を人間に回す場合、その manager_id'),
        // 生ログの id では通らない: `request_id` は生ログの `tool_use_id` や API の request id とは名前空間が違うため
        requestId: z
          .string()
          .optional()
          .describe(
            'マネージャーからの確認を人間に回す場合、受信箱に届いた requestId。' +
              '人間の回答をこの確認へ返すために必要なので、managerId と必ず対で渡すこと。' +
              '⚠️ 生ログの id とは別物である——生ログに出る toolu_…（tool_use_id）も ' +
              'req_…（API の request id）も、ここでは通らない。' +
              '受信箱に届いていない確認に、生ログから答える手段は無い（#572）',
          ),
      },
      async ({ question, context: background, questions, managerId, requestId }) => {
        if (questions !== undefined) {
          const violation = describeQuestionsViolation(questions);
          if (violation !== null) return text(`承認待ちには積まなかった: ${violation}`);
        }
        const questionError =
          describeStringLengthViolation('question', question, { min: 1 }) ??
          describeBlankViolation('question', question);
        if (questionError !== null) return text(`承認待ちには積まなかった: ${questionError}`);
        // 回す確認の委譲の起点を、ターンの起点より先に見る: 別の委譲の報告を読んでいるターンで回すこともあるため
        const conversationId =
          getConversationId() ??
          (await jobConversationOf(stores, managerId)) ??
          getWorkConversationId();
        await context.flushReply?.();
        const approval: PendingApproval = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          question,
          ...(background === undefined ? {} : { context: background }),
          ...(questions === undefined || questions.length === 0 ? {} : { questions }),
          ...(managerId === undefined ? {} : { jobId: managerId }),
          ...(requestId === undefined ? {} : { requestId }),
          ...(conversationId === undefined ? {} : { conversationId }),
        };
        try {
          await stores.jobs.putApproval(approval);
        } catch (error) {
          noteDroppedRecord('承認待ち', approvalShape(approval), error);
          throw new ApprovalNotRecordedError(approval, error);
        }
        await appendJournalOrThrow(
          'ask_human',
          stores.journal,
          {
            type: 'escalation',
            question,
            approvalId: approval.id,
          },
          'act-completed',
        );
        context.emit({ type: 'ask_human', approvalId: approval.id, question });
        return text(`承認待ちキューに積んだ（${approval.id}）。回答は後から届く。`);
      },
    ),

    // 自己矛盾した要求はキューに積む前に拒否する: 人間の確認画面に壊れた要求を出さないため
    // 許可の記録はここで持たない: 道具から許可を書く経路は作らないため
    tool(
      'request_permission',
      [
        '特定の Bash コマンドの規則を、以降は聞かずに通してよいか人間に確認する。',
        'rule は Bash(<完全なコマンド>) の完全一致か、Bash(<前方一致>:*) の前方一致（語境界で切る）。',
        'allows にはその規則が通すべき具体例、denies には通ってはならない具体例を挙げる——',
        '両方とも検算する（allows が1つでも規則に一致しない・denies が1つでも一致してしまうなら、',
        'この道具はキューに積む前に拒否する）。',
        '積むだけで人間の応答は待たない。人間が定型文でちょうど答えなければ許可は記録されない。',
        '質問文には、同じ道具・同じ先頭の語の直前の拒否（器が返した理由の原文・時刻）が自動で添えられる（コマンドの値は添えない）。',
      ].join(' '),
      {
        rule: z.string().describe('Bash(<完全な文字列>) または Bash(<前方一致>:*) の形の規則'),
        allows: z
          .array(z.string())
          .describe('この規則が通すべき具体的なコマンド例（1件以上、全部が規則に一致すること）'),
        denies: z
          .array(z.string())
          .describe('この規則が拒むべき具体的なコマンド例（1件以上、1件も規則に一致しないこと）'),
        reason: z.string().describe('なぜこの許可が要るか。人間が承認画面で読む理由文'),
      },
      async (args) => {
        // 検算は承認の行に残る値と同じもので行う: 入口で NUL が落ちるので、落とす前の値で検算すると通ったはずの要求が自己矛盾するため
        const { rule, allows, denies, reason } = stripNulDeep(args);
        const validation = validatePermissionRequest({ rule, allows, denies });
        if (!validation.ok) {
          return text(
            `request_permission を拒否した（キューに積んでいない）: ${validation.reason}`,
          );
        }
        const reasonError =
          describeStringLengthViolation('reason', reason, { min: 1 }) ??
          describeBlankViolation('reason', reason);
        if (reasonError !== null) {
          return text(`request_permission を拒否した（キューに積んでいない）: ${reasonError}`);
        }

        const conversationId = getWorkConversationId();
        const question =
          `以降 ${rule} を聞かずに通してよいか。理由: ${reason}\n` +
          `通る例: ${allows.join(' / ')}\n通らない例: ${denies.join(' / ')}\n` +
          `${describePermissionEvidence(rule, context.recentDenials)}\n` +
          `許可するなら「${PERMISSION_GRANT_CONSENT_PHRASE}」とだけ答える（句点や言い換えがあると記録しない）。`;
        await context.flushReply?.();
        const approval: PendingApproval = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          question,
          context: reason,
          permissionRequest: { rule, allows: [...allows], denies: [...denies] },
          ...(conversationId === undefined ? {} : { conversationId }),
        };
        try {
          await stores.jobs.putApproval(approval);
        } catch (error) {
          noteDroppedRecord('承認待ち', approvalShape(approval), error);
          throw new ApprovalNotRecordedError(approval, error);
        }
        await appendJournalOrThrow(
          'request_permission',
          stores.journal,
          {
            type: 'escalation',
            question,
            approvalId: approval.id,
          },
          'act-completed',
        );
        context.emit({ type: 'ask_human', approvalId: approval.id, question });
        return text(
          `承認待ちキューに積んだ（${approval.id}）。人間が「${PERMISSION_GRANT_CONSENT_PHRASE}」とちょうど答え、` +
            'かつ許可されたアカウント経由の回答だった場合だけ、以降この規則に一致する Bash が自動で通る。',
        );
      },
    ),

    tool(
      'approvals_list',
      [
        'いま人間の回答を待っている件の一覧。',
        '人間が席に居ないあいだに溜まる。溜まっていても他の仕事は進めてよい。',
        '一覧の質問は抜粋で、全文が要る1件は id を渡して取る。',
      ].join(' '),
      {
        id: z
          .string()
          .optional()
          .describe('この1件を全文で読む（一覧に出ている id）。他の条件は無視される'),
        offset: z
          .number()
          .optional()
          .describe(`id で全文を読むとき、何文字目から読むか（${formatIntRangeJa({ min: 0 })}）`),
      },
      async ({ id, offset = 0 }) => {
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        if (id !== undefined) {
          let approval: PendingApproval | null;
          try {
            approval = await stores.jobs.getApproval(id);
          } catch (error) {
            if (error instanceof UnreadableApprovalError)
              return text(describeUnreadableApproval(id));
            throw error;
          }
          if (!approval) return text(`承認待ち ${id} は無い（id が違う）。`);
          // 答えが付いた件も取り下げた件も読める: 「その質問が何だったか」は終端が付いた後にこそ要るため
          const status =
            approval.withdrawnAt !== undefined
              ? `${approval.withdrawnAt} に取り下げ`
              : approval.answeredAt === undefined
                ? '回答待ち'
                : `${approval.answeredAt} に回答済み`;
          const head =
            `${approval.id}（${approval.createdAt}）` +
            status +
            (approval.jobId === undefined
              ? ''
              : ` / 宛先 managerId: "${approval.jobId}"` +
                (approval.requestId === undefined ? '' : `, requestId: "${approval.requestId}"`));
          const body = [
            `質問: ${approval.question}`,
            ...(approval.context === undefined ? [] : [`背景: ${approval.context}`]),
            ...(approval.questions === undefined
              ? []
              : [`設問:\n${describeQuestionLines(approval.questions).join('\n')}`]),
            ...(approval.answer === undefined ? [] : [`回答: ${approval.answer}`]),
            ...(approval.withdrawnReason === undefined
              ? []
              : [`取り下げた理由: ${approval.withdrawnReason}`]),
          ].join('\n\n');
          const part = page(body, offset, APPROVAL_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは approvals_list id=${approval.id} offset=${part.to}）`
            : '';
          return text(`${head}（${describePage(part)}）\n\n${part.body}${tail}`);
        }

        // ここで全順序にする（`createdAt` 昇順、同着は `id` 昇順）: この一覧は予算で切るので、並びがストア実装依存だと切り落とされる側が構成によって変わるため
        // ストア側の `orderBy` は消さない: 消すと pg が大きな表を未整列のまま全件返してからここで並べることになるため
        const approvalList = await stores.jobs.listApprovals({ pendingOnly: true });
        const pending = [...approvalList.entries].sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        );
        // 読めない行は一覧から消さず、件数と id で言う
        const unreadableNote = describeUnreadableApprovals(approvalList.unreadable);
        if (pending.length === 0) {
          return text(
            unreadableNote === null
              ? '（人間の回答待ちは無い）'
              : `（読めた回答待ちは無い）\n${unreadableNote}`,
          );
        }
        const items = pending.map((approval) =>
          renderListingEntry({
            id: approval.id,
            title: approvalTitle(approval.question),
            // 更新は `createdAt` をそのまま出す: 回答待ちだけの一覧では「まだ一度も変わっていない」という観測で、値を作らないため
            createdAt: approval.createdAt,
            updatedAt: approvalUpdatedAt(approval),
            summary: excerptLine(approval.question, APPROVAL_QUESTION_EXCERPT),
            extra: [
              approval.questions === undefined || approval.questions.length === 0
                ? null
                : `  ${summarizeQuestions(approval.questions)}（詳細は approvals_list id=<id>）`,
              approval.jobId === undefined
                ? null
                : `  宛先: managerId: "${approval.jobId}"` +
                  (approval.requestId === undefined ? '' : `, requestId: "${approval.requestId}"`),
            ],
          }),
        );
        return text(
          [
            renderListing(items, {
              budget: APPROVAL_LIST_BUDGET,
              omitted: ({ rest, shown, total }) =>
                `…ほか ${rest} 件は省略（回答待ちは ${total} 件あり、作成が古い順に先頭から ${shown} 件だけ出した）。`,
            }),
            '（質問は抜粋。全文は approvals_list id=<id> で取れる。答えが付いた件・取り下げた件も id で開けて、回答/取り下げ理由もそこに出る）',
            '（更新＝この1件が最後に変わった時刻。回答待ちだけを出す一覧なので、常に作成と同じになる）',
            '（並び順: 作成時刻の昇順。同じ作成時刻なら id の昇順で全順序にしてある。保存先の実装には依存しない）',
            ...(unreadableNote === null ? [] : [unreadableNote]),
          ].join('\n'),
        );
      },
    ),

    // `approvals_list` の `id` モードへ相乗りさせない: 承認の口（`ask_human` / `approvals_list`）の形を変えないと決めているため
    tool(
      'approval_trace',
      [
        '承認への人間の答えと、その答えを受けたターンで自分が取った行動（判断・記憶の更新・道具・返答）を対で並べる。',
        '答えの後で自分が何をしたか、答えと行動が食い違っていないかを確かめるための口で、解釈や一般化は足さない。',
        '対が無いときは、まだ答えが無い／ターンが無い／記録を始める前の答え／記録が動いていない疑い、を分けて言う。',
        '行動は抜粋で、全文は日誌の id を journal_read に渡して取る。',
      ].join(' '),
      {
        id: z.string().describe('承認の id（approvals_list や日誌の escalation に出ている id）'),
      },
      async ({ id }) => {
        let trace: Awaited<ReturnType<typeof traceApproval>>;
        try {
          trace = await traceApproval(stores, id);
        } catch (error) {
          if (error instanceof UnreadableApprovalError) return text(describeUnreadableApproval(id));
          throw error;
        }
        if (trace === null) return text(`承認 ${id} は無い（id が違う）。`);
        return text(
          renderApprovalTrace(trace, {
            budget: APPROVAL_TRACE_BUDGET,
            summaryLimit: APPROVAL_TRACE_SUMMARY_EXCERPT,
            detailHint: '（行動は抜粋。全文は journal_read id=<日誌の id> で取れる）',
          }),
        );
      },
    ),

    // 自動 `deny` は選択肢として持たない: 取り下げの場面で人間は何も言っておらず、機械が人間の承認を偽造することになるため
    // `jobId`/`requestId` を持つ件を取り下げ不可にしない: マネージャー自体が既に停止している場合に詰むため
    tool(
      'approval_withdraw',
      [
        '未回答の承認待ちを、理由付きで取り下げる。行は消えず、取り下げた事実と理由が残る。',
        '回答済みの件は取り下げられない（先に answered ならここでは断られる）。',
        '⚠️ マネージャーからの許可確認を人間へ回した件（jobId/requestId 付き）を取り下げても、',
        'そのマネージャーは自動では解放されない——待ったままなら manager_send（decision 付き）で',
        '自分から答えること。ここでの取り下げは「人間の承認キューから消す」だけである。',
      ].join(' '),
      {
        id: z.string().describe('approvals_list に出ている id'),
        reason: z
          .string()
          .describe(
            `なぜ取り下げるか（不要になった経緯・自分で答えを見つけた等。${formatStringLengthJa({ min: 1 })}）。` +
              '人間はこれを読んで後から否定する',
          ),
      },
      async ({ id, reason }) => {
        const reasonError =
          describeStringLengthViolation('reason', reason, { min: 1 }) ??
          describeBlankViolation('reason', reason);
        if (reasonError !== null) return text(reasonError);
        let existing: PendingApproval | null;
        try {
          existing = await stores.jobs.getApproval(id);
        } catch (error) {
          if (error instanceof UnreadableApprovalError) return text(describeUnreadableApproval(id));
          throw error;
        }
        if (!existing) return text(`承認待ち ${id} は無い（id が違う）。`);
        if (existing.answeredAt !== undefined) {
          return text(
            `${id} は既に ${existing.answeredAt} に回答済みなので取り下げられない` +
              `（回答: ${existing.answer ?? '（本文なし）'}）。`,
          );
        }
        if (existing.withdrawnAt !== undefined) {
          return text(
            `${id} は既に ${existing.withdrawnAt} に取り下げ済み（理由: ${existing.withdrawnReason ?? ''}）。`,
          );
        }
        const withdrawnAt = new Date().toISOString();
        // 読み直す1操作で書く: 写しを丸ごと書き戻すと、読んでから書くまでの間に入った人間の回答を消してしまうため
        let settledNow: PendingApproval | undefined;
        let written: PendingApproval | null;
        try {
          written = await stores.jobs.updateApproval(id, (current) => {
            if (current.answeredAt !== undefined || current.withdrawnAt !== undefined) {
              settledNow = current;
              return null;
            }
            return { ...current, withdrawnAt, withdrawnReason: reason };
          });
        } catch (error) {
          if (error instanceof UnreadableApprovalError) return text(describeUnreadableApproval(id));
          throw error;
        }
        if (written === null) {
          if (settledNow?.answeredAt !== undefined) {
            return text(
              `${id} は既に ${settledNow.answeredAt} に回答済みなので取り下げられない` +
                `（回答: ${settledNow.answer ?? '（本文なし）'}）。`,
            );
          }
          if (settledNow?.withdrawnAt !== undefined) {
            return text(
              `${id} は既に ${settledNow.withdrawnAt} に取り下げ済み（理由: ${settledNow.withdrawnReason ?? ''}）。`,
            );
          }
          return text(`承認待ち ${id} は無い（id が違う）。`);
        }
        // 自分で閉じたことは日誌に残す: 人間が後から否定するための材料は台帳だけでなく日誌にも要るため
        await appendJournalOrThrow(
          'approval_withdraw',
          stores.journal,
          {
            type: 'escalation',
            question: existing.question,
            approvalId: id,
            ...(existing.jobId === undefined ? {} : { managerId: existing.jobId }),
            withdrawnAt,
            withdrawnReason: reason,
          },
          'act-completed',
        );
        const waiting =
          existing.jobId === undefined
            ? ''
            : ` ⚠️ この確認はマネージャー ${existing.jobId} のものである` +
              (existing.requestId === undefined ? '' : `（requestId: "${existing.requestId}"）`) +
              '。取り下げてもそのマネージャーは自動では解放されない——待ったままなら、' +
              '自分から manager_send（decision 付き）で答えて始末をつけること。';
        return text(`${id} を取り下げた。${waiting}`);
      },
    ),

    tool(
      'daily_report_write',
      [
        'その日の日報を残す。人間が普段読むのはこれだけである。',
        '今日何をしたか・何が決まったか・何が保留か、が読んだだけで分かるように書くこと。',
      ].join(' '),
      {
        date: z
          .string()
          .optional()
          .describe('対象日 YYYY-MM-DD（省略時は今日。締めの指示に書かれた日付を使うこと）'),
        body: z.string().describe('日報の本文（Markdown）'),
      },
      async ({ date, body }) => {
        // 形の検査だけで通さず localDayRange に確かめさせる: 存在しない日付で残すとその日報は二度と読めないため
        const target =
          date !== undefined && localDayRange(date) !== null ? date : localDate(new Date());
        await appendJournalOrThrow(
          'daily_report_write',
          stores.journal,
          { type: 'daily_report', date: target, body },
          'act-not-performed',
        );
        return text(`${target} の日報を残した。`);
      },
    ),

    tool(
      'usage_read',
      [
        'アカウント全体の残り枠と支出上限（claude.ai 側の値）と、alteroid が使った分（トークンと費用）を台帳から読む。',
        '軸（axis）を渡したときは、その軸だけを出す——アカウント全体の残りもまとめ表示も他の軸も出ない。',
        // 軸の件数も名前も数え直さない: 出所は `USAGE_AXES` と `USAGE_AXIS_NOTES` のため
        `軸は${USAGE_AXES.length}つ — ${USAGE_AXES.map((axis) => `${axis}（${USAGE_AXIS_NOTES[axis]}）`).join('・')}。`,
        'token の軸に「（トークンの帰属が無い分）」が出るのは、プールを使っていない構成では正常である（0 でも既定値でもなく、取れていない）。',
        '**推定値であり請求明細ではない。**',
        '記録は台帳を置いた日から始まっているので、それより前は 0 ではなく「記録が無い」と出る。',
        'まとめ表示は軸ごとに打ち切る。続きは axis と cursor で辿れる（打ち切りの行にそのまま書いてある。' +
          'cursor は前回の応答に出たものをそのまま渡す——自分で組み立てない）。',
        '続きの応答に「順位が上がった、または既に見せた行が伸びた可能性がある行」が別枠で出ることがある' +
          '（前回の呼び出し以降に記録が増えて起きる。通常の続きの頁と重複しない）。',
      ].join(' '),
      {
        from: z.string().optional().describe('この日から（YYYY-MM-DD）。省略すると台帳の全期間'),
        to: z.string().optional().describe('この日まで（YYYY-MM-DD）'),
        managerId: z
          .string()
          .optional()
          .describe('この actor の分だけ（マネージャーの id か "clone"）'),
        layer: usageLayerSchema.optional().describe('誰が使った分だけ（clone / manager）'),
        site: usageSiteSchema.optional().describe('どこで使った分だけ（session / distill / peer）'),
        tokenId: z
          .string()
          .optional()
          .describe(
            `この認証トークンで使った分だけ（token_list の id。${formatStringLengthJa({ min: 1 })}）`,
          ),
        axis: z
          .enum(USAGE_AXES)
          .optional()
          .describe(
            'この軸だけを出す（まとめ表示・他の軸・アカウント全体の残りは出ない）。省略すると先頭から',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            'axis と一緒に使う。その軸の続きを読む位置。前回の応答の断り書きに出た cursor を' +
              'そのまま渡す（自分で組み立てない）。省略すると先頭から',
          ),
      },
      async ({ from, to, managerId, layer, site, tokenId, axis, cursor }) => {
        const tokenIdError = describeStringLengthViolation('tokenId', tokenId, { min: 1 });
        if (tokenIdError !== null) return text(tokenIdError);
        // `from` / `to` は形を確かめてから店へ渡す: 店は日付を文字列の大小で比べるだけで、`2026-02-30` などが黙って絞り込みになるため
        for (const [name, value] of [
          ['from', from],
          ['to', to],
        ] as const) {
          if (value !== undefined && !isRealUsageDate(value)) {
            return text(
              `\`${name}\` は、暦の上に実在する日付（YYYY-MM-DD）で書く（受け取った値: ${JSON.stringify(value)}）。` +
                '形の合わない値や、2026-02-30 のような実在しない日では絞り込めない。',
            );
          }
        }
        const aggregate = await stores.usage.aggregate({
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(managerId === undefined ? {} : { managerId }),
          ...(layer === undefined ? {} : { layer }),
          ...(site === undefined ? {} : { site }),
          ...(tokenId === undefined ? {} : { tokenId }),
        });
        // `to` が `from` より前の注記を応答の先頭へ添える: 0件が「期間の指定が逆」と「記録が無い」で区別できないため
        const dateOrderNotice = describeUsageDateOrder(from, to);
        const withNotice = (body: string): string =>
          dateOrderNotice === null ? body : `${dateOrderNotice}\n${body}`;
        // 軸モードでは続きの1軸だけを返す: 続きを辿るほど同じ全体が積み増しで返ってくるのを避けるため
        if (axis !== undefined) {
          return text(withNotice(renderUsage(aggregate, { axis, cursor })));
        }
        const unrecordedManagers = await unrecordedManagersLines(context, stores, aggregate.since);
        return text(
          withNotice(
            [
              renderAccountUsage(context.accountUsage?.() ?? { state: 'unknown' }),
              '',
              '## alteroid が使った分（台帳）',
              renderUsage(aggregate, { unrecordedManagers }),
            ].join('\n'),
          ),
        );
      },
    ),

    tool(
      'schedule_list',
      [
        '仕込んである継続中の依頼の一覧。周期と、前回それで動いた時刻・次に動く時刻が分かる。',
        // 一覧を数え直さず `RESERVED_SCHEDULE_KINDS` から導出する: 足されたとき取り残されるため
        `既定の定期ジョブ（${RESERVED_SCHEDULE_KINDS.join(' / ')}）はここには出ない（あれは設定で回っているもの）。`,
        '一覧の依頼本文は抜粋で、全文が要る1件は kind を渡して取る。',
        '一覧が予算で切れたら、断り書きが次に打つ cursor を案内する。それを cursor へ渡すと続きから読める。',
      ].join(' '),
      {
        kind: z
          .string()
          .optional()
          .describe('この1件の依頼本文を全文で読む（一覧に出ている kind）'),
        offset: z
          .number()
          .optional()
          .describe(`kind で全文を読むとき、何文字目から読むか（${formatIntRangeJa({ min: 0 })}）`),
        cursor: z
          .string()
          .optional()
          .describe(
            '一覧モードの続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す' +
              '（自分で組み立てない）。省略すると先頭から。' +
              'kind を渡す全文モードでは他の条件と同じく無視される。',
          ),
      },
      async ({ kind, offset = 0, cursor }) => {
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        if (kind !== undefined) {
          // 読めない行は案内する文で返す: 書き直しの手段が無く、`schedule_remove` で外す以外に回復手段が無いため
          let plan: Awaited<ReturnType<typeof stores.schedules.get>>;
          try {
            plan = await stores.schedules.get(kind);
          } catch (error) {
            if (!(error instanceof UnreadableScheduleError)) throw error;
            return text(
              `継続中の依頼 ${kind} は読めない形で入っている（消されたのではない）。` +
                `schedule_remove kind=${kind} で外せる。`,
            );
          }
          if (!plan) return text(`継続中の依頼 ${kind} は無い（kind が違うか、もう外してある）。`);
          const head =
            `${plan.kind}（${describeScheduleSpec(plan.spec)}）` +
            ` 前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}` +
            ` 次に動く時刻: ${scheduleNextAtOf(context, plan.kind)}`;
          const part = page(plan.request, offset, SCHEDULE_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは schedule_list kind=${plan.kind} offset=${part.to}）`
            : '';
          return text(`${head}（依頼本文: ${describePage(part)}）\n\n${part.body}${tail}`);
        }

        const scheduleList = await stores.schedules.list();
        const plans = scheduleList.entries;
        // 読めない行は一覧から消さず、件数と kind で言う
        const unreadableNote = describeUnreadableSchedules(scheduleList.unreadable);
        if (plans.length === 0) {
          return text(
            unreadableNote === null
              ? '（継続中の依頼は無い）'
              : `（読めた継続中の依頼は無い）\n${unreadableNote}`,
          );
        }

        const cursorOutcome = resolveScheduleCursor(plans, cursor);
        if (cursorOutcome.kind === 'malformed') {
          return text(
            'cursor が壊れている（この道具が返したものではないか、書き換えられている）。' +
              '一覧を先頭から読み直すには cursor を付けずに schedule_list を呼ぶこと。',
          );
        }
        const view = cursorOutcome.view;
        const items = view.map((plan) =>
          renderListingEntry({
            id: plan.kind,
            title: describeScheduleSpec(plan.spec),
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
            summary: `依頼: ${excerptLine(plan.request, SCHEDULE_REQUEST_EXCERPT)}`,
            extra: [
              `  前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}`,
              `  次に動く時刻: ${scheduleNextAtOf(context, plan.kind)}`,
            ],
          }),
        );
        const lines = [
          view.length === 0
            ? '（cursor より後ろの継続中の依頼は無い。これが最後の頁）'
            : renderListing(items, {
                budget: SCHEDULE_LIST_BUDGET,
                // 母数は cursor を当てる前の `plans.length`: `renderListing` が渡す `total` は cursor 以降の残りで、頁が進むと変わるため
                omitted: ({ rest, shown }) => {
                  const total = plans.length;
                  const lastShown = view[shown - 1]!;
                  const nextCursor = encodeScheduleCursor({ kind: lastShown.kind });
                  return (
                    `…ほか ${rest} 件は省略（継続中の依頼は ${total} 件あり、${shown} 件だけ出した。` +
                    'kind の昇順で並んでいるので、省いたのはこれより後ろ（kind の綴りが後）の依頼である。' +
                    `続きは schedule_list cursor=${nextCursor} で取れる）。`
                  );
                },
              }),
        ];
        // 今回の応答に実際に載った件数（`view.length`）で見る: 最後の頁で1件も出していないのにこの行だけが付くのを避けるため
        if (view.length > 0) {
          lines.push('（依頼本文は抜粋。全文は schedule_list kind=<kind> で取れる）');
        }
        if (unreadableNote !== null) lines.push(unreadableNote);
        return text(lines.join('\n'));
      },
    ),

    tool(
      'schedule_create',
      [
        'その場で終わらない依頼を、時間起点として仕込む。',
        '時刻が来れば必ずあなたの受信箱へ届き、そのとき依頼の本文と前回動いた時刻が一緒に渡る。',
        '記憶に書くのは判断の根拠であって、記憶は時計を持たない。継続する依頼はここにも置くこと。',
        '同じ kind で呼べば置き換わる（周期や本文の直しはこれで行う）。',
        // 予約名は `RESERVED_SCHEDULE_KINDS` から導出する: 手で書き写すと既定の刻みが増えたときここだけ古くなるため
        `既定の定期ジョブの名前（${RESERVED_SCHEDULE_KINDS.join(' / ')}）は使えない——別の名前を付けること。`,
        `既定の刻みそのもの（締め時刻・間隔）はデーモンの設定で決まる（${describeReservedScheduleKindEnvKeys()}）ので、変えたいなら人間に頼むこと。`,
      ].join(' '),
      {
        kind: z
          .string()
          .describe('この依頼の名前（英小文字・数字・. _ -）。後から直す・消すときの識別子'),
        request: z
          .string()
          .describe(
            '依頼の本文。時刻が来たときのあなたが読んで、そのまま動ける粒度で書く' +
              '（対象・狙い・どこまでやるか。人間から頼まれた言葉そのものも残すとよい）',
          ),
        dailyAt: z
          .string()
          .optional()
          .describe('毎日この時刻に起こす（ローカル時刻の HH:MM）。周期はどれか1つだけ渡す'),
        everyMinutes: z
          .number()
          .optional()
          .describe(
            `この分数ごとに起こす（${formatIntRangeJa({ min: 1, max: SCHEDULE_EVERY_MINUTES_MAX })}。1年より長い周期は cron か単発で書く）。周期はどれか1つだけ渡す`,
          ),
        cron: z
          .string()
          .optional()
          .describe(
            'cron 式で起こす（ローカル時刻。分 時 日 月 曜の5欄だけ。例: 毎週月曜 10:00 なら `0 10 * * 1`）。' +
              '曜日や月の指定が要るときはこれを使う。周期はどれか1つだけ渡す',
          ),
      },
      async ({ kind, request, dailyAt, everyMinutes, cron }) => {
        const parsedKind = scheduleKindSchema.safeParse(kind);
        if (!parsedKind.success) {
          return text(`kind "${kind}" は使えない（英小文字・数字・. _ - のみ、64文字まで）。`);
        }
        // 「空」は NUL を落とした後で見る: ストアは NUL を落として残すので、落とす前の長さで見ると NUL だけの `request` が日誌より先へ進むため
        if (stripNul(request).length === 0) {
          return text('request が空文字は使えない（依頼の本文を渡すこと）。');
        }
        if (RESERVED_SCHEDULE_KINDS.includes(parsedKind.data)) {
          return text(
            `${parsedKind.data} は既定の定期ジョブの名前なので使えない（別の名前を付けること）。` +
              '既定の刻みそのもの（締め時刻・間隔）を変えたいなら、それはデーモンの設定' +
              `（${describeReservedScheduleKindEnvKeys()}）なので人間に頼むこと。`,
          );
        }
        const given = [dailyAt, everyMinutes, cron].filter((value) => value !== undefined);
        if (given.length !== 1) {
          return text('dailyAt / everyMinutes / cron のうち、どれか1つだけ渡すこと。');
        }
        if (dailyAt !== undefined && parseTimeOfDay(dailyAt) === null) {
          return text(`dailyAt "${dailyAt}" は HH:MM として読めない。`);
        }
        if (cron !== undefined && !isCronExpression(cron)) {
          return text(
            `cron "${cron}" は cron 式として読めない（分 時 日 月 曜の5欄だけ。秒つきは使えない。例: 毎週月曜 10:00 なら \`0 10 * * 1\`）。`,
          );
        }
        const everyViolation = describeIntRangeViolation('everyMinutes', everyMinutes, {
          min: 1,
          max: SCHEDULE_EVERY_MINUTES_MAX,
        });
        if (everyViolation !== null) {
          return text(
            `${everyViolation}1年（${SCHEDULE_EVERY_MINUTES_MAX}分）より長い周期は everyMinutes ではなく cron 式か単発の予定で書くこと。`,
          );
        }

        const spec: ScheduleSpec =
          dailyAt !== undefined
            ? { type: 'daily', at: dailyAt }
            : cron !== undefined
              ? { type: 'cron', expression: cron }
              : { type: 'every', minutes: everyMinutes ?? 60 };
        const parsedSpec = scheduleSpecSchema.safeParse(spec);
        if (!parsedSpec.success) return text(`周期を読めなかった: ${parsedSpec.error.message}`);

        const now = new Date().toISOString();

        // 日誌を先に書く: 書けなければ仕込まずに道具のエラーで返すため
        await appendJournalOrThrow(
          'schedule_create',
          stores.journal,
          {
            type: 'decision',
            decision: `定期の依頼を設定しようとしている: ${parsedKind.data}: ${request}`,
            grounds: '継続する依頼を時間起点として持つ判断',
          },
          'act-not-performed',
        );

        // 編集は `editRequest`、新規作成だけ `put`: 読んでから書く間に定期発火の `claimRun` が割り込むと、その印を消す lost update になるため
        let edited: ScheduledRequest | null;
        try {
          edited = await stores.schedules.editRequest(
            parsedKind.data,
            { request, spec: parsedSpec.data },
            now,
          );
        } catch (error) {
          // 読めない行は例外のまま落とさず、理由の分かる文で返す
          const unreadable = error instanceof UnreadableScheduleError;
          await appendJournalOrDrop('schedule_create', stores.journal, {
            type: 'decision',
            decision: unreadable
              ? `定期の依頼を設定できなかった（読めない形で入っている）: ${parsedKind.data}: ${request}`
              : `定期の依頼を設定できなかった: ${parsedKind.data}: ${request}`,
            grounds: unreadable
              ? '継続する依頼を時間起点として持とうとしたが、その kind の行が読めないので書いていない'
              : '継続する依頼を時間起点として持とうとしたが、状態の変更が失敗した',
          });
          if (unreadable) return text(describeUnreadableScheduleEdit(error));
          throw error;
        }
        let plan: ScheduledRequest;
        if (edited !== null) {
          plan = edited;
        } else {
          plan = {
            kind: parsedKind.data,
            spec: parsedSpec.data,
            request,
            createdAt: now,
            updatedAt: now,
          };
          try {
            await stores.schedules.put(plan);
          } catch (error) {
            await appendJournalOrDrop('schedule_create', stores.journal, {
              type: 'decision',
              decision: `定期の依頼を設定できなかった: ${parsedKind.data}: ${request}`,
              grounds: '継続する依頼を時間起点として持とうとしたが、状態の変更が失敗した',
            });
            throw error;
          }
        }
        await appendJournalOrDrop('schedule_create', stores.journal, {
          type: 'decision',
          decision:
            `${edited !== null ? '定期の依頼を直した' : '定期の依頼を仕込んだ'}: ` +
            `${plan.kind}（${describeScheduleSpec(plan.spec)}）: ${request}`,
          grounds: '継続する依頼を時間起点として持つ判断',
        });
        return text(
          `${plan.kind} を ${describeScheduleSpec(plan.spec)} で仕込んだ。時刻が来たら依頼の本文とともに届く。`,
        );
      },
    ),

    tool(
      'schedule_remove',
      '継続中の依頼を片付ける。済んだ依頼・もう要らない依頼はここで外す。',
      { kind: z.string().describe('schedule_list に出ている kind') },
      async ({ kind }) => {
        // `get(kind)` を先に呼ばない: 壊れた行を先に読もうとすると例外が上がり、外すという本来の目的まで届かないため
        const removed = await stores.schedules.removeIfPresent(kind);
        if (removed === null) return text(`継続中の依頼 ${kind} は無い。`);
        await appendJournalOrThrow(
          'schedule_remove',
          stores.journal,
          {
            type: 'decision',
            decision:
              removed === 'unreadable'
                ? // 読めなかった行なので本文（`request`）は取り出せない
                  `読めない形で入っていた依頼を外した: ${kind}`
                : `定期の依頼を外した: ${kind}: ${removed.request}`,
            grounds: 'この依頼はもう要らないという判断',
          },
          'act-completed',
        );
        return text(`${kind} を外した。`);
      },
    ),

    // 「やることの一覧」にしない: 器が持つのは「何を頼まれたか」と「まだ片付いていない」の2値だけで、順序も優先度も締切も持たないため
    tool(
      'commitment_list',
      [
        '引き受けたまま終わっていない仕事の一覧。既定は古い順に出る。',
        '人間の依頼・人間の回答（ask_human への答え）・マネージャーからの一件・外部イベント（デーモン自身が自分へ出す合図を除く）は、届いた時点で自動的にここへ載る。',
        '**載っているものは、あなたが閉じるまで消えない。**',
        'どれを先にやるかの順序はここには無い。記憶にある目的と価値観に照らして毎回決め直すこと。',
        '1件の全文（依頼本文と、片付けたならその理由）が要るなら id を渡す。片付いた件も id で読める。',
        'origin で出所を絞れる（他の絞りと併用できる）。',
        'q で本文・出所を語で探せる（他の絞りと併用できる）。',
        'order で新しい順に変えられる（台帳が膨らんで予算で切れるとき、直近の行へ届くにはこちらを使う）。',
        '一覧が予算で切れたら、断り書きが次に打つ cursor を案内する。それを cursor へ渡すと続きから読める。',
      ].join(' '),
      {
        id: z
          .string()
          .optional()
          .describe(
            'この1件を全文で読む（一覧に出ている id）。片付いた件も読める。他の条件は無視される（cursor も含む）',
          ),
        offset: z
          .number()
          .optional()
          .describe(
            `id で全文を読むとき、何文字目から読むか（件数ではなく文字数。${formatIntRangeJa({ min: 0 })}）`,
          ),
        includeClosed: z
          .boolean()
          .optional()
          .describe('片付けたものも見る（既定は未了だけ）。何を片付けたかを振り返るとき用'),
        origin: z
          .array(z.enum(commitmentOriginSchema.options))
          .optional()
          .describe('出所（human/manager/external/self）で絞る。省略すると絞らない'),
        // `q` は `body` と `source` の両方に当てる: `origin: 'manager'` の行は `source` が managerId で本文に入らず、`body` だけだと委譲の行を探せないため
        q: z
          .string()
          .optional()
          .describe(
            '語で探す（大文字小文字を区別しない部分一致）。当てる先は body と source の両方' +
              '（どちらかに当たれば残す。origin: manager の行は managerId が source に入り、' +
              'body には入らないため）。他の絞りと併用できる。' +
              'id を指定した全文モードでは他の条件と同じく無視される。',
          ),
        // `order` を足す: 予算で切る口で順序が固定だと、台帳が膨らんだとき片端の行へ予算のどこを歩いても到達しないため（HTTP は予算を持たないので足さない）
        order: z
          .enum(['oldest', 'newest'])
          .optional()
          .describe(
            '並び順（既定は oldest=古い順。newest=新しい順）。' +
              'newest にすると、台帳が膨らんで予算で切れる場合でも直近の行へ届く。' +
              'cursor の order はこの値と揃えること（食い違うと明示のエラーになる）',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            '一覧モードの続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す' +
              '（自分で組み立てない）。省略すると先頭から（order が newest なら新しい方から）。' +
              'includeClosed・order・origin・q はカーソルを取った呼びと揃えること' +
              '（食い違うと明示のエラーになる）',
          ),
      },
      async ({ id, offset = 0, includeClosed, origin, q, order, cursor }) => {
        // 既定値は zod の `.default()` に持たせずここで明示する: `effectiveOrder` をカーソルの発行・比較・文言の全箇所で同じ1つの値として使うため
        const effectiveOrder = order ?? 'oldest';
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        if (id !== undefined) {
          // 片付いた件も読める（`includeClosed` は要求しない）: `closedReason` は一覧では120字の抜粋で止まり、全文へ降りる口が無いと抜粋の分しか生きないため
          // `UnreadableCommitmentError` だけを捕まえて3値目として返す: 器の障害まで飲み込むと「台帳が壊れている」に化けて見えなくなるため
          let entry: Commitment | null;
          try {
            entry = await stores.commitments.get(id);
          } catch (error) {
            if (error instanceof UnreadableCommitmentError) {
              return text(
                `引き受けた仕事 ${id} は読めない形で入っている（片付いたのではない。` +
                  '無いのとは違う）。本文はここでは取れない。',
              );
            }
            throw error;
          }
          // 黙って空を返さない: 「無い」と「読めない」を混ぜると、id の打ち間違いが「存在しなかった」として片付くため
          if (!entry) return text(await describeMissingCommitment(stores, id));
          const head = [
            `${entry.id} ${commitmentOriginBadge(entry)}`,
            `作成: ${entry.at} / 更新: ${commitmentUpdatedAt(entry)}`,
            entry.closedAt === undefined ? '状態: 未了' : `状態: ${entry.closedAt} に片付けた`,
          ].join('\n');
          // 片付けた理由を本文より先に置く: `body` は長くなりうるので、後ろだと `page()` の2ページ目へ落ちるため
          const body = [
            ...(entry.closedAt === undefined
              ? []
              : [`片付けたとした理由: ${entry.closedReason ?? '（理由の記録なし）'}`]),
            `依頼（全文）: ${entry.body}`,
          ].join('\n\n');
          const part = page(body, offset, COMMITMENT_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは commitment_list id=${entry.id} offset=${part.to}）`
            : '';
          return text(`${head}（${describePage(part)}）\n\n${part.body}${tail}`);
        }

        // 「無い」と返してよいのは entries・unreadable・trimmedClosed がすべて0件のときだけ: 削除された事実が静かに握り潰されるため
        const {
          entries: allEntries,
          unreadable,
          trimmedClosed,
        } = await stores.commitments.list(
          includeClosed === true ? { includeClosed: true } : undefined,
        );
        if (allEntries.length === 0 && unreadable.length === 0 && trimmedClosed === 0) {
          return text('（引き受けたまま終わっていない仕事は無い）');
        }
        // `origin` / `q` は予算で切る前に効かせる: 絞りを後で掛けると、絞りに当たらない行が窓を食い尽くすため
        const originFiltered =
          origin === undefined
            ? allEntries
            : allEntries.filter((entry) => origin.includes(entry.origin));
        const entries =
          q === undefined
            ? originFiltered
            : originFiltered.filter((entry) => {
                const needle = q.toLowerCase();
                return (
                  entry.body.toLowerCase().includes(needle) ||
                  (entry.source !== undefined && entry.source.toLowerCase().includes(needle))
                );
              });
        // `order` も `origin` / `q` と同じ側（予算で切る前・cursor を解決する前）で効かせる: 後回しにすると絞りや向きに当たらない行が窓を食い尽くすため
        // `CommitmentStore.list` の契約は変えない: この反転はツール層だけの見え方
        const ordered = effectiveOrder === 'newest' ? [...entries].reverse() : entries;
        // `cursor` も予算で切る前に効かせる: 後で解決すると次の頁の起点が切った後に残った行からずれるため
        // 判定できないカーソルは黙って先頭からへ倒さない: 呼び手が続きを読んだつもりで同じ行を繰り返し読むため
        const cursorOutcome = resolveCommitmentCursor(
          ordered,
          includeClosed === true,
          cursor,
          effectiveOrder,
          origin,
          q,
        );
        if (cursorOutcome.kind === 'malformed') {
          return text(
            'cursor が壊れている（この道具が返したものではないか、書き換えられている）。' +
              '一覧を先頭から読み直すには cursor を付けずに commitment_list を呼ぶこと。',
          );
        }
        if (cursorOutcome.kind === 'includeClosed-mismatch') {
          return text(
            `cursor は includeClosed=${cursorOutcome.cursorIncludeClosed} の一覧から出た続きの` +
              `位置で、いまの呼び（includeClosed=${includeClosed === true}）と食い違う。` +
              `commitment_list includeClosed=${cursorOutcome.cursorIncludeClosed} ` +
              `order=${effectiveOrder} cursor=${cursor} のように includeClosed を揃えて呼び直すか、` +
              'cursor を付けずに先頭から呼び直すこと。',
          );
        }
        if (cursorOutcome.kind === 'order-mismatch') {
          return text(
            `cursor は order=${cursorOutcome.cursorOrder} の一覧から出た続きの位置で、` +
              `いまの呼び（order=${effectiveOrder}）と食い違う。` +
              `commitment_list order=${cursorOutcome.cursorOrder} includeClosed=${includeClosed === true} ` +
              `cursor=${cursor} のように order を揃えて呼び直すか、` +
              'cursor を付けずに先頭から呼び直すこと。',
          );
        }
        if (cursorOutcome.kind === 'origin-mismatch') {
          const cursorOriginText =
            cursorOutcome.cursorOrigin === undefined
              ? '絞っていない'
              : cursorOutcome.cursorOrigin.join(',');
          const currentOriginText = origin === undefined ? '絞っていない' : origin.join(',');
          const cursorOriginArg =
            cursorOutcome.cursorOrigin === undefined
              ? ''
              : `origin=${cursorOutcome.cursorOrigin.join(',')} `;
          return text(
            `cursor は origin=${cursorOriginText} の一覧から出た続きの位置で、` +
              `いまの呼び（origin=${currentOriginText}）と食い違う。` +
              `commitment_list ${cursorOriginArg}order=${effectiveOrder} ` +
              `includeClosed=${includeClosed === true} cursor=${cursor} のように origin を揃えて` +
              '呼び直すか、cursor を付けずに先頭から呼び直すこと。',
          );
        }
        if (cursorOutcome.kind === 'q-mismatch') {
          const cursorQText = cursorOutcome.cursorQ ?? '（絞っていない）';
          const currentQText = q ?? '（絞っていない）';
          const cursorQArg =
            cursorOutcome.cursorQ === undefined ? '' : `q=${cursorOutcome.cursorQ} `;
          return text(
            `cursor は q="${cursorQText}" の一覧から出た続きの位置で、` +
              `いまの呼び（q="${currentQText}"）と食い違う。` +
              `commitment_list ${cursorQArg}order=${effectiveOrder} ` +
              `includeClosed=${includeClosed === true} cursor=${cursor} のように q を揃えて` +
              '呼び直すか、cursor を付けずに先頭から呼び直すこと。',
          );
        }
        const view = cursorOutcome.view;
        const items = view.map((entry) =>
          renderListingEntry({
            id: entry.id,
            title: commitmentOriginBadge(entry),
            createdAt: entry.at,
            updatedAt: commitmentUpdatedAt(entry),
            summary: excerptLine(entry.body, COMMITMENT_BODY_LIMIT),
            extra: [
              entry.closedAt === undefined
                ? '  状態: 未了'
                : `  状態: ${entry.closedAt} に片付けた（${excerptLine(entry.closedReason ?? '', 120)}）`,
            ],
          }),
        );
        const appliedFilters = [
          ...(origin === undefined ? [] : ['origin']),
          ...(q === undefined ? [] : ['q']),
        ];
        const lines = [
          entries.length === 0
            ? // 絞り込みで0件になったのを「読める行が無い」と言い分ける: 台帳の破損（`unreadable`）を疑わせないため
              allEntries.length === 0
              ? '（読める行は無い）'
              : `（この${appliedFilters.join('・')}の絞り込みに当たる行は無い）`
            : view.length === 0
              ? // 絞り込みの結果ではなく、もうこれ以上先が無いことを明示する
                '（cursor より後ろの行は無い。これが最後の頁）'
              : renderListing(items, {
                  budget: COMMITMENT_LIST_BUDGET,
                  // `includeClosed` のときは「未了は」と言わない: `total` に片付いた分も含まれ、未了として数えた嘘になるため
                  // ここではあえて `renderListing` が渡す値（`view.length`）を使わず `entries.length` を `total` にする: cursor で頁が進んでも変わらない母数にするため
                  omitted: ({ rest, shown }) => {
                    const total = entries.length;
                    const lastShown = view[shown - 1];
                    const nextCursor = encodeCommitmentCursor({
                      ...commitmentPosition(lastShown!),
                      includeClosed: includeClosed === true,
                      order: effectiveOrder,
                      ...(origin === undefined ? {} : { origin }),
                      ...(q === undefined ? {} : { q }),
                    });
                    const scopeNoteParts = [
                      ...(origin === undefined ? [] : [`origin: ${origin.join(', ')}`]),
                      ...(q === undefined ? [] : [`q: "${q}"`]),
                    ];
                    const scopeNote =
                      scopeNoteParts.length === 0 ? '' : `${scopeNoteParts.join(' / ')} に絞った、`;
                    const countNote =
                      includeClosed === true
                        ? `片付けた分を含めて ${total} 件あり`
                        : `未了は ${total} 件あり`;
                    const directionNote =
                      effectiveOrder === 'newest'
                        ? includeClosed === true
                          ? '省いたのは、未了ならこれより古い依頼、片付いた分ならこれより新しい記録である。'
                          : '省いたのは、これより古い依頼である。'
                        : includeClosed === true
                          ? '省いたのは、未了ならこれより新しい依頼、片付いた分ならこれより古い記録である。'
                          : '省いたのは、これより新しい依頼である。';
                    const shownOrderNote = effectiveOrder === 'newest' ? '新しい順に' : '古い順に';
                    return (
                      `…ほか ${rest} 件は省略（${scopeNote}${countNote}、${shownOrderNote} ${shown} 件だけ` +
                      `出した。${directionNote}続きは commitment_list cursor=${nextCursor} で取れる` +
                      `（includeClosed=${includeClosed === true} / order=${effectiveOrder} のまま呼ぶこと）。` +
                      '1件の全文は commitment_list id=<id> で取れる）。'
                    );
                  },
                }),
        ];
        // `entries` ではなく `view` で見る: 最後の頁で1件も出していないのにこの2行だけが付くのを避けるため
        if (view.length > 0) {
          lines.push(
            '（本文は240字の抜粋。1件の全文は commitment_list id=<id> で取れる。片付いた件も読める）',
            '（更新＝この1件が最後に変わった時刻。まだ片付けていなければ、受け取った時刻と同じ）',
          );
        }
        if (unreadable.length > 0) {
          const idsAll = unreadable
            .map((entry) => entry.id)
            .filter((id): id is string => id !== undefined);
          // id の列挙にも上限を置く: 台帳の破損の度合いに比例して伸びるため
          const ids = idsAll.slice(0, UNREADABLE_COMMITMENT_IDS_SHOWN);
          const idsRest = idsAll.length - ids.length;
          lines.push(
            `**読めない行が ${unreadable.length} 件ある${
              ids.length > 0
                ? `（id: ${ids.join(', ')}${idsRest > 0 ? ` …ほか ${idsRest} 件は省略` : ''}）`
                : ''
            }。片付いたのではない。**`,
          );
        }
        if (trimmedClosed > 0) {
          lines.push(
            `**保持上限を超えて物理削除された片付き行が累計 ${trimmedClosed} 件ある。** ` +
              'この記憶ストアは片付いた行を新しい順に一定件数までしか残さない。' +
              '削除された分の内容はここでは二度と読めない（日誌側の記録が唯一の手掛かりになる）。',
          );
        }
        return text(lines.join('\n'));
      },
    ),

    tool(
      'commitment_open',
      [
        '自分で気づいたことを、引き受けた仕事として台帳に載せる。',
        '人間が「あ、これ直さないと」と思ったときにメモするのと同じもので、',
        'いま手を付けないなら**必ずここへ置くこと** — 会話の文脈はやがて要約に潰れ、',
        '記憶は時計を持たないので、そこにだけ置いた宿題は思い出せるかどうかの賭けになる。',
        '記憶へ書くのは判断の根拠のほうで、両方やってよい。',
      ].join(' '),
      {
        body: z
          .string()
          .describe(
            `何を引き受けたか。後日のあなたが読んでそのまま動ける粒度で書く（対象・狙い・どこまでやるか。${formatStringLengthJa({ min: 1 })}）`,
          ),
        source: z
          .string()
          .optional()
          .describe('関係する相手や出所（マネージャー id・会話 id など。分かるときだけ）'),
      },
      async ({ body, source }) => {
        // NUL を落とした後の値で検める: 台帳の入口は本文から NUL を落として残すので、生の値で数えると NUL だけの本文が通って空になるため
        const bodyError = describeStringLengthViolation('body', stripNul(body), { min: 1 });
        if (bodyError !== null) return text(bodyError);
        // source も NUL を落とした後で見る: NUL だけだと空の source の行になるため
        if (source !== undefined && stripNul(source).length === 0) {
          return text(
            'source が空です。NUL だけ・空文字は指定できません。source は分かるときだけ、実のある文字列で渡し、無いなら省略してください。',
          );
        }
        const entry = {
          id: randomUUID(),
          at: new Date().toISOString(),
          origin: 'self' as const,
          ...(source === undefined ? {} : { source }),
          body,
        };
        await stores.commitments.open(entry);
        // 「載せた」と名乗る前に、書いた後のストアを読み直して確かめる: 書き込みが静かに失敗しても呼び出し側からは例外が無かったとしか見えないため
        // 無い・読めないのどちらも「名乗らない」へ倒す: 載ったと確認できていないため
        let confirmed: Commitment | null;
        try {
          confirmed = await stores.commitments.get(entry.id);
        } catch (error) {
          if (!(error instanceof UnreadableCommitmentError)) throw error;
          confirmed = null;
        }
        if (confirmed === null) {
          return text(
            `台帳へ書き込んだが、直後に読み直しても ${entry.id} の行を確認できなかった` +
              '（無い、または読めない）。**「載せた」とは言えない。** ' +
              `commitment_list id=${entry.id} で確かめ、載っていなければ同じ内容で` +
              'もう一度 commitment_open を試すこと。',
          );
        }
        // 存在を確かめられた行だけ日誌に残す: 確かめられていない書き込みを「載せた」と残すと、誤った名乗りを日誌へ複製するため
        await appendJournalOrThrow(
          'commitment_open',
          stores.journal,
          {
            type: 'decision',
            decision: `引き受けた仕事として台帳に載せた（${entry.id}）: ${body}`,
            grounds: '手を付ける前に忘れないため（記憶は時計を持たない）',
          },
          'act-completed',
        );
        return text(`台帳に載せた（${entry.id}）。片付いたら commitment_close で閉じること。`);
      },
    ),

    tool(
      'commitment_close',
      [
        '引き受けた仕事が片付いたことを記録する。**返事をしただけでは閉じない。**',
        '委譲したなら、マネージャーが報告を返して始末がつくまでは開いたままにしておくこと。',
        'やらないと決めたのなら、それも片付いたうちである（理由にそう書いて閉じる）。',
      ].join(' '),
      {
        id: z.string().describe('commitment_list に出ている id'),
        reason: z
          .string()
          .describe(
            `何をもって片付いたとするか（やったこと、あるいはやらないと決めた理由。${formatStringLengthJa({ min: 1 })}）。` +
              '人間はこれを読んで後から否定する',
          ),
      },
      async ({ id, reason }) => {
        const reasonError =
          describeStringLengthViolation('reason', reason, { min: 1 }) ??
          describeBlankViolation('reason', reason);
        if (reasonError !== null) return text(reasonError);
        // 読めない行でも閉じられるようにする: 投げ直さず、下の `close()` の戻り値だけで「閉じられたか」を判定する
        let existing: Commitment | null;
        let unreadable = false;
        try {
          existing = await stores.commitments.get(id);
        } catch (error) {
          if (!(error instanceof UnreadableCommitmentError)) throw error;
          existing = null;
          unreadable = true;
        }
        if (existing === null && !unreadable) {
          return text(await describeCommitmentNotOnLedger(stores, id));
        }
        if (existing !== null && existing.closedAt !== undefined) {
          return text(
            `${id} は既に ${existing.closedAt} に片付けてある（${existing.closedReason ?? ''}）。`,
          );
        }
        // 片付いているかの判定は台帳の戻り値に任せる: 直前の `get` の後に他の経路が先に閉じていると、実際には閉じていないのに日誌へ「片付けた」と書くことになるため
        if (!(await stores.commitments.close(id, new Date().toISOString(), reason, 'clone'))) {
          let after: Commitment | null;
          try {
            after = await stores.commitments.get(id);
          } catch (error) {
            if (!(error instanceof UnreadableCommitmentError)) throw error;
            return text(
              `${id} は既に片付けてある（読めない形で入っているため、いつ・どう片付けたかは分からない）。`,
            );
          }
          return text(
            `${id} は既に ${after?.closedAt ?? '不明な時刻'} に片付けてある（${after?.closedReason ?? '理由の記録なし'}）。`,
          );
        }
        // 自分で閉じたことは日誌に残す: 台帳の片付き行は保持上限で物理削除されうるので、日誌の記録が唯一の手掛かりになるため
        await appendJournalOrThrow(
          'commitment_close',
          stores.journal,
          {
            type: 'decision',
            decision: unreadable
              ? `読めない形で入っていた仕事を自分で片付けた（${id}）: ${reason}`
              : `引き受けた仕事を自分で片付けた（${id}）: ${reason}`,
            grounds: 'クローン自身が commitment_close で閉じた（人間はこれを読んで後から否定する）',
          },
          'act-completed',
        );
        return text(
          unreadable
            ? `${id}（読めない形で入っていた仕事）を片付けた。中身が読めないため、本文の書き直しはできない。`
            : `${id} を片付けた。`,
        );
      },
    ),

    tool(
      'progress_read',
      [
        '作業の進捗を、台帳（引き受けた仕事）と委譲の行から数え直して読む。',
        '積み上がり（未了の件数・起点別・齢）・実施中（委譲）・窓の中の消化・見込みを返す。',
        '**率（%）は出さない**（台帳に総量が無く、分母が定まらない）。取れないものは 0 にせず、状態か理由で言う。',
        '**GitHub（Issue / PR / CI）は観測していない**——出力にある「観測していない」は 0 件という意味ではない。',
        '観測時刻を出力に含む。人間が `alteroid progress` や GET /progress で見るものと同じ数・同じ文である。',
      ].join(' '),
      {
        windowHours: z
          .number()
          .optional()
          .describe(
            `速度と見込みを数える窓の長さ（時間。有限の正数。省略時は ${String(DEFAULT_PROGRESS_WINDOW_HOURS)}）`,
          ),
      },
      async ({ windowHours }) => {
        try {
          return text(
            describeProgress(await readProgress(stores, { now: new Date(), windowHours })),
          );
        } catch (error) {
          if (error instanceof InvalidProgressWindowError) {
            throw new Error(error.message, { cause: error });
          }
          throw error;
        }
      },
    ),

    // 日誌が全行為なので、書けなければ失敗を返す: 書けたふりをしないため
    tool(
      'github_observation_record',
      [
        '自分（または委譲先）が GitHub を見て数えた open Issue / open PR の件数を、日誌へ記録する。',
        '`progress_read` / `GET /progress` の「GitHub」欄はこの記録を返す（デーモンは GitHub を見に行かない。値は観測した側の申告）。',
        '**取れなかった回は数を作らない。** `result: { status: "failed", reason }` で、取れなかったことと理由を記録する（0 件と書かない）。',
        '`query` には**母集合を切った引数を含める**（例: `gh issue list --state open --limit 200`）。`limit` を付けたなら `limit` にも同じ値を入れ、',
        '件数が `limit` に達したときは `truncated: true`（数は下限）にする。',
        '**CI の数え方**: ok のとき、open PR の CI を見たなら `result.ci: { pulls, success, failure, pending, checks }` を付ける（`pulls` は CI を見た PR の数。1つの PR は success / failure / pending のどれか1つに数え、チェックが1件も無い PR はどれにも数えない。3つの和は `pulls` 以下）。',
        '**何を数えたかを `checks` に書く**（例「必須チェックだけ」・check の名前の列挙。500字まで）。`query` が母集合の切り方を持つのと同じで、これが無いと数は読めない。打ち切ったら `ci.truncated: true`。',
        '**CI を取れなかったら `ci` を置かず `result.ciUnavailable` に理由を書く**（`ci` と同時には置けない。0 を書かない）。CI を見ていないなら両方とも省く（読み手には「観測していない」と出る）。',
        '観測者はあなた（clone）として器が記録する（引数では指定できない）。いつ観測するかはここでは決まらない。',
      ].join(' '),
      {
        repo: githubObservationInputSchema.shape.repo.describe('観測した repo（`owner/name`）'),
        query: githubObservationInputSchema.shape.query.describe(
          '何をどう数えたか（母集合を切る引数を含めたコマンド・条件）',
        ),
        limit:
          githubObservationInputSchema.shape.limit.describe('母集合を切った件数の上限（あれば）'),
        result: githubObservationInputSchema.shape.result.describe(
          '観測の結果。ok のときだけ件数（openIssues / openPulls / truncated と、任意で ci または ciUnavailable）、取れなかったときは failed と reason（数は持たない）',
        ),
      },
      async (args) => {
        const parsed = githubObservationInputSchema.omit({ observedBy: true }).safeParse(args);
        if (!parsed.success) {
          // 送られた値は混ぜない（where だけ）。
          const where = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
          return text(
            `github 観測の形が不正のため記録していない${where === '' ? '' : `: ${where}`}。`,
          );
        }
        const entry = await appendJournalOrThrow(
          'github_observation_record',
          stores.journal,
          {
            type: 'github_observation',
            ...parsed.data,
            observedBy: GITHUB_OBSERVATION_CLONE_OBSERVER,
          },
          'act-not-performed',
        );
        return text(
          `GitHub の観測を記録した（${entry.id}。${parsed.data.repo}。観測者 ${GITHUB_OBSERVATION_CLONE_OBSERVER}）。` +
            (parsed.data.result.status === 'failed'
              ? '取れなかった回として記録した（数は無い）。'
              : ''),
        );
      },
    ),

    tool(
      'commitment_edit',
      [
        '台帳に載っている**自分の**行の本文を後から直す（誤字・言葉足らず・状況が変わって書き直したいとき）。',
        '**直せるのは `origin` が `self` の行、つまりあなた自身が `commitment_open` で載せた行だけである。**',
        '人間が積んだ行（`human`）は人間自身が Web UI から直す。マネージャーの報告（`manager`）は誰も直せない。',
        '片付いた行は直せない（積み直すこと）。',
        '**編集の前後の本文は日誌へ逐語で残る**ので、直した後でも元の本文は読み戻せる。',
      ].join(' '),
      {
        id: z.string().describe('commitment_list に出ている id'),
        body: z
          .string()
          .describe(
            `直した後の本文（全文。差分ではない）。後日のあなたが読んでそのまま動ける粒度で書く（${formatStringLengthJa({ min: 1 })}）`,
          ),
      },
      async ({ id, body }) => {
        // NUL を落とした後の値で検める: 台帳の入口は本文から NUL を落として残すので、生の値で数えると NUL だけの本文が通って空になるため
        const bodyError = describeStringLengthViolation('body', stripNul(body), { min: 1 });
        if (bodyError !== null) return text(bodyError);
        // 読めない行は本文の書き直しを通さず名乗るだけにとどめる: 読める本文が無い以上、書き直して読める行へ戻る保証も無いため
        let existing;
        try {
          existing = await stores.commitments.get(id);
        } catch (error) {
          if (!(error instanceof UnreadableCommitmentError)) throw error;
          throw new Error(describeUnreadableCommitment(error), { cause: error });
        }
        if (existing === null) return text(`引き受けた仕事 ${id} は台帳に無い。`);
        // `origin` の判定はストアではなくここでする: 書き換えられるのは常に自分自身の言葉だけという線を人間側とクローン側で同じ形にするため
        if (existing.origin !== 'self') {
          return text(
            `${id} は origin:'${existing.origin}' なので直せない。` +
              (existing.origin === 'human'
                ? '人間が積んだ行は人間自身が Web UI / API から直す。'
                : 'マネージャーの報告（manager）や外から届いた出来事（external）の本文は誰も直せない。') +
              '書き換えてよいのは、あなたが commitment_open で載せた行（self）だけである。',
          );
        }
        const before = existing.body;
        if (!(await stores.commitments.editBody(id, body, new Date().toISOString(), 'clone'))) {
          const after = await stores.commitments.get(id);
          return text(
            `${id} は既に ${after?.closedAt ?? '不明な時刻'} に片付けてある` +
              `（${after?.closedReason ?? '理由の記録なし'}）ので直せない。` +
              '片付いた行を書き直したいなら、commitment_open で新しく載せること。',
          );
        }
        // 編集の前後を両方、日誌へ逐語で残す: 原文が日誌から読み戻せることが、クローンが過去の自分を追える条件のため
        await appendJournalOrThrow(
          'commitment_edit',
          stores.journal,
          {
            type: 'decision',
            decision:
              `引き受けた仕事の本文を直した（${id}）: ` + `編集前「${before}」→ 編集後「${body}」`,
            grounds: '自分で載せた行の本文を自分で直した（原文は日誌に残す）',
          },
          'act-completed',
        );
        return text(`${id} の本文を直した（元の本文は日誌に残してある）。`);
      },
    ),

    tool(
      'commitment_close_many',
      [
        '台帳の未了の行を、**絞り込みを渡してまとめて閉じる**。',
        '1件ずつの `commitment_close` では到達できない数（数千件）が溜まったときの口である。',
        '**既定は試算で、1件も閉じない。** 実際に閉じるには `dryRun: false` を明示すること —— ',
        '閉じた行を開き直す道具はこの器に無いので、撃ち間違えは道具では戻せない。',
        '**`origin` は必須で、在る起点（human / manager / external / self）を全部並べた呼びは断る**' +
          '（「全部閉じる」を1回で撃てる形は作らない）。',
        '行は消えない（`closedAt` / `closedReason` が付くだけ）。**閉じた id は全部日誌に残る。**',
      ].join(''),
      {
        origin: z
          .array(z.enum(commitmentOriginSchema.options))
          .describe(
            `閉じる対象の起点（必須。${formatArrayLengthJa({ min: 1 })}）。在る起点を全部（human / manager / external / self）並べると断られる。` +
              'manager の行を巻き込むつもりなら manager と自分で打つこと',
          ),
        source: z
          .array(z.string())
          .optional()
          .describe(
            `出所の**完全一致**（例 ["token-pool"]。配列は${formatArrayLengthJa({ min: 1 })}、各要素は${formatStringLengthJa({ min: 1 })}）。q の部分一致とは別物で、` +
              '器が自分へ出している合図だけを狙い撃つためにある',
          ),
        q: z
          .string()
          .optional()
          .describe(
            `本文か出所への部分一致（大文字小文字を区別しない。${formatStringLengthJa({ min: 1 })}）。commitment_list の q と同じ当て方`,
          ),
        until: z
          .string()
          .optional()
          .describe(
            `この時刻までに載った行だけを対象にする（ISO8601。${formatStringLengthJa({ min: 1 })}。その瞬間ちょうどの行は含む）。` +
              '元に戻せない操作なので時差が必須（Z か +09:00。例 2026-09-11T19:00:00Z。時差の無い形は断る）。' +
              '閉じている最中に届いた新しい行を巻き込まないために使う',
          ),
        reason: z
          .string()
          .describe(
            `何をもってこの絞り込みに当たる行が片付いたとするか（${formatStringLengthJa({ min: 1 })}）。人間はこれを読んで後から否定する`,
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            '省略すると true（何件当たるかを数えるだけで1件も閉じない）。実際に閉じるときだけ false を明示する',
          ),
        limit: z
          .number()
          .optional()
          .describe(
            `1回の呼びで閉じる上限（${formatIntRangeJa({ min: 1, max: CLOSE_MANY_LIMIT_MAX })}。省略すると 500）。**古い側から**閉じる。` +
              '残りは同じ絞り込みでもう一度呼べば続けられる',
          ),
      },
      async ({ origin, source, q, until, reason, dryRun, limit }) => {
        const limitError = describeIntRangeViolation('limit', limit, {
          min: 1,
          max: CLOSE_MANY_LIMIT_MAX,
        });
        if (limitError !== null) return text(limitError);
        const originError = describeArrayLengthViolation('origin', origin, { min: 1 });
        if (originError !== null) return text(originError);
        const sourceLengthError = describeArrayLengthViolation('source', source, { min: 1 });
        if (sourceLengthError !== null) return text(sourceLengthError);
        const sourceElementError = describeStringArrayElementLengthViolation('source', source);
        if (sourceElementError !== null) return text(sourceElementError);
        const qError = describeStringLengthViolation('q', q, { min: 1 });
        if (qError !== null) return text(qError);
        const untilLengthError = describeStringLengthViolation('until', until, { min: 1 });
        if (untilLengthError !== null) return text(untilLengthError);
        const reasonError =
          describeStringLengthViolation('reason', reason, { min: 1 }) ??
          describeBlankViolation('reason', reason);
        if (reasonError !== null) return text(reasonError);
        // 絞り込みの無い呼びを断る: 「全部閉じる」が事故で撃てる形を作らないため。確認用の追加の引数は作らない: `dryRun` の既定と2重に問うことになり、どちらが効いたのか読めなくなるため
        if (commitmentOriginSchema.options.every((known) => origin.includes(known))) {
          return text(
            'origin に在る起点を全部（human / manager / external / self）並べた呼びは断る——' +
              'それは絞り込みが無いのと同じで、1回で台帳を空にできてしまう。' +
              '閉じたい起点だけを名指しすること（例 origin: ["external"]）。**1件も閉じていない。**',
          );
        }
        // 読めない `until` を「絞り込みが当たらなかった」に混ぜない: 打ち間違いが「0件だった」に化けて静かに通るため
        // 時差（`Z` / `±hh:mm`）を必須にする: 元に戻せない一括操作で、時差の無い形は `Date.parse` が地方時刻として読み境界が黙ってずれるため
        if (until !== undefined && !isOffsetQualifiedTimeBoundary(until)) {
          return text(
            describeOffsetRequiredTimeBoundary('until', until, '2026-09-11T19:00:00.000Z') +
              '**1件も閉じていない。**',
          );
        }

        const { entries: openEntries, unreadable } = await stores.commitments.list();
        // 絞りは `commitment_list` と同じ側・同じ当て方で当てる: 下見した結果とこの道具が閉じる集合が食い違わないことが、一括で閉じてよいと判断できる唯一の根拠のため
        const afterOrigin = openEntries.filter((entry) => origin.includes(entry.origin));
        const afterSource =
          source === undefined
            ? afterOrigin
            : afterOrigin.filter(
                (entry) => entry.source !== undefined && source.includes(entry.source),
              );
        const needle = q?.toLowerCase();
        const afterQ =
          needle === undefined
            ? afterSource
            : afterSource.filter(
                (entry) =>
                  entry.body.toLowerCase().includes(needle) ||
                  (entry.source !== undefined && entry.source.toLowerCase().includes(needle)),
              );
        const untilMs = until === undefined ? undefined : Date.parse(until);
        const matched =
          untilMs === undefined
            ? afterQ
            : afterQ.filter((entry) => Date.parse(entry.at) <= untilMs);

        const filterText = [
          `origin=[${origin.join(', ')}]`,
          ...(source === undefined ? [] : [`source=[${source.join(', ')}]（完全一致）`]),
          ...(q === undefined ? [] : [`q="${q}"`]),
          ...(until === undefined ? [] : [`until=${until}`]),
        ].join(' / ');
        // 漏斗（段ごとの残数）を必ず出す: 「0件だった」と「絞り込みが間違っていた」はどの段で0になったかでしか区別できないため
        const funnel = [
          `未了 ${openEntries.length} 件`,
          `origin=[${origin.join(', ')}] で ${afterOrigin.length} 件`,
          ...(source === undefined ? [] : [`source（完全一致）で ${afterSource.length} 件`]),
          ...(q === undefined ? [] : [`q で ${afterQ.length} 件`]),
          ...(until === undefined ? [] : [`until で ${matched.length} 件`]),
        ].join(' → ');
        // 読めない行は件数を黙って落とさない: 「これで全部だ」と読まれるため
        const unreadableNote =
          unreadable.length === 0
            ? []
            : [
                `⚠ 読めない行が ${unreadable.length} 件ある。` +
                  'この道具は絞り込みを当てられないので対象に含めていない（commitment_list で確かめること）。',
              ];

        if (matched.length === 0) {
          // 0件の理由を段で名指しする: 1つの文言で済ませると「当たるものが無かった」と「絞り込みを間違えた」が同じ顔になるため
          let why: string;
          if (openEntries.length === 0) {
            why =
              '台帳に未了が1件も無い。**絞り込みの問題ではない**（閉じるべきものがそもそも無い）。';
          } else if (afterOrigin.length === 0) {
            const breakdown = commitmentOriginSchema.options
              .map(
                (known) =>
                  `${known} ${openEntries.filter((entry) => entry.origin === known).length}`,
              )
              .join(' / ');
            why =
              `未了 ${openEntries.length} 件のうち origin=[${origin.join(', ')}] に当たる行が0件——` +
              `**絞り込みが外れている。** いま未了に在る起点の内訳: ${breakdown}`;
          } else if (source !== undefined && afterSource.length === 0) {
            const counts = new Map<string, number>();
            for (const entry of afterOrigin) {
              if (entry.source === undefined) continue;
              counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1);
            }
            const top = [...counts.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, CLOSE_MANY_SOURCES_SHOWN)
              .map(([name, count]) => `${name} ${count}`)
              .join(' / ');
            const rest = counts.size - Math.min(counts.size, CLOSE_MANY_SOURCES_SHOWN);
            why =
              `origin では ${afterOrigin.length} 件当たったが source=[${source.join(', ')}] の完全一致で0件——` +
              `**この source は台帳に無い。** 当たった行に実在する source（多い順）: ` +
              `${top === '' ? '（source を持つ行が無い）' : top}` +
              `${rest > 0 ? ` …ほか ${rest} 種は省略` : ''}`;
          } else if (q !== undefined && afterQ.length === 0) {
            why =
              `source までで ${afterSource.length} 件当たったが q="${q}" に当たる行が0件` +
              '（本文と出所の両方を見て当たらなかった）。';
          } else {
            const oldest = afterQ.reduce(
              (acc, entry) => (acc === undefined || entry.at < acc ? entry.at : acc),
              undefined as string | undefined,
            );
            why =
              `q までで ${afterQ.length} 件当たったが until=${until} より前の行が0件` +
              `（当たった行のうち最も古いのは ${oldest ?? '不明'}）。`;
          }
          return text(
            [
              '絞り込みに当たる未了は0件だった。**1件も閉じていない。**',
              funnel,
              why,
              ...unreadableNote,
            ].join('\n'),
          );
        }

        const effectiveLimit = limit ?? CLOSE_MANY_LIMIT_DEFAULT;
        const targets = matched.slice(0, effectiveLimit);
        const rest = matched.length - targets.length;
        const restNote =
          rest === 0
            ? []
            : [
                `1回の上限（${effectiveLimit} 件）に当たったので、残り ${rest} 件は対象にしていない。` +
                  '**同じ絞り込みでもう一度呼べば続きを閉じられる。**',
              ];

        if (dryRun !== false) {
          // 省略された `dryRun` は試算にする: 閉じた行を開き直す道具が無く、撃ち間違えた一括 close は戻せないため
          const shown = targets.slice(0, CLOSE_MANY_IDS_SHOWN).map((entry) => entry.id);
          const hidden = targets.length - shown.length;
          return text(
            [
              `**試算（dryRun）。1件も閉じていない。** 実際に閉じるには dryRun: false を渡すこと。`,
              funnel,
              `絞り込み: ${filterText}`,
              `この呼びで閉じるのは ${targets.length} 件（当たったのは ${matched.length} 件）。` +
                `いちばん古いのは ${targets[0]?.at ?? '不明'}、いちばん新しいのは ${
                  targets[targets.length - 1]?.at ?? '不明'
                }。`,
              `対象の id（先頭 ${shown.length} 件）: ${shown.join(', ')}${
                hidden > 0 ? ` …ほか ${hidden} 件は省略` : ''
              }`,
              ...restNote,
              ...unreadableNote,
            ].join('\n'),
          );
        }

        // 塊ごとに「閉じる → その塊の id を日誌へ書く」を交互に回す: まとめて閉じてから日誌を書くと、器が落ちたとき閉じたのに記録が無い行が最大 `CLOSE_MANY_LIMIT_DEFAULT` 件できるため
        const chunks = chunkIdsByChars(
          targets.map((entry) => entry.id),
          CLOSE_MANY_JOURNAL_ID_CHARS,
        );
        const now = new Date().toISOString();
        const closedIds: string[] = [];
        // 「日誌に N 件」は実際に書いた件数で数える: `chunks.length` で言うと、塊が丸ごと競合になった回に無い日誌の行を名乗るため
        let journaledChunks = 0;
        for (const [index, chunk] of chunks.entries()) {
          const closed = await stores.commitments.closeMany(chunk, now, reason, 'clone');
          closedIds.push(...closed);
          // 1件も閉じられなかった塊では日誌へ書かない: 抜けている塊番号そのものが「その塊は1件も閉じなかった」を意味するため
          if (closed.length === 0) continue;
          journaledChunks += 1;
          await appendJournalOrThrow(
            'commitment_close_many',
            stores.journal,
            {
              type: 'decision',
              decision:
                `引き受けた仕事を絞り込みで一括して片付けた` +
                `（${index + 1}/${chunks.length} 塊目、この塊は ${closed.length} 件）: ${reason}\n` +
                `絞り込み: ${filterText}\n` +
                `閉じた id: ${closed.join(' ')}`,
              // `grounds` には id を置かない: この欄は操作の由来を名乗る文で、控えを置く場所ではないため
              grounds:
                'クローン自身が commitment_close_many で絞り込んで閉じた（人間はこれを読んで後から否定する）',
            },
            'act-completed',
          );
        }

        // 当たったのに閉じられなかった分を黙らせない: 「全部閉じた」と読まれると次の呼びの判断が狂うため
        const raced = targets.length - closedIds.length;
        const shownClosed = closedIds.slice(0, CLOSE_MANY_IDS_SHOWN);
        const hiddenClosed = closedIds.length - shownClosed.length;
        return text(
          [
            `**${closedIds.length} 件を片付けた**（理由: ${reason}）。`,
            funnel,
            `絞り込み: ${filterText}`,
            `閉じた id（先頭 ${shownClosed.length} 件）: ${shownClosed.join(', ')}${
              hiddenClosed > 0
                ? ` …ほか ${hiddenClosed} 件は省略（**全 id は日誌に ${journaledChunks} 件に分けて残してある**）`
                : ''
            }`,
            ...(raced === 0
              ? []
              : [
                  `⚠ 対象 ${targets.length} 件のうち ${raced} 件は閉じられなかった` +
                    '（この呼びの最中に他の経路が先に閉じた）。',
                ]),
            ...restNote,
            ...unreadableNote,
          ].join('\n'),
        );
      },
    ),

    // 人間起点の合図（`human_message` / `human_answer`）を選べない形にする: クローンは自分の側の都合で溜まった合図だけを畳める
    // 絞り込みの判定をストアへ複製しない: SQL 側へ同じ判定を書くと「一覧に見えている件数」と「実際に消える件数」が別の実装を持つことになるため

    tool(
      'inbox_remove_many',
      [
        '受信箱（`InboxStore`）の未読を、**絞り込みを渡してまとめて畳む（消す）**。',
        '1件ずつ消す道具（内部の `remove()`）はこの器から呼べない——同じ失敗の写しが',
        '数千件積もると、1ターン1件のペースでの排出それ自体が文脈窓を食い潰す（issue #972）。',
        '**既定は試算（dryRun）で、1件も消さない。** 実際に消すには `dryRun: false` を明示すること——',
        '消した合図を戻す道具はこの器に無いので、撃ち間違えは道具では戻せない。',
        `**\`types\` は必須で、選べる5種類（${CLONE_REMOVABLE_INBOX_EVENT_TYPES.join(' / ')}）を` +
          '全部並べた呼びは断る**' +
          '（「全部消す」を1回で撃てる形は作らない——それは `POST /reset` の役目である）。',
        '**人間起点の合図（`human_message` / `human_answer`）はそもそも選べない。**' +
          'あなたは自分の側の都合で溜まった合図だけを畳める——人間から届いた合図を' +
          '自分の判断で畳む口は、この道具には無い（オーナー判断。issue #972）。',
        '**行は消える。** `commitment_close_many` の「閉じる（closedAt を付けるだけで行は残る）」とは違い、',
        '受信箱は「まだ処理し終えていない」という事実だけを持つ器で、片付いた後の記録を残す場所ではない',
        '（`InboxStore` の doc）。**消した id は全部日誌に残る。**',
      ].join(''),
      {
        types: inboxRemoveManyTypesToolInputSchema.describe(
          `消す対象の種類（必須。${formatArrayLengthJa({ min: 1 })}）。選べる5種類 ` +
            `(${CLONE_REMOVABLE_INBOX_EVENT_TYPES.join(' / ')}) を全部並べると断られる。` +
            '人間起点の human_message / human_answer はここに無い——選べない' +
            '（自分の受信箱から人間の発言・回答を自分の判断で畳むことはできない）。' +
            '例: 委譲先の429の写しを畳むなら manager_message だけを狙う',
        ),
        sources: z
          .array(z.string())
          .optional()
          .describe(
            `送信元の**完全一致**（配列は${formatArrayLengthJa({ min: 1 })}、各要素は${formatStringLengthJa({ min: 1 })}）。\`manager_list\` の内訳（送信元）に出る表記` +
              '（例 "external:token-pool" / "manager:mgr-xxx"）をそのまま渡す。' +
              '送信元を言えない種類（distill / timer / self_initiative）の行は、' +
              'これを渡すと必ず対象から外れる',
          ),
        before: z
          .string()
          .optional()
          .describe(
            `この時刻**以前**（ISO8601、その瞬間ちょうども含む。${formatStringLengthJa({ min: 1 })}）に積まれた行だけを対象にする。` +
              '元に戻せない操作なので時差が必須（Z か +09:00。例 2026-09-15T00:00:00Z。時差の無い形は断る）。' +
              '消している最中に届いた新しい行を巻き込まないために使う',
          ),
        reason: z
          .string()
          .describe(
            `何をもってこの絞り込みに当たる行を畳んでよいとしたか（${formatStringLengthJa({ min: 1 })}）。人間はこれを読んで後から否定する`,
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            '省略すると true（何件当たるかを数えるだけで1件も消さない）。実際に消すときだけ false を明示する',
          ),
        limit: z
          .number()
          .optional()
          .describe(
            `1回の呼びで消す上限（${formatIntRangeJa({ min: 1, max: REMOVE_MANY_LIMIT_MAX })}。省略すると 500）。**古い側から**消す。` +
              '残りは同じ絞り込みでもう一度呼べば続けられる',
          ),
      },
      async ({ types, sources, before, reason, dryRun, limit }) => {
        const limitError = describeIntRangeViolation('limit', limit, {
          min: 1,
          max: REMOVE_MANY_LIMIT_MAX,
        });
        if (limitError !== null) return text(limitError);
        if (!inboxRemoveManyTypesSchema.safeParse(types).success) {
          return text(`types は使えない（${formatArrayLengthJa({ min: 1 })}）。`);
        }
        const sourcesLengthError = describeArrayLengthViolation('sources', sources, { min: 1 });
        if (sourcesLengthError !== null) return text(sourcesLengthError);
        const sourcesElementError = describeStringArrayElementLengthViolation('sources', sources);
        if (sourcesElementError !== null) return text(sourcesElementError);
        const beforeLengthError = describeStringLengthViolation('before', before, { min: 1 });
        if (beforeLengthError !== null) return text(beforeLengthError);
        const reasonError =
          describeStringLengthViolation('reason', reason, { min: 1 }) ??
          describeBlankViolation('reason', reason);
        if (reasonError !== null) return text(reasonError);
        // 絞り込みの無い呼びを断る: 「全部」は選べる5種類を指し、その2種は zod の enum が型で塞いでいるため実行時に弾くのは5種類を全部選んだ場合だけ
        if (CLONE_REMOVABLE_INBOX_EVENT_TYPES.every((known) => types.includes(known))) {
          return text(
            `types に選べる5種類（${CLONE_REMOVABLE_INBOX_EVENT_TYPES.join(', ')}）を全部並べた` +
              '呼びは断る——それは絞り込みが無いのと同じで、1回で（人間起点を除く）受信箱を' +
              '空にできてしまう。消したい種類だけを名指しすること（例 types: ["manager_message"]）。' +
              '**1件も消していない。**',
          );
        }
        // 読めない `before` を「絞り込みが当たらなかった」に混ぜない・時差を必須にする: `until` と同じ理由
        if (before !== undefined && !isOffsetQualifiedTimeBoundary(before)) {
          return text(
            describeOffsetRequiredTimeBoundary('before', before, '2026-09-15T00:00:00.000Z') +
              '**1件も消していない。**',
          );
        }

        const filter: InboxRemoveManyFilter = {
          types,
          ...(sources === undefined ? {} : { sources }),
          ...(before === undefined ? {} : { before }),
        };
        const peek = await stores.inbox.peekPending();
        const allPending = peek.entries;
        // 読めない行は絞り込みの材料が取れず対象にできないので、「未読が1件も無い」とは言わない: 消していないだけで受信箱に在るため
        const unreadableNote = describeUnreadableInboxEvents(peek.unreadable);
        const matched = allPending.filter((row) => matchesInboxRemoveManyFilter(row, filter));

        const filterText = [
          `types=[${types.join(', ')}]`,
          ...(sources === undefined ? [] : [`sources=[${sources.join(', ')}]（完全一致）`]),
          ...(before === undefined ? [] : [`before=${before}`]),
        ].join(' / ');
        const funnel = `未読 ${allPending.length} 件 → 絞り込みで ${matched.length} 件`;

        if (matched.length === 0) {
          let why: string;
          if (allPending.length === 0 && unreadableNote !== null) {
            why = `読めた未読が1件も無い。ただし ${unreadableNote}この道具では選べず、1件も消していない。`;
          } else if (allPending.length === 0) {
            why =
              '受信箱に未読が1件も無い。**絞り込みの問題ではない**（消すべきものがそもそも無い）。';
          } else {
            const breakdown = CLONE_REMOVABLE_INBOX_EVENT_TYPES.map(
              (known) => `${known} ${allPending.filter((row) => row.event.type === known).length}`,
            ).join(' / ');
            const humanCount = allPending.filter(
              (row) => row.event.type === 'human_message' || row.event.type === 'human_answer',
            ).length;
            why =
              `未読 ${allPending.length} 件のうち絞り込みに当たる行が0件——**絞り込みが外れている。**` +
              ` いま未読に在る種類の内訳（選べる5種類のみ）: ${breakdown}` +
              `${humanCount > 0 ? `（このほか人間起点の行が ${humanCount} 件あるが、この道具では選べない）` : ''}`;
          }
          return text(
            ['絞り込みに当たる未読は0件だった。**1件も消していない。**', funnel, why].join('\n'),
          );
        }

        const effectiveLimit = limit ?? REMOVE_MANY_LIMIT_DEFAULT;
        const targets = matched.slice(0, effectiveLimit);
        const rest = matched.length - targets.length;
        const restNote =
          rest === 0
            ? []
            : [
                `1回の上限（${effectiveLimit} 件）に当たったので、残り ${rest} 件は対象にしていない。` +
                  '**同じ絞り込みでもう一度呼べば続きを消せる。**',
              ];

        if (dryRun !== false) {
          // 省略された `dryRun` は試算にする: 消した合図を戻す道具が無いため
          const shown = targets.slice(0, REMOVE_MANY_IDS_SHOWN).map((row) => row.event.id);
          const hidden = targets.length - shown.length;
          return text(
            [
              `**試算（dryRun）。1件も消していない。** 実際に消すには dryRun: false を渡すこと。`,
              funnel,
              `絞り込み: ${filterText}`,
              `この呼びで消すのは ${targets.length} 件（当たったのは ${matched.length} 件）。` +
                `いちばん古いのは ${targets[0]?.at ?? '不明'}、いちばん新しいのは ${
                  targets[targets.length - 1]?.at ?? '不明'
                }。`,
              `対象の id（先頭 ${shown.length} 件）: ${shown.join(', ')}${
                hidden > 0 ? ` …ほか ${hidden} 件は省略` : ''
              }`,
              ...restNote,
            ].join('\n'),
          );
        }

        // 配達を止める口が無ければ1件も消さない: 行を消した状態で配達だけが続くほうが、1件も消さないより悪い（掃除できたと誤解するのにターンは起き続ける）ため
        const stopDelivery = context.dropQueuedInboxEvents;
        if (stopDelivery === undefined) {
          return text(
            [
              '**1件も消していない。** 配達の待ち行列から落とす口が渡されていないので、' +
                'この道具は消し込みを拒んだ。',
              '消しても、既にクローンのメモリ上の待ち行列へ載った合図は配られ続ける' +
                '（issue #1049）。「消した」と名乗って配達が続く状態を作らないために、' +
                'ここで止めている。',
              '⚠️ これは配線の不備である（本番の `ToolContext` は2箇所とも' +
                '`dropQueuedInboxEvents` を渡している）。人間へ上げること。',
            ].join('\n'),
          );
        }

        // 塊ごとに「消す → その塊の id を日誌へ書く」を交互に回す: まとめて消してから日誌を書くと、器が落ちたとき消えたのに記録が無い行が最大 `REMOVE_MANY_LIMIT_DEFAULT` 件できるため
        const chunks = chunkIdsByChars(
          targets.map((row) => row.event.id),
          REMOVE_MANY_JOURNAL_ID_CHARS,
        );
        const removedIds: string[] = [];
        let droppedFromDelivery = 0;
        // 「日誌に N 件」は実際に書いた件数で数える: `chunks.length` で言うと、塊が丸ごと競合になった回に無い日誌の行を名乗るため
        let journaledChunks = 0;
        for (const [index, chunk] of chunks.entries()) {
          // `stores.inbox.removeMany` を直に呼ばない: 器から消すのと配達を止めるのを1つの呼びで行う関数を通すため
          const outcome = await removeInboxEventsAndStopDelivery(
            stores.inbox,
            { dropQueuedInboxEvents: stopDelivery },
            chunk,
          );
          const removed = outcome.removedIds;
          droppedFromDelivery += outcome.droppedFromDelivery;
          removedIds.push(...removed);
          if (removed.length === 0) continue;
          journaledChunks += 1;
          await appendJournalOrThrow(
            'inbox_remove_many',
            stores.journal,
            {
              type: 'decision',
              decision:
                `受信箱の未読を絞り込みで一括して畳んだ（消した）` +
                `（${index + 1}/${chunks.length} 塊目、この塊は ${removed.length} 件）: ${reason}\n` +
                `絞り込み: ${filterText}\n` +
                `消した id: ${removed.join(' ')}`,
              grounds:
                'クローン自身が inbox_remove_many で絞り込んで消した（人間はこれを読んで後から否定する）',
            },
            'act-completed',
          );
        }

        const raced = targets.length - removedIds.length;
        const shownRemoved = removedIds.slice(0, REMOVE_MANY_IDS_SHOWN);
        const hiddenRemoved = removedIds.length - shownRemoved.length;
        return text(
          [
            `**${removedIds.length} 件を畳んだ（消した）**（理由: ${reason}）。`,
            funnel,
            `絞り込み: ${filterText}`,
            `消した id（先頭 ${shownRemoved.length} 件）: ${shownRemoved.join(', ')}${
              hiddenRemoved > 0
                ? ` …ほか ${hiddenRemoved} 件は省略（**全 id は日誌に ${journaledChunks} 件に分けて残してある**）`
                : ''
            }`,
            // 配達の側にも届いたことを名乗る: 消えた件数だけを出すと器の行しか消さずに「消した」と名乗る形に戻るため
            `配達の待ち行列からも外したのは ${droppedFromDelivery} 件` +
              `（残りは器に在っただけで、まだ配達待ちには載っていなかった分である。` +
              `**既に取り出して処理中のものは取り消せない。**）`,
            ...(raced === 0
              ? []
              : [
                  `⚠ 対象 ${targets.length} 件のうち ${raced} 件は消せなかった` +
                    '（この呼びの最中に他の経路が先に消した）。',
                ]),
            ...restNote,
          ].join('\n'),
        );
      },
    ),

    tool(
      'profile_read',
      [
        '実行環境プロファイル（人間の ~/.zprofile / /etc/profile.d に当たるもの）を読む。',
        'プロファイルは**名前付きの行**の集まりで、行ごとに本文（何行でもよい）と撒く先（all / app / runner）を持つ。',
        'name を省略すると行の一覧（名前・撒く先・バイト数・更新時刻。**本文は載らない**）、',
        'name を渡すとその行の本文を返す。',
        '行は名前のコード単位順（辞書順）につなげられて、撒く先が掛かる側（あなた自身／マネージャーと作業者）へ効く。',
        '**本文には鍵が入っている。読んだ中身を記憶や日誌へ書き写さないこと**',
        '（記憶はあなたのシステムプロンプトに載るし、人間がいつでも開く場所である）。',
      ].join(' '),
      {
        name: z
          .string()
          .optional()
          .describe('読む行の名前。省略すると行の一覧を返す（本文は載らない）'),
        offset: z
          .number()
          .optional()
          .describe(
            `何文字目から読むか（name を渡したときだけ。${formatIntRangeJa({ min: 0 })}。既定 0）`,
          ),
      },
      async ({ name, offset = 0 }) => {
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        const rows = await stores.profile.list();
        if (rows.length === 0) {
          return text('実行環境プロファイルは置かれていない。');
        }
        if (name === undefined) {
          return text(
            [
              renderListing(
                rows.map(
                  (row) =>
                    `- ${row.name} / 撒く先 ${row.scope} / ${String(Buffer.byteLength(row.script))} バイト / 更新 ${row.updatedAt}`,
                ),
                {
                  budget: PROFILE_LIST_BUDGET,
                  omitted: ({ rest, shown, total }) =>
                    `…ほか ${rest} 件は省略（全 ${total} 件のうち ${shown} 件だけ出した。名前が分かっていれば profile_read name=<名前> で取れる）。`,
                },
              ),
              '（本文は載せていない。取るには profile_read name=<名前>。つなげる順番は名前のコード単位順。',
              '更新時刻は「最後に本文か撒く先を変えた時刻」で、作成時刻は持っていない）',
            ].join('\n'),
          );
        }
        const row = rows.find((entry) => entry.name === name);
        if (row === undefined) {
          return text(
            `プロファイルに行 ${name} は無い。行の一覧は profile_read（name を省略）で取れる。`,
          );
        }
        const part = page(row.script, offset, PROFILE_PAGE);
        // 「切れている」だけで終えず、書き戻す前に何をすべきかまで言う: 切れたものを `profile_write` へ渡すと、全文置換で検証を通ってしまい行が縮むため
        const tail = part.more
          ? `\n…（ここで切れている。続きは profile_read name=${row.name} offset=${part.to}。` +
            '**profile_write は行の全文置換なので、書き戻すつもりなら先に offset を進めて' +
            '最後まで取ること** — ここまでの分だけを渡すと残りが消える）'
          : '';
        return text(
          `（行 ${row.name} / 撒く先 ${row.scope} / 最終更新 ${row.updatedAt} / ${describePage(part)}）\n${part.body}${tail}`,
        );
      },
    ),

    // 書き込みは渡さない: 枠に当たったクローンはターンを回さないので、判断を待つ設計はいちばん要るときに動かないため
    tool(
      'token_list',
      [
        '認証トークンのプールを読む（枠に当たったとき実装が回す候補の一覧）。',
        '**値は返らない。** 出るのは id・ラベル・指紋・状態だけである。',
        '**この道具に書き込みは無い。** 回すのは実装であってあなたの判断ではないし、',
        '登録・無効化は人間の手（alteroid token / PUT /tokens）に属する。',
        '枠で止まったときここを見れば、候補が残っているのか全部冷却中なのかが分かる。',
        '回った履歴のほうは journal_read types=token_rotation で引ける。',
      ].join(' '),
      {
        cursor: z
          .string()
          .optional()
          .describe(
            '続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す' +
              '（自分で組み立てない）。省略すると先頭から。',
          ),
      },
      async ({ cursor }) => {
        // `readSettings()` と `readActive()` を素の `Promise.all` に入れない: どちらかが壊れているだけで一覧まで道連れになり、`token_list` そのものが使えなくなるため
        const allTokens = await stores.tokens.list();
        // 読めなかった行を言う: `list()` は読めない行を飛ばすので、プールが「空」に見えても壊れた行が在るかもしれないため
        const unreadableTokensNote = describeUnreadableTokens(await stores.tokens.listUnreadable());
        let settingsLine: string;
        try {
          const settings = await stores.tokens.readSettings();
          settingsLine = `回す契機: ${settings.rotateOn} / 冷却 ${String(settings.cooldownMs)}ms`;
        } catch (error) {
          if (!(error instanceof UnreadableTokenSettingsError)) throw error;
          settingsLine =
            `回転の設定は読めない（${error.message}）。直すには回す契機と冷却の両方を指定して` +
            '設定し直す（`alteroid token policy <free_exhausted|overage_exhausted|off>' +
            ' --cooldown-ms <値>` / `PUT /tokens/policy`）。';
        }
        // 読めないときは `null` で偽装せず `undefined` にする: `null` は「まだ一度も指名していない」という別の意味で、潰すと「指名は無い」という嘘になるため
        let active: ActiveAgentToken | null | undefined;
        let activeLine: string;
        try {
          active = await stores.tokens.readActive();
          activeLine =
            active === null
              ? // `null` を「1本目が現役」と書かない: 器の環境変数だけで走っている既定の構成と、1本目を撒いた後は別の状態のため
                '現役の指名: **まだ一度も無い**（器の環境変数のまま走っている）'
              : `現役の指名: ${active.tokenId}（世代 ${String(active.generation)}、${active.rotatedAt}）`;
        } catch (error) {
          if (!(error instanceof UnreadableActiveTokenError)) throw error;
          active = undefined;
          activeLine = `現役の指名は読めない（${error.message}）。`;
        }
        const resolved = resolveTokenCursor(allTokens, cursor);
        if (resolved.kind === 'malformed') {
          // 黙って先頭からへ倒さない
          return text(
            'この cursor は読めない（壊れているか、この道具のものではない）。' +
              'cursor は前回の応答の断り書きに出たものをそのまま渡すこと（自分で組み立てない）。' +
              '先頭から読み直すなら cursor を省いて呼ぶこと。',
          );
        }
        // cursor を渡されたときだけ「最後の頁」と言う: プールが空のときの言い方を奪わないため
        if (cursor !== undefined && resolved.view.length === 0) {
          return text('（cursor より後ろのトークンは無い。これが最後の頁）');
        }
        const tokens = resolved.view;
        // `toAgentTokenView` を通す: 自分で組むと値を含む `AgentToken` から拾う形になり、いつか `value` が混ざるため
        const views = tokens.map((token) => toAgentTokenView(token));
        const now = Date.now();
        const head = [
          settingsLine,
          activeLine,
          ...(unreadableTokensNote === null ? [] : [unreadableTokensNote]),
        ];
        if (views.length === 0) {
          // 「プールは空である」は読めない行が0件のときだけ言う: 在れば、読めた行が無いとしか言えないため
          return text(
            [
              ...head,
              '',
              ...(unreadableTokensNote === null
                ? ['プールは空である。**この状態では回らない**——枠に当たっても次の候補が無い。']
                : [
                    '読めたトークンの行は無い。**プールが空だとは言えない**——読めない行が在り、' +
                      'それが使えるかどうかはここから分からない。',
                  ]),
              '登録は人間の手で（`alteroid token add --label <名前> --file <path>`）。',
            ].join('\n'),
          );
        }
        const items = views.map((view) => {
          // キャストを挟まない: 挟むと「値を持つ型として扱ってよい」が既成事実になるため
          const state = tokenAvailabilityAt(view, now);
          const title = `${state}${active?.tokenId === view.id ? ' ← 現役' : ''}`;
          return renderListingEntry({
            id: view.id,
            title,
            summary: `${view.label}（order ${String(view.order)}）`,
            // `now` で埋めない: 作成・更新が無い行が実在し、「いま作られた」という嘘になるため
            createdAt: view.createdAt ?? '（記録が無い）',
            updatedAt: view.updatedAt ?? '（記録が無い）',
            extra: [
              view.sha256 === undefined ? null : `  指紋 ${view.sha256}`,
              view.cooldownUntil === undefined
                ? null
                : // 出所を添える: 時刻だけだと枠のリセット時刻なのか5時間足しただけなのかが一覧から言えない。無い回は「記録が無い」と書く: 黙ると「権威ある値」と読まれるため
                  `  冷却明け ${new Date(view.cooldownUntil).toISOString()}` +
                  `（出所: ${TOKEN_COOLDOWN_SOURCE_LABEL[view.cooldownSource ?? 'unrecorded'] ?? '記録が無い'}）`,
              view.disabledAt === undefined ? null : `  人間が外した ${view.disabledAt}`,
              view.lastRejectedReason === undefined
                ? null
                : // 文言は言い換えずそのまま出す: 回復の見込みは分類であって実測ではないので、そう断って添える
                  `  止まった理由（原文）: ${excerptLine(view.lastRejectedReason, TOKEN_REASON_EXCERPT)}` +
                  (view.recovery === undefined ? '' : ` / 回復の見込み（分類）: ${view.recovery}`),
              view.invalidatedReason === undefined
                ? null
                : `  失効（原文）: ${excerptLine(view.invalidatedReason, TOKEN_REASON_EXCERPT)}`,
            ],
          });
        });
        return text(
          [
            ...head,
            '',
            renderListing(items, {
              budget: TOKEN_LIST_BUDGET,
              omitted: ({ rest, shown }) => {
                const lastShown = tokens[shown - 1]!;
                return (
                  `…ほか ${rest} 件は省略（プールは ${allTokens.length} 件あり、order の昇順に ${shown} 件だけ出した）。` +
                  // 「**残りを見る手はこの道具に無い**」と名乗らない: 案内先がどちらも人間の口で、クローンからは叩けなかったため
                  `続きは token_list cursor=${encodeTokenCursor({ id: lastShown.id, order: lastShown.order })} で取れる。`
                );
              },
            }),
            // 欄の意味を出力に書く: 「作成と更新が同じ」は値を作ったのではなく一度も変わっていないという観測のため
            '（作成 = 行を足した時刻 / 更新 = 最後に変わった時刻。同じなら一度も変わっていない。' +
              'どちらも「記録が無い」ことがある——この2列より前に置かれた行である）',
            '（止まった理由は抜粋。全文は journal_read types=token_rotation の noticeText に在る）',
          ].join('\n'),
        );
      },
    ),

    // 書き込みは渡さない: 取り消しも読めない行を消す口も人間の手に限る
    tool(
      'permission_grant_list',
      [
        '人間が承認した Bash 許可の記録の一覧（読むだけ）。',
        '取り消し済みの行も出る（状態の札で分かる）。生きている許可だけが Bash 呼び出しを自動で通す。',
        '**この道具に書き込みは無い。** 取り消しも、読めない行を消すことも人間の手に属する。',
        '一覧の本文（規則・回答・allows / denies）は抜粋で、全文が要る1件は id を渡して取る。',
        '切れたときは from で続きを取る。',
      ].join(' '),
      {
        id: z
          .string()
          .optional()
          .describe('この1件を全文で読む（一覧に出ている id）。他の条件は無視される'),
        from: z
          .number()
          .optional()
          .describe(
            `一覧で、grantedAt 昇順の何件目から出すか（${formatIntRangeJa({ min: 0 })}、0 起点）`,
          ),
        offset: z
          .number()
          .optional()
          .describe(`id で全文を読むとき、何文字目から読むか（${formatIntRangeJa({ min: 0 })}）`),
      },
      async ({ id, from = 0, offset = 0 }) => {
        const fromError = describeIntRangeViolation('from', from, { min: 0 });
        if (fromError !== null) return text(fromError);
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        return text(await renderPermissionGrantList(stores, { id, from, offset }));
      },
    ),

    // 付与・取り消し・読めない行を消す口は渡さない
    // email と表示名は載せない: 人間が決めたら変わりうるため
    tool(
      'account_list',
      [
        'alteroid にログインしたアカウントと、使う許可の状態の一覧（読むだけ）。',
        '出るのは id・許可の状態（許可済み / 未許可、許可した時刻と者、持ち主の宣言）・時刻だけ。',
        '**個人の情報（email・表示名）は出さない**（identity・アクセストークンも出ない）。人間が決めたら変わりうる。',
        '**この道具に書き込みは無い。** 許可の付与も取り消しも、読めない行を消すことも人間の手に属する。',
        '1件だけ読むときは id を渡す。切れたときは from で続きを取る。',
      ].join(' '),
      {
        id: z
          .string()
          .optional()
          .describe('この1件だけを読む（一覧に出ている id）。他の条件は無視される'),
        from: z
          .number()
          .optional()
          .describe(
            `一覧で、createdAt 昇順の何件目から出すか（${formatIntRangeJa({ min: 0 })}、0 起点）`,
          ),
        offset: z
          .number()
          .optional()
          .describe(`id で読むとき、何文字目から読むか（${formatIntRangeJa({ min: 0 })}）`),
      },
      async ({ id, from = 0, offset = 0 }) => {
        const fromError = describeIntRangeViolation('from', from, { min: 0 });
        if (fromError !== null) return text(fromError);
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        return text(await renderAccountList(stores, { id, from, offset }));
      },
    ),

    tool(
      'profile_write',
      [
        '実行環境プロファイルの**1行**（名前付き）を全文置換する（無ければ作る）。',
        'プロファイルは名前付きの行の集まりで、行ごとに本文（シェルスクリプト。何行でもよい）と撒く先を持つ。',
        '行は名前のコード単位順（辞書順）につなげられる（/etc/profile.d と同じ）。',
        '人間から「このトークンを使って」「PATH にこれを足して」のように**実行環境そのもの**を',
        '渡されたら、会話の中に置いたままにせずここへ移すこと — 会話は要約に潰れ、器は作り直される。',
        '記憶（判断の根拠）とは別の器である。鍵や PATH を記憶に書かないこと。',
        '置く前に実際に読めるかを確かめるので、読めなければ保存も配布もされず理由が返る',
        '（scope=runner の行だけは、あなたの側では評価できないので runner が評価し、読めなければ配布結果に出る）。',
        '**行の全文置換なので、足すだけのつもりなら先に profile_read name=<名前> で今の本文を取ること。**',
        '撒く先は scope で選ぶ（all=あなたと runner の両方 / app=あなた（デーモン）だけ / runner=マネージャー・作業者だけ。',
        '省略すると既存の行の撒く先を保つ。新しい行なら all）。',
        'runner だけに要る環境（runner に入れた道具の PATH など）を all で置くと、あなた自身にも届いてしまう。',
        '行を外すのは profile_remove。',
      ].join(' '),
      {
        name: z
          .string()
          .optional()
          .describe(
            `行の名前（${PROFILE_ENTRY_NAME.source}。英数字で始まり、英数字と . _ - が使える。64字まで。省略すると default）`,
          ),
        scope: z
          .enum(['all', 'app', 'runner'])
          .optional()
          .describe(
            '撒く先。all=クローン（あなた）と runner の両方 / app=クローンだけ / runner=runner（マネージャー・作業者）だけ。' +
              '省略は「既存の行の撒く先を保つ」（新しい行なら all）',
          ),
        script: z
          .string()
          .describe(
            'この行のシェルスクリプト全文（`export FOO=bar` / `export PATH="$HOME/bin:$PATH"` / `eval "$(tool env)"` など。何行でもよい）。' +
              '空にはできない（外すなら profile_remove）',
          ),
        summary: z
          .string()
          .describe('何を変えたかの一行要約（日誌に残る。**値そのものは書かない**）'),
      },
      async ({ name = 'default', script, summary, scope }) => {
        if (context.profile === undefined) {
          return text(
            'いまは実行環境プロファイルを差し替えられない場面である（記憶へ移すための内部ターン）。' +
              '次の会話で置くこと。',
          );
        }
        // 日誌を書く前に形を検査する: 置けない入力で「差し替えようとしている」を残さないため
        if (!PROFILE_ENTRY_NAME.test(name)) {
          return text(`行の名前の形が不正（${PROFILE_ENTRY_NAME.source}）。何も変えていない。`);
        }
        if (script.trim().length === 0) {
          return text(
            '本文が空では行を置けない。外すなら profile_remove を使う。何も変えていない。',
          );
        }

        // 日誌を先に書く: 書けなければ差し替えずに道具のエラーで返すため
        await appendJournalOrThrow(
          'profile_write',
          stores.journal,
          {
            type: 'decision',
            decision: `実行環境プロファイルを差し替えようとしている${profileRowLabel(name)}: ${summary}`,
            grounds: '人間から実行環境そのものを渡された（値は記録しない）',
          },
          'act-not-performed',
        );

        // 人間の口と同じ1本道を通る: 評価・保存・配布が1つの区間として直列に行われ、人間の更新と重なっても層ごとに違う本文が残らないため
        let result: Awaited<ReturnType<ProfileService['set']>>;
        try {
          result = await context.profile.set(name, script, scope);
        } catch (error) {
          return await profileToolFailed('profile_write', name, summary, error);
        }
        return await profileToolReport('profile_write', name, summary, result, {
          decision: `実行環境プロファイルを更新した${profileRowLabel(name)}`,
          text: `行 ${name} を置いた`,
        });
      },
    ),

    tool(
      'profile_remove',
      [
        '実行環境プロファイルの1行を外す。他の行は変えない（全部外すときは行を1つずつ外す）。',
        '外した行がクローンと runner のどちらかの最後の1行だったなら、その側からは環境が外れる（空が降りる）。',
        '無い名前を渡しても何も変わらない。行の名前は profile_read（name を省略）で取れる。',
      ].join(' '),
      {
        name: z.string().describe('外す行の名前'),
        summary: z
          .string()
          .describe('何を外したかの一行要約（日誌に残る。**値そのものは書かない**）'),
      },
      async ({ name, summary }) => {
        if (context.profile === undefined) {
          return text(
            'いまは実行環境プロファイルを差し替えられない場面である（記憶へ移すための内部ターン）。' +
              '次の会話で外すこと。',
          );
        }
        if (!PROFILE_ENTRY_NAME.test(name)) {
          return text(`行の名前の形が不正（${PROFILE_ENTRY_NAME.source}）。何も変えていない。`);
        }
        await appendJournalOrThrow(
          'profile_remove',
          stores.journal,
          {
            type: 'decision',
            decision: `実行環境プロファイルの行 ${name} を外そうとしている: ${summary}`,
            grounds: '人間から実行環境そのものを渡された（値は記録しない）',
          },
          'act-not-performed',
        );
        let result: Awaited<ReturnType<ProfileService['remove']>>;
        try {
          result = await context.profile.remove(name);
        } catch (error) {
          return await profileToolFailed('profile_remove', name, summary, error);
        }
        if (!result.removed) {
          await appendJournalOrDrop('profile_remove', stores.journal, {
            type: 'decision',
            decision: `実行環境プロファイルの行 ${name} は無かったので何も変えなかった: ${summary}`,
            grounds: '外そうとしたが、その名前の行は置かれていなかった',
          });
          return text(`プロファイルに行 ${name} は無い。何も変えていない。`);
        }
        return await profileToolReport('profile_remove', name, summary, result, {
          decision: `実行環境プロファイルの行 ${name} を外した`,
          text: `行 ${name} を外した`,
        });
      },
    ),

    // `practice_apply` / `practice_enforce` を足さない: 従わせた時点でクローンは「制限された自動化ジョブ」に戻り、やり方は読む素材で実行される定義ではないため
    tool(
      'practice_list',
      [
        '仕事のやり方の一覧を返す（本文は返さない。slug・種類・題・文字数・作成/更新時刻だけ）。',
        'やり方はあなたが読んで従うかどうかを毎回自分で決める素材であって、実行される定義ではない',
        '（従わせる道具はここには無い）。',
        '**読めない行が無いのにやり方が1件も無いのは正常な状態である。** やり方が書かれていない仕事も普通に進む——',
        '空を「まだ設定されていない」という異常として読まないこと。',
        '読めない行が在るときは、応答の末尾にその件数と slug が出る（壊れた行であって、消されたやり方ではない）。',
        '中身が要るなら practice_read slug=<slug> で開くこと。',
      ].join(' '),
      {},
      async () => {
        const { entries, unreadable } = await stores.practices.list();
        // 読めない行は予算の外に別に言う: 一覧が溢れても「壊れた行が在る」は必ず届けるため
        const unreadableNote = describeUnreadablePractices(unreadable);
        // 空は正常と言う: 異常や未設定であるかのような文言を出さない。ただし「無い」と言えるのは読めない行が0件のときだけ
        if (entries.length === 0) {
          if (unreadableNote !== null) {
            return text(
              `（読めたやり方は無い）${unreadableNote}` +
                '**やり方が無いとも、正常だとも言えない。**' +
                'slug が分かる行は、practice_write で同じ slug を書き直すか practice_remove で外せる。',
            );
          }
          return text(
            'やり方はまだ1件も無い。**これは正常な状態である**——やり方が書かれていない' +
              '仕事も普通に進む。書くなら practice_write slug=<slug> kind=<種類> title=<題> content=<本文>。',
          );
        }
        const items = entries.map((entry) =>
          renderListingEntry({
            id: entry.slug,
            title: `[${entry.kind}] ${entry.title}`,
            summary: `${String(entry.chars)} 文字`,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          }),
        );
        const listing = renderListing(items, {
          budget: PRACTICE_LIST_BUDGET,
          omitted: ({ rest, shown, total }) =>
            // 続きを取る口が無いので、無いと正直に言う: 口が無いまま断り書きだけ出すと、落ちた分へ呼び手が到達できないため
            `…ほか ${String(rest)} 件は省略（全 ${String(total)} 件のうち slug の昇順に ${String(shown)} 件だけ出した）。` +
            'この一覧に続きを取る口はまだ無い——個別に読むには practice_read slug=<slug> を使うこと。',
        });
        return text(unreadableNote === null ? listing : `${listing}\n\n${unreadableNote}`);
      },
    ),

    tool(
      'practice_read',
      [
        '仕事のやり方を1件、本文まで読む。無ければ、その旨を返す（例外で落とさない）。',
        'version を指定すると、いまの本文ではなく過去の版（practice_history に出ている version）を',
        '読む——version を省く既定は、いまのやり方（全文置換の最新の姿）を読む。',
      ].join(' '),
      {
        slug: z.string().describe('やり方のスラッグ（practice_list に出ている slug）'),
        version: z
          .number()
          .optional()
          .describe(
            `省略時はいまの本文。指定すると practice_history にある過去の版を読む（${formatIntRangeJa({ min: 1 })}）`,
          ),
      },
      async ({ slug, version }) => {
        // 不正なスラッグはここで断る: 無いと pg は生の例外を投げ、fs / インメモリは「無い」として扱い、器によって結果が違ってしまうため
        if (!practiceSlugSchema.safeParse(slug).success) {
          return text(`やり方のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const versionError = describeIntRangeViolation('version', version, { min: 1 });
        if (versionError !== null) return text(versionError);
        if (version !== undefined) {
          // 読めない行は理由の分かる文に変える: `isError` と生の Zod issue より読み手に親切なため
          let found: Awaited<ReturnType<typeof stores.practices.readVersion>>;
          try {
            found = await stores.practices.readVersion(slug, version);
          } catch (error) {
            if (!(error instanceof UnreadablePracticeError)) throw error;
            return text(
              `やり方 ${slug} の版 ${String(version)} は読めない形で入っている` +
                '（消されたのではない）。本文はここでは取れない。',
            );
          }
          if (found === null) {
            return text(
              `やり方 ${slug} の版 ${String(version)} は無い。` +
                'practice_history slug=<slug> で在る版を確かめること。',
            );
          }
          return text(
            [
              `${found.slug} 版${String(found.version)}（${found.kind}） ${found.title}`,
              `この版が書かれた時刻: ${found.at} / ${String(found.chars)} 文字`,
              '',
              found.content,
            ].join('\n'),
          );
        }
        let found: Awaited<ReturnType<typeof stores.practices.read>>;
        try {
          found = await stores.practices.read(slug);
        } catch (error) {
          if (!(error instanceof UnreadablePracticeError)) throw error;
          return text(
            `やり方 ${slug} は読めない形で入っている（消されたのではない）。` +
              '本文はここでは取れない。書き直すなら practice_write、外すなら practice_remove。',
          );
        }
        if (found === null) {
          return text(
            `やり方 ${slug} は無い。practice_list で在るものを確かめるか、` +
              'practice_write で新しく書けること。',
          );
        }
        return text(
          [
            `${found.slug}（${found.kind}） ${found.title}`,
            `作成: ${found.createdAt} / 更新: ${found.updatedAt} / ${String(found.chars)} 文字`,
            '',
            found.content,
            '',
            practiceVersionLine(found),
          ].join('\n'),
        );
      },
    ),

    tool(
      'practice_history',
      [
        'やり方1件の、追記専用の版の履歴を返す（本文は返さない。版番号・種類・題・',
        '文字数・書かれた時刻だけ——#1309）。',
        '**write のたびに版が1つ増える。remove しても版は消えない**——消した slug を',
        '同じ名前で作り直しても、版番号は消える前の続きから振られる。',
        '中身が要るなら practice_read slug=<slug> version=<版番号> で開くこと。',
      ].join(' '),
      {
        slug: z.string().describe('やり方のスラッグ（practice_list に出ている slug）'),
      },
      async ({ slug }) => {
        if (!practiceSlugSchema.safeParse(slug).success) {
          return text(`やり方のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const versions = await stores.practices.listVersions(slug);
        if (versions.length === 0) {
          return text(
            `やり方 ${slug} の版は無い。practice_write で一度も書かれていない` +
              '（または slug を打ち間違えている）可能性がある。',
          );
        }
        const items = versions.map((entry) =>
          renderListingEntry({
            id: `版${String(entry.version)}`,
            title: `[${entry.kind}] ${entry.title}`,
            summary: `${String(entry.chars)} 文字`,
            createdAt: entry.at,
            updatedAt: entry.at,
          }),
        );
        return text(
          renderListing(items, {
            budget: PRACTICE_LIST_BUDGET,
            omitted: ({ rest, shown, total }) =>
              `…ほか ${String(rest)} 件は省略（全 ${String(total)} 件のうち版番号の昇順に ` +
              `${String(shown)} 件だけ出した）。個別に読むには practice_read slug=${slug} ` +
              'version=<版番号> を使うこと。',
          }),
        );
      },
    ),

    tool(
      'practice_write',
      [
        '仕事のやり方を書く（全文置換。無ければ作る）。',
        'kind は仕事の種類（実装・調査・相談・レビュー・日報・外部サービスの確認…）を自由文字列で書く',
        '（**列挙ではない**。知らない種類のやり方を弾かない。表記ゆれは束ねる側の負担として引き受ける）。',
        'これは実行される定義ではない——読んで従うかどうかは、そのときのあなたが決める' +
          '（従わせる道具はここには無い）。人間もこの3入口のどこからでも同じものを読み書きできる。',
        '本文の末尾改行は正規化される（無ければ足す。既に在れば増やさない）。',
        '**既存のやり方を書き換えるときは、先に practice_read で読んで、応答に出る base_version を渡すこと。焼き込みの索引だけでは書けない**（読んだ後に人間や別のターンが書いていたら、何も書かずに「その間に変わった」と返す。読み直して判断し直すこと）。**新規作成は版なしで通る。**',
      ].join(' '),
      {
        slug: z.string().describe('やり方のスラッグ（英小文字・数字・. _ - のみ）'),
        kind: z.string().describe('仕事の種類（自由文字列。例: 実装・調査・相談・レビュー・日報）'),
        title: z.string().describe('一覧で見る短い題'),
        content: z.string().describe('本文（人間もこのまま読む。Markdown を想定）'),
        base_version: z
          .string()
          .optional()
          .describe(
            '読んだ時点の版（practice_read / 直前の practice_write の応答に出る base_version）。' +
              '**既存のやり方を書き換えるときは必須。** 読んだ後に人間や別のターンが書いていたら、書かずに「その間に変わった」と返す。' +
              '新規作成（その slug がまだ無い）では省略してよい（版なしで通る）。焼き込みの索引だけでは版は分からない——先に practice_read を呼ぶこと。',
          ),
      },
      async ({ slug, kind, title, content, base_version: baseVersion }) => {
        if (!practiceSlugSchema.safeParse(slug).success) {
          return text(`やり方のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        // `kind` も書く前に見る: 見ないと保存層の `parse` が生の ZodError を投げ、そのままクローンへ返るため
        const kindError = describePracticeKindViolation(kind);
        if (kindError !== null) return text(kindError);
        // `UnreadablePracticeError` だけを捕まえて「在ったが読めない」として先へ進む: 投げっぱなしだと `write()` まで届かず、壊れた行を書き直す唯一の回復手段が塞がるため
        let before: Practice | null;
        let beforeWasUnreadable = false;
        try {
          before = await stores.practices.read(slug);
        } catch (error) {
          if (!(error instanceof UnreadablePracticeError)) throw error;
          before = null;
          beforeWasUnreadable = true;
        }
        // 読めない形で入っていた行だけ版の前提なしで通す: 版が無く、書き直しの回復手段を塞がないため
        if (before !== null && baseVersion === undefined) {
          return text(
            `やり方 ${slug} は既に在る。全文を書き直すには、先に practice_read slug=${slug} で読み、` +
              '応答に出る base_version をこの呼び出しの base_version に渡すこと' +
              '（読んだ後に人間や別のターンが書いた内容を、気づかずに消さないため。焼き込みの索引だけでは書けない）。**何も書いていない。**',
          );
        }
        let written;
        try {
          written = await stores.practices.write(
            { slug, kind, title, content },
            beforeWasUnreadable
              ? undefined
              : { ifMatch: before === null ? (baseVersion ?? null) : baseVersion! },
          );
        } catch (error) {
          if (error instanceof PracticeConflictError) {
            return text(describePracticeConflict(slug, '書き直し', error.current));
          }
          throw error;
        }
        await appendJournalOrThrow(
          'practice_write',
          stores.journal,
          {
            type: 'decision',
            decision: beforeWasUnreadable
              ? `読めない形で入っていたやり方 ${slug}（${kind}）を書き直した: ${title}`
              : `やり方 ${slug}（${kind}）を${before === null ? '作った' : '書き直した'}: ${title}`,
            grounds: beforeWasUnreadable
              ? '読めない形で入っていたやり方を書き直した（全文置換。前の本文は読めなかった' +
                'ため分からない。版の履歴には今回の内容だけが新しい版として積まれる——#1309）'
              : before === null
                ? '新しいやり方を器に置いた'
                : 'やり方を書き直した（全文置換。いまの本文の読み口は最新の1本だが、' +
                  '前の本文は版の履歴（practice_history）に残る——#1309）',
            target: { kind: 'practice', slug },
          },
          'act-completed',
        );
        return text(
          `やり方 ${slug} を${
            beforeWasUnreadable
              ? '（読めない形で入っていたやり方を）書き直した'
              : before === null
                ? '新しく作った'
                : '書き直した'
          }` +
            `（${String(written.chars)} 文字。前の版は practice_history slug=${slug} で読める）。` +
            'practice_list で一覧に出る。' +
            ((note) => (note === null ? '' : `\n${note}`))(
              describeTokenDiff(before === null ? null : before.content, content),
            ) +
            `\n\n${practiceVersionLine(written)}`,
        );
      },
    ),

    tool(
      'practice_remove',
      [
        '仕事のやり方を1件消す。',
        '**無い slug を指定しても失敗しない（冪等）**——その場合は何もしていないとだけ返す。',
        '**既存のやり方を消すときは、先に practice_read で読んで、応答に出る base_version を渡すこと（必須）。焼き込みの索引だけでは消せない**——読んだ後に人間や別のターンが書いていたら、何も消さずに「その間に変わった」と返す（読んでいない内容まで消さないため）。',
      ].join(' '),
      {
        slug: z.string().describe('やり方のスラッグ（practice_list に出ている slug）'),
        base_version: z
          .string()
          .optional()
          .describe(
            '読んだ時点の版（practice_read / 直前の practice_write の応答に出る base_version）。**必須**——無ければ何も消さずに読み直しを促す。焼き込みの索引だけでは版は分からない。',
          ),
      },
      async ({ slug, base_version: baseVersion }) => {
        if (!practiceSlugSchema.safeParse(slug).success) {
          return text(`やり方のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        // `UnreadablePracticeError` だけを捕まえて「在ったが読めない」として先へ進む: 投げっぱなしだと `remove()` まで届かず、壊れた行を消す唯一の回復手段が塞がるため
        let before: Practice | null;
        let wasUnreadable = false;
        try {
          before = await stores.practices.read(slug);
        } catch (error) {
          if (!(error instanceof UnreadablePracticeError)) throw error;
          before = null;
          wasUnreadable = true;
        }
        // 無かったときは日誌を書かない: 何も起きていないのに「消した」という判断の跡を残すと日誌が実際の変化と食い違うため。「読めなかった」は「無かった」ではない
        if (before === null && !wasUnreadable) {
          return text(`やり方 ${slug} はもともと無かった（何もしていない）。`);
        }
        // 読めない形の行には版が無いので前提なしで消せる: 回復手段を塞がないため
        if (before !== null) {
          if (baseVersion === undefined) {
            return text(
              `やり方 ${slug} を消すには、先に practice_read slug=${slug} で読み、` +
                '応答に出る base_version をこの呼び出しの base_version に渡すこと' +
                '（読んだ後に人間や別のターンが書いた内容を、気づかずに消さないため。焼き込みの索引だけでは消せない）。**何も消していない。**',
            );
          }
        }
        try {
          await stores.practices.remove(
            slug,
            before === null ? undefined : { ifMatch: baseVersion },
          );
        } catch (error) {
          if (error instanceof PracticeConflictError) {
            return text(describePracticeConflict(slug, '削除', error.current, 'remove'));
          }
          throw error;
        }
        if (before !== null) {
          await appendJournalOrThrow(
            'practice_remove',
            stores.journal,
            {
              type: 'decision',
              decision: `やり方 ${slug}（${before.kind}）を消した: ${before.title}`,
              grounds: '不要になったと判断した',
              target: { kind: 'practice', slug },
            },
            'act-completed',
          );
          return text(`やり方 ${slug} を消した。`);
        }
        await appendJournalOrThrow(
          'practice_remove',
          stores.journal,
          {
            type: 'decision',
            decision: `読めない形で入っていたやり方 ${slug} を消した`,
            grounds: '読めない形で入っていたやり方を外した',
            target: { kind: 'practice', slug },
          },
          'act-completed',
        );
        return text(`読めない形で入っていたやり方 ${slug} を消した。`);
      },
    ),

    tool(
      'self_read',
      [
        '自分自身（alteroid）の正典を1つ読む。',
        '自分が何で出来ているか・何が要件か・どう設計されているか・何が未着手かはここにある。',
        'ビルド時に焼き込んだ写しなので、実装の最新が要るならマネージャーにリポジトリを読ませること。',
        '長いので切れて出る（続きの取り方が出力に付く）。',
      ].join(' '),
      {
        document: z
          .string()
          .describe(`正典の名前。読めるのは ${canonNames().join(' / ')}（上ほど優先順位が高い）`),
        offset: z
          .number()
          .optional()
          .describe(`何文字目から読むか（${formatIntRangeJa({ min: 0 })}。既定 0）`),
      },
      async ({ document, offset = 0 }) => {
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        const doc = canonDocument(document);
        if (doc === undefined) {
          return text(`正典 ${document} は無い。読めるのは ${canonNames().join(' / ')}。`);
        }
        const part = page(doc.content, offset, CANON_PAGE);
        const tail = part.more
          ? `\n\n…（ここで切れている。続きは self_read document=${doc.name} offset=${part.to}）`
          : '';
        return text(
          `${doc.path}（${CANON_REVISION.length > 0 ? `リビジョン ${CANON_REVISION}` : 'リビジョン不明'} の写し / ${describePage(part)}）\n\n${part.body}${tail}`,
        );
      },
    ),

    tool(
      'self_status',
      [
        // 項目を数え直さず `CLONE_RUNTIME_ITEM_LABELS` から導出する: 散文に書くと実出力とずれて腐るが、クローンは道具の説明しか読まないので列挙は残す
        `いま自分が何で走っているかを返す（${CLONE_RUNTIME_ITEM_LABELS.join('・')}）。`,
        'これに加えて、いまの記憶の大きさと、台帳との突き合わせも出る。',
        '**effort はこのセッションで最初の道具呼び出しでは取れない**（前の道具呼び出しの結果として',
        '観測するため）。モデルが effort に対応していない場合もずっと取れない。',
        '取れない値は「まだ分からない」と出る（既定値では埋めない）。',
        // 素の位置ではなく keyset の `ledgerCursor` にする: 台帳は増え続け、途中で内訳の順位が入れ替わると欠落・重複を生むため
        '台帳との突き合わせの内訳は14件で打ち切る。続きは ledgerCursor で辿れる' +
          '（打ち切りの行にそのまま書いてある。ledgerCursor を渡すとその節だけを出す。' +
          '前回の呼び出し以降に記録が増えていたら、順位が上がった行が別枠で出ることがある）。',
      ].join(' '),
      {
        ledgerCursor: z
          .string()
          .optional()
          .describe(
            '台帳との突き合わせの内訳の続きを読む位置。前回の応答の断り書きに出た ledgerCursor を' +
              'そのまま渡す（自分で組み立てない。実行時の事実・記憶の大きさは出ない）',
          ),
      },
      async ({ ledgerCursor }) => {
        const runtime = context.runtime?.();
        if (runtime === undefined) {
          return text(
            'いまは自分の実行時の事実を読めない場面である（記憶へ移すための内部ターン）。' +
              '次の会話で呼ぶこと。',
          );
        }

        // 続きを取りに来た呼び出しは、その節だけを返す: 続きを辿るたびに同じ全体が返ると、辿るほど入力を食うため
        if (ledgerCursor !== undefined) {
          const aggregate = runtime.sdkModel === null ? null : await stores.usage.aggregate({});
          return text(renderLedgerCrossReference(runtime.sdkModel, aggregate, ledgerCursor));
        }

        const runnerModels = await context.runnerModels?.();
        const runnerAnthropicRoutes = await context.runnerAnthropicRoutes?.();
        const [documents, memoryDocuments, aggregate, codexAuth] = await Promise.all([
          stores.persona.list(),
          stores.persona.documents(),
          runtime.sdkModel === null ? Promise.resolve(null) : stores.usage.aggregate({}),
          // 読めなければ黙らずに言う
          stores.codexAuth.get().then(
            (record) =>
              record === null ? null : describeCodexChatgptAuth(codexChatgptAuthStatusOf(record)),
            (error: unknown) =>
              `Codex の ChatGPT ログイン: 正本を読めなかった（${reasonOf(error)}）`,
          ),
        ]);

        return text(
          [
            describeCloneRuntime({
              ...runtime,
              ...(runnerModels === undefined ? {} : { runnerModels }),
              ...(runnerAnthropicRoutes === undefined ? {} : { runnerAnthropicRoutes }),
            }),
            ...(codexAuth === null ? [] : [codexAuth]),
            '',
            // クローンの文脈へ実際に載る形で数える: 本文だけを足すと、見出しのぶんだけ本当より少ない数を名乗るため
            renderMemorySize(documents, memoryDocuments, renderMemoryDocuments(memoryDocuments)),
            '',
            renderLedgerCrossReference(runtime.sdkModel, aggregate),
            ...(await renderPeerReach(context.managers)),
          ].join('\n'),
        );
      },
    ),

    // `journal_read` と二重に持たない: 日誌は起きたことを持ち、ここは日誌そのものへは書けなかった側を持つ
    // `cursor` ではなく `offset` にする: 帳面はプロセス内の配列で、直近から何件スキップするかの整数で足りるため
    tool(
      'self_dropped',
      [
        '自分（クローン）が記録・読み出しをしそこねた跡（`noteDroppedRecord` 等が',
        'stderr へ残す行）を、このプロセスの中から読み戻す。',
        '器の外（Railway 等のホスティング先のログ）へ出ている生の stderr の代わりではない',
        '——そちらは既に人間が読める（#242）。ここは、器の中からは1行も遡れなかった',
        '穴を塞ぐためのものである。',
        'このプロセスが生きているあいだの直近の分だけを持つ（帳面の保持件数は',
        `${RECENT_TRACE_LIMIT} 件。それより古い分はこのプロセスの中には無く、器の外の`,
        'stderr を見るしかない）。再起動・デプロイの入れ替えでも消える。',
        '予算で切れた古い側は offset で読み進められる（limit を上げても境界は動かない）。',
      ].join(' '),
      {
        limit: z
          .number()
          .optional()
          .describe(
            `一度に対象にする件数（${formatIntRangeJa({ min: 1, max: RECENT_TRACE_LIMIT })}。既定 ${SELF_DROPPED_DEFAULT_LIMIT}、最大 ${RECENT_TRACE_LIMIT}` +
              '＝帳面が保持している件数そのもの）。⚠️ 予算（文字数）が先に尽きることが' +
              'あり、そのときはこれを上げても実際に載る内容は動かない——古い側へ進むには' +
              '`offset` を使うこと。',
          ),
        offset: z
          .number()
          .optional()
          .describe(
            `直近から数えて何件をスキップしてから見るか（${formatIntRangeJa({ min: 0, max: RECENT_TRACE_LIMIT })}。既定 0＝最新から）。` +
              '#662。前回の応答の断り書きに出た offset をそのまま渡せば、' +
              '予算や limit で切れて省略された古い側へ実際に進める。',
          ),
      },
      async ({ limit = SELF_DROPPED_DEFAULT_LIMIT, offset = 0 }) => {
        const limitError = describeIntRangeViolation('limit', limit, {
          min: 1,
          max: RECENT_TRACE_LIMIT,
        });
        if (limitError !== null) return text(limitError);
        const offsetError = describeIntRangeViolation('offset', offset, {
          min: 0,
          max: RECENT_TRACE_LIMIT,
        });
        if (offsetError !== null) return text(offsetError);
        const origin = describeDroppedTraceOrigin('daemon');
        const since = `この帳面が数え始めたのは ${droppedTraceLedgerSince()}。`;
        const all = recentDroppedTraces();
        if (all.length === 0) {
          return text([describeDroppedTraceEmpty(), origin, since].join(' '));
        }
        // `limit` と予算の両方をこの1本の窓に通す: どちらで切れても、次に渡す offset を同じ式（`skip + shown`）で組めるようにするため
        const skip = Math.min(offset, all.length);
        const windowed = skip === 0 ? all : all.slice(0, all.length - skip);
        if (windowed.length === 0) {
          return text(
            `offset（${String(offset)}）が帳面の件数（${String(all.length)}）以上なので、` +
              `これより古い分は無い。offset を ${String(all.length - 1)} 以下にして呼び直すこと。 ` +
              `${origin} ${since}`,
          );
        }
        const traces = windowed.slice(-limit);
        const fill = fillListingBudget(traces, SELF_DROPPED_BUDGET, true);
        // 残りは `limit` で除外された分と予算で除外された分を1つに数える: 呼び手にどちらが原因かを区別させないため
        const remaining = windowed.length - fill.shown;
        const nextOffset = skip + fill.shown;
        const lines = [...fill.lines];
        if (remaining > 0) {
          lines.unshift(
            `…ほか古い ${String(remaining)} 件は省略（帳面には全 ${String(all.length)} 件あり、` +
              `直近から ${String(fill.shown)} 件だけ出した）。続きは ` +
              `self_dropped offset=${String(nextOffset)} で取れる（limit を上げても動かない）。`,
          );
        }
        return text(
          [
            lines.join('\n'),
            origin,
            `（${describeDroppedTraceRetention(RECENT_TRACE_LIMIT)} ${since}）`,
          ].join('\n'),
        );
      },
    ),

    tool(
      'manager_start',
      [
        'マネージャー（あなたが起こす Claude Code）に仕事を任せる。',
        '起動して即返るので、完了を待たずに次の判断へ移ってよい。同時に何本走らせてもよい。',
        '依頼できるのは実装だけではない。調査・設計の相談・外部サービスの確認・レビューも同じように頼める。',
        'Codex に作業を頼めるマネージャーの器があれば（runner_list の peer の行）、依頼文に「Codex にやらせて」と' +
          '書けば、マネージャーが peer で Codex に頼む。その器を runnerId で名指しできる。',
        '置き先は資源で自動配置される（runner_list の説明を参照）。新しいプロセスを起こせない' +
          '（pids 飽和）と判定された器は、飽和していない器が居れば自動配置から外れる。' +
          '全台が飽和でも、runnerId で名指ししても断らず起こす——置き先が飽和と判定されていれば' +
          '応答に「⚠ 置き先の runner は pids 飽和と判定されている: 材料」の行が付くので、' +
          '落ちる前提で読むこと。',
      ].join(' '),
      {
        request: z
          .string()
          .describe('依頼内容。人間が Claude Code に書くのと同じ粒度で、背景と狙いを添えて書く'),
        cwd: z.string().optional().describe('作業ディレクトリ。省略時はデーモンの既定'),
        attachments: z
          .array(z.string().min(1))
          .optional()
          .describe(MANAGER_ATTACHMENTS_DESCRIPTION),
        runnerId: z
          .string()
          .optional()
          .describe(
            '置き先の器を名指しで指名する（runner_list / manager_list が出す runnerId）。' +
              'これは配置の指名であって本数の制限ではない——省略すれば資源による自動配置。' +
              '指名した器が名簿に無い・使えない・名前が重複のときは失敗し、他の器へは' +
              '自動で落とさない（返ってきた文言をそのまま読むこと）。',
          ),
      },
      async (rawArgs) => {
        const { request, cwd, runnerId, attachments } = rawArgs as unknown as {
          request: string;
          cwd?: string | undefined;
          attachments?: string[] | undefined;
          runnerId?: string | undefined;
        };
        if (!context.managers) return NO_POOL;
        // conversationId はクローンに渡させず呼び出し文脈から自動で読む: 手で維持する欄を新しく作らないため
        // 返信の宛先ではなく仕事の会話を読む: 報告を受けた内部ターンで続きを委譲したとき、起点が途切れないため（#4210）
        const conversationId = getWorkConversationId();

        // 添付は日誌にも命令にも触れる前に読む: 見つからなければ何も送らず日誌も書かないため
        const handover = await loadManagerAttachments(
          stores,
          attachments ?? [],
          context.attachmentLimits ?? readAttachmentLimits().limits,
        );
        if (!handover.ok) return text(handover.message);
        const handedRefs = attachmentRefsOf(handover.attachments);
        const handedNote =
          handedRefs.length === 0
            ? ''
            : `（添付 ${handedRefs.length} 件を渡す: ${handedRefs.map((ref) => `${ref.id} ${ref.name}`).join(', ')}）`;

        // 日誌を先に書く: 書けなければ起こさずに道具のエラーで返すため
        await appendJournalOrThrow(
          'manager_start',
          stores.journal,
          {
            type: 'decision',
            decision: `マネージャーを起こそうとしている${
              runnerId === undefined ? '' : `（指名: runnerId=${runnerId}）`
            }${handedNote}: ${request}`,
            grounds: '委譲の判断',
          },
          'act-not-performed',
        );

        let started: ManagerSummary;
        try {
          started = await context.managers.start({
            request,
            ...(cwd === undefined ? {} : { cwd }),
            ...(runnerId === undefined ? {} : { runnerId }),
            ...(conversationId === undefined ? {} : { conversationId }),
            ...(handover.attachments.length === 0 ? {} : { attachments: handover.attachments }),
          });
        } catch (error) {
          await appendJournalOrDrop('manager_start', stores.journal, {
            type: 'decision',
            decision: `マネージャーを起こせなかった${
              runnerId === undefined ? '' : `（指名: runnerId=${runnerId}）`
            }${handedNote}: ${request}`,
            grounds: `委譲しようとしたが、状態の変更が失敗した: ${reasonOf(error)}`,
          });
          if (error instanceof ManagerAttachmentsRefusedError) {
            return text(`${reasonOf(error)}。マネージャーは起こしていない。`);
          }
          throw error;
        }

        await appendJournalOrDrop('manager_start', stores.journal, {
          type: 'decision',
          decision:
            `マネージャー ${started.managerId} を起こした（${describeStartedCwd(started)}` +
            `${runnerId === undefined ? '' : `, 指名: runnerId=${runnerId}`}）${handedNote}: ${request}`,
          grounds: '委譲の判断',
        });
        // pids 飽和の置き先でも断らない: 起こしたうえで、材料つきで知らせる
        const saturation =
          started.runnerId === undefined
            ? undefined
            : context.managers.runnerPidsSaturation?.(started.runnerId);
        return text(
          `マネージャー ${started.managerId} を起こした（${describeStartedCwd(started)}、` +
            `runner: ${started.runnerId ?? '未記録'}）。` +
            '報告・質問は後から受信箱に届く。' +
            (saturation === undefined
              ? ''
              : `\n⚠ 置き先の runner は pids 飽和と判定されている: ${describePidsSaturation(saturation)}。` +
                'この委譲は新しいプロセスを起こせず落ちるかもしれない——' +
                'runner_list で他の器を見て、必要なら止めて別の器へ置き直すこと。'),
        );
      },
    ),

    tool(
      'manager_send',
      [
        '走行中のマネージャーへ追加指示を送る、または止まっている質問・許可確認に答える。',
        'requestId か decision を付けたときだけ回答として扱う（止まっていたその仕事だけが再開する）。',
        'どちらも無い本文は、相手が返事待ちでも回答にはならず追加指示として届く。',
        '許可確認への回答では decision を必ず付けること。',
        // 答える先の無い合図に decision を付けさせない: requestId 無しの decision は待ちが1件ならその1件へ当たり、無関係の確認を許可してしまうため
        '「確認へ上がらずに止められた」合図（分類器・deny 規則の拒否）には requestId が無く、' +
          '許可として答える口は無い。decision を付けずに、別の形を追加指示として送ること' +
          '（requestId 無しの decision は、そのマネージャーが別に待っている確認へ回答として当たりうる）。',
        'manager_list が [running] と出していても、runner の側でセッションが畳まれていることがある' +
          '（その合図が届かなかった窓）。そのときは resume から入り直して届けるので、' +
          '返り値にそう書いてある。入り直せなかったときも「そんな id は無い」ではなく' +
          '「セッションが無い」と返る——委譲そのものは台帳に在るので、manager_start で' +
          '起こし直す前に、返ってきた文言をそのまま読むこと。',
        // 「セッションが無い」を「仕事が失われた」と読ませない: 完遂後に畳まれた回も同じ形に見え、決めつけると完遂済みの仕事を委譲し直すため
        'セッションが無いことは、その仕事が失われたことを意味しない——完遂した後に' +
          'セッションが畳まれ、終端イベントだけが届かなかった回も同じ形になる。' +
          '委譲し直す前に必ず manager_report を見ること（報告が空でも、生ログから' +
          '「生成されたが配られていない」報告を拾える）。',
      ].join(' '),
      {
        managerId: z.string().describe('manager_start が返した id'),
        message: z
          .string()
          .describe('マネージャーへの本文。deny のときは、なぜ駄目でどうしてほしいかを書く'),
        attachments: z
          .array(z.string().min(1))
          .optional()
          .describe(MANAGER_ATTACHMENTS_DESCRIPTION),
        // `deny` を機械的に流さない: 受け取るマネージャーは「人間が拒否した」としか読めず、人間の承認の偽造になるため
        decision: z
          .enum(['allow', 'deny'])
          .optional()
          .describe('許可確認への回答のとき必須。それ以外では不要'),
        // 生ログの id では通らない: 名前空間の違う id は「待っていない」に落ち、「まだ届いていない」と見分けが付かないため
        requestId: z
          .string()
          .optional()
          .describe(
            'どの確認への回答かを示す id（受信箱に届いた requestId）。' +
              '1本のマネージャーが複数を同時に待つことがあるので、回答では必ず添えること。' +
              '⚠️ 生ログの id とは別物である——生ログに出る toolu_…（tool_use_id）も ' +
              'req_…（API の request id）も、ここでは通らない。' +
              '受信箱に届いていない確認に、生ログから答える手段は無い（#572）',
          ),
      },
      async ({ managerId, message, decision, requestId, attachments }) => {
        if (!context.managers) return NO_POOL;
        // 空白だけは断らない: HTTP も通すため
        const messageError = describeStringLengthViolation('message', message, { min: 1 });
        if (messageError !== null) return text(messageError);
        const handover = await loadManagerAttachments(
          stores,
          attachments ?? [],
          context.attachmentLimits ?? readAttachmentLimits().limits,
        );
        if (!handover.ok) return text(handover.message);
        const result = await context.managers.send(managerId, message, {
          ...(decision === undefined ? {} : { decision }),
          ...(requestId === undefined ? {} : { requestId }),
          ...(handover.attachments.length === 0 ? {} : { attachments: handover.attachments }),
        });
        // `session_missing` は必ず言い足す: そのものは居る側なので、`manager_start` で起こし直すと同じ仕事が2本になりうるため
        if (result.outcome === 'session_missing') {
          return text(
            `[${managerId}] ${result.detail}\n` +
              '**この委譲そのものは台帳に在る**（「そんな id は無い」ではない）。' +
              'runner に生きたセッションが無く、resume でも入り直せなかっただけである。' +
              'manager_list で状態を確かめ、時間で解ける理由（引き取り中・貸し出し期限）' +
              'なら少し置いてから送り直すこと。' +
              RESTART_BEFORE_CHECK_ADVICE,
          );
        }
        // 「届けた」が保証する範囲を名乗る: 観測したのは resume の口が成功を返したところまでで、相手がこの本文を読んだかは見ていないため
        // 「同じ本文で立て直さないこと」は落とさない: 送った直後の `manager_list` が `lost` のままで、クローンが指示を失ったと判断し出し直した実害があるため
        if (result.outcome === 'delivered') {
          return text(
            `[${managerId}] ${result.detail}\n` +
              '**「届けた」は「読んで動いた」ではない。** 観測したのは runner の ' +
              'resume の口を叩いて成功が返ったところまでで、' +
              '相手がこの本文を読んだかは1度も見ていない。' +
              '⟹ この直後の manager_list が lost／セッション切断のままでも、' +
              'それは「届かなかった」の証拠にはならない' +
              '（黙った器に載っている委譲へも送信は実際に届く）。' +
              '**同じ本文で新しい委譲を立てないこと** — 同じ仕事が2本になる。' +
              '読まれたかを確かめるなら manager_report を見ること。',
          );
        }
        return text(result.detail);
      },
    ),

    // クローン用の停止を別に作らない: 挙動が2種類あると、人間とクローンで見えている状態が食い違うため
    // マネージャーには渡さない: 自分や隣の仕事を止められると M4 の制御面分離が意味を失うため
    tool(
      'manager_stop',
      [
        'マネージャーを止める。人間が Web UI から押す停止と同じもので、その1本だけが止まる。',
        '暴走しているとき、報告を出したのに終わらないとき、依頼自体が要らなくなったときに使う。',
        '止めたあと本当に止まったかを確かめて返すので、返ってきた状態まで読むこと。',
        '⚠️ いまターンの途中（running）の委譲は既定では止めない——畳むと進行中の作業が' +
          '失われるため。それでも止めるなら force: true を渡すこと。' +
          '止める前に一覧を読めなかったときも、走行中かどうか判定できないので同じく断る。',
      ].join(' '),
      {
        managerId: z.string().describe('manager_list に出ている id'),
        reason: z
          .string()
          .optional()
          .describe('なぜ止めたか。日誌と、その仕事の記録に残る。後から辿れるように書く'),
        force: z
          .boolean()
          .optional()
          .describe(
            'いまターンの途中（status: running）の委譲でも止める。既定（false/省略）だと、' +
              'running の委譲は abort を呼ばずに断って理由を返す——畳むと、そのターンが抱えて' +
              'いる進行中の作業（起こした作業者など。作業ツリーが見つかれば未 push の実装・監視中の CI も）が' +
              '失われるため。' +
              '止める前に一覧を読めなかったとき（走行中か判定できない）も同じく断る。' +
              '断りを読んだうえで、それでも畳んでよいと判断したら true で呼び直すこと。',
          ),
      },
      async ({ managerId, reason, force }) => {
        if (!context.managers) return NO_POOL;
        const pool = context.managers;
        // 3状態にする: `pool.list()` の失敗を `[]` に倒すと「居ない」と「読めなかった」が区別できないため
        type ManagerLookup =
          | { kind: 'found'; manager: ManagerSummary }
          | { kind: 'absent' }
          | { kind: 'unreadable'; reason: string };
        const find = async (): Promise<ManagerLookup> => {
          let list: ManagerSummary[];
          try {
            list = await pool.list();
          } catch (error: unknown) {
            return { kind: 'unreadable', reason: reasonOf(error) };
          }
          const manager = list.find((entry) => entry.managerId === managerId);
          return manager === undefined ? { kind: 'absent' } : { kind: 'found', manager };
        };

        const beforeLookup = await find();
        const before = beforeLookup.kind === 'found' ? beforeLookup.manager : undefined;

        if (beforeLookup.kind === 'unreadable' && force !== true) {
          return text(
            `[${managerId}] 止めていない。**いまの状態を一覧から読めなかった**ので、` +
              '走行中（running）かどうか判定できない — 走行中なら、畳むと、そのターンの' +
              '進行中の作業（起こした作業者など）が失われる。\n' +
              `読めなかった原因: ${beforeLookup.reason}\n` +
              'manager_list で状態を確かめること。読めても判断が同じなら、🔴 force: true で' +
              '呼び直すと止まる。',
          );
        }

        // running は既定で abort を呼ばずに断る: クローンには人間の画面のようにターンが走っている様子が見えないため
        // `force` を必ず残す: 暴走している委譲を止める道を塞ぐほうが、誤って畳むより危険なため
        // `waiting_human` は含めない: クローン自身が立てた問いで、待っていること自体は既に知っているため
        if (before?.status === 'running' && force !== true) {
          // 要点を先頭・短くする: 「⚠ の1行を足す」形の断りは読まれても流されるため、核心（force で止まる）を長い説明の奥に埋めない
          const lastReportLine =
            before.lastReportAt === undefined
              ? '直近の報告は一度も届いていない。'
              : `直近の報告は ${before.lastReportAt}` +
                '（最後に終えたターンのもの。いま走っているターンの中身ではない）。';

          // この調べものが失敗しても断りは必ず返す: 止める道が塞がっていないことを守るため、例外を投げない設計でも念のため捕まえる
          const unpushedWork = await pool
            .unpushedWork(managerId, {
              signal: AbortSignal.timeout(MANAGER_STOP_UNPUSHED_WORK_TIMEOUT_MS),
              source: 'stop-refusal',
            })
            .catch((error: unknown): ManagerUnpushedWork => ({
              kind: 'unavailable',
              reason: `確かめようとして例外が飛んだ: ${reasonOf(error)}`,
            }));

          // 具体（未 push・CI）は作業ツリーが見つかったか探索に失敗したときだけ足す: git を使わない仕事に git/CI 前提の文面を毎回出さないため
          const gitConcrete =
            unpushedWork.kind === 'unavailable' ||
            !isEmptyCompleteUnpushedWorkObservation({
              kind: 'observed',
              worktrees: unpushedWork.result.worktrees,
              truncatedAtCount: unpushedWork.result.truncatedAtCount,
              stoppedEarly: unpushedWork.result.stoppedEarly,
              scratchRootsUnknown: unpushedWork.result.scratchRootsUnknown,
              unreadableDirCount: unpushedWork.result.unreadableDirCount,
            });
          return text(
            `[${managerId}] 止めていない。**いまターンの途中**（running）— 畳むと、そのターンの進行中の作業が失われる` +
              (gitConcrete
                ? '（未 push の実装・起こした作業者・監視中の CI など）'
                : '（起こした作業者など）') +
              '。🔴 force: true で止まる。\n' +
              `${lastReportLine} ターンの中身は manager_report で先に読めること。` +
              (gitConcrete ? `\n${describeUnpushedWork(unpushedWork)}` : ''),
          );
        }

        const result = await pool.abort(managerId, reason, 'clone');

        if (result.outcome === 'unreadable') {
          // 読めない行を「居ない」と言わない
          return text(`${managerId} は止められなかった: ${result.detail}`);
        }
        if (result.outcome === 'absent') {
          if (beforeLookup.kind === 'unreadable') {
            // 読めなかったことを「居ない」と言い切らない
            return text(
              `${managerId} は止められなかった: ${result.detail}\n` +
                `止める前の状態を一覧から読めなかった（${beforeLookup.reason}）ので、` +
                '台帳にあるかどうかは分からない。manager_list で今あるものを確かめること。',
            );
          }
          if (!before) {
            return text(
              `${managerId} は居ない（id が違うか、台帳からも消えている）。` +
                'manager_list で今あるものが見える。',
            );
          }
          return text(
            `${managerId} は止められなかった: ${result.detail}\n` +
              `台帳では ${before.status} で、このデーモンからは話しかけられない（live: false）。` +
              '走らせていた器がもう無いので、止める手そのものが残っていない。',
          );
        }

        const afterLookup = await find();
        const after = afterLookup.kind === 'found' ? afterLookup.manager : undefined;
        // 読めなかったときは「消えている」と言わない
        const afterUnreadable =
          afterLookup.kind === 'unreadable'
            ? `止めた後の状態を一覧から読めなかった（${afterLookup.reason}）`
            : undefined;

        if (result.outcome === 'not_stopped') {
          return text(
            `[${managerId}] ${result.detail}\n` +
              `**止まっていない。** runner には ${managerId} のセッションがまだ残っている。` +
              `いまの状態: ${afterUnreadable ?? (after === undefined ? '一覧から消えている' : describeManagerState(after.status, after.live, after.awaitingBackground))}。` +
              ' manager_list で確かめ、必要ならもう一度止めること。',
          );
        }

        if (result.outcome === 'unknown') {
          // 「止めた」とも「止まっていない」とも言い切らない
          return text(
            `[${managerId}] ${result.detail}\n` +
              '止まったかは**未確認**である（runner に確認が取れなかった）。' +
              'manager_list で状態を確かめること。',
          );
        }

        const lines = [`[${managerId}] ${result.detail}`];

        if (before?.status === 'done') {
          // 「走っている手は無い」と断定しない: `done` はマネージャー自身のターンが終わっただけで、作業者の生存はデーモンから見えないため
          lines.push(
            'もともと待機中（done）だった仕事である。マネージャー自身のターンは終わっていたので、' +
              '畳んだのは記録である。ただし **`done` は「その下で誰も動いていない」ことまでは' +
              '意味しない** — 作業者が走っているかどうかはデーモンからは見えていない。',
          );
        }
        lines.push(
          afterUnreadable !== undefined
            ? `${afterUnreadable}。manager_list で状態を確かめること。`
            : after === undefined
              ? '一覧からも消えている。'
              : `いまの状態: ${describeManagerState(after.status, after.live, after.awaitingBackground)}。`,
        );
        // 届いていない本文を待ってこの応答を止めない: report イベントは HTTP 越しの runner では後から届くため、届いていれば抜粋を、届いていなければ `manager_report` への案内を出す
        lines.push(
          after?.lastFoldedTurn === undefined
            ? '畳んだターンの本文はまだ台帳に届いていない（別経路で後から届くことがある）。' +
                `届けば台帳へ残るので、manager_report ${managerId} で後から読めること。`
            : `畳んだターンの本文（${after.lastFoldedTurn.at} 受信）: ` +
                `${excerptLine(after.lastFoldedTurn.text, MANAGER_STOP_FOLDED_TURN_EXCERPT)} ` +
                `全文は manager_report ${managerId} で読めること。`,
        );
        return text(lines.join('\n'));
      },
    ),

    // `resources()` を毎回呼ばない: 一覧のためにネットワーク往復を足し、`runner_list resources: true` というクローンの明示的な opt-in を自動で踏み潰すため、代わりにキャッシュの `runnerBacklog()` を読む
    tool(
      'manager_list',
      [
        'マネージャーの一覧と状態を見る。何が走っていて、何が返事待ちかが分かる。',
        // 状態の名前を「観測」より強く読ませない: running は「走らせた」で「進んでいる」ではなく、done は「ターンが終わった」で「仕事が終わった」ではないため
        '状態の名前はデーモンが観測できた範囲でしかないので、⚠ の行まで読むこと。',
        'done/背景処理待ち×N は、そのマネージャーが自分で起こした背景処理（run_in_background の子）や' +
          '作業者への委譲の完了を待って畳んだだけで、手が空いたのではないという意味である。' +
          'N は器が名乗った背景タスクの在り高であって、握り潰した報告の本数ではない' +
          '（同じ1本が3つのタスクを待ちながら2回畳めば、在り高3・握り潰し2になる）。' +
          '握り潰した報告の中身は manager_report と日誌（decision）に在る。' +
          '**この印は器が名乗った分にだけ立つ** — この欄を送らない古い器では、背景処理を待っていても' +
          '立たない。だから **印が無いことを「手が空いている」と読まないこと。**',
        '背景処理待ち×N の直後に「（<時刻> から）」が付くことがある。それはこの委譲が' +
          '最初に背景処理待ちへ入った時刻（ISO 8601、UTC）で、経過時間そのもの（「N時間」等）' +
          'ではない——ここは呼ばれるたびに答えが変わる計算をしない場所なので、経過は' +
          'いまの時刻と見比べて自分で出すこと。時刻が付かないのは「そう名乗られていない」' +
          '場合であって「待ち始めていない」ではない（この印が立つ条件は直前の断りと同じ）。',
        '依頼文と報告は抜粋なので、全文が要るなら manager_report で取ること。',
        '「runner にセッションが無い」は、10秒ごとの生存確認が runner に一覧を' +
          '聞いて観測する（走行中・返事待ちのものだけを見る）。誰かが manager_send を' +
          '打つのを待たない。ただし観測できた回にだけ立つので、**行が出ないことを' +
          '「セッションは在る」と読まないこと** — 器に聞けなかっただけの回もある。' +
          '待機中（done）のものはこの観測の対象外である（完遂してセッションを畳んだ' +
          '回と区別が付かず、区別できないものに ⚠ を付けると本当に困っている1本が埋もれる）。',
        '器（runner）側の未送出の滞留は、runner_list を resources: true で明示的に呼んだとき、' +
          'または10秒ごとの生存確認が対応する runner から自動で拾ったときに、それぞれ' +
          'キャッシュされる（それ以外の経路では更新されない）。生存確認からの自動更新に' +
          '対応しない古い runner・LocalRunner は、runner_list を resources: true で' +
          '呼ばない限り一度も warm しない——この一覧に行が出ないことを「滞留0」と' +
          '読まないこと。0件だったか、まだ観測していないかのどちらかである。出ている行も' +
          '観測した時点の値であって現在値ではないので、最新の値が要るなら runner_list を' +
          'resources: true で呼び直すこと。',
        '生ログの末尾が stop_reason: tool_use のまま対応する tool_result が無く、かつ返事待ちが空の' +
          'ものには ⚠ の行が出る（道具を回しているなら、その応答を待っているのはデーモンのはずなので、' +
          'これは矛盾である）。この行に時刻の閾値は置いていない——何分経ったかは判定していないので、' +
          '行に出ている timestamp を読んで判断すること。返事待ちが在るものにはこの行を出さない' +
          '（確認は届いていて、クローンがまだ答えていないだけの正常な状態である）。',
        '「畳む候補」の ⚠ は、status が done で背景処理待ちの印が無く、状態の判定が' +
          'active で、最後のターン終了から一定時間が経った委譲に出す印である。' +
          'ただし、器が「背景処理待ちの印を送る版」だと名乗った（runner の hello の能力）委譲にしか出ない' +
          '——名乗らない古い器や、名乗りをまだ受けていない器の委譲には出ない' +
          '（出ていないことを「畳む候補が無い」と読まないこと）。' +
          'この道具（manager_list）自身は畳まない——ここは表示だけである。' +
          '畳むのは runner_list を resources: true で呼んだときだけで、その器の pids が' +
          '逼迫していれば（上限の80%以上）、同じ候補の判定を満たす委譲をデーモンが自動で畳む' +
          '（未 push の実装・未コミットの変更が無いことも確かめたうえで。#1394 段④⑥⑦）。' +
          '何を畳んだ・見送ったかは runner_list の応答と日誌（journal_read、decision）に出る。',
        '走行中・返事待ち（running / waiting_human）を先に出し、次に lost（前のセッションへ戻れなかったもの。' +
          '成果がリモートに届いているかを誰も確かめていない＝判断待ちである）、' +
          'そのあとに残りの終端（done / failed / stopped）を出す。' +
          '各群の中は startedAt の新しい順である。',
        'status で状態を絞れる（省略すると絞らない）。先頭の件数の行は**絞る前の全体**を出すので、絞っても全体の実像は消えない。',
        // `[]` の倒し方はクローンが読む面にも書く: 他の一覧は `[]` を0件として扱うので、ここだけ違うことを黙っていると読み手が「0件だ」と読むため
        'status に空の配列を渡した呼びは絞らない（渡さなかったのと同じ全件が出る。' +
          'そのときは「絞らずに全件を出した」と応答に書く）。' +
          '**journal_read の types / commitment_list の origin とは倒し方が違う** — ' +
          'あちらは [] を「どれにも当たらない」＝0件として扱う。',
        '絞った先が予算で切れたら、断り書きが次に打つ cursor を案内する。それを cursor へ渡すと続きから読める。',
        '認証トークンの世代の行（`describeTokenGeneration` の doc）が出ているマネージャーでは、' +
          'この委譲が最後に起こした／自動で開き直した時点の世代と、いまの現役の世代を比べられる。' +
          '⚠ が付いていれば世代が食い違っている——回した直後の短い遅れなら自然に消える。' +
          `429 が続いたまま消えないなら、起こし直すこと。${STALE_TOKEN_RESTART_ADVICE}` +
          '世代が測れていないときも行は出る——' +
          '「分からない」の理由（プール未配線／未観測／デーモンの再起動をまたいだ引き取り）を' +
          '名乗る（Issue #988）。再起動をまたいだ場合だけ manager_stop → manager_start が効く。',
        '429 で落ちたとき、SDK が返す文言に書かれていた resets 時刻を、認証トークンの' +
          'プールの各鍵の冷却期限と突き合わせた行も出ることがある。「世代ずれの疑い」なら、' +
          'この委譲は現役ではない古い鍵を掴んだまま走っている可能性が高い——鍵が通る状態へ' +
          '戻っても、このセッション自身は起こし直すまで戻らない。' +
          '「待てば戻る」なら、現役の鍵自身がいま冷却中なだけで世代ずれではなく、対処は要らない。' +
          '行が出ないのは「健全」ではなく「まだ判定できない」という意味である——' +
          '429 の通知がまだ届いていないか、文言・プールのどちらとも一致しなかったかのどちらか。' +
          '世代番号の比較（提案1）が既に食い違いを名指ししているときは、二重に鳴らさないので' +
          'この行は出ない。',
      ].join(' '),
      {
        // `jobStatusSchema` をそのまま使う: 綴りを間違えた呼びが「その状態のものは0件」として返り、絞り込みが効いていないことに気づけない形を作らないため
        status: z
          .array(jobStatusSchema)
          .optional()
          .describe(
            '状態（running / waiting_human / done / failed / lost / stopped）で絞る。' +
              '省略すると絞らない。走っているものだけを見たいなら ["running","waiting_human"]。' +
              '空の配列 [] も絞らない（渡さなかったのと同じ。0件にはならない）。' +
              '先頭の件数の行は絞る前の全体を出す',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            '一覧の続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す' +
              '（自分で組み立てない）。省略すると先頭から。' +
              'status はカーソルを取った呼びと揃えること（食い違うと明示のエラーになる）。',
          ),
      },
      async ({ status, cursor }) => {
        if (!context.managers) return NO_POOL;
        const managers = await context.managers.list();
        // この一覧ぜんぶで同じ「いま」を使う: 行ごとに `new Date()` を呼ぶと、同じ応答の中で判定の基準がずれるため
        const now = new Date();
        // 受信箱の滞留は早期リターンの前に確かめる: マネージャーが1本も居なくても合図が溜まっていることがあるため
        const inboxBacklog = describeInboxBacklog(
          await context.stores.inbox.peekPending(),
          Date.now(),
          context.queuedInMemory?.(),
        );
        // `?.() ?? []` で読まない: 「この口を持たない実装」と「持っているが1件も観測していない」を同じ `[]` へ畳み、この一覧が区別しようとしているものを潰すため
        const runnerBacklog = describeRunnerBacklog(context.managers.runnerBacklog());
        const origins = await readJobOrigins(context.stores);
        // 読めない委譲の行は「居ない」と分けて名乗る: `list()` は読めない行を飛ばすので、黙っていると壊れた行だけの台帳が「1本も居ない」に見えるため
        const unreadableJobNote = describeUnreadableJobs(
          await context.stores.jobs.listUnreadableJobs(),
        );
        if (managers.length === 0) {
          return text(
            [
              unreadableJobNote === null
                ? '（マネージャーは1本も居ない）'
                : '（読めたマネージャーは無い。居ないとは言えない）',
              unreadableJobNote,
              inboxBacklog,
              runnerBacklog,
            ]
              .filter((line): line is string => line !== null)
              .join('\n'),
          );
        }

        // 走行中・返事待ち → lost → その他の3群で出す: `ManagerPool.list()` は稼働状態を見ない `startedAt` 降順で、終端した委譲が溜まると走行中が窓の外へ押し出され id が本文に出なくなるため
        // `ManagerPool.list()` は変えない: HTTP の錨と digest の契約があの並びに依存しており、並べ直すのはこの一覧の中だけにする
        // `lost` は第2群として前へ出す: 成果の有無を観測していないので確かめるまで終われず、終端の袋に入れると判断が要るものが窓の外へ落ちるため
        // 再通知は作らない: `manager_message` は束ねられず、`lost` の本数がそのままクローンのターン数になるため
        const attention = [...managers].sort(compareManagerAttention);
        // 絞りは文字数の予算より前に当てる: 後だと絞りに当たらない行が窓を食い尽くし、狙った行が窓の外へ落ちるため
        // `status: []`（空配列）は「絞らない」へ倒す。**この面の他の一覧とは逆である**: ストアを通らず、同じ引数名が面によって逆の答えを返すほうが、面の中で倒し方が揃わないことより重いため（`GET /managers?status=` に揃える）
        // 黙って無視しない: `[]` を0件だと思って渡した呼び手には、出力で「絞らずに全件を出した」と言う
        const filtering = status !== undefined && status.length > 0;
        const view = filtering
          ? attention.filter((manager) => status.includes(manager.status))
          : attention;
        // cursor は `status` で絞った後・予算で切る前で解決する: 順序を変えると絞りに当たらない行が窓を食い尽くすため
        const cursorStatus = normalizeManagerCursorStatus(status);
        const cursorOutcome = resolveManagerCursor(view, managerPositionOf, cursorStatus, cursor);
        if (cursorOutcome.kind === 'malformed') {
          return text(
            'cursor が壊れている（この道具が返したものではないか、書き換えられている）。' +
              '一覧を先頭から読み直すには cursor を付けずに manager_list を呼ぶこと。',
          );
        }
        if (cursorOutcome.kind === 'status-mismatch') {
          const cursorStatusText =
            cursorOutcome.cursorStatus === null
              ? '絞っていない'
              : cursorOutcome.cursorStatus.join(',');
          return text(
            `cursor は status: ${cursorStatusText} の一覧から出た続きの位置で、` +
              `いまの呼び（status: ${status === undefined ? '未指定' : status.join(',')}）と食い違う。` +
              'status を cursor を取ったときと揃えて呼び直すか（' +
              `manager_list ${cursorOutcome.cursorStatus === null ? '' : `status=${JSON.stringify(cursorOutcome.cursorStatus)} `}cursor=${cursor}）、` +
              'cursor を付けずに status だけで先頭から呼び直すこと。',
          );
        }
        const paged = cursorOutcome.view;
        // 予算を先に決めて入るところまで積む: 件数から出力量を決めると何件で壊れるかが運任せになるため
        const items = paged.map((manager) => {
          // 印は行を新しく増やさず既存の行へ添える: 行を1本増やすと予算に張り付いた一覧では出る件数が減るため
          const drift = describeReportDriftMark(manager, now);
          const driftMark = drift === null ? '' : `、${drift}`;
          // 条件3は器の機能申告で確かめる: 名乗りを受けていない・旧い器・runnerId が無い委譲は「送っているはず」と仮定しない
          // 条件5の材料は `turnEndedAt` ではなく `updatedAt`: `turnEndedAt` は `status: 'running'` の委譲でしか計算されないため
          const foldCandidateLine = describeManagerFoldCandidate(
            {
              status: manager.status,
              hasAwaitingBackgroundSignal: manager.awaitingBackground !== undefined,
              awaitingBackgroundSignalVersionConfirmed:
                manager.runnerId !== undefined &&
                (context.managers?.runnerHasCapability?.(
                  manager.runnerId,
                  RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL,
                ) ??
                  false),
              activityKind: classifyManagerActivity(managerActivityInputOf(manager)),
              lastTurnEndedAt: manager.updatedAt,
            },
            now,
          );
          return renderListingEntry({
            id: manager.managerId,
            title: `[${describeManagerState(manager.status, manager.live, manager.awaitingBackground)}]`,
            createdAt: manager.startedAt,
            updatedAt: manager.updatedAt,
            summary: `依頼: ${excerptLine(manager.request, LIST_REQUEST_EXCERPT)}`,
            extra: [
              // runnerId は空欄にしない: 空欄だと「取れていない」のか「読み忘れ」なのか区別できないため「未記録」と書く
              // 断定は「器が黙っている」までにする: その中で走っていたかはこの観測から言えない
              // 「いま話しかけられない」と書かない: 名簿が `lost` と判定した器の委譲へも `send()` は実際に届くため
              `  runner: ${manager.runnerId ?? '未記録'}${
                manager.runnerLostSince === undefined
                  ? ''
                  : `（この器は ${manager.runnerLostSince} 以降 名乗っていない。新しい委譲の宛先からは外れている（置き先として数えない）。**この委譲が失われたという意味ではない** — 黙っているのが器なのか経路なのかは、ここからは言えない（器の中でまだ走っていることもある）。話しかけることは塞いでいない — 戻る先（session_id）が在れば manager_send が resume を試みる（届くとは限らない）。${RESTART_BEFORE_CHECK_ADVICE}器そのものは runner_list で見る）`
              }`,
              // 取れない側は「不明」と書き、既定の帯（opus / sonnet）と推測しない
              `  モデル: ${describeManagerModels(managerModelsOf(context.managers, manager))}`,
              // 別の行として出し `describeManagerState` は動かさない: `manager_list` と要約で字面が割れるのを防ぐための関数のため
              manager.sessionMissingSince === undefined
                ? null
                : `  ⚠ 宛先の runner は ${manager.sessionMissingSince} の時点で、この委譲のセッションを持っていなかった` +
                  '（runner がそう答えた。聞けなかったのではない）。' +
                  // 由来を畳まない: 「resume でも入り直せなかった」と「名簿に載っていなかっただけ」では読み手の次の一手が違うため
                  describeSessionMissingKind(manager.sessionMissingKind) +
                  '**この委譲が失われたという意味ではない** — ' +
                  '完遂した後にセッションが畳まれ、終端イベントだけが届かなかった回も同じ形に見える' +
                  '（デーモンにこの2つを区別する材料は無い）。まず manager_report を見ること' +
                  '（報告が空でも、生ログから「生成されたが配られていない」報告を拾える）。' +
                  'session_id が残っていれば manager_send が resume から入り直す。' +
                  RESTART_BEFORE_CHECK_ADVICE,
              `  cwd: ${manager.cwd}`,
              // `lost` を状態名だけで済ませない: 「終わった」と読まれると完了していない仕事がそのまま片付くため
              // 言い切るのは観測した分までにする: 落ちる直前にマージまで済ませていた仕事が、その
              // 1分半後の器の作り直しで `lost` になり、この行が「途中で失われて
              // いる（完了ではない）」と嘘をついた実害があるため
              manager.status === 'lost'
                ? '  ⚠ 前のセッションへ戻れなかった。**戻れたかどうかしか見ていない** — ' +
                  'この仕事が終わっていたかは分からない（成果がリモートの PR・ブランチ・' +
                  'コミットまで届いていることがある）。まずそこを確かめ、続きが要ると' +
                  '判断したときだけ manager_start で起こし直すこと。'
                : null,
              describeJobOrigin(origins, manager.managerId),
              unobservedOutcomeLine(manager),
              // 拒否は `status` に映らないので、状態の値は増やさず状態に添える
              denialLine(context.managers?.denials(manager.managerId) ?? [], manager.lastReportAt),
              // 待ちの要約も抜粋を通す: `AskUserQuestion` の経路は質問文を連ねて runner 側のキャップを通らないため
              // 欠けていても「実行許可」「undefined から」と嘘をつかず、`種別不明` にして時刻の断片を落とす
              // 件数にも上限を置く: `manager.waiting` は増える一方で、伸びると1本のマネージャーが予算を占有し他が押し出されるため
              ...manager.waiting.slice(0, MANAGER_WAITING_LIST_LIMIT).map((item) => {
                const askedAtNote = describeAskedAt(item.askedAt);
                return (
                  `  返事待ち(requestId: ${item.requestId}, ${describeWaitingKind(item.kind)}` +
                  `${askedAtNote === '' ? '' : `, ${askedAtNote}`}): ` +
                  excerptLine(item.summary, LIST_WAITING_EXCERPT)
                );
              }),
              manager.waiting.length > MANAGER_WAITING_LIST_LIMIT
                ? `  …ほか ${manager.waiting.length - MANAGER_WAITING_LIST_LIMIT} 件の返事待ちは省略` +
                  `（全 ${manager.waiting.length} 件。manager_send に requestId を渡せば個別に答えられる）。`
                : null,
              // 失敗は報告の上に置く: 下だと包まれたエラー文を先に読んでから「実は報告ではない」と分かる順になるため
              failureLine(manager),
              usageStoppedLine(manager),
              runnerVanishedLine(manager),
              systemErrorLine(manager),
              cgroupEventsLine(manager),
              manager.lastReport === undefined
                ? null
                : // 時刻は既存の行に添えるだけ: 行を1本増やすと予算に張り付いた一覧では出る件数が減るため、`lastReportAt` が無い行には「未受信」のような行を作らない
                  // 失敗した回・畳まれた回は「報告」と呼ばない: 見出しが「直近の報告」のままだと包みの内側だけを読んで報告として扱うため
                  `  ${isFoldedTurnReport(manager) ? '直近のターンの中身' : '直近の報告'}${manager.lastReportAt === undefined ? '' : `（${manager.lastReportAt} 受信${driftMark}）`}: ${excerptLine(manager.lastReport, LIST_REPORT_EXCERPT)}`,
              describeTurnEnd(manager),
              describeToolUseStall(manager),
              describeTokenGeneration(manager),
              describeResetTimeSkew(manager),
              foldCandidateLine,
              describeUnpushedWorkObservation(manager),
              // `describeWithheldReports` はここには足さない: 「背景処理待ち×N」の `tasks` と並べると別行でも混同が起き、行を増やしても読み手の次の一手は変わらないため
            ],
          });
        });
        return text(
          [
            // 本数は一覧の外に出す: 一覧は予算で打ち切られ、出ている行を数えても全体の本数にならないため。件数は絞る前の全件で出す: 絞りのせいで全体の実像が見えなくなる形にしないため
            describeManagerCounts(managers),
            unreadableJobNote,
            // 絞ったことは件数の行とは別の行で言う: 混ぜると「絞る前の全体」と「絞った後」がどちらの数なのかを読み分ける負担が読み手に移るため
            // `status: []` は「絞らなかった」と言う: 黙って無視しないため
            status === undefined
              ? null
              : filtering
                ? `絞り込み: status: ${status.join(',')} に当たるのは ${view.length} 件で、` +
                  'この一覧はその中だけを出している（すぐ上の件数は絞る前の全体である）。'
                : '絞り込み: status に空の配列が渡ったので、絞らずに全件を出した' +
                  '（渡さなかったのと同じ結果である。人間の GET /managers に揃えてある——' +
                  '0件へ倒すと絞りを解除した呼びが「マネージャーが消えた」ように見えるため）。' +
                  '**journal_read の types / commitment_list の origin は [] を0件として扱うので、' +
                  'この道具だけ倒し方が違う**（理由は tools.ts の doc に在る）。',
            // 絞った結果が0件なのと委譲が1本も無いのを分ける: 「無い」と読めると、絞りが厳しかっただけなのに台帳の側を疑うことになるため
            view.length === 0
              ? '（この status の絞り込みに当たる委譲は無い。絞る前の件数は上の行に在る）'
              : // cursor で辿り切った最後の頁を、絞り込みの0件とは別の文にする
                paged.length === 0
                ? '（cursor より後ろの、この絞り込みに当たる委譲は無い。これが最後の頁）'
                : renderListing(items, {
                    budget: LIST_BUDGET,
                    // `status` の有無ではなく `filtering` で分ける: `status: []` は絞っていないので、有無で分けると渡した文字が無いのに絞ったと言う嘘になるため
                    // 母数は `renderListing` が渡す `total` ではなく `view.length` を使う: 頁が進んでも変わらない数にするため
                    omitted: ({ rest, shown }) => {
                      const total = view.length;
                      const lastShown = paged[shown - 1]!;
                      const nextCursor = encodeManagerCursor({
                        ...managerPositionOf(lastShown),
                        status: cursorStatus === null ? null : [...cursorStatus],
                      });
                      const statusArg = filtering ? ` status=${JSON.stringify(status)}` : '';
                      return (
                        `…ほか ${rest} 件は省略（` +
                        (filtering
                          ? `status: ${status.join(',')} に絞った ${total} 件のうち ${shown} 件を出した`
                          : `全 ${total} 件`) +
                        '）。走行中・返事待ちを先に出し、次に lost（判断待ち）、そのあとに残りを出す。' +
                        '各群の中は startedAt の新しい順である。' +
                        '**省略されたのは終端したもの（またはより古いもの）の側である。**' +
                        `続きは manager_list cursor=${nextCursor}${statusArg} で取れる（status は同じまま呼ぶこと）。` +
                        '委譲の台帳には保持期間も掃除の機構も無いので、辿る頁数は台帳の本数に比例して増える。' +
                        'status で絞れば頁数を減らせる。'
                      );
                    },
                  }),
            '（依頼と報告は抜粋。全文は manager_report <managerId> で取れる）',
            inboxBacklog,
            runnerBacklog,
          ]
            .filter((line): line is string => line !== null)
            .join('\n'),
        );
      },
    ),

    tool(
      'manager_report',
      [
        'マネージャーの依頼文・直近の報告を全文で読む。',
        'manager_list は抜粋なので、欠落に気づいたらここで全部読むこと。',
        '長い場合は続きの取り方が末尾に出るので、最後まで読み切ること。',
        'それでも足りない（報告に書かれていない中身を確かめたい）ときは manager_transcript で生ログまで降りられる。',
        'report が「まだ無い」と返ったときは、内部で生ログも見ている（#323）——',
        '「まだ書いていない」のか「書いたのに配られていない」のかを、応答の文言（⚠ の有無）で見分けられる。',
      ].join(' '),
      {
        managerId: z.string().describe('manager_list に出ている id'),
        part: z
          .enum(['report', 'request'])
          .optional()
          .describe('report=直近の報告（既定） / request=依頼文'),
        offset: z
          .number()
          .optional()
          .describe(
            `何文字目から読むか（${formatIntRangeJa({ min: 0 })}）。前回の応答が示した続きの位置を渡す`,
          ),
      },
      async ({ managerId, part = 'report', offset = 0 }) => {
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        if (!context.managers) return NO_POOL;
        const managers = await context.managers.list();
        const found = managers.find((manager) => manager.managerId === managerId);
        if (!found) {
          // 読めない委譲の行は「居ない」と分けて言う: 見つからなかったときだけ台帳を読み直す（単票の取得のたびに一覧を読まない）
          const unreadableRow = (await context.stores.jobs.listUnreadableJobs()).find(
            (row) => row.id === managerId,
          );
          if (unreadableRow !== undefined) {
            return text(describeUnreadableManagerRow(managerId, unreadableRow.reason));
          }
          return text(
            `マネージャー ${managerId} は居ない（もう畳まれたか、id が違う）。` +
              'manager_list で今あるものが見える。',
          );
        }

        const modelLine = `モデル: ${describeManagerModels(managerModelsOf(context.managers, found))}`;
        // 在れば `lastReport` より優先して見せる: `lastFoldedTurn` は `lastReport` より後に届いた内容で、陰に隠れたままだと `manager_report` から一生読めなくなるため
        const foldedTurn = part === 'request' ? undefined : found.lastFoldedTurn;
        const body = part === 'request' ? found.request : (foldedTurn?.text ?? found.lastReport);
        if (body === undefined || body.length === 0) {
          if (part === 'request') {
            return text(`マネージャー ${managerId} の依頼文が記録に無い。`);
          }
          // 依頼文では見に行かない: 往復を無条件に増やさないため、report のときだけ生ログを見る
          const missing = await describeMissingReport(context.managers, managerId, found.status);
          // 報告の有無とは別の軸なので、報告が空の回だからこちらも出さない、にはしない
          const usageStopped = describeUsageStopped(found);
          const runnerVanished = describeRunnerVanished(found);
          const systemError = describeManagerSystemError(found);
          const cgroupEvents = describeManagerCgroupEvents(found);
          // 報告が空の回でも拒否は出す: 黙ると「まだ書いていない」と「番人に止められて書けない」を区別できないため
          const denied = describeDenials(context.managers.denials(managerId), found.lastReportAt);
          // この枝でも出す: `manager_list` で「何も届いていない」と読んだクローンが掘りに来る先で、黙ると順位を付けた意味が掘った先で消えるため
          const unobserved = describeUnobservedOutcome(found);
          const unpushedWork = unpushedWorkReportNote(found);
          const withheldReportsNote = describeWithheldReports(found);
          return text(
            [
              modelLine,
              missing,
              usageStopped,
              runnerVanished,
              systemError,
              cgroupEvents,
              denied,
              unobserved,
              unpushedWork,
              withheldReportsNote,
            ]
              .filter((s) => s !== null)
              .join('\n\n'),
          );
        }

        // 失敗した回は「報告」と呼ばない（Issue #714）: 見出しが「直近の報告」のままだと、⚠ を見た直後に包みの内側だけを読んで報告として扱うため
        // `foldedTurn` が在る回は注記を出さない: `lastFailure` は畳まれる前の無関係な古いターンを指し、注記が予告する本文の種類と実際の本文が食い違うため
        const managerFailure =
          part === 'request' || foldedTurn !== undefined
            ? null
            : describeManagerFailure(
                found.lastFailure,
                found.lastReport,
                found.status,
                tokenGenerationMismatched(found),
              );
        const usageStopped = part === 'request' ? null : describeUsageStopped(found);
        const runnerVanished = part === 'request' ? null : describeRunnerVanished(found);
        const systemError = part === 'request' ? null : describeManagerSystemError(found);
        const cgroupEvents = part === 'request' ? null : describeManagerCgroupEvents(found);
        // 報告が在る回でも拒否は出す: 報告を書いた後で別の道具を止められていると、本文だけ読むと「報告どおり進んでいる」と読めるため
        // foldedTurn の回は `lastReportAt` の代わりに `foldedTurn.at` を渡す: `lastReportAt` は畳まれる前の古い値のままで、「拒否の後の報告はまだ届いていない」と誤判定するため
        const denied =
          part === 'request'
            ? null
            : describeDenials(
                context.managers.denials(managerId),
                foldedTurn !== undefined ? foldedTurn.at : found.lastReportAt,
              );
        // 依頼文（`part === 'request'`）では注記を出さない: 依頼文は報告・失敗・拒否の話ではないため
        const unobserved = part === 'request' ? null : describeUnobservedOutcome(found);
        const unpushedWork = part === 'request' ? null : unpushedWorkReportNote(found);
        const withheldReportsNote = part === 'request' ? null : describeWithheldReports(found);
        const label =
          part === 'request'
            ? '依頼文'
            : // 停止後に届いた本文は別の見出しで言い分ける: `isFoldedTurnReport` とは別の畳まれ方のため
              foldedTurn !== undefined
              ? `停止後に届いた、畳まれたターンの中身（${foldedTurn.at} 受信）`
              : isFoldedTurnReport(found)
                ? '直近のターンの中身'
                : '直近の報告';
        const part1 = page(body, offset, REPORT_PAGE);
        // 齢といまの status を見出しに添える: 読み手が直近に完了したターンの中身をいまの状態として読まないため
        const reportAgeStatus =
          part === 'request'
            ? ''
            : foldedTurn !== undefined
              ? // foldedTurn の回は `lastReportAt` の欄ごと出さない: 畳まれる前の別のターンの受信時刻で、いま読んでいる本文の齢に見えるため
                ` — いまの status: \`${found.status}\``
              : // 文言に「直近の報告」を含めない: 見出しを「直近のターンの中身」へ切り替えた回で混ざると、切り替えた意味が薄れるため
                ` — lastReportAt: ${found.lastReportAt ?? '一度も届いていない'} / いまの status: \`${found.status}\``;
        const head = `マネージャー ${managerId} の${label}（${describePage(part1)}）${reportAgeStatus}`;
        // foldedTurn の回はその材料で組む: `lastReportAt` / `lastReportStatus` は畳まれる前の別のターンの値で、そのまま渡すと無関係な drift を語るため
        const drift =
          part === 'request'
            ? ''
            : describeReportDrift({
                managerId,
                lastReportAt: foldedTurn !== undefined ? foldedTurn.at : found.lastReportAt,
                lastReportStatus: foldedTurn !== undefined ? 'stopped' : found.lastReportStatus,
                status: found.status,
                now: new Date(),
              });
        const driftNote = drift === '' ? '' : `${drift}\n\n`;
        // 失敗は本文の上に置く: 下だと包まれたエラー文を先に読んでから「実は報告ではない」と分かる順になるため。以下の注記も同じ順
        const failureNote = managerFailure === null ? '' : `${managerFailure}\n\n`;
        const usageStoppedNote = usageStopped === null ? '' : `${usageStopped}\n\n`;
        const runnerVanishedNote = runnerVanished === null ? '' : `${runnerVanished}\n\n`;
        const systemErrorNote = systemError === null ? '' : `${systemError}\n\n`;
        const cgroupEventsNote = cgroupEvents === null ? '' : `${cgroupEvents}\n\n`;
        const denialNote = denied === null ? '' : `${denied}\n\n`;
        const unobservedNote = unobserved === null ? '' : `${unobserved}\n\n`;
        const unpushedWorkNote = unpushedWork === null ? '' : `${unpushedWork}\n\n`;
        const withheldReportsFooterNote =
          withheldReportsNote === null ? '' : `${withheldReportsNote}\n\n`;
        const tail = part1.more
          ? `\n\n…（ここで切れている。続きは manager_report managerId=${managerId}` +
            `${part === 'request' ? ' part=request' : ''} offset=${part1.to}）`
          : '';
        // 切れていない場合にも次の一手を常に添える: ここに載る `lastReport` は報告の全文で、セッションの生ログではないため
        const footer =
          '\n\n（さらに掘るなら manager_transcript managerId=' + managerId + ' で生ログへ）';
        return text(
          `${head}\n\n${modelLine}\n\n${driftNote}${failureNote}${usageStoppedNote}${runnerVanishedNote}${systemErrorNote}${cgroupEventsNote}${denialNote}${unobservedNote}${unpushedWorkNote}${withheldReportsFooterNote}${part1.body}${tail}${footer}`,
        );
      },
    ),

    // 遡り切れていない窓で「無い」と言い切らない: 遡った件数と先頭に届いたかを必ず出す
    // いまのターンの会話そのものへは書かない: ターンの返答が届くので、道具で書くと同じ画面に返答が2通並ぶため
    tool(
      'conversation_post',
      [
        '人間の会話へ1通書く。いまのターンが人間の発言で起きたものでなくても届く（定期の仕事・外部イベント・委譲の報告を人間へ知らせる口）。',
        'conversationId を指定するとその会話へ、省略すると新しい会話を始めて、その id を返す。',
        '指定した conversationId の会話が無ければ、何も書かずに断る（その文字列で新しい会話は作らない。略記・前方一致では書かない）。',
        'いまのターンの会話へは書けない（そこへは普通に返答すれば届く）。',
        '人間へファイルを渡すなら、先に file_put で置き場へ入れ、その id を attachments に渡す（添付があれば text は空でもよい。どちらも空の発言は書かない）。',
        '添付の検査（存在・個数・合計の上限）に1つでも落ちたら、何も書かずに断る。',
        '日誌には人間との往復（あなたの発言）として残る。',
      ].join(' '),
      {
        text: z
          .string()
          .optional()
          .describe(
            `人間へ届ける本文（添付が無いとき必須。${formatStringLengthJa({ min: 1 })}。添付があれば省略か空でもよい）`,
          ),
        conversationId: z
          .string()
          .optional()
          .describe(
            `書く先の既存の会話 id（conversation_read の一覧で分かる完全な id。${formatStringLengthJa({ min: 1 })}）。省略すると新しい会話`,
          ),
        attachments: z
          .array(z.string().min(1))
          .optional()
          .describe(
            '添える添付の id（file_put の応答の id）。1発言に添えられる個数・合計には人間の発言と同じ上限がある。' +
              'どこにも結ばれていない添付は、この発言の会話へ結ばれる',
          ),
      },
      async ({ text: rawBody, conversationId, attachments: attachmentIds }) => {
        const withAttachments = attachmentIds !== undefined && attachmentIds.length > 0;
        if (!withAttachments) {
          if (rawBody === undefined) {
            return text('text か attachments のどちらかが要る（どちらも空の発言は書かない）。');
          }
          const textError = describeStringLengthViolation('text', rawBody, { min: 1 });
          if (textError !== null) return text(textError);
        }
        const body = rawBody ?? '';
        const conversationIdError = describeStringLengthViolation(
          'conversationId',
          conversationId,
          {
            min: 1,
          },
        );
        if (conversationIdError !== null) return text(conversationIdError);
        const current = getConversationId();
        if (conversationId !== undefined && conversationId === current) {
          return {
            ...text(
              `会話 ${conversationId} はいまのターンの会話なので、この道具では書かなかった。` +
                (withAttachments
                  ? 'このターンの返答に添付を添えるなら reply_attach を使う。'
                  : 'このターンの返答として書けば、その会話へ届く。'),
            ),
            isError: true,
          };
        }
        // 前方一致で読み替えない: 略記が別の会話にも当たるようになった日に、黙って別の会話へ書くため（conversation-lookup.ts）
        if (conversationId !== undefined) {
          const lookup = await lookupConversation(stores.journal, conversationId);
          if (!lookup.found) {
            return {
              ...text(
                `会話へは書かなかった。${describeMissingConversation(conversationId, lookup)}`,
              ),
              isError: true,
            };
          }
        }
        const target = conversationId ?? randomUUID();
        const attached = withAttachments
          ? await checkAndBindOutboundAttachments(stores, attachmentIds, {
              conversationId: target,
              limits: context.attachmentLimits ?? readAttachmentLimits().limits,
            })
          : ({ ok: true, refs: [], newlyBound: [] } satisfies OutboundAttachmentResult);
        if (!attached.ok) return text(`会話へは書かなかった。${attached.message}`);
        let entry;
        try {
          entry = await appendJournalOrThrow(
            'conversation_post',
            stores.journal,
            {
              type: 'exchange',
              with: 'human',
              role: 'outbound',
              text: body,
              conversationId: target,
              ...(attached.refs.length === 0 ? {} : { attachments: attached.refs }),
            },
            'act-not-performed',
          );
        } catch (error) {
          // 書けなかった発言に添付を結んだままにしない: 結んだままだと、掃除が未結び付けとして消す前に1時間ぶん居座る
          await releaseOutboundAttachments(stores, attached.newlyBound, target).catch(
            () => undefined,
          );
          throw error;
        }
        if (attached.refs.length === 0) context.postToConversation?.(target, body);
        else context.postToConversation?.(target, body, attached.refs);
        const withNote =
          attached.refs.length === 0 ? '' : `（添付 ${attached.refs.length} 件つき）`;
        return text(
          conversationId === undefined
            ? `新しい会話 ${target} を始めて書いた${withNote}（${entry.id}）。`
            : `会話 ${target} へ書いた${withNote}（${entry.id}）。`,
        );
      },
    ),

    tool(
      'file_put',
      [
        'あなたの手元（デーモンの側）のファイルを、添付の置き場へ入れる。人間へファイルを渡す最初の段で、',
        '返る id を reply_attach（いまのターンの返信に添える）か conversation_post の attachments（別の会話へ書く）に渡すと、人間の画面に添付として出る。',
        '返信に添えるまで、この添付はどこにも結ばれていないので **1時間で消える**。入れたらすぐ添えること。',
        '後で使うために取っておくなら keep: true で入れる（保存の印つき。期限なし・1時間の掃除にも掛からない。消えるのは file_delete したときだけ）。入れた後から付けるなら file_keep、置き場の一覧は file_list。',
        '通常のファイルだけ入れられる（ディレクトリ・特殊ファイルは断る）。大きさの上限は人間の添付と同じ（その他の上限を超えるものは読まずに断る）。画像の上限を超える画像は、画像ではなくファイル（application/octet-stream）として入れる（人間はダウンロードして開く）。',
        '画像は中身（先頭の印）が拡張子の種類と一致しないと断る。種類は拡張子から推す（分からなければ application/octet-stream）。',
        '**資格・鍵を含むファイルは入れない**: ALTEROID_CREDENTIAL_DIR の配下と、名前が _FILE で終わる環境変数が指すファイルは断る。',
        '人間に送ってよい内容かは、入れる前に自分で確かめること。',
      ].join(' '),
      {
        path: z.string().min(1).describe('入れるファイルの絶対パス（デーモンの側のファイル）'),
        name: z
          .string()
          .min(1)
          .optional()
          .describe('人間の画面に出す名前。省略するとファイル名。種類もこの名前の拡張子から推す'),
        keep: z
          .boolean()
          .optional()
          .describe(
            'true なら保存の印つきで入れる（期限なし・1時間の掃除にも掛からない）。既定 false',
          ),
      },
      async ({ path, name, keep }) => {
        const result = await putLocalFile(
          stores,
          { path, ...(name === undefined ? {} : { name }), ...(keep === true ? { keep } : {}) },
          { limits: context.attachmentLimits ?? readAttachmentLimits().limits, env: process.env },
        );
        if (!result.ok) return { ...text(result.message), isError: true };
        const { ref } = result;
        return text(
          `置き場へ入れた。id=${ref.id}\nname=${ref.name} type=${ref.mediaType} size=${ref.size} sha256=${ref.sha256}\n` +
            (result.note === undefined ? '' : `${result.note}\n`) +
            (keep === true
              ? '保存の印つきで入れた（期限なし・1時間の掃除にも掛からない。消すのは file_delete）。' +
                '人間へ渡すなら reply_attach か conversation_post の attachments に id を渡す。'
              : '会話に添える（reply_attach、または conversation_post の attachments）まで、この添付は1時間で消える。' +
                '取っておくなら file_keep id=<id> keep=true。'),
        );
      },
    ),

    tool(
      'file_list',
      [
        '添付の置き場の控えの一覧（新しい順）と、置き場の使用量（合計と出所ごと）を返す。**中身は読まない**（中身は attachment_fetch で取り出して Read で開ける）。',
        '1行に id・名前・種類・大きさ・出所・保存中か期限・作成日時が出る。',
        `絞り込み: kept（true＝保存中だけ・false＝保存していないものだけ）、from（${ATTACHMENT_FROM_CLASSES.join(' / ')}。上げた主体の分類）、conversationId、query（名前の部分一致）。`,
        '文字数の予算で締めるので、切れたら末尾に「続きは file_list cursor=…」が出る。その cursor を同じ絞り込みでそのまま渡すと続きが読める。',
        '期限切れで消えたものは出ない。保存した添付に期限も全体の容量の上限も無いので、使用量を見て要らないものは file_delete で消すこと。',
      ].join(' '),
      {
        kept: z.boolean().optional().describe('true＝保存中だけ・false＝保存していないものだけ'),
        from: z
          .enum(ATTACHMENT_FROM_CLASSES)
          .optional()
          .describe('上げた主体の分類（人間・クローン・マネージャー・連携の鍵・不明）'),
        conversationId: z.string().min(1).optional().describe('この会話に結ばれた添付だけ'),
        query: z.string().min(1).optional().describe('名前の部分一致（大文字小文字を問わない）'),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe('続きの位置。前回の応答の「続きは file_list cursor=…」をそのまま渡す'),
      },
      async ({ kept, from, conversationId, query, cursor }) => {
        try {
          return text(await listFiles(stores, { kept, from, conversationId, query, cursor }));
        } catch (error) {
          return text(
            `置き場の一覧を読めなかった: ${reasonOf(error)}（もう一度試すと直る場合がある）`,
          );
        }
      },
    ),

    tool(
      'file_keep',
      [
        '添付に保存の印を付ける／外す。保存中の添付は保持期限（既定30日）でも、未結び付け1時間の掃除でも消えない（期限なし。全体の容量の上限も無い）。',
        'keep: true で付ける。keep: false で外す（外した時刻から保持日数後に期限が入る。応答にいつ消えるかが出る）。',
        '無い id（期限切れで消えた・id の誤り）は「無い」と返る。',
        '人間が保存した添付の印も外せるが、人間の持ち物を変える行為なので、外すのは要らないと判断できるときだけ。この操作（道具の使用と id）は日誌に残る。',
      ].join(' '),
      {
        id: z.string().min(1).describe('添付の id（file_list / file_put の応答）'),
        keep: z.boolean().describe('true＝保存の印を付ける・false＝外す'),
      },
      async ({ id, keep }) => {
        try {
          return text(await keepFile(stores, id, keep, new Date()));
        } catch (error) {
          return text(
            `添付 ${id} の保存の印を変えられなかった: ${reasonOf(error)}（もう一度試すと直る場合がある）`,
          );
        }
      },
    ),

    tool(
      'file_delete',
      [
        '添付の中身と控えを消す。**保存の印が付いていても消える。取り戻せない。** 人間の持ち物でも消せるので、要らないと判断できるときだけ。',
        'その id を attachment_fetch で取り出した写しも消す。すでに会話へ添えた添付を消すと、画面の添付は開けなくなる。',
        '**消す前に**、その控え（id・名前・種類・大きさ・sha256・出所・保存中だったか。中身は書かない）を日誌へ書く。日誌に書けなければ何も消さない（やり直してよい）。',
        '無い id（期限切れで消えた・id の誤り）は「無い」と返り、日誌には何も書かない。',
      ].join(' '),
      {
        id: z.string().min(1).describe('消す添付の id（file_list / file_put の応答）'),
      },
      async ({ id }) => {
        try {
          return text(
            await deleteFile(
              stores,
              context.attachmentCopiesDir ?? fallbackAttachmentCopiesDir(),
              id,
              async (meta) => {
                // 消した後では名前も大きさも辿れないので、先に書く。書けなければ投げて、何も消さない（`act-not-performed`）
                await appendJournalOrThrow(
                  'file_delete',
                  stores.journal,
                  {
                    type: 'decision',
                    decision: `添付の中身と控えを消す: ${meta.name}（id=${meta.id}）`,
                    grounds: `消す前の控え: ${describeAttachmentForJournal(meta)}`,
                  },
                  'act-not-performed',
                );
              },
            ),
          );
        } catch (error) {
          if (error instanceof JournalNotRecordedError) throw error;
          return text(
            `添付 ${id} を消せなかった: ${reasonOf(error)}（もう一度試すと直る場合がある）`,
          );
        }
      },
    ),

    tool(
      'reply_attach',
      [
        '**いまのターンの返信**に添付を添える。人間の発言で起きたターン（会話のあるターン）で使い、返信の本文とは別に、画面の返信に添付が付く。',
        'ids は file_put の応答の id（または人間が添えた添付の id）。1件以上。',
        '同じターンで複数回呼んでも、個数・合計は合わせて数える（人間の1発言と同じ上限）。1つでも検査に落ちたら、何も添えずに、どれがなぜかを返す。',
        'どこにも結ばれていない添付はこの会話へ結ばれる。すでに別の会話に結ばれている添付は結び直さず、そのまま添える。',
        '本文が空で添付だけの返信でも、返信として残る。',
        'いまのターンに会話が無いとき（定期の仕事・外部イベントが起点で返信先が無い）は使えない。別の会話へ渡すなら conversation_post の attachments を使う。',
        '資格・鍵を含むファイルは添えないこと。',
      ].join(' '),
      {
        ids: z
          .array(z.string().min(1))
          .min(1)
          .describe('添える添付の id（file_put の応答の id）。1件以上'),
      },
      async ({ ids }) => {
        const conversationId = getConversationId();
        if (conversationId === undefined) {
          return {
            ...text(
              'いまのターンには返信先の会話が無いので、返信には添えられない（何も添えていない）。' +
                '人間へ渡すなら conversation_post の attachments に id を渡す。',
            ),
            isError: true,
          };
        }
        const slot = context.replyAttachments;
        if (slot === undefined) {
          return {
            ...text('この器では返信に添付を添えられない（何も添えていない）。'),
            isError: true,
          };
        }
        const attached = await checkAndBindOutboundAttachments(stores, ids, {
          conversationId,
          limits: context.attachmentLimits ?? readAttachmentLimits().limits,
          alreadyAttached: slot.current(),
        });
        if (!attached.ok) return { ...text(attached.message), isError: true };
        if (attached.refs.length === 0) {
          return text('指された添付はすでにこの返信に添えてある。');
        }
        slot.add(attached.refs);
        return text(
          `この返信に添付 ${attached.refs.length} 件を添えた: ` +
            attached.refs.map((ref) => `${ref.name}（id=${ref.id}）`).join(', ') +
            `。このターンの返信には合計 ${slot.current().length} 件ついている。`,
        );
      },
    ),

    tool(
      'attachment_fetch',
      [
        '人間が会話に添えた添付（画像・動画・PDF・ログなど）の中身を、デーモンの手元のファイルへ取り出す。',
        'id は発言の通知行（[添付] id=…）か conversation_read の [添付 n件] にある。',
        '返るパスを **Read で開ける**（クローンの作業ディレクトリの中に置く）。動画は置いて取り出せるところまで（コマ切り出しはしない）。',
        '同じ中身（sha256 が同じ）の写しが既にあれば書き直さず使い回す。',
        '**取り出したものは写し**で、正本ではない。器が作り直される・一定時間（24時間）たつと消えうる。必要なら再度取り出す。',
        '添付は保持期限（既定30日）を過ぎる・未結び付けのまま1時間たつと消える。そのときは「見つからない」と返る。',
        '**中身は記憶にも日誌にも写さない**（日誌に残るのは道具の使用の記録だけ）。要る事実は自分の言葉で記憶へ書く。',
      ].join(' '),
      {
        id: z.string().min(1).describe('添付の id（通知行の id=… / conversation_read の添付行）'),
      },
      async ({ id }) => {
        try {
          const result = await fetchAttachmentCopy(
            stores,
            context.attachmentCopiesDir ?? fallbackAttachmentCopiesDir(),
            id,
          );
          if (!result.ok) {
            return text(
              result.reason === 'not_found'
                ? `添付 ${id} は見つからない（保持期限が過ぎて消えた、または id の誤り）。人間に再送を頼む。`
                : result.reason === 'mismatch'
                  ? `添付 ${id} は取り出せなかった（置き場から読んだ中身が、控えの大きさか sha256 と合わない。途中で切れたか壊れている。写しは残していない。もう一度試すと直る場合がある）。`
                  : `添付 ${id} は取り出せない（置き場が返した id か名前が、置き場所の外へ出る形だった）。`,
            );
          }
          const { copy } = result;
          return text(
            `添付 ${id} を取り出した${copy.reused ? '（既にあった写しを使い回した）' : ''}。` +
              `Read で開ける。\npath=${copy.path}\nname=${copy.name} type=${copy.mediaType} ` +
              `size=${copy.size} sha256=${copy.sha256}`,
          );
        } catch (error) {
          return text(
            `添付 ${id} を取り出せなかった: ${reasonOf(error)}（もう一度試すと直る場合がある）`,
          );
        }
      },
    ),

    tool(
      'conversation_read',
      [
        '人間との会話を日誌から読み返す。要約に潰された後でも逐語はここに残っている。',
        'conversationId を指定するとその会話の中身を古い順に読める。',
        'q だけを指定すると窓の中を語で探す（新しい順）。',
        '何も指定しなければ会話の一覧（新しい順）。',
        '一覧が limit・文字数の予算・scan の窓で切れたら、末尾に「続きを読むには: conversation_read cursor=…」が出るので、' +
          'その cursor をそのまま渡すと続き（limit の上限 200 や窓の外も含む）から読める。続きが無ければ出ない。' +
          'GET /conversations（人間の口）と同じ cursor である。',
        '人間自身の発言だけを見るなら speaker: "human" を指定する',
        '（既定 both は人間とクローンの両方の発言を含む）。',
        '一覧の本文は抜粋で、全文が要る1件は id を渡して取る。',
        '人間は送信済みの発言を編集できる（チャットの「メッセージを編集する」機能）。' +
          'conversationId を指定した既定の応答は編集後の版だけを返すが、畳まれた版が' +
          '在れば件数を注記する。旧版と旧版への応答も読むには includeSuperseded: true を指定する。',
        '**ここに出ないもの**（知らずに引くと「無かった」と読むので、先に言う）:',
        '① **ask_human への人間の回答は、この道具では出ない。**',
        '回答の本文は日誌の escalation にしか無いので journal_read types=["escalation"] で読むこと',
        '（approvals_list の一覧モードは**まだ答えが来ていない件**だけを出すが、id を渡す全文モードは答えが付いた件も開けて、回答の本文もそこに出る）。',
        '② 人間がマネージャーへ直接話しかけた発言も出ない',
        '（日誌には with:"manager" として載り、あなた自身の指示と見分けが付かない）。',
        '**ここに出るもの**: 発言に添付があれば「[添付 n件]」と各添付の id・name・type・size（メタデータだけ）。',
        '**添付の中身はここには出ない**（画像は届いたターンでだけ画像として渡される）。',
        '画像・動画・PDF・ログなど**どの添付も、attachment_fetch id=<添付の id> で手元に取り出して Read で開ける**（動画は置いて取り出せるところまで）。',
      ].join(' '),
      {
        conversationId: z
          .string()
          .optional()
          .describe('この会話の中身を古い順に読む（一覧に出ている conversationId）'),
        q: z
          .string()
          .optional()
          .describe('語で探す（大文字小文字を区別しない部分一致）。conversationId と併用できる'),
        speaker: z
          .enum(['human', 'clone', 'both'])
          .optional()
          .describe('既定 both。human で人間自身の発言だけ（clone はクローンの返答だけ）'),
        since: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以降だけ返す（例 2026-08-15T09:00:00Z）'),
        until: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以前だけ返す。過去を掘るときはこれを指定する'),
        scan: z
          .number()
          .optional()
          .describe(
            `人間との往復を何件遡るか（${formatIntRangeJa({ min: 1, max: 10_000 })}。既定 2000。マネージャーとの往復・内部ターンは` +
              '数えない。issue #418）。遡り切れたかは応答の注記で分かる',
          ),
        limit: z
          .number()
          .optional()
          .describe(
            `一覧モードで返す会話の本数（${formatIntRangeJa({ min: 1, max: 200 })}。既定 20）。conversationId / q のときは効かない`,
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            '一覧モードの続きを読む位置。前回の応答の末尾「続きを読むには」に出た cursor をそのまま渡す' +
              '（自分で組み立てない。GET /conversations の nextCursor と同じもの）。' +
              '同じ since / until を付けて呼ぶこと。conversationId / q のときは効かない',
          ),
        id: z
          .string()
          .optional()
          .describe('この発言1件を全文で読む（一覧に出ている id）。他の条件は無視される'),
        offset: z
          .number()
          .optional()
          .describe(`id で全文を読むとき、何文字目から読むか（${formatIntRangeJa({ min: 0 })}）`),
        includeSuperseded: z
          .boolean()
          .optional()
          .describe(
            '既定 false。true にすると、チャットで編集され既定ビューから畳まれた旧発言・' +
              'それに対する応答も conversationId のときに含めて返す（各発言に supersedes / ' +
              'supersededBy が付く）。false のままでも、畳まれた版が在れば件数を注記する',
          ),
      },
      async ({
        conversationId,
        q,
        speaker = 'both',
        since: sinceInput,
        until: untilInput,
        scan,
        limit,
        cursor: cursorInput,
        id,
        offset = 0,
        includeSuperseded = false,
      }) => {
        const scanError = describeIntRangeViolation('scan', scan, { min: 1, max: 10_000 });
        if (scanError !== null) return text(scanError);
        const limitError = describeIntRangeViolation('limit', limit, { min: 1, max: 200 });
        if (limitError !== null) return text(limitError);
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        if (id !== undefined) {
          let entry: JournalEntry | null;
          try {
            entry = await stores.journal.get(id);
          } catch (error) {
            if (error instanceof UnreadableJournalEntryError)
              return text(describeUnreadableJournalEntry('発言', id));
            throw error;
          }
          if (!entry) return text(`発言 ${id} は無い（id が違うか、まだ書かれていない）。`);
          if (entry.type !== 'exchange' || entry.with !== 'human') {
            return text(
              `${id} は会話の発言ではない。日誌の中身を見るなら journal_read id=${id} を使うこと。`,
            );
          }
          const part = page(entry.text, offset, CONVERSATION_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは conversation_read id=${entry.id} offset=${part.to}）`
            : '';
          return text(
            `${entry.at} [${roleLabel(entry.role)}] id=${entry.id}（${describePage(part)}）` +
              `\n\n${part.body}${tail}${attachmentLines(entry.attachments, '')}`,
          );
        }

        // since/until を正規化する: `journal_read` と同じ穴を持つため
        if (sinceInput !== undefined && normalizeJournalTimeBoundary(sinceInput) === null) {
          return text(
            describeUnreadableJournalTimeBoundary('since', sinceInput) + '**会話は読んでいない。**',
          );
        }
        if (untilInput !== undefined && normalizeJournalTimeBoundary(untilInput) === null) {
          return text(
            describeUnreadableJournalTimeBoundary('until', untilInput) + '**会話は読んでいない。**',
          );
        }
        const since =
          sinceInput === undefined
            ? undefined
            : (normalizeJournalTimeBoundary(sinceInput) ?? undefined);
        const until =
          untilInput === undefined
            ? undefined
            : (normalizeJournalTimeBoundary(untilInput) ?? undefined);

        const scanLimit = scan ?? 2000;
        const listMode = conversationId === undefined && q === undefined;
        let cursor: ConversationCursor | undefined;
        if (listMode && cursorInput !== undefined) {
          const decoded = decodeConversationCursor(cursorInput);
          if (decoded === null) {
            return text(
              'cursor が壊れている（この道具か GET /conversations が返したものではないか、書き換えられている）。' +
                'cursor は前回の応答の「続きを読むには」に出たものをそのまま渡すこと（自分で組み立てない）。' +
                '先頭から読み直すなら cursor を省いて呼ぶこと。**会話は読んでいない。**',
            );
          }
          cursor = decoded;
        }
        let listPage: ConversationPage | undefined;
        let entries: Awaited<ReturnType<typeof readConversationWindow>> = [];
        // 窓の組み立ては `readConversationWindow` 1か所に閉じる: 手組みし直すたびに `with` を絞り忘れる余地が生まれるため
        if (listMode) {
          try {
            listPage = await readConversationPage(stores.journal, {
              limit: limit ?? 20,
              scan: scanLimit,
              ...(cursor === undefined ? {} : { cursor }),
              ...(since === undefined ? {} : { since }),
              ...(until === undefined ? {} : { until }),
            });
          } catch (error) {
            // 継続点が指す発言が見当たらないのは「判定できない」: 黙って先頭から返さない
            if (error instanceof InvalidConversationCursorError) {
              return text(
                `cursor が使えない（${error.message}。別の日誌のものか、書き換えられている）。` +
                  '先頭から読み直すなら cursor を省いて呼ぶこと。**会話は読んでいない。**',
              );
            }
            throw error;
          }
        } else {
          entries = await readConversationWindow(stores.journal, {
            scan: scanLimit,
            ...(since === undefined ? {} : { since }),
            ...(until === undefined ? {} : { until }),
          });
        }
        const scannedCount = listPage === undefined ? entries.length : listPage.scanned;
        // `since` を渡されたら「先頭に届いた」と言わない: `reachedStart` は行を出し切ったかだけで、`since` は LIMIT より先に効くため、混ぜると `since` より古い側に在りうるものを「無い」と言い切る
        const exhausted = reachedStart(scannedCount, scanLimit);
        const reached = exhausted && since === undefined;
        const scanNote =
          `（人間との往復を ${scannedCount} 件遡った。` +
          (reached
            ? '先頭に届いている）'
            : exhausted
              ? `since=${since} より新しい範囲は出し切ったが、それより古い側は見ていない。` +
                'since を外すか古い方へずらすこと）'
              : listMode
                ? 'この窓より古いものは見ていない。続きは「続きを読むには」の cursor で読める）'
                : 'この窓より古いものは見ていない。scan を増やすか until で窓をずらすこと）');
        const cursorIgnoredNote =
          !listMode && cursorInput !== undefined
            ? [
                '（cursor は会話の一覧のときだけ効く。conversationId / q のときは使っていない。' +
                  '古い側は until で窓をずらすこと）',
              ]
            : [];

        // 畳み込みの正本（`conversationMessages`）を経由する: 畳み込み規則を持つのを `conversation.ts` の1か所だけにするため
        // 常に `includeSuperseded: true` で1回だけ呼ぶ: 既定ビューでも畳まれた版の件数を数える必要があり、出ないとクローンは畳まれた版の存在に気づけないため
        if (conversationId !== undefined) {
          const allMessages = conversationMessages(entries, conversationId, {
            includeSuperseded: true,
          });
          const supersededCount = allMessages.filter(
            (message) => message.supersededBy !== undefined,
          ).length;
          const visible = includeSuperseded
            ? allMessages
            : allMessages.filter((message) => message.supersededBy === undefined);
          const speakerFiltered =
            speaker === 'both'
              ? visible
              : visible.filter(
                  (message) => message.role === (speaker === 'human' ? 'inbound' : 'outbound'),
                );
          const needle = q?.toLowerCase();
          const matched =
            needle === undefined
              ? speakerFiltered
              : speakerFiltered.filter((message) => message.text.toLowerCase().includes(needle));
          if (matched.length === 0) {
            return text(
              (reached
                ? `会話 ${conversationId} に当たる発言は無い。`
                : `会話 ${conversationId} は、この窓には無い（判定できない）。`) + `\n${scanNote}`,
            );
          }
          const lines = matched.map(
            (message) =>
              `${message.at} [${roleLabel(message.role)}] id=${message.id}` +
              (message.supersededBy === undefined
                ? ''
                : `（畳み込み済み。編集後は id=${message.supersededBy}）`) +
              `\n  ${excerptLine(message.text, CONVERSATION_EXCHANGE_EXCERPT)}` +
              attachmentLines(message.attachments, '  '),
          );
          // 会話は新しい側から積む: 予算で切るとき落とすのは古い側にし、会話を開く動機である直近の続きを残すため
          // 畳み込みの注記は予算の断り書きとは別の行にする: 「予算で切った」と「畳み込みで意図的に隠した」は別の事実のため
          const supersededNote =
            supersededCount === 0
              ? undefined
              : includeSuperseded
                ? `（この会話には畳まれた版が ${supersededCount} 件あり、includeSuperseded=true ` +
                  'なので含めて表示している）'
                : `（この会話には畳まれた版が ${supersededCount} 件ある。読むには ` +
                  `conversation_read conversationId=${conversationId} includeSuperseded=true を指定する）`;
          return text(
            [
              renderListingFromEnd(lines, {
                budget: CONVERSATION_LIST_BUDGET,
                // どちら側を落としたかを言う: 「N 件省略」だけだと続きの取り方を間違えるため
                omitted: ({ rest, shown, total }) =>
                  `…この会話の**古い側** ${rest} 件は省略（この窓に ${total} 件あり、` +
                  `新しい側から ${shown} 件だけ出した）。古い側を見るには until で窓を古い方へずらすこと。`,
              }),
              '（本文は抜粋。全文は conversation_read id=<id> で取れる）',
              ...(supersededNote === undefined ? [] : [supersededNote]),
              ...cursorIgnoredNote,
              scanNote,
            ].join('\n'),
          );
        }

        if (q !== undefined) {
          const exchanges = bySpeaker(humanExchanges(entries), speaker);
          const matched = searchExchanges(exchanges, q);
          if (matched.length === 0) {
            return text(
              (reached
                ? `"${q}" に当たる発言は無い。`
                : `"${q}" は、この窓には無い（判定できない）。`) + `\n${scanNote}`,
            );
          }
          const lines = matched.map(
            (message) =>
              `${message.at} [${roleLabel(message.role)}] id=${message.id}` +
              ` conversation=${message.conversationId ?? '(無し)'}\n` +
              `  ${excerptLine(message.text, CONVERSATION_EXCHANGE_EXCERPT)}` +
              attachmentLines(message.attachments, '  '),
          );
          return text(
            [
              renderListing(lines, {
                budget: CONVERSATION_LIST_BUDGET,
                omitted: ({ rest, shown, total }) =>
                  `…ほか ${rest} 件は省略（"${q}" に ${total} 件当たり、新しい順に ${shown} 件だけ出した）。` +
                  '省いたのは**古い側**である。scan を増やしても出てこない（当たりが増えるだけで、' +
                  '切られる側は変わらない）ので、until で窓を古い方へずらすこと。',
              }),
              '（本文は抜粋。全文は conversation_read id=<id> で取れる）',
              ...cursorIgnoredNote,
              scanNote,
            ].join('\n'),
          );
        }

        // `speaker` が効かないことを黙らない: 無視するのが正しいが、渡した側から見ると絞れた一覧に見えるため、使わなかったならそう言う
        // `limit` で落ちた分も数に入れる: `slice` の後の件数だけだと、`limit` で消えた分が出力のどこにも現れず、日誌の先頭に届いていると読める応答のまま消えるため
        const listing = listPage as ConversationPage;
        const listLimit = limit ?? 20;
        const conversations = listing.conversations;
        const hiddenByLimit = listing.hiddenByLimit;
        const windowTotal = conversations.length + hiddenByLimit;
        // 渡した絞りは続きの呼びにも付ける: 付け忘れると窓が変わるため
        const continuation = (resume: ConversationCursor | null): string[] => {
          if (resume === null) return [];
          const args = [
            `cursor=${encodeConversationCursor(resume)}`,
            ...(sinceInput === undefined ? [] : [`since=${sinceInput}`]),
            ...(untilInput === undefined ? [] : [`until=${untilInput}`]),
            ...(scan === undefined ? [] : [`scan=${scan}`]),
            ...(limit === undefined ? [] : [`limit=${limit}`]),
          ];
          return [
            `続きを読むには: conversation_read ${args.join(' ')}` +
              '（limit の上限や窓の外もこれで辿れる。続きが無くなれば、この行は出ない）',
          ];
        };
        if (conversations.length === 0) {
          const emptyNote = !reached
            ? 'この窓には無い（判定できない）。'
            : cursor === undefined
              ? '会話はまだ無い。'
              : 'この cursor より古い会話は無い。';
          return text([emptyNote, ...continuation(listing.next), scanNote].join('\n'));
        }
        const lines = conversations.map(
          (conversation) =>
            `${conversation.conversationId} ${conversation.startedAt}〜${conversation.updatedAt}` +
            `（${conversation.messages} 件）\n  ${conversation.preview}`,
        );
        // どちらの段で切れたかで勧める手を変える: 混ぜると効かない手（予算で切れているのに「limit を増やせ」など）を案内することになるため
        let cutByBudget = false;
        let shownByBudget = conversations.length;
        const body = renderListing(lines, {
          budget: CONVERSATION_LIST_BUDGET,
          // 予算が縛っているときは `limit` で落ちた分も合わせて「古い側」として1つの数で言う: `limit` を増やしても省略へ回るだけのため
          omitted: ({ rest, shown }) => {
            cutByBudget = true;
            shownByBudget = shown;
            return (
              `…ほか ${rest + hiddenByLimit} 件は省略（この窓に ${windowTotal} 件あり、` +
              `新しい順に ${shown} 件だけ出した）。` +
              '省いたのは**古い側**である。limit を増やしても出てこない（予算のほうで切れているので、' +
              '増やした分がそのまま省略へ回る）。続きは下の cursor で読むこと。'
            );
          },
        });
        const notes: string[] = [];
        if (!cutByBudget && hiddenByLimit > 0) {
          // 言い方は既存の一覧に寄せる（`…ほか N 件は省略`）: 新しい言い方を足すとその言い方も契約に入るため、予算の側との区別は語ではなく勧める手で分ける
          notes.push(
            `…ほか ${hiddenByLimit} 件は省略（この窓に ${windowTotal} 件あり、` +
              `新しい順に ${conversations.length} 件だけ出した）。` +
              '省いたのは**古い側**で、切ったのは limit=' +
              `${listLimit} である。予算にはまだ余りがあるので、limit を増やせば出る。`,
          );
        }
        const lastShown = conversations[shownByBudget - 1];
        const resume = cutByBudget
          ? ((lastShown === undefined
              ? undefined
              : listing.positions.get(lastShown.conversationId)) ?? listing.next)
          : listing.next;
        notes.push(...continuation(resume));
        notes.push('（各会話の中身は conversation_read conversationId=<id> で古い順に読める）');
        if (speaker !== 'both') {
          notes.push(
            `（speaker=${speaker} はこの一覧には効いていない。会話が在るかどうかは誰が喋ったかで` +
              '変わらないので、一覧は絞らずに出している。話者で絞るのは conversationId か q の' +
              'ときである）',
          );
        }
        notes.push(scanNote);
        return text([body, ...notes].join('\n'));
      },
    ),

    // `manager_report` に `part: 'transcript'` を足さない: 「無い」の意味が違い、大きさの桁も違い、1つの説明文に2つの契約を載せると読む側がどちらの「無い」を見ているか分からなくなるため
    tool(
      'manager_transcript',
      [
        'マネージャーのセッションそのものの生ログを読む（JSONL、1行1イベント）。',
        'manager_report の報告は要約された最終報告でしかない——それでも足りないとき、',
        '実際に何が起きたか（どの道具をどう呼んだか等）を確かめるにはここまで降りる。',
        '走行中なら runner のディスクから、畳まれていれば退避済みアーカイブから、',
        'それも無ければ預かったセッションの生ログから返る（3段のどこかにあれば返る）。',
        '長ければ続きの取り方が末尾に出るので、最後まで読み切ること。',
        '大きな生ログを何百ページもめくらずに探せるよう、絞りを4つ渡せる',
        '（どれも省略できる。1つも渡さなければ出力は絞らないときと1文字も',
        '変わらない）——since/until（ISO 8601。各行の timestamp 欄がこの窓に',
        '入る行だけ残す。since は含む・until は含まない）、type（行の type 欄。',
        'カンマ区切りで複数指定できる）、contains（行の生の文字列の部分一致。',
        '例 contains=\'"stop_reason":"tool_use"\'。JSON として読めない行にも',
        '掛かる）。絞ったときは先頭に「全X行のうちY行が当たった」を出し、',
        '時刻の窓を渡したときは timestamp の無い行・JSON として読めない行を',
        '（窓の判定ができないので）除いた数も出す——黙って捨てない。',
      ].join(' '),
      {
        managerId: z.string().describe('manager_list に出ている id'),
        offset: z
          .number()
          .optional()
          .describe(
            `何文字目から読むか（${formatIntRangeJa({ min: 0 })}）。前回の応答が示した続きの位置を渡す`,
          ),
        since: z
          .string()
          .optional()
          .describe(
            '絞り: ISO 8601。各行の timestamp 欄がこの時刻以降（含む）の行だけ残す' +
              '（例 2026-08-15T09:00:00Z）。until と組み合わせて窓を作る',
          ),
        until: z
          .string()
          .optional()
          .describe('絞り: ISO 8601。timestamp 欄がこの時刻より前（含まない）の行だけ残す'),
        type: z
          .string()
          .optional()
          .describe(
            '絞り: 行の type 欄で絞る。カンマ区切りで複数指定できる（例 assistant,result）',
          ),
        contains: z
          .string()
          .optional()
          .describe(
            '絞り: 行の生の文字列にこの部分文字列を含む行だけ残す' +
              '（例 "stop_reason":"tool_use"）。JSON として読めない行にも掛かる',
          ),
      },
      async ({ managerId, offset = 0, since, until, type, contains }) => {
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        // since/until が読めるかはここで見る: 読めない値は生ログを読みに行く前に断るため
        if (since !== undefined && !isReadableJournalTimeBoundary(since)) {
          return text(describeUnreadableJournalTimeBoundary('since', since) + '生ログは絞れない。');
        }
        if (until !== undefined && !isReadableJournalTimeBoundary(until)) {
          return text(describeUnreadableJournalTimeBoundary('until', until) + '生ログは絞れない。');
        }
        if (!context.managers) return NO_POOL;
        const result = await context.managers.transcript(managerId);
        if (result.kind === 'unreadable') {
          // 読めない行を「生ログは無い」と言わない
          return text(`${result.detail}生ログには降りていない。`);
        }
        if (result.kind === 'missing') {
          // `missing` が2つの意味を畳んでいることを隠さずそう書く: `ManagerPool.transcript()` が区別する値を返さないため
          return text(
            `マネージャー ${managerId} の生ログは無い。走行中の runner のディスク・` +
              '退避済みアーカイブ・預かったセッションの生ログ、3段のどこにも見当たらなかった。' +
              `（${managerId} という id 自体が台帳に無い場合と、id はあるが生ログが` +
              '一度も残らなかった場合のどちらも、この応答だけでは区別できない。' +
              'manager_list に出ているかで id の実在は別途確かめられる。）\n\n' +
              (await describeTranscriptMissingLeg(context.managers, managerId)),
          );
        }
        if (result.kind === 'removed') {
          // `missing` と同じ文面へ畳まない: 退避そのものは在ったが本文が落とされており、「どこにも無かった」ではなく「消された」ため
          return text(
            `マネージャー ${managerId} の生ログは退避されていたが、本文は消されている` +
              `（${result.removedAt} に ${result.bytes.toLocaleString('ja-JP')} バイトを落とした${describeArchiveRemovedBytesUnit()}。` +
              `archive id: ${result.archiveId}）。` +
              '走行中の runner のディスク・預かったセッションの生ログにも見当たらなかった。',
          );
        }

        const { body: rawBody, archiveId } = result;

        const hasFilter =
          since !== undefined ||
          until !== undefined ||
          type !== undefined ||
          contains !== undefined;
        let body = rawBody;
        let filterNote = '';
        if (hasFilter) {
          const types =
            type === undefined
              ? undefined
              : type
                  .split(',')
                  .map((t) => t.trim())
                  .filter((t) => t.length > 0);
          const filtered = filterTranscriptLines(rawBody, { since, until, types, contains });
          body = filtered.body;
          const { totalLines, matchedLines, noTimestampLines, unparsableLines } = filtered.counts;
          // 「全X行のうちY行が当たった」は0件でも出す: 黙って空の本文を返すと「絞りが効いていない」のか「本当に0件だった」のか区別できないため
          const noteLines = [`絞り込み: 全 ${totalLines} 行のうち ${matchedLines} 行が当たった。`];
          if (since !== undefined || until !== undefined) {
            // 窓を渡したときは除いた行数を0件でも出す: 黙って捨てると「窓の判定ができない行があった」という事実そのものが出力から消えるため
            noteLines.push(
              `（時刻の無い行 ${noTimestampLines} 行・読めない行 ${unparsableLines} 行は` +
                '窓の判定ができないので除いた）',
            );
          } else if (unparsableLines > 0) {
            noteLines.push(
              `（JSON として読めない行 ${unparsableLines} 行は type の判定ができないので除いた）`,
            );
          }
          filterNote = noteLines.join('\n') + '\n\n';
        }

        const part1 = page(body, offset, TRANSCRIPT_PAGE);
        const archiveNote =
          archiveId === undefined
            ? ''
            : `（archive id: ${archiveId}。archive_remove archiveId=${archiveId} で消せる）`;
        const head = `マネージャー ${managerId} の生ログ（${describePage(part1)}）${archiveNote}`;
        // 続きの取り方に今回渡した絞りの引数をそのまま付ける: 付けないと、続きを読んだ瞬間に絞りが外れて窓の外の行まで読めてしまうため
        const resumeFilterArgs = hasFilter
          ? [
              since !== undefined ? ` since=${since}` : '',
              until !== undefined ? ` until=${until}` : '',
              type !== undefined ? ` type=${type}` : '',
              contains !== undefined ? ` contains=${contains}` : '',
            ].join('')
          : '';
        const tail = part1.more
          ? `\n\n…（ここで切れている。続きは manager_transcript managerId=${managerId} offset=${part1.to}${resumeFilterArgs}）`
          : '';
        return text(`${filterNote}${head}\n\n${part1.body}${tail}`);
      },
    ),

    // 存在しない id を黙って成功にしない・本文は日誌へ写さない
    // 判定は `guardArchiveRemoval()` 1箇所だけを通す: 2箇所に書くと片方だけ直る形になるため。override したときは理由と走行中だったマネージャーの id を日誌へ残す（黙って通さない）
    tool(
      'archive_remove',
      [
        'アーカイブ済みセッション生ログの本文を1件消す（tombstone。行そのものは残る——',
        'archive の一覧には引き続き出る。DELETE ではない）。',
        '無い id を渡しても成功にはならず、そう返る。',
        '走行中のマネージャーの退避は既定では消せない（拒む。どのマネージャーが走行中かを言う）。',
        'それでも消す必要があるなら overrideReason にその理由を書く——渡すと通り、',
        '「override で消した」事実と理由が日誌に残る（黙って通る経路は無い）。',
        '消した事実は日誌に残る（archive id と直前のバイト数のみ。本文は残らない）。',
        'id は manager_transcript の応答に載る（「この本文を読んだ archive id」）——',
        '読んだ直後にそこから渡せる。',
      ].join(' '),
      {
        archiveId: z.string().describe('manager_transcript が出す archive id'),
        summary: z.string().describe('なぜ消したかの一行要約（日誌に残る。本文は残らない）'),
        overrideReason: z
          .string()
          .optional()
          .describe(
            '走行中のマネージャーの退避を、それでも消す理由。渡さなければ拒否される' +
              '（省略時は既定の拒否のまま）。渡すと「override で消した」として理由ごと日誌に残る。',
          ),
      },
      async ({ archiveId, summary, overrideReason }) => {
        const guard = guardArchiveRemoval(context.managers, archiveId, overrideReason);
        if (guard.kind === 'unknown') {
          return text(
            '消せない——いまは委譲の道具が配線されていない内部ターンで、走行中の' +
              'マネージャーがこの退避を使っているかどうかを確かめる材料が無い' +
              '（安全側に倒して拒む。#698）。',
          );
        }
        if (guard.kind === 'denied') {
          return text(
            `消せない——マネージャー ${guard.managerId} がいま走行中で、この退避を使っている` +
              '（走行中の委譲を追う最後の手段が消えるため。それでも消すなら overrideReason に' +
              '理由を書くこと。#698）。',
          );
        }
        const result = await stores.archive.remove(archiveId);
        if (result.kind === 'missing') {
          return text(`アーカイブ ${archiveId} は存在しない（消せない。何も変わっていない）。`);
        }
        if (result.kind === 'already') {
          return text(
            `アーカイブ ${archiveId} は前から消されている（${result.removedAt} に ` +
              `${result.bytes.toLocaleString('ja-JP')} バイトを落とした${describeArchiveRemovedBytesUnit()}）。何も変わっていない。`,
          );
        }
        const overrideNote =
          guard.kind === 'allowed-with-override'
            ? `（⚠️ override — 走行中のマネージャー ${guard.managerId} の退避だったが、` +
              `理由「${guard.reason}」により消した）`
            : '';
        await appendJournalOrThrow(
          'archive_remove',
          stores.journal,
          {
            type: 'decision',
            decision:
              `退避済み生ログの本文を消した: ${archiveId}（${result.bytes} バイト${describeArchiveRemovedBytesUnit()}）: ${summary}` +
              overrideNote,
            grounds:
              guard.kind === 'allowed-with-override' ? `${summary}／${overrideNote}` : summary,
          },
          'act-completed',
        );
        return text(
          `アーカイブ ${archiveId} の本文を消した（${result.bytes.toLocaleString('ja-JP')} バイト${describeArchiveRemovedBytesUnit()}）。` +
            `行そのものは残っている（list には引き続き出る）。${overrideNote}`,
        );
      },
    ),

    // `overrideReason` を持たない: 一括で複数件を無条件に開ける形は事故の芽が大きく、開ける口は単発の `archive_remove` に既に在るため（走行中の委譲が使っている行は一括の対象から外す）
    // `limit` / `requireContainment` は引数に持たない: 既定の安全側のまま使い、溢れた分は `remaining` として名乗る
    // 実行は `stores.archive.remove(id)` を1件ずつ: 一括 UPDATE にしない
    tool(
      'archive_remove_many',
      [
        'アーカイブ済みセッション生ログの本文を、絞り込んでまとめて消す（tombstone。',
        '行そのものは残る——archive の一覧には引き続き出る。DELETE ではない）。',
        '**既定は試算（dryRun を省略すると true）で、1件も消さない。**',
        'sessionIds / before / minStoredBytes のどれも渡さない呼びは断る——',
        '絞り込みが無いのと同じで、1回でアーカイブを空にできてしまう。',
        '3つは AND で効く（全部渡せば全部に当たった行だけが対象になる）。',
        'セッションの最新行・含有が証明できない行・墓標（まだ記憶へ蒸留していない区間）は',
        '既定で守る。',
        '走行中のマネージャーが使っている退避は一括では消せない（拒む。skipped.inUse に数える）——',
        'ここに override は無い。それでも消す必要があるなら、その id を manager_transcript の',
        '応答か、この道具の下見（dryRun）が返す対象一覧から見つけて、',
        'archive_remove（単発）に overrideReason を渡し1件ずつ名指しで消すこと。',
        '消した id は全部日誌に残る（塊に分けて書く。応答には先頭だけを出す）。',
      ].join(' '),
      {
        sessionIds: z
          .array(z.string())
          .optional()
          .describe(
            `対象セッションの完全一致（配列は${formatArrayLengthJa({ min: 1 })}、各要素は${formatStringLengthJa({ min: 1 })}）。省略すると全セッションが対象になりうる`,
          ),
        before: z
          .string()
          .optional()
          .describe(
            `この時刻より前（ISO8601、排他。${formatStringLengthJa({ min: 1 })}）に積まれた行だけを対象にする` +
              '（例 2026-09-15T00:00:00.000Z）',
          ),
        minStoredBytes: z
          .number()
          .optional()
          .describe(
            `storedBytes がこれ以上の行だけを対象にする（${formatIntRangeJa({ min: 0 })}）`,
          ),
        summary: z
          .string()
          .describe(
            `なぜ消したかの一行要約（日誌に残る。本文は残らない。${formatStringLengthJa({ min: 1 })}）`,
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            '省略すると true（何件当たるかを数えるだけで1件も消さない）。実際に消すときだけ false を明示する',
          ),
      },
      async ({ sessionIds, before, minStoredBytes, summary, dryRun }) => {
        const sessionIdsLengthError = describeArrayLengthViolation('sessionIds', sessionIds, {
          min: 1,
        });
        if (sessionIdsLengthError !== null) return text(sessionIdsLengthError);
        const sessionIdsElementError = describeStringArrayElementLengthViolation(
          'sessionIds',
          sessionIds,
        );
        if (sessionIdsElementError !== null) return text(sessionIdsElementError);
        const beforeLengthError = describeStringLengthViolation('before', before, { min: 1 });
        if (beforeLengthError !== null) return text(beforeLengthError);
        const summaryError =
          describeStringLengthViolation('summary', summary, { min: 1 }) ??
          describeBlankViolation('summary', summary);
        if (summaryError !== null) return text(summaryError);
        if (sessionIds === undefined && before === undefined && minStoredBytes === undefined) {
          return text(
            'sessionIds / before / minStoredBytes のどれも渡さない呼びは断る' +
              '——それは絞り込みが無いのと同じで、1回でアーカイブを空にできてしまう。' +
              '**1件も消していない。**',
          );
        }
        // 3段で検める: 存在しない日付や日付でない文字列を別の時刻として読んで消すため。元に戻せない一括削除なので時差も必須にする
        if (before !== undefined && !isOffsetQualifiedTimeBoundary(before)) {
          return text(
            describeOffsetRequiredTimeBoundary('before', before, '2026-09-15T00:00:00.000Z') +
              '**1件も消していない。**',
          );
        }
        const minStoredBytesError = describeIntRangeViolation('minStoredBytes', minStoredBytes, {
          min: 0,
        });
        if (minStoredBytesError !== null) return text(minStoredBytesError);

        // 墓標を守る
        const grave = await stores.sessions.getTranscriptGrave();
        const protectedIds: string[] = grave === null ? [] : [grave.archiveId];

        const filter: ArchiveRemoveManyFilter = {
          ...(sessionIds === undefined ? {} : { sessionIds }),
          ...(before === undefined ? {} : { before }),
          ...(minStoredBytes === undefined ? {} : { minStoredBytes }),
        };
        const filterText = [
          ...(sessionIds === undefined ? [] : [`sessionIds=[${sessionIds.join(', ')}]`]),
          ...(before === undefined ? [] : [`before=${before}`]),
          ...(minStoredBytes === undefined ? [] : [`minStoredBytes=${minStoredBytes}`]),
        ].join(' / ');

        // 絞りと選定は `selectArchiveRemovalTargets` に閉じる: ロジックを書き写すと片方だけ変えたとき黙って食い違うため
        const allRows = await stores.archive.list();
        const selection = selectArchiveRemovalTargets(allRows, filter, { protectedIds });
        const funnel = `アーカイブ全 ${selection.totalRows} 行 → 絞り込みで ${selection.matched} 件`;

        if (selection.matched === 0) {
          const why =
            selection.totalRows === 0
              ? 'アーカイブそのものに行が無い。**絞り込みの問題ではない**（消すべきものがそもそも無い）。'
              : '絞り込みに当たる行が0件——**絞り込みが外れている。**';
          return text(
            ['絞り込みに当たる行は0件だった。**1件も消していない。**', funnel, why].join('\n'),
          );
        }

        // `requireContainment` には常に `true` を渡す: 走行中の委譲の保護を `archiveIds` の末尾1本へ狭めないと、過去に積んだ写しが1本残らず保護され一括処理が1件も消せないため
        // この guard は `dryRun` の分岐より前で回す: 下見が返す `targeted` / `skipped.inUse` が実行時と食い違うため
        const removableTargets: ArchiveEntry[] = [];
        let skippedInUse = 0;
        for (const target of selection.targets) {
          const guard = guardArchiveRemoval(context.managers, target.id, undefined, true);
          if (guard.kind === 'denied' || guard.kind === 'unknown') {
            skippedInUse += 1;
            continue;
          }
          removableTargets.push(target);
        }
        // `targeted` は guard を通った後の件数にする: 飛ばした行を `skipped.inUse` と2回数えないため
        const targeted = removableTargets.length;

        const skippedLine =
          `skipped: protected(墓標) ${selection.skipped.protected} / ` +
          `alreadyRemoved ${selection.skipped.alreadyRemoved} / newest ${selection.skipped.newest} / ` +
          `notContained ${selection.skipped.notContained} / inUse(走行中) ${skippedInUse}`;
        const remainingLine = `remaining（limit に溢れて対象にすらならなかった件数）: ${selection.remaining}`;

        if (dryRun !== false) {
          // 省略された `dryRun` は試算にする: 消した本文を戻す道具が無いため
          const shown = removableTargets
            .slice(0, ARCHIVE_REMOVE_MANY_IDS_SHOWN)
            .map((row) => row.id);
          const hidden = removableTargets.length - shown.length;
          return text(
            [
              '**試算（dryRun）。1件も消していない。** 実際に消すには dryRun: false を渡すこと。',
              funnel,
              `絞り込み: ${filterText}`,
              `この呼びで消すのは ${targeted} 件（当たったのは ${selection.matched} 件。` +
                `1回の上限 ${ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT} 件）。`,
              skippedLine,
              remainingLine,
              `対象の id（先頭 ${shown.length} 件）: ${shown.join(', ')}${
                hidden > 0 ? ` …ほか ${hidden} 件は省略` : ''
              }`,
              ...(skippedInUse === 0
                ? []
                : [
                    '走行中のマネージャーが使っている行は一括では開けない（override は無い）。' +
                      '開けるなら archive_remove（単発）に overrideReason を渡して1件ずつ名指しすること。',
                  ]),
            ].join('\n'),
          );
        }

        // 塊ごとに「消す → その塊の id を日誌へ書く」を交互に回す: まとめて消してから日誌を書くと、デーモンが落ちたとき消えたのに記録が無い行ができるため
        const chunks = chunkIdsByChars(
          removableTargets.map((row) => row.id),
          ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
        );
        const removedIds: string[] = [];
        let removedBytes = 0;
        let raced = 0;
        // 「日誌に N 件」は実際に書いた件数で数える: `chunks.length` で言うと、塊が丸ごと競合になった回に無い日誌の行を名乗るため
        let journaledChunks = 0;
        for (const [index, chunk] of chunks.entries()) {
          const chunkIds = new Set(chunk);
          const chunkTargets = removableTargets.filter((row) => chunkIds.has(row.id));
          const removedThisChunk: string[] = [];
          for (const target of chunkTargets) {
            const result = await stores.archive.remove(target.id);
            if (result.kind === 'missing' || result.kind === 'already') {
              // 他経路が先に消していた回は `raced` へ数える（`already` も同じ競合）: この呼びが消したことにしない（触っていない id を応答・日誌に載せない）
              raced += 1;
              continue;
            }
            removedThisChunk.push(target.id);
            removedBytes += result.bytes;
          }
          removedIds.push(...removedThisChunk);
          if (removedThisChunk.length === 0) continue;

          journaledChunks += 1;
          await appendJournalOrThrow(
            'archive_remove_many',
            stores.journal,
            {
              type: 'decision',
              decision:
                `退避済み生ログの本文を絞り込みで一括して tombstone した` +
                `（${index + 1}/${chunks.length} 塊目、この塊は ${removedThisChunk.length} 件）: ${summary}\n` +
                `絞り込み: ${filterText}\n` +
                `消した id: ${removedThisChunk.join(' ')}`,
              grounds: summary,
            },
            'act-completed',
          );
        }

        const shownRemoved = removedIds.slice(0, ARCHIVE_REMOVE_MANY_IDS_SHOWN);
        const hiddenRemoved = removedIds.length - shownRemoved.length;
        return text(
          [
            `**${removedIds.length} 件の本文を tombstone した**（理由: ${summary}）。` +
              '行そのものは残っている（list には引き続き出る）。',
            funnel,
            `絞り込み: ${filterText}`,
            skippedLine,
            remainingLine,
            `消した本文の合計: ${removedBytes.toLocaleString('ja-JP')} バイト` +
              describeArchiveRemovedBytesUnit(),
            `消した id（先頭 ${shownRemoved.length} 件）: ${shownRemoved.join(', ')}${
              hiddenRemoved > 0
                ? ` …ほか ${hiddenRemoved} 件は省略（**全 id は日誌に ${journaledChunks} 件に分けて残してある**）`
                : ''
            }`,
            ...(raced === 0
              ? []
              : [
                  `⚠ 対象 ${targeted} 件のうち ${raced} 件は消せなかった` +
                    '（この呼びの最中に他の経路が先に消した）。',
                ]),
            ...(skippedInUse === 0
              ? []
              : [
                  '走行中のマネージャーが使っている行は一括では開けない（override は無い）。' +
                    '開けるなら archive_remove（単発）に overrideReason を渡して1件ずつ名指しすること。',
                ]),
          ].join('\n'),
        );
      },
    ),

    tool(
      'runner_list',
      [
        '委譲先の器（runner のコンテナ）がいくつあり、それぞれで何本のマネージャーが' +
          '走っているかを見る。manager_start の runnerId に渡す名前もここで分かる。',
        'peer の行は、その器のマネージャーが Codex などのもう一方の provider に作業を頼めること' +
          '（と名指しできるモデル）を示す。開いている peer が無い器には行が出ない。' +
          '「不明」は名乗らない旧い runner で、頼めないとは限らない。',
        'ここで数えている本数はデーモンの台帳から見た数である。新しいマネージャーを' +
          'どこへ置くか（資源による自動配置）の判断が使う本数は runner 自身が /health で' +
          '名乗る別の値で、この一覧とはずれうる——混ぜて配置の判断を予測しないこと。',
        'state は6値（connecting/connected/unreachable/unusable/lost/vacating）のまま出る。' +
          'unreachable（まだ開けていない）と lost（開けていたのに黙った）は別物である。' +
          'vacating は「意図して空けている最中」（drain）で、黙ったのではなく空けると決めた側である——' +
          'lost と同じく新しい委譲の置き先からは外れるが、走っていた仕事ごと黙ったわけではない。',
        '各器の「この状態になった」（since）は、その器がいまの state に変わった時刻である' +
          '（作成時刻・更新時刻ではない）。名簿（Registry）はインメモリで永続化するストアを' +
          '持たないので、デーモンを再起動すると名簿ごと作り直され、全 runner の since が' +
          '現在時刻へ巻き戻る——ずっと保持されている記録ではない。',
        // マネージャーの状態の字面は manager_list と揃える: 片方だけが「セッション切断」を出すと、同じ相手を2つの道具で見たクローンがどちらが本当かを判定できないため
        '器ごとの内訳に出るマネージャーの状態は manager_list と同じ字面である' +
          '（running / running/セッション切断 / running/セッション不明 / done/背景処理待ち×N）。' +
          '「背景処理待ち」は、そのマネージャーが自分で起こした背景処理や作業者の完了を待って' +
          '畳んだだけで、手が空いたのではないという意味である（器が名乗った分だけ出る——' +
          'この欄を送らない古い器では、待っていても出ない）。' +
          '「セッション切断」は、このデーモンがその委譲の宛先をいま開けていないという観測であって、' +
          '送っても届かないことの証明ではない（manager_send は resume を試みる）。' +
          '仕事が終わったという意味でもない。',
        'マネージャーの字面の直後に ⚠世代N≠現役M が付くことがある——この委譲が抱えている' +
          '認証トークンの世代（N）と、いまの現役の世代（M）が食い違っている（Issue #914）。' +
          '回した直後の短い遅れなら自然に消える。429 が続いたまま消えないなら起こし直すこと。' +
          `${STALE_TOKEN_RESTART_ADVICE}詳しい文面は manager_list に出る。` +
          '一致している・材料が無い（プールを使っていない構成）ときはこの印自体が出ない。',
        'デーモン自身の版と、各 runner が名乗った版（コミット sha）も出る。' +
          'デーモンと runner は別々にデプロイされるので、同じ main から起こしていても' +
          '別のコミットで走る窓がある——調べ物で「コードはこうなっている」と言う前に、' +
          'いま走っている版がその主張と同じかを見ること。',
        '版が「不明」（器が自分の版を知らない）と「未確認」（名乗りをまだ聞けていない）は' +
          '別物で、疑う先が違う（前者は器の設定、後者は登録とネットワーク）。' +
          'state が lost の器の版は黙る前に聞いた古い値である（#1949）。' +
          '鍵・プロファイル・MCP の登録の指紋（fingerprints: true）も、聞いていない' +
          '（繋がっていないので聞いていない）／聞いたが失敗した／聞いて0件・無しだった、' +
          'を同じ文言に潰さない——「確かめていない」と出たときは鍵が配られていない証拠には' +
          'ならず、「確かめられなかった」と出たときは配り直しでは直らないことがある' +
          '（器そのものに訊けなかった）。MCP の登録だけは、もう1つ「この runner は口を' +
          '持たない（古い版）」という状態も持つ——こちらは runner を上げないと直らない。',
        '「直近の押し込み」は、その器へプロファイル・環境変数・認証トークンを配る' +
          '（`#connectTo`/繋ぎ直しのたびに必ず試みる）処理が、直近どうだったかである。' +
          'state が connected でもこれが1つでも「失敗」なら、その種類はまだ古い値の' +
          'ままで走っている——manager_start する前にここを見て気づける。' +
          '「失敗」は自分から諦めずに挑み直すので、次に見たときには直っていることがある' +
          '（人間が手で繋ぎ直す必要は無い）。まだ一度も試みていない種類は行ごと出ない。',
        'resources: true を渡すと器ごとの pids（プロセス数）の現在値/上限も出る' +
          '（#315 案1）。**pids の現在値/上限そのものは今も器の合計である**——何が' +
          'その数を持っているかはこの2つの数字からは分からない。空き（上限 − ' +
          '現在値）も、次に何本置けるかを意味しない——実測では vitest が1本立ち' +
          '上がるだけで pids が +131 跳ねている。**対応している runner なら、' +
          'その合計の内訳（ゾンビ/生存の内訳・ゾンビの comm 別集計・いちばん古い' +
          'ゾンビの年齢）が別行で出る**（#315 の可視化）——対応していない runner' +
          '（古い版）ではこの内訳の行自体が出ない。pids が出ない器は、理由ごとに別の' +
          '文言で出る（#2426）——「確かめていない」（繋がっていないので聞いていない）・' +
          '「訊いたが失敗した: 理由」（resources() が落ちた）・「確かめられない」' +
          '（この runner は口を持たない古い版）・「訊けたが pids が読めない」' +
          '（cgroup を持たない器）。どれも数字が出ない点は同じだが、疑う先' +
          '（接続・器の RPC・runner の版・器の cgroup 構成）が違う。**そしてこの pids は、いまは配置の材料でもある**' +
          '（#712。点数は「メモリの余り × プロセス数の余り × 新しい1本が受け取る CPU」で、' +
          '最後の項の分母には抱えている本数に加えて直近に起動が失敗した本数も足す——' +
          '落ちて空いた器が「空いている」ように見えて次も吸い込む輪を切るため）——' +
          'pids が枯れた器は自動配置で選ばれにくくなる。**ただし断る材料ではない**——' +
          '枯れていても置き先としては返るので、「置けない」と読まないこと。' +
          '**加えて、新しいプロセスを起こせない器（pids 飽和）は、飽和していない器が1台でも' +
          '居れば自動配置の候補から外れる**（点数を見ずに後ろへ回る）。**全台が飽和なら断らず、' +
          'その中の最良を返す**（飽和は応答で分かる）。飽和の判定は構造化された値だけ——' +
          '現在値が上限に達している（resources: true のときだけ分かる・一瞬の値）、' +
          '直近5分に spawn が EAGAIN で失敗した、直近5分に fork が pids 上限で拒まれた委譲が' +
          '終わった。後ろ2つは resources を付けなくても、connected の器の行に' +
          '「pids 飽和: 新しい委譲を置けない（材料）」として出る。**この行が無いことは' +
          '「飽和ではない」を意味しない**（材料が無いだけ）。' +
          'manager_start で器を名指しした場合も断らず、飽和なら応答にこの行が付く。',
        'resources: true を渡した結果、いずれかの器の pids が逼迫していれば' +
          '（現在値が上限の80%以上）、その器に割り当てられた委譲のうち' +
          '「畳む候補」（manager_list の ⚠ と同じ5条件——done・背景処理待ちの印なし・' +
          '器がその印を送る版だと名乗っている・状態の判定が active・最後のターン終了から' +
          '一定時間経過）を、デーモンが自動で manager_stop 相当（非 force）で畳む' +
          '（#1394 段④⑥⑦）。**未 push の実装・未コミットの変更が1件でもある' +
          '（または確認できなかった）委譲は畳まない**——安全側に倒す。' +
          '何を畳んだ・見送ったかはこの応答の先頭に出て、日誌にも decision として残る' +
          '（journal_read）。**新しい周期処理ではない**——この道具をこの引数で呼んだ、' +
          'まさにこの1回の中だけで判定と実行が完結する。呼ばなければ何も起きない。',
      ].join(' '),
      {
        fingerprints: z
          .boolean()
          .optional()
          .describe(
            '鍵とプロファイルの指紋（sha256）まで出すか。既定は出さない——' +
              '要らないものを文脈へ載せない側に倒してある。人間は Web UI の設定画面で' +
              '常に見られるので、必要になったらここを true にして開くこと。',
          ),
        resources: z
          .boolean()
          .optional()
          .describe(
            '器ごとの pids（プロセス数）と、対応している runner ならその内訳' +
              '（ゾンビ/生存の内訳・ゾンビの comm 別集計・いちばん古いゾンビの年齢）を' +
              '出すか。既定は出さない——このためにネットワーク往復を足さない側に' +
              '倒してある。頼んだときだけ各 runner の /health を叩く（#315 の可視化）。',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            '続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す' +
              '（自分で組み立てない）。省略すると先頭から。',
          ),
      },
      async ({ fingerprints, resources, cursor }) => {
        if (!context.managers) return NO_POOL;
        const overview = await context.managers.runners({
          ...(fingerprints === undefined ? {} : { fingerprints }),
          ...(resources === undefined ? {} : { resources }),
        });
        // 自動畳みが走っていればどの return 経路でも必ず言う: 早い return でだけ黙ると、畳んだ・見送ったことがクローンに一度も届かない窓ができるため
        const autoFoldedNote =
          overview.autoFolded === undefined
            ? ''
            : overview.autoFolded.length === 0
              ? '\n（pids 逼迫を検出したが、この呼び出しでは畳む候補が無かった。#1394 段④⑥⑦）'
              : `\n⚠ この呼び出しで自動畳み（#1394 段④⑥⑦）が働いた:\n${overview.autoFolded
                  .map((entry) => `  - [${entry.managerId}] ${entry.outcome}: ${entry.detail}`)
                  .join('\n')}`;

        const resolved = resolveRunnerCursor(overview.runners, cursor);
        if (resolved.kind === 'malformed') {
          // 黙って先頭からへ倒さない
          return text(
            'この cursor は読めない（壊れているか、この道具のものではない）。' +
              'cursor は前回の応答の断り書きに出たものをそのまま渡すこと（自分で組み立てない）。' +
              '先頭から読み直すなら cursor を省いて呼ぶこと。' +
              autoFoldedNote,
          );
        }

        // デーモン自身の版は runner が0台でも出す: 0台のときに落とすと、配線がまだ無い状態（まさに版を確かめたい状態）でだけ答えが消えるため
        const daemonLine = `デーモン（あなた自身が居るプロセス）の版: ${describeRevisionStatus(
          overview.daemonRevision,
        )}`;

        if (overview.runners.length === 0) {
          return text(
            '登録されている runner は0台である（設定に ALTEROID_RUNNER_URLS 等が無いか、' +
              `まだ配線されていない）。\n${daemonLine}${autoFoldedNote}`,
          );
        }

        // cursor を渡されたときだけ「最後の頁」と言う: 名簿が0台のときの言い方を奪わないため
        if (cursor !== undefined && resolved.view.length === 0) {
          return text(
            `（cursor より後ろの器は無い。これが最後の頁）\n${daemonLine}${autoFoldedNote}`,
          );
        }

        const head: string[] = [
          // 1台のときにそう言う: 言わないと「分散していない」ことが読み取れず、複数台に散っていると誤読されうるため
          overview.runners.length === 1
            ? 'runner は1台のみ登録されている（分散していない）。'
            : `runner は${overview.runners.length}台登録されている。`,
          // デーモンと runner の版を同じ出力に並べる: 別々の口に出すと突き合わせ忘れがそのまま見逃しになり、2つの Service は別々にデプロイされてずれる窓が在るため
          daemonLine,
        ];
        // 先頭から出し直したことを黙って重複させない: 言わないと「進んでいない」のか「出し直した」のかが区別できないため
        if (resolved.restarted) {
          head.push(
            '⚠ 渡された cursor が指していた器は、いま名簿に居ない（登録から外れた）。' +
              'この並びは登録順で、そこから位置を割り出す手が無いので、**先頭から出し直した**' +
              '——既に見た器がもう一度出る。**1台も落としていない**（欠落より重複の側へ倒してある）。',
          );
        }

        // 器1台ぶんを1つのブロックにしてから予算で積む: 行ごとに積むと、予算に当たった器が途中の1行で切れて「版が無い器」に見えるため
        const blocks: string[] = [];
        for (const runner of resolved.view) {
          const lines: string[] = [];
          lines.push(
            `- ${runner.label} [${runner.state}]` +
              (runner.runnerId === undefined
                ? '（runnerId は未確定。まだ名乗っていない）'
                : ` runnerId=${runner.runnerId}`),
          );
          lines.push(`  この状態になった: ${runner.since}`);
          if (runner.workspacePath !== undefined)
            lines.push(`  workspace: ${runner.workspacePath}`);
          // 名乗らないことを黙らせない: 出さないと「入れ替わっていない」と「判定できない」が同じに見えるため
          lines.push(
            runner.instanceId === undefined
              ? '  応えているプロセス: 名乗っていない（この器では入れ替わりを判定できない）'
              : `  応えているプロセス: ${runner.instanceId}` +
                  (runner.instanceSince === undefined ? '' : `（${runner.instanceSince} から）`),
          );
          // 版は「どのプロセスか」の隣に置く: 別の問いに答える2つを並べないと片方でもう片方を推測することになり、state から遠いと `lost` の器の古い値が現役の版として読まれるため
          lines.push(`  版: ${describeRevisionStatus(runner.revision)}`);
          const peersLine = describeManagerPeers(runner.managerPeers);
          if (peersLine !== undefined) {
            lines.push(`  peer: ${excerptLine(peersLine, RUNNER_MANAGER_PEERS_EXCERPT)}`);
          }
          if (runner.error !== undefined) lines.push(`  直近の失敗: ${runner.error}`);
          // 材料が無い器には行を出さない: 「飽和ではない」と言わないため
          if (runner.pidsSaturation !== undefined) {
            lines.push(
              `  pids 飽和: 新しい委譲を置けない（${describePidsSaturation(runner.pidsSaturation)}）`,
            );
          }
          if (runner.managers.length === 0) {
            lines.push('  マネージャー: 無し');
          } else {
            const shown = runner.managers.slice(0, RUNNER_MANAGER_LIST_LIMIT);
            const rest = runner.managers.length - shown.length;
            lines.push(
              `  マネージャー(${runner.managers.length}): ` +
                // 字面は `describeManagerState` から取る: `m.status` をそのまま書くと「走行中」と「走行中だがセッション切断」がここでだけ潰れるため
                shown
                  .map(
                    (m) =>
                      `${m.managerId}[${describeManagerState(m.status, m.live, m.awaitingBackground)}]` +
                      runnerManagerTokenTag(m),
                  )
                  .join(', ') +
                (rest === 0 ? '' : `, …ほか ${rest} 本は省略（manager_list で全部見える）`),
            );
          }
          // 表示そのものを引数で二重に締める: どちらか片方が緩んでも既定で漏れないよう `fingerprints === true` のときしか出さない
          // 3状態（聞いていない／失敗／0件・無し）を同じ文言に潰さない
          if (fingerprints === true) {
            if (runner.credentialsProbe?.status === 'unheard') {
              lines.push('  鍵: 確かめていない（繋がっていないので聞いていない）');
            } else if (runner.credentialsProbe?.status === 'failed') {
              lines.push(`  鍵を確かめられなかった: ${runner.credentialsProbe.error}`);
            } else if (runner.credentials !== undefined) {
              lines.push(
                runner.credentials.length === 0
                  ? '  鍵: 無し'
                  : `  鍵の指紋: ${excerptLine(
                      runner.credentials.map((c) => `${c.name}=${c.sha256}`).join(', '),
                      RUNNER_CREDENTIAL_FINGERPRINT_EXCERPT,
                    )}`,
              );
            }
            if (runner.profileProbe?.status === 'unheard') {
              lines.push('  プロファイル: 確かめていない（繋がっていないので聞いていない）');
            } else if (runner.profileProbe?.status === 'failed') {
              lines.push(`  プロファイルを確かめられなかった: ${runner.profileProbe.error}`);
            } else if (runner.profile !== undefined) {
              lines.push(`  プロファイルの指紋: ${runner.profile.sha256}`);
            }
            // `unsupported` は `failed` とは別の文言で言う: 鍵を配り直せば直る故障と、runner を上げないと直らない故障を混ぜないため
            if (runner.mcpServersProbe?.status === 'unheard') {
              lines.push('  MCP の登録: 確かめていない（繋がっていないので聞いていない）');
            } else if (runner.mcpServersProbe?.status === 'unsupported') {
              lines.push('  MCP の登録: 確かめられない（この runner は口を持たない。古い版）');
            } else if (runner.mcpServersProbe?.status === 'failed') {
              lines.push(`  MCP の登録を確かめられなかった: ${runner.mcpServersProbe.error}`);
            } else if (runner.mcpServers !== undefined) {
              lines.push(
                `  MCP の登録: ${excerptLine(runner.mcpServers.names.join(', '), RUNNER_CREDENTIAL_FINGERPRINT_EXCERPT)}（指紋 ${runner.mcpServers.sha256}）`,
              );
            }
          }
          // `undefined` を「成功した」の既定値として埋めない: 3種類とも「まだ一度も試みていない」ことがあり、その種類だけ行を出さない
          if (runner.pushHealth !== undefined) {
            const outcomeText = (label: string, outcome: RunnerPushOutcome | undefined) =>
              outcome === undefined
                ? undefined
                : outcome.status === 'ok'
                  ? `${label} ok（${outcome.at}）`
                  : `${label} 失敗（${outcome.at}）: ${outcome.error ?? '理由不明'}`;
            const pushLines = [
              outcomeText('プロファイル', runner.pushHealth.profile),
              outcomeText('環境変数', runner.pushHealth.credentials),
              outcomeText('認証トークン', runner.pushHealth.agentToken),
              outcomeText('MCP の登録', runner.pushHealth.mcpServers),
              outcomeText('plugin', runner.pushHealth.plugins),
            ].filter((line): line is string => line !== undefined);
            if (pushLines.length > 0) {
              lines.push(`  直近の押し込み: ${pushLines.join(' / ')}`);
            }
          }
          // pids の3つの状態（読めた／訊けなかった／訊けたが読めない）を混ぜない: 疑う先が違うので同じ文言に倒さない
          // 「言えないこと」は器ごとに繰り返さず一覧の末尾に1度だけ出す: 台数ぶん並べると断りが本体を上回って読み飛ばされるため
          if (resources === true) {
            if (runner.resources === undefined) {
              const probe = runner.resourcesProbe;
              if (probe?.status === 'unheard') {
                lines.push('  pids: 確かめていない（繋がっていないので聞いていない）');
              } else if (probe?.status === 'failed') {
                lines.push(`  pids: 訊いたが失敗した: ${probe.error}`);
              } else if (probe?.status === 'unsupported') {
                lines.push('  pids: 確かめられない（この runner は口を持たない。古い版）');
              } else if (probe?.status === 'asked') {
                lines.push('  pids: 訊けたが、応答に資源が無かった');
              } else {
                lines.push('  pids: runner に訊けなかった（器が開いていない、または応答が無い）');
              }
            } else if (runner.resources.pids === undefined) {
              lines.push('  pids: 訊けたが読めない器だった（cgroup を持たない。ローカル開発など）');
            } else {
              const { current, max } = runner.resources.pids;
              lines.push(`  pids: ${current} / ${max}`);
              // `tasks` が無い runner ではこの行そのものを省く: 「0」でも「unknown」でもなく、3状態を新しく混ぜないため
              const { tasks } = runner.resources;
              if (tasks !== undefined) {
                const aliveThreads = tasks.threads - tasks.zombies;
                const aliveProcesses = tasks.processes - tasks.zombies;
                lines.push(
                  `    内訳: ゾンビ ${tasks.zombies} / 生存 ${aliveThreads}` +
                    `（${aliveProcesses}プロセス）`,
                );
                if (tasks.zombieCommands !== undefined && tasks.zombieCommands.length > 0) {
                  lines.push(
                    `    ゾンビの comm: ${tasks.zombieCommands
                      .map((entry) => `${entry.command} ${entry.count}`)
                      .join(', ')}`,
                  );
                }
                if (tasks.oldestZombieSeconds !== undefined) {
                  lines.push(
                    `    いちばん古いゾンビ: ${describeZombieAge(tasks.oldestZombieSeconds)}`,
                  );
                }
                // 欄が無い・走査が読めなかった回では行そのものを出さない: 「0本だった」と「数えられなかった」を混ぜないため。`pids` を同じ行に並べる: 返るはずの量と返る先の空きは組で読むため
                const { reclaim } = tasks;
                if (reclaim !== undefined) {
                  const age =
                    reclaim.oldestAgeSec === undefined
                      ? ''
                      : `（いちばん古い ${describeZombieAge(reclaim.oldestAgeSec)}）`;
                  const atScan =
                    reclaim.pidsAtScan === undefined
                      ? ''
                      : `、走査時 pids ${reclaim.pidsAtScan.current}/${reclaim.pidsAtScan.max}`;
                  const mode =
                    reclaim.mode === 'observe'
                      ? 'observe: 終端した委譲の木だけ畳む'
                      : '回収（既定）: 素性の分からない孤児も撃つ';
                  lines.push(
                    `    孤児（${mode}）: 候補 ${reclaim.candidates} 本 / ` +
                      `${reclaim.candidateThreads} threads${age}${atScan}` +
                      `、送出 ${reclaim.signalled} / 畳み ${reclaim.killed} / ` +
                      `返却 ${reclaim.freedThreads} threads`,
                  );
                  if (
                    reclaim.roots !== undefined &&
                    reclaim.largestTreeCandidates !== undefined &&
                    reclaim.singletonTrees !== undefined
                  ) {
                    lines.push(
                      `    孤児の木: ルート ${reclaim.roots} 本 / ` +
                        `いちばん大きい木 ${reclaim.largestTreeCandidates} 本 / ` +
                        `単独 ${reclaim.singletonTrees} 本`,
                    );
                  }
                  if (reclaim.medianAgeSec !== undefined && reclaim.ageBuckets !== undefined) {
                    const buckets = reclaim.ageBuckets
                      .map((bucket) => `${describeAgeBucketLabel(bucket.upToSec)} ${bucket.count}`)
                      .join(' / ');
                    lines.push(
                      `    孤児の齢（⚠ 起動から。孤児になってからではない）: ` +
                        `中央値 ${describeZombieAge(reclaim.medianAgeSec)} / ${buckets}`,
                    );
                  }
                  // 欄ごと無い回は 0 に潰さず行を出さない: 在る欄の0は「数えて0本だった」で、取れなかったのとは別のため
                  const { notFired } = reclaim;
                  if (notFired !== undefined) {
                    const { outsideRoots, held, observeOnly } = notFired;
                    const bySid =
                      outsideRoots.bySid === undefined
                        ? ''
                        : `。仮に孤児ルートに入っていたら: 撃つ ${outsideRoots.bySid.wouldFire} / ` +
                          `sid 不明 ${outsideRoots.bySid.sidUnknown} / ` +
                          `sid が live ${outsideRoots.bySid.sidLive} / ` +
                          `sid の長が残存 ${outsideRoots.bySid.sidLeaderPresent} / ` +
                          `sid 未認識 ${outsideRoots.bySid.sidUnrecognised}`;
                    lines.push(
                      `    孤児ルート外: ${outsideRoots.total}（うち親が生存 ` +
                        `${outsideRoots.parentInScan}。孤児ルートの部分木に入らず、撃つ判定に掛からない）` +
                        bySid,
                    );
                    if (held !== undefined) {
                      lines.push(
                        `    hold（候補のうち撃たなかった理由）: sid 不明 ${held.sidUnknown} / ` +
                          `sid が live ${held.sidLive} / sid の長が残存 ${held.sidLeaderPresent} / ` +
                          `sid 未認識 ${held.sidUnrecognised}`,
                      );
                    } else {
                      lines.push(
                        '    hold の内訳: この走査には判定材料（live / 終端済みの sid）が渡っていないので出せない',
                      );
                    }
                    if (observeOnly !== undefined) {
                      lines.push(
                        `    素性の分からない孤児（委譲が0本のとき sid を問わず撃つ形）で、reclaim でないので撃たなかった: ${observeOnly}`,
                      );
                    }
                  }
                }
              }
            }
          }
          blocks.push(lines.join('\n'));
        }

        const tail: string[] = [];
        if (autoFoldedNote !== '') tail.push(autoFoldedNote.trimStart());
        // 「この状態になった」の注記は器ごとに繰り返さず末尾に1度だけ添える: 名簿はインメモリで再起動すると `since` が巻き戻り、「ずっと保持されている記録」と誤読されないため
        tail.push(
          '「この状態になった」は名簿の値。名簿（Registry）はインメモリなので、' +
            'デーモンを再起動すると作り直される。',
        );
        // pids を出したなら、その数字が言えないことを必ず添える: 言えないことを書いていない計器は、読む側が言えると思い込むため
        if (resources === true) {
          tail.push(
            'pids について: **pids の現在値/上限そのものは今も器の合計であって内訳ではない。** ' +
              'この2つの数字だけからは、何がその数を持っているかは分からない。' +
              '**対応している runner なら、その内訳（ゾンビ/生存・ゾンビの comm 別・' +
              'いちばん古いゾンビの年齢）が器ごとのブロックに出る**（#315 の可視化。' +
              '対応していない runner——古い版——では内訳の行自体が出ない）。' +
              '**空き（上限 − 現在値）は「次に何本置けるか」を意味しない**——実測では ' +
              'vitest が1本立ち上がるだけで pids が +131 跳ねている。',
          );
        }
        if (overview.unassigned.length > 0) {
          const shown = overview.unassigned.slice(0, RUNNER_MANAGER_LIST_LIMIT);
          const rest = overview.unassigned.length - shown.length;
          tail.push(
            `どの器か分からない: ${overview.unassigned.length}件（` +
              shown
                .map(
                  (m) =>
                    `${m.managerId}[${describeManagerState(m.status, m.live, m.awaitingBackground)}]` +
                    runnerManagerTokenTag(m),
                )
                .join(', ') +
              (rest === 0 ? '' : `, …ほか ${rest} 本は省略（manager_list で全部見える）`) +
              '）。runnerId が記録されていない古いマネージャーで、どの器の内訳にも混ぜていない。',
          );
        }

        return text(
          [
            ...head,
            renderListing(blocks, {
              budget: RUNNER_LIST_BUDGET,
              omitted: ({ rest, shown }) => {
                // 母数は cursor を当てる前の全件: 頁が進んでも動かさないため
                const lastShown = resolved.view[shown - 1]!;
                return (
                  `…ほか ${rest} 台は省略（登録は ${overview.runners.length} 台あり、${shown} 台だけ出した）。` +
                  `続きは runner_list cursor=${encodeRunnerCursor({ label: lastShown.label })} で取れる。`
                );
              },
            }),
            ...tail,
          ].join('\n'),
        );
      },
    ),
  ];
}

// `status === 'lost'` を直に書かず `digest.ts` の述語から組み立てる: 書き下ろすと分け方が割れるため
// 2つの述語を1つに畳まない: `isManagerInFlight` へ `lost` を足すと日報の `MAX_ITEMS` の枠を食って最近終わった委譲が押し出される。
// 群の数はこの一覧の側の判断であって、述語の側の判断ではない
// 順位を数にする: `if` の連鎖だとどの2つの比較が抜けても「たまたま並ぶ」になるため
function managerAttentionRank(status: JobStatus): 0 | 1 | 2 {
  if (isManagerInFlight(status)) return 0;
  // `lost` は終端だが、その他の終端より先に出す: 確かめるまで終われず、窓から落ちると id が本文に出ず名指しもできないため
  if (isManagerAwaitingJudgement(status)) return 1;
  return 2;
}

// 判定は `digest.ts` の純関数から取る: `lastReport === undefined` を書き下ろすと分け方が字面の側と割れ、「順位は先頭なのに文は delivered と言う」形が黙って作れるため
function managerJudgementRank(entry: ManagerSummary): 0 | 1 | 2 {
  const outcome = classifyUnobservedOutcome(entry);
  return outcome === null ? JUDGEMENT_RANK_NOT_APPLICABLE : outcome.rank;
}

function managerPositionOf(entry: ManagerSummary): ManagerPosition {
  return {
    rank: managerAttentionRank(entry.status),
    judgementRank: managerJudgementRank(entry),
    startedAt: entry.startedAt,
    managerId: entry.managerId,
  };
}

// `ManagerPool.list()` 側を並べ替えて解かない: HTTP の窓の錨と `order` を足さないという判断があの並びに乗っているため
// 並び替えと cursor は `compareManagerPosition` を共有する: 別々に書くと片方だけがずれたときに黙って行が飛ぶため
function compareManagerAttention(a: ManagerSummary, b: ManagerSummary): number {
  return compareManagerPosition(managerPositionOf(a), managerPositionOf(b));
}

// 一覧を数えて答えさせない: 一覧は予算で打ち切られ、`status` だけを数えると上振れする（`running` は終端へ勝手には行かない）ため2軸で数える
// 0 の行は作らない: 「切断 0本」と書くと、観測して 0 だったのか数えていないのかが読めなくなるため、在るときだけ書く
// `usageStopped` を上の内訳へ足し合わせない: `status` と独立の横断する軸で、同じ委譲を2回数えることになるため
function describeManagerCounts(managers: readonly ManagerSummary[]): string {
  const live = managers.filter((m) => m.live).length;
  const parts = [`全 ${managers.length} 本`];
  // `m.status === 'running'` を直書きしない: 将来「実行中」を意味する新しい値が足されてもこの行の件数からだけ静かに漏れるため
  const running = managers.filter((m) => isRunningJobStatus(m.status));
  if (running.length > 0) {
    const reachable = running.filter((m) => m.live).length;
    parts.push(`走行中 ${running.length} 本（うち話しかけられる ${reachable} 本）`);
  }
  const orphaned = managers.filter((m) => m.runnerLostSince !== undefined).length;
  if (orphaned > 0) parts.push(`宛先の器が名乗らなくなった ${orphaned} 本`);
  // 「器が黙った」とは別の区分: 畳むと打つ手が変わるため（器の側を見るのか、送り直すのか）
  const sessionMissing = managers.filter((m) => m.sessionMissingSince !== undefined).length;
  if (sessionMissing > 0) parts.push(`runner にセッションが無い ${sessionMissing} 本`);
  const waiting = managers.filter((m) => m.status === 'waiting_human').length;
  if (waiting > 0) parts.push(`返事待ち ${waiting} 本`);
  // 判定は `digest.ts` の述語から取る: `status === 'lost'` を書き下ろすと `situation.ts` と分け方が割れるため
  const lost = managers.filter((m) => isManagerAwaitingJudgement(m.status)).length;
  if (lost > 0) parts.push(`戻れなかった(lost) ${lost} 本`);
  const usageStopped = managers.filter((m) => m.usageStoppedAt !== undefined).length;
  if (usageStopped > 0)
    parts.push(
      `枠(利用上限)で止まっている ${usageStopped} 本（横断する軸。他の区分とは足し合わせない）`,
    );
  // `runnerVanished` も横断する軸で、上の内訳には足し合わせない: `lost` の絞りでは拾えない集合を名指しするための別軸のため
  const runnerVanished = managers.filter((m) => m.runnerVanished !== undefined).length;
  if (runnerVanished > 0)
    parts.push(
      `宛先の runner が名簿から消えている ${runnerVanished} 本（横断する軸。他の区分とは足し合わせない）`,
    );
  return (
    `件数: ${parts.join(' / ')}。話しかけられる委譲は全体で ${live} 本である。` +
    '**「走行中」は「進んでいる」ではない** — 宛先の器が黙って消えても ' +
    'status は running のままで、それを終端へ動かす経路はデーモンに無い。' +
    'いま何本動いているかを数えるなら、走行中の本数ではなく' +
    '「話しかけられる」ほうを見ること。' +
    // `lost` が在るときだけ足す: 本数だけだと「終わった本数」と読まれ、`lost` は確かめるまで終われない側のため
    (lost === 0
      ? ''
      : ' **「戻れなかった(lost)」は「終わった」ではない** — 前のセッションへ戻れたかだけを' +
        '見ていて、成果が既に外へ出ていることがある（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）。' +
        'この一覧の本文は文字数の予算で切れるので、名指しで引くなら status: ["lost"] を渡すこと' +
        '（絞りは予算より前に効く）。' +
        // 残りへ辿る綴りは `lost` が在るときだけ置く: 「全部見た」と読みかけるときだけで、それぞれの行には既に ⚠ が付くため
        '**ただし lost を全部確かめても、落ちた委譲を全部見たことにはならない** — ' +
        '宛先の器が黙って消えた委譲は running のまま残り、直近のターンが失敗で終わった委譲は ' +
        'done のまま残る。前者は status: ["running"]、後者は status: ["done"] で引き、' +
        '行に付く ⚠ を見ること。' +
        RESTART_BEFORE_CHECK_ADVICE) +
    (usageStopped === 0
      ? ''
      : ' **「枠(利用上限)で止まっている」は status の分割ではなく横断する軸である** — ' +
        '走行中・返事待ち・戻れなかった(lost)・手が空いている（done）等のどれとも重なりうるので、' +
        '上の内訳には足し合わせない。名指しで絞る綴りは無い（`status` の値ではないため）——' +
        'この一覧の各行に付く注記（⚠ 枠(利用上限)で止まっている）を見て、どの委譲かを辿ること。') +
    // `lost` を条件に混ぜない: `lost` が 0 のまま器が黙って消えた委譲だけが在る回を取りこぼすため
    (runnerVanished === 0
      ? ''
      : ' **「宛先の runner が名簿から消えている」は status の分割ではなく横断する軸である** — ' +
        '必ず「走行中」の内側に座るが、`lost`（戻れなかった）とは別の集合で、' +
        '`manager_list status: ["lost"]` の絞りでは拾えない。名指しで絞る綴りは無い' +
        '（`status` の値ではないため）——この一覧の各行に付く注記' +
        '（⚠ 宛先の runner が名簿から消えている）を見て、どの委譲かを辿ること。' +
        RESTART_BEFORE_CHECK_ADVICE)
  );
}

function roleLabel(role: 'inbound' | 'outbound'): string {
  return role === 'inbound' ? '人間' : 'クローン';
}

// 型を写さず `JournalEntry` の union から取り出す: 写した側が古いままでも気づけないため
type ContextUsageRow = NonNullable<Extract<JournalEntry, { type: 'turn_usage' }>['contextUsage']>;

// 欄が無い回は 0 を置かず空文字を返す: 「測ったが 0 だった」と「測っていない」を混ぜないため
// SDK の語をそのまま使わない: `memoryFiles` は `CLAUDE.md` 系で、alteroid の記憶はシステムプロンプト側に入り取り違えるため
function describeContextLine(context: ContextUsageRow | undefined): string {
  if (context === undefined) return '';
  if (context.error !== undefined) return `\n文脈: 測れなかった（${context.error}）。`;
  return (
    `\n文脈: ${context.totalTokens?.toLocaleString('en-US') ?? '不明'} トークン` +
    (context.rawMaxTokens === undefined
      ? ''
      : ` / ${context.rawMaxTokens.toLocaleString('en-US')}`) +
    (context.percentage === undefined ? '' : `（${context.percentage}%）`) +
    '。' +
    describeContextBreakdown(context)
  );
}

function describeContextBreakdown(context: ContextUsageRow): string {
  const parts: string[] = [];
  if (context.systemPromptTokens !== undefined) {
    parts.push(
      `システムプロンプト ${context.systemPromptTokens.toLocaleString('en-US')} トークン` +
        (context.systemPromptSectionCount === undefined
          ? ''
          : `（${context.systemPromptSectionCount} 節。**記憶の焼き込みはここに入る**）`),
    );
  }
  if (context.mcpToolTokens !== undefined) {
    parts.push(
      `MCP の道具の説明文 ${context.mcpToolTokens.toLocaleString('en-US')} トークン` +
        (context.mcpToolCount === undefined ? '' : `（${context.mcpToolCount} 本）`),
    );
  }
  if (context.memoryFileTokens !== undefined) {
    parts.push(
      `CLAUDE.md 系のファイル ${context.memoryFileTokens.toLocaleString('en-US')} トークン` +
        (context.memoryFileCount === undefined ? '' : `（${context.memoryFileCount} 件）`) +
        '——**alteroid の記憶ではない**',
    );
  }
  const categories =
    context.categories === undefined || context.categories.length === 0
      ? ''
      : `\n  カテゴリ別（SDK が名乗る軸。名前は SDK の版で変わりうる）: ` +
        context.categories
          .map(
            (category) =>
              // `kind` が無ければ「分類なし」と名乗る: `0` や `used` へ倒さないため
              `${category.name} ${category.tokens.toLocaleString('en-US')} [${category.kind ?? '分類なし'}]`,
          )
          .join(' / ') +
        (context.categoriesOmitted === undefined
          ? ''
          : `…ほか ${context.categoriesOmitted} 軸は省略`);

  return (parts.length === 0 ? '' : `\n  内訳: ${parts.join(' / ')}。`) + categories;
}

// 付けるのは窓の始点が地平より前にかかるときだけ: 窓がまるごと地平より後ろなら0件でも「本当に無かった」と言い切れ、注記を出すと確定できることまで「判定できない」と言う誤りになるため。前にかかるなら非空でも付ける: 同じ区間について同じ区別が付かないため
function describeJournalHorizonNote(
  oldestAt: string | null,
  since: string | undefined,
  isEmpty: boolean,
): string | undefined {
  if (oldestAt === null) return undefined;
  if (!journalWindowCrossesHorizon(oldestAt, since)) return undefined;
  const range =
    since === undefined ? 'それより前は' : `指定の since（${since}）から ${oldestAt} までの区間は`;
  return isEmpty
    ? `この記憶ストアの日誌の最古は ${oldestAt}。${range}判定できない` +
        '（該当する行が無かったのか、日誌がそこまで遡れないのかは、' +
        'この返り値だけからは区別できない）。'
    : `この記憶ストアの日誌の最古は ${oldestAt}。${range}判定できない` +
        '（その区間に該当する行が無かったのか、日誌がそこまで遡れないのかは、' +
        'この返り値だけからは区別できない）。';
}

function journalAttachmentHead(
  attachments: readonly { id: string; name: string; mediaType: string; size: number }[] | undefined,
  rejected?: readonly { name: string; reason: string }[],
  limit: number = Number.POSITIVE_INFINITY,
): string {
  // 一覧では先頭の数件だけ出し、残りは件数にする: 添付の多い1行が一覧の予算を食い潰さないため。全件は id 指定で出る
  const more = (total: number): string =>
    total > limit ? `; ほか ${total - limit} 件（全件は journal_read id=<id>）` : '';
  const kept =
    attachments === undefined || attachments.length === 0
      ? ''
      : ` attachments=[${attachments
          .slice(0, limit)
          .map(
            (a) => `id=${a.id} name=${excerptLine(a.name, 80)} type=${a.mediaType} size=${a.size}`,
          )
          .join('; ')}${more(attachments.length)}]`;
  // 受け取れなかったファイルも出す: 全部断られた報告が、添付なしの空の発言に見えないため
  const refused =
    rejected === undefined || rejected.length === 0
      ? ''
      : ` rejectedAttachments=[${rejected
          .slice(0, limit)
          .map((r) => `${excerptLine(r.name, 80)}（${excerptLine(r.reason, 80)}）`)
          .join('; ')}${more(rejected.length)}]`;
  return kept + refused;
}

function renderJournalEntry(
  entry: JournalEntry,
  attachmentLimit: number = Number.POSITIVE_INFINITY,
): { head: string; body: string } {
  switch (entry.type) {
    case 'exchange': {
      const conversation =
        entry.conversationId === undefined ? '' : ` conversation=${entry.conversationId}`;
      return {
        head: `[exchange ${entry.with}/${entry.role}]${conversation}${journalAttachmentHead(entry.attachments, entry.rejectedAttachments, attachmentLimit)}`,
        body: entry.text,
      };
    }
    case 'decision':
      return { head: '[decision]', body: `${entry.decision}（根拠: ${entry.grounds}）` };
    case 'escalation': {
      const to = entry.managerId === undefined ? '' : ` manager=${entry.managerId}`;
      const status =
        entry.withdrawnAt !== undefined
          ? `取り下げ済み ${entry.withdrawnAt}`
          : entry.answeredAt === undefined
            ? '未回答'
            : `回答済み ${entry.answeredAt}`;
      const body =
        entry.withdrawnAt !== undefined
          ? `${entry.question} →（取り下げ: ${entry.withdrawnReason ?? '（理由の記録なし）'}）`
          : entry.answer === undefined
            ? entry.question
            : `${entry.question} → ${entry.answer}`;
      return { head: `[escalation approval=${entry.approvalId}${to} ${status}]`, body };
    }
    case 'tool_use':
      return {
        head: `[tool_use ${entry.actor} ${entry.tool}]`,
        body: safeJson(entry.input),
      };
    case 'memory_update': {
      // バイトは `head`、文字を含みうる自由文（`summary`）は `body` に分ける: 1行・1文にバイトと文字を混ぜないため
      // 値が無いときは `0` ではなく「不明」と明示する: `0` だと「変化が無かった」と読め、省くと出ている行と混ざって「変化なし」に読めるため
      const action = entry.action === undefined ? '' : ` ${entry.action}`;
      const bytes =
        entry.bytesBefore === undefined || entry.bytesAfter === undefined
          ? ' bytes=不明(旧形式)'
          : ` bytes=${entry.bytesBefore}→${entry.bytesAfter}`;
      return {
        head: `[memory_update ${entry.slug} (${entry.cause})${action}${bytes}]`,
        body: entry.summary,
      };
    }
    case 'daily_report':
      return { head: `[daily_report ${entry.date}]`, body: entry.body };
    case 'external_event':
      return {
        head: `[external_event ${entry.source}]${journalAttachmentHead(entry.attachments, undefined, attachmentLimit)}`,
        body: entry.summary,
      };
    case 'worker_wait': {
      const cause = entry.byCause;
      return {
        head: `[worker_wait tasks=${entry.tasks} turns=${entry.turns} settled=${entry.settled}]`,
        body:
          `作業者 ${entry.tasks} 体を待つあいだに ${entry.turns} ターン` +
          `（通知 ${cause.notification} / 自己継続 ${cause.continuation} / 話しかけ ${cause.input}）。` +
          `うち ${entry.toolless} ターンは道具を1つも動かしていない。` +
          `UserPromptSubmit の発火は ${entry.submits} 回` +
          (entry.sources === undefined
            ? '（source は取れていない）'
            : `（内訳: ${Object.entries(entry.sources)
                .map(([source, count]) => `${source}=${count}`)
                .join(', ')}）`) +
          '。',
      };
    }
    case 'turn_usage': {
      // キャッシュの書き直しを目で分かる形にする: 潰すと測る意味が消えるため、印の行を一覧から隠さない
      const modelLines = Object.entries(entry.models)
        .map(([model, totals]) => {
          const cache =
            totals.cacheReadInputTokens === 0 && totals.cacheCreationInputTokens === 0
              ? ''
              : ` cache(read=${totals.cacheReadInputTokens} write=${totals.cacheCreationInputTokens})`;
          return (
            `${model}: ${formatUsd(totals.costUsd)}${cache} ` +
            `in=${totals.inputTokens} out=${totals.outputTokens}`
          );
        })
        .join('\n');
      const resetLine =
        entry.reset === undefined
          ? ''
          : `\n⚠ 数え直しを挟んだ回（${formatUsd(entry.reset.fromCostUsd)} → ` +
            `${formatUsd(entry.reset.toCostUsd)}）。models は差分ではなく新しい累積の先頭 — ` +
            '他の行と足し合わせると二重に数える。';
      const context = entry.contextUsage;
      const contextLine = describeContextLine(context);
      const compactionLine =
        entry.compactions === undefined || entry.compactions.length === 0
          ? ''
          : `\ncompaction ${entry.compactions.length} 回: ` +
            entry.compactions
              .map(
                (compaction) =>
                  `${compaction.trigger} ${compaction.preTokens.toLocaleString('en-US')} → ` +
                  `${compaction.postTokens?.toLocaleString('en-US') ?? '不明'}`,
              )
              .join(' / ');
      return {
        head:
          `[turn_usage ${entry.layer}/${entry.site} ${entry.managerId}]` +
          (entry.reset === undefined ? '' : ' ⚠reset') +
          (context?.percentage === undefined ? '' : ` 文脈 ${context.percentage}%`),
        body: `${modelLines}${resetLine}${contextLine}${compactionLine}`,
      };
    }
    case 'context_usage': {
      const context = entry.contextUsage;
      return {
        head:
          `[context_usage ${entry.layer}/${entry.site} ${entry.managerId} ` +
          `${entry.turnSucceeded ? '成功' : '失敗'}]` +
          (context.percentage === undefined ? '' : ` 文脈 ${context.percentage}%`),
        body: describeContextLine(context).replace(/^\n/, ''),
      };
    }
    case 'token_rotation': {
      // `exhausted`（全層が止まる）を `not_rotated`（正常）と同じ顔にしない: 見出しに `event` を出す
      const where =
        entry.tokenId === undefined
          ? ''
          : ` → ${entry.tokenId}${entry.label === undefined ? '' : `「${entry.label}」`}`;
      const gen = entry.generation === undefined ? '' : ` 世代${String(entry.generation)}`;
      // `earliestAt` が無いことを「すぐ戻る」と読ませない: 無いのは戻る見込みの立っている候補が1本も無いとき。`parked` でも言い方を変えて出す: その時刻より前に重い委譲を起こす判断をしないために要るため
      const earliest =
        entry.event === 'parked'
          ? entry.earliestAt === undefined
            ? '\n⚠ 撒いた鍵が通るようになる時刻が取れていない'
            : `\n⚠ 撒いた鍵は ${entry.earliestAt} まで通らない（それまでのターンは失敗する）`
          : entry.event !== 'exhausted'
            ? ''
            : entry.earliestAt === undefined
              ? '\n⚠ 戻る見込みの立っている候補が1本も無い（プールが空か、全部外されている）'
              : // 全体の最速として書かない: `exhausted` に `earliestAt` が付くのは現役自身か現役のほうが早い回だけのため
                `\n撒き直す候補のうちいちばん早く戻るのは ${entry.earliestAt}（現役はこれと同時かより早く戻る見込みなので撒き直していない）`;
      // `recoveredSource` を潰さない: どちらの生産者が「通る」と観測したかを見出しから引ける形で出す
      const recoveredSource =
        entry.recoveredSource === undefined ? '' : ` src=${entry.recoveredSource}`;
      return {
        head:
          `[token_rotation ${entry.event}` +
          (entry.signal === undefined ? '' : ` ${entry.signal}`) +
          (entry.freshness === undefined ? '' : `/${entry.freshness}`) +
          `${gen}]${where}${recoveredSource}`,
        // 本文は整形済みの行をそのまま出す: 組み直すと人間が読む面と言い方が分かれるため
        body: `${entry.text}${earliest}`,
      };
    }
    case 'subagent_stall': {
      const agentType = entry.agentType === undefined ? '' : `/${entry.agentType}`;
      return {
        head:
          `[subagent_stall ${entry.outcome} agent=${entry.agentId}${agentType} ` +
          `owned=${entry.ownedTaskCount} session=${entry.sessionTaskCount} ` +
          `wakeup=${entry.wakeupCount}]`,
        body: entry.text,
      };
    }
    case 'inbox_flow': {
      const byTypeText = (count: { byType: { type: string; count: number }[] }): string =>
        count.byType.length === 0
          ? '（無し）'
          : count.byType.map((e) => `${e.type} ${e.count}`).join(' / ');
      // `retained` は見出しに出さない: 一覧の1行を太らせないため、詳細は本文（全文モード）に回す
      const retainedLine =
        entry.retained === undefined
          ? ''
          : `\n残存: unread=${entry.retained.unread} redelivered=${entry.retained.redelivered} ` +
            `redeliveredClosed=${entry.retained.redeliveredClosed} ` +
            `pendingCollapse=${entry.retained.pendingCollapse}`;
      return {
        head:
          `[inbox_flow arrived=${entry.arrived.total} delivered=${entry.delivered.total} ` +
          `settled=${entry.settled.total} pending=${entry.pending.count}]`,
        body:
          `窓: ${entry.windowStartedAt} 〜 ${entry.at}\n` +
          `到着: ${byTypeText(entry.arrived)}\n` +
          `配達: ${byTypeText(entry.delivered)}\n` +
          `消し込み: ${byTypeText(entry.settled)}` +
          (entry.pending.oldestAt === undefined ? '' : `\n最古の滞留: ${entry.pending.oldestAt}`) +
          retainedLine,
      };
    }
    case 'github_observation': {
      // 申告であることを見出しに出す。数が取れなかった回は数を出さない
      const head = `[github_observation ${entry.repo} by ${entry.observedBy} ${entry.result.status}]`;
      const scope = `母集合: ${entry.query}${entry.limit === undefined ? '' : ` / limit ${entry.limit}`}`;
      return entry.result.status === 'ok'
        ? {
            head,
            body:
              `open Issue ${entry.result.openIssues} 件 / open PR ${entry.result.openPulls} 件` +
              (entry.result.truncated ? '（limit に達した。実数はこれ以上）' : '') +
              `\n${describeGithubCi(entry.result)}` +
              `\n${scope}`,
          }
        : { head, body: `取れなかった: ${entry.result.reason}\n${scope}` };
    }
    case 'conversation_deleted':
      return {
        head: '[conversation_deleted]',
        body: `会話 ${entry.deletedConversationId} を削除した（${entry.hiddenCount} 件。${entry.deletedBy}）`,
      };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// 軸ごとに上限を置き、打ち切ったことを必ず書く: 「全部でこれだけ」と読める出力を黙って作ると嘘になるため
const USAGE_AXIS_LIMIT = 14;

export const USAGE_AXES = ['date', 'manager', 'model', 'layer', 'site', 'token'] as const;
type UsageAxis = (typeof USAGE_AXES)[number];

const USAGE_AXIS_PAGE = 100;

// `USAGE_AXIS_TITLES` と分ける: 見出しと、その軸が何で切っているかの注記は用途が違うため
const USAGE_AXIS_NOTES: Record<UsageAxis, string> = {
  date: '日',
  manager: '誰の分か',
  model: 'どのモデルで',
  layer: '誰が: clone / manager',
  site: 'どこで: session / distill / peer',
  token: 'どの認証トークンで',
};

const USAGE_AXIS_TITLES: Record<UsageAxis, string> = {
  date: '日別',
  manager: 'マネージャー別',
  model: 'モデル別',
  layer: '層別（誰が）',
  site: '場所別（どこで）',
  token: '認証トークン別',
};

interface UsageAxisEntry {
  label: string;
  totals: UsageTotals;
  // 無いときは `0` にせず欄そのものを持たない: `model` の枝は `UsageBreakdown.byModel` に欄が無く渡せないため
  turns?: number;
  updatedAt: string;
  cost: number;
}

// 定数へ寄せて書き写さない: 畳んだラベルの綴りが1文字でもずれると `updatedAt` の引き当てが外れて静かに握り潰すため
const USAGE_TOKEN_UNATTRIBUTED_LABEL = '（トークンの帰属が無い分）';

// `usageAxisEntries` と同じ鍵の取り方をする: ずれると `resolveUsageCursor` の取りこぼし対策が誤動作するため
function usageAxisUpdatedAtByLabel(
  rows: readonly UsageRow[],
  axis: UsageAxis,
): Map<string, string> {
  const map = new Map<string, string>();
  const bump = (label: string, updatedAt: string) => {
    const found = map.get(label);
    if (found === undefined || updatedAt > found) map.set(label, updatedAt);
  };
  for (const row of rows) {
    switch (axis) {
      case 'date':
        bump(row.date, row.updatedAt);
        break;
      case 'manager':
        bump(row.managerId, row.updatedAt);
        break;
      case 'model':
        bump(row.model, row.updatedAt);
        break;
      case 'layer':
        bump(row.layer, row.updatedAt);
        break;
      case 'site':
        bump(row.site, row.updatedAt);
        break;
      case 'token':
        bump(row.tokenId ?? USAGE_TOKEN_UNATTRIBUTED_LABEL, row.updatedAt);
        break;
    }
  }
  return map;
}

// まとめ表示と `axis` モードが同じここを通る: 並びが違うとページングが取りこぼすか重複するため
// 全順序にする（費用降順 → ラベル昇順）: 費用の降順だけだと同額のときの順序が実装の偶然に依存するため
// `summary` に `updatedAt` を足さない: ブラウザと共有する型で、HTTP の応答の形が変わるため同じ `rows` から別に畳む
function usageAxisEntries(
  summary: UsageBreakdown,
  axis: UsageAxis,
  rows: readonly UsageRow[],
): UsageAxisEntry[] {
  const updatedAtByLabel = usageAxisUpdatedAtByLabel(rows, axis);
  // 見つからなければ `risen` へ回さない安全側（最古のタイムスタンプ）に倒す: 「常に伸びた」と誤解して余計な節を出すより安全なため
  const updatedAtOf = (label: string): string => updatedAtByLabel.get(label) ?? '';
  const withUpdatedAt = <E extends { label: string; totals: UsageTotals }>(
    e: E,
  ): E & { updatedAt: string; cost: number } => ({
    ...e,
    updatedAt: updatedAtOf(e.label),
    cost: e.totals.costUsd,
  });
  const byCost = (entries: UsageAxisEntry[]) =>
    entries.sort((a, b) => b.totals.costUsd - a.totals.costUsd || a.label.localeCompare(b.label));
  switch (axis) {
    case 'date':
      // 日別は新しい順: 古い日で上限を使い切らせないため
      return summary.byDate
        .map((entry) =>
          withUpdatedAt({ label: entry.date, totals: entry.totals, turns: entry.turns }),
        )
        .sort((a, b) => b.label.localeCompare(a.label));
    case 'manager':
      return byCost(
        summary.byManager.map((e) =>
          withUpdatedAt({ label: e.managerId, totals: e.totals, turns: e.turns }),
        ),
      );
    case 'model':
      return byCost(
        summary.byModel.map((e) => withUpdatedAt({ label: e.model, totals: e.totals })),
      );
    case 'layer':
      return byCost(
        summary.byLayer.map((e) =>
          withUpdatedAt({ label: e.layer, totals: e.totals, turns: e.turns }),
        ),
      );
    case 'site':
      return byCost(
        summary.bySite.map((e) =>
          withUpdatedAt({ label: e.site, totals: e.totals, turns: e.turns }),
        ),
      );
    case 'token':
      // `null` を「記録が無い」と書き、id を捏造しない: 空文字や `'unknown'` だと1本のトークンに見え、費用をそこへ帰属させた話が始まるため
      return byCost(
        summary.byToken.map((e) =>
          withUpdatedAt({
            label: e.tokenId ?? USAGE_TOKEN_UNATTRIBUTED_LABEL,
            totals: e.totals,
            turns: e.turns,
          }),
        ),
      );
  }
}

// `turns` が無いときは `0回` とも `-` とも書かない
function formatUsageAxisLine(entry: UsageAxisEntry): string {
  const cost = formatUsd(entry.totals.costUsd);
  if (entry.turns === undefined) return `  ${entry.label}: ${cost}`;
  return `  ${entry.label}: ${cost} / ${entry.turns}回 / 1回 ${formatUsd(entry.totals.costUsd / entry.turns)}`;
}

// 文言を書き写さない: 同じ値を見る口の間で言い方が分かれ、いつか片方だけが「取れなかった」を 0 と描くため
function renderAccountUsage(state: AccountUsageState): string {
  return [`## ${ACCOUNT_USAGE_TITLE}`, ...describeAccountUsage(state)].join('\n');
}

// `context.managers` が `undefined` のとき 0 と出さず「確かめられなかった」と明示する: 空配列と同じ形にすると蒸留の場では常に「取りこぼしは無い」と嘘をつくため
async function unrecordedManagersLines(
  context: ToolContext,
  stores: Stores,
  since: string | null,
): Promise<string[]> {
  if (context.managers === undefined) {
    return [
      '⚠ 台帳に1行も記録が無い委譲: 確かめられなかった' +
        '（この場ではマネージャーの一覧が読めない。0 件ではない）。',
    ];
  }
  const [managers, recordedManagerIds] = await Promise.all([
    context.managers.list(),
    stores.usage.recordedManagerIds(),
  ]);
  return describeUnrecordedManagers(findUnrecordedManagers(managers, recordedManagerIds, since));
}

function maxUpdatedAt(rows: readonly UsageRow[]): string | undefined {
  let max: string | undefined;
  for (const row of rows) {
    if (max === undefined || row.updatedAt > max) max = row.updatedAt;
  }
  return max;
}

// 文言を1か所に寄せる: 片方だけ直すと読み手が「同じことを別の言葉で言っている」と誤読するため
function renderRisenSection<T>(risen: readonly T[], formatEntry: (entry: T) => string): string[] {
  if (risen.length === 0) return [];
  const lines = [
    '',
    '⚠ 順位が上がった、または既に見せた行が伸びた可能性がある行' +
      '（前回の呼び出し以降に記録が増えたため。この頁の本体とは重複しない）:',
  ];
  for (const entry of risen.slice(0, USAGE_AXIS_LIMIT)) lines.push(formatEntry(entry));
  if (risen.length > USAGE_AXIS_LIMIT) {
    lines.push(`  …ほか ${risen.length - USAGE_AXIS_LIMIT} 件は省略。`);
  }
  return lines;
}

function renderUsage(
  aggregate: UsageAggregate,
  view: {
    axis?: UsageAxis;
    cursor?: string;
    // `undefined` は「軸モードなので出さない」であって「取りこぼしが無い」ではない
    unrecordedManagers?: readonly string[];
  } = {},
): string {
  const {
    rows,
    turnRows,
    since,
    layersSince,
    tokensSince,
    turnsSince,
    beforeLedger,
    beforeLayers,
    beforeTokens,
    beforeTurns,
    notice,
  } = aggregate;
  const unreadableRowsLines = describeUnreadableUsageRows(aggregate.unreadableRows);
  const unmeteredLines = describeUnmeteredUsage(aggregate.unmeteredRows);

  if (since === null) {
    return [
      '台帳にはまだ1件も記録が無い。',
      '（消費の記録はこの機能を入れた時点から始まる。それより前の分は残っていない）',
      ...unreadableRowsLines,
      ...unmeteredLines,
      ...(view.unrecordedManagers === undefined ? [] : ['', ...view.unrecordedManagers]),
    ].join('\n');
  }

  const summary = summarizeUsage(rows, turnRows);
  const lines: string[] = [];

  if (view.axis !== undefined) {
    // 軸モードではまとめ表示も他の軸も出さない: 続きを取るたびに同じ全体が返ると、辿るほど入力を食うため
    const axis = view.axis;
    const entries = usageAxisEntries(summary, axis, rows);
    const cursorOutcome = resolveUsageCursor(entries, axis, view.cursor);
    if (cursorOutcome.kind === 'malformed') {
      lines.push(
        `${USAGE_AXIS_TITLES[axis]}`,
        'cursor が壊れている（この道具が返したものではないか、書き換えられている）。' +
          `cursor を付けずに axis="${axis}" で usage_read を呼び直すと先頭から読める。`,
      );
      return lines.join('\n');
    }
    if (cursorOutcome.kind === 'wrong-axis') {
      lines.push(
        `${USAGE_AXIS_TITLES[axis]}`,
        `cursor が別の軸（または self_status）のものである。axis="${axis}" の cursor を` +
          'そのまま渡すこと（自分で組み立てない）。',
      );
      return lines.join('\n');
    }
    const { page: afterAnchor, risen } = cursorOutcome;
    lines.push(`${USAGE_AXIS_TITLES[axis]}（全 ${entries.length} 件）`);
    const page = afterAnchor.slice(0, USAGE_AXIS_PAGE);
    if (page.length === 0) {
      // 黙って空を返さない: 空の一覧だけでは「この軸には記録が無い」と「最後の頁」を区別できないため
      lines.push(
        view.cursor === undefined
          ? `  （その軸には記録が無い）`
          : '  （cursor より後ろは無い。これが最後の頁）',
      );
    } else {
      for (const entry of page) {
        lines.push(formatUsageAxisLine(entry));
      }
      const rest = afterAnchor.length - page.length;
      if (rest > 0) {
        const lastShown = page[page.length - 1]!;
        const nextAsOf = maxUpdatedAt(rows);
        const nextCursor = encodeUsageCursor({
          axis,
          label: lastShown.label,
          cost: lastShown.totals.costUsd,
          asOf: nextAsOf,
          tiedAtAsOf: findUsageCursorTies(entries, axis, lastShown, nextAsOf),
        });
        lines.push(
          `  …（残り ${rest} 件は出していない。` +
            `axis="${axis}", cursor="${nextCursor}" で続きが出る）`,
        );
      }
    }
    lines.push(...renderRisenSection(risen, formatUsageAxisLine));
    lines.push(...unreadableRowsLines);
    lines.push(...unmeteredLines);
  } else if (rows.length === 0) {
    lines.push('その範囲には記録が無い。');
    lines.push(...unreadableRowsLines);
    lines.push(...unmeteredLines);
    // 取りこぼしは照会範囲と無関係に全期間で判定するので、この範囲に台帳の行が無くても出す
    if (view.unrecordedManagers !== undefined) lines.push('', ...view.unrecordedManagers);
  } else {
    lines.push(
      `合計 ${formatUsd(summary.total.costUsd)}` +
        (summary.turns === undefined
          ? ''
          : ` / ${summary.turns}回 / 1回 ${formatUsd(summary.total.costUsd / summary.turns)}`),
    );
    lines.push(
      `  入力 ${summary.total.inputTokens.toLocaleString('en-US')} / ` +
        `出力 ${summary.total.outputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ読み ${summary.total.cacheReadInputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ書き ${summary.total.cacheCreationInputTokens.toLocaleString('en-US')}` +
        describeWebSearchRequests(summary.total),
    );
    lines.push(...describeUnreadableUsage(summary.total));
    lines.push(...unreadableRowsLines);
    lines.push(...unmeteredLines);
    if (view.unrecordedManagers !== undefined) lines.push(...view.unrecordedManagers);

    for (const axis of USAGE_AXES) {
      const entries = usageAxisEntries(summary, axis, rows);
      lines.push('', `${USAGE_AXIS_TITLES[axis]}:`);
      for (const entry of entries.slice(0, USAGE_AXIS_LIMIT)) {
        lines.push(formatUsageAxisLine(entry));
      }
      if (entries.length > USAGE_AXIS_LIMIT) {
        const lastShown = entries[USAGE_AXIS_LIMIT - 1]!;
        const nextAsOf = maxUpdatedAt(rows);
        const nextCursor = encodeUsageCursor({
          axis,
          label: lastShown.label,
          cost: lastShown.totals.costUsd,
          asOf: nextAsOf,
          tiedAtAsOf: findUsageCursorTies(entries, axis, lastShown, nextAsOf),
        });
        lines.push(
          `  …（残り ${entries.length - USAGE_AXIS_LIMIT} 件は出していない。` +
            `axis="${axis}", cursor="${nextCursor}" で続きが出る）`,
        );
      }
    }
    // 回数が1つでも出ているときだけ、モデル別に出ない理由を書く: 出さないと「モデル別だけ0回」に読めるため
    if (summary.turns !== undefined) {
      lines.push(
        '',
        'モデル別に回数は出さない（1ターンが複数のモデル行を作るので、回数をモデルへ帰属させられない）。',
      );
    }
  }

  lines.push('', `台帳の始点: ${since}`);
  if (beforeLedger) {
    // 0 と言わない: 台帳が無かった期間を「使っていない期間」と読ませないため
    lines.push(
      '照会した範囲は台帳の始点より前にかかっている。その分は **0 ではなく「記録が無い」**。',
    );
  }
  // 層の始点を台帳の始点と混ぜない: 層の軸は台帳より後から入ったので、それより前の行の層と場所は既定値で観測ではないため
  lines.push(
    layersSince === null
      ? '層と場所の軸はまだ1件も記録していない。'
      : `層と場所の軸の始点: ${layersSince}`,
  );
  if (beforeLayers) {
    lines.push(
      '照会した範囲は層と場所の軸の始点より前にかかっている。' +
        'その分の層と場所は **既定値であって観測ではない**（クローンが使っていなかった、' +
        '蒸留が起きていなかった、とは読まないこと）。',
    );
  }
  // トークンの軸の始点を上の2つと混ぜない: null はプールを使っていないので取れないこともあり、「トークンを回していない」と読ませないため
  lines.push(
    tokensSince === null
      ? '認証トークンの軸はまだ1件も記録していない' +
          '（プールを使っていない構成なら、これが正常である）。'
      : `認証トークンの軸の始点: ${tokensSince}`,
  );
  if (beforeTokens) {
    lines.push(
      '照会した範囲は認証トークンの軸の始点より前にかかっている。' +
        'その分に **トークンの帰属は無い**（0 でも既定値でもなく、取れていない）。',
    );
  }
  // 回数の軸の始点を上の3つと混ぜない: null は「まだ1件も数えられる形で起きていない」であって「0回だった」ではないため
  lines.push(
    turnsSince === null ? '回数の軸はまだ1件も記録していない。' : `回数の軸の始点: ${turnsSince}`,
  );
  if (beforeTurns) {
    lines.push(
      '照会した範囲は回数の軸の始点より前にかかっている。' +
        'その分の回数は **0 ではなく「取れていない」**。',
    );
  }
  lines.push(notice);
  return lines.join('\n');
}

// `memory.ts` の `MEMORY_TOC_LINE_LIMIT` を使い回さない: 値が同じでも、片方だけ直したくなったときに一緒に動くため
const SELF_STATUS_MEMORY_DESCRIPTION_LIMIT = 120;

// `MEMORY_LISTING_BUDGET` より小さく取る: `self_status` は3節同居で、合計を一覧総当たり試験の `OUTPUT_CAP`（12,000）に収める必要があるため
const SELF_STATUS_MEMORY_LISTING_BUDGET = 3_500;

// 単位のラベル（文字 / bytes）を両方に必ず付ける: 単位が混ざると、読み手が bytes から文字数を割り戻すことになるため
// 並びは毎ターンの寄与が大きい順にする: slug 順のままだと予算に達したとき大きい premise でも黙って落ち、測れていない0を測ったつもりで読むため。`stores.persona.list()` 自体の並びは変えない: 他の面がその順に依存するため
function renderMemorySize(
  documents: MemoryDocumentMeta[],
  memoryDocuments: readonly MemoryPart[],
  totalMemory: string,
): string {
  const lines = [
    '## 記憶の大きさ（いま stores.persona を読み直した値）',
    '',
    `- 総文字数: ${totalMemory.length.toLocaleString('en-US')} 文字（${documents.length} 文書）`,
  ];
  if (documents.length === 0) return lines.join('\n');

  const floor = measureMemoryFloor(memoryDocuments);

  const contentBySlug = new Map(memoryDocuments.map((doc) => [doc.slug, doc]));
  const contribution = new Map(
    documents.map((doc) => {
      const part = contentBySlug.get(doc.slug);
      const chars = part === undefined ? 0 : measureMemoryFloor([part]).totalChars;
      return [doc.slug, chars] as const;
    }),
  );
  const sorted = [...documents].sort(
    (a, b) => (contribution.get(b.slug) ?? 0) - (contribution.get(a.slug) ?? 0),
  );

  const items = sorted.map((doc) => {
    const descriptor =
      doc.description === undefined
        ? ''
        : ` — ${excerptLine(doc.description, SELF_STATUS_MEMORY_DESCRIPTION_LIMIT)}`;
    const chars = contribution.get(doc.slug) ?? 0;
    return (
      `  - [${doc.kind}] ${doc.slug}: ${doc.title} ` +
      `(作成: ${formatMemoryCreatedAt(doc.createdAt)} / 更新: ${doc.updatedAt}) ` +
      `${doc.bytes.toLocaleString('en-US')} bytes / ${chars.toLocaleString('en-US')} 文字${descriptor}`
    );
  });

  lines.push(
    renderListing(items, {
      budget: SELF_STATUS_MEMORY_LISTING_BUDGET,
      omitted: ({ rest, shown, total }) =>
        `  …ほか ${rest} 文書は省略（全 ${total} 文書のうち ${shown} 文書だけ出した）。` +
        '全件は memory_list、本文は memory_read slug=<slug> で取れる。',
    }),
  );
  // 区分ごとの小計は文書一覧の後ろへ0字下げで置く: 2字下げのままだと総当たり試験が「5項目を満たさない文書」として撃つため
  // 蓋が噛んだ件数は同じ行で名乗り、噛んでいない回は足さない: 毎回付けると本当に噛んだときの目印が効かなくなるため
  const demotedSuffix =
    floor.demotedPremiseDocs === 0
      ? ''
      : `。⚠️ うち ${floor.demotedPremiseDocs.toLocaleString('en-US')} 文書は束ねた予算に当たって` +
        'カードを落とし、1行になっている（節の目次は焼かれていない。' +
        '落ちた文書の名前と直し方は焼き込みの断り書きに在り、節は memory_outline で開ける）';
  lines.push(
    `- premise 合計: ${floor.premiseChars.toLocaleString('en-US')} 文字（${floor.premiseDocs} 文書。毎ターン「要旨＋節の目次」が焼かれる${demotedSuffix}）`,
    `- indexed 合計: ${floor.indexedChars.toLocaleString('en-US')} 文字（${floor.indexedDocs} 文書。毎ターン要旨だけが焼かれる。節の目次は焼かれない）`,
    `- fact 目次合計: ${floor.tocChars.toLocaleString('en-US')} 文字（${floor.factDocs} 文書。目次の1行だけが焼かれる）`,
  );
  return lines.join('\n');
}

// 「あなたの消費が台帳に載っている／載っていない」と書かない: 台帳の軸が変わった瞬間に嘘になるため、軸そのものを構造として出す
// 畳む鍵に層と場所を入れる: クローンとマネージャーはどちらも opus で同じモデル id に並び、`managerId` だけだと見分けられないため
// 素の位置ではなく keyset の `ledgerCursor`: 内訳が委譲の進行で順位を変えると欠落・重複を生むため。3項目は区切り文字（`\u0000`）で連結した合成ラベルにする: 区切りが個々のフィールドより小さい codepoint なら `localeCompare` がタプル比較と同じ順序になるため
// 軸の名前は `'ledger'`: `UsageAxis` のどれとも重ならず、`usage_read` の cursor との取り違えが `wrong-axis` で断られるため
const LEDGER_CURSOR_AXIS = 'ledger';
const LEDGER_LABEL_SEP = '\u0000';

function renderLedgerCrossReference(
  sdkModel: string | null,
  aggregate: UsageAggregate | null,
  ledgerCursor?: string,
): string {
  const lines = ['## 台帳との突き合わせ（軸: 日 × actor × モデル × 層 × 場所）', ''];

  if (sdkModel === null) {
    lines.push('まだ init を観測していないので、SDK のモデル id が分からず突き合わせられない。');
    return lines.join('\n');
  }
  if (aggregate === null || aggregate.since === null) {
    lines.push(`台帳にはまだ1件も記録が無い（いまのモデル id: ${sdkModel}）。`);
    return lines.join('\n');
  }

  const matches = aggregate.rows.filter((row) => row.model === sdkModel);
  if (matches.length === 0) {
    lines.push(`モデル id ${sdkModel} と同じ行は無い（台帳の始点: ${aggregate.since}）。`);
    return lines.join('\n');
  }

  const buckets = new Map<
    string,
    { managerId: string; layer: string; site: string; costUsd: number; updatedAt: string }
  >();
  for (const row of matches) {
    const key = `${row.managerId} ${row.layer} ${row.site}`;
    const found = buckets.get(key);
    if (found === undefined) {
      buckets.set(key, {
        managerId: row.managerId,
        layer: row.layer,
        site: row.site,
        costUsd: row.totals.costUsd,
        updatedAt: row.updatedAt,
      });
    } else {
      found.costUsd += row.totals.costUsd;
      if (row.updatedAt > found.updatedAt) found.updatedAt = row.updatedAt;
    }
  }
  const entries = [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      label: [bucket.managerId, bucket.layer, bucket.site].join(LEDGER_LABEL_SEP),
      cost: bucket.costUsd,
    }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        a.managerId.localeCompare(b.managerId) ||
        a.layer.localeCompare(b.layer) ||
        a.site.localeCompare(b.site),
    );

  const formatEntry = (entry: (typeof entries)[number]): string =>
    `  - managerId: "${entry.managerId}" / layer: ${entry.layer} / site: ${entry.site}` +
    ` / 合計 ${formatUsd(entry.costUsd)}`;

  const cursorOutcome = resolveUsageCursor(entries, LEDGER_CURSOR_AXIS, ledgerCursor);
  if (cursorOutcome.kind === 'malformed') {
    lines.push(
      'ledgerCursor が壊れている（この道具が返したものではないか、書き換えられている）。' +
        'ledgerCursor を付けずに self_status を呼び直すと先頭の内訳から読める。',
    );
    return lines.join('\n');
  }
  if (cursorOutcome.kind === 'wrong-axis') {
    lines.push(
      'ledgerCursor が別の文脈（usage_read の axis 用など）のものである。' +
        'self_status が返した ledgerCursor をそのまま渡すこと。',
    );
    return lines.join('\n');
  }
  const { page: afterAnchor, risen } = cursorOutcome;

  if (ledgerCursor !== undefined) {
    lines.push(`モデル id ${sdkModel} の行の内訳（全 ${entries.length} 件）:`);
    const page = afterAnchor.slice(0, USAGE_AXIS_PAGE);
    if (page.length === 0) {
      lines.push('  （ledgerCursor より後ろは無い。これが最後の頁）');
      lines.push(...renderRisenSection(risen, formatEntry));
      return lines.join('\n');
    }
    for (const entry of page) lines.push(formatEntry(entry));
    const rest = afterAnchor.length - page.length;
    if (rest > 0) {
      const lastShown = page[page.length - 1]!;
      const nextAsOf = maxUpdatedAt(matches);
      const nextCursor = encodeUsageCursor({
        axis: LEDGER_CURSOR_AXIS,
        label: lastShown.label,
        cost: lastShown.cost,
        asOf: nextAsOf,
        tiedAtAsOf: findUsageCursorTies(entries, LEDGER_CURSOR_AXIS, lastShown, nextAsOf),
      });
      lines.push(
        `  …（残り ${rest} 件は出していない。self_status の ledgerCursor=${nextCursor} で続きが出る）`,
      );
    }
    lines.push(...renderRisenSection(risen, formatEntry));
    return lines.join('\n');
  }

  lines.push(
    `モデル id ${sdkModel} の行の内訳（台帳の軸そのもの。行には必ず actor と層と場所が付く）:`,
  );
  for (const entry of entries.slice(0, USAGE_AXIS_LIMIT)) lines.push(formatEntry(entry));
  if (entries.length > USAGE_AXIS_LIMIT) {
    const lastShown = entries[USAGE_AXIS_LIMIT - 1]!;
    const nextAsOf = maxUpdatedAt(matches);
    const nextCursor = encodeUsageCursor({
      axis: LEDGER_CURSOR_AXIS,
      label: lastShown.label,
      cost: lastShown.cost,
      asOf: nextAsOf,
      tiedAtAsOf: findUsageCursorTies(entries, LEDGER_CURSOR_AXIS, lastShown, nextAsOf),
    });
    lines.push(
      `  …（残り ${entries.length - USAGE_AXIS_LIMIT} 件は出していない。` +
        `self_status の ledgerCursor=${nextCursor} で続きが出る）`,
    );
  }
  return lines.join('\n');
}

export function createCloneMcpServer(context: ToolContext) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '0.1.0',
    instructions:
      'alteroid のクローン自身の道具。記憶（人間がいつでも読み書きする Markdown）、' +
      '日誌（追記専用）、人間への確認、継続中の依頼（時間起点の仕込み）、' +
      '実行環境プロファイル（`.zprofile` 相当）、自分自身（alteroid）の正典と実行時の状態、' +
      'マネージャーへの委譲。',
    tools: createCloneTools(context),
  });
}

// 中身は出さない: `conversation_read` は一覧の道具で、中身は別の取り口に回すため。名前は抜粋にする: 255 文字まで入り、10 個並べても溢れない長さへ締めるため
function attachmentLines(
  attachments: readonly { id: string; name: string; mediaType: string; size: number }[] | undefined,
  indent: string,
): string {
  if (attachments === undefined || attachments.length === 0) return '';
  return (
    `\n${indent}[添付 ${attachments.length}件]` +
    attachments
      .map(
        (a) =>
          `\n${indent}  id=${a.id} name=${excerptLine(a.name, 80)} type=${a.mediaType} size=${a.size}`,
      )
      .join('') +
    `\n${indent}  （attachment_fetch id=<id> で取り出して Read で開ける）`
  );
}
