import { createHash } from 'node:crypto';

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { describeArchiveRemovedBytesUnit } from './archive-removed-bytes.js';
import { codexChatgptAuthStatusOf, describeCodexChatgptAuth } from './codex-chatgpt-auth.js';
import { fallbackAttachmentCopiesDir, fetchAttachmentCopy } from './attachment-fetch.js';
import { ATTACHMENT_FROM_CLASSES, readAttachmentLimits } from './attachment.js';
import { putLocalFile } from './file-put.js';
import {
  deleteFile,
  describeAttachmentAlreadyGoneRetraction,
  describeAttachmentForJournal,
  keepFile,
  listFiles,
} from './file-tools.js';
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
  lookupWithdrawnForMessages,
  readConversationPage,
  readConversationWindow,
  readConversationWindowPage,
  searchExchanges,
  type ConversationCursor,
  type ConversationPage,
} from './conversation.js';
import {
  describeResolvedConversationPrefix,
  describeUnresolvedConversation,
  resolveConversationId,
} from './conversation-lookup.js';

import { isRunningJobStatus } from './job-status-running.js';

import { isTaskClosed, taskStatusForJob } from './task.js';
import { filterTranscriptLinesYielding } from './transcript-filter.js';
import {
  TranscriptPageCache,
  transcriptPageCacheKey,
  type TranscriptPageSnapshot,
} from './transcript-page-cache.js';
import {
  describeOffsetRequiredTimeBoundary,
  describeUnreadableJournalTimeBoundary,
  isOffsetQualifiedTimeBoundary,
  isReadableJournalTimeBoundary,
  normalizeJournalTimeBoundary,
} from './journal-time.js';
import { notePhase } from './loop-stall.js';
import { describeDenialStreakForList } from './classifier-denial-streak.js';
import {
  compareManagerPosition,
  encodeManagerCursor,
  normalizeManagerCursorStatus,
  resolveManagerCursor,
  type ManagerPosition,
} from './manager-cursor.js';

import {
  describePidsSaturation,
  RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL,
} from './runner-protocol.js';
import { CGROUP_EVENTS_UNKNOWN_NOTE, formatCgroupEventsNote } from './cgroup-events.js';
import { formatSystemErrorFacts, SYSTEM_ERROR_UNKNOWN_NOTE } from './system-error.js';
import {
  classifyUnobservedOutcome,
  describeManagerState,
  describeSessionMissingKind,
  describeReportState,
  describeUnobservedOutcome,
  isManagerAwaitingJudgement,
  isManagerInFlight,
  isManagerOutcomeUnobserved,
  JUDGEMENT_RANK_NOT_APPLICABLE,
} from './digest.js';
import {
  describeDroppedTraceEmpty,
  describeDroppedTraceOrigin,
  describeDroppedTraceRetention,
  droppedTraceLedgerSince,
  journalEntryShape,
  noteDroppedRecord,
  reasonOf,
  RECENT_TRACE_LIMIT,
  recentDroppedTraces,
} from './dropped-record.js';
import { collapseErrorCause } from './error-cause.js';

import { encodeRunnerCursor, resolveRunnerCursor } from './runner-cursor.js';

import { encodeUsageCursor, findUsageCursorTies, resolveUsageCursor } from './usage-cursor.js';
import {
  describePage,
  excerptLine,
  excerptRow,
  fillListingBudget,
  page,
  renderFilledListing,
  renderListing,
  renderListingEntry,
  renderListingFromEnd,
} from './excerpt.js';
import { renderTurnTimingSummary, type TurnTimingEntry } from './turn-timing-format.js';
import { renderHttpTimingSummary, type HttpTimingEntry } from './http-timing-format.js';

import { classifyManagerActivity, describeReportDrift } from './manager-activity.js';
import type { ManagerActivityInput } from './manager-activity.js';

import {
  removeArchiveChunkJournalFirst,
  removeArchiveJournalFirst,
} from './removal-journal-first.js';

import {
  ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
  ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
  selectArchiveRemovalTargets,
} from './archive-prune.js';
import type { ArchiveRemoveManyFilter } from './archive-prune.js';
import { denialActorTag, describeDenialFollowUp } from './denial-format.js';
import { HELD_MESSAGE_TTL_MS } from './held-messages.js';
import { decisionUnusedNote, guardArchiveRemoval } from './manager.js';
import { tokenGenerationMismatched } from './manager-summary.js';
import { describeTokenDiff } from './token-diff.js';
import type { ManagerDenial } from './denial-key.js';
import type { ManagerUnpushedWork } from './unpushed-work-observation.js';
import type {
  ManagerPool,
  ManagerSendResult,
  ManagerSummary,
  ManagerTranscript,
  RunnerBacklogSnapshot,
  RunnerFleetOverview,
  RunnerManagerEntry,
  TokenGenerationUnknownReason,
} from './manager.js';
import type { RunnerPushOutcome } from './push-ledger.js';

import { formatMemoryCreatedAt, measureMemoryFloor, renderMemoryDocuments } from './memory.js';
import { stripNul } from './nul-guard.js';
import type { MemoryPart } from './memory.js';

import {
  externalOutputLimits,
  jobStatusSchema,
  practiceKindSchema,
  practiceSlugSchema,
} from './schema.js';

import type {
  Task,
  ExternalOutput,
  Job,
  JobStatus,
  JournalEntry,
  LastUnpushedWorkObservation,
  MemoryDocumentMeta,
  RescueRemovalReason,
  Practice,
} from './schema.js';

import { describeRevisionStatus } from './revision.js';
import { describeManagerPeers } from './manager-peers-format.js';
import {
  CANON_REVISION,
  CLONE_RUNTIME_ITEM_LABELS,
  canonDocument,
  canonNames,
  describeCloneRuntime,
} from './self.js';

import {
  UnreadableJournalEntryError,
  UnreadablePracticeError,
  UnreadableTaskError,
  describeUnreadableJobs,
  describeUnreadableManagerRow,
  describeUnreadablePractices,
} from './store.js';
import { PracticeConflictError, practiceVersion } from './store.js';
import type { ArchiveEntry, InboxPeek, Stores } from './store.js';
import {
  RESTART_BEFORE_CHECK_ADVICE,
  RESTART_BEFORE_CHECK_ADVICE_CORE,
  STALE_TOKEN_RESTART_ADVICE,
  limitRecoveryOf,
  limitRecoveryOfAssistantError,
  withRecoveryNote,
} from './usage-limits.js';
import {
  describeHumanOriginatedInboxAlert,
  describeInboxBacklogBreakdown,
  describeInboxBacklogQueuedInMemory,
  describeNoReadableInboxEvents,
  summarizeInboxBacklog,
} from './inbox-backlog.js';
import type { InboxBacklogBreakdown } from './inbox-backlog.js';

import { formatUsd, type UsageAggregate } from './usage.js';

import { describeManagerFoldCandidate } from './manager-fold-candidate.js';
import { describeManagerModels, managerModelsOf } from './manager-models.js';
import {
  describeUnpushedWorkObservationIncompleteness,
  describeUnpushedWorkObservationProvenance,
  describeUnpushedWorkObservationSource,
  formatUnpushedWorkObservationWorktrees,
  isEmptyCompleteUnpushedWorkObservation,
  UNPUSHED_WORK_SHUTDOWN_OBSERVATION_NOT_ARRIVED_NOTE,
} from './unpushed-work-observation-format.js';
import { describeWaitingKind } from './waiting-kind-format.js';
import { formatElapsedAgo, formatMinutesAgo } from './format-elapsed.js';
import { RESCUE_NOT_PUSHED_TEXT, rescueNotPushedDetail } from './workspace-swap-hints.js';

import { chunkIdsByChars } from './chunk-ids.js';

import { CLOSE_MANY_JOURNAL_ID_CHARS, CLOSE_MANY_LIMIT_MAX } from './task-close-many.js';

import {
  describeArrayLengthViolation,
  describeBlankViolation,
  describeIntRangeViolation,
  describeStringArrayElementLengthViolation,
  describeStringLengthViolation,
  formatArrayLengthJa,
  formatIntRangeJa,
  formatStringLengthJa,
} from './tool-arg-checks.js';
import { profileTools } from './clone-tools-profile.js';
import { taskTools } from './clone-tools-task.js';
import { scheduleTools } from './clone-tools-schedule.js';
import { usageTools } from './clone-tools-usage.js';
import { approvalTools } from './clone-tools-approval.js';
import { journalTools } from './clone-tools-journal.js';
import { memoryTools } from './clone-tools-memory.js';
import { CLOSES_SCHEMA, describeClosesViolation, finishWithCloses } from './clone-tools-closes.js';
import {
  tool,
  describeRunnerLegState,
  TRANSCRIPT_PAGE,
  JOURNAL_TEXT_EXCERPT,
  describeUnreadableJournalEntry,
  RUNNER_MANAGER_PEERS_EXCERPT,
  text,
  type ToolText,
  JournalNotRecordedError,
  appendJournalOrThrow,
  appendJournalOrDrop,
  NO_POOL,
  type FixedFold,
  NO_FIXED_FOLD,
  isSubagentCaller,
  foldFixedFor,
  USAGE_AXIS_LIMIT,
  USAGE_AXIS_PAGE,
  maxUpdatedAt,
  renderRisenSection,
} from './clone-tools-common.js';
import { CLONE_TOOL_NAMES, type CloneToolName } from './clone-tools-names.js';
import type { CloneToolsShared, ToolContext } from './clone-tools-context.js';

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

import { MCP_SERVER_NAME } from './mcp-server-name.js';

export { MCP_SERVER_NAME };
export {
  GITHUB_OBSERVATION_CLONE_OBSERVER,
  REMOVE_MANY_JOURNAL_ID_CHARS,
} from './clone-tools-task.js';
export { USAGE_AXES } from './clone-tools-usage.js';
export { describePermissionEvidence } from './clone-tools-approval.js';
export { GROUNDS_NOT_DELIVERED } from './clone-tools-journal.js';
export {
  MEMORY_GUARD_ENV,
  MEMORY_GUARD_VALUES,
  DEFAULT_MEMORY_GUARD,
  resolveMemoryGuard,
} from './clone-tools-memory.js';
export type { MemoryGuardValue } from './clone-tools-memory.js';
export {
  TOOL_USE_ID_META_KEY,
  toolUseIdFromExtra,
  toolUseIdProbeFromExtra,
} from './clone-tools-common.js';
export { CLONE_TOOL_NAMES } from './clone-tools-names.js';
export type { CloneToolName } from './clone-tools-names.js';
export type { ReplyAttachments, ToolContext } from './clone-tools-context.js';

const MANAGER_ATTACHMENTS_DESCRIPTION =
  '人間の添付を担い手にも見せたいときに、その添付の id（通知行の id=… / conversation_read の添付行）を渡す。' +
  '渡したものは担い手の手元にファイルとして置かれ（通知行にパスが付くので Read で開ける）、画像は画像としても見える。' +
  '渡さない添付は担い手には見えない。**記憶には写らない**（日誌に残るのは渡した添付の参照だけで、中身は残らない）。' +
  '見つからない添付（保持期限切れ・id の誤り）があれば、何も送らずにエラーを返す。個数・合計には人間の発言と同じ上限がある。' +
  '確認への回答（requestId / decision）には載せられない。';

export function qualifiedToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

export const SELF_JOURNALING_CLONE_TOOLS = [
  'github_observation_record',
  'memory_write',
  'memory_append',
  'memory_delete',
  'memory_frontmatter_set',
  'memory_section_move',
  'journal_write',
  'ask_human',
  'request_permission',
  'approval_withdraw',
  'daily_report_write',
  'schedule_create',
  'schedule_remove',
  'task_add',
  'task_move',
  'task_set_status',
  'task_set_status_many',
  'task_keep',
  'task_say',
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
  'task_list',
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
  ask_human: false,
  request_permission: false,
  approval_withdraw: false,
  daily_report_write: false,
  schedule_create: false,
  schedule_remove: false,
  task_add: false,
  task_move: false,
  task_set_status: false,
  task_set_status_many: false,
  task_keep: false,
  task_say: false,
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

// 同じ会話で前回に全文で出した行と1字も違わない行を、managerId だけの短い1行にする。判定は行の全文の完全一致（可変部を含む）。
// 鍵に行の指紋を入れ、同じ担当の古い版は捨てる（`foldFixed` の supersedes）: A→B→A と変わったとき、2回前の A を「前回と同じ」と言わないため。
// 控えは `DigestSessionDelta.fixed` に乗るので、reset・compaction・失敗ターン・20ターン保険（forgetFixed）で全文へ戻る
const MANAGER_LIST_ROW_FOLD_PREFIX = 'manager-list:row:';
const MANAGER_ROW_SAME_MARK = '前回と同じ';

function rowFingerprint(row: string): string {
  return createHash('sha256').update(row).digest('hex').slice(0, 24);
}

function managerRowRef(manager: ManagerSummary): string {
  return `- ${manager.managerId} ${MANAGER_ROW_SAME_MARK}`;
}

// 見落とすと困る行は、前回と同じでも全文で出す。lost・失敗・枠で止まっている・runner 消失／セッション無し・⚠ の行
function managerRowAlwaysFull(manager: ManagerSummary, row: string): boolean {
  return (
    manager.status === 'lost' ||
    manager.status === 'failed' ||
    manager.lastFailure !== undefined ||
    manager.usageStoppedAt !== undefined ||
    manager.runnerVanished !== undefined ||
    manager.runnerLostSince !== undefined ||
    manager.sessionMissingSince !== undefined ||
    row.includes('⚠')
  );
}

// 行ごとに同じ長い固定文を繰り返さず、行には印だけを置いて意味は一覧の末尾に1回だけ書く（#5347）。
// 429 の波で runner が一斉に黙る・lost が並ぶときに、同じ文が行の数だけ積まれて LIST_BUDGET が尽き、後続の行が省略されるため
type ManagerListNoteMark = 'runner-lost' | 'session-missing' | 'lost';
const MANAGER_LIST_NOTE_MARKS: Record<ManagerListNoteMark, string> = {
  'runner-lost': '［runner 消失］',
  'session-missing': '［セッション無し］',
  lost: '［lost］',
};
const MANAGER_LIST_NOTE_BODIES: Record<ManagerListNoteMark, string> = {
  'runner-lost':
    '宛先の器が行の時刻以降 名乗っていない。新しい委譲の宛先からは外れている（置き先として数えない）。' +
    '**この委譲が失われたという意味ではない** — 黙っているのが器なのか経路なのかは、ここからは言えない（器の中でまだ走っていることもある）。' +
    '話しかけることは塞いでいない — 戻る先（session_id）が在れば manager_send が resume を試みる（届くとは限らない）。' +
    '器そのものは runner_list で見る。',
  'session-missing':
    '行の時刻の時点で、宛先の runner がこの委譲のセッションを持っていなかった（runner がそう答えた。聞けなかったのではない）。' +
    '**この委譲が失われたという意味ではない** — ' +
    '完遂した後にセッションが畳まれ、終端イベントだけが届かなかった回も同じ形に見える' +
    '（デーモンにこの2つを区別する材料は無い）。まず manager_report を見ること' +
    '（報告が空でも、生ログから「生成されたが配られていない」報告を拾える）。' +
    'session_id が残っていれば manager_send が resume から入り直す。',
  lost:
    '前のセッションへ戻れなかった。**戻れたかどうかしか見ていない** — ' +
    'この仕事が終わっていたかは分からない（成果がリモートの PR・ブランチ・' +
    'コミットまで届いていることがある）。まずそこを確かめ、続きが要ると' +
    '判断したときだけ manager_start で起こし直すこと。',
};
// 2回目からの札。安全上の結論（失われたという意味ではない・終わったかは分からない）は札にも残し、全文は同じ会話の最初の一覧を指す
const MANAGER_LIST_NOTE_REFS: Record<ManagerListNoteMark, string> = {
  'runner-lost':
    '宛先の器が名乗っていない。**この委譲が失われたという意味ではない**（器の中で走っていることもある）。' +
    '話しかけることは塞いでいない（全文は最初の一覧のとおり）。',
  'session-missing':
    'runner がこの委譲のセッションを持っていなかった。**この委譲が失われたという意味ではない**。' +
    'まず manager_report を見る（全文は最初の一覧のとおり）。',
  lost:
    '前のセッションへ戻れなかっただけで、**終わったかは分からない**（成果が外へ出ていることがある）。' +
    'まず成果を確かめ、続きが要るときだけ manager_start（全文は最初の一覧のとおり）。',
};
const MANAGER_LIST_NOTE_ORDER: readonly ManagerListNoteMark[] = [
  'runner-lost',
  'session-missing',
  'lost',
];

// 出ている行が使った印の分だけ書く（使われなければ1文字も足さない）。RESTART_BEFORE_CHECK_ADVICE は
// runner 消失・セッション無しの両方に掛かるので、並べずここで1回だけ言う
// `fold` は返す文に載せるときだけ渡す（呼んだ時点で「会話に出した」と控えるため、予算を測るだけの呼びには渡さない）
function managerListNotes(
  rowMarks: readonly ReadonlySet<ManagerListNoteMark>[],
  fold: FixedFold = NO_FIXED_FOLD,
): string {
  const used = MANAGER_LIST_NOTE_ORDER.filter((mark) => rowMarks.some((marks) => marks.has(mark)));
  if (used.length === 0) return '';
  const lines = used.map(
    (mark) =>
      `${MANAGER_LIST_NOTE_MARKS[mark]} ${fold(`manager-list:note-${mark}`, MANAGER_LIST_NOTE_BODIES[mark], MANAGER_LIST_NOTE_REFS[mark])}`,
  );
  if (used.includes('runner-lost') || used.includes('session-missing')) {
    lines.splice(
      used.includes('lost') ? used.length - 1 : used.length,
      0,
      `${used
        .filter((mark) => mark !== 'lost')
        .map((mark) => MANAGER_LIST_NOTE_MARKS[mark])
        .join('')} ${RESTART_BEFORE_CHECK_ADVICE}`,
    );
  }
  return `行の印の意味（同じ文を行ごとには繰り返さない）:\n${lines.join('\n')}`;
}
const MANAGER_WAITING_LIST_LIMIT = 10;
const LIST_DENIED_TOOLS = 3;
const LIST_TOOL_USE_STALL_LIMIT = 3;

// 「未処理の合図は無い」は、器の行も読めない行もメモリの待ち行列も0件のときにしか言わない
function describeInboxBacklog(
  peek: InboxPeek,
  now: number,
  queuedInMemory: number | undefined,
  fold: FixedFold = NO_FIXED_FOLD,
  // 真なら、前回と同じ内訳も全文で出し直す（控えは更新する）
  refetch = false,
): string {
  const rows = peek.entries;
  const queuedLine = describeInboxBacklogQueuedInMemory(queuedInMemory, fold);
  const noReadable = describeNoReadableInboxEvents(peek.unreadable);
  // 行が無い回は、会話に出した内訳の控えを捨てる: A→空→A の3回目を、空の回を挟んだのに「前回と同じ」と畳まないため
  // 控えを捨てる口は `supersedes` だけなので、全文を出す回の形（前置きで始まる控えを消して1件足す）で呼ぶ。この鍵は内訳の指紋と衝突しない
  if (rows.length === 0) {
    fold(`${MANAGER_LIST_INBOX_BREAKDOWN_PREFIX}none`, '', '', MANAGER_LIST_INBOX_BREAKDOWN_PREFIX);
  }
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
  const humanOriginatedAlert = describeHumanOriginatedInboxAlert(breakdown, fold);
  const fullBreakdown = describeInboxBacklogBreakdown(breakdown, fold);
  // 内訳（人間起点の行と内訳の本体）が、同じ会話で前回に全文で出した版と同じ中身なら1行ずつにする。
  // 件数と最も古い時刻の見出しは毎回出す。読めない行が在る回も `fold` は呼んで控えを最新にするが、出力は全文（⚠ を落とさない）。
  // `&&` で呼びを飛ばさない: 飛ばすと控えが古いまま残り、A→B（読めない行あり）→A の3回目を「前回と同じ」と畳む
  const sameAsShown =
    fold(
      `${MANAGER_LIST_INBOX_BREAKDOWN_PREFIX}${inboxBreakdownFingerprint(breakdown)}`,
      fullBreakdown,
      describeInboxBreakdownRef(breakdown),
      MANAGER_LIST_INBOX_BREAKDOWN_PREFIX,
    ) !== fullBreakdown;
  const folded = sameAsShown && !refetch && breakdown.unreadable === undefined;
  const humanOriginatedLine =
    humanOriginatedAlert === ''
      ? ''
      : `${folded ? describeHumanOriginatedAlertRef(breakdown) : humanOriginatedAlert}\n`;
  const queuedSuffix = queuedLine === null ? '' : `\n${queuedLine}`;
  return (
    `${humanOriginatedLine}` +
    `⚠ クローンの受信箱に未処理の合図が ${breakdown.total} 件ある${oldest}\n` +
    (folded ? describeInboxBreakdownRef(breakdown) : fullBreakdown) +
    queuedSuffix
  );
}

// 受信箱の内訳の控え。鍵に内訳の指紋を入れ、古い版は捨てる（`foldFixed` の supersedes）: A→B→A と変わったとき、2回前の A を「前回と同じ」と言わないため。
// 指紋は観測時刻（毎回変わる）を除いた内訳の全文: 件数・種類・送信元・齢の段（段が動けば別の版）が1つでも変われば全文へ戻る
const MANAGER_LIST_INBOX_BREAKDOWN_PREFIX = 'manager-list:inbox-breakdown:';
function inboxBreakdownFingerprint(breakdown: InboxBacklogBreakdown): string {
  const stable = { ...breakdown, observedAt: '' };
  return rowFingerprint(
    `${describeHumanOriginatedInboxAlert(stable)}\n${describeInboxBacklogBreakdown(stable)}`,
  );
}

function describeInboxBreakdownRef(breakdown: InboxBacklogBreakdown): string {
  return (
    `内訳（計 ${breakdown.total} 件）は前回と同じ（観測 ${breakdown.observedAt} 時点の値。` +
    '種類・送信元・齢の全文は前の一覧のとおり。引き直しは manager_list に refetch: true。' +
    '⚠ 器の入れ替え回数は配られた回数ではない。同一本文の件数: この数は上下どちらへもぶれる）'
  );
}

function describeHumanOriginatedAlertRef(breakdown: InboxBacklogBreakdown): string {
  const h = breakdown.humanOriginated;
  return (
    `⚠ 人間起点（human_message / human_answer）の滞留が ${h.total} 件ある` +
    `（うち、いまの器になってから積まれ、まだ片付いていない分が ${h.undelivered} 件。配達されていないとは言えない。前回と同じ）。`
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
  // 末尾を読む口があれば使う: 判定は末尾の REPORT_GENERATED_PROBE_CHARS 文字しか見ず、全文（退避なら数十〜百 MB 級）をデーモンのループの上で文字へ戻すと1回で約1秒止まりうるため（#4638）
  const tailRead = managers.transcriptTail !== undefined;
  try {
    result =
      managers.transcriptTail !== undefined
        ? await managers.transcriptTail(managerId, REPORT_GENERATED_PROBE_CHARS)
        : await managers.transcript(managerId);
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
  const state = `（状態: ${status}）`;
  const found = `生ログには ${when} に本文が在る（約 ${length.toLocaleString('ja-JP')} 文字）`;
  // 末尾だけを読んだ回は全体の長さが分からないので、読み始めを offset ではなく発言の時刻（since）で案内する
  const where = tailRead
    ? timestamp === undefined
      ? 'で読める（末尾だけを見たので、読み始めの位置は示せない）'
      : ` since=${timestamp} で、その発言から読める`
    : ` offset=${Math.max(0, transcript.length - TRANSCRIPT_PAGE)} で読める`;
  const howToDigIn =
    `manager_transcript managerId=${managerId}${where}` +
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

// 定数は `task-close-many.ts` に在る。外へ出していた名前はここから変えない
export { CLOSE_MANY_LIMIT_MAX, CLOSE_MANY_JOURNAL_ID_CHARS };
import { REMOVE_MANY_LIMIT_DEFAULT, REMOVE_MANY_LIMIT_MAX } from './remove-many-limit.js';

export { REMOVE_MANY_LIMIT_DEFAULT, REMOVE_MANY_LIMIT_MAX };
// 道具の応答だけの関心事: 一括削除の口は道具だけ（HTTP の口は無い）なので、`removedIds` の間引きはテキスト応答の側で持つ
const ARCHIVE_REMOVE_MANY_IDS_SHOWN = 20;

// `task-close-many.ts` から使うため `chunk-ids.ts` へ移した（`tools.ts` を import すると循環する）。外へ出す名前はここから変えない
export { chunkIdsByChars };

// app.ts の人間の直接送信の行（`excerptLine(text, 200)`）に合わせる
const MANAGER_ANSWER_MESSAGE_EXCERPT = 200;

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
    // 開いている器と、閉じている器（理由つき）を並べる: ログイン済みなのに開いていない器を見せるため
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

// 内訳が無い（古い runner・材料を渡さない構成）ときは合計だけを出す: 内訳を0に潰さないため
function describeUnrecognised(
  total: number,
  split: { ownerLive: number; ownerListed: number; ownerUnknown: number } | undefined,
): string {
  if (split === undefined) return `sid 未認識 ${total}`;
  return (
    `sid 未認識 ${total}（持ち主が生きている ${split.ownerLive}・` +
    `持ち主が名簿に居るので守っている ${split.ownerListed}・持ち主不明 ${split.ownerUnknown}）`
  );
}

function describeZombieAge(seconds: number): string {
  return seconds < 60 ? `${seconds}秒前` : formatMinutesAgo(seconds * 1000);
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

const CANON_PAGE = 8_000;

// 他の一覧と定数を共有しない: 片方だけ直したくなったときに一緒に動かないため
const SELF_DROPPED_BUDGET = 8_000;
const SELF_DROPPED_DEFAULT_LIMIT = 50;
// self_status の「直近のターンの時間」が読む件数（#5086）。中央値・90% 点が意味を持つ数で、1回の読みを軽く保つ
const SELF_STATUS_TURN_TIMING_LIMIT = 30;
// self_status の「HTTP API の時間」が読む窓の数（#5089）。10 分の窓で直近 2 時間ぶん
const SELF_STATUS_HTTP_TIMING_LIMIT = 12;

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

// 断り文の部品は `tool-arg-checks.ts` へ切り出してある（道具と HTTP が同じ関数を共有するため）。既存の import 元（この文書）を変えないよう、書式の関数だけここから再公開する
export { formatIntRangeJa, formatStringLengthJa, formatArrayLengthJa };

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

/** 確認待ちの peer が残っている担当に1行（#4886）。確認に期限は無く、答えるまで peer は止まったままなので、一覧で見えるようにする。 */
function peerApprovalsLine(
  approvals: { count: number; oldestSince: string } | undefined,
): string | null {
  if (approvals === undefined) return null;
  return (
    `  ⚠ 確認待ちの peer が ${String(approvals.count)} 本ある（最古は ${approvals.oldestSince} から待っている）。` +
    '担当が peer_approve で答えるまで peer は止まったままで、確認の期限は無い。'
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
        'セッションが消えたことを確かめた事実。`manager-liveness.ts` の `isLive()` の doc）。' +
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
      'セッションが消えたことを確かめた事実。`manager-liveness.ts` の `isLive()` の doc）。' +
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
      ? '**枠の壁（利用上限）の可能性が高い** — 「報告が配られない」症状とは別の原因である。 '
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
      '  道具を実行中（矛盾ではない）。' +
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
    '(4) それが無いなら、確認がクローンの受信箱に一度も現れない症状そのものである。' +
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
  // セッションの終わった委譲には ⚠ を出さない（#4857）: 走っているセッションが無いので「古い鍵で走り続けている」は事実に反し、鍵が回るたびに一覧が終わった委譲の ⚠ で埋まる。done はセッションが生きて待っていることがあるので対象にしない
  if (manager.status === 'stopped' || manager.status === 'failed' || manager.status === 'lost') {
    return (
      `  認証トークンの世代: ${manager.tokenGeneration}（現役は世代 ${manager.activeTokenGeneration}。` +
      `この委譲のセッションは終わっている（status=${manager.status}）ので、古い鍵で走ってはいない。起こし直すと新しい鍵で起きる）`
    );
  }
  return (
    `  ⚠ 認証トークンの世代が食い違っている（世代 ${manager.tokenGeneration} を抱えたまま、` +
    `現役は世代 ${manager.activeTokenGeneration}）。この委譲のセッションが、` +
    'ターンの境界（確認待ち・背景処理が無い状態）に一度も達しないまま古い鍵で走り続けている' +
    '可能性がある（認証トークンを回した直後は、次のターンの境界に達するまでの短い遅れとして' +
    '普通に起こる——それ自体は症状ではない）。' +
    describeBackgroundTasksForStaleToken(manager) +
    '委譲が done なら、manager_send の時点で畳んで新しい鍵で起こし直す' +
    '（背景処理・確認待ちが残っていれば断る）。' +
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

function unpushedWorkObservationIncompleteSuffix(
  observation: Extract<LastUnpushedWorkObservation, { kind: 'observed' }>,
): string {
  const note = describeUnpushedWorkObservationIncompleteness(observation);
  return note === null ? '' : `\n  ${note}`;
}

// 一覧では外へ出した成果も退避 ref も件数と最後の1件だけにする: 一覧は予算で打ち切られ、1件の委譲が最大20行を取ると出る委譲の数が減るため。全件は `manager_report` が出す
function describeUnpushedWorkObservation(
  manager: ManagerSummary,
  outputs: 'brief' | 'full' | 'report' = 'brief',
  now?: Date,
): string | null {
  const lines = [
    describeUnpushedWorkObservationOnly(manager),
    describeRescue(manager, outputs, now),
    describeRescueStash(manager),
    // 'report' でも外へ出した成果は畳まない: 畳むのは退避 ref だけで、成果の記録は件数が上限で締まっている
    describeExternalOutputs(manager, outputs === 'report' ? 'full' : outputs),
    describeHeldMessages(manager),
  ].filter((line): line is string => line !== null);
  return lines.length === 0 ? null : lines.join('\n');
}

// 一覧で見えないと、クローンは届いたかを台帳で手書きで追い、送り直して二重に届ける（預かりそのものの理由と同じ）
export function describeHeldMessages(manager: ManagerSummary): string | null {
  const held = manager.heldMessages;
  if (held === undefined) return null;
  const expiresAt = new Date(Date.parse(held.oldestHeldAt) + HELD_MESSAGE_TTL_MS).toISOString();
  return (
    `  預かっている伝言（manager_send が届けられなかった分）: ${String(held.count)} 通` +
    `（最初の預かり ${held.oldestHeldAt}・その期限 ${expiresAt}）。` +
    '届けられるようになったら自動で届けて知らせる。送り直さないこと（二重に届く）'
  );
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

// 在りかを辿れるように件数と合計を出す。パスは出さない（担当へは器が入れ替わった後の知らせと `rescue_restore` の返事が運ぶ）
export function describeRescueStash(manager: ManagerSummary): string | null {
  const stash = manager.rescueStash;
  if (stash === undefined) return null;
  return (
    `  預かっている未追跡のファイル（デーモンの置き場。猶予は退避 ref と同じ）: ${String(stash.count)} 件・合計 ${String(stash.totalBytes)} バイト` +
    `（最後の預かり ${stash.latestAt}）。器が入れ替わった後、担当は rescue_restore で取り戻せる`
  );
}

type RescuePushed = NonNullable<
  NonNullable<ManagerSummary['lastRescue']>['worktrees'][number]['pushed']
>;

function describeRescuePushed(pushed: RescuePushed): string {
  const removal = pushed.removal;
  // 消した ref を「在る」と読ませない
  const state =
    removal === undefined
      ? ''
      : removal.failureKind === 'no-remote'
        ? '・送り先が台帳に無いので自動では消せない（手で消す）'
        : removal.failureKind === undefined
          ? `・${removal.at} に消した（${RESCUE_REMOVAL_REASON_TEXT[removal.reason]}）`
          : `・消せなかった（${removal.failureKind}。${removal.at} 時点で ${String(removal.attempts ?? 1)} 回目。次の機会に再試行する）`;
  return `${pushed.ref}（${pushed.commit.slice(0, 8)}, ${pushed.at}${state}）`;
}

// 一覧（brief）は件数と最新の1件だけにする: 作業ツリーごとに数行が付くと1件の委譲が予算を占有し、出る委譲の数が減って頁をめくらされるため。全部は `manager_report`（full）が出す
// 退避されなかったもの（push 失敗・未追跡・submodule）は件数だけ残す: 消すと「全部退避できた」と読めるため
// いまの器で、送るものが在るのに送れていない作業ツリー（#5117）。`goneAt` の行と、前の器の行（最新の行と `instanceId` が違う）は外す: 担当に push を促しても届かない分のため
function stuckRescueTrees(rescue: NonNullable<ManagerSummary['lastRescue']>): RescueTree[] {
  const newest = rescue.worktrees.reduce<RescueTree | undefined>(
    (best, tree) => (best === undefined || tree.at > best.at ? tree : best),
    undefined,
  );
  return rescue.worktrees.filter(
    (tree) =>
      tree.notPushed !== undefined &&
      tree.notPushed.reason !== 'nothing-tracked' &&
      tree.goneAt === undefined &&
      tree.instanceId === newest?.instanceId,
  );
}

function rescueNotPushedSinceOf(tree: RescueTree): string {
  return tree.notPushed?.since ?? tree.at;
}

// 一覧には、いちばん長く続いている1本と残りの本数だけを出す: 作業ツリーごとに並べると1件の委譲が予算を占有するため（`describeRescueBrief` と同じ理由）
function describeStuckRescueBrief(
  rescue: NonNullable<ManagerSummary['lastRescue']>,
  now: Date | undefined,
): string {
  const stuck = stuckRescueTrees(rescue);
  const oldest = stuck.reduce<RescueTree | undefined>(
    (best, tree) =>
      best === undefined || rescueNotPushedSinceOf(tree) < rescueNotPushedSinceOf(best)
        ? tree
        : best,
    undefined,
  );
  if (oldest?.notPushed === undefined) return '';
  const since = rescueNotPushedSinceOf(oldest);
  const elapsed =
    now === undefined
      ? ''
      : `・${formatElapsedAgo(since, now.getTime()).replace(/前$/, '')}続いている`;
  const rest = stuck.length > 1 ? ` ほか ${String(stuck.length - 1)} 本` : '';
  // too-large と secret-like は、担当が push すれば退避そのものが要らなくなる: 消える前に声を掛けられるよう、取れる手を添える
  const hint =
    oldest.notPushed.reason === 'too-large' || oldest.notPushed.reason === 'secret-like'
      ? '。担当が push すれば消えずに済む'
      : '';
  return (
    `。退避できていない: ${oldest.relativePath}（${oldest.notPushed.reason}。${since} から${elapsed}）${rest}` +
    hint
  );
}

function describeRescueBrief(
  rescue: NonNullable<ManagerSummary['lastRescue']>,
  now?: Date,
): string {
  const pushedTrees = rescue.worktrees.filter((tree) => tree.pushed !== undefined);
  const latest = pushedTrees.reduce<RescuePushed | undefined>(
    (best, tree) =>
      tree.pushed !== undefined && (best === undefined || tree.pushed.at > best.at)
        ? tree.pushed
        : best,
    undefined,
  );
  const unsavedTrees = rescue.worktrees.filter(
    (tree) =>
      tree.notPushed !== undefined ||
      tree.untracked !== undefined ||
      tree.submoduleCount !== undefined,
  ).length;
  const refs =
    latest === undefined
      ? '0 本'
      : `${String(pushedTrees.length)} 本（最新: ${describeRescuePushed(latest)}）`;
  const unsaved =
    unsavedTrees === 0 ? '' : `。退避されなかったものがある作業ツリー ${String(unsavedTrees)} 本`;
  return `  退避 ref ${refs}${unsaved}${describeStuckRescueBrief(rescue, now)}（走行中に自動で push。${rescue.at} に最後に更新。全部は manager_report を rescueAll: true で読む）`;
}

type RescueTree = NonNullable<ManagerSummary['lastRescue']>['worktrees'][number];

// manager_report の既定は件数に畳む。畳まないのは、退避できていない（push 失敗・未追跡・submodule で、失われうる）作業ツリーの存在だけ:
// 件数と代表の1本を必ず残す。生きている ref・消せなかった ref・生きている間に消えた作業ツリーは、読み手が何もできないか、ref 名が要るのは取り戻すときだけなので件数でよい（#5028 の続き）
// 軸は独立に数える（排他の分類にしない）: 作業ツリーが消えても、退避できていないものが在っても、ref が残っていれば「生きている ref」に数えるため
function isUnsavedRescueTree(tree: RescueTree): boolean {
  return (
    tree.untracked !== undefined ||
    tree.submoduleCount !== undefined ||
    (tree.notPushed !== undefined && tree.notPushed.reason !== 'nothing-tracked')
  );
}

function hasLiveRescueRef(tree: RescueTree): boolean {
  const removal = tree.pushed?.removal;
  return tree.pushed !== undefined && (removal === undefined || removal.failureKind !== undefined);
}

function describeRescueTreeRows(tree: RescueTree): string[] {
  const rows: string[] = [];
  const parts: string[] = [];
  if (tree.pushed !== undefined) {
    parts.push(describeRescuePushed(tree.pushed));
  } else {
    parts.push('退避された ref は無い');
  }
  if (tree.notPushed !== undefined) {
    parts.push(
      `直近の回: ${RESCUE_NOT_PUSHED_TEXT[tree.notPushed.reason]}${rescueNotPushedDetail(tree.notPushed)}` +
        (tree.notPushed.since === undefined || tree.notPushed.reason === 'nothing-tracked'
          ? ''
          : `（${tree.notPushed.since} から続いている）`),
    );
  }
  // 消さず印を添える: 台帳の項目は退避の記録そのもので、生きている間に消えた作業ツリーの ref も取り戻す材料として残す
  if (tree.goneAt !== undefined) {
    parts.push(`生きている間に消えた（観測 ${tree.goneAt}）`);
  }
  rows.push(`    ${tree.relativePath}: ${parts.join('。')}`);
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
  if (unsaved.length > 0) rows.push(`      退避されなかったもの: ${unsaved.join('、')}`);
  return rows;
}

// 代表は、いまも担当が手を打てる（消えていない）ものの中でいちばん長く続いているもの。無ければ消えたものから選ぶ
function representativeUnsavedTree(unsaved: RescueTree[]): RescueTree | undefined {
  const pool = unsaved.some((tree) => tree.goneAt === undefined)
    ? unsaved.filter((tree) => tree.goneAt === undefined)
    : unsaved;
  return pool.reduce<RescueTree | undefined>(
    (best, tree) =>
      best === undefined || rescueNotPushedSinceOf(tree) < rescueNotPushedSinceOf(best)
        ? tree
        : best,
    undefined,
  );
}

function describeRescueReport(rescue: NonNullable<ManagerSummary['lastRescue']>): string[] {
  const trees = rescue.worktrees;
  const unsaved = trees.filter(isUnsavedRescueTree);
  const liveTrees = trees.filter(hasLiveRescueRef);
  const rest = trees.filter((tree) => !hasLiveRescueRef(tree));
  const goneWithRef = liveTrees.filter((tree) => tree.goneAt !== undefined).length;
  const stuckFailed = liveTrees.filter(
    (tree) => tree.pushed?.removal !== undefined && tree.pushed.removal.failureKind !== 'no-remote',
  ).length;
  const noRemote = liveTrees.filter(
    (tree) => tree.pushed?.removal?.failureKind === 'no-remote',
  ).length;
  // ref が無い側の内訳: 消し終えた ref は理由ごと、消えた作業ツリーで ref が最初から無いもの、送るもの無し
  const goneNoRef = rest.filter(
    (tree) => tree.goneAt !== undefined && tree.pushed === undefined,
  ).length;
  const nothing = rest.filter(
    (tree) => tree.goneAt === undefined && tree.pushed === undefined && !isUnsavedRescueTree(tree),
  ).length;
  const removedGroups = (Object.keys(RESCUE_REMOVAL_REASON_TEXT) as RescueRemovalReason[])
    .map((reason) => ({
      reason,
      count: rest.filter((tree) => tree.pushed?.removal?.reason === reason).length,
    }))
    .filter((group) => group.count > 0)
    .map((group) => `${RESCUE_REMOVAL_REASON_TEXT[group.reason]} ${String(group.count)} 本`);
  const latestLive = liveTrees.reduce<RescuePushed | undefined>(
    (best, tree) =>
      tree.pushed !== undefined && (best === undefined || tree.pushed.at > best.at)
        ? tree.pushed
        : best,
    undefined,
  );
  const counts = [
    latestLive === undefined
      ? null
      : `生きている ref ${String(liveTrees.length)} 本（最新: ${describeRescuePushed(latestLive)}）` +
        (goneWithRef === 0
          ? ''
          : `・うち作業ツリーが生きている間に消えて ref だけ残っている ${String(goneWithRef)} 本（取り戻す材料）`) +
        (stuckFailed === 0 ? '' : `・うち消せなかった ${String(stuckFailed)} 本`) +
        (noRemote === 0
          ? ''
          : `・うち送り先が台帳に無く自動では消せない ${String(noRemote)} 本（手で消す）`),
    removedGroups.length === 0 ? null : `消した ref: ${removedGroups.join('・')}`,
    goneNoRef === 0 ? null : `生きている間に消えた（ref は無い） ${String(goneNoRef)} 本`,
    nothing === 0 ? null : `送るもの無し ${String(nothing)} 本`,
  ].filter((part): part is string => part !== null);
  const lines = [
    `  退避 ref（走行中に自動で push。${rescue.at} に最後に更新）: 作業ツリー ${String(rescue.worktrees.length)} 本`,
  ];
  if (counts.length > 0) lines.push(`    ${counts.join('、')}`);
  const representative = representativeUnsavedTree(unsaved);
  if (representative !== undefined) {
    // 種類ごとの本数も添える: 代表の1本だけだと、残りが別の種類（too-large など担当が打てる手が違うもの）でも見えないため
    const causeCounts = new Map<string, number>();
    for (const tree of unsaved) {
      const causes = [
        tree.notPushed !== undefined && tree.notPushed.reason !== 'nothing-tracked'
          ? RESCUE_NOT_PUSHED_TEXT[tree.notPushed.reason]
          : null,
        tree.untracked === undefined ? null : '未追跡',
        tree.submoduleCount === undefined ? null : 'submodule',
      ];
      for (const cause of causes) {
        if (cause !== null) causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);
      }
    }
    const causes = [...causeCounts].map(([cause, count]) => `${cause} ${String(count)}`).join('・');
    lines.push(
      `    ⚠ 退避できていない作業ツリー ${String(unsaved.length)} 本（失われうる。${causes}）。代表の1本:`,
      ...describeRescueTreeRows(representative).map((row) => `  ${row}`),
    );
  }
  lines.push('    全部は manager_report を rescueAll: true で読む');
  return lines;
}

export function describeRescue(
  manager: ManagerSummary,
  mode: 'brief' | 'full' | 'report' = 'full',
  now?: Date,
): string | null {
  const rescue = manager.lastRescue;
  if (rescue === undefined || rescue.worktrees.length === 0) return null;
  if (mode === 'brief') return describeRescueBrief(rescue, now);
  if (mode === 'report') return describeRescueReport(rescue).join('\n');
  const lines = [`  退避 ref（走行中に自動で push。${rescue.at} に最後に更新）:`];
  for (const tree of rescue.worktrees) lines.push(...describeRescueTreeRows(tree));
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

function unpushedWorkReportNote(
  manager: ManagerSummary,
  rescueAll: boolean = false,
): string | null {
  const note = describeUnpushedWorkObservation(manager, rescueAll ? 'full' : 'report');
  return note === null ? null : note.trimStart();
}

function runnerManagerTokenTag(manager: RunnerManagerEntry): string {
  if (manager.tokenGeneration === undefined || manager.activeTokenGeneration === undefined) {
    return '';
  }
  if (manager.tokenGeneration === manager.activeTokenGeneration) return '';
  return ` ⚠世代${manager.tokenGeneration}≠現役${manager.activeTokenGeneration}`;
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

/** 委譲が結び付いた task（`Job.taskId`）。読めない・見つからない・結び付いていないときは `undefined`（その回は委譲に数えない。走っている委譲は、閉じる直前に別に台帳を引いて見る）。 */
async function jobTaskIdOf(stores: Stores, managerId: string): Promise<string | undefined> {
  try {
    return (await stores.jobs.listJobs()).find((job) => job.id === managerId)?.taskId;
  } catch {
    return undefined;
  }
}

/** `manager_list` の行に出す、委譲の起点の会話。 */
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
  // 「結び付いた task へ」と出すのは taskId があるときだけ。無い委譲は task_list で探す・task_add で足す手順
  const hint = job.taskId === undefined ? ORIGIN_HINT_NO_TASK_FULL : ORIGIN_HINT_FULL;
  const origin =
    job.conversationId === undefined
      ? '  起点の会話: 無し（会話の外で起こした委譲）'
      : `  起点の会話: ${job.conversationId}${hint}`;
  return job.taskId === undefined
    ? origin
    : `${origin}\n  結び付いた task: ${job.taskId}（task_say で書ける。task_list で読める）`;
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
  // 道具の組み立て1回（＝セッション1本）の中だけで覚える: セッションをまたいで古い生ログを持ち越さないため（#4638）
  const transcriptPages = new TranscriptPageCache();
  // `conversationId` も倒れ先を作らない: 関数が無いことと `undefined` を返すことは別で、落とすのは前者だけ
  if (typeof context.conversationId !== 'function') {
    throw new Error(
      'conversationId が届いていない。ToolContext を組む側で明示すること' +
        '（既定値へ倒すと、ask_human が積む承認が会話 id を持てなくなり、' +
        '承認への回答を受けたターンのクローンの返答が会話に紐づかなくなる）。',
    );
  }
  const getConversationId = context.conversationId;
  const getWorkConversationId = context.workConversationId ?? getConversationId;

  const shared: CloneToolsShared = {
    stores,
    memoryCause,
    getConversationId,
    getWorkConversationId,
  };

  return [
    ...memoryTools(context, shared),
    ...journalTools(context, shared),
    ...approvalTools(context, shared),
    ...usageTools(context, shared),
    ...scheduleTools(context, shared),
    ...taskTools(context, shared),
    ...profileTools(context, shared),
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
        '文字数・書かれた時刻だけ）。',
        '**write のたびに版が1つ増える。remove しても版は消えない**——消した slug を',
        '同じ名前で作り直しても、版番号は消える前の続きから振られる。',
        '中身が要るなら practice_read slug=<slug> version=<版番号> で開くこと。',
        '各版は作成時刻だけを出す（版は追記専用なので、更新はいつも作成と同じ）。',
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
            // 更新は出さない: 版は追記専用で、書かれた時刻が作成でも更新でもあるため（同じ値の2回目を積まない）
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
        '**既存のやり方を書き換えるときは、先に practice_read で読んで、応答に出る base_version を渡すこと。焼き込みの索引だけでは書けない**（版が無ければ何も書かずに断る。読んだ後に人間や別のターンが書いていたら、何も書かずに「その間に変わった」と返す。読み直して判断し直すこと）。**新規作成は版なしで通る。**',
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
              '**既存のやり方を書き換えるときは必須**。',
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
                'ため分からない。版の履歴には今回の内容だけが新しい版として積まれる）'
              : before === null
                ? '新しいやり方を器に置いた'
                : 'やり方を書き直した（全文置換。いまの本文の読み口は最新の1本だが、' +
                  '前の本文は版の履歴（practice_history）に残る）',
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
        '**既存のやり方を消すときは、先に practice_read で読んで、応答に出る base_version を渡すこと（必須）。焼き込みの索引だけでは消せない**——版が無ければ何も消さずに断る。読んだ後に人間や別のターンが書いていたら、何も消さずに「その間に変わった」と返す（読んでいない内容まで消さないため）。',
      ].join(' '),
      {
        slug: z.string().describe('やり方のスラッグ（practice_list に出ている slug）'),
        base_version: z
          .string()
          .optional()
          .describe(
            '読んだ時点の版（practice_read / 直前の practice_write の応答に出る base_version）。**必須**。',
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
      async ({ ledgerCursor }, extra: unknown) => {
        // サブエージェントの呼びは全文で返し、控えも更新しない（manager_list と同じ）
        const fold = isSubagentCaller(context, extra)
          ? NO_FIXED_FOLD
          : (context.foldFixed ?? NO_FIXED_FOLD);
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
        const [documents, memoryDocuments, aggregate, codexAuth, turnTiming, httpTiming] =
          await Promise.all([
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
            // 直近のターンの時間（#5086）。読むのは種別と件数で絞った行だけで、この呼び出しのときにしか読まない
            stores.journal
              .list({ types: ['turn_timing'], limit: SELF_STATUS_TURN_TIMING_LIMIT })
              .then(
                (entries) =>
                  renderTurnTimingSummary(
                    entries.filter(
                      (entry): entry is TurnTimingEntry => entry.type === 'turn_timing',
                    ),
                  ),
                (error: unknown) =>
                  `直近のターンの時間: 日誌を読めなかった（${reasonOf(error)}）。`,
              ),
            // HTTP API の時間（#5089）。同じく種別と件数で絞って読む
            stores.journal
              .list({ types: ['http_timing'], limit: SELF_STATUS_HTTP_TIMING_LIMIT })
              .then(
                (entries) =>
                  renderHttpTimingSummary(
                    entries.filter(
                      (entry): entry is HttpTimingEntry => entry.type === 'http_timing',
                    ),
                  ),
                (error: unknown) => `HTTP API の時間: 日誌を読めなかった（${reasonOf(error)}）。`,
              ),
          ]);

        // 非同期の読みは `fold` を呼ぶ前に済ませる: 途中で落ちると、出していない全文を「出した」と控えてしまうため
        const peerReach = await renderPeerReach(context.managers);
        return text(
          [
            describeCloneRuntime(
              {
                ...runtime,
                ...(runnerModels === undefined ? {} : { runnerModels }),
                ...(runnerAnthropicRoutes === undefined ? {} : { runnerAnthropicRoutes }),
              },
              fold,
            ),
            ...(codexAuth === null ? [] : [codexAuth]),
            '',
            // クローンの文脈へ実際に載る形で数える: 本文だけを足すと、見出しのぶんだけ本当より少ない数を名乗るため
            renderMemorySize(
              documents,
              memoryDocuments,
              renderMemoryDocuments(memoryDocuments),
              fold,
            ),
            '',
            renderLedgerCrossReference(runtime.sdkModel, aggregate),
            '',
            turnTiming,
            '',
            httpTiming,
            ...peerReach,
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
        '——そちらは既に人間が読める。ここは、器の中からは1行も遡れなかった',
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
              '前回の応答の断り書きに出た offset をそのまま渡せば、' +
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
        'failed / lost の前任の後継を立てるときは supersedes に前任の managerId を渡すこと。' +
          '渡さないと、鍵の回転で前任が起き上がって二重になりうる。' +
          '前任が終わっていない（running / waiting_human / 生きている done）と断られる——先に manager_stop で止めること。',
      ].join(' '),
      {
        request: z
          .string()
          .describe(
            `依頼内容。人間が Claude Code に書くのと同じ粒度で、背景と狙いを添えて書く（${formatStringLengthJa({ min: 1 })}。空白だけは断る）`,
          ),
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
        supersedes: z
          .string()
          .optional()
          .describe(
            '前任の managerId（manager_list に出ている id）。failed / lost の前任の後継を立てるときに渡す。' +
              '前任の枠で止まった印を下ろし、自動の起こし直しの対象から外す。' +
              '前任が終わっていなければ断られる（先に manager_stop で止めること）。',
          ),
        taskId: z
          .string()
          .optional()
          .describe(
            'この委譲を結び付ける task の id（task_list）。渡すと task は待ちになり、委譲が終わる・失敗する・lost になると' +
              '判断待ち（needs_decision）に戻って、報告にもこの id が付く。閉じた task と、走っている委譲が既にある task は断られる（1つの task に走らせる委譲は同時に1本まで）。' +
              '人間の依頼の task のために委譲するときは渡すこと。渡さないと task に結び付かず、起点の会話へ返答した時点で、器が task を自動で done にする。',
          ),
      },
      async (rawArgs) => {
        const { request, cwd, runnerId, attachments, supersedes, taskId } = rawArgs as unknown as {
          request: string;
          supersedes?: string | undefined;
          cwd?: string | undefined;
          attachments?: string[] | undefined;
          runnerId?: string | undefined;
          taskId?: string | undefined;
        };
        if (!context.managers) return NO_POOL;
        // 空の依頼を断る: 日誌に「起こそうとしている」と書き、runner へ何もしない依頼を渡して1本ぶんの器を使うことになるため
        const requestError = describeStringLengthViolation('request', stripNul(request), {
          min: 1,
        });
        if (requestError !== null) return text(`${requestError}起こしていない。`);
        if (stripNul(request).trim().length === 0) {
          return text('request が空白だけなので起こしていない。任せたい仕事を書いて渡すこと。');
        }
        // task は日誌にも委譲にも触れる前に確かめる: 結び付かない委譲を黙って走らせると、終わっても task が動かず、渡したつもりのクローンが気づけないため
        if (taskId !== undefined) {
          let linked: Task | null;
          try {
            linked = await stores.tasks.get(taskId);
          } catch (error) {
            if (error instanceof UnreadableTaskError) {
              return text(
                `task ${taskId} は読めない形で入っている。マネージャーは起こしていない。`,
              );
            }
            throw error;
          }
          if (linked === null) {
            return text(
              `task ${taskId} は無い（task_list で実在する id を確かめること）。マネージャーは起こしていない。`,
            );
          }
          if (linked.status === 'done' || linked.status === 'cancelled') {
            return text(
              `task ${taskId} は閉じている（${linked.status}）。続きを頼むなら先に task_set_status で queued へ戻すこと。マネージャーは起こしていない。`,
            );
          }
          // 1つの task に同時に走る委譲は1本まで: 2本目が先に終わると、1本目が走っているのに task が判断待ちへ倒れる
          const running = (await stores.jobs.listJobs()).filter(
            (job) => job.taskId === taskId && taskStatusForJob(job.status) === 'waiting',
          );
          if (running.length > 0) {
            return text(
              `task ${taskId} には走っている委譲がある（${running.map((job) => `${job.id}: ${job.status}`).join('、')}）。` +
                '1つの task に同時に走らせる委譲は1本までなので、マネージャーは起こしていない。' +
                'その委譲が終わるのを待つか、manager_stop で止めてから頼むこと。' +
                '止められない（器が消えて running のまま残っている等）ときは、taskId を付けずに起こすか、task_set_status で task を動かすこと。',
            );
          }
        }
        // conversationId はクローンに渡させず呼び出し文脈から自動で読む: 手で維持する欄を新しく作らないため
        // 返信の宛先ではなく仕事の会話を読む: 報告を受けた内部ターンで続きを委譲したとき、起点が途切れないため
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
            ...(supersedes === undefined ? {} : { supersedes }),
            ...(conversationId === undefined ? {} : { conversationId }),
            ...(taskId === undefined ? {} : { taskId }),
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

        // 日誌より先に控える: 日誌の追記が落ちても、起こした事実は変わらない（自動 done がこの委譲を見落とさない）
        context.noteDelegationStarted?.(taskId);
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
        // 答え方の細則（allow のあとの撃ち直し・一時規則・伝える文言）はここに書かない: 確認の本文が言うため（`classifier-denial-streak.ts` の `DENIAL_ASK_AFTER_ANSWER_PARAGRAPH*`、`manager.ts` の `DENIAL_REPLY_ROUTE`）。ここに残すのは、本文に無い規則と、どの本文を読むかの指し先だけ
        '許可確認は2種類（分類器の拒否の確認は requestId が toolu_… の形、それ以外は UUID の形）で、答えたあとが違う。' +
          '答え方の細則は、届いた確認の本文が言う。' +
          'allow のあとに撃ち直し方を伝えるときは、decision を付けない追加指示で送ること。',
        '確認として届かない拒否の合図（拒否の報告だけが届いた回）には requestId が無く、許可として答える口は無い。' +
          'requestId 無しの decision は付けないこと（待っている別の確認へ当たりうる）。答え方は報告の本文が言う。',
        'manager_list が [running] と出していても、runner の側でセッションが畳まれていることがある' +
          '（その合図が届かなかった窓）。そのときは resume から入り直して届けるので、' +
          '返り値にそう書いてある。入り直せなかったときも「そんな id は無い」ではなく' +
          '「セッションが無い」と返る——委譲そのものは台帳に在るので、manager_start で' +
          '起こし直す前に、返ってきた文言をそのまま読むこと。',
        // 「セッションが無い」を「仕事が失われた」と読ませない: 完遂後に畳まれた回も同じ形に見え、決めつけると完遂済みの仕事を委譲し直すため
        // 「届けた」の保証の範囲はここに1回だけ詳しく書く: 返り値は送るたびに文脈へ積まれるので短くしてある
        '返り値の「届けた」が保証するのは、runner の resume の口を叩いて成功が返ったところまでで、' +
          '相手がこの本文を読んだかは見ていない。黙った器に載っている委譲へも送信は実際に届くので、' +
          '直後の manager_list が lost／セッション切断のままでも「届かなかった」とは読まず、' +
          '同じ本文で新しい委譲を立てないこと（同じ仕事が2本になる）。',
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
              '⚠️ 通るのは受信箱に確認として届いた requestId だけである。分類器の拒否の確認では toolu_… の形のことがあるが、' +
              '生ログから拾った toolu_…（tool_use_id）や req_…（API の request id）は、確認として届いていなければ通らない。' +
              '受信箱に届いていない確認に、生ログから答える手段は無い',
          ),
        closes: CLOSES_SCHEMA,
      },
      async ({ managerId, message, decision, requestId, attachments, closes }, extra: unknown) => {
        // 閉じる指定の誤りは、送る前に丸ごと断る（送ってから閉じる側だけ断ると、半分だけ済んだ呼びになるため）
        const closesError = describeClosesViolation(closes);
        if (closesError !== null) return text(closesError);
        // 送れなかった（早い断り・保留・失敗）呼びは1行も閉じず、そう書く
        const notDone = (res: ToolText) =>
          finishWithCloses(stores, res, closes, false, 'manager_send');
        if (!context.managers) return notDone(NO_POOL);
        // 空白だけは断らない: HTTP も通すため
        const messageError = describeStringLengthViolation('message', message, { min: 1 });
        if (messageError !== null) return notDone(text(messageError));
        const handover = await loadManagerAttachments(
          stores,
          attachments ?? [],
          context.attachmentLimits ?? readAttachmentLimits().limits,
        );
        if (!handover.ok) return notDone(text(handover.message));
        // 答える前に判断の行を書く: 答えが届いたのに跡が無い窓を作らないため。
        // この道具は自己記録なので PostToolUse の行が無く、この行が「クローンが人間に聞かず答えた」唯一の跡になる。
        // 行を書いたかを旗で持つ: 確認に当たらなかった送信では呼ばれず、書いていない行は打ち消さない
        // 閉包から代入するので、`let` ではなく箱にする（`let` だと代入後も `undefined` へ絞られる）
        const answerJournaled: { requestId?: string } = {};
        // 先に書いた行が効かなかったとき（答えが届かなかった）の打ち消し。書けなければ跡だけ残す
        const retractAnswerJournal = async (detail: string): Promise<void> => {
          if (answerJournaled.requestId === undefined) return;
          await appendJournalOrDrop('manager_send', stores.journal, {
            type: 'decision',
            decision:
              `クローンが担当 ${managerId} の確認（${answerJournaled.requestId}）へ答えるとした直前の回答の行は` +
              `効いていない（答えは届いていない）。理由: ${excerptLine(detail, MANAGER_ANSWER_MESSAGE_EXCERPT)}`,
            grounds: '先に書いた回答の行の後で、答えが届かなかったため打ち消す',
          });
        };
        const send = async (pool: ManagerPool): Promise<ManagerSendResult> => {
          try {
            return await pool.send(managerId, message, {
              ...(decision === undefined ? {} : { decision }),
              ...(requestId === undefined ? {} : { requestId }),
              ...(handover.attachments.length === 0 ? {} : { attachments: handover.attachments }),
              beforeAnswer: async (pending) => {
                await appendJournalOrThrow(
                  'manager_send',
                  stores.journal,
                  {
                    type: 'decision',
                    decision:
                      `クローンが担当 ${managerId} の確認（${pending.requestId}: ` +
                      `${excerptLine(pending.summary, JOURNAL_TEXT_EXCERPT)}）に自分で答える` +
                      `（decision=${decision ?? '指定なし（runner が本文から読む）'}。` +
                      `抜粋: ${excerptLine(message, MANAGER_ANSWER_MESSAGE_EXCERPT)}）`,
                    grounds:
                      'クローン自身が manager_send で、人間に聞かずに答えた（根拠は記憶。人間はこれを読んで後から否定する）',
                  },
                  'act-not-performed',
                );
                answerJournaled.requestId = pending.requestId;
              },
            });
          } catch (error) {
            await retractAnswerJournal(`送信が例外で終わった: ${reasonOf(error)}`);
            throw error;
          }
        };
        const result = await send(context.managers);
        if (result.outcome !== 'answered') await retractAnswerJournal(result.detail);
        // 届いた（delivered）か答えた（answered）ときだけ閉じる。それ以外は本来の作業が通っていない
        const sent = result.outcome === 'delivered' || result.outcome === 'answered';
        // 既存の委譲へ頼んだターンも、委譲に数える（その委譲に結び付いた task〔Job.taskId〕を、このターンの返答で自動 done にしない。#5469 P5）
        if (sent) context.noteDelegationStarted?.(await jobTaskIdOf(stores, managerId));
        // `session_missing` は必ず言い足す: そのものは居る側なので、`manager_start` で起こし直すと同じ仕事が2本になりうるため
        if (result.outcome === 'session_missing') {
          return notDone(
            text(
              `[${managerId}] ${result.detail}\n` +
                '**この委譲そのものは台帳に在る**（「そんな id は無い」ではない）。' +
                'runner に生きたセッションが無く、resume でも入り直せなかっただけである。' +
                'manager_list で状態を確かめ、時間で解ける理由（引き取り中・貸し出し期限）' +
                'なら少し置いてから送り直すこと。' +
                RESTART_BEFORE_CHECK_ADVICE,
            ),
          );
        }
        // 警告の文は HTTP（POST /managers/:id/messages）と共有する（`decisionUnusedNote`）
        const unusedNote = decisionUnusedNote(decision, requestId, result.outcome);
        if (result.outcome === 'held') return notDone(text(`${result.detail}${unusedNote}`));
        // 「届けた」が保証する範囲を名乗る: 観測したのは resume の口が成功を返したところまでで、相手がこの本文を読んだかは見ていないため
        // 「同じ本文で立て直さないこと」は落とさない: 送った直後の `manager_list` が `lost` のままで、クローンが指示を失ったと判断し出し直した実害があるため
        if (result.outcome === 'delivered') {
          // 毎回返る文なので短く保つ（理由の詳しい説明は道具の説明文の側に1回だけ置く）: 送るたびにクローンの文脈へ積まれ、読み直しの費用になるため
          // 脚注は同じ会話の2回目から札にする（結論の「同じ本文で新しい委譲を立てない」は札にも残す）。返す直前のここで呼ぶ
          const deliveredNote = foldFixedFor(context, extra)(
            'manager-send:delivered-note',
            '（「届けた」は resume の口が成功を返したところまで。読んだかは manager_report で見る。' +
              '同じ本文で新しい委譲を立てないこと）',
            '（届けたのは resume の口まで。同じ本文で新しい委譲を立てないこと）',
          );
          return finishWithCloses(
            stores,
            text(`[${managerId}] ${result.detail}${unusedNote}\n${deliveredNote}`),
            closes,
            sent,
            'manager_send',
          );
        }
        return finishWithCloses(stores, text(result.detail), closes, sent, 'manager_send');
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
        `同じ会話で前回に全文で出した行と1字も変わらない行は「- <managerId> ${MANAGER_ROW_SAME_MARK}」の1行に畳む（⚠・lost・失敗の行は畳まない）。畳んだ件数は一覧に出る。全部を全文で引き直すなら refetch: true。`,
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
          '（未 push の実装・未コミットの変更が無いことも確かめたうえで）。' +
          '何を畳んだ・見送ったかは runner_list の応答と日誌（journal_read、decision）に出る。',
        '走行中・返事待ち（running / waiting_human）を先に出し、次に lost（前のセッションへ戻れなかったもの。' +
          '成果がリモートに届いているかを誰も確かめていない＝判断待ちである）、' +
          'そのあとに残りの終端（done / failed / stopped）を出す。' +
          '各群の中は startedAt の新しい順である。',
        // status の説明は欄（status の describe）へ集めてある: 2か所に分かれていると、読み手が欄だけ見て呼ぶときに片方を取りこぼすため
        'q で依頼文の全文・managerId・直近の報告の本文・未 push の観測にある枝の名前を部分一致で探せる（依頼文の札や語、持っている PR の番号、作業中の枝で担当を探すとき。大文字小文字・全角半角は区別しない）。status と併用できる。' +
          '各行の退避 ref は件数と最新の1件だけで、全部は manager_report を rescueAll: true で呼ぶと、退避 ref を作業ツリーごとに全部出す。',
        '絞った先が予算で切れたら、断り書きが次に打つ cursor を案内する。それを cursor へ渡すと続きから読める。',
        '認証トークンの世代の行（`describeTokenGeneration` の doc）が出ているマネージャーでは、' +
          'この委譲が最後に起こした／自動で開き直した時点の世代と、いまの現役の世代を比べられる。' +
          '⚠ が付いていれば世代が食い違っている——回した直後の短い遅れなら自然に消える。' +
          `429 が続いたまま消えないなら、起こし直すこと。${STALE_TOKEN_RESTART_ADVICE}` +
          '世代が測れていないときも行は出る——' +
          '「分からない」の理由（プール未配線／未観測／デーモンの再起動をまたいだ引き取り）を' +
          '名乗る。再起動をまたいだ場合だけ manager_stop → manager_start が効く。',
        '429 で落ちたとき、SDK が返す文言に書かれていた resets 時刻を、認証トークンの' +
          'プールの各鍵の冷却期限と突き合わせた行も出ることがある。「世代ずれの疑い」なら、' +
          'この委譲は現役ではない古い鍵を掴んだまま走っている可能性が高い——鍵が通る状態へ' +
          '戻っても、このセッション自身は起こし直すまで戻らない。' +
          '「待てば戻る」なら、現役の鍵自身がいま冷却中なだけで世代ずれではなく、対処は要らない。' +
          '行が出ないのは「健全」ではなく「まだ判定できない」という意味である——' +
          '429 の通知がまだ届いていないか、文言・プールのどちらとも一致しなかったかのどちらか。' +
          '上の世代番号の比較が既に食い違いを名指ししているときは、二重に鳴らさないので' +
          'この行は出ない。',
      ].join(' '),
      {
        // `jobStatusSchema` をそのまま使う: 綴りを間違えた呼びが「その状態のものは0件」として返り、絞り込みが効いていないことに気づけない形を作らないため
        status: z
          .array(jobStatusSchema)
          .optional()
          .describe(
            '例 {"status":["waiting_human"]}。配列で渡し、値は引用符で囲む。' +
              '状態（running / waiting_human / done / failed / lost / stopped の6つ。`waiting` ではなく `waiting_human`）で絞る。' +
              '省略すると絞らない。走っているものだけを見たいなら ["running","waiting_human"]。' +
              // `[]` の倒し方はクローンが読む面にも書く: 他の一覧は `[]` を0件として扱うので、ここだけ違うことを黙っていると読み手が「0件だ」と読むため
              '空の配列 [] も絞らない（渡さなかったのと同じ全件が出て、応答に「絞らずに全件を出した」と書く）。' +
              '**journal_read の types とは倒し方が違う**（あちらは [] を0件として扱う）。' +
              '先頭の件数の行は絞る前の全体を出す',
          ),
        q: z
          .string()
          .optional()
          .describe(
            '依頼文の全文・managerId・直近の報告の本文・未 push の観測にある枝の名前に部分一致で絞る（例: 依頼文の札 "WORLDBUILD-7"、PR の番号 "6387"、枝 "feat/mob-add-kinds"）。' +
              '大文字小文字は区別せず、全角と半角は NFKC で揃えて比べる（【】と [] のような別の字は揃わない）。' +
              'status と併用できる（両方に当たるものだけが出る）。' +
              '省略・空文字・空白だけは絞らない（応答にその旨が出る）。' +
              '先頭の件数の行は絞る前の全体を出す。0件のときは q の値つきでそう言う',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            '一覧の続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す' +
              '（自分で組み立てない）。省略すると先頭から。' +
              'status と q はカーソルを取った呼びと揃えること（食い違うと明示のエラーになる）。',
          ),
        refetch: z
          .boolean()
          .optional()
          .describe(
            `真なら、前回と変わらず「${MANAGER_ROW_SAME_MARK}」に畳まれる行・受信箱の内訳も全文で出し直す（会話の上の全文を見失ったとき）`,
          ),
      },
      async ({ status, q, cursor, refetch }, extra: unknown) => {
        if (!context.managers) return NO_POOL;
        // サブエージェントの呼びは全文で返し、控えも更新しない: 札が指す全文はサブエージェントの文脈にしか載らず、本体の控えが「出した」になるのを防ぐ
        const fold = isSubagentCaller(context, extra)
          ? NO_FIXED_FOLD
          : (context.foldFixed ?? NO_FIXED_FOLD);
        const managers = await context.managers.list();
        // この一覧ぜんぶで同じ「いま」を使う: 行ごとに `new Date()` を呼ぶと、同じ応答の中で判定の基準がずれるため
        const now = new Date();
        // 受信箱の滞留は早期リターンの前に確かめる: マネージャーが1本も居なくても合図が溜まっていることがあるため
        // 文にするのは返す直前: 固定の言い回しの `fold` は呼んだ時点で「会話に出した」と控えるので、cursor の誤りなどで返す別の応答の手前で呼ぶと、出していない全文を出したことにしてしまうため
        const inboxPeek = await context.stores.inbox.peekPending();
        const inboxPeekedAt = Date.now();
        const inboxQueued = context.queuedInMemory?.();
        const renderInboxBacklog = (): string =>
          describeInboxBacklog(inboxPeek, inboxPeekedAt, inboxQueued, fold, refetch === true);
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
              renderInboxBacklog(),
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
        // `q` は依頼文の全文（`manager.request`。一覧に出す抜粋ではない）と managerId に当てる: 抜粋に当てると、抜粋の後ろに在る札や語で探せないため
        // 両側を NFKC に揃えて小文字にする: 全角の【】・英数と半角、英字の大小を呼び手が合わせなくても当たるように
        // 空白だけの `q` は絞らない側へ倒す（`status: []` と同じ。0件へ倒すと絞りを外した呼びが「マネージャーが消えた」ように見える）
        const queryNeedle = q === undefined ? '' : normalizeManagerQuery(q);
        const queryFiltering = queryNeedle !== '';
        const statusView = filtering
          ? attention.filter((manager) => status.includes(manager.status))
          : attention;
        const view = queryFiltering
          ? statusView.filter((manager) =>
              managerQueryHaystacks(manager).some((text) =>
                normalizeManagerQuery(text).includes(queryNeedle),
              ),
            )
          : statusView;
        // cursor は `status` と `q` で絞った後・予算で切る前で解決する: 順序を変えると絞りに当たらない行が窓を食い尽くすため
        const cursorStatus = normalizeManagerCursorStatus(status);
        const cursorQuery = queryFiltering ? queryNeedle : null;
        const cursorOutcome = resolveManagerCursor(
          view,
          managerPositionOf,
          cursorStatus,
          cursor,
          cursorQuery,
        );
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
        if (cursorOutcome.kind === 'q-mismatch') {
          return text(
            `cursor は q: ${cursorOutcome.cursorQuery === null ? '絞っていない' : JSON.stringify(cursorOutcome.cursorQuery)} の一覧から出た続きの位置で、` +
              `いまの呼び（q: ${queryFiltering ? JSON.stringify(q) : '未指定または空'}）と食い違う。` +
              'q を cursor を取ったときと揃えて呼び直すか、cursor を付けずに先頭から呼び直すこと。',
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
              hasHeldMessages: manager.heldMessages !== undefined,
              lastTurnEndedAt: manager.updatedAt,
            },
            now,
          );
          const marks = new Set<ManagerListNoteMark>();
          if (manager.runnerLostSince !== undefined) marks.add('runner-lost');
          if (manager.sessionMissingSince !== undefined) marks.add('session-missing');
          if (manager.status === 'lost') marks.add('lost');
          const entry = renderListingEntry({
            id: manager.managerId,
            title: `[${describeManagerState(manager.status, manager.live, manager.awaitingBackground)}]`,
            createdAt: manager.startedAt,
            updatedAt: manager.updatedAt,
            summary: `依頼: ${excerptLine(manager.request, LIST_REQUEST_EXCERPT)}`,
            extra: [
              // 行ごとに同じ長い固定文を繰り返さない（#5347）: 行には印と固有の値（since・kind）だけを残し、印の意味は一覧の末尾に1回だけ書く（`managerListNotes`）
              // runnerId は空欄にしない: 空欄だと「取れていない」のか「読み忘れ」なのか区別できないため「未記録」と書く
              // 断定は「器が黙っている」までにする: その中で走っていたかはこの観測から言えない
              // 「いま話しかけられない」と書かない: 名簿が `lost` と判定した器の委譲へも `send()` は実際に届くため
              `  runner: ${manager.runnerId ?? '未記録'}${
                manager.runnerLostSince === undefined
                  ? ''
                  : `（この器は ${manager.runnerLostSince} 以降 名乗っていない${MANAGER_LIST_NOTE_MARKS['runner-lost']}）`
              }`,
              // 取れない側は「不明」と書き、既定の帯（opus / sonnet）と推測しない
              `  モデル: ${describeManagerModels(managerModelsOf(context.managers, manager))}`,
              // 別の行として出し `describeManagerState` は動かさない: `manager_list` と要約で字面が割れるのを防ぐための関数のため
              manager.sessionMissingSince === undefined
                ? null
                : `  ⚠ 宛先の runner は ${manager.sessionMissingSince} の時点で、この委譲のセッションを持っていなかった${MANAGER_LIST_NOTE_MARKS['session-missing']}。` +
                  // 由来を畳まない: 「resume でも入り直せなかった」と「名簿に載っていなかっただけ」では読み手の次の一手が違うため
                  describeSessionMissingKind(manager.sessionMissingKind),
              `  cwd: ${manager.cwd}`,
              // `lost` を状態名だけで済ませない: 「終わった」と読まれると完了していない仕事がそのまま片付くため
              // 言い切るのは観測した分までにする: 落ちる直前にマージまで済ませていた仕事が、その
              // 1分半後の器の作り直しで `lost` になり、この行が「途中で失われて
              // いる（完了ではない）」と嘘をついた実害があるため
              manager.status === 'lost'
                ? `  ⚠ 前のセッションへ戻れなかった${MANAGER_LIST_NOTE_MARKS.lost}。`
                : null,
              describeJobOrigin(origins, manager.managerId),
              // 前任・後継は短く1行で出す: 自動の起こし直しの対象外か、どれの後継かを一覧で読めるように（#4861）
              manager.supersededBy === undefined
                ? null
                : `  後継: ${manager.supersededBy}（以後は自動で起こさない）`,
              manager.supersedes === undefined ? null : `  前任: ${manager.supersedes}`,
              unobservedOutcomeLine(manager),
              // 拒否は `status` に映らないので、状態の値は増やさず状態に添える
              denialLine(context.managers?.denials(manager.managerId) ?? [], manager.lastReportAt),
              // 拒否の行の直後に置く: 上限を越えた担当は、この後の返事待ちが分類器の倒した確認で埋まりうるため、返事待ちより先に読ませる
              describeDenialStreakForList(manager.classifierDenials),
              peerApprovalsLine(manager.pendingPeerApprovals),
              // 待ちの要約も抜粋を通す: `AskUserQuestion` の経路は質問文を連ねて runner 側のキャップを通らないため
              // 件数にも上限を置く: `manager.waiting` は増える一方で、伸びると1本のマネージャーが予算を占有し他が押し出されるため
              ...manager.waiting
                .slice(0, MANAGER_WAITING_LIST_LIMIT)
                .map(
                  (item) =>
                    `  返事待ち(requestId: ${item.requestId}, ${describeWaitingKind(item.kind)}, ` +
                    `${item.askedAt} から): ${excerptLine(item.summary, LIST_WAITING_EXCERPT)}`,
                ),
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
              describeUnpushedWorkObservation(manager, 'brief', now),
              // `describeWithheldReports` はここには足さない: 「背景処理待ち×N」の `tasks` と並べると別行でも混同が起き、行を増やしても読み手の次の一手は変わらないため
            ],
          });
          return { entry, marks, manager };
        });
        const itemTexts = items.map((item) => item.entry);
        // 末尾の注は予算の内側で数える: 外に置くと lost が多い一覧で LIST_BUDGET を越える。出る行が減れば要る注も減るので、2回目の締めは1回目の部分集合で収まる
        const firstFill = fillListingBudget(itemTexts, LIST_BUDGET, false);
        const firstNotes = managerListNotes(
          items.slice(0, firstFill.shown).map((item) => item.marks),
        );
        const secondFill = fillListingBudget(
          itemTexts,
          Math.max(0, LIST_BUDGET - firstNotes.length),
          false,
        );
        // 予算は全文の長さで測り（畳んだ分は余るだけ）、畳む呼びはこの1回だけにする
        const noteBlock = managerListNotes(
          items.slice(0, secondFill.shown).map((item) => item.marks),
          fold,
        );
        // 前回と変わらない行を短い1行にする。対象は予算の内側で全文のまま出る行だけ（省略された行・切り詰めた先頭行は「出した」と控えない）
        const rowLines = secondFill.lines.map((line, index) => {
          const item = items[index]!;
          if (line !== item.entry || managerRowAlwaysFull(item.manager, line)) return line;
          const folded = fold(
            `${MANAGER_LIST_ROW_FOLD_PREFIX}${item.manager.managerId}\u0000${rowFingerprint(line)}`,
            line,
            managerRowRef(item.manager),
            `${MANAGER_LIST_ROW_FOLD_PREFIX}${item.manager.managerId}\u0000`,
          );
          return refetch === true ? line : folded;
        });
        const foldedRows = rowLines.filter(
          (line, index) => line !== secondFill.lines[index],
        ).length;
        return text(
          dedupeRestartAdvice(
            foldRowPhrases(
              [
                // 本数は一覧の外に出す: 一覧は予算で打ち切られ、出ている行を数えても全体の本数にならないため。件数は絞る前の全件で出す: 絞りのせいで全体の実像が見えなくなる形にしないため
                describeManagerCounts(managers, fold),
                unreadableJobNote,
                // 絞り込みの注記の固定の言い回しは `fold` に包む。絞りの値・件数は毎回出す
                // 絞ったことは件数の行とは別の行で言う: 混ぜると「絞る前の全体」と「絞った後」がどちらの数なのかを読み分ける負担が読み手に移るため
                // `status: []` は「絞らなかった」と言う: 黙って無視しないため
                status === undefined
                  ? null
                  : filtering
                    ? `絞り込み: status: ${status.join(',')} に当たるのは ${statusView.length} 件で、` +
                      `この一覧は${queryFiltering ? 'その中の q にも当たるものだけ' : 'その中だけ'}を出している` +
                      fold(
                        'manager-list:filter-status-scope',
                        FILTER_COUNTS_SCOPE_FULL,
                        FILTER_COUNTS_SCOPE_REF,
                      )
                    : '絞り込み: status に空の配列が渡ったので、絞らずに全件を出した' +
                      fold(
                        'manager-list:filter-status-empty',
                        FILTER_STATUS_EMPTY_FULL,
                        FILTER_STATUS_EMPTY_REF,
                      ),
                // `q` の注記も件数の行とは別の行で言う。空白だけの `q` は黙って無視せず、絞らなかったと言う
                q === undefined
                  ? null
                  : queryFiltering
                    ? `絞り込み: q: ${JSON.stringify(q)}` +
                      fold('manager-list:filter-q-match', FILTER_Q_MATCH_FULL, FILTER_Q_MATCH_REF) +
                      `に当たるのは ${view.length} 件` +
                      `${filtering ? `（status で絞った ${statusView.length} 件の中）` : `（全 ${managers.length} 本の中）`}で、` +
                      'この一覧はその中だけを出している' +
                      fold(
                        'manager-list:filter-q-scope',
                        FILTER_COUNTS_SCOPE_FULL,
                        FILTER_COUNTS_SCOPE_REF,
                      )
                    : '絞り込み: q が空（または空白だけ）だったので、q では絞らなかった' +
                      fold('manager-list:filter-q-empty', FILTER_Q_EMPTY_FULL, FILTER_Q_EMPTY_REF),
                // 絞った結果が0件なのと委譲が1本も無いのを分ける: 「無い」と読めると、絞りが厳しかっただけなのに台帳の側を疑うことになるため
                view.length === 0
                  ? queryFiltering
                    ? `（${filtering ? 'この status と ' : ''}q: ${JSON.stringify(q)} の絞り込みに当たる委譲は0件だった。絞る前の件数は上の行に在る）`
                    : '（この status の絞り込みに当たる委譲は無い。絞る前の件数は上の行に在る）'
                  : // cursor で辿り切った最後の頁を、絞り込みの0件とは別の文にする
                    paged.length === 0
                    ? '（cursor より後ろの、この絞り込みに当たる委譲は無い。これが最後の頁）'
                    : renderFilledListing(rowLines, secondFill, {
                        // `status` の有無ではなく `filtering` で分ける: `status: []` は絞っていないので、有無で分けると渡した文字が無いのに絞ったと言う嘘になるため
                        // 母数は `renderListing` が渡す `total` ではなく `view.length` を使う: 頁が進んでも変わらない数にするため
                        omitted: ({ rest, shown }) => {
                          const total = view.length;
                          const lastShown = paged[shown - 1]!;
                          const nextCursor = encodeManagerCursor({
                            ...managerPositionOf(lastShown),
                            status: cursorStatus === null ? null : [...cursorStatus],
                            q: cursorQuery,
                          });
                          const statusArg = filtering ? ` status=${JSON.stringify(status)}` : '';
                          const queryArg = queryFiltering ? ` q=${JSON.stringify(q)}` : '';
                          const narrowed = [
                            filtering ? `status: ${status.join(',')}` : null,
                            queryFiltering ? `q: ${JSON.stringify(q)}` : null,
                          ].filter((part): part is string => part !== null);
                          return (
                            `…ほか ${rest} 件は省略（` +
                            (narrowed.length > 0
                              ? `${narrowed.join(' と ')} に絞った ${total} 件のうち ${shown} 件を出した`
                              : `全 ${total} 件`) +
                            '）。' +
                            fold(
                              'manager-list:omitted-order',
                              OMITTED_ORDER_FULL,
                              OMITTED_ORDER_REF,
                            ) +
                            // cursor は毎回変わる（位置・絞りを含む）ので畳まない: 畳むと続きが取れなくなる
                            `続きは manager_list cursor=${nextCursor}${statusArg}${queryArg} で取れる（status と q は同じまま呼ぶこと）。` +
                            fold(
                              'manager-list:omitted-paging',
                              OMITTED_PAGING_FULL,
                              OMITTED_PAGING_REF,
                            )
                          );
                        },
                      }),
                foldedRows === 0
                  ? null
                  : `前回と同じ行 ${foldedRows} 本は省いた（上の「${MANAGER_ROW_SAME_MARK}」の行。順序は変えていない）。` +
                    '全文は manager_report <managerId>、一覧を丸ごと引き直すなら manager_list に refetch: true',
                '（依頼と報告は抜粋。全文は manager_report <managerId> で取れる）',
                noteBlock === '' ? null : noteBlock,
                renderInboxBacklog(),
                runnerBacklog,
              ]
                .filter((line): line is string => line !== null)
                .join('\n'),
              fold,
            ),
          ),
        );
      },
    ),

    tool(
      'manager_report',
      [
        'マネージャーの依頼文・直近の報告を全文で読む。',
        'manager_list は抜粋なので、欠落に気づいたらここで全部読むこと。',
        'manager_list の行は退避 ref を件数と最新の1件しか出さない。ここ（manager_report）も報告の本文の前に、退避 ref を既定では種類ごとの本数に畳んで出す:',
        '生きている退避 ref（最新の1件つき）・消し終えた ref（消した理由ごと）・生きている間に消えた作業ツリー・送るもの無しは本数だけで、',
        '退避できていない（失われうる）作業ツリー（未追跡・submodule・送れなかった失敗）は、本数と代表の1本の行を必ず出す。',
        '全部（ref 名・退避できていない作業ツリーのすべて）は rescueAll: true で作業ツリーごとに読む。',
        '長い場合は続きの取り方が末尾に出るので、最後まで読み切ること。',
        'それでも足りない（報告に書かれていない中身を確かめたい）ときは manager_transcript で生ログまで降りられる。',
        '直近の報告の全文が既にあなたの発言（会話の上）に載っているときは、本文を繰り返さず、載っている時刻を示す注記だけを返す。引き直したいときは refetch: true を付ける（offset で頁を送る・依頼文は影響を受けない）。',
        '全文が載っている報告に未 push などの状態の注記だけが要るなら、引き直さず manager_list の行を見る。',
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
        rescueAll: z
          .boolean()
          .optional()
          .describe(
            '真なら退避 ref を畳まず作業ツリーごとに全部出す（既定は、種類ごとの本数と、退避できていない作業ツリーの本数・代表の1本だけ）',
          ),
        refetch: z
          .boolean()
          .optional()
          .describe(
            '真なら、報告の全文が既に会話の上に載っていても本文を必ず返す（既定は、載っているときは注記だけ返す）',
          ),
      },
      async (
        { managerId, part = 'report', offset = 0, rescueAll = false, refetch = false },
        extra: unknown,
      ) => {
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
          const unpushedWork = unpushedWorkReportNote(found, rescueAll);
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

        // 失敗した回は「報告」と呼ばない: 見出しが「直近の報告」のままだと、⚠ を見た直後に包みの内側だけを読んで報告として扱うため
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
        const unpushedWork = part === 'request' ? null : unpushedWorkReportNote(found, rescueAll);
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
        // 本文だけを畳む: 状態の注記（失敗・拒否・退避 ref など）は発言の後に変わりうるので残す。依頼文・頁送り（offset > 0）・refetch は従来どおり本文を出す
        const shownAt =
          part === 'report' && offset === 0 && !refetch && !isSubagentCaller(context, extra)
            ? (context.managerReportShownAt?.(managerId, body) ?? null)
            : null;
        if (shownAt !== null) {
          return text(
            `${head}\n\n${modelLine}\n\n${driftNote}${failureNote}${usageStoppedNote}${runnerVanishedNote}${systemErrorNote}${cgroupEventsNote}${denialNote}${unobservedNote}${unpushedWorkNote}${withheldReportsFooterNote}` +
              `この報告の全文（${body.length.toLocaleString('en-US')} 文字）は ${shownAt.toISOString().slice(11, 16)}Z の発言に載っている（会話の上）。` +
              '引き直すには `refetch: true` を付ける。' +
              `\n\n（さらに掘るなら manager_transcript managerId=${managerId} で生ログへ）`,
          );
        }
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

    // いまのターンの会話そのものへは書かない: ターンの返答が届くので、道具で書くと同じ画面に返答が2通並ぶため
    // 宛先は task の起点の会話に固定する（会話 id の引数・新規会話の生成は持たない）。閉じた task にも書ける（報告を後から出すため）
    tool(
      'task_say',
      [
        'task の起点の会話へ1通書く。宛先は task の起点の会話に固定で、会話 id は選べない。いまのターンが人間の発言で起きたものでなくても届く（定期の仕事・外部イベント・委譲の報告を人間へ知らせる口）。',
        '閉じた task にも書ける（報告を後から出すため）。',
        'task が無い、または起点の会話を持たない古い task なら、何も書かずに断る（古い task は task_add で足し直す）。',
        'いまのターンの会話へは書けない（そこへは普通に返答すれば届く。添付なら reply_attach）。',
        '知らせるだけで、答えは待たない。確認や承認が要るなら ask_human を使うこと。',
        '人間へファイルを渡すなら、先に file_put で置き場へ入れ、その id を attachments に渡す（添付があれば text は空でもよい。どちらも空の発言は書かない）。',
        '添付の検査（存在・個数・合計の上限）に1つでも落ちたら、何も書かずに断る。',
        '知らせるためだけに足した task は、書いたら done にして閉じる。続ける仕事の task は、書いた会話が返答に数えられて器が自動で done にしないよう、task_keep で「続く」の印を付ける（queued で印の無い task は、このターンの終わりに自動で done になりうる）。',
        '日誌には人間との往復（あなたの発言）として残る。',
      ].join(' '),
      {
        taskId: z
          .string()
          .describe(
            `書く先の task の id（task_list に出ている id。閉じた件も可。${formatStringLengthJa({ min: 1 })}）`,
          ),
        text: z
          .string()
          .optional()
          .describe(
            `人間へ届ける本文（添付が無いとき必須。${formatStringLengthJa({ min: 1 })}。添付があれば省略か空でもよい）`,
          ),
        attachments: z
          .array(z.string().min(1))
          .optional()
          .describe(
            '添える添付の id（file_put の応答の id）。1発言に添えられる個数・合計には人間の発言と同じ上限がある。' +
              'どこにも結ばれていない添付は、この発言の会話へ結ばれる',
          ),
      },
      async ({ taskId, text: rawBody, attachments: attachmentIds }) => {
        const withAttachments = attachmentIds !== undefined && attachmentIds.length > 0;
        if (!withAttachments) {
          if (rawBody === undefined) {
            return text('text か attachments のどちらかが要る（どちらも空の発言は書かない）。');
          }
          const textError = describeStringLengthViolation('text', rawBody, { min: 1 });
          if (textError !== null) return text(textError);
        }
        const body = rawBody ?? '';
        const taskIdError = describeStringLengthViolation('taskId', taskId, { min: 1 });
        if (taskIdError !== null) return text(taskIdError);
        let task: Task | null;
        try {
          task = await stores.tasks.get(taskId);
        } catch (error) {
          if (error instanceof UnreadableTaskError) {
            return {
              ...text(`task ${taskId} は読めない形で入っている。何も書かなかった。`),
              isError: true,
            };
          }
          throw error;
        }
        if (task === null) {
          return {
            ...text(
              `task ${taskId} は無いので、何も書かなかった（task_list で実在する id を確かめること）。`,
            ),
            isError: true,
          };
        }
        const target = task.originConversationId;
        if (target === undefined) {
          return {
            ...text(
              `task ${taskId} は起点の会話を持たない古い task なので、何も書かなかった。task_add で足し直すと起点の会話が付く。`,
            ),
            isError: true,
          };
        }
        // 解決を挟まず、そのままの一致で断る: いまのターンの会話は、1通目がまだ日誌に載っていないことがあるため
        if (target === getConversationId()) {
          return {
            ...text(
              `task ${taskId} の起点の会話 ${target} はいまのターンの会話なので、この道具では書かなかった。` +
                (withAttachments
                  ? 'このターンの返答に添付を添えるなら reply_attach を使う。'
                  : 'このターンの返答として書けば、その会話へ届く。'),
            ),
            isError: true,
          };
        }
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
            'task_say',
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
        context.noteTaskSaid?.(taskId);
        if (attached.refs.length === 0) context.postToConversation?.(target, body);
        else context.postToConversation?.(target, body, attached.refs);
        const withNote =
          attached.refs.length === 0 ? '' : `（添付 ${attached.refs.length} 件つき）`;
        return text(
          `task ${taskId} の起点の会話 ${target} へ書いた${withNote}（${entry.id}）。` +
            (!isTaskClosed(task.status)
              ? '\n知らせるだけの task なら task_set_status で done にすること。'
              : ''),
        );
      },
    ),

    tool(
      'file_put',
      [
        'あなたの手元（デーモンの側）のファイルを、添付の置き場へ入れる。人間へファイルを渡す最初の段で、',
        '返る id を reply_attach（いまのターンの返信に添える）か task_say の attachments（task の起点の会話へ書く）に渡すと、人間の画面に添付として出る。',
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
                '人間へ渡すなら reply_attach か task_say の attachments に id を渡す。'
              : '会話に添える（reply_attach、または task_say の attachments）まで、この添付は1時間で消える。' +
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
        conversationId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'この会話に結ばれた添付だけ（完全な id か、1つの会話に決まる 8 文字以上の先頭）',
          ),
        query: z.string().min(1).optional().describe('名前の部分一致（大文字小文字を問わない）'),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe('続きの位置。前回の応答の「続きは file_list cursor=…」をそのまま渡す'),
      },
      async ({ kept, from, conversationId: conversationIdInput, query, cursor }) => {
        try {
          // 一意に決まる 8 文字以上の前方一致だけ読み替える（#5130）。当たらない id は今どおりそのまま絞る
          let conversationId = conversationIdInput;
          let resolvedNote = '';
          if (conversationIdInput !== undefined) {
            const resolution = await resolveConversationId(stores.journal, conversationIdInput);
            if (resolution.kind === 'ambiguous') {
              return text(
                `置き場の一覧は読んでいない。${describeUnresolvedConversation(conversationIdInput, resolution)}`,
              );
            }
            if (resolution.kind === 'prefix') {
              conversationId = resolution.id;
              resolvedNote = `${describeResolvedConversationPrefix(conversationIdInput, resolution.id)}\n`;
            }
          }
          return text(
            resolvedNote + (await listFiles(stores, { kept, from, conversationId, query, cursor })),
          );
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
        '控えが読めなかった無い id（期限切れで消えた・id の誤り）は「無い」と返り、日誌には何も書かない。控えを読んだ後に消えていたときは、消す行と打ち消しの行が日誌に残る。',
        '外部の置き場に預けた中身は先に消す。置き場から消せなかったときは「消していない」と理由が返り（控えも写しも残る）、日誌に断った旨の行が足される。もう一度呼ぶと再試行する。',
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
              async (meta, reason) => {
                // 断った後に足す行: 先に書いた「消す」の行だけでは、日誌が消したように読める。書けなくても断りの結果は変えない
                await appendJournalOrDrop('file_delete', stores.journal, {
                  type: 'decision',
                  decision: `添付の中身を置き場から消せなかったので、消していない（控えも残した）: ${meta === undefined ? `id=${id}` : `${meta.name}（id=${meta.id}）`}`,
                  grounds: `理由: ${reason}。直前の「消す」の行は実行されていない。もう一度 file_delete で再試行できる。`,
                });
              },
              async (meta) => {
                // 控えを読んだ後に別の手で消えていた回: 先に書いた「消す」の行はこの呼びでは実行されていない。書けなくても「無い」の結果は変えない
                await appendJournalOrDrop('file_delete', stores.journal, {
                  type: 'decision',
                  ...describeAttachmentAlreadyGoneRetraction(meta),
                });
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
        'いまのターンに会話が無いとき（定期の仕事・外部イベントが起点で返信先が無い）は使えない。task の起点の会話へ渡すなら task_say の attachments を使う。',
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
                '人間へ渡すなら task_say の attachments に id を渡す。',
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
        '人間が送ったあとクローンへ届く前に取り下げた発言は、conversationId・q の読みでは外さず「（取り下げた発言。クローンへは届いていない）」と付けて出す（依頼として扱わない。会話の一覧の件数はこれを除く）。取り下げの印を読めなかった回は、有無を判定できなかったと言う。',
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
          .describe(
            'この会話の中身を古い順に読む（一覧に出ている conversationId か、1つの会話に決まる 8 文字以上の先頭）',
          ),
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
              '数えない。conversationId を指定したときは、その会話の人間との往復だけを数える）。遡り切れたかは応答の注記で分かる',
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
      async (
        {
          conversationId: conversationIdInput,
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
        },
        extra: unknown,
      ) => {
        const fold = isSubagentCaller(context, extra)
          ? NO_FIXED_FOLD
          : (context.foldFixed ?? NO_FIXED_FOLD);
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
          // 一覧は本文を抜粋して「全文は id で取れる」と案内するので、案内先でも取り下げを言う: 言わないと長い取り下げ済みの指示が生きた依頼に見える（#5456）。続きの頁（offset）でも毎回引く
          const withdrawnReading = describeWithdrawnReading(
            await lookupWithdrawnForMessages(stores.journal, entry.conversationId, [entry]),
            [entry],
            { single: true },
          );
          const part = page(entry.text, offset, CONVERSATION_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは conversation_read id=${entry.id} offset=${part.to}）`
            : '';
          return text(
            `${entry.at} [${roleLabel(entry.role)}] id=${entry.id}` +
              (entry.role === 'inbound' && withdrawnReading.isWithdrawn(entry)
                ? WITHDRAWN_MESSAGE_MARK
                : '') +
              `（${describePage(part)}）` +
              `\n\n${part.body}${tail}${attachmentLines(entry.attachments, '')}` +
              withdrawnReading.notes.map((note) => `\n${note}`).join(''),
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

        // 一意に決まる 8 文字以上の前方一致だけ読み替える（#5130）。
        // 当たらない id は今どおり窓の中で読み、「無い／この窓には無い」で答える（解決できなかったことでは断らない）
        let conversationId = conversationIdInput;
        const resolvedNoteLines: string[] = [];
        if (conversationIdInput !== undefined) {
          const resolution = await resolveConversationId(stores.journal, conversationIdInput);
          if (resolution.kind === 'ambiguous') {
            return text(
              `会話は読んでいない。${describeUnresolvedConversation(conversationIdInput, resolution)}`,
            );
          }
          if (resolution.kind === 'prefix') {
            conversationId = resolution.id;
            resolvedNoteLines.push(
              describeResolvedConversationPrefix(conversationIdInput, resolution.id),
            );
          }
        }

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
        let windowReachedStart = false;
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
          // 会話を名指したときはその会話だけをストア側で絞る: 全会話の窓を読んでから絞ると、他の会話の往復が `scan` を食い尽くして古い会話が「判定できない」になるため。
          const window = await readConversationWindowPage(stores.journal, {
            scan: scanLimit,
            ...(conversationId === undefined ? {} : { conversationId }),
            ...(since === undefined ? {} : { since }),
            ...(until === undefined ? {} : { until }),
          });
          entries = window.entries;
          windowReachedStart = window.reachedStart;
        }
        const scannedCount = listPage === undefined ? entries.length : listPage.scanned;
        // `since` を渡されたら「先頭に届いた」と言わない: `reachedStart` は行を出し切ったかだけで、`since` は LIMIT より先に効くため、混ぜると `since` より古い側に在りうるものを「無い」と言い切る
        // 終端は件数から推さない: 読めない行を捨てて短くなった窓を「先頭に届いた」と誤るため（一覧は `listPage.reachedStart`、それ以外は窓の `reachedStart`）
        const exhausted = listPage === undefined ? windowReachedStart : listPage.reachedStart;
        const reached = exhausted && since === undefined;
        const scanNote =
          `（${conversationId === undefined ? '' : 'この会話の'}人間との往復を ${scannedCount} 件遡った。` +
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
              [
                ...resolvedNoteLines,
                (reached
                  ? `会話 ${conversationId} に当たる発言は無い。`
                  : `会話 ${conversationId} は、この窓には無い（判定できない）。`) +
                  `\n${scanNote}`,
              ].join('\n'),
            );
          }
          const withdrawnLookup = await lookupWithdrawnForMessages(
            stores.journal,
            conversationId,
            matched,
          );
          const withdrawnReading = describeWithdrawnReading(withdrawnLookup, matched);
          let shownCount = matched.length;
          const lines = matched.map(
            (message) =>
              `${message.at} [${roleLabel(message.role)}] id=${message.id}` +
              (message.supersededBy === undefined
                ? ''
                : `（畳み込み済み。編集後は id=${message.supersededBy}）`) +
              (message.role === 'inbound' && withdrawnReading.isWithdrawn(message)
                ? WITHDRAWN_MESSAGE_MARK
                : '') +
              `\n  ${excerptRow(message.text, CONVERSATION_EXCHANGE_EXCERPT)}` +
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
          const renderedFromEnd = renderListingFromEnd(lines, {
            budget: CONVERSATION_LIST_BUDGET,
            // どちら側を落としたかを言う: 「N 件省略」だけだと続きの取り方を間違えるため
            omitted: ({ rest, shown, total }) => {
              shownCount = shown;
              return (
                `…この会話の**古い側** ${rest} 件は省略（この窓に ${total} 件あり、` +
                `新しい側から ${shown} 件だけ出した）。古い側を見るには until で窓を古い方へずらすこと。`
              );
            },
          });
          const withdrawnNotes = describeWithdrawnReading(withdrawnLookup, matched, {
            shown: shownCount === 0 ? [] : matched.slice(-shownCount),
          }).notes;
          return text(
            [
              ...resolvedNoteLines,
              renderedFromEnd,
              fold(
                'conversation-read:excerpt-note',
                '（本文は抜粋。全文は conversation_read id=<id> で取れる）',
                '（本文は抜粋。全文は id=<id>）',
              ),
              ...(supersededNote === undefined ? [] : [supersededNote]),
              ...withdrawnNotes,
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
          // 会話をまたぐ検索なので、会話を問わず印を引く（一覧の読みと同じ）
          const withdrawnLookup = await lookupWithdrawnForMessages(
            stores.journal,
            undefined,
            matched,
          );
          const withdrawnReading = describeWithdrawnReading(withdrawnLookup, matched);
          let shownCount = matched.length;
          const lines = matched.map(
            (message) =>
              `${message.at} [${roleLabel(message.role)}] id=${message.id}` +
              ` conversation=${message.conversationId ?? '(無し)'}` +
              (message.role === 'inbound' && withdrawnReading.isWithdrawn(message)
                ? WITHDRAWN_MESSAGE_MARK
                : '') +
              '\n' +
              `  ${excerptRow(message.text, CONVERSATION_EXCHANGE_EXCERPT)}` +
              attachmentLines(message.attachments, '  '),
          );
          const renderedMatches = renderListing(lines, {
            budget: CONVERSATION_LIST_BUDGET,
            omitted: ({ rest, shown, total }) => {
              shownCount = shown;
              return (
                `…ほか ${rest} 件は省略（"${q}" に ${total} 件当たり、新しい順に ${shown} 件だけ出した）。` +
                '省いたのは**古い側**である。scan を増やしても出てこない（当たりが増えるだけで、' +
                '切られる側は変わらない）ので、until で窓を古い方へずらすこと。'
              );
            },
          });
          const withdrawnNotes = describeWithdrawnReading(withdrawnLookup, matched, {
            shown: matched.slice(0, shownCount),
          }).notes;
          return text(
            [
              renderedMatches,
              fold(
                'conversation-read:excerpt-note',
                '（本文は抜粋。全文は conversation_read id=<id> で取れる）',
                '（本文は抜粋。全文は id=<id>）',
              ),
              ...withdrawnNotes,
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
              fold(
                'conversation-read:continuation-note',
                '（limit の上限や窓の外もこれで辿れる。続きが無くなれば、この行は出ない）',
                '（窓の外もこれで辿れる。続きが無ければ行は出ない）',
              ),
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
        notes.push(
          fold(
            'conversation-read:list-open-note',
            '（各会話の中身は conversation_read conversationId=<id> で古い順に読める）',
            '（中身は conversationId=<id> で読める）',
          ),
        );
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
        // 続きの頁は1枚目に取り寄せて絞った本文を使い回す: 頁ごとに全文（退避なら数十〜百 MB 級）を取り寄せて絞り直すと、そのたびにデーモンのループが止まるため（#4638）
        const cacheKey = transcriptPageCacheKey({ managerId, since, until, type, contains });
        const hasFilter =
          since !== undefined ||
          until !== undefined ||
          type !== undefined ||
          contains !== undefined;
        const reused = offset > 0 ? transcriptPages.get(cacheKey) : undefined;
        let snapshot: TranscriptPageSnapshot;
        if (reused !== undefined) {
          snapshot = reused;
        } else {
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
            const filtered = await filterTranscriptLinesYielding(rawBody, {
              since,
              until,
              types,
              contains,
            });
            body = filtered.body;
            const { totalLines, matchedLines, noTimestampLines, unparsableLines } = filtered.counts;
            // 「全X行のうちY行が当たった」は0件でも出す: 黙って空の本文を返すと「絞りが効いていない」のか「本当に0件だった」のか区別できないため
            const noteLines = [
              `絞り込み: 全 ${totalLines} 行のうち ${matchedLines} 行が当たった。`,
            ];
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
          snapshot = {
            body,
            filterNote,
            ...(archiveId === undefined ? {} : { archiveId }),
            fetchedAt: new Date().toISOString(),
          };
        }

        const part1 = page(snapshot.body, offset, TRANSCRIPT_PAGE);
        // 続きが残る間だけ覚え、最後の頁を出したら捨てる: 読み終えた本文をヒープに残さないため
        if (part1.more) transcriptPages.set(cacheKey, snapshot);
        else transcriptPages.clear();
        const archiveNote =
          snapshot.archiveId === undefined
            ? ''
            : `（archive id: ${snapshot.archiveId}。archive_remove archiveId=${snapshot.archiveId} で消せる）`;
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
        // 使い回した頁にはいつの生ログかを添える: 1枚目より後に書かれた行は載らないため
        const reuseNote =
          reused === undefined
            ? ''
            : `\n（この頁は1枚目を読んだ時点（${snapshot.fetchedAt}）の生ログを使い回している。それより後の行は offset を付けずに読み直すと載る）`;
        return text(`${snapshot.filterNote}${head}${reuseNote}\n\n${part1.body}${tail}`);
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
        // 消す・日誌を書くより前に断る（`archive_remove_many` と同じ2検査）: 理由が空の「本文を消す」行が日誌に残るため
        const summaryError =
          describeStringLengthViolation('summary', summary, { min: 1 }) ??
          describeBlankViolation('summary', summary);
        if (summaryError !== null) return text(summaryError);
        const guard = guardArchiveRemoval(context.managers, archiveId, overrideReason);
        if (guard.kind === 'unknown') {
          return text(
            '消せない——いまは委譲の道具が配線されていない内部ターンで、走行中の' +
              'マネージャーがこの退避を使っているかどうかを確かめる材料が無い' +
              '（安全側に倒して拒む）。',
          );
        }
        if (guard.kind === 'denied') {
          return text(
            `消せない——マネージャー ${guard.managerId} がいま走行中で、この退避を使っている` +
              '（走行中の委譲を追う最後の手段が消えるため。それでも消すなら overrideReason に' +
              '理由を書くこと）。',
          );
        }
        // 本文は消すと戻らないので、日誌を先に書いてから消す（`removeArchiveJournalFirst`）。書けなければ消さない（`act-not-performed`）。
        // 消す対象・理由・override は消す前に決まるので先の行へ。バイト数と「前から消されていたか」は消した後でないと分からないので2行目に足す（落ちても握る）。
        const overrideNote =
          guard.kind === 'allowed-with-override'
            ? `（⚠️ override — 走行中のマネージャー ${guard.managerId} の退避だが、` +
              `理由「${guard.reason}」により消す）`
            : '';
        const grounds =
          guard.kind === 'allowed-with-override' ? `${summary}／${overrideNote}` : summary;
        const result = await removeArchiveJournalFirst(stores, archiveId, {
          buildEntry: () => ({
            type: 'decision',
            decision: `退避済み生ログの本文を消す: ${archiveId}: ${summary}${overrideNote}`,
            grounds,
          }),
          buildAfterEntry: (done) => ({
            type: 'decision',
            decision:
              `退避済み生ログの本文を消した結果: ${archiveId}（${done.bytes} バイト${describeArchiveRemovedBytesUnit()}。` +
              `${done.kind === 'already' ? '前から消されていたので今回は何も変わっていない' : 'いま消した'}）`,
            grounds,
          }),
        });
        if (result.kind === 'journal-failed') {
          // 消す前に落ちたので何も起きていない（`act-not-performed`）
          noteDroppedRecord('日誌', journalEntryShape(result.entry), result.error);
          throw new JournalNotRecordedError(
            'archive_remove',
            result.entry,
            'act-not-performed',
            result.error,
          );
        }
        if (result.kind === 'missing') {
          return text(`アーカイブ ${archiveId} は存在しない（消せない。何も変わっていない）。`);
        }
        if (result.kind === 'already') {
          return text(
            `アーカイブ ${archiveId} は前から消されている（${result.removedAt} に ` +
              `${result.bytes.toLocaleString('ja-JP')} バイトを落とした${describeArchiveRemovedBytesUnit()}）。何も変わっていない。`,
          );
        }
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
        // 順番待ちの墓標も守る（#4884）
        const protectedIds: string[] = (await stores.sessions.listTranscriptGraves()).map(
          (g) => g.archiveId,
        );

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

        // 塊ごとに「その塊の id を日誌へ書く → 消す」を交互に回す（`removeArchiveChunkJournalFirst`）: 本文は戻らないので、消してから書くと日誌が落ちた回に何を消したかが残らないため
        const chunks = chunkIdsByChars(
          removableTargets.map((row) => row.id),
          ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
        );
        const removedIds: string[] = [];
        let removedBytes = 0;
        let raced = 0;
        // 「日誌に N 件」は実際に書いた件数で数える: 塊の先の行が書けて止めた回に、書いていない行を名乗らないため
        let journaledChunks = 0;
        let stoppedNote: string | undefined;
        for (const [index, chunk] of chunks.entries()) {
          const chunkIds = new Set(chunk);
          const chunkTargetIds = removableTargets
            .filter((row) => chunkIds.has(row.id))
            .map((row) => row.id);
          const outcome = await removeArchiveChunkJournalFirst(stores, chunkTargetIds, () => ({
            type: 'decision',
            decision:
              `退避済み生ログの本文を絞り込みで一括して tombstone する` +
              `（${index + 1}/${chunks.length} 塊目、この塊は ${chunkTargetIds.length} 件）: ${summary}\n` +
              `絞り込み: ${filterText}\n` +
              `消す id: ${chunkTargetIds.join(' ')}`,
            grounds: summary,
          }));
          if (outcome.kind === 'journal-failed') {
            // 先の行が書けなかった塊は消していない。1つも消していなければ行為は起きていない（`act-not-performed`）。
            noteDroppedRecord('日誌', journalEntryShape(outcome.entry), outcome.error);
            if (removedIds.length === 0 && raced === 0 && journaledChunks === 0) {
              throw new JournalNotRecordedError(
                'archive_remove_many',
                outcome.entry,
                'act-not-performed',
                outcome.error,
              );
            }
            // 前の塊は消えていて日誌にも在るので投げず、どこまで消したかを返す（投げると「やり直してよい」が前の塊について嘘になる）
            stoppedNote =
              `⚠⚠ ${index + 1}/${chunks.length} 塊目の先の日誌が書けなかったので、この塊（${chunkTargetIds.length} 件）と` +
              `それ以降は消さずに止めた（${collapseErrorCause(outcome.error)}）。` +
              `止める前の ${index} 塊は消えていて日誌にも残っている。残りは同じ絞り込みでもう一度呼べば続きから消せる。`;
            break;
          }
          journaledChunks += 1;
          // 他経路が先に消していた回は `raced` へ数える（`already` も同じ競合）: この呼びが消したことにしない（打ち消しの行は helper が足してある）
          removedIds.push(...outcome.removedIds);
          removedBytes += outcome.removedBytes;
          raced += outcome.racedIds.length;
        }

        const shownRemoved = removedIds.slice(0, ARCHIVE_REMOVE_MANY_IDS_SHOWN);
        const hiddenRemoved = removedIds.length - shownRemoved.length;
        return text(
          [
            ...(stoppedNote === undefined ? [] : [stoppedNote]),
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
          '認証トークンの世代（N）と、いまの現役の世代（M）が食い違っている。' +
          '回した直後の短い遅れなら自然に消える。429 が続いたまま消えないなら起こし直すこと。' +
          `${STALE_TOKEN_RESTART_ADVICE}詳しい文面は manager_list に出る。` +
          '一致している・材料が無い（プールを使っていない構成）ときはこの印自体が出ない。',
        'デーモン自身の版と、各 runner が名乗った版（コミット sha）も出る。' +
          'デーモンと runner は別々にデプロイされるので、同じ main から起こしていても' +
          '別のコミットで走る窓がある——調べ物で「コードはこうなっている」と言う前に、' +
          'いま走っている版がその主張と同じかを見ること。',
        '版が「不明」（器が自分の版を知らない）と「未確認」（名乗りをまだ聞けていない）は' +
          '別物で、疑う先が違う（前者は器の設定、後者は登録とネットワーク）。' +
          'state が lost の器の版は黙る前に聞いた古い値である。' +
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
          '。**pids の現在値/上限そのものは今も器の合計である**——何が' +
          'その数を持っているかはこの2つの数字からは分からない。空き（上限 − ' +
          '現在値）も、次に何本置けるかを意味しない——実測では vitest が1本立ち' +
          '上がるだけで pids が +131 跳ねている。**対応している runner なら、' +
          'その合計の内訳（ゾンビ/生存の内訳・ゾンビの comm 別集計・いちばん古い' +
          'ゾンビの年齢）が別行で出る**——対応していない runner' +
          '（古い版）ではこの内訳の行自体が出ない。pids が出ない器は、理由ごとに別の' +
          '文言で出る——「確かめていない」（繋がっていないので聞いていない）・' +
          '「訊いたが失敗した: 理由」（resources() が落ちた）・「確かめられない」' +
          '（この runner は口を持たない古い版）・「訊けたが pids が読めない」' +
          '（cgroup を持たない器）。どれも数字が出ない点は同じだが、疑う先' +
          '（接続・器の RPC・runner の版・器の cgroup 構成）が違う。**そしてこの pids は、いまは配置の材料でもある**' +
          '（点数は「メモリの余り × プロセス数の余り × 新しい1本が受け取る CPU」で、' +
          '最後の項の分母には抱えている本数に加えて直近に起動が失敗した本数も足すので、' +
          '落ちた直後の器は空いて見えても選ばれにくい）——' +
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
          '。**未 push の実装・未コミットの変更が1件でもある' +
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
              '倒してある。頼んだときだけ各 runner の /health を叩く。',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            '続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す' +
              '（自分で組み立てない）。省略すると先頭から。',
          ),
      },
      async ({ fingerprints, resources, cursor }, extra: unknown) => {
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
              ? '\n（pids 逼迫を検出したが、この呼び出しでは畳む候補が無かった）'
              : `\n⚠ この呼び出しで自動畳みが働いた:\n${overview.autoFolded
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
                  // 欄が無い（古い runner）ときは行を出さない: 「引き取り手が無い」と読ませないため
                  if (reclaim.subreaper !== undefined) {
                    lines.push(
                      reclaim.subreaper.command === null
                        ? '    委譲の引き取り手: 無し（tini が PATH に無い。setsid で抜けて親が先に終わった子孫は、誰のものか分からず撃たれない）'
                        : `    委譲の引き取り手: ${reclaim.subreaper.command} -s（setsid で抜けた子孫も委譲の木に留まる）`,
                    );
                  }
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
                          describeUnrecognised(
                            outsideRoots.bySid.sidUnrecognised,
                            outsideRoots.bySid.unrecognisedBy,
                          );
                    lines.push(
                      `    孤児ルート外: ${outsideRoots.total}（うち親が生存 ` +
                        `${outsideRoots.parentInScan}。孤児ルートの部分木に入らず、撃つ判定に掛からない）` +
                        bySid,
                    );
                    if (held !== undefined) {
                      lines.push(
                        `    hold（候補のうち撃たなかった理由）: sid 不明 ${held.sidUnknown} / ` +
                          `sid が live ${held.sidLive} / sid の長が残存 ${held.sidLeaderPresent} / ` +
                          describeUnrecognised(held.sidUnrecognised, held.unrecognisedBy),
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
            // `pids` の読めた・読めないとは独立した材料: 欄が無い（古い runner）ときは行を出さない
            const ownerRecords = runner.resources?.pidOwnerRecords;
            if (ownerRecords !== undefined) {
              lines.push(
                `  持ち主の記録 ${ownerRecords.remembered.toLocaleString('en-US')}/` +
                  `${ownerRecords.cap.toLocaleString('en-US')}・` +
                  `上限で忘れた累計 ${ownerRecords.forgottenTotal.toLocaleString('en-US')}`,
              );
            }
          }
          blocks.push(lines.join('\n'));
        }

        const tail: string[] = [];
        if (autoFoldedNote !== '') tail.push(autoFoldedNote.trimStart());
        // 「この状態になった」の注記は器ごとに繰り返さず末尾に1度だけ添える: 名簿はインメモリで再起動すると `since` が巻き戻り、「ずっと保持されている記録」と誤読されないため
        // 末尾の固定の2文は、同じ会話の2回目から札にする（`manager_list` と同じ口。札にも結論を残す）。返す直前のここで1度だけ呼ぶ
        const foldRunnerTail = isSubagentCaller(context, extra)
          ? NO_FIXED_FOLD
          : (context.foldFixed ?? NO_FIXED_FOLD);
        tail.push(
          foldRunnerTail(
            'runner-list:since-note',
            '「この状態になった」は名簿の値。名簿（Registry）はインメモリなので、' +
              'デーモンを再起動すると作り直される。',
            '「この状態になった」は名簿の値で、デーモンの再起動で作り直される。',
          ),
        );
        // pids を出したなら、その数字が言えないことを必ず添える: 言えないことを書いていない計器は、読む側が言えると思い込むため
        if (resources === true) {
          tail.push(
            foldRunnerTail(
              'runner-list:pids-note',
              'pids について: **pids の現在値/上限そのものは今も器の合計であって内訳ではない。** ' +
                'この2つの数字だけからは、何がその数を持っているかは分からない。' +
                '**対応している runner なら、その内訳（ゾンビ/生存・ゾンビの comm 別・' +
                'いちばん古いゾンビの年齢）が器ごとのブロックに出る**（' +
                '対応していない runner——古い版——では内訳の行自体が出ない）。' +
                '**空き（上限 − 現在値）は「次に何本置けるか」を意味しない**——実測では ' +
                'vitest が1本立ち上がるだけで pids が +131 跳ねている。',
              'pids について: **現在値/上限は器の合計であって内訳ではない。空きは「次に何本置けるか」を意味しない**（内訳は対応する runner のブロックに出る）。',
            ),
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

// `q` が当たる文: 依頼文・managerId・直近の報告の本文・未 push の観測にある枝の名前。
// 枝は `branch` が null（detached HEAD など）の行を飛ばす。`unavailable` の観測は枝を持たない
function managerQueryHaystacks(manager: ManagerSummary): string[] {
  const observation = manager.lastUnpushedWorkObservation;
  return [
    manager.request,
    manager.managerId,
    ...(manager.lastReport === undefined ? [] : [manager.lastReport]),
    ...(observation?.kind === 'observed'
      ? observation.worktrees.flatMap((worktree) =>
          worktree.branch === null ? [] : [worktree.branch],
        )
      : []),
  ];
}

// NFKC の後に小文字へ: 順序を逆にすると、小文字化で字形が変わる全角英字が半角へ揃う前に素通りするため
function normalizeManagerQuery(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
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

// 1応答に最大5回出る RESTART_BEFORE_CHECK_ADVICE（件数の行の lost・消失、印の意味、失敗の行ごと）を、初出の1回だけ全文にする。
// 2回目以降は結論（確かめる前に起こし直さない）を短く残して「上と同じ」と言う: 行ごとの失敗の説明は別の行として読まれるため、消さずに短くする
const RESTART_ADVICE_AGAIN = '**確かめる前に起こし直さないこと**（上と同じ）。';
function dedupeRestartAdvice(response: string): string {
  const first = response.indexOf(RESTART_BEFORE_CHECK_ADVICE);
  if (first < 0) return response;
  const head = first + RESTART_BEFORE_CHECK_ADVICE.length;
  return (
    response.slice(0, head) +
    response.slice(head).replaceAll(RESTART_BEFORE_CHECK_ADVICE, RESTART_ADVICE_AGAIN)
  );
}

// 行の中の固定の一文（起点の会話の使い方・lost などの行の「本文は届いているが…」）を、出ている行だけ畳む。
// 行を組む時点では畳まない: 予算で出ない行が先に「全文を出した」と控えられ、会話の上に無い全文を参照してしまうため。
// 畳むのは `manager_list` が組んだ行の形に厳密に合う行だけ: 報告の抜粋の中に同じ字面が在っても書き換えないため。
// 1応答の中の2行目以降も参照になる（`fold` は id ごとに最初の1回だけ全文を返す）
const ORIGIN_HINT_FULL = '（報告を人間へ知らせるなら、結び付いた task へ task_say で書く）';
const ORIGIN_HINT_REF = '（知らせるなら結び付いた task へ task_say）';
// 委譲に task が結び付いていないとき
const ORIGIN_HINT_NO_TASK_FULL =
  '（報告を人間へ知らせるなら、この会話を起点にした task を task_list で探して task_say で書く。無ければ task_add で足す）';
const ORIGIN_HINT_NO_TASK_REF =
  '（知らせるなら task_list で探した task へ task_say。無ければ task_add）';
const ORIGIN_LINE_PREFIX = '  起点の会話: ';
const UNOBSERVED_NONE_LINE = `  ${describeReportState('none')}`;
const UNOBSERVED_NONE_REF =
  '  ⚠ 終端までに本文が1文字も届いていない（何をしたかはこの一覧から読めない。全文は最初の一覧のとおり）。';
const UNOBSERVED_DELIVERED_LINE = `  ${describeReportState('delivered')}`;
const UNOBSERVED_DELIVERED_REF =
  '  ⚠ 本文は届いているが、完遂した報告とは限らない（台帳では区別できない。理由は最初の一覧のとおり）。';
function foldRowPhrases(response: string, fold: FixedFold): string {
  return response
    .split('\n')
    .map((line) => {
      if (line === UNOBSERVED_NONE_LINE) {
        return fold('manager-list:row-unobserved-none', line, UNOBSERVED_NONE_REF);
      }
      if (line === UNOBSERVED_DELIVERED_LINE) {
        return fold('manager-list:row-unobserved-delivered', line, UNOBSERVED_DELIVERED_REF);
      }
      if (line.startsWith(ORIGIN_LINE_PREFIX) && line.endsWith(ORIGIN_HINT_FULL)) {
        return (
          line.slice(0, line.length - ORIGIN_HINT_FULL.length) +
          fold('manager-list:row-origin-hint', ORIGIN_HINT_FULL, ORIGIN_HINT_REF)
        );
      }
      if (line.startsWith(ORIGIN_LINE_PREFIX) && line.endsWith(ORIGIN_HINT_NO_TASK_FULL)) {
        return (
          line.slice(0, line.length - ORIGIN_HINT_NO_TASK_FULL.length) +
          fold(
            'manager-list:row-origin-hint-no-task',
            ORIGIN_HINT_NO_TASK_FULL,
            ORIGIN_HINT_NO_TASK_REF,
          )
        );
      }
      return line;
    })
    .join('\n');
}

// 件数の行の固定の読み方。2回目から参照にする（`describeManagerCounts`）。参照にも要点（読み違えると打つ手が変わる点）を残す
const COUNTS_RUNNING_FULL =
  '**「走行中」は「進んでいる」ではない** — 宛先の器が黙って消えても ' +
  'status は running のままで、それを終端へ動かす経路はデーモンに無い。' +
  'いま何本動いているかを数えるなら、走行中の本数ではなく' +
  '「話しかけられる」ほうを見ること。';
const COUNTS_RUNNING_REF =
  '（読み方は前の一覧の全文のとおり: 「走行中」は「進んでいる」ではない。動いている本数は「話しかけられる」ほうで数える）';
const COUNTS_LOST_FULL =
  ' **「戻れなかった(lost)」は「終わった」ではない** — 前のセッションへ戻れたかだけを' +
  '見ていて、成果が既に外へ出ていることがある（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）。' +
  'この一覧の本文は文字数の予算で切れるので、名指しで引くなら status: ["lost"] を渡すこと' +
  '（絞りは予算より前に効く）。' +
  // 残りへ辿る綴りは `lost` が在るときだけ置く: 「全部見た」と読みかけるときだけで、それぞれの行には既に ⚠ が付くため
  '**ただし lost を全部確かめても、落ちた委譲を全部見たことにはならない** — ' +
  '宛先の器が黙って消えた委譲は running のまま残り、直近のターンが失敗で終わった委譲は ' +
  'done のまま残る。前者は status: ["running"]、後者は status: ["done"] で引き、' +
  '行に付く ⚠ を見ること。' +
  RESTART_BEFORE_CHECK_ADVICE;
const COUNTS_LOST_REF =
  ' （lost は「終わった」ではなく、成果が外へ出ていることがある。名指しは status: ["lost"]。' +
  '全部ではない: running のまま残る委譲は status: ["running"]、失敗で終わった委譲は status: ["done"] で引き、行の ⚠ を見る。' +
  `${RESTART_BEFORE_CHECK_ADVICE_CORE}。全文は最初の一覧のとおり）`;
const COUNTS_USAGE_STOPPED_FULL =
  ' **「枠(利用上限)で止まっている」は status の分割ではなく横断する軸である** — ' +
  '走行中・返事待ち・戻れなかった(lost)・手が空いている（done）等のどれとも重なりうるので、' +
  '上の内訳には足し合わせない。名指しで絞る綴りは無い（`status` の値ではないため）——' +
  'この一覧の各行に付く注記（⚠ 枠(利用上限)で止まっている）を見て、どの委譲かを辿ること。';
const COUNTS_USAGE_STOPPED_REF =
  ' （「枠(利用上限)で止まっている」は横断する軸で、他の内訳に足し合わせない。' +
  '絞る綴りは無いので、各行の ⚠ 枠(利用上限)で止まっている から辿る）';
const COUNTS_RUNNER_VANISHED_FULL =
  ' **「宛先の runner が名簿から消えている」は status の分割ではなく横断する軸である** — ' +
  '必ず「走行中」の内側に座るが、`lost`（戻れなかった）とは別の集合で、' +
  '`manager_list status: ["lost"]` の絞りでは拾えない。名指しで絞る綴りは無い' +
  '（`status` の値ではないため）——この一覧の各行に付く注記' +
  '（⚠ 宛先の runner が名簿から消えている）を見て、どの委譲かを辿ること。' +
  RESTART_BEFORE_CHECK_ADVICE;
const COUNTS_RUNNER_VANISHED_REF =
  ' （「宛先の runner が名簿から消えている」は横断する軸で、走行中の内側にあり lost とは別の集合。' +
  '`status: ["lost"]` では拾えず、各行の ⚠ 宛先の runner が名簿から消えている から辿る。' +
  `${RESTART_BEFORE_CHECK_ADVICE_CORE}）`;

// 絞り込みの注記の固定の言い回し。絞りの値・件数は畳まず、言い回しだけを2回目から札にする
const FILTER_COUNTS_SCOPE_FULL = '（すぐ上の件数は絞る前の全体である）。';
const FILTER_COUNTS_SCOPE_REF = '（上の件数は絞る前の全体）。';
const FILTER_STATUS_EMPTY_FULL =
  '（渡さなかったのと同じ結果である。人間の GET /managers に揃えてある——' +
  '0件へ倒すと絞りを解除した呼びが「マネージャーが消えた」ように見えるため）。' +
  '**journal_read の types は [] を0件として扱うので、' +
  'この道具だけ倒し方が違う**（理由は tools.ts の doc に在る）。';
const FILTER_STATUS_EMPTY_REF =
  '（[] は絞らない扱い。**journal_read の [] は0件で、この道具だけ逆**）。';
const FILTER_Q_MATCH_FULL =
  '（依頼文の全文・managerId・直近の報告の本文・未 push の観測にある枝の名前への部分一致。大文字小文字と全角半角は区別しない）';
const FILTER_Q_MATCH_REF =
  '（依頼文の全文・managerId・直近の報告の本文・未 push の観測にある枝の名前への部分一致）';
const FILTER_Q_EMPTY_FULL = '（渡さなかったのと同じ結果である。status: [] と同じ倒し方）。';
const FILTER_Q_EMPTY_REF = '（絞らない扱い）。';

// 「…ほか N 件は省略」の固定の文。続きの取り方（cursor）は毎回変わるので畳まず、その前後の固定の2文だけを畳む
const OMITTED_ORDER_FULL =
  '走行中・返事待ちを先に出し、次に lost（判断待ち）、そのあとに残りを出す。' +
  '各群の中は startedAt の新しい順である。' +
  '**省略されたのは終端したもの（またはより古いもの）の側である。**';
const OMITTED_ORDER_REF =
  '（並びは前の一覧のとおり: 走行中・返事待ち → lost → 残り、群の中は startedAt の新しい順。省略されたのは終端したもの・より古いものの側である）';
const OMITTED_PAGING_FULL =
  '委譲の台帳には保持期間も掃除の機構も無いので、辿る頁数は台帳の本数に比例して増える。' +
  'status や q で絞れば頁数を減らせる。';
const OMITTED_PAGING_REF = '（頁数は台帳の本数に比例して増える。status や q で絞れば減らせる）';

// 一覧を数えて答えさせない: 一覧は予算で打ち切られ、`status` だけを数えると上振れする（`running` は終端へ勝手には行かない）ため2軸で数える
// 0 の行は作らない: 「切断 0本」と書くと、観測して 0 だったのか数えていないのかが読めなくなるため、在るときだけ書く
// `usageStopped` を上の内訳へ足し合わせない: `status` と独立の横断する軸で、同じ委譲を2回数えることになるため
function describeManagerCounts(
  managers: readonly ManagerSummary[],
  fold: FixedFold = NO_FIXED_FOLD,
): string {
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
    fold('manager-list:counts-running', COUNTS_RUNNING_FULL, COUNTS_RUNNING_REF) +
    // `lost` が在るときだけ足す: 本数だけだと「終わった本数」と読まれ、`lost` は確かめるまで終われない側のため
    // 畳むのも足したときだけ: 足さない回に `fold` を呼ぶと、出していない全文を「出した」と控えてしまうため
    (lost === 0 ? '' : fold('manager-list:counts-lost', COUNTS_LOST_FULL, COUNTS_LOST_REF)) +
    (usageStopped === 0
      ? ''
      : fold(
          'manager-list:counts-usage-stopped',
          COUNTS_USAGE_STOPPED_FULL,
          COUNTS_USAGE_STOPPED_REF,
        )) +
    // `lost` を条件に混ぜない: `lost` が 0 のまま器が黙って消えた委譲だけが在る回を取りこぼすため
    (runnerVanished === 0
      ? ''
      : fold(
          'manager-list:counts-runner-vanished',
          COUNTS_RUNNER_VANISHED_FULL,
          COUNTS_RUNNER_VANISHED_REF,
        ))
  );
}

function roleLabel(role: 'inbound' | 'outbound'): string {
  return role === 'inbound' ? '人間' : 'クローン';
}

// 取り下げた発言は外さず注記つきで出す（`GET /conversations/:id` の `delivery: 'withdrawn'` と同じ向き）。
// 印を引けなかった回は「取り下げていない」と言わない: 空の集合へ倒すと、取り下げた発言が生きた依頼に見える（#5456）
function describeWithdrawnReading(
  lookup: Awaited<ReturnType<typeof lookupWithdrawnForMessages>>,
  messages: readonly { role: 'inbound' | 'outbound'; clientMessageId?: string | undefined }[],
  // 予算で省いた行を含めて数えるので、実際に表示した行（`messages` の一部）を渡せば「うち表示 k 件」を添える。1件を id で読む回は `single`
  options: {
    shown?: readonly { role: 'inbound' | 'outbound'; clientMessageId?: string | undefined }[];
    single?: boolean;
  } = {},
): {
  isWithdrawn: (message: { clientMessageId?: string | undefined }) => boolean;
  notes: string[];
} {
  const shownOf = (
    count: (message: {
      role: 'inbound' | 'outbound';
      clientMessageId?: string | undefined;
    }) => boolean,
  ): string =>
    options.shown === undefined || options.shown.length === messages.length
      ? ''
      : `（省いた行を含む数。うち表示 ${options.shown.filter(count).length} 件）`;
  const isHumanSendable = (message: {
    role: 'inbound' | 'outbound';
    clientMessageId?: string | undefined;
  }): boolean => message.role === 'inbound' && message.clientMessageId !== undefined;
  if (lookup.kind === 'unknown') {
    const unverifiable = messages.filter(isHumanSendable).length;
    return {
      isWithdrawn: () => false,
      notes: [
        `（取り下げの有無を判定できなかった: 取り下げの印を日誌から読めなかった（${lookup.reason}）。` +
          (options.single
            ? 'この発言は、取り下げていないとは言えない。'
            : `人間の発言 ${unverifiable} 件${shownOf(isHumanSendable)}は、取り下げていないとは言えない。`) +
          'クローンへ届いていない発言が混じっているかもしれないので、実行の根拠にする前に人間へ確かめること）',
      ],
    };
  }
  const ids = lookup.ids;
  const isWithdrawn = (message: { clientMessageId?: string | undefined }): boolean =>
    message.clientMessageId !== undefined && ids.has(message.clientMessageId);
  const count = messages.filter(
    (message) => message.role === 'inbound' && isWithdrawn(message),
  ).length;
  return {
    isWithdrawn,
    notes:
      count === 0
        ? []
        : [
            options.single
              ? '（この発言は、人間が送ったあとクローンへ届く前に取り下げたもので、クローンへは届いていない。依頼として扱わないこと）'
              : `（取り下げた発言が ${count} 件${shownOf((message) => message.role === 'inbound' && isWithdrawn(message))}ある。人間が送ったあとクローンへ届く前に取り下げたもので、` +
                'クローンへは届いていない。依頼として扱わないこと。会話の一覧の件数はこれを除いて数えるので、' +
                'ここに出ている行数とは合わない）',
          ],
  };
}

const WITHDRAWN_MESSAGE_MARK = '（取り下げた発言。クローンへは届いていない）';

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
  fold: FixedFold = NO_FIXED_FOLD,
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
    `- premise 合計: ${floor.premiseChars.toLocaleString('en-US')} 文字（${floor.premiseDocs} 文書。${fold('self-status:memory-premise', '毎ターン「要旨＋節の目次」が焼かれる', '要旨＋節の目次が焼かれる')}${demotedSuffix}）`,
    `- indexed 合計: ${floor.indexedChars.toLocaleString('en-US')} 文字（${floor.indexedDocs} 文書。${fold('self-status:memory-indexed', '毎ターン要旨だけが焼かれる。節の目次は焼かれない', '要旨だけが焼かれる')}）`,
    `- fact 目次合計: ${floor.tocChars.toLocaleString('en-US')} 文字（${floor.factDocs} 文書。${fold('self-status:memory-fact', '目次の1行だけが焼かれる', '目次の1行だけ')}）`,
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
    tools: withToolPhases(createCloneTools(context)),
  });
}

/**
 * ループの停止の見張り（#4485）に、どの自作ツールを処理していたかを残す。自作ツールはデーモンと同じプロセスで走るので、
 * 中の同期処理はループを塞ぐ。入口と出口の2つを打ち、止まった窓の印でどちらの間かを読めるようにする。
 */
export function withToolPhases<
  T extends { name: string; handler: (args: never, extra: unknown) => Promise<unknown> },
>(tools: readonly T[]): T[] {
  return tools.map((definition) => {
    const handler = (async (args: never, extra: unknown) => {
      notePhase(`clone-tool:${definition.name}`);
      try {
        return await definition.handler(args, extra);
      } finally {
        notePhase(`clone-tool-done:${definition.name}`);
      }
    }) as T['handler'];
    return { ...definition, handler };
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
