import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { readRedactedTranscriptTail } from './transcript-tail.js';
import { homedir, tmpdir } from 'node:os';
import { basename, join as joinPath } from 'node:path';

import type {
  AgentContentBlock,
  AgentDelegationNotified,
  AgentDelegationStarted,
  AgentEvent,
  AgentPermissionDenial,
  AgentTurnEnded,
} from './agent-events.js';
import type {
  AgentContextOutcome,
  AgentPermissionDeniedDecision,
  AgentPermissionDeniedRecord,
  AgentPreCompactRecord,
  AgentPreToolDecision,
  AgentPreToolRecord,
  AgentPreToolRewrite,
  AgentStopRecord,
  AgentSubagentStopRecord,
  AgentToolAuditFailureRecord,
  AgentToolAuditRecord,
  AgentSessionStartRecord,
  AgentUserPromptSubmitRecord,
} from './agent-hooks.js';
import { DEFAULT_AGENT_PROVIDER_ID, type AgentProviderId } from './agent-ports.js';
import { resolvePeerOpening, samePeerOpening, type PeerOpening } from './agent-provider-peers.js';
import { describeRunWatchRewrite, planRunWatchCompact } from './bash-run-watch-compact.js';
import { describeBashToolTimeoutRaise, planBashToolTimeoutRaise } from './bash-tool-timeout.js';
import {
  describeBashShapeGuard,
  resolveBashGuardMode,
  resolveEffectiveBashShapeGuard,
  type BashGuardMode,
} from './bash-guard-mode.js';
import { inspectReleaseProdDispatch } from './bash-release-prod-guard.js';
import { inspectBashCommand } from './bash-wait-guard.js';
import { inspectBashShape, pipeExitNotice } from './bash-shape-guard.js';
import { cgroupEventsDeltaOf } from './cgroup-events.js';
import { ClaudeManagerDriver, type ClaudeQueryFn } from './claude-manager-driver.js';
import {
  CODEX_API_KEY_ENV_NAME,
  CodexManagerDriver,
  type CodexChatgptAuthHandle,
} from './codex-manager-driver.js';
import {
  CodexAuthMirror,
  type CodexAuthMirrorStatus,
  type CodexAuthPush,
  type CodexAuthWriteBack,
} from './codex-auth-mirror.js';
import {
  CLONE_TOOL_RELAY_SOCKET_ENV,
  CLONE_TOOL_RELAY_TOKEN_ENV,
} from './clone-tool-relay-protocol.js';
import { resolveCloneToolRelayChildEntry } from './clone-tools-transport.js';
import {
  createPeerBroker,
  describePeerTurnResult,
  PEER_MCP_SERVER_NAME,
  PEER_SYSTEM_PROMPT_APPEND,
  peerSystemPromptAppend,
  peerActorOf,
  peerApprovalMark,
  resolvePeerLimits,
  type PeerApprovalSource,
  type PeerBroker,
  type PeerResumable,
  type PeerTurnResult,
} from './peer-broker.js';
import type { PeerSocketHost } from './peer-socket-host.js';
import {
  createManagerToolsMcpServer,
  MANAGER_TOOLS_MCP_SERVER_NAME,
  type ManagerToolsSocketHost,
} from './manager-tools.js';
import type {
  AgentChildProcess,
  AgentManagerDriver,
  AgentManagerSession,
  AgentManagerSessionSpec,
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentSessionLog,
  AgentSessionLogKey,
  AgentSpawnOptions,
  AgentInputImage,
  AgentUserInput,
} from './agent-session.js';
import {
  CONTEXT_USAGE_CATEGORY_LIMIT,
  CONTEXT_USAGE_READ_TIMEOUT_MS,
  contextUsageWithin,
} from './context-usage.js';
import { controlRequestWithin, SESSION_ALLOW_RULES_TIMEOUT_MS } from './control-deadline.js';
import { denialInputShape, type DeniedRecord } from './denial-shape.js';
import { buildDenialInputHead, matchInputOf, redactErrorText } from './denial-input-head.js';
import {
  noteBackgroundFailure,
  noteDroppedRecord,
  noteMissingRecordSource,
  noteUnclassifiedFailure,
  noteUnclassifiedFailuresSummary,
  noteUnreadableRecord,
  reasonOf,
  writeStderrLine,
} from './dropped-record.js';
import { ArchiveStash } from './archive-ref.js';
import {
  describeAnthropicRoute,
  inspectAnthropicRoute,
  type AnthropicRouteLayer,
} from './anthropic-route-env.js';
import {
  fingerprintOf,
  POOL_OWNED_CREDENTIAL_NAMES,
  ROTATABLE_CREDENTIAL_KEYS,
} from './credentials.js';
import type { CredentialEntry, CredentialFingerprint, CredentialStore } from './credentials.js';
import { compareCodeUnits } from './code-unit-order.js';
import { subreapedProcess, underSubreaper } from './delegation-subreaper.js';
import { codePointBoundary, excerptLine } from './excerpt.js';
import { relocateMcpConfigArgs } from './mcp-config-arg.js';
import {
  RUNNER_MCP_CONFIG_DIR_PREFIX,
  sweepRunnerMcpConfigDirs,
} from './runner-mcp-config-sweep.js';
import { mcpServerNames, mcpServersFingerprintOf, parseMcpServers } from './mcp-servers.js';
import type { McpServers } from './mcp-servers.js';
import { placedModelTier, resolveModelTier } from './model-tier.js';
import type { AgentClonePlugin } from './agent-clone-session.js';
import {
  defaultRunnerPluginsRoot,
  extractPlugin,
  pruneExtractedPluginDirs,
  runnerPluginsDirOptions,
} from './plugin-extract.js';
import { parseRunnerPlugin, pluginsFingerprintOf } from './plugins.js';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  resolvePermissionModeFor,
  type PermissionModeName,
} from './permission-mode.js';
import { createProfileApplier, type ProfileApplier, type ProfileVessel } from './profile.js';
import { createRecentMap } from './recent.js';
import { scanPeerWorkdir } from './peer-workdir-scan.js';
import {
  buildManagerSystemPrompt,
  buildWorkerPrompt,
  managerScratchDirOf,
  type BashGuardsInPrompt,
} from './prompt.js';
import {
  RunnerCutOffWorkers,
  type CutOffBackgroundTaskSummary,
  type PendingBackgroundTaskOutput,
} from './runner-cut-off-workers.js';
import { readCgroupEventCounters, type CgroupEventCounters } from './runner-resources.js';
import { RunnerSdkSession } from './runner-sdk-session.js';
import {
  composeAttachmentInput,
  defaultRunnerAttachmentsRoot,
  placeRunnerAttachments,
  pruneStaleAttachmentDirs,
  removeManagerAttachments,
  stageRunnerAttachment,
  StagedAttachmentLedger,
} from './runner-attachments.js';
import { attachToManagerOutbox, type AttachToOutboxResult } from './runner-outbox-attach.js';
import {
  collectManagerOutbox,
  defaultRunnerOutboxRoot,
  defaultRunnerOutboxStagedRoot,
  openStagedOutboxFile,
  outboxCollectFailureRefusals,
  prepareManagerOutbox,
  pruneStaleOutboxRoots,
  removeManagerOutbox,
  removeStagedOutboxFile,
  RUNNER_OUTBOX_ENV,
  type OutboxContentsRemover,
  type OutboxRemovalOptions,
  type StagedOutboxFile,
} from './runner-outbox.js';
import {
  BACKGROUND_TASK_OWNER_LIMIT,
  RunnerSubagentStopState,
  SUBAGENT_BACKGROUND_WAIT_MS,
} from './runner-subagent-stop-state.js';
import {
  recoverFromFailedResume,
  type ResumeRecoveryHost,
  type ResumeRecoveryOutcome,
} from './runner-resume-recovery.js';
import {
  GIT_DIR_HINTS_MAX,
  gitDirsFromBashCommand,
  isSameOrInside,
  isUnderManagerScratchDir,
} from './git-worktree-hints.js';
import { outwardCommandsIn } from './outward-commands.js';
import {
  chownTreeSync,
  parseTranscriptEntries,
  placePeersInCodexHome,
  placeResumeMaterialAsChild,
  sdkResumeConfigDirOf,
  sessionIdInSdkResumeConfigDir,
  type PeerRolloutSeed,
  type SubagentTranscriptSeed,
} from './runner-resume-config-dir.js';
import {
  childFileWriter,
  childRolloutIo,
  type ChildFileWriter,
  type RolloutIo,
} from './runner-child-fs.js';
import { PeerRolloutMirror } from './runner-peer-rollout.js';
import {
  cachedPidsReader,
  PidsPressureNotices,
  type PidsPressureReading,
} from './runner-pids-pressure.js';
import {
  describeReportLanguage,
  excerptExample,
  findEnglishSentences,
  ReportLanguageNotices,
  resolveEffectiveReportLanguage,
  REPORT_LANGUAGE_PROMPT_PARAGRAPH,
  withReportLanguageParagraph,
  type ReportLanguageMode,
} from './report-language.js';
import {
  ClassifierDenialStreaks,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
  describeDenialStreakForClone,
} from './classifier-denial-streak.js';
import {
  mergeSessionAllowRules,
  SessionAllowRuleBook,
  sessionAllowRuleShapeOf,
  type SessionAllowRuleGrant,
} from './session-allow-rules.js';
import { parseDelegatedPermissionRules } from './delegated-permission-rules.js';
import { RunnerResumeState } from './runner-resume-state.js';
import { RunnerTurnTally } from './runner-turn-tally.js';
import { RunnerWorkerWaitWindow } from './runner-worker-wait-window.js';
import { WorkerToolWatch, type WorkerToolWatchClock } from './runner-worker-tool-watch.js';
import type {
  RunnerAnswerCommand,
  RunnerAnswerOutcome,
  RunnerEvent,
  RunnerLease,
  RunnerManagerPeer,
  RunnerManagerPeerClosed,
  RunnerManagerState,
  RunnerMcpServersFingerprint,
  RunnerPermissionRulesResult,
  RunnerPluginFingerprintEntry,
  RunnerPluginsFingerprint,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerResumeCommand,
  RunnerAttachment,
  RunnerStagedAttachmentMeta,
  RunnerOutboxFile,
  RunnerOutboxRejectedFile,
  RunnerStartCommand,
  UnpushedWorkResult,
} from './runner-protocol.js';
import { readAttachmentLimits, readRunnerAttachmentStageLimit } from './attachment.js';
import {
  redactImagesInEntries,
  redactImagesInTranscriptYielding,
} from './transcript-image-redaction.js';
import { chunkMirrorEntries, MIRROR_EVENT_MAX_CHARS } from './mirror-chunks.js';
import {
  deleteRescueRef,
  type RescueListIncomplete,
  RescueListNotice,
  RescueMemory,
  type RescueRefDeleteResult,
  resolveRescueIntervalMs,
  runRescue,
  UNTRACKED_STALE_AFTER_MS,
} from './rescue-ref.js';
import { defaultRunnerRescueStagedRoot } from './rescue-stash.js';
import { PeerApprovalNotices } from './runner-peer-approval-notice.js';
import {
  WORKER_LIMIT_PRE_ROTATION_KEY_SENTENCE,
  WORKER_LIMIT_REOPENED_NUDGE,
  WorkerLimitNotices,
  workerLimitLabel,
} from './runner-worker-limit-notice.js';
import { StaleUntrackedNotices } from './runner-stale-untracked.js';
import {
  ScratchSweeper,
  resolveScratchSweepGraceMs,
  resolveScratchSweepIntervalMs,
  type ScratchSweeperOptions,
} from './scratch-sweep.js';
import { computeUnpushedWork, worktreeRootsOfDirs } from './unpushed-work.js';
import { foldMcpToolsByServer } from './mcp-tools-by-server.js';
import { foldMessageBreakdown } from './message-breakdown.js';
import type { ContextUsageObservation, JobStatus } from './schema.js';
// クローンと同じ判定を呼ぶ: 層ごとに書くと片方だけが印を見落として非対称になるため
import {
  FAILED_REPORT_PARTIAL_MARKER,
  assistantFailureOf,
  turnFailureKindOf,
  type SdkFailure,
} from './sdk-failure.js';
import { systemErrorFactsOf, type SystemErrorFacts } from './system-error.js';
import { classifyUsageNotice } from './usage-limits.js';
import { describeProbeError } from './usage-probe.js';

export { SUBAGENT_BACKGROUND_WAIT_MS };

// 既定を動かさない: 変更には人間の承認が要るため（AGENTS.md 地雷5）
export const MANAGER_MODEL = 'opus';

// 省略しない: SDK の既定はマネージャーの継承になるため
export const WORKER_MODEL = 'sonnet';

export const MANAGER_MODEL_ENV_KEY = 'ALTEROID_MANAGER_MODEL';
export const WORKER_MODEL_ENV_KEY = 'ALTEROID_WORKER_MODEL';

export function resolveManagerModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveModelTier(env, MANAGER_MODEL_ENV_KEY, MANAGER_MODEL);
}

export function resolveWorkerModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveModelTier(env, WORKER_MODEL_ENV_KEY, WORKER_MODEL);
}

// 既定と同じ値が置かれた場合も含める: 答えるのは差し替えの承認が置かれているかで、値の比較ではないため
export function placedManagerModels(
  env: NodeJS.ProcessEnv = process.env,
): { key: string; value: string; fallback: string }[] {
  return (
    [
      { key: MANAGER_MODEL_ENV_KEY, fallback: MANAGER_MODEL },
      { key: WORKER_MODEL_ENV_KEY, fallback: WORKER_MODEL },
    ] as const
  ).flatMap(({ key, fallback }) => {
    const value = placedModelTier(env, key);
    return value === null ? [] : [{ key, value, fallback }];
  });
}

// 独自のワーカープールを作らない: 作業者層の本体はこの `agents` 定義1個だけ
export const WORKER_AGENT_NAME = 'worker';

export const TOOL_USE_FAILURE_NOTE_PREFIX = 'tool_use_failure:';

// 切らずに残さない: `error` は上限の無い自由文で、巨大な失敗メッセージが日誌の1行を埋め尽くしうるため
const TOOL_USE_FAILURE_ERROR_EXCERPT = 500;

// 日誌の1行を埋め尽くさない長さで、落ちた理由（最後の数行）が収まる長さ
const DELEGATION_STDERR_TAIL_CHARS = 2000;

// 止めた側の合図どおりの終わり方: SIGTERM・SIGKILL と、シェルや tini（`-s`）を挟んだときに exit code へ写った 128+15・128+9
function isStopTermination(code: number | null, signal: NodeJS.Signals | null): boolean {
  if (code === null) return signal === 'SIGTERM' || signal === 'SIGKILL';
  return code === 143 || code === 137;
}

// `exit` から stderr の `end` までの待ちの上限: 孫プロセスが stderr のパイプを握ったままだと `end` が永久に来ないため。通常は `exit` の直後（数 ms）に `end` が来るので、1 秒あれば最後の chunk は読み切れ、握られても note が1秒遅れるだけで済む
export const DELEGATION_STDERR_END_GRACE_MS = 1000;

// runner の制御面の鍵も落とす: マネージャーが runner の API を叩くと、自分宛の許可確認に自分で allow を返せるため
export const WITHHELD_ENV_KEYS = [
  'ALTEROID_HOME',
  'ALTEROID_PORT',
  'ALTEROID_DATABASE_URL',
  'ALTEROID_RUNNER_TOKEN',
  'ALTEROID_RUNNER_TOKEN_SHA256',
  'ALTEROID_RUNNER_SOCKET',
] as const;

// 重ね順をここ1か所に置く: セッションの env（`RunnerSession#childEnv`）と接続先の検査（`Host#anthropicRoute`）が別々に書かれると、表示が実際の env とずれるため
function childEnvLayers(input: {
  env: NodeJS.ProcessEnv;
  credentials: CredentialStore | undefined;
  profileEnv: Record<string, string>;
}): AnthropicRouteLayer[] {
  const vessel = { ...input.env };
  // 鍵の名前をまず自分の env から落とす: 器の env に残った現役でない鍵（週次上限で冷却中のトークン）で走り、クローンが撒いたものとの食い違いが見えなくなるため。重ねる前に消す（後だと降ろした鍵まで落ちる）
  for (const name of ROTATABLE_CREDENTIAL_KEYS) delete vessel[name];
  return [
    { source: '器', env: vessel },
    {
      source: '袋',
      env:
        input.credentials === undefined
          ? {}
          : { ...input.credentials.values(), ...input.credentials.env() },
    },
    // **プロファイルは鍵より後。** 人間が明示的に書いたほうが勝つ（`credentials`
    // は1つの鍵を回すための細い口で、こちらは実行環境そのものの宣言である）。
    { source: 'プロファイル', env: input.profileEnv },
  ];
}

// files のバイトは持たない: メモリに残すのは印だけにするため
interface HeldPlugin {
  readonly name: string;
  readonly sha: string;
  readonly contentSha256: string;
  readonly enableHooks: boolean;
  readonly enableMcp: boolean;
  readonly path: string;
  readonly skipMcpDiscovery: boolean;
}

// 400 ではなく 500 で返す: 検査は通っており、入力の不正ではなく runner 側の事情のため
export class RunnerPluginExtractError extends Error {
  constructor(cause: unknown) {
    super(
      `plugin を展開できなかった（置いていない）: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'RunnerPluginExtractError';
  }
}

// 同じ UID で走らせない: 子が runner の `/proc/1/environ` から制御面の鍵を読めるため。特権が無いのに設定されていたら黙って同じ UID で走らせず落とす
export interface RunnerChildUser {
  uid: number;
  gid: number;
  home?: string;
}

// 既定を `default` にしない: 層を下りた途端に `Read` や `grep` で止まるのはデグレードのため（north_star 禁止1）
export const MANAGER_PERMISSION_MODES = PERMISSION_MODES;

export type ManagerPermissionMode = PermissionModeName;

export { DEFAULT_PERMISSION_MODE };

export const PERMISSION_MODE_ENV_KEY = 'ALTEROID_MANAGER_PERMISSION_MODE';

export function resolvePermissionMode(env: NodeJS.ProcessEnv): ManagerPermissionMode {
  return resolvePermissionModeFor(env, PERMISSION_MODE_ENV_KEY);
}

// 既定で開けない: マネージャーは使い捨てで、書いた auto-memory がクローンにも次の器にも届かないため
// 固定値にしない: 人間が開きたいときに開けなくなるため（north_star 禁止2）
export const MANAGER_AUTO_MEMORY_ENV_KEY = 'ALTEROID_MANAGER_AUTO_MEMORY';

export function resolveManagerAutoMemoryEnabled(env: NodeJS.ProcessEnv): boolean {
  const given = env[MANAGER_AUTO_MEMORY_ENV_KEY]?.trim();
  if (given === undefined || given.length === 0) return false;
  if (given === 'true') return true;
  if (given === 'false') return false;
  throw new Error(
    `${MANAGER_AUTO_MEMORY_ENV_KEY} の値が不正: ${given}（使えるのは true / false。既定は false）`,
  );
}

// 環境変数の設定項目にしない: つまみとして外へ出すと実質の運用パラメータになるため
const LEASE_WATCH_INTERVAL_MS = 10_000;

export interface RunnerPeerOptions {
  readonly host: PeerSocketHost;
  readonly peers: readonly AgentProviderId[];
  // `agent-provider-selection.js` をここで import しない: バンドルのモジュール評価順が変わり、起動時に provider の表が未初期化になるため
  readonly reportsUsage: (provider: AgentProviderId) => boolean;
  readonly models?: Partial<Record<AgentProviderId, readonly string[]>>;
  readonly childEntry?: string;
  /** peer の作業場を置く根（既定 `/tmp`）。テストで本物の `/tmp` を触らないための口。 */
  readonly workdirRoot?: string;
}

/** 渡されたソケットは Host の停止で閉じる。 */
export interface RunnerManagerToolsOptions {
  readonly host: ManagerToolsSocketHost;
  readonly childEntry?: string;
}

/**
 * runner の peer。**開く条件はこの器に届いた Codex の資格**（ChatGPT ログインか `CODEX_API_KEY`）で、
 * 資格が届く・外れるたびに判定し直す（`resolvePeerOpening`）。ソケットは初めて開くときに1回だけ作る
 * （資格が1度も届かない器にはソケットを作らない）。
 */
export interface RunnerHostPeerOptions {
  readonly openSocket: () => Promise<PeerSocketHost>;
  readonly reportsUsage: (provider: AgentProviderId) => boolean;
  readonly models?: Partial<Record<AgentProviderId, readonly string[]>>;
  readonly childEntry?: string;
  /** peer の作業場を置く根（既定 `/tmp`）。テストで本物の `/tmp` を触らないための口。 */
  readonly workdirRoot?: string;
}

/** hello と `manager_peers` に載せる、peer の開閉。 */
export interface RunnerManagerPeersAnnouncement {
  readonly managerPeers: RunnerManagerPeer[];
  readonly managerPeersClosed?: RunnerManagerPeerClosed[];
}

export interface RunnerHostOptions {
  runnerId: string;
  emit: (event: RunnerEvent) => void;
  workspacePath: string;
  queryFn?: ClaudeQueryFn;
  env?: NodeJS.ProcessEnv;
  // 起動後に実効の設定が変わったときの1行の出し口（`Bash の形の歯` の出し直し）。省略なら出さない
  log?: (line: string) => void;
  peer?: RunnerHostPeerOptions;
  managerTools?: RunnerManagerToolsOptions;
  withheldEnvKeys?: readonly string[];
  childUser?: RunnerChildUser;
  codexHome?: string;
  codexAuthCheckIntervalMs?: number;
  attachmentsRoot?: string;
  // 別口で受ける1つの大きいファイルの最大バイト（#4128 段3a）。省略は `readRunnerAttachmentStageLimit(env)`。主にテスト用
  attachmentStageLimit?: number;
  // 出し箱（担い手 → クローンへのファイルの受け渡し。`runner-outbox.ts`）。置き場は下りの添付と同じ作法で、テストで差し替える
  outboxRoot?: string;
  outboxStagedRoot?: string;
  /** 未追跡のファイルの預かりの退避先（`rescue-stash.ts`。出し箱の退避先とは別の dir）。テストで差し替える。 */
  rescueStagedRoot?: string;
  /** 担当の作業場（`/tmp/mgr-<先頭8桁>`）の根。テストで差し替える。既定は `/tmp`。 */
  managerScratchRoot?: string;
  // テスト用: 子の権限で出し箱の中身を消す関数の差し替え口
  outboxRemoveContentsAsChild?: OutboxContentsRemover;
  // `/workspace` に置かない: 子の持ち物のため（ここは runner の所有にし、子 uid は読めるが書けない）
  pluginsRoot?: string;
  permissionMode?: ManagerPermissionMode;
  credentials?: CredentialStore;
  // runner が自分で記憶ストアを読みに行く形にしない: 読みに行けるということは鍵があるということのため
  profile?: ProfileVessel;
  rescueIntervalMs?: number;
  // 退避で探す作業ツリーの本数の上限（#4953）。既定は `RESCUE_MAX_WORKTREES`。試験が小さくするための口
  rescueMaxWorktrees?: number;
  scratchSweep?:
    | false
    | (Partial<
        Omit<ScratchSweeperOptions, 'liveManagerIds' | 'knownManagerIds' | 'spawn' | 'env'>
      > & {
        intervalMs?: number;
      });
  // 既定で有効にしない: 同一プロセスの `runner-local` ではデーモンだけが消えることが無く、接触の無い構成のセッションを理由なく畳むため
  enforceLease?: boolean;
  spawnAgentProcessFn?: (options: SpawnAgentProcessOptions) => DelegationProcessHandle;
  // 委譲の CLI を `<この実行ファイル> -s --` の子として起こす（tini の絶対パス。#4494）。無ければ CLI を直に起こす: tini の無い手元の構成でも動かすため
  delegationSubreaper?: string;
  handOverResumeConfigDirFn?: HandOverResumeConfigDir;
  handOverMcpConfigDirFn?: HandOverResumeConfigDir;
  // 委譲の CLI の MCP 設定を置く親と、その掃き（`scratchSweep` の周期）の親。既定は `tmpdir()`。試験が本物の /tmp に触れないための口
  mcpConfigTmpRoot?: string;
  // 起動時にもその掃きを1回走らせる（#5186）。既定で有効にしない: 試験や同一プロセスの `runner-local` は本物の /tmp を他の runner と共有しうるため
  sweepMcpConfigOnStart?: boolean;
  contextUsageTimeoutMs?: number;
  // 一時規則（#4905）の置き直しを待つ期限。既定は `SESSION_ALLOW_RULES_TIMEOUT_MS`。試験が短くするための口
  sessionAllowRulesTimeoutMs?: number;
  readCgroupEventCountersFn?: () => Promise<CgroupEventCounters>;
  /**
   * 器の pids（cgroup の `pids.current` / `pids.max`）を読む口。渡したときだけ、上限に近い器の担当に道具の結果へ知らせを添える
   * （`runner-pids-pressure.ts`）。既定で読まない: 手元の構成や試験で、ホストの値に応じて文脈が変わらないため。
   */
  readPidsFn?: () => Promise<{ current: number; max: number } | undefined>;
  finishUnpushedWorkFn?: (options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>;
  cwdExistsFn?: (cwd: string) => boolean;
  workerToolWatchClock?: WorkerToolWatchClock;
}

export interface RunnerHost {
  readonly runnerId: string;
  readonly workspacePath: string;
  credentials(): CredentialFingerprint[];
  // 指紋が同じなら畳まない: 再接続のたびに同じ値が降りるので、無条件に畳むと再接続のたびにセッションが畳まれるため
  setCredentials(entries: readonly CredentialEntry[]): Promise<CredentialFingerprint[]>;
  profile(): RunnerProfileFingerprint | undefined;
  setProfile(script: string): Promise<RunnerProfileResult>;
  // 起動行に出す `Bash の形の歯` の1行（実効の値。不正な値でも投げない）
  bashShapeGuardLine(): string;
  // 起動行に出す `報告の言語の知らせ` の1行（実効の値。不正な値でも投げない。#4965）
  reportLanguageLine(): string;
  // 鍵・プロファイルが降りた後の実効の env から読む（値は返さない）。hello と `anthropic_route` が名乗る
  anthropicRoute(): string[];
  mcpServers(): RunnerMcpServersFingerprint | undefined;
  // ファイルへ落とさない: 走行中のプロセスが読み直す経路が無く、効くのはセッションを組む瞬間だけのため
  setMcpServers(input: unknown): RunnerMcpServersFingerprint | undefined;
  // 委譲先の許可規則（#4952）。`setMcpServers` と違い走行中のセッションへも置き直す: flag 層は走行中に差し替えられ、取り消しを次のセッションまで待たせないため
  // 置く前に `parseDelegatedPermissionRules` を通す: 不正なら投げて前の一覧を残すため
  setPermissionRules(input: unknown): RunnerPermissionRulesResult;
  plugins(): RunnerPluginsFingerprint | undefined;
  // 置く前に `parseRunnerPlugin` を通す: 不正なら投げて前の状態を残すため
  setPlugin(name: string, input: unknown): Promise<RunnerPluginFingerprintEntry>;
  // ディスクの旧版はここで消さない: 走行中のセッションが読んでいるかもしれないため
  retainPlugins(names: readonly string[]): RunnerPluginsFingerprint | undefined;
  codexAuth(): CodexAuthMirrorStatus;
  setCodexAuth(push: CodexAuthPush): Promise<CodexAuthMirrorStatus>;
  /** いまの peer の開閉（hello に載せる）。peer を持たない器（ローカル実行など）は `undefined`。 */
  managerPeers(): RunnerManagerPeersAnnouncement | undefined;
  takeCodexAuthWriteBack(fingerprint: string): CodexAuthWriteBack | null;
  start(command: RunnerStartCommand): Promise<{ cwd: string; sessionGeneration: string }>;
  resume(command: RunnerResumeCommand): Promise<{
    cwd: string;
    reusedLiveSession: boolean;
    sessionGeneration: string;
  }>;
  send(
    managerId: string,
    text: string,
    attachments?: readonly RunnerAttachment[],
  ): Promise<boolean>;
  answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome>;
  /** `keepPeers`: 鍵の付け替えのための畳み。peer を閉じずに預け、同じ担当の resume で引き継ぐ（#4734）。 */
  stop(managerId: string, options?: { keepPeers?: boolean }): Promise<void>;
  list(): RunnerManagerState[];
  transcript(managerId: string): Promise<string | null>;
  // 末尾 `maxChars + 1` 字だけ（全文を伏せて切った値と同じ。#5160）。無い・読めないは null
  transcriptTail(managerId: string, maxChars: number): Promise<string | null>;
  // 委譲が終わっていても開く（退避先は `closed` では消えず、デーモンの `DELETE` か24時間の掃除まで残る）。形が不正・無ければ `undefined`
  openOutboxFile(managerId: string, fileId: string): Promise<StagedOutboxFile | undefined>;
  // 無くても成功（冪等）。形が不正なら `false`
  deleteOutboxFile(managerId: string, fileId: string): Promise<boolean>;
  // 未追跡のファイルの預かりの退避先（`rescue_files`。#4863）。意味は出し箱と同じで、dir だけが別
  openRescueFile(managerId: string, fileId: string): Promise<StagedOutboxFile | undefined>;
  deleteRescueFile(managerId: string, fileId: string): Promise<boolean>;
  /**
   * いま繋がっているデーモンが、生ログの退避を参照で受け取れるか（SSE の接続で `archive-ref` を名乗ったか。#4485）。
   * 接続のたびに書き直す: 新しい接続のデーモンが古い版なら、本文を載せる形に戻すため。
   */
  setDaemonAcceptsArchiveRef(accepts: boolean): void;
  /** 預けた退避の本文。無い・期限切れ・別の委譲の id なら `undefined`。 */
  readArchive(managerId: string, archiveId: string): string | undefined;
  /** デーモンが本文を取り終えた印（GET の応答を返し終えた時点）。畳みの待ちと送り直しの対象から外す（#4899）。 */
  markArchiveFetched(managerId: string, archiveId: string): void;
  /** 冪等。 */
  deleteArchive(managerId: string, archiveId: string): void;
  /** 別口で受ける1つの大きいファイルの最大バイト（hello の `attachmentStageLimit`。#4128 段3a）。 */
  readonly attachmentStageLimit: number;
  // 大きいファイルの別口（#4128 段3a）。置けなければ `RunnerAttachmentRejectedError`（`RunnerAttachmentStageError` は 413 / 422）
  stageAttachment(
    managerId: string,
    meta: RunnerStagedAttachmentMeta,
    body: AsyncIterable<Uint8Array>,
  ): Promise<void>;
  // origin remote は host/path までしか出さない: userinfo・クエリ・資格を出さないため
  unpushedWork(
    managerId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UnpushedWorkResult | undefined>;
  deleteRescueRef(
    request: { remote: string; ref: string; commit: string },
    options?: { signal?: AbortSignal },
  ): Promise<RescueRefDeleteResult>;
  shutdown(): Promise<void>;
  /**
   * `shutdown()` を始めてから出した、デーモンに HTTP で取りに来させる物（預けた生ログ・出し箱の退避先ファイル）のうち、まだ取られていない数（#4699）。
   * runner の入口は、これが 0 になるまで（期限付きで）口を閉じずに待つ。
   */
  pendingPickups(): number;
  /**
   * 待っても取られない預けた退避を、本文を載せて送り直す。送った件数を返す（#4896）。
   * 参照だけを送って器が入れ替わると、新しいプロセスに本文が無く生ログが失われるため、runner の入口が待ちの途中で呼ぶ。
   */
  inlineUnpickedArchives(): number;
  // 無認証の `/livez` から呼ばない: 誰でも貸し出し期限を延ばせてしまうため
  noteDaemonContact(): void;
  // プロセスの exit で knownTerminated にしない: 作業者の1回の呼び出しは委譲が生きていてもプロセスを終え、その孫（nohup のサーバ等）が撃たれるため
  // failed / lost で閉じたセッションの pid は、同じ managerId を resume しても knownTerminated に残す: 落ちた CLI の木（verify・dev サーバー等）が守られ続けて溜まるため（done・stop() からの resume は守る。#4433）。
  // 溜まらないのは、回収が CLI の枝（落ちた CLI と背景の Bash・verify などその子孫）を撃ち続けるから。撃たなくなるのは tini に引き取られた枝（担当が自分で切り離したサーバー。postgres など）だけで、持ち主が名簿に居る間に限る（#5168）。
  // 溜まりうるのは、切り離したサーバーを resume のたびに新しく起こす担当。名簿に居る間は残るので、#5159 の内訳（unrecognisedBy.ownerListed）と runner_list の pids で見張る。
  // ownerListed は観測の内訳用（#5157）: 持ち主が名簿に居る（または鍵の付け替えの戻り待ち）ので knownTerminated に入れていない CLI の pid。撃つ判定には使わない
  // abandonedOwnerListed は knownTerminated の部分集合（#5162）: 鍵の付け替えの畳みで背景処理を畳んだ（abandonTree）か failed / lost で閉じた（#5168）pid のうち、持ち主がまだ名簿に居る（または戻り待ち）もの。回収は CLI の枝だけを撃つ
  delegationSessionPids(): {
    live: ReadonlySet<number>;
    knownTerminated: ReadonlySet<number>;
    ownerListed: ReadonlySet<number>;
    abandonedOwnerListed: ReadonlySet<number>;
  };
  // 所有者の記録（pid → managerId）の件数。上限で忘れた累計は runner を起こしてからの数（#5157）
  delegationPidOwnerRecords(): { remembered: number; cap: number; forgottenTotal: number };
}

// 無限には覚えない: 長時間走る runner のメモリが際限なく育つため。忘れた分は所有者不明として knownTerminated に入れず、撃たない側へ倒れる
const PID_OWNER_MANAGER_ID_CAP = 4096;

// 添付を置く間に畳みの片付けが重なったときの、置き直しを含めた試行の上限（`#placeAttachmentInput`）
const ATTACHMENT_PLACE_ATTEMPTS = 3;

// 裸のリテラルにしない（型で `ROTATABLE_CREDENTIAL_KEYS` に縛る）: 名前が変わると世代の照合が静かに効かなくなるため
const AGENT_TOKEN_CREDENTIAL_NAME: (typeof ROTATABLE_CREDENTIAL_KEYS)[number] =
  'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * **鍵の器（`CredentialStore`）が無い器で、マネージャーが `Not logged in` で落ちたときの案内。**
 * 器が無いのは、デーモンの同一プロセスの runner（`createLocalRunner` に `credentials` を渡さない構成）。
 * そこではトークンプールの鍵を降ろす先が無く（`setCredentials` が断る）、マネージャーの子には器の鍵が届かない。
 * 別プロセスの runner（`apps/runner`）は必ず器を作るので、この案内は出ない（本番の runner の挙動は変えない）。
 */
const NOT_LOGGED_IN_PATTERN = /not logged in/i;
const NO_CREDENTIAL_DIR_HINT =
  '鍵の置き場（ALTEROID_CREDENTIAL_DIR）が無いと、ローカル runner のマネージャーへ鍵が届かない。' +
  'この runner には鍵の置き場が無い（同一プロセスの runner は置き場を持たない）。' +
  '`ALTEROID_CREDENTIAL_DIR` 付きの runner（apps/runner）を別に起こし、デーモンの `ALTEROID_RUNNER_URL` で繋ぐこと。';

function fingerprintsByName(
  fingerprints: readonly CredentialFingerprint[],
): ReadonlyMap<string, string> {
  return new Map(fingerprints.map((fingerprint) => [fingerprint.name, fingerprint.sha256]));
}

function sameFingerprints(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, sha256] of a) if (b.get(name) !== sha256) return false;
  return true;
}

function tokenFingerprintOf(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[AGENT_TOKEN_CREDENTIAL_NAME];
  return value === undefined || value === '' ? undefined : fingerprintOf(value);
}

function withSessionGeneration(event: RunnerEvent, sessionGeneration: string): RunnerEvent {
  switch (event.type) {
    case 'closed':
    case 'session':
    case 'report':
    case 'ask':
    case 'settled':
      return { ...event, sessionGeneration };
    default:
      return event;
  }
}

// `statSync` が投げる理由を見分けない: `chdir` できないかもしれないという1点だけが呼び出し側に意味を持つため
function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface GitSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

export function createRunnerHost(options: RunnerHostOptions): RunnerHost {
  return new Host(options);
}

function sameRuleSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(b);
  return a.every((rule) => seen.has(rule));
}

class Host implements RunnerHost {
  readonly runnerId: string;
  readonly workspacePath: string;
  readonly #codexAuth: CodexAuthMirror;
  #codexAuthTimer: ReturnType<typeof setInterval> | null = null;
  readonly #emit: (event: RunnerEvent) => void;
  readonly #queryFn: ClaudeQueryFn | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #withheldEnvKeys: readonly string[];
  readonly #childUser: RunnerChildUser | undefined;
  readonly #credentials: CredentialStore | undefined;
  readonly #permissionMode: ManagerPermissionMode;
  readonly #bashGuard: BashGuardMode;
  readonly #peer: RunnerHostPeerOptions | undefined;
  readonly #managerTools: RunnerManagerToolsOptions | undefined;
  /** peer 用ソケット（初めて開くときに作る。資格が外れても閉じない — 道具を出さなければ token が発行されない）。 */
  #peerSocket: PeerSocketHost | undefined;
  /** いまの開閉。名乗り直しとセッションの組み直しの要否は、これとの比較で決める。 */
  #peerOpening: PeerOpening = { open: [], closed: [] };
  /** 判定を1本ずつ流す鎖（鍵と ChatGPT ログインが同時に降りても、ソケットを2回開かず名乗りが前後しない）。 */
  #peerChain: Promise<void> = Promise.resolve();
  // 起こすたびに評価し直さない: 評価はプロセスを1本起こす操作で、人間のスクリプト次第で委譲そのものが遅くなるため
  readonly #profile: ProfileApplier | undefined;
  /** 最後に名乗った（起動時は構築時に読んだ）接続先の表示行。器だけの状態からの変化だけを名乗るための基準。 */
  #announcedAnthropicRoute: string;
  #announcedBashShapeGuard: string;
  #announcedReportLanguage: string;
  readonly #log: ((line: string) => void) | undefined;
  readonly #sessions = new Map<string, RunnerSession>();
  // 終わった担当が撃った退避の push（#4789）。畳むときに待つ（それぞれ `STOP_RESCUE_TIMEOUT_MS` で切れるので待ちは有限）
  readonly #closeRescues = new Set<Promise<unknown>>();
  // 鍵の付け替えで畳んだ担当から預かった peer（#4734）。同じ担当の resume で新しいセッションへ渡し、戻らなければ期限で閉じる
  readonly #parkedPeers = new Map<
    string,
    { parked: ParkedPeers; timer: ReturnType<typeof setTimeout> }
  >();
  // 預けた peer を閉じている最中の仕事（#4885）。器を畳むときに待つ
  readonly #closingPeers = new Set<Promise<unknown>>();
  readonly #generations = new WeakMap<RunnerSession, string>();
  readonly #attachmentsRoot: string;
  readonly #attachmentRemovals = new Map<string, Promise<void>>();
  // 担当ごとに、片付けを始めた回数（置いている間に片付けが重なったかを見分ける）
  readonly #attachmentRemovalStarts = new Map<string, number>();
  // 別口で置いて照合を済ませた添付の控え（命令の `staged: true` の参照を突き合わせる。#4128 段3a）
  readonly #stagedAttachments = new StagedAttachmentLedger();
  readonly attachmentStageLimit: number;
  readonly #outboxRoot: string;
  readonly #outboxStagedRoot: string;
  readonly #rescueStagedRoot: string;
  readonly #outboxRemoveContentsAsChild: OutboxContentsRemover | undefined;
  readonly #managerScratchRoot: string;
  #mcpServers: { servers: McpServers; fingerprint: RunnerMcpServersFingerprint } | undefined;
  #permissionRules: readonly string[] = [];
  /**
   * daemon から降りてきた plugin（名前 → 展開済みの印）。**files のバイトは持たない**
   * （多数の大きな plugin でメモリを積まないため。展開したあとはディスクが持つ）。
   */
  readonly #plugins = new Map<string, HeldPlugin>();
  #pluginsUpdatedAt = '';
  readonly #pluginsRoot: string;
  /** 展開と片づけを1本ずつ流す鎖（片づけが書いている途中の `.tmp-*` を消さないため）。 */
  #pluginsChain: Promise<void> = Promise.resolve();
  readonly #enforceLease: boolean;
  // 起動直後は「今」を起点にする: 知らない時刻を過去に見積もると、デーモンが1度も繋いでいない起動直後のセッションまで即座に自己失効するため
  #lastDaemonContact = Date.now();
  #leaseWatcher: ReturnType<typeof setInterval> | null = null;
  #rescueTimer: ReturnType<typeof setInterval> | null = null;
  #scratchTimer: ReturnType<typeof setInterval> | null = null;
  readonly #scratchAbort = new AbortController();
  #scratchRunning: Promise<void> | null = null;
  #attachmentPruning: Promise<void> | null = null;
  #outboxPruning: Promise<void> | null = null;
  readonly #knownManagerIds = new Set<string>();
  // `knownTerminated` を固定の集合として持たない: resume で同じ `managerId` が戻っても古い pid が「終端済み」のままになるため
  readonly #liveDelegationPids = new Set<number>();
  readonly #pidOwnerManagerId = new Map<number, string>();
  // 上限で忘れた件数の累計（runner を起こしてから。pid の再利用による付け替えは忘れたに数えない）
  #pidOwnerForgottenTotal = 0;
  // failed / lost / abandonTree で閉じたセッションが起こした pid: 同じ `managerId` を resume しても撃つ側に残す（落ちた CLI の木が pid を占め続けるため。#2352・#1334）。
  // 持ち主が名簿に居る間は CLI の枝だけを撃ち、引き取られた枝は撃たない（#5162・#5168）。abandonTree と failed / lost を分ける必要は無くなった: 回収の絞り方が同じため
  readonly #abandonedDelegationPids = new Set<number>();
  // resume で戻ってくる担当（managerId → 名簿から消えた時刻）。`#sessions` から消えている間も木を守る。
  // 鍵の付け替えで畳んだ担当（#5115）と、failed / lost で閉じた担当（#5168: 枠で落ちた担当は通る鍵で起こし直されるが、それまでの窓に走査が当たる）
  readonly #returnAwaitedSince = new Map<string, number>();
  readonly #spawnAgentProcessFn:
    ((options: SpawnAgentProcessOptions) => DelegationProcessHandle) | undefined;
  readonly #delegationSubreaper: string | undefined;
  readonly #handOverResumeConfigDirFn: HandOverResumeConfigDir | undefined;
  readonly #handOverMcpConfigDirFn: HandOverResumeConfigDir | undefined;
  readonly #mcpConfigTmpRoot: string;
  // 全担当で共有する: 掃きは runner 全体で1本なので、どの担当の委譲が置いたディレクトリも外せる必要があるため
  readonly #liveMcpConfigDirs = new Set<string>();
  // 同じ失敗を周期ごとに note へ出し直さない
  #mcpConfigSweepFailedNotified = new Set<string>();
  #mcpConfigSweeping = false;
  readonly #contextUsageTimeoutMs: number | undefined;
  readonly #sessionAllowRulesTimeoutMs: number | undefined;
  readonly #rescueMaxWorktrees: number | undefined;
  readonly #readCgroupEventCountersFn: (() => Promise<CgroupEventCounters>) | undefined;
  readonly #readPids: (() => Promise<{ current: number; max: number } | undefined>) | undefined;
  // 生ログの退避の本文を、デーモンが取りに来るまで預かる（#4485。`archive-ref.ts`）。捨てた分は stderr に残す（デーモンへの経路が無い時にも起きるため）
  readonly #archiveStash = new ArchiveStash({
    onDrop: (drop) => {
      // 捨てた分を畳みの待ちに残さない: 本文が無いものを待っても取られない
      this.#pickupsSinceShutdown.delete(pickupKey('archive', drop.managerId, drop.archiveId));
      noteDroppedRecord(
        '預けた生ログの退避',
        `managerId=${drop.managerId} archiveId=${drop.archiveId} chars=${String(drop.chars)} reason=${drop.reason}`,
        new Error('デーモンが取りに来ないまま捨てた'),
      );
    },
  });
  #daemonAcceptsArchiveRef = false;
  // 畳み始めに残っていた物と畳み始めてから出した物のうち、デーモンに HTTP で取りに来させる物（預けた生ログ・出し箱・未追跡の預かりの退避先ファイル。#4912）。取られる（消される）と外す（#4699）
  #shuttingDown = false;
  readonly #pickupsSinceShutdown = new Set<string>();
  // このプロセスが出来事で送り、まだデーモンに取られていない出し箱・預かりのファイル（#4912）。畳み始めに `#pickupsSinceShutdown` へ積む
  // 値は送った時刻（ms）。古いものは畳みの待ちに数えない（#4925）
  readonly #emittedPickups = new Map<string, number>();
  readonly #finishUnpushedWorkFn:
    ((options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>) | undefined;
  readonly #cwdExistsFn: (cwd: string) => boolean;
  readonly #workerToolWatchClock: WorkerToolWatchClock | undefined;

  constructor(options: RunnerHostOptions) {
    this.#workerToolWatchClock = options.workerToolWatchClock;
    this.runnerId = options.runnerId;
    this.workspacePath = options.workspacePath;
    this.#emit = (event) => {
      this.#notePickup(event);
      options.emit(event);
    };
    this.#queryFn = options.queryFn;
    this.#env = options.env ?? process.env;
    this.#withheldEnvKeys = [...WITHHELD_ENV_KEYS, ...(options.withheldEnvKeys ?? [])];
    this.#childUser = options.childUser;
    this.#attachmentsRoot = options.attachmentsRoot ?? defaultRunnerAttachmentsRoot();
    this.attachmentStageLimit =
      options.attachmentStageLimit ?? readRunnerAttachmentStageLimit(this.#env);
    this.#outboxRoot = options.outboxRoot ?? defaultRunnerOutboxRoot();
    this.#managerScratchRoot = options.managerScratchRoot ?? '/tmp';
    this.#outboxStagedRoot = options.outboxStagedRoot ?? defaultRunnerOutboxStagedRoot();
    this.#rescueStagedRoot = options.rescueStagedRoot ?? defaultRunnerRescueStagedRoot();
    this.#outboxRemoveContentsAsChild = options.outboxRemoveContentsAsChild;
    this.#pluginsRoot = options.pluginsRoot ?? defaultRunnerPluginsRoot();
    this.#peer = options.peer;
    this.#managerTools = options.managerTools;
    this.#credentials = options.credentials;
    this.#permissionMode = options.permissionMode ?? resolvePermissionMode(this.#env);
    this.#bashGuard = resolveBashGuardMode(this.#env);
    this.#enforceLease = options.enforceLease ?? false;
    this.#spawnAgentProcessFn = options.spawnAgentProcessFn;
    this.#delegationSubreaper = options.delegationSubreaper;
    this.#handOverResumeConfigDirFn = options.handOverResumeConfigDirFn;
    this.#handOverMcpConfigDirFn = options.handOverMcpConfigDirFn;
    this.#mcpConfigTmpRoot = options.mcpConfigTmpRoot ?? tmpdir();
    this.#contextUsageTimeoutMs = options.contextUsageTimeoutMs;
    this.#sessionAllowRulesTimeoutMs = options.sessionAllowRulesTimeoutMs;
    this.#rescueMaxWorktrees = options.rescueMaxWorktrees;
    this.#readCgroupEventCountersFn = options.readCgroupEventCountersFn;
    this.#readPids =
      options.readPidsFn === undefined ? undefined : cachedPidsReader(options.readPidsFn);
    this.#finishUnpushedWorkFn = options.finishUnpushedWorkFn;
    this.#cwdExistsFn = options.cwdExistsFn ?? directoryExists;
    this.#codexAuth = new CodexAuthMirror({
      codexHome: options.codexHome ?? defaultCodexHome(options.childUser),
      ...(options.childUser === undefined
        ? {}
        : { owner: { uid: options.childUser.uid, gid: options.childUser.gid } }),
      onNotice: (notice) => this.#emit({ type: 'codex_auth', runnerId: this.runnerId, ...notice }),
    });
    const codexAuthTimer = setInterval(
      () => void this.#codexAuth.check().catch(() => undefined),
      options.codexAuthCheckIntervalMs ?? 60_000,
    );
    // unref する: 見張りでプロセスの終了を引き延ばさないため
    codexAuthTimer.unref?.();
    this.#codexAuthTimer = codexAuthTimer;
    // 起動時の判定（多くは閉じていて、デーモンが繋いで資格を降ろしたときに開く）
    if (this.#peer !== undefined) {
      const initial = resolvePeerOpening(this.#peerPresence());
      // 開く側はソケットを開いてから立てる（`#refreshPeers`）。閉じている側は最初から名乗れる
      if (initial.open.length === 0) this.#peerOpening = initial;
      else void this.#refreshPeers();
    }
    const rescueTimer = setInterval(
      () => {
        for (const session of [...this.#sessions.values()]) void session.rescueRef();
      },
      options.rescueIntervalMs ?? resolveRescueIntervalMs(this.#env),
    );
    rescueTimer.unref?.();
    this.#rescueTimer = rescueTimer;
    if (options.scratchSweep !== false) {
      const { intervalMs, ...sweepOptions } = options.scratchSweep ?? {};
      const sweeper = new ScratchSweeper({
        tmpRoot: '/tmp',
        graceMs: resolveScratchSweepGraceMs(this.#env),
        startedAt: Date.now(),
        ...sweepOptions,
        spawn: (spawnOptions) =>
          this.#childUser === undefined
            ? spawn(spawnOptions.command, spawnOptions.args, {
                ...(spawnOptions.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
                env: spawnOptions.env,
                signal: spawnOptions.signal,
                stdio: ['ignore', 'pipe', 'pipe'],
              })
            : this.#spawnAsChildUser(spawnOptions),
        env: this.#baseChildEnv(),
        liveManagerIds: () => [...this.#sessions.keys()],
        knownManagerIds: () => [...this.#knownManagerIds],
      });
      const scratchTimer = setInterval(
        () => {
          if (this.#attachmentPruning === null) {
            const prune = pruneStaleAttachmentDirs(
              this.#attachmentsRoot,
              [...this.#sessions.keys()],
              Date.now(),
            )
              .catch(() => 0)
              .then(() => undefined)
              .finally(() => {
                this.#attachmentPruning = null;
              });
            this.#attachmentPruning = prune;
          }
          // 出し箱と退避先の取りこぼしも、添付と同じ周期・同じ基準（生きた委譲に当たらず24時間触れていない）で消す
          // `#attachmentPruning` の鎖に乗せない: 添付の掃除が長引いても出し箱の掃除を止めないため（失敗は握る）
          // 出し箱の root は子の権限で消す（担い手が書ける木を runner の権限で再帰削除しない）
          // 非同期（#4906）: 同一プロセスの runner では、走査と削除の同期 I/O がデーモンのメインのループを止める。重ならないよう1本ずつ走らせる
          if (this.#outboxPruning === null) {
            this.#outboxPruning = pruneStaleOutboxRoots(
              {
                outboxRoot: this.#outboxRoot,
                stagedRoot: this.#outboxStagedRoot,
                rescueStagedRoot: this.#rescueStagedRoot,
              },
              () => [...this.#sessions.keys()],
              Date.now(),
              this.#outboxRemoval(),
            )
              .catch(() => undefined)
              .finally(() => {
                this.#outboxPruning = null;
              });
          }
          // scratch の掃きの鎖に乗せない: あちらは git の判定で長引きうるが、資格入りのファイルを長く残さないため
          this.#kickMcpConfigSweep();
          if (this.#scratchRunning !== null || this.#scratchAbort.signal.aborted) return;
          const run = sweeper
            .sweep(this.#scratchAbort.signal, this.runnerId)
            .then((event) => {
              if (event !== null && !this.#scratchAbort.signal.aborted) this.#emit(event);
            })
            .catch(() => {})
            .finally(() => {
              this.#scratchRunning = null;
            });
          this.#scratchRunning = run;
        },
        intervalMs ?? resolveScratchSweepIntervalMs(this.#env),
      );
      scratchTimer.unref?.();
      this.#scratchTimer = scratchTimer;
      // 起動時にも1回掃く（#5186）: 前の runner が落ちて残した資格入りのファイルを、最初の周期（既定10分）まで残さないため
      if (options.sweepMcpConfigOnStart === true) this.#kickMcpConfigSweep();
    }
    if (this.#enforceLease) {
      const watcher = setInterval(() => this.#checkLeaseExpiry(), LEASE_WATCH_INTERVAL_MS);
      watcher.unref?.();
      this.#leaseWatcher = watcher;
    }
    this.#profile =
      options.profile === undefined
        ? undefined
        : createProfileApplier({
            vessel: options.profile,
            baseEnv: () => this.#baseChildEnv(),
            // root で読まない: 降りた先では読めないプロファイルを「置けた」と報告することになるため
            ...(this.#childUser === undefined
              ? {}
              : { spawnFn: (spawnOptions) => this.#spawnAsChildUser(spawnOptions) }),
          });
    this.#announcedAnthropicRoute = JSON.stringify(this.anthropicRoute());
    this.#log = options.log;
    this.#announcedBashShapeGuard = this.bashShapeGuardLine();
    this.#announcedReportLanguage = this.reportLanguageLine();
  }

  credentials(): CredentialFingerprint[] {
    return this.#credentials?.fingerprints() ?? [];
  }

  // 前の掃きが続いている間は重ねない
  #kickMcpConfigSweep(): void {
    if (this.#mcpConfigSweeping || this.#scratchAbort.signal.aborted) return;
    this.#mcpConfigSweeping = true;
    void this.#sweepMcpConfigDirs().finally(() => {
      this.#mcpConfigSweeping = false;
    });
  }

  // runner が落ちると、委譲の CLI の MCP 設定（資格入り）のディレクトリが残る。消すのは自分の権限で行う（ディレクトリは子の uid の持ち主）
  async #sweepMcpConfigDirs(): Promise<void> {
    try {
      const { removed, failed, scanError } = await sweepRunnerMcpConfigDirs({
        tmpRoot: this.#mcpConfigTmpRoot,
        liveDirs: this.#liveMcpConfigDirs,
        now: Date.now(),
      });
      if (this.#scratchAbort.signal.aborted) return;
      // 失敗は note ではなく scratch_sweep の kept / scanError へ載せる: note は担当の managerId を要するが、この掃きは担当に属さない
      const keys = [
        ...failed.map((f) => `${f.name}\u0000${f.reason}`),
        ...(scanError === undefined ? [] : [`__scan__\u0000${scanError}`]),
      ];
      const notified = this.#mcpConfigSweepFailedNotified;
      this.#mcpConfigSweepFailedNotified = new Set(keys);
      const kept = failed
        .filter((f) => !notified.has(`${f.name}\u0000${f.reason}`))
        .map((f) => ({
          name: f.name,
          kind: 'directory' as const,
          reason: 'rm-failed' as const,
          detail: `委譲の CLI の MCP 設定の残骸を掃けなかった: ${f.reason}`,
        }));
      const newScanError =
        scanError !== undefined && !notified.has(`__scan__\u0000${scanError}`)
          ? scanError
          : undefined;
      if (removed.length === 0 && kept.length === 0 && newScanError === undefined) return;
      this.#emit({
        type: 'scratch_sweep',
        runnerId: this.runnerId,
        removed: removed.map((name) => ({ name, kind: 'directory' as const })),
        kept,
        ...(newScanError === undefined ? {} : { scanError: newScanError }),
      });
    } catch {
      // 掃きの失敗で runner の周期を止めない
    }
  }

  noteDaemonContact(): void {
    this.#lastDaemonContact = Date.now();
  }

  // 本数は「手を動かしている担当」だけを数える（ターン中・返事待ち・背景処理が残っている）: 手が空いた done の担当まで数えると、
  // 知らせを読む担当が「pids を分け合っている相手」を多く見積もり、自分の分を軽く見るため
  async #pidsPressureReading(): Promise<PidsPressureReading | undefined> {
    const pids = await this.#readPids?.();
    if (pids === undefined) return undefined;
    let active = 0;
    for (const session of this.#sessions.values()) {
      const state = session.state();
      if (
        state.status === 'running' ||
        state.status === 'waiting_human' ||
        (state.liveBackgroundTasks ?? 0) > 0
      ) {
        active += 1;
      }
    }
    return { current: pids.current, max: pids.max, delegations: active };
  }

  delegationPidOwnerRecords(): { remembered: number; cap: number; forgottenTotal: number } {
    return {
      remembered: this.#pidOwnerManagerId.size,
      cap: PID_OWNER_MANAGER_ID_CAP,
      forgottenTotal: this.#pidOwnerForgottenTotal,
    };
  }

  delegationSessionPids(): {
    live: ReadonlySet<number>;
    knownTerminated: ReadonlySet<number>;
    ownerListed: ReadonlySet<number>;
    abandonedOwnerListed: ReadonlySet<number>;
  } {
    // 内部の集合への参照を渡さない: 渡した後に書き換えられないという前提が呼び出し側の実装に依存するため（写しを返す）
    const knownTerminated = new Set<number>();
    const ownerListed = new Set<number>();
    const abandonedOwnerListed = new Set<number>();
    const now = Date.now();
    for (const [pid, managerId] of this.#pidOwnerManagerId) {
      if (this.#liveDelegationPids.has(pid)) continue;
      const ownerIsListed = this.#sessions.has(managerId) || this.#awaitingReturn(managerId, now);
      // failed / lost / abandonTree で閉じた CLI の pid は、同じ managerId が戻っていても ownerListed へ移さない: 落ちた CLI の木（CLI の枝）を守ると resume のたびに pid が溜まるため（#4433）
      if (ownerIsListed && !this.#abandonedDelegationPids.has(pid)) {
        ownerListed.add(pid);
        continue;
      }
      // 持ち主が名簿に居る間は knownTerminated に残したまま `abandonedOwnerListed` にも入れる（#5162・#5168）:
      // ownerListed へ移すと「撃つ側」の経路（帰属・先祖・台帳の継ぎ）が全部切れ、CLI の枝まで撃てなくなる。
      // 撃つ範囲を CLI の枝へ絞るのは回収の判定の側で、ここは「絞る対象の pid」を渡すだけにする
      if (ownerIsListed && this.#abandonedDelegationPids.has(pid)) abandonedOwnerListed.add(pid);
      knownTerminated.add(pid);
    }
    return {
      live: new Set(this.#liveDelegationPids),
      knownTerminated,
      ownerListed,
      abandonedOwnerListed,
    };
  }

  // 鍵の付け替えの畳み（`stop(…, { keepPeers: true })`）と failed / lost の閉じは終端ではない: 名簿から消えてから resume で戻るまでの窓に走査が当たると、
  // 担当が自分で起こした postgres（`pg_ctl` が setsid して tini に引き取られたもの）が終端した委譲の残骸として SIGTERM を受けるため（#5115・#5168）。
  // failed / lost の CLI の枝は、戻り待ちの間も `abandonedOwnerListed` として撃つ（#4433）。守るのは引き取られた枝だけである。
  // 期限は預けた peer と同じ: 戻らない担当の木を永久に守らないため
  #awaitingReturn(managerId: string, now: number): boolean {
    const since = this.#returnAwaitedSince.get(managerId);
    if (since === undefined) return false;
    if (now - since < PEER_PARK_TTL_MS) return true;
    this.#returnAwaitedSince.delete(managerId);
    return false;
  }

  #noteDelegationProcessSpawned(pid: number, managerId: string): void {
    this.#liveDelegationPids.add(pid);
    // `set` の前に `delete` する: 挿入順を今に更新するため（pid が再利用された場合の所有者の付け替えも兼ねる）
    this.#pidOwnerManagerId.delete(pid);
    this.#pidOwnerManagerId.set(pid, managerId);
    // 使い回された pid は新しい CLI のもの: 残すと生きている新しい CLI の木を撃つ側へ回すため
    this.#abandonedDelegationPids.delete(pid);
    while (this.#pidOwnerManagerId.size > PID_OWNER_MANAGER_ID_CAP) {
      const oldestPid = this.#pidOwnerManagerId.keys().next().value;
      if (oldestPid === undefined) break;
      this.#pidOwnerManagerId.delete(oldestPid);
      this.#pidOwnerForgottenTotal += 1;
      // 所有者を忘れた pid は覚えない: 集合が際限なく育つため
      this.#abandonedDelegationPids.delete(oldestPid);
    }
  }

  #noteDelegationProcessExited(pid: number): void {
    this.#liveDelegationPids.delete(pid);
    // 所有者の記録（`#pidOwnerManagerId`）を消さない: 後で委譲が本当に終端したとき、この pid を `knownTerminated` へ回す手がかりが無くなるため
  }

  // `lease` を伴わないセッションは畳まない: 世代の約束をしていないセッションを理由なく畳むことになるため
  #checkLeaseExpiry(): void {
    const now = Date.now();
    for (const [managerId, session] of [...this.#sessions.entries()]) {
      const ttlMs = session.leaseTtlMs;
      if (ttlMs === undefined) continue;
      if (now - this.#lastDaemonContact < ttlMs) continue;
      void session
        .selfFence(
          'デーモンと連絡が取れないので貸し出し期限が切れた（自己失効）。' +
            `最後に接触があったのは ${new Date(this.#lastDaemonContact).toISOString()}、` +
            `約束していた貸し出し期限は ${ttlMs}ms。`,
        )
        // 黙って落とさない: 握らないと器のログにしか出ず、引き取る側は相手が自分で畳んだ前提で期限を数えているため
        .catch((error: unknown) => {
          this.#emit({
            type: 'note',
            managerId,
            text: `貸し出し期限の自己失効に失敗した（このセッションは畳まれていない可能性がある）: ${reasonOf(error)}`,
          });
        });
    }
  }

  async setCredentials(entries: readonly CredentialEntry[]): Promise<CredentialFingerprint[]> {
    if (this.#credentials === undefined) {
      throw new Error(
        '鍵の器が無い runner では差し替えられない（ALTEROID_CREDENTIAL_DIR を用意すること）',
      );
    }
    const before = fingerprintsByName(this.#credentials.fingerprints());
    const fingerprints = await this.#credentials.set(entries);
    const after = fingerprintsByName(fingerprints);
    // 値を読まず指紋だけで比べる。SDK 子プロセスの env は起動時に凍るので、畳まないと更新が次のセッション作り直しまで届かない
    if (!sameFingerprints(before, after)) {
      // Claude の鍵が変わったかを別に渡す: 作業者の落ちの知らせが「回転前の鍵で走っている」と言うのは、その回だけのため（#5021）
      const claudeKeyChanged = POOL_OWNED_CREDENTIAL_NAMES.some(
        (name) => before.get(name) !== after.get(name),
      );
      for (const session of this.#sessions.values()) session.recycleForToken(claudeKeyChanged);
    }
    this.#announceAnthropicRoute();
    // `CODEX_API_KEY` が届いた・外れたら peer の開閉が変わる
    await this.#refreshPeers();
    return fingerprints;
  }

  managerPeers(): RunnerManagerPeersAnnouncement | undefined {
    if (this.#peer === undefined) return undefined;
    const models = this.#peer.models ?? {};
    const closed = this.#peerOpening.closed.map((entry) => ({
      provider: entry.provider,
      reason: entry.reason,
    }));
    return {
      managerPeers: this.#peerOpening.open.map((provider) => {
        const open = models[provider];
        return open === undefined ? { provider } : { provider, models: [...open] };
      }),
      ...(closed.length === 0 ? {} : { managerPeersClosed: closed }),
    };
  }

  // 値は読まず「在るか」だけを見る（`CodexManagerDriver` が鍵を読むのと同じ袋・同じ名前）
  #peerPresence(): { codexApiKey: boolean; codexChatgptLogin: boolean } {
    const apiKey = this.#credentials?.values()[CODEX_API_KEY_ENV_NAME] ?? '';
    return {
      codexApiKey: apiKey.trim() !== '',
      codexChatgptLogin: this.#codexAuth.status().placed,
    };
  }

  /**
   * 届いている資格から peer の開閉を決め直す。初めて開くときにソケットを作る。
   * **変わったときだけ** `manager_peers` で名乗り直し、開いている provider が変わったら走行中のセッションを
   * 次の区切りで組み直す（MCP の道具はセッションを組む瞬間に決まるので、組み直さないと道具が出ない・消えない）。
   */
  #refreshPeers(): Promise<void> {
    const peer = this.#peer;
    if (peer === undefined) return Promise.resolve();
    const run = async (): Promise<void> => {
      let opening = resolvePeerOpening(this.#peerPresence());
      if (opening.open.length > 0 && this.#peerSocket === undefined) {
        try {
          this.#peerSocket = await peer.openSocket();
        } catch (error) {
          // 開けなかったら閉じている側へ倒し、理由を名乗る（次に資格が降りたときにもう一度試す）
          opening = {
            open: [],
            closed: opening.open.map((provider) => ({
              provider,
              reason: `peer 用のソケットを開けなかった: ${reasonOf(error)}`,
            })),
          };
        }
      }
      const before = this.#peerOpening;
      if (samePeerOpening(before, opening)) return;
      this.#peerOpening = opening;
      const announcement = this.managerPeers();
      if (announcement !== undefined) {
        this.#emit({ type: 'manager_peers', runnerId: this.runnerId, ...announcement });
      }
      if (before.open.join(',') !== opening.open.join(',')) {
        for (const session of this.#sessions.values()) session.recycleForToken();
      }
    };
    const next = this.#peerChain.then(run, run);
    this.#peerChain = next.catch(() => undefined);
    return next;
  }

  /** セッションへ渡す peer（開いている provider が無い・ソケットが無いなら `undefined` = 道具を出さない）。 */
  #sessionPeer(): RunnerPeerOptions | undefined {
    const peer = this.#peer;
    const host = this.#peerSocket;
    if (peer === undefined || host === undefined) return undefined;
    const peers = this.#peerOpening.open;
    if (peers.length === 0) return undefined;
    return {
      host,
      peers,
      reportsUsage: peer.reportsUsage,
      ...(peer.models === undefined ? {} : { models: peer.models }),
      ...(peer.childEntry === undefined ? {} : { childEntry: peer.childEntry }),
      ...(peer.workdirRoot === undefined ? {} : { workdirRoot: peer.workdirRoot }),
    };
  }

  profile(): RunnerProfileFingerprint | undefined {
    return this.#profile?.fingerprint();
  }

  // 評価せずに置かない: 構文を間違えたスクリプトが `BASH_ENV` に載り、以後すべてのコマンドが壊れた環境で走るため
  async setProfile(script: string): Promise<RunnerProfileResult> {
    if (this.#profile === undefined) {
      throw new Error(
        'プロファイルの器が無い runner では差し替えられない（ALTEROID_PROFILE_FILE を用意すること）',
      );
    }
    const result = await this.#profile.apply(script);
    this.#announceAnthropicRoute();
    this.#announceBashShapeGuard();
    this.#announceReportLanguage();
    return result;
  }

  // 起動行に出す1行。不正な値でも投げない（起動は落とさない）
  bashShapeGuardLine(): string {
    return describeBashShapeGuard(this.#env, this.#profile?.env() ?? {});
  }

  // 実効の値が前回と変わったときだけ1行出し直す（新しいプロトコルの出来事は足さない）
  #announceBashShapeGuard(): void {
    const line = this.bashShapeGuardLine();
    if (line === this.#announcedBashShapeGuard) return;
    this.#announcedBashShapeGuard = line;
    this.#log?.(`alteroid-runner: ${line}`);
  }

  // 起動行に出す1行。不正な値でも投げない（起動は落とさない）
  reportLanguageLine(): string {
    return describeReportLanguage(this.#env, this.#profile?.env() ?? {});
  }

  // 実効の値が前回と変わったときだけ1行出し直す（`#announceBashShapeGuard` と同じ）
  #announceReportLanguage(): void {
    const line = this.reportLanguageLine();
    if (line === this.#announcedReportLanguage) return;
    this.#announcedReportLanguage = line;
    this.#log?.(`alteroid-runner: ${line}`);
  }

  anthropicRoute(): string[] {
    return describeAnthropicRoute(
      inspectAnthropicRoute(
        childEnvLayers({
          env: this.#env,
          credentials: this.#credentials,
          profileEnv: this.#profile?.env() ?? {},
        }),
      ),
    );
  }

  // 変わったときだけ名乗り直す: 同じ値が繋ぎ直しのたびに降りてくるため
  #announceAnthropicRoute(): void {
    const anthropicRoute = this.anthropicRoute();
    const key = JSON.stringify(anthropicRoute);
    if (key === this.#announcedAnthropicRoute) return;
    this.#announcedAnthropicRoute = key;
    this.#emit({ type: 'anthropic_route', runnerId: this.runnerId, anthropicRoute });
  }

  mcpServers(): RunnerMcpServersFingerprint | undefined {
    return this.#mcpServers?.fingerprint;
  }

  setMcpServers(input: unknown): RunnerMcpServersFingerprint | undefined {
    // 届いたものを信じずにもう一度検査する: ここは制御面の入口のため
    const servers = parseMcpServers(input);
    if (Object.keys(servers).length === 0) {
      this.#mcpServers = undefined;
      return undefined;
    }
    this.#mcpServers = {
      servers,
      fingerprint: {
        sha256: mcpServersFingerprintOf(servers),
        names: mcpServerNames(servers),
        updatedAt: new Date().toISOString(),
      },
    };
    return this.#mcpServers.fingerprint;
  }

  setPermissionRules(input: unknown): RunnerPermissionRulesResult {
    // 届いたものを信じずにもう一度検査する: ここは制御面の入口のため
    const rules = parseDelegatedPermissionRules(input);
    const changed = !sameRuleSet(rules, this.#permissionRules);
    this.#permissionRules = rules;
    // 変わらなければ置き直さない: 名乗り直しのたびに同じ一覧が降りてくるため
    if (changed) {
      for (const session of this.#sessions.values()) session.reapplyPermissionRules();
    }
    return { count: rules.length, changed };
  }

  plugins(): RunnerPluginsFingerprint | undefined {
    if (this.#plugins.size === 0) return undefined;
    const plugins = [...this.#plugins.values()]
      .map((p) => ({
        name: p.name,
        sha: p.sha,
        contentSha256: p.contentSha256,
        enableHooks: p.enableHooks,
        enableMcp: p.enableMcp,
      }))
      .sort((a, b) => compareCodeUnits(a.name, b.name));
    return {
      sha256: pluginsFingerprintOf(plugins),
      plugins,
      updatedAt: this.#pluginsUpdatedAt,
    };
  }

  async setPlugin(name: string, input: unknown): Promise<RunnerPluginFingerprintEntry> {
    // 検査の正本は daemon の器と同じ `parseRunnerPlugin`。届いたものを信じずにもう一度通す。
    const plugin = parseRunnerPlugin(input);
    if (plugin.name !== name) throw new Error('plugin の名前が URL の名前と合わない');
    const entry = {
      name: plugin.name,
      sha: plugin.sourceSha,
      contentSha256: plugin.contentSha256,
      enableHooks: plugin.enableHooks,
      enableMcp: plugin.enableMcp,
    };
    return this.#withPluginsLock(async () => {
      let path: string;
      try {
        const extracted = await extractPlugin(
          this.#pluginsRoot,
          { ...plugin, source: { sha: plugin.sourceSha } },
          // 子 uid は読めて書けず、差し替えられない（root 所有の 0o755）。
          runnerPluginsDirOptions(),
        );
        path = extracted.path;
      } catch (error) {
        throw new RunnerPluginExtractError(error);
      }
      // 展開に成功してから差し替える（失敗したら前の状態が残る）。
      this.#plugins.set(plugin.name, {
        ...entry,
        path,
        skipMcpDiscovery: !plugin.enableMcp,
      });
      this.#pluginsUpdatedAt = new Date().toISOString();
      await this.#pruneUnusedPlugins();
      return entry;
    });
  }

  retainPlugins(names: readonly string[]): RunnerPluginsFingerprint | undefined {
    const keep = new Set(names);
    let removed = false;
    for (const name of [...this.#plugins.keys()]) {
      if (keep.has(name)) continue;
      this.#plugins.delete(name);
      removed = true;
    }
    if (removed) {
      this.#pluginsUpdatedAt = new Date().toISOString();
      this.#schedulePluginPrune();
    }
    return this.plugins();
  }

  /** セッションの `Options.plugins` へ渡す、展開済みの plugin（名前順）。 */
  #pluginRefs(): readonly AgentClonePlugin[] {
    return [...this.#plugins.values()]
      .sort((a, b) => compareCodeUnits(a.name, b.name))
      .map((p) => ({ path: p.path, skipMcpDiscovery: p.skipMcpDiscovery }));
  }

  #withPluginsLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#pluginsChain.then(task);
    this.#pluginsChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #schedulePluginPrune(): void {
    void this.#withPluginsLock(() => this.#pruneUnusedPlugins());
  }

  /**
   * 一覧に無い版・外したもの・書き残しの `.tmp-*` をディスクから消す。**走行中のセッションが1つでもあれば
   * 何もしない**（その版を読んでいるかもしれない）。呼び手は必ず {@link #withPluginsLock} の中。
   */
  async #pruneUnusedPlugins(): Promise<void> {
    if (this.#sessions.size > 0) return;
    const keep = new Set([...this.#plugins.values()].map((p) => basename(p.path)));
    await pruneExtractedPluginDirs(this.#pluginsRoot, keep).catch(() => undefined);
  }

  codexAuth(): CodexAuthMirrorStatus {
    return this.#codexAuth.status();
  }

  async setCodexAuth(push: CodexAuthPush): Promise<CodexAuthMirrorStatus> {
    await this.#codexAuth.set(push);
    // ログインが届いた・外れた（ログアウト）なら peer の開閉が変わる。トークンの更新では変わらない
    await this.#refreshPeers();
    return this.#codexAuth.status();
  }

  takeCodexAuthWriteBack(fingerprint: string): CodexAuthWriteBack | null {
    return this.#codexAuth.takeWriteBack(fingerprint);
  }

  // 素の `process.env` で評価しない: プロファイル内で `gh` を叩く書き方が評価時だけ失敗するため
  #baseChildEnv(): NodeJS.ProcessEnv {
    const env = { ...this.#env };
    if (this.#credentials !== undefined) {
      Object.assign(env, this.#credentials.values(), this.#credentials.env());
    }
    for (const key of this.#withheldEnvKeys) delete env[key];
    return env;
  }

  #spawnAsChildUser(options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) {
    return spawnAsUser(this.#childUser as RunnerChildUser, options);
  }

  // 実在しない `cwd` を `query()` へそのまま渡さない: 移送先の器に無いと SDK が `chdir` で `ENOENT` になり、libc 不一致に見える形でセッションが開けなくなるため
  #resolveCwd(cwd: string): string {
    if (cwd.length === 0) return this.workspacePath;
    if (!this.#cwdExistsFn(cwd)) return this.workspacePath;
    return cwd;
  }

  #create(managerId: string, request: string, cwd: string): RunnerSession {
    const sessionGeneration = randomUUID();
    // セッションごとに持つ（host の集合に直接足さない）: 終わり方が分かるのは閉じた後で、それまでは守る側のままにするため
    const spawnedPids = new Set<number>();
    const session = new RunnerSession({
      onPeersParked: (parked) => this.#parkPeers(managerId, parked),
      onCloseRescue: (rescue) => {
        this.#closeRescues.add(rescue);
        void rescue.finally(() => this.#closeRescues.delete(rescue));
      },
      managerId,
      request,
      cwd: this.#resolveCwd(cwd),
      emit: (event) => this.#emit(withSessionGeneration(event, sessionGeneration)),
      ...(this.#queryFn === undefined ? {} : { queryFn: this.#queryFn }),
      env: this.#env,
      withheldEnvKeys: this.#withheldEnvKeys,
      ...(this.#childUser === undefined ? {} : { childUser: this.#childUser }),
      ...(this.#credentials === undefined ? {} : { credentials: this.#credentials }),
      permissionMode: this.#permissionMode,
      bashGuard: this.#bashGuard,
      // 組むたびに読み直す口を渡す: 開閉は資格が届く・外れるたびに変わるため
      ...(this.#peer === undefined ? {} : { peer: () => this.#sessionPeer() }),
      ...(this.#managerTools === undefined ? {} : { managerTools: this.#managerTools }),
      codexAuth: this.#codexAuth,
      profileEnv: () => this.#profile?.env() ?? {},
      mcpServers: () => this.#mcpServers?.servers,
      permissionRules: () => this.#permissionRules,
      plugins: () => this.#pluginRefs(),
      onClosed: (outcome) => {
        // `stop()` は outcome を渡さない（done・停止からの resume は守る）: 落ちた・失効した CLI だけを撃つ側に残すため。
        // 鍵の付け替えの畳みで背景処理を畳んだ回（`abandonTree`）も撃つ側に残す（#5044）: 同じ担当がすぐ resume で戻り、守ると畳んだはずの背景処理が走り続けて、やり直しと取り合うため
        if (
          outcome !== undefined &&
          ('abandonTree' in outcome || outcome.status === 'failed' || outcome.status === 'lost')
        ) {
          for (const pid of spawnedPids) {
            // 所有者が今も自分の pid だけ入れる: CAP で忘れた・使い回された pid を足すと集合が育つ・別の CLI を撃つため
            if (this.#pidOwnerManagerId.get(pid) !== managerId) continue;
            this.#abandonedDelegationPids.add(pid);
          }
        }
        // failed / lost は戻り待ちにする（#5168）: 枠で落ちた担当は通る鍵で起こし直されるが、名簿から消えてから resume までの窓
        // （鍵が尽きていれば数時間）に走査が当たると、担当の postgres を落ちた CLI の木ごと撃つため。名簿から消すのと同じ同期の区間で立てる
        if (
          outcome !== undefined &&
          'status' in outcome &&
          (outcome.status === 'failed' || outcome.status === 'lost')
        ) {
          this.#returnAwaitedSince.set(managerId, Date.now());
        }
        this.#sessions.delete(managerId);
        this.#schedulePluginPrune();
        this.#removeAttachments(managerId);
        // 例外を握る: 消せなかった出し箱は24時間の掃除が消す。ここで投げると `closed` の後始末が途中で止まる
        try {
          // 退避先は消さない: 最後の報告の直後に `closed` が来るので、消すとデーモンが取りに来る前に最終報告のファイルが消える
          removeManagerOutbox(this.#outboxRoot, managerId, this.#outboxRemoval());
        } catch {
          // 取りこぼしは掃除に任せる
        }
      },
      outboxRoot: this.#outboxRoot,
      outboxStagedRoot: this.#outboxStagedRoot,
      rescueStagedRoot: this.#rescueStagedRoot,
      managerScratchRoot: this.#managerScratchRoot,
      attachmentStageLimit: this.attachmentStageLimit,
      onDelegationProcessSpawned: (pid) => {
        spawnedPids.add(pid);
        this.#noteDelegationProcessSpawned(pid, managerId);
      },
      onDelegationProcessExited: (pid) => this.#noteDelegationProcessExited(pid),
      ...(this.#spawnAgentProcessFn === undefined
        ? {}
        : { spawnAgentProcessFn: this.#spawnAgentProcessFn }),
      ...(this.#delegationSubreaper === undefined
        ? {}
        : { delegationSubreaper: this.#delegationSubreaper }),
      ...(this.#handOverResumeConfigDirFn === undefined
        ? {}
        : { handOverResumeConfigDirFn: this.#handOverResumeConfigDirFn }),
      ...(this.#handOverMcpConfigDirFn === undefined
        ? {}
        : { handOverMcpConfigDirFn: this.#handOverMcpConfigDirFn }),
      mcpConfigTmpRoot: this.#mcpConfigTmpRoot,
      liveMcpConfigDirs: this.#liveMcpConfigDirs,
      ...(this.#contextUsageTimeoutMs === undefined
        ? {}
        : { contextUsageTimeoutMs: this.#contextUsageTimeoutMs }),
      ...(this.#sessionAllowRulesTimeoutMs === undefined
        ? {}
        : { sessionAllowRulesTimeoutMs: this.#sessionAllowRulesTimeoutMs }),
      ...(this.#rescueMaxWorktrees === undefined
        ? {}
        : { rescueMaxWorktrees: this.#rescueMaxWorktrees }),
      ...(this.#readCgroupEventCountersFn === undefined
        ? {}
        : { readCgroupEventCountersFn: this.#readCgroupEventCountersFn }),
      ...(this.#readPids === undefined
        ? {}
        : { pidsPressureFn: () => this.#pidsPressureReading() }),
      stashArchive: (body: string) => this.#stashArchive(managerId, body),
      ...(this.#finishUnpushedWorkFn === undefined
        ? {}
        : { finishUnpushedWorkFn: this.#finishUnpushedWorkFn }),
      ...(this.#workerToolWatchClock === undefined
        ? {}
        : { workerToolWatchClock: this.#workerToolWatchClock }),
    });
    this.#generations.set(session, sessionGeneration);
    this.#sessions.set(managerId, session);
    this.#returnAwaitedSince.delete(managerId);
    this.#knownManagerIds.add(managerId);
    return session;
  }

  async start(command: RunnerStartCommand): Promise<{ cwd: string; sessionGeneration: string }> {
    if (this.#sessions.has(command.managerId)) {
      throw new Error(`${command.managerId} は既に走っている`);
    }
    // 添付をセッションを作った後に置かない: 置けなければセッションを作らずに断るため、ファイルが置かれる前に担い手が読む競りも避ける
    const placing = this.#attachmentInput(command.managerId, command.request, command.attachments);
    const input = placing instanceof Promise ? await placing : placing;
    if (this.#sessions.has(command.managerId)) {
      throw new Error(`${command.managerId} は既に走っている`);
    }
    const session = this.#create(command.managerId, command.request, command.cwd);
    try {
      session.checkFence(command.lease);
      session.begin(input.text, input.images);
    } catch (error) {
      this.#sessions.delete(command.managerId);
      this.#removeAttachments(command.managerId);
      throw error;
    }
    return { cwd: session.cwd, ...this.#generationOf(session) };
  }

  // 畳み中の alive へ合流しない（畳み終わるのを待ってから作り直す）: push は黙って捨てられ、待たずに作ると古い畳みの `#onClosed()` が新しいセッションを名簿から消すため
  async resume(command: RunnerResumeCommand): Promise<{
    cwd: string;
    reusedLiveSession: boolean;
    sessionGeneration: string;
  }> {
    let alive = this.#sessions.get(command.managerId);
    for (;;) {
      if (alive) {
        alive.checkFence(command.lease);
        let current: RunnerSession | undefined = alive;
        while (current !== undefined) {
          if (!current.stopping) {
            if (command.message === undefined) {
              return { cwd: current.cwd, reusedLiveSession: true, ...this.#generationOf(current) };
            }
            const placing = this.#attachmentInput(
              command.managerId,
              command.message,
              command.attachments,
            );
            const input = placing instanceof Promise ? await placing : placing;
            // 置いている間に畳まれたら積まずに畳み待ちへ落ちる: `push()` は畳み済みなら黙って捨てるので、成功と答えると追加の一言が誰にも届かないため
            if (!current.stopping && this.#sessions.get(command.managerId) === current) {
              current.push(input.text, input.images);
              return { cwd: current.cwd, reusedLiveSession: true, ...this.#generationOf(current) };
            }
          }
          try {
            await current.stop('resume 待ちのため、畳み中のセッションの完了を待った。');
          } catch {
            // 投げ直さない: 待ちたいのは畳みの完了で、投げ直すと resume 自体が失敗したように見えるため
          }
          const next = this.#sessions.get(command.managerId);
          if (next === current) {
            this.#sessions.delete(command.managerId);
            current = undefined;
          } else {
            // 別のセッションが居れば作り直さず合流する: 同じ managerId のセッションが2本開くため
            current = next;
          }
        }
      }
      const resumePlacing =
        command.message === undefined
          ? undefined
          : this.#attachmentInput(command.managerId, command.message, command.attachments);
      const resumeInput = resumePlacing instanceof Promise ? await resumePlacing : resumePlacing;
      // 見直さずに作らない: 同じ managerId のセッションが2本開き、先の1本が名簿から外れて孤児になるため
      // 置いた添付は消さない: 置き場は managerId 単位で、`#removeAttachments` を呼ぶと合流先の分まで消えるため
      const raced = this.#sessions.get(command.managerId);
      if (raced !== undefined) {
        alive = raced;
        continue;
      }
      const session = this.#create(command.managerId, command.request, command.cwd);
      session.checkFence(command.lease);
      // 鍵の付け替えで預けた peer を引き継ぐ（#4734）。組む道具が新しい窓口を作らないよう resume の前に渡し、預かった知らせは resume の後に回す
      const parked = this.#takeParkedPeers(command.managerId);
      if (parked !== undefined) session.adoptPeers(parked);
      session.resume(
        command.sessionId,
        command.entries,
        resumeInput?.text,
        resumeInput?.images,
        command.subagents,
        command.peers,
      );
      if (parked !== undefined) session.releaseAdoptedPeers();
      return { cwd: session.cwd, reusedLiveSession: false, ...this.#generationOf(session) };
    }
  }

  #generationOf(session: RunnerSession): { sessionGeneration: string } {
    return { sessionGeneration: this.#generations.get(session) ?? '' };
  }

  async send(
    managerId: string,
    text: string,
    attachments?: readonly RunnerAttachment[],
  ): Promise<boolean> {
    const session = this.#sessions.get(managerId);
    // 畳み中は積まず `false` を返す: `push()` は黙って捨てるので、`true` を返すと誰にも読まれない本文が 200 で返るため
    if (!session || session.stopping) return false;
    const placing = this.#attachmentInput(managerId, text, attachments);
    const input = placing instanceof Promise ? await placing : placing;
    if (session.stopping || this.#sessions.get(managerId) !== session) return false;
    session.push(input.text, input.images);
    return true;
  }

  #outboxRemoval(): OutboxRemovalOptions {
    return {
      ...(this.#childUser === undefined
        ? {}
        : { child: { uid: this.#childUser.uid, gid: this.#childUser.gid } }),
      ...(this.#outboxRemoveContentsAsChild === undefined
        ? {}
        : { removeContentsAsChild: this.#outboxRemoveContentsAsChild }),
    };
  }

  async openOutboxFile(managerId: string, fileId: string): Promise<StagedOutboxFile | undefined> {
    const file = await openStagedOutboxFile(this.#outboxStagedRoot, managerId, fileId);
    return this.#releaseWhenRead(file, pickupKey('outbox', managerId, fileId));
  }

  // 読み切られたら待ちから外す（#4912）: DELETE が落ちても、取り終えた分を上限まで待たない
  #releaseWhenRead(file: StagedOutboxFile | undefined, key: string): StagedOutboxFile | undefined {
    file?.stream.once('end', () => {
      this.#notePickedUp(key);
    });
    return file;
  }

  deleteOutboxFile(managerId: string, fileId: string): Promise<boolean> {
    this.#notePickedUp(pickupKey('outbox', managerId, fileId));
    return removeStagedOutboxFile(this.#outboxStagedRoot, managerId, fileId);
  }

  // 出し箱の退避先と同じ作り（`fileId` の形・`managerId` の形を検める）で、dir だけが別
  async openRescueFile(managerId: string, fileId: string): Promise<StagedOutboxFile | undefined> {
    const file = await openStagedOutboxFile(this.#rescueStagedRoot, managerId, fileId);
    return this.#releaseWhenRead(file, pickupKey('rescue', managerId, fileId));
  }

  deleteRescueFile(managerId: string, fileId: string): Promise<boolean> {
    this.#notePickedUp(pickupKey('rescue', managerId, fileId));
    return removeStagedOutboxFile(this.#rescueStagedRoot, managerId, fileId);
  }

  pendingPickups(): number {
    return this.#pickupsSinceShutdown.size;
  }

  /**
   * まだデーモンに取られていない預けた退避を、本文を載せた `archive` の出来事として送り直す（#4896）。
   * 待ちの期限までに取られなかった分を、器と一緒に失わないための最後の手。送った分は預かりから外す（同じ本文を二度送らない）。
   * 送った件数を返す。
   */
  inlineUnpickedArchives(): number {
    let sent = 0;
    for (const entry of this.#archiveStash.list()) {
      if (entry.fetched) continue;
      if (!this.#pickupsSinceShutdown.has(pickupKey('archive', entry.managerId, entry.id)))
        continue;
      const body = this.#archiveStash.get(entry.managerId, entry.id);
      if (body === undefined) continue;
      // 元の id を載せる: デーモンが同じ id を参照で取り寄せ中・取り終えなら、本文を二重に置かないため（#4899）
      this.#emit({ type: 'archive', managerId: entry.managerId, id: entry.id, body });
      this.deleteArchive(entry.managerId, entry.id);
      sent += 1;
    }
    return sent;
  }

  // 畳み始める前に emit した出し箱・rescue のファイルは、`#emittedPickups` に持ち、`shutdown()` が畳み始めに待ちへ積む（#4912）。
  // 積まないと、直前に emit した分をデーモンが取りに来る前に器が入れ替わり、退避先ごと失う（404 になる）。
  // 自分が送っていない退避先の残りは数えない。取りこぼしを待って入れ替えが遅れる分は、待ちの上限（`PICKUP_WAIT_LIMIT_MS`）が抑える
  #notePickup(event: RunnerEvent): void {
    if (event.type === 'report') {
      for (const file of event.files ?? []) {
        this.#noteEmittedPickup(pickupKey('outbox', event.managerId, file.fileId));
      }
    }
    // 畳む直前の最後の回の預かりを、デーモンが取りに来るまで待たせる（待たないと、器と一緒に未追跡のファイルが消える）
    if (event.type === 'rescue_files') {
      for (const file of event.files) {
        this.#noteEmittedPickup(pickupKey('rescue', event.managerId, file.fileId));
      }
    }
    if (!this.#shuttingDown) return;
    if (event.type === 'archive' && event.ref !== undefined) {
      this.#pickupsSinceShutdown.add(pickupKey('archive', event.managerId, event.ref.id));
    }
  }

  #noteEmittedPickup(key: string): void {
    // 入れ直しで時刻を新しくする: 同じ鍵を再び送ったなら、デーモンはまた取りに来る
    this.#emittedPickups.delete(key);
    this.#emittedPickups.set(key, Date.now());
    if (this.#shuttingDown) this.#pickupsSinceShutdown.add(key);
    // 上限: 取りに来ない旧いデーモンの下で、長く動く器の集合が増え続けないように（古い順に捨てる）
    if (this.#emittedPickups.size > EMITTED_PICKUPS_MAX) {
      const oldest = this.#emittedPickups.keys().next().value;
      if (oldest !== undefined) this.#emittedPickups.delete(oldest);
    }
  }

  #notePickedUp(key: string): void {
    this.#emittedPickups.delete(key);
    this.#pickupsSinceShutdown.delete(key);
  }

  setDaemonAcceptsArchiveRef(accepts: boolean): void {
    this.#daemonAcceptsArchiveRef = accepts;
  }

  readArchive(managerId: string, archiveId: string): string | undefined {
    return this.#archiveStash.get(managerId, archiveId);
  }

  markArchiveFetched(managerId: string, archiveId: string): void {
    this.#pickupsSinceShutdown.delete(pickupKey('archive', managerId, archiveId));
    this.#archiveStash.markFetched(managerId, archiveId);
  }

  deleteArchive(managerId: string, archiveId: string): void {
    this.#pickupsSinceShutdown.delete(pickupKey('archive', managerId, archiveId));
    this.#archiveStash.delete(managerId, archiveId);
  }

  // 名乗りの有無に関わらず預けて参照を送る（#4485）: 2026-10-13T16:54Z、名乗りを覚えていない回に 155MB の本文が SSE の1行で届き、
  // デーモンのループが 3.8 秒塞がった（ヒープ 1722/1759MB）。本文を載せる道を残すと、名乗りが落ちた回にいつでも同じことが起きる。
  // 古い（名乗らない）デーモンは参照だけの出来事を読めず落とすが、それは跡が残る失敗で、ループを塞いで全体を止めるよりよい。
  // 名乗りを覚えていない回は stderr に残す: 名乗りがいつ落ちるのかを後から確かめられるように（本文・委譲の中身は書かない）
  #stashArchive(managerId: string, body: string): { id: string; chars: number } | undefined {
    if (!this.#daemonAcceptsArchiveRef) {
      writeStderrLine(
        `alteroid-runner: いま繋がっているデーモンが退避の参照を受けると名乗っていないが、本文は SSE に載せずに預けて参照を送る（managerId=${managerId} chars=${String(body.length)}）\n`,
      );
    }
    return this.#archiveStash.put(managerId, body);
  }

  #attachmentInput(
    managerId: string,
    text: string,
    attachments: readonly RunnerAttachment[] | undefined,
  ): AgentUserInput | Promise<AgentUserInput> {
    // 添付が無ければ `await` を挟まない: 余計な yield が並行した resume との競りの順序を変えるため
    if (attachments === undefined || attachments.length === 0) return { text };
    return this.#placeAttachmentInput(managerId, text, attachments);
  }

  // Promise を握る: 握らないと畳みの `onClosed` が投げた削除が遅れて走り、resume が置き直した添付を消すため
  #removeAttachments(managerId: string): void {
    this.#attachmentRemovalStarts.set(
      managerId,
      (this.#attachmentRemovalStarts.get(managerId) ?? 0) + 1,
    );
    this.#stagedAttachments.forgetManager(managerId);
    const removal: Promise<void> = removeManagerAttachments(this.#attachmentsRoot, managerId)
      .catch(() => undefined)
      .finally(() => {
        if (this.#attachmentRemovals.get(managerId) === removal) {
          this.#attachmentRemovals.delete(managerId);
        }
      });
    this.#attachmentRemovals.set(managerId, removal);
  }

  async #awaitAttachmentRemovals(managerId: string): Promise<void> {
    for (let removal = this.#attachmentRemovals.get(managerId); removal !== undefined;) {
      await removal;
      removal = this.#attachmentRemovals.get(managerId);
    }
  }

  // 大きいファイルの別口（#4128 段3a）。置き場・置き先・作法は命令の添付（`placeRunnerAttachments`）と同じ部品を通す。
  async stageAttachment(
    managerId: string,
    meta: RunnerStagedAttachmentMeta,
    body: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    await this.#awaitAttachmentRemovals(managerId);
    void pruneStaleAttachmentDirs(
      this.#attachmentsRoot,
      [...this.#sessions.keys(), managerId],
      Date.now(),
    ).catch(() => undefined);
    await stageRunnerAttachment({
      root: this.#attachmentsRoot,
      managerId,
      id: meta.id,
      name: meta.name,
      size: meta.size,
      sha256: meta.sha256,
      body,
      limit: this.attachmentStageLimit,
      ...(this.#childUser === undefined ? {} : { childGid: this.#childUser.gid }),
      ledger: this.#stagedAttachments,
    });
  }

  async #placeAttachmentInput(
    managerId: string,
    text: string,
    attachments: readonly RunnerAttachment[],
  ): Promise<AgentUserInput> {
    // 置いている間に畳みの片付け（`#removeAttachments`）が始まったら、片付けを待って置き直す: 片付けは担当の置き場ごと消すので、
    // 置く途中なら mkdir が ENOENT で投げて resume ごと失敗し（作り直しへ落ちない）、置き終えていても参照だけが残ってファイルが無い
    for (let attempt = 1; ; attempt += 1) {
      await this.#awaitAttachmentRemovals(managerId);
      const removalsBefore = this.#attachmentRemovalStarts.get(managerId) ?? 0;
      void pruneStaleAttachmentDirs(
        this.#attachmentsRoot,
        [...this.#sessions.keys(), managerId],
        Date.now(),
      ).catch(() => undefined);
      const outcome = await placeRunnerAttachments({
        root: this.#attachmentsRoot,
        managerId,
        attachments,
        ledger: this.#stagedAttachments,
        ...(this.#childUser === undefined ? {} : { childGid: this.#childUser.gid }),
        // 担い手の子プロセスの env と同じ出所（器の env・鍵・プロファイル）で経路を決める。
        routeEnv: { ...this.#baseChildEnv(), ...(this.#profile?.env() ?? {}) },
      }).then(
        (placed) => ({ placed }),
        (error: unknown) => ({ error }),
      );
      const removedMeanwhile =
        (this.#attachmentRemovalStarts.get(managerId) ?? 0) !== removalsBefore;
      // 回数に上限を置く: 畳みが続けて重なっても、置き直しを際限なく繰り返さない
      if (!removedMeanwhile || attempt >= ATTACHMENT_PLACE_ATTEMPTS) {
        if ('error' in outcome) throw outcome.error;
        return composeAttachmentInput(text, outcome.placed);
      }
    }
  }

  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome> {
    const session = this.#sessions.get(managerId);
    if (!session) return { delivered: false };
    return session.answer(answer);
  }

  async stop(managerId: string, options: { keepPeers?: boolean } = {}): Promise<void> {
    // 鍵の付け替えのためでない停止（人間・クローンが止めた）では、前に預かった peer も閉じる（#4734）
    // 預けた peer を閉じ終えるのを待ってからセッションを止めない: 間に待ちが挟まると「止めると決めた」印が立つ前に子が終わり、止め方どおりの SIGTERM を異常終了と言うため（#4488）。止める指示を先に出し、閉じるのは並べて待つ
    const closingParked =
      options.keepPeers !== true
        ? this.#closeParkedPeers(managerId, 'stopped', '人間・クローンが止めた')
        : Promise.resolve();
    const session = this.#sessions.get(managerId);
    // 畳み始める前に立てる: `onClosed` が名簿から消した直後の走査にも守りを効かせるため（#5115）。背景処理を畳んだ回（`abandonTree`）は `#abandonedDelegationPids` が先に効く
    // keepPeers 無しの停止（人間・クローンが止めた）は、failed / lost で閉じて戻りを待っている担当の守りも外す（#5168）
    if (options.keepPeers === true) {
      if (session !== undefined) this.#returnAwaitedSince.set(managerId, Date.now());
    } else {
      this.#returnAwaitedSince.delete(managerId);
    }
    const stopping = session?.stop(
      'デーモンから停止を指示された。',
      options.keepPeers === true ? { keepPeers: true } : {},
    );
    await Promise.all([closingParked, stopping]);
  }

  #parkPeers(managerId: string, parked: ParkedPeers): void {
    // 前に預かった分が残っていれば閉じる: 同じ担当の peer が2組あると、どちらを付け替えるか決められないため
    void this.#closeParkedPeers(managerId, 'replaced', '同じ担当の peer を預かり直した');
    const timer = setTimeout(() => {
      void this.#closeParkedPeers(
        managerId,
        'expired',
        `鍵の付け替えで畳んだ担当が ${String(PEER_PARK_TTL_MS / 60_000)} 分戻らなかった`,
      );
    }, PEER_PARK_TTL_MS);
    timer.unref?.();
    this.#parkedPeers.set(managerId, { parked, timer });
    this.#emit({
      type: 'note',
      managerId,
      text: '鍵の付け替えのために畳んだので、peer のセッションは閉じずに預けた。起こし直した担当へ引き継ぐ（#4734）',
    });
  }

  #takeParkedPeers(managerId: string): ParkedPeers | undefined {
    const entry = this.#parkedPeers.get(managerId);
    if (entry === undefined) return undefined;
    clearTimeout(entry.timer);
    this.#parkedPeers.delete(managerId);
    return entry.parked;
  }

  /** 閉じ終えるまで（閉じた後に届く背景ターンの止まりどころも）集めてから、デーモンへ `parked_peers_closed` を運ぶ（#4885）。 */
  #closeParkedPeers(
    managerId: string,
    kind: 'expired' | 'stopped' | 'replaced' | 'shutdown',
    reason: string,
  ): Promise<void> {
    const parked = this.#takeParkedPeers(managerId);
    if (parked === undefined) return Promise.resolve();
    // 伏せ字は env と vault の値を渡して行う（#4923）: 形を持たない鍵が peer の出力に載っていても、抜粋・note に残さない
    const vaultValues = Object.values(this.#credentials?.values() ?? {});
    const closing = closeParkedPeers(
      parked,
      reason,
      (text) => this.#emit({ type: 'note', managerId, text }),
      (text) => redactErrorText(text, process.env, vaultValues),
    ).then((closed) => {
      if (closed.length === 0) return;
      this.#emit({
        type: 'parked_peers_closed',
        managerId,
        reason: kind,
        peers: closed.map((peer) => ({
          id: peer.id,
          provider: peer.provider,
          ...(peer.interrupted === undefined ? {} : { interrupted: peer.interrupted }),
        })),
      });
    });
    this.#closingPeers.add(closing);
    void closing.finally(() => this.#closingPeers.delete(closing));
    return closing;
  }

  list(): RunnerManagerState[] {
    return [...this.#sessions.values()].map((session) => session.state());
  }

  async transcript(managerId: string): Promise<string | null> {
    return (await this.#sessions.get(managerId)?.transcript()) ?? null;
  }

  async transcriptTail(managerId: string, maxChars: number): Promise<string | null> {
    return (await this.#sessions.get(managerId)?.transcriptTail(maxChars)) ?? null;
  }

  async unpushedWork(
    managerId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UnpushedWorkResult | undefined> {
    const session = this.#sessions.get(managerId);
    if (session === undefined) return undefined;
    return session.unpushedWork(options);
  }

  async deleteRescueRef(
    request: { remote: string; ref: string; commit: string },
    options?: { signal?: AbortSignal },
  ): Promise<RescueRefDeleteResult> {
    const env: NodeJS.ProcessEnv = { ...this.#env };
    for (const name of ROTATABLE_CREDENTIAL_KEYS) delete env[name];
    if (this.#credentials !== undefined) {
      Object.assign(env, this.#credentials.values(), this.#credentials.env());
    }
    Object.assign(env, this.#profile?.env() ?? {});
    for (const key of this.#withheldEnvKeys) delete env[key];
    const spawnFn =
      this.#childUser === undefined
        ? (spawnOptions: GitSpawnOptions) =>
            spawn(spawnOptions.command, spawnOptions.args, {
              ...(spawnOptions.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
              env: spawnOptions.env,
              signal: spawnOptions.signal,
              stdio: ['ignore', 'pipe', 'pipe'] as const,
            })
        : (spawnOptions: GitSpawnOptions) => this.#spawnAsChildUser(spawnOptions);
    return deleteRescueRef({
      spawn: spawnFn,
      env,
      remote: request.remote,
      ref: request.ref,
      commit: request.commit,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    // 畳む前に預けた退避も、デーモンに取られるまで待たせる（#4896）: 畳み始めてからの分だけだと、直前に参照を送った退避を
    // デーモンが取りに来る前に器が入れ替わり、取りに行った先の新しいプロセスに本文が無くなる
    for (const entry of this.#archiveStash.list()) {
      // 取り終えたもの（DELETE が落ちただけ）は待たない（#4899）
      if (entry.fetched) continue;
      this.#pickupsSinceShutdown.add(pickupKey('archive', entry.managerId, entry.id));
    }
    // このプロセスが出来事で送り、まだ取られていない出し箱・未追跡の預かりも待たせる（#4912）。
    // 退避先の dir は数えない: 前の担当・前のプロセスの残りや読み捨てられた分まで待つと、入れ替えのたびに上限まで遅れる。
    // 本文を載せて送り直すのは生ログだけ: 大きいファイルを SSE に載せないため
    // 送ってから `EMITTED_PICKUP_STALE_MS` を過ぎても取られていないものは数えない（#4925）: デーモンは普通数秒で取りに来る。
    // 古いものは、取りに行かないと決めた（検めで断った・台帳に無い担当など）か別の事情で、待っても取られず畳みのたびに上限まで待たせる
    const staleBefore = Date.now() - EMITTED_PICKUP_STALE_MS;
    for (const [key, emittedAt] of this.#emittedPickups) {
      if (emittedAt > staleBefore) this.#pickupsSinceShutdown.add(key);
    }
    // 畳み始めの名乗りを入口ごとに任せない: 積み忘れる形を作らないため
    this.#emit({ type: 'shutting_down', runnerId: this.runnerId });
    // 見張りを先に畳む: 畳み残すと止まったはずの見張りが空の名簿を叩き続け、テストではタイマーが残ってハングするため
    if (this.#leaseWatcher !== null) clearInterval(this.#leaseWatcher);
    this.#leaseWatcher = null;
    if (this.#rescueTimer !== null) clearInterval(this.#rescueTimer);
    this.#rescueTimer = null;
    if (this.#scratchTimer !== null) clearInterval(this.#scratchTimer);
    this.#scratchTimer = null;
    if (this.#codexAuthTimer !== null) clearInterval(this.#codexAuthTimer);
    this.#codexAuthTimer = null;
    this.#scratchAbort.abort();
    await Promise.all(
      [...this.#sessions.values()].map((session) =>
        session.stop('runner が停止した。', { captureUnpushedWork: true }),
      ),
    );
    this.#sessions.clear();
    // 終わった担当の退避も待つ（#4789）: 上で止めた担当の分も、それより前に終わった担当の分もここに積まれている
    await Promise.all([...this.#closeRescues]);
    for (const managerId of [...this.#parkedPeers.keys()]) {
      void this.#closeParkedPeers(managerId, 'shutdown', '器を畳む');
    }
    // 閉じた後に届く背景ターンの止まりどころも待つ（#4885）: 待たずに返すと、知らせを運ぶ前に出口が閉じる
    await Promise.all([...this.#closingPeers]);
    // 予約済みの plugin の片づけ（retainPlugins の投げっぱなし）を待つ: 待たずに返すと、畳んだ後にも展開先を消し続け、呼び手の後片づけと競合するため
    await this.#pluginsChain;
    // セッションを畳んだ後に閉じる: 先に閉じると、畳みの途中の peer の中継が切れるため
    this.#peerSocket?.close();
    this.#peerSocket = undefined;
    this.#managerTools?.host.close();
  }
}

// task id → 作業者を呼んだ tool_use id の対応を覚える数の上限。超えたら古いものから捨てる（#4996）
const TASK_TOOL_USE_IDS_MAX = 1_000;

// 送ったまま取られていない出し箱・預かりを覚える数の上限（#4912）
const EMITTED_PICKUPS_MAX = 10_000;

// 送ってからこれを過ぎて取られていない出し箱・預かりは、畳みの待ちに数えない（#4925）。10分: PEER_PARK_TTL_MS と同じ桁で、普段の数秒に十分な余裕がある
export const EMITTED_PICKUP_STALE_MS = 10 * 60_000;

function pickupKey(kind: 'archive' | 'outbox' | 'rescue', managerId: string, id: string): string {
  return `${kind}\u0000${managerId}\u0000${id}`;
}

/**
 * 鍵の付け替えで畳んだ担当から預かった peer を待つ長さ（#4734）。デーモンは畳んだ直後に resume するので、普段は数秒で引き取られる。
 * 戻らない（resume が別の器へ行った・失敗した）ときに peer の子プロセスを残し続けないため、期限で閉じる。
 */
export const PEER_PARK_TTL_MS = 10 * 60_000;

const RESOLVED_MEMORY_LIMIT = 512;

const DENIED_MEMORY_LIMIT = 512;

// `onForget` の日誌行に控えていた本文を書かない（`tool_use_id` だけ）: 上限に達した回にだけ入力の先頭が日誌へ滲み出るため
const PRE_TOOL_INPUT_HEAD_MEMORY_LIMIT = 512;

const ONE_SHOT_ALLOW_MEMORY_LIMIT = 512;

const ONE_SHOT_ALLOWED_TOOL_USE_MEMORY_LIMIT = 512;

// 10分: 短すぎると許可が間に合わず失効し、長すぎると状況が変わった後に古い許可が生きる。フックの持ち時間の既定（600000ms）と同じ桁に揃えた経験的な値
export const ONE_SHOT_ALLOW_TTL_MS = 10 * 60 * 1000;

// 超えた分を黙って落とさない: 切ったこと自体を末尾に書く（AGENTS.md「静かに失敗する道具」）
const SUBAGENT_STOP_NOTE_TEXT_LIMIT = 1_500;

// `SUBAGENT_STOP_NOTE_TEXT_LIMIT` と共有しない: 片方を動かしたときに黙って一緒に動かないため。超えた分を黙って落とさない
const STOP_NOTE_TEXT_LIMIT = 1_500;

/**
 * [sdk-verbatim BackgroundTaskSummary.type]
 * > Friendly task-type label (e.g. 'shell', 'subagent', 'monitor', 'workflow'). Falls back to the raw discriminant for unknown types.
 *
 * [sdk-verbatim BashOutput.backgroundTaskId]
 * > ID of the background task if command is running in background
 *
 * [sdk-verbatim MonitorOutput.taskId]
 * > ID of the background monitor task.
 *
 * [sdk-verbatim WorkflowOutput.taskType]
 * > TaskType of the registered background task — 'local_workflow' for in-process runs, 'remote_agent' when remote:true dispatches to CCR. Set on all new writes; absent only on transcripts written before this field existed.
 */
// `type !== 'subagent'` で除外しない: 所有者を引けないのが正常かは出力が `backgroundTaskId` を持つかという性質で決まり、monitor / workflow を起こしただけで誤診断が出るため
// 「引けなかった種類」を足さない: これは引ける側の名簿で、増えるのは `#recordBackgroundTaskOwner` が読むキーを増やしたときだけのため
export const OWNER_RECORDABLE_TASK_TYPES: ReadonlySet<string> = new Set(['shell']);

// `#noteOwnerLookupFailure` と `#stopTaskOwnerKind` の両方から引く: 片方だけ直すと同じ問いに2つの答えが出るため
function isOwnerRecordableTaskType(type: unknown): boolean {
  return typeof type === 'string' && OWNER_RECORDABLE_TASK_TYPES.has(type);
}

// 知らない値を数えない: 数えると SDK が新しい種類（`local_workflow` 等）を増やすたびに作業者の過大計上が黙って再発するため
// `OWNER_RECORDABLE_TASK_TYPES` と混ぜない: 背景処理の種類と委譲の種類は別の id 空間のため
/** 背景で起こした作業者（サブエージェント）の、SDK の背景処理の種類（`task_type`）。 */
const BACKGROUND_AGENT_TASK_TYPE = 'local_agent';

function isWorkerTaskType(taskType: string | undefined): boolean {
  return taskType === undefined || taskType === BACKGROUND_AGENT_TASK_TYPE;
}

/**
 * [sdk-verbatim SDKTaskUpdatedMessage.patch.status]
 * > status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused';
 */
const SETTLED_BACKGROUND_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
]);

// `paused` を settled に入れない: 止まっているだけで、畳めば置き去りになるため
const LIVE_BACKGROUND_TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'paused',
]);

// 分からない status を `'settled'` へ倒さない: 起こし直しが黙って効かなくなるため
function classifyBackgroundTaskStatus(status: unknown): 'live' | 'settled' | 'unknown' {
  if (typeof status !== 'string') return 'unknown';
  if (SETTLED_BACKGROUND_TASK_STATUSES.has(status)) return 'settled';
  if (LIVE_BACKGROUND_TASK_STATUSES.has(status)) return 'live';
  return 'unknown';
}

/** 鍵の付け替えで畳む間に預かる peer の窓口の結び（#4734）。受け口はいつも `session`（いまの担当のセッション）へ回る。 */
interface PeerBinding {
  session: RunnerSession;
  // 預けている間（前のセッションを畳んだ後・新しいセッションへ付け替える前）は、確認と背景の止まりどころを預かる
  parked: boolean;
  heldAsks: { run: () => void; deny: (message: string) => void }[];
  heldStops: PeerTurnResult[];
  /** peer の rollout の読み済みの位置を持つ。結びと一緒に付け替え先へ渡る（作り直すと、読み済みの位置が消えて全行を預け直す）。 */
  rollouts: PeerRolloutMirror;
  /** 付け替え先が主の記録の鍵を知るまでの間、前のセッションが知っていた値を引き継ぐ。 */
  lastMainKey?: { projectKey: string; sessionId: string };
  // 預けた peer を閉じている間だけ立つ（#4885）: 閉じた後に届く止まりどころを `heldStops`（もう誰も読まない）へ積まず、ここへ集める
  collectStop?: (result: PeerTurnResult) => void;
}

/** 畳んだセッションから預かった peer（#4734）。host が持ち、同じ担当の resume で新しいセッションへ渡す。 */
export interface ParkedPeers {
  readonly broker: PeerBroker;
  readonly binding: PeerBinding;
}

/** 預かった peer を閉じる（担当が戻らなかった・人が止めた・器を畳む）。預かっていた確認は理由を付けて断り、背景の止まりどころは知らせに残す。 */
export async function closeParkedPeers(
  parked: ParkedPeers,
  reason: string,
  note: (text: string) => void,
  // 伏せ字（env と vault の値を渡したもの。#4923）。抜粋はこれを通してから切る（伏せ字が先、切り詰めが後）
  redact: (text: string) => string,
): Promise<ClosedParkedPeer[]> {
  const { binding, broker } = parked;
  for (const ask of binding.heldAsks.splice(0)) {
    ask.deny(`peer のマネージャーが戻らないので断った（${reason}）`);
  }
  const closed = new Map<string, ClosedParkedPeer>();
  for (const session of broker.sessionList()) {
    closed.set(session.id, { id: session.id, provider: session.provider });
  }
  const record = (result: PeerTurnResult): void => {
    closed.set(result.sessionId, {
      id: result.sessionId,
      provider: result.provider,
      interrupted: excerptLine(
        redact(
          result.pendingApproval === undefined
            ? result.text
            : `確認待ちで止まっていた: ${result.pendingApproval.toolName} ${result.pendingApproval.summary}`,
        ),
        PARKED_PEER_STOP_EXCERPT_CHARS,
      ),
    });
  };
  for (const result of binding.heldStops.splice(0)) {
    note(
      `背景の peer（${result.provider}）[${result.sessionId}] の止まりどころを届けられないまま閉じた（${reason}）: ${redact(describePeerTurnResult(result))}`,
    );
    record(result);
  }
  // 閉じるとき走っていた背景ターンは、閉じた後に止まりどころが届く（`readEvents` が終わる → ターンが終わる → `onBackgroundStop`）。
  // それを `heldStops` へ積ませず、届くまで待って集める（#4885）
  const awaiting = new Set(broker.backgroundTasks().map((task) => task.id.replace(/^peer:/u, '')));
  let finish = (): void => undefined;
  const collected = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let done = false;
  binding.collectStop = (result) => {
    if (done) {
      note(
        `背景の peer（${result.provider}）[${result.sessionId}] の止まりどころが、閉じ終えた後に届いた（${reason}）: ${redact(describePeerTurnResult(result))}`,
      );
      return;
    }
    record(result);
    awaiting.delete(result.sessionId);
    if (awaiting.size === 0) finish();
  };
  broker.closeAll();
  if (awaiting.size > 0) {
    // 止まりどころが届かない相手（読み取りが終わらない）で器の畳みを止めない: 上限で切り、集めた分だけ運ぶ
    const timer = setTimeout(finish, PARKED_PEER_STOP_COLLECT_MS);
    timer.unref?.();
    await collected;
    clearTimeout(timer);
  }
  done = true;
  note(`預かっていた peer のセッションを閉じた（${reason}）`);
  return [...closed.values()];
}

export interface ClosedParkedPeer {
  readonly id: string;
  readonly provider: string;
  /** 閉じるとき背景で走っていた（または預かっていた）ターンの止まりどころの抜粋。 */
  readonly interrupted?: string;
}

// 止まりどころの抜粋の長さ。畳んだ背景処理のコマンドの字数（`FOLD_NOTICE_COMMAND_CHARS`）より長く、知らせ1通に peer 数ぶん載っても収まる程度
const PARKED_PEER_STOP_EXCERPT_CHARS = 300;
const PARKED_PEER_STOP_COLLECT_MS = 5_000;

interface PendingRequest {
  id: string;
  kind: 'question' | 'permission';
  summary: string;
  // 取り直さない: 引き取りのたびに取り直すと、待っている時間の長さが消えるため
  askedAt: string;
  // `message` の文言を嗅がない（`withdrawn` / `aborted` で判定する）: AGENTS.md「文字列で本文を嗅がない」
  // `aborted` を `settled` イベントに載せない: 中断は `withdrawn` が言う「CLI へ届いていない」とは別の事実のため
  settle: (answer: {
    message: string;
    decision?: 'allow' | 'deny';
    withdrawn?: true;
    aborted?: true;
  }) => void;
  result: Promise<AgentPermissionDecision>;
}

type SpawnAgentProcessOptions = AgentSpawnOptions;

export type HandOverResumeConfigDir = (dir: string, uid: number, gid: number) => void;

type DelegationProcessHandle = AgentChildProcess;

/** セッションの閉じ方。`status` は `#finish()` の終わり方、`abandonTree` は鍵の付け替えの畳みで CLI の背景処理を畳んだ回（#5044）。 */
type RunnerSessionCloseOutcome = { status: JobStatus } | { abandonTree: true };

interface RunnerSessionOptions {
  workerToolWatchClock?: WorkerToolWatchClock;
  /** 鍵の付け替えのための畳みで peer を預けたとき、host へ渡す（#4734）。 */
  onPeersParked?: (parked: ParkedPeers) => void;
  /** 終わり際に撃った退避の push を host へ渡す（#4789）。host は畳むときにこれを待つ。 */
  onCloseRescue?: (rescue: Promise<unknown>) => void;
  managerId: string;
  request: string;
  cwd: string;
  emit: (event: RunnerEvent) => void;
  queryFn?: ClaudeQueryFn;
  driver?: AgentManagerDriver;
  env: NodeJS.ProcessEnv;
  withheldEnvKeys: readonly string[];
  childUser?: RunnerChildUser;
  credentials?: CredentialStore;
  permissionMode: ManagerPermissionMode;
  bashGuard: BashGuardMode;
  codexAuth?: CodexChatgptAuthHandle;
  // 値で渡さない（関数で受ける）: 走行中に差し替わるので、後から起こしたマネージャーだけが古い環境で走るため
  profileEnv: () => Record<string, string>;
  // 値で渡さない（関数で受ける）: セッションを作った後に降りた登録が resume・開き直しに届かないため
  mcpServers: () => McpServers | undefined;
  // 値で渡さない（関数で受ける）: `mcpServers` と同じ理由
  plugins: () => readonly AgentClonePlugin[];
  // 委譲先の許可規則（#4952）。値で渡さない（関数で受ける）: `mcpServers` と同じ理由。省けば空
  permissionRules?: () => readonly string[];
  // 値で渡さない（関数で受ける）: 資格が届く・外れるたびに開閉が変わるため
  peer?: () => RunnerPeerOptions | undefined;
  managerTools?: RunnerManagerToolsOptions;
  // 終わり方は `#finish()` を通ったときだけ渡る（`stop()` は渡さない）: 落ちた・失効した CLI の木と、人間・畳みの停止の木を host が見分けるため。
  // 例外は鍵の付け替えの畳みで背景処理を畳んだ回（`abandonTree`。#5044）: 結果の受け手が居なくなった木で、守ると畳んだ後も走り続けるため
  onClosed: (outcome?: RunnerSessionCloseOutcome) => void;
  outboxRoot: string;
  outboxStagedRoot: string;
  rescueStagedRoot: string;
  managerScratchRoot: string;
  /** 出し箱の大きいファイルの1つの上限と1報告の合計（hello の `attachmentStageLimit` と同じ値）。 */
  attachmentStageLimit?: number;
  onDelegationProcessSpawned?: (pid: number) => void;
  onDelegationProcessExited?: (pid: number) => void;
  spawnAgentProcessFn?: (options: SpawnAgentProcessOptions) => DelegationProcessHandle;
  delegationSubreaper?: string;
  handOverResumeConfigDirFn?: HandOverResumeConfigDir;
  handOverMcpConfigDirFn?: HandOverResumeConfigDir;
  mcpConfigTmpRoot?: string;
  liveMcpConfigDirs?: Set<string>;
  contextUsageTimeoutMs?: number;
  // 一時規則（#4905）の置き直しを待つ期限。既定は `SESSION_ALLOW_RULES_TIMEOUT_MS`。試験が短くするための口
  sessionAllowRulesTimeoutMs?: number;
  readCgroupEventCountersFn?: () => Promise<CgroupEventCounters>;
  rescueMaxWorktrees?: number;
  /** 器の pids と、器の上の担当の本数。渡されたときだけ、上限に近ければ道具の結果へ知らせを添える。 */
  pidsPressureFn?: () => Promise<PidsPressureReading | undefined>;
  /**
   * 生ログの退避の本文を runner に預け、参照を返す（#4485）。`undefined` は「預けない」（デーモンが参照を受け取れない・口が無い）で、本文を出来事に載せる。
   */
  stashArchive?: (body: string) => { id: string; chars: number } | undefined;
  finishUnpushedWorkFn?: (options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>;
}

// `manager.ts` の定数と共有しない: `runner.ts` → `manager.ts` の逆向き import を増やさないため
const FINISH_UNPUSHED_WORK_TIMEOUT_MS = 5_000;

/** 担当の作業場の下に置く、委譲の CLI の一時フォルダの名前（`#prepareClaudeTmpDir`）。 */
export const DELEGATION_CLAUDE_TMP_DIR_NAME = 'claude-tmp';

// `FORCED_EXIT_MS`（SIGTERM から55秒）の内側に収める: 全セッションを並行に畳むので、この観測1本ぶんだけが畳みの合計時間に上乗せされる
const STOP_UNPUSHED_WORK_TIMEOUT_MS = 5_000;

const STOP_RESCUE_TIMEOUT_MS = 20_000;

// `manager.ts` の型を import しない: `runner.ts` → `manager.ts` の逆向き import を増やさないため
type FinishUnpushedWorkOutcome =
  | { readonly kind: 'ok'; readonly result: UnpushedWorkResult }
  | { readonly kind: 'unavailable'; readonly reason: string };

class RunnerSession {
  readonly #id: string;
  readonly #request: string;
  readonly #cwd: string;
  readonly #emit: (event: RunnerEvent) => void;
  readonly #workerTools: WorkerToolWatch;
  readonly #driver: AgentManagerDriver;
  readonly #env: NodeJS.ProcessEnv;
  readonly #withheldEnvKeys: readonly string[];
  readonly #childUser: RunnerChildUser | undefined;
  readonly #credentials: CredentialStore | undefined;
  readonly #permissionMode: ManagerPermissionMode;
  readonly #bashGuard: BashGuardMode;
  readonly #peer: (() => RunnerPeerOptions | undefined) | undefined;
  readonly #onPeersParked: ((parked: ParkedPeers) => void) | undefined;
  readonly #onCloseRescue: ((rescue: Promise<unknown>) => void) | undefined;
  readonly #managerTools: RunnerManagerToolsOptions | undefined;
  readonly #codexAuth: CodexChatgptAuthHandle | undefined;
  readonly #queryFn: ClaudeQueryFn | undefined;
  #peerBroker: PeerBroker | undefined;
  #peerBinding: PeerBinding | undefined;
  /** 担当の主の記録の鍵（SDK の書き出しで分かる）。peer の記録を同じ `projectKey`/`sessionId` の下に預けるのに要る。 */
  #mainLogKey: { projectKey: string; sessionId: string } | undefined;
  /** resume で戻された peer の記録（`peer_reply` が来て置くまで持つ）。置いたら（または置けないと分かったら）手放す。 */
  readonly #peerSeeds = new Map<string, PeerRolloutSeed & { provider: string }>();
  readonly #peerPlacements = new Map<string, Promise<void>>();
  /** 背景の peer の止まりどころの知らせのうち、まだ届けていないもの（確認待ちの間は溜める）。 */
  readonly #peerNotices: string[] = [];
  readonly #profileEnv: () => Record<string, string>;
  readonly #mcpServers: () => McpServers | undefined;
  readonly #permissionRules: () => readonly string[];
  readonly #pluginRefs: () => readonly AgentClonePlugin[];
  readonly #onClosed: (outcome?: RunnerSessionCloseOutcome) => void;
  readonly #outboxRoot: string;
  readonly #outboxStagedRoot: string;
  readonly #rescueStagedRoot: string;
  readonly #managerScratchRoot: string;
  /** 委譲の CLI に渡す `CLAUDE_CODE_TMPDIR`。用意できた後だけ立つ（`#prepareClaudeTmpDir`）。 */
  #claudeTmpDir: string | undefined;
  readonly #attachmentStageLimit: number | undefined;
  //用意できなかったら無し: 出し箱が無くてもマネージャーは動く（成果物を報告に添えられないだけ）
  readonly #outboxDir: string | undefined;
  readonly #onDelegationProcessSpawned: (pid: number) => void;
  readonly #onDelegationProcessExited: (pid: number) => void;
  readonly #spawnAgentProcessFn: (options: SpawnAgentProcessOptions) => DelegationProcessHandle;
  readonly #delegationSubreaper: string | undefined;
  readonly #handOverResumeConfigDirFn: HandOverResumeConfigDir;
  readonly #handOverMcpConfigDirFn: HandOverResumeConfigDir;
  readonly #mcpConfigTmpRoot: string;
  readonly #liveMcpConfigDirs: Set<string>;
  readonly #contextUsageTimeoutMs: number;
  readonly #sessionAllowRulesTimeoutMs: number;
  readonly #rescueMaxWorktrees: number | undefined;
  readonly #readCgroupEventCountersFn: () => Promise<CgroupEventCounters>;
  readonly #pidsPressureFn: (() => Promise<PidsPressureReading | undefined>) | undefined;
  readonly #stashArchive: ((body: string) => { id: string; chars: number } | undefined) | undefined;
  readonly #pidsPressureNotices = new PidsPressureNotices();
  readonly #staleUntrackedNotices = new StaleUntrackedNotices();
  readonly #peerApprovalNotices = new PeerApprovalNotices();
  /** 作業者だけが利用上限で落ちた事実。ターンの集計とは別に、ターンをまたいで持つ（#4903）。 */
  readonly #workerLimitNotices = new WorkerLimitNotices();
  readonly #denialStreaks = new ClassifierDenialStreaks();
  /** 担当の発言に混ざった英語の文の知らせ（#4965）。 */
  readonly #reportLanguageNotices = new ReportLanguageNotices();
  /** 不正な `ALTEROID_REPORT_LANGUAGE` を日誌に書いた値（同じ値は1回だけ書く）。 */
  #reportLanguageMisconfigNoted: string | undefined;
  readonly #rescueMemory = new RescueMemory();
  /** 退避の列挙の打ち切りの知らせ（同じ状態が続く間は繰り返さない。#4681）。 */
  readonly #rescueListNotice = new RescueListNotice();
  #rescueRunning: Promise<void> | null = null;
  /** 前の報告から後に走った「外へ出す」コマンドの名前（`outward-commands.ts`）。報告を出すときに空にする。 */
  readonly #outwardActions: string[] = [];
  /**
   * 担い手（作業者を含む）が git を打った場所（`git-worktree-hints.ts`）。未 push の観測と退避 ref の探す先に足す。
   * 覚えるのはこのプロセスの中だけ: 器が替われば作業ツリーも一緒に消えるため。数に上限を置く: 作業場は数か所で、増え続けるのは拾い方の誤りのため。
   */
  readonly #gitDirHints: string[] = [];
  /** 鍵の回転で入力を閉じる前に、resume の一時ディレクトリから読んだ生ログ。`#reopenForTokenRotation` が受け取って消す。 */
  #rotationSeed: unknown[] | undefined;
  /**
   * 鍵の回転の後も回転前の鍵で走っている間に、作業者が利用上限で落ちた印（#5046）。
   * 境界で新しい鍵へ開き直したとき、続きを促す一言を入れるために使う: 入れないと、知らせに従ってターンを終えた担当が、開き直した後に誰にも起こされず止まるため。
   */
  #workerLimitOnPreRotationKey = false;
  readonly #finishUnpushedWorkFn: (options?: {
    signal?: AbortSignal;
  }) => Promise<UnpushedWorkResult>;
  // `Promise` のまま持つ: コンストラクタは同期で、fs 読み取りを待たずに構築を終えるため
  readonly #openedCgroupEvents: Promise<CgroupEventCounters>;

  readonly #pending: PendingRequest[] = [];
  // 解けた確認を覚える: `#pending` だけで重複を判定すると、解決後の再送が新しい確認になりクローンへ二度目が届くため
  readonly #resolved = createRecentMap<AgentPermissionDecision>({
    limit: RESOLVED_MEMORY_LIMIT,
    // 忘れたことを黙らない: 忘れた id の再送はもう一度クローンへ出るので、記録が無いと「なぜ二度届いたのか」を辿れないため
    onForget: (ids) =>
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `解決済みの確認の記憶が上限（${RESOLVED_MEMORY_LIMIT}件）に達したので、` +
          `古い ${ids.length} 件を忘れた: ${ids.join(', ')}。` +
          'この id の確認が SDK から再送されると、新しい確認としてもう一度回る。',
      }),
  });
  // `true` だけを置かない: 入力を持たない `via: 'live'` が先に鍵を立てると、入力を持つ `via: 'result'` を区別できず捨てるため
  readonly #denied = createRecentMap<DeniedRecord>({
    limit: DENIED_MEMORY_LIMIT,
    // 忘れたことを黙らない: 忘れた id が `result` に再度載ると、同じ拒否が新しい拒否として上がるため
    onForget: (ids) =>
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `上へ降ろした拒否の記憶が上限（${DENIED_MEMORY_LIMIT}件）に達したので、` +
          `古い ${ids.length} 件を忘れた: ${ids.join(', ')}。` +
          'この tool_use_id が result に残っていれば、同じ拒否がもう一度上がる。',
      }),
  });
  // 生の入力を保持しない: 伏せ字済み・160字以内の文字列だけを控える
  readonly #preToolInputHeads = createRecentMap<string>({
    limit: PRE_TOOL_INPUT_HEAD_MEMORY_LIMIT,
    onForget: (ids) =>
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `PreToolUse で控えた入力の先頭の記憶が上限（${PRE_TOOL_INPUT_HEAD_MEMORY_LIMIT}件）に` +
          `達したので、古い ${ids.length} 件（tool_use_id のみ。本文は書かない）を忘れた: ` +
          `${ids.join(', ')}。この tool_use_id の拒否が後から届いても、inputHead は付かない。`,
      }),
  });
  // 生の入力を保持しない: 復元できないダイジェストだけを鍵にするため
  readonly #oneShotAllows = createRecentMap<{
    readonly expiresAt: number;
    readonly actor: string;
    readonly tool: string;
  }>({
    limit: ONE_SHOT_ALLOW_MEMORY_LIMIT,
    onForget: (ids) =>
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `分類器の拒否への1回だけの許可の記憶が上限（${ONE_SHOT_ALLOW_MEMORY_LIMIT}件）に` +
          `達したので、古い ${ids.length} 件（鍵のみ。中身は書かない）を忘れた: ${ids.join(', ')}。` +
          `使われないまま忘れたので実害は無い（issue #1105 P1）。`,
      }),
  });
  // `key` と `at` を持つ: allow を返した撃ち直しがまた拒否されたとき、同じ呼び出しへの確認を重ねて上げないために照合する（#4904）
  readonly #oneShotAllowedToolUses = createRecentMap<{
    readonly actor: string;
    readonly tool: string;
    readonly key: string;
    readonly at: number;
  }>({
    limit: ONE_SHOT_ALLOWED_TOOL_USE_MEMORY_LIMIT,
    onForget: (ids) =>
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `1回だけの許可で allow を返した呼び出しの記憶が上限` +
          `（${ONE_SHOT_ALLOWED_TOOL_USE_MEMORY_LIMIT}件）に達したので、古い ${ids.length} 件を` +
          `忘れた: ${ids.join(', ')}。この tool_use_id への拒否が後から届いても、` +
          `「許可を追い越した」とは検出できない（issue #1105 P1）。`,
      }),
  });
  // allow を返した撃ち直しが分類器にまた拒否された呼び出しの鍵（生の入力は持たない）: 同じ呼び出しの確認の連鎖を止めるため（#4904）
  readonly #allowedButDenied = createRecentMap<{ readonly expiresAt: number }>({
    limit: ONE_SHOT_ALLOWED_TOOL_USE_MEMORY_LIMIT,
  });
  // クローンの allow で足した一時規則（#4905）。タイマーを置かない（`#noteUnusedExpiredOneShotAllows` と同じ遅延評価）: 期限切れは次の出来事とセッションの終わりで掃くため
  readonly #sessionAllowRules = new SessionAllowRuleBook();
  // 置き直しを1本ずつ流す: `applyFlagSettings` は一覧を丸ごと置き換えるので、追い越すと古い一覧が後から勝つため
  #sessionAllowRulesPush: Promise<unknown> = Promise.resolve();
  readonly #resumeState = new RunnerResumeState();
  #tokenFingerprint: string | undefined;
  readonly #workerWaitWindow = new RunnerWorkerWaitWindow();
  readonly #nonWorkerTaskIds = new Set<string>();
  // `task_notification` に tool_use_id を載せない古い CLI のために、`task_started` で見た対応を覚える（#4996）
  readonly #toolUseIdByTaskId = new Map<string, string>();

  readonly #cutOffWorkers = new RunnerCutOffWorkers();
  readonly #stopState = new RunnerSubagentStopState();
  readonly #turnTally = new RunnerTurnTally();
  readonly #sdkSession = new RunnerSdkSession();

  constructor(options: RunnerSessionOptions) {
    this.#id = options.managerId;
    this.#request = options.request;
    this.#cwd = options.cwd;
    this.#emit = options.emit;
    this.#workerTools = new WorkerToolWatch(
      options.managerId,
      options.emit,
      options.workerToolWatchClock,
    );
    this.#driver =
      options.driver ??
      new ClaudeManagerDriver(options.queryFn === undefined ? {} : { queryFn: options.queryFn });
    this.#env = options.env;
    this.#withheldEnvKeys = options.withheldEnvKeys;
    this.#childUser = options.childUser;
    this.#onPeersParked = options.onPeersParked;
    this.#onCloseRescue = options.onCloseRescue;
    this.#peer = options.peer;
    this.#managerTools = options.managerTools;
    this.#codexAuth = options.codexAuth;
    this.#queryFn = options.queryFn;
    this.#credentials = options.credentials;
    this.#permissionMode = options.permissionMode;
    this.#bashGuard = options.bashGuard;
    this.#profileEnv = options.profileEnv;
    this.#mcpServers = options.mcpServers;
    this.#permissionRules = options.permissionRules ?? (() => []);
    this.#pluginRefs = options.plugins;
    this.#onClosed = options.onClosed;
    this.#outboxRoot = options.outboxRoot;
    this.#managerScratchRoot = options.managerScratchRoot;
    this.#outboxStagedRoot = options.outboxStagedRoot;
    this.#rescueStagedRoot = options.rescueStagedRoot;
    this.#attachmentStageLimit = options.attachmentStageLimit;
    this.#outboxDir = this.#prepareOutbox();
    this.#onDelegationProcessSpawned = options.onDelegationProcessSpawned ?? (() => undefined);
    this.#onDelegationProcessExited = options.onDelegationProcessExited ?? (() => undefined);
    this.#spawnAgentProcessFn =
      options.spawnAgentProcessFn ??
      ((spawnOptions) =>
        spawnAsUser(this.#childUser as RunnerChildUser, { ...spawnOptions, detached: true }));
    this.#delegationSubreaper = options.delegationSubreaper;
    this.#handOverResumeConfigDirFn = options.handOverResumeConfigDirFn ?? chownTreeSync;
    this.#handOverMcpConfigDirFn = options.handOverMcpConfigDirFn ?? chownTreeSync;
    this.#mcpConfigTmpRoot = options.mcpConfigTmpRoot ?? tmpdir();
    this.#liveMcpConfigDirs = options.liveMcpConfigDirs ?? new Set<string>();
    this.#contextUsageTimeoutMs = options.contextUsageTimeoutMs ?? CONTEXT_USAGE_READ_TIMEOUT_MS;
    this.#sessionAllowRulesTimeoutMs =
      options.sessionAllowRulesTimeoutMs ?? SESSION_ALLOW_RULES_TIMEOUT_MS;
    this.#rescueMaxWorktrees = options.rescueMaxWorktrees;
    this.#readCgroupEventCountersFn =
      options.readCgroupEventCountersFn ?? (() => readCgroupEventCounters());
    this.#pidsPressureFn = options.pidsPressureFn;
    this.#stashArchive = options.stashArchive;
    this.#finishUnpushedWorkFn =
      options.finishUnpushedWorkFn ??
      ((unpushedWorkOptions) => this.unpushedWork(unpushedWorkOptions));
    // `#finish()` で読み直さない: 畳んだときの値になり、開いたときとの差分が取れないため
    this.#openedCgroupEvents = this.#readCgroupEventCountersFn();
  }

  get leaseTtlMs(): number | undefined {
    return this.#sdkSession.leaseTtlMs;
  }

  get cwd(): string {
    return this.#cwd;
  }

  // `lease` が無ければ何もしない: 名乗らない古いデーモンの命令は素通しするため
  checkFence(lease: RunnerLease | undefined): void {
    this.#sdkSession.checkFence(lease, this.#id);
  }

  begin(request: string, images?: readonly AgentInputImage[]): void {
    this.push(request, images);
    this.#open();
  }

  // `message` を必ず流す: resume が開き直すだけでは仕事が進まず、器が落ちたことを理由に止まったままにしないため
  resume(
    sessionId: string,
    entries: unknown[] | undefined,
    message: string | undefined,
    images?: readonly AgentInputImage[],
    subagents?: readonly SubagentTranscriptSeed[],
    peers?: readonly (PeerRolloutSeed & { provider: string })[],
  ): void {
    this.#resumeState.beginResume(sessionId, entries, subagents);
    // peer の分は `#resumeState` に入れない: 主の `load()` で使い切る材料ではなく、`peer_reply` が来た回に戻す（置き場が資格の状態に依るため）
    for (const peer of peers ?? []) {
      if (peer.provider !== 'codex') continue;
      this.#peerSeeds.set(peer.peerId, peer);
    }
    if (message !== undefined) this.push(message, images);
    this.#open(sessionId);
  }

  state(): RunnerManagerState {
    return {
      managerId: this.#id,
      status: this.#sdkSession.status,
      cwd: this.#cwd,
      request: this.#request,
      // `askedAt` を取り直さない: デーモン再起動のたびに待ち始めた時刻が「いま」に書き換わるため
      waiting: this.#pending.map((request) => ({
        requestId: request.id,
        summary: request.summary,
        kind: request.kind,
        askedAt: request.askedAt,
      })),
      ...(this.#resumeState.sessionId === undefined
        ? {}
        : { sessionId: this.#resumeState.sessionId }),
      liveBackgroundTasks: this.#liveBackgroundTasks().length,
      liveBackgroundPeers: this.#peerBroker?.backgroundTasks().length ?? 0,
      // 種類が `local_agent` と分かるものだけを数える: 知らない種類（`(不明)` を含む）を作業者に数えると、鍵を使わない子プロセスを待たずに畳むため
      liveBackgroundAgents: this.#sdkSession.liveBackgroundTasks.filter(
        (task) => task.taskType === BACKGROUND_AGENT_TASK_TYPE,
      ).length,
      backgroundTaskCommands: this.#liveBackgroundTasks().flatMap((task) => {
        const command = this.#stopState.backgroundTaskCommand(task.id);
        return command === undefined ? [] : [command];
      }),
      ...(this.#tokenFingerprint === undefined ? {} : { tokenFingerprint: this.#tokenFingerprint }),
      classifierDenials: this.#denialStreaks.overLimit(),
      ...this.#pendingPeerApprovalsState(),
    };
  }

  /** 確認待ちの peer の本数と最古の待ち始め（#4886）。待っているものが無ければ欄ごと無い。 */
  #pendingPeerApprovalsState(): Pick<RunnerManagerState, 'pendingPeerApprovals'> {
    const pending = this.#peerBroker?.pendingApprovals() ?? [];
    if (pending.length === 0) return {};
    const oldest = Math.min(...pending.map((entry) => entry.since));
    return {
      pendingPeerApprovals: { count: pending.length, oldestSince: new Date(oldest).toISOString() },
    };
  }

  get stopping(): boolean {
    return this.#sdkSession.stopped;
  }

  // 作業者の完了を契機に呼ばない: 同一の query ストリームで完了が現れるので、呼ぶと SDK の自己継続と二重にターンが回り `worker_wait` の `byCause` も壊れるため
  push(text: string, images?: readonly AgentInputImage[]): void {
    if (this.#sdkSession.stopped) return;
    this.#sdkSession.enqueueInput(
      images === undefined || images.length === 0 ? { text } : { text, images },
    );
    this.#sdkSession.setStatus('running');
    this.#sdkSession.wakeInput();
  }

  // 返事の宛先を推測しない（`requestId` で指す）: 取り違えは拒否を承認に変えるため
  // `decideAnswer` を `#onPermission` と共有する: 2箇所に式を書くと黙ってずれるため
  // `decision` 欄に `unreadable` をそのまま出す: `deny` に畳むと本当に拒否された回と区別できないため
  answer(answer: RunnerAnswerCommand): RunnerAnswerOutcome {
    const pending = this.#pending.find((request) => request.id === answer.requestId);
    if (!pending) return { delivered: false };
    const { decision, unreadable } = decideAnswer(pending.kind, answer.decision, answer.message);
    pending.settle({
      message: answer.message,
      ...(answer.decision === undefined ? {} : { decision: answer.decision }),
    });
    return { delivered: true, decision: unreadable ? 'unreadable' : decision };
  }

  // 戻り値を3状態にしない: 他パッケージからも見える公開面へ波及するため（3状態は `#readTranscript` が持つ）
  async transcript(): Promise<string | null> {
    const result = await this.#readTranscript();
    return result.status === 'ok' ? result.body : null;
  }

  // `#readTranscript` の3状態と同じ扱い（パスが無い・読めないは null）。全文を読まず末尾だけ読む（#5160）
  async transcriptTail(maxChars: number): Promise<string | null> {
    const path = this.#sdkSession.transcriptPath;
    if (path === undefined) return null;
    try {
      return (await readRedactedTranscriptTail(path, maxChars)).body;
    } catch {
      return null;
    }
  }

  async unpushedWork(options?: { signal?: AbortSignal }): Promise<UnpushedWorkResult> {
    const spawnFn = this.#gitSpawnFn();
    // `options.signal` で始めた git 呼び出しを止めない: `computeUnpushedWork` 自身のタイムアウトまで走らせ、止めるのは次の作業ツリーへ進む前だけ
    return computeUnpushedWork(this.#cwd, {
      spawn: spawnFn,
      env: this.#childEnv(),
      managerId: this.#id,
      hintDirs: this.#gitDirHints,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  #gitSpawnFn(): (spawnOptions: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) => ChildProcess {
    return this.#childUser === undefined
      ? (spawnOptions) =>
          spawn(spawnOptions.command, spawnOptions.args, {
            ...(spawnOptions.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
            env: spawnOptions.env,
            signal: spawnOptions.signal,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
      : (spawnOptions) => this.#spawnAsChildUser(spawnOptions);
  }

  async rescueRef(options: { signal?: AbortSignal; waitForRunning?: boolean } = {}): Promise<void> {
    if (this.#rescueRunning !== null) {
      // 畳む直前の回は見送らず走行中の回の終わりを待つ: 見送ると畳む直前の変更が退避されないまま器が消えるため
      if (options.waitForRunning !== true) return;
      const running = this.#rescueRunning;
      const aborted = new Promise<void>((resolve) => {
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      await Promise.race([running, aborted]);
      if (this.#rescueRunning !== null || options.signal?.aborted === true) return;
    }
    const run = (async (): Promise<void> => {
      try {
        const childEnv = this.#childEnv();
        const worktrees = await runRescue(this.#cwd, {
          managerId: this.#id,
          spawn: this.#gitSpawnFn(),
          env: childEnv,
          memory: this.#rescueMemory,
          ...(this.#rescueMaxWorktrees === undefined
            ? {}
            : { maxWorktrees: this.#rescueMaxWorktrees }),
          // 未追跡のファイルの預かり（#4863 案A）。畳む直前の回（`waitForRunning`）は安定を待たない。
          // 所有者の検査は出し箱と同じ（子を降ろす構成なら子の uid、降ろさない構成なら runner 自身の uid）
          stash: {
            stagedRoot: this.#rescueStagedRoot,
            expectedUid: this.#childUser?.uid ?? process.getuid?.(),
            secretEnv: childEnv,
            // 資格の置き場（`ALTEROID_CREDENTIAL_DIR`・`*_FILE`）は、子へ渡す env の層と runner 自身の env の両方で見る
            credentialEnv: { ...this.#env, ...childEnv },
            ...(options.waitForRunning === true ? { final: true } : {}),
            onResult: (worktree, result) => {
              this.#emit({
                type: 'rescue_files',
                managerId: this.#id,
                worktree,
                files: result.files,
                skipped: result.skipped,
              });
            },
          },
          hintDirs: this.#gitDirHints,
          onListIncomplete: (incomplete) => this.#noteRescueListIncomplete(incomplete),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (worktrees.length > 0) {
          this.#emit({ type: 'rescue_ref', managerId: this.#id, worktrees });
        }
      } catch {
        // 退避は best-effort。この1回の失敗でセッションを巻き込まない。
      } finally {
        this.#rescueRunning = null;
      }
    })();
    this.#rescueRunning = run;
    await run;
  }

  // resume の一時ディレクトリの外の生ログは読まない: 子の設定ディレクトリに在る会話は開き直しても見つかり、材料を渡すと resume の経路そのものが変わるため
  async #readTranscriptInResumeConfigDir(): Promise<unknown[] | undefined> {
    const path = this.#sdkSession.transcriptPath;
    const sessionId = this.#resumeState.sessionId;
    if (path === undefined || sessionId === undefined) return undefined;
    if (sessionIdInSdkResumeConfigDir(path) !== sessionId) return undefined;
    try {
      const entries = parseTranscriptEntries(await readFile(path, 'utf8'));
      if (entries !== undefined) return entries;
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `鍵の回転で開き直す前に、resume の一時ディレクトリの生ログ（${path}）を読み切れなかった（空か、読めない行が在る）。材料なしで開き直す。`,
      });
    } catch (error) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `鍵の回転で開き直す前に、resume の一時ディレクトリの生ログ（${path}）を読めなかった。材料なしで開き直す: ${reasonOf(error)}`,
      });
    }
    return undefined;
  }

  // 「無い」の種類を潰さない（`no-path` はフックの配線、`unreadable` はディスク・権限を疑う別の次の一手）
  async #readTranscript(): Promise<
    | { status: 'no-path' }
    | { status: 'unreadable'; error: unknown }
    | { status: 'ok'; body: string }
  > {
    const path = this.#sdkSession.transcriptPath;
    if (path === undefined) return { status: 'no-path' };
    try {
      // 返す前に画像の中身を控えへ置き換える: archive と transcript API の両方がここを通り、base64 が生ログに残ると保持期限（30日）後も消えないため
      return {
        status: 'ok',
        body: await redactImagesInTranscriptYielding(await readFile(path, 'utf8')),
      };
    } catch (error) {
      return { status: 'unreadable', error };
    }
  }

  async stop(
    reason: string,
    options: { captureUnpushedWork?: boolean; keepPeers?: boolean } = {},
  ): Promise<void> {
    if (this.#sdkSession.stopped) {
      // 畳み中のものがあれば待ってから返る（2本目は自分では畳まない）: 即座に返すと `stop()` を await した呼び出し元が畳み終わったと思って先へ進むため
      // 例外を飲み込まない: 呼び出し元は既に `stop()` が投げうる前提で受けているため
      const closing = this.#sdkSession.closing;
      if (closing) await closing;
      return;
    }
    await this.#sdkSession.trackClosing(() => this.#stopBody(reason, options));
  }

  async #stopBody(
    reason: string,
    options: { captureUnpushedWork?: boolean; keepPeers?: boolean } = {},
  ): Promise<void> {
    this.#sdkSession.markStopped();

    // `#settleAll` より前に状態を控える: 控えずに `#status` を読むと確認が解放された後の `running` を報告が名乗ってしまうため
    const statusAtStop = this.#sdkSession.status;
    // 鍵の付け替えの畳みで CLI の背景処理（peer は数えない。預けて続くため）が残っていたら、その木を撃つ側へ回す（#5044）。閉じる前に数える
    const abandonTree =
      options.keepPeers === true && this.#sdkSession.liveBackgroundTasks.length > 0;

    // `result` を待たずに渡す: この経路で畳まれたぶんは台帳に1行も残らず、渡し損ねたら二度と取れないため
    await this.#flushUsage();

    // `worker_wait` をここで閉じる: この経路は `#finish` を通らず、閉じないと開いたままの区間が黙って消えるため
    this.#closeWorkerWaitWindow();

    // 分類できなかった失敗の件数もここで出す: `#finish` にだけ置くと、器の入れ替えと `manager_stop` で畳まれたぶんの量が失われるため
    noteUnclassifiedFailuresSummary(this.#sdkSession.unclassifiedFailures, this.#id);

    this.#settleAll(reason);
    this.#workerTools.settleAll();
    this.#dropSessionAllowRulesOnClose();
    this.#sdkSession.wakeInput();
    // 鍵の付け替えのための畳み（`keepPeers`）では peer を閉じずに預ける（#4734）: peer は担当の Claude の鍵と関係の無い資格で走っていて、閉じると担当が持っていた作業者が黙って消えるため。
    // 人間・クローンの停止と器の畳みでは今どおり閉じる
    if (
      options.keepPeers === true &&
      this.#peerBroker !== undefined &&
      this.#peerBinding !== undefined
    ) {
      this.#peerBinding.parked = true;
      const parked: ParkedPeers = { broker: this.#peerBroker, binding: this.#peerBinding };
      this.#peerBroker = undefined;
      this.#peerBinding = undefined;
      this.#onPeersParked?.(parked);
    } else {
      await this.#peerBinding?.rollouts.closeAfterCollecting();
      this.#peerBroker?.closeAll();
    }
    this.#sdkSession.closeQuery();
    // 生ログの送り出しと報告を `#reader` が終わるまで待つ: `query.close()` の前に読むと CLI が EOF を受けてから書く最後の数行を取りこぼすため
    await this.#sdkSession.reader?.catch(() => undefined);
    // 止まる前に全文を返す: runner のディスクは器と一緒に消え、渡し損ねると manager_id から生ログへ降りる経路が切れるため
    await this.#shipArchive();
    // `this.#status` ではなく `statusAtStop` を渡す: `#settleAll` が確認を解いた後の `#status` は報告の意味が変わるため
    await this.#flushUnreported(reason, statusAtStop);
    // 例外を投げない（`.catch()` を添える）: 観測1回の失敗で畳みそのものを巻き添えにしないため
    // 期限を切る（`STOP_UNPUSHED_WORK_TIMEOUT_MS`）: SIGTERM から `exit(0)` するまでの猶予 `FORCED_EXIT_MS` を大きく食わないため
    if (options.captureUnpushedWork === true) {
      // 観測の emit は退避を待たない: 待たせると競走の窓が広がるため
      const rescued = this.rescueRef({
        signal: AbortSignal.timeout(STOP_RESCUE_TIMEOUT_MS),
        waitForRunning: true,
      });
      const unpushedWork = await this.#finishUnpushedWorkFn({
        signal: AbortSignal.timeout(STOP_UNPUSHED_WORK_TIMEOUT_MS),
      })
        .then((result): FinishUnpushedWorkOutcome => ({ kind: 'ok', result }))
        .catch((error: unknown): FinishUnpushedWorkOutcome => ({
          kind: 'unavailable',
          reason: `確かめようとして例外が飛んだ: ${reasonOf(error)}`,
        }));
      this.#emit({ type: 'shutdown_unpushed_work', managerId: this.#id, unpushedWork });
      await rescued;
    } else {
      this.#rescueOnClose();
    }
    await this.#noteWorktreesOutsideScratchConvention();
    this.#onClosed(abandonTree ? { abandonTree: true } : undefined);
  }

  // 退避から漏れた作業ツリーがあることを note で知らせる（#4681）。打ち切られた分は退避されず、知らせないと人間もクローンも気づけないため
  #noteRescueListIncomplete(incomplete: RescueListIncomplete | undefined): void {
    const text = this.#rescueListNotice.next(incomplete);
    if (text === undefined) return;
    // 日誌だけにしない（#4685）: 退避から漏れた作業ツリーは、クローンが手を打つべき出来事のため。同じ状態の間は1度だけ（`RescueListNotice`）
    this.#emit({ type: 'note', managerId: this.#id, text, notifyClone: true });
  }

  /**
   * 担当を畳むときに退避 ref を1回撃つ（#4677）。畳んだ担当は `#sessions` から外れ、周期の退避の対象にならないので、
   * 撃たないと最後の周期より後の変更が退避に載らない。走行中の回があれば、その終わりを待ってから撃つ。
   * 待たない: デーモンへの停止の応答・`closed` を退避の push で遅らせないため。作業ツリーはディスクに残っているので、外れた後も走れる。
   */
  #rescueOnClose(): void {
    const rescue = this.rescueRef({
      signal: AbortSignal.timeout(STOP_RESCUE_TIMEOUT_MS),
      waitForRunning: true,
    }).catch(() => undefined);
    // host へ渡す（#4789）: 終わった担当は host のセッション一覧から外れるので、渡さないと畳み（`shutdown`）がこの push を待たずに終わり、器ごと消える作業ツリーの写しが途中で失われるため
    this.#onCloseRescue?.(rescue);
  }

  /**
   * 決まり（担当の作業場か `/tmp/mgr-<委譲 id の頭>`）の外で git を打った作業ツリーが残っていれば、パスを note に出す。
   * 片付け（`scratch-sweep.ts`）はこれを消さない: 名前が担当と結びつかず、複数の担当が共有していることがあり、取り違えると生きている担当の作業を消すため（2026-10-13 のクローン teto の判断）。
   */
  async #noteWorktreesOutsideScratchConvention(): Promise<void> {
    if (this.#gitDirHints.length === 0) return;
    const roots = await worktreeRootsOfDirs(this.#gitDirHints).catch(() => [] as string[]);
    const outside = roots.filter(
      (root) => !isSameOrInside(root, this.#cwd) && !isUnderManagerScratchDir(root),
    );
    if (outside.length === 0) return;
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        `決まり（担当の作業場か /tmp/mgr-<委譲 id の頭>）の外で git を打った作業ツリーが残っている。` +
        `未 push の観測と退避 ref はこれも見たが、runner の片付けは消さない（共有の作業場を取り違えて消さないため）。` +
        `要らなければ人間か担当が消すこと: ${outside.join(', ')}`,
    });
  }

  // `stop()` ではなく `#finish()` を通す: 自己失効はランナー自身の判断で、デーモンが知る手段が `closed` イベントしかないため
  // 文言（`reason`）で自己失効を判定させない: `lost` だけでは resume 不能と区別できず、構造化された印 `selfFenced: true` だけを台帳が見る
  async selfFence(reason: string): Promise<void> {
    if (this.#sdkSession.stopped) return;
    await this.#finish('lost', reason, { selfFenced: true });
  }

  // セッションが無ければ印を立てない: 次に `#open()` するのはもう新しい鍵のもとのため
  recycleForToken(claudeKeyChanged = false): void {
    if (this.#sdkSession.query === null) return;
    this.#sdkSession.requestTokenRecycle(claudeKeyChanged);
    this.#sdkSession.wakeInput();
  }

  #open(resume?: string): void {
    if (this.#sdkSession.query) return;
    // 止めたセッションでは CLI を起こさない（#5205）: 立て直し・鍵の回転の開き直しのどの経路から呼ばれても、名簿から外れた後に生きた CLI が残り、stop も答えも届かなくなるため
    if (this.#sdkSession.stopped) return;
    this.#sdkSession.clearPreRotationClaudeKey();
    // 開いた後は新しい鍵のもと: 前の鍵での作業者の落ちを、次の開き直しへ持ち越さない（#5046）
    this.#workerLimitOnPreRotationKey = false;
    // 「whenever the session's CLI process (re)starts」[sdk-verbatim SDKBackgroundTasksChangedMessage] に対応するのはここで、`init` ではない: `init` はターンの頭ごとに来るだけのため
    this.#sdkSession.resetLiveBackgroundTasks();
    this.#nonWorkerTaskIds.clear();
    const generation = this.#sdkSession.generation;
    const session = this.#driver.open(this.#buildSpec(resume));
    this.#sdkSession.open(session, this.#read(session, generation));
    this.#reapplySessionAllowRules();
  }

  #peerMcpEntry(): McpServers[string] | undefined {
    // 組むたびに読み直す: 資格が届いた・外れたあとの組み直しで道具が出る・消える
    const peer = this.#peer?.();
    if (peer === undefined) return undefined;
    const allowed = peer.peers.filter((provider) => provider !== DEFAULT_AGENT_PROVIDER_ID);
    if (allowed.length === 0) return undefined;
    let childEntry: string;
    try {
      childEntry = peer.childEntry ?? resolveCloneToolRelayChildEntry(import.meta.url);
    } catch (error) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `MCP peer を出せなかった（中継の子が見つからない）: ${reasonOf(error)}`,
      });
      return undefined;
    }
    const broker = (this.#peerBroker ??= this.#createPeerBroker(allowed, peer));
    const token = peer.host.register(() => broker.mcpServer().instance);
    return {
      type: 'stdio',
      command: process.execPath,
      args: [childEntry],
      env: {
        [CLONE_TOOL_RELAY_SOCKET_ENV]: peer.host.socketPath,
        [CLONE_TOOL_RELAY_TOKEN_ENV]: token,
      },
    };
  }

  #managerToolsMcpEntry(): McpServers[string] | undefined {
    const tools = this.#managerTools;
    if (tools === undefined) return undefined;
    let childEntry: string;
    try {
      childEntry = tools.childEntry ?? resolveCloneToolRelayChildEntry(import.meta.url);
    } catch (error) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `MCP ${MANAGER_TOOLS_MCP_SERVER_NAME} を出せなかった（中継の子が見つからない）: ${reasonOf(error)}`,
      });
      return undefined;
    }
    const token = tools.host.register(
      () =>
        createManagerToolsMcpServer({
          record: (input) =>
            this.#emit({
              type: 'external_output',
              managerId: this.#id,
              output: { ...input, at: new Date().toISOString() },
            }),
          managerId: this.#id,
          // 出し箱が無い構成では道具を出さない（プロンプトも同じ判定で `cp` の案内のままにする）
          ...(this.#outboxDir === undefined
            ? {}
            : { attach: (paths: string[]) => this.#attachToOutbox(paths) }),
          restore: (input) =>
            this.#emit({
              type: 'rescue_restore_request',
              managerId: this.#id,
              ...(input.paths === undefined ? {} : { paths: input.paths }),
              ...(input.from === undefined ? {} : { from: input.from }),
            }),
        }).instance,
    );
    return {
      type: 'stdio',
      command: process.execPath,
      args: [childEntry],
      env: {
        [CLONE_TOOL_RELAY_SOCKET_ENV]: tools.host.socketPath,
        [CLONE_TOOL_RELAY_TOKEN_ENV]: token,
      },
    };
  }

  // 受け口はすべて結び（`binding`）を通す（#4734）: 鍵の付け替えで畳んだ後、起こし直した新しいセッションへ窓口ごと付け替えるため。
  // 預けている間（`parked`）の確認と背景の止まりどころは、黙って捨てず預かり、付け替えた先へ回す
  #createPeerBroker(allowed: readonly AgentProviderId[], peer: RunnerPeerOptions): PeerBroker {
    const rollouts = new PeerRolloutMirror({
      codexHome: () => binding.session.#peerCodexHome(),
      mainKey: () => binding.session.#mainLogKey,
      mirror: (key, entries) =>
        binding.session.#emit({ type: 'mirror', managerId: binding.session.#id, key, entries }),
      note: (text) => binding.session.#emit({ type: 'note', managerId: binding.session.#id, text }),
      // rollout の読みは子の uid の子プロセスで行う（#5259）。env は呼ぶたびに引く（`#childEnv()` は変わりうる）
      ...(this.#childUser === undefined
        ? {}
        : {
            io: {
              realpaths: (paths) => binding.session.#childRolloutIo()!.realpaths(paths),
              readChunk: (file, offset, length) =>
                binding.session.#childRolloutIo()!.readChunk(file, offset, length),
            },
          }),
    });
    const binding: PeerBinding = {
      session: this,
      parked: false,
      heldAsks: [],
      heldStops: [],
      rollouts,
      ...(this.#mainLogKey === undefined ? {} : { lastMainKey: this.#mainLogKey }),
    };
    this.#peerBinding = binding;
    // 組む（遅延で1回）時点で戻されている peer。置けなかった id はここから外れ、`peer_reply` は今までどおり断る
    const resumable = new Map<string, PeerResumable>();
    for (const [peerId, seed] of this.#peerSeeds) {
      resumable.set(peerId, {
        provider: seed.provider as AgentProviderId,
        threadId: seed.threadId,
      });
    }
    return createPeerBroker({
      allowed,
      resumable,
      prepareResume: async (peerId) => {
        try {
          await binding.session.#placePeerRollout(peerId);
        } catch (error) {
          resumable.delete(peerId);
          throw error;
        }
      },
      onThread: (event) => {
        if (event.kind === 'started') {
          void rollouts.track({
            peerId: event.peerId,
            provider: event.provider,
            threadId: event.threadId,
            transcriptLocation: event.transcriptLocation,
            resumed: event.resumed,
          });
        } else {
          void rollouts.collect(event.peerId);
        }
      },
      limits: resolvePeerLimits(this.#env),
      ...(peer.models === undefined ? {} : { models: peer.models }),
      // 組んだ後に資格が外れたら、相手を起こさずに断る（道具が消えるのは次の組み直し）
      closedReason: (provider) =>
        binding.session.#peer?.()?.peers.includes(provider) === true
          ? undefined
          : `この器では peer（${provider}）がいま閉じている（資格が外れた。理由は runner_list の peer の行に出る）`,
      askApproval: (source, request) =>
        binding.parked
          ? new Promise<AgentPermissionDecision>((resolve) => {
              binding.heldAsks.push({
                run: () => {
                  binding.session.#onPermission(request, source).then(resolve, (error: unknown) =>
                    resolve({
                      behavior: 'deny',
                      message: `確認を上げられなかった: ${reasonOf(error)}`,
                    }),
                  );
                },
                deny: (message) => resolve({ behavior: 'deny', message }),
              });
            })
          : binding.session.#onPermission(request, source),
      driverOf: (provider) =>
        provider === 'codex'
          ? new CodexManagerDriver(
              binding.session.#codexAuth === undefined
                ? {}
                : { chatgptAuth: binding.session.#codexAuth },
            )
          : new ClaudeManagerDriver(
              binding.session.#queryFn === undefined ? {} : { queryFn: binding.session.#queryFn },
            ),
      reportsUsage: (provider) => peer.reportsUsage(provider),
      onNote: (text) =>
        binding.session.#emit({ type: 'note', managerId: binding.session.#id, text }),
      // 背景へ回した peer の止まりどころは、マネージャーへの知らせとして入れて起こす
      onBackgroundStop: (result) => {
        if (binding.collectStop !== undefined) binding.collectStop(result);
        else if (binding.parked) binding.heldStops.push(result);
        else binding.session.#onPeerBackgroundStop(result);
      },
      // 作業者の長い道具と同じ口に載せる: ホームの稼働状況に、作業者と同じ形で「実行中」を出すため
      onTurn: (event) => {
        const toolUseId = `peer:${event.turnId}`;
        if (event.kind === 'ended') {
          binding.session.#emit({ type: 'tool_end', managerId: binding.session.#id, toolUseId });
          return;
        }
        binding.session.#emit({
          type: 'tool_running',
          managerId: binding.session.#id,
          actor: peerActorOf(binding.session.#id, event.provider),
          tool: event.tool,
          toolUseId,
          startedAt: event.startedAt,
          ...(event.model === undefined ? {} : { model: event.model }),
        });
      },
      onUsage: (report) =>
        binding.session.#emit({
          type: 'peer_usage',
          managerId: binding.session.#id,
          provider: report.provider,
          ...(report.sessionId === undefined ? {} : { sessionId: report.sessionId }),
          models: report.models,
          ...(report.unmetered ? { unmetered: true } : {}),
        }),
      // 作られたファイルを、道具の記録に残らない作り方（コードで書いた等）でも拾う
      scanWorkdir: (dir, sinceMs) => scanPeerWorkdir(dir, sinceMs),
      makeSpec: (provider, parts) => ({
        ...binding.session.#buildSpec(undefined, true),
        ...binding.session.#peerWorkdirSpec(),
        input: parts.input,
        ...(parts.resume === undefined ? {} : { resume: parts.resume }),
        // 置かれたモデルを peer に効かせない: ホストの provider のものなので、名指しが無ければ各 provider の既定に任せるため
        model: parts.model ?? resolveManagerModel({}),
        modelPlaced: parts.model !== undefined,
        workerModel: resolveWorkerModel({}),
        // `strictApprovals` を載せない: 載せると構えが `default` / `untrusted` に締まるため
        permissionMode: binding.session.#permissionMode,
        // peer の生ログを預けない: マネージャーの生ログと混ぜないため
        sessionLog: { append: async () => undefined, load: async () => null },
        onPermission: parts.onPermission,
        onNote: parts.onNote,
        onPreToolUse: () => ({ kind: 'continue' }),
        onPermissionDenied: async () => ({ kind: 'no-retry' }),
        onPostToolUse: (record) => {
          binding.session.#emit({
            type: 'tool_use',
            managerId: binding.session.#id,
            actor: peerActorOf(binding.session.#id, provider),
            tool: record.toolName ?? '(不明)',
            input: record.toolInput,
          });
          return { kind: 'continue' };
        },
        onPostToolUseFailure: (record) => binding.session.#notePeerToolUseFailure(provider, record),
        onPreCompact: () => undefined,
        onUserPromptSubmit: () => undefined,
        onSubagentStop: () => ({ kind: 'continue' }),
        onStop: () => undefined,
      }),
    });
  }

  /**
   * peer の作業場。マネージャーの cwd（共有の `/workspace` など）ではなく、マネージャーの作業場
   * `/tmp/mgr-<先頭8桁>` に揃える（無ければ作る）。作れなければ、マネージャーの cwd のままにして note を残す。
   * 作ったときは子の uid へ渡す: runner の持ち物のままだと、マネージャー本人も peer もそこへ書けないため。
   */
  #peerWorkdirSpec(): { cwd?: string; systemPromptAppend: string } {
    const dir = managerScratchDirOf(this.#id, this.#peer?.()?.workdirRoot);
    try {
      const created = mkdirSync(dir, { recursive: true });
      if (created !== undefined && this.#childUser !== undefined) {
        chownSync(dir, this.#childUser.uid, this.#childUser.gid);
      }
    } catch (error) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `peer の作業場 ${dir} を作れなかったので、マネージャーの cwd のままにした: ${reasonOf(error)}`,
      });
      return {
        systemPromptAppend: withReportLanguageParagraph(
          PEER_SYSTEM_PROMPT_APPEND,
          this.#sessionReportLanguage(),
        ),
      };
    }
    return {
      cwd: dir,
      systemPromptAppend: withReportLanguageParagraph(
        peerSystemPromptAppend(dir),
        this.#sessionReportLanguage(),
      ),
    };
  }

  /**
   * セッションを開く時点の `ALTEROID_REPORT_LANGUAGE`（#4977。プロファイルが優先）。
   * 不正な値は off へ倒す: 言語の指示のためにセッションを開けなくしないため。日誌は `#4965` の知らせと同じ1行に寄せる。
   */
  #sessionReportLanguage(): ReportLanguageMode {
    try {
      return resolveEffectiveReportLanguage(this.#env, this.#profileEnv());
    } catch (error) {
      this.#noteReportLanguageMisconfig(error);
      return 'off';
    }
  }

  /**
   * セッションを開く時点の歯の状態（#5017）。担当・作業者のプロンプトに、断られる形の一覧を載せるかを決める。
   * 判定が投げたら載せない: プロンプトを作れなくするより、載せないほうへ倒す。
   * 既知の限界: 開いた後に設定（プロファイルを含む）が変わっても、プロンプトは作り直さない。歯そのものは呼び出しのたびに読むので、断る・断らないは変わるが、告知の一覧は開いた時点のまま。
   * 両方とも偽なら undefined（プロンプトは1文字も増えない）。
   */
  #sessionBashGuards(): BashGuardsInPrompt | undefined {
    const shape = ((): boolean => {
      try {
        return resolveEffectiveBashShapeGuard(this.#env, this.#profileEnv()) === 'on';
      } catch {
        return false;
      }
    })();
    const wait = this.#bashGuard !== 'off';
    return shape || wait ? { shape, wait } : undefined;
  }

  // 開く時点と発言の観測の両方から呼ぶ。同じ値は1回だけ書く: 設定の誤りは1つで、日誌を2行にしないため
  #noteReportLanguageMisconfig(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.#reportLanguageMisconfigNoted === message) return;
    this.#reportLanguageMisconfigNoted = message;
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        `報告の言語を掛けていない: ${message}。直すまで、英語の文の知らせも、` +
        '担当・作業者のプロンプトへの言語の指示も掛けない（指示は直した後に開くセッションから入る）。#4965 #4977',
    });
  }

  // `tool_use` にしない: 旧 daemon が未知の欄を落とすため
  #notePeerToolUseFailure(provider: AgentProviderId, record: AgentToolAuditFailureRecord): void {
    const error =
      typeof record.error === 'string'
        ? excerptLine(
            redactErrorText(record.error, process.env, this.#vaultValues()),
            TOOL_USE_FAILURE_ERROR_EXCERPT,
          )
        : '(不明)';
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: `${TOOL_USE_FAILURE_NOTE_PREFIX} 道具=${record.toolName ?? '(不明)'}・actor=${peerActorOf(this.#id, provider)}・error=${error}`,
    });
  }

  #buildSpec(resume?: string, forPeer = false): AgentManagerSessionSpec {
    // `#childEnv()` より先に用意する: 用意できた後だけ `CLAUDE_CODE_TMPDIR` を渡すため
    this.#prepareClaudeTmpDir();
    // プロファイルが上書きした後の値から指紋を控える: 子が実際に掴む鍵を見るため（peer のセッションは別物なので控えない）
    const childEnv = this.#childEnv();
    if (!forPeer) this.#tokenFingerprint = tokenFingerprintOf(childEnv);
    // 1回だけ呼ぶ: 呼ぶたびに使い捨ての token を発行するため。道具とプロンプトの案内は同じ判定から出す
    const peerEntry = forPeer ? undefined : this.#peerMcpEntry();
    const peerModels = peerEntry === undefined ? undefined : this.#peer?.()?.models?.codex;
    // peer のセッションには出さない: 記録するのはマネージャー自身で、peer の成果はマネージャーが受け取ってから記録する
    const managerToolsEntry = forPeer ? undefined : this.#managerToolsMcpEntry();
    // 開くたびに読む（新規・resume・鍵の回転の起こし直しはどれも `#open` からここを通る）: system prompt は開く時点で決まるため
    const reportLanguage = this.#sessionReportLanguage();
    const bashGuards = this.#sessionBashGuards();
    return {
      input: this.#inputStream(),
      model: resolveManagerModel(this.#env),
      modelPlaced: placedModelTier(this.#env, MANAGER_MODEL_ENV_KEY) !== null,
      permissionMode: this.#permissionMode,
      systemPromptAppend: withReportLanguageParagraph(
        buildManagerSystemPrompt({
          managerId: this.#id,
          workerName: WORKER_AGENT_NAME,
          ...(peerEntry === undefined
            ? {}
            : { peer: peerModels === undefined ? {} : { models: peerModels } }),
          ...(managerToolsEntry === undefined ? {} : { managerTools: true }),
          ...(managerToolsEntry === undefined || this.#outboxDir === undefined
            ? {}
            : { reportAttach: true }),
          ...(bashGuards === undefined ? {} : { bashGuards }),
        }),
        reportLanguage,
      ),
      workerAgentName: WORKER_AGENT_NAME,
      // 作業者にも足す: 作業者は担当の system prompt を継がないため
      workerPrompt: withReportLanguageParagraph(buildWorkerPrompt(bashGuards), reportLanguage),
      ...(reportLanguage === 'off' ? {} : { reportLanguage }),
      // 省略しない: SDK の既定は親の継承で、省くとマネージャーを差し替えた人が作業者まで巻き添えで動かすため
      workerModel: resolveWorkerModel(this.#env),
      cwd: this.#cwd,
      env: childEnv,
      managerAutoMemoryEnabled: resolveManagerAutoMemoryEnabled(this.#env),
      ...(() => {
        const plugins = this.#pluginRefs();
        return plugins.length === 0 ? {} : { plugins };
      })(),
      ...(() => {
        const human = this.#mcpServers();
        if (peerEntry === undefined && managerToolsEntry === undefined) {
          return human === undefined ? {} : { mcpServers: human };
        }
        // alteroid 自身のサーバを後に置いて勝たせる（人間の登録が同じ名前を使っても差し替わらない）
        return {
          mcpServers: {
            ...human,
            ...(peerEntry === undefined ? {} : { [PEER_MCP_SERVER_NAME]: peerEntry }),
            ...(managerToolsEntry === undefined
              ? {}
              : { [MANAGER_TOOLS_MCP_SERVER_NAME]: managerToolsEntry }),
          },
        };
      })(),
      // runner に永続化の器を置かない: 記憶ストアの鍵を runner に置かないため
      sessionLog: this.#sessionLog(),
      ...(resume === undefined ? {} : { resume }),
      // 道具も preset も削らない: 変えるのは実行する主体だけのため
      ...(this.#childUser === undefined
        ? {}
        : { spawnProcess: (options) => this.#spawnDelegationProcess(options) }),
      onPermission: (request) => this.#onPermission(request),
      onNote: (text) => this.#emit({ type: 'note', managerId: this.#id, text }),
      onPreToolUse: (record) => this.#onPreToolUse(record),
      onPermissionDenied: (record) => this.#onPermissionDenied(record),
      onPostToolUse: (record) => this.#onPostToolUse(record),
      onPostToolUseFailure: (input) => this.#onPostToolUseFailure(input),
      onPreCompact: (record) => this.#onPreCompact(record),
      onUserPromptSubmit: (record) => this.#onUserPromptSubmit(record),
      onSessionStart: (record) => this.#onSessionStart(record),
      onSubagentStop: (record) => this.#onSubagentStop(record),
      onStop: (record) => this.#onStop(record),
    };
  }

  // runner のディスクに前回の生ログが残っている前提を置かない: 器は作り直されるため
  #sessionLog(): AgentSessionLog {
    return {
      append: async (key: AgentSessionLogKey, entries: unknown[]) => {
        const mirrorKey = {
          projectKey: key.projectKey,
          sessionId: key.sessionId,
          ...(key.subpath === undefined ? {} : { subpath: key.subpath }),
        };
        if (key.subpath === undefined) {
          this.#setMainLogKey({ projectKey: key.projectKey, sessionId: key.sessionId });
        }
        // 画像の中身は mirror（pg）へ流さない: 保持期限後も消えない生ログになるため
        // 書き出し1回分を丸ごと1件にしない: 数十 MB の1行をデーモンが受けて処理する間、ループが秒単位で塞がるため（#4485）
        for (const chunk of chunkMirrorEntries(
          redactImagesInEntries(entries),
          MIRROR_EVENT_MAX_CHARS,
        )) {
          this.#emit({ type: 'mirror', managerId: this.#id, key: mirrorKey, entries: chunk });
        }
        this.#emit({ type: 'project_key', managerId: this.#id, projectKey: key.projectKey });
      },
      // SDK に渡す経路（子 UID でない器・置けなかった回）でだけ呼ばれる: 自分で置いて主の `load` が `null` を返した回、SDK は一覧を引く前に戻す材料が無いと見て終わる
      listSubkeys: async () => this.#resumeState.subagents.map((subagent) => subagent.subpath),
      load: async (key: AgentSessionLogKey) => {
        if (key.subpath !== undefined) {
          // 預かった分の中の subpath だけ返す: 一覧に無い鍵を SDK が引いても、作業者の記録を作り出さない
          const found = this.#resumeState.subagents.find(
            (subagent) => subagent.subpath === key.subpath,
          );
          return found === undefined ? null : [...found.entries];
        }
        const seed = this.#resumeState.seed;
        if (seed === undefined) return null;
        // 子のふだんの設定ディレクトリへ自分で置き、SDK には材料を返さない: 返すと SDK が /tmp/claude-resume-* に書き出し、CLI が終わると消えるため（`placeSeedInConfigDir`）
        const writer = this.#childFileWriter();
        const configDir = writer === undefined ? undefined : this.#childEnv().CLAUDE_CONFIG_DIR;
        if (writer !== undefined && configDir !== undefined) {
          try {
            // 主と作業者の分を1回の子プロセスで置く（子の uid で。#5259）
            const placed = await placeResumeMaterialAsChild(
              configDir,
              key,
              seed,
              this.#resumeState.subagents,
              writer,
            );
            this.#noteSubagentPlacement(configDir, placed);
            return null;
          } catch (error) {
            this.#emit({
              type: 'note',
              managerId: this.#id,
              text: `resume の材料を子の設定ディレクトリ（${configDir}）へ置けなかったので、SDK の一時ディレクトリから resume する: ${reasonOf(error)}`,
            });
          }
        }
        return seed;
      },
    };
  }

  // 作業者の分を置けなくても主の resume は止めない（主の記録は置けている）。置けなかった・断った分は note に残す: 黙ると `SendMessage` の失敗の理由が追えない
  #noteSubagentPlacement(
    configDir: string,
    placed: { subagents: { rejected: string[] }; subagentFailure?: string },
  ): void {
    const { rejected } = placed.subagents;
    if (rejected.length > 0) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `resume の作業者の記録 ${String(rejected.length)} 件を、subpath が安全でないので置かなかった: ${rejected.join(', ')}`,
      });
    }
    if (placed.subagentFailure !== undefined) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `resume の作業者の記録を子の設定ディレクトリ（${configDir}）へ置けなかった（その作業者への SendMessage は記録が無く失敗する）: ${placed.subagentFailure}`,
      });
    }
  }

  /** 子を別 UID で起こす構成だけ: 子の書ける場所への書き込みを、子の uid の子プロセスで行う口（#5259）。 */
  #childFileWriter(): ChildFileWriter | undefined {
    if (this.#childUser === undefined) return undefined;
    return childFileWriter((options) => this.#spawnAsChildUser(options), this.#childEnv());
  }

  #childRolloutIo(): RolloutIo | undefined {
    if (this.#childUser === undefined) return undefined;
    return childRolloutIo((options) => this.#spawnAsChildUser(options), this.#childEnv());
  }

  #spawnAsChildUser(options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) {
    return spawnAsUser(this.#childUser as RunnerChildUser, options);
  }

  // `#spawnAsChildUser` と共有しない: `detached: true` と pid 追跡を委譲そのものの起動経路にだけ効かせるため
  #spawnDelegationProcess(options: SpawnAgentProcessOptions): DelegationProcessHandle {
    this.#handOverResumeConfigDir(options.env);
    const staged = this.#stageMcpConfig(options);
    // 追う pid は tini のもの: tini が sid の主になり、CLI と子孫はその sid の下に居るため（孤児の回収が撃つ単位は変わらない）
    let child: DelegationProcessHandle;
    try {
      child =
        this.#delegationSubreaper === undefined
          ? this.#spawnAgentProcessFn(staged.options)
          : subreapedProcess(
              this.#spawnAgentProcessFn(underSubreaper(staged.options, this.#delegationSubreaper)),
            );
    } catch (error) {
      staged.remove();
      throw error;
    }
    // 起動直後には消さない: CLI は起動後に設定ファイルを読み直しうるため。子が終わるまで置く
    child.once('exit', staged.remove);
    child.once('error', staged.remove);
    const pid = child.pid;
    if (pid !== undefined) {
      this.#onDelegationProcessSpawned(pid);
      const noteExited = (): void => this.#onDelegationProcessExited(pid);
      // `exit` だけに頼らない: `error` のときに `exit` が来るかは環境依存のため
      child.once('exit', noteExited);
      child.once('error', noteExited);
    }
    this.#watchDelegationStderr(child, options.env, options.signal);
    return child;
  }

  // 失敗したら握り潰さず投げる: 元の引数のまま起こすと MCP の資格（中継のトークン・人間の登録の env / headers）が argv に戻り、同じ器の他のプロセスから `ps` で読めるため
  #stageMcpConfig(options: SpawnAgentProcessOptions): {
    options: SpawnAgentProcessOptions;
    remove: () => void;
  } {
    const childUser = this.#childUser;
    let dir: string | undefined;
    const remove = (): void => {
      if (dir === undefined) return;
      this.#liveMcpConfigDirs.delete(dir);
      rmSync(dir, { recursive: true, force: true });
    };
    try {
      let count = 0;
      const args = relocateMcpConfigArgs(options.args, (json) => {
        if (dir === undefined) {
          dir = mkdtempSync(joinPath(this.#mcpConfigTmpRoot, RUNNER_MCP_CONFIG_DIR_PREFIX));
          this.#liveMcpConfigDirs.add(dir);
        }
        count += 1;
        const file = joinPath(dir, `mcp-config-${String(count)}.json`);
        writeFileSync(file, json, { mode: 0o600, flag: 'wx' });
        return file;
      });
      if (dir !== undefined && childUser !== undefined) {
        this.#handOverMcpConfigDirFn(dir, childUser.uid, childUser.gid);
      }
      return { options: dir === undefined ? options : { ...options, args }, remove };
    } catch (error) {
      remove();
      const text = `委譲の CLI の MCP 設定を argv の外（0600 のファイル）へ置けなかったので、起動しない: ${reasonOf(error)}`;
      this.#emit({ type: 'note', managerId: this.#id, text });
      throw new Error(text, { cause: error });
    }
  }

  /**
   * 自前で起こした子の stderr は SDK が読まない（SDK が読むのは自分で起こした子だけ）: 読まなければ落ちたときの理由が
   * 「exited with code 1」だけになり、64KB を超えて書かれるとパイプが詰まって CLI が書き込みで止まる。読み続けて末尾だけを持ち、
   * 0 以外で終わった回に note で残す（伏せ字を通す）。
   */
  #watchDelegationStderr(
    child: DelegationProcessHandle,
    childEnv: Readonly<Record<string, string | undefined>>,
    stopSignal: AbortSignal,
  ): void {
    const stderr = (child as { stderr?: NodeJS.ReadableStream | null }).stderr;
    if (stderr === undefined || stderr === null) return;
    let tail = '';
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-DELEGATION_STDERR_TAIL_CHARS);
    });
    stderr.on('error', () => undefined);
    // `exit` は stdio を読み終える前に来うる: 落ちる直前の最後の行を取りこぼさないよう、stderr の `end` を待ってから確定する
    child.once('exit', (code, signal) => {
      if (code === 0 || (code === null && signal === null)) return;
      // 止めると決めた後に、止め方どおりに終わった子は異常終了と言わない（#4488）: SDK の close() は渡した signal を abort してから
      // SIGTERM・SIGKILL を送り、runner の stop はセッションを stopped にする。言うと本物の失敗の note が埋もれるため。
      // 止めた後でも code 1 のような終わり方は言う（止める途中で本当に落ちたのかもしれない）。
      const stopRequested = stopSignal.aborted || this.#sdkSession.stopped;
      if (stopRequested && isStopTermination(code, signal)) return;
      let done = false;
      // 猶予のタイマーは unref する: runner の終了を引き止めないため
      const timer = setTimeout(() => report(), DELEGATION_STDERR_END_GRACE_MS);
      timer.unref();
      const report = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const how = code === null ? `signal ${String(signal)}` : `exit code ${String(code)}`;
        // 子に渡した env も値の伏せ字に入れる: プロファイルや鍵の袋にだけある値は runner の process.env に無いため
        const shown = redactErrorText(
          tail.trim(),
          { ...process.env, ...childEnv },
          this.#vaultValues(),
        );
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text:
            `委譲の CLI（pid ${String(child.pid ?? '?')}）が ${how} で終わった。` +
            (shown.length === 0 ? 'stderr には何も出ていなかった。' : `stderr の末尾: ${shown}`),
        });
      };
      if ((stderr as { readableEnded?: boolean }).readableEnded === true) {
        report();
        return;
      }
      stderr.once('end', report);
      stderr.once('close', report);
    });
  }

  // 起こす直前に持ち主を移す: SDK は resume の材料を root の 0700 の一時ディレクトリに書き、子の `CLAUDE_CONFIG_DIR` をそこへ向ける。別の UID の子は入れず、会話を見つけられずに終わる（生ログからの引き継ぎへ落ちる）ため。移せなくても起こすのは止めない: 引き継ぎで続けられる
  #handOverResumeConfigDir(env: Readonly<Record<string, string | undefined>>): void {
    const childUser = this.#childUser;
    if (childUser === undefined) return;
    const dir = sdkResumeConfigDirOf(env);
    if (dir === undefined) return;
    try {
      this.#handOverResumeConfigDirFn(dir, childUser.uid, childUser.gid);
    } catch (error) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `resume の材料の置き場（${dir}）を子へ渡せなかった。生ログからの引き継ぎで続ける: ${reasonOf(error)}`,
      });
    }
  }

  // 記憶ストアの所在を子プロセスへ渡さない: 渡さなければ構造的に触れないため
  // 鍵を `this.#env` のスナップショットのまま配らない: 人間が後から差し替えた鍵が永久に届かないため
  #childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const layer of childEnvLayers({
      env: this.#env,
      credentials: this.#credentials,
      profileEnv: this.#profileEnv(),
    })) {
      Object.assign(env, layer.env);
    }
    // 伏せるのは最後: 先に消してから鍵を重ねると、鍵の名前に `ALTEROID_DATABASE_URL` を渡すだけで伏せたはずの値を注入し直せるため
    for (const key of this.#withheldEnvKeys) delete env[key];
    // 伏せる処理の後・最後に置く: プロファイルや `withheldEnvKeys` で出し箱の行き先を差し替えられると、取り込む場所と担い手が書く場所がずれる
    if (this.#outboxDir !== undefined) env[RUNNER_OUTBOX_ENV] = this.#outboxDir;
    // 子の設定ディレクトリを SDK にも見せる: SDK は生ログの写しの鍵を `env.CLAUDE_CONFIG_DIR ?? <runner の homedir>/.claude` から作り、別の HOME で起こした子が書いたパスをその外として捨てる（デーモンへ1行も預からず、器が替わると resume できない）ため。既に置かれていれば子も SDK も同じ値を見るので触らない
    const childHome = this.#childUser?.home;
    if (childHome !== undefined && env.CLAUDE_CONFIG_DIR === undefined) {
      env.CLAUDE_CONFIG_DIR = joinPath(childHome, '.claude');
    }
    // 人間がプロファイルや鍵で置いた値は上書きしない
    if (this.#claudeTmpDir !== undefined && env.CLAUDE_CODE_TMPDIR === undefined) {
      env.CLAUDE_CODE_TMPDIR = this.#claudeTmpDir;
    }
    return env;
  }

  /**
   * 委譲の CLI の一時フォルダ（`CLAUDE_CODE_TMPDIR`）を、担当の作業場 `/tmp/mgr-<先頭8桁>/claude-tmp` に用意する。
   * 既定の `/tmp/claude-<uid>` のままにしない: 背景に回った処理の出力がそこに書かれ、`/tmp/claude-*` を読まない決まりのもとで担当が結果を読めず、同じ検査を回し直していたため（2026-10-13）。
   * CLI は基点の持ち主が自分でないと使わないので、子の uid の持ち物（0700）にする。
   * 子を別の uid で起こす構成（本番の runner）でだけ行う: 同じ uid で動く構成は人間の手元で、作業場を勝手に作らないため。
   * 用意できなければ既定のまま起こし、note を残す。
   */
  #prepareClaudeTmpDir(): void {
    const childUser = this.#childUser;
    if (this.#claudeTmpDir !== undefined || childUser === undefined) return;
    const scratch = managerScratchDirOf(this.#id, this.#managerScratchRoot);
    const dir = joinPath(scratch, DELEGATION_CLAUDE_TMP_DIR_NAME);
    try {
      // 作業場をここで作ったときは子へ渡す: runner の持ち物のままだと、担当がその下に書けないため
      if (mkdirSync(scratch, { recursive: true }) !== undefined) {
        chownSync(scratch, childUser.uid, childUser.gid);
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chownSync(dir, childUser.uid, childUser.gid);
      chmodSync(dir, 0o700);
      this.#claudeTmpDir = dir;
    } catch (error) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `委譲の CLI の一時フォルダ ${dir} を用意できなかったので、既定（/tmp/claude-<uid>）のまま起こす: ${reasonOf(error)}`,
      });
    }
  }

  #prepareOutbox(): string | undefined {
    try {
      return prepareManagerOutbox({
        root: this.#outboxRoot,
        managerId: this.#id,
        ...(this.#childUser === undefined ? {} : { childGid: this.#childUser.gid }),
      });
    } catch (error) {
      // 黙って落とさない: 出し箱が無いと成果物を添えられず、理由が出力に残らないと原因が辿れない
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `出し箱を用意できなかったので ${RUNNER_OUTBOX_ENV} を渡さない: ${reasonOf(error)}`,
      });
      return undefined;
    }
  }

  /** `report_attach`: 名指しされたファイルを、取り込みと同じ検めで出し箱の直下へ写す（`runner-outbox-attach.ts`）。 */
  async #attachToOutbox(paths: string[]): Promise<AttachToOutboxResult[]> {
    const childUser = this.#childUser;
    const scratchDir = managerScratchDirOf(this.#id, this.#managerScratchRoot);
    return attachToManagerOutbox({
      outboxRoot: this.#outboxRoot,
      managerId: this.#id,
      scratchParent: this.#managerScratchRoot,
      scratchName: basename(scratchDir),
      // 子を降ろす構成なら子の uid、降ろさない構成なら runner 自身の uid（`#collectOutbox` と同じ）
      expectedUid: childUser?.uid ?? process.getuid?.(),
      ...(childUser === undefined ? {} : { chownTo: { uid: childUser.uid, gid: childUser.gid } }),
      limits: readAttachmentLimits().limits,
      ...(this.#attachmentStageLimit === undefined
        ? {}
        : { maxLargeFileBytes: this.#attachmentStageLimit }),
      paths,
    });
  }

  // 同期のままにする（#4906）: 見るのは担当ごとの小さな出し箱の直下1つだけで、ループを止める重さではない。非同期にすると、報告が出る時機が実際の I/O の待ちに左右されるため
  #outboxHasEntries(): boolean {
    if (this.#outboxDir === undefined) return false;
    try {
      return readdirSync(this.#outboxDir).length > 0;
    } catch (error) {
      // 読めないことを「空」へ倒さない: 取り込みへ進めて、断りの理由を報告に載せる（無いだけなら取り込みが空を返す）
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  }

  /**
   * 報告の直前に出し箱の直下を取り込む。失敗は報告を止めず、`note` に残す（出し箱の不調でターンの報告を失わない）。
   * 失敗を `note` だけにしない: `note` は日誌にしか残らず、報告はファイルを持たない報告になって背景処理待ちなら畳まれる。
   * 置かれた名前ごとの断り（`rejectedFiles`）にして報告に載せ、クローンに理由の行を出す。
   */
  async #collectOutbox(): Promise<{
    files?: RunnerOutboxFile[];
    rejectedFiles?: RunnerOutboxRejectedFile[];
  }> {
    if (this.#outboxDir === undefined) return {};
    try {
      const collected = await collectManagerOutbox({
        root: this.#outboxRoot,
        stagedRoot: this.#outboxStagedRoot,
        managerId: this.#id,
        // 子を降ろす構成なら子の uid、降ろさない構成なら runner 自身の uid
        expectedUid: this.#childUser?.uid ?? process.getuid?.(),
        limits: readAttachmentLimits().limits,
        ...(this.#attachmentStageLimit === undefined
          ? {}
          : { maxLargeFileBytes: this.#attachmentStageLimit }),
      });
      return {
        ...(collected.files.length === 0 ? {} : { files: collected.files }),
        ...(collected.rejectedFiles.length === 0 ? {} : { rejectedFiles: collected.rejectedFiles }),
      };
    } catch (error) {
      const reason = reasonOf(error);
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `出し箱を取り込めなかった: ${reason}`,
      });
      return {
        rejectedFiles: outboxCollectFailureRefusals(
          this.#outboxRoot,
          this.#id,
          `出し箱を取り込めなかった（${reason}）。ファイルは出し箱に残っている`,
        ),
      };
    }
  }

  // 待っているストリームを1本だけ覚えない: 世代が重なるため
  async *#inputStream(): AsyncGenerator<AgentUserInput> {
    const generation = this.#sdkSession.generation;
    for (;;) {
      // 世代の確認を `shift` より先にする: 逆にすると畳まれる直前の死んだストリームが新しいセッション宛の1通を引き抜くため
      if (generation !== this.#sdkSession.generation) return;
      const next = this.#sdkSession.dequeueInput();
      if (next !== undefined) {
        this.#turnTally.incrementInputsSinceResult();
        yield next;
        continue;
      }
      if (this.#sdkSession.stopped) return;
      // `#stopped` に相乗りしない: runner セッション全体の停止で、混ぜるとトークンを回したらマネージャーが止まるため
      // `#read` は `#endedInputForTokenRotation` だけを見る: 意図（`#recycleForToken`）と混ぜると、SDK 自身の閉じを畳み直しと誤認して嘘の `note` を出すため
      if (this.#sdkSession.wantsTokenRecycle && this.#atTokenRecycleBoundary()) {
        this.#sdkSession.consumeTokenRecycleAtBoundary();
        // 入力を閉じる前に読む: 閉じた後は CLI が終わり、SDK が resume の一時ディレクトリごと生ログを消すため
        this.#rotationSeed = await this.#readTranscriptInResumeConfigDir();
        return;
      }
      await this.#sdkSession.waitForInput();
    }
  }

  #atTokenRecycleBoundary(): boolean {
    return (
      this.#sdkSession.status !== 'running' &&
      this.#pending.length === 0 &&
      this.#sdkSession.liveBackgroundTasks.length === 0 &&
      this.#resumeState.sessionId !== undefined
    );
  }

  // `generation` で古い読み手を止める: 作り直しの後に、畳まれた古いストリームの `for await` が失敗でも完了でもないのに `#finish` するのを防ぐため
  async #read(session: AgentManagerSession, generation: number): Promise<void> {
    try {
      // 畳まれた世代の出来事を新しい世代へ通さない: 古い `result` の累積が新しい世代の累積の後ろに届くと、台帳で逆順になり過大に数えるため
      await session.readEvents((event) =>
        generation !== this.#sdkSession.generation ? Promise.resolve() : this.#apply(event),
      );
      if (this.#sdkSession.stopped || generation !== this.#sdkSession.generation) return;
      // `#recycleForToken` で判定しない: あれは意図でしかなく、SDK 自身の閉じを畳み直しと誤認して嘘の `note` を出し、答えていない確認を道連れに開き直すため
      // この分岐を `#finish('done', …)` より前に置く: 畳み直しの正常な閉じが `done` の報告に化けるため
      if (this.#sdkSession.takeEndedForTokenRotation()) {
        const sessionId = this.#resumeState.sessionId;
        if (sessionId === undefined) {
          // 放置しない: `#query` が死んだまま誰も開き直さないので、通常の「セッションが閉じた」経路へ委ねる
          await this.#finish('done', 'マネージャーのセッションが閉じた。');
          return;
        }
        this.#reopenForTokenRotation(sessionId);
        return;
      }
      const closed = 'セッションが開かないまま閉じた';
      switch (this.#recoverFromFailedResume(closed)) {
        case 'recovered':
          return;
        case 'unresumable':
          await this.#finish('lost', closed);
          return;
        default:
          await this.#finish('done', 'マネージャーのセッションが閉じた。');
          return;
      }
    } catch (error) {
      if (generation !== this.#sdkSession.generation) return;
      // `String(error)` の手前で分類を取る: 文字列になった後で解釈し始めると `reasonType` の doc が禁じる形になるため
      // `reasonOf` を使わず `String(error)` に伏せ字だけ通す: 構造化の欄を足すと `reason` の一文が変わるため。素のままだと値を運ぶ例外が日誌と受信箱へ出る
      const systemError = systemErrorFactsOf(error);
      const reason = redactErrorText(String(error), process.env, this.#vaultValues());
      // `#stopped` ならここから下は何もしない: `#finish('failed', …)` を呼ぶと `stop()` の畳みと二重に走り、人間が止めたセッションが `failed` として記録されるため
      if (!this.#sdkSession.stopped) {
        switch (this.#recoverFromFailedResume(reason)) {
          case 'recovered':
            return;
          // `failed` にしない: 話しかければ直るかもしれない失敗に見えるが、戻れなかったことは確定しているため
          case 'unresumable':
            // `lost` にも同じ分類を付ける: 片方にだけ付けると同じ例外が経路によって見えたり見えなかったりするため
            await this.#finish('lost', reason, { systemError });
            return;
          default:
            break;
        }
        await this.#finish('failed', `マネージャーのセッションが落ちた: ${reason}`, {
          systemError,
        });
      }
    }
  }

  // `#resumeAttempt` も立てる: 無いと、まだ一度も進んでいないセッションで開き直しの resume が効かなかったとき `done` に化けるため
  // 会話を切らない: 畳むのは SDK の子プロセスで、会話でも記憶でもないため
  // プロトコルへ新しい `type` を足さず `note` に載せる: 旧いデーモンも `note` は解釈できるため
  #reopenForTokenRotation(sessionId: string): void {
    const seed = this.#rotationSeed;
    this.#rotationSeed = undefined;
    this.#sdkSession.teardownForRecreate();
    this.#resumeState.beginRotationResume(sessionId, seed);
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        '鍵・環境変数（認証トークンを含む）が差し替わったので、ターンの境界でセッションを畳んで' +
        '開き直した（会話は resume で続く）。',
      // `text` の言い回しで判定させない: 構造化した旗でデーモンに伝える
      tokenRotation: true,
    });
    // `#open()` が印を下ろすので先に読む
    const nudge = this.#workerLimitOnPreRotationKey;
    this.#open(sessionId);
    // 回転前の鍵で作業者が落ちていたなら、続きを促す（#5046）。担当は知らせに従ってターンを終えて待っているので、入れないと止まったままになる
    if (nudge) this.push(WORKER_LIMIT_REOPENED_NUDGE);
  }

  #markProgressed(): void {
    this.#resumeState.markProgressed();
  }

  // `unresumable` を `not-a-resume-failure` と同じ戻り値にしない: 戻れなかった resume が `done` として残り、腐った session_id しか無いマネージャーが「まだ続けられるもの」に見え続けるため
  #recoverFromFailedResume(reason: string): ResumeRecoveryOutcome {
    return recoverFromFailedResume(this.#resumeRecoveryHost, reason);
  }

  // `class … implements` にしない: 手順の断片が `RunnerSession` の公開面に生え、順序を無視して呼べてしまうため
  readonly #resumeRecoveryHost: ResumeRecoveryHost = {
    takeResumeAttempt: () => this.#resumeState.takeAttempt(),
    hasProgressed: () => this.#resumeState.progressed,
    renderSeedRecord: () => renderSessionLog(this.#resumeState.seed),
    closeWorkerWaitWindow: () => this.#closeWorkerWaitWindow(),
    discardCarriedOverWork: () => {
      // 委譲の区間を持ち越さない: 二度と来ない `task_notification` を待ち続けて区間が永久に閉じないため（`closeWorkerWaitWindow` の後に呼ぶ）
      this.#workerWaitWindow.clear();
      this.#nonWorkerTaskIds.clear();
      // **このターンで開いた作業者の数も、同じ理由で持ち越さない。**
      // この経路は `turn_ended` を通らないので、捨てないと前のセッションの作業者が次のセッションの最初のターンの数に入る。
      this.#turnTally.discardOpenedWorkersAndRejections();
    },
    emitResumeFailed: (input) => {
      this.#emit({
        type: 'resume_failed',
        managerId: this.#id,
        sessionId: input.sessionId,
        reason: input.reason,
        recovered: input.recovered,
      });
    },
    teardownForRecreate: () => {
      // 世代を進めてから畳む: 進めないと死んだ `#inputStream` が引き継ぎの一言を横取りするため
      this.#sdkSession.teardownForRecreate();
      this.#resumeState.discardForRecreate();
      // 前の器へ向けた入力を捨てない: 人間やクローンがちょうど送った指示だけが消えるため
      return this.#sdkSession
        .drainInput()
        .map((message) => message.text)
        .filter((text) => text.length > 0);
    },
    pushHandoff: (input) => {
      this.push(handoffPrompt(input));
    },
    openSession: () => {
      this.#open();
    },
  };

  async #apply(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'session_started': {
        // `init` そのものをリセットの契機にしない: ターンの頭ごとに来るだけで、無条件にリセットすると在り高が0へ落ち、`awaitingBackground` が付かず報告が畳まれずクローンを起こすため
        // [sdk-verbatim SDKSystemMessage]
        // > Session metadata the CLI emits at the start of each turn, normally ahead of every other message of that turn: session_id, model, working directory, tools, MCP servers, slash commands, permission mode, and the capabilities list for feature detection.
        // [sdk-verbatim SDKBackgroundTasksChangedMessage]
        // > The level is per-process: nothing is emitted at startup, so consumers must reset to the empty set whenever the session's CLI process (re)starts and let the next membership change repopulate it.
        if (this.#resumeState.observeSessionStarted(event.sessionId)) {
          this.#sdkSession.resetLiveBackgroundTasks();
        }
        // `pluginLoad` が null（init に `plugins` が無い）なら欄ごと省く: 「読み込み結果を観測していない」を空の結果として運ばないため
        this.#emit({
          type: 'session',
          managerId: this.#id,
          sessionId: event.sessionId,
          ...(event.runtime.pluginLoad === null ? {} : { pluginLoad: event.runtime.pluginLoad }),
        });
        return;
      }

      case 'rate_limit': {
        this.#emit({ type: 'rate_limit', managerId: this.#id, facts: event.facts });
        return;
      }

      case 'permission_denied': {
        // 両方読む: `auto` ではこの合図が唯一の生の合図で、SDK 曰く best-effort のため authoritative な `result.permission_denials` と併読する
        this.#noteDenial(event.denial, 'live');
        return;
      }

      case 'delegation_started': {
        this.#onTaskStarted(event);
        return;
      }

      case 'delegation_notified': {
        this.#onTaskNotification(event);
        return;
      }

      case 'usage_notice': {
        // 上限の文言は API エラーとしては来ない: 通知・情報メッセージの本文を見ないと止まる一歩前を捉えられないため
        this.#emit({ type: 'usage_notice', managerId: this.#id, notice: event.notice });
        return;
      }

      case 'assistant_message': {
        // 作業者の本文を混ぜない: `parentToolUseId` が付いたものは Task の中の別の層の発言のため
        if (event.parentToolUseId === null) {
          const said = assistantText(event.blocks);
          // 「応答ではない」と印の付いたメッセージを報告に混ぜない: 上限の英語文言がそのまま「マネージャーの報告」として台帳・日誌・受信箱へ流れるため
          const rejected = assistantFailureOf(event.errorCode, said);
          if (rejected !== undefined) {
            this.#turnTally.setRejected(rejected);
            return;
          }
          if (said.length > 0) {
            this.#turnTally.recordSaid(said, event.id);
            this.#observeReportLanguage(said);
          }
        } else {
          // 作業者の発言に付いた拒否の印をターンの失敗にしない: 数えるだけ
          const workerText = assistantText(event.blocks);
          const rejected = assistantFailureOf(event.errorCode, '');
          if (rejected !== undefined) {
            this.#turnTally.pushWorkerRejection(rejected.code);
            // 構造化された印（errorCode）だけで判定し、本文の引用では立てない（#4903）
            if (turnFailureKindOf(assistantFailureOf(event.errorCode, workerText)) === 'quota') {
              this.#recordWorkerLimit(
                `tool_use:${event.parentToolUseId}`,
                workerLimitLabel(event.parentToolUseId, undefined),
                workerText.length > 0 ? workerText : rejected.code,
              );
            }
          }
        }
        return;
      }

      case 'background_tasks': {
        // 差分計算をしない（REPLACE 意味論）
        this.#sdkSession.replaceLiveBackgroundTasks(event.tasks);
        // 起こしを `'result'` の枝だけに任せない: 背景処理の完了は新しい入力を伴わない単独のイベントとしてターンの外で届きうるため
        //    [sdk-verbatim SDKBackgroundTasksChangedMessage]
        //    > emitted whenever membership changes (start, completion, kill, a foreground agent being backgrounded)
        if (this.#sdkSession.wantsTokenRecycle) this.#sdkSession.wakeInput();
        return;
      }

      case 'text_delta':
      case 'tool_result':
        return;

      case 'compaction':
        return;

      // 要約の始まり（#5086）はクローン層がターンの時間を測るためのもので、委譲層では見ない
      case 'compaction_started':
        return;

      // 拒否の合図は委譲層では見ない: 数えて開き直すのはクローン層の仕事で、作業者のセッションは使い捨てのため
      case 'refusal':
        return;

      case 'turn_ended': {
        // `clone.ts` の `#apply` の `case 'turn_ended'` と同じ位置（成否分岐より前）に置く——成否で絞ると、失敗したターン
        // の文脈占有が測れなくなる。
        const contextUsage = await this.#observeContextUsage();

        // 成否分岐の外で無条件に emit する: `usage` に相乗りさせるだけだと失敗したターンの文脈占有がどこにも残らないため
        if (contextUsage !== undefined) {
          this.#emit({
            type: 'context_usage',
            managerId: this.#id,
            sessionId: this.#resumeState.sessionId,
            turnSucceeded: event.succeeded,
            contextUsage,
          });
        }

        // ターンの区切りで必ず畳む: 持ち越すと前のターンの本文が次の報告に混ざり、言っていないことを言ったことになるため
        const {
          said,
          rejected,
          inputsThisTurn,
          notificationsThisTurn,
          toolsThisTurn,
          submitsThisTurn,
          sourcesThisTurn,
          openedWorkersThisTurn,
          workerRejectionsThisTurn,
          failedWorkerNotificationsThisTurn,
          failedWorkerNotificationsNamingLimitThisTurn,
        } = this.#turnTally.takeAtResult();

        const closedWindow = this.#workerWaitWindow.foldTurn({
          inputsThisTurn,
          notificationsThisTurn,
          toolsThisTurn,
          submitsThisTurn,
          sourcesThisTurn,
        });
        if (closedWindow !== null) {
          this.#emit({ type: 'worker_wait', managerId: this.#id, ...closedWindow });
        }

        // 成否で絞らない: 拒否は成功したターンにも失敗したターンにも載り、ゼロ埋めで害が出る値でもないため
        for (const denial of event.denials) this.#noteDenial(denial, 'result');

        // `succeeded` で兼ねない: あちらは台帳の問いで `subtype === 'success'` だけを見るので `is_error: true` の result を成功として通すため
        const failure = event.failure ?? rejected ?? undefined;

        // `init` を「戻れた」と見ない: 手が動く前の結果なし終了は、この resume が効かなかったということのため
        if (event.succeeded) {
          this.#markProgressed();
          // 成功した result だけを通す: SDK は
          // 「Crash/startup-error results may carry zeroed values」と言っている。 [sdk-verbatim SDKResultSuccess.total_cost_usd]
          // ゼロを通すと受け取った側の基準が下がり、次の本物の累積が丸ごと増分になって記録済みの分がもう一度積まれるため
          if (event.usage !== undefined) {
            this.#emit({
              type: 'usage',
              managerId: this.#id,
              sessionId: this.#resumeState.sessionId,
              models: event.usage.models,
              // 応答として返ったかを別の欄で運ぶ: `succeeded` は台帳の問いで、枠で落ちた `is_error: true` のターンもここへ来て、成功と読まれると回し手が `recovered` と枠を往復し続けるため
              answered: failure === undefined,
              ...(contextUsage === undefined ? {} : { contextUsage }),
            });
          }
        }

        // なぜ終わったのかを落とさない: 上限で止まったのか失敗したのかが区別できないと、待つ／人間に頼むと挑み直すで手が正反対になるため
        // 成否の分岐の外に出す: `assistant.error` で止まった回は `result` が成功で返ることがあるため
        // マネージャーの本文 `said` を分類に通さない: `classifyUsageNotice` は部分一致で、報告に「上限に当たった」と書いただけで誤判定するため
        // 鍵の器が無い器で `Not logged in` が来たときの案内。分類できなかった失敗の中でも、原因の見当が付く1つだけに足す
        let noCredentialDirHint = false;
        if (failure !== undefined) {
          let classified = false;
          // 応答の本文 `resultTextOf(event)` は候補に入れない（#4934）: 作業者の上限の原文（#4903 で道具の結果へ添える）を担当が引用して別の理由で失敗すると、自分の枠と取り違える。
          // 失った形は無い: 失敗した result では `failure.text` が `result` そのもの（`resultFailureOf`）で本文と同じ文字列、Codex は `errorLines` に同じ文言が入り、「結果なしで終了: …」は固定の包みで上限の文言を含まない。
          for (const candidate of [failure.text, ...event.errorLines]) {
            const notice = classifyUsageNotice(candidate);
            if (notice !== undefined) {
              this.#emit({ type: 'usage_notice', managerId: this.#id, notice });
              classified = true;
              break;
            }
          }
          // 1件も分類できなかった回に跡を残す: 黙って抜けると、回し手が原理的に聞けない失敗（資格が1つも無い器）が何回起きているかがどこにも残らないため
          if (!classified) {
            noCredentialDirHint =
              this.#credentials === undefined &&
              [failure.text, resultTextOf(event).text, ...event.errorLines].some((text) =>
                NOT_LOGGED_IN_PATTERN.test(text),
              );
            noteUnclassifiedFailure(
              this.#sdkSession.unclassifiedFailures,
              this.#id,
              failure.via,
              failure.code,
            );
          }
        }

        // 止めた後の失敗の結果は立て直さない（#5205。`#read` の他の2か所と揃える）: 畳み（stop）で終わったターンの失敗を「resume が戻れなかった」と読み、
        // 止めたはずのセッションの中に CLI を作り直していた。作り直した CLI は名簿から外れたまま古い世代で出来事を出し続け、stop も答えも届かない
        if (!event.succeeded && !this.#sdkSession.stopped) {
          const outcome = this.#recoverFromFailedResume(
            `結果なしで終了: ${resultTextOf(event).text}`,
          );
          if (outcome === 'recovered') return;
          // 戻れなかった resume を「1ターン終わった」として報告しない: `done` が書かれ、腐った session_id しか無いのにクローンが「まだ続けられるもの」を見せられ、話しかけるたびに失敗するため
          if (outcome === 'unresumable') {
            // `await` へ揃えない: 揃えると直列化点が増え、`stop()` との競合を含めて影響を測っていないため
            // `#stopped` ならここで `#finish` を呼ばない: `stop()` が `host.list()` から消した後に `closed(status=lost)` が遅れて出るため
            if (!this.#sdkSession.stopped) {
              void this.#finish('lost', `結果なしで終了: ${resultTextOf(event).text}`).catch(
                (error: unknown) => {
                  noteBackgroundFailure(
                    'セッションの片付け',
                    `managerId=${this.#id} outcome=lost`,
                    error,
                  );
                  throw error;
                },
              );
            }
            return;
          }
        }

        // 失敗した回の報告に失敗であることを載せる: 上限の英語文言が「マネージャーの報告」として流れ、「報告が来た」と「エラーで死んだ」が区別できなくなるため
        // 本文（`text`）の側でも包む: 構造化した `failure` を見ていない読み手にはエラー文が報告として見えるため
        // 失敗で終わった回は `contentless` に含めない: 上限に当たった事実をクローンが知る必要があるため
        const outcome =
          failure === undefined
            ? reportText(said, resultTextOf(event))
            : {
                text:
                  failedReportText(
                    said,
                    failure,
                    resultTextOf(event).text,
                    openedWorkersThisTurn,
                    workerRejectionsThisTurn,
                    failedWorkerNotificationsThisTurn,
                    failedWorkerNotificationsNamingLimitThisTurn,
                  ) + (noCredentialDirHint ? `\n\n${NO_CREDENTIAL_DIR_HINT}` : ''),
                contentless: false,
              };
        // 取り込みは `setStatus` より前に済ませる: 後ろへ置くと `await` が `report.status` / `awaitingBackground` の算出との間に挟まり、その間に変わった状態で嘘の報告になる
        // 背景処理の完了待ちで畳む報告でも取り込む: デーモンはファイルの付いた報告を背景待ちでも畳まずに配る。残すと、背景処理が絶えない担当では成果物が出し箱に置き去りになる
        // 取り込みの `await` より前に1回だけ読む: 背景の peer はこの間にも止まりうるので、取り込みの前後で別の一覧を見ないため
        const liveBackground = this.#liveBackgroundTasks();
        // 出し箱が空なら `await` を挟まない: 余計な yield が報告の出る順序（と、それを前提にした観測）を変えるため
        const outbox = this.#outboxHasEntries() ? await this.#collectOutbox() : {};
        this.#sdkSession.setStatus(this.#pending.length > 0 ? 'waiting_human' : 'done');
        if (this.#sdkSession.wantsTokenRecycle) this.#sdkSession.wakeInput();
        // 3条件（失敗でない・`done`・背景処理が在る）が揃うときだけ載せる、欠けたら配る側へ倒す: 上限・拒否や確認待ちを黙って畳むと人間の判断が止まるため
        const awaitingBackground =
          failure === undefined && this.#sdkSession.status === 'done' && liveBackground.length > 0
            ? {
                count: liveBackground.length,
                breakdown: summarizeBackgroundTasks(liveBackground),
              }
            : undefined;
        const outwardActions = this.#outwardActions.splice(0);
        this.#emit({
          type: 'report',
          managerId: this.#id,
          reportId: event.id,
          text: outcome.text,
          ...('fullText' in outcome && outcome.fullText !== undefined
            ? { fullText: outcome.fullText }
            : {}),
          status: this.#sdkSession.status,
          ...(failure === undefined
            ? {}
            : {
                failure: {
                  code: failure.code,
                  via: failure.via,
                  ...(failure.status === undefined ? {} : { status: failure.status }),
                },
              }),
          ...(outcome.contentless ? { contentless: true } : {}),
          ...(awaitingBackground === undefined ? {} : { awaitingBackground }),
          ...(outwardActions.length === 0 ? {} : { outwardActions }),
          ...(failure === undefined ? {} : { synthesized: 'turn_failed' }),
          ...outbox,
        });
        // `report` を出した後に呼ぶ: `push()` が状態を `running` へ戻すので、先に呼ぶと `report.status` / `awaitingBackground` が嘘になるため
        this.#wakeForFinishedBackgroundTaskOutputs();
        // 確認待ちの間に溜めた peer の知らせも、同じ理由でここで届ける
        this.#deliverPeerNotices();
        return;
      }

      // 既定で無視へ倒さない（枝が増えたら型で落とす）: provider が名乗り始めた事実が黙って網の外へ出るため
      default: {
        const unread: never = event;
        void unread;
        return;
      }
    }
  }

  // 作業者（`local_agent`）のタスクだけを数える: SDK は作業者以外のタスクでも `task_started` を出し、一律に数えると委譲していないターンでも `openedWorkers` が増え `worker_wait` の区間まで開くため
  #onTaskStarted(event: AgentDelegationStarted): void {
    // id を名乗らなければ偽の id で数える: 取りこぼすより多く数える方を選ぶため
    const taskId = event.taskId ?? randomUUID();
    if (event.taskId !== undefined && event.toolUseId !== undefined) {
      this.#toolUseIdByTaskId.delete(event.taskId);
      this.#toolUseIdByTaskId.set(event.taskId, event.toolUseId);
      if (this.#toolUseIdByTaskId.size > TASK_TOOL_USE_IDS_MAX) {
        const oldest = this.#toolUseIdByTaskId.keys().next();
        if (oldest.done !== true) this.#toolUseIdByTaskId.delete(oldest.value);
      }
    }
    if (!isWorkerTaskType(event.taskType)) {
      if (event.taskId !== undefined) this.#nonWorkerTaskIds.add(event.taskId);
      return;
    }
    this.#turnTally.addOpenedWorker(taskId);
    this.#workerWaitWindow.taskStarted(taskId);
  }

  // `status` を `=== 'failed'` の一致だけで見る: SDK が値を増やしても知らない値は「失敗ではない」側へ落ちるため。枠(429)は手書きの文言一致にせず `classifyUsageNotice` を通す
  // `output_file` が読めなければ `null` を渡す: 作り物のパスを主張しないため
  #onTaskNotification(event: AgentDelegationNotified): void {
    const taskId = event.taskId;
    this.#workerWaitWindow.notified(taskId);
    if (taskId !== undefined) {
      this.#sdkSession.backgroundWaiters.noteFinished(
        taskId,
        typeof event.outputFile === 'string' ? event.outputFile : null,
      );
    }
    // 作業者ではないタスクの通知を `notifications`・failed 通知に入れない: `task_started` 側だけを直すと Bash の失敗が「作業者の failed 通知」に積まれ、枠を名乗れば枠の件数まで立つため
    const nonWorker = taskId !== undefined && this.#nonWorkerTaskIds.delete(taskId);
    if (!nonWorker) this.#turnTally.incrementNotificationsSinceResult();

    if (!nonWorker && event.status === 'failed') {
      const limitNamed =
        event.summary !== undefined && classifyUsageNotice(event.summary) !== undefined;
      this.#turnTally.recordFailedWorkerNotification(taskId, limitNamed);
      // 失敗の通知で、文言が「上限に当たった」と読めるものに限る（`reached`）。completed の報告の引用では立てない（#4903）
      if (event.summary !== undefined && classifyUsageNotice(event.summary)?.kind === 'reached') {
        // 身元は作業者を呼んだ tool_use の id にそろえる: 作業者の発言の拒否の印と同じ作業者を、2回記録しないため（#4996）
        const toolUseId =
          event.toolUseId ??
          (taskId === undefined ? undefined : this.#toolUseIdByTaskId.get(taskId));
        this.#recordWorkerLimit(
          toolUseId !== undefined
            ? `tool_use:${toolUseId}`
            : taskId === undefined
              ? 'background-worker'
              : `task:${taskId}`,
          workerLimitLabel(toolUseId, taskId),
          event.summary,
        );
      }
    }

    if (taskId !== undefined && this.#cutOffWorkers.consumeCutOff(taskId)) {
      this.#cutOffWorkers.recordPendingNotification(taskId);
    }

    if (taskId !== undefined) {
      const owner = this.#stopState.backgroundTaskOwner(taskId);
      if (owner !== undefined && owner !== '' && this.#cutOffWorkers.isCutOff(owner)) {
        this.#cutOffWorkers.recordPendingBackgroundTaskOutput({
          agentId: owner,
          taskId,
          command: this.#stopState.backgroundTaskCommand(taskId),
          outputFile: typeof event.outputFile === 'string' ? event.outputFile : null,
        });
        this.#wakeForFinishedBackgroundTaskOutputs();
      }
    }
  }

  /** SDK の背景処理と、背景で流れている peer のターンを合わせた一覧（作業者の背景処理と同じ形）。 */
  #liveBackgroundTasks(): readonly { id: string; taskType: string }[] {
    const peers = this.#peerBroker?.backgroundTasks() ?? [];
    return peers.length === 0
      ? this.#sdkSession.liveBackgroundTasks
      : [...this.#sdkSession.liveBackgroundTasks, ...peers];
  }

  /** 背景の peer が止まりどころに来た。知らせを溜め、届けられるなら届ける。 */
  /** 鍵の付け替えで畳んだ前のセッションの peer を引き継ぐ（#4734）。`resume()` より前に呼ぶ: 組む道具（MCP）が新しい窓口を作らないため。 */
  adoptPeers(parked: ParkedPeers): void {
    this.#peerBroker = parked.broker;
    this.#peerBinding = parked.binding;
    parked.binding.session = this;
    // 新しいセッションが主の記録の鍵を知るまで、前のセッションの値で peer の記録を預け続ける（同じ担当の同じ会話の鍵）
    this.#mainLogKey ??= parked.binding.lastMainKey;
  }

  #setMainLogKey(key: { projectKey: string; sessionId: string }): void {
    const known = this.#mainLogKey;
    if (known?.projectKey === key.projectKey && known.sessionId === key.sessionId) return;
    this.#mainLogKey = key;
    const binding = this.#peerBinding;
    if (binding === undefined) return;
    binding.lastMainKey = key;
    // 鍵が分かる前に読んで溜めていた peer の記録を預ける
    binding.rollouts.flushBuffered();
  }

  /**
   * peer（Codex）の `CODEX_HOME`: peer の spawn と同じ値に揃える（`codex-manager-driver.ts` の `#produce`）。
   * API キーで走るなら ChatGPT ログインの置き場に触らず、子の `HOME/.codex`（env に `CODEX_HOME` があればそれ）。
   * そうでなければ ChatGPT ログインを書き出す `CODEX_HOME`（ログインが降りていないとき peer は閉じているので `undefined`）。
   */
  #peerCodexHome(): string | undefined {
    const env = this.#childEnv();
    const apiKey = env.CODEX_API_KEY?.trim();
    if (apiKey === undefined || apiKey === '') {
      const auth = this.#codexAuth;
      return auth?.codexHome !== undefined && auth.status?.().placed === true
        ? auth.codexHome
        : undefined;
    }
    if (env.CODEX_HOME !== undefined && env.CODEX_HOME !== '') return env.CODEX_HOME;
    return joinPath(this.#childUser?.home ?? env.HOME ?? homedir(), '.codex');
  }

  /** 戻された peer の記録を、Codex の `CODEX_HOME/sessions/` へ書き戻す（`thread/resume` が rollout を見つけられるように）。同じ peer は1回だけ。 */
  #placePeerRollout(peerId: string): Promise<void> {
    const earlier = this.#peerPlacements.get(peerId);
    if (earlier !== undefined) return earlier;
    const placing = (async (): Promise<void> => {
      const seed = this.#peerSeeds.get(peerId);
      if (seed === undefined) throw new Error('戻された記録が無い');
      const home = this.#peerCodexHome();
      if (home === undefined) throw new Error('Codex の CODEX_HOME が分からない');
      const result = await placePeersInCodexHome(home, [seed], this.#childFileWriter());
      if (result.rejected.length > 0) {
        throw new Error('rollout の置き場（relPath・ファイル名）が安全でないか、戻せる行が無い');
      }
      this.#peerSeeds.delete(peerId);
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `peer [${peerId}] の記録を ${home}/sessions へ${result.placed.length > 0 ? '置いた' : '置かなかった（既に在る）'}` +
          (result.droppedLines > 0
            ? `（ordinal の無い行 ${String(result.droppedLines)} 行は捨てた）`
            : ''),
      });
    })();
    this.#peerPlacements.set(peerId, placing);
    // 失敗した約束は残さない（broker 側は失敗した id を起こせる一覧から外す）
    placing.catch(() => this.#peerPlacements.delete(peerId));
    return placing;
  }

  /** 預けている間に届いた確認と背景の止まりどころを、このセッションへ回す（#4734）。`resume()` の後に呼ぶ: 先に入れると、resume の一言より前に知らせが入るため。 */
  releaseAdoptedPeers(): void {
    const binding = this.#peerBinding;
    if (binding === undefined || !binding.parked) return;
    binding.parked = false;
    for (const ask of binding.heldAsks.splice(0)) ask.run();
    for (const result of binding.heldStops.splice(0)) this.#onPeerBackgroundStop(result);
  }

  #onPeerBackgroundStop(result: PeerTurnResult): void {
    if (this.#sdkSession.stopped) return;
    const where =
      result.pendingApproval !== undefined
        ? '確認待ちで止まった'
        : result.ok
          ? 'ターンが終わった'
          : 'ターンが失敗した・セッションが終わった';
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: `背景の peer（${result.provider}）[${result.sessionId}] が${where}。マネージャーへ知らせる（#4123）`,
    });
    this.#peerNotices.push(describePeerTurnResult(result));
    this.#deliverPeerNotices();
  }

  // `waiting_human` では届けない（`#wakeForFinishedBackgroundTaskOutputs` と同じ理由）。溜めて、報告の区切りで届ける
  #deliverPeerNotices(): void {
    if (this.#sdkSession.stopped) {
      this.#peerNotices.length = 0;
      return;
    }
    if (this.#peerNotices.length === 0 || this.#sdkSession.status === 'waiting_human') return;
    const bodies = this.#peerNotices.splice(0);
    this.push(
      'alteroid が自動で送った知らせである（#4123）。背景へ回した peer（Codex）が止まりどころに来た。' +
        '続けるなら peer_reply、確認待ちなら peer_approve で答えること。\n\n' +
        bodies.join('\n\n---\n\n'),
    );
  }

  // `waiting_human` では起こさない（`done` のときだけ）: `push()` が状態を `running` へ戻し、確認待ちが残ったまま「確認待ちではない」と名乗って `answer()` の宛先との対応が崩れるため
  #wakeForFinishedBackgroundTaskOutputs(): void {
    if (this.#sdkSession.stopped || this.#sdkSession.status !== 'done') return;
    const body = this.#drainFinishedBackgroundTaskOutputs();
    if (body === null) return;
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: '打ち切った作業者の背景処理の完了で、止まっていたマネージャーを起こした（#1554）',
    });
    this.push(
      'alteroid が自動で送った知らせである（#1554）。作業者は打ち切られていて、' +
        `自分では再開しない。\n\n${body}`,
    );
  }

  // `settled` を引数で受けない: 呼び出し側に持たせると3経路が固定で `false` を渡し、受け切った直後に畳まれた場合まで偽の印が付くため
  #closeWorkerWaitWindow(): void {
    const closedWindow = this.#workerWaitWindow.close();
    if (closedWindow === null) return;
    this.#emit({ type: 'worker_wait', managerId: this.#id, ...closedWindow });
  }

  // `#progressed` を立てない: 拒否は手が動いた印ではなく、立てると resume が効かず終わった回を「もう作業した」と誤認して生ログからの作り直しを止めるため
  #noteDenial(denial: AgentPermissionDenial, via: 'live' | 'result'): void {
    const tool = denial.tool ?? '(不明な道具)';
    const input = denial.input;
    if (typeof denial.toolUseId === 'string') this.#settleWorkerTool(denial.toolUseId);
    // フックと拒否の知らせのどちらが先に届いても決着させる（先に届いた方だけが note を出す。#4905）
    this.#settleSessionAllowRuleUse(denial.toolUseId, { kind: 'denied', via });

    // SDK が付けてきた `denial.toolUseId` で引く: 下で組む代用の `toolUseId` は実在の id ではなく、無関係な一致が起きうるため
    if (typeof denial.toolUseId === 'string') {
      const funneled = this.#oneShotAllowedToolUses.get(denial.toolUseId);
      if (funneled !== undefined) {
        this.#oneShotAllowedToolUses.delete(denial.toolUseId);
        // 同じ呼び出しの次の拒否では確認を上げない（#4904）。期限は許可と同じ: 過ぎれば別の機会として扱うため
        this.#allowedButDenied.set(funneled.key, {
          expiresAt: funneled.at + ONE_SHOT_ALLOW_TTL_MS,
        });
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text:
            `1回だけの許可（issue #1105 P1、${funneled.actor}・${funneled.tool}）で allow を` +
            `返した呼び出しが、それでも拒否された（合図の出所: ${via}）。分類器がこの allow を` +
            `分類器へ回した（リモートの機能フラグ）か、deny 規則が上書きしたかのどちらか` +
            `（あるいは両方）で、alteroid 側からは切り分けられない。この許可はいまは効いて` +
            `いない可能性がある。分類器が迂回・敵対の型で止めた呼び出しは、クローンの allow や` +
            `担当の伝言を人間の確認と見なさないため、同じ入力の撃ち直しは通らないことがある。` +
            `同じ呼び出しへの確認は重ねて上げない（#4904）。`,
        });
      }
    }

    // 道具名だけで束ねない: 「同じ拒否の2度目」と「live を見逃した初出」が潰れるため（`tool_use_id` は SDK の型で必須なのでこの経路はいま踏まれない）
    // 入力そのものを鍵に混ぜない: 鍵は `onForget` が日誌へそのまま並べ、道具の入力にはトークンが入りうるため
    const toolUseId = denial.toolUseId ?? `${tool}:${digestOf(brief(input, 120))}`;
    // 引いたら消す: 生の入力を持ち回っていないので、同じ tool_use_id の拒否がもう一度来ても作り直せないため
    const inputHead = this.#preToolInputHeads.get(toolUseId);
    if (inputHead !== undefined) this.#preToolInputHeads.delete(toolUseId);
    // `has` だけで弾かない: 入力を持つのは `via: 'result'` だけで、弾くと入力を持つ authoritative な記録が捨てられ日誌に「何を実行しようとしたか」が残らないため
    // `permission_denied` をもう一度降ろさず既存の `note` で足す: デーモンは拒否を1件ずつ数えており二重計上で escalation が段を跨いで飛ぶため。新しい種別を足すとまだ知らないデーモンの `safeParse` が落ちる
    const seen = this.#denied.get(toolUseId);
    if (seen !== undefined) {
      if (seen.input || input === undefined) return;
      this.#denied.set(toolUseId, { input: true });
      const shape = denialInputShape(input);
      if (shape !== undefined) {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text:
            `先に降ろした ${tool} の拒否について、ターン終わりの記録（via: result）に` +
            `入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: ${shape}`,
        });
      }
      return;
    }
    this.#denied.set(toolUseId, { input: input !== undefined });
    // 文字列であることを確かめてからしか載せない: 型を保証しないまま `z.string().optional()` へ渡すと、SDK の型変化で数値や null が黙って通るため。無いものは作り物を出さずキーごと省く
    // `actor` は `via: 'live'` のときだけ載せる: `result` 側の SDK 型には `agent_id` が無く、「マネージャーだった」と決めつけないため
    // `agent_type` を作り物で埋めない: SDK の型に無い情報のため
    const agentId = denial.agentId;
    const agentType = denial.agentType;
    const actor =
      via === 'live'
        ? agentId === undefined
          ? `manager:${this.#id}`
          : `worker:${this.#id}:${agentType ?? WORKER_AGENT_NAME}`
        : undefined;
    this.#emit({
      type: 'permission_denied',
      managerId: this.#id,
      toolUseId,
      tool,
      input,
      via,
      ...(actor === undefined ? {} : { actor }),
      ...(denial.reason === undefined ? {} : { reason: denial.reason }),
      ...(denial.reasonType === undefined ? {} : { reasonType: denial.reasonType }),
      ...(denial.message === undefined ? {} : { message: denial.message }),
      // `input` の欄には詰めない: `runner-protocol.ts` の `input` の doc が禁じているため（別の任意欄に載せる）
      ...(inputHead === undefined ? {} : { inputHead }),
    });
  }

  // 分類ロジックを複製しない: SDK の値をそのまま写し、集計は読む側（`context-usage.ts`）が1箇所で持つため
  // `this.#query` が無ければ聞かない: セッションが終わる窓で `getContextUsage` を持たない値を呼ぶことになるため（「まだ観測していない」側）
  // 例外の理由は `describeProbeError` でしか運ばない: 秘密を漏らさないため
  async #observeContextUsage(): Promise<ContextUsageObservation | undefined> {
    const session = this.#sdkSession.query;
    if (session === null) return undefined;
    const startedAt = Date.now();
    try {
      const usage = await contextUsageWithin(session.contextUsage(), this.#contextUsageTimeoutMs);
      const categories = (usage.categories ?? []).map((category) => ({
        name: category.name,
        tokens: category.tokens,
        kind: category.kind,
      }));
      const shownCategories = categories.slice(0, CONTEXT_USAGE_CATEGORY_LIMIT);
      const omittedCategories = categories.length - shownCategories.length;
      const sumTokens = (items: readonly { tokens: number }[]): number =>
        items.reduce((total, item) => total + item.tokens, 0);
      const mcpTools = usage.mcpTools ?? [];
      const memoryFiles = usage.memoryFiles ?? [];
      const systemPromptSections = usage.systemPromptSections ?? [];
      const messageBreakdown = foldMessageBreakdown(usage.messageBreakdown);
      return {
        durationMs: Date.now() - startedAt,
        totalTokens: usage.totalTokens,
        rawMaxTokens: usage.rawMaxTokens,
        percentage: usage.percentage,
        ...(usage.autoCompactThreshold === undefined
          ? {}
          : { autoCompactThreshold: usage.autoCompactThreshold }),
        isAutoCompactEnabled: usage.isAutoCompactEnabled,
        // 空の配列のときは欄そのものを作らない: 取れない軸に 0 の行を作らないため（AGENTS.md の地雷）
        ...(shownCategories.length === 0 ? {} : { categories: shownCategories }),
        ...(omittedCategories > 0 ? { categoriesOmitted: omittedCategories } : {}),
        ...(mcpTools.length === 0
          ? {}
          : {
              mcpToolTokens: sumTokens(mcpTools),
              mcpToolCount: mcpTools.length,
              mcpToolsByServer: foldMcpToolsByServer(mcpTools),
            }),
        ...(memoryFiles.length === 0
          ? {}
          : { memoryFileTokens: sumTokens(memoryFiles), memoryFileCount: memoryFiles.length }),
        ...(systemPromptSections.length === 0
          ? {}
          : {
              systemPromptTokens: sumTokens(systemPromptSections),
              systemPromptSectionCount: systemPromptSections.length,
            }),
        // SDK が返さなかった回は欄を作らない（0 を置くと「測ったが 0」と読める）。
        ...(messageBreakdown === undefined ? {} : { messageBreakdown }),
      };
    } catch (error) {
      return {
        durationMs: Date.now() - startedAt,
        error: describeProbeError(error, process.env),
      };
    }
  }

  // 畳む経路をこれに縛らない（投げない）: ターン中の control 要求は失敗が通常の枝のため
  // 全部ゼロなら降ろさない: ゼロは「読めなかった」で、降ろすと台帳に基準ができて「記録が無い」が「$0.00 使った」に化けるため
  // 層ごとに書き分けない: 片方だけ直っていると、直っていない側の欠落を「使っていない」と読ませるため
  async #flushUsage(): Promise<void> {
    const models = await this.#sdkSession.query?.sessionModelUsage();
    if (models === undefined) return;
    this.#emit({
      type: 'usage',
      managerId: this.#id,
      sessionId: this.#resumeState.sessionId,
      models,
    });
  }

  // 空なら1件も出さない: 中身の無い報告はクローンのターンを1本焼くため
  // 畳んでから出す: `stop()` の後に `#read` の catch から `#finish` が来る経路があり、二度は出さないため
  // `#rejected` を読まない: `result` が来ていないこの経路では「失敗として終わった」と名乗れないため
  // 出し箱に残っている成果物もここで取り込んで添える（#4675）: 取り込みは `result` の報告の直前にしか無く、畳まれた担当の出し箱は `#onClosed` が消すため。
  // 取り込んだファイルは退避先へ移るので、`#onClosed` の後もデーモンが取りに来られる。本文が無くても、ファイルがあれば報告を出す
  async #flushUnreported(reason: string, status: JobStatus): Promise<void> {
    const outbox = this.#outboxHasEntries() ? await this.#collectOutbox() : {};
    const carriesFiles = (outbox.files?.length ?? 0) > 0 || (outbox.rejectedFiles?.length ?? 0) > 0;
    if (!this.#turnTally.hasSaid && !carriesFiles) return;
    const { said, reportId } = this.#turnTally.hasSaid
      ? this.#turnTally.takeSaid()
      : { said: [], reportId: undefined };
    this.#emit({
      type: 'report',
      managerId: this.#id,
      ...(reportId === undefined ? {} : { reportId }),
      text: said.length > 0 ? unreportedText(said, reason) : outboxOnlyUnreportedText(reason),
      status,
      unreported: { reason },
      ...outbox,
    });
  }

  // `selfFenced` を他の呼び出し元（resume 不能・クラッシュ）から渡さない: 自己失効以外にもデーモン側の判定（lease だけ返す）が効いてしまうため
  // ここで例外を握り潰さない: 呼び出し元は元から例外の伝播を前提にしており、新しく飲み込むと片方の前提を壊すため
  async #finish(
    status: JobStatus,
    reason: string,
    options: { selfFenced?: true; systemError?: SystemErrorFacts } = {},
  ): Promise<void> {
    await this.#sdkSession.trackClosing(() => this.#finishBody(status, reason, options));
  }

  async #finishBody(
    status: JobStatus,
    reason: string,
    options: { selfFenced?: true; systemError?: SystemErrorFacts } = {},
  ): Promise<void> {
    this.#sdkSession.markStopped();
    // 量をここでも1行にまとめる: `stop()` は `#finish` を通らず、片方だけにすると存在は残るが量だけが失われ、落ちていることに気づく手がかりが出力に無いため
    noteUnclassifiedFailuresSummary(this.#sdkSession.unclassifiedFailures, this.#id);
    // `close()` より先に読む: 閉じた後の control channel からは何も取れないため
    await this.#flushUsage();
    this.#closeWorkerWaitWindow();
    this.#settleAll(reason);
    this.#workerTools.settleAll();
    this.#dropSessionAllowRulesOnClose();
    // 読み取りが終わっても入力側を起こして本体を閉じる。怠ると閉じられない
    // Query と起きない `#inputStream` が残る。
    this.#sdkSession.wakeInput();
    await this.#peerBinding?.rollouts.closeAfterCollecting();
    this.#peerBroker?.closeAll();
    this.#sdkSession.closeQuery();
    this.#sdkSession.setStatus(status);
    await this.#shipArchive();
    // `#shipArchive()` の後に置く: この報告を読んだクローンがすぐ `manager_transcript` で裏を取れるようにするため
    await this.#flushUnreported(reason, status);
    // `closed` を emit する前に runner が自分で取って運ぶ: デーモンが `closed` を受けてから問い合わせると `#onClosed()` でセッションが消えていて空振りするため
    // `.catch()` を添える: 設計が将来守られなくなっても、この1回の観測の失敗が `#finish()` を巻き添えにしないため。取れなかったときは `kind: 'unavailable'` と理由を載せ、欄を省く（古い runner）のと混ぜない
    const unpushedWork = await this.#finishUnpushedWorkFn({
      signal: AbortSignal.timeout(FINISH_UNPUSHED_WORK_TIMEOUT_MS),
    })
      .then((result): FinishUnpushedWorkOutcome => ({ kind: 'ok', result }))
      .catch((error: unknown): FinishUnpushedWorkOutcome => ({
        kind: 'unavailable',
        reason: `確かめようとして例外が飛んだ: ${reasonOf(error)}`,
      }));
    const cgroupEvents = cgroupEventsDeltaOf(
      await this.#openedCgroupEvents,
      await this.#readCgroupEventCountersFn(),
    );
    await this.#noteWorktreesOutsideScratchConvention();
    this.#rescueOnClose();
    this.#emit({
      type: 'closed',
      managerId: this.#id,
      status,
      reason,
      ...(options.selfFenced === undefined ? {} : { selfFenced: options.selfFenced }),
      ...(options.systemError === undefined ? {} : { systemError: options.systemError }),
      ...(cgroupEvents === undefined ? {} : { cgroupEvents }),
      unpushedWork,
    });
    this.#onClosed({ status });
  }

  // 待ち時間に上限を置かない: 止まるのはこの1件だけで他は走り続けるため
  // `permissionMode` が `auto` でもこの配線を外さない: SDK が確認を降ろしてきたときの行き先はここ1本のため
  async #onPermission(
    permission: AgentPermissionRequest,
    source?: PeerApprovalSource,
  ): Promise<AgentPermissionDecision> {
    const { toolName, input, kind, signal, reason } = permission;
    this.#markProgressed();
    // 再送では新しい待ちを積まず同じ結果を返す: 二重に消費されると片方が永久に返らないため
    // peer の確認は id に出所を前置する: マネージャー自身の確認の id と混ざらないため
    const rawId = permission.requestId ?? randomUUID();
    const id =
      source === undefined ? rawId : `peer:${source.provider}:${source.sessionId}:${rawId}`;
    const already = this.#pending.find((request) => request.id === id);
    if (already) return already.result;
    // 解けた後の再送も同じ扱いにする: `#pending` だけで見ると「答えたのに待っていないと言われる」ため
    const resolved = this.#resolved.get(id);
    if (resolved !== undefined) return resolved;

    // `kind` の判定のコピーを作らない: `classifyManagerActivity` も同じ分け方を使うため
    const permissionSummary = `${toolName} の実行許可: ${brief(input)}${reason === undefined ? '' : `\n理由: ${reason}`}`;
    // 分類器の拒否が続いた担当の確認には事情を添える: CLI が分類器の拒否を確認へ倒した後は、ふだん通る操作の確認も混ざるため（peer の確認は別の数えなので添えない）
    const streakNote =
      kind === 'permission' && source === undefined
        ? describeDenialStreakForClone(
            permission.agentId ?? 'manager',
            this.#denialStreaks.view(permission.agentId ?? 'manager'),
          )
        : null;
    const baseSummary =
      kind === 'question'
        ? describeQuestions(input)
        : streakNote === null
          ? permissionSummary
          : `${streakNote}\n${permissionSummary}`;
    // 出所の印を要約の先頭に必ず付ける: 旧いデーモンが `source` 欄を落としても印が本文に残るため
    const summary =
      source === undefined ? baseSummary : `${peerApprovalMark(source.provider)}${baseSummary}`;
    // ここで1度だけ取る: 経路ごとに取り直すと、同じ確認が経路によって違う「待ち始めた時刻」を名乗るため
    const askedAt = new Date().toISOString();

    let settle!: PendingRequest['settle'];
    const answered = new Promise<{
      message: string;
      decision?: 'allow' | 'deny';
      withdrawn?: true;
      aborted?: true;
    }>((resolve) => {
      settle = resolve;
    });

    const result = answered.then((answer) => {
      // `decideAnswer` の呼び出しを変えない: `Session#answer()` が同じ関数を呼んでおり、クローンへ返す値と SDK へ返る `behavior` の一致が壊れるため
      const { decision, unreadable } = decideAnswer(kind, answer.decision, answer.message);
      // 畳む・中断の経路では `question` も deny で返す: `decideAnswer` は `question` なら常に allow を返すので、`decision` だけで判定すると人間が答えていない問いに畳む・中断の理由の文言が「答え」として乗るため（`message` の文字列は嗅がない）
      const teardown = answer.withdrawn === true || answer.aborted === true;
      // teardown 側を `unreadable` の対象外にする: クローンの回答そのものではないため
      const denyMessage =
        !teardown && unreadable ? unreadableDenyMessage(answer.message) : answer.message;
      const outcome: AgentPermissionDecision =
        teardown || decision === 'deny'
          ? { behavior: 'deny', message: denyMessage }
          : kind === 'question'
            ? { behavior: 'allow', updatedInput: withAnswers(input, answer.message) }
            : { behavior: 'allow' };
      // 解けたことを覚えるのはここ1箇所: 経路ごとに覚え忘れる隙を作らないため
      this.#resolved.set(id, outcome);
      return outcome;
    });

    let done = false;
    let unlisten = () => undefined as void;

    const request: PendingRequest = {
      id,
      kind,
      summary,
      askedAt,
      result,
      // 待ち行列から自分を外すのは settle の責任: 呼び出し側任せにすると中断で解けた1件が行列に残り、次に届いた言葉を食い潰すため
      settle: (value) => {
        if (done) return;
        done = true;
        unlisten();
        const at = this.#pending.indexOf(request);
        if (at !== -1) this.#pending.splice(at, 1);
        if (this.#sdkSession.status === 'waiting_human' && this.#pending.length === 0) {
          this.#sdkSession.setStatus('running');
        }
        this.#emit({
          type: 'settled',
          managerId: this.#id,
          requestId: id,
          ...(value.withdrawn === true ? { withdrawn: { reason: value.message } } : {}),
        });
        settle(value);
        // 確認待ちの間に溜めた peer の知らせを届ける: 手すきのマネージャーへ背景の peer が上げた確認だと、
        // この後に報告の区切りが来ず、溜めたまま残るため
        this.#deliverPeerNotices();
      },
    };

    this.#pending.push(request);
    this.#sdkSession.setStatus('waiting_human');

    // `ask` を中断の確かめより先に出す（#4772）: 受けた時点で中断済みだと `settled` が先に出て、デーモンが後から届いた `ask` を答えようの無い確認として積むため
    this.#emit({
      type: 'ask',
      managerId: this.#id,
      requestId: id,
      kind,
      summary,
      askedAt,
      ...(source === undefined ? {} : { source: { type: 'peer', provider: source.provider } }),
    });

    const onAbort = () =>
      request.settle({
        message: 'マネージャー側で中断された。',
        decision: 'deny',
        aborted: true,
      });
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
      unlisten = () => signal.removeEventListener('abort', onAbort);
    }

    return result;
  }

  // `#onPermission` の実装を直接再利用しない: あちらは `PermissionResult` を組み立てる関数で、両方に手を入れると再送や `withdrawn`/`aborted` の挙動を壊しかねないため
  // 鍵が作れない入力はクローンへ確認を上げず `no-retry` で終える: 一致させる鍵が無いと撃ち直しを安全に特定できないため
  // 鍵は入力全体（`matchInputOf`）で作る: `command` だけだと `run_in_background` 等だけが違う撃ち直しにまで許可が及ぶため
  // フックの持ち時間切れは安全側（`no-retry`）で確定し `#pending` から外す: 遅れて届いた `allow` を構造的に捨てるため。`settled.withdrawn` を使い回さない: 「CLI に一度も届かなかった」と区別できなくなるため
  async #onPermissionDenied(
    record: AgentPermissionDeniedRecord,
  ): Promise<AgentPermissionDeniedDecision> {
    const actor =
      record.agentId === undefined
        ? `manager:${this.#id}`
        : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;
    const toolName = record.toolName;

    // 道具名や入力の鍵が取れない回より前に置く: 一時規則に当たった呼び出しの拒否は、この先で早く返る回でも決着させるため（#4905）
    this.#settleSessionAllowRuleUse(record.toolUseId, { kind: 'denied', via: 'PermissionDenied' });
    this.#sweepExpiredSessionAllowRules();

    // 道具名や入力の鍵が取れない回も数える: 分類器が止めた事実は変わらず、CLI の数えも進むため
    const streakActor = record.agentId ?? 'manager';
    if (this.#denialStreaks.noteDenial(streakActor, record.reason)) {
      const view = this.#denialStreaks.view(streakActor);
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `分類器の拒否が ${actor} で続けて ${String(view?.consecutive ?? 0)} 回になった（累計 ${String(view?.total ?? 0)} 回。runner の数え）。` +
          'CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。' +
          `${streakActor === 'manager' ? '担当' : 'この作業者'}には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。` +
          `最初に引っかかった理由: ${view?.firstReason ?? '(取れなかった)'}`,
      });
    }

    // `tool_input` を載せない（理由は先頭だけ）
    const reasonHead = Array.from((record.reason ?? '').replace(/\s+/g, ' ').trim());
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        `分類器の拒否のフックが届いた（${actor}・${toolName ?? '道具名なし'}・` +
        `tool_use_id=${record.toolUseId ?? '無し'}）。理由の先頭: ` +
        `${reasonHead.length === 0 ? '(無し)' : reasonHead.slice(0, 80).join('')}` +
        `${reasonHead.length > 80 ? '…' : ''}（issue #1766）`,
    });

    if (toolName === undefined) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `分類器の拒否（${actor}）が道具名を持たない合図で届いたので、クローンへは確認を上げず、` +
          `1回だけの許可も出さない（issue #1105 P1）。`,
      });
      return { kind: 'no-retry' };
    }

    const matchInput = matchInputOf(record.toolInput);
    if (matchInput === undefined) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `分類器が ${actor} の ${toolName} 呼び出しを拒否したが、入力を1回だけの許可の鍵へ畳め` +
          `なかったため、クローンへは確認を上げず1回だけの許可も出さない（issue #1105 P1）。`,
      });
      return { kind: 'no-retry' };
    }

    const inputHead = buildDenialInputHead(record.toolInput, this.#env, this.#vaultValues());
    const permitKey = oneShotAllowKey(
      oneShotActorOf(this.#id, record),
      toolName,
      digestOf(matchInput),
    );
    const id = record.toolUseId ?? randomUUID();

    // allow を返した撃ち直しがそれでも拒否された呼び出しは、確認を重ねて上げずに止める: 上げても同じ入力は通らないことがあり、確認が1件ずつ積み上がるため（#4904）
    // 拒否の合図と `#noteDenial` のどちらが先に届いても拾えるよう、控え済みの鍵と、まだ決着していない allow の撃ち直しの両方を見る
    const nowMs = Date.now();
    const pendingRetry = this.#oneShotAllowedToolUses
      .entries()
      .some(([, use]) => use.key === permitKey && use.at + ONE_SHOT_ALLOW_TTL_MS > nowMs);
    const deniedAgain = this.#allowedButDenied.get(permitKey);
    if (pendingRetry || (deniedAgain !== undefined && deniedAgain.expiresAt > nowMs)) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `分類器が ${actor} の ${toolName} 呼び出しを、allow を返した撃ち直しのあとでも再び止めた。` +
          `同じ呼び出しの確認は重ねて上げない（allow しても通らなかった。人間が止められた中身を見て` +
          `誤検知だと確かめるまで、同じ入力は通らないことがある。#4904）。`,
      });
      return { kind: 'no-retry' };
    }

    const already = this.#pending.find((request) => request.id === id);
    if (already) {
      const outcome = await already.result;
      return outcome.behavior === 'allow' ? { kind: 'retry' } : { kind: 'no-retry' };
    }
    const resolved = this.#resolved.get(id);
    if (resolved !== undefined) {
      return resolved.behavior === 'allow' ? { kind: 'retry' } : { kind: 'no-retry' };
    }

    const kind = 'permission';
    const streakNote = describeDenialStreakForClone(
      streakActor,
      this.#denialStreaks.view(streakActor),
    );
    const ruleShape = sessionAllowRuleShapeOf(toolName, record.toolInput);
    // 口を持たないセッションでは Bash でも従来の段落にする: 一時規則は足されないので、足されると告げると嘘になるため
    const ruleable =
      ruleShape.kind === 'rule' && this.#sdkSession.query?.setSessionAllowRules !== undefined;
    const summary =
      (streakNote === null ? '' : `${streakNote}\n\n`) +
      // 段落を空行で分ける（#4943）: 変わる値の行・固定の長い段落・変わる値（理由・入力の先頭）の行を別の段落にし、クローンの入力で固定の段落だけを同じ会話の2回目から参照にできるようにする
      `分類器が ${actor} の ${toolName} 呼び出しを拒否した。この1回だけ許可しますか。\n\n` +
      `${ruleable ? DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE : DENIAL_ASK_AFTER_ANSWER_PARAGRAPH}\n\n` +
      `理由: ${record.reason ?? '(無し)'}\n` +
      `入力の先頭（伏せ字・最大160字。issue #1105 P0）: ${inputHead ?? '(取れなかった)'}`;
    const askedAt = new Date().toISOString();

    // `withdrawn` を型から落とさない: 落とすと畳みで解けた確認が取り下げとして日誌に残らず、下の deny の note がクローンの判断として書かれるため
    let settle!: PendingRequest['settle'];
    const answered = new Promise<{
      message: string;
      decision?: 'allow' | 'deny';
      withdrawn?: true;
      aborted?: true;
    }>((resolve) => {
      settle = resolve;
    });

    const result = answered.then((answer) => {
      // `decideAnswer` を `#onPermission` と共有する: 別々に判定を書くと黙ってずれるため
      const { decision, unreadable } = decideAnswer(kind, answer.decision, answer.message);
      const teardown = answer.aborted === true || answer.withdrawn === true;
      const denyMessage =
        !teardown && unreadable ? unreadableDenyMessage(answer.message) : answer.message;
      const outcome: AgentPermissionDecision =
        teardown || decision === 'deny'
          ? { behavior: 'deny', message: denyMessage }
          : { behavior: 'allow' };
      this.#resolved.set(id, outcome);
      return outcome;
    });

    let done = false;
    let unlisten = () => undefined as void;

    const request: PendingRequest = {
      id,
      kind,
      summary,
      askedAt,
      result,
      settle: (value) => {
        if (done) return;
        done = true;
        unlisten();
        const at = this.#pending.indexOf(request);
        if (at !== -1) this.#pending.splice(at, 1);
        if (this.#sdkSession.status === 'waiting_human' && this.#pending.length === 0) {
          this.#sdkSession.setStatus('running');
        }
        this.#emit({
          type: 'settled',
          managerId: this.#id,
          requestId: id,
          ...(value.withdrawn === true ? { withdrawn: { reason: value.message } } : {}),
        });
        settle(value);
        // 確認待ちの間に溜めた peer の知らせを届ける: 手すきのマネージャーへ背景の peer が上げた確認だと、
        // この後に報告の区切りが来ず、溜めたまま残るため
        this.#deliverPeerNotices();
      },
    };

    this.#pending.push(request);
    this.#sdkSession.setStatus('waiting_human');

    let timedOut = false;
    const onTimeout = () => {
      timedOut = true;
      request.settle({
        message: 'フックの持ち時間が尽きたので、安全側でこの1回だけの許可は出さない。',
        decision: 'deny',
        aborted: true,
      });
    };
    // `ask` を持ち時間の確かめより先に出す（#4772。理由は `#onPermission` と同じ）
    this.#emit({ type: 'ask', managerId: this.#id, requestId: id, kind, summary, askedAt });

    const signal = record.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        onTimeout();
      } else {
        signal.addEventListener('abort', onTimeout, { once: true });
        unlisten = () => signal.removeEventListener('abort', onTimeout);
      }
    }

    const answer = await answered;
    const outcome = await result;

    if (timedOut) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `分類器の拒否（${actor}・${toolName}）への1回だけの許可の確認が、フックの持ち時間切れで` +
          `終わった。安全側で retry は返さない。答えが遅れて届いても、この確認は既に解決済みなので` +
          `反映しない（issue #1105 P1）。`,
      });
      return { kind: 'no-retry' };
    }

    // 畳みで解けた確認をクローンの判断として書かない（deny の分岐より前に置く）: クローンは答えておらず、取り下げの事実は `settled.withdrawn` が運ぶため
    if (answer.withdrawn === true) {
      return { kind: 'no-retry' };
    }

    if (outcome.behavior === 'deny') {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `クローンが分類器の拒否（${actor}・${toolName}）への1回だけの許可を出さなかった: ${outcome.message}`,
      });
      return { kind: 'no-retry' };
    }

    this.#noteUnusedExpiredOneShotAllows(undefined);
    this.#oneShotAllows.set(permitKey, {
      expiresAt: Date.now() + ONE_SHOT_ALLOW_TTL_MS,
      actor,
      tool: toolName,
    });
    // retry を返す前に置き終える: 撃ち直しが規則の置き直しを追い越すと、規則の無いまま分類器へ回るため
    const ruleAdded = await this.#addSessionAllowRule({
      shape: ruleShape,
      actor,
      toolName,
      inputHead,
    });
    const ttlMinutes = Math.round(ONE_SHOT_ALLOW_TTL_MS / 60000);
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        `クローンが分類器の拒否（${actor}・${toolName}）を1回だけ許可した。同じ入力で撃ち直された` +
        `ときにだけ、${ttlMinutes}分以内なら1回通す（issue #1105 P1）。` +
        `撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない` +
        `（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。` +
        (ruleAdded
          ? `同じ入力の1回だけを${ttlMinutes}分通す一時規則をこのセッションに足した` +
            `（そのセッションの他の作業者にも効く。#4905）。撃ち直すなら入力を1字も変えないこと。` +
            `それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること。`
          : `同じ入力で撃ち直しても、分類器にまた止められうる（迂回・敵対の型で止めた呼び出しは、` +
            `クローンの allow や担当の伝言を人間の確認と見なさない）。続けて同じ入力を撃たず、` +
            `別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4904）。`) +
        `担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。`,
    });
    return { kind: 'retry' };
  }

  // 「もっと強く書く」側へ倒さず機械の門へ倒す: システムプロンプトへ逐語で書いても守られないため
  // 既定を deny にしない（`ask` を既定にする）: 誰も開けられず、方針は設定で開けられなければならないため（north_star 禁止2）
  // `Bash` 以外を弾かない: 他のツールまで巻き込むと「何でも弾きうる門」になり、確認が要る行為の一覧を作ることに近づくため
  // `decision: 'block'`（セッション全体を止める口）を使わない: この呼び出し1件だけを拒否する
  // `escalate` を立てない: 作業者が動けなくなったような危険の通知ではなく、ツール呼び出し1件が拒否に置き換わっただけの経過のため
  // 冒頭で全道具の入力の先頭を控える（`Bash` に絞らない）: 分類器はどの道具でも拒否しうるため
  // 1回だけの許可の消費は deny の後に置く: `deny` の設定ではクローンの許可で門を上書きしないため
  // 判定の周りの例外で deny を消さない: フックが例外で終わると CLI は「ブロックしない」として通常の許可の流れへ戻し、ガードが素通りになるため（観測の副作用は失敗しても判定を止めず、判定そのものが投げたら確認へ倒す）
  async #onPreToolUse(record: AgentPreToolRecord): Promise<AgentPreToolDecision> {
    this.#tryObservation('PreToolUse の入力の頭の控え', () => {
      this.#capturePreToolInputHead(record);
    });
    this.#tryObservation('期限切れの一時規則の掃除', () => {
      this.#sweepExpiredSessionAllowRules();
    });

    let guardAsk: { reason: string } | undefined;
    if (record.toolName === 'Bash') {
      const toolInput = record.toolInput as
        { command?: unknown; run_in_background?: unknown } | null | undefined;
      const command = toolInput?.command;
      if (typeof command === 'string') {
        // `run_in_background` を `=== true` で受ける: 欠けていても形が崩れていても前景になり、通す側へ倒れるため
        let verdict:
          ReturnType<typeof inspectBashCommand> | { blocked: true; form: string; reason: string };
        let shapeDeny: boolean;
        try {
          // 本番デプロイの起動（release-prod）は `off` でも確認に残す
          const releaseProd = inspectReleaseProdDispatch(command);
          // 形の歯は release-prod の後・wait-guard の前に置く: release-prod は `off` でも残す門で、形の歯は断る理由が単純（打ち直せば抜けられる）なため先に返す
          // マネージャーにも掛ける（#4949）: heosterra のマネージャーも同じ形を打っていて、オーナーの決まりはマネージャーにも同じ形を禁じているため
          // `ALTEROID_BASH_GUARD` から切り離す（#4949）: 形の歯は `ALTEROID_BASH_SHAPE_GUARD`（既定 off）だけで決まる。呼び出しのたびに読み、プロファイルの値を優先する（プロファイルに置けば次の呼び出しから効く）。不正な値はここで投げ、下の catch が確認（`deny` 設定なら deny）に倒す
          const shape =
            !releaseProd.matched &&
            resolveEffectiveBashShapeGuard(this.#env, this.#profileEnv()) === 'on'
              ? inspectBashShape(command)
              : { blocked: false as const };
          shapeDeny = shape.blocked;
          verdict = releaseProd.matched
            ? { blocked: true, form: releaseProd.form, reason: releaseProd.reason }
            : shape.blocked
              ? shape
              : this.#bashGuard === 'off'
                ? { blocked: false }
                : inspectBashCommand(command, {
                    backgrounded: toolInput?.run_in_background === true,
                  });
        } catch (error) {
          // 判定できなかった呼び出しを素通しにしない: 倒れる先は確認で、上がらずに止めて誰も開けられない形にしない（`deny` を選んだ人にだけ止める）
          const message = reasonOf(error);
          const reason = `Bash のガードの判定が例外で終わったので、安全側で確認に上げた（${message}）。形を変えずに打ち直さず、依頼者へ報告すること。`;
          if (this.#bashGuard === 'deny') {
            return {
              kind: 'deny',
              reason: `Bash のガードの判定が例外で終わったので、安全側で拒否した（${message}）。形を変えずに打ち直さず、依頼者へ報告すること。`,
            };
          }
          return { kind: 'ask', reason };
        }
        if (verdict.blocked) {
          const actor =
            record.agentId === undefined
              ? `manager:${this.#id}`
              : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;
          // 形の歯は `ask` でも deny: 確認に上げると、打つたびにクローンへ確認が積み上がるため（#4947）
          const asked = this.#bashGuard !== 'deny' && !shapeDeny;

          this.#tryObservation('ガードの note の送り出し', () => {
            this.#emit({
              type: 'note',
              managerId: this.#id,
              text: asked
                ? `Bash の呼び出しを確認に上げた（${actor}・形=${verdict.form}）。${verdict.reason}`
                : `Bash の呼び出しを弾いた（${actor}・形=${verdict.form}）。${verdict.reason}`,
            });
          });

          if (!asked) return { kind: 'deny', reason: verdict.reason };
          guardAsk = { reason: verdict.reason };
        }
      }
    }

    // ガードの deny より後に置く: 弾いた呼び出しは Post も拒否の合図も来ないので、置くと片付かないため
    this.#tryObservation('作業者の道具の見張り', () => {
      if (record.agentId === undefined || record.toolUseId === undefined) return;
      this.#workerTools.begin({
        agentId: record.agentId,
        actor: `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`,
        tool: record.toolName ?? '(不明)',
        toolUseId: record.toolUseId,
      });
    });
    // 担い手を問わず印を付ける: 規則はセッション全体に効くので、誰が撃っても1回で外すため（#4905）
    this.#tryObservation('一時規則に当たる呼び出しの印', () => {
      this.#sessionAllowRules.markUse({
        toolUseId: record.toolUseId,
        toolName: record.toolName,
        toolInput: record.toolInput,
        useActor:
          record.agentId === undefined
            ? `manager:${this.#id}`
            : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`,
        nowMs: Date.now(),
      });
    });

    // `deny` の守りを書かない: `#consumeOneShotAllow` は戻り値の型で `deny` を返さず、将来返すようになれば `tsc` がここで落ちるため
    const decision = this.#consumeOneShotAllow(record);
    const rewrite = this.#planBashToolTimeoutRewrite(record);
    // 門の確認（`ask`）はクローンの1回だけの許可が開ける: 許可は同じ呼び出しに明示して出されたもので、確認に上げた答えと同じ重さのため
    const resolved: Exclude<AgentPreToolDecision, { kind: 'deny' }> =
      guardAsk !== undefined && decision.kind === 'continue'
        ? { kind: 'ask', reason: guardAsk.reason }
        : decision;
    if (rewrite === undefined) return resolved;
    return { ...resolved, rewrite };
  }

  // 弾かず入力を書き換える（`timeout` の欄の引き上げと、`gh run watch` への `--compact`。#5322）。判定が投げても呼び出しを止めない: 書き換えは安全弁ではなく便宜なので、倒れる先は「書き換えない」
  #planBashToolTimeoutRewrite(record: AgentPreToolRecord): AgentPreToolRewrite | undefined {
    if (record.toolName !== 'Bash') return undefined;
    const toolInput = record.toolInput;
    if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
      return undefined;
    }
    const original = toolInput as Record<string, unknown>;
    const actor =
      record.agentId === undefined
        ? `manager:${this.#id}`
        : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;

    // `gh run watch` の `--compact` は、`timeout` 引数の引き上げより先に当てる: 引き上げは書き換え後の入力を見るため（どちらも `timeout <秒>` の値は変えない）
    let input = original;
    const notes: string[] = [];
    try {
      const compact = planRunWatchCompact(original);
      if (compact !== undefined) {
        input = { ...original, command: compact.command };
        notes.push(describeRunWatchRewrite(compact));
        const added = [
          ...(compact.addedCompact ? ['--compact'] : []),
          ...(compact.addedInterval ? ['--interval 30'] : []),
        ].join(' と ');
        this.#tryObservation('gh run watch の --compact / --interval の note の送り出し', () => {
          this.#emit({
            type: 'note',
            managerId: this.#id,
            text: `gh run watch に ${added} を足した（${actor}・形=run-watch-compact）。`,
          });
        });
      }
    } catch (error) {
      writeStderrLine(
        `alteroid: gh run watch の --compact の判定が失敗した（書き換えない）: ${reasonOf(error)}\n`,
      );
    }

    let raise: ReturnType<typeof planBashToolTimeoutRaise>;
    try {
      raise = planBashToolTimeoutRaise(input);
    } catch (error) {
      writeStderrLine(
        `alteroid: Bash の timeout 引数の判定が失敗した（書き換えない）: ${reasonOf(error)}\n`,
      );
      raise = undefined;
    }
    if (raise !== undefined) {
      const from = raise.fromMs === undefined ? '未指定' : `${raise.fromMs}ms`;
      const toMs = raise.toMs;
      this.#tryObservation('timeout 引数の引き上げの note の送り出し', () => {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text: `Bash の呼び出しの timeout 引数を引き上げた（${actor}・形=bash-tool-timeout-raised・${from}→${toMs}ms）。`,
        });
      });
      input = { ...input, timeout: raise.toMs };
      notes.push(describeBashToolTimeoutRaise(raise));
    }
    if (notes.length === 0) return undefined;
    return { input, note: notes.join(' ') };
  }

  #settleWorkerTool(toolUseId: string): void {
    this.#tryObservation('作業者の道具の見張りの片付け', () => {
      this.#workerTools.settle(toolUseId);
    });
  }

  // 投げ直さない: `#onPreToolUse` が例外で終わり、ガードの deny が CLI へ届かなくなるため
  #tryObservation(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      writeStderrLine(`alteroid: ${label}が失敗した（判定は続ける）: ${reasonOf(error)}\n`);
    }
  }

  // `Bash` に絞らない: 分類器は `Edit` / `Write` 等にも掛かり、絞ると撃ち直しのほとんどが通せなくなるため
  // 鍵は表示用の伏せ字済みの値（`buildDenialInputHead`）にしない: 先頭160字が同じで残りが違う別の入力が誤って一致しうるため
  // `rawLineOf` を鍵にしない: `command` が同じでほかの欄（`run_in_background` / `timeout` 等）だけが違う撃ち直しにまで許可が及ぶため
  // 一致してもしなくても使い切る（`delete` する）。寿命ちょうどのミリ秒も「過ぎた」側に含める: 「まだ有効」に倒れると許しすぎるため
  #consumeOneShotAllow(
    record: AgentPreToolRecord,
  ): Extract<AgentPreToolDecision, { kind: 'continue' | 'allow' }> {
    const toolName = record.toolName;
    if (toolName === undefined) return { kind: 'continue' };
    const matchInput = matchInputOf(record.toolInput);
    if (matchInput === undefined) return { kind: 'continue' };

    const actor =
      record.agentId === undefined
        ? `manager:${this.#id}`
        : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;
    const key = oneShotAllowKey(oneShotActorOf(this.#id, record), toolName, digestOf(matchInput));
    this.#noteUnusedExpiredOneShotAllows(key);
    const grant = this.#oneShotAllows.get(key);
    if (grant === undefined) return { kind: 'continue' };
    this.#oneShotAllows.delete(key);

    if (grant.expiresAt <= Date.now()) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `分類器の拒否への1回だけの許可（${actor}・${toolName}）は期限切れだったので使わなかった` +
          `（issue #1105 P1）。分類器の判定へそのまま委ねる。`,
      });
      return { kind: 'continue' };
    }

    if (typeof record.toolUseId === 'string') {
      this.#oneShotAllowedToolUses.set(record.toolUseId, {
        actor,
        tool: toolName,
        key,
        at: Date.now(),
      });
    }

    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: `クローンの1回だけの許可（issue #1105 P1）で、分類器の拒否（${actor}・${toolName}）を上書きした。`,
    });

    return {
      kind: 'allow',
      reason: 'クローンが分類器の拒否をこの1回だけ上書きした（issue #1105 P1）。',
    };
  }

  // タイマーを置かない（遅延評価）: セッションの終了・畳みで片付け漏れる物が無いため
  #noteUnusedExpiredOneShotAllows(except: string | undefined): void {
    const now = Date.now();
    for (const [key, grant] of this.#oneShotAllows.entries()) {
      if (key === except || grant.expiresAt > now) continue;
      this.#oneShotAllows.delete(key);
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `クローンが出した1回だけの許可（${grant.actor}・${grant.tool}）は、撃ち直されないまま` +
          `${Math.round(ONE_SHOT_ALLOW_TTL_MS / 60000)}分の期限が切れた（使われていない。issue #1105 P1）。` +
          `撃ち直すかどうかは担い手のモデルが決めることで、retry は助言でしかない。` +
          `manager_send で伝える案が効くかは確かめていない。` +
          `この note は期限後の次の道具呼び出しか次の拒否の時点で出る（それまで何も呼ばれなければ出ない）。`,
      });
    }
  }

  /**
   * 委譲先の許可規則（#4952）と一時規則（#4905）をまとめた一覧を、いまのセッションへ丸ごと置き直す。置けたら undefined、置けなければ理由を返す（投げない）。
   * 一覧は積んだ時点ではなく順番が来た時点で読む: 先に積んだ置き直しが、後で外した規則を巻き戻さないため。
   * 片方だけを置かない: 口は一覧を丸ごと置き換えるので、片方だけを置くともう片方がセッションから消えるため。
   */
  #pushSessionAllowRules(): Promise<string | undefined> {
    const run = async (): Promise<string | undefined> => {
      const session = this.#sdkSession.query;
      if (session?.setSessionAllowRules === undefined) {
        return 'このセッションは規則を置く口を持たない';
      }
      try {
        // 期限を掛ける: 分類器の拒否のフックの中で待つので、答えない control channel に、フックと後に続く置き直しの鎖ごと止められないため
        await controlRequestWithin(
          session.setSessionAllowRules(
            mergeSessionAllowRules(this.#permissionRules(), this.#sessionAllowRules.rules()),
          ),
          this.#sessionAllowRulesTimeoutMs,
          'applyFlagSettings（一時規則の置き直し）',
        );
        return undefined;
      } catch (error) {
        return `規則の置き直しが失敗した: ${reasonOf(error)}`;
      }
    };
    const next = this.#sessionAllowRulesPush.then(run);
    this.#sessionAllowRulesPush = next;
    return next;
  }

  #sessionAllowRuleLabel(grant: SessionAllowRuleGrant): string {
    return `一時規則（担当 ${this.#id}・規則を足させた呼び出し: ${grant.grantActor}・Bash）`;
  }

  // 規則を足せないときは黙らない（Bash 以外と、口を持たない provider は今までどおりなので黙る）: 「足すはずが足りなかった」は、撃ち直しがまた止められたときの切り分けに要るため
  async #addSessionAllowRule(input: {
    shape: ReturnType<typeof sessionAllowRuleShapeOf>;
    actor: string;
    toolName: string;
    inputHead: string | undefined;
  }): Promise<boolean> {
    const { shape, actor, toolName, inputHead } = input;
    if (shape.kind === 'not-bash') return false;
    if (this.#sdkSession.query?.setSessionAllowRules === undefined) return false;
    const head = inputHead ?? '(取れなかった)';
    const refused = (reason: string) =>
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `分類器が止めた ${actor} の ${toolName} 呼び出しへのクローンの allow を、一時規則としてセッションに` +
          `足せなかった（担当 ${this.#id}。理由: ${reason}）。今までどおり、同じ担い手の同じ入力を1回だけ通す` +
          `許可だけを出す（#4905）。入力の先頭（伏せ字）: ${head}`,
      });
    if (shape.kind === 'unruleable') {
      refused(`command が規則にできない（${shape.reason}。完全一致より広い規則になりうる）`);
      return false;
    }

    const grant: SessionAllowRuleGrant = {
      rule: shape.rule,
      expiresAt: Date.now() + ONE_SHOT_ALLOW_TTL_MS,
      grantActor: actor,
      inputHead,
    };
    this.#sessionAllowRules.add(grant);
    const failure = await this.#pushSessionAllowRules();
    if (failure !== undefined) {
      this.#sessionAllowRules.remove(grant.rule);
      refused(failure);
      return false;
    }
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        `分類器が止めた ${actor} の Bash 呼び出しを、クローンの allow を受けて、同じ入力の1回だけを通す` +
        `一時規則としてこのセッションに足した（担当 ${this.#id}・${Math.round(ONE_SHOT_ALLOW_TTL_MS / 60000)}分で外す。` +
        `そのセッションの他の作業者が同じ入力を撃っても、1回使えば外れる。#4905）。入力の先頭（伏せ字）: ${head}`,
    });
    return true;
  }

  // 外した後の置き直しの失敗は note に残す: 外したはずの規則がセッションに残っているおそれがあり、次に置き直せるまで効き続けるため
  async #pushAfterSessionAllowRuleRemoval(): Promise<void> {
    const failure = await this.#pushSessionAllowRules();
    if (failure === undefined) return;
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        `一時規則を外したあと、セッションの規則の置き直しが失敗した（担当 ${this.#id}。${failure}）。` +
        `外したはずの規則がセッションに残っているおそれがある。次に一覧を置き直せたときに消える（#4905）。`,
    });
  }

  #sweepExpiredSessionAllowRules(): void {
    const expired = this.#sessionAllowRules.sweepExpired(Date.now());
    if (expired.length === 0) return;
    for (const grant of expired) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `${this.#sessionAllowRuleLabel(grant)}は、使われないまま` +
          `${Math.round(ONE_SHOT_ALLOW_TTL_MS / 60000)}分の期限が切れたので外した（#4905）。` +
          `この note は期限後の次の道具呼び出しか次の拒否の時点で出る。入力の先頭（伏せ字）: ${grant.inputHead ?? '(取れなかった)'}`,
      });
    }
    void this.#pushAfterSessionAllowRuleRemoval();
  }

  /**
   * 印を付けた呼び出しの決着で、一時規則を外して結果を note に残す。
   * `passed` は PostToolUse / PostToolUseFailure（道具が失敗で終わっても、分類器は通っている）、`denied` は拒否の合図。
   */
  #settleSessionAllowRuleUse(
    toolUseId: string | undefined,
    outcome: { kind: 'passed'; toolFailed: boolean } | { kind: 'denied'; via: string },
  ): void {
    const use = this.#sessionAllowRules.settleUse(toolUseId);
    if (use === undefined) return;
    const head = use.grant.inputHead ?? '(取れなかった)';
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        outcome.kind === 'passed'
          ? `${this.#sessionAllowRuleLabel(use.grant)}が ${use.useActor} の呼び出しで使われ、分類器を通った` +
            `（道具の結果: ${outcome.toolFailed ? '失敗。道具は失敗で終わったが、分類器は通っている' : '成功'}）。` +
            `1回使ったので外した（#4905）。入力の先頭（伏せ字）: ${head}`
          : `${this.#sessionAllowRuleLabel(use.grant)}に当たる ${use.useActor} の呼び出しが、それでも拒否された` +
            `（合図の出所: ${outcome.via}）。セッションに許可規則を足すこの口が、分類器に効いていない疑いがある。` +
            `規則は外した。同じ入力を撃ち直さず、人間が止められた中身を見て誤検知だと確かめるか、` +
            `別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4905）。入力の先頭（伏せ字）: ${head}`,
    });
    void this.#pushAfterSessionAllowRuleRemoval();
  }

  // 置き直しは呼ばない: セッションはこの後閉じ、閉じかけの control channel へ投げても届かないため（規則はセッションと一緒に消える）
  #dropSessionAllowRulesOnClose(): void {
    for (const grant of this.#sessionAllowRules.drainAll()) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `${this.#sessionAllowRuleLabel(grant)}は、セッションが閉じたので使われないまま外した（#4905）。` +
          `入力の先頭（伏せ字）: ${grant.inputHead ?? '(取れなかった)'}`,
      });
    }
  }

  // 開いた・開き直した CLI は flag 層を持ち越さないので、委譲先の許可規則と生きている一時規則を置き直す
  // 口の無いセッション（Codex）では何もしない: 置けない理由を note にすると、開くたびに同じ断りが積まれるため
  #reapplySessionAllowRules(): void {
    this.#sweepExpiredSessionAllowRules();
    const granted = this.#permissionRules().length;
    if (this.#sessionAllowRules.size === 0 && granted === 0) return;
    if (this.#sdkSession.query?.setSessionAllowRules === undefined) return;
    void this.#pushSessionAllowRules().then((failure) => {
      if (failure === undefined) return;
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `セッションを開いた（開き直した）が、生きている一時規則（${this.#sessionAllowRules.size}件）と` +
          `委譲先の許可規則（${granted}件）を置き直せなかった（担当 ${this.#id}。${failure}）。` +
          `撃ち直しは、同じ担い手の1回だけの許可でしか通らず、人間が承認した許可もこのセッションには効かない（#4905・#4952）。`,
      });
    });
  }

  /**
   * 委譲先の許可規則の一覧が変わったとき（#4952）に Host から呼ばれ、走行中のセッションへ置き直す。
   * 口の無いセッション（Codex）・まだ開いていないセッションでは何もしない（開くときに `#reapplySessionAllowRules` が置く）。
   */
  reapplyPermissionRules(): void {
    if (this.#sdkSession.query?.setSessionAllowRules === undefined) return;
    void this.#pushSessionAllowRules().then((failure) => {
      if (failure === undefined) return;
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `委譲先の許可規則（人間が承認した許可）の一覧が変わったが、このセッションへ置き直せなかった` +
          `（担当 ${this.#id}・いまの一覧は ${this.#permissionRules().length}件。${failure}）。` +
          `取り消された許可の規則がセッションに残っている、または足された許可がまだ効いていないおそれがある。` +
          `次に一覧を置き直せたときに揃う（#4952）。`,
      });
    });
  }

  // 資格の正本の値を、名前によらず伏せ字の対象にする（#4829）: 正本は名前と値しか降りず「秘密か」の印が無いので、`DB_PASS` のように名前の決まりに合わない秘密が抜粋・日誌・note へ伏せずに出るため
  #vaultValues(): string[] {
    return Object.values(this.#credentials?.values() ?? {});
  }

  // 生の入力を保持しない（伏せ字済みの先頭だけ）: 忘れるまでの間ずっと鍵が入りうる文字列を抱え、`onForget` の日誌行へ滲み出る経路も増えるため
  #capturePreToolInputHead(record: AgentPreToolRecord): void {
    if (record.toolUseId === undefined) return;
    const preview = buildDenialInputHead(record.toolInput, this.#env, this.#vaultValues());
    if (preview === undefined) return;
    this.#preToolInputHeads.set(record.toolUseId, preview);
  }

  // 背景タスクの所有者をここで控える: `SubagentStop` の `background_tasks[]` に所有者の欄が無く、生ログにも構造化された形では出ないため
  // 成功で決着した呼び出しの控え（`#preToolInputHeads` / `#oneShotAllowedToolUses`）を消す: 控えっぱなしにしない（成功後に拒否は届かない）
  async #onPostToolUse(record: AgentToolAuditRecord): Promise<AgentContextOutcome> {
    if (typeof record.toolUseId === 'string') {
      this.#preToolInputHeads.delete(record.toolUseId);
      this.#oneShotAllowedToolUses.delete(record.toolUseId);
      this.#settleWorkerTool(record.toolUseId);
    }
    this.#settleSessionAllowRuleUse(record.toolUseId, { kind: 'passed', toolFailed: false });
    if (typeof record.transcriptPath === 'string')
      this.#sdkSession.setTranscriptPath(record.transcriptPath);
    this.#markProgressed();

    if (record.agentId === undefined) this.#turnTally.incrementToolsSinceResult();

    // 作業者の分も数える: マージや push を打つのは作業者のことが多い
    // PreToolUse ではなくここで拾う: 拒否されて走らなかったコマンドを「外へ出した」と言わないため
    const command = (record.toolInput as { command?: unknown } | undefined)?.command;
    if (record.toolName === 'Bash' && typeof command === 'string') {
      for (const label of outwardCommandsIn(command)) {
        if (!this.#outwardActions.includes(label)) this.#outwardActions.push(label);
      }
      for (const dir of gitDirsFromBashCommand(command, record.cwd)) {
        if (this.#gitDirHints.length >= GIT_DIR_HINTS_MAX) break;
        if (!this.#gitDirHints.includes(dir)) this.#gitDirHints.push(dir);
      }
    }

    this.#emit({
      type: 'tool_use',
      managerId: this.#id,
      actor:
        record.agentId === undefined
          ? `manager:${this.#id}`
          : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`,
      tool: record.toolName ?? '(不明)',
      input: record.toolInput,
    });

    this.#recordBackgroundTaskOwner(record.toolResponse, record.agentId, record.toolInput);

    // 道具の種類を問わない: `#pendingCutOffNotifications` はどの道具の呼び出しにも相乗りし、先に届いた別の完了通知を配達するだけのため
    const additionalContext =
      record.agentId === undefined ? this.#annotateCutOffWorkers(record.toolResponse) : null;
    // 担当本人にも作業者にも添える: dev サーバーや E2E を起こすのは作業者のことが多い
    const pressure = await this.#pidsPressureNotice(record.agentId);
    const staleUntracked = this.#staleUntrackedNotice(record.agentId);
    const peerApproval = this.#peerApprovalNotice(record.agentId);
    const workerLimit = this.#workerLimitNotice(record.agentId);
    const reportLanguage = this.#reportLanguageNotice(record.agentId);
    const pipeExit = pipeExitNotice(record.toolName, command);
    // 分類器の拒否が続いた後に初めて通った道具に、事情と取れる道を添える
    const streakActor = record.agentId ?? 'manager';
    const denialStreak = this.#denialStreaks.takeNotice(streakActor, Date.now());
    this.#denialStreaks.noteProgress(streakActor);
    const parts = [
      additionalContext,
      pressure,
      staleUntracked,
      peerApproval,
      workerLimit,
      reportLanguage,
      pipeExit,
      denialStreak,
    ].filter((part): part is string => part !== null);
    if (parts.length === 0) return { kind: 'continue' };
    return { kind: 'addContext', text: parts.join('\n\n') };
  }

  /**
   * 器の pids が上限に近ければ、知らせの段落を返す（`runner-pids-pressure.ts`）。相手（担当本人・作業者ごと）に5分に1回まで。
   * 担当本人に添えた回は、日誌にも1行残す: 添えたかどうかがクローンから見えないと、本番で効いたかを確かめられないため。
   * 読めない・投げたときは何も添えない: 知らせのために道具の結果を壊さないため。
   */
  async #pidsPressureNotice(agentId: string | undefined): Promise<string | null> {
    if (this.#pidsPressureFn === undefined) return null;
    let reading: PidsPressureReading | undefined;
    try {
      reading = await this.#pidsPressureFn();
    } catch {
      return null;
    }
    const text = this.#pidsPressureNotices.next(agentId ?? 'manager', reading, Date.now());
    if (text !== null && agentId === undefined && reading !== undefined) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `器の pids が ${String(reading.current)}/${String(reading.max)}（この器で手を動かしている担当 ${String(reading.delegations)} 本）で上限に近いので、` +
          'この担当の道具の結果に「重い処理を重ねる前に、要らない背景処理を止めることを考えよ」という知らせを添えた（止める指示ではない）。',
      });
    }
    return text;
  }

  /**
   * 作業ツリーに 30 分以上 commit されていない未追跡のファイルが残っていれば、知らせの段落を返す（`runner-stale-untracked.ts`、#4863 案C）。
   * 相手（担当本人・作業者ごと）に30分に1回まで。担当本人に添えた回は日誌にも1行残す。投げたときは何も添えない。
   */
  #staleUntrackedNotice(agentId: string | undefined): string | null {
    try {
      const stale = this.#rescueMemory.staleUntracked(UNTRACKED_STALE_AFTER_MS);
      const text = this.#staleUntrackedNotices.next(agentId ?? 'manager', stale, Date.now());
      if (text !== null && agentId === undefined) {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text:
            `作業ツリーに 30 分以上 commit されていない未追跡のファイルがある（${String(stale.length)} 本の作業ツリー）ので、` +
            'この担当の道具の結果に「commit して push するか出し箱へ写すこと」という知らせを添えた（止める指示ではない）。',
        });
      }
      return text;
    } catch {
      return null;
    }
  }

  /**
   * 確認待ちの peer が 10 分以上残っていれば、知らせの段落を返す（`runner-peer-approval-notice.ts`、#4886）。
   * 確認に期限は無く、自動では閉じない（見える化だけ）。相手（担当本人・作業者ごと）に10分に1回まで。担当本人に添えた回は日誌にも1行残す。
   * 投げたときは何も添えない。
   */
  #peerApprovalNotice(agentId: string | undefined): string | null {
    const broker = this.#peerBroker;
    if (broker === undefined) return null;
    try {
      const notice = this.#peerApprovalNotices.next(
        agentId ?? 'manager',
        broker.pendingApprovals(),
        Date.now(),
      );
      if (notice !== null && agentId === undefined) {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text:
            `確認待ちの peer が 10 分以上残っている（${String(notice.count)} 本）ので、` +
            'この担当の道具の結果に「peer_approve で答えるか閉じること」という知らせを添えた（止める指示ではない）。',
        });
      }
      return notice?.text ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 担当本人の発言（`parentToolUseId` の無い assistant の本文）に英語の文が混ざっていれば、知らせる待ちに積み、日誌に1行残す（#4965）。
   * 作業者の発言には掛けない: 作業者の本文は `parentToolUseId`（Task の tool_use id）でしか届かず、知らせを添える PostToolUse の `agent_id` と結ぶ口が無いため。
   * 設定は発言のたびに読む（プロファイルに1行置けば次の発言から効く）。off なら判定もしない。
   * 不正な値・判定が投げたときは知らせない側へ倒す: 知らせのために担当の発言の処理を壊さないため。不正な値は同じ値につき1回だけ日誌に書く。
   */
  #observeReportLanguage(said: string): void {
    try {
      let mode: string;
      try {
        mode = resolveEffectiveReportLanguage(this.#env, this.#profileEnv());
      } catch (error) {
        this.#noteReportLanguageMisconfig(error);
        return;
      }
      if (mode === 'off') return;
      const found = findEnglishSentences(said);
      if (found.length === 0) return;
      if (!this.#reportLanguageNotices.observe('manager', found, Date.now())) return;
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `担当の発言に英語の文が ${String(found.length)} 件混ざっていた` +
          `（担い手: manager:${this.#id}、例: "${excerptExample(found[0] ?? '')}"）。#4965`,
      });
    } catch {
      return;
    }
  }

  /** 担当の発言に英語の文が混ざっていた後の最初の道具の結果に、知らせの段落を返す（#4965）。同じ担い手に10分に1回まで。 */
  #reportLanguageNotice(agentId: string | undefined): string | null {
    try {
      return this.#reportLanguageNotices.next(agentId ?? 'manager', Date.now());
    } catch {
      return null;
    }
  }

  /**
   * 作業者が利用上限で落ちた事実を覚え、日誌とクローンの受信箱へ運ぶ（#4903）。担当のターンが成功しても捨てない。
   * 枠の印（`#usageStopped`）・`usage_notice`・鍵の回転の契機にはしない: 担当は動けるため。原文は伏せ字を通す。
   * 重複は身元（作業者を呼んだ tool_use の id）でそろえる: 作業者が上限で落ちると、作業者の発言の拒否の印とタスクの失敗通知の2つが届き、
   * 名札も原文も違うので2回記録して知らせが2通になっていた（#4996）。
   */
  #recordWorkerLimit(identity: string, label: string, raw: string): void {
    const shown = redactErrorText(raw, process.env, this.#vaultValues());
    if (!this.#workerLimitNotices.record(identity, label, shown, Date.now())) return;
    // `wantsTokenRecycle` で判定しない: `GH_TOKEN` の差し替えや peer の開閉でも立ち、そのときは鍵は回っていないため（Claude の鍵が変わった回だけの印を読む）
    const preRotationKey = this.#sdkSession.onPreRotationClaudeKey;
    if (preRotationKey) this.#workerLimitOnPreRotationKey = true;
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        `作業者（${label}）だけが利用上限で落ちた。担当は動けるので、枠の印も鍵の回転も起こしていない。` +
        `次の道具の結果に知らせを添える（原文: ${shown.trim().slice(0, 300)}）` +
        (preRotationKey ? WORKER_LIMIT_PRE_ROTATION_KEY_SENTENCE : ''),
      notifyClone: true,
      // 構造化して運ぶ: デーモンが落ちた枠の鍵を突き合わせるのに原文と印が要り、`text` の文言では判定しない
      workerLimit: { raw: shown.trim().slice(0, 300), preRotationKey },
    });
  }

  /**
   * 作業者が利用上限で落ちていれば、知らせの段落を返す（`runner-worker-limit-notice.ts`、#4903）。
   * 相手（担当本人・作業者ごと）に10分に1回まで。担当本人に添えた回は日誌にも1行残す。投げたときは何も添えない。
   */
  #workerLimitNotice(agentId: string | undefined): string | null {
    try {
      const preRotationKey = this.#sdkSession.onPreRotationClaudeKey;
      const notice = this.#workerLimitNotices.next(
        agentId ?? 'manager',
        agentId === undefined,
        Date.now(),
        preRotationKey,
      );
      if (notice !== null && agentId === undefined) {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text:
            `作業者が利用上限で落ちている（${String(notice.count)} 体）ので、` +
            (preRotationKey
              ? 'この担当の道具の結果に「鍵は回っているので、このターンを終えれば新しい鍵で開き直る」という知らせを添えた（止める指示ではない）。'
              : 'この担当の道具の結果に「戻るまで作業者を立て直しても同じく落ちうる」という知らせを添えた（止める指示ではない）。'),
        });
      }
      return notice?.text ?? null;
    } catch {
      return null;
    }
  }

  #annotateCutOffWorkers(toolResponse: unknown): string | null {
    const parts: string[] = [];
    const sync = this.#annotateCutOffWorker(toolResponse);
    if (sync !== null) parts.push(sync);
    const pending = this.#drainPendingCutOffNotifications();
    if (pending !== null) parts.push(pending);
    const finished = this.#drainFinishedBackgroundTaskOutputs();
    if (finished !== null) parts.push(finished);
    return parts.length === 0 ? null : parts.join('\n\n');
  }

  // `#renderSubagentStopTaskLines` を使い回さない: 型も出所も違うため
  #renderCutOffTaskLines(agentId: string): string[] {
    return this.#cutOffWorkers
      .cutOffTasks(agentId)
      .map(
        (task) => `- id=${task.id}${task.command === undefined ? '' : ` command=${task.command}`}`,
      );
  }

  // 案内の文面を場所ごとに変えない: 読む場所によって変わると、どこで読んでも同じ手を思い出せるという利点が消えるため
  // 即時に届くとは書かない: 届くのは作業者の次の道具の区切りで、作業者は読む前に動くことがあるため
  #resumeGuidance(agentId: string): string {
    return (
      `続きを頼むなら、\`ToolSearch\` を \`select:SendMessage\` で読み込んでから ` +
      `agentId=${agentId} へ送ること——同じ文脈のまま再開できる。` +
      '届くのはその作業者の次の道具の区切りで、即時ではない（読む前に動くことがある）。'
    );
  }

  #drainFinishedBackgroundTaskOutputs(): string | null {
    const items = this.#cutOffWorkers.drainPendingBackgroundTaskOutputs();
    if (items.length === 0) return null;
    const describe = (item: PendingBackgroundTaskOutput): string =>
      `agent_id=${item.agentId} が残した背景処理（id=${item.taskId}` +
      `${item.command === undefined ? '' : `・command=${item.command}`}）`;
    for (const item of items) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `打ち切った作業者の背景処理が終わった（#1554）: ${describe(item)}が完了した。` +
          `出力は${item.outputFile === null ? '取れなかった' : ` ${item.outputFile}`}`,
      });
    }
    return items
      .map(
        (item) =>
          `⚠️ ${describe(item)}が終わった。出力は` +
          `${item.outputFile === null ? '取れなかった' : ` ${item.outputFile}`}。 ` +
          this.#resumeGuidance(item.agentId),
      )
      .join('\n\n');
  }

  // フックの `agent_id` どうしで結ばない: `Task` の `PostToolUse` はマネージャー側で発火するので `agent_id` が付かないため（`tool_response.agentId` と `SubagentStop` の `agent_id` で結ぶ）
  #annotateCutOffWorker(toolResponse: unknown): string | null {
    if (typeof toolResponse !== 'object' || toolResponse === null) return null;
    const response = toolResponse as { status?: unknown; agentId?: unknown };
    if (response.status !== 'completed' || typeof response.agentId !== 'string') return null;
    if (!this.#cutOffWorkers.consumeCutOff(response.agentId)) return null;
    const agentId = response.agentId;
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: `Task の結果に注記した（#901）: agent_id=${agentId} は背景処理の待ちの上限（30分）で打ち切られていた`,
    });
    return [
      `⚠️ この作業者（agent_id=${agentId}）は、自分で起こした背景処理を残したまま` +
        '畳もうとした後、背景処理の完了を待つ上限（30分）に達したため、alteroid が打ち切った。' +
        '**上の報告は完結していない可能性がある**（最後の発言が「待っています」の類でも、' +
        'その待ちはもう誰も続けない）。成果（commit / push / 検証）が実際に在るかを確かめてから次を決めること。',
      ...this.#renderCutOffTaskLines(agentId),
      '出力の置き場所は、処理が終わったら知らせる（#1554）。',
      this.#resumeGuidance(agentId),
    ].join('\n');
  }

  // note は配達時点で出す（控えた時点では出さない）: 控えただけの段階で同じ文言を出すと「もう注記した」と読めてしまうため
  #drainPendingCutOffNotifications(): string | null {
    const agentIds = this.#cutOffWorkers.drainPendingNotifications();
    if (agentIds.length === 0) return null;
    for (const agentId of agentIds) {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `Task の結果に注記した（#901・task_notification 経由）: ` +
          `agent_id=${agentId} は背景処理の待ちの上限（30分）で打ち切られていた`,
      });
    }
    return agentIds
      .map((agentId) =>
        [
          `⚠️ 作業者（agent_id=${agentId}）は、自分で起こした背景処理を残したまま` +
            '畳もうとした後、背景処理の完了を待つ上限（30分）に達したため、alteroid が打ち切った。' +
            '**先に届いたその完了通知（task-notification）の報告は完結していない可能性がある**' +
            '（最後の発言が「待っています」の類でも、その待ちはもう誰も続けない）。' +
            '成果（commit / push / 検証）が実際に在るかを確かめてから次を決めること。',
          ...this.#renderCutOffTaskLines(agentId),
          '出力の置き場所は、処理が終わったら知らせる（#1554）。',
          this.#resumeGuidance(agentId),
        ].join('\n'),
      )
      .join('\n\n');
  }

  // `tool_use` に `outcome` を足さず `note` で出す: 旧 daemon の `runnerEventSchema` は未知の欄を黙って落とし、失敗が成功の顔で日誌に残る（1件も記録しないより悪い）ため
  // `#recordBackgroundTaskOwner` を呼ばない: `PostToolUseFailureHookInput` には `tool_response` も `backgroundTaskId` を運べる欄も無いため
  // 自作ツールの除外を失敗側にだけ新設しない: 成功側と揃えるため
  // `#preToolInputHeads` / `#oneShotAllowedToolUses` を消す: 失敗は `#noteDenial` を経由せず、消さないと上限による `onForget` まで残るため
  async #onPostToolUseFailure(record: AgentToolAuditFailureRecord): Promise<void> {
    if (typeof record.toolUseId === 'string') {
      this.#preToolInputHeads.delete(record.toolUseId);
      this.#oneShotAllowedToolUses.delete(record.toolUseId);
      this.#settleWorkerTool(record.toolUseId);
    }
    this.#settleSessionAllowRuleUse(record.toolUseId, { kind: 'passed', toolFailed: true });
    if (typeof record.transcriptPath === 'string')
      this.#sdkSession.setTranscriptPath(record.transcriptPath);
    this.#markProgressed();
    // 失敗で終わっても、道具は分類器を通って走った: 連続の数えを0に戻す（このフックは文脈を返せないので、知らせは次に通った道具へ持ち越す）
    this.#denialStreaks.noteProgress(record.agentId ?? 'manager');

    if (record.agentId === undefined) this.#turnTally.incrementToolsSinceResult();

    const actor =
      record.agentId === undefined
        ? `manager:${this.#id}`
        : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;
    const tool = record.toolName ?? '(不明)';
    const error =
      typeof record.error === 'string'
        ? // 道具の出力（トークン・資格付き URL）を運びうる自由文なので、伏せてから切る
          excerptLine(
            redactErrorText(record.error, process.env, this.#vaultValues()),
            TOOL_USE_FAILURE_ERROR_EXCERPT,
          )
        : '(不明)';

    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: `${TOOL_USE_FAILURE_NOTE_PREFIX} 道具=${tool}・actor=${actor}・error=${error}`,
    });
  }

  // 入力を防御的に読む: `tool_response` の形は SDK 側の都合で変わりうるため。道具名で絞らない（このキーを返す道具は `Bash` だけなので、他の道具での早期 return は正常な経路）
  // 「読めなかった」`command` を空文字と混ぜない
  #recordBackgroundTaskOwner(
    toolResponse: unknown,
    agentId: string | undefined,
    toolInput?: unknown,
  ): void {
    if (typeof toolResponse !== 'object' || toolResponse === null) return;
    const taskId = (toolResponse as { backgroundTaskId?: unknown }).backgroundTaskId;
    if (typeof taskId !== 'string' || taskId.length === 0) return;

    const command =
      typeof toolInput === 'object' && toolInput !== null
        ? (toolInput as { command?: unknown }).command
        : undefined;

    // マネージャー自身の分は空文字で控える: 「引けなかった」と混ぜないため
    this.#stopState.setBackgroundTaskOwner(
      taskId,
      agentId ?? '',
      typeof command === 'string' ? command : undefined,
    );
  }

  // CLI は resume のとき最初の system prompt を持ち続け、環境・言語の変化だけを知らせで足すので、system prompt の末尾の段落（#4977）は #4977 より前に開いたセッションに届かない。resume・fork の回に会話へ足す（#4995）。
  // startup は system prompt に入っており、compact は system prompt が残るので足さない
  async #onSessionStart(record: AgentSessionStartRecord): Promise<string | null> {
    if (record.source !== 'resume' && record.source !== 'fork') return null;
    if (this.#sessionReportLanguage() !== 'ja') return null;
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: `${record.source} で開いたので、応答の言語の段落を会話へ足した。#4995`,
    });
    return REPORT_LANGUAGE_PROMPT_PARAGRAPH;
  }

  // `{ continue: true }` を返すだけでブロックしない: ブロックすれば能力の削除になるため
  async #onUserPromptSubmit(record: AgentUserPromptSubmitRecord): Promise<void> {
    if (record.agentId === undefined) {
      this.#turnTally.incrementSubmitsSinceResult();
      // 取れない回に `'unknown': 1` のような行を作らない（AGENTS.md 地雷「取れない軸に0の行を作る」）
      if (typeof record.source === 'string') {
        this.#turnTally.recordSubmitSource(record.source);
      }
    }
  }

  /**
   * [sdk-verbatim SubagentStopHookSpecificOutput]
   * > Hook-specific output for the SubagentStop event. additionalContext is non-error feedback delivered to the subagent; the subagent continues so it can act on it.
   */
  // `decision: 'block'` を使わず `additionalContext` だけを返す: `block` は止める側の口で、地雷「ターン数上限・実行回数上限で暴走を止める」（能力の削除）に当たるため
  // `runner-protocol.ts` の欄を増やさず `note` に乗せる: runner が新しく名乗る値を足すと古い runner が居る窓が開くため
  // `background_tasks` が非空であることを空転の署名にしない: 畳もうとしている当人と兄弟の作業者も配列に入り、件数では「この作業者が待っている」が言えないため（所有者で絞る）
  // `mine` を「まだ走っているもの」と見ない（`status` で言い分ける）: 畳み終えた背景処理の完了を待たせる形で作業者を起こし直し、進まないまま上限に達して委譲が止まるため
  // 回数の上限で暴走を止めない: 回数で止める形は地雷に当たり、各回は背景処理が終わった後の1ターンで空転ではなく仕事のため（終わらない背景処理は30分で切れる）
  // 待ちの途中で畳まれたら起こし直さず返す: 畳まれつつある世代で作業者にモデルを1ターン回させても結果は誰にも届かない。打ち切りではないので `recordCutOff` は通さない
  // この `note` が出ないことを「空転が無かった」と読ませない: フックの発火は親のターンが開いていたかで割れ、拾えるのは一部のため
  // 例外が出ても起こし直さず `{ continue: true }` へ倒す。`#markProgressed()` を呼ばない: 挙動を変えるのは継続の合図だけのため
  async #onSubagentStop(record: AgentSubagentStopRecord): Promise<AgentContextOutcome> {
    if (typeof record.agentId === 'string') {
      const agentId = record.agentId;
      this.#tryObservation('作業者の道具の見張りの片付け', () => {
        this.#workerTools.settleAgent(agentId);
      });
    }
    try {
      if (record.readError !== undefined) throw record.readError;
      const tasks = record.backgroundTasks ?? [];
      const crons = record.sessionCrons ?? [];
      const agentId = record.agentId;
      const stopHookActive = record.stopHookActive;

      const mine = tasks.filter((task) => {
        const id = (task as { id?: unknown }).id;
        if (typeof id !== 'string' || agentId === undefined) return false;
        return this.#stopState.backgroundTaskOwner(id) === agentId;
      });

      if (mine.length === 0) {
        this.#noteOwnerLookupFailure(tasks);
        return { kind: 'continue' };
      }
      if (agentId === undefined) return { kind: 'continue' };

      // `'unknown'` は「走っている」側へ倒す: 倒す先を間違えると起こし直しが黙って効かなくなるため（分からなかったことは下の `note` に書く）
      const remaining: unknown[] = [];
      const settled: unknown[] = [];
      let unknownStatusCount = 0;
      for (const task of mine) {
        const kind = classifyBackgroundTaskStatus((task as { status?: unknown }).status);
        if (kind === 'settled') {
          settled.push(task);
          continue;
        }
        remaining.push(task);
        if (kind === 'unknown') unknownStatusCount += 1;
      }

      // 当人のものが全部終わっていたら起こし直さないが、黙らない: 1セッションに1回だけ日誌へ出す（`#noteSettledOnly`）
      if (remaining.length === 0) {
        this.#noteSettledOnly(settled);
        return { kind: 'continue' };
      }

      const stopHookActiveText =
        stopHookActive === undefined ? '' : ` stop_hook_active=${String(stopHookActive)}。`;
      const disclaimer =
        '⚠️ この行が出ないことは「空転が無かった」を意味しない — ' +
        'このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。';

      // 数に入れなかったものを黙って落とさない: 「残っている」の件数だけを出すと `status` で言い分けたこと自体が消えるため（AGENTS.md「静かに失敗する道具」）
      const settledText =
        settled.length === 0
          ? ''
          : `（当人が起こしたもののうち ${settled.length}件 は status が「終わった」側だったので数に入れていない）`;
      const unknownText =
        unknownStatusCount === 0
          ? ''
          : `⚠️ 上のうち ${unknownStatusCount}件 は status が既知の語彙のどちらでもない —— ` +
            '「走っている」へ倒して数えた（分からないものを「終わった」へ倒さない）。' +
            'この行が出たら計器のほうを疑う — SDK が status の語彙を変えた見込みが高い。';
      // `id` を防御的にもう一度 `typeof` で絞る: 前提が崩れても例外で落ちない側へ倒すため
      const remainingIds = remaining
        .map((task) => (task as { id?: unknown }).id)
        .filter((id): id is string => typeof id === 'string');
      const waitOutcome = await this.#waitForBackgroundTasks(remainingIds);

      // 待ちの途中で畳まれたら起こし直さず返す: 結果が誰にも届かず、`recordCutOff` を通すと新しい世代で「打ち切った作業者」の注記を誤って出すため
      if (waitOutcome === 'released') {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text: this.#truncateSubagentStopText(
            `SubagentStop（作業者: ${record.agentType ?? '(不明)'} / agent_id=${agentId}）: ` +
              `**この作業者が自分で起こした背景処理が ${remaining.length}件 残ったまま畳もうとした** ` +
              '— 完了を待っている途中でセッションが畳まれた（stop / 畳み直し / 世代交代）ので、' +
              `起こし直さずに返した。${stopHookActiveText}`,
          ),
        });
        return { kind: 'continue' };
      }

      if (waitOutcome === 'settled') {
        const newTotal = this.#stopState.recordSubagentWakeup(agentId);
        const taskLines = this.#renderSubagentStopTaskLines(remaining);

        const noteLines = [
          `SubagentStop（作業者: ${record.agentType ?? '(不明)'} / agent_id=${agentId}）: ` +
            `**この作業者が自分で起こした背景処理が ${remaining.length}件 残ったまま畳もうとした**` +
            settledText +
            `（この瞬間のセッション全体の在庫=${tasks.length}件、session_crons=${crons.length}件）。` +
            `**完了を待ってから起こし直した**（この作業者の通算 ${newTotal}回目）。${stopHookActiveText}`,
          ...taskLines,
          ...(unknownText === '' ? [] : [unknownText]),
          disclaimer,
        ];
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text: this.#truncateSubagentStopText(noteLines.join('\n')),
          stall: {
            agentId,
            ...(record.agentType === undefined ? {} : { agentType: record.agentType }),
            ownedTaskCount: remaining.length,
            sessionTaskCount: tasks.length,
            wakeupCount: newTotal,
            outcome: 'woken',
          },
        });

        // 出力の置き場所が取れなければ「取れなかった」と書く: 作り物のパスを主張しないため
        const snapshotCommands = new Map<string, string>();
        for (const task of remaining) {
          const t = task as { id?: unknown; command?: unknown };
          if (typeof t.id === 'string' && typeof t.command === 'string') {
            snapshotCommands.set(t.id, t.command);
          }
        }
        const finishedLines = remainingIds.map((id) => {
          const command = snapshotCommands.get(id) ?? this.#stopState.backgroundTaskCommand(id);
          const outputFile = this.#sdkSession.backgroundWaiters.outputFileOf(id);
          return (
            `- id=${id}${command === undefined ? '' : ` command=${command}`} ` +
            `出力: ${outputFile === null ? '取れなかった（完了通知の output_file が無い）' : outputFile}`
          );
        });
        const contextLines = [
          `あなたが自分で起こした背景処理が ${remaining.length}件、残ったまま畳もうとしたので、` +
            '**終わるまで待ってから**起こし直した。**背景処理は終わった。**' +
            settledText +
            `（この瞬間のセッション全体の在庫=${tasks.length}件、session_crons=${crons.length}件）。`,
          ...finishedLines,
          ...(unknownText === '' ? [] : [unknownText]),
          '**結果（出力）を読んでから畳むこと。** 出力の置き場所は上の行のとおり。' +
            'まだ続きの背景処理を起こすなら、畳む前にまた最大 ' +
            `${String(SUBAGENT_BACKGROUND_WAIT_MS / 60_000)} 分は完了を待つ（それを超えると打ち切られる）。`,
          `これはこの作業者の通算 ${newTotal}回目の起こし直し。`,
        ];
        return {
          kind: 'addContext',
          text: this.#truncateSubagentStopText(contextLines.join('\n')),
        };
      }

      // `escalate` を毎回立てない: 同じ agentId が `SubagentStop` を送るたびに同じ report がクローンの受信箱へ積まれ続けるため（間引くのは知らせであって実行の制限ではない）
      const total = this.#stopState.subagentWakeupTotal(agentId);
      const { count: limitNoteCount, shouldEscalate: shouldEscalateLimitNote } =
        this.#stopState.recordSubagentLimitReachedNote(agentId);

      const taskLines = this.#renderSubagentStopTaskLines(remaining);
      const limitReasonText =
        `**背景処理の完了を ${String(SUBAGENT_BACKGROUND_WAIT_MS / 60_000)} 分（待ちの上限）まで待ったが、` +
        `終わらなかったため、起こし直さずに打ち切った**（この作業者の通算 ${total}回 起こし直し済み）。`;
      const limitNoteCountText =
        `打ち切ってから ${limitNoteCount}回目（1・3・9…回目だけクローンへ上げる）。` +
        (shouldEscalateLimitNote ? '' : ' この回はクローンの受信箱へは上げない — 日誌には残る。');
      const noteLines = [
        `SubagentStop（作業者: ${record.agentType ?? '(不明)'} / agent_id=${agentId}）: ` +
          `**この作業者が自分で起こした背景処理が ${remaining.length}件 残ったまま畳もうとした**` +
          settledText +
          `（この瞬間のセッション全体の在庫=${tasks.length}件、session_crons=${crons.length}件）。` +
          limitReasonText +
          stopHookActiveText,
        limitNoteCountText,
        ...taskLines,
        ...(unknownText === '' ? [] : [unknownText]),
        disclaimer,
        // `taskLines` より後ろに置く: `#truncateSubagentStopText` は末尾から切るので、読み手がいちばん要る id / command を残すため
        '出力の置き場所は、処理が終わったら知らせる（#1554）。',
        this.#resumeGuidance(agentId),
      ];
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: this.#truncateSubagentStopText(noteLines.join('\n')),
        ...(shouldEscalateLimitNote ? { escalate: true } : {}),
        stall: {
          agentId,
          ...(record.agentType === undefined ? {} : { agentType: record.agentType }),
          ownedTaskCount: remaining.length,
          sessionTaskCount: tasks.length,
          // 間引きの回数 `limitNoteCount` を運ばない: スキーマの doc の意味を変えないため
          wakeupCount: total,
          outcome: 'limit_reached',
        },
      });
      const cutOffTasks: CutOffBackgroundTaskSummary[] = remaining.flatMap((task) => {
        const t = task as { id?: unknown; command?: unknown };
        if (typeof t.id !== 'string') return [];
        return [{ id: t.id, ...(typeof t.command === 'string' ? { command: t.command } : {}) }];
      });
      this.#cutOffWorkers.recordCutOff(agentId, cutOffTasks);

      return { kind: 'continue' };
    } catch (error: unknown) {
      // フックが例外でセッションを止めない: 起こし直しよりも必ず `continue: true` を返すことを優先する
      try {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text: `SubagentStop の観測に失敗した: ${reasonOf(error)}`,
        });
      } catch {
        // ここまで失敗したら、もう上げる手段が無い。黙って諦める
        // （挙動は変えない＝必ず continue: true を返すことのほうを優先する）。
      }
      return { kind: 'continue' };
    }
  }

  // 載ったことの無い id を「載っていない」だけで終わりとしない: id 空間が違えば常に真になり、待たずに毎回起こし直して空転が無限になるため
  // `stopped` / 世代を待つ前にも待った後にも見る: 解きより後に始まった待ちは誰も解かず、待った後に世代が替わっていれば古い世代の作業者を起こさないため
  async #waitForBackgroundTasks(
    ids: readonly string[],
  ): Promise<'settled' | 'timeout' | 'released'> {
    if (this.#sdkSession.stopped) return 'released';
    const generation = this.#sdkSession.generation;
    const waiters = this.#sdkSession.backgroundWaiters;
    const seenLive = new Set<string>();
    const outcome = await waiters.wait(() => {
      const live = new Set(this.#sdkSession.liveBackgroundTasks.map((task) => task.id));
      return ids.every((id) => {
        if (waiters.isFinished(id)) return true;
        if (live.has(id)) {
          seenLive.add(id);
          return false;
        }
        return seenLive.has(id);
      });
    }, SUBAGENT_BACKGROUND_WAIT_MS);
    if (
      outcome === 'settled' &&
      (this.#sdkSession.stopped || generation !== this.#sdkSession.generation)
    ) {
      return 'released';
    }
    return outcome;
  }

  #renderSubagentStopTaskLines(tasks: readonly unknown[]): string[] {
    return tasks.map((task) => {
      const t = task as {
        id?: unknown;
        type?: unknown;
        status?: unknown;
        description?: unknown;
        command?: unknown;
      };
      const id = typeof t.id === 'string' ? t.id : '(不明)';
      const type = typeof t.type === 'string' ? t.type : '(不明)';
      const status = typeof t.status === 'string' ? t.status : '(不明)';
      const description = typeof t.description === 'string' ? t.description : '(不明)';
      const command = typeof t.command === 'string' ? ` command=${t.command}` : '';
      // `id` と `command` を `description` より前に置く: `#truncateSubagentStopText` は末尾から切るので、`description` が先に切られる側にするため
      return `- id=${id}${command} type=${type} status=${status} description=${description}`;
    });
  }

  // 黙って落とさない: 超えたら切り、切ったこと自体を末尾に書く（AGENTS.md「静かに失敗する道具」）
  #truncateSubagentStopText(text: string): string {
    if (text.length <= SUBAGENT_STOP_NOTE_TEXT_LIMIT) return text;
    return (
      text.slice(0, codePointBoundary(text, SUBAGENT_STOP_NOTE_TEXT_LIMIT)) +
      `…（上限 ${SUBAGENT_STOP_NOTE_TEXT_LIMIT} 文字で切った）`
    );
  }

  /**
   * [sdk-verbatim SubagentStopHookInput.background_tasks]
   * > In-flight background work (running/pending + backgrounded) registered in this session. Lets hooks distinguish "session is done" from "session is paused waiting for background work to wake it". Empty array when nothing is in flight.
   */
  // 起こし直さない側でも黙らない: 黙ると「作業者はきれいに畳んだ」と日誌の上で同じ顔になるため
  // `stall` を載せない: `note.stall.outcome` の2語のどちらでもなく、欄を増やすとデプロイの窓で古い側が黙って落とすため
  #noteSettledOnly(settled: readonly unknown[]): void {
    if (this.#stopState.settledOnlyNoted) return;
    this.#stopState.markSettledOnlyNoted();

    const listed = settled
      .map((task) => {
        const t = task as { type?: unknown; status?: unknown };
        const type = typeof t.type === 'string' ? t.type : '(不明)';
        const status = typeof t.status === 'string' ? t.status : '(不明)';
        return `type=${type} status=${status}`;
      })
      .join(' / ');

    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: this.#truncateSubagentStopText(
        `SubagentStop: 当人が起こした背景処理が ${settled.length}件 配列に載っていたが、` +
          `**status は全部「終わった」側だった**（${listed}）。起こし直していない。` +
          'SDK は `background_tasks` を「in-flight」と名乗っているので、この行が出たら' +
          '計器のほうを疑う — 畳み終えた分が配列に残っているか、status の語彙が変わった' +
          'かである。⟹ この Issue（#570）へ、この行と SDK の版を添えて報告してほしい。' +
          '（雑音にしないため、この診断はセッションに1回だけ出す。）',
      ),
    });
  }

  // 壊れても無音にしない: 表が引けなくなった状態と「作業者はきれいに畳んだ」が日誌の上で同じ顔になるため
  // `type !== 'subagent'` にしない: Monitor / Workflow / 遠隔の Task も表に載らず、設計どおりでも診断が出るため
  #noteOwnerLookupFailure(tasks: readonly unknown[]): void {
    if (this.#stopState.ownerLookupFailureNoted) return;

    const orphans = tasks.filter((task) => {
      const t = task as { id?: unknown; type?: unknown };
      if (!isOwnerRecordableTaskType(t.type)) return false;
      return typeof t.id !== 'string' || !this.#stopState.hasBackgroundTaskOwner(t.id);
    });
    if (orphans.length === 0) return;

    this.#stopState.markOwnerLookupFailureNoted();
    const listed = orphans
      .map((task) => {
        const t = task as { id?: unknown; type?: unknown };
        const id = typeof t.id === 'string' ? t.id : '(不明)';
        const type = typeof t.type === 'string' ? t.type : '(不明)';
        return `id=${id} type=${type}`;
      })
      .join(' / ');

    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        `SubagentStop: 背景処理の**所有者を引けなかった**（${orphans.length}件。${listed}）。` +
        'この行が出たら計器のほうを疑う — ' +
        '`PostToolUse` の `tool_response.backgroundTaskId` が改名・消滅したか、' +
        `表が上限（${BACKGROUND_TASK_OWNER_LIMIT}件）で古い側を捨てたかである。` +
        '⟹ この Issue（#570）へ、この行と SDK の版を添えて報告してほしい。' +
        'そのあいだ「自分の背景処理を残して畳んだ作業者」の記録は出なくなる（無音になる）。' +
        '（雑音にしないため、この診断はセッションに1回だけ出す。）',
    });
  }

  /**
   * [sdk-verbatim StopHookInput.background_tasks]
   * > In-flight background work (running/pending + backgrounded) registered in this session. Lets hooks distinguish "session is done" from "session is paused waiting for background work to wake it". Empty array when nothing is in flight.
   */
  // 何も判断せず何も抑制しない（`{ continue: true }` だけを返す）: まず実データを見てから機構を足すかを決めるため
  // 所有者を `owned_by_subagent` に依存して引かない: 0.3.259 以降の型定義に存在しないため（既存の `#backgroundTaskOwners` だけから引く）
  // `background_tasks_changed.tasks[].task_id` の等式に乗らない: 同じ id 空間かを誰もライブで確かめていないため
  // 在り高が非0の回は畳まず毎回出す: 同じ在り高で何度も閉じていること自体が探している署名のため
  // `#markProgressed()` を呼ばない: 既存の挙動を変えないため
  async #onStop(record: AgentStopRecord): Promise<void> {
    try {
      // 数えるのは何より先: 下のどの枝を通っても（間引かれても）通算が進むため
      const stopFirings = this.#stopState.incrementStopFirings();

      if (record.readError !== undefined) throw record.readError;
      const tasks = record.backgroundTasks ?? [];
      const crons = record.sessionCrons ?? [];
      const stopHookActive = record.stopHookActive;

      if (tasks.length === 0 && crons.length === 0) {
        this.#noteStopIdle();
        return;
      }

      // 0 の行も残す: 数えた結果の 0 で、消すと合計との突き合わせができなくなるため
      const owners = { manager: 0, worker: 0, delegation: 0, unrecordable: 0, unresolved: 0 };
      const statuses = { live: 0, settled: 0, unknown: 0 };
      for (const task of tasks) {
        owners[this.#stopTaskOwnerKind(task)] += 1;
        statuses[classifyBackgroundTaskStatus((task as { status?: unknown }).status)] += 1;
      }

      const stopHookActiveText =
        stopHookActive === undefined ? '' : ` stop_hook_active=${String(stopHookActive)}。`;

      const noteLines = [
        `Stop（マネージャーのターンが閉じる瞬間。このセッションで通算 ${stopFirings}回目）: ` +
          `**背景処理 ${tasks.length}件 / session_crons ${crons.length}件 を残したまま閉じようとしている。**` +
          stopHookActiveText,
        `所有者の内訳（表 #backgroundTaskOwners から引いた）: マネージャー自身 ${owners.manager}件 / ` +
          `作業者 ${owners.worker}件 / 委譲そのもの ${owners.delegation}件 / ` +
          `控えられない種類 ${owners.unrecordable}件 / 引けなかった ${owners.unresolved}件。`,
        `status の内訳: 走っている ${statuses.live}件 / 終わった ${statuses.settled}件 / ` +
          `分からない ${statuses.unknown}件。`,
        ...tasks.map((task) => this.#renderStopTaskLine(task)),
        ...(owners.unresolved === 0
          ? []
          : [
              `⚠️ 上のうち ${owners.unresolved}件 は**所有者を引けなかった**（\`type\` が` +
                '**所有者を控えられる種類**なのに、表に無い）。この行が出たら計器の' +
                'ほうを疑う —— `PostToolUse` の `tool_response.backgroundTaskId` が改名・消滅したか、' +
                `表が上限（${BACKGROUND_TASK_OWNER_LIMIT}件）で古い側を捨てたかである。` +
                '（`monitor` / `workflow` / 遠隔の `Task` は元から控えられないので、この数には入らない' +
                '—— それらは「控えられない種類」に数えてある。）',
            ]),
        ...(statuses.unknown === 0
          ? []
          : [
              `⚠️ 上のうち ${statuses.unknown}件 は status が既知の語彙のどちらでもない。` +
                'この行が出たら計器のほうを疑う —— SDK が status の語彙を変えた見込みが高い。',
            ]),
        '⚠️ **これは観測だけである（#861 の段1）。** この行は何も止めておらず、何も起こし直していない。',
        '⚠️ この行が出ないことは「空転が無かった」を意味しない —— `Stop` は**マネージャーが起きて' +
          'いるときにしか来ない**。器が落ちた・入れ替わった・二度と起こされなかった回は、' +
          'この観測にも現れない（#861）。',
      ];

      this.#emit({
        type: 'note',
        managerId: this.#id,
        // `stall` を載せない: `note.stall.outcome` の2語のどちらでもなく、欄を増やすとデプロイの窓で古い側が黙って落とすため
        // `escalate` も立てない: 観測だけなので、クローンの受信箱へ割り込む理由がまだ無いため
        text: this.#truncateStopNoteText(noteLines.join('\n')),
      });
    } catch (error: unknown) {
      try {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text: `Stop の観測に失敗した: ${reasonOf(error)}`,
        });
      } catch {
        // ここまで失敗したら、もう上げる手段が無い。黙って諦める
        // （挙動は変えない＝必ず continue: true を返すことのほうを優先する）。
      }
    }
  }

  // `unresolved` を他へ混ぜない: 混ぜると経路が壊れて表が空になった状態が「全部が委譲そのものだった」に化けるため
  // `delegation` と `unrecordable` を1つにしない: `subagent` は実測で取れている区別で、名前を1つにして消さないため
  #stopTaskOwnerKind(
    task: unknown,
  ): 'manager' | 'worker' | 'delegation' | 'unrecordable' | 'unresolved' {
    const t = task as { id?: unknown; type?: unknown };
    const owner = typeof t.id === 'string' ? this.#stopState.backgroundTaskOwner(t.id) : undefined;
    if (owner !== undefined) return owner === '' ? 'manager' : 'worker';
    if (t.type === 'subagent') return 'delegation';
    return isOwnerRecordableTaskType(t.type) ? 'unresolved' : 'unrecordable';
  }

  // `#renderSubagentStopTaskLines` を使い回さない: 起こし直しの回数を付けると `0回目` が並び、「起こし直しの枠がまだ在る」と読まれるため
  #renderStopTaskLine(task: unknown): string {
    const t = task as {
      id?: unknown;
      type?: unknown;
      status?: unknown;
      description?: unknown;
      command?: unknown;
    };
    const id = typeof t.id === 'string' ? t.id : '(不明)';
    const type = typeof t.type === 'string' ? t.type : '(不明)';
    const status = typeof t.status === 'string' ? t.status : '(不明)';
    const description = typeof t.description === 'string' ? t.description : '(不明)';
    const command = typeof t.command === 'string' ? ` command=${t.command}` : '';
    const kind = this.#stopTaskOwnerKind(task);
    const owner =
      kind === 'worker' && typeof t.id === 'string'
        ? `worker:${this.#stopState.backgroundTaskOwner(t.id) ?? ''}`
        : kind;
    return `- id=${id} owner=${owner} type=${type} status=${status} description=${description}${command}`;
  }

  // 毎回出さず1セッションに1回へ間引く: `Stop` はマネージャーのターンが閉じるたびに来るので、毎回出すと日誌がターン数ぶんの同じ行で埋まるため
  // 黙らない: 黙ると「`Stop` が一度も発火しなかった」と「発火したが毎回きれいに閉じた」が日誌の上で同じ顔になるため
  #noteStopIdle(): void {
    if (this.#stopState.stopIdleNoted) return;
    this.#stopState.markStopIdleNoted();

    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: this.#truncateStopNoteText(
        'Stop: マネージャーのターンが閉じたが、**背景処理も session_crons も 0件 だった**' +
          `（このセッションで通算 ${this.#stopState.stopFirings}回目の発火）。` +
          '⟹ SDK の言う「session is done」の側である。' +
          '**この行が出たこと自体が「`Stop` はこの器で発火する」の実測である**（#861 の段1）。' +
          '（雑音にしないため、この「0件で閉じた」診断はセッションに1回だけ出す —— `Stop` は' +
          'ターンが閉じるたびに来るので、毎回出せば日誌がターン数ぶんの同じ行で埋まる。' +
          '⟹ **2回目以降の「0件で閉じた」回は個別には残らない。** 続きは #861。）',
      ),
    });
  }

  // 黙って落とさない: 超えたら切り、切ったこと自体を末尾に書く（AGENTS.md「静かに失敗する道具」）
  #truncateStopNoteText(text: string): string {
    if (text.length <= STOP_NOTE_TEXT_LIMIT) return text;
    return (
      text.slice(0, codePointBoundary(text, STOP_NOTE_TEXT_LIMIT)) +
      `…（上限 ${STOP_NOTE_TEXT_LIMIT} 文字で切った）`
    );
  }

  async #onPreCompact(record: AgentPreCompactRecord): Promise<void> {
    const path = record.transcriptPath;
    if (typeof path === 'string' && path.length > 0) this.#sdkSession.setTranscriptPath(path);
    await this.#shipArchive();
  }

  // ここで `#emit` を通さない（stderr へ出す）: `stop()` 経路は器ごと畳まれる最中で outbox が失われうるため
  // 本文が0文字は正常として跡を出さない: 計器やディスクを疑わせる2状態と同列に鳴らすと雑音になるため
  async #shipArchive(): Promise<void> {
    const result = await this.#readTranscript();
    if (result.status === 'no-path') {
      noteMissingRecordSource('生ログ', `managerId=${this.#id} transcript_path`);
      return;
    }
    if (result.status === 'unreadable') {
      noteUnreadableRecord('生ログ', `managerId=${this.#id}`, result.error);
      return;
    }
    if (result.body.length === 0) return;
    // 本文を SSE の1行で運ばない（#4485）: 数十 MB の行を受け取って解析する間、デーモンのループが塞がるため。預けられなければ（古いデーモン）本文を載せる
    const ref = this.#stashArchive?.(result.body);
    this.#emit(
      ref === undefined
        ? { type: 'archive', managerId: this.#id, body: result.body }
        : { type: 'archive', managerId: this.#id, ref },
    );
  }

  // `withdrawn: true` を渡すのはここだけ: 直後の `query.close()` で答えが CLI に一度も届かないため（`answer()` は `close()` を伴わず届く）
  #settleAll(reason: string): void {
    for (const request of [...this.#pending]) {
      request.settle({ message: reason, decision: 'deny', withdrawn: true });
    }
    this.#pending.length = 0;
  }
}

const HANDOFF_LOG_LIMIT = 12_000;

export function renderSessionLog(
  entries: readonly unknown[] | undefined,
  limit = HANDOFF_LOG_LIMIT,
): string | null {
  if (entries === undefined || entries.length === 0) return null;
  const lines = entries
    .map((entry) => renderLogEntry(entry))
    .filter((line): line is string => line !== null);
  if (lines.length === 0) return null;
  const text = lines.join('\n');
  // 溢れたら末尾を残す: 直前に何をしていたかのほうが続きには効くため
  return text.length > limit ? `（前略）\n${text.slice(text.length - limit)}` : text;
}

function renderLogEntry(entry: unknown): string | null {
  const record = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
  const role =
    typeof record.message?.role === 'string'
      ? record.message.role
      : typeof record.type === 'string'
        ? record.type
        : null;
  if (role === null) return null;

  const content = record.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => renderContentPart(part))
            .filter((part) => part.length > 0)
            .join('\n')
        : '';
  return text.length === 0 ? null : `${role}: ${text}`;
}

function renderContentPart(part: unknown): string {
  const block = part as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
  if (typeof block.text === 'string') return block.text;
  if (block.type === 'tool_use') return `[${String(block.name ?? '道具')} ${brief(block.input)}]`;
  return '';
}

// 失敗を伏せない: 「前のセッションには戻れていない」ことを伝えないと、記憶にあるはずの文脈を前提に話し始めて噛み合わないまま進むため
function handoffPrompt(input: {
  sessionId: string;
  reason: string;
  record: string;
  carried: readonly string[];
}): string {
  return [
    `[system] 前のセッション（${input.sessionId}）を開き直せなかった: ${input.reason}`,
    'このセッションは前の続きではない。以下は失われたセッションの記録である。' +
      'ここから状況を組み立て直して、作業の続きを進めよ。',
    '作業ディレクトリの状態は記録と食い違っているかもしれない。' +
      '同じ結果を期待せず、手元を確かめてから動くこと。',
    '--- 失われたセッションの記録（ここから） ---',
    input.record,
    '--- 失われたセッションの記録（ここまで） ---',
    ...input.carried,
  ].join('\n');
}

// `clone.ts` の同名の写しと揃えない: 繋ぎ方は報告と表示の作法で、層の側の判断のため
function assistantText(blocks: readonly AgentContentBlock[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function summarizeBackgroundTasks(tasks: readonly { id: string; taskType: string }[]): string {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    counts.set(task.taskType, (counts.get(task.taskType) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([taskType, count]) => `${taskType}×${String(count)}`)
    .join(', ');
}

// `result` が含まれていなくても落とさずに足す: 本文には出ないまま結果だけが来ることがあり、黙って捨てると終わり方が分からなくなるため
// `（報告なし）` という文字列に一致させない: `contentless` は構造化された印で、文言の判定ではないため
// 結論は「最後の発言」で切る: SDK の `result` は最後の assistant の本文で、Codex の `turn_ended.body` も最後の agentMessage なので、両 provider で同じ線になるため
// 全文（`fullText`）は捨てずに運ぶ: 途中の発言を見たいときに `manager_report` と画面から引けることがオーナーの条件のため
export function reportText(
  said: readonly string[],
  result: { text: string; empty: boolean },
): { text: string; fullText?: string; contentless: boolean } {
  const body = said.join('\n\n').trim();
  if (body.length === 0) return { text: result.text, contentless: result.empty };
  const full = body.includes(result.text.trim()) ? body : `${body}\n\n${result.text}`;
  const last = (said.at(-1) ?? '').trim();
  const conclusion = last.includes(result.text.trim()) ? last : `${last}\n\n${result.text}`.trim();
  if (conclusion === full) return { text: full, contentless: false };
  return { text: conclusion, fullText: full, contentless: false };
}

// 先頭で「畳まれた」と言い切る: 無いと通常の報告と区別が付かず、途中で切られた本文を「マネージャーの結論」として読むため
// 本文を言い換えず全部載せる: 途中まででも次に何を頼み直すかの材料のため
function outboxOnlyUnreportedText(reason: string): string {
  return (
    `（このターンは結果を受け取らないまま畳まれた: ${reason}）\n` +
    '（マネージャーの本文は無い。畳まれる前に出し箱に置かれていた成果物を添える）'
  );
}

function unreportedText(said: readonly string[], reason: string): string {
  const body = said.join('\n\n').trim();
  return (
    `（このターンは結果を受け取らないまま畳まれた: ${reason}）\n` +
    `（以下は畳まれる前にマネージャーが書いていた本文である。ターンの途中の発言が混ざっていることがある）\n\n` +
    body
  );
}

// 先頭で「応答ではない」と言い切る: 支出上限の英語文言が「マネージャーの報告」として台帳・日誌・受信箱へ入るため
// SDK の文言を言い換えない（人間が検索できる形で残す）。途中まで出ていた本文も捨てない: 次に何を頼み直すかの材料のため
// `openedWorkers` が0のときは1文字も足さない: 委譲と無関係な失敗まで作業者絡みに見えるため（AGENTS.md「取れない軸に0の行を作らない」）
// 3つの証拠を足し合わせて全部載せない: 本文が太るだけでいちばん確かな証拠が埋もれるため（`workerRejections` → `failedWorkerNotifications` → `openedWorkers` の順に差し替える）
// 「本体は当たっていない」とは言わない: 作業者自身の発言に拒否の印が付いていても、本体の状態は分からないため
function failedReportText(
  said: readonly string[],
  failure: SdkFailure,
  result: string,
  openedWorkers: number,
  workerRejections: readonly string[] = [],
  failedWorkerNotifications = 0,
  failedWorkerNotificationsNamingLimit = 0,
): string {
  const body = failure.text.length > 0 ? failure.text : result;
  // `via === 'assistant_error'` のときだけ「本体も当たっている」と言い切る: この via は本体自身の assistant メッセージに拒否の印が付いた回にしか立たないため
  const bodyHit = failure.via === 'assistant_error';
  const workerNote =
    workerRejections.length > 0
      ? bodyHit
        ? `\n（このターンでは作業者の発言に SDK の拒否の印が付いていた: ${describeRejectionCodes(workerRejections)}。作業者が当たったことは確かで、本体の発言にも拒否の印が付いていたので、本体も当たっている）`
        : `\n（このターンでは作業者の発言に SDK の拒否の印が付いていた: ${describeRejectionCodes(workerRejections)}。作業者が当たったことは確かだが、本体も当たったかは SDK からは分からない）`
      : failedWorkerNotifications > 0
        ? `\n（このターンでは作業者 ${String(failedWorkerNotifications)} 体が失敗で終わった${
            failedWorkerNotificationsNamingLimit > 0
              ? `（うち ${String(failedWorkerNotificationsNamingLimit)} 体は枠(429)を名乗った）`
              : ''
          }。${
            bodyHit
              ? '本体の発言にも拒否の印が付いていたので、本体も当たっている'
              : '本体も当たったかは SDK からは分からない'
          }）`
        : openedWorkers > 0
          ? `\n（このターンでは作業者が ${String(openedWorkers)} 体開いていた。${
              bodyHit
                ? '作業者が当たったかは SDK からは分からないが、本体の発言には拒否の印が付いていたので、本体は当たっている'
                : 'どちらが当たったかは SDK からは分からない'
            }）`
          : '';
  const head = `（このターンは応答を返さずに終わった: ${failure.code} / ${failure.via}）\n${body}${workerNote}`;
  const partial = said.join('\n\n').trim();
  return partial.length === 0 ? head : `${head}\n\n${FAILED_REPORT_PARTIAL_MARKER}\n${partial}`;
}

function describeRejectionCodes(codes: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts].map(([code, n]) => `${code} ×${String(n)}`).join(' / ');
}

// `empty` は構造的な事実で、返す文字列（`（報告なし）` 等）そのものではない: 文字列を変えずに構造だけを添える
function resultTextOf(event: AgentTurnEnded): { text: string; empty: boolean } {
  if (event.body.length > 0) return { text: event.body, empty: false };
  if (event.outcome !== undefined)
    return { text: `（結果なしで終了: ${event.outcome}）`, empty: false };
  return { text: '（報告なし）', empty: true };
}

function withAnswers(input: Record<string, unknown>, message: string): Record<string, unknown> {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const text = (question as { question?: unknown }).question;
    if (typeof text === 'string') answers[text] = message;
  }
  return { ...input, answers };
}

// 選択肢（`options`）まで載せる: 載せないとクローンは選択肢の中身を読めず、確認の往復が無駄になるため（north_star のデグレード禁止）
function describeQuestions(input: Record<string, unknown>): string {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const blocks = questions
    .map((question) => describeQuestion(question))
    .filter((block): block is string => block !== undefined);
  return blocks.length > 0 ? blocks.join('\n\n') : brief(input);
}

// `description` が空の選択肢でも `label` は必ず出す: 潰すと「選べる数」そのものが読めなくなるため
function describeQuestion(question: unknown): string | undefined {
  const text = (question as { question?: unknown }).question;
  if (typeof text !== 'string') return undefined;
  const rawOptions = (question as { options?: unknown }).options;
  const options = Array.isArray(rawOptions) ? rawOptions : [];
  const lines = options
    .map((option) => {
      const label = (option as { label?: unknown }).label;
      if (typeof label !== 'string') return undefined;
      const description = (option as { description?: unknown }).description;
      return typeof description === 'string' && description.length > 0
        ? `- **${label}**: ${description}`
        : `- **${label}**`;
    })
    .filter((line): line is string => line !== undefined);
  return lines.length > 0 ? [text, ...lines].join('\n') : text;
}

// 足す語は他の語の一部になりにくい形にする（部分一致で `断` 1字だと「判断」に当たるので `断る` / `お断り` にする）。否定の語を含む承認が deny に倒れるのは止める側で、許しすぎる側ではない
const DENIAL_PHRASES = [
  'やめ',
  'だめ',
  'ダメ',
  '駄目',
  '不可',
  '中止',
  '却下',
  '拒否',
  '無理',
  '断る',
  'お断り',
  'しないで',
  '止めて',
  '待って',
  '許可しない',
  '許可できな',
  '許可できません',
  '承認しない',
  '承認できな',
  '承認できません',
  '認めない',
  '認められない',
];

// 英語側は語境界で見る: `nothing` の `no` を否定と読まないため。`reject` / `refuse` / `decline` は語幹＋任意の語尾（`\w*`）にする: `rejecting` の途中に語境界が無く一致しないため
const DENIAL_WORDS =
  /\b(deny|denied|denying|no|nope|don't|do not|won't|will not|cannot|can not|stop|stopping|cancel\w*|reject\w*|refus\w*|declin\w*|abort\w*)\b/i;

// 承認の語の一覧を狭くする: ここに無い言い方は `allow` にならず `unreadable` 側へ寄る（過剰に拒否と読む側で、許しすぎる側ではないため）
// `進めて`（`よい` を伴わない単独形）を足さない: `よい、そのまま進めて` を `unreadable` の代表例として使う複数のテストの歯を反転させてしまうため
const APPROVAL_PHRASES = [
  'どうぞ',
  '進めてよい',
  '許可する',
  '許可します',
  '承認する',
  'はい',
  '承認します',
];
const APPROVAL_WORDS = /\b(go ahead|approved|approve|ok|okay|yes|sure)\b/i;

// 単体で `deny` を返さない: 承認の語と同じ回答に見つかったときにだけ `allow` と読むのを止める（`unreadable` へ落とす）ため
// 保留・一時停止の語を `DENIAL_*` へ足さない: 「Don't wait, go ahead」のように承認の文にも現れうるので、deny と言い切らず `unreadable` へ落とすだけにするため
// 部分一致の誤検出は常に「承認と読まない」側へ倒れる: `unreadable` は SDK 側で deny なので、許しすぎる側へは化けない
// `n't` は語境界の組の外に置く: `\b(…|n't|…)\b` では `isn't` の `s` と `n` のあいだに `\b` が立たず縮約の中で1回も当たらないため
const NEGATION_MARKERS_EN = /\b(not|never|cannot|wait|hold off|hold on|pause\w*)\b|n't\b/i;
const NEGATION_MARKERS_JA = ['ない', 'ません', 'ず', '保留', '見送', '不要'];

// テストのためだけに export している: 否定の印を含む文は `isApprovalOnly` で承認だけから外れるので、`inferDecision` の戻り値からは印が当たったか見えないため
export function hasNegationMarker(message: string): boolean {
  return (
    NEGATION_MARKERS_EN.test(message) ||
    NEGATION_MARKERS_JA.some((marker) => message.includes(marker))
  );
}

// 語を足さず形で絞る: 語を足す形では承認の語と一覧に無い否定・条件の同居が漏れ続けるため、承認以外の語が1つでも残れば `unreadable` にする（答え直しが増えるのは代償として受け入れる）
// 付け足しの一覧を広げない: そのぶん allow の線が緩むため
const APPROVAL_ONLY_FILLERS_JA = [
  'よろしくお願いします',
  'お願いします',
  'お願い',
  'ください',
  'です',
];
const APPROVAL_ONLY_FILLERS_EN = /\b(please|thanks|thank you)\b/gi;
const APPROVAL_ONLY_REMAINDER = /^[\s、。，．,.!！・…~〜ー—–-]*$/u;

function isApprovalOnly(message: string): boolean {
  if (!hasApprovalMarker(message)) return false;
  let rest = message;
  // 長い語から取り除く: `承認します` を `承認する` より先にする等、部分の食い違いを避けるため
  for (const phrase of [...APPROVAL_PHRASES, ...APPROVAL_ONLY_FILLERS_JA].sort(
    (a, b) => b.length - a.length,
  )) {
    rest = rest.split(phrase).join(' ');
  }
  rest = rest.replace(new RegExp(APPROVAL_WORDS.source, 'gi'), ' ');
  rest = rest.replace(APPROVAL_ONLY_FILLERS_EN, ' ');
  return APPROVAL_ONLY_REMAINDER.test(rest);
}

function hasApprovalMarker(message: string): boolean {
  return (
    APPROVAL_PHRASES.some((phrase) => message.includes(phrase)) || APPROVAL_WORDS.test(message)
  );
}

// アポストロフィの変種（U+2019 等）を素の `'` へ揃える: 素の `'` を要求する一覧がどれにも当たらず、`Don’t go ahead.` が `go ahead` にだけ当たって `allow` へ化けるため
// `inferDecision` の入口1箇所でだけ呼び、元の文言は書き換えない: 表示・台帳への保存は呼び出し元の元の `message` を使うため
function normalizeApostrophes(message: string): string {
  return message.replace(/[‘’ʼ]/g, "'");
}

// NFKC で全角を半角へ揃える: 半角だけの `DENIAL_WORDS` に当たらず、`ＮＯ、go ahead` が承認の語に負けて allow になるため
function normalizeForDecision(message: string): string {
  return normalizeApostrophes(message.normalize('NFKC'));
}

// 否定の語を含む承認の言い方は `allow` ではなく `unreadable` に倒す: `DENIAL_WORDS` が `no` / `don't` を先に拾って `deny` を確定させ、答え直しの案内に届かないため（SDK から見える結果は `deny` のままで許しすぎる側へは動かない）
// 一致した部分を除いた残りに本物の否定が在れば `deny` を優先する（`no problem, but stop` 等）
const NEGATED_APPROVAL_PHRASES = [
  'no problem',
  'no objection',
  "don't hesitate",
  "don't mind",
  "don't worry",
  'no worries',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasNegatedApprovalPhrase(message: string): boolean {
  const lower = message.toLowerCase();
  return NEGATED_APPROVAL_PHRASES.some((phrase) => lower.includes(phrase));
}

function stripNegatedApprovalPhrases(message: string): string {
  return NEGATED_APPROVAL_PHRASES.reduce(
    (remainder, phrase) => remainder.replace(new RegExp(escapeRegExp(phrase), 'gi'), ' '),
    message,
  );
}

function hasNegatedApprovalDenial(message: string): boolean {
  const remainder = stripNegatedApprovalPhrases(message);
  return (
    DENIAL_PHRASES.some((phrase) => remainder.includes(phrase)) || DENIAL_WORDS.test(remainder)
  );
}

// 既定を閉じる側（`unreadable`）にする: 一覧に無い否定が `allow` へ化ける実害が続き、語を足すだけでは漏れが終わらないため（過剰に拒否と読む側で許しすぎる側ではない）
// 否定は承認より先に見る: `won't approve` は `approve` を含むため
// 否定の語を含む承認の言い方の判定は、否定の判定より先に走らせる: 先だと `no problem` の `no` が `deny` を確定させるため
// 日本語を語境界（`\s` や `\b`）で探さない: 「それはやめて」の「やめ」の前に区切りが無く、探せていないことが承認として表に出るため
export function inferDecision(message: string): 'allow' | 'deny' | 'unreadable' {
  const normalized = normalizeForDecision(message);
  if (hasNegatedApprovalPhrase(normalized)) {
    return hasNegatedApprovalDenial(normalized) ? 'deny' : 'unreadable';
  }
  if (DENIAL_PHRASES.some((phrase) => normalized.includes(phrase))) return 'deny';
  if (DENIAL_WORDS.test(normalized)) return 'deny';
  if (isApprovalOnly(normalized) && !hasNegationMarker(normalized)) return 'allow';
  return 'unreadable';
}

// 元の文言を1文字も消さない: 安全側で拒否したことと答え直し方を前置きとして足すだけ
function unreadableDenyMessage(original: string): string {
  return (
    '[decision が無く、承認とも拒否とも読み取れなかったので安全側で拒否した] ' +
    `${original}\n\n許可するときは decision: 'allow' を明示して答え直すこと。`
  );
}

// 式を複数箇所に書かない（この関数が唯一の実装）: 実装が2つあると runner.ts 側が変わったときに黙ってずれるため
export function decideAnswer(
  kind: 'question' | 'permission',
  decision: 'allow' | 'deny' | undefined,
  message: string,
): { decision: 'allow' | 'deny'; unreadable: boolean } {
  if (kind === 'question') return { decision: 'allow', unreadable: false };
  if (decision !== undefined) return { decision, unreadable: false };
  const inferred = inferDecision(message);
  return inferred === 'unreadable'
    ? { decision: 'deny', unreadable: true }
    : { decision: inferred, unreadable: false };
}

// 暗号としての強度は要らない: 要るのは「同じ文字列は同じ鍵になる」ことと「鍵を見ても元の文字列が読めない」ことだけのため
function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

// 区切りに `\u0000` を使う: `actor` / `tool` の値には現れない制御文字のため
// 表示用の `actor` を鍵に使わない: 型までしか区別せず、同じ型の作業者が並行に2体いると片方への許可をもう片方が使えてしまうため（`agentId` で区別する）
function oneShotActorOf(
  managerId: string,
  record: { readonly agentId?: string | undefined },
): string {
  return record.agentId === undefined
    ? `manager:${managerId}`
    : `worker:${managerId}:agent=${record.agentId}`;
}

function oneShotAllowKey(actor: string, tool: string, digest: string): string {
  return `${actor}\u0000${tool}\u0000${digest}`;
}

// 切り口を補助面の文字（絵文字の多く）の途中に置かない: 素の `slice` だと高サロゲートだけが残り、UTF-8 で届いたところで U+FFFD に化けるため
export function brief(value: unknown, limit = 200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > limit ? `${text.slice(0, codePointBoundary(text, limit))}…` : text;
}

// プロファイル評価と共有する: 評価だけ root で走らせると、降りた先では読めないプロファイルを「置けた」と報告するため
// 人間自身の `~/.codex` を正本のログインで上書きしない
function defaultCodexHome(childUser: RunnerChildUser | undefined): string {
  if (childUser?.home !== undefined) return joinPath(childUser.home, '.codex');
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return joinPath(tmpdir(), `alteroid-runner-codex-home-${uid}`);
}

function spawnAsUser(
  user: RunnerChildUser,
  options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
    // 既定を `false` にして呼び出し側で選ばせる: 影響を委譲プロセスの起動経路だけに絞るため（プロファイル評価や `git` 起動は委譲のセッションではない）
    detached?: boolean;
  },
) {
  return spawn(options.command, options.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: {
      ...options.env,
      ...(user.home === undefined ? {} : { HOME: user.home }),
    },
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
    uid: user.uid,
    gid: user.gid,
    ...(options.detached === true ? { detached: true } : {}),
  });
}
