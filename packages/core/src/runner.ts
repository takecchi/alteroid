import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chownSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  AgentUserPromptSubmitRecord,
} from './agent-hooks.js';
import { DEFAULT_AGENT_PROVIDER_ID, type AgentProviderId } from './agent-ports.js';
import { resolvePeerOpening, samePeerOpening, type PeerOpening } from './agent-provider-peers.js';
import { describeBashToolTimeoutRaise, planBashToolTimeoutRaise } from './bash-tool-timeout.js';
import { resolveBashGuardMode, type BashGuardMode } from './bash-guard-mode.js';
import { inspectReleaseProdDispatch } from './bash-release-prod-guard.js';
import { inspectBashCommand } from './bash-wait-guard.js';
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
  type PeerApprovalSource,
  type PeerBroker,
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
import { CONTEXT_USAGE_CATEGORY_LIMIT } from './context-usage.js';
import { denialInputShape, type DeniedRecord } from './denial-shape.js';
import { buildDenialInputHead, matchInputOf, redactErrorText } from './denial-input-head.js';
import {
  noteBackgroundFailure,
  noteMissingRecordSource,
  noteUnclassifiedFailure,
  noteUnclassifiedFailuresSummary,
  noteUnreadableRecord,
  reasonOf,
} from './dropped-record.js';
import {
  describeAnthropicRoute,
  inspectAnthropicRoute,
  type AnthropicRouteLayer,
} from './anthropic-route-env.js';
import { fingerprintOf, ROTATABLE_CREDENTIAL_KEYS } from './credentials.js';
import type { CredentialEntry, CredentialFingerprint, CredentialStore } from './credentials.js';
import { compareCodeUnits } from './code-unit-order.js';
import { codePointBoundary, excerptLine } from './excerpt.js';
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
import { buildManagerSystemPrompt, buildWorkerPrompt, managerScratchDirOf } from './prompt.js';
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
import {
  collectManagerOutbox,
  defaultRunnerOutboxRoot,
  defaultRunnerOutboxStagedRoot,
  openStagedOutboxFile,
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
import { redactImagesInEntries, redactImagesInTranscript } from './transcript-image-redaction.js';
import {
  deleteRescueRef,
  RescueMemory,
  type RescueRefDeleteResult,
  resolveRescueIntervalMs,
  runRescue,
} from './rescue-ref.js';
import {
  ScratchSweeper,
  resolveScratchSweepGraceMs,
  resolveScratchSweepIntervalMs,
  type ScratchSweeperOptions,
} from './scratch-sweep.js';
import { computeUnpushedWork } from './unpushed-work.js';
import type { ContextUsageObservation, JobStatus } from './schema.js';
// クローンと同じ判定を呼ぶ: 層ごとに書くと片方だけが印を見落として非対称になるため
import { assistantFailureOf, type SdkFailure } from './sdk-failure.js';
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
  // テスト用: 子の権限で出し箱の中身を消す関数の差し替え口
  outboxRemoveContentsAsChild?: OutboxContentsRemover;
  // `/workspace` に置かない: 子の持ち物のため（ここは runner の所有にし、子 uid は読めるが書けない）
  pluginsRoot?: string;
  permissionMode?: ManagerPermissionMode;
  credentials?: CredentialStore;
  // runner が自分で記憶ストアを読みに行く形にしない: 読みに行けるということは鍵があるということのため
  profile?: ProfileVessel;
  rescueIntervalMs?: number;
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
  readCgroupEventCountersFn?: () => Promise<CgroupEventCounters>;
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
  // 鍵・プロファイルが降りた後の実効の env から読む（値は返さない）。hello と `anthropic_route` が名乗る
  anthropicRoute(): string[];
  mcpServers(): RunnerMcpServersFingerprint | undefined;
  // ファイルへ落とさない: 走行中のプロセスが読み直す経路が無く、効くのはセッションを組む瞬間だけのため
  setMcpServers(input: unknown): RunnerMcpServersFingerprint | undefined;
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
  stop(managerId: string): Promise<void>;
  list(): RunnerManagerState[];
  transcript(managerId: string): Promise<string | null>;
  // 委譲が終わっていても開く（退避先は `closed` では消えず、デーモンの `DELETE` か24時間の掃除まで残る）。形が不正・無ければ `undefined`
  openOutboxFile(managerId: string, fileId: string): Promise<StagedOutboxFile | undefined>;
  // 無くても成功（冪等）。形が不正なら `false`
  deleteOutboxFile(managerId: string, fileId: string): Promise<boolean>;
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
  // 無認証の `/livez` から呼ばない: 誰でも貸し出し期限を延ばせてしまうため
  noteDaemonContact(): void;
  // プロセスの exit で knownTerminated にしない: 作業者の1回の呼び出しは委譲が生きていてもプロセスを終え、その孫（nohup のサーバ等）が撃たれるため
  // failed / lost で閉じたセッションの pid は、同じ managerId を resume しても knownTerminated に残す: 落ちた CLI の木（verify・dev サーバー等）が守られ続けて溜まるため（done・stop() からの resume は守る）
  delegationSessionPids(): { live: ReadonlySet<number>; knownTerminated: ReadonlySet<number> };
}

// 無限には覚えない: 長時間走る runner のメモリが際限なく育つため。忘れた分は所有者不明として knownTerminated に入れず、撃たない側へ倒れる
const PID_OWNER_MANAGER_ID_CAP = 4096;

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
  readonly #sessions = new Map<string, RunnerSession>();
  readonly #generations = new WeakMap<RunnerSession, string>();
  readonly #attachmentsRoot: string;
  readonly #attachmentRemovals = new Map<string, Promise<void>>();
  // 別口で置いて照合を済ませた添付の控え（命令の `staged: true` の参照を突き合わせる。#4128 段3a）
  readonly #stagedAttachments = new StagedAttachmentLedger();
  readonly attachmentStageLimit: number;
  readonly #outboxRoot: string;
  readonly #outboxStagedRoot: string;
  readonly #outboxRemoveContentsAsChild: OutboxContentsRemover | undefined;
  #mcpServers: { servers: McpServers; fingerprint: RunnerMcpServersFingerprint } | undefined;
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
  readonly #knownManagerIds = new Set<string>();
  // `knownTerminated` を固定の集合として持たない: resume で同じ `managerId` が戻っても古い pid が「終端済み」のままになるため
  readonly #liveDelegationPids = new Set<number>();
  readonly #pidOwnerManagerId = new Map<number, string>();
  // failed / lost で閉じたセッションが起こした pid: 同じ `managerId` を resume しても撃つ側に残す（落ちた CLI の木が pid を占め続けるため。#2352・#1334）
  readonly #abandonedDelegationPids = new Set<number>();
  readonly #spawnAgentProcessFn:
    ((options: SpawnAgentProcessOptions) => DelegationProcessHandle) | undefined;
  readonly #readCgroupEventCountersFn: (() => Promise<CgroupEventCounters>) | undefined;
  readonly #finishUnpushedWorkFn:
    ((options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>) | undefined;
  readonly #cwdExistsFn: (cwd: string) => boolean;
  readonly #workerToolWatchClock: WorkerToolWatchClock | undefined;

  constructor(options: RunnerHostOptions) {
    this.#workerToolWatchClock = options.workerToolWatchClock;
    this.runnerId = options.runnerId;
    this.workspacePath = options.workspacePath;
    this.#emit = options.emit;
    this.#queryFn = options.queryFn;
    this.#env = options.env ?? process.env;
    this.#withheldEnvKeys = [...WITHHELD_ENV_KEYS, ...(options.withheldEnvKeys ?? [])];
    this.#childUser = options.childUser;
    this.#attachmentsRoot = options.attachmentsRoot ?? defaultRunnerAttachmentsRoot();
    this.attachmentStageLimit =
      options.attachmentStageLimit ?? readRunnerAttachmentStageLimit(this.#env);
    this.#outboxRoot = options.outboxRoot ?? defaultRunnerOutboxRoot();
    this.#outboxStagedRoot = options.outboxStagedRoot ?? defaultRunnerOutboxStagedRoot();
    this.#outboxRemoveContentsAsChild = options.outboxRemoveContentsAsChild;
    this.#pluginsRoot = options.pluginsRoot ?? defaultRunnerPluginsRoot();
    this.#peer = options.peer;
    this.#managerTools = options.managerTools;
    this.#credentials = options.credentials;
    this.#permissionMode = options.permissionMode ?? resolvePermissionMode(this.#env);
    this.#bashGuard = resolveBashGuardMode(this.#env);
    this.#enforceLease = options.enforceLease ?? false;
    this.#spawnAgentProcessFn = options.spawnAgentProcessFn;
    this.#readCgroupEventCountersFn = options.readCgroupEventCountersFn;
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
          pruneStaleOutboxRoots(
            { outboxRoot: this.#outboxRoot, stagedRoot: this.#outboxStagedRoot },
            [...this.#sessions.keys()],
            Date.now(),
            this.#outboxRemoval(),
          );
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
  }

  credentials(): CredentialFingerprint[] {
    return this.#credentials?.fingerprints() ?? [];
  }

  noteDaemonContact(): void {
    this.#lastDaemonContact = Date.now();
  }

  delegationSessionPids(): { live: ReadonlySet<number>; knownTerminated: ReadonlySet<number> } {
    // 内部の集合への参照を渡さない: 渡した後に書き換えられないという前提が呼び出し側の実装に依存するため（写しを返す）
    const knownTerminated = new Set<number>();
    for (const [pid, managerId] of this.#pidOwnerManagerId) {
      if (this.#liveDelegationPids.has(pid)) continue;
      // failed / lost で閉じた CLI の pid は、同じ managerId が戻っていても外さない: 落ちた CLI の木を守ると resume のたびに pid が溜まるため
      if (this.#sessions.has(managerId) && !this.#abandonedDelegationPids.has(pid)) continue;
      knownTerminated.add(pid);
    }
    return {
      live: new Set(this.#liveDelegationPids),
      knownTerminated,
    };
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
      for (const session of this.#sessions.values()) session.recycleForToken();
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
    return result;
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
      plugins: () => this.#pluginRefs(),
      onClosed: (outcome) => {
        // `stop()` は outcome を渡さない（done・停止からの resume は守る）: 落ちた・失効した CLI だけを撃つ側に残すため
        if (outcome?.status === 'failed' || outcome?.status === 'lost') {
          for (const pid of spawnedPids) {
            // 所有者が今も自分の pid だけ入れる: CAP で忘れた・使い回された pid を足すと集合が育つ・別の CLI を撃つため
            if (this.#pidOwnerManagerId.get(pid) === managerId)
              this.#abandonedDelegationPids.add(pid);
          }
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
      attachmentStageLimit: this.attachmentStageLimit,
      onDelegationProcessSpawned: (pid) => {
        spawnedPids.add(pid);
        this.#noteDelegationProcessSpawned(pid, managerId);
      },
      onDelegationProcessExited: (pid) => this.#noteDelegationProcessExited(pid),
      ...(this.#spawnAgentProcessFn === undefined
        ? {}
        : { spawnAgentProcessFn: this.#spawnAgentProcessFn }),
      ...(this.#readCgroupEventCountersFn === undefined
        ? {}
        : { readCgroupEventCountersFn: this.#readCgroupEventCountersFn }),
      ...(this.#finishUnpushedWorkFn === undefined
        ? {}
        : { finishUnpushedWorkFn: this.#finishUnpushedWorkFn }),
      ...(this.#workerToolWatchClock === undefined
        ? {}
        : { workerToolWatchClock: this.#workerToolWatchClock }),
    });
    this.#generations.set(session, sessionGeneration);
    this.#sessions.set(managerId, session);
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
      session.resume(command.sessionId, command.entries, resumeInput?.text, resumeInput?.images);
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

  openOutboxFile(managerId: string, fileId: string): Promise<StagedOutboxFile | undefined> {
    return openStagedOutboxFile(this.#outboxStagedRoot, managerId, fileId);
  }

  deleteOutboxFile(managerId: string, fileId: string): Promise<boolean> {
    return removeStagedOutboxFile(this.#outboxStagedRoot, managerId, fileId);
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
    await this.#awaitAttachmentRemovals(managerId);
    void pruneStaleAttachmentDirs(
      this.#attachmentsRoot,
      [...this.#sessions.keys(), managerId],
      Date.now(),
    ).catch(() => undefined);
    const placed = await placeRunnerAttachments({
      root: this.#attachmentsRoot,
      managerId,
      attachments,
      ledger: this.#stagedAttachments,
      ...(this.#childUser === undefined ? {} : { childGid: this.#childUser.gid }),
      // 担い手の子プロセスの env と同じ出所（器の env・鍵・プロファイル）で経路を決める。
      routeEnv: { ...this.#baseChildEnv(), ...(this.#profile?.env() ?? {}) },
    });
    return composeAttachmentInput(text, placed);
  }

  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome> {
    const session = this.#sessions.get(managerId);
    if (!session) return { delivered: false };
    return session.answer(answer);
  }

  async stop(managerId: string): Promise<void> {
    await this.#sessions.get(managerId)?.stop('デーモンから停止を指示された。');
  }

  list(): RunnerManagerState[] {
    return [...this.#sessions.values()].map((session) => session.state());
  }

  async transcript(managerId: string): Promise<string | null> {
    return (await this.#sessions.get(managerId)?.transcript()) ?? null;
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
    // 予約済みの plugin の片づけ（retainPlugins の投げっぱなし）を待つ: 待たずに返すと、畳んだ後にも展開先を消し続け、呼び手の後片づけと競合するため
    await this.#pluginsChain;
    // セッションを畳んだ後に閉じる: 先に閉じると、畳みの途中の peer の中継が切れるため
    this.#peerSocket?.close();
    this.#peerSocket = undefined;
    this.#managerTools?.host.close();
  }
}

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
function isWorkerTaskType(taskType: string | undefined): boolean {
  return taskType === undefined || taskType === 'local_agent';
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

type DelegationProcessHandle = AgentChildProcess;

interface RunnerSessionOptions {
  workerToolWatchClock?: WorkerToolWatchClock;
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
  // 値で渡さない（関数で受ける）: 資格が届く・外れるたびに開閉が変わるため
  peer?: () => RunnerPeerOptions | undefined;
  managerTools?: RunnerManagerToolsOptions;
  // 終わり方は `#finish()` を通ったときだけ渡る（`stop()` は渡さない）: 落ちた・失効した CLI の木と、人間・畳みの停止の木を host が見分けるため
  onClosed: (outcome?: { status: JobStatus }) => void;
  outboxRoot: string;
  outboxStagedRoot: string;
  /** 出し箱の大きいファイルの1つの上限と1報告の合計（hello の `attachmentStageLimit` と同じ値）。 */
  attachmentStageLimit?: number;
  onDelegationProcessSpawned?: (pid: number) => void;
  onDelegationProcessExited?: (pid: number) => void;
  spawnAgentProcessFn?: (options: SpawnAgentProcessOptions) => DelegationProcessHandle;
  readCgroupEventCountersFn?: () => Promise<CgroupEventCounters>;
  finishUnpushedWorkFn?: (options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>;
}

// `manager.ts` の定数と共有しない: `runner.ts` → `manager.ts` の逆向き import を増やさないため
const FINISH_UNPUSHED_WORK_TIMEOUT_MS = 5_000;

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
  readonly #managerTools: RunnerManagerToolsOptions | undefined;
  readonly #codexAuth: CodexChatgptAuthHandle | undefined;
  readonly #queryFn: ClaudeQueryFn | undefined;
  #peerBroker: PeerBroker | undefined;
  /** 背景の peer の止まりどころの知らせのうち、まだ届けていないもの（確認待ちの間は溜める）。 */
  readonly #peerNotices: string[] = [];
  readonly #profileEnv: () => Record<string, string>;
  readonly #mcpServers: () => McpServers | undefined;
  readonly #pluginRefs: () => readonly AgentClonePlugin[];
  readonly #onClosed: (outcome?: { status: JobStatus }) => void;
  readonly #outboxRoot: string;
  readonly #outboxStagedRoot: string;
  readonly #attachmentStageLimit: number | undefined;
  //用意できなかったら無し: 出し箱が無くてもマネージャーは動く（成果物を報告に添えられないだけ）
  readonly #outboxDir: string | undefined;
  readonly #onDelegationProcessSpawned: (pid: number) => void;
  readonly #onDelegationProcessExited: (pid: number) => void;
  readonly #spawnAgentProcessFn: (options: SpawnAgentProcessOptions) => DelegationProcessHandle;
  readonly #readCgroupEventCountersFn: () => Promise<CgroupEventCounters>;
  readonly #rescueMemory = new RescueMemory();
  #rescueRunning: Promise<void> | null = null;
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
  readonly #oneShotAllowedToolUses = createRecentMap<{
    readonly actor: string;
    readonly tool: string;
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
  readonly #resumeState = new RunnerResumeState();
  #tokenFingerprint: string | undefined;
  readonly #workerWaitWindow = new RunnerWorkerWaitWindow();
  readonly #nonWorkerTaskIds = new Set<string>();

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
    this.#peer = options.peer;
    this.#managerTools = options.managerTools;
    this.#codexAuth = options.codexAuth;
    this.#queryFn = options.queryFn;
    this.#credentials = options.credentials;
    this.#permissionMode = options.permissionMode;
    this.#bashGuard = options.bashGuard;
    this.#profileEnv = options.profileEnv;
    this.#mcpServers = options.mcpServers;
    this.#pluginRefs = options.plugins;
    this.#onClosed = options.onClosed;
    this.#outboxRoot = options.outboxRoot;
    this.#outboxStagedRoot = options.outboxStagedRoot;
    this.#attachmentStageLimit = options.attachmentStageLimit;
    this.#outboxDir = this.#prepareOutbox();
    this.#onDelegationProcessSpawned = options.onDelegationProcessSpawned ?? (() => undefined);
    this.#onDelegationProcessExited = options.onDelegationProcessExited ?? (() => undefined);
    this.#spawnAgentProcessFn =
      options.spawnAgentProcessFn ??
      ((spawnOptions) =>
        spawnAsUser(this.#childUser as RunnerChildUser, { ...spawnOptions, detached: true }));
    this.#readCgroupEventCountersFn =
      options.readCgroupEventCountersFn ?? (() => readCgroupEventCounters());
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
  ): void {
    this.#resumeState.beginResume(sessionId, entries);
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
      ...(this.#tokenFingerprint === undefined ? {} : { tokenFingerprint: this.#tokenFingerprint }),
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

  async unpushedWork(options?: { signal?: AbortSignal }): Promise<UnpushedWorkResult> {
    const spawnFn = this.#gitSpawnFn();
    // `options.signal` で始めた git 呼び出しを止めない: `computeUnpushedWork` 自身のタイムアウトまで走らせ、止めるのは次の作業ツリーへ進む前だけ
    return computeUnpushedWork(this.#cwd, {
      spawn: spawnFn,
      env: this.#childEnv(),
      managerId: this.#id,
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
        const worktrees = await runRescue(this.#cwd, {
          managerId: this.#id,
          spawn: this.#gitSpawnFn(),
          env: this.#childEnv(),
          memory: this.#rescueMemory,
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
      return { status: 'ok', body: redactImagesInTranscript(await readFile(path, 'utf8')) };
    } catch (error) {
      return { status: 'unreadable', error };
    }
  }

  async stop(reason: string, options: { captureUnpushedWork?: boolean } = {}): Promise<void> {
    if (this.#sdkSession.stopped) {
      // 畳み中のものがあれば待ってから返る（2本目は自分では畳まない）: 即座に返すと `stop()` を await した呼び出し元が畳み終わったと思って先へ進むため
      // 例外を飲み込まない: 呼び出し元は既に `stop()` が投げうる前提で受けているため
      const closing = this.#sdkSession.closing;
      if (closing) await closing;
      return;
    }
    await this.#sdkSession.trackClosing(() => this.#stopBody(reason, options));
  }

  async #stopBody(reason: string, options: { captureUnpushedWork?: boolean } = {}): Promise<void> {
    this.#sdkSession.markStopped();

    // `#settleAll` より前に状態を控える: 控えずに `#status` を読むと確認が解放された後の `running` を報告が名乗ってしまうため
    const statusAtStop = this.#sdkSession.status;

    // `result` を待たずに渡す: この経路で畳まれたぶんは台帳に1行も残らず、渡し損ねたら二度と取れないため
    await this.#flushUsage();

    // `worker_wait` をここで閉じる: この経路は `#finish` を通らず、閉じないと開いたままの区間が黙って消えるため
    this.#closeWorkerWaitWindow();

    // 分類できなかった失敗の件数もここで出す: `#finish` にだけ置くと、器の入れ替えと `manager_stop` で畳まれたぶんの量が失われるため
    noteUnclassifiedFailuresSummary(this.#sdkSession.unclassifiedFailures, this.#id);

    this.#settleAll(reason);
    this.#workerTools.settleAll();
    this.#sdkSession.wakeInput();
    this.#peerBroker?.closeAll();
    this.#sdkSession.closeQuery();
    // 生ログの送り出しと報告を `#reader` が終わるまで待つ: `query.close()` の前に読むと CLI が EOF を受けてから書く最後の数行を取りこぼすため
    await this.#sdkSession.reader?.catch(() => undefined);
    // 止まる前に全文を返す: runner のディスクは器と一緒に消え、渡し損ねると manager_id から生ログへ降りる経路が切れるため
    await this.#shipArchive();
    // `this.#status` ではなく `statusAtStop` を渡す: `#settleAll` が確認を解いた後の `#status` は報告の意味が変わるため
    this.#flushUnreported(reason, statusAtStop);
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
    }
    this.#onClosed();
  }

  // `stop()` ではなく `#finish()` を通す: 自己失効はランナー自身の判断で、デーモンが知る手段が `closed` イベントしかないため
  // 文言（`reason`）で自己失効を判定させない: `lost` だけでは resume 不能と区別できず、構造化された印 `selfFenced: true` だけを台帳が見る
  async selfFence(reason: string): Promise<void> {
    if (this.#sdkSession.stopped) return;
    await this.#finish('lost', reason, { selfFenced: true });
  }

  // セッションが無ければ印を立てない: 次に `#open()` するのはもう新しい鍵のもとのため
  recycleForToken(): void {
    if (this.#sdkSession.query === null) return;
    this.#sdkSession.requestTokenRecycle();
    this.#sdkSession.wakeInput();
  }

  #open(resume?: string): void {
    if (this.#sdkSession.query) return;
    // 「whenever the session's CLI process (re)starts」[sdk-verbatim SDKBackgroundTasksChangedMessage] に対応するのはここで、`init` ではない: `init` はターンの頭ごとに来るだけのため
    this.#sdkSession.resetLiveBackgroundTasks();
    this.#nonWorkerTaskIds.clear();
    const generation = this.#sdkSession.generation;
    const session = this.#driver.open(this.#buildSpec(resume));
    this.#sdkSession.open(session, this.#read(session, generation));
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

  #createPeerBroker(allowed: readonly AgentProviderId[], peer: RunnerPeerOptions): PeerBroker {
    return createPeerBroker({
      allowed,
      ...(peer.models === undefined ? {} : { models: peer.models }),
      // 組んだ後に資格が外れたら、相手を起こさずに断る（道具が消えるのは次の組み直し）
      closedReason: (provider) =>
        this.#peer?.()?.peers.includes(provider) === true
          ? undefined
          : `この器では peer（${provider}）がいま閉じている（資格が外れた。理由は runner_list の peer の行に出る）`,
      askApproval: (source, request) => this.#onPermission(request, source),
      driverOf: (provider) =>
        provider === 'codex'
          ? new CodexManagerDriver(
              this.#codexAuth === undefined ? {} : { chatgptAuth: this.#codexAuth },
            )
          : new ClaudeManagerDriver(this.#queryFn === undefined ? {} : { queryFn: this.#queryFn }),
      reportsUsage: (provider) => peer.reportsUsage(provider),
      onNote: (text) => this.#emit({ type: 'note', managerId: this.#id, text }),
      // 背景へ回した peer の止まりどころは、マネージャーへの知らせとして入れて起こす
      onBackgroundStop: (result) => this.#onPeerBackgroundStop(result),
      // 作業者の長い道具と同じ口に載せる: ホームの稼働状況に、作業者と同じ形で「実行中」を出すため
      onTurn: (event) => {
        const toolUseId = `peer:${event.turnId}`;
        if (event.kind === 'ended') {
          this.#emit({ type: 'tool_end', managerId: this.#id, toolUseId });
          return;
        }
        this.#emit({
          type: 'tool_running',
          managerId: this.#id,
          actor: peerActorOf(this.#id, event.provider),
          tool: event.tool,
          toolUseId,
          startedAt: event.startedAt,
          ...(event.model === undefined ? {} : { model: event.model }),
        });
      },
      onUsage: (report) =>
        this.#emit({
          type: 'peer_usage',
          managerId: this.#id,
          provider: report.provider,
          ...(report.sessionId === undefined ? {} : { sessionId: report.sessionId }),
          models: report.models,
          ...(report.unmetered ? { unmetered: true } : {}),
        }),
      // 作られたファイルを、道具の記録に残らない作り方（コードで書いた等）でも拾う
      scanWorkdir: (dir, sinceMs) => scanPeerWorkdir(dir, sinceMs),
      makeSpec: (provider, parts) => ({
        ...this.#buildSpec(undefined, true),
        ...this.#peerWorkdirSpec(),
        input: parts.input,
        // 置かれたモデルを peer に効かせない: ホストの provider のものなので、名指しが無ければ各 provider の既定に任せるため
        model: parts.model ?? resolveManagerModel({}),
        modelPlaced: parts.model !== undefined,
        workerModel: resolveWorkerModel({}),
        // `strictApprovals` を載せない: 載せると構えが `default` / `untrusted` に締まるため
        permissionMode: this.#permissionMode,
        // peer の生ログを預けない: マネージャーの生ログと混ぜないため
        sessionLog: { append: async () => undefined, load: async () => null },
        onPermission: parts.onPermission,
        onNote: parts.onNote,
        onPreToolUse: () => ({ kind: 'continue' }),
        onPermissionDenied: async () => ({ kind: 'no-retry' }),
        onPostToolUse: (record) => {
          this.#emit({
            type: 'tool_use',
            managerId: this.#id,
            actor: peerActorOf(this.#id, provider),
            tool: record.toolName ?? '(不明)',
            input: record.toolInput,
          });
          return { kind: 'continue' };
        },
        onPostToolUseFailure: (record) => this.#notePeerToolUseFailure(provider, record),
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
      return { systemPromptAppend: PEER_SYSTEM_PROMPT_APPEND };
    }
    return { cwd: dir, systemPromptAppend: peerSystemPromptAppend(dir) };
  }

  // `tool_use` にしない: 旧 daemon が未知の欄を落とすため
  #notePeerToolUseFailure(provider: AgentProviderId, record: AgentToolAuditFailureRecord): void {
    const error =
      typeof record.error === 'string'
        ? excerptLine(redactErrorText(record.error, process.env), TOOL_USE_FAILURE_ERROR_EXCERPT)
        : '(不明)';
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text: `${TOOL_USE_FAILURE_NOTE_PREFIX} 道具=${record.toolName ?? '(不明)'}・actor=${peerActorOf(this.#id, provider)}・error=${error}`,
    });
  }

  #buildSpec(resume?: string, forPeer = false): AgentManagerSessionSpec {
    // プロファイルが上書きした後の値から指紋を控える: 子が実際に掴む鍵を見るため（peer のセッションは別物なので控えない）
    const childEnv = this.#childEnv();
    if (!forPeer) this.#tokenFingerprint = tokenFingerprintOf(childEnv);
    // 1回だけ呼ぶ: 呼ぶたびに使い捨ての token を発行するため。道具とプロンプトの案内は同じ判定から出す
    const peerEntry = forPeer ? undefined : this.#peerMcpEntry();
    const peerModels = peerEntry === undefined ? undefined : this.#peer?.()?.models?.codex;
    // peer のセッションには出さない: 記録するのはマネージャー自身で、peer の成果はマネージャーが受け取ってから記録する
    const managerToolsEntry = forPeer ? undefined : this.#managerToolsMcpEntry();
    return {
      input: this.#inputStream(),
      model: resolveManagerModel(this.#env),
      modelPlaced: placedModelTier(this.#env, MANAGER_MODEL_ENV_KEY) !== null,
      permissionMode: this.#permissionMode,
      systemPromptAppend: buildManagerSystemPrompt({
        managerId: this.#id,
        workerName: WORKER_AGENT_NAME,
        ...(peerEntry === undefined
          ? {}
          : { peer: peerModels === undefined ? {} : { models: peerModels } }),
        ...(managerToolsEntry === undefined ? {} : { managerTools: true }),
      }),
      workerAgentName: WORKER_AGENT_NAME,
      workerPrompt: buildWorkerPrompt(),
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
      onSubagentStop: (record) => this.#onSubagentStop(record),
      onStop: (record) => this.#onStop(record),
    };
  }

  // runner のディスクに前回の生ログが残っている前提を置かない: 器は作り直されるため
  #sessionLog(): AgentSessionLog {
    return {
      append: async (key: AgentSessionLogKey, entries: unknown[]) => {
        this.#emit({
          type: 'mirror',
          managerId: this.#id,
          key: {
            projectKey: key.projectKey,
            sessionId: key.sessionId,
            ...(key.subpath === undefined ? {} : { subpath: key.subpath }),
          },
          // 画像の中身は mirror（pg）へ流さない: 保持期限後も消えない生ログになるため
          entries: redactImagesInEntries(entries),
        });
        this.#emit({ type: 'project_key', managerId: this.#id, projectKey: key.projectKey });
      },
      load: async (key: AgentSessionLogKey) => {
        if (key.subpath !== undefined) return null;
        return this.#resumeState.seed ?? null;
      },
    };
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
    const child = this.#spawnAgentProcessFn(options);
    const pid = child.pid;
    if (pid !== undefined) {
      this.#onDelegationProcessSpawned(pid);
      const noteExited = (): void => this.#onDelegationProcessExited(pid);
      // `exit` だけに頼らない: `error` のときに `exit` が来るかは環境依存のため
      child.once('exit', noteExited);
      child.once('error', noteExited);
    }
    return child;
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
    return env;
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

  #outboxHasEntries(): boolean {
    if (this.#outboxDir === undefined) return false;
    try {
      return readdirSync(this.#outboxDir).length > 0;
    } catch {
      return false;
    }
  }

  /** 報告の直前に出し箱の直下を取り込む。失敗は報告を止めず、`note` に残す（出し箱の不調でターンの報告を失わない）。 */
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
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `出し箱を取り込めなかった: ${reasonOf(error)}`,
      });
      return {};
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
      const reason = redactErrorText(String(error), process.env);
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
    this.#sdkSession.teardownForRecreate();
    this.#resumeState.armResumeAttempt(sessionId);
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        '鍵・環境変数（認証トークンを含む）が差し替わったので、ターンの境界でセッションを畳んで' +
        '開き直した（会話は resume で続く）。',
      // `text` の言い回しで判定させない: 構造化した旗でデーモンに伝える
      tokenRotation: true,
    });
    this.#open(sessionId);
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
      // **このターンで開いた作業者の数（#1373）も、同じ理由で持ち越さない。**
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
          }
        } else {
          // 作業者の発言に付いた拒否の印をターンの失敗にしない: 数えるだけ
          const rejected = assistantFailureOf(event.errorCode, '');
          if (rejected !== undefined) this.#turnTally.pushWorkerRejection(rejected.code);
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
          for (const candidate of [failure.text, resultTextOf(event).text, ...event.errorLines]) {
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

        if (!event.succeeded) {
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
        // 背景処理の完了待ちで畳んだだけの報告（デーモンが握り潰しうる）では取り込まない: 載せた `files` が配られないまま退避先にだけ残るため。出し箱に残して次の報告で送る
        // 1回だけ読む: 背景の peer はこの間にも止まりうるので、2つの判定で別の一覧を見ないため
        const liveBackground = this.#liveBackgroundTasks();
        const awaitsBackgroundOnly =
          failure === undefined && this.#pending.length === 0 && liveBackground.length > 0;
        // 出し箱が空なら `await` を挟まない: 余計な yield が報告の出る順序（と、それを前提にした観測）を変えるため
        const outbox =
          awaitsBackgroundOnly || !this.#outboxHasEntries() ? {} : await this.#collectOutbox();
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
        this.#emit({
          type: 'report',
          managerId: this.#id,
          reportId: event.id,
          text: outcome.text,
          status: this.#sdkSession.status,
          ...(failure === undefined ? {} : { failure: { code: failure.code, via: failure.via } }),
          ...(outcome.contentless ? { contentless: true } : {}),
          ...(awaitingBackground === undefined ? {} : { awaitingBackground }),
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

    // SDK が付けてきた `denial.toolUseId` で引く: 下で組む代用の `toolUseId` は実在の id ではなく、無関係な一致が起きうるため
    if (typeof denial.toolUseId === 'string') {
      const funneled = this.#oneShotAllowedToolUses.get(denial.toolUseId);
      if (funneled !== undefined) {
        this.#oneShotAllowedToolUses.delete(denial.toolUseId);
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text:
            `1回だけの許可（issue #1105 P1、${funneled.actor}・${funneled.tool}）で allow を` +
            `返した呼び出しが、それでも拒否された（合図の出所: ${via}）。分類器がこの allow を` +
            `分類器へ回した（リモートの機能フラグ）か、deny 規則が上書きしたかのどちらか` +
            `（あるいは両方）で、alteroid 側からは切り分けられない。この許可はいまは効いて` +
            `いない可能性がある。`,
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
      const usage = await session.contextUsage();
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
  #flushUnreported(reason: string, status: JobStatus): void {
    if (!this.#turnTally.hasSaid) return;
    const { said, reportId } = this.#turnTally.takeSaid();
    this.#emit({
      type: 'report',
      managerId: this.#id,
      ...(reportId === undefined ? {} : { reportId }),
      text: unreportedText(said, reason),
      status,
      unreported: { reason },
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
    // 読み取りが終わっても入力側を起こして本体を閉じる。怠ると閉じられない
    // Query と起きない `#inputStream` が残る。
    this.#sdkSession.wakeInput();
    this.#peerBroker?.closeAll();
    this.#sdkSession.closeQuery();
    this.#sdkSession.setStatus(status);
    await this.#shipArchive();
    // `#shipArchive()` の後に置く: この報告を読んだクローンがすぐ `manager_transcript` で裏を取れるようにするため
    this.#flushUnreported(reason, status);
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
    const baseSummary =
      kind === 'question'
        ? describeQuestions(input)
        : `${toolName} の実行許可: ${brief(input)}${reason === undefined ? '' : `\n理由: ${reason}`}`;
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

    this.#emit({
      type: 'ask',
      managerId: this.#id,
      requestId: id,
      kind,
      summary,
      askedAt,
      ...(source === undefined ? {} : { source: { type: 'peer', provider: source.provider } }),
    });

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

    const inputHead = buildDenialInputHead(record.toolInput, this.#env);
    const permitKey = oneShotAllowKey(
      oneShotActorOf(this.#id, record),
      toolName,
      digestOf(matchInput),
    );
    const id = record.toolUseId ?? randomUUID();

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
    const summary =
      `分類器が ${actor} の ${toolName} 呼び出しを拒否した。この1回だけ許可しますか。\n` +
      `（allow は「同じ入力での撃ち直しを1回だけ通す」許可で、撃ち直すかは担い手が決める。` +
      `拒否文が再試行を禁じていると撃ち直されないことがある。その場合は allow の後で担い手へ` +
      `manager_send で伝える必要がある。効くかは確かめていない）\n` +
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
    const signal = record.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        onTimeout();
      } else {
        signal.addEventListener('abort', onTimeout, { once: true });
        unlisten = () => signal.removeEventListener('abort', onTimeout);
      }
    }

    this.#emit({ type: 'ask', managerId: this.#id, requestId: id, kind, summary, askedAt });

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
    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        `クローンが分類器の拒否（${actor}・${toolName}）を1回だけ許可した。同じ入力で撃ち直された` +
        `ときにだけ、${Math.round(ONE_SHOT_ALLOW_TTL_MS / 60000)}分以内なら1回通す（issue #1105 P1）。` +
        `撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない。` +
        `分類器の拒否文が再試行や別の手段を禁じていると、担い手は撃ち直さないことがある` +
        `（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。` +
        `その場合は許可を出したクローンが、担い手へ manager_send で同じ入力で撃ち直してよいこと` +
        `（1回だけの許可が有効なこと）を明示して伝える。これで撃ち直されるかは確かめていない。`,
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

    let guardAsk: { reason: string } | undefined;
    if (record.toolName === 'Bash') {
      const toolInput = record.toolInput as
        { command?: unknown; run_in_background?: unknown } | null | undefined;
      const command = toolInput?.command;
      if (typeof command === 'string') {
        // `run_in_background` を `=== true` で受ける: 欠けていても形が崩れていても前景になり、通す側へ倒れるため
        let verdict:
          ReturnType<typeof inspectBashCommand> | { blocked: true; form: string; reason: string };
        try {
          // 本番デプロイの起動（release-prod）は `off` でも確認に残す
          const releaseProd = inspectReleaseProdDispatch(command);
          verdict = releaseProd.matched
            ? { blocked: true, form: releaseProd.form, reason: releaseProd.reason }
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
          const asked = this.#bashGuard !== 'deny';

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

  // 弾かず `timeout` の欄だけを引き上げる。判定が投げても呼び出しを止めない: 書き換えは安全弁ではなく便宜なので、倒れる先は「書き換えない」
  #planBashToolTimeoutRewrite(record: AgentPreToolRecord): AgentPreToolRewrite | undefined {
    if (record.toolName !== 'Bash') return undefined;
    const toolInput = record.toolInput;
    if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
      return undefined;
    }
    const input = toolInput as Record<string, unknown>;
    let raise: ReturnType<typeof planBashToolTimeoutRaise>;
    try {
      raise = planBashToolTimeoutRaise(input);
    } catch (error) {
      process.stderr.write(
        `alteroid: Bash の timeout 引数の判定が失敗した（書き換えない）: ${reasonOf(error)}\n`,
      );
      return undefined;
    }
    if (raise === undefined) return undefined;

    const actor =
      record.agentId === undefined
        ? `manager:${this.#id}`
        : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;
    const from = raise.fromMs === undefined ? '未指定' : `${raise.fromMs}ms`;
    this.#tryObservation('timeout 引数の引き上げの note の送り出し', () => {
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: `Bash の呼び出しの timeout 引数を引き上げた（${actor}・形=bash-tool-timeout-raised・${from}→${raise.toMs}ms）。`,
      });
    });
    return { input: { ...input, timeout: raise.toMs }, note: describeBashToolTimeoutRaise(raise) };
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
      process.stderr.write(`alteroid: ${label}が失敗した（判定は続ける）: ${reasonOf(error)}\n`);
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
      this.#oneShotAllowedToolUses.set(record.toolUseId, { actor, tool: toolName });
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

  // 生の入力を保持しない（伏せ字済みの先頭だけ）: 忘れるまでの間ずっと鍵が入りうる文字列を抱え、`onForget` の日誌行へ滲み出る経路も増えるため
  #capturePreToolInputHead(record: AgentPreToolRecord): void {
    if (record.toolUseId === undefined) return;
    const preview = buildDenialInputHead(record.toolInput, this.#env);
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
    if (typeof record.transcriptPath === 'string')
      this.#sdkSession.setTranscriptPath(record.transcriptPath);
    this.#markProgressed();

    if (record.agentId === undefined) this.#turnTally.incrementToolsSinceResult();

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
    if (additionalContext === null) return { kind: 'continue' };
    return { kind: 'addContext', text: additionalContext };
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
    if (typeof record.transcriptPath === 'string')
      this.#sdkSession.setTranscriptPath(record.transcriptPath);
    this.#markProgressed();

    if (record.agentId === undefined) this.#turnTally.incrementToolsSinceResult();

    const actor =
      record.agentId === undefined
        ? `manager:${this.#id}`
        : `worker:${this.#id}:${record.agentType ?? WORKER_AGENT_NAME}`;
    const tool = record.toolName ?? '(不明)';
    const error =
      typeof record.error === 'string'
        ? // 道具の出力（トークン・資格付き URL）を運びうる自由文なので、伏せてから切る
          excerptLine(redactErrorText(record.error, process.env), TOOL_USE_FAILURE_ERROR_EXCERPT)
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
    this.#emit({ type: 'archive', managerId: this.#id, body: result.body });
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
function reportText(
  said: readonly string[],
  result: { text: string; empty: boolean },
): { text: string; contentless: boolean } {
  const body = said.join('\n\n').trim();
  if (body.length === 0) return { text: result.text, contentless: result.empty };
  if (body.includes(result.text.trim())) return { text: body, contentless: false };
  return { text: `${body}\n\n${result.text}`, contentless: false };
}

// 先頭で「畳まれた」と言い切る: 無いと通常の報告と区別が付かず、途中で切られた本文を「マネージャーの結論」として読むため
// 本文を言い換えず全部載せる: 途中まででも次に何を頼み直すかの材料のため
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
  return partial.length === 0 ? head : `${head}\n\n（失敗する前に出ていた本文）\n${partial}`;
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
