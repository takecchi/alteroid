import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { describeArchiveRemovedBytesUnit } from './archive-removed-bytes.js';

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

import { isTaskClosed } from './task.js';
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

import { describePidsSaturation } from './runner-protocol.js';

import { describeManagerState } from './digest.js';
import { journalEntryShape, noteDroppedRecord, reasonOf } from './dropped-record.js';
import { collapseErrorCause } from './error-cause.js';

import { encodeRunnerCursor, resolveRunnerCursor } from './runner-cursor.js';

import {
  describePage,
  excerptLine,
  excerptRow,
  page,
  renderListing,
  renderListingFromEnd,
} from './excerpt.js';

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

import { guardArchiveRemoval } from './manager.js';

import type { ManagerPool, RunnerManagerEntry } from './manager.js';
import type { RunnerPushOutcome } from './push-ledger.js';

import type { Task, JournalEntry } from './schema.js';

import { describeRevisionStatus } from './revision.js';
import { describeManagerPeers } from './manager-peers-format.js';

import { UnreadableJournalEntryError, UnreadableTaskError } from './store.js';

import type { ArchiveEntry } from './store.js';
import { STALE_TOKEN_RESTART_ADVICE } from './usage-limits.js';

import { formatMinutesAgo } from './format-elapsed.js';

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
import { managerTools } from './clone-tools-manager.js';
import { selfTools } from './clone-tools-self.js';
import { practiceTools } from './clone-tools-practice.js';
import { profileTools } from './clone-tools-profile.js';
import { taskTools } from './clone-tools-task.js';
import { scheduleTools } from './clone-tools-schedule.js';
import { usageTools } from './clone-tools-usage.js';
import { approvalTools } from './clone-tools-approval.js';
import { journalTools } from './clone-tools-journal.js';
import { memoryTools } from './clone-tools-memory.js';

import {
  tool,
  describeRunnerLegState,
  TRANSCRIPT_PAGE,
  describeUnreadableJournalEntry,
  RUNNER_MANAGER_PEERS_EXCERPT,
  text,
  JournalNotRecordedError,
  appendJournalOrThrow,
  appendJournalOrDrop,
  NO_POOL,
  NO_FIXED_FOLD,
  isSubagentCaller,
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
  isFoldedTurnReport,
  describeReportDriftMark,
  describeTurnEnd,
  describeToolUseStall,
  describeHeldMessages,
  describeExternalOutputs,
  describeRescueStash,
  describeRescue,
} from './clone-tools-manager.js';
export { renderPeerReach } from './clone-tools-self.js';
export { formatPracticeKindRangeJa } from './clone-tools-practice.js';
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

// 定数は `task-close-many.ts` に在る。外へ出していた名前はここから変えない
export { CLOSE_MANY_LIMIT_MAX, CLOSE_MANY_JOURNAL_ID_CHARS };
import { REMOVE_MANY_LIMIT_DEFAULT, REMOVE_MANY_LIMIT_MAX } from './remove-many-limit.js';

export { REMOVE_MANY_LIMIT_DEFAULT, REMOVE_MANY_LIMIT_MAX };
// 道具の応答だけの関心事: 一括削除の口は道具だけ（HTTP の口は無い）なので、`removedIds` の間引きはテキスト応答の側で持つ
const ARCHIVE_REMOVE_MANY_IDS_SHOWN = 20;

// `task-close-many.ts` から使うため `chunk-ids.ts` へ移した（`tools.ts` を import すると循環する）。外へ出す名前はここから変えない
export { chunkIdsByChars };

// `LIST_BUDGET` を使い回さない: 値が同じでも、片方だけ直したくなったときに一緒に動くため
const RUNNER_LIST_BUDGET = 8_000;
const RUNNER_MANAGER_LIST_LIMIT = 20;
const RUNNER_CREDENTIAL_FINGERPRINT_EXCERPT = 400;

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

function runnerManagerTokenTag(manager: RunnerManagerEntry): string {
  if (manager.tokenGeneration === undefined || manager.activeTokenGeneration === undefined) {
    return '';
  }
  if (manager.tokenGeneration === manager.activeTokenGeneration) return '';
  return ` ⚠世代${manager.tokenGeneration}≠現役${manager.activeTokenGeneration}`;
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
    ...practiceTools(context, shared),
    ...selfTools(context, shared),
    ...managerTools(context, shared),
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
