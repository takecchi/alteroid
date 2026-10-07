import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

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
  AgentClonePlugin,
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
import { collectRunnerModelLines } from './manager-models.js';
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
import type {
  AnswerApprovalVia,
  CloneHost,
  InterruptOutcome,
  InterruptTarget,
  PendingMessage,
  PendingMessageState,
  PostPersistOutcome,
} from './host.js';
import { createRunnerRegistry, type RunnerClient } from './runner-protocol.js';
import {
  createManagerPool,
  type CodexAuthRunnerSync,
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
import type { PluginDistributionService } from './plugin-distribution-service.js';
import { PLUGIN_SCOPES_FOR_CLONE, extractPluginsForScopes } from './plugin-extract.js';
import { summarizeRemovedForJournal } from './plugin-removed-summary.js';
import type { ProfileService } from './profile-service.js';
import { createRecentMap } from './recent.js';
import { describeSituation, describeSituationUnavailable, readAtLabel } from './situation.js';
import { countSupersedingReports, describeSuperseded } from './superseded.js';
import { describeValidity, inboxEventValidity } from './inbox-validity.js';
import type { AttachmentRef, JobStatus, TurnFailureKind } from './schema.js';
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
import { assistantFailureOf, turnFailureKindOf, type SdkFailure } from './sdk-failure.js';
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
  // デーモンが作った同じインスタンスを渡す: `mcpServerService` と同じく、別のインスタンスを持つと正本が2つになるため
  pluginDistributionService?: PluginDistributionService;
  // デーモンが作った同じインスタンスを渡す: runner が名乗るたびの降ろし直しと書き戻しをマネージャーのプールに通すため
  codexAuthService?: CodexAuthRunnerSync;
  accountUsage?: () => AccountUsageState;
  // ここで `Scheduler` を作り直さない: デーモン側が組み立てるため
  scheduler?: () => ScheduleStatus[];
  onScheduledRunNotStarted?: (kind: string, delayMs?: number) => void;
  // ここで環境変数を読み直さない: 事実はデーモン側が組み立て、読み直すと出所が2つになるため
  self?: SelfFacts;
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
  /** 前回日誌へ書いた plugin の一覧の指紋（`#plugins`）。空は ''。 */
  #lastPluginsDigest = '';
  readonly #sessionStore: SessionStore | undefined;
  // `cwd` から計算し直さない: SDK の sanitize（200 文字超は切って djb2 のハッシュを足す）の再実装は静かにずれるため
  #projectKey: string | null = null;
  readonly #managers: ManagerPool;
  // 本セッションと蒸留のサイドクエリで同じものを使う: 片方だけ帯が違うと、蒸留＝人格の書き手だけが別の頭になるため
  readonly #model: string;
  readonly #self: SelfFacts | undefined;
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
  #inFlight: { readonly events: readonly InboxEvent[]; started: boolean } | null = null;
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
      pluginDistributionService,
      codexAuthService,
      accountUsage,
      scheduler,
      onScheduledRunNotStarted,
      self,
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
        ...(pluginDistributionService === undefined ? {} : { plugins: pluginDistributionService }),
        ...(codexAuthService === undefined ? {} : { codexAuth: codexAuthService }),
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
      // 投げない: 書けない器に消しも通らないのは想定内で、跡は `noteInboxEventRefused` が残す
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
  ): {
    inProgress: ChatStreamEvent[] | null;
    pending: PendingMessage[];
    unsubscribe: () => void;
  } {
    const inProgress = this.#progress.snapshot(conversationId);
    const pending = this.#pendingMessages(conversationId);
    const unsubscribe = this.subscribe(conversationId, listener);
    return { inProgress, pending, unsubscribe };
  }

  /**
   * その会話で答えを待っている発言を、取り出し済み → 枠で保持 → 受信箱の順番待ち（古い順）で返す。
   * 分類は `#interruptInFlight` と同じ見方（`await` を挟まない）。`clientMessageId` を持たない発言は、
   * 呼び手が指す手がかりが無いので載せない。
   */
  #pendingMessages(conversationId: string): PendingMessage[] {
    const result: PendingMessage[] = [];
    const add = (events: readonly InboxEvent[], state: PendingMessageState): void => {
      for (const event of events) {
        if (event.type !== 'human_message' || event.conversationId !== conversationId) continue;
        if (event.clientMessageId === undefined) continue;
        result.push({ clientMessageId: event.clientMessageId, state });
      }
    };
    const flight = this.#inFlight;
    if (flight !== null) {
      if (this.#sdkSession.turn !== null) add(flight.events, 'running');
      else if (!flight.started) add(flight.events, 'starting');
    }
    const any = (): boolean => true;
    add(this.#delivery.findDeferred(any), 'held');
    add(this.#delivery.inbox.findPending(any), 'queued');
    return result;
  }

  // 先に日誌へ書いてから止める: 止めた後に書くと、止めたことで起きた失敗の記録より後ろに並んで順序が逆に読めるため
  async interruptTurn(target?: InterruptTarget): Promise<InterruptOutcome> {
    if (target === undefined) return this.#stopRunningTurn();
    const isTarget = (event: InboxEvent): boolean =>
      event.type === 'human_message' &&
      event.conversationId === target.conversationId &&
      event.clientMessageId === target.clientMessageId;
    const queued = [
      ...this.#delivery.inbox.findPending(isTarget),
      ...this.#delivery.findDeferred(isTarget),
    ];
    if (queued.length === 0) return this.#interruptInFlight(isTarget);
    return this.#withdrawQueued(
      queued.map((event) => event.id),
      isTarget,
      target,
    );
  }

  // await を挟まずに呼ぶ: 分類と取り下げの間に取り出されると、取り下げたと言いながら配られる窓ができるため
  #interruptInFlight(isTarget: (event: InboxEvent) => boolean): Promise<InterruptOutcome> {
    const flight = this.#inFlight;
    if (flight !== null && flight.events.some(isTarget)) {
      if (this.#sdkSession.turn !== null) return this.#stopRunningTurn();
      return Promise.resolve(flight.started ? 'idle' : 'starting');
    }
    return Promise.resolve(this.#sdkSession.turn === null ? 'idle' : 'not_target');
  }

  async #withdrawQueued(
    ids: readonly string[],
    isTarget: (event: InboxEvent) => boolean,
    target: InterruptTarget,
  ): Promise<InterruptOutcome> {
    // 器への書き込みが終わる前に消すと、消した後に行が積まれて次の起動で配り直される（`#forget` と同じ）。
    for (const id of ids) await this.#delivery.getUnread(id);
    const { droppedFromDelivery } = await removeInboxEventsAndStopDelivery(
      this.#stores.inbox,
      { dropQueuedInboxEvents: (removedIds) => this.dropQueuedInboxEvents(removedIds) },
      ids,
    );
    const dropped =
      droppedFromDelivery > 0 ? droppedFromDelivery : await this.dropQueuedInboxEvents(ids);
    if (dropped === 0) return this.#interruptInFlight(isTarget);
    for (const id of ids) this.#heldForUsage.delete(id);
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_DECISION_PREFIX}人間の求めで、順番待ちだった発言（clientMessageId ` +
        `${target.clientMessageId}）を取り下げた。ターンを起こさず配らない。発言の行は日誌に残してある`,
      conversationId: target.conversationId,
    });
    return 'withdrawn';
  }

  async #stopRunningTurn(): Promise<'interrupted' | 'idle'> {
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
      this.#inFlight = { events: [event], started: false };
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
          this.#inFlight = null;
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
        this.#inFlight = null;
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
        this.#inFlight = null;
        continue;
      }

      // まとめ読みの判定を呼ぶ前に必ずリセットする: `#drainMergeableWithinLimit` は対象外の起点では呼ばれず、戻さないと前の反復で切ったときの断り書きが持ち越されるため。判定の呼び出しより下に置かない: 立った印を拭き取り、`external` の束でだけ断り書きが黙って消えるため
      this.#notices.set('mergedBatchTruncation', '');
      const mergedHuman = this.#mergedHumanBatch(event);
      const mergedReports = this.#mergedManagerReportBatch(event);
      const mergedExternal = this.#mergedExternalBatch(event);
      const batch: InboxEvent[] = mergedHuman ?? mergedReports ?? mergedExternal ?? [event];
      this.#inFlight = { events: batch, started: false };

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
        this.#inFlight = null;
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
        // ターンを止めない: 引けなかったことは `humanTurnText` が「引けなかった」として扱う
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
        // stale の record は直上の `flushStaleRemovalBuffer` でストアから消えているので「処理した」に入れ、live の record はまだストアに残るので入れない
        await this.#journalRestoreUnreadPassEnd(
          decided,
          restoreUnreadPassIndex + (verdict === 'stale' ? 1 : 0),
          { interrupted: true },
        );
        return claimedIds;
      }

      // 型で先読みして分岐を作らず、`commitmentFor` の結果（`!== null`）を毎回見る: `null` を返すのは型で決まる3つだけでなく、デーモン自身の `external` も同じため
      if (commitmentFor(record.event) !== null) {
        try {
          const commitment = await this.#stores.commitments.get(record.event.id);
          if (commitment !== null && commitment.closedAt !== undefined) {
            this.#delivery.redeliveryState.markClosed(record.event.id, commitment);
          }
        } catch (error) {
          // 読めなければ「閉じていない」として全文で配る: 雑音であって喪失ではない側へ倒すため
          noteDroppedRecord('配り直しの片付き確認', inboxEventShape(record.event), error);
        }
      }

      this.#delivery.redeliveryState.markRedelivered(record.event.id, record);
      // 既に器に在るので書き直さないが、消し込みの対象には入れる: 入れ忘れると、拾い直したものが処理後も残って毎回配られるため
      this.#delivery.setUnread(record.event.id, Promise.resolve());
      // 本文は配達のたびに書く: 受理の瞬間の追記は器へ届く前に落ちたかがここから分からず、書かないと、その窓に落ちた発言が日誌にも `GET /conversations` にも永久に無くなるため（「消えるより配り直す」の向きを記録でも揃える）
      this.#record(record.event);
      // 記帳もやり直す: `open` は冪等で、やり直さないと `post` の受理後に `open` が届く前に落ちた合図が未読として残るのに台帳から永久に漏れるため
      this.#commit(record.event);

      // 門より先に「そもそもまだ意味が在るか」を訊く: 門は `usageBlocked` という揺れる値で「いま配るか」を決めて行を残すが、こちらは合図の性質だけで「もう要らないか」を決めて消すので、消し込みを揺れる値に預けないため（`restoredInboxEventVerdict` は `usageBlocked` を受け取らない）
      if (verdict === 'stale') {
        continue;
      }

      // `usageBlocked` はその瞬間に評価し、ループの外で1回だけ評価して使い回さない: このループは1件ごとに `await` するので、並行する `#pump` が途中で動かしうるため（`usageBlockedResetsAt` / `usageBlockedTokenId` も同じ瞬間に読む）
      let worthRedelivering: boolean;
      try {
        worthRedelivering = this.#redeliveryGate(record.event, {
          usageBlocked: this.usageBlocked,
          releasePending: this.usageReleasePending,
          usageBlockedResetsAt: this.usageBlockedResetsAt,
          usageBlockedTokenId: this.usageBlockedTokenId,
        });
      } catch (error) {
        // 判定できないときは配る側へ倒す: 雑音であって喪失ではない側のため
        noteDroppedRecord('配り直しの門の判定', inboxEventShape(record.event), error);
        worthRedelivering = true;
      }

      if (!worthRedelivering) {
        // **`#inbox.push` をしない ＝ ターンを起こさない。** 受信箱の行も台帳の行も消さない: 次の起動でまた拾い、その時点の `usageBlocked` で判定し直すため
        await this.#foldGatedRedelivery(record, gatedRecordsThisPass);
        continue;
      }

      // `post` を通さない: tick の畳み込みで落ちた行が器に残り続けるため。ただし人間優先（`insertAfterLast`）まで落とさない: 避けたいのは畳み込みだけで、割り込みの規則ではないため
      // 拾い直しているあいだに消された合図は積まない: `dropQueuedInboxEvents` は「その瞬間に待ち行列に居るもの」しか外せず、このループは日誌・台帳の `await` を挟みながらこれから積むので、消された後に積む順序が起きるため
      // 門より後ろに置く: 逆にすると、消された合図に対して「次の起動でまた拾う」と書く跡が残り、拾えないのに拾えると書くことになるため
      // `#forget` は呼ばない: 器の行は消し込んだ側が既に消しており、空振りの `remove` で `settled` を二重に数えるため
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

    await flushStaleRemovalBuffer();
    await flushGatedFoldHeadline();
    await this.#journalRestoreUnreadPassEnd(decided, decided.length, { interrupted: false });
    return claimedIds;
  }

  // 件数が0のときは書かない: 未読が0件の起動が大半で、0件のたびに書くと、起動回数ぶん積み重なる中身の無い雑音になるため
  async #journalRestoreUnreadPassStart(total: number): Promise<void> {
    if (total <= 0) return;
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: `${EXCHANGE_KIND_GAUGE_PREFIX}未読の拾い直しを始める（claimPending が返した総数 ${total} 件）`,
    });
  }

  // `processed` は「ストアから消えた件数」で統一する: 行が「残り N 件は次の起動で拾い直す」と名乗る以上、N はストアの実際の残りと一致させるため（stale は含め、live は含めない）
  // 内訳は専用のカウンタを持たず都度数え直す: 中断のタイミングと更新の順序が噛み合わず2本のカウンタが食い違うバグを作る余地を避けるため
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
    // 接頭辞の参照は `#journal` 呼び出しの `text:` に直接書く: `exchange-kind-coverage.test.ts` がソースを走査して `EXCHANGE_KIND_*_PREFIX` の定数名を文字として探すため、変数経由だとこの歯を素通りする
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

  // record の本文より前に、ループの外で書き切る: N 件を1本へまとめるには先に N 件ぶんの中身を知る必要があり、`deliveries` は `claimPending()` がループより前に確定させた値で、ループが途中で打ち切られても「配り直された」事実は真のため（「二度届く（雑音）より消える（判断材料の喪失）方が高い」）
  // 1件のときは文言を変えない: `inbox-persistence.test.ts` が逐語で見るため。2件以上の枝は `alone` を参照しない: `alone` が真なら live な record は高々1件のため
  // 各件を `deliveries` / `at` / `inboxEventShape(event)` で列挙し、要約しない: 人間が後から読み返す日誌のため。時間の窓や件数の上限は持ち込まない
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

  // 「二度目だと分からない」ことは受け入れない: 分からないとクローンは同じ報告に二度応答し、ターンが丸ごと無駄になるため
  // `batch.length === 1` は1件専用の文言を変えない: 既存の逐語一致の歯（`inbox-persistence.test.ts` など）を壊さないため
  // 2件以上は1件ごとに断り書きを繰り返さず束の行にする: N 件を並べると断り書きの分量が本文を埋めるため（件数・配達回数の最大値・最古の時刻を持たせる）
  // 印付きが1件しかない束も `alone` ではない側へ倒す: 「この回数をこの合図のせいにしない」より慎重な言い方で、情報は減らないため
  #redeliveryNoticeFor(batch: readonly InboxEvent[]): string {
    if (batch.length === 1) {
      const event = batch[0];
      if (event === undefined) return '';
      const record = this.#delivery.redeliveryState.get(event.id);
      if (record === undefined) return '';

      // 同時に拾い直した件数で名乗り分ける: 2件以上だと居合わせただけの合図も同じだけ回数が増えており、回数から原因が読めないため
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

    const records: PendingInboxEvent[] = [];
    for (const event of batch) {
      const record = this.#delivery.redeliveryState.get(event.id);
      if (record !== undefined) records.push(record);
    }
    if (records.length === 0) return '';

    const maxDeliveries = Math.max(...records.map((record) => record.deliveries));
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

  // `stores.commitments` を引き直さない: 配り直した後に取り出されるまでの間にクローン自身が閉じた場合にも畳みが掛かり、「配り直した時点では未了だった」事実が消えるため（判定は `#restoreUnread` が済ませてある）
  #closedRedeliveryNoticeFor(event: InboxEvent): string | null {
    const commitment = this.#delivery.redeliveryState.getClosed(event.id);
    if (commitment === undefined) return null;
    return closedRedeliveryNotice(event, commitment);
  }

  // 流せたことを記録の代わりにしない: `#emit` は購読者が居なければ何もせず、内部ターンには聞き手が居ないので、握り潰すと「クローンが黙り、マネージャーが永久に返事を待つ」が無記録で起きるため。どちらも日誌で受ける（`#forget` が例外で終わった合図も消す根拠は「失敗が記録されている」こと）
  // 日誌へ書く（`Clone#post` のように stderr にしない）: ここは `async` で呼び出し側が全経路で `await` しており、`#forget` はその後に走るので、跡を残す窓と競合しないため
  // 本文（`message`）を stderr へ出さない・素の `String(error)` を足さない: `message` は SDK・API・ストアのドライバが決める文字列で、stderr は器の外へ出ていくため
  // 失敗の記録は `with: 'self'` へ置く: `with: 'human'` / `role: 'outbound'` だと、`GET /conversations/:id` で失敗の記録が「クローンの返信」として会話に並ぶため（`conversationId` は落とさず、テキストの前置きも変えない）
  // 人間には生の文言を含まない1行を `with: 'human'` で返す: `self` へ移しただけだと、後から開いた人間には自分の発言だけがあって返信が無く、「まだ考えている」と見分けられないため
  // 同じ1行を二度書かない: 枠が閉じている間は毎回同じ理由で落ちて会話がこの1行で埋まり、人間が何もしていないのに増え続けるため（会話ごとに最後の1行を覚えて畳む。新しい発言が来れば `post()` が記憶を落とす）
  async #reportFailure(
    conversationId: string | null,
    cause: string | { readonly error: unknown },
    sdkFailure?: SdkFailure,
  ): Promise<void> {
    // 分類は生の文字列で先に行い、外へ出す文だけを `reasonOf` にする: `prompt is too long` 等が2行目以降に在る形もあり入口で1行目へ畳むと判定が壊れる一方、`emit`・日誌・`failure` に載る文は drizzle の `params:` のように値を運びうるため
    const rawMessage = typeof cause === 'string' ? cause : String(cause.error);
    const message = typeof cause === 'string' ? cause : reasonOf(cause.error);
    // 失敗の印はここで立てる: 呼び出し側ごとに立てると、経路が増えたとき印の無い失敗が混ざり「成功して空文字を返した」と区別できないため。`#finishTurn()` より必ず先に呼ぶ: 逆だと `this.#turn` が既に `null` で印が残らないため
    const running = this.#sdkSession.turn;
    if (running !== null) running.failure = message;

    // 日誌より先に見せる: 書き込みを待たせて「反応が無い」時間を伸ばさないため
    // 種別は本文から決めない: 構造（`turnFailureKindOf`）から決める
    const kind: TurnFailureKind =
      this.#usageBlocked === null ? turnFailureKindOf(sdkFailure) : 'quota';
    this.#emit(conversationId, { type: 'error', message, kind });

    // 文脈窓を超えた失敗の目印は末尾に足し、先頭（`内部ターンが失敗した:` / `人間との対話ターンが失敗した:`）は変えない: `clone-turn-failure-trace.test.ts` の `text.startsWith(...)` を壊すため
    const contextWindowFailure = classifyContextWindowFailure(rawMessage);
    // 判定はここでしかしない: `#apply` 側でもう一度分類すると判定が2本に割れるため
    const foldingForContextWindow = await this.#noteContextWindowFold(
      contextWindowFailure,
      conversationId,
    );
    // 枠に当たり続けたことによる畳みは判定済みなので、ここでは立っている印を読むだけにする: 二重に畳まないため
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

    // 文言の分岐は `#usageBlocked` を見てこの1か所に置く: 呼び出し側ごとに書き分けると、経路が増えたとき「枠なのに枠と言わない」失敗が静かに混ざるため
    // 枠と長さは同時に真になりうる（CLI が合成した `Prompt is too long · automatic compaction failed: You've hit your …`）: 保持は正しい（やめると閉じた枠を叩き続ける）ので、保持だけを言うと長さでも落ちる回に守れない約束になり、どちらへも倒さず両方言う
    // ここへ ASCII の目印（`context_window_failure`）と生の文言を持ち込まない: 日誌側の道具で、`clone-turn-failure-trace.test.ts` が「人間へ返す1行」でその線を測るため
    const turnFailure = this.#usageBlocked === null ? ('failed' as const) : ('held' as const);
    const humanText =
      (this.#usageBlocked === null
        ? 'この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。'
        : 'いま利用上限に当たっているので、この発言にはまだ返せない。' +
          '発言は捨てずに保持していて、枠が開いたら試し直して返信する。' +
          (contextWindowFailure === undefined ? '' : CONTEXT_WINDOW_ALSO_NOTICE)) +
      // 畳むかどうかは枠の有無と独立なので、3軸目として1文足すだけにする: 4マスをそれぞれ書き分けると同じ内容を4回持つため
      (foldingForContextWindow === 'folding'
        ? CONTEXT_WINDOW_FOLD_NOTICE
        : foldingForContextWindow === 'held'
          ? CONTEXT_WINDOW_FOLD_HELD_NOTICE
          : foldingForUnproductiveUsage === 'folding'
            ? UNPRODUCTIVE_USAGE_BLOCK_FOLD_NOTICE
            : '');

    const folded = this.#notices.foldHumanFailure(conversationId, humanText);
    if (folded !== null) {
      // 畳んだ回は1件ずつ残す: 「畳んだ」だけでは何件ぶんが人間へ返らなかったかを後から数えられないため
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
      turnFailureKind: kind,
    });
  }

  // 形が読めなければ控えを触らない: `null` に戻すと、既に控えてあった正しい在り処を捨てるため
  #noteTranscriptPath(path: string | undefined): void {
    if (typeof path === 'string' && path.length > 0) this.#distillMemory.setTranscriptPath(path);
  }

  // 畳んでも直らない枝（`held`）を置く: 会話を引き継がずに開いたセッションが1度も答えを返せず長さで落ちたなら、開き直しても材料は同じで、落ちる→畳む→開く→落ちるを枠が閉じているときほど激しく繰り返すため（抑止しても悪くなるものは無く、止まるのは畳み直しだけでターンは回る）
  // `held` は1回きり: 拒まれた入力がセッションに残るなら、次の入力で履歴ごと送り直して同じ長さで落ち、自力では抜けられないため。同じセッションで別の入力でもう一度長さの失敗が起きたらそこで畳む（`#heldInSession`）。黙って回さず、畳み直すたびに日誌と人間の会話へ1行残す（`#noteHeldEscalation`）
  // 人間の発言には上限を掛けない: 人間の言葉を機械が黙って切ると、人間にできることがこの層でできない形になるため
  // `setCloneSessionId(null)` は畳んだ後でなく印と同時に打つ: 畳む前にプロセスが死ぬと、長すぎるセッション id が残って次の起動が resume し同じところで落ちるため
  // 投げない: 失敗の報告そのものが失敗するため（id を捨てられなかったことは記録に残し、報告は続ける）
  async #noteContextWindowFold(
    failure: ContextWindowFailure | undefined,
    conversationId: string | null,
  ): Promise<'no' | 'folding' | 'held'> {
    if (failure === undefined) return 'no';
    if (this.#sdkSession.query === null) return 'no';
    const escalatedFromHeld = this.#sdkSession.resumedFrom === null && !this.#sessionAnswered;
    if (escalatedFromHeld && !this.#heldInSession) {
      this.#heldInSession = true;
      return 'held';
    }

    this.#sdkSession.armContextWindowRecycle();
    this.#distillMemory.armContextWindowFoldNotice();
    try {
      await this.#stores.sessions.setCloneSessionId(null);
    } catch (error) {
      noteDroppedRecord('resume 素材の破棄', 'clone', error);
    }
    if (escalatedFromHeld) await this.#noteHeldEscalation(conversationId);
    return 'folding';
  }

  // 人間の発言のターンでは書かない: `#reportFailure` の1行に `CONTEXT_WINDOW_FOLD_NOTICE` が既に載るため。内部のターンで落ちた回は人間へ何も届かないので、直近の会話へ1行書く。投げない
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
      // 会話の窓は `readConversationWindow` でだけ組む: `scripts/conversation-window-single-source.test.ts` が見るため
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

  // 文脈窓の実測を待たず積んだ文字数で先に畳む: 枠が閉じている間は compaction 自体が 429 で落ち、「長すぎる」と教える合成メッセージが来ないまま積み上がり続けるため。呼ぶのは `reached` 枝からだけ: 短絡はモデルを呼ばず持ち越しが増えないため
  // 畳んだ後の印は文脈窓のときと同じ実体を使う: 理由が違っても結末（次の境界で resume せずに開き直す）は同じで、系統を2つに増やさないため
  async #noteUnproductiveUsageBlockFold(): Promise<'no' | 'folding'> {
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
    // 日誌にも残す: 跡が無いと「なぜか会話が切れた」としか見えないため
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

  // (i) 退避と (ii) 蒸留を独立した `try` に割る: (i) はモデルを呼ばず枠が閉じていても通るが (ii) は通らず、同じ `try` に入れると (i) が (ii) の失敗に巻き込まれるため
  // (i) が落ちたら黙らず日誌へ残す: 「残っているはず」と読まれると守れない約束になるため
  async #salvageTranscript(): Promise<void> {
    const path = this.#distillMemory.transcriptPath;
    // 控えが無い窓は黙って通す: 開いたばかりで退避する中身もほぼ無く、日誌へ書くと道具を使う前に落ちた回のたびにノイズが1行増えるため
    if (path === null) return;

    let archiveId: string | null = null;
    try {
      const transcript = await readFile(path, 'utf8');
      const write = await this.#stores.archive.archive(
        this.#sdkSession.sdkSessionId ?? 'clone',
        transcript,
      );
      archiveId = write.id;
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
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_FAILURE_PREFIX}文脈窓で畳む前の生ログの退避に失敗した: ${reasonOf(error)}` +
          '（⚠️ この区間の生ログは器の外に残っていない）',
      });
    }

    // (i) が落ちても (ii) へ進む（`return` しない）: (i) は全文を1本の文字列にするので生ログが伸びると `ERR_STRING_TOO_LONG` で落ち、そこで止めると記憶へ移すことが退避の都合で道連れになるため。蒸留は末尾だけを自分で読むので (i) の成否に依存しない
    try {
      await this.#distillFromTranscript(tailOf(await readTranscriptTail(path)));
    } catch (error) {
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_FAILURE_PREFIX}文脈窓で畳む前の蒸留に失敗した: ${reasonOf(error)}` +
          // 退避が落ちた回に「退避は済んでいる」と書かない: 守れない約束になるため
          (archiveId !== null
            ? '（生ログの退避は済んでいる。記憶へは移せていない。次の起動で拾い直す）'
            : '（⚠️ 退避も失敗しているので、この区間はどこにも残っていない）'),
      });

      // 墓標を立てる: 蒸留が落ちる主な理由は枠で、枠は待てば開くが、印が無いと開いた後に拾う手がかりが残らないため。投げない: 失敗の報告の途中のため
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

  // 起動時に拾う: 同じプロセスの中で試し直しても枠はまだ閉じているため。`load()` ではなく `archive.readTail` から拾う: 退避は済んでおり、`load` は 60 秒の予算に掛かるため
  async #pickUpTranscriptGrave(): Promise<void> {
    const grave = await this.#stores.sessions.getTranscriptGrave();
    if (grave === null) return;

    // `read()`（全文）ではなく `readTail()`（末尾）を使う: `archive` の1行は最大 78.3 MB に育ち、全体をヒープへ載せると起動のたびに走るこの経路が OOM を起こしうるため
    const result = await this.#stores.archive.readTail(
      grave.archiveId,
      DISTILL_TRANSCRIPT_TAIL_CHARS,
    );
    if (result.kind !== 'body') {
      // `missing` と `removed` を同じ文面へ畳まない: 別の出来事のため。どちらも印だけを残さない: 拾えないものを起動のたびに引きに行くことになるため。`missing` の文面は変えない: 保証するテストがあるため
      const text =
        result.kind === 'removed'
          ? `記憶へ移せていない区間の退避の本文が消されているので、印を下ろした: ${grave.archiveId}` +
            `（${result.removedAt} に ${result.bytes} バイトを落とした${describeArchiveRemovedBytesUnit()}。` +
            '⚠️ この区間は記憶へ移せていない）'
          : `記憶へ移せていない区間の退避が見つからないので、印を下ろした: ${grave.archiveId}` +
            '（器を作り直した、あるいはそもそも積まれなかった。⚠️ この区間は記憶へ移せていない）';
      // 判定と書き込みを1操作へ畳む: 引き直して比べる形では、引き直しの後・下ろす書き込みが効く前に新しい印が landing しうるため（`clone-grave-pickup-race.test.ts` が再現する）
      const lowered = await this.#stores.sessions.clearTranscriptGraveIf(grave.archiveId);
      // 下ろしていないなら「下ろした」と書かない: 跡が嘘をつくため
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

    // 拾い直したことを日誌へ1行残す: `pre_compact_distill` の入力だけだと compaction の蒸留と区別が付かず、後から何回拾い直したかを数えられないため
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: `${EXCHANGE_KIND_RECOVERY_PREFIX}前の器が記憶へ移せなかった区間を拾い直す: ${grave.archiveId}`,
    });

    await this.#distillFromTranscript(tailOf(transcript));

    // 印を下ろすのは蒸留が成功したときだけ、引き直してから下ろす: 拾っている間に新しい印が立つ窓があり、素で `null` を書くとその新しい方を消すため
    await this.#stores.sessions.clearTranscriptGraveIf(grave.archiveId);
  }

  // 変わったときだけ器へ書く: `append` はおよそ 100ms ごとに来て、毎回書くとターン1本につき数十回の書き込みになるため。投げない: 失敗しても生ログを預ける本体の仕事を止める理由が無いため
  #noteProjectKey(projectKey: string): void {
    if (this.#projectKey === projectKey) return;
    this.#projectKey = projectKey;
    void this.#stores.sessions.setProjectKey(projectKey).catch((error: unknown) => {
      noteDroppedRecord('生ログの scope の記録', projectKey, error);
    });
  }

  // 捨てる前に呼ぶ。空振りは黙って通す: 生ログの預け先が無い構成は拾う材料が無く、書くと fs で動かすたびに同じ1行が積もり、`projectKey` を誰も知らない窓は預けた生ログが1件も無く失うものもほぼ無いため
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

  // `load()` は使わない: 全件を戻すと SDK が掛けている 60 秒の予算に当たりに行くため
  async #pickUpLostSession(): Promise<void> {
    const tail = this.#stores.sessionTranscriptTail;
    if (tail === undefined) return;
    const grave = await this.#stores.sessions.getLostSessionGrave();
    if (grave === null) return;

    const transcript = await tail.readTail(grave, DISTILL_TRANSCRIPT_TAIL_CHARS);
    if (transcript === null) {
      // 印だけを残さない: 残すと、拾えないものを起動のたびに引きに行くため
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

    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: `${EXCHANGE_KIND_RECOVERY_PREFIX}捨てたセッションの区間を、預けた生ログから拾い直す: ${grave.sessionId}`,
    });

    await this.#distillFromTranscript(tailOf(transcript));

    await this.#stores.sessions.clearLostSessionGraveIf(grave.sessionId);
  }

  // `reached` を呼び出し側が直後に `error`（終端）で閉じるなら、`usage_limited` の `await` を先に済ませる
  // `org_policy` は保持しないが日誌には書く: 早期 return すると「ただ失敗した」と区別できないため
  // 畳むのは日誌だけ: 同じ `kind`・同じ文言でも `#usageBlocked` を立てる処理と `usage_limited` の emit は毎回行う（2件目以降は別の会話から来ているかもしれず、emit まで畳むと送り主に何も見えなくなるため）。`transition` / `warning` は毎ターン届き、畳まないと同じ知らせで日誌が埋まる
  async #noteUsageNotice(
    notice: UsageLimitNotice | undefined,
    conversationId: string | null,
    source: 'text' | 'rate_limit',
  ): Promise<void> {
    if (notice === undefined) return;

    // 言い換えない: `describeUsageNotice` が人間の検索できる文言をそのまま返すため
    if (this.#notices.noteUsage(notice.kind, notice.text)) {
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_GAUGE_PREFIX}${describeUsageNotice(notice)}`,
      });
    }

    // 回し手へ渡すのは文言から分類した通知（`source === 'text'`）だけ: `rate_limit_event` 由来の `reached` は「その枠が尽きた」を仕立て直したもので「仕事が止まった」ではなく、渡すと `overage_exhausted` の設定でも課金枠を使わずに回ってしまうため
    if (source === 'text') await this.#observeForTokenRotation({ notice });

    if (notice.kind !== 'reached') return;

    this.#usageBlocked = withNoticeTextResetsAt(notice, Date.now());
    this.#emit(conversationId, { type: 'usage_limited', message: describeUsageNotice(notice) });

    // `source === 'text'` に限って数える: `rate_limit_event` 由来はターンの頭ごとに届く「1つぶんの状態」で後続の `result` が成功することがあり、数えると成功するターンの途中でも畳みにかかるため
    if (source === 'text') await this.#noteUnproductiveUsageBlockFold();
  }

  async #handle(event: InboxEvent): Promise<void> {
    switch (event.type) {
      case 'human_message': {
        await this.#runHumanTurn([event]);
        return;
      }

      case 'distill': {
        // セッションが無くても活動が在れば見送ったことを日誌へ残し、印は倒さない: 倒すと「移した」ことになり、何も移っていない記憶が落ちるため。活動が一度も無いなら黙って return する: 起動直後の停止などで毎回日誌を増やさないため
        // 「一度も活動していない」は `hasUndistilledActivity` でなく `stores.sessions` の `cloneSessionId`（プロセスを跨いで残る）で見る: `hasUndistilledActivity` の初期値は `true` で、確認された活動と仮定を区別できないため。読めなかったら「活動が在った」側へ倒す: 読めないことを理由に記録を失わないため
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
        // 前回の蒸留以降に新しいことが無ければ、同一内容の蒸留を重ねて払わない: 会話終了の直後の `stop()` は同じ文面になり、間にターンが無ければ文字どおりの重複のため。印が立っていれば必ず投げる
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
        // 的の一覧は定期の棚卸しの刻みにだけ添える: 会話終了・shutdown の蒸留は会話を記憶へ移すのが本題のため。測れなかったら添えてもターンは止めない: 記憶が読めない回に棚卸しを落とすと、いちばん畳みたい状態で仕事が消えるため
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
        await this.#journal(
          turnInputEntry({ type: 'distill', reason: event.reason, prompt: distillPrompt }),
        );
        const outcome = await this.#runInternal(distillPrompt, 'distill');
        // 成功で終わった蒸留だけが印を下ろす: 失敗した蒸留（枠で保持された場合を含む）で下ろすと、移せなかった記憶を「移した」ことにして落とすため
        if (outcome.status === 'answered') {
          this.#distillMemory.markDistilled();
          // 「成功で終わった」を日誌へ残す: 印は器の中にしか無く、プロセスが消えると「前回どこまで移せたか」が引けないため。`#hasUndistilledActivity` を下ろすのと同じ条件・同じ場所に置く: 条件を別の行へ写すと、片方だけ直して古い基準が残るため
          await this.#journal(distillSucceededEntry(event.reason));
        }
        return;
      }

      case 'human_answer': {
        // 同じ id を既に処理していたら2回目はターンを起こさず、中身の無い跡だけ stderr に残す
        if (this.#handledHumanAnswerIds.has(event.id)) {
          noteDuplicateHumanAnswer(event);
          return;
        }
        this.#handledHumanAnswerIds.add(event.id);

        // 行が読めなくなっていても回答は失わない: 回答の本文は `event` が持ち、取れないのは質問だけなので、そう言って続きへ進む
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
        // 宛先は managerId と requestId の対で戻す: requestId を落とすと、複数を待っているマネージャーの宛先が決まらず、人間が答えたのに仕事が再開しないため
        const waiting =
          approval?.jobId === undefined
            ? ''
            : `\n\nこの確認はマネージャー ${approval.jobId} のものである。` +
              `回答を \`manager_send\`（許可確認なら decision 付き）で返すと、止まっていたその仕事が再開する。` +
              `\n宛先: managerId: "${approval.jobId}"` +
              (approval.requestId === undefined ? '' : `, requestId: "${approval.requestId}"`);
        // 回答経路を添える: `operator` 経由の回答が人間本人とは限らないことを、クローンが判断材料にできるようにするため
        const viaLine =
          event.answeredVia === undefined
            ? ''
            : `\n回答経路: ${describeAnsweredVia(event.answeredVia)}`;
        // 構造も JSON で添える: 回答の文は人間向けに畳んだもので、設問 id と選択肢 id の対が文から読み取れないため
        const selectionsLine =
          event.selections === undefined
            ? ''
            : `\n選択（構造。設問 id → 選んだ選択肢 id ＋ その他）: ${JSON.stringify(event.selections)}`;
        const answerPrompt =
          `[system] 承認待ちにしていた質問に人間が答えた。\n\n質問: ${question}\n回答: ${event.answer}` +
          `${selectionsLine}${viaLine}${waiting}\n\n` +
          'この回答に沿って続きを進めよ。今後同じ判断を自分でできるよう、必要なら記憶へ残すこと。';
        // 入口の行にも印を立てる: `traceApproval` の錨で、本文の `approvalId=<id>` は64字で切られうるため、錨は構造化した欄に持たせる
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
        // `#runInternal`（常に `null`）ではなく `#runTurn` を直接呼ぶ: 会話 id を持つ承認への回答だけ人間の会話へ載せるため
        // `event.approvalId` も運ぶ: 返答が「どの承認への返答か」を、会話 id や時刻の近さでなく id で持てるようにするため
        await this.#runTurn(this.#conversationOf(event), answerPrompt, 'normal', event.approvalId);
        return;
      }

      case 'manager_message': {
        await this.#journalIncomingBody(event);

        // `report` は判定の対象外で、`'unknown'` を渡しても `managerPrompt` はその分岐を読まない
        const liveness: ConfirmationLiveness =
          (event.kind === 'question' || event.kind === 'permission') &&
          event.requestId !== undefined
            ? await confirmationLiveness(this.#managers, event.managerId, event.requestId)
            : 'unknown';
        // 台帳は kind を問わず引く: 台帳の id は `event.id` そのもので kind に依存しないため
        const settlement: ReportSettlement = await reportSettlement(
          this.#stores.commitments,
          event.id,
        );
        // `kind` を絞ってから確かめる: `closedReportNotice` は `report` だけの断り書きのため
        if (event.kind === 'report' && closedReportNotice(settlement) !== null) {
          await this.#noteRedeliveryPredicateHitA(event.managerId);
        }
        // `now` はここで1度だけ取り `managerPrompt` の中では取らない: `managerPrompt` を純関数に保ち、経過を測るテストが時刻に依存して揺れないようにするため
        await this.#runInternal(managerPrompt(event, liveness, settlement, new Date()));
        return;
      }

      case 'timer': {
        if (event.kind === DAILY_REPORT_KIND) {
          // 省略時は `schedule`: この分岐は下の journalCause の計算より前で return するので、同じ既定をここで別に持つ
          await this.#dailyReport(
            event.target ?? localDate(new Date(event.at)),
            event.cause ?? 'schedule',
          );
          return;
        }
        // 依頼の本文はいま読む: イベントに載せて運ぶと、人間が依頼を書き換えても発火時点の写しで走るため
        const claimed = await this.#claimScheduledRun(
          event.kind,
          event.at,
          event.cause === 'manual' ? 'manual' : 'schedule',
        );

        // 動かさない方を選ぶ: 1周期遅らせるだけで済むが、走らせてしまうと取り返せないため
        if (claimed.status !== 'ok' && claimed.status !== 'missing') {
          await this.#journal({
            type: 'exchange',
            with: 'self',
            role: 'outbound',
            text: `${EXCHANGE_KIND_DECISION_PREFIX}定期の依頼 ${event.kind} は、この発火では動かない: ${claimed.reason}`,
          });
          // 人間が消した（`withdrawn`）ものは再試行しない
          if (event.cause !== 'manual' && claimed.status !== 'withdrawn') {
            this.#onScheduledRunNotStarted?.(event.kind);
          }
          return;
        }

        // 日誌の側は2値に畳まず `event.cause` の3値をそのまま書く: 「なぜこの時刻に起きたか」（定刻どおりか、取りこぼしを拾ったか）を追えるようにするため
        const cause = event.cause === 'manual' ? 'manual' : 'schedule';
        const journalCause = event.cause ?? 'schedule';
        const plan = claimed.status === 'ok' ? claimed.plan : null;
        const timerDigest = await this.#recentDigest();
        // digest の全文は書かない: 材料は日誌の中に在り、形と長さがあれば組み直せるため
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
            // 走りかけていた可能性があることを隠さない: 二重に手を出さないため
            ...(plan?.pendingRun === undefined ? {} : { unfinishedAt: plan.pendingRun.at }),
            digest: timerDigest,
          }),
        );

        // 完了の記録は claim とは別に、ここで行う: ここまで来ないうちに器が落ちたら印が残って配り直される
        // 失敗で終わったターンでは `completeRun` を呼ばない: 印が消えて基準が進み、週次なら次の週まで誰も気づかないため（印を残せば次の起動の `#firstDue` と次の周期の刻みで元の発火として配り直される）
        // 枠保持の回では印を残さない: 残すと `#firstDue` と未読の両方から同じ回が届き、走っていない回に `unfinishedAt` が付くため（`clone-schedule-held-for-usage.test.ts`）
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
            // 手で起こした1回は再試行しない
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
            // 枠保持で終わった回は完了を記録する前に受信箱の行へ印を付ける: 完了を記録すると「完了して消し込みだけ失敗した回」と同じ見た目になり、再起動の配り直しが畳むため（`#heldForUsage` はメモリで再起動を越えない）。印を書けなかったら `completeRun` を呼ばない: 二重の側へ倒れ、回は失われないため
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
        const attached = await this.#resolveExternalAttachments([event]);
        await this.#journalIncomingBody(event);
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

  // 本文だけを返さない: 失敗しても `turn.text` を返すと、呼び出し側が「クローンが答えた」と「SDK がエラーを返した」を区別できないため
  // `kind` が `'distill'` のときだけ `#hasUndistilledActivity` を立て直さない: 立て直すと印が永久に下りず、`stop()` の重複防止が何もしないのと同じになるため
  async #runTurn(
    conversationId: string | null,
    text: string,
    kind: 'normal' | 'distill' = 'normal',
    approvalId: string | null = null,
    images: readonly AgentInputImage[] = [],
  ): Promise<TurnOutcome> {
    if (kind !== 'distill') this.#distillMemory.markActivity();

    // ターンはセッションを起こす前に登録する: セッションの生成が失敗したり読み取りが即死したりしても、待っているターンを必ず誰かが解放できるようにするため
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
      if (this.#inFlight !== null) this.#inFlight.started = true;
    });

    try {
      await this.#ensureQuery();
      // 並び順は `composeTurnInputText` が持ち、ここは作り方だけを持つ: 規則が違うものを同じ場所に置かないため
      // `distillGap` と `contextWindowFold` の呼び出しはここから動かさない: 呼ぶこと自体が遷移（pending を倒す）で、並びが元の `+` の連結と同じ順序を保つため。`...this.#notices.forTurn()` はこの2行より後ろに置く: 前に置くと「まだ消費していない時点の6本」を読むように見え、読む者を誤らせるため
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
      // `#ensureQuery` より後で送る: セッションの起動そのものはまだ考え始めておらず、先に送ると手が動いていないのに考えていると言うことになるため
      this.#emit(conversationId, { type: 'thinking' });
    } catch (error) {
      await this.#reportFailure(conversationId, { error });
      this.#finishTurn();
    }

    await done;

    // 失敗の印を先に見る: 本文が部分的に出ていても、失敗したターンの本文は応答ではないため
    if (turn.failure !== null) {
      return {
        status: 'failed',
        reason: turn.failure,
        // `#pump` の `finally` と同じ `#usageBlocked` を読む: 別の判定を書くと、「保持したのに呼び出し側は保持していないと思っている」がありうるため
        heldForUsage: this.#usageBlocked !== null,
      };
    }
    return { status: 'answered', text: turn.text };
  }

  // 承認回答の反映（`human_answer`）はここを通さない: 内部ターン扱いだと、元の承認の会話にチャットの生配信も履歴も出ないため
  async #runInternal(
    text: string,
    kind: 'normal' | 'distill' = 'normal',
    images: readonly AgentInputImage[] = [],
  ): Promise<TurnOutcome> {
    return this.#runTurn(null, text, kind, null, images);
  }

  // 「消された」と「読めなかった」を区別する: 前者は本文なしのターンが正しく、後者は器の瞬断で本文なしで動かす理由にならないため
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

  // 書けなければ動かない: 動いた事実が外の世界にだけ残ると、次の起動で同じ仕事をもう一度起こし、二重実行は1周期遅れるよりずっと高いため
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

  // 読みと記録を別操作にしない: 隙間に人間が消した・直した依頼が古い本文で走るため（確定はストア側の `claimRun` に閉じる）。版が入れ替わっていたら読み直す: 古い方で走らないことが最優先のため
  async #claimScheduledRun(
    kind: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<
    | { status: 'ok'; plan: ScheduledRequest }
    | { status: 'missing' }
    | { status: 'unreadable' | 'unrecordable' | 'withdrawn' | 'churning'; reason: string }
  > {
    // 最初から無いのと後から消えたのは分ける: 片方は判断させ、片方は動かさないため
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
      if (claimed.plan !== null) return { status: 'ok', plan: claimed.plan };
    }
    return {
      status: 'churning',
      reason: '読むたびに依頼が書き換わっている（人間が直している最中なので次の発火に譲る）',
    };
  }

  // `list()` が失敗しても digest を壊さず空の Map を返す: 全件 `/セッション不明` になり、黙って「繋がっている」に倒れないため
  // 2つの軸を別の `Map` にする: 1つに畳むと、`live` は取れたが握り潰しは無かった委譲と、何も取れなかった委譲が同じ「載っていない」になるため。`list()` を2回呼ばない: 軸の数だけ台帳を読むことになるため
  async #managerDigestAxes(): Promise<{
    liveness: ManagerLiveness;
    awaitingBackground: ManagerAwaitingBackgroundMap;
  }> {
    try {
      const managers = await this.#managers.list();
      return {
        liveness: new Map(managers.map((manager) => [manager.managerId, manager.live])),
        // 握り潰しが在る分だけを載せる: `Map` の側で「載っていない」と「`undefined` が載っている」が別の意味を持たないようにするため
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

  async #recentDigest(): Promise<string> {
    return `${await this.#memoryFloorDigestLine()}\n\n${await this.#recentDigestBare()}`;
  }

  // 日報は「記憶の床」の1行を付けない: tick という区切りに数を出す仕組みで、日報はその区切りではないため
  async #recentDigestBare(): Promise<string> {
    try {
      const axes = await this.#managerDigestAxes();
      return await buildActivityDigest(
        this.#stores,
        { since: new Date(Date.now() - RECENT_DIGEST_WINDOW_MS) },
        axes.liveness,
        axes.awaitingBackground,
      );
    } catch (error) {
      return `（直近の状況をまとめられなかった: ${reasonOf(error)}）`;
    }
  }

  // 前回の tick の値は永続化しない: 再起動後の最初の tick は「前回が無い」として扱うのが正しいため。測定に失敗した回は更新しない: 「前回」を直近の成功した測定に保つため
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

    // 線の判定は丸めた後の値で `>=` にする: 表示と判定を食い違わせず、読み手の語「達した」に合わせるため
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

  // ターンが失敗したときの応答を日報にしない: エラーの文言が日報として保存されるため。失敗したときは `unavailable` の印を付けた行だけを書く
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
          ).catch((error: unknown) => `（この日の記録をまとめられなかった: ${reasonOf(error)}）`);

    await this.#journal(turnInputEntry({ type: 'daily_report', date, cause, digest }));

    const outcome = await this.#runInternal(buildDailyReportPrompt({ date, digest }));

    // 枠で保持しているなら痕跡を残さず引き下がる: 印だけでも書くと、下の早期 return と `missingDailyReportDates` が「もう書いた」と判断し、本物の日報が永久に書かれないため
    if (outcome.status === 'failed' && outcome.heldForUsage) return;

    // 読めなかった回を「日報が無い」と扱わない。かといって引き下がらない: 既存確認の失敗には配り直しが無く、引き下がると本物の日報が永久に書かれないため。書いて重複の可能性を日誌に残す
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
        this.#scheduleDailyReportRetry(date);
        return;
      }
    }
    // 印の付いた行は「日報がある」と数えない: 数えると、後から本物を書き直す道が閉じるため
    if (existing.some(isWrittenDailyReport)) return;

    if (outcome.status === 'failed') {
      // 印は1日1件にする: 積むと人間が読む唯一の層が「作れなかった」で埋まるため
      if (existing.length === 0)
        await this.#journal({
          type: 'daily_report',
          date,
          // SDK の文言を言い換えない: 人間が検索できる形で残すため
          body: `（この日の日報は作れなかった。日誌から直接辿ること。理由: ${outcome.reason}）`,
          unavailable: outcome.reason,
        });
      // 印を書いて終わりにしない: 枠切れ以外の失敗は一時的なことが多く、後追いは起動時に1回しか走らないため
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

  // 判定をここに書かない: 基準は `deriveDistillGapFromJournal` が1本で持つため。蒸留のターンには載せず印も下ろさない: 内部ターンで、`stop()` 経由はこの直後にプロセスが消えるため。読めなくても空文字で進める: 断り書きが組めないことでターンを止めると穴が広がるため。印は読む前に下ろす: 日誌が壊れていると毎ターン同じ読み出しを繰り返すため
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

  // 読み直す口の名前（`conversation_read`）を書く: 書かないとクローンが次のターンで口を探すところから始めるため。「読め」とは書かない: 読み直すかどうかはクローンの判断のため
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

  // 載せ直すのは変わった文書だけ、削除は名前だけで伝える: 全文を置くと二重に文脈へ載り、消えた文書の本文を載せると「消したのに文脈には居る」状態になるため。文書の中も変わった範囲だけにする（`seenContent`）: 1回の費用が文書の大きさで決まってしまうため。`head` は「システムプロンプトの記憶はセッション構築時点の内容」と言う: 現在の内容と書くと嘘になるため。`presentInMemory` には記憶の全体を渡す: 親が今回変わっていないだけで「親が無い」と読まれるため
  async #withFreshMemory(text: string): Promise<string> {
    let documents: MemoryDocument[];
    try {
      documents = await this.#stores.persona.documents();
    } catch {
      // `#memoryOnRecord` を触らない: 触ると「載せた」ことになり、次のターンで差分が消えるため
      return text;
    }

    const { changed, removed } = this.#distillMemory.diffAgainstRecorded(documents);

    const resumeNotice = this.#distillMemory.takeResumedHistoryHasMemory()
      ? RESUMED_MEMORY_NOTICE
      : null;

    // 印は載せ直すものが無くても下ろす: 下ろさないと、何ターンも先の無関係な更新に相乗りして載るため
    const refreshIndex = this.#distillMemory.takeMemoryIndexRefreshPending();

    if (!refreshIndex && changed.length === 0 && removed.length === 0) {
      return resumeNotice === null ? text : [resumeNotice, '', '---', '', text].join('\n');
    }

    // 控えを差し替える前に退避する: 順序を逆にすると退避した `Map` が新しい内容で埋まり、差分が常に空になるため
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
      // 索引の載せ直しは `seenContent` を渡さない: 渡すと変わった範囲だけに縮み、潰された分を埋められないため
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
    // `#usageBlockedAccumulatedChars` はここ1か所でだけ積む: `#runTurn` 側で数え直すと、並び順（`composeTurnInputText`）が変わったときに二重管理になるため
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
      // 途中で畳まない: 課金枠で通るはずのターンを殺し、`#read` の `finally` が未完のターンを「セッションが終了した」失敗として報告するため。`#stopped` に相乗りしない: クローン全体の停止と混ざり、トークンを回すだけで止まるため。印を2つに分ける: トークンを回すだけで会話が切れないようにするため
      if (
        (this.#sdkSession.wantsTokenRecycle || this.#sdkSession.wantsContextWindowRecycle) &&
        this.#sdkSession.turn === null
      ) {
        // 文脈窓の畳みでは鳴らさない: 鍵と無関係で、「トークンが戻った」という嘘の合図になるため。知らせの失敗を投げさせない: 畳むことはもう決まっており、作り直しを巻き添えにしないため
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

  // `load()` には一切触れない: 大きすぎる鍵は `load()` を呼ばないことで SDK の契約（返す内容は削れない）を守るため。測れないときは日誌へ書かず resume する: 通常の起動のたびに同じ1行が積もり、DB の一時的な不調で resume できた可能性を潰すため。古い resume 素材は捨てない: 次の `init` が上書きし、書き込みを増やす必要が無いため
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

  // `#distillMemory.hasUndistilledActivity` で代用しない: プロセスを起こすたびに `true` へ戻り、確認された活動と仮定を区別できないため。読めなかったら「活動が在った」側へ倒す: 見送りの記録を落とすと、記録の欠落をこの層が新しく作るため
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
    const resume =
      storedResume === null ? null : await this.#resumeCandidateWithinBudget(storedResume);
    this.#sdkSession.beginSession(resume);
    // セッションごとに戻す: 生ログの在り処を持ち越すと別のセッションの生ログをいまの `sessionId` の名前で退避し、`#sessionAnswered` を持ち越すと暴走の止めが前のセッションの成功で解け、積んだ文字数を持ち越すと畳みの敷居の近くから始まるため
    this.#distillMemory.clearTranscriptPath();
    this.#sessionAnswered = false;
    this.#heldInSession = false;
    this.#usageBlockedAccumulatedChars = 0;
    // 前のセッションで観測した値を持ち越さない: `self_status` が前のモデル id や effort を「いまの値」として返してしまうため
    this.#forgetObservedFacts();

    const q = this.#driver.open(await this.#buildSessionSpec(resume));
    this.#sdkSession.open(q, this.#read(q));
  }

  // 読めなくてもセッションは起こし、日誌に残す: 壊れた1ファイルでクローンが起きなくなるのを避け、黙って空で起きると「登録したのに0本」が原因の出ない形で起きるため。理由の文言に値を載せない
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

  // `cwd` が無ければ展開しない: 展開先の根を勝手に決めると `prune` が見る根とずれて、掃除されない版が残るため。失敗の理由の文言は書かない: 取り元の URL や内容が混ざりうるため。一覧は前回と変わったときだけ書く: 毎セッション書くと日誌が太るだけのため
  async #plugins(): Promise<AgentClonePlugin[]> {
    if (this.#cwd === undefined) return [];
    const result = await extractPluginsForScopes({
      root: this.#cwd,
      store: this.#stores.plugins,
      scopes: PLUGIN_SCOPES_FOR_CLONE,
    });
    for (const failure of result.failures) {
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_FAILURE_PREFIX}plugin を展開できなかったので、` +
          `${failure.name === null ? 'plugin の一覧が読めず、plugin' : `plugin「${failure.name}」`}なしで` +
          `このセッションを起こした（段: ${failure.stage}）。`,
      });
    }
    const loaded = result.plugins.map((plugin) => basename(plugin.path)).sort();
    const removedSummary = summarizeRemovedForJournal(result.removed);
    const digest = JSON.stringify([loaded, removedSummary]);
    if (digest !== this.#lastPluginsDigest) {
      const hadAny = this.#lastPluginsDigest !== '';
      this.#lastPluginsDigest = loaded.length === 0 && removedSummary === null ? '' : digest;
      if (loaded.length > 0 || removedSummary !== null || hadAny) {
        await this.#journal({
          type: 'exchange',
          with: 'self',
          role: 'outbound',
          text:
            `${EXCHANGE_KIND_DECISION_PREFIX}展開した plugin: ` +
            `${loaded.length === 0 ? 'なし' : loaded.join(', ')}` +
            `${removedSummary === null ? '' : `。展開しなかったもの: ${removedSummary}`}`,
        });
      }
    }
    return result.plugins.map((plugin) => ({
      path: plugin.path,
      skipMcpDiscovery: plugin.skipMcpDiscovery,
    }));
  }

  async #buildSessionSpec(resume: string | null): Promise<AgentCloneSessionSpec> {
    const documents = await this.#stores.persona.documents();
    const memory = renderMemoryDocuments(documents);

    // 焼き込んだ内容をそのまま控える: 読み直して比べると、間に人間が直した場合に差分を見失うため
    this.#distillMemory.commitMemory(documents);
    this.#distillMemory.setResumedHistoryHasMemory(resume !== null);
    // 前のセッションで立った印を持ち越さない: 載せる必要が無い索引をもう一度会話へ積むため
    this.#distillMemory.takeMemoryIndexRefreshPending();

    const systemPrompt = buildCloneSystemPrompt({
      memory,
      ...(this.#self === undefined ? {} : { self: this.#self }),
    });
    this.#distillMemory.recordBuiltSizes(systemPrompt.length, memory.length);

    return {
      model: this.#model,
      modelPlaced: this.#modelOverridden,
      permissionMode: this.#permissionMode,
      input: this.#inputStream(),
      tools: await this.#cloneToolsFor(this.#toolContext()),
      externalMcpServers: await this.#externalMcpServers(),
      plugins: await this.#plugins(),
      systemPrompt,
      env: this.#childEnv(),
      ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
      onNote: (text) => {
        void this.#journal({
          type: 'exchange',
          with: 'self',
          role: 'outbound',
          text: `${EXCHANGE_KIND_DECISION_PREFIX}${text}`,
        });
      },
      resume,
      ...(this.#sessionStore === undefined ? {} : { sessionLog: this.#sessionStore }),
      onPreToolUse: (record) => this.#onPreToolUse(record),
      onPreCompact: (record) => this.#onPreCompact(record),
      // `PreCompact` に足さず別の枠にする: `PreCompact` はセッション生涯に対して1本のフックで、effort が載らないため
      onPostToolUse: (input) => this.#onPostToolUse(input),
      // `PostToolUse` と両方に登録する: 道具呼び出しはどちらか一方だけを発火させるので二重記録にならず、片方しか無いと失敗・中断した道具呼び出しが日誌に残らないため
      onPostToolUseFailure: (input) => this.#onPostToolUseFailure(input),
      onSubagentStop: (record) => this.#onSubagentStop(record),
    };
  }

  // セッションごとに listen し直さずデーモンの寿命で1つにする: 組み直しのたびに rmSync → mkdirSync → listen → chmodSync が走り、「listen〜chmod の窓」が毎回開くため
  async #ensureCloneToolRelayHost(): Promise<CloneToolRelayHost> {
    this.#cloneToolRelayHostPromise ??= createCloneToolRelayHost({
      socketPath: join(this.#cloneToolRelaySocketDir, CLONE_TOOL_RELAY_SOCKET_FILENAME),
    });
    return this.#cloneToolRelayHostPromise;
  }

  // 本セッションと蒸留のサイドクエリの両方がこれを通す: 片方だけ中継越しだと、ToolContext の構築点が別になる非対称が transport の軸にも生まれるため。`alwaysLoad` はどちらの分岐でも渡さない: stdio 側にだけ書くと、同じ道具なのに transport を切り替えただけで読み込みのタイミングが変わるため。`register()` の関数は呼ばれるまで `McpServer` を作らない: 子プロセスが繋がらない限り重い組み立てを避けるため
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

  #attachmentCopiesDirEntry(): { attachmentCopiesDir?: string } {
    return this.#cwd === undefined ? {} : { attachmentCopiesDir: attachmentCopiesDir(this.#cwd) };
  }

  // `#distillFromTranscript` の context とは統合しない: `emit` を実物にするとサイドクエリの出来事が人間の chat へ漏れ、`managers` を渡すと記憶へ移すだけの内部ターンがマネージャーを起こすため。`ToolContext` に口を足すときは両方の構築点へ手で足す
  #toolContext(): ToolContext {
    return {
      // 日誌だけを包む。蒸留のサイドクエリの context には包まない: 答えのターンと並行して走りうるため
      stores: {
        ...this.#stores,
        journal: stampingJournal(
          this.#stores.journal,
          () => this.#sdkSession.turn?.approvalId ?? null,
        ),
      },
      emit: (event) => this.#emit(this.#sdkSession.turn?.conversationId ?? null, event),
      flushReply: () => this.#flushReply(),
      managers: this.#managers,
      ...(this.#profileService === undefined ? {} : { profile: this.#profileService }),
      ...(this.#accountUsage === undefined ? {} : { accountUsage: this.#accountUsage }),
      ...(this.#scheduler === undefined ? {} : { scheduler: this.#scheduler }),
      runtime: () => this.#runtimeFacts(),
      runnerModels: () => collectRunnerModelLines(this.#managers),
      memoryCause: () => (this.#sdkSession.turn?.kind === 'distill' ? 'distill' : 'clone'),
      dropQueuedInboxEvents: (ids) => this.dropQueuedInboxEvents(ids),
      // `#situationNoticeFor` と同じ `#queuedInMemoryCount()` を経由する: 式を2箇所に書き写さないため
      queuedInMemory: () => this.#queuedInMemoryCount(),
      ...this.#attachmentCopiesDirEntry(),
      conversationId: () => this.#sdkSession.turn?.conversationId ?? undefined,
      recentDenials: () => this.#recentDenials.list(),
      postToConversation: (conversationId, text) => {
        this.#emit(conversationId, { type: 'text', text });
        this.#emit(conversationId, { type: 'done' });
      },
    };
  }

  #runtimeFacts(): CloneRuntimeFacts {
    return {
      // 呼ぶたびに解決する（構築時に凍らせない）: `resolveBuildRevision` は実行時の環境変数まで見るため
      revision: resolveBuildRevision(),
      buildTime: resolveBuildTime(),
      declaredModel: this.#model,
      modelOverridden: this.#modelOverridden,
      modelEnvKey: CLONE_MODEL_ENV_KEY,
      sdkModel: this.#sdkModel,
      effort: this.#effort,
      requestedEffort: null,
      claudeCodeVersion: this.#claudeCodeVersion,
      apiKeySource: this.#apiKeySource,
      permissionMode: this.#observedPermissionMode,
      requestedPermissionMode: this.#permissionMode,
      mcpServers: this.#mcpServersInfo,
      sessionId: this.#sdkSession.sdkSessionId,
      resumedFrom: this.#sdkSession.resumedFrom,
      injectedMemoryChars: heuristicChars(this.#distillMemory.promptMemoryChars),
      systemPromptChars: heuristicChars(this.#distillMemory.systemPromptChars),
      lastContextUsage: this.#lastContextUsage,
    };
  }

  // `#sdkModel`・`#effort`・`#lastContextUsage` を残さない: セッションを開き直すと SDK 側の解決結果も窓の中身も変わりうるため
  #forgetObservedFacts(): void {
    this.#sdkModel = null;
    this.#effort = null;
    this.#claudeCodeVersion = null;
    this.#apiKeySource = null;
    this.#observedPermissionMode = null;
    // `[]` ではなく `null` に戻す: 次の init が届くまでの窓で「0本」と嘘をつくため
    this.#mcpServersInfo = null;
    this.#sdkSession.setSdkSessionId(null);
    this.#lastContextUsage = null;
  }

  #captureInitFacts(facts: AgentRuntimeFacts): void {
    this.#sdkSession.setSdkSessionId(facts.sessionId);
    this.#sdkModel = facts.model;
    this.#claudeCodeVersion = facts.agentVersion;
    this.#apiKeySource = facts.apiKeySource;
    this.#observedPermissionMode = facts.permissionMode;
    this.#mcpServersInfo = facts.mcpServers;
  }

  // `deny` はしない: 一致しないコマンドは既存の確認フローへ委ねるため。`Bash` 以外は素通りにする: 確認が要る行為の一覧を作らず、対象を1本に絞るため。許可の一覧は毎回引き直す: キャッシュすると取り消しが次の呼び出しから効かなくなるため。`lastUsedAt` が書けなくても allow を覆さない: 判断は一致した事実だけで決まるため。`allow` を返した呼び出しを控える: SDK が分類器へ回して拒否することがあり、`#noteDenial` で見分けるため
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
      // 判断は写しではなく `markUsed` の結果に寄せる: `list()` の後に取り消しが完了していると、写しの上では生きていても通してはいけないため
      // 店が例外を投げたときは閉じる側へ倒さず通す: 許可の層は境界ではなく監査の層で、保証できないのは記録だけのため。その事実は跡に残す（grant の id だけ）。例外と取り消しが同時に起きた回に取り消し済みの許可が1回通りうる窓は塞がない
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

  // 自作ツール全部を除かない: 読む道具は自前では何も書かず、除くと自分で手を動かした事実が日誌から落ちるため。自前で跡を残す分だけ除く: 重ねて書くと日誌が自分の記録で埋まり、掘るための層が掘れなくなるため。迷ったら残す側（`TRACELESS_CLONE_TOOLS`）へ倒す: 誤って除くと監査の穴、誤って残しても重複で済むため
  // 除外する前に検証落ちかを見る: 入力検証が落ちるとハンドラが走らないのに普通の成功として届き、除外だけが効いて何も残らないため。例外を投げない: ツール実行の後続に影響しうるため
  async #onPostToolUse(record: AgentToolAuditRecord): Promise<void> {
    const level = record.effortLevel;
    if (typeof level === 'string') this.#effort = level;
    this.#noteTranscriptPath(record.transcriptPath);
    // 決着したので忘れる: `PreToolUse` は実行より前にしか発火せず、成功で終わった呼び出しに後から拒否が届くことはないため
    if (typeof record.toolUseId === 'string') this.#allowedByGrantToolUses.delete(record.toolUseId);

    await this.#journalToolUse(record, CLONE_ACTOR_ID);
  }

  // effort はここでは拾わない: 別セッションの値を本セッションの観測として持つと嘘になるため
  async #onDistillToolUse(record: AgentToolAuditRecord): Promise<void> {
    await this.#journalToolUse(record, CLONE_DISTILL_ACTOR_ID);
  }

  async #journalToolUse(
    raw: AgentToolAuditRecord | null | undefined,
    mainThreadActor: string,
  ): Promise<void> {
    // `tool_name` が読めなくても落とさず `(不明な道具)` で残す: 黙って消すと監査の穴がいちばん静かな形で空くため
    const tool = typeof raw?.toolName === 'string' ? raw.toolName : UNKNOWN_TOOL_NAME;
    if (cloneToolJournalsItself(tool)) {
      // 除外する前に検証落ちかを見る: ハンドラが走らない回は、除外だけが効いて日誌にも何も残らないため
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

  // 本セッションの actor の行だけに返す: 蒸留のサイドクエリは答えのターンと並行して走りうり、`#turn` を読むと無関係な行へ印が付くため
  #answeredApprovalFor(mainThreadActor: string): string | null {
    return mainThreadActor === CLONE_ACTOR_ID ? (this.#sdkSession.turn?.approvalId ?? null) : null;
  }

  // `cloneToolCarriesSecrets` の道具は `input` を残さず、落ちた欄の名前だけを `error` に残す: 値が実行環境の鍵・トークンそのもので、日誌に焼かれると回収できないため。`self_dropped` は `journal_write` だけに残す: 他の自作ツールはここで初めて記録の代わりが生まれる側で、二重に名乗る理由が無いため
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

  // `effort` と `transcript_path` もここで拾う: `#onPostToolUse` と排他で、拾わないと次に成功する呼び出しまで古いまま取り残されるため
  async #onPostToolUseFailure(record: AgentToolAuditFailureRecord): Promise<void> {
    const level = record.effortLevel;
    if (typeof level === 'string') this.#effort = level;
    this.#noteTranscriptPath(record.transcriptPath);
    if (typeof record.toolUseId === 'string') this.#allowedByGrantToolUses.delete(record.toolUseId);

    await this.#journalToolUseFailure(record, CLONE_ACTOR_ID);
  }

  // effort はここでは拾わない: 別セッションの値を本セッションの観測として持つと嘘になるため
  async #onDistillToolUseFailure(record: AgentToolAuditFailureRecord): Promise<void> {
    await this.#journalToolUseFailure(record, CLONE_DISTILL_ACTOR_ID);
  }

  // `exchange` ではなく `tool_use` に落とす: 拒否は一度も走っていないが、失敗は走った結果で副作用が在りうり、「自分で手を動かした回数」に数えるべきため。`outcome` で成功と区別する。自作ツールの失敗も成功と同じ規則で除く: 道具ごとに「成功は除く／失敗は残す」の非対称を持ち込むと、読む側が毎回どちらの規則かを確かめることになるため
  async #journalToolUseFailure(
    raw: AgentToolAuditFailureRecord | null | undefined,
    mainThreadActor: string,
  ): Promise<void> {
    const tool = typeof raw?.toolName === 'string' ? raw.toolName : UNKNOWN_TOOL_NAME;
    if (cloneToolJournalsItself(tool)) return;
    await this.#journal(
      stampAnsweredApproval(
        {
          type: 'tool_use',
          actor: cloneToolActor(raw, mainThreadActor),
          tool,
          input: raw?.toolInput,
          // `isInterrupt` の欠けを第3の値にせず failed に倒す: 欠けは「中断ではないと確定している」ではないが、安全側に倒すため
          outcome: raw?.isInterrupt === true ? 'interrupted' : 'failed',
          // `error` が文字列でなければ欄ごと省く: 作り物の文言で埋めないため
          ...(typeof raw?.error === 'string'
            ? // 道具の出力を運びうるので、伏せてから切る（#2493）。
              { error: excerptLine(redactErrorText(raw.error, this.#env), TOOL_USE_ERROR_EXCERPT) }
            : {}),
        },
        this.#answeredApprovalFor(mainThreadActor),
      ),
    );
  }

  // `tool_use` として記録しない: 拒否は「道具を使った」ではなく、混ぜると「自分で手を動かした回数」が使えていない回数まで数えるため。両方の経路から呼ばれるので `tool_use_id` で二重書きを防ぐ
  async #noteDenial(denial: AgentPermissionDenial, via: 'live' | 'result'): Promise<void> {
    const tool = denial.tool ?? UNKNOWN_TOOL_NAME;

    // SDK が付けてきた `tool_use_id` で引く: 下の `toolUseId` は代用値で、それで引くと無関係な一致が起きうるため。消費してから消す: 同じ拒否が2経路から届いても検出を1回にするため
    if (typeof denial.toolUseId === 'string') {
      const funneled = this.#allowedByGrantToolUses.get(denial.toolUseId);
      if (funneled !== undefined) {
        this.#allowedByGrantToolUses.delete(denial.toolUseId);
        await this.#noteGrantFunneled(funneled, denial, via);
      }
    }

    // id が無ければ道具の名前で代用する: 取りこぼすより重複を許すため
    const toolUseId = denial.toolUseId ?? `${tool}:${via}`;
    // 既に書いてある1件でも、入力を持つ記録が後から来たら形だけ足す: 入力を持つのは `via: 'result'` だけで、`has` で弾くと「何を実行しようとしたか」が1件も残らないため
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

    // 欠けているものは作り物を出さず行を省く
    const denialDetails = [
      denial.reasonType === undefined ? undefined : `分類: ${denial.reasonType}`,
      denial.reason === undefined ? undefined : `理由: ${denial.reason}`,
      denial.message === undefined ? undefined : `モデルへの拒否文: ${denial.message}`,
    ].filter((line): line is string => line !== undefined);
    const why = denialDetails.length > 0 ? `（${denialDetails.join(' / ')}）` : '';

    // 層は `agent_id` で見る: 分けないと「クローン自身の手が止まっている」と「作業者の手が止まっている」が同じ一文に潰れるため。`via: 'result'` は `agent_id` を持たないので「クローン本体」と決めつけず「どちらの層か不明」のまま出す。`agent_type` は作り物の型名を出さない
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
        // 入力は形だけ残す: 本文は書けない（道具の入力には鍵が入りうる）が、無いと誤検知と止められるべきだった呼び出しを分けられないため
        `入力の形: ${denialInputShape(denial.input) ?? denialInputAbsence(via)}。` +
        `許可モードは ${this.#permissionMode} で、この層に確認を回す相手は居ない。`,
    });
  }

  // 原因は断定しない: 機能フラグによる分類器行きか deny 規則の上書きかを、alteroid のコードからは切り分けられないため。事実は毎回書き、注意書きは grant ごとに初回だけにする: 同じ知らせで日誌を埋めないため。コマンド本文は読まない: `#noteDenial` が形だけに畳んだ行に任せるため
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

  // `agentId` が読めなければ何もしない: 旧い provider の写しは安全側に倒し、他の作業者や本体の控えには触れないため。「追い越された」とは書かず「決着しなかった」とだけ言う: 実際の拒否を受け取っておらず、不在の事実しか無いため。注意書きは `#grantFunneledWarnedOnce` を共有する: 両方の検出経路が交互に鳴っても1度で足りるため
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

  // 記憶ストアの鍵は落とさない: 記憶の持ち主であるクローン自身から取り上げるとデグレードになるため（例外は `#withheldEnvKeys`: ログイン基盤の鍵で、記憶の読み書きには使わない）
  #childEnv(): NodeJS.ProcessEnv {
    // 鍵は呼ばれるたびに読み直す: `this.#childEnvBase` は構築時のスナップショットで、後から差し替えた鍵が永久に届かなくなるため
    // 重ね順は runner.ts と揃える（`env` → 正本 → 鍵 → プロファイル）: 層ごとに順序が違うと「マネージャーには回るのにクローンには回らない」が生まれるため。正本の重ねはプールの重ねより手前に置く: Anthropic のプールの行を後勝ちのまま動かさないため
    // セッションが起きるこの瞬間の身元を捕まえる: ここ以外で読み直すと世代の照合が素通しになるため
    this.#sdkSession.captureSessionTokenIdentity(this.#tokenIdentity?.());
    const env: NodeJS.ProcessEnv = {
      ...this.#childEnvBase,
      ...this.#vaultCredentialOverlay(),
      ...(this.#credentials?.() ?? {}),
      ...(this.#profile?.env() ?? {}),
    };
    // 伏せるのは最後にする: 正本やプロファイルが同じ名前を重ねてきても生き残らせないため。`this.#env` 自体は動かさない: daemon 本体が OAuth の交換にこの鍵を使い続けるため
    for (const key of this.#withheldEnvKeys) delete env[key];
    return env;
  }

  // 非同期の読み出しを `await` せず同期の写し（`vaultSnapshot()`）を経由する: `#childEnv()` が同期のため。マネージャー側と同じ1本の解決（`resolveCredentialRows`）を通す
  #vaultCredentialOverlay(): Record<string, string> {
    const rows = this.#credentialService?.vaultSnapshot() ?? [];
    const resolved = resolveCredentialRows(rows, 'clone');
    return Object.fromEntries(resolved.map((row) => [row.name, row.value]));
  }

  // 投げ直さない: 回せなかったことは枠に当たったこととは別の失敗で、投げ直すと人間には「上限に当たった」ではなく「回し手が落ちた」だけが届くため
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
      noteDroppedRecord('認証トークンの切替', 'clone', error);
    }
  }

  async #onPreCompact(record: AgentPreCompactRecord): Promise<void> {
    const { sessionId, transcriptPath, signal } = record;

    // いちばん先に印を立てる: compaction はこのフックが何を返しても起きるので、退避や蒸留が落ちても索引の載せ直しは行われなければならないため
    this.#distillMemory.armMemoryIndexRefresh();

    if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
      return;
    }

    // 退避と蒸留を別の `try` に割る: 生ログが伸びて `readFile` が `ERR_STRING_TOO_LONG` で落ちると、蒸留も一緒に止まるため。蒸留は生存条件で、移し損ねたものは compaction のたびに失われる
    try {
      // 全文を1本の文字列にするのはここだけにする
      const transcript = await readFile(transcriptPath, 'utf8');
      const write = await this.#stores.archive.archive(sessionId ?? 'clone', transcript);
      // diverged / unknown のときだけ日誌へ記録する: `continues` はノイズにしかならないため
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

    // 中断の合図は蒸留にだけ掛ける: 退避は中断で飛ばさないため
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

  async #distillFromTranscript(transcriptTail: string): Promise<void> {
    // 蒸留を持たない駆動役では投げる: 黙って返すと、蒸留していないのに成功として扱われるため
    const driver = this.#driver;
    const distill = driver.distill?.bind(driver);
    if (distill === undefined) {
      throw new Error(`この駆動役（${driver.providerId}）は蒸留のサイドクエリを持たない`);
    }
    // 載せ直しの控え（`#memoryOnRecord`）は触らない: 触ると本セッションの差分が消えるため
    const memory = renderMemoryDocuments(await this.#stores.persona.documents());

    await this.#journal(turnInputEntry({ type: 'pre_compact_distill', transcriptTail }));

    const prompt = [
      buildDistillPrompt('pre_compact'),
      '',
      '以下は、要約に潰される直前の会話の生ログ（末尾）である。',
      '',
      transcriptTail,
    ].join('\n');

    // 本セッションと同じ人間の連携を渡す: 片方だけに見えると、人格の書き手だけが別の手を持つため
    const externalMcpServers = await this.#externalMcpServers();
    const plugins = await this.#plugins();
    const side = distill({
      prompt,
      model: this.#model,
      permissionMode: this.#permissionMode,
      // 蒸留のターンでも同じ道具・同じ観測値を渡す: 欠けると、会話の最後に「鍵を実行環境へ移す」が失敗し、蒸留のターンだけ自分のことが分からないクローンになるため
      tools: await this.#cloneToolsFor({
        stores: this.#stores,
        emit: () => undefined,
        ...(this.#profileService === undefined ? {} : { profile: this.#profileService }),
        ...(this.#accountUsage === undefined ? {} : { accountUsage: this.#accountUsage }),
        ...(this.#scheduler === undefined ? {} : { scheduler: this.#scheduler }),
        runtime: () => this.#runtimeFacts(),
        // 削らない: 既定の `'clone'` に落ち、蒸留が書いた記憶なのに `cause: 'clone'` と名乗るため
        memoryCause: () => 'distill',
        // 渡さない側を選ばない: 蒸留のターンだけ消せないという層ごとの能力差になるため
        dropQueuedInboxEvents: (ids) => this.dropQueuedInboxEvents(ids),
        queuedInMemory: () => this.#queuedInMemoryCount(),
        ...this.#attachmentCopiesDirEntry(),
        // 省略しない: `ToolContext.conversationId` が必須で、省略すると `createCloneTools` が throw するため
        conversationId: () => undefined,
        recentDenials: () => this.#recentDenials.list(),
      }),
      externalMcpServers,
      plugins,
      systemPrompt: buildCloneSystemPrompt({
        memory,
        ...(this.#self === undefined ? {} : { self: this.#self }),
      }),
      env: this.#childEnv(),
      ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
      onPostToolUse: (input) => this.#onDistillToolUse(input),
      // 蒸留は `memory_write` を叩く経路: 失敗を記録しないと「記憶が書かれなかった」が静かに落ちるため
      onPostToolUseFailure: (input) => this.#onDistillToolUseFailure(input),
    });

    for await (const ended of side) {
      // `#apply` は通さない: こちらは `site`（`distill`）も累積の数え方（`oneshot`）も本セッションと違い、同じ反応をさせてはいけないため
      if (ended.type !== 'turn_ended') continue;
      // このサイドクエリの `result` を読み捨てない: 「要約のたびに払っている蒸留の費用」の唯一の観測点のため。別の `query()` 呼び出しなので
      // 累積は1回で閉じており（SDK: 「during this query() call」）[sdk-verbatim SDKResultSuccess.modelUsage]、基準を持たせない。「要約そのものの費用」とは名乗らない: 本セッションの `modelUsage` に合算されて分離できないため
      await this.#recordUsage(ended.usage, 'distill', 'oneshot');
      // この経路の成功も日誌へ残す: 受信箱を通らない別経路で、残さないと「要約の直前に蒸留して器が入れ替わった」回が「1度も蒸留していない」と読まれるため
      if (ended.succeeded) await this.#journal(distillSucceededEntry('pre_compact'));
      break;
    }
  }

  // `this.#query` が無ければ何も聞かず `undefined` を返す: 「試して失敗した」ではなく「まだ観測していない」の側のため。理由は `describeProbeError` でしか運ばない: 秘密を漏らさないため
  async #observeContextUsage(): Promise<ContextUsageObservation | undefined> {
    const q = this.#sdkSession.query;
    if (q === null) return undefined;
    // 文脈の使用状況を出せない駆動役は、最初の1回だけ「取れない」と残し以後は聞かない: 毎ターン同じ error 付きの行を積まないため
    if (this.#driver.providesContextUsage === false) {
      if (this.#contextUsageUnavailableNoted) return undefined;
      this.#contextUsageUnavailableNoted = true;
    }
    const startedAt = Date.now();
    try {
      const usage = await q.contextUsage();
      // 内訳は取り出しても費用が同じなので写す。分類は `kind` の値だけで行い、`name` の文字列は見ない
      const categories = (usage.categories ?? []).map((category) => ({
        name: category.name,
        tokens: category.tokens,
        kind: category.kind,
      }));
      const shownCategories = categories.slice(0, CONTEXT_USAGE_CATEGORY_LIMIT);
      const omittedCategories = categories.length - shownCategories.length;
      // 配列は合計へ畳む: 1本ずつ写すと日誌の1行が道具の数だけ伸びるため
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
        // 空の配列のときは欄そのものを作らない: 0 を置くと「測ったが 0 だった」と読めるが、SDK がその欄を返さなかっただけのことがあるため
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

  // `this.#query?.close()` / `this.#query = null` より先に呼ぶ: 閉じた後の control channel からは何も取れないため。`turnBoundary` は渡さない: ターンの境界ではなく、文脈占有も compaction も持たないため
  async #flushSessionUsage(): Promise<void> {
    const session = this.#sdkSession.query;
    const models = await (session === null ? undefined : session.sessionModelUsage());
    if (models === undefined) return;
    await this.#recordUsage({ models }, 'session', 'cumulative');
  }

  // モデル id で層を代用しない: `ALTEROID_CLONE_MODEL` を置けばクローンもマネージャーと同じ opus で走り、台帳では同じ `model` に並ぶため。台帳に積めなくてもターンは止めないが、黙って消さない
  async #recordUsage(
    usage: AgentTurnUsage | undefined,
    site: UsageSite,
    accumulation: 'cumulative' | 'oneshot',
    // 蒸留のサイドクエリからは渡さない: 本セッションの `#turn` も `#query` も指さず、文脈占有も compaction も原理的に持たないため
    turnBoundary?: {
      contextUsage?: ContextUsageObservation;
      compactions?: CompactionObservation[];
    },
  ): Promise<void> {
    if (usage === undefined) {
      // 条件は `usage === undefined` ではなく `capabilities.usage === false`: Claude の失敗した result も usage を持たないが、無報告ではないため
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
        // セッションが起きた瞬間の身元を使う: `#tokenIdentity?.()` を読み直すと、回した直後に届いた前のセッションぶんの消費が新しいトークンに付くため
        ...(this.#sdkSession.sessionTokenIdentity === undefined
          ? {}
          : { tokenId: this.#sdkSession.sessionTokenIdentity.tokenId }),
      });

      // 増分が空の回は行を書かない: 取れない軸に0の行を作らないため
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

      // 数え直しを黙って通さない: 記録が無いと後から「なぜ集計が飛んでいるか」を誰も辿れないため
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
      // stderr にも日誌にも残す: 日誌への追記が失敗しても「台帳が落ちた」という名指しは stderr に残り、日誌に無いことが「起きなかった」と読まれないため。`#journal` は投げないので循環しない
      noteDroppedRecord('利用状況の台帳', `layer=clone site=${site}`, error);

      // 文言はマネージャー層と揃え、複数性の代わりに `site` をタグとして前置する: 層ごとに言い方を変えると読む側が層ごとに文言を覚えることになるため
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_FAILURE_PREFIX}[site=${site}] 消費を台帳へ記録できなかった（この分は集計に出ない）`,
      });
    }
  }

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
        // 捨てる前に墓標を立てる: 捨てた後だと、立てる前にプロセスが死んだ回で id がどこにも残らないため
        await this.#noteLostSession(this.#sdkSession.resumedFrom);
        // 捨て損ねても投げず、跡は残す: 投げると失敗の報告そのものが失敗するため
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
        // `#query` を捨てる前に累積を1回読む: 捨ててから読んでも何も取れないため
        await this.#flushSessionUsage();
        this.#sdkSession.clearQuery();
        // 控えを空にする: 前のセッションで見せた分を「もう見せた」と数えたまま新しいシステムプロンプトを組むと、控えの出所が2か所になるため
        this.#distillMemory.forgetMemory();
        // `this.#query = null` より後に置く: `#read` は待たれずに走っているので、退避と蒸留を先に待つと `#query` が古いまま残り、次のターンが畳んだはずのセッションへ入るため。印を先に下ろす: 下ろさずに `await` すると、その間に届いた失敗がもう一度畳もうとするため
        if (this.#sdkSession.takeContextWindowRecycle()) {
          await this.#salvageTranscript();
        }
      }
    }
  }

  // マネージャー層の `#apply` と共通化しない: 反応が層ごとに違い、副作用は2層で15種あって重なるのは2種だけのため
  async #apply(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'session_started': {
        this.#sdkSession.markSawInit();
        // 控え損ねても投げず、跡は残す: セッションを殺さず、かつ次の起動で resume を諦める経路が「素材が無かった」正常な経路と見分けられなくなるため
        await this.#stores.sessions.setCloneSessionId(event.sessionId).catch((error: unknown) => {
          noteCloneSessionIdNotRecorded(error);
        });
        this.#captureInitFacts(event.runtime);
        return;
      }

      case 'permission_denied': {
        // 捨てない: クローンの手が止められたことが日誌に出ないと、「静かになった」と「起きていない」が区別できなくなるため
        await this.#noteDenial(event.denial, 'live');
        return;
      }

      case 'usage_notice': {
        await this.#noteUsageNotice(
          event.notice,
          this.#sdkSession.turn?.conversationId ?? null,
          'text',
        );
        return;
      }

      case 'rate_limit': {
        const facts = event.facts;
        // 状態ではなく遷移を渡す: 状態をそのまま流すと同じ `rejected` で毎ターン回そうとするため。覚えるのは重ねた形（`mergeRateLimitFacts`）: 届いた1件で置き換えると、`status` を運ばない観測が「もう知らせた」という記憶を消すため
        // 覚える欄は「トークンの身元 × 枠の種類」で分け、身元はセッションを起こした瞬間のものを使い `#tokenIdentity?.()` を読み直さない: 別々のアカウントの事実が同じ欄を踏み合い、回った直後に届いた前の鍵の観測が新しい鍵の欄へ入るため
        const kind = facts.kind ?? '';
        const memoryKey = rateLimitMemoryKey(this.#sdkSession.sessionTokenIdentity?.tokenId, kind);
        const previous = this.#rateLimits.get(memoryKey);
        const transition = usageTransitionOf(previous, facts);
        const merged = mergeRateLimitFacts(previous, facts);
        this.#rateLimits.set(memoryKey, merged);

        // 畳むたびには書かず、次に `transition` が定まった回にまとめて吐き出す: 日誌の肥大化を作り直さないため
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
          this.#rateLimitCrossFold.set(memoryKey, {
            lastConversationId: conversationId,
            folded: new Set(),
          });
        }

        // 遷移が取れなかった回も `rejected` なら渡す: 同じ鍵で `rejected` が続いているあいだは遷移が立たず、回し手の契機を門の後ろでは拾えないため
        // `statusNow` は重ねる前の生の1件から取る: 重ねた形の `status` はアカウントを跨いで残り、回した直後の健全な鍵でもう一度回るため
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

        // SDK が応答ではないと印を付けたメッセージは応答として扱わない: 支出上限などの文言がそのままクローンの応答や日報の本文になるため。本文は捨てず `turn.rejected` へ置き、`text` としては流さない: 「返答が来た」と見えてしまうため
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

      // `tool_result` を含むときだけにする: 人間の発言のエコーや replay を「考え始めた」と読み違えないため
      case 'tool_result': {
        this.#emit(this.#sdkSession.turn?.conversationId ?? null, { type: 'thinking' });
        return;
      }

      case 'compaction': {
        // ターンの外で届いた分は静かに捨てる: 対応する `turn_usage` の行が無く、持ち帰る先が無いため
        this.#sdkSession.turn?.compactions.push({
          trigger: event.trigger,
          preTokens: event.preTokens,
          ...(event.postTokens === undefined ? {} : { postTokens: event.postTokens }),
        });
        return;
      }

      case 'turn_ended': {
        const contextUsage = await this.#observeContextUsage();
        // `undefined`（まだ観測していない）は `null` へ寄せる: 未観測 `null` / 試して失敗 `error` 付き / 観測できた値の3値を `CloneRuntimeFacts.lastContextUsage` 側でも同じ形のまま保つため
        this.#lastContextUsage = contextUsage ?? null;

        // 消費の行（`turn_usage`）とは独立に、観測できたら必ず日誌へ書く: `#recordUsage` は `usage === undefined`（失敗したターン）で早期 return するため、相乗りさせると失敗したターンの文脈占有がどこにも残らないが、観測そのものが `undefined` の回は書かない
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

        // 成否・消費の増分の有無に関わらず毎回呼ぶ: そうしないと `journal_read` で辿れる推移に穴が空くため
        await this.#writeInboxFlow();

        const compactions = this.#sdkSession.turn?.compactions ?? [];

        await this.#recordUsage(event.usage, 'session', 'cumulative', {
          contextUsage,
          compactions,
        });

        // 成否で絞らない: 拒否は成功したターンにも失敗したターンにも載るため。生の合図は best-effort で、`result` の方が authoritative なので両方読む
        for (const denial of event.denials) {
          await this.#noteDenial(denial, 'result');
        }

        const turn = this.#sdkSession.turn;
        const failure = event.failure ?? turn?.rejected ?? undefined;

        // 内部ターン（蒸留・自律）も必ず残す: 見えない層を作らないため
        if (turn) await this.#journalReply(turn, failure !== undefined);

        // 成否を見て分ける: 見ないと、`error_during_execution` や支出上限でターンが死んでも `done` が出て、どこにも記録が残らないため。判定は `isSuccessResult` ではなく `isAnsweredResult`: `subtype: 'success'` かつ `is_error: true` を成功として通してしまうため。`turn.rejected` も見る: `assistant.error` が付いたターンは `result` が成功でも応答として扱わないため
        if (failure !== undefined) {
          // 分類にかけるのは SDK が失敗として出した文言だけにする: `classifyUsageNotice` は部分一致なので、クローンが書いた本文（`turn.text`）を通すと「上限に当たったと日報に書いた瞬間に上限と誤判定する」自家中毒になるため。この `await` は `#reportFailure` より先に終える: `usage_limited` は終端ではなく、終端の `error` より先に届かなければならないため
          for (const candidate of [failure.text, event.body, ...event.errorLines]) {
            const notice = classifyUsageNotice(candidate);
            if (notice !== undefined) {
              await this.#noteUsageNotice(notice, turn?.conversationId ?? null, 'text');
              break;
            }
          }
          // 失敗した result では `done` を出さない: `#reportFailure` の `error` を終端にし、成功したことにしないため
          await this.#reportFailure(
            turn?.conversationId ?? null,
            failureReason(failure, event),
            // 種別は言い切れるほうの印を採る: `result` が状態番号を持たず `assistant.error` だけが `rate_limit` と言う回を `other` に落とさないため
            [event.failure, turn?.rejected].find(
              (candidate) => turnFailureKindOf(candidate ?? undefined) !== 'other',
            ) ?? failure,
          );
          // 失敗側でも必ず畳む: `#runTurn` は `turn.resolve()` だけを待ち、呼ばないと `#pump` の `for await` が次の合図へ進めず受信箱ごと止まるため
          this.#finishTurn();
          return;
        }

        // 成功した result は「枠が開いている」ことの権威ある証拠なので、ここで保持のスイッチを降ろす: `rate_limit_event.status` は枠1つぶんの状態で、`five_hour` が `rejected` でも課金枠に落ちてターンが成功するのは通常の遷移のため。降ろさないと `#pump` の `finally` が `defer: true` にして、答えが返って終わった合図がもう一度処理される。`#notices` は降ろさない: 同じ文言を二度書かないためのもので、別の関心のため
        this.#usageBlocked = null;
        // 抑止した再武装・畳んだ内部の失敗記録は区間を跨いで持ち越さない: 次の枠当たりへ古い件数を持ち越さないため
        this.#usageBlockSuppressedRearms = 0;
        this.#usageBlockFoldedInternalFailures = 0;
        await this.#observeForTokenRotation({ succeeded: true });
        // `#usageBlocked` では代用できない: 初期値も `null` で「まだ成功していない」と区別できないため
        this.#sessionAnswered = true;
        this.#heldEscalationStreak = 0;
        // 降ろさないと、次に `reached` に当たったときに前回までの積算から数え直し、実際より早く畳むため
        this.#usageBlockedAccumulatedChars = 0;
        this.#emit(turn?.conversationId ?? null, { type: 'done' });
        this.#finishTurn();
        return;
      }

      // この層は見ないと決めてある: 委譲の区間と背景処理を数えるのはマネージャー層で、クローンのターンは人間が読む前提の別の面のため
      case 'delegation_started':
      case 'delegation_notified':
      case 'background_tasks':
        return;

      // 既定で無視へ倒さない: provider が名乗り始めた事実が黙って網の外へ出るため
      default: {
        const unread: never = event;
        void unread;
        return;
      }
    }
  }

  // `pending()` が読めなければ窓は書かずカウンタも戻さない: 次のターンへ持ち越せば到着・配達・消し込みを失わずに済むため。追記の成否を問わず窓を空にする: `#journal` の失敗は既に跡が残り、再送の仕組みは持たないため
  async #writeInboxFlow(): Promise<void> {
    let pending: { count: number; oldestAt?: string };
    try {
      pending = await this.#stores.inbox.pending();
    } catch (error) {
      noteDroppedRecord('受信箱の流量（inbox_flow）', '', error);
      return;
    }

    // `#journal` を待つ前にカウンタを読む: 待つ間に届いた bump をスナップショットに入れないため
    const flow = this.#inboxFlow.snapshot();
    await this.#journal({
      type: 'inbox_flow',
      windowStartedAt: flow.windowStartedAt,
      arrived: flow.arrived,
      delivered: flow.delivered,
      settled: flow.settled,
      pending,
      retained: {
        unread: this.#delivery.unreadSize,
        redelivered: this.#delivery.redeliveryState.redeliveredSize,
        redeliveredClosed: this.#delivery.redeliveryState.redeliveredClosedSize,
        pendingCollapse: this.#delivery.collapseSize,
      },
    });

    this.#inboxFlow.reset();
  }

  // `type: 'exchange'` の書き込みはここ1か所だけにする: `exchange-kind-coverage.test.ts` の数え方を崩さず、2つの経路で付ける欄を食い違わせないため。割れた各行に同じ欄を付ける: `approval-trace` が `answeredApprovalId` で対にするため
  async #journalReply(turn: Turn, failed: boolean): Promise<void> {
    const pending = turn.reply.slice(turn.replyWritten);
    if (pending.trim().length === 0) return;
    // await の前に印を進める: 割る口が並行して呼ばれても同じ本文を2度書かないため
    turn.replyWritten = turn.reply.length;
    await this.#journal({
      type: 'exchange',
      with: turn.conversationId === null ? 'self' : 'human',
      role: 'outbound',
      // kind の接頭辞は self 側にだけ付ける: human 側は本文を人間が画面で見ているものと1文字も変えないため。失敗したターンの本文は捨てず印を付ける: 無印だと日誌が digest を通って「クローンがそう言った」として翌日の日報に効くため
      text:
        (turn.conversationId === null ? EXCHANGE_KIND_REPLY_PREFIX : '') +
        (failed
          ? `（このターンは失敗して終わった。以下は失敗する前に出ていた本文である）\n${pending}`
          : pending),
      ...(turn.conversationId === null ? {} : { conversationId: turn.conversationId }),
      // `conversationId` が無い行には `approvalId` を立てない: 内部ターンが人間の会話の一部であるかのように読めてしまうため
      ...(turn.conversationId === null || turn.approvalId === null
        ? {}
        : { approvalId: turn.approvalId }),
      ...(turn.approvalId === null ? {} : { answeredApprovalId: turn.approvalId }),
    });
  }

  // 会話のあるターンだけ割る: 内部ターンの承認は会話の履歴に出ず、割っても並びは変わらず行が増えるだけのため
  async #flushReply(): Promise<void> {
    const turn = this.#sdkSession.turn;
    if (turn === null || turn.conversationId === null) return;
    await this.#journalReply(turn, false);
  }

  async #journal(entry: JournalEntryInput): Promise<void> {
    try {
      await this.#stores.journal.append(entry);
    } catch (error) {
      // 黙って消さない: 跡が無いと「日誌に無い」が「起きなかった」と読め、日誌を判別器に使った切り分けが静かに嘘をつくため。ここから `#journal` を呼び直さない: 日誌への書き込みが失敗した直後に日誌へ書き直すのは循環のため
      noteDroppedRecord('日誌', journalEntryShape(entry), error);
    }
  }

  #finishTurn(): void {
    // ターンの終わりでも途中経過を捨てる: `error` / `done` を出さずに終わる経路が増えても、会話を開き直した人間に終わったターンの途中経過が「進行中」として流れ続けないための二重の網。畳む前に会話 id を読む: 畳んだ後は `turn` が無いため
    const conversationId = this.#sdkSession.turn?.conversationId ?? null;
    this.#sdkSession.finishTurn();
    if (conversationId !== null) this.#progress.clear(conversationId);
  }

  #emit(conversationId: string | null, event: ChatStreamEvent): void {
    if (conversationId === null) return;
    // 記録は購読者への配送より先に同じ同期区間で行う: `attach` の継ぎ目の保証のため
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

export type HumanMessage = Extract<InboxEvent, { type: 'human_message' }>;

function isHumanMessage(event: InboxEvent): event is HumanMessage {
  return event.type === 'human_message';
}

// `Extract` ではなく交差型にする: `kind` は単一の enum で、`Extract` は共用体のメンバー単位でしか絞れず効かないため
type ManagerReportMessage = Extract<InboxEvent, { type: 'manager_message' }> & { kind: 'report' };

function isManagerReport(event: InboxEvent): event is ManagerReportMessage {
  return event.type === 'manager_message' && event.kind === 'report';
}

export type ExternalEvent = Extract<InboxEvent, { type: 'external' }>;

function isExternalEvent(event: InboxEvent): event is ExternalEvent {
  return event.type === 'external';
}

// 1件なら本文そのままにする: 断り書きを足すと普通の一往復のたびに読ませるものが増えるため。複数件は要約も間引きもしない。時刻を各件に添える: 「3分空けて言い直した」と「続けて3行打った」は別の出来事で、どう読むかは本文だけが持っているため。「N件が届いた」ではなく「N件をまとめて渡す」と書く: 束は上限で切られることがあり、前者は偽になるため。pure/sync のまま保つ: 編集前の本文は呼び出し側が `priorTexts` として解決済みで渡す
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

// `priorText` が引けなくても編集である事実は伝える: 本文が引けないことと編集だと分からないことは別の欠落のため。副作用の巻き戻しは指示しない: プロンプト側から存在しないロジックを作ることになるため
function editedTurnBody(event: HumanMessage, priorText: string | undefined): string {
  if (event.supersedes === undefined) return event.text;
  const notice =
    priorText === undefined
      ? `[system] これは既出発言（id=${event.supersedes}）の編集である。` +
        '（編集前の本文は引けなかった。）'
      : `[system] これは既出発言（id=${event.supersedes}）の編集である。編集前の本文:\n\n${priorText}`;
  return event.text === '' ? notice : `${notice}\n\n---\n\n${event.text}`;
}

// 2値にしない: 判定できない場合がどちらかへ黙って倒れるため。`'unknown'` は安全側（雑音）へ倒すためのもので、「待っている」の言い換えではない
type ConfirmationLiveness = 'live' | 'settled' | 'unknown';

// 2値にしない: 判定できない場合がどちらかへ黙って倒れるため。`'unknown'` は安全側＝雑音側（ふつうに全文を出す）へ倒すためのもので、`'open'` の言い換えではない。`'open'` は「まだ読んでいない」を意味しない: 保証するのは「閉じたものには印が付く」までのため
type ReportSettlement =
  { kind: 'closed'; closedReason?: string } | { kind: 'open' } | { kind: 'unknown' };

// 日誌へ書く行の先頭にだけ置く: `composeTurnInputText` を経由してモデルへ渡る文字列に混ぜず、配り方を変えないため。片付け済みの配り直しは `#foldClosedRedelivery` が書く行があるので数え直さない
export const REDELIVERY_COUNT_PREFIX_A = '【数える:A】';
export const REDELIVERY_COUNT_PREFIX_B = '【数える:B】';

// 全文ではなく先頭だけにする: 判断を読み直させるのではなく、どういう判断で閉じたかを思い出させるのが目的のため
const CLOSED_REASON_EXCERPT = 120;

// 配り直しかどうかを見ない: `Clone#post()` は受信箱へ積む前に台帳へ積むので、台帳で閉じた後に来る「初回配達」は配り直しの機構では捕まえられず、「台帳で既に閉じているか」だけを見るため
async function reportSettlement(
  commitments: Stores['commitments'],
  id: string,
): Promise<ReportSettlement> {
  const commitment = await commitments.get(id).catch(() => null);
  // `'open'` にはせず `'unknown'` へ倒す: 「開いている」は台帳を実際に読めたときにだけ言えるため
  if (commitment === null) return { kind: 'unknown' };
  if (commitment.closedAt === undefined) return { kind: 'open' };
  return {
    kind: 'closed',
    ...(commitment.closedReason === undefined ? {} : { closedReason: commitment.closedReason }),
  };
}

// 「閉じた理由」を添える: 誤って閉じたとき、印だけでは「片付け済みだから読まなくてよい」と読めてしまい、誤りに気づく手がかりが無いため。無ければ括弧ごと出さない
function closedReasonParenthetical(
  settlement: Extract<ReportSettlement, { kind: 'closed' }>,
): string {
  return settlement.closedReason === undefined
    ? ''
    : `（閉じた理由: 「${excerptLine(settlement.closedReason, CLOSED_REASON_EXCERPT)}」）`;
}

// 本文は短くしない: 誤って閉じたことにクローンが気づけるのは本文の後半を読み直したときで、閉じた理由を見たときではないため
function closedReportNotice(settlement: ReportSettlement): string | null {
  if (settlement.kind !== 'closed') return null;
  return `この報告は台帳で既に片付けている${closedReasonParenthetical(settlement)}。読み直す必要は無い。`;
}

// 文言を使い回さない: 報告は読むもの、質問・許可確認は答えるものなので、同じ語尾だと嘘になるため
function closedConfirmationNotice(settlement: ReportSettlement, label: string): string | null {
  if (settlement.kind !== 'closed') return null;
  return `この${label}は台帳で既に片付けている${closedReasonParenthetical(settlement)}。答え直す必要は無い。`;
}

// 「書かれてから」とは言わず「受け取ってから」と書く: `event.at` は `post()` が受理した時刻で、測っていない値を名乗らないため。閾値を設けない: 新しい報告に行が出ないのと機能が無いのとが同じ顔になるため。ISO 文字列を併記する: 丸めた値だけでは日誌・台帳の他のタイムスタンプと突き合わせられないため。壊れた `at` には `NaN` や負の経過でなく取れない理由を書く。`now` は引数で受け取る: `managerPrompt` を純関数のまま保つため
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

// 配り直し（`#redelivered`）に限定しない: 実測された再送は初回配達と同じ経路で新しい `event.id` で届き、限定すると取りこぼすため。「答えたのにまだ `waiting` に載っている」窓は残る: `send()` は `record.waiting` を同期では書き換えず、安全側（雑音）へ倒れるだけのため。`managerId` に対応する要素が無いときも `'unknown'`: 「待たれていない」と決め打たないため
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

// 「何なら答えてよいか」の一覧を書かない: 答えるか人間に回すかの線引きはクローンが記憶として持っており、書くと人による違いが潰れるため。`new Date()` を呼ばず `now` を引数で受け取る: 純関数として保つため。`foldedTurn` の判定は構造化された印だけで行い、本文の文言は見ない
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
      // 本文に束と同じ予算を掛ける: 単発の報告も新しいセッションの最初のターンに載れば文脈窓を越えうるため
      ...boundedReportBody({ ...event, kind: 'report' }),
      '',
      // 経過も印も本文の後ろ・指示の前に置く: 本文より前に置くと「読まなくてよい」と読まれて本文を飛ばされるため
      describeReportAge(event.at, now),
      '',
      ...(closed === null ? [] : [closed, '']),
      '続きが要るなら `manager_send` で指示を出し、要らないなら何もしなくてよい。',
      '学びや判断の基準になったことがあれば記憶へ移すこと。',
    ].join('\n');
  }

  const label = event.kind === 'question' ? '質問' : '実行の許可確認';

  // もう待たれていない確認は答え直せと言わない: 「まだ止まっている」と偽ると、クローンが同じ requestId へ二重に答え、`manager_send` に弾かれるため。`'unknown'` は安全側（雑音）の文言へ倒す。`liveness` と `settlement` は別々の材料なので、どちらか一方が「もう要らない」と言えば足りる
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

  // 宛先には requestId まで書く: 同じマネージャーが同時に複数を待つことがあり、宛先を欠いた回答は宛先を推測できないため
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

// `retrievalHintFor` を呼ばず文言を独立させる: あちらは「配り直し」の文脈専用で、ここへ来る事象は構造上すべて初回配達のため、流用すると起きていないことを起きたと書くことになる
function managerReportRetrievalHint(event: ManagerReportMessage): string {
  return (
    `全文の取り方: \`journal_read\` に \`types: ["exchange"]\` と ` +
    `\`since: "${event.at}"\` を渡して絞り込む（マネージャー ${event.managerId} からの` +
    `${event.kind} が処理されるたびに、"${EXCHANGE_KIND_REPLY_PREFIX}[${event.managerId}/${event.kind}] " で始まる` +
    '全文を、この束を渡す前に日誌へ個別に書いてある）。'
  );
}

// 予算は件数ではなく文字数で持つ: 件数の上限だけでは、巨大な報告を束ねるとターン入力が数十MBになるため。`PROMPT_CHARACTER_BUDGET` と値が同じでも定数は使い回さない: 片方だけ直したくなったときに一緒に動く形を避けるため
const MANAGER_REPORT_BATCH_BODY_BUDGET = 47_500;

// 切った回は全文の取り方を次の行に出す: 言わないと読めるものを減らしたことになるため
function boundedReportBody(event: ManagerReportMessage): string[] {
  if (event.text.length <= MANAGER_REPORT_BATCH_BODY_BUDGET) return [event.text];
  return [
    excerpt(event.text, MANAGER_REPORT_BATCH_BODY_BUDGET),
    '',
    `⚠ 本文が文字数の予算（${MANAGER_REPORT_BATCH_BODY_BUDGET.toLocaleString('en-US')} 文字）を超えたので、ここでは先頭だけを出した。 ${managerReportRetrievalHint(event)}`,
  ];
}

// 全文を届いた順に並べ、要約も間引きもしない。台帳の判定は1件ごとに出す: まとめても「どれが片付け済みか」は件によって違いうるため。1件ごとに経過を出す: 束ねられる報告は定義上いちばん長く待った報告で、待った証拠がいちばん要る場所でだけ消えるのを避けるため。0件・1件には別の見た目を用意しない: 呼び出し元は常に2件以上で呼び、届かない分岐は検証できないため。「N件が届いた」ではなく「N件をまとめて渡す」と書く: 束は上限で切られることがあるため
function managerReportBatchPrompt(
  events: ManagerReportMessage[],
  settlements: ReportSettlement[],
  now: Date,
): string {
  const head = events[0];
  if (head === undefined) return '';

  const items = events.map((event, index) => {
    // 印は本文の後ろ、指示の前に置く: 本文より前に置くと「読まなくてよい」と読まれて本文を飛ばされるため
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
    // 末尾（最新の報告）を優先して残す: 後の報告が前の報告を補足・訂正していることがあるため
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

// 本文は1回だけ出す: `source` と中身が全件で一致しており、繰り返しても情報が増えないため。全件の `at` は本文へ出す: 件ごとに違いうるのは `id` と `at` だけで、「何件届いたか」「いつからいつまでか」を読めるようにするため。「重複だから無視してよい」とは書かない: 外の世界で別々に発行された合図である可能性があるため。`now` を取らない: `at` をそのまま出すので経過はクローン自身が計算できるため。「N件が届いた」ではなく「N件をまとめて渡す」と書く: 束は上限で切られることがあるため
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

// `'unknown'`（既知の2値ではない値）と `'absent'`（欄が無い）を同じ扱いにしない: 前者は書き込み側の想定外、後者は欄が入る前に閉じられた行で、原因も対処も別のため
type ClosedByState =
  { kind: 'clone' } | { kind: 'human' } | { kind: 'unknown'; raw: string } | { kind: 'absent' };

function closedByState(closedBy: string | undefined): ClosedByState {
  if (closedBy === undefined) return { kind: 'absent' };
  const parsed = commitmentClosedBySchema.safeParse(closedBy);
  if (!parsed.success) return { kind: 'unknown', raw: closedBy };
  return { kind: parsed.data };
}

// 切り詰める: 台帳の行を直接書かれれば `closedBy` は任意長になりうるため
const CLOSED_BY_EXCERPT = 64;

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

function closedRedeliveryClosing(state: ClosedByState): string {
  switch (state.kind) {
    case 'clone':
      // 他の3状態にこの文を流用しない: クローンが下していない判断に「閉じた判断を思い出せず」は的外れのため
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

// 中身の条件を減らさない（再起動後の配り直し・どの合図か・いつ受け取ったか・閉じた時刻と理由・全文の取り方）: 減らすと「何を根拠に畳んだのか」が後から取れなくなるため。誰が閉じたかは文面に反映する: クローンでもないのに「クローンが閉じた」と書くと日誌を追う人間に嘘を伝えるため。「全文は省略した」とだけ書かない: 取り方が無い断り書きは禁止された形のため
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

// `human_answer` だけ `journal_read` ではなく `approvals_list` を案内する: 回答そのものは日誌に無く、承認待ちの器が保つため。必ず在る側を案内する: 取り方が分かる体裁のまま実際には取れない形を作らないため
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
    // `external` はここに含めない: 台帳を開かない `source` でも受信箱が持つ全文は消えず、「台帳に載るか」と「全文の取り方があるか」は別の軸のため
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
