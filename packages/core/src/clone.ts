import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { query, SessionKey, SessionStore } from '@anthropic-ai/claude-agent-sdk';

import type {
  AgentContentBlock,
  AgentEvent,
  AgentPermissionDenial,
  AgentRuntimeFacts,
  AgentTurnEnded,
  AgentTurnUsage,
} from './agent-events.js';
import type {
  AgentPreCompactRecord,
  AgentPreToolDecision,
  AgentPreToolRecord,
  AgentSubagentStopRecord,
  AgentToolAuditFailureRecord,
  AgentToolAuditRecord,
} from './agent-hooks.js';
import type {
  AgentCloneDriver,
  AgentCloneSession,
  AgentCloneSessionSpec,
  AgentCloneTools,
} from './agent-clone-session.js';
import type { AgentProvider } from './agent-ports.js';
import type { AgentInputImage, AgentUserInput } from './agent-session.js';
import { ClaudeCloneDriver } from './claude-clone-driver.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';
import { describeArchiveContinuityForJournal } from './archive-continuity.js';
import {
  CLONE_TOOL_RELAY_SOCKET_ENV,
  CLONE_TOOL_RELAY_TOKEN_ENV,
} from './clone-tool-relay-protocol.js';
import { createCloneToolRelayHost, type CloneToolRelayHost } from './clone-tool-relay-host.js';
import {
  CLONE_TOOL_RELAY_SOCKET_FILENAME,
  DEFAULT_CLONE_TOOL_RELAY_SOCKET_DIR,
  resolveCloneToolRelayChildEntry,
  resolveCloneToolsTransportFor,
  type CloneToolsTransport,
} from './clone-tools-transport.js';
import { CONTEXT_USAGE_CATEGORY_LIMIT } from './context-usage.js';
import {
  completedTimerRoundVerdict,
  restoredInboxEventVerdict,
  type RestoredInboxEventVerdict,
} from './inbox-staleness.js';
import {
  denialInputAbsence,
  denialInputShape,
  RecentDenialLog,
  type DeniedRecord,
} from './denial-shape.js';
import {
  buildActivityDigest,
  type ManagerAwaitingBackgroundMap,
  type ManagerLiveness,
} from './digest.js';
import { knownProviderOf } from './agent-provider-selection.js';
import { collectRunnerProviderGaps, type ProviderGapSubject } from './provider-gaps.js';
import {
  DISTILL_GAP_ACTIVITY_SCAN_LIMIT,
  deriveDistillGapFromJournal,
  describeDistillGap,
  distillSucceededEntry,
} from './distill-gap.js';
import { describeSelectionsViolation, foldSelections } from './approval-choices.js';
import { stampAnsweredApproval, stampingJournal } from './approval-trace.js';
import { redactErrorText } from './denial-input-head.js';
import { excerpt, excerptLine, renderListingFromEnd, tailByCodePoints } from './excerpt.js';
import { readConversationWindow } from './conversation.js';
import { describeArchiveRemovedBytesUnit } from './archive-removed-bytes.js';
import {
  EXCHANGE_KIND_DECISION_PREFIX,
  EXCHANGE_KIND_FAILURE_PREFIX,
  EXCHANGE_KIND_GAUGE_PREFIX,
  EXCHANGE_KIND_RECOVERY_PREFIX,
  EXCHANGE_KIND_REPLY_PREFIX,
  EXCHANGE_KIND_THINNING_PREFIX,
} from './exchange-kind.js';
import {
  DAEMON_RUNNER_REGISTRY_SOURCE,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  isDaemonSelfNotice,
  staleObservedRecoveryNoticeEvent,
} from './daemon-self-notice.js';
import {
  inboxBacklogDedupeKey,
  inboxCollapseKey,
  INBOX_BACKLOG_LOUD_THRESHOLD,
  isHumanOriginated,
  removeInboxEventsAndStopDelivery,
  summarizeInboxBacklog,
} from './inbox-backlog.js';
import type { InboxBacklogBreakdown } from './inbox-backlog.js';
export { isHumanOriginated };
import {
  inboxEventShape,
  journalEntryShape,
  noteBackgroundFailure,
  noteDroppedInboxEvent,
  noteDroppedRecord,
  noteDuplicateHumanAnswer,
  noteInboxEventKeptInMemoryOnly,
  noteCloneSessionIdNotRecorded,
  noteInboxEventLost,
  noteInboxEventRefused,
  noteUnreadableRecord,
  reasonOf,
} from './dropped-record.js';
import type { AnswerApprovalVia, CloneHost, PostPersistOutcome } from './host.js';
import { createRunnerRegistry, type RunnerClient } from './runner-protocol.js';
import {
  createManagerPool,
  type ManagerPool,
  type ManagerSummary,
  type WorkerToolEvent,
} from './manager.js';
import {
  describeMemorySessionDelta,
  describeMemoryTidyTargets,
  measureMemoryFloor,
  renderMemoryDocuments,
} from './memory.js';
import { placedModelTier, resolveModelTier } from './model-tier.js';
import { heuristicChars } from './quantity.js';
import {
  placedPermissionMode,
  resolvePermissionModeFor,
  type PermissionModeName,
} from './permission-mode.js';
import type { ProfileApplier } from './profile.js';
import { resolveCredentialRows, type CredentialService } from './credential-service.js';
import type { McpServerService } from './mcp-server-service.js';
import type { McpServers } from './mcp-servers.js';
import type { ProfileService } from './profile-service.js';
import { createRecentMap } from './recent.js';
import { describeSituation, describeSituationUnavailable, readAtLabel } from './situation.js';
import { countSupersedingReports, describeSuperseded } from './superseded.js';
import { describeValidity, inboxEventValidity } from './inbox-validity.js';
import type { AttachmentRef, JobStatus } from './schema.js';
import { DEFAULT_TOKEN_COOLDOWN_MS, toAgentTokenView } from './token-pool.js';
import { parseNoticeResetAt } from './usage-reset-text.js';
import type { RunnerRegistry } from './runner-protocol.js';
import {
  buildCloneSystemPrompt,
  buildDailyReportPrompt,
  buildDistillPrompt,
  buildExternalEventPrompt,
  externalAttachmentSection,
  EXTERNAL_EVENT_FRAMING,
  externalViaLine,
  buildSelfInitiativePrompt,
  buildTimerPrompt,
} from './prompt.js';
import { DAILY_REPORT_KIND, dailyReportEvent, localDate, localDayRange } from './schedule.js';
import type { ScheduleStatus } from './schedule.js';
import {
  commitmentClosedBySchema,
  describeAnsweredVia,
  isDailyReport,
  isWrittenDailyReport,
  PERMISSION_GRANT_CONSENT_PHRASE,
} from './schema.js';
import type {
  ApprovalSelection,
  ChatStreamEvent,
  Commitment,
  InboxEvent,
  JournalEntry,
  JournalEntryInput,
  MemoryDocument,
  PendingApproval,
  PermissionGrant,
  ScheduledRequest,
} from './schema.js';
import { matchPermissionRule } from './permission-rule.js';
import { collapseErrorCause } from './error-cause.js';
import { resolveBuildRevision, resolveBuildTime } from './revision.js';
import type { CloneRuntimeFacts, SelfFacts } from './self.js';
import { UnreadableApprovalError, findOpenManagerDuplicate } from './store.js';
import type { CommitmentList, PendingInboxEvent, Stores } from './store.js';
import {
  cloneToolCarriesSecrets,
  cloneToolJournalsItself,
  createCloneMcpServer,
  detectMcpInputValidationFailure,
  qualifiedToolName,
  type ToolContext,
} from './tools.js';
import { CloneDelivery } from './clone-delivery.js';
import { CloneProgress } from './clone-progress.js';
import { CloneDistillMemoryState } from './clone-distill-memory-state.js';
import { CloneInboxFlow } from './clone-inbox-flow.js';
import { CloneNotices } from './clone-notices.js';
import { CloneSdkSession } from './clone-sdk-session.js';
import { attachmentCopiesDir } from './attachment-fetch.js';
import { resolveTurnAttachmentGroups } from './attachment-turn.js';
import { stripNul } from './nul-guard.js';
import { composeTurnInputText, turnInputEntry } from './turn-input.js';
import type { AccountUsageState } from './usage-snapshot.js';
import {
  CLONE_ACTOR_ID,
  CLONE_DISTILL_ACTOR_ID,
  CLONE_SUB_ACTOR_PREFIX,
  usageDate,
  type UsageSite,
  type UsageSnapshot,
} from './usage.js';
import {
  classifyUsageNotice,
  describeUsageNotice,
  mergeRateLimitFacts,
  rateLimitMemoryKey,
  usageTransitionOf,
  type RateLimitFacts,
  type UsageLimitNotice,
} from './usage-limits.js';
import type { TokenRotatorObservation } from './token-rotator.js';
import { assistantFailureOf, type SdkFailure } from './sdk-failure.js';
import { describeProbeError } from './usage-probe.js';
import {
  classifyContextWindowFailure,
  describeContextWindowFailure,
  type ContextWindowFailure,
} from './context-window-failure.js';

export {
  DAEMON_RUNNER_REGISTRY_SOURCE,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  isDaemonSelfNotice,
  staleObservedRecoveryNoticeEvent,
};
export {
  staleObservedRecoveryForBlockedKey,
  tokenPoolReopenedPayload,
  type TokenPoolReopenedPayload,
} from './daemon-self-notice.js';

// row-folded は待ち行列から抜かない: 抜くと `#mergedExternalBatch` の束ね読み（件数と全件の届いた時刻）が消えるため
type PendingCollapseVerdict = 'pass' | 'folded' | 'row-folded';


export const CLONE_MODEL = 'opus';

// 途中で読み直さない: 走行中の SDK セッションのモデルは差し替えられず、読み直すと蒸留のサイドクエリだけがずれるため
export const CLONE_MODEL_ENV_KEY = 'ALTEROID_CLONE_MODEL';

export function resolveCloneModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveModelTier(env, CLONE_MODEL_ENV_KEY, CLONE_MODEL);
}

// 「既定と違うか」で言い換えない: 置いた値が既定と同じでも「置いた」であり、`self_status` が返すのは承認が置かれているかのため
export function placedCloneModel(env: NodeJS.ProcessEnv = process.env): string | null {
  return placedModelTier(env, CLONE_MODEL_ENV_KEY);
}

export const CLONE_PERMISSION_MODE_ENV_KEY = 'ALTEROID_CLONE_PERMISSION_MODE';

// 切れる口を消さない: 順序付けは方針であり、「切れない」にすると器が優先順位を握って動かせなくなるため
export const CLONE_HUMAN_PRIORITY_ENV_KEY = 'ALTEROID_CLONE_HUMAN_PRIORITY';

// 未設定・空・空白は有効のまま: 「読めなかった」を「切られた」と読むと、変数が届かなかっただけの器で人間の待ちが黙って戻るため
export function resolveCloneHumanPriority(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CLONE_HUMAN_PRIORITY_ENV_KEY]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

export function resolveClonePermissionMode(
  env: NodeJS.ProcessEnv = process.env,
): PermissionModeName {
  return resolvePermissionModeFor(env, CLONE_PERMISSION_MODE_ENV_KEY);
}

export function placedClonePermissionMode(env: NodeJS.ProcessEnv = process.env): string | null {
  return placedPermissionMode(env, CLONE_PERMISSION_MODE_ENV_KEY);
}

// 単位は文字（UTF-16 の code unit）でバイトではない: 切っているのが `String.prototype.slice` のため
const DISTILL_TRANSCRIPT_TAIL_CHARS = 60_000;

// この値を上げない: 巨大セッションを resume すると JSON.parse の結果が V8 ヒープ 4 GiB を使い切って落ちるため（天井の半分 ÷ 展開倍率4 ＝ 512 MiB）
const RESUME_SIZE_BUDGET_BYTES = 512 * 1024 * 1024;

const RECENT_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

const MEMORY_FLOOR_SESSION_GROWTH_LINE_PERCENT = 10;

function formatMemoryCharCountLocal(value: number): string {
  return value.toLocaleString('en-US');
}

function formatSignedMemoryCharCount(delta: number): string {
  return delta >= 0 ? `+${formatMemoryCharCountLocal(delta)}` : formatMemoryCharCountLocal(delta);
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

const DAILY_REPORT_LOOKUP = 30;

// 使い切ったら諦める: 恒常的な失敗で回り続けないため
export const DAILY_REPORT_RETRY_DELAYS_MS: readonly number[] = [
  10 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
];

const EXTERNAL_PAYLOAD_LIMIT = 8_000;

// 上限は外さない: 入口が本文の大きさを締めておらず、病的に大きい webhook が1件で日誌を膨らませうるため
const EXTERNAL_JOURNAL_LIMIT = 200_000;

const CLONE_ID_LIST_EXCERPT = 400;

// 空文字や省略で表さない: 読めなかったことを黙って落とすと、監査の穴が「何も起きなかった」と同じ見え方になるため
const UNKNOWN_TOOL_NAME = '(不明な道具)';
const UNKNOWN_AGENT_TYPE = '(不明)';

const JOURNAL_WRITE_QUALIFIED_TOOL_NAME = qualifiedToolName('journal_write');

// 切らずに残さない: `error` は上限の無い自由文で、1件の巨大な失敗メッセージが日誌の1行を埋め尽くしうるため
const TOOL_USE_ERROR_EXCERPT = 500;

const DENIED_TOOL_USE_MEMORY_LIMIT = 512;

const RECENT_DENIAL_LIMIT = 32;

const ALLOWED_BY_GRANT_MEMORY_LIMIT = 512;

// コマンド本文を持たない: 覚える必要があるのは人間が承認済みの規則（`grant.rule`）とその行の id だけのため
interface AllowedByGrantRecord {
  readonly grantId: string;
  readonly rule: string;
  readonly agentId?: string;
}

// 上限を外さない: `drainWhile` に上限が無く、外すと起動直後に拾い直した在庫（報告369件など）が全部1本のプロンプトへ連結されるため
const MERGED_BATCH_SIZE_LIMIT = 50;

export const MERGED_BATCH_SIZE_LIMIT_ENV_KEY = 'ALTEROID_MERGED_BATCH_SIZE_LIMIT';

const MERGED_BATCH_SIZE_LIMIT_UNREADABLE_WHAT = 'まとめ読みの束の上限件数の設定';

export function resolveMergedBatchSizeLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MERGED_BATCH_SIZE_LIMIT_ENV_KEY];
  if (raw === undefined) return MERGED_BATCH_SIZE_LIMIT;
  const trimmed = raw.trim();
  if (trimmed === '') return MERGED_BATCH_SIZE_LIMIT;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    noteUnreadableRecord(
      MERGED_BATCH_SIZE_LIMIT_UNREADABLE_WHAT,
      `${MERGED_BATCH_SIZE_LIMIT_ENV_KEY} chars=${String(trimmed.length)}`,
      new Error(`数値として読めない。既定の ${String(MERGED_BATCH_SIZE_LIMIT)} 件で走る`),
    );
    return MERGED_BATCH_SIZE_LIMIT;
  }
  if (parsed <= 0) {
    noteUnreadableRecord(
      MERGED_BATCH_SIZE_LIMIT_UNREADABLE_WHAT,
      `${MERGED_BATCH_SIZE_LIMIT_ENV_KEY} chars=${String(trimmed.length)}`,
      new Error(`0 以下は上限にならない。既定の ${String(MERGED_BATCH_SIZE_LIMIT)} 件で走る`),
    );
    return MERGED_BATCH_SIZE_LIMIT;
  }
  return Math.floor(parsed);
}

// 失敗のたびに後退する: 毎分1ターンにしないため
const FAILED_TURN_RETRY_DELAYS_MS: readonly number[] = [10, 30, 120, 360, 720].map(
  (minutes) => minutes * 60_000,
);

const SCHEDULE_STORE_ATTEMPTS = 3;
const SCHEDULE_STORE_RETRY_MS = 200;

const FORGET_RETRY_ATTEMPTS = 3;
const FORGET_RETRY_MS = 200;

// 65,535 を上げない: `IN (...)` のバインドパラメータ上限で、`removeMany` の DELETE に条件を足すなら下げること
const RESTORE_STALE_REMOVE_CHUNK_MAX_IDS = 65_535;

// 無限に粘らない: 器が詰まったまま合図が届き続けるたびに終わらない待ちが積み上がるため
const REMEMBER_RETRY_ATTEMPTS = 3;
const REMEMBER_RETRY_MS = 200;

// 合わなければ諦めて次の発火に譲る: 古い本文で走らないことが最優先のため
const SCHEDULE_CLAIM_ROUNDS = 3;

// 記憶の全文を載せ直さない: 二重載せになり、履歴の写しが resume のたびに増えるため
const RESUMED_MEMORY_NOTICE =
  '[system] このセッションは前のセッションを引き継いで（resume して）開いたものである。' +
  '**現在の記憶は、システムプロンプトの「現在の記憶」に載っているものである。** ' +
  'この下より前の会話に「記憶が更新された」として載っている塊は、それより古い可能性がある' +
  '（デーモンが落ちている間に人間が直していれば、正本のほうが新しい）。食い違ったら' +
  'システムプロンプト側を採ること。確かめたければ `memory_read` で読み直せる。';

// `context_window_failure` の目印と生の文言を含めない: 日誌側の道具で、人間へ返す1行に持ち込まないため（`clone-turn-failure-trace.test.ts` が測る）
// 「どうすべきか」を書かない: 材料だけ渡して判断は人間とクローンに残すため
const CONTEXT_WINDOW_ALSO_NOTICE =
  '⚠️ ただし、このターンは文脈窓（プロンプトの長さ）にも当たっている。' +
  '⟹ 枠が開いても、長さが同じままなら同じところで落ちる。' +
  '待つだけでは返せない可能性がある（詳しい理由は日誌に残してある）。';

// 「会話が失われた」と書かない: 記録はストアに在って消えておらず、失われるのはクローンの文脈の連続性だけのため
const CONTEXT_WINDOW_FOLD_NOTICE =
  'この会話はここで一区切りにして、次の発言から新しく開き直す。' +
  '⚠️ それまでのやりとりは消えていない（記録は残っている）が、' +
  '私はその続きを覚えていない状態で始まるので、必要なら読み直す。';

// 抑止を名乗る: 畳まずに落ち続ける状態は外から「なぜか動かない」にしか見えず、名乗らないと「壊れている」と読まれるため
// 「どうすべきか」を書かない: 材料だけ渡して判断は人間とクローンに残すため
const CONTEXT_WINDOW_FOLD_HELD_NOTICE =
  '⚠️ このセッションは既に会話を引き継がずに開いたもので、まだ1度も答えを返せていない。' +
  '⟹ もう一度開き直しても同じ材料で同じところへ落ちるので、開き直していない。' +
  '⟹ プロンプトそのものが収まっていない可能性がある。';

// 閾値は回数ではなく文字数にする: 回数だと、小さい本文の再試行と1回あたりの持ち越しが大きい本物の事故を区別できないため
const UNPRODUCTIVE_USAGE_BLOCK_FOLD_CHAR_THRESHOLD = 200_000;

// `CONTEXT_WINDOW_FOLD_NOTICE` と共通にしない: 長さで落ちたのではないのに「文脈窓」の話だと読ませないため
const UNPRODUCTIVE_USAGE_BLOCK_FOLD_NOTICE =
  'この会話はここで一区切りにして、次の発言から新しく開き直す。' +
  '⚠️ 理由は文脈窓ではなく、枠（利用上限）に当たったまま1度も答えを返せずに' +
  '再試行を繰り返しているため——同じセッションへ積み続けると、枠が開いたときには' +
  '文脈が伸びきっている。それまでのやりとりは消えていない（記録は残っている）が、' +
  '私はその続きを覚えていない状態で始まるので、必要なら読み直す。';

// 述語は注入する: 門の実体は `apps/daemon` に在り、`packages/core` はそこへ依存できないため
// `usageBlocked` などは1件ごとに読み直す: ループは1件ごとに `await` するので、前の件の評価時から変わっていることがあるため
export type RedeliveryGate = (
  event: InboxEvent,
  context: {
    usageBlocked: boolean;
    releasePending: boolean;
    usageBlockedResetsAt: number | undefined;
    usageBlockedTokenId: string | undefined;
  },
) => boolean;

export const ALWAYS_REDELIVER: RedeliveryGate = () => true;

function withNoticeTextResetsAt(notice: UsageLimitNotice, at: number): UsageLimitNotice {
  if (notice.resetsAt !== undefined) return notice;
  const resetsAt = parseNoticeResetAt(notice.text, { at, withinMs: DEFAULT_TOKEN_COOLDOWN_MS });
  return resetsAt === undefined ? notice : { ...notice, resetsAt };
}

// synthesized な manager_message は無条件に再武装しない: 機構が合成した失敗の知らせは枠が開いた証拠にならず、1ターン回して 429 を踏むだけのため
// この判定へ `resetsAt` の比較を畳み込まない: `event` だけを見る純関数でなくなり、インスタンス状態が要るため
function usageBlockAlwaysRearms(event: InboxEvent): boolean {
  return (
    isHumanOriginated(event) ||
    (event.type === 'manager_message' && event.synthesized !== true) ||
    (event.type === 'external' && event.source === DAEMON_TOKEN_POOL_REOPENED_SOURCE)
  );
}

export interface CloneOptions {
  stores: Stores;
  provider?: Pick<AgentProvider, 'id' | 'capabilities'>;
  queryFn?: typeof query;
  driver?: AgentCloneDriver;
  // カレントディレクトリに依存させない: 別の場所から起動した途端に resume が迷子になるため
  cwd?: string;
  runners?: RunnerRegistry;
  sessionStore?: SessionStore;
  managers?: ManagerPool;
  env?: NodeJS.ProcessEnv;
  // `env` と別に持つ: 書き写し後の `process.env` を子へ渡すと、正本から外した名前の古い値が子に残り続けるため
  childEnvBase?: NodeJS.ProcessEnv;
  credentials?: () => Record<string, string>;
  tokenIdentity?: () => { tokenId: string; generation: number; fingerprint?: string } | undefined;
  // クローンは回すかどうかを判断しない: 枠に当たるとこのループはターンを回さないので、判断をここへ置くと一番要るときに動かないため
  onUsageObservation?: (observation: TokenRotatorObservation) => Promise<void>;
  onWorkerToolEvent?: (event: WorkerToolEvent) => void;
  // ここで状態を動かさない: `#usageBlocked` を降ろす・保持分を取り出すのは `#pump` の先頭だけで、崩すと隙間に居た合図が1件取り残されるため
  onTokenSessionRecycled?: () => void;
  syncRunnerToken?: (runner: RunnerClient) => Promise<void>;
  permissionMode?: PermissionModeName;
  humanPriority?: boolean;
  mergedBatchLimit?: number;
  dailyReportRetryDelaysMs?: readonly number[];
  profile?: ProfileApplier;
  // デーモンが作った同じインスタンスを渡す: 別のインスタンスを持つと直列化の意味が消え、層ごとに違う本文が残るため
  profileService?: ProfileService;
  credentialService?: CredentialService;
  // 鍵の名前は daemon から受け取る: core は daemon の定数を import できない（依存の向きが逆）ため
  // 伏せるのは `#childEnv()` の最後にする: 正本やプロファイルが同じ名前を重ねてきても生き残らせないため
  withheldEnvKeys?: readonly string[];
  mcpServerService?: McpServerService;
  accountUsage?: () => AccountUsageState;
  // ここで `Scheduler` を作り直さない: デーモン側が組み立てるため
  scheduler?: () => ScheduleStatus[];
  onScheduledRunNotStarted?: (kind: string, delayMs?: number) => void;
  // ここで環境変数を読み直さない: 事実はデーモン側が組み立て、読み直すと出所が2つになるため
  self?: SelfFacts;
  providerOf?: (id: string) => ProviderGapSubject | undefined;
  mcpServerFactory?: typeof createCloneMcpServer;
  cloneToolRelaySocketDir?: string;
  // 省略可能にしない: 書き手ごとに同じ意図の無名関数が散らばるため（全件配るなら `ALWAYS_REDELIVER`）
  redeliveryGate: RedeliveryGate;
}

export type Listener = (event: ChatStreamEvent) => void;

export interface Turn {
  conversationId: string | null;
  approvalId: string | null;
  text: string;
  // 日誌へ書く本文の元は `text` にしない: 道具の実行は直前の assistant メッセージの処理完了前に始まりうり、受信中に見えていた前半が欠けるため
  reply: string;
  replyWritten: number;
  replyMessageStart: number;
  streamed: boolean;
  // 本文は `text` へ入れずここへ置く: 支出上限の文言がそのまま「クローンの応答」になり、日報の本文にまでなるため
  rejected: SdkFailure | null;
  failure: string | null;
  // 配列にする: 「1ターンに複数回」の compaction を否定できないため
  compactions: CompactionObservation[];
  resolve: () => void;
  // `cause` は呼び手（モデル）に申告させない: 書き忘れ・書き間違いがそのまま計器の値になるため
  kind: 'normal' | 'distill';
}

// スキーマ側から引く: 二重に定義すると、どちらかを直し忘れたときに型は緑のまま日誌の形だけがずれるため
type TurnUsageEntry = Extract<JournalEntry, { type: 'turn_usage' }>;
type ContextUsageObservation = NonNullable<TurnUsageEntry['contextUsage']>;

type CompactionObservation = NonNullable<TurnUsageEntry['compactions']>[number];

// 文字列で返さない: 呼び出し側（日報）が成否を判別できず、エラーの文言を応答として保存してしまうため
type TurnOutcome =
  | { status: 'answered'; text: string }
  | {
      status: 'failed';
      reason: string;
      // 真なら合図は捨てられず配り直されるので、呼び出し側は「もう書いた」痕跡を残さない。`Clone#heldForUsage`（Set）とは別物
      heldForUsage: boolean;
    };

// `open()` の戻り値（boolean）を捨てて例外の有無だけで振り分けない: 既に在って何もしなかった回まで 'opened' と記録され、配り直しのたびに仕事が開き直るため
// この値だけで「載せ損なった」と断定しない: `#commit` 時点のスナップショットで、その後に台帳の行が閉じられても古びるため
export type CommitOutcome = 'opened' | 'existed' | 'folded' | 'failed' | 'unrecorded';

export function createClone(options: CloneOptions): CloneHost {
  return new Clone(options);
}

export class ApprovalAlreadySettledError extends Error {
  constructor(
    readonly approvalId: string,
    readonly settled: 'answered' | 'withdrawn',
  ) {
    super(
      `承認待ち ${approvalId} は既に${settled === 'answered' ? '回答済み' : '取り下げ済み'}なので、回答しなかった`,
    );
    this.name = 'ApprovalAlreadySettledError';
  }
}

export class InvalidApprovalSelectionsError extends Error {
  constructor(
    readonly approvalId: string,
    readonly reason: string,
  ) {
    super(`承認待ち ${approvalId} への selections が不正なので、回答しなかった: ${reason}`);
    this.name = 'InvalidApprovalSelectionsError';
  }
}

// id はランダムにしない: `#reconcileUndeliveredAnswers` が同じ入力から同じ id を再現し、`InboxStore#put` の上書きで二重配達を避けるため
export function humanAnswerEventId(approvalId: string, answeredAt: string): string {
  return `human-answer-${approvalId}-${answeredAt}`;
}

function buildHumanAnswerEvent(
  approval: Pick<PendingApproval, 'id' | 'conversationId'>,
  answer: string,
  answeredAt: string,
  via: AnswerApprovalVia | undefined,
  selections?: readonly ApprovalSelection[],
): Extract<InboxEvent, { type: 'human_answer' }> {
  return {
    type: 'human_answer',
    id: humanAnswerEventId(approval.id, answeredAt),
    at: answeredAt,
    approvalId: approval.id,
    answer,
    ...(selections === undefined ? {} : { selections: [...selections] }),
    ...(approval.conversationId === undefined ? {} : { conversationId: approval.conversationId }),
    ...(via === undefined ? {} : { answeredVia: via }),
  };
}

class Clone implements CloneHost {
  readonly #stores: Stores;
  readonly #driver: AgentCloneDriver;
  #contextUsageUnavailableNoted = false;
  readonly #cwd: string | undefined;
  readonly #sessionStore: SessionStore | undefined;
  // `cwd` から計算し直さない: SDK の sanitize（200 文字超は切って djb2 のハッシュを足す）の再実装は静かにずれるため
  #projectKey: string | null = null;
  readonly #managers: ManagerPool;
  // 本セッションと蒸留のサイドクエリで同じものを使う: 片方だけ帯が違うと、蒸留＝人格の書き手だけが別の頭になるため
  readonly #model: string;
  readonly #self: SelfFacts | undefined;
  readonly #providerOf: (id: string) => ProviderGapSubject | undefined;
  readonly #modelOverridden: boolean;
  // `#observedPermissionMode` と1本にしない: 頼んだ値と SDK が init で報告した値の片方だけだと、頼んだ値が通っていないことに気づけないため
  readonly #permissionMode: PermissionModeName;
  readonly #humanPriority: boolean;
  readonly #mergedBatchLimit: number;
  readonly #dailyReportRetryDelays: readonly number[];
  readonly #dailyReportRetries = new Map<string, number>();
  readonly #dailyReportRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  readonly #mcpServerFactory: typeof createCloneMcpServer;
  readonly #cloneToolsTransport: CloneToolsTransport;
  readonly #cloneToolRelaySocketDir: string;
  #cloneToolRelayHostPromise: Promise<CloneToolRelayHost> | undefined;
  #cloneToolRelayChildEntry: string | undefined;

  // 蒸留のサイドクエリの init はここへ反映しない: 別の SDK セッションのため
  #sdkModel: string | null = null;
  #effort: string | null = null;
  #claudeCodeVersion: string | null = null;
  #apiKeySource: string | null = null;
  #observedPermissionMode: string | null = null;
  // `null`（init 未観測）と `[]`（SDK が0本と報告）を畳まない: `self.ts` 側で区別する手段が無くなるため
  #mcpServersInfo: Array<{ name: string; status: string }> | null = null;
  // ここで `getContextUsage()` を呼ばない: `detail: 'full'` は token-count API を呼ぶので、`turn_ended` が既に呼んだ戻り値を代入するだけにするため
  #lastContextUsage: ContextUsageObservation | null = null;
  // 無制限には覚えない: 長く走る1本のセッションでメモリが伸び続けるため。忘れたら `onForget` で日誌へ残す（忘れた id が `permission_denials` に再び載ると同じ拒否が二重に載る）
  readonly #deniedToolUses = createRecentMap<DeniedRecord>({
    limit: DENIED_TOOL_USE_MEMORY_LIMIT,
    onForget: (ids) => {
      void this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'inbound',
        text:
          `${EXCHANGE_KIND_THINNING_PREFIX}二重書き込み防止のために覚えている拒否の記憶が上限` +
          `（${DENIED_TOOL_USE_MEMORY_LIMIT}件）に達したので、古い ${ids.length} 件を忘れた: ` +
          `${ids.join(', ')}。この tool_use_id の拒否が生の合図と result の両方から` +
          '再び届くと、同じ拒否がもう一度日誌に載る。',
      });
    },
  });
  readonly #recentDenials = new RecentDenialLog(RECENT_DENIAL_LIMIT);
  // 決着（`#onPostToolUse` / `#onPostToolUseFailure`）で消す: その後は拒否が来ないため。上限で忘れた id への拒否は検出できず、`onForget` がその代償を日誌へ残す
  readonly #allowedByGrantToolUses = createRecentMap<AllowedByGrantRecord>({
    limit: ALLOWED_BY_GRANT_MEMORY_LIMIT,
    onForget: (ids) => {
      void this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'inbound',
        text:
          `${EXCHANGE_KIND_THINNING_PREFIX}許可 DB の規則に一致して allow を返した記憶が上限` +
          `（${ALLOWED_BY_GRANT_MEMORY_LIMIT}件）に達したので、古い ${ids.length} 件を忘れた: ` +
          `${ids.join(', ')}。この tool_use_id への拒否が後から届いても、もう「hook の allow を` +
          '追い越した」とは検出できない。',
      });
    },
  });
  // 日誌の書き込みは毎回行い、間引くのは注意書きの文言だけにする。上限や永続化は持たせない: 忘れても実害は注意書きがもう一度載るだけのため
  readonly #grantFunneledWarnedOnce = new Set<string>();

  // 台帳（消費）が積まれたかで代用しない: 「いくら使ったか」の軸であって「答えが返ったか」の軸ではないため
  #sessionAnswered = false;

  #heldInSession = false;

  // セッションごとには戻さない: 開き直した新しいセッションでも答えないまま畳み直す連なりを数えるため
  #heldEscalationStreak = 0;

  // 回数ではなく積んだ文字数で数える: 回数だと小さい本文の再試行と本物の事故が同じ桁で、閾値を上げると本物の事故を捕まえられなくなるため。セッションごとに戻す: 持ち越すと前のセッションの量から数え始めるため
  #usageBlockedAccumulatedChars = 0;

  readonly #delivery = new CloneDelivery();

  // 配送の束（`#delivery`）には入れない: あちらは受信箱の遷移で、これは `#emit` の出口の側の状態のため
  readonly #progress = new CloneProgress();

  readonly #inboxFlow = new CloneInboxFlow();

  // タイマーを持たない: 「枠が開いたか」を無料で知る方法が無く、試行の契機は新しい合図が届いたときに限るため
  #usageBlocked: UsageLimitNotice | null = null;
  #restoringUnread = false;
  // 待ち行列から外すだけにしない: `#restoreUnread` は消した後にこれから積むので、消した合図が配られてしまうため
  readonly #droppedWhileRestoring = new Set<string>();
  // `#restoringUnread` が立つ前から控える: 起動直後の `post` の書き込みを `claimPending()` が「前の器の未読」として拾い、同じ発言に2回応えるため
  readonly #postedBeforeRestored = new Set<string>();
  #restorePassFinished = false;
  // 待ち行列は id で重複排除しないのでここで畳む: ライブ配達と拾い直し配達が同じ `human_answer` を2回運びうるため
  readonly #handledHumanAnswerIds = new Set<string>();

  // これより後に回答された行は拾い直さない: `answerApproval` の配達の途中の行を拾うと、同じ合図を2回 `post` し、2回目の回答を古い回答で上書きしうるため
  readonly #bootedAt = new Date().toISOString();
  // 保持した発言を新しい発言と1ターンに束ねない: 束ねた回が再び枠に当たると、新しい発言も保持へ戻り、人間は受け取られたかを判断できなくなるため。`#deferred` と別に持つ: 解除のたびに空になるため
  readonly #heldForUsage = new Set<string>();
  // 印を立てる側（`post()`）と見て動く側（`#pump`）を1つにまとめない: `post()` は同期で呼ばれ `#pump` の `await` の隙間に割り込むので、そこで状態遷移まで済ませるとその隙間の合図が1件取り残されるため
  #releaseRequested = false;
  // 1回ごとには日誌へ書かない: 「保持 N 件×再武装 M 回」を「抑止 M 回」に置き換えるだけのため。解除を試した瞬間の1行（「枠の解除を試す」）へまとめる
  #usageBlockSuppressedRearms = 0;
  // `#usageBlockSuppressedRearms` と1本にしない: 増える契機（`post()` 側と `#pump` 側）が違うため
  #usageBlockFoldedInternalFailures = 0;

  // 配達回数と1つの数に潰さない: `claimPending()` は未読の全行の回数を進めるので、2件以上を同時に拾い直した回の回数は器が入れ替わった回数であり、どの合図が原因かを言えないため
  #restoredCohort = 0;
  readonly #notices = new CloneNotices();

  readonly #distillMemory = new CloneDistillMemoryState();
  readonly #sdkSession = new CloneSdkSession<AgentCloneSession, AgentUserInput>();
  readonly #env: NodeJS.ProcessEnv;
  readonly #childEnvBase: NodeJS.ProcessEnv;
  // 値ではなく関数を持つ: 値だと構築時に凍り、回し手が差し替えたトークンが永久に届かないため
  readonly #credentials: (() => Record<string, string>) | undefined;
  readonly #tokenIdentity:
    (() => { tokenId: string; generation: number; fingerprint?: string } | undefined) | undefined;
  readonly #provider: Pick<AgentProvider, 'id' | 'capabilities'>;
  readonly #onUsageObservation:
    ((observation: TokenRotatorObservation) => Promise<void>) | undefined;
  readonly #onTokenSessionRecycled: (() => void) | undefined;
  // 鍵は枠の種類だけにしない: アカウントはトークンのプールで複数あり、`kind` だけだと別々のアカウントの事実が同じ欄を踏み合うため。状態をそのまま回し手へ流さない: `rate_limit_event` はターンの頭ごとに来て、同じ `rejected` で毎ターン回そうとするため
  readonly #rateLimits = new Map<string, RateLimitFacts>();
  // 畳むたびには日誌へ書かない: `folded` へ足すだけにして、次に `transition` が定まった回にまとめて吐き出す（日誌の肥大化を作り直さないため）。同じ会話の連打は「跨いだ」に数えない
  readonly #rateLimitCrossFold = new Map<
    string,
    { lastConversationId: string | null; folded: Set<string | null> }
  >();
  readonly #profile: ProfileApplier | undefined;
  readonly #profileService: ProfileService | undefined;
  // 読み出し専用の窓だけを持つ: 置いて配る操作（`apply` / `syncRunner`）は `createManagerPool` へ渡した同じインスタンスの役目のため
  readonly #credentialService: CredentialService | undefined;
  readonly #withheldEnvKeys: readonly string[];
  readonly #accountUsage: (() => AccountUsageState) | undefined;
  readonly #scheduler: (() => ScheduleStatus[]) | undefined;
  readonly #onScheduledRunNotStarted: ((kind: string, delayMs?: number) => void) | undefined;
  readonly #timerTurnRetries = new Map<string, { at: string; attempts: number }>();
  readonly #redeliveryGate: RedeliveryGate;

  constructor(options: CloneOptions) {
    const {
      stores,
      provider,
      queryFn,
      driver,
      cwd,
      runners,
      sessionStore,
      managers,
      env,
      childEnvBase,
      credentials,
      tokenIdentity,
      onUsageObservation,
      onWorkerToolEvent,
      onTokenSessionRecycled,
      syncRunnerToken,
      permissionMode,
      humanPriority,
      mergedBatchLimit,
      dailyReportRetryDelaysMs,
      profile,
      profileService,
      credentialService,
      withheldEnvKeys,
      mcpServerService,
      accountUsage,
      scheduler,
      onScheduledRunNotStarted,
      self,
      providerOf,
      mcpServerFactory,
      cloneToolRelaySocketDir,
      redeliveryGate,
    } = options;
    this.#stores = stores;
    this.#provider = provider ?? CLAUDE_PROVIDER;
    this.#driver =
      driver ?? new ClaudeCloneDriver({ ...(queryFn === undefined ? {} : { queryFn }) });
    this.#cwd = cwd;
    this.#sessionStore =
      sessionStore === undefined
        ? undefined
        : withProjectKeyProbe(sessionStore, (projectKey) => {
            this.#noteProjectKey(projectKey);
          });
    const envSource = env ?? process.env;
    this.#model = resolveCloneModel(envSource);
    this.#modelOverridden = placedCloneModel(envSource) !== null;
    this.#permissionMode = permissionMode ?? resolveClonePermissionMode(envSource);
    this.#humanPriority = humanPriority ?? resolveCloneHumanPriority(envSource);
    this.#mergedBatchLimit = mergedBatchLimit ?? resolveMergedBatchSizeLimit(envSource);
    this.#dailyReportRetryDelays = dailyReportRetryDelaysMs ?? DAILY_REPORT_RETRY_DELAYS_MS;
    this.#env = envSource;
    this.#childEnvBase = childEnvBase ?? envSource;
    this.#credentials = credentials;
    this.#tokenIdentity = tokenIdentity;
    this.#onUsageObservation = onUsageObservation;
    this.#onTokenSessionRecycled = onTokenSessionRecycled;
    this.#profile = profile;
    this.#profileService = profileService;
    this.#credentialService = credentialService;
    this.#withheldEnvKeys = withheldEnvKeys ?? [];
    this.#accountUsage = accountUsage;
    this.#scheduler = scheduler;
    this.#onScheduledRunNotStarted = onScheduledRunNotStarted;
    this.#self = self;
    this.#providerOf = providerOf ?? knownProviderOf;
    this.#mcpServerFactory = mcpServerFactory ?? createCloneMcpServer;
    // 駆動役が経路を決めるなら env より優先する: Codex は別プロセスで、インプロセスの MCP を持てないため
    this.#cloneToolsTransport = resolveCloneToolsTransportFor(
      this.#driver.requiredToolsTransport,
      envSource,
    );
    this.#cloneToolRelaySocketDir = cloneToolRelaySocketDir ?? DEFAULT_CLONE_TOOL_RELAY_SOCKET_DIR;
    this.#redeliveryGate = redeliveryGate;
    this.#managers =
      managers ??
      createManagerPool({
        stores,
        ...(profileService === undefined ? {} : { profile: profileService }),
        ...(credentialService === undefined ? {} : { credentials: credentialService }),
        ...(mcpServerService === undefined ? {} : { mcpServers: mcpServerService }),
        post: (event) => this.post(event),
        runners: runners ?? createRunnerRegistry([]),
        // クローンの側とプールの側で別々の回し手へ渡さない: 同じ1本へ集めるから、世代の照合が「同じ当たりで1回だけ」を保証できるため
        ...(tokenIdentity === undefined ? {} : { tokenIdentity }),
        ...(onUsageObservation === undefined ? {} : { onUsageObservation }),
        ...(onWorkerToolEvent === undefined ? {} : { onWorkerToolEvent }),
        ...(syncRunnerToken === undefined ? {} : { syncRunnerToken }),
      });
    // 握り潰さない: 生き残ると HTTP は答え続け、受信箱は積まれ続けたまま誰も気づかない（落ちて再起動すれば `#restoreUnread` が配り直す）
    // `.catch(...)` まで含めた Promise を保持する: 素の `#pump()` だと、`stop()` が待つより前に投げた分が unhandled rejection になるため
    this.#sdkSession.beginPumpLoop(
      this.#pump().catch((error: unknown) => {
        noteBackgroundFailure('クローンの受信箱のループ', '', error);
        throw error;
      }),
    );
  }

  // セッションには触らず印だけ立てる: いま走っているターンは最後まで走らせるため。セッションがまだ無ければ印を立てない: 次に作られる新しい鍵のセッションがいきなり畳まれるため
  // 返り値を捨てない: `'deferred'` の回に「再開の合図」を先に入れると、古い鍵のターンに消費されて沈黙する（`onTokenSessionRecycled` が鳴ってから入れる）
  recycleSessionForToken(): 'now' | 'deferred' {
    if (this.#sdkSession.query === null) return 'now';
    this.#sdkSession.requestTokenRecycle();
    this.#sdkSession.wakeInput();
    return 'deferred';
  }

  get managers(): ManagerPool {
    return this.#managers;
  }

  // 別の判定を書かない: `#deliver` の `heldForUsage` も同じ `#usageBlocked !== null` を読んでおり、ずれると「保持しているのに呼び出し側は保持していないと思っている」がありうるため
  get usageBlocked(): boolean {
    return this.#usageBlocked !== null;
  }

  activeTurn(): { conversationId?: string; kind: 'normal' | 'distill' } | null {
    const turn = this.#sdkSession.turn;
    if (turn === null) return null;
    return {
      ...(turn.conversationId === null ? {} : { conversationId: turn.conversationId }),
      kind: turn.kind,
    };
  }

  get usageReleasePending(): boolean {
    return this.#releaseRequested;
  }

  get usageBlockedResetsAt(): number | undefined {
    return this.#usageBlocked?.resetsAt;
  }

  // `#usageBlocked` を経由しない: 枠に当たっても回すまでは同じセッションのまま走り続けるので、セッションの身元をそのまま返せば足りるため
  get usageBlockedTokenId(): string | undefined {
    return this.#sdkSession.sessionTokenIdentity?.tokenId;
  }


  post(event: InboxEvent): void {
    this.#admit(event, false);
  }

  // 書けなかった合図は配達しない: メモリに積んで配達すると、503 で断られた相手が送り直した回に同じ出来事が2回届き、外部イベントの id はデーモンが採番するので id で弾けないため
  postPersisted(event: InboxEvent): Promise<PostPersistOutcome> {
    return Promise.resolve(this.#admit(event, true) ?? 'persisted');
  }

  #admit(event: InboxEvent, durable: boolean): Promise<PostPersistOutcome> | undefined {
    // 受信箱へは積まない: 閉じた受信箱へ `Inbox#push` すると投げるため
    // 「次の起動へ回した」と言い切らない: この窓の後半ではストアが既に閉じており書き込みは落ちうるため
    // `#inbox.closed` も見る: `stop()` は受信箱を閉じてから `#stopped` を立てるので、`#stopped` だけで判定するとその間に届いたものが閉じた受信箱へ `push` して投げるため
    if (this.#sdkSession.stopped || this.#delivery.inbox.closed) {
      // ここでも畳む: 畳まなければ片付け中に届いた同文の連投が行の増殖としてディスクに残るため
      // `canQueue: false` で呼ぶ: この窓の合図は待ち行列へ入らず、`external` でも「行だけ畳んでターンは #841 へ任せる」が成り立たないため
      if (this.#foldIntoPendingCollapse(event, { canQueue: false }) !== 'pass') return;
      if (durable) return this.#persistThenSettleClosed(event);
      // 同じ `canQueue: false` を `#remember` へも流す: この窓は `#inbox.push` を通らないので、拾い直しが尽きたときの跡に「メモリの待ち行列に残る」を使うと嘘になるため
      this.#remember(event, { canQueue: false });
      this.#commit(event);
      noteDroppedInboxEvent(event);
      return;
    }

    // `isTick` の畳み込みより前に置く: 畳まれる tick でも「新しい合図が届いた」事実は本物で、解除自体はモデルを呼ばないため
    // ここでは印を立てるだけにする: `#pump` の後始末の最中にも割り込むので、ここで状態を動かすとその隙間の合図が1件取り残されるため
    // 回復予定時刻より前なら、新しい情報を運ばない合図では再武装しない: 保持 N 件×再武装 M 回で N×M 件の「内部ターンが失敗した」を日誌へ書くため
    // 構造化 payload を持たない token-pool 通知は無条件に再武装する: 判定できないときは能力を削らない側へ倒すため
    if (this.#usageBlocked !== null) {
      const resetsAt = this.#usageBlocked.resetsAt;
      const stillCoolingDown = resetsAt !== undefined && Date.now() < resetsAt;
      const staleSameKeyRecovery = staleObservedRecoveryNoticeEvent(
        event,
        resetsAt,
        this.#sdkSession.sessionTokenIdentity?.tokenId,
      );
      if ((!usageBlockAlwaysRearms(event) || staleSameKeyRecovery) && stillCoolingDown) {
        this.#usageBlockSuppressedRearms += 1;
      } else {
        this.#releaseRequested = true;
      }
    }

    // 新しい発言への返事は畳まない: 「自分の発言だけがあって返信が無い」へ戻るため。ターンの中ではなく受理の時点に置く: 枠が閉じている間の発言はターンが短絡され、仕切り直しが1度も走らないため
    // 落とすのはその会話のぶんだけ: 会話をまたいで消すと、別の会話で返してある1行の記憶が消え、試し直しでまた1行増えるため
    if (event.type === 'human_message') this.#notices.forgetConversation(event.conversationId);

    // 人間の発言・マネージャーからの一件・外部イベントは畳まない: 中身が違うため
    // `#mergedHumanBatch` の側をこの `return` に足さない: あちらは捨てず、全文が届いた順に渡り、合図は件数ぶん器に残るため
    if (isTick(event) && this.#delivery.inbox.hasPending((queued) => isSameTick(queued, event)))
      return;

    // `isTick` の畳み込みより後に置く: tick は中身が無いから畳め、こちらは中身が同じだから畳むという別の判定のため
    // `external` は行だけ畳んで待ち行列へは入れる（`row-folded`）: 抜くと `#mergedExternalBatch` の束ね読みが消えるため
    // token-pool の「戻った」だけ先に1件へ絞る: `#foldIntoPendingCollapse` は本文が一字一句同じ場合しか畳めず、429↔成功の往復で本文が変わるたびにすり抜けるため
    if (event.type === 'external' && event.source === DAEMON_TOKEN_POOL_REOPENED_SOURCE) {
      this.#foldPendingTokenPoolNotice(event);
    }
    const collapse = this.#foldIntoPendingCollapse(event, { canQueue: true });
    if (collapse === 'folded') return;

    // 境界を「queue に入った時点」に置かない: 暇なときに届いた合図は `Inbox#push` の waiter 経路で queue を素通りするため
    // `row-folded` のときだけこの3つを飛ばす: 同じ本文の未読が既に器に在り、行を増やしても仕事は1件のままで、増えるのは拾い直される行数だけのため
    if (collapse === 'pass') {
      // `canQueue: true` を `#remember` へも流す: この経路は下で必ず `#inbox.push` するので、拾い直しが尽きても合図はメモリの待ち行列に残るため
      if (!this.#restorePassFinished) this.#postedBeforeRestored.add(event.id);
      if (durable) return this.#persistThenEnqueue(event);
      this.#remember(event, { canQueue: true });
      this.#record(event);
      // 未了として開くのをターンの中に置かない: ターンが例外で落ちた合図は `#forget` されて二度と来ないので、「処理に失敗した依頼」だけが台帳に載らなくなるため
      this.#commit(event);
    }
    this.#enqueue(event);
    return undefined;
  }

  #enqueue(event: InboxEvent): void {
    // 走行中のターンは止めない: 止めると掛かった分が捨てられるため（できるのは次に読むものを人間にするまで）
    this.#inboxFlow.delivered(event.type);
    this.#delivery.inbox.push(
      event,
      this.#humanPriority && isHumanOriginated(event) ? isHumanOriginated : undefined,
    );
  }

  // 書けなかったら書きかけを消す: 「失敗」を返しつつ実は通っていた場合に、次の起動の配り直しで二重に届くため
  async #persistThenEnqueue(event: InboxEvent): Promise<PostPersistOutcome> {
    const failure = await this.#tryPersistUnread(event);
    if (failure !== null) {
      await this.#rollbackUnread(event);
      noteInboxEventRefused(inboxEventShape(event), failure.error);
      return 'unavailable';
    }
    this.#inboxFlow.arrived(event.type);
    this.#delivery.setUnread(event.id, Promise.resolve());
    if (this.#sdkSession.stopped || this.#delivery.inbox.closed) {
      this.#commit(event);
      noteDroppedInboxEvent(event);
      return 'persisted';
    }
    this.#record(event);
    this.#commit(event);
    this.#enqueue(event);
    return 'persisted';
  }

  async #persistThenSettleClosed(event: InboxEvent): Promise<PostPersistOutcome> {
    const failure = await this.#tryPersistUnread(event);
    if (failure !== null) {
      await this.#rollbackUnread(event);
      noteInboxEventRefused(inboxEventShape(event), failure.error);
      return 'unavailable';
    }
    this.#inboxFlow.arrived(event.type);
    this.#delivery.setUnread(event.id, Promise.resolve());
    this.#commit(event);
    noteDroppedInboxEvent(event);
    return 'persisted';
  }

  async #rollbackUnread(event: InboxEvent): Promise<void> {
    try {
      await this.#stores.inbox.remove(event.id);
    } catch {
    }
  }

  // ストア側から `Clone` を呼ばせない: ストアは `Clone` を知らず、繋ぎ目は消す側の呼び手に置くため
  // `#forget` は呼ばない: 呼び手が既に器から消しており、呼ぶと `stores.inbox.remove` が空振りして `settled` を二重に数えるため
  // 処理中の1件は取り消さない: 走っているターンを止めると掛かった分が捨てられるため
  async dropQueuedInboxEvents(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const targets = new Set(ids);

    // 待ち行列を外すより前に墓標を残す: 後に置くと、`await` を挟んだ隙にループが1件積む窓ができるため
    if (this.#restoringUnread) for (const id of targets) this.#droppedWhileRestoring.add(id);

    const fromQueue = this.#delivery.inbox.removeWhere((event) => targets.has(event.id));

    // 枠（利用上限）で保持している分（`#deferred`）も落とす: 忘れると、枠の解除で待ち行列の先頭へ戻されてそのまま配られるため
    // 後ろから外す: 前から splice すると1件外すごとに次を読み飛ばすため
    const fromHeld = this.#delivery.removeDeferredWhere((held) => targets.has(held.id));

    for (const event of [...fromQueue, ...fromHeld]) {
      this.#delivery.deleteUnread(event.id);
      this.#delivery.redeliveryState.drop(event.id);
      this.#dropPendingCollapse(event);
      // 走っているターンがその会話のものなら触らない: そのターンの終端が捨てるため
      if (
        event.type === 'human_message' &&
        this.#sdkSession.turn?.conversationId !== event.conversationId
      ) {
        this.#progress.clear(event.conversationId);
      }
    }

    const dropped = fromQueue.length + fromHeld.length;
    if (dropped === 0) return 0;

    // id をここに並べない: 呼び手が既に自分の記録へ書いており、並べると 3,000 件規模の消し込みでこの1行が日誌を埋めるため
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_THINNING_PREFIX}器から消された合図 ${ids.length} 件のうち、${dropped} 件を配達の待ち行列からも外した` +
        `（待ち行列 ${fromQueue.length} 件、枠で保持していた分 ${fromHeld.length} 件）。` +
        '既に取り出して処理中のものは取り消していない。',
    });
    return dropped;
  }

  subscribe(conversationId: string, listener: Listener): () => void {
    const set = this.#delivery.subscribeListener(conversationId, listener);
    return () => {
      this.#delivery.unsubscribeListener(conversationId, listener, set);
    };
  }

  // 写しを取ることと購読を張ることを、await を挟まない同じ同期区間で行う: `#emit` も同期なので、取りこぼしも二重渡しも無くなるため
  attach(
    conversationId: string,
    listener: Listener,
  ): { inProgress: ChatStreamEvent[] | null; unsubscribe: () => void } {
    const inProgress = this.#progress.snapshot(conversationId);
    const unsubscribe = this.subscribe(conversationId, listener);
    return { inProgress, unsubscribe };
  }

  // 先に日誌へ書いてから止める: 止めた後に書くと、止めたことで起きた失敗の記録より後ろに並んで順序が逆に読めるため
  async interruptTurn(): Promise<'interrupted' | 'idle'> {
    const turn = this.#sdkSession.turn;
    const q = this.#sdkSession.query;
    if (turn === null || q === null) return 'idle';
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_DECISION_PREFIX}人間の求めで、走っているターンを止めた（` +
        `${turn.kind === 'distill' ? '蒸留' : '通常'}のターン）。セッションと受信箱はそのまま残る`,
      ...(turn.conversationId === null ? {} : { conversationId: turn.conversationId }),
    });

    // 書いた後にもう一度、同じターン・同じ query かを確かめる: `await` の間に次のターンが始まると、人間が止めようとしていないターンを止めるため
    if (this.#sdkSession.turn !== turn || this.#sdkSession.query !== q) {
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_DECISION_PREFIX}止めようとしたターンは既に終わっていたので、止めなかった` +
          '（直前の「止めた」の行は取り消す。次のターンには触れていない）',
        ...(turn.conversationId === null ? {} : { conversationId: turn.conversationId }),
      });
      return 'idle';
    }

    try {
      await q.interrupt();
    } catch (error) {
      // 伏せる手がかりの env は `process.env` でなく注入された `this.#env` を渡す: `process.env` だと器の環境変数の値に一致する字面まで伏せ、結果が器ごとに変わるため
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_FAILURE_PREFIX}ターンを止められなかった（${describeProbeError(error, this.#env)}）。` +
          '直前の「止めた」の行は取り消す。ターンは走ったまま',
        ...(turn.conversationId === null ? {} : { conversationId: turn.conversationId }),
      });
      throw error;
    }
    return 'interrupted';
  }

  async endConversation(conversationId: string): Promise<void> {
    // `interrupt: true` を渡す: 人間が画面の前で待っており、末尾へ積むだけだと先に積まれた非人間の合図を全部読み終えるまで待たされるため。`stop()` の `shutdown` は同じ待ちが無いので渡さない
    await this.#postAndWait(
      {
        type: 'distill',
        id: randomUUID(),
        at: new Date().toISOString(),
        reason: 'conversation_end',
      },
      true,
    );
    this.#delivery.dropListenersIfEmpty(conversationId);
    // 畳み込みの記憶も一緒に落とす: 会話は無限に増えうるので、失敗した会話のぶんが増え続ける形にしないため
    this.#notices.forgetConversation(conversationId);
  }

  async answerApproval(
    approvalId: string,
    suppliedAnswer: string,
    via?: AnswerApprovalVia,
    selections?: readonly ApprovalSelection[],
  ): Promise<void> {
    // `UnreadableApprovalError` をそのまま出す: 「存在しない」に畳むと、呼び手が「在るが読めない」（HTTP は 409）と言えなくなるため
    const approval = await this.#stores.jobs.getApproval(approvalId);
    if (!approval) throw new Error(`承認待ち ${approvalId} は存在しない`);

    let answer = suppliedAnswer;
    if (selections !== undefined) {
      const violation = describeSelectionsViolation(approval.questions, selections, suppliedAnswer);
      if (violation !== null) throw new InvalidApprovalSelectionsError(approvalId, violation);
      answer = foldSelections(approval.questions ?? [], selections, suppliedAnswer);
    }

    const answeredAt = new Date().toISOString();
    // `answerDelivery: 'pending'` を先に書く: 受信箱への永続化までの間に落ちた行を、`#reconcileUndeliveredAnswers` が起動時に拾い直すため
    // `getApproval` の写しを `putApproval` で書き戻さない: 回答済み・取り下げ済みを見ないまま回答が立ち、同じ承認への2つの回答が両方通る（仕事が2回再開しうる）ため
    let settled: 'answered' | 'withdrawn' | undefined;
    const written = await this.#stores.jobs.updateApproval(approvalId, (current) => {
      if (current.withdrawnAt !== undefined) {
        settled = 'withdrawn';
        return null;
      }
      if (current.answeredAt !== undefined) {
        settled = 'answered';
        return null;
      }
      return {
        ...current,
        answeredAt,
        answer,
        ...(selections === undefined ? {} : { selections: [...selections] }),
        answerDelivery: 'pending',
        ...(via === undefined ? {} : { answeredVia: via }),
      };
    });
    if (written === null) {
      if (settled !== undefined) throw new ApprovalAlreadySettledError(approvalId, settled);
      throw new Error(`承認待ち ${approvalId} は存在しない`);
    }

    await this.#journal({
      type: 'escalation',
      question: approval.question,
      approvalId,
      answeredAt,
      answer,
      ...(via === undefined ? {} : { answeredVia: via }),
    });

    await this.#recordPermissionGrantIfConsented(approval, answer, answeredAt, via);

    const event = buildHumanAnswerEvent(approval, answer, answeredAt, via, selections);

    // 失敗しても投げない: ここは落ちたときの保険であり、ライブ配達（`post()`）を止める理由にならないため
    let delivery: 'pending' | 'delivered' = 'pending';
    try {
      await this.#stores.inbox.put(event, event.at);
      delivery = 'delivered';
    } catch (error) {
      noteDroppedRecord('回答の配達印の先出し', inboxEventShape(event), error);
    }

    // 先出しが成功した回だけ配達済みの印を立てる: 失敗したまま立てると、受信箱に無いのに「配達済み」の行ができ、`#reconcileUndeliveredAnswers` が二度と拾い直さなくなるため
    if (delivery === 'delivered') {
      try {
        await this.#markAnswerDelivered(approvalId, answeredAt);
      } catch (error) {
        noteDroppedRecord('回答の配達印の確定', inboxEventShape(event), error);
      }
    }

    this.post(event);
  }

  // `via.kind === 'operator'` や `via === undefined` では記録しない: operator の token はクローン自身の Bash からも読め、クローンが `answer` を偽造できて人間の証拠にならないため
  // 記録に失敗しても投げない: 許可の記録は副産物で、人間への回答という主作用を巻き込まないため
  async #recordPermissionGrantIfConsented(
    approval: PendingApproval,
    rawAnswer: string,
    answeredAt: string,
    via: AnswerApprovalVia | undefined,
  ): Promise<void> {
    const { permissionRequest } = approval;
    if (permissionRequest === undefined) return;

    // 同意の判定は NUL を落とした後の値で行う: 落とす前の値だと、行に残る値は定型文ちょうどなのに許可が記録されず、保存後の値を読む起動時の拾い直しと結果が食い違うため
    const answer = stripNul(rawAnswer);

    const grounds = `approvalId=${approval.id}・rule=${permissionRequest.rule}`;

    if (answer.trim() !== PERMISSION_GRANT_CONSENT_PHRASE) {
      await this.#journal({
        type: 'decision',
        decision: `許可を記録しなかった: ${permissionRequest.rule}`,
        grounds: `回答が定型文（${PERMISSION_GRANT_CONSENT_PHRASE}）と一致しない（${grounds}）`,
      });
      return;
    }
    if (via === undefined) {
      await this.#journal({
        type: 'decision',
        decision: `許可を記録しなかった: ${permissionRequest.rule}`,
        grounds: `回答の経路が指定されていない——既定は不許可（${grounds}）`,
      });
      return;
    }
    if (via.kind !== 'account') {
      await this.#journal({
        type: 'decision',
        decision: `許可を記録しなかった: ${permissionRequest.rule}`,
        grounds:
          `回答の経路が実行環境の持ち主（operator。認証: ${via.auth}）だった——operator の資格は` +
          `クローンの器から読めるため、人間の証拠にならない（${grounds}）`,
      });
      return;
    }

    const grant: PermissionGrant = {
      id: randomUUID(),
      rule: permissionRequest.rule,
      allows: permissionRequest.allows,
      denies: permissionRequest.denies,
      approvalId: approval.id,
      answer,
      grantedAt: answeredAt,
      route: { principalKind: 'account', accountId: via.accountId },
    };
    try {
      await this.#stores.permissionGrants.put(grant);
    } catch (error) {
      await this.#journal({
        type: 'decision',
        decision: `許可の記録に失敗した: ${permissionRequest.rule}`,
        grounds: `${collapseErrorCause(error)}（${grounds}）`,
      });
      return;
    }
    await this.#journal({
      type: 'decision',
      decision: `許可を記録した: ${permissionRequest.rule}`,
      grounds: `許可されたアカウント（${via.accountId}）の回答（${grounds}）`,
    });
  }

  async stop(options?: { farewellDeadlineAt?: number }): Promise<void> {
    for (const timer of this.#dailyReportRetryTimers) clearTimeout(timer);
    this.#dailyReportRetryTimers.clear();
    // `#inbox.closed` も見る: 読み切りのあいだ `#stopped` はまだ立っておらず、`#stopped` だけで守ると2度目の呼びが本体をもう一度走らせるため
    if (this.#sdkSession.stopped || this.#delivery.inbox.closed) return;

    // 蒸留は無条件に投げる: 「前回の蒸留以降に新しいことがあったか」の判定は `#handle` の `'distill'` 分岐に1本化してあり、ここで判定すると2か所に散るため
    // `interrupt` を渡す: shutdown は `FORCED_EXIT_MS` で打ち切られるので、待ち行列が詰まっていると蒸留が切られ、会話1区間まるごと失われるため（shutdown の蒸留はプロセスにつき高々1回で、有界性は崩れない）
    if (this.#sdkSession.query) {
      await this.#postAndWait(
        {
          type: 'distill',
          id: randomUUID(),
          at: new Date().toISOString(),
          reason: 'shutdown',
        },
        true,
      ).catch(() => undefined);
    }

    this.#delivery.inbox.close();

    // 割り込ませたら、読み切ってから畳む: 割り込みだけ足すと待ち行列に残った非人間が1件もモデルへ届かず、器に未読が残るため（`clone-turn-queue.test.ts` が押さえる）
    // `#stopped` は読み切りの後で立てる: 先に立てると `#inputStream` が入力の generator を畳んで蒸留の次のターンが永久に完了せず、`#read` の `finally` が丸ごと飛んで宙吊りのターンを誰も解放しないため（`#stopped` は新しい仕事を受けない印ではなく、それは `#inbox.closed` が持つ）
    await this.#sdkSession.pumpLoop;

    this.#sdkSession.markStopped();
    this.#progress.clearAll();
    this.#sdkSession.wakeInput();
    // 閉じる前に累積を1回読む: デーモンの停止でここを通ったぶんは `result` を出さず、読まなければ台帳に1行も残らないため
    await this.#flushSessionUsage();
    this.#sdkSession.closeQuery();
    await this.#sdkSession.reader?.catch(() => undefined);
    await this.#managers.stop(options).catch(() => undefined);
    if (this.#cloneToolRelayHostPromise !== undefined) {
      const relayHost = await this.#cloneToolRelayHostPromise.catch(() => undefined);
      relayHost?.close();
    }
  }

  // `isHumanOriginated` を広げない: `distill` を人間起点の型にすると、蒸留という型そのものが常に割り込む側になり、有界性の根拠を型で支えられなくなるため（割り込ませるかは引数で呼び出し側が決める）
  #postAndWait(event: InboxEvent, interrupt = false): Promise<void> {
    if (this.#sdkSession.stopped || this.#delivery.inbox.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#delivery.registerCompletion(event.id, resolve);
      this.#inboxFlow.delivered(event.type);
      this.#delivery.inbox.push(
        event,
        interrupt && this.#humanPriority
          ? (queued) =>
              isHumanOriginated(queued) ||
              (queued.type === 'distill' && queued.reason === 'conversation_end')
          : undefined,
      );
    });
  }

  async #pump(): Promise<void> {
    // 拾い直しは待たない: 器が詰まっていると `claimPending` が返らず受信箱のループが始まらず、`for await` の最初の `next()` が遅れて起動直後の合図の畳み込み方が変わるため。待たない以上、失敗は自分で受ける（漏らすと unhandled rejection でデーモンごと落ちる）
    void this.#restoreUnread().catch((error: unknown) => {
      noteDroppedRecord('未読の読み直し', '', error);
    });

    // 墓標の拾い直しも待たない: こちらはモデルを呼び、枠が閉じていると人間の発言がその間ずっと処理されないため
    void this.#pickUpTranscriptGrave().catch((error: unknown) => {
      noteDroppedRecord('墓標の拾い直し', '', error);
    });

    // 2本に分けたまま畳まない: 指す先と拾い方が違い、畳むとどちらの材料が無かったのかが日誌から消えるため
    void this.#pickUpLostSession().catch((error: unknown) => {
      noteDroppedRecord('捨てたセッションの拾い直し', '', error);
    });

    for await (const event of this.#delivery.inbox) {
      // 枠の解除は `post()` からでなくここでだけ行う: `post()` は後始末の隙間にも割り込み、先に降ろすと `defer: false` で枠で失敗しただけの合図が `#forget` されて再起動でも戻らず、また保持した合図が `#deferred` へ積まれる前に取り出されずこのプロセスで二度と処理されないため
      // 片付け中は解除しない（`#inbox.closed` を見る）: `Inbox#unshift` は閉じた受信箱で投げ、ここは `try` の外なので `for await` ごと抜けて受信箱のループが死ぬため（保持した分は器に未読で残り、次の起動で拾い直される）
      if (this.#releaseRequested && !this.#delivery.inbox.closed) {
        this.#releaseRequested = false;
        if (this.#usageBlocked !== null) {
          this.#usageBlocked = null;
          const held = this.#delivery.drainDeferred();
          // `held` → `event` の順で先頭へ戻す: `event` は `held` より後に届いており、末尾へ push すると到着順が崩れるため
          // `#remember` / `#record` / `#commit` はやり直さない: 器には `held` が未読で残っており、やり直すと記帳・日誌追記が二重になるため
          // 「`held` が空なら戻さない」を足さない: 分岐が増えるだけで、通る条件が構造上ほぼ起きずテストの当たらない道になるため
          this.#delivery.inbox.unshift([...held, event]);
          // 抑止した再武装と畳んだ内部の失敗記録は1回ごとには書かず、この1行へ畳む: 書くと二乗の書き込みをこちらへ移すだけのため
          const suppressedRearms = this.#usageBlockSuppressedRearms;
          const foldedInternalFailures = this.#usageBlockFoldedInternalFailures;
          this.#usageBlockSuppressedRearms = 0;
          this.#usageBlockFoldedInternalFailures = 0;
          const counts =
            (suppressedRearms > 0
              ? ` 回復予定時刻より前だったので再武装を抑止: ${String(suppressedRearms)} 回。`
              : '') +
            (foldedInternalFailures > 0
              ? ` 人間が待っていない内部の失敗記録を畳んだ: ${String(foldedInternalFailures)} 件。`
              : '');
          // 件数の射程を行そのものに名乗らせる: カウンタはメモリ上にしか無く、件数は下限のため。件数が0の行には付けない
          const suffix =
            counts === ''
              ? ''
              : `${counts}（件数・回数は、この枠の区間でこのプロセスが数えた分だけ。器の入れ替えを跨いだ分と、ターンの成功で枠が降りた回の分は数えずに0へ戻るので、実際より少ない＝下限。）`;
          await this.#journal({
            type: 'exchange',
            with: 'self',
            role: 'outbound',
            text: `${EXCHANGE_KIND_THINNING_PREFIX}枠の解除を試す。新しい合図が届いたので、保持していた ${held.length} 件を配り直す。${suffix}`,
          });
          continue;
        }
      }

      // 枠（利用上限）が閉じている間はターンを回さない（金を払わない）。`#usageBlocked` は既に立っている場合はここで短絡し、今回の `#handle` で立つ場合は下の `finally` で拾う
      if (this.#usageBlocked !== null) {
        const notice = this.#usageBlocked;
        // `error` は終端なので、枠が閉じていること自体（消えない情報）を必ず先に届ける
        this.#emit(this.#conversationOf(event), {
          type: 'usage_limited',
          message: describeUsageNotice(notice),
        });
        // 内部の合図（人間が待っていない）では `#reportFailure` を呼ばない: 呼ぶたびに日誌へ1行書き、保持 N 件×再武装 M 回で N×M 行になるため（他の副作用は no-op で、残る効果は日誌の1行だけ。件数は `#usageBlockFoldedInternalFailures` へ積み、「枠の解除を試す」の1行へまとめる）
        if (this.#conversationOf(event) === null) {
          this.#usageBlockFoldedInternalFailures += 1;
        } else {
          await this.#reportFailure(
            this.#conversationOf(event),
            '枠が閉じているので、いまは投げていない。合図は保持してある。次に別の合図が' +
              `届いたとき、保持した分から順に試し直す（${describeUsageNotice(notice)}）`,
          );
        }
        await this.#settleInboxEvent(event, true);
        continue;
      }

      // 素朴に `continue` しない: `manager_message` / `external` の本文追記が落ち、`retrievalHintFor` が案内する「処理されるたびに全文が日誌へ書かれる」が静かに嘘になるため（型ごとの本文追記と「畳んだ」の1行は `#foldClosedRedelivery` が書く）
      // 判定できないときは起こす側へ倒す: 台帳を引けなかった合図は `#redeliveredClosed` に載らず、通常経路（全文でターンを回す）へ落ちるため
      // 枠の短絡より後ろに置く: 前に置くと保持の不変条件（`#heldForUsage` / `#deferred` / `finally` の `defer`）と交差する枝が1本増えるだけで、畳む回数は変わらないため
      const closedRedelivery = this.#closedRedeliveryNoticeFor(event);
      if (closedRedelivery !== null) {
        await this.#foldClosedRedelivery(event, closedRedelivery);
        // `defer: false` で器の未読からも外す: 残すとこの1件だけが起動のたびに配り直されるため
        await this.#settleInboxEvent(event, false);
        continue;
      }

      // まとめ読みの判定を呼ぶ前に必ずリセットする: `#drainMergeableWithinLimit` は対象外の起点では呼ばれず、戻さないと前の反復で切ったときの断り書きが持ち越されるため。判定の呼び出しより下に置かない: 立った印を拭き取り、`external` の束でだけ断り書きが黙って消えるため
      this.#notices.set('mergedBatchTruncation', '');
      const mergedHuman = this.#mergedHumanBatch(event);
      const mergedReports = this.#mergedManagerReportBatch(event);
      const mergedExternal = this.#mergedExternalBatch(event);
      const batch: InboxEvent[] = mergedHuman ?? mergedReports ?? mergedExternal ?? [event];

      this.#notices.set('redelivery', this.#redeliveryNoticeFor(batch));
      // `try` の外: 投げれば `for await` ごと抜けて受信箱のループが死ぬので、握り漏らしに備えて外側にも受けを置く（断り書きが付かないことよりループが止まることの方がずっと高い）
      this.#notices.set(
        'commitment',
        await this.#commitmentNoticeFor(batch).catch((error: unknown) => {
          noteDroppedRecord('未了の断り書きの組み立て', inboxEventShape(event), error);
          return '';
        }),
      );
      // 読めなければ消さずに「数えられなかった」と名乗る行を出す: 0 で埋めると「全部片付いている」と読め、いちばん見落としたい向きへ倒れるため
      this.#notices.set(
        'situation',
        await this.#situationNoticeFor(batch).catch((error: unknown) => {
          noteDroppedRecord('いまの全体の組み立て', inboxEventShape(event), error);
          return describeSituationUnavailable(error);
        }),
      );
      // 倒れ先は空文字ではなく `describeSuperseded` の `uncountable` の文: 「数えられなかった」を 0 件と混同しないため
      const validityNotice = await this.#validityNoticeFor(batch);
      this.#notices.set('validity', validityNotice);
      if (validityNotice !== '' && event.type === 'manager_message') {
        await this.#noteRedeliveryPredicateHitB(event.managerId);
      }
      this.#notices.set(
        'superseded',
        await this.#supersededNoticeFor(batch).catch((error: unknown) => {
          noteDroppedRecord('後続の報告の組み立て', inboxEventShape(event), error);
          return event.type === 'manager_message'
            ? describeSuperseded({ kind: 'uncountable', detail: reasonOf(error) }, event.managerId)
            : '';
        }),
      );
      try {
        if (mergedHuman !== null) await this.#runHumanTurn(mergedHuman);
        else if (mergedReports !== null) await this.#runManagerReportBatch(mergedReports);
        else if (mergedExternal !== null) await this.#runExternalBatch(mergedExternal);
        else await this.#handle(event);
      } catch (error) {
        await this.#reportFailure(this.#conversationOf(event), { error });
        this.#finishTurn();
      } finally {
        this.#notices.clearTurn();
        // まとめて読んだ分は1件も飛ばさずここを通す: 通し忘れた合図は器に未読のまま残り、起動のたびに永久に配り直されるため。`#usageBlocked` の判定は先に1度だけ取る: 件ごとに読み直すと同じ1ターンの分が半分は消えて半分は保持される形が残るため
        const defer = this.#usageBlocked !== null;
        for (const held of batch) {
          // 保持した `human_answer` は「処理済み」の印を外す: 枠で失敗した回答はまだ処理されておらず、残すと解除後の再配達が「二重配達」と畳まれて回答が黙って失われるため
          if (defer && held.type === 'human_answer') this.#handledHumanAnswerIds.delete(held.id);
          await this.#settleInboxEvent(held, defer);
        }
      }
    }
    this.#delivery.settleAllCompletions();
  }

  // 報告（`report`）をこの関数でまとめない: 対象・宛先の決め方・組み立てる本文が違うので `#mergedManagerReportBatch` に分けてある。会話が違う発言と枠で保持した合図はまとめない: 応答の宛先が1つに決まらず、束ねると再試行1回が何件ぶんの仕事かが変わるため
  #mergedHumanBatch(event: InboxEvent): HumanMessage[] | null {
    if (event.type !== 'human_message') return null;
    if (!this.#mergeable(event)) return null;

    // 先頭から連続している分だけ集める: 間に別の起点が挟まっているのを飛び越えると、並んでいる順に読むという約束が崩れるため
    const rest = this.#drainMergeableWithinLimit(
      (queued) => queued.type === 'human_message' && queued.conversationId === event.conversationId,
    );
    // 1件だけなら `null` を返す: まとめる側へ寄せると、いちばん多い「1件だけ」の本文に断り書きが載る形になるため
    if (rest.length === 0) return null;
    return [event, ...rest.filter(isHumanMessage)];
  }

  // `question` / `permission` はまとめない: 返事を待つ相手（`requestId`）が1件ごとに違いうるため。同じ `managerId` に限る: 複数のマネージャーを混ぜると「誰からの何件か」が言えなくなるため
  #mergedManagerReportBatch(event: InboxEvent): ManagerReportMessage[] | null {
    if (!isManagerReport(event)) return null;
    if (!this.#mergeable(event)) return null;

    const rest = this.#drainMergeableWithinLimit(
      (queued) => isManagerReport(queued) && queued.managerId === event.managerId,
    );
    if (rest.length === 0) return null;
    return [event, ...rest.filter(isManagerReport)];
  }

  // `source` だけでなく `payload` まで一致を条件にする: 中身の違う合図まで混ぜると、重要な1件が同じ出所の重複の中に埋もれるため
  // 「中身が同じか」は `inboxBacklogDedupeKey` を再利用して独自の比較を書かない: 畳み込みの鍵が2つに割れるため
  // 鍵が作れない場合は束ねない: `JSON.stringify` が投げうり、この関数は `#pump` の `try` の外で呼ばれるので、投げると受信箱のループが死ぬため
  #mergedExternalBatch(event: InboxEvent): ExternalEvent[] | null {
    if (event.type !== 'external') return null;
    if (!this.#mergeable(event)) return null;

    const key = this.#externalMergeKey(event);
    if (key === null) return null;

    // `queued.type === 'external'` は鍵と重複するが残す: TypeScript は文字列の一致から型を絞れないため
    const rest = this.#drainMergeableWithinLimit(
      (queued) => queued.type === 'external' && this.#externalMergeKey(queued) === key,
    );
    if (rest.length === 0) return null;
    return [event, ...rest.filter(isExternalEvent)];
  }

  // 跡に本文は残さない: `noteDroppedRecord` の「本文を出さない」約束を守るため
  #externalMergeKey(event: InboxEvent): string | null {
    try {
      return inboxBacklogDedupeKey(event);
    } catch (error) {
      noteDroppedRecord('external の束ね鍵の計算', inboxEventShape(event), error);
      return null;
    }
  }

  // `1` から数え始める: 呼び出し元が `event` 自身を先頭に足すので、`taken` を `0` から始めると上限より1件多く束ねるため
  // 「本当に届いた件数」とは名乗らない: 処理済みの分は待ち行列に残っておらず測りようがなく、言えるのは待ち行列の先頭に残っている件数だけのため
  #drainMergeableWithinLimit(predicate: (queued: InboxEvent) => boolean): InboxEvent[] {
    const limit = this.#mergedBatchLimit;
    let taken = 1;
    const matchesRule = (queued: InboxEvent): boolean =>
      predicate(queued) && this.#mergeable(queued);
    const rest = this.#delivery.inbox.drainWhile((queued) => {
      if (taken >= limit) return false;
      const matches = matchesRule(queued);
      if (matches) taken += 1;
      return matches;
    });
    // `rest.length === 0` でも計算する: `limit === 1` だと `rest` は必ず空になるが、待ち行列の先頭に同じ束に入るはずだった合図は残りうるため
    const remainingHead = this.#delivery.inbox.countWhile(matchesRule);
    if (remainingHead > 0) {
      this.#notices.set(
        'mergedBatchTruncation',
        this.#mergedBatchTruncationNoticeFor({
          limit,
          batchSize: taken,
          remainingHead,
        }),
      );
    }
    return rest;
  }

  // いつ数えた値かを名乗る: この節は `#pushInput` で会話履歴に溜まり、時刻が無いと後から読み返す側が「あと何件残っている」をどのターンのものか判定できないため
  #mergedBatchTruncationNoticeFor(truncation: {
    readonly limit: number;
    readonly batchSize: number;
    readonly remainingHead: number;
  }): string {
    const { limit, batchSize, remainingHead } = truncation;
    return [
      `[system] **このターンへ束ねる合図は、上限（${String(limit)} 件）で切った束である` +
        `（この束は ${String(batchSize)} 件。${readAtLabel(Date.now())} 時点）。**` +
        `同じ束に入るはずの合図が、待ち行列の先頭にあと ${String(remainingHead)} 件連続して残っている。`,
      '**1件も失われていない** —— 上限で止めただけで、外れた分は次のターンで同じ形でまた束ね直される。',
      '',
      '---',
      '',
    ].join('\n');
  }

  // `#heldForUsage` は外したままにする: 再試行は「新しい合図1件につき高々1回」で、束ねるとその1回が何件ぶんの仕事かが変わるため
  #mergeable(event: InboxEvent): boolean {
    return !this.#heldForUsage.has(event.id);
  }

  // 1件でも複数件でも同じ道を通す: 分けて書くと、片方にだけ `#recorded` の待ちが入る・会話 id の取り方が違うといった食い違いが静かに入るため
  async #runHumanTurn(events: HumanMessage[]): Promise<void> {
    // ここでは書かない: 発言は受理した瞬間に `#record` が書いており、両方で書くと同じ発言が日誌に二度載るため
    // まとめた分は全部待つ: 1件でも飛ばすと、その発言だけが日誌で自分への応答より後ろに回りうるため。書けたかどうかを条件にしない: 記録できないことより応答が返らないことの方が高くつくため
    for (const event of events) await this.#delivery.getRecorded(event.id);

    const head = events[0];
    if (head === undefined) return;
    const priorTexts = await this.#resolvePriorTexts(events);
    // 添付の中身は受信箱・日誌・記憶へ写さない。画像の予算は新しい発言から使う
    const images: AgentInputImage[] = [];
    const notices = new Map<string, string>();
    const withAttachments = events.filter(
      (event) => event.attachments !== undefined && event.attachments.length > 0,
    );
    const resolvedGroups = await resolveTurnAttachmentGroups(
      this.#stores,
      withAttachments.map((event) => event.attachments ?? []),
    );
    withAttachments.forEach((event, index) => {
      const resolved = resolvedGroups[index];
      if (resolved === undefined) return;
      images.push(...resolved.images);
      notices.set(event.id, resolved.noticeLines.join('\n'));
    });
    await this.#runTurn(
      head.conversationId,
      humanTurnText(events, priorTexts, notices),
      'normal',
      null,
      images,
    );
  }

  // 本文を読むだけにする: 編集前のターンが開いた承認待ち・起こしたマネージャー・書いた記憶・台帳の行には触れず、「編集されたから取り消す」ロジックは作らないため。引けなくても落ちない
  async #resolvePriorTexts(events: HumanMessage[]): Promise<Map<string, string>> {
    const priorTexts = new Map<string, string>();
    for (const event of events) {
      if (event.supersedes === undefined) continue;
      try {
        const entry = await this.#stores.journal.get(event.supersedes);
        if (entry !== null && entry.type === 'exchange' && entry.with === 'human') {
          priorTexts.set(event.id, entry.text);
        }
      } catch {
      }
    }
    return priorTexts;
  }

  // `#handle` の `manager_message`/`report` 分岐がしていることを件数ぶん繰り返す: 落とすと、まとめた側だけ日誌への追記や台帳の判定（#391）が抜けて能力の削除になるため
  async #runManagerReportBatch(events: ManagerReportMessage[]): Promise<void> {
    const settlements: ReportSettlement[] = [];
    for (const event of events) {
      // 日誌への追記は件数ぶん個別に書く: 1回にまとめると、合図は件数ぶん器に残るという前提が日誌の側で破れるため
      await this.#journalIncomingBody(event);
      // 台帳の判定（#391）も件数ぶん引く: 「どの報告が片付け済みか」は1件ごとに違いうるので、1つの判定へ潰さない
      const settlement = await reportSettlement(this.#stores.commitments, event.id);
      settlements.push(settlement);
      if (closedReportNotice(settlement) !== null) {
        await this.#noteRedeliveryPredicateHitA(event.managerId);
      }
    }

    // `now` はここで1度だけ取る: `managerReportBatchPrompt` を純関数のまま保つため
    await this.#runInternal(managerReportBatchPrompt(events, settlements, new Date()));
  }

  // `#handle` の `'external'` 分岐がしていることを件数ぶん繰り返す: 落とすと、まとめた側だけ日誌への追記が抜けて能力の削除になるため
  async #runExternalBatch(events: ExternalEvent[]): Promise<void> {
    for (const event of events) {
      // 日誌への追記は件数ぶん個別に書く: 1回にまとめると、合図は件数ぶん器に残るという前提が日誌の側で破れるため
      await this.#journalIncomingBody(event);
    }

    const attached = await this.#resolveExternalAttachments(events);
    await this.#runInternal(
      externalBatchPrompt(events, attached.noticeLines),
      'normal',
      attached.images,
    );
  }

  // 2箇所の呼び出しを1本にまとめる: 別々に書くと、台帳の控えを外し忘れる・待っている相手を起こし忘れるといった漏れが片方にだけ起きるため
  // `defer` が真なら `#forget` を呼ばず器にも未読のまま残す: 枠は時間で解決する失敗で、消すと開いたときに合図が無く仕事が失われるため
  async #settleInboxEvent(event: InboxEvent, defer: boolean): Promise<void> {
    // 台帳の行は消さない: 消すのは「もう順序を待つ相手が居ない」という印だけで、閉じられていない未了は残すため
    this.#delivery.deleteCommitted(event.id);
    // 追記の控えはここで捨てる: `#handle` の中で消すと、例外で終わった経路のぶんが残り続けるため
    this.#delivery.deleteRecorded(event.id);

    if (defer && this.#foldsIntoHeldTick(event)) {
      // 中身を持たない合図で在庫を作らない: `post` は待ち行列しか見ず、枠で保持した分（`#deferred`）は見ないので、合図が溜まる枠が閉じている間だけ畳み込みの規則が効かなくなるため
      // `post` 側では畳まない: `post` で return すると受信箱へ何も積まれず `#pump` が印を見に来ないので、枠が開いたかを試す唯一の定期的な契機である tick の再試行が静かに止まるため
      // 畳むのはいま届いた新しい方だけ: 先に保持している同じ tick は動かさない
      await this.#noteFoldedTick(event);
      // 器の未読からも外す: 残すとこの1件だけが起動のたびに配り直されてクローンのターンを焼くため
      this.#heldForUsage.delete(event.id);
      await this.#forget(event);
    } else if (defer && this.#isSupersededTokenPoolNotice(event)) {
      // 代表でなくなった token-pool 通知は延期の列へ積まずに畳む: 積むと新旧2件が並び、解除で古い方が先に配られるため
      const current = this.#delivery.pendingTokenPoolNotice;
      if (current !== null) {
        const folded = current.folded + 1;
        this.#delivery.setPendingTokenPoolNotice({ ...current, folded });
        await this.#journalSupersededTokenPoolNotice(event, null, folded);
      }
      this.#heldForUsage.delete(event.id);
      await this.#forget(event);
    } else if (defer) {
      this.#delivery.pushDeferred(event);
      // 保持したことを覚えておく: 保持している間に印を消すと、解除で戻ってきた合図が「初めて届いたもの」に見えてまとめ読みの対象へ戻るため
      this.#heldForUsage.add(event.id);
    } else {
      // 取り出した時点でなく終えた時点で消す: 取り出した時点だと、処理の途中でプロセスが死んだものが失われるため
      // 例外で終わったものも消す: 失敗は `#reportFailure` に記録済みで、残すと決定的に失敗する合図が起動のたびに配り直されてターンを1本ずつ焼くため（残るのはプロセスが死んだときと枠で保持したときだけ）
      this.#heldForUsage.delete(event.id);
      await this.#forget(event);
    }
    this.#delivery.takeCompletion(event.id)?.();
  }

  // 文言では判定しない: `isSameTick`（型と構造化フィールドだけ）に委ね、本文の一致は見ない
  #foldsIntoHeldTick(event: InboxEvent): boolean {
    return isTick(event) && this.#delivery.someDeferred((held) => isSameTick(held, event));
  }

  // 代表が `null` のときは偽: 比較する相手が居ないので延期の列へ積み、何も失わない側へ倒すため
  #isSupersededTokenPoolNotice(event: InboxEvent): boolean {
    if (event.type !== 'external' || event.source !== DAEMON_TOKEN_POOL_REOPENED_SOURCE) {
      return false;
    }
    const current = this.#delivery.pendingTokenPoolNotice;
    return current !== null && current.id !== event.id;
  }

  // 畳んだ跡を日誌に残す: 畳み込みは器にも台帳にも何も残さず、書かないと「静かに消えた」と区別が付かず、判定が間違っていても永久に見えないため
  async #noteFoldedTick(event: InboxEvent): Promise<void> {
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_THINNING_PREFIX}枠で保持している同じ合図（${event.type}）が既にあるので、新しく届いた分を畳んだ。` +
        `中身は処理の瞬間に組み立て直すので、読まれる前の重複には情報が無い（保持中の同種: ` +
        `${this.#delivery.matchingDeferredCount((held) => isSameTick(held, event))} 件）。`,
    });
  }

  // 消えてよいのはクローンを起こすことだけで、記録は消さない: 型ごとの本文追記と「畳んだ」の1行を書く（配り直した行と対で残り、「畳んだ」と「そもそも配られなかった」を区別できる）。断り書きは全文で写す: どこにも保存されず、写さないと畳んだ根拠が永久に取れないため
  async #foldClosedRedelivery(event: InboxEvent, notice: string): Promise<void> {
    await this.#journalIncomingBody(event);
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_THINNING_PREFIX}片付け済みの配り直しなので、ターンを起こさずに畳んだ（モデルへは1文字も渡して` +
        `いない）: ${inboxEventShape(event)}\n\n${notice}`,
    });
  }

  // `#pushInput` には触れない: この行はモデルには一度も見えないため。述語はここで確かめ直さず、呼び出し元が「配った回」だけを選ぶ
  async #noteRedeliveryPredicateHitA(managerId: string): Promise<void> {
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_GAUGE_PREFIX}${REDELIVERY_COUNT_PREFIX_A}台帳で既に片付けている報告に断り書きを付けて配った` +
        `（managerId=${managerId}）。`,
    });
  }

  async #noteRedeliveryPredicateHitB(managerId: string): Promise<void> {
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_GAUGE_PREFIX}${REDELIVERY_COUNT_PREFIX_B}名乗った前提が動いている報告のままターンを起こした` +
        `（managerId=${managerId}）。`,
    });
  }

  // 消し込みは呼び手が行い、ここは跡を書くだけにする: 跡が書けなかったときに消し込みまで道連れにしないため。型ごとの本文追記を飛ばさない: 消した合図の中身が日誌のどこにも残らなくなるため
  async #dropStaleRedelivery(
    record: PendingInboxEvent,
    context: { readonly alone: boolean; readonly completedRound?: boolean },
  ): Promise<void> {
    await this.#journalIncomingBody(record.event);
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_THINNING_PREFIX}未読のまま残っていた合図を配り直したが（${record.deliveries}回目の配達` +
        (context.alone
          ? ''
          : `＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が ${this.#restoredCohort} 件あり、` +
            `配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない`) +
        `、${record.at} に受け取ったもの）、` +
        (context.completedRound === true
          ? `その回は既に完了していた（定期の依頼の \`lastScheduledRunAt\` 以前）ので` +
            `ターンを起こさずに消した（モデルへは1文字も渡していない。本文は` +
            `直前の行に残してある。完了した回を二度走らせないための畳みで、まだ走っていない回は畳まない）: `
          : `もう効く先の無い種類だったので` +
            `ターンを起こさずに消した（モデルへは1文字も渡していない。本文は` +
            `直前の行に残してある。まだ要る状況なら、この種類の合図は作り直される）: `) +
        `${inboxEventShape(record.event)}`,
    });
  }

  // `inbox.removeMany` を直に呼ばず `removeInboxEventsAndStopDelivery` を通す: 将来この経路の手前へ配達される変更が入っても、消した合図がメモリ側に残る穴（#1049）が空かないようにするため
  // 失敗した塊は丸ごと次の起動へ回す: 「消えるより配り直す」を崩さないため
  // `#forget` の `await written` をここに置かない: この経路の record は `Promise.resolve()` を積んだものだけ（`this.#delivery.setUnread(record.event.id, Promise.resolve())`）で、待つべき書き込みが無いため。本物の Promise を積むよう変えるなら `await` が要る
  // メモリ上の後始末は1件ずつ行い、`settled` も1件ずつ数える: まとめるのはストアへの書き込みだけで、数える場所を増やさないため
  async #removeStaleRedeliveryChunk(chunk: readonly PendingInboxEvent[]): Promise<void> {
    if (chunk.length === 0) return;
    const ids = chunk.map((record) => record.event.id);

    let last: unknown;
    for (let attempt = 0; attempt < FORGET_RETRY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, FORGET_RETRY_MS * attempt));
      }
      try {
        await removeInboxEventsAndStopDelivery(
          this.#stores.inbox,
          { dropQueuedInboxEvents: (removedIds) => this.dropQueuedInboxEvents(removedIds) },
          ids,
        );
        for (const record of chunk) {
          this.#delivery.deleteUnread(record.event.id);
          this.#delivery.redeliveryState.drop(record.event.id);
          this.#dropPendingCollapse(record.event);
          // token-pool の代表もここで落とす: この経路は `#forget` を通らず、落とし忘れると消えた stale な id を代表として指したまま残り、次の通知の合流判定が偽の前提で走るため
          this.#delivery.clearPendingTokenPoolNoticeIfMatches(record.event.id);
          this.#inboxFlow.settled(record.event.type);
        }
        return;
      } catch (error) {
        last = error;
      }
    }
    // 印も残したまま跡だけ残して進む: 印を消すと「もう消せている」と嘘をつくことになるため
    noteDroppedRecord('未読の消し込み（一括）', `${chunk.length} 件: ${ids.join(', ')}`, last);
  }

  // `#forget` は呼ばない: この畳み込みは「いまは配る意味が無い」という一時的な判定なので、行を残して次の起動で判定し直すため
  // 「畳んだ」の1行は record ごとに書かない: 未読を N 件拾い直して M 件が畳まれると M 行が1秒未満に並ぶので、`sink` へ積んで1パス1本へ畳む（本文追記は record ごとに即座に書く）
  async #foldGatedRedelivery(record: PendingInboxEvent, sink: PendingInboxEvent[]): Promise<void> {
    await this.#journalIncomingBody(record.event);
    sink.push(record);
  }

  // 各件の合図の形は最大値・最古の時刻へ要約せず1件も欠かさず列挙する: 人間が後から読み返す日誌のため。時間の窓や件数の上限は持ち込まない。1件のときの文言は変えない: `inbox-persistence.test.ts` が逐語で見るため
  #gatedRedeliveryFoldHeadline(records: readonly PendingInboxEvent[]): string {
    if (records.length === 1) {
      const record = records[0];
      if (record === undefined) return '';
      return (
        `配り直しの門がいま配る意味は無いと答えたので、ターンを起こさずに畳んだ` +
        `（モデルへは1文字も渡していない。合図も台帳の行も消していない——次の起動で` +
        `また拾い直され、そのときの状態であらためて判定される）: ${inboxEventShape(record.event)}`
      );
    }

    const details = records
      .map((record, index) => `[${index + 1}] ${inboxEventShape(record.event)}`)
      .join('\n');
    return (
      `配り直しの門がいま配る意味は無いと答えたので、まとめて${records.length}件、ターンを` +
      `起こさずに畳んだ（モデルへは1文字も渡していない。合図も台帳の行も消していない——` +
      `次の起動でまた拾い直され、そのときの状態であらためて判定される）:\n${details}`
    );
  }

  // 配達のたびに書く: 配り直しの回でも畳んでターンを起こさない回でも同じものを書く。1本にまとめる: 別々に書くと、`retrievalHintFor` が案内する「処理されるたびに全文が日誌へ書かれる」約束がどれか1つの経路でだけ静かに破れ、気づく手掛かりが残らないため
  // 書くのは `manager_message` と `external` だけ: 人間の発言は `#record` が書き（両方で書くと二度載る）、`human_answer` の全文は承認待ちの器が持つため
  async #journalIncomingBody(event: InboxEvent): Promise<void> {
    if (event.type === 'manager_message') {
      await this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'inbound',
        managerId: event.managerId,
        text: `${EXCHANGE_KIND_REPLY_PREFIX}[${event.managerId}/${event.kind}] ${event.text}`,
      });
      return;
    }
    if (event.type === 'external') {
      await this.#journal({
        type: 'external_event',
        source: event.source,
        summary: journalPayload(event.payload),
        ...(event.via === undefined ? {} : { via: event.via }),
        ...(event.attachments === undefined || event.attachments.length === 0
          ? {}
          : { attachments: event.attachments.map((ref) => ({ ...ref })) }),
      });
    }
  }

  // 束ねた合図すべての添付を集める: 添付の違う合図は通常は束ならないが、ここでも黙って落とさないため
  async #resolveExternalAttachments(
    events: readonly ExternalEvent[],
  ): Promise<{ images: AgentInputImage[]; noticeLines: string[] }> {
    const seen = new Set<string>();
    const groups: AttachmentRef[][] = [];
    for (const event of events) {
      const refs: AttachmentRef[] = [];
      for (const ref of event.attachments ?? []) {
        if (seen.has(ref.id)) continue;
        seen.add(ref.id);
        refs.push(ref);
      }
      if (refs.length > 0) groups.push(refs);
    }
    if (groups.length === 0) return { images: [], noticeLines: [] };
    const resolved = await resolveTurnAttachmentGroups(this.#stores, groups);
    return {
      images: resolved.flatMap((group) => group.images),
      noticeLines: resolved.flatMap((group) => group.noticeLines),
    };
  }

  #conversationOf(event: InboxEvent): string | null {
    if (event.type === 'human_message') return event.conversationId;
    if (event.type === 'human_answer') return event.conversationId ?? null;
    return null;
  }

  // `external` は行だけ畳み待ち行列からは抜かない: 抜くと #841 の束ね読み（件数と全件の届いた時刻）が起きなくなり、片方へ寄せるともう片方の保証が黙って落ちるため。`canQueue` が偽の呼び出しは任せる先のターンが起きないので `folded` と同じ扱いにする
  // `#record` では代われない: `human_message` にしか効かず、`manager_message` / `external` を畳んだ回の本文は `#journalIncomingBody` で残すため
  // 索引の照会と書き込みを同じ刻みの中に置く: `post()` は同期なので、台帳側で #1041 が挙げるような `list()` と `open()` の間の TOCTOU が生まれないため
  #foldIntoPendingCollapse(
    event: InboxEvent,
    options: { readonly canQueue: boolean },
  ): PendingCollapseVerdict {
    const key = inboxCollapseKey(event);
    if (key === undefined) return 'pass';

    const existing = this.#delivery.getCollapseEntry(key);
    if (existing === undefined) {
      this.#delivery.registerCollapseRepresentative(key, event.id, event.at);
      return 'pass';
    }

    existing.collapsed += 1;

    // 待ち行列へ入れる `external` では `#journalIncomingBody` を呼ばない: #841 の束ね読みが本文を書くので、呼ぶと同じ本文が日誌に二重に載るため（跡は「行を畳んだ」の1行だけ）
    if (options.canQueue && event.type === 'external') {
      void this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_THINNING_PREFIX}alteroid 自身が合成した同一本文の未読が既に受信箱にあるので、受信箱の行は増やさずに` +
          `畳んだ（本文と届いた時刻はこのあと束ね読み（#841）が1ターンの中で渡す）: ` +
          `${inboxEventShape(event)}`,
      });
      return 'row-folded';
    }

    // 待たない: `post` を待たせないため
    void this.#journalIncomingBody(event);
    void this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_THINNING_PREFIX}alteroid 自身が合成した同一本文の未読が既に受信箱にあるので、受信箱にも台帳にも` +
        `積まずに畳んだ（モデルへは1文字も渡していない。本文は直前の行に残してある）: ` +
        `${inboxEventShape(event)}`,
    });
    return 'folded';
  }

  // 代表の合図が実際に片付いて `#stores.inbox.remove` が確定したときだけ鍵を落とす（`this.#stores.inbox.remove(` を呼ぶのは `#forget` の1箇所だけなので、落とす場所もそこに閉じる）: 早く落とすと次の同文が新しい代表として積まれて畳み込みが二重になり、遅いと片付いた合図の影が残って次の同じ内容の合図が二度と積まれなくなるため
  // `existing.id === event.id` で確かめる: 他の代表の索引を誤って落とさないための防御
  // 要約は件数だけを1行書く: 生の本文は畳んだ回ごとに `#foldIntoPendingCollapse` が残しているため
  #dropPendingCollapse(event: InboxEvent): void {
    const key = inboxCollapseKey(event);
    if (key === undefined) return;

    const existing = this.#delivery.dropCollapseEntryIfMatches(key, event.id);
    if (existing === undefined) return;

    if (existing.collapsed > 0) {
      void this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_THINNING_PREFIX}alteroid 自身が合成した同一本文の未読を ${existing.collapsed} 件、受信箱にも台帳にも` +
          `積まずに畳んだ（本文はそれぞれ畳んだ時点で直前の行に残してある。この合図が` +
          `片付いたので数え終える）: ${inboxEventShape(event)}`,
      });
    }
  }

  // 中身の同一判定は `#externalMergeKey` を再利用して独自の比較を書かない: 同じ判定を2箇所に書かないため
  // 鍵が作れない event は合流の対象外にして素通しする: `event.id` を鍵の代わりにすると、鍵が作れない event が届くたびに既存の代表を巻き添えで外して畳んでしまうため
  #foldPendingTokenPoolNotice(event: InboxEvent): void {
    const key = this.#externalMergeKey(event);
    if (key === null) return;

    const current = this.#delivery.pendingTokenPoolNotice;

    if (current === null) {
      this.#delivery.setPendingTokenPoolNotice({ id: event.id, at: event.at, key, folded: 0 });
      return;
    }

    if (current.key === key) {
      return;
    }

    const evicted = this.#evictPendingTokenPoolRepresentative(current.id);
    const folded = current.folded + (evicted !== null ? 1 : 0);
    if (evicted !== null) {
      void this.#journalSupersededTokenPoolNotice(evicted, event, folded);
    }
    // 見つからなかった場合も代表はこの event へ差し替える: 既に処理中か片付いたかで、この event が自分自身の新しい代表として振る舞うため
    this.#delivery.setPendingTokenPoolNotice({ id: event.id, at: event.at, key, folded });
  }

  // 新しい消し方を作らず `#forget` に委ねる: 器の未読・`#pendingCollapse`・`inbox_flow` を正しく後始末するので、二重に書かないため（`#heldForUsage` だけは `#deferred` 側固有なのでここで落とす）。待たない: `post()` は同期のため
  #evictPendingTokenPoolRepresentative(id: string): InboxEvent | null {
    const fromQueue = this.#delivery.inbox.removeWhere((queued) => queued.id === id);
    const victim = fromQueue[0];
    if (victim !== undefined) {
      void this.#forget(victim);
      return victim;
    }

    const held = this.#delivery.removeDeferredById(id);
    if (held === undefined) return null;
    this.#heldForUsage.delete(id);
    void this.#forget(held);
    return held;
  }

  // 本文は先に書く: `#forget` が消すのは器の未読だけで、本文はどこにも保存されておらず、書かないと「何が畳まれたか」が永久に読めなくなるため
  async #journalSupersededTokenPoolNotice(
    old: InboxEvent,
    next: InboxEvent | null,
    folded: number,
  ): Promise<void> {
    await this.#journalIncomingBody(old);
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        (next === null
          ? `${EXCHANGE_KIND_THINNING_PREFIX}token-pool の「戻った」通知（本文は直前の行）は、処理中に内容の違う同種の通知が届いて` +
            `代表が差し替わった後に枠で失敗して戻ってきたので、延期の列へは積まずに畳んだ（モデルへ渡るのは新しい代表だけ。`
          : `${EXCHANGE_KIND_THINNING_PREFIX}token-pool の「戻った」通知（本文は直前の行）がまだ未処理のまま残っていたところへ、` +
            `内容の違う同種の通知が届いたので、古い方は配らずに畳み、新しい方（` +
            `${inboxEventShape(next)}）を代表にした（モデルへ渡るのは新しい方だけ。`) +
        `合流はここまでで累計 ${folded} 件——時間の窓ではなく「未処理のまま残っているか」だけで判定している）。`,
    });
  }

  // 失敗しても post を落とさない: 未読を書けないことでその合図の処理まで止めると、直そうとしているものより広い穴になるため
  // 跡に本文を出さない: 合図には人間の発言・webhook の本文が入り、テスト出力に `GH_TOKEN` が全文で出た前例があるため
  // `arrived` は書き込みの成否を問わず入口で数える: `inbox_flow.arrived` は受理した瞬間であって書けた時刻ではないため
  #remember(event: InboxEvent, options: { readonly canQueue: boolean }): void {
    this.#inboxFlow.arrived(event.type);
    this.#delivery.setUnread(event.id, this.#persistUnread(event, options));
  }

  // 尽きても reject しない。`#forget` が `await written` で待つので、reject すると書けなかった合図の消し込みまで例外で止まるため
  async #persistUnread(event: InboxEvent, options: { readonly canQueue: boolean }): Promise<void> {
    const failure = await this.#tryPersistUnread(event);
    if (failure === null) return;
    if (options.canQueue) {
      noteInboxEventKeptInMemoryOnly(inboxEventShape(event), failure.error);
    } else {
      noteInboxEventLost(inboxEventShape(event), failure.error);
    }
  }

  async #tryPersistUnread(event: InboxEvent): Promise<{ readonly error: unknown } | null> {
    let last: unknown;
    for (let attempt = 0; attempt < REMEMBER_RETRY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, REMEMBER_RETRY_MS * attempt));
      }
      try {
        await this.#stores.inbox.put(event, event.at);
        return null;
      } catch (error) {
        last = error;
      }
    }
    return { error: last };
  }

  // 記録をターンの直列の後ろに置かない: 先客が走っているあいだ日誌にその発言が存在せず、`GET /conversations` にも出ないので、器を替えた人からは発言そのものが消えて見えるため
  // 記録が先、通知は後: 日誌へ載れば `GET /journal/stream` にもそのまま流れ、この1か所で送った本人以外の観測者が同時に埋まるため。人間の発言だけを見る: 他の6種は起点ごとに違う型で「何をしたか」を残しており、寄せると意味の違う2つを1つの型に潰すため
  #record(event: InboxEvent): void {
    if (event.type !== 'human_message') return;

    // `supersedes` はそのまま日誌へ通すだけにする: 畳み込みの解釈は `computeSupersededIds` の射影が持ち、記録の時点で何かを取り消さないため
    // 列は失敗で切らない: 1本書けなかったことで以後の発言の記録まで止めないため
    this.#delivery.chainRecord(event.id, () =>
      this.#journal({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: event.text,
        conversationId: event.conversationId,
        ...(event.supersedes === undefined ? {} : { supersedes: event.supersedes }),
        ...(event.clientMessageId === undefined ? {} : { clientMessageId: event.clientMessageId }),
        ...(event.attachments === undefined || event.attachments.length === 0
          ? {}
          : {
              attachments: event.attachments.map((ref) => ({
                id: ref.id,
                name: stripNul(ref.name),
                mediaType: ref.mediaType,
                size: ref.size,
                sha256: ref.sha256,
              })),
            }),
      }),
    );

    this.#emit(event.conversationId, { type: 'queued' });
  }

  // 合図の id をそのまま未了の id にする: 配り直しでも同じ id になり、`CommitmentStore.open` の冪等性が「二度開かない・閉じたものを開き直さない」になるため
  // `timer` と `self_initiative` では開かない: 起こされたこと自体で、開くと発意 tick のたびに未了が1件増えて台帳が数時間で読めなくなるため。`external` でもデーモン自身の合図（`isDaemonSelfNotice`）では開かない
  // 読んでから書く形へ戻さない: 重複判定は `CommitmentStore.open` の中で行う。アプリ層の排他はプロセスを跨げず、同じストアを指す2つのデーモンが両方「重複なし」と読んで台帳が2行に割れるため
  // 失敗しても post を落とさない
  // 種別は `decision` にしない: 器が受信箱の合図から機械的に開いた行を混ぜると、クローンが自分で決めて引き受けた判断という面の意味が変わるため
  // 記録を名乗りより先に済ませる（この `.then()` チェーンの中で行う）: `#commitmentNoticeFor` がこの鎖を `await` してから再読するので、追記を待たずに `'opened'` を先に確定させるとその保証が消えるため
  // `#journal` を経由せず直接 append する: 通常の `#journal` だと失敗が stderr に沈んで「記録が無い」と「名乗っていない」を区別できず、日誌の失敗から日誌へ書き直す循環も作るため。失敗したら `'unrecorded'` を返す
  #commit(event: InboxEvent): void {
    const entry = commitmentFor(event);
    if (entry === null) return;
    this.#delivery.setCommitted(
      event.id,
      this.#stores.commitments.open(entry).then(
        async (result): Promise<CommitOutcome> => {
          if (!result.opened) return result.folded ? 'folded' : 'existed';
          try {
            await this.#stores.journal.append({
              type: 'exchange',
              with: 'self',
              role: 'outbound',
              text:
                `${EXCHANGE_KIND_DECISION_PREFIX}受信箱の合図から、引き受けた仕事として台帳に開いた（id: ${event.id}）。` +
                `合図: ${inboxEventShape(event)}`,
            });
          } catch (error) {
            // ここから `#journal` を呼び直さない: 日誌の失敗から日誌へ書き直す循環になるため
            noteDroppedRecord(
              '機械が名乗った id の記帳（#commit 成功時）',
              inboxEventShape(event),
              error,
            );
            return 'unrecorded';
          }
          return 'opened';
        },
        (error: unknown): Promise<CommitOutcome> => {
          noteDroppedRecord('未了の記帳', inboxEventShape(event), error);
          // stderr の跡はクローンが読めないので、日誌へも1件残す
          return this.#journal({
            type: 'exchange',
            with: 'self',
            role: 'outbound',
            text:
              `${EXCHANGE_KIND_FAILURE_PREFIX}未了の記帳に失敗した（id: ${event.id}）。台帳に載っていない可能性が` +
              'あるので、必要なら `commitment_open` で載せ直すこと' +
              `（理由: ${reasonOf(error)}）。`,
          }).then((): CommitOutcome => 'failed');
        },
      ),
    );
  }

  // 器は起点の中身を読んで順番を付けない: 付けた瞬間に「何を先にやるか」の判断が器へ移るため（人間が待っている合図だけを前へ出す）。一覧そのものは載せない: 件数に比例して伸びるものを毎ターン積むと、溜まっているときほどターンが重くなるため
  // 読めなくてもターンは進めるが、黙って消さない: 空文字を返すと「台帳が読めなかった回」と「異常が1件も無かった回」が同じ無言になるため。読めなかったこと自体を名乗り、再読を要しない `unrecorded` の断りは生き残らせる
  // 見出しは「いつ数えた値か」を名乗る: この節は会話履歴へ連結されてターンの数だけ並び、時刻が無いと古い節と新しい節が見分けられないため
  async #commitmentNoticeFor(events: InboxEvent[]): Promise<string> {
    const event = events[0];
    if (event === undefined) return '';

    // 蒸留には載せない: 記憶へ移すためだけの内部ターンで、`stop()` 経由はこの直後にプロセスが消え、未了を渡すと畳んでいる最中に新しい仕事を始めさせるだけのため
    if (event.type === 'distill') return '';

    // まとめて読む分は全部待つ: 1件でも飛ばすと一覧に間に合わず、閉じ方（id）を渡せない未了が黙って混じるため
    const outcomes = new Map<string, CommitOutcome>();
    for (const pending of events) {
      const outcome = await this.#delivery.getCommitted(pending.id);
      if (outcome !== undefined) outcomes.set(pending.id, outcome);
    }

    // 読めない行は `unreadable` として別に断る: 件数だけを見て握り潰さないため
    // `includeClosed: true` で読む（件数・最古・文言は未了だけを選び直す）: `missing` 判定のためで、台帳を2回読み直すと「いつ数えた値か」（`at`）が2つに割れるため
    // `unrecorded` の断りは `missing` とは別に集める: 別の軸で、同じ id が両方に出ても片方がもう片方を隠す理由は無いため。台帳の再読より前に組む: 再読を要さず、再読の失敗で消える理由が無いため
    const unrecorded = events.filter((pending) => outcomes.get(pending.id) === 'unrecorded');
    const unrecordedIdList = excerptLine(
      unrecorded.map((pending) => `\`${pending.id}\``).join(', '),
      CLONE_ID_LIST_EXCERPT,
    );
    const unrecordedLines =
      unrecorded.length === 0
        ? []
        : [
            `**⚠️ この ${unrecorded.length} 件は台帳には開けたが、機械が名乗った記録を` +
              `日誌に残せなかった（id: ${unrecordedIdList}）。** 後から「機械がこの id を` +
              '名乗ったか」を突き合わせられない。',
          ];

    let list: CommitmentList;
    try {
      list = await this.#stores.commitments.list({ includeClosed: true });
    } catch (error) {
      noteDroppedRecord('未了の読み出し', inboxEventShape(event), error);
      // 件数は名乗らない: 0 件と書けば「全部片付いている」と読め、いちばん見落としたい向きへ倒れるため
      return [
        `[system] **台帳を読めなかった（${readAtLabel(Date.now())} に試みた材料。` +
          `理由: ${reasonOf(error)}）。** ⟹ **引き受けたまま終わっていない仕事が何件` +
          'あるかも、いま届いた分が台帳に載ったかどうかも、この回は判定できていない' +
          '——0 件だったのでも、異常が無かったのでもない。** 読み直す手は ' +
          '`commitment_list` である（同じ理由で失敗するなら、失敗として返る）。',
        ...unrecordedLines,
        '',
        '---',
        '',
      ].join('\n');
    }
    const open = list.entries.filter((entry) => entry.closedAt === undefined);
    // `list()` を読み終えた直後の値を使う: 後で計算すると、数えた対象とは無関係な遅延が乗るため
    const at = Date.now();

    // まとめた件数ぶん渡す: 1件しか渡さないと、残りは id を渡されないまま未了として溜まるため
    const ids = new Set(events.map((pending) => pending.id));
    const mine = open.filter((entry) => ids.has(entry.id));
    const idList = excerptLine(
      mine.map((entry) => `\`${entry.id}\``).join(', '),
      CLONE_ID_LIST_EXCERPT,
    );
    // `'folded'` と `'existed'` は「載っていない」から除く: 台帳には触っていない・もう手当て済みで、除かないと正常なターンにも毎回嘘の警告が出るため
    // 「見当たらない」は `mine`（未了だけ）でなく `list.entries`（閉じた行を含む全行）で判定する: `outcome` は `#commit` 時点のスナップショットで、他のターンで先に閉じられると `'opened'` のまま古びり、`mine` だと閉じた行が視野から消えて「載っていない」に誤って落ちるため
    // `list.unreadable` の id も足す: 行は実在するのに読めないだけで、「載せ直しが要る」と誤って断らないため（id が取れない分は従来どおり）
    const ledgerIds = new Set([
      ...list.entries.map((entry) => entry.id),
      ...list.unreadable.flatMap((entry) => (entry.id === undefined ? [] : [entry.id])),
    ]);
    const missing = events.filter((pending) => {
      const outcome = outcomes.get(pending.id);
      return (
        outcome !== undefined &&
        outcome !== 'folded' &&
        outcome !== 'existed' &&
        !ledgerIds.has(pending.id)
      );
    });
    // 断定できるときだけ「載せ直しが要る」と断定する: fs 実装は片付いた行を 500 件超で物理削除し、載せ直すと片付いた仕事をクローンが作り直すため。`event.at` が残存する片付き行の `closedAt` 最小値より新しくなければ trim と本物の欠落を区別できず、第3の状態へ回す（`trimmedClosed` が足される前の削除は救えない）
    // 時刻の比較は `localeCompare`: `trimClosed` 自身のソートと同じ前提のため
    let oldestRemainingClosedAt: string | undefined;
    for (const entry of list.entries) {
      if (entry.closedAt === undefined) continue;
      if (
        oldestRemainingClosedAt === undefined ||
        entry.closedAt.localeCompare(oldestRemainingClosedAt) < 0
      ) {
        oldestRemainingClosedAt = entry.closedAt;
      }
    }
    const explainableByTrim = (pending: InboxEvent): boolean =>
      list.trimmedClosed > 0 &&
      (oldestRemainingClosedAt === undefined ||
        pending.at.localeCompare(oldestRemainingClosedAt) <= 0);
    const missingConfirmed = missing.filter((pending) => !explainableByTrim(pending));
    const missingUnexplained = missing.filter((pending) => explainableByTrim(pending));
    const missingIdList = excerptLine(
      missingConfirmed.map((pending) => `\`${pending.id}\``).join(', '),
      CLONE_ID_LIST_EXCERPT,
    );
    const missingUnexplainedIdList = excerptLine(
      missingUnexplained.map((pending) => `\`${pending.id}\``).join(', '),
      CLONE_ID_LIST_EXCERPT,
    );
    const oldest = open[0];
    const lines = [
      `[system] 引き受けたまま終わっていない仕事は（${readAtLabel(at)} に数えた材料）` +
        `**${open.length} 件** ある` +
        (oldest === undefined ? '。' : `（いちばん古いものは ${oldest.at} に受け取ったもの）。`),
      ...(mine.length === 0
        ? []
        : [
            (mine.length === 1
              ? `いま届いたこの一件も台帳に載せた（id: ${idList}）。`
              : `いま届いたこの ${mine.length} 件も台帳に載せた（id: ${idList}）。` +
                '**まとめて1つの応答で答えても、閉じるのは id ごとである。**') +
              '**片付いたら `commitment_close` で閉じること** — 返事をしただけでは閉じない。' +
              '雑談や、その場で答えて終わる話なら、答えたうえですぐ閉じてよい。',
          ]),
      // 分母は `events.length` でなく `outcomes.size`: `events` には台帳と無関係な合図も混じり、母数が大きくなって「このうち何件」の比率が嘘になるため
      ...(missingConfirmed.length === 0
        ? []
        : [
            `**⚠️ 台帳を開くつもりだったこの ${outcomes.size} 件のうち ${missingConfirmed.length} 件は` +
              `台帳に載っていない（id: ${missingIdList}）。重複として畳んだのでも、既に在った` +
              'のでもない。** **載せ直しが要る**（`commitment_open` で開き直すこと）。',
          ]),
      // trim で説明できてしまう `missing` では「開き直せ」とも「`commitment_list` で確かめよ」とも言わない: 前者は片付いた仕事を作り直させ、後者は trim で消えていれば載らず確かめる手段にならないため
      ...(missingUnexplained.length === 0
        ? []
        : [
            `**⚠️ 台帳を開くつもりだったこの ${outcomes.size} 件のうち ${missingUnexplained.length} 件は` +
              `台帳に見当たらない（id: ${missingUnexplainedIdList}）。この台帳は片付いた古い行を` +
              `物理削除しており（累計 ${list.trimmedClosed} 件）、この id が届いた時刻は、いま残って` +
              'いる片付いた行の中でいちばん古いもの' +
              (oldestRemainingClosedAt === undefined
                ? 'が無い（片付いた行が1件も残っていない）'
                : `（${oldestRemainingClosedAt} に閉じたもの）`) +
              'より前である。** **すでに片付いて捨てられた後なのか、そもそも台帳に書けなかったのかを、' +
              'この情報だけでは区別できない。**',
          ]),
      // `unrecorded` は `missing` とは別の軸で、同じ id が両方に出ることがある: この断りが無いと記録の欠落が黙って消え、「機械がこの id を名乗ったか」を突き合わせる材料が無くなるため
      ...unrecordedLines,
      // 読めない行が在ることもここで断る: `open.length` は `entries` だけの件数で、無いと読めない行が完全に見えなくなるため
      ...(list.unreadable.length === 0
        ? []
        : [
            // 「詳細が見られる」とは書かない: `commitment_list id=<id>` の全文モードは読めない行で `get(id)` が throw し、返るのは「読めない」という事実だけのため
            `**読めない行が ${list.unreadable.length} 件ある（片付いたのではない）。**` +
              '`commitment_list` の一覧に件数として出る（本文はここでは取れない）。',
          ]),
      '全文と齢は `commitment_list` で見られる。**どれを先にやるかは、記憶にある目的と価値観に照らして毎回決め直すこと**' +
        '（台帳は順序を持たない。溜まっている順に片付ける決まりは無い）。',
      '',
      '---',
      '',
    ];
    return lines.join('\n');
  }

  // 1本のメソッドにする: 式 `this.#delivery.inbox.size + this.#delivery.deferredCount` を毎ターンの状況の節と `manager_list` の2箇所に書き写すと、どちらかだけ直して2つの数字が食い違いうるため
  #queuedInMemoryCount(): number {
    return this.#delivery.inbox.size + this.#delivery.deferredCount;
  }

  // `runners()` の内訳から委譲を数え直さない: `unregister()` で名簿から消えた器を持つ委譲がどの束にも載らず落ち、分母が黙って縮むため（本数はいつも `list()` から取る）
  // 蒸留には載せない: 記憶へ移すためだけの内部ターンで、`stop()` 経由はこの直後にプロセスが消えるため
  // 読めなくても行を消さない: 0 で埋めるのも消すのも「全部片付いている」と読める側へ倒れるため。受信箱の滞留は読めなかったとき `undefined` でなく `'unreadable'` を渡す: `undefined` は「省略」に取ってあり、「0件だった」と見分けが付かなくなるため
  async #situationNoticeFor(events: InboxEvent[]): Promise<string> {
    const event = events[0];
    if (event === undefined) return '';
    if (event.type === 'distill') return '';
    try {
      const managers = await this.#managers.list();
      const fleet = await this.#managers.runners();
      // 読めなくても状況ごと落とさない: 鍵だけ `undefined` で渡して「読めなかった」と書かせる。`catch` を外まで広げると、鍵の読みが落ちた回に委譲の本数も器の台数も消えるため
      const pool = await Promise.all([
        this.#stores.tokens.list().then(
          (rows) => rows.map(toAgentTokenView),
          () => undefined,
        ),
        this.#stores.tokens.readActive().then(
          (active) => active,
          () => undefined,
        ),
        // 受信箱の滞留も個別に catch する: 委譲・器・鍵の数え上げを道連れにしないため。安い `pending()` を使う: 内訳まで返す `peekPending()` は毎ターン呼ぶ口ではないため
        // このターンが処理している `events` 自身を引く: 消す `#forget()` はこの後（`#handle` の完了後）にしか呼ばれず、素で読むと処理中の1件が毎ターン「滞留」に数えられ、詰まっているときだけ膨らむという節の存在理由が壊れるため
        // `oldestAt` は補正しない: `events` の `at` は「いま」に近く、本物の滞留の方が古いため。件数が0まで落ちた回は `oldestAt` ごと消す
        this.#stores.inbox.pending().then(
          async (
            backlog,
          ): Promise<{
            count: number;
            oldestAt?: string;
            typeBreakdown?: InboxBacklogBreakdown;
          }> => {
            const count = Math.max(0, backlog.count - events.length);
            if (count === 0) return { count: 0 };
            // `oldestAt: backlog.oldestAt` と素に書かない: 値が `undefined` でもキー自体が生えるため
            const base = {
              count,
              ...(backlog.oldestAt === undefined ? {} : { oldestAt: backlog.oldestAt }),
            };
            // 閾値を超えた回だけ重い `peekPending()` を呼ぶ: 費用は「詰まっている」と分かった回にしか掛けないため（`clone-situation-notice.test.ts` が固定する）
            if (count <= INBOX_BACKLOG_LOUD_THRESHOLD) return base;
            try {
              const peek = await this.#stores.inbox.peekPending();
              return {
                ...base,
                typeBreakdown: summarizeInboxBacklog(peek.entries, Date.now(), peek.unreadable),
              };
            } catch {
              // 内訳が読めなくても件数は取れているので base のまま返す: 件数の行そのものを消さないため
              return base;
            }
          },
          (): 'unreadable' => 'unreadable',
        ),
      ]);
      return describeSituation({
        managers,
        runners: fleet.runners,
        tokens: pool[0],
        active: pool[1],
        at: Date.now(),
        backlog: pool[2],
        // このターン自身は引かない: `#pump` が取り出してからここへ来るので、`#inbox.size` は既にこのターンの分を含まないため
        // `#queuedInMemoryCount()` を経由する: `manager_list` 側と件数の出どころを1箇所にするため
        queuedInMemory: this.#queuedInMemoryCount(),
      });
    } catch (error) {
      return describeSituationUnavailable(error);
    }
  }

  // `list()` の失敗を握り潰さず呼び出し側（`#pump`）へ返す: 握り潰すと呼び出し側の `.catch()` を外しても何も赤くならないため
  // 文言は「いまは」でなく「この断り書きを組んだ時点では」と言う: `#situationNoticeFor` とは別々の `list()` 呼び出しで、まれに食い違うため
  async #validityNoticeFor(events: InboxEvent[]): Promise<string> {
    const event = events[0];
    if (event === undefined) return '';
    // `kind` まで絞る: 質問・許可確認は `#situationNoticeFor` 側で見ており、絞らないと `list()` を1本余計に引くため
    if (event.type !== 'manager_message' || event.kind !== 'report') return '';

    // `try` で囲う: `list()` は同期的に投げうり、`.catch()` だけでは拾えないため
    let now: { readonly status: JobStatus } | { readonly detail: string };
    try {
      const managers = await this.#managers.list();
      const found = managers.find((manager) => manager.managerId === event.managerId);
      now =
        found === undefined
          ? { detail: `${event.managerId} が一覧に居ない` }
          : { status: found.status };
    } catch (error) {
      now = { detail: reasonOf(error) };
    }

    return describeValidity(inboxEventValidity(event, now), event.managerId);
  }

  async #supersededNoticeFor(events: InboxEvent[]): Promise<string> {
    const event = events[0];
    if (event === undefined) return '';
    if (event.type !== 'manager_message') return '';

    // `at` は畳まずそのまま渡す: ここで `Date.parse` すると、読めなかった回の基準が `-Infinity` になり、この委譲の報告が全部「後続」に見えるため
    const afterAts: string[] = [];
    const excludeIds = new Set<string>();
    for (const item of events) {
      excludeIds.add(item.id);
      if (item.type !== 'manager_message') continue;
      afterAts.push(item.at);
    }

    const list = await this.#stores.commitments.list({ includeClosed: true });
    const decision = countSupersedingReports({
      list,
      managerId: event.managerId,
      afterAts,
      excludeIds,
    });
    return describeSuperseded(decision, event.managerId);
  }

  // 書き込みの完了を待ってから消す: 待たないと短いターンでは消し込みが書き込みを追い越し、消したはずの合図が後から書かれて起動のたびに永久に配り直されるため
  // `inbox.remove` が確定するまでメモリ上の印は消さない: 先に消すと「ストアにはまだ残っているのに `#unread` には無い」矛盾を自分で作るため
  // `commitment_close` と1本の DB トランザクションで束ねない: ターンの残りのあいだトランザクションを開いたままにし、長時間ロック・接続の占有を作るため
  async #forget(event: InboxEvent): Promise<void> {
    const written = this.#delivery.getUnread(event.id);
    if (written === undefined) return;

    await written;

    let last: unknown;
    for (let attempt = 0; attempt < FORGET_RETRY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, FORGET_RETRY_MS * attempt));
      }
      try {
        await this.#stores.inbox.remove(event.id);
        this.#delivery.deleteUnread(event.id);
        this.#delivery.redeliveryState.drop(event.id);
        // 畳み込みの索引は `remove` が確定した後でしか落とさない: 消せずに抜ける回は次の起動で配り直される側なので、索引に残す方が正しいため
        this.#dropPendingCollapse(event);
        // token-pool の代表も同じ理由で確定後に落とし、id が一致するときだけ落とす: 合流で差し替えられた後に古い event が来ても代表を巻き添えで消さないため
        this.#delivery.clearPendingTokenPoolNoticeIfMatches(event.id);
        // `settled` は成功した回だけ1回数える: 失敗を再試行する `for` の中で `return` するのはここだけのため
        this.#inboxFlow.settled(event.type);
        return;
      } catch (error) {
        last = error;
      }
    }
    // 印も残したまま跡だけ残して進む: 消せなかったものは次の起動で配り直される（消えるより配り直す）側で、印を消すと「もう消せている」と嘘をつくため
    noteDroppedRecord('未読の消し込み', inboxEventShape(event), last);
  }

  async #restoreUnread(): Promise<void> {
    // 本体を別の関数へ分けたまま畳まない: 本体は途中の `return` で何箇所からも抜けるので、`return` の手前で印を降ろす形だと1箇所足し忘れた回だけ印が立ったまま残り、その後の消し込みが永久に墓標へ溜まる（赤くならない）ため
    this.#restoringUnread = true;
    try {
      // `#restoreUnreadPass()` の前に `await` を足さない: `claimPending()` が動く時機が遅れると、`post()` の永続化との競合で、たった今 `post()` された合図を「前の器の未読」として拾い、同じ合図を2回配達へ乗せるため
      const claimedIds = await this.#restoreUnreadPass();

      // 回答済みで未配達の承認の拾い直しはその後に置く: `claimedIds` で、既に拾われたものとまだ受信箱に乗っていないものを区別するため。失敗しても投げない: 通常の配り直しは完走済みで、次の起動でまた拾い直せるため
      try {
        await this.#reconcileUndeliveredAnswers(claimedIds);
      } catch (error) {
        noteDroppedRecord('回答済み未配達の承認の拾い直し（全体）', '', error);
      }
    } finally {
      this.#restoringUnread = false;
      this.#droppedWhileRestoring.clear();
      this.#restorePassFinished = true;
      this.#postedBeforeRestored.clear();
    }
  }

  // 読み直す1操作（`updateApproval`）で `answerDelivery` だけを書き換える: 読んだ写しで行を丸ごと書き戻すと、その間に入った取り下げ・2回目の回答を古い写しで消すため。現在の行が `'pending'` で `answeredAt` が同じときだけ書く
  async #markAnswerDelivered(approvalId: string, answeredAt: string): Promise<void> {
    await this.#stores.jobs.updateApproval(approvalId, (current) =>
      current.answerDelivery === 'pending' && current.answeredAt === answeredAt
        ? { ...current, answerDelivery: 'delivered' }
        : null,
    );
  }

  // 処理した時点で印を付け直す: 印の書き込みだけが落ちると `'pending'` のまま残り、起こし直しで空になる `#handledHumanAnswerIds` では二重配達を畳めず、起動時の拾い直しが同じ回答をもう一度配るため（約束は「少なくとも1回」で、回答を失うより二重に届く方が害が小さい）。書き込みの失敗は握って跡を残す
  async #markAnswerDeliveredOnHandle(
    approval: PendingApproval | null,
    event: Extract<InboxEvent, { type: 'human_answer' }>,
  ): Promise<void> {
    if (approval === null || approval.answerDelivery !== 'pending') return;
    if (approval.answeredAt === undefined) return;
    if (humanAnswerEventId(approval.id, approval.answeredAt) !== event.id) return;
    try {
      await this.#markAnswerDelivered(approval.id, approval.answeredAt);
    } catch (error) {
      noteDroppedRecord('回答の配達印の確定（処理時）', inboxEventShape(event), error);
    }
  }

  // `#restoreUnreadPass` の前に置かない: 前で `await` すると `claimPending()` の時機が1往復遅れ、直後に `post()` された合図を「前の器の未読」として拾って同じ合図を2回配達へ乗せるため
  // 古い行（`answerDelivery` を持たない）は対象にしない: 遡って配り直すと、とっくに人間の目から消えた古い回答が今さら届くため
  // `claimedIds` に載っている行には印を付けるだけにする: 直前の `#restoreUnreadPass` が配達の管轄に入れており、`inbox.put` も `post()` も重ねない（二重配達を避ける）。載っていない行だけ `post()` を呼ぶ
  async #reconcileUndeliveredAnswers(claimedIds: ReadonlySet<string>): Promise<void> {
    let approvals: PendingApproval[];
    try {
      const list = await this.#stores.jobs.listApprovals({ pendingOnly: false });
      approvals = list.entries;
      if (list.unreadable.length > 0) {
        noteDroppedRecord(
          `読めない承認待ち ${list.unreadable.length} 件の回答済み未配達の拾い直し`,
          '',
          new Error('行が読めない形で入っている。行は書き換えていない'),
        );
      }
    } catch (error) {
      noteDroppedRecord('回答済み未配達の承認の読み直し', '', error);
      return;
    }

    const undelivered = approvals.filter(
      (approval): approval is PendingApproval & { answeredAt: string; answer: string } =>
        approval.answeredAt !== undefined &&
        approval.answer !== undefined &&
        approval.answerDelivery === 'pending' &&
        approval.withdrawnAt === undefined &&
        approval.answeredAt < this.#bootedAt,
    );
    if (undelivered.length === 0) return;

    let reconciled = 0;
    for (const approval of undelivered) {
      const event = buildHumanAnswerEvent(
        approval,
        approval.answer,
        approval.answeredAt,
        approval.answeredVia,
        approval.selections,
      );
      // 配達より先に許可の記録を作り直す: 落ちた窓は `answerApproval` の許可の記録より前にありうるので、配達だけ埋めると同意が黙って消えるため
      await this.#reconcilePermissionGrant(approval);
      try {
        if (claimedIds.has(event.id)) {
          await this.#markAnswerDelivered(approval.id, approval.answeredAt);
        } else {
          await this.#stores.inbox.put(event, event.at);
          await this.#markAnswerDelivered(approval.id, approval.answeredAt);
          this.post(event);
        }
        reconciled += 1;
      } catch (error) {
        noteDroppedRecord('回答済み未配達の承認の拾い直し', inboxEventShape(event), error);
      }
    }

    if (reconciled > 0) {
      // 新しい `type: 'exchange'` の書き込み箇所は増やさず `type: 'decision'` を使う: `exchange-kind-coverage.test.ts` の網羅の件数を動かさないため
      await this.#journal({
        type: 'decision',
        decision: `回答済みで未配達の承認を拾い直した（${reconciled} 件）`,
        grounds:
          '起動時、承認の行が answerDelivery=pending のまま残っていた' +
          '（issue #1977。プロセスが answerApproval の途中で落ちた痕跡）。',
      });
    }
  }

  // 呼び直すのは許可の記録の前提を満たす承認だけ: 満たさない承認で呼ぶと「記録しなかった」の日誌が二重に出るため。その `approvalId` の許可の記録が既に在れば何もしない: 落ちたのが記録の後だった場合に二重にしないため。失敗は握って、配達の拾い直しは止めない
  async #reconcilePermissionGrant(
    approval: PendingApproval & { answeredAt: string; answer: string },
  ): Promise<void> {
    if (approval.permissionRequest === undefined) return;
    if (approval.answer.trim() !== PERMISSION_GRANT_CONSENT_PHRASE) return;
    if (approval.answeredVia?.kind !== 'account') return;
    try {
      const grants = await this.#stores.permissionGrants.list();
      if (grants.some((grant) => grant.approvalId === approval.id)) return;
      await this.#recordPermissionGrantIfConsented(
        approval,
        approval.answer,
        approval.answeredAt,
        approval.answeredVia,
      );
    } catch (error) {
      noteDroppedRecord(
        '回答済み未配達の承認の許可の記録の拾い直し',
        `approvalId=${approval.id}`,
        error,
      );
    }
  }

  // 読めなければ空を返す: 判定できないなら畳まず配る（「消えるより配り直す」）ため
  async #lastScheduledRunAtByKind(
    pending: readonly PendingInboxEvent[],
  ): Promise<Map<string, string>> {
    const byKind = new Map<string, string>();
    if (!pending.some((record) => record.event.type === 'timer')) return byKind;
    try {
      const list = await this.#stores.schedules.list();
      for (const plan of list.entries) {
        if (plan.lastScheduledRunAt !== undefined) byKind.set(plan.kind, plan.lastScheduledRunAt);
      }
    } catch (error) {
      noteDroppedRecord('定期の依頼の完了済みの回の確認', '', error);
    }
    return byKind;
  }

  async #restoreUnreadPass(): Promise<ReadonlySet<string>> {
    let pending: PendingInboxEvent[];
    try {
      pending = await this.#stores.inbox.claimPending();
    } catch (error) {
      noteDroppedRecord('未読の読み直し', '', error);
      return new Set();
    }

    const claimedIds: ReadonlySet<string> = new Set(pending.map((record) => record.event.id));

    // 一緒に拾い直した件数はここで数える: `#redelivered` は1件ずつ積まれるので、後から見ても「同時だったか」が分からないため
    this.#restoredCohort = pending.length;

    // どんな早期 return を通っても、終わりには必ず対の1行（`#journalRestoreUnreadPassEnd`）を書く: 始まりと終わりの対応を崩さないため
    await this.#journalRestoreUnreadPassStart(pending.length);

    // 索引を拾い直した未読から作り直す: `#pendingCollapse` はメモリ上にしか無く、再起動を跨ぐと空になり、これから届く同文がまた新しい代表として積まれるため
    // 先に見つかった行を代表にし、既存のバックログは遡って畳まない: `#forget` を伴う別の後始末になり、下の1件ごとの配るか消すかの判定を横取りするため
    for (const record of pending) {
      const key = inboxCollapseKey(record.event);
      if (key === undefined) continue;
      if (this.#delivery.hasCollapseKey(key)) continue;
      this.#delivery.registerCollapseRepresentative(key, record.event.id, record.event.at);
    }

    // token-pool の代表は最後に見つかったものにする: 複数残っていた場合、いちばん後ろに並んでいたものを「いま分かっている中でいちばん新しい」とみなす近似（ここでも遡って畳まない）
    for (const record of pending) {
      if (record.event.type !== 'external') continue;
      if (record.event.source !== DAEMON_TOKEN_POOL_REOPENED_SOURCE) continue;
      // 鍵が作れない record は代表にしない: `event.id` を鍵の代わりにすると、次に鍵の作れる通知が届いたとき「中身が違う」と誤判定して代表を無条件で外しに行くため
      const key = this.#externalMergeKey(record.event);
      if (key === null) continue;
      this.#delivery.setPendingTokenPoolNotice({
        id: record.event.id,
        at: record.event.at,
        key,
        folded: 0,
      });
    }

    // 日誌の側も同じ材料で名乗り分ける: モデルへ渡す側だけ直すと、渡す側で塞いだ嘘が `journal_read` で読み返す側から入ってくるため。`#restoredCohort` は以降動かないのでループの外で1度だけ判定する
    const alone = this.#restoredCohort <= 1;

    // live/stale の判定はループの外で全件ぶん先に済ませ、ループの中で呼び直さない（`decided` から読むだけ）: 二重に呼ぶ理由が無いことをコードの形でも示すため
    // 完了済みの回の timer 行も畳む: 完了まで済んだのに消し込みだけ失敗した行を配ると、完了済みの回が二度走るため
    const completedRounds = await this.#lastScheduledRunAtByKind(pending);
    const completedRoundIds = new Set<string>();
    const decided = pending.map((record) => {
      const base = restoredInboxEventVerdict(record.event);
      if (base === 'stale' || record.event.type !== 'timer') return { record, verdict: base };
      const completed =
        completedTimerRoundVerdict(record.event, completedRounds.get(record.event.kind)) ===
        'stale';
      if (completed) completedRoundIds.add(record.event.id);
      return { record, verdict: completed ? ('stale' as const) : base };
    });

    // live と判定した record は先にまとめて1回だけ「配り直した」を書く: 1件ずつだと N 件の未読を拾い直した起動でこの見出しだけで N 行が1秒未満に並ぶため
    const liveRecordsThisPass = decided
      .filter((entry) => entry.verdict !== 'stale')
      .map((entry) => entry.record);
    if (liveRecordsThisPass.length > 0) {
      // この行に本文は載せない: 載せると、本文を持つ側（`#record` / `#handle`）と二重になるため。本文より必ず前に書く
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_RECOVERY_PREFIX}${this.#redeliveredLiveHeadline(liveRecordsThisPass, alone)}`,
      });
    }

    // 溜めるのはストアへの書き込みだけ: journal・`#record` / `#commit`・メモリ上の索引は record ごとに即座に済ませる
    // `#stopped` / `#inbox.closed` による早期 return の手前では必ず先に空にする（`flushStaleRemovalBuffer`）: 「消した」と日誌へ書いた record が器から消えないまま抜け、日誌の言明とストアの実体が食い違う窓を作らないため
    const staleBuffer: PendingInboxEvent[] = [];

    const flushStaleRemovalBuffer = async (): Promise<void> => {
      if (staleBuffer.length === 0) return;
      const batch = staleBuffer.splice(0, staleBuffer.length);
      // `RESTORE_STALE_REMOVE_CHUNK_MAX_IDS` を超えないよう件数で塊に割る: 1本の `removeMany` へ全件を渡すと `storage-pg` の `IN (...)` がバインドパラメータ上限で壊れるため
      for (let i = 0; i < batch.length; i += RESTORE_STALE_REMOVE_CHUNK_MAX_IDS) {
        await this.#removeStaleRedeliveryChunk(
          batch.slice(i, i + RESTORE_STALE_REMOVE_CHUNK_MAX_IDS),
        );
      }
    };

    // 溜めるのは journal の材料だけ: 本文は `#foldGatedRedelivery` の中で record ごとに即座に書く。合図を消すかどうかはここでも扱わない
    const gatedRecordsThisPass: PendingInboxEvent[] = [];

    const flushGatedFoldHeadline = async (): Promise<void> => {
      if (gatedRecordsThisPass.length === 0) return;
      const batch = gatedRecordsThisPass.splice(0, gatedRecordsThisPass.length);
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_THINNING_PREFIX}${this.#gatedRedeliveryFoldHeadline(batch)}`,
      });
    };

    for (const [restoreUnreadPassIndex, { record, verdict }] of decided.entries()) {
      if (this.#sdkSession.stopped || this.#delivery.inbox.closed) {
        await flushStaleRemovalBuffer();
        // `staleBuffer` と同じ理由でここでも先に空にする: 積んだ「畳んだ」を return 前に書き切らないと、journal に一度も現れず黙って失われるため
        await flushGatedFoldHeadline();
        await this.#journalRestoreUnreadPassEnd(decided, restoreUnreadPassIndex, {
          interrupted: true,
        });
        return claimedIds;
      }

      // この起動で既に生で投函した合図は配り直さず、未読の控えにも触らない: `post` の書き込みの後に `claimPending()` が返ると同じ合図が乗るが、前の器の未読ではなく生の配達の側が持っているため
      if (this.#postedBeforeRestored.has(record.event.id)) continue;


      if (verdict === 'stale') {
        // 跡は残す: 落ちた分が読めないと、「無い」の種類（届かなかった／畳まれた／そもそも起きなかった）が区別できなくなるため
        await this.#dropStaleRedelivery(record, {
          alone,
          completedRound: completedRoundIds.has(record.event.id),
        });
        // `staleBuffer` へ積むのは journal 書き込みの直後・他のどんな早期 return よりも前: 後ろに置くと、「消した」と書いた直後に `#stopped` が立った回だけ record が積まれないまま return し、日誌とバッファが食い違うため
        staleBuffer.push(record);
      }

      // 積む直前にもう一度見る: 日誌を書いているあいだに片付けが始まっていることがあり、`Inbox#push` は閉じた後だと投げるため
      if (this.#sdkSession.stopped || this.#delivery.inbox.closed) {
        await flushStaleRemovalBuffer();
        await flushGatedFoldHeadline();
        // **計器: 終わりの1行（中断）**（issue #903）。stale の record は
        // ここに来る前に `#dropStaleRedelivery` と `staleBuffer.push` を
        // 済ませ、直上の `flushStaleRemovalBuffer` でストアから消えている
        // ので、この周の1件も「処理した」に入れる。live の record はまだ
        // `#inbox.push` しておらずストアに残るので入れない
        // （`#journalRestoreUnreadPassEnd` の doc「『処理した』の定義を1つに
        // 統一する」）。
        await this.#journalRestoreUnreadPassEnd(
          decided,
          restoreUnreadPassIndex + (verdict === 'stale' ? 1 : 0),
          { interrupted: true },
        );
        return claimedIds;
      }

      // **台帳が既に片付いていると言っているかを見る（閉じた主体は問わない
      // ——クローンでも人間でもよい）。** 台帳の id は合図の id その
      // ものである（`commitmentFor`）ので、`event.id` でそのまま引ける。
      // `commitmentFor` が `null` を返す合図は台帳に載らない＝引く意味が無いので
      // `stores.commitments.get` を呼ばない。**`null` を返すのは型で決まる3つ
      // （`timer` / `self_initiative` / `distill`）だけではない** — `external` は
      // `source` がデーモン自身の合図（`isDaemonSelfNotice`）なら同じく `null` を
      // 返す。だから型で先読みして分岐を作らず、呼び出した結果（`!== null`）を
      // 毎回見る。
      if (commitmentFor(record.event) !== null) {
        try {
          const commitment = await this.#stores.commitments.get(record.event.id);
          // **`closedAt` が立っているものだけ短縮の対象にする。** 未了はここでは
          // 何もしない（`#redeliveredClosed` に載らない）ので、後段は変わらず
          // 全文で配る — 1文字も変えない。
          if (commitment !== null && commitment.closedAt !== undefined) {
            this.#delivery.redeliveryState.markClosed(record.event.id, commitment);
          }
        } catch (error) {
          // **読めなければ「閉じていない」として扱う＝全文で配る。** ここで
          // ターンを止めない。安全側は「全文で配る」— 雑音であって喪失ではない
          // 側へ倒す。
          noteDroppedRecord('配り直しの片付き確認', inboxEventShape(record.event), error);
        }
      }

      this.#delivery.redeliveryState.markRedelivered(record.event.id, record);
      // 既に器に在るので書き直さない。**ただし消し込みの対象には入れる**
      // （入れ忘れると、拾い直したものが処理後も残って毎回配られる）。
      this.#delivery.setUnread(record.event.id, Promise.resolve());
      // **本文は配達のたびに書く。** 受理の瞬間の追記（`#record`）は `post` から
      // 見て非同期なので、器へ届く前に落ちたかどうかは**ここからは分からない**。
      // 書かない側を選ぶと、その窓に落ちた発言が日誌から永久に消える（未読の器に
      // は在るのに、日誌にも `GET /conversations` にも無い）。書く側を選べば重複
      // しうるが、それは**この直しの前と同じ回数**である（以前も `#handle` が配達
      // ごとに書いていた）。「消えるより配り直す」の向きを、記録でも揃える。
      this.#record(record.event);
      // **記帳もやり直す。** `open` は冪等なので、前の器で開けていれば何も起きず、
      // 閉じてあれば閉じたままである。やり直さない側を選ぶと、`post` が受理してから
      // `open` が器へ届く前に落ちた合図だけが、未読としては残るのに台帳から永久に
      // 漏れる（そしてその窓は、いちばん落ちやすい起動直後と重なる）。
      this.#commit(record.event);

      // **門より先に「そもそもまだ意味が在るか」を訊く**（Issue #783 段1）。
      //
      // **門（`redeliveryGate`）とは別の問いである。** あちらは `usageBlocked`
      // という**揺れる値**で「いま配るか」を決め、偽でも行を残す。こちらは
      // **合図の性質**だけで「もう要らないか」を決め、要らないものを消す——
      // だから `restoredInboxEventVerdict` は `usageBlocked` を受け取らない
      // （その doc）。**消し込みを揺れる値に預けない**ための分け方である。
      //
      // **判定はループの外（`decided`）で計算済みのものを使う**（issue #903。
      // 「配り直した」を1本へ畳んだこの直しでループの外へ出したが、
      // 「二重に呼ばない」という判断自体は変えていない）。
      // `restoredInboxEventVerdict` をもう一度呼び
      // 直さない——同じ `event` に対して二度目を呼んでも答えは変わらないが
      // （純関数）、二重に呼ぶ理由が無いことをコードの形でも示す。
      //
      // **消し込みはここでは行わない。** `#dropStaleRedelivery`（上で呼び
      // 済み）は跡を書くだけで、実際の `inbox.remove` はもう呼ばない——
      // 積むのは既に上（journal 書き込みの直後）で済ませてある
      // （`staleBuffer.push` の doc）。ここは残っている門（`redeliveryGate`）
      // ・`#inbox.push` を skip するだけの分岐である。
      if (verdict === 'stale') {
        continue;
      }

      // **配る前に、この1件だけ「いま配る意味が在るか」を訊く**
      // （`CloneOptions.redeliveryGate`。Issue #783 続き）。`#restoreUnread` は
      // `post()` を通らないので、`post()` の中の枠の門（`#usageBlocked` の唯一の
      // 効果）もここを素通りしてしまう——渡されていれば、その門と同じ実体
      // （`apps/daemon/src/index.ts` の `worthDeliveringNow`）を使った述語で
      // ここを埋める。
      //
      // **その瞬間の `usageBlocked` で評価する。** ループの外で1回だけ評価して
      // 使い回さないこと——このループは1件ごとに `await` するので、並行して動く
      // `#pump` が途中で `usageBlocked` を動かしうる（枠に当たる／解ける）。
      //
      // **`redeliveryGate` は必須なので、ここは常に呼ぶ**
      // （`CloneOptions.redeliveryGate` の doc）。
      //
      // **`usageBlockedResetsAt` / `usageBlockedTokenId` も同じ瞬間に読む**
      // （Issue #1223 再発）——`#restoreUnread` は `post()` を通らないので、
      // `staleObservedRecoveryNoticeEvent` の判定は呼び手（`redeliveryGate`）
      // が自分で当てるしかない（`RedeliveryGate` の doc の該当 `@param`）。
      let worthRedelivering: boolean;
      try {
        worthRedelivering = this.#redeliveryGate(record.event, {
          usageBlocked: this.usageBlocked,
          releasePending: this.usageReleasePending,
          usageBlockedResetsAt: this.usageBlockedResetsAt,
          usageBlockedTokenId: this.usageBlockedTokenId,
        });
      } catch (error) {
        // **判定できないときは配る側へ倒す**（直前の「台帳が読めなければ
        // 『閉じていない』として扱う」と同じ向き。雑音であって喪失ではない側）。
        noteDroppedRecord('配り直しの門の判定', inboxEventShape(record.event), error);
        worthRedelivering = true;
      }

      if (!worthRedelivering) {
        // **`#inbox.push` をしない ＝ ターンを起こさない。** 受信箱の行も台帳の
        // 行も消さない（`#forget` / `stores.inbox.remove` を呼ばない）——次の
        // 起動でまた `#restoreUnread` が拾い、その時点の `usageBlocked` で
        // 判定し直す。跡は `#foldGatedRedelivery` が残す——本文
        // （`#journalIncomingBody`）は record ごとに即座に、「畳んだ」の1行は
        // `gatedRecordsThisPass` へ積んで1パスぶんまとめて1本（未読の一括
        // 拾い直しで日誌が肥大化する形をもう1つ塞ぐ直し。同メソッドの doc）。
        await this.#foldGatedRedelivery(record, gatedRecordsThisPass);
        continue;
      }

      // `post` を通さないのは、tick の畳み込みで落ちた行が器に残り続けるからである
      // （落とした側は誰も消さないので、起動のたびに配られて回数だけが増える）。
      // それでも `post` が効かせている人間優先（`insertAfterLast`）まで
      // 一緒に落としてはいけない——`post` を通さない選択は「畳み込み」だけを
      // 避けるためのもので、割り込みの規則まで避ける理由にはならない。
      //
      // **`delivered`（Issue #783 段0。Issue #1049 が名指しした軸）。** ここは
      // 器の入れ替えを跨いだ拾い直しなので、**この窓に `arrived` していない**
      // ものが `delivered` に入る（`schema.ts` の `inbox_flow` の doc「`arrived`
      // / `pending` と食い違う理由」）。
      // **拾い直しているあいだに消された合図は、積まない**（issue #1049）。
      //
      // **`dropQueuedInboxEvents` だけでは届かない窓がここである。** あちらが
      // 外せるのは「その瞬間に待ち行列に居るもの」で、このループは `claimPending()`
      // した集合を**これから**1件ずつ積んでいく —— あいだに日誌の書き込みと台帳の
      // 照会の `await` が挟まるので、**消された後に積む**順序が普通に起きる
      // （#1049 の事故は拾い直しが 3,326 件あった起動で、消し込みはそのループの
      // 最中だった）。
      //
      // **門（`redeliveryGate`）より後ろに置く。** あちらは「いま配る意味が
      // 在るか」を `usageBlocked` で決めて**行を残す**が、こちらは器の行が既に
      // 無い ⟹ 残す先が無い。順序を逆にすると、消された合図に対して
      // `#foldGatedRedelivery`（「次の起動でまた拾う」と書く跡）が残り、**次の
      // 起動では拾えないのに拾えると書く**ことになる。
      //
      // **`#forget` は呼ばない。** 器の行は消し込んだ側が既に消している
      // （`dropQueuedInboxEvents` の doc「消し込みは呼ばない」と同じ理由 ——
      // 空振りの `remove` で `settled` を二重に数える）。
      if (this.#droppedWhileRestoring.has(record.event.id)) {
        this.#delivery.deleteUnread(record.event.id);
        this.#delivery.redeliveryState.drop(record.event.id);
        this.#dropPendingCollapse(record.event);
        await this.#journal({
          type: 'exchange',
          with: 'self',
          role: 'outbound',
          text:
            `${EXCHANGE_KIND_THINNING_PREFIX}拾い直している最中に器から消された合図なので、配らずに畳んだ` +
            `（配り直しの対象だったが、消し込みが先に届いた）: ${inboxEventShape(record.event)}`,
        });
        continue;
      }

      this.#inboxFlow.delivered(record.event.type);
      this.#delivery.inbox.push(
        record.event,
        this.#humanPriority && isHumanOriginated(record.event) ? isHumanOriginated : undefined,
      );
    }

    // **ループが最後まで走り切った回の後始末**（issue #903）。早期 return
    // した回はそれぞれの手前で既に空にしているので、ここへ来る時点で
    // 残っているのは「最後まで到達した」場合だけである。
    await flushStaleRemovalBuffer();
    // **こちらも同じ理由で最後に空にする**（`#foldGatedRedelivery` の doc
    // 「1パス1本へ畳む直し」）。ループの中で1件も門に畳まれなかった回は
    // `gatedRecordsThisPass` が空のままなので、`flushGatedFoldHeadline` は
    // 何も書かずに戻る。
    await flushGatedFoldHeadline();
    // **計器: 終わりの1行（完走）**（issue #903）。ここへ来る時点で
    // `decided` の全件を処理し終えている——`processed` に `decided.length`
    // を渡す。
    await this.#journalRestoreUnreadPassEnd(decided, decided.length, { interrupted: false });
    return claimedIds;
  }

  /**
   * `#restoreUnreadPass` の1回の処理（1パス）の**始まりに1行だけ**書く、
   * 総数の計器（issue #903）。呼ぶのは `#restoreUnreadPass` の先頭
   * （`claimPending()` が返した直後）だけである。
   *
   * ## 何のための行か——性能の改修ではなく、見える化である
   *
   * issue #903 が指摘した性質（`claimPending()` が返す全件を、上限も刻みも
   * 無く処理する）そのものはこの行では直していない——直すかどうかは
   * 別の判断で、当時のオーナーの判定（本 Issue のコメント）は「急いで
   * 刻みを入れるほうが危険」だった。**ここで足すのは、その性質が実際に
   * どれくらいの件数を動かしているかを、日誌を読むだけで数えられるように
   * する手当てだけである。**
   *
   * ## 件数が0のときは書かない
   *
   * `#restoreUnread` は器の入れ替え（プロセスの再起動）のたびに必ず1回
   * 走る——未読が0件の（実運用ではこちらが大半の）起動でもここへ来る。
   * 0件のたびにこの行を書くと、この行自体が「積み上がったときに見え
   * なくする」雑音になる——起動回数ぶん積み重なるのに対し、対応する
   * `#journalRestoreUnreadPassEnd` も含めて中身が無い。**この Issue が
   * 問題にしている雑音を、対策のつもりで増やさないため、総数が1件以上の
   * ときだけ書く。**
   *
   * ## 対になる終わりの行との関係
   *
   * この行を書いた回は、`#restoreUnreadPass` のその後の全ての経路
   * （完走・2箇所ある `#stopped` / `#inbox.closed` の早期 return のどれか）
   * で、必ず `#journalRestoreUnreadPassEnd` を1回呼ぶ——始まりだけ在って
   * 終わりが無い回を作らない。**この対称性は呼び出し元（`#restoreUnreadPass`
   * 自身）が保証する**——ここでは総数を書くだけで、終わりの側の責務は
   * 一切持たない。
   */
  async #journalRestoreUnreadPassStart(total: number): Promise<void> {
    if (total <= 0) return;
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: `${EXCHANGE_KIND_GAUGE_PREFIX}未読の拾い直しを始める（claimPending が返した総数 ${total} 件）`,
    });
  }

  /**
   * `#restoreUnreadPass` の1回の処理（1パス）の**終わりに1行だけ**書く、
   * 処理件数の計器（issue #903）。`#journalRestoreUnreadPassStart` と対——
   * 呼ぶのは、始まりの行を書いた回（`decided.length > 0`）だけである
   * （`#restoreUnreadPass` がその対称性を保証する。同関数の doc）。
   *
   * ## 引数
   *
   * - `decided`: `#restoreUnreadPass` がループの外で1回だけ計算した
   *   live/stale の判定表（`{ verdict }` を持つ配列。`record` 自体は
   *   ここでは読まない）。**その `length` が総数**——`claimPending()` が
   *   返した件数と常に一致する（`decided` は `pending.map(...)` で作る
   *   1対1の写像）。
   * - `processed`: このパスでループが実際に最後まで処理し終えた件数。
   *   **`decided` の先頭からこの件数ぶんを指す**——`#restoreUnreadPass` が
   *   ループを回した `for…of decided.entries()` の index をそのまま渡す
   *   （完走した回は `decided.length` を渡す）。
   * - `context.interrupted`: `#stopped` / `#inbox.closed` による早期
   *   return を経由したかどうか。
   *
   * ## 「処理した」の定義を1つに統一する
   *
   * ループの中には `#stopped` / `#inbox.closed` を見る早期 return が2箇所
   * ある——1箇所目は record を1件も触る前、2箇所目は stale の record なら
   * 既に `#dropStaleRedelivery`（消し込みの journal・`staleBuffer` への
   * 積み込み）まで済ませた後。**どちらで止まっても、`processed` は
   * 「ストアから消えた（次の起動で拾い直されない）件数」で統一する**——
   * 行が「残り N 件は次の起動で拾い直す」と名乗る以上、N はストアの実際の
   * 残りと一致していなければならない。⟹ 2箇所目で止まった周の record は、
   * stale なら `processed` に含める（直前の `flushStaleRemovalBuffer` で
   * 消えている）。live なら含めない（まだ `#inbox.push` しておらず、ストアに
   * 残って次の起動で拾い直される）。
   *
   * ## 内訳（stale / live）は専用のカウンタを持たず、都度数え直す
   *
   * `decided[i].verdict` はループより前に確定済みの純関数の結果なので、
   * `processed` 件ぶんを事後にまとめて数え直しても答えは変わらない。
   * ループの中で専用のカウンタを2本（stale 用・live 用）持つ設計も
   * あり得たが、**採らなかった**——中断のタイミングと更新の順序が
   * 噛み合わなかったときに2本のカウンタが食い違う、という単純な数え直し
   * では起こらない種類のバグを新しく作る余地があるため。
   */
  async #journalRestoreUnreadPassEnd(
    decided: ReadonlyArray<{ readonly verdict: RestoredInboxEventVerdict }>,
    processed: number,
    context: { readonly interrupted: boolean },
  ): Promise<void> {
    const total = decided.length;
    if (total <= 0) return;
    const staleCount = decided
      .slice(0, processed)
      .filter((entry) => entry.verdict === 'stale').length;
    const liveCount = processed - staleCount;
    // **接頭辞の参照はここ（`#journal` 呼び出しの `text:` フィールド）に
    // 直接書く。** `exchange-kind-coverage.test.ts` の静的な網羅性の歯は
    // ソースを走査して `text:` フィールドの値が `EXCHANGE_KIND_*_PREFIX`
    // 定数名を**文字として**含むかを見る——実行時にどの分岐を通っても
    // 値が同じ接頭辞で始まることは、この歯にとっては見えない（変数に
    // 一度だけ計算してから `text` の短縮記法で渡すと、定数名がこの
    // 呼び出しの引数の中に一度も現れず、この歯を静かに素通りする。
    // 実測——最初の版はこの形で書いていて、この歯を赤くした）。
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: context.interrupted
        ? `${EXCHANGE_KIND_GAUGE_PREFIX}未読の拾い直しを中断した（#stopped または #inbox.closed。` +
          `総数 ${total} 件のうち ${processed} 件を処理した＝内訳 stale ${staleCount} 件・` +
          `live ${liveCount} 件。残り ${total - processed} 件は次の起動で拾い直す）`
        : `${EXCHANGE_KIND_GAUGE_PREFIX}未読の拾い直しが終わった（総数 ${total} 件のうち ${processed} 件を` +
          `処理した＝内訳 stale ${staleCount} 件・live ${liveCount} 件）`,
    });
  }

  /**
   * `#restoreUnreadPass` が live と判定した record 全件ぶんの「配り直した」
   * を、1本の journal entry の文面へ組み立てる。呼ぶのは
   * `#restoreUnreadPass` だけである。
   *
   * ⚠️ **この直しに GitHub の issue 番号は付いていない。** オーナーが
   * 逐語で名指しした表示（`self → 未読のまま残っていた合図を配り直した
   * (330回目の配達)`）を直接直したもので、「issue #1240」と紐づけない
   * こと——その番号は別件（PR #1280「枠が閉じている間の再武装と日誌の
   * 書き込みを抑える」）で既に使われている。
   *
   * ## なぜ要るか
   *
   * 以前は record 1件につき「配り直した」を1行書いていた——器の入れ替えを
   * 跨いで未読が N 件溜まった起動では、この見出しだけで N 行が1秒未満に
   * 並ぶ（`with: 'self'` の交換）。issue #903 は stale の
   * 消し込み（ストアへの `removeMany`）を一括にしたが、**live 側の見出しは
   * 触っていない**——stale 側は`#dropStaleRedelivery` が record ごとに
   * 「配り直した」と「消した」を1行へ畳んだだけで、複数 record を1本へ
   * まとめる形はどちらの側にも無かった。ここが初めてそれをする。
   *
   * ## なぜループの外（record を1件も処理する前）で書くか
   *
   * **この行は、この record の本文より前でなければならない**——本文は
   * `#restoreUnreadPass` のループが record ごとに `this.#record(record.event)`
   * （人間の発言なら）で書く。1件ずつ書いていた旧実装は、record の番に
   * なったときにその場で書くことで自然にこれを満たしていた。**N 件を
   * 1本へまとめる以上、N 件ぶんの中身を先に知っていなければ書けない**
   * ——知るのに record を1件も処理する必要は無い（`restoredInboxEventVerdict`
   * は純関数で、`pending` は `#restoreUnreadPass` の先頭で既に読み終えて
   * いる）。だから `#restoreUnreadPass` は、record を1件も処理する前に
   * この1本を書き切ってから、record ごとのループへ入る。
   *
   * ⚠️ **この選択には代償が1つある。** 書いた後で `#stopped` /
   * `#inbox.closed` によりループが途中で打ち切られると、まだ「到達して
   * いない」live な record もこの1行には載っている——旧実装なら、その
   * record の見出しはこの回は一度も書かれず、次の起動で（新しい
   * `deliveries` の値で）改めて書かれていた。**それでもここで書く**——
   * `deliveries` は `claimPending()`（`#restoreUnreadPass` の先頭）が
   * **ループより前に**ストアへ確定させた値であり、record がループの中で
   * 実際に処理されたかどうかとは無関係に、この起動で「配り直された
   * （＝再度読み出しの対象になった）」ことは既に真である。**「二度届く
   * （雑音）より消える（判断材料の喪失）方が高い」**（`store.ts` の
   * `InboxStore` の doc）という、この受信箱の設計そのものの向きに合わせて
   * いる——旧実装の「見出しごと書かれない」ほうが、確定済みの事実を無言で
   * 捨てる側だった。
   *
   * ## 1件のときは、以前の文言を1文字も変えない
   *
   * `records.length === 1` のときは、この直しの前とまったく同じ組み立てを
   * 通す——変える理由が無いところは変えない（`AGENTS.md`「テストを弱めず
   * に直す」の見分け方）。`inbox-persistence.test.ts` の「未読が1件だけ
   * なら、日誌の1行は回数をそのまま名乗る」はこの文言を逐語で見ている。
   *
   * ## 2件以上のときは `alone` を参照しない
   *
   * `alone`（`this.#restoredCohort <= 1`）が真なら `pending` は高々1件しか
   * 無い ⟹ live な record が2件以上あることは無い。**だから2件以上の枝は
   * `alone` の分岐を持たない**——`#redeliveryNoticeFor` の `batch.length >= 2`
   * 枝が同じ理由で `alone` を参照していないのと同じ形である。
   *
   * ## 何を失っていないか
   *
   * `deliveries` / `at` / `inboxEventShape(event)` を record ごとに列挙する
   * ——件数だけに潰さない。**`#redeliveryNoticeFor` の束の行（2件以上）とは
   * 違う**——あちらは最大配達回数と最も古い時刻だけへ要約する。あちらは
   * モデルへ渡す判断材料で、要約で足りる（`#redeliveryNoticeFor` の doc）。
   * こちらは人間が後から読み返す日誌なので、1件も欠かさず残す。
   *
   * ⚠️ **時間の窓（何秒以内は捨てる）も件数の上限（先頭 N 件だけ書く）も
   * 持ち込まない。** `records` は `pending` のうち live と判定された分を
   * 1件残らず列挙する。
   */
  #redeliveredLiveHeadline(records: readonly PendingInboxEvent[], alone: boolean): string {
    if (records.length === 1) {
      const record = records[0];
      if (record === undefined) return '';
      return (
        `未読のまま残っていた合図を配り直した（${record.deliveries}回目の配達` +
        (alone
          ? ''
          : `＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が ${this.#restoredCohort} 件あり、` +
            `配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない`) +
        `、${record.at} に受け取ったもの）: ${inboxEventShape(record.event)}`
      );
    }

    const details = records
      .map(
        (record, index) =>
          `[${index + 1}] ${record.deliveries}回目の配達、${record.at} に受け取ったもの: ` +
          inboxEventShape(record.event),
      )
      .join('\n');
    return (
      `未読のまま残っていた合図を配り直した（まとめて${records.length}件。回数はいずれも` +
      `器が入れ替わった回数——同じ起動で一緒に拾い直した未読が ${this.#restoredCohort} 件あり、` +
      `配達回数は残っている未読の全行で一緒に進む — それぞれの合図の処理が落ちた回数ではない）:\n` +
      details
    );
  }

  /**
   * 配り直しの断り書き。**束（`batch`）のうち1件も配り直しでなければ空文字。**
   *
   * **「二度届く」ことは受け入れるが、「二度目だと分からない」ことは受け入れない。**
   * 分からなければクローンは同じ報告に二度応答し、そのターンが丸ごと無駄になる
   * （消費にも直結する）。ここが、消し込みを「終えた時点」に置いた取引の対価である。
   *
   * **`batch.length === 1` は、以前の1件専用の実装を1文字も変えない**（issue
   * #783）。いちばん多い経路（単発）の出力を変えないため、かつ既存の歯
   * （`clone-*.test.ts`（旧 `clone.test.ts`。#1744 で分割済み）/ `inbox-persistence.test.ts` の逐語一致）を壊さないため
   * である。
   *
   * **`batch.length >= 2` で印付きが1件以上あるときだけ束の行にする。** 1件
   * ごとに断り書きを繰り返さない —— `#mergedManagerReportBatch` が同じ
   * `managerId` の配り直しを大量に束ねられるようになった以上（issue #783、
   * `#mergeable` の doc）、N 件を1件ずつの断り書きで並べると、断り書きの分量が
   * 本文そのものを埋める。代わりに次の3つを必ず持たせる —— **(1) 件数**（束が
   * 何件で、うち配り直しが何件か） **(2) 配達回数の最大値** **(3) いちばん
   * 古いものの時刻**（印付きのうち最も古い `at`）。どれも「判定の根拠にならなく
   * なった情報」ではない —— 1件ごとに繰り返すのをやめるだけで、1つも消していない。
   *
   * **束が2件以上ある時点で「1件だけが拾い直された（`alone`）」側は出さない。**
   * `alone` が言えるのは束の中の印付きが1件のときだけで、束に2件以上の印付きが
   * 在れば、それらは同じ `#restoreUnread` の呼び出しで一緒に拾い直された仲間が
   * 2件以上いたことの直接の証拠になる（＝ `#restoredCohort` は最低でもその件数
   * ぶんある）。**印付きが1件しかない束**（印付き1件＋新規の合図が隣接して
   * 束ねられた場合）も、安全側（`alone` ではない側 = 「この回数をこの合図の
   * せいにしない」という、より慎重な言い方）へ倒す —— どちらの言い方でも
   * 情報は減らない。
   */
  #redeliveryNoticeFor(batch: readonly InboxEvent[]): string {
    if (batch.length === 1) {
      const event = batch[0];
      if (event === undefined) return '';
      const record = this.#delivery.redeliveryState.get(event.id);
      if (record === undefined) return '';

      // **同時に拾い直した件数で名乗り分ける**（`#restoredCohort` の doc）。
      // 1件だけなら、器が入れ替わった時点で受信箱に在った未読はこの合図なので、
      // 回数はこの合図について語れる。2件以上なら語れない — **居合わせただけの
      // 合図も同じだけ増えている**ので、回数から原因は1文字も読めない。
      const alone = this.#restoredCohort <= 1;
      return [
        `[system] **これは配り直しである（${record.deliveries} 回目の配達）。**` +
          `${record.at} に受け取ったまま、処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。`,
        '同じ内容に既に応答しているかもしれない。日誌（`journal_read`）と `manager_list` を見て、' +
          '同じ仕事を二度起こさないこと。',
        ...(alone
          ? record.deliveries >= 2
            ? [
                '**2 回以上配り直している。** 器が入れ替わった時点で受信箱に在った未読はこの1件' +
                  'だけだった ⟹ この合図の処理そのものが落ちている可能性がある。' +
                  '同じやり方をもう一度なぞる前に、なぜ落ちたかを先に見ること。',
              ]
            : []
          : [
              `**この回数は「器が入れ替わった回数」であって、この合図の処理が落ちた回数ではない。**` +
                `同じ起動で一緒に拾い直した未読が ${this.#restoredCohort} 件あり、この合図は` +
                'そのうちの1件である（配達回数は残っている未読の**全行**で一緒に進む）。' +
                '**まだ一度も処理されていない可能性がある** — この回数を「この合図で落ちた」' +
                'の根拠にしないこと。',
            ]),
        '',
        '---',
        '',
      ].join('\n');
    }

    // **束の行。** 印が付いた（配り直しの）ものだけを集める——1件も無ければ
    // 空文字（初回配達だけの束）。
    const records: PendingInboxEvent[] = [];
    for (const event of batch) {
      const record = this.#delivery.redeliveryState.get(event.id);
      if (record !== undefined) records.push(record);
    }
    if (records.length === 0) return '';

    const maxDeliveries = Math.max(...records.map((record) => record.deliveries));
    // `at` は ISO 8601 なので文字列としての昇順が時刻の昇順と一致する。
    const oldestAt = records.map((record) => record.at).sort()[0];

    return [
      `[system] **これは配り直しの束である（束 ${batch.length} 件のうち ${records.length} 件が` +
        `配り直し、最大 ${maxDeliveries} 回の配達、最も古いものは ${oldestAt} に受け取った）。**` +
        '処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。',
      '同じ内容に既に応答しているかもしれない。日誌（`journal_read`）と `manager_list` を見て、' +
        '同じ仕事を二度起こさないこと。',
      `**この回数は「器が入れ替わった回数」であって、この合図の処理が落ちた回数ではない。**` +
        `同じ起動で一緒に拾い直した未読が ${this.#restoredCohort} 件あり、この合図は` +
        'そのうちの1件である（配達回数は残っている未読の**全行**で一緒に進む）。' +
        '**まだ一度も処理されていない可能性がある** — この回数を「この合図で落ちた」' +
        'の根拠にしないこと。',
      '',
      '---',
      '',
    ].join('\n');
  }

  /**
   * 片付け済みの配り直しかどうかを、**畳んだ跡へ写す断り書き**の形で答える。
   * 片付いていなければ `null`（呼び出し側は通常経路＝全文でターンを回す）。
   *
   * **非 `null` が「ターンを起こさない」の判定そのものである**（`#pump`）。
   * かつてはこの戻り値を本文の代わりにモデルへ渡していた（issue #217）が、いまは
   * `#foldClosedRedelivery` が日誌へ写すだけで、モデルへは渡らない。
   *
   * **`#redeliveryNoticeFor` とは別物。** あちらは全ての配り直しに付く定型の
   * 1文で、本文も変えないしターンも回る。こちらは「片付け済み」の配り直しにだけ
   * 掛かり、ターンそのものを起こさない（`closedRedeliveryNotice`）。
   *
   * **判定は `#restoreUnread` が済ませてある。** ここでは `stores.commitments`
   * を引き直さない — 引き直すと「配り直した後、この合図が受信箱から取り出される
   * までの間にクローン自身がこの合図を閉じた」ような場合にも畳みが掛かってしまい、
   * 「配り直した時点では未了だった」という事実が消える。
   */
  #closedRedeliveryNoticeFor(event: InboxEvent): string | null {
    const commitment = this.#delivery.redeliveryState.getClosed(event.id);
    if (commitment === undefined) return null;
    return closedRedeliveryNotice(event, commitment);
  }

  /**
   * ターンの失敗を必ずどこかに残す。
   *
   * 人間が繋がっていれば chat へも流れるが、**流せたことを記録の代わりにしない。**
   * `#emit` はその会話の購読者が居なければ何もしないので、chat へ流すだけで
   * 済ませると「人間が発言 → chat を閉じる／切断 → そのターンが例外で失敗」が
   * どこにも残らない。内部ターン（マネージャーからの確認・蒸留・自律）には
   * そもそも聞き手が居ないので、握り潰せば「クローンが黙り、マネージャーが
   * 永久に返事を待つ」が無記録で起きる。**どちらの向きも日誌で受ける。**
   *
   * これは消し込みの前提でもある。受信箱のループは例外で終わった合図も
   * `#forget` するが（`#pump` の `finally`）、その根拠は「失敗が記録されて
   * いる」ことである。人間の発言だけがその根拠を欠いていた。
   *
   * **なぜ日誌か（`Clone#post` の #57 とは選択が違う）。** あちらは同期で
   * 返り値を持たず、日誌へ書けば fire-and-forget ＝跡が残る前にプロセスが
   * 消える窓そのものへ賭けることになるので stderr にした。ここは `async` で、
   * **呼び出し側が全経路で `await` している**（`#pump` の catch / `#runTurn` /
   * 読み取りループの finally）。しかも `#forget` はこの `await` が返った後の
   * `finally` で走るので、書き終える前に落ちれば合図は未読のまま残って配り
   * 直される。跡を残す窓と競合しない以上、stderr へ落とす理由が無い。
   *
   * **本文（`message`）を stderr へは出さない。** 例外で来る呼び出し側3か所は
   * `{ error }` で渡し、外へ出す文は `reasonOf` を通す（#2483。分類だけが
   * 生の `String(error)` を見る）。**いま辿れる範囲に、人間の発言そのものを
   * 載せて戻ってくる経路は無い**（発言を束縛して書くのは `#handle` の
   * `#journal` だが、あれは自分で握って `noteDroppedRecord` へ落とすので
   * ここまで投げてこない）。だが `message` は SDK・API・ストアのドライバが
   * 決める文字列であって**こちらが値を決めていない** — `journalEntryShape` の
   * 判定基準（「自由文かどうか」ではなく「値を誰が決めるか」）では出せない側で
   * ある。日誌は持ち主しか読まないが stderr は器の外へ出ていく
   * （`noteDroppedRecord` の doc）。書けなかったときの跡は `#journal` が
   * `journalEntryShape` ＝長さだけに畳んで `noteDroppedRecord` へ落とす。
   * **ここに素の `String(error)` を1行も足さないこと。**
   *
   * ## 失敗の記録は `with: 'self'` へ置く（#92）
   *
   * 直す前は、会話のある失敗を `with: 'human'` / `role: 'outbound'` で書いていた。
   * `GET /conversations/:id` は `with === 'human'` だけで絞って `role` をそのまま
   * 返すので、**失敗の記録が「クローンの返信」として会話に並んでいた** — 人間が
   * 見たのがこれである（利用上限に当たった状態で話しかけると、SDK の英語の文言
   * だけが返信として出る）。`message` の中身は SDK・API・ストアのドライバが決める
   * 文字列で、**人間へ向けた発言ではない。**
   *
   * だから記録は `self`（人間に見せない側）へ移す。**`conversationId` は落とさない**
   * ので、どの会話の失敗かは日誌の列でそのまま辿れる（#56 の線）。#89 が塞いだ
   * 「失敗がどこにも残らない」は記録が残ることで満たされていて、**どの `with` で
   * 残すかとは無関係である**（`with` を変えても、テキストの前置きは変えていない —
   * 既存の回帰テストが見ているのはそこである）。
   *
   * ## 代わりに、人間には人間の言葉で1行返す
   *
   * `self` へ移しただけだと、会話の画面を後から開いた人間には**自分の発言だけが
   * あって返信が無い**状態になる。沈黙は「まだ考えている」と見分けられないので、
   * 生の文言を含まない1行を `with: 'human'` で残す。**枠（利用上限）で保持して
   * いる場合はそう言う** — 人間の要望は「あとで良いのでちゃんと返信してほしい」で
   * あって待つこと自体は受け入れられている。待てば返るのか、もう返らないのかが
   * 会話から読めなければ、その要望は満たせない。
   *
   * ## ただし、同じ1行を二度書かない
   *
   * その1行は**繰り返す**（枠が閉じている間、保持した発言は新しい合図が届くたびに
   * 試し直され、毎回同じ理由で落ちる）。畳まないと会話がこの1行だけで埋まり、
   * **人間が何もしていないのに増え続ける**（人間の報告「定期的に積み上がり続ける」）。
   * ⟹ 会話ごとに最後に返した1行を覚えて、文字列が同じなら日誌の `self` 側へ畳む
   * （`#notices` の `foldHumanFailure`。doc は `clone-notices.ts` の
   * `CloneNotices` の `#humanFailure`）。**人間から新しい発言が来れば `post()`
   * が記憶を落とす**ので、発言1件につき1行は必ず返る。
   */
  async #reportFailure(
    conversationId: string | null,
    cause: string | { readonly error: unknown },
  ): Promise<void> {
    // **例外で来た失敗は、分類を生の文字列で先に行い、外へ出す文だけを `reasonOf`
    // （伏せ字 → 1行目 → 200字）にする（#2483）。** `classifyContextWindowFailure` は
    // 部分文字列で判定し、`prompt is too long` 等が2行目以降に在る形もある——
    // 入口で1行目へ畳むと判定が壊れる。一方、`emit`・日誌・`failure`
    // （`TurnOutcome.reason` → 日報などの `reason`）に載る文は、drizzle の
    // `params:`（2行目）のように値を運びうる。⟹ 分類だけが生の文字列を見る。
    // 文字列で来たもの（こちらが書いた固定文・SDK の `result` の文言）は今までどおり。
    const rawMessage = typeof cause === 'string' ? cause : String(cause.error);
    const message = typeof cause === 'string' ? cause : reasonOf(cause.error);
    // **走っているターンに失敗の印を残す。** `#runTurn` の戻り値をこれで分岐させる
    // （`TurnOutcome`）。ここに置いてあるのは、失敗を畳む経路が4つある（セッションの
    // 起動失敗 / 読み取りループの例外 / 失敗した `result` / `#handle` の例外）ため —
    // 呼び出し側ごとに印を立てると、経路が増えたときに**印の無い失敗**が静かに
    // 混ざり、それは「成功して空文字を返した」と区別できない。
    //
    // **`#finishTurn()` より必ず先に呼ばれる**（全4経路でこの順序）。逆にすると
    // `this.#turn` は既に `null` で、印はどこにも残らない。
    const running = this.#sdkSession.turn;
    if (running !== null) running.failure = message;

    // 繋がっている人間には即座に見せる。日誌より先なのは、書き込みを待たせて
    // 「反応が無い」時間を伸ばさないため。届かなくても下の記録が残る。
    this.#emit(conversationId, { type: 'error', message });

    // `conversationId` は呼び出し側が構造化フィールドとして持っている値なので
    // 載せる（#56 の線）。落とすと、失敗がどの会話のものだったかを時刻でしか
    // 突き合わせられなくなる — 日誌には列があるのに。
    //
    // **文脈窓（コンテキストウィンドウ）を超えた失敗だけ、末尾に目印を足す**
    // （Issue #318 P4）。先頭（`内部ターンが失敗した:` / `人間との対話ターンが
    // 失敗した:`）は変えない — 変えると `clone-turn-failure-trace.test.ts`
    // （旧 `clone.test.ts`。#1744 で分割済み）の
    // `text.startsWith(...)` の歯を壊す。生の `message` は既に逐語で載って
    // いるので、目印はその後ろに足すだけでよい（判定・弱さの断り書きは
    // `context-window-failure.ts` の doc）。
    const contextWindowFailure = classifyContextWindowFailure(rawMessage);
    // **長さで落ちたなら、次の境界でセッションを畳んで作り直す**（#553。人間の依頼
    // 「今後発生した際に落ちないように対策」）。**判定はここでしかしない** ——
    // `classifyContextWindowFailure` の呼び出しはこの1か所だけで、`#apply` 側で
    // もう一度分類すると判定が2本に割れる。
    const foldingForContextWindow = await this.#noteContextWindowFold(
      contextWindowFailure,
      conversationId,
    );
    // **枠に当たり続けたことによる畳み（`#noteUnproductiveUsageBlockFold`）は、
    // このターンの `result` より前（`#apply` の `usage_notice` 処理。
    // `#noteUsageNotice` の doc）で既に判定・実行済みである。** ここで
    // 新しく判定を走らせるのではなく、**既に立っている印を読むだけ**にする
    // （二重に畳まない——`#noteContextWindowFold` が既に「文脈窓」側の理由で
    // 畳んでいれば `foldingForContextWindow` を優先し、そうでなければ
    // `#recycleForContextWindow` の現在値を読む）。Issue #1240。
    const foldingForUnproductiveUsage: 'no' | 'folding' =
      foldingForContextWindow === 'no' &&
      this.#usageBlocked !== null &&
      this.#sdkSession.wantsContextWindowRecycle
        ? 'folding'
        : 'no';
    const failureText =
      conversationId === null
        ? `内部ターンが失敗した: ${message}`
        : `人間との対話ターンが失敗した: ${message}`;
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: `${EXCHANGE_KIND_FAILURE_PREFIX}${
        contextWindowFailure === undefined
          ? failureText
          : `${failureText}${describeContextWindowFailure(contextWindowFailure)}`
      }`,
      ...(conversationId === null ? {} : { conversationId }),
    });

    if (conversationId === null) return;

    // **枠で保持しているかは `#usageBlocked` を見て決める。** ここへ来る前に
    // `#noteUsageNotice` が立てている（枠を検知する3経路はいずれもこの
    // `#reportFailure` より先に `await` してある。`#pump` の枠チェックの分岐は
    // 既に立っているものを読んでいる）ので、文言の分岐をこの1か所に置ける —
    // 呼び出し側ごとに書き分けると、経路が増えたときに「枠なのに枠と言わない」
    // 失敗が静かに混ざる。
    //
    // **⚠️ 枠と長さは同時に真になりうる。そのとき保持だけを言うと、守れない約束に
    // なる。** 実機の文言には2つの群があり、片方はこう来る（依頼元の実測、
    // 2026-08-29〜31 の24件のうち9件）:
    //
    // ```
    // Prompt is too long · automatic compaction failed: You've hit your or…
    // ```
    //
    // これは CLI が**合成した1本の文字列**である。**同梱の `claude` バイナリに、
    // 見出しの定数と `automatic compaction failed: ` を挟む合成の両方が実在する。**
    // 初出の実測は `0.3.251` だが、**版番号もミニファイ後の関数名も錨にしない**
    // ——どちらも版ごとに変わるので、錨にすると「静かに何も返さないコマンド」に
    // なる（この判断の理由と `$F` の出し方は `context-window-failure.ts` の
    // 「既知の文言はどこから来たか」の節に在る）。下は同梱の `0.3.261` で
    // 確かめた（2026-09-06）:
    //
    // ```sh
    // command grep -a -o -E '[A-Za-z_$]+="Prompt is too long"|return`\$\{[A-Za-z_$]+\} \\xB7 automatic compaction failed: `' "$F"
    // ```
    //
    // 出力（`\xB7` は `·`。**2行が合わさって、上の1本の文字列になる**。⚠️ 何も
    // 返らなければ「確かめ損ねた」ではなく「この合成が無くなった」である）:
    //
    // ```js
    // gC="Prompt is too long"
    // return`${gC} \xB7 automatic compaction failed: `
    // ```
    //
    // **⟹ マーカーの後ろに在るのはこのターンの失敗ではなく、「compaction という
    // 別の呼び出しがなぜ失敗したか」である。**
    //
    // `classifyUsageNotice` はこれを `reached` に分類する（`usage-limits.ts` の
    // `longestMatchingPrefix` が `includes` を持つので、文字列のどこに
    // `You've hit your` が在っても当たる）。**それは誤分類ではない** —— compaction は
    // 本物の枠に当たっていて、枠は実際に閉じている。**⟹ 保持は正しい。やめれば
    // 閉じた枠を叩き続けることになる。**
    //
    // **⟹ だから直すのは保持ではなく、この文言だけである。** 「枠が開いたら試し直して
    // 返信する」だけを言うと、原因が長さでもある回に**守れない約束**をする —— 枠が
    // 開いた瞬間に、同じ長さで同じところへ落ちる。**⟹ どちらかへ倒さず、両方言う。**
    //
    // **⛔ ここへ ASCII の目印（`context_window_failure`）と生の文言は持ち込まない。**
    // あれは日誌の側（`with: 'self'`）の道具であり、`clone-turn-failure-trace.test.ts`
    // （旧 `clone.test.ts`。#1744 で分割済み）の
    // 「人間へ返す1行」の歯がその線を測っている。ここで足すのは日本語の断り1文だけ
    // である（{@link CONTEXT_WINDOW_ALSO_NOTICE}）。
    //
    // **⚠️ 枠で保持していない側（`#usageBlocked === null`）は1文字も変えていない。**
    // 実測ではそちらのほうが多い（24件中15件）が、依頼元の判定が「2×2 の右下1マス
    // だけ」であり、そこは範囲の外である。**⟹ 「長さで落ちる回は全部直った」と
    // 読まないこと。**
    // 画面が「失敗の知らせ」と見分けるための印（`turnFailure` の doc）。文面は見ない。
    const turnFailure = this.#usageBlocked === null ? ('failed' as const) : ('held' as const);
    const humanText =
      (this.#usageBlocked === null
        ? 'この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。'
        : 'いま利用上限に当たっているので、この発言にはまだ返せない。' +
          '発言は捨てずに保持していて、枠が開いたら試し直して返信する。' +
          (contextWindowFailure === undefined ? '' : CONTEXT_WINDOW_ALSO_NOTICE)) +
      // **畳むかどうかは、枠の有無と独立である。⟹ 3軸目として1文足すだけにする**
      // （2×2 の4マスをそれぞれ書き分けると、同じ内容を4回持つことになる）。
      // **`foldingForContextWindow`（文脈窓）と `foldingForUnproductiveUsage`
      // （枠に当たり続けた）は同時には'folding'にならない**——後者は前者が
      // `'no'` のときにしか評価しない（`folding` の doc）ので、文言も
      // どちらか一方だけが選ばれる。
      (foldingForContextWindow === 'folding'
        ? CONTEXT_WINDOW_FOLD_NOTICE
        : foldingForContextWindow === 'held'
          ? CONTEXT_WINDOW_FOLD_HELD_NOTICE
          : foldingForUnproductiveUsage === 'folding'
            ? UNPRODUCTIVE_USAGE_BLOCK_FOLD_NOTICE
            : '');

    // **同じ会話へ、同じ1行を二度書かない**（`#notices` の `foldHumanFailure`。
    // doc は `clone-notices.ts` の `CloneNotices` の `#humanFailure`。人間の
    // 報告「定期的に積み上がり続ける」）。枠が閉じている間、保持した発言は新しい
    // 合図が届くたびに試し直され、そのたびに同じ理由で落ちる ⟹ 畳まないと会話が
    // この1行で埋まる。**人間から新しい発言が来れば `post()` が記憶を落とす**ので、
    // 発言1件につき1行は必ず返る。
    const folded = this.#notices.foldHumanFailure(conversationId, humanText);
    if (folded !== null) {
      // **畳んだ回は1件ずつ残す。** 「畳んだ」だけでは何件ぶんが人間へ返らなかった
      // のかを後から数えられない（`#notices` の `noteUsage` と同じ形）。
      // 本文も残す — 記録の側では1文字も失っていない。
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_THINNING_PREFIX}人間へ返す1行は畳んだ（最後に返した1行から数えて ${folded} 件目）。同じ1行を` +
          `既に返してあり、そのあと人間からの新しい発言は届いていない: ${humanText}`,
        conversationId,
      });
      return;
    }

    await this.#journal({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: humanText,
      conversationId,
      turnFailure,
    });
  }

  /**
   * フックの入力から生ログの在り処を控える（`#transcriptPath`）。
   *
   * **`unknown` から入る値なので、形が読めなければ控えを触らない。** 上書きして
   * `null` に戻すと、既に控えてあった正しい在り処を捨てることになる。
   */
  #noteTranscriptPath(path: string | undefined): void {
    if (typeof path === 'string' && path.length > 0) this.#distillMemory.setTranscriptPath(path);
  }

  /**
   * 文脈窓（プロンプトの長さ）で落ちたときに、**セッションを畳んで作り直すかを
   * 決めて印を立てる**（#553。人間の依頼「今後発生した際に落ちないように対策」）。
   *
   * 戻り値は人間へ返す1行の分岐にそのまま使う:
   *
   * | 戻り値 | 意味 |
   * | --- | --- |
   * | `'no'` | 長さの失敗ではない（あるいはセッションが無い）。何もしない |
   * | `'folding'` | 次の境界で畳む。印を立て、resume 素材を捨てた |
   * | `'held'` | 長さの失敗だが、**畳んでも直らないので畳まない** |
   *
   * ## なぜ「畳んでも直らない」枝が要るのか（暴走の止め）
   *
   * **会話を引き継がずに開いたセッションが、1度も答えを返せずに長さで落ちたなら、
   * もう一度開き直しても材料は同じである。⟹ 落ちる → 畳む → 開く → 落ちる を
   * 延々繰り返し、そのたびに子プロセスを起こす。⟹ しかも枠が閉じているときほど
   * 激しく回る**（＝いちばん壊れてほしくない状況で最も回る）。
   *
   * **⚠️ これは「ターン数上限で暴走を止める」（AGENTS.md の地雷）ではない。**
   * あれが防いでいるのは**仕事そのものを止めること**である。ここで止まるのは
   * **畳み直しだけ**で、ターンは回り続ける。そして**抑止しなくても落ち続ける**
   * （同じ材料でもう一度開くだけ）ので、**抑止して悪くなるものが1つも無い。**
   *
   * ## ⚠️ `held` は1回きり（issue #955 の (A)。2026-09-25 のクローン teto の判断）
   *
   * 「材料は同じ」は、**拒まれた入力がセッションに残らない**ときにしか成り立たない。
   * 残るなら、`held` した同じセッションへ次の入力（どれだけ小さくても）を入れると
   * 履歴ごと送り直して同じ長さで落ち、合図のたびに `held` し直して**自力では抜け
   * られない**（器の再起動か鍵の回転で resume されるまで止まる）。本物の CLI が
   * どちらかは確かめていない。
   *
   * ⟹ **同じセッションで、別の入力でもう一度長さの失敗が起きたら、そこで畳む**
   * （`#heldInSession`）。残らないなら2回目の失敗は起きないので何も変わらず、
   * 残るなら機械だけで抜けられる——どちらでも今より悪くならない。
   *
   * **代償**: システムプロンプトや焼き込みそのものが収まらないときは、開き直した
   * セッションもまた落ちるので、合図のたびに `held` と畳み直しが交互に起きる。
   * 周期は合図の到着で決まり（タイマーは無い）、枠が閉じている間は `#usageBlocked`
   * の保持でターン自体が立たない。**黙って回さない**——畳み直すたびに日誌へ1行
   * （連続回数つき。2回以上なら「収まっていない可能性」を名乗る）と、人間の会話へ
   * 1行を残す（`#noteHeldEscalation`）。
   *
   * ## ⚠️ 「材料は同じ」が指す中身（issue #955）
   *
   * **新しいセッションの最初のターンに載りうるものは、次の3種類だけである。**
   * このうちどれが原因かで、開き直した先が「同じ材料」になるかどうかが変わる。
   *
   * 1. **システムプロンプト**（`buildCloneSessionOptions` 等が焼く固定文）——
   *    セッションを開き直しても内容は変わらない。**常に同じ材料。**
   * 2. **記憶の焼き込み**（セッション開始時に注入される目次・premise 等）——
   *    件数・文字数の両方に予算が掛かっている（`memory.ts` の
   *    `MEMORY_TOC_ENTRY_LIMIT` / `MEMORY_TOC_CHAR_BUDGET`）が、記憶そのものが
   *    育てば開き直しの間にも伸びうる。**開き直した瞬間だけを見れば、ほぼ同じ材料。**
   * 3. **このターンを起こした合図の本文**——ここが唯一、合図の種類によって
   *    答えが変わる:
   *    - **マネージャーの報告**（束の `managerReportBatchPrompt` と単発の
   *      `managerPrompt`）は、#955 で本文に文字数の予算を掛けた
   *      （`MANAGER_REPORT_BATCH_BODY_BUDGET`。束は合計、単発は1件ぶん）。
   *      **⟹ これが原因だった回は、開き直せば本文が縮んで収まる可能性がある——
   *      「材料は同じ」ではなくなった。**
   *    - **外部イベントの束**（`externalBatchPrompt`）は、#955 で調べたが
   *      変更していない——本文（`renderPayload`）には元から
   *      `EXTERNAL_PAYLOAD_LIMIT`（8,000文字）の上限が掛かっており、
   *      この軸では最初から「材料は同じ」ではなかった（詳細は
   *      `externalBatchPrompt` の doc）。
   *    - **人間の発言**（`humanTurnText`）には、この直しでも上限を掛けていない
   *      （意図的——人間の言葉を機械が黙って切ると north_star 禁止1「人間に
   *      できることがこの層でできないならバグ」に当たる。人間は Web UI で
   *      全文を送っているのに、クローンだけが黙って切られた版を受け取る形に
   *      なるため）。**⟹ 巨大な人間の発言が原因の回は、いまも「材料は同じ」
   *      のままである。**
   *
   * **⟹ この関数の判定条件（`#resumedFrom === null && !#sessionAnswered`）は
   * 1文字も変えていない。** 原因の内訳が変わっただけで、「畳んでも直らない
   * ケースが在る」という結論そのものは変わらない——2 と 3-人間発言 が残る限り、
   * この枝は引き続き要る。
   *
   * ## `setCloneSessionId(null)` は畳んだ後ではなく**印と同時に**打つ
   *
   * 畳む前にプロセスが死ぬ窓が在る。そこで打っていなければ、**長すぎるセッション
   * id が残り、次の起動が resume して同じところで落ちる ＝ 直そうとしていた形へ
   * 戻る。** 先に打っておけば、その窓で死んでも「resume せずに開く」＝意図した
   * 結果そのものになる。
   *
   * ## 投げない
   *
   * ここで投げると、失敗の報告そのものが失敗する（`#reportFailure` の途中である）。
   * **id を捨てられなかったことは記録に残すが、報告は続ける** ——
   * `noteDroppedRecord` は `#observeForTokenRotation` が同じ場面で採っている形。
   */
  async #noteContextWindowFold(
    failure: ContextWindowFailure | undefined,
    /** 落ちたターンの人間の会話（内部のターンなら `null`）。{@link Clone.#noteHeldEscalation} へ渡す。 */
    conversationId: string | null,
  ): Promise<'no' | 'folding' | 'held'> {
    if (failure === undefined) return 'no';
    // **セッションが無ければ畳むものが無い**（`recycleSessionForToken` の同じ門）。
    if (this.#sdkSession.query === null) return 'no';
    // 暴走の止め（上の doc）。**ただし1回きり**（issue #955 の (A)。下の doc）。
    const escalatedFromHeld = this.#sdkSession.resumedFrom === null && !this.#sessionAnswered;
    if (escalatedFromHeld && !this.#heldInSession) {
      this.#heldInSession = true;
      return 'held';
    }

    this.#sdkSession.armContextWindowRecycle();
    // **クローン自身への断りも同時に立てる**（`#contextWindowFoldNoticePending`）。
    this.#distillMemory.armContextWindowFoldNotice();
    try {
      await this.#stores.sessions.setCloneSessionId(null);
    } catch (error) {
      noteDroppedRecord('resume 素材の破棄', 'clone', error);
    }
    if (escalatedFromHeld) await this.#noteHeldEscalation(conversationId);
    return 'folding';
  }

  /**
   * `held` の後に畳み直したことを、日誌と人間の会話へ1行ずつ残す（issue #955 の
   * (A)。人間の依頼の条件1・2）。**投げない**（`#reportFailure` の途中である）。
   *
   * - **日誌**: 判断の1行。答えを返せないまま畳み直した回数（`#heldEscalationStreak`）
   *   を必ず載せ、2回以上続いたら「システムプロンプトや焼き込みそのものが収まって
   *   いない可能性」を名乗る（`held` と畳みの交互の印）。
   * - **人間の会話**: 失敗したのが人間の発言のターンなら、`#reportFailure` が返す
   *   1行に `CONTEXT_WINDOW_FOLD_NOTICE` が既に載る（`'folding'` と同じ扱い）ので
   *   ここでは書かない。**内部のターン（tick・外部イベント・マネージャーの報告）で
   *   落ちた回は、人間へ何も届かない**——そこで、日誌に在る直近の人間とのやりとりの
   *   会話へ1行を書く。会話が1つも無ければ書かない（書く先が無い）。
   */
  async #noteHeldEscalation(conversationId: string | null): Promise<void> {
    this.#heldEscalationStreak += 1;
    const streak = this.#heldEscalationStreak;
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_DECISION_PREFIX}会話を引き継がずに開いたこのセッションは、1度も答えを返せないまま、` +
        '1回目の長さの失敗では開き直さずに持ちこたえた（held）が、別の入力でもう一度同じ長さで落ちた。' +
        '⟹ 拒まれた入力がセッションに残って送り直されている可能性があるので、ここで畳んで新しい' +
        `セッションで開き直す（issue #955。答えを返せないままの畳み直しは連続 ${String(streak)} 回目）。` +
        (streak >= 2
          ? ' ⚠ 開き直した新しいセッションも、1度も答えないまま同じ形で落ちている。' +
            'システムプロンプトや記憶の焼き込みそのものが文脈窓に収まっていない可能性がある' +
            '（held と畳み直しの交互）。'
          : ''),
    });
    if (conversationId !== null) return;
    try {
      // **会話の窓は `readConversationWindow` でだけ組む**（issue #418 の再発防止。
      // `scripts/conversation-window-single-source.test.ts`）。直近の1件だけを見る。
      const recent = await readConversationWindow(this.#stores.journal, { scan: 1 });
      const last = recent[0] as { conversationId?: string } | undefined;
      if (last?.conversationId === undefined) return;
      await this.#journal({
        type: 'exchange',
        with: 'human',
        role: 'outbound',
        text:
          '文脈が収まらずに走れなくなっていたので、この会話はここで一区切りにして、新しいセッションで' +
          '開き直した。それまでのやりとりは消えていない（記録は残っている）。',
        conversationId: last.conversationId,
      });
    } catch (error) {
      noteDroppedRecord('畳み直しを人間へ知らせる1行', 'clone', error);
    }
  }

  /**
   * 枠（利用上限）に当たり続けて1度も成功しないまま、セッションの持ち越しが
   * 積み重なっているかを判定し、達していれば文脈窓のときと同じ手当てで畳む
   * （`#usageBlockedAccumulatedChars` の doc。Issue #1240）。
   *
   * ## `#noteContextWindowFold` と何が違うか
   *
   * あちらは**文脈窓を超えたという実測**（`classifyContextWindowFailure`）を
   * 待って畳む。**枠に当たり続ける回では、その実測がそもそも起きないことが
   * ある**——compaction 自体が API 呼び出しなので、枠が閉じている間は
   * 「長すぎる」と教えてくれる合成メッセージを生成する処理自体が429で落ちる。
   * ⟹ 実測を待つと、実測が来ないまま積み上がり続ける。ここは実測の代わりに
   * **`#usageBlockedAccumulatedChars`（1度も成功しないまま `#pushInput` へ
   * 積んだ文字数の合計）**を見て、実測より先に畳む。
   *
   * ## 呼び出しは `#noteUsageNotice` の `reached` 枝からだけ
   *
   * `#usageBlocked` が新しく立った（＝そのターンが `reached` で終わった）
   * 直後に呼ぶ。**枠が閉じている間の短絡（`#pump` の枠チェック）はここを
   * 通らない**——短絡はモデルを呼んでいないので、持ち越しは1文字も増えて
   * いない（増えていないものを畳んでも意味が無い）。
   *
   * ## 畳んだ後の印は使い回す
   *
   * `#recycleForContextWindow` / `#contextWindowFoldNoticePending` は
   * `#noteContextWindowFold` と同じ実体をそのまま立てる——**理由が違っても
   * 結末（次の境界で resume せずに開き直す。会話の記録は消えない）は同じ**
   * なので、系統を2つに増やさない（`#recycleForContextWindow` の doc「印を
   * 2つに分けているのは、トークンを回すだけで会話が切れないようにするため」
   * と同じ考え方——ここは逆に、結末が同じものを1つの印に相乗りさせている）。
   */
  async #noteUnproductiveUsageBlockFold(): Promise<'no' | 'folding'> {
    // **セッションが無ければ畳むものが無い**（`#noteContextWindowFold` と同じ門）。
    if (this.#sdkSession.query === null) return 'no';
    if (this.#usageBlockedAccumulatedChars < UNPRODUCTIVE_USAGE_BLOCK_FOLD_CHAR_THRESHOLD) {
      return 'no';
    }

    this.#sdkSession.armContextWindowRecycle();
    this.#distillMemory.armContextWindowFoldNotice();
    try {
      await this.#stores.sessions.setCloneSessionId(null);
    } catch (error) {
      noteDroppedRecord('resume 素材の破棄', 'clone', error);
    }
    // **`#noteContextWindowFold` と同じ理由で日誌にも残す**（跡が無いと
    // 「なぜか会話が切れた」としか見えない）。ここは `#reportFailure` の
    // 外なので自分で書く——あちらの `failureText` の組み立てには乗らない。
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_DECISION_PREFIX}枠に当たったまま1度も答えを返せないうちに、積んだ入力が ` +
        `${String(this.#usageBlockedAccumulatedChars)} 文字（閾値 ` +
        `${String(UNPRODUCTIVE_USAGE_BLOCK_FOLD_CHAR_THRESHOLD)}）に達した。同じ` +
        'セッションへ積み続けると枠が開いた頃には文脈が伸びきっているので、' +
        'ここでセッションを畳んで作り直す（Issue #1240）。',
    });
    return 'folding';
  }

  /**
   * 畳む直前に、生ログを**器の外へ出す**（#553 / #564）。
   *
   * ## ⚠️ 2段に割ってある。片方は枠が閉じていても通る
   *
   * | 段 | モデルを呼ぶか | 枠が閉じている回で通るか |
   * | --- | --- | --- |
   * | (i) 退避（`archive`） | **呼ばない** | **通る** |
   * | (ii) 蒸留（`#distillFromTranscript`） | 呼ぶ | **通らない** |
   *
   * **実測では、長さで落ちた24件のうち9件が「枠も同時に閉じている」形だった**
   * （#553）。**⟹ その9件では (ii) は原理的に走れない。** だから (i) を先に、
   * 独立した `try` で通す —— **同じ `try` に入れると、通るはずの (i) が (ii) の
   * 失敗に巻き込まれる。**
   *
   * ## ⚠️ (i) が落ちることも在る。そのときは黙らない
   *
   * `archive` はストアへの書き込みなので、ストアが閉じていれば落ちる（長い生ログを
   * 1本で受け切れるかも測っていない）。**⟹ 落ちたら日誌へ残す。**「残っているはず」と
   * 読まれるのを防ぐためで、**黙って落とすと、直そうとしている形（守れない約束）と
   * 同じになる。**
   *
   * **そして (i) が落ちても (ii) へ進む。** (i) は全文を1本の文字列にするので、生ログが
   * 伸びると `ERR_STRING_TOO_LONG` で落ちる側である（`readTranscriptTail` の doc）。
   * **そこで止めると、いちばん失いたくないもの（記憶へ移すこと）が退避の都合で
   * 道連れになる。** ⟹ 理由は (ii) の直前のコメントに書いた。
   *
   * ## ⛔ これは #564 の被害を無くすものではない
   *
   * 会話の文脈は戻らない。**残るのは生ログだけである。⟹ 「1区間まるごと失われる」
   * から「1区間の生ログは在るが、記憶へは移せていない」へ変わるだけである。**
   */
  async #salvageTranscript(): Promise<void> {
    const path = this.#distillMemory.transcriptPath;
    // **控えが無い窓は在る**（`#transcriptPath` の doc）。そこは開いたばかりの
    // セッションで、退避する中身もほぼ無い。**黙って通す側へ倒す** — ここで日誌へ
    // 書くと、道具を使う前に落ちた回のたびにノイズが1行増える。
    if (path === null) return;

    // **全文を 1 本の文字列にするのはここだけである**（`readTranscriptTail` の doc）。
    // **id を受ける。** 墓標が指すのはこれである（`TranscriptGrave` の doc）。
    let archiveId: string | null = null;
    try {
      const transcript = await readFile(path, 'utf8');
      const write = await this.#stores.archive.archive(
        this.#sdkSession.sdkSessionId ?? 'clone',
        transcript,
      );
      archiveId = write.id;
      // **diverged / unknown のときだけ日誌へ記録する**（#698。理由は
      // `describeArchiveContinuityForJournal` の doc）。`#journal` は自分で
      // 失敗を握り潰すので、退避の成功を道連れにしない。
      const continuityText = describeArchiveContinuityForJournal({
        caller: '文脈窓で畳む前の退避',
        sessionId: this.#sdkSession.sdkSessionId ?? 'clone',
        continuity: write.continuity,
        comparedTo: write.comparedTo,
        bodyChars: transcript.length,
      });
      if (continuityText !== null) {
        await this.#journal({
          type: 'exchange',
          with: 'self',
          role: 'outbound',
          text: `${EXCHANGE_KIND_RECOVERY_PREFIX}${continuityText}`,
        });
      }
    } catch (error) {
      // (i) が落ちた。**「残っているはず」と読まれないように必ず残す。**
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_FAILURE_PREFIX}文脈窓で畳む前の生ログの退避に失敗した: ${reasonOf(error)}` +
          '（⚠️ この区間の生ログは器の外に残っていない）',
      });
    }

    // (ii) は best-effort。**枠が閉じていれば落ちる。それは (i) を巻き込まない。**
    //
    // **⚠️ (i) が落ちてもここへ進む（直す前は (i) の catch で `return` していた）。**
    // (i) は全文を 1 本の文字列にするので、生ログが伸びると `ERR_STRING_TOO_LONG` で
    // 落ちる側である（`readTranscriptTail` の doc）。**そこで `return` すると、いちばん
    // 失いたくないもの（記憶へ移すこと）が、退避の都合で道連れになる。** 蒸留は末尾だけを
    // 自分で読むので (i) の成否に依存しない。⟹ (i) と (ii) を別の `try` に割った意図
    // （どちらか一方の失敗が他方を巻き込まない）を、読む側だけでなく制御の流れにも通す。
    try {
      await this.#distillFromTranscript(tailOf(await readTranscriptTail(path)));
    } catch (error) {
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_FAILURE_PREFIX}文脈窓で畳む前の蒸留に失敗した: ${reasonOf(error)}` +
          // **退避が落ちた回に「退避は済んでいる」と書かない**（守れない約束になる）。
          (archiveId !== null
            ? '（生ログの退避は済んでいる。記憶へは移せていない。次の起動で拾い直す）'
            : '（⚠️ 退避も失敗しているので、この区間はどこにも残っていない）'),
      });

      // **⭐ 墓標を立てる**（#564 E1b）。退避が済んでいる区間だけが対象で、
      // 次の起動が `archive.read` で拾い直して蒸留する（`#pickUpTranscriptGrave`）。
      //
      // **⟹ 枠が閉じている回でも待てるようになる。** ここで蒸留が落ちる主な理由は
      // 枠であり（実測で24件中9件が「長さと枠が同時」）、枠は待てば開く。**印が
      // 無ければ、開いた後に拾う手がかりが1つも残らない。**
      //
      // **投げない。** ここは失敗の報告の途中である（`#noteContextWindowFold` と
      // 同じ形）。印を立てられなかったことは記録に残すが、報告は続ける。
      const id = archiveId;
      if (id !== null) {
        await this.#stores.sessions
          .setTranscriptGrave({ archiveId: id })
          .catch((graveError: unknown) => {
            noteDroppedRecord('墓標の記録', id, graveError);
          });
      }
    }
  }

  /**
   * 起動時に、**前の器が記憶へ移せなかった区間を拾い直す**（#564 E1b）。
   *
   * ## なぜ起動時なのか
   *
   * 印が立つのは蒸留が落ちた回で、その主な理由は**枠が閉じていること**である。
   * ⟹ **同じプロセスの中で試し直しても、枠はまだ閉じている。** 次の起動は
   * 早くても器の入れ替えの後なので、そこが最初の「開いているかもしれない」地点である。
   *
   * ## なぜ `load()` ではなく `archive.readTail` から拾うのか
   *
   * 退避は既に済んでいる（印が立つ条件がそれである）。⟹ pg の生ログを全件
   * 戻す口（`SessionStore.load`）を使う理由が無い。**あちらは 60 秒の予算に
   * 掛かっている**ので、掛からない側で足りるならそちらを採る。
   *
   * **`read()`（全文）ではなく `readTail()`（末尾）を使う（#1283）。** 蒸留が
   * 使うのは `tailOf()` が切った末尾だけなのに、以前は `read()` で本文の
   * 全体を先にヒープへ載せていた——実測で `archive` の1行は最大 78.3 MB に
   * 育つので、起動のたびに自動で走るこの経路が自分自身で OOM を起こしうる
   * 形だった。`readTail(id, DISTILL_TRANSCRIPT_TAIL_CHARS)` は末尾だけを
   * 返すので、以降の `tailOf(transcript)` は前と同じ結果を、全文を載せずに
   * 得る（`TranscriptArchive.readTail` の契約——渡るものは全文を読んでいた
   * ときと同一である）。
   *
   * ## ⛔ 限界（この経路が拾えないもの）
   *
   * **退避そのものが落ちた回は印が立たない。** 材料が器の外に無いので拾うものが
   * 無い —— そのときは (i) の失敗が日誌に1行残るだけである。
   */
  async #pickUpTranscriptGrave(): Promise<void> {
    const grave = await this.#stores.sessions.getTranscriptGrave();
    if (grave === null) return;

    // **`read()`（全文）ではなく `readTail()`（末尾）**（#1283）——本文の
    // 全体をヒープへ載せてから `tailOf()` で切っていたのが欠陥そのもの。
    // 詳しい理由はこの関数の doc「なぜ `load()` ではなく `archive.readTail`
    // から拾うのか」を見よ。
    const result = await this.#stores.archive.readTail(
      grave.archiveId,
      DISTILL_TRANSCRIPT_TAIL_CHARS,
    );
    if (result.kind !== 'body') {
      // 退避が無い。**理由は2つに分かれ、同じ文面へ畳まない**（#698 — tombstone
      // を足した目的そのもの）——`missing`（器を作り直した／そもそも一度も
      // 積まれなかった）と `removed`（`archive_remove` / `DELETE /archive/:id`
      // で人が意図して本文を落とした）は別の出来事である。**どちらにせよ印だけを
      // 残さない** — 残すと、拾えないものを起動のたびに引きに行くことになる。
      // **`missing` の文面は既存のまま1文字も変えない**（「退避が見つからない
      // ので、印を下ろした」— この文言を保証しているテストがある）。`removed`
      // は別の文にする——同じ穴埋め型の文にすると「退避が本文が消されている」
      // のような重複した「が」が生まれるためでもある。
      const text =
        result.kind === 'removed'
          ? `記憶へ移せていない区間の退避の本文が消されているので、印を下ろした: ${grave.archiveId}` +
            `（${result.removedAt} に ${result.bytes} バイトを落とした${describeArchiveRemovedBytesUnit()}。` +
            '⚠️ この区間は記憶へ移せていない）'
          : `記憶へ移せていない区間の退避が見つからないので、印を下ろした: ${grave.archiveId}` +
            '（器を作り直した、あるいはそもそも積まれなかった。⚠️ この区間は記憶へ移せていない）';
      // **判定と書き込みを1操作へ畳む**（issue #1157。`clearTranscriptGraveIf` の doc）。
      // **引き直して比べる形では閉じない** —— 引き直しの後・下ろす書き込みが効く前に
      // 新しい印が landing しうる（`clone-grave-pickup-race.test.ts` で再現した）。
      // 拾い上げは `#pump` から待たれずに走るので、拾っている間に
      // `#salvageTranscript` が新しい印を立てる窓が在る。
      const lowered = await this.#stores.sessions.clearTranscriptGraveIf(grave.archiveId);
      // **下ろしていないなら「下ろした」と書かない** —— 跡が嘘をつく側へ倒れる
      // （#1157 段1 が塞いだのと同じ族）。拾えなかったこと自体は失われるので残す。
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_FAILURE_PREFIX}${
          lowered
            ? text
            : `記憶へ移せていない区間の退避を拾えなかったが、拾っている間に新しい印が立ったので、印は下ろさなかった: ${grave.archiveId}`
        }`,
      });
      return;
    }
    const transcript = result.body;

    // **拾い直したことを日誌へ1行残す。** `#distillFromTranscript` が書く
    // 「ターンの入力: pre_compact_distill」だけだと、**compaction の蒸留と区別が
    // 付かない** ⟹ 後から「何回拾い直したか」を数えられなくなる。
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: `${EXCHANGE_KIND_RECOVERY_PREFIX}前の器が記憶へ移せなかった区間を拾い直す: ${grave.archiveId}`,
    });

    await this.#distillFromTranscript(tailOf(transcript));

    // **印を下ろすのは蒸留が成功したときだけである。** 枠が閉じていれば上で投げるので
    // ここへ来ない ＝ 印が残り、次の起動でまた試す。
    //
    // **⚠️ 引き直してから下ろす。** 拾っている間に新しい印が立つ窓が在る（文脈窓で
    // 畳む回はいつでも起きる）。素で `null` を書くと、**その新しい方を消す。**
    await this.#stores.sessions.clearTranscriptGraveIf(grave.archiveId);
  }

  /**
   * `append` が渡してきた `projectKey` を控える（#564 E1b）。
   *
   * **変わったときだけ器へ書く。** `append` はターンの間およそ 100ms ごとに来るので、
   * 毎回書くと**ターン1本につき数十回の書き込み**になる。値はほぼ不変（`cwd` から
   * 決まる）なので、メモリ上の控えと違うときだけ書けばよい。
   *
   * **投げない。** ここはフックの延長で、失敗しても本体の仕事（生ログを預けること）を
   * 止める理由が無い。
   */
  #noteProjectKey(projectKey: string): void {
    if (this.#projectKey === projectKey) return;
    this.#projectKey = projectKey;
    void this.#stores.sessions.setProjectKey(projectKey).catch((error: unknown) => {
      noteDroppedRecord('生ログの scope の記録', projectKey, error);
    });
  }

  /**
   * 捨てる resume 素材を墓標として控える（#564 E1b）。**捨てる前に呼ぶこと。**
   *
   * ## 空振りする条件（どちらも黙って通す）
   *
   * | 条件 | なぜ黙るか |
   * | --- | --- |
   * | 生ログの預け先が無い（fs 構成） | 拾う材料そのものが無い。日誌へ書くと、fs で動かす
   *   たびに同じ1行が積もる |
   * | `projectKey` を誰も知らない | 配備してから1度も `append` が来ていない窓である
   *   （`SessionRegistry.getProjectKey` の doc）。**そこは失うものもほぼ無い** ——
   *   預けた生ログが1件も無いということである |
   */
  async #noteLostSession(sessionId: string): Promise<void> {
    if (this.#stores.sessionTranscriptTail === undefined) return;
    const projectKey = this.#projectKey ?? (await this.#stores.sessions.getProjectKey());
    if (projectKey === null) return;

    await this.#stores.sessions
      .setLostSessionGrave({ projectKey, sessionId })
      .catch((error: unknown) => {
        noteDroppedRecord('捨てたセッションの記録', sessionId, error);
      });
  }

  /**
   * 起動時に、**捨てた resume 素材の区間を pg の生ログから拾い直す**（#564 E1b）。
   *
   * `#pickUpTranscriptGrave` との違いは材料だけである —— あちらは退避（`archive`）の
   * 全文、こちらは**預けた生ログの末尾**である。**`load()` は使わない**（全件を戻すと
   * SDK が掛けている 60 秒の予算に当たりに行く。`SessionTranscriptTail` の doc）。
   */
  async #pickUpLostSession(): Promise<void> {
    const tail = this.#stores.sessionTranscriptTail;
    if (tail === undefined) return;
    const grave = await this.#stores.sessions.getLostSessionGrave();
    if (grave === null) return;

    const transcript = await tail.readTail(grave, DISTILL_TRANSCRIPT_TAIL_CHARS);
    if (transcript === null) {
      // 預けた生ログが1件も無い（そのセッションは何も預けずに終わった）。
      // **印だけを残さない** —— 残すと、拾えないものを起動のたびに引きに行く。
      // **判定と書き込みを1操作へ畳む**（issue #1157。理由は
      // `#pickUpTranscriptGrave` の同じ分岐に書いた）。
      const lowered = await this.#stores.sessions.clearLostSessionGraveIf(grave.sessionId);
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_FAILURE_PREFIX}${
          lowered
            ? `捨てたセッションの生ログが1件も無いので、印を下ろした: ${grave.sessionId}` +
              '（⚠️ この区間は記憶へ移せていない）'
            : `捨てたセッションの生ログが1件も無かったが、拾っている間に新しい印が立ったので、印は下ろさなかった: ${grave.sessionId}`
        }`,
      });
      return;
    }

    // **拾い直したことを日誌へ1行残す**（`#pickUpTranscriptGrave` と同じ理由 ——
    // これが無いと compaction の蒸留と区別が付かず、後から数えられない）。
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: `${EXCHANGE_KIND_RECOVERY_PREFIX}捨てたセッションの区間を、預けた生ログから拾い直す: ${grave.sessionId}`,
    });

    await this.#distillFromTranscript(tailOf(transcript));

    // **印を下ろすのは成功したときだけ**／**引き直してから下ろす**（`#pickUpTranscriptGrave`
    // と同じ形。理由もそちらに書いた）。
    await this.#stores.sessions.clearLostSessionGraveIf(grave.sessionId);
  }

  /**
   * 上限の合図を1か所で扱う。**分類ごとの扱いはここでだけ決める** — 3経路
   * （`rate_limit_event` / `system` の通知・情報メッセージ / 失敗した `result`）
   * がそれぞれ検知して、ここへ渡す。
   *
   * | `kind` | どうするか |
   * | --- | --- |
   * | `reached` | **保持して待つ**（この機構の対象）。`#usageBlocked` を立て、
   *   以降の合図は `#pump` がターンを回さず保持する（保持も解除も本体は
   *   `#pump` にある。`post` は解除の印を立てるだけ）。いま処理中の会話には
   *   `usage_limited` を届ける —
   *   呼び出し側がこの直後に `error`（終端）を出すなら、**この `await` を
   *   先に済ませてから**でなければならない。 |
   * | `org_policy` | **待たないが、記録は残す。** `usage-limits.ts` が「待っても
   *   直らないし、増やす先も違う」と明記しているので保持はしない（従来どおりの
   *   失敗として呼び出し側の通常の失敗処理に任せる）。**ただし日誌には書く** —
   *   直す前はここで早期 return して日誌にも残さなかったので、
   *   `This service is disabled for your org` で止まったことがどこにも出ず、
   *   「ただ失敗した」と区別できなかった。**「待たない」は設計判断だが、
   *   「記録しない」はどこにも書かれていない。** |
   * | `transition` / `warning` | **待たない**（まだ動く）。ただし日誌には残す
   *   — そろそろ止まることが、止まる前に分かるように。 |
   *
   * **同じ `kind` で同じ文言が続くなら、日誌への書き込みは畳む**
   * （`#notices` の `noteUsage`。doc は `clone-notices.ts` の `CloneNotices` の
   * `#usage`）。`transition` / `warning` はターンが回り続ける
   * ので `system` 通知が毎ターン届き、畳まないと同じ知らせで日誌が埋まる。
   * **畳むのは日誌だけ** — `reached` の `#usageBlocked` を立てる処理と
   * `usage_limited` の emit は、同じ `kind`・同じ文言が再び来ても毎回行う
   * （2件目以降の合図は別の会話から来ているかもしれず、emit まで畳むと
   * その送り主に何も見えなくなる）。
   */
  async #noteUsageNotice(
    notice: UsageLimitNotice | undefined,
    conversationId: string | null,
    /**
     * この通知が**どこから来たか**（Issue #393 PR3）。
     *
     * - `text`: SDK が出した文言を `classifyUsageNotice` に通したもの
     * - `rate_limit`: `rate_limit_event` の `rejected` を通知の形へ仕立て直したもの
     *
     * **回し手へ渡すのは `text` だけである**（下の分岐に理由がある）。日誌と
     * `#usageBlocked` の扱いは今までどおり両方で同じ——**この引数で変わるのは
     * 回し手へ渡すかどうかだけ**にしてある。
     */
    source: 'text' | 'rate_limit',
  ): Promise<void> {
    if (notice === undefined) return;

    // 枠が閉じた（あるいは近づいた）と分かった瞬間に日誌へ1件。**言い換えない**
    // — `describeUsageNotice` がそのまま人間の検索できる文言を返す。
    if (this.#notices.noteUsage(notice.kind, notice.text)) {
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_GAUGE_PREFIX}${describeUsageNotice(notice)}`,
      });
    }

    // **回し手へ渡すのは、文言から分類した通知だけである。**
    //
    // **⚠️ `rate_limit_event` 由来のものを渡さないこと。** この関数はそちらからも
    // 呼ばれ（`rejectedRateLimitNotice`）、そこで作られる `reached` は
    // **「その枠が尽きた」を `reached` の形へ仕立て直したもの**であって
    // 「仕事が止まった」ではない（Issue #393 追記1 の訂正。`clone.ts` に逐語で
    // 在る「1つぶんの状態でしかない」）。回し手へ `reached` として渡すと、
    // **`overage_exhausted` の設定でも課金枠を1円も使わずに回ってしまう。**
    //
    // ⟹ 出所を引数で受ける。`source` を足したのはこの1点のためである。
    if (source === 'text') await this.#observeForTokenRotation({ notice });

    if (notice.kind !== 'reached') return;

    this.#usageBlocked = withNoticeTextResetsAt(notice, Date.now());
    this.#emit(conversationId, { type: 'usage_limited', message: describeUsageNotice(notice) });

    // **`source === 'text'` に限る。** `rate_limit_event` 由来（`source ===
    // 'rate_limit'`）はターンの頭ごとに届く「1つぶんの状態」で、同じターンの
    // 後続の `result` が成功することがある（すぐ下の成功枝のコメントと同じ
    // 形）——ここで数えると、成功するターンの途中でも畳みにかかってしまう。
    // **`source === 'text'` は SDK がそのターンの応答として実際に返した文言
    // なので、`#usageBlocked` が立ったこの回はそのターン自身が失敗している。**
    if (source === 'text') await this.#noteUnproductiveUsageBlockFold();
  }

  async #handle(event: InboxEvent): Promise<void> {
    switch (event.type) {
      case 'human_message': {
        // 1件だけの経路。**まとめて読む経路（`#runHumanTurn`）と同じ関数を通す** —
        // 理由と、ここで日誌へ書かない理由はそちらの doc にある。
        await this.#runHumanTurn([event]);
        return;
      }

      case 'distill': {
        // **セッションが無いなら蒸留するものも無い。ただし「無い」の中身で分ける**
        // （Issue #1650）。かつては無条件に沈黙して return していたが、それだと
        // 兄弟の見送り（すぐ下、`!hasUndistilledActivity`）と非対称になる ——
        // あちらは見送ったことを日誌へ残すのに、こちらは1バイトも残さなかった。
        //
        // - **活動が在る（`hasUndistilledActivity`）＋ このクローンが一度でも
        //   活動している**: 記憶へ移すべきものが在るのに見送るので、その事実を
        //   日誌へ残す。**印は倒さない** —— 倒すと「移した」ことになり、実際には
        //   何も移っていない記憶が落ちる（`#hasUndistilledActivity` の doc
        //   「迷ったら蒸留する側へ倒す」と同じ理由）。次に別の入口（人間の発言・
        //   外部イベント・自発の tick 等）が `#ensureQuery()` でセッションを
        //   戻せば、その次の蒸留契機で走る。
        // - **活動が一度も無い**: 移すものが何も無いので、これまでどおり黙って
        //   return する（起動直後の停止などで、毎回日誌を増やさないため）。
        //
        // ⚠️ **横断レビューの指摘（#1650 後始末）**: `hasUndistilledActivity` の
        // 初期値は `true`（`CloneDistillMemoryState` の doc「知れないなら蒸留
        // する側を既定にする」——前のプロセスの終わり方をこの層からは知れない
        // ための保守的な既定）。⟹ **一度もターンを走らせていないクローンでも、
        // 起動直後からこの条件は満たされてしまう**——`hasUndistilledActivity`
        // 単独では「確認された活動」と「知らないので活動が在ると仮定している
        // だけ」を区別できない。**「一度も活動していない」の意味は「起動して
        // から一度もターンが走っていない」ではなく「このクローンがこれまでに
        // 一度も活動していない」である**——プロセスの再起動そのものは活動の
        // 有無を変えないので、判定もプロセスをまたいで残るものを見る必要が
        // ある。`stores.sessions` に控えた `cloneSessionId`（`session_started`
        // で必ず立ち、通常終了では下ろさない——下ろすのは畳み・resume 素材の
        // 破棄という別の理由のときだけ）が、まさにその「このクローンが一度でも
        // セッションを起こしたか」を跨プロセスで持つ唯一の控えである。**読めな
        // かったら「活動が在った」側へ倒す**（同じ「迷ったら記録する側へ倒す」
        // 理由——読めないことを理由に記録を失うと #1650 の約束を壊す）。
        if (!this.#sdkSession.query) {
          if (this.#distillMemory.hasUndistilledActivity && (await this.#everHadSession())) {
            await this.#journal({
              type: 'exchange',
              with: 'self',
              role: 'outbound',
              text:
                `${EXCHANGE_KIND_THINNING_PREFIX}蒸留（${event.reason}）は見送った。セッションが無い` +
                '（終わっていた）ので蒸留できない。未蒸留の活動の印は残したので、次にセッションが戻った' +
                'とき（別の入口が新しいセッションを起こしたとき）に蒸留される。',
            });
          }
          return;
        }
        // **前回の蒸留以降に新しいことが無ければ、同一内容の蒸留を重ねて払わない。**
        // `endConversation()` の直後に `stop()` が来る形（デプロイの夜間再起動が
        // これに当たる）は、`event.reason` が `conversation_end` でも `shutdown`
        // でも `buildDistillPrompt` が同じ文面へ写す（すぐ下）ので、間に新しい
        // ターンが1本も無ければ2回目は文字どおりの重複でしかない
        // （`#hasUndistilledActivity` の doc）。**取りこぼしより重複を疑うこと** —
        // 印が立っていれば必ず投げる。
        if (!this.#distillMemory.hasUndistilledActivity) {
          await this.#journal({
            type: 'exchange',
            with: 'self',
            role: 'outbound',
            text:
              `${EXCHANGE_KIND_THINNING_PREFIX}蒸留（${event.reason}）は見送った。前回の蒸留以降にターンが1本も` +
              '走っていない（＝内容が変わっていない）ので、同一内容を重ねて払わない。',
          });
          return;
        }
        // **定期の棚卸しの刻みにだけ、いま測った的の一覧を添える**
        // （`prompt.ts` の `DistillPromptOptions.tidyTargets`）。会話終了・
        // shutdown の蒸留は「その会話を記憶へ移す」のが本題なので添えない。
        //
        // **測れなかったら添えない。ターンは止めない。** 記憶が読めない回に
        // 棚卸しそのものを落とすと、いちばん畳みたい状態（ストアが不調で
        // 溜まっている）で仕事が消える。`#memoryFloorDigestLine` の
        // 「測れなかった」と同じ倒し方である。
        let tidyTargets: string | undefined;
        if (event.reason === 'scheduled') {
          try {
            tidyTargets = describeMemoryTidyTargets(await this.#stores.persona.documents());
          } catch (error) {
            tidyTargets = `棚卸しの的: 測れなかった（理由: ${reasonOf(error)}）。memory_list から自分で探すこと。`;
          }
        }
        const distillPrompt = buildDistillPrompt(
          event.reason === 'shutdown' ? 'conversation_end' : event.reason,
          {
            ...(tidyTargets === undefined ? {} : { tidyTargets }),
          },
        );
        // **このターンへ何が入ったかを残す**（#243）。本文は定型文なので長さだけ
        // を書く（何を載せるかの判断は `turnInputEntry` に1本化してある）。
        await this.#journal(
          turnInputEntry({ type: 'distill', reason: event.reason, prompt: distillPrompt }),
        );
        const outcome = await this.#runInternal(distillPrompt, 'distill');
        // **成功で終わった蒸留だけが印を下ろす。** 失敗した蒸留（枠で保持
        // された場合を含む。`outcome.status === 'failed'`）で下ろすと、移せ
        // なかった記憶を「移した」ことにして記憶を落とす（`#hasUndistilledActivity`
        // の doc）。
        if (outcome.status === 'answered') {
          this.#distillMemory.markDistilled();
          // **「成功で終わった」を日誌へ残す**（Issue #564 の (b)）。印は器の
          // 中にしか無く（`#hasUndistilledActivity`）、プロセスが消えれば一緒に
          // 消えるので、次のセッションからは「前回どこまで移せたか」が引けない。
          //
          // **`#hasUndistilledActivity` を下ろすのと同じ条件・同じ場所に置く。**
          // 条件を別の行へ写すと、片方だけ直して残りが古い基準のまま、という穴が
          // できる（`distill-gap.ts` の doc）。
          await this.#journal(distillSucceededEntry(event.reason));
        }
        return;
      }

      case 'human_answer': {
        // **同じ回答を1回として扱う**（issue #1977。`#handledHumanAnswerIds` の
        // doc）。決まった形の id を同じプロセスの中で既に処理していたら、
        // 2回目はターンを起こさない——中身の無い跡だけ stderr に残す
        // （`inboxEventShape` は本文を出さない）。
        if (this.#handledHumanAnswerIds.has(event.id)) {
          noteDuplicateHumanAnswer(event);
          return;
        }
        this.#handledHumanAnswerIds.add(event.id);

        // **片付け済みの配り直しはここへ来ない**（`#pump` が畳む。
        // `#foldClosedRedelivery`）。かつてはここで承認待ちを読み直さずに断り書き
        // だけを配り、その全文を `turnInputEntry`（`human_answer_closed`）で日誌へ
        // 残していた（#243）。**残す先は消していない** —— 断り書きの全文は畳んだ側の
        // 1行へ写している（`#foldClosedRedelivery` の doc）。
        // **行が読めなくなっていても、回答は失わない**（`UnreadableApprovalError`。回答の
        // 本文は `event` が持つ）。質問だけが取れないので、そう言って続きへ進む。
        let approval: PendingApproval | null = null;
        let approvalUnreadable = false;
        try {
          approval = await this.#stores.jobs.getApproval(event.approvalId);
        } catch (error) {
          if (!(error instanceof UnreadableApprovalError)) throw error;
          approvalUnreadable = true;
          noteDroppedRecord('回答済みの承認待ちの読み出し', inboxEventShape(event), error);
        }
        await this.#markAnswerDeliveredOnHandle(approval, event);
        const question =
          approval?.question ??
          (approvalUnreadable
            ? '(不明な質問。承認待ちの行は在るが読めない形で入っている)'
            : '(不明な質問)');
        // 宛先は managerId と requestId の対で戻す。requestId を落とすと、
        // そのマネージャーが複数を待っているとき宛先が決まらず、人間が答えたのに
        // 仕事が再開しない（人間へ回る経路の端から端まで id を運ぶこと）。
        const waiting =
          approval?.jobId === undefined
            ? ''
            : `\n\nこの確認はマネージャー ${approval.jobId} のものである。` +
              `回答を \`manager_send\`（許可確認なら decision 付き）で返すと、止まっていたその仕事が再開する。` +
              `\n宛先: managerId: "${approval.jobId}"` +
              (approval.requestId === undefined ? '' : `, requestId: "${approval.requestId}"`);
        // **回答経路を短く添える（Issue #1479）。** クローンは人間の代理であり、
        // `operator` 経由の回答が人間本人とは限らないことを、隠さず自分の判断
        // 材料にできるようにするため——「人間が答えた」という前置きの直後に置く。
        // `event.answeredVia` が無い（`via` を渡さずに呼んだ経路）ときは何も足さない。
        const viaLine =
          event.answeredVia === undefined
            ? ''
            : `\n回答経路: ${describeAnsweredVia(event.answeredVia)}`;
        // **構造も添える（issue #2525）。** 回答の文（上）は人間向けに畳んだもので、設問 id と
        // 選んだ選択肢 id の対は文からは読み取れない。クローンが機械的に拾えるよう JSON で足す。
        const selectionsLine =
          event.selections === undefined
            ? ''
            : `\n選択（構造。設問 id → 選んだ選択肢 id ＋ その他）: ${JSON.stringify(event.selections)}`;
        const answerPrompt =
          `[system] 承認待ちにしていた質問に人間が答えた。\n\n質問: ${question}\n回答: ${event.answer}` +
          `${selectionsLine}${viaLine}${waiting}\n\n` +
          'この回答に沿って続きを進めよ。今後同じ判断を自分でできるよう、必要なら記憶へ残すこと。';
        // **全文を残す**（#243）。回答そのものは承認待ちの器にも在るが、質問・回答・
        // 宛先を1本にしたこの形＝**このターンへ入ったもの**は、ここにしか無い。
        // **入口の行にも印を立てる（issue #847 の案B）。** 答えと行動を対で読む
        // 口（`approval-trace.ts` の `traceApproval`）の錨で、印の有無で
        // 「この記録を始める前のターン」と「記録が動いていない」を分ける。本文の
        // `approvalId=<id>` は64字で切られうる（`turn-input.ts` の `TAG_LIMIT`）ので、
        // 錨は本文ではなく構造化した欄に持たせる。
        const turnStart = turnInputEntry({
          type: 'human_answer',
          approvalId: event.approvalId,
          text: answerPrompt,
        });
        await this.#journal(
          turnStart.type === 'exchange'
            ? { ...turnStart, answeredApprovalId: event.approvalId }
            : turnStart,
        );
        // **`#runInternal`（常に `null`）ではなく `#runTurn` を直接呼ぶ（#768）。**
        // `#conversationOf(event)` は、元の承認が会話 id を持っていればそれを
        // 返し、持っていなければ `null` を返す —— 会話 id が無ければこれまでと
        // 1文字も変わらない（`#runInternal` は `#runTurn(null, text, kind)` の
        // 薄いラッパーでしかない）。
        // **`event.approvalId` も運ぶ（issue #782 の1）。** このターンの
        // outbound な exchange が「どの承認への返答か」を、会話 id や時刻の
        // 近さではなく id で持てるようにする。
        await this.#runTurn(this.#conversationOf(event), answerPrompt, 'normal', event.approvalId);
        return;
      }

      case 'manager_message': {
        // **本文の追記は配達のたびに書く**（`#journalIncomingBody`。`#restoreUnread`
        // の「本文は配達のたびに書く」と同じ理由 —— 読む側にとってはこの1回が「全文の
        // 取り方」の在り処になる）。**ターンを起こさずに畳む回でも同じものを書く**
        // ので、書き込みは1本にまとめてある（`#foldClosedRedelivery`）。
        await this.#journalIncomingBody(event);

        // **片付け済みの配り直しはここへ来ない**（`#pump` が畳む）。かつてはここで
        // 短い断り書きだけを配っており、そのとき `waiting` の生死（liveness）は
        // 問わなかった ——「片付いているものには liveness を問わない」というその判断は
        // 畳む側でも同じである（台帳が閉じていると言っているものについて、待たれて
        // いるかを確かめたところで出す文言が無い）。
        // `report` は判定の対象外（`confirmationLiveness` の doc）。
        // `'unknown'` を渡しても `managerPrompt` はその分岐を読まない。
        const liveness: ConfirmationLiveness =
          (event.kind === 'question' || event.kind === 'permission') &&
          event.requestId !== undefined
            ? await confirmationLiveness(this.#managers, event.managerId, event.requestId)
            : 'unknown';
        // **台帳は kind を問わず引く**（#391 は `report` 限定だったが、#871 で
        // `question` / `permission` にも広げた）。台帳の id は `event.id` その
        // もの（`commitmentFor` の `manager_message` 分岐）で kind に依存しない
        // ので、同じ関数がそのまま使える（`reportSettlement` の doc「#871」）。
        const settlement: ReportSettlement = await reportSettlement(
          this.#stores.commitments,
          event.id,
        );
        // **(A) の件数を数える跡（issue #1374）。** `closedReportNotice` は
        // `report` だけの断り書き（`question`/`permission` は姉妹版の
        // `closedConfirmationNotice`——ここでは数えない）なので、`kind` を
        // 絞ってから確かめる。片付け済みの配り直しはここへ来ない（`#pump` が
        // 畳む）ので、非 null は必ず配った回である。
        if (event.kind === 'report' && closedReportNotice(settlement) !== null) {
          await this.#noteRedeliveryPredicateHitA(event.managerId);
        }
        // **`now` はここで1度だけ取り、`managerPrompt` の中では取らない**（#562）。
        // `managerPrompt` を純関数のまま保つ ——歯に `now` を固定して渡せる形で
        // なければ、経過を測るテストが時刻に依存して揺れる。
        await this.#runInternal(managerPrompt(event, liveness, settlement, new Date()));
        return;
      }

      // --- 人間以外の起点（PRD「自律」の②③④） -------------------------------
      // どれも人間が見ていない時間に来る。だから応答の宛先は無く（内部ターン）、
      // 何をするかの判断はプロンプトではなくクローンに残す。

      case 'timer': {
        if (event.kind === DAILY_REPORT_KIND) {
          // **省略時は `schedule`（定刻どおり）。** この分岐は下の journalCause の
          // 計算より前で return するので、同じ既定をここで別に持つ
          // （`dailyReportEvent` の doc。後追いだけが `schedule_catchup` を運ぶ）。
          await this.#dailyReport(
            event.target ?? localDate(new Date(event.at)),
            event.cause ?? 'schedule',
          );
          return;
        }
        // 依頼の本文は**いま**読み、読んだその版で発火を確定させる。イベントに
        // 載せて運ぶと、人間が依頼を書き換えても発火時点の写しで走る（真実はストア側）。
        const claimed = await this.#claimScheduledRun(
          event.kind,
          event.at,
          // 省略時は定期の予定（`schema.ts` の `timer` の既定）
          event.cause === 'manual' ? 'manual' : 'schedule',
        );

        // **動かさない方を選ぶ場面が3つある。** どれも「時刻が来れば必ず届く」の側を
        // 1周期遅らせるだけで済むが、走らせてしまうと取り返せない。
        if (claimed.status !== 'ok' && claimed.status !== 'missing') {
          await this.#journal({
            type: 'exchange',
            with: 'self',
            role: 'outbound',
            text: `${EXCHANGE_KIND_DECISION_PREFIX}定期の依頼 ${event.kind} は、この発火では動かない: ${claimed.reason}`,
          });
          // 「次の発火で読み直す」の次の発火が1周期先では遠すぎる。人間が消した
          // （`withdrawn`）ものは再試行しない。
          if (event.cause !== 'manual' && claimed.status !== 'withdrawn') {
            this.#onScheduledRunNotStarted?.(event.kind);
          }
          return;
        }

        // ストア（`claimRun` / `completeRun`）は「定期の予定の基準を動かすか」だけを
        // 知ればよいので、いまも2値のまま（`schedule_catchup` も基準を進める側なので
        // `schedule` 扱い）。**日誌の側はここで分けない** — 「なぜこの時刻に起きたか」
        // （定刻どおりか、取りこぼしを拾ったか）を追えるようにするのが#5の直しなので、
        // `event.cause` が運んできた3値（`schema.ts` の `timer` の doc）をそのまま書く。
        const cause = event.cause === 'manual' ? 'manual' : 'schedule';
        const journalCause = event.cause ?? 'schedule';
        const plan = claimed.status === 'ok' ? claimed.plan : null;
        const timerDigest = await this.#recentDigest();
        // **このターンへ何が入ったかを残す**（#243）。digest の全文は書かない —
        // 材料はこの日誌の中に在るので、形と長さがあれば組み直せる
        // （`turn-input.ts` の doc）。
        await this.#journal(
          turnInputEntry({
            type: 'timer',
            kind: event.kind,
            cause: journalCause,
            ...(event.target === undefined ? {} : { target: event.target }),
            request: plan !== null,
            digest: timerDigest,
          }),
        );
        const outcome = await this.#runInternal(
          buildTimerPrompt({
            kind: event.kind,
            ...(event.target === undefined ? {} : { target: event.target }),
            ...(plan === null ? {} : { request: plan.request }),
            ...(plan?.lastRunAt === undefined ? {} : { lastRunAt: plan.lastRunAt }),
            // 前の発火が終わっていなかったなら、それは器が落ちた跡である。
            // 走りかけていた可能性があることを隠さない（二重に手を出さないため）。
            ...(plan?.pendingRun === undefined ? {} : { unfinishedAt: plan.pendingRun.at }),
            digest: timerDigest,
          }),
        );

        // **終わったことを記録するのはここ。** claim（引き受けた印）とは別に置く。
        // ここまで来ないうちに器が落ちたら、印が残っているので配り直される
        // （日次なら翌日・週次なら翌週まで消える、を作らない）。
        //
        // **失敗で終わったターンは「終わった」ではない（#2739）。** 枠切れ以外の失敗
        // （API エラー・文脈窓・SDK の失敗）で `completeRun` を呼ぶと、印が消えて基準が
        // 進み、週次なら次の週まで誰も気づかない。印を残せば、次の起動の
        // `#firstDue` と、次の周期の刻み（`#resumable`）で元の発火として配り直される。
        // 受信箱の合図は失敗として settle される（決定的に失敗する合図を起動のたびに
        // 焼かない線）ので、配り直しを担うのは印の側である。枠での保持（`heldForUsage`）は
        // 従来どおり `#pump` の `defer` が配り直す。保持した合図は受信箱に未読で残るので、
        // 保持中に器が落ちても再起動の `#restoreUnread` が元の回として配り直す（#2814）。
        // **ここで印を残さないこと** — 残すと `#firstDue` と未読の両方から同じ回が届き、
        // 走っていない回に `unfinishedAt` が付く（`clone-schedule-held-for-usage.test.ts`）。
        if (plan !== null) {
          if (outcome.status === 'failed' && !outcome.heldForUsage) {
            await this.#journal({
              type: 'exchange',
              with: 'self',
              role: 'outbound',
              text:
                `${EXCHANGE_KIND_FAILURE_PREFIX}定期の依頼 ${event.kind}（${event.at}）のターンが失敗で終わった` +
                `ので「終わった」とは記録しない（引き受けた印が残り、次の起動か次の周期の刻みで配り直される）: ` +
                outcome.reason,
            });
            // 同じプロセスの中でも、次の周期を待たずに後退しながら配り直す。
            // 元の回（`pendingRun.at`）のまま配り直される（`Scheduler.#resumable`）。
            // 手で起こした1回は再試行しない。使い切ったら印を残したまま次の周期か再起動に任せる。
            if (cause !== 'manual') {
              const prior = this.#timerTurnRetries.get(event.kind);
              const attempts = prior?.at === event.at ? prior.attempts : 0;
              const delayMs = FAILED_TURN_RETRY_DELAYS_MS[attempts];
              if (delayMs !== undefined) {
                this.#timerTurnRetries.set(event.kind, { at: event.at, attempts: attempts + 1 });
                this.#onScheduledRunNotStarted?.(event.kind, delayMs);
              }
            }
          } else {
            this.#timerTurnRetries.delete(event.kind);
            // **枠保持で終わった回は、完了を記録する前に受信箱の行へ印を付ける**（#3317）。
            // 完了（`completeRun`）を記録すると永続状態は「完了して消し込みだけ失敗した回」と
            // 同じ見た目になり、再起動の配り直しが畳んでしまう（#2814 が配り直すと決めた回）。
            // 印は行に書く（`#heldForUsage` はメモリで再起動を越えない）。同じ id の `put` は
            // 配達回数を保って上書きする。**印を書けなかったら `completeRun` を呼ばない** —
            // 印（`pendingRun`）が残れば次の起動でスケジューラが配り直す（二重の側へ倒れ、回は失われない）。
            if (outcome.status === 'failed' && outcome.heldForUsage) {
              try {
                await this.#stores.inbox.put({ ...event, heldForUsage: true }, event.at);
              } catch (error) {
                noteDroppedRecord('枠保持の印の書き込み', inboxEventShape(event), error);
                return;
              }
            }
            await this.#completeScheduledRun(event.kind, event.at, cause);
          }
        }
        return;
      }

      case 'external': {
        const body = renderPayload(event.payload, event.at);
        // 添付（#3113 段3）。中身はここで読むだけで、受信箱・日誌・記憶へは写さない。
        const attached = await this.#resolveExternalAttachments([event]);
        // **日誌の書き込みは配達のたびに**（`manager_message` と同じ理由。畳む回でも
        // 同じものを書くので1本にまとめてある: `#journalIncomingBody`）。
        await this.#journalIncomingBody(event);
        // **片付け済みの配り直しはここへ来ない**（`#pump` が畳む。
        // `#foldClosedRedelivery`）。
        await this.#runInternal(
          buildExternalEventPrompt({
            source: event.source,
            body,
            ...(event.via === undefined ? {} : { viaKeyNames: [event.via.name] }),
            ...(attached.noticeLines.length === 0
              ? {}
              : { attachmentNoticeLines: attached.noticeLines }),
          }),
          'normal',
          attached.images,
        );
        return;
      }

      case 'self_initiative': {
        const digest = await this.#recentDigest();
        // **このターンへ何が入ったかを残す**（#243。digest の全文を書かない理由は
        // `turn-input.ts` の doc）。`cause` は `timer` の `journalCause` と同じ形
        // （省略時は `schedule`＝定刻どおり。`schema.ts` の
        // `inboxEventSchema` `self_initiative.cause` の doc）。
        await this.#journal(
          turnInputEntry({
            type: 'self_initiative',
            reason: event.reason,
            cause: event.cause ?? 'schedule',
            digest,
          }),
        );
        await this.#runInternal(buildSelfInitiativePrompt({ reason: event.reason, digest }));
        return;
      }

      default: {
        const exhaustive: never = event;
        throw new Error(`未知の受信箱イベント: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // ターンの実行
  // -------------------------------------------------------------------------

  /**
   * ターンを1本回して**結果の状態**を返す（`TurnOutcome`）。
   *
   * **本文だけを返さない。** 直す前は `Promise<string>` で、失敗しても
   * `turn.text` を返していたので、呼び出し側は「クローンが答えた」と
   * 「SDK がエラーを返した」を区別できなかった（`sdk-failure.ts` の doc）。
   *
   * **`kind` が `'distill'` のときだけ `#hasUndistilledActivity` を立て直さない。**
   * 蒸留そのものもここを通る（人間の発言と同じ「1本のターン」であることに
   * 変わりは無い）が、蒸留のターンで立て直すと印は永久に下りず、`stop()` の
   * 重複防止は何もしないのと同じになる（`#hasUndistilledActivity` の doc）。
   * それ以外の全経路（`human_message` / `human_answer` / `manager_message` /
   * `timer` / `external` / `self_initiative`）は素通しで `kind` を省略し、
   * 既定の `'normal'` で印を立てる。
   */
  async #runTurn(
    conversationId: string | null,
    text: string,
    kind: 'normal' | 'distill' = 'normal',
    /**
     * 承認待ちへの回答（`human_answer`）から呼ばれたときだけ、その承認の
     * id（issue #782 の1）。他の呼び出し元（`#runInternal` / `#runHumanTurn`）
     * は渡さないので既定 `null` のままになる——渡し忘れではなく、承認に
     * 由来しないターンには紐づける承認が無いことをそのまま表す。
     */
    approvalId: string | null = null,
    /**
     * 本文に添える画像（段1b）。モデルへ渡す入力（`AgentUserInput.images`）へそのまま通す。
     * 呼び出し元が渡さなければ従来どおり文字列だけの入力になる。
     */
    images: readonly AgentInputImage[] = [],
  ): Promise<TurnOutcome> {
    if (kind !== 'distill') this.#distillMemory.markActivity();

    // ターンは **セッションを起こす前に** 登録する。セッションの生成が失敗したり
    // 読み取りが即死したりしても、待っているターンを必ず誰かが解放できるように。
    let turn!: Turn;
    const done = new Promise<void>((resolve) => {
      turn = {
        conversationId,
        approvalId,
        text: '',
        reply: '',
        replyWritten: 0,
        replyMessageStart: 0,
        streamed: false,
        rejected: null,
        failure: null,
        compactions: [],
        resolve,
        kind,
      };
      this.#sdkSession.beginTurn(turn);
    });

    try {
      await this.#ensureQuery();
      // 配り直しと台帳の断り書きは**ここでだけ**載せる（`#notices` の
      // `redelivery` の理由）。蒸留が間に合わなかった区間の断り書きも同じ場所へ
      // 置く（起点は7か所に散っているが、ターンの入口はここ1か所しかない）。
      // **並び順そのものは `turn-input.ts` の `composeTurnInputText` が持つ。**
      // ここに在るのは「8本をどう作るか」だけで、「どれを先に置くか」の規則は
      // 向こうに在る（規則が違うものを同じ場所に置かない、の doc もそちら）。
      //
      // ⚠️ **`distillGap` と `contextWindowFold` はこの2行で消費される。**
      // どちらも呼ぶこと自体が遷移（自分の pending を倒す）なので、**呼び出しは
      // ここから動かさない。** オブジェクトのプロパティは書いた順に評価されるので、
      // この並びが元の `+` の連結と同じ順序を保つ。**`...this.#notices.forTurn()`
      // はこの2行より後ろに置くこと。** `forTurn()` 自体は副作用の無い読み取り
      // なので、前に置いても6本の値そのものは変わらない——ただし、消費する2本の
      // `await` より前に評価する形は「まだ消費していない時点の6本」を読むように
      // 見える書き方であり、次に読む者を誤らせる。
      this.#pushInput(
        await this.#withFreshMemory(
          composeTurnInputText({
            distillGap: await this.#distillGapNotice(kind),
            contextWindowFold: this.#contextWindowFoldNotice(kind),
            ...this.#notices.forTurn(),
            body: text,
          }),
        ),
        images,
      );
      // 入力がモデルへ渡った瞬間から最初の出力までは「考えている」。
      // **`#ensureQuery` より後で送る** — セッションの起動そのものはまだ考え
      // 始めていないので、そこで送ると手が動いていないのに考えていると
      // 言うことになる。`#pushInput` は同期なので、この emit は続く `text`
      // より必ず先に届く。
      this.#emit(conversationId, { type: 'thinking' });
    } catch (error) {
      await this.#reportFailure(conversationId, { error });
      this.#finishTurn();
    }

    await done;

    // **失敗の印を先に見る。** 本文が部分的に出ていても、失敗したターンの本文は
    // 応答ではない（`daily_report` はまさにそれを本文として保存していた）。
    if (turn.failure !== null) {
      return {
        status: 'failed',
        reason: turn.failure,
        // 保持しているかは `#usageBlocked` が持つ。**`#pump` の `finally` が
        // `defer` を決めるのに使うのと同じ値を読む** — 別の判定を書くと、
        // 「保持したのに呼び出し側は保持していないと思っている」がありうる。
        heldForUsage: this.#usageBlocked !== null,
      };
    }
    return { status: 'answered', text: turn.text };
  }

  /**
   * 人間に見せない内部ターン（蒸留・人間以外の起点）。
   *
   * `kind` は `#runTurn` へそのまま渡す。蒸留の呼び出し元だけが `'distill'` を
   * 渡し、それ以外は省略して既定（`'normal'`）のままにする。
   *
   * **承認回答の反映（`human_answer`）はここを通らない（#768 で外した）。**
   * かつては常に `#runTurn(null, …)` を呼ぶこの関数を経由していたので、元の
   * 承認がどの会話で上がったかに関わらず一律で内部ターン扱いになっていた
   * （＝チャットに生配信も履歴も出ない、という穴の本体）。いまは `#handle` の
   * `case 'human_answer'` が `#runTurn(this.#conversationOf(event), …)` を
   * 直接呼び、会話 id を持つ承認への回答だけ人間の会話へ載る。
   */
  async #runInternal(
    text: string,
    kind: 'normal' | 'distill' = 'normal',
    /** 本文に添える画像（外部イベントの添付。#3113 段3）。渡さなければ文字列だけの入力。 */
    images: readonly AgentInputImage[] = [],
  ): Promise<TurnOutcome> {
    return this.#runTurn(null, text, kind, null, images);
  }

  // -------------------------------------------------------------------------
  // 自律（人間以外の起点の中身）
  // -------------------------------------------------------------------------

  /**
   * 発火した kind の依頼を読む。
   *
   * **「消された」と「読めなかった」を区別する。** 前者は人間が手で仕込んだ kind を
   * 起こした場合も含むので、本文なしのターン（記憶に照らして判断する）が正しい。
   * 後者は器の瞬断であって、本文なしで動かす理由にはならない。
   *
   * 一瞬の揺れで1周期ぶんの仕事を落とさないよう、この発火の中で読み直す。**回数を
   * 絞るためではなく取りこぼしを拾うため**であり、諦めた場合も `lastRunAt` を
   * 進めないので、次の発火で同じ依頼がそのまま来る。
   */
  async #scheduledRequestFor(
    kind: string,
  ): Promise<
    { status: 'ok'; plan: ScheduledRequest | null } | { status: 'unreadable'; error: string }
  > {
    let last = '';
    for (let attempt = 0; attempt < SCHEDULE_STORE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, SCHEDULE_STORE_RETRY_MS * attempt));
      }
      try {
        return { status: 'ok', plan: await this.#stores.schedules.get(kind) };
      } catch (error) {
        last = reasonOf(error);
      }
    }
    return { status: 'unreadable', error: last };
  }

  /**
   * 「この発火で起きた」をストア側で確定させる。書けたら確定した依頼、書けなければ
   * 理由を返す（`null` は「同じ版がもう無い」＝消された・書き換わった）。
   *
   * 読み取りと同じ理由で、この発火の中で書き直す（器の一瞬の揺れで1周期ぶんの仕事を
   * 落とさない）。**それでも書けなければ動かない** — 動いた事実が外の世界にだけ残り、
   * `lastRunAt` が古いままだと、次の起動で「落ちている間に過ぎた予定」として同じ仕事を
   * もう一度起こす（取り消せない操作の二重実行は、1周期遅れるよりずっと高い）。
   */
  async #claimRun(
    kind: string,
    expectedUpdatedAt: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<
    { status: 'ok'; plan: ScheduledRequest | null } | { status: 'failed'; error: string }
  > {
    let last = '';
    for (let attempt = 0; attempt < SCHEDULE_STORE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, SCHEDULE_STORE_RETRY_MS * attempt));
      }
      try {
        return {
          status: 'ok',
          plan: await this.#stores.schedules.claimRun(kind, expectedUpdatedAt, at, cause),
        };
      } catch (error) {
        last = reasonOf(error);
      }
    }
    return { status: 'failed', error: last };
  }

  /**
   * 引き受けた発火が終わったことを記録する。
   *
   * 書けなくても**ターンはもう走っている**ので、ここで止めるものは無い。印が残るぶん
   * 次の起動で配り直されるが、それは「消えるより配り直す」を選んだ結果である
   * （プロンプトには前の発火が終わっていないことを添えるので、二重に手を出す前に
   * クローンが `manager_list` と日誌を見られる）。
   */
  async #completeScheduledRun(
    kind: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<void> {
    let last = '';
    for (let attempt = 0; attempt < SCHEDULE_STORE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, SCHEDULE_STORE_RETRY_MS * attempt));
      }
      try {
        await this.#stores.schedules.completeRun(kind, at, cause);
        return;
      } catch (error) {
        last = reasonOf(error);
      }
    }
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_FAILURE_PREFIX}定期の依頼 ${kind} の「終わった」を記録できなかった` +
        `（引き受けた印が残るので、次の起動で配り直される）: ${last}`,
    });
  }

  /**
   * 発火した kind を「読んで、その版で確定させる」まで通す。
   *
   * **読んだ本文で走るなら、走ると決めた時点でその版が生きていることを確かめる。**
   * 読みと記録が別操作だと、その隙間に人間が消した・直した依頼が古い本文で走る
   * （消した依頼が外の世界へ手を出したら取り返せない）。確定はストア側の1操作
   * （`claimRun`）に閉じてあり、ここはその周りの再試行と、版が入れ替わっていたときの
   * 読み直しだけを持つ。
   *
   * 版が入れ替わっていたら**新しい版を読み直して**そちらで確定させる。人間が直した
   * 直後なら、その新しい依頼で動くのが正しい（古い方で走らないことが最優先）。
   */
  async #claimScheduledRun(
    kind: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<
    | { status: 'ok'; plan: ScheduledRequest }
    /**
     * そもそも仕込みが無い kind だった（人間が手で `POST /schedule/:kind/run` を
     * 叩いた等）。本文が無いのは正常なので、記憶に照らして判断させる。
     */
    | { status: 'missing' }
    | { status: 'unreadable' | 'unrecordable' | 'withdrawn' | 'churning'; reason: string }
  > {
    // 一度でも依頼を読めていたなら、後から消えたのは「人間が消した」である。
    // 最初から無いのとは意味が違うので分ける（片方は動かさない、片方は判断させる）。
    let sawPlan = false;

    for (let round = 0; round < SCHEDULE_CLAIM_ROUNDS; round += 1) {
      const found = await this.#scheduledRequestFor(kind);
      if (found.status === 'unreadable') {
        return {
          status: 'unreadable',
          reason:
            `依頼を読めなかった（本文なしで曖昧に動かすより、次の発火で読み直す）: ` + found.error,
        };
      }
      if (found.plan === null) {
        return sawPlan
          ? {
              status: 'withdrawn',
              reason: '確定する前に人間がこの依頼を消した（取り消された仕事は動かさない）',
            }
          : { status: 'missing' };
      }
      sawPlan = true;

      const claimed = await this.#claimRun(kind, found.plan.updatedAt, at, cause);
      if (claimed.status === 'failed') {
        return {
          status: 'unrecordable',
          reason:
            `「起きた」を記録できなかった（動いてから記録できないと、次の起動で同じ仕事を` +
            `もう一度起こす）: ${claimed.error}`,
        };
      }
      // 確定できた。返るのは更新前の姿なので「前回いつ動いたか」も分かる
      if (claimed.plan !== null) return { status: 'ok', plan: claimed.plan };
      // 読んでから確定するまでに人間が消した・直した。新しい版で読み直す
    }
    return {
      status: 'churning',
      reason: '読むたびに依頼が書き換わっている（人間が直している最中なので次の発火に譲る）',
    };
  }

  /**
   * `manager_list`（`tools.ts`）が使う「話しかけられるか」を、digest の
   * マネージャー節でも同じ字面で出すための材料（**握り潰しの軸と一緒に
   * `#managerDigestAxes()` が返す**——真下）。
   *
   * `ManagerPool#list()` は実行時に `isLive()`（`manager.ts`）を計算する——
   * ジョブ台帳（`stores.jobs`）が持たない軸なので、`buildActivityDigest`
   * 自身は取れない。**`list()` が失敗しても digest を壊さない** — 空の Map を
   * 返す。空の Map は `describeManagerState` の既定どおり全件 `/セッション不明`
   * になる（`liveness?.get(id)` が `undefined` を返すため）。これは「取れて
   * いない」がそのまま出力に出る側であって、黙って「繋がっている」に倒れる
   * 側ではない（`digest.ts` の `describeManagerState` / `buildActivityDigest`
   * の doc と同じ理由）。
   *
   * ## もう1つの軸（#621 / #643 — 背景処理の完了待ち）
   *
   * `ManagerSummary.awaitingBackground` も同じ理由でここから運ぶ——材料は
   * `ManagerPool` のプロセス内の在庫（`#withheldReports`）で、ジョブ台帳には
   * 載らない。**2つを別の `Map` にしてある**（`digest.ts` の
   * `ManagerAwaitingBackgroundMap` の doc）——1つに畳むと、`live` は取れたが
   * 握り潰しは無かった委譲と、そもそも何も取れなかった委譲が同じ「載っていない」
   * になる。
   *
   * **`list()` を2回呼ばない。** 軸ごとに読みに行く形にすると、digest 1本の
   * ために台帳を軸の数だけ読むことになり、軸が増えるたびに読みも増える。
   * ——この関数の名前が `#managerLiveness` から変わったのはそのためである
   * （返す軸が2つになった）。
   */
  async #managerDigestAxes(): Promise<{
    liveness: ManagerLiveness;
    awaitingBackground: ManagerAwaitingBackgroundMap;
  }> {
    try {
      const managers = await this.#managers.list();
      return {
        liveness: new Map(managers.map((manager) => [manager.managerId, manager.live])),
        // **握り潰しが在る分だけを載せる。** 無い分を `undefined` で載せても
        // `describeManagerState` の側では同じだが、`Map` の側で「載っていない」
        // と「`undefined` が載っている」が別の意味を持たないようにしておく。
        awaitingBackground: new Map(
          managers.flatMap((manager) =>
            manager.awaitingBackground === undefined
              ? []
              : [[manager.managerId, manager.awaitingBackground] as const],
          ),
        ),
      };
    } catch {
      return { liveness: new Map(), awaitingBackground: new Map() };
    }
  }

  /**
   * 発意・定期ジョブに渡す直近の状況。**先頭に「記憶の床」の1行が付く**
   * （#553 F2）。日報はこれを呼ばない——`#recentDigestBare` を直接呼ぶ
   * （`#dailyReport` の doc）。
   */
  async #recentDigest(): Promise<string> {
    return `${await this.#memoryFloorDigestLine()}\n\n${await this.#recentDigestBare()}`;
  }

  /**
   * `#recentDigest` から「記憶の床」の1行を除いた本体。日報（`#dailyReport`）
   * が呼ぶのはこちら——tick という区切りに数を出す仕組みであって、日報は
   * その区切りではない（依頼者の明示指定。#553 F2）。
   */
  async #recentDigestBare(): Promise<string> {
    try {
      const axes = await this.#managerDigestAxes();
      return await buildActivityDigest(
        this.#stores,
        { since: new Date(Date.now() - RECENT_DIGEST_WINDOW_MS) },
        axes.liveness,
        axes.awaitingBackground,
        await this.#providerGapLines(),
      );
    } catch (error) {
      return `（直近の状況をまとめられなかった: ${reasonOf(error)}）`;
    }
  }

  /**
   * tick の digest の先頭に載せる「記憶の床」の1行（#553 F2）。
   *
   * ## 目的（依頼者の明示指定）
   *
   * 書き込みを止める門ではない。畳むことを強制しない。**tick という区切りに
   * 数が在れば読む**、という1点のためだけに、文字列を1行足すだけである。
   * 判断（畳むかどうか）は常にクローンが下す——`describeMemorySessionDelta`
   * の doc の「閾値を置かない」と同じ理由。
   *
   * ## 使う計器は書き込み応答と同じもの
   *
   * `describeMemorySessionDelta`（`memory.ts`）をそのまま呼ぶ——`tools.ts` の
   * `memorySessionGrowthNote`（`memory_write` 等の応答）が使っているのと同じ
   * 関数である。書き込み応答の計器と tick の計器が違う値を出すと、どちらを
   * 信じるかという要らない判断が増える。
   *
   * ## 分母は `#promptMemoryChars`、床の絶対値は `measureMemoryFloor`
   *
   * 軸は「セッション構築時点からの増分（%）」。分母（セッション構築時点の値）
   * は `#promptMemoryChars`——**セッションの間は固定**の値であり、実際に
   * いま払っている額そのもの（`describeMemorySessionDelta` の doc「なぜ
   * セッション構築時点を基準にするか」と同じ理由）。床の絶対値は
   * `measureMemoryFloor(await this.#stores.persona.documents()).totalChars`
   * ——毎ターン焼き込みに実際に載る分量そのもの。
   *
   * ## `#promptMemoryChars === 0`（まだセッションが組まれていない）
   *
   * tick は `#runInternal`（＝ `#ensureQuery`）より**前**に digest を作るので、
   * プロセス起動後・最初のセッションがまだ組まれていない tick が実在しうる。
   * このとき `#promptMemoryChars` は「セッション構築時点との差」を計れる値
   * ではなく、単に「まだ組まれていない」ことを意味する——0文字の基準が
   * 実在するのと区別が付かない値なので、**`describeMemorySessionDelta` へは
   * `injectedMemoryChars: null` を渡す**（現在値だけを出し、それが構築時点
   * との差ではないと明記する既存の文言に倒れる）。線の判定も出さない——
   * 「基準がまだ無いので線の判定は出せない」と書く（`0` を基準として
   * 「n 文字増えた」と名乗らせない。AGENTS.md 地雷表「取れない軸に 0 の
   * 行を作る」）。
   *
   * ## 前回の tick との差分
   *
   * `#lastTickMemoryFloorChars` に、直近の tick が測った床の絶対値を控えて
   * おく。**永続化しない**——器が再起動すれば失われ、再起動後の最初の tick は
   * 「前回の tick が無い」として扱う（依頼者の明示指定。それが正しい）。
   * 測定に失敗した回はこの値を更新しない——「前回」の意味を「直近の
   * *成功した* 測定」に保つため。
   *
   * ## 基準が取り直された（resume 等）
   *
   * `#lastTickMemoryBaselineChars`（前回 tick 時点の `#promptMemoryChars`）と
   * 今回の値が食い違うなら ⚠️ を足す。**両方が0でなく、かつ違うときだけ**
   * 発火する（私の判断——0 は「まだセッションが無い」を表す番人の値であって
   * 「基準が0文字だった」という実在の基準ではないので、0 が絡む食い違いは
   * この「取り直された」の対象にしない。0→非0 は単なる初回の確立であって、
   * resume が作る「% が説明なく下がる」驚きには当たらない）。
   *
   * ## 床が測れなかった
   *
   * `persona.documents()` が投げたら、「測れなかった＋理由」だけを書き、
   * 数を1つも作らない。digest 全体は落とさない（既存の `#recentDigestBare`
   * の `try/catch` と同じ規律）。この回は `#lastTickMemoryFloorChars` /
   * `#lastTickMemoryBaselineChars` のどちらも更新しない。
   *
   * ## 線の判定は丸めた後の値で行う。そして**線に達したら**印を出す
   *
   * `describeMemorySessionDelta` が表示する百分率は小数第1位で丸めている
   * （`memory.ts` の `formatMemoryPercentDelta`）ので、線に達したかの判定も
   * 同じ丸め方をした値で行う——生の値で判定すると「+10.0%」と表示されて
   * いるのに印が出ない、という表示と判定の食い違いを作りうる。
   *
   * **比較は `>` ではなく `>=` である**（依頼者の明示指定）。読み手（クローン）
   * が自分の記憶へ毎回書いている語が「床が構築時点から +10% に**達した**ので
   * 畳んだ」であり、「超えた」ではないため——判定の側を読み手の語に合わせる。
   * 文言も「超えている」ではなく「達している」にしてある（`>=` のまま
   * 「超えている」と書くと、ちょうど線上の回に嘘を書くことになる）。
   * **稀にしか起きない境界だが、倒す費用が0に近い側へ倒してある**——この印の
   * 読み手は1人で、表示と判定が食い違う形はその1人の判断を1回誤らせる。
   *
   * 線の印は**達している間ずっと出す**（達した最初の1回だけにしない——
   * 依頼者の明示指定）。
   */
  async #memoryFloorDigestLine(): Promise<string> {
    let documents: MemoryDocument[];
    try {
      documents = await this.#stores.persona.documents();
    } catch (error) {
      return `記憶の床: 測れなかった（理由: ${reasonOf(error)}）。`;
    }

    const afterChars = measureMemoryFloor(documents).totalChars;
    const injectedMemoryChars = this.#distillMemory.promptMemoryChars;
    const sessionDelta = describeMemorySessionDelta({
      afterChars,
      injectedMemoryChars: injectedMemoryChars === 0 ? null : injectedMemoryChars,
    });

    const tickDiffNote =
      this.#distillMemory.lastTickMemoryFloorChars === null
        ? '前回の tick が無いので差分は出せない（このプロセスでの最初の tick）。'
        : `前回の tick から ${formatSignedMemoryCharCount(afterChars - this.#distillMemory.lastTickMemoryFloorChars)} 文字。`;

    const thresholdNote =
      injectedMemoryChars === 0
        ? '基準がまだ無いので線の判定は出せない。'
        : roundToOneDecimal(((afterChars - injectedMemoryChars) / injectedMemoryChars) * 100) >=
            MEMORY_FLOOR_SESSION_GROWTH_LINE_PERCENT
          ? `⚠️ 線（セッション構築時点から +${MEMORY_FLOOR_SESSION_GROWTH_LINE_PERCENT}%）に達している。`
          : '';

    const rebasedNote =
      this.#distillMemory.lastTickMemoryBaselineChars !== null &&
      this.#distillMemory.lastTickMemoryBaselineChars !== 0 &&
      injectedMemoryChars !== 0 &&
      this.#distillMemory.lastTickMemoryBaselineChars !== injectedMemoryChars
        ? `⚠️ セッションが組み直されて基準が ${formatMemoryCharCountLocal(this.#distillMemory.lastTickMemoryBaselineChars)} → ${formatMemoryCharCountLocal(injectedMemoryChars)} 文字へ取り直された（% が下がったのは畳んだからではない）。`
        : '';

    this.#distillMemory.recordTick(afterChars, injectedMemoryChars);

    return ['記憶の床:', sessionDelta, tickDiffNote, thresholdNote, rebasedNote]
      .filter((part) => part !== '')
      .join(' ');
  }

  /**
   * 日報 — 人間が普段読む唯一の層（PRD「可観測性」）。
   *
   * クローンに `daily_report_write` で書かせるが、**書かれなかった日を作らない**。
   * 道具を呼び忘れたらその応答をそのまま日報にする。ここで穴が開くと、人間が
   * 見ようとしたときに見えないという、要件上バグとして扱う状態になる。
   *
   * ## **ターンが失敗したときの応答を日報にしないこと**
   *
   * 実際に起きた壊れ方は、日報の本文が丸ごと
   * `You've hit your org's monthly spend limit · ask your admin to raise it at …`
   * になっていた、というものである。直す前の `#runInternal` は戻り値が `string`
   * 一本で成否を運ばなかったので、ここは**エラーの文言を日報として保存した**。
   *
   * いまは `TurnOutcome` を見る。失敗したときに書くのは
   * `unavailable`（`schema.ts` の doc）の印が付いた行だけで、**本文は日報では
   * ないと分かる形にする**。
   */
  async #dailyReport(
    date: string,
    cause: 'schedule' | 'schedule_catchup' | 'manual' = 'schedule',
  ): Promise<void> {
    const range = localDayRange(date);
    const axes = range === null ? null : await this.#managerDigestAxes();
    const digest =
      range === null || axes === null
        ? await this.#recentDigestBare()
        : await buildActivityDigest(
            this.#stores,
            range,
            axes.liveness,
            axes.awaitingBackground,
            await this.#providerGapLines(),
          ).catch((error: unknown) => `（この日の記録をまとめられなかった: ${reasonOf(error)}）`);

    // **このターンへ何が入ったかを残す**（#243）。日報は結果（`daily_report` の行）
    // しか残っていなかったので、「何を材料に書いたか」が後から取れなかった。digest の
    // 全文は書かない（`turn-input.ts` の doc）。`cause` は呼び出し側
    // （`case 'timer'`）が運んできた値をそのまま載せる — 定刻どおりか、起動時の
    // 後追い（`missingDailyReportDates`）か、`POST /schedule/daily_report/run`
    // による手動実行かを日誌の上で区別できるようにする（`turn-input.ts` の
    // `daily_report` の doc）。
    await this.#journal(turnInputEntry({ type: 'daily_report', date, cause, digest }));

    const outcome = await this.#runInternal(buildDailyReportPrompt({ date, digest }));

    // **枠で保持しているなら、痕跡を1つも残さずに引き下がる。** この合図は
    // 捨てられておらず（`#pump` の `finally` が `defer` する）、枠が開いたら
    // 配り直されてこの関数がもう一度走る。ここで印だけでも書いてしまうと、
    // 下の早期 return と `missingDailyReportDates`（`schedule.ts`）の両方が
    // 「もう書いた」と判断して、**本物の日報が永久に書かれない**。
    if (outcome.status === 'failed' && outcome.heldForUsage) return;

    // **読めなかった回を「日報が無い」と扱わない**（#2447）。前は `.catch(() => [])`
    // で `existing = []` に倒しており、本物の日報がある日にもう1本書き、失敗の回には
    // 「作れなかった」の印を重ねて書いた。
    //
    // **ただし枠での保持のように、書かずに引き下がる形にはしない。** 引き下がる根拠は
    // 「合図が捨てられず、配り直されて、もう一度ここへ来る」ことだったが、既存確認の
    // 失敗にはその配り直しが無い。後追い（`missingDailyReportDates`）は起動時に1回
    // しか走らず、しかも同じ日誌を読む。引き下がれば、動いているあいだその日の
    // 日報は書かれず、**本物の日報が永久に書かれない**側へ倒れる（上の枠の話と同じ穴）。
    // しかもターンはもう走り終わっていて、本文は手の中にある。
    // ⟹ **書く。ただし重複の可能性を日誌に残す。** 失敗の回の印は、1日1件を
    // 確かめられないので積まない（印が無くても後追いは本物を拾う）。
    let existing: JournalEntry[] = [];
    try {
      const written: JournalEntry[] = await this.#stores.journal.list({
        types: ['daily_report'],
        limit: DAILY_REPORT_LOOKUP,
      });
      existing = written.filter(isDailyReport).filter((entry) => entry.date === date);
    } catch (error) {
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_FAILURE_PREFIX}日報の既存確認（${date}）で日誌を読めなかった` +
          `（理由: ${reasonOf(error)}）。` +
          (outcome.status === 'failed'
            ? 'この日の日報が既にあるか確かめられなかったので、「作れなかった」の印は書かなかった。'
            : 'この日の日報が既にあるか確かめられないまま書いた。同じ日に日報が2本ある' +
              'ならこの回の重複（消さずに日誌から辿ること）。'),
      });
      if (outcome.status === 'failed') {
        // 印を書けなかっただけで、失敗した日報であることは変わらない。再起動まで
        // 待たずに作り直す（#2745）。作り直しが成功すれば（読めなければ重複の
        // 可能性つきで）本物が書かれる。
        this.#scheduleDailyReportRetry(date);
        return;
      }
    }
    // **印の付いた行は「日報がある」と数えない**（`schema.ts` の `unavailable` の
    // doc）。数えると、後から本物を書き直す道が閉じる。
    if (existing.some(isWrittenDailyReport)) return;

    if (outcome.status === 'failed') {
      // 印は1日1件でよい。**積むと人間が読む唯一の層が「作れなかった」で埋まる。**
      // 失敗が続いた回数は日誌（`#reportFailure`）に全部残っているので、ここで
      // 数える必要は無い。
      if (existing.length === 0)
        await this.#journal({
          type: 'daily_report',
          date,
          // **SDK の文言をそのまま残す**（人間が検索できる形。`usage-limits.ts` の
          // 「言い換えないこと」と同じ約束）。ただし日報の本文としてではなく、
          // 書けなかった理由として置く。
          body: `（この日の日報は作れなかった。日誌から直接辿ること。理由: ${outcome.reason}）`,
          unavailable: outcome.reason,
        });
      // **印を書いて終わりにしない**（#2745）。枠切れ以外の失敗は一時的なことが多く、
      // 後追い（`missingDailyReportDates`）は起動時に1回しか走らない。有限回、間を置いて
      // 作り直す。印は本物の日報が書かれるまで残る（`isWrittenDailyReport`）。
      this.#scheduleDailyReportRetry(date);
      return;
    }
    this.#dailyReportRetries.delete(date);

    await this.#journal({
      type: 'daily_report',
      date,
      body:
        outcome.text.trim().length > 0
          ? outcome.text
          : '（クローンがこの日の日報を残さなかった。日誌から直接辿ること。）',
    });
  }

  /**
   * 失敗した日報を、間を置いて作り直す合図を積む（#2745）。回数は
   * `#dailyReportRetryDelays` の長さで頭打ち。使い切ったら何もしない（印は残っている）。
   */
  #scheduleDailyReportRetry(date: string): void {
    const done = this.#dailyReportRetries.get(date) ?? 0;
    const delay = this.#dailyReportRetryDelays[done];
    if (delay === undefined) return;
    this.#dailyReportRetries.set(date, done + 1);
    const timer = setTimeout(() => {
      this.#dailyReportRetryTimers.delete(timer);
      this.post(dailyReportEvent(date, new Date(), 'schedule_catchup'));
    }, delay);
    timer.unref();
    this.#dailyReportRetryTimers.add(timer);
  }

  /**
   * 蒸留が間に合わなかった区間を、最初のターンで1度だけ断る（Issue #564 の (b)）。
   *
   * **判定そのものはここに書かない。** 基準は `distill-gap.ts` の
   * `deriveDistillGapFromJournal` が1本で持つ（`memory.ts` の derive 2本と
   * 同じ形・同じ理由 —— 基準が散ると、片方だけ直して残りが古い基準のまま、
   * という穴ができる）。ここが持つのは**いつ載せるか**だけである。
   *
   * **蒸留のターンには載せない。** 記憶へ移すためだけの内部ターンであって、
   * しかも `stop()` 経由の蒸留はこの直後にプロセスが消える
   * （`#commitmentNoticeFor` が同じ判断を逐語で持っている）。**印も下ろさない**
   * ので、次の通常のターンで改めて載る。
   *
   * **読めなくても空文字を返してターンを進める。** 断り書きが組み立てられない
   * ことでターンまで止めたら、いま塞いでいる穴より広い穴になる
   * （`#commitmentNoticeFor` と同じ）。**印は読む前に下ろす** —— 日誌が壊れて
   * いれば毎ターン同じ読み出しを繰り返すことになり、鳴らない断り書きのために
   * 全ターンが重くなる。
   */
  async #distillGapNotice(kind: 'normal' | 'distill'): Promise<string> {
    if (kind === 'distill') return '';
    if (!this.#distillMemory.takeDistillGapNoticePending()) return '';

    try {
      const gap = await deriveDistillGapFromJournal(this.#stores.journal, {
        until: this.#distillMemory.bootAt,
        activityScanLimit: DISTILL_GAP_ACTIVITY_SCAN_LIMIT,
      });
      if (gap === null) return '';
      return `${describeDistillGap(gap)}\n\n---\n\n`;
    } catch (error) {
      noteDroppedRecord('蒸留の区間の読み出し', `until=${this.#distillMemory.bootAt}`, error);
      return '';
    }
  }

  /**
   * 文脈窓で畳んだことを、**次の通常のターンで1度だけクローン自身へ断る**（#553）。
   *
   * **`#distillGapNotice` と同じ形にしてある** —— 印を下ろしてから文を返し、
   * 蒸留のターンには載せない（印も下ろさないので、次の通常のターンで改めて載る）。
   *
   * ## ⭐ 読み直す口の名前を書く
   *
   * 「読み直せる」だけだと、クローンは次のターンで**口を探すところから始める。**
   * `conversation_read` と書いてあれば1手で済む。**依頼元（クローン）の逐語の条件
   * である** —— 読むのはクローン自身なので、そこは読む側が決めた。
   *
   * ## ⛔ 「どうすべきか」は書かない
   *
   * 読み直すかどうかはクローンの判断である（`usage-limits.ts` の
   * `describeUsageNotice` と同じ約束）。ここが渡すのは**何が起きたか**と
   * **どの口で読めるか**だけで、「読め」とは書かない。
   */
  #contextWindowFoldNotice(kind: 'normal' | 'distill'): string {
    if (kind === 'distill') return '';
    if (!this.#distillMemory.takeContextWindowFoldNoticePending()) return '';
    return (
      '[system] 直前のターンが文脈窓（プロンプトの長さ）に当たって失敗したので、' +
      'このセッションは前の会話を引き継がずに開き直したものである。' +
      '**⟹ あなたはそれまでのやりとりを文脈として持っていない。**' +
      'ただし会話の記録そのものは消えていない（`conversation_read` で読み直せる。' +
      '生ログはアーカイブに退避してある）。' +
      '⚠️ 記憶（システムプロンプトの「現在の記憶」）はそのままである' +
      '——失われたのは会話の文脈だけである。\n\n---\n\n'
    );
  }

  /**
   * システムプロンプトはセッション開始時に固定されるので、走行中に人間が記憶を
   * 書き換えても届かない。ターンごとに差分を見て、変わっていたら本文の前に
   * 載せ直す（受け入れ基準3: 手編集が次の会話に反映されること）。
   *
   * **載せ直すのは実際に変わった文書だけである。** 記憶はもうシステムプロンプトに
   * 全文が載っており、そこへ全文をもう一度置けば、変わっていない文書まで二重に
   * 文脈へ載る。しかも載せ直した塊は会話の履歴として残るので、直すたびに写しが
   * 増え、resume でもそのまま運ばれる。「どの文書か」を指せる形（`slug.md` の
   * 見出し。システムプロンプトに載っているものと同じ見出しである）で差分だけを
   * 渡し、載っていない文書は変わっていないと明示する。
   *
   * **削除は名前だけで伝える。** 消えた文書の本文を載せ直す意味は無く、載せれば
   * 「消したのに文脈には居る」という一番まぎらわしい状態になる。
   *
   * ## ⭐ 文書の中も絞る——「変わった量」ではなく「文書の大きさ」を払っていた
   *
   * 上の「変わった文書だけを載せる」は**文書の単位**の絞り込みであり、1文書の
   * 中は全文のままだった。**その結果、1回の書き換えの費用は「変えた量」ではなく
   * 「その文書の大きさ」で決まっていた。**
   *
   * 本番（Railway）の実測。2026-09-08T00:15Z に PostgreSQL を直接引いた値である:
   *
   * | 測ったもの | 値 |
   * | --- | --- |
   * | `alteroid-work`（premise）の大きさ | 305,536 文字 |
   * | 同文書の更新回数（2026-09-07 の1日） | **120 回** |
   * | 1回あたりの実際の変更量（同日の平均） | 3,732 バイト ＝ **約 60 倍の増幅** |
   * | `describe`（要旨だけを直す）の変更量 | 520 バイト → 310,325 バイトが載る ＝ **約 600 倍** |
   * | クローンのターン1回の文脈（1日平均） | 2026-09-02 457k → 2026-09-07 **752k** トークン |
   * | 自動 compaction の回数（1日） | 2026-09-02 0 回 → 2026-09-07 **33 回** |
   * | 載せ直し1回が文脈を押し上げた量（実測の1ターン） | 507,081 → 745,129 ＝ **+238,048 トークン** |
   *
   * ⟹ `renderMemoryDocuments` へ `seenContent`（クローンが既に見ている版）を
   * 渡し、**変わった範囲だけ**を載せる（`memory.ts` の `renderPremiseDelta`）。
   * 省いた側は必ず行数と文字数で名乗る。
   *
   * **⚠️ 「省いた」と「消えた」を混ぜないための断りが、この関数の側にも要る。**
   * だから `head` は「変わった範囲だけが載る」ことと「全文は `memory_read`」を
   * 明言する——省略が黙って行われると、クローンはそれを記憶の破損として読む。
   *
   * **⚠️ そして `head` は、システムプロンプトの記憶が何であるかも言い直した。**
   * 以前は「システムプロンプトに載っているものが現在の内容である」と書いて
   * いたが、これは**嘘である**——システムプロンプトは `#buildSessionSpec` が
   * セッションを組むときに1回だけ焼くので、載っているのは**セッション構築時点**
   * の内容である。全文を毎回載せ直していた間はその嘘が実害にならなかった
   * （現在の全文がすぐ下に在った）が、差分にした以上は正しく言う必要がある。
   * 本番のクローンのセッションは 2026-09-02 から 2026-09-07 まで**1本のまま**で、
   * その間ずっと 6 日前の記憶が「現在の内容である」と名乗っていた。
   *
   * **⚠️ 断り書きを正しくしただけで、古びること自体は直していない。** 全文の
   * 持ち主はシステムプロンプトであり（`renderMemoryDocuments` の doc「`premise`
   * は全文。切り詰めない」）、その持ち主が組み直されない限り古びていく。
   * **⟹ ここを読んで「差分にしたのだから全文はどこかに在るはずだ」と考えた
   * 人は、Issue #696 を見ること**（セッションを組み直す条件と、組み直したことを
   * 観測する手段の両方が、まだ無い）。
   *
   * ## ⭐ 「載せていない」を「存在しない」と言わない
   *
   * 差分だけを渡すと、`renderMemoryDocuments` は**渡された集合の中でしか
   * `parent` を解決できない。** 親が今回変わっていないだけで
   * 「親 X が見つからない」（＝その文書はそもそも無い）と出ていた——実測
   * 2026-09-02、クローンがこれを「記憶の階層が壊れた」と読んで `memory_list` を
   * 呼び直している。**この断りの1行目（「ここに出ていない文書は変わっていない」）
   * と正面から矛盾する印を、同じ塊の中で出していた。**
   *
   * だから `presentInMemory` に**記憶の全体の文書**（`documents`。ストアから
   * 読み直したそのままの配列）を渡す。載せる文書は差分（`changed`）のままで、
   * **「無い」と「今回載せていない」の区別だけが戻る。**
   *
   * **`documents` をそのまま渡せる——`present`（slug の `Set`）を新しく作る
   * 必要は無い。** `RenderMemoryDocumentsOptions.presentInMemory` の型は
   * `readonly MemoryPart[]`（`memory.ts`）で、`MemoryDocument` はこれへ構造的に
   * 代入できる。**`present` 自体は消していない**——`removed`（消えた文書名の
   * 列挙）の判定に引き続き使っているので、ここでは選り分けの手間を
   * `presentInMemory` の側だけで省いた形になる。
   *
   * **循環の検出も記憶の全体で行われるようになった。** `documents` を渡す前は
   * 「循環の一部が差分の外を通る」形（a → b → c → a で c だけが今回の差分に
   * 無い）を `cycle` として検出できず、`parent-not-rendered` に落ちていた
   * （`resolveMemoryHierarchy` の doc）。`documents` を渡す形にしたことで、
   * その欠落もここで一緒に埋まる——`#withFreshMemory` 側で追加の作業をした
   * わけではなく、`presentInMemory` の型が「slug の集合」から「文書の全体」へ
   * 変わったことの副産物である。
   */
  async #withFreshMemory(text: string): Promise<string> {
    let documents: MemoryDocument[];
    try {
      documents = await this.#stores.persona.documents();
    } catch {
      // 記憶が読めないことでターンまで止めない。**ただし `#memoryOnRecord` も
      // 触らない** — 触れば「載せた」ことになり、次のターンで差分が消える。
      return text;
    }

    const { changed, removed } = this.#distillMemory.diffAgainstRecorded(documents);

    // resume の断りは、載せ直すものが無くても1度だけ出す（それが目的である）。
    const resumeNotice = this.#distillMemory.takeResumedHistoryHasMemory()
      ? RESUMED_MEMORY_NOTICE
      : null;

    // **要約に潰された直後は、索引を丸ごと載せ直す**（`#memoryIndexRefreshPending`）。
    // **印は載せ直すものが無くても下ろす** —— 下ろさないと、記憶が動くまで印が
    // 残り続け、何ターンも先の無関係な更新に相乗りして載る。
    const refreshIndex = this.#distillMemory.takeMemoryIndexRefreshPending();

    if (!refreshIndex && changed.length === 0 && removed.length === 0) {
      return resumeNotice === null ? text : [resumeNotice, '', '---', '', text].join('\n');
    }

    // **控えを差し替える前に、いまの控え（＝クローンが見ている版）を退避する。**
    // 下の `renderMemoryDocuments` はこれを見て「変わった範囲だけ」を描く
    // （`memory.ts` の `RenderMemoryDocumentsOptions.seenContent`）。順序を
    // 逆にすると、退避したつもりの `Map` が新しい内容で埋まっていて、差分が
    // 常に空になる＝**何も載らないのに「更新された」とだけ言う**形になる。
    const seenContent = this.#distillMemory.commitMemory(documents);

    const head = refreshIndex
      ? '[system] この会話の文脈が要約に潰された。**それまでに載せた記憶の差分も、その要約の中へ' +
        '畳まれている**（残っているとは限らない）。だから**いまの索引を丸ごと載せ直す** —— ' +
        '下に在るのが現在の記憶の全体（要旨と節の目次）であり、システムプロンプト側の' +
        '「現在の記憶」より新しい。食い違ったら下を採ること。' +
        '**節の本文はどこにも載っていない——要るなら `memory_section_read` で開くこと。**'
      : '[system] 記憶が更新された（人間が直接書き換えたか、あなた自身が更新した）。' +
        '**変わった文書だけを載せる。ここに出ていない文書は変わっていない。**' +
        '載っている文書も、大きく変わっていなければ**変わった範囲だけ**が載る' +
        '（省いた側は行数と文字数で名乗ってある）。' +
        'システムプロンプトの「現在の記憶」は**このセッションを組んだ時点の索引**（要旨と節の目次）であり、' +
        'それに続けてこれらの差分を当てたものが現在の索引である。' +
        '**節の本文はどこにも載っていない——要るなら `memory_section_read` で開くこと。**';

    return [
      ...(resumeNotice === null ? [] : [resumeNotice, '']),
      head,
      // **索引の載せ直しは `seenContent` を渡さない**（差分ではなく全体を描く）。
      // 渡すと「変わった範囲だけ」に縮み、潰された分を埋める役に立たない。
      ...(refreshIndex
        ? ['', renderMemoryDocuments(documents)]
        : changed.length === 0
          ? []
          : ['', renderMemoryDocuments(changed, { presentInMemory: documents, seenContent })]),
      ...(removed.length === 0
        ? []
        : [
            '',
            `削除された記憶: ${excerptLine(
              removed.map((slug) => `${slug}.md`).join(' / '),
              CLONE_ID_LIST_EXCERPT,
            )}`,
          ]),
      ...(documents.length === 0 ? ['', '（記憶は空になった）'] : []),
      '',
      '---',
      '',
      text,
    ].join('\n');
  }

  #pushInput(text: string, images: readonly AgentInputImage[] = []): void {
    // **`#usageBlockedAccumulatedChars` を積む場所はここ1か所だけ**
    // （`#usageBlockedAccumulatedChars` の doc。Issue #1240）。モデルへ実際に
    // 渡す文字列の長さそのものを数える——`#runTurn` 側で数え直すと、並び順
    // （`composeTurnInputText`）が変わったときに二重管理になる。**成功すれば
    // 別の場所（`turn_ended` の成功枝）で 0 へ戻すので、健全なセッションでは
    // ここは大きくならない。**
    this.#usageBlockedAccumulatedChars += text.length;
    this.#sdkSession.enqueueInput(images.length === 0 ? { text } : { text, images });
    this.#sdkSession.wakeInput();
  }

  async *#inputStream(): AsyncGenerator<AgentUserInput> {
    for (;;) {
      const next = this.#sdkSession.dequeueInput();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#sdkSession.stopped) return;
      // **認証トークンを回したので、このセッションを畳んで作り直す**（Issue #393 PR4）。
      //
      // **ここが「ターンの境界」である** —— 積まれた入力が無く（上の `shift` が
      // `undefined`）、走っているターンも無い（`#turn === null`）。
      //
      // ## 途中で畳んではいけない理由は2つあり、どちらも既定の設定で必ず踏む
      //
      // 1. **既定（`free_exhausted`）は `rejected` で回すが、そのターンは成功しうる**
      //    （課金枠で通る。`usage-limits.ts` の「1つぶんの状態でしかない」）。
      //    途中で畳むと**通るはずだった仕事を殺す**
      // 2. **`#read` の `finally` は、未完のターンが在ると失敗を報告する**
      //    （すぐ上の `if (turn) { … 'クローンのセッションが終了した' }`）。
      //    ⟹ 途中で畳むと、**回したことが依頼者には「セッションが終了した」という
      //    失敗として届く**
      //
      // **`#stopped` に相乗りしないこと。** あれはクローン全体の停止であり、
      // 混ぜると「トークンを回したらクローンが止まる」になる。
      // **文脈窓で畳む印も同じ境界で見る**（#553）。理由も条件も上と同じで、
      // 違うのは作り直すときに resume しない点だけである
      // （`#recycleForContextWindow` の doc）。**印を2つに分けているのは、
      // トークンを回すだけで会話が切れないようにするためである。**
      if (
        (this.#sdkSession.wantsTokenRecycle || this.#sdkSession.wantsContextWindowRecycle) &&
        this.#sdkSession.turn === null
      ) {
        /**
         * **トークンのために畳んだのなら、畳んだことを知らせる**（人間の決定
         * 2026-09-07。{@link CloneOptions.onTokenSessionRecycled}）。
         *
         * **ここが「畳んだ後」の唯一の地点である。** `return` で入力の流れが
         * 終わり、次の `#ensureQuery()` が新しい鍵でセッションを起こす ⟹
         * ここから先に届く合図は、必ず新しい鍵で受け取られる。
         *
         * **文脈窓のほう（`#recycleForContextWindow`）では鳴らさない。** あちらは
         * 鍵と無関係で、鳴らすと「トークンが戻った」という嘘の合図が入る。
         *
         * **投げさせない。** 知らせの失敗でセッションの作り直しを巻き添えに
         * しない —— 畳むことはもう決まっている。
         */
        const recycledForToken = this.#sdkSession.takeTokenRecycle();
        if (recycledForToken && this.#onTokenSessionRecycled !== undefined) {
          try {
            this.#onTokenSessionRecycled();
          } catch (error) {
            noteDroppedRecord('認証トークンのセッション作り直しの知らせ', 'clone', error);
          }
        }
        return;
      }
      await this.#sdkSession.waitForInput();
    }
  }

  // -------------------------------------------------------------------------
  // SDK セッション
  // -------------------------------------------------------------------------

  /**
   * resume する前に、その鍵の大きさを確かめる（#1283 の OOM、段2）。
   *
   * **`load()` には一切触れない。** 大きすぎる鍵はそもそも `load()` を呼ばない
   * ことで SDK の契約（返す内容は削れない）を守る——`readTail` の doc「末尾だけ
   * を読む口」と同じ考え方を、resume するかどうかの判断そのものへ広げている。
   *
   * ## 既存の「畳んで作り直す」機構との違い
   *
   * `#noteContextWindowFold` / `#noteUnproductiveUsageBlockFold` も同じ
   * 「新しい鍵で始める」を行うが、**どちらもターンが少なくとも1本走った後にしか
   * 発火しない**（`#query !== null` が門）。今回の OOM は起動直後——ターンが
   * 1本も走っていない `#ensureQuery` の中で `load()` が呼ばれた瞬間に起きるので、
   * 既存の2つの引き金は間に合わない。ここが3つ目の、より早い引き金である。
   *
   * ## 判定できないときは resume する側へ倒す
   *
   * 測れない理由は3つあり、**どれも黙って通す**（AGENTS.md 地雷表「判定できない
   * ときは能力を削らない側へ倒す」）。`#noteLostSession` が同じ形（空振りする
   * 条件を黙って通す）を既に採っている:
   *
   * | 理由 | なぜ黙るか |
   * | --- | --- |
   * | 生ログの預け先が無い（fs 構成） | 測る材料そのものが無い。日誌へ書くと、fs で
   *   起動するたびに同じ1行が積もる |
   * | `projectKey` を誰も知らない | 配備してから1度も `append` が来ていない窓
   *   （`SessionRegistry.getProjectKey` の doc） |
   * | 測る呼び出し自体が失敗した | DB が一時的に不調でも、resume できた可能性を
   *   先に潰さない |
   *
   * **予算を超えたときだけ日誌へ1行残す**（実測バイト数・予算・だから resume
   * しなかった、が分かる文言。数を捨てない）。上の3つの空振りは黙って通す——
   * 通常の起動のたびに同じ1行が積もることを避ける（`#noteLostSession` と同じ
   * 理由）。
   *
   * **古い resume 素材を明示的に捨てはしない。** 次のセッションが `init` すれば
   * `session_started` が新しい id で上書きする（既存の配線）。捨てなくても、
   * 次回の起動はこの関数をもう一度通るだけで同じ判定に落ち着く——安全側に
   * 倒すたびに書き込みを増やす必要はない。
   */
  async #resumeCandidateWithinBudget(sessionId: string): Promise<string | null> {
    const tail = this.#stores.sessionTranscriptTail;
    if (tail === undefined) return sessionId;

    const projectKey = this.#projectKey ?? (await this.#stores.sessions.getProjectKey());
    if (projectKey === null) return sessionId;

    let bytes: number | null;
    try {
      bytes = await tail.measureSize({ projectKey, sessionId });
    } catch (error) {
      noteDroppedRecord('resume 前のセッションの大きさの計測', sessionId, error);
      return sessionId;
    }
    if (bytes === null) return sessionId;
    if (bytes <= RESUME_SIZE_BUDGET_BYTES) return sessionId;

    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_DECISION_PREFIX}resume 素材が大きすぎるので resume せず新しいセッションで始める: ${sessionId}` +
        `（${bytes} バイト ＞ 予算 ${RESUME_SIZE_BUDGET_BYTES} バイト）`,
    });
    return null;
  }

  /**
   * このクローンが、これまでに一度でも SDK セッションを起こしたことがあるか。
   * `case 'distill'`（セッションが無い枝、Issue #1650 後始末）だけが使う。
   *
   * **`#distillMemory.hasUndistilledActivity` では代用できない。** あちらは
   * プロセスを起こすたびに `true` へ戻る（前のプロセスの終わり方をこの層からは
   * 知れないための保守的な既定——`CloneDistillMemoryState` の doc）ので、
   * 「確認された活動」と「知らないので活動が在ると仮定しているだけ」を
   * 区別できない。**ここで要るのはプロセスをまたいで残るほうの信号である。**
   *
   * `stores.sessions` の `cloneSessionId` を見る——`session_started`
   * （`#apply` の該当 `case`）で必ず立ち、通常の終了では下ろさない。下ろす
   * のは文脈窓の畳み・resume 素材の破棄という別の理由のときだけ
   * （`#noteContextWindowFold` / 直後の `catch` 節）。⟹ **非 null なら、この
   * クローンは過去に少なくとも1回はセッションを起こしている**（＝一度も活動
   * していない、ではない）。
   *
   * **読めなかったら「活動が在った」側へ倒す。** 読めないことを理由に見送りの
   * 記録を落とすと、#1650 が塞ぎたかった「記録の欠落」をこの層自身が新しく
   * 作ることになる。
   */
  async #everHadSession(): Promise<boolean> {
    try {
      return (await this.#stores.sessions.getCloneSessionId()) !== null;
    } catch (error) {
      noteDroppedRecord('一度でも活動したかの確認', '', error);
      return true;
    }
  }

  async #ensureQuery(): Promise<void> {
    if (this.#sdkSession.query) return;

    const storedResume = await this.#stores.sessions.getCloneSessionId();
    // **`load()` を呼ぶ前に大きさを測る**（#1283 の OOM、段2）。超えていたら
    // `resume` を `null` にして渡さない＝新しいセッションで始める
    // （`#resumeCandidateWithinBudget` の doc）。
    const resume =
      storedResume === null ? null : await this.#resumeCandidateWithinBudget(storedResume);
    this.#sdkSession.beginSession(resume);
    // **セッションごとに戻す。** 生ログの在り処を持ち越すと、別のセッションの
    // 生ログをいまの `sessionId` の名前で退避することになる（`#transcriptPath` の
    // doc）。`#sessionAnswered` を持ち越すと、暴走の止めが前のセッションの成功で
    // 解けてしまう。
    this.#distillMemory.clearTranscriptPath();
    this.#sessionAnswered = false;
    // **`#sessionAnswered` と同じ理由・同じ場所で戻す**（issue #955 の (A)）。
    this.#heldInSession = false;
    // **`#sessionAnswered` と同じ理由・同じ場所で戻す**（Issue #1240）。持ち越すと
    // 前のセッションで積んだ文字数が新しいセッションの1回目から引き継がれ、
    // まだ1度も試していないのに畳みの敷居へ近い状態から始まることになる。
    this.#usageBlockedAccumulatedChars = 0;
    // **前のセッションで観測した値を持ち越さない。** ここを残すと、新しい
    // セッションの init が届く前（あるいは届かないまま）に `self_status` が
    // 前のセッションのモデル id や effort を「いまの値」として返す ＝
    // 観測していないものを確信することになる（`CloneRuntimeFacts` の約束）。
    this.#forgetObservedFacts();

    const q = this.#driver.open(await this.#buildSessionSpec(resume));
    this.#sdkSession.open(q, this.#read(q));
  }

  /**
   * 人間の MCP 連携の登録を読む（#325 段2）。**本セッションを組むときと、蒸留を
   * 起こすたびに呼ぶ** ⟹ 登録の差し替えは「次のセッション／次の蒸留」から効く
   * （`claude-provider.ts` の `cloneMcpServers` の doc）。
   *
   * **読めなくてもセッションは起こす。** 登録は人間が手で書き換えられる器に在る
   * ので（`FsMcpServerStore` の doc）、壊れた1ファイルでクローンが丸ごと起きなく
   * なる形にはしない —— 外部の連携なしで起き、**そのことを日誌に残す**（黙って
   * 空で起きると「登録したのに0本」が原因の出ない形で起きる）。理由の文言には
   * 値を載せない（`parseMcpServers` と `FsMcpServerStore#read` が名前と欄の
   * 位置しか出さない）。
   */
  async #externalMcpServers(): Promise<McpServers> {
    try {
      return (await this.#stores.mcpServers.read())?.mcpServers ?? {};
    } catch (error) {
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_FAILURE_PREFIX}MCP サーバの登録が読めなかったので、人間の MCP 連携なしで` +
          `このセッションを起こした（理由: ${reasonOf(error)}）。` +
          '登録を直すには人間に PUT /mcp-servers で置き直してもらう。',
      });
      return {};
    }
  }

  async #buildSessionSpec(resume: string | null): Promise<AgentCloneSessionSpec> {
    const documents = await this.#stores.persona.documents();
    const memory = renderMemoryDocuments(documents);

    // **焼き込んだ内容をそのまま「クローンが見たもの」として控える。** ここを
    // 控え損ねると、最初のターンでいきなり全文が載せ直される（システムプロンプト
    // と合わせて二重に載る）。読み直して比べるのではなく、載せた値を控えること —
    // 読み直すと、この行までの間に人間が直した場合に差分を見失う。**戻り値
    // （退避した旧い控え）は使わない**——`#withFreshMemory` と同じ「退避して
    // から差し替える」遷移をそのまま再利用しているだけである。
    this.#distillMemory.commitMemory(documents);
    // 履歴に前のセッションの載せ直しが残っているのは resume のときだけである。
    this.#distillMemory.setResumedHistoryHasMemory(resume !== null);
    // **セッションを組んだ回は、焼き込みが最新である。** 前のセッションで
    // 立った印を持ち越すと、載せる必要が無い索引をもう一度会話へ積む
    // （`#memoryIndexRefreshPending` の doc「下ろすのは …と `#buildSessionSpec`」）。
    // **戻り値は使わない**——ここは「無条件に下ろす」だけの意味で呼んでいる。
    this.#distillMemory.takeMemoryIndexRefreshPending();

    const systemPrompt = buildCloneSystemPrompt({
      memory,
      ...(this.#self === undefined ? {} : { self: this.#self }),
    });
    this.#distillMemory.recordBuiltSizes(systemPrompt.length, memory.length);

    return {
      model: this.#model,
      // Claude 以外の駆動役が、人間が置いたときだけモデルを渡すための印（Claude は読まない）。
      modelPlaced: this.#modelOverridden,
      permissionMode: this.#permissionMode,
      input: this.#inputStream(),
      tools: await this.#cloneToolsFor(this.#toolContext()),
      externalMcpServers: await this.#externalMcpServers(),
      systemPrompt,
      env: this.#childEnv(),
      ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
      // 駆動役の観測（失敗ではないもの。渡していない MCP など）は日誌へ残す。Claude は呼ばない。
      onNote: (text) => {
        void this.#journal({
          type: 'exchange',
          with: 'self',
          role: 'outbound',
          text: `${EXCHANGE_KIND_DECISION_PREFIX}${text}`,
        });
      },
      resume,
      // 預け先は SDK の `SessionStore` を包み直さずそのまま渡す（駆動役が戻す）。
      ...(this.#sessionStore === undefined ? {} : { sessionLog: this.#sessionStore }),
      // 人間が承認した Bash 許可（Issue #863）を消費する唯一の口。中身は
      // `#onPreToolUse` の doc、配線の理由は `claude-provider.ts` の
      // `CloneSessionOptionsRequest.onPreToolUse` の doc。
      onPreToolUse: (record) => this.#onPreToolUse(record),
      onPreCompact: (record) => this.#onPreCompact(record),
      // `self_status` の effort と、**クローンが自分の手を使った跡**をここで拾う
      // （後者は `#onPostToolUse` のコメント）。
      //
      // 1. **`PostToolUse` はツールの実行後に走るので、実行そのものを止められない**
      //    （`PreToolUse` と違ってここで判断を差し込む余地が無い＝観測専用として
      //    安全に足せる）。
      // 2. **`PreCompact` はセッション生涯に対して1本のフックであり、effort は
      //    載らない**（`BaseHookInput.effort` はツール実行の文脈で発火するフックに
      //    しか付かない）。だから既存の `PreCompact` はそのままにし、別の枠へ足す。
      // 3. **クローンは毎ターン MCP の道具を叩く。** `self_status` を呼ぶ時点までに
      //    別の道具呼び出しが1本挟まっていれば、その回で観測済みになっている。
      //    **例外はそのセッションで最初の道具呼び出しそのもの** — そのときはまだ
      //    どの `PostToolUse` も発火しておらず `effort` は `null` のままである
      //    （`CloneRuntimeFacts.effort` のコメントと同じ）。
      onPostToolUse: (input) => this.#onPostToolUse(input),
      // **`PostToolUse` と排他である**（Issue #924 — 出荷済みの SDK 実行体を
      // 実測して確認した。同じ `try/catch` の `try` 側が `PostToolUse` を、
      // `catch` 側が `PostToolUseFailure` を組み立てる）。⟹ 道具呼び出しは
      // 必ずどちらか一方だけを発火させるので、両方に登録しても二重記録には
      // ならない——**片方しか無いままだと、失敗・中断した道具呼び出しが日誌に
      // 1件も残らない**（`docs/architecture.md`「非対称な可視性」が求める
      // 「どちらで見たかは日誌に残す」から静かに落ちていた）。
      onPostToolUseFailure: (input) => this.#onPostToolUseFailure(input),
      // 作業者（サブエージェント）の allow が決着も拒否の記録も無いまま
      // 取り残されたことを検出する唯一の残った合図（Issue #1803）。中身は
      // `#onSubagentStop` の doc、配線の理由は `claude-provider.ts` の
      // `CloneSessionOptionsRequest.onSubagentStop` の doc。
      onSubagentStop: (record) => this.#onSubagentStop(record),
    };
  }

  /**
   * クローンの道具の中継のホスト（`clone-tool-relay-host.ts`）を、**デーモンの
   * 寿命で高々1つ**だけ起こす（Issue #486 48(a) PR2）。
   *
   * ## デーモンの寿命で1つ、を選んだ理由
   *
   * セッションごとに起こす（＝ listen し直す）形と迷った。**デーモンの寿命で
   * 1つの方が安い**——理由は3つ:
   *
   * 1. **クローンは1つのプロセスの生涯で何度もセッションを組み直す**（`resume`・
   *    トークン交代による `recycleSessionForToken`・compaction 後の再開）。
   *    セッションごとに listen し直すと、そのたびに `rmSync` → `mkdirSync` →
   *    `listen` → `chmodSync` の4手が走る——`register()`（token を1本発行する
   *    だけ）に比べて明らかに重い。
   * 2. **listen し直すたびに「listen〜chmod の窓」が新しく開く。** ディレクトリ
   *    側を 0700 にして塞いだ（`clone-tool-relay-host.ts` の doc）とはいえ、
   *    窓の再発生そのものを無くせるなら無くす方が単純である。
   * 3. **`register()` は token を使い捨てにする設計**（`CloneToolRelayHost` の
   *    doc）なので、複数セッションが同じホストを共有しても、古いセッションの
   *    token が新しいセッションの子プロセスに使い回される事故は起きない——
   *    ホストを使い回すことの安全性は元から作り込まれている。
   *
   * **`stdio` のセッションが1度も組まれなければ、この関数自体が呼ばれない**——
   * `#cloneToolsFor` の `'sdk'` 分岐がここへ来ないので、`sdk`（既定）の
   * ままなら listen すら発生しない。
   */
  async #ensureCloneToolRelayHost(): Promise<CloneToolRelayHost> {
    this.#cloneToolRelayHostPromise ??= createCloneToolRelayHost({
      socketPath: join(this.#cloneToolRelaySocketDir, CLONE_TOOL_RELAY_SOCKET_FILENAME),
    });
    return this.#cloneToolRelayHostPromise;
  }

  /**
   * `this.#mcpServerFactory(context)` の結果を、いまの
   * `ALTEROID_CLONE_TOOLS_TRANSPORT`（`#cloneToolsTransport`）に応じてそのまま
   * 返すか、`clone-tool-relay-*` 越しの stdio 設定へ組み替える（Issue #486
   * 48(a) PR2）。**本セッション（`#buildSessionSpec`）と蒸留のサイドクエリ
   * （`#distillFromTranscript`）の両方がこれを通す**——`claude-provider.ts` の
   * `cloneMcpServers` の doc「本セッションと蒸留で同じ関数を通す」と同じ理由で、
   * 経路（transport）も両者で必ず揃える。片方だけ中継越しだと、蒸留のセッション
   * だけ ToolContext の構築点が別になり、`#toolContext()` の doc が挙げている
   * 「片方へ渡し忘れる」穴と同じ形の非対称が transport の軸にも生まれる。
   *
   * **`sdk`（既定）ではここは素通り。** ホストも子プロセスも一切起こさない——
   * 今日と1バイトも変わらない経路のまま。
   *
   * **`stdio` のときだけ**、ホストを（上の `#ensureCloneToolRelayHost` の理由で
   * デーモンの寿命で1つに）起こし、呼ぶたびに新しい token を発行して登録する。
   * `register()` へ渡す関数は道具の実装（`McpServer` インスタンス）を
   * **その関数が実際に呼ばれるまで**作らない——子プロセスが繋がってこない限り、
   * 重い `createCloneMcpServer` を組み立てずに済む（`CloneToolRelayHost.register`
   * の doc と同じ理由）。
   *
   * **`alwaysLoad` はどちらの分岐でも渡さない。** インプロセス（`type: 'sdk'`）
   * の設定にはこの欄自体が無い（SDK の `McpSdkServerConfig` 型に `alwaysLoad` が
   * 無い——`timeout` しか持たない）ので、今日は常に「渡していない」＝ SDK の
   * 既定（tool search が効いていれば defer される）のままである。ここで stdio
   * 側にだけ `alwaysLoad: true` を書くと、**同じ道具なのに transport を
   * 切り替えただけで読み込みのタイミングが変わる**——`clone-tools-transport.test.ts`
   * が両分岐で `alwaysLoad` が無いことを固定する。
   */
  async #cloneToolsFor(context: ToolContext): Promise<AgentCloneTools> {
    if (this.#cloneToolsTransport === 'sdk') {
      return { kind: 'inproc', server: this.#mcpServerFactory(context) };
    }
    const host = await this.#ensureCloneToolRelayHost();
    this.#cloneToolRelayChildEntry ??= resolveCloneToolRelayChildEntry(import.meta.url);
    const token = host.register(() => this.#mcpServerFactory(context).instance);
    return {
      kind: 'stdio',
      command: process.execPath,
      args: [this.#cloneToolRelayChildEntry],
      env: {
        [CLONE_TOOL_RELAY_SOCKET_ENV]: host.socketPath,
        [CLONE_TOOL_RELAY_TOKEN_ENV]: token,
      },
    };
  }

  /**
   * クローンの道具（インプロセス MCP）へ渡す context。**本セッション
   * （`#sessionOptions`）だけが呼ぶ。**
   *
   * **蒸留のサイドクエリ（`#distillFromTranscript`）はここを経由しない。**
   * 同じ形の context を、自分のインラインのオブジェクトリテラルとして
   * 別に組んでいる。**これは意図した設計であって、直し忘れではない** —
   * 統合すると振る舞いが変わってしまう点が2つある:
   *
   * - **`emit`** — 本セッションは実物の `this.#emit` を渡すが、サイドクエリは
   *   `() => undefined`（捨てる）。サイドクエリは `pre_compact` フックから走り、
   *   人間の会話に紐づいていない。しかも**本セッションのターンと同時に
   *   走りうる**ので、実物の `emit` を渡すとサイドクエリの出来事が人間の
   *   chat へ漏れる。
   * - **`managers`** — サイドクエリには渡さない。`ToolContext.managers` の
   *   doc が既に明言している通り、「省略できるのは蒸留用の短命セッションの
   *   ためで、そこではマネージャーを起こさない（記憶へ移すだけの内部
   *   ターン）」。
   *
   * **だから2つを1本の関数へ寄せない。** 寄せると上の2点の意図的な違いを
   * 表現できなくなる（`emit` を実物にしてしまう／`managers` を渡してしまう）。
   *
   * **この結果、`ToolContext` に新しい口を1つ足すときは、ここと
   * `#distillFromTranscript` のインラインのリテラルの2か所へ手で足す必要が
   * ある。** これがまさに「片方へ渡し忘れる」穴の形である — `runtime` が
   * まさにそれで、片方に足し忘れるとその場面だけ `self_status` が「取れない」
   * を返す。`memoryCause` にも同じ注意を書いてある
   * （`ToolContext.memoryCause` の doc）。
   *
   * **`runtime` は本セッションの private フィールドを読むだけの薄い closure。**
   * サイドクエリに渡しても、そちらの init やツール実行は反映されない
   * （`CloneRuntimeFacts.sessionId` のコメントの理由）。
   *
   * **`memoryCause` も同じ形の薄い closure。** ここが読むのは `this.#turn?.kind`
   * だけで、`#distillFromTranscript` 側は自分のインライン context に
   * `memoryCause: () => 'distill'` を固定で持たせている（あちらは常に
   * 蒸留のターンなので、`#turn` を読む必要が無い）。
   *
   * **`conversationId` も必須（#781）で、両方の構築点が明示している。** ここは
   * `this.#turn?.conversationId`（無ければ undefined）を返す薄い closure、
   * `#distillFromTranscript` 側は常に内部ターンなので `() => undefined` を
   * 固定で持たせている。**どちらも関数そのものは省略していない** ——
   * 省略すると `createCloneTools` の歯（`ToolContext.conversationId` の doc）
   * が throw する。
   */
  /** `ToolContext.attachmentCopiesDir`。cwd が無ければ入れない（道具が `os.tmpdir()` 配下へ倒す）。 */
  #attachmentCopiesDirEntry(): { attachmentCopiesDir?: string } {
    return this.#cwd === undefined ? {} : { attachmentCopiesDir: attachmentCopiesDir(this.#cwd) };
  }

  #toolContext(): ToolContext {
    return {
      // **日誌だけを包む（issue #847 の案B）。** 答えのターンの中で道具が書く
      // `decision` / `memory_update` / outbound の `exchange` へ、その承認の id を
      // 立てる。道具を1本ずつ直さない理由は `approval-trace.ts` の
      // `stampingJournal` の doc。**蒸留のサイドクエリの context
      // （`#distillFromTranscript`）には包まない**——あちらは答えのターンと
      // 並行して走りうる。
      stores: {
        ...this.#stores,
        journal: stampingJournal(
          this.#stores.journal,
          () => this.#sdkSession.turn?.approvalId ?? null,
        ),
      },
      emit: (event) => this.#emit(this.#sdkSession.turn?.conversationId ?? null, event),
      // **承認カードを出す道具が、カードの時刻を決める前に呼ぶ**（#3605。`ToolContext.flushReply`）。
      flushReply: () => this.#flushReply(),
      managers: this.#managers,
      ...(this.#profileService === undefined ? {} : { profile: this.#profileService }),
      ...(this.#accountUsage === undefined ? {} : { accountUsage: this.#accountUsage }),
      ...(this.#scheduler === undefined ? {} : { scheduler: this.#scheduler }),
      runtime: () => this.#runtimeFacts(),
      providerGaps: () => this.#providerGapLines(),
      ...(this.#self?.cloneProviderPeers === undefined
        ? {}
        : { cloneProviderPeers: this.#self.cloneProviderPeers }),
      memoryCause: () => (this.#sdkSession.turn?.kind === 'distill' ? 'distill' : 'clone'),
      // **消した合図の配達を止める口**（issue #1049）。これを渡さないと
      // `inbox_remove_many` は1件も消さずに断る（`ToolContext` のその doc）。
      dropQueuedInboxEvents: (ids) => this.dropQueuedInboxEvents(ids),
      // **`manager_list` の受信箱の行に、メモリの配達待ち行列を渡す口**
      // （issue #1133）。`#situationNoticeFor` が読むのと同じ
      // `#queuedInMemoryCount()` を経由する——式を2箇所に書き写さない
      // （そのメソッドの doc「なぜ1本のメソッドに切り出したか」）。
      queuedInMemory: () => this.#queuedInMemoryCount(),
      // **`attachment_fetch` の写しの置き場。クローンの cwd の中**（`Read` が追加の許可なしで開ける）。
      ...this.#attachmentCopiesDirEntry(),
      // **`ask_human` が `PendingApproval.conversationId` を埋めるための口（#768）。**
      // `emit` の1行上と同じ薄い closure —— `#turn?.conversationId` が無ければ
      // （マネージャー発の確認・蒸留・timer など内部ターン）undefined を返す。
      conversationId: () => this.#sdkSession.turn?.conversationId ?? undefined,
      // **`request_permission` が直前の拒否の証拠を添えるための口**（issue #1802）。
      recentDenials: () => this.#recentDenials.list(),
      // **`conversation_post` の1通を、その会話を開いている画面へ流す口**
      // （issue #1393）。1通で閉じる逐次配信なので、本文の直後に `done` を出す。
      postToConversation: (conversationId, text) => {
        this.#emit(conversationId, { type: 'text', text });
        this.#emit(conversationId, { type: 'done' });
      },
    };
  }

  /**
   * 層を動かす provider が持たない能力の行。クローン層（起動時に確定、`SelfFacts`）に、
   * 接続中の runner が名乗るマネージャー層（と作業者層）を**実行時に**足す。
   * `self_status` と日報・発意 tick の digest が使う。システムプロンプトは静的な側だけ。
   */
  async #providerGapLines(): Promise<string[]> {
    const runnerGaps = await collectRunnerProviderGaps(this.#managers, this.#providerOf);
    return [...(this.#self?.providerGaps ?? []), ...runnerGaps];
  }

  /** {@link CloneRuntimeFacts} を、いまの private フィールドから組み立てる。 */
  #runtimeFacts(): CloneRuntimeFacts {
    return {
      // **呼ぶたびに解決する（構築時に凍らせない）。** `resolveBuildRevision` は
      // 実行時の環境変数まで見るので、凍らせるとその経路が「起動時に在ったか」
      // しか答えられなくなる（`revision.ts`「環境変数は呼び出し時に読む」）。
      revision: resolveBuildRevision(),
      // **呼ぶたびに解決する（構築時に凍らせない）。** `resolveBuildTime` は
      // 焼き込みだけを見るので `resolveBuildRevision` ほど理由は強くないが、
      // 形を揃えておく（凍らせても実害は無いが、隣で揃えないと読み手が理由の
      // 違いを詮索することになる）。
      buildTime: resolveBuildTime(),
      declaredModel: this.#model,
      modelOverridden: this.#modelOverridden,
      modelEnvKey: CLONE_MODEL_ENV_KEY,
      sdkModel: this.#sdkModel,
      effort: this.#effort,
      // alteroid はどこでも `options.effort` を渡していない（SDK の既定に任せている）。
      requestedEffort: null,
      claudeCodeVersion: this.#claudeCodeVersion,
      apiKeySource: this.#apiKeySource,
      permissionMode: this.#observedPermissionMode,
      requestedPermissionMode: this.#permissionMode,
      mcpServers: this.#mcpServersInfo,
      sessionId: this.#sdkSession.sdkSessionId,
      resumedFrom: this.#sdkSession.resumedFrom,
      // **ここで `heuristicChars(...)` を通す。** `#promptMemoryChars` /
      // `#systemPromptChars` は素の `number`（`String.length` を直接
      // 控えている私有フィールド）——`CloneRuntimeFacts` の欄は
      // `HeuristicChars` なので、代入するこの1行が単位を名乗り直している
      // 印になる（`quantity.ts` モジュール冒頭の doc）。
      injectedMemoryChars: heuristicChars(this.#distillMemory.promptMemoryChars),
      systemPromptChars: heuristicChars(this.#distillMemory.systemPromptChars),
      lastContextUsage: this.#lastContextUsage,
      ...(this.#self?.providerGaps !== undefined ? { providerGaps: this.#self.providerGaps } : {}),
      ...(this.#self?.cloneProvider !== undefined
        ? { cloneProvider: this.#self.cloneProvider }
        : {}),
      ...(this.#self?.cloneProviderPeers !== undefined
        ? { cloneProviderPeers: this.#self.cloneProviderPeers }
        : {}),
    };
  }

  /**
   * SDK から観測した事実をすべて捨てる（セッションを開き直すとき）。
   *
   * **`#sdkModel` と `#effort` を残さないこと。** モデル帯の宣言は変わらなくても、
   * SDK 側の解決結果はセッションを開き直せば変わりうる（版が上がる／帯の別名が
   * 別の id を指す）。effort も同じで、次のセッションで観測し直すまでは
   * 「まだ分からない」が正しい。
   *
   * **`#lastContextUsage` も同じ理由で戻す。** 文脈占有は「このセッションが
   * いまどれだけ窓を使っているか」であって、セッションを開き直せば窓の中身
   * （記憶の再注入・道具のスキーマ・システムプロンプト）も入れ直しになる——
   * 前のセッションの占有は、次のセッションの自分のものではない。
   */
  #forgetObservedFacts(): void {
    this.#sdkModel = null;
    this.#effort = null;
    this.#claudeCodeVersion = null;
    this.#apiKeySource = null;
    this.#observedPermissionMode = null;
    // **`null` に戻す（`[]` ではない）。** セッションを開き直した直後は「まだ
    // 観測していない」であって「0本と観測した」ではない（#324）。`[]` に戻すと
    // 次の init が届くまでの窓で「0本」と嘘をつく。
    this.#mcpServersInfo = null;
    this.#sdkSession.setSdkSessionId(null);
    this.#lastContextUsage = null;
  }

  /**
   * init で SDK が報告してきた実行時の事実を、`self_status` の材料として控える。
   *
   * **`typeof` で検査し、読めない形は `null` のままにする。** 型定義の上では
   * どれも必須フィールドだが、ここで読み違えて例外を投げると本セッションの
   * 起動そのものが壊れる。読めなかったことは「まだ分からない」として出せば済む
   * （`describeCloneRuntime` 側の仕事）。**`mcp_servers` も同じ扱いにする（#324）**
   * —— この関数は init を観測した後にしか呼ばれないが、`mcp_servers` の形が
   * 読めなかったときにまで「0本」と主張する根拠は無い。読めた配列だけが「0本」
   * を名乗れる。
   */
  #captureInitFacts(facts: AgentRuntimeFacts): void {
    this.#sdkSession.setSdkSessionId(facts.sessionId);
    this.#sdkModel = facts.model;
    this.#claudeCodeVersion = facts.agentVersion;
    this.#apiKeySource = facts.apiKeySource;
    this.#observedPermissionMode = facts.permissionMode;
    this.#mcpServersInfo = facts.mcpServers;
  }

  /**
   * 人間が承認した Bash 許可（Issue #863）に、いま流れてきたコマンドが一致
   * するかを見る。一致すれば `{ kind: 'allow' }` を返し、その許可の
   * `lastUsedAt` を進める。**一致しなければ何も決めない**（`{ kind: 'continue' }`
   * だけを返す——`deny` はしない。一致しないコマンドは、既存の確認フロー
   * （`permissionMode` / 人間の確認）へそのまま委ねる）。
   *
   * **中立の判断（`AgentPreToolDecision`）を返す**（#486 中立の口の3本目）。
   * SDK の `hookSpecificOutput` へ包み直すのは `claude-provider.ts` の
   * `wrapPreToolHook` の仕事——ここは「届いた記録」と「下した判断」だけを
   * 知っている。
   *
   * ## 射程はクローン本セッションの `Bash` だけ
   *
   * - **`Bash` 以外は素通り。** ここは「何でも通しうる門」ではなく、Bash の
   *   許可だけを扱う（地雷表「確認が要る行為の一覧を作る」と同じ理由で
   *   対象を1本に絞る——`runner.ts` の `#onPreToolUse`
   *   （`bash-wait-guard.ts`、deny 側）と同じ絞り方）。
   * - **このフックはクローン本セッション（`#buildSessionSpec` →
   *   `buildCloneSessionOptions`）にしか配線しない。** 蒸留
   *   （`buildCloneDistillOptions`）・マネージャー／作業者
   *   （`runner.ts` が別プロセスで組む `buildManagerSessionOptions`）は
   *   この許可の対象ではない——蒸留は `Bash` を呼ばない設計だが、
   *   マネージャー・作業者は独立した SDK セッションで、この許可のストア
   *   すら見ていない。
   *
   * ## 毎回引き直す（キャッシュしない）
   *
   * `this.#stores.permissionGrants.list()` を呼び出しのたびに呼ぶ。
   * キャッシュすると「取り消しは次の呼び出しから効く」という要件が崩れる
   * ——1回引いて使い回せば、`revoke` した後の呼び出しも古い許可を見続ける。
   *
   * ## `lastUsedAt` の書き込みは失敗しても allow を止めない
   *
   * 観測用の副作用（最終使用時刻）が書けなかったからといって、既に下した
   * 「一致した」という判断を覆さない——`allow` を返すかどうかは一致した
   * 事実だけで決まる。
   *
   * ## `allow` を返した呼び出しを控える（Issue #863 残項目・検出のみ）
   *
   * `record.toolUseId` が読めれば、一致した grant の id / rule を
   * `#allowedByGrantToolUses` へその id をキーに控える——**SDK がこの
   * `permissionDecision: 'allow'` を分類器へ回して、それでも拒否する
   * ことがありうる**（バイナリを静的に読んだ観測。リモートの機能フラグ
   * `tengu_virtual_knuth` が立つと `Hook approved tool use for X, but auto
   * mode requires classifier adjudication` に分岐する）。alteroid のコード
   * からはこの分岐を検出できないので、代わりに「hook が allow を返した直後の
   * 同じ呼び出しが、それでも拒否された」という結果を `#noteDenial` 側で
   * 見分けられるようにする。`toolUseId` が読めない回（古い provider の写し）
   * は控えずに `allow` だけ返す——検出できないだけで、許可そのものは今までと
   * 同じ理由で下す。
   *
   * **`record.agentId` が読めれば、同じ控えへ足す（Issue #1803）。** クローンは
   * `Task` を持つので、この `allow` は作業者（サブエージェント）の `Bash` に
   * も当たる——`agentId` が省かれれば本体の呼び出しと同じ扱いのまま
   * （`#onSubagentStop` はこの欄が無い控えを絞らない＝拾わない）。
   */
  async #onPreToolUse(record: AgentPreToolRecord): Promise<AgentPreToolDecision> {
    if (record.toolName !== 'Bash') return { kind: 'continue' };

    const toolInput = record.toolInput as { command?: unknown } | null | undefined;
    const command = toolInput?.command;
    if (typeof command !== 'string') return { kind: 'continue' };

    const grants = await this.#stores.permissionGrants.list();
    const now = new Date().toISOString();
    for (const grant of grants) {
      if (grant.revokedAt !== undefined) continue;
      if (!matchPermissionRule(grant.rule, command)) continue;
      // `put({ ...grant, lastUsedAt })` にしないこと——lost update
      // （`PermissionGrantStore.markUsed` の doc。#1654 と同型）。`markUsed` が
      // 排他区間の中で現在値を読み直すので、人間の `revoke` 割り込みでも
      // 取り消しが消えない。
      // **判断は写しではなく、この記録の結果に寄せる（Issue #1687）。** `list()` で
      // 読んだ後に人間の取り消しが完了していると、写しの上では生きていても
      // `markUsed` は記録せず `false` を返す——その許可では通さない。
      // **店が例外を投げたときは、これまでどおり写しの読みに倒す**（通す）。
      // 承認 d0f15fb7（`docs/architecture.md`「承認への回答と許可の記録 ——
      // 境界ではなく監査の層」）で、許可の層はセキュリティの境界ではなく監査の層と
      // 決まっている。⟹ 店が例外を投げて再確認できなかったからといって閉じる側へは
      // 倒さない——境界であれば「確かめられなければ拒否」だが、監査の層が保証する
      // のは「正規の口を通った許可が記録に残る」ことなので、その保証を満たせなかった
      // こと自体を跡に残す（`noteDroppedRecord`。本文は出さない——grant の id だけ）。
      // **この窓を塞がない。** 例外と人間の取り消しがちょうど同時に起きた回だけ、
      // 取り消し済みの許可が1回通りうる——監査の層として受け入れた窓である。
      // 道具の呼び出しそのものは `#journalToolUse` で日誌に残る。ただし、どの
      // 許可（grant）で通ったかは残らない——`#allowedByGrantToolUses` はメモリ
      // だけの控えで、`#onPostToolUse` が決着した時点で `delete` する。その許可が
      // 使われた記録（`lastUsedAt`）が今回落ちたことは、この跡でしか分からない。
      const usable = await this.#stores.permissionGrants.markUsed(grant.id, now).catch((error) => {
        noteDroppedRecord('許可を使った時刻（lastUsedAt）', `grant=${grant.id}`, error);
        return true;
      });
      if (!usable) continue;
      if (typeof record.toolUseId === 'string') {
        this.#allowedByGrantToolUses.set(record.toolUseId, {
          grantId: grant.id,
          rule: grant.rule,
          ...(typeof record.agentId === 'string' ? { agentId: record.agentId } : {}),
        });
      }
      return {
        kind: 'allow',
        reason: `人間が承認した許可に一致した（${grant.rule}）`,
      };
    }
    return { kind: 'continue' };
  }

  /**
   * `PostToolUse` フックから effort の実効値と、**自分の手を使った跡**を拾う
   * （`#buildSessionSpec` の hooks コメント参照）。
   *
   * ## なぜ日誌に残すのか
   *
   * `docs/architecture.md`「非対称な可視性」が名指しで求めている
   * — 「**どちらで見たかは日誌に残す。** 委譲が原則である理由（俯瞰と判断を守る）が
   * 守られているかは、禁止ではなく記録で見る」。道具を渡した以上、記録がここに
   * 無いと「委譲していない」が誰にも見えなくなり、方針が守られているかを見る手が
   * 禁止しか残らない。
   *
   * ## なぜ*自前で日誌へ書く道具だけ*を除くのか
   *
   * 除くのは**重複を避けるため**であり、対象は**自前で跡を残す道具に限る** —
   * `memory_write` は `memory_update`、`journal_write` は本文、`manager_start` は
   * 台帳と `tool_use`（マネージャー側の記録）へ落ちる。`manager_send` /
   * `manager_stop` は `tools.ts` の中では書かず、`ManagerPool`（`manager.ts` の
   * `send` / `abort`）経由で `exchange` へ落ちる（`manager_send` が保留中の確認へ
   * 答えた回は `escalation`）——**grep だけだと「書かない」に見える2本である。**ここで重ねて書くと、クローンは毎ターン数本の道具を叩くので日誌が
   * 自分の記録で埋まり、**掘るための層が掘れなくなる**。
   *
   * **自作ツール全部を除いていたら、それはバグである。** 読む道具（`memory_read` /
   * `journal_read` など）は自前では何も書かないので、除くと
   * `docs/architecture.md`「非対称な可視性」が求める「どちらで見たかは日誌に残す」
   * から静かに落ちる — **実際に 19 本がそうなっていた**（`tool.startsWith(...)`
   * 1行が自作ツール全部を素通りにしていた期間。PR #94 以来）。この関数がいま
   * 見るのは「委譲せずに自分で手を動かした」という事実全体であって、そこから
   * 引くのは**自前で跡を残す分だけ**でなければならない（人間の MCP 連携も
   * preset の道具と同じくここに残る — あちらも「自分でブラウザを開いた」側で
   * ある）。
   *
   * **名簿は `tools.ts` に在り、`CLONE_TOOL_NAMES` の全部がどちらか一方に
   * 必ず属することを型で強制している**（`SELF_JOURNALING_CLONE_TOOLS` /
   * `TRACELESS_CLONE_TOOLS`。
   * `CloneToolName` に対する網羅性・排他性のチェック）。道具を1本足す人は、
   * その場でどちらかへ入れることになる — 入れなければ `typecheck` が落ちる。
   *
   * **名簿の間違いは向きで重さが違う。** 自前では書かない道具を誤って
   * `SELF_JOURNALING_CLONE_TOOLS` へ入れると、その道具の使用はどこにも残らない
   * （**監査の穴**）。逆に自前で書く道具を誤って `TRACELESS_CLONE_TOOLS` 側へ
   * 残すと、同じ手を2つの記録で二重に見るだけ（**重複**）で済む。**だから
   * 迷ったら「残す側」（`TRACELESS_CLONE_TOOLS` へ入れる＝除かない）へ倒す**
   * ——`cloneToolJournalsItself` が未知の道具に対して `false`（＝残す）を返すのも
   * 同じ理由である（下の判定を参照）。
   *
   * ## 除外の前提が崩れる回（Issue #1338 残件1）
   *
   * 上の除外の前提は「その道具のハンドラが自分で記録する」ことである。
   * **この前提は、ハンドラが一度も呼ばれない回には効かない。** alteroid の
   * 自作ツールは in-process の MCP サーバ（`tools.ts` の
   * `createCloneMcpServer`）で、その `McpServer`（`@modelcontextprotocol/sdk`）
   * は引数を zod で検証してからハンドラを呼ぶ。**検証が落ちると、SDK は
   * `McpError` を自分で `try/catch` して `isError: true` の普通の
   * `CallToolResult` へ変換する**（ハンドラは呼ばれない。実測は
   * `tools.ts` の `MCP_INPUT_VALIDATION_ERROR_MARKER` の doc）。⟹ Claude
   * Code から見るとこれは「道具の実行が成功して、たまたまエラーの本文を
   * 返した」にしか見えない——発火するのはここ（`PostToolUse`）であって
   * `PostToolUseFailure`（`#journalToolUseFailure`）ではない。
   *
   * **⟹ `journal_write` の `decision` が欠けて検証で落ちた回のような場合、
   * ハンドラ（＝自前で記録するはずの当人）が一度も走らないのに、除外だけが
   * 効いて日誌にも `self_dropped` にも何も残らない**（監査の穴。#1343 が
   * `grounds` の欠落は直したが、`decision` の欠落・他の自作ツールの検証
   * 落ちは残っていた——`tools.ts` の `journal_write` の doc「これで直らない
   * 残り」の訂正を参照）。
   *
   * **だからここでは、除外する前に検証落ちかを見る。** `tools.ts` の
   * `detectMcpInputValidationFailure` が `tool_response` を見て、SDK の
   * 入力検証エラーの印（`MCP_INPUT_VALIDATION_ERROR_MARKER`）を探す。
   * 見つかれば `#journalSelfJournalingToolValidationFailure` が
   * `tool_use`（`outcome: 'failed'`）として残す——**ハンドラが走っていない
   * ので `input` を残してよいかは道具ごとに違う**（`profile_write` の
   * `script` は実行環境の鍵そのものを運ぶ契約——`tools.ts` の
   * `cloneToolCarriesSecrets` の doc。値は写さず、道具名と検証で落ちた
   * 欄の名前だけを残す）。`journal_write` はこれに加えて `self_dropped`
   * にも跡を残す（判断の記録そのものが落ちたため。#1343 の `grounds` の
   * 欠落と同じ理由）。
   *
   * **例外を投げないこと。** 投げるとツール実行の後続に影響しうる。読めない形なら
   * 何もしないだけで、道具の実行そのものは常に続ける（日誌の失敗も `#journal` が
   * 飲み込む）。
   */
  async #onPostToolUse(record: AgentToolAuditRecord): Promise<void> {
    // **`claude-provider.ts` の `toAgentToolAuditRecord` が SDK の入力から
    // 写した中立の記録として読む。** フィールド名の綴り（SDK の snake_case）
    // を決めるのはもうここではない（#486「中立の口」）。
    const level = record.effortLevel;
    if (typeof level === 'string') this.#effort = level;
    this.#noteTranscriptPath(record.transcriptPath);
    // **決着したので `#allowedByGrantToolUses` から忘れる**（Issue #863
    // 残項目）。`#preToolInputHeads` の同じ掃除と同じ理由——`PreToolUse` は
    // 実行より前にしか発火しないので、成功で終わった呼び出しに後から拒否が
    // 届くことはない。
    if (typeof record.toolUseId === 'string') this.#allowedByGrantToolUses.delete(record.toolUseId);

    await this.#journalToolUse(record, CLONE_ACTOR_ID);
  }

  /**
   * 蒸留のサイドクエリでの道具実行を日誌へ残す。
   *
   * **本セッションと同じ関数を通す。** 道具の配置を揃えたのだから記録も揃える
   * （片方だけ記録が無いと「蒸留のターンで何をしたか」がどこにも残らない）。
   * 違うのは actor だけで、**effort はここでは拾わない** — あちらは別セッション
   * なので、その値を本セッションの観測として持つと嘘になる。
   */
  async #onDistillToolUse(record: AgentToolAuditRecord): Promise<void> {
    await this.#journalToolUse(record, CLONE_DISTILL_ACTOR_ID);
  }

  /** `PostToolUse` の合図1件を日誌へ落とす（自前で日誌へ書く自作ツールは除く）。 */
  async #journalToolUse(
    raw: AgentToolAuditRecord | null | undefined,
    mainThreadActor: string,
  ): Promise<void> {
    // 自前で日誌へ書く自作ツールだけを除く（上のコメント）。**`tool_name` が
    // 読めなかったときは落とさずに `(不明な道具)` で残す** — 除外の判定に使う
    // 名前が読めないなら、それは「自前で書く道具だった」ではなく「観測できな
    // かった」である。黙って消すと、監査の穴がいちばん静かな形（何も起きな
    // かったように見える）で空く。
    const tool = typeof raw?.toolName === 'string' ? raw.toolName : UNKNOWN_TOOL_NAME;
    if (cloneToolJournalsItself(tool)) {
      // **除外する前に、この回がハンドラの走らない検証落ちでないかを見る**
      // （上の doc「除外の前提が崩れる回」。Issue #1338 残件1）。
      await this.#journalSelfJournalingToolValidationFailure(tool, raw, mainThreadActor);
      return;
    }
    await this.#journal(
      stampAnsweredApproval(
        {
          type: 'tool_use',
          actor: cloneToolActor(raw, mainThreadActor),
          tool,
          input: raw?.toolInput,
        },
        this.#answeredApprovalFor(mainThreadActor),
      ),
    );
  }

  /**
   * いま走っているターンが承認への回答から起きたものなら、その承認の id
   * （issue #847 の案B。`approval-trace.ts` の doc）。
   *
   * **本セッションの actor の行だけに返す。** 蒸留のサイドクエリ
   * （`CLONE_DISTILL_ACTOR_ID`）は答えのターンと並行して走りうる別の
   * セッションなので、`#turn` を読むと答えと無関係な行へ印が付く。
   */
  #answeredApprovalFor(mainThreadActor: string): string | null {
    return mainThreadActor === CLONE_ACTOR_ID ? (this.#sdkSession.turn?.approvalId ?? null) : null;
  }

  /**
   * 自前で日誌へ書く道具（`SELF_JOURNALING_CLONE_TOOLS`）の呼び出しが、
   * ハンドラへ届く前の MCP 入力検証で落ちた回だけを `tool_use`
   * （`outcome: 'failed'`）として残す（Issue #1338 残件1。`#journalToolUse`
   * の doc「除外の前提が崩れる回」）。
   *
   * **検証落ちでなければ何もしない**（`detectMcpInputValidationFailure` が
   * `undefined` を返す——道具が成功した通常の回。ここで戻れば `#journalToolUse`
   * の早期 return と同じ挙動になり、成功した自前記録の道具を二重に書かない）。
   *
   * ## `input` を残すかどうかは道具ごとに違う
   *
   * ハンドラが一度も走っていない以上、この回の唯一の材料は SDK が返した
   * 生の `tool_input` である。**`cloneToolCarriesSecrets(tool)` が `true`
   * の道具（いまは `profile_write` だけ）では、この `input` を一切残さない**
   * ——`script` は実行環境の鍵・トークンの値そのものを運ぶ契約であり、日誌は
   * 人間が読み要約にも載る場所なので、値が焼かれると回収できない
   * （`tools.ts` の `cloneToolCarriesSecrets` の doc）。代わりに、検証で
   * 落ちた欄の名前（zod の path。値ではなく鍵の**名前**）だけを `error` に
   * 残す。**それ以外の道具は、`Bash` など preset の道具が既に日誌へ書いて
   * いる生の引数と同じ扱いで `input` をそのまま残す**（値を運ぶ契約が無い
   * ので、この回だけ特別扱いする理由が無い）。
   *
   * ## `journal_write` は `self_dropped` にも跡を残す
   *
   * `journal_write` は「クローンが人間に聞かずに実行した判断を残す唯一の
   * 経路」（`tools.ts` の doc）——判断の記録そのものが落ちたことを、
   * `journal_write` 自身が `grounds` の欠落で行っているのと同じ形
   * （#1343）で `self_dropped` にも残す。他の自作ツールには広げない
   * （`self_dropped` は「自分の記録が落ちた」ことを言う場であり、
   * `journal_write` 以外はここで初めて記録の**代わり**（`tool_use`）が
   * 生まれる側なので、二重に名乗る理由が無い）。
   */
  async #journalSelfJournalingToolValidationFailure(
    tool: string,
    raw: AgentToolAuditRecord | null | undefined,
    mainThreadActor: string,
  ): Promise<void> {
    const validation = detectMcpInputValidationFailure(raw?.toolResponse);
    if (validation === undefined) return;

    const fieldList =
      validation.fields.length > 0 ? validation.fields.join(', ') : '（取れなかった）';
    const secretBearing = cloneToolCarriesSecrets(tool);

    await this.#journal(
      stampAnsweredApproval(
        {
          type: 'tool_use',
          actor: cloneToolActor(raw, mainThreadActor),
          tool,
          outcome: 'failed',
          ...(secretBearing
            ? {
                error: excerptLine(
                  `入力検証で落ちた（この道具は実行環境の秘密を運びうるため、値は日誌へ写さない。` +
                    `欠けた/不正な引数: ${fieldList}）`,
                  TOOL_USE_ERROR_EXCERPT,
                ),
              }
            : {
                input: raw?.toolInput,
                // 伏せてから切る（#2493）。
                error: excerptLine(
                  redactErrorText(validation.message, this.#env),
                  TOOL_USE_ERROR_EXCERPT,
                ),
              }),
        },
        this.#answeredApprovalFor(mainThreadActor),
      ),
    );

    if (tool === JOURNAL_WRITE_QUALIFIED_TOOL_NAME) {
      noteDroppedRecord(
        '判断そのもの（journal_write）',
        `fields=${fieldList}`,
        new Error('入力検証で落ちた——decision が届かなかった可能性がある（issue #1338 残件1）'),
      );
    }
  }

  /**
   * 失敗・中断した道具呼び出しの合図（`PostToolUseFailure`）を拾う（Issue #924）。
   *
   * **`#onPostToolUse` と排他である**（`#buildSessionSpec` の `onPostToolUseFailure`
   * の doc — 出荷済みの SDK 実行体を実測して確認した排他分岐）。⟹ 1回の道具
   * 呼び出しにつき、このハンドラと `#onPostToolUse` のどちらか一方だけが呼ばれる。
   *
   * **`effort` と `transcript_path` もここで拾う。** どちらも `BaseHookInput`
   * の欄で `PostToolUseFailureHookInput` にも載る（`PostToolUseHookInput` と
   * 同じ形）。**拾わない理由が無い** — 排他である以上、直近の道具呼び出しが
   * 失敗した回だけこの2つを拾わずにいると、次に成功する道具呼び出しが来る
   * までのあいだ `#effort` と生ログの在り処が古いまま取り残される
   * （`#onPostToolUse` の同じ2行と同じ理由）。
   */
  async #onPostToolUseFailure(record: AgentToolAuditFailureRecord): Promise<void> {
    const level = record.effortLevel;
    if (typeof level === 'string') this.#effort = level;
    this.#noteTranscriptPath(record.transcriptPath);
    // **`#onPostToolUse` の同じ掃除と同じ理由**（Issue #863 残項目）。
    if (typeof record.toolUseId === 'string') this.#allowedByGrantToolUses.delete(record.toolUseId);

    await this.#journalToolUseFailure(record, CLONE_ACTOR_ID);
  }

  /**
   * 蒸留のサイドクエリでの、失敗・中断した道具呼び出しを日誌へ残す。
   *
   * **`#onDistillToolUse` と同じ理由で足す。** 道具の配置を揃えたのだから
   * 記録も揃える（片方だけ記録が無いと「蒸留のターンで何をしたか」がどこにも
   * 残らない）。しかも蒸留は `memory_write` を叩く経路なので、そこの失敗が
   * 記録されないと「記憶が書かれなかった」が静かに落ちる。
   *
   * **effort はここでは拾わない**（`#onDistillToolUse` と同じ理由 — 別
   * セッションの値を本セッションの観測として持つと嘘になる）。
   */
  async #onDistillToolUseFailure(record: AgentToolAuditFailureRecord): Promise<void> {
    await this.#journalToolUseFailure(record, CLONE_DISTILL_ACTOR_ID);
  }

  /**
   * `PostToolUseFailure` の合図1件を `tool_use` として日誌へ落とす（Issue #924）。
   *
   * ## なぜ `#noteDenial` のように `exchange` へ落とさないのか
   *
   * 分かれ目は「実行されたか」である。
   *
   * - **拒否**（`#noteDenial` が扱う）= 一度も走っていない ⟹ 「自分で手を
   *   動かした回数」に数えてはいけない ⟹ だから `exchange`
   * - **失敗**（ここ）= **走った。走った結果として投げた**（だから *Post* で
   *   ある）⟹ 副作用が在りうる ⟹ **「自分で手を動かした回数」に数えるべき**
   *   ⟹ だから `tool_use`
   *
   * **ただし成功と見分けが付かなくなってはいけない。** `outcome` を立てる
   * ことで区別する（`schema.ts` の `tool_use.outcome` の doc）。
   *
   * ## 自作ツールの除外は成功側と同じ規則をそのまま通す
   *
   * `cloneToolJournalsItself` の判定を `#journalToolUse` と共有しているので、
   * **自作ツールの失敗も、成功と同じ理由で除かれる**——`memory_write` が
   * 失敗しても、この関数はそれを重ねて書かない。**これは判断であり、
   * 名指ししておく**: 別の選択肢（失敗だけは自作ツールでも重ねて残す）も
   * 在ったが、道具ごとに「成功は除く／失敗は残す」という非対称を持ち込むと、
   * 除外規則を読む側が「この道具の記録はどちらの規則に従うか」をその都度
   * 確かめる必要が生まれる。自作ツール自身が失敗を記録するかどうかは
   * その道具のハンドラの責務であって、ここでは踏み込まない。
   *
   * ## ⚠️ 訂正・補足（2026-09-23、issue #1338 残件1）——ここが担当しない回
   *
   * **alteroid の自作ツール（in-process MCP）の入力検証エラーは、ここへは
   * 来ない。** MCP SDK（`McpServer` の `callTool`）は zod の検証失敗を自分で
   * `try/catch` し、`isError: true` の**普通の** `CallToolResult` へ変換する
   * （ハンドラは一度も呼ばれない。実測は `tools.ts` の
   * `MCP_INPUT_VALIDATION_ERROR_MARKER` の doc）。⟹ Claude Code から見ると
   * これは「道具の実行が成功した」にしか見えず、発火するのは `PostToolUse`
   * （`#journalToolUse`）であって、ここ（`PostToolUseFailure`）ではない。
   *
   * **⟹ 「自作ツール自身が失敗を記録するかどうかはその道具のハンドラの
   * 責務」という上の判断は、ハンドラが実際に走った後の失敗（本物の例外・
   * `is_interrupt`）にしか適用できない。** ハンドラが一度も呼ばれない
   * 検証落ち（例: `journal_write` の `decision` 欠落）にこの判断を当てはめる
   * と、責務を「走らなかったコード」へ割り当てることになり、日誌にも
   * `self_dropped` にも何も残らない（#1343 の PR 本文はこの取り違えをして
   * おり、`journal_write` の doc にも同じ訂正を書いた）。**その回の救済は
   * ここではなく `#journalToolUse` に足した**（`#onPostToolUse` の doc
   * 「除外の前提が崩れる回」）。ここが実際に受け持つのは、ハンドラが走った
   * 後に本物の例外を投げた回と、`is_interrupt: true` の中断だけである。
   */
  async #journalToolUseFailure(
    raw: AgentToolAuditFailureRecord | null | undefined,
    mainThreadActor: string,
  ): Promise<void> {
    // 名前が読めない扱いも成功側と揃える（`#journalToolUse` と同じ理由）。
    const tool = typeof raw?.toolName === 'string' ? raw.toolName : UNKNOWN_TOOL_NAME;
    if (cloneToolJournalsItself(tool)) return;
    await this.#journal(
      stampAnsweredApproval(
        {
          type: 'tool_use',
          actor: cloneToolActor(raw, mainThreadActor),
          tool,
          input: raw?.toolInput,
          // **`isInterrupt` が `true` のときだけ `'interrupted'`。** それ以外
          // （`false` または欠け）は `'failed'` とする——`isInterrupt` は
          // 任意の欄なので provider が付けてこないことがあるが、そのときは「中断だと
          // 分かっていない」であって「中断ではないと確定している」ではない。
          // 欠けを第3の値にはせず、安全側（failed）に倒す
          // （`schema.ts` の `tool_use.outcome` の doc と同じ判断）。
          outcome: raw?.isInterrupt === true ? 'interrupted' : 'failed',
          // `error` は無制限長の自由文なので切り詰める（`TOOL_USE_ERROR_EXCERPT`
          // の doc）。`raw?.error` が読めない形（文字列でない）のときは欄ごと
          // 省く——作り物の文言で埋めない。
          ...(typeof raw?.error === 'string'
            ? // 道具の出力を運びうるので、伏せてから切る（#2493）。
              { error: excerptLine(redactErrorText(raw.error, this.#env), TOOL_USE_ERROR_EXCERPT) }
            : {}),
        },
        this.#answeredApprovalFor(mainThreadActor),
      ),
    );
  }

  /**
   * 確認へ上がらずに止められた1件を日誌へ残す。
   *
   * **生の合図（`system/permission_denied`）と `result.permission_denials` の
   * 両方から呼ばれる。** 前者は best-effort で取りこぼしうるが速く、後者は
   * authoritative だがターンの終わりにしか来ない。だから両方読み、`tool_use_id`
   * で二重書きを防ぐ（`runner.ts` の `#noteDenial` と同じ形）。
   *
   * **`tool_use` としては記録しない。** 拒否は「道具を使った」ではないので、
   * 混ぜると `digest` の「自分で手を動かした回数」が使えていない回数まで数える。
   */
  async #noteDenial(denial: AgentPermissionDenial, via: 'live' | 'result'): Promise<void> {
    const tool = denial.tool ?? UNKNOWN_TOOL_NAME;

    // **hook の allow を SDK が追い越したかの検出**（Issue #863 残項目）。
    // **必ず SDK が実際に付けてきた `tool_use_id` で引く**——下で組む
    // `toolUseId`（道具名・`via` からの代用値）ではない。代用値はここで
    // 意味を持つ実在の id ではないので、それで引くと無関係な一致が起きうる。
    // 一致したら消費してから消す——同じ拒否が生の合図と `result` の両方から
    // 届いても、検出そのものは1回しか起こらない（下の二重書き防止と同じ形の
    // 独立した仕組み）。
    if (typeof denial.toolUseId === 'string') {
      const funneled = this.#allowedByGrantToolUses.get(denial.toolUseId);
      if (funneled !== undefined) {
        this.#allowedByGrantToolUses.delete(denial.toolUseId);
        await this.#noteGrantFunneled(funneled, denial, via);
      }
    }

    // id が無ければ道具の名前で代用する。**取りこぼすより重複を許す。**
    //
    // **代用値を作るのはこちら側の仕事である**（`agent-events.ts` の
    // `AgentPermissionDenial` の doc）。provider の写しは「無かった」を
    // そのまま運ぶだけで、何で埋めるかは層が決める。
    const toolUseId = denial.toolUseId ?? `${tool}:${via}`;
    // **既に書いてある1件でも、入力を持つ記録が後から来たら形だけ足す。**
    // 理由・形とも `runner.ts` の `#noteDenial` と同じである（層ごとに
    // 書き分けない）——入力を持つのは `via: 'result'` だけなので、`has` で
    // 弾くと「何を実行しようとしたか」が日誌に1件も残らない。
    const seen = this.#deniedToolUses.get(toolUseId);
    if (seen !== undefined) {
      if (seen.input || denial.input === undefined) return;
      this.#deniedToolUses.set(toolUseId, { input: true });
      this.#recentDenials.fillHeadWord(toolUseId, denial.input);
      const later = denialInputShape(denial.input);
      if (later !== undefined) {
        await this.#journal({
          type: 'exchange',
          with: 'self',
          role: 'inbound',
          text:
            `${EXCHANGE_KIND_DECISION_PREFIX}先に書いた ${tool} の拒否について、ターン終わりの記録（合図の出所: result）に` +
            `入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: ${later}`,
        });
      }
      return;
    }
    this.#deniedToolUses.set(toolUseId, { input: denial.input !== undefined });
    this.#recentDenials.remember(toolUseId, new Date().toISOString(), tool, denial);

    // `decision_reason` / `decision_reason_type` / `message` は3つとも
    // `via: 'result'` では必ず欠け、`via: 'live'` でも SDK が付けてこなければ
    // 欠ける（`runner.ts` の `#noteDenial` と同じ前提）。**欠けているものは
    // 作り物を出さず、そのまま行を省く**（`manager.ts` の `permission_denied`
    // 受信での組み立てと同じ形）。
    const denialDetails = [
      denial.reasonType === undefined ? undefined : `分類: ${denial.reasonType}`,
      denial.reason === undefined ? undefined : `理由: ${denial.reason}`,
      denial.message === undefined ? undefined : `モデルへの拒否文: ${denial.message}`,
    ].filter((line): line is string => line !== undefined);
    const why = denialDetails.length > 0 ? `（${denialDetails.join(' / ')}）` : '';

    // **層は `agent_id` で見る（`runner.ts` の `#noteDenial` と同じ判断・同じ
    // 理由をそのまま当てる）。** クローンも preset 一式を持つので `Task` を
    // 持ち、作業者（サブエージェント）の道具実行の拒否もこのフックを通って
    // 来る（`cloneToolActor` が `PostToolUse` で読んでいるのと同じ
    // `agent_id`）。分けないと「クローン自身の手が止まっている」と
    // 「作業者の手が止まっている」が同じ一文に潰れ、`journal_read` で追う
    // 側が誤った層へ次の判断を向けかねない。
    //
    // **`via: 'live'` のときだけ載る。** `via: 'result'`（`permissionDenialsOf`
    // が読む `SDKPermissionDenial`）は `tool_name` / `tool_use_id` /
    // `tool_input` の3つしか持たず、`agent_id` が原理的に存在しない
    // （`runner.ts` の同じ doc）。**「クローン本体だった」と決めつけないこと**
    // —— それは「層が取れた」ではなく「取れなかった」であり、3値目
    // （どちらの層か不明）のまま文言へ出す。
    //
    // **`agent_type` は今のところ常に無い。** `SDKPermissionDeniedMessage` は
    // `agent_id` は持つが `agent_type` を持たない（`runner.ts` の同じ doc）。
    // 読みはするが、作り物の型名を出さない（`cloneToolActor` の
    // `UNKNOWN_AGENT_TYPE` と同じ扱い）。
    //
    // **この不在には歯が在る**（`permission-denied.test.ts` の
    // `走行中の合図は agent_type の欄を持たない`）。**⚠️ 版番号を根拠に書かない**
    // ——不在は `check:sdk-quotes` では守れない（あの門は「在ること」しか
    // 言えない。`check-sdk-quotes-core.mjs` の「この検査が言えないこと」）ので、
    // 守っているのは型の歯のほうである。
    const agentId = denial.agentId;
    const agentType = denial.agentType;
    const actorLabel =
      via !== 'live'
        ? 'どちらの層か不明'
        : agentId === undefined
          ? 'クローン本体'
          : `作業者（${agentType ?? UNKNOWN_AGENT_TYPE}）`;

    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'inbound',
      text:
        `${EXCHANGE_KIND_DECISION_PREFIX}${tool} の実行が、確認へ上がらずに止められた${why}。` +
        `止められたのは ${actorLabel} の手（合図の出所: ${via}）。` +
        // **入力は形だけ残す。値は残さない**（`denial-shape.ts`）。ここは元から
        // 入力を1文字も書いていなかったので、読む側は「良性の道具呼び出しが
        // 誤検知された」と「止められるべきだった」を分けられなかった。
        // **かといって本文は書けない** —— 道具の入力には鍵が入りうる。
        `入力の形: ${denialInputShape(denial.input) ?? denialInputAbsence(via)}。` +
        `許可モードは ${this.#permissionMode} で、この層に確認を回す相手は居ない。`,
    });
  }

  /**
   * `#onPreToolUse` が許可 DB の規則に一致して `allow` を返した呼び出しが、
   * 同じ `tool_use_id` で拒否された1件を日誌へ残す（Issue #863 残項目「hook
   * の allow を SDK が追い越したことの検出」）。
   *
   * ## 原因は断定しない
   *
   * バイナリを静的に読んだ観測（Issue #863 のコメント、2026-09-26）による
   * と、考えられる筋は2つある——(1) リモートの機能フラグ
   * （`tengu_virtual_knuth`）が立ち、SDK が hook の allow を分類器へ回すように
   * なった、(2) deny 規則が hook の allow を上書きした。**alteroid 自身の
   * コードからはどちらか（あるいは両方）かを切り分けられない**——切り分けを
   * 主張せず、両方を挙げたうえで「効いていない可能性がある」とだけ言う。
   *
   * ## 日誌には毎回書く。注意書きは grant ごとに初回だけ
   *
   * 起きた事実（規則・grant id・拒否の分類/理由）は検出のたびに書く。
   * **人間が読む「原因を断定しない」注意書きは、同じ grant について初めて
   * 検出した回にだけ足す**（`#grantFunneledWarnedOnce`）——`#notices.noteUsage`
   * が「同じ知らせで日誌を埋めない」ために畳むのと同じ考え方で、ここでは
   * 事実の記録そのものは畳まず、注意書きの文言だけを間引く。
   *
   * ## コマンド本文は書かない
   *
   * `funneled.rule` は人間が既に承認した文字列（`request_permission` の
   * 引数）なので書いてよいが、実際に流れたコマンド本文（`denial.input` /
   * `toolInput`）はここでは一切読まない——`#noteDenial` 本体が既に
   * `denialInputShape` で形だけに畳んでいる分（この呼び出しの直後に書かれる
   * 通常の拒否の行）に任せる。
   */
  async #noteGrantFunneled(
    funneled: AllowedByGrantRecord,
    denial: AgentPermissionDenial,
    via: 'live' | 'result',
  ): Promise<void> {
    const denialDetails = [
      denial.reasonType === undefined ? undefined : `分類: ${denial.reasonType}`,
      denial.reason === undefined ? undefined : `理由: ${denial.reason}`,
    ].filter((line): line is string => line !== undefined);
    const why = denialDetails.length > 0 ? `（${denialDetails.join(' / ')}）` : '';

    const firstTimeForGrant = !this.#grantFunneledWarnedOnce.has(funneled.grantId);
    if (firstTimeForGrant) this.#grantFunneledWarnedOnce.add(funneled.grantId);
    const guidance = firstTimeForGrant
      ? ' 考えられるのは、SDK が hook の allow を分類器へ回すようになったこと、' +
        'または deny 規則が hook の allow を上書きしたことである' +
        '（どちらかは、あるいは両方かは、ここからは切り分けられない）。' +
        'この許可は、いまは効いていない可能性がある。'
      : '';

    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'inbound',
      text:
        `${EXCHANGE_KIND_DECISION_PREFIX}許可 DB の規則 ${funneled.rule}（grant ${funneled.grantId}）で ` +
        `PreToolUse が allow を返したのに、同じ呼び出し（合図の出所: ${via}）が拒否された${why}。` +
        guidance,
    });
  }

  /**
   * `#allowedByGrantToolUses` に控えたまま、決着（`#onPostToolUse` /
   * `#onPostToolUseFailure`）も拒否（`#noteDenial` → `#noteGrantFunneled`）も
   * 来ないうちに、その控えを作った作業者（サブエージェント）が
   * `SubagentStop` を迎えた分を日誌へ残す（Issue #1803）。
   *
   * ## なぜ要るか
   *
   * `#noteGrantFunneled` の検出は、拒否が実際に SDK から届くことに依存する。
   * **作業者（サブエージェント）の呼び出しでは、この拒否そのものが届かない
   * 経路がある**——静的な読みだけの観測（Issue #1803 本文、2026-09-26 の
   * コメント。**生きたセッションでは確かめていない**）によると、背景で走る
   * 作業者の文脈を組み立てる箇所に `onPermissionDenial=void 0` があり、その
   * 文脈で deny 規則が hook の allow を上書きしても `permission_denials` にも
   * 走行中の合図にも載らない。⟹ `#noteDenial` が一度も呼ばれないまま、
   * `#allowedByGrantToolUses` の控えだけが残り続ける——`SubagentStop` は
   * その作業者がもう戻ってこないことを知る、唯一の残った合図である。
   *
   * ## `agentId` で絞る（本体・別の作業者の控えには触れない）
   *
   * `record.agentId` が読めなければ何もしない——本体（クローン自身）のターン
   * が閉じるのは `Stop` であって `SubagentStop` ではないので、ここへ来る
   * 時点で作業者の呼び出しのはずだが、`agentId` が省かれた回（旧い provider
   * の写し）は安全側（何もしない）に倒す。控えは `funneled.agentId ===
   * record.agentId` で絞ってから消費するので、他の作業者や本体（`agentId`
   * を持たない控え）には触れない。
   *
   * ## 原因は断定しない（`#noteGrantFunneled` と同じ流儀）
   *
   * ここで分かるのは「決着も拒否の記録も無いまま作業者が終わった」という
   * **不在の事実**だけで、`#noteGrantFunneled` よりさらに1段弱い証拠しか
   * 持たない（実際の拒否を受け取ったわけではない）。**だから「追い越され
   * た」とは書かず、「決着しなかった」とだけ言う。** 人間が読む注意書きは
   * `#grantFunneledWarnedOnce` を共有し、grant ごとに初回だけ足す
   * （`#noteGrantFunneled` の doc「日誌には毎回書く。注意書きは grant ごとに
   * 初回だけ」と同じ帳面・同じ理由——同じ grant について両方の検出経路が
   * 交互に鳴っても、注意書きは1度で足りる）。
   *
   * ## コマンド本文は書かない
   *
   * `AllowedByGrantRecord` はもともとコマンド本文を持たない（`grantId` /
   * `rule` / `agentId` だけ）ので、ここでも書きようがない——載せるのは
   * `tool_use_id` / `grantId` / `rule` / `agentId` の4つだけである。
   *
   * ## 誤検出の筋（確かめていない）
   *
   * 背景処理が `SubagentStop` の**後**に決着する回があるかもしれない——その
   * 回は実際には道具の実行が続いているのに「決着しなかった」と書くことに
   * なる。**生きたセッションでは確かめていない**（Issue #1803 本文）。
   * それでも、この関数が消費した**後**に同じ `tool_use_id` で
   * `#onPostToolUse` / `#onPostToolUseFailure` / `#noteDenial` が来ても、
   * 控えは既に消えているので何も起きない——`RecentMap.delete` は無い鍵を
   * 渡されても例外を投げず、何も起きたことにしない（歯で固定してある）。
   * ⟹ 誤検出はありうるが、二重に日誌へ残ることは無い。
   */
  async #onSubagentStop(record: AgentSubagentStopRecord): Promise<void> {
    if (typeof record.agentId !== 'string') return;
    const agentId = record.agentId;

    for (const [toolUseId, funneled] of this.#allowedByGrantToolUses.entries()) {
      if (funneled.agentId !== agentId) continue;
      this.#allowedByGrantToolUses.delete(toolUseId);

      const firstTimeForGrant = !this.#grantFunneledWarnedOnce.has(funneled.grantId);
      if (firstTimeForGrant) this.#grantFunneledWarnedOnce.add(funneled.grantId);
      const guidance = firstTimeForGrant
        ? ' 「hook の allow を追い越した」とは断定しない——決着も拒否の記録も' +
          '無いまま作業者が終わった、という不在の事実だけがここでは分かる。' +
          'この許可は、いまは効いていない可能性がある。'
        : '';

      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'inbound',
        text:
          `${EXCHANGE_KIND_DECISION_PREFIX}許可 DB の規則 ${funneled.rule}（grant ${funneled.grantId}）で ` +
          `PreToolUse が allow を返した作業者（agentId: ${agentId}）の呼び出し` +
          `（tool_use_id: ${toolUseId}）が、実行の決着も拒否の記録も無いまま、` +
          `その作業者の SubagentStop を迎えた。決着しなかった。${guidance}`,
      });
    }
  }

  /**
   * クローンの SDK 子プロセスへ渡す env。
   *
   * **記憶ストアの鍵は落とさない。** ここはマネージャー（`runner.ts` の
   * `#childEnv`）と扱いが逆である — 伏せるのは「上（記憶）へ到達する鍵を
   * *下の層* へ配らない」ためであって、記憶の持ち主であるクローン自身から
   * 取り上げるためではない。取り上げれば、それはただのデグレードになる。
   *
   * **⚠️ 例外が1つある——`#withheldEnvKeys`（Issue #1495 ①。`CloneOptions.
   * withheldEnvKeys` の doc）。** ここへ挙げるのは記憶へ届く鍵ではなく、
   * ログイン基盤そのものの鍵（Google OAuth のクライアント ID /
   * シークレット）である。クローンの SDK 子プロセス（`Bash` / MCP / 作業者を
   * 含む）が記憶を読み書きするのにこの鍵を使うことは無いので、「記憶の持ち主
   * だから落とさない」という上の理由はここには当てはまらない。
   */
  #childEnv(): NodeJS.ProcessEnv {
    // **鍵は呼ばれるたびに読み直す。** `this.#childEnvBase` は構築時のスナップショットなので、
    // そのまま配ると人間（や回し手）が後から差し替えた鍵が永久に届かない
    // （`credentials.ts` / `runner.ts` の `#childEnv()` と同じ理由）。
    //
    // **重ね順は runner.ts と揃えてある** ——`env` → 正本 → 鍵 → プロファイル。
    // あちらの doc が「プロファイルは鍵より後。人間が明示的に書いたほうが勝つ」と
    // 言っており、**層ごとに順序が違うと「マネージャーには回るのにクローンには
    // 回らない」（あるいは逆）が生まれる。** 規則は1つにする。**正本の重ねを
    // `env` の直後・鍵とプロファイルより前に置くのは、Anthropic のプールの扱い
    // （`this.#credentials`）を1バイトも変えないためである** —— プールの名前
    // （`POOL_OWNED_CREDENTIAL_NAMES`）は `assertEntries` が正本への書き込みを拒むので
    // ここに挟んでも衝突しないが、念のためプールの重ねより手前に置いて、
    // プールの行を後勝ちのまま動かさない。
    //
    // **⚠️ この順序の帰結として、プロファイルが鍵と同じ名前を宣言していると
    // 鍵が黙って上書きされる。** 塞ぐのは順序ではなく検出のほうである
    // （`credentialNamesShadowedByProfile`。理由はあちらの doc）。
    // **セッションが起きるこの瞬間の身元を捕まえる**（`#sessionTokenIdentity` の doc）。
    // ここ以外で読み直すと、世代の照合が素通しになる。
    this.#sdkSession.captureSessionTokenIdentity(this.#tokenIdentity?.());
    const env: NodeJS.ProcessEnv = {
      ...this.#childEnvBase,
      ...this.#vaultCredentialOverlay(),
      ...(this.#credentials?.() ?? {}),
      ...(this.#profile?.env() ?? {}),
    };
    // **伏せるのは最後**（`runner.ts` の `#childEnv()` と同じ順序）。正本や
    // プロファイルがログイン基盤の鍵と同じ名前を重ねてきても、最後にもう一度
    // 落とすことで生き残らせない——`credentialNamesShadowedByProfile` が
    // 「人間が明示的に書いたほうが勝つ」を検出するのと違い、ここは検出ではなく
    // 実際に落とす（記憶ストアの鍵とは扱いが違う理由は直上の doc）。
    // **`this.#env`（daemon の `process.env`）自体は動かさない** —— ここで
    // 作った新しいオブジェクト（`env`）から削るだけである。daemon 本体は
    // このメソッドの後もこの鍵を使って OAuth の交換を続ける。
    for (const key of this.#withheldEnvKeys) delete env[key];
    return env;
  }

  /**
   * 正本（`CredentialService`）を、マネージャー側（`effective()`）と**同じ
   * 1本の解決**（`resolveCredentialRows`）へ通してから重ねる（人間の決定
   * 2026-09-12、「梯子を1本に統一する」——Issue #865 の恒久策）。
   *
   * ## なぜ以前は正本を素通りしていたか
   *
   * `#childEnv()` は同期だが、正本（`stores.credentials`）の読み出しは
   * 非同期である。⟹ ここで直接 `await` はできない。**同期の写し**
   * （`CredentialService#vaultSnapshot()`）を経由することで、この制約の
   * 中で正本を覗く。
   *
   * ## `credentialService` を渡さなかったら
   *
   * `[]` を正本として解決する——正本の上乗せが無いだけで、**変更前の `#childEnv()`**
   * （`env` → 鍵 → プロファイルだけ）とちょうど同じ集合を返す。**既定の構成の挙動を
   * 変えない**（`CloneOptions.credentials` の同じ doc と同じ約束）。
   *
   * ## 器の env を最後の土台にしない（2026-10-06）
   *
   * 正本に無い名前（`GH_TOKEN` を含む）は、この重ねからは何も出ない。以前は
   * `resolveCredentialRows` が `this.#env` の `GH_TOKEN` 等を土台として埋めていたが、
   * その値は起動時に正本から書き写されたものだった（`CloneOptions.childEnvBase` の doc）。
   *
   * ## 範囲が広がる副作用
   *
   * **正本にしか無い任意の名前（GitHub 以外。PR #825）も、初めてクローンへ
   * 届くようになる。** 以前はマネージャーだけが正本を読んでいた
   * （`effective()`）ので、クローンには一切届いていなかった。これは能力の
   * 削除ではなく追加であり、north_star が求める「クローンは道具を全部持つ」
   * （地雷表）にむしろ沿う——マネージャーが読める正本を、その代理である
   * クローンが読めないほうが不自然である。
   */
  #vaultCredentialOverlay(): Record<string, string> {
    const rows = this.#credentialService?.vaultSnapshot() ?? [];
    const resolved = resolveCredentialRows(rows, 'clone');
    return Object.fromEntries(resolved.map((row) => [row.name, row.value]));
  }

  /**
   * 枠の観測を回し手へ渡す（Issue #393 PR3）。**判断はしない。**
   *
   * **投げてもターンを壊さない。** 回せなかったことは枠に当たったこととは別の
   * 失敗であり、後者の報告を前者で置き換えない——ここで投げ直すと、人間には
   * 「上限に当たった」ではなく「回し手が落ちた」だけが届く。
   */
  async #observeForTokenRotation(
    observation: Omit<TokenRotatorObservation, 'observedBy'>,
  ): Promise<void> {
    if (this.#onUsageObservation === undefined) return;
    try {
      await this.#onUsageObservation({
        ...observation,
        ...(this.#sdkSession.sessionTokenIdentity === undefined
          ? {}
          : { observedBy: this.#sdkSession.sessionTokenIdentity }),
      });
    } catch (error) {
      // **黙って握り潰さない。** 跡は残すが、ターンは続ける。
      noteDroppedRecord('認証トークンの切替', 'clone', error);
    }
  }

  /**
   * 要約に潰される直前に、全文をアーカイブへ落とし、そこから蒸留する。
   *
   * 蒸留は生存条件であり、後回しにしてよい機能ではない。ここで記憶へ移し損ねた
   * ものは、compaction のたびに人格の一部として失われる。
   */
  async #onPreCompact(record: AgentPreCompactRecord): Promise<void> {
    const { sessionId, transcriptPath, signal } = record;

    // **いちばん先に印を立てる**（`#memoryIndexRefreshPending`）。compaction は
    // このフックが何を返しても起きるので、生ログのパスが取れない回でも
    // 「潰された」ことは真である。**退避や蒸留の try より前に置く** ——
    // あちらが落ちても、索引の載せ直しは行われなければならない。
    this.#distillMemory.armMemoryIndexRefresh();

    if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
      return;
    }

    // **(i) 退避と (ii) 蒸留を別の `try` に割る**（`#salvageTranscript` と同じ形）。
    // 直す前は 1 つの `try` で、しかも全文を 1 本の文字列にしてから両方へ渡していた。
    // ⟹ **生ログが伸びて `readFile` が `ERR_STRING_TOO_LONG` で落ちると、蒸留も
    // 一緒に止まる。** それはこの経路の doc（「蒸留は生存条件であり、後回しにしてよい
    // 機能ではない」）が守ると言っているものが、退避の都合で失われる形である。
    try {
      // 退避するのは全文（ロードマップの要件）。**全文を 1 本の文字列にするのは
      // ここだけである**（`readTranscriptTail` の doc）。
      const transcript = await readFile(transcriptPath, 'utf8');
      const write = await this.#stores.archive.archive(sessionId ?? 'clone', transcript);
      // **diverged / unknown のときだけ日誌へ記録する**（#698。`continues` は
      // ノイズにしかならない——理由は `describeArchiveContinuityForJournal`
      // の doc）。`#journal` は自分で失敗を握り潰すので、退避の成功を道連れに
      // しない。
      const continuityText = describeArchiveContinuityForJournal({
        caller: 'PreCompact の退避',
        sessionId: sessionId ?? 'clone',
        continuity: write.continuity,
        comparedTo: write.comparedTo,
        bodyChars: transcript.length,
      });
      if (continuityText !== null) {
        await this.#journal({
          type: 'exchange',
          with: 'self',
          role: 'outbound',
          text: `${EXCHANGE_KIND_RECOVERY_PREFIX}${continuityText}`,
        });
      }
    } catch (error) {
      // これはクローンの判断ではなくシステムの失敗なので、判断として記録しない
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_FAILURE_PREFIX}PreCompact の退避に失敗した: ${reasonOf(error)}`,
      });
    }

    // **中断の合図は蒸留にだけ掛かる**（直す前と同じ。退避は中断で飛ばさない）。
    if (signal?.aborted === true) return;

    try {
      await this.#distillFromTranscript(tailOf(await readTranscriptTail(transcriptPath)));
    } catch (error) {
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_FAILURE_PREFIX}PreCompact の蒸留に失敗した: ${reasonOf(error)}`,
      });
    }
  }

  /**
   * 走行中のセッションは compaction 中なので、蒸留は別の短命セッションで行う。
   * 道具（記憶・日誌）は同じインプロセス MCP を渡すので、書き込み先は同じ。
   */
  async #distillFromTranscript(transcriptTail: string): Promise<void> {
    // **蒸留のサイドクエリは駆動役の任意の能力である**（`AgentCloneDriver.distill`）。持たない
    // 駆動役では**投げる**——呼び出し側はどれも失敗として日誌へ残し、「蒸留できた」印を
    // 下ろさない（黙って返すと、蒸留していないのに成功として扱われる）。
    const driver = this.#driver;
    const distill = driver.distill?.bind(driver);
    if (distill === undefined) {
      throw new Error(`この駆動役（${driver.providerId}）は蒸留のサイドクエリを持たない`);
    }
    // ここは**別の短命セッション**なので、載せ直しの控え（`#memoryOnRecord`）は
    // 触らない。触ると本セッションの差分が消える。
    const memory = renderMemoryDocuments(await this.#stores.persona.documents());

    // **このターンへ何が入ったかを残す**（#243 の7本目）。本文は会話の生ログの
    // 末尾で、他の5経路の `digest` のように器から組み直せる寄せ集めではないので、
    // 長さに加えて指紋も書く（何を載せるかの判断は `turnInputEntry` に1本化して
    // ある）。
    await this.#journal(turnInputEntry({ type: 'pre_compact_distill', transcriptTail }));

    const prompt = [
      buildDistillPrompt('pre_compact'),
      '',
      '以下は、要約に潰される直前の会話の生ログ（末尾）である。',
      '',
      transcriptTail,
    ].join('\n');

    // **蒸留のたびに読み直す**（`#externalMcpServers` の doc）。本セッションと同じ
    // 人間の連携を渡す——片方だけに見えると、人格の書き手だけが別の手を持つ。
    const externalMcpServers = await this.#externalMcpServers();
    const side = distill({
      prompt,
      model: this.#model,
      permissionMode: this.#permissionMode,
      // **蒸留のターンでも同じ道具を渡す。** ここだけ欠けていると、
      // 会話の最後に「鍵を実行環境へ移す」をやろうとして失敗する。
      //
      // **本セッションで観測した値をそのまま渡す。** ここだけ欠けていると、
      // 蒸留のターンだけ自分のことが分からないクローンになる
      // （`CloneRuntimeFacts.sessionId` のコメントの理由）。
      // **`#cloneToolsFor` を本セッションと同じく通す**（Issue #486
      // 48(a) PR2）。中身は変えず、経路（`sdk`/`stdio`）を決める1点だけを
      // 本セッションと揃える——`#cloneToolsFor` の doc「片方だけ中継越し
      // だと…非対称が transport の軸にも生まれる」を参照。
      tools: await this.#cloneToolsFor({
        stores: this.#stores,
        emit: () => undefined,
        ...(this.#profileService === undefined ? {} : { profile: this.#profileService }),
        ...(this.#accountUsage === undefined ? {} : { accountUsage: this.#accountUsage }),
        ...(this.#scheduler === undefined ? {} : { scheduler: this.#scheduler }),
        runtime: () => this.#runtimeFacts(),
        // このサイドクエリ自体が常に蒸留のターンなので、`#turn` を読む必要は
        // 無い（`#toolContext()` の doc）。**ここを削ると `memoryCause` は
        // 既定の `'clone'` に落ち、蒸留が書いた記憶なのに `cause: 'clone'`
        // と名乗る**（`ToolContext.memoryCause` の doc の「渡し忘れ」）。
        memoryCause: () => 'distill',
        // **蒸留のサイドクエリにも渡す**（issue #1049）。この層で
        // `inbox_remove_many` を打つ場面は想定していないが、**渡さない側を
        // 選ぶと「蒸留のターンだけ消せない」という層ごとの能力差になる**
        // （north_star 禁止2）。渡す実体は本セッションと同一である。
        dropQueuedInboxEvents: (ids) => this.dropQueuedInboxEvents(ids),
        // **同じ理由で渡す**（issue #1133）。`#toolContext()` と同じ
        // `#queuedInMemoryCount()` を経由する。
        queuedInMemory: () => this.#queuedInMemoryCount(),
        ...this.#attachmentCopiesDirEntry(),
        // **`conversationId` は明示する（#768・#781）。** かつては省略していたが、
        // いまは `ToolContext.conversationId` が必須（省略すると
        // `createCloneTools` が throw する）。値そのものの判断は変えていない
        // —— `emit` を `() => undefined` にしているのと同じ判断で、
        // サイドクエリは常に内部ターンで人間の会話には紐づいていないので、
        // 関数は渡すが常に `undefined` を返す。
        conversationId: () => undefined,
        // **同じ実体を渡す**（issue #1802。上の `dropQueuedInboxEvents` と同じ理由）。
        recentDenials: () => this.#recentDenials.list(),
      }),
      externalMcpServers,
      systemPrompt: buildCloneSystemPrompt({
        memory,
        ...(this.#self === undefined ? {} : { self: this.#self }),
      }),
      env: this.#childEnv(),
      ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
      onPostToolUse: (input) => this.#onDistillToolUse(input),
      // **本セッションと同じ理由で足す**（`#buildSessionSpec` の
      // `onPostToolUseFailure` の doc）。蒸留は `memory_write` を叩く経路
      // なので、そこの失敗を記録しないと「記憶が書かれなかった」が
      // 静かに落ちる。
      onPostToolUseFailure: (input) => this.#onDistillToolUseFailure(input),
    });

    for await (const ended of side) {
      // **本セッションと同じ写しを通す**（駆動役が `foldClaudeMessage` 等で中立イベントへ
      // 畳んで返す）。読むのはターンの終わりだけなので `#apply` は
      // 通さない —— こちらは `site`（`distill`）も累積の数え方（`oneshot`）も
      // 本セッションと違い、**同じ反応をさせてはいけない側**である。
      if (ended.type !== 'turn_ended') continue;
      // **このサイドクエリの `result` を読み捨てないこと。** ここが「要約のたびに
      // 払っている蒸留の費用」の唯一の観測点である。別の `query()` 呼び出しなので
      // 累積は1回で閉じており（SDK: 「during this query() call」）[sdk-verbatim SDKResultSuccess.modelUsage]、値はこの1回の
      // 総量そのものである ＝ 基準を持たせない（`usage.ts` の `foldOneshotUsage`）。
      //
      // **これは「要約そのものの費用」ではない。** 要約を作る推論は本セッションの
      // `modelUsage` に合算されて分離できない（`usage.ts` の `usageSiteSchema`）。
      // 混ぜて名乗ると、取れていないものを取れたことにする。
      await this.#recordUsage(ended.usage, 'distill', 'oneshot');
      // **この経路の成功も日誌へ残す**（Issue #564 の (b)）。ここは受信箱を
      // 通らない別経路なので、`#handle` の `'distill'` 分岐に印を置いただけでは
      // 「要約の直前に蒸留して、そのまま器が入れ替わった」回が「1度も蒸留して
      // いない」と読まれる。
      //
      // **判定は `succeeded` である**（`#recordUsage` が消費を積むのと同じ条件 ——
      // 中立イベントの `succeeded` は `usage.ts` の `isSuccessResult` そのもので、
      // `usage` が載るかどうかもこれで決まる）。ここは `#runTurn` を通らないサイド
      // クエリなので `TurnOutcome` が無く、成否はターンの終わりからしか取れない。
      if (ended.succeeded) await this.#journal(distillSucceededEntry('pre_compact'));
      break;
    }
  }

  /**
   * ターンの境界の文脈占有を、SDK の control channel から1回だけ聞く
   * （`schema.ts` の `turn_usage.contextUsage` の doc）。
   *
   * **`this.#query` が既に無ければ何も聞かない。** セッションが終わる窓
   * （`#read` の `finally` が `#query = null` にした後）でここへ来ると
   * `getContextUsage` を持たない値を呼ぶことになるので、`null` のときは
   * 呼ばずに `undefined` を返す —— これは「試して失敗した」ではなく
   * 「まだ観測していない」の側である（`turn_usage.contextUsage` の doc、
   * 欄そのものが無い行の意味）。
   *
   * **失敗してもターンを止めない。** 呼び出しは `try`/`catch` で必ず値を
   * 返す形にしてあり、呼び出し元（`#apply` の `case 'turn_ended'`）は
   * ここで例外を待ち受けない。
   *
   * **秘密を漏らさない。** 例外・rejection の理由は `usage-probe.ts` の
   * `describeProbeError`（`redactEnvSecrets` を内側で通す）でしか運ばない
   * ——新しい伏せ字の仕組みは作っていない。
   */
  async #observeContextUsage(): Promise<ContextUsageObservation | undefined> {
    const q = this.#sdkSession.query;
    if (q === null) return undefined;
    // **文脈の使用状況を出せない駆動役（Codex）は、最初の1回だけ「取れない」と残し、以後は聞かない**
    // （毎ターン同じ error 付きの `context_usage` 行を積まない）。2回目以降は「観測していない」
    // （`undefined`）で、行は書かれない。`providesContextUsage` を持たない Claude は従来どおり。
    if (this.#driver.providesContextUsage === false) {
      if (this.#contextUsageUnavailableNoted) return undefined;
      this.#contextUsageUnavailableNoted = true;
    }
    const startedAt = Date.now();
    try {
      const usage = await q.contextUsage();
      // **内訳は既に払ってあるものを写すだけである。** `getContextUsage()` を
      // 引数なしで呼ぶと SDK の既定は `detail: 'full'`（＝カテゴリごとに
      // token-count API を呼ぶ）なので、**内訳を取り出さなくても費用は同じ**
      // （`schema.ts` の `contextUsage.categories` の doc に逐語）。
      // **`kind` も写す（#804）。** SDK の doc が名指しでそう言っている
      // （`schema.ts` の `contextUsage.categories[].kind` の doc、逐語）——
      // 分類は `kind` の値だけで行い、この `map` は `name` の文字列を
      // 1文字も見ない。分類そのもの（`used`/`free`/`buffer`/`deferred`/
      // 分類できない軸）は `context-usage.ts` の `summarizeContextCategories`
      // が1箇所で持つ——ここは SDK の値をそのまま写すだけである。
      const categories = (usage.categories ?? []).map((category) => ({
        name: category.name,
        tokens: category.tokens,
        kind: category.kind,
      }));
      const shownCategories = categories.slice(0, CONTEXT_USAGE_CATEGORY_LIMIT);
      const omittedCategories = categories.length - shownCategories.length;
      // **配列は合計へ畳む。** 道具は `CLONE_TOOL_NAMES`（`tools.ts`）の本数だけ
      // あるので、1本ずつ写すと日誌の1行がその数だけ伸びる
      // （`turn-input.ts` の「再構成できるものを二重に持たない」）。
      const sumTokens = (items: readonly { tokens: number }[]): number =>
        items.reduce((total, item) => total + item.tokens, 0);
      const mcpTools = usage.mcpTools ?? [];
      const memoryFiles = usage.memoryFiles ?? [];
      const systemPromptSections = usage.systemPromptSections ?? [];
      return {
        durationMs: Date.now() - startedAt,
        totalTokens: usage.totalTokens,
        rawMaxTokens: usage.rawMaxTokens,
        percentage: usage.percentage,
        ...(usage.autoCompactThreshold === undefined
          ? {}
          : { autoCompactThreshold: usage.autoCompactThreshold }),
        isAutoCompactEnabled: usage.isAutoCompactEnabled,
        // **空の配列のときは欄そのものを作らない。** 0 を置くと「測ったが 0
        // だった」と読めるが、実際には「SDK がその欄を返さなかった」ことが
        // ありうる（`systemPromptSections` などは optional である）——
        // AGENTS.md の地雷「取れない軸に 0 の行を作る」と同じ形。
        ...(shownCategories.length === 0 ? {} : { categories: shownCategories }),
        ...(omittedCategories > 0 ? { categoriesOmitted: omittedCategories } : {}),
        ...(mcpTools.length === 0
          ? {}
          : { mcpToolTokens: sumTokens(mcpTools), mcpToolCount: mcpTools.length }),
        ...(memoryFiles.length === 0
          ? {}
          : { memoryFileTokens: sumTokens(memoryFiles), memoryFileCount: memoryFiles.length }),
        ...(systemPromptSections.length === 0
          ? {}
          : {
              systemPromptTokens: sumTokens(systemPromptSections),
              systemPromptSectionCount: systemPromptSections.length,
            }),
      };
    } catch (error) {
      return {
        durationMs: Date.now() - startedAt,
        error: describeProbeError(error, process.env),
      };
    }
  }

  /**
   * **セッションを畳む直前に、累積を control channel から1回読んで台帳へ積む。**
   *
   * ## なぜ要るのか（マネージャー層と同じ穴である）
   *
   * `#recordUsage` は `turn_ended` の `usage` からしか積まない。そして
   * `claude-provider.ts` の `foldClaudeMessage` は逐語「**成功した result の消費だけ
   * を通す**」なので、**`result` を出さずに終わったターンは `usage` を持たない**
   * ⟹ `#recordUsage` は逐語「**積める消費が無い回はここで終わる**」で戻る。
   *
   * **失われるのは「そのターンぶん」ではなくセッションの末尾ぶんである。** クローン
   * の台帳は累積（`accumulation: 'cumulative'`）なので、セッションが生きていれば
   * 次の成功ターンが取り戻す。**取り戻せないのはセッションごと死んだときである**
   * —— 新しいセッションは累積 0 から始まるので `foldUsageSnapshot` の `detectReset`
   * が真になり、増分は新しい累積そのものになる。⟹ 前のセッションの、最後に記録
   * できた点から死ぬまでのぶんは二度と積まれない。
   *
   * **マネージャー層は `runner.ts` の `#flushUsage` で既にこれを塞いでいる**
   * （終わり口2本 `stop()` と `#finish` の両方）。**クローン層だけが塞いでいな
   * かった。** 読み取りの本体を層で書き分けず `usage.ts` の `readSessionUsage` に
   * 置いてあるのは、片方だけ消されないためである（そちらの doc に理由の全文）。
   *
   * ## 契約
   *
   * - **`this.#query?.close()` / `this.#query = null` より先に呼ぶこと。** 閉じた後の
   *   control channel からは何も取れない
   * - **投げない。** `readSessionUsage` が口の不在・例外・時間切れを全部
   *   `undefined` へ畳む。**畳む経路を観測に縛らない**
   * - **`turnBoundary` は渡さない。** ここはターンの境界ではないので、文脈占有も
   *   compaction も持たない（`#recordUsage` の `turnBoundary` の doc が蒸留の
   *   サイドクエリについて言っているのと同じ理由である）
   */
  async #flushSessionUsage(): Promise<void> {
    const session = this.#sdkSession.query;
    const models = await (session === null ? undefined : session.sessionModelUsage());
    if (models === undefined) return;
    await this.#recordUsage({ models }, 'session', 'cumulative');
  }

  /**
   * `result` に載っている消費を台帳へ積む。
   *
   * **モデル id で層を代用しない。** `ALTEROID_CLONE_MODEL` を置けばクローンも
   * マネージャーと同じ opus で走るので、台帳では同じ `model` に並ぶ。層は
   * `layer` の列で言う（`usage.ts` の `usageLayerSchema`）。
   *
   * **台帳に積めないことでクローンのターンを止めない。ただし黙って消さない**
   * （`manager.ts` の `case 'usage'` と同じ作法）。
   */
  async #recordUsage(
    usage: AgentTurnUsage | undefined,
    site: UsageSite,
    accumulation: 'cumulative' | 'oneshot',
    /**
     * ターンの境界で聞いた文脈占有と、ターンの間に起きた compaction
     * （`case 'turn_ended'` だけが渡す）。**蒸留のサイドクエリ（`site: 'distill'`）
     * からの呼び出しは渡さない** —— あちらはこの層の外の短命セッションで、
     * `this.#turn` も `this.#query`（本セッションの）も指していないので、
     * 文脈占有もこのターンの compaction も原理的に持たない（`schema.ts` の
     * `turn_usage.contextUsage` / `turn_usage.compactions` の doc）。
     */
    turnBoundary?: {
      contextUsage?: ContextUsageObservation;
      compactions?: CompactionObservation[];
    },
  ): Promise<void> {
    // **積める消費が無い回はここで終わる。** 「成功した result だけを通す」の
    // 判定は provider の写しが済ませている（`claude-provider.ts` の
    // `foldClaudeMessage` ＋ `usage.ts` の `isSuccessResult`）ので、
    // `usage` が無いことがそのまま「積む値が無い」である。
    //
    // **⚠️ Issue #982 以降、`turnBoundary?.contextUsage` はここで一緒に
    // 捨てても文脈占有そのものを失わない。** 呼び出し元（`case 'turn_ended'`）
    // が `event.succeeded` を見る前に独立の `context_usage` journal 行として
    // 既に書いてある——ここで早期 return するのは、あくまで `turn_usage`
    // （消費の増分の行）とその欄に相乗りする `contextUsage` の写しだけである。
    if (usage === undefined) {
      // **消費を報告しない provider だけが「取れなかった」を数える。** 条件は
      // `capabilities.usage === false` であって `usage === undefined` ではない——Claude の
      // 失敗した result も usage を持たないが、あれは無報告ではない（数えない）。
      if (this.#provider.capabilities.usage === false) await this.#recordUnmeteredTurn(site);
      return;
    }

    const snapshot: UsageSnapshot = usage;

    const at = new Date();
    try {
      const fold = await this.#stores.usage.record({
        layer: 'clone',
        site,
        managerId: CLONE_ACTOR_ID,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot,
        accumulation,
        // **セッションが起きた瞬間の身元を使う**（`#sessionTokenIdentity`）。
        // ここで `#tokenIdentity?.()` を読み直すと、回した直後に届いた**前の
        // セッションぶんの消費**が新しいトークンに付く（`store.ts` の
        // `UsageStore.record` の `tokenId` の doc）。
        //
        // **無いときは渡さない。** プールが空の器では毎回 undefined になり、
        // 台帳のトークン軸は空のまま ＝ 受け入れ基準7（既定の構成の挙動を
        // 1文字も変えない）。
        ...(this.#sdkSession.sessionTokenIdentity === undefined
          ? {}
          : { tokenId: this.#sdkSession.sessionTokenIdentity.tokenId }),
      });

      // **ターン1回ぶんの増分を日誌へ残す。** 台帳は日 × actor × モデル ×
      // 層 × 場所に畳むので、このターンがいくらだったかは台帳のどこにも
      // 残らない（`schema.ts` の `turn_usage` の doc）。
      //
      // **増分が空の回は行を書かない**（`hasAnyUsage` と同じ判定を
      // `fold.delta` に直接当てる — `foldUsageSnapshot` / `foldOneshotUsage`
      // は増えていないモデルの行を作らないので、キーが1つも無ければ「この
      // 回は増分ゼロだった」で確定する）。取れない軸に0の行を作らない
      // （AGENTS.md 地雷表）。
      if (Object.keys(fold.delta).length > 0) {
        await this.#journal({
          type: 'turn_usage',
          layer: 'clone',
          site,
          managerId: CLONE_ACTOR_ID,
          ...(usage.sessionId === undefined ? {} : { sessionId: usage.sessionId }),
          models: fold.delta,
          ...(fold.reset === undefined
            ? {}
            : {
                reset: { fromCostUsd: fold.reset.fromCostUsd, toCostUsd: fold.reset.toCostUsd },
              }),
          ...(usage.mainLoopUsage === undefined ? {} : { mainLoopUsage: usage.mainLoopUsage }),
          ...(turnBoundary?.contextUsage === undefined
            ? {}
            : { contextUsage: turnBoundary.contextUsage }),
          ...(turnBoundary?.compactions === undefined || turnBoundary.compactions.length === 0
            ? {}
            : { compactions: turnBoundary.compactions }),
        });
      }

      // **数え直しを黙って通さない。** resume や mid-session の `/clear` で累積が
      // 0 に戻るのは正常だが、記録が無いと後から「なぜ集計が飛んでいるか」を誰も
      // 辿れない（PRD「可観測性」）。クローンは resume する層なので必ず起きる。
      if (fold.reset !== undefined) {
        await this.#journal({
          type: 'exchange',
          with: 'self',
          role: 'outbound',
          text:
            `${EXCHANGE_KIND_GAUGE_PREFIX}自分の消費の累積が数え直された（${fold.reset.fromCostUsd.toFixed(4)} → ` +
            `${fold.reset.toCostUsd.toFixed(4)}）。resume か /clear で SDK 側の累積が ` +
            '0 から始まったため。記録済みの分は保持している。',
        });
      }
    } catch (error) {
      // **跡がどこにも無いと「日誌に無い」が「起きなかった」と読める。**
      // `noteDroppedRecord` の作者の理由（ストアへの書き込みが失敗している
      // のに同じストアへ日誌を書こうとするのは循環である）は正しい。だから
      // stderr をやめて日誌にするのではなく、**両方を残す**。
      //
      // stderr は今回も残す（消さない） — 台帳の失敗を確実に名指しする跡が
      // 1本要る。下の `#journal` が失敗すればその跡は `#journal` 自身の
      // catch（stderr フォールバック）に落ち、「台帳が落ちた」という名指しが
      // 消えて「日誌を記録できませんでした」という別の文言に置き換わる。
      // stderr にこの行を残しておけば、その置き換わりが起きても「台帳が
      // 落ちた」という事実だけは残る。
      noteDroppedRecord('利用状況の台帳', `layer=clone site=${site}`, error);

      // **ここで日誌にも1件残す。** マネージャー層の `case 'usage'` の
      // `catch` は `exchange with=manager` を書いて日誌に跡を残すが、
      // クローン層はここが `noteDroppedRecord` だけで終わっていたため、
      // 台帳の記録が落ちたクローンのターンは日誌に `turn_usage` も
      // `exchange` も1行も残らなかった（`schema.ts` の `turn_usage` の
      // doc「行が無い理由は3つある」の2番）。
      //
      // **これは循環しない。** `#journal` は既に「best-effort で日誌へ
      // append し、失敗したら `noteDroppedRecord('日誌', ...)` で stderr に
      // 落とし、throw しない」という契約を持っている（`#journal` の実装を
      // 見よ）。だから日誌への追記そのものが失敗しても、それはここへ
      // 投げ返らず、`#journal` の中で吸収されて終わる。台帳への書き込みが
      // 失敗した状態で「同じ場所（台帳）へもう一度書きに行く」わけではなく、
      // 別のストア（日誌）へ1回だけ試すだけなので、堂々巡りにならない。
      //
      // `with: 'self'` を使うのは、これが人間に見せない内部ターンだから
      // （`schema.ts` の `exchange.with` の doc）。マネージャー層が
      // `with: 'manager'` を使うのと対応する。
      //
      // 文言はマネージャー層（`manager.ts` の `case 'usage'` の catch）と
      // 揃える。層ごとに言い方を変えると、読む側が層ごとに文言を覚える
      // ことになる。ただしマネージャー層は複数のマネージャーを区別する
      // ために `managerId` をタグとして前置しており、クローン層には
      // マネージャーのような複数性が無い代わりに `site`（`session` /
      // `distill`）が呼び出し文脈を区別する軸なので、同じ位置に `site` を
      // タグとして前置する。
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_FAILURE_PREFIX}[site=${site}] 消費を台帳へ記録できなかった（この分は集計に出ない）`,
      });
    }
  }

  /**
   * 消費を報告しない provider のターンを台帳へ「取れなかった」として1回数える。**0 を積まない**
   * （`UsageStore.recordUnmetered`）。台帳に積めなくてもターンは止めず、跡は stderr に残す。
   */
  async #recordUnmeteredTurn(site: UsageSite): Promise<void> {
    const at = new Date();
    try {
      await this.#stores.usage.recordUnmetered({
        layer: 'clone',
        site,
        managerId: CLONE_ACTOR_ID,
        date: usageDate(at),
        at: at.toISOString(),
        provider: this.#provider.id,
        ...(this.#sdkSession.sessionTokenIdentity === undefined
          ? {}
          : { tokenId: this.#sdkSession.sessionTokenIdentity.tokenId }),
      });
    } catch (error) {
      noteDroppedRecord('利用状況の台帳（無報告のターン）', `layer=clone site=${site}`, error);
    }
  }

  async #read(q: AgentCloneSession): Promise<void> {
    let failure: { readonly error: unknown } | null = null;

    try {
      // **provider の綴りを読むのはここまでである**（駆動役の `readEvents` が
      // `foldClaudeMessage` 等で畳む）。ここから下へ流れるのは中立イベントだけで、
      // 次の provider を足しても `#apply` は1本のままになる（#486）。
      await q.readEvents((event) => this.#apply(event));
    } catch (error) {
      failure = { error };

      // init すら来ずに落ちたなら resume 素材が腐っている。捨てて作り直す。
      // 同一性はセッションではなく記憶に宿るので、捨てて困るものは無い。
      if (
        !this.#sdkSession.stopped &&
        !this.#sdkSession.sawInit &&
        this.#sdkSession.resumedFrom !== null
      ) {
        // **⭐ 捨てる前に墓標を立てる**（#564 E1b）。**順序が要点である** —— 捨てた後だと、
        // 立てる前にプロセスが死んだ回で id がどこにも残らない。
        //
        // **この回は退避が無い**（道具を1つも使っていないので `#transcriptPath` は
        // `null` で、`#salvageTranscript` は何もしない）。⟹ `TranscriptGrave` の側では
        // 拾えない。材料は pg に預けた生ログだけである。
        await this.#noteLostSession(this.#sdkSession.resumedFrom);
        // **捨て損ねたことを黙らせない**（issue #1157）。ここで投げると失敗の報告
        // そのものが失敗するので投げないが、跡は残す —— **同じ操作を打つ
        // `#noteContextWindowFold` が既にこの形で跡を残しており、こちらだけが
        // 黙っていた。** 捨て損ねると、次の起動が腐った id をもう一度 resume
        // しに行く（この分岐へ戻ってくるので自己回復はするが、その1周は無駄に
        // なる）。
        await this.#stores.sessions.setCloneSessionId(null).catch((error: unknown) => {
          noteDroppedRecord('resume 素材の破棄', 'clone', error);
        });
      }
    } finally {
      if (!this.#sdkSession.stopped) {
        // result を伴わずに終わってもターンを取り残さない（取り残すと受信箱ごと止まる）
        const turn = this.#sdkSession.turn;
        if (turn) {
          await this.#reportFailure(
            turn.conversationId,
            failure ?? 'クローンのセッションが終了した',
          );
        }
        this.#finishTurn();
        // **`#query` を捨てる前に累積を1回読む**（`#flushSessionUsage` の doc）。
        // ここは直上の逐語のとおり「result を伴わずに終わった」経路 —— 枠切れ
        // （429）や文脈窓でセッションが落ちた回そのものである。捨ててから読んでも
        // 何も取れない。`runner.ts` の `#finish` が `#flushUsage()` を `close()` の
        // 手前に置いているのと対である。
        await this.#flushSessionUsage();
        this.#sdkSession.clearQuery();
        // 次のセッションは `#buildSessionSpec` が控え直す。ここで空にしておかないと、
        // 前のセッションで見せた分を「もう見せた」と数えたまま新しいシステム
        // プロンプトを組むことになる（実際には焼き込み直すので嘘にはならないが、
        // 控えの出所が2か所になる）。
        this.#distillMemory.forgetMemory();
        // **文脈窓で畳んだ回は、ここで生ログを器の外へ出す**（#553 / #564）。
        //
        // **`this.#query = null` より後に置いてある。** ここは `#read` の
        // `finally` で、`#read` は `#ensureQuery` から待たれずに走っている
        // （`this.#reader = this.#read(q)`）。⟹ 退避と蒸留を先に待つと、その間
        // `#query` が古いまま残り、次のターンが畳んだはずのセッションへ入る。
        //
        // **印を先に下ろす。** 下ろさずに `await` すると、その間に届いた失敗が
        // もう一度畳もうとする。
        if (this.#sdkSession.takeContextWindowRecycle()) {
          await this.#salvageTranscript();
        }
      }
    }
  }

  /**
   * 中立イベント1件へ反応する（`agent-events.ts` の表の (ii)）。
   *
   * **provider の綴りはここには無い。** 何が起きたかを決めるのは
   * `foldClaudeMessage` で、ここが決めるのは「起きたことへクローン層がどう
   * 反応するか」だけである —— 画面へ何を流すか、日誌へ何を書くか、ターンを
   * どこで畳むか。**その反応は層ごとに違う**（マネージャー層の同じ場所は
   * `runner.ts` の `#apply` で、副作用は2層で15種あり重なるのは2種だけである）。
   */
  async #apply(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'session_started': {
        this.#sdkSession.markSawInit();
        // **控え損ねたことを黙らせない**（issue #1157）。**投げない** —— 控えに
        // 失敗したことでセッションそのものを殺さない。**だが跡は残す**:
        // 控えられなければ次の起動で resume を諦めるが、その諦め方は
        // 「素材が無かった」という正常な経路と1文字も違わない
        // （`noteCloneSessionIdNotRecorded` の doc）。
        await this.#stores.sessions.setCloneSessionId(event.sessionId).catch((error: unknown) => {
          noteCloneSessionIdNotRecorded(error);
        });
        this.#captureInitFacts(event.runtime);
        return;
      }

      case 'permission_denied': {
        // 確認へ上げずにその場で止められた1件（分類器・deny 規則・モード）。
        //
        // **`permissionMode: 'auto'` で `canUseTool` を繋いでいない以上、拒否は
        // 普通に起きる**（そのうえ `settingSources` で人間の deny 規則も読む）。
        // ここを捨てると、クローンの手が止められたことが日誌のどこにも出ない ＝
        // 「静かになった」と「起きていない」が区別できなくなる（`runner.ts` の
        // 同じ箇所と同じ理由。あちらは受信箱にも出すが、こちらは**自分が**
        // ツール結果でエラーを読むので、要るのは後から辿れる記録だけである）。
        await this.#noteDenial(event.denial, 'live');
        return;
      }

      case 'usage_notice': {
        // 上限の文言。**API エラーとしては来ない**（SDK のコメント）ので、
        // 通知・情報メッセージの本文を見るしかない（`runner.ts` の同じ場面と
        // 同じ理由 — マネージャー側だけがこれを見ていて、クローン側に無いのは
        // 非対称だった）。
        // **文言の分類そのものは provider の写しが済ませている**
        // （`claude-provider.ts` の `foldClaudeMessage`）。ここへ届く時点で
        // 「上限の合図である」は確定している。
        await this.#noteUsageNotice(
          event.notice,
          this.#sdkSession.turn?.conversationId ?? null,
          'text',
        );
        return;
      }

      // 枠の事実（アカウント単位）。**ターンの頭ごとに来る**ので、ここが走行中の
      // 唯一の最新情報になる（`runner.ts` の同じ場面と同じ理由）。
      case 'rate_limit': {
        const facts = event.facts;
        // **回し手へは事実と遷移で渡す**（通知の形へ仕立て直したものではない）。
        // `#noteUsageNotice` の `source` の doc に理由がある。
        //
        // **状態ではなく遷移を渡す。** `rate_limit_event` はターンの頭ごとに
        // 来るので、状態をそのまま流すと同じ `rejected` で毎ターン回そうと
        // する。覚えるのは**重ねた形**（`mergeRateLimitFacts`）——届いた1件で
        // 丸ごと置き換えると、`status` を運んでいない観測が「もう知らせた」と
        // いう記憶を消す（あちらの doc）。
        //
        // **覚える欄は「トークンの身元 × 枠の種類」で分ける**（`usage-limits.ts` の
        // `rateLimitMemoryKey`）。`kind` だけで引いていた版には、別々のアカウントの
        // 事実が同じ欄を踏み合う穴が在った（Issue #1222 / #668。両方向の帰結は
        // あちらの doc）。⚠️ **身元はこのセッションを起こした瞬間のもの
        // （`#sessionTokenIdentity`）を使い、`#tokenIdentity?.()` を読み直さない**
        // —— 読み直さない理由は `UsageStore.record` の `tokenId` の doc と同じで、
        // 回った直後に届いた**前の鍵の観測**が新しい鍵の欄へ入るからである。
        const kind = facts.kind ?? '';
        const memoryKey = rateLimitMemoryKey(this.#sdkSession.sessionTokenIdentity?.tokenId, kind);
        const previous = this.#rateLimits.get(memoryKey);
        const transition = usageTransitionOf(previous, facts);
        const merged = mergeRateLimitFacts(previous, facts);
        this.#rateLimits.set(memoryKey, merged);

        // **跨いで畳んだ回を数える（Issue #1425）。** `transition` が
        // `undefined` の回は、直前に別の会話のターンが同じ壁を報告済み
        // だった回で、ここまでは日誌にも痕跡を残さずに消えていた。
        // 書き込む量・「跨いだ」の定義は `#rateLimitCrossFold` の doc に
        // ある理由（#1311 と同じ形の肥大化を作り直さない／同じ会話の連打は
        // 数えない）で、畳むたびには書かず、次に `transition` が定まった
        // 回にまとめて `#journal` へ吐き出す。
        const conversationId = this.#sdkSession.turn?.conversationId ?? null;
        if (transition === undefined) {
          const crossFold = this.#rateLimitCrossFold.get(memoryKey);
          if (crossFold !== undefined && crossFold.lastConversationId !== conversationId) {
            crossFold.folded.add(conversationId);
          }
        } else {
          const crossFold = this.#rateLimitCrossFold.get(memoryKey);
          if (crossFold !== undefined && crossFold.folded.size > 0) {
            await this.#journal({
              type: 'exchange',
              with: 'self',
              role: 'outbound',
              text:
                `${EXCHANGE_KIND_GAUGE_PREFIX}同じ壁を跨いで畳んだ回に、` +
                `${crossFold.folded.size} 本の異なる会話が当たっている` +
                '（前回この壁の遷移を記録してから、いまの遷移までのあいだ）。',
            });
          }
          // **この回の `conversationId` を、次に跨ぐかどうかの基準へ更新する。**
          // `folded` は必ず空から始める——上で書き出した分をここで捨てる。
          this.#rateLimitCrossFold.set(memoryKey, {
            lastConversationId: conversationId,
            folded: new Set(),
          });
        }

        // **⚠️ 遷移が取れなかった回も渡す（#668）。**
        //
        // ⚠️ **ここに書いてあった理由は、いまは成り立たない（消さずに残す）。**
        // かつては「遷移だけを渡していたので、同じ `kind` の `rejected` が**別の
        // トークンで**再発しても回し手へ1度も届かなかった —— `#rateLimits` は
        // **このインスタンスの寿命ぶん**残るので、`usageTransitionOf` は2度目以降
        // `undefined` を返す。⟹ 記録は `ready` のまま、実際は 429」と書いてあった
        // （実運用で観測済み。2026-09-07）。**その筋は記憶の鍵をトークンごとに
        // 分けたことで閉じた**（`rateLimitMemoryKey`。Issue #1222）。
        //
        // **⭐ それでもこの形は要る。** 同じ鍵で `rejected` が続いているあいだは
        // 遷移が立たず、その回し手の契機は門の後ろでは拾えない。⟹ 理由が1つ
        // 減っただけで、渡す条件は動かさない。
        //
        // **`statusNow` は重ねる前の生の1件から取る**（`merged` からではない）。
        // 重ねた形の `status` はアカウントを跨いで残るので、回す契機の材料にすると
        // 回した直後の健全な鍵でもう一度回る（`token-rotation.ts` の
        // `TokenRotationObservation.statusNow` の doc）。
        //
        // **これだけでは回らない。** 状態で回すには観測がいまの世代を名乗っている
        // ことが要る（`decideTokenRotation` の `freshness`）。**知らせの側
        // （`#noteUsageNotice`）は1文字も変えていない** —— あちらの畳みは
        // 「同じ知らせを何度も配らない」ためのもので、回し手の契機とは別である。
        if (transition !== undefined || facts.status === 'rejected') {
          await this.#observeForTokenRotation({
            facts: merged,
            ...(transition === undefined ? {} : { transition }),
            ...(facts.status === undefined ? {} : { statusNow: facts.status }),
          });
        }
        if (facts.status === 'rejected') {
          await this.#noteUsageNotice(
            rejectedRateLimitNotice(facts),
            this.#sdkSession.turn?.conversationId ?? null,
            'rate_limit',
          );
        }
        return;
      }

      case 'text_delta': {
        const turn = this.#sdkSession.turn;
        if (turn) {
          turn.streamed = true;
          turn.reply += event.text;
        }
        this.#emit(turn?.conversationId ?? null, { type: 'text', text: event.text });
        return;
      }

      case 'assistant_message': {
        const turn = this.#sdkSession.turn;
        const said = assistantTextOf(event.blocks);

        // **SDK が「これは応答ではない」と印を付けたメッセージは、応答として
        // 扱わない。** 支出上限（`billing_error`）・枠（`rate_limit`）・認証の失敗は
        // ここへ来る。直す前はこの印を1度も見ておらず、text ブロックを無条件に
        // `turn.text` へ足していたので、`You've hit your org's monthly spend limit …`
        // がそのままクローンの応答になり、日報の本文にまでなった。
        //
        // **本文は捨てず `turn.rejected` へ置く**（`resultFailureOf` と同じ材料として
        // `classifyUsageNotice` へ渡る）。人間へ `text` として流さないのは、
        // 「返答が来た」と見えてしまうからである — 終端は `result` の分岐が出す
        // `usage_limited` / `error` に任せる。
        const rejected = assistantFailureOf(event.errorCode, said);
        if (rejected !== undefined) {
          if (turn) {
            turn.rejected = rejected;
            // このメッセージの分として流れた片は返答にしない（日誌へ書かない）。書き済みの分は戻せない。
            turn.reply = turn.reply.slice(0, Math.max(turn.replyMessageStart, turn.replyWritten));
            turn.replyMessageStart = turn.reply.length;
          }
          return;
        }

        // 逐次配信の回で、このメッセージの片が1つも流れていなければ、本文は人間に出ていない。
        // 日誌には従来どおり残す（`reply` へだけ足す）。
        const unstreamedInStreamedTurn =
          turn !== null && turn.streamed && turn.reply.length === turn.replyMessageStart;
        for (const block of event.blocks) {
          if (block.type === 'text') {
            if (turn) turn.text += block.text;
            // 逐次配信が来ていない環境でも、人間に本文が届かないことは無いようにする
            if (!turn?.streamed) {
              if (turn) turn.reply += block.text;
              this.#emit(turn?.conversationId ?? null, { type: 'text', text: block.text });
            } else if (turn !== null && unstreamedInStreamedTurn) {
              turn.reply += block.text;
            }
          } else if (block.type === 'tool_use') {
            this.#emit(turn?.conversationId ?? null, { type: 'tool', tool: block.name });
          }
        }
        if (turn) turn.replyMessageStart = turn.reply.length;
        return;
      }

      // 道具の結果が返った＝実行は終わり、モデルが次を考え始めた。ここで
      // 送り直さないと画面は `tool` の合図（「…を実行中…」）のまま止まり、
      // もう終わっている実行をまだ続いているように見せてしまう。
      // `tool_result` を含むときだけにしているのは、人間の発言のエコーや
      // replay（`SDKUserMessageReplay`）を「考え始めた」と読み違えないため。
      case 'tool_result': {
        this.#emit(this.#sdkSession.turn?.conversationId ?? null, { type: 'thinking' });
        return;
      }

      case 'compaction': {
        // **ターンの間だけ保持する。** compaction は `result`（`turn_ended`）とは
        // 別のメッセージとして途中で届くので、ここで拾わないと `turn_ended` の
        // 一瞬しか見ない書き手からは見えなくなる（`schema.ts` の
        // `turn_usage.compactions` の doc）。
        //
        // **ターンの外で届いた分は拾えない。** `this.#turn` が `null`（人間とも
        // クローン自身とも話していない窓）なら静かに捨てる —— 対応する
        // `turn_usage` の行そのものが無いので、持ち帰る先が無い。
        this.#sdkSession.turn?.compactions.push({
          trigger: event.trigger,
          preTokens: event.preTokens,
          ...(event.postTokens === undefined ? {} : { postTokens: event.postTokens }),
        });
        return;
      }

      case 'turn_ended': {
        // **ターンの境界の文脈占有を、日誌へ1行書く前に1回だけ聞く**
        // （`schema.ts` の `turn_usage.contextUsage` の doc）。失敗しても
        // このターンの成否には影響させない —— `#observeContextUsage` が
        // 例外を内側で受け止める。
        const contextUsage = await this.#observeContextUsage();
        // **`self_status` の材料として控える（#804）。新しい呼び出しは増やさない**
        // ——上の1回の戻り値をそのまま持つだけである（`#lastContextUsage` の
        // doc）。`undefined`（まだ観測していない）は `null` へ寄せる —— この欄の
        // 3値（未観測 `null` / 試して失敗 `error` 付き / 観測できた値）を
        // `CloneRuntimeFacts.lastContextUsage` 側でも同じ形のまま保つため。
        this.#lastContextUsage = contextUsage ?? null;

        // **Issue #982 — 消費の行（`turn_usage`）とは独立に、観測できたら
        // 必ず日誌へ書く。** 委譲層（`runner.ts` の `case 'turn_ended'`、
        // #976 / PR #980）と同じ形——下の `#recordUsage` は
        // `usage === undefined`（失敗したターン）で早期 return するため、
        // そこへ相乗りさせている限り失敗したターンの文脈占有はどこにも
        // 残らなかった（`#recordUsage` の doc「積める消費が無い回はここで
        // 終わる」）。**`event.succeeded` を見る前に、観測できた値をここで
        // 独立にも書く**——`turn_usage`（消費の増分）とは別の行として日誌へ
        // 残る（`schema.ts` の `context_usage` の doc、`layer: 'clone'`）。
        //
        // **観測そのものが `undefined`（`#query` が既に無かった等）の回は
        // 書かない。** `#observeContextUsage` の3値（未観測 `undefined` /
        // 試して失敗 `error` 付き / 観測できた値）のうち、書くのは後の2つ
        // だけである——上の `#lastContextUsage` と同じ判断。
        if (contextUsage !== undefined) {
          await this.#journal({
            type: 'context_usage',
            layer: 'clone',
            site: 'session',
            managerId: CLONE_ACTOR_ID,
            ...(this.#sdkSession.sdkSessionId === null
              ? {}
              : { sessionId: this.#sdkSession.sdkSessionId }),
            turnSucceeded: event.succeeded,
            contextUsage,
          });
        }

        // **受信箱の流量（Issue #783 段0）も、同じターンの境界で1行書く。**
        // `context_usage` と同じ境界を使う——`event.succeeded` を見る前、
        // ターンの成否・消費の増分の有無とは無関係に毎回呼ぶ（そうしないと
        // `journal_read` で辿れる推移に穴が空く。`schema.ts` の `inbox_flow`
        // の doc「いつ書くか」）。
        await this.#writeInboxFlow();

        // **このターンの間に起きた compaction を取り出す。** `this.#turn` は
        // `#finishTurn()` が呼ばれるまでこの後も生きているので、ここで読んでも
        // 消えない（畳むのは `#finishTurn()` が `this.#turn = null` にする形
        // でまとめて行われる —— `#said` を個別に空配列へ戻す必要が無いのと
        // 同じ理由）。
        const compactions = this.#sdkSession.turn?.compactions ?? [];

        // **クローンの消費も台帳へ載せる。** ここを渡していなかったのは設計判断
        // ではなく抜けで（#45 の本文にも `usage.ts` にも「クローンの分は記録
        // しない」は無い）、その結果クローンは自分がいくら使ったかを読めなかった。
        // 人間は `claude.ai/settings/usage` で見られるので、これは能力の削除に
        // なっていた（north_star 禁止1）。
        await this.#recordUsage(event.usage, 'session', 'cumulative', {
          contextUsage,
          compactions,
        });

        // **生の合図と `result` の両方を読む。** SDK は前者を best-effort と言い、
        // 「authoritative なのは `result.permission_denials`」と言っている。
        // **成否で絞らない** — 拒否は成功したターンにも失敗したターンにも載る
        // （`runner.ts` の同じ箇所と同じ判断）。二重に書かないのは `#deniedToolUses`。
        for (const denial of event.denials) {
          await this.#noteDenial(denial, 'result');
        }

        const turn = this.#sdkSession.turn;
        // 失敗の印は日誌へ書く前に決める（下の分岐と同じ材料を使う）。**本文を
        // 「クローンの発言」として無印で残せるかどうかがこれで変わる。**
        const failure = event.failure ?? turn?.rejected ?? undefined;

        // 残りの本文（承認カードを出す道具が割った分より後）を書く。内部ターン（蒸留・自律）も必ず
        // 残す。見えない層を作らない。書く形は `#journalReply`。
        if (turn) await this.#journalReply(turn, failure !== undefined);

        // **成否を見ずに `done` を出していたのがこの穴の本体である。** 直す前は
        // ここで `result` の成否を一度も見ておらず、`error_during_execution` や
        // 支出上限でターンが死んでも `{ type: 'done' }` が無条件に出て
        // `#finishTurn()` が呼ばれていた。`#read()` の `finally` に来た時点で
        // `this.#turn` は既に `null` なので `#reportFailure` は一度も呼ばれず、
        // 例外も起きないから `#handle` は正常終了し、受信箱の合図は `#forget`
        // されて消える — 支出上限でクローンのターンが死んでも、どこにも記録が
        // 残らなかった。**`runner.ts` の `#apply` に在る、成否で分ける同じ形の
        // 分岐（`failure === undefined ? ... : ...`）をここにも置く**
        // （マネージャー側にはこの分岐と回帰テストがあり、クローン側だけ
        // 無いのは非対称だった）。
        //
        // **判定は `isAnsweredResult` である（`isSuccessResult` ではない）。**
        // `subtype: 'success'` かつ `is_error: true` という組み合わせが SDK の型に
        // あり（`SDKResultSuccess.is_error`）、`isSuccessResult` はそれを成功として
        // 通す — 台帳の問い（累積を通してよいか）と応答の問い（答えとして扱って
        // よいか）が違うからである（`sdk-failure.ts` の表）。**中立イベントは
        // 両方を別の欄で運ぶ** —— 台帳へ積む `usage` は `isSuccessResult` で絞られた
        // 側、`failure` は `isAnsweredResult` で絞られた側である。
        //
        // **`turn.rejected` も見る**（`failure` は上で決めてある）。`assistant.error`
        // が付いたメッセージが来たターンは、たとえ `result` が綺麗な成功で返って
        // きても応答として扱わない。
        if (failure !== undefined) {
          // **枠（利用上限）の文言を見逃さない。** 分類にかけるのは
          // **「SDK が失敗として出した文言」だけ**である — `assistant.error` の
          // 本文・`result.result`・`result.errors[]` の3つ。`classifyUsageNotice` は
          // 部分一致なので、クローンが書いた本文（`turn.text`）をここへ通すと
          // 「上限に当たったと日報に書いた瞬間に上限と誤判定する」自家中毒に
          // なる（`sdk-failure.ts` の doc の順序）。
          //
          // `errors[]` を混ぜたのは `runner.ts` の同種の候補列（逐語は
          // `grep -Fn -- 'for (const candidate of [failure.text, resultTextOf(event).text, ...event.errorLines])' packages/core/src/runner.ts`）
          // に揃えるためで、直す前はクローン側だけがこれを読んでいなかった。
          //
          // `reached` なら以降の合図を保持する側へ切り替わる（`#noteUsageNotice` が
          // `#usageBlocked` を立てる）。この `await` は下の `#reportFailure`
          // （`error` を emit する）より必ず先に終わる — `usage_limited` は終端では
          // ないので、終端の `error` より先に届いていなければならない。
          for (const candidate of [failure.text, event.body, ...event.errorLines]) {
            const notice = classifyUsageNotice(candidate);
            if (notice !== undefined) {
              await this.#noteUsageNotice(notice, turn?.conversationId ?? null, 'text');
              break;
            }
          }
          // 失敗した result では `done` を出さない。`#reportFailure` が出す
          // `{ type: 'error' }` を終端にする（成功したことにしない）。
          await this.#reportFailure(turn?.conversationId ?? null, failureReason(failure, event));
          // 失敗側でも必ず畳む。`#runTurn` は `#finishTurn()` が呼ぶ `turn.resolve()`
          // だけを待っており（`await done`）、`#handle`（`human_message` の分岐）は
          // その `#runTurn` を待つ。呼ばなければ `#runTurn` が永久に返らず、それを
          // 待つ `#handle` も返らず、`#handle` を待つ `#pump` の `for await` が
          // 次の合図へ進めない ＝ 受信箱ごと止まる。
          this.#finishTurn();
          return;
        }

        // **成功した result は「枠が開いている」ことの権威ある証拠なので、
        // ここで保持のスイッチを降ろす。** `rate_limit_event.status` は枠
        // 1つぶんの状態でしかない（`rateLimitFactsSchema` — `status` とは別に
        // `overageStatus` / `usingOverage` / `overageResetsAt` がある）。
        // つまり「`five_hour` が `rejected` でも課金枠（overage）に落ちて
        // ターンは成功する」という組み合わせが構造上ある — `usage-limits.ts`
        // の `usageTransitionOf` が `entered_overage` と名前まで付けている
        // **通常の遷移**であって、異常系ではない。
        //
        // 直す前は、ターン途中の `rate_limit_event`（`rejected`）で
        // `#usageBlocked` が立った後、同じターンの `result` が成功しても
        // それを見ずに `done` を出すだけだった。`#pump` の `finally` は
        // `#usageBlocked !== null` を見て `defer: true` にする（`#forget` しない）
        // ので、**答えが返って終わった合図が保持され、次の合図が来たときに
        // 同じ発言がもう一度処理される**（成功した仕事の二重実行。しかも
        // 「答えは返ったのに、もう一度同じことをやり出す」という、人間から
        // 見て最も分かりにくい壊れ方だった）。
        //
        // ここで降ろせば、`finally` は `#usageBlocked === null` を見て正しく
        // `#forget` する。**「試したら通った」を機構が自分で観測して状態を
        // 戻す**ことにもなり、タイマーを持たない設計（`#usageBlocked` の doc）
        // とも一貫する — 枠が開いたかを知る唯一の方法は試すことで、成功は
        // まさにその答えだからである。
        //
        // **`#notices`（`CloneNotices` の `#usage`。日誌の畳み込み）は降ろさない。**
        // あれは「同じ文言を二度書かない」ためのもので、枠が開いたかどうかとは
        // 別の関心である。
        this.#usageBlocked = null;
        // **抑止した再武装・畳んだ内部の失敗記録も、区間を跨いで持ち越さない**
        // （Issue #1240 続き。`#usageBlockSuppressedRearms` /
        // `#usageBlockFoldedInternalFailures` の doc）。ここは「枠の解除を
        // 試す」の1行を経由しない `#usageBlocked = null` なので（`#pump` 先頭の
        // 解除ブロックとは別の、ターン途中の成功による解除）、フラッシュする
        // 行が無い——それでも次の枠当たりへ古い件数を持ち越さないために0へ戻す。
        this.#usageBlockSuppressedRearms = 0;
        this.#usageBlockFoldedInternalFailures = 0;
        // **`usable` の2本目の生産者へ1本渡す**（#681 (1)）。ここは
        // `markTokenUsable` の doc が「`clone.ts` が成功した result で
        // `#usageBlocked` を降ろしているのと同じ根拠」と名指ししている場所
        // そのものである——成功は権威ある証拠なので、`TokenRotator.reconsider`
        // 側の記録（止まった記録・世代の照合）も同じ根拠で動かしてよい。
        // **`observedBy` はここでは付けない** —— `#observeForTokenRotation` が
        // `#sessionTokenIdentity`（このセッションが起きた瞬間の身元）から
        // 自動で付ける。
        await this.#observeForTokenRotation({ succeeded: true });
        // **このセッションで1度でも答えが返ったことを控える**（#553 の暴走の止め）。
        // `#usageBlocked` では代用できない —— あれは初期値も `null` なので
        // 「まだ成功していない」と区別できない（`#sessionAnswered` の doc）。
        this.#sessionAnswered = true;
        // **答えが返ったので、`held` と畳みの交互の連なりは切れた**（issue #955 の (A)）。
        this.#heldEscalationStreak = 0;
        // **成功は「積んだ入力が無駄になっている」ことの反証そのもの**
        // （Issue #1240。`#usageBlockedAccumulatedChars` の doc）。降ろさないと、
        // 次に `reached` に当たったときに前回までの積算から数え直してしまい、
        // 実際より早く畳む。
        this.#usageBlockedAccumulatedChars = 0;
        this.#emit(turn?.conversationId ?? null, { type: 'done' });
        this.#finishTurn();
        return;
      }

      // **この層が反応しない事実。** 委譲の区間（`worker_wait`）を数えているのは
      // マネージャー層（`runner.ts`）で、クローンは `Task` を持つが区間を数えて
      // いない。**「まだ書いていない」ではなく「この層は見ないと決めてある」である。**
      //
      // **`background_tasks` も同じ理由でここに並べる。** 数えているのは
      // マネージャー層（`runner.ts` の `#liveBackgroundTasks` →
      // `report.awaitingBackground`）で、クローンは自分自身の背景処理を
      // 数えていない——クローン自身が `Bash` を `run_in_background: true`
      // で起こしても、この事実はクローンの `AgentEvent` としては届く（同じ
      // `foldClaudeMessage` を通るため）が、「畳んだターンの報告を握り潰す」
      // という反応そのものをマネージャー層にしか実装していない（クローンの
      // ターンは人間が読む前提の別の面なので、握り潰す判断はまた別に要る）。
      case 'delegation_started':
      case 'delegation_notified':
      case 'background_tasks':
        return;

      // **枝が増えたらここが型で落ちる（#285 と同じ形）。** 落ちたら「この層は
      // その事実にどう反応するか」を決めてから通すこと —— 既定で無視へ倒すと、
      // provider が名乗り始めた事実が黙って網の外へ出る。
      default: {
        const unread: never = event;
        void unread;
        return;
      }
    }
  }

  /**
   * 受信箱の到着・配達・消し込み・滞留を、ターンの境界で1行にして日誌へ残す
   * （Issue #783 段0。欄の意味は `schema.ts` の `inbox_flow` の doc）。
   *
   * **`InboxStore.pending()` が読めなければこの窓は書かない。カウンタも
   * 戻さない** — 次のターンへ持ち越せば、この窓ぶんの到着・配達・消し込みは
   * 失わずに済む（`windowStartedAt` が正しく「その分だけ長くなった窓」を
   * 名乗る）。跡は `noteDroppedRecord` が残す（`#situationNoticeFor` の
   * `pending()` の扱いと同じ向き——読めないことでターンは落とさない）。
   *
   * **日誌への追記自体は `#journal` が best-effort で引き受ける**（失敗しても
   * 例外を投げ返さず、stderr へ跡を残すだけ）。ここでは追記の成否を問わず
   * 窓を空にする——`#journal` の失敗は既にそこで跡が残っており、この型だけ
   * 再送を試みる仕組みは持たない（他の journal 書き手と同じ「1回だけ試す」
   * 作法。`#journal` 自身の doc）。
   */
  async #writeInboxFlow(): Promise<void> {
    let pending: { count: number; oldestAt?: string };
    try {
      pending = await this.#stores.inbox.pending();
    } catch (error) {
      noteDroppedRecord('受信箱の流量（inbox_flow）', '', error);
      return;
    }

    // **`#journal` の引数を組み立てるこの時点でカウンタを読む。** `snapshot()`
    // は読むだけで何も変えない（`CloneInboxFlow.snapshot` の doc）ので、この
    // 1行を分けても「`#journal` を待つ間に届いた bump がスナップショットに
    // 入らない」という元の挙動は変わらない。
    const flow = this.#inboxFlow.snapshot();
    await this.#journal({
      type: 'inbox_flow',
      windowStartedAt: flow.windowStartedAt,
      arrived: flow.arrived,
      delivered: flow.delivered,
      settled: flow.settled,
      pending,
      // **窓の終わりの1点（Issue #1264、案1a）。** `arrived` / `delivered` /
      // `settled`（直上）と違って `.clear()` しない——時点の値であって
      // 増分ではない（`schema.ts` の `inbox_flow.retained` の doc）。
      retained: {
        unread: this.#delivery.unreadSize,
        redelivered: this.#delivery.redeliveryState.redeliveredSize,
        redeliveredClosed: this.#delivery.redeliveryState.redeliveredClosedSize,
        pendingCollapse: this.#delivery.collapseSize,
      },
    });

    // **`#journal` を待った後にだけ、3本を空にして窓を進める。** `pending()`
    // が失敗して上で return した回はここへ来ないので、カウンタは戻らず次の
    // 窓へ持ち越される（`#writeInboxFlow` の doc）。
    this.#inboxFlow.reset();
  }

  /**
   * 返答の本文のうち、まだ日誌へ書いていない分（`turn.reply.slice(turn.replyWritten)`）を、人間との
   * outbound の `exchange` として**1件**書く。**`type: 'exchange'` の書き込みはここ1か所だけ**
   * （ターン末の `turn_ended` と、承認カードを出す道具の `ToolContext.flushReply` の両方がここを通る。
   * `exchange-kind-coverage.test.ts` の数え方を崩さないため、そして2つの経路で付ける欄を食い違わせないため）。
   *
   * **1ターンが承認カードで割れたとき、各行に同じ欄を付ける**（`conversationId`・`approvalId`・
   * `answeredApprovalId`。`approval-trace` が `answeredApprovalId` で対にするので欠けさせない）。
   * 書くものが空白だけなら書かず、書き済みの印も進めない（次の行の頭に付く）。
   *
   * **失敗の前置きは `failed` のとき（＝ターン末）の行にだけ付く。** 失敗するまでに割れて書けた前の行は、
   * 失敗の前に出ていた本文として無印で残る。
   */
  async #journalReply(turn: Turn, failed: boolean): Promise<void> {
    const pending = turn.reply.slice(turn.replyWritten);
    if (pending.trim().length === 0) return;
    // **await の前に印を進める**。割る口が並行して呼ばれても、同じ本文を2度書かない。
    turn.replyWritten = turn.reply.length;
    await this.#journal({
      type: 'exchange',
      with: turn.conversationId === null ? 'self' : 'human',
      role: 'outbound',
      // **kind の接頭辞は self 側（内部ターン）にだけ付ける。** human 側
      // （`with: 'human'`）は、その1欄で「人間との生の往復である」ことが
      // 既に構造化されて分かる——本文は人間が画面で現に見ているものと1文字も
      // 変えない（`exchange-kind.ts` の doc）。
      //
      // **失敗したターンの本文には印を付ける。** 本文を捨てないのは、人間は
      // それを画面で現に見ている（逐次配信）ので、履歴から消すと見たものが
      // 探せなくなるからである。**無印で残さないのは、日誌が digest を通って
      // 次の日報の材料になるからである** — 印が無いと「クローンがそう言った」
      // として翌日の日報に効いてしまう。
      text:
        (turn.conversationId === null ? EXCHANGE_KIND_REPLY_PREFIX : '') +
        (failed
          ? `（このターンは失敗して終わった。以下は失敗する前に出ていた本文である）\n${pending}`
          : pending),
      ...(turn.conversationId === null ? {} : { conversationId: turn.conversationId }),
      // **issue #782 の1。`conversationId` が無い（＝ `with: 'self'`）行には
      // 立てない** —— 会話 id を持たない承認への回答は今までどおり内部
      // ターンのままで、`approvalId` が付くと人間の会話の一部であるかの
      // ように読めてしまう（`schema.ts` の `exchange.approvalId` の doc）。
      ...(turn.conversationId === null || turn.approvalId === null
        ? {}
        : { approvalId: turn.approvalId }),
      // **issue #847 の案B。** 上の `approvalId` と違い、会話の有無を問わず
      // 立てる（`schema.ts` の `exchange.answeredApprovalId` の doc）。
      ...(turn.approvalId === null ? {} : { answeredApprovalId: turn.approvalId }),
    });
  }

  /**
   * `ToolContext.flushReply` の実体（#3605）。承認カードを出す道具が、カードの `createdAt` を決める前に
   * 呼ぶ。**会話のあるターン（人間に見せるターン）だけ割る**——内部ターン（`conversationId === null`）の
   * 承認は会話の履歴に出ないので、割っても並びは変わらず行が増えるだけになる。
   */
  async #flushReply(): Promise<void> {
    const turn = this.#sdkSession.turn;
    if (turn === null || turn.conversationId === null) return;
    await this.#journalReply(turn, false);
  }

  /** 日誌の書き込み失敗でクローンのセッションを殺さない。 */
  async #journal(entry: JournalEntryInput): Promise<void> {
    try {
      await this.#stores.journal.append(entry);
    } catch (error) {
      // 記録できないこと自体は致命ではない。文脈を失う方が高くつく。
      // **ただし黙って消さない。** 跡がどこにも無いと「日誌に無い」が
      // 「起きなかった」と読めてしまい、日誌を判別器に使った切り分けが
      // 静かに嘘をつく（本文を出さない理由は `noteDroppedRecord`）。
      //
      // **⚠️ ここから `#journal` を呼び直さないこと。** 日誌への書き込みが
      // 失敗した直後に日誌へ書き直そうとするのは、本物の循環である
      // （`noteDroppedRecord` の doc「ストアが閉じている窓で日誌へ書こうと
      // しても同じ理由で落ちるため」）。他の呼び出し元（`#recordUsage` 等）が
      // 「まず本来のストアへ書き、失敗したら `#journal` へ1回だけ試す」の
      // 形で二段構えにするのは循環にならないが、それはあちら側の話であって、
      // ここ（`#journal` 自身の失敗経路）から一歩でも日誌へ戻ろうとした
      // 瞬間に循環になる。stderr で止めるのはそのためである。
      noteDroppedRecord('日誌', journalEntryShape(entry), error);
    }
  }

  /**
   * 中身（ターンを取り出して `null` にし、控えていた `resolve()` を呼び、
   * 回す印が立っていれば入力待ちで止まっている `#inputStream` を起こす）は
   * `CloneSdkSession#finishTurn` へそのまま移した——触る4フィールド
   * （`#turn`・`#recycleForToken`・`#recycleForContextWindow`・
   * `#inputWaiter`）がすべてあの器の中にあるため、丸ごと1つの遷移として
   * 移せた。ここは薄い口である。
   */
  #finishTurn(): void {
    // **ターンの終わりでも途中経過を捨てる**（Issue #2652）。失敗の経路は
    // `#reportFailure` が `error` を出してから来るので、ふつうは `#emit` が既に捨てている。
    // ここは、`error` / `done` を出さずに終わる経路が将来増えても記録が残り続けない
    // ための二重の網である（残ると、会話を開き直した人間に終わったターンの途中経過が
    // 「進行中」として流れ続ける）。畳む前に会話 id を読む（畳んだ後は `turn` が無い）。
    const conversationId = this.#sdkSession.turn?.conversationId ?? null;
    this.#sdkSession.finishTurn();
    if (conversationId !== null) this.#progress.clear(conversationId);
  }

  #emit(conversationId: string | null, event: ChatStreamEvent): void {
    if (conversationId === null) return;
    // 記録は購読者への配送より先に、同じ同期区間で行う（`attach` の継ぎ目の保証）。
    this.#progress.record(conversationId, event);
    for (const listener of this.#delivery.listenersFor(conversationId)) {
      try {
        listener(event);
      } catch {
        // 購読側の失敗でクローンを止めない
      }
    }
  }
}

/** 人間の発言1件。 */
export type HumanMessage = Extract<InboxEvent, { type: 'human_message' }>;

function isHumanMessage(event: InboxEvent): event is HumanMessage {
  return event.type === 'human_message';
}

/**
 * マネージャーからの一件のうち、報告（`kind === 'report'`）だけを指す。
 *
 * `InboxEvent` の `manager_message` は `kind` を `'report' | 'question' |
 * 'permission'` の単一の enum で持つ（`kind` ごとに別の型が分かれる判別可能な
 * 共用体ではない）ので、`Extract<InboxEvent, { type: 'manager_message';
 * kind: 'report' }>` は効かない（`Extract` は共用体のメンバー単位でしか
 * 絞れず、1つのメンバーの中のフィールドをさらに狭めることはできない）。
 * `& { kind: 'report' }` の交差型で上書きして表す。
 */
type ManagerReportMessage = Extract<InboxEvent, { type: 'manager_message' }> & { kind: 'report' };

function isManagerReport(event: InboxEvent): event is ManagerReportMessage {
  return event.type === 'manager_message' && event.kind === 'report';
}

/** 外部からの出来事1件（issue #841）。`HumanMessage` / `ManagerReportMessage` と同型。 */
export type ExternalEvent = Extract<InboxEvent, { type: 'external' }>;

function isExternalEvent(event: InboxEvent): event is ExternalEvent {
  return event.type === 'external';
}

/**
 * 人間の発言をターン1本の本文にする。
 *
 * **1件なら本文そのままである。** 断り書きを足さない — いちばん多いのがこの形で、
 * ここに `[system]` の節を載せると、普通の一往復のたびに読ませるものが増える。
 *
 * 複数件になるのは、先客が居るあいだに人間が喋り続けたときである（`#mergedHumanBatch`）。
 * そのとき渡すのは**全文を届いた順に並べたもの**で、要約も間引きもしない。
 *
 * **時刻を各件に添える。** 「3分空けて言い直した」と「続けて3行打った」は別の
 * 出来事で、後者なら最後の一行だけが本題のことがある。判断の材料はクローンに渡し、
 * どう読むかはこちらで決めない（プロンプトで「最後のものを優先せよ」とは書かない —
 * 前の依頼を取り消したのか、条件を足したのかは本文だけが持っている）。
 *
 * **⚠️ 「N 件」は束の件数であって「届いた総数」ではない（issue #783 の続き）。**
 * `#drainMergeableWithinLimit` は上限で束を切ることがあり、切ったときは
 * `events.length` が実際に届いた総数より小さくなる。**だから文面は
 * 「N件が届いた」ではなく「N件をまとめて渡す」の形にしてある** —— 前者は
 * 上限に当たった回に偽になるが、後者はこの束の件数を言っているだけなので、
 * 上限に当たったかどうかに関わらず常に真である。切ったという事実そのものは
 * `#notices` の `mergedBatchTruncation`（別の断り書き）が言う——ここで重ねて
 * 言わない。
 *
 * **`supersedes` を持つ発言（チャットの「メッセージを編集する」機能）には、
 * 編集であると分かる合図を前置きする。** 断り書きを足さないという上の方針は
 * 「普通の一往復」の話であって、編集は普通の一往復ではない——合図が無いと
 * クローンは「先ほど述べたとおり」と噛み合わない応答をする（issue「チャットの
 * 送信済みメッセージを編集する」）。**逆に `supersedes` が無い発言には1文字も
 * 足さない**（この関数はまだ pure/sync であり、ストアへは一切触れない——
 * 編集前の本文は呼び出し側が `priorTexts` として解決済みで渡す）。
 */
export function humanTurnText(
  events: HumanMessage[],
  priorTexts: ReadonlyMap<string, string> = new Map(),
  attachmentNotices: ReadonlyMap<string, string> = new Map(),
): string {
  const head = events[0];
  if (head === undefined) return '';
  const bodyOf = (event: HumanMessage): string => {
    const body = editedTurnBody(event, priorTexts.get(event.id));
    const notice = attachmentNotices.get(event.id);
    // 添付だけで本文が空の発言は、通知行だけを本文にする（先頭に空行を残さない）。
    if (notice === undefined) return body;
    return event.text === '' && event.supersedes === undefined ? notice : `${body}\n\n${notice}`;
  };
  if (events.length === 1) return bodyOf(head);

  return [
    `[system] 前のターンを処理しているあいだに人間から届いた発言を、続けて **${events.length} 件** ` +
      'まとめて渡す（届いた順の全文で、要約していない）。',
    '**まとめて1つの応答で答えよ。** 1件目に答えたうえで、後の発言が' +
      'それを言い直している・取り消している・条件を足していることがある。**最後まで読んでから答えること。**',
    '',
    '---',
    '',
    ...events.map(
      (event, index) =>
        `**(${index + 1}) ${event.at}**` +
        `${event.supersedes === undefined ? '' : '（既出発言の編集）'}` +
        `\n\n${bodyOf(event)}\n`,
    ),
  ].join('\n');
}

/**
 * 1件ぶんの本文に、必要なら編集の合図を前置きする。
 *
 * **`supersedes` が無ければ、素通しである。** `head.text` をそのまま返す
 * （`humanTurnText` の doc「普通の一往復のたびに読ませるものが増える」を
 * 1件の場合にも守るため）。
 *
 * **`priorText` が引けなかったとき（`undefined`）も、編集である事実だけは
 * 伝える。** 旧エントリが窓の外に落ちた・日誌に無い、いずれの場合でも
 * 「これは編集である」という合図自体は失わない——本文が引けないことと、
 * 編集だという事実が分からないことは別の欠落である。
 *
 * **副作用の巻き戻しは一切指示しない（制約(B)）。** ここが言うのは「これは
 * 既出発言の編集であり、編集前の本文はこれである」までで、「だから前のターンの
 * 承認待ち・記憶・台帳の行を取り消せ」とは書かない——書けば、いま存在しない
 * ロジックをプロンプト側から作ることになる。
 */
function editedTurnBody(event: HumanMessage, priorText: string | undefined): string {
  if (event.supersedes === undefined) return event.text;
  const notice =
    priorText === undefined
      ? `[system] これは既出発言（id=${event.supersedes}）の編集である。` +
        '（編集前の本文は引けなかった。）'
      : `[system] これは既出発言（id=${event.supersedes}）の編集である。編集前の本文:\n\n${priorText}`;
  // 本文が空（添付だけの編集）なら、区切りの後ろに何も置かない。
  return event.text === '' ? notice : `${notice}\n\n---\n\n${event.text}`;
}

/**
 * 質問・許可確認が、いまも `ManagerPool` の `waiting` で待たれているかの3値。
 *
 * 2値にしない（`AGENTS.md`「静かに失敗する道具」— 判定できない場合がどちらかへ
 * 黙って倒れる）。**`'unknown'` は安全側（雑音）へ倒すためのものであって、
 * 「待っている」の言い換えではない** — `managerPrompt` はこれを `'live'` と
 * 同じ扱いにするが、根拠が無いことは呼び出し元がここで確定させる。
 */
type ConfirmationLiveness = 'live' | 'settled' | 'unknown';

/**
 * 台帳の項目（`event.id` で引く1件）が、既に片付けられているかの3値（#391）。
 *
 * **当初は `kind === 'report'` 限定だったが、#871 で `question` / `permission`
 * にも広げた。** `commitmentFor` は `manager_message` のどの `kind` でも
 * `id: event.id` で同じ台帳行を積むので、この3値自体は kind を問わない
 * （kind ごとに違うのは「誰がこれを見るか」であって、値の意味ではない）。
 *
 * **2値にしない**（AGENTS.md「静かに失敗する道具」——判定できない場合が
 * どちらかへ黙って倒れる）。`'unknown'` は**安全側＝雑音側**（＝ふつうに全文を
 * 出す）へ倒すためのもので、`'open'` の言い換えではない。
 *
 * ## `'open'` は「まだ読んでいない」を意味しない
 *
 * クローンが閉じずに読んだ行は `'open'` のままである。**この3値が保証するのは
 * 「閉じたものには印が付く」までであって、「印が無ければ未読」ではない。**
 */
type ReportSettlement =
  { kind: 'closed'; closedReason?: string } | { kind: 'open' } | { kind: 'unknown' };

/**
 * 述語が当たった配り直しの件数を、日誌の跡として数えられるようにする
 * （issue #1374。#879 から切り出し）。
 *
 * ## 何を数えるか
 *
 * 述語は2つある。**(A)** `reportSettlement` / `closedReportNotice`
 * （「私が対処したか」）と **(B)** `inbox-validity.ts` の `inboxEventValidity` /
 * `describeValidity`（「その合図がまだ有効か」）。#1374 はまだ「注記して配る
 * （いま）」と「抑える」のどちらにするかを決めていない——決める前に要るのが
 * 件数である。ここで足すのは**数える跡だけ**で、配り方（モデルへ渡す本文・
 * 断り書きの文言・配る/配らないの判定）は1文字も変えない：この2つの定数は
 * 日誌へ書く行の**先頭にだけ**現れ、`composeTurnInputText` を経由してモデルへ
 * 渡る文字列には一度も混ざらない（呼び出し箇所は `Clone#journal` だけを叩く
 * `#noteRedeliveryPredicateHitA` / `#noteRedeliveryPredicateHitB` の2つに
 * 閉じている）。
 *
 * ## いつ書くか（`#foldClosedRedelivery` と二重に数えない）
 *
 * - **(A)** は、`closedReportNotice(settlement)` が非 null で、かつその報告が
 *   実際に配られた回（`#handle` の `manager_message`/`report` 分岐、または
 *   `#runManagerReportBatch` の束の中の1件）にだけ書く。**片付け済みの
 *   配り直し**（`#foldClosedRedelivery` が畳む回）はここへ来ない——`#pump` が
 *   まとめ読みの判定より前で畳んでおり、`closedReportNotice` を一度も
 *   呼ばない経路だからである。畳んだ回の跡は既に在る（`#foldClosedRedelivery`
 *   が書く「片付け済みの配り直しなので、ターンを起こさずに畳んだ」の1行）ので、
 *   ここでは足さない（二重に数えない）。
 * - **(B)** は、`describeValidity(...)` が空文字でなく、かつそのターンが
 *   実際に起きた回（`#pump` が `#notices` へ `validity` を積んだ直後——
 *   この時点から先、その反復は必ずいずれかのターンを起こす。畳む判定は
 *   これより前で終わっている）にだけ書く。
 *
 * ## 上限は1回につき高々1行（#1311 の日誌の行数の関心への配慮）
 *
 * - (A) は `closedReportNotice` が1件の報告につき高々1回しか呼ばれない
 *   （`managerPrompt` の単発経路・`managerReportBatchPrompt` の束の中の
 *   1件ぶん）ので、**配った報告1件につき高々1行**——述語が当たらない報告には
 *   1行も増えない。
 * - (B) は `#validityNoticeFor` がその反復の束の先頭1件だけを見て1回だけ
 *   呼ばれる（`#validityNoticeFor` の doc「`events[0]` だけを見る」）ので、
 *   **ターン1回につき高々1行**——述語が当たらない反復には1行も増えない。
 */
export const REDELIVERY_COUNT_PREFIX_A = '【数える:A】';
export const REDELIVERY_COUNT_PREFIX_B = '【数える:B】';

/**
 * 片付け済みの報告に添える「閉じた理由」の長さ（#391）。
 *
 * **全文ではなく先頭だけでよい。** 目的は「自分がどういう判断で閉じたか」を
 * 思い出させることであって、判断そのものを読み直させることではない
 * （読み直すなら `commitment_list` に全文が在る）。
 */
const CLOSED_REASON_EXCERPT = 120;

/**
 * 報告の台帳項目を引いて、既に片付けられているかを答える（#391）。
 *
 * ## なぜ台帳を引くのか（質問側と材料が違う）
 *
 * 質問・許可確認は `managers.list()` の `waiting` に `requestId` が載っているかで
 * 「もう待たれていない」を判定できる（{@link confirmationLiveness}）。**報告には
 * `requestId` が無く、「待たれている」という状態がそもそも存在しない。** 報告に
 * おける「もう要らない」の合図は、**クローンが `commitment_close` で閉じたこと
 * そのもの**である。
 *
 * ## 「配り直しかどうか」を見ない —— それがこの判定の要点である
 *
 * `#redeliveredClosed` を引く既存の断り書きは、`#restoreUnread`（プロセスの生涯に
 * 1回だけ走る）が埋めた Map しか見ないので、**起動を跨がない配達には初めから
 * 対象外である。** そして `Clone#post()` は受信箱へ積む**前**に `#commit` を呼ぶので、
 * **台帳に本文が見えるのは `post()` 到達の瞬間であって、ターンへ配られた時点では
 * ない** —— クローンは配られる前の本文を台帳で読んで閉じられる。**その後に来る
 * 「初回配達」は配り直しではないので、配り直しの機構では原理的に捕まえられない。**
 *
 * **だからここでは配り直しかどうかを一切見ず、「いま配ろうとしているこの報告は、
 * 台帳で既に閉じているか」だけを見る。** #391 が未決のまま残した問い（初回配達か
 * 再配達か）に答えなくても、この判定は成り立つ。
 *
 * 追加の I/O は無い —— 台帳の id は `event.id` そのもの（{@link commitmentFor} の
 * `base`）で、`closedAt` / `closedReason` は `get(id)` の戻り値に載っている。
 *
 * ## #871 —— `question` / `permission` にも同じ判定を足す
 *
 * 質問・許可確認の「もう要らない」判定（`waiting` を見る {@link confirmationLiveness}）は
 * `manager_send` で答えたことしか見ておらず、**クローンが `commitment_close` で
 * その行を閉じても、何も変わらなかった**（#394 が report 側だけに付けた印の、
 * 鏡像の穴）。材料を増やすだけで、この関数の作りは変えない —— `commitmentFor` は
 * `manager_message` のどの `kind` でも `id: event.id` で同じ台帳行を積むので、
 * `question` / `permission` の `event.id` を渡しても、そのまま同じ答えが返る。
 * 呼び出し元（`managerPrompt`）が `liveness` と `settlement` の**両方**を見て、
 * どちらかが「もう要らない」と言えば答え直せとは言わない、という形にする。
 */
async function reportSettlement(
  commitments: Stores['commitments'],
  id: string,
): Promise<ReportSettlement> {
  const commitment = await commitments.get(id).catch(() => null);
  // **引けなかったのと「無い」のを混ぜない。** `get` は無ければ `null` を返すが、
  // 投げたときもここで `null` に畳んでいる——どちらも「閉じていると言える根拠が
  // 無い」側なので、同じ `'unknown'` へ倒す。**`'open'` にはしない**：
  // 「開いている」は台帳を実際に読めたときにだけ言える。
  if (commitment === null) return { kind: 'unknown' };
  if (commitment.closedAt === undefined) return { kind: 'open' };
  return {
    kind: 'closed',
    ...(commitment.closedReason === undefined ? {} : { closedReason: commitment.closedReason }),
  };
}

/**
 * 「閉じた理由」の括弧書きを組み立てる（#391 / #871 共通）。
 *
 * **誤って閉じたとき、誤りは「閉じた理由」に出る。** 実例（2026-08-24、台帳
 * `801f5ee7`）: クローンが「判断は求めていない」と書いて閉じたが、**本文の後半に
 * 依頼が入っていた。** 印だけでは「片付け済みだから読まなくてよい」と読めてしまい、
 * その誤りに気づく手がかりが1つも無い。
 *
 * `closedReason` が無ければ空文字を返す——呼び出し側はそれを括弧ごと出さない
 * （取れない軸に値を作らない）。
 */
function closedReasonParenthetical(
  settlement: Extract<ReportSettlement, { kind: 'closed' }>,
): string {
  return settlement.closedReason === undefined
    ? ''
    : `（閉じた理由: 「${excerptLine(settlement.closedReason, CLOSED_REASON_EXCERPT)}」）`;
}

/**
 * 片付け済みの報告に添える1行（#391）。**閉じた理由の先頭を一緒に運ぶ。**
 *
 * **ただし本文の代わりにはならない。** 上の実例（`closedReasonParenthetical` の
 * doc）でクローンが気づけたのは本文の後半を読み直したからであって、閉じた理由を
 * 見たからではない。**だから本文は短くしない**（{@link managerPrompt} の doc）。
 */
function closedReportNotice(settlement: ReportSettlement): string | null {
  if (settlement.kind !== 'closed') return null;
  return `この報告は台帳で既に片付けている${closedReasonParenthetical(settlement)}。読み直す必要は無い。`;
}

/**
 * 片付け済みの質問・許可確認に添える1行（#871）。**`closedReportNotice` の姉妹版。**
 *
 * ## なぜ別の関数にするのか（文言を使い回さない）
 *
 * 報告の印は「読み直す必要は無い」で終わる——報告は読むものだからである。
 * 質問・許可確認は答えるものなので、同じ語尾を使うと嘘になる。**`label`
 * （「質問」／「実行の許可確認」）で主語を差し替え、語尾も「答え直す必要は無い」
 * にする。** `closedReportNotice` 自身の出力・doc は変えていない——既存の
 * report 向けの歯（#391）が保証している文言はそのまま残る。
 */
function closedConfirmationNotice(settlement: ReportSettlement, label: string): string | null {
  if (settlement.kind !== 'closed') return null;
  return `この${label}は台帳で既に片付けている${closedReasonParenthetical(settlement)}。答え直す必要は無い。`;
}

/**
 * 「受け取ってからどれだけ経ったか」を丸めて言う（#562）。
 *
 * ## `at` は「書かれた時刻」ではない
 *
 * `event.at` は `Clone#post()` が受理した時点の時刻であって、マネージャーが
 * その報告を**書いた**時刻ではない（`post()` の doc。受信箱へ積む前に走る
 * `#commit` もこの同じ `at` を使う）。**だから文言は「受け取ってから」
 * 「受け取った時刻」で書く** — 「書かれてから」「書かれた時刻」は測っていない
 * 値を名乗ることになる。
 *
 * ## 閾値を設けない
 *
 * 経過が短くても必ず1行を出す。閾値で「古いときだけ出す」形にすると、**新しい
 * 報告に行が出ないのと、この機能自体が無いのとが出力上で同じ顔になる** ——
 * それは同じ #562 が直そうとしているもう一方のバグ（`tools.ts` の
 * `describeInboxBacklog` が0件で行そのものを消していたこと）とまったく同じ形
 * である。**同じ PR で片方を「常に出す」に直しながら、こちらを「閾値超えの
 * ときだけ出す」に作り込むと、直したはずの形をここで再現することになる。**
 *
 * ## `at` そのものも一緒に出す
 *
 * 丸めた値（「約2分」等）だけでは、クローンが日誌・台帳の他のタイムスタンプと
 * 突き合わせられない。ISO 文字列のままの値を必ず併記する。
 *
 * ## 壊れた `at` に嘘の値を出さない
 *
 * `event.at` が parse できない、または `now` より未来（時計のずれ・順序の乱れ）
 * のときは、`NaN` や負の経過を出さず、**取れない理由を書く**（AGENTS.md
 * 「取れない軸に0の行を作る」と同じ考え方。`lease.ts` の `undecidable` の
 * doc「読めない時刻で断言しない」も同型）。
 *
 * ## `now` を引数で受け取る
 *
 * `managerPrompt` を純関数のまま保つため、ここでも `new Date()` を直接
 * 呼ばない。呼び出し元（`#handle` の `'manager_message'` 分岐）から渡す。
 */
function describeReportAge(at: string, now: Date): string {
  const receivedMs = Date.parse(at);
  if (Number.isNaN(receivedMs)) {
    return `受け取った時刻（${at}）を解析できないため、経過は測れない。`;
  }
  const elapsedMs = now.getTime() - receivedMs;
  if (elapsedMs < 0) {
    return `受け取った時刻（${at}）が現在時刻より未来のため、経過は測れない。`;
  }
  return `受け取ってから${formatElapsed(elapsedMs)}経過（受け取った時刻: ${at}）。`;
}

/** 経過ミリ秒を秒／分／時間／日で丸める（{@link describeReportAge} 専用）。 */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return '1秒未満';
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `約${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `約${hours}時間`;
  const days = Math.floor(hours / 24);
  return `約${days}日`;
}

/**
 * `event`（質問・許可確認）が、いまも `managers.list()` の `waiting` に載って
 * いるかを確かめる。
 *
 * **配り直し（`#redelivered`）に限定しない。** 実測された再送は
 * `ManagerPool#emit`（`manager.ts`）が初回配達と同じ経路（毎回新しい
 * `event.id` を発行する）で届き、`#redelivered` の判定には乗らない。限定すると
 * この実例を取りこぼす——だから `manager_message` を受け取るたびに、ここで
 * 毎回確かめる。
 *
 * **競合の心配は無い。** `manager.ts` の `ask` 分岐は `record.waiting.push(...)`
 * → `#persist` → 日誌 → `#emit()` の順で動くので、**初回配達の時点で
 * `waiting` には既に載っている。** 「生きている確認を死んだと誤判定する」窓は
 * 無い。
 *
 * ⚠️ **ただし「答えたのに、まだ `waiting` に載っている」窓はある。** `manager.ts`
 * の `send()`（`manager_send` の実体）は `runner.answer()` が成功しても
 * `record.waiting` を同期では書き換えない。`waiting` からその requestId が
 * 消えるのは、あとから非同期で届く別種の `RunnerEvent`（`'settled'`）の
 * ハンドラだけである。**その窓の中で合図が配られると、ここは `'live'` を返し、
 * 従来どおり「まだ止まっている」の文言が出る。** 安全側（雑音）へ倒れている
 * ので方針には反しないが、「解決済みなら必ず正しい文言が出る」の保証では
 * ない——回答の受理そのものを冪等にしない限り、この窓は残る。
 *
 * **`event.managerId` に対応する要素が `list()` に無いときも `'unknown'`。**
 * 本物の配達では `#emit` の前に必ず `#persist` が通るので実際には起きないが
 * （委譲の記録が無いのに合図だけ届くことは無い）、起きたとしても「待たれて
 * いない」と決め打たず、確かめられなかった側へ倒す。
 */
async function confirmationLiveness(
  managers: ManagerPool,
  managerId: string,
  requestId: string,
): Promise<ConfirmationLiveness> {
  let summaries: ManagerSummary[];
  try {
    summaries = await managers.list();
  } catch {
    return 'unknown';
  }
  const summary = summaries.find((entry) => entry.managerId === managerId);
  if (summary === undefined) return 'unknown';
  return summary.waiting.some((item) => item.requestId === requestId) ? 'live' : 'settled';
}

/**
 * マネージャーからの一件をクローンの言葉に直す。
 *
 * ここに「何なら答えてよいか」の一覧を書かないこと。答えるか人間に回すかの線引きは
 * クローンが記憶として持っているものであり、書いた瞬間に人による違いが潰れる
 * （PRD「権限境界」/ AGENTS.md 地雷3）。
 *
 * `liveness` は `kind` が `question` / `permission` のときだけ意味を持つ
 * （`confirmationLiveness` の doc）。`report` では読まない。
 *
 * `settlement` は **すべての `kind` で読む**（#871。当初は `report` 限定
 * だった——`reportSettlement` の doc「#871 —— question / permission にも
 * 同じ判定を足す」）。
 *
 * `now` は `report` のときだけ意味を持つ（{@link describeReportAge}）。
 * **純関数として保つため、ここでは `new Date()` を呼ばない** ——呼び出し元
 * （`#handle` の `'manager_message'` 分岐）から渡す。既定値は本番の呼び出しを
 * 短く保つためのものであって、テストは明示的に `now` を渡して固定すること。
 *
 * `event.foldedTurn` が立っている回（Issue #1848）は、見出しを「（報告）」
 * ではなく「（直近のターンの中身）」にする——`tools.ts` の `isFoldedTurnReport`
 * が `manager_list` / `manager_report` の見出しを切り替えるのと同じ語・同じ
 * 軸（`manager.ts` の `case 'report'` が `event.failure` / `event.unreported`
 * から立てる。`schema.ts` の `manager_message.foldedTurn` の doc）。**判定は
 * この構造化された印だけで行い、本文の文言は見ない。**
 */
function managerPrompt(
  event: Extract<InboxEvent, { type: 'manager_message' }>,
  liveness: ConfirmationLiveness,
  settlement: ReportSettlement = { kind: 'unknown' },
  now: Date = new Date(),
): string {
  const head = `[system] マネージャー ${event.managerId} から届いた。`;

  if (event.kind === 'report') {
    const closed = closedReportNotice(settlement);
    const reportLabel = event.foldedTurn === true ? '直近のターンの中身' : '報告';
    return [
      `${head}（${reportLabel}）`,
      '',
      // **本文に束と同じ予算を掛ける（issue #955）。** 単発の報告も、新しい
      // セッションの最初のターンに載れば束と同じ形で文脈窓を越えうる——
      // 束だけ締めて単発を素通しにすると、同じ穴が1件ぶん残る。
      ...boundedReportBody({ ...event, kind: 'report' }),
      '',
      // **経過も印も、本文の後ろ・指示の前に置く**（#391 と同じ規則。
      // 本文より前に置くと「読まなくてよい」と読まれて本文を飛ばされる ——
      // 本文を残した意味が消える）。
      describeReportAge(event.at, now),
      '',
      ...(closed === null ? [] : [closed, '']),
      '続きが要るなら `manager_send` で指示を出し、要らないなら何もしなくてよい。',
      '学びや判断の基準になったことがあれば記憶へ移すこと。',
    ].join('\n');
  }

  const label = event.kind === 'question' ? '質問' : '実行の許可確認';

  // **もう待たれていない確認は、答え直せと言わない。** 台帳が既に解決済みだと
  // 知っているものを「まだ止まっている」と偽ると、クローンが同じ requestId へ
  // 二重に答え、`manager_send` が「その確認は待っていない」と弾く（実測の
  // バグそのもの）。`liveness === 'unknown'` はここへは来ない——確かめられな
  // かった側は下の「生きている」と同じ文言（安全側＝雑音）へ倒す。
  //
  // **#871: 台帳（`settlement`）が既に閉じているときも、同じく答え直せと
  // 言わない。** これまでこの分岐は `liveness`（`manager_send` で答えたか）
  // しか見ておらず、クローンが `commitment_close` でこの行を閉じても
  // 何も変わらなかった——`report` 側にだけ付いていた印（#391）の鏡像の穴
  // （#394 の issue が名指ししたもの）。`liveness` と `settlement` は
  // 別々の材料から来る別々の判定なので、**どちらか一方が「もう要らない」と
  // 言えば足りる**（両方が真である必要は無い）。
  const closedConfirmation = closedConfirmationNotice(settlement, label);
  if (liveness === 'settled' || closedConfirmation !== null) {
    return [
      `${head}（${label}）`,
      '',
      event.text,
      '',
      ...(liveness === 'settled'
        ? [
            'この確認はもう待たれていない（既に解決したか、マネージャーが終わっている）。答え直す必要は無い。',
          ]
        : []),
      ...(closedConfirmation === null ? [] : [closedConfirmation]),
    ].join('\n');
  }

  // 宛先には requestId まで書く。同じマネージャーが同時に複数を待つことがあり
  // （1応答で並列に呼ばれた道具）、宛先を欠いた回答は宛先を推測できない。
  const to =
    event.requestId === undefined
      ? `managerId: "${event.managerId}"`
      : `managerId: "${event.managerId}", requestId: "${event.requestId}"`;

  return [
    `${head}（${label}）`,
    '',
    event.text,
    '',
    `返事をするまで ${event.managerId} のこの1件だけが止まっている（他のマネージャーも、同じマネージャーの別の確認も、それぞれ独立に待っている）。`,
    `記憶に根拠があるなら自分で決めて \`manager_send\`（${to}）で返し、その判断を \`journal_write\` に残せ。`,
    event.kind === 'permission' ? '許可確認なので `decision` に allow / deny を明示すること。' : '',
    `根拠が無いなら \`ask_human\` に ${to} を添えて積み、人間の回答が届いてから同じ宛先へ \`manager_send\` で返せ。` +
      '（宛先を添えないと、人間が答えてもこの仕事を再開できない）',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * `managerReportBatchPrompt` が文字数の予算により報告本文を省いたときに使う、
 * 全文の取り方（issue #955）。
 *
 * **`retrievalHintFor` と機構は同じだが、文言は独立させてある。** あちらの
 * `manager_message` 分岐の文面は「配り直し」の文脈（`closedRedeliveryNotice`）
 * 専用で、末尾に「この配り直しでも直前に書いている」と付ける。**ここへ来る
 * 事象は構造上すべて初回配達である**（`#runManagerReportBatch` の doc
 * 「この経路に来る事象は構造上すべて初回配達である」）ので、その文言を
 * そのまま流用すると起きていないことを起きたと書くことになる——だから
 * `retrievalHintFor` を直接は呼ばず、同じ材料（`journal_read` の `types` /
 * `since`）で文言だけ書き直した専用の関数を用意した。
 *
 * **根拠となる書き込みは同じ**（`#journalIncomingBody`）。`#runManagerReportBatch`
 * は、この関数の呼び出し元（`managerReportBatchPrompt`）を呼ぶより前に、束の
 * 全イベントぶん個別に `#journalIncomingBody` を呼び終えている（同関数の doc
 * 「件数ぶん個別に書く」）——だから探せば必ず見つかる。
 *
 * **`externalBatchPrompt` には対応する関数を用意していない。** あちらの本文
 * （`renderPayload`）には既に `EXTERNAL_PAYLOAD_LIMIT` の上限が掛かっており、
 * 今回の変更が対象にした「1件あたり無制限」の穴が無かった
 * （`externalBatchPrompt` の doc に詳細）。
 */
function managerReportRetrievalHint(event: ManagerReportMessage): string {
  return (
    `全文の取り方: \`journal_read\` に \`types: ["exchange"]\` と ` +
    `\`since: "${event.at}"\` を渡して絞り込む（マネージャー ${event.managerId} からの` +
    `${event.kind} が処理されるたびに、"${EXCHANGE_KIND_REPLY_PREFIX}[${event.managerId}/${event.kind}] " で始まる` +
    '全文を、この束を渡す前に日誌へ個別に書いてある）。'
  );
}

/**
 * `managerReportBatchPrompt` が束ねる報告の本文（合計）に掛ける文字数の予算
 * （issue #955）。
 *
 * **無かった理由。** この束は `MERGED_BATCH_SIZE_LIMIT`（件数＝50）でしか
 * 締めておらず、1件あたりの文字数には上限が無かった。1件が巨大な報告
 * （例: 1MB）を50件束ねれば、束のターン入力だけで数十MBになりうる——
 * `.claude/skills/listing-and-detail/SKILL.md` が言う「件数の上限だけでは
 * 足りない」の実例そのものである。
 *
 * **予算は件数ではなく文字数で持つ。** 積む形は既存のヘルパー
 * （`excerpt.ts` の `renderListingFromEnd`）を使い、手で書かない——
 * `memory.ts` の `MEMORY_TOC_CHAR_BUDGET`（#741）と同じ直し方である。
 * **末尾（＝最新の報告）を優先して残す**（`renderListingFromEnd` の doc
 * 「並びが時系列で、続きを読む動機が『直近』にある一覧のため」）——
 * `managerReportBatchPrompt` 自身が「後の報告が前の報告を補足・訂正して
 * いることがある」と言っている、その「後の報告」を最初に落とすと本末
 * 転倒になる。
 *
 * **値の出し方。** `PROMPT_CHARACTER_BUDGET`（`prompt.ts`。47,500）と同じ
 * 桁——あちらも「1ターンぶんの連結後プロンプト全体」を締める役割で、この
 * 束もマネージャー起点のターンでは同じ役割を果たす。**値が同じでも定数は
 * 使い回さない**（AGENTS.md 地雷表「予算の定数は用途ごとに別に置く」）——
 * 片方だけ直したくなったときに一緒に動く形を避けるため、独立した定数として
 * 持つ。
 */
const MANAGER_REPORT_BATCH_BODY_BUDGET = 47_500;

/**
 * 単発の報告（`managerPrompt` の 'report' 分岐）の本文を予算で締める
 * （issue #955）。予算は束と同じ {@link MANAGER_REPORT_BATCH_BODY_BUDGET}
 * ——1ターンに載る報告本文の上限という同じ役割だからである。
 *
 * **予算に収まる回は本文を1文字も変えない**（配列の1要素として素通しする）。
 * 切った回は `excerpt` の「N 文字省略。全 M 文字」の印に加えて、全文の取り方
 * （{@link managerReportRetrievalHint}）を次の行に出す——**切ったのに取り方を
 * 言わないと、読めるものを減らしたことになる**（listing-and-detail の性質2）。
 */
function boundedReportBody(event: ManagerReportMessage): string[] {
  if (event.text.length <= MANAGER_REPORT_BATCH_BODY_BUDGET) return [event.text];
  return [
    excerpt(event.text, MANAGER_REPORT_BATCH_BODY_BUDGET),
    '',
    `⚠ 本文が文字数の予算（${MANAGER_REPORT_BATCH_BODY_BUDGET.toLocaleString('en-US')} 文字）を超えたので、ここでは先頭だけを出した。 ${managerReportRetrievalHint(event)}`,
  ];
}

/**
 * 同じマネージャーから連続して届いた report をターン1本の本文にする
 * （`#mergedManagerReportBatch`）。
 *
 * **`humanTurnText` の姉妹版。** 全文を届いた順に並べ、要約も間引きもしない
 * （`#mergedManagerReportBatch` の doc「これも畳み込みではない」）。
 *
 * **台帳の判定（#391）は1件ごとに出す。** まとめても「どれが片付け済みか」は
 * 件によって違いうるので、`events` と `settlements` を同じ添字で対応させ、
 * 1件ずつ `closedReportNotice` を通す — 1つの判定へ潰さない。
 *
 * **1件ごとに「受け取ってからの経過」を出す**（`describeReportAge`。#562 PR-1 が
 * `managerPrompt` の `report` 分岐へ入れたのと同じもの）。**束ねられる報告は、
 * 定義上いちばん長く待った報告である** —— 単発の経路にだけ経過が載って、こちらに
 * 載らないと、**待った証拠がいちばん要る場所でだけ消える。** `now` を引数で受け
 * 取るのも PR-1 と同じ理由（純関数のまま保ち、歯が時刻で揺れないようにする）。
 *
 * **呼び出し元は常に2件以上で呼ぶ**（`#mergedManagerReportBatch` が1件のとき
 * `null` を返し、`#pump` はそちらを `#handle` の単発経路（`managerPrompt`）へ
 * 落とすため）。0件・1件の来客には空文字列／`managerPrompt` 相当の形を返す
 * ようにはしていない —— 呼び出し元の契約を守っている限り届かない分岐に、
 * 届いたときの見た目を用意しても検証できない。
 *
 * **⚠️ 「N 件」は束の件数であって「届いた総数」ではない（issue #783 の続き）。**
 * `humanTurnText` の同じ注記と理由は同一 —— `#drainMergeableWithinLimit` が
 * 上限で束を切ると `events.length` は実際に届いた総数より小さくなるので、
 * 文面は「N件が届いた」ではなく「N件をまとめて渡す」にしてある（切った事実
 * そのものは `#notices` の `mergedBatchTruncation` が別に言う）。
 *
 * **⚠️ issue #955: 本文の合計に文字数の予算を掛けた
 * （{@link MANAGER_REPORT_BATCH_BODY_BUDGET}）。** 予算に収まる回は1文字も
 * 変わらない——`renderListingFromEnd` は省略が起きないとき、渡した配列を
 * そのまま `join('\n')` するだけである。省略が起きた回は、古い側（先頭）の
 * ブロックから丸ごと落ち、**その旨と全文の取り方**
 * （{@link managerReportRetrievalHint}）を先頭へ1行足す。
 */
function managerReportBatchPrompt(
  events: ManagerReportMessage[],
  settlements: ReportSettlement[],
  now: Date,
): string {
  const head = events[0];
  if (head === undefined) return '';

  const items = events.map((event, index) => {
    // **印は本文の後ろ、指示の前に置く**（`managerPrompt` の 'report' 分岐と
    // 同じ理由 —— 本文より前に置くと「読まなくてよい」と読まれて本文を飛ばされる）。
    const closed = closedReportNotice(settlements[index] ?? { kind: 'unknown' });
    return [
      `**(${index + 1})** ${describeReportAge(event.at, now)}`,
      '',
      event.text,
      ...(closed === null ? [] : ['', closed]),
    ].join('\n');
  });

  return [
    `[system] マネージャー ${head.managerId} から届いた報告を、処理待ちのあいだに続けて **${events.length} 件** まとめて渡す（要約していない）。`,
    '**まとめて読んでから答えよ。** 後の報告が前の報告を補足・訂正していることがある。**最後まで読んでから判断すること。**',
    '',
    '---',
    '',
    // **最新の1件だけで予算を超える回も、この1行は必ず出る。** その1件を
    // `excerpt` で予算まで切った時点で予算が埋まるので、束の残り（2件以上の
    // 束なので必ず在る）は落ちる ⟹ `rest > 0` になり、全文の取り方を名乗る。
    renderListingFromEnd(items, {
      budget: MANAGER_REPORT_BATCH_BODY_BUDGET,
      omitted: ({ rest, shown, total }) =>
        `⚠ 本文の合計が文字数の予算（${MANAGER_REPORT_BATCH_BODY_BUDGET.toLocaleString('en-US')} 文字）に` +
        `当たったので、古い ${rest} 件（${total} 件中、新しい ${shown} 件だけを本文つきで出した）は本文を省いた。` +
        ` ${managerReportRetrievalHint(head)}`,
    }),
    '',
    '続きが要るなら、それぞれの報告に対して `manager_send` で指示を出せ。要らないなら何もしなくてよい。',
    '学びや判断の基準になったことがあれば記憶へ移すこと。',
  ].join('\n');
}

/**
 * 中身の同じ `external` が連続して届いたとき、ターン1本の本文にする
 * （`#mergedExternalBatch`。issue #841）。
 *
 * **`managerReportBatchPrompt` の姉妹版だが、束ね方が違う。** あちらは
 * `managerId` だけを揃えて中身の違う報告を並べて渡す（全文を件数ぶん出す）。
 * こちらは `#mergedExternalBatch` が {@link inboxBacklogDedupeKey} で
 * `source` と `payload` の一致まで確かめてから束ねるので、束の中で `id` と
 * `at`（1回の発行ごとに必ず変わる2つ。`inboxBacklogDedupeKey` の doc）を
 * 除いた中身は全件同一である。
 *
 * **⟹ 本文（`renderPayload`）は1回だけ出す。** 2回目以降を出しても、同じ
 * 文字列が繰り返されるだけで1文字も情報が増えない——根拠は上の一致保証
 * そのもの（`source` も `JSON.stringify(payload)` も全件で文字どおり一致
 * している）。
 *
 * **それでも1文字も捨てない。** 束の中で件ごとに違いうるのは `id` と `at`
 * の2つだけなので、**全件の `at` を本文へ出す**（`MERGED_BATCH_SIZE_LIMIT`
 * ＝50 が上限なので分量は有界）。`id` は出さない —— クローンにとって
 * 意味を持つのは「いつ・何件」であって、内部の識別子ではない。`at` の並びが
 * あれば「何件届いたか」も「いつからいつまでか」も本文から読める。
 *
 * **束は同じ出来事の反復とは限らないと明記する。** 中身（`source` /
 * `payload`）が同じでも、外の世界で別々に発行された合図である可能性がある
 * （issue #841 が名指しした危険——「重要な1件が同じ出所の重複の中に埋もれる」）。
 * **「重複だから無視してよい」とは書かない。**
 *
 * **何が届いたら何をするかの対応表は書かない**（`buildExternalEventPrompt`
 * と同じ理由。`prompt.ts` の `ExternalEventPromptInput` の doc）。
 *
 * **呼び出し元は常に2件以上で呼ぶ**（`#mergedExternalBatch` が1件のとき
 * `null` を返し、`#pump` はそちらを `#handle` の単発経路
 * （`buildExternalEventPrompt`）へ落とすため）。0件・1件の来客に別の見た目を
 * 用意しないのは `managerReportBatchPrompt` の doc と同じ理由——届かない
 * 分岐に見た目を用意しても検証できない。
 *
 * **純関数のまま保つ。** 時刻を出力に使わないので `now` を引数に取る必要も
 * 無い（`managerReportBatchPrompt` と違い、束の中の経過時間を報告しない——
 * 全件の `at` をそのまま出すので、経過はクローン自身が計算できる）。
 *
 * **⚠️ 「N 件」は束の件数であって「届いた総数」ではない（issue #783 の続き）。**
 * `humanTurnText` / `managerReportBatchPrompt` の同じ注記と理由は同一——
 * `#drainMergeableWithinLimit` は上限で束を切ることがあり、切ったときは
 * `events.length` が実際に届いた総数より小さくなる。**だから文面は
 * 「N件が届いた」ではなく「N件をまとめて渡す」の形にしてある**——前者は
 * 上限に当たった回に偽になるが、後者はこの束の件数を言っているだけなので、
 * 上限に当たったかどうかに関わらず常に真である。**切ったという事実そのものは
 * `#notices` の `mergedBatchTruncation`（別の断り書き）が言う——ここで重ねて
 * 言わない。**
 *
 * **⚠️ issue #955 で調べたが、ここには変更を入れていない。** 本文
 * （`renderPayload`）には**既に** `EXTERNAL_PAYLOAD_LIMIT`（8,000文字）の
 * 上限が掛かっている——`renderPayload` が `body.length > EXTERNAL_PAYLOAD_LIMIT`
 * を見て `slice` する。issue の見立て「1件あたりの文字数の上限が無い」は、
 * この関数については誤りだった（依頼者の見立ても検証すること。AGENTS.md）。
 * 50件束ねても本文は1回しか出さない（このコメント群の上）ので、束全体の
 * 上限も実質 8,000文字強のままである——`managerReportBatchPrompt`（1件あたり
 * 無制限だった報告を件数ぶん連結する）とは構造が違う。
 *
 * **切ったときの名乗り方は issue #1535 で直した。** 以前の `renderPayload` は
 * `…（以下省略）` だけで省いた量も全文の取り方も言わず、しかも日誌の控えも同じ
 * 関数を通していたので、切る前の全文がどこにも残らなかった。いまは日誌へ切らずに
 * 書き（`journalPayload`）、プロンプトの側は省いた量と `journal_read` での取り方を
 * 名乗る（`renderPayload` の doc）。
 */
function externalBatchPrompt(
  events: ExternalEvent[],
  attachmentNoticeLines: readonly string[] = [],
): string {
  const head = events[0];
  if (head === undefined) return '';

  const body = renderPayload(head.payload, head.at);
  const timestamps = events.map((event) => event.at).join(' / ');

  const viaNames = events.flatMap((event) => (event.via === undefined ? [] : [event.via.name]));
  const via = externalViaLine(viaNames, viaNames.length < events.length);

  return [
    `[system] 外部から出来事が届いた（source: ${head.source}）。人間はこれを見ていない。`,
    ...(via === null ? [] : [via]),
    EXTERNAL_EVENT_FRAMING,
    ...externalAttachmentSection(attachmentNoticeLines),
    `処理待ちのあいだに、同じ中身の合図を続けて **${events.length} 件** まとめて渡す` +
      '（本文は1回だけ。全件で `source` と中身が一致している）。',
    `届いた時刻（届いた順）: ${timestamps}`,
    '',
    '**同じ中身が複数回届いたからといって、同じ出来事の繰り返しとは限らない**' +
      '——外の世界で別々に発行された合図である可能性がある。',
    '',
    '中身を読み、記憶にある目的と価値観に照らして、何をするか決めよ。動く必要が無ければ何もしなくてよい。',
    '判断の根拠が記憶に無く、しかも放っておけないことなら `ask_human` に積む。聞かずに動いたなら `journal_write` に残せ。',
    '',
    '---',
    '',
    body,
  ].join('\n');
}

/**
 * `commitment.closedBy` を実行時に区別する4状態。
 *
 * **`commitmentSchema.closedBy` は `z.string().optional()` で緩く持つ**
 * （`schema.ts` の doc）。既知の値は `commitmentClosedBySchema`
 * （`'clone' | 'human'`）の2つだが、**保存層はそれ以外の値も台帳の一覧を
 * 壊さないために通す**ので、読み出す側は4状態を区別しなければならない
 * ——表示側（`apps/web/app/routes/commitments.tsx` の `ClosedReasonBody`）が
 * 既に同じ4分岐を持っており、語彙をそちらに合わせてある。
 *
 * **`'unknown'`（誰かが値を書いたが既知の2値ではない）と `'absent'`
 * （そもそも欄が無い）を同じ扱いにしないこと。** 前者は書き込み側の想定外、
 * 後者は「この欄が入る前に閉じられた行」——原因も対処も別である。
 */
type ClosedByState =
  { kind: 'clone' } | { kind: 'human' } | { kind: 'unknown'; raw: string } | { kind: 'absent' };

/** {@link ClosedByState} の doc を見よ。 */
function closedByState(closedBy: string | undefined): ClosedByState {
  if (closedBy === undefined) return { kind: 'absent' };
  const parsed = commitmentClosedBySchema.safeParse(closedBy);
  if (!parsed.success) return { kind: 'unknown', raw: closedBy };
  return { kind: parsed.data };
}

/**
 * 未知の `closedBy` の生値を断り書きへ載せるときの上限。
 *
 * **本番の書き込み経路は `'clone'`（`tools.ts` の `commitment_close`）と
 * `'human'`（`app.ts` の `POST /commitments/:id/close`）のリテラル2つだけで、
 * 自由記述が入る余地は無い。** それでも切り詰めるのは、台帳の行を（マイグレー
 * ション・手動修正等で）直接書かれれば `closedBy` は任意長になりうるためで
 * ある——`dropped-record.ts` の `TAG_LIMIT` と同じ根拠（列挙値・id を1行に
 * 収める）で、値は 64 に揃えた。
 */
const CLOSED_BY_EXCERPT = 64;

/** {@link closedRedeliveryNotice} の (1) 冒頭の断定行。状態ごとに全く別の文である。 */
function closedRedeliveryHeadline(state: ClosedByState): string {
  switch (state.kind) {
    case 'clone':
      return '**これは再起動後の配り直しである。クローンは既にこの合図を片付けている。**';
    case 'human':
      return '**これは再起動後の配り直しである。人間が既にこの合図を片付けている。**';
    case 'unknown':
      return (
        '**これは再起動後の配り直しである。この合図は既に片付いている' +
        `（閉じた主体として台帳に未知の値が入っている: 「${excerptLine(state.raw, CLOSED_BY_EXCERPT)}」）。**`
      );
    case 'absent':
      return (
        '**これは再起動後の配り直しである。この合図は既に片付いている' +
        '（誰が閉じたかは台帳に無い ＝ この欄が入る前に閉じられた行である）。**'
      );
  }
}

/** {@link closedRedeliveryNotice} の (2) 片付けた時刻のラベル。 */
function closedAtLabel(state: ClosedByState): string {
  switch (state.kind) {
    case 'clone':
      return '片付けた時刻（commitment_close）';
    case 'human':
      return '片付けた時刻（POST /commitments/:id/close）';
    case 'unknown':
    case 'absent':
      return '片付けた時刻';
  }
}

/** {@link closedRedeliveryNotice} の末尾の一文。**`clone` を他へ流用しないこと**（下の doc）。 */
function closedRedeliveryClosing(state: ClosedByState): string {
  switch (state.kind) {
    case 'clone':
      // 閉じた判断を下したのはクローン自身なので、「思い出せなければ確かめよ」
      // が的確に効く。**他の3状態にはこの文を流用しない** —— クローンが下して
      // いない判断に「閉じた判断を思い出せず」は的外れである。
      return (
        '片付け済みなので、あらためて手を動かす必要は無い。閉じた判断を思い出せず、' +
        '正しかったか確かめたいときだけ、上の手順で全文を読み直すこと。'
      );
    case 'human':
      return (
        '片付け済みなので、あらためて手を動かす必要は無い。**この判断はあなたが下したものではない**' +
        '（人間が閉じた）ので、心当たりが無くても異常ではない。何が起きたか確かめたいときだけ、' +
        '上の手順で全文を読み直すこと。'
      );
    case 'unknown':
      return (
        '片付け済みなので、あらためて手を動かす必要は無い。**この判断をあなたが下したとは限らない**' +
        '（閉じた主体が台帳の既知の値ではない）ので、心当たりが無くても異常ではない。何が起きたか' +
        '確かめたいときだけ、上の手順で全文を読み直すこと。'
      );
    case 'absent':
      return (
        '片付け済みなので、あらためて手を動かす必要は無い。**この判断をあなたが下したとは限らない**' +
        '（誰が閉じたかは台帳に残っていない）ので、心当たりが無くても異常ではない。何が起きたか' +
        '確かめたいときだけ、上の手順で全文を読み直すこと。'
      );
  }
}

/**
 * 片付け済みの合図が配り直されたときの断り書き。
 *
 * **宛先は日誌である（モデルではない）。** issue #217 ではこれを本文の代わりに
 * モデルへ渡していたが、それは「あらためて手を動かす必要は無い」を伝えるために
 * ターン1本を焼くことだった（`#pump` の畳み込みの doc に、クローンが数えた値が
 * ある）。いまは `#foldClosedRedelivery` が畳んだ跡としてこの全文を日誌へ写す。
 * **中身の条件は1つも減らしていない** —— 減らせば「何を根拠に畳んだのか」が
 * 後から取れなくなる。
 *
 * **依頼者の条件（1つでも欠けたら能力の欠落）を全部入れる**:
 * (1) 再起動後の配り直しであること (2) どの合図か（`inboxEventShape` を流用
 * — 既にこの用途で使われている本文を含まない見分け） (3) いつ受け取ったか
 * (4) **台帳が既に閉じていること・閉じた時刻・`closedReason`（在れば）** ——
 * **閉じた主体（`commitment.closedBy`）は問わずに「片付いている」と言える**
 * （{@link closedByState} の4状態）が、**誰が閉じたかは断り書きの文面に
 * 反映する** —— クローンでもないのに「クローンが閉じた」と書けば、日誌を
 * 後から追う人間に嘘を伝えることになる（見出し・時刻ラベル・末尾の一文の
 * 3箇所が状態ごとに変わるのはそのため）。
 * (5) 全文の取り方 — 具体的な id か検索の手掛かり（`retrievalHintFor`）。
 *
 * **「全文は省略した」とだけ書かない。** 取り方が無い断り書きは、依頼者が
 * 明示的に禁止した形である。
 */
export function closedRedeliveryNotice(event: InboxEvent, commitment: Commitment): string {
  const state = closedByState(commitment.closedBy);
  const closedReason =
    commitment.closedReason === undefined || commitment.closedReason === ''
      ? ''
      : `\n閉じた理由: ${commitment.closedReason}`;

  return [
    closedRedeliveryHeadline(state),
    `合図: ${inboxEventShape(event)}`,
    `受け取った時刻: ${event.at}`,
    `${closedAtLabel(state)}: ${commitment.closedAt}${closedReason}`,
    '',
    '**この配り直しではターンを起こしていない。** 片付け済みだと分かっているものを、' +
      '再起動のたびに読み直してターンを1本焼く費用を払わないためである。',
    retrievalHintFor(event),
    '',
    closedRedeliveryClosing(state),
  ].join('\n');
}

/**
 * 全文の取り方（`closedRedeliveryNotice` の (5)）。**型ごとに違う。**
 *
 * `human_message` / `manager_message` / `external` は、この合図が処理される
 * たびに全文が日誌へ書かれる（`human_message` は `Clone#record`、他の2つは
 * `#journalIncomingBody`。どちらも配り直しのこの回でも変わらず書く —— **ターンを
 * 起こさずに畳む回でも書く。** `#restoreUnread` / `#foldClosedRedelivery` /
 * `#foldGatedRedelivery` の当該コメントを見よ）ので `journal_read` で取れる。
 *
 * **`human_answer` だけは違う。** 案内するのは `journal_read` ではなく
 * `approvals_list id=<approvalId>` である — `tools.ts` の `approvals_list` の
 * doc「答えが付いた件も読める」がその根拠。
 *
 * **#243 で `human_answer` 分岐も `#journal` を呼ぶようになった**（配った断り書きを
 * `turnInputEntry` で残す）が、片付け済みの配り直しはターンを起こさなくなったので
 * （`#foldClosedRedelivery`）その追記はもう無い —— 断り書きの全文は畳んだ跡の1行に
 * 写っているだけで、**回答そのもの**は日誌に無い。**案内は初めからこのままである** —
 * 承認待ちの器は回答そのものを保つ器であって、日誌の追記は失敗を握り潰す
 * （`#journal` の doc）。**必ず在る側を案内する**方が、「取り方が分かる体裁のまま
 * 実際には取れない」を作らない。
 */
function retrievalHintFor(event: InboxEvent): string {
  switch (event.type) {
    case 'human_answer':
      return (
        `全文の取り方: \`approvals_list\` に \`id: "${event.approvalId}"\` を渡す` +
        '（質問と回答の全文が返る。答えが付いた件も読める）。'
      );
    case 'external':
      return (
        `全文の取り方: \`journal_read\` に \`types: ["external_event"]\` と ` +
        `\`since: "${event.at}"\` を渡して絞り込む（source: ${event.source} の合図が処理される` +
        'たびに、この型で全文が日誌へ書かれる。この配り直しでも直前に書いている）。'
      );
    case 'human_message':
      return (
        `全文の取り方: \`journal_read\` に \`types: ["exchange"]\` と ` +
        `\`since: "${event.at}"\` を渡して絞り込む（会話 id: ${event.conversationId}。この合図が` +
        '配られるたびに、受理の瞬間の追記として全文が日誌へ書かれる。この配り直しでも既に書いて' +
        'ある）。'
      );
    case 'manager_message':
      return (
        `全文の取り方: \`journal_read\` に \`types: ["exchange"]\` と ` +
        `\`since: "${event.at}"\` を渡して絞り込む（マネージャー ${event.managerId} からの` +
        `${event.kind} が処理されるたびに、"${EXCHANGE_KIND_REPLY_PREFIX}[${event.managerId}/${event.kind}] " で始まる全文が` +
        '日誌へ書かれる。この配り直しでも直前に書いている）。'
      );
    // 台帳に載らない型（`commitmentFor` が型だけで常に `null` を返す組）。
    // `closedRedeliveryNotice` はここへは来ない — `#redeliveredClosed` に載る id は
    // 必ず `commitmentFor` が非 null を返した合図の id である（`#restoreUnread` の
    // doc）。
    //
    // **`external` はここに含めない。** `commitmentFor` は `source` によっては
    // `external` でも `null` を返す（`isDaemonSelfNotice`）が、それは台帳を
    // 開かないというだけで、受信箱が持つ全文がその回だけ消えるわけではない——
    // `external` は必ず上の `case 'external':` で全文の取り方を案内する。
    // 「台帳に載るかどうか」と「全文の取り方があるかどうか」は別の軸である。
    case 'timer':
    case 'self_initiative':
    case 'distill':
      return '';
  }
}

/**
 * 合図から、台帳へ開く未了を作る。開かないものは `null`。
 *
 * **判定の基準は「誰かが渡してきたか」である。** 人間の発言・人間の回答・マネージャー
 * からの一件・外部イベントは、届いた時点で「始末をつける相手」が居る。時間起点の発火と
 * 発意 tick は起こされたこと自体であって渡されたものではないので開かない
 * （`Clone#commit` の doc に理由の全文——そこには `external` が `source` によって
 * 同じ結論に達することがある理由も並べて置いてある）。
 *
 * **⚠️ `external` だけは、型だけでは決まらない。** デーモン自身が自分の受信箱へ
 * 出す合図（`isDaemonSelfNotice` が真になる2つの `source`）は、型としては
 * `external` でも「誰かが渡してきた」に当たらない——機械が自分に話しかけている
 * だけで、引き受けるべき相手がそもそも居ない。**基準そのものは変わっていない**:
 * 「誰かが渡してきたか」という同じ問いを当てはめると、この2つは最初から不合格
 * になる。変わったのは、`external` という型だけではその問いに答えられず
 * `source` まで見る必要がある、という点だけである——他の3つの非 null の型
 * （`human_message` / `human_answer` / `manager_message`）は型が決まった時点で
 * 答えが決まる。
 *
 * **本文は全文を入れる。** 台帳の `body` を要約にすると、頼まれた内容そのものが
 * 二度と取れなくなる（切るのは表示側の仕事である）。
 */
export function commitmentFor(event: InboxEvent): Commitment | null {
  const base = { id: event.id, at: event.at };
  switch (event.type) {
    case 'human_message':
      return { ...base, origin: 'human', source: event.conversationId, body: event.text };
    // 人間が承認待ちへ答えた一件。**これも未了である** — 答えを受け取っただけでは
    // 何も進んでおらず、止まっているマネージャーへ `manager_send` で返して初めて
    // 仕事が再開する。宛先を添え損ねて再開しなかった前例があり（AGENTS.md「委譲」）、
    // そのとき人間の側からは「答えたのだから進んでいる」ようにしか見えない。
    case 'human_answer':
      return {
        ...base,
        origin: 'human',
        source: event.approvalId,
        body: `承認待ち ${event.approvalId} への回答: ${event.answer}`,
      };
    case 'manager_message':
      return {
        ...base,
        origin: 'manager',
        source: event.managerId,
        body: `[${event.kind}] ${event.text}`,
        // **`bodyMarkup` が指すのは `event.text`（接頭辞を除いた本体）である。**
        // `body` は `[${event.kind}] ` を前置した形なので、この印をそのまま
        // 持ち越すと、指す対象は接頭辞を含まない本体のまま揃う（表示側
        // `apps/web/app/routes/commitments.tsx` は接頭辞を剥がしてから
        // `bodyMarkup` を当てる、という前提が両側で一致している）。
        //
        // **印が無いイベント（`event.markup === undefined`）では、
        // `bodyMarkup` も立てず `undefined` のままにする。** 既定へ倒さない
        // （`textMarkupSchema` の doc、`packages/core/src/schema.ts`）。
        ...(event.markup === undefined ? {} : { bodyMarkup: event.markup }),
      };
    case 'external':
      // **デーモン自身が自分へ出した合図には、始末をつける相手が居ない。**
      // `isDaemonSelfNotice` の doc に理由と、外から予約語を名乗らせない入口の断りの全文がある。
      if (isDaemonSelfNotice(event)) return null;
      return {
        ...base,
        origin: 'external',
        source: event.source,
        body: renderPayload(event.payload, event.at),
      };
    case 'timer':
    case 'self_initiative':
    case 'distill':
      return null;
  }
}

/**
 * `entry` と同じマネージャー（`origin: 'manager'` かつ同じ `source`）× 同じ
 * `body` の未了行が、`entries` の中に既にあるか（Issue #954 提案3。`#commit`
 * が開く前に呼ぶ）。
 *
 * **対象はマネージャー起因の行だけに絞る。** 実測（Issue #954）が示した無限
 * 連投の形——同一マネージャーの合成通知（`turn_failed` 等）が同文のまま連投
 * される——は `origin: 'manager'` の行にしか出ない。人間の発言・人間の回答・
 * 外部イベントまで同じ基準で畳むと、たまたま同じ文言になった別々の発言
 * （例: 2人の人間が同じ一言を別の会話で送る）まで1件に潰しかねない——
 * その保証を弱める理由がここには無い。
 *
 * **`source` が無い行（`undefined`）どうしは重複と数えない。** `manager_message`
 * の `commitmentFor` は必ず `source: event.managerId` を持つので、`source`
 * が `undefined` になるのは他の origin だけだが、`entry.origin !== 'manager'`
 * を先に弾いているのでここへは来ない——念のための防御である。
 *
 * **`entries` は未了だけを渡すこと。** `CommitmentStore.list()`（`includeClosed`
 * を省いた既定の呼び方）が返す形を想定しているが、念のため `closedAt ===
 * undefined` もここで自分で確かめる——`list()` の契約に頼り切らない。
 *
 * **閉じたあとの同文は畳まない。** 一度閉じれば「未了」ではなくなるので、
 * 同じマネージャーが同じ文言をもう一度報告してきても、それは新しい未了として
 * 台帳に載る——「二度と報告できなくなる」側には倒れない。
 */
export function hasOpenManagerDuplicate(
  entries: readonly Commitment[],
  entry: Commitment,
): boolean {
  return findOpenManagerDuplicate(entries, entry) !== undefined;
}

/**
 * 中身を持たない「見に行け」の合図か。
 *
 * 時間起点の発火と発意 tick だけがこれに当たる。どちらも materialize されるのは
 * 処理の瞬間（そこで最新の状況をまとめ直す）なので、読まれる前の重複には情報が無い。
 */
function isTick(event: InboxEvent): boolean {
  return event.type === 'self_initiative' || event.type === 'timer';
}

function isSameTick(a: InboxEvent, b: InboxEvent): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'self_initiative') return true;
  if (a.type === 'timer' && b.type === 'timer') {
    // 対象日が違えば別の仕事（別の日の日報は畳めない）。手で起こした分と定期の
    // 発火も別物である（前者は予定をずらさない＝記録先が違う）ので畳まない。
    return a.kind === b.kind && a.target === b.target && a.cause === b.cause;
  }
  return false;
}

/** 外部から届いた中身を、切る前の1本の文字列にする。 */
function payloadText(payload: unknown): string {
  // 中身なしの通知（source だけ）もある。`undefined` という文字列を読ませない。
  if (payload === undefined || payload === null || payload === '') {
    return '（中身のない通知。source だけが届いた。）';
  }
  return typeof payload === 'string' ? payload : safeJson(payload);
}

/**
 * 外部から届いた中身を、そのままクローンに読ませられる形にする。
 *
 * **切ったら、省いた量と全文の取り方を名乗る**（issue #1535）。以前は
 * `…（以下省略）` だけで、何文字省いたのかも、全文がどこに在るのかも
 * 言わなかった（`.claude/skills/listing-and-detail/SKILL.md` の性質2）。
 * 取り方の先は、同じ合図を受けた回に `#journalIncomingBody` が日誌へ
 * 切らずに書いた `external_event` の行である（`at` はその合図が届いた時刻）。
 */
function renderPayload(payload: unknown, at: string): string {
  const body = payloadText(payload);
  if (body.length <= EXTERNAL_PAYLOAD_LIMIT) return body;
  const journalNote =
    body.length > EXTERNAL_JOURNAL_LIMIT
      ? `（日誌にも先頭 ${EXTERNAL_JOURNAL_LIMIT.toLocaleString('en-US')} 文字までしか残っていない）`
      : '（日誌には切らずに書いてある）';
  return [
    excerpt(body, EXTERNAL_PAYLOAD_LIMIT),
    `全文の取り方: \`journal_read\` に \`types: ["external_event"]\` と \`since: "${at}"\` を渡して行を見つけ、` +
      `その id を渡して読む${journalNote}。`,
  ].join('\n');
}

/** 日誌へ書く中身（issue #1535。{@link EXTERNAL_JOURNAL_LIMIT} の doc）。 */
function journalPayload(payload: unknown): string {
  return excerpt(payloadText(payload), EXTERNAL_JOURNAL_LIMIT);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 応答の text ブロックを1本に繋いだもの。
 *
 * **失敗の印が付いたメッセージの本文を取り出すためにある**（`sdk-failure.ts` の
 * `assistantFailureOf` へ渡す材料）。応答の積み上げ側（`#apply` の
 * `assistant_message`）がブロックごとに `emit` するのと役割が違うので、そちらは
 * 書き換えていない。
 *
 * **`runner.ts` の同名の写しとは繋ぎ方が違う**（あちらは改行で繋いで trim する）。
 * 揃えていないのは、繋ぎ方が報告と表示の作法＝層の側の判断だからである。
 */
function assistantTextOf(blocks: readonly AgentContentBlock[]): string {
  let text = '';
  for (const block of blocks) {
    if (block.type === 'text') text += block.text;
  }
  return text;
}

/**
 * どの層の手だったかを `PostToolUse` の合図から決める。
 *
 * **`agent_id` で見る**。SDK の doc も逐語でそう言っている。
 *
 * [sdk-verbatim BaseHookInput.agent_id]
 * > Use this field (not agent_type) to distinguish subagent calls from main-thread calls.
 *
 * クローンは preset 一式を持つので
 * `Task` も持っており、サブエージェントの中の道具実行もこのフックを通って来る。
 * ここを分けないと「クローンが自分で叩いた回数」がサブエージェントの分だけ
 * 膨らみ、**日誌が答えるべき問い（自分でやったのか委ねたのか）に嘘の数を返す。**
 */
function cloneToolActor(
  hook: { agentId?: string; agentType?: string } | null | undefined,
  mainThreadActor: string,
): string {
  if (typeof hook?.agentId !== 'string' || hook.agentId.length === 0) return mainThreadActor;
  const type =
    typeof hook.agentType === 'string' && hook.agentType.length > 0
      ? hook.agentType
      : UNKNOWN_AGENT_TYPE;
  return `${CLONE_SUB_ACTOR_PREFIX}${type}`;
}

/**
 * 失敗を1行の理由にする。
 *
 * **`runner.ts` の `resultText()` と役割は同じだが、共有化はしない** — あちらは
 * `result` の本文と `subtype` のどちらか一方だけを返す作り（本文があれば本文、
 * 無ければ `（結果なしで終了: subtype）`）だが、ここは**両方を必ず載せる**。
 * 支出上限のとき SDK は `subtype: 'error_during_execution'` と
 * `result: "You've hit your individual spend limit..."` を両方運んでくる。
 * 片方だけにすると「上限で止まった」と「ただ失敗した」が区別できなくなる
 * （`runner.ts` の `else` 側のコメントと同じ理由）。5行程度の重複は許容する。
 *
 * **印の出どころ（`via`）も載せる。** `assistant.error` で止まったのか、
 * `result.subtype` が失敗だったのか、`subtype: 'success'` なのに `is_error` が
 * 立っていたのかは、**次に同じことが起きたときの掘り始めの位置が違う**。
 */
function failureReason(failure: SdkFailure, event: AgentTurnEnded): string {
  const body =
    failure.text.length > 0
      ? failure.text
      : event.body.length > 0
        ? event.body
        : (event.errorLines[0] ?? '（本文なし）');
  return `結果なしで終了: ${failure.code}（${failure.via}） / ${body}`;
}

/**
 * `rate_limit_event` の `status: 'rejected'` を上限の合図に仕立てる。
 *
 * **文言を捏造しない。** SDK の上限プレフィックス集合に文言を足すのではなく、
 * `rate_limit_info` が持つ構造化事実（`kind` ＝ `rateLimitType`）をそのまま
 * 添えるだけにする。`classifyUsageNotice` を通していないので `text` は
 * 「SDK が出した文言そのまま」ではないが、`status: 'rejected'` 自体が
 * SDK 側の権威ある値であり、これも自前の正規表現ではない。
 *
 * **`resetsAt` も同じ理由でそのまま運ぶ**（`usageLimitNoticeSchema.resetsAt`
 * の doc。Issue #1240 続き）。`facts.resetsAt` は `rate_limit_event` が持つ
 * 権威ある回復予定時刻で、`toRateLimitFacts` が既に epoch ミリ秒へ正規化して
 * ある——ここで単位を作り直さない。**分からなければ載せない**（`facts.resetsAt`
 * が `undefined` ならそのまま `undefined` を通す。AGENTS.md 地雷表「取れない軸に
 * 0 の行を作る」）。
 */
function rejectedRateLimitNotice(facts: RateLimitFacts): UsageLimitNotice {
  return {
    kind: 'reached',
    text: `rate_limit_event: status=rejected${facts.kind === undefined ? '' : `（kind: ${facts.kind}）`}`,
    ...(facts.resetsAt === undefined ? {} : { resetsAt: facts.resetsAt }),
  };
}

/**
 * UTF-8 で 1 つのコードポイントを表すのに要るバイト数の**上限**（issue #1829。
 * 以前は「1 UTF-16 code unit あたり」で数えていたが、`maxChars`（末尾を切る
 * 予算）をコードポイント数で統一したので、こちらもコードポイント単位へ揃える）。
 *
 * BMP の文字（コードポイント1つ＝ 1 code unit）は 1〜3 バイト、補助面の文字
 * （コードポイント1つ＝サロゲートペア＝ 2 code unit。絵文字の多くを含む）は
 * 常に 4 バイトである。**⟹ 上限は 4 である**（旧・code unit あたりの上限
 * だった 3 より大きい——補助面の文字は「2 code unit で 4 バイト」なので
 * code unit あたりでは 2 バイトで済むが、コードポイントあたりでは 4 バイト
 * まるごと要るため）。
 *
 * **export してある**——`packages/storage-fs/src/archive.ts` の
 * `FsTranscriptArchive.readTail`（#1283）が同じ「N倍読んでから切る」形を
 * 使う。根拠をもう1か所へ複製すると、直したときに片方だけ直る事故が
 * 起きるため、ここを唯一の出所にする。
 */
export const MAX_UTF8_BYTES_PER_CODE_POINT = 4;

/**
 * 生ログの**末尾だけ**を読む（全文を 1 本の文字列にしない）。
 *
 * ## なぜ全文を読まないのか
 *
 * `readFile(path, 'utf8')` は中身を **1 本の文字列**にする。JS の文字列には上限が
 * あり（`node:buffer` の `constants.MAX_STRING_LENGTH`。この器の Node 22 では
 * 536,870,888 文字）、**超えると `ERR_STRING_TOO_LONG` で投げる。**
 *
 * **クローンの生ログは 1 本のセッションが伸び続ける形である** —— resume は同じ
 * セッションへ書き足すので、ファイルは開始からの累積の全量を持つ。⟹ **伸びるほど
 * 確実に当たる側であり、当たると蒸留がまるごと止まる**（下の「なぜ退避と別の try か」）。
 *
 * ⟹ **蒸留に要るのは末尾だけである**（{@link tailOf}）。全文を文字列にする理由が
 * 最初から無い。
 *
 * ## なぜ {@link MAX_UTF8_BYTES_PER_CODE_POINT} 倍読むのか
 *
 * {@link tailOf} が切るのは**コードポイント**であってバイトではない。⟹ 末尾から
 * {@link DISTILL_TRANSCRIPT_TAIL_CHARS} **バイト**だけ読むと、日本語混じりの生ログでは
 * 渡る文字数が半分以下になる（1 文字 3 バイト）。**それは能力の削減である。**
 *
 * **`+ 1` を掛けてから倍する。** 本文が長いときに `tailOf` が「切り詰め済みの窓」を
 * 「本文がもとから短かった」と誤読しないためには、窓に**厳密に `DISTILL_TRANSCRIPT_TAIL_CHARS`
 * を上回るコードポイント数**が入っている必要がある（`TranscriptArchive.readTail`
 * interface doc、`tailOf` の doc と同じ理由）。`(DISTILL_TRANSCRIPT_TAIL_CHARS + 1)`
 * 倍読めば、末尾が genuinely 長いときは必ずそれを満たす。
 *
 * 4 倍読めば、末尾 `(DISTILL_TRANSCRIPT_TAIL_CHARS + 1)` コードポイント以上を必ず含む
 * （{@link MAX_UTF8_BYTES_PER_CODE_POINT} の doc）。そのうえで {@link tailOf} に
 * 切らせるので、**渡るものは全文を読んでいたときと同一である。**
 *
 * ## 窓の先頭が壊れることは問題にならない
 *
 * 窓の先頭はバイト列の途中を切りうる（デコードで `U+FFFD` になる）。{@link tailOf}
 * は切り詰めるときに**最初の改行より前を捨てる**ので、そこで一緒に落ちる（`tailOf` の
 * doc「行の途中と壊れた文字で始めないように整える」がもともとその仕事をしている）。
 * 窓がファイル全体に届いたときは切り詰めが起きないので、そもそも壊れない。
 */
async function readTranscriptTail(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const window = (DISTILL_TRANSCRIPT_TAIL_CHARS + 1) * MAX_UTF8_BYTES_PER_CODE_POINT;
    const length = Math.min(size, window);
    const buffer = Buffer.alloc(length);
    // 末尾から読む。`size <= window` なら `position` は 0 ＝ 全文である。
    //
    // **`bytesRead` で切る。** `read` は要求より短く返しうるので、`buffer` をそのまま
    // 文字列にすると**末尾に NUL が並ぶ**。それは蒸留の入力に混ざるうえ、pg 側は NUL を
    // 落とすので（`storage-pg` の `stripNulls`）**器によって中身が変わる**ことになる。
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * 生ログの預け先を包んで、`append` が渡してくる `projectKey` を拾う（#564 E1b）。
 *
 * **`{ ...store }` で包まないこと。** 預け先はクラス（`PgSessionStore`）なので、
 * 展開しても**プロトタイプのメソッドは1つも写らない** —— 型は通り、実行時に
 * `append is not a function` で落ちる。⟹ 1つずつ束ねて渡す。
 *
 * **任意のメソッドは、在るときだけ写す。** 無い口を `undefined` で持たせると、SDK 側の
 * 「実装しているか」の判定（`typeof store.listSessions === 'function'` の族）が
 * 変わりうる。
 */
function withProjectKeyProbe(
  store: SessionStore,
  note: (projectKey: string) => void,
): SessionStore {
  const listSessions = store.listSessions?.bind(store);
  const listSessionSummaries = store.listSessionSummaries?.bind(store);
  const remove = store.delete?.bind(store);
  const listSubkeys = store.listSubkeys?.bind(store);
  return {
    append: async (key: SessionKey, entries) => {
      note(key.projectKey);
      await store.append(key, entries);
    },
    load: store.load.bind(store),
    ...(listSessions === undefined ? {} : { listSessions }),
    ...(listSessionSummaries === undefined ? {} : { listSessionSummaries }),
    ...(remove === undefined ? {} : { delete: remove }),
    ...(listSubkeys === undefined ? {} : { listSubkeys }),
  };
}

/**
 * 蒸留に渡す末尾。全文はアーカイブに残っているので、ここでは直近だけでよい。
 * 行の途中と壊れた文字で始めないように整える。
 *
 * **`DISTILL_TRANSCRIPT_TAIL_CHARS` はコードポイント数で数える（issue #1829）。**
 * 以前は JS の `.length`（UTF-16 コード単位）で切っていた——補助面の文字
 * （絵文字の多く。1コードポイントが2コード単位になる）を含む本文では、
 * `TranscriptArchive.readTail`（pg 実装。PostgreSQL の `right()` はコードポイント
 * 数で数える）が「まだ短い（切り詰めていない）」と判定した本文の末尾を、
 * ここが「もう長い」と誤判定し、**本当は消えるはずのない本文の先頭を静かに
 * 消していた**（`slice()` がサロゲートペアを割って孤立サロゲートを作ることも
 * あった）。単位の変換は `tailByCodePoints`（`excerpt.ts`）の唯一の出所へ寄せる。
 *
 * **判定は「切り詰めた結果が元の文字列と一致するか」で行う**——`tailByCodePoints`
 * は本文全体のコードポイント数が `DISTILL_TRANSCRIPT_TAIL_CHARS` 以下ならその
 * 本文をそのまま返す（`transcript` と値が一致する）ので、一致すれば「正真正銘の
 * 先頭」であり、行の途中を整える必要は無い。一致しなければ真に超えていた
 * ということなので、そこから最初の改行までを捨てる。
 */
function tailOf(transcript: string): string {
  const cut = tailByCodePoints(transcript, DISTILL_TRANSCRIPT_TAIL_CHARS);
  if (cut === transcript) return transcript;
  const newline = cut.indexOf('\n');
  return newline === -1 ? cut : cut.slice(newline + 1);
}
